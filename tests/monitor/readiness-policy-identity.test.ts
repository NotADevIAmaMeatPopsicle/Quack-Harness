import { computeSchemaPolicyHash } from "../../src/gate/schema-policy";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { QuackDB } from "../../src/db";
import { EventReader } from "../../src/monitor/event-reader";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs";
import {
  evaluateFederatedSchedulingGate,
  isRecoverableFederatedSchedulingBlock,
} from "../../src/monitor/federation/scheduling";
import type { FederationProjectContext } from "../../src/monitor/federation/types";
import { PrepCache, computeContentHash, type PrepResult } from "../../src/monitor/prep-cache";
import { ReadinessService, toOperatorPrepResult, toOperatorPreflightResult } from "../../src/monitor/readiness-service";
import { TaskService } from "../../src/monitor/task-service";
import type { PreflightResult } from "../../src/preflight/preflight-types";
import { taskSpec } from "../helpers/divergent-task-fixture";

describe("readiness schema policy authority", () => {
  let root: string;
  let db: QuackDB;
  let cache: PrepCache;
  let service: ReadinessService;
  let project: FederationProjectContext;
  const taskId = "TASK-1354";
  const oldPolicy = computeSchemaPolicyHash();
  const policy = computeSchemaPolicyHash(["filesToModify"]);
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
    Object.assign(project, { schemaPolicyHash: policy });
    const deps = { ...project, projectRoot: root, schemaPolicyHash: policy };
    service = new ReadinessService(deps);
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
      schemaPolicyHash: oldPolicy,
    };
  }

  function preflight(mode: "skipped" | "passed" | "failed" = "skipped"): PreflightResult {
    return {
      taskId,
      timestamp: "2026-09-12T23:01:00.000Z",
      contentHash: hash,
      schemaPolicyHash: oldPolicy,
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

  test.each(["db", "file"] as const)(
    "%s prep with old policy blocks and recovers",
    async (source) => {
      const write = async (value: Omit<PrepResult, "stale">) => {
        if (source === "db") service.persistPrepResult(taskId, content, value);
        else await cache.write(value);
      };
      await write(prep());
      const blocked = await evaluateFederatedSchedulingGate(project, job, {
        allowMissingPreflight: true,
      });
      expect(blocked).toMatchObject({
        ok: false,
        error: "preflight_gate_stale",
        nextAction: "reprep",
        retryable: true,
      });
      expect(isRecoverableFederatedSchedulingBlock({ ...job, ...blocked, status: "blocked" })).toBe(
        true,
      );
      const state = await service.resolveCurrent(taskId);
      expect(state).toMatchObject({
        admissionPrep: null,
        hasStalePrep: true,
        staleReasons: expect.arrayContaining(["schema_policy_stale"]) as unknown,
      });
      expect(toOperatorPrepResult(state)).toMatchObject({
        evidenceSource: "prep_record",
        stale: true,
        depthScore: 4.9,
      });
      expect(await service.isPrepCurrent(taskId)).toBe(false);
      expect(await service.isPrepCurrentForHash(taskId, hash)).toBe(false);
      expect(await service.getCurrentGateScore(taskId)).toBeNull();
      expect(
        await evaluateFederatedSchedulingGate(project, job, { allowLowPreflight: true }),
      ).toEqual({ ok: true });
      await write({ ...prep(), schemaPolicyHash: policy });
      expect(await evaluateFederatedSchedulingGate(project, job, {})).toEqual({ ok: true });
      expect(await service.isPrepCurrent(taskId)).toBe(true);
      expect(await service.isPrepCurrentForHash(taskId, hash)).toBe(true);
    },
  );

  test.each(["db", "file"] as const)(
    "%s preflight with old policy cannot hide behind allowMissing",
    async (source) => {
      const write = async (value: PreflightResult) => {
        if (source === "db") service.persistPreflightResult(taskId, content, value);
        else await cache.writePreflight(value);
      };
      await write(preflight("passed"));
      expect(
        await evaluateFederatedSchedulingGate(project, job, { allowMissingPreflight: true }),
      ).toMatchObject({ ok: false, error: "preflight_gate_stale", nextAction: "reprep" });
      expect(await service.resolveCurrent(taskId)).toMatchObject({
        admissionPreflight: null,
        hasStalePreflight: true,
        staleReasons: expect.arrayContaining(["schema_policy_stale"]) as unknown,
      });
      expect(await service.isPreflightCurrent(taskId)).toBe(false);
      expect(await service.isPreflightCurrentForHash(taskId, hash)).toBe(false);
      await write({ ...preflight("passed"), schemaPolicyHash: policy });
      expect(await evaluateFederatedSchedulingGate(project, job, {})).toEqual({ ok: true });
      expect(await service.isPreflightCurrent(taskId)).toBe(true);
      expect(await service.isPreflightCurrentForHash(taskId, hash)).toBe(true);
    },
  );

  test.each(["prep", "preflight"] as const)(
    "unstamped %s remains unknown under default policy",
    async (kind) => {
      Object.assign(project, { schemaPolicyHash: oldPolicy });
      if (kind === "prep") {
        const value = prep();
        delete value.schemaPolicyHash;
        service.persistPrepResult(taskId, content, value);
      } else {
        const value = preflight("passed");
        delete value.schemaPolicyHash;
        service.persistPreflightResult(taskId, content, value);
      }
      expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({
        ok: false,
        error: "preflight_gate_stale", nextAction: "reprep",
      });
      if (kind === "prep") expect(await service.resolveCurrent(taskId)).toMatchObject({
        prepEvidenceSource: "snapshot_projection", admissionPrep: null, hasStalePrep: true,
        staleReasons: ["prep_stale", "schema_policy_stale", "legacy_prep_provenance"],
      });
    },
  );

  test.each(["prep", "preflight"] as const)(
    "current %s rescues the other stale source",
    async (kind) => {
      service.persistPrepResult(taskId, content, {
        ...prep(),
        schemaPolicyHash: kind === "prep" ? policy : oldPolicy,
      });
      service.persistPreflightResult(taskId, content, {
        ...preflight("passed"),
        schemaPolicyHash: kind === "preflight" ? policy : oldPolicy,
      });
      expect(await evaluateFederatedSchedulingGate(project, job, {})).toEqual({ ok: true });
    },
  );

  test.each(["db", "file"] as const)(
    "%s mode mismatch is stale even with matching policy",
    async (source) => {
      const value = { ...preflight("passed"), schemaPolicyHash: policy };
      value.gate.readinessJudgmentMode = "shadow";
      if (source === "db") service.persistPreflightResult(taskId, content, value);
      else await cache.writePreflight(value);
      expect(
        await evaluateFederatedSchedulingGate(project, job, { allowMissingPreflight: true }),
      ).toMatchObject({ ok: false, error: "preflight_gate_stale" });
      expect(await service.resolveCurrent(taskId)).toMatchObject({
        staleReasons: expect.arrayContaining(["readiness_mode_stale"]) as unknown,
      });
      expect(await service.isPreflightCurrent(taskId)).toBe(false);
      expect(await service.isPreflightCurrentForHash(taskId, hash)).toBe(false);
    },
  );

  test.each(["db", "file"] as const)("a current %s result is not hidden by stale evidence in the other store", async (source) => {
    service.persistPrepResult(taskId, content, { ...prep(), schemaPolicyHash: source === "db" ? policy : oldPolicy });
    await cache.write({ ...prep(), schemaPolicyHash: source === "file" ? policy : oldPolicy });
    service.persistPreflightResult(taskId, content, { ...preflight("passed"), schemaPolicyHash: source === "db" ? policy : oldPolicy });
    await cache.writePreflight({ ...preflight("passed"), schemaPolicyHash: source === "file" ? policy : oldPolicy });
    expect(await service.resolveCurrent(taskId)).toMatchObject({
      admissionPrep: { schemaPolicyHash: policy }, admissionPreflight: { schemaPolicyHash: policy }, hasStalePrep: false, hasStalePreflight: false,
    });
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toEqual({ ok: true });
  });

  test("a policy stamp without a spec hash cannot suppress prep via timestamps", async () => {
    await cache.write({ ...prep(), schemaPolicyHash: policy, contentHash: undefined, preparedAt: "2099-01-01T00:00:00Z" });
    expect(await service.isPrepCurrent(taskId)).toBe(false);
    expect(await service.isPrepCurrentForHash(taskId, hash)).toBe(false);
    expect(toOperatorPrepResult(await service.resolveCurrent(taskId))).toMatchObject({ evidenceSource: "prep_record", stale: true });
  });

  test("current failed preflight keeps decomposition guidance despite unknown prep policy", async () => {
    const legacy = prep();
    delete legacy.schemaPolicyHash;
    service.persistPrepResult(taskId, content, legacy);
    const failed = { ...preflight("failed"), schemaPolicyHash: policy };
    failed.gate.score = 2;
    failed.complexity.recommendDecomposition = true;
    service.persistPreflightResult(taskId, content, failed);
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({
      ok: false, error: "preflight_gate_failed:2.0", nextAction: "decompose",
    });
    const state = await service.resolveCurrent(taskId);
    expect(state?.dispatchBlockReason).toBe("preflight_gate_failed");
    expect(toOperatorPreflightResult(state)).toMatchObject({ stale: false, staleReasons: [] });
  });

  test.each([true, false])("malformed genuine prep reports invalid with known policy=%s", async (known) => {
    const malformed = { ...prep(), schemaPolicyHash: known ? policy : undefined };
    service.persistPrepResult(taskId, content, malformed);
    const row = db.getReadinessSnapshot(taskId, hash)!;
    db.upsertReadinessSnapshot({ ...row, prep_data: JSON.stringify({ ...malformed, depthScore: "bad" }) });
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({
      ok: false, error: "preflight_gate_invalid", nextAction: "reprep",
    });
  });

  test.each([
    ["db", "policy"], ["file", "policy"], ["db", "mode"], ["file", "mode"],
  ] as const)("current failing prep wins over %s preflight stale by %s", async (source, reason) => {
    const old = { ...preflight("passed"), schemaPolicyHash: reason === "policy" ? oldPolicy : policy };
    if (reason === "mode") old.gate.readinessJudgmentMode = "shadow";
    if (source === "db") service.persistPreflightResult(taskId, content, old);
    else await cache.writePreflight(old);
    const failed = { ...prep(), schemaPolicyHash: policy, depthScore: 3.9, depthReady: false,
      outcome: "rejected" as const, recommendDecomposition: true };
    for (let attempt = 0; attempt < 2; attempt++) {
      service.persistPrepResult(taskId, content, failed);
      expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({
        ok: false, error: "preflight_gate_failed:3.9", nextAction: "decompose",
      });
      expect((await service.resolveCurrent(taskId))?.dispatchBlockReason).toBe("preflight_gate_failed");
    }
    service.persistPrepResult(taskId, content, { ...prep(), schemaPolicyHash: policy });
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toEqual({ ok: true });
    expect((await service.resolveCurrent(taskId))?.dispatchBlockReason).toBeNull();
  });

  test("API summary honors passing prep rescue of current failed preflight", async () => {
    service.persistPrepResult(taskId, content, { ...prep(), schemaPolicyHash: policy });
    service.persistPreflightResult(taskId, content, { ...preflight("failed"), schemaPolicyHash: policy });
    expect((await service.resolveCurrent(taskId))?.dispatchBlockReason).toBeNull();
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toEqual({ ok: true });
  });

  test("API summary cannot pass schema-invalid prep with optimistic depth fields", async () => {
    service.persistPrepResult(taskId, content, { ...prep(), schemaPolicyHash: policy,
      schemaValid: false, schemaErrors: ["Missing required section"] });
    expect((await service.resolveCurrent(taskId))?.dispatchBlockReason).toBe("preflight_gate_invalid");
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({ error: "preflight_gate_invalid" });
  });

  test("content-only stale preflight retains the missing admission diagnostic", async () => {
    await cache.writePreflight({ ...preflight("passed"), contentHash: "different", schemaPolicyHash: policy });
    expect((await service.resolveCurrent(taskId))?.dispatchBlockReason).toBe("preflight_gate_missing");
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({ error: "preflight_gate_missing" });
  });

  test("semantic policy sets are canonical and versioned", () => {
    expect(computeSchemaPolicyHash(["filesToModify", "currentState", "filesToModify"])).toBe(
      computeSchemaPolicyHash(["currentState", "filesToModify"]),
    );
    expect(policy).not.toBe(oldPolicy);
    expect(oldPolicy).toMatch(/^[a-f0-9]{64}$/);
  });
});
