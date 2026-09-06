# UIWitness Agent Guide

## Source of truth

Before changing implementation code, read these files in order:

1. `codex/MASTER_PROMPT.md`
2. `codex/IMPLEMENTATION_SPEC.md`
3. `docs/product/PRD.md`
4. `docs/architecture/ARCHITECTURE.md`
5. `docs/engineering/IMPLEMENTATION_PLAN.md`
6. `docs/engineering/TEST_STRATEGY.md`
7. `docs/engineering/SECURITY_PRIVACY.md`

Phase 1 through Phase 7 are complete. The public packages, protected release workflow, launch assets, consumer smoke gates, example evidence, and contributor/release guidance are implemented. The approved Public URL Quick Check roadmap is also complete: bounded discovery, fixed-matrix evidence, kinetic reporting, `uiwitness check <url>` orchestration, overwrite-safe `--write-config` promotion, public launch guidance, and the registry-only check → promotion → scan → open release gate are implemented. Keep future work in an explicitly approved roadmap slice.

The approved [State Contract Guard roadmap](docs/designs/uiwitness-state-contract-guard.md) is active. T1 through T10 are complete with strict browser-independent contract parsing, RFC 8785 canonical digests, exhaustive contract comparison, deterministic verdict precedence, complete fresh-run CLI guard orchestration, exact-coordinate reproduction, deterministic machine verdicts, immutable content-addressed proposals, constrained metadata overlays, named single-use acceptance, one crash-recoverable generation transaction for report/evidence/verdict/proposal output, the contract-first offline verdict experience, a thin full-SHA-pinned GitHub Action with exact project-local CLI parity and opt-in evidence upload, complete exact/owned/visible/expiring exception governance across local and hosted surfaces, memory-only shared-read-only authentication, and fail-closed masking with explicit evidence retention; T11 through T14 remain separate future slices and must not be pulled forward implicitly.

## Design system

Always read `DESIGN.md` before making visual or UI decisions. Font choices, colors, spacing, layout, motion, and the industrial-editorial direction are defined there. Do not deviate without explicit user approval. In visual QA, flag code that does not match `DESIGN.md`.

## Development workflow

Every development step after the repository bootstrap must follow this sequence:

1. Start from an up-to-date, clean `main` branch.
2. Create a focused branch named `feat/<slug>`, `fix/<slug>`, `chore/<slug>`, `docs/<slug>`, `test/<slug>`, or `refactor/<slug>`.
3. Implement one coherent development step and its tests. Keep the branch inside the approved phase and scope.
4. Run the repository checks locally.
5. Run the GStack `review` skill and resolve its findings.
6. Run the GStack `ship` skill. Let it verify, version, update the changelog, commit, push, and open or update the pull request.
7. Merge only through a green pull request. Never push implementation work directly to `main` and never force-push.

The initial documentation import on `main` is the one bootstrap exception because no base branch existed yet.

## Required checks

Once `package.json` exists, the root package must provide `lint`, `typecheck`, `test`, and `build` scripts. CI treats any missing script as a failure.

Before handoff, run:

```bash
node scripts/check-docs.mjs
node --test scripts/*.test.mjs
node scripts/run-ci.mjs
corepack pnpm release:check
corepack pnpm release:package-smoke
```

Run `corepack pnpm install --frozen-lockfile` first when dependencies are present. Install the pinned browser with `corepack pnpm --filter uiwitness-runner-playwright exec playwright install chromium` before running browser-backed tests.

## Engineering constraints

- Keep the core local-first and deterministic. No telemetry, hosted backend, account, database, cloud dependency, or required LLM.
- Add tests with each capability and regression fix.
- Keep public APIs small and documented.
- Record material architecture decisions in `docs/decisions/`.
- Do not commit `.uiwitness/` or legacy `.statecraft/` evidence because reports may contain screenshots and sensitive application data.
- Justify major dependencies and prefer mature, narrowly scoped packages.

## Skill routing

When the user's request matches an available skill, invoke it via the Skill tool. When in doubt, invoke the skill.

Key routing rules:
- Product ideas/brainstorming → invoke /office-hours
- Strategy/scope → invoke /plan-ceo-review
- Architecture → invoke /plan-eng-review
- Design system/plan review → invoke /design-consultation or /plan-design-review
- Full review pipeline → invoke /autoplan
- Bugs/errors → invoke /investigate
- QA/testing site behavior → invoke /qa or /qa-only
- Code review/diff check → invoke /review
- Visual polish → invoke /design-review
- Ship/deploy/PR → invoke /ship or /land-and-deploy
- Save progress → invoke /context-save
- Resume context → invoke /context-restore
- Author a backlog-ready spec/issue → invoke /spec
