# Report UX Specification

The report is UIWitness's primary product surface and launch asset.

## Header
Product name, "UI State Coverage Report", a viewport-scale evidence verdict, passed/expected executions, execution coverage, and generation metadata. Routes, states, executions, passed, failed, and duration form one ruled run tape rather than separate cards.

When a State Contract Guard verdict is present, contract truth replaces execution coverage as the first message: `PROMISE KEPT`, `CONTRACT BROKEN`, or `RUN INCOMPLETE`. The hero shows matched/promised coordinates and the canonical contract vocabulary before the existing execution tape. Ordinary `scan` and `check` reports keep the original evidence-first header.

## Contract findings

Guard reports place all non-ordinary-match findings before the evidence matrix in canonical order. Regressions and incomplete runs use vermilion signal fracture; unaccepted drift, active known failures, recovery, and expiry use warning amber; color is never the only cue. Every row names the exact coordinate, expected and actual outcome, optional exception owner/reason/window, and only the commands valid for that finding. Executable findings include reproduction; structural findings do not invent one. Incomplete runs show every stable machine reason with a deterministic plain-language explanation, including whether a coordinate is absent, duplicated, unexpected, or the run was declared incomplete.

Commands remain selectable plain text without JavaScript. With JavaScript enabled, a 44-pixel copy control uses the constant CSP-pinned script and announces feedback through a polite live region. Stable finding anchors support offline deep links. A ruled native disclosure exposes the full contract, configuration, and semantic-run digests plus evaluation date and completeness.

## Matrix
Rows = route/state. Columns = viewport/theme. Each available cell shows status + a large screenshot frame in a horizontally navigable evidence field. Failures use the controlled signal-fracture treatment without obscuring screenshots.

## Detail view
Selecting a cell opens a viewport-scale inspection room with the full screenshot first; route/URL, state, viewport, theme, duration, status, and scenario source second; and failures, console errors, page errors, and failed requests as ruled disclosures below.

## Filters
Route, state, viewport, theme, pass/fail.

The contract finding ledger separately combines coordinate-text search with an exact finding-type select. Valid selections round-trip through the local URL, visible counts update in a polite live region, and reset/no-match states make recovery explicit without changing the evidence-matrix filters.

## Constraints
Fully offline; no CDN/server/font request; bundled CSS/JS; responsive; keyboard usable; screenshots dominate; purposeful finite motion only; reduced-motion safe; full-bleed and explicitly not dashboard-heavy.

At 760 pixels and below, each finding becomes a single reading stream. At 320 pixels, long coordinates, commands, and digests wrap without horizontal page scroll. No-script mode keeps every finding, command, digest, matrix cell, and execution detail readable.

## Launch test
A report screenshot should explain UIWitness before a developer reads the README.

## Phase 5 delivery

The report includes validated transformation plus a responsive offline document with the editorial verdict, ruled run tape, evidence matrix, full evidence, metadata, failures, and counted diagnostic disclosures. Native route/state/viewport/theme/status filters combine predictably, preserve their state in the local URL, announce result counts, and provide a clear reset/no-match path. A keyboard-accessible inspection room shows one execution at a time and supports Escape, return focus, hashes, browser history, and dialog semantics while open. Inline CSS and a CSP-hashed constant script require no external asset, network request, or server. Phase 5 is complete; the kinetic evidence visual system is documented in `DESIGN.md` and `docs/design/BRAND_RESEARCH.md`.

## State Contract Guard T6 delivery

The renderer accepts an optional validated schema-v1 contract verdict without changing the schema-v1 execution report. The Playwright runner derives guard HTML from the exact canonical verdict sidecar inside the same crash-recoverable generation transaction, so report, evidence, verdict, proposal family, manifest, and committed marker cannot describe different runs. Contract status and findings lead; contract findings have their own coordinate and type filters, while the existing execution filters, matrix, inspection room, diagnostics, CSP, no-network boundary, and progressive no-script behavior remain intact.

## State Contract Guard T10 delivery

Privacy-policy reports distinguish a retained screenshot, policy-driven omission, and capture failure instead of rendering every absent image alike. A no-script privacy panel names the retention policy, attempted/captured/omitted totals, and successful mask IDs/cardinalities only after the selector-free evidence manifest binds to the exact report digest and counts. Default `all` output remains schema v1; `failures-only` and `none` use report schema v2 without changing the existing visual hierarchy, filters, offline boundary, or keyboard behavior.
