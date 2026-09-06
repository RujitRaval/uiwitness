import { randomUUID } from "node:crypto";
import { performance } from "node:perf_hooks";

import type {
  ExecutionDiagnostics,
  ExecutionFailure,
  ExecutionFailureCode,
  EvidenceConfig,
  EvidenceMaskConfig,
  FailurePolicy,
  MatrixCell,
} from "uiwitness-core";
import type { ConsoleMessage, Locator, Page, Request } from "playwright";

import type { CellExecutionOutcome } from "./lifecycle.js";
import {
  runNavigatedScenarioLifecycleCells,
  type NavigationMetadata,
  type RunNavigatedScenarioCellsOptions,
} from "./navigation.js";
import {
  ScenarioLoadError,
  type AssertionScenarioContext,
  type UIWitnessScenario,
} from "./scenario.js";

const maxDiagnosticLength = 2_000;
const maxDiagnosticsPerCategory = 100;
const maxDiagnosticUrlLength = 8_192;
const redactedValue = "[REDACTED]";
const authorizationPattern =
  /\bauthorization(\s*[:=]\s*)[^\n]*/giu;
const cookiePattern = /\b(cookie|set-cookie)(\s*[:=]\s*)[^\n]*/giu;
const sensitiveAssignmentPattern =
  /\b(password|passwd|secret|token|api[-_]?key)(\s*[:=]\s*)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu;
const bearerPattern = /\bBearer\s+[^\s,;]+/giu;
const embeddedHttpUrlPattern = /https?:\/\/[^\s<>"']+/giu;
const embeddedRouteUrlPattern = /(?<![:/])\/{1,2}[^\s<>"']*[?#][^\s<>"']*/giu;
const evidenceIdentifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;

/** Whether a scenario assertion ran and how it completed. */
export type AssertionStatus =
  | "failed"
  | "not-configured"
  | "not-run"
  | "passed";

/** Counts diagnostics omitted after the per-category memory cap is reached. */
export interface DroppedDiagnosticCounts {
  readonly consoleErrors: number;
  readonly failedRequests: number;
  readonly pageErrors: number;
}

/** One successfully resolved non-secret mask ID and its DOM cardinality. */
export interface AppliedEvidenceMask {
  readonly count: number;
  readonly id: string;
}

/** Explicit screenshot lifecycle state for retention-aware capture. */
export type EvidenceScreenshotStatus =
  | "capture-failed"
  | "captured"
  | "omitted-by-policy";

/** Evidence available after a capture succeeds or fails. */
export interface ScenarioCaptureEvidence {
  readonly assertionStatus: AssertionStatus;
  readonly diagnostics: ExecutionDiagnostics;
  readonly droppedDiagnostics: DroppedDiagnosticCounts;
  readonly durationMs: number;
  readonly masks: readonly AppliedEvidenceMask[];
  readonly navigation: NavigationMetadata | null;
  readonly screenshot: Uint8Array | null;
  readonly screenshotAttempted: boolean;
  readonly screenshotStatus: EvidenceScreenshotStatus;
}

/** Complete in-memory evidence for a successfully captured cell. */
export interface CapturedScenarioCell extends ScenarioCaptureEvidence {
  readonly assertionStatus: "not-configured" | "passed";
  readonly navigation: NavigationMetadata;
  readonly screenshot: Uint8Array;
  readonly screenshotStatus: "captured";
}

/** Successful cell whose screenshot bytes were intentionally not retained. */
export interface OmittedScenarioCell extends ScenarioCaptureEvidence {
  readonly assertionStatus: "not-configured" | "passed";
  readonly navigation: NavigationMetadata;
  readonly screenshot: null;
  readonly screenshotStatus: "omitted-by-policy";
}

export type CompletedScenarioCell = CapturedScenarioCell | OmittedScenarioCell;

/** Browser, readiness, and diagnostic-failure settings for capture. */
export interface RunCapturedScenarioCellsOptions
  extends RunNavigatedScenarioCellsOptions {
  readonly evidence?: (EvidenceConfig & { readonly retention?: "all" }) | undefined;
  readonly failOn?: FailurePolicy | undefined;
}

/** Capture settings whose retention policy can intentionally omit PNG bytes. */
export interface PrivacyRunCapturedScenarioCellsOptions
  extends Omit<RunCapturedScenarioCellsOptions, "evidence"> {
  readonly evidence: EvidenceConfig & {
    readonly retention: "failures-only" | "none";
  };
}

type AnyRunCapturedScenarioCellsOptions = Omit<
  RunCapturedScenarioCellsOptions,
  "evidence"
> & {
  readonly evidence?: EvidenceConfig | undefined;
};

/** Stable failure for invalid direct runner evidence-policy inputs. */
export class EvidencePolicyError extends Error {
  readonly code = "EVIDENCE_POLICY_INVALID" as const;

  constructor(message: string) {
    super(message);
    this.name = "EvidencePolicyError";
  }
}

/** A failed cell with sanitized failures and any evidence captured beforehand. */
export class ScenarioCaptureError extends Error {
  readonly evidence: ScenarioCaptureEvidence;
  readonly failures: readonly ExecutionFailure[];

  constructor(
    failures: readonly ExecutionFailure[],
    evidence: ScenarioCaptureEvidence,
    options?: ErrorOptions,
  ) {
    const safeFailures = Object.freeze(
      failures.map(({ code, message }) =>
        Object.freeze({ code, message: sanitizeDiagnosticText(message) }),
      ),
    );
    const safeOptions =
      options?.cause === undefined
        ? undefined
        : { cause: new Error(diagnosticErrorMessage(options.cause)) };
    super(
      `Scenario capture failed: ${safeFailures.map(({ code }) => code).join(", ")}.`,
      safeOptions,
    );
    this.name = "ScenarioCaptureError";
    this.evidence = evidence;
    this.failures = safeFailures;
  }
}

interface ResolvedFailurePolicy {
  readonly consoleError: boolean;
  readonly failedRequest: boolean;
  readonly pageError: boolean;
}

interface ResolvedEvidencePolicy {
  readonly masks: readonly EvidenceMaskConfig[];
  readonly retention: "all" | "failures-only" | "none";
}

function sanitizeHttpUrl(value: string): string | null {
  let url: URL;
  try {
    url = new URL(value.slice(0, maxDiagnosticUrlLength));
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    return null;
  }

  url.username = "";
  url.password = "";
  url.hash = "";
  if (url.search.length > 0) {
    const redacted = new URLSearchParams();
    for (const [key] of url.searchParams) {
      redacted.append(key, redactedValue);
    }
    url.search = redacted.toString();
  }
  return url.href.length <= maxDiagnosticUrlLength
    ? url.href
    : new URL("/__uiwitness_url_truncated__", url.origin).href;
}

function sanitizeEmbeddedUrl(value: string): string {
  const trailingPunctuationPattern = /[),.;}]+$/u;
  const punctuation = value.match(trailingPunctuationPattern)?.[0] ?? "";
  const candidate = punctuation.length === 0 ? value : value.slice(0, -punctuation.length);
  return `${sanitizeHttpUrl(candidate) ?? redactedValue}${punctuation}`;
}

function sanitizeEmbeddedRouteUrl(value: string): string {
  const trailingPunctuationPattern = /[),.;}]+$/u;
  const punctuation = value.match(trailingPunctuationPattern)?.[0] ?? "";
  const candidate = punctuation.length === 0 ? value : value.slice(0, -punctuation.length);
  const referenceOrigin = "https://uiwitness.invalid";
  let url: URL;
  try {
    url = new URL(candidate, referenceOrigin);
  } catch {
    return redactedValue;
  }

  url.hash = "";
  if (url.search.length > 0) {
    const redacted = new URLSearchParams();
    for (const [key] of url.searchParams) {
      redacted.append(key, redactedValue);
    }
    url.search = redacted.toString();
  }
  const prefix = candidate.startsWith("//") ? `//${url.host}` : "";
  return `${prefix}${url.pathname}${url.search}${punctuation}`;
}

/** @internal Redacts common secret forms and caps untrusted diagnostic text. */
export function sanitizeDiagnosticText(value: string): string {
  const sanitized = value
    .slice(0, maxDiagnosticLength)
    .replace(
      cookiePattern,
      (_match, key: string, separator: string) =>
        `${key}${separator}${redactedValue}`,
    )
    .replace(
      authorizationPattern,
      (_match, separator: string) => `authorization${separator}${redactedValue}`,
    )
    .replace(bearerPattern, `Bearer ${redactedValue}`)
    .replace(
      sensitiveAssignmentPattern,
      (_match, key: string, separator: string) =>
        `${key}${separator}${redactedValue}`,
    )
    .replace(embeddedHttpUrlPattern, sanitizeEmbeddedUrl)
    .replace(embeddedRouteUrlPattern, sanitizeEmbeddedRouteUrl)
    .slice(0, maxDiagnosticLength)
    .trim();
  return sanitized.length === 0 ? "[empty diagnostic]" : sanitized;
}

/** @internal Converts unknown thrown values into bounded sanitized text. */
export function diagnosticErrorMessage(reason: unknown): string {
  try {
    return sanitizeDiagnosticText(
      String(reason instanceof Error ? reason.message : reason),
    );
  } catch {
    return "[unprintable thrown value]";
  }
}

function resolveFailurePolicy(
  policy: FailurePolicy | undefined,
): ResolvedFailurePolicy {
  const values = {
    consoleError: policy?.consoleError ?? false,
    failedRequest: policy?.failedRequest ?? false,
    pageError: policy?.pageError ?? true,
  };
  for (const [key, value] of Object.entries(values)) {
    if (typeof value !== "boolean") {
      throw new TypeError(`failOn.${key} must be a boolean.`);
    }
  }
  return Object.freeze(values);
}

function validMaskScope(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.length > 0 &&
    value.every((item) =>
      typeof item === "string" && evidenceIdentifierPattern.test(item)
    ) && new Set(value).size === value.length;
}

function resolveEvidencePolicy(
  config: EvidenceConfig | undefined,
  cells: readonly MatrixCell[],
): ResolvedEvidencePolicy {
  if (
    config !== undefined &&
    (typeof config !== "object" || config === null || Array.isArray(config))
  ) {
    throw new EvidencePolicyError("Evidence policy must be an object.");
  }
  if (
    config !== undefined &&
    Object.keys(config).some((key) => key !== "masks" && key !== "retention")
  ) {
    throw new EvidencePolicyError("Evidence policy contains unsupported fields.");
  }
  const retention = config?.retention ?? "all";
  const masks = config?.masks ?? [];
  if (!(["all", "failures-only", "none"] as readonly unknown[]).includes(retention)) {
    throw new EvidencePolicyError("Evidence retention policy is invalid.");
  }
  if (!Array.isArray(masks)) {
    throw new EvidencePolicyError("Evidence masks must be an array.");
  }
  const routeIds = new Set(cells.map(({ route }) => route.id));
  const stateIds = new Set(cells.map(({ state }) => state.id));
  const routeStateIds = new Set(cells.map(({ route, state }) =>
    JSON.stringify([route.id, state.id])
  ));
  const maskIds = new Set<string>();
  for (const mask of masks as readonly unknown[]) {
    if (typeof mask !== "object" || mask === null || Array.isArray(mask)) {
      throw new EvidencePolicyError("Evidence masks must be objects.");
    }
    const candidate = mask as Record<string, unknown>;
    const keys = new Set(["count", "id", "required", "routeIds", "selector", "stateIds"]);
    if (Object.keys(candidate).some((key) => !keys.has(key))) {
      throw new EvidencePolicyError("Evidence masks contain unsupported fields.");
    }
    if (
      typeof candidate["id"] !== "string" ||
      !evidenceIdentifierPattern.test(candidate["id"]) ||
      maskIds.has(candidate["id"])
    ) {
      throw new EvidencePolicyError("Evidence mask IDs must be unique valid identifiers.");
    }
    maskIds.add(candidate["id"]);
    if (
      typeof candidate["selector"] !== "string" ||
      candidate["selector"].trim().length === 0 ||
      candidate["selector"].length > 1_024
    ) {
      throw new EvidencePolicyError("Evidence mask selectors must contain 1 to 1,024 characters.");
    }
    if (candidate["required"] !== undefined && typeof candidate["required"] !== "boolean") {
      throw new EvidencePolicyError("Evidence mask required values must be booleans.");
    }
    if (
      candidate["count"] !== undefined &&
      (!Number.isSafeInteger(candidate["count"]) || (candidate["count"] as number) <= 0)
    ) {
      throw new EvidencePolicyError("Evidence mask counts must be positive integers.");
    }
    for (const scopeName of ["routeIds", "stateIds"] as const) {
      const scope = candidate[scopeName];
      if (scope !== undefined && !validMaskScope(scope)) {
        throw new EvidencePolicyError(`Evidence mask ${scopeName} must contain unique valid identifiers.`);
      }
    }
    const scopedRoutes = candidate["routeIds"] as readonly string[] | undefined;
    const scopedStates = candidate["stateIds"] as readonly string[] | undefined;
    if (scopedRoutes?.some((id) => !routeIds.has(id)) === true) {
      throw new EvidencePolicyError("Evidence masks cannot reference unknown routes.");
    }
    if (scopedStates?.some((id) => !stateIds.has(id)) === true) {
      throw new EvidencePolicyError("Evidence masks cannot reference unknown states.");
    }
    if (
      scopedRoutes !== undefined && scopedStates !== undefined &&
      scopedStates.some((stateId) =>
        !scopedRoutes.some((routeId) =>
          routeStateIds.has(JSON.stringify([routeId, stateId]))
        )
      )
    ) {
      throw new EvidencePolicyError("Evidence mask states must belong to their scoped routes.");
    }
  }
  return Object.freeze({
    masks: Object.freeze([...(masks as readonly EvidenceMaskConfig[])]),
    retention,
  });
}

function applicableMasks(
  masks: readonly EvidenceMaskConfig[],
  cell: Pick<MatrixCell, "route" | "state">,
): readonly EvidenceMaskConfig[] {
  return masks.filter((mask) =>
    (mask.routeIds === undefined || mask.routeIds.includes(cell.route.id)) &&
    (mask.stateIds === undefined || mask.stateIds.includes(cell.state.id))
  );
}

function freezeDiagnostics(
  consoleErrors: readonly string[],
  failedRequests: ExecutionDiagnostics["failedRequests"],
  navigationStatus: number | null,
  pageErrors: readonly string[],
): ExecutionDiagnostics {
  return Object.freeze({
    consoleErrors: Object.freeze([...consoleErrors]),
    failedRequests: Object.freeze([...failedRequests]),
    navigationStatus,
    pageErrors: Object.freeze([...pageErrors]),
  });
}

class DiagnosticCollector {
  readonly consoleErrors: string[] = [];
  readonly failedRequests: {
    readonly errorText: string;
    readonly method: string;
    readonly url: string;
  }[] = [];
  readonly pageErrors: string[] = [];
  private readonly dropped = {
    consoleErrors: 0,
    failedRequests: 0,
    pageErrors: 0,
  };

  readonly onConsole = (message: ConsoleMessage): void => {
    if (message.type() === "error") {
      if (this.consoleErrors.length < maxDiagnosticsPerCategory) {
        this.consoleErrors.push(sanitizeDiagnosticText(message.text()));
      } else {
        this.dropped.consoleErrors += 1;
      }
    }
  };

  readonly onPageError = (error: Error): void => {
    if (this.pageErrors.length < maxDiagnosticsPerCategory) {
      this.pageErrors.push(diagnosticErrorMessage(error));
    } else {
      this.dropped.pageErrors += 1;
    }
  };

  readonly onRequestFailed = (request: Request): void => {
    const requestUrl = request.url();
    if (
      !requestUrl.startsWith("http://") &&
      !requestUrl.startsWith("https://")
    ) {
      return;
    }
    if (this.failedRequests.length >= maxDiagnosticsPerCategory) {
      this.dropped.failedRequests += 1;
      return;
    }
    const url = sanitizeHttpUrl(requestUrl);
    if (url === null) {
      return;
    }
    this.failedRequests.push(
      Object.freeze({
        errorText: sanitizeDiagnosticText(
          request.failure()?.errorText ??
            "Request failed without an error message.",
        ),
        method: sanitizeDiagnosticText(request.method()),
        url,
      }),
    );
  };

  constructor(private readonly page: Page) {}

  start(): void {
    this.page.on("console", this.onConsole);
    this.page.on("pageerror", this.onPageError);
    this.page.on("requestfailed", this.onRequestFailed);
  }

  stop(): void {
    this.page.off("console", this.onConsole);
    this.page.off("pageerror", this.onPageError);
    this.page.off("requestfailed", this.onRequestFailed);
  }

  snapshot(navigationStatus: number | null): ExecutionDiagnostics {
    return freezeDiagnostics(
      this.consoleErrors,
      this.failedRequests,
      navigationStatus,
      this.pageErrors,
    );
  }

  droppedSnapshot(): DroppedDiagnosticCounts {
    return Object.freeze({ ...this.dropped });
  }
}

function durationSince(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}

function evidence(
  assertionStatus: AssertionStatus,
  collector: DiagnosticCollector,
  startedAt: number,
  navigation: NavigationMetadata | null,
  navigationStatus: number | null,
  screenshot: Uint8Array | null,
  screenshotStatus: EvidenceScreenshotStatus,
  screenshotAttempted: boolean,
  masks: readonly AppliedEvidenceMask[],
): ScenarioCaptureEvidence {
  return Object.freeze({
    assertionStatus,
    diagnostics: collector.snapshot(navigationStatus),
    droppedDiagnostics: collector.droppedSnapshot(),
    durationMs: durationSince(startedAt),
    masks: Object.freeze([...masks]),
    navigation,
    screenshot,
    screenshotAttempted,
    screenshotStatus,
  });
}

function failure(
  code: ExecutionFailureCode,
  message: string,
): ExecutionFailure {
  return Object.freeze({ code, message });
}

function policyFailures(
  diagnostics: ExecutionDiagnostics,
  droppedDiagnostics: DroppedDiagnosticCounts,
  policy: ResolvedFailurePolicy,
): readonly ExecutionFailure[] {
  const failures: ExecutionFailure[] = [];
  if (policy.consoleError && diagnostics.consoleErrors.length > 0) {
    failures.push(
      failure(
        "CONSOLE_ERROR",
        `${diagnostics.consoleErrors.length + droppedDiagnostics.consoleErrors} console error(s) matched the failure policy.`,
      ),
    );
  }
  if (policy.pageError && diagnostics.pageErrors.length > 0) {
    failures.push(
      failure(
        "PAGE_ERROR",
        `${diagnostics.pageErrors.length + droppedDiagnostics.pageErrors} page error(s) matched the failure policy.`,
      ),
    );
  }
  if (policy.failedRequest && diagnostics.failedRequests.length > 0) {
    failures.push(
      failure(
        "FAILED_REQUEST",
        `${diagnostics.failedRequests.length + droppedDiagnostics.failedRequests} failed request(s) matched the failure policy.`,
      ),
    );
  }
  return failures;
}

function captureError(
  failures: readonly ExecutionFailure[],
  currentEvidence: ScenarioCaptureEvidence,
  cause?: unknown,
): ScenarioCaptureError {
  return new ScenarioCaptureError(
    failures,
    currentEvidence,
    cause === undefined ? undefined : { cause },
  );
}

function lifecycleFailureCode(reason: unknown): ExecutionFailureCode {
  return reason instanceof ScenarioLoadError
    ? "INTERNAL_ERROR"
    : "NAVIGATION_FAILED";
}

/**
 * Runs complete in-memory Phase 3 capture for every matrix cell. PNG bytes and
 * sanitized diagnostics are returned without writing artifacts or reports.
 */
export function runCapturedScenarioCells(
  cells: readonly MatrixCell[],
  options: PrivacyRunCapturedScenarioCellsOptions,
): Promise<readonly CellExecutionOutcome<CompletedScenarioCell>[]>;
export function runCapturedScenarioCells(
  cells: readonly MatrixCell[],
  options: RunCapturedScenarioCellsOptions,
): Promise<readonly CellExecutionOutcome<CapturedScenarioCell>[]>;
export async function runCapturedScenarioCells(
  cells: readonly MatrixCell[],
  options: AnyRunCapturedScenarioCellsOptions,
): Promise<readonly CellExecutionOutcome<CompletedScenarioCell>[]> {
  const policy = resolveFailurePolicy(options.failOn);
  const evidencePolicy = resolveEvidencePolicy(options.evidence, cells);

  return runNavigatedScenarioLifecycleCells(
    cells,
    async (lifecycle) => {
      const { context } = lifecycle;
      const startedAt = lifecycle.startedAt;
      const collector = new DiagnosticCollector(context.page);
      let navigation: NavigationMetadata | null = null;
      let assertionContext: AssertionScenarioContext | undefined;
      let scenario: UIWitnessScenario;
      let screenshot: Uint8Array | null = null;
      let screenshotAttempted = false;
      let screenshotStatus: EvidenceScreenshotStatus =
        evidencePolicy.retention === "none"
          ? "omitted-by-policy"
          : "capture-failed";
      const appliedMasks: AppliedEvidenceMask[] = [];
      collector.start();

      const currentEvidence = (
        assertionStatus: AssertionStatus,
      ): ScenarioCaptureEvidence => evidence(
        assertionStatus,
        collector,
        startedAt,
        navigation,
        navigation?.status ?? lifecycle.navigationStatusSnapshot(),
        screenshot,
        screenshotStatus,
        screenshotAttempted,
        appliedMasks,
      );

      const assertNavigationStable = (
        assertionStatus: AssertionStatus,
      ): void => {
        try {
          lifecycle.assertNavigationStable();
        } catch (cause: unknown) {
          screenshot = null;
          if (evidencePolicy.retention !== "none") {
            screenshotStatus = "capture-failed";
          }
          const captured = currentEvidence(assertionStatus);
          throw captureError(
            [
              failure("NAVIGATION_FAILED", diagnosticErrorMessage(cause)),
              ...policyFailures(
                captured.diagnostics,
                captured.droppedDiagnostics,
                policy,
              ),
            ],
            captured,
            cause,
          );
        }
      };

      try {
        try {
          const navigated = await lifecycle.navigate();
          navigation = navigated.context.navigation;
          assertionContext = navigated.context;
          scenario = navigated.scenario;
        } catch (cause: unknown) {
          navigation = lifecycle.navigationSnapshot();
          const captured = currentEvidence("not-run");
          throw captureError(
            [
              failure(
                lifecycleFailureCode(cause),
                diagnosticErrorMessage(cause),
              ),
              ...policyFailures(
                captured.diagnostics,
                captured.droppedDiagnostics,
                policy,
              ),
            ],
            captured,
            cause,
          );
        }

        if (evidencePolicy.retention !== "none") {
          const resolvedMasks: Array<{
            readonly attribute: string;
            readonly count: number;
            readonly id: string;
            readonly locator: Locator;
            readonly property: string;
            readonly selectorLocator: Locator;
            readonly token: string;
          }> = [];
          for (const mask of applicableMasks(evidencePolicy.masks, context)) {
            let locator: Locator;
            let count: number;
            const token = randomUUID();
            const suffix = token.replaceAll("-", "");
            const attribute = `data-uiwitness-mask-${suffix}`;
            const property = `__uiwitnessMask${suffix}`;
            try {
              locator = context.page.locator(mask.selector);
              count = await locator.evaluateAll(
                (elements, marker) => {
                  for (const element of elements) {
                    element.setAttribute(marker.attribute, "");
                    Object.defineProperty(element, marker.property, {
                      configurable: true,
                      value: marker.token,
                    });
                  }
                  return elements.length;
                },
                { attribute, property, token },
              );
            } catch (cause: unknown) {
              const captured = currentEvidence("not-run");
              throw captureError([
                failure(
                  "MASK_SELECTOR_INVALID",
                  `Mask ${mask.id} uses an invalid selector.`,
                ),
                ...policyFailures(
                  captured.diagnostics,
                  captured.droppedDiagnostics,
                  policy,
                ),
              ], captured, cause);
            }
            if (count === 0 && (mask.required ?? true)) {
              const captured = currentEvidence("not-run");
              throw captureError([
                failure(
                  "MASK_REQUIRED_MISSING",
                  `Required mask ${mask.id} matched no elements.`,
                ),
                ...policyFailures(
                  captured.diagnostics,
                  captured.droppedDiagnostics,
                  policy,
                ),
              ], captured);
            }
            if (mask.count !== undefined && count !== mask.count) {
              const captured = currentEvidence("not-run");
              throw captureError([
                failure(
                  "MASK_CARDINALITY_MISMATCH",
                  `Mask ${mask.id} matched ${count} element(s); expected ${mask.count}.`,
                ),
                ...policyFailures(
                  captured.diagnostics,
                  captured.droppedDiagnostics,
                  policy,
                ),
              ], captured);
            }
            resolvedMasks.push({
              attribute,
              count,
              id: mask.id,
              locator: context.page.locator(`[${attribute}]`),
              property,
              selectorLocator: locator,
              token,
            });
          }

          try {
            screenshotAttempted = true;
            const bytes = await context.page.screenshot({
              type: "png",
              ...(resolvedMasks.length === 0
                ? {}
                : {
                    mask: resolvedMasks.flatMap(
                      ({ count, locator, selectorLocator }) =>
                        count === 0
                          ? [selectorLocator]
                          : [locator, selectorLocator],
                    ),
                    maskColor: "#0b0c0a",
                  }),
            });
            for (const mask of resolvedMasks) {
              const stable = await mask.selectorLocator.evaluateAll(
                (elements, marker) =>
                  elements.length === marker.count && elements.every((element) =>
                    element.getAttribute(marker.attribute) === "" &&
                    Reflect.get(element, marker.property) === marker.token
                  ),
                {
                  attribute: mask.attribute,
                  count: mask.count,
                  property: mask.property,
                  token: mask.token,
                },
              );
              if (!stable) {
                throw new Error(`Mask ${mask.id} changed while the screenshot was captured.`);
              }
            }
            screenshot = new Uint8Array(bytes);
            screenshotStatus = "captured";
            appliedMasks.push(...resolvedMasks.map(({ count, id }) =>
              Object.freeze({ count, id })
            ));
          } catch (cause: unknown) {
            const captured = currentEvidence("not-run");
            const code = resolvedMasks.length === 0
              ? "SCREENSHOT_FAILED"
              : "MASK_APPLY_FAILED";
            throw captureError([
              failure(code, diagnosticErrorMessage(cause)),
              ...policyFailures(
                captured.diagnostics,
                captured.droppedDiagnostics,
                policy,
              ),
            ], captured, cause);
          } finally {
            await Promise.all(resolvedMasks.map(async (mask) => {
              await mask.locator.evaluateAll((elements, marker) => {
                for (const element of elements) {
                  element.removeAttribute(marker.attribute);
                  Reflect.deleteProperty(element, marker.property);
                }
              }, {
                attribute: mask.attribute,
                property: mask.property,
              }).catch(() => undefined);
            }));
          }
        }
        assertNavigationStable("not-run");

        let assertionStatus: AssertionStatus = "not-configured";
        let assertionFailure: ExecutionFailure | undefined;
        let assertionCause: unknown;
        if (scenario?.assert !== undefined) {
          try {
            if (assertionContext === undefined) {
              throw new Error("Assertion context is unavailable after navigation.");
            }
            await scenario.assert(assertionContext);
            assertionStatus = "passed";
          } catch (cause: unknown) {
            assertionStatus = "failed";
            assertionCause = cause;
            assertionFailure = failure(
              "ASSERTION_FAILED",
              diagnosticErrorMessage(cause),
            );
          }
        }
        assertNavigationStable(assertionStatus);

        const captured = currentEvidence(assertionStatus);
        const failures = [
          ...(assertionFailure === undefined ? [] : [assertionFailure]),
          ...policyFailures(
            captured.diagnostics,
            captured.droppedDiagnostics,
            policy,
          ),
        ];
        if (failures.length > 0) {
          throw captureError(failures, captured, assertionCause);
        }

        if (evidencePolicy.retention === "failures-only") {
          screenshot = null;
          screenshotStatus = "omitted-by-policy";
        }

        if (
          (assertionStatus !== "not-configured" &&
            assertionStatus !== "passed") ||
          navigation === null ||
          (evidencePolicy.retention === "all" && screenshot === null)
        ) {
          throw new Error("Successful capture evidence is incomplete.");
        }
        const completed = currentEvidence(assertionStatus);
        return Object.freeze({
          assertionStatus,
          diagnostics: completed.diagnostics,
          droppedDiagnostics: completed.droppedDiagnostics,
          durationMs: completed.durationMs,
          masks: completed.masks,
          navigation,
          screenshot,
          screenshotAttempted,
          screenshotStatus,
        }) as CompletedScenarioCell;
      } finally {
        collector.stop();
      }
    },
    options,
  );
}
