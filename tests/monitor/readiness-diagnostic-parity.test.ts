import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { QuackDB } from "../../src/db";
import { resolvePrepStorageDirSync } from "../../src/core/prep-storage";
import { DEFAULT_SCHEMA_POLICY_HASH } from "../../src/gate/schema-policy";
import { EventReader } from "../../src/monitor/event-reader";
import { queueFederatedJobRecord } from "../../src/monitor/federation/jobs";
import { evaluateFederatedSchedulingGate, isRecoverableFederatedSchedulingBlock } from "../../src/monitor/federation/scheduling";
import type { FederationProjectContext } from "../../src/monitor/federation/types";
import { PrepCache, computeContentHash, type PrepResult } from "../../src/monitor/prep-cache";
import { ReadinessService, selectReadinessDiagnosticPrep, toOperatorPrepResult } from "../../src/monitor/readiness-service";
import { TaskService } from "../../src/monitor/task-service";
import { taskSpec } from "../helpers/divergent-task-fixture";
import { fullPreflightReport } from "../helpers/preflight-job-fixture";

describe("readiness diagnostic reason parity without stale authority", () => {
  let root: string;
  let db: QuackDB;
  let cache: PrepCache;
  let service: ReadinessService;
  let project: FederationProjectContext;
  const taskId = "TASK-1363";
  const content = taskSpec(taskId);
  const hash = computeContentHash(content);
  const job = queueFederatedJobRecord({ projectId: "fixture", taskId, jobType: "dispatch",
    requiredCapabilities: ["dispatch"], provenance: { channel: "federation-queue" } });
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-diagnostic-parity-"));
    fs.mkdirSync(path.join(root, ".quack"));
    fs.mkdirSync(path.join(root, "docs/tasks"), { recursive: true });
    fs.writeFileSync(path.join(root, "docs/tasks", `${taskId}.md`), content);
    db = new QuackDB(path.join(root, ".quack/quack.db"));
    cache = new PrepCache(root);
    project = { projectId: "fixture", projectRoot: root, db, prepCache: cache,
      taskService: new TaskService(root, "docs/tasks"), reader: new EventReader(path.join(root, ".quack/logs")) };
    service = new ReadinessService({ ...project, projectRoot: root });
  });
  afterEach(() => {
    db.close();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
  });
  const prep = (): Omit<PrepResult, "stale"> => ({ taskId, preparedAt: "2026-09-13T11:00:00.000Z",
    schemaValid: true, schemaErrors: [], depthScore: 4.9, depthReady: true,
    deficiencies: [], outcome: "pass", contentHash: hash, schemaPolicyHash: DEFAULT_SCHEMA_POLICY_HASH });
  async function seed(kind: string): Promise<void> {
    if (kind === "missing") return;
    if (kind === "skipped-projection") {
      const report = fullPreflightReport(taskId); report.contentHash = hash; report.gate.gateSkipped = true;
      service.persistPreflightResult(taskId, content, report); return;
    }
    const value = prep();
    if (kind.includes("old") || kind.startsWith("preflight-") || kind === "current-prep-rescue") value.schemaPolicyHash = "c".repeat(64);
    if (kind.includes("legacy")) delete value.schemaPolicyHash;
    if (kind.includes("invalid") || kind.startsWith("preflight-") || kind === "current-prep-rescue") value.depthScore = 6;
    if (kind.includes("rejected")) { value.depthScore = 3; value.depthReady = false; value.outcome = "rejected"; }
    if (kind.startsWith("file-")) await cache.write(value);
    else service.persistPrepResult(taskId, content, value);
    if (["corrupt-json", "array", "null"].includes(kind)) {
      const snapshot = db.getReadinessSnapshot(taskId, hash)!;
      db.upsertReadinessSnapshot({ ...snapshot, prep_data: kind === "corrupt-json" ? "{not json" : kind === "array" ? "[]" : "null" });
    }
    if (kind === "changed-spec") fs.writeFileSync(path.join(root, "docs/tasks", `${taskId}.md`), `${content}\nChanged requirement.\n`);
    if (kind === "current-prep-rescue") await cache.write(prep());
    if (kind.startsWith("preflight-")) {
      const report = fullPreflightReport(taskId); report.contentHash = hash;
      if (kind === "preflight-fail") { report.gate.ready = false; report.gate.score = 3; }
      service.persistPreflightResult(taskId, content, report);
    }
  }

  test.each<[string, string | null, string | null]>([
    ["db-old-invalid", "preflight_gate_invalid", "reprep"],
    ["file-old-invalid", "preflight_gate_invalid", "reprep"],
    ["legacy-invalid", "preflight_gate_invalid", "reprep"],
    ["current-invalid", "preflight_gate_invalid", "reprep"],
    ["db-old-pass", "preflight_gate_stale", "reprep"],
    ["file-old-pass", "preflight_gate_stale", "reprep"],
    ["db-old-rejected", "preflight_gate_stale", "reprep"],
    ["file-old-rejected", "preflight_gate_stale", "reprep"],
    ["legacy-pass", "preflight_gate_stale", "reprep"],
    ["legacy-rejected", "preflight_gate_stale", "reprep"],
    ["current-rejected", "preflight_gate_failed:3.0", "enrich_and_reprep"],
    ["preflight-pass", null, null],
    ["preflight-fail", "preflight_gate_failed:3.0", "enrich_and_reprep"],
    ["current-prep-rescue", null, null],
    ["skipped-projection", "preflight_gate_missing", "prep_or_preflight"],
    ["corrupt-json", "preflight_gate_missing", "prep_or_preflight"],
    ["array", "preflight_gate_missing", "prep_or_preflight"],
    ["null", "preflight_gate_missing", "prep_or_preflight"],
    ["changed-spec", "preflight_gate_stale", "reprep"],
    ["missing", "preflight_gate_missing", "prep_or_preflight"],
  ])("%s retains scheduler decisions and explains the same code", async (kind, error, nextAction) => {
    await seed(kind);
    const before = db.getReadinessSnapshot(taskId, hash)?.prep_data;
    const filePath = path.join(resolvePrepStorageDirSync(root), `${taskId}.json`);
    const fileBytes = fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null;
    const result = await evaluateFederatedSchedulingGate(project, job, {});
    if (error) {
      expect(result).toEqual({ ok: false, error, nextAction, retryable: true, blockReasonCode: "pending_manual_handoff" });
      expect(isRecoverableFederatedSchedulingBlock({ ...job, ...result, status: "blocked" })).toBe(true);
    } else expect(result).toEqual({ ok: true });
    const state = await service.resolveCurrent(taskId);
    expect(state?.dispatchBlockReason).toBe(error?.split(":")[0] ?? null);
    expect(db.getReadinessSnapshot(taskId, hash)?.prep_data).toBe(before);
    expect(fs.existsSync(filePath) ? fs.readFileSync(filePath, "utf8") : null).toBe(fileBytes);
    if (kind.startsWith("legacy-")) {
      expect(state?.staleReasons).toEqual(["prep_stale", "schema_policy_stale", "legacy_prep_provenance"]);
      expect(toOperatorPrepResult(state)).toMatchObject({ stale: true, evidenceSource: "snapshot_projection" });
      expect(state?.admissionPrep).toBeNull();
    }
    if (kind.includes("old")) expect(state?.admissionPrep).toBeNull();
  });

  test("overrides intentionally differ from the summary without changing its diagnostic reason", async () => {
    await seed("legacy-invalid");
    expect(await evaluateFederatedSchedulingGate(project, job, { allowLowPreflight: true })).toEqual({ ok: true });
    expect(await evaluateFederatedSchedulingGate(project, job, { allowMissingPreflight: true }))
      .toMatchObject({ ok: false, error: "preflight_gate_invalid", nextAction: "reprep" });
    expect((await service.resolveCurrent(taskId))?.dispatchBlockReason).toBe("preflight_gate_invalid");
  });
  test("allowMissing admits only missing evidence while the un-overridden summary remains missing", async () => {
    expect(await evaluateFederatedSchedulingGate(project, job, { allowMissingPreflight: true })).toEqual({ ok: true });
    expect((await service.resolveCurrent(taskId))?.dispatchBlockReason).toBe("preflight_gate_missing");
  });
  test("diagnostic selection is repeatable and does not mutate frozen state", async () => {
    await seed("legacy-invalid");
    const state = (await service.resolveCurrent(taskId))!;
    Object.freeze(state.prep); Object.freeze(state.snapshot); Object.freeze(state.staleReasons); Object.freeze(state);
    const before = JSON.stringify(state);
    expect(selectReadinessDiagnosticPrep(state)).toBe(state.prep);
    expect(selectReadinessDiagnosticPrep(state)).toBe(state.prep);
    expect(JSON.stringify(state)).toBe(before);
    const current: PrepResult = { ...prep(), stale: false };
    expect(selectReadinessDiagnosticPrep({ ...state, admissionPrep: current })).toBe(current);
    expect(selectReadinessDiagnosticPrep({ ...state, staleReasons: [] })).toBeNull();
    expect(selectReadinessDiagnosticPrep(null)).toBeNull();
  });
});
