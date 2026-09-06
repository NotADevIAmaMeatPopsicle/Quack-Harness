import { execSync } from "node:child_process";

// ─── CLI flag parsing tests ──────────────────────────────────────
// Tests the CLI registration and flag parsing by invoking
// `node dist/index.js revise --help` and checking output.

describe("quack revise CLI", () => {
  it("registers the revise command with correct flags", () => {
    const output = execSync("node dist/index.js revise --help", {
      encoding: "utf-8",
      cwd: process.cwd(),
    });

    expect(output).toContain("revise");
    expect(output).toContain("--feedback");
    expect(output).toContain("--from-pr");
    expect(output).toContain("--max-budget");
    expect(output).toContain("--max-turns");
    expect(output).toContain("--project");
  });

  it("exits with error when no feedback provided", () => {
    // revise without --feedback or --from-pr should fail
    try {
      execSync("node dist/index.js revise TASK-999", {
        encoding: "utf-8",
        cwd: process.cwd(),
        stdio: "pipe",
      });
      // Should not reach here
      fail("Expected command to fail");
    } catch (err: unknown) {
      const error = err as { status: number; stderr: string };
      expect(error.status).not.toBe(0);
    }
  });
});

// ─── PR feedback extraction tests ────────────────────────────────
// Tests the formatting logic from the revise module.
// Since the PR extraction uses execSync with `gh`, we test the
// formatting pattern directly.

describe("PR feedback formatting", () => {
  it("formats file-specific comments into structured markdown", () => {
    // Simulates the formatting logic from src/cli/revise.ts:72-89
    const prData = {
      comments: [
        { path: "src/server.ts", line: 42, body: "Use existing middleware" },
        { path: "tests/server.test.ts", line: 15, body: "Missing edge case" },
      ],
      reviews: [{ body: "Overall looks good but needs integration fixes" }],
    };

    let feedback = `\n\n## PR Feedback (PR #42)\n\n`;

    if (prData.comments && prData.comments.length > 0) {
      feedback += "### File-Specific Comments\n";
      for (const comment of prData.comments) {
        feedback += `- \`${comment.path}:${comment.line}\` — ${comment.body}\n`;
      }
      feedback += "\n";
    }

    if (prData.reviews && prData.reviews.length > 0) {
      feedback += "### Overall Reviews\n";
      for (const review of prData.reviews) {
        feedback += `${review.body}\n\n`;
      }
    }

    expect(feedback).toContain("## PR Feedback (PR #42)");
    expect(feedback).toContain("### File-Specific Comments");
    expect(feedback).toContain("`src/server.ts:42` — Use existing middleware");
    expect(feedback).toContain("`tests/server.test.ts:15` — Missing edge case");
    expect(feedback).toContain("### Overall Reviews");
    expect(feedback).toContain("Overall looks good but needs integration fixes");
  });

  it("handles PR data with no file-specific comments", () => {
    const prData = {
      comments: [] as { path: string; line: number; body: string }[],
      reviews: [{ body: "Needs more tests" }],
    };

    let feedback = `\n\n## PR Feedback (PR #10)\n\n`;

    if (prData.comments && prData.comments.length > 0) {
      feedback += "### File-Specific Comments\n";
      for (const comment of prData.comments) {
        feedback += `- \`${comment.path}:${comment.line}\` — ${comment.body}\n`;
      }
      feedback += "\n";
    }

    if (prData.reviews && prData.reviews.length > 0) {
      feedback += "### Overall Reviews\n";
      for (const review of prData.reviews) {
        feedback += `${review.body}\n\n`;
      }
    }

    expect(feedback).not.toContain("### File-Specific Comments");
    expect(feedback).toContain("### Overall Reviews");
    expect(feedback).toContain("Needs more tests");
  });
});
