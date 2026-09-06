import { evaluateEnrichmentCandidate } from "../../src/monitor/enrichment-candidate-gate";

function taskContent(
  options: {
    blockedBy?: string;
    successCriteria?: string[];
    testingRequirements?: string[];
    files?: string[];
    tags?: string;
    status?: string;
  } = {},
): string {
  const successCriteria = options.successCriteria ?? [
    "Original success criterion remains present.",
  ];
  const testingRequirements = options.testingRequirements ?? [
    "Run npm test -- tests/monitor/enrichment-candidate-gate.test.ts --runInBand.",
  ];
  const files = options.files ?? ["src/monitor/server.ts"];

  return `# TASK-921-B: Enrichment Candidate Test

## Metadata
- **Priority:** P0-CRITICAL
- **Effort:** 2-4 hours
- **Status:** ${options.status ?? "READY"}
- **Blocked By:** ${options.blockedBy ?? "[TASK-921-A]"}
- **Blocks:** []
- **Tags:** ${options.tags ?? "[enrichment, security]"}

## Problem Statement

Workers need a safe way to submit task spec enrichments.

## Current State

The current packet has important safety details.

## Recommended Approach

Compare parsed task packets before accepting a candidate.

## Files to Modify

| File | Action | Notes |
|---|---|---|
${files.map((file) => `| ${file} | Modify | Keep this integration point. |`).join("\n")}

## Success Criteria

${successCriteria.map((criterion) => `- [ ] ${criterion}`).join("\n")}

## Testing Requirements

${testingRequirements.map((requirement) => `- [ ] ${requirement}`).join("\n")}
`;
}

describe("evaluateEnrichmentCandidate", () => {
  it("accepts a candidate that preserves required content and adds useful detail", () => {
    const current = taskContent();
    const candidate = taskContent({
      successCriteria: [
        "Original success criterion remains present.",
        "Candidate records readiness provenance for future workers.",
      ],
      testingRequirements: [
        "Run npm test -- tests/monitor/enrichment-candidate-gate.test.ts --runInBand.",
        "Run npm run build.",
      ],
      files: ["src/monitor/server.ts", "src/monitor/enrichment-candidate-gate.ts"],
    });

    const decision = evaluateEnrichmentCandidate(current, candidate);

    expect(decision.accepted).toBe(true);
    expect(decision.blockers).toEqual([]);
    expect(decision.score.delta).toBeGreaterThan(0);
    expect(decision.reasons).toEqual(
      expect.arrayContaining(["adds_success_criteria", "adds_testing_requirements"]),
    );
  });

  it("rejects candidates that remove blockers, success criteria, verification, files, or risk tags", () => {
    const current = taskContent();
    const candidate = taskContent({
      blockedBy: "[]",
      successCriteria: ["A different success criterion."],
      testingRequirements: ["Manual glance only."],
      files: ["src/monitor/readiness-service.ts"],
      tags: "[enrichment]",
    });

    const decision = evaluateEnrichmentCandidate(current, candidate);

    expect(decision.accepted).toBe(false);
    expect(decision.blockers).toEqual(
      expect.arrayContaining([
        "deleted_blocker",
        "deleted_success_criterion",
        "deleted_testing_requirement",
        "deleted_file_reference",
        "deleted_risk_tag",
      ]),
    );
  });

  it("rejects status changes as canonical status regressions", () => {
    const decision = evaluateEnrichmentCandidate(taskContent(), taskContent({ status: "BACKLOG" }));

    expect(decision.accepted).toBe(false);
    expect(decision.blockers).toContain("status_regression");
  });
});
