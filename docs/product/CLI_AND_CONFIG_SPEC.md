# CLI and Configuration Specification

## Commands
### `uiwitness init`
Create starter config/scenario directory; never silently overwrite; print exact next steps.

The starter is intentionally small:

```text
uiwitness.config.mts
uiwitness/
  scenarios/
    home/
      success.mts
```

Existing target files cause a setup error. There is no force flag.

### `uiwitness check <url>`
Discover a bounded public surface, execute a fixed responsive/theme matrix, persist evidence, and print a page-level verdict without requiring config.

```bash
uiwitness check https://example.com
uiwitness check https://example.com --max-pages 12
uiwitness check https://example.com --headed
uiwitness check https://example.com --write-config
```

The URL must be absolute HTTP(S) and contain no credentials. Discovery removes its query and fragment, follows same-origin HTML pages in deterministic first-seen order, attempts at most five pages by default, and accepts an explicit integer budget from 1 through 20. Each accepted page receives exactly four checks: mobile `390x844` light/dark and desktop `1440x900` light/dark. HTTP errors, missing main-document responses, uncaught page errors, and horizontal overflow greater than one CSS pixel fail a cell; sanitized console and subordinate-request diagnostics remain warning evidence.

The summary reports canonical site, discovered/scanned/skipped counts, per-page failures, issue totals, coverage, and `.uiwitness/report/index.html`. It prints no raw diagnostic payloads. Without `--write-config`, it prints the exact command that promotes the canonical discovered surface. With `--write-config`, it preflights every supported config and generated path before browser work, persists evidence, then exclusively publishes the shared scenario and config-last entrypoint. A completed all-pass check exits `0`; a completed check with failed cells exits `1`; invalid usage, discovery failure, setup conflict/write failure, or a run-level failure exits `2`.

### `uiwitness scan`
Validate config, optionally filter, execute matrix, write artifacts/report, print summary, return stable exit code.
```bash
uiwitness scan
uiwitness scan --config ./uiwitness.config.mts
uiwitness scan --route dashboard
uiwitness scan --coordinate dashboard/success/desktop/light --headed
uiwitness scan --headed
```

`--route` matches one configured route ID exactly and rejects an unknown ID before creating output. `--coordinate` is the atomic `route/state/viewport/theme` selector used by guard reproduction commands; it must resolve to exactly one configured cell and cannot be combined with `--route`. Scenario paths resolve from the selected config's directory, while `.uiwitness/` belongs to the invocation working directory. The summary groups executions by route and prints `.uiwitness/report/index.html`. Default `all` retention writes schema-v1 JSON; non-default privacy policies write schema v2 with explicit screenshot outcomes.

Private applications may declare one `authentication` block with a trusted local `setup` module and the optional `shared-readonly` mode. The module runs once per complete scan, reads its own environment or secret-manager inputs, and returns no state. UIWitness validates Playwright's memory-only storage state and deep-copies it into every otherwise-fresh cell context. The setup file must stay beneath the invocation workspace through regular, non-linked boundaries. Origin or cookie scope violations and opaque setup failures exit `2` before any product cell is created.

`evidence.retention` is `all` (default), `failures-only`, or `none`. `evidence.masks` declares non-secret IDs and CSS selectors with optional exact `routeIds`, `stateIds`, `count`, and `required` (default `true`). Applicable masks bind to the exact resolved nodes before capture; post-capture identity/cardinality drift or any other unsafe resolution/application failure discards bytes and blocks the cell without unmasked fallback. `none` performs no selector lookup. Every completed run writes a selector-free evidence manifest beside the report.

```ts
authentication: {
  setup: "./uiwitness/auth.mjs",
  mode: "shared-readonly",
  additionalOrigins: ["https://id.example.com"],
  cookieScopes: [{
    domain: ".example.com",
    pathPrefix: "/",
    secure: "required",
    partitionKeys: ["https://app.example.com"],
  }],
}
```

```js
export default async function authenticate({ page }) {
  const email = process.env.UIWITNESS_LOGIN_EMAIL;
  const password = process.env.UIWITNESS_LOGIN_PASSWORD;
  if (email === undefined || password === undefined) {
    throw new Error("Required authentication environment is unavailable.");
  }
  await page.goto("https://app.example.com/login");
  await page.getByLabel("Email").fill(email);
  await page.getByLabel("Password").fill(password);
  await page.getByRole("button", { name: "Sign in" }).click();
  await page.waitForURL("https://app.example.com/");
}
```

Setup and scenario modules are trusted arbitrary local code, not sandboxes. They can print or transmit anything they read. UIWitness's enforceable guarantee is narrower: its own state validation, errors, reports, verdicts, fingerprints, and files never serialize credentials, cookies, local storage, headers, or setup return values.

### `uiwitness guard`
Run the entire configured matrix once and compare only that fresh in-memory result with a committed state contract.

```bash
uiwitness guard
uiwitness guard --config ./uiwitness.config.mts
uiwitness guard --contract ./contracts/release.json
uiwitness guard --json ./artifacts/contract-verdict.json
```

Guard treats the invocation directory as its workspace and never searches a parent. Config, contract, scenario, and explicit JSON paths must remain beneath that canonical workspace through regular, non-symbolic-link boundaries. The default contract is `uiwitness.contract.json`. The contract schema and comparison truth table are documented in the [core API](../engineering/CORE_API.md).

After validating every input and output boundary, guard runs the complete unfiltered matrix in normal headless mode. It never compares an earlier report. The deterministic machine verdict is written to `.uiwitness/contract-verdict.json`; `--json` requests an additional contained copy and refuses to replace an existing path. Executable regressions, changed known failures, and recovered known failures include an exact shell-safe headed `scan --coordinate` reproduction command. Structural drift deliberately has no coordinate reproduction command.

A matching complete contract exits `0`, including exact active known failures. A complete run with a regression, recovery, expired exception, or unaccepted matrix/config drift exits `1` and publishes an immutable content-addressed proposal with a separate metadata overlay. Invalid input, unsafe output, setup failure, incomplete execution, or an internal error exits `2`. Report, evidence, verdict, proposal family, and generation metadata publish in one crash-recoverable transaction.

### `uiwitness contract`

```bash
uiwitness contract init [--config <path>] [--contract <path>]
uiwitness contract inspect --candidate <path> --change <id>
uiwitness contract annotate --candidate <path> --change <id> --owner <text> --reason <text> --created-on <date> --expires-on <date>
uiwitness contract accept --candidate <path> --change <id>... [--config <path>] [--contract <path>]
```

`contract init` performs one complete run and exclusively creates the first contract only when every coordinate passes. Failures publish a proposal instead. Proposal IDs are stable `<operation>:<route/state/viewport/theme>` values where operation is `add`, `remove`, `config`, `expectation`, or `exception`. `inspect` shows exactly one named change. `annotate` writes only owner, reason, creation date, and a 1–30 day expiry to the proposal's separate metadata overlay; only changes that can create or renew a failed expectation accept metadata.

`accept` takes one or more explicit `--change` selections. Under a contract writer lock it verifies the content-addressed filename, regenerates the proposal from its immutable source, checks current contract and expanded-config digests, revalidates exception dates, and applies only selected changes. Success safely replaces an existing contract or exclusively creates the first one, consumes the proposal and metadata, reports unselected IDs as discarded, and never renews an exception implicitly. Concurrent writers, stale inputs, mutated proposals, unsafe paths, empty selection, and missing metadata fail with exit `2` without changing the contract.

### `uiwitness open`
Open latest `.uiwitness/report/index.html`; useful error if absent.

The command accepts no flags or positional arguments. It opens only the fixed HTML report beneath the invocation directory, refuses symbolic-link/non-file report paths, and delegates to the operating system's default browser without a command shell. It never generates or changes report files; the Phase 5 report package owns HTML creation.

## Exit codes
0 the requested check passes or the contract matches; 1 a complete check/scan has failures or a complete guard has contract failures; 2 usage/config/internal/setup/incomplete-run error.

## Coverage
Every `route x state x viewport x theme` is an expected cell. Only configured states count; v0.1 never claims an unconfigured state is missing.
