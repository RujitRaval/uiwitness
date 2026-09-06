import {
  access,
  chmod,
  link,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";

import {
  contractConfigDigest,
  parseAnyReport,
  parseConfig,
  parseContractProposal,
  parseReport,
  type ContractConfigurationCoordinate,
  type AnyUIWitnessReport,
  type UIWitnessContract,
  type UIWitnessReport,
} from "uiwitness-core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  guardConfiguration,
  guardRemediateCommand,
  guardReproduceCommand,
  guardRunDigest,
  reportIsComplete,
} from "../src/guard-adapter.js";
import { annotateContractChange, initContract } from "../src/contract.js";
import {
  DEFAULT_GUARD_VERDICT_PATH,
  GuardError,
  guardProject,
} from "../src/guard.js";

const runPersistedScenarioCellsMock = vi.hoisted(() => vi.fn());

vi.mock("uiwitness-runner-playwright", () => ({
  runPersistedScenarioCells: runPersistedScenarioCellsMock,
}));

const projects: string[] = [];

interface GuardFixture {
  readonly configPath: string;
  readonly contractPath: string;
  readonly project: string;
  readonly scenarioPath: string;
}

async function temporaryProject(prefix = "uiwitness-cli-guard-"): Promise<string> {
  const project = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  projects.push(project);
  return project;
}

async function fixture(options: {
  readonly authentication?: boolean;
  readonly configDirectory?: string;
  readonly configFilename?: string;
  readonly evidence?: boolean;
  readonly routePath?: string;
} = {}): Promise<GuardFixture> {
  const project = await temporaryProject();
  const configDirectory = join(project, options.configDirectory ?? "");
  await mkdir(configDirectory, { recursive: true });
  const scenarioPath = join(configDirectory, "scenario.mjs");
  await writeFile(scenarioPath, "export default {};\n", "utf8");
  if (options.authentication === true) {
    await writeFile(
      join(configDirectory, "auth.mjs"),
      "export default async function () {};\n",
      "utf8",
    );
  }
  const configPath = join(
    configDirectory,
    options.configFilename ?? "uiwitness.config.mjs",
  );
  await writeFile(
    configPath,
    `export default {
  ${options.authentication === true ? 'authentication: { additionalOrigins: ["https://id.example.test"], cookieScopes: [{ domain: ".example.test", pathPrefix: "/account", secure: "required", partitionKeys: ["https://example.test"] }], setup: "./auth.mjs" },' : ""}
  baseURL: "https://example.test",
  ${options.evidence === true ? 'evidence: { retention: "failures-only", masks: [{ id: "account-name", selector: "[data-private=name]", routeIds: ["home"], stateIds: ["success"], count: 1 }] },' : ""}
  routes: [{ id: "home", path: ${JSON.stringify(options.routePath ?? "/?token=secret#private")}, states: [{ id: "success", setup: "./scenario.mjs" }] }],
  themes: ["light"],
  viewports: { desktop: { height: 900, width: 1440 } },
};\n`,
    "utf8",
  );
  const imported = (await import(`${pathToFileURL(configPath).href}?fixture=${Date.now()}`)) as {
    readonly default: Parameters<typeof guardConfiguration>[0];
  };
  const configuration = await guardConfiguration(
    parseConfig(imported.default),
    configPath,
    project,
  );
  const contract: UIWitnessContract = {
    configDigest: contractConfigDigest(configuration),
    coordinates: configuration.map((coordinate) => ({
      ...coordinate,
      expected: { status: "passed" as const },
    })),
    schemaVersion: 1,
  };
  const contractPath = join(project, "uiwitness.contract.json");
  await writeFile(contractPath, `${JSON.stringify(contract, null, 2)}\n`, "utf8");
  return { configPath, contractPath, project, scenarioPath };
}

function report(
  configuration: readonly ContractConfigurationCoordinate[],
  status: "failed" | "passed",
  failureCode = "ASSERTION_FAILED",
): UIWitnessReport {
  const coordinate = configuration[0]!;
  const passed = status === "passed";
  const covered = passed ? 1 : 0;
  return parseReport({
    executions: [{
      diagnostics: {
        consoleErrors: [],
        failedRequests: [],
        navigationStatus: 200,
        pageErrors: [],
      },
      durationMs: 17,
      failures: passed
        ? []
        : [{ code: failureCode, message: "Expected heading." }],
      routeId: coordinate.routeId,
      routePath: coordinate.routePath,
      scenarioSource: coordinate.scenarioSource,
      screenshotPath: passed
        ? ".uiwitness/artifacts/home/success/desktop-light.png"
        : null,
      stateId: coordinate.stateId,
      status,
      theme: coordinate.theme,
      url: "https://example.test/?token=secret#private",
      viewport: coordinate.viewport,
      viewportId: coordinate.viewportId,
    }],
    generatedAt: "2026-09-03T12:00:00.000Z",
    project: { baseURL: "https://example.test" },
    schemaVersion: 1,
    summary: {
      coverage: {
        execution: { covered, percentage: covered * 100, total: 1 },
        responsive: { covered, percentage: covered * 100, total: 1 },
        state: { covered, percentage: covered * 100, total: 1 },
        theme: { covered, percentage: covered * 100, total: 1 },
      },
      durationMs: 17,
      executions: 1,
      failed: passed ? 0 : 1,
      passed: passed ? 1 : 0,
      routes: 1,
      states: 1,
    },
  });
}

function privacyReport(
  configuration: readonly ContractConfigurationCoordinate[],
  status: "failed" | "passed",
  screenshot: { readonly path: string; readonly status: "captured" } |
    { readonly status: "capture-failed" | "omitted-by-policy" },
  retention: "failures-only" | "none" = "failures-only",
): AnyUIWitnessReport {
  const coordinate = configuration[0]!;
  const passed = status === "passed";
  const covered = passed ? 1 : 0;
  return parseAnyReport({
    evidence: { retention },
    executions: [{
      diagnostics: {
        consoleErrors: [],
        failedRequests: [],
        navigationStatus: 200,
        pageErrors: [],
      },
      durationMs: 17,
      failures: passed ? [] : [{ code: "ASSERTION_FAILED", message: "Expected heading." }],
      routeId: coordinate.routeId,
      routePath: coordinate.routePath,
      scenarioSource: coordinate.scenarioSource,
      screenshot,
      stateId: coordinate.stateId,
      status,
      theme: coordinate.theme,
      url: "https://example.test/",
      viewport: coordinate.viewport,
      viewportId: coordinate.viewportId,
    }],
    generatedAt: "2026-09-03T12:00:00.000Z",
    project: { baseURL: "https://example.test" },
    schemaVersion: 2,
    summary: {
      coverage: {
        execution: { covered, percentage: covered * 100, total: 1 },
        responsive: { covered, percentage: covered * 100, total: 1 },
        state: { covered, percentage: covered * 100, total: 1 },
        theme: { covered, percentage: covered * 100, total: 1 },
      },
      durationMs: 17,
      executions: 1,
      failed: passed ? 0 : 1,
      passed: passed ? 1 : 0,
      routes: 1,
      states: 1,
    },
  });
}

function mockRunReport(value: AnyUIWitnessReport, once = false): void {
  const implementation = async (
    _cells: unknown,
    options: {
      readonly finalizeGeneration?: ((report: AnyUIWitnessReport) => unknown) | undefined;
      readonly projectDirectory: string;
    },
  ) => {
    const finalization = await options.finalizeGeneration?.(value) as {
      readonly artifacts?: readonly {
        readonly contents: string | Uint8Array;
        readonly path: string;
        readonly publication: "exclusive" | "immutable" | "replace";
      }[];
    } | undefined;
    for (const artifact of finalization?.artifacts ?? []) {
      const path = join(options.projectDirectory, ...artifact.path.split("/"));
      await mkdir(dirname(path), { recursive: true });
      if (artifact.publication === "immutable") {
        try {
          const existing = await readFile(path);
          if (!existing.equals(Buffer.from(artifact.contents))) {
            throw new Error(`Immutable test artifact changed: ${artifact.path}`);
          }
          continue;
        } catch (error: unknown) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
      }
      await writeFile(path, artifact.contents, {
        flag: artifact.publication === "replace" ? "w" : "wx",
        mode: 0o600,
      });
    }
    return {
      htmlReportPath: ".uiwitness/report/index.html",
      report: value,
      reportPath: ".uiwitness/report/uiwitness.json",
    };
  };
  if (once) {
    runPersistedScenarioCellsMock.mockImplementationOnce(implementation);
  } else {
    runPersistedScenarioCellsMock.mockImplementation(implementation);
  }
}

async function writeKnownFailureContract(
  value: GuardFixture,
  options: {
    readonly createdOn?: string;
    readonly expiresOn?: string;
    readonly failureCodes?: readonly string[];
  } = {},
): Promise<void> {
  const contract = JSON.parse(
    await readFile(value.contractPath, "utf8"),
  ) as Record<string, unknown> & { coordinates: Array<Record<string, unknown>> };
  contract.coordinates[0]!["expected"] = {
    exception: {
      createdOn: options.createdOn ?? "2026-09-01",
      expiresOn: options.expiresOn ?? "2026-09-30",
      owner: "quality-team",
      reason: "Tracked by UIW-1842.",
    },
    failureCodes: options.failureCodes ?? ["ASSERTION_FAILED"],
    status: "failed",
  };
  await writeFile(
    value.contractPath,
    `${JSON.stringify(contract, null, 2)}\n`,
    "utf8",
  );
}

async function fixtureConfiguration(value: GuardFixture): Promise<readonly ContractConfigurationCoordinate[]> {
  const imported = (await import(`${pathToFileURL(value.configPath).href}?config=${Date.now()}`)) as {
    readonly default: Parameters<typeof guardConfiguration>[0];
  };
  return guardConfiguration(parseConfig(imported.default), value.configPath, value.project);
}

beforeEach(() => {
  runPersistedScenarioCellsMock.mockReset();
});

afterEach(async () => {
  await Promise.all(projects.splice(0).map((project) =>
    rm(project, { force: true, recursive: true })
  ));
});

describe("guardProject", () => {
  it("initializes an all-pass contract and proposes failed initial states", async () => {
    const passing = await fixture();
    const passingConfiguration = await fixtureConfiguration(passing);
    await rm(passing.contractPath);
    mockRunReport(report(passingConfiguration, "passed"), true);

    await expect(initContract({
      cwd: passing.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    })).resolves.toMatchObject({
      contractPath: "uiwitness.contract.json",
      status: "created",
    });
    expect(JSON.parse(await readFile(passing.contractPath, "utf8")))
      .toMatchObject({ coordinates: [{ expected: { status: "passed" } }] });

    const failing = await fixture();
    const failingConfiguration = await fixtureConfiguration(failing);
    await rm(failing.contractPath);
    mockRunReport(report(failingConfiguration, "failed"), true);

    const result = await initContract({
      cwd: failing.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    expect(result).toMatchObject({ status: "proposal" });
    expect(result.proposalPath).toMatch(
      /^\.uiwitness\/contract-candidates\/[a-f0-9]{64}\.proposal\.json$/u,
    );
    await expect(access(failing.contractPath)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("runs one complete fresh matrix and publishes deterministic private verdict JSON", async () => {
    const value = await fixture();
    const configuration = await fixtureConfiguration(value);
    const clock = vi.fn(() => new Date("2026-09-03T12:00:00.000Z"));
    mockRunReport(report(configuration, "passed"));

    const result = await guardProject({
      cwd: value.project,
      jsonPath: "machine/verdict.json",
      now: clock,
    });

    expect(result.comparison).toMatchObject({
      complete: true,
      evaluatedOn: "2026-09-03",
      verdict: "passed",
    });
    expect(result.machineVerdict).toMatchObject({
      complete: true,
      schemaVersion: 1,
      verdict: "passed",
    });
    expect(runPersistedScenarioCellsMock).toHaveBeenCalledOnce();
    expect(clock).toHaveBeenCalledOnce();
    expect(runPersistedScenarioCellsMock.mock.calls[0]![0]).toHaveLength(1);
    expect(runPersistedScenarioCellsMock.mock.calls[0]![1]).toEqual({
      baseURL: "https://example.test",
      finalizeGeneration: expect.any(Function),
      projectDirectory: value.project,
      scenarioBaseDirectory: value.project,
    });

    const defaultJson = await readFile(
      join(value.project, ...DEFAULT_GUARD_VERDICT_PATH.split("/")),
      "utf8",
    );
    const explicitJson = await readFile(
      join(value.project, "machine", "verdict.json"),
      "utf8",
    );
    expect(explicitJson).toBe(defaultJson);
    expect(defaultJson.endsWith("\n")).toBe(true);
    expect(JSON.parse(defaultJson)).toEqual(result.machineVerdict);
    if (process.platform !== "win32") {
      expect((await stat(join(value.project, "machine", "verdict.json"))).mode & 0o777)
        .toBe(0o600);
    }
  });

  it("locks config-fingerprint v1 and the semantic run digest to fixed vectors", async () => {
    const value = await fixture();
    const configuration = await fixtureConfiguration(value);
    const completedReport = report(configuration, "passed");

    expect(configuration[0]!.configFingerprint).toBe(
      "sha256:32bf5d713eb274706576a0a083a89dc05df287716e29ffd6201000129d37359c",
    );
    expect(guardRunDigest(configuration, completedReport)).toBe(
      "sha256:c50d804d6fcc78c6ff11276fcccd56387fdb6cba611fe94e9d568b1d0bc2e6f6",
    );
    const hostSpecificReport = parseReport({
      ...completedReport,
      executions: completedReport.executions.map((execution) => ({
        ...execution,
        durationMs: 9_999,
        url: "https://different.test/?credential=private#fragment",
      })),
      generatedAt: "2030-01-01T00:00:00.000Z",
      project: { baseURL: "https://different.test" },
      summary: { ...completedReport.summary, durationMs: 9_999 },
    });
    expect(guardRunDigest(configuration, hostSpecificReport)).toBe(
      guardRunDigest(configuration, completedReport),
    );
  });

  it("locks authenticated coordinates to fingerprint v2 without secret values", async () => {
    const value = await fixture({ authentication: true });
    const configuration = await fixtureConfiguration(value);

    expect(configuration[0]!.configFingerprint).toBe(
      "sha256:b14cc03197d0df02d3631666a10a7fef5a187aaa1d1c5704d51ae6ea1efb52d1",
    );
    expect(JSON.stringify(configuration)).not.toContain("SECRET");
    mockRunReport(report(configuration, "passed"));

    await guardProject({
      cwd: value.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    expect(runPersistedScenarioCellsMock.mock.calls[0]![1]).toMatchObject({
      authentication: {
        baseURL: "https://example.test",
        config: {
          mode: "shared-readonly",
          setup: "./auth.mjs",
        },
        setupBaseDirectory: value.project,
      },
    });
  });

  it("includes canonical evidence policy in fingerprint v2 and runner options", async () => {
    const value = await fixture({ evidence: true });
    const configuration = await fixtureConfiguration(value);
    expect(configuration[0]!.configFingerprint).not.toBe(
      "sha256:32bf5d713eb274706576a0a083a89dc05df287716e29ffd6201000129d37359c",
    );
    mockRunReport(report(configuration, "passed"));

    await guardProject({
      cwd: value.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    expect(runPersistedScenarioCellsMock.mock.calls[0]![1]).toMatchObject({
      evidence: {
        masks: [{
          count: 1,
          id: "account-name",
          required: true,
          routeIds: ["home"],
          selector: "[data-private=name]",
          stateIds: ["success"],
        }],
        retention: "failures-only",
      },
    });
  });

  it("canonicalizes evidence ordering and fingerprints every privacy-policy change", async () => {
    const project = await temporaryProject("uiwitness-cli-guard-evidence-fingerprint-");
    const configPath = join(project, "uiwitness.config.mjs");
    await Promise.all([
      writeFile(configPath, "export default {};\n", "utf8"),
      writeFile(join(project, "home.mjs"), "export default {};\n", "utf8"),
      writeFile(join(project, "settings.mjs"), "export default {};\n", "utf8"),
    ]);
    const base = {
      baseURL: "https://example.test",
      routes: [
        { id: "home", path: "/", states: [{ id: "success", setup: "./home.mjs" }] },
        { id: "settings", path: "/settings", states: [{ id: "empty", setup: "./settings.mjs" }] },
      ],
      themes: ["light"],
      viewports: { desktop: { height: 900, width: 1_440 } },
    } as const;
    const privateMask = {
      count: 1,
      id: "private",
      routeIds: ["home", "settings"],
      selector: "[data-private]",
      stateIds: ["success", "empty"],
    } as const;
    const tokenMask = { id: "token", selector: "[data-token]" } as const;
    const primary = await guardConfiguration(parseConfig({
      ...base,
      evidence: { masks: [privateMask, tokenMask], retention: "failures-only" },
    }), configPath, project);
    const permuted = await guardConfiguration(parseConfig({
      ...base,
      evidence: {
        masks: [tokenMask, {
          ...privateMask,
          routeIds: ["settings", "home"],
          stateIds: ["empty", "success"],
        }],
        retention: "failures-only",
      },
    }), configPath, project);
    const changedRetention = await guardConfiguration(parseConfig({
      ...base,
      evidence: { masks: [privateMask, tokenMask], retention: "none" },
    }), configPath, project);
    const changedSelector = await guardConfiguration(parseConfig({
      ...base,
      evidence: {
        masks: [{ ...privateMask, selector: "[data-private-alt]" }, tokenMask],
        retention: "failures-only",
      },
    }), configPath, project);

    expect(permuted.map(({ configFingerprint }) => configFingerprint)).toEqual(
      primary.map(({ configFingerprint }) => configFingerprint),
    );
    expect(changedRetention[0]!.configFingerprint).not.toBe(
      primary[0]!.configFingerprint,
    );
    expect(changedSelector[0]!.configFingerprint).not.toBe(
      primary[0]!.configFingerprint,
    );
    const semanticMaskChanges = [
      { ...privateMask, id: "private-alt" },
      { ...privateMask, count: 2 },
      { ...privateMask, required: false },
      { ...privateMask, routeIds: undefined },
      { ...privateMask, stateIds: undefined },
    ];
    for (const changedMask of semanticMaskChanges) {
      const changed = await guardConfiguration(parseConfig({
        ...base,
        evidence: {
          masks: [changedMask, tokenMask],
          retention: "failures-only",
        },
      }), configPath, project);
      expect(changed[0]!.configFingerprint).not.toBe(
        primary[0]!.configFingerprint,
      );
    }
  });

  it("projects every schema-v2 screenshot state into guard evidence identity", async () => {
    const value = await fixture({ evidence: true });
    const configuration = await fixtureConfiguration(value);
    const path = ".uiwitness/artifacts/home/success/desktop-light.png";
    const captured = privacyReport(configuration, "failed", {
      path,
      status: "captured",
    });
    const captureFailed = privacyReport(configuration, "failed", {
      status: "capture-failed",
    });
    const omitted = privacyReport(configuration, "failed", {
      status: "omitted-by-policy",
    }, "none");

    const capturedDigest = guardRunDigest(configuration, captured);
    const captureFailedDigest = guardRunDigest(configuration, captureFailed);
    expect(capturedDigest).not.toBe(captureFailedDigest);
    expect(guardRunDigest(configuration, omitted)).toBe(captureFailedDigest);
  });

  it("normalizes execution, failure, diagnostic, and request ordering in run digests", async () => {
    const value = await fixture();
    const primary = (await fixtureConfiguration(value))[0]!;
    const secondary: ContractConfigurationCoordinate = Object.freeze({
      ...primary,
      id: "home/alternate/desktop/light",
      scenarioSource: "./alternate.mjs",
      stateId: "alternate",
    });
    const configuration = [primary, secondary];
    const executions = configuration.map((coordinate, index) => ({
      diagnostics: {
        consoleErrors: index === 0 ? ["z-console", "a-console"] : ["middle-console"],
        failedRequests: index === 0
          ? [
              { errorText: "z-error", method: "POST", url: "https://example.test/z" },
              { errorText: "a-error", method: "GET", url: "https://example.test/a" },
            ]
          : [],
        navigationStatus: index === 0 ? 503 : 200,
        pageErrors: index === 0 ? ["z-page", "a-page"] : ["middle-page"],
      },
      durationMs: index + 10,
      failures: index === 0
        ? [
            { code: "PAGE_ERROR", message: "Page failed." },
            { code: "ASSERTION_FAILED", message: "Assertion failed." },
            { code: "PAGE_ERROR", message: "Page failed again." },
          ]
        : [{ code: "FAILED_REQUEST", message: "Request failed." }],
      routeId: coordinate.routeId,
      routePath: coordinate.routePath,
      scenarioSource: coordinate.scenarioSource,
      screenshotPath: null,
      stateId: coordinate.stateId,
      status: "failed" as const,
      theme: coordinate.theme,
      url: "https://example.test/private?token=value#fragment",
      viewport: coordinate.viewport,
      viewportId: coordinate.viewportId,
    }));
    const summary = {
      coverage: {
        execution: { covered: 0, percentage: 0, total: 2 },
        responsive: { covered: 0, percentage: 0, total: 2 },
        state: { covered: 0, percentage: 0, total: 2 },
        theme: { covered: 0, percentage: 0, total: 2 },
      },
      durationMs: 21,
      executions: 2,
      failed: 2,
      passed: 0,
      routes: 1,
      states: 2,
    };
    const original = parseReport({
      executions,
      generatedAt: "2026-09-03T12:00:00.000Z",
      project: { baseURL: "https://example.test" },
      schemaVersion: 1,
      summary,
    });
    const permuted = parseReport({
      executions: [...executions].reverse().map((execution) => ({
        ...execution,
        diagnostics: {
          ...execution.diagnostics,
          consoleErrors: [...execution.diagnostics.consoleErrors].reverse(),
          failedRequests: [...execution.diagnostics.failedRequests].reverse(),
          pageErrors: [...execution.diagnostics.pageErrors].reverse(),
        },
        failures: [...execution.failures].reverse(),
      })),
      generatedAt: "2030-01-01T00:00:00.000Z",
      project: { baseURL: "https://different.test" },
      schemaVersion: 1,
      summary,
    });

    const digest = guardRunDigest(configuration, original);
    expect(digest).toBe(
      "sha256:a25354f70afa07dc31ffc32b95be44ac97bee8d2c2a47568e4cc85d5f0c57570",
    );
    expect(guardRunDigest([...configuration].reverse(), permuted)).toBe(digest);

    const changed = parseReport({
      ...original,
      executions: original.executions.map((execution, index) => index === 0
        ? {
            ...execution,
            diagnostics: {
              ...execution.diagnostics,
              pageErrors: [...execution.diagnostics.pageErrors, "new-page-error"],
            },
          }
        : execution),
    });
    expect(guardRunDigest(configuration, changed)).not.toBe(digest);
  });

  it("returns regression exit data with a shell-safe exact-coordinate command", async () => {
    const value = await fixture({
      configDirectory: "config dir",
      configFilename: "team's config.mjs",
    });
    const configuration = await fixtureConfiguration(value);
    mockRunReport(report(configuration, "failed"));

    const result = await guardProject({
      configPath: "config dir/team's config.mjs",
      cwd: value.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });

    expect(result.comparison.verdict).toBe("failed");
    expect(result.comparison.findings).toEqual([
      expect.objectContaining({
        id: "home/success/desktop/light",
        kind: "regression",
      }),
    ]);
    expect(result.machineVerdict.findings).toEqual([
      expect.objectContaining({
        remediate: expect.stringContaining(
          "contract inspect --candidate .uiwitness/contract-candidates/",
        ),
        reproduce: guardReproduceCommand(
          "home/success/desktop/light",
          "config dir/team's config.mjs",
        ),
      }),
    ]);
    expect(result.proposalPath).toMatch(
      /^\.uiwitness\/contract-candidates\/[a-f0-9]{64}\.proposal\.json$/u,
    );
    expect(result.metadataPath).toMatch(
      /^\.uiwitness\/contract-candidates\/[a-f0-9]{64}\.metadata\.json$/u,
    );

    await annotateContractChange({
      candidatePath: result.proposalPath!,
      changeId: "expectation:home/success/desktop/light",
      createdOn: "2026-09-03",
      cwd: value.project,
      expiresOn: "2026-09-17",
      owner: "quality-team",
      reason: "UIW-2041 tracks repair",
    });
    const annotatedMetadata = await readFile(
      join(value.project, ...result.metadataPath!.split("/")),
      "utf8",
    );
    const repeated = await guardProject({
      configPath: "config dir/team's config.mjs",
      cwd: value.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    expect(repeated.proposalPath).toBe(result.proposalPath);
    expect(await readFile(
      join(value.project, ...result.metadataPath!.split("/")),
      "utf8",
    )).toBe(annotatedMetadata);
  });

  it("quotes POSIX commands and emits one encoded command safe in Windows shells", () => {
    const configPath = "config dir/team's config.mjs";
    expect(
      guardReproduceCommand(
        "home/success/desktop/light",
        configPath,
        "posix",
      ),
    ).toBe(
      "./node_modules/.bin/uiwitness scan --coordinate home/success/desktop/light --headed --config 'config dir/team'\"'\"'s config.mjs'",
    );
    const windowsCommand = guardReproduceCommand(
      "home/success/desktop/light",
      "config dir/& % ! team's config.mjs",
      "windows",
    );
    expect(windowsCommand).toMatch(
      /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/u,
    );
    const encoded = windowsCommand.split(" ").at(-1)!;
    expect(Buffer.from(encoded, "base64").toString("utf16le")).toBe(
      "& 'node_modules\\.bin\\uiwitness.cmd' 'scan' '--coordinate' 'home/success/desktop/light' '--headed' '--config' 'config dir/& % ! team''s config.mjs'; exit $LASTEXITCODE",
    );
    const remediation = guardRemediateCommand(
      "expectation:home/success/desktop/light",
      "candidate dir/team's proposal.json",
      "windows",
    );
    expect(remediation).toMatch(
      /^powershell\.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand [A-Za-z0-9+/=]+$/u,
    );
    expect(Buffer.from(remediation.split(" ").at(-1)!, "base64").toString("utf16le"))
      .toBe("& 'node_modules\\.bin\\uiwitness.cmd' 'contract' 'inspect' '--candidate' 'candidate dir/team''s proposal.json' '--change' 'expectation:home/success/desktop/light'; exit $LASTEXITCODE");
  });

  it("preserves an explicit config basename beginning with two dashes", async () => {
    const value = await fixture({ configFilename: "--team.mjs" });
    const configuration = await fixtureConfiguration(value);
    mockRunReport(report(configuration, "failed"));

    const result = await guardProject({
      configPath: "./--team.mjs",
      cwd: value.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });

    expect(result.machineVerdict.findings).toEqual([
      expect.objectContaining({
        reproduce: guardReproduceCommand(
          "home/success/desktop/light",
          "./--team.mjs",
        ),
      }),
    ]);
  });

  it.each([
    ["changed-known-failure", "failed", "PAGE_ERROR"],
    ["recovered-known-failure", "passed", "ASSERTION_FAILED"],
  ] as const)("adds an exact-coordinate command for %s", async (
    kind,
    status,
    failureCode,
  ) => {
    const value = await fixture();
    const configuration = await fixtureConfiguration(value);
    await writeKnownFailureContract(value);
    mockRunReport(report(configuration, status, failureCode));

    const result = await guardProject({
      cwd: value.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });

    expect(result.comparison.findings).toEqual([
      expect.objectContaining({ kind }),
    ]);
    expect(result.machineVerdict.findings).toEqual([
      expect.objectContaining({
        reproduce: guardReproduceCommand(
          "home/success/desktop/light",
          undefined,
        ),
      }),
    ]);
  });

  it("omits reproduction when a known-failure exception has expired", async () => {
    const value = await fixture();
    const configuration = await fixtureConfiguration(value);
    await writeKnownFailureContract(value, { expiresOn: "2026-09-02" });
    mockRunReport(report(configuration, "failed"));

    const result = await guardProject({
      cwd: value.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });

    expect(result.comparison.findings).toContainEqual(
      expect.objectContaining({ kind: "expired-exception" }),
    );
    expect(result.machineVerdict.findings).toHaveLength(2);
    for (const finding of result.machineVerdict.findings) {
      expect(finding).not.toEqual(
        expect.objectContaining({ reproduce: expect.anything() }),
      );
    }
  });

  it.each([
    ["exact failure", "failed", "ASSERTION_FAILED", "exception"],
    ["changed failure", "failed", "PAGE_ERROR", "expectation"],
    ["recovered failure", "passed", "ASSERTION_FAILED", "expectation"],
  ] as const)("offers only the valid %s lifecycle operation", async (
    _label,
    status,
    failureCode,
    operation,
  ) => {
    const value = await fixture();
    const configuration = await fixtureConfiguration(value);
    await writeKnownFailureContract(value, { expiresOn: "2026-09-02" });
    mockRunReport(report(configuration, status, failureCode), true);

    const result = await guardProject({
      cwd: value.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });

    const proposal = parseContractProposal(await readFile(
      join(value.project, result.proposalPath!),
      "utf8",
    ));
    expect(proposal.changes.map(({ id }) => id)).toEqual([
      `${operation}:home/success/desktop/light`,
    ]);
    expect(result.machineVerdict.findings[0]).toMatchObject({
      expected: {
        exception: {
          createdOn: "2026-09-01",
          expiresOn: "2026-09-02",
          owner: "quality-team",
          reason: "Tracked by UIW-1842.",
        },
      },
      kind: "expired-exception",
    });
  });

  it("fails closed when the fresh report is incomplete", async () => {
    const value = await fixture();
    mockRunReport(parseReport({
        executions: [],
        generatedAt: "2026-09-03T12:00:00.000Z",
        project: { baseURL: "https://example.test" },
        schemaVersion: 1,
        summary: {
          coverage: {
            execution: { covered: 0, percentage: 0, total: 0 },
            responsive: { covered: 0, percentage: 0, total: 0 },
            state: { covered: 0, percentage: 0, total: 0 },
            theme: { covered: 0, percentage: 0, total: 0 },
          },
          durationMs: 0,
          executions: 0,
          failed: 0,
          passed: 0,
          routes: 0,
          states: 0,
        },
      }));

    const result = await guardProject({
      cwd: value.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });

    expect(result.comparison).toMatchObject({ complete: false, verdict: "error" });
    expect(result.comparison.findings).toEqual([{
      id: null,
      kind: "run-error",
      reasons: ["declared-incomplete"],
    }]);
  });

  it("rejects equal-length duplicate and unexpected execution identities", async () => {
    const value = await fixture();
    const primary = (await fixtureConfiguration(value))[0]!;
    const secondary: ContractConfigurationCoordinate = {
      ...primary,
      id: "home/alternate/desktop/light",
      stateId: "alternate",
    };
    const completed = report([primary], "passed");
    const execution = completed.executions[0]!;
    const duplicate = {
      ...completed,
      executions: [execution, execution],
    } as unknown as UIWitnessReport;
    const unexpected = {
      ...completed,
      executions: [
        execution,
        { ...execution, stateId: "unexpected" },
      ],
    } as unknown as UIWitnessReport;

    expect(reportIsComplete([primary, secondary], duplicate)).toBe(false);
    expect(reportIsComplete([primary, secondary], unexpected)).toBe(false);
  });

  it("classifies an unaccepted current-config fingerprint change as drift", async () => {
    const value = await fixture();
    const configuration = await fixtureConfiguration(value);
    const contract = JSON.parse(
      await readFile(value.contractPath, "utf8"),
    ) as UIWitnessContract;
    const staleCoordinates = contract.coordinates.map((coordinate) => ({
      ...coordinate,
      configFingerprint:
        `sha256:${"f".repeat(64)}` as ContractConfigurationCoordinate["configFingerprint"],
    }));
    const staleContract = {
      ...contract,
      configDigest: contractConfigDigest(staleCoordinates),
      coordinates: staleCoordinates,
    };
    await writeFile(
      value.contractPath,
      `${JSON.stringify(staleContract, null, 2)}\n`,
      "utf8",
    );
    mockRunReport(report(configuration, "passed"));

    const result = await guardProject({
      cwd: value.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });

    expect(result.comparison).toMatchObject({ complete: true, verdict: "failed" });
    expect(result.comparison.findings).toEqual([
      expect.objectContaining({
        id: "home/success/desktop/light",
        kind: "unaccepted-config-drift",
      }),
    ]);
    expect(result.machineVerdict.findings).toEqual([
      expect.not.objectContaining({ reproduce: expect.anything() }),
    ]);
  });

  it("rejects unsafe inputs and existing explicit JSON before browser launch", async () => {
    const value = await fixture();
    const outside = await temporaryProject("uiwitness-cli-guard-outside-");
    await writeFile(join(value.project, "existing.json"), "keep", "utf8");
    const cases = [
      guardProject({ configPath: join(outside, "config.mjs"), cwd: value.project }),
      guardProject({ contractPath: join(outside, "contract.json"), cwd: value.project }),
      guardProject({ cwd: value.project, jsonPath: "existing.json" }),
      guardProject({ configPath: "bad\nconfig.mjs", cwd: value.project }),
      guardProject({ cwd: value.project, jsonPath: ".uiwitness/contract.lock" }),
    ];

    const errors = await Promise.all(cases.map((promise) =>
      promise.catch((error: unknown) => error)
    ));
    expect(errors[0]).toMatchObject({ code: "GUARD_CONFIG_PATH_INVALID" });
    expect(errors[1]).toMatchObject({ code: "GUARD_CONTRACT_PATH_INVALID" });
    expect(errors[2]).toMatchObject({ code: "GUARD_JSON_EXISTS" });
    expect(errors[3]).toMatchObject({ code: "GUARD_CONFIG_PATH_INVALID" });
    expect(errors[4]).toMatchObject({ code: "GUARD_JSON_PATH_INVALID" });
    expect(errors.every((error) => error instanceof GuardError)).toBe(true);
    expect(runPersistedScenarioCellsMock).not.toHaveBeenCalled();
  });

  it("holds the contract writer lock from contract snapshot through publication", async () => {
    const value = await fixture();
    await mkdir(join(value.project, ".uiwitness"));
    await writeFile(join(value.project, ".uiwitness/contract.lock"), "busy\n");

    await expect(guardProject({ cwd: value.project })).rejects.toMatchObject({
      code: "GUARD_CONTRACT_LOCKED",
    });
    expect(runPersistedScenarioCellsMock).not.toHaveBeenCalled();
  });

  it("rejects symbolic-link scenario boundaries before browser launch", async () => {
    const value = await fixture();
    const realScenario = join(value.project, "real-scenario.mjs");
    await writeFile(realScenario, "export default {};\n", "utf8");
    await rm(value.scenarioPath);
    await symlink(realScenario, value.scenarioPath);

    const error = await guardProject({ cwd: value.project }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({ code: "GUARD_SCENARIO_PATH_INVALID" });
    expect(runPersistedScenarioCellsMock).not.toHaveBeenCalled();
    await expect(access(join(value.project, ".uiwitness"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects symbolic-link config, contract, and output boundaries", async () => {
    const configFixture = await fixture();
    const realConfig = join(configFixture.project, "real-config.mjs");
    await writeFile(realConfig, await readFile(configFixture.configPath, "utf8"), "utf8");
    await rm(configFixture.configPath);
    await symlink(realConfig, configFixture.configPath);

    const contractFixture = await fixture();
    const realContract = join(contractFixture.project, "real-contract.json");
    await writeFile(
      realContract,
      await readFile(contractFixture.contractPath, "utf8"),
      "utf8",
    );
    await rm(contractFixture.contractPath);
    await symlink(realContract, contractFixture.contractPath);

    const outputFixture = await fixture();
    const outputDirectory = join(outputFixture.project, "real-output");
    await mkdir(outputDirectory);
    await symlink(outputDirectory, join(outputFixture.project, "output-link"));

    const errors = await Promise.all([
      guardProject({ cwd: configFixture.project }).catch((error: unknown) => error),
      guardProject({ cwd: contractFixture.project }).catch((error: unknown) => error),
      guardProject({
        cwd: outputFixture.project,
        jsonPath: "output-link/verdict.json",
      }).catch((error: unknown) => error),
    ]);

    expect(errors).toEqual([
      expect.objectContaining({ code: "GUARD_CONFIG_PATH_INVALID" }),
      expect.objectContaining({ code: "GUARD_CONTRACT_PATH_INVALID" }),
      expect.objectContaining({ code: "GUARD_JSON_PATH_INVALID" }),
    ]);
    expect(runPersistedScenarioCellsMock).not.toHaveBeenCalled();
  });

  it("rejects hard-linked config, contract, scenario, and default output files", async () => {
    const configFixture = await fixture();
    const configSource = join(configFixture.project, "hard-config-source.mjs");
    await writeFile(configSource, await readFile(configFixture.configPath, "utf8"), "utf8");
    await rm(configFixture.configPath);
    await link(configSource, configFixture.configPath);

    const contractFixture = await fixture();
    const contractSource = join(contractFixture.project, "hard-contract-source.json");
    await writeFile(
      contractSource,
      await readFile(contractFixture.contractPath, "utf8"),
      "utf8",
    );
    await rm(contractFixture.contractPath);
    await link(contractSource, contractFixture.contractPath);

    const scenarioFixture = await fixture();
    const scenarioSource = join(scenarioFixture.project, "hard-scenario-source.mjs");
    await writeFile(scenarioSource, "export default {};\n", "utf8");
    await rm(scenarioFixture.scenarioPath);
    await link(scenarioSource, scenarioFixture.scenarioPath);

    const outputFixture = await fixture();
    const outputDirectory = join(outputFixture.project, ".uiwitness");
    const outputSource = join(outputFixture.project, "hard-output-source.json");
    await mkdir(outputDirectory);
    await writeFile(outputSource, "keep", "utf8");
    await link(
      outputSource,
      join(outputFixture.project, ...DEFAULT_GUARD_VERDICT_PATH.split("/")),
    );

    const errors = await Promise.all([
      guardProject({ cwd: configFixture.project }).catch((error: unknown) => error),
      guardProject({ cwd: contractFixture.project }).catch((error: unknown) => error),
      guardProject({ cwd: scenarioFixture.project }).catch((error: unknown) => error),
      guardProject({ cwd: outputFixture.project }).catch((error: unknown) => error),
    ]);

    expect(errors).toEqual([
      expect.objectContaining({ code: "GUARD_CONFIG_PATH_INVALID" }),
      expect.objectContaining({ code: "GUARD_CONTRACT_PATH_INVALID" }),
      expect.objectContaining({ code: "GUARD_SCENARIO_PATH_INVALID" }),
      expect.objectContaining({ code: "GUARD_JSON_PATH_INVALID" }),
    ]);
    expect(runPersistedScenarioCellsMock).not.toHaveBeenCalled();
  });

  it("does not change permissions on an existing explicit-output directory", async () => {
    if (process.platform === "win32") return;
    const value = await fixture();
    const configuration = await fixtureConfiguration(value);
    const outputDirectory = join(value.project, "machine");
    await mkdir(outputDirectory, { mode: 0o755 });
    await chmod(outputDirectory, 0o755);
    mockRunReport(report(configuration, "passed"));

    await guardProject({
      cwd: value.project,
      jsonPath: "machine/verdict.json",
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });

    expect((await stat(outputDirectory)).mode & 0o777).toBe(0o755);
    expect((await stat(join(outputDirectory, "verdict.json"))).mode & 0o777)
      .toBe(0o600);
  });

  it("refuses a missing default contract before browser launch", async () => {
    const value = await fixture();
    await rm(value.contractPath);

    const error = await guardProject({ cwd: value.project }).catch(
      (cause: unknown) => cause,
    );

    expect(error).toMatchObject({ code: "GUARD_CONTRACT_NOT_FOUND" });
    expect(runPersistedScenarioCellsMock).not.toHaveBeenCalled();
  });

  it("rejects an invalid contract before browser launch or output creation", async () => {
    const value = await fixture();
    await writeFile(
      value.contractPath,
      '{"schemaVersion":2,"configDigest":"invalid","coordinates":[]}',
      "utf8",
    );

    await expect(guardProject({ cwd: value.project })).rejects.toMatchObject({
      name: "ContractValidationError",
    });
    expect(runPersistedScenarioCellsMock).not.toHaveBeenCalled();
    await expect(access(join(value.project, ".uiwitness"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a structurally valid future-created exception before browser launch", async () => {
    const value = await fixture();
    await writeKnownFailureContract(value, {
      createdOn: "2026-09-04",
      expiresOn: "2026-09-30",
    });

    await expect(guardProject({
      cwd: value.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    })).rejects.toMatchObject({ name: "ContractValidationError" });
    expect(runPersistedScenarioCellsMock).not.toHaveBeenCalled();
    await expect(access(join(value.project, ".uiwitness"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("keeps private route values out of fingerprints and verdict output", async () => {
    const value = await fixture({ routePath: "/search?token=secret#private" });
    const configuration = await fixtureConfiguration(value);
    const alternate = await fixture({
      routePath: "/search?token=a-different-value#another-fragment",
    });
    const alternateConfiguration = await fixtureConfiguration(alternate);
    expect(configuration[0]!.routePath).toBe("/search?token=%5BREDACTED%5D");
    expect(alternateConfiguration[0]!.configFingerprint).toBe(
      configuration[0]!.configFingerprint,
    );
    mockRunReport(report(configuration, "passed"));

    await guardProject({
      cwd: value.project,
      now: () => new Date("2026-09-03T12:00:00.000Z"),
    });
    const output = await readFile(
      join(value.project, ...DEFAULT_GUARD_VERDICT_PATH.split("/")),
      "utf8",
    );
    expect(output).not.toContain("secret");
    expect(output).not.toContain("private");
  });
});
