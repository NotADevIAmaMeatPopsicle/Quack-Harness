import { buildJudgePrompt, JUDGE_SYSTEM_PROMPT } from "../../src/judge/judge-prompt";
import type { VerificationResult } from "../../src/core/types";

describe("JUDGE_SYSTEM_PROMPT (static, cacheable)", () => {
  it("should include adversarial reviewer role", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("adversarial code review judge");
  });

  it("should include per-criterion evaluation instructions", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("Per-Criterion Evaluation Instructions");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Identify the enforcement mechanism");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Classify the enforcement type");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Test edge cases");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Assign a status");
  });

  it("should include enforcement types", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("deterministic_code");
    expect(JUDGE_SYSTEM_PROMPT).toContain("llm_instruction_only");
    expect(JUDGE_SYSTEM_PROMPT).toContain("not_implemented");
  });

  it("should include response format with JSON structure", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("Response Format");
    expect(JUDGE_SYSTEM_PROMPT).toContain('"verdict"');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"criteria_evaluation"');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"scope_violations"');
    expect(JUDGE_SYSTEM_PROMPT).toContain('"feedback"');
  });

  it("should include verdict guidelines", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("Verdict Guidelines");
    expect(JUDGE_SYSTEM_PROMPT).toContain("APPROVE");
    expect(JUDGE_SYSTEM_PROMPT).toContain("REVISE");
    expect(JUDGE_SYSTEM_PROMPT).toContain("REJECT");
  });

  it("should include additional checks", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("Additional Checks");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Recommended Approach");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Scope Violations");
  });

  it("should include scope gap detection section", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("Scope Gap Detection");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Files to Modify audit");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Implementation Plan audit");
  });

  it("should include scope_gap in follow_up_items type", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('"scope_gap"');
  });

  it("should preserve anti-scope-creep rules", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain('"Success Criteria" section is the CONTRACT');
    expect(JUDGE_SYSTEM_PROMPT).toContain("Do NOT invent new requirements");
  });

  it("should NOT include per-task data", () => {
    // System prompt may explain how to interpret these inputs, but it must not
    // contain the dynamic sections into which per-task payloads are rendered.
    expect(JUDGE_SYSTEM_PROMPT).not.toContain("## Original Task Specification");
    expect(JUDGE_SYSTEM_PROMPT).not.toContain("## Git Diff");
    expect(JUDGE_SYSTEM_PROMPT).not.toContain("## Verification Results");
    expect(JUDGE_SYSTEM_PROMPT).not.toContain("## Extracted Success Criteria");
  });
});

describe("buildJudgePrompt (dynamic, per-task)", () => {
  const mockVerification: VerificationResult = {
    allPassed: true,
    commands: [{ name: "tests", passed: true, output: "" }],
    conventionChecks: [],
  };

  it("should include task spec", () => {
    const prompt = buildJudgePrompt({
      taskSpec: "# TASK-042: Add caching",
      gitDiff: "diff --git a/file.ts",
      verificationResults: mockVerification,
      judgeCriteria: "",
    });

    expect(prompt).toContain("TASK-042: Add caching");
  });

  it("should include git diff", () => {
    const prompt = buildJudgePrompt({
      taskSpec: "# TASK-042",
      gitDiff: "diff --git a/file.ts b/file.ts\n+new line",
      verificationResults: mockVerification,
      judgeCriteria: "",
    });

    expect(prompt).toContain("Git Diff");
    expect(prompt).toContain("+new line");
  });

  it("should include verification results", () => {
    const prompt = buildJudgePrompt({
      taskSpec: "# TASK-042",
      gitDiff: "diff",
      verificationResults: {
        allPassed: false,
        commands: [{ name: "lint", passed: false, output: "Error on line 5" }],
        conventionChecks: [],
      },
      judgeCriteria: "",
    });

    expect(prompt).toContain("Verification Results");
    expect(prompt).toContain("FAIL");
  });

  it("should NOT include full static instruction sections (those are in system prompt)", () => {
    const prompt = buildJudgePrompt({
      taskSpec: "# TASK-042",
      gitDiff: "diff",
      verificationResults: mockVerification,
      judgeCriteria: "",
    });

    // The dynamic prompt should not duplicate the full instruction sections.
    // It may reference them briefly (e.g., "follow the instructions in your system prompt")
    // but should NOT include the full enforcement type definitions, verdict guidelines, etc.
    expect(prompt).not.toContain("Identify the enforcement mechanism");
    expect(prompt).not.toContain("Classify the enforcement type");
    expect(prompt).not.toContain("APPROVE**: ALL criteria have status PASS");
    expect(prompt).not.toContain("Respond with this JSON structure");
  });

  it("should include project-specific criteria when provided", () => {
    const prompt = buildJudgePrompt({
      taskSpec: "# TASK-042",
      gitDiff: "diff",
      verificationResults: mockVerification,
      judgeCriteria: "Must follow REST conventions",
    });

    expect(prompt).toContain("Project-Specific Evaluation Criteria");
    expect(prompt).toContain("REST conventions");
  });

  it("should reference system prompt instructions", () => {
    const prompt = buildJudgePrompt({
      taskSpec: "# TASK-042",
      gitDiff: "diff",
      verificationResults: mockVerification,
      judgeCriteria: "",
    });

    expect(prompt).toContain("system prompt");
  });
});
