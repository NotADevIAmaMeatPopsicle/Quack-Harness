import type { ParsedTask } from "../../src/core/types";
import type { QuackEvent, SessionEntry } from "../../src/monitor/event-types";
import type { PersistedReviewBundle } from "../../src/review/docs-gate";
import { projectWorkflowState } from "../../src/workflow/state-projector";

function makeTask(status: ParsedTask["status"]): ParsedTask {
  return {
    id: "TASK-842",
    title: "Workflow State Projector",
    priority: "P0-CRITICAL",
    effort: "10-14 hours",
    status,
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: ["workflow-state"],
    problemStatement: "Need a projector.",
    currentState: "",
    recommendedApproach: "",
    filesToModify: [{ path: "src/workflow/state-projector.ts", action: "Create", notes: "" }],
    successCriteria: ["Projection exists"],
    testingRequirements: ["Unit tests pass"],
    contextReferences: [],
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    rawContent: "# TASK-842: Workflow State Projector",
  };
}

function makeReview(overrides: Partial<PersistedReviewBundle> = {}): PersistedReviewBundle {
  return {
    taskId: "TASK-842",
    verdict: "VERIFIED",
    docsImpact: "feature_page_update",
    requiredWikiActions: ["changelog_entry", "feature_page_update"],
    wikiArtifacts: [],
    reviewId: "review-task-842",
    createdAt: "2026-04-26T12:00:00.000Z",
    gate: {
      mergeReady: false,
      requiredWikiActions: ["changelog_entry", "feature_page_update"],
      missingWikiActions: ["feature_page_update"],
      issues: [
        {
          code: "missing_wiki_artifacts",
          blockReasonCode: "pending_wiki_artifacts",
          message: "Missing feature page.",
          blocking: true,
          field: "wikiArtifacts",
        },
      ],
    },
    ...overrides,
  };
}

describe("state-projector", () => {
  it("projects ready tasks to submitted state", () => {
    const projection = projectWorkflowState({ task: makeTask("READY") });

    expect(projection.state).toBe("submitted");
    expect(projection.mergeReady).toBe(false);
    expect(projection.evidenceBundle.taskId).toBe("TASK-842");
  });

  it("projects review gate blockers with canonical reason codes", () => {
    const projection = projectWorkflowState({
      task: makeTask("COMPLETE"),
      latestReview: makeReview(),
    });

    expect(projection.state).toBe("blocked");
    expect(projection.blockReasonCode).toBe("pending_wiki_artifacts");
    expect(projection.missingWikiActions).toEqual(["feature_page_update"]);
    expect(projection.blockers).toEqual([
      expect.objectContaining({
        code: "pending_wiki_artifacts",
        field: "wikiArtifacts",
      }),
    ]);
  });

  it("projects merge-ready reviews as merge_ready", () => {
    const projection = projectWorkflowState({
      task: makeTask("COMPLETE"),
      latestReview: makeReview({
        gate: {
          mergeReady: true,
          requiredWikiActions: ["changelog_entry"],
          missingWikiActions: [],
          issues: [],
        },
      }),
    });

    expect(projection.state).toBe("merge_ready");
    expect(projection.mergeReady).toBe(true);
  });

  it("does not project advisory-only review issues as blocked (TASK-1300)", () => {
    const projection = projectWorkflowState({
      task: makeTask("COMPLETE"),
      latestReview: makeReview({
        gate: {
          mergeReady: true,
          requiredWikiActions: ["changelog_entry"],
          missingWikiActions: [],
          issues: [
            {
              code: "non_canonical_status",
              blockReasonCode: "non_canonical_status",
              message: 'Task status "DONE" is non-canonical. Did you mean "COMPLETE"?',
              blocking: false,
              field: "status",
            },
          ],
        },
      }),
    });

    expect(projection.state).toBe("merge_ready");
    expect(projection.blockReasonCode).toBeUndefined();
    expect(projection.blockers).toEqual([]);
  });

  it("projects auto-merge events as merged", () => {
    const session: SessionEntry = {
      sessionId: "quack-TASK-842-1",
      taskId: "TASK-842",
      project: "quack",
      startTime: "2026-04-26T12:00:00.000Z",
      status: "completed",
    };
    const event: QuackEvent = {
      sessionId: session.sessionId,
      taskId: "TASK-842",
      project: "quack",
      timestamp: "2026-04-26T12:10:00.000Z",
      stage: "auto_merge_complete",
      payload: {
        taskId: "TASK-842",
        targetBranch: "dev",
        strategy: "no-ff",
      },
    };

    const projection = projectWorkflowState({
      task: makeTask("VERIFIED"),
      sessions: [session],
      events: [event],
    });

    expect(projection.state).toBe("merged");
    expect(projection.mergeReady).toBe(true);
    expect(projection.sessionId).toBe("quack-TASK-842-1");
  });

  // ── TASK-1332: a spec-identity refusal is blocked, WITH a reason ────
  const specChangedEvent: QuackEvent = {
    sessionId: "quack-TASK-842-1",
    taskId: "TASK-842",
    project: "quack",
    timestamp: "2026-08-15T12:00:00.000Z",
    stage: "session_complete",
    payload: { taskId: "TASK-842", outcome: "spec_changed", durationMs: 12, totalCostUsd: 0 },
  };

  it("projects a spec-identity refusal as blocked with pending_manual_handoff (R7-2)", () => {
    const projection = projectWorkflowState({
      task: makeTask("READY"),
      events: [specChangedEvent],
    });

    expect(projection.state).toBe("blocked");
    // Round 6 mapped the STATE and stopped, so this came back undefined:
    // `/workflow-state` returned a null pendingState, no
    // `workflow_pending_state` SSE fired, and a blocked transition
    // carried no canonical reason.
    expect(projection.blockReasonCode).toBe("pending_manual_handoff");
  });

  it("lets the refusal outrank a STALE review blocker (R8-4)", () => {
    // Round 8. A blocking review left over from an earlier run overwrote
    // the fresh refusal reason, so the operator was told to go fix
    // documentation for a run that had refused to start. The refusal is a
    // terminal event on the CURRENT run and outranks it.
    const projection = projectWorkflowState({
      task: makeTask("READY"),
      events: [specChangedEvent],
      latestReview: makeReview(),
    });

    expect(projection.state).toBe("blocked");
    expect(projection.blockReasonCode).toBe("pending_manual_handoff");
    // Round 9 (R9-3): and the BLOCKERS list too. Round 8 moved the reason
    // code and left this returning the stale review blockers, so the
    // projection contradicted itself, a manual-handoff badge beside a
    // "fix the wiki artifacts" list, which is what the dashboard renders.
    expect(projection.blockers).toEqual([
      expect.objectContaining({ code: "pending_manual_handoff" }),
    ]);
  });

  it("still surfaces review blockers when there is no refusal (R9-3 control)", () => {
    // The control. Without it, suppressing review blockers unconditionally
    // would pass the arm above and silently break every ordinary review
    // gate.
    const projection = projectWorkflowState({
      task: makeTask("COMPLETE"),
      latestReview: makeReview(),
    });

    expect(projection.blockReasonCode).toBe("pending_wiki_artifacts");
    expect(projection.blockers).toEqual([
      expect.objectContaining({ code: "pending_wiki_artifacts" }),
    ]);
  });
});
