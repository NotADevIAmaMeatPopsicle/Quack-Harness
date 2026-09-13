import { DEFAULT_SCHEMA_POLICY_HASH } from "../../src/gate/schema-policy";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { QuackDB } from "../../src/db";
import { ReadinessService, toOperatorPrepResult } from "../../src/monitor/readiness-service";
import { TaskService } from "../../src/monitor/task-service";
import { computeContentHash, PrepCache } from "../../src/monitor/prep-cache";
import type { PreflightResult } from "../../src/preflight/preflight-types";
import { taskSpec } from "../helpers/divergent-task-fixture";

describe("preflight schema database projection", () => {
  let root: string;
  let db: QuackDB;
  let service: ReadinessService;
  const content = taskSpec("TASK-100", { targetFiles: [] });
  const hash = computeContentHash(content);
  const missing = ["files_to_modify (required by project config)"];
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-schema-projection-"));
    fs.mkdirSync(path.join(root, ".quack"));
    fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs", "tasks", "TASK-100.md"), content);
    // An explicit real DB prevents NoopDB fallback from making this test vacuous.
    db = new QuackDB(path.join(root, ".quack", "quack.db"));
    service = new ReadinessService({
      projectRoot: root,
      db,
      taskService: new TaskService(root, "docs/tasks"),
    });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });

  function preflight(schemaFailure = true): PreflightResult {
    return {
      taskId: "TASK-100",
      timestamp: "2026-09-12T23:00:00.000Z",
      contentHash: hash,
      schemaPolicyHash: DEFAULT_SCHEMA_POLICY_HASH,
      gate: {
        ready: false,
        score: 0,
        dimensions: {},
        readinessJudgmentMode: "off",
        ...(schemaFailure ? { reason: "Schema validation failed", schemaErrors: missing } : {}),
      },
      blueprint: {
        fileAnalyses: 0,
        codeExamples: 0,
        verificationPatterns: 0,
        antiPatterns: 0,
        formattedMarkdown: "fixture",
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
      complexity: {
        filesToModify: 0,
        successCriteria: 1,
        estimatedContextTokens: 0,
        independentFeatures: 1,
        featureClusters: [],
        recommendDecomposition: false,
        reason: "fixture",
      },
    };
  }

  function prep() {
    return { taskId: "TASK-100", preparedAt: "2026-09-12T22:00:00.000Z", schemaValid: true,
      schemaErrors: [], depthScore: 4.9, depthReady: true, deficiencies: [], outcome: "pass" as const,
      contentHash: hash, schemaPolicyHash: DEFAULT_SCHEMA_POLICY_HASH };
  }

  test.each(["legacy", "corrupt", "array", "null", "contract-invalid", "wrong-task", "missing-task", "wrong-hash", "missing-hash"])(
    "%s prep cannot mask a new schema failure or be rewritten as part of the repair", async (kind) => {
      const valid = prep();
      service.persistPrepResult("TASK-100", content, valid);
      const payload = kind === "legacy" ? { ...valid, schemaPolicyHash: undefined }
        : kind === "contract-invalid" ? { ...valid, outcome: "rejected" }
        : kind === "wrong-task" ? { ...valid, taskId: "TASK-OTHER" }
        : kind === "missing-task" ? { ...valid, taskId: undefined }
        : kind === "wrong-hash" ? { ...valid, contentHash: "a".repeat(64) }
        : kind === "missing-hash" ? { ...valid, contentHash: undefined } : valid;
      const bytes = kind === "corrupt" ? "{broken" : kind === "array" ? "[]" : kind === "null" ? "null" : JSON.stringify(payload);
      db.upsertReadinessSnapshot({ ...db.getReadinessSnapshot("TASK-100", hash)!, prep_data: bytes });
      const report = preflight();
      service.persistPreflightResult("TASK-100", content, report);
      expect(db.getReadinessSnapshot("TASK-100", hash)).toMatchObject({
        prep_data: bytes, schema_valid: 0, schema_errors: JSON.stringify(missing), preflight_data: JSON.stringify(report) });
      expect(db.getPrep("TASK-100")?.schema_valid).toBe(0);
      expect(db.getPrep("TASK-100")?.preflight_data).toBe(JSON.stringify(report));
      if (["corrupt", "array", "null"].includes(kind)) {
        const state = await service.resolveCurrent("TASK-100");
        expect(toOperatorPrepResult(state)).toMatchObject({ evidenceSource: "snapshot_projection", schemaValid: false, schemaErrors: missing });
        expect(state?.admissionPrep).toBeNull();
        expect(state?.dispatchBlockReason).toBe("preflight_gate_failed");
      }
    });

  test.each([false, true])("qualified prep repairs divergent columns even when preflight is skipped=%s", (skipped) => {
    for (const accepted of [true, false]) {
      const independent = accepted ? prep() : { ...prep(), schemaValid: false, schemaErrors: ["prep missing section"],
        depthReady: false, depthScore: 0, outcome: "rejected" as const };
      service.persistPrepResult("TASK-100", content, independent);
      const before = db.getReadinessSnapshot("TASK-100", hash)!;
      db.upsertReadinessSnapshot({ ...before, schema_valid: accepted ? 0 : 1, schema_errors: '["divergent columns"]' });
      const report = preflight(); report.gate.gateSkipped = skipped;
      service.persistPreflightResult("TASK-100", content, report);
      expect(db.getReadinessSnapshot("TASK-100", hash)).toMatchObject({ prep_data: before.prep_data,
        schema_valid: accepted ? 1 : 0, schema_errors: JSON.stringify(independent.schemaErrors) });
      expect(db.getPrep("TASK-100")?.schema_valid).toBe(accepted ? 1 : 0);
    }
  });

  test("a genuine old-policy prep stays independent history rather than becoming a new observation", async () => {
    const old = { ...prep(), schemaPolicyHash: "a".repeat(64) };
    service.persistPrepResult("TASK-100", content, old);
    const bytes = db.getReadinessSnapshot("TASK-100", hash)!.prep_data;
    service.persistPreflightResult("TASK-100", content, preflight());
    expect(db.getReadinessSnapshot("TASK-100", hash)).toMatchObject({ prep_data: bytes, schema_valid: 1, schema_errors: "[]" });
    const state = await service.resolveCurrent("TASK-100");
    expect(toOperatorPrepResult(state)).toMatchObject({ evidenceSource: "prep_record", stale: true, schemaValid: true });
    expect(state?.admissionPrep).toBeNull();
    expect(state?.dispatchBlockReason).toBe("preflight_gate_failed");
  });

  test.each([false, true])("skipping without qualified prep preserves prior observation (history=%s)", async (history) => {
    if (history) {
      service.persistPreflightResult("TASK-100", content, preflight());
      db.upsertReadinessSnapshot({ ...db.getReadinessSnapshot("TASK-100", hash)!, prep_data: "{broken" });
    }
    const skipped = preflight(false); skipped.gate = { ...skipped.gate, ready: true, score: 5, gateSkipped: true };
    service.persistPreflightResult("TASK-100", content, skipped);
    expect(db.getReadinessSnapshot("TASK-100", hash)).toMatchObject({
      schema_valid: history ? 0 : 1, schema_errors: JSON.stringify(history ? missing : []) });
    expect(db.getPrep("TASK-100")?.schema_valid).toBe(history ? 0 : 1);
    expect((await service.resolveCurrent("TASK-100"))?.admissionPrep).toBeNull();
    expect((await service.resolveCurrent("TASK-100"))?.dispatchBlockReason).toBe("preflight_gate_missing");
  });

  test("legacy columns follow repeated rejecting and recovering preflight writes while the raw diagnostic remains stale", async () => {
    service.persistPrepResult("TASK-100", content, { ...prep(), schemaPolicyHash: undefined });
    const bytes = db.getReadinessSnapshot("TASK-100", hash)!.prep_data;
    for (const failed of [true, false, true]) {
      const report = preflight(failed);
      if (!failed) report.gate = { ...report.gate, ready: true, score: 4.9 };
      service.persistPreflightResult("TASK-100", content, report);
      expect(db.getReadinessSnapshot("TASK-100", hash)).toMatchObject({ prep_data: bytes,
        schema_valid: failed ? 0 : 1, schema_errors: JSON.stringify(failed ? missing : []) });
      expect(db.getPrep("TASK-100")?.schema_valid).toBe(failed ? 0 : 1);
      const state = await service.resolveCurrent("TASK-100");
      expect(toOperatorPrepResult(state)).toMatchObject({ evidenceSource: "snapshot_projection", stale: true, schemaValid: true });
      expect(state?.admissionPrep).toBeNull();
      expect(state?.dispatchBlockReason).toBe(failed ? "preflight_gate_failed" : null);
    }
  });

  test("a skipped gate cannot publish attached schema errors as a new observation", () => {
    const skipped = preflight(); skipped.gate.gateSkipped = true;
    expect(skipped.gate.schemaErrors).toEqual(missing);
    service.persistPreflightResult("TASK-100", content, skipped);
    expect(db.getReadinessSnapshot("TASK-100", hash)).toMatchObject({ schema_valid: 1, schema_errors: "[]",
      preflight_data: JSON.stringify(skipped) });
    expect(db.getPrep("TASK-100")).toMatchObject({ schema_valid: 1, preflight_data: JSON.stringify(skipped) });
  });

  test("a preflight-only schema rejection stays rejected in columns and the synthetic prep", async () => {
    const result = preflight();
    service.persistPreflightResult("TASK-100", content, result);
    const state = await service.resolveCurrent("TASK-100");
    expect(state?.snapshot).toMatchObject({
      schema_valid: 0,
      schema_errors: JSON.stringify(missing),
      prep_data: null,
    });
    expect(state?.prep).toMatchObject({ schemaValid: false, schemaErrors: missing });
    expect(state?.preflight).toEqual(result);
    expect(db.getPrep("TASK-100")?.schema_valid).toBe(0);
  });

  test("an actual prep remains independent when a later preflight rejects", async () => {
    service.persistPrepResult("TASK-100", content, {
      taskId: "TASK-100",
      preparedAt: "2026-09-12T22:00:00.000Z",
      schemaValid: true,
      schemaErrors: [],
      depthScore: 4.9,
      depthReady: true,
      deficiencies: [],
      outcome: "pass",
      contentHash: hash,
      schemaPolicyHash: DEFAULT_SCHEMA_POLICY_HASH,
    });
    service.persistPreflightResult("TASK-100", content, preflight());
    const state = await service.resolveCurrent("TASK-100");
    expect(state?.prep).toMatchObject({ schemaValid: true, depthScore: 4.9, outcome: "pass" });
    expect(state?.preflight?.gate).toMatchObject({ ready: false, schemaErrors: missing });
  });

  test("legacy cached summaries remain readable with the existing hash/mode checks", async () => {
    const cache = new PrepCache(root);
    const legacy = preflight(false);
    await cache.writePreflight(legacy);
    expect(await cache.readPreflight("TASK-100", hash, "off")).toEqual(legacy);
    expect(await cache.readPreflight("TASK-100", "different-hash", "off")).toBeNull();
    expect(await cache.readPreflight("TASK-100", hash, "enforce")).toBeNull();
  });
});
