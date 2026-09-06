# Migrating to UIWitness

Statecraft is now UIWitness. The product behavior and schema-v1 report payload are unchanged, but the public packages, executable, generated project files, and new evidence paths use the UIWitness identity.

UIWitness does not rename, copy, upload, or delete existing `.statecraft/` evidence. New runs write only to `.uiwitness/`.

## Old-to-new reference

| Before | After |
| --- | --- |
| `statecraft-ui` | `uiwitness` |
| `statecraft-ui-core` | `uiwitness-core` |
| `statecraft-ui-report` | `uiwitness-report` |
| `statecraft-ui-runner-playwright` | `uiwitness-runner-playwright` |
| `statecraft` executable | `uiwitness` executable |
| `StatecraftConfig` | `UIWitnessConfig` |
| `StatecraftReport` | `UIWitnessReport` |
| `StatecraftScenario` | `UIWitnessScenario` |
| `statecraft.config.*` | `uiwitness.config.*` |
| `statecraft/scenarios/` | `uiwitness/scenarios/` |
| `.statecraft/report/statecraft.json` | `.uiwitness/report/uiwitness.json` |
| `.statecraft/report/index.html` | `.uiwitness/report/index.html` |

## Migrate a project

1. Replace the packages you use. For the common CLI installation:

   ```bash
   npm uninstall statecraft-ui
   npm install --save-dev uiwitness playwright@1.62.1
   ```

   Direct API consumers should replace the corresponding supporting package from the table above.

2. Preflight the new source paths so the manual move cannot overwrite an existing UIWitness setup:

   ```bash
   test ! -e uiwitness.config.mts
   test ! -e uiwitness
   ```

3. Rename the config and scenario directory you own:

   ```bash
   mv statecraft.config.mts uiwitness.config.mts
   mv statecraft uiwitness
   ```

   Use the matching config extension if your project uses `.ts`, `.cts`, `.js`, `.mjs`, or `.cjs` instead of `.mts`.

4. Update package imports, exported type names, scenario `setup` paths, npm scripts, and CI commands using the mapping table. Then verify the CLI surface:

   ```bash
   npx uiwitness --help
   npx uiwitness scan
   npx uiwitness open
   ```

5. Commit the renamed config and scenarios. Keep both `.uiwitness/` and `.statecraft/` ignored because either directory may contain screenshots, URLs, and diagnostics.

## Existing evidence stays private

Do not move `.statecraft/` to `.uiwitness/`. UIWitness treats the roots as separate evidence histories and never accesses the legacy directory during a new run. Existing schema-v1 JSON can still be parsed and rendered programmatically with the UIWitness core and report packages, including screenshot references rooted under `.statecraft/artifacts/`; `uiwitness open` intentionally opens only the latest `.uiwitness/report/index.html`.

Default screenshot retention still emits schema v1. Configuring `failures-only` or `none` intentionally emits schema v2, where `screenshot.status` distinguishes retained evidence, policy omission, and capture failure. Upgrade schema-v1-only consumers before enabling those policies.

Delete old evidence only when you have reviewed it and deliberately decided it is no longer needed:

```bash
# Review first. This command is intentionally not automated by UIWitness.
ls -la .statecraft
```

## Deprecation messages

The migration is deprecation-only because no qualifying external users or compatibility promises were found. The UIWitness registry journey passed on 2026-09-01, and every version of the old npm packages now carries these exact messages:

- `statecraft-ui has moved to uiwitness. Install uiwitness and migrate with https://github.com/RujitRaval/uiwitness/blob/main/docs/open-source/MIGRATING_TO_UIWITNESS.md`
- `statecraft-ui-core has moved to uiwitness-core. Install uiwitness-core and migrate with https://github.com/RujitRaval/uiwitness/blob/main/docs/open-source/MIGRATING_TO_UIWITNESS.md`
- `statecraft-ui-report has moved to uiwitness-report. Install uiwitness-report and migrate with https://github.com/RujitRaval/uiwitness/blob/main/docs/open-source/MIGRATING_TO_UIWITNESS.md`
- `statecraft-ui-runner-playwright has moved to uiwitness-runner-playwright. Install uiwitness-runner-playwright and migrate with https://github.com/RujitRaval/uiwitness/blob/main/docs/open-source/MIGRATING_TO_UIWITNESS.md`

No compatibility bridge or support-end date applies. The cutover is complete; any future compatibility work requires a new evidence-backed roadmap decision.
