import { computeSchemaPolicyHash, DEFAULT_SCHEMA_POLICY_HASH } from "../../src/gate/schema-policy";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { loadAdapter } from "../../src/core/adapter-loader";
import type { PreflightResult } from "../../src/preflight/preflight-types";
import { createMonitorServer } from "../../src/monitor/server";
import { generateProjectId } from "../../src/monitor/project-registry";
import { EventReader } from "../../src/monitor/event-reader";
import type { QuackEvent } from "../../src/monitor/event-types";
import { PrepJobStore } from "../../src/monitor/prep-job-store";
import { PrepCache, computeContentHash } from "../../src/monitor/prep-cache";
import { ListenerRegistry } from "../../src/federation/listener-registry";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs";
import { loadFederatedJob, saveFederatedJob } from "../../src/monitor/federation/store";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "fixture", sessionTtlMs: 86400000 }),
}));

describe.each(["embedded", "legacy", "registered"] as const)("%s prep completion wakes current federation prerequisites", (mode) => {
  let root: string;
  let stop: (() => Promise<void>) | undefined;
  let callback: ((event: QuackEvent) => void | Promise<void>) | undefined;
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-prep-refill-"));
    fs.mkdirSync(path.join(root, "docs/tasks"), { recursive: true });
    fs.mkdirSync(path.join(root, ".quack/logs"), { recursive: true });
    fs.copyFileSync(
      path.join(__dirname, "../fixtures/task-valid-minimal.md"),
      path.join(root, "docs/tasks/TASK-001.md"),
    );
    // Only filesystem delivery is replaced. The real server callback, current
    // cache reader, declaration scanner, job fence and scheduler all execute.
    jest.spyOn(EventReader.prototype, "watch").mockImplementation(function (this: EventReader, onEvent) {
      if (path.resolve(this.logDir) === path.join(root, ".quack/logs")) callback = onEvent;
      return Promise.resolve(() => Promise.resolve());
    });
  });
  afterEach(async () => {
    jest.restoreAllMocks();
    try {
      if (stop) await stop();
      fs.rmSync(root, { recursive: true, force: true });
    } finally {
      stop = undefined;
      callback = undefined;
    }
  });
  it.each([[false, "prep"], [true, "prep"], [false, "preflight"], [true, "preflight"]] as const)(
    "uses persisted prep completion only as a wake-up (rejected=%s, evidence=%s)",
    async (rejected, evidence) => {
      const projectId = generateProjectId(root);
      const logDir = path.join(root, ".quack/logs");
      const queued = queueFederatedJobRecord({
        projectId,
        taskId: "TASK-001",
        jobType: "dispatch",
        requiredCapabilities: ["dispatch"],
        preferredHostId: "worker",
        provenance: { channel: "federation-queue", tokenId: "fixture" },
      });
      await saveFederatedJob(root, {
        ...queued,
        status: "blocked",
        error: "preflight_gate_missing",
        nextAction: "prep_or_preflight",
        retryable: true,
        blockReasonCode: "pending_manual_handoff",
      });
      await new ListenerRegistry(root).register({
        hostId: "worker",
        capabilities: ["dispatch"],
        maxConcurrentJobs: 1,
      });
      const adapterPath = path.join(root, ".quack/adapter.json");
      if (mode !== "embedded") {
        const adapter = JSON.parse(fs.readFileSync(path.join(__dirname,
          "../fixtures/adapters/gate-required-sections/.quack/adapter.json"), "utf8")) as Record<string, unknown>;
        adapter.project = { ...(adapter.project as Record<string, unknown>), name: root };
        adapter.judgment = { stages: { readiness: { mode: "shadow" } } };
        fs.writeFileSync(adapterPath, JSON.stringify(adapter));
      }
      const runtime = await createMonitorServer(mode === "registered" ? {
        projectAdapters: [await loadAdapter(root)], host: "127.0.0.1", port: 0,
      } : {
        projectRoot: root, taskDir: "docs/tasks", logDir,
        ...(mode === "legacy" ? { adapterPath } : {}),
        host: "127.0.0.1", port: 0,
      }).start();
      stop = runtime.stop;
      const result = {
        schemaPolicyHash: mode === "embedded" ? DEFAULT_SCHEMA_POLICY_HASH : computeSchemaPolicyHash(["filesToModify"]),
        schemaValid: true,
        schemaErrors: [],
        depthScore: rejected ? 4.0 : 4.9,
        depthReady: !rejected,
        deficiencies: [],
        outcome: rejected ? ("rejected" as const) : ("pass" as const),
        contentHash: computeContentHash(
          fs.readFileSync(path.join(root, "docs/tasks/TASK-001.md"), "utf-8"),
        ),
      };
      const now = new Date().toISOString();
      const cache = new PrepCache(root);
      if (evidence === "prep") {
        await cache.write({ ...result, taskId: "TASK-001", preparedAt: now });
      } else {
        const preflight: PreflightResult = {
          taskId: "TASK-001", timestamp: now, contentHash: result.contentHash,
          schemaPolicyHash: result.schemaPolicyHash,
          gate: { ready: !rejected, score: rejected ? 4 : 4.9, dimensions: {}, readinessJudgmentMode: mode === "embedded" ? "off" : "shadow" },
          blueprint: { fileAnalyses: 0, codeExamples: 0, verificationPatterns: 0, antiPatterns: 0, formattedMarkdown: "fixture" },
          complexity: { filesToModify: 0, successCriteria: 1, estimatedContextTokens: 0, independentFeatures: 1, featureClusters: [], recommendDecomposition: false, reason: "fixture" },
          contextEstimate: { taskSpec: 0, blueprint: 0, repoMap: 0, relevantFiles: 0, relatedPatterns: 0, existingTests: 0, conventions: 0, claudeMd: 0, total: 0, withinBudget: true },
        };
        await cache.writePreflight(preflight);
      }
      const jobId = randomUUID();
      new PrepJobStore(logDir, projectId).write({
        jobId,
        taskId: "TASK-001",
        pid: 42,
        startedAt: now,
        completedAt: now,
        status: "completed",
        exitCode: 0,
        signal: null,
        result,
        diagnostics: {
          stdout: JSON.stringify(result),
          stderr: "",
          stdoutTruncated: false,
          stderrTruncated: false,
        },
      });
      const event = JSON.parse(
        fs.readFileSync(path.join(logDir, `events-prep-${jobId}.jsonl`), "utf-8"),
      ) as QuackEvent;
      if (!callback) throw new Error("Server did not register its event watcher");
      await callback(event);
      if (!rejected) expect((await loadFederatedJob(root, queued.jobId))?.error).toBeUndefined();
      else expect(await loadFederatedJob(root, queued.jobId)).toMatchObject({
        error: "preflight_gate_failed:4.0", nextAction: "enrich_and_reprep",
      });
      expect(await loadFederatedJob(root, queued.jobId)).toMatchObject({
        status: rejected ? "blocked" : "assigned",
      });
      if (!rejected) expect((await loadFederatedJob(root, queued.jobId))?.hostId).toBe("worker");
    },
  );
});
