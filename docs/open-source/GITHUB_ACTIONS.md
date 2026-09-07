# GitHub Actions

UIWitness ships a thin composite Action that runs the `uiwitness` version already installed and locked by your repository. It never downloads product logic, reads pull-request text, mutates the pull request, or uploads evidence unless you explicitly enable that step. Use the [State Contract Guard guide](STATE_CONTRACT_GUARD.md) for the complete local-to-CI lifecycle; this page owns the copy-ready GitHub configuration.

## Install and pin

Install the exact UIWitness release and its documented Playwright version as development dependencies, commit the lockfile, and make sure your application can be built and served in CI.

```bash
npm install --save-dev --save-exact uiwitness@0.26.8 playwright@1.62.1
```

Pin the Action to the full 40-character commit SHA for the same release. Replace `<full-release-commit-sha>` below with the SHA shown on that GitHub Release. The SemVer comment is for humans; the SHA is the cryptographically stable reference.

```yaml
name: UIWitness

on:
  pull_request:

permissions:
  contents: read

jobs:
  guard:
    name: Product-state contract
    runs-on: ubuntu-latest
    timeout-minutes: 20
    steps:
      - name: Check out repository
        uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - name: Set up Node.js
        uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: 22.20.0
          cache: npm
      - name: Install dependencies
        run: npm ci
      - name: Install Chromium
        run: npx --no-install playwright install --with-deps chromium
      - name: Build application
        run: npm run build
      - name: Start application
        run: |
          npm run start > "$RUNNER_TEMP/uiwitness-app.log" 2>&1 &
          echo $! > "$RUNNER_TEMP/uiwitness-app.pid"
      - name: Wait for application
        run: |
          for attempt in $(seq 1 60); do
            if curl --fail --silent http://127.0.0.1:3000/ > /dev/null; then
              exit 0
            fi
            sleep 1
          done
          cat "$RUNNER_TEMP/uiwitness-app.log"
          exit 1
      - name: Guard promised product states
        id: uiwitness
        uses: RujitRaval/uiwitness@<full-release-commit-sha> # v0.26.8
```

The Action reads its own checked-in `VERSION`, runs the project-local `uiwitness --version`, and stops before browser work if the versions differ. Each guard invocation writes and validates a new exclusive internal `--json` verdict copy, so stale evidence already in the workspace cannot satisfy the current job. The repair for version drift is exact: update the package and Action pin to the same release, reinstall, and commit the lockfile. UIWitness does not fall back to `npx`, a global binary, or an implicit package download.

Full SemVer tags such as `v0.26.8` are protected by repository tag rules and are a readable convenience, but GitHub can technically move a tag. Mutable major tags are not published. Use the full release SHA for the strongest supply-chain boundary. The release workflow proves the exact four packed packages and matching Action SHA on Node 22 and 24 with both a pass and seeded regression before publication. It then verifies npm provenance and both registry consumers. To roll back, pin both the dependency and Action to the prior known-good release and rerun the same consumer proof.

## Inputs

Only five inputs are accepted:

| Input | Default | Contract |
| --- | --- | --- |
| `config` | empty | Optional workspace-contained config path passed as one argv value. |
| `contract` | empty | Optional workspace-contained contract path passed as one argv value. |
| `upload-artifact` | `false` | The complete `.uiwitness` evidence bundle is uploaded only when exactly `true`. |
| `retention-days` | `1` | Integer from 1 through 90. Choose any value above one explicitly. |
| `annotation-cap` | `10` | Integer from 0 through 50; 50 is the hard maximum. |

Values move from Action expressions into environment variables and then into a shell-free child-process argv array. Branch names, pull-request titles, comments, and other GitHub context strings are never executed. Config and contract paths retain the CLI's workspace-containment, symbolic-link, and regular-file validation.

```yaml
      - name: Guard a non-default contract
        id: uiwitness
        uses: RujitRaval/uiwitness@<full-release-commit-sha> # v0.26.8
        with:
          config: config/uiwitness.config.mts
          contract: contracts/product-states.json
          annotation-cap: 20
```

## Outputs and failure behavior

The Action exports `verdict`, `exit-class`, `report-path`, `contract-digest`, `finding-count`, `matched-count`, and `blocking-count`. Outputs contain stable classifications, paths, digests, and aggregate numbers—not screenshots, diagnostics, commands, or arbitrary user text.

The project-local CLI remains authoritative:

- `0` becomes `verdict=passed` and `exit-class=success`.
- `1` becomes `verdict=failed` and `exit-class=contract-failure`; the job fails.
- `2`, a missing CLI, a version mismatch, or an invalid sidecar becomes `verdict=error` and `exit-class=setup-error`; the job fails.

The step summary includes totals by finding kind and the first 20 findings in canonical order. Known-failure entries include their bounded owner, reason, expiry date, active/expired UTC lifecycle, exact expected/actual codes, and eligibility-aware next step; blocking annotations include the owner and lifecycle context. It is capped deterministically at 512 KiB of UTF-8. Blocking-finding annotations default to 10 and cannot exceed 50. Workflow-command characters and Markdown are escaped, control and default-ignorable Unicode characters in legacy schema-v1 ownership text are rendered as explicit code-point escapes, and two-digit findings retain correctly nested metadata; the complete result remains in `.uiwitness/contract-verdict.json` and the offline report. New annotations reject those characters. Renew expired exact failures locally with a newly annotated `exception:<coordinate>` change and an updated reason. Recovery removes the exception through an `expectation:<coordinate>` change, changed eligible failure codes require a new expectation decision, and ineligible failures must be repaired—nothing renews automatically in GitHub.

Do not convert a nonzero Action result into success. That would hide both product-state regressions and runs that could not prove the contract.

## Sharded matrix execution

For a large unauthenticated matrix, use the reviewed [four-shard workflow example](examples/uiwitness-sharded.yml). One job creates a nonce-bound plan, four matrix jobs publish distinct immutable bundles, and one final job passes every explicit bundle directory to `uiwitness guard merge`. Merge order does not matter; the CLI verifies every manifest header and checksum, exact `1..M` completeness, current config/contract/target/tool identity, plan lifetime, execution assignment, and evidence-path uniqueness before comparison or final publication.

The example deliberately uploads partial evidence because separate jobs need a transfer channel. It pins both artifact Actions to full commits and retains inputs for one day. These bundles can contain screenshots and private route/state inventories, so do not use this pattern for sensitive evidence in a public repository. Authentication remains unsupported for sharded runs. A failed or missing matrix job prevents the merge job from publishing final truth; rerun from a fresh plan rather than reusing an expired or incomplete run set.

## Evidence upload

Evidence upload is off by default. Enable it only when the repository and captured application data are appropriate for GitHub artifact storage:

```yaml
      - name: Guard and retain evidence for one day
        uses: RujitRaval/uiwitness@<full-release-commit-sha> # v0.26.8
        with:
          upload-artifact: true
          retention-days: 1
```

The Action uses the repository's immutable `actions/upload-artifact` revision and uploads the complete `.uiwitness` directory so the offline report keeps its screenshots and sidecars. An explicitly requested upload failure fails the integration job without changing the CLI verdict. Reports can contain screenshots, URLs, application data, and private route/state inventories. Treat artifacts in a public repository as public; use a restricted private repository or keep upload disabled for sensitive evidence.

## Fork safety and permissions

The workflow needs only `contents: read`. A normal `pull_request` run for a fork receives a read-only token and no repository secrets. The Action asks for no write permission and performs no pull-request mutation.

Do not work around missing fork secrets with `pull_request_target` or a secret-bearing `workflow_run` that checks out untrusted contribution code. Environment approval does not sandbox a scenario or authentication module. Keep the ordinary fork `pull_request` guard secret-free. For private states, review the exact commit first, promote that same commit to a branch allowed by a protected environment, require an environment reviewer, and run the authenticated guard there. The auth module reads environment values itself; UIWitness holds the resulting validated storage state only in memory and never creates an auth-state artifact. Use a non-mutating shared account because `shared-readonly` is an operator promise, not a server-side sandbox.

Scenario and config modules are trusted repository code and execute with the job's privileges. UIWitness can keep its own adapter deterministic and injection-safe, but it cannot sandbox code your repository chooses to run.

## Manual scan alternative

Repositories that do not yet maintain `uiwitness.contract.json` may keep a direct `npx --no-install uiwitness scan` step and an explicit immutable `actions/upload-artifact` step. That remains ordinary CLI wiring, not the contract-aware Action. Establish the first reviewed contract with `npx --no-install uiwitness contract init` before switching the pull-request job to the official guard Action.
