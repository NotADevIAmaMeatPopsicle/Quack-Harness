import { execFile, execFileSync } from "node:child_process";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

type CapturedEvent = {
  status?: string;
  message?: string;
  evidence?: Array<Record<string, unknown>>;
  resumeGrant?: Record<string, unknown>;
  resumeSessionId?: string;
  resumeStartedAt?: string;
};

type WorkerRefreshAckBody = {
  commandIds?: string[];
  results?: Array<{
    kind?: string;
    status?: string;
    errorCategory?: string;
    metadata?: {
      repos?: Array<{
        repoKey?: string;
        status?: string;
        blocker?: string;
        commitAfter?: string;
      }>;
    };
  }>;
};

function expectServiceTokenHeader(req: http.IncomingMessage): void {
  expect(req.headers["x-quack-service-token"]).toBe("test-token");
  expect(req.headers.authorization).toBeUndefined();
}

function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += String(chunk);
    });
    req.on("end", () => {
      resolve(raw ? (JSON.parse(raw) as Record<string, unknown>) : {});
    });
  });
}

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("No server address");
      resolve(address.port);
    });
  });
}

function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

function requestHandler(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => Promise<void> | void,
): http.RequestListener {
  return (req, res) => {
    void Promise.resolve(handler(req, res)).catch((err: unknown) => {
      res.writeHead(500, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: err instanceof Error ? err.message : String(err) }));
    });
  };
}

async function runListener(args: string[]): Promise<Record<string, unknown>> {
  const script = path.join(process.cwd(), "scripts", "quack-listener.mjs");
  const { stdout } = await execFileAsync(process.execPath, [script, ...args, "--json"], {
    cwd: process.cwd(),
    timeout: 10000,
  });
  return JSON.parse(stdout) as Record<string, unknown>;
}

async function runListenerText(args: string[]): Promise<{ stdout: string; stderr: string }> {
  const script = path.join(process.cwd(), "scripts", "quack-listener.mjs");
  const result = await execFileAsync(process.execPath, [script, ...args], {
    cwd: process.cwd(),
    timeout: 10000,
  });
  return {
    stdout: result.stdout,
    stderr: result.stderr,
  };
}

interface FixtureDispatchScope {
  projectId: string;
  taskId: string;
  jobId: string;
  hostId: string;
  leaseId: string;
  sessionId: string;
}
// Known fixture identities come from the advertised job/start response. Request
// query values are checked against them and never become completion authority.
function dispatchFixturePayload(
  req: http.IncomingMessage,
  scopes: FixtureDispatchScope[],
  values: Array<Record<string, unknown>>,
): unknown {
  const jobs: Array<Record<string, unknown>> = values.map((job) => {
    const scope = scopes.find(
      (entry) => entry.taskId === job.taskId && entry.sessionId === job.sessionId,
    );
    if (!scope) throw new Error("Unconfigured dispatch fixture identity");
    return {
      ...job,
      project: scope.projectId,
      federatedJobId: scope.jobId,
      federatedHostId: scope.hostId,
      federatedLeaseId: scope.leaseId,
    };
  });
  if (req.url === "/api/dispatch/jobs") return jobs;
  const url = new URL(req.url!, "http://fixture.invalid");
  const scope = scopes.find(
    (entry) =>
      url.pathname === "/api/tasks/" + entry.taskId + "/dispatch/observation" &&
      url.searchParams.get("sessionId") === entry.sessionId,
  );
  if (!scope) throw new Error("Unexpected exact observation request");
  for (const field of ["projectId", "jobId", "hostId", "leaseId", "sessionId"] as const)
    expect(url.searchParams.get(field)).toBe(scope[field]);
  const job = jobs.find(
    (entry) => entry.taskId === scope.taskId && entry.sessionId === scope.sessionId,
  );
  if (!job) throw new Error("Expected fixture job is absent");
  const settled = ["completed", "failed", "stopped"].includes(String(job.status));
  return {
    identity: scope,
    settled,
    source: "memory",
    job: {
      ...job,
      ...(settled ? { completedAt: "2026-09-11T00:00:00.000Z" } : {}),
      ...(job.status === "completed" ? { exitCode: 0 } : {}),
    },
  };
}
function sessionFixtureEvents(
  req: http.IncomingMessage,
  scopes: FixtureDispatchScope[],
  values: Array<Record<string, unknown>>,
): unknown {
  const scope = scopes.find((entry) => req.url === "/api/sessions/" + entry.sessionId);
  if (!scope) throw new Error("Unexpected completion event session request");
  return [
    {
      stage: "session_start",
      payload: { jobId: scope.jobId, hostId: scope.hostId, leaseId: scope.leaseId },
      project: scope.projectId,
      taskId: scope.taskId,
      sessionId: scope.sessionId,
    },
    ...values.map((event) => ({
      ...event,
      project: scope.projectId,
      taskId: scope.taskId,
      sessionId: scope.sessionId,
    })),
  ];
}

describe("quack-listener work command", () => {
  it("reports allPassed:false verify output as a failed federated event", async () => {
    const events: CapturedEvent[] = [];
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          expectServiceTokenHeader(req);
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              jobs: [
                {
                  projectId: "example-service",
                  jobId: "fed-task-1",
                  taskId: "TASK-1",
                  jobType: "verify",
                  status: "assigned",
                  hostId: "laptop",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-task-1/events") {
          expectServiceTokenHeader(req);
          expect(req.headers["x-project-id"]).toBe("example-service");
          events.push((await readJson(req)) as CapturedEvent);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const local = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-1") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-1", title: "Visible task" }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-1/verify") {
          const body = (await readJson(req)) as { includeOptional?: boolean };
          expect(body.includeOptional).toBe(false);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              allPassed: false,
              commands: [{ name: "build", passed: false, output: "boom" }],
            }),
          );
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
      ]);

      expect(result.body).toMatchObject({ ok: false, worked: true, jobId: "fed-task-1" });
      expect(events.map((event) => event.status)).toEqual(["verifying", "failed"]);
      expect(events.at(-1)?.evidence?.[0]).toMatchObject({
        type: "worker_verify",
        status: 200,
      });
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("turns local monitor fetch failures into failed job evidence", async () => {
    const events: CapturedEvent[] = [];
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          expectServiceTokenHeader(req);
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              jobs: [
                {
                  jobId: "fed-task-2",
                  taskId: "TASK-2",
                  jobType: "verify",
                  status: "assigned",
                  hostId: "laptop",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-task-2/events") {
          expectServiceTokenHeader(req);
          events.push((await readJson(req)) as CapturedEvent);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    const local = http.createServer(
      requestHandler((req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-2") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-2", title: "Visible task" }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-2/verify") {
          req.socket.destroy();
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
      ]);

      expect(result.body).toMatchObject({ ok: false, worked: true, jobId: "fed-task-2" });
      expect(events.map((event) => event.status)).toEqual(["verifying", "failed"]);
      expect(events.at(-1)?.evidence?.[0]).toMatchObject({
        type: "worker_verify",
        status: 0,
      });
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("rejects prefix-only task matches from the local monitor", async () => {
    const events: CapturedEvent[] = [];
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          expectServiceTokenHeader(req);
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              jobs: [
                {
                  projectId: "fixture-project",
                  lease: { leaseId: "lease-task-886", hostId: "laptop" },
                  jobId: "fed-task-886",
                  taskId: "TASK-886",
                  jobType: "dispatch",
                  status: "assigned",
                  hostId: "laptop",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-task-886/events") {
          expectServiceTokenHeader(req);
          events.push((await readJson(req)) as CapturedEvent);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const local = http.createServer(
      requestHandler((req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-886") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-886-A", title: "Wrong subtask" }));
          return;
        }
        if (req.method === "GET" && req.url === "/api/projects") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([{ id: "fixture-project", active: true }]));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
      ]);

      expect(result.body).toMatchObject({ ok: false, worked: true, jobId: "fed-task-886" });
      const lastEvent = events.at(-1);
      expect(lastEvent?.status).toBe("failed");
      expect(lastEvent?.message).toContain("task_not_visible_in_expected_local_project");
      expect(events.map((event) => event.status)).toEqual(["failed"]);
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("starts only assigned jobs and ignores already-running entries", async () => {
    const fixtureScopes: FixtureDispatchScope[] = [
      {
        projectId: "fixture-project",
        taskId: "TASK-3",
        jobId: "fed-task-assigned",
        hostId: "laptop",
        leaseId: "lease-task-1",
        sessionId: "sess-3",
      },
    ];
    const events: CapturedEvent[] = [];
    const startCalls: string[] = [];
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          expectServiceTokenHeader(req);
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              jobs: [
                {
                  jobId: "fed-task-running",
                  taskId: "TASK-RUNNING",
                  jobType: "dispatch",
                  status: "running",
                  hostId: "laptop",
                },
                {
                  projectId: "fixture-project",
                  jobId: "fed-task-assigned",
                  taskId: "TASK-3",
                  jobType: "dispatch",
                  status: "assigned",
                  hostId: "laptop",
                  lease: { leaseId: "lease-task-1", hostId: "laptop" },
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-task-assigned/events") {
          expectServiceTokenHeader(req);
          events.push((await readJson(req)) as CapturedEvent);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const local = http.createServer(
      requestHandler((req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-3") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-3", title: "Visible task" }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-3/start") {
          startCalls.push("TASK-3");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionId: "sess-3" }));
          return;
        }
        if (
          req.method === "GET" &&
          (req.url === "/api/dispatch/jobs" || req.url?.includes("/dispatch/observation?"))
        ) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              dispatchFixturePayload(req, fixtureScopes, [
                {
                  taskId: "TASK-3",
                  sessionId: "sess-3",
                  status: "completed",
                  output: [],
                },
              ]),
            ),
          );
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
      ]);

      expect(result.body).toMatchObject({ ok: true, worked: true, jobId: "fed-task-assigned" });
      expect(startCalls).toEqual(["TASK-3"]);
      expect(events.map((event) => event.status)).toEqual(["running", "completed"]);
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("reports canonical session + worker completion metadata after a verified local auto-merge", async () => {
    const fixtureScopes: FixtureDispatchScope[] = [
      {
        projectId: "fixture-project",
        taskId: "TASK-5",
        jobId: "fed-task-5",
        hostId: "laptop",
        leaseId: "lease-task-5",
        sessionId: "quack-TASK-5-20260505-123000",
      },
    ];
    const events: Array<CapturedEvent & Record<string, unknown>> = [];
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          expectServiceTokenHeader(req);
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              jobs: [
                {
                  projectId: "fixture-project",
                  lease: { leaseId: "lease-task-5", hostId: "laptop" },
                  jobId: "fed-task-5",
                  taskId: "TASK-5",
                  jobType: "dispatch",
                  status: "assigned",
                  hostId: "laptop",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-task-5/events") {
          expectServiceTokenHeader(req);
          events.push((await readJson(req)) as CapturedEvent & Record<string, unknown>);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const local = http.createServer(
      requestHandler((req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-5") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-5", title: "Visible task" }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-5/start") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionId: "quack-TASK-5-20260505-123000" }));
          return;
        }
        if (
          req.method === "GET" &&
          (req.url === "/api/dispatch/jobs" || req.url?.includes("/dispatch/observation?"))
        ) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              dispatchFixturePayload(req, fixtureScopes, [
                {
                  taskId: "TASK-5",
                  sessionId: "quack-TASK-5-20260505-123000",
                  status: "completed",
                  branchName: "quack/TASK-5",
                  commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                  output: [],
                },
              ]),
            ),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/api/tasks/TASK-5/runs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify([
              {
                sessionId: "quack-TASK-5-20260505-123000",
                taskId: "TASK-5",
                status: "completed",
              },
            ]),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/api/sessions/quack-TASK-5-20260505-123000") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              sessionFixtureEvents(req, fixtureScopes, [
                {
                  stage: "lifecycle_verify_result",
                  payload: {
                    workflowId: "workflow-task-5-worker",
                    verified: true,
                    verdict: "VERIFIED",
                  },
                },
                {
                  stage: "lifecycle_complete",
                  payload: {
                    verified: true,
                  },
                },
                {
                  stage: "auto_merge_complete",
                  payload: {
                    targetBranch: "dev",
                    mergeCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
                  },
                },
                {
                  stage: "session_complete",
                  payload: {
                    outcome: "approved",
                    autoMerged: true,
                  },
                },
              ]),
            ),
          );
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
      ]);

      expect(result.body).toMatchObject({ ok: true, worked: true, jobId: "fed-task-5" });
      expect(events.map((event) => event.status)).toEqual(["running", "completed"]);
      expect(events.at(-1)).toMatchObject({
        remoteSessionId: "quack-TASK-5-20260505-123000",
        commitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        targetBranch: "dev",
        workerCompletion: {
          canonicalSessionId: "quack-TASK-5-20260505-123000",
          verificationWorkflowId: "workflow-task-5-worker",
          verified: true,
          verificationVerdict: "VERIFIED",
          autoMerged: true,
          mergeTargetBranch: "dev",
          mergeCommitSha: "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        },
      });
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("posts a terminal failed event when the local dispatch dies after start", async () => {
    const fixtureScopes: FixtureDispatchScope[] = [
      {
        projectId: "fixture-project",
        taskId: "TASK-4",
        jobId: "fed-task-failed",
        hostId: "laptop",
        leaseId: "lease-task-failed",
        sessionId: "sess-4",
      },
    ];
    const events: CapturedEvent[] = [];
    let polls = 0;
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          expectServiceTokenHeader(req);
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              jobs: [
                {
                  projectId: "fixture-project",
                  lease: { leaseId: "lease-task-failed", hostId: "laptop" },
                  jobId: "fed-task-failed",
                  taskId: "TASK-4",
                  jobType: "dispatch",
                  status: "assigned",
                  hostId: "laptop",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-task-failed/events") {
          expectServiceTokenHeader(req);
          events.push((await readJson(req)) as CapturedEvent);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const local = http.createServer(
      requestHandler((req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-4") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-4", title: "Visible task" }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-4/start") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionId: "sess-4" }));
          return;
        }
        if (
          req.method === "GET" &&
          (req.url === "/api/dispatch/jobs" || req.url?.includes("/dispatch/observation?"))
        ) {
          polls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          if (polls === 1) {
            res.end(
              JSON.stringify(
                dispatchFixturePayload(req, fixtureScopes, [
                  {
                    taskId: "TASK-4",
                    sessionId: "sess-4",
                    status: "running",
                    output: [],
                  },
                ]),
              ),
            );
            return;
          }
          res.end(
            JSON.stringify(
              dispatchFixturePayload(req, fixtureScopes, [
                {
                  taskId: "TASK-4",
                  sessionId: "sess-4",
                  status: "failed",
                  exitCode: 1,
                  branchName: "quack/TASK-4",
                  commitSha: "abcdef1234567890",
                  worktreePath: "C:/worker/TASK-4",
                  output: [
                    "Judge evaluation failed after retry: Claude Code process exited with code 1",
                  ],
                },
              ]),
            ),
          );
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
      ]);

      expect(result.body).toMatchObject({ ok: false, worked: true, jobId: "fed-task-failed" });
      expect(events.map((event) => event.status)).toEqual(["running", "failed"]);
      expect(events.at(-1)).toMatchObject({
        message: "laptop local dispatch failed for TASK-4.",
        evidence: [
          expect.objectContaining({
            type: "worker_execution",
            taskId: "TASK-4",
            localSessionId: "sess-4",
            localStatus: "failed",
            exitCode: 1,
            outputTail: [
              "Judge evaluation failed after retry: Claude Code process exited with code 1",
            ],
          }),
        ],
      });
    } finally {
      await close(local);
      await close(control);
    }
  });
  it("releases a recoverable pause without reporting failure", async () => {
    const fixtureScopes: FixtureDispatchScope[] = [
      {
        projectId: "demo",
        taskId: "TASK-PAUSE",
        jobId: "fed-pause",
        hostId: "laptop",
        leaseId: "lease-pause",
        sessionId: "session-pause",
      },
    ];
    const events: Array<CapturedEvent & Record<string, unknown>> = [];
    let released = false;
    let armed = false;
    const pauseOpenedAt = "2026-09-09T00:00:00.000Z";
    const pause = {
      generation: 1,
      state: "attached",
      gate: "judge",
      sessionId: "session-pause",
      originalHostId: "laptop",
      releaseNonce: "nonce-pause",
      openedAt: pauseOpenedAt,
    };
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jobs: [
                {
                  projectId: "demo",
                  jobId: "fed-pause",
                  taskId: "TASK-PAUSE",
                  jobType: "dispatch",
                  status: "assigned",
                  hostId: "laptop",
                  lease: { leaseId: "lease-pause" },
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-pause/events") {
          const body = (await readJson(req)) as CapturedEvent & Record<string, unknown>;
          events.push(body);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, job: { pause } }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-pause/pause/release") {
          released = true;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, job: { pause: { ...pause, state: "released" } } }));
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const local = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-PAUSE") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-PAUSE" }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-PAUSE/start") {
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionId: "session-pause" }));
          return;
        }
        if (
          req.method === "GET" &&
          (req.url === "/api/dispatch/jobs" || req.url?.includes("/dispatch/observation?"))
        ) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              dispatchFixturePayload(req, fixtureScopes, [
                {
                  taskId: "TASK-PAUSE",
                  sessionId: "session-pause",
                  status: "awaiting_approval",
                },
              ]),
            ),
          );
          return;
        }
        if (req.method === "GET" && req.url?.startsWith("/api/tasks/TASK-PAUSE/pause-state")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              paused: true,
              gate: "judge",
              createdAt: pauseOpenedAt,
              identity: {
                jobId: "fed-pause",
                taskId: "TASK-PAUSE",
                jobType: "dispatch",
                hostId: "laptop",
                sessionId: "session-pause",
              },
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-PAUSE/federated-resume/arm") {
          armed = true;
          await readJson(req);
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
      ]);
      expect(result).toMatchObject({ status: 202, ok: true });
      expect(result.body).toMatchObject({
        outcome: "awaiting_approval",
        worked: false,
        jobId: "fed-pause",
      });
      expect(armed).toBe(true);
      expect(released).toBe(true);
      expect(events.some((event) => event.status === "failed")).toBe(false);
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("contains a direct local restart when pause transport fails before exact grant arming", async () => {
    const fixtureScopes: FixtureDispatchScope[] = [
      {
        projectId: "demo",
        taskId: "TASK-UNBOUND",
        jobId: "fed-unbound-resume",
        hostId: "laptop",
        leaseId: "lease-unbound",
        sessionId: "session-unbound",
      },
    ];
    const events: Array<CapturedEvent & Record<string, unknown>> = [];
    let localPolls = 0;
    let pauseAnnouncements = 0;
    let stopAttempted = false;
    let releaseAttempted = false;
    const pauseOpenedAt = "2026-09-09T00:00:00.000Z";
    const pause = {
      generation: 1,
      state: "attached",
      gate: "judge",
      sessionId: "session-unbound",
      originalHostId: "laptop",
      releaseNonce: "nonce-unbound",
      openedAt: pauseOpenedAt,
    };
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jobs: [
                {
                  projectId: "demo",
                  jobId: "fed-unbound-resume",
                  taskId: "TASK-UNBOUND",
                  jobType: "dispatch",
                  status: "assigned",
                  hostId: "laptop",
                  lease: { leaseId: "lease-unbound" },
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-unbound-resume/events") {
          const body = (await readJson(req)) as CapturedEvent & Record<string, unknown>;
          events.push(body);
          if (body.status === "awaiting_approval") {
            pauseAnnouncements += 1;
            if (pauseAnnouncements === 1) {
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "lost_pause_announcement" }));
              return;
            }
          }
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, job: { pause } }));
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/v1/federation/jobs/fed-unbound-resume/pause/release"
        ) {
          releaseAttempted = true;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const local = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-UNBOUND") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-UNBOUND" }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-UNBOUND/start") {
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionId: "session-unbound" }));
          return;
        }
        if (
          req.method === "GET" &&
          (req.url === "/api/dispatch/jobs" || req.url?.includes("/dispatch/observation?"))
        ) {
          localPolls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              dispatchFixturePayload(req, fixtureScopes, [
                {
                  taskId: "TASK-UNBOUND",
                  sessionId: "session-unbound",
                  status: localPolls <= 2 ? "awaiting_approval" : "running",
                  output: [],
                },
              ]),
            ),
          );
          return;
        }
        if (req.method === "GET" && req.url?.startsWith("/api/tasks/TASK-UNBOUND/pause-state")) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              paused: true,
              gate: "judge",
              createdAt: pauseOpenedAt,
              identity: {
                jobId: "fed-unbound-resume",
                taskId: "TASK-UNBOUND",
                jobType: "dispatch",
                hostId: "laptop",
                sessionId: "session-unbound",
              },
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-UNBOUND/federated-resume/arm") {
          await readJson(req);
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "federated_pause_identity_mismatch" }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-UNBOUND/stop") {
          stopAttempted = true;
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
        "--poll-ms",
        "10",
      ]);
      expect(result.body).toMatchObject({
        ok: true,
        worked: false,
        outcome: "awaiting_approval",
        jobId: "fed-unbound-resume",
      });
      expect(stopAttempted).toBe(true);
      expect(releaseAttempted).toBe(false);
      expect(pauseAnnouncements).toBeGreaterThanOrEqual(2);
      expect(events.filter((event) => event.status === "running")).toHaveLength(1);
      expect(events.some((event) => event.resumeGrant)).toBe(false);
      expect(events.filter((event) => event.status === "awaiting_approval")).toHaveLength(2);
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("reclaims a released pause and completes against the original job id", async () => {
    const fixtureScopes: FixtureDispatchScope[] = [
      {
        projectId: "demo",
        taskId: "TASK-RESUME",
        jobId: "fed-resume",
        hostId: "laptop",
        leaseId: "lease-resume",
        sessionId: "session-resumed",
      },
    ];
    const calls: string[] = [];
    const resumeEvents: CapturedEvent[] = [];
    const pauseOpenedAt = "2026-09-09T00:00:00.000Z";
    const pause = {
      generation: 3,
      state: "released",
      gate: "judge",
      sessionId: "session-original",
      originalHostId: "laptop",
      releaseNonce: "nonce-3",
      openedAt: pauseOpenedAt,
    };
    const startGrant = {
      token: "grant-3",
      projectId: "demo",
      jobId: "fed-resume",
      taskId: "TASK-RESUME",
      jobType: "dispatch",
      hostId: "laptop",
      originalSessionId: "session-original",
      generation: 3,
      releaseNonce: "nonce-3",
      claimToken: "claim-3",
      leaseId: "lease-resume",
      issuedAt: "2026-09-09T00:00:00.000Z",
      expiresAt: "2099-09-09T00:05:00.000Z",
    };
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jobs: [
                {
                  lease: { leaseId: "lease-resume", hostId: "laptop" },
                  projectId: "demo",
                  jobId: "fed-resume",
                  taskId: "TASK-RESUME",
                  jobType: "dispatch",
                  status: "awaiting_approval",
                  hostId: "laptop",
                  pause,
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url?.startsWith("/v1/federation/jobs/fed-resume/")) {
          calls.push(req.url);
          const body = await readJson(req);
          if (req.url.endsWith("/resume/request")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                job: {
                  status: "awaiting_approval",
                  pause: { ...pause, state: "resume_requested", decision: body.decision },
                },
              }),
            );
            return;
          }
          if (req.url.endsWith("/resume/claim")) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                job: {
                  status: "awaiting_approval",
                  lease: { leaseId: "lease-resume", hostId: "laptop" },
                  pause: {
                    ...pause,
                    state: "resume_claimed",
                    claim: { token: "claim-3", hostId: "laptop" },
                  },
                },
              }),
            );
            return;
          }
          if (req.url.endsWith("/resume/ack")) {
            expect(body).toMatchObject({
              projectId: "demo",
              taskId: "TASK-RESUME",
              jobType: "dispatch",
              hostId: "laptop",
              originalSessionId: "session-original",
              generation: 3,
              releaseNonce: "nonce-3",
              claimToken: "claim-3",
              leaseId: "lease-resume",
            });
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify({
                startGrant,
                job: { lease: { leaseId: "lease-resume" }, pause: { startGrant } },
              }),
            );
            return;
          }
          if (req.url.endsWith("/events")) {
            resumeEvents.push(body as CapturedEvent);
            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
        }
        res.writeHead(404).end();
      }),
    );
    const local = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-RESUME") {
          expect(req.headers["x-project-id"]).toBe("demo");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-RESUME" }));
          return;
        }
        if (
          req.method === "GET" &&
          req.url?.startsWith("/api/tasks/TASK-RESUME/federated-resume-state")
        ) {
          expect(req.headers["x-project-id"]).toBe("demo");
          expect(req.url).toContain("projectId=demo");
          expect(req.url).toContain("jobId=fed-resume");
          expect(req.url).toContain("originalSessionId=session-original");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              state: {
                projectId: "demo",
                taskId: "TASK-RESUME",
                jobType: "dispatch",
                jobId: "fed-resume",
                hostId: "laptop",
                sessionId: "session-original",
                generation: 3,
                releaseNonce: "nonce-3",
                pauseOpenedAt,
                decision: { action: "approved" },
              },
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-RESUME/federated-resume/grant") {
          calls.push(req.url);
          expect(await readJson(req)).toEqual({
            projectId: "demo",
            originalSessionId: "session-original",
            startGrant,
          });
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, state: { startGrant } }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-RESUME/federated-resume/start") {
          calls.push(req.url);
          expect(await readJson(req)).toEqual({
            projectId: "demo",
            originalSessionId: "session-original",
            startGrant,
          });
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionId: "session-resumed" }));
          return;
        }
        if (
          req.method === "GET" &&
          (req.url === "/api/dispatch/jobs" || req.url?.includes("/dispatch/observation?"))
        ) {
          expect(req.headers["x-project-id"]).toBe("demo");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              dispatchFixturePayload(req, fixtureScopes, [
                {
                  taskId: "TASK-RESUME",
                  sessionId: "session-resumed",
                  status: "completed",
                  output: [],
                },
              ]),
            ),
          );
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
      ]);
      expect(result.body).toMatchObject({
        ok: true,
        worked: true,
        outcome: "completed",
        jobId: "fed-resume",
      });
      expect(calls).toEqual(
        expect.arrayContaining([
          "/v1/federation/jobs/fed-resume/resume/request",
          "/v1/federation/jobs/fed-resume/resume/claim",
          "/v1/federation/jobs/fed-resume/resume/ack",
          "/api/tasks/TASK-RESUME/federated-resume/grant",
          "/api/tasks/TASK-RESUME/federated-resume/start",
          "/v1/federation/jobs/fed-resume/events",
        ]),
      );
      expect(resumeEvents).toEqual([
        expect.objectContaining({
          status: "running",
          resumeGrant: startGrant,
          resumeSessionId: "session-resumed",
          remoteSessionId: "session-resumed",
        }),
        expect.objectContaining({
          status: "completed",
          resumeGrant: startGrant,
          resumeSessionId: "session-resumed",
        }),
      ]);
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("keeps an exact resumed child monitored when its running announcement is lost through grant expiry", async () => {
    const fixtureScopes: FixtureDispatchScope[] = [
      {
        projectId: "demo",
        taskId: "TASK-LOST-ANNOUNCEMENT",
        jobId: "fed-lost-announcement",
        hostId: "laptop",
        leaseId: "lease-lost-announcement",
        sessionId: "session-resumed",
      },
    ];
    let runningAnnouncements = 0;
    let localPolls = 0;
    let stopAttempted = false;
    let renewedLeaseId: string | undefined;
    let ackCalls = 0;
    const pauseOpenedAt = "2026-09-09T00:00:00.000Z";
    const reportedReservationTimes: Array<string | undefined> = [];
    const terminalEvents: CapturedEvent[] = [];
    const startGrant = {
      token: "grant-lost-announcement",
      projectId: "demo",
      jobId: "fed-lost-announcement",
      taskId: "TASK-LOST-ANNOUNCEMENT",
      jobType: "dispatch",
      hostId: "laptop",
      originalSessionId: "session-original",
      generation: 4,
      releaseNonce: "nonce-4",
      claimToken: "claim-4",
      leaseId: "lease-lost-announcement",
      issuedAt: new Date(Date.now() - 1_000).toISOString(),
      expiresAt: new Date(Date.now() + 100).toISOString(),
    };
    const pause = {
      generation: 4,
      state: "approved_but_not_started",
      gate: "judge",
      sessionId: "session-original",
      originalHostId: "laptop",
      releaseNonce: "nonce-4",
      openedAt: pauseOpenedAt,
      claim: { token: "claim-4", hostId: "laptop" },
      startGrant,
    };
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jobs: [
                {
                  projectId: "demo",
                  jobId: "fed-lost-announcement",
                  taskId: "TASK-LOST-ANNOUNCEMENT",
                  jobType: "dispatch",
                  status: "awaiting_approval",
                  hostId: "laptop",
                  lease: { leaseId: startGrant.leaseId, hostId: "laptop" },
                  pause,
                },
              ],
            }),
          );
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/v1/federation/jobs/fed-lost-announcement/resume/ack"
        ) {
          ackCalls += 1;
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ startGrant }));
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/v1/federation/jobs/fed-lost-announcement/events"
        ) {
          const body = (await readJson(req)) as CapturedEvent;
          if (body.status === "running") {
            runningAnnouncements += 1;
            reportedReservationTimes.push(body.resumeStartedAt);
            if (runningAnnouncements === 1) {
              await new Promise((resolve) => setTimeout(resolve, 150));
              res.writeHead(503, { "Content-Type": "application/json" });
              res.end(JSON.stringify({ error: "lost_running_announcement" }));
              return;
            }
            res.writeHead(202, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: true }));
            return;
          }
          terminalEvents.push(body);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/v1/federation/jobs/fed-lost-announcement/lease/renew"
        ) {
          const body = (await readJson(req)) as { leaseId?: string };
          renewedLeaseId = body.leaseId;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const local = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-LOST-ANNOUNCEMENT") {
          expect(req.headers["x-project-id"]).toBe("demo");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-LOST-ANNOUNCEMENT" }));
          return;
        }
        if (
          req.method === "GET" &&
          req.url?.startsWith("/api/tasks/TASK-LOST-ANNOUNCEMENT/federated-resume-state")
        ) {
          expect(req.headers["x-project-id"]).toBe("demo");
          expect(req.url).toContain("projectId=demo");
          expect(req.url).toContain("jobId=fed-lost-announcement");
          expect(req.url).toContain("originalSessionId=session-original");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              state: {
                projectId: "demo",
                taskId: "TASK-LOST-ANNOUNCEMENT",
                jobType: "dispatch",
                jobId: "fed-lost-announcement",
                hostId: "laptop",
                sessionId: "session-original",
                generation: 4,
                releaseNonce: "nonce-4",
                pauseOpenedAt,
                decision: { action: "approved" },
              },
            }),
          );
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/api/tasks/TASK-LOST-ANNOUNCEMENT/federated-resume/grant"
        ) {
          expect(await readJson(req)).toEqual({
            projectId: "demo",
            originalSessionId: "session-original",
            startGrant,
          });
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/api/tasks/TASK-LOST-ANNOUNCEMENT/federated-resume/start"
        ) {
          expect(await readJson(req)).toEqual({
            projectId: "demo",
            originalSessionId: "session-original",
            startGrant,
          });
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              sessionId: "session-resumed",
              state: { startGrantConsumedAt: startGrant.issuedAt },
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-LOST-ANNOUNCEMENT/stop") {
          stopAttempted = true;
          expect(await readJson(req)).toEqual({
            projectId: "demo",
            resumedSessionId: "session-resumed",
          });
          res.writeHead(409, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              error: "stop could not be confirmed",
              terminationConfirmed: false,
            }),
          );
          return;
        }
        if (
          req.method === "GET" &&
          (req.url === "/api/dispatch/jobs" || req.url?.includes("/dispatch/observation?"))
        ) {
          expect(req.headers["x-project-id"]).toBe("demo");
          localPolls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              dispatchFixturePayload(req, fixtureScopes, [
                {
                  taskId: "TASK-LOST-ANNOUNCEMENT",
                  sessionId: "session-resumed",
                  status: localPolls <= 2 ? "running" : "completed",
                  output: [],
                },
              ]),
            ),
          );
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
        "--poll-ms",
        "10",
        "--lease-renew-ms",
        "10",
      ]);
      expect(result.body).toMatchObject({
        ok: true,
        worked: true,
        outcome: "completed",
        jobId: "fed-lost-announcement",
      });
      expect(stopAttempted).toBe(true);
      expect(ackCalls).toBe(0);
      expect(localPolls).toBeGreaterThanOrEqual(3);
      expect(runningAnnouncements).toBeGreaterThanOrEqual(2);
      expect(reportedReservationTimes).toHaveLength(runningAnnouncements);
      expect(reportedReservationTimes.every((value) => value === startGrant.issuedAt)).toBe(true);
      expect(renewedLeaseId).toBe(startGrant.leaseId);
      expect(terminalEvents).toEqual([
        expect.objectContaining({
          status: "completed",
          resumeGrant: startGrant,
          resumeSessionId: "session-resumed",
        }),
      ]);
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("forwards an exact blueprint-rejection grant as a terminal event without a child", async () => {
    const terminalEvents: CapturedEvent[] = [];
    let ackCalls = 0;
    let renewedLeaseId: string | undefined;
    const pauseOpenedAt = "2026-09-09T00:00:00.000Z";
    const resumeStartedAt = new Date(Date.now() - 1_000).toISOString();
    const startGrant = {
      token: "grant-blueprint",
      projectId: "demo",
      jobId: "fed-blueprint-reject",
      taskId: "TASK-BLUEPRINT",
      jobType: "dispatch",
      hostId: "laptop",
      originalSessionId: "session-blueprint",
      generation: 2,
      releaseNonce: "nonce-blueprint",
      claimToken: "claim-blueprint",
      leaseId: "lease-blueprint",
      issuedAt: resumeStartedAt,
      expiresAt: new Date(Date.now() + 100).toISOString(),
    };
    const pause = {
      generation: 2,
      state: "approved_but_not_started",
      gate: "blueprint",
      sessionId: "session-blueprint",
      originalHostId: "laptop",
      releaseNonce: "nonce-blueprint",
      openedAt: pauseOpenedAt,
      claim: { token: "claim-blueprint", hostId: "laptop" },
      startGrant,
    };
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jobs: [
                {
                  projectId: "demo",
                  jobId: "fed-blueprint-reject",
                  taskId: "TASK-BLUEPRINT",
                  jobType: "dispatch",
                  status: "awaiting_approval",
                  hostId: "laptop",
                  lease: { leaseId: "lease-blueprint", hostId: "laptop" },
                  pause,
                },
              ],
            }),
          );
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/v1/federation/jobs/fed-blueprint-reject/resume/ack"
        ) {
          ackCalls += 1;
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ startGrant }));
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/v1/federation/jobs/fed-blueprint-reject/events"
        ) {
          terminalEvents.push((await readJson(req)) as CapturedEvent);
          if (terminalEvents.length === 1) {
            await new Promise((resolve) => setTimeout(resolve, 150));
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ error: "lost_terminal_announcement" }));
            return;
          }
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/v1/federation/jobs/fed-blueprint-reject/lease/renew"
        ) {
          const body = (await readJson(req)) as { leaseId?: string };
          renewedLeaseId = body.leaseId;
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const local = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-BLUEPRINT") {
          expect(req.headers["x-project-id"]).toBe("demo");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-BLUEPRINT" }));
          return;
        }
        if (
          req.method === "GET" &&
          req.url?.startsWith("/api/tasks/TASK-BLUEPRINT/federated-resume-state")
        ) {
          expect(req.headers["x-project-id"]).toBe("demo");
          expect(req.url).toContain("projectId=demo");
          expect(req.url).toContain("jobId=fed-blueprint-reject");
          expect(req.url).toContain("originalSessionId=session-blueprint");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              state: {
                projectId: "demo",
                taskId: "TASK-BLUEPRINT",
                jobType: "dispatch",
                jobId: "fed-blueprint-reject",
                hostId: "laptop",
                sessionId: "session-blueprint",
                generation: 2,
                releaseNonce: "nonce-blueprint",
                pauseOpenedAt,
                decision: { action: "rejected" },
              },
            }),
          );
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/api/tasks/TASK-BLUEPRINT/federated-resume/grant"
        ) {
          expect(await readJson(req)).toEqual({
            projectId: "demo",
            originalSessionId: "session-blueprint",
            startGrant,
          });
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/api/tasks/TASK-BLUEPRINT/federated-resume/start"
        ) {
          expect(await readJson(req)).toEqual({
            projectId: "demo",
            originalSessionId: "session-blueprint",
            startGrant,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              terminal: true,
              state: { startGrantConsumedAt: resumeStartedAt },
            }),
          );
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
        "--poll-ms",
        "10",
      ]);
      expect(result.body).toMatchObject({
        ok: true,
        worked: true,
        outcome: "completed",
        jobId: "fed-blueprint-reject",
      });
      expect(ackCalls).toBe(0);
      expect(renewedLeaseId).toBe(startGrant.leaseId);
      expect(terminalEvents).toHaveLength(2);
      for (const event of terminalEvents) {
        expect(event).toEqual(
          expect.objectContaining({
            status: "rejected",
            resumeGrant: startGrant,
            resumeStartedAt,
          }),
        );
      }
      expect(terminalEvents[0]).not.toHaveProperty("resumeSessionId");
    } finally {
      await close(local);
      await close(control);
    }
  });
});

describe("quack-listener worker.refresh command", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-listener-refresh-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function createDirtyRepo(): string {
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(repo, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "quack@example.test"], {
      cwd: repo,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Quack Test"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "tracked.txt"), "clean\n");
    execFileSync("git", ["add", "."], { cwd: repo, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: repo, stdio: "ignore" });
    fs.writeFileSync(path.join(repo, "tracked.txt"), "dirty\n");
    return repo;
  }

  function createRepoWithRuntimeArtifacts(): { repo: string; remoteCommit: string } {
    const { repo, remoteCommit } = createRefreshableRepo();
    fs.mkdirSync(path.join(repo, ".quack", "admin-runs"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".quack", "docs-pipeline"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".quack", "evidence"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".quack", "intake"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".quack", "reviews"), { recursive: true });
    fs.mkdirSync(path.join(repo, ".quack-from-clone"), { recursive: true });
    fs.writeFileSync(path.join(repo, ".quack", "admin-runs", "run.json"), "{}\n");
    fs.writeFileSync(path.join(repo, ".quack", "docs-pipeline", "job.jsonl"), "{}\n");
    fs.writeFileSync(path.join(repo, ".quack", "evidence", "TASK-1.json"), "{}\n");
    fs.writeFileSync(path.join(repo, ".quack", "intake", "draft.json"), "{}\n");
    fs.writeFileSync(path.join(repo, ".quack", "reviews", "review-task-1.json"), "{}\n");
    fs.writeFileSync(path.join(repo, ".quack-from-clone", "note.txt"), "runtime\n");
    return { repo, remoteCommit };
  }

  function createRefreshableRepo(): { repo: string; remoteCommit: string } {
    const seed = path.join(tmpDir, "seed");
    const remote = path.join(tmpDir, "remote.git");
    const repo = path.join(tmpDir, "repo");
    fs.mkdirSync(seed, { recursive: true });
    execFileSync("git", ["init", "-b", "main"], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "quack@example.test"], {
      cwd: seed,
      stdio: "ignore",
    });
    execFileSync("git", ["config", "user.name", "Quack Test"], { cwd: seed, stdio: "ignore" });
    fs.writeFileSync(path.join(seed, "tracked.txt"), "one\n");
    execFileSync("git", ["add", "."], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["init", "--bare", remote], { cwd: tmpDir, stdio: "ignore" });
    execFileSync("git", ["remote", "add", "origin", remote], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["push", "-u", "origin", "main"], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["--git-dir", remote, "symbolic-ref", "HEAD", "refs/heads/main"], {
      cwd: tmpDir,
      stdio: "ignore",
    });
    execFileSync("git", ["clone", remote, repo], { cwd: tmpDir, stdio: "ignore" });
    fs.writeFileSync(path.join(seed, "tracked.txt"), "two\n");
    execFileSync("git", ["add", "."], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "advance"], { cwd: seed, stdio: "ignore" });
    execFileSync("git", ["push", "origin", "main"], { cwd: seed, stdio: "ignore" });
    const remoteCommit = execFileSync("git", ["rev-parse", "--short", "HEAD"], {
      cwd: seed,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return { repo, remoteCommit };
  }

  it("fast-forwards a clean selected repo and acknowledges refreshed metadata", async () => {
    const { repo, remoteCommit } = createRefreshableRepo();
    const ackBodies: Array<Record<string, unknown>> = [];
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/commands") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              commands: [
                {
                  commandId: "refresh-clean",
                  protocolVersion: "worker-command-v1",
                  kind: "worker.refresh",
                  issuedAt: "2026-05-13T00:00:00.000Z",
                  payload: {
                    reason: "test",
                    repos: ["quack"],
                    branches: { quack: "main" },
                    maxDirtyAction: "block",
                    runCapabilityProbes: false,
                  },
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/commands/ack") {
          expectServiceTokenHeader(req);
          ackBodies.push(await readJson(req));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    try {
      await runListenerText([
        "once",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
        "--repo-path",
        repo,
      ]);

      expect(
        execFileSync("git", ["rev-parse", "--short", "HEAD"], {
          cwd: repo,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      ).toBe(remoteCommit);
      const ackBody = ackBodies[0] as WorkerRefreshAckBody;
      const result = ackBody.results?.[0];
      expect(result?.kind).toBe("worker.refresh");
      expect(result?.status).toBe("completed");
      expect(result?.metadata?.repos?.[0]).toMatchObject({
        repoKey: "quack",
        status: "refreshed",
        commitAfter: remoteCommit,
      });
    } finally {
      await close(control);
    }
  });

  it("blocks refresh when a selected repo is dirty and acknowledges structured drift", async () => {
    const repo = createDirtyRepo();
    const ackBodies: Array<Record<string, unknown>> = [];
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/commands") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              commands: [
                {
                  commandId: "refresh-1",
                  protocolVersion: "worker-command-v1",
                  kind: "worker.refresh",
                  issuedAt: "2026-05-13T00:00:00.000Z",
                  payload: {
                    reason: "test",
                    repos: ["quack"],
                    maxDirtyAction: "block",
                    runCapabilityProbes: false,
                  },
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/commands/ack") {
          expectServiceTokenHeader(req);
          ackBodies.push(await readJson(req));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    try {
      await runListenerText([
        "once",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
        "--repo-path",
        repo,
      ]);

      expect(ackBodies).toHaveLength(1);
      const ackBody = ackBodies[0] as WorkerRefreshAckBody;
      expect(ackBody.commandIds).toEqual(["refresh-1"]);
      expect(ackBody.results).toHaveLength(1);
      const result = ackBody.results?.[0];
      expect(result?.kind).toBe("worker.refresh");
      expect(result?.status).toBe("failed");
      expect(result?.errorCategory).toBe("execution_failed");
      expect(result?.metadata?.repos?.[0]).toMatchObject({
        repoKey: "quack",
        status: "blocked",
        blocker: "dirty_worktree",
      });
    } finally {
      await close(control);
    }
  });

  it("ignores untracked Quack runtime artifacts during worker refresh", async () => {
    const { repo, remoteCommit } = createRepoWithRuntimeArtifacts();
    const ackBodies: Array<Record<string, unknown>> = [];
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/commands") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              commands: [
                {
                  commandId: "refresh-runtime-artifacts",
                  protocolVersion: "worker-command-v1",
                  kind: "worker.refresh",
                  issuedAt: "2026-05-19T00:00:00.000Z",
                  payload: {
                    reason: "post-merge",
                    repos: ["quack"],
                    branches: { quack: "main" },
                    maxDirtyAction: "block",
                    runCapabilityProbes: false,
                  },
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/commands/ack") {
          expectServiceTokenHeader(req);
          ackBodies.push(await readJson(req));
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    try {
      await runListenerText([
        "once",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
        "--repo-path",
        repo,
      ]);

      expect(
        execFileSync("git", ["rev-parse", "--short", "HEAD"], {
          cwd: repo,
          encoding: "utf-8",
          stdio: ["ignore", "pipe", "ignore"],
        }).trim(),
      ).toBe(remoteCommit);
      const ackBody = ackBodies[0] as WorkerRefreshAckBody;
      const result = ackBody.results?.[0];
      expect(result?.kind).toBe("worker.refresh");
      expect(result?.status).toBe("completed");
      expect(result?.metadata?.repos?.[0]).toMatchObject({
        repoKey: "quack",
        status: "refreshed",
        ignoredRuntimeDirtyCount: 6,
        commitAfter: remoteCommit,
      });
      expect(result?.metadata?.repos?.[0]).not.toHaveProperty("dirtyStatus");
    } finally {
      await close(control);
    }
  });

  it("reports a completed no-change dispatch as a completed federated job", async () => {
    const fixtureScopes: FixtureDispatchScope[] = [
      {
        projectId: "fixture-project",
        taskId: "TASK-6",
        jobId: "fed-task-no-changes",
        hostId: "laptop",
        leaseId: "lease-task-no-changes",
        sessionId: "sess-6",
      },
    ];
    const events: CapturedEvent[] = [];
    let polls = 0;
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          expectServiceTokenHeader(req);
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              jobs: [
                {
                  projectId: "fixture-project",
                  lease: { leaseId: "lease-task-no-changes", hostId: "laptop" },
                  jobId: "fed-task-no-changes",
                  taskId: "TASK-6",
                  jobType: "dispatch",
                  status: "assigned",
                  hostId: "laptop",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-task-no-changes/events") {
          expectServiceTokenHeader(req);
          events.push((await readJson(req)) as CapturedEvent);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const local = http.createServer(
      requestHandler((req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-6") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-6", title: "Visible task" }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-6/start") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionId: "sess-6" }));
          return;
        }
        if (
          req.method === "GET" &&
          (req.url === "/api/dispatch/jobs" || req.url?.includes("/dispatch/observation?"))
        ) {
          polls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          if (polls === 1) {
            res.end(
              JSON.stringify(
                dispatchFixturePayload(req, fixtureScopes, [
                  {
                    taskId: "TASK-6",
                    sessionId: "sess-6",
                    status: "running",
                    output: [],
                  },
                ]),
              ),
            );
            return;
          }
          res.end(
            JSON.stringify(
              dispatchFixturePayload(req, fixtureScopes, [
                {
                  taskId: "TASK-6",
                  sessionId: "sess-6",
                  status: "completed",
                  exitCode: 0,
                  branchName: "main",
                  commitSha: "1234567890abcdef",
                  worktreePath: "C:/worker/TASK-6",
                  output: [
                    "Task TASK-6: NO CHANGES",
                    "Agent completed but produced no committed changes.",
                  ],
                },
              ]),
            ),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/api/tasks/TASK-6/runs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ runs: [{ sessionId: "sess-6" }] }));
          return;
        }
        if (req.method === "GET" && req.url === "/api/sessions/sess-6") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              sessionFixtureEvents(req, fixtureScopes, [
                {
                  stage: "session_complete",
                  payload: { verified: true, verificationVerdict: "VERIFIED" },
                },
              ]),
            ),
          );
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
      ]);

      expect(result.body).toMatchObject({ ok: true, worked: true, jobId: "fed-task-no-changes" });
      expect(events.map((event) => event.status)).toEqual(["running", "completed"]);
      expect(events.at(-1)).toMatchObject({
        message: "laptop local dispatch completed for TASK-6.",
        workerCompletion: {
          canonicalSessionId: "sess-6",
          verified: true,
          verificationVerdict: "VERIFIED",
        },
        evidence: [
          expect.objectContaining({
            type: "worker_execution",
            taskId: "TASK-6",
            localSessionId: "sess-6",
            localStatus: "completed",
            exitCode: 0,
            outputTail: [
              "Task TASK-6: NO CHANGES",
              "Agent completed but produced no committed changes.",
            ],
          }),
        ],
      });
    } finally {
      await close(local);
      await close(control);
    }
  });
});

describe("quack-listener registration and command protocol", () => {
  it("shrinks advertised capacity when the local runtime reports worktree degradation", async () => {
    let heartbeatBody: Record<string, unknown> | undefined;
    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          expectServiceTokenHeader(req);
          heartbeatBody = await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop", healthy: true } }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const local = http.createServer(
      requestHandler((req, res) => {
        if (req.method === "GET" && req.url === "/api/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "degraded",
              runtimeRole: "worker",
              worktreeDegraded: true,
              dbDegraded: false,
              projectRoot: "C:/worker/example",
              commit: "abc123",
            }),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/api/testing/commands") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([]));
          return;
        }
        if (req.method === "GET" && req.url === "/api/dispatch/jobs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([]));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "heartbeat",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-runtime-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
        "--max-concurrent",
        "4",
      ]);

      expect(result.status).toBe(200);
      expect(heartbeatBody).toMatchObject({
        healthy: true,
        maxConcurrentJobs: 1,
        runtimeRole: "worker",
        protocolVersion: "worker-command-v1",
      });
      expect(
        (heartbeatBody as { metadata?: Record<string, unknown> } | undefined)?.metadata,
      ).toMatchObject({
        localRuntimeRole: "worker",
        worktreeDegraded: true,
        capacityWarning: "worktree_degraded",
      });
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("executes typed commands locally and acknowledges structured results back to Headnode", async () => {
    let ackBody: Record<string, unknown> | undefined;
    let heartbeatBody: Record<string, unknown> | undefined;

    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/register") {
          expectServiceTokenHeader(req);
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop", healthy: true } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/commands") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              commands: [
                {
                  commandId: "cmd-diag-1",
                  protocolVersion: "worker-command-v1",
                  kind: "collect_diagnostics",
                  issuedAt: "2026-05-04T12:00:00.000Z",
                  issuedBy: "admin",
                  payload: {
                    includeJobs: true,
                    includeHealth: true,
                  },
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/commands/ack") {
          expectServiceTokenHeader(req);
          ackBody = await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, acknowledged: [{ commandId: "cmd-diag-1" }] }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          expectServiceTokenHeader(req);
          heartbeatBody = await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop", healthy: true } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, jobs: [] }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const local = http.createServer(
      requestHandler((req, res) => {
        if (req.method === "GET" && req.url === "/api/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              status: "ok",
              runtimeRole: "worker",
              worktreeDegraded: false,
              dbDegraded: false,
              projectRoot: "C:/worker/example",
              commit: "abc123",
            }),
          );
          return;
        }
        if (req.method === "GET" && req.url === "/api/testing/commands") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify([]));
          return;
        }
        if (req.method === "GET" && req.url === "/api/dispatch/jobs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify([
              {
                taskId: "TASK-0",
                sessionId: "sess-0",
                status: "running",
                output: [],
              },
            ]),
          );
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      await runListenerText([
        "once",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-runtime-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
        "--max-concurrent",
        "3",
      ]);

      expect(ackBody).toMatchObject({
        commandIds: ["cmd-diag-1"],
        results: [
          expect.objectContaining({
            commandId: "cmd-diag-1",
            protocolVersion: "worker-command-v1",
            kind: "collect_diagnostics",
            status: "completed",
            message: "Collected worker diagnostics.",
          }),
        ],
      });
      const firstAckResult = (
        ackBody as
          | {
              results?: Array<{ metadata?: Record<string, unknown> }>;
            }
          | undefined
      )?.results?.[0];
      expect(firstAckResult?.metadata).toMatchObject({
        health: {
          status: 200,
          ok: true,
        },
        dispatchJobs: {
          status: 200,
          ok: true,
        },
      });
      expect(heartbeatBody).toMatchObject({
        runtimeRole: "worker",
        protocolVersion: "worker-command-v1",
      });
      expect(
        (heartbeatBody as { lastCommand?: Record<string, unknown> } | undefined)?.lastCommand,
      ).toMatchObject({
        kind: "collect_diagnostics",
        status: "completed",
      });
    } finally {
      await close(local);
      await close(control);
    }
  });
});

describe("quack-listener daemon command", () => {
  it("fans out assigned jobs up to maxConcurrent without waiting for the first run to finish", async () => {
    const fixtureScopes: FixtureDispatchScope[] = [
      {
        projectId: "fixture-project",
        taskId: "TASK-1",
        jobId: "fed-task-1",
        hostId: "laptop",
        leaseId: "lease-task-1",
        sessionId: "sess-TASK-1",
      },
      {
        projectId: "fixture-project",
        taskId: "TASK-2",
        jobId: "fed-task-2",
        hostId: "laptop",
        leaseId: "lease-task-2",
        sessionId: "sess-TASK-2",
      },
    ];
    const events: CapturedEvent[] = [];
    const startCalls: string[] = [];

    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/register") {
          expectServiceTokenHeader(req);
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          expectServiceTokenHeader(req);
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              jobs: [
                {
                  projectId: "fixture-project",
                  jobId: "fed-task-1",
                  taskId: "TASK-1",
                  jobType: "dispatch",
                  status: "assigned",
                  hostId: "laptop",
                  lease: { leaseId: "lease-task-1", hostId: "laptop" },
                },
                {
                  projectId: "fixture-project",
                  lease: { leaseId: "lease-task-2", hostId: "laptop" },
                  jobId: "fed-task-2",
                  taskId: "TASK-2",
                  jobType: "dispatch",
                  status: "assigned",
                  hostId: "laptop",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-task-1/events") {
          expectServiceTokenHeader(req);
          events.push((await readJson(req)) as CapturedEvent);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-task-2/events") {
          expectServiceTokenHeader(req);
          events.push((await readJson(req)) as CapturedEvent);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-task-1/lease/renew") {
          expectServiceTokenHeader(req);
          expect(await readJson(req)).toMatchObject({ leaseId: "lease-task-1" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-task-2/lease/renew") {
          expectServiceTokenHeader(req);
          expect(await readJson(req)).toMatchObject({ leaseId: "lease-task-2" });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const local = http.createServer(
      requestHandler((req, res) => {
        if (
          req.method === "GET" &&
          (req.url === "/api/tasks/TASK-1" || req.url === "/api/tasks/TASK-2")
        ) {
          const taskId = req.url.split("/").at(-1);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: taskId, title: `Visible task ${taskId}` }));
          return;
        }
        if (
          req.method === "POST" &&
          (req.url === "/api/tasks/TASK-1/start" || req.url === "/api/tasks/TASK-2/start")
        ) {
          const taskId = req.url.split("/")[3];
          startCalls.push(taskId);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionId: `sess-${taskId}` }));
          return;
        }
        if (
          req.method === "GET" &&
          (req.url === "/api/dispatch/jobs" || req.url?.includes("/dispatch/observation?"))
        ) {
          const startedTasks = [...startCalls];
          const allStarted = startedTasks.includes("TASK-1") && startedTasks.includes("TASK-2");
          if (!allStarted) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify(
                dispatchFixturePayload(
                  req,
                  fixtureScopes,
                  startedTasks.map((taskId) => ({
                    taskId,
                    sessionId: `sess-${taskId}`,
                    status: "running",
                    output: [],
                  })),
                ),
              ),
            );
            return;
          }

          const status = "completed";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              dispatchFixturePayload(req, fixtureScopes, [
                {
                  taskId: "TASK-1",
                  sessionId: "sess-TASK-1",
                  status,
                  output: [],
                },
                {
                  taskId: "TASK-2",
                  sessionId: "sess-TASK-2",
                  status,
                  output: [],
                },
              ]),
            ),
          );
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "daemon",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
        "--max-concurrent",
        "2",
        "--max-jobs",
        "2",
        "--poll-ms",
        "10",
      ]);

      expect(result.body).toMatchObject({ ok: true, worked: true, completedJobs: 2 });
      expect(startCalls).toEqual(expect.arrayContaining(["TASK-1", "TASK-2"]));
      expect(startCalls).toHaveLength(2);
      expect(events.filter((event) => event.status === "running")).toHaveLength(2);
      expect(events.filter((event) => event.status === "completed")).toHaveLength(2);
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("reconciles a durably reserved resume after daemon restart even when the child fills capacity", async () => {
    const fixtureScopes: FixtureDispatchScope[] = [
      {
        projectId: "demo",
        taskId: "TASK-RESTART-RESUME",
        jobId: "fed-restart-resume",
        hostId: "laptop",
        leaseId: "restart-lease",
        sessionId: "session-after-restart",
      },
    ];
    const pauseOpenedAt = "2026-09-09T00:00:00.000Z";
    const consumedAt = "2026-09-09T00:01:00.000Z";
    const startGrant = {
      token: "restart-grant",
      projectId: "demo",
      jobId: "fed-restart-resume",
      taskId: "TASK-RESTART-RESUME",
      jobType: "dispatch",
      hostId: "laptop",
      originalSessionId: "session-before-restart",
      generation: 2,
      releaseNonce: "restart-nonce",
      claimToken: "restart-claim",
      leaseId: "restart-lease",
      issuedAt: "2026-09-09T00:00:30.000Z",
      expiresAt: "2099-09-09T00:05:00.000Z",
    };
    const pauseState = {
      generation: 2,
      state: "approved_but_not_started",
      gate: "judge",
      sessionId: "session-before-restart",
      originalHostId: "laptop",
      releaseNonce: "restart-nonce",
      openedAt: pauseOpenedAt,
      claim: { token: "restart-claim", hostId: "laptop" },
      startGrant,
    };
    const localState = {
      lease: { leaseId: "restart-lease", hostId: "laptop" },
      projectId: "demo",
      taskId: "TASK-RESTART-RESUME",
      jobType: "dispatch",
      gate: "judge",
      jobId: "fed-restart-resume",
      hostId: "laptop",
      sessionId: "session-before-restart",
      generation: 2,
      releaseNonce: "restart-nonce",
      pauseOpenedAt,
      status: "approved_but_not_started",
      decision: { action: "approved" },
      startGrant,
      startGrantConsumedAt: consumedAt,
    };
    const events: CapturedEvent[] = [];
    let dispatchJobReads = 0;
    let resumeStarts = 0;

    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/register") {
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              jobs: [
                {
                  projectId: "demo",
                  jobId: "fed-restart-resume",
                  taskId: "TASK-RESTART-RESUME",
                  jobType: "dispatch",
                  status: "awaiting_approval",
                  hostId: "laptop",
                  lease: {
                    leaseId: "restart-lease",
                    hostId: "laptop",
                    expiresAt: "2099-09-09T00:30:00.000Z",
                  },
                  pause: pauseState,
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-restart-resume/events") {
          events.push((await readJson(req)) as CapturedEvent);
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );
    const local = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-RESTART-RESUME") {
          expect(req.headers["x-project-id"]).toBe("demo");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-RESTART-RESUME" }));
          return;
        }
        if (
          req.method === "GET" &&
          req.url?.startsWith("/api/tasks/TASK-RESTART-RESUME/federated-resume-state")
        ) {
          expect(req.url).toContain("projectId=demo");
          expect(req.url).toContain("jobId=fed-restart-resume");
          expect(req.url).toContain("originalSessionId=session-before-restart");
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ state: localState }));
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/api/tasks/TASK-RESTART-RESUME/federated-resume/grant"
        ) {
          expect(await readJson(req)).toEqual({
            projectId: "demo",
            originalSessionId: "session-before-restart",
            resumedSessionId: "session-after-restart",
            startGrant,
          });
          res.writeHead(201, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, state: localState }));
          return;
        }
        if (
          req.method === "POST" &&
          req.url === "/api/tasks/TASK-RESTART-RESUME/federated-resume/start"
        ) {
          resumeStarts += 1;
          expect(await readJson(req)).toEqual({
            projectId: "demo",
            originalSessionId: "session-before-restart",
            resumedSessionId: "session-after-restart",
            startGrant,
          });
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              alreadyStarted: true,
              sessionId: "session-after-restart",
              state: localState,
            }),
          );
          return;
        }
        if (
          req.method === "GET" &&
          (req.url === "/api/dispatch/jobs" || req.url?.includes("/dispatch/observation?"))
        ) {
          dispatchJobReads += 1;
          const status = dispatchJobReads <= 3 ? "running" : "completed";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              dispatchFixturePayload(req, fixtureScopes, [
                {
                  taskId: "TASK-RESTART-RESUME",
                  sessionId: "session-after-restart",
                  status,
                  output: [],
                  federatedJobId: "fed-restart-resume",
                  federatedHostId: "laptop",
                  federatedLeaseId: "restart-lease",
                },
              ]),
            ),
          );
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      const result = await runListener([
        "daemon",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
        "--project-id",
        "demo",
        "--max-concurrent",
        "1",
        "--max-jobs",
        "1",
        "--poll-ms",
        "10",
      ]);
      expect(result.body).toMatchObject({ ok: true, worked: true, completedJobs: 1 });
      expect(resumeStarts).toBe(1);
      expect(dispatchJobReads).toBeGreaterThanOrEqual(3);
      expect(events.map((event) => event.status)).toEqual(["running", "completed"]);
      expect(events.every((event) => event.resumeStartedAt === consumedAt)).toBe(true);
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("retries registration through transient 5xx before giving up (TASK-899)", async () => {
    let registerAttempts = 0;

    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/register") {
          expectServiceTokenHeader(req);
          await readJson(req);
          registerAttempts += 1;
          if (registerAttempts < 3) {
            // Two transient 503s, then succeed on the 3rd attempt.
            res.writeHead(503, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ ok: false, error: "transient" }));
            return;
          }
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          expectServiceTokenHeader(req);
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, jobs: [] }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/commands") {
          expectServiceTokenHeader(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, commands: [] }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const local = http.createServer(
      requestHandler((_req, res) => {
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ activeRuns: 0, maxConcurrent: 1 }));
      }),
    );

    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      // Stop after the first poll loop completes by using --max-jobs 0 with a
      // hard heartbeat-loop timeout via the `process.kill` pattern — instead,
      // exit cleanly by giving the daemon nothing to do and setting a tight
      // poll-ms so we finish quickly. We rely on registerAttempts reaching 3
      // as the proof signal.
      const proc = execFile(
        process.execPath,
        [
          path.join(__dirname, "..", "..", "scripts", "quack-listener.mjs"),
          "daemon",
          "--base-url",
          `http://127.0.0.1:${controlPort}`,
          "--local-monitor-url",
          `http://127.0.0.1:${localPort}`,
          "--host-id",
          "laptop",
          "--token",
          "test-token",
          "--max-concurrent",
          "1",
          "--poll-ms",
          "50",
        ],
        { timeout: 10000 },
      );

      // Poll until registerAttempts reaches 3, then kill the daemon.
      const deadline = Date.now() + 8000;
      while (registerAttempts < 3 && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 100));
      }
      proc.kill("SIGTERM");

      expect(registerAttempts).toBeGreaterThanOrEqual(3);
    } finally {
      await close(local);
      await close(control);
    }
  }, 15000);
});

// ─── summarizeWorkerCompletion unit tests ─────────────────────────────────────
// These tests exercise summarizeWorkerCompletion via the work command's
// dispatch path: the local monitor returns session events and the captured
// workerCompletion in the headnode POST is asserted.

describe("summarizeWorkerCompletion via work dispatch path", () => {
  const fixtureScopes: FixtureDispatchScope[] = [
    {
      projectId: "fixture-project",
      taskId: "TASK-WC",
      jobId: "fed-wc-1",
      hostId: "laptop",
      leaseId: "lease-wc-1",
      sessionId: "quack-TASK-WC-session-1",
    },
  ];
  /**
   * Helper: build a control + local server pair that serves one dispatch job.
   * The local monitor returns a completed job with the given session events.
   * Returns the captured workerCompletion from the headnode POST.
   */
  async function runDispatchWithEvents(
    sessionEvents: Array<Record<string, unknown>>,
  ): Promise<Record<string, unknown> | undefined> {
    const sessionId = "quack-TASK-WC-session-1";
    let capturedWorkerCompletion: Record<string, unknown> | undefined;

    const control = http.createServer(
      requestHandler(async (req, res) => {
        if (req.method === "POST" && req.url === "/v1/listeners/laptop/heartbeat") {
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, listener: { id: "laptop" } }));
          return;
        }
        if (req.method === "GET" && req.url === "/v1/listeners/laptop/jobs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              jobs: [
                {
                  projectId: "fixture-project",
                  lease: { leaseId: "lease-wc-1", hostId: "laptop" },
                  jobId: "fed-wc-1",
                  taskId: "TASK-WC",
                  jobType: "dispatch",
                  status: "assigned",
                  hostId: "laptop",
                },
              ],
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-wc-1/lease/renew") {
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify({
              ok: true,
              lease: { expiresAt: new Date(Date.now() + 60000).toISOString() },
            }),
          );
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-wc-1/events") {
          const body = await readJson(req);
          if (body.status === "completed" || body.status === "failed") {
            capturedWorkerCompletion = body.workerCompletion as Record<string, unknown> | undefined;
          }
          res.writeHead(202, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const local = http.createServer(
      requestHandler((req, res) => {
        if (req.method === "GET" && req.url === "/api/tasks/TASK-WC") {
          // taskVisibleResponse checks result.body.id === taskId
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ id: "TASK-WC", title: "Worker Completion Test" }));
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-WC/start") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, sessionId }));
          return;
        }
        if (
          req.method === "GET" &&
          (req.url === "/api/dispatch/jobs" || req.url?.includes("/dispatch/observation?"))
        ) {
          // Return completed dispatch job
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify(
              dispatchFixturePayload(req, fixtureScopes, [
                {
                  taskId: "TASK-WC",
                  sessionId,
                  status: "completed",
                  exitCode: 0,
                  output: ["Task completed successfully"],
                },
              ]),
            ),
          );
          return;
        }
        if (req.method === "GET" && req.url === `/api/tasks/TASK-WC/runs`) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ runs: [{ sessionId, taskId: "TASK-WC" }] }));
          return;
        }
        if (req.method === "GET" && req.url === `/api/sessions/${sessionId}`) {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify(sessionFixtureEvents(req, fixtureScopes, sessionEvents)));
          return;
        }
        res.writeHead(404).end();
      }),
    );

    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      await runListener([
        "work",
        "--base-url",
        `http://127.0.0.1:${controlPort}`,
        "--local-monitor-url",
        `http://127.0.0.1:${localPort}`,
        "--host-id",
        "laptop",
        "--token",
        "test-token",
      ]);
    } finally {
      await close(local);
      await close(control);
    }
    return capturedWorkerCompletion;
  }

  it("captures verified+autoMerged from session_complete when lifecycle_verify_result is absent", async () => {
    const events = [
      {
        stage: "session_complete",
        payload: {
          verified: true,
          verificationVerdict: "VERIFIED",
          autoMerged: true,
          mergeTargetBranch: "dev",
        },
      },
    ];

    const workerCompletion = await runDispatchWithEvents(events);

    expect(workerCompletion).toBeDefined();
    expect(workerCompletion?.verified).toBe(true);
    expect(workerCompletion?.verificationVerdict).toBe("VERIFIED");
    expect(workerCompletion?.autoMerged).toBe(true);
  }, 15000);

  it("captures verified from session_complete combined with auto_merge_complete merge details", async () => {
    const events = [
      {
        stage: "auto_merge_complete",
        payload: {
          targetBranch: "dev",
          mergeCommitSha: "abc123",
        },
      },
      {
        stage: "session_complete",
        payload: {
          verified: true,
          autoMerged: true,
        },
      },
    ];

    const workerCompletion = await runDispatchWithEvents(events);

    expect(workerCompletion).toBeDefined();
    expect(workerCompletion?.autoMerged).toBe(true);
    expect(workerCompletion?.mergeTargetBranch).toBe("dev");
    expect(workerCompletion?.mergeCommitSha).toBe("abc123");
    expect(workerCompletion?.verified).toBe(true);
  }, 15000);

  it("lifecycle_verify_result takes precedence and is not overwritten by session_complete (regression guard)", async () => {
    const events = [
      {
        stage: "lifecycle_verify_result",
        payload: {
          verified: true,
          verdict: "VERIFIED",
          workflowId: "wf-1",
        },
      },
      {
        stage: "auto_merge_complete",
        payload: {
          targetBranch: "dev",
          mergeCommitSha: "def456",
        },
      },
      {
        stage: "session_complete",
        payload: {
          autoMerged: true,
        },
      },
    ];

    const workerCompletion = await runDispatchWithEvents(events);

    expect(workerCompletion).toBeDefined();
    expect(workerCompletion?.verified).toBe(true);
    expect(workerCompletion?.verificationVerdict).toBe("VERIFIED");
    expect(workerCompletion?.verificationWorkflowId).toBe("wf-1");
    expect(workerCompletion?.autoMerged).toBe(true);
    expect(workerCompletion?.mergeTargetBranch).toBe("dev");
    expect(workerCompletion?.mergeCommitSha).toBe("def456");
  }, 15000);
});
