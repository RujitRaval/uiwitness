import { readFile } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import {
  canonicalizeJson,
  compareContract,
  contractProposalDigest,
  contractProposalSourceDigest,
  createContractProposal,
  createContractProposalSource,
  emptyContractProposalMetadata,
  parseContract,
  parseContractProposalMetadata,
  serializeContractProposal,
  serializeContractProposalMetadata,
  serializeContractProposalSource,
  type AnyUIWitnessReport,
  type ContractComparisonResult,
  type ContractConfigurationCoordinate,
  type JsonValue,
  type ContractProposal,
  type ContractProposalSource,
  type GenerationArtifactRole,
  type Sha256Digest,
} from "uiwitness-core";

import {
  compareGuardInputs,
  contractSourceExecutions,
  guardConfiguration,
  guardMachineVerdict,
  guardRunDigest,
  loadGuardConfig,
  type GuardMachineVerdict,
} from "./guard-adapter.js";
import { GuardError } from "./guard-errors.js";
import {
  canonicalGuardWorkspace,
  containedRegularFile,
  preflightOutputPath,
  withContractLock,
} from "./guard-paths.js";
import { scanLoadedProject } from "./scan.js";

export { GuardError } from "./guard-errors.js";
export type { GuardErrorCode } from "./guard-errors.js";
export type { GuardMachineVerdict } from "./guard-adapter.js";

export const DEFAULT_CONTRACT_PATH = "uiwitness.contract.json" as const;
export const DEFAULT_GUARD_VERDICT_PATH =
  ".uiwitness/contract-verdict.json" as const;
export const DEFAULT_CONTRACT_CANDIDATE_DIRECTORY =
  ".uiwitness/contract-candidates" as const;
export const DEFAULT_CONTRACT_SOURCE_DIRECTORY =
  ".uiwitness/contract-generations" as const;

interface GuardGenerationSidecarArtifact {
  readonly contents: string | Uint8Array;
  readonly mutable?: boolean | undefined;
  readonly path: string;
  readonly publication: "exclusive" | "immutable" | "replace";
  readonly role: Exclude<GenerationArtifactRole, "evidence" | "evidence-manifest" | "report-html" | "report-json">;
}

export interface GuardGenerationFinalization {
  readonly artifacts?: readonly GuardGenerationSidecarArtifact[] | undefined;
  readonly runDigest?: Sha256Digest | undefined;
  readonly sourceGenerationDigests?: readonly Sha256Digest[] | undefined;
  readonly toolVersion: string;
}

/** Inputs for one complete, fresh State Contract Guard run. */
export interface GuardOptions {
  /** Explicit config path beneath the guard workspace. */
  readonly configPath?: string | undefined;
  /** Explicit committed contract path beneath the guard workspace. */
  readonly contractPath?: string | undefined;
  /** Guard workspace. Unlike scan, guard never walks parent directories. */
  readonly cwd?: string | undefined;
  /** Optional no-clobber copy of the machine verdict beneath the workspace. */
  readonly jsonPath?: string | undefined;
  /** Called once before browser launch and reused for the comparison date. */
  readonly now?: (() => Date) | undefined;
}

/** Complete guard output plus the existing schema-v1 execution report. */
export interface GuardResult {
  readonly comparison: ContractComparisonResult;
  readonly configPath: string;
  readonly contractPath: string;
  readonly explicitVerdictPath?: string | undefined;
  readonly machineVerdict: GuardMachineVerdict;
  readonly metadataPath?: string | undefined;
  readonly proposalPath?: string | undefined;
  readonly report: AnyUIWitnessReport;
  readonly verdictPath: typeof DEFAULT_GUARD_VERDICT_PATH;
}

function relativePath(root: string, path: string): string {
  const local = relative(root, path).split(sep).join("/");
  return local.startsWith("--") ? `./${local}` : local;
}

async function contractFile(
  root: string,
  contractPath: string | undefined,
): Promise<string> {
  const input = contractPath ?? DEFAULT_CONTRACT_PATH;
  try {
    return await containedRegularFile(
      root,
      input,
      "GUARD_CONTRACT_PATH_INVALID",
      "Guard contract path",
    );
  } catch (error: unknown) {
    if (
      contractPath === undefined &&
      error instanceof GuardError &&
      (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ) {
      throw new GuardError(
        "GUARD_CONTRACT_NOT_FOUND",
        `No UIWitness contract found at ${DEFAULT_CONTRACT_PATH}.`,
        resolve(root, DEFAULT_CONTRACT_PATH),
      );
    }
    throw error;
  }
}

function evaluationInstant(now: (() => Date) | undefined): Date {
  const value = (now ?? (() => new Date()))();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new RangeError("The guard clock must return a valid Date.");
  }
  return new Date(value.valueOf());
}

function prevalidateComparison(
  contract: ReturnType<typeof parseContract>,
  configuration: readonly ContractConfigurationCoordinate[],
  evaluatedAt: Date,
): void {
  compareContract({
    complete: false,
    configuration,
    contract,
    executions: [],
    now: () => new Date(evaluatedAt.valueOf()),
  });
}

function serializeMachineVerdict(verdict: GuardMachineVerdict): string {
  return `${canonicalizeJson(verdict as unknown as JsonValue)}\n`;
}

async function toolVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new GuardError("GUARD_PROPOSAL_INVALID", "UIWitness package version is unavailable.");
  }
  return manifest.version;
}

async function proposalMetadataContents(
  root: string,
  path: string,
  fallback: string,
  proposalDigest: ReturnType<typeof contractProposalDigest>,
): Promise<string> {
  try {
    const safePath = await containedRegularFile(
      root,
      path,
      "GUARD_PROPOSAL_INVALID",
      "Contract proposal metadata",
    );
    const contents = await readFile(safePath, "utf8");
    const metadata = parseContractProposalMetadata(contents);
    if (metadata.proposalDigest !== proposalDigest) {
      throw new GuardError(
        "GUARD_PROPOSAL_INVALID",
        "Existing contract proposal metadata targets another proposal.",
        safePath,
      );
    }
    return serializeContractProposalMetadata(metadata);
  } catch (error: unknown) {
    if (
      error instanceof GuardError &&
      (error.cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT"
    ) return fallback;
    throw error;
  }
}

export interface PreparedContractProposal {
  readonly artifacts: readonly GuardGenerationSidecarArtifact[];
  readonly metadataPath: string;
  readonly proposal: ContractProposal;
  readonly proposalPath: string;
  readonly source: ContractProposalSource;
  readonly sourceGenerationDigest: ReturnType<typeof contractProposalSourceDigest>;
  readonly toolVersion: string;
}

export async function prepareContractProposal(input: {
  readonly configuration: readonly ContractConfigurationCoordinate[];
  readonly contract: ReturnType<typeof parseContract> | null;
  readonly evaluatedOn: string;
  readonly report: AnyUIWitnessReport;
  readonly root: string;
  readonly runDigest: ReturnType<typeof guardRunDigest>;
}): Promise<PreparedContractProposal> {
  const source = createContractProposalSource({
    configuration: input.configuration,
    contract: input.contract,
    evaluatedOn: input.evaluatedOn,
    executions: contractSourceExecutions(input.report),
    runDigest: input.runDigest,
  });
  const version = await toolVersion();
  const proposal = createContractProposal(source, version);
  if (proposal.changes.length === 0) {
    throw new GuardError(
      "GUARD_PROPOSAL_INVALID",
      "A contract proposal cannot be published without named changes.",
    );
  }
  const sourceDigest = contractProposalSourceDigest(source).slice("sha256:".length);
  const proposalDigest = contractProposalDigest(proposal).slice("sha256:".length);
  const sourcePath = resolve(
    input.root,
    DEFAULT_CONTRACT_SOURCE_DIRECTORY,
    `${sourceDigest}.source.json`,
  );
  const proposalPath = resolve(
    input.root,
    DEFAULT_CONTRACT_CANDIDATE_DIRECTORY,
    `${proposalDigest}.proposal.json`,
  );
  const metadataPath = resolve(
    input.root,
    DEFAULT_CONTRACT_CANDIDATE_DIRECTORY,
    `${proposalDigest}.metadata.json`,
  );
  const emptyMetadata = serializeContractProposalMetadata(
    emptyContractProposalMetadata(proposal),
  );
  const metadataContents = await proposalMetadataContents(
    input.root,
    metadataPath,
    emptyMetadata,
    contractProposalDigest(proposal),
  );
  return {
    artifacts: Object.freeze([
      Object.freeze({
        contents: serializeContractProposalSource(source),
        path: relativePath(input.root, sourcePath),
        publication: "immutable" as const,
        role: "contract-source" as const,
      }),
      Object.freeze({
        contents: serializeContractProposal(proposal),
        path: relativePath(input.root, proposalPath),
        publication: "immutable" as const,
        role: "contract-proposal" as const,
      }),
      Object.freeze({
        contents: metadataContents,
        mutable: true,
        path: relativePath(input.root, metadataPath),
        publication: "immutable" as const,
        role: "contract-metadata" as const,
      }),
    ]),
    metadataPath: relativePath(input.root, metadataPath),
    proposal,
    proposalPath: relativePath(input.root, proposalPath),
    source,
    sourceGenerationDigest: contractProposalSourceDigest(source),
    toolVersion: version,
  };
}

/**
 * Executes the complete configured matrix once, compares only that fresh
 * in-memory report, and publishes a deterministic machine-verdict sidecar.
 */
export async function guardProject(
  options: GuardOptions = {},
): Promise<GuardResult> {
  const root = await canonicalGuardWorkspace(options.cwd);
  const loaded = await loadGuardConfig(root, options.configPath);
  const configuration = await guardConfiguration(
    loaded.config,
    loaded.path,
    root,
  );
  const defaultVerdictPath = resolve(root, DEFAULT_GUARD_VERDICT_PATH);
  const explicitVerdictPath = options.jsonPath === undefined
    ? undefined
    : await preflightOutputPath(root, options.jsonPath, true);
  await preflightOutputPath(root, defaultVerdictPath, false);
  const evaluatedAt = evaluationInstant(options.now);
  const selectedContractPath = await contractFile(root, options.contractPath);
  const prevalidatedContract = parseContract(
    await readFile(selectedContractPath, "utf8"),
  );
  prevalidateComparison(prevalidatedContract, configuration, evaluatedAt);

  return withContractLock(root, async () => {
    const contract = parseContract(await readFile(selectedContractPath, "utf8"));
    prevalidateComparison(contract, configuration, evaluatedAt);

    let comparison: ContractComparisonResult | undefined;
    let machineVerdict: GuardMachineVerdict | undefined;
    let proposal: PreparedContractProposal | undefined;
    const scan = await scanLoadedProject(loaded, {
      projectDirectory: root,
      finalizeGeneration: async (report): Promise<GuardGenerationFinalization> => {
        comparison = compareGuardInputs(contract, configuration, report, evaluatedAt);
        const runDigest = guardRunDigest(configuration, report);
        proposal = comparison.complete && comparison.verdict !== "passed"
          ? await prepareContractProposal({
              configuration,
              contract,
              evaluatedOn: comparison.evaluatedOn,
              report,
              root,
              runDigest,
            })
          : undefined;
        machineVerdict = guardMachineVerdict(
          comparison,
          runDigest,
          options.configPath === undefined
            ? undefined
            : relativePath(root, loaded.path),
          proposal?.proposalPath,
        );
        const serialized = serializeMachineVerdict(machineVerdict);
        const verdictArtifact: GuardGenerationSidecarArtifact = {
          contents: serialized,
          path: relativePath(root, defaultVerdictPath),
          publication: explicitVerdictPath === defaultVerdictPath
            ? "exclusive"
            : "replace",
          role: "contract-verdict",
        };
        const artifacts = [
          ...(proposal?.artifacts ?? []),
          verdictArtifact,
          ...(explicitVerdictPath === undefined || explicitVerdictPath === defaultVerdictPath
            ? []
            : [{
                contents: serialized,
                path: relativePath(root, explicitVerdictPath),
                publication: "exclusive" as const,
                role: "json-copy" as const,
              }]),
        ];
        return {
          artifacts,
          runDigest,
          sourceGenerationDigests: proposal === undefined
            ? []
            : [proposal.sourceGenerationDigest],
          toolVersion: await toolVersion(),
        };
      },
    });
    if (comparison === undefined || machineVerdict === undefined) {
      throw new GuardError(
        "GUARD_PROPOSAL_INVALID",
        "Guard generation finalization did not complete.",
      );
    }

    return Object.freeze({
      comparison,
      configPath: loaded.path,
      contractPath: selectedContractPath,
      ...(explicitVerdictPath === undefined
        ? {}
        : { explicitVerdictPath: relativePath(root, explicitVerdictPath) }),
      machineVerdict,
      ...(proposal === undefined
        ? {}
        : {
            metadataPath: proposal.metadataPath,
            proposalPath: proposal.proposalPath,
          }),
      report: scan.report,
      verdictPath: DEFAULT_GUARD_VERDICT_PATH,
    });
  });
}
