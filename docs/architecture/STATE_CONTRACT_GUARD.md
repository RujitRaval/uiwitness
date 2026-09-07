# State Contract Guard Architecture

This document is the technical map for the shipped State Contract Guard. The [operator guide](../open-source/STATE_CONTRACT_GUARD.md) owns task-oriented usage; this document owns package boundaries, state transitions, failure routing, and publication semantics.

## System architecture

```mermaid
flowchart LR
  Repo[Config, scenarios, contract] --> CLI[uiwitness CLI]
  CLI --> Core[uiwitness-core\nvalidation, digests, comparison]
  CLI --> Runner[uiwitness-runner-playwright\nfresh isolated cells]
  Runner --> Core
  Core --> Verdict[Verdict and optional proposal]
  Runner --> Report[uiwitness-report\noffline HTML]
  Verdict --> Tx[Runner generation transaction]
  Report --> Tx
  Runner --> Tx
  Tx --> Local[Private .uiwitness generation]
  Action[Full-SHA-pinned Action] --> CLI
```

The Action is a presentation adapter, not a fifth product implementation. It locates the adopting repository's locked CLI, proves version parity, and translates the process result into bounded GitHub output.

## Data and shadow paths

The contract is the only version-controlled product promise. Everything under `.uiwitness/` is private operational evidence or crash-recovery state.

```mermaid
flowchart TB
  C[uiwitness.config.mts] --> I[Current coordinate inventory]
  S[Trusted scenarios] --> R[Fresh complete browser run]
  A[Optional memory-only auth] -. no serialized state .-> R
  I --> R
  K[uiwitness.contract.json] --> X[Contract comparison]
  R --> X
  X --> V[contract-verdict.json]
  X --> P[Immutable proposal source and candidate]
  P --> M[Separate metadata overlay]
  R --> E[Report, screenshots, evidence manifest]
  V --> G[Generation transaction]
  P --> G
  M --> G
  E --> G
  G --> L[generation.json published last]
```

Credentials, cookies, local storage, authorization headers, setup return values, raw request bodies, and unredacted diagnostics have no UIWitness-owned persistence path.

## Generation and proposal state machine

```mermaid
stateDiagram-v2
  [*] --> Validating
  Validating --> Running: inputs safe
  Validating --> SetupError: invalid or unsafe
  Running --> Comparing: complete fresh run
  Running --> Incomplete: run cannot prove completeness
  Comparing --> Matching: contract matches
  Comparing --> ReviewRequired: regression, recovery, expiry, or drift
  Matching --> Staging
  ReviewRequired --> Staging: include immutable proposal family
  Staging --> Publishing
  Publishing --> Committed: marker last
  Publishing --> PriorGeneration: rollback or recovery
  Committed --> Accepted: named proposal changes revalidated
  Accepted --> [*]: proposal consumed
  SetupError --> [*]
  Incomplete --> [*]
  PriorGeneration --> [*]
```

Guard and acceptance share the lock order: contract-writer lock, then runner generation lock. Acceptance regenerates the proposal from its source and revalidates the committed marker before changing the contract.

## Shard state machine

```mermaid
stateDiagram-v2
  [*] --> Planned: fresh nonce-bound plan
  Planned --> Expired: TTL exceeded
  Planned --> Sharding: exact N/M worker starts
  Sharding --> Bundle: manifest written last
  Sharding --> Rejected: identity or authentication mismatch
  Bundle --> Aggregating: every 1..M bundle supplied
  Aggregating --> Rejected: missing, duplicate, mixed, drifted, linked, extra, or corrupt
  Aggregating --> Comparing: coherent complete aggregate
  Comparing --> Committed: ordinary final generation transaction
  Expired --> [*]
  Rejected --> [*]
  Committed --> [*]
```

Partial bundles never update the latest report, verdict, proposal, or generation marker. The aggregator normalizes executions into current configuration order, so arrival order cannot affect final meaning.

## Error flow

```mermaid
flowchart TD
  Start[Command] --> Usage{Usage and paths valid?}
  Usage -- no --> E2[Exit 2\nno new authoritative truth]
  Usage -- yes --> Complete{Fresh result complete?}
  Complete -- no --> E2
  Complete -- yes --> Match{Promise matches?}
  Match -- yes --> E0[Exit 0\ncommitted matching generation]
  Match -- no --> E1[Exit 1\ncommitted evidence, verdict, proposal]
  E1 --> Decision{Accidental or intended?}
  Decision -- accidental --> Repair[Repair product or test, rerun guard]
  Decision -- intended --> Review[Inspect, optionally annotate, accept named change]
  Review --> Rerun[Run complete guard again]
```

Exit `2` is never equivalent to a product failure or success. It means the system could not prove the contract.

## CI deployment sequence

```mermaid
sequenceDiagram
  participant PR as Pull request
  participant App as Application
  participant Action as Pinned Action
  participant CLI as Project-local CLI
  participant Runner as Runner/Core/Report
  participant GH as GitHub output
  PR->>App: build and start reviewed commit
  PR->>Action: invoke full release SHA
  Action->>CLI: verify exact release version
  CLI->>Runner: run complete guard
  Runner-->>CLI: committed local verdict generation
  CLI-->>Action: exit 0, 1, or 2 plus exclusive sidecar
  Action-->>GH: bounded outputs, summary, annotations
  opt repository owner explicitly enables upload
    Action-->>GH: upload complete .uiwitness bundle
  end
```

This is CI integration, not SaaS deployment. UIWitness itself has no hosted service or production data plane.

## Publication rollback flow

```mermaid
flowchart TD
  Stage[Stage and fsync all members] --> Swap[Journal bounded swaps]
  Swap --> HTML[Publish report HTML last among report members]
  HTML --> Marker[Publish generation marker last overall]
  Marker --> Done[Generation authoritative]
  Stage -. failure .-> Preserve[Preserve prior generation]
  Swap -. interruption .-> Recover[Authenticate journal and inspect marker]
  HTML -. interruption .-> Recover
  Marker -. cleanup interruption .-> Recover
  Recover --> Valid{Committed marker and manifest valid?}
  Valid -- yes --> Keep[Keep committed generation; finish cleanup]
  Valid -- no --> Hide[Hide marker first]
  Hide --> Restore[Durably restore prior coherent members]
  Restore --> Preserve
```

An operator rollback restores a reviewed contract or matching Action/package release through version control. It does not manually transplant generated evidence.

## Report information architecture

```mermaid
flowchart TB
  Hero[Contract verdict\nPROMISE KEPT / CONTRACT BROKEN / RUN INCOMPLETE]
  Findings[Canonical findings\nexpected vs actual, owner, lifecycle, commands]
  Matrix[Evidence matrix\nroute × state × viewport × theme]
  Inspector[Dominant screenshot and diagnostics inspector]
  Details[Contract, run, privacy, shard, and generation digests]
  Hero --> Findings --> Matrix --> Inspector --> Details
```

Ordinary `scan` and `check` omit the contract layer and keep the execution-first report. Guard adds contract truth above the same evidence matrix; it does not create a separate dashboard or hide complete no-script output.

## Package ownership

| Surface | Owner |
| --- | --- |
| Config, contract, proposal, shard schemas and canonical comparison | `uiwitness-core` |
| Browser lifecycle, capture, privacy enforcement, bundles, aggregation, atomic persistence | `uiwitness-runner-playwright` |
| Offline report transformation and rendering | `uiwitness-report` |
| Workspace policy, commands, fingerprints, orchestration, terminal behavior, acceptance | `uiwitness` |
| Hosted summary, annotations, version handshake, optional upload | root `action.yml` and composite scripts |

No browser behavior enters core comparison, no comparison policy enters the runner, no execution semantics enter the renderer, and no product implementation is duplicated in the Action.

## Bounds and invariants

- At most 10,000 configured coordinates.
- Shard plan TTL is 5–1440 minutes; default 60.
- Aggregate manifest reads stay within 16 MiB before report/evidence content.
- Declared aggregate report/evidence content is capped at 256 MiB before content reads.
- Every accepted bundle set is exactly one coherent `1..M` assignment union.
- New runner-owned files and directories are owner-private where supported.
- The committed marker is authoritative only when its content-addressed manifest and members validate.
- T14, not this architecture document, owns proof from packed packages, the released Action SHA, npm provenance, and a registry-only consumer.
