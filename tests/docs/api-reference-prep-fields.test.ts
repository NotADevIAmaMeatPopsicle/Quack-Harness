// Drift detector for docs/API_REFERENCE.md ↔ src/monitor/prep-cache.ts:PrepResult.
// Catches the class of bug surfaced by ISSUES-2026-04-29 §9 (the `score` vs `depthScore`
// mismatch that made operator scripts misread passing prep results as missing).

import * as fs from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(__dirname, "..", "..");

function readApiReferencePrepSection(): string {
  const refMd = fs.readFileSync(path.join(repoRoot, "docs", "API_REFERENCE.md"), "utf-8");
  // Match the complete heading so the earlier /prep/job route cannot shadow it.
  const startMarker = "### GET /api/tasks/:id/prep";
  const startMatch = /^### GET \/api\/tasks\/:id\/prep[ \t]*\r?$/m.exec(refMd);
  if (!startMatch) {
    throw new Error(`API_REFERENCE.md is missing "${startMarker}" heading`);
  }
  const after = refMd.slice(startMatch.index + startMatch[0].length);
  const nextHeading = after.search(/\n#{2,3} /);
  return nextHeading < 0 ? after : after.slice(0, nextHeading);
}

function readPrepResultFields(): string[] {
  const src = fs.readFileSync(path.join(repoRoot, "src", "monitor", "prep-cache.ts"), "utf-8");
  // Naive but stable parse: find `interface PrepResult` ... `}` block and extract field names.
  const match = src.match(/(?:export\s+)?interface\s+PrepResult\s*\{([\s\S]*?)\}/);
  if (!match) {
    throw new Error("PrepResult interface not found in src/monitor/prep-cache.ts");
  }
  const body = match[1];
  const fields: string[] = [];
  for (const line of body.split(/\r?\n/)) {
    const m = line.match(/^\s*([a-zA-Z_][a-zA-Z0-9_]*)\??\s*:/);
    if (m) fields.push(m[1]);
  }
  return fields;
}

describe("API_REFERENCE.md PrepResult section", () => {
  it("documents the actual PrepResult fields (not stale aliases)", () => {
    const documented = readApiReferencePrepSection();
    const fields = readPrepResultFields();
    expect(fields.length).toBeGreaterThan(0);

    // Every required field must appear in the doc section.
    for (const field of fields) {
      expect(documented).toMatch(new RegExp(`\\b${field}\\b`));
    }
  });

  it("does NOT mention the stale `score` alias", () => {
    const documented = readApiReferencePrepSection();
    // The PrepResult shape uses `depthScore`, not `score` or `overallScore`.
    // We allow `gate.score` references because that's a separate PreflightResult field.
    const standaloneScoreReferences = documented
      .split(/\r?\n/)
      .filter((line) => /\bscore\b/.test(line))
      .filter((line) => !/depthScore/.test(line))
      .filter((line) => !/gate\.score/.test(line));

    expect(standaloneScoreReferences).toEqual([]);
  });

  it("explicitly mentions depthScore as the gate threshold field", () => {
    const documented = readApiReferencePrepSection();
    expect(documented).toMatch(/depthScore/);
  });
});
