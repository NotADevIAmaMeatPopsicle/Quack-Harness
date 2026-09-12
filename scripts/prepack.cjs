"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { requireFile, assertPackagedRuntime, runNpm } = require("./package-assets.cjs");

const root = path.resolve(__dirname, "..");

try {
  for (const entry of [
    "package.json",
    "src/index.ts",
    "tsconfig.json",
    "frontend/package.json",
    "frontend/package-lock.json",
  ]) {
    requireFile(root, entry);
  }
  // This fixed package-local output is regenerated from source. Never clean
  // a caller's cwd or an adapter/worktree supplied by a project.
  fs.rmSync(path.join(root, "dist"), { recursive: true, force: true });
  runNpm(root, ["run", "build"]);
  assertPackagedRuntime(root);
} catch (error) {
  console.error(`Quack Harness packaging failed: ${error.message}`);
  process.exitCode = Number.isInteger(error.exitCode) && error.exitCode > 0 ? error.exitCode : 1;
}
