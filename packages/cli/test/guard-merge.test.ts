import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SHARD_ASSIGNMENT_ALGORITHM,
  SHARD_BUNDLE_MANIFEST_SCHEMA_VERSION,
  calculateCoverage,
  contractConfigDigest,
  contractDigest,
  createShardPlan,
  expandMatrix,
  parseCommittedGeneration,
  parseConfig,
  parseContract,
  parseReport,
  serializeReport,
  serializeShardBundleManifest,
  shardPlanDigest,
  shardTargetDigest,
  screenshotArtifactPath,
  type Sha256Digest,
} from "uiwitness-core";

import { guardConfiguration } from "../src/guard-adapter.js";
import { mergeGuardShards } from "../src/guard-merge.js";
import { guardToolVersion } from "../src/guard.js";

const projects: string[] = [];
const baseURL = "https://example.test/app/";

function digest(contents: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

async function fixture(): Promise<{
  readonly bundlePath: string;
  readonly project: string;
  readonly runSetId: string;
}> {
  const project = await mkdtemp(join(tmpdir(), "uiwitness-cli-merge-"));
  projects.push(project);
  await writeFile(join(project, "scenario.mjs"), "export default {};\n", "utf8");
  const configPath = join(project, "uiwitness.config.mjs");
  const configInput = {
    baseURL,
    routes: [{ id: "home", path: "/", states: [{ id: "default", setup: "./scenario.mjs" }] }],
    themes: ["light"],
    viewports: { desktop: { height: 900, width: 1440 } },
  } as const;
  await writeFile(configPath, `export default ${JSON.stringify(configInput, null, 2)};\n`, "utf8");
  const config = parseConfig(configInput);
  const configuration = await guardConfiguration(config, configPath, project);
  const contract = parseContract(`${JSON.stringify({
    configDigest: contractConfigDigest(configuration),
    coordinates: configuration.map((coordinate) => ({
      ...coordinate,
      expected: { status: "passed" },
    })),
    schemaVersion: 1,
  }, null, 2)}\n`);
  await writeFile(join(project, "uiwitness.contract.json"), `${JSON.stringify(contract, null, 2)}\n`, "utf8");

  const cells = expandMatrix(config);
  const cell = cells[0]!;
  const screenshotPath = screenshotArtifactPath(cell);
  const report = parseReport({
    executions: [{
      diagnostics: { consoleErrors: [], failedRequests: [], navigationStatus: 200, pageErrors: [] },
      durationMs: 7,
      failures: [],
      routeId: "home",
      routePath: "/",
      scenarioSource: "./scenario.mjs",
      screenshotPath,
      stateId: "default",
      status: "passed",
      theme: "light",
      url: "https://example.test/",
      viewport: { height: 900, width: 1440 },
      viewportId: "desktop",
    }],
    generatedAt: "2026-09-06T12:00:00.000Z",
    project: { baseURL },
    schemaVersion: 1,
    summary: {
      coverage: calculateCoverage(cells, [{
        passed: true,
        routeId: "home",
        stateId: "default",
        theme: "light",
        viewportId: "desktop",
      }]),
      durationMs: 7,
      executions: 1,
      failed: 0,
      passed: 1,
      routes: 1,
      states: 1,
    },
  });
  const reportContents = serializeReport(report);
  const screenshot = Uint8Array.from([137, 80, 78, 71, 1]);
  const toolVersion = await guardToolVersion();
  const plan = createShardPlan({
    configDigest: contractConfigDigest(configuration),
    contractDigest: contractDigest(contract),
    coordinateIds: configuration.map(({ id }) => id),
    createdAt: new Date(report.generatedAt),
    nonce: "0123456789abcdef0123456789abcdef",
    reportSchemaVersion: 1,
    shardCount: 1,
    targetDigest: shardTargetDigest(baseURL),
    toolVersion,
    ttlMinutes: 60,
  });
  const bundlePath = `.uiwitness/shards/${plan.runSetId}/1-of-1`;
  const bundleRoot = join(project, bundlePath);
  const evidencePath = `evidence/${screenshotPath.slice(".uiwitness/".length)}`;
  await mkdir(join(bundleRoot, ...evidencePath.split("/").slice(0, -1)), { recursive: true });
  await writeFile(join(bundleRoot, "report.json"), reportContents, "utf8");
  await writeFile(join(bundleRoot, ...evidencePath.split("/")), screenshot);
  await writeFile(join(bundleRoot, "manifest.json"), serializeShardBundleManifest({
    assignedCoordinateIds: [...plan.coordinateIds],
    assignmentAlgorithm: SHARD_ASSIGNMENT_ALGORITHM,
    configDigest: plan.configDigest,
    contractDigest: plan.contractDigest,
    createdAt: plan.createdAt,
    environmentId: plan.environmentId,
    evaluatedOn: plan.evaluatedOn,
    evidence: { attempted: 1, captured: 1, masks: [], omitted: 0, retention: "all" },
    executedCoordinateIds: [...plan.coordinateIds],
    expiresAt: plan.expiresAt,
    files: [
      { bytes: screenshot.byteLength, digest: digest(screenshot), path: evidencePath, role: "evidence" as const },
      { bytes: Buffer.byteLength(reportContents), digest: digest(reportContents), path: "report.json", role: "report" as const },
    ].sort((left, right) => left.path.localeCompare(right.path)),
    nonce: plan.nonce,
    planDigest: shardPlanDigest(plan),
    reportDigest: digest(reportContents),
    reportSchemaVersion: plan.reportSchemaVersion,
    runSetId: plan.runSetId,
    schemaVersion: SHARD_BUNDLE_MANIFEST_SCHEMA_VERSION,
    shardCount: 1,
    shardIndex: 1,
    targetDigest: plan.targetDigest,
    toolVersion,
  }), "utf8");
  return { bundlePath, project, runSetId: plan.runSetId };
}

describe("guard shard merge orchestration", () => {
  it("rejects authenticated configurations before inspecting bundle inputs", async () => {
    const project = await mkdtemp(join(tmpdir(), "uiwitness-cli-merge-auth-"));
    projects.push(project);
    await writeFile(join(project, "uiwitness.config.mjs"), `export default ${JSON.stringify({
      authentication: { mode: "shared-readonly", setup: "./auth.mjs" },
      baseURL,
      routes: [{ id: "home", path: "/", states: [{ id: "default", setup: "./scenario.mjs" }] }],
      themes: ["light"],
      viewports: { desktop: { height: 900, width: 1440 } },
    }, null, 2)};\n`, "utf8");

    await expect(mergeGuardShards({ cwd: project, inputs: ["missing"] }))
      .rejects.toMatchObject({ code: "GUARD_SHARD_AUTH_UNSUPPORTED" });
  });

  it("publishes one authoritative verdict and committed generation without browser work", async () => {
    const value = await fixture();
    const result = await mergeGuardShards({
      cwd: value.project,
      inputs: [value.bundlePath],
      now: () => new Date("2026-09-06T12:30:00.000Z"),
    });

    expect(result.comparison.verdict).toBe("passed");
    expect(result.comparison.evaluatedOn).toBe("2026-09-06");
    expect(result.runSetId).toBe(value.runSetId);
    expect(result.inputCount).toBe(1);
    expect(result.proposalPath).toBeUndefined();
    expect(JSON.parse(await readFile(join(value.project, result.verdictPath), "utf8"))).toMatchObject({
      complete: true,
      verdict: "passed",
    });
    expect(parseCommittedGeneration(await readFile(join(value.project, ".uiwitness/generation.json"), "utf8")))
      .toMatchObject({ schemaVersion: 1 });
  });

  it("fails closed before publication when the current contract no longer matches the run set", async () => {
    const value = await fixture();
    const contractPath = join(value.project, "uiwitness.contract.json");
    const contract = JSON.parse(await readFile(contractPath, "utf8")) as { configDigest: string };
    contract.configDigest = `sha256:${"f".repeat(64)}`;
    await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");

    await expect(mergeGuardShards({
      cwd: value.project,
      inputs: [value.bundlePath],
      now: () => new Date("2026-09-06T12:30:00.000Z"),
    })).rejects.toMatchObject({ code: "GUARD_SHARD_MERGE_INVALID" });
    await expect(readFile(join(value.project, ".uiwitness/generation.json"), "utf8"))
      .rejects.toMatchObject({ code: "ENOENT" });
  });
});
