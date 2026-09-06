import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  blockedOnlyByDocsDebt,
  evaluateReviewGate,
  type PersistedReviewBundle,
  requiredActionsForDocsImpact,
  runDocsPipeline,
} from "../../src/review/docs-gate";
import type { ReviewGateResult } from "../../src/review/docs-gate";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-docs-gate-"));
}

describe("blockedOnlyByDocsDebt (TASK-1328 ledger admission test)", () => {
  const base = (over: Partial<ReviewGateResult>): ReviewGateResult =>
    ({
      mergeReady: false,
      requiredWikiActions: [],
      issues: [],
      ...over,
    }) as ReviewGateResult;

  it("admits a merge-ready gate", () => {
    expect(blockedOnlyByDocsDebt(base({ mergeReady: true }))).toBe(true);
  });

  it("admits a gate blocked ONLY by docs debt", () => {
    expect(
      blockedOnlyByDocsDebt(
        base({
          issues: [
            { code: "missing_wiki_artifacts", message: "m", blocking: true },
            { code: "non_canonical_status", message: "advisory", blocking: false },
          ],
        } as Partial<ReviewGateResult>),
      ),
    ).toBe(true);
  });

  it("refuses when an INTEGRITY blocker is present alongside docs debt", () => {
    expect(
      blockedOnlyByDocsDebt(
        base({
          issues: [
            { code: "missing_wiki_artifacts", message: "m", blocking: true },
            { code: "unresolved_high_severity_finding", message: "P1", blocking: true },
          ],
        } as Partial<ReviewGateResult>),
      ),
    ).toBe(false);
  });

  it("refuses a checklist mismatch", () => {
    expect(
      blockedOnlyByDocsDebt(
        base({
          issues: [{ code: "verified_unchecked_checklists", message: "m", blocking: true }],
        } as Partial<ReviewGateResult>),
      ),
    ).toBe(false);
  });

  // The self-caught hole: in ENFORCE mode the judgment sets mergeReady from
  // its own action and adds NO issue, so a refused review presents an empty
  // blocker list. "No integrity blockers" would have admitted it.
  it("refuses a NOT-merge-ready gate carrying no blocking issues at all", () => {
    expect(blockedOnlyByDocsDebt(base({ mergeReady: false, issues: [] }))).toBe(false);
  });

  it("refuses when only ADVISORY issues are present but mergeReady is false", () => {
    expect(
      blockedOnlyByDocsDebt(
        base({
          issues: [{ code: "non_canonical_status", message: "advisory", blocking: false }],
        } as Partial<ReviewGateResult>),
      ),
    ).toBe(false);
  });
});

describe("docs-gate", () => {
  it("passes changelog_only when changelog artifact is present", () => {
    const gate = evaluateReviewGate({
      taskId: "TASK-100",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-100.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-100"],
          action: "changelog_entry",
        },
      ],
    });

    expect(gate.mergeReady).toBe(true);
    expect(gate.requiredWikiActions).toEqual(["changelog_entry"]);
    expect(gate.missingWikiActions).toHaveLength(0);
  });

  it("fails feature_page_update when feature wiki artifact is missing", () => {
    const gate = evaluateReviewGate({
      taskId: "TASK-101",
      verdict: "VERIFIED",
      docsImpact: "feature_page_update",
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-101.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-101"],
          action: "changelog_entry",
        },
      ],
    });

    expect(gate.mergeReady).toBe(false);
    expect(gate.requiredWikiActions).toEqual(requiredActionsForDocsImpact("feature_page_update"));
    expect(gate.missingWikiActions).toContain("feature_page_update");
    expect(gate.issues.some((issue) => issue.code === "missing_wiki_artifacts")).toBe(true);
    expect(gate.issues.some((issue) => issue.blockReasonCode === "pending_wiki_artifacts")).toBe(
      true,
    );
  });

  it("flags non-canonical status prose", () => {
    const taskContent = [
      "# TASK-889: Inventory Search Server Wiring",
      "",
      "## Metadata",
      "- **Status:** IMPLEMENTED IN FRONTEND SLICE",
      "",
      "## Success Criteria",
      "- [x] Server endpoint exists",
      "",
      "## Testing Requirements",
      "- [x] Integration test added",
      "",
    ].join("\n");

    const gate = evaluateReviewGate(
      {
        taskId: "TASK-889",
        verdict: "VERIFIED",
        docsImpact: "changelog_only",
        wikiArtifacts: [
          {
            pagePath: "raw/platform/changelog/2026-04-26-task-889.md",
            commitSha: "abc1234",
            linkedTaskIds: ["TASK-889"],
            action: "changelog_entry",
          },
        ],
      },
      taskContent,
    );

    // Non-canonical status is an advisory, not a merge blocker (TASK-1300 / v2 P0-5).
    expect(gate.mergeReady).toBe(true);
    const statusIssue = gate.issues.find((issue) => issue.code === "non_canonical_status");
    expect(statusIssue).toBeDefined();
    expect(statusIssue?.blocking).toBe(false);
    expect(statusIssue?.blockReasonCode).toBe("non_canonical_status");
    expect(statusIssue?.message).toContain("Use one of:");
  });

  it("accepts DECOMPOSED as canonical status", () => {
    const taskContent = [
      "# TASK-900: Split large rollout",
      "",
      "## Metadata",
      "- **Status:** DECOMPOSED",
      "",
      "## Success Criteria",
      "- [x] Parent task split into tracked subtasks",
      "",
      "## Testing Requirements",
      "- [x] Follow-up subtasks include validation steps",
      "",
    ].join("\n");

    const gate = evaluateReviewGate(
      {
        taskId: "TASK-900",
        verdict: "VERIFIED",
        docsImpact: "changelog_only",
        wikiArtifacts: [
          {
            pagePath: "raw/platform/changelog/2026-04-26-task-900.md",
            commitSha: "abc1234",
            linkedTaskIds: ["TASK-900"],
            action: "changelog_entry",
          },
        ],
      },
      taskContent,
    );

    expect(gate.mergeReady).toBe(true);
    expect(gate.issues.some((issue) => issue.code === "non_canonical_status")).toBe(false);
  });

  it("flags VERIFIED status with unchecked checklists", () => {
    const taskContent = [
      "# TASK-861: Ambient Display Port",
      "",
      "## Metadata",
      "- **Status:** VERIFIED",
      "",
      "## Success Criteria",
      "- [ ] Ambient mode toggles from settings",
      "",
      "## Testing Requirements",
      "- [ ] Visual regression run captured",
      "",
    ].join("\n");

    const gate = evaluateReviewGate(
      {
        taskId: "TASK-861",
        verdict: "VERIFIED",
        docsImpact: "changelog_only",
        wikiArtifacts: [
          {
            pagePath: "raw/platform/changelog/2026-04-26-task-861.md",
            commitSha: "abc1234",
            linkedTaskIds: ["TASK-861"],
            action: "changelog_entry",
          },
        ],
      },
      taskContent,
    );

    expect(gate.mergeReady).toBe(false);
    expect(gate.issues.some((issue) => issue.code === "verified_unchecked_checklists")).toBe(true);
    expect(gate.issues.some((issue) => issue.blockReasonCode === "checklist_mismatch")).toBe(true);
  });

  it("fails support_bundle when supportDocCandidates are missing", () => {
    const gate = evaluateReviewGate({
      taskId: "TASK-102",
      verdict: "VERIFIED",
      docsImpact: "support_bundle",
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-102.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-102"],
          action: "changelog_entry",
        },
        {
          pagePath: "raw/features/dashboard/ambient-display.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-102"],
          action: "feature_page_update",
        },
        {
          pagePath: "raw/support/kb/ambient-display.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-102"],
          action: "support_bundle",
        },
      ],
    });

    expect(gate.mergeReady).toBe(false);
    expect(gate.issues.some((issue) => issue.code === "missing_support_doc_candidates")).toBe(true);
    expect(
      gate.issues.some((issue) => issue.blockReasonCode === "missing_support_candidates"),
    ).toBe(true);
  });

  it("writes changelog + feature + support content from pipeline", async () => {
    const projectRoot = makeTempDir();
    const review: PersistedReviewBundle = {
      reviewId: "review-task-200",
      createdAt: "2026-04-26T12:00:00.000Z",
      taskId: "TASK-200",
      verdict: "VERIFIED",
      docsImpact: "support_bundle",
      summary: "Ambient display rollout complete.",
      requiredWikiActions: ["changelog_entry", "feature_page_update", "support_bundle"],
      wikiArtifacts: [
        {
          pagePath: "raw/platform/changelog/2026-04-26-task-200.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-200"],
          action: "changelog_entry",
        },
        {
          pagePath: "raw/features/dashboard/ambient-display.md",
          commitSha: "abc1234",
          linkedTaskIds: ["TASK-200"],
          action: "feature_page_update",
        },
      ],
      supportDocCandidates: [
        {
          title: "How Ambient Display works",
          summary: "Explains activation and timeout behavior.",
          productArea: "web-dashboard",
          linkedTaskIds: ["TASK-200"],
          tags: ["ambient", "display"],
        },
      ],
      gate: {
        mergeReady: true,
        requiredWikiActions: ["changelog_entry", "feature_page_update", "support_bundle"],
        missingWikiActions: [],
        issues: [],
      },
    };

    const result = await runDocsPipeline(projectRoot, review);
    expect(result.changelogPath).toBeDefined();
    expect(result.featureUpdatesPath).toBeDefined();
    expect(result.supportContentPath).toBeDefined();
    expect(result.emittedSupportRecords).toBe(1);

    const changelog = fs.readFileSync(result.changelogPath!, "utf-8");
    expect(changelog).toContain("TASK-200");
    expect(changelog).toContain("Docs Impact: support_bundle");

    const feature = fs.readFileSync(result.featureUpdatesPath!, "utf-8");
    expect(feature).toContain("ambient-display.md");

    const support = fs.readFileSync(result.supportContentPath!, "utf-8");
    expect(support).toContain('"title":"How Ambient Display works"');
    expect(support).toContain('"taskId":"TASK-200"');

    fs.rmSync(projectRoot, { recursive: true, force: true });
  });
});

// ─── TASK-1300: tolerant status parsing + multi-format checklists ───

function specWith(statusLine: string, criteria: string, testing = "- [x] done"): string {
  return [
    "# TASK-999: fixture",
    "",
    "## Metadata",
    statusLine,
    "",
    "## Success Criteria",
    criteria,
    "",
    "## Testing Requirements",
    testing,
    "",
  ].join("\n");
}

const CHANGELOG_ARTIFACT = {
  pagePath: "raw/platform/changelog/2026-07-14-task-999.md",
  commitSha: "abc1234",
  linkedTaskIds: ["TASK-999"],
  action: "changelog_entry" as const,
};

function gateFor(taskContent: string) {
  return evaluateReviewGate(
    {
      taskId: "TASK-999",
      verdict: "VERIFIED",
      docsImpact: "changelog_only",
      wikiArtifacts: [CHANGELOG_ARTIFACT],
    },
    taskContent,
  );
}

describe("tolerant status parsing (TASK-1300)", () => {
  const parseableShapes: Array<[string, string]> = [
    ["bold bullet", "- **Status:** COMPLETE"],
    ["bold no bullet", "**Status:** COMPLETE"],
    ["plain", "Status: COMPLETE"],
    ["bullet plain", "- Status: COMPLETE"],
  ];

  for (const [label, line] of parseableShapes) {
    it(`parses the ${label} shape inside ## Metadata (mergeReady, no status issues)`, () => {
      const gate = gateFor(specWith(line, "- [x] item"));
      expect(gate.mergeReady).toBe(true);
      expect(gate.issues.filter((i) => i.field === "status")).toHaveLength(0);
    });
  }

  it("missing status line is an advisory, not a blocker", () => {
    const gate = gateFor(specWith("- **Priority:** P1-HIGH", "- [x] item"));
    const issue = gate.issues.find((i) => i.code === "missing_status");
    expect(issue).toBeDefined();
    expect(issue?.blocking).toBe(false);
    expect(gate.mergeReady).toBe(true);
  });

  it("suggests COMPLETE for DONE", () => {
    const gate = gateFor(specWith("- **Status:** DONE", "- [x] item"));
    const issue = gate.issues.find((i) => i.code === "non_canonical_status");
    expect(issue?.blocking).toBe(false);
    expect(issue?.message).toContain('Did you mean "COMPLETE"?');
    expect(gate.mergeReady).toBe(true);
  });

  it("still normalizes known aliases silently", () => {
    const gate = gateFor(specWith("- **Status:** IN PROGRESS", "- [ ] item"));
    expect(gate.issues.filter((i) => i.field === "status")).toHaveLength(0);
    // IN_PROGRESS is not a done status, so unchecked items do not block.
    expect(gate.mergeReady).toBe(true);
  });

  it("ignores line-start Status: text outside ## Metadata (code fences, prose)", () => {
    const content = [
      "# TASK-999: fixture",
      "",
      "## Problem Statement",
      "```",
      "Status: TODO",
      "```",
      "Status: this sentence describes state in prose.",
      "",
      "## Metadata",
      "- **Status:** VERIFIED",
      "",
      "## Success Criteria",
      "- [x] item",
      "",
      "## Testing Requirements",
      "- [x] done",
      "",
    ].join("\n");
    const gate = gateFor(content);
    // The Metadata section's VERIFIED wins; the fence/prose lines are never read.
    expect(gate.issues.filter((i) => i.field === "status")).toHaveLength(0);
    expect(gate.mergeReady).toBe(true);
  });

  it("falls back to the strict whole-doc shape when no ## Metadata section exists", () => {
    const content = [
      "# TASK-999: fixture",
      "",
      "- **Status:** VERIFIED",
      "",
      "## Success Criteria",
      "- [x] item",
      "",
      "## Testing Requirements",
      "- [x] done",
      "",
    ].join("\n");
    const gate = gateFor(content);
    expect(gate.issues.filter((i) => i.field === "status")).toHaveLength(0);
    expect(gate.mergeReady).toBe(true);
  });
});

describe("multi-format checklist counting (TASK-1300)", () => {
  const uncheckedShapes: Array<[string, string]> = [
    ["dash", "- [ ] item"],
    ["star", "* [ ] item"],
    ["plus", "+ [ ] item"],
    ["numbered dot", "1. [ ] item"],
    ["numbered paren", "1) [ ] item"],
    ["bare brackets", "- [] item"],
    ["no trailing space", "- [ ]item"],
    ["html", '<input type="checkbox"> item'],
  ];

  for (const [label, line] of uncheckedShapes) {
    it(`counts an unchecked ${label} item and blocks a VERIFIED claim`, () => {
      const gate = gateFor(specWith("- **Status:** VERIFIED", line));
      const issue = gate.issues.find((i) => i.code === "verified_unchecked_checklists");
      expect(issue).toBeDefined();
      expect(issue?.blocking).toBe(true);
      expect(gate.mergeReady).toBe(false);
    });
  }

  const checkedShapes: Array<[string, string]> = [
    ["numbered dot", "1. [x] item"],
    ["uppercase X", "- [X] item"],
    ["html checked", '<input type="checkbox" checked> item'],
  ];

  for (const [label, line] of checkedShapes) {
    it(`counts a checked ${label} item as satisfied`, () => {
      const gate = gateFor(specWith("- **Status:** VERIFIED", line));
      expect(gate.issues.filter((i) => i.code === "verified_unchecked_checklists")).toHaveLength(0);
      expect(gate.mergeReady).toBe(true);
    });
  }

  it("does not count markdown links or task references as checkboxes", () => {
    const gate = gateFor(
      specWith(
        "- **Status:** VERIFIED",
        [
          "- [x](https://example.com) link not checkbox",
          "- [TASK-016] reference item",
          "- [x] real checked",
        ].join("\n"),
      ),
    );
    expect(gate.issues.filter((i) => i.code === "verified_unchecked_checklists")).toHaveLength(0);
    expect(gate.mergeReady).toBe(true);
  });

  it("flags checklist_not_countable when a done status has prose-only sections", () => {
    const gate = gateFor(
      specWith("- **Status:** COMPLETE", "All behaviors verified in prose.", "Covered by CI."),
    );
    const issue = gate.issues.find((i) => i.code === "checklist_not_countable");
    expect(issue).toBeDefined();
    expect(issue?.blocking).toBe(false);
    expect(issue?.blockReasonCode).toBe("checklist_mismatch");
    expect(gate.mergeReady).toBe(true);
  });

  it("does not flag checklist_not_countable for non-done statuses or empty sections", () => {
    const inProgress = gateFor(specWith("- **Status:** IN_PROGRESS", "Prose only.", "Prose only."));
    expect(inProgress.issues.filter((i) => i.code === "checklist_not_countable")).toHaveLength(0);

    const emptySections = gateFor(specWith("- **Status:** COMPLETE", "", ""));
    expect(emptySections.issues.filter((i) => i.code === "checklist_not_countable")).toHaveLength(
      0,
    );
  });

  it("keeps blocking a COMPLETE claim with a previously-invisible numbered unchecked item", () => {
    const gate = gateFor(
      specWith("- **Status:** COMPLETE", "1. [x] done item\n2. [ ] forgotten item"),
    );
    const issue = gate.issues.find((i) => i.code === "complete_unchecked_checklists");
    expect(issue?.blocking).toBe(true);
    expect(gate.mergeReady).toBe(false);
  });
});
