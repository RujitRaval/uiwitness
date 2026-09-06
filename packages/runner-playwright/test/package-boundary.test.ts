import { execFile } from "node:child_process";
import { access, readFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { describe, expect, it } from "vitest";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

interface PackageManifest {
  dependencies?: Record<string, string>;
  exports?: {
    "."?: {
      import?: string;
      types?: string;
    };
    "./public-site-contract"?: {
      import?: string;
      types?: string;
    };
  };
  name?: string;
  private?: boolean;
  type?: string;
}

describe("uiwitness-runner-playwright package boundary", () => {
  it("defines a publishable ESM build with pinned runtime dependencies", async () => {
    const manifestUrl = new URL("../package.json", import.meta.url);
    const contents = await readFile(manifestUrl, "utf8");
    const manifest = JSON.parse(contents) as PackageManifest;

    expect(manifest).toMatchObject({
      dependencies: {
        "uiwitness-core": "workspace:*",
        "uiwitness-report": "workspace:*",
        playwright: "1.62.1",
      },
      name: "uiwitness-runner-playwright",
      type: "module",
      exports: {
        ".": {
          import: "./dist/index.js",
          types: "./dist/index.d.ts",
        },
        "./public-site-contract": {
          import: "./dist/public-site-contract.js",
          types: "./dist/public-site-contract.d.ts",
        },
      },
    });
    expect(manifest.private).toBeUndefined();

    const importPath = manifest.exports?.["."]?.import;
    const typesPath = manifest.exports?.["."]?.types;
    expect(importPath).toBeDefined();
    expect(typesPath).toBeDefined();

    const packageRoot = new URL("../", import.meta.url);
    const importUrl = new URL(importPath ?? "", packageRoot);
    const typesUrl = new URL(typesPath ?? "", packageRoot);
    await expect(access(typesUrl)).resolves.toBeUndefined();
    const builtModule = await import(importUrl.href);
    expect(Object.keys(builtModule)).toEqual([
      "AuthenticationError",
      "discoverPublicRoutes",
      "PublicRouteDiscoveryError",
      "runExecutionCells",
      "EvidencePolicyError",
      "runCapturedScenarioCells",
      "ScenarioCaptureError",
      "runPersistedScenarioCells",
      "withGenerationTransactionLock",
      "loadScenario",
      "runScenarioCells",
      "runScenarioLifecycle",
      "ScenarioLoadError",
      "PUBLIC_SITE_OVERFLOW_TOLERANCE_PX",
      "publicSiteScenario",
      "runPublicSiteChecks",
      "runNavigatedScenarioCells",
    ]);

    const contractExport = manifest.exports?.["./public-site-contract"];
    const contractImportUrl = new URL(
      contractExport?.import ?? "",
      packageRoot,
    );
    const contractTypesUrl = new URL(
      contractExport?.types ?? "",
      packageRoot,
    );
    await expect(access(contractTypesUrl)).resolves.toBeUndefined();
    const { PUBLIC_SITE_CHECK_CONTRACT } = await import(contractImportUrl.href);
    expect(PUBLIC_SITE_CHECK_CONTRACT).toEqual({
      failOn: {
        consoleError: false,
        failedRequest: false,
        pageError: true,
      },
      themes: ["light", "dark"],
      viewports: {
        mobile: { height: 844, width: 390 },
        desktop: { height: 900, width: 1_440 },
      },
    });
    expect(Object.isFrozen(PUBLIC_SITE_CHECK_CONTRACT)).toBe(true);
  });

  it(
    "compiles the documented public API through the package export",
    async () => {
      const typeScriptCli = require.resolve("typescript/bin/tsc");
      const typeContractConfig = fileURLToPath(
        new URL("../test-d/tsconfig.json", import.meta.url),
      );

      await expect(
        execFileAsync(process.execPath, [typeScriptCli, "-p", typeContractConfig]),
      ).resolves.toMatchObject({ stderr: "", stdout: "" });
    },
    15_000,
  );
});
