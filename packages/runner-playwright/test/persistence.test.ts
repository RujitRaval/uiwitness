import { createHash } from "node:crypto";
import {
  access,
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as fsRename,
  rm,
  stat,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { chromium } from "playwright";
import { describe, expect, it } from "vitest";

import {
  canonicalizeJson,
  EVIDENCE_MANIFEST_PATH,
  expandMatrix,
  parseConfig,
  parseExecutionResult,
  parseEvidenceManifest,
  parseReport,
  screenshotArtifactPath,
  serializeReport,
  type JsonValue,
  type MatrixCell,
  type Sha256Digest,
} from "uiwitness-core";

import { runPersistedScenarioCells } from "../src/index.js";
import {
  acquirePersistenceLock,
  executionArtifactForOutcome,
  persistReport,
  releasePersistenceLock,
  recoverPublication,
  takeoverClaimPath,
} from "../src/persistence.js";

const scenarioBaseDirectory = fileURLToPath(
  new URL("./fixtures/scenarios/", import.meta.url),
);
const baseURL = "https://uiwitness.invalid/base/";

function persistenceCells(states: readonly string[]): readonly MatrixCell[] {
  return expandMatrix(
    parseConfig({
      baseURL,
      routes: [
        {
          id: "capture",
          path: "/capture?source=uiwitness#panel",
          states: states.map((id) => ({ id, setup: "./capture.mjs" })),
        },
      ],
      themes: ["light"],
      viewports: { compact: { height: 240, width: 320 } },
    }),
  );
}

function interactiveReportCells(): readonly MatrixCell[] {
  return expandMatrix(
    parseConfig({
      baseURL,
      routes: [
        {
          id: "capture",
          path: "/capture",
          states: [
            { id: "clean-after", setup: "./capture.mjs" },
            { id: "page-error", setup: "./capture.mjs" },
          ],
        },
        {
          id: "secondary",
          path: "/capture",
          states: [{ id: "nonfatal", setup: "./capture.mjs" }],
        },
      ],
      themes: ["light", "dark"],
      viewports: {
        compact: { height: 240, width: 320 },
        wide: { height: 480, width: 720 },
      },
    }),
  ).filter(
    (cell) =>
      cell.state.id !== "page-error" ||
      (cell.viewportId === "compact" && cell.theme === "light") ||
      (cell.viewportId === "wide" && cell.theme === "dark"),
  );
}

function allIdentifierCells(): readonly MatrixCell[] {
  return expandMatrix(
    parseConfig({
      baseURL,
      routes: [
        {
          id: "zeta",
          path: "/capture",
          states: [{ id: "alpha", setup: "./capture.mjs" }],
        },
        {
          id: "all",
          path: "/capture",
          states: [{ id: "all", setup: "./capture.mjs" }],
        },
      ],
      themes: ["dark", "all"],
      viewports: {
        wide: { height: 480, width: 720 },
        all: { height: 240, width: 320 },
      },
    }),
  );
}

const contractDigest = `sha256:${"a".repeat(64)}` as Sha256Digest;

function contractVerdictContents(): string {
  return `${canonicalizeJson({
    complete: true,
    configDigest: contractDigest,
    contractDigest,
    evaluatedOn: "2026-09-04",
    findings: [
      {
        actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
        expected: { status: "passed" },
        id: "capture/ordered/compact/light",
        kind: "regression",
        remediate: "uiwitness contract inspect --candidate candidate.json --change expectation:capture/ordered/compact/light",
        reproduce: "uiwitness scan --coordinate capture/ordered/compact/light --headed",
      },
    ],
    runDigest: contractDigest,
    schemaVersion: 1,
    verdict: "failed",
  } as JsonValue)}\n`;
}

function largeContractVerdictContents(count = 2_000): string {
  const findings = Array.from({ length: count }, (_, index) => {
    const id = `bulk/row-${String(index).padStart(4, "0")}/desktop/light`;
    return index % 2 === 0
      ? {
          actual: { failureCodes: ["ASSERTION_FAILED"], status: "failed" },
          expected: { status: "passed" },
          id,
          kind: "regression",
          remediate: `uiwitness contract inspect --change regression:${id}`,
          reproduce: `uiwitness scan --coordinate ${id}`,
        }
      : {
          actual: { status: "passed" },
          currentConfigFingerprint: contractDigest,
          expected: null,
          id,
          kind: "unaccepted-addition",
          remediate: `uiwitness contract inspect --change addition:${id}`,
        };
  });
  return `${canonicalizeJson({
    complete: true,
    configDigest: contractDigest,
    contractDigest,
    evaluatedOn: "2026-09-04",
    findings,
    runDigest: contractDigest,
    schemaVersion: 1,
    verdict: "failed",
  } as JsonValue)}\n`;
}

async function temporaryProject(): Promise<{
  readonly cleanup: () => Promise<void>;
  readonly path: string;
}> {
  const path = await mkdtemp(join(tmpdir(), "uiwitness-persistence-"));
  return {
    cleanup: () => rm(path, { force: true, recursive: true }),
    path,
  };
}

async function expectMissing(path: string): Promise<void> {
  await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
}

describe("runPersistedScenarioCells", () => {
  it("persists deterministic screenshots and a validated schema-v1 report", async () => {
    const project = await temporaryProject();
    const eventKey = Symbol.for("uiwitness.test.capture-events");
    Reflect.set(globalThis, eventKey, []);

    try {
      const cells = persistenceCells([
        "ordered",
        "page-error",
        "screenshot-fail",
        "clean-after",
      ]);
      const run = await runPersistedScenarioCells(cells, {
        baseURL,
        generatedAt: new Date("2026-08-20T15:00:00.000Z"),
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });

      expect(run.reportPath).toBe(".uiwitness/report/uiwitness.json");
      expect(run.htmlReportPath).toBe(".uiwitness/report/index.html");
      expect(run.report).toMatchObject({
        generatedAt: "2026-08-20T15:00:00.000Z",
        project: { baseURL },
        schemaVersion: 1,
        summary: {
          executions: 4,
          failed: 2,
          passed: 2,
          routes: 1,
          states: 4,
        },
      });
      expect(run.report.executions.map(({ status }) => status)).toEqual([
        "passed",
        "failed",
        "failed",
        "passed",
      ]);
      expect(run.report.summary.coverage).toEqual({
        execution: { covered: 2, percentage: 50, total: 4 },
        responsive: { covered: 2, percentage: 50, total: 4 },
        state: { covered: 2, percentage: 50, total: 4 },
        theme: { covered: 2, percentage: 50, total: 4 },
      });
      expect(run.report.summary.durationMs).toBe(
        run.report.executions.reduce(
          (total, execution) => total + execution.durationMs,
          0,
        ),
      );
      expect(run.report.executions[0]).toMatchObject({
        failures: [],
        routePath: "/capture?source=%5BREDACTED%5D",
        screenshotPath: screenshotArtifactPath(cells[0]!),
        url: "https://uiwitness.invalid/capture?source=%5BREDACTED%5D",
      });
      expect(run.report.executions[1]).toMatchObject({
        failures: [
          {
            code: "PAGE_ERROR",
            message: "1 page error(s) matched the failure policy.",
          },
        ],
        screenshotPath: screenshotArtifactPath(cells[1]!),
      });
      expect(run.report.executions[2]).toMatchObject({
        failures: [
          {
            code: "SCREENSHOT_FAILED",
            message: "screenshot failed token=[REDACTED]",
          },
        ],
        screenshotPath: null,
      });

      for (const index of [0, 1, 3]) {
        const path = run.report.executions[index]!.screenshotPath;
        expect(path).not.toBeNull();
        const screenshotPath = join(
          project.path,
          ...(path ?? "").split("/"),
        );
        const bytes = await readFile(screenshotPath);
        expect([...bytes.subarray(0, 8)]).toEqual([
          137, 80, 78, 71, 13, 10, 26, 10,
        ]);
        if (process.platform !== "win32") {
          expect((await stat(screenshotPath)).mode & 0o777).toBe(0o600);
        }
      }
      await expectMissing(
        join(project.path, ".uiwitness/artifacts/capture/screenshot-fail/compact-light.png"),
      );

      const reportPath = join(project.path, run.reportPath);
      const serialized = await readFile(reportPath, "utf8");
      expect(parseReport(JSON.parse(serialized))).toEqual(run.report);
      expect(serialized).toBe(serializeReport(run.report));
      if (process.platform !== "win32") {
        expect((await stat(reportPath)).mode & 0o777).toBe(0o600);
        expect(
          (
            await stat(join(project.path, ".uiwitness/report/index.html"))
          ).mode & 0o777,
        ).toBe(0o600);
        expect(
          (await stat(join(project.path, ".uiwitness/artifacts"))).mode &
            0o777,
        ).toBe(0o700);
      }
      await expect(
        readFile(join(project.path, run.htmlReportPath), "utf8"),
      ).resolves.toContain("UI State Coverage Report");
    } finally {
      Reflect.deleteProperty(globalThis, eventKey);
      await project.cleanup();
    }
  });

  it("atomically publishes schema-v2 retention outcomes and a privacy-safe manifest", async () => {
    const project = await temporaryProject();
    Reflect.set(globalThis, Symbol.for("uiwitness.test.capture-events"), []);
    try {
      const cells = persistenceCells(["ordered", "assertion-fail"]);
      const run = await runPersistedScenarioCells(cells, {
        baseURL,
        evidence: {
          masks: [{ count: 1, id: "private-main", selector: "main" }],
          retention: "failures-only",
        },
        generatedAt: new Date("2026-09-05T12:00:00.000Z"),
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });

      expect(run.report).toMatchObject({
        evidence: { retention: "failures-only" },
        schemaVersion: 2,
      });
      expect(run.report.executions.map(({ screenshot }) => screenshot)).toEqual([
        { status: "omitted-by-policy" },
        {
          path: screenshotArtifactPath(cells[1]!),
          status: "captured",
        },
      ]);
      await expectMissing(join(
        project.path,
        ...screenshotArtifactPath(cells[0]!).split("/"),
      ));
      await expect(access(join(
        project.path,
        ...screenshotArtifactPath(cells[1]!).split("/"),
      ))).resolves.toBeUndefined();

      const manifestSource = await readFile(
        join(project.path, ...EVIDENCE_MANIFEST_PATH.split("/")),
        "utf8",
      );
      expect(parseEvidenceManifest(manifestSource)).toMatchObject({
        attempted: 2,
        captured: 1,
        masks: [{ cardinalities: [1, 1], id: "private-main" }],
        omitted: 1,
        retention: "failures-only",
      });
      expect(manifestSource).not.toContain("selector");
      const html = await readFile(
        join(project.path, ".uiwitness/report/index.html"),
        "utf8",
      );
      expect(html).toContain("Failures Only retention");
      expect(html).toContain("Screenshot omitted by retention policy");
      expect(html).not.toContain("private-main\"");

      const failedCaptureCell = persistenceCells(["screenshot-fail"])[0]!;
      const failedCapture = await runPersistedScenarioCells([failedCaptureCell], {
        baseURL,
        evidence: { retention: "failures-only" },
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });
      expect(failedCapture.report.executions[0]).toMatchObject({
        screenshot: { status: "capture-failed" },
        status: "failed",
      });
      expect(parseEvidenceManifest(await readFile(
        join(project.path, ...EVIDENCE_MANIFEST_PATH.split("/")),
        "utf8",
      ))).toMatchObject({
        attempted: 1,
        captured: 0,
        omitted: 1,
        retention: "failures-only",
      });

      const none = await runPersistedScenarioCells([cells[0]!], {
        baseURL,
        evidence: {
          masks: [{ id: "never-resolved", selector: "[" }],
          retention: "none",
        },
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });
      expect(none.report.schemaVersion).toBe(2);
      expect(none.report.executions[0]?.screenshot).toEqual({
        status: "omitted-by-policy",
      });
      expect(await readdir(join(project.path, ".uiwitness/artifacts"))).toEqual([]);
      expect(parseEvidenceManifest(await readFile(
        join(project.path, ...EVIDENCE_MANIFEST_PATH.split("/")),
        "utf8",
      ))).toMatchObject({
        attempted: 0,
        captured: 0,
        masks: [],
        omitted: 1,
        retention: "none",
      });
    } finally {
      Reflect.deleteProperty(globalThis, Symbol.for("uiwitness.test.capture-events"));
      await project.cleanup();
    }
  });

  it("loads the generated report from disk without network access", async () => {
    const project = await temporaryProject();
    const browser = await chromium.launch({ headless: true });
    const eventKey = Symbol.for("uiwitness.test.capture-events");
    Reflect.set(globalThis, eventKey, []);
    try {
      const run = await runPersistedScenarioCells(
        interactiveReportCells(),
        {
          baseURL,
          generatedAt: new Date("2026-08-20T15:00:30.000Z"),
          projectDirectory: project.path,
          scenarioBaseDirectory,
        },
      );
      const reportUrl = pathToFileURL(
        join(project.path, ...run.htmlReportPath.split("/")),
      ).href;

      for (const viewport of [
        { height: 812, width: 375 },
        { height: 1_024, width: 768 },
        { height: 768, width: 1_024 },
        { height: 900, width: 1_440 },
      ]) {
        const context = await browser.newContext({ viewport });
        try {
          const networkRequests: string[] = [];
          await context.route(/^https?:\/\//, async (route) => {
            networkRequests.push(route.request().url());
            await route.abort();
          });
          const page = await context.newPage();
          await page.goto(reportUrl, { waitUntil: "load" });

          for (const thumbnail of await page.locator("img.thumbnail").all()) {
            await thumbnail.scrollIntoViewIfNeeded();
          }
          await page.waitForFunction(() =>
            Array.from(document.querySelectorAll("img.thumbnail")).every((image) =>
              image instanceof HTMLImageElement && image.complete && image.naturalWidth > 0
            ),
          );
          await page.evaluate(() => {
            window.scrollTo(0, 0);
            document.querySelectorAll(".matrix-scroll").forEach((element) => {
              element.scrollLeft = 0;
            });
          });
          const imageWidths = await page.locator("img.thumbnail").evaluateAll((images) =>
            images.map((image) => (image as HTMLImageElement).naturalWidth),
          );
          expect(imageWidths.length).toBeGreaterThan(0);
          expect(imageWidths.every((width) => width > 0)).toBe(true);
          expect(networkRequests).toEqual([]);
          expect(await page.locator("[data-detail]:visible").count()).toBe(0);
          expect(await page.locator("[data-detail-target]:visible").count()).toBe(10);
          expect(await page.locator("[data-matrix-row]:visible").count()).toBe(3);
          expect(await page.locator('[data-signal-fracture="failed"]:visible').count()).toBe(2);
          expect(await page.locator('[data-signal-fracture="missing"]:visible').count()).toBe(2);
          expect(
            await page.locator(".matrix-cell--passed:visible").first().getAttribute("data-signal-fracture"),
          ).toBeNull();

          if (viewport.width > 1_000) {
            expect(
              await page
                .locator('select[name="route"] option')
                .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
            ).toEqual(["", "capture", "secondary"]);
            expect(
              await page
                .locator('select[name="state"] option')
                .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
            ).toEqual(["", "clean-after", "page-error", "nonfatal"]);
          }

          expect(
            await page.locator(".hero").evaluate((hero) => getComputedStyle(hero).display),
          ).toBe("block");
          const verdictColumns = await page.locator(".hero-verdict").evaluate((verdict) =>
            getComputedStyle(verdict).gridTemplateColumns.split(" ").length,
          );
          expect(verdictColumns).toBe(viewport.width > 1_000 ? 2 : 1);

          if (viewport.width > 1_000) {
            await page.emulateMedia({ colorScheme: "dark" });
            expect(
              await page.locator("html").evaluate((html) =>
                getComputedStyle(html).getPropertyValue("--bg").trim(),
              ),
            ).toBe("#11140f");
            await page.emulateMedia({ colorScheme: "light" });

            await page.keyboard.press("Tab");
            expect(
              await page.locator(".skip-link").evaluate(
                (link) => link === document.activeElement,
              ),
            ).toBe(true);

            await page.locator('select[name="route"]').selectOption("secondary");
            await expect
              .poll(() => page.locator("#filter-results").textContent())
              .toBe("Showing 4 of 10 executions across 1 matrix row.");
            expect(await page.locator("[data-matrix-row]:visible").count()).toBe(1);
            expect(new URL(page.url()).searchParams.get("route")).toBe(
              "secondary",
            );

            await page.locator('select[name="state"]').selectOption("clean-after");
            expect(await page.locator("#no-results").isVisible()).toBe(true);
            await page.locator(".reset-filters").click();
            await expect
              .poll(() => page.locator("#filter-results").textContent())
              .toBe("Showing 10 of 10 executions across 3 matrix rows.");

            const captureGroup = page.locator('[data-route-group="capture"]');
            expect(
              await captureGroup.locator(".route-heading:visible").getAttribute("rowspan"),
            ).toBe("2");
            await page.locator('select[name="state"]').selectOption("page-error");
            expect(await page.locator("[data-matrix-row]:visible").count()).toBe(1);
            expect(await page.locator(".matrix-cell--missing:visible").count()).toBe(2);
            const filteredRouteHeading = page.locator(
              '[data-state="page-error"] .route-heading',
            );
            expect(await filteredRouteHeading.isVisible()).toBe(true);
            expect(await filteredRouteHeading.getAttribute("rowspan")).toBe("1");
            await page.locator(".reset-filters").click();

            await page.locator('select[name="viewport"]').selectOption("wide");
            expect(await page.locator("[data-column]:visible").count()).toBe(2);
            for (const row of await page.locator("[data-matrix-row]:visible").all()) {
              expect(await row.locator("[data-matrix-slot]:visible").count()).toBe(2);
            }
            await page.locator('select[name="theme"]').selectOption("dark");
            expect(await page.locator("[data-column]:visible").count()).toBe(1);
            await page.locator('select[name="status"]').selectOption("failed");
            expect(await page.locator("[data-detail-target]:visible").count()).toBe(1);
            expect(await page.locator(".matrix-cell--passed:visible").count()).toBe(0);

            await page.locator(".reset-filters").click();
            await page.locator('select[name="status"]').selectOption("failed");
            expect(await page.locator(".matrix-cell--failed:visible").count()).toBe(2);
            expect(await page.locator("[data-matrix-row]:visible").count()).toBe(1);

            const firstCell = page.locator("[data-detail-target]:visible").first();
            await page.emulateMedia({ reducedMotion: "reduce" });
            await page.evaluate(() => {
              HTMLElement.prototype.scrollIntoView = (options) => {
                document.documentElement.dataset["scrollBehavior"] =
                  typeof options === "object" && options !== null
                    ? (options.behavior ?? "")
                    : "legacy";
              };
            });
            await firstCell.focus();
            await page.keyboard.press("Enter");
            expect(new URL(page.url()).hash).toMatch(/^#execution-/);
            expect(await page.locator("[data-detail]:visible").count()).toBe(1);
            expect(await firstCell.getAttribute("aria-current")).toBe("true");
            expect(
              await page.locator("html").getAttribute("data-scroll-behavior"),
            ).toBe("auto");
            expect(
              await page.locator("[data-detail]:visible").evaluate(
                (detail) => detail === document.activeElement,
              ),
            ).toBe(true);
            const visibleDetail = page.locator("[data-detail]:visible");
            const detailElement = page.locator(new URL(page.url()).hash);
            expect(await visibleDetail.getAttribute("role")).toBe("dialog");
            expect(await visibleDetail.getAttribute("aria-modal")).toBe("true");
            expect(await page.locator("body").getAttribute("class")).toContain("detail-open");
            expect(
              await firstCell.evaluate((cell) => getComputedStyle(cell).transitionDuration),
            ).toBe("0s");
            const detailClose = visibleDetail.locator(".detail-close");
            const detailBack = visibleDetail.locator(".back-link");
            await detailBack.focus();
            await page.keyboard.press("Tab");
            expect(await detailClose.evaluate((link) => link === document.activeElement)).toBe(true);
            await page.keyboard.press("Shift+Tab");
            expect(await detailBack.evaluate((link) => link === document.activeElement)).toBe(true);
            await visibleDetail.focus();
            const diagnosticCounts = await visibleDetail
              .locator("details summary strong")
              .allTextContents();
            expect(diagnosticCounts).toHaveLength(4);
            expect(diagnosticCounts.some((count) => Number(count) > 0)).toBe(true);
            const consoleDisclosure = visibleDetail.locator("details").nth(1);
            await consoleDisclosure.locator("summary").click();
            expect(await consoleDisclosure.getAttribute("open")).not.toBeNull();
            await detailClose.click();
            expect(await page.locator("[data-detail]:visible").count()).toBe(0);
            expect(await page.locator("body").getAttribute("class")).not.toContain("detail-open");
            expect(await detailElement.getAttribute("role")).toBeNull();
            expect(await detailElement.getAttribute("aria-modal")).toBeNull();
            expect(await firstCell.evaluate((cell) => cell === document.activeElement)).toBe(
              true,
            );

            await firstCell.focus();
            await page.keyboard.press("Enter");
            await page.keyboard.press("Escape");
            expect(await page.locator("[data-detail]:visible").count()).toBe(0);
            expect(await firstCell.evaluate((cell) => cell === document.activeElement)).toBe(
              true,
            );

            await page.locator(".reset-filters").click();
            await page.locator('select[name="route"]').selectOption("capture");
            const historyCell = page.locator("[data-detail-target]:visible").first();
            await historyCell.click();
            await page.locator('select[name="route"]').selectOption("secondary");
            await page.goBack();
            expect(await page.locator('select[name="route"]').inputValue()).toBe(
              "capture",
            );
            expect(await page.locator("[data-detail]:visible").count()).toBe(1);
            await page.goForward();
            expect(await page.locator('select[name="route"]').inputValue()).toBe(
              "secondary",
            );
            expect(await page.locator("[data-detail]:visible").count()).toBe(0);
            expect(
              await page
                .locator('select[name="route"]')
                .evaluate((select) => select === document.activeElement),
            ).toBe(true);

            await page.goto(`${reportUrl}#execution-1`, { waitUntil: "load" });
            expect(await page.locator("#execution-1").isVisible()).toBe(true);
            await page.evaluate(() => {
              window.location.hash = "execution-999";
            });
            await expect
              .poll(() => page.locator("[data-detail]:visible").count())
              .toBe(0);
            await expect
              .poll(() => page.evaluate(() => window.location.hash))
              .toBe("#matrix-title");
            expect(await page.locator('[aria-current="true"]').count()).toBe(0);

            await page.goto(`${reportUrl}#execution-1`, { waitUntil: "load" });
            await page.keyboard.press("Escape");
            expect(
              await page
                .locator('[data-detail-target="execution-1"]')
                .evaluate((cell) => cell === document.activeElement),
            ).toBe(true);

            await page.locator('select[name="status"]').selectOption("failed");
            const failedCell = page.locator("[data-detail-target]:visible").first();
            await failedCell.click();
            await page.evaluate(() => {
              window.location.hash = "execution-1";
            });
            await expect
              .poll(() => page.locator("[data-detail]:visible").count())
              .toBe(0);
            expect(await page.locator('[aria-current="true"]').count()).toBe(0);

            await page.locator('select[name="route"]').selectOption("capture");
            await page.reload({ waitUntil: "load" });
            expect(await page.locator('select[name="route"]').inputValue()).toBe(
              "capture",
            );
            expect(await page.locator('select[name="status"]').inputValue()).toBe(
              "failed",
            );
            expect(await page.locator("[data-detail-target]:visible").count()).toBe(2);

            await page.goto(`${reportUrl}?route=unknown&state=unknown#execution-1`, {
              waitUntil: "load",
            });
            expect(await page.locator('select[name="route"]').inputValue()).toBe("");
            expect(await page.locator('select[name="state"]').inputValue()).toBe("");
            expect(await page.locator("[data-detail-target]:visible").count()).toBe(10);
            expect(await page.locator("#execution-1").isVisible()).toBe(true);
          } else {
            const horizontalOverflow = await page.evaluate(
              () => document.documentElement.scrollWidth > document.documentElement.clientWidth,
            );
            expect(horizontalOverflow).toBe(false);
            const firstCell = await page
              .locator("[data-detail-target]:visible")
              .first()
              .boundingBox();
            expect(firstCell).not.toBeNull();
            expect(firstCell?.x).toBeGreaterThanOrEqual(0);
            expect((firstCell?.x ?? viewport.width) + (firstCell?.width ?? 0)).toBeLessThanOrEqual(
              viewport.width,
            );
            const controlHeights = await page
              .locator("#report-filters select, #report-filters button")
              .evaluateAll((controls) =>
                controls.map((control) => control.getBoundingClientRect().height),
              );
            expect(controlHeights.every((height) => height >= 44)).toBe(true);
          }
        } finally {
          await context.close();
        }
      }

      const noScriptContext = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { height: 900, width: 1_440 },
      });
      try {
        const page = await noScriptContext.newPage();
        await page.goto(reportUrl, { waitUntil: "load" });
        expect(await page.locator("html.js").count()).toBe(0);
        expect(await page.locator("#report-filters").isVisible()).toBe(true);
        expect(await page.locator("[data-detail-target]:visible").count()).toBe(10);
        expect(await page.locator("[data-detail]:visible").count()).toBe(10);
        await page.locator('[data-detail-target="execution-1"]').click();
        expect(new URL(page.url()).hash).toBe("#execution-1");
      } finally {
        await noScriptContext.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, eventKey);
      await browser.close();
      await project.cleanup();
    }
  }, 30_000);

  it("publishes and renders the exact committed contract verdict sidecar", async () => {
    const project = await temporaryProject();
    const browser = await chromium.launch({ headless: true });
    const eventKey = Symbol.for("uiwitness.test.capture-events");
    Reflect.set(globalThis, eventKey, []);
    try {
      const run = await runPersistedScenarioCells(persistenceCells(["ordered"]), {
        baseURL,
        finalizeGeneration: () => ({
          artifacts: [{
            contents: contractVerdictContents(),
            path: ".uiwitness/contract-verdict.json",
            publication: "replace",
            role: "contract-verdict",
          }],
          runDigest: contractDigest,
          toolVersion: "0.0.0-test",
        }),
        generatedAt: new Date("2026-09-04T12:00:00.000Z"),
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });
      await expect(
        readFile(join(project.path, ".uiwitness/contract-verdict.json"), "utf8"),
      ).resolves.toBe(contractVerdictContents());
      const reportUrl = pathToFileURL(
        join(project.path, ...run.htmlReportPath.split("/")),
      ).href;

      for (const width of [320, 760, 1_440]) {
        const context = await browser.newContext({
          viewport: { height: 900, width },
        });
        try {
          const page = await context.newPage();
          await page.goto(reportUrl, { waitUntil: "load" });
          expect(await page.locator("body").getAttribute("data-contract-verdict"))
            .toBe("failed");
          expect(await page.locator("#contract-findings").isVisible()).toBe(true);
          expect(await page.locator("#matrix").isVisible()).toBe(true);
          expect(
            await page.locator("#contract-findings").evaluate((findings) => {
              const matrix = document.querySelector("#matrix");
              return matrix instanceof HTMLElement &&
                findings.getBoundingClientRect().top < matrix.getBoundingClientRect().top;
            }),
          ).toBe(true);
          expect(await page.getByText("Expected", { exact: true }).isVisible()).toBe(true);
          expect(await page.getByText("Actual", { exact: true }).isVisible()).toBe(true);
          expect(await page.getByRole("button", { name: "Copy" }).count()).toBe(2);
          expect(
            await page.getByRole("button", { name: "Copy" }).evaluateAll((buttons) =>
              buttons.every((button) => button.getBoundingClientRect().height >= 44)
            ),
          ).toBe(true);
          if (width === 1_440) {
            const copyButton = page.locator("button[data-copy-target]").first();
            await page.evaluate(() => {
              const nativeTimeout = window.setTimeout.bind(window);
              window.setTimeout = ((callback: TimerHandler, delay?: number) =>
                nativeTimeout(callback, delay === 120 ? 10_000 : delay)) as typeof window.setTimeout;
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: undefined,
              });
              Object.defineProperty(document, "execCommand", {
                configurable: true,
                value: (command: string) => {
                  document.documentElement.dataset["copyFallback"] = command;
                  return true;
                },
              });
            });
            await copyButton.focus();
            await page.keyboard.press("Enter");
            await page.waitForFunction(() =>
              document.querySelector("[data-copy-target]")?.textContent === "Copied"
            );
            expect(await copyButton.textContent()).toBe("Copied");
            expect(await page.locator("#copy-status").textContent()).toBe(
              "Command copied.",
            );
            expect(
              await page.locator("html").getAttribute("data-copy-fallback"),
            ).toBe("copy");

            const nativeCopyButton = page.locator("button[data-copy-target]").nth(1);
            const nativeCommand = await page.locator(
              `#${await nativeCopyButton.getAttribute("data-copy-target")}`,
            ).textContent();
            await page.evaluate(() => {
              delete document.documentElement.dataset["copyFallback"];
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: {
                  writeText: async (value: string) => {
                    document.documentElement.dataset["copyNative"] = value;
                  },
                },
              });
              Object.defineProperty(document, "execCommand", {
                configurable: true,
                value: () => {
                  document.documentElement.dataset["copyFallback"] = "unexpected";
                  return true;
                },
              });
            });
            await nativeCopyButton.focus();
            await page.keyboard.press("Enter");
            await page.waitForFunction(() =>
              document.querySelectorAll("[data-copy-target]")[1]?.textContent === "Copied"
            );
            expect(
              await page.locator("html").getAttribute("data-copy-native"),
            ).toBe(nativeCommand);
            expect(
              await page.locator("html").getAttribute("data-copy-fallback"),
            ).toBeNull();

            await page.evaluate(() => {
              const button = document.querySelectorAll("[data-copy-target]")[1];
              if (button instanceof HTMLButtonElement) {
                button.textContent = "Copy";
                button.classList.remove("is-copied");
              }
              const status = document.querySelector("#copy-status");
              if (status !== null) status.textContent = "";
              Object.defineProperty(navigator, "clipboard", {
                configurable: true,
                value: {
                  writeText: async () => {
                    throw new Error("injected native clipboard failure");
                  },
                },
              });
              Object.defineProperty(document, "execCommand", {
                configurable: true,
                value: () => false,
              });
            });
            await nativeCopyButton.focus();
            await page.keyboard.press("Enter");
            await page.waitForFunction(() =>
              document.querySelector("#copy-status")?.textContent?.startsWith("Copy failed")
            );
            expect(await nativeCopyButton.textContent()).toBe("Copy");
            expect(await nativeCopyButton.getAttribute("class")).not.toContain(
              "is-copied",
            );
            expect(await page.locator("#copy-status").textContent()).toBe(
              "Copy failed. Select and copy the command manually.",
            );
          }
          const overflow = await page.evaluate(() => ({
            clientWidth: document.documentElement.clientWidth,
            offenders: Array.from(document.querySelectorAll("body *"))
              .filter((element) => {
                const box = element.getBoundingClientRect();
                return box.right > document.documentElement.clientWidth + 0.5 ||
                  box.left < -0.5;
              })
              .slice(0, 10)
              .map((element) => ({
                className: element.className,
                left: element.getBoundingClientRect().left,
                right: element.getBoundingClientRect().right,
                tag: element.tagName,
              })),
            scrollWidth: document.documentElement.scrollWidth,
          }));
          expect(overflow.scrollWidth, JSON.stringify({ width, ...overflow }))
            .toBe(overflow.clientWidth);
        } finally {
          await context.close();
        }
      }

      const noScript = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { height: 900, width: 320 },
      });
      try {
        const page = await noScript.newPage();
        await page.goto(reportUrl, { waitUntil: "load" });
        expect(await page.locator("[data-contract-finding]").isVisible()).toBe(true);
        expect(
          await page.getByText(
            "uiwitness scan --coordinate capture/ordered/compact/light --headed",
            { exact: true },
          ).isVisible(),
        ).toBe(true);
        expect(await page.getByRole("button", { name: "Copy" }).count()).toBe(0);
      } finally {
        await noScript.close();
      }
    } finally {
      Reflect.deleteProperty(globalThis, eventKey);
      await browser.close();
      await project.cleanup();
    }
  }, 30_000);

  it("filters thousands of contract findings without reordering or truncating them", async () => {
    const project = await temporaryProject();
    const browser = await chromium.launch({ headless: true });
    const eventKey = Symbol.for("uiwitness.test.capture-events");
    Reflect.set(globalThis, eventKey, []);
    try {
      const verdictContents = largeContractVerdictContents();
      const run = await runPersistedScenarioCells(persistenceCells(["ordered"]), {
        baseURL,
        finalizeGeneration: () => ({
          artifacts: [{
            contents: verdictContents,
            path: ".uiwitness/contract-verdict.json",
            publication: "replace",
            role: "contract-verdict",
          }],
          runDigest: contractDigest,
          toolVersion: "0.0.0-test",
        }),
        generatedAt: new Date("2026-09-04T12:00:00.000Z"),
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });
      const reportUrl = pathToFileURL(
        join(project.path, ...run.htmlReportPath.split("/")),
      ).href;
      const page = await browser.newPage({ viewport: { height: 900, width: 1_440 } });
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(reportUrl, { waitUntil: "load" });

      const findingLocator = page.locator("[data-contract-finding]");
      const visibleFindings = page.locator("[data-contract-finding]:visible");
      const initialCoordinates = await findingLocator.evaluateAll((items) =>
        items.map((item) => (item as HTMLElement).dataset["contractCoordinate"])
      );
      expect(initialCoordinates).toHaveLength(2_000);
      expect(initialCoordinates[0]).toBe("bulk/row-0000/desktop/light");
      expect(initialCoordinates.at(-1)).toBe("bulk/row-1999/desktop/light");

      const elapsed = await page.evaluate(async () => {
        const input = document.querySelector('input[name="finding-query"]');
        if (!(input instanceof HTMLInputElement)) return Number.POSITIVE_INFINITY;
        const started = performance.now();
        input.focus();
        input.value = "row-1998";
        input.dispatchEvent(new InputEvent("input", { bubbles: true }));
        await new Promise<void>((resolve) => requestAnimationFrame(() =>
          requestAnimationFrame(() => resolve())
        ));
        return performance.now() - started;
      });
      expect(elapsed).toBeLessThan(5_000);
      expect(await visibleFindings.count()).toBe(1);
      expect(await page.locator("#finding-filter-results").textContent()).toBe(
        "Showing 1 of 2000 findings.",
      );
      expect(new URL(page.url()).searchParams.get("finding-query")).toBe("row-1998");

      await page.locator('select[name="finding-kind"]').selectOption("regression");
      expect(await visibleFindings.count()).toBe(1);
      expect(new URL(page.url()).searchParams.get("finding-kind")).toBe("regression");
      await page.reload({ waitUntil: "load" });
      expect(await page.locator('input[name="finding-query"]').inputValue()).toBe(
        "row-1998",
      );
      expect(await page.locator('select[name="finding-kind"]').inputValue()).toBe(
        "regression",
      );
      expect(await visibleFindings.count()).toBe(1);

      const targetId = await visibleFindings.getAttribute("id");
      await page.locator('select[name="finding-kind"]').selectOption(
        "unaccepted-addition",
      );
      expect(await visibleFindings.count()).toBe(0);
      const filteredDeepLink = new URL(reportUrl);
      filteredDeepLink.searchParams.set("finding-kind", "unaccepted-addition");
      filteredDeepLink.searchParams.set("finding-query", "row-1998");
      filteredDeepLink.hash = targetId ?? "";
      const deepLinkPage = await browser.newPage({
        viewport: { height: 900, width: 1_440 },
      });
      try {
        await deepLinkPage.goto(filteredDeepLink.href, { waitUntil: "load" });
        expect(
          await deepLinkPage.locator('input[name="finding-query"]').inputValue(),
        ).toBe("row-1998");
        expect(
          await deepLinkPage.locator('select[name="finding-kind"]').inputValue(),
        ).toBe("unaccepted-addition");
        expect(
          await deepLinkPage.locator("[data-contract-finding]:visible").count(),
        ).toBe(1);
        expect(new URL(deepLinkPage.url()).hash).toBe(`#${targetId}`);
      } finally {
        await deepLinkPage.close();
      }

      await page.getByRole("button", { name: "Reset finding filters" }).focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => visibleFindings.count()).toBe(2_000);
      await page.locator('input[name="finding-query"]').focus();
      await page.keyboard.type("row-0001");
      await expect.poll(() => visibleFindings.count()).toBe(1);
      await page.getByRole("button", { name: "Reset finding filters" }).focus();
      await page.keyboard.press("Enter");
      await expect.poll(() => visibleFindings.count()).toBe(2_000);
      expect(
        await findingLocator.evaluateAll((items) =>
          items.map((item) => (item as HTMLElement).dataset["contractCoordinate"])
        ),
      ).toEqual(initialCoordinates);

      const mobile = await browser.newContext({ viewport: { height: 900, width: 320 } });
      try {
        const mobilePage = await mobile.newPage();
        await mobilePage.goto(reportUrl, { waitUntil: "load" });
        const controlsFit = await mobilePage
          .locator("#finding-filters input, #finding-filters select, #finding-filters button")
          .evaluateAll((controls) => controls.every((control) => {
            const box = control.getBoundingClientRect();
            return box.height >= 44 && box.left >= 0 && box.right <= 320;
          }));
        expect(controlsFit).toBe(true);
        const mobileOverflow = await mobilePage.evaluate(() => ({
          clientWidth: document.documentElement.clientWidth,
          offenders: Array.from(document.querySelectorAll("body *"))
            .filter((element) => {
              const box = element.getBoundingClientRect();
              return box.left < -0.5 || box.right > document.documentElement.clientWidth + 0.5;
            })
            .slice(0, 10)
            .map((element) => ({
              className: element.className,
              left: element.getBoundingClientRect().left,
              right: element.getBoundingClientRect().right,
              tag: element.tagName,
            })),
          scrollWidth: document.documentElement.scrollWidth,
        }));
        expect(mobileOverflow.scrollWidth, JSON.stringify(mobileOverflow)).toBe(
          mobileOverflow.clientWidth,
        );
      } finally {
        await mobile.close();
      }

      const noScript = await browser.newContext({
        javaScriptEnabled: false,
        viewport: { height: 900, width: 320 },
      });
      try {
        const noScriptPage = await noScript.newPage();
        await noScriptPage.goto(reportUrl, { waitUntil: "load" });
        expect(await noScriptPage.locator("#finding-filters").isVisible()).toBe(false);
        expect(
          await noScriptPage.locator("[data-contract-finding]:visible").count(),
        ).toBe(2_000);
      } finally {
        await noScript.close();
      }
      expect(pageErrors).toEqual([]);
    } finally {
      Reflect.deleteProperty(globalThis, eventKey);
      await browser.close();
      await project.cleanup();
    }
  }, 30_000);

  it("filters identifiers named all without treating them as wildcards", async () => {
    const project = await temporaryProject();
    const browser = await chromium.launch({ headless: true });
    const eventKey = Symbol.for("uiwitness.test.capture-events");
    Reflect.set(globalThis, eventKey, []);
    try {
      const run = await runPersistedScenarioCells(allIdentifierCells(), {
        baseURL,
        generatedAt: new Date("2026-08-20T15:00:45.000Z"),
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });
      const reportUrl = pathToFileURL(
        join(project.path, ...run.htmlReportPath.split("/")),
      ).href;
      const page = await browser.newPage();
      await page.goto(reportUrl, { waitUntil: "load" });

      expect(
        await page
          .locator('select[name="route"] option')
          .evaluateAll((options) => options.map((option) => (option as HTMLOptionElement).value)),
      ).toEqual(["", "zeta", "all"]);
      await page.locator('select[name="route"]').selectOption("all");
      await page.locator('select[name="state"]').selectOption("all");
      await page.locator('select[name="viewport"]').selectOption("all");
      await page.locator('select[name="theme"]').selectOption("all");
      expect(await page.locator("[data-detail-target]:visible").count()).toBe(1);
      expect(await page.locator("#filter-results").textContent()).toBe(
        "Showing 1 of 8 executions across 1 matrix row.",
      );
    } finally {
      Reflect.deleteProperty(globalThis, eventKey);
      await browser.close();
      await project.cleanup();
    }
  }, 30_000);

  it("runs the empty-report script guard without a filter form", async () => {
    const project = await temporaryProject();
    const browser = await chromium.launch({ headless: true });
    try {
      const run = await runPersistedScenarioCells([], {
        baseURL,
        generatedAt: new Date("2026-08-20T15:00:50.000Z"),
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });
      const reportUrl = pathToFileURL(
        join(project.path, ...run.htmlReportPath.split("/")),
      ).href;
      const page = await browser.newPage();
      const pageErrors: string[] = [];
      page.on("pageerror", (error) => pageErrors.push(error.message));
      await page.goto(reportUrl, { waitUntil: "load" });

      expect(await page.locator("#report-filters").count()).toBe(0);
      expect(await page.getByText("No executions were selected for this report.").isVisible()).toBe(
        true,
      );
      expect(pageErrors).toEqual([]);
    } finally {
      await browser.close();
      await project.cleanup();
    }
  }, 30_000);

  it("replaces stale artifacts, JSON, and HTML as one report set", async () => {
    const project = await temporaryProject();
    const uiwitnessRoot = join(project.path, ".uiwitness");
    const artifactsRoot = join(uiwitnessRoot, "artifacts");
    const reportRoot = join(uiwitnessRoot, "report");

    try {
      await mkdir(join(artifactsRoot, "stale"), { recursive: true });
      await mkdir(reportRoot, { recursive: true });
      if (process.platform !== "win32") {
        await chmod(uiwitnessRoot, 0o755);
        await chmod(reportRoot, 0o755);
      }
      await writeFile(join(artifactsRoot, "stale/old.png"), "old");
      await writeFile(join(reportRoot, "uiwitness.json"), "stale");
      await writeFile(join(reportRoot, "index.html"), "stale report UI");

      const run = await runPersistedScenarioCells([], {
        baseURL,
        generatedAt: new Date("2026-08-20T15:01:00.000Z"),
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });

      expect(run.report.executions).toEqual([]);
      expect(await readdir(artifactsRoot)).toEqual([]);
      expect(await readFile(join(reportRoot, "index.html"), "utf8")).toContain(
        "UI State Coverage Report",
      );
      expect((await readdir(uiwitnessRoot)).sort()).toEqual([
        "artifacts",
        "generation.json",
        "generations",
        "report",
      ]);
      expect((await readdir(reportRoot)).sort()).toEqual([
        "evidence-manifest.json",
        "index.html",
        "uiwitness.json",
      ]);
      if (process.platform !== "win32") {
        expect((await stat(uiwitnessRoot)).mode & 0o777).toBe(0o700);
        expect((await stat(reportRoot)).mode & 0o777).toBe(0o700);
      }
    } finally {
      await project.cleanup();
    }
  });

  it.skipIf(process.platform === "win32")(
    "publishes beside an unreadable legacy evidence tree without touching it",
    async () => {
      const project = await temporaryProject();
      const legacyRoot = join(project.path, ".statecraft");
      const legacyArtifact = join(
        legacyRoot,
        "artifacts/dashboard/success/desktop-light.png",
      );
      const legacyReport = join(legacyRoot, "report/statecraft.json");
      const artifactBytes = Uint8Array.of(137, 80, 78, 71, 13, 10, 26, 10);
      const reportBytes = '{"schemaVersion":1,"legacy":true}\n';

      try {
        await mkdir(join(legacyRoot, "artifacts/dashboard/success"), {
          recursive: true,
        });
        await mkdir(join(legacyRoot, "report"), { recursive: true });
        await writeFile(legacyArtifact, artifactBytes);
        await writeFile(legacyReport, reportBytes);
        await chmod(legacyRoot, 0o000);

        const run = await runPersistedScenarioCells([], {
          baseURL,
          generatedAt: new Date("2026-08-20T15:01:30.000Z"),
          projectDirectory: project.path,
          scenarioBaseDirectory,
        });

        expect(run.reportPath).toBe(".uiwitness/report/uiwitness.json");
        await expect(
          access(join(project.path, ".uiwitness/report/index.html")),
        ).resolves.toBeUndefined();
      } finally {
        await chmod(legacyRoot, 0o700).catch(() => undefined);
      }

      try {
        await expect(readFile(legacyArtifact)).resolves.toEqual(
          Buffer.from(artifactBytes),
        );
        await expect(readFile(legacyReport, "utf8")).resolves.toBe(reportBytes);
        expect((await readdir(project.path)).sort()).toEqual([
          ".statecraft",
          ".uiwitness",
        ]);
      } finally {
        await project.cleanup();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symbolic-link artifact roots without writing outside the project",
    async () => {
      const project = await temporaryProject();
      const outside = await temporaryProject();
      const uiwitnessRoot = join(project.path, ".uiwitness");

      try {
        await mkdir(uiwitnessRoot);
        await writeFile(join(outside.path, "marker"), "unchanged");
        await symlink(outside.path, join(uiwitnessRoot, "artifacts"));

        await expect(
          runPersistedScenarioCells([], {
            baseURL,
            projectDirectory: project.path,
            scenarioBaseDirectory,
          }),
        ).rejects.toThrow(
          ".uiwitness/artifacts must be a real directory, not a symbolic link.",
        );
        expect(await readFile(join(outside.path, "marker"), "utf8")).toBe(
          "unchanged",
        );
        await expectMissing(join(outside.path, "uiwitness.json"));
      } finally {
        await project.cleanup();
        await outside.cleanup();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symbolic-link report targets without modifying their destination",
    async () => {
      const project = await temporaryProject();
      const outside = await temporaryProject();
      const reportRoot = join(project.path, ".uiwitness/report");
      const outsideReport = join(outside.path, "uiwitness.json");

      try {
        await mkdir(reportRoot, { recursive: true });
        await writeFile(outsideReport, "outside report");
        await symlink(outsideReport, join(reportRoot, "uiwitness.json"));

        await expect(
          runPersistedScenarioCells([], {
            baseURL,
            projectDirectory: project.path,
            scenarioBaseDirectory,
          }),
        ).rejects.toThrow(
          ".uiwitness/report/uiwitness.json must be a regular file, not a symbolic link.",
        );
        expect(await readFile(outsideReport, "utf8")).toBe("outside report");
        await expectMissing(
          join(project.path, ".uiwitness/.runner-persistence-lock"),
        );
      } finally {
        await project.cleanup();
        await outside.cleanup();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symbolic-link HTML targets without modifying their destination",
    async () => {
      const project = await temporaryProject();
      const outside = await temporaryProject();
      const reportRoot = join(project.path, ".uiwitness/report");
      const outsideHtml = join(outside.path, "index.html");

      try {
        await mkdir(reportRoot, { recursive: true });
        await writeFile(outsideHtml, "outside HTML");
        await symlink(outsideHtml, join(reportRoot, "index.html"));

        await expect(
          runPersistedScenarioCells([], {
            baseURL,
            projectDirectory: project.path,
            scenarioBaseDirectory,
          }),
        ).rejects.toThrow(
          ".uiwitness/report/index.html must be a regular file, not a symbolic link.",
        );
        expect(await readFile(outsideHtml, "utf8")).toBe("outside HTML");
        await expectMissing(
          join(project.path, ".uiwitness/.runner-persistence-lock"),
        );
      } finally {
        await project.cleanup();
        await outside.cleanup();
      }
    },
  );

  it.skipIf(process.platform === "win32")(
    "rejects symbolic-link report directories without writing through them",
    async () => {
      const project = await temporaryProject();
      const outside = await temporaryProject();
      const uiwitnessRoot = join(project.path, ".uiwitness");
      const marker = join(outside.path, "marker");

      try {
        await mkdir(uiwitnessRoot);
        await writeFile(marker, "unchanged");
        await symlink(outside.path, join(uiwitnessRoot, "report"));

        await expect(
          runPersistedScenarioCells([], {
            baseURL,
            projectDirectory: project.path,
            scenarioBaseDirectory,
          }),
        ).rejects.toThrow(
          "report must be a real directory, not a symbolic link.",
        );
        expect(await readFile(marker, "utf8")).toBe("unchanged");
        await expectMissing(join(outside.path, "uiwitness.json"));
      } finally {
        await project.cleanup();
        await outside.cleanup();
      }
    },
  );

  it("does not remove a lock owned by another persistence run", async () => {
    const project = await temporaryProject();
    const lock = join(
      project.path,
      ".uiwitness/.runner-persistence-lock",
    );

    try {
      await mkdir(lock, { recursive: true });
      await writeFile(
        join(lock, "owner.json"),
        `${JSON.stringify({
          phase: "capture",
          pid: process.pid,
          schemaVersion: 1,
          token: "other-live-run",
        })}\n`,
      );
      await expect(
        runPersistedScenarioCells(persistenceCells(["clean-after"]), {
          baseURL,
          launchOptions: {
            executablePath: join(project.path, "missing-chromium"),
          },
          projectDirectory: project.path,
          scenarioBaseDirectory,
        }),
      ).rejects.toThrow("Another result-persistence run is active");
      expect((await stat(lock)).isDirectory()).toBe(true);
    } finally {
      await chmod(lock, 0o700).catch(() => undefined);
      await project.cleanup();
    }
  });

  it("refuses to release a lock after its durable owner token changes", async () => {
    const project = await temporaryProject();

    try {
      const lock = await acquirePersistenceLock(project.path);
      await writeFile(
        join(lock.directory, "owner.json"),
        `${JSON.stringify({
          pid: process.pid,
          schemaVersion: 1,
          token: "replacement-owner",
        })}\n`,
      );

      await expect(releasePersistenceLock(lock)).rejects.toThrow(
        "Result-persistence lock ownership changed before cleanup.",
      );
      expect((await stat(lock.directory)).isDirectory()).toBe(true);
    } finally {
      await project.cleanup();
    }
  });

  it("recovers an abandoned capture-phase lock before running", async () => {
    const project = await temporaryProject();
    const lock = join(project.path, ".uiwitness/.runner-persistence-lock");

    try {
      await mkdir(lock, { recursive: true });
      await mkdir(
        join(project.path, ".uiwitness/.runner-persistence-stage-abandoned"),
      );
      await writeFile(
        join(lock, "owner.json"),
        `${JSON.stringify({
          phase: "capture",
          pid: 2_147_483_647,
          schemaVersion: 1,
          token: "abandoned-run",
        })}\n`,
      );

      const run = await runPersistedScenarioCells([], {
        baseURL,
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });
      expect(run.report.executions).toEqual([]);
      await expectMissing(lock);
      await expectMissing(
        join(project.path, ".uiwitness/.runner-persistence-stage-abandoned"),
      );
      expect(
        (await readdir(join(project.path, ".uiwitness"))).some((entry) =>
          entry.startsWith(".runner-persistence-lock.claimed-"),
        ),
      ).toBe(false);
    } finally {
      await project.cleanup();
    }
  });

  it.each(["publishing", "recovery"] as const)(
    "preserves abandoned %s-phase recovery state",
    async (phase) => {
      const project = await temporaryProject();
      const lock = join(project.path, ".uiwitness/.runner-persistence-lock");

      try {
        await mkdir(lock, { recursive: true });
        await writeFile(
          join(lock, "owner.json"),
          `${JSON.stringify({
            pid: 2_147_483_647,
            schemaVersion: 1,
            token: `abandoned-${phase}-run`,
          })}\n`,
        );
        await writeFile(join(lock, phase), `${phase}\n`);

        await expect(
          runPersistedScenarioCells([], {
            baseURL,
            launchOptions: {
              executablePath: join(project.path, "missing-chromium"),
            },
            projectDirectory: project.path,
            scenarioBaseDirectory,
          }),
        ).rejects.toThrow(
          ".uiwitness contains recovery state from an interrupted result-persistence run.",
        );
        expect((await stat(lock)).isDirectory()).toBe(true);
        const preservedPhase = phase === "publishing" ? "recovery" : phase;
        expect(await readFile(join(lock, preservedPhase), "utf8")).toBe(
          `${preservedPhase}\n`,
        );
      } finally {
        await project.cleanup();
      }
    },
  );

  it("allows only one concurrent recovery claimant for an abandoned lock", async () => {
    const project = await temporaryProject();
    const lock = join(project.path, ".uiwitness/.runner-persistence-lock");

    try {
      await mkdir(lock, { recursive: true });
      await writeFile(
        join(lock, "owner.json"),
        `${JSON.stringify({
          pid: 2_147_483_647,
          schemaVersion: 1,
          token: "shared-abandoned-run",
        })}\n`,
      );

      const attempts = await Promise.allSettled([
        acquirePersistenceLock(project.path),
        acquirePersistenceLock(project.path),
      ]);
      expect(attempts.map(({ status }) => status).sort()).toEqual([
        "fulfilled",
        "rejected",
      ]);
      const acquired = attempts.find(
        (attempt): attempt is PromiseFulfilledResult<
          Awaited<ReturnType<typeof acquirePersistenceLock>>
        > => attempt.status === "fulfilled",
      );
      expect(acquired).toBeDefined();
      expect(
        JSON.parse(await readFile(join(lock, "owner.json"), "utf8")),
      ).toMatchObject({ token: acquired?.value.token });
    } finally {
      await project.cleanup();
    }
  });

  it("derives one permanent takeover claim for each observed stale owner", () => {
    const lock = "/project/.uiwitness/.runner-persistence-lock";
    const first = takeoverClaimPath(lock, "observed-owner");

    expect(takeoverClaimPath(lock, "observed-owner")).toBe(first);
    expect(takeoverClaimPath(lock, "newer-owner")).not.toBe(first);
    expect(first).toMatch(
      /^\/project\/\.uiwitness\/\.runner-persistence-lock\.claimed-[a-f0-9]{64}$/,
    );
  });

  it("normalizes unexpected lifecycle failures into sanitized core results", () => {
    const cell = persistenceCells(["clean-after"])[0]!;
    const outcome = Object.freeze({
      cell,
      reason: Object.create(null),
      status: "rejected" as const,
    });

    expect(executionArtifactForOutcome(outcome, baseURL)).toEqual({
      masks: [],
      result: expect.objectContaining({
        diagnostics: {
          consoleErrors: [],
          failedRequests: [],
          navigationStatus: null,
          pageErrors: [],
        },
        durationMs: 0,
        failures: [
          { code: "INTERNAL_ERROR", message: "[unprintable thrown value]" },
        ],
        screenshotPath: null,
        status: "failed",
        url: "https://uiwitness.invalid/capture?source=%5BREDACTED%5D",
      }),
      screenshot: null,
      screenshotAttempted: false,
      screenshotStatus: "capture-failed",
    });
    expect(executionArtifactForOutcome(
      outcome,
      baseURL,
      { retention: "none" },
    )).toMatchObject({
      result: {
        failures: [
          { code: "INTERNAL_ERROR", message: "[unprintable thrown value]" },
        ],
        status: "failed",
      },
      screenshot: null,
      screenshotAttempted: false,
      screenshotStatus: "omitted-by-policy",
    });
  });

  it("restores artifacts before making the previous JSON and HTML visible", async () => {
    const calls: string[] = [];
    const errors = await recoverPublication(
      {
        existingArtifacts: "existing-artifacts",
        existingHtml: "existing-html",
        existingReport: "existing-report",
        previousArtifacts: "previous-artifacts",
        previousHtml: "previous-html",
        previousReport: "previous-report",
      },
      {
        movedPreviousArtifacts: true,
        movedPreviousHtml: true,
        movedPreviousReport: true,
        publishedArtifacts: true,
        publishedHtml: true,
        publishedReport: true,
      },
      {
        remove: async (path) => {
          calls.push(`remove:${path}`);
        },
        rename: async (source, destination) => {
          calls.push(`rename:${source}:${destination}`);
        },
      },
    );

    expect(calls).toEqual([
      "remove:existing-html",
      "remove:existing-report",
      "remove:existing-artifacts",
      "rename:previous-artifacts:existing-artifacts",
      "rename:previous-report:existing-report",
      "rename:previous-html:existing-html",
    ]);
    expect(errors).toEqual([]);
  });

  it("keeps the previous report hidden when artifact recovery fails", async () => {
    const calls: string[] = [];
    const removalFailure = new Error("artifact removal failed");
    const errors = await recoverPublication(
      {
        existingArtifacts: "existing-artifacts",
        existingHtml: "existing-html",
        existingReport: "existing-report",
        previousArtifacts: "previous-artifacts",
        previousHtml: "previous-html",
        previousReport: "previous-report",
      },
      {
        movedPreviousArtifacts: true,
        movedPreviousHtml: true,
        movedPreviousReport: true,
        publishedArtifacts: true,
        publishedHtml: true,
        publishedReport: true,
      },
      {
        remove: async (path) => {
          calls.push(`remove:${path}`);
          if (path === "existing-artifacts") {
            throw removalFailure;
          }
        },
        rename: async (source, destination) => {
          calls.push(`rename:${source}:${destination}`);
        },
      },
    );

    expect(calls).toEqual([
      "remove:existing-html",
      "remove:existing-report",
      "remove:existing-artifacts",
    ]);
    expect(errors).toEqual([removalFailure]);
  });

  it("preserves staging data and the lock when publication recovery fails", async () => {
    const project = await temporaryProject();
    try {
      const initial = await runPersistedScenarioCells([], {
        baseURL,
        generatedAt: new Date("2026-08-20T15:02:00.000Z"),
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });
      const lock = await acquirePersistenceLock(project.path);
      const publishFailure = new Error("report publication failed");
      const recoveryFailure = new Error("artifact recovery failed");
      let renameCalls = 0;

      await expect(
        persistReport(project.path, lock, initial.report, [], {
          remove: rm,
          rename: async (source, destination) => {
            renameCalls += 1;
            if (renameCalls === 4) {
              throw publishFailure;
            }
            if (renameCalls === 5) {
              throw recoveryFailure;
            }
            await fsRename(source, destination);
          },
        }),
      ).rejects.toMatchObject({
        cause: publishFailure,
        errors: [recoveryFailure],
      });

      expect(lock.preserve).toBe(true);
      expect(await readFile(join(lock.directory, "recovery"), "utf8")).toBe(
        "recovery\n",
      );
      const recoveryDirectory = (await readdir(
        join(project.path, ".uiwitness"),
      )).find(
        (entry) =>
          entry !== ".runner-persistence-lock" &&
          entry.startsWith(".runner-persistence-stage-"),
      );
      expect(recoveryDirectory).toBeDefined();
      expect(
        await readFile(
          join(
            project.path,
            ".uiwitness",
            recoveryDirectory ?? "missing",
            "previous-uiwitness.json",
          ),
          "utf8",
        ),
      ).toBe(serializeReport(initial.report));
      await expectMissing(
        join(project.path, ".uiwitness/report/uiwitness.json"),
      );
    } finally {
      await project.cleanup();
    }
  });

  it("restores the previous PNG, JSON, and HTML when final HTML publication fails", async () => {
    const project = await temporaryProject();
    let lock: Awaited<ReturnType<typeof acquirePersistenceLock>> | undefined;
    try {
      const initialCells = persistenceCells(["clean-after"]);
      const initial = await runPersistedScenarioCells(initialCells, {
        baseURL,
        generatedAt: new Date("2026-08-20T15:02:30.000Z"),
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });
      const initialScreenshotPath = initial.report.executions[0]!.screenshotPath!;
      const initialScreenshot = await readFile(
        join(project.path, ...initialScreenshotPath.split("/")),
      );
      const initialEvidenceManifest = await readFile(
        join(project.path, ...EVIDENCE_MANIFEST_PATH.split("/")),
        "utf8",
      );
      const nextCell = persistenceCells(["replacement"])[0]!;
      const nextScreenshotPath = screenshotArtifactPath(nextCell);
      const nextExecution = parseExecutionResult({
        ...initial.report.executions[0]!,
        screenshotPath: nextScreenshotPath,
        stateId: nextCell.state.id,
      });
      const next = parseReport({
        ...initial.report,
        executions: [nextExecution],
        generatedAt: "2026-08-20T15:02:31.000Z",
      });
      lock = await acquirePersistenceLock(project.path);
      let rejectedHtml = false;

      await expect(
        persistReport(
          project.path,
          lock,
          next,
          [{ result: nextExecution, screenshot: Uint8Array.of(1, 2, 3) }],
          {
            remove: rm,
            rename: async (source, destination) => {
              if (
                !rejectedHtml &&
                String(source).includes(".runner-persistence-stage-") &&
                String(source).endsWith("index.html")
              ) {
                rejectedHtml = true;
                throw new Error("HTML publication failed");
              }
              await fsRename(source, destination);
            },
          },
        ),
      ).rejects.toThrow("HTML publication failed");

      expect(
        parseReport(
          JSON.parse(
            await readFile(
              join(project.path, ".uiwitness/report/uiwitness.json"),
              "utf8",
            ),
          ),
        ),
      ).toEqual(initial.report);
      const html = await readFile(
        join(project.path, ".uiwitness/report/index.html"),
        "utf8",
      );
      expect(html).toContain("2026-08-20T15:02:30.000Z");
      expect(html).not.toContain("2026-08-20T15:02:31.000Z");
      await expect(
        readFile(join(project.path, ...initialScreenshotPath.split("/"))),
      ).resolves.toEqual(initialScreenshot);
      await expectMissing(join(project.path, ...nextScreenshotPath.split("/")));
      const restoredEvidenceManifest = await readFile(
        join(project.path, ...EVIDENCE_MANIFEST_PATH.split("/")),
        "utf8",
      );
      expect(restoredEvidenceManifest).toBe(initialEvidenceManifest);
      const parsedEvidenceManifest = parseEvidenceManifest(restoredEvidenceManifest);
      expect(parsedEvidenceManifest.reportDigest).toBe(
        `sha256:${createHash("sha256")
          .update(serializeReport(initial.report))
          .digest("hex")}`,
      );
      expect(lock.preserve).toBe(false);
    } finally {
      if (lock !== undefined) {
        await releasePersistenceLock(lock).catch(() => undefined);
      }
      await project.cleanup();
    }
  });

  it("preserves committed cleanup state when published staging cleanup fails", async () => {
    const project = await temporaryProject();
    try {
      const initial = await runPersistedScenarioCells([], {
        baseURL,
        generatedAt: new Date("2026-08-20T15:03:00.000Z"),
        projectDirectory: project.path,
        scenarioBaseDirectory,
      });
      const lock = await acquirePersistenceLock(project.path);
      const cleanupFailure = new Error("staging cleanup failed");

      await expect(
        persistReport(
          project.path,
          lock,
          initial.report,
          [],
          {
            remove: async (path, options) => {
              if (
                options?.recursive === true &&
                String(path).includes(".runner-persistence-stage-")
              ) {
                throw cleanupFailure;
              }
              await rm(path, options);
            },
            rename: fsRename,
          },
        ),
      ).rejects.toMatchObject({ errors: [cleanupFailure] });

      expect(lock.preserve).toBe(true);
      expect(await readFile(join(lock.directory, "committed"), "utf8")).toBe(
        "committed\n",
      );
      expect(
        (await readdir(join(project.path, ".uiwitness"))).some((entry) =>
          entry.startsWith(".runner-persistence-stage-"),
        ),
      ).toBe(true);
      expect(
        parseReport(
          JSON.parse(
            await readFile(
              join(project.path, ".uiwitness/report/uiwitness.json"),
              "utf8",
            ),
          ),
        ),
      ).toEqual(initial.report);
    } finally {
      await project.cleanup();
    }
  });

  it("rejects malformed matrix cells before launching a browser", async () => {
    const project = await temporaryProject();
    try {
      const validCell = persistenceCells(["clean-after"])[0]!;
      const invalidCell: MatrixCell = {
        ...validCell,
        route: { ...validCell.route, path: "//outside.invalid/capture" },
      };
      await expect(
        runPersistedScenarioCells([invalidCell], {
          baseURL,
          projectDirectory: project.path,
          scenarioBaseDirectory,
        }),
      ).rejects.toThrow("Invalid UIWitness execution result.");
      await expectMissing(join(project.path, ".uiwitness"));
    } finally {
      await project.cleanup();
    }
  });

  it("rejects conflicting matrix coordinates before launching a browser", async () => {
    const project = await temporaryProject();
    try {
      const cell = persistenceCells(["clean-after"])[0]!;
      await expect(
        runPersistedScenarioCells([cell, cell], {
          baseURL,
          projectDirectory: project.path,
          scenarioBaseDirectory,
        }),
      ).rejects.toThrow("Invalid UIWitness report.");
      await expectMissing(join(project.path, ".uiwitness"));
    } finally {
      await project.cleanup();
    }
  });

  it("rejects missing and non-directory project roots before writing", async () => {
    const project = await temporaryProject();
    const file = join(project.path, "not-a-directory");
    const missing = join(project.path, "missing");
    try {
      await writeFile(file, "file");
      await expect(
        runPersistedScenarioCells([], {
          baseURL,
          projectDirectory: file,
          scenarioBaseDirectory,
        }),
      ).rejects.toThrow(
        "projectDirectory must refer to an existing directory.",
      );
      await expect(
        runPersistedScenarioCells([], {
          baseURL,
          projectDirectory: missing,
          scenarioBaseDirectory,
        }),
      ).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await project.cleanup();
    }
  });

  it("rejects invalid deterministic timestamps before launching a browser", async () => {
    const project = await temporaryProject();
    try {
      const invalidDate = new Date(Number.NaN);
      await expect(
        runPersistedScenarioCells(persistenceCells(["clean-after"]), {
          baseURL,
          generatedAt: invalidDate,
          projectDirectory: project.path,
          scenarioBaseDirectory,
        }),
      ).rejects.toThrow(RangeError);
      await expectMissing(join(project.path, ".uiwitness"));
    } finally {
      await project.cleanup();
    }
  });
});
