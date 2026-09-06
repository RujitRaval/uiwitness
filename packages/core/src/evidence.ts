import { z, type ZodIssue } from "zod";

import {
  canonicalizeJson,
  type JsonValue,
  type Sha256Digest,
} from "./canonical-json.js";
import { GenerationValidationError } from "./errors.js";

/** Version of the privacy-safe evidence manifest. */
export const EVIDENCE_MANIFEST_SCHEMA_VERSION = 1 as const;
export const EVIDENCE_MANIFEST_PATH =
  ".uiwitness/report/evidence-manifest.json" as const;

/** Aggregated successful DOM cardinalities for one non-secret mask ID. */
export interface EvidenceManifestMask {
  readonly cardinalities: readonly number[];
  readonly id: string;
}

/** Auditable policy metadata for one atomically committed evidence generation. */
export interface UIWitnessEvidenceManifest {
  readonly captured: number;
  readonly attempted: number;
  readonly generationDigest: Sha256Digest;
  readonly masks: readonly EvidenceManifestMask[];
  readonly omitted: number;
  readonly reportDigest: Sha256Digest;
  readonly retention: "all" | "failures-only" | "none";
  readonly schemaVersion: typeof EVIDENCE_MANIFEST_SCHEMA_VERSION;
  readonly verdictDigest: Sha256Digest | null;
}

const digestSchema = z.string().regex(/^sha256:[a-f0-9]{64}$/u) as z.ZodType<Sha256Digest>;
const identifierSchema = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/u);
const manifestSchema = z.strictObject({
  attempted: z.number().int().nonnegative(),
  captured: z.number().int().nonnegative(),
  generationDigest: digestSchema,
  masks: z.array(z.strictObject({
    cardinalities: z.array(z.number().int().nonnegative()).min(1),
    id: identifierSchema,
  })),
  omitted: z.number().int().nonnegative(),
  reportDigest: digestSchema,
  retention: z.enum(["all", "failures-only", "none"]),
  schemaVersion: z.literal(EVIDENCE_MANIFEST_SCHEMA_VERSION),
  verdictDigest: digestSchema.nullable(),
}).superRefine((manifest, context) => {
  if (manifest.captured > manifest.attempted) {
    context.addIssue({
      code: "custom",
      message: "Retained evidence cannot exceed screenshot attempts.",
      path: ["captured"],
    });
  }
  if (manifest.captured + manifest.omitted < manifest.attempted) {
    context.addIssue({
      code: "custom",
      message: "Captured and omitted evidence must account for every attempt.",
      path: ["attempted"],
    });
  }
  if (
    manifest.retention === "none" &&
    (manifest.attempted !== 0 || manifest.captured !== 0 || manifest.masks.length !== 0)
  ) {
    context.addIssue({
      code: "custom",
      message: "Retention 'none' cannot attempt, retain, or mask screenshots.",
      path: ["retention"],
    });
  }
  manifest.masks.forEach((mask, index) => {
    if (index > 0 && manifest.masks[index - 1]!.id >= mask.id) {
      context.addIssue({
        code: "custom",
        message: "Manifest masks must have unique canonically ordered IDs.",
        path: ["masks", index, "id"],
      });
    }
  });
});

function invalid(issues: readonly ZodIssue[]): never {
  throw new GenerationValidationError(issues.map((issue) => ({
    code: issue.code === "invalid_type"
      ? "invalid_type"
      : issue.code === "unrecognized_keys" ? "unrecognized_key" : "invalid_value",
    message: issue.message,
    path: issue.path.reduce<string>((path, segment) =>
      typeof segment === "number" ? `${path}[${segment}]` : `${path}.${String(segment)}`,
    "$"),
  })));
}

/** Parses strict canonical evidence-manifest JSON. */
export function parseEvidenceManifest(source: string): UIWitnessEvidenceManifest {
  let input: unknown;
  try {
    input = JSON.parse(source);
  } catch {
    throw new GenerationValidationError([{
      code: "invalid_syntax",
      message: "Evidence manifest must be valid canonical JSON.",
      path: "$",
    }]);
  }
  let canonical: string;
  try {
    canonical = canonicalizeJson(input as JsonValue);
  } catch {
    throw new GenerationValidationError([{
      code: "invalid_value",
      message: "Evidence manifest must contain canonical JSON values.",
      path: "$",
    }]);
  }
  if (`${canonical}\n` !== source) {
    throw new GenerationValidationError([{
      code: "invalid_syntax",
      message: "Evidence manifest must use its exact canonical representation.",
      path: "$",
    }]);
  }
  const result = manifestSchema.safeParse(input);
  if (!result.success) invalid(result.error.issues);
  return Object.freeze({
    ...result.data,
    masks: Object.freeze(result.data.masks.map((mask) => Object.freeze({
      cardinalities: Object.freeze([...mask.cardinalities]),
      id: mask.id,
    }))),
  }) as UIWitnessEvidenceManifest;
}

/** Serializes a validated evidence manifest as canonical JSON. */
export function serializeEvidenceManifest(manifest: UIWitnessEvidenceManifest): string {
  const source = `${canonicalizeJson(manifest as unknown as JsonValue)}\n`;
  parseEvidenceManifest(source);
  return source;
}
