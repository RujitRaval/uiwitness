import { describe, expect, it } from "vitest";

import {
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  PRIVACY_REPORT_SCHEMA_VERSION,
  ConfigValidationError,
  GenerationValidationError,
  parseConfig,
  parseEvidenceManifest,
  parseAnyReport,
  serializeEvidenceManifest,
  serializeReport,
  type UIWitnessEvidenceManifest,
} from "../src/index.js";

const digest = `sha256:${"a".repeat(64)}` as const;

function config(overrides: Record<string, unknown> = {}): unknown {
  return {
    baseURL: "https://app.example.com",
    routes: [{
      id: "settings",
      path: "/settings",
      states: [{ id: "billing", setup: "./billing.mjs" }],
    }],
    themes: ["light"],
    viewports: { desktop: { height: 900, width: 1440 } },
    ...overrides,
  };
}

function emptySummary() {
  const metric = { covered: 0, percentage: 0, total: 0 };
  return {
    coverage: {
      execution: metric,
      responsive: metric,
      state: metric,
      theme: metric,
    },
    durationMs: 0,
    executions: 0,
    failed: 0,
    passed: 0,
    routes: 0,
    states: 0,
  };
}

describe("evidence privacy config", () => {
  it("normalizes retention, masks, and fail-closed defaults", () => {
    expect(parseConfig(config({
      evidence: {
        masks: [{
          id: "account-email",
          routeIds: ["settings"],
          selector: "[data-private='email']",
          stateIds: ["billing"],
        }],
        retention: "failures-only",
      },
    })).evidence).toEqual({
      masks: [{
        id: "account-email",
        required: true,
        routeIds: ["settings"],
        selector: "[data-private='email']",
        stateIds: ["billing"],
      }],
      retention: "failures-only",
    });
  });

  it.each([
    [{ masks: [{ id: "private", selector: " " }] }, "$.evidence.masks[0].selector"],
    [{ masks: [{ count: 0, id: "private", selector: "#private" }] }, "$.evidence.masks[0].count"],
    [{ masks: [{ id: "private", routeIds: ["missing"], selector: "#private" }] }, "$.evidence.masks[0].routeIds[0]"],
    [{ masks: [{ id: "private", selector: "#private", stateIds: [] }] }, "$.evidence.masks[0].stateIds"],
    [{ masks: [{ id: "private", selector: "#a" }, { id: "private", selector: "#b" }] }, "$.evidence.masks[1].id"],
    [{ retention: "passing-only" }, "$.evidence.retention"],
  ])("rejects invalid evidence policy at %s", (evidence, path) => {
    expect(() => parseConfig(config({ evidence }))).toThrow(ConfigValidationError);
    try {
      parseConfig(config({ evidence }));
    } catch (error: unknown) {
      expect((error as ConfigValidationError).issues).toEqual(
        expect.arrayContaining([expect.objectContaining({ path })]),
      );
    }
  });
});

describe("privacy report and evidence manifest", () => {
  it("reads and deterministically serializes schema v2 without weakening v1", () => {
    const report = parseAnyReport({
      evidence: { retention: "none" },
      executions: [],
      generatedAt: "2026-09-05T12:00:00.000Z",
      project: { baseURL: "https://app.example.com" },
      schemaVersion: PRIVACY_REPORT_SCHEMA_VERSION,
      summary: emptySummary(),
    });

    expect(report.schemaVersion).toBe(2);
    expect(serializeReport(report)).toContain('"retention": "none"');
  });

  it("round-trips canonical policy metadata without selectors or content", () => {
    const manifest: UIWitnessEvidenceManifest = {
      attempted: 2,
      captured: 1,
      generationDigest: digest,
      masks: [{ cardinalities: [1, 1], id: "account-email" }],
      omitted: 1,
      reportDigest: digest,
      retention: "failures-only",
      schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
      verdictDigest: null,
    };
    const source = serializeEvidenceManifest(manifest);

    expect(parseEvidenceManifest(source)).toEqual(manifest);
    expect(source).not.toContain("selector");
    expect(() => parseEvidenceManifest(JSON.stringify(manifest))).toThrow(
      GenerationValidationError,
    );
    expect(() => parseEvidenceManifest(
      '{"attempted":1e400,"captured":0,"generationDigest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","masks":[],"omitted":1,"reportDigest":"sha256:0000000000000000000000000000000000000000000000000000000000000000","retention":"none","schemaVersion":1,"verdictDigest":null}\n',
    )).toThrow(GenerationValidationError);
    expect(() => serializeEvidenceManifest({
      ...manifest,
      attempted: 0,
      captured: 1,
      masks: [],
      omitted: 0,
      retention: "none",
    })).toThrow(GenerationValidationError);
  });
});
