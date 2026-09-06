import { execFile } from "node:child_process";
import {
  access,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  canonicalJsonDigest,
  contractConfigDigest,
  type ContractConfigurationCoordinate,
  type UIWitnessContract,
} from "uiwitness-core";
import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

interface PackageManifest {
  bin?: {
    uiwitness?: string;
  };
  exports?: {
    "."?: {
      import?: string;
      types?: string;
    };
    "./public-site-scenario"?: {
      import?: string;
      types?: string;
    };
  };
  name?: string;
  private?: boolean;
  type?: string;
  version?: string;
}

describe("uiwitness package boundary", () => {
  it("defines a publishable ESM build with deterministic dist paths", async () => {
    const manifestUrl = new URL("../package.json", import.meta.url);
    const contents = await readFile(manifestUrl, "utf8");
    const manifest = JSON.parse(contents) as PackageManifest;

    expect(manifest).toMatchObject({
      name: "uiwitness",
      type: "module",
      bin: {
        uiwitness: "./dist/bin.js",
      },
      exports: {
        ".": {
          import: "./dist/index.js",
          types: "./dist/index.d.ts",
        },
        "./public-site-scenario": {
          import: "./dist/public-site-scenario.js",
          types: "./dist/public-site-scenario.d.ts",
        },
      },
    });
    expect(manifest.private).toBeUndefined();

    const importPath = manifest.exports?.["."]?.import;
    const typesPath = manifest.exports?.["."]?.types;
    const scenarioImportPath =
      manifest.exports?.["./public-site-scenario"]?.import;
    const scenarioTypesPath =
      manifest.exports?.["./public-site-scenario"]?.types;
    const binPath = manifest.bin?.uiwitness;
    expect(importPath).toBeDefined();
    expect(typesPath).toBeDefined();
    expect(binPath).toBeDefined();
    expect(scenarioImportPath).toBeDefined();
    expect(scenarioTypesPath).toBeDefined();

    const packageRoot = new URL("../", import.meta.url);
    const importUrl = new URL(importPath ?? "", packageRoot);
    const typesUrl = new URL(typesPath ?? "", packageRoot);
    const binUrl = new URL(binPath ?? "", packageRoot);
    const scenarioImportUrl = new URL(scenarioImportPath ?? "", packageRoot);
    const scenarioTypesUrl = new URL(scenarioTypesPath ?? "", packageRoot);
    await expect(access(typesUrl)).resolves.toBeUndefined();
    await expect(access(scenarioTypesUrl)).resolves.toBeUndefined();
    await expect(access(binUrl)).resolves.toBeUndefined();
    await expect(readFile(binUrl, "utf8")).resolves.toMatch(
      /^#!\/usr\/bin\/env node\n/,
    );
    const builtModule = await import(importUrl.href);
    const scenarioModule = await import(scenarioImportUrl.href);
    expect(scenarioModule.publicSiteScenario).toMatchObject({
      assert: expect.any(Function),
    });
    expect(Object.keys(builtModule).sort()).toEqual([
      "CheckError",
      "ConfigDiscoveryError",
      "ConfigLoadError",
      "DEFAULT_CONFIG_FILENAMES",
      "GuardError",
      "InitError",
      "OpenReportError",
      "ScanError",
      "checkPublicSite",
      "createGuardShardPlan",
      "defineConfig",
      "discoverConfig",
      "initProject",
      "loadConfig",
      "openReport",
      "runCli",
      "runGuardShard",
      "scanProject",
    ]);
  });

  it("compiles the documented public API through the package export", async () => {
    const typeScriptCli = require.resolve("typescript/bin/tsc");
    const typeContractConfig = fileURLToPath(
      new URL("../test-d/tsconfig.json", import.meta.url),
    );

    await expect(
      execFileAsync(process.execPath, [typeScriptCli, "-p", typeContractConfig]),
    ).resolves.toMatchObject({ stderr: "", stdout: "" });
  });

  it("runs the built executable entrypoint", async () => {
    const project = await realpath(
      await mkdtemp(join(tmpdir(), "uiwitness-cli-bin-")),
    );
    const binPath = fileURLToPath(
      new URL("../dist/bin.js", import.meta.url),
    );
    const manifest = JSON.parse(
      await readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as PackageManifest;

    try {
      await expect(
        execFileAsync(process.execPath, [binPath, "--version"], { cwd: project }),
      ).resolves.toEqual({
        stderr: "",
        stdout: `${manifest.version}\n`,
      });
      await expect(
        execFileAsync(process.execPath, [binPath, "init"], { cwd: project }),
      ).resolves.toMatchObject({
        stderr: "",
        stdout: expect.stringContaining("UIWitness initialized."),
      });
      await expect(
        access(join(project, "uiwitness.config.mts")),
      ).resolves.toBeUndefined();
      await expect(
        execFileAsync(process.execPath, [binPath, "open"], { cwd: project }),
      ).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining(
          "No UIWitness HTML report found at .uiwitness/report/index.html.",
        ),
      });

      const packageModules = join(project, "node_modules");
      await mkdir(packageModules, { recursive: true });
      await symlink(
        fileURLToPath(new URL("../", import.meta.url)),
        join(packageModules, "uiwitness"),
        process.platform === "win32" ? "junction" : "dir",
      );
      await writeFile(
        join(project, "package.json"),
        JSON.stringify({ private: true }),
        "utf8",
      );
      expect(
        JSON.parse(await readFile(join(project, "package.json"), "utf8")),
      ).not.toHaveProperty("type");
      await writeFile(
        join(project, "tsconfig.json"),
        JSON.stringify({
          compilerOptions: {
            module: "NodeNext",
            moduleResolution: "NodeNext",
            noEmit: true,
            skipLibCheck: false,
            strict: true,
            target: "ES2023",
            types: [],
          },
          include: ["uiwitness.config.mts", "uiwitness/**/*.mts"],
        }),
        "utf8",
      );
      const typeScriptCli = require.resolve("typescript/bin/tsc");
      await expect(
        execFileAsync(process.execPath, [typeScriptCli, "-p", "tsconfig.json"], {
          cwd: project,
        }),
      ).resolves.toMatchObject({ stderr: "", stdout: "" });

      const builtCli = await import(
        new URL("../dist/index.js", import.meta.url).href
      );
      await expect(builtCli.loadConfig({ cwd: project })).resolves.toMatchObject(
        {
          config: {
            baseURL: "http://localhost:3000",
            routes: [{ id: "home", path: "/" }],
          },
        },
      );
      const scenarioModule = await import(
        pathToFileURL(
          join(project, "uiwitness", "scenarios", "home", "success.mts"),
        ).href
      );
      expect(scenarioModule.default).toEqual({});

      await writeFile(
        join(project, "scan-scenario.mjs"),
        `export default {
  async beforeNavigate({ page }) {
    await page.route("**/*", async (route) => route.fulfill({
      body: "<!doctype html><title>Ready</title><h1>Ready</h1>",
      contentType: "text/html",
      status: 200,
    }));
  },
};\n`,
        "utf8",
      );
      await writeFile(
        join(project, "scan.config.mjs"),
        `export default {
  baseURL: "https://uiwitness.invalid",
  routes: [{ id: "home", path: "/", states: [{ id: "success", setup: "./scan-scenario.mjs" }] }],
  themes: ["light"],
  viewports: { compact: { height: 240, width: 320 } },
};\n`,
        "utf8",
      );
      await expect(
        execFileAsync(
          process.execPath,
          [
            binPath,
            "scan",
            "--config",
            "scan.config.mjs",
            "--coordinate",
            "home/success/compact/light",
          ],
          { cwd: project },
        ),
      ).resolves.toMatchObject({
        stderr: "",
        stdout: expect.stringContaining("All 1 execution passed."),
      });
      await expect(
        access(join(project, ".uiwitness", "report", "uiwitness.json")),
      ).resolves.toBeUndefined();
      await expect(
        readFile(join(project, ".uiwitness", "report", "index.html"), "utf8"),
      ).resolves.toContain("UI State Coverage Report");

      const coordinate: ContractConfigurationCoordinate = {
        configFingerprint: canonicalJsonDigest({
          consoleError: false,
          failedRequest: false,
          height: 240,
          pageError: true,
          routeId: "home",
          routePath: "/",
          scenarioSource: "./scan-scenario.mjs",
          stateId: "success",
          theme: "light",
          viewportId: "compact",
          width: 320,
        }),
        id: "home/success/compact/light",
        routeId: "home",
        routePath: "/",
        scenarioSource: "./scan-scenario.mjs",
        stateId: "success",
        theme: "light",
        viewport: { height: 240, width: 320 },
        viewportId: "compact",
      };
      const contract: UIWitnessContract = {
        configDigest: contractConfigDigest([coordinate]),
        coordinates: [{ ...coordinate, expected: { status: "passed" } }],
        schemaVersion: 1,
      };
      await writeFile(
        join(project, "uiwitness.contract.json"),
        `${JSON.stringify(contract, null, 2)}\n`,
        "utf8",
      );
      await expect(
        execFileAsync(
          process.execPath,
          [binPath, "guard", "--config", "scan.config.mjs"],
          { cwd: project },
        ),
      ).resolves.toMatchObject({
        stderr: "",
        stdout: expect.stringContaining("Verdict: PROMISE KEPT"),
      });
      await expect(
        readFile(
          join(project, ".uiwitness", "contract-verdict.json"),
          "utf8",
        ),
      ).resolves.toContain('"verdict":"passed"');

      await expect(
        execFileAsync(process.execPath, [binPath, "init"], { cwd: project }),
      ).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining(
          "UIWitness initialization conflicts with existing paths:",
        ),
      });
    } finally {
      await rm(project, { force: true, recursive: true });
    }
  }, 20_000);
});
