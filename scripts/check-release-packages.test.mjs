import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";

import {
  npmVersionFromRelease,
  RELEASE_PACKAGES,
  syncReleaseVersions,
  validateManifest,
  validateReleaseWorkspace,
} from "./check-release-packages.mjs";

const executeFile = promisify(execFile);
const repositoryRoot = path.resolve(import.meta.dirname, "..");
const checkedInRelease = await validateReleaseWorkspace({ root: repositoryRoot });

async function copyReleaseFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), "uiwitness-release-contract-"));
  await cp(path.join(repositoryRoot, "VERSION"), path.join(root, "VERSION"));
  await cp(path.join(repositoryRoot, "LICENSE"), path.join(root, "LICENSE"));
  await cp(path.join(repositoryRoot, "package.json"), path.join(root, "package.json"));
  for (const { directory } of RELEASE_PACKAGES) {
    const target = path.join(root, directory);
    await mkdir(target, { recursive: true });
    await cp(path.join(repositoryRoot, directory, "package.json"), path.join(target, "package.json"));
    await cp(path.join(repositoryRoot, directory, "README.md"), path.join(target, "README.md"));
    await cp(path.join(repositoryRoot, directory, "LICENSE"), path.join(target, "LICENSE"));
  }
  return root;
}

test("translates only collision-free four-part release versions", () => {
  assert.equal(npmVersionFromRelease("1.2.3.0"), "1.2.3");
  assert.throws(() => npmVersionFromRelease("1.2.3.4"), /zero MICRO/u);
  assert.throws(() => npmVersionFromRelease("1.2.3"), /MAJOR\.MINOR\.PATCH\.MICRO/u);
});

test("validates the checked-in public package metadata and tag", async () => {
  assert.deepEqual(
    await validateReleaseWorkspace({
      root: repositoryRoot,
      tag: `v${checkedInRelease.packageVersion}`,
    }),
    checkedInRelease,
  );
  await assert.rejects(
    validateReleaseWorkspace({ root: repositoryRoot, tag: `v${checkedInRelease.packageVersion}-wrong` }),
    /Release tag must be/u,
  );
});

test("rejects private packages and repository metadata drift", async () => {
  const contract = RELEASE_PACKAGES[0];
  const manifest = JSON.parse(
    await readFile(path.join(repositoryRoot, contract.directory, "package.json"), "utf8"),
  );
  assert.throws(
    () => validateManifest({ ...manifest, private: true }, contract, checkedInRelease.packageVersion),
    /must not set private/u,
  );
  assert.throws(
    () =>
      validateManifest(
        { ...manifest, repository: { ...manifest.repository, url: "https://example.com/wrong.git" } },
        contract,
        checkedInRelease.packageVersion,
      ),
    /repository URL/u,
  );
});

test("synchronizes every npm manifest from the four-part VERSION", async (context) => {
  const root = await copyReleaseFixture();
  context.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(path.join(root, "VERSION"), "0.24.0.0\n", "utf8");
  assert.deepEqual(await syncReleaseVersions({ root }), {
    packageVersion: "0.24.0",
    releaseVersion: "0.24.0.0",
  });
  assert.deepEqual(await validateReleaseWorkspace({ root, tag: "v0.24.0" }), {
    packageVersion: "0.24.0",
    releaseVersion: "0.24.0.0",
  });
});

test("writes explicit GitHub outputs without inheriting ambient output paths", async (context) => {
  const outputRoot = await mkdtemp(path.join(os.tmpdir(), "uiwitness-release-output-"));
  context.after(() => rm(outputRoot, { force: true, recursive: true }));
  const outputFile = path.join(outputRoot, "github-output");
  await writeFile(outputFile, "", "utf8");
  const { stdout } = await executeFile(
    process.execPath,
    [
      path.join(repositoryRoot, "scripts", "check-release-packages.mjs"),
      "--tag",
      `v${checkedInRelease.packageVersion}`,
      "--github-output",
      outputFile,
    ],
    {
      env: { ...process.env, GITHUB_OUTPUT: path.join(outputRoot, "ambient-output") },
    },
  );
  assert.match(stdout, new RegExp(`4 packages at ${checkedInRelease.packageVersion.replaceAll(".", "\\.")}`, "u"));
  assert.equal(
    await readFile(outputFile, "utf8"),
    `package-version=${checkedInRelease.packageVersion}\nrelease-version=${checkedInRelease.releaseVersion}\n`,
  );
});

test("separates bootstrap publication from automatic OIDC registry verification", async () => {
  const workflow = await readFile(path.join(repositoryRoot, ".github", "workflows", "release.yml"), "utf8");
  const prepareJob = workflow.slice(workflow.indexOf("  prepare-release:"), workflow.indexOf("  publish-npm:"));
  const publishJob = workflow.slice(workflow.indexOf("  publish-npm:"), workflow.indexOf("  verify-provenance:"));

  assert.doesNotMatch(workflow, /registry-url:/u);
  assert.doesNotMatch(prepareJob, /id-token: write|NPM_BOOTSTRAP_TOKEN_PRESENT|NODE_AUTH_TOKEN/u);
  assert.doesNotMatch(workflow, /^ {6}\S[^\n]*\$\{\{ runner\./mu);
  assert.match(prepareJob, /\$RUNNER_TEMP\/uiwitness-release-bundle/u);
  assert.match(publishJob, /\$RUNNER_TEMP\/uiwitness-release-bundle/u);
  assert.match(workflow, /NPM_BOOTSTRAP_TOKEN_PRESENT: \$\{\{ secrets\.NPM_TOKEN != '' \}\}/u);
  assert.match(
    workflow,
    /if: \$\{\{ env\.NPM_BOOTSTRAP_TOKEN_PRESENT == 'true' \}\}[\s\S]*npm config set \/\/registry\.npmjs\.org\/:_authToken/u,
  );
  assert.equal((workflow.match(/NODE_AUTH_TOKEN:/gu) ?? []).length, 1);
  assert.equal((workflow.match(/id-token: write/gu) ?? []).length, 1);
  assert.match(workflow, /bootstrap: \$\{\{ steps\.release-mode\.outputs\.bootstrap \}\}/u);
  const publishIndex = workflow.indexOf("- name: Publish npm artifacts");
  const registryGateIndex = workflow.indexOf("verify-public-url:");
  assert.equal(publishIndex >= 0, true);
  assert.equal(registryGateIndex > publishIndex, true);
  assert.match(
    workflow.slice(registryGateIndex),
    /node scripts\/public-url-registry-smoke\.mjs --tag "\$RELEASE_TAG" --with-deps/u,
  );
  assert.match(workflow.slice(registryGateIndex), /needs:\n {6}- publish-npm/u);
  assert.match(
    workflow.slice(registryGateIndex),
    /needs\.publish-npm\.outputs\.bootstrap == 'false'/u,
  );
  assert.match(workflow, /Use a fresh token for every retry\./u);
  assert.match(workflow.slice(registryGateIndex), /timeout-minutes: 25/u);
});
