import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import test from "node:test";

import { RELEASE_PACKAGES } from "./check-release-packages.mjs";
import {
  GITHUB_WORKFLOW_BUILD_TYPE,
  GITHUB_OIDC_ISSUER,
  NPM_REGISTRY_ORIGIN,
  PROVENANCE_RETRY_DELAY_MS,
  RELEASE_REPOSITORY,
  SLSA_PROVENANCE_TYPE,
  assertNpmSignatureAudit,
  assertReleaseProvenance,
  normalizeReleaseSha,
  parseProvenanceArguments,
  verifyReleaseProvenance,
  verifyNpmAuditIdentities,
} from "./verify-release-provenance.mjs";

const sha = "0123456789abcdef0123456789abcdef01234567";
const tag = "v1.2.3";
const integrityBytes = Buffer.alloc(64, 1);
const integrity = `sha512-${integrityBytes.toString("base64")}`;
const digest = integrityBytes.toString("hex");

function fixture(name, overrides = {}) {
  const workflow = {
    // Captured npm provenance uses the repository-relative path without a leading slash.
    path: ".github/workflows/release.yml",
    ref: `refs/tags/${tag}`,
    repository: RELEASE_REPOSITORY,
    ...overrides.workflow,
  };
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    predicateType: SLSA_PROVENANCE_TYPE,
    subject: [{ digest: { sha512: overrides.digest ?? digest }, name: `pkg:npm/${name}@1.2.3` }],
    predicate: {
      buildDefinition: {
        buildType: overrides.buildType ?? GITHUB_WORKFLOW_BUILD_TYPE,
        externalParameters: { workflow },
        internalParameters: { github: { event_name: overrides.eventName ?? "release" } },
        resolvedDependencies: [{
          digest: { gitCommit: overrides.sha ?? sha },
          uri: `git+${RELEASE_REPOSITORY}@refs/tags/${tag}`,
        }],
      },
    },
  };
  const metadata = {
    name,
    version: "1.2.3",
    dist: {
      integrity,
      attestations: {
        provenance: { predicateType: SLSA_PROVENANCE_TYPE },
        url: `${NPM_REGISTRY_ORIGIN}/-/npm/v1/attestations/${name}@1.2.3`,
      },
    },
  };
  const attestationDocument = {
    attestations: [{
      bundle: {
        dsseEnvelope: {
          payload: Buffer.from(JSON.stringify(statement)).toString("base64"),
          payloadType: "application/vnd.in-toto+json",
        },
      },
      predicateType: SLSA_PROVENANCE_TYPE,
    }],
  };
  return { attestationDocument, metadata };
}

function signatureAudit(overrides = {}) {
  return {
    invalid: overrides.invalid ?? [],
    missing: overrides.missing ?? [],
    verified: RELEASE_PACKAGES.map(({ name }) => ({
      attestations: { provenance: { predicateType: SLSA_PROVENANCE_TYPE } },
      attestationBundles: fixture(name).attestationDocument.attestations,
      name,
      version: "1.2.3",
    })),
  };
}

test("requires an exact release tag and full lowercase commit SHA", () => {
  assert.equal(normalizeReleaseSha(sha), sha);
  assert.deepEqual(parseProvenanceArguments(["--tag", tag, "--sha", sha]), { sha, tag, version: "1.2.3" });
  for (const value of ["abc", sha.toUpperCase(), `${sha}0`]) {
    assert.throws(() => normalizeReleaseSha(value), /40-character commit SHA/u);
  }
  for (const arguments_ of [[], ["--tag", tag], ["--sha", sha], ["--tag", tag, "--tag", tag, "--sha", sha]]) {
    assert.throws(() => parseProvenanceArguments(arguments_));
  }
});

test("binds npm integrity, package identity, release workflow, tag, event, and commit", () => {
  const name = "uiwitness";
  const valid = fixture(name);
  assert.doesNotThrow(() => assertReleaseProvenance({ ...valid, name, sha, tag, version: "1.2.3" }));
  for (const [overrides, expected] of [
    [{ digest: "0".repeat(26) }, /digest does not match/u],
    [{ sha: "f".repeat(40) }, /not bound to release commit/u],
    [{ workflow: { path: "/.github/workflows/other.yml" } }, /release workflow and tag/u],
    [{ workflow: { ref: "refs/heads/main" } }, /release workflow and tag/u],
    [{ eventName: "push" }, /event must be release/u],
    [{ buildType: "https://example.invalid/build" }, /build type drifted/u],
  ]) {
    const invalid = fixture(name, overrides);
    assert.throws(() => assertReleaseProvenance({ ...invalid, name, sha, tag, version: "1.2.3" }), expected);
  }
});

test("accepts only npm-cryptographically-verified provenance bundles", () => {
  const verified = assertNpmSignatureAudit(signatureAudit(), "1.2.3");
  assert.deepEqual([...verified.keys()], RELEASE_PACKAGES.map(({ name }) => name));
  assert.throws(() => assertNpmSignatureAudit(signatureAudit({ invalid: [{ code: "EATTESTATIONVERIFY" }] }), "1.2.3"), /invalid registry signature or Sigstore/u);
  const unsigned = signatureAudit();
  unsigned.verified[0].attestationBundles = [];
  assert.throws(() => assertNpmSignatureAudit(unsigned, "1.2.3"), /not available yet/u);
});

test("binds every verified bundle to the exact GitHub OIDC workflow identity", async () => {
  const calls = [];
  await verifyNpmAuditIdentities({
    audit: signatureAudit(),
    sigstoreVerify: async (bundle, options) => calls.push({ bundle, options }),
    tag,
    tufCachePath: "/tmp/uiwitness-tuf-fixture",
    version: "1.2.3",
  });
  assert.equal(calls.length, RELEASE_PACKAGES.length);
  for (const call of calls) {
    assert.deepEqual(call.options, {
      certificateIdentityURI: `${RELEASE_REPOSITORY}/.github/workflows/release.yml@refs/tags/${tag}`,
      certificateIssuer: GITHUB_OIDC_ISSUER,
      tufCachePath: "/tmp/uiwitness-tuf-fixture",
      tufForceCache: true,
    });
  }
  await assert.rejects(
    verifyNpmAuditIdentities({
      audit: signatureAudit(),
      sigstoreVerify: async () => { throw new Error("SAN mismatch"); },
      tag,
      tufCachePath: "/tmp/uiwitness-tuf-fixture",
      version: "1.2.3",
    }),
    /provenance certificate is not bound/u,
  );
});

test("fetches only exact npm package and attestation endpoints", async () => {
  const calls = [];
  const fetchImpl = async (input, options) => {
    assert.deepEqual(options, { redirect: "manual" });
    const url = String(input);
    calls.push(url);
    const packageEntry = RELEASE_PACKAGES.find(({ name }) => url.includes(encodeURIComponent(name)) || url.includes(`${name}@`));
    assert.notEqual(packageEntry, undefined);
    const body = fixture(packageEntry.name).metadata;
    return { json: async () => body, ok: true, status: 200 };
  };
  const verified = await verifyReleaseProvenance({ fetchImpl, sha, signatureAudit: async () => signatureAudit(), tag });
  assert.deepEqual(verified.map(({ name }) => name), RELEASE_PACKAGES.map(({ name }) => name));
  assert.equal(calls.length, RELEASE_PACKAGES.length);
});

test("rejects redirected or missing attestation metadata", async () => {
  const malicious = fixture("uiwitness").metadata;
  malicious.dist.attestations.url = "https://example.invalid/attestations";
  await assert.rejects(
    verifyReleaseProvenance({
      fetchImpl: async () => ({ json: async () => malicious, ok: true, status: 200 }),
      sha,
      signatureAudit: async () => signatureAudit(),
      tag,
    }),
    /escaped the npm registry/u,
  );
  await assert.rejects(
    verifyReleaseProvenance({
      fetchImpl: async () => ({ json: async () => ({}), ok: false, status: 404 }),
      now: (() => {
        let value = 0;
        return () => {
          value += 600_000;
          return value;
        };
      })(),
      sha,
      signatureAudit: async () => signatureAudit(),
      sleep: async () => {},
      tag,
    }),
    /HTTP 404/u,
  );
});

test("retries bounded registry propagation failures", async () => {
  let calls = 0;
  const delays = [];
  const fetchImpl = async (input) => {
    calls += 1;
    if (calls === 1) return { json: async () => ({}), ok: false, status: 404 };
    const url = String(input);
    const packageEntry = RELEASE_PACKAGES.find(({ name }) => url.includes(encodeURIComponent(name)) || url.includes(`${name}@`));
    const body = fixture(packageEntry.name).metadata;
    return { json: async () => body, ok: true, status: 200 };
  };
  await verifyReleaseProvenance({
    fetchImpl,
    now: () => 0,
    sha,
    signatureAudit: async () => signatureAudit(),
    sleep: async (duration) => delays.push(duration),
    tag,
  });
  assert.deepEqual(delays, [PROVENANCE_RETRY_DELAY_MS]);
});

test("retries an incomplete HTTP 200 attestation transaction", async () => {
  let auditCalls = 0;
  const delays = [];
  await verifyReleaseProvenance({
    fetchImpl: async (input) => {
      const packageEntry = RELEASE_PACKAGES.find(({ name }) => String(input).includes(encodeURIComponent(name)));
      return { json: async () => fixture(packageEntry.name).metadata, ok: true, status: 200 };
    },
    now: () => 0,
    sha,
    signatureAudit: async () => {
      auditCalls += 1;
      const audit = signatureAudit();
      if (auditCalls === 1) audit.verified[0].attestationBundles = [];
      return audit;
    },
    sleep: async (duration) => delays.push(duration),
    tag,
  });
  assert.equal(auditCalls, 2);
  assert.deepEqual(delays, [PROVENANCE_RETRY_DELAY_MS]);
});

test("retries incomplete successful metadata responses", async () => {
  let metadataCalls = 0;
  const delays = [];
  await verifyReleaseProvenance({
    fetchImpl: async (input) => {
      metadataCalls += 1;
      const packageEntry = RELEASE_PACKAGES.find(({ name }) => String(input).includes(encodeURIComponent(name)));
      const metadata = fixture(packageEntry.name).metadata;
      if (metadataCalls === 1) delete metadata.dist.attestations.provenance;
      return { json: async () => metadata, ok: true, status: 200 };
    },
    now: () => 0,
    sha,
    signatureAudit: async () => signatureAudit(),
    sleep: async (duration) => delays.push(duration),
    tag,
  });
  assert.equal(metadataCalls, RELEASE_PACKAGES.length + 1);
  assert.deepEqual(delays, [PROVENANCE_RETRY_DELAY_MS]);
});
