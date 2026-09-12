// ─── TASK-1323: Dispatch provenance ────────────────────────────────
// Every job records its entry channel, token identity, and origin.
// Pins: the single mint API (compile + runtime), route-derived channel
// stamps (incl. the QPI-047 scenario: a queued job is attributable to
// its service token from the record alone), advisory-only claimed
// channel, legacy-record read tolerance, stale-recovery provenance
// preservation, durable event-log presence, and the grep-pin proving
// no inline FederatedJobRecord construction survives outside jobs.ts.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

import { ListenerRegistry } from "../../src/federation/listener-registry";
import { mintFederatedJobRecord, queueFederatedJobRecord } from "../../src/monitor/federation/jobs";
import { recoverStaleFederatedLeases } from "../../src/monitor/federation/scheduling";
import { QueuePersistence } from "../../src/queue/queue-persistence";
import {
  federationDir,
  listFederatedJobs,
  loadFederatedJob,
  saveFederatedJob,
} from "../../src/monitor/federation/store";
import type {
  FederatedJobRecord,
  FederationProjectContext,
  JobProvenance,
} from "../../src/monitor/federation/types";
import { createMonitorServer } from "../../src/monitor/server";
import { computeContentHash } from "../../src/monitor/prep-cache";
import { TaskService } from "../../src/monitor/task-service";

const PROVENANCE: JobProvenance = {
  channel: "federation-queue",
  tokenId: "fed-test",
  remoteAddr: "127.0.0.1",
};

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupDir(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 });
      return;
    } catch {
      await pause(125);
    }
  }
}

describe("TASK-1323 mint API (unit)", () => {
  it("stamps required provenance verbatim and refuses identity overrides via extra", () => {
    const record = mintFederatedJobRecord({
      taskId: "TASK-900",
      jobType: "dispatch",
      requiredCapabilities: ["dispatch"],
      provenance: PROVENANCE,
      status: "queued",
      // @ts-expect-error — extra deliberately cannot carry provenance
      extra: { provenance: { channel: "cli" } },
    });
    expect(record.provenance).toEqual(PROVENANCE);
    expect(record.taskId).toBe("TASK-900");
    expect(record.createdAt).toBe(record.updatedAt);
  });

  it("makes channel-less creation a compile error", () => {
    const call = () => {
      // @ts-expect-error - provenance is required; anonymous creation must not compile (QPI-047)
      return mintFederatedJobRecord({
        taskId: "TASK-901",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        status: "queued",
      });
    };
    expect(typeof call).toBe("function");
  });

  it("queue wrapper preserves queuedAt === createdAt and threads provenance", () => {
    const record = queueFederatedJobRecord({
      taskId: "TASK-902",
      jobType: "verify",
      requiredCapabilities: ["verify"],
      provenance: PROVENANCE,
    });
    expect(record.queuedAt).toBe(record.createdAt);
    expect(record.status).toBe("queued");
    expect(record.provenance).toEqual(PROVENANCE);
  });

  it("QPI-048 leg (f): skipDecomposeCheck rides the job record to the listener", () => {
    const withOverride = queueFederatedJobRecord({
      taskId: "TASK-902",
      jobType: "dispatch",
      requiredCapabilities: ["dispatch"],
      provenance: PROVENANCE,
      skipDecomposeCheck: true,
    });
    expect(withOverride.skipDecomposeCheck).toBe(true);

    const without = queueFederatedJobRecord({
      taskId: "TASK-902",
      jobType: "dispatch",
      requiredCapabilities: ["dispatch"],
      provenance: PROVENANCE,
    });
    expect(without.skipDecomposeCheck).toBeUndefined();
  });
});

describe("TASK-1323 store + recovery (unit)", () => {
  let projectRoot: string;

  beforeEach(() => {
    projectRoot = makeTempDir("quack-provenance-store-");
  });

  afterEach(async () => {
    await cleanupDir(projectRoot);
  });

  it("loads and lists a pre-1323 record with no provenance without error", async () => {
    const dir = federationDir(projectRoot);
    fs.mkdirSync(dir, { recursive: true });
    const legacy = {
      jobId: "fed-task-800-legacy",
      taskId: "TASK-800",
      jobType: "dispatch",
      status: "queued",
      correlationId: "fed-task-800-legacy",
      requiredCapabilities: ["dispatch"],
      decision: {},
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
      queuedAt: "2026-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(path.join(dir, `${legacy.jobId}.json`), JSON.stringify(legacy), "utf-8");

    const jobs = await listFederatedJobs(projectRoot);
    expect(jobs).toHaveLength(1);
    expect(jobs[0].jobId).toBe("fed-task-800-legacy");
    expect(jobs[0].provenance).toBeUndefined();
  });

  it("stale-lease recovery mutates in place and KEEPS the original provenance (Design 6)", async () => {
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, "TASK-903.md"),
      [
        "# TASK-903: stale recovery fixture",
        "",
        "## Metadata",
        "- **Priority:** P2-MEDIUM",
        "- **Effort:** SMALL",
        "- **Status:** READY",
        "- **Blocked By:** []",
        "- **Tags:** [federation]",
        "",
        "## Problem Statement",
        "Fixture.",
        "",
        "## Success Criteria",
        "- [ ] recovered",
        "",
        "## Testing Requirements",
        "- [ ] unit",
      ].join("\n"),
      "utf-8",
    );
    const stale: FederatedJobRecord = {
      ...queueFederatedJobRecord({
        taskId: "TASK-903",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        provenance: PROVENANCE,
      }),
      status: "assigned",
      hostId: "headnode",
      lease: {
        leaseId: "lease-1",
        hostId: "headnode",
        acquiredAt: "2026-01-01T00:00:00.000Z",
        expiresAt: "2026-01-01T00:30:00.000Z",
      },
    };
    await saveFederatedJob(projectRoot, stale);

    const recovered = await recoverStaleFederatedLeases({
      projectRoot,
      taskService: new TaskService(projectRoot, "docs/tasks"),
    } as FederationProjectContext);
    expect(recovered).toHaveLength(1);
    const job = recovered[0];
    expect(job.status).toBe("queued");
    // The original entry provenance is untouched — no new mint happened;
    // the staleRecovery decision fields are the lineage marker.
    expect(job.provenance).toEqual(PROVENANCE);
    expect(job.decision).toMatchObject({ staleRecoveryMode: "auto_retry" });
  });

  it("round-2 F3: queue persistence round-trips dispatchOptions (provenance survives a monitor restart)", () => {
    const persistence = new QueuePersistence(projectRoot);
    persistence.append({
      ts: "2026-08-09T00:00:00.000Z",
      type: "task_enqueued",
      taskId: "TASK-904",
      priority: 1,
      blockedBy: [],
      dispatchOptions: {
        parentTaskId: "TASK-900",
        sharedBranchName: "quack/TASK-900",
        provenance: { channel: "api-direct", principal: "user:operator", remoteAddr: "127.0.0.1" },
      },
    });

    const items = persistence.replay();
    const item = items.get("TASK-904");
    expect(item).toBeDefined();
    expect(item?.dispatchOptions?.provenance).toEqual({
      channel: "api-direct",
      principal: "user:operator",
      remoteAddr: "127.0.0.1",
    });
    expect(item?.dispatchOptions?.parentTaskId).toBe("TASK-900");

    // Pre-1323 log lines (no dispatchOptions field) still replay fine.
    persistence.append({
      ts: "2026-08-09T00:01:00.000Z",
      type: "task_enqueued",
      taskId: "TASK-905",
      priority: 2,
      blockedBy: [],
    });
    const again = persistence.replay();
    expect(again.get("TASK-905")?.dispatchOptions).toBeUndefined();
  });

  it("round-2b C3: replay seeds from the compaction snapshot, so provenance survives a compaction-then-restart", () => {
    const persistence = new QueuePersistence(projectRoot);
    // Simulate the post-compaction disk state: snapshot holds the items,
    // the log has been emptied (compact() writes exactly this shape).
    fs.writeFileSync(
      path.join(projectRoot, "dispatch-queue-snapshot.json"),
      JSON.stringify(
        [
          {
            taskId: "TASK-906",
            status: "queued",
            priority: 1,
            blockedBy: [],
            enqueuedAt: "2026-08-09T00:00:00.000Z",
            retryCount: 0,
            dispatchOptions: {
              provenance: { channel: "api-direct", principal: "user:operator" },
            },
          },
        ],
        null,
        2,
      ),
      "utf-8",
    );
    fs.writeFileSync(path.join(projectRoot, "dispatch-queue.jsonl"), "", "utf-8");

    const recovered = persistence.replay();
    expect(recovered.get("TASK-906")?.dispatchOptions?.provenance).toEqual({
      channel: "api-direct",
      principal: "user:operator",
    });

    // Post-compaction log events overlay the snapshot: a fresh enqueue of
    // the same task wins, and new tasks appear alongside seeded ones.
    persistence.append({
      ts: "2026-08-09T00:02:00.000Z",
      type: "task_enqueued",
      taskId: "TASK-906",
      priority: 5,
      blockedBy: [],
      dispatchOptions: {
        provenance: { channel: "api-direct", principal: "user:newer" },
      },
    });
    const overlaid = persistence.replay();
    expect(overlaid.get("TASK-906")?.priority).toBe(5);
    expect(overlaid.get("TASK-906")?.dispatchOptions?.provenance).toMatchObject({
      principal: "user:newer",
    });
  });
});

describe("TASK-1323 grep-pin: no inline FederatedJobRecord construction outside jobs.ts", () => {
  it("finds no fresh record literals outside the mint API", () => {
    const srcRoot = path.resolve(__dirname, "..", "..", "src");
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
          continue;
        }
        if (!entry.name.endsWith(".ts")) continue;
        const relative = path.relative(srcRoot, full).replace(/\\/g, "/");
        const lines = fs.readFileSync(full, "utf-8").split("\n");
        for (let i = 0; i < lines.length; i += 1) {
          // A fresh construction is `: FederatedJobRecord = {`, a literal
          // `as FederatedJobRecord` / `satisfies FederatedJobRecord`
          // cast, whose opening lines do NOT spread an existing record.
          // Derivations (`{ ...job, ... }`) preserve provenance and are
          // allowed; JSON.parse read casts in the store are reads, not
          // construction. Known limit (round-2 F4, recorded): a two-step
          // `const base = {...}; const record: FederatedJobRecord = base;`
          // evades any line-regex — this pin is the TRIPWIRE for the
          // common shapes; the required `provenance` parameter on the
          // mint API remains the primary guarantee.
          const line = lines[i];
          const constructs =
            /:\s*FederatedJobRecord\s*=\s*\{/.test(line) ||
            /\}\s*as\s+FederatedJobRecord\b/.test(line) ||
            /satisfies\s+FederatedJobRecord\b/.test(line) ||
            (/=\s*\{\s*$/.test(line) === false &&
              /as\s+FederatedJobRecord\s*;?\s*$/.test(line) &&
              line.includes("{"));
          if (!constructs) continue;
          const window = lines.slice(i, i + 4).join("\n");
          const spreadsExisting = window.includes("...");
          if (!spreadsExisting && relative !== "monitor/federation/jobs.ts") {
            offenders.push(`${relative}:${i + 1}`);
          }
        }
      }
    };
    walk(srcRoot);
    expect(offenders).toEqual([]);
  });
});

describe("TASK-1323 route stamps (HTTP)", () => {
  jest.setTimeout(30000);

  let projectRoot: string;
  let quackRoot: string;
  let stop: (() => Promise<void>) | null = null;
  let baseUrl: string;
  const federationGitExec = jest.fn(() => "abc1234\n");

  function sha256(value: string): string {
    return crypto.createHash("sha256").update(value).digest("hex");
  }

  function writeAuthConfig(root: string): void {
    const dir = path.join(root, ".quack");
    fs.mkdirSync(dir, { recursive: true });
    // scrypt hash matching src/monitor/auth.ts (salt:derivedKey, KEY_LENGTH 64)
    const passwordHash = `testsalt:${crypto.scryptSync("quack-pw", "testsalt", 64).toString("hex")}`;
    fs.writeFileSync(
      path.join(dir, "auth.json"),
      JSON.stringify(
        {
          users: [{ username: "operator", passwordHash, role: "admin" }],
          serviceTokens: [
            {
              id: "fed-test",
              tokenHash: sha256("fed-token"),
              scopes: [
                "federation:write",
                "listener:admin",
                "listener:read",
                "listener:register",
                "listener:heartbeat",
              ],
            },
          ],
          sessionSecret: "test",
          sessionTtlMs: 86400000,
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  async function loginCookie(): Promise<string> {
    const resp = await httpPost(
      `${baseUrl}/api/auth/login`,
      {
        username: "operator",
        password: "quack-pw",
      },
      "",
    );
    expect(resp.status).toBe(200);
    const setCookie = resp.setCookie;
    expect(setCookie).toBeTruthy();
    // Echo back just the name=value pair.
    return (setCookie as string).split(";")[0];
  }

  function writeTaskFile(root: string, taskId: string): void {
    const taskDir = path.join(root, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(
      path.join(taskDir, `${taskId}-fixture.md`),
      [
        `# ${taskId}: Provenance Fixture`,
        "",
        "## Metadata",
        "- **Priority:** P1-HIGH",
        "- **Effort:** 1-2 hours",
        "- **Status:** READY",
        "- **Blocked By:** []",
        "- **Tags:** [federation, api]",
        "",
        "## Problem Statement",
        "Provenance fixture.",
        "",
        "## Current State",
        "Fixture state.",
        "",
        "## Recommended Approach",
        "Stamp provenance.",
        "",
        "## Files to Modify",
        "| File | Action | Notes |",
        "|------|--------|-------|",
        "| `src/fixture.ts` | Create | Fixture |",
        "",
        "## Success Criteria",
        "- [ ] Provenance recorded",
        "",
        "## Testing Requirements",
        "- [ ] API test passes",
        "",
      ].join("\n"),
      "utf-8",
    );
  }

  function writePassingPrep(root: string, taskId: string): void {
    const prepDir = path.join(root, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, `${taskId}.json`),
      JSON.stringify(
        {
          taskId,
          preparedAt: "2999-01-01T00:00:00.000Z",
          schemaValid: true,
          schemaErrors: [],
          depthScore: 4.9,
          depthReady: true,
          deficiencies: [],
          outcome: "pass",
          stale: false,
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  function writeCcusageCache(root: string): void {
    const cacheDir = path.join(root, ".quack", "cache");
    fs.mkdirSync(cacheDir, { recursive: true });
    fs.writeFileSync(
      path.join(cacheDir, "ccusage.json"),
      JSON.stringify(
        {
          daily: [],
          totals: {
            inputTokens: 0,
            outputTokens: 0,
            cacheCreationTokens: 0,
            cacheReadTokens: 0,
            totalCost: 0,
            totalTokens: 0,
          },
          lastRefreshedAt: "2026-04-26T12:00:00.000Z",
          lastFetchedDate: "20260426",
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  function readSessionEvents(root: string, sessionId: string): Array<Record<string, unknown>> {
    const eventsFile = path.join(root, ".quack", "logs", `events-${sessionId}.jsonl`);
    return fs
      .readFileSync(eventsFile, "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  async function httpPost(
    url: string,
    data: Record<string, unknown>,
    token = "fed-token",
    headers: Record<string, string> = {},
  ): Promise<{ status: number; body: string; setCookie?: string }> {
    return new Promise((resolve, reject) => {
      const urlObj = new URL(url);
      const postData = JSON.stringify(data);
      const allHeaders: Record<string, string | number> = {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
        ...headers,
      };
      if (token) allHeaders.Authorization = `Bearer ${token}`;
      const req = http.request(
        {
          hostname: urlObj.hostname,
          port: urlObj.port,
          path: urlObj.pathname,
          method: "POST",
          headers: allHeaders,
        },
        (res) => {
          let body = "";
          res.on("data", (chunk: Buffer | string) => {
            body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
          });
          res.on("end", () =>
            resolve({
              status: res.statusCode ?? 0,
              body,
              setCookie: res.headers["set-cookie"]?.[0],
            }),
          );
          res.on("error", reject);
        },
      );
      req.on("error", reject);
      req.write(postData);
      req.end();
    });
  }

  beforeEach(async () => {
    federationGitExec.mockClear();
    projectRoot = makeTempDir("quack-provenance-api-");
    quackRoot = makeTempDir("quack-provenance-root-");
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeAuthConfig(quackRoot);
    writeCcusageCache(projectRoot);
    writeTaskFile(projectRoot, "TASK-910");
    writePassingPrep(projectRoot, "TASK-910");

    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      quackRoot,
      port: 0,
      host: "127.0.0.1",
      federationGitExec,
    });
    const started = await server.start();
    stop = started.stop;
    baseUrl = `http://127.0.0.1:${started.port}`;
    await pause(150);
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    await pause(150);
    await cleanupDir(projectRoot);
    await cleanupDir(quackRoot);
  });

  it("QPI-047 scenario: a queue POST is attributable to its service token from the record alone, and a forged body provenance never wins", async () => {
    const resp = await httpPost(
      `${baseUrl}/v1/federation/queue`,
      {
        taskId: "TASK-910",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        // Forged: the server must derive channel/identity itself.
        provenance: { channel: "cli", tokenId: "forged", principal: "nobody" },
      },
      "fed-token",
      { "X-Quack-Channel": "example-relay" },
    );

    expect(resp.status).toBe(202);
    const body = JSON.parse(resp.body) as { queued: FederatedJobRecord };
    expect(body.queued.provenance).toBeDefined();
    expect(body.queued.provenance).toMatchObject({
      channel: "federation-queue",
      tokenId: "fed-test",
      claimedChannel: "example-relay",
    });
    expect(body.queued.provenance!.remoteAddr).toBeTruthy();

    // The persisted record alone answers the QPI-047 question.
    const stored = await listFederatedJobs(projectRoot);
    const persisted = stored.find((job) => job.jobId === body.queued.jobId);
    expect(persisted?.provenance).toMatchObject({
      channel: "federation-queue",
      tokenId: "fed-test",
    });

    const sessionId = `federation-${body.queued.jobId}`;
    const events = readSessionEvents(projectRoot, sessionId);
    const queuedEvent = events.find((event) => event.stage === "federated_job_status");
    expect(queuedEvent).toBeDefined();
    expect(queuedEvent?.payload).toMatchObject({
      jobId: body.queued.jobId,
      taskId: "TASK-910",
      status: "queued",
      message: "Queued for swarm scheduler.",
    });

    const sessions = fs
      .readFileSync(path.join(projectRoot, ".quack", "logs", "sessions.jsonl"), "utf-8")
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(sessions.find((entry) => entry.sessionId === sessionId)).toMatchObject({
      sessionId,
      taskId: "TASK-910",
      status: "active",
      outcome: "federated_job_queued",
    });
  });

  it("legacy jobs POST stamps federation-jobs-legacy and the submitted event carries provenance into the durable log", async () => {
    const resp = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-910",
      jobType: "verify",
      hosts: [{ id: "worker-b", capabilities: ["verify"], enabled: true, healthy: true }],
      requiredCapabilities: ["verify"],
    });

    expect(resp.status).toBe(202);
    const body = JSON.parse(resp.body) as { job: FederatedJobRecord };
    expect(body.job.provenance).toMatchObject({
      channel: "federation-jobs-legacy",
      tokenId: "fed-test",
    });

    const events = readSessionEvents(projectRoot, `federation-${body.job.jobId}`);
    const submitted = events.find((event) => event.stage === "federated_job_submitted");
    expect(submitted).toBeDefined();
    expect((submitted!.payload as Record<string, unknown>).provenance).toMatchObject({
      channel: "federation-jobs-legacy",
      tokenId: "fed-test",
    });
  });

  // CONTROL, not counted in the pre-change red record: this HTTP matrix was
  // added after the route compiled against the new strict-index contract.
  // The executed red is in duplicate-claimants-strict-index and the clean
  // queue persistence twin is the QPI-047 test above.
  it.each([
    ["exact", "second-created"],
    ["exact", "first-created"],
    ["cross-population", "second-created"],
    ["cross-population", "first-created"],
  ] as const)(
    "TASK-1338-F queue veto: %s duplicate in %s order persists no job or workflow log",
    async (shape, order) => {
      const originalPath = path.join(projectRoot, "docs", "tasks", "TASK-910-fixture.md");
      const duplicatePath = path.join(
        projectRoot,
        "docs",
        "tasks",
        shape === "exact" ? "TASK-910-second.md" : "TASK-999-second.md",
      );
      const content = fs.readFileSync(originalPath, "utf-8");
      if (order === "first-created") {
        fs.rmSync(originalPath);
        fs.writeFileSync(duplicatePath, content, "utf-8");
        fs.writeFileSync(originalPath, content, "utf-8");
      } else {
        fs.writeFileSync(duplicatePath, content, "utf-8");
      }
      const logNamesBefore = fs.readdirSync(path.join(projectRoot, ".quack", "logs")).sort();

      const response = await httpPost(`${baseUrl}/v1/federation/queue`, {
        taskId: "task-910",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        autoSchedule: false,
      });

      expect(response.status).toBe(409);
      const refusal = JSON.parse(response.body) as {
        error: string;
        taskId: string;
        claimants: string[];
      };
      expect(refusal).toMatchObject({
        error: "duplicate_claimants",
        taskId: "TASK-910",
      });
      expect(refusal.claimants).toEqual(
        expect.arrayContaining(["TASK-910-fixture.md", path.basename(duplicatePath)]),
      );
      expect(await listFederatedJobs(projectRoot)).toEqual([]);
      expect(fs.readdirSync(path.join(projectRoot, ".quack", "logs")).sort()).toEqual(
        logNamesBefore,
      );
    },
  );

  // CONTROL, not counted in the pre-change red record for the same compile
  // sequencing reason. The existing legacy provenance test above is the
  // positive twin proving writer, assignment, job, and log persistence.
  it.each([
    ["exact", "second-created"],
    ["exact", "first-created"],
    ["cross-population", "second-created"],
    ["cross-population", "first-created"],
  ] as const)(
    "TASK-1338-F legacy veto: %s duplicate in %s order constructs no writer and assigns no host",
    async (shape, order) => {
      const originalPath = path.join(projectRoot, "docs", "tasks", "TASK-910-fixture.md");
      const duplicatePath = path.join(
        projectRoot,
        "docs",
        "tasks",
        shape === "exact" ? "TASK-910-second.md" : "TASK-999-second.md",
      );
      const content = fs.readFileSync(originalPath, "utf-8");
      if (order === "first-created") {
        fs.rmSync(originalPath);
        fs.writeFileSync(duplicatePath, content, "utf-8");
        fs.writeFileSync(originalPath, content, "utf-8");
      } else {
        fs.writeFileSync(duplicatePath, content, "utf-8");
      }
      const logNamesBefore = fs.readdirSync(path.join(projectRoot, ".quack", "logs")).sort();

      const response = await httpPost(`${baseUrl}/v1/federation/jobs`, {
        taskId: "TASK-910",
        jobType: "verify",
        hosts: [{ id: "worker-b", capabilities: ["verify"], enabled: true, healthy: true }],
        requiredCapabilities: ["verify"],
      });

      expect(response.status).toBe(409);
      expect(JSON.parse(response.body)).toMatchObject({
        error: "duplicate_claimants",
        taskId: "TASK-910",
      });
      expect(await listFederatedJobs(projectRoot)).toEqual([]);
      expect(fs.readdirSync(path.join(projectRoot, ".quack", "logs")).sort()).toEqual(
        logNamesBefore,
      );
    },
  );

  it.each([
    ["exact", "second-created"],
    ["exact", "first-created"],
    ["cross-population", "second-created"],
    ["cross-population", "first-created"],
  ] as const)(
    "TASK-1338-F events new-lease veto: %s duplicate in %s order preserves the queued job",
    async (shape, order) => {
      const queuedResponse = await httpPost(`${baseUrl}/v1/federation/queue`, {
        taskId: "TASK-910",
        jobType: "verify",
        requiredCapabilities: ["verify"],
        autoSchedule: false,
      });
      expect(queuedResponse.status).toBe(202);
      const queued = JSON.parse(queuedResponse.body) as { queued: FederatedJobRecord };
      const originalPath = path.join(projectRoot, "docs", "tasks", "TASK-910-fixture.md");
      const duplicatePath = path.join(
        projectRoot,
        "docs",
        "tasks",
        shape === "exact" ? "TASK-910-second.md" : "TASK-999-second.md",
      );
      const content = fs.readFileSync(originalPath, "utf-8");
      if (order === "first-created") {
        fs.rmSync(originalPath);
        fs.writeFileSync(duplicatePath, content, "utf-8");
        fs.writeFileSync(originalPath, content, "utf-8");
      } else {
        fs.writeFileSync(duplicatePath, content, "utf-8");
      }
      const logsBefore = fs.readdirSync(path.join(projectRoot, ".quack", "logs")).sort();

      const response = await httpPost(
        `${baseUrl}/v1/federation/jobs/${queued.queued.jobId}/events`,
        { hostId: "worker-b", status: "running" },
      );

      expect(response.status).toBe(409);
      const persisted = await loadFederatedJob(projectRoot, queued.queued.jobId);
      expect(persisted).toMatchObject({ status: "queued" });
      expect(persisted?.hostId).toBeUndefined();
      expect(persisted?.lease).toBeUndefined();
      expect(fs.readdirSync(path.join(projectRoot, ".quack", "logs")).sort()).toEqual(logsBefore);
    },
  );

  it("TASK-1338-F events cannot mint a new lease for a clean queued job", async () => {
    const queuedResponse = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-910",
      jobType: "verify",
      requiredCapabilities: ["verify"],
      autoSchedule: false,
    });
    const queued = JSON.parse(queuedResponse.body) as { queued: FederatedJobRecord };
    const eventCountBefore = readSessionEvents(
      projectRoot,
      `federation-${queued.queued.jobId}`,
    ).length;

    const response = await httpPost(`${baseUrl}/v1/federation/jobs/${queued.queued.jobId}/events`, {
      hostId: "worker-b",
      status: "running",
    });

    expect(response.status).toBe(409);
    expect(response.body).toContain("federated_lease_epoch_required");
    const persisted = await loadFederatedJob(projectRoot, queued.queued.jobId);
    expect(persisted).toMatchObject({ status: "queued" });
    expect(persisted?.hostId).toBeUndefined();
    expect(persisted?.lease).toBeUndefined();
    expect(readSessionEvents(projectRoot, `federation-${queued.queued.jobId}`)).toHaveLength(
      eventCountBefore,
    );
  });

  it("TASK-1338-F terminal evidence stays writable without verification or scheduler refill", async () => {
    const assignedResponse = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-910",
      jobType: "verify",
      hosts: [{ id: "worker-b", capabilities: ["verify"], enabled: true, healthy: true }],
      requiredCapabilities: ["verify"],
    });
    const assigned = JSON.parse(assignedResponse.body) as { job: FederatedJobRecord };
    writeTaskFile(projectRoot, "TASK-911");
    const queuedResponse = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-911",
      jobType: "verify",
      requiredCapabilities: ["verify"],
      autoSchedule: false,
    });
    const queued = JSON.parse(queuedResponse.body) as { queued: FederatedJobRecord };
    fs.copyFileSync(
      path.join(projectRoot, "docs", "tasks", "TASK-910-fixture.md"),
      path.join(projectRoot, "docs", "tasks", "TASK-999-terminal.md"),
    );

    const response = await httpPost(`${baseUrl}/v1/federation/jobs/${assigned.job.jobId}/events`, {
      hostId: "worker-b",
      status: "completed",
      autoVerify: true,
      verification: {
        requireReview: false,
        criteriaChecked: 1,
        criteriaPassed: 1,
        phaseResults: [{ name: "tests", status: "passed", summary: "fixture" }],
      },
    });

    expect(response.status).toBe(202);
    const terminal = await loadFederatedJob(projectRoot, assigned.job.jobId);
    expect(terminal?.status).toBe("completed");
    expect(terminal?.error).toContain("duplicate_claimants:TASK-910");
    expect((await loadFederatedJob(projectRoot, queued.queued.jobId))?.status).toBe("queued");
    const verifiedPath = path.join(projectRoot, ".quack", "verified.json");
    const projection = fs.existsSync(verifiedPath)
      ? (JSON.parse(fs.readFileSync(verifiedPath, "utf-8")) as {
          tasks?: Record<string, unknown>;
        })
      : { tasks: {} };
    expect(projection.tasks?.["TASK-910"]).toBeUndefined();
    expect(fs.existsSync(path.join(projectRoot, ".quack", "workflows"))).toBe(false);
  });

  it("TASK-1338-F contested already-attached evidence remains writable", async () => {
    const assignedResponse = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-910",
      jobType: "verify",
      hosts: [{ id: "worker-b", capabilities: ["verify"], enabled: true, healthy: true }],
      requiredCapabilities: ["verify"],
    });
    const assigned = JSON.parse(assignedResponse.body) as { job: FederatedJobRecord };
    fs.copyFileSync(
      path.join(projectRoot, "docs", "tasks", "TASK-910-fixture.md"),
      path.join(projectRoot, "docs", "tasks", "TASK-999-evidence.md"),
    );

    const response = await httpPost(`${baseUrl}/v1/federation/jobs/${assigned.job.jobId}/events`, {
      hostId: "worker-b",
      evidence: [{ kind: "note", summary: "terminal evidence remains append-only" }],
    });

    expect(response.status).toBe(202);
    const persisted = await loadFederatedJob(projectRoot, assigned.job.jobId);
    expect(persisted?.status).toBe("assigned");
    expect(persisted?.evidence).toEqual([
      expect.objectContaining({ kind: "note", summary: "terminal evidence remains append-only" }),
    ]);
  });

  it("TASK-1338-F contested attached lease renewal remains writable", async () => {
    await new ListenerRegistry(projectRoot).register(
      {
        hostId: "worker-b",
        capabilities: ["verify"],
        maxConcurrentJobs: 1,
      },
      "fed-test",
    );
    const assignedResponse = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-910",
      jobType: "verify",
      hosts: [{ id: "worker-b", capabilities: ["verify"], enabled: true, healthy: true }],
      requiredCapabilities: ["verify"],
    });
    const assigned = JSON.parse(assignedResponse.body) as { job: FederatedJobRecord };
    fs.copyFileSync(
      path.join(projectRoot, "docs", "tasks", "TASK-910-fixture.md"),
      path.join(projectRoot, "docs", "tasks", "TASK-999-renewal.md"),
    );

    const response = await httpPost(
      `${baseUrl}/v1/federation/jobs/${assigned.job.jobId}/lease/renew`,
      {
        hostId: "worker-b",
        leaseId: assigned.job.lease!.leaseId,
        leaseTtlMs: 120000,
      },
    );

    expect(response.status).toBe(200);
    const persisted = await loadFederatedJob(projectRoot, assigned.job.jobId);
    expect(persisted).toMatchObject({ status: "assigned", hostId: "worker-b" });
    expect(persisted?.lease).toBeDefined();
  });

  it.each([
    ["exact", "second-created"],
    ["exact", "first-created"],
    ["cross-population", "second-created"],
    ["cross-population", "first-created"],
  ] as const)(
    "queued jobs cannot mint a lease through renewal: %s duplicate in %s order",
    async (shape, order) => {
      const queuedResponse = await httpPost(`${baseUrl}/v1/federation/queue`, {
        taskId: "TASK-910",
        jobType: "verify",
        requiredCapabilities: ["verify"],
        autoSchedule: false,
      });
      const queued = JSON.parse(queuedResponse.body) as { queued: FederatedJobRecord };
      const originalPath = path.join(projectRoot, "docs", "tasks", "TASK-910-fixture.md");
      const duplicatePath = path.join(
        projectRoot,
        "docs",
        "tasks",
        shape === "exact" ? "TASK-910-second.md" : "TASK-999-second.md",
      );
      const content = fs.readFileSync(originalPath, "utf-8");
      if (order === "first-created") {
        fs.rmSync(originalPath);
        fs.writeFileSync(duplicatePath, content, "utf-8");
        fs.writeFileSync(originalPath, content, "utf-8");
      } else {
        fs.writeFileSync(duplicatePath, content, "utf-8");
      }
      const logsBefore = fs.readdirSync(path.join(projectRoot, ".quack", "logs")).sort();

      const response = await httpPost(
        `${baseUrl}/v1/federation/jobs/${queued.queued.jobId}/lease/renew`,
        { hostId: "worker-b", leaseId: "forged-queued-lease" },
      );

      expect(response.status).toBe(409);
      const persisted = await loadFederatedJob(projectRoot, queued.queued.jobId);
      expect(persisted).toMatchObject({ status: "queued" });
      expect(persisted?.hostId).toBeUndefined();
      expect(persisted?.lease).toBeUndefined();
      expect(fs.readdirSync(path.join(projectRoot, ".quack", "logs")).sort()).toEqual(logsBefore);
    },
  );

  it("refuses queued lease renewal even when the task claimant is clean", async () => {
    const queuedResponse = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-910",
      jobType: "verify",
      requiredCapabilities: ["verify"],
      autoSchedule: false,
    });
    const queued = JSON.parse(queuedResponse.body) as { queued: FederatedJobRecord };

    const response = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queued.queued.jobId}/lease/renew`,
      { hostId: "worker-b", leaseId: "forged-queued-lease" },
    );

    expect(response.status).toBe(409);
    const persisted = await loadFederatedJob(projectRoot, queued.queued.jobId);
    expect(persisted).toMatchObject({ status: "queued" });
    expect(persisted?.hostId).toBeUndefined();
    expect(persisted?.lease).toBeUndefined();
  });

  const externalCompletionPayload = (): Record<string, unknown> => ({
    taskId: "TASK-910",
    source: "hermes",
    branchName: "quack/TASK-910",
    commitSha: "abc1234",
    targetBranch: "dev",
    verificationClass: "fast-required",
    autoVerify: false,
    autoMerge: false,
    maxFixAttempts: 0,
    docsImpact: "none",
    criteriaChecked: 1,
    criteriaPassed: 1,
    phaseResults: [{ name: "local_validation", status: "passed", summary: "fixture" }],
  });

  it.each([
    ["exact", "second-created"],
    ["exact", "first-created"],
    ["cross-population", "second-created"],
    ["cross-population", "first-created"],
  ] as const)(
    "TASK-1338-F external completion veto: %s duplicate in %s order invokes no git and persists no review",
    async (shape, order) => {
      const originalPath = path.join(projectRoot, "docs", "tasks", "TASK-910-fixture.md");
      const duplicatePath = path.join(
        projectRoot,
        "docs",
        "tasks",
        shape === "exact" ? "TASK-910-second.md" : "TASK-999-second.md",
      );
      const content = fs.readFileSync(originalPath, "utf-8");
      if (order === "first-created") {
        fs.rmSync(originalPath);
        fs.writeFileSync(duplicatePath, content, "utf-8");
        fs.writeFileSync(originalPath, content, "utf-8");
      } else {
        fs.writeFileSync(duplicatePath, content, "utf-8");
      }
      const reviewsDir = path.join(projectRoot, ".quack", "reviews");
      const reviewsBefore = fs.existsSync(reviewsDir) ? fs.readdirSync(reviewsDir).sort() : [];
      const response = await httpPost(
        `${baseUrl}/v1/federation/external-completions`,
        externalCompletionPayload(),
      );

      expect(response.status).toBe(409);
      expect(JSON.parse(response.body)).toMatchObject({
        error: "duplicate_claimants",
        taskId: "TASK-910",
      });
      expect(federationGitExec).not.toHaveBeenCalled();
      expect(await listFederatedJobs(projectRoot)).toEqual([]);
      expect(fs.existsSync(reviewsDir) ? fs.readdirSync(reviewsDir).sort() : []).toEqual(
        reviewsBefore,
      );
    },
  );

  it("TASK-1338-F external completion clean twin resolves git before persisting review and job", async () => {
    const response = await httpPost(
      `${baseUrl}/v1/federation/external-completions`,
      externalCompletionPayload(),
    );

    expect(response.status).toBe(202);
    expect(federationGitExec).toHaveBeenCalled();
    expect(await listFederatedJobs(projectRoot)).toHaveLength(1);
    expect(fs.readdirSync(path.join(projectRoot, ".quack", "reviews"))).toEqual(
      expect.arrayContaining(["latest-by-task.json"]),
    );
  });

  it("TASK-1338-F singular federation admissions fail closed when the configured scan is unavailable", async () => {
    const seeded = queueFederatedJobRecord({
      taskId: "TASK-910",
      jobType: "dispatch",
      requiredCapabilities: ["dispatch"],
      provenance: PROVENANCE,
    });
    await saveFederatedJob(projectRoot, seeded);
    const seededPath = path.join(
      projectRoot,
      ".quack",
      "federation",
      "jobs",
      `${seeded.jobId}.json`,
    );
    const seededBytes = fs.readFileSync(seededPath);
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.renameSync(taskDir, `${taskDir}-offline`);

    const requests = [
      () =>
        httpPost(`${baseUrl}/v1/federation/queue`, {
          taskId: "TASK-910",
          jobType: "dispatch",
          requiredCapabilities: ["dispatch"],
        }),
      () =>
        httpPost(`${baseUrl}/v1/federation/jobs`, {
          taskId: "TASK-910",
          jobType: "dispatch",
          requiredCapabilities: ["dispatch"],
        }),
      () =>
        httpPost(`${baseUrl}/v1/federation/jobs/${seeded.jobId}/events`, {
          hostId: "host-unavailable",
          status: "assigned",
        }),
      () => httpPost(`${baseUrl}/v1/federation/external-completions`, externalCompletionPayload()),
    ];

    for (const request of requests) {
      const response = await request();
      expect(response.status).toBe(409);
      const refusal = JSON.parse(response.body) as {
        error?: string;
        taskId?: string;
        claimants?: string[];
        retryable?: boolean;
        message?: string;
      };
      expect(refusal).toMatchObject({
        error: "duplicate_claimants",
        taskId: "TASK-910",
        claimants: [],
        retryable: true,
      });
      expect(refusal.message).toContain("Duplicate claimant scan failed");
    }
    expect(fs.readFileSync(seededPath)).toEqual(seededBytes);
    expect(federationGitExec).not.toHaveBeenCalled();
    expect(await listFederatedJobs(projectRoot)).toHaveLength(1);
  });

  it("session_start for a federated worker carries the job's entry provenance", async () => {
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-910",
      jobType: "verify",
      hosts: [{ id: "worker-b", capabilities: ["verify"], enabled: true, healthy: true }],
      requiredCapabilities: ["verify"],
    });
    expect(created.status).toBe(202);
    const createdBody = JSON.parse(created.body) as { job: FederatedJobRecord };

    const relayed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${createdBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "running",
        remoteSessionId: "hex-provenance-001",
        message: "Worker started.",
      },
    );
    expect(relayed.status).toBe(202);

    const events = readSessionEvents(projectRoot, `federation-${createdBody.job.jobId}`);
    const sessionStart = events.find((event) => event.stage === "session_start");
    expect(sessionStart).toBeDefined();
    expect((sessionStart!.payload as Record<string, unknown>).provenance).toMatchObject({
      channel: "federation-jobs-legacy",
      tokenId: "fed-test",
    });
  });

  it("round-2 F1: a claimed federated start with no matching assigned job is REFUSED, not honored", async () => {
    const cookie = await loginCookie();
    const registered = await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "laptop",
      alias: "Laptop",
      baseUrl: "http://100.1.2.3:3337",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });
    expect(registered.status).toBe(201);

    // Forged fed ids: no such job exists — previously this claim alone
    // bypassed the swarm-mode block AND would stamp listener-execution.
    const forged = await httpPost(
      `${baseUrl}/api/tasks/TASK-910/start`,
      {
        federatedJobId: "fed-task-910-forged",
        federatedHostId: "laptop",
      },
      "",
      { Cookie: cookie },
    );
    expect(forged.status).toBe(409);
    expect(JSON.parse(forged.body)).toMatchObject({ code: "federated_claim_unverified" });

    // No claim at all: the plain swarm-mode block still fires.
    const direct = await httpPost(`${baseUrl}/api/tasks/TASK-910/start`, {}, "", {
      Cookie: cookie,
    });
    expect(direct.status).toBe(409);
    expect(JSON.parse(direct.body)).toMatchObject({
      code: "direct_dispatch_blocked_in_swarm_mode",
    });
  });

  it("round-2 F1 positive control: a VERIFIED federated claim passes the gate (fails later on the missing task, not on the claim)", async () => {
    const cookie = await loginCookie();
    const registered = await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      alias: "Worker-B",
      baseUrl: "http://100.1.2.4:3334",
      capabilities: ["verify"],
      maxConcurrentJobs: 1,
    });
    expect(registered.status).toBe(201);

    // Mint a REAL assigned job (legacy hosts route) for a task that has
    // no spec file, so the start route can pass the claim gate and then
    // fail deterministically on task lookup — proving the gate verdict
    // came from VERIFICATION, without spawning a dispatch child.
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-GHOST",
      jobType: "verify",
      hosts: [{ id: "worker-b", capabilities: ["verify"], enabled: true, healthy: true }],
      requiredCapabilities: ["verify"],
    });
    expect(created.status).toBe(202);
    const createdBody = JSON.parse(created.body) as { job: FederatedJobRecord };
    expect(createdBody.job.status).toBe("assigned");

    const started = await httpPost(
      `${baseUrl}/api/tasks/TASK-GHOST/start`,
      {
        federatedJobId: createdBody.job.jobId,
        federatedHostId: "worker-b",
        federatedLeaseId: createdBody.job.lease!.leaseId,
      },
      "",
      { Cookie: cookie },
    );
    expect(started.status).toBe(404);
    expect(JSON.parse(started.body)).toMatchObject({ error: "Task TASK-GHOST not found" });
  });

  function writePoisonedPreflight(taskId: string): void {
    // The QPI-051 shape: an embedded gate block reading rejected/score-0
    // (assembled under readiness-shadow safety_stop) for a task whose
    // deterministic prep legitimately passes.
    const taskContent = fs.readFileSync(
      path.join(projectRoot, "docs", "tasks", `${taskId}-fixture.md`),
      "utf-8",
    );
    fs.writeFileSync(
      path.join(projectRoot, ".quack", "prep", `${taskId}-preflight.json`),
      JSON.stringify(
        {
          taskId,
          timestamp: "2026-08-10T16:38:41.000Z",
          contentHash: computeContentHash(taskContent),
          gate: { ready: false, score: 0, dimensions: {}, activeOutcome: "rejected" },
          blueprint: {
            fileAnalyses: 0,
            codeExamples: 0,
            verificationPatterns: 0,
            antiPatterns: 0,
            formattedMarkdown: "# stub",
          },
          contextEstimate: { totalTokens: 0 },
          complexity: { recommendDecomposition: false },
          mode: "full",
        },
        null,
        2,
      ),
      "utf-8",
    );
  }

  it("QPI-051: a poisoned preflight gate cannot block a task whose deterministic prep passes", async () => {
    writePoisonedPreflight("TASK-910"); // prep 4.9 written by beforeEach

    const resp = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-910",
      jobType: "dispatch",
      requiredCapabilities: ["dispatch"],
    });
    expect(resp.status).toBe(202);
    const body = JSON.parse(resp.body) as { job: FederatedJobRecord };
    // The deterministic prep is the admission authority: the GATE
    // passes (specifically not the preflight_gate_failed:0.0 that piled
    // three federation jobs against a 4.9 prep on the live wave). In
    // this listener-less fixture the job then blocks downstream on
    // capacity matching — no_capable_listener IS the proof the gate
    // admitted it and scheduling proceeded past readiness.
    expect(body.job.error ?? "").not.toContain("preflight_gate_failed");
    expect(body.job.error).toBe("no_capable_listener");
  });

  it("QPI-051 counter-arm: the poisoned preflight still blocks when the prep ALSO fails", async () => {
    writePoisonedPreflight("TASK-910");
    fs.writeFileSync(
      path.join(projectRoot, ".quack", "prep", "TASK-910.json"),
      JSON.stringify(
        {
          taskId: "TASK-910",
          preparedAt: "2999-01-01T00:00:00.000Z",
          schemaValid: true,
          schemaErrors: [],
          depthScore: 3.9,
          depthReady: false,
          deficiencies: ["thin"],
          outcome: "rejected",
          stale: false,
        },
        null,
        2,
      ),
      "utf-8",
    );

    const resp = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-910",
      jobType: "dispatch",
      requiredCapabilities: ["dispatch"],
    });
    expect(resp.status).toBe(202);
    const body = JSON.parse(resp.body) as { job: FederatedJobRecord };
    expect(body.job.status).toBe("blocked");
    expect(body.job.error).toContain("preflight_gate_failed:0.0");
  });

  it("round-2 F2: a session-authenticated enqueue records the username as principal", async () => {
    const cookie = await loginCookie();
    const resp = await httpPost(
      `${baseUrl}/api/queue/enqueue`,
      {
        taskIds: ["TASK-910"],
      },
      "",
      { Cookie: cookie },
    );
    expect(resp.status).toBe(200);
    const body = JSON.parse(resp.body) as {
      ok: boolean;
      items: Array<{ taskId: string; dispatchOptions?: { provenance?: JobProvenance } }>;
    };
    expect(body.ok).toBe(true);
    expect(body.items[0].dispatchOptions?.provenance).toMatchObject({
      channel: "api-direct",
      principal: "user:operator",
    });

    // Configured users require a session; anonymous writes cannot change the queue.
    const queuePersistence = new QueuePersistence(path.join(projectRoot, ".quack", "logs"));
    const enqueuedBefore = queuePersistence
      .readEvents()
      .filter((event) => event.type === "task_enqueued");
    expect(enqueuedBefore.map((event) => event.taskId)).toEqual(["TASK-910"]);
    const anon = await httpPost(
      `${baseUrl}/api/queue/enqueue`,
      {
        taskIds: ["TASK-911"],
      },
      "",
    );
    expect(anon.status).toBe(401);
    expect(JSON.parse(anon.body)).toEqual({ error: "Authentication required" });
    expect(queuePersistence.readEvents().filter((event) => event.type === "task_enqueued")).toEqual(
      enqueuedBefore,
    );
    expect(queuePersistence.replay().has("TASK-911")).toBe(false);
  });
});
