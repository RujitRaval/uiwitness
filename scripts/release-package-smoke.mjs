import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import {
  copyFile,
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from "node:fs/promises";
import { createServer } from "node:http";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { RELEASE_PACKAGES, validateReleaseWorkspace } from "./check-release-packages.mjs";
import { normalizeActionSha, runReleaseActionFixture } from "./release-action-smoke.mjs";

const repositoryRoot = path.resolve(import.meta.dirname, "..");
const commandTimeout = 180_000;

function capture(stream) {
  let value = "";
  stream?.setEncoding("utf8");
  stream?.on("data", (chunk) => {
    value = `${value}${chunk}`.slice(-100_000);
  });
  return () => value;
}

export async function runCommand(command, args, { cwd, env = process.env, timeout = commandTimeout } = {}) {
  const child = spawn(command, args, {
    cwd,
    env,
    shell: process.platform === "win32" && command === "corepack",
    stdio: ["ignore", "pipe", "pipe"],
  });
  const stdout = capture(child.stdout);
  const stderr = capture(child.stderr);
  let killTimer;
  let timedOut = false;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      killTimer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    }, timeout);
    const cleanUp = () => {
      clearTimeout(timer);
      clearTimeout(killTimer);
    };
    child.once("error", (error) => {
      cleanUp();
      reject(error);
    });
    child.once("close", (code, signal) => {
      cleanUp();
      if (timedOut) {
        reject(new Error(`${command} exceeded ${timeout}ms.`));
        return;
      }
      resolve({ code, signal });
    });
  });
  return { ...result, stderr: stderr(), stdout: stdout() };
}

function assertCommand(result, label) {
  assert.equal(
    result.code,
    0,
    `${label} failed${result.signal ? ` (${result.signal})` : ""}:\n${result.stderr || result.stdout}`,
  );
}

export function releaseTarballName(packageName, packageVersion) {
  return `${packageName.replace(/^@/u, "").replaceAll("/", "-")}-${packageVersion}.tgz`;
}

export function assertPublishSummaryIdentity(summary, packageName, packageVersion) {
  assert.equal(
    summary !== null && typeof summary === "object" && !Array.isArray(summary),
    true,
    `npm returned an invalid publish summary for ${packageName}.`,
  );
  const summaryKeys = Object.keys(summary);
  const packageSummary = summaryKeys.length === 1 && Object.hasOwn(summary, packageName)
    ? summary[packageName]
    : summary;
  assert.equal(
    packageSummary !== null && typeof packageSummary === "object" && !Array.isArray(packageSummary),
    true,
    `npm returned an invalid package summary for ${packageName}.`,
  );
  assert.equal(
    packageSummary.name,
    packageName,
    `npm dry-run reported the wrong package name for ${packageName}.`,
  );
  assert.equal(
    packageSummary.version,
    packageVersion,
    `npm dry-run reported the wrong package version for ${packageName}.`,
  );
  if (packageSummary.id !== undefined) {
    assert.equal(
      packageSummary.id,
      `${packageName}@${packageVersion}`,
      `npm dry-run reported an inconsistent package id for ${packageName}.`,
    );
  }
}

async function createOutputDirectory(requestedPath) {
  const resolved = path.resolve(requestedPath);
  const parent = await realpath(path.dirname(resolved));
  const output = path.join(parent, path.basename(resolved));
  await mkdir(output, { recursive: false, mode: 0o700 });
  return output;
}

async function existingPackageDirectory(requestedPath) {
  const resolved = path.resolve(requestedPath);
  const metadata = await lstat(resolved);
  assert.equal(metadata.isSymbolicLink(), false, "Release package input must not be a symbolic link.");
  assert.equal(metadata.isDirectory(), true, "Release package input must be a directory.");
  return realpath(resolved);
}

export async function resolveActionSha({ execute = runCommand, root = repositoryRoot, value } = {}) {
  if (value !== undefined) return normalizeActionSha(value);
  const result = await execute("git", ["rev-parse", "HEAD"], { cwd: root, timeout: 30_000 });
  assertCommand(result, "Resolving the Action commit SHA");
  return normalizeActionSha(result.stdout.trim());
}

async function assertInstalledPackage(packageRoot, contract, packageVersion) {
  const manifest = JSON.parse(await readFile(path.join(packageRoot, "package.json"), "utf8"));
  assert.equal(manifest.name, contract.name);
  assert.equal(manifest.version, packageVersion);
  assert.equal(manifest.private, undefined);
  assert.equal(manifest.repository.url, "git+https://github.com/RujitRaval/uiwitness.git");
  assert.equal(manifest.publishConfig.access, "public");
  for (const dependency of Object.keys(contract.dependencies)) {
    assert.equal(manifest.dependencies[dependency], packageVersion);
  }

  const entries = await readdir(packageRoot);
  const allowed = new Set(["LICENSE", "README.md", "dist", "package.json"]);
  assert.deepEqual(
    entries.filter((entry) => !allowed.has(entry)),
    [],
    `${contract.name} packed unexpected top-level files.`,
  );
  assert.equal((await lstat(path.join(packageRoot, "dist"))).isDirectory(), true);
  assert.equal(
    await readFile(path.join(packageRoot, "LICENSE"), "utf8"),
    await readFile(path.join(repositoryRoot, "LICENSE"), "utf8"),
  );
  assert.equal(
    (await readdir(path.join(packageRoot, "dist"), { recursive: true })).some(
      (entry) => entry.endsWith(".tsbuildinfo"),
    ),
    false,
    `${contract.name} packed a TypeScript compiler cache.`,
  );
}

const packedLegacyEvidenceFiles = new Set([
  "uiwitness/README.md",
  "uiwitness-core/README.md",
  "uiwitness-core/dist/results.js",
  "uiwitness-core/dist/results.js.map",
  "uiwitness-report/README.md",
  "uiwitness-report/dist/transform.js",
  "uiwitness-report/dist/transform.js.map",
  "uiwitness-runner-playwright/README.md",
]);

function decodeText(buffer) {
  if (buffer.includes(0)) return undefined;
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    return undefined;
  }
}

export async function assertPackedBrandContract(nodeModulesRoot) {
  for (const contract of RELEASE_PACKAGES) {
    const packageRoot = path.join(nodeModulesRoot, contract.name);
    for (const entry of await readdir(packageRoot, { recursive: true })) {
      const filePath = path.join(packageRoot, entry);
      const metadata = await lstat(filePath);
      assert.equal(
        metadata.isSymbolicLink(),
        false,
        `${contract.name}/${entry} must not be a symbolic link.`,
      );
      if (!metadata.isFile()) continue;
      const contents = decodeText(await readFile(filePath));
      if (contents === undefined || !/statecraft/iu.test(contents)) continue;
      const packagePath = `${contract.name}/${entry.split(path.sep).join("/")}`;
      assert.equal(
        packedLegacyEvidenceFiles.has(packagePath),
        true,
        `${packagePath} packed a non-allowlisted legacy identity.`,
      );
      for (const line of contents.split("\n")) {
        if (/statecraft/iu.test(line)) {
          assert.match(
            line,
            /\.statecraft\//u,
            `${packagePath} packed legacy product text outside the evidence-path compatibility contract.`,
          );
        }
      }
    }
  }
}

export async function runReleasePackageSmoke({
  actionSha,
  input,
  onProgress = () => {},
  output,
  root = repositoryRoot,
} = {}) {
  assert.equal(input === undefined || output === undefined, true, "Specify at most one of --input and --output.");
  const { packageVersion } = await validateReleaseWorkspace({ root });
  const resolvedActionSha = await resolveActionSha({ root, value: actionSha });
  const localRoot = output === undefined && input === undefined
    ? await mkdtemp(path.join(os.tmpdir(), "uiwitness-package-smoke-"))
    : undefined;
  const packageOutput = input !== undefined
    ? await existingPackageDirectory(input)
    : output === undefined
      ? path.join(localRoot, "packages")
      : await createOutputDirectory(output);
  if (output === undefined && input === undefined) await mkdir(packageOutput, { mode: 0o700 });
  const consumerRoot = await mkdtemp(path.join(os.tmpdir(), "uiwitness-package-consumer-"));
  const npmEnvironment = {
    ...process.env,
    npm_config_cache: path.join(consumerRoot, ".npm-cache"),
  };
  let fixtureServer;

  try {
    const tarballs = [];
    for (const contract of RELEASE_PACKAGES) {
      onProgress(`${input === undefined ? "Packing" : "Validating"} ${contract.name}.`);
      const tarball = path.join(packageOutput, releaseTarballName(contract.name, packageVersion));
      if (input === undefined) {
        const buildEntry = path.join(root, contract.directory, "dist", "index.js");
        assert.equal((await lstat(buildEntry)).isFile(), true, `${contract.name} must be built before packing.`);
        const pack = await runCommand(
          "corepack",
          ["pnpm", "--filter", contract.name, "pack", "--pack-destination", packageOutput],
          { cwd: root },
        );
        assertCommand(pack, `Packing ${contract.name}`);
      }
      assert.equal((await lstat(tarball)).isFile(), true, `${contract.name} tarball was not created.`);
      assert.equal((await lstat(tarball)).isSymbolicLink(), false, `${contract.name} tarball must not be a symbolic link.`);
      if (input === undefined) {
        const dryRun = await runCommand("npm", ["publish", tarball, "--dry-run", "--json", "--offline"], {
          cwd: root,
          env: npmEnvironment,
        });
        assertCommand(dryRun, `Dry-run publishing ${contract.name}`);
        const publishSummary = JSON.parse(dryRun.stdout);
        assertPublishSummaryIdentity(publishSummary, contract.name, packageVersion);
      }
      tarballs.push(tarball);
    }
    assert.deepEqual(
      (await readdir(packageOutput)).sort(),
      tarballs.map((tarball) => path.basename(tarball)).sort(),
      "Release package input must contain exactly the four expected tarballs.",
    );
    const consumerPackageRoot = path.join(consumerRoot, "packages");
    await mkdir(consumerPackageRoot, { mode: 0o700 });
    const consumerTarballs = [];
    for (const tarball of tarballs) {
      const consumerTarball = path.join(consumerPackageRoot, path.basename(tarball));
      await copyFile(tarball, consumerTarball);
      consumerTarballs.push(consumerTarball);
    }

    const npmInit = await runCommand("npm", ["init", "--yes"], { cwd: consumerRoot, env: npmEnvironment });
    assertCommand(npmInit, "Initializing a default npm consumer");
    const consumerManifest = JSON.parse(
      await readFile(path.join(consumerRoot, "package.json"), "utf8"),
    );
    assert.notEqual(
      consumerManifest.type,
      "module",
      "npm init must leave the consumer outside package-wide ESM mode.",
    );
    onProgress("Installing the exact four tarballs in a CommonJS-default consumer.");
    const install = await runCommand(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--package-lock=false",
        ...consumerTarballs,
      ],
      { cwd: consumerRoot, env: npmEnvironment },
    );
    assertCommand(install, "Installing packed packages");

    onProgress("Installing pinned Chromium in the packed consumer.");
    const chromiumInstall = await runCommand(
      "npm",
      ["exec", "--offline", "--", "playwright", "install", "chromium"],
      { cwd: consumerRoot, env: npmEnvironment },
    );
    assertCommand(chromiumInstall, "Installing Chromium from the packed consumer");

    for (const contract of RELEASE_PACKAGES) {
      await assertInstalledPackage(
        path.join(consumerRoot, "node_modules", contract.name),
        contract,
        packageVersion,
      );
    }
    await assertPackedBrandContract(path.join(consumerRoot, "node_modules"));

    const importProbe = path.join(consumerRoot, "import-probe.mjs");
    await writeFile(
      importProbe,
      [
        'import { defineConfig, parseReport } from "uiwitness-core";',
        'import { renderReportHtml } from "uiwitness-report";',
        'import { runExecutionCells } from "uiwitness-runner-playwright";',
        'import { runCli } from "uiwitness";',
        "if (![defineConfig, parseReport, renderReportHtml, runExecutionCells, runCli].every((value) => typeof value === \"function\")) process.exit(1);",
        "",
      ].join("\n"),
      "utf8",
    );
    const imports = await runCommand(process.execPath, [importProbe], { cwd: consumerRoot });
    assertCommand(imports, "Importing packed package APIs");

    const cliManifest = JSON.parse(
      await readFile(path.join(consumerRoot, "node_modules", "uiwitness", "package.json"), "utf8"),
    );
    assert.equal(cliManifest.bin.uiwitness, "./dist/bin.js");
    const cliBinPath = path.join(
      consumerRoot,
      "node_modules",
      "uiwitness",
      cliManifest.bin.uiwitness,
    );
    const help = await runCommand("npm", ["exec", "--offline", "--", "uiwitness", "--help"], {
      cwd: consumerRoot,
      env: npmEnvironment,
    });
    assertCommand(help, "Running the packed CLI");
    assert.match(help.stdout, /uiwitness scan/u);

    const init = await runCommand("npm", ["exec", "--offline", "--", "uiwitness", "init"], {
      cwd: consumerRoot,
      env: npmEnvironment,
    });
    assertCommand(init, "Initializing with the packed CLI");
    const generatedConfigPath = path.join(consumerRoot, "uiwitness.config.mts");
    assert.match(await readFile(generatedConfigPath, "utf8"), /from "uiwitness"/u);
    assert.match(
      await readFile(path.join(consumerRoot, "uiwitness", "scenarios", "home", "success.mts"), "utf8"),
      /export default scenario/u,
    );

    fixtureServer = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      response.end("<!doctype html><html><head><title>Ready</title></head><body><h1>Ready</h1></body></html>");
    });
    fixtureServer.listen(0, "127.0.0.1");
    await once(fixtureServer, "listening");
    const fixtureAddress = fixtureServer.address();
    assert.notEqual(fixtureAddress, null);
    assert.equal(typeof fixtureAddress, "object");
    const generatedConfig = await readFile(generatedConfigPath, "utf8");
    assert.match(generatedConfig, /http:\/\/localhost:3000/u);
    await writeFile(
      generatedConfigPath,
      generatedConfig.replace(
        "http://localhost:3000",
        `http://127.0.0.1:${fixtureAddress.port}`,
      ),
      "utf8",
    );

    const scan = await runCommand(
      process.execPath,
      [cliBinPath, "scan"],
      { cwd: consumerRoot },
    );
    assertCommand(scan, "Scanning the default CommonJS npm consumer");
    assert.match(scan.stdout, /All 4 executions passed\./u);
    const report = JSON.parse(
      await readFile(path.join(consumerRoot, ".uiwitness", "report", "uiwitness.json"), "utf8"),
    );
    assert.equal(report.schemaVersion, 1);
    assert.deepEqual(
      {
        executions: report.summary.executions,
        failed: report.summary.failed,
        passed: report.summary.passed,
      },
      { executions: 4, failed: 0, passed: 4 },
    );
    assert.equal(report.executions.length, 4);
    const artifactRoot = path.join(consumerRoot, ".uiwitness", "artifacts");
    const artifactPrefix = `${artifactRoot}${path.sep}`;
    const artifactRealRoot = await realpath(artifactRoot);
    const artifactRealPrefix = `${artifactRealRoot}${path.sep}`;
    for (const execution of report.executions) {
      assert.equal(typeof execution.screenshotPath, "string");
      const screenshot = path.resolve(consumerRoot, execution.screenshotPath);
      assert.equal(
        screenshot.startsWith(artifactPrefix),
        true,
        `Screenshot escaped the consumer artifact root: ${execution.screenshotPath}`,
      );
      assert.equal(
        (await realpath(screenshot)).startsWith(artifactRealPrefix),
        true,
        `Screenshot resolved outside the consumer artifact root: ${execution.screenshotPath}`,
      );
      const screenshotMetadata = await lstat(screenshot);
      assert.equal(screenshotMetadata.isSymbolicLink(), false);
      assert.equal(screenshotMetadata.isFile(), true);
      assert.equal(screenshotMetadata.size > 0, true);
    }
    assert.match(
      await readFile(path.join(consumerRoot, ".uiwitness", "report", "index.html"), "utf8"),
      /UI State Coverage Report/u,
    );

    onProgress(`Running passing and seeded-regression guards through Action ${resolvedActionSha}.`);
    const action = await runReleaseActionFixture({
      actionRoot: root,
      actionSha: resolvedActionSha,
      cliBinPath,
      consumerRoot,
      execute: runCommand,
      fixtureUrl: `http://127.0.0.1:${fixtureAddress.port}`,
      packageVersion,
    });

    return { action, packageOutput, packageVersion, tarballs };
  } finally {
    if (fixtureServer?.listening) {
      await new Promise((resolve, reject) => {
        fixtureServer.close((error) => (error ? reject(error) : resolve()));
      });
    }
    await rm(consumerRoot, { force: true, recursive: true });
    if (localRoot !== undefined) await rm(localRoot, { force: true, recursive: true });
  }
}

function argumentValue(arguments_, name) {
  const index = arguments_.indexOf(name);
  return index === -1 ? undefined : arguments_[index + 1];
}

async function main() {
  const result = await runReleasePackageSmoke({
    actionSha: argumentValue(process.argv, "--action-sha"),
    input: argumentValue(process.argv, "--input"),
    onProgress: (message) => console.log(message),
    output: argumentValue(process.argv, "--output"),
  });
  console.log(
    `Release package smoke passed: ${result.tarballs.length} tarballs at ${result.packageVersion} install and run with pinned Action ${result.action.actionSha} parity for passing and seeded-regression guards.`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    await main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}
