# ADR 0039: Fail-closed evidence masking and explicit retention

## Status

Accepted and implemented on 2026-09-05.

## Context

Authenticated product states can expose personal or confidential data in screenshots. A selector typo, missing private field, or screenshot failure must never cause UIWitness to capture an unmasked fallback. Teams also need to keep only failing screenshots, or no screenshots at all, without making a missing file ambiguous.

## Decision

Configuration may declare named masks with exact route/state scopes, required presence, and optional exact cardinality. For `all` and `failures-only`, applicable selectors resolve after readiness and before assertions. The runner marks the exact matched DOM nodes, masks those stable markers with opaque `#0b0c0a`, verifies identity/cardinality again after capture, and discards bytes on any drift. Invalid selectors, required zero matches, cardinality mismatch, and masked capture failure produce stable blocking codes. No masked failure retries without masks, and only successfully completed masked screenshots contribute cardinalities.

Retention defaults to `all`. It preserves report schema v1. `failures-only` captures before assertions but discards passing bytes before staging; `none` performs no mask resolution or screenshot call. Those privacy policies emit schema v2 with an explicit `screenshot.status` of `captured`, `omitted-by-policy`, or `capture-failed`.

Every run atomically publishes `.uiwitness/report/evidence-manifest.json`. Its canonical schema-v1 record contains the policy, attempted/retained/omitted counts, successful mask IDs and cardinalities, and report/verdict/generation identity digests. It never stores selectors, matched text, or DOM content. The enclosing generation manifest advances to schema v2 and requires exactly one immutable evidence-manifest member at that path; the source-compatible schema-v1 reader and closed role vocabulary remain unchanged. The privacy panel renders only when its digest, retention, and counts bind to the exact report. The manifest and panel join the existing crash-recoverable generation transaction.

The current reader and renderer accept report schemas v1 and v2. Existing schema-v1-only readers remain compatible with default `all` runs but must upgrade before consuming privacy-policy output.

## Consequences

- Privacy failures block a cell and cannot silently weaken capture.
- `none` can run with structurally valid masks even when those selectors do not exist in the DOM.
- Default users retain the established screenshot-led v1 contract.
- Evidence consumers can distinguish deliberate omission from capture failure and audit retained bytes without learning private selector contents.
