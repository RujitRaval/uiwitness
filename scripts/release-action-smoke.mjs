import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";

const actionRepository = "RujitRaval/uiwitness";
export const ACTION_METADATA_SHA256 = "c1e908414dd813dabb584bed7b44841e73397deb6a06d862671e78fb48a5dd24";
const commitPattern = /^[0-9a-f]{40}$/u;
const passingKinds = new Set(["matched", "matched-known-failure"]);

export function normalizeActionSha(value) {
  assert.equal(typeof value === "string" && commitPattern.test(value), true, "Action SHA must be one lowercase 40-character commit SHA.");
  return value;
}

export function actionWorkflowSource({ nodeVersion = process.versions.node, packageVersion, sha }) {
  normalizeActionSha(sha);
  assert.match(nodeVersion, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
  assert.match(packageVersion, /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)$/u);
  return `name: UIWitness release fixture

on:
  workflow_dispatch:

permissions:
  contents: read

jobs:
  guard:
    runs-on: ubuntu-24.04
    steps:
      - uses: actions/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1 # v7.0.1
      - uses: actions/setup-node@820762786026740c76f36085b0efc47a31fe5020 # v7.0.0
        with:
          node-version: ${nodeVersion}
      - run: >-
          npm install --ignore-scripts --no-audit --no-fund --package-lock=false
          ./packages/uiwitness-core-${packageVersion}.tgz
          ./packages/uiwitness-report-${packageVersion}.tgz
          ./packages/uiwitness-runner-playwright-${packageVersion}.tgz
          ./packages/uiwitness-${packageVersion}.tgz
      - run: npm exec --offline -- playwright install chromium
      - uses: ${actionRepository}@${sha} # v${packageVersion}
`;
}

export function parseActionOutputs(source) {
  const values = {};
  for (const line of source.split(/\r?\n/u)) {
    if (line.length === 0) continue;
    const separator = line.indexOf("=");
    assert.notEqual(separator, -1, `Invalid GitHub Action output line: ${line}`);
    const name = line.slice(0, separator);
    assert.equal(Object.hasOwn(values, name), false, `Duplicate GitHub Action output: ${name}`);
    values[name] = line.slice(separator + 1);
  }
  return values;
}

export function assertActionMetadataContract(source) {
  assert.equal(typeof source, "string");
  assert.equal(
    createHash("sha256").update(source).digest("hex"),
    ACTION_METADATA_SHA256,
    "Action metadata must match the complete reviewed composite contract with no additional fields or steps.",
  );
  assert.match(source, /^name: UIWitness Contract Guard$/mu);
  assert.match(source, /runs:\n {2}using: composite/u);
  assert.match(source, /id: guard\n {6}continue-on-error: true/u);
  for (const [input, environment] of [
    ["config", "UIWITNESS_INPUT_CONFIG"],
    ["contract", "UIWITNESS_INPUT_CONTRACT"],
    ["upload-artifact", "UIWITNESS_INPUT_UPLOAD_ARTIFACT"],
    ["retention-days", "UIWITNESS_INPUT_RETENTION_DAYS"],
    ["annotation-cap", "UIWITNESS_INPUT_ANNOTATION_CAP"],
  ]) {
    assert.match(source, new RegExp(`${environment}: \\$\\{\\{ inputs\\.${input} \\}\\}`, "u"));
  }
  assert.equal((source.match(/index\.mjs" run/gu) ?? []).length, 1, "Action metadata must run the guard exactly once.");
  assert.equal((source.match(/index\.mjs" finalize/gu) ?? []).length, 1, "Action metadata must finalize exactly once.");
  assert.match(source, /if: \$\{\{ always\(\) && inputs\.upload-artifact == 'true' \}\}[\s\S]*uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.match(source, /name: Preserve UIWitness exit semantics\n {6}if: \$\{\{ always\(\) \}\}[\s\S]*UIWITNESS_GUARD_EXIT_CODE: \$\{\{ steps\.guard\.outputs\.exit-code \}\}/u);
  for (const output of ["verdict", "exit-class", "report-path", "contract-digest", "finding-count", "matched-count", "blocking-count"]) {
    assert.match(source, new RegExp(`^  ${output}:\\n(?: {4}.*\\n)+ {4}value: \\$\\{\\{ steps\\.guard\\.outputs\\.${output} \\}\\}$`, "mu"));
  }
}

export function assertCliActionParity(verdict, outputs, expectedExitCode) {
  assert.equal(verdict.schemaVersion, 1);
  const matched = verdict.findings.filter(({ kind }) => passingKinds.has(kind)).length;
  assert.deepEqual({
    blocking: outputs["blocking-count"],
    contractDigest: outputs["contract-digest"],
    exitClass: outputs["exit-class"],
    exitCode: outputs["exit-code"],
    findings: outputs["finding-count"],
    matched: outputs["matched-count"],
    reportPath: outputs["report-path"],
    verdict: outputs.verdict,
  }, {
    blocking: String(verdict.findings.length - matched),
    contractDigest: verdict.contractDigest,
    exitClass: expectedExitCode === 0 ? "success" : "contract-failure",
    exitCode: String(expectedExitCode),
    findings: String(verdict.findings.length),
    matched: String(matched),
    reportPath: ".uiwitness/report/index.html",
    verdict: verdict.verdict,
  });
}

function assertCommand(result, label, expectedCode = 0) {
  assert.equal(result.code, expectedCode, `${label} exited ${String(result.code)}:\n${result.stderr || result.stdout}`);
}

async function actionInvocation({ actionRoot, consumerRoot, execute, label }) {
  const output = path.join(consumerRoot, `.github-output-${label}.txt`);
  const summary = path.join(consumerRoot, `.github-summary-${label}.md`);
  const guardResult = await execute(
    process.execPath,
    [path.join(actionRoot, ".github", "actions", "uiwitness-guard", "index.mjs"), "run"],
    {
      cwd: consumerRoot,
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: actionRoot,
        GITHUB_OUTPUT: output,
        GITHUB_STEP_SUMMARY: summary,
        UIWITNESS_INPUT_ANNOTATION_CAP: "10",
        UIWITNESS_INPUT_CONFIG: "",
        UIWITNESS_INPUT_CONTRACT: "",
        UIWITNESS_INPUT_RETENTION_DAYS: "1",
        UIWITNESS_INPUT_UPLOAD_ARTIFACT: "false",
      },
    },
  );
  const outputs = parseActionOutputs(await readFile(output, "utf8"));
  const result = await execute(
    process.execPath,
    [path.join(actionRoot, ".github", "actions", "uiwitness-guard", "index.mjs"), "finalize"],
    {
      cwd: consumerRoot,
      env: {
        ...process.env,
        GITHUB_ACTION_PATH: actionRoot,
        UIWITNESS_GUARD_EXIT_CODE: outputs["exit-code"],
      },
    },
  );
  return { guardResult, outputs, result };
}

async function directGuard({ cliBinPath, consumerRoot, execute, label }) {
  const verdictPath = `.uiwitness/release-${label}-verdict.json`;
  const result = await execute(process.execPath, [cliBinPath, "guard", "--json", verdictPath], { cwd: consumerRoot });
  return {
    result,
    verdict: JSON.parse(await readFile(path.join(consumerRoot, verdictPath), "utf8")),
  };
}

export async function runReleaseActionFixture({
  actionRoot,
  actionSha,
  cliBinPath,
  consumerRoot,
  execute,
  fixtureUrl,
  packageVersion,
} = {}) {
  const sha = normalizeActionSha(actionSha);
  assert.equal(typeof execute, "function");
  const actionHead = await execute("git", ["rev-parse", "HEAD"], { cwd: actionRoot });
  assertCommand(actionHead, "Resolving the checked-out Action commit");
  assert.equal(actionHead.stdout.trim(), sha, "The Action SHA must match the checked-out release commit.");
  assertActionMetadataContract(await readFile(path.join(actionRoot, "action.yml"), "utf8"));
  const initializeRepository = await execute("git", ["init", "--quiet"], { cwd: consumerRoot });
  assertCommand(initializeRepository, "Initializing the temporary Action consumer repository");
  const workflowPath = path.join(consumerRoot, ".github", "workflows", "uiwitness.yml");
  await mkdir(path.dirname(workflowPath), { recursive: true });
  await writeFile(workflowPath, actionWorkflowSource({ packageVersion, sha }), "utf8");
  await writeFile(
    path.join(consumerRoot, "uiwitness.config.mts"),
    `import { defineConfig } from "uiwitness";

export default defineConfig({
  baseURL: ${JSON.stringify(fixtureUrl)},
  viewports: { desktop: { width: 1280, height: 800 } },
  themes: ["light"],
  routes: [{ id: "home", path: "/", states: [{ id: "success", setup: "./uiwitness/scenarios/home/success.mts" }] }],
});
`,
    "utf8",
  );

  const initialize = await execute(process.execPath, [cliBinPath, "contract", "init"], { cwd: consumerRoot });
  assertCommand(initialize, "Initializing the packed release contract");

  const passingCli = await directGuard({ cliBinPath, consumerRoot, execute, label: "passing" });
  assertCommand(passingCli.result, "Running the passing packed CLI guard");
  const passingAction = await actionInvocation({ actionRoot, consumerRoot, execute, label: "passing" });
  assertCommand(passingAction.guardResult, "Running the passing composite guard step");
  assertCommand(passingAction.result, "Running the passing pinned Action");
  assertCliActionParity(passingCli.verdict, passingAction.outputs, 0);

  await writeFile(
    path.join(consumerRoot, "uiwitness", "scenarios", "home", "success.mts"),
    `export default { async assert() { throw new Error("Seeded T14 release regression."); } };\n`,
    "utf8",
  );
  const failingCli = await directGuard({ cliBinPath, consumerRoot, execute, label: "regression" });
  assertCommand(failingCli.result, "Running the seeded-regression packed CLI guard", 1);
  const failingAction = await actionInvocation({ actionRoot, consumerRoot, execute, label: "regression" });
  assertCommand(failingAction.guardResult, "Running the seeded-regression composite guard step", 1);
  assertCommand(failingAction.result, "Running the seeded-regression pinned Action", 1);
  assertCliActionParity(failingCli.verdict, failingAction.outputs, 1);
  assert.equal(failingCli.verdict.findings.some(({ kind }) => kind === "regression"), true);

  return Object.freeze({
    actionSha: sha,
    packageVersion,
    regressionVerdict: failingCli.verdict.verdict,
    passingVerdict: passingCli.verdict.verdict,
  });
}
