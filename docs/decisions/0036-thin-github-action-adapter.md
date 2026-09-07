# ADR 0036: Keep the GitHub Action a Thin Project-Local Adapter

## Status

Accepted.

## Context

State Contract Guard needs a first-class pull-request experience without making GitHub a core dependency, downloading an unlocked CLI, interpreting pull-request text, or changing the deterministic local process contract. Hosted summaries and annotations also have strict size and injection boundaries, while screenshots and verdict sidecars can contain private application information.

## Decision

Publish one root composite `action.yml` with a dependency-free Node adapter. The adapter resolves only the adopting repository's installed `uiwitness` executable, requires its `--version` output to match the Action checkout's release version, and passes the bounded config and contract inputs as child-process argv without a shell.

The CLI's `0`/`1`/`2` result remains authoritative. Each invocation also writes one exclusive internal `--json` verdict copy, which the adapter strictly validates before presentation so an old fixed-path sidecar cannot satisfy a new run. GitHub receives escaped, deterministic summaries capped at 512 KiB and at most 50 blocking annotations. Outputs contain only stable verdict classifications, paths, digests, and aggregate counts. Evidence upload is a separate immutable Action step, disabled by default with one-day retention when enabled.

Consumer examples request only `contents: read`, use normal secret-free fork pull-request jobs, and pin the complete release commit SHA. Full SemVer tags remain a protected human-readable convenience, not an equivalent immutability guarantee.

## Consequences

- GitHub-specific code stays outside core, report, runner, and CLI comparison semantics.
- Adopting repositories control dependency installation and lockfiles; version drift fails before browser work.
- The same CLI verdict is reproducible locally and in GitHub Actions.
- Explicit artifact upload can still fail independently when the requested deliverable cannot be stored.
- Release-time proof now requires one exact Action release SHA and the matching packed/public packages to retain pass and seeded-regression parity on Node 22 and 24.
