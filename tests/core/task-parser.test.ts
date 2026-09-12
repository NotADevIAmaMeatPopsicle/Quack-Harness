import * as fs from "fs";
import * as path from "path";
import { matchTaskHeading, parseTaskFile, TaskParseError } from "../../src/core/task-parser";
import type { ParsedTask } from "../../src/core/types";

// ─── Helpers ──────────────────────────────────────────────────────

const FIXTURES_DIR = path.join(__dirname, "..", "fixtures");

function readFixture(filename: string): string {
  return fs.readFileSync(path.join(FIXTURES_DIR, filename), "utf-8");
}

// ─── Valid Full Task ──────────────────────────────────────────────

describe("TASK-1336-C bare task identity", () => {
  it.each(["TASK-1402-A", "TASK-100-B", "TASK-1402", "SAURUS-REM-001"])(
    "keeps the complete declared ID %s before parsing a title separator",
    (id) => {
      expect(matchTaskHeading(id)).toEqual({ id, title: "" });
      expect(matchTaskHeading(`${id}: Named task`)).toEqual({ id, title: "Named task" });
    },
  );
  it("retains the hyphen title separator when the heading is not a bare ID", () => {
    expect(matchTaskHeading("TASK-1402 - Named task")).toEqual({
      id: "TASK-1402",
      title: "Named task",
    });
  });
});

describe("parseTaskFile — valid full task", () => {
  let task: ParsedTask;

  beforeAll(() => {
    const content = readFixture("task-valid-full.md");
    task = parseTaskFile(content, "tests/fixtures/task-valid-full.md");
  });

  it("should extract the task ID from H1 heading", () => {
    expect(task.id).toBe("TASK-042");
  });

  it("should extract the title from H1 heading", () => {
    expect(task.title).toBe("Implement User Authentication");
  });

  it("should parse priority", () => {
    expect(task.priority).toBe("P1-HIGH");
  });

  it("should parse effort", () => {
    expect(task.effort).toBe("6-8 hours");
  });

  it("should parse status", () => {
    expect(task.status).toBe("READY");
  });

  it("should parse blockedBy as string array", () => {
    expect(task.blockedBy).toEqual(["TASK-040", "TASK-041"]);
  });

  it("should parse blocks as string array", () => {
    expect(task.blocks).toEqual(["TASK-043", "TASK-044", "TASK-045"]);
  });

  it("should parse conventions as string array", () => {
    expect(task.conventions).toEqual(["ADR-012", "STYLE-001"]);
  });

  it("should parse tags as string array", () => {
    expect(task.tags).toEqual(["backend", "auth", "security"]);
  });

  it("should parse the problem statement section", () => {
    expect(task.problemStatement).toContain("no authentication system");
    expect(task.problemStatement).toContain("security risk");
  });

  it("should parse the current state section", () => {
    expect(task.currentState).toContain("unprotected");
    expect(task.currentState).toContain("src/routes/");
  });

  it("should parse the recommended approach section", () => {
    expect(task.recommendedApproach).toContain("JWT-based authentication");
  });

  it("should parse files to modify table", () => {
    expect(task.filesToModify).toHaveLength(6);
    expect(task.filesToModify[0]).toEqual({
      path: "src/models/user.ts",
      action: "Create",
      notes: "User model with email, hashed password, timestamps",
    });
    expect(task.filesToModify[5]).toEqual({
      path: "src/config/jwt.ts",
      action: "Modify",
      notes: "Add JWT secret and expiry configuration",
    });
  });

  it("should parse success criteria, stripping checkbox prefixes", () => {
    expect(task.successCriteria).toHaveLength(6);
    expect(task.successCriteria[0]).toBe("Users can register with email and password");
    expect(task.successCriteria[5]).toBe("All existing tests still pass");
  });

  it("should parse testing requirements, stripping checkbox prefixes", () => {
    expect(task.testingRequirements).toHaveLength(4);
    expect(task.testingRequirements[0]).toBe(
      "Unit tests for password hashing and token generation",
    );
    expect(task.testingRequirements[3]).toBe("All tests pass: `npm test`");
  });

  it("should parse context references as string array", () => {
    expect(task.contextReferences).toHaveLength(4);
    expect(task.contextReferences[0]).toContain("ADR-012");
    expect(task.contextReferences[3]).toContain("TASK-040");
  });

  it("should store rawContent as the full original markdown", () => {
    const content = readFixture("task-valid-full.md");
    expect(task.rawContent).toBe(content);
  });
});

describe("parseTaskFile - qualified section headings", () => {
  it("accepts safe qualifiers on success criteria and testing requirements headings", () => {
    const content = `# TASK-010: Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria (umbrella)
- [ ] Fix the visible problem.

## Testing Requirements (applies to each subtask)
- [ ] Prove the fix with a targeted test.
`;

    const result = parseTaskFile(content);

    expect(result.successCriteria).toEqual(["Fix the visible problem."]);
    expect(result.testingRequirements).toEqual(["Prove the fix with a targeted test."]);
  });

  it("accepts dash-qualified canonical headings", () => {
    const content = `# TASK-010: Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria - program level
- [ ] Fix the visible problem.

## Testing Requirements - backend and frontend
- [ ] Prove the fix with a targeted test.
`;

    const result = parseTaskFile(content);

    expect(result.successCriteria).toEqual(["Fix the visible problem."]);
    expect(result.testingRequirements).toEqual(["Prove the fix with a targeted test."]);
  });

  it("accepts numbered testing requirements", () => {
    const content = `# TASK-010: Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix the visible problem.

## Testing Requirements
1. Run the targeted unit test.
2. Run the build.
`;

    const result = parseTaskFile(content);

    expect(result.testingRequirements).toEqual(["Run the targeted unit test.", "Run the build."]);
  });

  it("still rejects qualified success criteria headings with no criteria", () => {
    const content = `# TASK-010: Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria (umbrella)

## Testing Requirements
1. Run the targeted unit test.
`;

    expect(() => parseTaskFile(content)).toThrow(/Success Criteria/i);
  });
});

describe("parseTaskFile - backlog hygiene metadata", () => {
  it("parses supersession metadata and backlog relevance review sections", () => {
    const content = `# TASK-856: Hygiene

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** REJECTED
- **Superseded By:** [TASK-900, TASK-901]
- **Supersedes:** TASK-700

## Problem Statement
Something is stale.

## Backlog Relevance Review (2026-05-02)
Rejected as a duplicate after the federated rebuild.

## Success Criteria
- [ ] Capture the stale state.

## Testing Requirements
- [ ] Prove the parser keeps the metadata.
`;

    const result = parseTaskFile(content);

    expect(result.supersededBy).toEqual(["TASK-900", "TASK-901"]);
    expect(result.supersedes).toEqual(["TASK-700"]);
    expect(result.relevanceReview).toContain("Rejected as a duplicate");
  });

  it("prefers explicit metadata relevance review when both metadata and section exist", () => {
    const content = `# TASK-856: Hygiene

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2 hours
- **Status:** ON_HOLD
- **Relevance Review:** Wait until the rollout lane is stable.

## Problem Statement
Something is deferred.

## Backlog Relevance Review (2026-05-02)
This section should not override the metadata field.

## Success Criteria
- [ ] Capture the deferred state.

## Testing Requirements
- [ ] Prove metadata wins.
`;

    const result = parseTaskFile(content);

    expect(result.relevanceReview).toBe("Wait until the rollout lane is stable.");
    expect(result.supersededBy).toEqual([]);
    expect(result.supersedes).toEqual([]);
  });
});

// ─── Valid Minimal Task ───────────────────────────────────────────

describe("parseTaskFile — valid minimal task (required fields only)", () => {
  let task: ParsedTask;

  beforeAll(() => {
    const content = readFixture("task-valid-minimal.md");
    task = parseTaskFile(content);
  });

  it("should extract the task ID", () => {
    expect(task.id).toBe("TASK-001");
  });

  it("should extract the title", () => {
    expect(task.title).toBe("Fix Login Bug");
  });

  it("should parse required metadata fields", () => {
    expect(task.priority).toBe("P0-CRITICAL");
    expect(task.effort).toBe("1-2 hours");
    expect(task.status).toBe("BACKLOG");
  });

  it("should default optional bracket lists to empty arrays", () => {
    expect(task.blockedBy).toEqual([]);
    expect(task.blocks).toEqual([]);
    expect(task.conventions).toEqual([]);
    expect(task.tags).toEqual([]);
  });

  it("should default missing optional text sections to empty string", () => {
    expect(task.currentState).toBe("");
    expect(task.recommendedApproach).toBe("");
  });

  it("should default missing files-to-modify to empty array", () => {
    expect(task.filesToModify).toEqual([]);
  });

  it("should default missing context references to empty array", () => {
    expect(task.contextReferences).toEqual([]);
  });

  it("should parse the problem statement", () => {
    expect(task.problemStatement).toContain("login form crashes");
  });

  it("should parse success criteria", () => {
    expect(task.successCriteria).toHaveLength(1);
    expect(task.successCriteria[0]).toBe("Login form handles empty email without crashing");
  });

  it("should parse testing requirements", () => {
    expect(task.testingRequirements).toHaveLength(1);
    expect(task.testingRequirements[0]).toBe("Unit test for empty email validation");
  });
});

// ─── Invalid: Missing Title ──────────────────────────────────────

describe("parseTaskFile — invalid: missing H1 heading", () => {
  it("should throw TaskParseError when H1 heading is missing", () => {
    const content = readFixture("task-invalid-missing-title.md");
    expect(() => parseTaskFile(content, "task-invalid-missing-title.md")).toThrow(TaskParseError);
    expect(() => parseTaskFile(content)).toThrow(/H1 heading/i);
  });
});

// ─── Invalid: Missing Priority ────────────────────────────────────

describe("parseTaskFile — invalid: missing priority", () => {
  it("should throw TaskParseError when priority is missing", () => {
    const content = readFixture("task-invalid-missing-priority.md");
    expect(() => parseTaskFile(content, "task-invalid-missing-priority.md")).toThrow(
      TaskParseError,
    );
    expect(() => parseTaskFile(content)).toThrow(/Priority/i);
  });
});

// ─── Missing Required Fields ─────────────────────────────────────

describe("parseTaskFile — missing required fields", () => {
  it("should throw on missing effort", () => {
    const content = `# TASK-010: Test

## Metadata
- **Priority:** P2-MEDIUM
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    expect(() => parseTaskFile(content)).toThrow(/Effort/i);
  });

  it("should throw on missing status", () => {
    const content = `# TASK-010: Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    expect(() => parseTaskFile(content)).toThrow(/Status/i);
  });

  it("should throw on missing problem statement", () => {
    const content = `# TASK-010: Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    expect(() => parseTaskFile(content)).toThrow(/Problem Statement/i);
  });

  it("should throw on empty success criteria", () => {
    const content = `# TASK-010: Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria

## Testing Requirements
- [ ] Test it
`;
    expect(() => parseTaskFile(content)).toThrow(/Success Criteria/i);
  });

  it("should throw on missing testing requirements", () => {
    const content = `# TASK-010: Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it
`;
    expect(() => parseTaskFile(content)).toThrow(/Testing Requirements/i);
  });

  it("should throw on missing metadata section entirely", () => {
    const content = `# TASK-010: Test

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    expect(() => parseTaskFile(content)).toThrow(/Priority/i);
  });
});

// ─── Invalid Values ──────────────────────────────────────────────

describe("parseTaskFile — invalid field values", () => {
  it("should throw on invalid priority value", () => {
    const content = `# TASK-010: Test

## Metadata
- **Priority:** URGENT
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    expect(() => parseTaskFile(content)).toThrow(/Invalid priority/i);
  });

  it("should throw on invalid status value", () => {
    const content = `# TASK-010: Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** DONE

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    expect(() => parseTaskFile(content)).toThrow(/Invalid status/i);
  });
});

// ─── Edge Cases ──────────────────────────────────────────────────

describe("parseTaskFile — edge cases", () => {
  it("should handle extra whitespace in metadata fields", () => {
    const content = `# TASK-010: Whitespace Test

## Metadata
-   **Priority:**   P2-MEDIUM
-  **Effort:**    3-4 hours
- **Status:**  BACKLOG

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    const task = parseTaskFile(content);
    expect(task.priority).toBe("P2-MEDIUM");
    expect(task.effort).toBe("3-4 hours");
    expect(task.status).toBe("BACKLOG");
  });

  it("should handle checked checkboxes [x] and [X]", () => {
    const content = `# TASK-010: Checkbox Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Unchecked criterion
- [x] Checked criterion lowercase
- [X] Checked criterion uppercase

## Testing Requirements
- [ ] Run the tests
`;
    const task = parseTaskFile(content);
    expect(task.successCriteria).toHaveLength(3);
    expect(task.successCriteria[0]).toBe("Unchecked criterion");
    expect(task.successCriteria[1]).toBe("Checked criterion lowercase");
    expect(task.successCriteria[2]).toBe("Checked criterion uppercase");
  });

  it("should handle empty bracket lists", () => {
    const content = `# TASK-010: Empty Lists

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG
- **Blocked By:** []
- **Blocks:** []
- **Tags:** []

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    const task = parseTaskFile(content);
    expect(task.blockedBy).toEqual([]);
    expect(task.blocks).toEqual([]);
    expect(task.tags).toEqual([]);
  });

  it("should handle bare comma-separated values without brackets", () => {
    const content = `# TASK-010: Bare Values

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG
- **Tags:** backend, api, auth

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    const task = parseTaskFile(content);
    expect(task.tags).toEqual(["backend", "api", "auth"]);
  });

  it("should handle CRLF line endings", () => {
    const content =
      "# TASK-010: CRLF Test\r\n\r\n" +
      "## Metadata\r\n" +
      "- **Priority:** P2-MEDIUM\r\n" +
      "- **Effort:** 2 hours\r\n" +
      "- **Status:** BACKLOG\r\n\r\n" +
      "## Problem Statement\r\n" +
      "Something is broken.\r\n\r\n" +
      "## Success Criteria\r\n" +
      "- [ ] Fix it\r\n\r\n" +
      "## Testing Requirements\r\n" +
      "- [ ] Test it\r\n";
    const task = parseTaskFile(content);
    expect(task.id).toBe("TASK-010");
    expect(task.priority).toBe("P2-MEDIUM");
    expect(task.successCriteria).toEqual(["Fix it"]);
  });

  it("should handle files-to-modify table with case-insensitive actions", () => {
    const content = `# TASK-010: Table Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/foo.ts | create | New file |
| src/bar.ts | MODIFY | Changed file |
| src/baz.ts | Delete | Removed file |

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    const task = parseTaskFile(content);
    expect(task.filesToModify).toHaveLength(3);
    expect(task.filesToModify[0].action).toBe("Create");
    expect(task.filesToModify[1].action).toBe("Modify");
    expect(task.filesToModify[2].action).toBe("Delete");
  });

  it("should treat Add and New actions as Create rows", () => {
    const content = `# TASK-010: Add Action Alias

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something needs a new test file.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/tests/unit/middleware/auth-assignment-scope.test.js | Add | New focused middleware test |
| src/generated/client.ts | New | Generated client entry |

## Success Criteria
- [ ] File rows are parsed

## Testing Requirements
- [ ] Parser test passes
`;
    const task = parseTaskFile(content);
    expect(task.filesToModify).toHaveLength(2);
    expect(task.filesToModify[0]).toEqual({
      path: "src/tests/unit/middleware/auth-assignment-scope.test.js",
      action: "Create",
      notes: "New focused middleware test",
    });
    expect(task.filesToModify[1]).toEqual({
      path: "src/generated/client.ts",
      action: "Create",
      notes: "Generated client entry",
    });
  });

  it("should handle multi-paragraph problem statement", () => {
    const content = `# TASK-010: Multi Paragraph

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
First paragraph describing the problem.

Second paragraph with more detail about the issue.

Third paragraph with additional context.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    const task = parseTaskFile(content);
    expect(task.problemStatement).toContain("First paragraph");
    expect(task.problemStatement).toContain("Second paragraph");
    expect(task.problemStatement).toContain("Third paragraph");
  });

  it("should handle H1 heading with dash separator instead of colon", () => {
    const content = `# TASK-010 - Dash Separated Title

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    const task = parseTaskFile(content);
    expect(task.id).toBe("TASK-010");
    expect(task.title).toBe("Dash Separated Title");
  });

  it("should include filePath in error messages when provided", () => {
    const content = "No heading here";
    expect(() => parseTaskFile(content, "path/to/task.md")).toThrow(/path\/to\/task\.md/);
  });

  it("should handle a single success criterion and single testing requirement", () => {
    const content = `# TASK-010: Single Items

## Metadata
- **Priority:** P3-LOW
- **Effort:** 1 hour
- **Status:** BACKLOG

## Problem Statement
Minor fix needed.

## Success Criteria
- [ ] The one thing that matters

## Testing Requirements
- [ ] The one test
`;
    const task = parseTaskFile(content);
    expect(task.successCriteria).toHaveLength(1);
    expect(task.testingRequirements).toHaveLength(1);
  });

  it("should handle H1 with no title (just task ID)", () => {
    const content = `# TASK-010

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    const task = parseTaskFile(content);
    expect(task.id).toBe("TASK-010");
    expect(task.title).toBe("");
  });

  it("should handle non-TASK H1 heading with error", () => {
    const content = `# Just a Random Title

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    expect(() => parseTaskFile(content)).toThrow(/H1 heading does not match expected format/);
  });

  it("should skip malformed rows in files-to-modify table", () => {
    const content = `# TASK-010: Table Edge Cases

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/good.ts | Create | Valid row |
| src/bad.ts | InvalidAction | This row should be skipped |
| src/also-good.ts | Modify | Another valid row |

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
    const task = parseTaskFile(content);
    expect(task.filesToModify).toHaveLength(2);
    expect(task.filesToModify[0].path).toBe("src/good.ts");
    expect(task.filesToModify[1].path).toBe("src/also-good.ts");
  });

  it("should parse plain bullet items in success criteria (no checkboxes)", () => {
    const content = `# TASK-010: Plain Bullets

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria
- First criterion without checkbox
- Second criterion without checkbox

## Testing Requirements
- First test without checkbox
`;
    const task = parseTaskFile(content);
    expect(task.successCriteria).toHaveLength(2);
    expect(task.successCriteria[0]).toBe("First criterion without checkbox");
    expect(task.testingRequirements).toHaveLength(1);
    expect(task.testingRequirements[0]).toBe("First test without checkbox");
  });

  it("normalizes ON-HOLD status spelling to ON_HOLD with warning", () => {
    const content = `# TASK-010: Status Normalization

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** ON-HOLD

## Problem Statement
Something is blocked.

## Success Criteria
- [ ] Status parses

## Testing Requirements
- [ ] Parser test passes
`;
    const task = parseTaskFile(content);
    expect(task.status).toBe("ON_HOLD");
    expect(task.parseWarnings).toBeDefined();
    expect(task.parseWarnings?.join(" ")).toContain("normalized");
  });

  it("normalizes status annotations like COMPLETE (note) without hard-failing", () => {
    const content = `# TASK-010: Status Annotation

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** COMPLETE (verified 2026-04-25)

## Problem Statement
Already done.

## Success Criteria
- [ ] Status parses

## Testing Requirements
- [ ] Parser test passes
`;
    const task = parseTaskFile(content);
    expect(task.status).toBe("COMPLETE");
    expect(task.parseWarnings?.some((warning) => warning.includes("annotation"))).toBe(true);
  });

  it("should handle all valid status values", () => {
    const statuses = [
      "BACKLOG",
      "READY",
      "IN_PROGRESS",
      "BLOCKED",
      "ON_HOLD",
      "DECOMPOSED",
      "VERIFYING",
      "COMPLETE",
      "VERIFIED",
      "REJECTED",
    ];
    for (const status of statuses) {
      const content = `# TASK-010: Status Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** ${status}

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
      const task = parseTaskFile(content);
      expect(task.status).toBe(status);
    }
  });

  it("should handle all valid priority values", () => {
    const priorities = ["P0-CRITICAL", "P1-HIGH", "P2-MEDIUM", "P3-LOW"];
    for (const priority of priorities) {
      const content = `# TASK-010: Priority Test

## Metadata
- **Priority:** ${priority}
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Something is broken.

## Success Criteria
- [ ] Fix it

## Testing Requirements
- [ ] Test it
`;
      const task = parseTaskFile(content);
      expect(task.priority).toBe(priority);
    }
  });

  it("parses Target Branch metadata when present", () => {
    const content = `# TASK-010: Target Branch Parse

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** READY
- **Target Branch:** feature/web-dashboard-ui

## Problem Statement
Needs branch isolation.

## Success Criteria
- [ ] Parse target branch

## Testing Requirements
- [ ] Parser test
`;
    const task = parseTaskFile(content);
    expect(task.targetBranch).toBe("feature/web-dashboard-ui");
  });

  it("returns undefined targetBranch when metadata is absent", () => {
    const content = `# TASK-010: No Target Branch

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** READY

## Problem Statement
Needs default routing.

## Success Criteria
- [ ] Use default branch

## Testing Requirements
- [ ] Parser test
`;
    const task = parseTaskFile(content);
    expect(task.targetBranch).toBeUndefined();
  });

  it("preserves Target Branch with spaces and slashes", () => {
    const content = `# TASK-010: Target Branch Special

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** READY
- **Target Branch:** release/2026 Q2/hotfix

## Problem Statement
Needs non-standard branch string.

## Success Criteria
- [ ] Parse target branch exactly

## Testing Requirements
- [ ] Parser test
`;
    const task = parseTaskFile(content);
    expect(task.targetBranch).toBe("release/2026 Q2/hotfix");
  });

  it.each(["dispatch", "loop"] as const)("parses Execution Mode %s", (executionMode) => {
    const content = `# TASK-010: Execution Mode

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** READY
- **Execution Mode:** ${executionMode}

## Problem Statement
Needs explicit execution routing.

## Success Criteria
- [ ] Route execution

## Testing Requirements
- [ ] Parser test
`;
    expect(parseTaskFile(content).executionMode).toBe(executionMode);
  });

  it("returns undefined executionMode when metadata is absent", () => {
    const content = `# TASK-010: Default Execution Mode

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** READY

## Problem Statement
Uses adapter routing.

## Success Criteria
- [ ] Route execution

## Testing Requirements
- [ ] Parser test
`;
    expect(parseTaskFile(content).executionMode).toBeUndefined();
  });

  it("rejects invalid Execution Mode metadata", () => {
    const content = `# TASK-010: Invalid Execution Mode

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** READY
- **Execution Mode:** unsafe-loop

## Problem Statement
Must fail parsing.

## Success Criteria
- [ ] Reject invalid routing

## Testing Requirements
- [ ] Parser test
`;
    expect(() => parseTaskFile(content)).toThrow(
      'Invalid Execution Mode: "unsafe-loop". Must be one of: dispatch, loop',
    );
  });
});

// ─── Parsing Real Task Files ─────────────────────────────────────

describe("parseTaskFile — parsing real TASK-002 file", () => {
  it("should successfully parse the actual TASK-002 spec", () => {
    const taskPath = path.join(
      __dirname,
      "..",
      "..",
      "docs",
      "tasks",
      "TASK-002-task-spec-parser.md",
    );
    // Only run if the file exists (it should in this project)
    if (!fs.existsSync(taskPath)) {
      return;
    }
    const content = fs.readFileSync(taskPath, "utf-8");
    const task = parseTaskFile(content, taskPath);

    expect(task.id).toBe("TASK-002");
    expect(task.title).toBe("Task Spec Parser");
    expect(task.priority).toBe("P0-CRITICAL");
    expect(task.status).toBe("COMPLETE");
    expect(task.blockedBy).toEqual(["TASK-001"]);
    expect(task.blocks).toEqual(["TASK-004", "TASK-005", "TASK-007"]);
    expect(task.tags).toEqual(["core", "parser"]);
    expect(task.successCriteria.length).toBeGreaterThanOrEqual(1);
    expect(task.testingRequirements.length).toBeGreaterThanOrEqual(1);
    expect(task.filesToModify.length).toBeGreaterThanOrEqual(1);
  });
});

// ─── Reference action aliases ────────────────────────────────────

describe("parseTaskFile — Reference action aliases", () => {
  function makeTableTask(action: string): string {
    return `# TASK-010: Reference Alias Test

## Metadata
- **Priority:** P2-MEDIUM
- **Effort:** 2 hours
- **Status:** BACKLOG

## Problem Statement
Testing reference aliases.

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| src/foo.ts | ${action} | check |

## Success Criteria
- [ ] Alias maps to Reference

## Testing Requirements
- [ ] Parser test passes
`;
  }

  it("maps 'Verify' action to Reference", () => {
    const task = parseTaskFile(makeTableTask("Verify"));
    expect(task.filesToModify).toHaveLength(1);
    expect(task.filesToModify[0].action).toBe("Reference");
  });

  it("maps 'Read-only reference' action to Reference", () => {
    const task = parseTaskFile(makeTableTask("Read-only reference"));
    expect(task.filesToModify).toHaveLength(1);
    expect(task.filesToModify[0].action).toBe("Reference");
  });

  it("maps 'Optional' action to Reference", () => {
    const task = parseTaskFile(makeTableTask("Optional"));
    expect(task.filesToModify).toHaveLength(1);
    expect(task.filesToModify[0].action).toBe("Reference");
  });

  it("maps 'DO NOT MODIFY' action to Reference", () => {
    const task = parseTaskFile(makeTableTask("DO NOT MODIFY"));
    expect(task.filesToModify).toHaveLength(1);
    expect(task.filesToModify[0].action).toBe("Reference");
  });

  it("maps 'review' action to Reference", () => {
    const task = parseTaskFile(makeTableTask("review"));
    expect(task.filesToModify).toHaveLength(1);
    expect(task.filesToModify[0].action).toBe("Reference");
  });

  it("emits a parseWarnings entry for truly unknown actions like 'Conjure'", () => {
    const task = parseTaskFile(makeTableTask("Conjure"));
    expect(task.filesToModify).toHaveLength(0);
    expect(task.parseWarnings).toBeDefined();
    expect(task.parseWarnings?.join(" ")).toContain("Conjure");
  });

  it("emits a parseWarnings entry naming the unknown verb 'Frobnicate'", () => {
    const task = parseTaskFile(makeTableTask("Frobnicate"));
    expect(task.filesToModify).toHaveLength(0);
    expect(task.parseWarnings).toBeDefined();
    expect(task.parseWarnings?.join(" ")).toContain("Frobnicate");
  });
});
