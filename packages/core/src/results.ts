import { z, type ZodIssue } from "zod";

import {
  screenshotArtifactPath,
  type ReportScreenshotArtifactPath,
  type ScreenshotArtifactPath,
} from "./artifacts.js";
import type { CoverageSummary } from "./coverage.js";
import { calculateCoverage } from "./coverage.js";
import {
  ReportValidationError,
  ResultValidationError,
  type ConfigValidationIssueCode,
  type ReportValidationIssue,
  type ResultValidationIssue,
} from "./errors.js";
import type { MatrixCell } from "./matrix.js";

/** The current external JSON report contract version. */
export const REPORT_SCHEMA_VERSION = 1 as const;
/** Report version used when screenshot retention intentionally omits bytes. */
export const PRIVACY_REPORT_SCHEMA_VERSION = 2 as const;

/** @internal Stable failure codes reused by validated execution projections. */
export const EXECUTION_FAILURE_CODES = [
  "ASSERTION_FAILED",
  "CONSOLE_ERROR",
  "FAILED_REQUEST",
  "INTERNAL_ERROR",
  "MASK_APPLY_FAILED",
  "MASK_CARDINALITY_MISMATCH",
  "MASK_REQUIRED_MISSING",
  "MASK_SELECTOR_INVALID",
  "NAVIGATION_FAILED",
  "PAGE_ERROR",
  "SCREENSHOT_FAILED",
] as const;

/** Stable failure classifications persisted in execution records. */
export type ExecutionFailureCode = (typeof EXECUTION_FAILURE_CODES)[number];

const executionStatuses = ["failed", "passed"] as const;

/** The terminal status of one configured execution. */
export type ExecutionStatus = (typeof executionStatuses)[number];

/** A failure that caused an execution to be marked failed. */
export interface ExecutionFailure {
  readonly code: ExecutionFailureCode;
  readonly message: string;
}

/** Sanitized metadata for a request that failed before receiving a response. */
export interface FailedRequestDiagnostic {
  readonly errorText: string;
  readonly method: string;
  readonly url: string;
}

/** Diagnostics captured during one execution without sensitive request data. */
export interface ExecutionDiagnostics {
  readonly consoleErrors: readonly string[];
  readonly failedRequests: readonly FailedRequestDiagnostic[];
  readonly navigationStatus: number | null;
  readonly pageErrors: readonly string[];
}

/** The persisted outcome for one configured execution cell. */
export interface ExecutionResult {
  readonly diagnostics: ExecutionDiagnostics;
  readonly durationMs: number;
  readonly failures: readonly ExecutionFailure[];
  readonly routeId: string;
  readonly routePath: string;
  readonly scenarioSource: string;
  readonly screenshotPath: ScreenshotArtifactPath | null;
  readonly stateId: string;
  readonly status: ExecutionStatus;
  readonly theme: string;
  readonly url: string;
  readonly viewport: {
    readonly height: number;
    readonly width: number;
  };
  readonly viewportId: string;
}

/** One schema-v1 execution read from either supported evidence root. */
export interface ReportExecutionResult
  extends Omit<ExecutionResult, "screenshotPath"> {
  readonly screenshotPath: ReportScreenshotArtifactPath | null;
}

/** Explicit screenshot outcome used by privacy-aware schema-v2 reports. */
export type ReportScreenshot =
  | { readonly path: ReportScreenshotArtifactPath; readonly status: "captured" }
  | { readonly status: "capture-failed" }
  | { readonly status: "omitted-by-policy" };

/** One schema-v2 execution with intentional omission separated from failure. */
export interface ReportExecutionResultV2
  extends Omit<ExecutionResult, "screenshotPath"> {
  readonly screenshot: ReportScreenshot;
  readonly screenshotPath?: never;
}

/** One execution from either supported external report version. */
export type AnyReportExecutionResult =
  | ReportExecutionResult
  | ReportExecutionResultV2;

/** Aggregate metrics stored in a report and checked against its executions. */
export interface ReportSummary {
  readonly coverage: CoverageSummary;
  readonly durationMs: number;
  readonly executions: number;
  readonly failed: number;
  readonly passed: number;
  readonly routes: number;
  readonly states: number;
}

/** Version 1 of UIWitness's external JSON report. Retained for source compatibility. */
export interface UIWitnessReport {
  readonly schemaVersion: typeof REPORT_SCHEMA_VERSION;
  readonly generatedAt: string;
  readonly project: {
    readonly baseURL: string;
  };
  readonly summary: ReportSummary;
  readonly executions: readonly ReportExecutionResult[];
  readonly evidence?: never;
}

/** Explicit name for the source-compatible schema-v1 report. */
export type UIWitnessReportV1 = UIWitnessReport;

/** Version 2 makes privacy-driven screenshot omission explicit. */
export interface UIWitnessReportV2 {
  readonly schemaVersion: typeof PRIVACY_REPORT_SCHEMA_VERSION;
  readonly evidence: {
    readonly retention: "failures-only" | "none";
  };
  readonly generatedAt: string;
  readonly project: {
    readonly baseURL: string;
  };
  readonly summary: ReportSummary;
  readonly executions: readonly ReportExecutionResultV2[];
}

/** Every report version accepted by the current reader. */
export type AnyUIWitnessReport = UIWitnessReportV1 | UIWitnessReportV2;

const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const identifierMessage =
  "IDs must use lowercase letters or numbers separated by single hyphens.";
const redactedQueryValue = "[REDACTED]";
const identifierSchema = z.string().regex(identifierPattern, identifierMessage);
const nonEmptyStringSchema = z.string().refine((value) => value.trim().length > 0, {
  message: "Values cannot be empty.",
});

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function redactUrl(url: URL): void {
  url.username = "";
  url.password = "";
  url.hash = "";

  if (url.search.length > 0) {
    const redacted = new URLSearchParams();
    for (const [key] of url.searchParams) {
      redacted.append(key, redactedQueryValue);
    }
    url.search = redacted.toString();
  }
}

function sanitizeHttpUrl(value: string): string {
  const url = new URL(value);
  if (
    url.username.length === 0 &&
    url.password.length === 0 &&
    url.search.length === 0 &&
    url.hash.length === 0
  ) {
    return value;
  }

  redactUrl(url);
  return url.href;
}

function isLocalRoutePath(value: string): boolean {
  const referenceBase = new URL("https://uiwitness.invalid");
  try {
    return (
      value.startsWith("/") &&
      new URL(value, referenceBase).origin === referenceBase.origin
    );
  } catch {
    return false;
  }
}

function sanitizeRoutePath(value: string): string {
  const referenceBase = new URL("https://uiwitness.invalid");
  const url = new URL(value, referenceBase);
  if (url.search.length === 0 && url.hash.length === 0) {
    return value;
  }

  redactUrl(url);
  return `${url.pathname}${url.search}`;
}

const httpUrlSchema = z.string().url().refine(isHttpUrl, {
  message: "URLs must use the http or https protocol.",
}).transform(sanitizeHttpUrl);
const routePathSchema = z.string().refine(isLocalRoutePath, {
  message: "Route paths must be local and start with '/'.",
}).transform(sanitizeRoutePath);
const durationSchema = z.number().int().nonnegative();
const viewportSchema = z.strictObject({
  height: z.number().int().positive(),
  width: z.number().int().positive(),
});
const failureCodeSchema = z.enum(EXECUTION_FAILURE_CODES);
const failureSchema = z.strictObject({
  code: failureCodeSchema,
  message: nonEmptyStringSchema,
});
const failedRequestSchema = z.strictObject({
  errorText: nonEmptyStringSchema,
  method: nonEmptyStringSchema,
  url: httpUrlSchema,
});
const diagnosticsSchema = z.strictObject({
  consoleErrors: z.array(nonEmptyStringSchema),
  failedRequests: z.array(failedRequestSchema),
  navigationStatus: z.number().int().min(100).max(599).nullable(),
  pageErrors: z.array(nonEmptyStringSchema),
});

function matrixCellFor(result: {
  readonly routeId: string;
  readonly routePath: string;
  readonly scenarioSource: string;
  readonly stateId: string;
  readonly theme: string;
  readonly viewport: { readonly height: number; readonly width: number };
  readonly viewportId: string;
}): MatrixCell {
  const state = { id: result.stateId, setup: result.scenarioSource };
  return {
    route: { id: result.routeId, path: result.routePath, states: [state] },
    state,
    theme: result.theme,
    viewport: result.viewport,
    viewportId: result.viewportId,
  };
}

const executionResultShape = {
    diagnostics: diagnosticsSchema,
    durationMs: durationSchema,
    failures: z.array(failureSchema),
    routeId: identifierSchema,
    routePath: routePathSchema,
    scenarioSource: nonEmptyStringSchema,
    screenshotPath: z.string().nullable(),
    stateId: identifierSchema,
    status: z.enum(executionStatuses),
    theme: identifierSchema,
    url: httpUrlSchema,
    viewport: viewportSchema,
    viewportId: identifierSchema,
  } as const;

const {
  screenshotPath: _screenshotPathSchema,
  ...executionResultV2Shape
} = executionResultShape;
void _screenshotPathSchema;
const reportScreenshotSchema = z.discriminatedUnion("status", [
  z.strictObject({ path: z.string(), status: z.literal("captured") }),
  z.strictObject({ status: z.literal("capture-failed") }),
  z.strictObject({ status: z.literal("omitted-by-policy") }),
]);

function validateExecutionResult(
  result: z.infer<ReturnType<typeof executionResultObjectSchema>>,
  context: z.RefinementCtx,
  allowLegacyScreenshotRoot: boolean,
): void {
    if (result.status === "passed" && result.failures.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Passed executions cannot contain failures.",
        path: ["failures"],
      });
    }
    if (result.status === "failed" && result.failures.length === 0) {
      context.addIssue({
        code: "custom",
        message: "Failed executions must contain at least one failure.",
        path: ["failures"],
      });
    }
    if (result.status === "passed" && result.screenshotPath === null) {
      context.addIssue({
        code: "custom",
        message: "Passed executions must include a screenshot path.",
        path: ["screenshotPath"],
      });
    }
    const expectedPath = screenshotArtifactPath(matrixCellFor(result));
    const legacyPath = legacyScreenshotPath(expectedPath);
    if (
      result.screenshotPath !== null &&
      result.screenshotPath !== expectedPath &&
      (!allowLegacyScreenshotRoot || result.screenshotPath !== legacyPath)
    ) {
      context.addIssue({
        code: "custom",
        message: "Screenshot path does not match the execution coordinate.",
        path: ["screenshotPath"],
      });
    }
}

function executionResultObjectSchema() {
  return z.strictObject(executionResultShape);
}

function legacyScreenshotPath(expectedPath: string): string {
  return expectedPath.replace(/^\.uiwitness\//u, ".statecraft/");
}

const executionResultSchema = executionResultObjectSchema().superRefine(
  (result, context) => validateExecutionResult(result, context, false),
);
const reportExecutionResultSchema = executionResultObjectSchema().superRefine(
  (result, context) => validateExecutionResult(result, context, true),
);
const reportExecutionResultV2Schema = z.strictObject({
  ...executionResultV2Shape,
  screenshot: reportScreenshotSchema,
}).superRefine((result, context) => {
  if (result.status === "passed" && result.failures.length > 0) {
    context.addIssue({
      code: "custom",
      message: "Passed executions cannot contain failures.",
      path: ["failures"],
    });
  }
  if (result.status === "failed" && result.failures.length === 0) {
    context.addIssue({
      code: "custom",
      message: "Failed executions must contain at least one failure.",
      path: ["failures"],
    });
  }
  if (result.status === "passed" && result.screenshot.status === "capture-failed") {
    context.addIssue({
      code: "custom",
      message: "Passed executions cannot have a failed screenshot capture.",
      path: ["screenshot", "status"],
    });
  }
  if (result.screenshot.status === "captured") {
    const expectedPath = screenshotArtifactPath(matrixCellFor(result));
    const legacyPath = legacyScreenshotPath(expectedPath);
    if (result.screenshot.path !== expectedPath && result.screenshot.path !== legacyPath) {
      context.addIssue({
        code: "custom",
        message: "Screenshot path does not match the execution coordinate.",
        path: ["screenshot", "path"],
      });
    }
  }
});

const coverageMetricSchema = z
  .strictObject({
    covered: z.number().int().nonnegative(),
    percentage: z.number().min(0).max(100),
    total: z.number().int().nonnegative(),
  })
  .superRefine((metric, context) => {
    if (metric.covered > metric.total) {
      context.addIssue({
        code: "custom",
        message: "Coverage cannot exceed its configured total.",
        path: ["covered"],
      });
    }
    const expectedPercentage =
      metric.total === 0
        ? 0
        : Math.round((metric.covered * 10_000) / metric.total) / 100;
    if (metric.percentage !== expectedPercentage) {
      context.addIssue({
        code: "custom",
        message: "Coverage percentage must match covered and total.",
        path: ["percentage"],
      });
    }
  });
const coverageSummarySchema = z.strictObject({
  execution: coverageMetricSchema,
  responsive: coverageMetricSchema,
  state: coverageMetricSchema,
  theme: coverageMetricSchema,
});
const reportSummarySchema = z.strictObject({
  coverage: coverageSummarySchema,
  durationMs: durationSchema,
  executions: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  passed: z.number().int().nonnegative(),
  routes: z.number().int().nonnegative(),
  states: z.number().int().nonnegative(),
});

type ReportValidationExecution = Omit<ExecutionResult, "screenshotPath">;

function coordinateKey(result: ReportValidationExecution): string {
  return JSON.stringify([
    result.routeId,
    result.stateId,
    result.viewportId,
    result.theme,
  ]);
}

function stateKey(result: ReportValidationExecution): string {
  return JSON.stringify([result.routeId, result.stateId]);
}

function addSummaryIssue(
  context: z.RefinementCtx,
  path: readonly PropertyKey[],
  message: string,
): void {
  context.addIssue({ code: "custom", message, path: [...path] });
}

function validateReport(
  report: {
    readonly executions: readonly ReportValidationExecution[];
    readonly summary: ReportSummary;
  },
  context: z.RefinementCtx,
): void {
    const executions = report.executions;
    const coordinates = new Set<string>();
    const routePaths = new Map<string, string>();
    const scenarioSources = new Map<string, string>();
    const viewports = new Map<string, string>();
    executions.forEach((execution, index) => {
      const key = coordinateKey(execution);
      if (coordinates.has(key)) {
        context.addIssue({
          code: "custom",
          message: "Execution coordinates must be unique.",
          params: { uiwitnessIssueCode: "duplicate" },
          path: ["executions", index],
        });
      }
      coordinates.add(key);

      const knownRoutePath = routePaths.get(execution.routeId);
      if (
        knownRoutePath !== undefined &&
        knownRoutePath !== execution.routePath
      ) {
        context.addIssue({
          code: "custom",
          message: "A route id must use one route path throughout the report.",
          path: ["executions", index, "routePath"],
        });
      }
      routePaths.set(execution.routeId, execution.routePath);

      const routeStateKey = stateKey(execution);
      const knownScenarioSource = scenarioSources.get(routeStateKey);
      if (
        knownScenarioSource !== undefined &&
        knownScenarioSource !== execution.scenarioSource
      ) {
        context.addIssue({
          code: "custom",
          message:
            "A route/state pair must use one scenario source throughout the report.",
          path: ["executions", index, "scenarioSource"],
        });
      }
      scenarioSources.set(routeStateKey, execution.scenarioSource);

      const viewportDimensions = JSON.stringify(execution.viewport);
      const knownViewport = viewports.get(execution.viewportId);
      if (
        knownViewport !== undefined &&
        knownViewport !== viewportDimensions
      ) {
        context.addIssue({
          code: "custom",
          message:
            "A viewport id must use one set of dimensions throughout the report.",
          path: ["executions", index, "viewport"],
        });
      }
      viewports.set(execution.viewportId, viewportDimensions);
    });

    const passed = executions.filter(
      (execution) => execution.status === "passed",
    ).length;
    const expected = {
      durationMs: executions.reduce(
        (total, execution) => total + execution.durationMs,
        0,
      ),
      executions: executions.length,
      failed: executions.length - passed,
      passed,
      routes: new Set(executions.map((execution) => execution.routeId)).size,
      states: new Set(executions.map(stateKey)).size,
    };
    for (const [key, value] of Object.entries(expected)) {
      const summaryKey = key as keyof typeof expected;
      if (report.summary[summaryKey] !== value) {
        addSummaryIssue(
          context,
          ["summary", summaryKey],
          `Summary ${summaryKey} must match execution records.`,
        );
      }
    }

    const coverage = calculateCoverage(
      executions.map(matrixCellFor),
      executions.map((execution) => ({
        passed: execution.status === "passed",
        routeId: execution.routeId,
        stateId: execution.stateId,
        theme: execution.theme,
        viewportId: execution.viewportId,
      })),
    );
    for (const metricName of [
      "execution",
      "responsive",
      "state",
      "theme",
    ] as const) {
      if (
        JSON.stringify(report.summary.coverage[metricName]) !==
        JSON.stringify(coverage[metricName])
      ) {
        addSummaryIssue(
          context,
          ["summary", "coverage", metricName],
          `Summary ${metricName} coverage must match execution records.`,
        );
      }
    }
}

const reportSchemaV1 = z.strictObject({
  schemaVersion: z.literal(REPORT_SCHEMA_VERSION),
  generatedAt: z.string().datetime({ offset: true }),
  project: z.strictObject({ baseURL: httpUrlSchema }),
  summary: reportSummarySchema,
  executions: z.array(reportExecutionResultSchema),
}).superRefine(validateReport);

const reportSchemaV2 = z.strictObject({
  schemaVersion: z.literal(PRIVACY_REPORT_SCHEMA_VERSION),
  evidence: z.strictObject({
    retention: z.enum(["failures-only", "none"]),
  }),
  generatedAt: z.string().datetime({ offset: true }),
  project: z.strictObject({ baseURL: httpUrlSchema }),
  summary: reportSummarySchema,
  executions: z.array(reportExecutionResultV2Schema),
}).superRefine((report, context) => {
  validateReport(report, context);
  report.executions.forEach((execution, index) => {
    if (
      report.evidence.retention === "none" &&
      execution.screenshot.status !== "omitted-by-policy"
    ) {
      context.addIssue({
        code: "custom",
        message: "Retention 'none' requires every screenshot to be omitted by policy.",
        path: ["executions", index, "screenshot", "status"],
      });
    }
    if (
      report.evidence.retention === "failures-only" &&
      ((execution.status === "passed" && execution.screenshot.status !== "omitted-by-policy") ||
        (execution.status === "failed" && execution.screenshot.status === "omitted-by-policy"))
    ) {
      context.addIssue({
        code: "custom",
        message: "Failures-only retention must omit passing screenshots and retain failed capture outcomes.",
        path: ["executions", index, "screenshot", "status"],
      });
    }
  });
});

const reportSchema = z.discriminatedUnion("schemaVersion", [
  reportSchemaV1,
  reportSchemaV2,
]);

function formatIssuePath(path: readonly PropertyKey[]): string {
  const propertyPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === "number") {
      return `${formatted}[${segment}]`;
    }
    if (typeof segment === "string" && propertyPattern.test(segment)) {
      return `${formatted}.${segment}`;
    }
    return `${formatted}[${JSON.stringify(String(segment))}]`;
  }, "$");
}

function issueCode(issue: ZodIssue): ConfigValidationIssueCode {
  if (
    issue.code === "custom" &&
    issue.params?.["uiwitnessIssueCode"] === "duplicate"
  ) {
    return "duplicate";
  }
  if (issue.code === "invalid_type") {
    return "invalid_type";
  }
  if (issue.code === "unrecognized_keys") {
    return "unrecognized_key";
  }
  return "invalid_value";
}

function toIssue(issue: ZodIssue): ResultValidationIssue {
  return Object.freeze({
    code: issueCode(issue),
    message: issue.message,
    path: formatIssuePath(issue.path),
  });
}

/** Parses an unknown value into one safe, internally consistent execution result. */
export function parseExecutionResult(input: unknown): ExecutionResult {
  const result = executionResultSchema.safeParse(input);
  if (!result.success) {
    throw new ResultValidationError(result.error.issues.map(toIssue));
  }
  return result.data as ExecutionResult;
}

/** Parses an unknown value into the source-compatible schema-v1 report contract. */
export function parseReport(input: unknown): UIWitnessReport {
  const result = reportSchemaV1.safeParse(input);
  if (!result.success) {
    throw new ReportValidationError(
      result.error.issues.map(toIssue) as readonly ReportValidationIssue[],
    );
  }
  return result.data as UIWitnessReport;
}

/** Parses an unknown value into either supported versioned report contract. */
export function parseAnyReport(input: unknown): AnyUIWitnessReport {
  const schemaVersion = typeof input === "object" && input !== null
    ? (input as Record<string, unknown>)["schemaVersion"]
    : undefined;
  if (schemaVersion !== REPORT_SCHEMA_VERSION && schemaVersion !== PRIVACY_REPORT_SCHEMA_VERSION) {
    throw new ReportValidationError([{
      code: "invalid_value",
      message: "Unsupported report schema version.",
      path: "$.schemaVersion",
    }]);
  }
  const result = reportSchema.safeParse(input);
  if (!result.success) {
    throw new ReportValidationError(
      result.error.issues.map(toIssue) as readonly ReportValidationIssue[],
    );
  }
  return result.data as AnyUIWitnessReport;
}

/** Serializes a validated report as deterministic, newline-terminated JSON. */
export function serializeReport(report: AnyUIWitnessReport): string {
  return `${JSON.stringify(parseAnyReport(report), null, 2)}\n`;
}
