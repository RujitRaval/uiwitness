import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createPublicationPlan,
  packageIntegrity,
  publishReleasePackages,
} from "./publish-release-packages.mjs";
import {
  assertPackedBrandContract,
  assertPublishSummaryIdentity,
  releaseTarballName,
  resolveActionSha,
  runCommand,
} from "./release-package-smoke.mjs";
import { RELEASE_PACKAGES, validateReleaseWorkspace } from "./check-release-packages.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const checkedInRelease = await validateReleaseWorkspace({ root: repositoryRoot });

async function createTarballFixture(context) {
  const input = await mkdtemp(path.join(os.tmpdir(), "uiwitness-publish-test-"));
  context.after(() => rm(input, { force: true, recursive: true }));
  const integrities = new Map();
  for (const contract of RELEASE_PACKAGES) {
    const tarball = path.join(
      input,
      releaseTarballName(contract.name, checkedInRelease.packageVersion),
    );
    const value = Buffer.from(`tarball:${contract.name}`);
    integrities.set(contract.name, packageIntegrity(value));
    await writeFile(tarball, value);
  }
  return { input, integrities };
}

function packageNameFromViewTarget(target) {
  const suffix = `@${checkedInRelease.packageVersion}`;
  assert.equal(target.endsWith(suffix), true);
  return target.slice(0, -suffix.length);
}

function packageNameFromTarball(tarball) {
  return RELEASE_PACKAGES.find(
    ({ name }) => path.basename(tarball) === releaseTarballName(name, checkedInRelease.packageVersion),
  )?.name;
}

test("derives stable npm tarball names", () => {
  assert.equal(releaseTarballName("uiwitness", "1.2.3"), "uiwitness-1.2.3.tgz");
  assert.equal(releaseTarballName("@example/tool", "1.2.3"), "example-tool-1.2.3.tgz");
});

test("validates npm publish identities across supported JSON summary shapes", () => {
  const name = "uiwitness-core";
  const version = "1.2.3";
  assert.doesNotThrow(() => assertPublishSummaryIdentity({ name, version }, name, version));
  assert.doesNotThrow(() =>
    assertPublishSummaryIdentity({ id: `${name}@${version}`, name, version }, name, version),
  );
  assert.doesNotThrow(() =>
    assertPublishSummaryIdentity(
      { [name]: { id: `${name}@${version}`, name, version } },
      name,
      version,
    ),
  );
  assert.throws(
    () => assertPublishSummaryIdentity({ id: "other@1.2.3", name, version }, name, version),
    /inconsistent package id/u,
  );
  assert.throws(
    () => assertPublishSummaryIdentity({ name: "other", version }, name, version),
    /wrong package name/u,
  );
  assert.throws(
    () => assertPublishSummaryIdentity({ name, version: "9.9.9" }, name, version),
    /wrong package version/u,
  );
  assert.throws(
    () => assertPublishSummaryIdentity({ other: { name, version } }, name, version),
    /wrong package name/u,
  );
  assert.throws(
    () => assertPublishSummaryIdentity({ [name]: { name, version }, extra: {} }, name, version),
    /wrong package name/u,
  );
  assert.throws(
    () => assertPublishSummaryIdentity({ [name]: null }, name, version),
    /invalid package summary/u,
  );
  assert.throws(() => assertPublishSummaryIdentity([], name, version), /invalid publish summary/u);
});

test("runs bounded shell-free release commands", async () => {
  const complete = await runCommand(process.execPath, ["--eval", 'process.stdout.write("ok")']);
  assert.equal(complete.code, 0);
  assert.equal(complete.stdout, "ok");
  await assert.rejects(
    runCommand(process.execPath, ["--eval", "setTimeout(() => {}, 1_000)"], { timeout: 10 }),
    /exceeded 10ms/u,
  );
});

test("binds package smoke to an explicit or repository Action SHA", async () => {
  const sha = "0123456789abcdef0123456789abcdef01234567";
  assert.equal(await resolveActionSha({ value: sha }), sha);
  assert.equal(await resolveActionSha({
    execute: async (command, args, options) => {
      assert.equal(command, "git");
      assert.deepEqual(args, ["rev-parse", "HEAD"]);
      assert.equal(options.timeout, 30_000);
      return { code: 0, signal: null, stderr: "", stdout: `${sha}\n` };
    },
    root: repositoryRoot,
  }), sha);
  await assert.rejects(
    resolveActionSha({
      execute: async () => ({ code: 1, signal: null, stderr: "not a checkout", stdout: "" }),
      root: repositoryRoot,
    }),
    /Resolving the Action commit SHA failed/u,
  );
});

test("packed brand inspection permits only the legacy evidence read contract", async (context) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "uiwitness-packed-brand-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  for (const { name } of RELEASE_PACKAGES) {
    await mkdir(path.join(root, name, "dist"), { recursive: true });
    await writeFile(path.join(root, name, "package.json"), JSON.stringify({ name }), "utf8");
  }
  await writeFile(
    path.join(root, "uiwitness-core", "dist", "results.js"),
    'const legacyReadRoot = ".statecraft/artifacts/";\n',
    "utf8",
  );
  await assertPackedBrandContract(root);

  await writeFile(
    path.join(root, "uiwitness", "dist", "index.js"),
    'const product = "Statecraft";\n',
    "utf8",
  );
  await assert.rejects(
    assertPackedBrandContract(root),
    /packed a non-allowlisted legacy identity/u,
  );
  await unlink(path.join(root, "uiwitness", "dist", "index.js"));

  await writeFile(
    path.join(root, "uiwitness-core", "dist", "results.js"),
    'const product = "Statecraft";\n',
    "utf8",
  );
  await assert.rejects(
    assertPackedBrandContract(root),
    /packed legacy product text outside the evidence-path compatibility contract/u,
  );
  await writeFile(
    path.join(root, "uiwitness-core", "dist", "results.js"),
    'const legacyReadRoot = ".statecraft/artifacts/";\n',
    "utf8",
  );

  const linkedFile = path.join(root, "uiwitness-core", "dist", "linked.js");
  await symlink(path.join(root, "uiwitness-core", "package.json"), linkedFile, "file");
  await assert.rejects(
    assertPackedBrandContract(root),
    /must not be a symbolic link/u,
  );
});

test("plans new publishes, skips byte-identical versions, and rejects collisions", () => {
  const candidate = {
    integrity: "sha512-same",
    name: "uiwitness-core",
    registryIntegrity: undefined,
    tarball: "/tmp/core.tgz",
    version: "1.2.3",
  };
  assert.equal(createPublicationPlan([candidate])[0].action, "publish");
  assert.equal(
    createPublicationPlan([
      { ...candidate, latestVersion: "1.2.3", registryIntegrity: "sha512-same" },
    ])[0].action,
    "skip",
  );
  assert.throws(
    () =>
      createPublicationPlan([
        { ...candidate, latestVersion: "1.2.3", registryIntegrity: "sha512-different" },
      ]),
    /different contents/u,
  );
  assert.throws(
    () => createPublicationPlan([{ ...candidate, latestVersion: "2.0.0" }]),
    /older than npm latest/u,
  );
  assert.throws(
    () => createPublicationPlan([{ ...candidate, latestVersion: "1.2.3" }]),
    /has no integrity/u,
  );
  assert.throws(
    () =>
      createPublicationPlan([
        { ...candidate, latestVersion: "1.2.2", registryIntegrity: "sha512-same" },
      ]),
    /cannot repair dist-tags/u,
  );
});

test("publishes missing tarballs in dependency order and resumes identical versions", async (context) => {
  const { input, integrities } = await createTarballFixture(context);
  const registry = new Map([["uiwitness-core", integrities.get("uiwitness-core")]]);
  const latest = new Map([["uiwitness-core", checkedInRelease.packageVersion]]);
  const published = [];
  let failRunnerOnce = true;
  const execute = async (command, args) => {
    assert.equal(command, "npm");
    if (args[0] === "view") {
      const exactVersionLookup = args[2] === "dist.integrity";
      const name = exactVersionLookup ? packageNameFromViewTarget(args[1]) : args[1];
      const source = exactVersionLookup ? registry : latest;
      if (source.has(name)) {
        return { code: 0, signal: null, stderr: "", stdout: JSON.stringify(source.get(name)) };
      }
      return { code: 1, signal: null, stderr: "npm error code E404", stdout: "" };
    }
    assert.deepEqual(args.slice(2), ["--access", "public", "--provenance"]);
    const name = packageNameFromTarball(args[1]);
    assert.notEqual(name, undefined);
    if (name === "uiwitness-runner-playwright" && failRunnerOnce) {
      failRunnerOnce = false;
      return { code: 1, signal: null, stderr: "simulated registry outage", stdout: "" };
    }
    registry.set(name, integrities.get(name));
    latest.set(name, checkedInRelease.packageVersion);
    published.push(path.basename(args[1]));
    return { code: 0, signal: null, stderr: "", stdout: "+ published" };
  };

  const options = {
    execute,
    input,
    root: repositoryRoot,
    tag: `v${checkedInRelease.packageVersion}`,
  };
  await assert.rejects(publishReleasePackages(options), /simulated registry outage/u);
  assert.deepEqual(published, [releaseTarballName("uiwitness-report", checkedInRelease.packageVersion)]);

  const plan = await publishReleasePackages(options);
  assert.deepEqual(plan.map(({ action }) => action), ["skip", "skip", "publish", "publish"]);
  assert.deepEqual(published, [
    releaseTarballName("uiwitness-report", checkedInRelease.packageVersion),
    releaseTarballName("uiwitness-runner-playwright", checkedInRelease.packageVersion),
    releaseTarballName("uiwitness", checkedInRelease.packageVersion),
  ]);
  const retry = await publishReleasePackages(options);
  assert.deepEqual(retry.map(({ action }) => action), ["skip", "skip", "skip", "skip"]);
});

test("rejects malformed and non-404 registry responses before publishing", async (context) => {
  const { input } = await createTarballFixture(context);
  const notFound = { code: 1, signal: null, stderr: "npm error code E404", stdout: "" };
  const cases = [
    {
      expected: /invalid integrity/u,
      executeView: (args) =>
        args[2] === "dist-tags.latest"
          ? notFound
          : { code: 0, signal: null, stderr: "", stdout: "{}" },
    },
    {
      expected: /invalid latest version/u,
      executeView: () => ({ code: 0, signal: null, stderr: "", stdout: "{}" }),
    },
    {
      expected: /Could not inspect the latest version/u,
      executeView: () => ({ code: 1, signal: null, stderr: "npm error code E401", stdout: "" }),
    },
    {
      expected: /Could not inspect/u,
      executeView: (args) =>
        args[2] === "dist-tags.latest"
          ? notFound
          : { code: 1, signal: null, stderr: "npm error code E429", stdout: "" },
    },
    {
      expected: /Could not inspect/u,
      executeView: (args) =>
        args[2] === "dist-tags.latest"
          ? notFound
          : { code: 1, signal: null, stderr: "npm error code E500", stdout: "" },
    },
  ];

  for (const { executeView, expected } of cases) {
    let publishAttempted = false;
    const execute = async (_command, args) => {
      if (args[0] === "view") return executeView(args);
      publishAttempted = true;
      return { code: 0, signal: null, stderr: "", stdout: "" };
    };
    await assert.rejects(
      publishReleasePackages({
        execute,
        input,
        root: repositoryRoot,
        tag: `v${checkedInRelease.packageVersion}`,
      }),
      expected,
    );
    assert.equal(publishAttempted, false);
  }
});

test("rejects unsafe and incomplete publisher input paths", async (context) => {
  const tag = `v${checkedInRelease.packageVersion}`;
  await assert.rejects(publishReleasePackages({ root: repositoryRoot, tag }), /--input is required/u);

  const nonDirectoryRoot = await mkdtemp(path.join(os.tmpdir(), "uiwitness-publish-file-"));
  context.after(() => rm(nonDirectoryRoot, { force: true, recursive: true }));
  const nonDirectory = path.join(nonDirectoryRoot, "packages");
  await writeFile(nonDirectory, "not a directory", "utf8");
  await assert.rejects(
    publishReleasePackages({ input: nonDirectory, root: repositoryRoot, tag }),
    /must be a directory/u,
  );

  const symlinkTarget = await mkdtemp(path.join(os.tmpdir(), "uiwitness-publish-link-target-"));
  const symlinkRoot = await mkdtemp(path.join(os.tmpdir(), "uiwitness-publish-link-"));
  context.after(() => rm(symlinkTarget, { force: true, recursive: true }));
  context.after(() => rm(symlinkRoot, { force: true, recursive: true }));
  const linkedInput = path.join(symlinkRoot, "packages");
  await symlink(symlinkTarget, linkedInput, process.platform === "win32" ? "junction" : "dir");
  await assert.rejects(
    publishReleasePackages({ input: linkedInput, root: repositoryRoot, tag }),
    /must not be a symbolic link/u,
  );

  const incomplete = await mkdtemp(path.join(os.tmpdir(), "uiwitness-publish-incomplete-"));
  context.after(() => rm(incomplete, { force: true, recursive: true }));
  await assert.rejects(
    publishReleasePackages({ input: incomplete, root: repositoryRoot, tag }),
    /directory is incomplete/u,
  );
  await writeFile(path.join(incomplete, "unexpected.tgz"), "unexpected", "utf8");
  await assert.rejects(
    publishReleasePackages({ input: incomplete, root: repositoryRoot, tag }),
    /directory is incomplete/u,
  );

  const symlinkTarballs = await createTarballFixture(context);
  const coreTarball = path.join(
    symlinkTarballs.input,
    releaseTarballName("uiwitness-core", checkedInRelease.packageVersion),
  );
  const externalTarballRoot = await mkdtemp(path.join(os.tmpdir(), "uiwitness-publish-external-"));
  context.after(() => rm(externalTarballRoot, { force: true, recursive: true }));
  const externalTarball = path.join(externalTarballRoot, "core.tgz");
  await writeFile(externalTarball, "external", "utf8");
  await unlink(coreTarball);
  await symlink(externalTarball, coreTarball, "file");
  await assert.rejects(
    publishReleasePackages({ input: symlinkTarballs.input, root: repositoryRoot, tag }),
    /tarball must not be a symbolic link/u,
  );

  const directoryTarballs = await createTarballFixture(context);
  const missingRegistry = async (_command, args) => {
    assert.equal(args[0], "view");
    return { code: 1, signal: null, stderr: "npm error code E404", stdout: "" };
  };
  const reportTarball = path.join(
    directoryTarballs.input,
    releaseTarballName("uiwitness-report", checkedInRelease.packageVersion),
  );
  await unlink(reportTarball);
  await mkdir(reportTarball);
  await assert.rejects(
    publishReleasePackages({
      execute: missingRegistry,
      input: directoryTarballs.input,
      root: repositoryRoot,
      tag,
    }),
    /tarball must be a regular file/u,
  );
});
