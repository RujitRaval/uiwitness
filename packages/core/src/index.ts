export {
  CANONICAL_JSON_ALGORITHM,
  canonicalizeJson,
  canonicalJsonDigest,
} from "./canonical-json.js";
export type { JsonValue, Sha256Digest } from "./canonical-json.js";
export {
  EVIDENCE_MANIFEST_PATH,
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  parseEvidenceManifest,
  serializeEvidenceManifest,
} from "./evidence.js";
export type {
  EvidenceManifestMask,
  UIWitnessEvidenceManifest,
} from "./evidence.js";
export {
  CONTRACT_DIGEST_ALGORITHM,
  CONTRACT_FAILURE_CODES,
  CONTRACT_SCHEMA_VERSION,
  canonicalizeContract,
  contractDigest,
  parseContract,
} from "./contract.js";
export type {
  ContractCoordinate,
  ContractException,
  ContractExpectation,
  ContractFailureCode,
  UIWitnessContract,
} from "./contract.js";
export {
  CONTRACT_CONFIG_DIGEST_ALGORITHM,
  compareContract,
  contractConfigDigest,
} from "./contract-comparison.js";
export type {
  CompareContractOptions,
  ContractConfigurationCoordinate,
  ContractExecutionObservation,
} from "./contract-comparison.js";
export {
  CONTRACT_FINDING_KINDS,
  CONTRACT_FINDING_PRECEDENCE,
  contractExceptionLifecycle,
  contractVerdictStatus,
} from "./contract-verdict.js";
export {
  CONTRACT_METADATA_SCHEMA_VERSION,
  CONTRACT_PROPOSAL_OPERATIONS,
  CONTRACT_PROPOSAL_SCHEMA_VERSION,
  CONTRACT_SOURCE_SCHEMA_VERSION,
  applyContractProposal,
  contractProposalDigest,
  contractProposalSourceDigest,
  createContractProposal,
  createContractProposalSource,
  emptyContractProposalMetadata,
  parseContractProposal,
  parseContractProposalMetadata,
  parseContractProposalSource,
  serializeContractProposal,
  serializeContractProposalMetadata,
  serializeContractProposalSource,
  withContractProposalAnnotation,
} from "./contract-proposal.js";
export {
  COMMITTED_GENERATION_SCHEMA_VERSION,
  GENERATION_ARTIFACT_ROLES,
  GENERATION_MANIFEST_SCHEMA_VERSION,
  PRIVACY_GENERATION_ARTIFACT_ROLES,
  PRIVACY_GENERATION_MANIFEST_SCHEMA_VERSION,
  generationManifestDigest,
  parseAnyGenerationManifest,
  parseCommittedGeneration,
  parseGenerationManifest,
  parsePrivacyGenerationManifest,
  serializeCommittedGeneration,
  serializeGenerationManifest,
  serializePrivacyGenerationManifest,
} from "./generation.js";
export type {
  AnyGenerationArtifactRole,
  AnyUIWitnessGenerationManifest,
  GenerationArtifactDescriptor,
  GenerationArtifactRole,
  PrivacyGenerationArtifactDescriptor,
  PrivacyGenerationArtifactRole,
  UIWitnessCommittedGeneration,
  UIWitnessGenerationManifest,
  UIWitnessGenerationManifestV2,
} from "./generation.js";
export type {
  ContractProposal,
  ContractProposalChange,
  ContractProposalMetadata,
  ContractProposalOperation,
  ContractProposalSource,
  ContractSourceDigest,
  ContractSourceExecution,
  ProposedExpectation,
} from "./contract-proposal.js";
export type {
  ChangedKnownFailureContractFinding,
  ContractExceptionLifecycle,
  ContractActualOutcome,
  ContractComparisonResult,
  ContractFinding,
  ContractFindingKind,
  ContractRunErrorReason,
  ContractVerdictStatus,
  ExpiredExceptionContractFinding,
  KnownFailureContractFinding,
  MatchedContractFinding,
  MissingCoordinateContractFinding,
  RecoveredKnownFailureContractFinding,
  RegressionContractFinding,
  RunErrorContractFinding,
  UnacceptedAdditionContractFinding,
  UnacceptedConfigDriftContractFinding,
} from "./contract-verdict.js";
export {
  defineConfig,
  parseConfig,
} from "./config.js";
export {
  AuthenticationStateError,
  validateAuthenticationStorageState,
} from "./authentication.js";
export type {
  EvidenceConfig,
  EvidenceMaskConfig,
  FailurePolicy,
  RouteDefinition,
  StateDefinition,
  UIWitnessConfig,
  ViewportDefinition,
} from "./config.js";
export type {
  AuthenticationConfig,
  AuthenticationCookieScope,
  AuthenticationLocalStorageEntry,
  AuthenticationMode,
  AuthenticationOriginStorage,
  AuthenticationStateErrorCode,
  AuthenticationStorageCookie,
  AuthenticationStorageState,
} from "./authentication.js";
export {
  CanonicalJsonError,
  ConfigValidationError,
  ContractValidationError,
  ContractProposalValidationError,
  GenerationValidationError,
  ReportValidationError,
  ResultValidationError,
  UIWitnessError,
} from "./errors.js";
export type {
  CanonicalJsonIssue,
  ConfigValidationIssue,
  ConfigValidationIssueCode,
  ContractValidationIssue,
  ContractValidationIssueCode,
  GenerationValidationIssue,
  ReportValidationIssue,
  ResultValidationIssue,
  UIWitnessErrorCode,
} from "./errors.js";
export { expandMatrix } from "./matrix.js";
export type { MatrixCell, MatrixFilter } from "./matrix.js";
export { screenshotArtifactPath } from "./artifacts.js";
export type {
  LegacyScreenshotArtifactPath,
  ReportScreenshotArtifactPath,
  ScreenshotArtifactPath,
} from "./artifacts.js";
export { calculateCoverage } from "./coverage.js";
export type {
  CoverageMetric,
  CoverageObservation,
  CoverageSummary,
} from "./coverage.js";
export {
  PRIVACY_REPORT_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  parseAnyReport,
  parseExecutionResult,
  parseReport,
  serializeReport,
} from "./results.js";
export type {
  AnyUIWitnessReport,
  AnyReportExecutionResult,
  ExecutionDiagnostics,
  ExecutionFailure,
  ExecutionFailureCode,
  ExecutionResult,
  ExecutionStatus,
  FailedRequestDiagnostic,
  ReportExecutionResult,
  ReportExecutionResultV2,
  ReportScreenshot,
  ReportSummary,
  UIWitnessReport,
  UIWitnessReportV1,
  UIWitnessReportV2,
} from "./results.js";
