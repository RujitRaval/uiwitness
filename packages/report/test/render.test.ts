import { createHash } from "node:crypto";

import {
  EVIDENCE_MANIFEST_SCHEMA_VERSION,
  REPORT_SCHEMA_VERSION,
  calculateCoverage,
  parseReport,
  serializeReport,
  type UIWitnessEvidenceManifest,
} from "uiwitness-core";
import { describe, expect, it } from "vitest";

import { renderReportHtml } from "../src/render.js";
import {
  allIdentifierReportFixture,
  interactiveReportFixture,
  reportFixture,
} from "./fixture.js";

describe("renderReportHtml", () => {
  it("binds privacy metadata to the exact report before rendering it", () => {
    const report = reportFixture();
    const reportDigest = `sha256:${createHash("sha256")
      .update(serializeReport(report))
      .digest("hex")}` as const;
    const manifest: UIWitnessEvidenceManifest = {
      attempted: report.executions.length,
      captured: report.executions.length,
      generationDigest: reportDigest,
      masks: [],
      omitted: 0,
      reportDigest,
      retention: "all",
      schemaVersion: EVIDENCE_MANIFEST_SCHEMA_VERSION,
      verdictDigest: null,
    };

    expect(renderReportHtml(report, { evidenceManifest: manifest })).toContain(
      "Evidence privacy",
    );
    expect(() => renderReportHtml(report, {
      evidenceManifest: { ...manifest, reportDigest: `sha256:${"f".repeat(64)}` },
    })).toThrow("Evidence manifest does not match");
    expect(() => renderReportHtml(report, {
      evidenceManifest: {
        ...manifest,
        captured: report.executions.length - 1,
        omitted: 1,
      },
    })).toThrow("Evidence manifest does not match");
  });

  it("renders a polished offline matrix and execution details", () => {
    const html = renderReportHtml(reportFixture());

    expect(html).toMatch(/^<!doctype html>/);
    expect(html).toContain("<title>UIWitness · UI State Coverage Report</title>");
    expect(html).toContain('aria-hidden="true">UI/W</span>UIWitness');
    expect(html).toContain("<footer class=\"footer\"><strong>UIWitness</strong>");
    expect(html).not.toContain(["State", "craft"].join(""));
    expect(html).toContain("UI State Coverage Report");
    expect(html).toContain('data-brand-system="kinetic-evidence-v1"');
    expect(html).toContain("Evidence<br>over instinct.");
    expect(html).toContain("1 state broke. Open the evidence.");
    expect(html).toContain("Coverage matrix");
    expect(html).toContain("../artifacts/dashboard/success/desktop-light.png");
    expect(html).toContain('href="#execution-1"');
    expect(html).toContain('id="execution-2"');
    expect(html).toContain('data-signal-fracture="failed"');
    expect(html).toContain('data-signal-fracture="missing"');
    expect(html).toContain("Inspection room / execution-2");
    expect(html).toContain("@media(prefers-color-scheme:dark)");
    expect(html).toContain("@media(prefers-reduced-motion:reduce)");
    expect(html).toContain('detail.setAttribute("role", "dialog")');
    expect(html).toContain('detail.setAttribute("aria-modal", "true")');
    expect(html).toContain('event.key === "Tab"');
    expect(html).toContain("activeDetail.querySelectorAll(focusableSelector)");
    expect(html).toMatch(/<tbody\b[\s\S]*scope="rowgroup"[\s\S]*<\/tbody>/);
    expect(html).toContain("No network or server required");
    expect(html).toContain("default-src 'none'");
    expect(html).not.toMatch(/<link\b/i);
    expect(html).not.toContain("@font-face");
    expect(html).not.toMatch(/<script[^>]+src=/i);
  });

  it("renders every interactive filter and pins its embedded script in CSP", () => {
    const html = renderReportHtml(interactiveReportFixture());
    const script = html.match(/<script>([\s\S]*)<\/script>/i)?.[1];
    const cspHash = html.match(/script-src 'sha256-([^']+)'/)?.[1];

    expect(html).toContain('id="report-filters"');
    expect(html).toContain('select name="route"');
    expect(html).toContain('select name="state"');
    expect(html).toContain('select name="viewport"');
    expect(html).toContain('select name="theme"');
    expect(html).toContain('select name="status"');
    expect(html).toContain('data-route="settings"');
    expect(html).toContain('data-viewport="mobile"');
    expect(html).toContain('data-theme="dark"');
    expect(html).toContain('data-status="failed"');
    expect(html).toContain("2 states broke. Open the evidence.");
    expect(script).toBeDefined();
    expect(cspHash).toBe(
      createHash("sha256").update(script ?? "").digest("base64"),
    );
  });

  it("keeps the valid identifier 'all' distinct from each wildcard option", () => {
    const html = renderReportHtml(allIdentifierReportFixture());

    expect(html).toContain("Every captured state held.");

    for (const name of ["route", "state", "viewport", "theme"]) {
      const select = html.match(
        new RegExp(`<select name="${name}">([\\s\\S]*?)<\\/select>`),
      )?.[1];
      expect(select).toContain('<option value="">All ');
      expect(select).toContain('<option value="all">All</option>');
    }
  });

  it("escapes report-controlled strings in every rendered detail", () => {
    const html = renderReportHtml(reportFixture());

    expect(html).toContain("Widget &lt;script&gt;alert(&#39;x&#39;)&lt;/script&gt; failed");
    expect(html).toContain("Expected &lt;main&gt; content.");
    expect(html).not.toContain("<script>alert('x')</script>");
  });

  it("renders an explicit empty selection without inventing matrix cells", () => {
    const report = parseReport({
      executions: [],
      generatedAt: "2026-08-20T18:00:00.000Z",
      project: { baseURL: "https://uiwitness.invalid" },
      schemaVersion: REPORT_SCHEMA_VERSION,
      summary: {
        coverage: calculateCoverage([], []),
        durationMs: 0,
        executions: 0,
        failed: 0,
        passed: 0,
        routes: 0,
        states: 0,
      },
    });

    const html = renderReportHtml(report);

    expect(html).toContain("No executions were selected for this report.");
    expect(html).not.toContain('class="matrix-cell matrix-cell--passed"');
    expect(html).not.toContain('id="report-filters"');
  });

  it("renders missing evidence and every diagnostic metadata branch", () => {
    const fixture = reportFixture();
    const failed = fixture.executions[1]!;
    const report = parseReport({
      ...fixture,
      executions: [
        fixture.executions[0],
        {
          ...failed,
          diagnostics: {
            ...failed.diagnostics,
            failedRequests: [
              {
                errorText: "net::ERR_CONNECTION_RESET",
                method: "POST",
                url: "https://uiwitness.invalid/api/widget?token=secret",
              },
            ],
            navigationStatus: null,
          },
          durationMs: 10_000,
          screenshotPath: null,
        },
      ],
      summary: { ...fixture.summary, durationMs: 10_420 },
    });

    const html = renderReportHtml(report);

    expect(html).toContain("Screenshot capture failed");
    expect(html).toContain("Not available");
    expect(html).toContain("10 s");
    expect(html).toContain("<strong>POST</strong>");
    expect(html).toContain("token=%5BREDACTED%5D");
    expect(html).toContain("net::ERR_CONNECTION_RESET");
  });
});
