// TASK-1338-C pre-change record: every provisioned route reached its real
// mutation and returned success. Each behavioral case failed at the pinned
// 409 assertion. The no-op cases are controls for earlier unchanged returns.

import * as fs from "node:fs";
import * as path from "node:path";

import { savePendingApproval } from "../../src/dispatcher/blueprint-approval";
import { CheckpointManager } from "../../src/dispatcher/checkpoint-manager";
import { savePendingJudgeApproval } from "../../src/dispatcher/judge-approval";
import { DispatchManager, type DispatchJob } from "../../src/monitor/dispatch-manager";
import { createMonitorServer } from "../../src/monitor/server";
import {
  DUPLICATE_FIXTURE_CASES,
  createDuplicateFixture,
  createSingleClaimantFixture,
  expectPinnedHttpRefusal,
  postJson,
  removeFixture,
  writeAdapter,
} from "../helpers/duplicate-claimants-fixture";

type Surface =
  | "start"
  | "revise"
  | "blueprint-approve"
  | "judge-approve"
  | "judge-reject"
  | "force-retry"
  | "resume";

const SURFACES: Surface[] = [
  "start",
  "revise",
  "blueprint-approve",
  "judge-approve",
  "judge-reject",
  "force-retry",
  "resume",
];

function makeJob(taskId: string): DispatchJob {
  return {
    taskId,
    sessionId: `session-${taskId}`,
    pid: 41,
    startedAt: new Date().toISOString(),
    status: "running",
    output: [],
  };
}

function testPort(): number {
  return 0;
}

function writeSessionEvidence(logDir: string, includeJudge: boolean): void {
  const sessionId = "session-prior";
  fs.writeFileSync(
    path.join(logDir, "sessions.jsonl"),
    JSON.stringify({
      sessionId,
      taskId: "TASK-100",
      project: "fixture",
      startTime: "2026-08-18T00:00:00.000Z",
      status: "completed",
      outcome: "rejected",
    }) + "\n",
  );
  const events = includeJudge
    ? [
        JSON.stringify({
          sessionId,
          taskId: "TASK-100",
          project: "fixture",
          timestamp: "2026-08-18T00:01:00.000Z",
          stage: "judge_result",
          payload: {
            verdict: "REVISE",
            feedback: "fixture feedback",
            scopeViolations: [],
            criteriaGaps: [],
            qualityIssues: [],
          },
        }),
      ]
    : [];
  fs.writeFileSync(
    path.join(logDir, `events-${sessionId}.jsonl`),
    events.join("\n") + (events.length ? "\n" : ""),
  );
}

async function provision(surface: Surface, root: string): Promise<string | undefined> {
  const logDir = path.join(root, ".quack", "logs");
  if (surface === "revise") writeSessionEvidence(logDir, false);
  if (surface === "force-retry") writeSessionEvidence(logDir, true);
  if (surface === "blueprint-approve") {
    await savePendingApproval(
      "TASK-100",
      {
        taskId: "TASK-100",
        fileAnalyses: [],
        codeExamples: [],
        verificationPatterns: [],
        antiPatterns: [],
        preconditions: [],
      },
      undefined,
      logDir,
    );
    return path.join(logDir, "approvals", "TASK-100.json");
  }
  if (surface === "judge-approve" || surface === "judge-reject") {
    await savePendingJudgeApproval("TASK-100", "diff", ["src/file.ts"], true, logDir);
    return path.join(logDir, "approvals", "TASK-100-judge.json");
  }
  if (surface === "resume") {
    const checkpointPath = path.join(logDir, "checkpoints", "TASK-100.json");
    await new CheckpointManager(logDir).save({
      taskId: "TASK-100",
      sessionId: "session-resume",
      completedStages: ["gate"],
      claudeSessionId: "claude-resume",
      totalCostUsd: 0,
      retriesUsed: 0,
      updatedAt: "2026-08-18T00:00:00.000Z",
      startedAt: "2026-08-18T00:00:00.000Z",
    });
    return checkpointPath;
  }
  return undefined;
}

function requestFor(surface: Surface): { pathname: string; body: Record<string, unknown> } {
  switch (surface) {
    case "start":
      return {
        pathname: "/api/tasks/TASK-100/start",
        body: { localSmokeOnly: true, skipGate: true, skipDecomposeCheck: true },
      };
    case "revise":
      return {
        pathname: "/api/tasks/TASK-100/revise",
        body: { localSmokeOnly: true, feedback: "retry" },
      };
    case "blueprint-approve":
      return { pathname: "/api/tasks/TASK-100/blueprint/approve", body: {} };
    case "judge-approve":
      return { pathname: "/api/tasks/TASK-100/judge/approve", body: {} };
    case "judge-reject":
      return { pathname: "/api/tasks/TASK-100/judge/reject", body: { rejectionReason: "retry" } };
    case "force-retry":
      return { pathname: "/api/tasks/TASK-100/force-retry", body: {} };
    case "resume":
      return { pathname: "/api/tasks/TASK-100/resume", body: {} };
  }
}

describe.each(DUPLICATE_FIXTURE_CASES)("direct route admission veto (%s, %s)", (kind, order) => {
  it.each(SURFACES)("%s refuses before route-specific mutation", async (surface) => {
    const fixture = createDuplicateFixture(`quack-route-${surface}-`, kind, order);
    let stop: (() => Promise<void>) | undefined;
    const startSpy = jest
      .spyOn(DispatchManager.prototype, "start")
      .mockImplementation((taskId) => makeJob(taskId));
    try {
      const adapterPath = writeAdapter(fixture.root);
      const artifactPath = await provision(surface, fixture.root);
      const artifactBefore =
        artifactPath && fs.existsSync(artifactPath)
          ? fs.readFileSync(artifactPath, "utf-8")
          : undefined;
      const monitor = createMonitorServer({
        port: testPort(),
        projectRoot: fixture.root,
        taskDir: "docs/tasks",
        adapterPath,
        logDir: path.join(fixture.root, ".quack", "logs"),
      });
      const started = await monitor.start();
      stop = started.stop;
      const request = requestFor(surface);

      const response = await postJson(started.port, request.pathname, request.body);

      expectPinnedHttpRefusal(response, fixture.claimants);
      expect(startSpy).not.toHaveBeenCalled();
      if (artifactPath && artifactBefore !== undefined) {
        expect(fs.readFileSync(artifactPath, "utf-8")).toBe(artifactBefore);
      }
    } finally {
      await stop?.();
      startSpy.mockRestore();
      removeFixture(fixture.root);
    }
  });
});

it("single claimant START preserves the success response and dispatch mutation", async () => {
  const fixture = createSingleClaimantFixture("quack-route-start-clean-");
  const startSpy = jest
    .spyOn(DispatchManager.prototype, "start")
    .mockReturnValue(makeJob("TASK-100"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const adapterPath = writeAdapter(fixture.root);
    const monitor = createMonitorServer({
      port: testPort(),
      projectRoot: fixture.root,
      taskDir: "docs/tasks",
      adapterPath,
      logDir: path.join(fixture.root, ".quack", "logs"),
    });
    const started = await monitor.start();
    stop = started.stop;

    const response = await postJson(started.port, "/api/tasks/TASK-100/start", {
      localSmokeOnly: true,
      skipGate: true,
      skipDecomposeCheck: true,
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      ok: true,
      taskId: "TASK-100",
      sessionId: "session-TASK-100",
      pid: 41,
      dispatchMode: "local_smoke",
      message: "Dispatch started for TASK-100",
    });
    expect(startSpy).toHaveBeenCalledTimes(1);
  } finally {
    await stop?.();
    startSpy.mockRestore();
    removeFixture(fixture.root);
  }
});

it("START preserves the already-running response ahead of the contested veto", async () => {
  const fixture = createDuplicateFixture(
    "quack-route-start-running-",
    "cross-population",
    "forward",
  );
  const activeSpy = jest
    .spyOn(DispatchManager.prototype, "getActiveJob")
    .mockReturnValue(makeJob("TASK-100"));
  let stop: (() => Promise<void>) | undefined;
  try {
    const adapterPath = writeAdapter(fixture.root);
    const monitor = createMonitorServer({
      port: testPort(),
      projectRoot: fixture.root,
      taskDir: "docs/tasks",
      adapterPath,
      logDir: path.join(fixture.root, ".quack", "logs"),
    });
    const started = await monitor.start();
    stop = started.stop;

    const response = await postJson(started.port, "/api/tasks/TASK-100/start", {
      localSmokeOnly: true,
      skipGate: true,
      skipDecomposeCheck: true,
    });

    expect(response.status).toBe(409);
    expect(response.body).toEqual({ error: "Task TASK-100 is already running (pid 41)" });
  } finally {
    await stop?.();
    activeSpy.mockRestore();
    removeFixture(fixture.root);
  }
});

describe.each(DUPLICATE_FIXTURE_CASES)("active-job no-op precedence (%s, %s)", (kind, order) => {
  it.each([
    {
      label: "START awaiting approval",
      surface: "start" as const,
      status: "awaiting_approval" as const,
      expected: {
        error:
          "Task TASK-100 is awaiting human approval at a gate. Approve or reject via the dashboard, or stop the task first.",
      },
    },
    {
      label: "force-retry already running",
      surface: "force-retry" as const,
      status: "running" as const,
      expected: { error: "Task TASK-100 is already running (pid 41)" },
    },
    {
      label: "force-retry awaiting approval",
      surface: "force-retry" as const,
      status: "awaiting_approval" as const,
      expected: {
        error:
          "Task TASK-100 is awaiting human approval at a gate. Approve or reject via the dashboard, or stop the task first.",
      },
    },
  ])("keeps the original $label response", async ({ surface, status, expected }) => {
    const fixture = createDuplicateFixture("quack-route-active-noop-", kind, order);
    const activeJob = { ...makeJob("TASK-100"), status };
    const activeSpy = jest
      .spyOn(DispatchManager.prototype, "getActiveJob")
      .mockReturnValue(activeJob);
    const startSpy = jest.spyOn(DispatchManager.prototype, "start");
    let stop: (() => Promise<void>) | undefined;
    try {
      const adapterPath = writeAdapter(fixture.root);
      await provision(surface, fixture.root);
      const monitor = createMonitorServer({
        port: testPort(),
        projectRoot: fixture.root,
        taskDir: "docs/tasks",
        adapterPath,
        logDir: path.join(fixture.root, ".quack", "logs"),
      });
      const started = await monitor.start();
      stop = started.stop;
      const request = requestFor(surface);

      const response = await postJson(started.port, request.pathname, request.body);

      expect(response.status).toBe(409);
      expect(response.body).toEqual(expected);
      expect(startSpy).not.toHaveBeenCalled();
    } finally {
      await stop?.();
      startSpy.mockRestore();
      activeSpy.mockRestore();
      removeFixture(fixture.root);
    }
  });
});

describe.each([
  [
    "revise",
    "/api/tasks/TASK-100/revise",
    { localSmokeOnly: true, feedback: "retry" },
    400,
    "no prior runs",
  ],
  ["blueprint approve", "/api/tasks/TASK-100/blueprint/approve", {}, 500, "No pending approval"],
  ["judge approve", "/api/tasks/TASK-100/judge/approve", {}, 500, "No pending judge approval"],
  ["judge reject", "/api/tasks/TASK-100/judge/reject", {}, 500, "No pending judge approval"],
  ["force retry", "/api/tasks/TASK-100/force-retry", {}, 404, "No judge feedback"],
  ["resume", "/api/tasks/TASK-100/resume", {}, 404, "No checkpoint"],
] as const)("%s no-op precedence", (_label, pathname, body, expectedStatus, expectedText) => {
  it("keeps the original response ahead of the contested veto", async () => {
    const fixture = createDuplicateFixture("quack-route-noop-", "cross-population", "reverse");
    let stop: (() => Promise<void>) | undefined;
    try {
      const adapterPath = writeAdapter(fixture.root);
      const monitor = createMonitorServer({
        port: testPort(),
        projectRoot: fixture.root,
        taskDir: "docs/tasks",
        adapterPath,
        logDir: path.join(fixture.root, ".quack", "logs"),
      });
      const started = await monitor.start();
      stop = started.stop;

      const response = await postJson(started.port, pathname, body);

      expect(response.status).toBe(expectedStatus);
      expect(JSON.stringify(response.body)).toContain(expectedText);
    } finally {
      await stop?.();
      removeFixture(fixture.root);
    }
  });
});
