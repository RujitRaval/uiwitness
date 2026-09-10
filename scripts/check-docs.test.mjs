import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { checkDocs } from "./check-docs.mjs";

async function makeFixture() {
  return mkdtemp(path.join(tmpdir(), "uiwitness-docs-"));
}

async function write(root, relativePath, contents) {
  const target = path.join(root, relativePath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, contents);
}

test("accepts inline, reference, balanced-parenthesis, and angle-bracket links", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, "README.md", [
    "# Fixture",
    "",
    "[plain](docs/plain.md)",
    "[space](<docs/My Guide.md>)",
    "[balanced](docs/guide_(draft).md)",
    "[reference][guide]",
    "",
    "[guide]: docs/plain.md",
    "",
  ].join("\n"));
  await write(root, "docs/plain.md", "# Plain\n");
  await write(root, "docs/My Guide.md", "# Space\n");
  await write(root, "docs/guide_(draft).md", "# Balanced\n");

  const result = await checkDocs({ root, requiredFiles: ["README.md"] });
  assert.deepEqual(result.errors, []);
});

test("reports broken links, undefined references, malformed documents, and URL encoding", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, "README.md", [
    "Not a heading ",
    "[broken](missing.md)",
    "[unknown][reference]",
    "[encoded](bad%ZZ.md)",
  ].join("\n"));

  const result = await checkDocs({ root, requiredFiles: ["README.md", "MISSING.md"] });
  assert.ok(result.errors.some((error) => error.includes("required documentation file is missing")));
  assert.ok(result.errors.some((error) => error.includes("level-one heading")));
  assert.ok(result.errors.some((error) => error.includes("trailing whitespace")));
  assert.ok(result.errors.some((error) => error.includes("broken link to missing.md")));
  assert.ok(result.errors.some((error) => error.includes("undefined link reference reference")));
  assert.ok(result.errors.some((error) => error.includes("invalid URL encoding")));
});

test("ignores generated and dependency directories", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, "README.md", "# Fixture\n");
  await write(root, "node_modules/package/BROKEN.md", "broken");
  await write(root, ".gstack/qa-reports/BROKEN.md", "broken");
  await write(root, ".statecraft/BROKEN.md", "broken");
  await write(root, ".uiwitness/BROKEN.md", "broken");

  const result = await checkDocs({ root, requiredFiles: ["README.md"] });
  assert.equal(result.filesChecked, 1);
  assert.deepEqual(result.errors, []);
});

test("ignores link-shaped examples inside inline and fenced code", async (t) => {
  const root = await makeFixture();
  t.after(() => rm(root, { recursive: true, force: true }));
  await write(root, "README.md", [
    "# Fixture",
    "",
    "Use `[example](missing-inline.md)` in documentation.",
    "",
    "```markdown",
    "[example](missing-fenced.md)",
    "[example][missing-reference]",
    "```",
    "",
  ].join("\n"));

  const result = await checkDocs({ root, requiredFiles: ["README.md"] });
  assert.deepEqual(result.errors, []);
});
