export {
  AuthenticationError,
} from "./authentication.js";
export type {
  AuthenticationErrorCode,
  AuthSetup,
  AuthSetupContext,
  RunAuthenticationOptions,
} from "./authentication.js";
export {
  discoverPublicRoutes,
  PublicRouteDiscoveryError,
} from "./discovery.js";
export type {
  DiscoveredPublicRoute,
  DiscoverPublicRoutesOptions,
  PublicRouteDiscovery,
  PublicRouteDiscoveryErrorCode,
} from "./discovery.js";
export { runExecutionCells } from "./lifecycle.js";
export type {
  CellExecutionContext,
  CellExecutionOutcome,
  CellExecutor,
  FulfilledCellExecution,
  RejectedCellExecution,
  RunExecutionCellsOptions,
} from "./lifecycle.js";
export {
  EvidencePolicyError,
  runCapturedScenarioCells,
  ScenarioCaptureError,
} from "./capture.js";
export type {
  AppliedEvidenceMask,
  AssertionStatus,
  CapturedScenarioCell,
  CompletedScenarioCell,
  DroppedDiagnosticCounts,
  EvidenceScreenshotStatus,
  OmittedScenarioCell,
  PrivacyRunCapturedScenarioCellsOptions,
  RunCapturedScenarioCellsOptions,
  ScenarioCaptureEvidence,
} from "./capture.js";
export {
  runPersistedScenarioCells,
  withGenerationTransactionLock,
} from "./persistence.js";
export type {
  AnyPersistedScenarioRun,
  GenerationArtifactPublication,
  GenerationFinalization,
  GenerationFinalizer,
  GenerationSidecarArtifact,
  PersistedScenarioRun,
  PrivacyGenerationFinalizer,
  PrivacyPersistedScenarioRun,
  PrivacyRunPersistedScenarioCellsOptions,
  RunPersistedScenarioCellsOptions,
} from "./persistence.js";
export {
  loadScenario,
  runScenarioCells,
  runScenarioLifecycle,
  ScenarioLoadError,
} from "./scenario.js";
export type {
  AssertionScenarioContext,
  LoadScenarioOptions,
  RunScenarioCellsOptions,
  ScenarioCellExecutor,
  ScenarioContext,
  ScenarioAssertionHook,
  ScenarioHook,
  ScenarioLoadErrorCode,
  UIWitnessScenario,
} from "./scenario.js";
export {
  PUBLIC_SITE_OVERFLOW_TOLERANCE_PX,
  publicSiteScenario,
} from "./public-site-scenario.js";
export { runPublicSiteChecks } from "./public-site.js";
export type { RunPublicSiteChecksOptions } from "./public-site.js";
export { runNavigatedScenarioCells } from "./navigation.js";
export type {
  DeterministicReadinessOptions,
  NavigatedScenarioCellExecutor,
  NavigatedScenarioContext,
  NavigationMetadata,
  RunNavigatedScenarioCellsOptions,
} from "./navigation.js";
