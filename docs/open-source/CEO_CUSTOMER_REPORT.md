# UIWitness CEO Report and Customer Launch Playbook

- **Status date:** September 10, 2026
- **Original adoption snapshot:** September 7, 2026
- **Repository:** [RujitRaval/uiwitness](https://github.com/RujitRaval/uiwitness)
- **Current public release:** [`v0.26.13`](https://github.com/RujitRaval/uiwitness/releases/tag/v0.26.13) / npm `0.26.13`
- **Source baseline:** `0.26.17`, including the completed community cleanup and sharp security update
- **This report's release candidate:** `0.26.18` (source version; not a published npm release)

**Audience:** CEO/founder, launch owner, product and engineering leaders, prospective customers, design partners, and new repository visitors

## Executive summary

UIWitness is an open-source, local-first developer tool for **UI product-state coverage**. It answers a question that ordinary screenshot regression tools do not answer well:

> What happens to every important screen when the product is loading, empty, broken, offline, unauthorized, unusually long, viewed on a narrow screen, or rendered in another theme?

The product turns explicit UI promises into repeatable browser evidence. It renders a configured matrix of routes, states, viewports, and themes with Playwright; runs assertions; captures screenshots and sanitized diagnostics; calculates coverage; and generates one polished offline report. Its State Contract Guard can then protect the reviewed matrix in pull requests without a hosted service, account, database, required AI model, or automatic upload.

The core product is complete and publicly distributed. The original seven implementation phases, the Public URL Quick Check roadmap, the UIWitness rename and distribution cutover, and all fourteen State Contract Guard slices are complete. Four public npm packages exist at `0.26.13`. The protected release ran the exact packed package set and matching GitHub Action revision on Node.js 22 and 24, published through token-free OpenID Connect (OIDC), verified npm signatures and provenance, and repeated the registry-only `check → promotion → scan → open` journey on both supported Node lines.

The project has crossed the **technical launch** line. It has not yet crossed the **market-validation** line. As of this report:

- The repository is public, licensed under MIT, documented, protected, and green on its latest `main` checks.
- The public `uiwitness` package is available at `0.26.13` with registry provenance.
- The September 7 snapshot recorded 70 commits, 42 architecture decision records, four public packages, and 80 test/type-contract files. Subsequent cleanup and maintenance are recorded in the changelog.
- GitHub stars, forks, and watchers remained at zero when rechecked on September 10. The external pilot remains open.
- npm recorded 276 downloads for `uiwitness` in the August 31–September 6 window, but registry downloads are not equivalent to unique users and may include release and CI activity.
- No completed unassisted external-user observation is recorded yet.
- [Issue #72](https://github.com/RujitRaval/uiwitness/issues/72) is the correct next gate: one developer who did not build UIWitness should run Quick Check on an authorized site using only the public documentation and report where the experience is confusing or useful.

### CEO decision

Proceed with a **controlled customer-validation launch now**. Do not open a new feature roadmap until the first external pilot has completed.

The product is ready to be put in a customer’s hands for public-site evaluation, configured state coverage, local reports, and contract enforcement. The project should not yet claim broad adoption, enterprise readiness, universal framework coverage, automatic state discovery, or proven retention. The next investment decision should be based on observed user friction and repeated use, not on another internally generated feature list.

## 1. What is this product?

### 1.1 The category

UIWitness defines a category called **UI product-state coverage**.

Visual regression usually asks, “Did this screenshot change from a baseline?” UIWitness asks, “Did every product state we promised still render and behave correctly in every condition we support?” Those are related but different jobs.

| Question | UIWitness | Conventional screenshot regression |
| --- | --- | --- |
| Primary concern | Product-state behavior and coverage | Pixel change from a baseline |
| Unit of work | Route × state × viewport × theme | A screenshot case |
| Typical evidence | Screenshot, assertion, navigation status, console/page/request diagnostics | Baseline image and diff |
| Missing-state model | Explicit configured states only | Usually outside the tool’s model |
| Default operating model | Local, deterministic, offline report | Often runner- or service-specific |
| Contract model | Reviewed UI state contract and deterministic findings | Baseline approval |

UIWitness does **not** claim an unconfigured state is missing. It measures the states a team explicitly chooses to support. This avoids false confidence while making the product promise reviewable.

### 1.2 The customer problem

Production interfaces often fail outside clean seed data and desktop light mode. Common failures include:

- Loading states that never settle or shift the layout.
- Empty states that are unhelpful, broken, or missing calls to action.
- API failures that crash a page instead of showing recovery UI.
- Unauthorized, forbidden, and not-found states that leak data or confuse users.
- Long names, emails, translations, or generated content that overflow narrow layouts.
- Dark-mode contrast failures that do not appear in light mode.
- Responsive states that work on one viewport but fail on another.
- Diagnostics that exist in browser consoles but never reach a product review.
- Pull requests that silently change which product states exist or what outcomes are accepted.

These problems are easy to miss because they require deliberate data, network, authentication, theme, and viewport setup. UIWitness converts that setup into a deterministic matrix and leaves evidence for every exercised coordinate.

### 1.3 The product promise

The simplest positioning is:

> **Find the UI states your product forgot.**

The deeper operational promise is:

> Every configured product state can be rendered, inspected, reproduced, and—when the team is ready—protected as a versioned contract.

### 1.4 Who it is for

Primary users:

- Frontend and full-stack engineers.
- Solo developers and AI-assisted development teams.
- Open-source maintainers.
- Teams already using Playwright that need better state coverage and evidence.

Secondary users:

- Quality engineers who need a repeatable state matrix.
- Product designers reviewing loading, empty, error, responsive, and theme behavior.
- Design-system teams checking resilient component composition in real routes.
- Engineering managers who want a visible contract and stable CI result.

Best early customers are teams with a web application, a few high-value routes, known edge-state risk, and enough engineering ownership to write deterministic Playwright scenarios.

### 1.5 Who it is not for today

UIWitness is not currently:

- A hosted visual testing service.
- A pixel-diff baseline manager.
- An automatic crawler that discovers private application states.
- A no-code QA recorder.
- A general accessibility audit suite.
- A cross-browser matrix service.
- A production monitoring or synthetic uptime platform.
- A collaboration, billing, or approval SaaS.
- A sandbox for untrusted configuration, authentication, or scenario code.
- A complete Storybook, Mock Service Worker, Vue, Svelte, or Angular integration.

### 1.6 How the product works

```text
authorized site or explicit config
              │
              ▼
discover public routes or expand the configured state matrix
              │
              ▼
run isolated Playwright browser cells
              │
              ├── screenshots
              ├── assertions
              ├── navigation status
              └── sanitized diagnostics
              │
              ▼
optional state-contract comparison
              │
              ▼
commit one coherent local evidence/verdict/proposal generation
              │
              ▼
inspect offline report → repair or accept named changes → rerun
```

Each configured `route × state × viewport × theme` combination becomes one cell. A team with three routes, four states, two viewports, and two themes receives 48 explicit executions. Every cell gets a fresh browser context and page; a healthy Chromium process is reused for efficiency.

### 1.7 The four customer journeys

| Journey | Entry command | Outcome |
| --- | --- | --- |
| Public-site evaluation | `uiwitness check <url>` | Bounded same-origin route discovery and four cells per page without config |
| Configured product-state coverage | `uiwitness init`, then `uiwitness scan` | Explicit state matrix, assertions, screenshots, JSON, and offline HTML |
| Contract enforcement | `uiwitness contract init`, then `uiwitness guard` | A committed promise and deterministic pass/fail/error findings |
| Large-matrix CI | `guard shard-plan`, `guard --shard`, `guard merge` | Deterministic unauthenticated parallel execution with one final verdict |

## 2. What has been built so far?

### 2.1 Foundation and public package architecture

The project is a strict TypeScript and pnpm monorepo targeting Node.js `^22.20.0 || ^24.0.0`. It contains four public packages:

| Package | Responsibility |
| --- | --- |
| `uiwitness` | CLI, config discovery, orchestration, terminal behavior, and public entry points |
| `uiwitness-core` | Browser-independent config, matrix, coverage, report, authentication policy, contract, proposal, generation, and sharding contracts |
| `uiwitness-runner-playwright` | Playwright lifecycle, discovery, authentication, capture, persistence, and shard aggregation |
| `uiwitness-report` | Deterministic report transformation and self-contained offline HTML |

The boundaries are intentionally small. Browser behavior stays out of core. Filesystem publication stays out of the report renderer. The GitHub Action delegates to the installed CLI instead of duplicating product logic.

### 2.2 Core configuration and matrix model

Working capabilities include:

- Type-safe `defineConfig` authoring and strict runtime validation.
- HTTP(S) base URL validation, local route definitions, arbitrary named states, named viewports, named themes, readiness, and failure policies.
- Deterministic matrix expansion and filtering.
- Stable route/state/viewport/theme coordinate identities.
- Deterministic, collision-resistant screenshot paths.
- Execution, state, responsive, and theme coverage calculations.
- Versioned report schemas and stable validation errors.
- Canonical JSON and digest contracts for state-contract governance.

### 2.3 Playwright runner

The runner supports:

- One healthy Chromium process with an isolated browser context and page for every cell.
- Browser quarantine and replacement after uncertain cleanup.
- Trusted scenario modules with `beforeNavigate`, `afterNavigate`, and `assert` hooks.
- Direct Playwright `page` and `context` access instead of a large proprietary domain-specific language.
- Same-origin navigation enforcement.
- Theme setup before application scripts, reduced-motion emulation, and arbitrary theme IDs.
- Deterministic readiness based on load, an optional visible selector, and fonts—not blind `networkidle` or required fixed delays.
- Viewport-sized PNG capture.
- Bounded, sanitized console, page-error, failed-request, navigation-status, duration, and assertion evidence.
- Per-cell failure isolation so one bad state does not abort unrelated cells.
- Memory-only shared-readonly authentication for private applications.
- Fail-closed screenshot masking and `all`, `failures-only`, or `none` retention.
- Crash-recoverable, owner-private local publication.

### 2.4 Command-line product

The installed executable supports:

```text
uiwitness init
uiwitness check <url> [--max-pages <1-20>] [--headed] [--write-config]
uiwitness scan [--config <path>] [--route <id> | --coordinate <route/state/viewport/theme>] [--headed]
uiwitness guard [--config <path>] [--contract <path>] [--json <path>]
uiwitness guard shard-plan --shards <M> --out <path> [...]
uiwitness guard --shard <N/M> --shard-plan <path> [...]
uiwitness guard merge --input <shard-bundle>... [...]
uiwitness contract init [--config <path>] [--contract <path>]
uiwitness contract inspect --candidate <path> --change <id>
uiwitness contract annotate --candidate <path> --change <id> [...]
uiwitness contract accept --candidate <path> --change <id>... [...]
uiwitness open
uiwitness --version
uiwitness --help
```

Stable exit semantics are part of the public contract:

- `0`: the requested check passed, or a complete contract matched.
- `1`: execution completed and exposed product failures or unaccepted contract drift.
- `2`: usage, configuration, setup, safety, incomplete-run, authentication, or internal failure prevented a valid verdict.

A completed failure still writes the report. This is essential: exit `1` means useful product evidence exists, not that the tool crashed.

### 2.5 Public URL Quick Check

Quick Check reduces initial setup:

```bash
npx uiwitness check https://example.com
```

It:

- Accepts one credential-free absolute HTTP(S) URL.
- Discovers up to five same-origin HTML pages by default, with a configurable limit from 1 to 20.
- Uses deterministic navigation-only discovery.
- Runs each accepted page at mobile `390×844` and desktop `1440×900`, in light and dark themes.
- Fails cells for unhealthy main responses, missing document responses, page errors, or horizontal overflow greater than one CSS pixel.
- Writes local PNG, schema-v1 JSON, and a kinetic offline report.
- Prints an exact promotion command.
- Can rerun with `--write-config` to create an overwrite-safe permanent config and shared scenario.

Quick Check is an onboarding path, not hidden-state inference. It exercises one public success state and gives the customer a surface to promote into deeper configured coverage.

### 2.6 Offline report

The report is a first-class product surface, not a debug table. It includes:

- An evidence-first verdict.
- A ruled execution tape with pass/fail and coverage signals.
- A route/state matrix aligned across viewports and themes.
- Screenshot thumbnails and a viewport-scale inspection view.
- Route, state, viewport, theme, and status filters with AND semantics.
- URL-restorable filter and detail selections.
- Keyboard focus containment, Escape behavior, focus return, and no-script fallbacks.
- Failures, navigation data, durations, console errors, page errors, and failed requests.
- A contract-first hero and finding ledger when Guard is used.
- A privacy panel for mask and retention evidence after digest validation.

It is self-contained, works from `file://`, requests no CDN or external asset, escapes report-controlled data, and uses a restrictive content security policy with an exact script hash.

### 2.7 State Contract Guard

State Contract Guard turns a reviewed matrix into a versioned product promise.

It provides:

- Strict contract parsing and canonical `sha256:` identity.
- Complete fresh-run comparison; an old report cannot satisfy Guard.
- Deterministic findings for match, regression, missing coordinate, unaccepted addition, config drift, known failure, changed known failure, recovered known failure, expired exception, and incomplete run.
- Exact-coordinate headed reproduction commands for executable findings.
- Immutable, content-addressed proposals when the current result differs from the contract.
- `inspect`, `annotate`, and named `accept` workflows.
- Explicit ownership, reason, creation date, and 1–30 day expiry for eligible known failures.
- No automatic exception renewal.
- One committed generation containing report, evidence, verdict, proposal family, metadata, and digest-bound manifest.
- Locking, validation, rollback, and recovery around contract and evidence publication.
- Deterministic unauthenticated sharding and fail-closed aggregation.

The contract protects configured state outcomes. It does not become a pixel baseline and does not silently approve change.

### 2.8 GitHub Action and continuous integration

The repository ships a thin composite Contract Guard Action. It:

- Resolves only the adopting repository’s installed `uiwitness` executable.
- Requires the package version and Action version to match before browser work.
- Preserves CLI exit classes.
- Emits bounded summaries, stable aggregate outputs, and at most 50 blocking annotations.
- Requests no pull-request write permission.
- Uploads evidence only when the repository owner explicitly opts in.
- Defaults uploaded evidence to one-day retention.
- Avoids reading or executing pull-request titles, comments, or other untrusted GitHub context.

The main branch is protected with strict required checks for Documentation, Quality, Dependency Review, and CodeQL. Administrator enforcement, linear history, and no force pushes or branch deletion are enabled.

### 2.9 Security and privacy model

The enforced model includes:

- No telemetry.
- No automatic report, screenshot, URL, diagnostic, or source upload.
- No hosted account, database, or cloud dependency.
- No persisted authentication storage-state file.
- Sanitized failed-request metadata with credentials, fragments, and query values removed or redacted.
- Bounded diagnostic text and counts.
- Owner-private generated directories and files where supported.
- Workspace containment, canonical path checks, symbolic-link rejection, and hard-link checks at sensitive boundaries.
- Fail-closed masked capture: unsafe selector/cardinality/DOM changes discard bytes and never fall back to an unmasked screenshot.
- Explicit evidence retention policies.
- Release publishing that limits OIDC authority to a minimal protected job after package and browser execution has already completed elsewhere.

The trust boundary is explicit: configuration, scenario, and authentication modules are trusted local code and can execute with the user or CI job’s privileges. UIWitness protects its own serialization and publication paths; it does not sandbox code a repository chooses to run.

### 2.10 Example application and launch evidence

The Northline Next.js example is both a real fixture and a customer demonstration. It contains:

- `/dashboard`: success, loading, empty, and error.
- `/orders`: success, loading, empty, and error.
- `/customers/[id]`: success, loading, unauthorized, forbidden, not-found, error, and long-content.
- Mobile and desktop viewports.
- Light and dark themes.
- Fifteen route/state combinations and 60 total cells.

It deliberately preserves four visible failures:

- Two mobile long-content customer cells expose an overflowing email.
- Two dark-theme orders-error cells expose a contrast failure.

The expected demonstration result is 56 passes, four assertion failures, 60 screenshots, 93.33% execution coverage, 100% state coverage, and 93.33% responsive and theme coverage. These are fixture defects designed to prove detection, not known defects in the UIWitness CLI.

## 3. Delivery history: all completed update eras

The project moved from repository bootstrap to a distribution-proven contract system in 70 commits between August 19 and September 7, 2026. The complete itemized record remains in [`CHANGELOG.md`](../../CHANGELOG.md); this section gives the management view of every shipped version family.

### 3.1 Foundation and core contracts — `0.0.1` through `0.6.0`

| Version | Delivered outcome |
| --- | --- |
| `0.0.1` | Repository workflow, documentation checks, security scanning, dependency review, ownership, and contribution rules |
| `0.1.0` | Reproducible pnpm monorepo, strict TypeScript, ESLint, Vitest, ESM build, CI, and supported Node policy |
| `0.2.0` | Type-safe configuration, runtime validation, stable issues/errors, and first browser-independent public API |
| `0.3.0` | Deterministic matrix expansion and exact filtering |
| `0.4.0` | Portable deterministic screenshot paths with collision and traversal protection |
| `0.5.0` | Execution, state, responsive, and theme coverage calculations |
| `0.6.0` | Strict execution/report contracts, schema v1, deterministic serialization, and diagnostic redaction |

### 3.2 Playwright execution — `0.7.0` through `0.11.0`

| Version | Delivered outcome |
| --- | --- |
| `0.7.0` | Reused browser process, isolated per-cell contexts/pages, cleanup quarantine, and failure continuation |
| `0.8.0` | Typed scenario loading and lifecycle hooks |
| `0.9.0` | Same-origin navigation, pre-script theme setup, reduced motion, and deterministic readiness |
| `0.10.0` | PNG capture, assertions, bounded sanitized diagnostics, and failure policy |
| `0.11.0` | Deterministic persistence, owner-private output, locking, rollback, and recovery |

### 3.3 CLI and report — `0.12.0` through `0.17.0`

| Version | Delivered outcome |
| --- | --- |
| `0.12.0` | Config discovery/loading across supported TS/JS module variants |
| `0.13.0` | Overwrite-safe `init` and executable dispatch |
| `0.14.0` | `scan`, route filtering, headed mode, summaries, and exit codes |
| `0.15.0` | Safe `open` through the operating system browser launcher |
| `0.16.0` | Responsive self-contained offline HTML report and coherent HTML/JSON/PNG publication |
| `0.17.0` | Five report filters, deep-linkable detail view, browser history, responsive and keyboard behavior |

### 3.4 Example application and launch foundation — `0.18.0` through `0.24.2`

| Version | Delivered outcome |
| --- | --- |
| `0.18.0` | Northline Next.js foundation, dashboard states, visual system, and real-browser tests |
| `0.19.0` | Orders states, filters, summaries, URL state, and responsive navigation |
| `0.20.0` | Customer states, runtime-validated fictional data, authorization distinctions, and long-content coverage |
| `0.21.0` | Two narrow deterministic visual defects used to prove detection |
| `0.22.0` | Complete 60-cell matrix and exact 56-pass/four-failure end-to-end gate |
| `0.23.0` | Clean-checkout release smoke, CI evidence artifact, and pre-publication GitHub Actions guide |
| `0.24.0` | Publish-ready package metadata, protected release workflow, tarball consumer smoke, and provenance-enabled publication |
| `0.24.1` | Customer-facing README, reproducible report screenshots, contributor/release docs, and completed Phase 7 |
| `0.24.2` | CommonJS-safe `.mts` starter modules and packed-package four-cell consumer proof |

### 3.5 Public URL Quick Check and report redesign — `0.24.3` through `0.24.11`

| Version | Delivered outcome |
| --- | --- |
| `0.24.3` | Approved zero-config public URL design and authorization boundary |
| `0.24.4` | Bounded deterministic same-origin route discovery |
| `0.24.5` | Fixed public-site evidence matrix, health/overflow assertions, screenshots, and report |
| `0.24.6` | Kinetic evidence report redesign across light/dark and responsive layouts |
| `0.24.7` | `check <url>` orchestration, page-grouped terminal output, and stable exits |
| `0.24.8` | Overwrite-safe `--write-config` promotion into a repeatable project setup |
| `0.24.9` | Customer guide and registry-only `check → promotion → scan → open` release gate |
| `0.24.10` | npm 11 CommonJS consumer compatibility and bounded registry propagation handling |
| `0.24.11` | Fresh-cache online registry revalidation and stronger bounded retry behavior |

### 3.6 UIWitness identity and public distribution — `0.24.12` through `0.25.6`

| Version | Delivered outcome |
| --- | --- |
| `0.24.12` | Approved legacy-to-UIWitness rename plan and executable brand-contract enforcement |
| `0.24.13` | Node 24-compatible evidence upload Action pinning |
| `0.25.0` | New package, CLI, and public TypeScript identities |
| `0.25.1` | New `.uiwitness/` persistence root with legacy read compatibility |
| `0.25.2` | New config/scenario identity, CLI text, and report branding |
| `0.25.3` | Completed example migration and copy-ready customer migration guide |
| `0.25.4` | First-publication bootstrap proof, cleanup gate, immutable release binding, and full registry journey |
| `0.25.5` | Completed external cutover and normal token-free OIDC release path |
| `0.25.6` | Recorded the first normal post-bootstrap release proof |

### 3.7 State Contract Guard and launch reporting — `0.26.0` through `0.26.18`

| Version | Delivered outcome |
| --- | --- |
| `0.26.0` | Strict state contracts, RFC 8785 canonical JSON, deterministic contract digests, and limits |
| `0.26.1` | Exhaustive contract comparison, verdict precedence, known-failure semantics, and 10,000-coordinate benchmark |
| `0.26.2` | `guard`, exact-coordinate replay, fresh-run enforcement, workspace safety, and machine verdicts |
| `0.26.3` | Immutable proposals, named inspection/annotation/acceptance, first-contract workflow, and explicit change IDs |
| `0.26.4` | Atomic crash-recoverable generation publication and committed-generation marker |
| `0.26.5` | Contract-first offline report, finding filters, commands, and complete incomplete-run explanations |
| `0.26.6` | Thin GitHub Action, version handshake, bounded summaries/annotations, and opt-in evidence |
| `0.26.7` | Exception ownership, exact failure-code lifecycle, expiry, renewal governance, and safe presentation |
| `0.26.8` | Once-per-run memory-only shared-readonly authentication with strict origin/cookie scopes |
| `0.26.9` | Fail-closed screenshot masks, evidence retention policies, schema v2, and privacy manifest |
| `0.26.10` | Nonce-bound shard plans and immutable checksummed partial bundles |
| `0.26.11` | Fail-closed aggregation and one authoritative merged generation |
| `0.26.12` | Consolidated customer/operator guide, architecture diagrams, and documentation contract tests |
| `0.26.13` | Exact package/Action release identity, Node 22/24 consumer proof, OIDC publication, and provenance verification |
| `0.26.14` | Documentation records `v0.26.13` as the completed public proof |
| `0.26.16` | Completed community issue forms, Code of Conduct, Issues-only support, release-pinned Action examples, reviewed assets, and launch copy |
| `0.26.17` | Updated the example's transitive sharp dependency and native libraries for GHSA-rgj7-g3m4-5g8c, with a dependency-free regression check |
| `0.26.18` | This CEO report, customer launch playbook, and README entry point, reconciled with the completed cleanup; not a public npm release |

## 4. What is working?

### 4.1 Customer-visible product capabilities

| Capability | Status | Evidence |
| --- | --- | --- |
| Install from npm | Working | `uiwitness@0.26.13` and three supporting packages are public |
| Check an authorized public site without config | Working | Release-only registry consumer runs the full journey on Node 22 and 24 |
| Promote discovered pages to config | Working | `--write-config` creates no-clobber `.mts` config/scenario files |
| Run explicit state matrices | Working | Example exercises 60 deterministic cells and preserves failure continuation |
| Force states with Playwright | Working | Scenario hooks expose `page` and `context` directly |
| Capture and inspect evidence | Working | Deterministic screenshots, schema JSON, diagnostics, and offline HTML |
| Use private applications | Working within scope | One once-per-run shared-readonly auth module with memory-only storage state |
| Protect sensitive pixels | Working within scope | Named fail-closed masks and configurable retention |
| Establish and enforce a state contract | Working | Strict contract, fresh Guard, machine verdict, proposals, and named acceptance |
| Govern known failures | Working | Owner/reason/date/expiry and no automatic renewal |
| Run in pull requests | Working | Thin full-SHA-pinned Action with least-privilege defaults |
| Parallelize large matrices | Working within scope | Deterministic sharding for unauthenticated runs only |
| Recover from interrupted publication | Working | Journaled transaction and stable marker published last |
| Consume reports offline | Working | No server, external asset, account, or network request required |

### 4.2 Engineering and release quality

The quality story is unusually complete for a pre-1.0 open-source tool:

- Required root scripts exist for lint, typecheck, test, and build.
- Test and compile-time contract files cover core, CLI, runner, report, example app, scripts, release workflows, package consumers, and provenance.
- Real Chromium tests exercise navigation, capture, privacy masks, reports, Quick Check, authentication, and the example application.
- Package smoke installs exact tarballs into an isolated CommonJS-default consumer and imports every public package surface.
- Release smoke proves the package/Action pair for a pass and seeded regression.
- Core contract parsing/digest/comparison is benchmarked at 10,000 coordinates under one second and 256 MiB additional RSS on both supported Node lines.
- Validation for each source candidate runs documentation and script checks, lint, typecheck, the full Vitest suite, production builds, release metadata checks, and the four-tarball consumer/Action smoke. The pull request records the exact candidate and results.
- The latest `main` CI and CodeQL runs completed successfully.
- The `v0.26.13` protected release completed every job: artifact preparation, npm publication, provenance verification, Node 22 registry journey, and Node 24 registry journey.
- The npm registry exposes an attestation URL and SLSA provenance for `uiwitness@0.26.13`.

### 4.3 Product clarity

The repository communicates several boundaries well:

- Product-state coverage is distinguished from pixel regression.
- Quick Check is explicitly a public success-surface probe, not state inference.
- Evidence is local and potentially sensitive.
- Exit `1` is a completed finding, while exit `2` means the tool could not prove the result.
- Known failures are temporary governed debt, not silent permanent approvals.
- Authentication and scenario modules are trusted code.
- Sharding and authentication cannot be combined.

## 5. What is not working, not proven, or deliberately unsupported?

This section separates product defects from evidence gaps and intentional scope limits.

### 5.1 The biggest gap: external customer validation is not complete

The code, package, documentation, and release mechanics have been proven mostly by the project’s own fixtures and automation. No completed unassisted external-user observation is recorded. The next gate is not “build more”; it is “watch a new user try the real public package without coaching.”

Consequences:

- Time to first useful report is asserted as a two-minute goal but is not yet proven with an outside user.
- The first confusing installation, browser setup, report interpretation, or promotion step is unknown.
- There is no evidence yet that the report reveals a problem a customer values enough to revisit.
- Repeat usage, retention, willingness to add explicit states, and willingness to adopt Guard are unproven.

### 5.2 Adoption is currently minimal

The September 10 GitHub recheck still shows zero stars, forks, and watchers. The original September 7 snapshot recorded 276 npm downloads during the week ending September 6, but those requests can include automated release, CI, and cache activity. They should not be presented as 276 users.

This is not a product failure; the product has only just completed its distribution proof. It does mean the CEO should treat adoption, activation, and retention as unknown rather than positive.

### 5.3 The example intentionally fails four cells

The Northline example is not all green. It intentionally retains four assertion failures to demonstrate the value of the report. A visitor who runs it without reading the explanation may think the project is broken.

Mitigation: every launch message and example command should say that exit `1` with exactly four known failures is the expected demonstration outcome.

### 5.4 Current source is ahead of the public release

Source development is ahead of the latest published release. Source `0.26.16` completed launch/community cleanup, and `0.26.17` updated the example's transitive sharp image-processing libraries. This report uses source candidate `0.26.18`. These source versions do not imply npm publication.

Customer commands must stay pinned to the proven `0.26.13` release until another protected release is deliberately published. The sharp update affects the private Next.js example's dependency tree; the public CLI packages do not depend on sharp.

### 5.5 Action examples are aligned with the public release

The [GitHub Actions guide](GITHUB_ACTIONS.md) now pins `uiwitness@0.26.13` and full release SHA `64c6f6dd0f541a5f79c1ec165080ed9e5a8a316b`. Keep that package/SHA pair together when updating customer instructions. The previously reported stale-example gap is resolved.

### 5.6 Community setup is complete; participation remains unproven

The repository now has dedicated bug-report, customer-pilot, and feature-evidence issue forms, a [Code of Conduct](../../CODE_OF_CONDUCT.md), and a [support guide](../../SUPPORT.md). GitHub Issues is the canonical public support and feedback queue. Discussions remains intentionally disabled, and suspected vulnerabilities use private reporting.

The [launch posts](LAUNCH_POSTS.md) include the required authorization and evidence-privacy language. The [asset review](../assets/README.md) records the fictional-data inspection and image digests. These completed items support a pilot; they do not establish customer demand or repeat use.

### 5.7 Deliberate product limits

The following are unsupported by design today:

- Quick Check cannot log in, infer private routes, or generate loading/error/empty states.
- UIWitness does not discover an unconfigured missing state.
- Contract Guard protects outcomes and configured coordinates, not pixel baselines.
- Sharded Guard rejects authentication.
- Authentication supports one shared-readonly role, not multiple roles or per-cell login.
- Only Chromium through the pinned Playwright runtime is proven; there is no Firefox/WebKit product matrix.
- There is no hosted history, team review UI, cloud storage, or cross-run dashboard.
- There is no built-in Storybook/MSW adapter, schema-driven edge-data generator, automatic accessibility metadata, or PR comment mutation.
- There is no required or built-in AI analysis.
- Public Quick Check is navigation-only and a changing live site can yield a different route surface later.

### 5.8 Operational trust limits

- Config, scenario, and authentication modules execute as trusted local code with user/CI privileges.
- UIWitness cannot prevent those trusted modules from printing or transmitting secrets themselves.
- The local project directory is trusted against a hostile same-user process racing pathname validation and publication.
- Screenshots and route inventories may remain sensitive even when headers, cookies, and request bodies are excluded.
- Uploading `.uiwitness/` to GitHub is an explicit publication decision; a public-repository artifact should be treated as public.

### 5.9 Pre-1.0 market expectation

The public version is `0.26.13`, so customers should expect a pre-1.0 product. The repository has strong schema and API discipline, but the project should still communicate that feedback may shape the next approved slice and that broad long-term compatibility promises should follow actual adoption.

## 6. CEO launch readiness

### 6.1 Readiness scorecard

| Dimension | Status | CEO interpretation |
| --- | --- | --- |
| Core product | Ready | Original MVP and approved follow-on roadmaps are complete |
| Public installation | Ready | Four packages are live and provenance-verified |
| First-value workflow | Ready for pilot | Quick Check is complete; external two-minute proof is pending |
| Deep product workflow | Ready | Configured scan, report, contract, auth, privacy, and CI exist |
| Release operations | Ready | Protected OIDC publishing and registry consumers are proven |
| Security/privacy model | Ready within documented trust boundary | Local-first, no telemetry/upload, strict evidence handling |
| Documentation | Ready for pilot | Customer guides and Action examples pin the proven public release |
| Demo assets | Ready | Real 60-cell report images are checked in |
| Community operations | Ready for pilot | Issue forms, Code of Conduct, and one Issues-only support path are implemented |
| External usability evidence | Not ready | No completed unassisted pilot yet |
| Market demand | Not proven | No stars/forks/watchers and no documented repeat customer use |
| Enterprise claim | Not ready | No commercial support, hosted collaboration, or adoption proof |

### 6.2 What is ready to launch now

The following claims are supportable today:

- “Install UIWitness from npm and check an authorized public site locally.”
- “Promote discovered pages into a repeatable config.”
- “Model loading, empty, error, authorization, long-content, responsive, theme, and domain-specific states with Playwright.”
- “Get screenshots, assertions, sanitized diagnostics, coverage, and an offline report.”
- “Commit a reviewed state contract and enforce it in CI.”
- “Use memory-only authentication and fail-closed evidence privacy controls.”
- “Run without an account, telemetry, cloud backend, database, API key, or required LLM.”
- “Use a package and Action release pair proven on Node 22 and 24 with npm provenance.”

### 6.3 Claims that should wait

Do not claim yet:

- “Teams love it” or “developers save a proven amount of time.”
- “Enterprise-ready” or “production standard.”
- “Works with every framework.”
- “Automatically finds every missing state.”
- “Replaces visual regression, accessibility testing, or end-to-end testing.”
- “Zero setup” for deeper product-state coverage. Quick Check is configuration-free; explicit states still require scenarios.
- “Secure for untrusted repository code.” Scenario and auth code is deliberately trusted.
- “Hundreds of users” based on registry downloads.

## 7. Recommended next roadmap: validation before expansion

### Gate 1 — one unassisted external Quick Check

- **Owner:** CEO/product lead
- **Artifact:** [Issue #72](https://github.com/RujitRaval/uiwitness/issues/72)

**Goal:** Observe one developer who did not contribute to UIWitness using only the public README and Quick Check guide.

Required evidence:

- Node version and operating system.
- Time from running `check` to having the offline report.
- Exit code.
- First confusing moment, or “none.”
- Whether the report revealed a real issue.
- Whether `--write-config` made the deeper scan understandable.
- Whether the participant would use UIWitness again.
- Any blocker, without uploading private evidence.

Pass condition: one qualified outside developer completes and reports every field. A failed attempt also creates valuable evidence; the blocker becomes the first work item.

### Gate 2 — three to five design partners

Start only after Gate 1. Select a small mix:

- One static/public marketing site.
- One application with a few explicit loading/empty/error states.
- One private authenticated application suitable for a non-mutating test account.
- Optionally one repository already using Playwright in CI.

Measure:

- Time to first report.
- Time to first meaningful failure.
- Percentage completing `--write-config` or `init → scan`.
- Percentage adding at least one non-success state.
- Percentage returning for a second run within seven days.
- Percentage willing to commit a state contract.
- Most common installation, scenario, evidence, and report confusion.
- Framework or adapter requests tied to a real attempted workflow.

### Gate 3 — focused public launch

Run a broader launch only after Gate 2 produces a repeatable value story. The public launch should include:

- One real, sanitized external finding with customer permission.
- A 60–90 second report walkthrough using the fictional Northline fixture.
- A copy-paste Quick Check path pinned to the current release.
- A clear explanation that Quick Check covers the public success surface and configured scan covers deeper states.
- A GitHub issue template for pilot feedback and one for bugs.
- A Code of Conduct before broadly asking for contributors.
- Updated Action examples matching the current release.
- A simple support response commitment, even if it is only best-effort via GitHub Issues.

### Gate 4 — approve exactly one evidence-backed product slice

Do not implement multiple speculative roadmap items at once. Choose the smallest slice that removes the most repeated customer friction. Candidate slices, only if evidence supports them, include:

- Installation/browser provisioning simplification.
- A Storybook or Mock Service Worker adapter for teams already using that stack.
- Better scenario templates for common loading/error/auth flows.
- Run-to-run comparison that complements, rather than replaces, state contracts.
- Accessibility metadata attached to the same state evidence.
- A compact pull-request summary workflow that preserves privacy and explicit authority.
- Another framework adapter requested by multiple attempted adopters.

Hosted collaboration, accounts, billing, automatic AI analysis, and cloud storage should remain out of scope until customers demonstrate a collaboration problem they will adopt or pay to solve.

## 8. Launch plan for the CEO and project manager

### 8.1 Completed pre-launch cleanup

The `0.26.16` cleanup is merged. Keep these controls in place:

1. Customer installation and Action examples use proven release `v0.26.13` and its matching full SHA until a new protected release is published.
2. Dedicated issue forms cover bugs, pilot feedback, and feature evidence.
3. The Code of Conduct and support guide define public Issues-only routing and private conduct/security reporting.
4. The README's signed-out desktop and mobile review is recorded in the [launch strategy](LAUNCH_STRATEGY.md).
5. Report screenshot provenance and reviewed digests are recorded in the [asset review](../assets/README.md).
6. Every checked-in launch post includes the testing-authorization and evidence-privacy boundary, enforced by repository tests.

The next launch action is the unassisted pilot in Issue #72. Refresh these reviews when their inputs change; do not reopen completed cleanup as a new feature roadmap.

### 8.2 Pilot launch package

Give a new customer only these entry points:

- [README](../../README.md)
- [Public URL Quick Check guide](PUBLIC_URL_QUICK_CHECK.md)
- [State Contract Guard guide](STATE_CONTRACT_GUARD.md) after the first scan
- [GitHub pilot issue #72](https://github.com/RujitRaval/uiwitness/issues/72) for sanitized feedback

Avoid giving them the implementation specification or internal architecture first. Those documents are valuable after the customer understands the outcome.

### 8.3 Recommended launch message

> UIWitness finds the loading, empty, error, authorization, long-content, responsive, and theme states your product forgot. Run one local command against a site you own, inspect a self-contained report, then promote the useful routes into a repeatable state matrix. No account, upload, telemetry, cloud backend, API key, or required AI model.

### 8.4 Demonstration flow

1. Show the Northline report overview—not terminal output—as the hero.
2. Open a failed mobile long-content cell.
3. Show its screenshot, assertion failure, coordinate, and diagnostics.
4. Explain the 60-cell matrix and the four deliberate failures.
5. Run Quick Check against an authorized simple site.
6. Promote with `--write-config`.
7. Explain how an engineer adds an error or empty scenario.
8. End with State Contract Guard: the reviewed state matrix becomes a pull-request promise.

### 8.5 Launch channels

Use channels where developers can understand the artifact:

- GitHub Release and repository README.
- A short engineering post centered on the real report, not on an abstract category pitch.
- Playwright, frontend testing, design-system, and AI-assisted development communities where self-promotion is allowed.
- Direct outreach to three to five design partners with a specific reason their UI has state risk.
- A short video or animated walkthrough only after the narration has been tested on Gate 1.

Avoid fake stars, generic launch directories with no technical audience, and claims based on npm download counts.

### 8.6 Launch-day runbook

| Time | Owner | Action | Proof |
| --- | --- | --- | --- |
| T−24h | Maintainer | Verify current release, README commands, npm package, GitHub Action SHA, and issue links | Clean private-window walkthrough |
| T−4h | Maintainer | Run one registry-only Quick Check from an empty project | Report opens and source remains stable |
| T−1h | CEO/product | Prepare launch copy, screenshots, privacy note, and pilot question | Final review against supported claims |
| T0 | CEO/product | Publish launch message and direct pilot invitations | Links resolve and package is installable |
| T+2h | Maintainer | Triage installation and documentation blockers | Every issue acknowledged and labeled |
| T+24h | Product | Summarize first-value times and confusion | Evidence table, no invented conclusions |
| T+7d | CEO/product/engineering | Decide whether to fix onboarding, recruit more pilots, or approve one roadmap slice | Written decision linked to observations |

### 8.7 Launch metrics

Use a funnel that distinguishes awareness from value:

```text
README/release visit
       ▼
package installed
       ▼
first check completed
       ▼
report opened
       ▼
real issue understood
       ▼
config promoted or explicit state added
       ▼
second run
       ▼
contract or CI adopted
```

Recommended initial targets are learning targets, not market forecasts:

- Gate 1: one complete unassisted observation.
- Gate 2: three to five design partners.
- At least 80% of pilots reach a report without maintainer intervention after prerequisites.
- Median time from `check` command to report under two minutes on the selected small sites, excluding dependency/browser installation; record installation time separately.
- At least two pilots report a real issue or a credible confidence gain.
- At least two pilots promote config or add a non-success state.
- At least one pilot returns for a second run within seven days.
- At least one repository attempts Guard or CI after the matrix is reviewed.

Because UIWitness has no telemetry, collect these metrics through explicit, sanitized pilot interviews or issue templates. Do not add telemetry merely to make the funnel easier to measure.

## 9. New customer playbook

### 9.1 Before starting

You need:

- Node.js `22.20.0` or newer within Node 22 LTS, or Node.js 24.x.
- A project directory.
- A website you own or have explicit permission to test.
- An understanding that screenshots and URLs may contain sensitive data.

Install the exact currently proven release and Playwright runtime:

```bash
npm install --save-dev --save-exact uiwitness@0.26.13 playwright@1.62.1
npx playwright install chromium
```

Add the current evidence root to version-control ignore rules if it is not already ignored:

```gitignore
.uiwitness/
```

Projects that used the earlier product identity should follow the [migration guide](MIGRATING_TO_UIWITNESS.md). UIWitness never migrates or deletes legacy evidence automatically.

### 9.2 Path A: evaluate an authorized public site

Run:

```bash
npx uiwitness check https://your-site.example
```

Expected behavior:

- UIWitness removes the starting query and fragment.
- It discovers up to five same-origin HTML pages.
- It checks each page in mobile/desktop and light/dark.
- It writes evidence beneath `.uiwitness/`.
- It prints the report path and exact promotion command.

Interpret the exit:

- `0`: all completed cells passed.
- `1`: one or more cells exposed a product issue; inspect the report.
- `2`: the tool could not complete a valid check; fix setup or usage before interpreting product quality.

Open `.uiwitness/report/index.html` directly or run:

```bash
npx uiwitness open
```

In the report:

1. Start with failed cells.
2. Filter by viewport and theme to see whether the problem is conditional.
3. Open a cell and inspect the screenshot, response status, assertion, and sanitized diagnostics.
4. Confirm the result manually in the application before treating it as a product defect.

### 9.3 Promote public routes into a project setup

If the discovered routes are useful:

```bash
npx uiwitness check https://your-site.example --write-config
npx uiwitness scan
```

Promotion creates:

```text
uiwitness.config.mts
uiwitness/
  scenarios/
    public/
      default.mts
```

It refuses existing supported config names, target files, and symbolic-link boundaries. There is no force or overwrite mode. Review and commit the config/scenario source; do not commit `.uiwitness/` evidence.

### 9.4 Path B: start with explicit states

For an application that already has known routes and states:

```bash
npx uiwitness init
```

Edit `uiwitness.config.mts` to define the route/state/viewport/theme matrix. Keep the first matrix small: one important route, three or four meaningful states, and the two viewports/themes customers actually use.

Example:

```ts
import { defineConfig } from "uiwitness";

export default defineConfig({
  baseURL: "http://127.0.0.1:3000",
  routes: [{
    id: "orders",
    path: "/orders",
    states: ["success", "loading", "empty", "error"].map((id) => ({
      id,
      setup: "./uiwitness/scenarios/orders.mjs",
    })),
  }],
  themes: ["light", "dark"],
  viewports: {
    mobile: { width: 390, height: 844 },
    desktop: { width: 1440, height: 1000 },
  },
});
```

Use scenario hooks to arrange data and assert the visible state:

```js
export default {
  async beforeNavigate({ page, state }) {
    if (state.id === "empty") {
      await page.route("**/api/orders", (route) =>
        route.fulfill({ json: { orders: [] }, status: 200 }),
      );
    }
  },
  async afterNavigate({ page }) {
    await page.locator("[data-orders-state]").waitFor();
  },
  async assert({ page }) {
    await page.getByRole("heading", { name: "Orders" }).waitFor();
  },
};
```

Start the application, then run:

```bash
npx uiwitness scan
npx uiwitness open
```

### 9.5 Add private application authentication

Use authentication only after the public or local unauthenticated matrix works. Configure one trusted non-mutating account:

```ts
authentication: {
  setup: "./uiwitness/auth.mjs",
  mode: "shared-readonly",
}
```

The setup module should read environment or secret-manager values directly, log in once, and return nothing. UIWitness validates the resulting storage state and copies it in memory to each fresh cell. It does not write an auth-state file.

Rules:

- Treat the auth module as trusted arbitrary code.
- Use a non-mutating account.
- Keep fork pull requests secret-free.
- Run authenticated CI only on an exact reviewed commit behind a protected environment.
- Do not combine authentication with sharding.

### 9.6 Protect screenshot evidence

Choose the least evidence needed:

- `all`: retain all screenshots; default and schema-v1 compatible.
- `failures-only`: retain failed-cell screenshots; produces schema v2.
- `none`: disable screenshot and mask-selector work; produces schema v2.

Use named masks for sensitive pixels. A required missing selector, wrong cardinality, DOM identity change, invalid selector, or masked capture failure blocks the cell and discards screenshot bytes. UIWitness never retries that cell without the mask.

Review the report and `evidence-manifest.json`, but remember that route names, failure information, and retained screenshots can still be sensitive.

### 9.7 Establish the first product-state contract

First make the configured matrix intentionally green. Then:

```bash
npx --no-install uiwitness scan
npx --no-install uiwitness contract init
git add uiwitness.contract.json
git commit -m "test: establish UI state contract"
```

`contract init` creates a contract only from a complete all-pass run. A failed initialization creates a review proposal instead of silently accepting the failure.

### 9.8 Enforce the contract locally

```bash
npx --no-install uiwitness guard
```

On a regression, use the exact reproduction command printed for that coordinate, for example:

```bash
npx --no-install uiwitness scan --coordinate 'orders/error/mobile/dark' --headed
```

Repair accidental regressions. For intentional changes, inspect and accept only named proposal changes:

```bash
npx --no-install uiwitness contract inspect \
  --candidate .uiwitness/contract-candidates/<digest>.proposal.json \
  --change expectation:orders/error/mobile/dark

npx --no-install uiwitness contract accept \
  --candidate .uiwitness/contract-candidates/<digest>.proposal.json \
  --change expectation:orders/error/mobile/dark
```

Never edit proposal JSON manually. Its canonical bytes and filename are digest-bound.

### 9.9 Use temporary known failures responsibly

Only exact eligible failure-code sets can become known failures. Add ownership before accepting:

```bash
npx --no-install uiwitness contract annotate \
  --candidate .uiwitness/contract-candidates/<digest>.proposal.json \
  --change expectation:orders/error/mobile/dark \
  --owner quality-team \
  --reason UIW-2041 \
  --created-on 2026-09-07 \
  --expires-on 2026-09-21
```

The expiry must be 1–30 days. Recovery removes the exception. Changed failure codes require another expectation decision. Ineligible failures must be repaired. Nothing renews automatically.

### 9.10 Add CI

Use the [GitHub Actions guide](GITHUB_ACTIONS.md). The core rules are:

- Pin `uiwitness` to an exact package version.
- Pin the Action to the matching full 40-character release commit SHA.
- Commit the lockfile.
- Grant only `contents: read` unless the repository independently needs more.
- Do not suppress nonzero Guard exits.
- Leave evidence upload disabled unless the screenshots and routes are appropriate for GitHub artifact storage.
- Never run untrusted fork code with secrets through `pull_request_target` or a secret-bearing `workflow_run`.

### 9.11 Scale an unauthenticated matrix

For a large matrix, create a fresh plan, run every shard, and merge every bundle:

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

Use a new plan for every run. Partial bundles are inputs, not verdicts. Only a complete, validated merge publishes final truth.

### 9.12 Customer troubleshooting guide

| Symptom | Likely meaning | Next action |
| --- | --- | --- |
| `check` or `scan` exits `1` | Run completed and found product failures | Open the report; do not reinstall the tool |
| Command exits `2` | Setup, configuration, safety, auth, completeness, or internal error | Read the stable error, fix the run, and rerun before judging the product |
| `init` refuses to run | A supported config or generated target already exists | Inspect existing files; UIWitness has no overwrite mode |
| Browser executable missing | Playwright’s matching Chromium is not installed | Run `npx playwright install chromium` |
| Quick Check finds fewer pages than expected | Discovery is bounded, same-origin, HTML-only, and navigation-only | Increase `--max-pages` up to 20 or add explicit routes after promotion |
| Private page is not discovered | Quick Check does not authenticate | Create explicit config and add the trusted auth module |
| Masked screenshot is missing | Fail-closed mask validation rejected capture | Fix selector, expected count, or DOM stability; no unmasked fallback exists |
| Guard reports drift | Current config/outcome differs from the committed promise | Reproduce, repair, or inspect and accept named intentional changes |
| Guard exits `2` | It could not prove a complete coherent run | Treat as infrastructure/setup failure, never as a passing product verdict |
| Shard merge fails | A bundle is missing, duplicate, expired, drifted, corrupt, linked, or inconsistent | Create a fresh plan and rerun all shards; do not reuse partial truth |
| Example exits `1` with four failures | Expected Northline demonstration result | Confirm exactly 56 passes and the documented four coordinates |

## 10. What can a new GitHub visitor do?

### 10.1 If they want to try the product

They do not need to clone the repository. They can:

1. Read the first screen of the [README](../../README.md).
2. Install `uiwitness@0.26.13` and `playwright@1.62.1` in their own project.
3. Install Chromium.
4. Run Quick Check on a site they own or are authorized to test.
5. Open the report.
6. Promote routes with `--write-config`.
7. Add explicit product states.
8. Initialize a state contract and add the Action when the matrix is reviewed.

### 10.2 If they want to inspect the product before installing it

Recommended reading order:

1. [README](../../README.md) — promise, screenshots, quick start, architecture, and boundaries.
2. [Public URL Quick Check](PUBLIC_URL_QUICK_CHECK.md) — two-minute evaluation path.
3. [State Contract Guard](STATE_CONTRACT_GUARD.md) — complete local-to-CI lifecycle.
4. [CLI and configuration specification](../product/CLI_AND_CONFIG_SPEC.md) — exact command and config behavior.
5. [Architecture](../architecture/ARCHITECTURE.md) — package and responsibility boundaries.
6. [Security and privacy](../engineering/SECURITY_PRIVACY.md) — trust, evidence, authentication, and release model.
7. [Core](../engineering/CORE_API.md), [runner](../engineering/RUNNER_API.md), [report](../engineering/REPORT_API.md), and [CLI](../engineering/CLI_API.md) APIs — programmatic contracts.
8. [Changelog](../../CHANGELOG.md) and [ADRs](../decisions/) — update history and design rationale.

### 10.3 If they want to run the repository

Prerequisites are Node.js 22.20+ within Node 22 LTS or Node.js 24.x, Corepack, and the locked package manager.

```bash
git clone https://github.com/RujitRaval/uiwitness.git
cd uiwitness
corepack pnpm install --frozen-lockfile
corepack pnpm --filter uiwitness-runner-playwright exec playwright install chromium
corepack pnpm lint
corepack pnpm typecheck
corepack pnpm test
corepack pnpm build
```

Run the example:

```bash
corepack pnpm --filter @uiwitness/example-nextjs build
corepack pnpm --filter @uiwitness/example-nextjs start
```

In another shell:

```bash
corepack pnpm --filter @uiwitness/example-nextjs uiwitness:scan
```

Expected result: exit `1`, 56 passes, and the four intentional failures described above.

### 10.4 If they want to understand the repository layout

```text
apps/example-nextjs/       polished Northline product fixture and scenarios
packages/core/             browser-independent contracts and calculations
packages/runner-playwright Playwright execution and local persistence
packages/report/           offline report transformation and rendering
packages/cli/              executable and orchestration
docs/product/              product behavior and UX specifications
docs/architecture/         system and State Contract Guard architecture
docs/engineering/          API, testing, security, and implementation references
docs/open-source/          customer, Action, migration, release, and launch guides
docs/decisions/            42 architecture decision records
scripts/                   CI, release, provenance, smoke, and contract checks
.github/workflows/         CI, security scanning, release, and registry verification
action.yml                 thin Contract Guard composite Action
```

### 10.5 If they want to contribute

They should:

1. Read [CONTRIBUTING.md](../../CONTRIBUTING.md), [`AGENTS.md`](../../AGENTS.md), and the relevant product/architecture documents.
2. Confirm the work belongs to an approved roadmap slice or issue.
3. Start from a clean, current `main`.
4. Create a focused `feat/`, `fix/`, `chore/`, `docs/`, `test/`, or `refactor/` branch.
5. Implement one coherent change with tests and public documentation where applicable.
6. Run the local quality gates.
7. Run GStack review and ship workflows.
8. Merge only through a green pull request; never force-push or push implementation work directly to `main`.

Good contribution surfaces include deterministic scenarios, fictional examples, report usability, documentation, and approved narrow adapters or policies. A bug report should include the command, exit code, sanitized terminal output, and the smallest safe reproduction—not an unreviewed `.uiwitness/` bundle.

### 10.6 If they want to release the project

Only maintainers with release authority should use the protected process:

1. Start a focused branch from current `main`.
2. Run review and ship; keep the four-component repository version’s fourth component at zero.
3. Merge the green pull request.
4. Create a non-prerelease `vMAJOR.MINOR.PATCH` GitHub Release from the merged `main` commit.
5. Approve the protected `npm-publish` environment.
6. Confirm artifact preparation, both Node consumer proofs, protected publication, provenance verification, and both registry journeys are green.

Do not recreate the one-time bootstrap token path. Normal releases use token-free trusted publishing.

## 11. Operating model and ownership

| Responsibility | CEO/product | Engineering maintainer | Design/QA partner | Pilot customer |
| --- | --- | --- | --- | --- |
| Positioning and claims | Accountable | Consulted | Consulted | Informed |
| Release integrity | Informed | Accountable | Informed | Informed |
| Pilot recruitment | Accountable | Consulted | Consulted | Participates |
| Installation and workflow observation | Observes | Supports after unassisted run | Observes | Responsible |
| Product-state matrix | Consulted | Responsible | Responsible | Responsible in own product |
| Evidence privacy | Accountable for policy | Responsible for implementation | Consulted | Responsible for captured data |
| Roadmap approval | Accountable | Recommends from evidence | Recommends | Supplies evidence |
| Community triage | Accountable for response standard | Responsible | Optional | Reports safely |

Weekly until Gate 2 completes:

- Review new installations/pilot attempts that customers voluntarily report.
- Record time to report and first confusion without collecting private evidence.
- Separate product bugs, documentation gaps, and unsupported requests.
- Close the loop publicly on reproducible blockers.
- Refuse to convert one unusual request into a broad roadmap without repeated evidence.

## 12. Risk register

| Risk | Likelihood | Impact | Mitigation |
| --- | --- | --- | --- |
| Strong internal proof does not translate to user activation | High until pilot | High | Run Issue #72 unassisted; prioritize observed first friction |
| Category requires too much explanation | Medium | High | Lead with failed UI states and report evidence, then name the category |
| Browser installation creates early drop-off | Medium | High | Measure separately; improve docs or provisioning only if observed |
| Customers expect automatic hidden-state discovery | High | Medium | State clearly that Quick Check covers public success surfaces and scenarios cover deeper states |
| Screenshots contain sensitive data | Medium | High | Local default, ignore rules, masks, retention, explicit upload, private test data |
| Users treat exit `1` as a tool crash | Medium | Medium | Repeat “completed finding” language in terminal, docs, and demos |
| Users treat example failures as repository failure | Medium | Medium | Announce exact 56/4 expected result before the command |
| Action/package version mismatch | Medium | High | Keep the package and full Action SHA pinned to the same proven release |
| Auth module leaks secrets | Low to medium | High | Trusted-code warning, reviewed commit, protected environment, non-mutating account |
| Sharded partial evidence is mistaken for a verdict | Low | High | Only merge publishes final truth; retain fail-closed CLI semantics |
| Pre-1.0 API change surprises early adopters | Medium | Medium | Maintain versioned contracts, changelog, migration guides, and explicit release notes |
| Broad feature work delays demand learning | High | High | Require a new approved roadmap slice backed by pilot evidence |

## 13. Recommended CEO narrative

### The concise version

UIWitness is a local-first way to prove that the UI states a team says it supports actually render and behave correctly across real conditions. The technical product, package distribution, CI integration, privacy controls, and release proof are complete. The next milestone is one unassisted customer completing Quick Check and telling us where value or confusion appears.

### The investor or partner version

The project has built a defensible deterministic core around a common but poorly measured engineering problem: UI failures outside the happy path. It combines explicit state modeling, browser evidence, an offline visual report, and contract governance without requiring a hosted service. The engineering risk has been reduced substantially; the remaining primary risk is adoption. The near-term strategy is to validate activation and repeat use before deciding whether adapters, richer analysis, accessibility, or collaboration deserve investment.

### The customer version

Start with one command against a site you control. UIWitness shows how the public surface behaves on mobile and desktop in light and dark modes. Keep the routes that matter, add the loading/error/empty/auth states only your application knows, and turn that matrix into a CI promise when the team is ready. Your evidence stays local unless you explicitly upload it.

## 14. Source-of-truth map

This report summarizes, but does not replace, the project’s normative documents:

- [Product requirements](../product/PRD.md)
- [Implementation specification](../../codex/IMPLEMENTATION_SPEC.md)
- [Architecture](../architecture/ARCHITECTURE.md)
- [Implementation plan](../engineering/IMPLEMENTATION_PLAN.md)
- [Test strategy](../engineering/TEST_STRATEGY.md)
- [Security and privacy](../engineering/SECURITY_PRIVACY.md)
- [Public URL Quick Check](PUBLIC_URL_QUICK_CHECK.md)
- [State Contract Guard](STATE_CONTRACT_GUARD.md)
- [GitHub Actions](GITHUB_ACTIONS.md)
- [Release process](RELEASING.md)
- [Launch strategy](LAUNCH_STRATEGY.md)
- [Migration guide](MIGRATING_TO_UIWITNESS.md)
- [Complete changelog](../../CHANGELOG.md)

The original adoption and download snapshot was captured on September 7, 2026. Repository status, the open Gate 1 pilot, the current public release, and the completed cleanup were rechecked on September 10. Historical counts and download windows above retain their original dates. Counts and adoption signals will change; product behavior and security claims should continue to be resolved from the versioned source documents and shipped code.
