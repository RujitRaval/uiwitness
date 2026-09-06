import assert from "node:assert/strict";
import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  MAXIMUM_ANNOTATIONS,
  MAXIMUM_SUMMARY_BYTES,
  annotationCommands,
  boundedSummary,
  buildSummary,
  finalizeAction,
  normalizeActionVersion,
  parseActionInputs,
  parseMachineVerdict,
  runAction,
} from "../.github/actions/uiwitness-guard/index.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const digest = `sha256:${"0".repeat(64)}`;
const currentVersion = normalizeActionVersion(
  await readFile(path.join(repositoryRoot, "VERSION"), "utf8"),
);

function verdict(status = "passed", findings) {
  const selectedFindings = findings ?? (status === "passed"
    ? [{ actual: { status: "passed" }, expected: { status: "passed" }, id: "home/success/desktop/light", kind: "matched" }]
    : [{ actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" }, expected: { status: "passed" }, id: "home/success/desktop/light", kind: "regression" }]);
  return {
    complete: status !== "error",
    configDigest: digest,
    contractDigest: digest,
    evaluatedOn: "2026-09-05",
    findings: selectedFindings.map((finding) => ({
      ...finding,
      ...(["changed-known-failure", "recovered-known-failure", "regression"].includes(finding.kind)
        ? { reproduce: finding.reproduce ?? `uiwitness scan --coordinate ${finding.id} --headed` }
        : {}),
      ...(["changed-known-failure", "expired-exception", "missing-coordinate", "recovered-known-failure", "regression", "unaccepted-addition", "unaccepted-config-drift"].includes(finding.kind)
        ? { remediate: finding.remediate ?? `uiwitness contract inspect --candidate .uiwitness/candidate.json --change expectation:${finding.id}` }
        : {}),
    })),
    runDigest: digest,
    schemaVersion: 1,
    verdict: status,
  };
}

async function temporaryProject() {
  return import("node:fs/promises").then(({ mkdtemp }) => mkdtemp(path.join(os.tmpdir(), "uiwitness-action-")));
}

async function installFakeCli(root, options = {}) {
  const binDirectory = path.join(root, "node_modules", "uiwitness", "dist");
  const executable = path.join(binDirectory, "bin.js");
  await mkdir(binDirectory, { recursive: true });
  const verdictSource = options.rawVerdict ?? JSON.stringify(options.verdict ?? verdict(options.exitCode === 1 ? "failed" : "passed"));
  const source = `#!/usr/bin/env node
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
const args = process.argv.slice(2);
if (args[0] === "--version") {
  process.stdout.write(${JSON.stringify(options.version ?? currentVersion)} + "\\n");
  process.exit(0);
}
await writeFile(path.join(process.cwd(), "guard-args.json"), JSON.stringify(args), "utf8");
${options.guardMarker === undefined ? "" : `await writeFile(path.join(process.cwd(), ${JSON.stringify(options.guardMarker)}), "called", "utf8");`}
${options.writeVerdict === false ? "" : `await mkdir(path.join(process.cwd(), ".uiwitness", "report"), { recursive: true });
    const explicitIndex = args.indexOf("--json");
    const verdictPath = explicitIndex === -1 ? ".uiwitness/contract-verdict.json" : args[explicitIndex + 1];
    await mkdir(path.dirname(path.join(process.cwd(), verdictPath)), { recursive: true });
    await writeFile(path.join(process.cwd(), verdictPath), ${JSON.stringify(verdictSource)} + "\\n", "utf8");
await writeFile(path.join(process.cwd(), ".uiwitness", "report", "index.html"), "<!doctype html>", "utf8");`}
process.stdout.write(${JSON.stringify(options.stdout ?? "guard complete")} + "\\n");
process.stderr.write(${JSON.stringify(options.stderr ?? "")} + (${JSON.stringify(options.stderr ?? "")} ? "\\n" : ""));
process.exit(${options.exitCode ?? 0});
`;
  await writeFile(executable, source, "utf8");
  await chmod(executable, 0o755);
  return executable;
}

function actionEnvironment(root, overrides = {}) {
  return {
    ...process.env,
    GITHUB_OUTPUT: path.join(root, "github-output.txt"),
    GITHUB_STEP_SUMMARY: path.join(root, "github-summary.md"),
    UIWITNESS_INPUT_ANNOTATION_CAP: "10",
    UIWITNESS_INPUT_CONFIG: "",
    UIWITNESS_INPUT_CONTRACT: "",
    UIWITNESS_INPUT_RETENTION_DAYS: "1",
    UIWITNESS_INPUT_UPLOAD_ARTIFACT: "false",
    ...overrides,
  };
}

test("normalizes only the repository release version shape", () => {
  assert.equal(normalizeActionVersion("1.2.3.0\n"), "1.2.3");
  assert.equal(normalizeActionVersion("1.2.3.0\r\n"), "1.2.3");
  for (const value of ["1.2.3", "1.2.3.1\n", "v1.2.3\n", "01.2.3.0\n"]) {
    assert.throws(() => normalizeActionVersion(value), /MAJOR\.MINOR\.PATCH\.0/u);
  }
});

test("validates the five bounded Action inputs", () => {
  assert.deepEqual(parseActionInputs({}), {
    annotationCap: 10,
    config: undefined,
    contract: undefined,
    retentionDays: 1,
    uploadArtifact: false,
  });
  assert.deepEqual(parseActionInputs({
    UIWITNESS_INPUT_ANNOTATION_CAP: "50",
    UIWITNESS_INPUT_CONFIG: "uiwitness.config.mts",
    UIWITNESS_INPUT_CONTRACT: "contracts/main.json",
    UIWITNESS_INPUT_RETENTION_DAYS: "90",
    UIWITNESS_INPUT_UPLOAD_ARTIFACT: "true",
  }), {
    annotationCap: 50,
    config: "uiwitness.config.mts",
    contract: "contracts/main.json",
    retentionDays: 90,
    uploadArtifact: true,
  });
  assert.throws(() => parseActionInputs({ UIWITNESS_INPUT_ANNOTATION_CAP: "51" }), /0 through 50/u);
  assert.throws(() => parseActionInputs({ UIWITNESS_INPUT_RETENTION_DAYS: "0" }), /1 through 90/u);
  assert.throws(() => parseActionInputs({ UIWITNESS_INPUT_UPLOAD_ARTIFACT: "yes" }), /true or false/u);
  assert.throws(() => parseActionInputs({ UIWITNESS_INPUT_CONFIG: "bad\npath" }), /control characters/u);
});

test("caps summaries by exact UTF-8 bytes without splitting a character", () => {
  const exact = "a".repeat(MAXIMUM_SUMMARY_BYTES);
  assert.equal(boundedSummary(exact), exact);
  assert.doesNotMatch(boundedSummary(exact), /Summary truncated/u);
  const oneByteOver = `${exact}b`;
  assert.ok(Buffer.byteLength(boundedSummary(oneByteOver)) <= MAXIMUM_SUMMARY_BYTES);
  assert.match(boundedSummary(oneByteOver), /Summary truncated/u);
  const summary = boundedSummary(`start\n${"😀".repeat(MAXIMUM_SUMMARY_BYTES)}`);
  assert.ok(Buffer.byteLength(summary) <= MAXIMUM_SUMMARY_BYTES);
  assert.match(summary, /Summary truncated/u);
  assert.doesNotMatch(summary, /�/u);
});

test("summarizes canonical totals and deterministically caps annotations", () => {
  const findings = Array.from({ length: 60 }, (_, index) => ({
    actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
    expected: { status: "passed" },
    id: `route-${String(index).padStart(2, "0")}/state/desktop/light`,
    kind: "regression",
  }));
  const parsed = parseMachineVerdict(verdict("failed", findings));
  const summary = buildSummary(parsed);
  assert.match(summary, /60 total · 0 matched · 60 blocking/u);
  assert.match(summary, /40 additional canonical finding\(s\) omitted/u);
  const annotations = annotationCommands(parsed, MAXIMUM_ANNOTATIONS);
  assert.equal(annotations.length, 50);
  assert.match(annotations[0], /route-00/u);
  assert.match(annotations.at(-1), /route-49/u);
});

test("summarizes the first 20 canonical findings, including matches", () => {
  const findings = Array.from({ length: 25 }, (_, index) => ({
    actual: { status: "passed" },
    expected: { status: "passed" },
    id: `route-${String(index).padStart(2, "0")}/state/desktop/light`,
    kind: "matched",
  }));
  const summary = buildSummary(parseMachineVerdict(verdict("passed", findings)));
  assert.match(summary, /route-00/u);
  assert.match(summary, /route-19/u);
  assert.doesNotMatch(summary, /route-20/u);
  assert.match(summary, /5 additional canonical finding\(s\) omitted/u);
});

test("surfaces bounded exception ownership and lifecycle in GitHub output", () => {
  const expected = {
    exception: {
      createdOn: "2026-08-20",
      expiresOn: "2026-09-04",
      owner: "checkout_*team*",
      reason: "UIW-2041 | repair <pending>",
    },
    failureCodes: ["ASSERTION_FAILED"],
    status: "failed",
  };
  const actual = { failureCodes: ["ASSERTION_FAILED"], status: "failed" };
  const parsed = parseMachineVerdict(verdict("failed", [
    {
      actual,
      expected,
      id: "checkout/error/mobile/dark",
      kind: "expired-exception",
    },
    {
      actual,
      expected,
      id: "checkout/error/mobile/dark",
      kind: "matched-known-failure",
    },
  ]));

  const summary = buildSummary(parsed);
  assert.match(summary, /Expected: failed \(ASSERTION\\_FAILED\)/u);
  assert.match(summary, /Actual: failed \(ASSERTION\\_FAILED\)/u);
  assert.match(summary, /Exception: checkout\\_\\\*team\\\* · expired 1 UTC day ago · through 2026-09-04/u);
  assert.match(summary, /Reason: UIW-2041 \\| repair &lt;pending&gt;/u);
  assert.match(summary, /explicitly renew with a new reason/u);
  assert.match(summary, /exact failure-code set still matches, but the exception is expired/u);
  assert.doesNotMatch(summary, /exception applies only/u);
  assert.doesNotMatch(summary, /<pending>/u);

  const [annotation] = annotationCommands(parsed, 1);
  assert.match(annotation, /owner checkout_\*team\*; expired 1 UTC day ago/u);
  assert.doesNotMatch(annotation, /\n/u);
});

test("explains added, removed, substituted, recovered, and ineligible known failures", () => {
  const activeException = {
    createdOn: "2026-09-01",
    expiresOn: "2026-09-10",
    owner: "quality-team",
    reason: "UIW-2041 tracks repair",
  };
  const failed = (failureCodes) => ({
    exception: activeException,
    failureCodes,
    status: "failed",
  });
  const parsed = parseMachineVerdict(verdict("failed", [
    {
      actual: { failureCodes: ["ASSERTION_FAILED", "PAGE_ERROR"], status: "failed" },
      expected: failed(["ASSERTION_FAILED"]),
      id: "added/error/mobile/dark",
      kind: "changed-known-failure",
    },
    {
      actual: { failureCodes: ["NAVIGATION_FAILED"], status: "failed" },
      expected: failed(["ASSERTION_FAILED"]),
      id: "ineligible/error/mobile/dark",
      kind: "changed-known-failure",
    },
    {
      actual: { status: "passed" },
      expected: failed(["ASSERTION_FAILED"]),
      id: "recovered/error/mobile/dark",
      kind: "recovered-known-failure",
    },
    {
      actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
      expected: failed(["ASSERTION_FAILED", "PAGE_ERROR"]),
      id: "removed/error/mobile/dark",
      kind: "changed-known-failure",
    },
    {
      actual: { failureCodes: ["PAGE_ERROR"], status: "failed" },
      expected: failed(["ASSERTION_FAILED"]),
      id: "substituted/error/mobile/dark",
      kind: "changed-known-failure",
    },
  ]));

  const summary = buildSummary(parsed);
  assert.match(summary, /Expected: failed \(ASSERTION\\_FAILED\)/u);
  assert.match(summary, /Actual: failed \(ASSERTION\\_FAILED, PAGE\\_ERROR\)/u);
  assert.match(summary, /Expected: failed \(ASSERTION\\_FAILED, PAGE\\_ERROR\)/u);
  assert.match(summary, /Actual: failed \(PAGE\\_ERROR\)/u);
  assert.match(summary, /Actual: passed/u);
  assert.match(summary, /review and annotate a new expectation/u);
  assert.match(summary, /cannot become a known failure/u);
  assert.match(summary, /accept the expectation change to remove contract debt/u);
});

test("keeps exception metadata nested beneath two-digit ordered items", () => {
  const expected = {
    exception: {
      createdOn: "2026-09-01",
      expiresOn: "2026-09-10",
      owner: "quality-team",
      reason: "Tracked repair",
    },
    failureCodes: ["ASSERTION_FAILED"],
    status: "failed",
  };
  const findings = [
    ...Array.from({ length: 9 }, (_, index) => ({
      actual: { status: "passed" },
      expected: { status: "passed" },
      id: `route-${String(index).padStart(2, "0")}/state/desktop/light`,
      kind: "matched",
    })),
    {
      actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
      expected,
      id: "route-10/state/desktop/light",
      kind: "matched-known-failure",
    },
  ];
  const summary = buildSummary(parseMachineVerdict(verdict("passed", findings)));
  assert.match(summary, /10\. route-10\/state\/desktop\/light[^\n]*\n {4}- Expected:/u);
  assert.match(summary, /\n {4}- Exception: quality-team/u);
});

test("renders legacy default-ignorable governance text visibly", () => {
  const expected = {
    exception: {
      createdOn: "2026-09-01",
      expiresOn: "2026-09-10",
      owner: "quality\u202Eteam",
      reason: "UIW-2041\u034F tracks\u0007 repair",
    },
    failureCodes: ["ASSERTION_FAILED"],
    status: "failed",
  };
  const parsed = parseMachineVerdict(verdict("passed", [{
    actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
    expected,
    id: "route/state/desktop/light",
    kind: "matched-known-failure",
  }]));
  assert.equal(parsed.findings[0].expected.exception.owner, "quality\\u{202e}team");
  assert.equal(parsed.findings[0].expected.exception.reason, "UIW-2041\\u{034f} tracks\\u{0007} repair");
  const summary = buildSummary(parsed);
  assert.doesNotMatch(summary, /\u202E|\u034F/u);
  assert.match(summary, /quality\\\\u\\\{202e\\\}team/u);
});

test("escapes Markdown and HTML-like finding detail", () => {
  const summary = buildSummary({
    contractDigest: digest,
    findings: [{
      actual: { failureCodes: ["ASSERTION_*_[x]`y`|<img>\\"], status: "failed" },
      expected: { status: "passed" },
      id: "route/*x*_[y]`z`|<img>/desktop/light",
      kind: "regression",
    }],
    verdict: "failed",
  });
  assert.match(summary, /\\\*x\\\*\\_\\\[y\\\]\\`z\\`\\\|&lt;img&gt;/u);
  assert.match(summary, /ASSERTION\\_\\\*\\_\\\[x\\\]\\`y\\`\\\|&lt;img&gt;\\\\/u);
  assert.doesNotMatch(summary, /<img>/u);
});

test("escapes hostile annotation text as workflow data", () => {
  const parsed = {
    contractDigest: digest,
    findings: [{
      actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
      expected: { status: "passed" },
      id: "route/state/desktop/light::warning::owned",
      kind: "regression",
    }],
    verdict: "failed",
  };
  const [annotation] = annotationCommands(parsed, 1);
  assert.doesNotMatch(annotation, /\n/u);
  assert.match(annotation, /%3A%3Awarning%3A%3Aowned/u);
});

test("runs the exact project-local CLI and preserves a passing verdict", async () => {
  const root = await temporaryProject();
  await installFakeCli(root);
  const environment = actionEnvironment(root, {
    SECRET_SENTINEL: "fork-secret-must-not-appear",
    UIWITNESS_INPUT_CONFIG: "config with spaces.mts",
    UIWITNESS_INPUT_CONTRACT: "contract.json",
  });
  const logs = [];
  assert.equal(await runAction({
    actionRoot: repositoryRoot,
    cwd: root,
    environment,
    writeLog: (value) => logs.push(value),
  }), 0);
  const args = JSON.parse(await readFile(path.join(root, "guard-args.json"), "utf8"));
  assert.deepEqual(args.slice(0, 5), ["guard", "--config", "config with spaces.mts", "--contract", "contract.json"]);
  assert.equal(args[5], "--json");
  assert.match(args[6], /^\.uiwitness\/action-verdicts\/[0-9a-f-]+\.json$/u);
  const output = await readFile(environment.GITHUB_OUTPUT, "utf8");
  const summary = await readFile(environment.GITHUB_STEP_SUMMARY, "utf8");
  assert.match(output, /verdict=passed/u);
  assert.match(output, /exit-class=success/u);
  assert.match(output, /matched-count=1/u);
  assert.match(summary, /PASSED/u);
  assert.doesNotMatch(`${logs.join("")}\n${output}\n${summary}`, /fork-secret-must-not-appear/u);
});

test("passes malicious-looking paths as inert argv and neutralizes workflow commands", async () => {
  const root = await temporaryProject();
  const marker = path.join(root, "shell-injection-marker");
  const malicious = `$(touch ${marker})`;
  await installFakeCli(root, { stdout: "::error::not-a-workflow-command\n##[add-mask]not-a-secret" });
  const environment = actionEnvironment(root, { UIWITNESS_INPUT_CONFIG: malicious });
  const logs = [];
  assert.equal(await runAction({ actionRoot: repositoryRoot, cwd: root, environment, writeLog: (value) => logs.push(value) }), 0);
  const args = JSON.parse(await readFile(path.join(root, "guard-args.json"), "utf8"));
  assert.deepEqual(args.slice(0, 3), ["guard", "--config", malicious]);
  assert.equal(args[3], "--json");
  assert.match(args[4], /^\.uiwitness\/action-verdicts\/[0-9a-f-]+\.json$/u);
  await assert.rejects(readFile(marker), /ENOENT/u);
  assert.match(logs.join(""), /^\[uiwitness\] :%3Aerror:%3Anot-a-workflow-command/mu);
  assert.match(logs.join(""), /^\[uiwitness\] ##%5Badd-mask\]not-a-secret/mu);
  assert.doesNotMatch(logs.join(""), /::error|##\[add-mask\]/u);
});

test("rejects Action and CLI version mismatch before guard execution", async () => {
  const root = await temporaryProject();
  await installFakeCli(root, { guardMarker: "guard-called", version: "9.9.9" });
  const environment = actionEnvironment(root);
  const logs = [];
  assert.equal(await runAction({ actionRoot: repositoryRoot, cwd: root, environment, writeLog: (value) => logs.push(value) }), 2);
  await assert.rejects(readFile(path.join(root, "guard-called")), /ENOENT/u);
  assert.match(logs.join(""), new RegExp(`requires project-local uiwitness@${currentVersion.replaceAll(".", "\\.")}`, "u"));
  assert.match(logs.join(""), new RegExp(`npm install --save-dev --save-exact uiwitness@${currentVersion.replaceAll(".", "\\.")}`, "u"));
  assert.match(await readFile(environment.GITHUB_OUTPUT, "utf8"), /exit-class=setup-error/u);
});

test("rejects a missing project-local CLI without an install fallback", async () => {
  const root = await temporaryProject();
  const environment = actionEnvironment(root);
  const logs = [];
  assert.equal(await runAction({ actionRoot: repositoryRoot, cwd: root, environment, writeLog: (value) => logs.push(value) }), 2);
  assert.match(logs.join(""), /Project-local UIWitness CLI not found/u);
  assert.match(logs.join(""), new RegExp(`npm install --save-dev --save-exact uiwitness@${currentVersion.replaceAll(".", "\\.")}`, "u"));
  assert.match(await readFile(environment.GITHUB_OUTPUT, "utf8"), /exit-class=setup-error/u);
});

test("requires an invocation-exclusive verdict instead of accepting stale evidence", async () => {
  const root = await temporaryProject();
  await mkdir(path.join(root, ".uiwitness"), { recursive: true });
  await writeFile(path.join(root, ".uiwitness", "contract-verdict.json"), `${JSON.stringify(verdict())}\n`, "utf8");
  await installFakeCli(root, { writeVerdict: false });
  const environment = actionEnvironment(root);
  assert.equal(await runAction({ actionRoot: repositoryRoot, cwd: root, environment, writeLog: () => {} }), 2);
  const output = await readFile(environment.GITHUB_OUTPUT, "utf8");
  assert.match(output, /verdict=error/u);
  assert.match(output, /exit-class=setup-error/u);
  assert.match(output, /finding-count=0/u);
});

test("fails closed when the CLI exit and fresh machine verdict disagree", async () => {
  const root = await temporaryProject();
  await installFakeCli(root, { exitCode: 1, verdict: verdict("passed") });
  const environment = actionEnvironment(root);
  const logs = [];
  assert.equal(await runAction({ actionRoot: repositoryRoot, cwd: root, environment, writeLog: (value) => logs.push(value) }), 2);
  assert.match(logs.join(""), /exit code disagrees with its machine verdict/u);
  const output = await readFile(environment.GITHUB_OUTPUT, "utf8");
  assert.match(output, /verdict=error/u);
  assert.match(output, /exit-class=setup-error/u);
  assert.match(output, /contract-digest=\n/u);
  assert.match(output, /report-path=\n/u);
  assert.match(output, /finding-count=0/u);
  assert.match(output, /matched-count=0/u);
  assert.match(output, /blocking-count=0/u);
});

test("fails closed when a declared pass contains a blocking finding", async () => {
  const root = await temporaryProject();
  await installFakeCli(root, { verdict: verdict("passed", [{
    actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
    expected: { status: "passed" },
    id: "route/state/desktop/light",
    kind: "regression",
  }]) });
  const environment = actionEnvironment(root);
  const logs = [];
  assert.equal(await runAction({ actionRoot: repositoryRoot, cwd: root, environment, writeLog: (value) => logs.push(value) }), 2);
  assert.match(logs.join(""), /status disagrees with its findings and completeness/u);
  assert.match(await readFile(environment.GITHUB_OUTPUT, "utf8"), /exit-class=setup-error/u);
});

test("rejects schema-invalid findings even when their kind would pass", async () => {
  const invalidVerdicts = [
    verdict("passed", [{
      actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
      expected: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
      id: "route/state/desktop/light",
      kind: "matched-known-failure",
    }]),
    verdict("passed", [{
      actual: { failureCodes: ["ASSERTION_FAILED"], status: "passed" },
      expected: { status: "passed" },
      id: "route/state/desktop/light",
      kind: "matched",
    }]),
    verdict("passed", [{
      actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
      expected: {
        exception: { createdOn: "2026-09-01", expiresOn: "2026-09-10", owner: "   ", reason: "tracked" },
        failureCodes: ["ASSERTION_FAILED"],
        status: "failed",
      },
      id: "route/state/desktop/light",
      kind: "matched-known-failure",
    }]),
  ];
  for (const invalidVerdict of invalidVerdicts) {
    const root = await temporaryProject();
    await installFakeCli(root, { verdict: invalidVerdict });
    const environment = actionEnvironment(root);
    assert.equal(await runAction({ actionRoot: repositoryRoot, cwd: root, environment, writeLog: () => {} }), 2);
    assert.match(await readFile(environment.GITHUB_OUTPUT, "utf8"), /exit-class=setup-error/u);
  }
});

test("accepts canonical generated commands above the general text limit", () => {
  const id = `${"a".repeat(1_000)}/s/v/t`;
  assert.doesNotThrow(() => parseMachineVerdict(verdict("failed", [{
    actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
    expected: { status: "passed" },
    id,
    kind: "regression",
  }])));
});

test("accepts every legitimate machine finding shape", async () => {
  const activeExpectation = {
    exception: { createdOn: "2026-09-01", expiresOn: "2026-09-10", owner: "team\nplatform", reason: "tracked\tprivately" },
    failureCodes: ["ASSERTION_FAILED"],
    status: "failed",
  };
  const expiredExpectation = {
    exception: { createdOn: "2026-08-15", expiresOn: "2026-09-04", owner: "team", reason: "tracked" },
    failureCodes: ["ASSERTION_FAILED"],
    status: "failed",
  };
  const failedActual = { failureCodes: ["ASSERTION_FAILED"], status: "failed" };
  const changedActual = { failureCodes: ["CONSOLE_ERROR"], status: "failed" };
  const secondDigest = `sha256:${"1".repeat(64)}`;
  const findings = [
    { actual: { status: "passed" }, currentConfigFingerprint: digest, expected: null, id: "a/s/v/t", kind: "unaccepted-addition" },
    { actual: null, contractConfigFingerprint: digest, expected: { status: "passed" }, id: "b/s/v/t", kind: "missing-coordinate" },
    { actual: { status: "passed" }, contractConfigFingerprint: digest, currentConfigFingerprint: secondDigest, expected: { status: "passed" }, id: "c/s/v/t", kind: "unaccepted-config-drift" },
    { actual: failedActual, contractConfigFingerprint: digest, currentConfigFingerprint: secondDigest, expected: expiredExpectation, id: "d/s/v/t", kind: "unaccepted-config-drift" },
    { actual: failedActual, expected: expiredExpectation, id: "d/s/v/t", kind: "expired-exception" },
    { actual: changedActual, expected: expiredExpectation, id: "e/s/v/t", kind: "expired-exception" },
    { actual: changedActual, expected: expiredExpectation, id: "e/s/v/t", kind: "changed-known-failure" },
    { actual: { failureCodes: ["CONSOLE_ERROR"], status: "failed" }, expected: { status: "passed" }, id: "f/s/v/t", kind: "regression" },
    { actual: { status: "passed" }, expected: activeExpectation, id: "g/s/v/t", kind: "recovered-known-failure" },
    { actual: failedActual, expected: activeExpectation, id: "h/s/v/t", kind: "matched-known-failure" },
    { actual: { status: "passed" }, expected: { status: "passed" }, id: "i/s/v/t", kind: "matched" },
  ];
  assert.doesNotThrow(() => parseMachineVerdict(verdict("failed", findings)));
  assert.doesNotThrow(() => parseMachineVerdict({
    ...verdict(),
    complete: false,
    findings: [{ id: null, kind: "run-error", reasons: ["declared-incomplete"] }],
    verdict: "error",
  }));

  const root = await temporaryProject();
  await installFakeCli(root, { verdict: verdict("passed", [findings.at(-2)]) });
  const environment = actionEnvironment(root);
  assert.equal(await runAction({ actionRoot: repositoryRoot, cwd: root, environment, writeLog: () => {} }), 0);
  assert.match(await readFile(environment.GITHUB_OUTPUT, "utf8"), /matched-count=1/u);
});

test("rejects impossible or expiry-incomplete passing coordinate groups", () => {
  const expectation = {
    exception: { createdOn: "2026-09-01", expiresOn: "2026-09-10", owner: "team", reason: "tracked" },
    failureCodes: ["ASSERTION_FAILED"],
    status: "failed",
  };
  const known = { actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" }, expected: expectation, id: "a/s/v/t", kind: "matched-known-failure" };
  const matched = { actual: { status: "passed" }, expected: { status: "passed" }, id: "a/s/v/t", kind: "matched" };
  assert.throws(() => parseMachineVerdict(verdict("passed", [known, matched])), /impossible coordinate finding combination/u);
  const expired = {
    ...known,
    expected: { ...expectation, exception: { ...expectation.exception, expiresOn: "2026-09-02" } },
  };
  assert.throws(() => parseMachineVerdict(verdict("passed", [expired])), /exception expiry disagrees/u);
});

test("preserves contract failure and setup error classifications", async () => {
  const failedRoot = await temporaryProject();
  await installFakeCli(failedRoot, { exitCode: 1 });
  const failedEnvironment = actionEnvironment(failedRoot);
  assert.equal(await runAction({ actionRoot: repositoryRoot, cwd: failedRoot, environment: failedEnvironment, writeLog: () => {} }), 1);
  assert.match(await readFile(failedEnvironment.GITHUB_OUTPUT, "utf8"), /exit-class=contract-failure/u);

  const errorRoot = await temporaryProject();
  await installFakeCli(errorRoot, { exitCode: 2, writeVerdict: false });
  const errorEnvironment = actionEnvironment(errorRoot);
  assert.equal(await runAction({ actionRoot: repositoryRoot, cwd: errorRoot, environment: errorEnvironment, writeLog: () => {} }), 2);
  assert.match(await readFile(errorEnvironment.GITHUB_OUTPUT, "utf8"), /exit-class=setup-error/u);
  assert.equal(finalizeAction("0"), 0);
  assert.equal(finalizeAction("1"), 1);
  assert.equal(finalizeAction("2"), 1);
  assert.equal(finalizeAction(undefined), 1);
});

test("summary write failure never changes the authoritative CLI result", async () => {
  for (const exitCode of [0, 1]) {
    const root = await temporaryProject();
    await installFakeCli(root, { exitCode });
    const environment = actionEnvironment(root, { GITHUB_STEP_SUMMARY: root });
    const logs = [];
    assert.equal(
      await runAction({ actionRoot: repositoryRoot, cwd: root, environment, writeLog: (value) => logs.push(value) }),
      exitCode,
    );
    assert.match(
      await readFile(environment.GITHUB_OUTPUT, "utf8"),
      new RegExp(`exit-class=${exitCode === 0 ? "success" : "contract-failure"}`, "u"),
    );
    assert.equal(logs.filter((entry) => entry.includes("Could not write the bounded GitHub step summary")).length, 1);
  }
});

test("wires the default and explicit annotation caps through the Action", async () => {
  const findings = Array.from({ length: 20 }, (_, index) => ({
    actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
    expected: { status: "passed" },
    id: `route-${String(index).padStart(2, "0")}/state/desktop/light`,
    kind: "regression",
  }));
  for (const [configuredCap, expectedCount] of [[undefined, 10], ["0", 0], ["50", 20]]) {
    const root = await temporaryProject();
    await installFakeCli(root, { exitCode: 1, verdict: verdict("failed", findings) });
    const environment = actionEnvironment(root, configuredCap === undefined ? {} : {
      UIWITNESS_INPUT_ANNOTATION_CAP: configuredCap,
    });
    const logs = [];
    assert.equal(await runAction({ actionRoot: repositoryRoot, cwd: root, environment, writeLog: (value) => logs.push(value) }), 1);
    assert.equal(logs.filter((entry) => entry.startsWith("::error title=UIWitness regression::")).length, expectedCount);
  }
});

test("fails closed on missing or malformed verdict sidecars", async () => {
  const cases = [
    { label: "missing", options: { writeVerdict: false } },
    { label: "invalid JSON", options: { rawVerdict: "{" } },
    { label: "wrong schema", options: { verdict: { ...verdict(), schemaVersion: 2 } } },
    { label: "wrong digest", options: { verdict: { ...verdict(), contractDigest: "sha256:nope" } } },
    { label: "wrong kind", options: { verdict: verdict("passed", [{ actual: { status: "passed" }, expected: { status: "passed" }, id: "route/state/desktop/light", kind: "invented" }]) } },
  ];
  for (const exitCode of [0, 1]) {
    for (const fixture of cases) {
      const root = await temporaryProject();
      await installFakeCli(root, { exitCode, ...fixture.options });
      const environment = actionEnvironment(root);
      const logs = [];
      assert.equal(
        await runAction({ actionRoot: repositoryRoot, cwd: root, environment, writeLog: (value) => logs.push(value) }),
        2,
        `${fixture.label} sidecar after CLI exit ${exitCode}`,
      );
      const output = await readFile(environment.GITHUB_OUTPUT, "utf8");
      assert.match(output, /verdict=error/u);
      assert.match(output, /exit-class=setup-error/u);
      assert.match(output, /finding-count=0/u);
      assert.equal(logs.filter((entry) => entry.startsWith("::error title=UIWitness regression::")).length, 0);
    }
  }
});

test("the composite Action is thin, immutable, upload-off, and argv-safe", async () => {
  const source = await readFile(path.join(repositoryRoot, "action.yml"), "utf8");
  assert.match(source, /using: composite/u);
  assert.match(source, /upload-artifact:\n {4}description: [^\n]+\n {4}required: false\n {4}default: "false"/u);
  assert.match(source, /retention-days:\n {4}description: [^\n]+\n {4}required: false\n {4}default: "1"/u);
  assert.match(source, /annotation-cap:\n {4}description: [^\n]+\n {4}required: false\n {4}default: "10"/u);
  assert.match(source, /- name: Run project-local UIWitness guard\n {6}id: guard\n {6}continue-on-error: true/u);
  assert.match(source, /- name: Upload UIWitness evidence\n {6}if: \$\{\{ always\(\) && inputs\.upload-artifact == 'true' \}\}\n {6}uses: actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/u);
  assert.match(source, /if-no-files-found: error\n {8}retention-days: \$\{\{ inputs\.retention-days \}\}/u);
  assert.match(source, /- name: Preserve UIWitness exit semantics\n {6}if: \$\{\{ always\(\) \}\}[\s\S]+UIWITNESS_GUARD_EXIT_CODE: \$\{\{ steps\.guard\.outputs\.exit-code \}\}/u);
  assert.match(source, /UIWITNESS_INPUT_CONFIG: \$\{\{ inputs\.config \}\}/u);
  assert.match(source, /run: node "\$GITHUB_ACTION_PATH\/\.github\/actions\/uiwitness-guard\/index\.mjs" run/u);
  assert.doesNotMatch(source, /npx|npm install|pull_request_target|workflow_run/u);
  assert.equal((source.match(/^ {2}[a-z][a-z-]+:\n {4}description:/gmu) ?? []).filter((entry) => [
    "  config:\n    description:",
    "  contract:\n    description:",
    "  upload-artifact:\n    description:",
    "  retention-days:\n    description:",
    "  annotation-cap:\n    description:",
  ].includes(entry)).length, 5);
});

test("the sharded workflow example transfers immutable bundles and merges exactly once", async () => {
  const source = await readFile(
    path.join(repositoryRoot, "docs", "open-source", "examples", "uiwitness-sharded.yml"),
    "utf8",
  );
  assert.match(source, /^permissions:\n {2}contents: read$/mu);
  assert.match(source, /fail-fast: false\n {6}matrix:\n {8}shard: \[1, 2, 3, 4\]/u);
  assert.match(source, /uiwitness guard shard-plan --shards 4 --out uiwitness-shard-plan\.json --ttl 60m/u);
  assert.match(source, /uiwitness guard --shard "\$SHARD_INDEX\/4" --shard-plan uiwitness-shard-plan\.json/u);
  assert.match(source, /args\+=\(--input "\$bundle"\)/u);
  assert.match(source, /uiwitness guard merge "\$\{args\[@\]\}"/u);
  assert.equal((source.match(/actions\/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a/g) ?? []).length, 2);
  assert.equal((source.match(/actions\/download-artifact@3e5f45b2cfb9172054b4087a40e8e0b5a5461e7c/g) ?? []).length, 2);
  assert.equal((source.match(/retention-days: 1/g) ?? []).length, 2);
  assert.doesNotMatch(source, /pull_request_target|workflow_run|continue-on-error|secrets\./u);
});
