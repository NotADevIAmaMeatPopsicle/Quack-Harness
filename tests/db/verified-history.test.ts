// ─── verified_history (TASK-1321) ───────────────────────────────────
// `verified` keys on task_id and its writer uses ON CONFLICT DO UPDATE,
// so it holds only the LATEST verdict. The design doc called it an
// append-only audit ledger; it never was. A re-verification silently
// destroyed the prior verdict, so there was no way to see that a task
// was VERIFIED and later re-verified differently.
//
// These pin both halves: history accumulates, and the latest-verdict
// lookup every existing reader depends on is untouched.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { QuackDB } from "../../src/db/quack-db";
import type { VerifiedRow } from "../../src/db/types";

const dbs: QuackDB[] = [];
const dirs: string[] = [];

function makeDb(): QuackDB {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1321-"));
  dirs.push(dir);
  const db = new QuackDB(path.join(dir, "quack.db"));
  dbs.push(db);
  return db;
}

function row(overrides: Partial<VerifiedRow> = {}): VerifiedRow {
  return {
    task_id: "TASK-1",
    verified_at: "2026-08-08T00:00:00.000Z",
    commit_sha: "abc1234",
    method: "admin-9-phase",
    verdict: "VERIFIED",
    criteria_checked: 3,
    criteria_passed: 3,
    notes: null,
    ...overrides,
  } as VerifiedRow;
}

afterAll(() => {
  for (const db of dbs) {
    try {
      db.close();
    } catch {
      // already closed
    }
  }
  for (const dir of dirs) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
    } catch {
      // Windows can hold a sqlite handle briefly after close.
    }
  }
});

describe("verified_history accumulates what `verified` overwrites", () => {
  it("a re-verification keeps BOTH verdicts in history and only the latest in verified", () => {
    // THE case this table exists for. Before TASK-1321 the first verdict
    // was destroyed by the second and nothing recorded that it had ever
    // existed.
    const db = makeDb();
    db.setVerified(row({ verdict: "VERIFIED", commit_sha: "aaa1111" }));
    db.setVerified(row({ verdict: "SOFT-VERIFIED", commit_sha: "bbb2222" }));

    const latest = db.getVerified("TASK-1");
    expect(latest?.verdict).toBe("SOFT-VERIFIED");
    expect(latest?.commit_sha).toBe("bbb2222");

    const history = db.getVerifiedHistory("TASK-1");
    expect(history.map((h) => h.verdict)).toEqual(["VERIFIED", "SOFT-VERIFIED"]);
    expect(history.map((h) => h.commit_sha)).toEqual(["aaa1111", "bbb2222"]);
  });

  it("each history row names the verdict it replaced", () => {
    // Stored rather than derived so a reader can see a TRANSITION
    // without walking the whole history.
    const db = makeDb();
    db.setVerified(row({ verdict: "VERIFIED" }));
    db.setVerified(row({ verdict: "REJECTED" }));
    db.setVerified(row({ verdict: "VERIFIED" }));

    expect(db.getVerifiedHistory("TASK-1").map((h) => h.previous_verdict)).toEqual([
      null, // first write for the task
      "VERIFIED",
      "REJECTED",
    ]);
  });

  it("history is per task and ordered oldest first", () => {
    const db = makeDb();
    db.setVerified(row({ task_id: "TASK-A", verdict: "VERIFIED" }));
    db.setVerified(row({ task_id: "TASK-B", verdict: "REJECTED" }));
    db.setVerified(row({ task_id: "TASK-A", verdict: "SOFT-VERIFIED" }));

    expect(db.getVerifiedHistory("TASK-A").map((h) => h.verdict)).toEqual([
      "VERIFIED",
      "SOFT-VERIFIED",
    ]);
    expect(db.getVerifiedHistory("TASK-B").map((h) => h.verdict)).toEqual(["REJECTED"]);
    expect(db.getVerifiedHistory("TASK-NONE")).toEqual([]);
  });

  it("the latest-verdict lookup every existing reader uses is unchanged", () => {
    // The availability control. This table is purely additive; if
    // `getVerified` or `getAllVerified` moved, every consumer of the
    // register would be affected and the change would not be additive
    // at all.
    const db = makeDb();
    db.setVerified(row({ task_id: "TASK-A", verdict: "VERIFIED", criteria_passed: 2 }));
    db.setVerified(row({ task_id: "TASK-B", verdict: "SOFT-VERIFIED" }));

    const all = db.getAllVerified();
    expect(all.size).toBe(2);
    expect(all.get("TASK-A")?.verdict).toBe("VERIFIED");
    expect(all.get("TASK-A")?.criteria_passed).toBe(2);
    expect(all.get("TASK-B")?.verdict).toBe("SOFT-VERIFIED");
  });

  it("an identical re-write still appends, because a re-verification IS an event", () => {
    // Deliberate: two identical verdicts are not a no-op. Somebody ran
    // the verification twice and the audit trail should say so.
    const db = makeDb();
    db.setVerified(row({ verdict: "VERIFIED" }));
    db.setVerified(row({ verdict: "VERIFIED" }));

    expect(db.getVerifiedHistory("TASK-1")).toHaveLength(2);
    expect(db.getVerifiedHistory("TASK-1")[1].previous_verdict).toBe("VERIFIED");
  });
});
