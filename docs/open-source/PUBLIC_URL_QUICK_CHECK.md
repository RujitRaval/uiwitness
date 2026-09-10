# Check a Public Website with UIWitness

UIWitness can turn an authorized live website into local visual evidence before you write configuration. It discovers a bounded same-origin surface, checks every accepted page at mobile/desktop × light/dark, and writes screenshots plus one offline report. No account, API key, hosted service, or upload is involved.

## The two-minute path

UIWitness supports Node.js 22.20 or newer within Node 22, or Node.js 24.x. In your project:

```bash
npm install --save-dev --save-exact uiwitness@0.26.13 playwright@1.62.1
npx playwright install chromium
npx uiwitness check https://example.com
```

Replace `https://example.com` with a site you own or are authorized to test. UIWitness checks up to five discovered same-origin HTML pages by default. Use `--max-pages <1-20>` to choose a different bound or `--headed` to watch the browser.

The command writes private local evidence beneath `.uiwitness/`:

```text
.uiwitness/
├── artifacts/             # one PNG per page × viewport × theme
└── report/
    ├── index.html         # interactive, self-contained report
    └── uiwitness.json    # schema-v1 machine-readable evidence
```

Open `.uiwitness/report/index.html` directly. Filter the matrix, inspect failed cells, and use the screenshot plus sanitized console, page, and request diagnostics to decide whether a problem is real.

## Keep the useful surface

An evidence-only check does not create project source files. When the discovered routes are useful, run the exact promotion command UIWitness prints:

```bash
npx uiwitness check https://example.com --write-config
npx uiwitness scan
```

The first command deliberately checks the site again, then creates `uiwitness.config.mts` and `uiwitness/scenarios/public/default.mts` only after the evidence run completes. It refuses existing supported config names, generated targets, and symbolic-link boundaries; there is no force or overwrite mode. The untouched generated setup reproduces the same public route × mobile/desktop × light/dark matrix through `scan`.

Quick Check covers the public success surface, not the product states hidden behind application behavior. Once the promoted scan is stable, add focused scenarios for loading, empty, error, unauthorized, long-content, and other states that matter to your product. That is where UIWitness moves from a website check to durable product-state coverage.

## Read the result correctly

- Exit `0`: every completed public cell passed.
- Exit `1`: the run completed and one or more cells exposed a failure. The report is still written.
- Exit `2`: usage, discovery, setup publication, or runner initialization could not complete.

Discovery is intentionally bounded and navigation-only. UIWitness does not log in, infer hidden routes, guess product states, or claim that an undiscovered state is covered. A changing public site can also produce a different accepted surface on a later run.

## Privacy and authorization

Run Quick Check only against websites you own or have permission to test. The browser executes ordinary page JavaScript and requests. UIWitness never uploads evidence or records cookies, authorization headers, response bodies, or raw secret-bearing request metadata, but screenshots and URLs can still contain sensitive information. Keep `.uiwitness/` ignored and treat any CI artifact upload as an explicit publication decision.

## Release proof

Every normal post-bootstrap UIWitness release finishes with the same consumer journey from an empty `npm init -y` project. The gate accepts both npm's implicit CommonJS manifest and npm 11's explicit `"type": "commonjs"` form, installs the exact release and pinned Playwright version from `https://registry.npmjs.org/`, starts a deterministic two-page authorized fixture, and runs:

```text
check → check --write-config → scan → open
```

It requires eight passing cells at each stage, non-empty screenshots, schema-v1 JSON, the kinetic offline HTML report, exact generated package imports, byte-unchanged config/scenario files after `scan`, and a successful report open through the installed CLI. No workspace package, local tarball, or repository build output can satisfy the gate.

Maintainers can repeat the post-publication proof with:

```bash
corepack pnpm release:registry-public-url-smoke -- --version 0.26.13
```

Use the npm version that was just published. Registry visibility retries share one bounded ten-minute elapsed-time window. Every attempt forces online revalidation through a distinct temporary npm cache; all consumer files, caches, and evidence are removed after success or failure.
