import { describe, expect, it } from "vitest";

import {
  REPORT_SCHEMA_VERSION,
  PRIVACY_REPORT_SCHEMA_VERSION,
  ReportValidationError,
  ResultValidationError,
  expandMatrix,
  parseConfig,
  parseExecutionResult,
  parseAnyReport,
  parseReport,
  screenshotArtifactPath,
  serializeReport,
  type ExecutionResult,
  type UIWitnessReport,
  type UIWitnessReportV2,
} from "../src/index.js";

const cells = expandMatrix(
  parseConfig({
    baseURL: "http://localhost:3000",
    routes: [
      {
        id: "dashboard",
        path: "/dashboard",
        states: [
          {
            id: "success",
            setup: "./uiwitness/scenarios/dashboard/success.ts",
          },
        ],
      },
    ],
    themes: ["light"],
    viewports: {
      desktop: { height: 1000, width: 1440 },
      mobile: { height: 844, width: 390 },
    },
  }),
);
const legacyScreenshotPath =
  ".statecraft/artifacts/dashboard/success/desktop-light.png";

function result(
  index: number,
  status: "failed" | "passed",
): ExecutionResult {
  const cell = cells[index]!;
  return {
    diagnostics: {
      consoleErrors: [],
      failedRequests:
        status === "failed"
          ? [
              {
                errorText: "net::ERR_CONNECTION_RESET",
                method: "GET",
                url: "http://localhost:3000/api/dashboard",
              },
            ]
          : [],
      navigationStatus: 200,
      pageErrors: [],
    },
    durationMs: index === 0 ? 120 : 80,
    failures:
      status === "failed"
        ? [{ code: "FAILED_REQUEST", message: "Dashboard request failed." }]
        : [],
    routeId: cell.route.id,
    routePath: cell.route.path,
    scenarioSource: cell.state.setup,
    screenshotPath: screenshotArtifactPath(cell),
    stateId: cell.state.id,
    status,
    theme: cell.theme,
    url: "http://localhost:3000/dashboard",
    viewport: cell.viewport,
    viewportId: cell.viewportId,
  };
}

function validReport(): UIWitnessReport {
  return {
    executions: [result(0, "passed"), result(1, "failed")],
    generatedAt: "2026-08-19T14:30:00.000Z",
    project: { baseURL: "http://localhost:3000" },
    schemaVersion: REPORT_SCHEMA_VERSION,
    summary: {
      coverage: {
        execution: { covered: 1, percentage: 50, total: 2 },
        responsive: { covered: 0, percentage: 0, total: 1 },
        state: { covered: 1, percentage: 100, total: 1 },
        theme: { covered: 1, percentage: 100, total: 1 },
      },
      durationMs: 200,
      executions: 2,
      failed: 1,
      passed: 1,
      routes: 1,
      states: 1,
    },
  };
}

function validPrivacyReport(
  retention: "failures-only" | "none" = "failures-only",
): UIWitnessReportV2 {
  const source = validReport();
  return {
    evidence: { retention },
    executions: source.executions.map((execution) => {
      const { screenshotPath, ...rest } = execution;
      return {
        ...rest,
        screenshot: retention === "none" || execution.status === "passed"
          ? { status: "omitted-by-policy" as const }
          : { path: screenshotPath!, status: "captured" as const },
      };
    }),
    generatedAt: source.generatedAt,
    project: source.project,
    schemaVersion: PRIVACY_REPORT_SCHEMA_VERSION,
    summary: source.summary,
  };
}

function withCredentials(
  value: string,
  username = "user",
  password = "secret",
): string {
  const url = new URL(value);
  url.username = username;
  url.password = password;
  return url.href;
}

function captureResultError(input: unknown): ResultValidationError {
  try {
    parseExecutionResult(input);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ResultValidationError);
    return error as ResultValidationError;
  }
  throw new Error("Expected execution result validation to fail.");
}

function captureReportError(input: unknown): ReportValidationError {
  try {
    parseReport(input);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ReportValidationError);
    return error as ReportValidationError;
  }
  throw new Error("Expected report validation to fail.");
}

function captureAnyReportError(input: unknown): ReportValidationError {
  try {
    parseAnyReport(input);
  } catch (error: unknown) {
    expect(error).toBeInstanceOf(ReportValidationError);
    return error as ReportValidationError;
  }
  throw new Error("Expected report validation to fail.");
}

describe("parseExecutionResult", () => {
  it("parses a complete browser-independent execution record", () => {
    expect(parseExecutionResult(result(0, "passed"))).toEqual(
      result(0, "passed"),
    );
  });

  it("accepts a failed execution without a screenshot or navigation response", () => {
    const failed = result(1, "failed");
    const withoutUnavailableArtifacts = {
      ...failed,
      diagnostics: { ...failed.diagnostics, navigationStatus: null },
      screenshotPath: null,
    };

    expect(parseExecutionResult(withoutUnavailableArtifacts)).toEqual(
      withoutUnavailableArtifacts,
    );
  });

  it("requires failures to agree with status and screenshots for passes", () => {
    const passedWithFailure = {
      ...result(0, "passed"),
      failures: [{ code: "ASSERTION_FAILED", message: "Expected heading." }],
    };
    const failedWithoutFailure = {
      ...result(1, "failed"),
      failures: [],
    };
    const passedWithoutScreenshot = {
      ...result(0, "passed"),
      screenshotPath: null,
    };

    expect(captureResultError(passedWithFailure).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.failures" }),
      ]),
    );
    expect(captureResultError(failedWithoutFailure).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.failures" }),
      ]),
    );
    expect(captureResultError(passedWithoutScreenshot).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.screenshotPath" }),
      ]),
    );
  });

  it("validates a screenshot path against explicit coordinate metadata", () => {
    const forged = {
      ...result(0, "passed"),
      screenshotPath:
        ".uiwitness/artifacts/dashboard/success/mobile-light.png",
    };

    expect(captureResultError(forged).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_value",
          path: "$.screenshotPath",
        }),
      ]),
    );
  });

  it("keeps legacy evidence paths out of the writer contract", () => {
    const legacy = {
      ...result(0, "passed"),
      screenshotPath: legacyScreenshotPath,
    };

    expect(captureResultError(legacy).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.screenshotPath" }),
      ]),
    );
  });

  it("rejects unsafe or ill-formed diagnostic data", () => {
    const withHeaders = structuredClone(result(1, "failed")) as unknown as Record<
      string,
      unknown
    >;
    const diagnostics = withHeaders["diagnostics"] as {
      failedRequests: Array<Record<string, unknown>>;
    };
    diagnostics.failedRequests[0]!["headers"] = {
      authorization: "Bearer secret",
    };

    const error = captureResultError(withHeaders);
    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "unrecognized_key",
          path: "$.diagnostics.failedRequests[0]",
        }),
      ]),
    );
  });

  it.each([
    ["negative duration", { durationMs: -1 }, "$.durationMs"],
    ["invalid navigation status", {
      diagnostics: { ...result(0, "passed").diagnostics, navigationStatus: 700 },
    }, "$.diagnostics.navigationStatus"],
    ["non-HTTP URL", { url: "file:///tmp/report.html" }, "$.url"],
    ["malformed URL", { url: "https://[::1" }, "$.url"],
    ["absolute route URL", { routePath: "https://example.com/dashboard" }, "$.routePath"],
    ["protocol-relative route URL", { routePath: "//example.com/dashboard" }, "$.routePath"],
    ["unknown failure code", {
      failures: [{ code: "TOKEN_LEAKED", message: "No." }],
      status: "failed",
    }, "$.failures[0].code"],
  ])("rejects %s", (_label, replacement, expectedPath) => {
    const error = captureResultError({ ...result(0, "passed"), ...replacement });

    expect(error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expectedPath })]),
    );
  });

  it("removes credentials and fragments and redacts every URL query value", () => {
    const execution = result(0, "passed");
    const parsed = parseExecutionResult({
      ...execution,
      diagnostics: {
        ...execution.diagnostics,
        failedRequests: [
          {
            errorText: "net::ERR_FAILED",
            method: "GET",
            url: withCredentials(
              "https://example.com/data?token=secret&tab=orders#debug",
              "api-user",
              "api-secret",
            ),
          },
        ],
      },
      routePath: "/dashboard?access_token=secret&tab=orders#debug",
      url: withCredentials(
        "https://example.com/dashboard?access_token=secret&tab=orders#debug",
      ),
    });

    expect(parsed.routePath).toBe(
      "/dashboard?access_token=%5BREDACTED%5D&tab=%5BREDACTED%5D",
    );
    expect(parsed.url).toBe(
      "https://example.com/dashboard?access_token=%5BREDACTED%5D&tab=%5BREDACTED%5D",
    );
    expect(parsed.diagnostics.failedRequests[0]?.url).toBe(
      "https://example.com/data?token=%5BREDACTED%5D&tab=%5BREDACTED%5D",
    );
  });

  it("sanitizes a dirty URL that has no query string", () => {
    const parsed = parseExecutionResult({
      ...result(0, "passed"),
      url: withCredentials("https://example.com/dashboard#debug"),
    });

    expect(parsed.url).toBe("https://example.com/dashboard");
  });
});

describe("parseReport", () => {
  it("parses schema version 1 with internally consistent summaries", () => {
    expect(parseReport(validReport())).toEqual(validReport());
  });

  it("reads legacy schema-v1 screenshot paths without rewriting them", () => {
    const report = validReport();
    const parsed = parseReport({
      ...report,
      executions: [
        { ...report.executions[0], screenshotPath: legacyScreenshotPath },
        report.executions[1],
      ],
    });

    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.executions[0]!.screenshotPath).toBe(legacyScreenshotPath);
    expect(serializeReport(parsed)).toContain(legacyScreenshotPath);
  });

  it.each([
    ".other/artifacts/dashboard/success/desktop-light.png",
    ".uiwitness/artifacts/dashboard/success/../desktop-light.png",
    legacyScreenshotPath.replace("desktop-light.png", "../desktop-light.png"),
  ])("rejects unsupported or traversing report screenshot path %s", (path) => {
    const report = validReport();
    const error = captureReportError({
      ...report,
      executions: [
        { ...report.executions[0], screenshotPath: path },
        report.executions[1],
      ],
    });

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.executions[0].screenshotPath" }),
      ]),
    );
  });

  it("rejects unsupported schema versions at a stable path", () => {
    const error = captureReportError({
      ...validReport(),
      schemaVersion: 3,
    });

    expect(error.code).toBe("REPORT_INVALID");
    expect(error.message).toBe("Invalid UIWitness report.");
    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "invalid_value",
          path: "$.schemaVersion",
        }),
      ]),
    );
  });

  it("rejects malformed generation times and unknown report properties", () => {
    const error = captureReportError({
      ...validReport(),
      generatedAt: "yesterday",
      telemetry: true,
    });

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.generatedAt" }),
        expect.objectContaining({
          code: "unrecognized_key",
          path: "$",
        }),
      ]),
    );
  });

  it("sanitizes credentials, query values, and fragments in the project base URL", () => {
    const report = validReport();
    const parsed = parseReport({
      ...report,
      project: {
        baseURL: withCredentials(
          "https://example.com/app?access_token=secret#debug",
        ),
      },
    });

    expect(parsed.project.baseURL).toBe(
      "https://example.com/app?access_token=%5BREDACTED%5D",
    );
  });

  it.each([
    ["execution count", { executions: 3 }, "$.summary.executions"],
    ["pass count", { passed: 2 }, "$.summary.passed"],
    ["failure count", { failed: 0 }, "$.summary.failed"],
    ["duration", { durationMs: 201 }, "$.summary.durationMs"],
    ["route count", { routes: 2 }, "$.summary.routes"],
    ["state count", { states: 2 }, "$.summary.states"],
  ])("rejects an inconsistent %s", (_label, replacement, expectedPath) => {
    const report = validReport();
    const error = captureReportError({
      ...report,
      summary: { ...report.summary, ...replacement },
    });

    expect(error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expectedPath })]),
    );
  });

  it("rejects mathematically invalid and execution-inconsistent coverage", () => {
    const report = validReport();
    const error = captureReportError({
      ...report,
      summary: {
        ...report.summary,
        coverage: {
          ...report.summary.coverage,
          execution: { covered: 2, percentage: 50, total: 2 },
        },
      },
    });

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.summary.coverage.execution.percentage",
        }),
        expect.objectContaining({
          path: "$.summary.coverage.execution",
        }),
      ]),
    );
  });

  it("rejects coverage numerators larger than their configured totals", () => {
    const report = validReport();
    const error = captureReportError({
      ...report,
      summary: {
        ...report.summary,
        coverage: {
          ...report.summary.coverage,
          execution: { covered: 1, percentage: 0, total: 0 },
        },
      },
    });

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: "$.summary.coverage.execution.covered",
        }),
      ]),
    );
  });

  it("rejects duplicate execution coordinates", () => {
    const report = validReport();
    const duplicate = result(0, "failed");
    const error = captureReportError({
      ...report,
      executions: [result(0, "passed"), duplicate],
      summary: {
        ...report.summary,
        durationMs: 240,
      },
    });

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: "duplicate",
          path: "$.executions[1]",
        }),
      ]),
    );
  });

  it.each([
    ["route path", { routePath: "/other" }, "$.executions[1].routePath"],
    [
      "scenario source",
      { scenarioSource: "./scenarios/other.ts" },
      "$.executions[1].scenarioSource",
    ],
  ])("rejects conflicting %s metadata", (_label, replacement, expectedPath) => {
    const report = validReport();
    const conflicting = { ...report.executions[1]!, ...replacement };
    const error = captureReportError({
      ...report,
      executions: [report.executions[0], conflicting],
    });

    expect(error.issues).toEqual(
      expect.arrayContaining([expect.objectContaining({ path: expectedPath })]),
    );
  });

  it("rejects conflicting dimensions for a shared viewport id", () => {
    const report = validReport();
    const base = result(0, "failed");
    const viewport = { height: 900, width: 1440 };
    const conflicting: ExecutionResult = {
      ...base,
      scenarioSource: "./uiwitness/scenarios/dashboard/error.ts",
      screenshotPath: screenshotArtifactPath({
        route: {
          id: "dashboard",
          path: "/dashboard",
          states: [
            {
              id: "error",
              setup: "./uiwitness/scenarios/dashboard/error.ts",
            },
          ],
        },
        state: {
          id: "error",
          setup: "./uiwitness/scenarios/dashboard/error.ts",
        },
        theme: "light",
        viewport,
        viewportId: "desktop",
      }),
      stateId: "error",
      viewport,
    };
    const error = captureReportError({
      ...report,
      executions: [...report.executions, conflicting],
    });

    expect(error.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "$.executions[2].viewport" }),
      ]),
    );
  });

  it("accepts a zero-execution report with zero-valued metrics", () => {
    const zero = { covered: 0, percentage: 0, total: 0 };
    const report: UIWitnessReport = {
      executions: [],
      generatedAt: "2026-08-19T14:30:00.000Z",
      project: { baseURL: "http://localhost:3000" },
      schemaVersion: REPORT_SCHEMA_VERSION,
      summary: {
        coverage: {
          execution: zero,
          responsive: zero,
          state: zero,
          theme: zero,
        },
        durationMs: 0,
        executions: 0,
        failed: 0,
        passed: 0,
        routes: 0,
        states: 0,
      },
    };

    expect(parseReport(report)).toEqual(report);
  });

  it("freezes validation issue collections", () => {
    const error = captureReportError(null);

    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(Object.isFrozen(error.issues[0])).toBe(true);
  });
});

describe("parseAnyReport privacy invariants", () => {
  it("accepts consistent none and failures-only reports while the legacy reader rejects v2", () => {
    expect(parseAnyReport(validPrivacyReport("none"))).toEqual(
      validPrivacyReport("none"),
    );
    expect(parseAnyReport(validPrivacyReport("failures-only"))).toEqual(
      validPrivacyReport("failures-only"),
    );
    expect(() => parseReport(validPrivacyReport())).toThrow(ReportValidationError);
  });

  it.each([
    ["none with captured bytes", "none", 0, { path: ".uiwitness/artifacts/dashboard/success/desktop-light.png", status: "captured" }],
    ["passing failures-only capture", "failures-only", 0, { path: ".uiwitness/artifacts/dashboard/success/desktop-light.png", status: "captured" }],
    ["failed failures-only omission", "failures-only", 1, { status: "omitted-by-policy" }],
    ["passed capture failure", "failures-only", 0, { status: "capture-failed" }],
    ["wrong captured path", "failures-only", 1, { path: ".uiwitness/artifacts/dashboard/success/desktop-light.png", status: "captured" }],
    ["missing captured path", "failures-only", 1, { status: "captured" }],
  ] as const)("rejects %s", (_label, retention, index, screenshot) => {
    const report = structuredClone(validPrivacyReport(retention));
    const executions = [...report.executions];
    executions[index] = {
      ...report.executions[index]!,
      screenshot,
    } as never;

    expect(captureAnyReportError({ ...report, executions }).issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: expect.stringContaining(`$.executions[${index}].screenshot`),
        }),
      ]),
    );
  });
});

describe("serializeReport", () => {
  it("produces deterministic, pretty, newline-terminated JSON", () => {
    const report = validReport();
    const first = serializeReport(report);
    const reordered: UIWitnessReport = {
      summary: {
        states: report.summary.states,
        routes: report.summary.routes,
        passed: report.summary.passed,
        failed: report.summary.failed,
        executions: report.summary.executions,
        durationMs: report.summary.durationMs,
        coverage: {
          theme: report.summary.coverage.theme,
          state: report.summary.coverage.state,
          responsive: report.summary.coverage.responsive,
          execution: {
            total: report.summary.coverage.execution.total,
            percentage: report.summary.coverage.execution.percentage,
            covered: report.summary.coverage.execution.covered,
          },
        },
      },
      project: report.project,
      generatedAt: report.generatedAt,
      executions: report.executions,
      schemaVersion: report.schemaVersion,
    };
    const second = serializeReport(reordered);

    expect(first).toBe(second);
    expect(first.endsWith("\n")).toBe(true);
    expect(first.startsWith('{\n  "schemaVersion": 1,')).toBe(true);
    expect(parseReport(JSON.parse(first))).toEqual(report);
  });

  it("refuses to serialize a forged inconsistent typed report", () => {
    const report = validReport();
    const forged = {
      ...report,
      summary: { ...report.summary, passed: 99 },
    } as UIWitnessReport;

    expect(() => serializeReport(forged)).toThrow(ReportValidationError);
  });

  it("redacts unsafe URLs at the final serialization boundary", () => {
    const report = validReport();
    const execution = report.executions[0]!;
    const unsafe = {
      ...report,
      executions: [
        {
          ...execution,
          url: withCredentials(
            "https://example.com/dashboard?token=secret#debug",
          ),
        },
        report.executions[1]!,
      ],
      project: {
        baseURL: withCredentials(
          "https://example.com?token=secret#debug",
        ),
      },
    } as UIWitnessReport;

    const serialized = serializeReport(unsafe);

    expect(serialized).not.toContain("secret");
    expect(serialized).not.toContain("#debug");
    expect(serialized).toContain("token=%5BREDACTED%5D");
  });
});
