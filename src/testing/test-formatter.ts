// ─── Test Formatter ───────────────────────────────────────────────
// Progressive disclosure formatters for test results:
// Level 1: One-line summary for judge
// Level 2: Details with new failure messages for retry agent
// Level 3: Full JSON artifact to disk

import { writeFileSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { TestSuiteResult } from "../core/types.js";

/**
 * Level 1: One-line summary suitable for the judge prompt.
 * Example: "47 tests: 45 passed, 1 new failure, 1 pre-existing"
 */
export function formatTestSummary(result: TestSuiteResult): string {
  const parts: string[] = [`${result.totalTests} tests:`];

  if (result.passed > 0) parts.push(`${result.passed} passed`);

  if (result.baseline) {
    if (result.baseline.newFailures.length > 0) {
      parts.push(`${result.baseline.newFailures.length} new failure(s)`);
    }
    if (result.baseline.preExisting.length > 0) {
      parts.push(`${result.baseline.preExisting.length} pre-existing`);
    }
    if (result.baseline.newlyFixed.length > 0) {
      parts.push(`${result.baseline.newlyFixed.length} newly fixed`);
    }
  } else if (result.failed > 0) {
    parts.push(`${result.failed} failed`);
  }

  if (result.skipped > 0) parts.push(`${result.skipped} skipped`);

  return parts.join(", ");
}

/**
 * Level 2: Details with full error messages for NEW failures only.
 * Pre-existing failures are listed by name but without error output
 * (they're not actionable by the agent).
 */
export function formatTestDetails(result: TestSuiteResult): string {
  const lines: string[] = [formatTestSummary(result), ""];

  if (result.baseline) {
    const { newFailures, preExisting, newlyFixed } = result.baseline;

    if (newFailures.length > 0) {
      lines.push("## New Failures (agent-caused — MUST fix)");
      lines.push("");
      for (const f of newFailures) {
        lines.push(`### ${f.fullName}`);
        lines.push(`Suite: ${f.suitePath}`);
        if (f.message) {
          lines.push("```");
          lines.push(f.message.length > 2000 ? f.message.slice(0, 2000) + "\n..." : f.message);
          lines.push("```");
        }
        lines.push("");
      }
    }

    if (preExisting.length > 0) {
      lines.push("## Pre-existing Failures (NOT agent-caused — ignore)");
      lines.push("");
      for (const f of preExisting) {
        lines.push(`- ${f.fullName}`);
      }
      lines.push("");
    }

    if (newlyFixed.length > 0) {
      lines.push("## Newly Fixed (were failing, now passing)");
      lines.push("");
      for (const f of newlyFixed) {
        lines.push(`- ${f.fullName}`);
      }
      lines.push("");
    }
  } else if (result.failures.length > 0) {
    lines.push("## Test Failures");
    lines.push("");
    for (const f of result.failures) {
      lines.push(`### ${f.fullName}`);
      lines.push(`Suite: ${f.suitePath}`);
      if (f.message) {
        lines.push("```");
        lines.push(f.message.length > 2000 ? f.message.slice(0, 2000) + "\n..." : f.message);
        lines.push("```");
      }
      lines.push("");
    }
  }

  return lines.join("\n");
}

/**
 * Level 3: Write the full TestSuiteResult as JSON to disk.
 */
export function writeTestArtifact(result: TestSuiteResult, filePath: string): void {
  mkdirSync(dirname(filePath), { recursive: true });
  writeFileSync(filePath, JSON.stringify(result, null, 2));
}
