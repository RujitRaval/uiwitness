import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  captureLaunchAssets,
  launchDetailSelector,
} from "../apps/example-nextjs/scripts/capture-launch-assets.mjs";

const repositoryRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

test("checked-in launch assets match the fictional-only review baseline", async () => {
  const review = await readFile(path.join(repositoryRoot, "docs", "assets", "README.md"), "utf8");
  const reviewedAssets = new Map([
    ["uiwitness-report-overview.png", "5334de21b141fc5617184f9724d680bc1369d6826fb87ca89939912fa8c1d10e"],
    ["uiwitness-failure-detail.png", "ddd9e5f3a5a509a9c9cafe719cdddec1813322b4ccd755210fe746495ab28742"],
  ]);

  for (const [filename, expectedDigest] of reviewedAssets) {
    const bytes = await readFile(path.join(repositoryRoot, "docs", "assets", filename));
    assert.equal(createHash("sha256").update(bytes).digest("hex"), expectedDigest);
    assert.ok(review.includes(`| \`${filename}\` | \`${expectedDigest}\` |`));
  }
});

test("launchDetailSelector accepts a generated execution detail id", () => {
  assert.equal(launchDetailSelector("execution-57"), "#execution-57");
});

test("launchDetailSelector rejects missing and selector-like values", () => {
  for (const value of [null, "", "#execution-57", "execution-57, body"]) {
    assert.throws(
      () => launchDetailSelector(value),
      /does not reference a valid detail view/u,
    );
  }
});

test("captureLaunchAssets captures the offline overview and approved failure", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "uiwitness-launch-assets-"),
  );
  t.after(() => rm(temporaryRoot, { force: true, recursive: true }));

  const sourceReportPath = path.join(temporaryRoot, "report", "index.html");
  const targetAssetsRoot = path.join(temporaryRoot, "assets");
  await mkdir(path.dirname(sourceReportPath), { recursive: true });
  await writeFile(sourceReportPath, "<!doctype html><title>Report</title>");

  const screenshots = [];
  const styles = [];
  const events = [];
  let routeHandler;
  const failure = {
    async click() {
      events.push("failure-clicked");
    },
    async count() {
      return 1;
    },
    async getAttribute(name) {
      assert.equal(name, "aria-controls");
      return "execution-57";
    },
  };
  const page = {
    async addStyleTag(options) {
      styles.push(options.content);
    },
    async goto(url) {
      assert.equal(url, pathToFileURL(sourceReportPath).href);
    },
    getByRole(role, options) {
      assert.equal(role, "link");
      assert.deepEqual(options, {
        exact: true,
        name: "customers long-content, mobile, light: failed",
      });
      return failure;
    },
    locator(selector) {
      assert.equal(selector, "#execution-57");
      return {
        async screenshot(options) {
          screenshots.push(options.path);
        },
      };
    },
    async route(pattern, handler) {
      assert.equal(String(pattern), "/^https?:/u");
      routeHandler = handler;
    },
    async screenshot(options) {
      screenshots.push(options.path);
    },
  };
  const browser = {
    async close() {
      events.push("browser-closed");
    },
    async newPage(options) {
      assert.deepEqual(options, {
        deviceScaleFactor: 1,
        viewport: { height: 1_000, width: 1_440 },
      });
      return page;
    },
  };
  const browserType = {
    async launch(options) {
      assert.deepEqual(options, { headless: true });
      return browser;
    },
  };

  await captureLaunchAssets({
    browserType,
    logger: { log() {} },
    sourceReportPath,
    targetAssetsRoot,
  });

  assert.equal(typeof routeHandler, "function");
  let routeAborted = false;
  routeHandler({
    abort() {
      routeAborted = true;
    },
  });
  assert.equal(routeAborted, true);
  assert.deepEqual(screenshots, [
    path.join(targetAssetsRoot, "uiwitness-report-overview.png"),
    path.join(targetAssetsRoot, "uiwitness-failure-detail.png"),
  ]);
  assert.equal(styles.length, 1);
  assert.match(styles[0], /\.filter-rail\{position:static!important\}/u);
  assert.match(styles[0], /body\.detail-open\{overflow:visible!important\}/u);
  assert.match(styles[0], /\.detail\.is-active\{position:static!important/u);
  assert.deepEqual(events, ["failure-clicked", "browser-closed"]);
});

test("captureLaunchAssets rejects a missing report before launching", async (t) => {
  const temporaryRoot = await mkdtemp(
    path.join(os.tmpdir(), "uiwitness-launch-assets-missing-"),
  );
  t.after(() => rm(temporaryRoot, { force: true, recursive: true }));

  let launched = false;
  await assert.rejects(
    captureLaunchAssets({
      browserType: {
        async launch() {
          launched = true;
        },
      },
      logger: { log() {} },
      sourceReportPath: path.join(temporaryRoot, "index.html"),
    }),
    /No example report found/u,
  );
  assert.equal(launched, false);
});
