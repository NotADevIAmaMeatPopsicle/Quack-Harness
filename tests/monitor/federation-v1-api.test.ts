import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";
import { execFileSync } from "node:child_process";

import { createMonitorServer } from "../../src/monitor/server";
import { QuackDB } from "../../src/db";
import {
  loadFederatedJob,
  saveFederatedJob,
  setFederatedJobLockOptionsForTests,
  updateFederatedJob,
} from "../../src/monitor/federation/store";
import { broadcastWorkerRefreshCommand } from "../../src/monitor/federation/host";
import type { FederatedJobRecord, FederatedMergeBinding } from "../../src/monitor/federation/types";
import type {
  FederatedMergeBoundary,
  FederatedMergeBoundaryInput,
  FederatedMergeExecutionInput,
  FederatedMergeResult,
} from "../../src/monitor/federation/orchestration";

function parseJson<T>(raw: string): T {
  return JSON.parse(raw) as T;
}

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function writeAuthConfig(quackRoot: string): void {
  const dir = path.join(quackRoot, ".quack");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify(
      {
        users: [],
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
          {
            id: "other-worker",
            tokenHash: sha256("other-token"),
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

function writeTaskFile(
  projectRoot: string,
  taskId: string,
  options: { status?: string; blockedBy?: string[] } = {},
): void {
  const taskDir = path.join(projectRoot, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  const blockedBy =
    options.blockedBy && options.blockedBy.length > 0 ? `[${options.blockedBy.join(", ")}]` : "[]";
  const content = [
    `# ${taskId}: Federation Fixture`,
    "",
    "## Metadata",
    "- **Priority:** P1-HIGH",
    "- **Effort:** 1-2 hours",
    `- **Status:** ${options.status ?? "READY"}`,
    `- **Blocked By:** ${blockedBy}`,
    "- **Tags:** [federation, api]",
    "",
    "## Problem Statement",
    "Federation fixture.",
    "",
    "## Current State",
    "Fixture state.",
    "",
    "## Recommended Approach",
    "Project federation events.",
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/federation/job-router.ts` | Create | Fixture |",
    "",
    "## Success Criteria",
    "- [ ] Federation API returns deterministic routing",
    "",
    "## Testing Requirements",
    "- [ ] API test passes",
    "",
  ].join("\n");
  fs.writeFileSync(path.join(taskDir, `${taskId}-fixture.md`), content, "utf-8");
}

function writePassingPrep(projectRoot: string, taskId: string): void {
  const prepDir = path.join(projectRoot, ".quack", "prep");
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

function writePrep(
  projectRoot: string,
  taskId: string,
  depthScore: number,
  depthReady: boolean,
): void {
  const prepDir = path.join(projectRoot, ".quack", "prep");
  fs.mkdirSync(prepDir, { recursive: true });
  fs.writeFileSync(
    path.join(prepDir, `${taskId}.json`),
    JSON.stringify(
      {
        taskId,
        preparedAt: "2999-01-01T00:00:00.000Z",
        schemaValid: true,
        schemaErrors: [],
        depthScore,
        depthReady,
        deficiencies: depthReady ? [] : ["Needs more implementation detail"],
        outcome: depthReady ? "pass" : "rejected",
        stale: false,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writePassingPreflight(projectRoot: string, taskId: string): void {
  const prepDir = path.join(projectRoot, ".quack", "prep");
  fs.mkdirSync(prepDir, { recursive: true });
  const taskFilePath = path.join(projectRoot, "docs", "tasks", `${taskId}-fixture.md`);
  const taskContent = fs.readFileSync(taskFilePath, "utf-8");
  fs.writeFileSync(
    path.join(prepDir, `${taskId}-preflight.json`),
    JSON.stringify(
      {
        taskId,
        timestamp: "2999-01-01T00:00:00.000Z",
        contentHash: sha256(taskContent),
        gate: {
          ready: true,
          score: 5.0,
          dimensions: {},
        },
        blueprint: {
          fileAnalyses: 1,
          codeExamples: 0,
          verificationPatterns: 1,
          antiPatterns: 0,
          formattedMarkdown: "## Blueprint\n\nFixture",
        },
        contextEstimate: {
          taskSpec: 100,
          blueprint: 100,
          repoMap: 0,
          relevantFiles: 0,
          relatedPatterns: 0,
          existingTests: 0,
          conventions: 0,
          claudeMd: 0,
          total: 200,
          withinBudget: true,
        },
        complexity: {
          filesToModify: 1,
          successCriteria: 1,
          estimatedContextTokens: 200,
          independentFeatures: 1,
          featureClusters: [],
          recommendDecomposition: false,
          reason: "Within thresholds",
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
}

function writeCcusageCache(projectRoot: string): void {
  const cacheDir = path.join(projectRoot, ".quack", "cache");
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

function git(projectRoot: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: projectRoot,
    encoding: "utf-8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();
}

function initGitMergeFixture(projectRoot: string): void {
  git(projectRoot, ["init"]);
  git(projectRoot, ["config", "user.email", "quack-test@example.test"]);
  git(projectRoot, ["config", "user.name", "Quack Test"]);
  git(projectRoot, ["checkout", "-b", "dev"]);
  const sourceDir = path.join(projectRoot, "src");
  fs.mkdirSync(sourceDir, { recursive: true });
  fs.writeFileSync(path.join(sourceDir, "fixture.txt"), "base\n", "utf-8");
  git(projectRoot, ["add", "."]);
  git(projectRoot, ["commit", "-m", "initial fixture"]);
  const remotePath = path.join(projectRoot, ".quack", "origin.git");
  fs.mkdirSync(path.dirname(remotePath), { recursive: true });
  execFileSync("git", ["init", "--bare", remotePath], { stdio: ["ignore", "pipe", "pipe"] });
  git(projectRoot, ["remote", "add", "origin", remotePath]);
  git(projectRoot, ["push", "-u", "origin", "dev"]);
  git(projectRoot, ["checkout", "-b", "quack/TASK-838"]);
  fs.writeFileSync(path.join(sourceDir, "fixture.txt"), "worker change\n", "utf-8");
  git(projectRoot, ["add", "src/fixture.txt"]);
  git(projectRoot, ["commit", "-m", "task 838 worker change"]);
  git(projectRoot, ["checkout", "dev"]);
}

function optionalGit(projectRoot: string, args: string[]): string[] {
  try {
    return git(projectRoot, args)
      .split(/\r?\n/u)
      .map((value) => value.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function fixtureRepository(projectRoot: string): FederatedMergeBinding["repository"] {
  const origin = git(projectRoot, ["remote", "get-url", "origin"]);
  const repo = path
    .basename(origin)
    .replace(/\.git$/iu, "")
    .replace(/[^A-Za-z0-9_.-]/gu, "-");
  return { host: "github.test", owner: "federation-fixture", repo };
}

function assertFixturePushDestination(projectRoot: string): void {
  const origin = path.resolve(git(projectRoot, ["remote", "get-url", "origin"]));
  const pushUrls = optionalGit(projectRoot, ["config", "--get-all", "remote.origin.pushurl"]);
  if (pushUrls.length > 1 || (pushUrls[0] && path.resolve(pushUrls[0]) !== origin)) {
    throw new Error("fixture push destination changed after repository identity was sealed");
  }
}

function sealFixtureFederatedMerge(
  input: FederatedMergeBoundaryInput,
): Promise<FederatedMergeBinding> {
  assertFixturePushDestination(input.projectRoot);
  const sourceCommitSha = git(input.projectRoot, [
    "rev-parse",
    "--verify",
    `refs/heads/${input.sourceBranch}`,
  ]);
  if (sourceCommitSha.toLowerCase() !== input.sourceCommitSha.toLowerCase()) {
    throw new Error("fixture source branch changed after completion was reported");
  }
  return Promise.resolve({
    version: 1,
    repository: fixtureRepository(input.projectRoot),
    sourceBranch: input.sourceBranch,
    sourceCommitSha: input.sourceCommitSha.toLowerCase(),
    targetBranch: input.targetBranch,
    publicationNonce: "00000000-0000-4000-8000-000000000001",
    sealedAt: new Date().toISOString(),
  });
}

function mergeFixtureFederatedBranch(
  input: FederatedMergeExecutionInput,
): Promise<FederatedMergeResult> {
  assertFixturePushDestination(input.projectRoot);
  const repository = fixtureRepository(input.projectRoot);
  if (JSON.stringify(repository) !== JSON.stringify(input.binding.repository)) {
    return Promise.resolve({
      ok: false,
      error: "fixture repository identity changed",
      commands: 0,
    });
  }
  const sourceCommitSha = git(input.projectRoot, [
    "rev-parse",
    "--verify",
    `refs/heads/${input.sourceBranch}`,
  ]);
  if (sourceCommitSha.toLowerCase() !== input.binding.sourceCommitSha.toLowerCase()) {
    return Promise.resolve({ ok: false, error: "fixture source branch changed", commands: 0 });
  }
  try {
    git(input.projectRoot, ["checkout", input.targetBranch]);
    git(input.projectRoot, ["pull", "--ff-only", "origin", input.targetBranch]);
    git(input.projectRoot, ["merge", "--squash", input.binding.sourceCommitSha]);
    git(input.projectRoot, [
      "commit",
      "-m",
      `feat(${input.taskId.toLowerCase()}): merge federated work`,
    ]);
    const commitSha = git(input.projectRoot, ["rev-parse", "HEAD"]);
    assertFixturePushDestination(input.projectRoot);
    git(input.projectRoot, ["push", "origin", `${commitSha}:refs/heads/${input.targetBranch}`]);
    return Promise.resolve({ ok: true, commitSha, commands: 5 });
  } catch (error: unknown) {
    return Promise.resolve({
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      commands: 0,
    });
  }
}

function writeMergeReadyReview(
  projectRoot: string,
  taskId: string,
  reviewId: string,
  commitSha?: string,
): void {
  const reviewsDir = path.join(projectRoot, ".quack", "reviews");
  fs.mkdirSync(reviewsDir, { recursive: true });
  fs.writeFileSync(
    path.join(reviewsDir, `${reviewId}.json`),
    JSON.stringify(
      {
        taskId,
        reviewId,
        ...(commitSha ? { commitSha } : {}),
        verdict: "VERIFIED",
        docsImpact: "none",
        wikiArtifacts: [],
        findings: [],
        createdAt: "2026-04-28T12:00:00.000Z",
        gate: {
          mergeReady: true,
          requiredWikiActions: [],
          missingWikiActions: [],
          issues: [],
        },
      },
      null,
      2,
    ),
    "utf-8",
  );
  fs.writeFileSync(
    path.join(reviewsDir, "latest-by-task.json"),
    JSON.stringify({ [taskId]: reviewId }, null, 2),
    "utf-8",
  );
}

function readSessionEvents(projectRoot: string, sessionId: string): Array<Record<string, unknown>> {
  const eventsFile = path.join(projectRoot, ".quack", "logs", `events-${sessionId}.jsonl`);
  return fs
    .readFileSync(eventsFile, "utf-8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupDir(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(targetPath, {
        recursive: true,
        force: true,
        maxRetries: 4,
        retryDelay: 75,
      });
      return;
    } catch {
      await pause(125);
    }
  }
}

async function httpGet(
  url: string,
  token = "fed-token",
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers.Authorization = `Bearer ${token}`;
    http
      .get(url, { headers }, (res) => {
        let body = "";
        res.on("data", (chunk: Buffer | string) => {
          body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

async function httpPost(
  url: string,
  data: Record<string, unknown>,
  token = "fed-token",
  timeoutMs?: number,
): Promise<{ status: number; body: string; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = JSON.stringify(data);
    const headers: Record<string, string | number> = {
      "Content-Type": "application/json",
      "Content-Length": Buffer.byteLength(postData),
    };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname,
        method: "POST",
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer | string) => {
          body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body, headers: res.headers }));
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (timeoutMs)
      req.setTimeout(timeoutMs, () =>
        req.destroy(new Error("Bounded federation request timed out")),
      );
    req.write(postData);
    req.end();
  });
}

function createStaleMergeDiagnostic(projectRoot: string, quackRoot: string) {
  const startedAt = Date.now();
  const parent = path.join(process.cwd(), ".dev", "stale-merge-diagnostics");
  let evidenceDir: string | undefined;
  if (process.env.QUACK_STALE_MERGE_DIAGNOSTICS === "1") {
    fs.mkdirSync(parent, { recursive: true });
    evidenceDir = fs.mkdtempSync(path.join(parent, "run-"));
  }
  const record = (phase: string, details: Record<string, unknown> = {}): void => {
    if (!evidenceDir) return;
    const fd = fs.openSync(path.join(evidenceDir, "phases.jsonl"), "a", 0o600);
    try {
      fs.writeSync(
        fd,
        JSON.stringify({
          phase,
          elapsedMs: Date.now() - startedAt,
          ...details,
        }) + "\n",
      );
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
  };
  let preserved = false;
  const preserve = (reason: string): void => {
    if (preserved) return;
    preserved = true;
    try {
      record("fixture.preserved", { reason, projectRoot, quackRoot });
      if (evidenceDir) {
        const federation = path.join(projectRoot, ".quack", "federation");
        if (fs.existsSync(federation))
          fs.cpSync(federation, path.join(evidenceDir, "federation-before-stop"), {
            recursive: true,
          });
      }
    } catch (error) {
      // Evidence I/O must not skip the real server stop after a failed test.
      console.warn("Stale merge diagnostic capture failed", error);
    }
    console.warn("Preserved stale merge fixture", {
      reason,
      projectRoot,
      quackRoot,
      evidenceDir,
    });
  };
  record("test.started", { projectRoot, quackRoot, timeoutMs: 30_000 });
  return { projectRoot, passed: false, record, preserve };
}

describe("v1 federation API", () => {
  let projectRoot: string;
  let quackRoot: string;
  let stop: (() => Promise<void>) | null = null;
  let baseUrl: string;
  let federationMergeFailure: string | undefined;
  let federationMergeFailureAfterPush: string | undefined;
  let federationMergeCalls: FederatedMergeExecutionInput[];
  let federationMergeReceipts: Map<string, string>;
  let federationMergeHook: ((input: FederatedMergeExecutionInput) => Promise<void>) | undefined;
  let federationRefreshHook: (() => Promise<void>) | undefined;
  let staleMergeDiagnostic: ReturnType<typeof createStaleMergeDiagnostic> | undefined;

  beforeEach(async () => {
    projectRoot = makeTempDir("quack-federation-project-");
    quackRoot = makeTempDir("quack-federation-root-");
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeAuthConfig(quackRoot);
    writeCcusageCache(projectRoot);
    writeTaskFile(projectRoot, "TASK-838");
    writePassingPrep(projectRoot, "TASK-838");
    federationMergeFailure = undefined;
    federationMergeFailureAfterPush = undefined;
    federationMergeCalls = [];
    federationMergeReceipts = new Map();
    federationMergeHook = undefined;
    federationRefreshHook = undefined;
    staleMergeDiagnostic = undefined;

    const federationMergeBoundary: FederatedMergeBoundary = {
      seal: async (input) => {
        const diagnostic =
          staleMergeDiagnostic?.projectRoot === input.projectRoot
            ? staleMergeDiagnostic
            : undefined;
        diagnostic?.record("seal.started");
        try {
          const binding = await sealFixtureFederatedMerge(input);
          diagnostic?.record("seal.completed", { binding });
          return binding;
        } catch (error) {
          diagnostic?.record("seal.failed", { error: String(error) });
          throw error;
        }
      },
      merge: async (input) => {
        federationMergeCalls.push(input);
        await federationMergeHook?.(input);
        const receipt = federationMergeReceipts.get(input.binding.publicationNonce);
        if (receipt) return { ok: true, commitSha: receipt, commands: 1 };
        if (federationMergeFailure) {
          return { ok: false, error: federationMergeFailure, commands: 0 };
        }
        const diagnostic =
          staleMergeDiagnostic?.projectRoot === input.projectRoot
            ? staleMergeDiagnostic
            : undefined;
        diagnostic?.record("merge.git.started");
        const result = await mergeFixtureFederatedBranch(input);
        diagnostic?.record("merge.git.completed", { result });
        if (result.ok)
          federationMergeReceipts.set(input.binding.publicationNonce, result.commitSha);
        if (result.ok && federationMergeFailureAfterPush) {
          return { ok: false, error: federationMergeFailureAfterPush, commands: result.commands };
        }
        return result;
      },
    };

    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      quackRoot,
      port: 0,
      host: "127.0.0.1",
      federationMergeBoundary,
      federationBroadcastRefresh: async (...args) => {
        await federationRefreshHook?.();
        return broadcastWorkerRefreshCommand(...args);
      },
    });
    const started = await server.start();
    stop = started.stop;
    baseUrl = `http://127.0.0.1:${started.port}`;
    await pause(150);
  });

  afterEach(async () => {
    const diagnostic = staleMergeDiagnostic;
    // Capture this before awaiting real shutdown: a timed-out body can still finish later.
    const preserveFixture = diagnostic !== undefined && !diagnostic.passed;
    if (preserveFixture) diagnostic.preserve("test_failed_or_did_not_finish");
    try {
      if (stop) {
        await stop();
        stop = null;
      }
    } catch (error) {
      diagnostic?.preserve("shutdown_failed");
      throw error;
    }
    await pause(150);
    if (!preserveFixture) {
      await cleanupDir(projectRoot);
      await cleanupDir(quackRoot);
    }
  });

  async function registerListener(hostId: string, token = "fed-token"): Promise<void> {
    const registered = await httpPost(
      `${baseUrl}/v1/listeners/register`,
      {
        hostId,
        capabilities: ["dispatch"],
        healthy: true,
        currentLoad: 0,
        maxConcurrentJobs: 1,
      },
      token,
    );
    expect(registered.status).toBe(201);
  }

  it("surfaces each malformed listener while retaining valid workers in listener and queue reads", async () => {
    await registerListener("healthy-worker");
    const directory = path.join(projectRoot, ".quack", "federation", "listeners");
    const malformed = "{not-json";
    fs.writeFileSync(path.join(directory, "broken-worker.json"), malformed);
    const listeners = await httpGet(`${baseUrl}/v1/listeners`);
    expect(listeners.status).toBe(200);
    expect(JSON.parse(listeners.body)).toMatchObject({
      listeners: [{ id: "healthy-worker" }],
      registryHealth: {
        healthy: false,
        unavailable: false,
        issues: [{ file: "broken-worker.json", code: "malformed_json" }],
      },
    });
    const queue = await httpGet(`${baseUrl}/v1/federation/queue`);
    expect(queue.status).toBe(200);
    expect(JSON.parse(queue.body)).toMatchObject({
      summary: {
        hosts: expect.arrayContaining([
          expect.objectContaining({ id: "healthy-worker" }),
        ]) as unknown,
        listenerRegistry: {
          healthy: false,
          issues: [{ file: "broken-worker.json", code: "malformed_json" }],
        },
      },
    });
    for (const operation of [
      {
        route: "/v1/listeners/register",
        body: { hostId: "broken-worker", capabilities: ["dispatch"] },
      },
      { route: "/v1/listeners/broken-worker/heartbeat", body: { healthy: true } },
      {
        route: "/v1/listeners/broken-worker/commands/ack",
        body: { commandIds: ["fixture-command"] },
      },
    ]) {
      const response = await httpPost(
        `${baseUrl}${operation.route}`,
        operation.body,
        "fed-token",
        2000,
      );
      expect(response.status).toBe(503);
      expect(JSON.parse(response.body)).toMatchObject({
        error: "listener_registry_unavailable",
        issue: { code: "malformed_json" },
      });
    }
    expect(fs.readFileSync(path.join(directory, "broken-worker.json"), "utf-8")).toBe(malformed);
  });

  it("coalesces repeated HTTP enqueue into one job and one queued event", async () => {
    const requests = await Promise.all([
      httpPost(`${baseUrl}/v1/federation/queue`, { taskId: "TASK-838", autoSchedule: false }),
      httpPost(`${baseUrl}/v1/federation/queue`, { taskId: "TASK-838", autoSchedule: false }),
    ]);
    expect(requests.map((request) => request.status)).toEqual([202, 202]);
    const results = requests.map((request) =>
      parseJson<{ reused: boolean; job: { jobId: string } }>(request.body),
    );
    expect(results.filter((result) => result.reused)).toHaveLength(1);
    expect(results[0].job.jobId).toBe(results[1].job.jobId);
    const file = path.join(
      projectRoot,
      ".quack",
      "logs",
      `events-federation-${results[0].job.jobId}.jsonl`,
    );
    const queued = fs
      .readFileSync(file, "utf-8")
      .split("\n")
      .filter((line) => line.includes('"status":"queued"'));
    expect(queued).toHaveLength(1);
    const conflict = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      autoSchedule: false,
      preferredHostId: "different-worker",
    });
    expect(conflict.status).toBe(409);
    expect(JSON.parse(conflict.body)).toMatchObject({ error: "federated_queue_conflict" });
  });

  it("rejects federated writes without a scoped service token", async () => {
    const resp = await httpPost(
      `${baseUrl}/v1/federation/jobs`,
      {
        taskId: "TASK-838",
        hosts: [],
      },
      "",
    );

    expect(resp.status).toBe(401);
    expect(JSON.parse(resp.body)).toMatchObject({
      error: "service_token_required",
      requiredScope: "federation:write",
    });
  });

  it("rejects listener takeover and cross-token resume mutations for a bound host", async () => {
    await registerListener("laptop");

    const takeover = await httpPost(
      `${baseUrl}/v1/listeners/register`,
      {
        hostId: "laptop",
        capabilities: ["dispatch"],
        healthy: true,
        currentLoad: 0,
        maxConcurrentJobs: 1,
      },
      "other-token",
    );
    expect(takeover.status).toBe(409);
    expect(takeover.body).toContain("listener_token_host_mismatch");

    const forgedHeartbeat = await httpPost(
      `${baseUrl}/v1/listeners/laptop/heartbeat`,
      { healthy: false, currentLoad: 99 },
      "other-token",
    );
    expect(forgedHeartbeat.status).toBe(403);
    expect(forgedHeartbeat.body).toContain("listener_token_host_mismatch");

    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "laptop",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
        },
      ],
    });
    const job = parseJson<{ job: FederatedJobRecord }>(created.body).job;
    const running = await httpPost(`${baseUrl}/v1/federation/jobs/${job.jobId}/events`, {
      hostId: "laptop",
      status: "running",
      remoteSessionId: "bound-session",
    });
    expect(running.status).toBe(202);

    const pauseMutation = {
      hostId: "laptop",
      status: "awaiting_approval",
      leaseId: job.lease!.leaseId,
      pendingGate: { stage: "judge", since: new Date().toISOString() },
      pauseIdentity: {
        jobId: job.jobId,
        taskId: job.taskId,
        jobType: "dispatch",
        hostId: "laptop",
        sessionId: "bound-session",
      },
    };
    const forgedPause = await httpPost(
      `${baseUrl}/v1/federation/jobs/${job.jobId}/events`,
      pauseMutation,
      "other-token",
    );
    expect(forgedPause.status).toBe(403);
    expect(forgedPause.body).toContain("listener_token_host_mismatch");

    const acceptedPause = await httpPost(
      `${baseUrl}/v1/federation/jobs/${job.jobId}/events`,
      pauseMutation,
    );
    expect(acceptedPause.status).toBe(202);
    const paused = parseJson<{ job: FederatedJobRecord }>(acceptedPause.body).job;
    const forgedRelease = await httpPost(
      `${baseUrl}/v1/federation/jobs/${job.jobId}/pause/release`,
      {
        hostId: "laptop",
        generation: paused.pause!.generation,
        releaseNonce: paused.pause!.releaseNonce,
        localStateArmed: true,
      },
      "other-token",
    );
    expect(forgedRelease.status).toBe(403);
    expect(forgedRelease.body).toContain("listener_token_host_mismatch");

    const commandAck = await httpPost(
      `${baseUrl}/v1/listeners/laptop/commands/ack`,
      { commandId: "forged-command" },
      "other-token",
    );
    expect(commandAck.status).toBe(403);
    expect(commandAck.body).toContain("listener_token_host_mismatch");

    const released = await httpPost(`${baseUrl}/v1/federation/jobs/${job.jobId}/pause/release`, {
      hostId: "laptop",
      generation: paused.pause!.generation,
      releaseNonce: paused.pause!.releaseNonce,
      localStateArmed: true,
    });
    expect(released.status).toBe(200);
    const releasedJob = parseJson<{ job: FederatedJobRecord }>(released.body).job;

    const forgedRequest = await httpPost(
      `${baseUrl}/v1/federation/jobs/${job.jobId}/resume/request`,
      {
        hostId: "laptop",
        generation: releasedJob.pause!.generation,
        releaseNonce: releasedJob.pause!.releaseNonce,
        decision: { action: "approved" },
      },
      "other-token",
    );
    expect(forgedRequest.status).toBe(403);

    const requested = await httpPost(`${baseUrl}/v1/federation/jobs/${job.jobId}/resume/request`, {
      hostId: "laptop",
      generation: releasedJob.pause!.generation,
      releaseNonce: releasedJob.pause!.releaseNonce,
      decision: { action: "approved" },
    });
    expect(requested.status).toBe(200);
    const requestedJob = parseJson<{ job: FederatedJobRecord }>(requested.body).job;

    const forgedClaim = await httpPost(
      `${baseUrl}/v1/federation/jobs/${job.jobId}/resume/claim`,
      {
        hostId: "laptop",
        generation: requestedJob.pause!.generation,
        releaseNonce: requestedJob.pause!.releaseNonce,
      },
      "other-token",
    );
    expect(forgedClaim.status).toBe(403);

    const claimed = await httpPost(`${baseUrl}/v1/federation/jobs/${job.jobId}/resume/claim`, {
      hostId: "laptop",
      generation: requestedJob.pause!.generation,
      releaseNonce: requestedJob.pause!.releaseNonce,
    });
    expect(claimed.status).toBe(200);
    const claimedJob = parseJson<{ job: FederatedJobRecord }>(claimed.body).job;

    const forgedAck = await httpPost(
      `${baseUrl}/v1/federation/jobs/${job.jobId}/resume/ack`,
      {
        projectId: claimedJob.projectId,
        taskId: claimedJob.taskId,
        jobType: claimedJob.jobType,
        hostId: "laptop",
        originalSessionId: claimedJob.pause!.sessionId,
        generation: claimedJob.pause!.generation,
        releaseNonce: claimedJob.pause!.releaseNonce,
        claimToken: claimedJob.pause!.claim!.token,
        leaseId: claimedJob.lease!.leaseId,
        phase: "approved_but_not_started",
      },
      "other-token",
    );
    expect(forgedAck.status).toBe(403);

    const forgedRenewal = await httpPost(
      `${baseUrl}/v1/federation/jobs/${job.jobId}/lease/renew`,
      { hostId: "laptop", leaseId: job.lease!.leaseId },
      "other-token",
    );
    expect(forgedRenewal.status).toBe(403);
    expect(forgedRenewal.body).toContain("listener_token_host_mismatch");
  });

  it("submits, reads, and cancels a job assigned to a healthy host", async () => {
    const resp = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "headnode",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
        },
      ],
    });

    expect(resp.status).toBe(202);
    const body = JSON.parse(resp.body) as {
      job: { jobId: string; hostId: string };
      projection: { state: string };
    };
    expect(body.job.hostId).toBe("headnode");
    expect(body.projection.state).toBe("assigned");

    const fetched = await httpGet(`${baseUrl}/v1/federation/jobs/${body.job.jobId}`);
    expect(fetched.status).toBe(200);
    expect(JSON.parse(fetched.body)).toMatchObject({
      ok: true,
      job: { jobId: body.job.jobId, status: "assigned" },
    });

    const running = await httpPost(`${baseUrl}/v1/federation/jobs/${body.job.jobId}/events`, {
      hostId: "headnode",
      status: "running",
      remoteSessionId: "beast-task-838-001",
      message: "Worker accepted the job.",
    });
    expect(running.status).toBe(202);

    const activeSessions = await httpGet(`${baseUrl}/api/sessions?limit=10`);
    expect(activeSessions.status).toBe(200);
    const sessionId = `federation-${body.job.jobId}`;
    expect(JSON.parse(activeSessions.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          taskId: "TASK-838",
          title: "Federation Fixture",
          status: "active",
        }),
      ]),
    );
    const runningEvents = readSessionEvents(projectRoot, sessionId);
    expect(runningEvents.find((event) => event.stage === "session_start")).toMatchObject({
      payload: {
        taskTitle: "Federation Fixture",
        taskDescription: "Federation fixture.",
      },
    });

    const canceled = await httpPost(`${baseUrl}/v1/federation/jobs/${body.job.jobId}/cancel`, {});
    expect(canceled.status).toBe(200);
    expect(JSON.parse(canceled.body)).toMatchObject({
      ok: true,
      job: { status: "canceled", canceledBy: "fed-test" },
      projection: { state: "canceled" },
    });

    const sessionsAfterCancel = await httpGet(`${baseUrl}/api/sessions?limit=10`);
    expect(sessionsAfterCancel.status).toBe(200);
    expect(JSON.parse(sessionsAfterCancel.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          taskId: "TASK-838",
          title: "Federation Fixture",
          status: "completed",
          outcome: "canceled",
        }),
      ]),
    );
  });

  it("returns a retryable locked response without overwriting a contended cancellation", async () => {
    const queued = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "headnode",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
        },
      ],
    });
    expect(queued.status).toBe(202);
    const jobId = parseJson<{ job: { jobId: string } }>(queued.body).job.jobId;
    const lockPath = path.join(projectRoot, ".quack", "federation", "jobs", `${jobId}.lock`);
    fs.writeFileSync(lockPath, "unverifiable owner", "utf-8");
    setFederatedJobLockOptionsForTests({
      retryMs: 2,
      waitTimeoutMs: 25,
      staleMs: 10,
      heartbeatMs: 2,
    });

    try {
      const canceled = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/cancel`, {});
      expect(canceled.status).toBe(423);
      expect(canceled.headers["retry-after"]).toBe("1");
      expect(parseJson<Record<string, unknown>>(canceled.body)).toMatchObject({
        error: "federated_job_lock_busy",
        retryable: true,
        jobId,
      });
      expect(await loadFederatedJob(projectRoot, jobId)).not.toMatchObject({ status: "canceled" });
      expect(fs.readFileSync(lockPath, "utf-8")).toBe("unverifiable owner");
    } finally {
      setFederatedJobLockOptionsForTests(undefined);
      fs.rmSync(lockPath, { force: true });
    }
  });

  it("refuses explicit reconciliation of a canceled job without reviving it", async () => {
    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoVerify: true,
      autoMerge: true,
    });
    expect(queued.status).toBe(202);
    const jobId = parseJson<{ job: { jobId: string } }>(queued.body).job.jobId;

    const canceled = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/cancel`, {});
    expect(canceled.status).toBe(200);

    const reconciled = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/reconcile`, {
      autoVerify: true,
      autoMerge: true,
      branchName: "quack/TASK-838",
      commitSha: "1234567890abcdef1234567890abcdef12345678",
      targetBranch: "dev",
    });
    expect(reconciled.status).toBe(409);
    expect(parseJson<{ error: string; status: string }>(reconciled.body)).toMatchObject({
      error: "federated_reconcile_terminal",
      status: "canceled",
    });
    expect(await loadFederatedJob(projectRoot, jobId)).toMatchObject({ status: "canceled" });
    expect(federationMergeCalls).toHaveLength(0);
  });

  it("releases the lease and marks nextAction when a worker reports a terminal failure", async () => {
    const queued = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "headnode",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
        },
      ],
    });

    expect(queued.status).toBe(202);
    const queuedBody = parseJson<{
      job: { jobId: string; status: string; hostId: string; lease?: { hostId: string } };
    }>(queued.body);
    expect(queuedBody.job.status).toBe("assigned");
    expect(queuedBody.job.lease?.hostId).toBe("headnode");

    const failed = await httpPost(`${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`, {
      hostId: "headnode",
      status: "failed",
      remoteSessionId: "beast-task-838-failed",
      message: "Judge evaluation failed after retry: Claude Code process exited with code 1",
      events: [
        {
          stage: "session_error",
          sessionId: "beast-task-838-failed",
          payload: {
            error: "Judge evaluation failed after retry: Claude Code process exited with code 1",
            failedStage: "unknown",
          },
        },
      ],
      evidence: [
        {
          type: "worker_execution",
          taskId: "TASK-838",
          status: "failed",
          outputTail: [
            "Judge evaluation failed after retry: Claude Code process exited with code 1",
          ],
        },
      ],
    });

    expect(failed.status).toBe(202);
    const failedBody = parseJson<{
      job: {
        jobId: string;
        status: string;
        nextAction: string;
        lease?: unknown;
        error?: string;
        completedAt?: string;
      };
      projection: { state: string };
    }>(failed.body);
    expect(failedBody.job.status).toBe("failed");
    expect(failedBody.job.nextAction).toBe("investigate_failed_worker");
    expect(failedBody.job.lease).toBeUndefined();
    expect(failedBody.job.error).toContain("Judge evaluation failed after retry");
    expect(failedBody.job.completedAt).toBeDefined();
    expect(failedBody.projection.state).toBe("failed");

    const sessionId = `federation-${queuedBody.job.jobId}`;
    const sessionEvents = readSessionEvents(projectRoot, sessionId);
    expect(sessionEvents.some((event) => event.stage === "session_error")).toBe(true);

    const sessions = await httpGet(`${baseUrl}/api/sessions?limit=10`);
    expect(sessions.status).toBe(200);
    expect(JSON.parse(sessions.body)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          sessionId,
          taskId: "TASK-838",
          status: "error",
          outcome: "failed",
        }),
      ]),
    );
  });

  it("keeps active progress monotonic and treats an exact terminal duplicate as immutable", async () => {
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [{ id: "laptop", capabilities: ["dispatch"], enabled: true, healthy: true }],
    });
    const original = parseJson<{ job: FederatedJobRecord }>(created.body).job;

    expect(
      (
        await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
          hostId: "laptop",
          status: "running",
          remoteSessionId: "monotonic-session",
        })
      ).status,
    ).toBe(202);
    expect(
      (
        await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
          hostId: "laptop",
          status: "verifying",
          remoteSessionId: "monotonic-session",
        })
      ).status,
    ).toBe(202);

    for (const staleStatus of ["running", "assigned", "queued"] as const) {
      const stale = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
        hostId: "laptop",
        status: staleStatus,
        remoteSessionId: "monotonic-session",
      });
      expect(stale.status).toBe(409);
      expect(stale.body).toContain("federated_status_regression");
    }

    const completed = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "completed",
      remoteSessionId: "monotonic-session",
      autoVerify: false,
      evidence: [{ type: "initial-terminal-evidence" }],
    });
    expect(completed.status).toBe(202);
    const closed = parseJson<{ job: FederatedJobRecord }>(completed.body).job;

    const duplicate = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "completed",
      remoteSessionId: "different-session",
      message: "must not overwrite terminal state",
      evidence: [{ type: "must-not-append" }],
    });
    expect(duplicate.status).toBe(202);
    expect(
      parseJson<{ duplicate: boolean; job: FederatedJobRecord }>(duplicate.body),
    ).toMatchObject({
      duplicate: true,
      job: {
        status: "completed",
        remoteSessionId: "monotonic-session",
        updatedAt: closed.updatedAt,
        eventCount: closed.eventCount,
        evidence: closed.evidence,
      },
    });

    const revive = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "running",
      remoteSessionId: "different-session",
    });
    expect(revive.status).toBe(409);
    expect(revive.body).toContain("federated_status_regression");
  });

  // ─── TASK-1329 round-2 R2-5 ───────────────────────────────────────
  // `awaiting_approval` is a CLAIM about disk state and has to be earned. If the
  // wire accepts it bare, nextAction degrades to a gate it cannot name and the
  // operator is told to decide something the record does not identify.
  it("refuses awaiting_approval without a pendingGate, and accepts it with one", async () => {
    await registerListener("headnode");
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-1329-relay",
      jobType: "dispatch",
      hosts: [{ id: "headnode", capabilities: ["dispatch"], enabled: true, healthy: true }],
      requiredCapabilities: ["dispatch"],
    });
    expect(created.status).toBe(202);
    const createdJob = (
      JSON.parse(created.body) as {
        job: FederatedJobRecord;
      }
    ).job;
    const jobId = createdJob.jobId;
    const running = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/events`, {
      hostId: "headnode",
      status: "running",
      remoteSessionId: "worker-session-1329",
    });
    expect(running.status).toBe(202);

    const bare = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/events`, {
      hostId: "headnode",
      status: "awaiting_approval",
      message: "paused, but naming no gate",
    });
    expect(bare.status).toBe(400);
    expect(bare.body).toContain("pendingGate");

    const earned = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/events`, {
      hostId: "headnode",
      status: "awaiting_approval",
      message: "paused at the brief gate",
      pendingGate: { stage: "blueprint", since: "2026-08-14T00:00:00.000Z" },
      leaseId: createdJob.lease!.leaseId,
      pauseIdentity: {
        jobId,
        taskId: "TASK-1329-relay",
        jobType: "dispatch",
        hostId: "headnode",
        sessionId: "worker-session-1329",
      },
    });
    expect(earned.status).toBe(202);
    // The queue must now name the decision rather than send anyone hunting a crash.
    const body = JSON.parse(earned.body) as {
      job: { status: string; nextAction?: string; error?: string };
    };
    expect(body.job.status).toBe("awaiting_approval");
    expect(body.job.nextAction).toContain("blueprint");
    expect(body.job.error).toBeUndefined();
  });

  it("prepares, releases, and atomically reclaims a pause without changing job identity", async () => {
    const registered = await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "laptop",
      capabilities: ["dispatch"],
      healthy: true,
      currentLoad: 0,
      maxConcurrentJobs: 1,
    });
    expect(registered.status).toBe(201);
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "laptop",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
          currentLoad: 0,
          maxConcurrentJobs: 1,
        },
      ],
    });
    const original = parseJson<{ job: FederatedJobRecord }>(created.body).job;
    await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "running",
      remoteSessionId: "worker-session-1330",
    });
    const forgedIdentity = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      {
        hostId: "laptop",
        status: "awaiting_approval",
        pendingGate: { stage: "judge", since: "2026-08-14T00:04:00.000Z" },
        pauseIdentity: {
          jobId: "different-job",
          taskId: "TASK-838",
          jobType: "dispatch",
          hostId: "laptop",
          sessionId: "worker-session-1330",
        },
        leaseId: original.lease!.leaseId,
      },
    );
    expect(forgedIdentity.status).toBe(409);
    expect(forgedIdentity.body).toContain("federated_pause_identity_mismatch");

    const preparedResponse = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      {
        hostId: "laptop",
        status: "awaiting_approval",
        pendingGate: { stage: "judge", since: "2026-08-14T00:05:00.000Z" },
        pauseIdentity: {
          jobId: original.jobId,
          taskId: "TASK-838",
          jobType: "dispatch",
          hostId: "laptop",
          sessionId: "worker-session-1330",
        },
        leaseId: original.lease!.leaseId,
      },
    );
    expect(preparedResponse.status).toBe(202);
    const prepared = parseJson<{ job: FederatedJobRecord }>(preparedResponse.body).job;
    expect(prepared.pause?.state).toBe("attached");
    expect(prepared.lease).toBeDefined();

    const staleAttachedStatus = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      { hostId: "laptop", status: "verifying" },
    );
    expect(staleAttachedStatus.status).toBe(409);
    expect(staleAttachedStatus.body).toContain("federated_resume_grant_required");

    const releasedResponse = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/pause/release`,
      {
        hostId: "laptop",
        generation: prepared.pause!.generation,
        releaseNonce: prepared.pause!.releaseNonce,
        localStateArmed: true,
      },
    );
    expect(releasedResponse.status).toBe(200);
    const released = parseJson<{ job: FederatedJobRecord }>(releasedResponse.body).job;
    expect(released).toMatchObject({
      jobId: original.jobId,
      status: "awaiting_approval",
      pause: { state: "released", originalHostId: "laptop" },
    });
    expect(released.lease).toBeUndefined();

    const releasedReceipt = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      {
        hostId: "laptop",
        status: "awaiting_approval",
        pendingGate: { stage: "judge", since: "2026-08-14T00:05:00.000Z" },
        pauseIdentity: {
          jobId: original.jobId,
          taskId: "TASK-838",
          jobType: "dispatch",
          hostId: "laptop",
          sessionId: "worker-session-1330",
        },
        leaseId: prepared.lease!.leaseId,
      },
    );
    expect(releasedReceipt.status).toBe(202);
    expect(
      parseJson<{ duplicate: boolean; job: FederatedJobRecord }>(releasedReceipt.body),
    ).toMatchObject({
      duplicate: true,
      job: {
        status: "awaiting_approval",
        updatedAt: released.updatedAt,
        pause: { state: "released", generation: released.pause!.generation },
      },
    });

    const queue = parseJson<{
      summary: { activeDispatchJobs: number; activeDispatchByHost: Record<string, number> };
    }>((await httpGet(`${baseUrl}/v1/federation/queue`)).body);
    expect(queue.summary.activeDispatchJobs).toBe(0);
    expect(queue.summary.activeDispatchByHost.laptop).toBeUndefined();

    const staleReleasedStatus = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      { hostId: "laptop", status: "running" },
    );
    expect(staleReleasedStatus.status).toBe(409);
    expect(staleReleasedStatus.body).toContain("federated_resume_grant_required");

    const staleRenewal = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/lease/renew`,
      { hostId: "laptop", leaseId: prepared.lease!.leaseId },
    );
    expect(staleRenewal.status).toBe(409);
    expect(staleRenewal.body).toContain("federated_pause_released");

    const requestedResponse = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/resume/request`,
      {
        hostId: "laptop",
        generation: released.pause!.generation,
        releaseNonce: released.pause!.releaseNonce,
        decision: { action: "approved" },
      },
    );
    expect(requestedResponse.status).toBe(200);
    const attempts = await Promise.all([
      httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/resume/claim`, {
        hostId: "laptop",
        generation: released.pause!.generation,
        releaseNonce: released.pause!.releaseNonce,
      }),
      httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/resume/claim`, {
        hostId: "laptop",
        generation: released.pause!.generation,
        releaseNonce: released.pause!.releaseNonce,
      }),
    ]);
    expect(attempts.map((attempt) => attempt.status).sort()).toEqual([200, 409]);
    const claimed = parseJson<{ job: FederatedJobRecord }>(
      attempts.find((attempt) => attempt.status === 200)!.body,
    ).job;
    expect(claimed.jobId).toBe(original.jobId);
    expect(claimed.pause?.state).toBe("resume_claimed");

    const incompleteAck = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/resume/ack`,
      {
        hostId: "laptop",
        generation: claimed.pause!.generation,
        claimToken: claimed.pause!.claim!.token,
        phase: "approved_but_not_started",
      },
    );
    expect(incompleteAck.status).toBe(400);

    const ack = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/resume/ack`, {
      projectId: claimed.projectId,
      taskId: claimed.taskId,
      jobType: claimed.jobType,
      hostId: "laptop",
      originalSessionId: claimed.pause!.sessionId,
      generation: claimed.pause!.generation,
      releaseNonce: claimed.pause!.releaseNonce,
      claimToken: claimed.pause!.claim!.token,
      leaseId: claimed.lease!.leaseId,
      phase: "approved_but_not_started",
    });
    expect(ack.status).toBe(200);
    const acknowledged = parseJson<{
      job: FederatedJobRecord;
      startGrant: NonNullable<NonNullable<FederatedJobRecord["pause"]>["startGrant"]>;
    }>(ack.body);

    for (const status of ["assigned", "running", "verifying", "fixing"] as const) {
      const genericRevival = await httpPost(
        `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
        { hostId: "laptop", status, remoteSessionId: "resume-session" },
      );
      expect(genericRevival.status).toBe(409);
      expect(genericRevival.body).toContain(
        status === "assigned" ? "federated_status_regression" : "federated_resume_grant_required",
      );
    }

    const resumed = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "running",
      remoteSessionId: "resume-session",
      resumeSessionId: "resume-session",
      resumeGrant: acknowledged.startGrant,
    });
    expect(resumed.status).toBe(202);
    expect(parseJson<{ job: FederatedJobRecord }>(resumed.body).job).toMatchObject({
      status: "running",
      remoteSessionId: "resume-session",
      pause: {
        startGrant: {
          token: acknowledged.startGrant.token,
          resumedSessionId: "resume-session",
        },
      },
    });

    const verifying = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "verifying",
      resumeSessionId: "resume-session",
      resumeGrant: acknowledged.startGrant,
    });
    expect(verifying.status).toBe(202);
    const verifyingJob = parseJson<{ job: FederatedJobRecord }>(verifying.body).job;

    await saveFederatedJob(projectRoot, {
      ...verifyingJob,
      lease: {
        ...verifyingJob.lease!,
        expiresAt: new Date(Date.now() - 1_000).toISOString(),
      },
    });
    const expiredReplay = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "verifying",
      resumeSessionId: "resume-session",
      resumeGrant: acknowledged.startGrant,
    });
    expect(expiredReplay.status).toBe(409);
    expect(expiredReplay.body).toContain("federated_resume_grant_expired");

    await saveFederatedJob(projectRoot, {
      ...verifyingJob,
      lease: { ...verifyingJob.lease!, leaseId: "reassigned-lease" },
    });
    const reassignedReplay = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      {
        hostId: "laptop",
        status: "verifying",
        resumeSessionId: "resume-session",
        resumeGrant: acknowledged.startGrant,
      },
    );
    expect(reassignedReplay.status).toBe(409);
    expect(reassignedReplay.body).toContain("federated_resume_grant_mismatch");
    await saveFederatedJob(projectRoot, verifyingJob);

    const staleRunning = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "running",
      resumeSessionId: "resume-session",
      resumeGrant: acknowledged.startGrant,
    });
    expect(staleRunning.status).toBe(409);
    expect(staleRunning.body).toContain("federated_status_regression");

    const staleDaemonCloseout = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      {
        hostId: "laptop",
        status: "completed",
        resumeSessionId: "stale-session",
        resumeGrant: acknowledged.startGrant,
        autoVerify: false,
      },
    );
    expect(staleDaemonCloseout.status).toBe(409);
    expect(staleDaemonCloseout.body).toContain("federated_resume_grant_replayed");

    const completed = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "completed",
      resumeSessionId: "resume-session",
      remoteSessionId: "stale-reported-session",
      resumeGrant: acknowledged.startGrant,
      autoVerify: false,
    });
    expect(completed.status).toBe(202);
    const completedJob = parseJson<{ job: FederatedJobRecord }>(completed.body).job;
    expect(completedJob).toMatchObject({
      status: "completed",
      remoteSessionId: "resume-session",
    });

    const terminalRegression = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      {
        hostId: "laptop",
        status: "running",
        resumeSessionId: "resume-session",
        resumeGrant: acknowledged.startGrant,
      },
    );
    expect(terminalRegression.status).toBe(409);
    expect(terminalRegression.body).toContain("federated_status_regression");

    const completedReplay = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      {
        hostId: "laptop",
        status: "completed",
        resumeSessionId: "resume-session",
        resumeGrant: acknowledged.startGrant,
        autoVerify: false,
        evidence: [{ type: "must-not-append" }],
      },
    );
    expect(completedReplay.status).toBe(202);
    const completedReceipt = parseJson<{ duplicate: boolean; job: FederatedJobRecord }>(
      completedReplay.body,
    );
    expect(completedReceipt).toMatchObject({
      duplicate: true,
      job: {
        status: "completed",
        updatedAt: completedJob.updatedAt,
        eventCount: completedJob.eventCount,
      },
    });
    expect(completedReceipt.job.evidence).toEqual(completedJob.evidence);
  });

  it("consumes and idempotently closes an exact rejected-blueprint grant without a child", async () => {
    await registerListener("laptop");
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "laptop",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
        },
      ],
    });
    expect(created.status).toBe(202);
    const original = parseJson<{ job: FederatedJobRecord }>(created.body).job;
    const nowMs = Date.now();
    const now = new Date(nowMs - 120_000).toISOString();
    const resumeStartedAt = new Date(nowMs - 90_000).toISOString();
    const expiresAt = new Date(nowMs - 60_000).toISOString();
    const liveLeaseExpiresAt = new Date(nowMs + 120_000).toISOString();
    const leaseId = original.lease!.leaseId;
    const startGrant = {
      token: "blueprint-rejection-grant",
      projectId: original.projectId!,
      jobId: original.jobId,
      taskId: original.taskId,
      jobType: "dispatch" as const,
      hostId: "laptop",
      originalSessionId: "blueprint-session-original",
      generation: 1,
      releaseNonce: "blueprint-nonce",
      claimToken: "blueprint-claim",
      leaseId,
      issuedAt: now,
      expiresAt,
    };
    await saveFederatedJob(projectRoot, {
      ...original,
      status: "awaiting_approval",
      hostId: "laptop",
      pendingGate: { stage: "blueprint", since: now },
      lease: {
        ...original.lease!,
        hostId: "laptop",
        expiresAt: liveLeaseExpiresAt,
      },
      pause: {
        generation: 1,
        state: "approved_but_not_started",
        gate: "blueprint",
        sessionId: "blueprint-session-original",
        originalHostId: "laptop",
        releaseNonce: "blueprint-nonce",
        openedAt: now,
        preparedAt: now,
        decision: { action: "rejected", recordedAt: now },
        claim: {
          token: "blueprint-claim",
          hostId: "laptop",
          claimedAt: now,
          expiresAt,
        },
        approvedButNotStartedAt: now,
        startGrant,
      },
    });

    const forged = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "rejected",
      resumeGrant: { ...startGrant, leaseId: "stale-lease" },
      resumeStartedAt,
    });
    expect(forged.status).toBe(409);

    const forgedLate = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "rejected",
      resumeGrant: startGrant,
      resumeStartedAt: new Date(nowMs - 30_000).toISOString(),
    });
    expect(forgedLate.status).toBe(409);
    expect(forgedLate.body).toContain("federated_resume_reservation_mismatch");

    const acknowledged = (await loadFederatedJob(projectRoot, original.jobId))!;
    await saveFederatedJob(projectRoot, {
      ...acknowledged,
      lease: { ...acknowledged.lease!, leaseId: "reassigned-live-lease" },
    });
    const reassigned = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "rejected",
      resumeGrant: startGrant,
      resumeStartedAt,
    });
    expect(reassigned.status).toBe(409);
    expect(reassigned.body).toContain("federated_resume_grant_mismatch");

    await saveFederatedJob(projectRoot, {
      ...acknowledged,
      lease: { ...acknowledged.lease!, expiresAt },
    });
    const expiredLease = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "rejected",
      resumeGrant: startGrant,
      resumeStartedAt,
    });
    expect(expiredLease.status).toBe(409);
    expect(expiredLease.body).toContain("federated_resume_terminal_not_startable");

    await saveFederatedJob(projectRoot, acknowledged);

    const rejected = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "rejected",
      resumeGrant: startGrant,
      resumeStartedAt,
    });
    expect(rejected.status).toBe(202);
    const rejectedJob = parseJson<{ job: FederatedJobRecord }>(rejected.body).job;
    expect(rejectedJob).toMatchObject({
      status: "rejected",
      pause: {
        state: "approved_but_not_started",
        startGrant: {
          token: "blueprint-rejection-grant",
          consumedAt: resumeStartedAt,
        },
      },
    });

    const replay = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      hostId: "laptop",
      status: "rejected",
      resumeGrant: startGrant,
    });
    expect(replay.status).toBe(202);

    const terminalJob = rejectedJob;
    await saveFederatedJob(projectRoot, {
      ...terminalJob,
      status: "blocked",
      pause: {
        ...terminalJob.pause!,
        state: "manual_recovery",
        recoveryReason: "operator owns this recovery",
      },
    });
    const staleManualRecoveryStatus = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      { hostId: "laptop", status: "running" },
    );
    expect(staleManualRecoveryStatus.status).toBe(409);
    expect(staleManualRecoveryStatus.body).toContain("federated_pause_manual_recovery");
    const staleManualRecoveryPause = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      {
        hostId: "laptop",
        status: "awaiting_approval",
        pendingGate: { stage: "blueprint", since: now },
        leaseId,
        pauseIdentity: {
          jobId: original.jobId,
          taskId: original.taskId,
          jobType: "dispatch",
          hostId: "laptop",
          sessionId: "blueprint-session-original",
        },
      },
    );
    expect(staleManualRecoveryPause.status).toBe(409);
    expect(staleManualRecoveryPause.body).toContain("federated_pause_manual_recovery");
    expect(
      parseJson<{ job: FederatedJobRecord }>(
        (await httpGet(`${baseUrl}/v1/federation/jobs/${original.jobId}`)).body,
      ).job.status,
    ).toBe("blocked");
  });

  it("opens a new generation for a later same-session same-gate pause and deduplicates its replay", async () => {
    await registerListener("laptop");
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "laptop",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
        },
      ],
    });
    expect(created.status).toBe(202);
    const original = parseJson<{ job: FederatedJobRecord }>(created.body).job;
    const openedAt = new Date(Date.now() - 180_000).toISOString();
    const resumedAt = new Date(Date.now() - 120_000).toISOString();
    const laterOpenedAt = new Date(Date.now() - 60_000).toISOString();
    await saveFederatedJob(projectRoot, {
      ...original,
      status: "running",
      remoteSessionId: "same-dispatcher-session",
      pause: {
        generation: 1,
        state: "approved_but_not_started",
        gate: "judge",
        sessionId: "old-dispatcher-session",
        originalHostId: "laptop",
        releaseNonce: "old-release-nonce",
        openedAt,
        preparedAt: openedAt,
        resumedAt,
        decision: { action: "rejected", recordedAt: openedAt },
        claim: {
          token: "old-claim",
          hostId: "laptop",
          claimedAt: openedAt,
          expiresAt: resumedAt,
        },
        startGrant: {
          token: "old-grant",
          projectId: original.projectId!,
          jobId: original.jobId,
          taskId: original.taskId,
          jobType: "dispatch",
          hostId: "laptop",
          originalSessionId: "old-dispatcher-session",
          generation: 1,
          releaseNonce: "old-release-nonce",
          claimToken: "old-claim",
          leaseId: original.lease!.leaseId,
          issuedAt: openedAt,
          expiresAt: resumedAt,
          consumedAt: resumedAt,
          resumedSessionId: "same-dispatcher-session",
        },
      },
    });
    const report = {
      hostId: "laptop",
      status: "awaiting_approval",
      pendingGate: { stage: "judge", since: laterOpenedAt },
      pauseIdentity: {
        jobId: original.jobId,
        taskId: original.taskId,
        jobType: "dispatch",
        hostId: "laptop",
        sessionId: "same-dispatcher-session",
      },
      leaseId: original.lease!.leaseId,
    };

    const later = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, report);
    expect(later.status).toBe(202);
    const laterPause = parseJson<{ job: FederatedJobRecord }>(later.body).job.pause!;
    expect(laterPause).toMatchObject({
      generation: 2,
      state: "attached",
      gate: "judge",
      sessionId: "same-dispatcher-session",
      openedAt: laterOpenedAt,
    });
    expect(laterPause.releaseNonce).not.toBe("old-release-nonce");

    const duplicate = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      report,
    );
    expect(duplicate.status).toBe(202);
    expect(parseJson<{ job: FederatedJobRecord }>(duplicate.body).job.pause).toMatchObject({
      generation: 2,
      releaseNonce: laterPause.releaseNonce,
      openedAt: laterOpenedAt,
    });

    const staleOccurrence = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      {
        ...report,
        pendingGate: { stage: "judge", since: openedAt },
      },
    );
    expect(staleOccurrence.status).toBe(409);
    expect(staleOccurrence.body).toContain("stale_federated_pause_generation");

    const equalToResume = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      ...report,
      pendingGate: { stage: "judge", since: resumedAt },
    });
    expect(equalToResume.status).toBe(409);
    expect(equalToResume.body).toContain("stale_federated_pause_generation");

    const wrongSession = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      ...report,
      pauseIdentity: { ...report.pauseIdentity, sessionId: "stale-dispatcher-session" },
    });
    expect(wrongSession.status).toBe(409);
    expect(wrongSession.body).toContain("federated_pause_epoch_mismatch");

    const invalidTimestamp = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      {
        ...report,
        pendingGate: { stage: "judge", since: "not-a-date" },
      },
    );
    expect(invalidTimestamp.status).toBe(400);
  });

  it("accepts a delayed first resume observation only with an in-window local reservation and the live exact lease", async () => {
    await registerListener("laptop");
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "laptop",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
        },
      ],
    });
    expect(created.status).toBe(202);
    const original = parseJson<{ job: FederatedJobRecord }>(created.body).job;
    const nowMs = Date.now();
    const issuedAt = new Date(nowMs - 120_000).toISOString();
    const resumeStartedAt = new Date(nowMs - 90_000).toISOString();
    const expiresAt = new Date(nowMs - 60_000).toISOString();
    const liveLeaseExpiresAt = new Date(nowMs + 120_000).toISOString();
    const startGrant = {
      token: "delayed-observation-grant",
      projectId: original.projectId!,
      jobId: original.jobId,
      taskId: original.taskId,
      jobType: "dispatch" as const,
      hostId: "laptop",
      originalSessionId: "original-delayed-session",
      generation: 1,
      releaseNonce: "delayed-release-nonce",
      claimToken: "delayed-claim-token",
      leaseId: "delayed-lease-id",
      issuedAt,
      expiresAt,
    };
    const acknowledged: FederatedJobRecord = {
      ...original,
      status: "awaiting_approval",
      hostId: "laptop",
      pendingGate: { stage: "judge", since: issuedAt },
      lease: {
        leaseId: startGrant.leaseId,
        hostId: "laptop",
        acquiredAt: issuedAt,
        expiresAt: liveLeaseExpiresAt,
      },
      pause: {
        generation: 1,
        state: "approved_but_not_started",
        gate: "judge",
        sessionId: startGrant.originalSessionId,
        originalHostId: "laptop",
        releaseNonce: startGrant.releaseNonce,
        openedAt: issuedAt,
        preparedAt: issuedAt,
        decision: { action: "approved", recordedAt: issuedAt },
        claim: {
          token: startGrant.claimToken,
          hostId: "laptop",
          claimedAt: issuedAt,
          expiresAt,
        },
        approvedButNotStartedAt: issuedAt,
        startGrant,
      },
    };
    const report = {
      hostId: "laptop",
      status: "running",
      resumeGrant: startGrant,
      resumeSessionId: "delayed-resumed-session",
      remoteSessionId: "delayed-resumed-session",
      resumeStartedAt,
    };

    await saveFederatedJob(projectRoot, acknowledged);
    const forgedLate = await httpPost(`${baseUrl}/v1/federation/jobs/${original.jobId}/events`, {
      ...report,
      resumeStartedAt: new Date(nowMs - 30_000).toISOString(),
    });
    expect(forgedLate.status).toBe(409);
    expect(forgedLate.body).toContain("federated_resume_reservation_mismatch");

    await saveFederatedJob(projectRoot, {
      ...acknowledged,
      lease: { ...acknowledged.lease!, leaseId: "reassigned-live-lease" },
    });
    const reassigned = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      report,
    );
    expect(reassigned.status).toBe(409);
    expect(reassigned.body).toContain("federated_resume_grant_mismatch");

    await saveFederatedJob(projectRoot, {
      ...acknowledged,
      lease: { ...acknowledged.lease!, expiresAt: new Date(nowMs - 1_000).toISOString() },
    });
    const expiredLease = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      report,
    );
    expect(expiredLease.status).toBe(409);
    expect(expiredLease.body).toContain("federated_resume_grant_expired");

    await saveFederatedJob(projectRoot, acknowledged);
    const delayed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${original.jobId}/events`,
      report,
    );
    expect(delayed.status).toBe(202);
    expect(parseJson<{ job: FederatedJobRecord }>(delayed.body).job).toMatchObject({
      status: "running",
      remoteSessionId: "delayed-resumed-session",
      pause: {
        startGrant: {
          consumedAt: resumeStartedAt,
          resumedSessionId: "delayed-resumed-session",
        },
      },
    });
  });

  it("accepts remote worker status, relays Slack-friendly events, and persists evidence", async () => {
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "verify",
      hosts: [
        {
          id: "worker-b",
          capabilities: ["verify", "staging-db"],
          enabled: true,
          healthy: true,
        },
      ],
      requiredCapabilities: ["verify", "staging-db"],
    });

    expect(created.status).toBe(202);
    const createdBody = JSON.parse(created.body) as { job: { jobId: string } };

    const relayed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${createdBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoVerify: false,
        remoteSessionId: "hex-task-838-001",
        message: "Worker-B verified waitlist evidence.",
        events: [
          {
            stage: "judge_result",
            sequence: 7,
            timestamp: "2026-04-28T12:00:00.000Z",
            payload: {
              verdict: "APPROVE",
              confidence: 0.92,
              scopeViolations: [],
              criteriaGaps: [],
              qualityIssues: [],
              feedback: "Remote worker evidence accepted.",
            },
          },
        ],
        evidence: [
          {
            type: "api_probe",
            endpoint: "/api/waitlist/matches?days=7",
            summary: "Real provider/gap/duration/service gates observed.",
          },
        ],
      },
    );

    expect(relayed.status).toBe(202);
    const body = JSON.parse(relayed.body) as {
      ok: boolean;
      relayedEvents: number;
      relayedSlackEvents: number;
      job: {
        status: string;
        hostId: string;
        remoteSessionId: string;
        eventCount: number;
        evidence: Array<Record<string, unknown>>;
      };
    };
    expect(body).toMatchObject({
      ok: true,
      relayedEvents: 1,
      relayedSlackEvents: 1,
      job: {
        status: "completed",
        hostId: "worker-b",
        remoteSessionId: "hex-task-838-001",
        eventCount: 3,
        evidence: [
          {
            type: "api_probe",
          },
        ],
      },
    });

    const sessionId = `federation-${createdBody.job.jobId}`;
    const events = readSessionEvents(projectRoot, sessionId);
    const stages = events.map((event) => event.stage);
    expect(stages).toEqual(
      expect.arrayContaining([
        "session_start",
        "federated_job_status",
        "agent_progress_update",
        "session_complete",
        "federated_job_event",
        "judge_result",
      ]),
    );
    expect(events.find((event) => event.stage === "judge_result")).toMatchObject({
      payload: {
        remote: {
          jobId: createdBody.job.jobId,
          hostId: "worker-b",
          remoteStage: "judge_result",
        },
      },
    });
  });

  it("rejects remote worker events from a different assigned host", async () => {
    const created = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "worker-b",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: true,
        },
      ],
    });

    expect(created.status).toBe(202);
    const createdBody = JSON.parse(created.body) as { job: { jobId: string } };

    const relayed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${createdBody.job.jobId}/events`,
      {
        hostId: "contributor-laptop",
        status: "running",
        message: "Wrong host should be rejected.",
      },
    );

    expect(relayed.status).toBe(409);
    expect(JSON.parse(relayed.body)).toMatchObject({
      error: "federated_job_host_mismatch",
      expectedHostId: "worker-b",
      actualHostId: "contributor-laptop",
    });
  });

  it("registers listener hosts, accepts heartbeats, and routes jobs by capability", async () => {
    const registered = await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "contributor-laptop",
      alias: "Contributor Laptop",
      baseUrl: "http://100.1.2.3:3333",
      capabilities: ["dispatch", "verify", "staging-db", "auth"],
      maxConcurrentJobs: 1,
      repoCommit: "abc123",
      projectPaths: { example: "/home/contributor/example-service" },
    });

    expect(registered.status).toBe(201);
    expect(JSON.parse(registered.body)).toMatchObject({
      ok: true,
      listener: {
        id: "contributor-laptop",
        healthy: true,
        maxConcurrentJobs: 1,
      },
    });

    const heartbeat = await httpPost(`${baseUrl}/v1/listeners/contributor-laptop/heartbeat`, {
      healthy: true,
      currentLoad: 0,
      repoCommit: "def456",
    });

    expect(heartbeat.status).toBe(200);
    expect(JSON.parse(heartbeat.body)).toMatchObject({
      ok: true,
      listener: { id: "contributor-laptop", repoCommit: "def456" },
    });

    const listeners = await httpGet(`${baseUrl}/v1/listeners`);
    expect(listeners.status).toBe(200);
    expect(JSON.parse(listeners.body)).toMatchObject({
      ok: true,
      listeners: [{ id: "contributor-laptop" }],
    });

    const job = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "verify",
      requiredCapabilities: ["verify", "staging-db"],
    });

    expect(job.status).toBe(202);
    expect(JSON.parse(job.body)).toMatchObject({
      ok: true,
      job: {
        hostId: "contributor-laptop",
        status: "assigned",
        lease: {
          hostId: "contributor-laptop",
        },
      },
    });
  });

  it("queues worker refresh commands through the worker refresh endpoint", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "verify"],
      maxConcurrentJobs: 1,
      projectPaths: { example: "/tmp/example" },
    });

    const refresh = await httpPost(`${baseUrl}/api/workers/worker-b/refresh`, {
      reason: "post-merge",
      repos: ["quack", "example"],
      branches: { example: "dev" },
      runCapabilityProbes: true,
    });

    expect(refresh.status).toBe(202);
    const body = JSON.parse(refresh.body) as {
      ok: boolean;
      ackPath: string;
      command: {
        kind: string;
        payload: { reason: string; repos: string[]; branches: Record<string, string> };
      };
    };
    expect(body).toMatchObject({
      ok: true,
      ackPath: "/v1/listeners/worker-b/commands/ack",
      command: {
        kind: "worker.refresh",
        payload: {
          reason: "post-merge",
          repos: ["quack", "example"],
          branches: { example: "dev" },
        },
      },
    });

    const commands = await httpGet(`${baseUrl}/v1/listeners/worker-b/commands`);
    expect(commands.status).toBe(200);
    const commandsBody = parseJson<{
      ok: boolean;
      commands: Array<{ kind: string; payload?: { reason?: string } }>;
    }>(commands.body);
    expect(commandsBody.ok).toBe(true);
    expect(commandsBody.commands).toHaveLength(1);
    expect(commandsBody.commands[0]?.kind).toBe("worker.refresh");
    expect(commandsBody.commands[0]?.payload?.reason).toBe("post-merge");
  });

  it("queues scheduler-owned jobs, assigns by listener capability, and renews leases", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "verify"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      priority: 10,
      leaseTtlMs: 60_000,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as {
      job: {
        jobId: string;
        status: string;
        hostId: string;
        lease: { leaseId: string; hostId: string; acquiredAt: string; expiresAt: string };
      };
      scheduler: { assigned: Array<{ jobId: string }> };
    };
    expect(queuedBody.job).toMatchObject({
      status: "assigned",
      hostId: "worker-b",
      lease: { hostId: "worker-b" },
    });
    expect(queuedBody.scheduler.assigned).toEqual([
      expect.objectContaining({ jobId: queuedBody.job.jobId }),
    ]);

    const staleEpoch = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/lease/renew`,
      {
        hostId: "worker-b",
        leaseId: "stale-lease-id",
        leaseTtlMs: 120_000,
      },
    );
    expect(staleEpoch.status).toBe(409);
    expect(staleEpoch.body).toContain("federated_lease_epoch_mismatch");

    const renewed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/lease/renew`,
      {
        hostId: "worker-b",
        leaseId: queuedBody.job.lease.leaseId,
        leaseTtlMs: 120_000,
      },
    );

    expect(renewed.status).toBe(200);
    const renewedBody = JSON.parse(renewed.body) as {
      job: { status: string; hostId: string };
      lease: { leaseId: string; acquiredAt: string; expiresAt: string };
    };
    expect(renewedBody.job).toMatchObject({ status: "assigned", hostId: "worker-b" });
    expect(renewedBody.lease.leaseId).toBe(queuedBody.job.lease.leaseId);
    expect(renewedBody.lease.acquiredAt).toBe(queuedBody.job.lease.acquiredAt);
    expect(Date.parse(renewedBody.lease.expiresAt)).toBeGreaterThan(
      Date.parse(queuedBody.job.lease.expiresAt),
    );
  });

  it("exposes only assigned jobs for a listener host", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      priority: "P1-HIGH",
    });
    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };

    const jobs = await httpGet(`${baseUrl}/v1/listeners/worker-b/jobs`);
    expect(jobs.status).toBe(200);
    expect(JSON.parse(jobs.body)).toMatchObject({
      ok: true,
      hostId: "worker-b",
      jobs: [
        expect.objectContaining({
          jobId: queuedBody.job.jobId,
          taskId: "TASK-838",
          status: "assigned",
          priority: 800,
          priorityLabel: "P1-HIGH",
        }),
      ],
    });
  });

  it("keeps dispatch jobs queued when all capable hosts are at capacity", async () => {
    writeTaskFile(projectRoot, "TASK-839");
    writePassingPrep(projectRoot, "TASK-839");
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "capacity-exclusive"],
      maxConcurrentJobs: 1,
    });

    const first = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      priority: 10,
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(first.status).toBe(202);
    expect(JSON.parse(first.body)).toMatchObject({
      job: { status: "assigned", hostId: "worker-b" },
    });

    const second = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-839",
      jobType: "dispatch",
      priority: 9,
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(second.status).toBe(202);
    const secondBody = JSON.parse(second.body) as {
      job: { status: string; hostId?: string; nextAction: string };
      scheduler: { queuedRemaining: number };
    };
    expect(secondBody).toMatchObject({
      job: {
        status: "queued",
        nextAction: "wait_for_capacity",
      },
      scheduler: {
        queuedRemaining: 1,
      },
    });
    expect(secondBody.job.hostId).toBeUndefined();
  });

  it("auto-assigns the next queued job when a worker completes and frees capacity", async () => {
    writeTaskFile(projectRoot, "TASK-839");
    writePassingPrep(projectRoot, "TASK-839");

    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "capacity-exclusive"],
      maxConcurrentJobs: 1,
    });

    const first = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      priority: 10,
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(first.status).toBe(202);
    const firstBody = JSON.parse(first.body) as { job: { jobId: string } };

    const second = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-839",
      jobType: "dispatch",
      priority: 9,
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(second.status).toBe(202);
    const secondBody = JSON.parse(second.body) as {
      job: { jobId: string; status: string; nextAction: string };
    };
    expect(secondBody.job).toMatchObject({
      status: "queued",
      nextAction: "wait_for_capacity",
    });

    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${firstBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoVerify: false,
        remoteSessionId: "hex-task-838-001",
        message: "Worker finished the first job cleanly.",
      },
    );
    expect(completed.status).toBe(202);
    const completedBody = JSON.parse(completed.body) as {
      scheduler?: { assigned: Array<{ jobId: string; hostId: string; status: string }> };
    };
    expect(completedBody.scheduler?.assigned).toEqual([
      expect.objectContaining({
        jobId: secondBody.job.jobId,
        hostId: "worker-b",
        status: "assigned",
      }),
    ]);

    const refilled = await httpGet(`${baseUrl}/v1/federation/jobs/${secondBody.job.jobId}`);
    expect(refilled.status).toBe(200);
    expect(JSON.parse(refilled.body)).toMatchObject({
      job: {
        jobId: secondBody.job.jobId,
        status: "assigned",
        hostId: "worker-b",
      },
    });
  });

  it("auto-assigns queued work when a listener heartbeat reports capacity returning", async () => {
    writeTaskFile(projectRoot, "TASK-839");
    writePassingPrep(projectRoot, "TASK-839");

    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "capacity-exclusive"],
      maxConcurrentJobs: 1,
    });

    const saturated = await httpPost(`${baseUrl}/v1/listeners/worker-b/heartbeat`, {
      healthy: true,
      currentLoad: 1,
    });
    expect(saturated.status).toBe(200);

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-839",
      jobType: "dispatch",
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as {
      job: { jobId: string; status: string; nextAction: string };
      scheduler: { queuedRemaining: number };
    };
    expect(queuedBody).toMatchObject({
      job: {
        status: "queued",
        nextAction: "wait_for_capacity",
      },
      scheduler: {
        queuedRemaining: 1,
      },
    });

    const regained = await httpPost(`${baseUrl}/v1/listeners/worker-b/heartbeat`, {
      healthy: true,
      currentLoad: 0,
    });
    expect(regained.status).toBe(200);
    const regainedBody = JSON.parse(regained.body) as {
      scheduler?: { assigned: Array<{ jobId: string; hostId: string; status: string }> };
    };
    expect(regainedBody.scheduler?.assigned).toEqual([
      expect.objectContaining({
        jobId: queuedBody.job.jobId,
        hostId: "worker-b",
        status: "assigned",
      }),
    ]);

    const assigned = await httpGet(`${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}`);
    expect(assigned.status).toBe(200);
    expect(JSON.parse(assigned.body)).toMatchObject({
      job: {
        jobId: queuedBody.job.jobId,
        status: "assigned",
        hostId: "worker-b",
      },
    });
  });

  it("requires passing prep evidence before assigning dispatch jobs", async () => {
    fs.rmSync(path.join(projectRoot, ".quack", "prep", "TASK-838.json"), { force: true });
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
    });

    expect(queued.status).toBe(202);
    expect(JSON.parse(queued.body)).toMatchObject({
      job: {
        status: "blocked",
        retryable: true,
        error: "preflight_gate_missing",
        nextAction: "prep_or_preflight",
      },
    });
  });

  it("accepts fresh preflight evidence even when cached prep is stale or failing", async () => {
    writePrep(projectRoot, "TASK-838", 4.1, false);
    writePassingPreflight(projectRoot, "TASK-838");
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
    });

    expect(queued.status).toBe(202);
    expect(JSON.parse(queued.body)).toMatchObject({
      job: {
        status: "assigned",
        hostId: "worker-b",
      },
    });
  });

  it("releases dependency-blocked jobs when the blocker is verified", async () => {
    writeTaskFile(projectRoot, "TASK-100");
    writeTaskFile(projectRoot, "TASK-101", { blockedBy: ["TASK-100"] });
    writePassingPrep(projectRoot, "TASK-101");
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const blocked = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-101",
      jobType: "dispatch",
    });
    expect(blocked.status).toBe(202);
    const blockedBody = JSON.parse(blocked.body) as { job: { jobId: string } };
    expect(JSON.parse(blocked.body)).toMatchObject({
      job: {
        status: "blocked",
        error: "blocked_by_unresolved:TASK-100",
        nextAction: "wait_for_dependencies",
      },
    });

    const verified = await httpPost(`${baseUrl}/api/tasks/TASK-100/verified`, {
      verdict: "VERIFIED",
      verified: "2026-04-28",
      commit: "abc1234",
      method: "api",
      criteria_checked: 1,
      criteria_passed: 1,
    });
    expect(verified.status).toBe(200);
    const verifiedBody = JSON.parse(verified.body) as {
      unblockedJobs: string[];
      scheduler: { assigned: Array<{ jobId: string; status: string; hostId: string }> };
    };
    expect(verifiedBody.unblockedJobs).toEqual([blockedBody.job.jobId]);
    expect(verifiedBody.scheduler.assigned).toEqual([
      expect.objectContaining({
        jobId: blockedBody.job.jobId,
        status: "assigned",
        hostId: "worker-b",
      }),
    ]);

    const job = await httpGet(`${baseUrl}/v1/federation/jobs/${blockedBody.job.jobId}`);
    expect(job.status).toBe(200);
    expect(JSON.parse(job.body)).toMatchObject({
      job: {
        jobId: blockedBody.job.jobId,
        status: "assigned",
        hostId: "worker-b",
      },
    });
    expect((JSON.parse(job.body) as { job: { error?: string } }).job.error).toBeUndefined();
  });

  it("recovers expired leases and reassigns jobs on the next scheduler tick", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      maxRetries: 1,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as {
      job: { jobId: string; lease: Record<string, unknown> };
    };
    const jobPath = path.join(
      projectRoot,
      ".quack",
      "federation",
      "jobs",
      `${queuedBody.job.jobId}.json`,
    );
    const staleRecord = JSON.parse(fs.readFileSync(jobPath, "utf-8")) as Record<string, unknown>;
    staleRecord.lease = {
      ...(staleRecord.lease as Record<string, unknown>),
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(jobPath, JSON.stringify(staleRecord, null, 2), "utf-8");

    const tick = await httpPost(`${baseUrl}/v1/federation/scheduler/tick`, {});
    expect(tick.status).toBe(200);
    const tickBody = JSON.parse(tick.body) as {
      recovered: Array<{ jobId: string; retryCount: number; status: string }>;
      assigned: Array<{ jobId: string; status: string }>;
    };
    expect(tickBody.recovered).toEqual([
      expect.objectContaining({
        jobId: queuedBody.job.jobId,
        retryCount: 1,
        status: "queued",
      }),
    ]);
    expect(tickBody.assigned).toEqual([
      expect.objectContaining({
        jobId: queuedBody.job.jobId,
        status: "assigned",
      }),
    ]);
  });

  it("blocks stale started jobs instead of reassigning them, while still refilling later queued work", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "capacity-exclusive"],
      maxConcurrentJobs: 1,
    });

    writeTaskFile(projectRoot, "TASK-839");
    writePassingPrep(projectRoot, "TASK-839");

    const firstQueued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      maxRetries: 2,
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(firstQueued.status).toBe(202);
    const firstBody = JSON.parse(firstQueued.body) as { job: { jobId: string } };

    const started = await httpPost(`${baseUrl}/v1/federation/jobs/${firstBody.job.jobId}/events`, {
      hostId: "worker-b",
      status: "running",
      remoteSessionId: "remote-session-1",
      message: "worker-b started TASK-838",
    });
    expect(started.status).toBe(202);

    const saturated = await httpPost(`${baseUrl}/v1/listeners/worker-b/heartbeat`, {
      healthy: true,
      currentLoad: 1,
    });
    expect(saturated.status).toBe(200);

    const secondQueued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-839",
      jobType: "dispatch",
      maxRetries: 2,
      requiredCapabilities: ["dispatch", "capacity-exclusive"],
    });
    expect(secondQueued.status).toBe(202);
    const secondBody = JSON.parse(secondQueued.body) as {
      job: { jobId: string; status: string; nextAction: string };
      scheduler: { queuedRemaining: number };
    };
    expect(secondBody.job.status).toBe("queued");
    expect(secondBody.job.nextAction).toBe("wait_for_capacity");
    expect(secondBody.scheduler.queuedRemaining).toBe(1);

    const firstJobPath = path.join(
      projectRoot,
      ".quack",
      "federation",
      "jobs",
      `${firstBody.job.jobId}.json`,
    );
    const staleRecord = JSON.parse(fs.readFileSync(firstJobPath, "utf-8")) as Record<
      string,
      unknown
    >;
    staleRecord.lease = {
      ...(staleRecord.lease as Record<string, unknown>),
      expiresAt: "2000-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(firstJobPath, JSON.stringify(staleRecord, null, 2), "utf-8");

    const tick = await httpPost(`${baseUrl}/v1/federation/scheduler/tick`, {});
    expect(tick.status).toBe(200);
    const tickBody = JSON.parse(tick.body) as {
      recovered: Array<{
        jobId: string;
        status: string;
        hostId?: string;
        error?: string;
        nextAction?: string;
      }>;
      assigned: Array<{ jobId: string; status: string; hostId?: string }>;
    };
    expect(tickBody.recovered).toEqual([
      expect.objectContaining({
        jobId: firstBody.job.jobId,
        status: "blocked",
        hostId: "worker-b",
        error: "lease_expired_after_worker_activity",
        nextAction: "investigate_stale_worker",
      }),
    ]);
    expect(tickBody.assigned).toEqual([]);

    const regained = await httpPost(`${baseUrl}/v1/listeners/worker-b/heartbeat`, {
      healthy: true,
      currentLoad: 0,
    });
    expect(regained.status).toBe(200);
    const regainedBody = JSON.parse(regained.body) as {
      scheduler?: { assigned: Array<{ jobId: string; status: string; hostId?: string }> };
    };
    expect(regainedBody.scheduler?.assigned).toEqual([
      expect.objectContaining({
        jobId: secondBody.job.jobId,
        status: "assigned",
        hostId: "worker-b",
      }),
    ]);

    const recovered = await httpGet(`${baseUrl}/v1/federation/jobs/${firstBody.job.jobId}`);
    expect(recovered.status).toBe(200);
    expect(JSON.parse(recovered.body)).toMatchObject({
      job: {
        jobId: firstBody.job.jobId,
        status: "blocked",
        hostId: "worker-b",
        error: "lease_expired_after_worker_activity",
        nextAction: "investigate_stale_worker",
      },
    });

    const refilled = await httpGet(`${baseUrl}/v1/federation/jobs/${secondBody.job.jobId}`);
    expect(refilled.status).toBe(200);
    expect(JSON.parse(refilled.body)).toMatchObject({
      job: {
        jobId: secondBody.job.jobId,
        status: "assigned",
        hostId: "worker-b",
      },
    });
  });

  it("keeps jobs blocked when no registered host can satisfy required capabilities", async () => {
    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "verify",
      requiredCapabilities: ["verify", "staging-db", "impossible-capability"],
    });

    expect(queued.status).toBe(202);
    expect(JSON.parse(queued.body)).toMatchObject({
      ok: true,
      job: {
        status: "blocked",
        retryable: false,
        blockReasonCode: "pending_remote_listener",
      },
    });
  });

  it("runs automated verification for completed worker jobs and queues bounded fix work on failure", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch", "fix"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      maxRetries: 2,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        message: "Worker finished but verification found a failed gate.",
        verification: {
          requireReview: false,
          criteriaChecked: 2,
          criteriaPassed: 1,
          phaseResults: [
            {
              name: "post_task_checks",
              status: "failed",
              summary: "One required gate failed.",
            },
          ],
        },
      },
    );

    expect(completed.status).toBe(202);
    const body = JSON.parse(completed.body) as {
      job: { status: string; nextAction: string; fixJobIds: string[] };
      orchestration: {
        verification: { verdict: string };
        fixJob: { jobId: string; jobType: string; parentJobId: string; status: string };
      };
    };
    expect(body.job).toMatchObject({
      status: "blocked",
      nextAction: "run_fix_job",
    });
    expect(body.orchestration.verification.verdict).toBe("FAILED");
    expect(body.orchestration.fixJob).toMatchObject({
      jobType: "fix",
      parentJobId: queuedBody.job.jobId,
      status: "queued",
    });
    expect(body.job.fixJobIds).toContain(body.orchestration.fixJob.jobId);
  });

  it("blocks auto-merge until the completed worker job has a merge-ready review", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: true,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        verification: {
          requireReview: true,
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      },
    );

    expect(completed.status).toBe(202);
    expect(JSON.parse(completed.body)).toMatchObject({
      job: {
        status: "blocked",
        blockReasonCode: "review_linkage_required",
        mergeStatus: "blocked",
        nextAction: "record_merge_ready_review",
      },
      orchestration: {
        verification: {
          verdict: "BLOCKED",
        },
      },
    });
  });

  it("fails closed when a worker claims it already merged directly to the target", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: true,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        targetBranch: "dev",
        workerCompletion: {
          canonicalSessionId: "quack-TASK-838-20260505-123000",
          verified: true,
          verificationWorkflowId: "workflow-task-838-worker",
          verificationVerdict: "VERIFIED",
          autoMerged: true,
          mergeTargetBranch: "dev",
          mergeCommitSha: "1234567890abcdef1234567890abcdef12345678",
        },
        verification: {
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      },
    );

    expect(completed.status).toBe(202);
    const body = JSON.parse(completed.body) as {
      job: {
        status: string;
        blockReasonCode?: string;
        mergeStatus: string;
        mergeCommitSha?: string;
        error?: string;
        nextAction: string;
        remoteSessionId: string;
      };
      orchestration: {
        verification?: { verdict: string };
        merge: { ok: boolean; error: string; commands: number };
      };
    };
    expect(body.job).toMatchObject({
      status: "blocked",
      blockReasonCode: "pending_manual_handoff",
      mergeStatus: "failed",
      error: "worker_side_auto_merge_requires_manual_reconciliation",
      nextAction: "manual_merge_recovery",
      remoteSessionId: "quack-TASK-838-20260505-123000",
    });
    expect(body.job.mergeCommitSha).toBeUndefined();
    expect(body.orchestration.verification).toBeUndefined();
    expect(body.orchestration.merge).toMatchObject({
      ok: false,
      error: "worker_side_auto_merge_requires_manual_reconciliation",
    });

    const commands = await httpGet(`${baseUrl}/v1/listeners/worker-b/commands`);
    expect(commands.status).toBe(200);
    const commandBody = parseJson<{
      ok: boolean;
      commands: Array<{
        kind: string;
        taskId?: string;
        payload?: { branches?: Record<string, string>; reason?: string };
      }>;
    }>(commands.body);
    expect(commandBody.ok).toBe(true);
    expect(commandBody.commands).toEqual([]);
  });

  it.each([
    ["events", "missing"],
    ["events", "invalid"],
    ["events", "corrupt-projection"],
    ["reconcile", "missing"],
    ["reconcile", "invalid"],
    ["reconcile", "corrupt-projection"],
  ] as const)("returns a bounded %s refusal for %s verification evidence", async (route, proof) => {
    await registerListener("worker-b");
    const commitSha =
      proof === "missing"
        ? undefined
        : proof === "invalid"
          ? "probe"
          : "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: false,
      ...(commitSha ? { commitSha } : {}),
    });
    expect(queued.status).toBe(202);
    const { job } = parseJson<{ job: FederatedJobRecord }>(queued.body);
    const eventsBody = {
      hostId: "worker-b",
      status: "completed",
      verification: {
        requireReview: route === "reconcile",
        criteriaChecked: 1,
        criteriaPassed: 1,
        phaseResults: [{ name: "tests", status: "passed", summary: "fixture" }],
      },
    };
    if (route === "reconcile") {
      const blocked = await httpPost(
        `${baseUrl}/v1/federation/jobs/${job.jobId}/events`,
        eventsBody,
        "fed-token",
        2_000,
      );
      expect(blocked.status).toBe(202);
      writeMergeReadyReview(projectRoot, "TASK-838", "review-invalid-proof");
    }
    const projectionPath = path.join(projectRoot, ".quack", "verified.json");
    if (proof === "corrupt-projection") fs.writeFileSync(projectionPath, "{broken projection");
    const projectionBefore = fs.readFileSync(projectionPath);
    const expectedStatus = proof === "corrupt-projection" ? 500 : 409;
    const refusal = await httpPost(
      `${baseUrl}/v1/federation/jobs/${job.jobId}/${route}`,
      route === "events" ? eventsBody : {},
      "fed-token",
      2_000,
    );
    expect(refusal.status).toBe(expectedStatus);
    expect(
      parseJson<{ ok: boolean; error: string; jobId: string; taskId: string }>(refusal.body),
    ).toMatchObject({
      ok: false,
      jobId: job.jobId,
      taskId: job.taskId,
      error:
        proof === "corrupt-projection"
          ? "federated_orchestration_failed"
          : "federated_verification_conflict",
    });
    const intentPath = path.join(
      projectRoot,
      ".quack",
      "federation",
      "jobs",
      `.completion-effect-${sha256(job.jobId)}.intent`,
    );
    const intentBefore = fs.readFileSync(intentPath);
    const parentBefore = await loadFederatedJob(projectRoot, job.jobId);
    const replay = await httpPost(
      `${baseUrl}/v1/federation/jobs/${job.jobId}/reconcile`,
      {},
      "fed-token",
      2_000,
    );
    expect(replay.status).toBe(expectedStatus);
    const tick = await httpPost(`${baseUrl}/v1/federation/scheduler/tick`, {}, "fed-token", 2_000);
    expect(tick.status).toBe(proof === "corrupt-projection" ? 500 : 200);
    if (proof !== "corrupt-projection")
      expect(parseJson<{ reconciled: unknown[] }>(tick.body).reconciled).toEqual([]);
    expect(fs.readFileSync(intentPath)).toEqual(intentBefore);
    expect(await loadFederatedJob(projectRoot, job.jobId)).toEqual(parentBefore);
    expect(fs.readFileSync(projectionPath)).toEqual(projectionBefore);
    const database = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    try {
      expect(database.getVerified(job.taskId)).toBeUndefined();
      expect(database.getVerifiedHistory(job.taskId)).toEqual([]);
    } finally {
      database.close();
    }
  });

  it("reconciles a stale review-linkage blocker when a merge-ready review appears", async () => {
    const commitSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: false,
      commitSha,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        branchName: "quack/TASK-838",
        verification: {
          requireReview: true,
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      },
    );

    expect(completed.status).toBe(202);
    const blockedBody = JSON.parse(completed.body) as {
      job: { verificationWorkflowId: string; blockReasonCode: string; status: string };
    };
    expect(blockedBody.job).toMatchObject({
      status: "blocked",
      blockReasonCode: "review_linkage_required",
    });

    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838", commitSha);

    const reconciled = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/reconcile`,
      {},
    );

    expect(reconciled.status).toBe(200);
    const reconciledBody = JSON.parse(reconciled.body) as {
      job: {
        status: string;
        blockReasonCode?: string;
        reviewId: string;
        verificationWorkflowId: string;
      };
      orchestration: { verification: { verdict: string } };
    };
    expect(reconciledBody.job).toMatchObject({
      status: "completed",
      reviewId: "review-task-838",
      verificationWorkflowId: blockedBody.job.verificationWorkflowId,
    });
    expect(reconciledBody.job.blockReasonCode).toBeUndefined();
    expect(reconciledBody.orchestration.verification.verdict).toBe("VERIFIED");

    const verified = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
    ) as { tasks: Record<string, { reviewId: string; workflowId: string; verdict: string }> };
    expect(verified.tasks["TASK-838"]).toMatchObject({
      reviewId: "review-task-838",
      workflowId: blockedBody.job.verificationWorkflowId,
      verdict: "VERIFIED",
    });
  });

  it("scheduler tick reconciles stale review-linkage blockers", async () => {
    const commitSha = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: false,
      commitSha,
    });

    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    await httpPost(`${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`, {
      hostId: "worker-b",
      status: "completed",
      verification: {
        requireReview: true,
        criteriaChecked: 1,
        criteriaPassed: 1,
      },
    });
    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838", commitSha);

    const tick = await httpPost(`${baseUrl}/v1/federation/scheduler/tick`, {});

    expect(tick.status).toBe(200);
    const tickBody = JSON.parse(tick.body) as {
      reconciled: Array<{
        jobId: string;
        status: string;
        reviewId: string;
        blockReasonCode?: string;
      }>;
    };
    expect(tickBody.reconciled).toEqual([
      expect.objectContaining({
        jobId: queuedBody.job.jobId,
        status: "completed",
        reviewId: "review-task-838",
      }),
    ]);
    expect(tickBody.reconciled[0]?.blockReasonCode).toBeUndefined();
  });

  it("auto-merges verified worker branches and records listener pull commands", async () => {
    initGitMergeFixture(projectRoot);
    const commitSha = git(projectRoot, ["rev-parse", "quack/TASK-838"]);
    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838");
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      branchName: "quack/TASK-838",
      targetBranch: "dev",
      reviewId: "review-task-838",
      autoMerge: true,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        commitSha,
        targetBranch: "dev",
        reviewId: "review-task-838",
        verification: {
          requireReview: true,
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      },
    );

    expect(completed.status).toBe(202);
    const body = JSON.parse(completed.body) as {
      job: {
        status: string;
        mergeStatus: string;
        mergeCommitSha: string;
        nextAction: string;
      };
      orchestration: {
        verification: { verdict: string };
        merge: { ok: boolean; commitSha: string; commands: number };
      };
    };
    expect(body.job).toMatchObject({
      status: "completed",
      mergeStatus: "merged",
      nextAction: "hosts_pull_dev",
    });
    expect(body.job.mergeCommitSha).toMatch(/^[0-9a-f]{40}$/);
    expect(body.orchestration.verification.verdict).toBe("VERIFIED");
    expect(body.orchestration.merge.ok).toBe(true);
    expect(body.job).toMatchObject({
      mergeBinding: {
        version: 1,
        repository: {
          host: "github.test",
          owner: "federation-fixture",
          repo: "origin",
        },
        sourceBranch: "quack/TASK-838",
        sourceCommitSha: commitSha,
        targetBranch: "dev",
        publicationNonce: "00000000-0000-4000-8000-000000000001",
      },
    });
    expect(federationMergeCalls).toHaveLength(1);
    expect(federationMergeCalls[0]?.binding.sourceCommitSha).toBe(commitSha);
    expect(git(projectRoot, ["show", "dev:src/fixture.txt"])).toBe("worker change");
    const verified = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
    ) as { tasks: Record<string, { method: string; verdict: string; reviewId: string }> };
    expect(verified.tasks["TASK-838"]).toMatchObject({
      method: "federated-orchestrator",
      verdict: "VERIFIED",
      reviewId: "review-task-838",
    });

    const commands = await httpGet(`${baseUrl}/v1/listeners/worker-b/commands`);
    expect(commands.status).toBe(200);
    const commandBody = parseJson<{
      ok: boolean;
      hostId: string;
      commands: Array<{
        commandId: string;
        kind: string;
        protocolVersion: string;
        taskId?: string;
        payload?: { branches?: Record<string, string>; reason?: string };
      }>;
    }>(commands.body);
    expect(commandBody.ok).toBe(true);
    expect(commandBody.hostId).toBe("worker-b");
    expect(commandBody.commands[0]).toMatchObject({
      kind: "worker.refresh",
      protocolVersion: "worker-command-v1",
      taskId: "TASK-838",
    });
    expect(commandBody.commands[0]?.payload).toMatchObject({
      reason: "post-merge",
    });

    const ack = await httpPost(`${baseUrl}/v1/listeners/worker-b/commands/ack`, {
      commandId: commandBody.commands[0]?.commandId,
    });
    expect(ack.status).toBe(200);
    expect(JSON.parse(ack.body)).toMatchObject({
      ok: true,
      acknowledged: [
        expect.objectContaining({
          commandId: commandBody.commands[0]?.commandId,
          acknowledgedBy: "fed-test",
        }),
      ],
    });

    const pendingCommands = await httpGet(`${baseUrl}/v1/listeners/worker-b/commands`);
    expect(JSON.parse(pendingCommands.body)).toMatchObject({
      ok: true,
      commands: [],
    });
  });

  it("refuses cancellation after exact publication admission and records the eventual receipt", async () => {
    initGitMergeFixture(projectRoot);
    const commitSha = git(projectRoot, ["rev-parse", "quack/TASK-838"]);
    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838");
    let enteredMerge!: () => void;
    let releaseMerge!: () => void;
    const mergeEntered = new Promise<void>((resolve) => {
      enteredMerge = resolve;
    });
    const mergeReleased = new Promise<void>((resolve) => {
      releaseMerge = resolve;
    });
    federationMergeHook = async () => {
      enteredMerge();
      await mergeReleased;
    };
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });
    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      branchName: "quack/TASK-838",
      commitSha,
      targetBranch: "dev",
      reviewId: "review-task-838",
      autoMerge: true,
    });
    const jobId = parseJson<{ job: { jobId: string } }>(queued.body).job.jobId;

    const completion = httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/events`, {
      hostId: "worker-b",
      status: "completed",
      autoMerge: true,
      branchName: "quack/TASK-838",
      commitSha,
      targetBranch: "dev",
      reviewId: "review-task-838",
      verification: { requireReview: true, criteriaChecked: 1, criteriaPassed: 1 },
    });
    await mergeEntered;
    expect(await loadFederatedJob(projectRoot, jobId)).toMatchObject({
      status: "completed",
      mergeStatus: "publishing",
      nextAction: "merge_gate",
      mergeBinding: { sourceCommitSha: commitSha },
    });

    const canceled = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/cancel`, {});
    expect(canceled.status).toBe(409);
    expect(parseJson<{ error: string }>(canceled.body).error).toBe(
      "federated_publication_in_progress",
    );
    releaseMerge();
    expect((await completion).status).toBe(202);
    expect(await loadFederatedJob(projectRoot, jobId)).toMatchObject({
      status: "completed",
      mergeStatus: "merged",
    });
  });

  it("preserves a concurrent durable winner while recording post-merge refresh", async () => {
    initGitMergeFixture(projectRoot);
    const commitSha = git(projectRoot, ["rev-parse", "quack/TASK-838"]);
    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838");
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });
    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      branchName: "quack/TASK-838",
      commitSha,
      targetBranch: "dev",
      reviewId: "review-task-838",
      autoMerge: true,
    });
    const jobId = parseJson<{ job: { jobId: string } }>(queued.body).job.jobId;
    federationRefreshHook = async () => {
      await updateFederatedJob(projectRoot, jobId, (current) => ({
        ...current,
        error: "operator_owned_refresh_state",
        nextAction: "operator_review_refresh",
        updatedAt: new Date().toISOString(),
      }));
    };

    const completed = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/events`, {
      hostId: "worker-b",
      status: "completed",
      autoMerge: true,
      branchName: "quack/TASK-838",
      commitSha,
      targetBranch: "dev",
      reviewId: "review-task-838",
      verification: { requireReview: true, criteriaChecked: 1, criteriaPassed: 1 },
    });

    expect(completed.status).toBe(202);
    expect(parseJson<{ job: FederatedJobRecord }>(completed.body).job).toMatchObject({
      status: "completed",
      mergeStatus: "merged",
      error: "operator_owned_refresh_state",
      nextAction: "operator_review_refresh",
    });
    expect(await loadFederatedJob(projectRoot, jobId)).toMatchObject({
      error: "operator_owned_refresh_state",
      nextAction: "operator_review_refresh",
    });
  });

  it("persists a restartable prepublication checkpoint when the merge lane is busy", async () => {
    initGitMergeFixture(projectRoot);
    const commitSha = git(projectRoot, ["rev-parse", "quack/TASK-838"]);
    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838");
    fs.mkdirSync(path.join(projectRoot, ".quack", "federation"), { recursive: true });
    fs.writeFileSync(
      path.join(projectRoot, ".quack", "federation", "merge.lock"),
      JSON.stringify({ jobId: "existing-merge", taskId: "TASK-000" }),
      "utf-8",
    );
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      branchName: "quack/TASK-838",
      targetBranch: "dev",
      reviewId: "review-task-838",
      autoMerge: true,
    });

    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        commitSha,
        targetBranch: "dev",
        reviewId: "review-task-838",
        verification: {
          requireReview: true,
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      },
    );

    expect(completed.status).toBe(202);
    const blocked = parseJson<{ job: FederatedJobRecord; orchestration: unknown }>(completed.body);
    expect(blocked).toMatchObject({
      orchestration: {
        merge: { ok: false, error: "merge_lane_busy" },
      },
    });
    expect(blocked.job.mergeError).toBeUndefined();
    expect(blocked.job.mergeBinding).toBeUndefined();
    expect(blocked.job).toMatchObject({
      status: "completed",
      autoMerge: true,
      branchName: "quack/TASK-838",
      commitSha,
      targetBranch: "dev",
      nextAction: "merge_gate",
    });
    expect(federationMergeCalls).toHaveLength(0);

    fs.unlinkSync(path.join(projectRoot, ".quack", "federation", "merge.lock"));
    const tick = await httpPost(`${baseUrl}/v1/federation/scheduler/tick`, {});
    expect(tick.status).toBe(200);
    expect(await loadFederatedJob(projectRoot, queuedBody.job.jobId)).toMatchObject({
      status: "completed",
      mergeStatus: "merged",
    });
    expect(federationMergeCalls).toHaveLength(1);
  });

  it("reclaims a stale federation merge lock and completes the sealed merge", async () => {
    const diagnostic = createStaleMergeDiagnostic(projectRoot, quackRoot);
    staleMergeDiagnostic = diagnostic;
    try {
      diagnostic.record("fixture.git.started");
      initGitMergeFixture(projectRoot);
      diagnostic.record("fixture.git.completed");
      const commitSha = git(projectRoot, ["rev-parse", "quack/TASK-838"]);
      diagnostic.record("review.started", { commitSha });
      writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838");
      diagnostic.record("review.completed");
      const lockPath = path.join(projectRoot, ".quack", "federation", "merge.lock");
      fs.mkdirSync(path.dirname(lockPath), { recursive: true });
      fs.writeFileSync(
        lockPath,
        JSON.stringify({
          version: 1,
          jobId: "interrupted-job",
          taskId: "TASK-000",
          ownerToken: "00000000-0000-4000-8000-000000000099",
          processId: 999999,
          acquiredAt: "2020-01-01T00:00:00.000Z",
        }),
        "utf-8",
      );
      const staleTime = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(lockPath, staleTime, staleTime);
      diagnostic.record("stale-lock.created", { lockPath });
      diagnostic.record("listener.register.started");
      const registered = await httpPost(`${baseUrl}/v1/listeners/register`, {
        hostId: "worker-b",
        capabilities: ["dispatch"],
        maxConcurrentJobs: 1,
      });
      diagnostic.record("listener.register.completed", {
        status: registered.status,
        body: registered.body,
      });
      diagnostic.record("queue.started");
      const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
        taskId: "TASK-838",
        jobType: "dispatch",
        branchName: "quack/TASK-838",
        commitSha,
        targetBranch: "dev",
        reviewId: "review-task-838",
        autoMerge: true,
      });
      diagnostic.record("queue.completed", {
        status: queued.status,
        body: queued.body,
      });
      const jobId = parseJson<{ job: { jobId: string } }>(queued.body).job.jobId;

      diagnostic.record("completion.started", { jobId });
      const completed = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/events`, {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        commitSha,
        targetBranch: "dev",
        reviewId: "review-task-838",
        verification: {
          requireReview: true,
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      });

      diagnostic.record("completion.response", {
        status: completed.status,
        body: completed.body,
      });
      diagnostic.record("assertions.started");
      expect(completed.status).toBe(202);
      expect(parseJson<{ job: FederatedJobRecord }>(completed.body).job).toMatchObject({
        status: "completed",
        mergeStatus: "merged",
        commitSha,
      });
      expect(fs.existsSync(lockPath)).toBe(false);
      diagnostic.record("assertions.completed");
      diagnostic.passed = true;
    } catch (error) {
      diagnostic.record("test.failed", { error: String(error) });
      throw error;
    }
  }, 30_000);

  it.each([
    ["branchName", "quack/TASK-OTHER"],
    ["branchName", "Quack/TASK-838"],
    ["commitSha", "2222222222222222222222222222222222222222"],
    ["targetBranch", "main"],
    ["targetBranch", "DEV"],
  ] as const)("rejects a worker attempt to replace recorded %s", async (field, replacement) => {
    const recordedCommit = "1111111111111111111111111111111111111111";
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });
    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      branchName: "quack/TASK-838",
      commitSha: recordedCommit,
      targetBranch: "dev",
      autoMerge: false,
    });
    const jobId = parseJson<{ job: { jobId: string } }>(queued.body).job.jobId;
    const completed = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/events`, {
      hostId: "worker-b",
      status: "completed",
      autoMerge: false,
      branchName: "quack/TASK-838",
      commitSha: recordedCommit,
      targetBranch: "dev",
      [field]: replacement,
      verification: { requireReview: false, criteriaChecked: 1, criteriaPassed: 1 },
    });

    expect(completed.status).toBe(409);
    expect(parseJson<{ error: string }>(completed.body).error).toBe(
      "federated_publication_identity_mismatch",
    );
    const persisted = await loadFederatedJob(projectRoot, jobId);
    expect(persisted?.branchName).toBe("quack/TASK-838");
    expect(persisted?.commitSha).toBe(recordedCommit);
    expect(persisted?.targetBranch).toBe("dev");
    expect(federationMergeCalls).toHaveLength(0);
  });

  it("refuses a moved source branch before federation auto-merge", async () => {
    initGitMergeFixture(projectRoot);
    const reportedCommit = git(projectRoot, ["rev-parse", "quack/TASK-838"]);
    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838");
    git(projectRoot, ["checkout", "quack/TASK-838"]);
    fs.appendFileSync(path.join(projectRoot, "src", "fixture.txt"), "moved branch\n", "utf-8");
    git(projectRoot, ["add", "src/fixture.txt"]);
    git(projectRoot, ["commit", "-m", "advance task branch after completion"]);
    git(projectRoot, ["checkout", "dev"]);

    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });
    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      branchName: "quack/TASK-838",
      commitSha: reportedCommit,
      targetBranch: "dev",
      reviewId: "review-task-838",
      autoMerge: true,
    });
    const jobId = parseJson<{ job: { jobId: string } }>(queued.body).job.jobId;

    const completed = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/events`, {
      hostId: "worker-b",
      status: "completed",
      autoMerge: true,
      branchName: "quack/TASK-838",
      commitSha: reportedCommit,
      targetBranch: "dev",
      reviewId: "review-task-838",
      verification: {
        requireReview: true,
        criteriaChecked: 1,
        criteriaPassed: 1,
      },
    });

    expect(completed.status).toBe(202);
    expect(parseJson<{ job: FederatedJobRecord }>(completed.body).job).toMatchObject({
      status: "blocked",
      mergeStatus: "failed",
      nextAction: "manual_merge_recovery",
    });
    expect(parseJson<{ job: FederatedJobRecord }>(completed.body).job.mergeError).toContain(
      "source branch changed",
    );
    expect(federationMergeCalls).toHaveLength(0);
    expect(fs.existsSync(path.join(projectRoot, ".quack", "federation", "merge.lock"))).toBe(false);
    expect(git(projectRoot, ["show", "dev:src/fixture.txt"])).toBe("base");
  });

  it("refuses an ambiguous or changed federation push destination", async () => {
    initGitMergeFixture(projectRoot);
    const reportedCommit = git(projectRoot, ["rev-parse", "quack/TASK-838"]);
    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838");
    git(projectRoot, [
      "config",
      "--add",
      "remote.origin.pushurl",
      "https://github.test/attacker/redirect.git",
    ]);

    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });
    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      branchName: "quack/TASK-838",
      commitSha: reportedCommit,
      targetBranch: "dev",
      reviewId: "review-task-838",
      autoMerge: true,
    });
    const jobId = parseJson<{ job: { jobId: string } }>(queued.body).job.jobId;

    const completed = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/events`, {
      hostId: "worker-b",
      status: "completed",
      autoMerge: true,
      branchName: "quack/TASK-838",
      commitSha: reportedCommit,
      targetBranch: "dev",
      reviewId: "review-task-838",
      verification: {
        requireReview: true,
        criteriaChecked: 1,
        criteriaPassed: 1,
      },
    });

    expect(completed.status).toBe(202);
    expect(parseJson<{ job: FederatedJobRecord }>(completed.body).job.mergeError).toContain(
      "push destination changed",
    );
    expect(federationMergeCalls).toHaveLength(0);
    expect(git(projectRoot, ["show", "dev:src/fixture.txt"])).toBe("base");
  });

  it("recovers a post-push interruption before re-running mutable verification", async () => {
    initGitMergeFixture(projectRoot);
    const commitSha = git(projectRoot, ["rev-parse", "quack/TASK-838"]);
    writeMergeReadyReview(projectRoot, "TASK-838", "review-task-838");
    federationMergeFailureAfterPush = "trusted_git_post_execution_attestation_failed";

    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });
    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      branchName: "quack/TASK-838",
      commitSha,
      targetBranch: "dev",
      reviewId: "review-task-838",
      autoMerge: true,
    });
    const jobId = parseJson<{ job: { jobId: string } }>(queued.body).job.jobId;
    const failed = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/events`, {
      hostId: "worker-b",
      status: "completed",
      autoMerge: true,
      branchName: "quack/TASK-838",
      commitSha,
      targetBranch: "dev",
      reviewId: "review-task-838",
      verification: {
        requireReview: true,
        criteriaChecked: 1,
        criteriaPassed: 1,
      },
    });

    expect(failed.status).toBe(202);
    const failedJob = parseJson<{ job: FederatedJobRecord }>(failed.body).job;
    expect(failedJob.mergeBinding).toMatchObject({
      sourceBranch: "quack/TASK-838",
      sourceCommitSha: commitSha,
      targetBranch: "dev",
    });
    expect(failedJob).toMatchObject({
      status: "completed",
      mergeStatus: "publishing",
      nextAction: "merge_gate",
    });
    expect(failedJob.error).toContain("publication_recovery_pending");
    expect(fs.existsSync(path.join(projectRoot, ".quack", "federation", "merge.lock"))).toBe(false);
    expect(git(projectRoot, ["show", "dev:src/fixture.txt"])).toBe("worker change");

    const canceled = await httpPost(`${baseUrl}/v1/federation/jobs/${jobId}/cancel`, {});
    expect(canceled.status).toBe(409);
    expect(parseJson<{ error: string }>(canceled.body).error).toBe(
      "federated_publication_in_progress",
    );

    federationMergeFailureAfterPush = undefined;
    fs.rmSync(path.join(projectRoot, ".quack", "reviews"), { recursive: true, force: true });
    const tick = await httpPost(`${baseUrl}/v1/federation/scheduler/tick`, {});
    expect(tick.status).toBe(200);
    const recovered = await loadFederatedJob(projectRoot, jobId);
    expect(recovered).toMatchObject({
      status: "completed",
      mergeStatus: "merged",
      mergeBinding: {
        sealedAt: failedJob.mergeBinding?.sealedAt,
        sourceCommitSha: commitSha,
      },
    });
    expect(federationMergeCalls).toHaveLength(2);
    expect(federationMergeCalls[1]?.binding.sealedAt).toBe(failedJob.mergeBinding?.sealedAt);
  });

  it("accepts an external Hermes completion and records canonical verified state", async () => {
    initGitMergeFixture(projectRoot);
    const commitSha = git(projectRoot, ["rev-parse", "quack/TASK-838"]);

    const resp = await httpPost(`${baseUrl}/v1/federation/external-completions`, {
      taskId: "TASK-838",
      source: "hermes",
      sourceCardId: "t_d1821fd2",
      branchName: "quack/TASK-838",
      commitSha,
      baseBranch: "dev",
      targetBranch: "dev",
      worktreePath:
        "C:/Users/Example/Desktop/GitHub/example-org/example-service/.hermes-worktrees/TASK-838",
      verificationClass: "fast-required",
      autoVerify: true,
      autoMerge: false,
      maxFixAttempts: 0,
      docsImpact: "none",
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [
        {
          name: "hermes_local_validation",
          status: "passed",
          summary: "Hermes validation chat checked the task diff and focused tests.",
        },
      ],
      evidence: [
        {
          kind: "command",
          command:
            "npm --prefix src test -- --runTestsByPath tests/unit/example.test.js --runInBand",
          outcome: "passed",
        },
      ],
    });

    expect(resp.status).toBe(202);
    const body = JSON.parse(resp.body) as {
      job: {
        jobId: string;
        taskId: string;
        hostId: string;
        status: string;
        branchName: string;
        targetBranch: string;
        reviewId: string;
        nextAction: string;
        decision: { source: string; sourceCardId: string; verificationClass: string };
        evidence: Array<{ kind: string; command: string; outcome: string }>;
      };
      review: { reviewId: string; mergeReady: boolean };
      orchestration: { verification: { verdict: string } };
    };
    expect(body.job).toMatchObject({
      taskId: "TASK-838",
      hostId: "external:hermes",
      status: "completed",
      branchName: "quack/TASK-838",
      targetBranch: "dev",
      nextAction: "admin_review_merge",
      decision: {
        source: "hermes",
        sourceCardId: "t_d1821fd2",
        verificationClass: "fast-required",
      },
      evidence: [expect.objectContaining({ kind: "command", outcome: "passed" })],
    });
    expect(body.review.mergeReady).toBe(true);
    expect(body.job.reviewId).toBe(body.review.reviewId);
    expect(body.orchestration.verification.verdict).toBe("VERIFIED");

    const verified = JSON.parse(
      fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
    ) as {
      tasks: Record<string, { method: string; verdict: string; reviewId: string; commit: string }>;
    };
    expect(verified.tasks["TASK-838"]).toMatchObject({
      method: "federated-orchestrator",
      verdict: "VERIFIED",
      reviewId: body.review.reviewId,
      commit: commitSha,
    });

    const sessionEvents = readSessionEvents(projectRoot, `federation-${body.job.jobId}`);
    expect(sessionEvents.map((event) => event.stage)).toEqual(
      expect.arrayContaining([
        "judgment_evaluation",
        "judgment_decision",
        "session_start",
        "agent_progress_update",
        "lifecycle_verify_result",
        "session_complete",
      ]),
    );
    const persistedReview = JSON.parse(
      fs.readFileSync(
        path.join(projectRoot, ".quack", "reviews", `${body.review.reviewId}.json`),
        "utf-8",
      ),
    ) as {
      gate: {
        judgmentDecision: Record<string, unknown>;
        judgmentOrchestration: { activeDecision: Record<string, unknown> };
      };
    };
    expect(persistedReview.gate.judgmentDecision).toEqual(
      persistedReview.gate.judgmentOrchestration.activeDecision,
    );
    expect(sessionEvents.find((event) => event.stage === "judgment_decision")?.payload).toEqual(
      expect.objectContaining({
        decision: persistedReview.gate.judgmentOrchestration.activeDecision,
      }),
    );
    expect(sessionEvents.find((event) => event.stage === "session_start")).toMatchObject({
      payload: {
        taskId: "TASK-838",
        jobId: body.job.jobId,
        hostId: "external:hermes",
        remoteSessionId: "t_d1821fd2",
        federated: true,
      },
    });
    expect(sessionEvents.find((event) => event.stage === "agent_progress_update")).toMatchObject({
      payload: {
        taskId: "TASK-838",
        jobId: body.job.jobId,
        hostId: "external:hermes",
        source: "hermes",
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        rawContent: expect.stringContaining("Hermes"),
      },
    });
    expect(sessionEvents.find((event) => event.stage === "session_complete")).toMatchObject({
      payload: {
        taskId: "TASK-838",
        jobId: body.job.jobId,
        hostId: "external:hermes",
        workflowState: "reviewing",
      },
    });
  });

  it("rejects an external Hermes completion when Headnode cannot resolve the branch", async () => {
    initGitMergeFixture(projectRoot);
    const resp = await httpPost(`${baseUrl}/v1/federation/external-completions`, {
      taskId: "TASK-838",
      source: "hermes",
      branchName: "echo/TASK-838-missing",
      commitSha: "abc1234",
      targetBranch: "dev",
      verificationClass: "fast-required",
      autoVerify: true,
      autoMerge: true,
      docsImpact: "none",
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [
        {
          name: "hermes_local_validation",
          status: "passed",
          summary: "Local validation passed, but the branch is not available to Headnode.",
        },
      ],
      evidence: [],
    });

    expect(resp.status).toBe(409);
    expect(JSON.parse(resp.body)).toMatchObject({
      ok: false,
      error: "branch_not_fetchable",
      branchName: "echo/TASK-838-missing",
      targetBranch: "dev",
    });
    if (fs.existsSync(path.join(projectRoot, ".quack", "verified.json"))) {
      const verified = JSON.parse(
        fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
      ) as { tasks?: Record<string, unknown> };
      expect(verified.tasks?.["TASK-838"]).toBeUndefined();
    }
  });

  it("blocks an external Hermes completion when validation evidence reports a failed phase", async () => {
    initGitMergeFixture(projectRoot);
    const commitSha = git(projectRoot, ["rev-parse", "quack/TASK-838"]);
    const resp = await httpPost(`${baseUrl}/v1/federation/external-completions`, {
      taskId: "TASK-838",
      source: "hermes",
      branchName: "quack/TASK-838",
      commitSha,
      targetBranch: "dev",
      verificationClass: "fast-required",
      autoVerify: true,
      autoMerge: true,
      maxFixAttempts: 0,
      docsImpact: "none",
      criteriaChecked: 1,
      criteriaPassed: 0,
      phaseResults: [
        {
          name: "hermes_local_validation",
          status: "failed",
          summary: "Focused regression test failed.",
        },
      ],
      evidence: [
        {
          kind: "command",
          command:
            "npm --prefix src test -- --runTestsByPath tests/unit/example.test.js --runInBand",
          outcome: "failed",
        },
      ],
    });

    expect(resp.status).toBe(202);
    expect(JSON.parse(resp.body)).toMatchObject({
      job: {
        status: "blocked",
        mergeStatus: "not_requested",
        error: "verification_failed_fix_budget_exhausted",
        nextAction: "manual_handoff",
      },
      orchestration: {
        verification: { verdict: "FAILED" },
      },
    });
    if (fs.existsSync(path.join(projectRoot, ".quack", "verified.json"))) {
      const verified = JSON.parse(
        fs.readFileSync(path.join(projectRoot, ".quack", "verified.json"), "utf-8"),
      ) as { tasks?: Record<string, unknown> };
      expect(verified.tasks?.["TASK-838"]).toBeUndefined();
    }
  });

  it("auto-merges an external Hermes completion through Headnode when validation and gates pass", async () => {
    initGitMergeFixture(projectRoot);
    const commitSha = git(projectRoot, ["rev-parse", "quack/TASK-838"]);

    const resp = await httpPost(`${baseUrl}/v1/federation/external-completions`, {
      taskId: "TASK-838",
      source: "hermes",
      sourceCardId: "t_d1821fd2",
      branchName: "quack/TASK-838",
      commitSha,
      targetBranch: "dev",
      verificationClass: "fast-required",
      autoVerify: true,
      autoMerge: true,
      maxFixAttempts: 0,
      docsImpact: "none",
      criteriaChecked: 1,
      criteriaPassed: 1,
      phaseResults: [
        {
          name: "hermes_local_validation",
          status: "passed",
          summary: "Separate Hermes validation chat passed the task.",
        },
      ],
      evidence: [],
    });

    expect(resp.status).toBe(202);
    const body = JSON.parse(resp.body) as {
      job: { status: string; mergeStatus: string; mergeCommitSha: string; nextAction: string };
      orchestration: { merge: { ok: boolean; commitSha: string } };
    };
    expect(body.job.status).toBe("completed");
    expect(body.job.mergeStatus).toBe("merged");
    expect(body.job.nextAction).toMatch(/hosts_pull_dev|merged_no_registered_hosts/);
    expect(body.orchestration.merge.ok).toBe(true);
    expect(body.job.mergeCommitSha).toBe(body.orchestration.merge.commitSha);
    expect(git(projectRoot, ["rev-parse", "dev"])).toBe(body.job.mergeCommitSha);
  });

  it("issues scoped listener invite tokens for worker registration", async () => {
    const invite = await httpPost(`${baseUrl}/v1/listeners/invites`, {
      tokenId: "contributor-worker-token",
      scopes: ["listener:register", "listener:heartbeat", "federation:write"],
    });

    expect(invite.status).toBe(201);
    const inviteBody = JSON.parse(invite.body) as { token: string; scopes: string[] };
    expect(inviteBody.token).toMatch(/^qsvc_/);
    expect(inviteBody.scopes).toEqual([
      "federation:write",
      "listener:heartbeat",
      "listener:register",
    ]);

    const registered = await httpPost(
      `${baseUrl}/v1/listeners/register`,
      {
        hostId: "worker-b",
        capabilities: ["dispatch", "verify"],
      },
      inviteBody.token,
    );

    expect(registered.status).toBe(201);
    expect(JSON.parse(registered.body)).toMatchObject({
      listener: {
        id: "worker-b",
        registeredBy: "contributor-worker-token",
      },
    });
  });

  it("returns structured host_unhealthy failures and projects blocked state", async () => {
    const resp = await httpPost(`${baseUrl}/v1/federation/jobs`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      hosts: [
        {
          id: "worker-b",
          capabilities: ["dispatch"],
          enabled: true,
          healthy: false,
        },
      ],
    });

    expect(resp.status).toBe(409);
    expect(JSON.parse(resp.body)).toMatchObject({
      ok: false,
      retryable: true,
      blockReasonCode: "host_unhealthy",
      projection: {
        state: "blocked",
        blockReasonCode: "host_unhealthy",
      },
    });
  });

  it("never treats worker completion booleans as a trusted merge receipt", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: true,
    });
    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };

    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        targetBranch: "dev",
        workerCompletion: {
          canonicalSessionId: "quack-TASK-838-wc-test",
          verified: true,
          verificationVerdict: "VERIFIED",
          verificationWorkflowId: "wf-wc-test",
          autoMerged: true,
          mergeTargetBranch: "dev",
          mergeCommitSha: "aabbccddeeff00112233445566778899aabbccdd",
        },
        verification: {
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
      },
    );

    expect(completed.status).toBe(202);
    const body = JSON.parse(completed.body) as {
      job: {
        status: string;
        nextAction: string;
        mergeStatus: string;
        blockReasonCode?: string;
        mergeCommitSha?: string;
        error?: string;
      };
      orchestration: {
        verification?: { verdict: string };
        merge: { ok: boolean; error: string };
      };
    };
    expect(body.job).toMatchObject({
      status: "blocked",
      blockReasonCode: "pending_manual_handoff",
      mergeStatus: "failed",
      error: "worker_side_auto_merge_requires_manual_reconciliation",
      nextAction: "manual_merge_recovery",
    });
    expect(body.job.mergeCommitSha).toBeUndefined();
    expect(body.orchestration.verification).toBeUndefined();
    expect(body.orchestration.merge).toMatchObject({
      ok: false,
      error: "worker_side_auto_merge_requires_manual_reconciliation",
    });
  });

  it("routes completed job without workerCompletion to a verification pass, not immediate merged state", async () => {
    await httpPost(`${baseUrl}/v1/listeners/register`, {
      hostId: "worker-b",
      capabilities: ["dispatch"],
      maxConcurrentJobs: 1,
    });

    const queued = await httpPost(`${baseUrl}/v1/federation/queue`, {
      taskId: "TASK-838",
      jobType: "dispatch",
      autoMerge: true,
    });
    expect(queued.status).toBe(202);
    const queuedBody = JSON.parse(queued.body) as { job: { jobId: string } };

    // Post completed with requireReview=true and NO workerCompletion
    const completed = await httpPost(
      `${baseUrl}/v1/federation/jobs/${queuedBody.job.jobId}/events`,
      {
        hostId: "worker-b",
        status: "completed",
        autoMerge: true,
        branchName: "quack/TASK-838",
        verification: {
          requireReview: true,
          criteriaChecked: 1,
          criteriaPassed: 1,
        },
        // no workerCompletion field → orchestrator must run its own verify/review cycle
      },
    );

    expect(completed.status).toBe(202);
    const body = JSON.parse(completed.body) as {
      job: {
        status: string;
        mergeStatus?: string;
        nextAction: string;
        blockReasonCode?: string;
      };
    };
    // Without workerCompletion the orchestrator runs its own verify logic and
    // blocks on review linkage — job must NOT be immediately merged
    expect(body.job.status).not.toBe("completed");
    expect(body.job.mergeStatus).not.toBe("merged");
    // The job should be blocked waiting for a review to link or blocked on some gate
    expect(["blocked", "failed"].some((s) => s === body.job.status)).toBe(true);
  });
});
