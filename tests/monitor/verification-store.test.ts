import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import {
  recordVerification,
  regenerateProjection,
  findDbJsonDrift,
  reconcileVerifiedDrift,
  type VerificationStoreProject,
} from "../../src/monitor/verification-store";
import type { VerifiedRow } from "../../src/db/types";
import type { DuplicateClaimantIndex } from "../../src/core/duplicate-claimants";

class FakeDb {
  getHealth() {
    return { mode: "sqlite" as const, available: true as const };
  }
  private verified = new Map<string, VerifiedRow>();
  public statusCalls: Array<{ taskId: string; status: string; source: string }> = [];

  setVerified(entry: VerifiedRow): void {
    this.verified.set(entry.task_id, { ...entry });
  }
  getVerified(taskId: string): VerifiedRow | undefined {
    return this.verified.get(taskId);
  }
  getAllVerified(): Map<string, VerifiedRow> {
    return new Map(this.verified);
  }
  setStatus(taskId: string, status: string, source: string): void {
    this.statusCalls.push({ taskId, status, source });
  }
}

function makeProject(): { project: VerificationStoreProject; db: FakeDb; root: string } {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-verify-store-"));
  const db = new FakeDb();
  return { project: { projectRoot: root, db }, db, root };
}

function readJson(root: string): {
  tasks: Record<string, Record<string, unknown>>;
  [k: string]: unknown;
} {
  const raw = fs.readFileSync(path.join(root, ".quack", "verified.json"), "utf-8");
  return JSON.parse(raw) as { tasks: Record<string, Record<string, unknown>> };
}

afterEach(() => {
  // tempdirs are isolated per project; nothing to clean globally
});

describe("recordVerification", () => {
  test("writes both DB row and JSON entry on first call", async () => {
    const { project, db, root } = makeProject();
    await recordVerification(project, {
      taskId: "TASK-001",
      verdict: "VERIFIED",
      commitSha: "abc1234",
      method: "/verify-task",
      criteriaChecked: 5,
      criteriaPassed: 5,
    });

    expect(db.getVerified("TASK-001")).toMatchObject({
      task_id: "TASK-001",
      verdict: "VERIFIED",
      commit_sha: "abc1234",
    });
    const json = readJson(root);
    expect(json.tasks["TASK-001"]).toMatchObject({
      verdict: "VERIFIED",
      commit: "abc1234",
      method: "/verify-task",
    });
  });

  test("advances task_status to COMPLETE on VERIFIED", async () => {
    const { project, db } = makeProject();
    await recordVerification(project, {
      taskId: "TASK-001",
      verdict: "VERIFIED",
      commitSha: "abc0000",
      method: "api",
      criteriaChecked: 1,
      criteriaPassed: 1,
    });
    expect(db.statusCalls).toContainEqual({
      taskId: "TASK-001",
      status: "COMPLETE",
      source: "api",
    });
  });

  test("advances task_status to REJECTED on REJECTED verdict", async () => {
    const { project, db } = makeProject();
    await recordVerification(project, {
      taskId: "TASK-002",
      verdict: "REJECTED",
      commitSha: "n/a",
      method: "api",
      criteriaChecked: 0,
      criteriaPassed: 0,
      notes: "no good",
    });
    expect(db.statusCalls).toContainEqual({
      taskId: "TASK-002",
      status: "REJECTED",
      source: "api",
    });
  });

  test("idempotent: second call updates in place, no duplicate keys", async () => {
    const { project, db, root } = makeProject();
    await recordVerification(project, {
      taskId: "TASK-001",
      verdict: "VERIFIED",
      commitSha: "abc0000",
      method: "/verify-task",
      criteriaChecked: 5,
      criteriaPassed: 5,
    });
    await recordVerification(project, {
      taskId: "TASK-001",
      verdict: "VERIFIED",
      commitSha: "def5678",
      method: "/verify-task",
      criteriaChecked: 5,
      criteriaPassed: 5,
    });

    const json = readJson(root);
    expect(Object.keys(json.tasks)).toEqual(["TASK-001"]);
    expect(json.tasks["TASK-001"]?.commit).toBe("def5678");
    expect(db.getVerified("TASK-001")?.commit_sha).toBe("def5678");
  });

  test("ranks by write recency, not lexical commit SHA (QPI-022)", async () => {
    const { project, db } = makeProject();
    // 1. Genuine verification with a real, low-sorting hex SHA.
    await recordVerification(project, {
      taskId: "TASK-Q22",
      verdict: "VERIFIED",
      commitSha: "0aa1111",
      method: "/verify-task",
      criteriaChecked: 1,
      criteriaPassed: 1,
      verifiedAt: "2026-05-23",
      updatedAt: "2026-05-23T01:00:00.000Z",
    });
    // 2. A LATER junk write with a high-sorting placeholder (the QPI-022 hijack, e.g. a rollback).
    //    It legitimately wins by recency.
    await recordVerification(project, {
      taskId: "TASK-Q22",
      verdict: "FAILED",
      commitSha: "zzzz-rollback",
      method: "admin-rollback",
      criteriaChecked: 0,
      criteriaPassed: 0,
      verifiedAt: "2026-05-23",
      updatedAt: "2026-05-23T02:00:00.000Z",
    });
    expect(db.getVerified("TASK-Q22")?.verdict).toBe("FAILED");
    // 3. A genuine re-verify written EVEN LATER, with a real SHA that sorts BELOW "zzzz", must WIN.
    //    Under the old lexical-SHA precedence this was wrongly rejected as "stale".
    const res = await recordVerification(project, {
      taskId: "TASK-Q22",
      verdict: "VERIFIED",
      commitSha: "1bb2222",
      method: "/verify-task",
      criteriaChecked: 1,
      criteriaPassed: 1,
      verifiedAt: "2026-05-23",
      updatedAt: "2026-05-23T03:00:00.000Z",
    });
    expect(res.applied).toBe(true);
    expect(db.getVerified("TASK-Q22")?.verdict).toBe("VERIFIED");
    expect(db.getVerified("TASK-Q22")?.commit_sha).toBe("1bb2222");
    // 4. An OLDER write (earlier updated_at) with a high-sorting SHA must be rejected as stale.
    const stale = await recordVerification(project, {
      taskId: "TASK-Q22",
      verdict: "FAILED",
      commitSha: "zzzz-late-loser",
      method: "admin-rollback",
      criteriaChecked: 0,
      criteriaPassed: 0,
      verifiedAt: "2026-05-23",
      updatedAt: "2026-05-23T02:30:00.000Z",
    });
    expect(stale.applied).toBe(false);
    expect(stale.skippedReason).toBe("stale");
    expect(db.getVerified("TASK-Q22")?.verdict).toBe("VERIFIED");
  });

  test("composes notes with workflowId + reviewId + freeform", async () => {
    const { project, db } = makeProject();
    await recordVerification(project, {
      taskId: "TASK-003",
      verdict: "VERIFIED",
      commitSha: "abc0000",
      method: "federated-orchestrator",
      criteriaChecked: 3,
      criteriaPassed: 3,
      reviewId: "review-task-003-1",
      workflowId: "workflow-1",
      notes: "ran in tier-2",
    });
    const notes = db.getVerified("TASK-003")?.notes;
    expect(notes).toMatch(/workflowId=workflow-1/);
    expect(notes).toMatch(/reviewId=review-task-003-1/);
    expect(notes).toMatch(/ran in tier-2/);
  });

  test("preserves existing JSON entries when writing a new task", async () => {
    const { project, root } = makeProject();
    await recordVerification(project, {
      taskId: "TASK-001",
      verdict: "VERIFIED",
      commitSha: "aaaaaaa",
      method: "api",
      criteriaChecked: 1,
      criteriaPassed: 1,
    });
    await recordVerification(project, {
      taskId: "TASK-002",
      verdict: "VERIFIED",
      commitSha: "bbbbbbb",
      method: "api",
      criteriaChecked: 1,
      criteriaPassed: 1,
    });

    const json = readJson(root);
    expect(Object.keys(json.tasks).sort()).toEqual(["TASK-001", "TASK-002"]);
  });

  test("reports only projection durability stages completed by the current platform", async () => {
    const { project } = makeProject();
    const observed: string[] = [];

    await recordVerification(
      project,
      {
        taskId: "TASK-DURABLE-PROJECTION",
        verdict: "VERIFIED",
        commitSha: "d0ab1e0",
        method: "federated-orchestrator",
        criteriaChecked: 1,
        criteriaPassed: 1,
      },
      {
        afterProjectionPersistenceStageForTest: (stage) => {
          observed.push(stage);
        },
      },
    );

    expect(observed).toEqual([
      "projection_temp_file_synced",
      "projection_published",
      "projection_published_file_synced",
      ...(process.platform === "win32" ? [] : ["projection_directory_synced"]),
      "projection_durability_acknowledged",
    ]);
  });

  test("serializes concurrent projections from different verification owners", async () => {
    const { project, root } = makeProject();
    let announceFirstRead!: () => void;
    let releaseFirstRead!: () => void;
    const firstRead = new Promise<void>((resolve) => {
      announceFirstRead = resolve;
    });
    const mayWriteFirst = new Promise<void>((resolve) => {
      releaseFirstRead = resolve;
    });
    let secondRead = false;

    const first = recordVerification(
      project,
      {
        taskId: "TASK-CONCURRENT-A",
        verdict: "VERIFIED",
        commitSha: "aaaaaaa",
        method: "federated-orchestrator",
        criteriaChecked: 1,
        criteriaPassed: 1,
      },
      {
        afterProjectionReadForTest: async () => {
          announceFirstRead();
          await mayWriteFirst;
        },
      },
    );
    await firstRead;
    const second = recordVerification(
      project,
      {
        taskId: "TASK-CONCURRENT-B",
        verdict: "VERIFIED",
        commitSha: "bbbbbbb",
        method: "federated-orchestrator",
        criteriaChecked: 1,
        criteriaPassed: 1,
      },
      {
        afterProjectionReadForTest: () => {
          secondRead = true;
        },
      },
    );
    await new Promise<void>((resolve) => setImmediate(resolve));
    const secondReadBeforeRelease = secondRead;
    releaseFirstRead();
    await Promise.all([first, second]);

    expect(secondReadBeforeRelease).toBe(false);
    expect(Object.keys(readJson(root).tasks).sort()).toEqual([
      "TASK-CONCURRENT-A",
      "TASK-CONCURRENT-B",
    ]);
  });

  test("serializes full projection regeneration behind an in-flight entry update", async () => {
    const { project, db, root } = makeProject();
    let announceRead!: () => void;
    let releaseRead!: () => void;
    const readStarted = new Promise<void>((resolve) => {
      announceRead = resolve;
    });
    const mayPublish = new Promise<void>((resolve) => {
      releaseRead = resolve;
    });
    const originalGetAllVerified = db.getAllVerified.bind(db);
    let regenerationRead = false;
    const getAllVerified = jest.spyOn(db, "getAllVerified").mockImplementation(() => {
      regenerationRead = true;
      return originalGetAllVerified();
    });

    const update = recordVerification(
      project,
      {
        taskId: "TASK-CONCURRENT-REGENERATE",
        verdict: "VERIFIED",
        commitSha: "0e9e0e0",
        method: "federated-orchestrator",
        criteriaChecked: 1,
        criteriaPassed: 1,
      },
      {
        afterProjectionReadForTest: async () => {
          announceRead();
          await mayPublish;
        },
      },
    );
    await readStarted;
    const regeneration = regenerateProjection(project);
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(regenerationRead).toBe(false);
    releaseRead();
    await Promise.all([update, regeneration]);
    expect(getAllVerified).toHaveBeenCalledTimes(1);
    expect(readJson(root).tasks["TASK-CONCURRENT-REGENERATE"]).toBeDefined();
  });

  test("emits deterministic byte output (same input -> identical bytes)", async () => {
    const { project: a } = makeProject();
    const { project: b } = makeProject();
    const entry = {
      taskId: "TASK-001",
      verdict: "VERIFIED" as const,
      commitSha: "abc0000",
      method: "api",
      criteriaChecked: 5,
      criteriaPassed: 5,
      verifiedAt: "2026-04-29",
    };
    await recordVerification(a, entry);
    await recordVerification(b, entry);
    const aBytes = fs.readFileSync(path.join(a.projectRoot ?? "", ".quack", "verified.json"));
    const bBytes = fs.readFileSync(path.join(b.projectRoot ?? "", ".quack", "verified.json"));
    expect(aBytes.toString()).toBe(bBytes.toString());
  });

  test("respects updateTaskStatus: false", async () => {
    const { project, db } = makeProject();
    await recordVerification(
      project,
      {
        taskId: "TASK-001",
        verdict: "VERIFIED",
        commitSha: "abc0000",
        method: "api",
        criteriaChecked: 1,
        criteriaPassed: 1,
      },
      { updateTaskStatus: false },
    );
    expect(db.statusCalls).toEqual([]);
  });

  test("preserves hyphenated child task IDs across repeated writes and projection rebuilds", async () => {
    const { project, db, root } = makeProject();
    const entry = {
      taskId: "TASK-875-C",
      verdict: "VERIFIED" as const,
      commitSha: "1e8c46a42",
      method: "/verify-task",
      criteriaChecked: 22,
      criteriaPassed: 22,
      reviewId: "review-task-875-c-1",
    };

    await recordVerification(project, entry);
    await regenerateProjection(project);
    await recordVerification(project, entry);
    await regenerateProjection(project);

    expect(db.getVerified("TASK-875-C")).toMatchObject({
      task_id: "TASK-875-C",
      commit_sha: "1e8c46a42",
      verdict: "VERIFIED",
    });
    const json = readJson(root);
    expect(json.tasks["TASK-875-C"]).toMatchObject({
      commit: "1e8c46a42",
      verdict: "VERIFIED",
      reviewId: "review-task-875-c-1",
    });
    expect(Object.keys(json.tasks).filter((taskId) => taskId === "TASK-875-C")).toHaveLength(1);
  });
});

describe("regenerateProjection", () => {
  test("rebuilds JSON from DB rows with sorted task IDs", async () => {
    const { project, db, root } = makeProject();
    db.setVerified({
      task_id: "TASK-002",
      verified_at: "2026-04-29",
      commit_sha: "bbbbbbb",
      method: "api",
      verdict: "VERIFIED",
      criteria_checked: 1,
      criteria_passed: 1,
      notes: null,
    });
    db.setVerified({
      task_id: "TASK-001",
      verified_at: "2026-04-29",
      commit_sha: "aaaaaaa",
      method: "api",
      verdict: "VERIFIED",
      criteria_checked: 1,
      criteria_passed: 1,
      notes: null,
    });

    const result = await regenerateProjection(project);
    expect(result.entryCount).toBe(2);
    const json = readJson(root);
    expect(Object.keys(json.tasks)).toEqual(["TASK-001", "TASK-002"]);
  });

  test("idempotent: regenerating twice produces identical bytes", async () => {
    const { project, db } = makeProject();
    db.setVerified({
      task_id: "TASK-001",
      verified_at: "2026-04-29",
      commit_sha: "aaaaaaa",
      method: "api",
      verdict: "VERIFIED",
      criteria_checked: 1,
      criteria_passed: 1,
      notes: null,
    });
    await regenerateProjection(project);
    const first = fs.readFileSync(path.join(project.projectRoot ?? "", ".quack", "verified.json"));
    await regenerateProjection(project);
    const second = fs.readFileSync(path.join(project.projectRoot ?? "", ".quack", "verified.json"));
    expect(first.toString()).toBe(second.toString());
  });
});

describe("findDbJsonDrift", () => {
  test("detects DB rows missing from JSON", async () => {
    const { project, db } = makeProject();
    db.setVerified({
      task_id: "TASK-DBONLY",
      verified_at: "2026-04-29",
      commit_sha: "x",
      method: "api",
      verdict: "VERIFIED",
      criteria_checked: 1,
      criteria_passed: 1,
      notes: null,
    });
    // No JSON write — simulates the bug where the API endpoint wrote DB only.

    const drift = await findDbJsonDrift(project);
    expect(drift.missingFromJson).toEqual(["TASK-DBONLY"]);
    expect(drift.missingFromDb).toEqual([]);
  });

  test("detects JSON entries missing from DB (production 2026-04-29 case)", async () => {
    const { project, root } = makeProject();
    fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".quack", "verified.json"),
      JSON.stringify({
        tasks: {
          "TASK-JSONONLY": {
            verified: "2026-04-29",
            commit: "abc0000",
            method: "pipeline",
            verdict: "VERIFIED",
            criteriaChecked: 5,
            criteriaPassed: 5,
            notes: null,
          },
        },
      }),
    );

    const drift = await findDbJsonDrift(project);
    expect(drift.missingFromDb).toEqual(["TASK-JSONONLY"]);
    expect(drift.missingFromJson).toEqual([]);
  });

  test("tolerates BOM-prefixed verified.json written by Windows tools", async () => {
    const { project, root } = makeProject();
    fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".quack", "verified.json"),
      "\uFEFF" +
        JSON.stringify({
          tasks: {
            "TASK-BOM": {
              verified: "2026-05-05",
              commit: "abc1234",
              method: "/verify-task",
              verdict: "VERIFIED",
              criteriaChecked: 3,
              criteriaPassed: 3,
              notes: null,
            },
          },
        }),
      "utf-8",
    );

    const drift = await findDbJsonDrift(project);
    expect(drift.missingFromDb).toEqual(["TASK-BOM"]);
    expect(drift.missingFromJson).toEqual([]);
  });
});

describe("reconcileVerifiedDrift — production 2026-04-29 scenario", () => {
  test("backfills DB from JSON entries (lifecycle-manager wrote JSON, DB stayed empty)", async () => {
    // This reproduces the EXACT 2026-04-29 production incident: 18 tasks had
    // verified.json saying VERIFIED but quack.db was empty for those rows,
    // so task_status stayed IN_PROGRESS and dependency resolution stalled.
    const { project, db, root } = makeProject();
    fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".quack", "verified.json"),
      JSON.stringify({
        tasks: {
          "TASK-885": {
            verified: "2026-04-28",
            commit: "5f8543cd9",
            method: "pipeline",
            verdict: "VERIFIED",
            criteriaChecked: 6,
            criteriaPassed: 6,
            notes: "Pipeline lifecycle: 6 criteria checked, 6 passed.",
          },
        },
      }),
    );

    const result = await reconcileVerifiedDrift(project);
    expect(result.jsonToDb).toEqual(["TASK-885"]);
    expect(result.dbToJson).toEqual([]);

    const dbRow = db.getVerified("TASK-885");
    expect(dbRow?.verdict).toBe("VERIFIED");
    expect(dbRow?.commit_sha).toBe("5f8543cd9");
    expect(dbRow?.notes).toMatch(/reconciled-at-startup:json->db/);

    // Status was advanced to COMPLETE
    expect(db.statusCalls).toContainEqual(
      expect.objectContaining({ taskId: "TASK-885", status: "COMPLETE" }),
    );
  });

  test("backfills JSON from DB rows (the API-only-wrote-DB drift)", async () => {
    const { project, db, root } = makeProject();
    db.setVerified({
      task_id: "TASK-001",
      verified_at: "2026-04-29",
      commit_sha: "abc0000",
      method: "api",
      verdict: "VERIFIED",
      criteria_checked: 1,
      criteria_passed: 1,
      notes: null,
    });
    // No JSON.

    const result = await reconcileVerifiedDrift(project);
    expect(result.dbToJson).toEqual(["TASK-001"]);
    const json = readJson(root);
    expect(json.tasks["TASK-001"]?.commit).toBe("abc0000");
  });

  test("idempotent: running twice does not duplicate or churn", async () => {
    const { project, db, root } = makeProject();
    db.setVerified({
      task_id: "TASK-001",
      verified_at: "2026-04-29",
      commit_sha: "abc0000",
      method: "api",
      verdict: "VERIFIED",
      criteria_checked: 1,
      criteria_passed: 1,
      notes: null,
    });
    await reconcileVerifiedDrift(project);
    const first = fs.readFileSync(path.join(root, ".quack", "verified.json"));
    const r2 = await reconcileVerifiedDrift(project);
    const second = fs.readFileSync(path.join(root, ".quack", "verified.json"));
    expect(first.toString()).toBe(second.toString());
    expect(r2.dbToJson).toEqual([]); // already present
    expect(r2.jsonToDb).toEqual([]);
  });

  test("re-asserts COMPLETE status on VERIFIED rows (the 18-task incident fix)", async () => {
    const { project, db } = makeProject();
    db.setVerified({
      task_id: "TASK-885",
      verified_at: "2026-04-28",
      commit_sha: "5f8543cd9",
      method: "pipeline",
      verdict: "VERIFIED",
      criteria_checked: 6,
      criteria_passed: 6,
      notes: null,
    });

    const result = await reconcileVerifiedDrift(project);
    expect(result.taskStatusFixed).toContain("TASK-885");
    expect(db.statusCalls).toContainEqual(
      expect.objectContaining({ taskId: "TASK-885", status: "COMPLETE", source: "reconcile" }),
    );
  });
});

// ─── skipIfExistingVerdict guard (TASK-1201) ───────────────────────────

describe("recordVerification skipIfExistingVerdict", () => {
  const onMergeEntry = {
    taskId: "TASK-100",
    verdict: "SOFT-VERIFIED" as const,
    commitSha: "ae09e99",
    method: "on-merge",
    criteriaChecked: 0,
    criteriaPassed: 0,
    notes: "on-merge: [TASK-100] merged",
  };

  test("skips when the existing verdict is VERIFIED, leaving the row byte-identical", async () => {
    const { project, db } = makeProject();
    await recordVerification(project, {
      taskId: "TASK-100",
      verdict: "VERIFIED",
      commitSha: "aaa1111",
      method: "/verify-task",
      criteriaChecked: 5,
      criteriaPassed: 5,
    });
    const before = db.getVerified("TASK-100");
    const statusCallsBefore = db.statusCalls.length;

    const result = await recordVerification(project, onMergeEntry, {
      skipIfExistingVerdict: ["VERIFIED", "SOFT-VERIFIED"],
    });

    expect(result.applied).toBe(false);
    expect(result.skippedReason).toBe("existing-verdict");
    expect(result.row).toEqual(before);
    expect(db.getVerified("TASK-100")).toEqual(before);
    expect(db.statusCalls.length).toBe(statusCallsBefore);
  });

  test("skips when the existing verdict is SOFT-VERIFIED (idempotent re-scan)", async () => {
    const { project, db } = makeProject();
    await recordVerification(project, { ...onMergeEntry, commitSha: "f100001" });
    const before = db.getVerified("TASK-100");

    const result = await recordVerification(
      project,
      { ...onMergeEntry, commitSha: "5ec0002" },
      {
        skipIfExistingVerdict: ["VERIFIED", "SOFT-VERIFIED"],
      },
    );

    expect(result.applied).toBe(false);
    expect(result.skippedReason).toBe("existing-verdict");
    expect(db.getVerified("TASK-100")).toEqual(before);
  });

  test("does not skip when the existing verdict is outside the list", async () => {
    const { project, db } = makeProject();
    await recordVerification(project, {
      taskId: "TASK-100",
      verdict: "FAILED",
      commitSha: "bad0001",
      method: "api",
      criteriaChecked: 3,
      criteriaPassed: 1,
    });

    const result = await recordVerification(project, onMergeEntry, {
      skipIfExistingVerdict: ["VERIFIED", "SOFT-VERIFIED"],
    });

    expect(result.applied).toBe(true);
    expect(db.getVerified("TASK-100")).toMatchObject({
      verdict: "SOFT-VERIFIED",
      commit_sha: "ae09e99",
    });
  });

  test("without the option, recency precedence still lets a newer write replace", async () => {
    const { project, db } = makeProject();
    await recordVerification(project, {
      taskId: "TASK-100",
      verdict: "VERIFIED",
      commitSha: "aaa1111",
      method: "/verify-task",
      criteriaChecked: 5,
      criteriaPassed: 5,
      updatedAt: "2026-07-01T00:00:00.000Z",
    });

    const result = await recordVerification(project, onMergeEntry);

    expect(result.applied).toBe(true);
    expect(db.getVerified("TASK-100")).toMatchObject({ verdict: "SOFT-VERIFIED" });
  });

  test("skip leaves the JSON ledger entry untouched", async () => {
    const { project, root } = makeProject();
    await recordVerification(project, {
      taskId: "TASK-100",
      verdict: "VERIFIED",
      commitSha: "aaa1111",
      method: "/verify-task",
      criteriaChecked: 5,
      criteriaPassed: 5,
    });

    await recordVerification(project, onMergeEntry, {
      skipIfExistingVerdict: ["VERIFIED", "SOFT-VERIFIED"],
    });

    const json = readJson(root);
    expect(json.tasks["TASK-100"]).toMatchObject({ verdict: "VERIFIED", method: "/verify-task" });
  });
});

describe("TASK-1338-F positive-token claimant guard", () => {
  const contested: DuplicateClaimantIndex = {
    status: "scanned",
    contested: new Map([["TASK-100", ["TASK-100-a.md", "TASK-999-b.md"]]]),
  };
  const unavailable: DuplicateClaimantIndex = {
    status: "unavailable",
    reason: "Duplicate claimant scan failed: access denied",
  };
  const verifiedEntry = {
    taskId: "TASK-100",
    verdict: "VERIFIED" as const,
    commitSha: "cea0001",
    method: "api",
    criteriaChecked: 2,
    criteriaPassed: 2,
    updatedAt: "2026-08-18T12:00:00.000Z",
  };

  test.each([
    ["contested", contested, "duplicate-claimants"],
    ["unavailable", unavailable, "claimant-index-unavailable"],
  ] as const)(
    "returns an expanded non-applied result for a %s positive write",
    async (_arm, index, reason) => {
      const { project, db, root } = makeProject();

      const result = await recordVerification(project, verifiedEntry, {}, index);

      expect(result.applied).toBe(false);
      expect(result.skippedReason).toBe(reason);
      expect(result.refusal).toBeDefined();
      expect(db.getVerified("TASK-100")).toBeUndefined();
      expect(db.statusCalls).toEqual([]);
      expect(fs.existsSync(path.join(root, ".quack", "verified.json"))).toBe(false);
    },
  );

  test("does not gate a negative verification verdict", async () => {
    const { project, db } = makeProject();
    const result = await recordVerification(
      project,
      {
        ...verifiedEntry,
        verdict: "FAILED",
      },
      {},
      contested,
    );

    expect(result.applied).toBe(true);
    expect(db.getVerified("TASK-100")?.verdict).toBe("FAILED");
  });

  test.each([
    ["existing-verdict", { skipIfExistingVerdict: ["VERIFIED"] as string[] }],
    ["stale", {}],
    ["identical", {}],
  ] as const)("keeps the %s no-op ahead of the claimant check", async (arm, options) => {
    const { project, db, root } = makeProject();
    const first = {
      ...verifiedEntry,
      commitSha: "e115710",
      updatedAt: "2026-08-18T11:00:00.000Z",
    };
    await recordVerification(project, first);
    const beforeRow = db.getVerified("TASK-100");
    const beforeStatusCalls = [...db.statusCalls];
    const beforeJson = fs.readFileSync(path.join(root, ".quack", "verified.json"));
    const candidate =
      arm === "stale"
        ? { ...verifiedEntry, updatedAt: "2026-08-18T10:00:00.000Z" }
        : arm === "identical"
          ? first
          : verifiedEntry;

    const result = await recordVerification(project, candidate, options, contested);

    expect(result).toMatchObject({ applied: false, skippedReason: arm });
    expect(db.getVerified("TASK-100")).toEqual(beforeRow);
    expect(db.statusCalls).toEqual(beforeStatusCalls);
    expect(fs.readFileSync(path.join(root, ".quack", "verified.json"))).toEqual(beforeJson);
  });

  test("reconcile skips positive promotions but preserves a negative JSON to DB write", async () => {
    const { project, db, root } = makeProject();
    fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".quack", "verified.json"),
      JSON.stringify({
        tasks: {
          "TASK-100": {
            verified: "2026-08-18",
            commit: "905171e",
            method: "api",
            verdict: "VERIFIED",
            criteriaChecked: 1,
            criteriaPassed: 1,
          },
          "TASK-200": {
            verified: "2026-08-18",
            commit: "negative",
            method: "api",
            verdict: "REJECTED",
            criteriaChecked: 1,
            criteriaPassed: 0,
          },
        },
      }),
      "utf-8",
    );
    const log = jest.fn();

    const result = await reconcileVerifiedDrift(project, { claimantIndex: contested, log });

    expect(result.jsonToDb).toEqual(["TASK-200"]);
    expect(result.promotionsSkipped).toEqual(["TASK-100"]);
    expect(db.getVerified("TASK-100")).toBeUndefined();
    expect(db.getVerified("TASK-200")?.verdict).toBe("REJECTED");
    expect(db.statusCalls).toContainEqual({
      taskId: "TASK-200",
      status: "REJECTED",
      source: "reconcile",
    });
    expect(log).toHaveBeenCalledWith(expect.stringContaining("TASK-100"));
  });

  // CONTROL, added after the executed unavailable writer red. The preceding
  // reconciliation red covers the positive skip; this pins the aggregate
  // summary arm and negative-write preservation together.
  test("reconcile reports unavailable while preserving negative writes", async () => {
    const { project, db, root } = makeProject();
    fs.mkdirSync(path.join(root, ".quack"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".quack", "verified.json"),
      JSON.stringify({
        tasks: {
          "TASK-100": {
            verified: "2026-08-18",
            commit: "905171e",
            method: "api",
            verdict: "VERIFIED",
            criteriaChecked: 1,
            criteriaPassed: 1,
          },
          "TASK-200": {
            verified: "2026-08-18",
            commit: "negative",
            method: "api",
            verdict: "REJECTED",
            criteriaChecked: 1,
            criteriaPassed: 0,
          },
        },
      }),
      "utf-8",
    );

    const result = await reconcileVerifiedDrift(project, { claimantIndex: unavailable });

    expect(result.unavailable).toBe(unavailable.reason);
    expect(result.promotionsSkipped).toEqual(["TASK-100"]);
    expect(db.getVerified("TASK-100")).toBeUndefined();
    expect(db.getVerified("TASK-200")?.verdict).toBe("REJECTED");
  });
});
