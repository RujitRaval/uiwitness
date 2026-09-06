import { createHash, randomUUID } from "node:crypto";
import {
  constants as fsConstants,
  chmod,
  link,
  lstat,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  realpath,
  rename,
  rm,
  stat,
} from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

import {
  COMMITTED_GENERATION_SCHEMA_VERSION,
  EVIDENCE_MANIFEST_PATH,
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  PRIVACY_GENERATION_MANIFEST_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  PRIVACY_REPORT_SCHEMA_VERSION,
  calculateCoverage,
  canonicalizeJson,
  contractProposalDigest,
  contractProposalSourceDigest,
  createContractProposal,
  generationManifestDigest,
  parseCommittedGeneration,
  parseContractProposal,
  parseContractProposalMetadata,
  parseContractProposalSource,
  parseExecutionResult,
  parseAnyGenerationManifest,
  parsePrivacyGenerationManifest,
  parseAnyReport,
  parseReport,
  screenshotArtifactPath,
  serializeCommittedGeneration,
  serializeContractProposal,
  serializeContractProposalMetadata,
  serializeContractProposalSource,
  serializePrivacyGenerationManifest,
  serializeEvidenceManifest,
  serializeReport,
  type PrivacyGenerationArtifactDescriptor,
  type GenerationArtifactRole,
  type PrivacyGenerationArtifactRole,
  type ExecutionDiagnostics,
  type ExecutionFailure,
  type ExecutionResult,
  type MatrixCell,
  type JsonValue,
  type AnyUIWitnessReport,
  type EvidenceConfig,
  type UIWitnessEvidenceManifest,
  type UIWitnessReport,
  type UIWitnessCommittedGeneration,
  type Sha256Digest,
} from "uiwitness-core";
import {
  REPORT_HTML_PATH,
  renderReportHtml,
  type ContractVerdictReportInput,
} from "uiwitness-report";

import {
  diagnosticErrorMessage,
  runCapturedScenarioCells,
  ScenarioCaptureError,
  type CompletedScenarioCell,
  type PrivacyRunCapturedScenarioCellsOptions,
  type RunCapturedScenarioCellsOptions,
  type ScenarioCaptureEvidence,
} from "./capture.js";
import type { CellExecutionOutcome } from "./lifecycle.js";
import { DocumentNavigationError } from "./readiness.js";

const evidenceDirectoryName = ".uiwitness";
const artifactsDirectoryName = "artifacts";
const reportDirectoryName = "report";
const reportFileName = "uiwitness.json";
const reportHtmlFileName = "index.html";
const reportProjectPath = ".uiwitness/report/uiwitness.json" as const;
const generationPointerProjectPath = ".uiwitness/generation.json" as const;
const lockDirectoryName = ".runner-persistence-lock";
const lockOwnerFileName = "owner.json";
const publishingMarkerFileName = "publishing";
const committedMarkerFileName = "committed";
const recoveryMarkerFileName = "recovery";
const lockCandidatePrefix = ".runner-lock-candidate-";
const stagingDirectoryPrefix = ".runner-persistence-stage-";
const publicationJournalFileName = "publication-journal.json";
const privateDirectoryMode = 0o700;
const privateFileMode = 0o600;

/** Filesystem and capture settings for one complete programmatic runner pass. */
export interface RunPersistedScenarioCellsOptions
  extends RunCapturedScenarioCellsOptions {
  readonly evidence?: (EvidenceConfig & { readonly retention?: "all" }) | undefined;
  /** Optional deterministic report timestamp. Defaults to the completion time. */
  readonly generatedAt?: Date | undefined;
  /** Existing project directory that owns the generated `.uiwitness/` tree. */
  readonly projectDirectory?: string | undefined;
  /** Adds validated browser-neutral outputs before the runner commits a generation. */
  readonly finalizeGeneration?: GenerationFinalizer | undefined;
}

export interface PrivacyRunPersistedScenarioCellsOptions
  extends Omit<RunPersistedScenarioCellsOptions, "evidence" | "finalizeGeneration"> {
  readonly evidence: EvidenceConfig & {
    readonly retention: "failures-only" | "none";
  };
  readonly finalizeGeneration?: PrivacyGenerationFinalizer | undefined;
}

type AnyRunPersistedScenarioCellsOptions = Omit<
  RunPersistedScenarioCellsOptions,
  "evidence" | "finalizeGeneration"
> & {
  readonly evidence?: EvidenceConfig | undefined;
  readonly finalizeGeneration?: GenerationFinalizer | PrivacyGenerationFinalizer | undefined;
};

/** The validated report and its stable project-relative JSON and HTML locations. */
export interface PersistedScenarioRun {
  readonly generation: UIWitnessCommittedGeneration;
  readonly htmlReportPath: typeof REPORT_HTML_PATH;
  readonly report: UIWitnessReport;
  readonly reportPath: typeof reportProjectPath;
}

export interface PrivacyPersistedScenarioRun
  extends Omit<PersistedScenarioRun, "report"> {
  readonly report: Extract<AnyUIWitnessReport, { readonly schemaVersion: 2 }>;
}

export type AnyPersistedScenarioRun =
  | PersistedScenarioRun
  | PrivacyPersistedScenarioRun;

export type GenerationArtifactPublication = "exclusive" | "immutable" | "replace";

export interface GenerationSidecarArtifact {
  readonly contents: string | Uint8Array;
  readonly mutable?: boolean | undefined;
  readonly path: string;
  readonly publication: GenerationArtifactPublication;
  readonly role: Exclude<
    GenerationArtifactRole,
    "evidence" | "evidence-manifest" | "report-html" | "report-json"
  >;
}

export interface GenerationFinalization {
  readonly artifacts?: readonly GenerationSidecarArtifact[] | undefined;
  readonly runDigest?: Sha256Digest | undefined;
  readonly sourceGenerationDigests?: readonly Sha256Digest[] | undefined;
  readonly toolVersion: string;
}

export type GenerationFinalizer = (
  report: UIWitnessReport,
) => GenerationFinalization | Promise<GenerationFinalization>;

/** Finalizes a privacy-report generation after retention changes the report schema. */
export type PrivacyGenerationFinalizer = (
  report: Extract<AnyUIWitnessReport, { readonly schemaVersion: 2 }>,
) => GenerationFinalization | Promise<GenerationFinalization>;

interface ExecutionArtifact {
  readonly masks?: ScenarioCaptureEvidence["masks"];
  readonly result: ExecutionResult;
  readonly screenshot: Uint8Array | null;
  readonly screenshotAttempted?: boolean;
  readonly screenshotStatus?: ScenarioCaptureEvidence["screenshotStatus"];
}

interface PublicationOperations {
  readonly link?: typeof link;
  readonly remove: typeof rm;
  readonly rename: typeof rename;
  readonly syncDirectory?: ((path: string) => Promise<void>) | undefined;
  readonly writeFile?: ((destination: string, contents: string | Uint8Array) => Promise<void>) | undefined;
}

interface AdditionalPublication {
  readonly commitPoint: boolean;
  readonly existing: string;
  readonly kind: "file";
  readonly previous: string;
  movedPrevious: boolean;
  published: boolean;
}

interface PublicationPaths {
  readonly existingArtifacts: string;
  readonly existingHtml: string;
  readonly existingReport: string;
  readonly previousArtifacts: string;
  readonly previousHtml: string;
  readonly previousReport: string;
}

interface PublicationState {
  readonly movedPreviousArtifacts: boolean;
  readonly movedPreviousHtml: boolean;
  readonly movedPreviousReport: boolean;
  readonly publishedArtifacts: boolean;
  readonly publishedHtml: boolean;
  readonly publishedReport: boolean;
}

interface PersistenceLock {
  readonly directory: string;
  preserve: boolean;
  readonly reportDirectory: string;
  readonly evidenceRoot: string;
  readonly token: string;
}

type PersistenceLockPhase = "capture" | "publishing" | "committed" | "recovery";

interface PersistenceLockOwner {
  readonly pid: number;
  readonly schemaVersion: 1;
  readonly token: string;
}

interface PersistenceLockState {
  readonly owner: PersistenceLockOwner | null;
  readonly phase: PersistenceLockPhase;
}

interface PublicationJournal {
  readonly additional: readonly {
    readonly index: number;
    readonly path: string;
  }[];
  readonly markerDigest: Sha256Digest;
  readonly schemaVersion: 1;
}

const publicationOperations: PublicationOperations = Object.freeze({
  link,
  remove: rm,
  rename,
});

const emptyDiagnostics: ExecutionDiagnostics = Object.freeze({
  consoleErrors: Object.freeze([]),
  failedRequests: Object.freeze([]),
  navigationStatus: null,
  pageErrors: Object.freeze([]),
});

function requestedUrl(cell: MatrixCell, baseURL: string): string {
  return new URL(cell.route.path, baseURL).href;
}

function resultInput(
  cell: MatrixCell,
  baseURL: string,
  status: "failed" | "passed",
  evidence: ScenarioCaptureEvidence | CompletedScenarioCell | null,
  failures: readonly ExecutionFailure[],
): ExecutionResult {
  const screenshotPath =
    evidence === null ||
      (evidence.screenshot === null && evidence.screenshotStatus !== "omitted-by-policy")
      ? null
      : screenshotArtifactPath(cell);
  return parseExecutionResult({
    diagnostics: evidence?.diagnostics ?? emptyDiagnostics,
    durationMs: evidence?.durationMs ?? 0,
    failures,
    routeId: cell.route.id,
    routePath: cell.route.path,
    scenarioSource: cell.state.setup,
    screenshotPath,
    stateId: cell.state.id,
    status,
    theme: cell.theme,
    url: evidence?.navigation?.url ?? requestedUrl(cell, baseURL),
    viewport: cell.viewport,
    viewportId: cell.viewportId,
  });
}

/** @internal Translates one settled capture into its core result and PNG bytes. */
export function executionArtifactForOutcome(
  outcome: CellExecutionOutcome<CompletedScenarioCell>,
  baseURL: string,
  evidence?: EvidenceConfig | undefined,
): ExecutionArtifact {
  const fallbackScreenshotStatus = evidence?.retention === "none"
    ? "omitted-by-policy"
    : "capture-failed";
  if (outcome.status === "fulfilled") {
    return Object.freeze({
      masks: outcome.value.masks,
      result: resultInput(outcome.cell, baseURL, "passed", outcome.value, []),
      screenshot: outcome.value.screenshot,
      screenshotAttempted: outcome.value.screenshotAttempted,
      screenshotStatus: outcome.value.screenshotStatus,
    });
  }

  if (outcome.reason instanceof ScenarioCaptureError) {
    return Object.freeze({
      masks: outcome.reason.evidence.masks,
      result: resultInput(
        outcome.cell,
        baseURL,
        "failed",
        outcome.reason.evidence,
        outcome.reason.failures,
      ),
      screenshot: outcome.reason.evidence.screenshot,
      screenshotAttempted: outcome.reason.evidence.screenshotAttempted,
      screenshotStatus: outcome.reason.evidence.screenshotStatus,
    });
  }

  if (outcome.reason instanceof DocumentNavigationError) {
    return Object.freeze({
      masks: Object.freeze([]),
      result: resultInput(outcome.cell, baseURL, "failed", null, [
        Object.freeze({
          code: "NAVIGATION_FAILED",
          message: diagnosticErrorMessage(outcome.reason),
        }),
      ]),
      screenshot: null,
      screenshotAttempted: false,
      screenshotStatus: fallbackScreenshotStatus,
    });
  }

  return Object.freeze({
    masks: Object.freeze([]),
    result: resultInput(outcome.cell, baseURL, "failed", null, [
      Object.freeze({
        code: "INTERNAL_ERROR",
        message: diagnosticErrorMessage(outcome.reason),
      }),
    ]),
    screenshot: null,
    screenshotAttempted: false,
    screenshotStatus: fallbackScreenshotStatus,
  });
}

function reportFor(
  cells: readonly MatrixCell[],
  artifacts: readonly ExecutionArtifact[],
  baseURL: string,
  generatedAt: string,
  evidence: EvidenceConfig | undefined,
): AnyUIWitnessReport {
  const executions = artifacts.map(({ result }) => result);
  const passed = executions.filter(({ status }) => status === "passed").length;
  const summary = {
    coverage: calculateCoverage(
      cells,
      executions.map((execution) => ({
        passed: execution.status === "passed",
        routeId: execution.routeId,
        stateId: execution.stateId,
        theme: execution.theme,
        viewportId: execution.viewportId,
      })),
    ),
    durationMs: executions.reduce(
      (total, execution) => total + execution.durationMs,
      0,
    ),
    executions: executions.length,
    failed: executions.length - passed,
    passed,
    routes: new Set(executions.map(({ routeId }) => routeId)).size,
    states: new Set(
      executions.map(({ routeId, stateId }) =>
        JSON.stringify([routeId, stateId]),
      ),
    ).size,
  };
  const retention = evidence?.retention ?? "all";
  if (retention === "all") {
    return parseReport({
      executions,
      generatedAt,
      project: { baseURL },
      schemaVersion: REPORT_SCHEMA_VERSION,
      summary,
    });
  }
  return parseAnyReport({
    evidence: { retention },
    executions: artifacts.map(({ result, screenshot, screenshotStatus }) => {
      const { screenshotPath, ...common } = result;
      const resolvedStatus = screenshotStatus ??
        (screenshot === null ? "capture-failed" : "captured");
      return {
        ...common,
        screenshot: resolvedStatus === "captured" && screenshotPath !== null
          ? { path: screenshotPath, status: "captured" as const }
          : { status: resolvedStatus as "capture-failed" | "omitted-by-policy" },
      };
    }),
    generatedAt,
    project: { baseURL },
    schemaVersion: PRIVACY_REPORT_SCHEMA_VERSION,
    summary,
  });
}

function reportTimestamp(value: Date | undefined): string | undefined {
  if (value === undefined) {
    return undefined;
  }
  return new Date(value.getTime()).toISOString();
}

function validatePersistenceBoundary(
  cells: readonly MatrixCell[],
  baseURL: string,
  generatedAt: string | undefined,
  evidence: EvidenceConfig | undefined,
): void {
  const artifacts = cells.map((cell) =>
    Object.freeze({
      result: parseExecutionResult({
      diagnostics: emptyDiagnostics,
      durationMs: 0,
      failures: [],
      routeId: cell.route.id,
      routePath: cell.route.path,
      scenarioSource: cell.state.setup,
      screenshotPath: screenshotArtifactPath(cell),
      stateId: cell.state.id,
      status: "passed",
      theme: cell.theme,
      url: requestedUrl(cell, baseURL),
      viewport: cell.viewport,
      viewportId: cell.viewportId,
      }),
      screenshot: null,
      masks: Object.freeze([]),
      screenshotAttempted: evidence?.retention !== "none",
      screenshotStatus: evidence?.retention === undefined || evidence.retention === "all"
        ? "captured"
        : "omitted-by-policy",
    }),
  );
  reportFor(
    cells,
    artifacts,
    baseURL,
    generatedAt ?? "1970-01-01T00:00:00.000Z",
    evidence,
  );
}

async function projectRoot(directory: string | undefined): Promise<string> {
  const candidate = resolve(directory ?? process.cwd());
  const metadata = await stat(candidate);
  if (!metadata.isDirectory()) {
    throw new TypeError("projectDirectory must refer to an existing directory.");
  }
  return realpath(candidate);
}

async function ensurePrivateDirectory(
  parent: string,
  segment: string,
): Promise<string> {
  const directory = join(parent, segment);
  await mkdir(directory, { mode: privateDirectoryMode }).catch(
    (error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") {
        throw error;
      }
    },
  );
  const metadata = await lstat(directory);
  if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
    throw new TypeError(
      `${relative(parent, directory) || segment} must be a real directory, not a symbolic link.`,
    );
  }
  if (process.platform !== "win32") {
    await chmod(directory, privateDirectoryMode);
  }
  return directory;
}

async function ensurePrivateTree(
  root: string,
  segments: readonly string[],
): Promise<string> {
  let directory = root;
  for (const segment of segments) {
    directory = await ensurePrivateDirectory(directory, segment);
  }
  return directory;
}

function canonicalRelativeSegments(projectPath: string): readonly string[] {
  if (
    projectPath.length > 1_024 ||
    isAbsolute(projectPath) ||
    projectPath.includes("\\") ||
    projectPath.includes("\0")
  ) {
    throw new TypeError("Artifact paths must be canonical project-relative POSIX paths.");
  }
  const segments = projectPath.split("/");
  if (
    segments.some((segment) =>
      segment.length === 0 || segment === "." || segment === ".."
    )
  ) {
    throw new TypeError("Artifact paths must not contain empty, current, or parent segments.");
  }
  return segments;
}

function safeRelativeSegments(projectPath: string): readonly string[] {
  const segments = canonicalRelativeSegments(projectPath);
  if (segments[0] !== evidenceDirectoryName) {
    throw new TypeError("Artifact paths must stay inside .uiwitness/.");
  }
  return segments;
}

function isReservedControlPath(projectPath: string): boolean {
  const [top, control] = projectPath.split("/");
  return top === evidenceDirectoryName && (
    control === "contract.lock" ||
    control?.startsWith(".runner-") === true
  );
}

function isGenerationManifestPath(projectPath: string): boolean {
  return /^\.uiwitness\/generations\/[a-f0-9]{64}\.manifest\.json$/u.test(
    projectPath,
  );
}

function assertSafeJournalPath(projectPath: string): void {
  if (
    projectPath === generationPointerProjectPath ||
    projectPath === EVIDENCE_MANIFEST_PATH ||
    isGenerationManifestPath(projectPath)
  ) {
    return;
  }
  if (
    projectPath.startsWith(`${generationPointerProjectPath}/`) ||
    projectPath === `${evidenceDirectoryName}/${artifactsDirectoryName}` ||
    projectPath.startsWith(`${evidenceDirectoryName}/${artifactsDirectoryName}/`) ||
    projectPath === `${evidenceDirectoryName}/${reportDirectoryName}` ||
    projectPath.startsWith(`${evidenceDirectoryName}/${reportDirectoryName}/`) ||
    projectPath === `${evidenceDirectoryName}/generations` ||
    projectPath.startsWith(`${evidenceDirectoryName}/generations/`) ||
    isReservedControlPath(projectPath)
  ) {
    throw new Error("Abandoned publication journal targets a reserved path.");
  }
}

function assertContained(root: string, destination: string): void {
  const relativePath = relative(root, destination);
  if (
    relativePath.length === 0 ||
    relativePath === ".." ||
    relativePath.startsWith(`..${sep}`) ||
    isAbsolute(relativePath)
  ) {
    throw new TypeError("Persistence destinations must stay inside .uiwitness/.");
  }
}

async function writePrivateFile(
  destination: string,
  contents: string | Uint8Array,
): Promise<void> {
  const handle = await open(
    destination,
    fsConstants.O_CREAT |
      fsConstants.O_EXCL |
      fsConstants.O_WRONLY |
      fsConstants.O_NOFOLLOW,
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

function artifactDigest(contents: string | Uint8Array): Sha256Digest {
  const digest = createHash("sha256").update(contents).digest("hex");
  return `sha256:${digest}`;
}

function evidenceManifestFor(
  report: AnyUIWitnessReport,
  reportContents: string,
  artifacts: readonly ExecutionArtifact[],
  finalization: GenerationFinalization,
): UIWitnessEvidenceManifest {
  const cardinalities = new Map<string, number[]>();
  for (const artifact of artifacts) {
    for (const mask of artifact.masks ?? []) {
      const values = cardinalities.get(mask.id) ?? [];
      values.push(mask.count);
      cardinalities.set(mask.id, values);
    }
  }
  const reportDigest = artifactDigest(reportContents);
  const verdict = finalization.artifacts?.find(
    ({ role }) => role === "contract-verdict",
  );
  return Object.freeze({
    attempted: artifacts.filter((artifact) =>
      artifact.screenshotAttempted ?? artifact.screenshot !== null
    ).length,
    captured: artifacts.filter(({ screenshot }) => screenshot !== null).length,
    generationDigest: finalization.runDigest ?? reportDigest,
    masks: Object.freeze([...cardinalities]
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([id, values]) => Object.freeze({
        cardinalities: Object.freeze([...values].sort((left, right) => left - right)),
        id,
      }))),
    omitted: artifacts.filter(({ screenshot }) => screenshot === null).length,
    reportDigest,
    retention: report.schemaVersion === REPORT_SCHEMA_VERSION
      ? "all"
      : report.evidence?.retention ?? "all",
    schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
    verdictDigest: verdict === undefined ? null : artifactDigest(verdict.contents),
  });
}

function posixProjectPath(root: string, destination: string): string {
  const local = relative(root, destination);
  if (
    local.length === 0 || local === ".." || local.startsWith(`..${sep}`) ||
    isAbsolute(local)
  ) {
    throw new TypeError("Generation artifacts must stay beneath the project directory.");
  }
  return local.split(sep).join("/");
}

async function ensureSafeParent(
  root: string,
  destination: string,
  sync: (path: string) => Promise<void> = syncDirectory,
): Promise<void> {
  const local = posixProjectPath(root, destination);
  const segments = local.split("/").slice(0, -1);
  let current = root;
  for (const segment of segments) {
    current = join(current, segment);
    try {
      const metadata = await lstat(current);
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        throw new TypeError("Generation artifact parents must be real directories.");
      }
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      await mkdir(current, { mode: privateDirectoryMode });
      if (process.platform !== "win32") await chmod(current, privateDirectoryMode);
      await sync(current);
      await sync(resolve(current, ".."));
    }
  }
}

async function syncDirectoryTree(
  root: string,
  sync: (path: string) => Promise<void>,
): Promise<void> {
  for (const entry of await readdir(root)) {
    const path = join(root, entry);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      throw new TypeError("Staged generation members cannot be symbolic links.");
    }
    if (metadata.isDirectory()) await syncDirectoryTree(path, sync);
  }
  await sync(root);
}

function artifactDescriptor(
  path: string,
  role: PrivacyGenerationArtifactRole,
  contents: string | Uint8Array,
  mutable = false,
): PrivacyGenerationArtifactDescriptor {
  return Object.freeze({
    bytes: typeof contents === "string" ? Buffer.byteLength(contents) : contents.byteLength,
    digest: artifactDigest(contents),
    mutable,
    path,
    role,
  });
}

function sidecarText(artifact: GenerationSidecarArtifact): string {
  if (typeof artifact.contents === "string") return artifact.contents;
  const bytes = Buffer.from(artifact.contents);
  const value = bytes.toString("utf8");
  if (!Buffer.from(value, "utf8").equals(bytes)) {
    throw new TypeError(`Generation artifact must contain valid UTF-8: ${artifact.path}`);
  }
  return value;
}

function validateCanonicalJsonSidecar(artifact: GenerationSidecarArtifact): string {
  const source = sidecarText(artifact);
  let parsed: unknown;
  try {
    parsed = JSON.parse(source);
  } catch {
    throw new TypeError(`Generation artifact must contain valid JSON: ${artifact.path}`);
  }
  if (`${canonicalizeJson(parsed as JsonValue)}\n` !== source) {
    throw new TypeError(`Generation artifact must contain canonical JSON: ${artifact.path}`);
  }
  return source;
}

function validateGenerationSidecars(finalization: GenerationFinalization): void {
  const artifacts = finalization.artifacts ?? [];
  const runnerOwnedRoles = new Set<PrivacyGenerationArtifactRole>([
    "evidence",
    "evidence-manifest",
    "report-html",
    "report-json",
  ]);
  if (artifacts.some(({ role }) => runnerOwnedRoles.has(role))) {
    throw new TypeError("Generation sidecars cannot use runner-owned artifact roles.");
  }
  const verdicts = artifacts.filter(({ role }) => role === "contract-verdict");
  const copies = artifacts.filter(({ role }) => role === "json-copy");
  if (verdicts.length > 1 || copies.length > 1) {
    throw new TypeError("A generation can contain only one verdict and one JSON copy.");
  }
  const verdict = verdicts[0];
  const copy = copies[0];
  const verdictText = verdict === undefined
    ? undefined
    : validateCanonicalJsonSidecar(verdict);
  if (
    copy !== undefined &&
    (verdictText === undefined || validateCanonicalJsonSidecar(copy) !== verdictText)
  ) {
    throw new TypeError("An explicit JSON copy must exactly match the generation verdict.");
  }
  const familyRoles = new Set<GenerationArtifactRole>([
    "contract-metadata",
    "contract-proposal",
    "contract-source",
  ]);
  const family = artifacts.filter(({ role }) => familyRoles.has(role));
  if (family.length === 0) return;
  const member = (role: GenerationArtifactRole): GenerationSidecarArtifact => {
    const selected = family.filter((artifact) => artifact.role === role);
    if (selected.length !== 1) {
      throw new TypeError(`A contract proposal generation requires one ${role} artifact.`);
    }
    return selected[0]!;
  };
  const sourceArtifact = member("contract-source");
  const proposalArtifact = member("contract-proposal");
  const metadataArtifact = member("contract-metadata");
  const sourceText = sidecarText(sourceArtifact);
  const proposalText = sidecarText(proposalArtifact);
  const metadataText = sidecarText(metadataArtifact);
  const source = parseContractProposalSource(sourceText);
  const proposal = parseContractProposal(proposalText);
  const metadata = parseContractProposalMetadata(metadataText);
  const sourceDigest = contractProposalSourceDigest(source);
  const proposalDigest = contractProposalDigest(proposal);
  const sourceName = sourceDigest.slice("sha256:".length);
  const proposalName = proposalDigest.slice("sha256:".length);
  if (
    sourceArtifact.path !== `.uiwitness/contract-generations/${sourceName}.source.json` ||
    proposalArtifact.path !== `.uiwitness/contract-candidates/${proposalName}.proposal.json` ||
    metadataArtifact.path !== `.uiwitness/contract-candidates/${proposalName}.metadata.json` ||
    sourceArtifact.publication !== "immutable" ||
    proposalArtifact.publication !== "immutable" ||
    metadataArtifact.publication !== "immutable" ||
    sourceArtifact.mutable === true ||
    proposalArtifact.mutable === true ||
    metadataArtifact.mutable !== true ||
    proposal.changes.length === 0 ||
    proposal.sourceGenerationDigest !== sourceDigest ||
    proposal.toolVersion !== finalization.toolVersion ||
    metadata.proposalDigest !== proposalDigest ||
    !finalization.sourceGenerationDigests?.includes(sourceDigest) ||
    serializeContractProposalSource(source) !== sourceText ||
    serializeContractProposal(proposal) !== proposalText ||
    serializeContractProposalMetadata(metadata) !== metadataText ||
    serializeContractProposal(createContractProposal(source, proposal.toolVersion)) !== proposalText
  ) {
    throw new TypeError("Contract proposal generation artifacts are not mutually digest-bound.");
  }
}

function snapshotGenerationFinalization(
  finalization: GenerationFinalization,
): GenerationFinalization {
  const artifacts = Object.freeze((finalization.artifacts ?? []).map((artifact) =>
    Object.freeze({
      ...artifact,
      contents: typeof artifact.contents === "string"
        ? artifact.contents
        : Uint8Array.from(artifact.contents),
    })
  ));
  return Object.freeze({
    artifacts,
    ...(finalization.runDigest === undefined
      ? {}
      : { runDigest: finalization.runDigest }),
    ...(finalization.sourceGenerationDigests === undefined
      ? {}
      : {
          sourceGenerationDigests: Object.freeze([
            ...finalization.sourceGenerationDigests,
          ]),
        }),
    toolVersion: finalization.toolVersion,
  });
}

async function runnerVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new Error("Runner package version is unavailable.");
  }
  return manifest.version;
}

async function existingType(
  path: string,
): Promise<"directory" | "file" | "missing" | "unsafe"> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink()) {
      return "unsafe";
    }
    if (metadata.isDirectory()) {
      return "directory";
    }
    return metadata.isFile() && metadata.nlink === 1 ? "file" : "unsafe";
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "missing";
    }
    throw error;
  }
}

/** @internal Restores the previous output while keeping its report hidden last. */
export async function recoverPublication(
  paths: PublicationPaths,
  state: PublicationState,
  operations: PublicationOperations = publicationOperations,
  additional: readonly AdditionalPublication[] = [],
): Promise<readonly unknown[]> {
  const errors: unknown[] = [];
  const attempt = async (operation: () => Promise<void>): Promise<boolean> => {
    try {
      await operation();
      return true;
    } catch (error: unknown) {
      errors.push(error);
      return false;
    }
  };
  const mutate = (
    operation: () => Promise<void>,
    parents: string | readonly string[],
  ): Promise<boolean> => attempt(async () => {
    await operation();
    for (const parent of new Set(
      typeof parents === "string" ? [parents] : parents,
    )) {
      await (operations.syncDirectory ?? syncDirectory)(parent);
    }
  });

  const removeAdditional = async (
    members: readonly AdditionalPublication[],
  ): Promise<boolean> => {
    for (const member of [...members].reverse()) {
      if (!member.published) continue;
      const removed = await mutate(
        () => operations.remove(member.existing, { force: true }),
        resolve(member.existing, ".."),
      );
      if (!removed) return false;
    }
    return true;
  };
  if (!(await removeAdditional(additional.filter(({ commitPoint }) => commitPoint)))) {
    return Object.freeze(errors);
  }
  if (state.publishedHtml) {
    const htmlRemoved = await mutate(
      () => operations.remove(paths.existingHtml, { force: true }),
      resolve(paths.existingHtml, ".."),
    );
    if (!htmlRemoved) {
      return Object.freeze(errors);
    }
  }
  if (!(await removeAdditional(additional.filter(({ commitPoint }) => !commitPoint)))) {
    return Object.freeze(errors);
  }
  if (state.publishedReport) {
    const reportRemoved = await mutate(
      () => operations.remove(paths.existingReport, { force: true }),
      resolve(paths.existingReport, ".."),
    );
    if (!reportRemoved) {
      return Object.freeze(errors);
    }
  }
  if (state.publishedArtifacts) {
    const artifactsRemoved = await mutate(
      () => operations.remove(paths.existingArtifacts, {
        force: true,
        recursive: true,
      }),
      resolve(paths.existingArtifacts, ".."),
    );
    if (!artifactsRemoved) {
      return Object.freeze(errors);
    }
  }
  if (state.movedPreviousArtifacts) {
    const artifactsRestored = await mutate(
      () => operations.rename(paths.previousArtifacts, paths.existingArtifacts),
      [resolve(paths.existingArtifacts, ".."), resolve(paths.previousArtifacts, "..")],
    );
    if (!artifactsRestored) {
      return Object.freeze(errors);
    }
  }
  if (state.movedPreviousReport) {
    const reportRestored = await mutate(
      () => operations.rename(paths.previousReport, paths.existingReport),
      [resolve(paths.existingReport, ".."), resolve(paths.previousReport, "..")],
    );
    if (!reportRestored) {
      return Object.freeze(errors);
    }
  }
  for (const member of additional.filter(({ commitPoint }) => !commitPoint)) {
    if (member.movedPrevious) {
      const restored = await mutate(
        () => operations.rename(member.previous, member.existing),
        [resolve(member.existing, ".."), resolve(member.previous, "..")],
      );
      if (!restored) return Object.freeze(errors);
    }
  }
  if (state.movedPreviousHtml) {
    const htmlRestored = await mutate(
      () => operations.rename(paths.previousHtml, paths.existingHtml),
      [resolve(paths.existingHtml, ".."), resolve(paths.previousHtml, "..")],
    );
    if (!htmlRestored) return Object.freeze(errors);
  }
  for (const member of additional.filter(({ commitPoint }) => commitPoint)) {
    if (member.movedPrevious) {
      const restored = await mutate(
        () => operations.rename(member.previous, member.existing),
        [resolve(member.existing, ".."), resolve(member.previous, "..")],
      );
      if (!restored) return Object.freeze(errors);
    }
  }
  return Object.freeze(errors);
}

function lockOwner(lock: PersistenceLock): PersistenceLockOwner {
  return {
    pid: process.pid,
    schemaVersion: 1,
    token: lock.token,
  };
}

function serializeLockOwner(owner: PersistenceLockOwner): string {
  return `${JSON.stringify(owner)}\n`;
}

function serializePublicationJournal(journal: PublicationJournal): string {
  return `${JSON.stringify(journal)}\n`;
}

function parsePublicationJournal(value: string): PublicationJournal {
  let input: unknown;
  try {
    input = JSON.parse(value);
  } catch {
    throw new Error("Abandoned publication journal is invalid JSON.");
  }
  if (typeof input !== "object" || input === null) {
    throw new Error("Abandoned publication journal must be an object.");
  }
  const record = input as Record<string, unknown>;
  if (
    record["schemaVersion"] !== 1 ||
    !Array.isArray(record["additional"]) ||
    typeof record["markerDigest"] !== "string" ||
    !/^sha256:[a-f0-9]{64}$/u.test(record["markerDigest"]) ||
    Object.keys(record).sort().join(",") !== "additional,markerDigest,schemaVersion"
  ) {
    throw new Error("Abandoned publication journal has an unsupported shape.");
  }
  const seenPaths = new Set<string>();
  const seenIndexes = new Set<number>();
  const additional = record["additional"].map((value: unknown) => {
    if (typeof value !== "object" || value === null) {
      throw new Error("Abandoned publication journal members must be objects.");
    }
    const member = value as Record<string, unknown>;
    if (
      !Number.isSafeInteger(member["index"]) ||
      (member["index"] as number) < 0 ||
      typeof member["path"] !== "string" ||
      Object.keys(member).sort().join(",") !== "index,path"
    ) {
      throw new Error("Abandoned publication journal member is invalid.");
    }
    const index = member["index"] as number;
    const path = member["path"];
    canonicalRelativeSegments(path);
    assertSafeJournalPath(path);
    if (
      seenIndexes.has(index) ||
      seenPaths.has(path) ||
      [...seenPaths].some((seenPath) =>
        seenPath.startsWith(`${path}/`) || path.startsWith(`${seenPath}/`)
      )
    ) {
      throw new Error("Abandoned publication journal members must be unique.");
    }
    seenIndexes.add(index);
    seenPaths.add(path);
    return Object.freeze({ index, path });
  });
  return Object.freeze({
    additional: Object.freeze(additional),
    markerDigest: record["markerDigest"] as Sha256Digest,
    schemaVersion: 1,
  });
}

function parseLockOwner(value: string): PersistenceLockOwner | null {
  try {
    const input: unknown = JSON.parse(value);
    if (typeof input !== "object" || input === null) {
      return null;
    }
    const record = input as Record<string, unknown>;
    if (
      record["schemaVersion"] !== 1 ||
      typeof record["pid"] !== "number" ||
      !Number.isSafeInteger(record["pid"]) ||
      record["pid"] <= 0 ||
      typeof record["token"] !== "string" ||
      record["token"].length === 0
    ) {
      return null;
    }
    return record as unknown as PersistenceLockOwner;
  } catch {
    return null;
  }
}

async function markerExists(path: string): Promise<boolean> {
  try {
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isFile()) {
      throw new Error("Result-persistence lock markers must be regular files.");
    }
    return true;
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }
    throw error;
  }
}

async function readLockState(directory: string): Promise<PersistenceLockState> {
  const owner = await readLockOwner(directory);
  const recovery = await markerExists(join(directory, recoveryMarkerFileName));
  const committed = await markerExists(join(directory, committedMarkerFileName));
  const publishing = await markerExists(
    join(directory, publishingMarkerFileName),
  );
  return {
    owner,
    phase: recovery
      ? "recovery"
      : committed
        ? "committed"
        : publishing
          ? "publishing"
          : "capture",
  };
}

async function readLockOwner(directory: string): Promise<PersistenceLockOwner | null> {
  const path = join(directory, lockOwnerFileName);
  try {
    const handle = await open(
      path,
      fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW,
    );
    try {
      if ((await handle.stat()).size > 4_096) {
        return null;
      }
      return parseLockOwner(await handle.readFile("utf8"));
    } finally {
      await handle.close();
    }
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function processIsAlive(pid: number): boolean {
  if (pid === process.pid) {
    return true;
  }
  try {
    process.kill(pid, 0);
    return true;
  } catch (error: unknown) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

/** @internal Derives the stable stale-owner claim used by recovery tests. */
export function takeoverClaimPath(
  directory: string,
  ownerToken: string,
): string {
  const digest = createHash("sha256").update(ownerToken, "utf8").digest("hex");
  return `${directory}.claimed-${digest}`;
}

async function updateLockPhase(
  lock: PersistenceLock,
  phase: PersistenceLockPhase,
  operations: Pick<PublicationOperations, "syncDirectory" | "writeFile"> = {},
): Promise<void> {
  if (phase === "capture") {
    throw new TypeError("Persistence locks cannot return to the capture phase.");
  }
  const marker = join(
    lock.directory,
    phase === "publishing"
      ? publishingMarkerFileName
      : phase === "committed"
        ? committedMarkerFileName
        : recoveryMarkerFileName,
  );
  await (operations.writeFile ?? writePrivateFile)(marker, `${phase}\n`);
  await (operations.syncDirectory ?? syncDirectory)(lock.directory);
}

/** @internal Releases a lock only when its durable owner token still matches. */
export async function releasePersistenceLock(
  lock: PersistenceLock,
): Promise<void> {
  const { owner } = await readLockState(lock.directory);
  if (owner?.token !== lock.token) {
    throw new Error("Result-persistence lock ownership changed before cleanup.");
  }
  await rm(lock.directory, { force: true, recursive: true });
  await syncDirectory(lock.evidenceRoot);
}

/** Serializes a non-run mutation with committed generation publication. */
export async function withGenerationTransactionLock<T>(
  projectDirectory: string,
  action: () => Promise<T>,
): Promise<T> {
  const root = await projectRoot(projectDirectory);
  const lock = await acquirePersistenceLock(root);
  try {
    return await action();
  } finally {
    if (!lock.preserve) await releasePersistenceLock(lock);
  }
}

async function removeAbandonedStaging(evidenceRoot: string): Promise<void> {
  for (const entry of await readdir(evidenceRoot)) {
    if (!entry.startsWith(stagingDirectoryPrefix)) {
      continue;
    }
    const path = join(evidenceRoot, entry);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Abandoned persistence staging must be a real directory.");
    }
    await rm(path, { force: true, recursive: true });
  }
  await syncDirectory(evidenceRoot);
}

async function abandonedStagingDirectories(
  evidenceRoot: string,
): Promise<readonly string[]> {
  const directories: string[] = [];
  for (const entry of await readdir(evidenceRoot)) {
    if (!entry.startsWith(stagingDirectoryPrefix)) continue;
    const path = join(evidenceRoot, entry);
    const metadata = await lstat(path);
    if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
      throw new Error("Abandoned persistence staging must be a real directory.");
    }
    directories.push(path);
  }
  return Object.freeze(directories.sort());
}

async function journalFrom(stagingRoot: string): Promise<PublicationJournal> {
  const path = join(stagingRoot, publicationJournalFileName);
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    const metadata = await handle.stat();
    if (!metadata.isFile() || metadata.nlink !== 1 || metadata.size > 1_000_000) {
      throw new Error("Abandoned publication journal must be a bounded regular file.");
    }
    return parsePublicationJournal(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function publicationMemberState(
  existing: string,
  previous: string,
  staged: string,
  expected: "directory" | "file",
): Promise<{ readonly movedPrevious: boolean; readonly published: boolean }> {
  const [existingKind, previousKind, stagedKind] = await Promise.all([
    existingType(existing),
    existingType(previous),
    existingType(staged),
  ]);
  if (expected === "file" && existingKind === "unsafe" && stagedKind === "unsafe") {
    const [existingMetadata, stagedMetadata] = await Promise.all([
      lstat(existing),
      lstat(staged),
    ]);
    if (
      existingMetadata.isFile() && !existingMetadata.isSymbolicLink() &&
      stagedMetadata.isFile() && !stagedMetadata.isSymbolicLink() &&
      existingMetadata.dev === stagedMetadata.dev &&
      existingMetadata.ino === stagedMetadata.ino &&
      existingMetadata.nlink === 2 && stagedMetadata.nlink === 2 &&
      (previousKind === "missing" || previousKind === "file")
    ) {
      return Object.freeze({
        movedPrevious: previousKind === "file",
        published: true,
      });
    }
  }
  for (const [label, kind] of [
    ["existing", existingKind],
    ["previous", previousKind],
    ["staged", stagedKind],
  ] as const) {
    if (kind !== "missing" && kind !== expected) {
      throw new Error(`Abandoned publication ${label} member is unsafe.`);
    }
  }
  if (previousKind === expected && existingKind === "missing" && stagedKind === "missing") {
    throw new Error("Abandoned publication lost both its staged and published member.");
  }
  return Object.freeze({
    movedPrevious: previousKind === expected,
    published: stagedKind === "missing" && existingKind === expected,
  });
}

async function validatePublishedMarker(
  root: string,
  markerPath: string,
  expectedDigest: Sha256Digest,
): Promise<void> {
  const markerBytes = await readFile(markerPath);
  if (artifactDigest(markerBytes) !== expectedDigest) {
    throw new Error("Published generation marker does not match its recovery journal.");
  }
  const marker = parseCommittedGeneration(markerBytes.toString("utf8"));
  const manifestPath = resolve(root, ...canonicalRelativeSegments(marker.manifestPath));
  const manifestBytes = await readFile(manifestPath);
  const manifest = parseAnyGenerationManifest(manifestBytes.toString("utf8"));
  if (
    generationManifestDigest(manifest) !== marker.manifestDigest ||
    JSON.stringify(manifest.sourceGenerationDigests) !==
      JSON.stringify(marker.sourceGenerationDigests)
  ) {
    throw new Error("Published generation manifest does not match its committed marker.");
  }
}

async function recoverAbandonedPublication(
  root: string,
  evidenceRoot: string,
  reportDirectory: string,
): Promise<void> {
  const stagingDirectories = await abandonedStagingDirectories(evidenceRoot);
  if (stagingDirectories.length !== 1) {
    throw new Error("Interrupted publication must have exactly one recoverable staging directory.");
  }
  const stagingRoot = stagingDirectories[0]!;
  const journal = await journalFrom(stagingRoot);
  const paths: PublicationPaths = {
    existingArtifacts: join(evidenceRoot, artifactsDirectoryName),
    existingHtml: join(reportDirectory, reportHtmlFileName),
    existingReport: join(reportDirectory, reportFileName),
    previousArtifacts: join(stagingRoot, "previous-artifacts"),
    previousHtml: join(stagingRoot, "previous-index.html"),
    previousReport: join(stagingRoot, "previous-uiwitness.json"),
  };
  const [artifacts, report, html] = await Promise.all([
    publicationMemberState(
      paths.existingArtifacts,
      paths.previousArtifacts,
      join(stagingRoot, artifactsDirectoryName),
      "directory",
    ),
    publicationMemberState(
      paths.existingReport,
      paths.previousReport,
      join(stagingRoot, reportFileName),
      "file",
    ),
    publicationMemberState(
      paths.existingHtml,
      paths.previousHtml,
      join(stagingRoot, reportHtmlFileName),
      "file",
    ),
  ]);
  const additional: AdditionalPublication[] = [];
  for (const member of journal.additional) {
    const final = resolve(root, ...member.path.split("/"));
    if (posixProjectPath(root, final) !== member.path) {
      throw new Error("Abandoned publication journal path is not canonical.");
    }
    const previous = join(
      stagingRoot,
      `previous-sidecar-${String(member.index).padStart(5, "0")}`,
    );
    const staged = join(
      stagingRoot,
      `sidecar-${String(member.index).padStart(5, "0")}`,
    );
    const state = await publicationMemberState(final, previous, staged, "file");
    additional.push({
      commitPoint: member.path === generationPointerProjectPath,
      existing: final,
      kind: "file",
      movedPrevious: state.movedPrevious,
      previous,
      published: state.published,
    });
  }
  const commitPoints = additional.filter(({ commitPoint }) => commitPoint);
  if (commitPoints.length !== 1) {
    throw new Error("Interrupted publication journal must identify one stable generation marker.");
  }
  if (commitPoints[0]!.published) {
    await validatePublishedMarker(
      root,
      commitPoints[0]!.existing,
      journal.markerDigest,
    );
    await rm(stagingRoot, { force: true, recursive: true });
    await syncDirectory(evidenceRoot);
    return;
  }
  const errors = await recoverPublication(paths, {
    movedPreviousArtifacts: artifacts.movedPrevious,
    movedPreviousHtml: html.movedPrevious,
    movedPreviousReport: report.movedPrevious,
    publishedArtifacts: artifacts.published,
    publishedHtml: html.published,
    publishedReport: report.published,
  }, publicationOperations, additional);
  if (errors.length > 0) {
    throw new AggregateError(errors, "Interrupted publication could not be recovered.");
  }
  await rm(stagingRoot, { force: true, recursive: true });
  await syncDirectory(evidenceRoot);
}

/** @internal Acquires the owned run lock used by persistence integration tests. */
export async function acquirePersistenceLock(
  root: string,
): Promise<PersistenceLock> {
  const evidenceRoot = await ensurePrivateTree(root, [
    evidenceDirectoryName,
  ]);
  const reportDirectory = await ensurePrivateTree(evidenceRoot, [
    reportDirectoryName,
  ]);
  const directory = join(evidenceRoot, lockDirectoryName);
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const candidate = await mkdtemp(join(evidenceRoot, lockCandidatePrefix));
    const token = randomUUID();
    const lock: PersistenceLock = {
      directory,
      preserve: false,
      reportDirectory,
      evidenceRoot,
      token,
    };
    try {
      await writePrivateFile(
        join(candidate, lockOwnerFileName),
        serializeLockOwner(lockOwner(lock)),
      );
      await rename(candidate, directory);
      return lock;
    } catch (error: unknown) {
      if (
        !["EEXIST", "ENOTEMPTY"].includes(
          (error as NodeJS.ErrnoException).code ?? "",
        )
      ) {
        await rm(candidate, { force: true, recursive: true });
        throw error;
      }

      let metadata;
      try {
        metadata = await lstat(directory);
      } catch (metadataError: unknown) {
        await rm(candidate, { force: true, recursive: true });
        if ((metadataError as NodeJS.ErrnoException).code === "ENOENT") {
          continue;
        }
        throw metadataError;
      }
      if (metadata.isSymbolicLink() || !metadata.isDirectory()) {
        await rm(candidate, { force: true, recursive: true });
        throw new Error(
          ".uiwitness result-persistence lock must be a real directory.",
          { cause: error },
        );
      }
      const state = await readLockState(directory);
      if (state.owner !== null && processIsAlive(state.owner.pid)) {
        await rm(candidate, { force: true, recursive: true });
        throw new Error("Another result-persistence run is active.", {
          cause: error,
        });
      }
      if (
        state.owner !== null &&
        (state.phase === "capture" ||
          state.phase === "publishing" ||
          state.phase === "committed")
      ) {
        const staleDirectory = takeoverClaimPath(directory, state.owner.token);
        try {
          await rename(directory, staleDirectory);
        } catch (staleError: unknown) {
          await rm(candidate, { force: true, recursive: true });
          if ((staleError as NodeJS.ErrnoException).code === "ENOENT") {
            continue;
          }
          if (
            ["EEXIST", "ENOTEMPTY"].includes(
              (staleError as NodeJS.ErrnoException).code ?? "",
            )
          ) {
            continue;
          }
          throw staleError;
        }
        try {
          await rename(candidate, directory);
        } catch (replacementError: unknown) {
          await rm(candidate, { force: true, recursive: true });
          if (
            ["EEXIST", "ENOTEMPTY"].includes(
              (replacementError as NodeJS.ErrnoException).code ?? "",
            )
          ) {
            continue;
          }
          throw replacementError;
        }
        try {
          if (state.phase === "capture" || state.phase === "committed") {
            await removeAbandonedStaging(evidenceRoot);
          } else {
            await recoverAbandonedPublication(root, evidenceRoot, reportDirectory);
          }
          await rm(staleDirectory, { force: true, recursive: true });
        } catch (cleanupError: unknown) {
          try {
            lock.preserve = true;
            await updateLockPhase(lock, "recovery");
          } catch (phaseError: unknown) {
            throw new AggregateError(
              [cleanupError],
              "Abandoned persistence cleanup failed and its replacement lock could not record recovery state.",
              { cause: phaseError },
            );
          }
          throw new Error(
            ".uiwitness contains recovery state from an interrupted result-persistence run.",
            { cause: cleanupError },
          );
        }
        return lock;
      }
      await rm(candidate, { force: true, recursive: true });
      throw new Error(
        ".uiwitness contains recovery state from an interrupted result-persistence run.",
        { cause: error },
      );
    }
  }
  throw new Error("Could not acquire the result-persistence lock safely.");
}

/** @internal Publishes a validated report through an acquired lock. */
export async function persistReport(
  root: string,
  lock: PersistenceLock,
  report: AnyUIWitnessReport,
  artifacts: readonly ExecutionArtifact[],
  operations: PublicationOperations = publicationOperations,
  finalization?: GenerationFinalization | undefined,
): Promise<UIWitnessCommittedGeneration> {
  const { directory: lockDirectory, evidenceRoot, reportDirectory } = lock;
  const suppliedFinalization = finalization === undefined
    ? undefined
    : snapshotGenerationFinalization(finalization);

  let stagingRoot: string | undefined;
  let preserveRecoveryState = false;
  let publicationCommitted = false;
  let persistenceError: unknown;
  let committedGeneration: UIWitnessCommittedGeneration | undefined;
  try {
    const existingArtifacts = join(evidenceRoot, artifactsDirectoryName);
    const existingReport = join(reportDirectory, reportFileName);
    const existingHtml = join(reportDirectory, reportHtmlFileName);
    const artifactsType = await existingType(existingArtifacts);
    const reportType = await existingType(existingReport);
    const htmlType = await existingType(existingHtml);
    if (artifactsType !== "missing" && artifactsType !== "directory") {
      throw new TypeError(
        ".uiwitness/artifacts must be a real directory, not a symbolic link.",
      );
    }
    if (reportType !== "missing" && reportType !== "file") {
      throw new TypeError(
        ".uiwitness/report/uiwitness.json must be a regular file, not a symbolic link.",
      );
    }
    if (htmlType !== "missing" && htmlType !== "file") {
      throw new TypeError(
        ".uiwitness/report/index.html must be a regular file, not a symbolic link.",
      );
    }

    stagingRoot = await mkdtemp(join(evidenceRoot, stagingDirectoryPrefix));
    const stagedArtifacts = await ensurePrivateTree(stagingRoot, [
      artifactsDirectoryName,
    ]);
    for (const artifact of artifacts) {
      if (
        artifact.screenshot === null ||
        artifact.result.screenshotPath === null
      ) {
        continue;
      }
      const segments = safeRelativeSegments(artifact.result.screenshotPath);
      if (
        segments[0] !== evidenceDirectoryName ||
        segments[1] !== artifactsDirectoryName
      ) {
        throw new TypeError(
          "Screenshot paths must stay inside .uiwitness/artifacts/.",
        );
      }
      const fileSegments = segments.slice(2);
      const fileName = fileSegments.at(-1);
      if (fileName === undefined) {
        throw new TypeError("Screenshot artifact paths must include a filename.");
      }
      const directory = await ensurePrivateTree(
        stagedArtifacts,
        fileSegments.slice(0, -1),
      );
      const destination = join(directory, fileName);
      assertContained(stagingRoot, destination);
      await (operations.writeFile ?? writePrivateFile)(destination, artifact.screenshot);
    }

    const selectedFinalization = suppliedFinalization ??
      snapshotGenerationFinalization({ toolVersion: await runnerVersion() });
    validateGenerationSidecars(selectedFinalization);
    const contractVerdictArtifact = selectedFinalization.artifacts?.find(
      ({ role }) => role === "contract-verdict",
    );
    const contractVerdict = contractVerdictArtifact === undefined
      ? undefined
      : JSON.parse(
          validateCanonicalJsonSidecar(contractVerdictArtifact),
        ) as ContractVerdictReportInput;
    if (
      contractVerdict !== undefined &&
      selectedFinalization.runDigest !== contractVerdict.runDigest
    ) {
      throw new TypeError(
        "The generation run digest must exactly match the contract verdict run digest.",
      );
    }
    const reportContents = serializeReport(report);
    const evidenceManifest = evidenceManifestFor(
      report,
      reportContents,
      artifacts,
      selectedFinalization,
    );
    const evidenceManifestContents = serializeEvidenceManifest(evidenceManifest);
    const htmlContents = renderReportHtml(
      report,
      {
        ...(contractVerdict === undefined ? {} : { contractVerdict }),
        evidenceManifest,
      },
    );
    const stagedReport = join(stagingRoot, reportFileName);
    assertContained(stagingRoot, stagedReport);
    await (operations.writeFile ?? writePrivateFile)(stagedReport, reportContents);
    const stagedHtml = join(stagingRoot, reportHtmlFileName);
    assertContained(stagingRoot, stagedHtml);
    await (operations.writeFile ?? writePrivateFile)(stagedHtml, htmlContents);

    const sidecars = [...(selectedFinalization.artifacts ?? [])];
    const sidecarPaths = new Set<string>();
    const stagedAdditional: Array<{
      readonly contents: string | Uint8Array;
      readonly final: string;
      readonly mutable: boolean;
      readonly path: string;
      readonly publication: GenerationArtifactPublication;
      readonly role: PrivacyGenerationArtifactRole;
      readonly staged: string;
    }> = [];
    for (const [index, sidecar] of sidecars.entries()) {
      const final = resolve(root, ...canonicalRelativeSegments(sidecar.path));
      const path = posixProjectPath(root, final);
      if (sidecar.path !== path) {
        throw new TypeError(`Generation artifact paths must be canonical project-relative paths: ${sidecar.path}`);
      }
      if (
        path === generationPointerProjectPath ||
        path.startsWith(`${generationPointerProjectPath}/`) ||
        path === reportProjectPath ||
        path === REPORT_HTML_PATH ||
        path === `${evidenceDirectoryName}/${artifactsDirectoryName}` ||
        path.startsWith(`${evidenceDirectoryName}/${artifactsDirectoryName}/`) ||
        path === `${evidenceDirectoryName}/${reportDirectoryName}` ||
        path.startsWith(`${evidenceDirectoryName}/${reportDirectoryName}/`) ||
        path === `${evidenceDirectoryName}/generations` ||
        path.startsWith(`${evidenceDirectoryName}/generations/`) ||
        isReservedControlPath(path) ||
        sidecarPaths.has(path)
      ) {
        throw new TypeError(`Duplicate generation artifact path: ${path}`);
      }
      if ([...sidecarPaths].some((existing) =>
        existing.startsWith(`${path}/`) || path.startsWith(`${existing}/`)
      )) {
        throw new TypeError(`Generation artifact paths cannot contain one another: ${path}`);
      }
      sidecarPaths.add(path);
      await ensureSafeParent(
        root,
        final,
        operations.syncDirectory ?? syncDirectory,
      );
      const staged = join(stagingRoot, `sidecar-${String(index).padStart(5, "0")}`);
      await (operations.writeFile ?? writePrivateFile)(staged, sidecar.contents);
      stagedAdditional.push({
        contents: sidecar.contents,
        final,
        mutable: sidecar.mutable ?? false,
        path,
        publication: sidecar.publication,
        role: sidecar.role,
        staged,
      });
    }

    const evidenceManifestFinal = resolve(
      root,
      ...EVIDENCE_MANIFEST_PATH.split("/"),
    );
    const stagedEvidenceManifest = join(
      stagingRoot,
      `sidecar-${String(sidecars.length).padStart(5, "0")}`,
    );
    await (operations.writeFile ?? writePrivateFile)(
      stagedEvidenceManifest,
      evidenceManifestContents,
    );
    stagedAdditional.push({
      contents: evidenceManifestContents,
      final: evidenceManifestFinal,
      mutable: false,
      path: EVIDENCE_MANIFEST_PATH,
      publication: "replace",
      role: "evidence-manifest",
      staged: stagedEvidenceManifest,
    });

    const descriptors: PrivacyGenerationArtifactDescriptor[] = artifacts
      .filter((artifact) => artifact.screenshot !== null && artifact.result.screenshotPath !== null)
      .map((artifact) => artifactDescriptor(
        artifact.result.screenshotPath!,
        "evidence",
        artifact.screenshot!,
      ));
    descriptors.push(
      artifactDescriptor(reportProjectPath, "report-json", reportContents),
      artifactDescriptor(REPORT_HTML_PATH, "report-html", htmlContents),
      ...stagedAdditional.map((member) =>
        artifactDescriptor(member.path, member.role, member.contents, member.mutable)
      ),
    );
    descriptors.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
    const sourceGenerationDigests = [
      ...new Set(selectedFinalization.sourceGenerationDigests ?? []),
    ].sort();
    const manifest = parsePrivacyGenerationManifest(serializePrivacyGenerationManifest({
      artifacts: descriptors,
      complete: true,
      reportDigest: artifactDigest(reportContents),
      runDigest: selectedFinalization.runDigest ?? null,
      schemaVersion: PRIVACY_GENERATION_MANIFEST_SCHEMA_VERSION,
      sourceGenerationDigests,
      toolVersion: selectedFinalization.toolVersion,
    }));
    const manifestContents = serializePrivacyGenerationManifest(manifest);
    const manifestDigest = generationManifestDigest(manifest);
    const manifestPath = `${evidenceDirectoryName}/generations/${manifestDigest.slice("sha256:".length)}.manifest.json`;
    const manifestFinal = resolve(root, ...manifestPath.split("/"));
    await ensureSafeParent(
      root,
      manifestFinal,
      operations.syncDirectory ?? syncDirectory,
    );
    const stagedManifest = join(stagingRoot, "generation-manifest.json");
    await (operations.writeFile ?? writePrivateFile)(stagedManifest, manifestContents);
    committedGeneration = Object.freeze({
      manifestDigest,
      manifestPath,
      schemaVersion: COMMITTED_GENERATION_SCHEMA_VERSION,
      sourceGenerationDigests,
    });
    const markerContents = serializeCommittedGeneration(committedGeneration);
    const markerFinal = resolve(root, ...generationPointerProjectPath.split("/"));
    const stagedMarker = join(stagingRoot, "generation.json");
    await (operations.writeFile ?? writePrivateFile)(stagedMarker, markerContents);
    stagedAdditional.push({
      contents: manifestContents,
      final: manifestFinal,
      mutable: false,
      path: manifestPath,
      publication: "immutable",
      role: "contract-source",
      staged: stagedManifest,
    });
    stagedAdditional.push({
      contents: markerContents,
      final: markerFinal,
      mutable: false,
      path: generationPointerProjectPath,
      publication: "replace",
      role: "contract-source",
      staged: stagedMarker,
    });
    const previousArtifacts = join(stagingRoot, "previous-artifacts");
    const previousReport = join(stagingRoot, "previous-uiwitness.json");
    const previousHtml = join(stagingRoot, "previous-index.html");
    let movedPreviousArtifacts = false;
    let movedPreviousReport = false;
    let movedPreviousHtml = false;
    let publishedArtifacts = false;
    let publishedReport = false;
    let publishedHtml = false;
    const additional: AdditionalPublication[] = [];
    const pendingAdditional: Array<{
      readonly index: number;
      readonly member: (typeof stagedAdditional)[number];
      readonly state: AdditionalPublication;
    }> = [];
    for (const [index, member] of stagedAdditional.entries()) {
      const type = await existingType(member.final);
      if (type !== "missing" && type !== "file") {
        throw new TypeError(`Generation artifact target is not a safe regular file: ${member.path}`);
      }
      if (member.publication === "exclusive" && type !== "missing") {
        throw new Error(`Generation artifact already exists: ${member.path}`);
      }
      if (member.publication === "immutable" && type === "file") {
        const existing = await readFile(member.final);
        const desired = typeof member.contents === "string"
          ? Buffer.from(member.contents)
          : Buffer.from(member.contents);
        if (!existing.equals(desired)) {
          throw new Error(`Immutable generation artifact changed: ${member.path}`);
        }
        continue;
      }
      const state: AdditionalPublication = {
        commitPoint: member.path === generationPointerProjectPath,
        existing: member.final,
        kind: "file",
        movedPrevious: false,
        previous: join(stagingRoot, `previous-sidecar-${String(index).padStart(5, "0")}`),
        published: false,
      };
      additional.push(state);
      pendingAdditional.push({ index, member, state });
    }
    const journal: PublicationJournal = Object.freeze({
      additional: Object.freeze(pendingAdditional.map(({ index, member }) =>
        Object.freeze({ index, path: member.path })
      )),
      markerDigest: artifactDigest(markerContents),
      schemaVersion: 1,
    });
    await (operations.writeFile ?? writePrivateFile)(
      join(stagingRoot, publicationJournalFileName),
      serializePublicationJournal(journal),
    );
    await syncDirectoryTree(stagingRoot, operations.syncDirectory ?? syncDirectory);
    await (operations.syncDirectory ?? syncDirectory)(evidenceRoot);
    await updateLockPhase(lock, "publishing", operations);

    try {
      if (reportType === "file") {
        await operations.rename(existingReport, previousReport);
        movedPreviousReport = true;
        await (operations.syncDirectory ?? syncDirectory)(reportDirectory);
        await (operations.syncDirectory ?? syncDirectory)(stagingRoot);
      }
      if (htmlType === "file") {
        await operations.rename(existingHtml, previousHtml);
        movedPreviousHtml = true;
        await (operations.syncDirectory ?? syncDirectory)(reportDirectory);
        await (operations.syncDirectory ?? syncDirectory)(stagingRoot);
      }
      if (artifactsType === "directory") {
        await operations.rename(existingArtifacts, previousArtifacts);
        movedPreviousArtifacts = true;
        await (operations.syncDirectory ?? syncDirectory)(evidenceRoot);
        await (operations.syncDirectory ?? syncDirectory)(stagingRoot);
      }
      for (const { member, state } of pendingAdditional) {
        const type = await existingType(member.final);
        if (type !== "missing" && type !== "file") {
          throw new TypeError(`Generation artifact target changed to an unsafe type: ${member.path}`);
        }
        if (member.publication !== "replace" && type !== "missing") {
          throw new Error(
            `Generation artifact target appeared during publication: ${member.path}`,
          );
        }
        if (type === "file") {
          await operations.rename(member.final, state.previous);
          state.movedPrevious = true;
          await (operations.syncDirectory ?? syncDirectory)(resolve(member.final, ".."));
          await (operations.syncDirectory ?? syncDirectory)(stagingRoot);
        }
      }
      await operations.rename(stagedArtifacts, existingArtifacts);
      publishedArtifacts = true;
      await (operations.syncDirectory ?? syncDirectory)(evidenceRoot);
      await (operations.syncDirectory ?? syncDirectory)(stagingRoot);
      await operations.rename(stagedReport, existingReport);
      publishedReport = true;
      await (operations.syncDirectory ?? syncDirectory)(reportDirectory);
      await (operations.syncDirectory ?? syncDirectory)(stagingRoot);
      for (const { member, state } of pendingAdditional) {
        if (member.path === generationPointerProjectPath) continue;
        if (member.publication === "replace") {
          await operations.rename(member.staged, member.final);
        } else {
          await (operations.link ?? link)(member.staged, member.final);
          state.published = true;
          await operations.remove(member.staged, { force: true });
        }
        state.published = true;
        await (operations.syncDirectory ?? syncDirectory)(resolve(member.final, ".."));
        await (operations.syncDirectory ?? syncDirectory)(stagingRoot);
      }
      await operations.rename(stagedHtml, existingHtml);
      publishedHtml = true;
      await (operations.syncDirectory ?? syncDirectory)(reportDirectory);
      await (operations.syncDirectory ?? syncDirectory)(stagingRoot);
      const markerPublication = pendingAdditional.find(
        ({ member }) => member.path === generationPointerProjectPath,
      );
      if (markerPublication === undefined) {
        throw new Error("Generation publication is missing its stable marker.");
      }
      await operations.rename(
        markerPublication.member.staged,
        markerPublication.member.final,
      );
      markerPublication.state.published = true;
      await (operations.syncDirectory ?? syncDirectory)(evidenceRoot);
      await (operations.syncDirectory ?? syncDirectory)(stagingRoot);
      await updateLockPhase(lock, "committed", operations);
      publicationCommitted = true;
    } catch (error: unknown) {
      const recoveryErrors = [
        ...(await recoverPublication(
          {
            existingArtifacts,
            existingHtml,
            existingReport,
            previousArtifacts,
            previousHtml,
            previousReport,
          },
          {
            movedPreviousArtifacts,
            movedPreviousHtml,
            movedPreviousReport,
            publishedArtifacts,
            publishedHtml,
            publishedReport,
          },
          operations,
          additional,
        )),
      ];
      if (recoveryErrors.length > 0) {
        preserveRecoveryState = true;
        lock.preserve = true;
        try {
          await updateLockPhase(lock, "recovery", operations);
        } catch (phaseError: unknown) {
          recoveryErrors.push(phaseError);
        }
        throw new AggregateError(
          recoveryErrors,
          `Result publication failed and automatic recovery was incomplete. Recovery data remains at ${relative(root, stagingRoot)}; preserve ${relative(root, lockDirectory)} until the previous output is recovered.`,
          { cause: error },
        );
      }
      throw error;
    }
  } catch (error: unknown) {
    persistenceError = error;
  }

  const cleanupErrors: unknown[] = [];
  if (!preserveRecoveryState) {
    if (stagingRoot !== undefined) {
      try {
        await operations.remove(stagingRoot, { force: true, recursive: true });
        await (operations.syncDirectory ?? syncDirectory)(evidenceRoot);
      } catch (error: unknown) {
        cleanupErrors.push(error);
        lock.preserve = true;
        if (!publicationCommitted) {
          try {
            await updateLockPhase(lock, "recovery", operations);
          } catch (phaseError: unknown) {
            cleanupErrors.push(phaseError);
          }
        }
      }
    }
  }

  if (persistenceError !== undefined) {
    if (cleanupErrors.length > 0) {
      throw new AggregateError(
        [persistenceError, ...cleanupErrors],
        "Result persistence and cleanup both failed.",
      );
    }
    throw persistenceError;
  }
  if (cleanupErrors.length > 0) {
    throw new AggregateError(cleanupErrors, "Result persistence cleanup failed.");
  }
  if (committedGeneration === undefined) {
    throw new Error("Result persistence completed without a committed generation.");
  }
  return committedGeneration;
}

/**
 * Runs the complete browser lifecycle and transactionally publishes deterministic
 * PNGs, schema-v1 JSON, and the offline HTML report under one owned run lock.
 */
export function runPersistedScenarioCells(
  cells: readonly MatrixCell[],
  options: PrivacyRunPersistedScenarioCellsOptions,
): Promise<PrivacyPersistedScenarioRun>;
export function runPersistedScenarioCells(
  cells: readonly MatrixCell[],
  options: RunPersistedScenarioCellsOptions,
): Promise<PersistedScenarioRun>;
export function runPersistedScenarioCells(
  cells: readonly MatrixCell[],
  options: AnyRunPersistedScenarioCellsOptions,
): Promise<AnyPersistedScenarioRun>;
export async function runPersistedScenarioCells(
  cells: readonly MatrixCell[],
  options: AnyRunPersistedScenarioCellsOptions,
): Promise<AnyPersistedScenarioRun> {
  const root = await projectRoot(options.projectDirectory);
  const configuredTimestamp = reportTimestamp(options.generatedAt);
  validatePersistenceBoundary(
    cells,
    options.baseURL,
    configuredTimestamp,
    options.evidence,
  );
  const lock = await acquirePersistenceLock(root);
  let run: AnyPersistedScenarioRun | undefined;
  let runError: unknown;
  try {
    const outcomes = options.evidence?.retention === "failures-only" ||
        options.evidence?.retention === "none"
      ? await runCapturedScenarioCells(
          cells,
          options as PrivacyRunCapturedScenarioCellsOptions,
        )
      : await runCapturedScenarioCells(
          cells,
          options as RunCapturedScenarioCellsOptions,
        );
    const artifacts = outcomes.map((outcome) =>
      executionArtifactForOutcome(outcome, options.baseURL, options.evidence),
    );
    const report = reportFor(
      cells,
      artifacts,
      options.baseURL,
      configuredTimestamp ?? new Date().toISOString(),
      options.evidence,
    );
    const finalization = options.finalizeGeneration === undefined
      ? undefined
      : report.schemaVersion === REPORT_SCHEMA_VERSION
        ? await (options.finalizeGeneration as GenerationFinalizer)(report)
        : await (options.finalizeGeneration as PrivacyGenerationFinalizer)(report);
    const generation = await persistReport(
      root,
      lock,
      report,
      artifacts,
      publicationOperations,
      finalization,
    );
    run = Object.freeze({
      generation,
      htmlReportPath: REPORT_HTML_PATH,
      report,
      reportPath: reportProjectPath,
    }) as AnyPersistedScenarioRun;
  } catch (error: unknown) {
    runError = error;
  }

  let lockCleanupError: unknown;
  if (!lock.preserve) {
    try {
      await releasePersistenceLock(lock);
    } catch (error: unknown) {
      lockCleanupError = error;
    }
  }
  if (runError !== undefined && lockCleanupError !== undefined) {
    throw new AggregateError(
      [runError, lockCleanupError],
      "Result persistence and lock cleanup both failed.",
    );
  }
  if (runError !== undefined) {
    throw runError;
  }
  if (lockCleanupError !== undefined) {
    throw lockCleanupError;
  }
  if (run === undefined) {
    throw new Error("Result persistence completed without a report.");
  }
  return run;
}
