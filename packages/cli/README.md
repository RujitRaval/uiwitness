# uiwitness

The npm package for the `uiwitness` CLI. UIWitness checks public websites or renders configured UI product states with Playwright, captures screenshots and diagnostics, and writes an offline coverage report.

```bash
npm install --save-dev uiwitness playwright@1.62.1
npx playwright install chromium
npx uiwitness check https://example.com
npx uiwitness check https://example.com --write-config
npx uiwitness scan
npx uiwitness guard
npx uiwitness contract init
npx uiwitness --version
```

`check <url>` needs no UIWitness config. It discovers at most five same-origin HTML pages by default, checks each at mobile/desktop × light/dark, and writes screenshots, schema-v1 JSON, and the kinetic offline report beneath `.uiwitness/`. Use `--max-pages <1-20>` to change the bounded discovery budget or `--headed` to watch Chromium. Add `--write-config` to save an overwrite-safe `uiwitness.config.mts` and `uiwitness/scenarios/public/default.mts`; the untouched result runs through `npx uiwitness scan`. Run it only against websites you own or are authorized to test.

New `check`, `scan`, and `open` operations use `.uiwitness/report/uiwitness.json` and `.uiwitness/report/index.html`. They never rename, copy, delete, or inspect a pre-existing `.statecraft/` evidence tree. Quick Check and configured runs using default `all` retention emit schema v1; configured `failures-only` or `none` runs emit schema v2. Version-aware readers accept both versions, while the schema-v1 reader continues to accept legacy `.statecraft/artifacts/**` screenshot references without rewriting them.

`init` generates `uiwitness.config.mts` and `uiwitness/scenarios/home/success.mts`, so the starter works without changing npm's default package type.

`guard` executes the complete configured matrix and compares that fresh result with `uiwitness.contract.json`. It commits the deterministic `.uiwitness/contract-verdict.json` together with report/evidence, any proposal family, a content-addressed manifest, and the stable `.uiwitness/generation.json` marker. It exits `0` for a match, `1` for contract failures or unaccepted drift, and `2` when the run cannot prove the contract. Regressions include an exact headed `scan --coordinate route/state/viewport/theme` command. Config, contract, scenario, and explicit `--json` paths are restricted to real non-symbolic-link paths beneath the invocation directory.

Configured `scan` and `guard` runs can use one trusted `authentication` setup module for a non-mutating shared account. Login runs once, validated storage state stays in memory, and every product-state cell still receives a fresh browser context. Exact extra origin and cookie scopes must be declared; stored auth files, multiple roles, authenticated sharding, and secret-bearing fork runs are not supported.

Configured runs can also declare fail-closed evidence masks plus `all`, `failures-only`, or `none` screenshot retention. Default `all` keeps schema-v1 compatibility; the privacy policies use schema v2 so intentional omission cannot be confused with capture failure.

`--version` prints the exact installed package version without project discovery. The official full-SHA-pinned GitHub Action uses it to reject Action/package drift before launching Chromium.

`contract init` creates the first contract only after a complete run; a failing run produces an immutable proposal instead. Failed guards likewise commit a content-addressed proposal plus a separate metadata overlay in the current generation. Use `contract inspect --candidate <path> --change <id>` to review one named `add`, `remove`, `config`, `expectation`, or `exception` change. Failed expectations require `contract annotate` ownership, reason, and a current 1–30 day exception before `contract accept`. An expired exception can be renewed only when its exact eligible failure-code set is still present, using a changed reason and fresh dates. Recovery removes the exception, changed eligible codes require new expectation metadata, and ineligible failures must be repaired; no dates extend automatically. Acceptance requires the current committed marker to bind the source and proposal, revalidates the source, current config, and current contract, applies only repeated `--change <id>` selections, consumes the proposal and overlay, and requires a fresh guard run for discarded changes.

The package also exports `defineConfig`, `checkPublicSite`, config discovery/loading, initialization, scan orchestration, and report-opening APIs for TypeScript consumers. Generated public-site scenarios import the narrow `uiwitness/public-site-scenario` helper so they retain the same assertions as Quick Check without copying implementation code.

See the [public website Quick Check guide](https://github.com/RujitRaval/uiwitness/blob/main/docs/open-source/PUBLIC_URL_QUICK_CHECK.md) for the complete first-run and promotion journey. The [UIWitness repository](https://github.com/RujitRaval/uiwitness) contains configuration, scenario, CI, privacy, release-proof, and contribution guidance.
