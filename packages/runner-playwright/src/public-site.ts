import { createHash } from "node:crypto";

import {
  expandMatrix,
  parseConfig,
  type MatrixCell,
} from "uiwitness-core";
import type { LaunchOptions } from "playwright";

import type { PublicRouteDiscovery } from "./discovery.js";
import { PUBLIC_SITE_CHECK_CONTRACT } from "./public-site-contract.js";
import {
  runPersistedScenarioCells,
  type PersistedScenarioRun,
  type RunPersistedScenarioCellsOptions,
} from "./persistence.js";
import {
  publicSiteScenario,
  publicSiteScenarioSource,
} from "./public-site-scenario.js";

const routeSlugLength = 48;
const routeDigestLength = 12;

/** Browser and persistence settings for one discovered public-site check. */
export interface RunPublicSiteChecksOptions {
  readonly generatedAt?: Date | undefined;
  readonly launchOptions?: LaunchOptions | undefined;
  readonly navigationTimeoutMs?: number | undefined;
  readonly projectDirectory?: string | undefined;
  readonly readinessTimeoutMs?: number | undefined;
}

function routeId(path: string): string {
  const readable =
    path === "/"
      ? "home"
      : path
          .toLowerCase()
          .replace(/%[0-9a-f]{2}/giu, "-")
          .replace(/[^a-z0-9]+/gu, "-")
          .replace(/^-+|-+$/gu, "")
          .slice(0, routeSlugLength)
          .replace(/-+$/gu, "") || "route";
  const digest = createHash("sha256")
    .update(path, "utf8")
    .digest("hex")
    .slice(0, routeDigestLength);
  return `${readable}-${digest}`;
}

function discoveryPaths(
  discovery: PublicRouteDiscovery,
): readonly string[] {
  if (
    typeof discovery !== "object" ||
    discovery === null ||
    !Array.isArray(discovery.routes)
  ) {
    throw new TypeError("discovery must be a public route discovery result.");
  }

  let baseURL: URL;
  try {
    baseURL = new URL(discovery.baseURL);
  } catch {
    throw new TypeError("discovery.baseURL must be a valid HTTP(S) URL.");
  }
  if (
    !["http:", "https:"].includes(baseURL.protocol) ||
    baseURL.username.length > 0 ||
    baseURL.password.length > 0
  ) {
    throw new TypeError("discovery.baseURL must be a credential-free HTTP(S) URL.");
  }

  const seen = new Set<string>();
  const paths = discovery.routes.map((route) => {
    if (typeof route !== "object" || route === null) {
      throw new TypeError("discovery routes must contain local path objects.");
    }
    const path = route.path;
    if (typeof path !== "string") {
      throw new TypeError("discovery route paths must be strings.");
    }
    let parsed: URL;
    try {
      parsed = new URL(path, baseURL.origin);
    } catch {
      throw new TypeError(`Discovery route path is invalid: ${path}.`);
    }
    if (
      !path.startsWith("/") ||
      parsed.origin !== baseURL.origin ||
      parsed.search.length > 0 ||
      parsed.hash.length > 0 ||
      parsed.pathname !== path
    ) {
      throw new TypeError(
        `Discovery route path must be a query-free local pathname: ${path}.`,
      );
    }
    if (seen.has(path)) {
      throw new TypeError(`Discovery route path is duplicated: ${path}.`);
    }
    seen.add(path);
    return path;
  });
  if (paths.length === 0) {
    throw new TypeError("discovery must contain at least one accepted route.");
  }
  return Object.freeze(paths);
}

/** @internal Builds the fixed mobile/desktop by light/dark Quick Check matrix. */
export function publicSiteMatrix(
  discovery: PublicRouteDiscovery,
): readonly MatrixCell[] {
  const paths = discoveryPaths(discovery);
  const config = parseConfig({
    baseURL: discovery.baseURL,
    routes: paths.map((path) => ({
      id: routeId(path),
      path,
      states: [{ id: "public", setup: publicSiteScenarioSource }],
    })),
    themes: PUBLIC_SITE_CHECK_CONTRACT.themes,
    viewports: PUBLIC_SITE_CHECK_CONTRACT.viewports,
  });
  return Object.freeze(expandMatrix(config));
}

/**
 * Runs every discovered route through the fixed public-site matrix and
 * transactionally publishes its screenshots and schema-v1 offline report.
 */
export async function runPublicSiteChecks(
  discovery: PublicRouteDiscovery,
  options: RunPublicSiteChecksOptions = {},
): Promise<PersistedScenarioRun> {
  const readiness =
    options.readinessTimeoutMs === undefined
      ? undefined
      : { timeoutMs: options.readinessTimeoutMs };
  const persistenceOptions: Omit<RunPersistedScenarioCellsOptions, "evidence"> = {
    baseURL: discovery.baseURL,
    failOn: PUBLIC_SITE_CHECK_CONTRACT.failOn,
    ...(options.generatedAt === undefined
      ? {}
      : { generatedAt: options.generatedAt }),
    ...(options.launchOptions === undefined
      ? {}
      : { launchOptions: options.launchOptions }),
    ...(options.navigationTimeoutMs === undefined
      ? {}
      : { navigationTimeoutMs: options.navigationTimeoutMs }),
    ...(options.projectDirectory === undefined
      ? {}
      : { projectDirectory: options.projectDirectory }),
    ...(readiness === undefined ? {} : { readiness }),
    scenario: publicSiteScenario,
  };
  return runPersistedScenarioCells(
    publicSiteMatrix(discovery),
    persistenceOptions,
  );
}
