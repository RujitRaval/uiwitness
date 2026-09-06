import { describe, expect, it } from "vitest";

import {
  SHARD_ASSIGNMENT_ALGORITHM,
  SHARD_BUNDLE_MANIFEST_SCHEMA_VERSION,
  ShardValidationError,
  assertShardPlanActive,
  assignedShardCoordinateIds,
  createShardPlan,
  parseShardBundleManifest,
  parseShardPlan,
  parseShardSpecifier,
  serializeShardBundleManifest,
  serializeShardPlan,
  shardIndexForCoordinate,
  shardPlanDigest,
  shardTargetDigest,
  type UIWitnessShardBundleManifest,
} from "../src/index.js";

const configDigest = `sha256:${"a".repeat(64)}` as const;
const contractDigest = `sha256:${"b".repeat(64)}` as const;
const reportDigest = `sha256:${"c".repeat(64)}` as const;

function plan() {
  return createShardPlan({
    configDigest,
    contractDigest,
    coordinateIds: [
      "settings/empty/mobile/dark",
      "home/default/desktop/light",
      "z/a/wide/light",
    ],
    createdAt: new Date("2026-09-05T12:00:00.000Z"),
    environmentId: "us-production",
    nonce: "0123456789abcdef0123456789abcdef",
    reportSchemaVersion: 2,
    shardCount: 3,
    targetDigest: shardTargetDigest("https://example.com/path?ignored=yes", "us-production"),
    toolVersion: "0.26.9",
    ttlMinutes: 60,
  });
}

describe("deterministic sharding", () => {
  it("matches fixed uint64be SHA-256 assignment vectors", () => {
    expect(shardIndexForCoordinate("home/default/desktop/light", 3)).toBe(0);
    expect(shardIndexForCoordinate("settings/empty/mobile/dark", 3)).toBe(2);
    expect(shardIndexForCoordinate("z/a/wide/light", 3)).toBe(0);
  });

  it("keeps a 10,000-coordinate distribution within the documented warning threshold", () => {
    const counts = Array.from({ length: 32 }, () => 0);
    for (let index = 0; index < 10_000; index += 1) {
      const id = `route-${index}/default/desktop/light`;
      counts[shardIndexForCoordinate(id, counts.length)]! += 1;
    }
    const mean = 10_000 / counts.length;
    expect(Math.max(...counts)).toBeLessThanOrEqual(mean * 1.5);
    expect(counts.reduce((total, count) => total + count, 0)).toBe(10_000);
  });

  it("creates a nonce-bound canonical plan and assigns every coordinate once", () => {
    const value = plan();
    const parsed = parseShardPlan(serializeShardPlan(value));

    expect(parsed).toEqual(value);
    expect(parsed.runSetId).toMatch(/^[a-f0-9]{64}$/u);
    expect(parsed.coordinateIds).toEqual([...parsed.coordinateIds].sort());
    expect(parsed.expiresAt).toBe("2026-09-05T13:00:00.000Z");
    expect(Object.isFrozen(parsed)).toBe(true);

    const assignments = [1, 2, 3].flatMap((index) =>
      assignedShardCoordinateIds(parsed, index)
    ).sort();
    expect(assignments).toEqual(parsed.coordinateIds);

    const second = createShardPlan({
      ...value,
      createdAt: new Date(value.createdAt),
      nonce: "1123456789abcdef0123456789abcdef",
    });
    expect(second.runSetId).not.toBe(value.runSetId);
  });

  it("accepts the exact TTL boundaries and defaults to 60 minutes", () => {
    const seed = plan();
    const create = (ttlMinutes?: number) => createShardPlan({
      configDigest: seed.configDigest,
      contractDigest: seed.contractDigest,
      coordinateIds: seed.coordinateIds,
      createdAt: new Date(seed.createdAt),
      environmentId: seed.environmentId,
      nonce: seed.nonce,
      reportSchemaVersion: seed.reportSchemaVersion,
      shardCount: seed.shardCount,
      targetDigest: seed.targetDigest,
      toolVersion: seed.toolVersion,
      ...(ttlMinutes === undefined ? {} : { ttlMinutes }),
    });

    expect(create(5).expiresAt).toBe("2026-09-05T12:05:00.000Z");
    expect(create(1_440).expiresAt).toBe("2026-09-06T12:00:00.000Z");
    expect(create().expiresAt).toBe("2026-09-05T13:00:00.000Z");
    expect(() => create(1_441)).toThrow(ShardValidationError);
  });

  it("normalizes targets to their origin and binds the environment", () => {
    expect(shardTargetDigest("https://example.com/path?q=1", "production"))
      .toBe(shardTargetDigest("https://example.com:443/elsewhere", "production"));
    expect(shardTargetDigest("https://example.com", "production"))
      .not.toBe(shardTargetDigest("https://example.com", "staging"));
    const credentialed = new URL("https://example.com");
    credentialed.username = "fixture-user";
    credentialed.password = "fixture-password";
    expect(() => shardTargetDigest(credentialed.href, "production"))
      .toThrow(ShardValidationError);
  });

  it("rejects invalid specifiers, environments, TTLs, tampering, and expired plans", () => {
    expect(parseShardSpecifier("2/3")).toEqual({ shardCount: 3, shardIndex: 2 });
    for (const value of ["0/3", "4/3", "1/0", "01/03", "1 / 3", "1/10001"]) {
      expect(() => parseShardSpecifier(value)).toThrow(ShardValidationError);
    }
    expect(() => shardTargetDigest("https://example.com", "US Production"))
      .toThrow(ShardValidationError);
    expect(() => createShardPlan({
      ...plan(),
      createdAt: new Date(Number.NaN),
    })).toThrow(ShardValidationError);
    expect(() => createShardPlan({
      ...plan(),
      createdAt: new Date("2026-09-05T12:00:00.000Z"),
      ttlMinutes: 4,
    })).toThrow(ShardValidationError);
    expect(() => createShardPlan({
      ...plan(),
      coordinateIds: [],
      createdAt: new Date("2026-09-05T12:00:00.000Z"),
    })).toThrow(ShardValidationError);

    const value = plan();
    expect(() => parseShardPlan(serializeShardPlan({ ...value, toolVersion: "tampered" })))
      .toThrow(ShardValidationError);
    expect(() => parseShardPlan(JSON.stringify(value, null, 2))).toThrow(ShardValidationError);
    expect(() => serializeShardPlan({ ...value, extra: true } as never))
      .toThrow(ShardValidationError);
    expect(() => assertShardPlanActive(value, new Date(value.expiresAt)))
      .toThrow(ShardValidationError);
    expect(() => assertShardPlanActive(value, new Date("2026-09-05T12:30:00.000Z")))
      .not.toThrow();
  });

  it("round-trips complete immutable bundle manifests, including empty shards", () => {
    const value = plan();
    const manifest: UIWitnessShardBundleManifest = {
      assignedCoordinateIds: [],
      assignmentAlgorithm: SHARD_ASSIGNMENT_ALGORITHM,
      configDigest,
      contractDigest,
      createdAt: value.createdAt,
      evidence: {
        attempted: 0,
        captured: 0,
        masks: [],
        omitted: 0,
        retention: "none",
      },
      environmentId: value.environmentId,
      evaluatedOn: value.evaluatedOn,
      executedCoordinateIds: [],
      expiresAt: value.expiresAt,
      files: [{ bytes: 42, digest: reportDigest, path: "report.json", role: "report" }],
      nonce: value.nonce,
      planDigest: shardPlanDigest(value),
      reportDigest,
      reportSchemaVersion: 2,
      runSetId: value.runSetId,
      schemaVersion: SHARD_BUNDLE_MANIFEST_SCHEMA_VERSION,
      shardCount: 3,
      shardIndex: 3,
      targetDigest: value.targetDigest,
      toolVersion: value.toolVersion,
    };

    expect(parseShardBundleManifest(serializeShardBundleManifest(manifest))).toEqual(manifest);
    expect(manifest.schemaVersion).toBe(2);
    expect(() => serializeShardBundleManifest({
      ...manifest,
      assignedCoordinateIds: ["home/default/desktop/light"],
    })).toThrow(ShardValidationError);
    expect(() => serializeShardBundleManifest({
      ...manifest,
      reportDigest: configDigest,
    })).toThrow(ShardValidationError);
    expect(() => serializeShardBundleManifest({ ...manifest, extra: true } as never))
      .toThrow(ShardValidationError);
    expect(() => serializeShardBundleManifest({
      ...manifest,
      assignedCoordinateIds: ["home/default/desktop/light"],
      executedCoordinateIds: ["home/default/desktop/light"],
    })).toThrow(ShardValidationError);
    expect(() => serializeShardBundleManifest({
      ...manifest,
      evidence: { ...manifest.evidence, attempted: 1 },
    })).toThrow(ShardValidationError);
    expect(() => serializeShardBundleManifest({
      ...manifest,
      evidence: { ...manifest.evidence, retention: "all" },
    })).toThrow(ShardValidationError);
    expect(() => serializeShardBundleManifest({
      ...manifest,
      evidence: {
        attempted: 0,
        captured: 0,
        masks: [{ cardinalities: [0], id: "optional-mask" }],
        omitted: 0,
        retention: "all",
      },
      reportSchemaVersion: 1,
    })).toThrow(ShardValidationError);
  });
});
