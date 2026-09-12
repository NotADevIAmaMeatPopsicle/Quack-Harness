import { execFile } from "node:child_process";
import * as http from "node:http";
import * as path from "node:path";
import { promisify } from "node:util";
const execute = promisify(execFile);

function listen(server: http.Server): Promise<number> {
  return new Promise((resolve) =>
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") throw new Error("Missing fixture port");
      resolve(address.port);
    }),
  );
}
function close(server: http.Server): Promise<void> {
  return new Promise((resolve, reject) =>
    server.close((error) => (error ? reject(error) : resolve())),
  );
}
function json(res: http.ServerResponse, value: unknown, status = 200): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(value));
}
function read(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  return new Promise((resolve) => {
    let value = "";
    req.on("data", (chunk: Buffer) => {
      value += chunk.toString();
    });
    req.on("end", () => resolve(JSON.parse(value) as Record<string, unknown>));
  });
}
const identity = {
  projectId: "fixture",
  taskId: "TASK-001",
  jobId: "fed-exact",
  hostId: "worker",
  leaseId: "lease-exact",
  sessionId: "session-original",
};

describe("listener exact terminal observation protocol", () => {
  it.each([
    "exact",
    "jobId",
    "projectId",
    "taskId",
    "hostId",
    "leaseId",
    "sessionId",
    "malformed",
    "missing",
    "unsettled",
    "retry",
    "missing-lease",
  ])("keeps terminal evidence bound to the started attempt (%s)", async (mode) => {
    const events: Array<Record<string, unknown>> = [];
    const requests: string[] = [];
    const callbackErrors: unknown[] = [];
    let starts = 0;
    let observations = 0;
    const control = http.createServer((req, res) => {
      void (async () => {
        if (req.method === "POST" && req.url === "/v1/listeners/worker/heartbeat") {
          await read(req);
          json(res, { ok: true });
          return;
        }
        if (req.url === "/v1/listeners/worker/jobs") {
          json(res, {
            ok: true,
            jobs: [
              {
                ...identity,
                jobType: "dispatch",
                status: "assigned",
                lease:
                  mode === "missing-lease"
                    ? undefined
                    : { leaseId: identity.leaseId, hostId: identity.hostId },
              },
            ],
          });
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-exact/events") {
          events.push(await read(req));
          json(res, { ok: true }, 202);
          return;
        }
        if (req.method === "POST" && req.url === "/v1/federation/jobs/fed-exact/lease/renew") {
          await read(req);
          json(res, { ok: true });
          return;
        }
        json(res, {}, 404);
      })().catch((error: unknown) => json(res, { error: String(error) }, 500));
    });
    const local = http.createServer((req, res) => {
      try {
        requests.push(req.url ?? "");
        if (req.url === "/api/tasks/TASK-001") {
          json(res, { id: "TASK-001", project: "fixture" });
          return;
        }
        if (req.method === "POST" && req.url === "/api/tasks/TASK-001/start") {
          starts += 1;
          json(res, { ok: true, sessionId: identity.sessionId });
          return;
        }
        if (req.url?.includes("/dispatch/observation?")) {
          observations += 1;
          const url = new URL(req.url, "http://fixture.invalid");
          const selectedSession =
            mode === "retry" && observations > 1 ? "session-retry" : identity.sessionId;
          expect(url.searchParams.get("sessionId")).toBe(selectedSession);
          for (const field of ["projectId", "jobId", "hostId", "leaseId"] as const)
            expect(url.searchParams.get(field)).toBe(identity[field]);
          if (mode === "malformed") {
            json(res, null);
            return;
          }
          if (mode === "missing") {
            json(res, {}, 404);
            return;
          }
          const mismatched = Object.keys(identity).includes(mode);
          const responseIdentity = {
            ...identity,
            sessionId: selectedSession,
            ...(mismatched ? { [mode]: "newer-or-other-attempt" } : {}),
          };
          const firstRetry = mode === "retry" && observations === 1;
          json(res, {
            identity: responseIdentity,
            source: "durable",
            settled: mode !== "unsettled" || observations > 1,
            job: {
              taskId: identity.taskId,
              sessionId: selectedSession,
              status: firstRetry ? "failed" : "completed",
              exitCode: firstRetry ? 1 : 0,
              completedAt: "2026-09-11T01:00:00.000Z",
              output: [],
              replacementSessionId: firstRetry ? "session-retry" : undefined,
            },
          });
          return;
        }
        if (req.url === "/api/tasks/TASK-001/runs") {
          json(res, [{ taskId: identity.taskId, sessionId: "newer-paid-run" }]);
          return;
        }
        if (req.url?.startsWith("/api/sessions/")) {
          const sessionId = mode === "retry" ? "session-retry" : identity.sessionId;
          expect(req.url).toBe(`/api/sessions/${sessionId}`);
          json(res, [
            {
              project: "Fixture display name",
              taskId: identity.taskId,
              sessionId,
              stage: "session_start",
              payload: {
                jobId: identity.jobId,
                hostId: identity.hostId,
                leaseId: identity.leaseId,
              },
            },
            {
              project: "Fixture display name",
              taskId: identity.taskId,
              sessionId,
              stage: "lifecycle_verify_result",
              payload: { verified: false, verdict: "FAILED" },
            },
            {
              project: "fixture",
              taskId: identity.taskId,
              sessionId: "newer-paid-run",
              stage: "auto_merge_complete",
              payload: { targetBranch: "dev", mergeCommitSha: "a".repeat(40) },
            },
          ]);
          return;
        }
        json(res, {}, 404);
      } catch (error: unknown) {
        callbackErrors.push(error);
        json(res, { error: String(error) }, 500);
      }
    });
    const controlPort = await listen(control);
    const localPort = await listen(local);
    try {
      await execute(
        process.execPath,
        [
          path.join(process.cwd(), "scripts/quack-listener.mjs"),
          "work",
          "--base-url",
          `http://127.0.0.1:${controlPort}`,
          "--local-monitor-url",
          `http://127.0.0.1:${localPort}`,
          "--host-id",
          "worker",
          "--token",
          "fixture-token",
          "--poll-ms",
          "5",
          "--json",
        ],
        {
          timeout: 5000,
          env: {
            ...process.env,
            QUACK_LOCAL_JOB_MISSING_GRACE_MS: "100",
            QUACK_LOCAL_JOB_UNREACHABLE_GRACE_MS: "100",
          },
        },
      );
      expect(callbackErrors).toEqual([]);
      const last = events.at(-1);
      if (["exact", "unsettled", "retry"].includes(mode)) {
        expect(last).toMatchObject({
          status: "completed",
          workerCompletion: { verified: false, verificationVerdict: "FAILED" },
        });
        expect(last?.workerCompletion).not.toHaveProperty("autoMerged");
        if (mode === "unsettled" || mode === "retry") expect(observations).toBeGreaterThan(1);
      } else if (mode === "missing-lease") {
        expect(starts).toBe(0);
        expect(last?.status).toBe("blocked");
      } else {
        expect(last?.status).toBe("failed");
      }
      expect(requests).not.toContain("/api/tasks/TASK-001/runs");
      expect(requests).not.toContain("/api/sessions/newer-paid-run");
    } finally {
      await close(local);
      await close(control);
    }
  });
});
