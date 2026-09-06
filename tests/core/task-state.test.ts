// ─── Task state resolver (TASK-1317, P2-3) ──────────────────────────
// The no-change promise is PROVEN here, not asserted: `legacyResolve`
// below is the pre-1317 chain copied verbatim from task-projection.ts
// as an independent oracle, and the compatibility matrix runs the real
// resolver against it over the value space that actually varies.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  DEFERRED_STATE_READERS,
  TASK_STATE_AUTHORITIES,
  TASK_STATE_PRECEDENCE,
  TASK_STATE_UNIVERSE,
  deriveSessionStatus,
  resolveTaskState,
  type TaskStateSessionInput,
} from "../../src/core/task-state";
import { TASK_STATUSES, isCompleteStatus } from "../../src/core/task-status";
import { isTerminalTaskStatus } from "../../src/monitor/task-projection";

// ─── The oracle: the pre-1317 implementation, verbatim ──────────────

function legacyDerive(fileStatus: string, session?: TaskStateSessionInput): string {
  if (!session) return fileStatus;
  if (fileStatus === "COMPLETE" || fileStatus === "VERIFIED") return fileStatus;
  if (session.outcome === "approved") return "COMPLETE";
  if (session.status === "active") return "IN_PROGRESS";
  if (
    (session.outcome === "rejected" || session.outcome === "agent_failed") &&
    fileStatus === "IN_PROGRESS"
  ) {
    return "REJECTED";
  }
  return fileStatus;
}

function legacyResolve(
  spec: string,
  runtime: string | undefined,
  session?: TaskStateSessionInput,
): string {
  // `dbStatus?.status ?? sessionEffectiveStatus` — note `??`, so an
  // empty-string runtime row wins.
  return runtime ?? legacyDerive(spec, session);
}

// ─── The value space that actually varies ───────────────────────────

const SPEC_VALUES = [
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
  "COMPLETE",
  "VERIFIED",
  "REJECTED",
  "on-hold",
  "",
  "PAUSED",
];

const RUNTIME_VALUES: (string | undefined)[] = [
  undefined,
  "COMPLETE",
  "IN_PROGRESS",
  "on-hold",
  "",
  "PAUSED",
];

const SESSIONS: (TaskStateSessionInput | undefined)[] = [
  undefined,
  { outcome: "approved", status: "completed" },
  { outcome: "rejected", status: "completed" },
  { outcome: "agent_failed", status: "completed" },
  { outcome: "running", status: "active" },
  { outcome: "unknown", status: "completed" },
];

describe("TASK-1317: resolveTaskState compatibility matrix", () => {
  it("is byte-identical to the pre-1317 chain across the whole value space", () => {
    const mismatches: string[] = [];
    let cases = 0;

    for (const spec of SPEC_VALUES) {
      for (const runtime of RUNTIME_VALUES) {
        for (const session of SESSIONS) {
          cases += 1;
          const expected = legacyResolve(spec, runtime, session);
          const actual = resolveTaskState({
            spec,
            ...(runtime !== undefined ? { runtime } : {}),
            ...(session ? { session } : {}),
          }).status;
          if (actual !== expected) {
            mismatches.push(
              `spec=${JSON.stringify(spec)} runtime=${JSON.stringify(runtime)} ` +
                `session=${JSON.stringify(session)} expected=${JSON.stringify(expected)} ` +
                `actual=${JSON.stringify(actual)}`,
            );
          }
        }
      }
    }

    expect(mismatches).toEqual([]);
    // Guard against the matrix silently shrinking to nothing.
    expect(cases).toBe(SPEC_VALUES.length * RUNTIME_VALUES.length * SESSIONS.length);
    expect(cases).toBeGreaterThan(300);
  });

  it("keeps the `??` quirk: an EMPTY-STRING runtime row still wins", () => {
    const resolved = resolveTaskState({ spec: "BACKLOG", runtime: "" });
    expect(resolved.status).toBe("");
    expect(resolved.authority).toBe("runtime");
    // And it has no canonical form, which is exactly what typedStatus
    // is for.
    expect(resolved.typedStatus).toBeNull();
  });

  it("never normalizes the raw value (round-1 F2)", () => {
    expect(resolveTaskState({ spec: "BACKLOG", runtime: "on-hold" }).status).toBe("on-hold");
    expect(resolveTaskState({ spec: "PAUSED" }).status).toBe("PAUSED");
  });

  it("adds the typed view alongside, normalizing aliases and rejecting unknowns", () => {
    expect(resolveTaskState({ spec: "BACKLOG", runtime: "on-hold" }).typedStatus).toBe("ON_HOLD");
    expect(resolveTaskState({ spec: "PAUSED" }).typedStatus).toBeNull();
    expect(resolveTaskState({ spec: "COMPLETE" }).typedStatus).toBe("COMPLETE");
  });
});

describe("TASK-1317: precedence and authority", () => {
  it("declares precedence as walkable data, runtime before session before spec", () => {
    expect(TASK_STATE_PRECEDENCE.map((entry) => entry.authority)).toEqual([
      "runtime",
      "session",
      "spec",
    ]);
    for (const entry of TASK_STATE_PRECEDENCE) {
      expect(entry.rationale.length).toBeGreaterThan(20);
    }
  });

  it("attributes each source correctly, including session-derived status", () => {
    expect(resolveTaskState({ spec: "READY", runtime: "COMPLETE" }).authority).toBe("runtime");
    // The concrete case round 1 confirmed: approved session, no runtime
    // row, produces a COMPLETE nothing else supports.
    const sessionDerived = resolveTaskState({
      spec: "READY",
      session: { outcome: "approved", status: "completed" },
    });
    expect(sessionDerived.status).toBe("COMPLETE");
    expect(sessionDerived.authority).toBe("session");
    expect(resolveTaskState({ spec: "READY" }).authority).toBe("spec");
  });

  it("has NO ledger authority: verification is evidence, never a supplier", () => {
    expect(TASK_STATE_AUTHORITIES).not.toContain("ledger");
    const resolved = resolveTaskState({
      spec: "BACKLOG",
      verification: {
        verdict: "VERIFIED",
        method: "on-merge",
        commitSha: "abc1234",
        verifiedAt: "2026-08-06",
      },
    });
    // The register says VERIFIED and the status is still BACKLOG. That
    // is the honest contract for this task; P2-4 moves authority.
    expect(resolved.status).toBe("BACKLOG");
    expect(resolved.authority).toBe("spec");
    expect(resolved.verification?.verdict).toBe("VERIFIED");
  });

  it("surfaces the verdict so the two-tier done state is representable", () => {
    for (const verdict of ["VERIFIED", "SOFT-VERIFIED"]) {
      const resolved = resolveTaskState({
        spec: "COMPLETE",
        verification: { verdict, method: "on-merge", commitSha: "a", verifiedAt: "b" },
      });
      expect(resolved.verification?.verdict).toBe(verdict);
    }
  });

  // Regression pin, not migration proof (round-2 F5): this encodes
  // behavior that already existed. Its value is that a future edit to
  // the moved copy fails loudly.
  it("moved the session derivation verbatim", () => {
    for (const spec of SPEC_VALUES) {
      for (const session of SESSIONS) {
        expect(deriveSessionStatus(spec, session)).toBe(legacyDerive(spec, session));
      }
    }
  });
});

// Regression pins (round-2 F5): the REJECTED distinction predates this
// task. Pinned here because S5 deleted two copies of the neighbouring
// predicate, and a later "simplification" collapsing them would be a
// silent eligibility bug.
describe("TASK-1317: doneness predicates stay distinct", () => {
  it("REJECTED is terminal but NOT complete", () => {
    // Collapsing these would silently let rejected work unblock its
    // dependents. This pin is the reason S5 de-duplicates only the two
    // identical copies.
    expect(isTerminalTaskStatus("REJECTED")).toBe(true);
    expect(isCompleteStatus("REJECTED")).toBe(false);
  });

  it("agrees on every other status in the union", () => {
    for (const status of TASK_STATUSES) {
      if (status === "REJECTED") continue;
      expect(isCompleteStatus(status)).toBe(isTerminalTaskStatus(status));
    }
  });

  it("accepts the widened input both former copies used", () => {
    expect(isCompleteStatus(undefined)).toBe(false);
    expect(isCompleteStatus(null)).toBe(false);
    expect(isCompleteStatus("")).toBe(false);
    expect(isCompleteStatus("COMPLETE")).toBe(true);
    expect(isCompleteStatus("VERIFIED")).toBe(true);
  });
});

// ─── The integration reachability matrix (S7, round-2 F3) ───────────
// The value matrix above proves compatibility over raw values. It does
// NOT say which of those values a real parsed task can actually carry.
// Round 1 required both, and only one was built; this is the other.
// Classifying honestly matters because it is the difference between
// "we tested the real world" and "we tested a cross product".

type Reachability = "reachable" | "legacy-or-corrupt" | "impossible";

interface ReachabilityRow {
  label: string;
  reachability: Reachability;
  why: string;
}

const REACHABILITY: ReachabilityRow[] = [
  {
    label: "spec status is a canonical TaskStatus",
    reachability: "reachable",
    why: "The parser normalizes known aliases and this is the ordinary case.",
  },
  {
    label: "spec status is an unknown value such as PAUSED",
    reachability: "legacy-or-corrupt",
    why: "The parser rejects or warns on unknown statuses, so this reaches the resolver only via a hand-edited or legacy spec — which is exactly why the resolver must not crash on it.",
  },
  {
    label: "runtime row holds an alias such as on-hold",
    reachability: "legacy-or-corrupt",
    why: "The DB has no enum constraint and lifecycle values arrive as free strings, so old rows can hold non-canonical values.",
  },
  {
    label: "runtime row holds an empty string",
    reachability: "legacy-or-corrupt",
    why: "Nothing forbids it at the storage layer, and the `??` chain lets it win — the quirk pinned above.",
  },
  {
    label: "no spec status at all",
    reachability: "impossible",
    why: "`spec` is a required input and the resolver throws; the universe is spec-parsed tasks.",
  },
  {
    label: "verification evidence with no runtime row",
    reachability: "reachable",
    why: "recordVerification writes the register and normally advances status, but a reader can observe the register before the status write lands (the named torn-read window).",
  },
];

describe("TASK-1317: integration reachability matrix", () => {
  it("classifies every matrix input class, with a reason", () => {
    expect(REACHABILITY.length).toBeGreaterThanOrEqual(6);
    for (const row of REACHABILITY) {
      expect(["reachable", "legacy-or-corrupt", "impossible"]).toContain(row.reachability);
      expect(row.why.length).toBeGreaterThan(30);
    }
    // The point of the classification: legacy/corrupt inputs are the
    // ones the resolver must survive rather than assume away.
    expect(
      REACHABILITY.filter((r) => r.reachability === "legacy-or-corrupt").length,
    ).toBeGreaterThanOrEqual(3);
  });

  it("the impossible row is genuinely impossible: the resolver THROWS", () => {
    // Round-2 F4: a JS caller can defeat the type, so this is enforced
    // at runtime, not merely declared.
    expect(() => (resolveTaskState as (input: unknown) => unknown)({})).toThrow(
      /requires a string `spec`/,
    );
    expect(() => (resolveTaskState as (input: unknown) => unknown)({ spec: undefined })).toThrow(
      TypeError,
    );
  });

  it("survives every legacy-or-corrupt class without throwing", () => {
    expect(resolveTaskState({ spec: "PAUSED" }).status).toBe("PAUSED");
    expect(resolveTaskState({ spec: "BACKLOG", runtime: "on-hold" }).status).toBe("on-hold");
    expect(resolveTaskState({ spec: "BACKLOG", runtime: "" }).status).toBe("");
  });

  it("the precedence table cannot be mutated by a consumer, entries included", () => {
    expect(Object.isFrozen(TASK_STATE_PRECEDENCE)).toBe(true);
    // Round-2b: a shallow freeze protects the container while leaving
    // each entry's `supply` swappable, which is the mutation that would
    // actually change resolution.
    for (const entry of TASK_STATE_PRECEDENCE) {
      expect(Object.isFrozen(entry)).toBe(true);
    }
  });
});

describe("TASK-1317: deferred work stays visible", () => {
  // NOTE (round-2 F5, recorded honestly): the assertions in this block
  // inspect constants introduced by the same commit, so they would fail
  // against the pre-build tree only because the module did not exist.
  // They are REGRESSION pins protecting the inventory from silently
  // shrinking, not proof that a migration happened. The discriminating
  // evidence for this task lives in the compatibility matrix and the
  // batch-read call-count pin.
  it("names every bypassing reader, and each named file still exists", () => {
    expect(DEFERRED_STATE_READERS.length).toBeGreaterThanOrEqual(7);
    for (const entry of DEFERRED_STATE_READERS) {
      expect(fs.existsSync(path.join(process.cwd(), entry.site))).toBe(true);
      // TASK-1318: dispositions now name the actual next step or
      // hazard rather than a task tag, so require substance.
      expect(entry.disposition.length).toBeGreaterThan(40);
      expect(entry.what.length).toBeGreaterThan(20);
    }
  });

  // TASK-1318 RETIRED the propagation, so the writer entry is gone by
  // design. What replaces it is the stronger claim: no writer remains.
  it("no WRITER entries remain: the spec can no longer write runtime state", () => {
    expect(DEFERRED_STATE_READERS.filter((e) => e.kind === "writer")).toEqual([]);
  });

  it("keeps the deferred queue hazard visible rather than just listing the file", () => {
    const queue = DEFERRED_STATE_READERS.find((e) => e.site.includes("dispatch-queue"));
    expect(queue?.disposition).toMatch(/enqueueAllEligible/);
  });

  it("states the task universe rather than implying it", () => {
    expect(TASK_STATE_UNIVERSE).toMatch(/spec-parsed/);
  });
});
