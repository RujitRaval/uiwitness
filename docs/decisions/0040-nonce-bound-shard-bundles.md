# ADR 0040: Nonce-bound deterministic shard plans and immutable bundles

## Status

Accepted and implemented on 2026-09-05.

## Context

Large state matrices need parallel execution without allowing independently configured jobs, stale artifacts, or partial evidence to masquerade as one trustworthy guard run. Shards must include current config additions that do not yet exist in the contract, remain isolated from normal report publication, and preserve enough identity for a later aggregator to reject mixed inputs.

## Decision

`uiwitness guard shard-plan` snapshots the complete current config inventory and committed contract into exact canonical JSON. The plan binds a random 128-bit nonce, canonical creation/expiry timestamps, UTC evaluation date, shard count, ordered coordinate IDs, config/contract/target digests, report schema, and tool version. The portable 64-character `runSetId` is the SHA-256 hex of that entire canonical payload. Target identity hashes the normalized base-URL origin plus a non-secret lowercase-kebab environment ID. TTLs are whole minutes from 5 through 1440 and default to 60.

Coordinates use one fixed assignment: the first unsigned big-endian 64 bits of `SHA256(UTF8(coordinateId))`, modulo `M`. CLI shard indexes remain one-based `N/M`. The planner warns when the largest shard exceeds 1.5 times the mean but never changes assignment. Authentication is rejected during both planning and shard startup; authenticated sharding needs a separately approved secret-safe design.

Each shard rereads and verifies the exact plan, current config, current contract, target, report schema, tool version, `N/M`, and active lifetime before browser work. It executes every assigned current-config coordinate exactly once. A complete partial run publishes `.uiwitness/shards/<runSetId>/<n>-of-<m>/` using exclusive creation. The bundle contains `report.json`, retained evidence under `evidence/artifacts/`, SHA-256/byte descriptors, the plan's non-secret environment ID, and canonical `manifest.json` written last as the commit marker. Existing bundle paths are hard errors. Shards never take the complete-report lock, update `.uiwitness/generation.json`, replace `.uiwitness/report/`, compare a partial report, create proposals, or issue a final contract verdict.

Completed shard bundles exit successfully even when their report records failed cells. Those failures are merge input, not a partial verdict. Invalid setup, expiry, drift, or publication fails closed.

## Consequences

- Every shard can run concurrently from one shared plan while keeping output paths isolated and immutable.
- Interrupted bundles lack `manifest.json` and cannot be treated as complete.
- The nonce prevents unrelated invocations with identical config/contract inputs from sharing a run set.
- T12 remains responsible for checksum verification, complete-set validation, deterministic aggregation, one comparison, and final generation publication.
- Rollback is operationally simple: stop invoking shard commands and continue using the existing complete `uiwitness guard`; ignored shard bundles do not affect the latest report.
