# Product Requirements Document

## Vision
UIWitness should define **UI product-state coverage**. Visual regression asks whether pixels changed; UIWitness asks whether important states exist and work across realistic conditions.

## Problem
Production UIs routinely fail outside happy-path seed data: loading, empty, API failure, offline, unauthorized, long content, partial data, responsive layouts, and themes. These states are difficult to inspect systematically and are often skipped by humans and coding agents.

## Users
Primary: frontend/full-stack engineers, solo and AI-assisted developers, open-source maintainers. Secondary: QA, product designers, design-system teams, engineering managers.

## Core job
Given explicit routes and scenarios, render the configured matrix of route x state x viewport x theme, capture evidence and diagnostics, and generate a polished local report.

## MVP
Local TypeScript/Node CLI; Playwright; type-safe config/scenarios; arbitrary named states; viewports/themes; isolated contexts; PNG screenshots; console/page/request diagnostics; assertions; configured-state coverage; offline HTML + versioned JSON; init/scan/open; stable exit codes; Next.js example; GitHub Actions documentation.

## Non-goals v0.1
No SaaS, accounts, cloud storage, billing, LLM requirement, automatic route/state discovery, pixel diffing, approval workflow, or broad framework support.

## Approved roadmap exception
The Public URL Quick Check adds bounded, navigation-only route discovery for authorized public sites. It checks one `public` state across a fixed mobile/desktop by light/dark matrix and does not infer application states or replace explicit configured scans. Discovery, persisted evidence, `uiwitness check <url>` orchestration, overwrite-safe `--write-config` promotion, public launch guidance, and the registry-only check → promotion → scan → open consumer release gate are implemented.

The approved State Contract Guard roadmap adds versioned UI promises without a hosted backend. T1–T10 are complete, including deterministic contract comparison, explicit exception governance, atomic local generations, the pinned GitHub Action, memory-only authentication, and fail-closed screenshot masks with explicit retention. Sharding and aggregation remain later approved slices.

## Success
A new developer can install, configure a few states, run one command, and understand a visually obvious UI problem from the report without author assistance. The report is strong enough to be the primary README/launch asset.

## Principles
Local-first; deterministic; explicit before magical; progressive adoption; small API; Playwright escape hatches; extensible architecture; excellent defaults.

## Recommended vocabulary
`success`, `loading`, `empty`, `error`, `offline`, `unauthorized`, `forbidden`, `not-found`, `partial`, `stale`, `long-content`, `large-data`, `slow-network`. Domain-specific IDs remain valid.
