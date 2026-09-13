import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { QuackDB } from "../../src/db";
import { migrations } from "../../src/db/migrations";
import { DEFAULT_SCHEMA_POLICY_HASH } from "../../src/gate/schema-policy";
import { ReadinessService, toOperatorPrepResult } from "../../src/monitor/readiness-service";
import { PrepCache, computeContentHash, type PrepResult } from "../../src/monitor/prep-cache";
import { TaskService } from "../../src/monitor/task-service";
import { EventReader } from "../../src/monitor/event-reader";
import { evaluateFederatedSchedulingGate, isRecoverableFederatedSchedulingBlock } from "../../src/monitor/federation/scheduling";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs";
import type { FederationProjectContext } from "../../src/monitor/federation/types";
import { taskSpec } from "../helpers/divergent-task-fixture";
import { fullPreflightReport } from "../helpers/preflight-job-fixture";

describe("legacy prep provenance", () => {
  let root: string; let db: QuackDB; let cache: PrepCache; let service: ReadinessService;
  let project: FederationProjectContext;
  const taskId = "TASK-1358"; const content = taskSpec(taskId); const hash = computeContentHash(content);
  const job = queueFederatedJobRecord({ projectId: "fixture", taskId, jobType: "dispatch", requiredCapabilities: ["dispatch"], provenance: { channel: "federation-queue" } });
  const fresh = (): Omit<PrepResult, "stale"> => ({ taskId, preparedAt: "2026-09-13T00:00:00.000Z", schemaValid: true,
    schemaErrors: [], depthScore: 4.9, depthReady: true, deficiencies: [], outcome: "pass", contentHash: hash, schemaPolicyHash: DEFAULT_SCHEMA_POLICY_HASH });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-legacy-prep-"));
    fs.mkdirSync(path.join(root, "docs/tasks"), { recursive: true });
    fs.mkdirSync(path.join(root, ".quack/logs"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/tasks", `${taskId}.md`), content);
    db = new QuackDB(path.join(root, ".quack/quack.db")); cache = new PrepCache(root);
    project = { projectId: "fixture", projectRoot: root, db, prepCache: cache,
      taskService: new TaskService(root, "docs/tasks"), reader: new EventReader(path.join(root, ".quack/logs")) };
    service = new ReadinessService({ ...project, projectRoot: root });
  });
  afterEach(() => { db.close(); fs.rmSync(root, { recursive: true, force: true }); });
  function migrate(): string {
    db.setPrep({ task_id: taskId, prepared_at: "2026-08-01T00:00:00.000Z", schema_valid: 1,
      depth_score: 3, depth_ready: 0, deficiencies: '["legacy diagnostic"]', outcome: "rejected",
      content_hash: hash, stale: 0, preflight_data: null });
    migrations.find(migration => migration.version === 3)!.up(db.raw());
    return db.getReadinessSnapshot(taskId, hash)!.prep_data!;
  }
  function preflight() { return { ...fullPreflightReport(taskId), contentHash: hash }; }
  async function expectUnproven(): Promise<void> {
    const state = await service.resolveCurrent(taskId);
    expect(state).toMatchObject({ admissionPrep: null, prepEvidenceSource: "snapshot_projection", hasStalePrep: true,
      staleReasons: ["prep_stale", "schema_policy_stale", "legacy_prep_provenance"], dispatchBlockReason: "preflight_gate_stale" });
    expect(toOperatorPrepResult(state)).toMatchObject({ evidenceSource: "snapshot_projection", stale: true });
    expect(await service.isPrepCurrentForHash(taskId, hash)).toBe(false);
    const gate = await evaluateFederatedSchedulingGate(project, job, {});
    expect(gate).toMatchObject({ ok: false, error: "preflight_gate_stale", nextAction: "reprep", retryable: true });
    expect(isRecoverableFederatedSchedulingBlock({ ...job, ...gate, status: "blocked" })).toBe(true);
  }

  test.each(["migration", "unstamped-genuine"])("%s remains diagnostic evidence with a recoverable stale block", async origin => {
    if (origin === "migration") migrate();
    else { const prep = fresh(); delete prep.schemaPolicyHash; service.persistPrepResult(taskId, content, prep); }
    const before = db.getReadinessSnapshot(taskId, hash)!.prep_data;
    await expectUnproven();
    expect(db.getReadinessSnapshot(taskId, hash)!.prep_data).toBe(before);
  });
  test("later preflight origin overwrite cannot promote a migrated blob or rewrite its diagnostics", async () => {
    const before = migrate();
    for (let index = 0; index < 2; index++) {
      const report = preflight(); report.gate = { ...report.gate, gateSkipped: true, score: 5, ready: true };
      service.persistPreflightResult(taskId, content, report);
      expect(db.getReadinessSnapshot(taskId, hash)).toMatchObject({ source: "preflight", generator_version: "task-887-g-v1", depth_score: 5, prep_data: before });
      await expectUnproven();
      expect(toOperatorPrepResult(await service.resolveCurrent(taskId))).toMatchObject({ preparedAt: "2026-08-01T00:00:00.000Z", depthScore: 3,
        deficiencies: ["legacy diagnostic"], outcome: "rejected" });
    }
  });
  test("legacy history for a changed task stays stale without pretending to be its current prep", async () => {
    const before = migrate(); fs.appendFileSync(path.join(root, "docs/tasks", `${taskId}.md`), "\nChanged requirement\n");
    expect(await service.resolveCurrent(taskId)).toMatchObject({ prep: null, admissionPrep: null, prepEvidenceSource: null,
      hasStalePrep: true, staleReasons: ["prep_stale"], dispatchBlockReason: "preflight_gate_stale" });
    expect(db.getReadinessSnapshot(taskId, hash)!.prep_data).toBe(before);
  });
  test.each(["file", "db"])("current genuine %s prep replaces legacy uncertainty and survives preflight writes", async origin => {
    migrate();
    if (origin === "file") await cache.write(fresh()); else service.persistPrepResult(taskId, content, fresh());
    service.persistPreflightResult(taskId, content, preflight());
    expect(await service.resolveCurrent(taskId)).toMatchObject({ admissionPrep: { depthScore: 4.9 }, prepEvidenceSource: "prep_record", hasStalePrep: false, staleReasons: [] });
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toEqual({ ok: true });
  });
  test.each(["file", "db"])("current genuine %s schema rejection takes precedence over migrated success-shaped data", async origin => {
    migrate(); const rejected = { ...fresh(), schemaValid: false, schemaErrors: ["missing section"], depthReady: false,
      depthScore: 0, outcome: "rejected" as const };
    if (origin === "file") await cache.write(rejected); else service.persistPrepResult(taskId, content, rejected);
    expect(await service.resolveCurrent(taskId)).toMatchObject({ prep: { schemaValid: false, schemaErrors: ["missing section"] },
      prepEvidenceSource: "prep_record", hasStalePrep: false, dispatchBlockReason: "preflight_gate_failed" });
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({ ok: false, error: "preflight_gate_failed:0.0" });
  });
  test.each(["historical-db", "historical-file", "current-file"])("%s legacy data cannot relabel a genuine mismatched policy", async origin => {
    migrate();
    const currentContent = origin === "current-file" ? content : `${content}\nChanged requirement\n`;
    fs.writeFileSync(path.join(root, "docs/tasks", `${taskId}.md`), currentContent);
    const prep = { ...fresh(), contentHash: computeContentHash(currentContent), schemaPolicyHash: "f".repeat(64) };
    if (origin === "historical-db") service.persistPrepResult(taskId, currentContent, prep);
    else await cache.write(prep);
    expect(toOperatorPrepResult(await service.resolveCurrent(taskId))).toMatchObject({ evidenceSource: "prep_record", stale: true });
    expect((await service.resolveCurrent(taskId))?.staleReasons).toEqual(["prep_stale", "schema_policy_stale"]);
  });
  test.each(["{not json", "[]", "null"])("corrupt or non-object bytes %s do not manufacture legacy prep evidence", async blob => {
    const report = preflight(); report.gate = { ...report.gate, gateSkipped: true };
    service.persistPreflightResult(taskId, content, report);
    db.upsertReadinessSnapshot({ ...db.getReadinessSnapshot(taskId, hash)!, prep_data: blob });
    expect(await service.resolveCurrent(taskId)).toMatchObject({ admissionPrep: null, hasStalePrep: false,
      staleReasons: [], dispatchBlockReason: "preflight_gate_missing" });
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({ ok: false,
      error: "preflight_gate_missing", nextAction: "prep_or_preflight" });
    expect(db.getReadinessSnapshot(taskId, hash)!.prep_data).toBe(blob);
  });
  test("current preflight rescues unproven prep and updates schema columns while retaining raw legacy diagnostics", async () => {
    const before = migrate(); service.persistPreflightResult(taskId, content, preflight());
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toEqual({ ok: true });
    const rejected = preflight(); rejected.gate = { ...rejected.gate, ready: false, score: 0, schemaErrors: ["current missing section"] };
    service.persistPreflightResult(taskId, content, rejected);
    const state = await service.resolveCurrent(taskId);
    expect(state).toMatchObject({ prepEvidenceSource: "snapshot_projection", prep: { depthScore: 3, schemaValid: true, schemaErrors: [] },
      preflight: { gate: { schemaErrors: ["current missing section"] } }, dispatchBlockReason: "preflight_gate_failed" });
    // TASK-1361 closes the deferred column mask; the legacy blob stays byte-identical.
    expect(db.getReadinessSnapshot(taskId, hash)).toMatchObject({ prep_data: before, schema_valid: 0, schema_errors: '["current missing section"]', depth_score: 0 });
    expect(db.getPrep(taskId)?.schema_valid).toBe(0);
    expect(toOperatorPrepResult(state)).toMatchObject({ evidenceSource: "snapshot_projection", stale: true,
      depthScore: 3, schemaValid: true, schemaErrors: [] });
    expect(await evaluateFederatedSchedulingGate(project, job, {})).toMatchObject({ ok: false, error: "preflight_gate_failed:0.0" });
  });
});
