import { createHash } from "node:crypto";

import { z, type ZodIssue } from "zod";

import {
  canonicalizeJson,
  canonicalJsonDigest,
  type JsonValue,
  type Sha256Digest,
} from "./canonical-json.js";
import { ShardValidationError } from "./errors.js";

export const SHARD_PLAN_SCHEMA_VERSION = 1 as const;
export const SHARD_BUNDLE_MANIFEST_SCHEMA_VERSION = 2 as const;
export const SHARD_ASSIGNMENT_ALGORITHM = "sha256-uint64be-mod-v1" as const;
export const SHARD_TARGET_DIGEST_ALGORITHM = "jcs-rfc8785+shard-target-v1" as const;
export const SHARD_TTL_MINUTES_DEFAULT = 60 as const;
export const SHARD_TTL_MINUTES_MIN = 5 as const;
export const SHARD_TTL_MINUTES_MAX = 1_440 as const;
export const SHARD_COORDINATE_LIMIT = 10_000 as const;
export const SHARD_COUNT_LIMIT = 10_000 as const;

export interface UIWitnessShardPlan {
  readonly assignmentAlgorithm: typeof SHARD_ASSIGNMENT_ALGORITHM;
  readonly configDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly coordinateIds: readonly string[];
  readonly createdAt: string;
  readonly environmentId: string;
  readonly evaluatedOn: string;
  readonly expiresAt: string;
  readonly nonce: string;
  readonly reportSchemaVersion: 1 | 2;
  readonly runSetId: string;
  readonly schemaVersion: typeof SHARD_PLAN_SCHEMA_VERSION;
  readonly shardCount: number;
  readonly targetDigest: Sha256Digest;
  readonly toolVersion: string;
}

export interface ShardBundleFile {
  readonly bytes: number;
  readonly digest: Sha256Digest;
  readonly path: string;
  readonly role: "evidence" | "report";
}

export interface ShardBundleEvidenceMask {
  readonly cardinalities: readonly number[];
  readonly id: string;
}

/** Privacy-safe capture totals needed to reproduce the final evidence manifest. */
export interface ShardBundleEvidence {
  readonly attempted: number;
  readonly captured: number;
  readonly masks: readonly ShardBundleEvidenceMask[];
  readonly omitted: number;
  readonly retention: "all" | "failures-only" | "none";
}

export interface UIWitnessShardBundleManifest {
  readonly assignedCoordinateIds: readonly string[];
  readonly assignmentAlgorithm: typeof SHARD_ASSIGNMENT_ALGORITHM;
  readonly configDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly createdAt: string;
  readonly evidence: ShardBundleEvidence;
  readonly environmentId: string;
  readonly evaluatedOn: string;
  readonly executedCoordinateIds: readonly string[];
  readonly expiresAt: string;
  readonly files: readonly ShardBundleFile[];
  readonly nonce: string;
  readonly planDigest: Sha256Digest;
  readonly reportDigest: Sha256Digest;
  readonly reportSchemaVersion: 1 | 2;
  readonly runSetId: string;
  readonly schemaVersion: typeof SHARD_BUNDLE_MANIFEST_SCHEMA_VERSION;
  readonly shardCount: number;
  readonly shardIndex: number;
  readonly targetDigest: Sha256Digest;
  readonly toolVersion: string;
}

export interface CreateShardPlanInput {
  readonly configDigest: Sha256Digest;
  readonly contractDigest: Sha256Digest;
  readonly coordinateIds: readonly string[];
  readonly createdAt: Date;
  readonly environmentId?: string | undefined;
  readonly nonce: string;
  readonly reportSchemaVersion: 1 | 2;
  readonly shardCount: number;
  readonly targetDigest: Sha256Digest;
  readonly toolVersion: string;
  readonly ttlMinutes?: number | undefined;
}

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u) as z.ZodType<Sha256Digest>;
const coordinateIdSchema = z.string().min(1).max(1_024).regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*\/[a-z0-9]+(?:-[a-z0-9]+)*$/u,
  "Coordinates must use route/state/viewport/theme with lowercase kebab-case IDs.",
);
const canonicalTimestampSchema = z.string().datetime({ offset: true }).refine(
  (value) => new Date(value).toISOString() === value,
  "Timestamps must use canonical UTC ISO-8601 form.",
);
const evaluatedOnSchema = z.string().regex(/^\d{4}-\d{2}-\d{2}$/u);
const environmentIdSchema = z.string().regex(
  /^[a-z0-9]+(?:-[a-z0-9]+)*$/u,
  "Environment IDs must use lowercase letters or numbers separated by single hyphens.",
);
const nonceSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const runSetIdSchema = z.string().regex(/^[a-f0-9]{64}$/u);
const safeBundlePathSchema = z.string().min(1).max(1_024).refine((value) => {
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  return value.split("/").every(
    (segment) => segment.length > 0 && segment !== "." && segment !== "..",
  );
}, "Bundle file paths must be safe relative POSIX paths.");

const planSchema = z.strictObject({
  assignmentAlgorithm: z.literal(SHARD_ASSIGNMENT_ALGORITHM),
  configDigest: digestSchema,
  contractDigest: digestSchema,
  coordinateIds: z.array(coordinateIdSchema).min(1).max(SHARD_COORDINATE_LIMIT),
  createdAt: canonicalTimestampSchema,
  environmentId: environmentIdSchema,
  evaluatedOn: evaluatedOnSchema,
  expiresAt: canonicalTimestampSchema,
  nonce: nonceSchema,
  reportSchemaVersion: z.union([z.literal(1), z.literal(2)]),
  runSetId: runSetIdSchema,
  schemaVersion: z.literal(SHARD_PLAN_SCHEMA_VERSION),
  shardCount: z.number().int().min(1).max(SHARD_COUNT_LIMIT),
  targetDigest: digestSchema,
  toolVersion: z.string().min(1).max(128),
});

const fileSchema = z.strictObject({
  bytes: z.number().int().nonnegative(),
  digest: digestSchema,
  path: safeBundlePathSchema,
  role: z.enum(["evidence", "report"]),
});

const bundleEvidenceSchema = z.strictObject({
  attempted: z.number().int().nonnegative(),
  captured: z.number().int().nonnegative(),
  masks: z.array(z.strictObject({
    cardinalities: z.array(z.number().int().nonnegative()).min(1).max(SHARD_COORDINATE_LIMIT),
    id: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u),
  })).max(SHARD_COORDINATE_LIMIT),
  omitted: z.number().int().nonnegative(),
  retention: z.enum(["all", "failures-only", "none"]),
});

const bundleManifestSchema = z.strictObject({
  assignedCoordinateIds: z.array(coordinateIdSchema).max(SHARD_COORDINATE_LIMIT),
  assignmentAlgorithm: z.literal(SHARD_ASSIGNMENT_ALGORITHM),
  configDigest: digestSchema,
  contractDigest: digestSchema,
  createdAt: canonicalTimestampSchema,
  evidence: bundleEvidenceSchema,
  environmentId: environmentIdSchema,
  evaluatedOn: evaluatedOnSchema,
  executedCoordinateIds: z.array(coordinateIdSchema).max(SHARD_COORDINATE_LIMIT),
  expiresAt: canonicalTimestampSchema,
  files: z.array(fileSchema).min(1).max(SHARD_COORDINATE_LIMIT + 1),
  nonce: nonceSchema,
  planDigest: digestSchema,
  reportDigest: digestSchema,
  reportSchemaVersion: z.union([z.literal(1), z.literal(2)]),
  runSetId: runSetIdSchema,
  schemaVersion: z.literal(SHARD_BUNDLE_MANIFEST_SCHEMA_VERSION),
  shardCount: z.number().int().min(1).max(SHARD_COUNT_LIMIT),
  shardIndex: z.number().int().min(1).max(SHARD_COUNT_LIMIT),
  targetDigest: digestSchema,
  toolVersion: z.string().min(1).max(128),
});

function issuePath(root: string, issue: ZodIssue): string {
  return issue.path.reduce<string>((path, segment) =>
    typeof segment === "number" ? `${path}[${segment}]` : `${path}.${String(segment)}`,
  root);
}

function invalid(message: string, path = "$", code: "duplicate" | "invalid_syntax" | "invalid_type" | "invalid_value" = "invalid_value"): never {
  throw new ShardValidationError([{ code, message, path }]);
}

function invalidZod(issues: readonly ZodIssue[]): never {
  throw new ShardValidationError(issues.map((issue) => ({
    code: issue.code === "invalid_type"
      ? "invalid_type"
      : issue.code === "unrecognized_keys" ? "unrecognized_key" : "invalid_value",
    message: issue.message,
    path: issuePath("$", issue),
  })));
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value as Record<string, unknown>)) freeze(nested);
    Object.freeze(value);
  }
  return value;
}

function orderedUnique(values: readonly string[]): boolean {
  return values.every((value, index) => index === 0 || values[index - 1]! < value);
}

function parseCanonical(source: string): JsonValue {
  let value: unknown;
  try {
    value = JSON.parse(source);
  } catch {
    return invalid("Shard JSON must be valid canonical JSON.", "$", "invalid_syntax");
  }
  let canonical: string;
  try {
    canonical = canonicalizeJson(value as JsonValue);
  } catch {
    return invalid("Shard JSON must contain only strict canonical JSON values.");
  }
  if (source !== canonical && source !== `${canonical}\n`) {
    return invalid("Shard JSON must use its exact canonical representation.", "$", "invalid_syntax");
  }
  return value as JsonValue;
}

function planPayload(plan: Omit<UIWitnessShardPlan, "runSetId">): JsonValue {
  return plan as unknown as JsonValue;
}

function withoutRunSetId(plan: UIWitnessShardPlan): Omit<UIWitnessShardPlan, "runSetId"> {
  const payload: Record<string, unknown> = { ...plan };
  delete payload["runSetId"];
  return payload as unknown as Omit<UIWitnessShardPlan, "runSetId">;
}

function validatePlanValue(input: unknown): UIWitnessShardPlan {
  const result = planSchema.safeParse(input);
  if (!result.success) return invalidZod(result.error.issues);
  return validatePlanInvariants(result.data);
}

/** Returns the portable nonce-bound identifier for an exact shard-plan payload. */
export function shardPlanRunSetId(plan: Omit<UIWitnessShardPlan, "runSetId">): string {
  const result = planSchema.safeParse({ ...plan, runSetId: "0".repeat(64) });
  if (!result.success) return invalidZod(result.error.issues);
  return canonicalJsonDigest(planPayload(withoutRunSetId(result.data))).slice("sha256:".length);
}

/** Returns the canonical digest of a complete validated shard plan. */
export function shardPlanDigest(plan: UIWitnessShardPlan): Sha256Digest {
  return canonicalJsonDigest(validatePlanValue(plan) as unknown as JsonValue);
}

function validatePlanInvariants(plan: UIWitnessShardPlan): UIWitnessShardPlan {
  if (!orderedUnique(plan.coordinateIds)) {
    return invalid("Shard-plan coordinate IDs must be unique and canonically ordered.", "$.coordinateIds", "duplicate");
  }
  const createdAt = Date.parse(plan.createdAt);
  const expiresAt = Date.parse(plan.expiresAt);
  const ttlMinutes = (expiresAt - createdAt) / 60_000;
  if (
    plan.evaluatedOn !== plan.createdAt.slice(0, 10) ||
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < SHARD_TTL_MINUTES_MIN ||
    ttlMinutes > SHARD_TTL_MINUTES_MAX
  ) {
    return invalid("Shard-plan timestamps must describe a canonical 5m to 1440m lifetime.", "$.expiresAt");
  }
  const payload = withoutRunSetId(plan);
  if (plan.runSetId !== shardPlanRunSetId(payload)) {
    return invalid("Shard-plan runSetId does not match its nonce-bound canonical payload.", "$.runSetId");
  }
  return freeze(plan);
}

/** Builds and validates a deterministic shard plan around a caller-generated 128-bit nonce. */
export function createShardPlan(input: CreateShardPlanInput): UIWitnessShardPlan {
  const ttlMinutes = input.ttlMinutes ?? SHARD_TTL_MINUTES_DEFAULT;
  if (!Number.isInteger(ttlMinutes) || ttlMinutes < SHARD_TTL_MINUTES_MIN || ttlMinutes > SHARD_TTL_MINUTES_MAX) {
    return invalid("Shard-plan TTL must be a whole number of minutes from 5 through 1440.", "$.ttlMinutes");
  }
  if (!Number.isFinite(input.createdAt.getTime())) {
    return invalid("Shard-plan creation time must be a valid instant.", "$.createdAt");
  }
  const createdAt = input.createdAt.toISOString();
  const payload = {
    assignmentAlgorithm: SHARD_ASSIGNMENT_ALGORITHM,
    configDigest: input.configDigest,
    contractDigest: input.contractDigest,
    coordinateIds: [...input.coordinateIds].sort(),
    createdAt,
    environmentId: input.environmentId ?? "default",
    evaluatedOn: createdAt.slice(0, 10),
    expiresAt: new Date(input.createdAt.getTime() + ttlMinutes * 60_000).toISOString(),
    nonce: input.nonce,
    reportSchemaVersion: input.reportSchemaVersion,
    schemaVersion: SHARD_PLAN_SCHEMA_VERSION,
    shardCount: input.shardCount,
    targetDigest: input.targetDigest,
    toolVersion: input.toolVersion,
  } satisfies Omit<UIWitnessShardPlan, "runSetId">;
  const result = planSchema.safeParse({ ...payload, runSetId: shardPlanRunSetId(payload) });
  if (!result.success) return invalidZod(result.error.issues);
  return validatePlanInvariants(result.data);
}

/** Parses exact canonical shard-plan JSON and verifies its nonce-bound identifier. */
export function parseShardPlan(source: string): UIWitnessShardPlan {
  return validatePlanValue(parseCanonical(source));
}

/** Serializes a shard plan as exact RFC 8785 JSON with one trailing newline. */
export function serializeShardPlan(plan: UIWitnessShardPlan): string {
  return `${canonicalizeJson(validatePlanValue(plan) as unknown as JsonValue)}\n`;
}

/** Produces the target digest from a normalized HTTP(S) origin and non-secret environment ID. */
export function shardTargetDigest(baseURL: string, environmentId = "default"): Sha256Digest {
  const environmentResult = environmentIdSchema.safeParse(environmentId);
  if (!environmentResult.success) return invalidZod(environmentResult.error.issues);
  let url: URL;
  try {
    url = new URL(baseURL);
  } catch {
    return invalid("Shard targets require a valid HTTP(S) base URL.", "$.baseURL");
  }
  if (!(["http:", "https:"] as const).includes(url.protocol as "http:" | "https:")) {
    return invalid("Shard targets require an HTTP(S) base URL.", "$.baseURL");
  }
  if (url.username.length > 0 || url.password.length > 0) {
    return invalid("Shard targets cannot contain URL credentials.", "$.baseURL");
  }
  return canonicalJsonDigest({
    algorithm: SHARD_TARGET_DIGEST_ALGORITHM,
    environmentId: environmentResult.data,
    origin: url.origin,
  });
}

/** Assigns one canonical coordinate to a zero-based shard using the fixed v1 algorithm. */
export function shardIndexForCoordinate(coordinateId: string, shardCount: number): number {
  if (!Number.isInteger(shardCount) || shardCount < 1 || shardCount > SHARD_COUNT_LIMIT) {
    return invalid("Shard count must be a whole number from 1 through 10000.", "$.shardCount");
  }
  const hash = createHash("sha256").update(coordinateId, "utf8").digest();
  return Number(hash.readBigUInt64BE(0) % BigInt(shardCount));
}

/** Returns the plan-order coordinates assigned to a one-based shard. */
export function assignedShardCoordinateIds(plan: UIWitnessShardPlan, shardIndex: number): readonly string[] {
  const validated = validatePlanValue(plan);
  if (!Number.isInteger(shardIndex) || shardIndex < 1 || shardIndex > validated.shardCount) {
    return invalid("Shard index must be within the plan's one-based shard range.", "$.shardIndex");
  }
  return Object.freeze(validated.coordinateIds.filter(
    (coordinateId) => shardIndexForCoordinate(coordinateId, validated.shardCount) === shardIndex - 1,
  ));
}

/** Parses an exact one-based `N/M` shard specifier. */
export function parseShardSpecifier(value: string): { readonly shardCount: number; readonly shardIndex: number } {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/u.exec(value);
  if (match === null) return invalid("Shard specifiers must use the exact one-based N/M form.", "$.shard");
  const shardIndex = Number(match[1]);
  const shardCount = Number(match[2]);
  if (!Number.isSafeInteger(shardCount) || shardCount < 1 || shardCount > SHARD_COUNT_LIMIT || !Number.isSafeInteger(shardIndex) || shardIndex < 1 || shardIndex > shardCount) {
    return invalid("Shard specifiers must identify one shard within a total of 1 through 10000.", "$.shard");
  }
  return Object.freeze({ shardCount, shardIndex });
}

/** Fails closed when a plan has not started or has reached its expiry instant. */
export function assertShardPlanActive(plan: UIWitnessShardPlan, evaluatedAt: Date): void {
  const validated = validatePlanValue(plan);
  const instant = evaluatedAt.getTime();
  const createdAt = Date.parse(validated.createdAt);
  const expiresAt = Date.parse(validated.expiresAt);
  if (
    !Number.isFinite(instant) || !Number.isFinite(createdAt) || !Number.isFinite(expiresAt) ||
    instant < createdAt || instant >= expiresAt
  ) {
    return invalid("Shard plan is not active at the evaluation instant.", "$.expiresAt");
  }
}

function validateManifestInvariants(manifest: UIWitnessShardBundleManifest): UIWitnessShardBundleManifest {
  if (manifest.shardIndex > manifest.shardCount) {
    return invalid("Shard manifest index must be within its shard count.", "$.shardIndex");
  }
  if (!orderedUnique(manifest.assignedCoordinateIds) || !orderedUnique(manifest.executedCoordinateIds)) {
    return invalid("Assigned and executed coordinate IDs must be unique and canonically ordered.", "$.assignedCoordinateIds", "duplicate");
  }
  if (
    manifest.assignedCoordinateIds.length !== manifest.executedCoordinateIds.length ||
    manifest.assignedCoordinateIds.some((value, index) => value !== manifest.executedCoordinateIds[index])
  ) {
    return invalid("A complete shard bundle must execute every assigned coordinate exactly once.", "$.executedCoordinateIds");
  }
  if (manifest.assignedCoordinateIds.some((coordinateId) =>
    shardIndexForCoordinate(coordinateId, manifest.shardCount) !== manifest.shardIndex - 1
  )) {
    return invalid("Shard manifest coordinates do not match its fixed shard assignment.", "$.assignedCoordinateIds");
  }
  if (!orderedUnique(manifest.files.map(({ path }) => path))) {
    return invalid("Shard bundle files must use unique canonical path order.", "$.files", "duplicate");
  }
  const reports = manifest.files.filter(({ role }) => role === "report");
  if (reports.length !== 1 || reports[0]!.path !== "report.json" || reports[0]!.digest !== manifest.reportDigest) {
    return invalid("A shard bundle requires exactly one report.json checksum matching reportDigest.", "$.files");
  }
  if (manifest.files.some(({ path, role }) =>
    role === "evidence" && !path.startsWith("evidence/artifacts/")
  )) {
    return invalid("Shard evidence checksums must stay beneath evidence/artifacts/.", "$.files");
  }
  if (
    manifest.evidence.captured > manifest.evidence.attempted ||
    manifest.evidence.attempted > manifest.executedCoordinateIds.length ||
    manifest.evidence.captured + manifest.evidence.omitted !== manifest.executedCoordinateIds.length
  ) {
    return invalid("Shard evidence totals must exactly account for the executed coordinates.", "$.evidence");
  }
  if (manifest.evidence.masks.some(({ cardinalities }) =>
    cardinalities.length > manifest.evidence.attempted
  )) {
    return invalid("Each shard mask summary must fit within the attempted capture count.", "$.evidence.masks");
  }
  if (manifest.files.filter(({ role }) => role === "evidence").length !== manifest.evidence.captured) {
    return invalid("Shard evidence checksums must exactly match the retained capture count.", "$.files");
  }
  if (
    (manifest.reportSchemaVersion === 1 && manifest.evidence.retention !== "all") ||
    (manifest.reportSchemaVersion === 2 && manifest.evidence.retention === "all")
  ) {
    return invalid("Shard evidence retention must match the report schema version.", "$.evidence.retention");
  }
  if (
    manifest.evidence.retention === "none" &&
    (manifest.evidence.attempted !== 0 || manifest.evidence.captured !== 0 || manifest.evidence.masks.length !== 0)
  ) {
    return invalid("Retention 'none' cannot attempt, retain, or mask screenshots.", "$.evidence.retention");
  }
  if (manifest.evidence.masks.some((mask, index) =>
    (index > 0 && manifest.evidence.masks[index - 1]!.id >= mask.id) ||
    mask.cardinalities.some((value, valueIndex) =>
      valueIndex > 0 && mask.cardinalities[valueIndex - 1]! > value
    )
  )) {
    return invalid("Shard evidence masks must use unique canonical ID and cardinality order.", "$.evidence.masks", "duplicate");
  }
  const ttlMinutes = (Date.parse(manifest.expiresAt) - Date.parse(manifest.createdAt)) / 60_000;
  if (
    manifest.evaluatedOn !== manifest.createdAt.slice(0, 10) ||
    !Number.isInteger(ttlMinutes) ||
    ttlMinutes < SHARD_TTL_MINUTES_MIN ||
    ttlMinutes > SHARD_TTL_MINUTES_MAX
  ) {
    return invalid("Shard manifest timestamps must match a canonical plan lifetime.", "$.expiresAt");
  }
  return freeze(manifest);
}

function validateManifestValue(input: unknown): UIWitnessShardBundleManifest {
  const result = bundleManifestSchema.safeParse(input);
  if (!result.success) return invalidZod(result.error.issues);
  return validateManifestInvariants(result.data);
}

/** Parses exact canonical JSON for a complete immutable shard-bundle manifest. */
export function parseShardBundleManifest(source: string): UIWitnessShardBundleManifest {
  return validateManifestValue(parseCanonical(source));
}

/** Validates and serializes a shard-bundle manifest as canonical JSON. */
export function serializeShardBundleManifest(manifest: UIWitnessShardBundleManifest): string {
  return `${canonicalizeJson(validateManifestValue(manifest) as unknown as JsonValue)}\n`;
}
