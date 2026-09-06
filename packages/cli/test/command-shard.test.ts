import { createShardPlan, shardTargetDigest } from "uiwitness-core";
import { beforeEach, describe, expect, it, vi } from "vitest";

const createGuardShardPlanMock = vi.hoisted(() => vi.fn());
const runGuardShardMock = vi.hoisted(() => vi.fn());

vi.mock("../src/guard-shard.js", () => ({
  createGuardShardPlan: createGuardShardPlanMock,
  runGuardShard: runGuardShardMock,
}));

import { runCli } from "../src/command.js";

const digestA = `sha256:${"a".repeat(64)}` as const;
const digestB = `sha256:${"b".repeat(64)}` as const;
const plan = createShardPlan({
  configDigest: digestA,
  contractDigest: digestB,
  coordinateIds: ["home/default/desktop/light"],
  createdAt: new Date("2026-09-05T12:00:00.000Z"),
  environmentId: "us-production",
  nonce: "0123456789abcdef0123456789abcdef",
  reportSchemaVersion: 1,
  shardCount: 4,
  targetDigest: shardTargetDigest("https://example.test", "us-production"),
  toolVersion: "0.26.9",
  ttlMinutes: 30,
});

beforeEach(() => {
  createGuardShardPlanMock.mockReset();
  runGuardShardMock.mockReset();
});

describe("guard shard commands", () => {
  it("parses and reports a nonce-bound shard plan", async () => {
    createGuardShardPlanMock.mockResolvedValue({
      configPath: "/project/uiwitness.config.mjs",
      contractPath: "/project/uiwitness.contract.json",
      largestShard: 1,
      meanShardSize: 0.25,
      plan,
      planPath: ".uiwitness/plan.json",
      warning: "Uneven distribution.",
    });
    const stdout: string[] = [];
    const exit = await runCli({
      args: [
        "guard", "shard-plan", "--shards", "4", "--out", ".uiwitness/plan.json",
        "--environment-id", "us-production", "--ttl", "30m",
      ],
      cwd: "/project",
      stdout: (value) => stdout.push(value),
    });

    expect(exit).toBe(0);
    expect(createGuardShardPlanMock).toHaveBeenCalledWith(expect.objectContaining({
      cwd: "/project",
      environmentId: "us-production",
      outPath: ".uiwitness/plan.json",
      shards: 4,
      ttlMinutes: 30,
    }));
    expect(stdout.join("")).toContain(`Run set: ${plan.runSetId}`);
    expect(stdout.join("")).toContain("Use this exact plan file for every shard.");
  });

  it("returns success for a complete partial bundle even when it records failures", async () => {
    runGuardShardMock.mockResolvedValue({
      bundlePath: `.uiwitness/shards/${plan.runSetId}/2-of-4`,
      configPath: "/project/uiwitness.config.mjs",
      contractPath: "/project/uiwitness.contract.json",
      failed: 2,
      planPath: ".uiwitness/plan.json",
      runSetId: plan.runSetId,
      shardCount: 4,
      shardIndex: 2,
      total: 3,
    });
    const stdout: string[] = [];
    const exit = await runCli({
      args: ["guard", "--shard", "2/4", "--shard-plan", ".uiwitness/plan.json"],
      cwd: "/project",
      stdout: (value) => stdout.push(value),
    });

    expect(exit).toBe(0);
    expect(runGuardShardMock).toHaveBeenCalledWith(expect.objectContaining({
      shard: "2/4",
      shardPlanPath: ".uiwitness/plan.json",
    }));
    expect(stdout.join("")).toContain("Recorded failures: 2");
    expect(stdout.join("")).toContain("T12 will add `uiwitness guard merge`");
  });

  it("rejects incomplete or malformed shard options before execution", async () => {
    const errors: string[] = [];
    for (const args of [
      ["guard", "--shard", "1/2"],
      ["guard", "--shard", "01/02", "--shard-plan", "plan.json"],
      ["guard", "shard-plan", "--shards", "0", "--out", "plan.json"],
      ["guard", "shard-plan", "--shards", "2", "--out", "plan.json", "--ttl", "5h"],
    ]) {
      expect(await runCli({ args, stderr: (value) => errors.push(value) })).toBe(2);
    }
    expect(createGuardShardPlanMock).not.toHaveBeenCalled();
    expect(runGuardShardMock).not.toHaveBeenCalled();
    expect(errors.join("\n")).toContain("must be provided together");
    expect(errors.join("\n")).toContain("exact one-based N/M form");
    expect(errors.join("\n")).toContain("whole number from 1 through 10000");
    expect(errors.join("\n")).toContain("whole minutes from 5m through 1440m");
  });
});
