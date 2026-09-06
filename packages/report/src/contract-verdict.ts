import {
  CONTRACT_FAILURE_CODES,
  CONTRACT_FINDING_KINDS,
  CONTRACT_FINDING_PRECEDENCE,
  contractExceptionLifecycle,
  type ContractFailureCode,
  type ContractFindingKind,
  type ContractRunErrorReason,
  type ContractVerdictStatus,
  type ExecutionFailureCode,
  type UIWitnessEvidenceManifest,
} from "uiwitness-core";

const digestPattern = /^sha256:[0-9a-f]{64}$/;
const datePattern = /^\d{4}-\d{2}-\d{2}$/;
const passingKinds = new Set<ContractFindingKind>([
  "matched",
  "matched-known-failure",
]);
const executionFailureCodes = new Set<ExecutionFailureCode>([
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
]);
const contractFailureCodes = new Set<ContractFailureCode>(
  CONTRACT_FAILURE_CODES,
);
const runErrorReasons: ReadonlySet<string> = new Set([
  "declared-incomplete",
  "duplicate-execution-coordinate",
  "missing-execution",
  "unexpected-execution",
] as const);

interface ParsedOutcome {
  readonly failureCodes: readonly string[];
  readonly label: string;
  readonly status: "failed" | "passed";
}

interface ParsedExpectation extends ParsedOutcome {
  readonly exception: ContractFindingView["exception"];
}

/** Optional schema-v1 contract verdict rendered above execution evidence. */
export interface ContractVerdictReportInput {
  readonly complete: boolean;
  readonly configDigest: string;
  readonly contractDigest: string;
  readonly evaluatedOn: string;
  readonly findings: readonly unknown[];
  readonly runDigest: string;
  readonly schemaVersion: 1;
  readonly verdict: ContractVerdictStatus;
}

/** Additive renderer options. Omitting them preserves the execution-only report. */
export interface RenderReportOptions {
  readonly contractVerdict?: ContractVerdictReportInput | undefined;
  readonly evidenceManifest?: UIWitnessEvidenceManifest | undefined;
}

export interface ContractFindingView {
  readonly actual: string;
  readonly coordinateId: string | null;
  readonly exception: {
    readonly createdOn: string;
    readonly daysUntilExpiry: number;
    readonly expiresOn: string;
    readonly owner: string;
    readonly reason: string;
    readonly status: "active" | "expired";
  } | null;
  readonly expected: string;
  readonly kind: ContractFindingKind;
  readonly label: string;
  readonly guidance: string | null;
  readonly remediate: string | null;
  readonly reproduce: string | null;
  readonly runErrorReasons: readonly ContractRunErrorReason[];
  readonly tone: "calm" | "critical" | "warning";
}

/** Validated, renderer-ready projection of the schema-v1 machine verdict. */
export interface ContractVerdictView {
  readonly complete: boolean;
  readonly configDigest: string;
  readonly contractDigest: string;
  readonly evaluatedOn: string;
  readonly findings: readonly ContractFindingView[];
  readonly matched: number;
  readonly promised: number;
  readonly runDigest: string;
  readonly schemaVersion: 1;
  readonly verdict: ContractVerdictStatus;
}

function record(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TypeError(`${label} must be an object.`);
  }
  return value as Record<string, unknown>;
}

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maximum: number): string {
  const selected = requiredString(value, label);
  if (selected.length > maximum) {
    throw new TypeError(`${label} must not exceed ${maximum.toLocaleString("en-US")} characters.`);
  }
  return selected;
}

function visibleGovernanceText(value: string): string {
  return [...value].map((character) =>
    /[\p{Cc}\p{Default_Ignorable_Code_Point}]/u.test(character)
      ? `\\u{${character.codePointAt(0)!.toString(16).padStart(4, "0")}}`
      : character
  ).join("");
}

function assertOnlyKeys(
  value: Record<string, unknown>,
  keys: readonly string[],
  label: string,
): void {
  const allowed = new Set(keys);
  const unexpected = Object.keys(value).find((key) => !allowed.has(key));
  if (unexpected !== undefined) {
    throw new TypeError(`${label}.${unexpected} is not supported.`);
  }
}

function isValidDate(value: string): boolean {
  if (!datePattern.test(value) || value.startsWith("0000-")) return false;
  const instant = new Date(`${value}T00:00:00.000Z`);
  return Number.isFinite(instant.valueOf()) &&
    instant.toISOString().slice(0, 10) === value;
}

function digest(value: unknown, label: string): string {
  const selected = requiredString(value, label);
  if (!digestPattern.test(selected)) {
    throw new TypeError(`${label} must be a lowercase SHA-256 digest.`);
  }
  return selected;
}

function command(value: unknown, label: string): string | null {
  if (value === undefined) return null;
  const selected = requiredString(value, label);
  if (selected.length > 8_192) {
    throw new TypeError(`${label} must not exceed 8,192 characters.`);
  }
  return selected;
}

function failureCodes(
  value: unknown,
  label: string,
  supported: ReadonlySet<string>,
): readonly string[] {
  if (!Array.isArray(value) || value.length === 0) {
    throw new TypeError(`${label} must contain at least one failure code.`);
  }
  const codes = value.map((item, index) =>
    requiredString(item, `${label}[${index}]`)
  );
  if (codes.some((code) => !supported.has(code))) {
    throw new TypeError(`${label} contains an unsupported failure code.`);
  }
  if (new Set(codes).size !== codes.length) {
    throw new TypeError(`${label} must not contain duplicate failure codes.`);
  }
  if ([...codes].sort().some((code, index) => code !== codes[index])) {
    throw new TypeError(`${label} must use canonical order.`);
  }
  return Object.freeze(codes);
}

function outcome(value: unknown, label: string): ParsedOutcome {
  const selected = record(value, label);
  if (selected["status"] === "passed") {
    assertOnlyKeys(selected, ["status"], label);
    return Object.freeze({ failureCodes: [], label: "Passed", status: "passed" });
  }
  if (selected["status"] === "failed") {
    assertOnlyKeys(selected, ["failureCodes", "status"], label);
    const codes = failureCodes(
      selected["failureCodes"],
      `${label}.failureCodes`,
      executionFailureCodes,
    );
    return Object.freeze({
      failureCodes: codes,
      label: `Failed · ${codes.join(", ")}`,
      status: "failed",
    });
  }
  throw new TypeError(`${label}.status must be passed or failed.`);
}

function exception(
  value: unknown,
  evaluatedOn: string,
): ContractFindingView["exception"] {
  if (value === undefined) return null;
  const selected = record(value, "Contract finding exception");
  assertOnlyKeys(
    selected,
    ["createdOn", "expiresOn", "owner", "reason"],
    "Contract finding exception",
  );
  const createdOn = requiredString(
    selected["createdOn"],
    "Contract finding exception.createdOn",
  );
  const expiresOn = requiredString(
    selected["expiresOn"],
    "Contract finding exception.expiresOn",
  );
  if (!isValidDate(createdOn) || !isValidDate(expiresOn)) {
    throw new TypeError("Contract finding exception dates must be real YYYY-MM-DD dates.");
  }
  const lifetimeDays = (
    Date.parse(`${expiresOn}T00:00:00.000Z`) -
    Date.parse(`${createdOn}T00:00:00.000Z`)
  ) / 86_400_000;
  if (lifetimeDays < 1 || lifetimeDays > 30) {
    throw new TypeError(
      "Contract finding exception expiry must be 1 to 30 calendar days after creation.",
    );
  }
  return Object.freeze({
    createdOn,
    ...contractExceptionLifecycle({ expiresOn }, evaluatedOn),
    expiresOn,
    owner: visibleGovernanceText(boundedString(
      selected["owner"],
      "Contract finding exception.owner",
      1_024,
    )),
    reason: visibleGovernanceText(boundedString(
      selected["reason"],
      "Contract finding exception.reason",
      1_024,
    )),
  });
}

function expectation(
  value: unknown,
  label: string,
  evaluatedOn: string,
): ParsedExpectation {
  const selected = record(value, label);
  if (selected["status"] === "passed") {
    assertOnlyKeys(selected, ["status"], label);
    return Object.freeze({
      exception: null,
      failureCodes: [],
      label: "Passed",
      status: "passed",
    });
  }
  if (selected["status"] === "failed") {
    assertOnlyKeys(selected, ["exception", "failureCodes", "status"], label);
    const codes = failureCodes(
      selected["failureCodes"],
      `${label}.failureCodes`,
      contractFailureCodes,
    );
    const selectedException = exception(selected["exception"], evaluatedOn);
    if (selectedException === null) {
      throw new TypeError(`${label}.exception is required for failed expectations.`);
    }
    return Object.freeze({
      exception: selectedException,
      failureCodes: codes,
      label: `Failed · ${codes.join(", ")}`,
      status: "failed",
    });
  }
  throw new TypeError(`${label}.status must be passed or failed.`);
}

function assertStatus(
  value: ParsedOutcome,
  status: ParsedOutcome["status"],
  label: string,
): void {
  if (value.status !== status) {
    throw new TypeError(`${label} must have status ${status}.`);
  }
}

function sameCodes(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length &&
    left.every((code, index) => code === right[index]);
}

function fingerprint(value: unknown, label: string): string {
  return digest(value, label);
}

function validateRunError(
  selected: Record<string, unknown>,
  coordinateId: string | null,
  label: string,
): readonly ContractRunErrorReason[] {
  const reasonsValue = selected["reasons"];
  if (!Array.isArray(reasonsValue) || reasonsValue.length === 0) {
    throw new TypeError(`${label}.reasons must contain at least one reason.`);
  }
  const reasons = reasonsValue.map((value, index) =>
    requiredString(value, `${label}.reasons[${index}]`)
  );
  if (
    reasons.some((reason) => !runErrorReasons.has(reason))
  ) {
    throw new TypeError(`${label}.reasons contains an unsupported reason.`);
  }
  if (new Set(reasons).size !== reasons.length) {
    throw new TypeError(`${label}.reasons must not contain duplicates.`);
  }
  if ([...reasons].sort().some((reason, index) => reason !== reasons[index])) {
    throw new TypeError(`${label}.reasons must use canonical order.`);
  }
  const declaredIncomplete = reasons.includes("declared-incomplete");
  if (
    (coordinateId === null && (reasons.length !== 1 || !declaredIncomplete)) ||
    (coordinateId !== null && declaredIncomplete)
  ) {
    throw new TypeError(`${label} has an invalid coordinate/reason combination.`);
  }
  return Object.freeze(reasons.map((reason) => reason as ContractRunErrorReason));
}

const reproductionKinds = new Set<ContractFindingKind>([
  "changed-known-failure",
  "recovered-known-failure",
  "regression",
]);
const remediationKinds = new Set<ContractFindingKind>([
  "changed-known-failure",
  "expired-exception",
  "missing-coordinate",
  "recovered-known-failure",
  "regression",
  "unaccepted-addition",
  "unaccepted-config-drift",
]);

function findingCommand(
  selected: Record<string, unknown>,
  field: "remediate" | "reproduce",
  required: boolean,
  label: string,
): string | null {
  const value = selected[field];
  if (!required) {
    if (value !== undefined) {
      throw new TypeError(`${label}.${field} is not supported for this finding kind.`);
    }
    return null;
  }
  if (value === undefined) {
    throw new TypeError(`${label}.${field} is required for this finding kind.`);
  }
  return command(value, `${label}.${field}`);
}

const findingPresentation: Readonly<
  Record<ContractFindingKind, Pick<ContractFindingView, "guidance" | "label" | "tone">>
> = Object.freeze({
  "changed-known-failure": Object.freeze({
    guidance: "The failure-code set changed, so the existing exception does not apply. Review and annotate the new exact expectation.",
    label: "Changed known failure",
    tone: "critical",
  }),
  "expired-exception": Object.freeze({
    guidance: "Repair the state, or explicitly renew with a new reason and a current 1–30 day window.",
    label: "Expired exception",
    tone: "warning",
  }),
  matched: Object.freeze({ guidance: null, label: "Matched", tone: "calm" }),
  "matched-known-failure": Object.freeze({
    guidance: "This accepted exception applies only to the displayed exact failure-code set.",
    label: "Known failure",
    tone: "warning",
  }),
  "missing-coordinate": Object.freeze({
    guidance: null,
    label: "Unaccepted drift",
    tone: "warning",
  }),
  "recovered-known-failure": Object.freeze({
    guidance: "The state recovered. Accept the expectation change to remove this stale contract debt.",
    label: "Recovered known failure",
    tone: "warning",
  }),
  regression: Object.freeze({ guidance: null, label: "Regression", tone: "critical" }),
  "run-error": Object.freeze({ guidance: null, label: "Incomplete run", tone: "critical" }),
  "unaccepted-addition": Object.freeze({
    guidance: null,
    label: "Unaccepted drift",
    tone: "warning",
  }),
  "unaccepted-config-drift": Object.freeze({
    guidance: null,
    label: "Unaccepted drift",
    tone: "warning",
  }),
});

function finding(
  input: unknown,
  index: number,
  evaluatedOn: string,
): ContractFindingView {
  const label = `Contract finding ${index + 1}`;
  const selected = record(input, label);
  const kindValue = requiredString(
    selected["kind"],
    `Contract finding ${index + 1}.kind`,
  );
  if (!(CONTRACT_FINDING_KINDS as readonly string[]).includes(kindValue)) {
    throw new TypeError(`Contract finding ${index + 1}.kind is not supported.`);
  }
  const kind = kindValue as ContractFindingKind;
  const idValue = selected["id"];
  const coordinateId = idValue === null && kind === "run-error"
    ? null
    : requiredString(idValue, `Contract finding ${index + 1}.id`);
  let actualLabel = "Incomplete";
  let expectedLabel = "Not available";
  let actualOutcome: ParsedOutcome | null = null;
  let expectedOutcome: ParsedExpectation | null = null;
  let selectedException: ContractFindingView["exception"] = null;
  let selectedRunErrorReasons: readonly ContractRunErrorReason[] = Object.freeze([]);

  if (kind === "run-error") {
    if ("actual" in selected || "expected" in selected) {
      throw new TypeError(`${label} must not contain expected or actual outcomes.`);
    }
    selectedRunErrorReasons = validateRunError(selected, coordinateId, label);
  } else if (kind === "unaccepted-addition") {
    const actual = outcome(selected["actual"], `${label}.actual`);
    actualOutcome = actual;
    if (selected["expected"] !== null) {
      throw new TypeError(`${label}.expected must be null.`);
    }
    fingerprint(selected["currentConfigFingerprint"], `${label}.currentConfigFingerprint`);
    actualLabel = actual.label;
    expectedLabel = "Not present";
  } else if (kind === "missing-coordinate") {
    if (selected["actual"] !== null) {
      throw new TypeError(`${label}.actual must be null.`);
    }
    const expected = expectation(selected["expected"], `${label}.expected`, evaluatedOn);
    expectedOutcome = expected;
    fingerprint(selected["contractConfigFingerprint"], `${label}.contractConfigFingerprint`);
    actualLabel = "Not present";
    expectedLabel = expected.label;
    selectedException = expected.exception;
  } else {
    const actual = outcome(selected["actual"], `${label}.actual`);
    const expected = expectation(selected["expected"], `${label}.expected`, evaluatedOn);
    actualOutcome = actual;
    expectedOutcome = expected;
    actualLabel = actual.label;
    expectedLabel = expected.label;
    selectedException = expected.exception;
    switch (kind) {
      case "matched":
        assertStatus(actual, "passed", `${label}.actual`);
        assertStatus(expected, "passed", `${label}.expected`);
        break;
      case "regression":
        assertStatus(actual, "failed", `${label}.actual`);
        assertStatus(expected, "passed", `${label}.expected`);
        break;
      case "matched-known-failure":
      case "changed-known-failure":
        assertStatus(actual, "failed", `${label}.actual`);
        assertStatus(expected, "failed", `${label}.expected`);
        if (
          sameCodes(actual.failureCodes, expected.failureCodes) !==
            (kind === "matched-known-failure")
        ) {
          throw new TypeError(`${label} failure codes do not match its kind.`);
        }
        break;
      case "recovered-known-failure":
        assertStatus(actual, "passed", `${label}.actual`);
        assertStatus(expected, "failed", `${label}.expected`);
        break;
      case "expired-exception":
        assertStatus(expected, "failed", `${label}.expected`);
        if (expected.exception === null || expected.exception.expiresOn >= evaluatedOn) {
          throw new TypeError(`${label}.expected exception is not expired.`);
        }
        break;
      case "unaccepted-config-drift": {
        const contractFingerprint = fingerprint(
          selected["contractConfigFingerprint"],
          `${label}.contractConfigFingerprint`,
        );
        const currentFingerprint = fingerprint(
          selected["currentConfigFingerprint"],
          `${label}.currentConfigFingerprint`,
        );
        if (contractFingerprint === currentFingerprint) {
          throw new TypeError(`${label} config fingerprints must differ.`);
        }
        break;
      }
    }
  }
  if (
    selectedException !== null &&
    selectedException.createdOn > evaluatedOn
  ) {
    throw new TypeError(`${label}.expected exception starts after evaluation.`);
  }
  const presentation = findingPresentation[kind];
  let guidance = presentation.guidance;
  if (kind === "matched-known-failure" && selectedException?.status === "expired") {
    guidance = "The exact failure-code set still matches, but the exception is expired.";
  } else if (
    kind === "changed-known-failure" &&
    actualOutcome?.failureCodes.some((code) => !contractFailureCodes.has(code as ContractFailureCode))
  ) {
    guidance = "This failure includes an ineligible code. Repair it because it cannot become a known failure.";
  } else if (kind === "expired-exception" && actualOutcome !== null) {
    if (actualOutcome.status === "passed") {
      guidance = "The state recovered. Accept the expectation change to remove this stale contract debt.";
    } else if (
      actualOutcome.failureCodes.some((code) => !contractFailureCodes.has(code as ContractFailureCode))
    ) {
      guidance = "This failure includes an ineligible code. Repair it because it cannot become a known failure.";
    } else if (
      expectedOutcome !== null &&
      !sameCodes(actualOutcome.failureCodes, expectedOutcome.failureCodes)
    ) {
      guidance = "The failure-code set changed. Review and annotate the new exact expectation.";
    }
  }
  const remediate = findingCommand(
    selected,
    "remediate",
    remediationKinds.has(kind),
    label,
  );
  const reproduce = findingCommand(
    selected,
    "reproduce",
    reproductionKinds.has(kind),
    label,
  );
  return Object.freeze({
    actual: actualLabel,
    coordinateId,
    exception: selectedException,
    expected: expectedLabel,
    guidance,
    kind,
    label: presentation.label,
    remediate,
    reproduce,
    runErrorReasons: selectedRunErrorReasons,
    tone: presentation.tone,
  });
}

function compareFinding(
  left: ContractFindingView,
  right: ContractFindingView,
): number {
  const leftId = left.coordinateId ?? "";
  const rightId = right.coordinateId ?? "";
  if (leftId < rightId) return -1;
  if (leftId > rightId) return 1;
  return CONTRACT_FINDING_PRECEDENCE[left.kind] -
    CONTRACT_FINDING_PRECEDENCE[right.kind];
}

/** @internal Validates a machine verdict before any value reaches HTML. */
export function transformContractVerdict(
  input: ContractVerdictReportInput,
): ContractVerdictView {
  const selected = record(input, "Contract verdict");
  if (selected["schemaVersion"] !== 1) {
    throw new TypeError("Contract verdict schemaVersion must be 1.");
  }
  if (typeof selected["complete"] !== "boolean") {
    throw new TypeError("Contract verdict complete must be a boolean.");
  }
  const verdict = selected["verdict"];
  if (verdict !== "error" && verdict !== "failed" && verdict !== "passed") {
    throw new TypeError("Contract verdict verdict is not supported.");
  }
  const evaluatedOn = requiredString(
    selected["evaluatedOn"],
    "Contract verdict evaluatedOn",
  );
  if (!isValidDate(evaluatedOn)) {
    throw new TypeError("Contract verdict evaluatedOn must be a real YYYY-MM-DD date.");
  }
  const findingInputs = selected["findings"];
  if (
    !Array.isArray(findingInputs) ||
    findingInputs.length === 0 ||
    findingInputs.length > 10_000
  ) {
    throw new TypeError("Contract verdict findings must contain 1 to 10,000 entries.");
  }
  const findings = findingInputs.map((item, index) =>
    finding(item, index, evaluatedOn)
  );
  const identities = new Set<string>();
  const findingsByCoordinate = new Map<string, ContractFindingView[]>();
  for (const [index, item] of findings.entries()) {
    const identity = `${item.coordinateId ?? ""}\u0000${item.kind}`;
    if (identities.has(identity)) {
      throw new TypeError("Contract verdict findings must not contain duplicate coordinate kinds.");
    }
    identities.add(identity);
    if (item.coordinateId !== null) {
      const group = findingsByCoordinate.get(item.coordinateId) ?? [];
      group.push(item);
      findingsByCoordinate.set(item.coordinateId, group);
    }
    if (index > 0 && compareFinding(findings[index - 1]!, item) > 0) {
      throw new TypeError("Contract verdict findings must use canonical order.");
    }
  }
  if (
    findings.some(({ kind }) => kind === "run-error") &&
    findings.some(({ kind }) => kind !== "run-error")
  ) {
    throw new TypeError("Contract verdict run errors cannot include comparison findings.");
  }
  const allowedPairs = new Set([
    "unaccepted-config-drift,expired-exception",
    "expired-exception,changed-known-failure",
    "expired-exception,recovered-known-failure",
    "expired-exception,matched-known-failure",
  ]);
  for (const group of findingsByCoordinate.values()) {
    const pair = group.map(({ kind }) => kind).join(",");
    if (group.length > 2 || (group.length === 2 && !allowedPairs.has(pair))) {
      throw new TypeError("Contract verdict contains an impossible coordinate finding combination.");
    }
    if (
      group.length === 2 &&
      (group[0]!.actual !== group[1]!.actual ||
       group[0]!.expected !== group[1]!.expected ||
       JSON.stringify(group[0]!.exception) !== JSON.stringify(group[1]!.exception))
    ) {
      throw new TypeError("Contract verdict coordinate findings disagree on outcomes.");
    }
    const expired = group.some(({ kind }) => kind === "expired-exception");
    if (group.length === 1 && expired) {
      throw new TypeError("Contract verdict expired exception is missing its coordinate outcome.");
    }
    const requiresExpired = group.some((item) =>
      item.kind !== "missing-coordinate" &&
      item.exception !== null &&
      item.exception.expiresOn < evaluatedOn
    );
    if (requiresExpired && !expired) {
      throw new TypeError(
        "Contract verdict expired expectations require an expired-exception finding.",
      );
    }
    if (expired && !requiresExpired) {
      throw new TypeError("Contract verdict exception expiry disagrees with its coordinate findings.");
    }
  }
  const derivedVerdict = findings.some(({ kind }) => kind === "run-error")
    ? "error"
    : findings.every(({ kind }) => passingKinds.has(kind)) ? "passed" : "failed";
  if (verdict !== derivedVerdict) {
    throw new TypeError("Contract verdict status does not match its findings.");
  }
  if (selected["complete"] === findings.some(({ kind }) => kind === "run-error")) {
    throw new TypeError("Contract verdict completeness does not match its findings.");
  }
  const promisedIds = new Set(
    findings
      .filter(({ coordinateId, kind }) =>
        coordinateId !== null && kind !== "unaccepted-addition"
      )
      .map(({ coordinateId }) => coordinateId!),
  );
  const matched = findings.filter(({ kind }) => passingKinds.has(kind)).length;
  return Object.freeze({
    complete: selected["complete"],
    configDigest: digest(selected["configDigest"], "Contract verdict configDigest"),
    contractDigest: digest(
      selected["contractDigest"],
      "Contract verdict contractDigest",
    ),
    evaluatedOn,
    findings: Object.freeze(findings),
    matched,
    promised: promisedIds.size,
    runDigest: digest(selected["runDigest"], "Contract verdict runDigest"),
    schemaVersion: 1,
    verdict,
  });
}
