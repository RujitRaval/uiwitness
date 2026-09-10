import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

function atLeast(actual, minimum) {
  assert.match(actual, /^\d+\.\d+\.\d+$/u);
  const parts = actual.split(".").map(Number);
  const floor = minimum.split(".").map(Number);
  for (let index = 0; index < floor.length; index += 1) {
    if (parts[index] !== floor[index]) return parts[index] > floor[index];
  }
  return true;
}

test("every locked sharp binary includes the GHSA-rgj7-g3m4-5g8c fix", async () => {
  // This suite also runs in the dependency-free documentation CI job.
  const lock = await readFile(new URL("../pnpm-lock.yaml", import.meta.url), "utf8");
  const packages = [...lock.matchAll(/^ {2}'?(sharp|@img\/sharp-[a-z0-9-]+)@(\d+\.\d+\.\d+)'?:$/gmu)];
  assert.ok(packages.some(([, name]) => name === "sharp"), "Expected the Next.js sharp dependency");
  assert.ok(packages.some(([, name]) => name.startsWith("@img/sharp-libvips-")), "Expected prebuilt libvips");
  for (const [, name, version] of packages) {
    const minimum = name.startsWith("@img/sharp-libvips-") ? "1.3.3" : "0.35.4";
    assert.ok(atLeast(version, minimum), `Vulnerable ${name}@${version}; requires >=${minimum}`);
  }
});
