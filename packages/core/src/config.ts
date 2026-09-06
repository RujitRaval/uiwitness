import { z, type ZodIssue } from "zod";

import {
  ConfigValidationError,
  type ConfigValidationIssue,
  type ConfigValidationIssueCode,
} from "./errors.js";
import {
  authenticationCookieDomainIsPublicSuffix,
  normalizedAuthenticationOrigin,
  validAuthenticationCookieDomain,
  type AuthenticationConfig,
} from "./authentication.js";

/** Pixel dimensions for a named browser viewport. */
export interface ViewportDefinition {
  readonly height: number;
  readonly width: number;
}

/** A named product state and the trusted local scenario module that sets it up. */
export interface StateDefinition {
  readonly id: string;
  readonly setup: string;
}

/** A configured application route and its explicitly declared product states. */
export interface RouteDefinition {
  readonly id: string;
  readonly path: string;
  readonly states: readonly StateDefinition[];
}

/** Controls which diagnostics will fail an execution in the future runner. */
export interface FailurePolicy {
  readonly consoleError?: boolean | undefined;
  readonly failedRequest?: boolean | undefined;
  readonly pageError?: boolean | undefined;
}

/** One named selector whose matched pixels must be obscured before capture. */
export interface EvidenceMaskConfig {
  readonly count?: number | undefined;
  readonly id: string;
  readonly required?: boolean | undefined;
  readonly routeIds?: readonly string[] | undefined;
  readonly selector: string;
  readonly stateIds?: readonly string[] | undefined;
}

/** Screenshot masking and local byte-retention policy. */
export interface EvidenceConfig {
  readonly masks?: readonly EvidenceMaskConfig[] | undefined;
  readonly retention?: "all" | "failures-only" | "none" | undefined;
}

/** The complete user-authored UIWitness configuration contract. */
export interface UIWitnessConfig {
  readonly authentication?: AuthenticationConfig | undefined;
  readonly baseURL: string;
  readonly evidence?: EvidenceConfig | undefined;
  readonly failOn?: FailurePolicy | undefined;
  readonly routes: readonly RouteDefinition[];
  readonly themes: readonly string[];
  readonly viewports: Readonly<Record<string, ViewportDefinition>>;
}

const identifierPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const identifierMessage =
  "IDs must use lowercase letters or numbers separated by single hyphens.";

const identifierSchema = z.string().regex(identifierPattern, identifierMessage);

function isHttpUrl(value: string): boolean {
  try {
    return ["http:", "https:"].includes(new URL(value).protocol);
  } catch {
    return false;
  }
}

function isLocalRoutePath(value: string): boolean {
  const referenceBase = new URL("https://uiwitness.invalid");
  try {
    return (
      value.startsWith("/") &&
      new URL(value, referenceBase).origin === referenceBase.origin
    );
  } catch {
    return false;
  }
}

const viewportSchema = z.strictObject({
  height: z.number().int().positive(),
  width: z.number().int().positive(),
});

const stateSchema = z.strictObject({
  id: identifierSchema,
  setup: z.string().refine((value) => value.trim().length > 0, {
    message: "Scenario setup paths cannot be empty.",
  }),
});

function addDuplicateIdIssues(
  values: readonly { readonly id: string }[],
  context: z.RefinementCtx,
  label: "mask" | "route" | "state",
  pathPrefix: readonly PropertyKey[],
): void {
  const seen = new Set<string>();

  values.forEach((value, index) => {
    if (seen.has(value.id)) {
      context.addIssue({
        code: "custom",
        message: `Duplicate ${label} id "${value.id}".`,
        params: { uiwitnessIssueCode: "duplicate" },
        path: [...pathPrefix, index, "id"],
      });
    }
    seen.add(value.id);
  });
}

const routeSchema = z
  .strictObject({
    id: identifierSchema,
    path: z.string().refine(isLocalRoutePath, {
      message: "Route paths must be local and start with '/'.",
    }),
    states: z.array(stateSchema).min(1, "Routes must declare at least one state."),
  })
  .superRefine((route, context) => {
    addDuplicateIdIssues(route.states, context, "state", ["states"]);
  });

const failurePolicySchema = z.strictObject({
  consoleError: z.boolean().optional(),
  failedRequest: z.boolean().optional(),
  pageError: z.boolean().optional(),
});

const scopedIdentifiersSchema = z.array(identifierSchema)
  .min(1, "Mask scopes cannot be empty.")
  .superRefine((values, context) => {
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate mask scope id "${value}".`,
          params: { uiwitnessIssueCode: "duplicate" },
          path: [index],
        });
      }
      seen.add(value);
    });
  });

const evidenceMaskSchema = z.strictObject({
  count: z.number().int().positive().optional(),
  id: identifierSchema,
  required: z.boolean().default(true),
  routeIds: scopedIdentifiersSchema.optional(),
  selector: z.string().max(1_024).refine((value) => value.trim().length > 0, {
    message: "Mask selectors cannot be empty.",
  }),
  stateIds: scopedIdentifiersSchema.optional(),
});

const evidenceSchema = z.strictObject({
  masks: z.array(evidenceMaskSchema).default([]).superRefine((masks, context) => {
    addDuplicateIdIssues(masks, context, "mask", []);
  }),
  retention: z.enum(["all", "failures-only", "none"]).default("all"),
});

const originSchema = z.string().max(1_024).transform((value, context) => {
  const normalized = normalizedAuthenticationOrigin(value);
  if (normalized === null) {
    context.addIssue({
      code: "custom",
      message: "Origins must be exact credential-free HTTP(S) origins without a path, query, or fragment.",
    });
    return z.NEVER;
  }
  return normalized;
});

const cookieScopeSchema = z.strictObject({
  domain: z.string().max(253).refine(
    (value) =>
      validAuthenticationCookieDomain(value) &&
      !authenticationCookieDomainIsPublicSuffix(value),
    { message: "Cookie domains must be lowercase ASCII hosts and cannot be public suffixes." },
  ),
  partitionKeys: z.array(originSchema).min(1).optional().superRefine((values, context) => {
    if (values === undefined) return;
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate partition origin "${value}".`,
          params: { uiwitnessIssueCode: "duplicate" },
          path: [index],
        });
      }
      seen.add(value);
    });
  }),
  pathPrefix: z.string().max(1_024).refine((value) => value.startsWith("/"), {
    message: "Cookie path prefixes must start with '/'.",
  }),
  secure: z.enum(["required", "permitted"]),
});

const authenticationSchema = z.strictObject({
  additionalOrigins: z.array(originSchema).min(1).optional().superRefine((values, context) => {
    if (values === undefined) return;
    const seen = new Set<string>();
    values.forEach((value, index) => {
      if (seen.has(value)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate authentication origin "${value}".`,
          params: { uiwitnessIssueCode: "duplicate" },
          path: [index],
        });
      }
      seen.add(value);
    });
  }),
  cookieScopes: z.array(cookieScopeSchema).min(1).optional().superRefine((values, context) => {
    if (values === undefined) return;
    const seen = new Set<string>();
    values.forEach((value, index) => {
      const key = `${value.domain}\u0000${value.pathPrefix}`;
      if (seen.has(key)) {
        context.addIssue({
          code: "custom",
          message: `Duplicate cookie scope for "${value.domain}${value.pathPrefix}".`,
          params: { uiwitnessIssueCode: "duplicate" },
          path: [index],
        });
      }
      seen.add(key);
    });
  }),
  mode: z.literal("shared-readonly").default("shared-readonly"),
  setup: z.string().max(1_024).refine((value) => value.trim().length > 0, {
    message: "Authentication setup paths cannot be empty.",
  }),
});

const configSchema = z
  .strictObject({
    authentication: authenticationSchema.optional(),
    baseURL: z
      .string()
      .url()
      .refine(isHttpUrl, {
        message: "baseURL must use the http or https protocol.",
      }),
    evidence: evidenceSchema.optional(),
    failOn: failurePolicySchema.optional(),
    routes: z.array(routeSchema).min(1, "Config must declare at least one route."),
    themes: z
      .array(identifierSchema)
      .min(1, "Config must declare at least one theme.")
      .superRefine((themes, context) => {
        const seen = new Set<string>();
        themes.forEach((theme, index) => {
          if (seen.has(theme)) {
            context.addIssue({
              code: "custom",
              message: `Duplicate theme id "${theme}".`,
              params: { uiwitnessIssueCode: "duplicate" },
              path: [index],
            });
          }
          seen.add(theme);
        });
      }),
    viewports: z
      .record(identifierSchema, viewportSchema)
      .refine((viewports) => Object.keys(viewports).length > 0, {
        message: "Config must declare at least one viewport.",
      }),
  })
  .superRefine((config, context) => {
    addDuplicateIdIssues(config.routes, context, "route", ["routes"]);
    const routeIds = new Set(config.routes.map(({ id }) => id));
    const stateIds = new Set(
      config.routes.flatMap(({ states }) => states.map(({ id }) => id)),
    );
    config.evidence?.masks.forEach((mask, maskIndex) => {
      mask.routeIds?.forEach((id, index) => {
        if (!routeIds.has(id)) {
          context.addIssue({
            code: "custom",
            message: `Unknown mask route id "${id}".`,
            path: ["evidence", "masks", maskIndex, "routeIds", index],
          });
        }
      });
      mask.stateIds?.forEach((id, index) => {
        if (!stateIds.has(id)) {
          context.addIssue({
            code: "custom",
            message: `Unknown mask state id "${id}".`,
            path: ["evidence", "masks", maskIndex, "stateIds", index],
          });
        } else if (
          mask.routeIds !== undefined &&
          !config.routes.some((route) =>
            mask.routeIds?.includes(route.id) === true &&
            route.states.some((state) => state.id === id)
          )
        ) {
          context.addIssue({
            code: "custom",
            message: `Mask state id "${id}" does not exist in its scoped routes.`,
            path: ["evidence", "masks", maskIndex, "stateIds", index],
          });
        }
      });
    });
    if (config.authentication === undefined) return;
    const baseURL = new URL(config.baseURL);
    if (baseURL.username.length > 0 || baseURL.password.length > 0) {
      context.addIssue({
        code: "custom",
        message: "Authenticated baseURL values cannot contain credentials.",
        path: ["baseURL"],
      });
    }
    const applicationOrigin = normalizedAuthenticationOrigin(
      baseURL.origin,
    );
    if (applicationOrigin === null) return;
    const origins = [
      applicationOrigin,
      ...(config.authentication.additionalOrigins ?? []),
    ];
    config.authentication.additionalOrigins?.forEach((origin, index) => {
      if (origin === applicationOrigin) {
        context.addIssue({
          code: "custom",
          message: `Duplicate authentication origin "${origin}".`,
          params: { uiwitnessIssueCode: "duplicate" },
          path: ["authentication", "additionalOrigins", index],
        });
      }
    });
    const hosts = origins.map((origin) => new URL(origin).hostname);
    config.authentication.cookieScopes?.forEach((scope, index) => {
      const domain = scope.domain.startsWith(".")
        ? scope.domain.slice(1)
        : scope.domain;
      if (!hosts.some((host) => host === domain || host.endsWith(`.${domain}`))) {
        context.addIssue({
          code: "custom",
          message: "Cookie scopes must match the application or an additional origin.",
          path: ["authentication", "cookieScopes", index, "domain"],
        });
      }
    });
  });

/**
 * Provides contextual typing for a config module without changing its value.
 * Runtime validation remains explicit through {@link parseConfig}.
 */
export function defineConfig(config: UIWitnessConfig): UIWitnessConfig {
  return config;
}

function formatIssuePath(path: readonly PropertyKey[]): string {
  const propertyPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
  return path.reduce<string>((formatted, segment) => {
    if (typeof segment === "number") {
      return `${formatted}[${segment}]`;
    }
    if (typeof segment === "string" && propertyPattern.test(segment)) {
      return `${formatted}.${segment}`;
    }
    return `${formatted}[${JSON.stringify(String(segment))}]`;
  }, "$");
}

function issueCode(issue: ZodIssue): ConfigValidationIssueCode {
  if (
    issue.code === "custom" &&
    issue.params?.["uiwitnessIssueCode"] === "duplicate"
  ) {
    return "duplicate";
  }
  if (issue.code === "invalid_type") {
    return "invalid_type";
  }
  if (issue.code === "unrecognized_keys") {
    return "unrecognized_key";
  }
  return "invalid_value";
}

function toConfigIssue(issue: ZodIssue): ConfigValidationIssue {
  return Object.freeze({
    code: issueCode(issue),
    message: issue.message,
    path: formatIssuePath(issue.path),
  });
}

/** Parses an unknown value or throws a stable, validator-independent error. */
export function parseConfig(input: unknown): UIWitnessConfig {
  const result = configSchema.safeParse(input);
  if (!result.success) {
    throw new ConfigValidationError(result.error.issues.map(toConfigIssue));
  }
  return result.data;
}
