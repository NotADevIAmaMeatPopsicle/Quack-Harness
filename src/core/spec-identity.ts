// ─── Spec Identity (TASK-1332 / QPI-045) ───────────────────────────
// An approval record must know WHICH spec it was built from, or a human
// can be shown a pre-amendment brief as if it were current and the
// resume path will execute it (dispatcher.ts restores the brief FROM
// the record whenever the blueprint stage is checkpointed).
//
// Round 1 established that this is not one hash, for two reasons.
//
// 1. "The current spec" is not one location. A dispatch worktree is
//    created from origin/<base> sharing only .quack/logs and
//    .quack/prep, resume REUSES that worktree, and the dispatcher
//    reloads the task from the worktree. So an amendment in the owning
//    clone need not be present in the resumed task at all, and the old
//    brief and the worktree's spec can be consistent with each other
//    while both violate the amended authoritative contract. Callers
//    resolve "current" from the OWNING project root
//    (resolveAuthoritativeProjectRoot), never the resumed worktree.
//
// 2. A byte hash answers the wrong question. The system writes to spec
//    files itself: the reconciler, the task-reject API, enrichment,
//    repair and the watcher all rewrite the `**Status:**` line in
//    place. Deciding VALIDITY on a byte hash means a bookkeeping write
//    retires a human's REJECTION, which is an approval-control bypass
//    wearing a safety feature's clothes. So validity reads a SEMANTIC
//    contract hash that excludes operational metadata, and the byte
//    hash is kept only as an audit trail.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { resolveAuthoritativeProjectRoot } from "./task-state-overlay.js";
import {
  isParentTaskFileName,
  listDuplicateClaimantsSync,
  listRawEligibleTaskFileCandidatesSync,
  pickBestRawTaskFileCandidate,
  resolveParsedTaskFileSyncPath,
} from "./task-file-resolver.js";

/**
 * Lines that are operational metadata rather than contract. A change
 * confined to these does NOT invalidate an approval.
 *
 * Deliberately a tiny, explicit list rather than a general "metadata"
 * notion. Every entry here is a line some part of Quack rewrites on its
 * own initiative; anything a HUMAN edits to change what the work is
 * must stay inside the contract hash. Adding to this list widens what a
 * machine can silently change under a human's decision, so entries need
 * a named writer.
 */
const OPERATIONAL_METADATA_FIELDS: ReadonlyArray<{
  readonly writer: string;
  readonly field: string;
}> = [
  // lifecycle-manager.updateTaskStatus, reconcile-spec-status,
  // POST /api/tasks/:id/reject, enrichment, repair, task-watcher.
  { writer: "status-line-writers", field: "Status" },
  // spec-normalizer writes these during watcher normalization/repair.
  // Round 2 (R2-3): missing them produced a FALSE STALE on every
  // normalized spec, which is the failure mode that makes refusals
  // untrustworthy.
  { writer: "spec-normalizer", field: "Status-Note" },
  { writer: "spec-normalizer", field: "Repaired" },
];

const OPERATIONAL_FIELD_RE = new RegExp(
  "^\\s*-?\\s*\\*\\*(" + OPERATIONAL_METADATA_FIELDS.map((f) => f.field).join("|") + "):\\*\\*",
);

const METADATA_HEADING_RE = /^\s*#{1,6}\s+Metadata\s*$/i;
const ANY_HEADING_RE = /^\s*#{1,6}\s+/;
const FENCE_RE = /^\s*(?:```|~~~)/;

/**
 * The identity of the spec an artifact was built from.
 *
 * Both hashes are recorded because they answer different questions and
 * round 1 showed that collapsing them is the bug:
 *   - `contractHash` decides VALIDITY. Semantic; ignores the lines in
 *     NON_CONTRACT_LINE_PATTERNS.
 *   - `auditHash` is the exact bytes, for forensics and for comparing
 *     against the prep/preflight caches, which key on the same value.
 *     It NEVER decides validity.
 */
export interface SpecIdentity {
  /** Semantic contract hash. The only hash that decides validity. */
  contractHash: string;
  /** Exact-byte hash of the spec content. Audit only. */
  auditHash: string;
  /**
   * R1-1: the contract hash of the SOURCE spec the pipeline actually had
   * in hand, which on a resumed run is the dispatch worktree's copy
   * rather than the owning clone's.
   *
   * When this differs from `contractHash` the run was reading the wrong
   * SOURCE, which is a different condition from "the spec has since been
   * amended" and is decided separately (`diverged` vs `stale`).
   *
   * **Round 5 (R5-2): this is SOURCE content, never derived content.**
   * The first cut passed the post-enrichment in-memory task here, so
   * every readiness-enriched dispatch stamped a record whose effective
   * hash differed from its contract hash by construction and was refused
   * as `diverged` at the next consumption, with recovery advice telling
   * the operator to push an amendment nobody had made. Authorized
   * in-pipeline derivation is not source divergence. What the brief was
   * actually synthesized from is recorded in `enrichedContractHash`,
   * which decides nothing.
   */
  effectiveContractHash?: string;
  /**
   * Round 5 (R5-2): the contract hash of the ENRICHED content the brief
   * was synthesized from, present only when readiness enrichment
   * replaced the task in memory.
   *
   * **Audit only. `compareSpecIdentity` never reads it.** It exists so a
   * later forensic question, "was this brief built from the spec as
   * written, or from an enriched derivation of it?", has an answer,
   * without that answer being able to refuse anything.
   */
  enrichedContractHash?: string;
  /** Spec path relative to the owning project root, when known. */
  taskSpecRelativePath?: string;
  /** Owning-root commit or ref the contract was read at, when known. */
  sourceRef?: string;
  /** ISO stamp of when this identity was computed. */
  stampedAt: string;
}

/** Byte-exact hash. Matches `computeContentHash(content)` with no file
 *  hashes, which is pinned by test so the two cannot drift apart. */
export function computeAuditHash(specContent: string): string {
  return crypto.createHash("sha256").update(specContent).digest("hex");
}

/**
 * Strip operational metadata so bookkeeping writes cannot move the
 * contract. Exported for testing and for diagnostics that need to show
 * an operator WHAT was compared.
 *
 * Trailing whitespace per line and trailing blank lines are normalized
 * because the same writers reflow them incidentally; interior blank
 * lines are preserved, since a human restructuring a spec is a contract
 * change and must not be normalized away.
 */
export function extractContract(specContent: string): string {
  const kept: string[] = [];
  let inMetadata = false;
  let inFence = false;

  for (const line of specContent.split(/\r?\n/)) {
    if (FENCE_RE.test(line)) inFence = !inFence;

    // Round 2 (R2-3): the exclusion is SCOPED to the Metadata section and
    // never applies inside a fenced block. Stripping by line shape
    // anywhere meant a human could make a material change on any line
    // shaped like `- **Status:** ...` — in Success Criteria, in a code
    // example — and the contract hash would not move, so a real
    // amendment read as "match". Context-blind stripping is a hole in
    // the direction that matters.
    if (!inFence && METADATA_HEADING_RE.test(line)) {
      inMetadata = true;
      kept.push(line.replace(/[ \t]+$/, ""));
      continue;
    }
    if (!inFence && inMetadata && ANY_HEADING_RE.test(line)) {
      inMetadata = false;
    }

    if (!inFence && inMetadata && OPERATIONAL_FIELD_RE.test(line)) {
      continue;
    }
    kept.push(line.replace(/[ \t]+$/, ""));
  }

  while (kept.length > 0 && kept[kept.length - 1] === "") kept.pop();
  return kept.join("\n");
}

/** Semantic contract hash. Decides validity. */
export function computeContractHash(specContent: string): string {
  return crypto.createHash("sha256").update(extractContract(specContent)).digest("hex");
}

export function computeSpecIdentity(
  specContent: string,
  meta?: {
    taskSpecRelativePath?: string;
    sourceRef?: string;
    /** SOURCE content in hand. Decides `diverged`. Never derived content. */
    effectiveSpecContent?: string;
    /** Enriched content the brief was built from. Audit only (R5-2). */
    enrichedSpecContent?: string;
  },
): SpecIdentity {
  const effectiveContractHash =
    meta?.effectiveSpecContent !== undefined
      ? computeContractHash(meta.effectiveSpecContent)
      : undefined;
  // R5-2: recorded, never compared. Only present when enrichment actually
  // moved the contract, so an unenriched run carries no misleading field.
  const enrichedContractHash =
    meta?.enrichedSpecContent !== undefined
      ? computeContractHash(meta.enrichedSpecContent)
      : undefined;
  return {
    contractHash: computeContractHash(specContent),
    auditHash: computeAuditHash(specContent),
    ...(effectiveContractHash ? { effectiveContractHash } : {}),
    ...(enrichedContractHash ? { enrichedContractHash } : {}),
    ...(meta?.taskSpecRelativePath ? { taskSpecRelativePath: meta.taskSpecRelativePath } : {}),
    ...(meta?.sourceRef ? { sourceRef: meta.sourceRef } : {}),
    stampedAt: new Date().toISOString(),
  };
}

/**
 * Three states, not two.
 *
 * `unknown` exists because every record written before TASK-1332 has no
 * stamp, and because a caller may be unable to read the authoritative
 * spec. Absence must never be read as "still current" (the TASK-1330
 * round-1 lesson) and must never be read as "stale" either, because
 * that would strand every pre-existing pend on the deploy that ships
 * this.
 */
export type SpecIdentityVerdict =
  /** The artifact's contract matches the current authoritative spec. */
  | "match"
  /** The contract moved. Refuse. */
  | "stale"
  /** No stamp at all: a pre-1332 record. Proceed, or every live pend is
   *  stranded by the deploy that ships this. */
  | "unknown_legacy"
  /**
   * Round 2 (R2-1): a stamp EXISTS but the current authoritative spec
   * could not be read (deleted, renamed, unreadable), or the stored
   * stamp is structurally malformed.
   *
   * The first cut collapsed this into the same `unknown` as a legacy
   * record and PROCEEDED, so deleting or renaming the owner spec
   * admitted the worktree's stale brief. A record that CLAIMS an
   * identity and cannot be checked is not the same as one that never
   * claimed one, and only the second is safe to grandfather.
   */
  | "unverifiable"
  /**
   * Round 2 (R2-2): the artifact was built from content whose contract
   * differs from the authoritative spec's at stamp time — owner v2,
   * worktree v1. Stamping the owner's hash onto an artifact built from
   * the worktree's copy would LAUNDER a stale brief into a
   * matching identity, which is exactly the "worse than absence" case
   * this task's own S1 documents and the first cut reintroduced.
   */
  | "diverged"
  /** More than one file currently declares ownership of the task id. */
  | "contested";

export interface ContestedSpecIdentity {
  verdict: "contested";
  reason: string;
  claimants: string[];
  contractHash?: undefined;
  auditHash?: undefined;
  effectiveContractHash?: undefined;
  enrichedContractHash?: undefined;
  taskSpecRelativePath?: undefined;
  stampedAt?: undefined;
}

export type ResolvedSpecIdentity = SpecIdentity | ContestedSpecIdentity | undefined;

export function isContestedSpecIdentity(
  resolution: ResolvedSpecIdentity,
): resolution is ContestedSpecIdentity {
  return resolution !== undefined && "verdict" in resolution && resolution.verdict === "contested";
}

/** Found-only extraction for approval stamping. */
export function foundSpecIdentity(resolution: ResolvedSpecIdentity): SpecIdentity | undefined {
  return isContestedSpecIdentity(resolution) ? undefined : resolution;
}

/** The verdicts a consumer may proceed on. Everything else refuses. */
export function mayConsume(verdict: SpecIdentityVerdict): boolean {
  return verdict === "match" || verdict === "unknown_legacy";
}

/**
 * Round 5 (R5-3): stamped on every approval record written by
 * stamping-aware code, whether or not identity resolution SUCCEEDED.
 *
 * Its only job is to date the record relative to this feature, so that a
 * missing identity can be told apart from a record that predates
 * identities altogether. Bump it only if the meaning of a stored
 * identity changes in a way that invalidates comparison against records
 * written by the previous version.
 */
export const SPEC_IDENTITY_VERSION = 1;

export interface SpecIdentityComparison {
  verdict: SpecIdentityVerdict;
  /** Why, in operator-facing terms. Always populated. */
  reason: string;
  /** True when only the audit hash moved, i.e. a bookkeeping-only edit
   *  that deliberately did NOT invalidate the artifact. Recorded so the
   *  distinction is visible rather than silently swallowed. */
  operationalOnlyChange?: boolean;
}

/** Round 2 (R2-4): a parsed record is not a valid one. `{contractHash: 1}`
 *  parses, and the first cut called `.slice` on it inside a try/catch that
 *  fell through to regenerating the brief while the old `approved` state
 *  still applied to the NEW artifact. Shape is validated, not assumed. */
function wellFormed(identity: SpecIdentity | undefined): boolean {
  return (
    typeof identity?.contractHash === "string" &&
    identity.contractHash.length > 0 &&
    (identity.effectiveContractHash === undefined ||
      typeof identity.effectiveContractHash === "string")
    // Round 6 (R6-4) removed `enrichedContractHash` from this check, and
    // round 7 (R7-3) removed `auditHash` for the identical reason: both
    // are documented as never deciding validity, and both were able to
    // produce `unverifiable`, a REFUSAL, purely by being malformed.
    // Round 6 retired one audit-only producer and left the other, which
    // is this series' recurring shape in miniature. Executed proof from
    // the round: `auditHash: 42` yielded `unverifiable` while
    // `enrichedContractHash: 42` yielded `match`.
    //
    // Only the two hashes that DECIDE are validated here. `auditHash`
    // still participates in the non-blocking `operationalOnlyChange`
    // diagnostic below, which can flag but never refuse.
  );
}

export function compareSpecIdentity(
  stored: SpecIdentity | undefined,
  current: SpecIdentity | undefined,
  /**
   * Round 5 (R5-3): the record-version boundary that makes "no stamp"
   * mean two different things.
   *
   * Every record written by stamping-aware code carries
   * {@link SPEC_IDENTITY_VERSION}, whether or not the authority could be
   * resolved. So a record with a version and NO identity was written
   * TODAY by code that tried and failed, which is `unverifiable`; a
   * record with neither predates TASK-1332 and is the `unknown_legacy`
   * the grandfather clause exists for.
   *
   * Without this, a task whose owning-clone spec is missing, unreadable
   * or ambiguous silently produced an unstamped record that read as
   * grandfathered on every later consumption, the fail-open the
   * `unverifiable` verdict was invented to close, reachable through the
   * creation path instead of the comparison path.
   */
  storedRecord?: { specIdentityVersion?: number },
): SpecIdentityComparison {
  // CLAIM detection and VALIDITY are different questions, and round 8
  // (R8-3) showed that collapsing them fails in both directions.
  //
  // Round 7 removed `auditHash` from here alongside removing it from
  // `wellFormed`. That went too far: an UNVERSIONED record carrying
  // `{ auditHash }` and no `contractHash` stopped counting as a claim at
  // all, so instead of `unverifiable` it became `unknown_legacy` and
  // `mayConsume` let it through. A malformed identity object is not the
  // same as no identity object, and only the second may be grandfathered
  //, the R2-1 distinction, reintroduced through claim detection after
  // being fixed in the verdict.
  //
  // Round 9 (R9-2) keyed the claim on the presence of an OBJECT, and
  // round 10 (R10-3) found the cells that left open: `loadApproval` parses
  // unvalidated JSON, so a record can carry `"specIdentity": null`, or a
  // string, a number, a boolean, none of which are objects, so all four
  // read as NO claim and were grandfathered as consumable.
  //
  // **The rule is now the narrowest one there is: only `undefined` is
  // absence.** A field that is genuinely missing was written before
  // TASK-1332 and is grandfathered. ANY other value is a claim that must
  // prove itself, and a claim that cannot is `unverifiable`.
  //
  // `auditHash` still cannot refuse anything on its own merits -
  // malformed audit metadata alongside a valid contract hash is `match`,
  // which is R7-3's point and is asserted by test.
  const storedClaimsIdentity = stored !== undefined;

  if (!storedClaimsIdentity && storedRecord?.specIdentityVersion !== undefined) {
    return {
      verdict: "unverifiable",
      reason:
        "this record was created by stamping-aware code but carries no spec identity, " +
        "so the authoritative spec could not be resolved when it was written; it is " +
        "NOT a pre-TASK-1332 record and must not be grandfathered",
    };
  }

  if (!storedClaimsIdentity) {
    return {
      verdict: "unknown_legacy",
      reason:
        "this approval record carries no spec identity (written before TASK-1332), " +
        "so it is grandfathered rather than checked",
    };
  }
  if (!wellFormed(stored)) {
    return {
      verdict: "unverifiable",
      reason:
        "this approval record's spec identity is malformed, so it cannot be checked " +
        "against the current spec",
    };
  }
  if (!wellFormed(current)) {
    return {
      verdict: "unverifiable",
      reason:
        "the current authoritative spec could not be read, so a record that claims a " +
        "spec identity cannot be checked against it",
    };
  }
  // Divergence is evaluated BEFORE equality: an artifact built from a
  // different spec than the one stamped on it is untrustworthy even
  // when the stamp matches the authority, because the stamp is the
  // thing that would be laundering it.
  if (
    stored.effectiveContractHash !== undefined &&
    stored.effectiveContractHash !== stored.contractHash
  ) {
    return {
      verdict: "diverged",
      reason:
        "this artifact was built from a spec that was not the authoritative one at the " +
        `time it was stamped (built from ${stored.effectiveContractHash.slice(0, 12)}, ` +
        `stamped against ${stored.contractHash.slice(0, 12)})`,
    };
  }
  if (stored.contractHash !== current!.contractHash) {
    return {
      verdict: "stale",
      reason:
        `the spec's contract has changed since this artifact was built ` +
        `(contract ${stored.contractHash.slice(0, 12)} -> ${current!.contractHash.slice(0, 12)})`,
    };
  }
  const operationalOnlyChange = Boolean(
    stored.auditHash && current!.auditHash && stored.auditHash !== current!.auditHash,
  );
  return {
    verdict: "match",
    reason: operationalOnlyChange
      ? "the spec's contract is unchanged; only operational metadata (the Status line) moved"
      : "the spec is byte-identical to the one this artifact was built from",
    ...(operationalOnlyChange ? { operationalOnlyChange } : {}),
  };
}

/** Full-resolution comparison that preserves the contested arm. */
export function compareResolvedSpecIdentity(
  stored: SpecIdentity | undefined,
  current: ResolvedSpecIdentity,
  storedRecord?: { specIdentityVersion?: number },
): SpecIdentityComparison {
  if (isContestedSpecIdentity(current)) {
    return { verdict: "contested", reason: current.reason };
  }
  return compareSpecIdentity(stored, current, storedRecord);
}

/**
 * Read the CURRENT authoritative spec and stamp its identity.
 *
 * Round 1 (R1-1) is the whole reason this does not simply hash
 * `task.rawContent`:
 *
 *   - `task.rawContent` on a resume comes from the REUSED dispatch
 *     worktree, which was cut from `origin/<base>` and never sees an
 *     amendment made in the owning clone. Hashing it would compare a
 *     stale brief against a stale spec and report "match".
 *   - readiness enrichment replaces `task` IN MEMORY only, so hashing
 *     the in-memory content against the unchanged file would report
 *     "stale" for a task nobody amended.
 *
 * So the authoritative answer is read from disk, at the owning project
 * root, every time. Returns `undefined` when the spec cannot be read,
 * which callers must treat as `unknown` rather than as either verdict.
 */
export function resolveCurrentSpecIdentity(
  projectRoot: string,
  taskDir: string,
  taskId: string,
  /** The SOURCE spec content this run has in hand, when the caller knows
   *  it. Recorded as `effectiveContractHash` and it DOES decide
   *  `diverged`, so callers must pass source content and never a derived
   *  or enriched form of it (R5-2). */
  effectiveSpecContent?: string,
  /** The enriched content the brief was built from, when readiness
   *  enrichment replaced the task in memory. Audit only (R5-2). */
  enrichedSpecContent?: string,
): ResolvedSpecIdentity {
  try {
    const owning = resolveAuthoritativeProjectRoot(projectRoot).root;
    const resolvedTaskDir = path.resolve(owning, taskDir);
    const resolution = findSpecFile(resolvedTaskDir, taskId);
    if (resolution.status === "not-found") return undefined;
    if (resolution.status === "duplicate") {
      return {
        verdict: "contested",
        reason:
          `the authoritative task id is a contested id claimed by: ` +
          resolution.claimants.join(", "),
        claimants: resolution.claimants,
      };
    }
    const specPath = resolution.filePath;
    const content = fs.readFileSync(specPath, "utf-8");
    return computeSpecIdentity(content, {
      taskSpecRelativePath: path.relative(owning, specPath).split(path.sep).join("/"),
      ...(effectiveSpecContent !== undefined ? { effectiveSpecContent } : {}),
      ...(enrichedSpecContent !== undefined ? { enrichedSpecContent } : {}),
    });
  } catch {
    return undefined;
  }
}

/**
 * Round 4 (R4-3): delegate candidate selection to the CANONICAL picker.
 *
 * The first cut took "the first sorted filename starting with the task id",
 * which is not what the dispatcher's own resolver does. For `TASK-100` that
 * happily selects `TASK-1000-....md` or the subtask `TASK-100-A-....md`, so the
 * pre-gate check would compare the run against a DIFFERENT task's spec and
 * refuse a legitimate dispatch. Wedging decomposed families is exactly the
 * false-refusal class that makes a gate untrustworthy.
 *
 * `pickBestRawTaskFileCandidate` already encodes the delimiter rule, the
 * parent-versus-subtask distinction and case handling, so this shares it rather
 * than reproducing it and drifting.
 */
export type SpecFileResolution =
  | { status: "found"; filePath: string }
  | { status: "duplicate"; claimants: string[] }
  | { status: "not-found" };

export function findSpecFile(taskDir: string, taskId: string): SpecFileResolution {
  const id = taskId.trim().toUpperCase();

  const duplicateClaimants = listDuplicateClaimantsSync(taskDir, id);
  if (duplicateClaimants.length > 1) {
    return { status: "duplicate", claimants: duplicateClaimants };
  }

  // ── Round 7 (R7-1): PARSED-FIRST, exactly like the dispatcher ──────
  // The dispatcher resolves a task by parsing each sorted candidate and
  // matching `task.id`, and only falls back to filename shape when no
  // candidate parses to the right id. Round 6 reached for the raw picker
  // alone, which is just that fallback half, so with a descriptive file
  // whose H1 names a DIFFERENT task, the dispatcher loaded the exact file
  // while this hashed the descriptive one and the run read as `diverged`.
  // Reproduced by the round: dispatcher `TASK-100.md`, identity
  // `TASK-100-parent.md`. It also fixes subtask IDS, where the canonical
  // parser accepts `TASK-100-A-B-child.md` as `TASK-100-A` and the
  // filename rule rejects it as a child, so identity returned UNKNOWN for
  // a task the dispatcher resolved fine.
  //
  // Sharing the resolver, rather than agreeing with it by construction,
  // is the point: this series has now paid three times for a second
  // producer holding a different answer.
  const parsed = resolveParsedTaskFileSyncPath(taskDir, taskId);
  if (parsed) return { status: "found", filePath: parsed.filePath };

  // ── Raw fallback, for specs that do not parse ──────────────────────
  // Round 9 (R9-1): candidates that parse CLEANLY to another task's id are
  // excluded before the filename rules run, so no name-shaped heuristic
  // can select another task's spec here either.
  const entries = listRawEligibleTaskFileCandidatesSync(taskDir, taskId);

  // The picker FALLS BACK to a loose prefix match when it finds no true
  // parent, so its pick is only accepted when it is an unambiguous parent
  // (R4-3). Round 10 (R10-1) moved that predicate into the resolver module
  // and shares it, because the raw fallback there needed the identical
  // rule and having two copies is how they drift.
  const picked = pickBestRawTaskFileCandidate(taskId, entries);
  if (picked && isParentTaskFileName(taskId, picked)) {
    return { status: "found", filePath: path.join(taskDir, picked) };
  }

  // Then the exact filename, as a RESCUE for R5-4: the picker's parent scan
  // considers only names starting `<id>-`, so with an exact `TASK-100.md`
  // alongside `TASK-100-A-child.md` its fallback can return the subtask,
  // which the guard above rejects, leaving the check silently disabled with
  // the parent sitting in the same directory.
  const exact = entries.filter((f) => f.toUpperCase() === `${id}.MD`);
  // More than one only happens on a case-sensitive filesystem holding
  // `TASK-100.md` and `TASK-100.MD`. There is no basis for preferring
  // either, and directory order is not one, so decline: `undefined` reads as
  // UNKNOWN and UNKNOWN never blocks.
  if (exact.length === 1) {
    return { status: "found", filePath: path.join(taskDir, exact[0]) };
  }

  return { status: "not-found" };
}

/**
 * Is the spec this run actually HAS in hand the authoritative one?
 *
 * Round 3 (R3-2). This is a different question from
 * {@link compareSpecIdentity}, which asks whether a STORED artifact still
 * matches. This one asks whether the run is about to build from the wrong
 * source in the first place, and it is the question that was missing.
 *
 * The loop it closes: a dispatch worktree is cut from `origin/<base>`, so it
 * holds v1 while the owning clone holds an unpushed v2. The brief is generated
 * from v1 and then stamped from the owning clone at v2, so the record is born
 * `diverged` and every later consumption refuses. Replanning regenerates from
 * the same worktree and reproduces it exactly, so the advertised recovery
 * loops.
 *
 * Catching it HERE, before the gate and before blueprint generation, does three
 * things the consumption-time check cannot: it names the real cause (a spec that
 * has not reached `origin/<base>`), it costs nothing instead of a full
 * gate-plus-blueprint spend, and it refuses before a human is asked to approve
 * something built from the wrong contract.
 *
 * Returns null when there is nothing to say: no readable authority (UNKNOWN
 * never blocks), or the contracts agree.
 *
 * MUST be called with the RAW loaded task, before readiness enrichment, which
 * replaces the task in memory only and would otherwise look like divergence.
 */
export function detectInHandDivergence(
  inHandSpecContent: string,
  authoritative: SpecIdentity | undefined,
): { authoritativeContractHash: string; inHandContractHash: string } | null {
  if (!authoritative?.contractHash) return null;
  const inHandContractHash = computeContractHash(inHandSpecContent);
  if (inHandContractHash === authoritative.contractHash) return null;
  return { authoritativeContractHash: authoritative.contractHash, inHandContractHash };
}

/** Operator-facing text for an in-hand divergence. Names the cause and the ONE
 *  action that clears it, because replan provably does not. */
export function inHandDivergenceMessage(
  taskId: string,
  divergence: { authoritativeContractHash: string; inHandContractHash: string },
  meta?: { taskSpecRelativePath?: string },
): string {
  const where = meta?.taskSpecRelativePath ? ` (${meta.taskSpecRelativePath})` : "";
  return (
    `Task ${taskId}: refusing BEFORE the gate. The spec this run has in hand does not ` +
    `match the authoritative one${where} ` +
    `(in hand ${divergence.inHandContractHash.slice(0, 12)}, authoritative ` +
    `${divergence.authoritativeContractHash.slice(0, 12)}). ` +
    `The usual cause is an amendment that has not reached the base branch the ` +
    `dispatch worktree is cut from, so the run would build from the OLD contract ` +
    `and then be refused for it. Nothing has been deleted. ` +
    // Round 6 (R6-1): this message used to carry its OWN advice, "push,
    // then dispatch" plus "replan will NOT clear this", written in round
    // 3 and never revisited when round 5 reversed the replan half. That
    // made it actively unsafe rather than merely stale: an operator who
    // pushed and dispatched fresh WITHOUT clearing an open approval got
    // the R5-1 bypass, and a pre-1332 record is `unknown_legacy`, so the
    // reuse check permits it by design and the new brief skips the gate
    // entirely. Two message producers with two answers is the defect;
    // there is now one.
    recoveryAdviceFor("diverged")
  );
}

/**
 * Round 4 (R4-1): recovery advice depends on the VERDICT, because the two
 * verdicts have different cures and the first cut gave both the same one.
 *
 * `stale` means the spec moved AFTER the artifact was built, so rebuilding the
 * artifact is the fix and replan does exactly that.
 *
 * `diverged` means the run was reading the WRONG SOURCE, and replan is actively
 * wrong for it: replan regenerates from the same worktree, and resume reopens
 * that same preserved worktree, so both reproduce the refusal. Only a push plus
 * a FRESH worktree changes what the run has in hand. Pointing an operator at
 * replan here is what turned a refusal into a loop.
 */
export function recoveryAdviceFor(verdict: SpecIdentityVerdict): string {
  switch (verdict) {
    case "contested":
      return (
        "Remove or rename the extra claimant files so exactly one file owns this task id. " +
        "Replanning cannot repair contested ownership; fix the claimant files first."
      );
    case "diverged":
      return (
        "PUSH the amended spec to the base branch FIRST. Then, if a blueprint approval " +
        "is open for this task, REPLAN to clear it, otherwise the next dispatch " +
        "reuses that approval for a brief nobody approved. Then start a FRESH " +
        "dispatch so the worktree is rebuilt from the updated base. Do NOT resume: " +
        "resume reopens the SAME preserved worktree and will reproduce this refusal. " +
        "Replanning before pushing will also reproduce it, because the new worktree " +
        "is cut from the base branch and not from your clone."
      );
    case "unverifiable":
      return (
        "The authoritative spec could not be READ, so nothing can be rebuilt from it " +
        "yet. Restore the task spec in the owning clone first: confirm the file " +
        "exists under the project's task directory, that it is readable, and that " +
        "exactly one file names this task as its parent (a subtask file alone is not " +
        "enough). THEN replan. Replanning first will fail for the same reason this " +
        "refusal fired."
      );
    case "match":
    case "stale":
    case "unknown_legacy":
      return (
        "Replan the task (POST /api/tasks/<taskId>/blueprint/replan) so the brief is " +
        "rebuilt and re-reviewed against the current spec. A plain re-dispatch will " +
        "repeat the refusal."
      );
    default: {
      const exhaustive: never = verdict;
      return exhaustive;
    }
  }
}

/**
 * Typed refusal so callers answer with a structured error instead of
 * re-deriving the condition. One source of truth for "this artifact no
 * longer matches its spec".
 */
export class StaleSpecIdentityError extends Error {
  constructor(
    readonly taskId: string,
    readonly surface: string,
    readonly comparison: SpecIdentityComparison,
  ) {
    super(
      `Task ${taskId}: refusing at ${surface} because ${comparison.reason}. ` +
        `Nothing has been deleted or rejected: the record, the checkpoint and the ` +
        `worktree are intact. ` +
        // Round 2 (R2-5) killed "stop, then replan": a refusal happens on an
        // already-exited child, so stop 404s. Round 4 (R4-1) then killed the
        // blanket "replan": right for `stale`, WRONG for `diverged`, where it
        // reproduces the refusal. The advice now follows the verdict.
        recoveryAdviceFor(comparison.verdict),
    );
    this.name = "StaleSpecIdentityError";
  }
}

/** Where the dispatcher records a refusal so the monitor can classify it
 *  from DISK rather than from a lifecycle callback. QPI-043's lesson: an
 *  SSE-only signal is not a signal. */
export function specStaleMarkerPath(logDir: string, taskId: string): string {
  return path.join(logDir, "spec-stale", `${taskId}.json`);
}

/** Clock skew tolerated between the child that writes a marker and the
 *  monitor that reads it. Mirrors paused-run-state's FUTURE_PEND_SKEW_MS. */
const MARKER_FUTURE_SKEW_MS = 5 * 60 * 1000;

export interface SpecStaleMarker {
  taskId: string;
  surface: string;
  verdict: SpecIdentityVerdict;
  reason: string;
  refusedAt: string;
}

/** Best-effort: a marker that cannot be written must never turn a clean
 *  refusal into a crash. The refusal itself is already durable in the
 *  session events and the returned outcome. */
export function writeSpecStaleMarker(logDir: string, marker: SpecStaleMarker): void {
  try {
    const target = specStaleMarkerPath(logDir, marker.taskId);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, JSON.stringify(marker, null, 2), "utf-8");
  } catch {
    // Diagnostic only.
  }
}

/**
 * Read a refusal marker attributable to THIS run.
 *
 * Run-scoped for the same reason TASK-1329's attribution is: a marker
 * left by an earlier run must never explain a later run's exit.
 */
export function readSpecStaleMarker(
  logDir: string,
  taskId: string,
  afterTimestamp: string,
): SpecStaleMarker | null {
  try {
    const raw = fs.readFileSync(specStaleMarkerPath(logDir, taskId), "utf-8");
    const parsed = JSON.parse(raw) as SpecStaleMarker;
    if (typeof parsed?.refusedAt !== "string" || typeof parsed.reason !== "string") return null;
    // Round 3 (R3-4): the marker must be about THIS task. The path already
    // encodes the id, but a mismatched body means the file is not what it
    // claims and nothing about it should be trusted.
    if (parsed.taskId !== taskId) return null;
    const refused = new Date(parsed.refusedAt).getTime();
    const after = new Date(afterTimestamp).getTime();
    if (Number.isNaN(refused) || Number.isNaN(after) || refused < after) return null;
    // Round 3 (R3-4): bound the OTHER end too, exactly as
    // resolveRunScopedPauseState does. A corrupt marker dated year 9999 is
    // "after the start" of every run that will ever exist, so without this
    // it would explain every future crash as a deliberate refusal — the
    // QPI-041 misclassification with the sign flipped.
    if (refused > Date.now() + MARKER_FUTURE_SKEW_MS) return null;
    return parsed;
  } catch {
    return null;
  }
}

/** Clear a stale marker so a later run is never explained by an older
 *  refusal. Called when a run gets past the check. */
export function clearSpecStaleMarker(logDir: string, taskId: string): void {
  try {
    fs.unlinkSync(specStaleMarkerPath(logDir, taskId));
  } catch {
    // Absent is the normal case.
  }
}
