import { createHash } from "node:crypto";

import {
  parseEvidenceManifest,
  parseAnyReport,
  serializeEvidenceManifest,
  serializeReport,
  type AnyReportExecutionResult,
  type UIWitnessEvidenceManifest,
} from "uiwitness-core";

import {
  transformReport,
  type ReportCellView,
  type ReportColumnView,
  type ReportViewModel,
} from "./transform.js";
import {
  transformContractVerdict,
  type ContractFindingView,
  type ContractVerdictView,
  type RenderReportOptions,
} from "./contract-verdict.js";

const runErrorReasonLabels = Object.freeze({
  "declared-incomplete": "The runner declared the execution set incomplete.",
  "duplicate-execution-coordinate": "This coordinate was executed more than once.",
  "missing-execution": "This promised coordinate was not executed.",
  "unexpected-execution": "A coordinate outside the current configuration was executed.",
} as const);

function escapeHtml(value: string | number): string {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function words(value: string): string {
  return value
    .split("-")
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function duration(value: number): string {
  if (value < 1_000) {
    return `${value} ms`;
  }
  return `${(value / 1_000).toFixed(value < 10_000 ? 1 : 0)} s`;
}

function columnLabel(column: ReportColumnView): string {
  return `${words(column.viewportId)} · ${words(column.theme)}`;
}

function unique(values: readonly string[]): readonly string[] {
  return [...new Set(values)];
}

function selectOptions(
  allLabel: string,
  values: readonly string[],
): string {
  return `<option value="">${escapeHtml(allLabel)}</option>${values
    .map(
      (value) =>
        `<option value="${escapeHtml(value)}">${escapeHtml(words(value))}</option>`,
    )
    .join("")}`;
}

function diagnosticList(values: readonly string[], empty: string): string {
  if (values.length === 0) {
    return `<p class="empty-detail">${escapeHtml(empty)}</p>`;
  }
  return `<ul>${values.map((value) => `<li>${escapeHtml(value)}</li>`).join("")}</ul>`;
}

function requestList(execution: AnyReportExecutionResult): string {
  if (execution.diagnostics.failedRequests.length === 0) {
    return '<p class="empty-detail">No failed requests captured.</p>';
  }
  return `<ul>${execution.diagnostics.failedRequests
    .map(
      (request) =>
        `<li><strong>${escapeHtml(request.method)}</strong> ${escapeHtml(request.url)}<br><span>${escapeHtml(request.errorText)}</span></li>`,
    )
    .join("")}</ul>`;
}

function failures(execution: AnyReportExecutionResult): string {
  if (execution.failures.length === 0) {
    return '<p class="empty-detail">No execution failures.</p>';
  }
  return `<ul>${execution.failures
    .map(
      (failure) =>
        `<li><strong>${escapeHtml(failure.code)}</strong><br>${escapeHtml(failure.message)}</li>`,
    )
    .join("")}</ul>`;
}

function findingDomId(finding: ContractFindingView): string {
  return `finding-${createHash("sha256")
    .update(`${finding.kind}\u0000${finding.coordinateId ?? "run"}`)
    .digest("hex")
    .slice(0, 16)}`;
}

function quantity(value: number, singular: string, plural = `${singular}s`): string {
  return `${value} ${value === 1 ? singular : plural}`;
}

function privacyPanel(manifest: UIWitnessEvidenceManifest): string {
  const validated = parseEvidenceManifest(serializeEvidenceManifest(manifest));
  const masks = validated.masks.length === 0
    ? '<p class="empty-detail">No masks applied.</p>'
    : `<ul>${validated.masks.map((mask) =>
        `<li><code>${escapeHtml(mask.id)}</code> · ${escapeHtml(mask.cardinalities.join(", "))}</li>`
      ).join("")}</ul>`;
  return `<section class="privacy-panel" aria-labelledby="privacy-title">
    <div><p class="eyebrow">Evidence privacy</p><h2 id="privacy-title">${escapeHtml(words(validated.retention))} retention</h2></div>
    <dl>
      <div><dt>Attempted</dt><dd>${validated.attempted}</dd></div>
      <div><dt>Retained</dt><dd>${validated.captured}</dd></div>
      <div><dt>Omitted</dt><dd>${validated.omitted}</dd></div>
    </dl>
    <div><h3>Successful masks</h3>${masks}</div>
  </section>`;
}

function boundEvidenceManifest(
  input: unknown,
  manifest: UIWitnessEvidenceManifest,
): UIWitnessEvidenceManifest {
  const report = parseAnyReport(input);
  const validated = parseEvidenceManifest(serializeEvidenceManifest(manifest));
  const reportDigest = `sha256:${createHash("sha256")
    .update(serializeReport(report))
    .digest("hex")}`;
  const retention = report.schemaVersion === 1
    ? "all"
    : report.evidence?.retention ?? "all";
  const captured = report.schemaVersion === 1
    ? report.executions.filter(({ screenshotPath }) => screenshotPath !== null).length
    : report.executions.filter(({ screenshot }) => screenshot.status === "captured").length;
  const omitted = report.executions.length - captured;
  if (
    validated.reportDigest !== reportDigest ||
    validated.retention !== retention ||
    validated.captured !== captured ||
    validated.omitted !== omitted
  ) {
    throw new TypeError("Evidence manifest does not match the report being rendered.");
  }
  return validated;
}

function contractSummary(view: ContractVerdictView): string {
  const counts = new Map<string, number>();
  for (const finding of view.findings) {
    counts.set(finding.kind, (counts.get(finding.kind) ?? 0) + 1);
  }
  const fragments = [
    `${quantity(view.promised, "promise")}`,
    `${quantity(view.matched, "matched coordinate")}`,
  ];
  const groups = [
    ["regression", "regression"],
    ["changed-known-failure", "changed known failure", "changed known failures"],
    ["unaccepted-addition", "addition"],
    ["missing-coordinate", "missing coordinate"],
    ["unaccepted-config-drift", "config drift", "config drifts"],
    ["expired-exception", "expired exception"],
    ["recovered-known-failure", "recovered failure"],
    ["matched-known-failure", "known failure"],
  ] as const;
  for (const [kind, singular, plural] of groups) {
    const count = counts.get(kind) ?? 0;
    if (count > 0) fragments.push(quantity(count, singular, plural));
  }
  return fragments.join(" · ");
}

function contractHero(view: ContractVerdictView): string {
  const title = view.verdict === "passed"
    ? "Promise<br>kept."
    : view.verdict === "failed" ? "Contract<br>broken." : "Run<br>incomplete.";
  const label = view.verdict === "passed"
    ? "The complete promised matrix held."
    : view.verdict === "failed"
      ? "The promise changed or a state regressed. Review every finding."
      : "The run could not prove the complete promise.";
  return `<div class="hero-verdict contract-hero">
        <div><p class="eyebrow">Contract verdict / ${escapeHtml(view.evaluatedOn)}</p><h1>${title}</h1></div>
        <div class="score contract-score" aria-label="${escapeHtml(label)}">
          <strong>${view.matched}<span>/${view.promised}</span></strong>
          <p>${escapeHtml(label)}</p>
        </div>
      </div>
      <p class="lede contract-lede">${escapeHtml(contractSummary(view))}</p>`;
}

function commandRow(
  label: string,
  value: string,
  id: string,
): string {
  return `<div class="finding-command">
      <span>${escapeHtml(label)}</span>
      <code id="${escapeHtml(id)}">${escapeHtml(value)}</code>
      <button type="button" data-copy-target="${escapeHtml(id)}">Copy</button>
    </div>`;
}

function contractFinding(finding: ContractFindingView): string {
  const id = findingDomId(finding);
  const coordinate = finding.coordinateId ?? "complete run";
  const exceptionMarkup = finding.exception === null
    ? ""
    : `<dl class="exception-meta">
        <div><dt>Owner</dt><dd>${escapeHtml(finding.exception.owner)}</dd></div>
        <div><dt>Reason</dt><dd>${escapeHtml(finding.exception.reason)}</dd></div>
        <div><dt>Window</dt><dd>${escapeHtml(finding.exception.createdOn)} → ${escapeHtml(finding.exception.expiresOn)}<span class="exception-lifecycle" data-exception-status="${finding.exception.status}">${escapeHtml(exceptionLifecycleLabel(finding.exception.daysUntilExpiry))}</span></dd></div>
      </dl>`;
  const guidanceMarkup = finding.guidance === null
    ? ""
    : `<p class="exception-guidance"><strong>Governance:</strong> ${escapeHtml(finding.guidance)}</p>`;
  const commands = [
    finding.reproduce === null
      ? ""
      : commandRow("Reproduce", finding.reproduce, `${id}-reproduce`),
    finding.remediate === null
      ? ""
      : commandRow("Review change", finding.remediate, `${id}-remediate`),
  ].join("");
  const runErrorMarkup = finding.runErrorReasons.length === 0
    ? ""
    : `<dl class="finding-outcome run-error-reasons" id="${id}-reasons">
        ${finding.runErrorReasons.map((reason, index) =>
          `<div><dt>Run reason ${index + 1}</dt><dd><code>${escapeHtml(reason)}</code><br>${escapeHtml(runErrorReasonLabels[reason])}</dd></div>`
        ).join("")}
      </dl>`;
  return `<li class="finding finding--${finding.tone}" id="${id}" data-contract-finding="${escapeHtml(finding.kind)}" data-contract-coordinate="${escapeHtml(coordinate)}">
    <article aria-labelledby="${id}-title" aria-describedby="${id}-outcome${finding.runErrorReasons.length === 0 ? "" : ` ${id}-reasons`}">
      <div class="finding-heading">
        <div><p class="eyebrow">${escapeHtml(finding.label)}</p><h3 id="${id}-title"><a href="#${id}">${escapeHtml(coordinate)}</a></h3></div>
        <span class="finding-kind">${escapeHtml(finding.label)}</span>
      </div>
      <dl class="finding-outcome" id="${id}-outcome">
        <div><dt>Expected</dt><dd>${escapeHtml(finding.expected)}</dd></div>
        <div><dt>Actual</dt><dd>${escapeHtml(finding.actual)}</dd></div>
      </dl>
      ${runErrorMarkup}
      ${exceptionMarkup}
      ${guidanceMarkup}
      ${commands === "" ? "" : `<div class="finding-commands">${commands}</div>`}
    </article>
  </li>`;
}

function exceptionLifecycleLabel(daysUntilExpiry: number): string {
  if (daysUntilExpiry < 0) {
    return `Expired ${quantity(Math.abs(daysUntilExpiry), "UTC day")} ago`;
  }
  if (daysUntilExpiry === 0) {
    return "Expires today · active through 23:59:59.999 UTC";
  }
  return `Expires in ${quantity(daysUntilExpiry, "UTC day")}`;
}

function contractFindingFilters(findings: readonly ContractFindingView[]): string {
  const kinds = new Map<string, string>();
  for (const finding of findings) {
    kinds.set(finding.kind, finding.label);
  }
  const kindOptions = [...kinds]
    .map(([kind, label]) =>
      `<option value="${escapeHtml(kind)}">${escapeHtml(label)}</option>`
    )
    .join("");
  return `<div class="finding-filter-rail">
    <form id="finding-filters" role="search" aria-label="Filter contract findings">
      <label class="filter-control"><span>Coordinate</span><input type="search" name="finding-query" maxlength="256" autocomplete="off" spellcheck="false" placeholder="Search coordinates"></label>
      <label class="filter-control"><span>Finding type</span><select name="finding-kind"><option value="">All finding types</option>${kindOptions}</select></label>
      <button class="reset-filters" type="reset" disabled>Reset finding filters</button>
    </form>
    <p id="finding-filter-results" aria-live="polite" aria-atomic="true">Showing ${quantity(findings.length, "finding")}.</p>
    <div class="finding-no-results" id="finding-no-results" hidden><strong>No findings match these filters.</strong><span>Clear the coordinate search or finding type to restore the canonical ledger.</span></div>
  </div>`;
}

function contractFindings(view: ContractVerdictView): string {
  const visible = view.findings.filter(({ kind }) => kind !== "matched");
  const body = visible.length === 0
    ? `<div class="contract-clear"><strong>No contract findings.</strong><span>Every promised coordinate matched this complete run.</span></div>`
    : `<ol class="findings-list">${visible.map(contractFinding).join("")}</ol>`;
  return `<section class="contract-findings" id="contract-findings" aria-labelledby="contract-findings-title">
    <div class="section-heading contract-findings-heading">
      <div><p class="eyebrow">Promise ledger / 01</p><h2 id="contract-findings-title">Findings</h2></div>
      <p>${visible.length === 0 ? "The committed promise and fresh evidence agree." : `${quantity(visible.length, "finding")} in canonical order. Full local output is never truncated.`}</p>
    </div>
    ${visible.length === 0 ? "" : contractFindingFilters(visible)}
    ${body}
    <details class="contract-details">
      <summary>Contract / run / generation details</summary>
      <dl>
        <div><dt>Contract</dt><dd><code>${escapeHtml(view.contractDigest)}</code></dd></div>
        <div><dt>Configuration</dt><dd><code>${escapeHtml(view.configDigest)}</code></dd></div>
        <div><dt>Run</dt><dd><code>${escapeHtml(view.runDigest)}</code></dd></div>
        <div><dt>Evaluated</dt><dd>${escapeHtml(view.evaluatedOn)} UTC</dd></div>
        <div><dt>Complete</dt><dd>${view.complete ? "Yes" : "No"}</dd></div>
      </dl>
    </details>
  </section>`;
}

function screenshot(cell: ReportCellView, className: string): string {
  if (cell.screenshotHref === null) {
    return `<div class="screenshot-missing">${cell.screenshotStatus === "omitted-by-policy" ? "Screenshot omitted by retention policy" : "Screenshot capture failed"}</div>`;
  }
  const execution = cell.execution;
  const alt = `${words(execution.routeId)} ${words(execution.stateId)}, ${words(execution.viewportId)}, ${words(execution.theme)} theme`;
  return `<img class="${className}" src="${escapeHtml(cell.screenshotHref)}" alt="${escapeHtml(alt)}" width="${execution.viewport.width}" height="${execution.viewport.height}" loading="lazy">`;
}

function matrixCell(
  cell: ReportCellView | null,
  column: ReportColumnView,
  routeId: string,
  stateId: string,
): string {
  if (cell === null) {
    return `<div class="matrix-cell matrix-cell--missing" data-cell data-signal-fracture="missing" aria-label="${escapeHtml(`${routeId} ${stateId}, ${column.viewportId}, ${column.theme}: not captured`)}">Not captured</div>`;
  }
  const status = cell.execution.status;
  return `<a class="matrix-cell matrix-cell--${status}" data-cell${status === "failed" ? ' data-signal-fracture="failed"' : ""} data-detail-target="${escapeHtml(cell.detailId)}" href="#${escapeHtml(cell.detailId)}" aria-controls="${escapeHtml(cell.detailId)}" aria-label="${escapeHtml(`${routeId} ${stateId}, ${column.viewportId}, ${column.theme}: ${status}`)}">
    <span class="cell-status"><span class="status-dot" aria-hidden="true"></span>${escapeHtml(status)}</span>
    ${screenshot(cell, "thumbnail")}
  </a>`;
}

function filters(view: ReportViewModel): string {
  if (view.executions.length === 0) {
    return "";
  }
  const executions = view.executions.map((cell) => cell.execution);
  return `<section class="filter-rail filters" aria-labelledby="filters-title">
    <div class="filters-heading">
      <div><p class="eyebrow">Focus the evidence</p><h2 id="filters-title">Filter executions</h2></div>
      <p id="filter-results" aria-live="polite">Showing ${executions.length} of ${executions.length} executions.</p>
    </div>
    <form id="report-filters">
      <label class="filter-control"><span>Route</span><select name="route">${selectOptions("All routes", unique(executions.map((execution) => execution.routeId)))}</select></label>
      <label class="filter-control"><span>State</span><select name="state">${selectOptions("All states", unique(executions.map((execution) => execution.stateId)))}</select></label>
      <label class="filter-control"><span>Viewport</span><select name="viewport">${selectOptions("All viewports", unique(executions.map((execution) => execution.viewportId)))}</select></label>
      <label class="filter-control"><span>Theme</span><select name="theme">${selectOptions("All themes", unique(executions.map((execution) => execution.theme)))}</select></label>
      <label class="filter-control"><span>Status</span><select name="status"><option value="">All statuses</option><option value="passed">Passed</option><option value="failed">Failed</option></select></label>
      <button class="reset-filters" type="reset" disabled>Reset filters</button>
    </form>
  </section>`;
}

function matrix(view: ReportViewModel): string {
  if (view.routes.length === 0) {
    return '<section class="panel empty-report" aria-labelledby="matrix-title"><h2 id="matrix-title">Coverage matrix</h2><p>No executions were selected for this report.</p></section>';
  }
  const heading = view.columns
    .map(
      (column) =>
        `<th scope="col" data-column data-viewport="${escapeHtml(column.viewportId)}" data-theme="${escapeHtml(column.theme)}"><span>${escapeHtml(columnLabel(column))}</span><small>${column.width} × ${column.height}</small></th>`,
    )
    .join("");
  const bodies = view.routes
    .map(
      (route) => `<tbody data-route-group="${escapeHtml(route.id)}">${route.rows
        .map(
        (row, rowIndex) => `<tr data-matrix-row data-route="${escapeHtml(row.routeId)}" data-state="${escapeHtml(row.stateId)}">
          <th class="route-heading" scope="rowgroup"${rowIndex === 0 ? ` rowspan="${route.rows.length}"` : " hidden"}><span>${escapeHtml(words(route.id))}</span><small>${escapeHtml(route.path)}</small></th>
          <th class="state-heading" scope="row" data-mobile-route="${escapeHtml(`${words(route.id)} · ${route.path}`)}"><span>${escapeHtml(words(row.stateId))}</span><small>${escapeHtml(row.scenarioSource)}</small></th>
          ${row.cells.map((cell, index) => {
            const column = view.columns[index]!;
            return `<td data-matrix-slot data-column-label="${escapeHtml(columnLabel(column))}" data-viewport="${escapeHtml(column.viewportId)}" data-theme="${escapeHtml(column.theme)}" data-status="${cell?.execution.status ?? "missing"}">${matrixCell(cell, column, row.routeId, row.stateId)}<span class="filtered-cell" hidden aria-hidden="true">—</span></td>`;
          }).join("")}
        </tr>`,
        )
        .join("")}</tbody>`,
    )
    .join("");
  return `<section class="matrix-panel" aria-labelledby="matrix-title">
    <div class="section-heading"><div><p class="eyebrow">Evidence field / 01</p><h2 id="matrix-title">Coverage matrix</h2></div><p>Every configured state. Select a frame to enter the inspection room.</p></div>
    <div class="matrix-scroll" tabindex="0" aria-label="Scrollable coverage matrix">
      <table><caption class="sr-only">Execution status and screenshot evidence by route, state, viewport, and theme.</caption><thead><tr><th scope="col">Route</th><th scope="col">State</th>${heading}</tr></thead>${bodies}</table>
    </div>
    <div class="no-results" id="no-results" hidden><strong>No executions match these filters.</strong><span>Reset one or more filters to restore the matrix.</span></div>
  </section>`;
}

function detail(cell: ReportCellView): string {
  const execution = cell.execution;
  const navigationStatus = execution.diagnostics.navigationStatus;
  const detailTitleId = `${cell.detailId}-title`;
  return `<article class="detail" id="${escapeHtml(cell.detailId)}" data-detail data-route="${escapeHtml(execution.routeId)}" data-state="${escapeHtml(execution.stateId)}" data-viewport="${escapeHtml(execution.viewportId)}" data-theme="${escapeHtml(execution.theme)}" data-status="${execution.status}" tabindex="-1" aria-labelledby="${escapeHtml(detailTitleId)}">
    <div class="detail-utility"><span>Inspection room / ${escapeHtml(cell.detailId)}</span><a class="detail-close" data-close-detail href="#matrix-title">Close <span aria-hidden="true">×</span></a></div>
    <div class="detail-heading">
      <div><p class="eyebrow">${escapeHtml(words(execution.routeId))} / ${escapeHtml(words(execution.stateId))}</p><h2 id="${escapeHtml(detailTitleId)}">${escapeHtml(words(execution.viewportId))} · ${escapeHtml(words(execution.theme))}</h2></div>
      <span class="status-badge status-badge--${execution.status}">${escapeHtml(execution.status)}</span>
    </div>
    <div class="detail-layout">
      <div class="evidence">${screenshot(cell, "full-screenshot")}</div>
      <div class="metadata">
        <dl>
          <div><dt>Route</dt><dd><code>${escapeHtml(execution.routePath)}</code></dd></div>
          <div><dt>URL</dt><dd><code>${escapeHtml(execution.url)}</code></dd></div>
          <div><dt>Viewport</dt><dd>${escapeHtml(execution.viewportId)} · ${execution.viewport.width} × ${execution.viewport.height}</dd></div>
          <div><dt>Theme</dt><dd>${escapeHtml(execution.theme)}</dd></div>
          <div><dt>Duration</dt><dd>${escapeHtml(duration(execution.durationMs))}</dd></div>
          <div><dt>Navigation</dt><dd>${navigationStatus === null ? "Not available" : navigationStatus}</dd></div>
          <div><dt>Scenario</dt><dd><code>${escapeHtml(execution.scenarioSource)}</code></dd></div>
        </dl>
      </div>
    </div>
    <div class="diagnostics">
      <details${execution.failures.length > 0 ? " open" : ""}><summary><span>Failures</span><strong>${execution.failures.length}</strong></summary><div class="diagnostic-body">${failures(execution)}</div></details>
      <details><summary><span>Console errors</span><strong>${execution.diagnostics.consoleErrors.length}</strong></summary><div class="diagnostic-body">${diagnosticList(execution.diagnostics.consoleErrors, "No console errors captured.")}</div></details>
      <details><summary><span>Page errors</span><strong>${execution.diagnostics.pageErrors.length}</strong></summary><div class="diagnostic-body">${diagnosticList(execution.diagnostics.pageErrors, "No page errors captured.")}</div></details>
      <details><summary><span>Failed requests</span><strong>${execution.diagnostics.failedRequests.length}</strong></summary><div class="diagnostic-body">${requestList(execution)}</div></details>
    </div>
    <a class="back-link" data-close-detail href="#matrix-title">Close details and return to matrix</a>
  </article>`;
}

const interactions = `
(() => {
  const form = document.querySelector("#report-filters");
  document.documentElement.classList.add("js");

  const copyStatus = document.querySelector("#copy-status");
  document.querySelectorAll("[data-copy-target]").forEach((button) => {
    button.addEventListener("click", async () => {
      if (!(button instanceof HTMLButtonElement)) return;
      const target = document.getElementById(button.dataset.copyTarget ?? "");
      if (!(target instanceof HTMLElement)) return;
      const value = target.textContent ?? "";
      let copied = false;
      try {
        if (!navigator.clipboard) throw new Error("Clipboard unavailable");
        await navigator.clipboard.writeText(value);
        copied = true;
      } catch {
        const fallback = document.createElement("textarea");
        fallback.value = value;
        fallback.setAttribute("readonly", "");
        fallback.style.position = "fixed";
        fallback.style.opacity = "0";
        document.body.append(fallback);
        try {
          fallback.select();
          copied = document.execCommand("copy");
        } catch {
          copied = false;
        } finally {
          fallback.remove();
        }
      }
      if (!copied) {
        if (copyStatus) {
          copyStatus.textContent = "Copy failed. Select and copy the command manually.";
        }
        return;
      }
      button.textContent = "Copied";
      button.classList.add("is-copied");
      if (copyStatus) copyStatus.textContent = "Command copied.";
      window.setTimeout(() => {
        button.textContent = "Copy";
        button.classList.remove("is-copied");
        if (copyStatus) copyStatus.textContent = "";
      }, 120);
    });
  });

  function writeSelectedUrl(names, selected) {
    const next = new URL(window.location.href);
    names.forEach((name) => next.searchParams.delete(name));
    Object.entries(selected).forEach(([key, value]) => {
      if (value !== "") next.searchParams.set(key, value);
    });
    history.replaceState(null, "", next.href);
  }

  const findingForm = document.querySelector("#finding-filters");
  const findingKind = findingForm?.querySelector('select[name="finding-kind"]');
  const findingQuery = findingForm?.querySelector('input[name="finding-query"]');
  const findingItems = Array.from(document.querySelectorAll("[data-contract-finding]"))
    .filter((item) => item instanceof HTMLElement)
    .map((item) => ({
      element: item,
      search: (item.dataset.contractCoordinate ?? "").toLowerCase(),
    }));
  const findingResult = document.querySelector("#finding-filter-results");
  const findingNoResults = document.querySelector("#finding-no-results");
  const findingReset = findingForm?.querySelector("[type=reset]");
  let findingFilterFrame = 0;

  const findingValues = () => ({
    "finding-kind": findingKind instanceof HTMLSelectElement ? findingKind.value : "",
    "finding-query": findingQuery instanceof HTMLInputElement ? findingQuery.value.trim() : "",
  });

  function applyFindingFilters(updateUrl = true) {
    if (!(findingForm instanceof HTMLFormElement)) return;
    const selected = findingValues();
    const query = selected["finding-query"].toLowerCase();
    const anchoredId = window.location.hash.slice(1);
    let visible = 0;
    findingItems.forEach(({ element, search }) => {
      const isMatch = ((selected["finding-kind"] === "" ||
          element.dataset.contractFinding === selected["finding-kind"]) &&
        (query === "" || search.includes(query))) || element.id === anchoredId;
      element.hidden = !isMatch;
      if (isMatch) visible += 1;
    });
    if (findingResult) {
      findingResult.textContent = "Showing " + visible + " of " + findingItems.length +
        (findingItems.length === 1 ? " finding." : " findings.");
    }
    if (findingNoResults instanceof HTMLElement) findingNoResults.hidden = visible !== 0;
    if (findingReset instanceof HTMLButtonElement) {
      findingReset.disabled = selected["finding-kind"] === "" && selected["finding-query"] === "";
    }
    if (updateUrl) {
      writeSelectedUrl(["finding-kind", "finding-query"], selected);
    }
  }

  function restoreFindingFiltersFromUrl() {
    if (!(findingForm instanceof HTMLFormElement)) return;
    const params = new URLSearchParams(window.location.search);
    if (findingKind instanceof HTMLSelectElement) {
      const kind = params.get("finding-kind");
      findingKind.value = kind !== null &&
          Array.from(findingKind.options).some((option) => option.value === kind)
        ? kind
        : "";
    }
    if (findingQuery instanceof HTMLInputElement) {
      const query = params.get("finding-query");
      findingQuery.value = query !== null && query.length <= findingQuery.maxLength ? query : "";
    }
  }

  function syncFindingFromHash() {
    if (!(findingForm instanceof HTMLFormElement)) return;
    const target = document.getElementById(window.location.hash.slice(1));
    if (!(target instanceof HTMLElement) ||
        target.dataset.contractFinding === undefined) return;
    applyFindingFilters(false);
  }

  if (findingForm instanceof HTMLFormElement) {
    findingForm.addEventListener("submit", (event) => event.preventDefault());
    findingForm.addEventListener("change", () => applyFindingFilters());
    findingForm.addEventListener("input", () => {
      window.cancelAnimationFrame(findingFilterFrame);
      findingFilterFrame = window.requestAnimationFrame(() => applyFindingFilters());
    });
    findingForm.addEventListener("reset", () =>
      window.requestAnimationFrame(() => applyFindingFilters())
    );
    window.addEventListener("hashchange", () =>
      window.requestAnimationFrame(syncFindingFromHash)
    );
    window.addEventListener("popstate", () => {
      restoreFindingFiltersFromUrl();
      applyFindingFilters(false);
      syncFindingFromHash();
    });
    restoreFindingFiltersFromUrl();
    applyFindingFilters(false);
    syncFindingFromHash();
  }

  if (!(form instanceof HTMLFormElement)) return;

  const selects = Array.from(form.querySelectorAll("select"));
  const rows = Array.from(document.querySelectorAll("[data-matrix-row]"));
  const columns = Array.from(document.querySelectorAll("[data-column]"));
  const details = Array.from(document.querySelectorAll("[data-detail]"));
  const triggers = Array.from(document.querySelectorAll("[data-detail-target]"));
  const triggerById = new Map(triggers.map((trigger) => [trigger.dataset.detailTarget, trigger]));
  const result = document.querySelector("#filter-results");
  const noResults = document.querySelector("#no-results");
  const reset = form.querySelector("[type=reset]");
  const matrixScroll = document.querySelector(".matrix-scroll");
  const focusableSelector = "a[href],button:not([disabled]),summary,[tabindex]:not([tabindex='-1'])";
  let activeDetail = null;
  let activeTrigger = null;
  let lastTrigger = null;

  const values = () => Object.fromEntries(selects.map((select) => [select.name, select.value]));
  const matches = (actual, selected) => selected === "" || actual === selected;
  const detailMatches = (detail, filters) =>
    matches(detail.dataset.route, filters.route) &&
    matches(detail.dataset.state, filters.state) &&
    matches(detail.dataset.viewport, filters.viewport) &&
    matches(detail.dataset.theme, filters.theme) &&
    matches(detail.dataset.status, filters.status);

  function updateRouteHeading(group) {
    const visibleRows = Array.from(group.querySelectorAll("[data-matrix-row]")).filter((row) => !row.hidden);
    const headings = Array.from(group.querySelectorAll(".route-heading"));
    headings.forEach((heading) => {
      heading.hidden = true;
      heading.removeAttribute("rowspan");
    });
    if (visibleRows.length > 0) {
      const heading = visibleRows[0].querySelector(".route-heading");
      heading.hidden = false;
      heading.rowSpan = visibleRows.length;
    }
    group.hidden = visibleRows.length === 0;
  }

  function writeFilterUrl(filters) {
    writeSelectedUrl(selects.map((select) => select.name), filters);
  }

  function returnDetailFocus(trigger = lastTrigger) {
    if (trigger instanceof HTMLElement && trigger.closest("[hidden]") === null) {
      trigger.focus();
    } else if (selects[0] instanceof HTMLSelectElement) {
      selects[0].focus();
    } else if (matrixScroll instanceof HTMLElement) {
      matrixScroll.focus();
    }
  }

  function closeDetail(returnFocus = false, updateHash = false) {
    if (activeDetail instanceof HTMLElement) {
      activeDetail.hidden = true;
      activeDetail.classList.remove("is-active");
      activeDetail.removeAttribute("role");
      activeDetail.removeAttribute("aria-modal");
    }
    document.body.classList.remove("detail-open");
    if (activeTrigger instanceof HTMLElement) activeTrigger.removeAttribute("aria-current");
    activeDetail = null;
    activeTrigger = null;
    if (updateHash) history.pushState(null, "", window.location.search + "#matrix-title");
    if (returnFocus) returnDetailFocus();
  }

  function openDetail(id, trigger = null, updateHash = true) {
    const detail = document.getElementById(id);
    if (!(detail instanceof HTMLElement) || detail.dataset.filterMatch !== "true") return false;
    closeDetail(false, false);
    detail.hidden = false;
    detail.classList.add("is-active");
    detail.setAttribute("role", "dialog");
    detail.setAttribute("aria-modal", "true");
    document.body.classList.add("detail-open");
    activeDetail = detail;
    const currentTrigger = triggerById.get(id);
    if (currentTrigger instanceof HTMLElement) {
      currentTrigger.setAttribute("aria-current", "true");
      activeTrigger = currentTrigger;
      lastTrigger = currentTrigger;
    } else if (trigger instanceof HTMLElement) {
      lastTrigger = trigger;
    }
    if (updateHash) history.pushState(null, "", window.location.search + "#" + id);
    detail.focus({ preventScroll: true });
    detail.scrollIntoView({ behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "auto" : "smooth", block: "start" });
    return true;
  }

  function applyFilters(updateUrl = true, updateDetailHistory = true) {
    const filters = values();
    columns.forEach((column) => {
      column.hidden = !matches(column.dataset.viewport, filters.viewport) || !matches(column.dataset.theme, filters.theme);
    });

    let visibleRowCount = 0;
    rows.forEach((row) => {
      const rowMatches = matches(row.dataset.route, filters.route) && matches(row.dataset.state, filters.state);
      let visibleSlots = 0;
      let matchingExecutions = 0;
      row.querySelectorAll("[data-matrix-slot]").forEach((slot) => {
        const coordinateMatches = matches(slot.dataset.viewport, filters.viewport) && matches(slot.dataset.theme, filters.theme);
        slot.hidden = !coordinateMatches;
        if (!coordinateMatches) return;
        visibleSlots += 1;
        const statusMatches = matches(slot.dataset.status, filters.status);
        const cell = slot.querySelector("[data-cell]");
        const placeholder = slot.querySelector(".filtered-cell");
        if (cell instanceof HTMLElement) cell.hidden = !statusMatches;
        if (placeholder instanceof HTMLElement) placeholder.hidden = statusMatches;
        if (statusMatches && slot.dataset.status !== "missing") matchingExecutions += 1;
      });
      row.hidden = !rowMatches || (filters.status === "" ? visibleSlots === 0 : matchingExecutions === 0);
      if (!row.hidden) visibleRowCount += 1;
    });
    document.querySelectorAll("[data-route-group]").forEach(updateRouteHeading);

    let executionCount = 0;
    details.forEach((detail) => {
      const isMatch = detailMatches(detail, filters);
      detail.dataset.filterMatch = String(isMatch);
      if (isMatch) executionCount += 1;
    });
    if (activeDetail instanceof HTMLElement && activeDetail.dataset.filterMatch !== "true") closeDetail(false, updateDetailHistory);
    if (result) result.textContent = "Showing " + executionCount + " of " + details.length + " executions across " + visibleRowCount + " matrix " + (visibleRowCount === 1 ? "row." : "rows.");
    if (noResults instanceof HTMLElement) noResults.hidden = executionCount !== 0;
    if (reset instanceof HTMLButtonElement) reset.disabled = selects.every((select) => select.value === "");
    if (updateUrl) writeFilterUrl(filters);
  }

  function restoreFiltersFromUrl() {
    const params = new URLSearchParams(window.location.search);
    selects.forEach((select) => {
      const value = params.get(select.name);
      select.value = value !== null && Array.from(select.options).some((option) => option.value === value) ? value : "";
    });
  }

  function syncDetailFromHash() {
    const id = window.location.hash.slice(1);
    if (id.startsWith("execution-")) {
      if (activeDetail instanceof HTMLElement && activeDetail.id === id) return;
      if (activeDetail !== null) closeDetail(true, false);
      if (!openDetail(id, null, false)) history.replaceState(null, "", window.location.search + "#matrix-title");
    } else if (activeDetail !== null) closeDetail(true, false);
  }

  function syncStateFromUrl() {
    const detailTrigger = activeTrigger ?? lastTrigger;
    const hadDetailFocus = activeDetail instanceof HTMLElement && activeDetail.contains(document.activeElement);
    const hadTriggerFocus = detailTrigger instanceof HTMLElement && document.activeElement === detailTrigger;
    restoreFiltersFromUrl();
    applyFilters(false, false);
    syncDetailFromHash();
    if (activeDetail === null && (hadDetailFocus || hadTriggerFocus)) returnDetailFocus(detailTrigger);
  }

  form.addEventListener("change", () => applyFilters());
  form.addEventListener("reset", () => requestAnimationFrame(() => applyFilters()));
  document.addEventListener("click", (event) => {
    const trigger = event.target instanceof Element ? event.target.closest("[data-detail-target]") : null;
    if (trigger instanceof HTMLAnchorElement) {
      event.preventDefault();
      openDetail(trigger.dataset.detailTarget, trigger);
      return;
    }
    const close = event.target instanceof Element ? event.target.closest("[data-close-detail]") : null;
    if (close instanceof HTMLAnchorElement) {
      event.preventDefault();
      closeDetail(true, true);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && activeDetail !== null) {
      event.preventDefault();
      closeDetail(true, true);
      return;
    }
    if (event.key === "Tab" && activeDetail instanceof HTMLElement) {
      const focusable = Array.from(activeDetail.querySelectorAll(focusableSelector)).filter((element) => element instanceof HTMLElement && !element.hidden);
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!(first instanceof HTMLElement) || !(last instanceof HTMLElement)) {
        event.preventDefault();
        activeDetail.focus();
      } else if (event.shiftKey && (document.activeElement === first || document.activeElement === activeDetail)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      } else if (!activeDetail.contains(document.activeElement)) {
        event.preventDefault();
        first.focus();
      }
    }
  });
  window.addEventListener("hashchange", syncDetailFromHash);
  window.addEventListener("popstate", syncStateFromUrl);

  restoreFiltersFromUrl();
  details.forEach((detail) => { detail.hidden = true; });
  applyFilters(false);
  syncDetailFromHash();
})();`;

const interactionHash = createHash("sha256")
  .update(interactions)
  .digest("base64");

const styles = `
:root{color-scheme:dark;--bg:#090b10;--panel:#11151d;--panel-2:#171c26;--line:#293140;--text:#f4f7fb;--muted:#9aa6b8;--accent:#5ee0b1;--pass:#4ade80;--fail:#fb7185;font-family:"Avenir Next","Segoe UI Variable",Ubuntu,sans-serif}
*{box-sizing:border-box}[hidden]{display:none!important}.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}html{background:var(--bg);scroll-behavior:smooth}body{margin:0;background:radial-gradient(circle at 15% -10%,#123c38 0,transparent 34rem),var(--bg);color:var(--text);font-size:16px;line-height:1.5}a{color:inherit}.skip-link{position:fixed;top:10px;left:10px;z-index:20;padding:12px 16px;border-radius:10px;background:var(--accent);color:#071510;font-weight:800;transform:translateY(-160%)}.skip-link:focus{transform:translateY(0)}code{font-family:"SFMono-Regular",Consolas,monospace;font-size:.88em;overflow-wrap:anywhere}.shell{width:min(1600px,calc(100% - 32px));margin:0 auto;padding:48px 0 96px}.hero{display:grid;grid-template-columns:minmax(0,1.6fr) minmax(260px,.7fr);gap:24px;align-items:end;margin-bottom:28px}.brand{display:inline-flex;align-items:center;gap:10px;color:#b9f8e3;font-weight:750;letter-spacing:.02em}.brand-mark{display:grid;place-items:center;width:30px;height:30px;border:1px solid #38c99c;border-radius:9px;background:linear-gradient(145deg,#249c78,#155e4a);box-shadow:0 10px 30px #2dc79a44}.eyebrow{margin:0 0 8px;color:#7ee7c4;font-size:.75rem;font-weight:800;letter-spacing:.14em;text-transform:uppercase}.hero h1{max-width:780px;margin:18px 0 10px;font-size:clamp(2.5rem,6vw,5.8rem);line-height:.94;letter-spacing:-.065em;text-wrap:balance}.lede{max-width:720px;margin:0;color:var(--muted);font-size:clamp(1rem,2vw,1.2rem)}.score{padding:26px;border:1px solid #285248;border-radius:20px;background:linear-gradient(145deg,#102420,#11151d);box-shadow:0 24px 80px #0008}.score strong{display:block;font-size:clamp(2.5rem,7vw,5rem);line-height:1;letter-spacing:-.06em;font-variant-numeric:tabular-nums}.score span{color:var(--muted)}.run-meta{display:flex;flex-wrap:wrap;gap:10px 24px;margin:0 0 24px;color:var(--muted);font-size:.82rem}.run-meta code{color:#d7ddea}.summary{display:grid;grid-template-columns:repeat(6,minmax(120px,1fr));gap:12px;margin-bottom:28px}.metric{padding:18px;border:1px solid var(--line);border-radius:16px;background:#10141bd9}.metric span{display:block;color:var(--muted);font-size:.75rem;font-weight:700;letter-spacing:.08em;text-transform:uppercase}.metric strong{display:block;margin-top:5px;font-size:1.65rem;letter-spacing:-.04em;font-variant-numeric:tabular-nums}.metric--failed strong{color:var(--fail)}.panel{border:1px solid var(--line);border-radius:20px;background:var(--panel);box-shadow:0 24px 80px #0005}.filters{padding:22px;margin-bottom:18px}.filters-heading{display:flex;align-items:end;justify-content:space-between;gap:24px;margin-bottom:16px}.filters-heading h2{margin:0;font-size:1.35rem;letter-spacing:-.025em}.filters-heading>p{margin:0;color:var(--muted)}#report-filters,#finding-filters{display:grid;grid-template-columns:repeat(5,minmax(130px,1fr)) auto;gap:10px;align-items:end}.filter-control span{display:block;margin:0 0 5px;color:var(--muted);font-size:.75rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.filter-control select,.filter-control input,.reset-filters{width:100%;min-height:44px;border:1px solid #3a4558;border-radius:10px;background:#0d1117;color:var(--text);font:inherit}.filter-control select{padding:8px 34px 8px 11px}.filter-control input{min-width:0;padding:8px 11px}.filter-control select:hover,.filter-control input:hover,.reset-filters:hover:not(:disabled){border-color:#4dbb99}.filter-control select:focus-visible,.filter-control input:focus-visible,.reset-filters:focus-visible,.back-link:focus-visible,summary:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.reset-filters{padding:8px 14px;color:#b9f8e3;font-weight:750;cursor:pointer}.reset-filters:disabled{color:#657184;cursor:not-allowed;opacity:.7}.matrix-panel{padding:22px;margin-bottom:28px}.section-heading{display:flex;justify-content:space-between;gap:24px;align-items:end;margin-bottom:18px}.section-heading h2,.detail h2,.empty-report h2{margin:0;font-size:1.6rem;letter-spacing:-.035em}.section-heading>p{max-width:420px;margin:0;color:var(--muted);text-align:right}.matrix-scroll{overflow:auto;border:1px solid var(--line);border-radius:14px}.matrix-scroll:focus-visible{outline:3px solid var(--accent);outline-offset:3px}table{width:100%;min-width:max-content;border-collapse:separate;border-spacing:0;background:#0d1117}th,td{border-right:1px solid var(--line);border-bottom:1px solid var(--line);padding:10px;text-align:left;vertical-align:top}thead th{position:sticky;top:0;z-index:2;background:#171c26;color:#e7eaf0}th:last-child,td:last-child{border-right:0}tbody tr:last-child th,tbody tr:last-child td{border-bottom:0}th span{display:block}th small{display:block;max-width:220px;margin-top:3px;color:var(--muted);font-weight:500}.route-heading{min-width:145px;background:#141924}.state-heading{min-width:170px;background:#10151e}.matrix-cell{display:block;width:224px;min-height:154px;overflow:hidden;border:1px solid var(--line);border-radius:11px;background:var(--panel-2);text-decoration:none;transition:border-color .15s ease,transform .15s ease}.matrix-cell:hover{border-color:#3cae8a;transform:translateY(-1px)}.matrix-cell:focus-visible{outline:3px solid var(--accent);outline-offset:2px}.matrix-cell[aria-current=true]{border-color:var(--accent);box-shadow:0 0 0 1px var(--accent)}.matrix-cell--failed{border-color:#6f3342}.matrix-cell--missing{display:grid;place-items:center;color:#8793a5;border-style:dashed}.filtered-cell{display:grid;width:224px;min-height:154px;place-items:center;color:#657184;font-size:1.5rem}.cell-status{display:flex;align-items:center;gap:7px;padding:7px 10px;color:#cad1dc;font-size:.75rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase}.status-dot{width:7px;height:7px;border-radius:99px;background:var(--pass);box-shadow:0 0 0 3px #4ade8020}.matrix-cell--failed .status-dot{background:var(--fail);box-shadow:none}.matrix-cell--missing{display:grid;place-items:center;border:1px dashed var(--fail);color:var(--fail);font:800 .75rem/1 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}.filtered-cell{width:clamp(260px,23vw,430px);min-height:220px;color:var(--muted)}.no-results{padding:64px clamp(20px,3.4vw,64px);border-bottom:2px solid var(--line);text-align:left}
@media(max-width:1180px){#report-filters{grid-template-columns:repeat(3,1fr)}.reset-filters{width:auto}}
@media(max-width:1000px){.hero,.detail-layout{grid-template-columns:1fr}.summary{grid-template-columns:repeat(3,1fr)}.score{max-width:420px}.section-heading{align-items:start;flex-direction:column}.section-heading>p{text-align:left}.diagnostics{grid-template-columns:1fr}}
@media(max-width:700px){.shell{width:min(100% - 20px,1600px);padding-top:28px}.hero h1{font-size:3rem}.summary{grid-template-columns:repeat(2,1fr)}.filters,.matrix-panel,.detail{padding:14px}.filters-heading,.detail-heading{align-items:start;flex-direction:column}.filters-heading{gap:8px}#report-filters{grid-template-columns:1fr}.reset-filters{width:100%}.run-meta{display:grid;gap:6px}.metric{padding:14px}.matrix-scroll{overflow:visible;border:0}.matrix-scroll>table{display:block;width:100%;max-width:100%;min-width:0;table-layout:fixed;background:transparent}.matrix-scroll thead,.matrix-scroll .route-heading{display:none!important}.matrix-scroll tbody{display:block;width:100%}.matrix-scroll tbody+tbody{margin-top:12px}.matrix-scroll tr{display:grid;width:100%;grid-template-columns:repeat(2,minmax(0,1fr));gap:8px;padding:10px;border:1px solid var(--line);border-radius:12px;background:#0d1117}.matrix-scroll tr+tr{margin-top:8px}.matrix-scroll .state-heading{display:block;grid-column:1/-1;min-width:0;padding:2px 2px 9px;border:0;background:transparent}.state-heading:before{content:attr(data-mobile-route);display:block;margin-bottom:3px;color:#7ee7c4;font-size:.72rem;font-weight:800;letter-spacing:.06em;text-transform:uppercase}.matrix-scroll td{display:block;min-width:0;padding:0;border:0}.matrix-scroll td:before{content:attr(data-column-label);display:block;margin:0 0 5px;color:var(--muted);font-size:.72rem;font-weight:800}.matrix-cell,.filtered-cell{width:100%;min-height:128px}.thumbnail{height:96px}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.matrix-cell{transition:none}}

/* Kinetic evidence editorial: full-bleed proof, not dashboard chrome. */
:root{color-scheme:light dark;--bg:#f4f0e6;--panel:#f4f0e6;--panel-2:#fbfaf6;--line:#171a16;--text:#171a16;--muted:#666b62;--accent:#c8ff48;--pass:#88bd2e;--fail:#ff4d2e;--warning:#d69b2d;--focus:#4c66ff;--void:#0b0c0a;--bone:#f4f0e6;font-family:"Avenir Next","Segoe UI Variable",Ubuntu,sans-serif}
html{background:var(--bg);scroll-padding-top:6rem}
body{min-width:320px;background-color:var(--bg);background-image:linear-gradient(to right,color-mix(in srgb,var(--line) 8%,transparent) 1px,transparent 1px),linear-gradient(to bottom,color-mix(in srgb,var(--line) 8%,transparent) 1px,transparent 1px);background-size:clamp(64px,8.333vw,160px) clamp(64px,8.333vw,160px);color:var(--text)}
body.detail-open{overflow:hidden}.shell{width:100%;max-width:none;margin:0;padding:0}.skip-link{border-radius:0;background:var(--focus);color:#fff}.eyebrow{color:var(--muted);font:800 .6875rem/1.2 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.18em}
.hero{display:block;min-height:min(900px,92svh);margin:0;padding:20px clamp(20px,3.4vw,64px) clamp(48px,7vw,112px);border-bottom:2px solid var(--line);background:color-mix(in srgb,var(--bg) 94%,transparent)}
.masthead{display:flex;align-items:center;justify-content:space-between;gap:24px;padding-bottom:18px;border-bottom:1px solid var(--line);font:750 .6875rem/1.2 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.14em;text-transform:uppercase}
.brand{gap:12px;color:var(--text);font-weight:850;letter-spacing:.03em}.brand-mark{display:grid;width:42px;height:26px;place-items:center;border:1px solid var(--line);border-radius:0;background:var(--accent);box-shadow:none;color:#0b0c0a;font:900 .625rem/1 ui-monospace,"SFMono-Regular",Menlo,monospace}
.hero-verdict{display:grid;grid-template-columns:minmax(0,8fr) minmax(240px,4fr);gap:clamp(24px,5vw,96px);align-items:end;margin-top:clamp(54px,10vh,132px)}
.hero h1{max-width:none;margin:10px 0 0;color:var(--text);font-family:Georgia,"Times New Roman",serif;font-size:clamp(4.5rem,12vw,12rem);font-weight:400;line-height:.72;letter-spacing:-.075em;text-wrap:balance}
.lede{max-width:58rem;margin:clamp(42px,7vh,88px) 0 0;color:var(--text);font-size:clamp(1.05rem,2vw,1.85rem);line-height:1.2;letter-spacing:-.025em}
.score{position:relative;padding:18px 0 0;border:0;border-top:2px solid var(--line);border-radius:0;background:none;box-shadow:none}.score:before{position:absolute;top:-2px;left:0;width:30%;height:8px;background:var(--accent);content:""}.score strong{display:flex;align-items:flex-start;color:var(--text);font-family:Georgia,"Times New Roman",serif;font-size:clamp(5rem,11vw,11rem);font-weight:400;line-height:.75;letter-spacing:-.09em}.score strong span{padding-top:.12em;font:800 clamp(1rem,2vw,2rem)/1 "Avenir Next","Segoe UI Variable",Ubuntu,sans-serif;letter-spacing:0}.score p{max-width:24rem;margin:26px 0 0;font-size:clamp(1rem,1.4vw,1.25rem);font-weight:750;line-height:1.2}
.run-meta{display:flex;margin:0;padding:13px clamp(20px,3.4vw,64px);border-bottom:1px solid var(--line);background:var(--line);color:var(--bg);font:650 .6875rem/1.4 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.04em}.run-meta code{color:inherit}.privacy-panel{display:grid;grid-template-columns:minmax(240px,1.2fr) minmax(260px,1fr) minmax(240px,1fr);gap:clamp(20px,3vw,48px);padding:clamp(24px,3.4vw,56px);border-bottom:2px solid var(--line)}.privacy-panel h2,.privacy-panel h3{margin:0}.privacy-panel h2{font-size:clamp(2rem,4vw,4rem);line-height:.9;letter-spacing:-.055em}.privacy-panel h3{font-size:.75rem;letter-spacing:.1em;text-transform:uppercase}.privacy-panel dl{display:grid;grid-template-columns:repeat(3,1fr);margin:0}.privacy-panel dl div{padding:12px;border-left:1px solid var(--line)}.privacy-panel dt{font:700 .7rem/1 ui-monospace,"SFMono-Regular",Menlo,monospace;text-transform:uppercase}.privacy-panel dd{margin:8px 0 0;font-size:2rem;font-weight:800}.privacy-panel ul{padding-left:18px}.privacy-panel code{color:var(--accent)}
.run-tape{display:grid;grid-template-columns:repeat(6,minmax(0,1fr));gap:0;margin:0;border-bottom:2px solid var(--line);background:var(--bg)}.metric{min-width:0;padding:clamp(16px,2vw,34px) clamp(12px,1.5vw,28px);border:0;border-right:1px solid var(--line);border-radius:0;background:transparent}.metric:last-child{border-right:0}.metric span{color:var(--muted);font:800 .6875rem/1.2 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.14em}.metric strong{margin-top:10px;color:var(--text);font-family:Georgia,"Times New Roman",serif;font-size:clamp(2rem,4vw,5rem);font-weight:400;line-height:.85;letter-spacing:-.06em}.metric--failed{background:var(--fail)}.metric--failed span,.metric--failed strong{color:#0b0c0a}
.contract-score strong{font-variant-numeric:tabular-nums}.contract-score strong span{padding-top:.42em;font-size:clamp(1rem,2vw,2rem);letter-spacing:-.02em}.contract-lede{font-family:ui-monospace,"SFMono-Regular",Menlo,monospace;font-size:clamp(.9rem,1.4vw,1.15rem);letter-spacing:.015em}.contract-hero h1{text-transform:uppercase}body[data-contract-verdict="failed"] .contract-score:before,body[data-contract-verdict="error"] .contract-score:before{background:var(--fail)}
.contract-findings{border-bottom:2px solid var(--line);background:var(--bg);scroll-margin-top:1rem}.contract-findings-heading{padding-top:clamp(64px,9vw,132px)}.findings-list{margin:0;padding:0;border-top:2px solid var(--line);list-style:none}.finding{position:relative;margin:0;padding:clamp(22px,3vw,46px) clamp(20px,3.4vw,64px);overflow:hidden;border-bottom:1px solid var(--line)}.finding:last-child{border-bottom:0}.finding:before{position:absolute;top:0;bottom:0;left:0;width:7px;background:var(--warning);content:""}.finding--critical:before{background:var(--fail)}.finding--calm:before{background:var(--accent)}.finding-heading{display:flex;align-items:start;justify-content:space-between;gap:24px}.finding-heading h3{max-width:100%;margin:0;font-family:Georgia,"Times New Roman",serif;font-size:clamp(1.8rem,4vw,4.5rem);font-weight:400;line-height:.95;letter-spacing:-.045em;overflow-wrap:anywhere}.finding-heading h3 a{text-decoration-thickness:1px;text-underline-offset:.16em}.finding-heading h3 a:visited{color:#23634f}.finding-kind{flex:none;padding:7px 9px;border:1px solid currentColor;font:800 .6875rem/1.2 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.08em;text-transform:uppercase}.finding--critical .finding-kind{background:var(--fail);color:#0b0c0a}.finding--warning .finding-kind{background:var(--warning);color:#0b0c0a}.finding-outcome,.exception-meta{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));max-width:72rem;margin:clamp(20px,3vw,36px) 0 0;border-top:1px solid var(--line)}.finding-outcome>div,.exception-meta>div{min-width:0;padding:12px 16px 12px 0;border-bottom:1px solid var(--line)}.finding-outcome>div:nth-child(odd),.exception-meta>div:nth-child(odd){border-right:1px solid var(--line)}.finding-outcome>div:nth-child(even),.exception-meta>div:nth-child(even){padding-left:16px}.finding-outcome dt,.exception-meta dt,.finding-command>span{color:var(--muted);font:800 .6875rem/1.2 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}.finding-outcome dd,.exception-meta dd{margin:6px 0 0;overflow-wrap:anywhere}.exception-meta{grid-template-columns:minmax(150px,1fr) minmax(240px,2fr) minmax(220px,1fr)}.exception-meta>div:nth-child(2){border-right:1px solid var(--line)}.exception-lifecycle{display:block;margin-top:6px;color:var(--muted);font:800 .6875rem/1.3 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.04em;text-transform:uppercase}.exception-guidance{max-width:72rem;margin:18px 0 0;padding:14px 16px;border-left:3px solid var(--warning);background:color-mix(in srgb,var(--warning) 10%,transparent)}.finding--critical .exception-guidance{border-left-color:var(--fail);background:color-mix(in srgb,var(--fail) 8%,transparent)}.finding-commands{max-width:72rem;margin-top:24px;border-top:1px solid var(--line)}.finding-command{display:grid;grid-template-columns:120px minmax(0,1fr) auto;gap:14px;align-items:center;padding:12px 0;border-bottom:1px solid var(--line)}.finding-command code{min-width:0;font-size:.78rem;overflow-wrap:anywhere;user-select:text}.finding-command button{min-width:72px;min-height:44px;padding:8px 12px;border:1px solid var(--line);border-radius:0;background:transparent;color:var(--text);font:800 .75rem/1 ui-monospace,"SFMono-Regular",Menlo,monospace;cursor:pointer}.finding-command button:hover,.finding-command button.is-copied{background:var(--focus);color:#fff}.finding-command button:focus-visible,.finding-heading a:focus-visible{outline:3px solid var(--focus);outline-offset:3px}html:not(.js) [data-copy-target]{display:none}.contract-clear{display:flex;justify-content:space-between;gap:24px;padding:clamp(24px,4vw,52px) clamp(20px,3.4vw,64px);border-top:2px solid var(--line)}.contract-clear strong{font-family:Georgia,"Times New Roman",serif;font-size:clamp(1.7rem,3vw,3.5rem);font-weight:400}.contract-clear span{max-width:30rem}.contract-details{margin:0;padding:0 clamp(20px,3.4vw,64px);border-top:1px solid var(--line)}.contract-details summary{min-height:64px;padding:20px 0;font-family:Georgia,"Times New Roman",serif;font-size:clamp(1.2rem,2vw,2rem);cursor:pointer}.contract-details dl{margin:0;padding-bottom:28px}.contract-details dl div{display:grid;grid-template-columns:140px minmax(0,1fr);gap:16px;padding:10px 0;border-top:1px solid color-mix(in srgb,var(--line) 30%,transparent)}.contract-details dt{color:var(--muted);font:800 .6875rem/1.2 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.1em;text-transform:uppercase}.contract-details dd{min-width:0;margin:0;overflow-wrap:anywhere}.copy-status{position:fixed;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
.finding-filter-rail{display:grid;grid-template-columns:minmax(0,1fr) auto;gap:14px 32px;align-items:end;padding:18px clamp(20px,3.4vw,64px);border-top:2px solid var(--line);background:color-mix(in srgb,var(--bg) 94%,transparent)}#finding-filters{display:grid;grid-template-columns:minmax(220px,2fr) minmax(180px,1fr) auto;gap:14px;align-items:end;min-width:0}.finding-filter-rail>p{margin:0;font:650 .75rem/1.4 ui-monospace,"SFMono-Regular",Menlo,monospace}.finding-no-results{grid-column:1/-1;padding:18px 0 4px;border-top:1px solid var(--line)}.finding-no-results strong,.finding-no-results span{display:block}.finding-no-results span{margin-top:4px;color:var(--muted)}html:not(.js) .finding-filter-rail{display:none}
.filter-rail{position:sticky;top:0;z-index:12;margin:0;padding:18px clamp(20px,3.4vw,64px);border:0;border-bottom:2px solid var(--line);border-radius:0;background:color-mix(in srgb,var(--bg) 92%,transparent);box-shadow:none;backdrop-filter:blur(18px)}
.filters-heading{align-items:end;margin-bottom:14px}.filters-heading h2{font-family:Georgia,"Times New Roman",serif;font-size:clamp(1.8rem,3vw,3.2rem);font-weight:400;letter-spacing:-.045em}.filters-heading>p{font:650 .75rem/1.4 ui-monospace,"SFMono-Regular",Menlo,monospace}
.filter-control span{color:var(--muted);font-family:ui-monospace,"SFMono-Regular",Menlo,monospace}.filter-control select,.filter-control input,.reset-filters{min-height:44px;border:0;border-bottom:1px solid var(--line);border-radius:0;background:transparent;color:var(--text)}.filter-control select:hover,.filter-control input:hover,.reset-filters:hover:not(:disabled){border-color:var(--focus)}.filter-control select:focus-visible,.filter-control input:focus-visible,.reset-filters:focus-visible,.back-link:focus-visible,.detail-close:focus-visible,summary:focus-visible{outline:3px solid var(--focus);outline-offset:3px}.reset-filters{color:var(--text);text-align:left}.reset-filters:disabled{color:var(--muted)}
.matrix-panel{margin:0;padding:clamp(64px,9vw,144px) 0 0;background:var(--bg)}.section-heading{align-items:end;margin:0;padding:0 clamp(20px,3.4vw,64px) clamp(28px,3vw,52px)}.section-heading h2,.empty-report h2{font-family:Georgia,"Times New Roman",serif;font-size:clamp(3.6rem,9vw,10rem);font-weight:400;line-height:.8;letter-spacing:-.075em}.section-heading>p{max-width:31rem;color:var(--text);font-size:clamp(1rem,1.4vw,1.25rem);line-height:1.25}
.matrix-scroll{border:0;border-top:2px solid var(--line);border-bottom:2px solid var(--line);border-radius:0;background:var(--bg)}.matrix-scroll:focus-visible{outline-color:var(--focus)}table{background:transparent}th,td{border-color:var(--line);padding:0}thead th{padding:12px 14px;background:var(--line);color:var(--bg);font:750 .6875rem/1.25 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.09em;text-transform:uppercase}
.route-heading,.state-heading{padding:16px 14px;background:var(--bg)}.route-heading{min-width:180px}.state-heading{min-width:210px}.route-heading span,.state-heading span{font-size:1rem}.route-heading small,.state-heading small{font-family:ui-monospace,"SFMono-Regular",Menlo,monospace}
.matrix-cell{position:relative;width:clamp(260px,23vw,430px);min-height:220px;overflow:visible;border:0;border-radius:0;background:var(--panel-2);transition:transform 120ms ease,filter 120ms ease}.matrix-cell:hover{z-index:3;border:0;transform:translateY(-5px);filter:contrast(1.03)}.matrix-cell:focus-visible{z-index:4;outline-color:var(--focus);outline-offset:-4px}.matrix-cell[aria-current=true]{border:0;box-shadow:inset 0 0 0 5px var(--focus)}
.cell-status{height:34px;padding:8px 12px;background:var(--line);color:var(--bg);font-family:ui-monospace,"SFMono-Regular",Menlo,monospace}.status-dot{border-radius:0;background:var(--accent);box-shadow:none}.thumbnail{height:clamp(186px,16vw,300px);background:var(--void);filter:saturate(.82);transition:filter 120ms ease}.matrix-cell:hover .thumbnail{filter:saturate(1)}
.matrix-cell--failed{z-index:2;transform:translate(5px,-5px);box-shadow:-6px 6px 0 var(--fail)}.matrix-cell--failed:hover{transform:translate(5px,-10px)}.matrix-cell--failed .cell-status{background:var(--fail);color:#0b0c0a}.matrix-cell--failed .status-dot{background:#0b0c0a;box-shadow:none}.matrix-cell--failed:after{position:absolute;right:-10px;bottom:12%;width:calc(100% + 20px);height:3px;background:var(--fail);content:"";pointer-events:none}
.matrix-cell--missing{display:grid;place-items:center;border:1px dashed var(--fail);color:var(--fail);font:800 .75rem/1 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.12em;text-transform:uppercase}.filtered-cell{width:clamp(260px,23vw,430px);min-height:220px;color:var(--muted)}.no-results{padding:64px clamp(20px,3.4vw,64px);border-bottom:2px solid var(--line);text-align:left}
.detail{margin:0;padding:clamp(24px,3.4vw,64px);border:0;border-radius:0;background:var(--void);box-shadow:none;color:var(--bone);scroll-margin-top:0}.js .detail.is-active{position:fixed;inset:0;z-index:50;display:block;overflow:auto;outline:0;animation:inspection-in 220ms cubic-bezier(.2,.8,.2,1)}
@keyframes inspection-in{from{clip-path:inset(0 0 100% 0)}to{clip-path:inset(0)}}
.detail-utility{position:sticky;top:0;z-index:3;display:flex;align-items:center;justify-content:space-between;gap:20px;min-height:54px;margin:calc(clamp(24px,3.4vw,64px)*-1) calc(clamp(24px,3.4vw,64px)*-1) clamp(40px,5vw,80px);padding:0 clamp(24px,3.4vw,64px);border-bottom:1px solid #55584f;background:color-mix(in srgb,var(--void) 94%,transparent);font:750 .6875rem/1.2 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.12em;text-transform:uppercase;backdrop-filter:blur(16px)}
.detail-close{display:flex;align-items:center;gap:14px;min-height:44px;text-decoration:none}.detail-close span{font-size:1.8rem;font-weight:300}.detail-heading{align-items:end;margin-bottom:clamp(28px,4vw,64px);padding-bottom:24px;border-bottom:1px solid #55584f}.detail-heading .eyebrow{color:#a8ad9f}.detail-heading h2{font-family:Georgia,"Times New Roman",serif;font-size:clamp(3.6rem,9vw,10rem);font-weight:400;line-height:.8;letter-spacing:-.075em}
.status-badge{border:1px solid currentColor;border-radius:0;background:transparent}.status-badge--passed{color:var(--accent);background:transparent}.status-badge--failed{color:var(--fail);background:transparent}.detail-layout{grid-template-columns:minmax(0,9fr) minmax(260px,3fr);gap:0;border-bottom:1px solid #55584f}.evidence{overflow:visible;border:0;border-right:1px solid #55584f;border-radius:0;background:#000}.full-screenshot{width:100%;max-height:none}.metadata{padding:0 0 0 clamp(20px,2.5vw,48px);border:0;border-radius:0;background:transparent}.metadata dl div{padding:14px 0;border-color:#55584f}.metadata dt{color:#a8ad9f;font-family:ui-monospace,"SFMono-Regular",Menlo,monospace}
.diagnostics{display:block;margin-top:clamp(44px,6vw,96px)}.diagnostics details{border:0;border-top:1px solid #55584f;border-radius:0;background:transparent}.diagnostics details:last-child{border-bottom:1px solid #55584f}.diagnostics summary{min-height:64px;padding:12px 0;font-family:Georgia,"Times New Roman",serif;font-size:clamp(1.2rem,2.2vw,2.5rem);font-weight:400}.diagnostics summary strong{border:1px solid #55584f;border-radius:0;background:transparent;color:var(--bone);font-family:ui-monospace,"SFMono-Regular",Menlo,monospace}.diagnostic-body{padding:0 0 24px;border:0}.diagnostic-body ul{color:var(--bone)}.diagnostic-body span,.empty-detail{color:#a8ad9f}.back-link,.back-link:visited{color:var(--accent)}
.empty-report{padding:64px clamp(20px,3.4vw,64px);border:0;border-bottom:2px solid var(--line);border-radius:0;background:var(--bg);box-shadow:none}.footer{display:flex;align-items:flex-end;justify-content:space-between;gap:24px;min-height:45vh;margin:0;padding:clamp(40px,5vw,80px) clamp(20px,3.4vw,64px);background:var(--line);color:var(--bg);text-align:left}.footer strong{font-family:Georgia,"Times New Roman",serif;font-size:clamp(4rem,12vw,12rem);font-weight:400;line-height:.7;letter-spacing:-.08em}.footer span{max-width:24rem;font:650 .75rem/1.4 ui-monospace,"SFMono-Regular",Menlo,monospace;letter-spacing:.06em;text-transform:uppercase}
@media(max-width:1000px){.hero{min-height:auto}.hero-verdict{grid-template-columns:1fr}.score{max-width:none}.run-tape{grid-template-columns:repeat(3,1fr)}.metric:nth-child(3){border-right:0}.metric:nth-child(-n+3){border-bottom:1px solid var(--line)}.detail-layout{grid-template-columns:1fr}.evidence{border-right:0;border-bottom:1px solid #55584f}.metadata{padding:24px 0}.footer{align-items:flex-start;flex-direction:column}}
@media(max-width:700px){body{background-image:none}.shell{width:100%;padding:0}.hero{padding:14px 14px 50px}.masthead>span{max-width:11rem;text-align:right}.hero-verdict{margin-top:58px}.hero-verdict>*{min-width:0}.hero h1{font-size:clamp(4rem,20vw,7rem);line-height:.78}.contract-hero h1{font-size:clamp(3.3rem,17vw,7rem)}.score strong{font-size:clamp(5rem,28vw,9rem)}.lede{margin-top:44px}.run-meta{display:grid;padding:12px 14px}.privacy-panel{grid-template-columns:1fr;padding:30px 14px}.privacy-panel dl div:first-child{border-left:0}.run-tape{grid-template-columns:repeat(2,1fr)}.metric{padding:16px 14px;border-right:1px solid var(--line)!important;border-bottom:1px solid var(--line)!important}.metric:nth-child(even){border-right:0!important}.metric:nth-last-child(-n+2){border-bottom:0!important}.filter-rail{position:relative;padding:20px 14px}.filters-heading{gap:8px}}
@media(max-width:700px){.matrix-panel{padding:72px 0 0}.section-heading{padding:0 14px 24px}.section-heading h2{font-size:clamp(3.5rem,19vw,6.5rem)}.matrix-scroll{overflow:visible;border-left:0;border-right:0}.matrix-scroll tr{grid-template-columns:minmax(0,1fr);gap:12px;padding:18px 0;border:0;border-top:1px solid var(--line);border-radius:0;background:transparent}.matrix-scroll tbody+tbody{margin-top:0}.matrix-scroll .state-heading{padding:0 14px 8px}.matrix-scroll td{padding:0 6px}.matrix-cell,.filtered-cell{min-height:170px;border-radius:0}.thumbnail{width:100%;max-width:calc(100vw - 12px);height:136px}.matrix-cell--failed{transform:translate(3px,-3px);box-shadow:-4px 4px 0 var(--fail)}.detail{padding:18px 14px}.detail-utility{margin:-18px -14px 38px;padding:0 14px}.detail-heading{align-items:flex-start}.detail-heading h2{font-size:clamp(3.2rem,18vw,6rem)}.footer{min-height:50vh;padding:48px 14px}.footer strong{font-size:clamp(4rem,22vw,8rem)}}
@media(max-width:760px){.contract-findings-heading{padding-top:72px}.finding-filter-rail{grid-template-columns:1fr;padding:18px 14px}#finding-filters{grid-template-columns:1fr}.finding-filter-rail>p{justify-self:start}.finding{padding:24px 14px}.finding-heading,.contract-clear{align-items:flex-start;flex-direction:column}.finding-kind{order:-1}.finding-outcome,.exception-meta{grid-template-columns:1fr}.finding-outcome>div,.finding-outcome>div:nth-child(even),.exception-meta>div,.exception-meta>div:nth-child(even){padding:12px 0;border-right:0}.finding-command{grid-template-columns:1fr auto;gap:8px}.finding-command>span{grid-column:1/-1}.finding-command code{font-size:.72rem}.contract-details{padding:0 14px}.contract-details dl div{grid-template-columns:1fr;gap:5px}}
@media(prefers-color-scheme:dark){:root{--bg:#11140f;--panel:#11140f;--panel-2:#171a16;--line:#eef0e8;--text:#f4f0e6;--muted:#a6aa9f}.metric--failed span,.metric--failed strong{color:#0b0c0a}.run-meta,.footer{background:var(--line);color:var(--bg)}.cell-status,thead th{background:var(--line);color:var(--bg)}}
@media(prefers-reduced-motion:reduce){html{scroll-behavior:auto}.matrix-cell,.thumbnail{transition:none}.matrix-cell:hover,.matrix-cell--failed,.matrix-cell--failed:hover{transform:none}.js .detail.is-active{animation:none}}
.eyebrow,.masthead,.run-meta,.metric span,thead th,.detail-utility{font-size:.75rem}
#matrix-title{scroll-margin-top:14rem}
@media(max-width:1000px){.privacy-panel{grid-template-columns:1fr}.privacy-panel>div{min-width:0}}
@media(min-width:1001px){.detail-layout{grid-template-columns:minmax(0,8fr) minmax(320px,4fr)}}
@media(max-width:700px){#matrix-title{scroll-margin-top:1rem}.matrix-cell,.filtered-cell{width:calc(100% - 12px)}.matrix-cell--failed:after{right:0;width:100%}}
`;

/** Renders one validated report as a network-independent HTML document. */
export function renderReportHtml(
  input: unknown,
  options: RenderReportOptions = {},
): string {
  const view = transformReport(input);
  const contract = options.contractVerdict === undefined
    ? null
    : transformContractVerdict(options.contractVerdict);
  const evidenceManifest = options.evidenceManifest === undefined
    ? undefined
    : boundEvidenceManifest(input, options.evidenceManifest);
  const summary = view.summary;
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; script-src 'sha256-${interactionHash}'; base-uri 'none'; form-action 'none'">
  <meta name="color-scheme" content="light dark">
  <title>UIWitness · ${contract === null ? "UI State Coverage" : "Contract Verdict"} Report</title>
  <style>${styles}</style>
</head>
<body data-brand-system="kinetic-evidence-v1"${contract === null ? "" : ` data-contract-verdict="${contract.verdict}"`}>
  <a class="skip-link" href="#${contract === null ? "matrix-title" : "contract-findings"}">Skip to ${contract === null ? "coverage matrix" : "contract findings"}</a>
  <main class="shell">
    <header class="hero">
      <div class="masthead"><div class="brand"><span class="brand-mark" aria-hidden="true">UI/W</span>UIWitness</div><span>${contract === null ? `Local evidence / schema v${view.schemaVersion}` : `Contract verdict / schema v${contract.schemaVersion}`}</span></div>
      ${contract === null ? `<div class="hero-verdict">
        <div><p class="eyebrow">UI state coverage report</p><h1>Evidence<br>over instinct.</h1></div>
        <div class="score" aria-label="${summary.passed} of ${summary.executions} executions passed">
          <strong>${escapeHtml(summary.coverage.execution.percentage)}<span>%</span></strong>
          <p>${summary.failed === 0 ? "Every captured state held." : `${summary.failed} ${summary.failed === 1 ? "state broke" : "states broke"}. Open the evidence.`}</p>
        </div>
      </div>
      <p class="lede">Route × state × viewport × theme. One local report. No green average hiding the frame that failed.</p>` : contractHero(contract)}
    </header>
    <p class="run-meta"><span>Generated <code>${escapeHtml(view.generatedAt)}</code></span><span>Base URL <code>${escapeHtml(view.baseURL)}</code></span>${contract === null ? "" : `<span>Run <code>${escapeHtml(contract.runDigest.slice(0, 19))}…</code></span>`}</p>
    ${evidenceManifest === undefined ? "" : privacyPanel(evidenceManifest)}
    <section class="run-tape summary" aria-label="Report summary">
      <div class="metric"><span>Routes</span><strong>${summary.routes}</strong></div>
      <div class="metric"><span>States</span><strong>${summary.states}</strong></div>
      <div class="metric"><span>Executions</span><strong>${summary.executions}</strong></div>
      <div class="metric"><span>Passed</span><strong>${summary.passed}</strong></div>
      <div class="metric metric--failed"><span>Failed</span><strong>${summary.failed}</strong></div>
      <div class="metric"><span>Duration</span><strong>${escapeHtml(duration(summary.durationMs))}</strong></div>
    </section>
    ${contract === null ? "" : contractFindings(contract)}
    ${filters(view)}
    <div id="matrix">${matrix(view)}</div>
    <section aria-label="Execution details">${view.executions.map(detail).join("")}</section>
    <footer class="footer"><strong>UIWitness</strong><span>Generated locally. No network or server required. Just evidence.</span></footer>
  </main>
  <p class="copy-status" id="copy-status" aria-live="polite"></p>
  <script>${interactions}</script>
</body>
</html>
`;
}
