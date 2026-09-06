// ─── Task state resolution (TASK-1317, P2-3) ────────────────────────
// One typed, provenanced answer to "what status is this task in, and
// from which source" — for the tasks the monitor projects.
//
// SCOPE HONESTY (round-1 F3/F4). This module does NOT make the
// verification register authoritative and does NOT unify every state
// reader in the repo. Both are P2-4. What it must never do is pretend
// otherwise, so the types below say plainly which sources supply status
// and which are evidence, and DEFERRED_STATE_READERS enumerates every
// site still answering independently.

import { normalizeTaskStatus, type TaskStatus } from "./task-status.js";

/**
 * The sources that can SUPPLY a status today, in precedence order.
 *
 * `session` is a member because it demonstrably supplies one: an
 * approved session with no runtime row yields COMPLETE (round-1 F1
 * confirmed the concrete case). Omitting it would make every
 * attribution of a session-derived status false.
 *
 * There is deliberately NO `"ledger"` member. The verification register
 * is carried as evidence and does not decide status in this task; a
 * member that could never be returned would satisfy the structural
 * tests while making the model a lie (round-1 F3).
 *
 * PROVENANCE CAVEAT on `"runtime"`: terminal spec `Status:` lines are
 * propagated into the DB `task_status` table by `task-watcher.ts`
 * (TASK-914), so a runtime row's true origin may be a markdown edit.
 * `"runtime"` therefore means "the runtime row answered", not "a
 * machine decided". Operator decided 2026-08-06 to retire that
 * propagation; it lands in P2-4 because removing it moves authority.
 */
export const TASK_STATE_AUTHORITIES = ["runtime", "session", "spec"] as const;

export type TaskStateAuthority = (typeof TASK_STATE_AUTHORITIES)[number];

/** Session evidence, exactly as the projection has always shaped it. */
export interface TaskStateSessionInput {
  outcome: string;
  status: string;
}

/** Latest-verification evidence. NOT an append-only audit history: the
 * `verified` table keys on `task_id` and overwrites on conflict, so only
 * the newest verdict survives (round-1 F5). */
export interface TaskVerificationEvidence {
  verdict: string;
  method: string;
  commitSha: string;
  verifiedAt: string;
}

/**
 * Resolver inputs. `spec` is REQUIRED (round-1b C1): the universe is
 * spec-parsed tasks, so "a task with no status source at all" is
 * unrepresentable by construction rather than needing an invented
 * sentinel authority.
 */
export interface TaskStateInputs {
  spec: string;
  runtime?: string;
  session?: TaskStateSessionInput;
  verification?: TaskVerificationEvidence;
}

export interface ResolvedTaskState {
  /** Byte-identical to the pre-1317 chain, including aliases, empty
   * strings and unknown values. Never normalized (round-1 F2). */
  status: string;
  /** The additive normalized view; null when the raw value has no
   * canonical form. New callers use this. */
  typedStatus: TaskStatus | null;
  authority: TaskStateAuthority;
  verification?: TaskVerificationEvidence;
}

/**
 * Precedence as DATA, not a `??` chain (S2). `supply` returns the raw
 * status this authority contributes, or undefined when it has nothing
 * to say. Resolution walks the table in order and takes the first
 * non-undefined answer. Reordering or adding a source is a one-line
 * change against a failing pin.
 */
export interface TaskStatePrecedenceEntry {
  authority: TaskStateAuthority;
  /** Why this authority sits here, for the enumeration test's output. */
  rationale: string;
  supply(inputs: TaskStateInputs): string | undefined;
}

const PRECEDENCE_ENTRIES: TaskStatePrecedenceEntry[] = [
  {
    authority: "runtime",
    rationale: "The DB task_status row is what the dispatcher selects on. Present means decided.",
    // `??` semantics preserved exactly: an empty-string row still wins,
    // because it did before 1317 (round-1 F2).
    supply: (inputs) => inputs.runtime ?? undefined,
  },
  {
    authority: "session",
    rationale:
      "Derived from the latest session when no runtime row exists. Evidence-grade, retired in P2-4 once every completion path writes a runtime row.",
    supply: (inputs) => {
      const derived = deriveSessionStatus(inputs.spec, inputs.session);
      return derived === inputs.spec ? undefined : derived;
    },
  },
  {
    authority: "spec",
    rationale:
      "The human-editable projection. Always answers, which is why it is last and why the input is required.",
    supply: (inputs) => inputs.spec,
  },
];

/**
 * Frozen (round-2 F4): `readonly` is compile-time only, so the exported
 * table was mutable at runtime by any consumer. Round-2b noted the
 * freeze was SHALLOW — the container was protected while each entry's
 * `supply` function could still be swapped, which is the mutation that
 * would actually change resolution. Deep-frozen so the claim is true
 * rather than approximately true.
 */
export const TASK_STATE_PRECEDENCE: readonly TaskStatePrecedenceEntry[] = Object.freeze(
  PRECEDENCE_ENTRIES.map((entry) => Object.freeze(entry)),
);

/**
 * The pre-1317 session derivation, moved verbatim so behavior cannot
 * drift. Kept exported for the compatibility matrix to compare against.
 */
export function deriveSessionStatus(specStatus: string, session?: TaskStateSessionInput): string {
  if (!session) return specStatus;
  if (specStatus === "COMPLETE" || specStatus === "VERIFIED") return specStatus;
  if (session.outcome === "approved") return "COMPLETE";
  if (session.status === "active") return "IN_PROGRESS";
  if (
    (session.outcome === "rejected" || session.outcome === "agent_failed") &&
    specStatus === "IN_PROGRESS"
  ) {
    return "REJECTED";
  }
  return specStatus;
}

/**
 * Resolve one task's state. The returned `status` is byte-identical to
 * what the pre-1317 chain produced for the same inputs.
 */
export function resolveTaskState(inputs: TaskStateInputs): ResolvedTaskState {
  // Round-2 F4: TypeScript's `required` evaporates at runtime. A JS or
  // unchecked caller passing `{}` previously got back
  // `{ status: undefined, authority: "spec" }` — a forged answer that
  // contradicted both the declared `string` result and the claimed
  // source. Provenance that can be forged is worse than none, so this
  // is validated rather than assumed.
  if (typeof inputs?.spec !== "string") {
    throw new TypeError(
      "resolveTaskState requires a string `spec` status: the resolver's universe is spec-parsed tasks",
    );
  }

  for (const entry of TASK_STATE_PRECEDENCE) {
    const supplied = entry.supply(inputs);
    if (supplied === undefined) continue;
    return {
      status: supplied,
      typedStatus: normalizeTaskStatus(supplied),
      authority: entry.authority,
      ...(inputs.verification ? { verification: inputs.verification } : {}),
    };
  }

  // The spec entry always supplies, so reaching here means the
  // precedence table was mutated or emptied. Fail loudly rather than
  // inventing an authority.
  throw new Error(
    "resolveTaskState: no precedence entry supplied a status; the precedence table is corrupt",
  );
}

// ─── Deferred readers (S8, round-1 F4 + round-1b C4) ────────────────
// Every site that answers task state WITHOUT this resolver. Named as
// data so P2-4's scope is visible rather than remembered, and pinned by
// a test so it cannot quietly shrink.

export interface DeferredStateReader {
  site: string;
  kind: "reader" | "writer";
  what: string;
  disposition: string;
}

export const DEFERRED_STATE_READERS: readonly DeferredStateReader[] = [
  // ── HOW THIS LIST HAS BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS. ─────
  //
  // Round 2 (F1) caught it TOO SHORT. Five sites had been removed as
  // "routed" when TASK-1318 had only changed their PREDICATE
  // (`=== "COMPLETE"` became `isCompleteStatus`) and not their INPUT.
  // They still read raw spec status, which is precisely what the task's
  // own anti-gaming clause forbade: "routing readers through a helper
  // that still prefers the spec would be a rename, not a retirement."
  //
  // Round 3 (F6) caught the correction OVERSHOOTING. Those five entries
  // were restored as PARTIALLY DONE and then left there while the work
  // completed around them, so the list described a repo that no longer
  // existed and reported finished routing as outstanding. An inventory
  // that overstates the gap is not "safely conservative": it is just as
  // untrustworthy as one that hides it, and it trains readers to skip it.
  //
  // Entries below now reflect what the code does, each verified by
  // reading the call site rather than by remembering a round's summary.
  // Removed as GENUINELY ROUTED, with the behavioral pins that hold them:
  //
  //   lifecycle-manager.ts   overlay loaded once per run and resolved
  //                          before both dependency passes, INCLUDING
  //                          under the real `--project <worktree>`
  //                          topology (round-3 F1). Pinned by
  //                          tests/dispatcher/spec-db-conflict-dependencies.
  //   templates/template-registry.ts
  //                          both the build scan and updateRegistry
  //                          resolve before `isCompleteStatus`, and the
  //                          refusal names the authority.
  //   monitor/prep-scheduler.ts
  //                          takes the project's store and hands it to
  //                          `listTasks`, so the predicate and backlog
  //                          hygiene share one resolution (round-3 F2).
  //   overnight/runner.ts    own-task skip, dependency eligibility AND
  //                          automatic discovery all resolve first
  //                          (round-3 F3).
  //   monitor/routes/triage.ts
  //                          one read-only overlay per request; blockers,
  //                          categorization, summaries and parent rollups
  //                          all read the resolved value.
  //   core/task-hygiene.ts   status hygiene moved out of the parse pass
  //                          into the projection pass (S2c), and the
  //                          spec-only shim was deleted once its last
  //                          caller was routed (round-3 F3).
  //   monitor/task-watcher.ts
  //                          its spec-to-runtime WRITE is gone. No
  //                          writer entry remains anywhere in this list.
  {
    site: "src/queue/dispatch-queue.ts",
    kind: "reader",
    what: "Readiness and the fresh pre-dispatch dependency resolution pass the project DB to listTasks, so admission uses the runtime overlay.",
    disposition:
      "PARTIALLY ROUTED BY TASK-1338-C: enqueueAllEligible remains outside this targeted admission change, preserving its reviewed BACKLOG eligibility semantics and the TASK-1318 round-1 F8 hazard boundary.",
  },
  {
    site: "src/monitor/federation/scheduling.ts",
    kind: "reader",
    what: "getFederatedDependencyStatus reads the DB row and falls back to spec status.",
    disposition:
      "LOW PRIORITY: already DB-first with a correct spec fallback, so it agrees with the resolver on every case that matters. Route it for uniformity, not correctness.",
  },
  {
    site: "src/dispatcher/dependency-resolver.ts",
    kind: "reader",
    what: "CLI status/wave eligibility via the TASK-1202 overlay, which is DB-over-spec but not the shared resolver.",
    disposition:
      "LOW PRIORITY: semantically equivalent to the resolver today. Route it so there is one implementation rather than two that agree by coincidence.",
  },
  // ── Found by TASK-1318 round-1 F6, NOT yet audited. Recorded rather
  // than quietly omitted, because an inventory that only lists what its
  // author already knew about is not an inventory.
  {
    site: "src/workflow/state-projector.ts",
    kind: "reader",
    what: "Persists workflow projections built from raw spec state.",
    disposition: "UNAUDITED: confirm whether it decides anything, or only renders.",
  },
  {
    site: "src/monitor/public/index.html",
    kind: "reader",
    what: "The dashboard disables dispatch for VERIFIED dependencies using client-side status logic.",
    disposition:
      "UNAUDITED: browser-side duplicate of the doneness rule; belongs with the Phase-4 UI work.",
  },
  {
    site: "src/dispatcher/follow-up-dedup.ts",
    kind: "reader",
    what: "May treat DB-complete tasks as backlog when deduplicating follow-ups.",
    disposition: "UNAUDITED: assess whether a stale answer causes duplicate follow-ups.",
  },
  {
    site: "src/integrations/github/issue-publisher.ts",
    kind: "reader",
    what: "Publishes issues using raw spec state.",
    disposition: "UNAUDITED: assess whether a stale answer publishes wrong state.",
  },
];

/**
 * The task universe this resolver answers for (round-1 F6). Spec-parsed
 * tasks only: a register-only or runtime-only id receives no projection
 * at all, because `TaskService` projects only successfully parsed
 * specs. Stated rather than implied.
 */
export const TASK_STATE_UNIVERSE =
  "spec-parsed tasks; register-only and runtime-only ids are outside this resolver's universe";
