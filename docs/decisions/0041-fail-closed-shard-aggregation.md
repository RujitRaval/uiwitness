# ADR 0041: Fail-closed shard aggregation and single final publication

## Status

Accepted and implemented on 2026-09-06.

## Context

Immutable shard bundles make parallel capture possible, but no partial result is contract truth. A trustworthy aggregator must detect missing, duplicated, mixed, expired, drifted, corrupted, or overlapping inputs before comparison, and privacy-aware shards must carry enough non-secret capture metadata to reproduce the final evidence manifest.

## Decision

`uiwitness guard merge --input <bundle>...` is the sole sharded finalization path. It accepts explicit workspace-contained bundle directories in any arrival order. Input count is checked before path work; manifests load sequentially within a 16 MiB aggregate budget and declare at most 256 MiB of report/evidence content before any content read. Before parsing report semantics or acquiring the final publication lock, the runner validates canonical manifests, exact directory identity, one complete `1..M` set, common run-set/version/digest headers, the reconstructed nonce-bound plan, fixed assignments, current config inventory, contract, target, report schema, tool version, lifetime, unique evidence paths, exact file trees, byte counts, and SHA-256 checksums. Reports then must exactly cover their assigned coordinates and agree with current coordinate metadata and base URL. The plan lifetime is checked again after the final lock is acquired.

Bundle-manifest schema v2 adds privacy-safe capture totals and mask ID/cardinality aggregates. It contains no selectors, DOM content, or captured values. This lets aggregation reproduce the same final evidence-manifest semantics for `all`, `failures-only`, and `none` retention. The plan and CLI tool-version bindings intentionally reject older schema-v1 bundles rather than heuristically migrate partial evidence.

After complete validation, the CLI holds the contract-writer lock and the runner takes the existing generation lock. Aggregated executions are restored to current deterministic configuration order for unsharded report equivalence, compared once using the coordinator's UTC `evaluatedOn`, and published through the existing crash-recoverable transaction with report, evidence, verdict, proposal family when needed, evidence manifest, HTML, generation manifest, and committed marker. Bundle directories remain immutable inputs and are not deleted or promoted individually.

## Consequences

- Input arrival order cannot change the normalized report or contract verdict.
- Any incomplete, mixed, expired, version-drifted, path-colliding, or checksum-invalid set exits as setup error without a new visible generation.
- A complete aggregate has the same proposal and acceptance semantics as an unsharded guard; no partial proposal can exist.
- GitHub remains an optional transport example rather than a core dependency, and artifact upload remains explicit.
- Rollback remains `uiwitness guard` without shard commands; existing ignored bundles do not affect final truth.
