import { realpath } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import {
  expandMatrix,
  type AnyUIWitnessReport,
  type GenerationArtifactRole,
  type Sha256Digest,
  type UIWitnessCommittedGeneration,
} from "uiwitness-core";

import { loadConfig } from "./config.js";
import type { LoadedConfig } from "./config.js";

interface ScanGenerationFinalization {
  readonly artifacts?: readonly {
    readonly contents: string | Uint8Array;
    readonly mutable?: boolean | undefined;
    readonly path: string;
    readonly publication: "exclusive" | "immutable" | "replace";
    readonly role: Exclude<GenerationArtifactRole, "evidence" | "evidence-manifest" | "report-html" | "report-json">;
  }[] | undefined;
  readonly runDigest?: Sha256Digest | undefined;
  readonly sourceGenerationDigests?: readonly Sha256Digest[] | undefined;
  readonly toolVersion: string;
}

type ScanGenerationFinalizer = (
  report: AnyUIWitnessReport,
) => ScanGenerationFinalization | Promise<ScanGenerationFinalization>;

/** Stable categories for expected scan-orchestration failures. */
export type ScanErrorCode =
  | "SCAN_AUTHENTICATION_FAILED"
  | "SCAN_AUTH_SETUP_PATH_INVALID"
  | "SCAN_COORDINATE_INVALID"
  | "SCAN_COORDINATE_NOT_FOUND"
  | "SCAN_ROUTE_NOT_FOUND"
  | "SCAN_SELECTION_CONFLICT";

/** An expected scan setup failure that callers can classify without parsing text. */
export class ScanError extends Error {
  readonly code: ScanErrorCode;
  readonly routeId: string;

  constructor(code: ScanErrorCode, message: string, routeId: string) {
    super(message);
    this.name = "ScanError";
    this.code = code;
    this.routeId = routeId;
  }
}

/** Inputs for one complete CLI-owned scan. */
export interface ScanOptions {
  /** Execute one exact route/state/viewport/theme coordinate. */
  readonly coordinate?: string | undefined;
  /** Explicit config file. Relative paths resolve from `cwd`. */
  readonly configPath?: string | undefined;
  /** Project directory that receives `.uiwitness/`. */
  readonly cwd?: string | undefined;
  /** Show the Playwright browser instead of using its headless default. */
  readonly headed?: boolean | undefined;
  /** Execute only the exact configured route id. */
  readonly routeId?: string | undefined;
}

/** Validated persisted output from one completed scan. */
export interface ScanResult {
  readonly configPath: string;
  readonly generation: UIWitnessCommittedGeneration;
  readonly htmlReportPath: ".uiwitness/report/index.html";
  readonly report: AnyUIWitnessReport;
  readonly reportPath: ".uiwitness/report/uiwitness.json";
}

interface ScanLoadedProjectOptions {
  readonly coordinate?: string | undefined;
  readonly headed?: boolean | undefined;
  readonly projectDirectory: string;
  readonly routeId?: string | undefined;
  readonly finalizeGeneration?: ScanGenerationFinalizer | undefined;
}

const coordinatePartPattern = /^[a-z0-9]+(?:-[a-z0-9]+)*$/u;
const authenticationErrorCodes = new Set([
  "AUTH_COOKIE_NOT_ALLOWED",
  "AUTH_ORIGIN_NOT_ALLOWED",
  "AUTH_SETUP_FAILED",
  "AUTH_SETUP_INVALID",
]);

function coordinateFilter(coordinate: string): {
  readonly routeId: string;
  readonly stateId: string;
  readonly theme: string;
  readonly viewportId: string;
} {
  const parts = coordinate.split("/");
  if (
    parts.length !== 4 ||
    parts.some((part) => !coordinatePartPattern.test(part))
  ) {
    throw new ScanError(
      "SCAN_COORDINATE_INVALID",
      "Coordinates must use route/state/viewport/theme with lowercase kebab-case IDs.",
      coordinate,
    );
  }
  return {
    routeId: parts[0]!,
    stateId: parts[1]!,
    viewportId: parts[2]!,
    theme: parts[3]!,
  };
}

/** @internal Executes one already-loaded config without importing it again. */
export async function scanLoadedProject(
  loaded: LoadedConfig,
  options: ScanLoadedProjectOptions,
): Promise<ScanResult> {
  if (options.coordinate !== undefined && options.routeId !== undefined) {
    throw new ScanError(
      "SCAN_SELECTION_CONFLICT",
      "The --coordinate and --route selections cannot be combined.",
      options.coordinate,
    );
  }
  if (
    options.routeId !== undefined &&
    !loaded.config.routes.some((route) => route.id === options.routeId)
  ) {
    throw new ScanError(
      "SCAN_ROUTE_NOT_FOUND",
      `Configured route not found: ${options.routeId}`,
      options.routeId,
    );
  }

  const exact = options.coordinate === undefined
    ? undefined
    : coordinateFilter(options.coordinate);
  const cells = expandMatrix(loaded.config, {
    routeIds: exact === undefined
      ? options.routeId === undefined ? undefined : [options.routeId]
      : [exact.routeId],
    stateIds: exact === undefined ? undefined : [exact.stateId],
    themes: exact === undefined ? undefined : [exact.theme],
    viewportIds: exact === undefined ? undefined : [exact.viewportId],
  });
  if (exact !== undefined && cells.length !== 1) {
    throw new ScanError(
      "SCAN_COORDINATE_NOT_FOUND",
      `Configured coordinate not found: ${options.coordinate}`,
      options.coordinate!,
    );
  }

  if (loaded.config.authentication !== undefined) {
    try {
      const { containedRegularFile } = await import("./guard-paths.js");
      const authenticationWorkspace = await realpath(options.projectDirectory);
      await containedRegularFile(
        authenticationWorkspace,
        resolve(dirname(loaded.path), loaded.config.authentication.setup),
        "GUARD_AUTH_SETUP_PATH_INVALID",
        "Authentication setup path",
      );
    } catch (error: unknown) {
      throw new ScanError(
        "SCAN_AUTH_SETUP_PATH_INVALID",
        error instanceof Error
          ? error.message
          : "Authentication setup path is invalid.",
        loaded.config.authentication.setup,
      );
    }
  }

  const { runPersistedScenarioCells } = await import(
    "uiwitness-runner-playwright"
  );
  let run;
  try {
    run = await runPersistedScenarioCells(cells, {
      ...(loaded.config.authentication === undefined
        ? {}
        : {
            authentication: {
              baseURL: loaded.config.baseURL,
              config: loaded.config.authentication,
              setupBaseDirectory: dirname(loaded.path),
            },
          }),
      baseURL: loaded.config.baseURL,
      ...(loaded.config.evidence === undefined
        ? {}
        : { evidence: loaded.config.evidence }),
      ...(loaded.config.failOn === undefined
        ? {}
        : { failOn: loaded.config.failOn }),
      ...(options.headed === true
        ? { launchOptions: { headless: false } }
        : {}),
      projectDirectory: options.projectDirectory,
      scenarioBaseDirectory: dirname(loaded.path),
      ...(options.finalizeGeneration === undefined
        ? {}
        : { finalizeGeneration: options.finalizeGeneration }),
    });
  } catch (error: unknown) {
    const code = (error as Error & { readonly code?: unknown }).code;
    const setupPath = (error as Error & { readonly setupPath?: unknown }).setupPath;
    if (
      error instanceof Error &&
      error.name === "AuthenticationError" &&
      typeof code === "string" &&
      authenticationErrorCodes.has(code) &&
      typeof setupPath === "string"
    ) {
      throw new ScanError(
        "SCAN_AUTHENTICATION_FAILED",
        `${code}: Authentication setup could not seed the run (${setupPath}).`,
        setupPath,
      );
    }
    throw error;
  }
  return Object.freeze({
    configPath: loaded.path,
    generation: run.generation,
    htmlReportPath: run.htmlReportPath,
    report: run.report,
    reportPath: run.reportPath,
  });
}

/**
 * Loads one trusted config, expands its selected matrix, executes every cell,
 * and persists deterministic screenshots plus schema-v1 JSON and offline HTML.
 */
export async function scanProject(
  options: ScanOptions = {},
): Promise<ScanResult> {
  const projectDirectory = resolve(options.cwd ?? process.cwd());
  const loaded = await loadConfig({
    configPath: options.configPath,
    cwd: projectDirectory,
  });
  return scanLoadedProject(loaded, {
    coordinate: options.coordinate,
    headed: options.headed,
    projectDirectory,
    routeId: options.routeId,
  });
}
