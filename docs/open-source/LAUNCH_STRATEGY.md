# Open-Source Launch Strategy

## Goal
Earn adoption and stars by solving a recognizable paid-tool-adjacent problem with an excellent local-first experience.

## Positioning
**Find the UI states your product forgot.** Visual regression tells you whether pixels changed; UIWitness tells you whether important product states survive reality.

## Hero asset
The generated report. The example must visibly catch defects such as long content breaking mobile or an API error crashing one state.

The checked-in assets are generated from the real Northline report:

- `docs/assets/uiwitness-report-overview.png` shows the kinetic evidence verdict and 60-cell coverage signal.
- `docs/assets/uiwitness-failure-detail.png` shows the approved customer long-content mobile overflow with its assertion and execution metadata.

Regenerate them only from the complete local example scan. Start the production example, run its checked-in UIWitness matrix, confirm the expected 56 passes and four failures, then run `corepack pnpm launch:assets`. Review both PNGs for fictional-only data before committing them. The capture command blocks HTTP and HTTPS requests while opening the self-contained file report. The current reviewed asset hashes and fictional-data provenance are recorded in the [launch asset review](../assets/README.md); the repository tests reject unreviewed pixel changes.

## README above fold
Name; promise; excellent GIF/screenshot; zero-config `npx uiwitness check <url>` entry point; configured `npx uiwitness scan` workflow; tiny matrix; contrast with conventional visual regression.

The signed-out GitHub review on 2026-09-08 covered the repository homepage and the rendered README section at 1440 × 1000 and 390 × 844. The promise, local-first explanation, fixed `0.26.13` install target, and report image are clear and legible once the README section begins. GitHub's own file list precedes README content on the repository homepage at both widths; that host-controlled ordering is not treated as a README defect.

## Launch-copy safety boundary

Every public launch post, regardless of channel or length, must include this boundary without weakening either sentence:

> Test only software you own or are authorized to assess. UIWitness keeps evidence local by default, but screenshots, URLs, and diagnostics may contain sensitive data; review them before sharing or uploading.

Posts may explain local-only Quick Check, configured scans, or Contract Guard, but must not imply permission to test third-party sites, automatic evidence privacy, or automatic GitHub artifact upload.

## Distribution after stability
npm; GitHub Actions workflow; demo repo; posts showing real findings; later Codex/Claude/OpenCode skills.

## Contribution surfaces
Scenarios, examples, report UX, and later adapters/policies. Prepare bounded `good first issue` work.

GitHub Issues is the one public support and feedback path. Discussions remains disabled so questions, pilot evidence, bugs, and feature evidence do not split across queues. The repository issue forms and [support guide](../../SUPPORT.md) route each request; suspected vulnerabilities stay in private vulnerability reporting.

## Metrics
Stars plus npm downloads, repeat users, issues from real use, contributors, forks, downstream integrations, adapter requests.

## Avoid
No fake activity, AI overclaiming, half-working universal framework, cloud gate, or SaaS before demand.

## Current status

Phase 7, the approved Public URL Quick Check, the UIWitness distribution proof, the ordered external cutover, and the State Contract Guard roadmap are complete. The canonical repository is `RujitRaval/uiwitness`; all four packages are public at `0.26.13` with provenance and protected trusted publishing. Immutable tag [`v0.26.13`](https://github.com/RujitRaval/uiwitness/releases/tag/v0.26.13) proved the complete normal release path: all four packages published through token-free OIDC, provenance bound each registry artifact to the exact release workflow, and the automatic registry-only check → promotion → scan → open journey passed all eight matrix cells on both supported Node lines. The historical `v0.25.5` first normal release, `v0.25.4` bootstrap, and legacy-package migration records remain preserved. Next, collect real-user feedback and use that evidence to approve a focused roadmap slice rather than expanding the product boundary speculatively.
