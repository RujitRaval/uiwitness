import {
  lstat,
  readFile,
  rm,
} from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";

import {
  applyContractProposal,
  canonicalizeJson,
  contractConfigDigest,
  contractDigest,
  contractProposalDigest,
  contractProposalSourceDigest,
  createContractProposal,
  createContractProposalSource,
  emptyContractProposalMetadata,
  parseContract,
  parseContractProposal,
  parseContractProposalMetadata,
  parseContractProposalSource,
  parseCommittedGeneration,
  parseAnyGenerationManifest,
  generationManifestDigest,
  serializeContractProposal,
  serializeContractProposalMetadata,
  withContractProposalAnnotation,
  type ContractException,
  type ContractProposal,
  type ContractProposalChange,
  type ContractProposalMetadata,
  type ContractProposalSource,
  type JsonValue,
  type UIWitnessContract,
} from "uiwitness-core";
import { withGenerationTransactionLock } from "uiwitness-runner-playwright";

import {
  contractSourceExecutions,
  guardConfiguration,
  guardRunDigest,
  loadGuardConfig,
} from "./guard-adapter.js";
import { GuardError } from "./guard-errors.js";
import {
  DEFAULT_CONTRACT_PATH,
  prepareContractProposal,
  type GuardGenerationFinalization,
  type PreparedContractProposal,
} from "./guard.js";
import {
  canonicalGuardWorkspace,
  containedRegularFile,
  preflightOutputPath,
  withContractLock,
  writeGuardJson,
} from "./guard-paths.js";
import { scanLoadedProject } from "./scan.js";

const proposalFilenamePattern = /^([a-f0-9]{64})\.proposal\.json$/u;

export interface ContractInspectOptions {
  readonly candidatePath: string;
  readonly changeId: string;
  readonly cwd?: string | undefined;
}

export interface ContractInspectResult {
  readonly change: ContractProposalChange;
  readonly proposalPath: string;
}

export interface ContractAnnotateOptions extends ContractInspectOptions {
  readonly createdOn: string;
  readonly expiresOn: string;
  readonly owner: string;
  readonly reason: string;
  readonly now?: (() => Date) | undefined;
}

export interface ContractAnnotateResult {
  readonly changeId: string;
  readonly metadataPath: string;
}

export interface ContractAcceptOptions {
  readonly candidatePath: string;
  readonly changeIds: readonly string[];
  readonly configPath?: string | undefined;
  readonly contractPath?: string | undefined;
  readonly cwd?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface ContractAcceptResult {
  readonly accepted: readonly string[];
  readonly contractPath: string;
  readonly discarded: readonly string[];
}

export interface ContractInitOptions {
  readonly configPath?: string | undefined;
  readonly contractPath?: string | undefined;
  readonly cwd?: string | undefined;
  readonly now?: (() => Date) | undefined;
}

export interface ContractInitResult {
  readonly contractPath?: string | undefined;
  readonly metadataPath?: string | undefined;
  readonly proposalPath?: string | undefined;
  readonly status: "created" | "proposal";
}

interface ProposalBundle {
  readonly digest: string;
  readonly metadataPath: string;
  readonly proposal: ContractProposal;
  readonly proposalPath: string;
  readonly root: string;
  readonly source: ContractProposalSource;
  readonly sourcePath: string;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === "ENOENT";
}

function relativeDisplay(root: string, path: string): string {
  return path.slice(root.length + 1).split("\\").join("/");
}

async function packageVersion(): Promise<string> {
  const manifest = JSON.parse(
    await readFile(new URL("../package.json", import.meta.url), "utf8"),
  ) as { readonly version?: unknown };
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    throw new GuardError("GUARD_PROPOSAL_INVALID", "UIWitness package version is unavailable.");
  }
  return manifest.version;
}

function candidateDigest(path: string): string {
  const match = proposalFilenamePattern.exec(basename(path));
  if (match === null) {
    throw new GuardError(
      "GUARD_PROPOSAL_INVALID",
      "Contract proposal filenames must be their 64-character SHA-256 digest followed by .proposal.json.",
      path,
    );
  }
  return match[1]!;
}

async function proposalBundle(
  cwd: string | undefined,
  candidatePath: string,
): Promise<ProposalBundle> {
  const root = await canonicalGuardWorkspace(cwd);
  const proposalPath = await containedRegularFile(
    root,
    candidatePath,
    "GUARD_PROPOSAL_INVALID",
    "Contract proposal",
  );
  const digest = candidateDigest(proposalPath);
  const proposalSource = await readFile(proposalPath, "utf8");
  const proposal = parseContractProposal(proposalSource);
  if (contractProposalDigest(proposal) !== `sha256:${digest}`) {
    throw new GuardError(
      "GUARD_PROPOSAL_INVALID",
      "Contract proposal contents do not match the content-addressed filename.",
      proposalPath,
    );
  }
  const sourceDigest = proposal.sourceGenerationDigest.slice("sha256:".length);
  const sourcePath = await containedRegularFile(
    root,
    resolve(root, ".uiwitness/contract-generations", `${sourceDigest}.source.json`),
    "GUARD_PROPOSAL_INVALID",
    "Contract proposal source",
  );
  const source = parseContractProposalSource(await readFile(sourcePath, "utf8"));
  if (contractProposalSourceDigest(source) !== proposal.sourceGenerationDigest) {
    throw new GuardError(
      "GUARD_PROPOSAL_INVALID",
      "Contract proposal source contents do not match their digest.",
      sourcePath,
    );
  }
  const regenerated = createContractProposal(source, proposal.toolVersion);
  if (serializeContractProposal(regenerated) !== proposalSource) {
    throw new GuardError(
      "GUARD_PROPOSAL_INVALID",
      "Contract proposal was changed after its source generation was recorded.",
      proposalPath,
    );
  }
  return {
    digest,
    metadataPath: resolve(dirname(proposalPath), `${digest}.metadata.json`),
    proposal,
    proposalPath,
    root,
    source,
    sourcePath,
  };
}

function namedChange(proposal: ContractProposal, changeId: string): ContractProposalChange {
  const selected = proposal.changes.find(({ id }) => id === changeId);
  if (selected === undefined) {
    throw new GuardError(
      "GUARD_PROPOSAL_INVALID",
      `Unknown contract proposal change: ${changeId}`,
    );
  }
  return selected;
}

async function readMetadata(bundle: ProposalBundle): Promise<ContractProposalMetadata> {
  const metadataPath = await containedRegularFile(
    bundle.root,
    bundle.metadataPath,
    "GUARD_PROPOSAL_INVALID",
    "Contract proposal metadata",
  );
  const metadata = parseContractProposalMetadata(await readFile(metadataPath, "utf8"));
  if (metadata.proposalDigest !== contractProposalDigest(bundle.proposal)) {
    throw new GuardError(
      "GUARD_PROPOSAL_INVALID",
      "Contract proposal metadata targets a different proposal.",
      metadataPath,
    );
  }
  return metadata;
}

async function verifyCommittedGeneration(bundle: ProposalBundle): Promise<void> {
  const markerPath = await containedRegularFile(
    bundle.root,
    resolve(bundle.root, ".uiwitness/generation.json"),
    "GUARD_PROPOSAL_INVALID",
    "Committed generation marker",
  );
  const marker = parseCommittedGeneration(await readFile(markerPath, "utf8"));
  if (!marker.sourceGenerationDigests.includes(bundle.proposal.sourceGenerationDigest)) {
    throw new GuardError(
      "GUARD_PROPOSAL_INVALID",
      "The contract proposal is not part of the currently committed generation.",
      bundle.proposalPath,
    );
  }
  const manifestPath = await containedRegularFile(
    bundle.root,
    resolve(bundle.root, marker.manifestPath),
    "GUARD_PROPOSAL_INVALID",
    "Committed generation manifest",
  );
  const manifest = parseAnyGenerationManifest(await readFile(manifestPath, "utf8"));
  if (
    generationManifestDigest(manifest) !== marker.manifestDigest ||
    JSON.stringify(manifest.sourceGenerationDigests) !==
      JSON.stringify(marker.sourceGenerationDigests)
  ) {
    throw new GuardError(
      "GUARD_PROPOSAL_INVALID",
      "The committed generation marker and manifest do not match.",
      manifestPath,
    );
  }
  const sourcePath = relativeDisplay(bundle.root, bundle.sourcePath);
  const proposalPath = relativeDisplay(bundle.root, bundle.proposalPath);
  const sourceEntry = manifest.artifacts.find(({ path }) => path === sourcePath);
  const proposalEntry = manifest.artifacts.find(({ path }) => path === proposalPath);
  if (
    sourceEntry?.role !== "contract-source" ||
    proposalEntry?.role !== "contract-proposal"
  ) {
    throw new GuardError(
      "GUARD_PROPOSAL_INVALID",
      "The proposal family is not bound to the committed generation manifest.",
      manifestPath,
    );
  }
}

function evaluationDate(now: (() => Date) | undefined): string {
  const value = (now ?? (() => new Date()))();
  if (!(value instanceof Date) || !Number.isFinite(value.valueOf())) {
    throw new RangeError("The contract clock must return a valid Date.");
  }
  return value.toISOString().slice(0, 10);
}

function prettyContract(contract: UIWitnessContract): string {
  return `${JSON.stringify(contract, null, 2)}\n`;
}

export async function inspectContractChange(
  options: ContractInspectOptions,
): Promise<ContractInspectResult> {
  const bundle = await proposalBundle(options.cwd, options.candidatePath);
  return Object.freeze({
    change: namedChange(bundle.proposal, options.changeId),
    proposalPath: relativeDisplay(bundle.root, bundle.proposalPath),
  });
}

export async function annotateContractChange(
  options: ContractAnnotateOptions,
): Promise<ContractAnnotateResult> {
  const bundle = await proposalBundle(options.cwd, options.candidatePath);
  namedChange(bundle.proposal, options.changeId);
  const exception: ContractException = {
    createdOn: options.createdOn,
    expiresOn: options.expiresOn,
    owner: options.owner,
    reason: options.reason,
  };
  return withContractLock(bundle.root, async () => {
    const current = await proposalBundle(bundle.root, bundle.proposalPath);
    const metadata = await readMetadata(current);
    const updated = withContractProposalAnnotation(
      current.proposal,
      metadata,
      options.changeId,
      exception,
      evaluationDate(options.now),
    );
    await writeGuardJson(
      current.root,
      current.metadataPath,
      serializeContractProposalMetadata(updated),
      false,
    );
    return Object.freeze({
      changeId: options.changeId,
      metadataPath: relativeDisplay(current.root, current.metadataPath),
    });
  });
}

async function currentContract(
  root: string,
  contractPath: string | undefined,
  sourceDigest: ContractProposal["sourceContractDigest"],
): Promise<{ readonly contract: UIWitnessContract | null; readonly path: string }> {
  const path = resolve(root, contractPath ?? DEFAULT_CONTRACT_PATH);
  if (sourceDigest === "absent") {
    try {
      await lstat(path);
      throw new GuardError(
        "GUARD_CONTRACT_STALE",
        "A contract now exists, so this initialization proposal is stale.",
        path,
      );
    } catch (error: unknown) {
      if (error instanceof GuardError) throw error;
      if (!missing(error)) throw error;
    }
    await preflightOutputPath(root, path, true);
    return { contract: null, path };
  }
  const safe = await containedRegularFile(
    root,
    path,
    "GUARD_CONTRACT_STALE",
    "Current contract",
  );
  const contract = parseContract(await readFile(safe, "utf8"));
  if (contractDigest(contract) !== sourceDigest) {
    throw new GuardError(
      "GUARD_CONTRACT_STALE",
      "The committed contract changed after this proposal was generated.",
      safe,
    );
  }
  return { contract, path: safe };
}

export async function acceptContractChanges(
  options: ContractAcceptOptions,
): Promise<ContractAcceptResult> {
  const initial = await proposalBundle(options.cwd, options.candidatePath);
  return withContractLock(initial.root, () => withGenerationTransactionLock(initial.root, async () => {
    const bundle = await proposalBundle(initial.root, initial.proposalPath);
    await verifyCommittedGeneration(bundle);
    const metadata = await readMetadata(bundle);
    const current = await currentContract(
      bundle.root,
      options.contractPath,
      bundle.proposal.sourceContractDigest,
    );
    const loaded = await loadGuardConfig(bundle.root, options.configPath);
    const configuration = await guardConfiguration(loaded.config, loaded.path, bundle.root);
    if (
      contractConfigDigest(configuration) !== bundle.proposal.configDigest ||
      canonicalizeJson(configuration as unknown as JsonValue) !==
        canonicalizeJson(bundle.source.configuration as unknown as JsonValue)
    ) {
      throw new GuardError(
        "GUARD_CONTRACT_STALE",
        "The UIWitness configuration changed after this proposal was generated.",
        loaded.path,
      );
    }
    if (
      (current.contract === null && bundle.source.contract !== null) ||
      (current.contract !== null && bundle.source.contract === null) ||
      (current.contract !== null && bundle.source.contract !== null &&
        contractDigest(current.contract) !== contractDigest(bundle.source.contract))
    ) {
      throw new GuardError(
        "GUARD_CONTRACT_STALE",
        "The proposal source contract no longer matches the committed contract.",
        current.path,
      );
    }
    const accepted = [...options.changeIds];
    const contract = applyContractProposal({
      acceptedOn: evaluationDate(options.now),
      changeIds: accepted,
      metadata,
      proposal: bundle.proposal,
      source: bundle.source,
    });
    await writeGuardJson(
      bundle.root,
      current.path,
      prettyContract(contract),
      current.contract === null,
    );
    const acceptedSet = new Set(accepted);
    const discarded = bundle.proposal.changes
      .map(({ id }) => id)
      .filter((id) => !acceptedSet.has(id));
    await rm(bundle.proposalPath);
    await rm(bundle.metadataPath);
    return Object.freeze({
      accepted: Object.freeze(accepted),
      contractPath: relativeDisplay(bundle.root, current.path),
      discarded: Object.freeze(discarded),
    });
  }));
}

export async function initContract(
  options: ContractInitOptions = {},
): Promise<ContractInitResult> {
  const root = await canonicalGuardWorkspace(options.cwd);
  return withContractLock(root, async () => {
    const target = resolve(root, options.contractPath ?? DEFAULT_CONTRACT_PATH);
    await preflightOutputPath(root, target, true);
    const loaded = await loadGuardConfig(root, options.configPath);
    const configuration = await guardConfiguration(loaded.config, loaded.path, root);
    const evaluatedOn = evaluationDate(options.now);
    let source: ContractProposalSource | undefined;
    let proposal: ContractProposal | undefined;
    let prepared: PreparedContractProposal | undefined;
    const scan = await scanLoadedProject(loaded, {
      projectDirectory: root,
      finalizeGeneration: async (report): Promise<GuardGenerationFinalization> => {
        const runDigest = guardRunDigest(configuration, report);
        source = createContractProposalSource({
          configuration,
          contract: null,
          evaluatedOn,
          executions: contractSourceExecutions(report),
          runDigest,
        });
        proposal = createContractProposal(source, await packageVersion());
        const allPassed = report.executions.every(({ status }) => status === "passed");
        prepared = allPassed
          ? undefined
          : await prepareContractProposal({
              configuration,
              contract: null,
              evaluatedOn,
              report,
              root,
              runDigest,
            });
        return {
          artifacts: prepared?.artifacts ?? [],
          runDigest,
          sourceGenerationDigests: prepared === undefined
            ? []
            : [prepared.sourceGenerationDigest],
          toolVersion: await packageVersion(),
        };
      },
    });
    if (source === undefined || proposal === undefined) {
      throw new GuardError("GUARD_PROPOSAL_INVALID", "Contract initialization generation did not complete.");
    }
    const allPassed = scan.report.executions.every(({ status }) => status === "passed");
    if (allPassed) {
      const contract = applyContractProposal({
        acceptedOn: evaluatedOn,
        changeIds: proposal.changes.map(({ id }) => id),
        metadata: emptyContractProposalMetadata(proposal),
        proposal,
        source,
      });
      await writeGuardJson(root, target, prettyContract(contract), true);
      return Object.freeze({
        contractPath: relativeDisplay(root, target),
        status: "created" as const,
      });
    }
    if (prepared === undefined) {
      throw new GuardError("GUARD_PROPOSAL_INVALID", "Contract proposal generation did not complete.");
    }
    return Object.freeze({
      metadataPath: prepared.metadataPath,
      proposalPath: prepared.proposalPath,
      status: "proposal" as const,
    });
  });
}
