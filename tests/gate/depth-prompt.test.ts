import { buildDepthPrompt } from "../../src/gate/depth-prompt";
import { ParsedTask, TaskPriority, TaskStatus } from "../../src/core/types";

/**
 * Helper function to create a valid task for depth prompt testing.
 */
function makeValidTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  const baseTask: ParsedTask = {
    id: "TASK-042",
    title: "Add email validation to registration form",
    priority: "P1-HIGH" as TaskPriority,
    effort: "2-3 hours",
    status: "BACKLOG" as TaskStatus,
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: ["TASK-043"],
    conventions: ["ADR-012"],
    tags: ["backend", "validation"],
    problemStatement:
      "The registration form accepts any string as an email address. We need RFC 5322 compliant email validation.",
    currentState:
      "src/controllers/auth.controller.ts has a register() handler that passes raw input to the service layer without validation.",
    recommendedApproach:
      "Add a validateEmail() function in src/utils/validators.ts and call it from the registration controller.",
    filesToModify: [
      {
        path: "src/utils/validators.ts",
        action: "Create",
        notes: "Email validation function",
      },
      {
        path: "src/controllers/auth.controller.ts",
        action: "Modify",
        notes: "Add validation call before service layer",
      },
    ],
    successCriteria: [
      "Invalid emails return 422 with field-level error",
      "Valid emails proceed to registration",
      "All existing auth tests still pass",
    ],
    testingRequirements: [
      "Unit test for validateEmail() with valid and invalid cases",
      "Integration test for registration endpoint with invalid email",
    ],
    contextReferences: ["ADR-012: Input validation patterns"],
    rawContent:
      "# TASK-042: Add email validation to registration form\n\n## Problem Statement\nThe registration form accepts any string as an email...",
  };

  return { ...baseTask, ...overrides };
}

describe("buildDepthPrompt", () => {
  test("should interpolate task rawContent into the prompt", () => {
    const task = makeValidTask();
    const conventions = "Use Express + Sequelize. camelCase in JS.";

    const prompt = buildDepthPrompt(task, conventions);

    expect(prompt).toContain(task.rawContent);
  });

  test("should interpolate conventions summary into the prompt", () => {
    const task = makeValidTask();
    const conventions = "Use Express + Sequelize. camelCase in JS.";

    const prompt = buildDepthPrompt(task, conventions);

    expect(prompt).toContain(conventions);
  });

  test("should include all seven evaluation dimensions", () => {
    const task = makeValidTask();
    const prompt = buildDepthPrompt(task, "conventions summary");

    expect(prompt).toContain("Problem Clarity");
    expect(prompt).toContain("Scope Boundedness");
    expect(prompt).toContain("Testability");
    expect(prompt).toContain("Convention Anchoring");
    expect(prompt).toContain("Implementation Specificity");
    expect(prompt).toContain("Verification Clarity");
    expect(prompt).toContain("Completeness");
  });

  test("should include Completeness dimension text", () => {
    const task = makeValidTask();
    const prompt = buildDepthPrompt(task, "conventions summary");

    expect(prompt).toContain("Completeness");
    expect(prompt).toContain("Does the task cover ALL layers implied by the spec?");
  });

  test("should include new dimensions in JSON response format", () => {
    const task = makeValidTask();
    const prompt = buildDepthPrompt(task, "conventions summary");

    expect(prompt).toContain('"implementation_specificity"');
    expect(prompt).toContain('"verification_clarity"');
    expect(prompt).toContain('"completeness"');
  });

  test("should include JSON response format instructions", () => {
    const task = makeValidTask();
    const prompt = buildDepthPrompt(task, "conventions summary");

    expect(prompt).toContain('"ready"');
    expect(prompt).toContain('"overall_score"');
    expect(prompt).toContain('"scores"');
    expect(prompt).toContain('"deficiencies"');
    expect(prompt).toContain('"enrichment_suggestions"');
    expect(prompt).toContain('"implementation_specificity"');
    expect(prompt).toContain('"verification_clarity"');
    expect(prompt).toContain('"completeness"');
  });

  test("should include the system context preamble", () => {
    const task = makeValidTask();
    const prompt = buildDepthPrompt(task, "conventions summary");

    expect(prompt).toContain("You are evaluating whether a task specification is detailed enough");
    expect(prompt).toContain("background coding agent to implement without human guidance");
  });

  test("should handle empty conventions summary", () => {
    const task = makeValidTask();
    const prompt = buildDepthPrompt(task, "");

    expect(prompt).toContain("## Project Context\n");
    expect(prompt).toContain(task.rawContent);
  });

  test("should handle task with minimal rawContent", () => {
    const task = makeValidTask({ rawContent: "# TASK-001: Minimal" });
    const prompt = buildDepthPrompt(task, "some conventions");

    expect(prompt).toContain("# TASK-001: Minimal");
    expect(prompt).toContain("some conventions");
  });

  test("should build an architecture-specific prompt from adr tags", () => {
    const task = makeValidTask({ tags: ["adr", "architecture"] });
    const prompt = buildDepthPrompt(task, "architecture conventions");

    expect(prompt).toContain("architecture / ADR");
    expect(prompt).toContain('"decision_points"');
    expect(prompt).toContain('"alternatives_coverage"');
    expect(prompt).not.toContain('"implementation_specificity"');
  });

  test("should build a test-specific prompt from testing tags", () => {
    const task = makeValidTask({ tags: ["playwright", "testing"] });
    const prompt = buildDepthPrompt(task, "test conventions");

    expect(prompt).toContain("test implementation");
    expect(prompt).toContain('"test_scope_definition"');
    expect(prompt).toContain('"target_coverage_areas"');
    expect(prompt).not.toContain('"clarity"');
  });

  test("should build a documentation-specific prompt from documentation tags", () => {
    const task = makeValidTask({ tags: ["documentation", "guides"] });
    const prompt = buildDepthPrompt(task, "docs conventions");

    expect(prompt).toContain("documentation");
    expect(prompt).toContain('"scope_definition"');
    expect(prompt).toContain('"source_material_references"');
    expect(prompt).toContain("overall_score >= 3.0");
  });
});
