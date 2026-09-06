# `uiwitness-core` API

`uiwitness-core` provides UIWitness's published, deterministic, browser-independent contracts. Most users install `uiwitness`; direct consumers can build integrations against this package's stable configuration, state-contract, canonical-digest, comparison/verdict, proposal/acceptance, matrix, coverage, artifact-path, and report boundaries.

## Configuration

```ts
import { defineConfig } from "uiwitness-core";

export default defineConfig({
  baseURL: "http://localhost:3000",
  viewports: {
    mobile: { width: 390, height: 844 },
    desktop: { width: 1440, height: 1000 },
  },
  themes: ["light", "dark"],
  routes: [
    {
      id: "dashboard",
      path: "/dashboard",
      states: [
        {
          id: "success",
          setup: "./uiwitness/scenarios/dashboard/success.ts",
        },
      ],
    },
  ],
});
```

`defineConfig(config)` is an identity helper that provides contextual TypeScript checking. It does not perform runtime validation or load scenario modules.

`parseConfig(input)` strictly validates an unknown value and returns a `UIWitnessConfig`. It rejects unknown properties, non-HTTP(S) base URLs, empty collections, invalid viewport dimensions, malformed IDs, duplicate route/state/theme IDs, empty scenario paths, and route paths that are not local slash-prefixed paths.

The optional `authentication` object accepts one non-empty setup-module path, only `mode: "shared-readonly"` (the default), exact additional HTTP(S) origins, and explicit cookie scopes. Origins are normalized to scheme, punycoded host, and effective port. Cookie domains must be lowercase ASCII hosts, match the application or an additional origin, and cannot be ICANN or private public suffixes; scope paths begin with `/`, secure policy is explicit, and optional partition keys are normalized exact origins. Arrays and normalized values cannot be empty or duplicated.

The optional `evidence` object accepts `retention: "all" | "failures-only" | "none"` and named masks. Mask IDs use the existing identifier grammar, selectors are non-empty and capped at 1,024 characters, `required` defaults to `true`, `count` is an exact positive integer, and non-empty route/state scopes must reference exact configured IDs. Duplicate IDs and scopes fail at their precise config path. Omitting evidence defaults behavior to `all` with no masks.

`validateAuthenticationStorageState(state, options)` is the browser-independent enforcement boundary used by the runner. It returns a detached frozen `AuthenticationStorageState` only when every local-storage origin and cookie domain/path/secure/partition attribute stays inside the parsed policy. It throws an opaque `AuthenticationStateError` with `AUTH_ORIGIN_NOT_ALLOWED` or `AUTH_COOKIE_NOT_ALLOWED`; neither error contains cookie names, values, origins, local-storage keys, or secret data.

Route, state, theme, and viewport IDs use lowercase letters and numbers separated by single hyphens. Domain-specific IDs such as `payment-declined` are supported.

The underlying Zod schema is intentionally private. Callers use `parseConfig` so validation behavior and errors remain UIWitness-owned contracts rather than validator-specific APIs.

## Validation errors

`parseConfig` throws `ConfigValidationError`, a `UIWitnessError` with:

- `code: "CONFIG_INVALID"` for machine-readable classification;
- a deterministic `issues` array containing `code`, `path`, and `message`;
- UIWitness-owned issue codes that do not expose Zod's internal issue types.

Configuration, scenario, and authentication modules are trusted local code running with the user's privileges. Validation checks their declared shape; it does not sandbox, execute, or inspect setup modules.

## State contracts and canonical JSON

`parseContract(source)` reads strict JSON text into a schema-v1 `UIWitnessContract`. It rejects comments, trailing commas, duplicate decoded keys, lone UTF-16 surrogates, non-finite numbers, negative zero, unknown fields or versions, malformed coordinate identities, non-canonical sanitized route paths, unsafe scenario paths, invalid known-failure metadata, and out-of-order or duplicate domain arrays. Contracts are bounded to 10,000 coordinates; governed text and path fields are bounded to 1,024 characters; diagnostics retain at most 99 exact issues plus one omission marker.

```ts
import { readFile } from "node:fs/promises";

import {
  canonicalizeContract,
  contractDigest,
  parseContract,
} from "uiwitness-core";

const contract = parseContract(await readFile("uiwitness.contract.json", "utf8"));
const canonical = canonicalizeContract(contract);
const digest = contractDigest(contract);
```

`canonicalizeContract(contract)` normalizes coordinates by the `routeId`, `stateId`, `viewportId`, and `theme` tuple and known-failure codes lexicographically before applying RFC 8785 JCS. `contractDigest(contract)` returns `sha256:<64 lowercase hex characters>` over those UTF-8 bytes. The associated constants are `CONTRACT_SCHEMA_VERSION`, `CONTRACT_FAILURE_CODES`, and `CONTRACT_DIGEST_ALGORITHM`.

For lower-level integrations, `canonicalizeJson(value)` and `canonicalJsonDigest(value)` accept only strict `JsonValue` data. They reject cyclic, sparse, accessor-backed, prototype-altered, `toJSON`-bearing, non-finite, negative-zero, and lone-surrogate values rather than accepting JavaScript behavior that can silently change hashed data. `CANONICAL_JSON_ALGORITHM` identifies the RFC 8785 implementation.

Invalid contract text throws `ContractValidationError` with code `CONTRACT_INVALID`; invalid programmatic canonical JSON throws `CanonicalJsonError` with code `CANONICAL_JSON_INVALID`. Both expose immutable UIWitness-owned issues without leaking parser or canonicalizer internals. Workspace containment and file safety remain CLI responsibilities; these core functions perform no filesystem, browser, clock, environment, or network access.

## State-contract comparison and verdicts

`compareContract(options)` compares one validated committed contract with the current configuration inventory and one fresh execution observation for every configured coordinate. The API is pure and browser-independent:

```ts
import { compareContract } from "uiwitness-core";

const result = compareContract({
  complete: true,
  configuration,
  contract,
  executions,
  now: () => new Date("2026-09-03T12:00:00.000Z"),
});

if (result.verdict !== "passed") {
  console.error(result.findings);
}
```

`configuration` contains the current `ContractConfigurationCoordinate` inventory, including each coordinate's stable ID and config fingerprint. `executions` contains message-free `ContractExecutionObservation` records: exact route/state/viewport/theme identity, `passed` or `failed` status, and stable failure codes only. `complete` must be `true` only when the caller has a trustworthy fresh observation for every configured coordinate. The optional `now` clock is called exactly once and fixes one UTC `evaluatedOn` date for deterministic expiry checks and coordinated runs.

Malformed contracts, configuration coordinates, execution observations, completeness values, clocks, or future-dated exceptions throw the corresponding `ContractValidationError`, `ConfigValidationError`, `ResultValidationError`, or `RangeError`. A declared-incomplete run, duplicate execution coordinate, missing execution, or unexpected execution is valid comparison output instead: the result has `complete: false`, an `error` verdict, and only `run-error` findings, so partial evidence is never compared as fresh truth.

For a complete aligned run, the engine emits canonically ordered findings by coordinate ID and then `CONTRACT_FINDING_PRECEDENCE`:

- `unaccepted-addition` and `missing-coordinate` report inventory changes;
- `unaccepted-config-drift` reports a changed coordinate fingerprint and takes precedence over its semantic outcome;
- `expired-exception` reports known-failure metadata whose UTC expiry date is before `evaluatedOn`;
- `regression`, `changed-known-failure`, and `recovered-known-failure` are failing verdict outcomes;
- `matched` and `matched-known-failure` are the only passing finding kinds.

Known failures match only when the observed unique sorted stable failure-code set exactly equals the committed set. They remain active through `expiresOn`; expiry begins on the following UTC date. Failure messages never participate in identity. Results and nested findings are detached from caller-owned data and recursively frozen.

`contractExceptionLifecycle(exception, evaluatedOn)` exposes those same UTC boundary semantics to integrations without running a comparison. It returns a frozen `ContractExceptionLifecycle` with `status: "active" | "expired"` and signed `daysUntilExpiry`; zero means the exception remains active on its expiry date. Both dates must be real `YYYY-MM-DD` UTC calendar dates.

`contractConfigDigest(configuration)` returns the RFC 8785 SHA-256 digest of the canonical ordered coordinate-ID/config-fingerprint inventory. `CONTRACT_CONFIG_DIGEST_ALGORITHM` identifies that projection. `contractVerdictStatus(findings)` applies the same stable overall rule independently: any `run-error` produces `error`, only all-matched findings produce `passed`, and every other set produces `failed`. `CONTRACT_FINDING_KINDS` publishes the complete finding vocabulary.

The CLI adapts project config and the same run's in-memory schema-v1 or schema-v2 report into these inputs, persists a deterministic machine verdict, and exposes stable process semantics. The browser-independent comparison contract stays owned here.

## Contract proposals and named acceptance

`createContractProposalSource` snapshots one complete configuration inventory, source contract or `null`, fresh message-free execution outcomes, evaluated UTC date, and run digest. It rejects any source without exactly one execution for every configured coordinate. `createContractProposal` deterministically derives individually named `add`, `remove`, `config`, `expectation`, and `exception` operations. Change IDs are `<operation>:<route/state/viewport/theme>`; the proposal binds the source-generation, source-contract, config, and run digests plus its tool/schema versions.

```ts
import {
  applyContractProposal,
  createContractProposal,
  createContractProposalSource,
  emptyContractProposalMetadata,
} from "uiwitness-core";

const source = createContractProposalSource({
  configuration,
  contract,
  evaluatedOn: "2026-09-03",
  executions,
  runDigest,
});
const proposal = createContractProposal(source, "0.26.3");
const metadata = emptyContractProposalMetadata(proposal);
const updated = applyContractProposal({
  acceptedOn: "2026-09-03",
  changeIds: ["expectation:home/success/desktop/light"],
  metadata,
  proposal,
  source,
});
```

`serializeContractProposalSource`, `serializeContractProposal`, and `serializeContractProposalMetadata` emit exact JCS bytes with one trailing newline. Their parse counterparts accept only those canonical bytes, validate bounded schema-v1 content, recompute embedded digests, reject duplicate or malformed change IDs, and return recursively frozen values. `contractProposalSourceDigest` and `contractProposalDigest` return the corresponding `sha256:<hex>` content identities.

Exception annotations never mutate proposal bytes. `emptyContractProposalMetadata` creates a proposal-bound overlay; `withContractProposalAnnotation` replaces one named annotation only after checking the proposal binding, that the operation can create or renew a failed expectation, non-empty owner/reason, real UTC dates, current validity, and a 1–30 day lifetime. `applyContractProposal` regenerates the proposal from its immutable source, rejects any difference or unknown metadata/selection, revalidates annotations against explicit `acceptedOn`, and applies only unique selected change IDs. It never derives intent from the fresh outcome and cannot produce an empty contract. Invalid proposal, overlay, or acceptance input throws `ContractProposalValidationError` with code `CONTRACT_PROPOSAL_INVALID` and immutable UIWitness-owned issues.

Filesystem containment, content-addressed filenames, current config/contract revalidation, writer locking, publication, and single-use consumption remain process-based CLI responsibilities.

## Generation manifests and committed markers

`UIWitnessGenerationManifest` remains the source-compatible browser-independent schema-v1 inventory. `UIWitnessGenerationManifestV2` adds the closed `evidence-manifest` role and requires exactly one immutable member at `.uiwitness/report/evidence-manifest.json`; `AnyUIWitnessGenerationManifest` covers both versions. Every version requires exactly one immutable report JSON member and one immutable report HTML member, binds the report digest, and may bind a semantic run digest plus sorted source-generation digests.

`UIWitnessEvidenceManifest` is canonical schema v1 at `.uiwitness/report/evidence-manifest.json`. It records retention, screenshot attempt/retained/omitted totals, successful mask IDs with cardinalities, the report digest, an optional verdict digest, and the semantic run digest (or report digest for an unguarded scan) as its generation identity. `parseEvidenceManifest` and `serializeEvidenceManifest` reject noncanonical or inconsistent data. Selectors and matched content are never represented.

`UIWitnessReport` remains the source-compatible schema-v1 type. `UIWitnessReportV1` is its explicit alias; `UIWitnessReportV2` models privacy-policy output, and `AnyUIWitnessReport` is the discriminated union for code that handles both versions.

```ts
import {
  generationManifestDigest,
  parseAnyGenerationManifest,
  parseCommittedGeneration,
} from "uiwitness-core";

const marker = parseCommittedGeneration(markerSource);
const manifest = parseAnyGenerationManifest(manifestSource);

if (generationManifestDigest(manifest) !== marker.manifestDigest) {
  throw new Error("Generation marker mismatch");
}
```

`parseGenerationManifest` and `serializeGenerationManifest` retain the schema-v1 source contract. `parsePrivacyGenerationManifest` and `serializePrivacyGenerationManifest` own schema v2, while `parseAnyGenerationManifest` is the dual-version reader used for committed generations. All variants require exact JCS bytes with one trailing newline, unique lexicographically ordered paths/digests, the normative 1,024-character path maximum, and recursively frozen values. `parseCommittedGeneration` additionally requires `.uiwitness/generations/<manifest-sha256>.manifest.json`, preventing a marker from redirecting validation to an unrelated path. Invalid input throws `GenerationValidationError` with code `GENERATION_INVALID`. The legacy and privacy schema/version/role constants publish each closed vocabulary without widening schema v1.

## Matrix planning

`expandMatrix(config, filter?)` expands a validated `UIWitnessConfig` into one `MatrixCell` for every configured `route x state x viewport x theme` combination. Each cell carries the route, state, named viewport, viewport dimensions, and theme that the runner needs.

Expansion follows routes and states in declaration order, viewport keys in deterministic ECMAScript property order, then themes in declaration order. Repeating the same validated input produces the same sequence. For normal named viewport IDs such as `mobile` and `desktop`, property order is declaration order; integer-like IDs are enumerated numerically before other keys. Filters do not change that order:

```ts
import { expandMatrix, parseConfig } from "uiwitness-core";

const cells = expandMatrix(parseConfig(config), {
  routeIds: ["dashboard"],
  stateIds: ["success", "error"],
  viewportIds: ["mobile"],
  themes: ["dark"],
});
```

`MatrixFilter` selections use exact, case-sensitive IDs. An omitted dimension selects all configured values; an empty selection or an unknown value selects no cells. Duplicate filter values never duplicate cells, and filter array order never reorders the configured matrix. Filtering is selection only: the CLI owns user-facing validation for unmatched flags.

The planner is pure and browser-independent. It does not load scenario modules, access the filesystem, create artifact paths, launch Playwright, or generate reports.

## Coverage calculations

`calculateCoverage(cells, observations)` calculates configured-state coverage without depending on runner or report contracts. The matrix is the source of truth for what was configured. Each `CoverageObservation` is a minimal exact coordinate plus a `passed` boolean:

```ts
import { calculateCoverage, expandMatrix } from "uiwitness-core";

const cells = expandMatrix(config);
const coverage = calculateCoverage(cells, [
  {
    passed: true,
    routeId: "dashboard",
    stateId: "success",
    viewportId: "mobile",
    theme: "light",
  },
]);

coverage.execution;
// { covered: 1, total: cells.length, percentage: ... }
```

Every metric is a `CoverageMetric` with an integer `covered` numerator, integer `total` denominator, and percentage from 0 through 100 rounded to at most two decimal places:

- Execution coverage counts passed execution cells out of unique configured cells.
- State coverage counts route/state pairs with at least one passed cell.
- Responsive coverage counts route/state pairs where every configured viewport has at least one passed cell across its configured themes.
- Theme coverage counts route/state pairs where every configured theme has at least one passed cell across its configured viewports.

Route/state pairs remain route-scoped, so the same state ID on two routes contributes two state denominators. Coverage is calculated against the supplied matrix, including a filtered matrix when a caller intentionally measures a selection.

Missing observations remain uncovered. Unknown or case-mismatched coordinates are ignored, so an unconfigured state can never inflate configured-state coverage. Duplicate configured coordinates are counted once. Duplicate observations pass only when every observation for that coordinate passed, making conflicts conservative and independent of input order. An empty matrix returns zero numerators, denominators, and percentages instead of `NaN`.

The calculator is pure, does not mutate its inputs, and returns immutable summary and metric objects. A later runner or result contract can project its records into `CoverageObservation`; coverage calculation does not define execution diagnostics, report serialization, Playwright behavior, or the report UI.

## Screenshot artifact paths

`screenshotArtifactPath(cell)` returns an opaque `ScreenshotArtifactPath`: the project-relative PNG path reserved for a `MatrixCell`:

```ts
import { screenshotArtifactPath } from "uiwitness-core";

const path = screenshotArtifactPath(cell);
// .uiwitness/artifacts/dashboard/success/desktop-light.png
```

The function is deterministic and pure: it does not inspect the clock, read directories, create files, or depend on the host path separator. Route and state IDs form directories; the viewport and theme form the PNG filename.

Filename identifiers use a fixed-width encoding for hyphens and other non-lowercase-alphanumeric characters. This keeps `desktop` + `wide-dark` distinct from `desktop-wide` + `dark`, and it protects against traversal if a caller forges a `MatrixCell` instead of using a validated configuration. Windows-reserved route and state basenames are encoded too. The resulting ASCII path stays stable under case folding and Unicode normalization.

Each encoded identifier has a 120-character budget. Longer identifiers retain a readable prefix and add a full SHA-256 digest, so directory components remain below common 255-byte limits and the combined viewport/theme filename remains at most 245 bytes including `.png`. Short encodings are reversible; long encodings are collision-resistant and intentionally opaque after the prefix.

Paths identify storage locations only. Later result contracts carry route, state, viewport, and theme metadata explicitly; consumers must not reconstruct metadata by parsing filenames. Directory creation and PNG writes remain runner responsibilities.

Plain strings are not assignable to `ScreenshotArtifactPath`. Code that reads a serialized path must validate it against report metadata and the expected cell rather than asserting the opaque type.

## Result and report contracts

`ExecutionResult` is the browser-independent persisted outcome for one matrix cell. It carries explicit route, state, viewport, theme, URL, scenario source, duration, status, screenshot, failure, and diagnostic data. Metadata is never reconstructed from a screenshot filename.

`parseExecutionResult(input)` strictly validates the internal schema-v1 writer record. Passed executions require a screenshot and cannot contain failures. Failed executions require at least one failure and may have a screenshot. Failure codes cover navigation, page, console, request, assertion, screenshot, mask selector/presence/cardinality/application, and internal failures.

Diagnostics contain console-error strings, page-error strings, optional navigation status, and failed requests with only `url`, `method`, and sanitized `errorText`. Strict validation rejects headers, cookies, request or response bodies, and every other unknown property. Parsing removes URL credentials and fragments and replaces every query value with `[REDACTED]` while preserving query keys. This applies to the project base URL, route path, execution URL, and failed-request URLs. The runner remains responsible for sanitizing every free-form diagnostic string before constructing a result.

When `screenshotPath` is present, parsing recomputes `screenshotArtifactPath` from the record's explicit coordinate and requires an exact match. The validated result therefore returns `ScreenshotArtifactPath | null` without trusting an arbitrary serialized string.

`UIWitnessReport` is the external JSON contract. Version 1 has this top-level shape:

```ts
interface UIWitnessReport {
  schemaVersion: 1;
  generatedAt: string;
  project: { baseURL: string };
  summary: ReportSummary;
  executions: readonly ExecutionResult[];
}
```

Use `REPORT_SCHEMA_VERSION` when constructing the default report and `parseReport(input)` for the source-compatible schema-v1 reader. Use `parseAnyReport(input)` at version-aware boundaries that accept privacy schema v2. `serializeReport(report)` validates either supported version before producing deterministic two-space-indented JSON with a trailing newline; it does not read the clock or filesystem.

`REPORT_SCHEMA_VERSION` remains `1` for default `all` retention. `PRIVACY_REPORT_SCHEMA_VERSION` is `2`; it replaces `screenshotPath` with `screenshot: { status, path? }` and includes the non-default retention policy. The version-aware reader accepts both versions. Schema v2 requires all `none` screenshots to be `omitted-by-policy`; `failures-only` requires passing cells to be omitted and failed cells to be either captured or explicitly capture-failed.

Report validation rejects unsupported versions, malformed RFC 3339 generation times, unknown properties, duplicate execution coordinates, conflicting route/state/viewport metadata, inconsistent counts or duration, and coverage that differs from `calculateCoverage` over the execution records. Empty execution selections remain representable with zero-valued summary and coverage metrics.

`ResultValidationError` and `ReportValidationError` use the stable `RESULT_INVALID` and `REPORT_INVALID` error codes. Their immutable issue arrays use the same UIWitness-owned issue categories and deterministic `$` paths as configuration validation. The underlying Zod schemas remain private.

## Exported types

- `UIWitnessConfig`
- `UIWitnessContract`, `ContractCoordinate`, `ContractExpectation`, `ContractException`, and `ContractFailureCode`
- `CompareContractOptions`, `ContractConfigurationCoordinate`, and `ContractExecutionObservation`
- `ContractComparisonResult`, `ContractVerdictStatus`, `ContractFinding`, `ContractFindingKind`, `ContractActualOutcome`, and `ContractRunErrorReason`
- `RunErrorContractFinding`, `UnacceptedAdditionContractFinding`, `MissingCoordinateContractFinding`, `UnacceptedConfigDriftContractFinding`, `ExpiredExceptionContractFinding`, `RegressionContractFinding`, `ChangedKnownFailureContractFinding`, `RecoveredKnownFailureContractFinding`, `KnownFailureContractFinding`, and `MatchedContractFinding`
- `ContractProposal`, `ContractProposalChange`, `ContractProposalMetadata`, `ContractProposalOperation`, `ContractProposalSource`, `ContractSourceDigest`, `ContractSourceExecution`, and `ProposedExpectation`
- `JsonValue` and `Sha256Digest`
- `ViewportDefinition`
- `RouteDefinition`
- `StateDefinition`
- `FailurePolicy`
- `EvidenceConfig`, `EvidenceMaskConfig`, `UIWitnessEvidenceManifest`, and `EvidenceManifestMask`
- `MatrixCell` and `MatrixFilter`
- `CoverageObservation`, `CoverageMetric`, and `CoverageSummary`
- `ScreenshotArtifactPath`
- `ExecutionResult`, `ExecutionStatus`, `ExecutionFailure`, `ExecutionFailureCode`, `ExecutionDiagnostics`, and `FailedRequestDiagnostic`
- `UIWitnessReport`, `UIWitnessReportV1`, `UIWitnessReportV2`, `AnyUIWitnessReport`, report execution/screenshot variants, and `ReportSummary`
- `UIWitnessErrorCode`
- `CanonicalJsonIssue`, `ContractValidationIssue`, `ConfigValidationIssue`, `ResultValidationIssue`, `ReportValidationIssue`, `ContractValidationIssueCode`, and `ConfigValidationIssueCode`

Exported functions additionally include `parseEvidenceManifest` and `serializeEvidenceManifest`. Exported constants additionally include `EVIDENCE_MANIFEST_PATH`, `EVIDENCE_MANIFEST_SCHEMA_VERSION`, and `PRIVACY_REPORT_SCHEMA_VERSION`; the existing browser-independent contract, proposal, generation, matrix, coverage, result, and report exports remain public.
