import {
  normalizeCanonicalTaskStatus,
  validateWorkflowInvariants,
  validateWorkflowTransition,
} from "../../src/workflow/workflow-state-machine";

describe("workflow-state-machine", () => {
  it("allows canonical primary-path transitions when required artifacts exist", () => {
    const result = validateWorkflowTransition({
      fromState: "submitted",
      toState: "classified",
      trigger: "lane_classified",
      artifacts: {
        lane: "auto",
        riskLevel: "low",
        classificationReasons: ["typed_code_change"],
      },
    });

    expect(result.allowed).toBe(true);
    expect(result.missingArtifacts).toEqual([]);
  });

  it("rejects valid transition pairs when required artifacts are missing", () => {
    const result = validateWorkflowTransition({
      fromState: "executing",
      toState: "verify_fix",
      trigger: "verify_fix_started",
      artifacts: {},
    });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("missing_required_artifact");
    expect(result.missingArtifacts).toEqual(["workflowRecord"]);
  });

  it("allows canonical blocked transitions with state-appropriate block reasons", () => {
    const result = validateWorkflowTransition({
      fromState: "assigned",
      toState: "blocked",
      trigger: "listener_unavailable",
      blockReasonCode: "pending_remote_listener",
    });

    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBe("pending_remote_listener");
  });

  it("allows pending_manual_handoff from executing, where a spec refusal lands (TASK-1332 R8-4)", () => {
    // A spec-identity refusal stops the run mid-execution and hands it to
    // an operator, so `executing -> blocked (pending_manual_handoff)` is
    // the transition it needs. The validator allowed that reason only
    // from `verify_fix`, so the projection was rejected as
    // `invalid_block_reason` and the blocked state carried no reason.
    const result = validateWorkflowTransition({
      fromState: "executing",
      toState: "blocked",
      trigger: "spec_identity_refusal",
      blockReasonCode: "pending_manual_handoff",
    });

    expect(result.allowed).toBe(true);
    expect(result.reasonCode).toBe("pending_manual_handoff");
  });

  it("rejects blocked transitions with reason codes from the wrong branch", () => {
    const result = validateWorkflowTransition({
      fromState: "reviewing",
      toState: "blocked",
      trigger: "listener_unavailable",
      blockReasonCode: "pending_remote_listener",
    });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("invalid_block_reason");
  });

  it("rejects transitions out of terminal states", () => {
    const result = validateWorkflowTransition({
      fromState: "merged",
      toState: "executing",
      trigger: "job_accepted",
      artifacts: {
        jobId: "job-1",
        dispatchSessionRef: "session-1",
      },
    });

    expect(result.allowed).toBe(false);
    expect(result.reasonCode).toBe("terminal_state");
  });

  it("normalizes accepted task status aliases", () => {
    expect(normalizeCanonicalTaskStatus("in progress")).toBe("IN_PROGRESS");
    expect(normalizeCanonicalTaskStatus("COMPLETE (verified externally)")).toBe("COMPLETE");
  });

  it("flags non-canonical task status invariants", () => {
    const issues = validateWorkflowInvariants({
      taskStatus: "DONE",
      successCriteria: { checked: 2, unchecked: 0 },
      testingRequirements: { checked: 1, unchecked: 0 },
    });

    expect(issues).toEqual([
      expect.objectContaining({
        code: "non_canonical_status",
        field: "status",
      }),
    ]);
  });

  it("flags COMPLETE or VERIFIED checklist mismatches", () => {
    const issues = validateWorkflowInvariants({
      taskStatus: "VERIFIED",
      successCriteria: { checked: 1, unchecked: 1 },
      testingRequirements: { checked: 2, unchecked: 0 },
    });

    expect(issues).toEqual([
      expect.objectContaining({
        code: "checklist_mismatch",
        field: "status",
      }),
    ]);
  });
});
