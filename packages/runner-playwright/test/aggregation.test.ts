import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  EVIDENCE_MANIFEST_PATH,
  assignedShardCoordinateIds,
  canonicalizeJson,
  createShardPlan,
  expandMatrix,
  parseConfig,
  parseEvidenceManifest,
  parseExecutionResult,
  parseShardBundleManifest,
  screenshotArtifactPath,
  serializeReport,
  serializeShardBundleManifest,
  shardTargetDigest,
  type EvidenceConfig,
  type MatrixCell,
  type Sha256Digest,
  type UIWitnessShardPlan,
} from "uiwitness-core";

import { mergeShardScenarioBundles } from "../src/aggregation.js";
import {
  reportForExecutionArtifacts,
  type ExecutionArtifact,
} from "../src/persistence.js";
import { publishShardBundle } from "../src/sharding.js";

const baseURL = "https://example.test/app/";
const configDigest = `sha256:${"a".repeat(64)}` as Sha256Digest;
const contractDigest = `sha256:${"b".repeat(64)}` as Sha256Digest;
const projects: string[] = [];

function coordinateId(cell: MatrixCell): string {
  return `${cell.route.id}/${cell.state.id}/${cell.viewportId}/${cell.theme}`;
}

function cells(): readonly MatrixCell[] {
  return [...expandMatrix(parseConfig({
    baseURL,
    routes: [
      { id: "home", path: "/", states: [{ id: "default", setup: "./scenario.mjs" }] },
      { id: "settings", path: "/settings", states: [{ id: "empty", setup: "./scenario.mjs" }] },
    ],
    themes: ["light", "dark"],
    viewports: { desktop: { height: 900, width: 1440 } },
  }))];
}

function artifact(cell: MatrixCell, index: number, options: {
  readonly failed?: boolean;
  readonly masks?: readonly { readonly count: number; readonly id: string }[];
  readonly retention?: "all" | "failures-only" | "none";
} = {}): ExecutionArtifact {
  const failed = options.failed ?? false;
  const retention = options.retention ?? "all";
  const retained = retention === "all" || (retention === "failures-only" && failed);
  const screenshotPath = screenshotArtifactPath(cell);
  return Object.freeze({
    masks: Object.freeze([...(options.masks ?? [])]),
    result: parseExecutionResult({
      diagnostics: { consoleErrors: [], failedRequests: [], navigationStatus: 200, pageErrors: [] },
      durationMs: index + 1,
      failures: failed ? [{ code: "ASSERTION_FAILED", message: "fixture failure" }] : [],
      routeId: cell.route.id,
      routePath: cell.route.path,
      scenarioSource: cell.state.setup,
      screenshotPath,
      stateId: cell.state.id,
      status: failed ? "failed" : "passed",
      theme: cell.theme,
      url: new URL(cell.route.path, baseURL).href,
      viewport: cell.viewport,
      viewportId: cell.viewportId,
    }),
    screenshot: retained ? Uint8Array.from([137, 80, 78, 71, index]) : null,
    screenshotAttempted: retention !== "none",
    screenshotStatus: retained ? "captured" : "omitted-by-policy",
  });
}

async function project(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "uiwitness-aggregation-"));
  projects.push(root);
  return root;
}

function planFor(
  allCells: readonly MatrixCell[],
  options: {
    readonly nonce?: string;
    readonly reportSchemaVersion?: 1 | 2;
    readonly shardCount?: number;
    readonly targetURL?: string;
    readonly toolVersion?: string;
  } = {},
): UIWitnessShardPlan {
  return createShardPlan({
    configDigest,
    contractDigest,
    coordinateIds: allCells.map(coordinateId),
    createdAt: new Date("2026-09-06T12:00:00.000Z"),
    nonce: options.nonce ?? "0123456789abcdef0123456789abcdef",
    reportSchemaVersion: options.reportSchemaVersion ?? 1,
    shardCount: options.shardCount ?? 2,
    targetDigest: shardTargetDigest(options.targetURL ?? baseURL),
    toolVersion: options.toolVersion ?? "0.26.10",
    ttlMinutes: 60,
  });
}

async function publishBundles(input: {
  readonly artifacts: readonly ExecutionArtifact[];
  readonly cells: readonly MatrixCell[];
  readonly evidence?: EvidenceConfig;
  readonly plan: UIWitnessShardPlan;
  readonly root: string;
  readonly reportBaseURL?: string;
}): Promise<readonly string[]> {
  const artifactById = new Map(input.cells.map((cell, index) => [coordinateId(cell), input.artifacts[index]!]));
  const paths: string[] = [];
  for (let index = 1; index <= input.plan.shardCount; index += 1) {
    const ids = new Set(assignedShardCoordinateIds(input.plan, index));
    const shardCells = input.cells.filter((cell) => ids.has(coordinateId(cell)));
    const shardArtifacts = shardCells.map((cell) => artifactById.get(coordinateId(cell))!);
    const report = reportForExecutionArtifacts(
      shardCells,
      shardArtifacts,
      input.reportBaseURL ?? baseURL,
      input.plan.createdAt,
      input.evidence,
    );
    paths.push((await publishShardBundle(input.root, input.plan, index, report, shardArtifacts)).bundlePath);
  }
  return paths;
}

afterEach(async () => {
  await Promise.all(projects.splice(0).map((root) => rm(root, { force: true, recursive: true })));
});

describe("fail-closed shard aggregation", () => {
  it("merges every shard independent of input order and publishes normalized final output", async () => {
    const root = await project();
    const allCells = cells();
    const artifacts = allCells.map((cell, index) => artifact(cell, index));
    const plan = planFor(allCells, { shardCount: 3 });
    const paths = await publishBundles({ artifacts, cells: allCells, plan, root });

    const merged = await mergeShardScenarioBundles({
      baseURL,
      bundlePaths: [...paths].reverse(),
      cells: allCells,
      configDigest,
      contractDigest,
      now: () => new Date("2026-09-06T12:30:00.000Z"),
      projectDirectory: root,
      toolVersion: plan.toolVersion,
    });
    const expected = reportForExecutionArtifacts(allCells, artifacts, baseURL, plan.createdAt, undefined);

    expect(serializeReport(merged.report)).toBe(serializeReport(expected));
    expect(allCells.map(coordinateId)).not.toEqual(plan.coordinateIds);
    expect(merged.manifests.map(({ shardIndex }) => shardIndex)).toEqual([1, 2, 3]);
    expect(merged.report.executions.map((execution) =>
      `${execution.routeId}/${execution.stateId}/${execution.viewportId}/${execution.theme}`
    )).toEqual(allCells.map(coordinateId));
    await expect(access(join(root, ".uiwitness/generation.json"))).resolves.toBeUndefined();
    await expect(readFile(join(root, ".uiwitness/report/uiwitness.json"), "utf8"))
      .resolves.toBe(serializeReport(expected));
    for (const cell of allCells) {
      await expect(access(join(root, ...screenshotArtifactPath(cell).split("/")))).resolves.toBeUndefined();
    }
  });

  it("preserves privacy-safe mask cardinalities and retention totals in the final generation", async () => {
    const root = await project();
    const allCells = cells().slice(0, 2);
    const evidence = {
      masks: [{ count: 1, id: "account-number", selector: "[data-private]" }],
      retention: "failures-only" as const,
    };
    const artifacts = [
      artifact(allCells[0]!, 0, { masks: [{ count: 1, id: "account-number" }], retention: "failures-only" }),
      artifact(allCells[1]!, 1, { failed: true, masks: [{ count: 1, id: "account-number" }], retention: "failures-only" }),
    ];
    const plan = planFor(allCells, { reportSchemaVersion: 2, shardCount: 1 });
    const paths = await publishBundles({ artifacts, cells: allCells, evidence, plan, root });

    await mergeShardScenarioBundles({
      baseURL,
      bundlePaths: paths,
      cells: allCells,
      configDigest,
      contractDigest,
      now: () => new Date("2026-09-06T12:30:00.000Z"),
      evidence,
      projectDirectory: root,
      toolVersion: plan.toolVersion,
    });
    const manifest = parseEvidenceManifest(await readFile(join(root, ...EVIDENCE_MANIFEST_PATH.split("/")), "utf8"));
    expect(manifest).toMatchObject({
      attempted: 2,
      captured: 1,
      masks: [{ cardinalities: [1, 1], id: "account-number" }],
      omitted: 1,
      retention: "failures-only",
    });
  });

  it("preserves the prior committed generation when finalization fails", async () => {
    const root = await project();
    const allCells = cells();
    const artifacts = allCells.map((cell, index) => artifact(cell, index));
    const plan = planFor(allCells, { shardCount: 1 });
    const paths = await publishBundles({ artifacts, cells: allCells, plan, root });
    const common = {
      baseURL,
      bundlePaths: paths,
      cells: allCells,
      configDigest,
      contractDigest,
      now: () => new Date("2026-09-06T12:30:00.000Z"),
      projectDirectory: root,
      toolVersion: plan.toolVersion,
    } as const;
    await mergeShardScenarioBundles(common);
    const priorGeneration = await readFile(join(root, ".uiwitness/generation.json"), "utf8");
    const priorReport = await readFile(join(root, ".uiwitness/report/uiwitness.json"), "utf8");

    await expect(mergeShardScenarioBundles({
      ...common,
      finalizeGeneration: () => {
        throw new Error("fixture finalization failure");
      },
    })).rejects.toThrow("fixture finalization failure");
    await expect(readFile(join(root, ".uiwitness/generation.json"), "utf8"))
      .resolves.toBe(priorGeneration);
    await expect(readFile(join(root, ".uiwitness/report/uiwitness.json"), "utf8"))
      .resolves.toBe(priorReport);
  });

  it("rechecks plan expiry at the final publication boundary", async () => {
    const root = await project();
    const allCells = cells();
    const artifacts = allCells.map((cell, index) => artifact(cell, index));
    const plan = planFor(allCells, { shardCount: 1 });
    const paths = await publishBundles({ artifacts, cells: allCells, plan, root });
    let clockCalls = 0;

    await expect(mergeShardScenarioBundles({
      baseURL,
      bundlePaths: paths,
      cells: allCells,
      configDigest,
      contractDigest,
      now: () => new Date(clockCalls++ === 0
        ? "2026-09-06T12:30:00.000Z"
        : plan.expiresAt),
      projectDirectory: root,
      toolVersion: plan.toolVersion,
    })).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
    expect(clockCalls).toBe(2);
    await expect(access(join(root, ".uiwitness/generation.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects oversized declared bundle contents before loading file bytes", async () => {
    const root = await project();
    const allCells = cells();
    const artifacts = allCells.map((cell, index) => artifact(cell, index));
    const plan = planFor(allCells, { shardCount: 1 });
    const paths = await publishBundles({ artifacts, cells: allCells, plan, root });
    const manifestPath = join(root, paths[0]!, "manifest.json");
    const manifest = parseShardBundleManifest(await readFile(manifestPath, "utf8"));
    await writeFile(manifestPath, serializeShardBundleManifest({
      ...manifest,
      files: manifest.files.map((file) => file.role === "report"
        ? { ...file, bytes: 256 * 1_024 * 1_024 + 1 }
        : file),
    }), "utf8");

    await expect(mergeShardScenarioBundles({
      baseURL,
      bundlePaths: paths,
      cells: allCells,
      configDigest,
      contractDigest,
      now: () => new Date("2026-09-06T12:30:00.000Z"),
      projectDirectory: root,
      toolVersion: plan.toolVersion,
    })).rejects.toThrow("256 MiB aggregate input limit");
  });

  it("rejects missing, duplicate, mixed, expired, target-drifted, and tampered inputs without publishing", async () => {
    const root = await project();
    const allCells = cells();
    const artifacts = allCells.map((cell, index) => artifact(cell, index));
    const plan = planFor(allCells);
    const paths = await publishBundles({ artifacts, cells: allCells, plan, root });
    const merge = (bundlePaths: readonly string[], evaluatedAt = new Date("2026-09-06T12:30:00.000Z")) =>
      mergeShardScenarioBundles({
        baseURL,
        bundlePaths,
        cells: allCells,
        configDigest,
        contractDigest,
        now: () => evaluatedAt,
        projectDirectory: root,
        toolVersion: plan.toolVersion,
      });

    await expect(merge(paths.slice(0, 1))).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
    await expect(merge([paths[0]!, paths[0]!])).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
    await expect(merge(paths, new Date(plan.expiresAt))).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
    await expect(mergeShardScenarioBundles({
      baseURL: "https://other.example.test/",
      bundlePaths: paths,
      cells: allCells,
      configDigest,
      contractDigest,
      now: () => new Date("2026-09-06T12:30:00.000Z"),
      projectDirectory: root,
      toolVersion: plan.toolVersion,
    })).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });

    const mixedPlan = planFor(allCells, { nonce: "1123456789abcdef0123456789abcdef" });
    const mixedPaths = await publishBundles({ artifacts, cells: allCells, plan: mixedPlan, root });
    await expect(merge([paths[0]!, mixedPaths[1]!])).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });

    await writeFile(join(root, paths[0]!, "report.json"), "{}\n", "utf8");
    await expect(merge(paths)).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
    await expect(access(join(root, ".uiwitness/generation.json"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a bundle set whose manifests claim overlapping coordinates", async () => {
    const root = await project();
    const allCells = cells();
    const artifacts = allCells.map((cell, index) => artifact(cell, index));
    const plan = planFor(allCells);
    const paths = await publishBundles({ artifacts, cells: allCells, plan, root });
    const firstManifest = parseShardBundleManifest(
      await readFile(join(root, paths[0]!, "manifest.json"), "utf8"),
    );
    const secondManifestPath = join(root, paths[1]!, "manifest.json");
    const secondManifest = JSON.parse(await readFile(secondManifestPath, "utf8"));
    const overlappingCoordinate = firstManifest.assignedCoordinateIds[0]!;
    secondManifest.assignedCoordinateIds = [overlappingCoordinate];
    secondManifest.executedCoordinateIds = [overlappingCoordinate];
    await writeFile(secondManifestPath, `${canonicalizeJson(secondManifest)}\n`, "utf8");

    await expect(mergeShardScenarioBundles({
      baseURL,
      bundlePaths: paths,
      cells: allCells,
      configDigest,
      contractDigest,
      now: () => new Date("2026-09-06T12:30:00.000Z"),
      projectDirectory: root,
      toolVersion: plan.toolVersion,
    })).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
    await expect(access(join(root, ".uiwitness/generation.json")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects report/baseURL disagreement even when every file checksum is internally valid", async () => {
    const root = await project();
    const allCells = cells();
    const artifacts = allCells.map((cell, index) => artifact(cell, index));
    const plan = planFor(allCells, { shardCount: 1 });
    const paths = await publishBundles({
      artifacts,
      cells: allCells,
      plan,
      reportBaseURL: "https://example.test/other/",
      root,
    });
    await expect(mergeShardScenarioBundles({
      baseURL,
      bundlePaths: paths,
      cells: allCells,
      configDigest,
      contractDigest,
      now: () => new Date("2026-09-06T12:30:00.000Z"),
      projectDirectory: root,
      toolVersion: plan.toolVersion,
    })).rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
  });

  it("rejects current inventory/tool drift, unexpected files, and cross-bundle evidence collisions", async () => {
    const root = await project();
    const allCells = cells();
    const artifacts = allCells.map((cell, index) => artifact(cell, index));
    const plan = planFor(allCells);
    const paths = await publishBundles({ artifacts, cells: allCells, plan, root });
    const common = {
      baseURL,
      bundlePaths: paths,
      configDigest,
      contractDigest,
      now: () => new Date("2026-09-06T12:30:00.000Z"),
      projectDirectory: root,
      toolVersion: plan.toolVersion,
    } as const;
    const addedCell = expandMatrix(parseConfig({
      baseURL,
      routes: [{ id: "added", path: "/added", states: [{ id: "default", setup: "./scenario.mjs" }] }],
      themes: ["light"],
      viewports: { desktop: { height: 900, width: 1440 } },
    }))[0]!;
    await expect(mergeShardScenarioBundles({ ...common, cells: [...allCells, addedCell] }))
      .rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
    await expect(mergeShardScenarioBundles({ ...common, cells: allCells, toolVersion: "0.26.999" }))
      .rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });

    await writeFile(join(root, paths[0]!, "unexpected.txt"), "not committed\n", "utf8");
    await expect(mergeShardScenarioBundles({ ...common, cells: allCells }))
      .rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
    await rm(join(root, paths[0]!, "unexpected.txt"));

    const firstManifestPath = join(root, paths[0]!, "manifest.json");
    const secondManifestPath = join(root, paths[1]!, "manifest.json");
    const firstManifest = parseShardBundleManifest(await readFile(firstManifestPath, "utf8"));
    const secondManifest = parseShardBundleManifest(await readFile(secondManifestPath, "utf8"));
    const collision = firstManifest.files.find(({ role }) => role === "evidence")!.path;
    let changedEvidence = false;
    const changedFiles = secondManifest.files.map((file) => {
      if (file.role !== "evidence" || changedEvidence) return file;
      changedEvidence = true;
      return { ...file, path: collision };
    }).sort((left, right) => left.path.localeCompare(right.path));
    await writeFile(secondManifestPath, serializeShardBundleManifest({
      ...secondManifest,
      files: changedFiles,
    }), "utf8");
    await expect(mergeShardScenarioBundles({ ...common, cells: allCells }))
      .rejects.toMatchObject({ code: "SHARD_BUNDLE_INVALID" });
  });
});
