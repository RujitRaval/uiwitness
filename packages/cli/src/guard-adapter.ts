import { lstat } from "node:fs/promises";
import { dirname, relative, resolve, sep } from "node:path";

import {
  canonicalJsonDigest,
  type AnyReportExecutionResult,
  type AnyUIWitnessReport,
  compareContract,
  type ContractComparisonResult,
  type ContractConfigurationCoordinate,
  type ContractExecutionObservation,
  type ContractSourceExecution,
  type ContractFinding,
  type JsonValue,
  type Sha256Digest,
  type UIWitnessConfig,
  type UIWitnessContract,
} from "uiwitness-core";

import {
  ConfigDiscoveryError,
  DEFAULT_CONFIG_FILENAMES,
  loadConfig,
  type LoadedConfig,
} from "./config.js";
import { GuardError } from "./guard-errors.js";
import { containedRegularFile } from "./guard-paths.js";

const defaultFailurePolicy = Object.freeze({
  consoleError: false,
  failedRequest: false,
  pageError: true,
});
const referenceOrigin = "https://uiwitness.invalid";

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function posixRelative(root: string, path: string): string {
  return `./${relative(root, path).split(sep).join("/")}`;
}

function sanitizedRoutePath(path: string): string {
  const url = new URL(path, referenceOrigin);
  url.hash = "";
  if (url.search.length > 0) {
    const redacted = new URLSearchParams();
    for (const [key] of url.searchParams) {
      redacted.append(key, "[REDACTED]");
    }
    url.search = redacted.toString();
  }
  return `${url.pathname}${url.search}`;
}

function coordinateId(coordinate: {
  readonly routeId: string;
  readonly stateId: string;
  readonly theme: string;
  readonly viewportId: string;
}): string {
  return `${coordinate.routeId}/${coordinate.stateId}/${coordinate.viewportId}/${coordinate.theme}`;
}

function evidenceId(execution: AnyReportExecutionResult): string | null {
  if ("screenshot" in execution) {
    return execution.screenshot.status === "captured"
      ? execution.screenshot.path
      : null;
  }
  return execution.screenshotPath;
}

function configurationOrder(
  left: ContractConfigurationCoordinate,
  right: ContractConfigurationCoordinate,
): number {
  const leftTuple = [left.routeId, left.stateId, left.viewportId, left.theme];
  const rightTuple = [right.routeId, right.stateId, right.viewportId, right.theme];
  for (let index = 0; index < leftTuple.length; index += 1) {
    if (leftTuple[index]! < rightTuple[index]!) return -1;
    if (leftTuple[index]! > rightTuple[index]!) return 1;
  }
  return 0;
}

async function defaultGuardConfigPath(root: string): Promise<string> {
  const candidates: string[] = [];
  for (const filename of DEFAULT_CONFIG_FILENAMES) {
    const candidate = resolve(root, filename);
    try {
      await lstat(candidate);
      candidates.push(candidate);
    } catch (error: unknown) {
      if (!missing(error)) {
        throw new GuardError(
          "GUARD_CONFIG_PATH_INVALID",
          `Config candidate cannot be inspected: ${candidate}`,
          candidate,
          { cause: error },
        );
      }
    }
  }
  if (candidates.length === 0) {
    throw new ConfigDiscoveryError(
      "CONFIG_NOT_FOUND",
      `No UIWitness config found in ${root}.`,
      {
        candidates: DEFAULT_CONFIG_FILENAMES.map((filename) =>
          resolve(root, filename),
        ),
      },
    );
  }
  if (candidates.length > 1) {
    throw new ConfigDiscoveryError(
      "CONFIG_AMBIGUOUS",
      `Multiple UIWitness configs found in ${root}. Pass an explicit config path.`,
      { candidates },
    );
  }
  return candidates[0]!;
}

/** Loads one config whose entire path stays inside the guard workspace. */
export async function loadGuardConfig(
  root: string,
  configPath: string | undefined,
): Promise<LoadedConfig> {
  const candidate = configPath === undefined
    ? await defaultGuardConfigPath(root)
    : resolve(root, configPath);
  const contained = await containedRegularFile(
    root,
    candidate,
    "GUARD_CONFIG_PATH_INVALID",
    "Guard config path",
  );
  return loadConfig({ configPath: contained, cwd: root });
}

/** Builds the exact browser-independent inventory governed by config fingerprint v1. */
export async function guardConfiguration(
  config: UIWitnessConfig,
  configPath: string,
  root: string,
): Promise<readonly ContractConfigurationCoordinate[]> {
  const policy = {
    consoleError: config.failOn?.consoleError ?? defaultFailurePolicy.consoleError,
    failedRequest: config.failOn?.failedRequest ?? defaultFailurePolicy.failedRequest,
    pageError: config.failOn?.pageError ?? defaultFailurePolicy.pageError,
  };
  const authentication = config.authentication === undefined
    ? undefined
    : {
        additionalOrigins: Object.freeze(
          [...(config.authentication.additionalOrigins ?? [])].sort(),
        ),
        cookieScopes: Object.freeze(
          (config.authentication.cookieScopes ?? [])
            .map((scope) => Object.freeze({
              domain: scope.domain,
              partitionKeys: Object.freeze(
                [...(scope.partitionKeys ?? [])].sort(),
              ),
              pathPrefix: scope.pathPrefix,
              secure: scope.secure,
            }))
            .sort((left, right) => {
              if (left.domain < right.domain) return -1;
              if (left.domain > right.domain) return 1;
              if (left.pathPrefix < right.pathPrefix) return -1;
              if (left.pathPrefix > right.pathPrefix) return 1;
              return 0;
            }),
        ),
        mode: config.authentication.mode ?? "shared-readonly",
        setup: posixRelative(
          root,
          await containedRegularFile(
            root,
            resolve(dirname(configPath), config.authentication.setup),
            "GUARD_AUTH_SETUP_PATH_INVALID",
            "Guard authentication setup path",
          ),
        ),
      };
  const coordinates: ContractConfigurationCoordinate[] = [];

  for (const route of config.routes) {
    for (const state of route.states) {
      const scenarioPath = await containedRegularFile(
        root,
        resolve(dirname(configPath), state.setup),
        "GUARD_SCENARIO_PATH_INVALID",
        "Guard scenario path",
      );
      const scenarioSource = posixRelative(root, scenarioPath);
      const routePath = sanitizedRoutePath(route.path);
      for (const [viewportId, viewport] of Object.entries(config.viewports)) {
        for (const theme of config.themes) {
          const identity = {
            routeId: route.id,
            stateId: state.id,
            theme,
            viewportId,
          };
          const fingerprintV1 = {
            consoleError: policy.consoleError,
            failedRequest: policy.failedRequest,
            height: viewport.height,
            pageError: policy.pageError,
            routeId: route.id,
            routePath,
            scenarioSource,
            stateId: state.id,
            theme,
            viewportId,
            width: viewport.width,
          };
          const configFingerprint = canonicalJsonDigest(
            authentication === undefined && config.evidence === undefined
              ? fingerprintV1
              : {
                  ...fingerprintV1,
                  ...(authentication === undefined ? {} : { authentication }),
                  evidence: {
                    masks: [...(config.evidence?.masks ?? [])]
                      .map((mask) => ({
                        count: mask.count ?? null,
                        id: mask.id,
                        required: mask.required ?? true,
                        routeIds: [...(mask.routeIds ?? [])].sort(),
                        selector: mask.selector,
                        stateIds: [...(mask.stateIds ?? [])].sort(),
                      }))
                      .sort((left, right) => left.id < right.id ? -1 : left.id > right.id ? 1 : 0),
                    retention: config.evidence?.retention ?? "all",
                  },
                  fingerprintVersion: 2,
                },
          );
          coordinates.push({
            configFingerprint,
            id: coordinateId(identity),
            routeId: route.id,
            routePath,
            scenarioSource,
            stateId: state.id,
            theme,
            viewport: Object.freeze({ ...viewport }),
            viewportId,
          });
        }
      }
    }
  }
  return Object.freeze(coordinates.sort(configurationOrder).map((coordinate) =>
    Object.freeze(coordinate)
  ));
}

export function contractObservations(
  report: AnyUIWitnessReport,
): readonly ContractExecutionObservation[] {
  return Object.freeze(report.executions.map((execution) => Object.freeze({
    failures: Object.freeze(execution.failures.map(({ code }) =>
      Object.freeze({ code })
    )),
    routeId: execution.routeId,
    stateId: execution.stateId,
    status: execution.status,
    theme: execution.theme,
    viewportId: execution.viewportId,
  })));
}

export function contractSourceExecutions(
  report: AnyUIWitnessReport,
): readonly ContractSourceExecution[] {
  return Object.freeze(report.executions.map((execution) => Object.freeze({
    actual: execution.status === "passed"
      ? Object.freeze({ status: "passed" as const })
      : Object.freeze({
          failureCodes: Object.freeze([
            ...new Set(execution.failures.map(({ code }) => code)),
          ].sort()),
          status: "failed" as const,
        }),
    id: coordinateId(execution),
  })));
}

export function reportIsComplete(
  configuration: readonly ContractConfigurationCoordinate[],
  report: AnyUIWitnessReport,
): boolean {
  if (configuration.length !== report.executions.length) {
    return false;
  }
  const expected = new Set(configuration.map(({ id }) => id));
  return report.executions.every((execution) =>
    expected.delete(coordinateId(execution))
  ) && expected.size === 0;
}

function sortedStrings(values: readonly string[]): readonly string[] {
  return [...values].sort();
}

function lexicalCompare(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

function runProjection(
  configuration: readonly ContractConfigurationCoordinate[],
  report: AnyUIWitnessReport,
): JsonValue {
  const configurationById = new Map(
    configuration.map((coordinate) => [coordinate.id, coordinate]),
  );
  const executions = [...report.executions]
    .sort((left, right) => lexicalCompare(coordinateId(left), coordinateId(right)))
    .map((execution) => {
      const id = coordinateId(execution);
      const configured = configurationById.get(id);
      return {
        diagnostics: {
          consoleErrors: sortedStrings(execution.diagnostics.consoleErrors),
          failedRequests: [...execution.diagnostics.failedRequests]
            .sort((left, right) => lexicalCompare(JSON.stringify(left), JSON.stringify(right)))
            .map(({ errorText, method, url }) => ({ errorText, method, url })),
          navigationStatus: execution.diagnostics.navigationStatus,
          pageErrors: sortedStrings(execution.diagnostics.pageErrors),
        },
        evidenceId: evidenceId(execution),
        failureCodes: sortedStrings([
          ...new Set(execution.failures.map(({ code }) => code)),
        ]),
        id,
        routePath: configured?.routePath ?? sanitizedRoutePath(execution.routePath),
        scenarioSource: configured?.scenarioSource ?? execution.scenarioSource,
        status: execution.status,
        viewport: {
          height: execution.viewport.height,
          width: execution.viewport.width,
        },
      };
    });
  return {
    coverage: report.summary.coverage as unknown as JsonValue,
    executions,
    reportSchemaVersion: report.schemaVersion,
  };
}

/** Hashes the normalized semantic projection of one fresh schema-v1 report. */
export function guardRunDigest(
  configuration: readonly ContractConfigurationCoordinate[],
  report: AnyUIWitnessReport,
): Sha256Digest {
  return canonicalJsonDigest(runProjection(configuration, report));
}

type ShellPlatform = "posix" | "windows";

function posixShellWord(value: string): string {
  if (/^[A-Za-z0-9_./:@%+=,-]+$/u.test(value)) {
    return value;
  }
  return `'${value.replaceAll("'", `'"'"'`)}'`;
}

function powershellWord(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

function windowsShellCommand(args: readonly string[]): string {
  const script = `& ${args.map(powershellWord).join(" ")}; exit $LASTEXITCODE`;
  const encoded = Buffer.from(script, "utf16le").toString("base64");
  return `powershell.exe -NoLogo -NoProfile -NonInteractive -EncodedCommand ${encoded}`;
}

/** @internal Builds the copy/paste command for one executable finding. */
export function guardReproduceCommand(
  id: string,
  explicitConfigPath: string | undefined,
  platform: ShellPlatform = process.platform === "win32" ? "windows" : "posix",
): string {
  const args = [
    platform === "windows"
      ? "node_modules\\.bin\\uiwitness.cmd"
      : "./node_modules/.bin/uiwitness",
    "scan",
    "--coordinate",
    id,
    "--headed",
  ];
  if (explicitConfigPath !== undefined) {
    args.push("--config", explicitConfigPath);
  }
  return platform === "windows"
    ? windowsShellCommand(args)
    : args.map(posixShellWord).join(" ");
}

/** @internal Builds the copy/paste proposal inspection command for one finding. */
export function guardRemediateCommand(
  changeId: string,
  proposalPath: string,
  platform: ShellPlatform = process.platform === "win32" ? "windows" : "posix",
): string {
  const args = [
    platform === "windows"
      ? "node_modules\\.bin\\uiwitness.cmd"
      : "./node_modules/.bin/uiwitness",
    "contract",
    "inspect",
    "--candidate",
    proposalPath,
    "--change",
    changeId,
  ];
  return platform === "windows"
    ? windowsShellCommand(args)
    : args.map(posixShellWord).join(" ");
}

function machineFinding(
  finding: ContractFinding,
  explicitConfigPath: string | undefined,
  proposalPath: string | undefined,
): JsonValue {
  const copy = { ...finding } as Record<string, JsonValue>;
  if (
    finding.id !== null &&
    (finding.kind === "regression" ||
      finding.kind === "changed-known-failure" ||
      finding.kind === "recovered-known-failure")
  ) {
    copy["reproduce"] = guardReproduceCommand(finding.id, explicitConfigPath);
  }
  if (proposalPath !== undefined && finding.id !== null && finding.kind !== "matched" && finding.kind !== "matched-known-failure") {
    const operation = finding.kind === "unaccepted-addition"
      ? "add"
      : finding.kind === "missing-coordinate"
        ? "remove"
        : finding.kind === "unaccepted-config-drift"
          ? "config"
          : finding.kind === "expired-exception" ? "exception" : "expectation";
    copy["remediate"] = guardRemediateCommand(
      `${operation}:${finding.id}`,
      proposalPath,
    );
  }
  return copy;
}

export interface GuardMachineVerdict {
  readonly complete: boolean;
  readonly configDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly evaluatedOn: string;
  readonly findings: readonly JsonValue[];
  readonly runDigest: Sha256Digest;
  readonly schemaVersion: 1;
  readonly verdict: ContractComparisonResult["verdict"];
}

export function guardMachineVerdict(
  comparison: ContractComparisonResult,
  runDigest: Sha256Digest,
  explicitConfigPath: string | undefined,
  proposalPath?: string | undefined,
): GuardMachineVerdict {
  return Object.freeze({
    complete: comparison.complete,
    configDigest: comparison.configDigest,
    contractDigest: comparison.contractDigest,
    evaluatedOn: comparison.evaluatedOn,
    findings: Object.freeze(comparison.findings.map((finding) =>
      machineFinding(finding, explicitConfigPath, proposalPath)
    )),
    runDigest,
    schemaVersion: 1,
    verdict: comparison.verdict,
  });
}

export function compareGuardInputs(
  contract: UIWitnessContract,
  configuration: readonly ContractConfigurationCoordinate[],
  report: AnyUIWitnessReport,
  evaluatedAt: Date,
): ContractComparisonResult {
  return compareContract({
    complete: reportIsComplete(configuration, report),
    configuration,
    contract,
    executions: contractObservations(report),
    now: () => new Date(evaluatedAt.valueOf()),
  });
}
