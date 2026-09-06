# CLI API

`uiwitness` exposes zero-config public-site checking, deterministic config loading, and executable `init`, `scan`, `guard`, `contract`, and `open` workflows. Check composes bounded runner discovery, fixed public-site evidence, and the report-generation contracts. Scan composes the core planner and configured runner. Guard compares one complete fresh run with a committed state contract. Contract commands initialize, inspect, annotate, and explicitly accept immutable proposals. Open launches the generated offline HTML report; report transformation and rendering stay owned by `uiwitness-report`.

## Executable

```bash
uiwitness init
uiwitness check <url> [--max-pages <1-20>] [--headed] [--write-config]
uiwitness scan [--config <path>] [--route <id> | --coordinate <route/state/viewport/theme>] [--headed]
uiwitness guard [--config <path>] [--contract <path>] [--json <path>]
uiwitness contract init [--config <path>] [--contract <path>]
uiwitness contract inspect --candidate <path> --change <id>
uiwitness contract annotate --candidate <path> --change <id> --owner <text> --reason <text> --created-on <date> --expires-on <date>
uiwitness contract accept --candidate <path> --change <id>... [--config <path>] [--contract <path>]
uiwitness open
uiwitness --version
uiwitness --help
```

`uiwitness --version` prints the exact installed three-component npm package version and exits `0`. The official GitHub Action uses this process-only handshake before browser work and rejects any mismatch with the Action checkout's four-component repository version translated to npm SemVer.

`init` creates:

```text
uiwitness.config.mts
uiwitness/scenarios/home/success.mts
```

The config imports `defineConfig` from the installed `uiwitness` package and declares one `/` route, one `success` state, mobile and desktop viewports, and light and dark themes. Both generated files use the module-unambiguous `.mts` extension, so they load correctly even when the nearest `package.json` is the CommonJS default created by `npm init -y`. The scenario starts as a valid empty module with no external import, so the documented one-package installation is sufficient. Developers can add typed Playwright hooks when they customize that scenario. Successful initialization prints the created paths plus edit, hook, and version-control next steps.

No force flag exists. Before writing, initialization checks every supported default config name, the generated scenario, and every directory boundary. Any existing config, an existing scenario, or a symbolic-link starter directory produces exit code `2`. Files use exclusive creation, the config is published last, and alternate config names are rechecked before success is reported. Failure recovery never deletes a path, because a concurrent process could have replaced a newly created file; write failures list the affected targets for inspection before retrying.

Missing or unsupported commands, malformed check/scan/guard/contract options, extra `init` or `open` arguments, invalid public URLs, discovery/config/contract errors, unknown route IDs or coordinates, unsafe guard paths, stale or mutated proposals, concurrent contract writers, absent/invalid HTML reports, launcher failures, and run-level failures return `2`. Help, successful opens, contract inspection/annotation/acceptance, all-pass checks/scans, and matching complete guards return `0`. A completed check or scan containing failed cells returns `1` after persisting its report; a complete guard with contract failures or unaccepted drift and a contract initialization that requires proposal review also return `1`.

## Programmatic command, check, init, scan, and open API

```ts
import {
  checkPublicSite,
  initProject,
  openReport,
  runCli,
  scanProject,
} from "uiwitness";

const check = await checkPublicSite({
  cwd: process.cwd(),
  maxPages: 5,
  url: "https://example.com",
  writeConfig: true,
});
const result = await initProject({ cwd: process.cwd() });
const exitCode = await runCli({ args: ["init"], cwd: process.cwd() });
const scan = await scanProject({ cwd: process.cwd(), routeId: "dashboard" });
const opened = await openReport({ cwd: process.cwd() });
```

`initProject` returns canonical absolute `projectRoot`, `configPath`, and `scenarioPath` values plus an immutable `files` list. Expected failures use `InitError` with `INIT_CONFLICT`, `INIT_ROOT_INVALID`, or `INIT_WRITE_FAILED` and expose the affected paths.

`checkPublicSite` canonicalizes the output directory before browser work, calls `discoverPublicRoutes`, passes that immutable discovery result to `runPublicSiteChecks`, and returns discovery metadata plus the validated report and stable JSON/HTML paths. `headed: true` is forwarded to both browser launches, while `maxPages` applies only to discovery.

With `writeConfig: true`, it preflights all supported config names, the public scenario target, and real directory boundaries before importing the runner. After a completed persisted check, it creates `uiwitness/scenarios/public/default.mts` exclusively and publishes `uiwitness.config.mts` last. The returned optional `setup` contains canonical generated paths. Setup conflicts and write failures use stable `CHECK_SETUP_*` codes; unexpected runner details remain hidden by the executable. The summary either prints the exact promotion command or the configured-scan handoff.

Generated scenarios import `publicSiteScenario` from the documented `uiwitness/public-site-scenario` subpath. This narrow helper retains the runner-owned public assertions without adding Playwright types to the main CLI API or eagerly loading the runner when consumers import `uiwitness`.

`scanProject` loads and validates config, verifies an optional exact `routeId` or atomic `route/state/viewport/theme` `coordinate`, expands the selected matrix, resolves scenarios relative to the selected config, and persists deterministic output beneath the selected `cwd`. The two selectors are mutually exclusive, and an exact coordinate must expand to one cell. `headed: true` forwards `{ headless: false }` to Playwright. The runner publishes retained PNGs, report schema v1 or v2 according to retention, offline HTML, an evidence manifest, a content-addressed generation-manifest schema v2, and `.uiwitness/generation.json` as one coordinated output set. `scanProject` returns the canonical config path, validated report, stable report paths, and the committed-generation identity. Unknown or malformed selection raises a stable `ScanError` before browser launch; unexpected runner or filesystem details remain hidden behind CLI exit code `2`.

When config declares authentication, `scanProject` first requires the setup module to be a readable, single-link regular file beneath the canonical invocation workspace with no symbolic-link boundary. It forwards the parsed normalized policy to the runner, which logs in once and seeds fresh cells from validated memory-only state. Authentication failure becomes `SCAN_AUTHENTICATION_FAILED`; setup-path failure becomes `SCAN_AUTH_SETUP_PATH_INVALID`. The executable prints only the stable auth code and non-secret configured module path and exits `2`.

`guard` remains an executable, process-based orchestration surface rather than a new public TypeScript export. Its workspace is the canonical invocation directory and, unlike ordinary config discovery, it does not search parents or permit paths outside that root. It validates the config, default or explicit contract, all scenario real paths, and default/explicit verdict paths before browser launch. Symbolic-link boundaries and non-files are refused. The default contract path is `uiwitness.contract.json`; the default verdict sidecar is `.uiwitness/contract-verdict.json`. An explicit `--json` copy uses exclusive no-clobber creation.

A configuration with neither authentication nor an explicit evidence policy retains the existing v1 coordinate fingerprint. Authentication or an explicit `evidence` block activates fingerprint v2. It adds the normalized evidence retention and canonically ordered mask definitions/scopes; when authentication is present it also adds the mode, canonical workspace-relative setup-module path, sorted normalized additional origins, and cookie scopes. The absent counterpart is represented by its default projection, so later authentication or evidence changes remain deterministic. Environment values, cookies, local storage, and captured auth state never participate. Introducing either block creates explicit config drift while untouched configurations retain stable fingerprints. Existing schema-v1 contracts remain readable; the first guarded run with either block emits named config changes that must be reviewed and accepted as the explicit fingerprint migration. The run digest hashes the canonical semantic report projection while excluding timestamps, durations, base URL, host paths, evidence bytes, and mtimes. Guard compares only the report returned by the same complete unfiltered run. Its canonical verdict contains schema version, completeness, evaluated UTC date, contract/config/run digests, overall verdict, message-free findings, and shell-safe exact-coordinate reproduction and remediation commands. A failed complete guard also prepares canonical content-addressed source/proposal files and a separately mutable canonical metadata overlay. The runner publishes those members, the default verdict, any exclusive `--json` copy, report/evidence, manifest, and marker in one crash-recoverable generation. Repeating an identical guard reuses identical immutable bytes and preserves an existing valid overlay.

`contract init` uses one complete fresh run to build the first contract. An all-pass run exclusively creates the target; a failed run publishes only a proposal and empty metadata overlay. `contract inspect` resolves a content-addressed candidate and prints one exact named change plus its lifecycle action. `contract annotate` accepts only changes that create or renew eligible failed expectations and replaces only that change's owner, reason, creation date, and 1–30 day expiry in the separate metadata file. Renewal is available only when the expired exception's exact eligible failure-code set is still observed; it requires a changed reason and current dates. A recovered known failure produces an expectation change that removes the exception. Added, removed, or substituted eligible codes require new ownership metadata; infrastructure and other ineligible codes must be repaired and are rejected before annotation. No command extends an exception automatically.

`contract accept` requires one or more exact change IDs. It takes `.uiwitness/contract.lock` and then the runner generation lock, rereads and regenerates the proposal from its immutable source, verifies the candidate filename and every source/proposal/config/contract digest, and requires the current `.uiwitness/generation.json` plus content-addressed manifest to bind that source and proposal before applying only the selected operations. Guard uses the same contract-first lock order and holds the contract lock from snapshot through publication, so acceptance cannot race a guard generation. An otherwise valid orphan proposal is rejected. Existing contracts use safe same-directory replacement; initial contracts retain exclusive no-clobber creation. A successful acceptance consumes the proposal and overlay and reports every unselected change as discarded, requiring a new complete guard run to reconsider it. The executable contract orchestration remains process-only and is not exported from the `uiwitness` TypeScript package.

The terminal summary is derived from report metadata, groups cells by route, prints each state/viewport/theme result and failure messages, then prints execution coverage, HTML report path, and aggregate pass/fail totals. It never parses artifact filenames for metadata.

`openReport` canonicalizes the selected project root and opens only `.uiwitness/report/index.html`. Every `.uiwitness/` and `report/` boundary must be a real directory and the HTML target must be a readable regular file, not a symbolic link, when inspected. The path is passed as one argument to the absolute system path for macOS `open`, Windows `explorer.exe`, or freedesktop `xdg-open`; neither a command shell nor project-directory executable lookup is used. Because those operating-system launchers accept pathnames rather than open file descriptors, the local project directory is trusted against concurrent same-user mutation during the handoff. The API returns canonical absolute `projectRoot` and `reportPath` values plus the stable project-relative path. Expected failures use `OpenReportError` with `OPEN_REPORT_NOT_FOUND`, `OPEN_REPORT_ROOT_INVALID`, `OPEN_REPORT_PATH_INVALID`, or `OPEN_REPORT_LAUNCH_FAILED`.

Opening is read-only: it does not parse, create, or modify the report. A completed scan now publishes the fixed HTML target that `open` consumes.

`runCli` accepts injectable arguments, working directory, and stdout/stderr writers for embedding and deterministic tests. `CliExitCode` is the stable `0 | 1 | 2` command contract. Exact package-version reporting is additive and performs no project discovery or browser work.

## Discovery

```ts
import { discoverConfig } from "uiwitness";

const configPath = await discoverConfig({ cwd: process.cwd() });
```

Default discovery checks only the selected working directory for these names:

- `uiwitness.config.ts`
- `uiwitness.config.mts`
- `uiwitness.config.cts`
- `uiwitness.config.js`
- `uiwitness.config.mjs`
- `uiwitness.config.cjs`

It does not walk toward the filesystem root. Exactly one canonical file must match. Multiple distinct matches raise `ConfigDiscoveryError` with code `CONFIG_AMBIGUOUS`; no extension has silent precedence.

Pass `configPath` to select any regular file explicitly. Relative paths resolve from `cwd`. Successful discovery returns the canonical absolute path, including resolution of filesystem aliases and symbolic links.

Expected discovery errors use `ConfigDiscoveryError` and one of:

- `CONFIG_NOT_FOUND`
- `CONFIG_AMBIGUOUS`
- `CONFIG_PATH_INVALID`
- `CONFIG_ROOT_INVALID`

The error exposes stable `code`, `configPath`, and `candidates` fields so later CLI presentation does not need to parse message text.

## Loading

```ts
import { loadConfig } from "uiwitness";

const { config, path } = await loadConfig({
  configPath: "./uiwitness.config.ts",
  cwd: process.cwd(),
});
```

`loadConfig` discovers the file, imports it as a trusted local module, requires a default export, and validates that export with `uiwitness-core`'s `parseConfig`. It returns the validated config and its canonical source path.

Module execution failures and absent default exports use `ConfigLoadError` with `CONFIG_IMPORT_FAILED` or `CONFIG_DEFAULT_EXPORT_MISSING`. Invalid exported values retain the core `ConfigValidationError` contract and its structured issues.

Config files execute with the user's process privileges. UIWitness does not sandbox them and does not upload their contents.
