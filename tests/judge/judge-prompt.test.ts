import {
  JUDGE_SYSTEM_PROMPT,
  buildJudgePrompt,
  type JudgePromptInput,
} from "../../src/judge/judge-prompt";

const baseInput = (): JudgePromptInput => ({
  taskSpec: "# TASK-099: Test\n\n## Success Criteria\n- [ ] thing works\n",
  gitDiff: "diff --git a/src/foo.ts b/src/foo.ts\n",
  verificationResults: { allPassed: true, commands: [], conventionChecks: [] },
  judgeCriteria: "",
});

describe("JUDGE_SYSTEM_PROMPT — Scope Gap Detection (TASK-083)", () => {
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

  it("should instruct judge to compare filesToModify against git diff", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      'If a file listed with action "Create" does NOT appear in the diff, note it as a scope gap',
    );
    expect(JUDGE_SYSTEM_PROMPT).toContain(
      'If a file listed with action "Modify" has no changes in the diff, note it',
    );
  });

  it("should specify verdict impact for scope gaps", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("Scope gaps that correspond to success criteria");
    expect(JUDGE_SYSTEM_PROMPT).toContain("do NOT block APPROVE");
  });

  it("scope-gap detection section explicitly exempts Reference entries from diff-presence check", () => {
    // Reference files are context-only — absent from diff is NOT a scope gap
    expect(JUDGE_SYSTEM_PROMPT).toMatch(
      /[Rr]eference.*context.only|context.only.*[Rr]eference|[Rr]eference.*NOT.*scope gap|[Rr]eference.*not.*flag/i,
    );
  });

  it("should include buildJudgePrompt existing sections unchanged", () => {
    // Verify the scope gap section does not replace existing sections
    expect(JUDGE_SYSTEM_PROMPT).toContain("Per-Criterion Evaluation Instructions");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Additional Checks");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Response Format");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Verdict Guidelines");
    expect(JUDGE_SYSTEM_PROMPT).toContain("STRICT: Scope Boundaries");
    expect(JUDGE_SYSTEM_PROMPT).toContain("Non-Blocking Follow-Up Items");
  });
});

describe("JUDGE_SYSTEM_PROMPT — Spec Ambiguity Awareness (TASK-894)", () => {
  it("includes a Spec Ambiguity Awareness section", () => {
    expect(JUDGE_SYSTEM_PROMPT).toContain("Spec Ambiguity Awareness");
  });

  it("instructs judge to give benefit of any reasonable interpretation on flagged criteria", () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/benefit of any reasonable interpretation/i);
  });

  it("clarifies that ambiguity does NOT excuse missing the criterion entirely", () => {
    expect(JUDGE_SYSTEM_PROMPT).toMatch(/does NOT excuse missing the criterion/i);
  });
});

describe("buildJudgePrompt — Pre-Dispatch Spec Ambiguities (TASK-894)", () => {
  it("renders the section when specReview.findings is non-empty", () => {
    const prompt = buildJudgePrompt({
      ...baseInput(),
      specReview: {
        riskLevel: "high",
        findings: [
          {
            criterionIndex: 0,
            criterionText: "API endpoint returns result",
            dimension: "criterion_ambiguity",
            severity: "high",
            explanation: "Spec offers two strategies without picking one",
          },
          {
            criterionIndex: 2,
            dimension: "interface_gap",
            severity: "medium",
            explanation: "Return type is not specified",
          },
        ],
      },
    });
    expect(prompt).toContain("## Pre-Dispatch Spec Ambiguities");
    expect(prompt).toContain("Risk level: high");
    expect(prompt).toContain("[HIGH] Criterion 0");
    expect(prompt).toContain("[MEDIUM] Criterion 2");
    expect(prompt).toContain("Spec offers two strategies without picking one");
    expect(prompt).toContain("Return type is not specified");
  });

  it("omits the section when specReview is undefined", () => {
    const prompt = buildJudgePrompt(baseInput());
    expect(prompt).not.toContain("Pre-Dispatch Spec Ambiguities");
  });

  it("omits the section when specReview.findings is empty", () => {
    const prompt = buildJudgePrompt({
      ...baseInput(),
      specReview: { riskLevel: "low", findings: [] },
    });
    expect(prompt).not.toContain("Pre-Dispatch Spec Ambiguities");
  });
});
