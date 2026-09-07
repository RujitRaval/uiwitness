import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RELEASE_PACKAGES, validateReleaseWorkspace } from "./check-release-packages.mjs";
import { releaseTarballName } from "./release-package-smoke.mjs";
import { normalizeActionSha } from "./release-action-smoke.mjs";

export const RELEASE_MANIFEST_SCHEMA_VERSION = 1;

function record(value, label) {
  assert.equal(value !== null && typeof value === "object" && !Array.isArray(value), true, `${label} must be an object.`);
  return value;
}

function exactKeys(value, keys, label) {
  assert.deepEqual(Object.keys(value).sort(), [...keys].sort(), `${label} fields drifted.`);
}

async function packageDirectory(requestedPath) {
  const metadata = await lstat(requestedPath);
  assert.equal(metadata.isSymbolicLink(), false, "Release package directory must not be a symbolic link.");
  assert.equal(metadata.isDirectory(), true, "Release package directory must be a directory.");
  return realpath(requestedPath);
}

async function artifactIdentity(filePath) {
  const metadata = await lstat(filePath);
  assert.equal(metadata.isSymbolicLink(), false, `${path.basename(filePath)} must not be a symbolic link.`);
  assert.equal(metadata.isFile(), true, `${path.basename(filePath)} must be a regular file.`);
  const contents = await readFile(filePath);
  return Object.freeze({
    bytes: contents.length,
    sha512: createHash("sha512").update(contents).digest("hex"),
  });
}

async function expectedArtifacts({ packageRoot, packageVersion }) {
  const entries = await readdir(packageRoot);
  const expectedNames = RELEASE_PACKAGES.map(({ name }) => releaseTarballName(name, packageVersion));
  assert.deepEqual(entries.sort(), [...expectedNames].sort(), "Release package directory must contain exactly four expected tarballs.");
  return Promise.all(RELEASE_PACKAGES.map(async ({ name }) => {
    const file = releaseTarballName(name, packageVersion);
    return Object.freeze({ file, name, ...(await artifactIdentity(path.join(packageRoot, file))) });
  }));
}

export async function createReleaseArtifactManifest({ input, output, root, sha, tag }) {
  const releaseSha = normalizeActionSha(sha);
  const { packageVersion } = await validateReleaseWorkspace({ root, tag });
  const packageRoot = await packageDirectory(input);
  const manifest = Object.freeze({
    actionSha: releaseSha,
    packageVersion,
    packages: Object.freeze(await expectedArtifacts({ packageRoot, packageVersion })),
    releaseSha,
    releaseTag: tag,
    schemaVersion: RELEASE_MANIFEST_SCHEMA_VERSION,
  });
  await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`, { encoding: "utf8", flag: "wx", mode: 0o600 });
  return manifest;
}

export async function verifyReleaseArtifactManifest({ input, manifest: manifestPath, root, sha, tag }) {
  const releaseSha = normalizeActionSha(sha);
  const { packageVersion } = await validateReleaseWorkspace({ root, tag });
  const packageRoot = await packageDirectory(input);
  const manifestMetadata = await lstat(manifestPath);
  assert.equal(manifestMetadata.isSymbolicLink(), false, "Release artifact manifest must not be a symbolic link.");
  assert.equal(manifestMetadata.isFile(), true, "Release artifact manifest must be a regular file.");
  const manifest = record(JSON.parse(await readFile(manifestPath, "utf8")), "Release artifact manifest");
  exactKeys(manifest, ["actionSha", "packageVersion", "packages", "releaseSha", "releaseTag", "schemaVersion"], "Release artifact manifest");
  assert.equal(manifest.schemaVersion, RELEASE_MANIFEST_SCHEMA_VERSION, "Release artifact manifest schema drifted.");
  assert.equal(manifest.releaseTag, tag, "Release artifact manifest tag drifted.");
  assert.equal(manifest.releaseSha, releaseSha, "Release artifact manifest commit drifted.");
  assert.equal(manifest.actionSha, releaseSha, "Release artifact manifest Action SHA drifted.");
  assert.equal(manifest.packageVersion, packageVersion, "Release artifact manifest version drifted.");
  assert.equal(Array.isArray(manifest.packages), true, "Release artifact manifest packages must be an array.");
  const actual = await expectedArtifacts({ packageRoot, packageVersion });
  assert.deepEqual(manifest.packages, actual, "Release artifact bytes do not match the SHA-512 manifest.");
  return Object.freeze(manifest);
}

function parseArguments(arguments_) {
  const [command, ...rest] = arguments_;
  assert.equal(command === "create" || command === "verify", true, "Expected create or verify.");
  const values = {};
  for (let index = 0; index < rest.length; index += 2) {
    const key = rest[index];
    const value = rest[index + 1];
    assert.equal(["--input", "--manifest", "--output", "--sha", "--tag"].includes(key) && value !== undefined, true, `Invalid release manifest arguments: ${JSON.stringify(arguments_)}`);
    assert.equal(values[key] === undefined, true, `${key} can be specified only once.`);
    values[key] = value;
  }
  for (const key of ["--input", "--sha", "--tag", command === "create" ? "--output" : "--manifest"]) {
    assert.equal(typeof values[key] === "string", true, `${key} is required.`);
  }
  return { command, values };
}

async function main() {
  const { command, values } = parseArguments(process.argv.slice(2));
  const common = {
    input: values["--input"],
    root: path.resolve(import.meta.dirname, ".."),
    sha: values["--sha"],
    tag: values["--tag"],
  };
  const manifest = command === "create"
    ? await createReleaseArtifactManifest({ ...common, output: values["--output"] })
    : await verifyReleaseArtifactManifest({ ...common, manifest: values["--manifest"] });
  console.log(`Release artifact manifest ${command === "create" ? "created" : "verified"}: ${manifest.packages.length} exact tarballs at ${manifest.releaseSha}.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
