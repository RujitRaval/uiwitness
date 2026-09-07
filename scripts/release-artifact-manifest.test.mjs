import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { RELEASE_PACKAGES, validateReleaseWorkspace } from "./check-release-packages.mjs";
import { createReleaseArtifactManifest, verifyReleaseArtifactManifest } from "./release-artifact-manifest.mjs";
import { releaseTarballName } from "./release-package-smoke.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sha = "0123456789abcdef0123456789abcdef01234567";

async function fixture() {
  const temporary = await mkdtemp(path.join(os.tmpdir(), "uiwitness-release-manifest-"));
  const packages = path.join(temporary, "packages");
  await mkdir(packages);
  const { packageVersion } = await validateReleaseWorkspace({ root });
  for (const { name } of RELEASE_PACKAGES) {
    await writeFile(path.join(packages, releaseTarballName(name, packageVersion)), `artifact:${name}\n`, "utf8");
  }
  return { manifest: path.join(temporary, "release-manifest.json"), packageVersion, packages, tag: `v${packageVersion}` };
}

test("creates and verifies a release manifest for exactly four immutable artifacts", async () => {
  const selected = await fixture();
  const created = await createReleaseArtifactManifest({ input: selected.packages, output: selected.manifest, root, sha, tag: selected.tag });
  assert.equal(created.packages.length, 4);
  assert.equal(created.packages.every(({ sha512 }) => /^[0-9a-f]{128}$/u.test(sha512)), true);
  await assert.doesNotReject(verifyReleaseArtifactManifest({ input: selected.packages, manifest: selected.manifest, root, sha, tag: selected.tag }));
});

test("rejects changed artifact bytes, release identity, and extra files", async () => {
  const selected = await fixture();
  await createReleaseArtifactManifest({ input: selected.packages, output: selected.manifest, root, sha, tag: selected.tag });
  const first = path.join(selected.packages, releaseTarballName(RELEASE_PACKAGES[0].name, selected.packageVersion));
  await writeFile(first, "tampered\n", "utf8");
  await assert.rejects(verifyReleaseArtifactManifest({ input: selected.packages, manifest: selected.manifest, root, sha, tag: selected.tag }), /do not match/u);

  const selectedIdentity = await fixture();
  await createReleaseArtifactManifest({ input: selectedIdentity.packages, output: selectedIdentity.manifest, root, sha, tag: selectedIdentity.tag });
  const parsed = JSON.parse(await readFile(selectedIdentity.manifest, "utf8"));
  parsed.releaseSha = "f".repeat(40);
  await writeFile(selectedIdentity.manifest, JSON.stringify(parsed), "utf8");
  await assert.rejects(verifyReleaseArtifactManifest({ input: selectedIdentity.packages, manifest: selectedIdentity.manifest, root, sha, tag: selectedIdentity.tag }), /commit drifted/u);

  const selectedExtra = await fixture();
  await createReleaseArtifactManifest({ input: selectedExtra.packages, output: selectedExtra.manifest, root, sha, tag: selectedExtra.tag });
  await writeFile(path.join(selectedExtra.packages, "extra.tgz"), "extra", "utf8");
  await assert.rejects(verifyReleaseArtifactManifest({ input: selectedExtra.packages, manifest: selectedExtra.manifest, root, sha, tag: selectedExtra.tag }), /exactly four/u);
});
