import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  PRIVACY_REPORT_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  SHARD_COORDINATE_LIMIT,
  SHARD_PLAN_SCHEMA_VERSION,
  ShardValidationError,
  assertShardPlanActive,
  assignedShardCoordinateIds,
  parseAnyReport,
  parseExecutionResult,
  parseShardBundleManifest,
  parseShardPlan,
  screenshotArtifactPath,
  serializeReport,
  serializeShardPlan,
  shardPlanDigest,
  shardTargetDigest,
  type AnyReportExecutionResult,
  type AnyUIWitnessReport,
  type EvidenceConfig,
  type MatrixCell,
  type Sha256Digest,
  type UIWitnessShardBundleManifest,
  type UIWitnessShardPlan,
} from "uiwitness-core";

import {
  acquirePersistenceLock,
  persistReport,
  releasePersistenceLock,
  reportForExecutionArtifacts,
  type ExecutionArtifact,
  type GenerationFinalization,
} from "./persistence.js";
import { ShardBundleError } from "./sharding.js";

const maximumManifestBytes = 16 * 1_024 * 1_024;
const maximumAggregateManifestBytes = 16 * 1_024 * 1_024;
const maximumAggregateBundleBytes = 256 * 1_024 * 1_024;

/** Finalizer invoked only after every bundle has been authenticated by its digests. */
export type ShardMergeFinalizer = (
  report: AnyUIWitnessReport,
  plan: UIWitnessShardPlan,
) => GenerationFinalization | Promise<GenerationFinalization>;

/** Current project bindings and immutable bundle inputs for one final merge. */
export interface MergeShardScenarioBundlesOptions {
  readonly baseURL: string;
  readonly bundlePaths: readonly string[];
  readonly cells: readonly MatrixCell[];
  readonly configDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly evidence?: EvidenceConfig | undefined;
  readonly finalizeGeneration?: ShardMergeFinalizer | undefined;
  /** Live merge clock checked before validation and again at publication. */
  readonly now?: (() => Date) | undefined;
  readonly projectDirectory?: string | undefined;
  readonly toolVersion: string;
}

/** One complete, atomically published aggregate. */
export interface MergedShardScenarioRun {
  readonly generation: Awaited<ReturnType<typeof persistReport>>;
  readonly htmlReportPath: ".uiwitness/report/index.html";
  readonly manifests: readonly UIWitnessShardBundleManifest[];
  readonly plan: UIWitnessShardPlan;
  readonly report: AnyUIWitnessReport;
  readonly reportPath: ".uiwitness/report/uiwitness.json";
}

interface BundleHeader {
  readonly manifest: UIWitnessShardBundleManifest;
  readonly manifestBytes: number;
  readonly root: string;
}

interface CheckedBundle extends BundleHeader {
  readonly bytes: ReadonlyMap<string, Uint8Array>;
}

interface VerifiedBundle extends CheckedBundle {
  readonly report: AnyUIWitnessReport;
}

function coordinateId(value: {
  readonly routeId: string;
  readonly stateId: string;
  readonly theme: string;
  readonly viewportId: string;
}): string {
  return `${value.routeId}/${value.stateId}/${value.viewportId}/${value.theme}`;
}

function cellCoordinateId(cell: MatrixCell): string {
  return coordinateId({
    routeId: cell.route.id,
    stateId: cell.state.id,
    theme: cell.theme,
    viewportId: cell.viewportId,
  });
}

function digest(contents: Uint8Array): Sha256Digest {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

function invalid(message: string, options?: ErrorOptions): never {
  throw new ShardBundleError("SHARD_BUNDLE_INVALID", message, options);
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function contained(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return local.length > 0 && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

async function projectRoot(directory: string | undefined): Promise<string> {
  const candidate = resolve(directory ?? process.cwd());
  const metadata = await stat(candidate);
  if (!metadata.isDirectory()) invalid("projectDirectory must refer to an existing directory.");
  return realpath(candidate);
}

async function bundleRoot(project: string, input: string): Promise<string> {
  if (input.length === 0 || input.length > 1_024 || [...input].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  })) {
    return invalid("Shard bundle input paths must be non-empty, bounded, and free of control characters.");
  }
  const candidate = resolve(project, input);
  if (!contained(project, candidate)) invalid("Shard bundle inputs must stay beneath the project directory.");
  const segments = relative(project, candidate).split(sep);
  let current = project;
  for (const segment of segments) {
    current = resolve(current, segment);
    let metadata;
    try {
      metadata = await lstat(current);
    } catch (error: unknown) {
      return invalid("Shard bundle input does not exist or cannot be inspected.", { cause: error });
    }
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      invalid("Shard bundle inputs must use only real directory boundaries.");
    }
  }
  if (await realpath(candidate) !== candidate) invalid("Shard bundle input resolved outside its lexical path.");
  return candidate;
}

async function headerFor(project: string, input: string): Promise<BundleHeader> {
  const root = await bundleRoot(project, input);
  const manifestPath = join(root, "manifest.json");
  let metadata;
  try {
    metadata = await lstat(manifestPath);
  } catch (error: unknown) {
    return invalid("Shard bundle is incomplete because manifest.json is missing.", { cause: error });
  }
  if (metadata.isSymbolicLink() || !metadata.isFile() || metadata.nlink !== 1) {
    invalid("Shard bundle manifest must be one regular, non-linked file.");
  }
  if (metadata.size > maximumManifestBytes) invalid("Shard bundle manifest exceeds the 16 MiB input limit.");
  let manifest: UIWitnessShardBundleManifest;
  try {
    manifest = parseShardBundleManifest(await readFile(manifestPath, "utf8"));
  } catch (error: unknown) {
    if (error instanceof ShardValidationError) {
      return invalid("Shard bundle manifest is invalid.", { cause: error });
    }
    throw error;
  }
  if (
    basename(root) !== `${manifest.shardIndex}-of-${manifest.shardCount}` ||
    basename(dirname(root)) !== manifest.runSetId
  ) {
    invalid("Shard bundle directory identity does not match its manifest.");
  }
  return Object.freeze({ manifest, manifestBytes: metadata.size, root });
}

function mergeInstant(now: (() => Date) | undefined): Date {
  return new Date((now?.() ?? new Date()).valueOf());
}

function assertMergePlanActive(plan: UIWitnessShardPlan, now: (() => Date) | undefined): void {
  try {
    assertShardPlanActive(plan, mergeInstant(now));
  } catch (error: unknown) {
    invalid("Shard bundle plan is expired or not active yet.", { cause: error });
  }
}

function reconstructPlan(manifests: readonly UIWitnessShardBundleManifest[]): UIWitnessShardPlan {
  const first = manifests[0];
  if (first === undefined) return invalid("At least one shard bundle input is required.");
  const coordinateIds = manifests.flatMap(({ assignedCoordinateIds }) => assignedCoordinateIds).sort();
  let plan: UIWitnessShardPlan;
  try {
    plan = parseShardPlan(serializeShardPlan({
      assignmentAlgorithm: first.assignmentAlgorithm,
      configDigest: first.configDigest,
      contractDigest: first.contractDigest,
      coordinateIds,
      createdAt: first.createdAt,
      environmentId: first.environmentId,
      evaluatedOn: first.evaluatedOn,
      expiresAt: first.expiresAt,
      nonce: first.nonce,
      reportSchemaVersion: first.reportSchemaVersion,
      runSetId: first.runSetId,
      schemaVersion: SHARD_PLAN_SCHEMA_VERSION,
      shardCount: first.shardCount,
      targetDigest: first.targetDigest,
      toolVersion: first.toolVersion,
    }));
  } catch (error: unknown) {
    return invalid("Shard bundle set does not reconstruct one valid coordinator plan.", { cause: error });
  }
  const expectedDigest = shardPlanDigest(plan);
  if (manifests.some(({ planDigest }) => planDigest !== expectedDigest)) {
    invalid("Shard bundle plan digests do not match the reconstructed complete run set.");
  }
  return plan;
}

function validateHeaders(
  headers: readonly BundleHeader[],
  options: MergeShardScenarioBundlesOptions,
): UIWitnessShardPlan {
  if (headers.length === 0 || headers.length > SHARD_COORDINATE_LIMIT) {
    invalid("Shard merge requires 1 through 10000 explicit bundle inputs.");
  }
  const roots = new Set(headers.map(({ root }) => root));
  if (roots.size !== headers.length) invalid("Shard merge inputs must identify distinct bundle directories.");
  const manifests = headers.map(({ manifest }) => manifest).sort((left, right) => left.shardIndex - right.shardIndex);
  const first = manifests[0]!;
  if (headers.length !== first.shardCount) invalid("Shard merge input count does not match the planned shard count.");

  const sharedKeys = [
    "assignmentAlgorithm", "configDigest", "contractDigest", "createdAt", "environmentId",
    "evaluatedOn", "expiresAt", "nonce", "planDigest", "reportSchemaVersion", "runSetId",
    "schemaVersion", "shardCount", "targetDigest", "toolVersion",
  ] as const;
  for (const [index, manifest] of manifests.entries()) {
    if (manifest.shardIndex !== index + 1) invalid("Shard merge inputs must contain every shard number exactly once.");
    if (sharedKeys.some((key) => manifest[key] !== first[key])) {
      invalid("Shard merge inputs disagree on their run-set identity or version bindings.");
    }
  }

  const allAssigned = manifests.flatMap(({ assignedCoordinateIds }) => assignedCoordinateIds);
  if (new Set(allAssigned).size !== allAssigned.length) invalid("Shard merge inputs contain overlapping coordinate assignments.");
  if (allAssigned.length > SHARD_COORDINATE_LIMIT) invalid("Shard merge coordinate inventory exceeds 10000 entries.");
  const plan = reconstructPlan(manifests);
  for (const manifest of manifests) {
    if (!sameStrings(manifest.assignedCoordinateIds, assignedShardCoordinateIds(plan, manifest.shardIndex))) {
      invalid("Shard bundle assignments do not match the reconstructed coordinator plan.");
    }
  }

  const currentIds = options.cells.map(cellCoordinateId).sort();
  if (new Set(currentIds).size !== currentIds.length || !sameStrings(currentIds, plan.coordinateIds)) {
    invalid("Shard bundle plan no longer matches the complete current config inventory.");
  }
  const reportSchemaVersion = options.evidence?.retention === "failures-only" || options.evidence?.retention === "none"
    ? PRIVACY_REPORT_SCHEMA_VERSION
    : REPORT_SCHEMA_VERSION;
  const expectedRetention = options.evidence?.retention ?? "all";
  const configuredMasks = new Map((options.evidence?.masks ?? []).map((mask) => [mask.id, mask]));
  if (
    plan.configDigest !== options.configDigest ||
    plan.contractDigest !== options.contractDigest ||
    plan.reportSchemaVersion !== reportSchemaVersion ||
    plan.toolVersion !== options.toolVersion ||
    plan.targetDigest !== shardTargetDigest(options.baseURL, plan.environmentId)
  ) {
    invalid("Shard bundle set no longer matches the current config, contract, target, report, or tool identity.");
  }
  for (const manifest of manifests) {
    if (manifest.evidence.retention !== expectedRetention) {
      invalid("Shard bundle evidence retention no longer matches the current config.");
    }
    for (const mask of manifest.evidence.masks) {
      const configured = configuredMasks.get(mask.id);
      if (
        configured === undefined ||
        (configured.count !== undefined && mask.cardinalities.some((count) => count !== configured.count))
      ) {
        invalid("Shard bundle mask evidence no longer matches the current config.");
      }
    }
  }
  assertMergePlanActive(plan, options.now);

  const evidencePaths = manifests.flatMap(({ files }) => files
    .filter(({ role }) => role === "evidence")
    .map(({ path }) => path));
  if (new Set(evidencePaths).size !== evidencePaths.length) {
    invalid("Shard bundle evidence paths collide across inputs.");
  }
  return plan;
}

async function listedBundleFiles(
  root: string,
  allowedDirectories: ReadonlySet<string>,
): Promise<readonly string[]> {
  const files: string[] = [];
  async function visit(directory: string, prefix: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const local = prefix.length === 0 ? entry.name : `${prefix}/${entry.name}`;
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) invalid("Shard bundle contents cannot contain symbolic links.");
      if (metadata.isDirectory()) {
        if (!allowedDirectories.has(local)) invalid("Shard bundle contains an unexpected directory.");
        await visit(path, local);
      } else if (metadata.isFile() && metadata.nlink === 1) {
        files.push(local);
      } else {
        invalid("Shard bundle contents must be regular, non-linked files or real directories.");
      }
    }
  }
  await visit(root, "");
  return files.sort();
}

async function verifyBundleFiles(header: BundleHeader): Promise<CheckedBundle> {
  const expectedFiles = ["manifest.json", ...header.manifest.files.map(({ path }) => path)].sort();
  const allowedDirectories = new Set(header.manifest.files.flatMap(({ path }) => {
    const segments = path.split("/").slice(0, -1);
    return segments.map((_segment, index) => segments.slice(0, index + 1).join("/"));
  }));
  if (!sameStrings(await listedBundleFiles(header.root, allowedDirectories), expectedFiles)) {
    invalid("Shard bundle contents do not exactly match the committed manifest.");
  }
  const bytes = new Map<string, Uint8Array>();
  for (const descriptor of header.manifest.files) {
    const path = join(header.root, ...descriptor.path.split("/"));
    const metadata = await lstat(path);
    if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.nlink !== 1 || metadata.size !== descriptor.bytes) {
      invalid("Shard bundle file metadata does not match its manifest.");
    }
    const contents = await readFile(path);
    if (digest(contents) !== descriptor.digest) invalid("Shard bundle file checksum does not match its manifest.");
    bytes.set(descriptor.path, contents);
  }
  return Object.freeze({ ...header, bytes });
}

function parseCheckedBundle(bundle: CheckedBundle): VerifiedBundle {
  const { bytes, ...header } = bundle;
  const reportBytes = bytes.get("report.json");
  if (reportBytes === undefined) invalid("Shard bundle report is missing after checksum verification.");
  let report: AnyUIWitnessReport;
  try {
    report = parseAnyReport(JSON.parse(Buffer.from(reportBytes).toString("utf8")));
  } catch (error: unknown) {
    return invalid("Shard bundle report is invalid.", { cause: error });
  }
  if (serializeReport(report) !== Buffer.from(reportBytes).toString("utf8")) {
    invalid("Shard bundle report must use the exact deterministic serialization.");
  }
  return Object.freeze({ ...header, bytes, report });
}

function sanitizedRoutePath(path: string): string {
  const url = new URL(path, "https://uiwitness.invalid");
  url.hash = "";
  if (url.search.length > 0) {
    const redacted = new URLSearchParams();
    for (const [key] of url.searchParams) redacted.append(key, "[REDACTED]");
    url.search = redacted.toString();
  }
  return `${url.pathname}${url.search}`;
}

function sanitizedHttpUrl(value: string): string {
  const url = new URL(value);
  url.username = "";
  url.password = "";
  url.hash = "";
  if (url.search.length > 0) {
    const redacted = new URLSearchParams();
    for (const [key] of url.searchParams) redacted.append(key, "[REDACTED]");
    url.search = redacted.toString();
  }
  return url.href;
}

function assertExecutionMatchesCell(execution: AnyReportExecutionResult, cell: MatrixCell): void {
  if (
    execution.routePath !== sanitizedRoutePath(cell.route.path) ||
    execution.scenarioSource !== cell.state.setup ||
    execution.viewport.height !== cell.viewport.height ||
    execution.viewport.width !== cell.viewport.width
  ) {
    invalid("Shard execution metadata no longer matches its current configured coordinate.");
  }
}

function screenshotState(execution: AnyReportExecutionResult): {
  readonly path: string | null;
  readonly status: "capture-failed" | "captured" | "omitted-by-policy";
} {
  if ("screenshot" in execution) {
    return execution.screenshot.status === "captured"
      ? { path: execution.screenshot.path, status: "captured" }
      : { path: null, status: execution.screenshot.status };
  }
  return execution.screenshotPath === null
    ? { path: null, status: "capture-failed" }
    : { path: execution.screenshotPath, status: "captured" };
}

function artifactsForBundle(
  bundle: VerifiedBundle,
  cells: ReadonlyMap<string, MatrixCell>,
): readonly ExecutionArtifact[] {
  const manifest = bundle.manifest;
  if (
    bundle.report.schemaVersion !== manifest.reportSchemaVersion ||
    bundle.report.generatedAt !== manifest.createdAt
  ) {
    invalid("Shard report header does not match its bundle manifest.");
  }
  const executionIds = bundle.report.executions.map(coordinateId);
  if (
    new Set(executionIds).size !== executionIds.length ||
    !sameStrings([...executionIds].sort(), manifest.executedCoordinateIds)
  ) {
    invalid("Shard report executions do not exactly match the committed assignment set.");
  }
  const evidenceDescriptors = new Map(manifest.files
    .filter(({ role }) => role === "evidence")
    .map((descriptor) => [descriptor.path, descriptor]));
  const artifacts: ExecutionArtifact[] = [];
  for (const execution of bundle.report.executions) {
    const id = coordinateId(execution);
    const cell = cells.get(id);
    if (cell === undefined) invalid("Shard report contains an execution outside the current config inventory.");
    assertExecutionMatchesCell(execution, cell);
    const screenshot = screenshotState(execution);
    const expectedArtifactPath = screenshotArtifactPath(cell);
    if (screenshot.status === "captured" && screenshot.path !== expectedArtifactPath) {
      invalid("Shard report screenshot path does not match its exact coordinate.");
    }
    const bundleEvidencePath = `evidence/${expectedArtifactPath.slice(".uiwitness/".length)}`;
    const screenshotBytes = screenshot.status === "captured"
      ? bundle.bytes.get(bundleEvidencePath) ?? invalid("Shard report references missing retained evidence.")
      : null;
    if (screenshot.status !== "captured" && evidenceDescriptors.has(bundleEvidencePath)) {
      invalid("Shard bundle contains evidence for an execution that did not retain a screenshot.");
    }
    if (screenshot.status === "captured") evidenceDescriptors.delete(bundleEvidencePath);
    const internalScreenshotPath = screenshot.status === "capture-failed" ? null : expectedArtifactPath;
    artifacts.push(Object.freeze({
      result: parseExecutionResult({
        diagnostics: execution.diagnostics,
        durationMs: execution.durationMs,
        failures: execution.failures,
        routeId: execution.routeId,
        routePath: execution.routePath,
        scenarioSource: execution.scenarioSource,
        screenshotPath: internalScreenshotPath,
        stateId: execution.stateId,
        status: execution.status,
        theme: execution.theme,
        url: execution.url,
        viewport: execution.viewport,
        viewportId: execution.viewportId,
      }),
      screenshot: screenshotBytes,
      screenshotStatus: screenshot.status,
    }));
  }
  if (evidenceDescriptors.size !== 0) invalid("Shard bundle contains retained evidence not referenced by its report.");

  const capturedIndexes = artifacts.flatMap((artifact, index) => artifact.screenshot === null ? [] : [index]);
  const attemptedIndexes = new Set(capturedIndexes);
  for (let index = 0; attemptedIndexes.size < manifest.evidence.attempted && index < artifacts.length; index += 1) {
    attemptedIndexes.add(index);
  }
  const masks = manifest.evidence.masks.flatMap(({ cardinalities, id }) =>
    cardinalities.map((count) => Object.freeze({ count, id }))
  );
  return Object.freeze(artifacts.map((artifact, index) => Object.freeze({
    ...artifact,
    ...(index === 0 && masks.length > 0 ? { masks: Object.freeze(masks) } : {}),
    screenshotAttempted: attemptedIndexes.has(index),
  })));
}

function validateReportAgreement(
  bundles: readonly VerifiedBundle[],
  plan: UIWitnessShardPlan,
  baseURL: string,
  evidence: EvidenceConfig | undefined,
): void {
  const retention = evidence?.retention ?? "all";
  const expectedBaseURL = sanitizedHttpUrl(baseURL);
  for (const bundle of bundles) {
    if (
      bundle.report.schemaVersion !== plan.reportSchemaVersion ||
      bundle.report.generatedAt !== plan.createdAt ||
      bundle.report.project.baseURL !== expectedBaseURL ||
      bundle.manifest.evidence.retention !== retention ||
      (bundle.report.schemaVersion === PRIVACY_REPORT_SCHEMA_VERSION && bundle.report.evidence.retention !== retention)
    ) {
      invalid("Shard reports disagree with the planned report version, timestamp, or current base URL.");
    }
  }
}

/**
 * Validates a complete bundle set independent of arrival order, then performs the
 * only allowed final publication for sharded evidence.
 */
export async function mergeShardScenarioBundles(
  options: MergeShardScenarioBundlesOptions,
): Promise<MergedShardScenarioRun> {
  if (options.bundlePaths.length === 0 || options.bundlePaths.length > SHARD_COORDINATE_LIMIT) {
    invalid("Shard merge requires 1 through 10000 explicit bundle inputs.");
  }
  const project = await projectRoot(options.projectDirectory);
  const headers: BundleHeader[] = [];
  let manifestBytes = 0;
  let bundleBytes = 0;
  for (const input of options.bundlePaths) {
    const header = await headerFor(project, input);
    if (header.manifestBytes > maximumAggregateManifestBytes - manifestBytes) {
      invalid("Shard bundle manifests exceed the 16 MiB aggregate input limit.");
    }
    manifestBytes += header.manifestBytes;
    for (const file of header.manifest.files) {
      if (file.bytes > maximumAggregateBundleBytes - bundleBytes) {
        invalid("Shard bundle contents exceed the 256 MiB aggregate input limit.");
      }
      bundleBytes += file.bytes;
    }
    headers.push(header);
  }
  const plan = validateHeaders(headers, options);
  const orderedHeaders = [...headers].sort((left, right) => left.manifest.shardIndex - right.manifest.shardIndex);
  const checkedBundles: CheckedBundle[] = [];
  for (const header of orderedHeaders) checkedBundles.push(await verifyBundleFiles(header));
  const bundles = checkedBundles.map(parseCheckedBundle);
  validateReportAgreement(bundles, plan, options.baseURL, options.evidence);

  const cells = new Map(options.cells.map((cell) => [cellCoordinateId(cell), cell]));
  const artifactById = new Map<string, ExecutionArtifact>();
  for (const bundle of bundles) {
    const artifacts = artifactsForBundle(bundle, cells);
    for (const [index, execution] of bundle.report.executions.entries()) {
      const id = coordinateId(execution);
      if (artifactById.has(id)) invalid("Shard reports contain duplicate execution coordinates.");
      artifactById.set(id, artifacts[index]!);
    }
  }
  const orderedCells = [...options.cells];
  const artifacts = orderedCells.map((cell) =>
    artifactById.get(cellCoordinateId(cell)) ?? invalid("Shard merge is missing one planned execution.")
  );
  const report = reportForExecutionArtifacts(
    orderedCells,
    artifacts,
    options.baseURL,
    plan.createdAt,
    options.evidence,
  );

  const lock = await acquirePersistenceLock(project);
  let publicationError: unknown;
  let generation: Awaited<ReturnType<typeof persistReport>> | undefined;
  try {
    assertMergePlanActive(plan, options.now);
    const finalization = options.finalizeGeneration === undefined
      ? { toolVersion: options.toolVersion }
      : await options.finalizeGeneration(report, plan);
    generation = await persistReport(project, lock, report, artifacts, undefined, finalization);
  } catch (error: unknown) {
    publicationError = error;
  }
  let cleanupError: unknown;
  if (!lock.preserve) {
    try {
      await releasePersistenceLock(lock);
    } catch (error: unknown) {
      cleanupError = error;
    }
  }
  if (publicationError !== undefined && cleanupError !== undefined) {
    throw new AggregateError([publicationError, cleanupError], "Shard merge publication and lock cleanup both failed.");
  }
  if (publicationError !== undefined) throw publicationError;
  if (cleanupError !== undefined) throw cleanupError;
  if (generation === undefined) throw new Error("Shard merge completed without a committed generation.");

  return Object.freeze({
    generation,
    htmlReportPath: ".uiwitness/report/index.html" as const,
    manifests: Object.freeze(bundles.map(({ manifest }) => manifest)),
    plan,
    report,
    reportPath: ".uiwitness/report/uiwitness.json" as const,
  });
}
