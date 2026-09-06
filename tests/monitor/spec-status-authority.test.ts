// ─── Spec-status authority retirement (TASK-1318, P2-4) ─────────────
// The propagation that wrote terminal spec `Status:` lines into the
// authoritative task_status table is gone (Operator's decision 2026-08-06).
// These are behavior-change pins: this task changes behavior on purpose,
// so the pins assert the NEW contract and guard the availability
// property that must survive it.

import * as fs from "node:fs";
import * as path from "node:path";

import { isCompleteStatus, TASK_STATUSES } from "../../src/core/task-status";
import { isTerminalTaskStatus } from "../../src/monitor/task-projection";
import { resolveTaskState } from "../../src/core/task-state";

function src(rel: string): string {
  return fs.readFileSync(path.join(process.cwd(), rel), "utf-8");
}

describe("TASK-1318: the spec no longer writes the authoritative store", () => {
  it("no source path writes task_status with spec_sync provenance", () => {
    // The retirement, pinned structurally. If someone reintroduces the
    // propagation, this fails before it can launder a markdown edit
    // into runtime authority again.
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of fs.readdirSync(path.join(process.cwd(), dir), { withFileTypes: true })) {
        const rel = `${dir}/${entry.name}`;
        if (entry.isDirectory()) walk(rel);
        else if (rel.endsWith(".ts") && src(rel).includes("spec_sync")) offenders.push(rel);
      }
    };
    walk("src");
    expect(offenders).toEqual([]);
  });

  it("keeps the drift OBSERVATION at both watcher wirings", () => {
    // Retiring the write must not cost the signal. Drift is now more
    // useful, not less, because nothing is silently reconciling it.
    const server = src("src/monitor/server.ts");
    const broadcasts = server.match(/stage: "task_status_drift"/g) ?? [];
    expect(broadcasts).toHaveLength(2);
    // And a rowless spec is NOT drift: that is the ordinary fallback
    // state for the ~262 terminal specs with no row (round-1 F10).
    expect(server).toMatch(/current === undefined\) return; \/\/ rowless/);
  });
});

describe("TASK-1318: availability survives the retirement", () => {
  // The criterion, narrowed after round-1 F1 corrected my original
  // claim: a task whose ONLY completion signal is its spec file must
  // still unblock its dependents. The spec fallback is what guarantees
  // it, so this pins the fallback rather than trusting it.
  it("a spec-only completion still resolves COMPLETE with no runtime row", () => {
    const resolved = resolveTaskState({ spec: "COMPLETE" });
    expect(resolved.status).toBe("COMPLETE");
    expect(resolved.authority).toBe("spec");
    expect(isCompleteStatus(resolved.status)).toBe(true);
  });

  it("a NONTERMINAL runtime row now beats a later terminal spec edit", () => {
    // This is the accepted behavior change, pinned as intended rather
    // than discovered later as a surprise: a live dispatch outranks a
    // markdown claim. That is "DB is truth" doing its job.
    const resolved = resolveTaskState({ spec: "COMPLETE", runtime: "IN_PROGRESS" });
    expect(resolved.status).toBe("IN_PROGRESS");
    expect(resolved.authority).toBe("runtime");
    expect(isCompleteStatus(resolved.status)).toBe(false);
  });
});

describe("TASK-1318: the routed sites use the predicate they MEAN", () => {
  it("dependency satisfaction never counts REJECTED, across the whole union", () => {
    for (const status of TASK_STATUSES) {
      if (status === "REJECTED") {
        expect(isCompleteStatus(status)).toBe(false);
        expect(isTerminalTaskStatus(status)).toBe(true);
      } else {
        expect(isCompleteStatus(status)).toBe(isTerminalTaskStatus(status));
      }
    }
  });

  // REMOVED (workflow verify phase, V3). Two grep-style pins lived here
  // and both were worthless. One asserted each routed file mentions
  // isCompleteStatus; it PASSED for prep-scheduler while that file had
  // the name only inside a COMMENT and actually imports
  // isTerminalTaskStatus. The other asserted the overnight runner kept
  // isCompleteStatus for its own-task skip, which is now the OPPOSITE of
  // the shipped behavior after that decision was deliberately reversed.
  //
  // A pin that greps for a symbol name cannot tell a call from a comment,
  // and a pin that encodes a superseded decision fails for the right
  // reason at the wrong time. Behavioral coverage now lives in
  // tests/dispatcher/spec-db-conflict-dependencies.test.ts and
  // tests/monitor/spec-db-conflict-surfaces.test.ts, which exercise
  // conflicting spec and DB state through the real paths.
});
