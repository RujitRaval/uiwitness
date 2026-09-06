# `uiwitness-runner-playwright` API

`uiwitness-runner-playwright` owns UIWitness's published browser-specific execution boundary while `uiwitness-core` remains independent of Playwright. Most users install `uiwitness`; direct consumers can compose the programmatic runner APIs documented here.

## Install the pinned browser

After installing workspace dependencies, install the Chromium build paired with the pinned Playwright version:

```bash
corepack pnpm --filter uiwitness-runner-playwright exec playwright install chromium
```

CI uses the same command with `--with-deps` on Ubuntu.

## Public URL route discovery

`discoverPublicRoutes(url, options?)` discovers a small public route surface without requiring a UIWitness configuration. The CLI composes it with `runPublicSiteChecks` through `uiwitness check <url>` and can preserve the accepted surface through explicit overwrite-safe `--write-config` promotion.

```ts
import { discoverPublicRoutes } from "uiwitness-runner-playwright";

const discovery = await discoverPublicRoutes("https://example.com/start", {
  maxPages: 5,
});

discovery.baseURL;
discovery.routes;
discovery.attemptedPages;
```

The function accepts one absolute HTTP(S) URL without credentials. It removes the supplied query and fragment before the first request. `maxPages` defaults to 5 and accepts integers from 1 through 20; navigation and readiness timeouts default to 30 and 10 seconds. Invalid inputs reject before Chromium launches.

Discovery:

1. Launches one Chromium process and creates a fresh browser context for every attempted page.
2. Lets the initial redirect establish the canonical origin, then stays on that origin.
3. Traverses at most the first 1,000 rendered anchors from each ready HTML page without materializing the complete anchor set, and ignores candidate URLs longer than 8,192 characters.
4. Removes query strings and fragments, ignores downloads and common non-document resources, and visits unique paths sequentially in first-seen breadth-first order.
5. Counts every navigation attempt against `maxPages`, including failed and skipped pages.

An initial navigation or readiness failure, missing HTTP response, or non-HTML document rejects with a sanitized `PublicRouteDiscoveryError`. An initial HTML response is accepted regardless of HTTP status so a later check can report the status. For subsequent candidates, a navigation/readiness failure keeps the requested same-origin path as a leaf; a non-HTML response or cross-origin redirect is skipped. A redirected external destination may receive its ordinary GET before Playwright exposes the final URL, but UIWitness extracts and follows no links from it.

`PublicRouteDiscoveryError.code` is one of:

- `initial-navigation-failed`
- `initial-response-missing`
- `initial-response-not-html`

The immutable result contains:

- `baseURL`: the canonical origin with a trailing slash.
- `routes`: accepted pathnames in deterministic first-seen order.
- `attemptedPages`: all attempted navigations, including the starting page.
- `skippedPages`: later cross-origin or non-HTML pages.
- `truncatedAnchorPages`: pages whose rendered anchor count exceeded 1,000.

This is navigation-only discovery. Loading a public page executes its scripts and ordinary requests, so callers should use it only on sites they own or are authorized to test. It does not click controls, submit forms, retain cross-page cookies or storage, or claim coverage of application states.

See [ADR 0029](../decisions/0029-public-url-route-discovery.md) for the discovery boundary and redirect rationale.

## Public-site checks

`runPublicSiteChecks(discovery, options?)` turns a `PublicRouteDiscovery` into persisted Quick Check evidence without a project config or temporary scenario module:

```ts
import {
  discoverPublicRoutes,
  runPublicSiteChecks,
} from "uiwitness-runner-playwright";

const discovery = await discoverPublicRoutes("https://example.com");
const run = await runPublicSiteChecks(discovery, {
  projectDirectory: process.cwd(),
});

run.report.summary;
run.reportPath;
run.htmlReportPath;
```

Every accepted route expands in discovery order into one `public` state and four deterministic cells:

1. mobile `390x844`, light;
2. mobile `390x844`, dark;
3. desktop `1440x900`, light;
4. desktop `1440x900`, dark.

Light and dark are browser-native `prefers-color-scheme` preferences; Quick Check does not invent application selectors. Route IDs retain a readable pathname slug and add a stable 12-hex SHA-256 suffix so similar slugs cannot overwrite one another's artifacts.

The trusted `publicSiteScenario` fails on a final main-document HTTP status of 400 or higher and on document-level horizontal overflow greater than `PUBLIC_SITE_OVERFLOW_TOLERANCE_PX` (one CSS pixel). The existing capture policy fails uncaught page errors and navigation failures. Console errors and subordinate request failures are retained as sanitized warnings and never fail this workflow. The screenshot is taken before assertions, so HTTP, overflow, and page-error failures keep visual evidence when capture itself succeeds. A main-frame navigation guard remains active through screenshot and assertion completion; any replacement document discards the PNG and fails the cell instead of allowing mismatched URL and pixel evidence.

The result uses the existing schema-v1 JSON and self-contained HTML report under `.uiwitness/`. Output remains private local evidence. Callers must check only sites they own or are authorized to test because normal page loads execute the site's JavaScript and requests.

The runner's navigated, captured, and persisted option shapes also accept a trusted in-memory `scenario` override for programmatic orchestration. When supplied, it is runtime-validated once and used for every cell instead of importing each state's `setup` path. The exported `publicSiteScenario` is the default export behind the generated trusted local scenario module, so promoted configured scans reuse the exact same assertions instead of copying them.

`uiwitness-runner-playwright/public-site-contract` is a lightweight export containing the frozen Quick Check viewports, themes, and diagnostic failure policy. The runner and CLI config generator share it so a promoted scan reproduces the same fixed matrix without importing Playwright at setup-render time.

See [ADR 0030](../decisions/0030-public-site-check-evidence.md) for the fixed matrix, assertion precision, and evidence decisions.

## Programmatic lifecycle

`runExecutionCells(cells, execute, options?)` accepts matrix cells from `expandMatrix` and invokes the callback once for every cell in configured order.

```ts
import { expandMatrix, parseConfig } from "uiwitness-core";
import { runExecutionCells } from "uiwitness-runner-playwright";

const config = parseConfig(unknownConfig);
const cells = expandMatrix(config);

const outcomes = await runExecutionCells(cells, async ({ cell, context, page }) => {
  // Phase 3 follow-up steps will load scenarios and navigate here.
  return { routeId: cell.route.id, pageCount: context.pages().length, url: page.url() };
});
```

One headless Chromium browser is launched for a non-empty call and reused while context cleanup remains healthy. Each callback receives a fresh Playwright `BrowserContext` and `Page`; the context viewport comes from the matrix cell. The context is closed before the next cell begins, including when the callback rejects. If context cleanup fails, that cell is rejected and the compromised browser is closed and replaced before the next cell starts.

The returned immutable array preserves cell order. Each `CellExecutionOutcome<Value>` is either:

- `{ cell, status: "fulfilled", value }` when the callback and context cleanup succeed.
- `{ cell, status: "rejected", reason }` when context creation, the callback, or cleanup fails.

A rejected cell does not abort later cells. Initial or replacement browser launch and browser cleanup failures reject the run because no remaining cell can execute safely. An empty cell list returns an empty immutable array without launching Chromium.

## Memory-only authentication

Every navigated, captured, and persisted runner option can carry `authentication: RunAuthenticationOptions`. `config` is the parsed core `AuthenticationConfig`; `baseURL` identifies the application origin; and `setupBaseDirectory` resolves its trusted local module.

```ts
import { expandMatrix, parseConfig } from "uiwitness-core";
import { runPersistedScenarioCells } from "uiwitness-runner-playwright";

const config = parseConfig(unknownConfig);
const cells = expandMatrix(config);
const run = await runPersistedScenarioCells(cells, {
  ...(config.authentication === undefined ? {} : {
    authentication: {
      baseURL: config.baseURL,
      config: config.authentication,
      setupBaseDirectory: process.cwd(),
    },
  }),
  baseURL: config.baseURL,
  projectDirectory: process.cwd(),
});
```

The setup module default-exports `AuthSetup = ({ context, page }) => Promise<void>`. It runs exactly once in a dedicated context, reads user-controlled secrets itself, and must return `undefined`. The runner calls `context.storageState()` without a path, validates it through the core origin/cookie policy, closes the setup context, and provides a deep copy to each fresh cell context. Cell mutations never flow into another cell. A browser replacement after unsafe cell cleanup reuses only that already validated in-memory snapshot; login does not repeat.

Module/import/shape/return failures use `AUTH_SETUP_INVALID`; hook, storage-state, or setup-context cleanup failures use `AUTH_SETUP_FAILED`; scope violations use `AUTH_ORIGIN_NOT_ALLOWED` or `AUTH_COOKIE_NOT_ALLOWED`. `AuthenticationError` exposes only the stable code and configured module path, discarding raw thrown values. The runner retains no UIWitness-owned auth file, report field, log record, or cleanup artifact and drops its last state reference with the completed run. Trusted modules can still read, print, transmit, or throw secrets and remain outside this guarantee.

`shared-readonly` is an operator assertion that all cells may safely use one non-mutating account. Multiple roles, stored state, and authenticated sharding are not supported.

`RunExecutionCellsOptions.launchOptions` exposes Playwright's launch settings directly. This keeps the API small and supports headed orchestration later without wrapping Playwright.

## Typed scenarios and hooks

`runScenarioCells(cells, execute, options?)` layers typed local scenario loading onto the isolated cell lifecycle. Each state's `setup` path is resolved relative to `options.scenarioBaseDirectory`; programmatic callers that omit it use `process.cwd()`.

```ts
import { expandMatrix, parseConfig } from "uiwitness-core";
import { runScenarioCells } from "uiwitness-runner-playwright";

const cells = expandMatrix(parseConfig(unknownConfig));
const outcomes = await runScenarioCells(
  cells,
  async ({ page, route, state, viewport, theme }) => {
    // Low-level callers may continue to own the middle lifecycle step.
    await page.goto(new URL(route.path, "http://127.0.0.1:3000").href);
    return { stateId: state.id, theme, width: viewport.width };
  },
  { scenarioBaseDirectory: process.cwd() },
);
```

A scenario is trusted local ESM code with an object default export:

```ts
import type { UIWitnessScenario } from "uiwitness-runner-playwright";

const scenario: UIWitnessScenario = {
  async beforeNavigate({ page }) {
    await page.route("**/api/dashboard", async (route) => {
      await route.fulfill({ json: { projects: [] } });
    });
  },
  async afterNavigate({ page }) {
    await page.getByRole("main").waitFor();
  },
};

export default scenario;
```

The runner runtime-checks the default export and the optional `beforeNavigate`, `afterNavigate`, and reserved `assert` fields. For each cell it runs `beforeNavigate`, the caller's middle step, and `afterNavigate` in order with one frozen `ScenarioContext`. After built-in navigation and screenshot capture, `assert` receives an `AssertionScenarioContext` that adds final `navigation` metadata. A module-load, validation, or hook failure rejects only that cell; cleanup still runs and later cells continue. `ScenarioLoadError` distinguishes `module-load-failed` from `invalid-module` failures.

`loadScenario(path, options?)` and `runScenarioLifecycle(scenario, context, execute)` expose the two smaller primitives for orchestration and focused testing. Dynamic imports follow normal Node ESM caching semantics. Scenario/config modules are trusted local code with the user's privileges and are not sandboxed.

## Built-in navigation, themes, and readiness

`runNavigatedScenarioCells(cells, execute, options)` owns the normal Phase 3 path through theme setup, hooks, navigation, and deterministic readiness. Its callback runs after readiness, which gives the following screenshot/diagnostics slice a stable capture seam without changing lifecycle order.

```ts
import { expandMatrix, parseConfig } from "uiwitness-core";
import { runNavigatedScenarioCells } from "uiwitness-runner-playwright";

const config = parseConfig(unknownConfig);
const outcomes = await runNavigatedScenarioCells(
  expandMatrix(config),
  async ({ navigation, page, state, theme }) => ({
    stateId: state.id,
    status: navigation.status,
    theme,
    title: await page.title(),
    url: navigation.url,
  }),
  {
    baseURL: config.baseURL,
    readiness: { selector: "main[data-ready]", timeoutMs: 10_000 },
    scenarioBaseDirectory: process.cwd(),
  },
);
```

The order for every cell is:

1. Validate that the configured route stays on the base URL's origin and load its scenario.
2. Apply the theme before application scripts: every theme becomes `data-theme` on `<html>`; `light` and `dark` also set the matching `prefers-color-scheme`; all themes request `prefers-reduced-motion: reduce`.
3. Run `beforeNavigate`, then navigate with `waitUntil: "domcontentloaded"`.
4. Run `afterNavigate`, which remains the scenario-controlled readiness escape hatch.
5. Suppress CSS animations, transitions, smooth scrolling, and carets; wait for the normal load event, an optional visible selector, and `document.fonts` to finish loading. Reject main-frame document navigation that starts during these gates.
6. Recheck the origin, then invoke the post-readiness callback with a frozen `NavigatedScenarioContext` and frozen `NavigationMetadata` containing the requested URL, final same-origin page URL, and the built-in navigation's HTTP response status when available.

The origin boundary is checked after built-in navigation, after `afterNavigate`, and after readiness; cross-origin redirects and hook-driven navigation reject the cell before caller-owned work. Same-origin hook navigation that completes in `afterNavigate` remains supported: `navigation.url` reports the final page while `navigation.status` reports the response to `navigation.requestedUrl`. Once deterministic readiness starts, any new main-frame document navigation is rejected because the replacement document has not passed the readiness gates. The runner never waits for `networkidle`, so persistent connections cannot stall a cell. Navigation defaults to 30 seconds; readiness defaults to 10 seconds. Both accept positive safe-integer overrides. Invalid run-level options reject before Chromium starts. Scenario, hook, route, navigation, readiness, and post-readiness callback failures reject only their cell; context cleanup still runs and later cells continue.

Arbitrary theme IDs are intentionally supported through `data-theme`; only the conventional `light` and `dark` IDs affect color-scheme media queries. Apps with different theme mechanisms can use direct Playwright access in `beforeNavigate`.

## In-memory screenshots, diagnostics, and assertions

`runCapturedScenarioCells(cells, options)` owns the complete capture lifecycle through assertion and diagnostic failure policy. It returns settled cell outcomes and deliberately has no output-directory or artifact-path option. `RunCapturedScenarioCellsOptions` preserves the default/`all` contract whose fulfilled cells always contain PNG bytes; `PrivacyRunCapturedScenarioCellsOptions` requires `failures-only` or `none` and returns `CompletedScenarioCell`, whose fulfilled result may explicitly omit bytes.

```ts
import { expandMatrix, parseConfig } from "uiwitness-core";
import {
  runCapturedScenarioCells,
  ScenarioCaptureError,
} from "uiwitness-runner-playwright";

const config = parseConfig(unknownConfig);
const outcomes = await runCapturedScenarioCells(expandMatrix(config), {
  baseURL: config.baseURL,
  failOn: config.failOn,
  readiness: { selector: "main[data-ready]" },
  scenarioBaseDirectory: process.cwd(),
});

for (const outcome of outcomes) {
  if (outcome.status === "fulfilled") {
    const { screenshot, diagnostics, assertionStatus, durationMs } = outcome.value;
    // Persisting screenshot bytes and constructing ExecutionResult come next.
    void screenshot;
    void diagnostics;
    void assertionStatus;
    void durationMs;
  } else if (outcome.reason instanceof ScenarioCaptureError) {
    // Partial evidence retains diagnostics and any screenshot captured before failure.
    console.error(outcome.reason.failures, outcome.reason.evidence);
  }
}
```

For every cell, duration starts before browser-context creation and diagnostic listeners attach before route validation, scenario loading, theme setup, and hooks. After navigation and deterministic readiness, the runner captures a viewport-sized PNG into an owned `Uint8Array`, runs the optional scenario `assert` hook, evaluates diagnostic failure policy, detaches its listeners, and closes the isolated context. Screenshots therefore represent the ready product state before assertion code can mutate it. An absent assertion produces `assertionStatus: "not-configured"`; a successful one produces `"passed"`.

Diagnostics use the browser-independent core shape:

- `consoleErrors`: sanitized text from Playwright console messages whose type is `error`.
- `pageErrors`: sanitized messages from uncaught page exceptions.
- `failedRequests`: HTTP(S) URL, method, and sanitized Playwright failure text only.
- `navigationStatus`: the built-in navigation response status when available.

The runner never reads diagnostic request/response headers, cookies, bodies, or console argument handles. It removes URL credentials and fragments, preserves query keys while replacing values with `[REDACTED]`, redacts authorization, cookie, bearer, and named-secret forms in free-form messages, pre-bounds and caps each diagnostic string at 2,000 characters, and bounds sanitized URLs. Each category retains its first 100 entries; `droppedDiagnostics` reports how many later entries were omitted. This is defense in depth, not a guarantee against novel secrets embedded by application code; captures remain sensitive local data. `ScenarioCaptureError.cause` is a new sanitized error rather than the original throwable so logging the structured error cannot bypass this boundary.

`failOn` uses the core `FailurePolicy`. Defaults are `{ consoleError: false, failedRequest: false, pageError: true }`. Enabled categories generate `CONSOLE_ERROR`, `FAILED_REQUEST`, or `PAGE_ERROR` failures. Screenshot and assertion failures are always fatal and generate `SCREENSHOT_FAILED` and `ASSERTION_FAILED`. Mask resolution/application adds `MASK_SELECTOR_INVALID`, `MASK_REQUIRED_MISSING`, `MASK_CARDINALITY_MISMATCH`, and `MASK_APPLY_FAILED`; a masked failure never retries unmasked. The runner marks the exact validated DOM nodes, captures through those stable markers, then re-evaluates the original selector and requires its complete current match set to be exactly the marked nodes before retaining bytes. Additions, removals, or substitutions discard the screenshot. Multiple failures are retained deterministically. `ScenarioCaptureError` exposes those stable failures plus `ScenarioCaptureEvidence`, including only successfully captured non-secret mask IDs/cardinalities, attempt state, explicit screenshot state, and nullable bytes/navigation. Route and browser lifecycle failures use `NAVIGATION_FAILED`; scenario module loading/validation uses `INTERNAL_ERROR`.

## Result translation and local persistence

`runPersistedScenarioCells(cells, options)` is the complete programmatic entry point. `options.evidence` carries the parsed mask/retention policy. `all` writes schema-v1 report records and every successful screenshot. `failures-only` captures before assertions, retains only failed-cell bytes, and writes schema v2. `none` performs no screenshot or DOM mask resolution and also writes schema v2. All modes publish the report, HTML, retained screenshots, and canonical evidence manifest in one recovery transaction.

```ts
import { expandMatrix, parseConfig } from "uiwitness-core";
import { runPersistedScenarioCells } from "uiwitness-runner-playwright";

const config = parseConfig(unknownConfig);
const run = await runPersistedScenarioCells(expandMatrix(config), {
  baseURL: config.baseURL,
  failOn: config.failOn,
  projectDirectory: process.cwd(),
  readiness: { selector: "main[data-ready]" },
  scenarioBaseDirectory: process.cwd(),
});

run.reportPath;
// .uiwitness/report/uiwitness.json
run.generation.manifestPath;
// .uiwitness/generations/<sha256>.manifest.json
run.report.summary.coverage.execution;
```

The project directory must already exist and defaults to `process.cwd()`. Cells must come from the validated core configuration/matrix boundary; malformed hand-built cells reject the run before Chromium launches. `generatedAt` optionally accepts a valid `Date` for deterministic callers and tests; normal runs record completion time. The returned `PersistedScenarioRun` contains the validated report, fixed project-relative JSON and HTML paths, and its committed-generation marker. It does not retain screenshot bytes after publication.

Each successful capture becomes a passed execution with its deterministic `screenshotArtifactPath(cell)`. A rejected `ScenarioCaptureError` becomes a failed execution with the same stable failures, diagnostics, duration, safe URL metadata, and a screenshot path when capture completed before the later failure. Unexpected context or cleanup failures become sanitized `INTERNAL_ERROR` results without screenshots. Result parsing redacts route, execution, failed-request, and project URL credentials, fragments, and query values before anything reaches disk.

Publication uses a private staging directory and local run lock inside `.uiwitness/`. The lock keeps an immutable process owner plus append-only publishing, committed, and recovery markers and is acquired before Chromium launches, so two programmatic runs cannot interleave capture and publication for one project. An abandoned capture lock discards only uncommitted staging. Before destructive publication, the runner writes and fsyncs a bounded journal that identifies every final sidecar destination. A later writer can claim an abandoned publishing lock and infer completed renames from the journal and staging tree: it restores the prior generation before the stable marker swap, keeps the new generation after that commit point, and finishes cleanup for an explicit committed phase. Missing, malformed, unsafe, ambiguous, or incompletely recoverable state remains preserved and fail-closed.

`finalizeGeneration(report)` is an optional browser-neutral hook called exactly once after the complete report is validated and while the run lock is still held. The source-compatible `GenerationFinalizer` receives schema v1; `PrivacyGenerationFinalizer` receives schema v2 for non-default retention. Either may return typed `GenerationSidecarArtifact` values for contract verdict/source/proposal/metadata or an explicit JSON copy, plus semantic run/source digests and tool version. The runner snapshots the returned objects, digest arrays, and mutable byte buffers synchronously before persistence yields, then validates canonical verdict/copy JSON and exact copy equality. A proposal family must contain one schema-valid source, proposal, and mutable metadata overlay whose canonical bytes, content-addressed paths, tool/source/proposal digests, and immutable publication modes agree. Publication modes are `replace`, `exclusive`, and content-checked `immutable`; exclusive and newly created immutable targets use an atomic no-clobber link at the final publication boundary. Paths are limited to 1,024 characters, must be canonical, nonconflicting project-relative paths, and cannot occupy or descend from runner report, artifact, manifest, marker, lock, staging, or contract-lock control locations.

The runner digests staged bytes, validates generation-manifest schema v2 with one canonical immutable evidence-manifest member, and then swaps screenshots, report JSON, sidecars, manifest, HTML, and the stable `.uiwitness/generation.json` commit point with rollback bookkeeping and directory fsyncs. The recovery journal records the expected marker digest; recovery keeps a new generation only after validating that exact canonical marker and its referenced digest-bound manifest. HTML is visible last among report content; the marker is visible last overall. Rollback hides the marker first and restores it only after the previous files and HTML are coherent, fsyncing both source and destination parents after each mutation. Symbolic links, unexpected hard links, unsafe types, changed immutable bytes, and no-clobber collisions are rejected. New runner files/directories use owner-only modes where supported; existing caller-owned parent permissions are preserved. Filesystem validation, locking, and publication errors reject the run instead of fabricating per-cell browser failures.

`withGenerationTransactionLock(projectDirectory, action)` serializes a non-run local mutation with all runner generation publication. Contract acceptance uses it only after taking the CLI contract lock, matching guard and initialization lock order and preventing a committed marker or proposal family from changing between acceptance validation and contract commit.

This API does not discover configuration, print terminal output, choose exit codes, or open a report. It delegates browser-independent HTML rendering to `uiwitness-report` so all generated output can share one publication transaction.

## Current boundary

Phase 3 and State Contract Guard T5/T9/T10 are complete. The runner owns browser reuse, per-cell isolation, once-per-run memory-only authentication, scenarios/hooks, viewport/theme, navigation/readiness, fail-closed masked screenshot capture, retention, sanitized diagnostics, assertions, failure policies, core result translation, and crash-recoverable generation persistence. The CLI consumes this API through `scan`, `check`, and `guard`; the report package remains a pure validated v1/v2 renderer, and contract comparison remains core-owned.

## Dependency decision

Playwright `1.62.1` is an exact runtime dependency because the runner exposes its `Page`, `BrowserContext`, and `LaunchOptions` types and must stay paired with its browser protocol and Chromium build. The runner also depends on browser-independent `uiwitness-report` for deterministic HTML rendering. Core uses pinned `tldts` only for browser-neutral Public Suffix List validation; no browser dependency enters `uiwitness-core` or the report package.
