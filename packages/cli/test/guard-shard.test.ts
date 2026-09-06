import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  calculateCoverage,
  contractConfigDigest,
  parseConfig,
  parseReport,
  parseShardPlan,
  screenshotArtifactPath,
  type MatrixCell,
  type UIWitnessContract,
} from "uiwitness-core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { guardConfiguration } from "../src/guard-adapter.js";
const runShardScenarioCellsMock = vi.hoisted(() => vi.fn());

vi.mock("uiwitness-runner-playwright", () => ({
  runShardScenarioCells: runShardScenarioCellsMock,
}));

import { createGuardShardPlan, runGuardShard } from "../src/guard-shard.js";

const projects: string[] = [];

async function fixture(options: { readonly authentication?: boolean } = {}) {
  const project = await realpath(await mkdtemp(join(tmpdir(), "uiwitness-cli-shard-")));
  projects.push(project);
  const scenarioPath = join(project, "scenario.mjs");
  await writeFile(scenarioPath, "export default {};\n", "utf8");
  if (options.authentication === true) {
    await writeFile(join(project, "auth.mjs"), "export default async function () {};\n", "utf8");
  }
  const configPath = join(project, "uiwitness.config.mjs");
  await writeFile(configPath, `export default {
  ${options.authentication === true ? 'authentication: { setup: "./auth.mjs" },' : ""}
  baseURL: "https://example.test/app",
  routes: [
    { id: "home", path: "/", states: [{ id: "default", setup: "./scenario.mjs" }] },
    { id: "settings", path: "/settings", states: [{ id: "empty", setup: "./scenario.mjs" }] }
  ],
  themes: ["light", "dark"],
  viewports: { desktop: { height: 900, width: 1440 } }
};\n`, "utf8");
  const imported = await import(`${pathToFileURL(configPath).href}?v=${Date.now()}`) as {
    readonly default: Parameters<typeof parseConfig>[0];
  };
  const configuration = await guardConfiguration(
    parseConfig(imported.default),
    configPath,
    project,
  );
  const accepted = configuration.slice(0, 1);
  const contract: UIWitnessContract = {
    configDigest: contractConfigDigest(accepted),
    coordinates: accepted.map((coordinate) => ({
      ...coordinate,
      expected: { status: "passed" as const },
    })),
    schemaVersion: 1,
  };
  const contractPath = join(project, "uiwitness.contract.json");
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  return { configuration, contractPath, project };
}

function report(cells: readonly MatrixCell[]) {
  return parseReport({
    executions: cells.map((cell) => ({
      diagnostics: { consoleErrors: [], failedRequests: [], navigationStatus: 200, pageErrors: [] },
      durationMs: 1,
      failures: [],
      routeId: cell.route.id,
      routePath: cell.route.path,
      scenarioSource: cell.state.setup,
      screenshotPath: screenshotArtifactPath(cell),
      stateId: cell.state.id,
      status: "passed" as const,
      theme: cell.theme,
      url: new URL(cell.route.path, "https://example.test").href,
      viewport: cell.viewport,
      viewportId: cell.viewportId,
    })),
    generatedAt: "2026-09-05T12:00:00.000Z",
    project: { baseURL: "https://example.test/app" },
    schemaVersion: 1,
    summary: {
      coverage: calculateCoverage(cells, cells.map((cell) => ({
        passed: true,
        routeId: cell.route.id,
        stateId: cell.state.id,
        theme: cell.theme,
        viewportId: cell.viewportId,
      }))),
      durationMs: cells.length,
      executions: cells.length,
      failed: 0,
      passed: cells.length,
      routes: new Set(cells.map(({ route }) => route.id)).size,
      states: new Set(cells.map(({ route, state }) => `${route.id}/${state.id}`)).size,
    },
  });
}

afterEach(async () => {
  runShardScenarioCellsMock.mockReset();
  await Promise.all(projects.splice(0).map((project) => rm(project, { force: true, recursive: true })));
});

describe("guard shard orchestration", () => {
  it("plans the complete current config, including coordinates absent from the contract", async () => {
    const { configuration, project } = await fixture();
    const result = await createGuardShardPlan({
      cwd: project,
      environmentId: "us-production",
      now: () => new Date("2026-09-05T12:00:00.000Z"),
      outPath: ".uiwitness/plan.json",
      shards: 3,
      ttlMinutes: 30,
    });
    const persisted = parseShardPlan(await readFile(join(project, result.planPath), "utf8"));

    expect(persisted.coordinateIds).toEqual(configuration.map(({ id }) => id));
    expect(persisted.coordinateIds).toHaveLength(4);
    expect(persisted.environmentId).toBe("us-production");
    expect(persisted.expiresAt).toBe("2026-09-05T12:30:00.000Z");
    const second = await createGuardShardPlan({
      cwd: project,
      now: () => new Date("2026-09-05T12:00:00.000Z"),
      outPath: ".uiwitness/plan-2.json",
      shards: 4,
    });
    expect(second.plan.runSetId).not.toBe(result.plan.runSetId);
    expect(second.warning).toContain("more than 1.5x the mean");
    await expect(createGuardShardPlan({
      cwd: project,
      outPath: ".uiwitness/plan.json",
      shards: 3,
    })).rejects.toMatchObject({ code: "GUARD_SHARD_PLAN_PATH_INVALID" });
    await expect(createGuardShardPlan({
      cwd: project,
      outPath: ".uiwitness/shards/plan.json",
      shards: 3,
    })).rejects.toMatchObject({ code: "GUARD_SHARD_PLAN_PATH_INVALID" });
    for (const outPath of [
      ".uiwitness/contract-verdict.json",
      ".uiwitness/contract-candidates/plan.json",
      ".uiwitness/contract-generations/plan.json",
    ]) {
      await expect(createGuardShardPlan({ cwd: project, outPath, shards: 3 }))
        .rejects.toMatchObject({ code: "GUARD_SHARD_PLAN_PATH_INVALID" });
    }
  });

  it("executes every plan assignment exactly once and treats partial failures as merge data", async () => {
    const { project } = await fixture();
    const planned = await createGuardShardPlan({
      cwd: project,
      now: () => new Date("2026-09-05T12:00:00.000Z"),
      outPath: "plan.json",
      shards: 3,
    });
    const seen: string[] = [];
    runShardScenarioCellsMock.mockImplementation(async (cells: readonly MatrixCell[], options: { readonly shardIndex: number }) => {
      seen.push(...cells.map((cell) => `${cell.route.id}/${cell.state.id}/${cell.viewportId}/${cell.theme}`));
      const value = report(cells);
      return {
        bundlePath: `.uiwitness/shards/${planned.plan.runSetId}/${options.shardIndex}-of-3`,
        manifest: {},
        report: value,
      };
    });

    const results = await Promise.all([1, 2, 3].map((index) => runGuardShard({
      cwd: project,
      now: () => new Date("2026-09-05T12:01:00.000Z"),
      shard: `${index}/3`,
      shardPlanPath: "plan.json",
    })));
    expect(seen.sort()).toEqual([...planned.plan.coordinateIds]);
    expect(results.reduce((total, result) => total + result.total, 0)).toBe(4);
  });

  it("fails closed for authentication, expiry, contract drift, and N/M mismatch", async () => {
    const authenticated = await fixture({ authentication: true });
    await expect(createGuardShardPlan({
      cwd: authenticated.project,
      outPath: "plan.json",
      shards: 2,
    })).rejects.toMatchObject({ code: "GUARD_SHARD_AUTH_UNSUPPORTED" });

    const { contractPath, project } = await fixture();
    await createGuardShardPlan({
      cwd: project,
      now: () => new Date("2026-09-05T12:00:00.000Z"),
      outPath: "plan.json",
      shards: 2,
      ttlMinutes: 5,
    });
    await expect(runGuardShard({
      cwd: project,
      now: () => new Date("2026-09-05T12:05:00.000Z"),
      shard: "1/2",
      shardPlanPath: "plan.json",
    })).rejects.toMatchObject({ code: "GUARD_SHARD_PLAN_EXPIRED" });
    await expect(runGuardShard({
      cwd: project,
      now: () => new Date("2026-09-05T12:01:00.000Z"),
      shard: "1/3",
      shardPlanPath: "plan.json",
    })).rejects.toMatchObject({ code: "GUARD_SHARD_PLAN_MISMATCH" });

    const source = JSON.parse(await readFile(contractPath, "utf8")) as UIWitnessContract;
    await writeFile(contractPath, `${JSON.stringify({
      ...source,
      configDigest: `sha256:${"d".repeat(64)}`,
    }, null, 2)}\n`, "utf8");
    await expect(runGuardShard({
      cwd: project,
      now: () => new Date("2026-09-05T12:01:00.000Z"),
      shard: "1/2",
      shardPlanPath: "plan.json",
    })).rejects.toMatchObject({ code: "GUARD_SHARD_PLAN_MISMATCH" });
  });
});
