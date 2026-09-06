import { access, mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  createShardPlan,
  expandMatrix,
  parseConfig,
  parseExecutionResult,
  parseShardBundleManifest,
  screenshotArtifactPath,
  shardTargetDigest,
  type Sha256Digest,
} from "uiwitness-core";

import {
  runShardScenarioCells,
  ShardBundleError,
} from "../src/index.js";
import {
  reportForExecutionArtifacts,
  type ExecutionArtifact,
} from "../src/persistence.js";
import { publishShardBundle } from "../src/sharding.js";

const configDigest = `sha256:${"a".repeat(64)}` as Sha256Digest;
const contractDigest = `sha256:${"b".repeat(64)}` as Sha256Digest;
const scenarioBaseDirectory = fileURLToPath(
  new URL("./fixtures/scenarios/", import.meta.url),
);

function emptyPlan(nonce: string) {
  return createShardPlan({
    configDigest,
    contractDigest,
    coordinateIds: ["home/default/desktop/light"],
    createdAt: new Date("2026-09-05T12:00:00.000Z"),
    nonce,
    reportSchemaVersion: 1,
    shardCount: 2,
    targetDigest: shardTargetDigest("https://example.com"),
    toolVersion: "0.26.9",
  });
}

function twoEmptyShardPlan(nonce: string) {
  return createShardPlan({
    configDigest,
    contractDigest,
    coordinateIds: ["home/default/desktop/light"],
    createdAt: new Date("2026-09-05T12:00:00.000Z"),
    nonce,
    reportSchemaVersion: 1,
    shardCount: 3,
    targetDigest: shardTargetDigest("https://example.com"),
    toolVersion: "0.26.9",
  });
}

async function missing(path: string): Promise<boolean> {
  try {
    await access(path);
    return false;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return true;
    throw error;
  }
}

describe("immutable shard bundles", () => {
  it("publishes an empty shard without taking or changing the final-report lock", async () => {
    const root = await mkdtemp(join(tmpdir(), "uiwitness-shard-"));
    try {
      await mkdir(join(root, ".uiwitness", ".runner-persistence-lock"), {
        recursive: true,
      });
      const plan = emptyPlan("0123456789abcdef0123456789abcdef");
      const run = await runShardScenarioCells([], {
        baseURL: "https://example.com",
        evaluatedAt: new Date("2026-09-05T12:01:00.000Z"),
        plan,
        projectDirectory: root,
        scenarioBaseDirectory: root,
        shardIndex: 1,
      });

      expect(run.bundlePath).toBe(`.uiwitness/shards/${plan.runSetId}/1-of-2`);
      expect(run.report.executions).toEqual([]);
      expect(await missing(join(root, ".uiwitness", "generation.json"))).toBe(true);
      expect(await missing(join(root, ".uiwitness", "report"))).toBe(true);
      expect(await missing(join(root, ".uiwitness", ".runner-persistence-lock"))).toBe(false);

      const manifestSource = await readFile(
        join(root, run.bundlePath, "manifest.json"),
        "utf8",
      );
      const manifest = parseShardBundleManifest(manifestSource);
      expect(manifest.assignedCoordinateIds).toEqual([]);
      expect(manifest.files).toHaveLength(1);
      expect(manifest.files[0]?.path).toBe("report.json");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("never overwrites an existing bundle path", async () => {
    const root = await mkdtemp(join(tmpdir(), "uiwitness-shard-"));
    try {
      const plan = emptyPlan("1123456789abcdef0123456789abcdef");
      const options = {
        baseURL: "https://example.com",
        evaluatedAt: new Date("2026-09-05T12:01:00.000Z"),
        plan,
        projectDirectory: root,
        scenarioBaseDirectory: root,
        shardIndex: 1,
      } as const;
      await runShardScenarioCells([], options);
      await expect(runShardScenarioCells([], options)).rejects.toMatchObject({
        code: "SHARD_BUNDLE_EXISTS",
      });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a tampered direct-API plan before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "uiwitness-shard-"));
    try {
      const plan = emptyPlan("5123456789abcdef0123456789abcdef");
      await expect(runShardScenarioCells([], {
        baseURL: "https://example.com",
        evaluatedAt: new Date("2026-09-05T12:01:00.000Z"),
        plan: { ...plan, runSetId: "0".repeat(64) },
        projectDirectory: root,
        scenarioBaseDirectory: root,
        shardIndex: 1,
      })).rejects.toMatchObject({ code: "SHARD_INVALID" });
      expect(await missing(join(root, ".uiwitness"))).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a direct-API target mismatch and authentication before publication", async () => {
    const root = await mkdtemp(join(tmpdir(), "uiwitness-shard-"));
    try {
      const plan = emptyPlan("6123456789abcdef0123456789abcdef");
      const common = {
        evaluatedAt: new Date("2026-09-05T12:01:00.000Z"),
        plan,
        projectDirectory: root,
        scenarioBaseDirectory: root,
        shardIndex: 1,
      } as const;
      await expect(runShardScenarioCells([], {
        ...common,
        baseURL: "https://other.example",
      })).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
      await expect(runShardScenarioCells([], {
        ...common,
        authentication: { setup: "./auth.mjs" },
        baseURL: "https://example.com",
      } as never)).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
      expect(await missing(join(root, ".uiwitness"))).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects invalid output roots and evidence-policy drift before capture", async () => {
    const root = await mkdtemp(join(tmpdir(), "uiwitness-shard-"));
    try {
      const invalidRoot = join(root, "file-not-directory");
      await writeFile(invalidRoot, "not a directory", "utf8");
      const plan = createShardPlan({
        configDigest,
        contractDigest,
        coordinateIds: ["capture/ordered/compact/light"],
        createdAt: new Date("2026-09-05T12:00:00.000Z"),
        nonce: "a123456789abcdef0123456789abcdef",
        reportSchemaVersion: 1,
        shardCount: 1,
        targetDigest: shardTargetDigest("https://uiwitness.invalid/base/"),
        toolVersion: "0.26.9",
      });
      const cells = expandMatrix(parseConfig({
        baseURL: "https://uiwitness.invalid/base/",
        routes: [{ id: "capture", path: "/", states: [{ id: "ordered", setup: "./capture.mjs" }] }],
        themes: ["light"],
        viewports: { compact: { height: 240, width: 320 } },
      }));
      const common = {
        baseURL: "https://uiwitness.invalid/base/",
        evaluatedAt: new Date("2026-09-05T12:01:00.000Z"),
        plan,
        scenarioBaseDirectory,
        shardIndex: 1,
      } as const;
      await expect(runShardScenarioCells(cells, {
        ...common,
        projectDirectory: invalidRoot,
      })).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
      await expect(runShardScenarioCells(cells, {
        ...common,
        evidence: { retention: "none" },
        projectDirectory: root,
      })).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
      expect(await missing(join(root, ".uiwitness"))).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("checksums report and evidence bytes inside the bundle boundary", async () => {
    const root = await mkdtemp(join(tmpdir(), "uiwitness-shard-"));
    try {
      const cells = expandMatrix(parseConfig({
        baseURL: "https://example.com",
        routes: [{ id: "home", path: "/", states: [{ id: "default", setup: "./scenario.mjs" }] }],
        themes: ["light"],
        viewports: { desktop: { height: 900, width: 1440 } },
      }));
      const cell = cells[0]!;
      const coordinateId = "home/default/desktop/light";
      const plan = createShardPlan({
        configDigest,
        contractDigest,
        coordinateIds: [coordinateId],
        createdAt: new Date("2026-09-05T12:00:00.000Z"),
        nonce: "3123456789abcdef0123456789abcdef",
        reportSchemaVersion: 1,
        shardCount: 1,
        targetDigest: shardTargetDigest("https://example.com"),
        toolVersion: "0.26.9",
      });
      const screenshot = Uint8Array.from([1, 2, 3, 4]);
      const artifact: ExecutionArtifact = {
        result: parseExecutionResult({
          diagnostics: { consoleErrors: [], failedRequests: [], navigationStatus: 200, pageErrors: [] },
          durationMs: 10,
          failures: [],
          routeId: cell.route.id,
          routePath: cell.route.path,
          scenarioSource: cell.state.setup,
          screenshotPath: screenshotArtifactPath(cell),
          stateId: cell.state.id,
          status: "passed",
          theme: cell.theme,
          url: "https://example.com/",
          viewport: cell.viewport,
          viewportId: cell.viewportId,
        }),
        screenshot,
      };
      const report = reportForExecutionArtifacts(
        cells,
        [artifact],
        "https://example.com",
        plan.createdAt,
        undefined,
      );
      const published = await publishShardBundle(root, plan, 1, report, [artifact]);
      const evidence = published.manifest.files.find(({ role }) => role === "evidence")!;
      expect(evidence.path).toBe("evidence/artifacts/home/default/desktop-light.png");
      expect(evidence.bytes).toBe(4);
      expect(await readFile(join(root, published.bundlePath, evidence.path))).toEqual(Buffer.from(screenshot));
      expect(published.manifest.files.find(({ role }) => role === "report")?.digest)
        .toBe(published.manifest.reportDigest);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.each([
    ["all", 1, true],
    ["failures-only", 2, false],
    ["none", 2, false],
  ] as const)("runs a non-empty %s shard through capture and publication", async (
    retention,
    schemaVersion,
    expectsEvidence,
  ) => {
    const root = await mkdtemp(join(tmpdir(), "uiwitness-shard-capture-"));
    const eventKey = Symbol.for("uiwitness.test.capture-events");
    Reflect.set(globalThis, eventKey, []);
    try {
      const cells = expandMatrix(parseConfig({
        baseURL: "https://uiwitness.invalid/base/",
        evidence: { retention },
        routes: [{
          id: "capture",
          path: "/capture?source=uiwitness#panel",
          states: [{ id: "ordered", setup: "./capture.mjs" }],
        }],
        themes: ["light"],
        viewports: { compact: { height: 240, width: 320 } },
      }));
      const plan = createShardPlan({
        configDigest,
        contractDigest,
        coordinateIds: ["capture/ordered/compact/light"],
        createdAt: new Date("2026-09-05T12:00:00.000Z"),
        nonce: `${retention === "all" ? "7" : retention === "failures-only" ? "8" : "9"}123456789abcdef0123456789abcdef`,
        reportSchemaVersion: schemaVersion,
        shardCount: 1,
        targetDigest: shardTargetDigest("https://uiwitness.invalid/base/"),
        toolVersion: "0.26.9",
      });
      const run = await runShardScenarioCells(cells, {
        baseURL: "https://uiwitness.invalid/base/",
        evaluatedAt: new Date("2026-09-05T12:01:00.000Z"),
        evidence: { retention },
        plan,
        projectDirectory: root,
        scenarioBaseDirectory,
        shardIndex: 1,
      });

      expect(run.report.schemaVersion).toBe(schemaVersion);
      expect(run.report.executions).toHaveLength(1);
      expect(run.manifest.executedCoordinateIds).toEqual(["capture/ordered/compact/light"]);
      expect(run.manifest.files.some(({ role }) => role === "evidence")).toBe(expectsEvidence);
    } finally {
      Reflect.deleteProperty(globalThis, eventKey);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a symlinked shard root", async () => {
    const root = await mkdtemp(join(tmpdir(), "uiwitness-shard-"));
    const outside = await mkdtemp(join(tmpdir(), "uiwitness-shard-outside-"));
    try {
      await mkdir(join(root, ".uiwitness"));
      await symlink(outside, join(root, ".uiwitness", "shards"), "dir");
      const plan = emptyPlan("4123456789abcdef0123456789abcdef");
      await expect(runShardScenarioCells([], {
        baseURL: "https://example.com",
        evaluatedAt: new Date("2026-09-05T12:01:00.000Z"),
        plan,
        projectDirectory: root,
        scenarioBaseDirectory: root,
        shardIndex: 1,
      })).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
      expect(await missing(join(outside, plan.runSetId))).toBe(true);
    } finally {
      await rm(root, { force: true, recursive: true });
      await rm(outside, { force: true, recursive: true });
    }
  });

  it("isolates concurrent shards and permits only one publisher per shard", async () => {
    const root = await mkdtemp(join(tmpdir(), "uiwitness-shard-"));
    try {
      const plan = twoEmptyShardPlan("2123456789abcdef0123456789abcdef");
      const common = {
        baseURL: "https://example.com",
        evaluatedAt: new Date("2026-09-05T12:01:00.000Z"),
        plan,
        projectDirectory: root,
        scenarioBaseDirectory: root,
      } as const;
      const isolated = await Promise.all([
        runShardScenarioCells([], { ...common, shardIndex: 2 }),
        runShardScenarioCells([], { ...common, shardIndex: 3 }),
      ]);
      expect(isolated.map(({ bundlePath }) => bundlePath).sort()).toEqual([
        `.uiwitness/shards/${plan.runSetId}/2-of-3`,
        `.uiwitness/shards/${plan.runSetId}/3-of-3`,
      ]);

      const secondRoot = await mkdtemp(join(tmpdir(), "uiwitness-shard-race-"));
      try {
        const sameOptions = { ...common, projectDirectory: secondRoot, shardIndex: 2 };
        const settled = await Promise.allSettled([
          runShardScenarioCells([], sameOptions),
          runShardScenarioCells([], sameOptions),
        ]);
        expect(settled.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
        const rejection = settled.find(({ status }) => status === "rejected");
        expect(rejection?.status).toBe("rejected");
        if (rejection?.status === "rejected") {
          expect(rejection.reason).toBeInstanceOf(ShardBundleError);
          expect(rejection.reason).toMatchObject({ code: "SHARD_BUNDLE_EXISTS" });
        }
      } finally {
        await rm(secondRoot, { force: true, recursive: true });
      }
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
