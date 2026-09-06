import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

async function read(relativePath) {
  return readFile(path.join(root, relativePath), "utf8");
}

test("State Contract Guard guide uses the shipped executable grammar", async () => {
  const [command, guide] = await Promise.all([
    read("packages/cli/src/command.ts"),
    read("docs/open-source/STATE_CONTRACT_GUARD.md"),
  ]);
  const exactForms = [
    "uiwitness guard shard-plan --shards <M> --out <path>",
    "uiwitness guard --shard <N/M> --shard-plan <path>",
    "uiwitness guard merge --input <shard-bundle>...",
    "uiwitness contract init [--config <path>] [--contract <path>]",
    "uiwitness contract inspect --candidate <path> --change <id>",
    "uiwitness contract annotate --candidate <path> --change <id>",
    "uiwitness contract accept --candidate <path> --change <id>...",
  ];

  for (const form of exactForms) {
    assert.match(command, new RegExp(form.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
    assert.match(guide, new RegExp(form.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }
});

test("State Contract Guard documentation preserves safety and roadmap boundaries", async () => {
  const [guide, architecture, roadmap] = await Promise.all([
    read("docs/open-source/STATE_CONTRACT_GUARD.md"),
    read("docs/architecture/STATE_CONTRACT_GUARD.md"),
    read("docs/designs/uiwitness-state-contract-guard.md"),
  ]);

  for (const phrase of [
    "Default `all` reports retain schema v1 compatibility",
    "Authentication is optional and unsharded",
    "evidence upload off by default",
    "full 40-character release commit SHA",
    "Release-artifact and registry proof are intentionally handled by the separate T14 release slice",
  ]) {
    assert.match(guide, new RegExp(phrase.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&"), "u"));
  }

  for (const heading of [
    "## System architecture",
    "## Data and shadow paths",
    "## Generation and proposal state machine",
    "## Shard state machine",
    "## Error flow",
    "## CI deployment sequence",
    "## Publication rollback flow",
    "## Report information architecture",
  ]) {
    assert.match(architecture, new RegExp(heading, "u"));
  }

  assert.match(roadmap, /- \[x\] \*\*T13/u);
  assert.match(roadmap, /- \[ \] \*\*T14/u);
});
