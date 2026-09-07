import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const releaseWorkflowPath = path.join(root, ".github", "workflows", "release.yml");
const ciWorkflowPath = path.join(root, ".github", "workflows", "ci.yml");
const verificationWorkflowPath = path.join(
  root,
  ".github",
  "workflows",
  "verify-registry-release.yml",
);

test("bootstrap publication cannot automatically start registry verification", async () => {
  const workflow = await readFile(releaseWorkflowPath, "utf8");
  const verificationJob = workflow.slice(workflow.indexOf("  verify-public-url:"));

  assert.match(workflow, /NPM_BOOTSTRAP_TOKEN_PRESENT: \$\{\{ secrets\.NPM_TOKEN != '' \}\}/u);
  assert.match(workflow, /bootstrap: \$\{\{ steps\.release-mode\.outputs\.bootstrap \}\}/u);
  assert.match(
    verificationJob,
    /if: \$\{\{ needs\.publish-npm\.result == 'success' && needs\.publish-npm\.outputs\.bootstrap == 'false' && needs\.verify-provenance\.result == 'success' \}\}/u,
  );
  assert.match(workflow, /Use a fresh token for every retry\./u);
  assert.match(
    workflow,
    /if: \$\{\{ always\(\) && env\.NPM_BOOTSTRAP_TOKEN_PRESENT == 'true' \}\}/u,
  );
  assert.equal((workflow.match(/NODE_AUTH_TOKEN: \$\{\{ secrets\.NPM_TOKEN \}\}/gu) ?? []).length, 1);
});

test("normal OIDC publication remains token-free and automatically gates on the registry journey", async () => {
  const workflow = await readFile(releaseWorkflowPath, "utf8");
  const provenanceJob = workflow.slice(
    workflow.indexOf("  verify-provenance:"),
    workflow.indexOf("  verify-public-url:"),
  );
  const verificationJob = workflow.slice(workflow.indexOf("  verify-public-url:"));

  assert.match(provenanceJob, /needs: publish-npm/u);
  assert.match(provenanceJob, /node scripts\/verify-release-provenance\.mjs --tag "\$RELEASE_TAG" --sha "\$RELEASE_SHA"/u);
  assert.match(verificationJob, /- publish-npm\n {6}- verify-provenance/u);
  assert.match(verificationJob, /node-version:\n {10}- 22\.20\.0\n {10}- 24\.19\.0/u);
  assert.match(verificationJob, /RELEASE_SHA: \$\{\{ needs\.publish-npm\.outputs\.release-sha \}\}/u);
  assert.match(verificationJob, /test "\$\(git rev-parse HEAD\)" = "\$RELEASE_SHA"/u);
  assert.match(
    verificationJob,
    /node scripts\/public-url-registry-smoke\.mjs --tag "\$RELEASE_TAG" --with-deps/u,
  );
  assert.doesNotMatch(verificationJob, /NPM_TOKEN|NODE_AUTH_TOKEN/u);
});

test("the exact packed release artifacts and Action SHA are proved on Node 22 and 24 before publication", async () => {
  const workflow = await readFile(releaseWorkflowPath, "utf8");
  const prepareJob = workflow.slice(workflow.indexOf("  prepare-release:"), workflow.indexOf("  publish-npm:"));
  const publishJob = workflow.slice(workflow.indexOf("  publish-npm:"), workflow.indexOf("  verify-provenance:"));
  assert.match(prepareJob, /release-package-smoke\.mjs --output "\$RUNNER_TEMP\/uiwitness-release-bundle\/packages" --action-sha "\$GITHUB_SHA"/u);
  assert.match(prepareJob, /node-version: 22\.20\.0[\s\S]*release-package-smoke\.mjs --input "\$RUNNER_TEMP\/uiwitness-release-bundle\/packages" --action-sha "\$GITHUB_SHA"/u);
  assert.match(prepareJob, /release-artifact-manifest\.mjs create[\s\S]*actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.doesNotMatch(prepareJob, /id-token: write|NPM_TOKEN|NODE_AUTH_TOKEN/u);

  assert.match(publishJob, /needs: prepare-release/u);
  assert.match(publishJob, /id-token: write/u);
  assert.match(publishJob, /actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/u);
  assert.match(publishJob, /release-artifact-manifest\.mjs verify/u);
  assert.match(publishJob, /publish-release-packages\.mjs --input "\$RUNNER_TEMP\/uiwitness-release-bundle\/packages"/u);
  assert.doesNotMatch(publishJob, /pnpm install|playwright install|release-package-smoke|run-ci\.mjs|benchmark:contract|release:smoke/u);
  assert.equal((publishJob.match(/scripts\/publish-release-packages\.mjs/gu) ?? []).length, 1);

  const ci = await readFile(ciWorkflowPath, "utf8");
  const packageSmoke = ci.slice(ci.indexOf("  package-smoke:"));
  assert.match(packageSmoke, /node-version:\n {10}- 22\.20\.0\n {10}- 24\.19\.0/u);
  assert.match(packageSmoke, /release:package-smoke -- --action-sha "\$GITHUB_SHA"/u);
});

test("manual bootstrap verification binds cleanup evidence to an immutable release tag and SHA", async () => {
  const workflow = await readFile(verificationWorkflowPath, "utf8");

  assert.match(workflow, /workflow_dispatch:/u);
  assert.match(workflow, /release_tag:[\s\S]*required: true[\s\S]*cleanup_evidence:[\s\S]*required: true/u);
  assert.match(workflow, /ref: \$\{\{ inputs\.release_tag \}\}/u);
  assert.match(workflow, /fetch-depth: 0/u);
  assert.match(workflow, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/u);
  assert.match(workflow, /git merge-base --is-ancestor "\$RELEASE_SHA" origin\/main/u);
  assert.match(workflow, /node scripts\/check-release-packages\.mjs --tag "\$RELEASE_TAG"/u);
  assert.match(workflow, /gh release view "\$RELEASE_TAG" --json tagName/u);
  assert.match(workflow, /gh release view "\$RELEASE_TAG" --json isDraft --jq \.isDraft/u);
  assert.match(
    workflow,
    /gh release view "\$RELEASE_TAG" --json isPrerelease --jq \.isPrerelease/u,
  );
  assert.match(workflow, /node scripts\/verify-bootstrap-cleanup\.mjs/u);
  assert.match(workflow, /--sha "\$\{\{ steps\.release\.outputs\.release-sha \}\}"/u);
  assert.match(workflow, /node scripts\/public-url-registry-smoke\.mjs --tag "\$RELEASE_TAG" --with-deps/u);
  assert.match(workflow, /node scripts\/verify-release-provenance\.mjs --tag "\$RELEASE_TAG" --sha "\$\{\{ steps\.release\.outputs\.release-sha \}\}"/u);
  assert.doesNotMatch(workflow, /secrets\.NPM_TOKEN|NODE_AUTH_TOKEN|id-token: write/u);
});
