// ─── Build Info ────────────────────────────────────────────────────
// Reads dist/build-info.json generated at build time.
// Contains version, git commit SHA, branch, and build timestamp.

import * as fs from "node:fs";
import * as path from "node:path";

export interface BuildInfo {
  version: string;
  commit: string;
  branch: string;
  builtAt: string;
}

let cached: BuildInfo | null = null;

export function getBuildInfo(): BuildInfo {
  if (cached) return cached;

  try {
    // dist/build-info.json is sibling to dist/core/build-info.js
    const infoPath = path.resolve(__dirname, "..", "build-info.json");
    const raw = fs.readFileSync(infoPath, "utf-8");
    cached = JSON.parse(raw) as BuildInfo;
    return cached;
  } catch {
    return {
      version: "unknown",
      commit: "unknown",
      branch: "unknown",
      builtAt: "unknown",
    };
  }
}
