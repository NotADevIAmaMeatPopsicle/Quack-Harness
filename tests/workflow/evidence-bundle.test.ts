import { mergeEvidenceBundles, parseEvidenceBundle } from "../../src/workflow/evidence-bundle";

describe("evidence-bundle", () => {
  it("parses canonical evidence with deterministic defaults", () => {
    const bundle = parseEvidenceBundle({
      taskId: "TASK-841",
      workflowState: "reviewing",
      lane: "guarded_auto",
      riskLevel: "medium",
    });

    expect(bundle.changedFiles).toEqual([]);
    expect(bundle.buildResults).toEqual([]);
    expect(bundle.workflowState).toBe("reviewing");
  });

  it("rejects non-canonical lanes and block reason codes", () => {
    expect(() =>
      parseEvidenceBundle({
        taskId: "TASK-841",
        lane: "semi_auto",
      }),
    ).toThrow();

    expect(() =>
      parseEvidenceBundle({
        taskId: "TASK-841",
        blockReasonCode: "waiting_on_review",
      }),
    ).toThrow();
  });

  it("merges file and command evidence deterministically", () => {
    const merged = mergeEvidenceBundles(
      {
        taskId: "TASK-841",
        changedFiles: ["src/b.ts", "src/a.ts"],
        testResults: [{ name: "unit", status: "failed", exitCode: 1, summary: "old failure" }],
      },
      {
        taskId: "TASK-841",
        changedFiles: ["src/c.ts", "src/a.ts"],
        testResults: [
          { name: "unit", status: "passed", exitCode: 0, summary: "fixed" },
          { name: "lint", status: "passed", exitCode: 0 },
        ],
      },
    );

    expect(merged.changedFiles).toEqual(["src/a.ts", "src/b.ts", "src/c.ts"]);
    expect(merged.testResults).toEqual([
      expect.objectContaining({ name: "lint", status: "passed" }),
      expect.objectContaining({ name: "unit", status: "passed", summary: "fixed" }),
    ]);
  });

  it("merges review and docs evidence using canonical fields", () => {
    const merged = mergeEvidenceBundles(
      {
        taskId: "TASK-841",
        review: {
          reviewId: "review-1",
          mergeReady: false,
          docsImpact: "feature_page_update",
          requiredWikiActions: ["changelog_entry"],
          missingWikiActions: ["feature_page_update"],
          wikiArtifacts: [
            {
              pagePath: "raw/platform/changelog/task-841.md",
              commitSha: "abc123",
              linkedTaskIds: ["TASK-841"],
              action: "changelog_entry",
            },
          ],
        },
      },
      {
        taskId: "TASK-841",
        review: {
          reviewId: "review-1",
          mergeReady: true,
          docsImpact: "feature_page_update",
          requiredWikiActions: ["feature_page_update", "changelog_entry"],
          missingWikiActions: [],
          wikiArtifacts: [
            {
              pagePath: "raw/features/workflow-state.md",
              commitSha: "def456",
              linkedTaskIds: ["TASK-841"],
              action: "feature_page_update",
            },
          ],
        },
        docs: {
          docsImpact: "feature_page_update",
          requiredWikiActions: ["feature_page_update"],
          supportContentRecords: 0,
        },
      },
    );

    expect(merged.review?.mergeReady).toBe(true);
    expect(merged.review?.requiredWikiActions).toEqual(["changelog_entry", "feature_page_update"]);
    expect(merged.review?.wikiArtifacts.map((artifact) => artifact.pagePath)).toEqual([
      "raw/platform/changelog/task-841.md",
      "raw/features/workflow-state.md",
    ]);
    expect(merged.docs?.docsImpact).toBe("feature_page_update");
  });
});
