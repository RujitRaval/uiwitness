import { randomBytes } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, rm } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

import {
  PRIVACY_REPORT_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  ShardValidationError,
  assertShardPlanActive,
  assignedShardCoordinateIds,
  compareContract,
  contractConfigDigest,
  contractDigest,
  createShardPlan,
  expandMatrix,
  parseContract,
  parseShardPlan,
  parseShardSpecifier,
  serializeShardPlan,
  shardIndexForCoordinate,
  shardTargetDigest,
  type UIWitnessShardPlan,
} from "uiwitness-core";

import { guardConfiguration, loadGuardConfig } from "./guard-adapter.js";
import { GuardError } from "./guard-errors.js";
import {
  guardContractFile,
  guardEvaluationInstant,
  guardToolVersion,
} from "./guard.js";
import { canonicalGuardWorkspace, containedRegularFile } from "./guard-paths.js";

const maximumShardPlanBytes = 16 * 1_024 * 1_024;

export interface GuardShardPlanOptions {
  readonly configPath?: string | undefined;
  readonly contractPath?: string | undefined;
  readonly cwd?: string | undefined;
  readonly environmentId?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly outPath: string;
  readonly shards: number;
  readonly ttlMinutes?: number | undefined;
}

export interface GuardShardPlanResult {
  readonly configPath: string;
  readonly contractPath: string;
  readonly largestShard: number;
  readonly meanShardSize: number;
  readonly plan: UIWitnessShardPlan;
  readonly planPath: string;
  readonly warning?: string | undefined;
}

export interface GuardShardOptions {
  readonly configPath?: string | undefined;
  readonly contractPath?: string | undefined;
  readonly cwd?: string | undefined;
  readonly now?: (() => Date) | undefined;
  readonly shard: string;
  readonly shardPlanPath: string;
}

export interface GuardShardResult {
  readonly bundlePath: string;
  readonly configPath: string;
  readonly contractPath: string;
  readonly failed: number;
  readonly planPath: string;
  readonly runSetId: string;
  readonly shardCount: number;
  readonly shardIndex: number;
  readonly total: number;
}

function localPath(root: string, path: string): string {
  return relative(root, path).split(sep).join("/");
}

function authUnsupported(): never {
  throw new GuardError(
    "GUARD_SHARD_AUTH_UNSUPPORTED",
    "Sharded guard runs do not support authentication; use the complete local guard command.",
  );
}

function reportSchemaVersion(retention: "all" | "failures-only" | "none" | undefined): 1 | 2 {
  return retention === "failures-only" || retention === "none"
    ? PRIVACY_REPORT_SCHEMA_VERSION
    : REPORT_SCHEMA_VERSION;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function contained(root: string, candidate: string): boolean {
  const local = relative(root, candidate);
  return local.length > 0 && local !== ".." && !local.startsWith(`..${sep}`) && !isAbsolute(local);
}

async function prepareExclusivePlanPath(root: string, inputPath: string): Promise<string> {
  if ([...inputPath].some((character) => {
    const codePoint = character.codePointAt(0)!;
    return codePoint <= 0x1f || (codePoint >= 0x7f && codePoint <= 0x9f);
  })) {
    throw new GuardError("GUARD_SHARD_PLAN_PATH_INVALID", "Shard-plan path cannot contain control characters.", inputPath);
  }
  const destination = resolve(root, inputPath);
  if (!contained(root, destination)) {
    throw new GuardError("GUARD_SHARD_PLAN_PATH_INVALID", "Shard-plan path must stay beneath the workspace.", destination);
  }
  const projectPath = localPath(root, destination);
  if (
    projectPath === ".uiwitness/contract.lock" ||
    projectPath === ".uiwitness/contract-verdict.json" ||
    projectPath === ".uiwitness/contract-candidates" || projectPath.startsWith(".uiwitness/contract-candidates/") ||
    projectPath === ".uiwitness/contract-generations" || projectPath.startsWith(".uiwitness/contract-generations/") ||
    projectPath === ".uiwitness/artifacts" || projectPath.startsWith(".uiwitness/artifacts/") ||
    projectPath === ".uiwitness/generation.json" ||
    projectPath === ".uiwitness/generations" || projectPath.startsWith(".uiwitness/generations/") ||
    projectPath === ".uiwitness/report" || projectPath.startsWith(".uiwitness/report/") ||
    projectPath === ".uiwitness/shards" || projectPath.startsWith(".uiwitness/shards/") ||
    projectPath.startsWith(".uiwitness/.runner-")
  ) {
    throw new GuardError("GUARD_SHARD_PLAN_PATH_INVALID", "Shard-plan output cannot use a UIWitness control or generated-artifact path.", destination);
  }
  const segments = relative(root, dirname(destination)).split(sep).filter(Boolean);
  let parent = root;
  for (const segment of segments) {
    const containingDirectory = parent;
    parent = resolve(containingDirectory, segment);
    let created = false;
    try {
      await mkdir(parent, { mode: 0o700 });
      created = true;
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const metadata = await lstat(parent);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new GuardError("GUARD_SHARD_PLAN_PATH_INVALID", "Shard-plan path cannot pass through a symbolic link or non-directory.", destination);
    }
    if (created && process.platform !== "win32") await chmod(parent, 0o700);
    if (created) await syncDirectory(containingDirectory);
  }
  try {
    await lstat(destination);
    throw new GuardError("GUARD_SHARD_PLAN_PATH_INVALID", "Shard-plan output already exists and will not be overwritten.", destination);
  } catch (error: unknown) {
    if (error instanceof GuardError) throw error;
    if (!missing(error)) {
      throw new GuardError("GUARD_SHARD_PLAN_PATH_INVALID", "Shard-plan output cannot be inspected.", destination, { cause: error });
    }
  }
  return destination;
}

async function syncDirectory(path: string): Promise<void> {
  const handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function writeExclusivePlan(root: string, destination: string, contents: string): Promise<void> {
  let handle;
  let created = false;
  let failure: unknown;
  try {
    handle = await open(
      destination,
      fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_WRONLY | fsConstants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    await handle.writeFile(contents, "utf8");
    await handle.sync();
  } catch (error: unknown) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new GuardError("GUARD_SHARD_PLAN_PATH_INVALID", "Shard-plan output already exists and will not be overwritten.", destination, { cause: error });
    }
    failure = error;
  } finally {
    try {
      await handle?.close();
    } catch (error: unknown) {
      failure ??= error;
    }
  }
  if (failure !== undefined) {
    if (created) await rm(destination, { force: true });
    throw new GuardError("GUARD_SHARD_PLAN_WRITE_FAILED", "Shard plan could not be written safely.", destination, { cause: failure });
  }
  await syncDirectory(dirname(destination));
  if (!contained(root, destination)) {
    throw new GuardError("GUARD_SHARD_PLAN_WRITE_FAILED", "Shard-plan publication escaped its workspace.", destination);
  }
}

function assertSameStrings(actual: readonly string[], expected: readonly string[], label: string): void {
  if (actual.length !== expected.length || actual.some((value, index) => value !== expected[index])) {
    throw new GuardError("GUARD_SHARD_PLAN_MISMATCH", `Shard plan no longer matches the current ${label}.`);
  }
}

/** Creates one nonce-bound plan from the complete current config inventory. */
export async function createGuardShardPlan(
  options: GuardShardPlanOptions,
): Promise<GuardShardPlanResult> {
  const root = await canonicalGuardWorkspace(options.cwd);
  const loaded = await loadGuardConfig(root, options.configPath);
  if (loaded.config.authentication !== undefined) authUnsupported();
  const configuration = await guardConfiguration(loaded.config, loaded.path, root);
  const contractPath = await guardContractFile(root, options.contractPath);
  const contract = parseContract(await readFile(contractPath, "utf8"));
  const createdAt = guardEvaluationInstant(options.now);
  compareContract({
    complete: false,
    configuration,
    contract,
    executions: [],
    now: () => new Date(createdAt.valueOf()),
  });
  const plan = createShardPlan({
    configDigest: contractConfigDigest(configuration),
    contractDigest: contractDigest(contract),
    coordinateIds: configuration.map(({ id }) => id),
    createdAt,
    environmentId: options.environmentId,
    nonce: randomBytes(16).toString("hex"),
    reportSchemaVersion: reportSchemaVersion(loaded.config.evidence?.retention),
    shardCount: options.shards,
    targetDigest: shardTargetDigest(loaded.config.baseURL, options.environmentId),
    toolVersion: await guardToolVersion(),
    ttlMinutes: options.ttlMinutes,
  });
  const destination = await prepareExclusivePlanPath(root, options.outPath);
  await writeExclusivePlan(root, destination, serializeShardPlan(plan));

  const sizes = Array.from({ length: plan.shardCount }, () => 0);
  for (const coordinateId of plan.coordinateIds) {
    sizes[shardIndexForCoordinate(coordinateId, plan.shardCount)]! += 1;
  }
  const largestShard = Math.max(...sizes);
  const meanShardSize = plan.coordinateIds.length / plan.shardCount;
  const warning = meanShardSize > 0 && largestShard > meanShardSize * 1.5
    ? `Largest shard has ${largestShard} coordinates, more than 1.5x the mean ${meanShardSize.toFixed(2)}.`
    : undefined;
  return Object.freeze({
    configPath: loaded.path,
    contractPath,
    largestShard,
    meanShardSize,
    plan,
    planPath: localPath(root, destination),
    ...(warning === undefined ? {} : { warning }),
  });
}

/** Executes one exact N/M assignment and publishes its immutable partial bundle. */
export async function runGuardShard(options: GuardShardOptions): Promise<GuardShardResult> {
  const root = await canonicalGuardWorkspace(options.cwd);
  const loaded = await loadGuardConfig(root, options.configPath);
  if (loaded.config.authentication !== undefined) authUnsupported();
  const planPath = await containedRegularFile(
    root,
    options.shardPlanPath,
    "GUARD_SHARD_PLAN_PATH_INVALID",
    "Guard shard-plan path",
  );
  if ((await lstat(planPath)).size > maximumShardPlanBytes) {
    throw new GuardError("GUARD_SHARD_PLAN_INVALID", "Shard plan exceeds the 16 MiB input limit.", planPath);
  }
  let plan: UIWitnessShardPlan;
  try {
    plan = parseShardPlan(await readFile(planPath, "utf8"));
  } catch (error: unknown) {
    if (error instanceof ShardValidationError) {
      throw new GuardError("GUARD_SHARD_PLAN_INVALID", error.message, planPath, { cause: error });
    }
    throw error;
  }
  const evaluatedAt = guardEvaluationInstant(options.now);
  try {
    assertShardPlanActive(plan, evaluatedAt);
  } catch (error: unknown) {
    throw new GuardError("GUARD_SHARD_PLAN_EXPIRED", "Shard plan is expired or not active yet.", planPath, { cause: error });
  }
  let shard: ReturnType<typeof parseShardSpecifier>;
  try {
    shard = parseShardSpecifier(options.shard);
  } catch (error: unknown) {
    throw new GuardError("GUARD_SHARD_PLAN_INVALID", "Shard must use a valid one-based N/M specifier.", planPath, { cause: error });
  }
  if (shard.shardCount !== plan.shardCount) {
    throw new GuardError("GUARD_SHARD_PLAN_MISMATCH", "The N/M shard total does not match the plan.", planPath);
  }
  const configuration = await guardConfiguration(loaded.config, loaded.path, root);
  const contractPath = await guardContractFile(root, options.contractPath);
  const contract = parseContract(await readFile(contractPath, "utf8"));
  assertSameStrings(configuration.map(({ id }) => id), plan.coordinateIds, "config inventory");
  if (contractConfigDigest(configuration) !== plan.configDigest) {
    throw new GuardError("GUARD_SHARD_PLAN_MISMATCH", "Shard plan config digest no longer matches.", planPath);
  }
  if (contractDigest(contract) !== plan.contractDigest) {
    throw new GuardError("GUARD_SHARD_PLAN_MISMATCH", "Shard plan contract digest no longer matches.", planPath);
  }
  if (shardTargetDigest(loaded.config.baseURL, plan.environmentId) !== plan.targetDigest) {
    throw new GuardError("GUARD_SHARD_PLAN_MISMATCH", "Shard plan target digest no longer matches.", planPath);
  }
  if (reportSchemaVersion(loaded.config.evidence?.retention) !== plan.reportSchemaVersion) {
    throw new GuardError("GUARD_SHARD_PLAN_MISMATCH", "Shard plan report schema no longer matches evidence retention.", planPath);
  }
  if (await guardToolVersion() !== plan.toolVersion) {
    throw new GuardError("GUARD_SHARD_PLAN_MISMATCH", "Shard plan tool version does not match this UIWitness CLI.", planPath);
  }

  const assigned = new Set(assignedShardCoordinateIds(plan, shard.shardIndex));
  const cells = expandMatrix(loaded.config).filter((cell) =>
    assigned.has(`${cell.route.id}/${cell.state.id}/${cell.viewportId}/${cell.theme}`)
  );
  const { runShardScenarioCells } = await import("uiwitness-runner-playwright");
  try {
    const run = await runShardScenarioCells(cells, {
      baseURL: loaded.config.baseURL,
      evaluatedAt,
      ...(loaded.config.evidence === undefined ? {} : { evidence: loaded.config.evidence }),
      ...(loaded.config.failOn === undefined ? {} : { failOn: loaded.config.failOn }),
      plan,
      projectDirectory: root,
      scenarioBaseDirectory: dirname(loaded.path),
      shardIndex: shard.shardIndex,
    });
    return Object.freeze({
      bundlePath: run.bundlePath,
      configPath: loaded.path,
      contractPath,
      failed: run.report.summary.failed,
      planPath: localPath(root, planPath),
      runSetId: plan.runSetId,
      shardCount: plan.shardCount,
      shardIndex: shard.shardIndex,
      total: run.report.summary.executions,
    });
  } catch (error: unknown) {
    const code = (error as { readonly code?: unknown }).code;
    if (code === "SHARD_BUNDLE_EXISTS") {
      throw new GuardError("GUARD_SHARD_BUNDLE_EXISTS", "Immutable shard bundle already exists.", undefined, { cause: error });
    }
    if (code === "SHARD_BUNDLE_WRITE_FAILED" || code === "SHARD_BUNDLE_INVALID") {
      throw new GuardError("GUARD_SHARD_BUNDLE_WRITE_FAILED", "Immutable shard bundle could not be published.", undefined, { cause: error });
    }
    throw error;
  }
}
