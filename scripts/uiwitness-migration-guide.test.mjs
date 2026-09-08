import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const guidePath = path.join(root, "docs", "open-source", "MIGRATING_TO_UIWITNESS.md");

const packageMappings = [
  ["statecraft-ui", "uiwitness"],
  ["statecraft-ui-core", "uiwitness-core"],
  ["statecraft-ui-report", "uiwitness-report"],
  ["statecraft-ui-runner-playwright", "uiwitness-runner-playwright"],
];

const deprecationMessages = packageMappings.map(
  ([legacyName, currentName]) =>
    `${legacyName} has moved to ${currentName}. Install ${currentName} and migrate with https://github.com/RujitRaval/uiwitness/blob/main/docs/open-source/MIGRATING_TO_UIWITNESS.md`,
);

test("migration guide maps every published package and exact deprecation message", async () => {
  const guide = await readFile(guidePath, "utf8");
  const packageDirectories = ["cli", "core", "report", "runner-playwright"];
  const publishedNames = await Promise.all(
    packageDirectories.map(async (directory) => {
      const manifest = JSON.parse(
        await readFile(path.join(root, "packages", directory, "package.json"), "utf8"),
      );
      return manifest.name;
    }),
  );

  assert.deepEqual(new Set(publishedNames), new Set(packageMappings.map(([, name]) => name)));
  for (const [legacyName, currentName] of packageMappings) {
    assert.ok(guide.includes(`| \`${legacyName}\` | \`${currentName}\` |`));
  }
  for (const message of deprecationMessages) assert.ok(guide.includes(`- \`${message}\``));
});

test("migration guide documents copy-paste commands and the no-touch evidence policy", async () => {
  const guide = await readFile(guidePath, "utf8");

  for (const command of [
    "npm uninstall statecraft-ui",
    "npm install --save-dev --save-exact uiwitness@0.26.13 playwright@1.62.1",
    "test ! -e uiwitness.config.mts",
    "test ! -e uiwitness",
    "mv statecraft.config.mts uiwitness.config.mts",
    "mv statecraft uiwitness",
    "npx uiwitness --help",
    "npx uiwitness scan",
    "npx uiwitness open",
  ]) {
    assert.ok(guide.includes(command), `Migration guide is missing command: ${command}`);
  }
  assert.match(guide, /does not rename, copy, upload, or delete existing `\.statecraft\/` evidence/u);
  assert.match(guide, /New runs write only to `\.uiwitness\/`/u);
  assert.match(guide, /No compatibility bridge or support-end date applies/u);
});

test("example package scripts and the root asset command use UIWitness", async () => {
  const [workspaceManifest, exampleManifest] = await Promise.all(
    ["package.json", path.join("apps", "example-nextjs", "package.json")].map(
      async (manifestPath) =>
        JSON.parse(await readFile(path.join(root, manifestPath), "utf8")),
    ),
  );

  assert.equal(exampleManifest.name, "@uiwitness/example-nextjs");
  assert.equal(
    workspaceManifest.scripts["launch:assets"],
    "corepack pnpm --filter @uiwitness/example-nextjs launch:assets",
  );
  assert.equal(
    exampleManifest.scripts["preuiwitness:scan"],
    "corepack pnpm --filter uiwitness... build",
  );
  assert.equal(
    exampleManifest.scripts["uiwitness:scan"],
    "node ../../packages/cli/dist/bin.js scan",
  );
  assert.equal(exampleManifest.scripts["prestatecraft:scan"], undefined);
  assert.equal(exampleManifest.scripts["statecraft:scan"], undefined);
});
