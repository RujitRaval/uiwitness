import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

const root = path.resolve(import.meta.dirname, "..");
const templateRoot = path.join(root, ".github", "ISSUE_TEMPLATE");
const safetyBoundary = "Test only software you own or are authorized to assess. UIWitness keeps evidence local by default, but screenshots, URLs, and diagnostics may contain sensitive data; review them before sharing or uploading.";

async function source(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

function issueFormTypes(contents) {
  return [...contents.matchAll(/^ {2}- type: ([a-z-]+)$/gmu)].map((match) => match[1]);
}

function issueFormIds(contents) {
  return [...contents.matchAll(/^ {4}id: ([a-z_]+)$/gmu)].map((match) => match[1]);
}

test("GitHub exposes exactly the three reviewed public issue forms", async () => {
  const entries = (await readdir(templateRoot)).filter((entry) => entry.endsWith(".yml")).sort();
  assert.deepEqual(entries, [
    "bug_report.yml",
    "config.yml",
    "customer_pilot_feedback.yml",
    "feature_evidence.yml",
  ]);

  const expectations = new Map([
    ["bug_report.yml", ["version", "command", "environment", "reproduction", "expected", "actual", "safety"]],
    ["customer_pilot_feedback.yml", ["version", "workflow", "context", "job", "outcome", "evidence", "next_step", "safety"]],
    ["feature_evidence.yml", ["observed_problem", "affected_users", "current_workaround", "evidence", "outcome", "boundaries", "fit"]],
  ]);

  for (const [filename, expectedIds] of expectations) {
    const contents = await readFile(path.join(templateRoot, filename), "utf8");
    assert.match(contents, /^name: .+\ndescription: .+\ntitle: ".+"\nlabels:\n {2}- (bug|question|enhancement)\nbody:\n/u, filename);
    assert.ok(issueFormTypes(contents).length > 1, filename);
    assert.ok(issueFormTypes(contents).every((type) => ["markdown", "input", "dropdown", "textarea", "checkboxes"].includes(type)), filename);
    assert.deepEqual(issueFormIds(contents), expectedIds, filename);
    assert.equal(new Set(issueFormIds(contents)).size, expectedIds.length, filename);
    // Every form has one checkbox group whose options, rather than the group,
    // carry their own required flags.
    assert.equal((contents.match(/^ {6}required: true$/gmu) ?? []).length, expectedIds.length - 1, filename);
    assert.ok((contents.match(/^ {10}required: true$/gmu) ?? []).length >= 3, filename);
    assert.match(contents, /own(?:ed)? or (?:am|was) authorized to test/u, filename);
    assert.match(contents, /customer|customer-identifying/u, filename);
    assert.match(contents, /credentials/u, filename);
    assert.match(contents, /private URLs/u, filename);
  }
});

test("issue routing keeps one public support queue and private security reporting", async () => {
  const config = await source(".github/ISSUE_TEMPLATE/config.yml");
  const support = await source("SUPPORT.md");
  assert.match(config, /^blank_issues_enabled: false$/mu);
  assert.match(config, /security\/advisories\/new/u);
  assert.doesNotMatch(config, /discussions/u);
  assert.match(support, /GitHub Issues is UIWitness's single public support and feedback path/u);
  assert.match(support, /GitHub Discussions is intentionally disabled/u);
  assert.match(support, /private vulnerability reporting/u);
});

test("every checked-in launch post carries the exact safety boundary", async () => {
  const launchPosts = await source("docs/open-source/LAUNCH_POSTS.md");
  const posts = launchPosts.split(/^## /mu).slice(1);
  assert.equal(posts.length, 3);
  for (const post of posts) {
    assert.ok(post.includes(safetyBoundary), post.split("\n", 1)[0]);
  }
});
