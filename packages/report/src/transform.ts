import {
  parseAnyReport,
  type AnyReportExecutionResult,
  type AnyUIWitnessReport,
  type ReportSummary,
} from "uiwitness-core";

/** One viewport/theme column in the offline report matrix. */
export interface ReportColumnView {
  readonly height: number;
  readonly id: string;
  readonly theme: string;
  readonly viewportId: string;
  readonly width: number;
}

/** One validated execution prepared for report rendering. */
export interface ReportCellView {
  readonly detailId: string;
  readonly execution: AnyReportExecutionResult;
  readonly screenshotHref: string | null;
  readonly screenshotStatus: "capture-failed" | "captured" | "omitted-by-policy";
}

/** One route/state row aligned to every report column. */
export interface ReportRowView {
  readonly cells: readonly (ReportCellView | null)[];
  readonly routeId: string;
  readonly routePath: string;
  readonly scenarioSource: string;
  readonly stateId: string;
}

/** Route grouping for the report matrix. */
export interface ReportRouteView {
  readonly id: string;
  readonly path: string;
  readonly rows: readonly ReportRowView[];
}

/** Deterministic, renderer-ready projection of either supported report schema. */
export interface ReportViewModel {
  readonly baseURL: string;
  readonly columns: readonly ReportColumnView[];
  readonly executions: readonly ReportCellView[];
  readonly generatedAt: string;
  readonly routes: readonly ReportRouteView[];
  readonly schemaVersion: AnyUIWitnessReport["schemaVersion"];
  readonly summary: ReportSummary;
}

interface RowBuilder {
  readonly cells: Map<string, ReportCellView>;
  readonly routeId: string;
  readonly routePath: string;
  readonly scenarioSource: string;
  readonly stateId: string;
}

interface RouteBuilder {
  readonly id: string;
  readonly path: string;
  readonly rows: RowBuilder[];
}

function freezeExecution(
  execution: AnyReportExecutionResult,
): AnyReportExecutionResult {
  return Object.freeze({
    ...execution,
    diagnostics: Object.freeze({
      ...execution.diagnostics,
      consoleErrors: Object.freeze([...execution.diagnostics.consoleErrors]),
      failedRequests: Object.freeze(
        execution.diagnostics.failedRequests.map((request) =>
          Object.freeze({ ...request }),
        ),
      ),
      pageErrors: Object.freeze([...execution.diagnostics.pageErrors]),
    }),
    failures: Object.freeze(
      execution.failures.map((failure) => Object.freeze({ ...failure })),
    ),
    viewport: Object.freeze({ ...execution.viewport }),
  });
}

function freezeSummary(summary: ReportSummary): ReportSummary {
  return Object.freeze({
    ...summary,
    coverage: Object.freeze({
      execution: Object.freeze({ ...summary.coverage.execution }),
      responsive: Object.freeze({ ...summary.coverage.responsive }),
      state: Object.freeze({ ...summary.coverage.state }),
      theme: Object.freeze({ ...summary.coverage.theme }),
    }),
  });
}

function coordinateKey(viewportId: string, theme: string): string {
  return JSON.stringify([viewportId, theme]);
}

function rowKey(routeId: string, stateId: string): string {
  return JSON.stringify([routeId, stateId]);
}

function screenshotStatus(
  execution: AnyReportExecutionResult,
): "capture-failed" | "captured" | "omitted-by-policy" {
  if ("screenshot" in execution) return execution.screenshot.status;
  return execution.screenshotPath === null ? "capture-failed" : "captured";
}

function screenshotHref(execution: AnyReportExecutionResult): string | null {
  const path = "screenshot" in execution
    ? execution.screenshot.status === "captured"
      ? execution.screenshot.path
      : null
    : execution.screenshotPath;
  if (path === null) {
    return null;
  }
  const prefix = [".uiwitness/", ".statecraft/"].find((candidate) =>
    path.startsWith(candidate),
  );
  if (prefix === undefined) {
    throw new TypeError(
      "Screenshot paths must stay inside .uiwitness/ or .statecraft/.",
    );
  }
  return `../${path.slice(prefix.length)}`;
}

/** Validates and transforms report data without reading filenames for metadata. */
export function transformReport(input: unknown): ReportViewModel {
  const report = parseAnyReport(input);
  const columns: ReportColumnView[] = [];
  const columnKeys = new Set<string>();
  const cells: ReportCellView[] = [];
  const routes: RouteBuilder[] = [];
  const routeById = new Map<string, RouteBuilder>();
  const rowById = new Map<string, RowBuilder>();

  report.executions.forEach((execution, index) => {
    const frozenExecution = freezeExecution(execution);
    const columnKey = coordinateKey(execution.viewportId, execution.theme);
    if (!columnKeys.has(columnKey)) {
      columnKeys.add(columnKey);
      columns.push(
        Object.freeze({
          height: execution.viewport.height,
          id: `column-${columns.length + 1}`,
          theme: execution.theme,
          viewportId: execution.viewportId,
          width: execution.viewport.width,
        }),
      );
    }

    const cell = Object.freeze({
      detailId: `execution-${index + 1}`,
      execution: frozenExecution,
      screenshotHref: screenshotHref(frozenExecution),
      screenshotStatus: screenshotStatus(frozenExecution),
    });
    cells.push(cell);

    let route = routeById.get(execution.routeId);
    if (route === undefined) {
      route = {
        id: execution.routeId,
        path: execution.routePath,
        rows: [],
      };
      routeById.set(execution.routeId, route);
      routes.push(route);
    }

    const executionRowKey = rowKey(execution.routeId, execution.stateId);
    let row = rowById.get(executionRowKey);
    if (row === undefined) {
      row = {
        cells: new Map<string, ReportCellView>(),
        routeId: execution.routeId,
        routePath: execution.routePath,
        scenarioSource: execution.scenarioSource,
        stateId: execution.stateId,
      };
      rowById.set(executionRowKey, row);
      route.rows.push(row);
    }
    row.cells.set(columnKey, cell);
  });

  const frozenColumns = Object.freeze(columns);
  const frozenRoutes = Object.freeze(
    routes.map((route) =>
      Object.freeze({
        id: route.id,
        path: route.path,
        rows: Object.freeze(
          route.rows.map((row) =>
            Object.freeze({
              cells: Object.freeze(
                frozenColumns.map((column) =>
                  row.cells.get(coordinateKey(column.viewportId, column.theme)) ??
                  null,
                ),
              ),
              routeId: row.routeId,
              routePath: row.routePath,
              scenarioSource: row.scenarioSource,
              stateId: row.stateId,
            }),
          ),
        ),
      }),
    ),
  );

  return Object.freeze({
    baseURL: report.project.baseURL,
    columns: frozenColumns,
    executions: Object.freeze(cells),
    generatedAt: report.generatedAt,
    routes: frozenRoutes,
    schemaVersion: report.schemaVersion,
    summary: freezeSummary(report.summary),
  });
}
