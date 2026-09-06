import { readFile } from "node:fs/promises";
import { relative } from "node:path";

import {
  CONTRACT_FAILURE_CODES,
  ConfigValidationError,
  ContractProposalValidationError,
  ContractValidationError,
  GenerationValidationError,
  ResultValidationError,
  ShardValidationError,
  contractExceptionLifecycle,
  parseShardSpecifier,
  type ContractActualOutcome,
  type ContractExpectation,
  type ContractFinding,
  type ContractProposalChange,
} from "uiwitness-core";

import {
  CheckError,
  checkPublicSite,
  type CheckResult,
} from "./check.js";
import {
  ConfigDiscoveryError,
  ConfigLoadError,
} from "./config.js";
import {
  acceptContractChanges,
  annotateContractChange,
  initContract,
  inspectContractChange,
  type ContractAcceptOptions,
  type ContractAnnotateOptions,
  type ContractInitOptions,
  type ContractInspectOptions,
} from "./contract.js";
import { InitError, initProject } from "./init.js";
import {
  GuardError,
  guardProject,
  type GuardResult,
} from "./guard.js";
import {
  createGuardShardPlan,
  runGuardShard,
  type GuardShardPlanResult,
  type GuardShardResult,
} from "./guard-shard.js";
import {
  mergeGuardShards,
  type GuardMergeResult,
} from "./guard-merge.js";
import { OpenReportError, openReport } from "./open.js";
import { ScanError, scanProject, type ScanResult } from "./scan.js";

const HELP = `UIWitness

Usage:
  uiwitness init
  uiwitness check <url> [--max-pages <1-20>] [--headed] [--write-config]
  uiwitness scan [--config <path>] [--route <id> | --coordinate <route/state/viewport/theme>] [--headed]
  uiwitness guard [--config <path>] [--contract <path>] [--json <path>]
  uiwitness guard shard-plan --shards <M> --out <path> [--config <path>] [--contract <path>] [--environment-id <id>] [--ttl <5m-1440m>]
  uiwitness guard --shard <N/M> --shard-plan <path> [--config <path>] [--contract <path>]
  uiwitness guard merge --input <shard-bundle>... [--config <path>] [--contract <path>]
  uiwitness contract init [--config <path>] [--contract <path>]
  uiwitness contract inspect --candidate <path> --change <id>
  uiwitness contract annotate --candidate <path> --change <id> --owner <text> --reason <text> --created-on <date> --expires-on <date>
  uiwitness contract accept --candidate <path> --change <id>... [--config <path>] [--contract <path>]
  uiwitness open
  uiwitness --version
  uiwitness --help

Commands:
  init  Create a starter config and scenario without overwriting files
  check Discover and inspect a public site without configuration
  scan  Execute configured UI states and persist screenshots, JSON, and HTML
  guard Run the complete matrix or produce deterministic partial shard bundles
  contract Initialize, inspect, annotate, or accept named contract changes
  open  Open the latest generated offline HTML report

Safety:
  Check only websites you own or are authorized to test.
`;

const maximumGuardTerminalFindings = 20;

async function cliVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new TypeError("UIWitness package version is unavailable.");
  }
  return manifest.version;
}

/** Stable process outcomes exposed by the current command foundation. */
export type CliExitCode = 0 | 1 | 2;

/** Injectable command environment for embedding and deterministic tests. */
export interface RunCliOptions {
  readonly args?: readonly string[] | undefined;
  readonly cwd?: string | undefined;
  readonly stderr?: ((message: string) => void) | undefined;
  readonly stdout?: ((message: string) => void) | undefined;
}

function displayPath(projectRoot: string, path: string): string {
  const localPath = relative(projectRoot, path);
  return localPath.length === 0 ? "." : localPath;
}

interface ParsedScanArguments {
  readonly coordinate?: string | undefined;
  readonly configPath?: string | undefined;
  readonly headed: boolean;
  readonly routeId?: string | undefined;
}

type ParsedGuardArguments =
  | {
      readonly command: "complete";
      readonly configPath?: string | undefined;
      readonly contractPath?: string | undefined;
      readonly jsonPath?: string | undefined;
    }
  | {
      readonly command: "merge";
      readonly configPath?: string | undefined;
      readonly contractPath?: string | undefined;
      readonly inputs: readonly string[];
    }
  | {
      readonly command: "shard";
      readonly configPath?: string | undefined;
      readonly contractPath?: string | undefined;
      readonly shard: string;
      readonly shardPlanPath: string;
    }
  | {
      readonly command: "shard-plan";
      readonly configPath?: string | undefined;
      readonly contractPath?: string | undefined;
      readonly environmentId?: string | undefined;
      readonly outPath: string;
      readonly shards: number;
      readonly ttlMinutes?: number | undefined;
    };

type ParsedContractArguments =
  | ({ readonly command: "accept" } & ContractAcceptOptions)
  | ({ readonly command: "annotate" } & ContractAnnotateOptions)
  | ({ readonly command: "init" } & ContractInitOptions)
  | ({ readonly command: "inspect" } & ContractInspectOptions);

interface ParsedCheckArguments {
  readonly headed: boolean;
  readonly maxPages?: number | undefined;
  readonly url: string;
  readonly writeConfig: boolean;
}

function terminalText(value: string): string {
  let safe = "";
  for (const character of value) {
    const codePoint = character.codePointAt(0)!;
    if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      /\p{Default_Ignorable_Code_Point}/u.test(character)
    ) {
      if (character === "\n") {
        safe += "\\n";
      } else if (character === "\r") {
        safe += "\\r";
      } else if (character === "\t") {
        safe += "\\t";
      } else {
        safe += `\\u{${codePoint.toString(16).padStart(4, "0")}}`;
      }
    } else {
      safe += character;
    }
  }
  return safe;
}

function inspectJson(value: unknown): string {
  return JSON.stringify(
    value,
    (_key, nested) => typeof nested === "string" ? terminalText(nested) : nested,
    2,
  ) ?? "undefined";
}

function parseScanArguments(
  args: readonly string[],
): ParsedScanArguments | string {
  let configPath: string | undefined;
  let coordinate: string | undefined;
  let headed = false;
  let routeId: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--headed") {
      if (headed) {
        return "The --headed option can be specified only once.";
      }
      headed = true;
      continue;
    }
    if (
      argument === "--config" ||
      argument === "--coordinate" ||
      argument === "--route"
    ) {
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return `The ${argument} option requires a value.`;
      }
      if (argument === "--config") {
        if (configPath !== undefined) {
          return "The --config option can be specified only once.";
        }
        configPath = value;
      } else if (argument === "--coordinate") {
        if (coordinate !== undefined) {
          return "The --coordinate option can be specified only once.";
        }
        coordinate = value;
      } else {
        if (routeId !== undefined) {
          return "The --route option can be specified only once.";
        }
        routeId = value;
      }
      index += 1;
      continue;
    }
    return `Unknown scan option: ${argument}`;
  }

  if (coordinate !== undefined && routeId !== undefined) {
    return "The --coordinate and --route options cannot be combined.";
  }

  return Object.freeze({ configPath, coordinate, headed, routeId });
}

function parseGuardArguments(
  args: readonly string[],
): ParsedGuardArguments | string {
  if (args[0] === "merge") {
    const parsed = parseNamedOptions(
      args.slice(1),
      new Set(["--config", "--contract", "--input"]),
      new Set(["--input"]),
      "guard merge",
    );
    if (typeof parsed === "string") return parsed;
    const inputs = parsed.get("--input") ?? [];
    if (inputs.length === 0) return "The guard merge command requires at least one --input bundle.";
    if (inputs.length > 10_000) return "The guard merge command accepts at most 10000 --input bundles.";
    const configPath = optionValue(parsed, "--config");
    const contractPath = optionValue(parsed, "--contract");
    return Object.freeze({
      command: "merge" as const,
      ...(configPath === undefined ? {} : { configPath }),
      ...(contractPath === undefined ? {} : { contractPath }),
      inputs: Object.freeze([...inputs]),
    });
  }
  if (args[0] === "shard-plan") {
    const parsed = parseNamedOptions(
      args.slice(1),
      new Set(["--config", "--contract", "--environment-id", "--out", "--shards", "--ttl"]),
      new Set(),
      "guard shard-plan",
    );
    if (typeof parsed === "string") return parsed;
    const outPath = optionValue(parsed, "--out");
    const shardsSource = optionValue(parsed, "--shards");
    if (outPath === undefined || shardsSource === undefined) {
      return "The guard shard-plan command requires --shards and --out.";
    }
    if (!/^(?:[1-9][0-9]{0,3}|10000)$/u.test(shardsSource)) {
      return "The --shards option must be a whole number from 1 through 10000.";
    }
    const ttlSource = optionValue(parsed, "--ttl");
    if (ttlSource !== undefined && !/^(?:[5-9]|[1-9][0-9]{1,2}|1[0-3][0-9]{2}|14[0-3][0-9]|1440)m$/u.test(ttlSource)) {
      return "The --ttl option must use whole minutes from 5m through 1440m.";
    }
    const configPath = optionValue(parsed, "--config");
    const contractPath = optionValue(parsed, "--contract");
    const environmentId = optionValue(parsed, "--environment-id");
    return Object.freeze({
      command: "shard-plan" as const,
      ...(configPath === undefined ? {} : { configPath }),
      ...(contractPath === undefined ? {} : { contractPath }),
      ...(environmentId === undefined ? {} : { environmentId }),
      outPath,
      shards: Number(shardsSource),
      ...(ttlSource === undefined ? {} : { ttlMinutes: Number(ttlSource.slice(0, -1)) }),
    });
  }
  let configPath: string | undefined;
  let contractPath: string | undefined;
  let jsonPath: string | undefined;
  let shard: string | undefined;
  let shardPlanPath: string | undefined;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (
      argument !== "--config" &&
      argument !== "--contract" &&
      argument !== "--json" &&
      argument !== "--shard" &&
      argument !== "--shard-plan"
    ) {
      return `Unknown guard option: ${argument}`;
    }
    const value = args[index + 1];
    if (value === undefined || value.startsWith("--")) {
      return `The ${argument} option requires a value.`;
    }
    if (argument === "--config") {
      if (configPath !== undefined) {
        return "The --config option can be specified only once.";
      }
      configPath = value;
    } else if (argument === "--contract") {
      if (contractPath !== undefined) {
        return "The --contract option can be specified only once.";
      }
      contractPath = value;
    } else if (argument === "--json") {
      if (jsonPath !== undefined) {
        return "The --json option can be specified only once.";
      }
      jsonPath = value;
    } else if (argument === "--shard") {
      if (shard !== undefined) return "The --shard option can be specified only once.";
      shard = value;
    } else {
      if (shardPlanPath !== undefined) return "The --shard-plan option can be specified only once.";
      shardPlanPath = value;
    }
    index += 1;
  }
  if ((shard === undefined) !== (shardPlanPath === undefined)) {
    return "The --shard and --shard-plan options must be provided together.";
  }
  if (shard !== undefined) {
    if (jsonPath !== undefined) return "The --json option cannot be combined with a shard run.";
    try {
      parseShardSpecifier(shard);
    } catch (error: unknown) {
      if (error instanceof ShardValidationError) {
        return "The --shard option must use the exact one-based N/M form.";
      }
      throw error;
    }
    return Object.freeze({ command: "shard", configPath, contractPath, shard, shardPlanPath: shardPlanPath! });
  }
  return Object.freeze({ command: "complete", configPath, contractPath, jsonPath });
}

function parseNamedOptions(
  args: readonly string[],
  allowed: ReadonlySet<string>,
  repeated: ReadonlySet<string> = new Set(),
  label = "contract",
): ReadonlyMap<string, readonly string[]> | string {
  const values = new Map<string, string[]>();
  for (let index = 0; index < args.length; index += 2) {
    const option = args[index]!;
    const value = args[index + 1];
    if (!allowed.has(option)) return `Unknown ${label} option: ${option}`;
    if (value === undefined || value.startsWith("--")) {
      return `The ${option} option requires a value.`;
    }
    const existing = values.get(option) ?? [];
    if (existing.length > 0 && !repeated.has(option)) {
      return `The ${option} option can be specified only once.`;
    }
    existing.push(value);
    values.set(option, existing);
  }
  return values;
}

function optionValue(
  values: ReadonlyMap<string, readonly string[]>,
  option: string,
): string | undefined {
  return values.get(option)?.[0];
}

function parseContractArguments(
  args: readonly string[],
): ParsedContractArguments | string {
  const command = args[0];
  if (command === undefined) return "The contract command requires a subcommand.";
  const rest = args.slice(1);
  if (command === "init") {
    const parsed = parseNamedOptions(rest, new Set(["--config", "--contract"]));
    if (typeof parsed === "string") return parsed;
    const configPath = optionValue(parsed, "--config");
    const contractPath = optionValue(parsed, "--contract");
    return {
      command,
      ...(configPath === undefined ? {} : { configPath }),
      ...(contractPath === undefined ? {} : { contractPath }),
    };
  }
  if (command === "inspect") {
    const parsed = parseNamedOptions(rest, new Set(["--candidate", "--change"]));
    if (typeof parsed === "string") return parsed;
    const candidatePath = optionValue(parsed, "--candidate");
    const changeId = optionValue(parsed, "--change");
    if (candidatePath === undefined || changeId === undefined) {
      return "The contract inspect command requires --candidate and --change.";
    }
    return { candidatePath, changeId, command };
  }
  if (command === "annotate") {
    const parsed = parseNamedOptions(rest, new Set([
      "--candidate",
      "--change",
      "--owner",
      "--reason",
      "--created-on",
      "--expires-on",
    ]));
    if (typeof parsed === "string") return parsed;
    const candidatePath = optionValue(parsed, "--candidate");
    const changeId = optionValue(parsed, "--change");
    const owner = optionValue(parsed, "--owner");
    const reason = optionValue(parsed, "--reason");
    const createdOn = optionValue(parsed, "--created-on");
    const expiresOn = optionValue(parsed, "--expires-on");
    if ([candidatePath, changeId, owner, reason, createdOn, expiresOn].some((value) => value === undefined)) {
      return "The contract annotate command requires --candidate, --change, --owner, --reason, --created-on, and --expires-on.";
    }
    return {
      candidatePath: candidatePath!,
      changeId: changeId!,
      command,
      createdOn: createdOn!,
      expiresOn: expiresOn!,
      owner: owner!,
      reason: reason!,
    };
  }
  if (command === "accept") {
    const parsed = parseNamedOptions(
      rest,
      new Set(["--candidate", "--change", "--config", "--contract"]),
      new Set(["--change"]),
    );
    if (typeof parsed === "string") return parsed;
    const candidatePath = optionValue(parsed, "--candidate");
    const changeIds = parsed.get("--change") ?? [];
    if (candidatePath === undefined || changeIds.length === 0) {
      return "The contract accept command requires --candidate and at least one --change.";
    }
    const configPath = optionValue(parsed, "--config");
    const contractPath = optionValue(parsed, "--contract");
    return {
      candidatePath,
      changeIds,
      command,
      ...(configPath === undefined ? {} : { configPath }),
      ...(contractPath === undefined ? {} : { contractPath }),
    };
  }
  return `Unknown contract subcommand: ${command}`;
}

function parseCheckArguments(
  args: readonly string[],
): ParsedCheckArguments | string {
  let headed = false;
  let maxPages: number | undefined;
  let url: string | undefined;
  let writeConfig = false;

  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index]!;
    if (argument === "--headed") {
      if (headed) {
        return "The --headed option can be specified only once.";
      }
      headed = true;
      continue;
    }
    if (argument === "--max-pages") {
      if (maxPages !== undefined) {
        return "The --max-pages option can be specified only once.";
      }
      const value = args[index + 1];
      if (value === undefined || value.startsWith("--")) {
        return "The --max-pages option requires a value.";
      }
      if (!/^(?:[1-9]|1[0-9]|20)$/u.test(value)) {
        return "The --max-pages option must be an integer between 1 and 20.";
      }
      maxPages = Number(value);
      index += 1;
      continue;
    }
    if (argument === "--write-config") {
      if (writeConfig) {
        return "The --write-config option can be specified only once.";
      }
      writeConfig = true;
      continue;
    }
    if (argument.startsWith("--")) {
      return `Unknown check option: ${argument}`;
    }
    if (url !== undefined) {
      return "The check command accepts exactly one URL.";
    }
    url = argument;
  }

  if (url === undefined) {
    return "The check command requires a public website URL.";
  }
  try {
    const parsedURL = new URL(url);
    if (
      (parsedURL.protocol !== "http:" && parsedURL.protocol !== "https:") ||
      parsedURL.username.length > 0 ||
      parsedURL.password.length > 0
    ) {
      return "The check URL must be absolute HTTP(S) without credentials.";
    }
  } catch {
    return "The check URL must be a valid absolute HTTP(S) URL.";
  }

  return Object.freeze({ headed, maxPages, url, writeConfig });
}

function routeTitle(routeId: string): string {
  return routeId
    .split("-")
    .map((segment) => `${segment[0]!.toUpperCase()}${segment.slice(1)}`)
    .join(" ");
}

/** Formats one completed scan without reading filenames for metadata. */
export function formatScanSummary(result: ScanResult): string {
  const lines = ["UIWitness", ""];
  let previousRouteId: string | undefined;

  for (const execution of result.report.executions) {
    if (execution.routeId !== previousRouteId) {
      if (previousRouteId !== undefined) {
        lines.push("");
      }
      lines.push(routeTitle(execution.routeId));
      previousRouteId = execution.routeId;
    }
    const marker = execution.status === "passed" ? "✓" : "✗";
    lines.push(
      `  ${marker} ${execution.stateId} · ${execution.viewportId} · ${execution.theme}`,
    );
    for (const failure of execution.failures) {
      lines.push(`      ${failure.code}: ${terminalText(failure.message)}`);
    }
  }

  const { executions, failed } = result.report.summary;
  lines.push(
    "",
    `Coverage: ${result.report.summary.coverage.execution.percentage}%`,
    `Report: ${result.htmlReportPath}`,
    failed === 0
      ? `All ${executions} execution${executions === 1 ? "" : "s"} passed.`
      : `${failed} of ${executions} execution${executions === 1 ? "" : "s"} failed.`,
  );
  return `${lines.join("\n")}\n`;
}

function quantity(
  count: number,
  singular: string,
  plural = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : plural}`;
}

function contractOutcomeLabel(
  outcome: ContractActualOutcome | ContractExpectation | null,
): string {
  if (outcome === null) return "not present";
  return outcome.status === "passed"
    ? "passed"
    : `failed (${outcome.failureCodes.join(", ")})`;
}

function exceptionLifecycleLabel(
  exception: Extract<ContractExpectation, { readonly status: "failed" }>["exception"],
  evaluatedOn: string,
): string {
  const lifecycle = contractExceptionLifecycle(exception, evaluatedOn);
  if (lifecycle.status === "expired") {
    return `expired ${quantity(Math.abs(lifecycle.daysUntilExpiry), "UTC day")} ago`;
  }
  if (lifecycle.daysUntilExpiry === 0) {
    return "expires today; active through 23:59:59.999 UTC";
  }
  return `expires in ${quantity(lifecycle.daysUntilExpiry, "UTC day")}`;
}

function exceptionEligible(outcome: ContractActualOutcome | null): boolean {
  return outcome?.status === "failed" && outcome.failureCodes.every((code) =>
    (CONTRACT_FAILURE_CODES as readonly string[]).includes(code)
  );
}

function governanceGuidance(
  finding: ContractFinding,
  evaluatedOn: string,
): string | undefined {
  const expected = "expected" in finding ? finding.expected : null;
  const actual = "actual" in finding ? finding.actual : null;
  switch (finding.kind) {
    case "matched-known-failure":
      return expected?.status === "failed" &&
          contractExceptionLifecycle(expected.exception, evaluatedOn).status === "expired"
        ? "The exact failure-code set still matches, but the exception is expired."
        : "The exception applies only to this exact failure-code set.";
    case "changed-known-failure":
      return exceptionEligible(actual)
        ? "The failure-code set changed; review and annotate a new expectation."
        : "The failure includes an ineligible code; repair it because it cannot become a known failure.";
    case "recovered-known-failure":
      return "The state recovered; accept the expectation change to remove contract debt.";
    case "expired-exception":
      if (actual?.status === "passed") {
        return "The state recovered; accept the expectation change to remove contract debt.";
      }
      if (!exceptionEligible(actual)) {
        return "The failure includes an ineligible code; repair it because it cannot become a known failure.";
      }
      if (
        actual?.status === "failed" &&
        expected?.status === "failed" &&
        actual.failureCodes.join("\u0000") !== expected.failureCodes.join("\u0000")
      ) {
        return "The failure-code set changed; review and annotate a new expectation.";
      }
      return "Repair the state, or explicitly renew with a new reason and a 1–30 day window.";
    default:
      return undefined;
  }
}

function inspectLifecycleGuidance(change: ContractProposalChange): string | undefined {
  if (change.operation === "exception") {
    return "Renewal requires a new annotation reason and current 1–30 day window before accepting this named change.";
  }
  if (change.operation !== "expectation") return undefined;
  const before = change.before as Readonly<Record<string, unknown>> | null;
  const after = change.after as Readonly<Record<string, unknown>> | null;
  if (before?.["status"] === "failed" && after?.["status"] === "passed") {
    return "Recovery removes the known-failure expectation; accept this named change after reviewing the fresh pass.";
  }
  if (before?.["status"] === "failed" && after?.["status"] === "failed") {
    const failureCodes = after["failureCodes"];
    const eligible = Array.isArray(failureCodes) && failureCodes.every((code) =>
      typeof code === "string" &&
      (CONTRACT_FAILURE_CODES as readonly string[]).includes(code)
    );
    return eligible
      ? "Changed failure codes require a new owner, reason, and 1–30 day exception before acceptance."
      : "This failure includes an ineligible code and cannot be annotated or accepted as a known failure; repair it instead.";
  }
  return undefined;
}

/** Formats one completed public-site Quick Check without exposing diagnostics. */
export function formatCheckSummary(result: CheckResult): string {
  const executions = result.report.executions;
  const routePaths = [
    ...new Set(executions.map((execution) => execution.routePath)),
  ];
  const issueCount = executions.reduce(
    (total, execution) => total + execution.failures.length,
    0,
  );
  const lines = [
    "UIWitness Quick Check",
    "",
    `Site: ${terminalText(result.discovery.baseURL)}`,
    `Pages: ${result.discovery.routes.length} discovered · ${routePaths.length} scanned · ${result.discovery.skippedPages} skipped`,
    `Discovery: ${quantity(result.discovery.attemptedPages, "page")} attempted · ${quantity(result.discovery.truncatedAnchorPages, "anchor page")} truncated`,
  ];

  for (const routePath of routePaths) {
    const routeExecutions = executions.filter(
      (execution) => execution.routePath === routePath,
    );
    const failed = routeExecutions.filter(
      (execution) => execution.status === "failed",
    );
    const routeIssues = failed.reduce(
      (total, execution) => total + execution.failures.length,
      0,
    );
    lines.push("", terminalText(routePath));
    if (failed.length === 0) {
      lines.push(`  ✓ All ${quantity(routeExecutions.length, "check")} passed.`);
      continue;
    }
    lines.push(
      `  ✗ ${failed.length} of ${quantity(routeExecutions.length, "check")} failed · ${quantity(routeIssues, "issue")}`,
    );
    for (const execution of failed) {
      for (const failure of execution.failures) {
        lines.push(
          `      ${terminalText(execution.viewportId)} · ${terminalText(execution.theme)} · ${terminalText(failure.code)}: ${terminalText(failure.message)}`,
        );
      }
    }
  }

  const { executions: executionCount, failed } = result.report.summary;
  lines.push(
    "",
    `Coverage: ${result.report.summary.coverage.execution.percentage}%`,
    `Issues: ${quantity(issueCount, "issue")} across ${quantity(executionCount, "check")}.`,
    `Report: ${result.htmlReportPath}`,
    failed === 0
      ? `All ${quantity(executionCount, "check")} passed.`
      : `${failed} of ${quantity(executionCount, "check")} failed.`,
  );
  if (result.setup === undefined) {
    lines.push(
      "",
      `Next: Open the report, then save this surface with \`npx uiwitness check ${terminalText(result.discovery.baseURL)} --write-config\`.`,
    );
  } else {
    lines.push(
      "",
      "Saved the discovered public surface.",
      "Created:",
      `  ${displayPath(result.setup.projectRoot, result.setup.configPath)}`,
      `  ${displayPath(result.setup.projectRoot, result.setup.scenarioPath)}`,
      "",
      "Next: add real product states, then run `npx uiwitness scan`.",
    );
  }
  return `${lines.join("\n")}\n`;
}

/** Formats one contract comparison without exposing captured diagnostics. */
export function formatGuardSummary(result: GuardResult): string {
  const labels = {
    error: "RUN INVALID",
    failed: "CONTRACT FAILED",
    passed: "PROMISE KEPT",
  } as const;
  const lines = [
    "UIWitness Contract Guard",
    "",
    `Verdict: ${labels[result.comparison.verdict]}`,
    `Evaluated: ${result.comparison.evaluatedOn} UTC`,
  ];
  const visibleFindings = result.comparison.findings.slice(
    0,
    maximumGuardTerminalFindings,
  );
  const describedExceptions = new Set<string>();
  for (const [index, finding] of visibleFindings.entries()) {
    const activeKnownFailure = finding.kind === "matched-known-failure" &&
      finding.expected.status === "failed" &&
      contractExceptionLifecycle(
        finding.expected.exception,
        result.comparison.evaluatedOn,
      ).status === "active";
    const marker = finding.kind === "matched" || activeKnownFailure
      ? "✓"
      : finding.kind === "run-error" ? "!" : "✗";
    lines.push(
      `${marker} ${terminalText(finding.id ?? "run")} · ${finding.kind.toUpperCase()}`,
    );
    if (
      "expected" in finding &&
      finding.expected?.status === "failed"
    ) {
      lines.push(`    Expected: ${contractOutcomeLabel(finding.expected)}`);
      if ("actual" in finding) {
        lines.push(`    Actual: ${contractOutcomeLabel(finding.actual)}`);
      }
      if (!describedExceptions.has(finding.id)) {
        describedExceptions.add(finding.id);
        lines.push(
          `    Exception: ${terminalText(finding.expected.exception.owner)} · ${exceptionLifecycleLabel(finding.expected.exception, result.comparison.evaluatedOn)} · through ${finding.expected.exception.expiresOn}`,
          `    Reason: ${terminalText(finding.expected.exception.reason)}`,
        );
      }
      const guidance = governanceGuidance(
        finding,
        result.comparison.evaluatedOn,
      );
      if (guidance !== undefined) lines.push(`    Next: ${guidance}`);
    }
    const machineFinding = result.machineVerdict.findings[index];
    const findingRecord = machineFinding !== null &&
        typeof machineFinding === "object" &&
        !Array.isArray(machineFinding)
      ? machineFinding as Readonly<Record<string, unknown>>
      : undefined;
    const reproduce = findingRecord?.["reproduce"];
    const remediate = findingRecord?.["remediate"];
    if (
      typeof reproduce === "string"
    ) {
      lines.push(`    Reproduce: ${terminalText(reproduce)}`);
    }
    if (typeof remediate === "string") {
      lines.push(`    Remediate: ${terminalText(remediate)}`);
    }
  }
  if (result.comparison.findings.length > visibleFindings.length) {
    const omitted = result.comparison.findings.length - visibleFindings.length;
    lines.push(
      `… ${quantity(omitted, "finding")} omitted; see the machine verdict.`,
    );
  }
  lines.push(
    "",
    `Findings: ${result.comparison.findings.length}`,
    `Verdict JSON: ${result.verdictPath}`,
  );
  if (result.explicitVerdictPath !== undefined) {
    lines.push(`JSON copy: ${terminalText(result.explicitVerdictPath)}`);
  }
  if (result.proposalPath !== undefined) {
    lines.push(`Proposal: ${terminalText(result.proposalPath)}`);
  }
  if (result.metadataPath !== undefined) {
    lines.push(`Metadata: ${terminalText(result.metadataPath)}`);
  }
  lines.push(
    result.comparison.verdict === "passed"
      ? "The complete configured state contract matched."
      : result.comparison.verdict === "failed"
        ? "The complete run found contract failures or unaccepted drift."
        : "The run was incomplete and cannot prove the contract.",
  );
  return `${lines.join("\n")}\n`;
}

/** Formats a reusable shard plan without exposing target inputs. */
export function formatGuardShardPlanSummary(result: GuardShardPlanResult): string {
  return `${[
    "UIWitness Guard Shard Plan",
    "",
    `Run set: ${result.plan.runSetId}`,
    `Coordinates: ${result.plan.coordinateIds.length}`,
    `Shards: ${result.plan.shardCount}`,
    `Largest shard: ${result.largestShard}`,
    `Expires: ${result.plan.expiresAt}`,
    `Plan: ${terminalText(result.planPath)}`,
    ...(result.warning === undefined ? [] : [`Warning: ${terminalText(result.warning)}`]),
    "Use this exact plan file for every shard.",
  ].join("\n")}\n`;
}

/** Formats a complete partial bundle while reserving verdicts for merge. */
export function formatGuardShardSummary(result: GuardShardResult): string {
  return `${[
    "UIWitness Guard Shard",
    "",
    `Shard: ${result.shardIndex}/${result.shardCount}`,
    `Run set: ${result.runSetId}`,
    `Executions: ${result.total}`,
    `Recorded failures: ${result.failed}`,
    `Bundle: ${terminalText(result.bundlePath)}`,
    "Bundle complete. Run `uiwitness guard merge --input <bundle>...` only after every shard finishes.",
  ].join("\n")}\n`;
}

/** Formats the run-set identity before the ordinary final guard verdict. */
export function formatGuardMergeSummary(result: GuardMergeResult): string {
  return `${[
    "UIWitness Guard Merge",
    "",
    `Run set: ${result.runSetId}`,
    `Shards: ${result.shardCount}`,
    `Inputs: ${result.inputCount}`,
    "",
  ].join("\n")}${formatGuardSummary(result)}`;
}

function expectedScanError(error: unknown): string | undefined {
  if (
    error instanceof ConfigDiscoveryError ||
    error instanceof ConfigLoadError ||
    error instanceof ScanError
  ) {
    return terminalText(error.message);
  }
  return validationError(error);
}

function validationError(error: unknown): string | undefined {
  if (
    !(error instanceof ConfigValidationError) &&
    !(error instanceof ContractProposalValidationError) &&
    !(error instanceof ContractValidationError) &&
    !(error instanceof GenerationValidationError) &&
    !(error instanceof ResultValidationError) &&
    !(error instanceof ShardValidationError)
  ) {
    return undefined;
  }
  return [
    error.message,
    ...error.issues.map(
      (issue) =>
        `  ${terminalText(issue.path)}: ${terminalText(issue.message)} (${issue.code})`,
    ),
  ].join("\n");
}

function expectedGuardError(error: unknown): string | undefined {
  if (
    error instanceof GuardError ||
    error instanceof ConfigDiscoveryError ||
    error instanceof ConfigLoadError ||
    error instanceof ScanError
  ) {
    return terminalText(error.message);
  }
  return validationError(error);
}

/** Parses and executes the currently supported UIWitness command. */
export async function runCli(options: RunCliOptions = {}): Promise<CliExitCode> {
  const args = [...(options.args ?? [])];
  const stdout =
    options.stdout ?? ((message: string) => process.stdout.write(message));
  const stderr =
    options.stderr ?? ((message: string) => process.stderr.write(message));

  if (
    args.length === 1 &&
    (args[0] === "--help" || args[0] === "-h" || args[0] === "help")
  ) {
    stdout(HELP);
    return 0;
  }

  if (args.length === 1 && args[0] === "--version") {
    stdout(`${await cliVersion()}\n`);
    return 0;
  }

  if (args.length === 0) {
    stderr(`Missing command.\n\n${HELP}`);
    return 2;
  }

  if (
    args[0] !== "init" &&
    args[0] !== "check" &&
    args[0] !== "contract" &&
    args[0] !== "guard" &&
    args[0] !== "scan" &&
    args[0] !== "open"
  ) {
    stderr(`Unknown command: ${terminalText(args[0]!)}\n\n${HELP}`);
    return 2;
  }

  if (args[0] === "check") {
    const parsed = parseCheckArguments(args.slice(1));
    if (typeof parsed === "string") {
      stderr(`${terminalText(parsed)}\n\n${HELP}`);
      return 2;
    }
    try {
      const result = await checkPublicSite({ cwd: options.cwd, ...parsed });
      stdout(formatCheckSummary(result));
      return result.report.summary.failed === 0 ? 0 : 1;
    } catch (error: unknown) {
      if (error instanceof CheckError) {
        const targets =
          error.code === "CHECK_SETUP_WRITE_FAILED" && error.paths.length > 0
            ? `\n\nTargets:\n${error.paths
                .map((path) => `  ${terminalText(path)}`)
                .join("\n")}`
            : "";
        stderr(`${terminalText(error.message)}${targets}\n`);
      } else {
        stderr("UIWitness check failed unexpectedly.\n");
      }
      return 2;
    }
  }

  if (args[0] === "guard") {
    const parsed = parseGuardArguments(args.slice(1));
    if (typeof parsed === "string") {
      stderr(`${terminalText(parsed)}\n\n${HELP}`);
      return 2;
    }
    try {
      if (parsed.command === "shard-plan") {
        const result = await createGuardShardPlan({
          configPath: parsed.configPath,
          contractPath: parsed.contractPath,
          cwd: options.cwd,
          environmentId: parsed.environmentId,
          outPath: parsed.outPath,
          shards: parsed.shards,
          ttlMinutes: parsed.ttlMinutes,
        });
        stdout(formatGuardShardPlanSummary(result));
        return 0;
      }
      if (parsed.command === "merge") {
        const result = await mergeGuardShards({
          configPath: parsed.configPath,
          contractPath: parsed.contractPath,
          cwd: options.cwd,
          inputs: parsed.inputs,
        });
        stdout(formatGuardMergeSummary(result));
        return result.comparison.verdict === "passed"
          ? 0
          : result.comparison.verdict === "failed" ? 1 : 2;
      }
      if (parsed.command === "shard") {
        const result = await runGuardShard({
          configPath: parsed.configPath,
          contractPath: parsed.contractPath,
          cwd: options.cwd,
          shard: parsed.shard,
          shardPlanPath: parsed.shardPlanPath,
        });
        stdout(formatGuardShardSummary(result));
        return 0;
      }
      const result = await guardProject({
        configPath: parsed.configPath,
        contractPath: parsed.contractPath,
        cwd: options.cwd,
        jsonPath: parsed.jsonPath,
      });
      stdout(formatGuardSummary(result));
      return result.comparison.verdict === "passed"
        ? 0
        : result.comparison.verdict === "failed" ? 1 : 2;
    } catch (error: unknown) {
      stderr(`${expectedGuardError(error) ?? "UIWitness guard failed unexpectedly."}\n`);
      return 2;
    }
  }

  if (args[0] === "contract") {
    const parsed = parseContractArguments(args.slice(1));
    if (typeof parsed === "string") {
      stderr(`${terminalText(parsed)}\n\n${HELP}`);
      return 2;
    }
    try {
      if (parsed.command === "init") {
        const result = await initContract({
          configPath: parsed.configPath,
          contractPath: parsed.contractPath,
          cwd: options.cwd,
        });
        if (result.status === "created") {
          stdout(`Created state contract: ${terminalText(result.contractPath!)}\n`);
          return 0;
        }
        stdout(
          `Contract initialization found failing states.\nProposal: ${terminalText(result.proposalPath!)}\nMetadata: ${terminalText(result.metadataPath!)}\n`,
        );
        return 1;
      }
      if (parsed.command === "inspect") {
        const result = await inspectContractChange({
          candidatePath: parsed.candidatePath,
          changeId: parsed.changeId,
          cwd: options.cwd,
        });
        const lifecycleGuidance = inspectLifecycleGuidance(result.change);
        stdout([
          `Change: ${terminalText(result.change.id)}`,
          `Proposal: ${terminalText(result.proposalPath)}`,
          ...(lifecycleGuidance === undefined
            ? []
            : ["Exception lifecycle:", lifecycleGuidance]),
          "Before:",
          inspectJson(result.change.before),
          "After:",
          inspectJson(result.change.after),
          "",
        ].join("\n"));
        return 0;
      }
      if (parsed.command === "annotate") {
        const result = await annotateContractChange({
          candidatePath: parsed.candidatePath,
          changeId: parsed.changeId,
          createdOn: parsed.createdOn,
          cwd: options.cwd,
          expiresOn: parsed.expiresOn,
          owner: parsed.owner,
          reason: parsed.reason,
        });
        const lifecycle = contractExceptionLifecycle(
          { expiresOn: parsed.expiresOn },
          parsed.createdOn,
        );
        stdout([
          `Annotated ${terminalText(result.changeId)} in ${terminalText(result.metadataPath)}.`,
          `Owner: ${terminalText(parsed.owner)}`,
          `Reason: ${terminalText(parsed.reason)}`,
          `Window: ${parsed.createdOn} → ${parsed.expiresOn} (${quantity(lifecycle.daysUntilExpiry, "UTC day")})`,
          "Acceptance is named and single-use; dates never renew automatically.",
          "",
        ].join("\n"));
        return 0;
      }
      const result = await acceptContractChanges({
        candidatePath: parsed.candidatePath,
        changeIds: parsed.changeIds,
        configPath: parsed.configPath,
        contractPath: parsed.contractPath,
        cwd: options.cwd,
      });
      stdout([
        `Updated state contract: ${terminalText(result.contractPath)}`,
        `Accepted: ${result.accepted.map(terminalText).join(", ")}`,
        `Discarded: ${result.discarded.length === 0 ? "none" : result.discarded.map(terminalText).join(", ")}`,
        "Proposal consumed. Run `uiwitness guard` to reconsider discarded changes.",
        "",
      ].join("\n"));
      return 0;
    } catch (error: unknown) {
      stderr(`${expectedGuardError(error) ?? "UIWitness contract command failed unexpectedly."}\n`);
      return 2;
    }
  }

  if (args[0] === "scan") {
    const parsed = parseScanArguments(args.slice(1));
    if (typeof parsed === "string") {
      stderr(`${terminalText(parsed)}\n\n${HELP}`);
      return 2;
    }
    try {
      const result = await scanProject({ cwd: options.cwd, ...parsed });
      stdout(formatScanSummary(result));
      return result.report.summary.failed === 0 ? 0 : 1;
    } catch (error: unknown) {
      stderr(`${expectedScanError(error) ?? "UIWitness scan failed unexpectedly."}\n`);
      return 2;
    }
  }

  if (args[0] === "open") {
    if (args.length > 1) {
      stderr(
        `The open command does not accept arguments: ${args
          .slice(1)
          .map(terminalText)
          .join(" ")}\n`,
      );
      return 2;
    }
    try {
      const result = await openReport({ cwd: options.cwd });
      stdout(`Opened ${result.reportRelativePath}.\n`);
      return 0;
    } catch (error: unknown) {
      stderr(
        `${
          error instanceof OpenReportError
            ? terminalText(error.message)
            : "UIWitness could not open the latest report unexpectedly."
        }\n`,
      );
      return 2;
    }
  }

  if (args.length > 1) {
    stderr(
      `The init command does not accept arguments: ${args
        .slice(1)
        .map(terminalText)
        .join(" ")}\n`,
    );
    return 2;
  }

  try {
    const result = await initProject({ cwd: options.cwd });
    const configPath = displayPath(result.projectRoot, result.configPath);
    const scenarioPath = displayPath(result.projectRoot, result.scenarioPath);
    stdout(`UIWitness initialized.\n\nCreated:\n  ${configPath}\n  ${scenarioPath}\n\nNext:\n  1. Update ${configPath} for your app.\n  2. Add scenario hooks in ${scenarioPath}.\n  3. Commit both starter files to version control.\n`);
    return 0;
  } catch (error: unknown) {
    if (error instanceof InitError) {
      const targets =
        error.code === "INIT_WRITE_FAILED" && error.paths.length > 0
          ? `\n\nTargets:\n${error.paths
              .map((path) => `  ${terminalText(path)}`)
              .join("\n")}`
          : "";
      stderr(`${terminalText(error.message)}${targets}\n`);
    } else {
      stderr("UIWitness initialization failed unexpectedly.\n");
    }
    return 2;
  }
}
