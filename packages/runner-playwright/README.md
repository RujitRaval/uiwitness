# uiwitness-runner-playwright

The Playwright execution engine for UIWitness: isolated browser contexts, typed scenario hooks, deterministic navigation/readiness, screenshots, sanitized diagnostics, assertions, crash-recoverable local generation persistence, and bounded public-route discovery.

```ts
import { discoverPublicRoutes } from "uiwitness-runner-playwright";

const publicSurface = await discoverPublicRoutes("https://example.com");
```

```ts
import { runPublicSiteChecks } from "uiwitness-runner-playwright";

const evidence = await runPublicSiteChecks(publicSurface);
console.log(evidence.htmlReportPath);
```

```ts
import type { AuthSetup, UIWitnessScenario } from "uiwitness-runner-playwright";
```

This fixed public-site check runs mobile/desktop by light/dark, fails only high-confidence navigation, HTTP, uncaught-page-error, and horizontal-overflow boundaries, and commits screenshots, schema-v1 JSON, offline HTML, and a digest-bound generation marker under the ignored local `.uiwitness/` directory. Check only sites you own or are authorized to test.

Configured runs support fail-closed named masks and `all`, `failures-only`, or `none` screenshot retention. Exact matched DOM nodes receive temporary stable markers, and a post-capture re-evaluation rejects additions, removals, or substitutions instead of risking an unmasked artifact. Mask failures never retry unmasked; privacy policies emit explicit schema-v2 screenshot outcomes and every run commits a selector-free evidence manifest inside generation-manifest schema v2.

Configured runs may execute one trusted `AuthSetup` per complete run and seed each fresh cell context from a validated in-memory storage-state copy. No UIWitness-owned auth file is created; only the application origin and explicit cookie/origin scopes are allowed. The single supported mode is shared read-only.

Persistence owns only the `.uiwitness/` transaction tree and does not open or modify legacy `.statecraft/` evidence. Private modes, control-path and link checks, shared generation locking, authenticated process-death recovery, and coherent rollback apply to every committed member.

Most users should install [`uiwitness`](https://www.npmjs.com/package/uiwitness). Use this package directly when composing the programmatic runner API.

See the [runner API documentation](https://github.com/RujitRaval/uiwitness/blob/main/docs/engineering/RUNNER_API.md).
