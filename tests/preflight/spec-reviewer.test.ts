import { reviewSpecAmbiguity, _setQueryFn } from "../../src/preflight/spec-reviewer";
import type { AmbiguityFinding } from "../../src/preflight/spec-review-types";
import type { ParsedTask } from "../../src/core/types";

// ─── Helpers ──────────────────────────────────────────────────────

function makeTask(overrides: Partial<ParsedTask> = {}): ParsedTask {
  return {
    id: "TASK-099",
    title: "Test task",
    priority: "P2-MEDIUM",
    effort: "2-4 hours",
    status: "READY",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: [],
    problemStatement: "Test problem",
    currentState: "Test state",
    recommendedApproach: "Test approach",
    filesToModify: [
      { path: "src/server.ts", action: "Modify", notes: "" },
      { path: "src/client.ts", action: "Modify", notes: "" },
    ],
    successCriteria: ["API endpoint returns result", "Dashboard shows progress bar"],
    testingRequirements: [],
    contextReferences: [],
    rawContent: "# TASK-099\nTest spec content",
    ...overrides,
  };
}

/**
 * Mock query function that returns a canned structured_output response.
 */
function makeMockQueryFn(findings: AmbiguityFinding[], suggestedClarifications: string[]) {
  // eslint-disable-next-line @typescript-eslint/require-await
  return async function* mockQueryFn() {
    yield {
      type: "result",
      subtype: "success",
      result: "Mock result text",
      structured_output: {
        findings,
        suggestedClarifications,
      },
    };
  };
}

// ─── Tests ─────────────────────────────────────────────────────────

describe("reviewSpecAmbiguity", () => {
  afterEach(() => {
    _setQueryFn(undefined); // Reset mock
  });

  it("returns low risk for unambiguous spec (0 findings)", async () => {
    const task = makeTask();
    _setQueryFn(makeMockQueryFn([], []) as never);

    const result = await reviewSpecAmbiguity(task);

    expect(result.riskLevel).toBe("low");
    expect(result.ambiguityCount).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it("flags visual ambiguity (progress bar without specifying type)", async () => {
    const task = makeTask({
      successCriteria: ["Dashboard shows progress bar"],
    });
    const findings: AmbiguityFinding[] = [
      {
        criterionIndex: 0,
        criterionText: "Dashboard shows progress bar",
        dimension: "visual_ambiguity",
        explanation: "Could mean single-color bar, stacked bar chart, or circular progress",
        clarificationQuestion:
          "Should this be a single-color bar or a stacked/segmented bar chart?",
        severity: "medium",
      },
    ];
    _setQueryFn(
      makeMockQueryFn(findings, [
        "Specify exact layout: stacked bar chart with colored segments",
      ]) as never,
    );

    const result = await reviewSpecAmbiguity(task);

    expect(result.riskLevel).toBe("medium");
    expect(result.ambiguityCount).toBe(1);
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0].dimension).toBe("visual_ambiguity");
  });

  it("flags interface contract gap (endpoint without response schema)", async () => {
    const task = makeTask({
      successCriteria: ["API endpoint returns decomposition result"],
    });
    const findings: AmbiguityFinding[] = [
      {
        criterionIndex: 0,
        criterionText: "API endpoint returns decomposition result",
        dimension: "interface_gap",
        explanation: "No JSON schema or field list for response payload",
        clarificationQuestion:
          "What fields should the response contain? What is the JSON structure?",
        severity: "high",
      },
    ];
    _setQueryFn(makeMockQueryFn(findings, ["Add JSON schema for endpoint response"]) as never);

    const result = await reviewSpecAmbiguity(task);

    expect(result.riskLevel).toBe("high");
    expect(result.ambiguityCount).toBe(1);
    expect(result.findings[0].dimension).toBe("interface_gap");
    expect(result.findings[0].severity).toBe("high");
  });

  it("flags integration_gap (new CLI file without index.ts integration)", async () => {
    const task = makeTask({
      filesToModify: [{ path: "src/cli/new-command.ts", action: "Create", notes: "" }],
      successCriteria: ["New CLI command is available"],
    });
    const findings: AmbiguityFinding[] = [
      {
        criterionIndex: 0,
        criterionText: "New CLI command is available",
        dimension: "integration_gap",
        explanation:
          "New CLI command file created but index.ts not in filesToModify for registration",
        clarificationQuestion:
          "Should src/index.ts be added to filesToModify to register the command?",
        severity: "high",
      },
    ];
    _setQueryFn(makeMockQueryFn(findings, ["Add src/index.ts to filesToModify"]) as never);

    const result = await reviewSpecAmbiguity(task);

    expect(result.riskLevel).toBe("high");
    expect(result.findings[0].dimension).toBe("integration_gap");
    expect(result.findings[0].severity).toBe("high");
  });

  it("returns no integration_gap when integration files present", async () => {
    const task = makeTask({
      filesToModify: [
        { path: "src/cli/new-command.ts", action: "Create", notes: "" },
        { path: "src/index.ts", action: "Modify", notes: "Register command" },
      ],
      successCriteria: ["New CLI command is available"],
    });
    _setQueryFn(makeMockQueryFn([], []) as never);

    const result = await reviewSpecAmbiguity(task);

    expect(result.riskLevel).toBe("low");
    expect(result.findings).toHaveLength(0);
  });

  it("flags integration_gap with high severity escalates to high risk", async () => {
    const task = makeTask();
    const findings: AmbiguityFinding[] = [
      {
        criterionIndex: 0,
        criterionText: "Some criterion",
        dimension: "integration_gap",
        explanation: "Missing integration wiring",
        clarificationQuestion: "Add integration file?",
        severity: "high",
      },
    ];
    _setQueryFn(makeMockQueryFn(findings, []) as never);

    const result = await reviewSpecAmbiguity(task);

    expect(result.riskLevel).toBe("high");
    expect(result.findings[0].dimension).toBe("integration_gap");
  });

  it("flags criterion-to-file mapping gap (criterion references unlisted file)", async () => {
    const task = makeTask({
      filesToModify: [{ path: "src/client.ts", action: "Modify", notes: "" }],
      successCriteria: ["Server endpoint handles request"],
    });
    const findings: AmbiguityFinding[] = [
      {
        criterionIndex: 0,
        criterionText: "Server endpoint handles request",
        dimension: "file_mapping",
        explanation: "Criterion mentions server endpoint but only client files are listed",
        clarificationQuestion: "Should src/server.ts be added to filesToModify?",
        severity: "high",
      },
    ];
    _setQueryFn(makeMockQueryFn(findings, ["Add src/server.ts to filesToModify"]) as never);

    const result = await reviewSpecAmbiguity(task);

    expect(result.riskLevel).toBe("high");
    expect(result.findings[0].dimension).toBe("file_mapping");
  });

  it("calculates high risk for any high-severity finding", async () => {
    const task = makeTask();
    const findings: AmbiguityFinding[] = [
      {
        criterionIndex: 0,
        criterionText: "Some criterion",
        dimension: "criterion_ambiguity",
        explanation: "Critical ambiguity",
        clarificationQuestion: "Clarify this",
        severity: "high",
      },
    ];
    _setQueryFn(makeMockQueryFn(findings, []) as never);

    const result = await reviewSpecAmbiguity(task);

    expect(result.riskLevel).toBe("high");
  });

  it("calculates high risk for 3+ findings even if all medium severity", async () => {
    const task = makeTask();
    const findings: AmbiguityFinding[] = [
      {
        criterionIndex: 0,
        criterionText: "A",
        dimension: "criterion_ambiguity",
        explanation: "X",
        clarificationQuestion: "Q1",
        severity: "medium",
      },
      {
        criterionIndex: 1,
        criterionText: "B",
        dimension: "visual_ambiguity",
        explanation: "Y",
        clarificationQuestion: "Q2",
        severity: "medium",
      },
      {
        criterionIndex: 2,
        criterionText: "C",
        dimension: "ownership_ambiguity",
        explanation: "Z",
        clarificationQuestion: "Q3",
        severity: "medium",
      },
    ];
    _setQueryFn(makeMockQueryFn(findings, []) as never);

    const result = await reviewSpecAmbiguity(task);

    expect(result.riskLevel).toBe("high");
    expect(result.ambiguityCount).toBe(3);
  });

  it("calculates medium risk for 1-2 medium-severity findings", async () => {
    const task = makeTask();
    const findings: AmbiguityFinding[] = [
      {
        criterionIndex: 0,
        criterionText: "A",
        dimension: "criterion_ambiguity",
        explanation: "X",
        clarificationQuestion: "Q1",
        severity: "medium",
      },
      {
        criterionIndex: 1,
        criterionText: "B",
        dimension: "visual_ambiguity",
        explanation: "Y",
        clarificationQuestion: "Q2",
        severity: "medium",
      },
    ];
    _setQueryFn(makeMockQueryFn(findings, []) as never);

    const result = await reviewSpecAmbiguity(task);

    expect(result.riskLevel).toBe("medium");
    expect(result.ambiguityCount).toBe(2);
  });

  it("accepts optional model parameter", async () => {
    const task = makeTask();
    _setQueryFn(makeMockQueryFn([], []) as never);

    const result = await reviewSpecAmbiguity(task, { model: "claude-opus-4-6" });

    expect(result.riskLevel).toBe("low");
  });
});
