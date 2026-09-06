// ─── Output Summarizer ──────────────────────────────────────────────
// Truncates and extracts relevant information from verification command output.
// Follows the Honk pattern: keep context concise to avoid blowing up agent context.

const MAX_OUTPUT_LENGTH = 2000;

/**
 * Summarize command output for agent consumption.
 *
 * On success: returns a brief message (e.g. "All 42 tests passed", "Lint clean").
 * On failure: extracts relevant error lines (failing test names, type errors, lint violations).
 * Always truncates to ~2000 chars max.
 */
export function summarizeOutput(output: string, passed: boolean): string {
  if (!output || output.trim().length === 0) {
    return passed ? "Passed (no output)" : "Failed (no output)";
  }

  if (passed) {
    return summarizeSuccess(output);
  }

  return summarizeFailure(output);
}

// ─── Success summarization ─────────────────────────────────────────

function summarizeSuccess(output: string): string {
  // Jest: look for test summary line
  const jestSummary = extractJestSummary(output);
  if (jestSummary) {
    return jestSummary;
  }

  // tsc: no errors means clean
  if (isTscOutput(output)) {
    return "Type-check clean (0 errors)";
  }

  // ESLint: no warnings/errors
  if (isEslintOutput(output)) {
    return "Lint clean";
  }

  // Generic success: return last meaningful line, truncated
  const lastLine = getLastMeaningfulLine(output);
  return truncate(lastLine || "Passed", MAX_OUTPUT_LENGTH);
}

// ─── Failure summarization ─────────────────────────────────────────

function summarizeFailure(output: string): string {
  // Jest failures: extract failing test names
  const jestFailures = extractJestFailures(output);
  if (jestFailures) {
    return truncate(jestFailures, MAX_OUTPUT_LENGTH);
  }

  // tsc errors: extract error lines
  const tscErrors = extractTscErrors(output);
  if (tscErrors) {
    return truncate(tscErrors, MAX_OUTPUT_LENGTH);
  }

  // ESLint violations: extract violation lines
  const eslintErrors = extractEslintErrors(output);
  if (eslintErrors) {
    return truncate(eslintErrors, MAX_OUTPUT_LENGTH);
  }

  // Generic failure: return truncated output
  return truncate(output.trim(), MAX_OUTPUT_LENGTH);
}

// ─── Jest extraction ───────────────────────────────────────────────

function extractJestSummary(output: string): string | null {
  // Match "Tests: N passed, N total" or "Test Suites: N passed, N total"
  const testsLine = output.match(/Tests:\s+(\d+\s+passed(?:,\s+\d+\s+total)?)/);
  if (testsLine) {
    return `All ${testsLine[1]}`;
  }

  // Match "X passed" standalone
  const passedMatch = output.match(/(\d+)\s+(?:tests?\s+)?passed/i);
  if (passedMatch) {
    return `All ${passedMatch[1]} tests passed`;
  }

  return null;
}

function extractJestFailures(output: string): string | null {
  const lines = output.split("\n");
  const failureLines: string[] = [];

  // Look for FAIL markers
  const failMarkers = lines.filter((line) => line.includes("FAIL "));
  if (failMarkers.length > 0) {
    failureLines.push(`${failMarkers.length} test suite(s) failed:`);
    for (const marker of failMarkers.slice(0, 10)) {
      failureLines.push(`  ${marker.trim()}`);
    }
  }

  // Look for failing test names (lines starting with specific markers)
  const failingTests = lines.filter(
    (line) =>
      /^\s*[x\u2717\u2716]\s/.test(line) || /^\s*FAIL\s/.test(line) || /^\s*\u25cf\s/.test(line),
  );
  if (failingTests.length > 0) {
    failureLines.push("");
    failureLines.push("Failing tests:");
    for (const test of failingTests.slice(0, 15)) {
      failureLines.push(`  ${test.trim()}`);
    }
  }

  // Look for "Tests: N failed" summary
  const summary = output.match(/Tests:\s+(.+failed.+)/);
  if (summary) {
    failureLines.push("");
    failureLines.push(`Summary: ${summary[1]}`);
  }

  if (failureLines.length === 0) {
    return null;
  }

  return failureLines.join("\n");
}

// ─── TypeScript extraction ─────────────────────────────────────────

function isTscOutput(output: string): boolean {
  return /error TS\d+/.test(output) === false && /\.tsx?/.test(output);
}

function extractTscErrors(output: string): string | null {
  const lines = output.split("\n");
  const errorLines = lines.filter((line) => /error TS\d+/.test(line));

  if (errorLines.length === 0) {
    return null;
  }

  const result = [`${errorLines.length} TypeScript error(s):`];
  for (const line of errorLines.slice(0, 20)) {
    result.push(`  ${line.trim()}`);
  }

  if (errorLines.length > 20) {
    result.push(`  ... and ${errorLines.length - 20} more errors`);
  }

  return result.join("\n");
}

// ─── ESLint extraction ─────────────────────────────────────────────

function isEslintOutput(output: string): boolean {
  // ESLint outputs file paths followed by violation lines, or "0 problems"
  return /\d+\s+problems?/.test(output) || /eslint/i.test(output);
}

function extractEslintErrors(output: string): string | null {
  const lines = output.split("\n");

  // Look for the summary line "N problems (N errors, N warnings)"
  const summaryMatch = output.match(/(\d+)\s+problems?\s*\((\d+)\s+errors?,\s*(\d+)\s+warnings?\)/);

  // Look for individual violation lines (file:line:col pattern)
  const violationLines = lines.filter((line) => /^\s*\d+:\d+\s+(error|warning)\s/.test(line));

  if (violationLines.length === 0 && !summaryMatch) {
    return null;
  }

  const result: string[] = [];
  if (summaryMatch) {
    result.push(`ESLint: ${summaryMatch[0]}`);
  }

  if (violationLines.length > 0) {
    result.push("");
    for (const line of violationLines.slice(0, 20)) {
      result.push(`  ${line.trim()}`);
    }
    if (violationLines.length > 20) {
      result.push(`  ... and ${violationLines.length - 20} more violations`);
    }
  }

  return result.join("\n");
}

// ─── Utility ───────────────────────────────────────────────────────

function getLastMeaningfulLine(output: string): string | null {
  const lines = output.split("\n").filter((line) => line.trim().length > 0);
  return lines.length > 0 ? lines[lines.length - 1].trim() : null;
}

function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) {
    return text;
  }

  const truncationMarker = "\n... [output truncated]";
  return text.slice(0, maxLength - truncationMarker.length) + truncationMarker;
}
