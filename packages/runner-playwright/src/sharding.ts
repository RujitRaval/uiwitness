import { createHash } from "node:crypto";
import {
  constants as fsConstants,
  chmod,
  lstat,
  mkdir,
  open,
  realpath,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  SHARD_ASSIGNMENT_ALGORITHM,
  SHARD_BUNDLE_MANIFEST_SCHEMA_VERSION,
  PRIVACY_REPORT_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  assertShardPlanActive,
  assignedShardCoordinateIds,
  parseShardPlan,
  serializeReport,
  serializeShardPlan,
  serializeShardBundleManifest,
  shardPlanDigest,
  shardTargetDigest,
  type AnyUIWitnessReport,
  type EvidenceConfig,
  type MatrixCell,
  type Sha256Digest,
  type UIWitnessShardBundleManifest,
  type UIWitnessShardPlan,
} from "uiwitness-core";

import {
  runCapturedScenarioCells,
  type PrivacyRunCapturedScenarioCellsOptions,
  type RunCapturedScenarioCellsOptions,
} from "./capture.js";
import {
  executionArtifactForOutcome,
  reportForExecutionArtifacts,
  type ExecutionArtifact,
} from "./persistence.js";

const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

/** Filesystem and capture settings for one plan-bound shard. */
export interface RunShardScenarioCellsOptions extends Omit<
  RunCapturedScenarioCellsOptions,
  "authentication" | "evidence"
> {
  readonly evidence?: EvidenceConfig | undefined;
  /** Evaluation instant captured before browser work begins. */
  readonly evaluatedAt?: Date | undefined;
  readonly plan: UIWitnessShardPlan;
  readonly projectDirectory?: string | undefined;
  readonly shardIndex: number;
}

/** One complete immutable partial bundle. It is not a final contract verdict. */
export interface ShardScenarioRun {
  readonly bundlePath: string;
  readonly manifest: UIWitnessShardBundleManifest;
  readonly report: AnyUIWitnessReport;
}

/** Stable runner-layer failures callers can classify without message matching. */
export type ShardBundleErrorCode =
  | "SHARD_BUNDLE_EXISTS"
  | "SHARD_BUNDLE_INVALID"
  | "SHARD_BUNDLE_WRITE_FAILED";

export class ShardBundleError extends Error {
  readonly code: ShardBundleErrorCode;

  constructor(code: ShardBundleErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ShardBundleError";
    this.code = code;
  }
}

function coordinateId(cell: MatrixCell): string {
  return `${cell.route.id}/${cell.state.id}/${cell.viewportId}/${cell.theme}`;
}

function digest(contents: string | Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

async function projectRoot(directory: string | undefined): Promise<string> {
  const candidate = resolve(directory ?? process.cwd());
  const metadata = await stat(candidate);
  if (!metadata.isDirectory()) {
    throw new ShardBundleError("SHARD_BUNDLE_INVALID", "projectDirectory must refer to an existing directory.");
  }
  return realpath(candidate);
}

async function assertBundleAvailable(
  root: string,
  plan: UIWitnessShardPlan,
  shardIndex: number,
): Promise<void> {
  const destination = join(
    root,
    ".uiwitness",
    "shards",
    plan.runSetId,
    `${shardIndex}-of-${plan.shardCount}`,
  );
  assertContained(root, destination);
  try {
    await lstat(destination);
    throw new ShardBundleError(
      "SHARD_BUNDLE_EXISTS",
      `Immutable shard bundle already exists: ${shardIndex}-of-${plan.shardCount}.`,
    );
  } catch (error: unknown) {
    if (error instanceof ShardBundleError) throw error;
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw new ShardBundleError(
        "SHARD_BUNDLE_INVALID",
        "Shard bundle destination could not be inspected.",
        { cause: error },
      );
    }
  }
}

function assertContained(root: string, destination: string): void {
  const local = relative(root, destination);
  if (
    local.length === 0 || local === ".." || local.startsWith(`..${sep}`) ||
    isAbsolute(local)
  ) {
    throw new ShardBundleError("SHARD_BUNDLE_INVALID", "Shard bundle paths must remain beneath the project directory.");
  }
}

async function ensurePrivateDirectory(parent: string, segment: string): Promise<string> {
  const destination = join(parent, segment);
  assertContained(parent, destination);
  let created = false;
  try {
    await mkdir(destination, { mode: privateDirectoryMode });
    created = true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
  const metadata = await lstat(destination);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new ShardBundleError("SHARD_BUNDLE_INVALID", "Shard bundle parents must be real directories.");
  }
  if (created && process.platform !== "win32") await chmod(destination, privateDirectoryMode);
  if (created) await syncDirectory(parent);
  return destination;
}

async function createBundleDirectory(parent: string, segment: string): Promise<string> {
  const destination = join(parent, segment);
  assertContained(parent, destination);
  try {
    await mkdir(destination, { mode: privateDirectoryMode });
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new ShardBundleError(
        "SHARD_BUNDLE_EXISTS",
        `Immutable shard bundle already exists: ${segment}.`,
        { cause: error },
      );
    }
    throw error;
  }
  return destination;
}

async function writePrivateFile(destination: string, contents: string | Uint8Array): Promise<void> {
  const handle = await open(
    destination,
    fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
    privateFileMode,
  );
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function safeScreenshotSegments(path: string): readonly string[] {
  if (path.length > 1_024 || !path.startsWith(".uiwitness/artifacts/") || path.includes("\\") || path.includes("\0")) {
    throw new ShardBundleError("SHARD_BUNDLE_INVALID", "Shard evidence path is not a canonical UIWitness artifact path.");
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment.length === 0 || segment === "." || segment === "..")) {
    throw new ShardBundleError("SHARD_BUNDLE_INVALID", "Shard evidence paths cannot contain traversal segments.");
  }
  return segments.slice(2);
}

async function writeEvidenceFile(
  bundleRoot: string,
  artifact: ExecutionArtifact,
): Promise<{ readonly bytes: number; readonly digest: Sha256Digest; readonly path: string; readonly role: "evidence" } | null> {
  if (artifact.screenshot === null || artifact.result.screenshotPath === null) return null;
  const segments = safeScreenshotSegments(artifact.result.screenshotPath);
  let directory = await ensurePrivateDirectory(bundleRoot, "evidence");
  directory = await ensurePrivateDirectory(directory, "artifacts");
  for (const segment of segments.slice(0, -1)) {
    directory = await ensurePrivateDirectory(directory, segment);
  }
  const filename = segments.at(-1);
  if (filename === undefined) {
    throw new ShardBundleError("SHARD_BUNDLE_INVALID", "Shard evidence path requires a filename.");
  }
  const destination = join(directory, filename);
  assertContained(bundleRoot, destination);
  await writePrivateFile(destination, artifact.screenshot);
  await syncDirectory(directory);
  return Object.freeze({
    bytes: artifact.screenshot.byteLength,
    digest: digest(artifact.screenshot),
    path: ["evidence", "artifacts", ...segments].join("/"),
    role: "evidence" as const,
  });
}

/**
 * @internal Publishes report/evidence bytes into an exclusive directory and writes
 * manifest.json last as the commit marker. Readers must ignore bundles without it.
 */
export async function publishShardBundle(
  root: string,
  plan: UIWitnessShardPlan,
  shardIndex: number,
  report: AnyUIWitnessReport,
  artifacts: readonly ExecutionArtifact[],
): Promise<{ readonly bundlePath: string; readonly manifest: UIWitnessShardBundleManifest }> {
  const assignedCoordinateIds = assignedShardCoordinateIds(plan, shardIndex);
  const executedCoordinateIds = report.executions.map((execution) =>
    `${execution.routeId}/${execution.stateId}/${execution.viewportId}/${execution.theme}`
  ).sort();
  if (
    assignedCoordinateIds.length !== executedCoordinateIds.length ||
    assignedCoordinateIds.some((value, index) => value !== executedCoordinateIds[index])
  ) {
    throw new ShardBundleError("SHARD_BUNDLE_INVALID", "Shard report does not exactly cover its plan assignment.");
  }

  const evidenceRoot = await ensurePrivateDirectory(root, ".uiwitness");
  const shardsRoot = await ensurePrivateDirectory(evidenceRoot, "shards");
  const runSetRoot = await ensurePrivateDirectory(shardsRoot, plan.runSetId);
  const shardSegment = `${shardIndex}-of-${plan.shardCount}`;
  const bundleRoot = await createBundleDirectory(runSetRoot, shardSegment);
  let committed = false;
  try {
    const files: Array<{
      readonly bytes: number;
      readonly digest: Sha256Digest;
      readonly path: string;
      readonly role: "evidence" | "report";
    }> = [];
    for (const artifact of artifacts) {
      const descriptor = await writeEvidenceFile(bundleRoot, artifact);
      if (descriptor !== null) files.push(descriptor);
    }
    const reportContents = serializeReport(report);
    await writePrivateFile(join(bundleRoot, "report.json"), reportContents);
    const reportDigest = digest(reportContents);
    files.push(Object.freeze({
      bytes: Buffer.byteLength(reportContents, "utf8"),
      digest: reportDigest,
      path: "report.json",
      role: "report" as const,
    }));
    files.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    await syncDirectory(bundleRoot);

    const manifest: UIWitnessShardBundleManifest = Object.freeze({
      assignedCoordinateIds,
      assignmentAlgorithm: SHARD_ASSIGNMENT_ALGORITHM,
      configDigest: plan.configDigest,
      contractDigest: plan.contractDigest,
      createdAt: plan.createdAt,
      environmentId: plan.environmentId,
      evaluatedOn: plan.evaluatedOn,
      executedCoordinateIds: Object.freeze(executedCoordinateIds),
      expiresAt: plan.expiresAt,
      files: Object.freeze(files),
      nonce: plan.nonce,
      planDigest: shardPlanDigest(plan),
      reportDigest,
      reportSchemaVersion: plan.reportSchemaVersion,
      runSetId: plan.runSetId,
      schemaVersion: SHARD_BUNDLE_MANIFEST_SCHEMA_VERSION,
      shardCount: plan.shardCount,
      shardIndex,
      targetDigest: plan.targetDigest,
      toolVersion: plan.toolVersion,
    });
    await writePrivateFile(
      join(bundleRoot, "manifest.json"),
      serializeShardBundleManifest(manifest),
    );
    committed = true;
    await syncDirectory(bundleRoot);
    await syncDirectory(runSetRoot);
    return Object.freeze({
      bundlePath: `.uiwitness/shards/${plan.runSetId}/${shardSegment}`,
      manifest,
    });
  } catch (error: unknown) {
    throw error instanceof ShardBundleError
      ? error
      : new ShardBundleError("SHARD_BUNDLE_WRITE_FAILED", "Could not publish the immutable shard bundle.", { cause: error });
  } finally {
    if (!committed) {
      await rm(bundleRoot, { force: true, recursive: true }).catch(() => undefined);
    }
  }
}

/** Runs exactly one deterministic shard and publishes only its immutable bundle. */
export async function runShardScenarioCells(
  cells: readonly MatrixCell[],
  options: RunShardScenarioCellsOptions,
): Promise<ShardScenarioRun> {
  if ("authentication" in options && options.authentication !== undefined) {
    throw new ShardBundleError(
      "SHARD_BUNDLE_INVALID",
      "Sharded runs do not support authentication.",
    );
  }
  const plan = parseShardPlan(serializeShardPlan(options.plan));
  if (shardTargetDigest(options.baseURL, plan.environmentId) !== plan.targetDigest) {
    throw new ShardBundleError(
      "SHARD_BUNDLE_INVALID",
      "Runner baseURL and environment do not match the shard-plan target digest.",
    );
  }
  const evaluatedAt = new Date((options.evaluatedAt ?? new Date()).getTime());
  assertShardPlanActive(plan, evaluatedAt);
  const root = await projectRoot(options.projectDirectory);
  await assertBundleAvailable(root, plan, options.shardIndex);
  const expectedReportSchemaVersion =
    options.evidence?.retention === "failures-only" || options.evidence?.retention === "none"
      ? PRIVACY_REPORT_SCHEMA_VERSION
      : REPORT_SCHEMA_VERSION;
  if (plan.reportSchemaVersion !== expectedReportSchemaVersion) {
    throw new ShardBundleError(
      "SHARD_BUNDLE_INVALID",
      "Shard evidence policy does not match the plan report schema.",
    );
  }
  const assigned = assignedShardCoordinateIds(plan, options.shardIndex);
  const actual = cells.map(coordinateId).sort();
  if (assigned.length !== actual.length || assigned.some((value, index) => value !== actual[index])) {
    throw new ShardBundleError("SHARD_BUNDLE_INVALID", "Runner cells do not exactly match the plan assignment.");
  }

  const outcomes = cells.length === 0
    ? []
    : options.evidence?.retention === "failures-only" || options.evidence?.retention === "none"
      ? await runCapturedScenarioCells(cells, options as PrivacyRunCapturedScenarioCellsOptions)
      : await runCapturedScenarioCells(cells, options as RunCapturedScenarioCellsOptions);
  const artifacts = outcomes.map((outcome) =>
    executionArtifactForOutcome(outcome, options.baseURL, options.evidence)
  );
  const report = reportForExecutionArtifacts(
    cells,
    artifacts,
    options.baseURL,
    plan.createdAt,
    options.evidence,
  );
  if (report.schemaVersion !== plan.reportSchemaVersion) {
    throw new ShardBundleError("SHARD_BUNDLE_INVALID", "Report schema does not match the shard plan.");
  }
  const published = await publishShardBundle(
    root,
    plan,
    options.shardIndex,
    report,
    artifacts,
  );
  return Object.freeze({ ...published, report });
}
