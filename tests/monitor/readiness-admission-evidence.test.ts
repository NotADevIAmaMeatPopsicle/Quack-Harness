import { DEFAULT_SCHEMA_POLICY_HASH } from "../../src/gate/schema-policy";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { QuackDB } from "../../src/db";
import { EventReader } from "../../src/monitor/event-reader";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs";
import { evaluateFederatedSchedulingGate } from "../../src/monitor/federation/scheduling";
import type { FederationProjectContext } from "../../src/monitor/federation/types";
import { PrepCache, computeContentHash, type PrepResult } from "../../src/monitor/prep-cache";
import { ReadinessService } from "../../src/monitor/readiness-service";
import { TaskService } from "../../src/monitor/task-service";
import type { PreflightResult } from "../../src/preflight/preflight-types";
import { taskSpec } from "../helpers/divergent-task-fixture";

describe("independent readiness admission evidence", () => {
  let root: string;
  let db: QuackDB;
  let cache: PrepCache;
  let service: ReadinessService;
  let project: FederationProjectContext;
  const taskId = "TASK-1352";
  const content = taskSpec(taskId);
  const hash = computeContentHash(content);
  const job = queueFederatedJobRecord({
    projectId: "fixture",
    taskId,
    jobType: "dispatch",
    requiredCapabilities: ["dispatch"],
    provenance: { channel: "federation-queue" },
  });

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-admission-evidence-"));
    fs.mkdirSync(path.join(root, ".quack"));
    fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "tasks", `${taskId}.md`), content);
    db = new QuackDB(path.join(root, ".quack", "quack.db"));
    cache = new PrepCache(root);
    project = {
      projectId: "fixture",
      projectRoot: root,
      taskService: new TaskService(root, "docs/tasks"),
      prepCache: cache,
      reader: new EventReader(path.join(root, ".quack", "logs")),
      db,
    };
    service = new ReadinessService({ ...project, projectRoot: root });
  });

  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function prep(): Omit<PrepResult, "stale"> {
    return {
      taskId,
      preparedAt: "2026-09-12T23:00:00.000Z",
      schemaValid: true,
      schemaErrors: [],
      depthScore: 4.9,
      depthReady: true,
      deficiencies: [],
      outcome: "pass",
      contentHash: hash,
      schemaPolicyHash: DEFAULT_SCHEMA_POLICY_HASH,
    };
  }

  function preflight(mode: "skipped" | "passed" | "failed" = "skipped"): PreflightResult {
    return {
      taskId,
      timestamp: "2026-09-12T23:01:00.000Z",
      contentHash: hash,
      schemaPolicyHash: DEFAULT_SCHEMA_POLICY_HASH,
      gate: {
        ready: mode !== "failed",
        score: mode === "failed" ? 0 : 5,
        dimensions: {},
        ...(mode === "skipped" ? { gateSkipped: true } : {}),
      },
      blueprint: {
        fileAnalyses: 0,
        codeExamples: 0,
        verificationPatterns: 0,
        antiPatterns: 0,
        formattedMarkdown: "fixture",
      },
      complexity: {
        filesToModify: 1,
        successCriteria: 1,
        estimatedContextTokens: 0,
        independentFeatures: 1,
        featureClusters: [],
        recommendDecomposition: false,
        reason: "fixture",
      },
      contextEstimate: {
        taskSpec: 0,
        blueprint: 0,
        repoMap: 0,
        relevantFiles: 0,
        relatedPatterns: 0,
        existingTests: 0,
        conventions: 0,
        claudeMd: 0,
        total: 0,
        withinBudget: true,
      },
    };
  }

  test("a skipped preflight alone blocks instead of manufacturing passing prep", async () => {
    service.persistPreflightResult(taskId, content, preflight());
    const state = await service.resolveCurrent(taskId);
    expect(state?.prep).toMatchObject({ schemaValid: true, depthScore: 5, depthReady: true });
    // The first red run must reach the real scheduler and show its erroneous admission.
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({
      ok: false,
      error: "preflight_gate_missing",
      nextAction: "prep_or_preflight",
    });
    expect(state).toMatchObject({
      admissionPrep: null,
      dispatchBlockReason: "preflight_gate_missing",
    });
    expect(await service.isPrepCurrent(taskId)).toBe(false);
    expect(await service.isPrepCurrentForHash(taskId, hash)).toBe(false);
  });

  test.each([
    ["{not json", "preflight_gate_missing", "prep_or_preflight"],
    [JSON.stringify({ depthScore: 5, schemaPolicyHash: DEFAULT_SCHEMA_POLICY_HASH }), "preflight_gate_invalid", "reprep"],
  ])(
    "malformed independent blob %s cannot inherit display authority",
    async (blob, error, nextAction) => {
      service.persistPreflightResult(taskId, content, preflight());
      const snapshot = db.getReadinessSnapshot(taskId, hash)!;
      db.upsertReadinessSnapshot({ ...snapshot, prep_data: blob });
      expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({
        ok: false,
        error,
        nextAction,
      });
    },
  );

  test.each(["db", "file"])(
    "stale genuine %s prep is not cleared by current display columns",
    async (source) => {
      const oldContent = `${content}\nEarlier spec revision\n`;
      if (source === "db") service.persistPrepResult(taskId, oldContent, prep());
      else await cache.write({ ...prep(), contentHash: computeContentHash(oldContent) });
      service.persistPreflightResult(taskId, content, preflight());
      expect(await service.resolveCurrent(taskId)).toMatchObject({ hasStalePrep: true });
      expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({
        ok: false,
        error: "preflight_gate_stale",
        nextAction: "reprep",
      });
    },
  );

  test.each([
    ["db", "failed"],
    ["db", "skipped"],
    ["file", "failed"],
    ["file", "skipped"],
  ] as const)("genuine %s prep rescues a %s preflight", async (source, mode) => {
    if (source === "db") service.persistPrepResult(taskId, content, prep());
    else await cache.write(prep());
    service.persistPreflightResult(taskId, content, preflight(mode));
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toEqual({ ok: true });
    expect(await service.resolveCurrent(taskId)).toMatchObject({
      admissionPrep: { depthScore: 4.9, outcome: "pass" },
      hasStalePrep: false,
    });
    expect(await service.isPrepCurrent(taskId)).toBe(true);
    expect(await service.isPrepCurrentForHash(taskId, hash)).toBe(true);
  });

  test("a non-skipped passing preflight still admits without prep", async () => {
    service.persistPreflightResult(taskId, content, preflight("passed"));
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toEqual({ ok: true });
    expect(await service.resolveCurrent(taskId)).toMatchObject({ admissionPrep: null });
    expect(await service.isPrepCurrent(taskId)).toBe(false);
  });

  test("explicit missing/low-preflight overrides retain their different paths", async () => {
    service.persistPreflightResult(taskId, content, preflight());
    expect(
      await evaluateFederatedSchedulingGate(project, job, { allowMissingPreflight: true }),
    ).toEqual({ ok: true });
    service.persistPreflightResult(taskId, content, preflight("failed"));
    expect(
      await evaluateFederatedSchedulingGate(project, job, { allowLowPreflight: true }),
    ).toEqual({ ok: true });
  });
});
