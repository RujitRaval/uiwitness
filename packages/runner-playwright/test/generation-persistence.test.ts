import { createHash } from "node:crypto";
import {
  link,
  mkdir,
  mkdtemp,
  open,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  EVIDENCE_MANIFEST_PATH,
  REPORT_SCHEMA_VERSION,
  canonicalizeJson,
  contractProposalDigest,
  contractProposalSourceDigest,
  createContractProposal,
  createContractProposalSource,
  emptyContractProposalMetadata,
  generationManifestDigest,
  parseAnyGenerationManifest,
  parseCommittedGeneration,
  parseEvidenceManifest,
  parseExecutionResult,
  parseReport,
  serializeContractProposal,
  serializeContractProposalMetadata,
  serializeContractProposalSource,
  serializePrivacyGenerationManifest,
  type JsonValue,
} from "uiwitness-core";

import {
  acquirePersistenceLock,
  persistReport,
  releasePersistenceLock,
} from "../src/persistence.js";

const zero = Object.freeze({ covered: 0, percentage: 0, total: 0 });
const report = parseReport({
  executions: [],
  generatedAt: "2026-09-04T00:00:00.000Z",
  project: { baseURL: "https://uiwitness.invalid" },
  schemaVersion: REPORT_SCHEMA_VERSION,
  summary: {
    coverage: { execution: zero, responsive: zero, state: zero, theme: zero },
    durationMs: 0,
    executions: 0,
    failed: 0,
    passed: 0,
    routes: 0,
    states: 0,
  },
});
const evidenceArtifact = Object.freeze({
  result: parseExecutionResult({
    diagnostics: {
      consoleErrors: [],
      failedRequests: [],
      navigationStatus: 200,
      pageErrors: [],
    },
    durationMs: 1,
    failures: [],
    routeId: "home",
    routePath: "/",
    scenarioSource: "./scenarios/home.mjs",
    screenshotPath: ".uiwitness/artifacts/home/public/desktop-light.png",
    stateId: "public",
    status: "passed",
    theme: "light",
    url: "https://uiwitness.invalid/",
    viewport: { height: 900, width: 1_440 },
    viewportId: "desktop",
  }),
  screenshot: Uint8Array.of(1, 2, 3, 4),
});
const covered = Object.freeze({ covered: 1, percentage: 100, total: 1 });
const evidenceReport = parseReport({
  executions: [evidenceArtifact.result],
  generatedAt: "2026-09-04T00:00:00.000Z",
  project: { baseURL: "https://uiwitness.invalid" },
  schemaVersion: REPORT_SCHEMA_VERSION,
  summary: {
    coverage: {
      execution: covered,
      responsive: covered,
      state: covered,
      theme: covered,
    },
    durationMs: 1,
    executions: 1,
    failed: 0,
    passed: 1,
    routes: 1,
    states: 1,
  },
});

async function temporaryProject(): Promise<string> {
  return mkdtemp(join(tmpdir(), "uiwitness-generation-"));
}

async function syncedWrite(destination: string, contents: string | Uint8Array): Promise<void> {
  await mkdir(dirname(destination), { recursive: true });
  const handle = await open(destination, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function syncedDirectory(path: string): Promise<void> {
  const handle = await open(path, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function digest(contents: string | Uint8Array): `sha256:${string}` {
  return `sha256:${createHash("sha256").update(contents).digest("hex")}`;
}

const runDigest = `sha256:${"d".repeat(64)}` as const;
const contractVerdict = Object.freeze({
  complete: true,
  configDigest: `sha256:${"a".repeat(64)}`,
  contractDigest: `sha256:${"b".repeat(64)}`,
  evaluatedOn: "2026-09-04",
  findings: Object.freeze([{
    actual: Object.freeze({
      failureCodes: Object.freeze(["ASSERTION_FAILED"]),
      status: "failed",
    }),
    expected: Object.freeze({ status: "passed" }),
    id: "home/public/desktop/light",
    kind: "regression",
    remediate: "uiwitness contract inspect --candidate candidate.json --change expectation:home/public/desktop/light",
    reproduce: "uiwitness scan --coordinate home/public/desktop/light --headed",
  }]),
  runDigest,
  schemaVersion: 1,
  verdict: "failed",
});
const serializedContractVerdict = `${canonicalizeJson(
  contractVerdict as JsonValue,
)}\n`;
const proposalSource = createContractProposalSource({
  configuration: [{
    configFingerprint: `sha256:${"a".repeat(64)}`,
    id: "home/public/desktop/light",
    routeId: "home",
    routePath: "/",
    scenarioSource: "./scenarios/home.mjs",
    stateId: "public",
    theme: "light",
    viewport: { height: 900, width: 1_440 },
    viewportId: "desktop",
  }],
  contract: null,
  evaluatedOn: "2026-09-04",
  executions: [{
    actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
    id: "home/public/desktop/light",
  }],
  runDigest,
});
const proposal = createContractProposal(proposalSource, "0.26.4");
const sourceDigest = contractProposalSourceDigest(proposalSource);
const proposalDigest = contractProposalDigest(proposal);
const sourceName = sourceDigest.slice("sha256:".length);
const proposalName = proposalDigest.slice("sha256:".length);
const finalization = Object.freeze({
  artifacts: Object.freeze([{
    contents: serializeContractProposalSource(proposalSource),
    path: `.uiwitness/contract-generations/${sourceName}.source.json`,
    publication: "immutable" as const,
    role: "contract-source" as const,
  }, {
    contents: serializeContractProposal(proposal),
    path: `.uiwitness/contract-candidates/${proposalName}.proposal.json`,
    publication: "immutable" as const,
    role: "contract-proposal" as const,
  }, {
    contents: serializeContractProposalMetadata(emptyContractProposalMetadata(proposal)),
    mutable: true,
    path: `.uiwitness/contract-candidates/${proposalName}.metadata.json`,
    publication: "immutable" as const,
    role: "contract-metadata" as const,
  }, {
    contents: serializedContractVerdict,
    path: ".uiwitness/contract-verdict.json",
    publication: "replace" as const,
    role: "contract-verdict" as const,
  }, {
    contents: serializedContractVerdict,
    path: "machine/verdict.json",
    publication: "exclusive" as const,
    role: "json-copy" as const,
  }]),
  runDigest,
  sourceGenerationDigests: [sourceDigest],
  toolVersion: "0.26.4",
});
const reusableFinalization = Object.freeze({
  ...finalization,
  artifacts: finalization.artifacts.filter(({ role }) => role !== "json-copy"),
});

describe("atomic generation persistence", () => {
  it("publishes a digest-bound manifest, stable marker, sidecars, report, and HTML", async () => {
    const root = await temporaryProject();
    const lock = await acquirePersistenceLock(root);
    try {
      const committed = await persistReport(root, lock, report, [], undefined, finalization);
      const marker = parseCommittedGeneration(
        await readFile(join(root, ".uiwitness/generation.json"), "utf8"),
      );
      const manifest = parseAnyGenerationManifest(
        await readFile(join(root, marker.manifestPath), "utf8"),
      );
      const evidenceManifest = parseEvidenceManifest(
        await readFile(join(root, ...EVIDENCE_MANIFEST_PATH.split("/")), "utf8"),
      );

      expect(marker).toEqual(committed);
      expect(generationManifestDigest(manifest)).toBe(marker.manifestDigest);
      expect(evidenceManifest).toMatchObject({
        generationDigest: runDigest,
        reportDigest: manifest.reportDigest,
        verdictDigest: manifest.artifacts.find(
          ({ role }) => role === "contract-verdict",
        )?.digest,
      });
      expect(manifest.artifacts.map(({ role }) => role)).toEqual([
        "contract-metadata",
        "contract-proposal",
        "contract-source",
        "contract-verdict",
        "evidence-manifest",
        "report-html",
        "report-json",
        "json-copy",
      ]);
      for (const artifact of manifest.artifacts) {
        const bytes = await readFile(join(root, ...artifact.path.split("/")));
        expect(bytes.byteLength).toBe(artifact.bytes);
        expect(`sha256:${createHash("sha256").update(bytes).digest("hex")}`)
          .toBe(artifact.digest);
      }
      await expect(readFile(join(root, ".uiwitness/contract-verdict.json"), "utf8"))
        .resolves.toContain("failed");
    } finally {
      await releasePersistenceLock(lock).catch(() => undefined);
      await rm(root, { force: true, recursive: true });
    }
  });

  it("recovers a process death in the middle of a journaled generation swap", async () => {
    const root = await temporaryProject();
    const baselineLock = await acquirePersistenceLock(root);
    await persistReport(root, baselineLock, report, []);
    await releasePersistenceLock(baselineLock);
    const evidenceRoot = join(root, ".uiwitness");
    const reportPath = join(evidenceRoot, "report", "uiwitness.json");
    const markerPath = join(evidenceRoot, "generation.json");
    const previousReport = await readFile(reportPath, "utf8");
    const previousMarker = await readFile(markerPath, "utf8");
    const explicitVerdictPath = join(root, "machine", "verdict.json");
    const stagingRoot = join(evidenceRoot, ".runner-persistence-stage-interrupted");
    const lockRoot = join(evidenceRoot, ".runner-persistence-lock");
    try {
      await mkdir(join(stagingRoot, "artifacts"), { recursive: true });
      await mkdir(dirname(explicitVerdictPath), { recursive: true });
      await writeFile(join(stagingRoot, "index.html"), "uncommitted html\n");
      await writeFile(join(stagingRoot, "uiwitness.json"), "uncommitted report\n");
      await writeFile(join(stagingRoot, "sidecar-00000"), "uncommitted marker\n");
      await writeFile(explicitVerdictPath, "uncommitted verdict\n");
      await writeFile(
        join(stagingRoot, "publication-journal.json"),
        `${JSON.stringify({
          additional: [
            { index: 0, path: ".uiwitness/generation.json" },
            { index: 1, path: "machine/verdict.json" },
          ],
          markerDigest: digest("uncommitted marker\n"),
          schemaVersion: 1,
        })}\n`,
      );
      await rename(reportPath, join(stagingRoot, "previous-uiwitness.json"));
      await rename(join(stagingRoot, "uiwitness.json"), reportPath);
      await rename(markerPath, join(stagingRoot, "previous-sidecar-00000"));
      await mkdir(lockRoot);
      await writeFile(join(lockRoot, "owner.json"), `${JSON.stringify({
        pid: 2_147_483_647,
        schemaVersion: 1,
        token: "interrupted-generation",
      })}\n`);
      await writeFile(join(lockRoot, "publishing"), "publishing\n");

      const recovered = await acquirePersistenceLock(root);
      await expect(readFile(reportPath, "utf8")).resolves.toBe(previousReport);
      await expect(readFile(markerPath, "utf8")).resolves.toBe(previousMarker);
      await expect(readFile(explicitVerdictPath, "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await expect(readFile(join(stagingRoot, "publication-journal.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await releasePersistenceLock(recovered);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "recovers a process death between a no-clobber link and staged-link cleanup",
    async () => {
      const root = await temporaryProject();
      const baselineLock = await acquirePersistenceLock(root);
      await persistReport(root, baselineLock, report, []);
      await releasePersistenceLock(baselineLock);
      const evidenceRoot = join(root, ".uiwitness");
      const markerPath = join(evidenceRoot, "generation.json");
      const previousMarker = await readFile(markerPath, "utf8");
      const stagingRoot = join(evidenceRoot, ".runner-persistence-stage-linked");
      const target = join(root, "machine/verdict.json");
      try {
        await mkdir(join(stagingRoot, "artifacts"), { recursive: true });
        await mkdir(dirname(target), { recursive: true });
        await writeFile(join(stagingRoot, "index.html"), "staged html\n");
        await writeFile(join(stagingRoot, "uiwitness.json"), "staged report\n");
        await writeFile(join(stagingRoot, "sidecar-00000"), "linked verdict\n");
        await link(join(stagingRoot, "sidecar-00000"), target);
        await writeFile(join(stagingRoot, "sidecar-00001"), previousMarker);
        await rename(markerPath, join(stagingRoot, "previous-sidecar-00001"));
        await writeFile(join(stagingRoot, "publication-journal.json"), `${JSON.stringify({
          additional: [
            { index: 0, path: "machine/verdict.json" },
            { index: 1, path: ".uiwitness/generation.json" },
          ],
          markerDigest: digest(previousMarker),
          schemaVersion: 1,
        })}\n`);
        const lockRoot = join(evidenceRoot, ".runner-persistence-lock");
        await mkdir(lockRoot);
        await writeFile(join(lockRoot, "owner.json"), `${JSON.stringify({
          pid: 2_147_483_647,
          schemaVersion: 1,
          token: "linked-sidecar-generation",
        })}\n`);
        await writeFile(join(lockRoot, "publishing"), "publishing\n");

        const recovered = await acquirePersistenceLock(root);
        await expect(readFile(markerPath, "utf8")).resolves.toBe(previousMarker);
        await expect(readFile(target, "utf8"))
          .rejects.toMatchObject({ code: "ENOENT" });
        await releasePersistenceLock(recovered);
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    },
  );

  it("keeps a durably committed generation when its writer dies before lock cleanup", async () => {
    const root = await temporaryProject();
    try {
      const initialLock = await acquirePersistenceLock(root);
      await persistReport(root, initialLock, report, []);
      const expectedMarker = await readFile(join(root, ".uiwitness/generation.json"), "utf8");
      await releasePersistenceLock(initialLock);
      const lockRoot = join(root, ".uiwitness/.runner-persistence-lock");
      await mkdir(lockRoot);
      await writeFile(join(lockRoot, "owner.json"), `${JSON.stringify({
        pid: 2_147_483_647,
        schemaVersion: 1,
        token: "committed-generation",
      })}\n`);
      await writeFile(join(lockRoot, "publishing"), "publishing\n");
      await writeFile(join(lockRoot, "committed"), "committed\n");

      const recovered = await acquirePersistenceLock(root);
      await expect(readFile(join(root, ".uiwitness/generation.json"), "utf8"))
        .resolves.toBe(expectedMarker);
      await releasePersistenceLock(recovered);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("recovers cleanup-only state after a committed publication", async () => {
    const root = await temporaryProject();
    try {
      const lock = await acquirePersistenceLock(root);
      let rejectedCleanup = false;
      await expect(persistReport(root, lock, report, [], {
        remove: async (path, options) => {
          if (
            !rejectedCleanup &&
            options?.recursive === true &&
            String(path).includes(".runner-persistence-stage-")
          ) {
            rejectedCleanup = true;
            throw new Error("injected committed cleanup failure");
          }
          await rm(path, options);
        },
        rename,
      })).rejects.toThrow("Result persistence cleanup failed");
      const expectedMarker = await readFile(join(root, ".uiwitness/generation.json"), "utf8");
      await expect(readFile(join(lock.directory, "committed"), "utf8"))
        .resolves.toBe("committed\n");
      await expect(readFile(join(lock.directory, "recovery"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
      await writeFile(join(lock.directory, "owner.json"), `${JSON.stringify({
        pid: 2_147_483_647,
        schemaVersion: 1,
        token: lock.token,
      })}\n`);

      const recovered = await acquirePersistenceLock(root);
      await expect(readFile(join(root, ".uiwitness/generation.json"), "utf8"))
        .resolves.toBe(expectedMarker);
      expect((await readdir(join(root, ".uiwitness"))).some((entry) =>
        entry.startsWith(".runner-persistence-stage-")
      )).toBe(false);
      await releasePersistenceLock(recovered);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("treats the stable marker swap as the commit point after a process death", async () => {
    const root = await temporaryProject();
    try {
      const initialLock = await acquirePersistenceLock(root);
      await persistReport(root, initialLock, report, []);
      await releasePersistenceLock(initialLock);
      const evidenceRoot = join(root, ".uiwitness");
      const reportRoot = join(evidenceRoot, "report");
      const stagingRoot = join(evidenceRoot, ".runner-persistence-stage-committed");
      const expectedReport = await readFile(join(reportRoot, "uiwitness.json"), "utf8");
      const expectedHtml = await readFile(join(reportRoot, "index.html"), "utf8");
      const expectedMarker = await readFile(join(evidenceRoot, "generation.json"), "utf8");
      await mkdir(stagingRoot);
      await rename(join(evidenceRoot, "artifacts"), join(stagingRoot, "previous-artifacts"));
      await mkdir(join(evidenceRoot, "artifacts"));
      await rename(join(reportRoot, "uiwitness.json"), join(stagingRoot, "previous-uiwitness.json"));
      await writeFile(join(reportRoot, "uiwitness.json"), expectedReport);
      await rename(join(reportRoot, "index.html"), join(stagingRoot, "previous-index.html"));
      await writeFile(join(reportRoot, "index.html"), expectedHtml);
      await rename(join(evidenceRoot, "generation.json"), join(stagingRoot, "previous-sidecar-00000"));
      await writeFile(join(evidenceRoot, "generation.json"), expectedMarker);
      await writeFile(join(stagingRoot, "publication-journal.json"), `${JSON.stringify({
        additional: [{ index: 0, path: ".uiwitness/generation.json" }],
        markerDigest: digest(expectedMarker),
        schemaVersion: 1,
      })}\n`);
      const lockRoot = join(evidenceRoot, ".runner-persistence-lock");
      await mkdir(lockRoot);
      await writeFile(join(lockRoot, "owner.json"), `${JSON.stringify({
        pid: 2_147_483_647,
        schemaVersion: 1,
        token: "marker-committed-generation",
      })}\n`);
      await writeFile(join(lockRoot, "publishing"), "publishing\n");

      const recovered = await acquirePersistenceLock(root);
      await expect(readFile(join(reportRoot, "uiwitness.json"), "utf8"))
        .resolves.toBe(expectedReport);
      await expect(readFile(join(reportRoot, "index.html"), "utf8"))
        .resolves.toBe(expectedHtml);
      await expect(readFile(join(evidenceRoot, "generation.json"), "utf8"))
        .resolves.toBe(expectedMarker);
      await releasePersistenceLock(recovered);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves rollback data when the published marker is not valid", async () => {
    const root = await temporaryProject();
    try {
      const initialLock = await acquirePersistenceLock(root);
      await persistReport(root, initialLock, report, []);
      await releasePersistenceLock(initialLock);
      const evidenceRoot = join(root, ".uiwitness");
      const reportRoot = join(evidenceRoot, "report");
      const stagingRoot = join(evidenceRoot, ".runner-persistence-stage-invalid-marker");
      await mkdir(stagingRoot);
      await rename(join(evidenceRoot, "artifacts"), join(stagingRoot, "previous-artifacts"));
      await mkdir(join(evidenceRoot, "artifacts"));
      await rename(join(reportRoot, "uiwitness.json"), join(stagingRoot, "previous-uiwitness.json"));
      await writeFile(join(reportRoot, "uiwitness.json"), "new report\n");
      await rename(join(reportRoot, "index.html"), join(stagingRoot, "previous-index.html"));
      await writeFile(join(reportRoot, "index.html"), "new html\n");
      await rename(join(evidenceRoot, "generation.json"), join(stagingRoot, "previous-sidecar-00000"));
      const invalidMarker = "invalid marker\n";
      await writeFile(join(evidenceRoot, "generation.json"), invalidMarker);
      await writeFile(join(stagingRoot, "publication-journal.json"), `${JSON.stringify({
        additional: [{ index: 0, path: ".uiwitness/generation.json" }],
        markerDigest: digest(invalidMarker),
        schemaVersion: 1,
      })}\n`);
      const lockRoot = join(evidenceRoot, ".runner-persistence-lock");
      await mkdir(lockRoot);
      await writeFile(join(lockRoot, "owner.json"), `${JSON.stringify({
        pid: 2_147_483_647,
        schemaVersion: 1,
        token: "invalid-marker-generation",
      })}\n`);
      await writeFile(join(lockRoot, "publishing"), "publishing\n");

      await expect(acquirePersistenceLock(root)).rejects.toThrow(
        ".uiwitness contains recovery state",
      );
      await expect(readFile(join(stagingRoot, "previous-uiwitness.json"), "utf8"))
        .resolves.toContain("schemaVersion");
      await expect(readFile(join(evidenceRoot, "generation.json"), "utf8"))
        .resolves.toBe(invalidMarker);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("preserves recovery state when a valid marker references a changed manifest", async () => {
    const root = await temporaryProject();
    try {
      const initialLock = await acquirePersistenceLock(root);
      await persistReport(root, initialLock, report, []);
      await releasePersistenceLock(initialLock);
      const evidenceRoot = join(root, ".uiwitness");
      const reportRoot = join(evidenceRoot, "report");
      const markerPath = join(evidenceRoot, "generation.json");
      const markerContents = await readFile(markerPath, "utf8");
      const marker = parseCommittedGeneration(markerContents);
      const manifestPath = join(root, marker.manifestPath);
      const manifest = parseAnyGenerationManifest(await readFile(manifestPath, "utf8"));
      if (manifest.schemaVersion !== 2) throw new Error("Expected a privacy generation.");
      await writeFile(manifestPath, serializePrivacyGenerationManifest({
        ...manifest,
        toolVersion: `${manifest.toolVersion}-changed`,
      }));

      const stagingRoot = join(evidenceRoot, ".runner-persistence-stage-changed-manifest");
      await mkdir(join(stagingRoot, "artifacts"), { recursive: true });
      await writeFile(
        join(stagingRoot, "uiwitness.json"),
        await readFile(join(reportRoot, "uiwitness.json")),
      );
      await writeFile(
        join(stagingRoot, "index.html"),
        await readFile(join(reportRoot, "index.html")),
      );
      await writeFile(join(stagingRoot, "publication-journal.json"), `${JSON.stringify({
        additional: [{ index: 0, path: ".uiwitness/generation.json" }],
        markerDigest: digest(markerContents),
        schemaVersion: 1,
      })}\n`);
      const lockRoot = join(evidenceRoot, ".runner-persistence-lock");
      await mkdir(lockRoot);
      await writeFile(join(lockRoot, "owner.json"), `${JSON.stringify({
        pid: 2_147_483_647,
        schemaVersion: 1,
        token: "changed-manifest-generation",
      })}\n`);
      await writeFile(join(lockRoot, "publishing"), "publishing\n");

      await expect(acquirePersistenceLock(root)).rejects.toThrow(
        ".uiwitness contains recovery state",
      );
      await expect(readFile(join(stagingRoot, "publication-journal.json"), "utf8"))
        .resolves.toContain("generation.json");
      await expect(readFile(join(lockRoot, "recovery"), "utf8"))
        .resolves.toBe("recovery\n");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("reuses identical immutable members and rejects changed bytes without replacing the generation", async () => {
    const root = await temporaryProject();
    try {
      const firstLock = await acquirePersistenceLock(root);
      await persistReport(root, firstLock, report, [], undefined, reusableFinalization);
      await releasePersistenceLock(firstLock);
      const markerPath = join(root, ".uiwitness/generation.json");
      const previousMarker = await readFile(markerPath, "utf8");

      const sameLock = await acquirePersistenceLock(root);
      await persistReport(root, sameLock, report, [], undefined, reusableFinalization);
      await releasePersistenceLock(sameLock);
      await expect(readFile(markerPath, "utf8")).resolves.toBe(previousMarker);

      const immutableProposal = reusableFinalization.artifacts.find(
        ({ role }) => role === "contract-proposal",
      )!;
      await writeFile(join(root, immutableProposal.path), "changed\n");
      const changedLock = await acquirePersistenceLock(root);
      await expect(persistReport(
        root,
        changedLock,
        report,
        [],
        undefined,
        reusableFinalization,
      )).rejects.toThrow("Immutable generation artifact changed");
      await releasePersistenceLock(changedLock);
      await expect(readFile(markerPath, "utf8")).resolves.toBe(previousMarker);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it.skipIf(process.platform === "win32")(
    "rejects symbolic-link and hard-link sidecars without modifying their destinations",
    async () => {
      for (const kind of ["hard", "symbolic"] as const) {
        const root = await temporaryProject();
        const source = join(root, `${kind}-source.json`);
        const target = join(root, ".uiwitness/contract-verdict.json");
        try {
          await mkdir(join(root, ".uiwitness"));
          await writeFile(source, "unchanged\n");
          if (kind === "hard") await link(source, target);
          else await symlink(source, target);
          const lock = await acquirePersistenceLock(root);
          await expect(persistReport(root, lock, report, [], undefined, finalization))
            .rejects.toThrow("Generation artifact target is not a safe regular file");
          await releasePersistenceLock(lock);
          await expect(readFile(source, "utf8")).resolves.toBe("unchanged\n");
        } finally {
          await rm(root, { force: true, recursive: true });
        }
      }
    },
  );

  it("rejects invalid proposal families and reserved control paths before publication", async () => {
    const invalidProposal = {
      artifacts: [{
        contents: "{\"proposal\":true}\n",
        path: ".uiwitness/contract-candidates/proposal.json",
        publication: "immutable" as const,
        role: "contract-proposal" as const,
      }],
      sourceGenerationDigests: [sourceDigest],
      toolVersion: "0.26.4",
    };
    const invalidRoot = await temporaryProject();
    try {
      const lock = await acquirePersistenceLock(invalidRoot);
      await expect(persistReport(
        invalidRoot,
        lock,
        report,
        [],
        undefined,
        invalidProposal,
      )).rejects.toThrow("requires one contract-source");
      await releasePersistenceLock(lock);
    } finally {
      await rm(invalidRoot, { force: true, recursive: true });
    }

    for (const path of [
      ".uiwitness/.runner-persistence-lock/verdict.json",
      ".uiwitness/.runner-lock-candidate-owned/verdict.json",
      ".uiwitness/.runner-persistence-stage-owned/verdict.json",
      ".uiwitness/contract.lock",
      ".uiwitness/generation.json/result.json",
    ]) {
      const root = await temporaryProject();
      try {
        const lock = await acquirePersistenceLock(root);
        await expect(persistReport(root, lock, report, [], undefined, {
          artifacts: [{
            contents: serializedContractVerdict,
            path,
            publication: "exclusive",
            role: "contract-verdict",
          }],
          runDigest,
          toolVersion: "0.26.4",
        })).rejects.toThrow("Duplicate generation artifact path");
        await releasePersistenceLock(lock);
        if (path.startsWith(".uiwitness/generation.json/")) {
          await expect(readFile(join(root, ".uiwitness/generation.json"), "utf8"))
            .rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        await rm(root, { force: true, recursive: true });
      }
    }
  });

  it("rejects an explicit JSON copy that differs from its generation verdict", async () => {
    const root = await temporaryProject();
    try {
      const lock = await acquirePersistenceLock(root);
      await expect(persistReport(root, lock, report, [], undefined, {
        artifacts: [{
          contents: "{\"verdict\":\"failed\"}\n",
          path: ".uiwitness/contract-verdict.json",
          publication: "replace",
          role: "contract-verdict",
        }, {
          contents: "{\"verdict\":\"passed\"}\n",
          path: "machine/verdict.json",
          publication: "exclusive",
          role: "json-copy",
        }],
        toolVersion: "0.26.4",
      })).rejects.toThrow(
        "An explicit JSON copy must exactly match the generation verdict",
      );
      await releasePersistenceLock(lock);
      await expect(readFile(join(root, ".uiwitness/generation.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects caller-supplied runner-owned generation roles", async () => {
    const root = await temporaryProject();
    try {
      const lock = await acquirePersistenceLock(root);
      await expect(persistReport(root, lock, report, [], undefined, {
        artifacts: [{
          contents: "{}\n",
          path: "private/forged-manifest.json",
          publication: "replace",
          role: "evidence-manifest",
        } as never],
        toolVersion: "0.26.8",
      })).rejects.toThrow("sidecars cannot use runner-owned artifact roles");
      await releasePersistenceLock(lock);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a contract verdict whose run digest differs from the generation", async () => {
    const root = await temporaryProject();
    try {
      const lock = await acquirePersistenceLock(root);
      await expect(persistReport(root, lock, report, [], undefined, {
        artifacts: [{
          contents: serializedContractVerdict,
          path: ".uiwitness/contract-verdict.json",
          publication: "replace",
          role: "contract-verdict",
        }],
        runDigest: `sha256:${"b".repeat(64)}`,
        toolVersion: "0.26.4",
      })).rejects.toThrow(
        "generation run digest must exactly match the contract verdict run digest",
      );
      await releasePersistenceLock(lock);
      await expect(readFile(join(root, ".uiwitness/generation.json"), "utf8"))
        .rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects a contract verdict when the generation omits its run digest", async () => {
    const root = await temporaryProject();
    try {
      const lock = await acquirePersistenceLock(root);
      await expect(persistReport(root, lock, report, [], undefined, {
        artifacts: [{
          contents: serializedContractVerdict,
          path: ".uiwitness/contract-verdict.json",
          publication: "replace",
          role: "contract-verdict",
        }],
        toolVersion: "0.26.4",
      })).rejects.toThrow(
        "generation run digest must exactly match the contract verdict run digest",
      );
      await releasePersistenceLock(lock);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("rejects abandoned journals that target descendants of reserved files", async () => {
    const root = await temporaryProject();
    try {
      const initialLock = await acquirePersistenceLock(root);
      await releasePersistenceLock(initialLock);
      const evidenceRoot = join(root, ".uiwitness");
      const stagingRoot = join(evidenceRoot, ".runner-persistence-stage-invalid-path");
      await mkdir(stagingRoot);
      await writeFile(join(stagingRoot, "publication-journal.json"), `${JSON.stringify({
        additional: [{ index: 0, path: ".uiwitness/generation.json/result.json" }],
        markerDigest: digest("marker\n"),
        schemaVersion: 1,
      })}\n`);
      const lockRoot = join(evidenceRoot, ".runner-persistence-lock");
      await mkdir(lockRoot);
      await writeFile(join(lockRoot, "owner.json"), `${JSON.stringify({
        pid: 2_147_483_647,
        schemaVersion: 1,
        token: "invalid-journal-path",
      })}\n`);
      await writeFile(join(lockRoot, "publishing"), "publishing\n");

      await expect(acquirePersistenceLock(root)).rejects.toThrow(
        ".uiwitness contains recovery state",
      );
      await expect(readFile(join(stagingRoot, "publication-journal.json"), "utf8"))
        .resolves.toContain("generation.json/result.json");
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("snapshots mutable finalizer bytes before the first asynchronous boundary", async () => {
    const root = await temporaryProject();
    const original = serializedContractVerdict;
    const bytes = Uint8Array.from(Buffer.from(original));
    try {
      const lock = await acquirePersistenceLock(root);
      const persisted = persistReport(root, lock, report, [], undefined, {
        artifacts: [{
          contents: bytes,
          path: ".uiwitness/contract-verdict.json",
          publication: "replace",
          role: "contract-verdict",
        }],
        runDigest,
        toolVersion: "0.26.4",
      });
      bytes.fill(0x20);
      const committed = await persisted;
      const manifest = parseAnyGenerationManifest(
        await readFile(join(root, committed.manifestPath), "utf8"),
      );
      const verdict = manifest.artifacts.find(({ role }) => role === "contract-verdict")!;
      await expect(readFile(join(root, verdict.path), "utf8")).resolves.toBe(original);
      expect(verdict.digest).toBe(digest(original));
      await releasePersistenceLock(lock);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("does not replace an exclusive artifact that appears after preflight", async () => {
    const root = await temporaryProject();
    const target = join(root, "machine/verdict.json");
    try {
      const lock = await acquirePersistenceLock(root);
      await expect(persistReport(root, lock, report, [], {
        remove: rm,
        rename,
        syncDirectory: syncedDirectory,
        writeFile: async (destination, contents) => {
          await syncedWrite(destination, contents);
          if (destination.endsWith("publication-journal.json")) {
            await syncedWrite(target, "late owner\n");
          }
        },
      }, finalization)).rejects.toThrow("appeared during publication");
      await expect(readFile(target, "utf8")).resolves.toBe("late owner\n");
      await releasePersistenceLock(lock);
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });

  it("restores the previous committed generation after every injected stage, swap, or fsync failure", async () => {
    const traceRoot = await temporaryProject();
    const traceLock = await acquirePersistenceLock(traceRoot);
    const trace: string[] = [];
    try {
      await persistReport(traceRoot, traceLock, evidenceReport, [evidenceArtifact], {
        link: async (source, destination) => {
          trace.push("swap");
          await link(source, destination);
        },
        remove: rm,
        rename: async (source, destination) => {
          trace.push("swap");
          await rename(source, destination);
        },
        syncDirectory: async (path) => {
          trace.push("fsync");
          await syncedDirectory(path);
        },
        writeFile: async (destination, contents) => {
          trace.push("stage");
          await syncedWrite(destination, contents);
        },
      }, finalization);
    } finally {
      await releasePersistenceLock(traceLock).catch(() => undefined);
      await rm(traceRoot, { force: true, recursive: true });
    }

    for (let fault = 0; fault < trace.length; fault += 1) {
      const root = await temporaryProject();
      const baselineLock = await acquirePersistenceLock(root);
      await persistReport(root, baselineLock, report, []);
      await releasePersistenceLock(baselineLock);
      const markerPath = join(root, ".uiwitness/generation.json");
      const previousMarker = await readFile(markerPath, "utf8");
      const previousReport = await readFile(
        join(root, ".uiwitness/report/uiwitness.json"),
        "utf8",
      );
      const previousHtml = await readFile(
        join(root, ".uiwitness/report/index.html"),
        "utf8",
      );
      const previousManifests = await readdir(join(root, ".uiwitness/generations"));
      const lock = await acquirePersistenceLock(root);
      let call = 0;
      const inject = async (kind: string, action: () => Promise<void>): Promise<void> => {
        if (call === fault) {
          call += 1;
          throw new Error(`injected ${kind} failure`);
        }
        call += 1;
        await action();
      };
      try {
        await expect(persistReport(root, lock, evidenceReport, [evidenceArtifact], {
          link: (source, destination) =>
            inject("swap", () => link(source, destination)),
          remove: rm,
          rename: (source, destination) => inject("swap", () => rename(source, destination)),
          syncDirectory: (path) => inject("fsync", () => syncedDirectory(path)),
          writeFile: (destination, contents) =>
            inject("stage", () => syncedWrite(destination, contents)),
        }, finalization)).rejects.toThrow(/injected (?:stage|swap|fsync) failure/u);
        await expect(readFile(markerPath, "utf8")).resolves.toBe(previousMarker);
        await expect(readFile(
          join(root, ".uiwitness/report/uiwitness.json"),
          "utf8",
        )).resolves.toBe(previousReport);
        await expect(readFile(
          join(root, ".uiwitness/report/index.html"),
          "utf8",
        )).resolves.toBe(previousHtml);
        await expect(readdir(join(root, ".uiwitness/generations")))
          .resolves.toEqual(previousManifests);
        await expect(readFile(
          join(root, evidenceArtifact.result.screenshotPath!),
        )).rejects.toMatchObject({ code: "ENOENT" });
        for (const artifact of finalization.artifacts) {
          await expect(readFile(join(root, artifact.path)))
            .rejects.toMatchObject({ code: "ENOENT" });
        }
      } finally {
        if (!lock.preserve) await releasePersistenceLock(lock).catch(() => undefined);
        await rm(root, { force: true, recursive: true });
      }
    }
    expect(trace).toContain("stage");
    expect(trace).toContain("swap");
    expect(trace).toContain("fsync");
  }, 30_000);
});
