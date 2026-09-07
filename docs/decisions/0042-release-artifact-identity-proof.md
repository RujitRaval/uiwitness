# ADR 0042: Bind Release Proof to Exact Package and Action Identities

## Status

Accepted.

## Context

Workspace tests can prove source behavior while missing packaging, runtime, or publication drift. State Contract Guard exposes four coordinated npm packages and a GitHub Action whose version must match the project-local CLI. A release is trustworthy only when the exact candidate artifacts, Action commit, registry packages, and provenance agree.

## Decision

Pack the four npm artifacts once in an OIDC-free preparation job. Exercise those exact tarballs with the matching 40-character Action commit on Node 24 and then Node 22 before publication. The temporary consumer uses a minimum-permission workflow pin, validates and executes the complete composite Action contract, initializes a real contract, proves a passing guard, seeds an assertion regression, and requires the direct CLI and Action adapter to agree on verdict, exit class, digest, and finding totals. Bind the four tarball byte streams, package version, Action SHA, release tag, and release commit in a SHA-512 manifest, then transfer that bundle to a minimal protected publishing job.

Only the minimal publishing job receives `id-token: write`. It installs no dependencies and runs no browser or package code; it checks out the exact release commit, downloads the prepared bundle through an immutable GitHub-owned Action, verifies the manifest, and publishes the verified tarballs. After OIDC trusted publication, npm's signature auditor cryptographically verifies each Sigstore provenance bundle, including its certificate/signature and transparency-log evidence. UIWitness re-verifies the selected bundle with an exact certificate policy for GitHub's OIDC issuer and `RujitRaval/uiwitness/.github/workflows/release.yml@refs/tags/<tag>` identity, then decodes only that verified statement. The package subject and sha512 digest must match npm metadata and bind the build to `.github/workflows/release.yml`, the immutable release tag, the `release` event, and the exact release commit. Only then run the registry-only check → promotion → scan → open journey on both supported Node lines.

## Consequences

- Package, Action, provenance, and registry claims fail closed on any identity mismatch.
- The protected environment gates the only OIDC-capable job; dependency installation, tests, browser execution, and packing cannot mint its publishing identity.
- Node 22 and 24 consume identical pre-publication tarball bytes, while post-publication consumers independently install the exact registry version.
- A registry or provenance failure happens after immutable npm publication and therefore requires investigation or a new release; it cannot be repaired by moving a tag or replacing package bytes.
- Rollback means pinning both the prior exact package version and its full release commit SHA.
