/* eslint-disable @typescript-eslint/no-unsafe-call, @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-assignment */
import { QuackDB } from "../../src/db/quack-db";
import type {
  SessionRow,
  DispatchJobRow,
  VerifiedRow,
  CheckpointRow,
  PrepCacheRow,
  ReadinessSnapshotRow,
  EffectiveSpecRow,
  QueueItemRow,
} from "../../src/db/types";

describe("QuackDB", () => {
  let db: QuackDB;

  beforeEach(() => {
    db = new QuackDB(":memory:");
  });

  afterEach(() => {
    db.close();
  });

  // ─── Migrations ─────────────────────────────────────────────

  describe("migrations", () => {
    it("should create all tables on initialization", () => {
      const raw = db.raw();
      const tables = raw
        .prepare(
          "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
        )
        .all() as Array<{ name: string }>;
      const names = tables.map((t) => t.name).sort();
      expect(names).toEqual([
        "checkpoints",
        "coordination_messages",
        "dispatch_jobs",
        "effective_specs",
        "prep_cache",
        "queue_items",
        "readiness_snapshots",
        "sessions",
        "task_status",
        "verified",
        "verified_history",
      ]);
    });

    it("should set user_version to latest migration", () => {
      const raw = db.raw();
      const version = raw.pragma("user_version", { simple: true });
      expect(version).toBe(6);
    });

    it("should not re-run migrations on second open", () => {
      // Close and reopen — should be idempotent
      db.close();
      db = new QuackDB(":memory:");
      const raw = db.raw();
      const version = raw.pragma("user_version", { simple: true });
      expect(version).toBe(6);
    });

    it("should enable WAL mode", () => {
      const raw = db.raw();
      const mode = raw.pragma("journal_mode", { simple: true });
      // In-memory DBs may report "memory" instead of "wal"
      expect(["wal", "memory"]).toContain(mode);
    });
  });

  // ─── Task Status ────────────────────────────────────────────

  describe("task status", () => {
    it("should set and get task status", () => {
      db.setStatus("TASK-001", "READY", "system");
      const row = db.getStatus("TASK-001");
      expect(row).toBeDefined();
      expect(row!.task_id).toBe("TASK-001");
      expect(row!.status).toBe("READY");
      expect(row!.updated_by).toBe("system");
      expect(row!.previous_status).toBeNull();
    });

    it("should track previous status on update", () => {
      db.setStatus("TASK-001", "READY", "system");
      db.setStatus("TASK-001", "IN_PROGRESS", "dispatch");
      const row = db.getStatus("TASK-001");
      expect(row!.status).toBe("IN_PROGRESS");
      expect(row!.previous_status).toBe("READY");
    });

    it("should return undefined for nonexistent task", () => {
      expect(db.getStatus("TASK-999")).toBeUndefined();
    });

    it("should list all statuses", () => {
      db.setStatus("TASK-001", "READY", "system");
      db.setStatus("TASK-002", "COMPLETE", "lifecycle");
      const all = db.getAllStatuses();
      expect(all).toHaveLength(2);
    });

    it("should conditionally transition status", () => {
      db.setStatus("TASK-001", "READY", "system");

      // Correct transition
      expect(db.transitionStatus("TASK-001", "READY", "IN_PROGRESS", "dispatch")).toBe(true);
      expect(db.getStatus("TASK-001")!.status).toBe("IN_PROGRESS");

      // Wrong from-status — should not change
      expect(db.transitionStatus("TASK-001", "READY", "COMPLETE", "lifecycle")).toBe(false);
      expect(db.getStatus("TASK-001")!.status).toBe("IN_PROGRESS");
    });

    it("should return false for transition on nonexistent task", () => {
      expect(db.transitionStatus("TASK-999", "READY", "IN_PROGRESS", "dispatch")).toBe(false);
    });
  });

  // ─── Sessions ───────────────────────────────────────────────

  describe("sessions", () => {
    const session: SessionRow = {
      session_id: "quack-TASK-001-12345",
      task_id: "TASK-001",
      project: "test-project",
      title: "Test task",
      start_time: "2026-04-05T00:00:00Z",
      status: "active",
      outcome: null,
      total_cost_usd: null,
      duration_ms: null,
      turns_used: null,
    };

    it("should upsert and get session", () => {
      db.upsertSession(session);
      const rows = db.getSessionsForTask("TASK-001");
      expect(rows).toHaveLength(1);
      expect(rows[0].session_id).toBe("quack-TASK-001-12345");
      expect(rows[0].status).toBe("active");
    });

    it("should update session on upsert", () => {
      db.upsertSession(session);
      db.upsertSession({
        ...session,
        status: "completed",
        outcome: "approved",
        total_cost_usd: 1.5,
        duration_ms: 60000,
        turns_used: 15,
      });
      const latest = db.getLatestSession("TASK-001");
      expect(latest!.status).toBe("completed");
      expect(latest!.outcome).toBe("approved");
      expect(latest!.total_cost_usd).toBe(1.5);
    });

    it("should get latest session for task", () => {
      db.upsertSession(session);
      db.upsertSession({
        ...session,
        session_id: "quack-TASK-001-99999",
        start_time: "2026-04-05T01:00:00Z",
        status: "completed",
        outcome: "approved",
      });
      const latest = db.getLatestSession("TASK-001");
      expect(latest!.session_id).toBe("quack-TASK-001-99999");
    });

    it("should return undefined for nonexistent task session", () => {
      expect(db.getLatestSession("TASK-999")).toBeUndefined();
    });

    it("should list all sessions ordered by start_time desc", () => {
      db.upsertSession(session);
      db.upsertSession({
        ...session,
        session_id: "quack-TASK-002-12345",
        task_id: "TASK-002",
        start_time: "2026-04-05T02:00:00Z",
      });
      const all = db.getAllSessions();
      expect(all).toHaveLength(2);
      expect(all[0].task_id).toBe("TASK-002"); // newer first
    });
  });

  // ─── Dispatch Jobs ──────────────────────────────────────────

  describe("dispatch jobs", () => {
    const job: DispatchJobRow = {
      task_id: "TASK-001",
      session_id: "quack-TASK-001-12345",
      pid: 4596,
      started_at: "2026-04-05T00:00:00Z",
      status: "running",
      exit_code: null,
      worktree_path: "/tmp/worktree",
      container_id: null,
      key_id: null,
      output_tail: JSON.stringify(["line 1", "line 2"]),
    };

    it("should upsert and get job", () => {
      db.upsertJob(job);
      const row = db.getJob("TASK-001");
      expect(row).toBeDefined();
      expect(row!.pid).toBe(4596);
      expect(row!.status).toBe("running");
    });

    it("should list active jobs", () => {
      db.upsertJob(job);
      db.upsertJob({ ...job, task_id: "TASK-002", status: "completed" });
      const active = db.getActiveJobs();
      expect(active).toHaveLength(1);
      expect(active[0].task_id).toBe("TASK-001");
    });

    it("should update job on upsert", () => {
      db.upsertJob(job);
      db.upsertJob({ ...job, status: "completed", exit_code: 0 });
      const row = db.getJob("TASK-001");
      expect(row!.status).toBe("completed");
      expect(row!.exit_code).toBe(0);
    });

    it("should remove job", () => {
      db.upsertJob(job);
      db.removeJob("TASK-001");
      expect(db.getJob("TASK-001")).toBeUndefined();
    });
  });

  // ─── Verified ───────────────────────────────────────────────

  describe("verified", () => {
    const entry: VerifiedRow = {
      task_id: "TASK-001",
      verified_at: "2026-04-05",
      commit_sha: "abc1234",
      method: "pipeline",
      verdict: "VERIFIED",
      criteria_checked: 10,
      criteria_passed: 10,
      notes: "All criteria met",
    };

    it("should set and get verified entry", () => {
      db.setVerified(entry);
      const row = db.getVerified("TASK-001");
      expect(row).toBeDefined();
      expect(row!.verdict).toBe("VERIFIED");
      expect(row!.criteria_passed).toBe(10);
    });

    it("should overwrite on conflict", () => {
      db.setVerified(entry);
      db.setVerified({ ...entry, verdict: "FAILED", criteria_passed: 8 });
      const row = db.getVerified("TASK-001");
      expect(row!.verdict).toBe("FAILED");
      expect(row!.criteria_passed).toBe(8);
    });

    it("should return all verified as Map", () => {
      db.setVerified(entry);
      db.setVerified({ ...entry, task_id: "TASK-002", verdict: "FAILED" });
      const map = db.getAllVerified();
      expect(map.size).toBe(2);
      expect(map.get("TASK-001")!.verdict).toBe("VERIFIED");
      expect(map.get("TASK-002")!.verdict).toBe("FAILED");
    });
  });

  // ─── Checkpoints ────────────────────────────────────────────

  describe("checkpoints", () => {
    const cp: CheckpointRow = {
      task_id: "TASK-001",
      session_id: "quack-TASK-001-12345",
      completed_stages: JSON.stringify(["gate", "blueprint"]),
      branch_name: "quack/TASK-001",
      total_cost_usd: 0.5,
      retries_used: 0,
      started_at: "2026-04-05T00:00:00Z",
      updated_at: "2026-04-05T00:05:00Z",
      parent_task_id: null,
      shared_branch: null,
      agent_result: null,
      judge_result: null,
      gate_result: null,
    };

    it("should save and load checkpoint", () => {
      db.saveCheckpoint(cp);
      const row = db.loadCheckpoint("TASK-001");
      expect(row).toBeDefined();
      expect(JSON.parse(row!.completed_stages)).toEqual(["gate", "blueprint"]);
    });

    it("should update checkpoint on save", () => {
      db.saveCheckpoint(cp);
      db.saveCheckpoint({
        ...cp,
        completed_stages: JSON.stringify(["gate", "blueprint", "agent"]),
        total_cost_usd: 2.0,
      });
      const row = db.loadCheckpoint("TASK-001");
      expect(JSON.parse(row!.completed_stages)).toEqual(["gate", "blueprint", "agent"]);
      expect(row!.total_cost_usd).toBe(2.0);
    });

    it("should delete checkpoint", () => {
      db.saveCheckpoint(cp);
      db.deleteCheckpoint("TASK-001");
      expect(db.loadCheckpoint("TASK-001")).toBeUndefined();
    });

    it("should list all checkpoints", () => {
      db.saveCheckpoint(cp);
      db.saveCheckpoint({ ...cp, task_id: "TASK-002" });
      expect(db.listCheckpoints()).toHaveLength(2);
    });
  });

  // ─── Prep Cache ─────────────────────────────────────────────

  describe("prep cache", () => {
    const prep: PrepCacheRow = {
      task_id: "TASK-001",
      prepared_at: "2026-04-05T00:00:00Z",
      schema_valid: 1,
      depth_score: 4.8,
      depth_ready: 1,
      deficiencies: "[]",
      outcome: "pass",
      content_hash: "sha256-abc",
      stale: 0,
      preflight_data: null,
    };

    it("should set and get prep", () => {
      db.setPrep(prep);
      const row = db.getPrep("TASK-001");
      expect(row).toBeDefined();
      expect(row!.depth_score).toBe(4.8);
    });

    it("should get prep by content hash", () => {
      db.setPrep(prep);
      const row = db.getPrepByHash("TASK-001", "sha256-abc");
      expect(row).toBeDefined();
      expect(row!.outcome).toBe("pass");
    });

    it("should return undefined for wrong hash", () => {
      db.setPrep(prep);
      expect(db.getPrepByHash("TASK-001", "sha256-wrong")).toBeUndefined();
    });

    it("should invalidate prep", () => {
      db.setPrep(prep);
      db.invalidatePrep("TASK-001");
      expect(db.getPrep("TASK-001")).toBeUndefined();
    });
  });

  describe("readiness snapshots", () => {
    const snapshot: ReadinessSnapshotRow = {
      task_id: "TASK-001",
      spec_hash: "spec-hash-1",
      base_spec_hash: "base-hash-1",
      created_at: "2026-04-05T00:00:00Z",
      updated_at: "2026-04-05T00:05:00Z",
      schema_valid: 1,
      schema_errors: "[]",
      depth_score: 4.9,
      depth_ready: 1,
      deficiencies: "[]",
      outcome: "pass",
      prep_data: '{"taskId":"TASK-001"}',
      preflight_data: null,
      effective_spec_data: null,
      stale_reason: null,
      source: "test",
      generator_version: "v1",
    };

    it("should upsert and get a readiness snapshot by task and spec hash", () => {
      db.upsertReadinessSnapshot(snapshot);
      const row = db.getReadinessSnapshot("TASK-001", "spec-hash-1");
      expect(row).toBeDefined();
      expect(row!.depth_score).toBe(4.9);
      expect(row!.base_spec_hash).toBe("base-hash-1");
    });

    it("should list readiness snapshots newest first", () => {
      db.upsertReadinessSnapshot(snapshot);
      db.upsertReadinessSnapshot({
        ...snapshot,
        spec_hash: "spec-hash-2",
        updated_at: "2026-04-05T00:10:00Z",
      });
      const rows = db.listReadinessSnapshots("TASK-001");
      expect(rows).toHaveLength(2);
      expect(rows[0].spec_hash).toBe("spec-hash-2");
    });
  });

  describe("effective specs", () => {
    const spec: EffectiveSpecRow = {
      task_id: "TASK-001",
      base_spec_hash: "base-hash-1",
      effective_spec_hash: "effective-hash-1",
      status: "accepted",
      content: "# TASK-001: enriched",
      deficiencies: '["clarify test plan"]',
      source: "test",
      created_at: "2026-04-05T00:00:00Z",
      updated_at: "2026-04-05T00:05:00Z",
    };

    it("should upsert and get an effective spec row", () => {
      db.upsertEffectiveSpec(spec);
      const row = db.getEffectiveSpec("TASK-001", "base-hash-1", "effective-hash-1");
      expect(row).toBeDefined();
      expect(row!.status).toBe("accepted");
      expect(row!.content).toContain("enriched");
    });

    it("should list effective specs newest first", () => {
      db.upsertEffectiveSpec(spec);
      db.upsertEffectiveSpec({
        ...spec,
        effective_spec_hash: "effective-hash-2",
        updated_at: "2026-04-05T00:10:00Z",
      });
      const rows = db.listEffectiveSpecs("TASK-001");
      expect(rows).toHaveLength(2);
      expect(rows[0].effective_spec_hash).toBe("effective-hash-2");
    });
  });

  // ─── Queue Items ────────────────────────────────────────────

  describe("queue items", () => {
    const item: QueueItemRow = {
      task_id: "TASK-001",
      status: "queued",
      priority: 5,
      blocked_by: "[]",
      enqueued_at: "2026-04-05T00:00:00Z",
      started_at: null,
      completed_at: null,
      outcome: null,
      cost_usd: null,
      duration_ms: null,
      retry_count: 0,
      error: null,
      dispatch_options: null,
    };

    it("should upsert and get queue item", () => {
      db.upsertQueueItem(item);
      const row = db.getQueueItem("TASK-001");
      expect(row).toBeDefined();
      expect(row!.status).toBe("queued");
      expect(row!.priority).toBe(5);
    });

    it("should update queue item on upsert", () => {
      db.upsertQueueItem(item);
      db.upsertQueueItem({ ...item, status: "running", started_at: "2026-04-05T00:05:00Z" });
      const row = db.getQueueItem("TASK-001");
      expect(row!.status).toBe("running");
    });

    it("should list all queue items ordered by priority desc", () => {
      db.upsertQueueItem(item);
      db.upsertQueueItem({ ...item, task_id: "TASK-002", priority: 10 });
      const all = db.getAllQueueItems();
      expect(all).toHaveLength(2);
      expect(all[0].task_id).toBe("TASK-002"); // higher priority first
    });

    it("should remove queue item", () => {
      db.upsertQueueItem(item);
      db.removeQueueItem("TASK-001");
      expect(db.getQueueItem("TASK-001")).toBeUndefined();
    });

    it("should clear all queue items", () => {
      db.upsertQueueItem(item);
      db.upsertQueueItem({ ...item, task_id: "TASK-002" });
      db.clearQueue();
      expect(db.getAllQueueItems()).toHaveLength(0);
    });
  });

  // ─── Transactions ───────────────────────────────────────────

  describe("transactions", () => {
    it("should commit transaction on success", () => {
      db.transaction(() => {
        db.setStatus("TASK-001", "READY", "system");
        db.setStatus("TASK-002", "COMPLETE", "lifecycle");
      });
      expect(db.getStatus("TASK-001")!.status).toBe("READY");
      expect(db.getStatus("TASK-002")!.status).toBe("COMPLETE");
    });

    it("should rollback transaction on error", () => {
      db.setStatus("TASK-001", "READY", "system");
      expect(() => {
        db.transaction(() => {
          db.setStatus("TASK-001", "IN_PROGRESS", "dispatch");
          throw new Error("deliberate failure");
        });
      }).toThrow("deliberate failure");
      // Status should NOT have changed
      expect(db.getStatus("TASK-001")!.status).toBe("READY");
    });

    it("should return value from transaction", () => {
      const result = db.transaction(() => {
        db.setStatus("TASK-001", "READY", "system");
        return 42;
      });
      expect(result).toBe(42);
    });
  });
});
