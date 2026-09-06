import { validateTaskSchema } from "../../src/gate/schema-validator";
import { ParsedTask, TaskPriority, TaskStatus } from "../../src/core/types";

/**
 * Helper function to create a valid task with all fields populated.
 * Tests can override specific fields to test edge cases.
 */
function makeValidTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  const baseTask: ParsedTask = {
    id: "TASK-001",
    title: "Implement feature X",
    priority: "P1-HIGH" as TaskPriority,
    effort: "2 hours",
    status: "BACKLOG" as TaskStatus,
    blockedBy: [],
    blocks: [],
    conventions: ["CONV-001"],
    tags: ["feature"],
    problemStatement: "We need to implement feature X to solve problem Y.",
    currentState: "No implementation exists yet.",
    recommendedApproach: "Create a new module in src/features/x",
    filesToModify: [
      {
        path: "src/features/x.ts",
        action: "Create",
        notes: "Main implementation",
      },
    ],
    successCriteria: ["Feature X is functional", "Tests pass"],
    testingRequirements: ["Unit tests for module X"],
    contextReferences: [],
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    rawContent: "# TASK-001\n...",
  };

  return { ...baseTask, ...overrides };
}

describe("validateTaskSchema", () => {
  describe("valid tasks", () => {
    test("should pass with all fields populated", () => {
      const task = makeValidTask();
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    test("should pass with only required fields, generate warnings for missing recommended fields", () => {
      const task = makeValidTask({
        currentState: "",
        recommendedApproach: "",
        filesToModify: [],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.warnings).toEqual([
        "current_state",
        "recommended_approach",
        "files_to_modify (minimum 1 recommended)",
      ]);
    });

    test("should pass with all valid priority values", () => {
      const priorities: TaskPriority[] = ["P0-CRITICAL", "P1-HIGH", "P2-MEDIUM", "P3-LOW"];

      priorities.forEach((priority) => {
        const task = makeValidTask({ priority });
        const result = validateTaskSchema(task);

        expect(result.valid).toBe(true);
        expect(result.missing).toEqual([]);
      });
    });

    test("should pass with all valid status values", () => {
      const statuses: TaskStatus[] = [
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

      statuses.forEach((status) => {
        const task = makeValidTask({ status });
        const result = validateTaskSchema(task);

        expect(result.valid).toBe(true);
        expect(result.missing).toEqual([]);
      });
    });

    test.each(["../../secrets.txt", "/etc/passwd", "C:\\Windows\\win.ini"])(
      "should reject an out-of-project file path: %s",
      (filePath) => {
        const task = makeValidTask({
          filesToModify: [{ path: filePath, action: "Modify", notes: "" }],
        });

        const result = validateTaskSchema(task);

        expect(result.valid).toBe(false);
        expect(result.missing.join("\n")).toContain("outside the project root");
      },
    );
  });

  describe("missing required fields", () => {
    test("should fail when title is missing", () => {
      const task = makeValidTask({ title: "" });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("title");
    });

    test("should fail when title is whitespace only", () => {
      const task = makeValidTask({ title: "   " });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("title");
    });

    test("should fail when priority is invalid", () => {
      const task = makeValidTask({ priority: "INVALID" as TaskPriority });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("priority");
    });

    test("should fail when effort is missing", () => {
      const task = makeValidTask({ effort: "" });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("effort");
    });

    test("should fail when effort is whitespace only", () => {
      const task = makeValidTask({ effort: "   " });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("effort");
    });

    test("should fail when status is invalid", () => {
      const task = makeValidTask({ status: "INVALID" as TaskStatus });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("status");
    });

    test("should fail when problem statement is missing", () => {
      const task = makeValidTask({ problemStatement: "" });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("problem_statement");
    });

    test("should fail when problem statement is whitespace only", () => {
      const task = makeValidTask({ problemStatement: "   " });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("problem_statement");
    });

    test("should fail when success criteria is empty array", () => {
      const task = makeValidTask({ successCriteria: [] });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("success_criteria (minimum 1 required)");
    });

    test("should fail when testing requirements is empty array", () => {
      const task = makeValidTask({ testingRequirements: [] });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("testing_requirements (minimum 1 required)");
    });

    test("should fail with multiple missing required fields", () => {
      const task = makeValidTask({
        title: "",
        effort: "",
        problemStatement: "",
        successCriteria: [],
        testingRequirements: [],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(false);
      expect(result.missing).toEqual([
        "title",
        "effort",
        "problem_statement",
        "success_criteria (minimum 1 required)",
        "testing_requirements (minimum 1 required)",
      ]);
    });
  });

  describe("recommended fields warnings", () => {
    test("should warn when current state is missing", () => {
      const task = makeValidTask({ currentState: "" });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain("current_state");
    });

    test("should warn when current state is whitespace only", () => {
      const task = makeValidTask({ currentState: "   " });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain("current_state");
    });

    test("should warn when recommended approach is missing", () => {
      const task = makeValidTask({ recommendedApproach: "" });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain("recommended_approach");
    });

    test("should warn when recommended approach is whitespace only", () => {
      const task = makeValidTask({ recommendedApproach: "   " });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain("recommended_approach");
    });

    test("should warn when files to modify is empty array", () => {
      const task = makeValidTask({ filesToModify: [] });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain("files_to_modify (minimum 1 recommended)");
    });

    test("should generate all warnings when all recommended fields are missing", () => {
      const task = makeValidTask({
        currentState: "",
        recommendedApproach: "",
        filesToModify: [],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toEqual([
        "current_state",
        "recommended_approach",
        "files_to_modify (minimum 1 recommended)",
      ]);
    });
  });

  describe("requiredSections override", () => {
    test("does not require filesToModify by default (regression)", () => {
      const task = makeValidTask({ filesToModify: [] });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.missing).not.toContain("files_to_modify (required by project config)");
      expect(result.warnings).toContain("files_to_modify (minimum 1 recommended)");
    });

    test("returns invalid when filesToModify empty and requiredSections includes filesToModify", () => {
      const task = makeValidTask({ filesToModify: [] });
      const result = validateTaskSchema(task, ["filesToModify"]);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("files_to_modify (required by project config)");
      expect(result.warnings).not.toContain("files_to_modify (minimum 1 recommended)");
    });

    test("returns valid when filesToModify has at least one entry and requiredSections includes filesToModify", () => {
      const task = makeValidTask({
        filesToModify: [{ path: "src/foo.ts", action: "Modify", notes: "" }],
      });
      const result = validateTaskSchema(task, ["filesToModify"]);

      expect(result.valid).toBe(true);
      expect(result.missing).not.toContain("files_to_modify (required by project config)");
    });

    test("promotes recommendedApproach to required when listed in requiredSections", () => {
      const task = makeValidTask({ recommendedApproach: "" });
      const result = validateTaskSchema(task, ["recommendedApproach"]);

      expect(result.valid).toBe(false);
      expect(result.missing).toContain("recommended_approach (required by project config)");
      expect(result.warnings).not.toContain("recommended_approach");
    });

    test("empty requiredSections array behaves identically to default (no argument)", () => {
      const task = makeValidTask({
        currentState: "",
        recommendedApproach: "",
        filesToModify: [],
      });
      const resultDefault = validateTaskSchema(task);
      const resultEmpty = validateTaskSchema(task, []);

      expect(resultEmpty.valid).toBe(resultDefault.valid);
      expect(resultEmpty.missing).toEqual(resultDefault.missing);
      expect(resultEmpty.warnings).toEqual(resultDefault.warnings);
    });
  });

  describe("integration wiring warnings", () => {
    test("should warn when new CLI command file lacks index.ts", () => {
      const task = makeValidTask({
        filesToModify: [{ path: "src/cli/new-command.ts", action: "Create", notes: "" }],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        "New CLI command file created but src/index.ts not in filesToModify — command will not be registered",
      );
    });

    test("should warn when new route file lacks server.ts", () => {
      const task = makeValidTask({
        filesToModify: [{ path: "src/routes/new-route.ts", action: "Create", notes: "" }],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        "New route/endpoint file created but server.ts not in filesToModify — endpoints will not be mounted",
      );
    });

    test("should warn when event emission mentioned but event-types.ts missing", () => {
      const task = makeValidTask({
        filesToModify: [{ path: "src/new-module.ts", action: "Create", notes: "" }],
        successCriteria: ["Module emits progress events"],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        "Success criteria mention emitting events but event-types.ts not in filesToModify",
      );
    });

    test("should NOT warn when integration files are present", () => {
      const task = makeValidTask({
        filesToModify: [
          { path: "src/cli/new-command.ts", action: "Create", notes: "" },
          { path: "src/index.ts", action: "Modify", notes: "Register command" },
        ],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).not.toContain(
        "New CLI command file created but src/index.ts not in filesToModify — command will not be registered",
      );
    });

    test("should warn about type files being created", () => {
      const task = makeValidTask({
        filesToModify: [{ path: "src/new-types.ts", action: "Create", notes: "" }],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        "New type definition file created — verify it is imported by the modules that use it",
      );
    });

    test("should handle multiple integration warnings", () => {
      const task = makeValidTask({
        filesToModify: [
          { path: "src/cli/cmd1.ts", action: "Create", notes: "" },
          { path: "src/routes/route1.ts", action: "Create", notes: "" },
        ],
        successCriteria: ["CLI command works", "Endpoint emits events"],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings.length).toBeGreaterThan(2);
      expect(result.warnings).toContain(
        "New CLI command file created but src/index.ts not in filesToModify — command will not be registered",
      );
      expect(result.warnings).toContain(
        "New route/endpoint file created but server.ts not in filesToModify — endpoints will not be mounted",
      );
    });
  });

  describe("multi-layer completeness warnings", () => {
    test("should warn when task mentions frontend but only has backend files", () => {
      const task = makeValidTask({
        rawContent:
          "# TASK-001: Add user profile page\n\nCreate a new React component for the user profile page.",
        problemStatement: "We need a frontend component to display user profiles",
        filesToModify: [{ path: "src/routes/users.ts", action: "Modify", notes: "Backend route" }],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
    });

    test("should warn when task mentions component and .tsx but has no frontend files", () => {
      const task = makeValidTask({
        rawContent: "# TASK-001: Implement feature\n\nAdd a new component in Profile.tsx",
        filesToModify: [{ path: "src/services/user.service.ts", action: "Create", notes: "" }],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
    });

    test("should NOT warn when task has frontend mentions AND frontend files", () => {
      const task = makeValidTask({
        rawContent: "# TASK-001: Add UI component\n\nCreate a React component",
        filesToModify: [
          { path: "frontends/web/components/Profile.tsx", action: "Create", notes: "" },
        ],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).not.toContain(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
    });

    test("should warn when task mentions backend work but only has frontend files", () => {
      const task = makeValidTask({
        rawContent: "# TASK-001: Add API endpoint\n\nCreate a new route handler and controller",
        problemStatement: "Need to add a service layer for user management",
        filesToModify: [{ path: "frontends/web/pages/Users.tsx", action: "Modify", notes: "" }],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        "Task spec describes backend work (routes/services/models) but no backend files in filesToModify — verify this is intentional",
      );
    });

    test("should NOT warn when task has backend mentions AND backend files", () => {
      const task = makeValidTask({
        rawContent: "# TASK-001: Add service layer\n\nCreate controller and service",
        filesToModify: [
          { path: "src/routes/users.ts", action: "Create", notes: "" },
          { path: "src/services/user.service.ts", action: "Create", notes: "" },
        ],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).not.toContain(
        "Task spec describes backend work (routes/services/models) but no backend files in filesToModify — verify this is intentional",
      );
    });

    test("should NOT warn when task has no rawContent", () => {
      const task = makeValidTask({
        rawContent: "",
        problemStatement: "",
        filesToModify: [{ path: "src/services/user.service.ts", action: "Create", notes: "" }],
      });

      const result = validateTaskSchema(task);

      // Should have other warnings but not cross-layer warnings
      expect(result.warnings).not.toContain(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
      expect(result.warnings).not.toContain(
        "Task spec describes backend work (routes/services/models) but no backend files in filesToModify — verify this is intentional",
      );
    });

    test("should NOT warn when task has empty filesToModify", () => {
      const task = makeValidTask({
        rawContent: "# TASK-001: Add React component\n\nFrontend work needed",
        filesToModify: [],
      });

      const result = validateTaskSchema(task);

      // Should have files_to_modify warning but not cross-layer frontend warning
      expect(result.warnings).toContain("files_to_modify (minimum 1 recommended)");
      expect(result.warnings).not.toContain(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
    });

    test("should detect UI component and page keywords", () => {
      const task = makeValidTask({
        rawContent: "Create a new UI page with sidebar navigation",
        filesToModify: [{ path: "src/services/data.service.ts", action: "Create", notes: "" }],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
    });

    test("should detect dashboard page keyword", () => {
      const task = makeValidTask({
        rawContent: "Add a dashboard page for analytics",
        filesToModify: [{ path: "src/controllers/analytics.ts", action: "Create", notes: "" }],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
    });

    test("should detect API endpoint keyword", () => {
      const task = makeValidTask({
        rawContent: "Create a new API endpoint for user data",
        filesToModify: [{ path: "frontends/web/components/User.tsx", action: "Create", notes: "" }],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        "Task spec describes backend work (routes/services/models) but no backend files in filesToModify — verify this is intentional",
      );
    });

    test("should detect standalone 'page' keyword (TASK-151 scenario)", () => {
      const task = makeValidTask({
        rawContent: "Create Gift Cards list page that loads at /gift-cards",
        filesToModify: [
          { path: "src/services/gift-card.service.ts", action: "Create", notes: "" },
          { path: "src/routes/gift-cards.ts", action: "Create", notes: "" },
        ],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).toContain(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
    });

    test("should recognize src/components/ as frontend files", () => {
      const task = makeValidTask({
        rawContent: "Create a new page with sidebar navigation",
        filesToModify: [{ path: "src/components/GiftCards.tsx", action: "Create", notes: "" }],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).not.toContain(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
    });

    test("should recognize pages/ directory as frontend files", () => {
      const task = makeValidTask({
        rawContent: "Add dashboard view for analytics",
        filesToModify: [{ path: "pages/analytics.tsx", action: "Create", notes: "" }],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).not.toContain(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
    });

    test("should recognize .tsx files as frontend files", () => {
      const task = makeValidTask({
        rawContent: "Create a form dialog for user input",
        filesToModify: [{ path: "src/app/UserForm.tsx", action: "Create", notes: "" }],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).not.toContain(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
    });

    test("should NOT warn for backend when both backend and frontend files present", () => {
      const task = makeValidTask({
        rawContent: "Add full-stack feature with API endpoint and UI component",
        filesToModify: [
          { path: "src/routes/users.ts", action: "Create", notes: "" },
          { path: "frontends/web/pages/Users.tsx", action: "Create", notes: "" },
        ],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).not.toContain(
        "Task spec describes frontend/UI work but no frontend files in filesToModify — verify this is intentional or add frontend deliverables",
      );
      expect(result.warnings).not.toContain(
        "Task spec describes backend work (routes/services/models) but no backend files in filesToModify — verify this is intentional",
      );
    });
  });

  describe("Reference action handling", () => {
    test("does not emit filesToModify length warning when only Reference entries present", () => {
      const task = makeValidTask({
        filesToModify: [{ path: "src/some/file.ts", action: "Reference", notes: "context" }],
      });
      const result = validateTaskSchema(task);
      expect(result.warnings).not.toContain("files_to_modify (minimum 1 recommended)");
    });

    test("does not emit CLI-file warning when CLI file entry has action Reference", () => {
      const task = makeValidTask({
        filesToModify: [{ path: "src/cli/my-command.ts", action: "Reference", notes: "context" }],
      });
      const result = validateTaskSchema(task);
      expect(result.warnings).not.toContain(
        "New CLI command file created but src/index.ts not in filesToModify — command will not be registered",
      );
    });
  });

  describe("edge cases", () => {
    test("should handle task with minimal valid data", () => {
      const task = makeValidTask({
        blockedBy: [],
        blocks: [],
        conventions: [],
        tags: [],
        contextReferences: [],
        currentState: "",
        recommendedApproach: "",
        filesToModify: [],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
      expect(result.warnings.length).toBeGreaterThan(0);
    });

    test("should handle task with success criteria containing single item", () => {
      const task = makeValidTask({ successCriteria: ["Feature works"] });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    test("should handle task with testing requirements containing single item", () => {
      const task = makeValidTask({ testingRequirements: ["Unit test exists"] });
      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.missing).toEqual([]);
    });

    test("should handle task with files to modify containing single item", () => {
      const task = makeValidTask({
        filesToModify: [
          {
            path: "src/test.ts",
            action: "Create",
            notes: "Test file",
          },
        ],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).not.toContain("files_to_modify (minimum 1 recommended)");
    });
  });

  describe("Reference action handling (TASK-893-C)", () => {
    test("Reference-only filesToModify counts toward length, no files_to_modify warning", () => {
      const task = makeValidTask({
        filesToModify: [
          {
            path: "src/context.ts",
            action: "Reference",
            notes: "Read-only context",
          },
        ],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(true);
      expect(result.warnings).not.toContain("files_to_modify (minimum 1 recommended)");
    });

    test("Reference entry under src/cli/ does NOT trigger CLI-file warning", () => {
      // The CLI-file warning fires only when a Create/Modify entry targets
      // src/cli/ without src/index.ts also in the list. Reference entries
      // are read-only and must be excluded from that branch.
      const task = makeValidTask({
        filesToModify: [
          {
            path: "src/cli/run.ts",
            action: "Reference",
            notes: "Existing CLI entrypoint we read for pattern",
          },
        ],
      });

      const result = validateTaskSchema(task);

      const cliWarning = result.warnings.find(
        (w) => w.toLowerCase().includes("cli") && w.toLowerCase().includes("index"),
      );
      expect(cliWarning).toBeUndefined();
    });

    test("mix of Create + Reference entries: only Create entries gate the CLI-file warning", () => {
      const task = makeValidTask({
        filesToModify: [
          {
            path: "src/cli/run.ts",
            action: "Create",
            notes: "New CLI command",
          },
          {
            path: "src/cli/util.ts",
            action: "Reference",
            notes: "Read for pattern",
          },
        ],
      });

      const result = validateTaskSchema(task);

      // Create on src/cli/ without src/index.ts in the list SHOULD warn —
      // the Reference entry must NOT mask that.
      const cliWarning = result.warnings.find(
        (w) => w.toLowerCase().includes("cli") && w.toLowerCase().includes("index"),
      );
      expect(cliWarning).toBeDefined();
    });
  });

  describe("unresolved repair placeholders", () => {
    test("fails the gate when the spec contains repair placeholders", () => {
      const task = makeValidTask({
        rawContent:
          "# TASK-001: X\n\n## Testing Requirements\n- [ ] TBD (repair placeholder): submitter must define real testing requirements\n",
        testingRequirements: [
          "TBD (repair placeholder): submitter must define real testing requirements",
        ],
      });

      const result = validateTaskSchema(task);

      expect(result.valid).toBe(false);
      expect(result.missing.some((m) => m.includes("unresolved_repair_placeholders"))).toBe(true);
    });

    test("passes once placeholders are resolved", () => {
      const task = makeValidTask({
        rawContent: "# TASK-001: X\n\n## Testing Requirements\n- [ ] Real unit tests\n",
      });

      const result = validateTaskSchema(task);

      expect(result.missing).toEqual([]);
      expect(result.valid).toBe(true);
    });
  });
});
