import assert from "node:assert/strict";
import { Buffer } from "node:buffer";
import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RELEASE_PACKAGES } from "./check-release-packages.mjs";
import { normalizeRegistrySmokeVersion } from "./public-url-registry-smoke.mjs";

export const NPM_REGISTRY_ORIGIN = "https://registry.npmjs.org";
export const RELEASE_WORKFLOW_PATH = ".github/workflows/release.yml";
export const RELEASE_REPOSITORY = "https://github.com/RujitRaval/uiwitness";
export const SLSA_PROVENANCE_TYPE = "https://slsa.dev/provenance/v1";
export const GITHUB_WORKFLOW_BUILD_TYPE = "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
export const GITHUB_OIDC_ISSUER = "https://token.actions.githubusercontent.com";
export const PROVENANCE_RETRY_WINDOW_MS = 600_000;
export const PROVENANCE_RETRY_DELAY_MS = 10_000;
const commitPattern = /^[0-9a-f]{40}$/u;
const retryableStatuses = new Set([404, 429, 502, 503, 504]);

class ProvenancePropagationError extends Error {}

function record(value, label) {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, `${label} must be an object.`);
  return value;
}

function requiredString(value, label) {
  assert.equal(typeof value === "string" && value.length > 0, true, `${label} must be a non-empty string.`);
  return value;
}

export function normalizeReleaseSha(value) {
  assert.equal(typeof value === "string" && commitPattern.test(value), true, "Release SHA must be one lowercase 40-character commit SHA.");
  return value;
}

export function parseProvenanceArguments(arguments_) {
  let sha;
  let tag;
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (!["--sha", "--tag"].includes(name) || value === undefined || value.startsWith("--")) {
      throw new Error(`Expected --tag <vMAJOR.MINOR.PATCH> and --sha <40-character commit>; received ${JSON.stringify(arguments_)}.`);
    }
    if (name === "--sha") {
      if (sha !== undefined) throw new Error("--sha can be specified only once.");
      sha = normalizeReleaseSha(value);
    } else {
      if (tag !== undefined) throw new Error("--tag can be specified only once.");
      tag = `v${normalizeRegistrySmokeVersion(value)}`;
    }
  }
  if (sha === undefined || tag === undefined) {
    throw new Error("Both --tag and --sha are required.");
  }
  return { sha, tag, version: tag.slice(1) };
}

function integrityHex(integrity) {
  const match = /^sha512-([A-Za-z0-9+/]+={0,2})$/u.exec(integrity);
  assert.notEqual(match, null, "Registry package integrity must be one sha512 digest.");
  const digest = Buffer.from(match[1], "base64");
  assert.equal(digest.length, 64, "Registry package integrity must decode to 64 sha512 bytes.");
  return digest.toString("hex");
}

function decodePayload(bundle) {
  const envelope = record(record(bundle, "SLSA bundle").dsseEnvelope, "SLSA DSSE envelope");
  assert.equal(envelope.payloadType, "application/vnd.in-toto+json", "SLSA payload type drifted.");
  const payload = requiredString(envelope.payload, "SLSA payload");
  return record(JSON.parse(Buffer.from(payload, "base64").toString("utf8")), "SLSA statement");
}

function provenanceBundle(entry, name, version) {
  const selected = record(entry, `${name} npm signature-audit result`);
  assert.equal(selected.name, name, `${name} npm signature-audit identity drifted.`);
  assert.equal(selected.version, version, `${name} npm signature-audit version drifted.`);
  if (selected.attestations?.provenance?.predicateType !== SLSA_PROVENANCE_TYPE) {
    throw new ProvenancePropagationError(`${name} cryptographically verified provenance is not available yet.`);
  }
  assert.equal(Array.isArray(selected.attestationBundles), true, `${name} verified attestation bundles are missing.`);
  const bundles = selected.attestationBundles.filter(({ predicateType }) => predicateType === SLSA_PROVENANCE_TYPE);
  if (bundles.length === 0) {
    throw new ProvenancePropagationError(`${name} cryptographically verified provenance bundle is not available yet.`);
  }
  assert.equal(bundles.length, 1, `${name} must expose exactly one cryptographically verified SLSA provenance bundle.`);
  return { attestations: bundles };
}

export function assertNpmSignatureAudit(audit, version) {
  const result = record(audit, "npm signature audit");
  assert.deepEqual(result.invalid, [], "npm found an invalid registry signature or Sigstore attestation.");
  assert.deepEqual(result.missing, [], "npm found a package with a missing registry signature.");
  assert.equal(Array.isArray(result.verified), true, "npm signature audit did not return verified attestations.");
  const verified = new Map();
  for (const { name } of RELEASE_PACKAGES) {
    const candidates = result.verified.filter((entry) => entry?.name === name && entry?.version === version);
    if (candidates.length === 0) {
      throw new ProvenancePropagationError(`${name}@${version} is not in npm's cryptographically verified attestation set yet.`);
    }
    assert.equal(candidates.length, 1, `${name}@${version} appeared more than once in npm's verified attestation set.`);
    verified.set(name, provenanceBundle(candidates[0], name, version));
  }
  return verified;
}

export async function verifyNpmAuditIdentities({ audit, sigstoreVerify, tag, tufCachePath, version }) {
  assert.equal(typeof sigstoreVerify, "function", "Sigstore identity verifier is unavailable.");
  const expectedIdentity = `${RELEASE_REPOSITORY}/.github/workflows/release.yml@refs/tags/${tag}`;
  const verified = assertNpmSignatureAudit(audit, version);
  for (const { name } of RELEASE_PACKAGES) {
    const [entry] = verified.get(name).attestations;
    try {
      await sigstoreVerify(entry.bundle, {
        certificateIdentityURI: expectedIdentity,
        certificateIssuer: GITHUB_OIDC_ISSUER,
        tufCachePath,
        tufForceCache: true,
      });
    } catch (error) {
      throw new Error(
        `${name}@${version} provenance certificate is not bound to ${expectedIdentity}: ${error instanceof Error ? error.message : String(error)}`,
        { cause: error },
      );
    }
  }
}

async function runCommand(command, arguments_, { cwd, env }) {
  const child = spawn(command, arguments_, { cwd, env, stdio: ["ignore", "pipe", "pipe"] });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => { stdout = `${stdout}${chunk}`.slice(-2_000_000); });
  child.stderr.on("data", (chunk) => { stderr = `${stderr}${chunk}`.slice(-100_000); });
  let timedOut = false;
  const code = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
    }, 120_000);
    child.once("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once("close", (result) => {
      clearTimeout(timer);
      resolve(result);
    });
  });
  if (timedOut) throw new ProvenancePropagationError(`${command} exceeded 120 seconds.`);
  return { code, stderr, stdout };
}

export async function auditReleaseSignatures({ execute = runCommand, importSigstore, tag, version }) {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "uiwitness-provenance-"));
  const environment = { ...process.env, npm_config_cache: path.join(temporary, ".npm-cache") };
  try {
    await writeFile(path.join(temporary, "package.json"), `${JSON.stringify({
      dependencies: Object.fromEntries(RELEASE_PACKAGES.map(({ name }) => [name, version])),
      name: "uiwitness-release-provenance",
      private: true,
      version: "0.0.0",
    }, null, 2)}\n`, "utf8");
    const install = await execute("npm", [
      "install",
      "--ignore-scripts",
      "--no-audit",
      "--no-fund",
      "--save-exact",
      "--registry",
      `${NPM_REGISTRY_ORIGIN}/`,
    ], { cwd: temporary, env: environment });
    if (install.code !== 0) {
      throw new ProvenancePropagationError(`Exact npm packages are not installable yet: ${install.stderr || install.stdout}`);
    }
    const audit = await execute("npm", [
      "audit",
      "signatures",
      "--json",
      "--include-attestations",
      "--registry",
      `${NPM_REGISTRY_ORIGIN}/`,
    ], { cwd: temporary, env: environment });
    let parsed;
    try {
      parsed = JSON.parse(audit.stdout);
    } catch {
      throw new Error(`npm signature audit returned invalid JSON: ${audit.stderr || audit.stdout}`);
    }
    if (audit.code !== 0 && Array.isArray(parsed.invalid) && parsed.invalid.length > 0) {
      throw new Error("npm cryptographic verification rejected a registry signature or Sigstore attestation.");
    }
    if (audit.code !== 0) {
      throw new ProvenancePropagationError(`npm signature audit is not complete yet: ${audit.stderr || audit.stdout}`);
    }
    const npmRoot = await execute("npm", ["root", "--global"], { cwd: temporary, env: environment });
    assert.equal(npmRoot.code, 0, `Could not resolve npm's bundled Sigstore verifier: ${npmRoot.stderr || npmRoot.stdout}`);
    const sigstore = importSigstore === undefined
      ? await import(pathToFileURL(path.join(npmRoot.stdout.trim(), "npm", "node_modules", "sigstore", "dist", "index.js")).href)
      : await importSigstore();
    await verifyNpmAuditIdentities({
      audit: parsed,
      sigstoreVerify: sigstore.verify,
      tag,
      tufCachePath: path.join(environment.npm_config_cache, "_tuf"),
      version,
    });
    return parsed;
  } finally {
    await rm(temporary, { force: true, recursive: true });
  }
}

export function assertReleaseProvenance({ attestationDocument, metadata, name, sha, tag, version }) {
  normalizeReleaseSha(sha);
  const packageMetadata = record(metadata, `${name} registry metadata`);
  assert.equal(packageMetadata.name, name, `${name} registry identity drifted.`);
  assert.equal(packageMetadata.version, version, `${name} registry version drifted.`);
  const dist = record(packageMetadata.dist, `${name} registry dist metadata`);
  const integrity = requiredString(dist.integrity, `${name} registry integrity`);
  const attestations = record(dist.attestations, `${name} registry attestation metadata`);
  assert.equal(attestations.provenance?.predicateType, SLSA_PROVENANCE_TYPE, `${name} does not advertise SLSA provenance.`);

  const document = record(attestationDocument, `${name} attestation document`);
  assert.equal(Array.isArray(document.attestations), true, `${name} attestation list is missing.`);
  const provenanceEntries = document.attestations.filter((entry) => entry?.predicateType === SLSA_PROVENANCE_TYPE);
  assert.equal(provenanceEntries.length, 1, `${name} must expose exactly one SLSA provenance statement.`);
  const statement = decodePayload(provenanceEntries[0].bundle);
  assert.equal(statement._type, "https://in-toto.io/Statement/v1", `${name} provenance statement type drifted.`);
  assert.equal(statement.predicateType, SLSA_PROVENANCE_TYPE, `${name} provenance predicate type drifted.`);
  assert.equal(Array.isArray(statement.subject), true, `${name} provenance subjects are missing.`);
  assert.equal(statement.subject.length, 1, `${name} provenance must bind exactly one package subject.`);
  const subject = record(statement.subject[0], `${name} provenance subject`);
  assert.equal(subject.name, `pkg:npm/${name}@${version}`, `${name} provenance subject drifted.`);
  assert.equal(subject.digest?.sha512, integrityHex(integrity), `${name} provenance digest does not match npm integrity.`);

  const predicate = record(statement.predicate, `${name} provenance predicate`);
  const buildDefinition = record(predicate.buildDefinition, `${name} provenance build definition`);
  assert.equal(buildDefinition.buildType, GITHUB_WORKFLOW_BUILD_TYPE, `${name} provenance build type drifted.`);
  const workflow = record(buildDefinition.externalParameters?.workflow, `${name} provenance workflow`);
  assert.deepEqual(workflow, {
    path: RELEASE_WORKFLOW_PATH,
    ref: `refs/tags/${tag}`,
    repository: RELEASE_REPOSITORY,
  }, `${name} provenance is not bound to the release workflow and tag.`);
  assert.equal(Array.isArray(buildDefinition.resolvedDependencies), true, `${name} provenance resolved dependencies are missing.`);
  assert.equal(buildDefinition.resolvedDependencies.length, 1, `${name} provenance must resolve exactly one release source.`);
  assert.deepEqual(buildDefinition.resolvedDependencies[0], {
    digest: { gitCommit: sha },
    uri: `git+${RELEASE_REPOSITORY}@refs/tags/${tag}`,
  }, `${name} provenance is not bound to release commit ${sha}.`);
  assert.equal(buildDefinition.internalParameters?.github?.event_name, "release", `${name} provenance event must be release.`);
  return { integrity, name, sha, tag, version };
}

async function registryJson({ fetchImpl, label, url }) {
  let response;
  try {
    response = await fetchImpl(url, { redirect: "manual" });
  } catch (error) {
    throw new ProvenancePropagationError(`${label} is not reachable yet: ${error instanceof Error ? error.message : String(error)}`);
  }
  if (response.ok) {
    try {
      return await response.json();
    } catch (error) {
      throw new ProvenancePropagationError(`${label} returned incomplete JSON: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (retryableStatuses.has(response.status)) {
    throw new ProvenancePropagationError(`${label} returned HTTP ${response.status}.`);
  }
  throw new Error(`${label} returned HTTP ${response.status}.`);
}

export async function verifyReleaseProvenance({
  signatureAudit = auditReleaseSignatures,
  fetchImpl = fetch,
  now = Date.now,
  sha,
  sleep = (duration) => new Promise((resolve) => setTimeout(resolve, duration)),
  tag,
} = {}) {
  const normalizedSha = normalizeReleaseSha(sha);
  const version = normalizeRegistrySmokeVersion(tag);
  const normalizedTag = `v${version}`;
  const deadline = now() + PROVENANCE_RETRY_WINDOW_MS;
  while (true) {
    try {
      const audited = assertNpmSignatureAudit(await signatureAudit({ tag: normalizedTag, version }), version);
      const verified = [];
      for (const { name } of RELEASE_PACKAGES) {
        const metadataUrl = `${NPM_REGISTRY_ORIGIN}/${encodeURIComponent(name)}/${version}`;
        const metadata = await registryJson({ fetchImpl, label: `${name} registry metadata`, url: metadataUrl });
        if (metadata?.dist?.attestations?.url === undefined || metadata.dist.attestations.provenance === undefined) {
          throw new ProvenancePropagationError(`${name} registry attestation metadata is not available yet.`);
        }
        const attestationUrl = new URL(metadata.dist.attestations.url, NPM_REGISTRY_ORIGIN);
        assert.equal(attestationUrl.origin, NPM_REGISTRY_ORIGIN, `${name} attestation URL escaped the npm registry.`);
        assert.equal(attestationUrl.pathname, `/-/npm/v1/attestations/${name}@${version}`, `${name} attestation URL drifted.`);
        verified.push(assertReleaseProvenance({ attestationDocument: audited.get(name), metadata, name, sha: normalizedSha, tag: normalizedTag, version }));
      }
      return Object.freeze(verified);
    } catch (error) {
      if (!(error instanceof ProvenancePropagationError) || now() >= deadline) throw error;
      const remaining = deadline - now();
      if (remaining <= 0) throw error;
      await sleep(Math.min(PROVENANCE_RETRY_DELAY_MS, remaining));
    }
  }
}

async function main() {
  const options = parseProvenanceArguments(process.argv.slice(2));
  const verified = await verifyReleaseProvenance(options);
  console.log(`Release provenance passed: npm cryptographically verified ${verified.length} packages bound to ${options.tag} at ${options.sha}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
