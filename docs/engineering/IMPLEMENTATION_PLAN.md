# Implementation Plan

## Phase 1 - Foundation
pnpm workspace, strict TypeScript, packages, build/test/lint, MIT license, initial README, CI skeleton.
**Gate:** clean install and root build/tests pass.

## Phase 2 - Core contracts
Config types/schema, `defineConfig`, validation, matrix planner, deterministic paths, result/report contracts, coverage math, errors.
**Gate:** comprehensive unit tests and stable contracts.

## Phase 3 - Playwright runner
Browser reuse + isolated contexts, scenarios/hooks, viewport/theme, readiness, screenshots, diagnostics, assertions, resilient per-cell execution.
**Gate:** programmatic runner works against a minimal fixture.
**Status:** complete.

## Phase 4 - CLI
`init`, `scan`, `open`, config discovery, `--config`, `--route`, `--headed`, terminal summary, exit codes 0/1/2.
**Gate:** fresh example goes init -> scan -> report.
**Status:** complete; config discovery/loading, overwrite-safe `init`, scan orchestration, summaries, stable exit codes, safe latest-report `open`, and the Phase 5 scan-to-HTML handoff are implemented.

## Phase 5 - Report
Offline HTML, summary, matrix, thumbnails, detail view, filters, responsive/keyboard UX.
**Gate:** no network/server dependency and launch-quality visual output.
**Status:** complete; validated transformation, responsive offline HTML, summary/matrix/evidence, route/state/viewport/theme/status filters, URL-restorable selections, accessible single-execution details, private atomic publication, and CLI scan integration are implemented.

## Phase 6 - Example
Polished Next.js dashboard with `/dashboard`, `/orders`, `/customers/[id]`; meaningful states and intentional defects.
**Gate:** report screenshot makes UIWitness's value obvious.
**Status:** complete; the design system, Next.js foundation, deterministic dashboard, orders and customer contracts, meaningful state surfaces, focused responsive/theme defects, complete 60-cell scan matrix, and four-cell known-failure report gate are implemented.

## Phase 7 - Release
README, CI usage, contributor docs, GIF/screenshots, package metadata, smoke tests.
**Gate:** another developer can use it from docs alone.
**Status:** complete; clean-checkout production build and built-CLI consumer smoke coverage, exact known-failure validation, short-lived report artifacts, documented GitHub Actions usage, public npm packages, artifact-level consumer verification, protected release automation, real report launch assets, and final contributor/release guidance are implemented.

## Approved roadmap - Public URL Quick Check
Bounded same-origin discovery, a fixed public-site evidence matrix, kinetic report presentation, CLI orchestration, and overwrite-safe promotion into permanent UIWitness setup.
**Gate:** a developer can point one command at an authorized live site, receive actionable local evidence, and promote the useful surface without hand-authoring boilerplate.
**Status:** complete; CLI `check <url>` composes discovery, four-cell-per-page evidence capture, page-level summaries, stable exit codes, the offline report, and overwrite-safe `--write-config` promotion. The public launch guide and post-publication registry-only check → promotion → scan → open consumer gate prove the documented journey from an empty npm project.

## Approved roadmap - State Contract Guard
Versioned state contracts, deterministic fresh-run comparison, exact regression reproduction, expiring known failures, a contract-first offline report, a thin GitHub Action, memory-only authentication, evidence privacy controls, and deterministic sharding.
**Gate:** every pull request can prove the complete promised UI state matrix without a hosted backend, required LLM, implicit acceptance, or automatic evidence upload.
**Status:** in progress; T1–T10 are complete. Strict contracts, exhaustive comparison, guard orchestration, proposals, atomic publication, contract-first reporting, the full-SHA-pinned Action, exception governance, memory-only authentication, and fail-closed evidence privacy are implemented. Deterministic sharding, aggregation, final documentation consolidation, and release proof remain T11–T14.

## Rules
Keep main buildable; no speculative abstractions/backend/telemetry/LLM; tests accompany capabilities; record important decisions as ADRs; justify major dependencies.
