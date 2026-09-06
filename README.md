# UIWitness

[![CI](https://github.com/RujitRaval/uiwitness/actions/workflows/ci.yml/badge.svg)](https://github.com/RujitRaval/uiwitness/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/uiwitness.svg)](https://www.npmjs.com/package/uiwitness)
[![license](https://img.shields.io/badge/license-MIT-171a16.svg)](LICENSE)

**Find the UI states your product forgot.**

UIWitness is a local-first product-state coverage tool. It renders your routes across meaningful states, viewports, and themes; runs assertions; captures screenshots and sanitized diagnostics; and produces one self-contained offline report.

```bash
npm install --save-dev uiwitness playwright@1.62.1
npx playwright install chromium
npx uiwitness check https://example.com
npx uiwitness check https://example.com --write-config
npx uiwitness scan
```

![UIWitness report opening with the Evidence over instinct verdict and 93.33 percent coverage for 60 UI executions](docs/assets/uiwitness-report-overview.png)

The screenshot above is the real 60-cell Northline example report. Four deliberately broken coordinates remain visible so the release gate proves UIWitness catches narrow-viewport overflow and theme-specific contrast failures.

## Product states, not just pixel changes

Conventional visual regression asks whether an existing screenshot changed. UIWitness asks whether every important product state still works in the conditions you support.

| | UIWitness | Screenshot regression |
| --- | --- | --- |
| Primary question | Did each configured product state survive? | Did pixels change from a baseline? |
| Coverage model | Route × state × viewport × theme | Screenshot cases you remembered to write |
| Evidence | Screenshot, assertions, console/page/request diagnostics | Image diff |
| Output | Private local JSON, PNGs, and offline HTML | Usually service- or runner-specific |

Use it for loading, empty, error, unauthorized, long-content, responsive, and theme states—the places where otherwise healthy applications tend to break.

## Check a live website without config

Point UIWitness at a public site you own or are authorized to test:

```bash
npx uiwitness check https://example.com
```

UIWitness discovers up to five same-origin HTML pages, checks every page at mobile/desktop × light/dark, captures screenshots and sanitized browser evidence, and writes the kinetic offline report to `.uiwitness/report/index.html`. Use `--max-pages <1-20>` for a different bounded discovery budget or `--headed` to watch the run. Add `--write-config` to save the discovered routes as an overwrite-safe `uiwitness.config.mts` plus a shared public-site scenario, ready for `npx uiwitness scan`. The command exits `0` when every cell passes, `1` when it finds failures, and `2` when usage, discovery, setup publication, or the run itself cannot complete.

Quick Check covers public success surfaces. After promotion, edit the generated config and add loading, empty, error, authenticated, and long-content scenarios that a public crawl cannot reach. Without `--write-config`, Quick Check creates only ignored `.uiwitness/` evidence and prints the exact promotion command.

The [public website Quick Check guide](docs/open-source/PUBLIC_URL_QUICK_CHECK.md) walks through the two-minute first run, interpreting the report, safe promotion, privacy boundaries, and the registry-only release proof behind this workflow. Existing users can follow the [identity migration guide](docs/open-source/MIGRATING_TO_UIWITNESS.md) for package, command, config, scenario, and evidence-path mappings.

## Quick start

UIWitness supports Node.js 22.20 or newer within the Node 22 LTS line, or Node.js 24.x.

1. Install the CLI and its pinned browser runtime:

   ```bash
   npm install --save-dev uiwitness playwright@1.62.1
   npx playwright install chromium
   ```

2. Generate an overwrite-safe starter config and scenario:

   ```bash
   npx uiwitness init
   ```

   This creates `uiwitness.config.mts` and `uiwitness/scenarios/home/success.mts`. The explicit ESM extensions work in both npm's default CommonJS projects and projects that set `"type": "module"`.

3. Start your application, then scan and open the report:

   ```bash
   npx uiwitness scan
   npx uiwitness open
   ```

`scan` exits `0` when all cells pass, `1` when completed cells expose product-state failures, and `2` for setup or configuration errors. A failing scan still writes its report whenever execution completed.

Once a repository has a committed `uiwitness.contract.json`, guard every promised coordinate against one fresh complete run:

```bash
npx uiwitness guard
```

Guard exits `0` when the contract matches, `1` for regressions or unaccepted drift, and `2` when an invalid or incomplete run cannot prove the contract. It writes `.uiwitness/contract-verdict.json`, gives executable findings an exact headed `scan --coordinate route/state/viewport/theme` reproduction command, and places the promise verdict plus actionable findings before the existing evidence matrix in the offline report. The [CLI API](docs/engineering/CLI_API.md), [core API](docs/engineering/CORE_API.md), and [report API](docs/engineering/REPORT_API.md) define the path, fingerprint, contract, digest, verdict, and rendering contracts.

Create the first contract from one complete run, or review a failed guard's immutable proposal one named change at a time:

```bash
npx uiwitness contract init
npx uiwitness contract inspect --candidate .uiwitness/contract-candidates/<digest>.proposal.json --change expectation:home/success/desktop/light
npx uiwitness contract annotate --candidate .uiwitness/contract-candidates/<digest>.proposal.json --change expectation:home/success/desktop/light --owner quality-team --reason UIW-2041 --created-on 2026-09-03 --expires-on 2026-09-17
npx uiwitness contract accept --candidate .uiwitness/contract-candidates/<digest>.proposal.json --change expectation:home/success/desktop/light
```

Proposals are canonical, content-addressed, and immutable; annotations live in a separate constrained metadata file. An expired exception can be renewed only when the exact eligible failure codes remain, using a changed reason and a fresh 1–30 day window. Recovery removes the exception, changed eligible codes require a new expectation decision, ineligible failures must be repaired, and dates never extend automatically. Terminal, machine JSON, offline HTML, and GitHub surfaces show the owner, reason, expiry, exact expected/actual codes, UTC lifecycle, and next action. The runner publishes report/evidence, verdict, proposal family, optional JSON copy, and a content-addressed manifest as one crash-recoverable generation whose stable marker appears last. Acceptance requires that committed marker, revalidates the proposal source plus the current config and contract under a writer lock, applies only explicitly named changes, consumes the proposal and metadata, and discards unselected changes. A new complete guard run is required to reconsider anything discarded.

## Configure a small, explicit matrix

```ts
import { defineConfig } from "uiwitness";

export default defineConfig({
  baseURL: "http://127.0.0.1:3000",
  routes: [
    {
      id: "orders",
      path: "/orders",
      states: ["success", "loading", "empty", "error"].map((id) => ({
        id,
        setup: "./uiwitness/scenarios/orders.mjs",
      })),
    },
  ],
  themes: ["light", "dark"],
  viewports: {
    mobile: { width: 390, height: 844 },
    desktop: { width: 1440, height: 1000 },
  },
});
```

Authentication is optional. Add `authentication: { setup: "./uiwitness/auth.mjs", mode: "shared-readonly" }` when the matrix needs one non-mutating account. Its trusted setup hook runs once, reads credentials directly from your environment or secret manager, and seeds every fresh cell context from validated in-memory state. UIWitness never writes a storage-state file; parent-domain, additional-origin, and partitioned cookies require explicit scopes. Fork pull requests must remain secret-free.

Sensitive pixels can be protected with `evidence.masks`: each named selector may be scoped to exact routes/states, required, and given an exact cardinality. Mask failures block capture and never retry unmasked. Retention defaults to `all`; choose `failures-only` to keep only failed-cell images or `none` to disable both screenshots and runtime selector resolution. Privacy modes use explicit report schema v2 states, while default `all` runs retain schema-v1 compatibility. Every run writes a selector-free `evidence-manifest.json` beside the report.

Scenarios are trusted local modules. They can intercept deterministic API responses, wait for product-specific readiness, and make assertions with the same Playwright page used for capture:

```js
export default {
  async beforeNavigate({ page, state }) {
    if (state.id === "empty") {
      await page.route("**/api/orders", (route) =>
        route.fulfill({ json: { orders: [] }, status: 200 }),
      );
    }
  },
  async afterNavigate({ page }) {
    await page.locator("[data-orders-state]").waitFor();
  },
  async assert({ page }) {
    await page.getByRole("heading", { name: "Orders" }).waitFor();
  },
};
```

See the [CLI and configuration specification](docs/product/CLI_AND_CONFIG_SPEC.md), [runner API](docs/engineering/RUNNER_API.md), and complete [Northline matrix](apps/example-nextjs/uiwitness.config.ts).

## Inspect evidence offline

Every completed scan writes a versioned report beneath `.uiwitness/`:

```text
.uiwitness/
├── artifacts/             # deterministic PNG evidence
├── contract-candidates/   # immutable proposals + metadata overlays
├── contract-generations/  # immutable proposal source snapshots
├── contract-verdict.json  # deterministic guard verdict
├── generation.json        # stable committed-generation marker
├── generations/           # content-addressed generation manifests
└── report/
    ├── evidence-manifest.json # retention, safe mask counts, and digests
    ├── index.html         # self-contained interactive report
    └── uiwitness.json
```

Filter by route, state, viewport, theme, or status. Open a cell to inspect the exact screenshot, route metadata, assertion failures, console errors, page errors, and failed requests. The report needs no server, account, network request, or external asset.

Guard reports lead with the contract verdict and canonical finding ledger. Filter findings independently by coordinate text and finding type; incomplete runs preserve their exact machine reasons alongside deterministic human-readable explanations. Each finding shows only the reproduction and review commands that apply to that finding kind.

![UIWitness failure detail showing the Northline customer long-content mobile overflow and its assertion evidence](docs/assets/uiwitness-failure-detail.png)

## GitHub Actions

UIWitness ships a thin composite Contract Guard Action over the project-local CLI—no hosted service or implicit package download. Pin the Action's complete release SHA, lock the matching `uiwitness` package version, grant only `contents: read`, and keep evidence upload off unless the captured application data is appropriate for GitHub artifacts. The copy-ready [GitHub Actions guide](docs/open-source/GITHUB_ACTIONS.md) covers application readiness, version parity, bounded summaries and annotations, fork safety, exit codes, rollback, and explicit one-day evidence retention.

Reports can contain screenshots, URLs, and application data. Treat artifacts from a public repository as public, use only fictional or approved test data, and choose the shortest useful retention period.

## Packages

| Package | Purpose |
| --- | --- |
| [`uiwitness`](https://www.npmjs.com/package/uiwitness) | Public API and the `uiwitness` executable |
| [`uiwitness-core`](https://www.npmjs.com/package/uiwitness-core) | Browser-independent config, authentication-state policy, state-contract, canonical-digest, comparison/verdict, proposal/acceptance, matrix, coverage, and report contracts |
| [`uiwitness-runner-playwright`](https://www.npmjs.com/package/uiwitness-runner-playwright) | Isolated Playwright execution, memory-only authentication, and local persistence |
| [`uiwitness-report`](https://www.npmjs.com/package/uiwitness-report) | Deterministic offline report transformation and rendering |

All four packages publish from the protected GitHub Release workflow through npm trusted publishing with provenance. The one-time bootstrap completed with its temporary token and secret removed inside the required cleanup window; normal OIDC releases keep no long-lived npm token configured and run registry verification automatically.

## Local-first architecture

```text
configure → expand matrix → run isolated browser cells → compare contract → commit one evidence/verdict/proposal generation → inspect
```

- No telemetry, hosted backend, database, account, cloud dependency, or required LLM.
- One Chromium process is reused while every matrix cell gets a fresh browser context and page.
- Screenshot paths, result schemas, coverage math, and report rendering are deterministic.
- Console, page, and request diagnostics are sanitized before persistence.
- `.uiwitness/` is ignored because reports may contain sensitive application data.

Read the [architecture](docs/architecture/ARCHITECTURE.md), [security and privacy model](docs/engineering/SECURITY_PRIVACY.md), [report UX specification](docs/product/REPORT_UX_SPEC.md), and [brand research](docs/design/BRAND_RESEARCH.md) for the detailed contracts. The repository-level [design system](DESIGN.md) is the visual source of truth.

## Develop and contribute

The workspace uses pnpm, strict TypeScript, Vitest, Playwright, and a polished Next.js fixture:

```bash
corepack pnpm install --frozen-lockfile
corepack pnpm --filter uiwitness-runner-playwright exec playwright install chromium
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

The Northline scan intentionally exits `1` with exactly 56 passes and four failures. To regenerate the checked-in launch images after producing that report, run `corepack pnpm launch:assets`.

Start with [CONTRIBUTING.md](CONTRIBUTING.md). The [Quick Check guide](docs/open-source/PUBLIC_URL_QUICK_CHECK.md), [documentation map](codex/MASTER_PROMPT.md), [implementation specification](codex/IMPLEMENTATION_SPEC.md), [release guide](docs/open-source/RELEASING.md), and [launch strategy](docs/open-source/LAUNCH_STRATEGY.md) explain the product boundary and workflow.

## Roadmap

The current release is the local-first v0.1 product: explicit matrices, deterministic Playwright scenarios, offline evidence, CI usage, a complete example, the completed [public URL Quick Check](docs/designs/public-url-quick-check.md), and T1–T10 of the approved [State Contract Guard roadmap](docs/designs/uiwitness-state-contract-guard.md), through memory-only authentication and fail-closed evidence privacy. Deterministic sharding and its aggregation/release-proof slices remain sequenced roadmap work. Hosted collaboration remains out of scope unless real demand appears.

## License

[MIT](LICENSE)
