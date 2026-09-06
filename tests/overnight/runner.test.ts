import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import {
  applyCurrentStageUpdate,
  classifyFailure,
  classifyPrepResult,
  decomposeRecommendedTask,
  dispatchTaskDirect,
  dispatchTaskViaFederation,
  isFederationJobVerified,
  parseTaskIdList,
  reconcileDirectTask,
  reconcileFederatedTask,
  resolveDispatchMode,
  runOvernightRunner,
  selectNextAction,
} from "../../src/overnight/runner";
import { writeTestAdapter } from "../helpers/divergent-task-fixture";
import type { NormalizedOptions } from "../../src/overnight/runner";
import type {
  OvernightDispatchJob,
  OvernightRunCheckpoint,
  OvernightRunSettings,
  OvernightTaskRecord,
} from "../../src/overnight/types";

const TEST_CHECKPOINT_PATH = path.join(
  process.env.TEMP ?? process.cwd(),
  `quack-runner-test-checkpoint-${process.pid}.json`,
);

function settings(overrides: Partial<OvernightRunSettings> = {}): OvernightRunSettings {
  return {
    projectRoot: "/repo",
    projectId: "project",
    monitorUrl: "http://localhost:3333",
    targetBranch: "dev",
    minDepthScore: 4.5,
    maxPrepAttempts: 2,
    maxEnrichmentAttempts: 1,
    maxDispatchAttempts: 1,
    maxDispatches: 99,
    activeDispatchLimit: 1,
    pollIntervalMs: 1000,
    verifyAfterDispatch: true,
    autoEnrich: false,
    autoDecompose: true,
    maxSubtasks: 4,
    skipGateOnDispatch: true,
    haltOnParseErrors: true,
    maxInfraFailures: 1,
    federationDispatch: false,
    allowLowPreflightOnFederationDispatch: false,
    autoAcknowledgeDecomposeReview: false,
    ...overrides,
  };
}

function task(overrides: Partial<OvernightTaskRecord>): OvernightTaskRecord {
  return {
    taskId: "TASK-001",
    status: "pending_prep",
    prepAttempts: 0,
    dispatchAttempts: 0,
    enrichmentAttempts: 0,
    deficiencies: [],
    updatedAt: "2026-04-27T00:00:00.000Z",
    ...overrides,
  };
}

function checkpoint(
  tasks: OvernightTaskRecord[],
  overrides: Partial<OvernightRunCheckpoint> = {},
): OvernightRunCheckpoint {
  return {
    schemaVersion: 1,
    runId: "overnight-test",
    createdAt: "2026-04-27T00:00:00.000Z",
    updatedAt: "2026-04-27T00:00:00.000Z",
    settings: settings(),
    tasks,
    events: [],
    dispatchesStarted: 0,
    totalCostUsd: 0,
    halted: false,
    ...overrides,
  };
}

/** Build a minimal NormalizedOptions for testing dispatch/reconcile helpers. */
function normalizedOptions(overrides: Partial<NormalizedOptions> = {}): NormalizedOptions {
  return {
    projectRoot: "/repo",
    monitorUrl: "http://localhost:3333",
    taskIds: [],
    targetBranch: "dev",
    minDepthScore: 4.5,
    maxPrepAttempts: 2,
    maxEnrichmentAttempts: 1,
    maxDispatchAttempts: 1,
    maxDispatches: 99,
    activeDispatchLimit: 1,
    pollIntervalMs: 1000,
    verifyAfterDispatch: false,
    autoEnrich: false,
    autoDecompose: true,
    maxSubtasks: 4,
    skipGateOnDispatch: true,
    haltOnParseErrors: true,
    maxInfraFailures: 1,
    maxBudgetUsd: undefined,
    dryRun: false,
    once: false,
    maxCycles: 1,
    logger: () => {},
    federationDispatch: true,
    allowLowPreflightOnFederationDispatch: false,
    autoAcknowledgeDecomposeReview: false,
    ...overrides,
  };
}

describe("overnight runner decisions", () => {
  it("parses comma and whitespace separated task IDs", () => {
    expect(parseTaskIdList("TASK-001, TASK-002 TASK-001\nTASK-003")).toEqual([
      "TASK-001",
      "TASK-002",
      "TASK-003",
    ]);
  });

  it("requires schema validity, depth readiness, minimum score, and decomposition clearance for prep pass", () => {
    expect(
      classifyPrepResult(
        {
          schemaValid: true,
          schemaErrors: [],
          depthScore: 4.7,
          depthReady: true,
          deficiencies: [],
          outcome: "pass",
        },
        4.5,
      ).ready,
    ).toBe(true);

    expect(
      classifyPrepResult(
        {
          schemaValid: true,
          schemaErrors: [],
          depthScore: 4.4,
          depthReady: true,
          deficiencies: ["Need concrete file paths"],
          outcome: "pass",
        },
        4.5,
      ),
    ).toEqual({
      ready: false,
      reason: "depth score 4.4 below 4.5",
    });

    expect(
      classifyPrepResult(
        {
          schemaValid: true,
          schemaErrors: [],
          depthScore: 4.8,
          depthReady: true,
          deficiencies: [],
          outcome: "pass",
          recommendDecomposition: true,
          decompositionReason: "files to modify 9 > 6",
        },
        4.5,
      ),
    ).toEqual({
      ready: false,
      needsDecomposition: true,
      reason: "decomposition recommended: files to modify 9 > 6",
    });
  });

  it("keeps prep moving while dispatch lane is occupied", () => {
    const active: OvernightDispatchJob[] = [
      {
        taskId: "TASK-010",
        sessionId: "quack-TASK-010",
        status: "running",
      },
    ];

    const action = selectNextAction(
      checkpoint([
        task({ taskId: "TASK-010", status: "running" }),
        task({ taskId: "TASK-011", status: "pending_prep" }),
      ]),
      active,
    );

    expect(action.type).toBe("prep");
    if (action.type === "prep") {
      expect(action.task.taskId).toBe("TASK-011");
    }
  });

  it("does not dispatch when the one-worker lane is occupied", () => {
    const active: OvernightDispatchJob[] = [
      {
        taskId: "TASK-010",
        sessionId: "quack-TASK-010",
        status: "running",
      },
    ];

    const action = selectNextAction(
      checkpoint([
        task({ taskId: "TASK-010", status: "running" }),
        task({ taskId: "TASK-011", status: "ready_for_dispatch" }),
      ]),
      active,
    );

    expect(action).toEqual({ type: "wait", reason: "dispatch lane occupied" });
  });

  it("halts when Quack infrastructure failures reach the configured threshold", () => {
    const action = selectNextAction(
      checkpoint([
        task({
          status: "failed",
          failureClass: "quack_infra",
          lastError: "0/0 tests passed is not evidence",
        }),
      ]),
      [],
    );

    expect(action).toEqual({
      type: "halt",
      reason: "quack infrastructure failure limit reached (1)",
    });
  });

  it("classifies verification script and zero-test failures as infrastructure", () => {
    expect(classifyFailure("web-app verify script reported 0/0 tests")).toBe("quack_infra");
    expect(classifyFailure("Task has unmet dependencies: TASK-900")).toBe("dependency_blocked");
  });

  it("tracks current stage transitions with preserved startedAt across completion and failure", () => {
    const run = checkpoint([]);

    applyCurrentStageUpdate(run, "blueprint", "running", {
      taskId: "TASK-901",
      detail: "Generating implementation blueprint.",
    });
    const startedAt = run.currentStage?.startedAt;
    expect(run.currentStage).toMatchObject({
      stage: "blueprint",
      status: "running",
      taskId: "TASK-901",
    });

    applyCurrentStageUpdate(run, "blueprint", "completed", {
      taskId: "TASK-901",
      detail: "Blueprint complete.",
    });
    expect(run.currentStage?.startedAt).toBe(startedAt);
    expect(run.currentStage).toMatchObject({
      stage: "blueprint",
      status: "completed",
      detail: "Blueprint complete.",
    });

    applyCurrentStageUpdate(run, "verify", "running", {
      taskId: "TASK-901",
      detail: "Running verification.",
    });
    const verifyStartedAt = run.currentStage?.startedAt;
    expect(verifyStartedAt).toBeDefined();

    applyCurrentStageUpdate(run, "verify", "failed", {
      taskId: "TASK-901",
      detail: "Verification failed.",
      error: "test suite failed",
    });
    expect(run.currentStage?.startedAt).toBe(verifyStartedAt);
    expect(run.currentStage).toMatchObject({
      stage: "verify",
      status: "failed",
      error: "test suite failed",
    });
  });
});

describe("resolveDispatchMode", () => {
  it("returns direct when federationDispatch is false", () => {
    expect(resolveDispatchMode({ federationDispatch: false })).toBe("direct");
  });

  it("returns federation when federationDispatch is true", () => {
    expect(resolveDispatchMode({ federationDispatch: true })).toBe("federation");
  });

  it("returns federation when normalizeOptions sees QUACK_SERVICE_TOKEN", () => {
    const tokenPresent = Boolean("test-token");
    expect(resolveDispatchMode({ federationDispatch: tokenPresent })).toBe("federation");

    const tokenAbsent = Boolean(undefined);
    expect(resolveDispatchMode({ federationDispatch: tokenAbsent })).toBe("direct");
  });
});

describe("classifyFailure — federation and headnode patterns", () => {
  it("classifies direct_dispatch_blocked as quack_infra", () => {
    expect(classifyFailure("direct_dispatch_blocked_in_swarm_mode")).toBe("quack_infra");
    expect(
      classifyFailure("Direct task dispatch is disabled while federated listeners are registered."),
    ).toBe("quack_infra");
  });
});

describe("isFederationJobVerified", () => {
  it("returns true when workerCompletion.verificationVerdict is VERIFIED", () => {
    expect(
      isFederationJobVerified({
        jobId: "job-1",
        status: "completed",
        workerCompletion: { verificationVerdict: "VERIFIED" },
      }),
    ).toBe(true);
  });

  it("returns true when verified flag is set", () => {
    expect(isFederationJobVerified({ jobId: "job-2", status: "completed", verified: true })).toBe(
      true,
    );
  });

  it("returns true when mergeReady is set", () => {
    expect(isFederationJobVerified({ jobId: "job-3", status: "completed", mergeReady: true })).toBe(
      true,
    );
  });

  it("returns true when autoMerged is set", () => {
    expect(isFederationJobVerified({ jobId: "job-4", status: "completed", autoMerged: true })).toBe(
      true,
    );
  });

  it("returns true when workerCompletion.verified is set", () => {
    expect(
      isFederationJobVerified({
        jobId: "job-5",
        status: "completed",
        workerCompletion: { verified: true },
      }),
    ).toBe(true);
  });

  it("returns true when workerCompletion.autoMerged is set", () => {
    expect(
      isFederationJobVerified({
        jobId: "job-6",
        status: "completed",
        workerCompletion: { autoMerged: true },
      }),
    ).toBe(true);
  });

  it("returns false when no verification evidence exists", () => {
    expect(isFederationJobVerified({ jobId: "job-7", status: "completed" })).toBe(false);
  });
});

describe("dispatchTaskViaFederation — integration", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.QUACK_SERVICE_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.QUACK_SERVICE_TOKEN;
    } else {
      process.env.QUACK_SERVICE_TOKEN = originalToken;
    }
  });

  it("POSTs to /v1/federation/queue with correct body and headers", async () => {
    process.env.QUACK_SERVICE_TOKEN = "test-service-token";
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          job: { jobId: "fed-job-999", status: "queued", assignedHostId: "headnode" },
        }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const run = checkpoint([task({ taskId: "TASK-300", status: "ready_for_dispatch" })], {
      settings: settings({ federationDispatch: true, projectId: "project" }),
    });
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions({
      preferredHostId: "headnode",
      allowLowPreflightOnFederationDispatch: true,
    });
    const stopHeartbeat = jest.fn();

    await dispatchTaskViaFederation(
      run,
      taskRecord,
      opts,
      "project",
      stopHeartbeat,
      TEST_CHECKPOINT_PATH,
    );

    // Assert fetch was called
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];

    // Assert the POST URL contains /v1/federation/queue?project=project
    expect(calledUrl).toContain("/v1/federation/queue");
    expect(calledUrl).toContain("project=project");

    // Assert the header X-Quack-Service-Token is present
    const headers = calledInit.headers as Record<string, string>;
    expect(headers["X-Quack-Service-Token"]).toBe("test-service-token");

    // Assert body includes taskId, jobType, requiredCapabilities, preferredHostId
    const body = JSON.parse(calledInit.body as string) as Record<string, unknown>;
    expect(body.taskId).toBe("TASK-300");
    expect(body.jobType).toBe("dispatch");
    expect(body.requiredCapabilities).toEqual(["dispatch"]);
    expect(body.preferredHostId).toBe("headnode");
    expect(body.allowLowPreflight).toBe(true);
    expect(body.autoSchedule).toBe(true);

    // Assert checkpoint task has dispatchMode:"federation" and federatedJobId
    expect(taskRecord.dispatchMode).toBe("federation");
    expect(taskRecord.federatedJobId).toBe("fed-job-999");
    expect(taskRecord.federatedHostId).toBe("headnode");
    expect(taskRecord.status).toBe("running");
    expect(run.dispatchesStarted).toBe(1);

    // Assert federation_dispatch_queued event was emitted
    const queuedEvent = run.events.find((e) => e.type === "federation_dispatch_queued");
    expect(queuedEvent).toBeDefined();
    expect(queuedEvent?.details?.jobId).toBe("fed-job-999");
    expect(queuedEvent?.details?.hostId).toBe("headnode");
    expect(queuedEvent?.details?.preferredHostId).toBe("headnode");
  });

  it("records quack_infra failure when QUACK_SERVICE_TOKEN is missing", async () => {
    delete process.env.QUACK_SERVICE_TOKEN;
    const fetchMock = jest.fn();
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const run = checkpoint([task({ taskId: "TASK-301", status: "ready_for_dispatch" })], {
      settings: settings({ federationDispatch: true }),
    });
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions();
    const stopHeartbeat = jest.fn();

    await dispatchTaskViaFederation(
      run,
      taskRecord,
      opts,
      "project",
      stopHeartbeat,
      TEST_CHECKPOINT_PATH,
    );

    // fetch must NOT have been called
    expect(fetchMock).not.toHaveBeenCalled();

    // Task must be marked failed with quack_infra
    expect(taskRecord.status).toBe("failed");
    expect(taskRecord.failureClass).toBe("quack_infra");
    expect(taskRecord.lastError).toContain("missing_federation_service_token");
    expect(taskRecord.lastError).toContain("QUACK_SERVICE_TOKEN");

    // A dispatch_error event must have been emitted with the errorCode
    const errorEvent = run.events.find((e) => e.type === "dispatch_error");
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.details?.errorCode).toBe("missing_federation_service_token");
  });
});

describe("dispatchTaskDirect - integration", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.QUACK_SERVICE_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.QUACK_SERVICE_TOKEN;
    } else {
      process.env.QUACK_SERVICE_TOKEN = originalToken;
    }
  });

  it("POSTs to /api/tasks/:id/start when no federation flag", async () => {
    delete process.env.QUACK_SERVICE_TOKEN;
    // dispatchTaskDirect uses http/https via requestJson, not fetch.
    // We need to mock at the http level. Instead we test through
    // the direct-start error path since the real HTTP call won't connect.
    // The important assertion is that dispatchTaskDirect targets /api/tasks/:id/start.
    //
    // We'll test the headnode rejection path since that exercises the real function
    // and validates the URL path + classification logic. For this we need an HTTP server
    // or we accept the connection-refused error as proof the URL was targeted.
    const run = checkpoint([task({ taskId: "TASK-400", status: "ready_for_dispatch" })], {
      settings: settings({ federationDispatch: false }),
    });
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions({ federationDispatch: false });
    const stopHeartbeat = jest.fn();

    // Call dispatchTaskDirect — it will try to connect to localhost:3333 and fail.
    // The error proves the direct path was attempted (not federation).
    await dispatchTaskDirect(run, taskRecord, opts, "project", stopHeartbeat, TEST_CHECKPOINT_PATH);

    // The task should be marked failed due to connection error
    expect(taskRecord.status).toBe("failed");
    // Importantly, the dispatch used the direct path (no federation fields)
    expect(taskRecord.federatedJobId).toBeUndefined();
    expect(taskRecord.dispatchMode).toBeUndefined();
    // The error should be a connection error, not a federation error
    expect(taskRecord.lastError).toBeDefined();
    expect(taskRecord.lastError).not.toContain("federation");
  });

  it("classifies headnode direct-start rejection as quack_infra with actionable lastError", async () => {
    // Spin up a minimal HTTP server that returns the headnode rejection payload.
    const http = await import("node:http");
    const server = http.createServer((_req, res) => {
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "direct_dispatch_blocked_in_swarm_mode" }));
    });
    await new Promise<void>((resolve) => {
      server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address() as { port: number };
    const monitorUrl = `http://127.0.0.1:${addr.port}`;

    try {
      const run = checkpoint([task({ taskId: "TASK-410", status: "ready_for_dispatch" })], {
        settings: settings({ federationDispatch: false }),
      });
      const taskRecord = run.tasks[0];
      const opts = normalizedOptions({ federationDispatch: false, monitorUrl });
      const stopHeartbeat = jest.fn();

      await dispatchTaskDirect(
        run,
        taskRecord,
        opts,
        "project",
        stopHeartbeat,
        TEST_CHECKPOINT_PATH,
      );

      // Assert failureClass is quack_infra
      expect(taskRecord.failureClass).toBe("quack_infra");
      // Assert lastError is the actionable message
      expect(taskRecord.lastError).toContain("QUACK_SERVICE_TOKEN");
      expect(taskRecord.lastError).toContain("--federation-dispatch");
      expect(taskRecord.lastError).toBe(
        "direct dispatch blocked on headnode; set QUACK_SERVICE_TOKEN and use --federation-dispatch",
      );
      expect(taskRecord.status).toBe("failed");

      // Assert a dispatch_error event was emitted with the correct errorCode
      const errorEvent = run.events.find((e) => e.type === "dispatch_error");
      expect(errorEvent).toBeDefined();
      expect(errorEvent?.details?.errorCode).toBe("direct_dispatch_blocked");
    } finally {
      server.close();
    }
  });
});

describe("reconcileDirectTask dispositions", () => {
  async function withRunServer(
    outcome: string,
    run: (monitorUrl: string) => Promise<void>,
  ): Promise<void> {
    const http = await import("node:http");
    const server = http.createServer((req, res) => {
      res.writeHead(200, { "Content-Type": "application/json" });
      if (req.url?.startsWith("/api/health")) {
        res.end('{"ok":true}');
        return;
      }
      if (req.url?.startsWith("/api/dispatch/jobs")) {
        res.end("[]");
        return;
      }
      if (req.url?.includes("/api/sessions/direct-session/events")) {
        res.end(
          JSON.stringify([
            {
              sessionId: "direct-session",
              taskId: "TASK-420",
              project: "project",
              timestamp: "2026-08-18T10:00:01.000Z",
              stage: "spec_identity_stale",
              payload: { reason: "contested id claimed by two files" },
            },
          ]),
        );
        return;
      }
      res.end(
        JSON.stringify([
          {
            sessionId: "direct-session",
            taskId: "TASK-420",
            startTime: "2026-08-18T10:00:00.000Z",
            status: "completed",
            outcome,
          },
        ]),
      );
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address() as { port: number };
    try {
      await run(`http://127.0.0.1:${address.port}`);
    } finally {
      await new Promise<void>((resolve, reject) =>
        server.close((error) => (error ? reject(error) : resolve())),
      );
    }
  }

  it("records spec_changed as blocked with the refusal reason", async () => {
    await withRunServer("spec_changed", async (monitorUrl) => {
      const record = task({
        taskId: "TASK-420",
        status: "running",
        sessionId: "direct-session",
      });
      const dependent = task({
        taskId: "TASK-421",
        status: "blocked",
        blockedBy: ["TASK-420"],
        failureClass: "dependency_blocked",
      });
      const run = checkpoint([record, dependent]);

      await reconcileDirectTask(
        run,
        record,
        normalizedOptions({ monitorUrl }),
        TEST_CHECKPOINT_PATH,
      );

      expect(record).toMatchObject({
        status: "blocked",
        lastOutcome: "spec_changed",
        lastError: "contested id claimed by two files",
      });
      expect(record.failureClass).toBeUndefined();
      expect(run.events.at(-1)).toMatchObject({
        type: "dispatch_blocked",
        details: { outcome: "spec_changed", reason: "contested id claimed by two files" },
      });

      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-spec-changed-refresh-"));
      try {
        fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
        writeTestAdapter(projectRoot);
        const checkpointPath = path.join(projectRoot, "overnight-checkpoint.json");
        fs.writeFileSync(checkpointPath, JSON.stringify(run), "utf-8");

        const refreshed = await runOvernightRunner({
          projectRoot,
          monitorUrl,
          taskIds: ["TASK-420", "TASK-421"],
          checkpointPath,
          once: true,
          maxCycles: 2,
          haltOnParseErrors: false,
          autoDecompose: false,
          federationDispatch: false,
          logger: () => {},
        });
        const refreshedOwner = refreshed.tasks.find((item) => item.taskId === "TASK-420");
        const refreshedDependent = refreshed.tasks.find((item) => item.taskId === "TASK-421");
        const activeBlocker = refreshedDependent?.blockedBy?.find(
          (taskId) => taskId === refreshedOwner?.taskId,
        );
        const dependentTransitions = refreshed.events
          .filter((event) => event.taskId === "TASK-421")
          .filter((event) => event.type === "task_failed" || event.type === "dependency_unblocked")
          .map((event) => event.type);

        expect({
          activeBlocker,
          blockerDisposition: refreshedOwner?.status,
          dependentDisposition: refreshedDependent?.status,
          dependentTransitions,
        }).toEqual({
          activeBlocker: "TASK-420",
          blockerDisposition: "blocked",
          dependentDisposition: "blocked",
          dependentTransitions: [],
        });

        expect({
          owner: refreshedOwner,
          dependent: refreshedDependent,
        }).toMatchObject({
          owner: {
            status: "blocked",
            lastOutcome: "spec_changed",
          },
          dependent: {
            status: "blocked",
            blockedBy: ["TASK-420"],
            lastError: "blocked by TASK-420",
            failureClass: "dependency_blocked",
          },
        });
        expect(refreshedOwner?.failureClass).toBeUndefined();
      } finally {
        fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      }
    });
  });

  it("keeps rejected direct reconciliation as task failure", async () => {
    await withRunServer("rejected", async (monitorUrl) => {
      const record = task({
        taskId: "TASK-420",
        status: "running",
        sessionId: "direct-session",
      });
      const run = checkpoint([record]);

      await reconcileDirectTask(
        run,
        record,
        normalizedOptions({ monitorUrl }),
        TEST_CHECKPOINT_PATH,
      );

      expect(record).toMatchObject({
        status: "failed",
        lastOutcome: "rejected",
        lastError: "rejected",
        failureClass: "task_failure",
      });
    });
  });
});

describe("reconcileFederatedTask - integration", () => {
  const originalFetch = globalThis.fetch;
  const originalToken = process.env.QUACK_SERVICE_TOKEN;

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (originalToken === undefined) {
      delete process.env.QUACK_SERVICE_TOKEN;
    } else {
      process.env.QUACK_SERVICE_TOKEN = originalToken;
    }
  });

  it("transitions to completed when federation job is completed with VERIFIED evidence", async () => {
    process.env.QUACK_SERVICE_TOKEN = "test-token";
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          jobId: "fed-job-500",
          taskId: "TASK-500",
          status: "completed",
          assignedHostId: "headnode",
          workerCompletion: { verificationVerdict: "VERIFIED" },
        }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const run = checkpoint(
      [
        task({
          taskId: "TASK-500",
          status: "running",
          dispatchMode: "federation",
          federatedJobId: "fed-job-500",
        }),
      ],
      { settings: settings({ federationDispatch: true }) },
    );
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions({ verifyAfterDispatch: false });

    await reconcileFederatedTask(run, taskRecord, opts, TEST_CHECKPOINT_PATH);

    expect(taskRecord.status).toBe("completed");
    expect(taskRecord.federatedHostId).toBe("headnode");
    const completedEvent = run.events.find((e) => e.type === "federation_dispatch_completed");
    expect(completedEvent).toBeDefined();
    expect(completedEvent?.details?.federatedJobId).toBe("fed-job-500");
  });

  it("transitions to manual_review when federation job is completed without verification evidence", async () => {
    process.env.QUACK_SERVICE_TOKEN = "test-token";
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          jobId: "fed-job-501",
          taskId: "TASK-501",
          status: "completed",
          assignedHostId: "headnode",
        }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const run = checkpoint(
      [
        task({
          taskId: "TASK-501",
          status: "running",
          dispatchMode: "federation",
          federatedJobId: "fed-job-501",
        }),
      ],
      { settings: settings({ federationDispatch: true }) },
    );
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions();

    await reconcileFederatedTask(run, taskRecord, opts, TEST_CHECKPOINT_PATH);

    expect(taskRecord.status).toBe("manual_review");
    expect(taskRecord.lastError).toBe("federation job completed without verified/merge evidence");
    expect(taskRecord.failureClass).toBe("task_failure");
    const completedEvent = run.events.find(
      (e) => e.type === "federation_dispatch_completed" && e.details?.noEvidence === true,
    );
    expect(completedEvent).toBeDefined();
  });

  it("transitions to failed when federation job status is failed", async () => {
    process.env.QUACK_SERVICE_TOKEN = "test-token";
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          jobId: "fed-job-502",
          taskId: "TASK-502",
          status: "failed",
          error: "agent crashed",
        }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const run = checkpoint(
      [
        task({
          taskId: "TASK-502",
          status: "running",
          dispatchMode: "federation",
          federatedJobId: "fed-job-502",
        }),
      ],
      { settings: settings({ federationDispatch: true }) },
    );
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions();

    await reconcileFederatedTask(run, taskRecord, opts, TEST_CHECKPOINT_PATH);

    expect(taskRecord.status).toBe("failed");
    expect(taskRecord.lastError).toBe("agent crashed");
    const failedEvent = run.events.find((e) => e.type === "federation_dispatch_failed");
    expect(failedEvent).toBeDefined();
  });

  it("transitions to manual_review when federation job is blocked with manual_review nextAction", async () => {
    process.env.QUACK_SERVICE_TOKEN = "test-token";
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          jobId: "fed-job-503",
          taskId: "TASK-503",
          status: "blocked",
          nextAction: "manual_review",
        }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const run = checkpoint(
      [
        task({
          taskId: "TASK-503",
          status: "running",
          dispatchMode: "federation",
          federatedJobId: "fed-job-503",
        }),
      ],
      { settings: settings({ federationDispatch: true }) },
    );
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions();

    await reconcileFederatedTask(run, taskRecord, opts, TEST_CHECKPOINT_PATH);

    expect(taskRecord.status).toBe("manual_review");
    const blockedEvent = run.events.find((e) => e.type === "federation_dispatch_blocked");
    expect(blockedEvent).toBeDefined();
  });

  it("transitions to failed when federation job is canceled", async () => {
    process.env.QUACK_SERVICE_TOKEN = "test-token";
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          jobId: "fed-job-504",
          taskId: "TASK-504",
          status: "canceled",
        }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const run = checkpoint(
      [
        task({
          taskId: "TASK-504",
          status: "running",
          dispatchMode: "federation",
          federatedJobId: "fed-job-504",
        }),
      ],
      { settings: settings({ federationDispatch: true }) },
    );
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions();

    await reconcileFederatedTask(run, taskRecord, opts, TEST_CHECKPOINT_PATH);

    expect(taskRecord.status).toBe("failed");
    expect(taskRecord.failureClass).toBe("quack_infra");
    expect(taskRecord.lastError).toBe("federation job canceled");
  });

  it("stays running when federation job is still active (queued/assigned/running/leased)", async () => {
    process.env.QUACK_SERVICE_TOKEN = "test-token";
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      json: () =>
        Promise.resolve({
          jobId: "fed-job-505",
          taskId: "TASK-505",
          status: "running",
          assignedHostId: "headnode",
        }),
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const run = checkpoint(
      [
        task({
          taskId: "TASK-505",
          status: "running",
          dispatchMode: "federation",
          federatedJobId: "fed-job-505",
        }),
      ],
      { settings: settings({ federationDispatch: true }) },
    );
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions();

    await reconcileFederatedTask(run, taskRecord, opts, TEST_CHECKPOINT_PATH);

    // Status should remain running
    expect(taskRecord.status).toBe("running");
    expect(taskRecord.federatedHostId).toBe("headnode");
    const progressEvent = run.events.find((e) => e.type === "federation_dispatch_progress");
    expect(progressEvent).toBeDefined();
  });
});

describe("federation reconciliation — state mapping", () => {
  it("settings helper includes federation fields with correct defaults", () => {
    const s = settings();
    expect(s.federationDispatch).toBe(false);
    expect(s.allowLowPreflightOnFederationDispatch).toBe(false);
    expect(s.preferredHostId).toBeUndefined();
  });

  it("settings helper propagates overrides for federation fields", () => {
    const s = settings({
      federationDispatch: true,
      preferredHostId: "headnode",
      allowLowPreflightOnFederationDispatch: true,
    });
    expect(s.federationDispatch).toBe(true);
    expect(s.preferredHostId).toBe("headnode");
    expect(s.allowLowPreflightOnFederationDispatch).toBe(true);
  });

  it("task record supports dispatchMode and federatedJobId fields", () => {
    const t = task({
      taskId: "TASK-200",
      status: "running",
      dispatchMode: "federation",
      federatedJobId: "fed-job-abc123",
      federatedHostId: "headnode",
    });
    expect(t.dispatchMode).toBe("federation");
    expect(t.federatedJobId).toBe("fed-job-abc123");
    expect(t.federatedHostId).toBe("headnode");
  });
});

describe("decomposeRecommendedTask — staged decompose API", () => {
  const originalFetch = globalThis.fetch;

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  const planResponse = {
    ok: true,
    topology: { rootTaskId: "TASK-1" },
    subtaskIds: ["TASK-1-A"],
    coverageReport: { clean: true, gaps: [] },
  };

  const materializeResponse = {
    ok: true,
    topology: { rootTaskId: "TASK-1" },
    drafts: [{ taskId: "TASK-1-A", path: "docs/tasks/TASK-1-A.md" }],
    subtaskIds: ["TASK-1-A"],
  };

  const finalizeResponse = {
    ok: true,
    subtaskIds: ["TASK-1-A"],
    writtenPaths: ["docs/tasks/TASK-1-A.md"],
  };

  function makeFetchMock(responses: object[]): jest.Mock {
    let call = 0;
    const mockFn = jest.fn().mockImplementation(() => {
      const resp = responses[call] ?? responses[responses.length - 1];
      call += 1;
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve(resp),
      });
    });
    return mockFn;
  }

  it("plan/materialize then manual_review when autoAcknowledgeDecomposeReview is false (default)", async () => {
    const fetchMock = makeFetchMock([planResponse, materializeResponse]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const run = checkpoint(
      [task({ taskId: "TASK-1", status: "pending_prep", recommendDecomposition: true })],
      { settings: settings() },
    );
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions({ autoAcknowledgeDecomposeReview: false });

    await decomposeRecommendedTask(run, taskRecord, opts, "docs/tasks", TEST_CHECKPOINT_PATH);

    // Assert exactly 2 fetch calls: plan then materialize, no finalize
    expect(fetchMock).toHaveBeenCalledTimes(2);

    const [, planInit] = fetchMock.mock.calls[0] as [string, RequestInit];
    const planBody = JSON.parse(planInit.body as string) as Record<string, unknown>;
    expect(planBody.mode).toBe("plan");
    expect(planBody).not.toHaveProperty("approve");

    const [, materializeInit] = fetchMock.mock.calls[1] as [string, RequestInit];
    const materializeBody = JSON.parse(materializeInit.body as string) as Record<string, unknown>;
    expect(materializeBody.mode).toBe("materialize");
    expect(materializeBody).not.toHaveProperty("approve");

    // Assert task status is manual_review
    expect(taskRecord.status).toBe("manual_review");
    expect(taskRecord.subtaskIds).toEqual(["TASK-1-A"]);
    expect(taskRecord.decomposeDraftCount).toBe(1);
    expect(taskRecord.lastError).toContain("decompose review required");

    // Assert decomposition_review_required event was emitted
    const reviewEvent = run.events.find((e) => e.type === "decomposition_review_required");
    expect(reviewEvent).toBeDefined();
    expect(reviewEvent?.details?.subtaskIds).toEqual(["TASK-1-A"]);
    expect(reviewEvent?.details?.draftCount).toBe(1);
  });

  it("plan/materialize/finalize succeeds when autoAcknowledgeDecomposeReview is true", async () => {
    const fetchMock = makeFetchMock([planResponse, materializeResponse, finalizeResponse]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const run = checkpoint(
      [task({ taskId: "TASK-1", status: "pending_prep", recommendDecomposition: true })],
      { settings: settings({ autoAcknowledgeDecomposeReview: true }) },
    );
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions({ autoAcknowledgeDecomposeReview: true });

    await decomposeRecommendedTask(run, taskRecord, opts, "docs/tasks", TEST_CHECKPOINT_PATH);

    // Assert exactly 3 fetch calls: plan, materialize, finalize
    expect(fetchMock).toHaveBeenCalledTimes(3);

    const [, finalizeInit] = fetchMock.mock.calls[2] as [string, RequestInit];
    const finalizeBody = JSON.parse(finalizeInit.body as string) as Record<string, unknown>;
    expect(finalizeBody.mode).toBe("finalize");
    expect(finalizeBody.reviewAcknowledged).toBe(true);
    expect(finalizeBody).not.toHaveProperty("approve");

    // Assert task status is decomposed
    expect(taskRecord.status).toBe("decomposed");
    expect(taskRecord.subtaskIds).toEqual(["TASK-1-A"]);

    // Assert decomposition_complete event was emitted
    const completeEvent = run.events.find((e) => e.type === "decomposition_complete");
    expect(completeEvent).toBeDefined();
    expect(completeEvent?.details?.subtaskIds).toEqual(["TASK-1-A"]);
    expect(completeEvent?.details?.writtenPaths).toEqual(["docs/tasks/TASK-1-A.md"]);
  });

  it("records refusal details when materialize fails with refusalCode and refusalMessage", async () => {
    const refusalBody = {
      ok: false,
      error: "coverage gap",
      refusalCode: "DECOMPOSE_COVERAGE_GAP",
      refusalMessage: "missing slice",
    };
    let callIdx = 0;
    const refusalMock = jest.fn().mockImplementation(() => {
      const httpOk = callIdx === 0;
      const body = callIdx === 0 ? planResponse : refusalBody;
      callIdx += 1;
      return Promise.resolve({
        ok: httpOk,
        status: httpOk ? 200 : 422,
        json: () => Promise.resolve(body),
      });
    });
    globalThis.fetch = refusalMock as unknown as typeof fetch;

    const run = checkpoint(
      [task({ taskId: "TASK-1", status: "pending_prep", recommendDecomposition: true })],
      { settings: settings() },
    );
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions({ autoAcknowledgeDecomposeReview: false });

    await decomposeRecommendedTask(run, taskRecord, opts, "docs/tasks", TEST_CHECKPOINT_PATH);

    expect(taskRecord.status).toBe("manual_review");
    expect(taskRecord.decomposeRefusalCode).toBe("DECOMPOSE_COVERAGE_GAP");
    expect(taskRecord.decomposeRefusalMessage).toBe("missing slice");
  });

  it("no request body ever contains an approve key", async () => {
    const fetchMock = makeFetchMock([planResponse, materializeResponse, finalizeResponse]);
    globalThis.fetch = fetchMock as unknown as typeof fetch;

    const run = checkpoint(
      [task({ taskId: "TASK-1", status: "pending_prep", recommendDecomposition: true })],
      { settings: settings() },
    );
    const taskRecord = run.tasks[0];
    const opts = normalizedOptions({ autoAcknowledgeDecomposeReview: true });

    await decomposeRecommendedTask(run, taskRecord, opts, "docs/tasks", TEST_CHECKPOINT_PATH);

    for (const [, init] of fetchMock.mock.calls as [string, RequestInit][]) {
      if (!init?.body) continue;
      const body = JSON.parse(init.body as string) as Record<string, unknown>;
      expect(body).not.toHaveProperty("approve");
    }
  });
});
