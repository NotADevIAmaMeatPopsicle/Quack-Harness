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
      expect(lastEvent?.message).toContain("task_not_visible_in_local_monitor");
    } finally {
      await close(local);
      await close(control);
    }
  });

  it("starts only assigned jobs and ignores already-running entries", async () => {
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
                  jobId: "fed-task-assigned",
                  taskId: "TASK-3",
                  jobType: "dispatch",
                  status: "assigned",
                  hostId: "laptop",
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
        if (req.method === "GET" && req.url === "/api/dispatch/jobs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify([
              {
                taskId: "TASK-3",
                sessionId: "sess-3",
                status: "completed",
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
          res.end(JSON.stringify({ ok: true, sessionId: "local-dispatch-5" }));
          return;
        }
        if (req.method === "GET" && req.url === "/api/dispatch/jobs") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify([
              {
                taskId: "TASK-5",
                sessionId: "local-dispatch-5",
                status: "completed",
                branchName: "quack/TASK-5",
                commitSha: "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                output: [],
              },
            ]),
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
            JSON.stringify([
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
        if (req.method === "GET" && req.url === "/api/dispatch/jobs") {
          polls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          if (polls === 1) {
            res.end(
              JSON.stringify([
                {
                  taskId: "TASK-4",
                  sessionId: "sess-4",
                  status: "running",
                  output: [],
                },
              ]),
            );
            return;
          }
          res.end(
            JSON.stringify([
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

  it("reports local no_changes dispatches as completed federated jobs", async () => {
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
        if (req.method === "GET" && req.url === "/api/dispatch/jobs") {
          polls += 1;
          res.writeHead(200, { "Content-Type": "application/json" });
          if (polls === 1) {
            res.end(
              JSON.stringify([
                {
                  taskId: "TASK-6",
                  sessionId: "sess-6",
                  status: "running",
                  output: [],
                },
              ]),
            );
            return;
          }
          res.end(
            JSON.stringify([
              {
                taskId: "TASK-6",
                sessionId: "sess-6",
                status: "no_changes",
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
            JSON.stringify([
              {
                stage: "session_complete",
                payload: { verified: true, verificationVerdict: "VERIFIED" },
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
        message: "laptop local dispatch no_changes for TASK-6.",
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
            localStatus: "no_changes",
            exitCode: 0,
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
    const events: CapturedEvent[] = [];
    const startCalls: string[] = [];
    let completionPolls = 0;

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
                  jobId: "fed-task-1",
                  taskId: "TASK-1",
                  jobType: "dispatch",
                  status: "assigned",
                  hostId: "laptop",
                },
                {
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
          await readJson(req);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-task-2/lease/renew") {
          expectServiceTokenHeader(req);
          await readJson(req);
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
        if (req.method === "GET" && req.url === "/api/dispatch/jobs") {
          const startedTasks = [...startCalls];
          const allStarted = startedTasks.includes("TASK-1") && startedTasks.includes("TASK-2");
          if (!allStarted) {
            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(
              JSON.stringify(
                startedTasks.map((taskId) => ({
                  taskId,
                  sessionId: `sess-${taskId}`,
                  status: "running",
                  output: [],
                })),
              ),
            );
            return;
          }

          completionPolls += 1;
          const status = completionPolls >= 2 ? "completed" : "running";
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify([
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
        if (req.method === "GET" && req.url === "/api/dispatch/jobs") {
          // Return completed dispatch job
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(
            JSON.stringify([
              {
                taskId: "TASK-WC",
                sessionId,
                status: "completed",
                exitCode: 0,
                output: ["Task completed successfully"],
              },
            ]),
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
          res.end(JSON.stringify(sessionEvents));
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
