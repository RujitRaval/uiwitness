# uiwitness-core

Browser-independent UIWitness contracts for configuration and evidence-policy validation, state-contract parsing, canonical digests, deterministic comparison and verdicts, immutable proposals and named acceptance, committed-generation and evidence manifests, matrix expansion and artifact paths, coverage calculations, and schema-v1/v2 report parsing.

```ts
import {
  canonicalizeContract,
  compareContract,
  contractConfigDigest,
  contractDigest,
  contractExceptionLifecycle,
  createContractProposal,
  createContractProposalSource,
  defineConfig,
  expandMatrix,
  generationManifestDigest,
  parseAnyGenerationManifest,
  parseAnyReport,
  parseCommittedGeneration,
  parseContract,
  parseGenerationManifest,
  parseReport,
  validateAuthenticationStorageState,
} from "uiwitness-core";
```

`contractExceptionLifecycle(exception, evaluatedOn)` returns the deterministic active or expired state and signed days until expiry using the same UTC calendar boundary as contract comparison.

`parseConfig` accepts strict shared-read-only authentication boundaries. `validateAuthenticationStorageState` enforces their exact local-storage origin and cookie domain/path/secure/partition scope without exposing secret values in errors.

New writer paths are restricted to `.uiwitness/artifacts/**`. `parseReport` keeps schema version 1 source-compatible with both `.uiwitness/artifacts/**` and legacy `.statecraft/artifacts/**` screenshot references; `parseAnyReport` is the version-aware v1/v2 reader. `parseGenerationManifest` likewise preserves schema v1, while `parseAnyGenerationManifest` reads committed schema-v1/v2 generations. The public `ScreenshotArtifactPath` type is writer-only, while `ReportScreenshotArtifactPath` and `ReportExecutionResult` represent the two-root read contract.

Most users should install [`uiwitness`](https://www.npmjs.com/package/uiwitness). Use this package directly when building integrations around UIWitness's stable core contracts.

See the [core API documentation](https://github.com/RujitRaval/uiwitness/blob/main/docs/engineering/CORE_API.md).
