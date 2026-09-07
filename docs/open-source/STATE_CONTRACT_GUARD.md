# State Contract Guard

State Contract Guard turns an explicit UIWitness matrix into a reviewed product promise. It runs the complete matrix, compares the fresh result with `uiwitness.contract.json`, and publishes one local verdict plus the evidence needed to reproduce or review every difference.

The workflow stays local-first: no account, hosted backend, required LLM, telemetry, automatic contract mutation, or automatic evidence upload.

## Choose the right command

| Goal | Command | Mutates the contract? |
| --- | --- | --- |
| Explore an authorized public site | `uiwitness check <url>` | No |
| Run configured evidence without contract enforcement | `uiwitness scan` | No |
| Create the first reviewed promise | `uiwitness contract init` | Creates only an all-pass contract |
| Enforce the committed promise | `uiwitness guard` | No |
| Review one proposed change | `uiwitness contract inspect` | No |
| Attach ownership to an eligible known failure | `uiwitness contract annotate` | Metadata only |
| Accept named proposed changes | `uiwitness contract accept` | Yes, named changes only |
| Split a large unauthenticated guard | `guard shard-plan`, `guard --shard`, `guard merge` | Only final named acceptance can mutate it |

`check` and `scan` remain evidence workflows. They never create or update a contract. Guard always evaluates one complete fresh run; it never compares a stale report.

The contract and sharding command grammar is:

```text
uiwitness guard shard-plan --shards <M> --out <path>
uiwitness guard --shard <N/M> --shard-plan <path>
uiwitness guard merge --input <shard-bundle>...
uiwitness contract init [--config <path>] [--contract <path>]
uiwitness contract inspect --candidate <path> --change <id>
uiwitness contract annotate --candidate <path> --change <id>
uiwitness contract accept --candidate <path> --change <id>...
```

The sections below add the applicable optional arguments and safe operating rules.

## Establish the first contract

Start with an explicit `uiwitness.config.mts` and deterministic scenarios. Run an ordinary scan until the matrix describes the product you intend to promise, then initialize:

```bash
npx --no-install uiwitness scan
npx --no-install uiwitness contract init
git add uiwitness.contract.json
git commit -m "test: establish UI state contract"
```

Initialization exclusively creates `uiwitness.contract.json` only when every coordinate passes. It never overwrites an existing contract. If a complete run has failures, it exits `1` and publishes an immutable proposal for review instead of silently recording failures as expected.

```text
uiwitness.config.mts + scenarios
              │
              ▼
      complete fresh run
          │         │
    all pass       failure
          │         │
          ▼         ▼
uiwitness.contract.json   .uiwitness/contract-candidates/<digest>.proposal.json
```

Commit the contract. Keep `.uiwitness/` ignored: proposals, reports, screenshots, private route inventories, and diagnostics belong to local evidence, not source control.

## Enforce the promise

Run the whole matrix from the repository root:

```bash
npx --no-install uiwitness guard
```

Useful contained overrides are:

```bash
npx --no-install uiwitness guard --config config/uiwitness.config.mts
npx --no-install uiwitness guard --contract contracts/product-states.json
npx --no-install uiwitness guard --json artifacts/contract-verdict.json
```

Guard paths must remain inside the invocation workspace through ordinary, non-symbolic-link boundaries. An explicit `--json` path is an additional no-clobber copy; `.uiwitness/contract-verdict.json` remains the canonical local sidecar.

### Exit codes

| Code | Meaning | Operator action |
| --- | --- | --- |
| `0` | The complete fresh run matches the contract, including exact active known failures. | Continue the pipeline. |
| `1` | The run completed, but found a regression, recovery, expiry, or unaccepted config/matrix drift. | Reproduce, repair, or review named proposal changes. |
| `2` | Usage, input, setup, authentication, completeness, safety, or internal failure prevented proof. | Repair the run; never treat it as a product verdict. |

Executable findings include an exact headed reproduction command such as:

```bash
npx --no-install uiwitness scan --coordinate 'orders/error/mobile/dark' --headed
```

Structural drift deliberately has no fake reproduction command. Inspect the proposal and configuration instead.

## Review and accept change

A failed complete guard publishes a content-addressed proposal. Copy the exact candidate path and change ID printed by the CLI or report:

```bash
npx --no-install uiwitness contract inspect \
  --candidate .uiwitness/contract-candidates/<digest>.proposal.json \
  --change expectation:orders/error/mobile/dark
```

Repair accidental regressions and rerun guard. For an intentional product change, accept only the reviewed IDs:

```bash
npx --no-install uiwitness contract accept \
  --candidate .uiwitness/contract-candidates/<digest>.proposal.json \
  --change config:orders/error/mobile/dark \
  --change expectation:orders/error/mobile/dark
```

Acceptance revalidates the current config, contract, proposal source, committed generation, dates, and digests under the writer locks. It applies only the named changes, consumes the proposal and metadata, and discards unselected changes. A new complete guard is required to reconsider anything discarded.

Never edit proposal JSON. Its filename and canonical bytes are bound by digest. Review metadata lives in a separate constrained overlay so ownership cannot change proposal identity.

## Govern known failures

Only exact eligible failure-code sets can become temporary known failures. Annotate one eligible proposed expectation before accepting it:

```bash
npx --no-install uiwitness contract annotate \
  --candidate .uiwitness/contract-candidates/<digest>.proposal.json \
  --change expectation:orders/error/mobile/dark \
  --owner quality-team \
  --reason UIW-2041 \
  --created-on 2026-09-06 \
  --expires-on 2026-09-20
```

Owner and reason must be non-secret review identifiers. The expiry window is 1–30 days. Terminal, JSON, offline HTML, and Action output show the owner, reason, UTC lifecycle, and exact expected/actual codes.

- An exact failure stays known only through its UTC expiry date.
- An expired exact failure requires a fresh `exception:<coordinate>` annotation with a changed reason and current dates.
- Recovery creates an `expectation:<coordinate>` change that removes the exception.
- Added, removed, or substituted eligible codes require a new expectation decision.
- Infrastructure and other ineligible failures must be repaired.
- Dates never renew automatically.

## Protect credentials and evidence

Authentication is optional and unsharded. Declare one trusted local setup module:

```ts
authentication: {
  setup: "./uiwitness/auth.mjs",
  mode: "shared-readonly",
}
```

The module reads credentials directly from the environment or secret manager and logs in once. UIWitness validates Playwright storage state and deep-copies it in memory into each fresh cell context. It never creates an authentication-state file. Setup and scenario modules are trusted arbitrary code, so run them only from reviewed commits and use a non-mutating account.

Screenshot retention defaults to `all`. Use `failures-only` to retain failed-cell images or `none` to disable screenshots and mask-selector resolution. Named `evidence.masks` fail closed: missing required nodes, cardinality drift, DOM identity drift, invalid selectors, or capture failure discard the bytes and never retry unmasked.

Default `all` reports retain schema v1 compatibility. Explicit privacy policies use report schema v2, where screenshot status distinguishes retained, policy-omitted, and capture-failed evidence. Every completed run writes a selector-free evidence manifest.

## Run in GitHub Actions

Use the [copy-ready GitHub Actions guide](GITHUB_ACTIONS.md). Lock an exact released `uiwitness` dependency and pin the matching Action to its full 40-character release commit SHA. The Action runs only the project-local CLI, checks version parity before browser work, preserves exit classes, requests only `contents: read`, and leaves evidence upload off by default.

Fork pull requests must remain secret-free. Do not use `pull_request_target` or a secret-bearing `workflow_run` to execute untrusted contribution code. Run private authenticated coverage only for an exact reviewed commit on a protected trusted branch or environment.

## Shard a large matrix

Sharding is only for unauthenticated guards. Create a fresh plan, run every exact shard against that same plan, and merge every immutable bundle before accepting any change:

```bash
npx --no-install uiwitness guard shard-plan \
  --shards 4 \
  --out .uiwitness/shard-plan.json \
  --environment-id ci \
  --ttl 60m

npx --no-install uiwitness guard \
  --shard 1/4 \
  --shard-plan .uiwitness/shard-plan.json

npx --no-install uiwitness guard merge \
  --input .uiwitness/shards/<run-set-id>/1-of-4 \
  --input .uiwitness/shards/<run-set-id>/2-of-4 \
  --input .uiwitness/shards/<run-set-id>/3-of-4 \
  --input .uiwitness/shards/<run-set-id>/4-of-4
```

Create a new plan for every run. Plans expire after 60 minutes by default and accept 5–1440 whole minutes. Partial bundles return `0` even when they contain failed cells because they are merge inputs, not verdicts. Only a complete coherent merge publishes final truth. Missing, duplicate, mixed, expired, drifted, linked, extra, or checksum-invalid input exits `2` without replacing the previous committed generation.

For separate CI jobs, use the reviewed [four-shard workflow](examples/uiwitness-sharded.yml). Bundle transfer is an explicit evidence upload and should use the shortest useful retention period.

## Read the output

One successful finalization publishes a coherent generation:

```text
.uiwitness/
├── artifacts/                 retained PNG evidence
├── contract-candidates/       immutable proposals + metadata overlays
├── contract-generations/      immutable proposal source snapshots
├── contract-verdict.json      deterministic machine verdict
├── generation.json            stable committed-generation marker, published last
├── generations/               content-addressed generation manifests
├── shards/                    immutable partial bundles, when sharding
└── report/
    ├── evidence-manifest.json privacy policy, counts, mask IDs, and digests
    ├── index.html             self-contained offline report
    └── uiwitness.json         report schema v1 or v2
```

The report leads with `PROMISE KEPT`, `CONTRACT BROKEN`, or `RUN INCOMPLETE`, followed by the canonical finding ledger and then the evidence matrix. It requires no server, account, network request, or external asset.

Open it locally:

```bash
npx --no-install uiwitness open
```

## Recover and roll back

Runner publication is crash-recoverable. The stable generation marker is published last; an interrupted or invalid generation never becomes authoritative. Recovery hides an incomplete marker first and restores the prior coherent output set when safe. Ambiguous recovery data is preserved instead of risking the last good generation.

To roll back contract intent, restore a reviewed earlier `uiwitness.contract.json` through normal version control, rerun the complete guard, and review the new result. Never copy an old `.uiwitness/` generation into place or reuse an expired shard plan.

To roll back the Action, pin both the dependency and full Action SHA to the same prior known-good release and rerun the consumer proof. Every normal release exercises that matching pair from packed artifacts on Node 22 and 24 before publication, then verifies provenance and registry consumers after publication.

## Compatibility boundaries

- Existing schema-v1 contracts remain readable.
- Configurations without authentication or explicit evidence policy retain the original coordinate fingerprint.
- Adding authentication or explicit evidence policy activates fingerprint v2 and appears as reviewable config drift.
- Default retention `all` keeps report schema v1; `failures-only` and `none` produce report schema v2.
- `check` stays outside contract mutation; promote its routes, add meaningful private states, then initialize a contract.
- Authentication and sharding cannot be combined.
- Contracts protect configured state coverage and outcomes, not pixel baselines.

For exact executable and programmatic contracts, see the [CLI API](../engineering/CLI_API.md), [core API](../engineering/CORE_API.md), [security and privacy model](../engineering/SECURITY_PRIVACY.md), and [architecture diagrams](../architecture/STATE_CONTRACT_GUARD.md).
