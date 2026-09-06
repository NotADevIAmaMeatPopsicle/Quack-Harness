// ─── Subtask Quality Gate Tests ─────────────────────────────────────
// Tests for runChildQualityGate and PREP_THRESHOLD.

import { runChildQualityGate, PREP_THRESHOLD } from "../../src/preflight/subtask-quality-gate.js";

/** Build a minimal valid markdown with all required sections */
function buildValidMarkdown(
  overrides: Partial<{
    problemStatement: string;
    currentState: string;
    recommendedApproach: string;
    testingRequirements: string;
    antiPatterns: string;
    stubContent: string;
  }>,
): string {
  const problem =
    overrides.problemStatement ??
    "This child implements the registry module, responsible for storing and retrieving project data. It must handle concurrent access and graceful error handling.";

  const currentState =
    overrides.currentState ??
    "The registry module does not exist. A new file must be created from scratch.";

  const approach =
    overrides.recommendedApproach ??
    "Create src/registry.ts with Map backing store. Expose addProject, removeProject, getProject. Validate inputs.";

  const testing =
    overrides.testingRequirements ??
    `- [ ] Unit test: addProject stores the project and getProject retrieves it
- [ ] Unit test: removeProject removes the entry from the map
- [ ] Integration test: registry integrates with the API layer`;

  const antiPatterns =
    overrides.antiPatterns ??
    `- Do NOT expose the internal Map directly
- Do NOT allow callers to mutate returned Project objects`;

  const stub = overrides.stubContent ?? "";

  return `# TASK-042-A: Implement Registry

## Metadata
- **Priority:** P1-HIGH
- **Effort:** 2-3 hours
- **Status:** READY
- **Blocked By:** []
- **Blocks:** []
- **Tags:** feature, subtask

## Problem Statement
${problem}

## Current State
${currentState}

## Recommended Approach
${approach}

## Files to Modify
| File | Action | Notes |
|------|--------|-------|
| \`src/registry.ts\` | Create | Registry module |

## Success Criteria
- [ ] Registry works
- [ ] getProject returns undefined for unknown IDs

## Testing Requirements
${testing}

## Anti-Patterns
${antiPatterns}

## Context References
- Parent task: TASK-042
- docs/ARCHITECTURE.md
${stub}`;
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("subtask-quality-gate", () => {
  describe("PREP_THRESHOLD", () => {
    it("should be 4.0", () => {
      expect(PREP_THRESHOLD).toBe(4.0);
    });
  });

  describe("runChildQualityGate", () => {
    it("should return prepReady=true for a fully valid draft", () => {
      const markdown = buildValidMarkdown({});
      const result = runChildQualityGate("TASK-042-A", markdown);

      expect(result.prepReady).toBe(true);
      expect(result.prepScore).toBeGreaterThanOrEqual(PREP_THRESHOLD);
      // No parse errors, no stub patterns, no missing sections
      expect(result.deficiencies.some((d) => d.includes("Generic stub"))).toBe(false);
      expect(result.deficiencies.some((d) => d.includes("Missing required section"))).toBe(false);
      expect(result.deficiencies.some((d) => d.includes("Parse failure"))).toBe(false);
    });

    it("should return all 8 required sections in sectionsPresent for a valid draft", () => {
      const markdown = buildValidMarkdown({});
      const result = runChildQualityGate("TASK-042-A", markdown);

      expect(result.sectionsPresent).toContain("Problem Statement");
      expect(result.sectionsPresent).toContain("Current State");
      expect(result.sectionsPresent).toContain("Recommended Approach");
      expect(result.sectionsPresent).toContain("Files to Modify");
      expect(result.sectionsPresent).toContain("Success Criteria");
      expect(result.sectionsPresent).toContain("Testing Requirements");
      expect(result.sectionsPresent).toContain("Anti-Patterns");
      expect(result.sectionsPresent).toContain("Context References");
    });

    it("should return prepReady=false for empty markdown", () => {
      const result = runChildQualityGate("TASK-042-A", "");

      expect(result.prepReady).toBe(false);
      expect(result.prepScore).toBe(0);
      expect(result.parseError).toBeDefined();
      expect(result.deficiencies).toContain("Draft is empty");
    });

    it("should detect banned stub pattern: 'This subtask is part of TASK-NNN decomposition'", () => {
      const markdown = buildValidMarkdown({
        stubContent: "\nThis subtask is part of TASK-042 decomposition.\n",
      });

      const result = runChildQualityGate("TASK-042-A", markdown);

      expect(result.deficiencies.some((d) => d.includes("Generic stub detected"))).toBe(true);
    });

    it("should detect banned stub pattern: 'At least N×2 new tests'", () => {
      const markdown = buildValidMarkdown({
        testingRequirements: "- [ ] At least 4×2 new tests",
      });

      const result = runChildQualityGate("TASK-042-A", markdown);

      expect(result.deficiencies.some((d) => d.includes("Generic stub detected"))).toBe(true);
    });

    it("should detect banned stub pattern: generic approach placeholder", () => {
      const markdown = buildValidMarkdown({
        recommendedApproach: "Follow the implementation patterns from the parent task's blueprint.",
      });

      const result = runChildQualityGate("TASK-042-A", markdown);

      expect(result.deficiencies.some((d) => d.includes("Generic stub detected"))).toBe(true);
    });

    it("should detect banned stub pattern: generic current state placeholder", () => {
      const markdown = buildValidMarkdown({
        currentState: "Parent task TASK-042 was decomposed into multiple subtasks.",
      });

      const result = runChildQualityGate("TASK-042-A", markdown);

      expect(result.deficiencies.some((d) => d.includes("Generic stub detected"))).toBe(true);
    });

    it("should penalize for too-short Problem Statement (< 15 words)", () => {
      const markdown = buildValidMarkdown({
        problemStatement: "Short problem statement.",
      });

      const result = runChildQualityGate("TASK-042-A", markdown);

      expect(result.deficiencies.some((d) => d.includes("Problem Statement is too short"))).toBe(
        true,
      );
    });

    it("should penalize for testing section with only generic build/lint checks", () => {
      const markdown = buildValidMarkdown({
        testingRequirements: "- [ ] npm run build\n- [ ] All tests pass\n- [ ] npm run lint",
      });

      const result = runChildQualityGate("TASK-042-A", markdown);

      expect(
        result.deficiencies.some((d) =>
          d.includes("Testing Requirements contains only generic build/lint checks"),
        ),
      ).toBe(true);
    });

    it("should penalize for fewer than 2 testing requirement lines", () => {
      const markdown = buildValidMarkdown({
        testingRequirements: "- [ ] Unit test: addProject stores a project",
      });

      const result = runChildQualityGate("TASK-042-A", markdown);

      expect(result.deficiencies.some((d) => d.includes("fewer than 2 test scenarios"))).toBe(true);
    });

    it("should report missing sections in deficiencies", () => {
      // Remove the Anti-Patterns section
      const markdown = buildValidMarkdown({}).replace(/^## Anti-Patterns[\s\S]*?(?=^## |$)/im, "");

      const result = runChildQualityGate("TASK-042-A", markdown);

      expect(result.sectionsPresent).not.toContain("Anti-Patterns");
      expect(result.deficiencies.some((d) => d.includes("Anti-Patterns"))).toBe(true);
    });

    it("should return subtaskId in result", () => {
      const markdown = buildValidMarkdown({});
      const result = runChildQualityGate("TASK-999-B", markdown);

      expect(result.subtaskId).toBe("TASK-999-B");
    });

    it("should have prepScore in [0, 5] range", () => {
      const markdown = buildValidMarkdown({});
      const result = runChildQualityGate("TASK-042-A", markdown);

      expect(result.prepScore).toBeGreaterThanOrEqual(0);
      expect(result.prepScore).toBeLessThanOrEqual(5);
    });

    it("should produce lower prepScore for a stub-heavy draft vs a rich draft", () => {
      const richMarkdown = buildValidMarkdown({});
      const stubMarkdown = buildValidMarkdown({
        problemStatement: "Short stub.",
        currentState: "Parent task TASK-042 was decomposed into multiple subtasks.",
        testingRequirements: "- [ ] At least 4×2 new tests",
      });

      const richResult = runChildQualityGate("TASK-042-A", richMarkdown);
      const stubResult = runChildQualityGate("TASK-042-A", stubMarkdown);

      expect(richResult.prepScore).toBeGreaterThan(stubResult.prepScore);
    });
  });
});
