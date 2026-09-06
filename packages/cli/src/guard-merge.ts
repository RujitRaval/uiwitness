import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  canonicalizeJson,
  contractConfigDigest,
  contractDigest,
  expandMatrix,
  parseContract,
  type AnyUIWitnessReport,
  type ContractComparisonResult,
  type JsonValue,
} from "uiwitness-core";

import {
  compareGuardInputs,
  guardConfiguration,
  guardMachineVerdict,
  guardRunDigest,
  loadGuardConfig,
  type GuardMachineVerdict,
} from "./guard-adapter.js";
import { GuardError } from "./guard-errors.js";
import {
  DEFAULT_GUARD_VERDICT_PATH,
  guardContractFile,
  guardToolVersion,
  prepareContractProposal,
  type GuardGenerationFinalization,
} from "./guard.js";
import {
  canonicalGuardWorkspace,
  preflightOutputPath,
  withContractLock,
} from "./guard-paths.js";

/** Inputs for one complete immutable shard-bundle aggregation. */
export interface GuardMergeOptions {
  readonly configPath?: string | undefined;
  readonly contractPath?: string | undefined;
  readonly cwd?: string | undefined;
  readonly inputs: readonly string[];
  /** Merge-time clock used only for plan activity; the plan owns comparison UTC. */
  readonly now?: (() => Date) | undefined;
}

/** Final contract truth published from one complete run set. */
export interface GuardMergeResult {
  readonly comparison: ContractComparisonResult;
  readonly configPath: string;
  readonly contractPath: string;
  readonly inputCount: number;
  readonly machineVerdict: GuardMachineVerdict;
  readonly metadataPath?: string | undefined;
  readonly proposalPath?: string | undefined;
  readonly report: AnyUIWitnessReport;
  readonly runSetId: string;
  readonly shardCount: number;
  readonly verdictPath: typeof DEFAULT_GUARD_VERDICT_PATH;
}

function relativePath(root: string, path: string): string {
  const local = relative(root, path).split(sep).join("/");
  return local.startsWith("--") ? `./${local}` : local;
}

function serializeMachineVerdict(verdict: GuardMachineVerdict): string {
  return `${canonicalizeJson(verdict as unknown as JsonValue)}\n`;
}

function authUnsupported(): never {
  throw new GuardError(
    "GUARD_SHARD_AUTH_UNSUPPORTED",
    "Sharded guard runs do not support authentication; use the complete local guard command.",
  );
}

/** Validates every partial bundle, compares once, and atomically publishes final truth. */
export async function mergeGuardShards(
  options: GuardMergeOptions,
): Promise<GuardMergeResult> {
  const root = await canonicalGuardWorkspace(options.cwd);
  const loaded = await loadGuardConfig(root, options.configPath);
  if (loaded.config.authentication !== undefined) authUnsupported();
  const configuration = await guardConfiguration(loaded.config, loaded.path, root);
  const selectedContractPath = await guardContractFile(root, options.contractPath);
  const defaultVerdictPath = resolve(root, DEFAULT_GUARD_VERDICT_PATH);
  await preflightOutputPath(root, defaultVerdictPath, false);
  parseContract(await readFile(selectedContractPath, "utf8"));
  const toolVersion = await guardToolVersion();

  return withContractLock(root, async () => {
    const contract = parseContract(await readFile(selectedContractPath, "utf8"));
    let comparison: ContractComparisonResult | undefined;
    let machineVerdict: GuardMachineVerdict | undefined;
    let proposalPath: string | undefined;
    let metadataPath: string | undefined;
    const { mergeShardScenarioBundles, ShardBundleError } = await import(
      "uiwitness-runner-playwright"
    );
    let merged: Awaited<ReturnType<typeof mergeShardScenarioBundles>>;
    try {
      merged = await mergeShardScenarioBundles({
        baseURL: loaded.config.baseURL,
        bundlePaths: options.inputs,
        cells: expandMatrix(loaded.config),
        configDigest: contractConfigDigest(configuration),
        contractDigest: contractDigest(contract),
        ...(loaded.config.evidence === undefined ? {} : { evidence: loaded.config.evidence }),
        finalizeGeneration: async (report, plan): Promise<GuardGenerationFinalization> => {
          const comparisonInstant = new Date(plan.createdAt);
          comparison = compareGuardInputs(contract, configuration, report, comparisonInstant);
          const runDigest = guardRunDigest(configuration, report);
          const proposal = comparison.complete && comparison.verdict !== "passed"
            ? await prepareContractProposal({
                configuration,
                contract,
                evaluatedOn: comparison.evaluatedOn,
                report,
                root,
                runDigest,
              })
            : undefined;
          proposalPath = proposal?.proposalPath;
          metadataPath = proposal?.metadataPath;
          machineVerdict = guardMachineVerdict(
            comparison,
            runDigest,
            options.configPath === undefined ? undefined : relativePath(root, loaded.path),
            proposal?.proposalPath,
          );
          const verdictArtifact = {
            contents: serializeMachineVerdict(machineVerdict),
            path: relativePath(root, defaultVerdictPath),
            publication: "replace" as const,
            role: "contract-verdict" as const,
          };
          return {
            artifacts: [...(proposal?.artifacts ?? []), verdictArtifact],
            runDigest,
            sourceGenerationDigests: proposal === undefined ? [] : [proposal.sourceGenerationDigest],
            toolVersion,
          };
        },
        ...(options.now === undefined ? {} : { now: options.now }),
        projectDirectory: root,
        toolVersion,
      });
    } catch (error: unknown) {
      if (error instanceof GuardError) throw error;
      if (error instanceof ShardBundleError || (error as { readonly code?: unknown }).code === "SHARD_INVALID") {
        throw new GuardError(
          "GUARD_SHARD_MERGE_INVALID",
          "Shard bundle merge failed closed before final publication.",
          undefined,
          { cause: error },
        );
      }
      throw new GuardError(
        "GUARD_SHARD_MERGE_FAILED",
        "Shard bundle merge could not publish a final generation.",
        undefined,
        { cause: error },
      );
    }
    if (comparison === undefined || machineVerdict === undefined) {
      throw new GuardError(
        "GUARD_SHARD_MERGE_FAILED",
        "Shard merge generation finalization did not complete.",
      );
    }
    return Object.freeze({
      comparison,
      configPath: loaded.path,
      contractPath: selectedContractPath,
      inputCount: options.inputs.length,
      machineVerdict,
      ...(metadataPath === undefined ? {} : { metadataPath }),
      ...(proposalPath === undefined ? {} : { proposalPath }),
      report: merged.report,
      runSetId: merged.plan.runSetId,
      shardCount: merged.plan.shardCount,
      verdictPath: DEFAULT_GUARD_VERDICT_PATH,
    });
  });
}
