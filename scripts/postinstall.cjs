"use strict";

const path = require("node:path");
const { pathExists, requireFile, assertPackagedRuntime, runNpm } = require("./package-assets.cjs");

const root = path.resolve(__dirname, "..");

try {
  const sourceLayout = ["src", "frontend", "tsconfig.json"].some((entry) =>
    pathExists(path.join(root, entry)),
  );
  if (sourceLayout) {
    for (const entry of [
      "src/index.ts",
      "tsconfig.json",
      "frontend/package.json",
      "frontend/package-lock.json",
    ]) {
      requireFile(root, entry);
    }
    runNpm(root, ["--prefix", path.join(root, "frontend"), "ci", "--no-audit", "--no-fund"]);
  } else {
    assertPackagedRuntime(root);
    console.log("Quack Harness: using the packaged CLI and monitor assets.");
  }
} catch (error) {
  console.error(`Quack Harness installation failed: ${error.message}`);
  process.exitCode = Number.isInteger(error.exitCode) && error.exitCode > 0 ? error.exitCode : 1;
}
