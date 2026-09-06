// ─── Authority Audit — the safety-coverage backbone (TASK-1313) ─────
// FAITHFUL PORT of `src/judgment/safety-boundary-audit.ts` from the
// preserved branch `codex/TASK-1312-safety-signal-producers` @ 27116ad
// (Operator-directed graft, 2026-08-04). Credit: the model — per-authority
// coverage with enforced-binding validation, observed absence as honest
// first-class coverage, exclusions that never excuse an uncovered
// authority, and INCOMPLETE as a representable truthful answer — is the
// codex lane's design, ported semantics-intact (round-1 F8).
//
// Documented extensions beyond their snapshot (new code postdates it):
//   - `machinery_tamper` joined SAFETY_FLOOR_CODES in TASK-1312, so it
//     is audited here with its own producer family.
//   - A `verification_machinery_write` operation for that family.
//   - The inventory below is updated to post-1312/1313 truth: the
//     TASK-1312 deletion guard upgraded the branch-deletion authorities
//     to `enforced`; config-gated (default-off) enforcement points are
//     deliberately declared `producer_only` with rationale — a dormant
//     guard is not structural enforcement, and this audit does not lie.

import { SAFETY_FLOOR_CODES, type JudgmentStage, type SafetyFloorCode } from "../judgment-types.js";

const AUDIT_IDENTIFIER_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,127}$/;

export function isSafetyAuditIdentifier(value: unknown): value is string {
  return typeof value === "string" && AUDIT_IDENTIFIER_PATTERN.test(value);
}

export const SAFETY_PRODUCER_FAMILIES = [
  "production_deploy",
  "protected_branch_mutation",
  "secret_exposure",
  "machinery_tamper",
] as const;

export type SafetyProducerFamily = (typeof SAFETY_PRODUCER_FAMILIES)[number];

export const SAFETY_BOUNDARY_OPERATIONS = [
  "production_service_mutation",
  "git_commit",
  "git_push",
  "git_reset",
  "git_branch_delete",
  "github_head_delete",
  "worker_git_interception",
  "secret_scan_boundary",
  "verification_machinery_write",
  "observed_absence",
] as const;

export type SafetyBoundaryOperation = (typeof SAFETY_BOUNDARY_OPERATIONS)[number];

export const SAFETY_BOUNDARY_COVERAGE = [
  "uncovered",
  "legacy_guard_only",
  "producer_only",
  "enforced",
] as const;

export type SafetyBoundaryCoverage = (typeof SAFETY_BOUNDARY_COVERAGE)[number];

export type AuditedSafetyCode = Exclude<SafetyFloorCode, "missing_required_schema">;

export const AUDITED_SAFETY_CODES = SAFETY_FLOOR_CODES.filter(
  (code): code is AuditedSafetyCode => code !== "missing_required_schema",
);

const PRODUCER_CODES: Record<SafetyProducerFamily, readonly AuditedSafetyCode[]> = {
  production_deploy: ["production_deploy"],
  protected_branch_mutation: ["protected_branch_history_rewrite", "protected_branch_delete"],
  secret_exposure: ["secret_exposure"],
  machinery_tamper: ["machinery_tamper"],
};

interface BoundaryBase {
  boundaryId: string;
  safetyCode: AuditedSafetyCode;
  operation: SafetyBoundaryOperation;
  sourceAnchor: string;
  rationale: string;
}

export interface SafetyAuthorityBoundary extends BoundaryBase {
  kind: "authority";
  authorityRef: string;
  coverage: SafetyBoundaryCoverage;
  producer?: SafetyProducerFamily;
  guardRef?: string;
}

export interface SafetyObservedAbsence extends BoundaryBase {
  kind: "observed_absent";
  evidenceRef: string;
}

export interface SafetyBoundaryExclusion extends BoundaryBase {
  kind: "exclusion";
  exclusion: "observed_dead" | "read_only" | "benign_local_state" | "documentation_only";
}

export type SafetyBoundaryDeclaration =
  | SafetyAuthorityBoundary
  | SafetyObservedAbsence
  | SafetyBoundaryExclusion;

export interface SafetyBoundaryAuditIssue {
  code:
    | "invalid_declaration"
    | "duplicate_boundary_id"
    | "unclaimed_safety_family"
    | "boundary_not_enforced"
    | "invalid_enforced_binding";
  boundaryId?: string;
  safetyCode?: AuditedSafetyCode;
  message: string;
}

export interface SafetyBoundaryFamilyAudit {
  safetyCode: AuditedSafetyCode;
  represented: boolean;
  authorityCount: number;
  enforcedCount: number;
  complete: boolean;
}

export interface SafetyBoundaryAuditResult {
  complete: boolean;
  issues: SafetyBoundaryAuditIssue[];
  families: SafetyBoundaryFamilyAudit[];
  declarations: SafetyBoundaryDeclaration[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validAnchor(value: unknown): value is string {
  return (
    typeof value === "string" && value.length > 2 && value.length <= 240 && !/[\r\n\0]/u.test(value)
  );
}

function parseDeclaration(value: unknown): SafetyBoundaryDeclaration | undefined {
  if (!isRecord(value)) return undefined;
  if (!isSafetyAuditIdentifier(value.boundaryId)) return undefined;
  if (!(AUDITED_SAFETY_CODES as readonly unknown[]).includes(value.safetyCode)) return undefined;
  if (!(SAFETY_BOUNDARY_OPERATIONS as readonly unknown[]).includes(value.operation))
    return undefined;
  if (!validAnchor(value.sourceAnchor) || !validAnchor(value.rationale)) return undefined;

  const base = {
    boundaryId: value.boundaryId,
    safetyCode: value.safetyCode as AuditedSafetyCode,
    operation: value.operation as SafetyBoundaryOperation,
    sourceAnchor: value.sourceAnchor,
    rationale: value.rationale,
  };

  if (value.kind === "observed_absent") {
    if (!validAnchor(value.evidenceRef)) return undefined;
    return { ...base, kind: "observed_absent", evidenceRef: value.evidenceRef };
  }
  if (value.kind === "exclusion") {
    if (
      !["observed_dead", "read_only", "benign_local_state", "documentation_only"].includes(
        String(value.exclusion),
      )
    ) {
      return undefined;
    }
    return {
      ...base,
      kind: "exclusion",
      exclusion: value.exclusion as SafetyBoundaryExclusion["exclusion"],
    };
  }
  if (value.kind !== "authority") return undefined;
  if (!isSafetyAuditIdentifier(value.authorityRef)) return undefined;
  if (!(SAFETY_BOUNDARY_COVERAGE as readonly unknown[]).includes(value.coverage)) return undefined;
  if (
    value.producer !== undefined &&
    !(SAFETY_PRODUCER_FAMILIES as readonly unknown[]).includes(value.producer)
  )
    return undefined;
  if (value.guardRef !== undefined && !isSafetyAuditIdentifier(value.guardRef)) return undefined;
  return {
    ...base,
    kind: "authority",
    authorityRef: value.authorityRef,
    coverage: value.coverage as SafetyBoundaryCoverage,
    ...(value.producer ? { producer: value.producer as SafetyProducerFamily } : {}),
    ...(value.guardRef ? { guardRef: value.guardRef } : {}),
  };
}

function issueSort(left: SafetyBoundaryAuditIssue, right: SafetyBoundaryAuditIssue): number {
  return `${left.safetyCode ?? ""}:${left.boundaryId ?? ""}:${left.code}`.localeCompare(
    `${right.safetyCode ?? ""}:${right.boundaryId ?? ""}:${right.code}`,
  );
}

/**
 * Audit a declaration set. Ported semantics: enforced requires a
 * matching producer AND a pre-side-effect guardRef; every non-enforced
 * authority is an issue; a family is complete only when every one of
 * its authorities is enforced (or its only coverage is honest observed
 * absence); an unrelated exclusion never excuses an uncovered authority.
 */
export function auditSafetyBoundaries(declarations: readonly unknown[]): SafetyBoundaryAuditResult {
  const issues: SafetyBoundaryAuditIssue[] = [];
  const parsed: SafetyBoundaryDeclaration[] = [];
  const ids = new Set<string>();

  declarations.forEach((declaration, index) => {
    const item = parseDeclaration(declaration);
    if (!item) {
      issues.push({
        code: "invalid_declaration",
        message: `declarations[${index}] is not a canonical safety boundary declaration`,
      });
      return;
    }
    if (ids.has(item.boundaryId)) {
      issues.push({
        code: "duplicate_boundary_id",
        boundaryId: item.boundaryId,
        safetyCode: item.safetyCode,
        message: "Safety boundary id is duplicated",
      });
      return;
    }
    ids.add(item.boundaryId);
    parsed.push(item);

    if (item.kind !== "authority") return;
    const producerMatches =
      item.producer !== undefined && PRODUCER_CODES[item.producer].includes(item.safetyCode);
    if (item.coverage === "enforced" && (!producerMatches || !item.guardRef)) {
      issues.push({
        code: "invalid_enforced_binding",
        boundaryId: item.boundaryId,
        safetyCode: item.safetyCode,
        message: "Enforced boundary lacks its matching producer or pre-side-effect guard",
      });
    } else if (item.coverage !== "enforced") {
      issues.push({
        code: "boundary_not_enforced",
        boundaryId: item.boundaryId,
        safetyCode: item.safetyCode,
        message: `Boundary coverage is ${item.coverage}`,
      });
    }
  });

  const families = AUDITED_SAFETY_CODES.map((safetyCode) => {
    const relevant = parsed.filter(
      (item) => item.safetyCode === safetyCode && item.kind !== "exclusion",
    );
    const authorities = relevant.filter(
      (item): item is SafetyAuthorityBoundary => item.kind === "authority",
    );
    const represented = relevant.length > 0;
    if (!represented) {
      issues.push({
        code: "unclaimed_safety_family",
        safetyCode,
        message: "Canonical safety family has no authority or observed-absent evidence",
      });
    }
    const enforcedCount = authorities.filter(
      (item) =>
        item.coverage === "enforced" &&
        item.producer !== undefined &&
        PRODUCER_CODES[item.producer].includes(safetyCode) &&
        Boolean(item.guardRef),
    ).length;
    const onlyObservedAbsent = represented && authorities.length === 0;
    return {
      safetyCode,
      represented,
      authorityCount: authorities.length,
      enforcedCount,
      complete:
        onlyObservedAbsent || (authorities.length > 0 && enforcedCount === authorities.length),
    } satisfies SafetyBoundaryFamilyAudit;
  });

  const sortedIssues = issues.sort(issueSort);
  return {
    complete: sortedIssues.length === 0 && families.every((family) => family.complete),
    issues: sortedIssues,
    families,
    declarations: parsed.map((item) => ({ ...item })),
  };
}

const authority = (
  boundaryId: string,
  safetyCode: AuditedSafetyCode,
  operation: SafetyBoundaryOperation,
  sourceAnchor: string,
  coverage: SafetyBoundaryCoverage,
  rationale: string,
  producer?: SafetyProducerFamily,
  guardRef?: string,
): SafetyAuthorityBoundary => ({
  kind: "authority",
  boundaryId,
  safetyCode,
  operation,
  sourceAnchor,
  authorityRef: boundaryId,
  coverage,
  rationale,
  ...(producer ? { producer } : {}),
  ...(guardRef ? { guardRef } : {}),
});

const DELETION_GUARD = "judgment/producers/branch-mutation.assertBranchDeletionAllowed";
const GIT_FLOOR_GUARD = "worker/git-floor.checkGitFloor";

/**
 * The post-TASK-1312/1313 truth. Updated from the codex-lane snapshot:
 * deletion authorities carry the always-on 1312 guard (enforced);
 * config-gated default-off enforcement stays producer_only by policy
 * (see module header); everything still uncovered says so.
 */
export const SAFETY_BOUNDARY_INVENTORY: readonly SafetyBoundaryDeclaration[] = [
  // ── production_deploy (decision 3: signal-only by ratified choice) ──
  authority(
    "deploy.headnode.full",
    "production_deploy",
    "production_service_mutation",
    "scripts/deploy-quack-to-headnode.sh:78",
    "uncovered",
    "Direct service restart outside the judgment plane",
  ),
  authority(
    "deploy.headnode.monitor_restart",
    "production_deploy",
    "production_service_mutation",
    "scripts/admin/headnode-restart-monitor.ps1:22",
    "uncovered",
    "Approved wrapper still has no structured safety producer",
  ),
  authority(
    "deploy.headnode.listener_enable",
    "production_deploy",
    "production_service_mutation",
    "scripts/admin/install-headnode-listener.sh:97",
    "uncovered",
    "Enables a production listener service",
  ),
  authority(
    "deploy.headnode.listener_restart",
    "production_deploy",
    "production_service_mutation",
    "scripts/admin/install-headnode-listener.sh:98",
    "uncovered",
    "Restarts a production listener service",
  ),
  authority(
    "deploy.worker.bash",
    "production_deploy",
    "production_service_mutation",
    "src/worker/agent-worker.ts:315",
    "producer_only",
    "Worker bash can run deploy-shaped commands; the TASK-1312 classifier observes (signal-only per ratified decision 3)",
    "production_deploy",
  ),
  // ── protected_branch_history_rewrite ──
  {
    kind: "observed_absent",
    boundaryId: "branch.force_push.absent",
    safetyCode: "protected_branch_history_rewrite",
    operation: "observed_absence",
    sourceAnchor: "src/dispatcher/branch-manager.ts:403",
    evidenceRef: "audit.rg.no_force_push",
    rationale: "Quack push helpers explicitly avoid force push at this snapshot",
  },
  authority(
    "history.worker.interception",
    "protected_branch_history_rewrite",
    "worker_git_interception",
    "src/worker/git-floor.ts:1",
    "enforced",
    "TASK-1312 floor denies force-push/plumbing rewrites pre-execution and classifies attempts",
    "protected_branch_mutation",
    GIT_FLOOR_GUARD,
  ),
  {
    kind: "exclusion",
    boundaryId: "exclude.canonical_spec.reset_608",
    safetyCode: "protected_branch_history_rewrite",
    operation: "git_reset",
    sourceAnchor: "src/monitor/server.ts:608",
    exclusion: "benign_local_state",
    rationale: "Unstages one task path after a guarded staging mismatch",
  },
  {
    kind: "exclusion",
    boundaryId: "exclude.canonical_spec.reset_627",
    safetyCode: "protected_branch_history_rewrite",
    operation: "git_reset",
    sourceAnchor: "src/monitor/server.ts:627",
    exclusion: "benign_local_state",
    rationale: "Unstages one task path after commit failure",
  },
  {
    kind: "exclusion",
    boundaryId: "exclude.autocommit.reset",
    safetyCode: "protected_branch_history_rewrite",
    operation: "git_reset",
    sourceAnchor: "src/dispatcher/branch-manager.ts:514",
    exclusion: "benign_local_state",
    rationale: "Unstages generated runtime files only",
  },
  {
    kind: "exclusion",
    boundaryId: "exclude.detached_merge.reset",
    safetyCode: "protected_branch_history_rewrite",
    operation: "git_reset",
    sourceAnchor: "src/dispatcher/branch-manager.ts:764",
    exclusion: "benign_local_state",
    rationale: "Restores temporary detached worktree after squash failure",
  },
  {
    kind: "exclusion",
    boundaryId: "exclude.federation.reset",
    safetyCode: "protected_branch_history_rewrite",
    operation: "git_reset",
    sourceAnchor: "src/monitor/federation/orchestration.ts:192",
    exclusion: "benign_local_state",
    rationale: "Restores temporary federation worktree after failure",
  },
  // ── protected_branch_delete ──
  authority(
    "branch.worker.interception",
    "protected_branch_delete",
    "worker_git_interception",
    "src/worker/agent-worker.ts:256",
    "enforced",
    "TASK-1312 floor denies branch deletion pre-execution and records attempt facts",
    "protected_branch_mutation",
    GIT_FLOOR_GUARD,
  ),
  authority(
    "branch.create.stale_local_delete",
    "protected_branch_delete",
    "git_branch_delete",
    "src/dispatcher/branch-manager.ts:349",
    "enforced",
    "TASK-1312 guard checked before the recovery delete",
    "protected_branch_mutation",
    DELETION_GUARD,
  ),
  authority(
    "branch.cleanup.local_delete",
    "protected_branch_delete",
    "git_branch_delete",
    "src/dispatcher/branch-manager.ts:445",
    "enforced",
    "TASK-1312 guard checked before local cleanup",
    "protected_branch_mutation",
    DELETION_GUARD,
  ),
  authority(
    "branch.cleanup.remote_delete",
    "protected_branch_delete",
    "git_branch_delete",
    "src/dispatcher/branch-manager.ts:462",
    "enforced",
    "TASK-1312 guard precedes the remote cleanup in the same guarded block",
    "protected_branch_mutation",
    DELETION_GUARD,
  ),
  authority(
    "branch.merge.github_head_delete",
    "protected_branch_delete",
    "github_head_delete",
    "src/dispatcher/branch-manager.ts:887",
    "legacy_guard_only",
    "GitHub-mediated PR head deletion is not wrapped by the TASK-1312 guard",
  ),
  authority(
    "branch.merge.detached_local_delete",
    "protected_branch_delete",
    "git_branch_delete",
    "src/dispatcher/branch-manager.ts:941",
    "enforced",
    "TASK-1312 guard gates the detached-merge cleanup pair",
    "protected_branch_mutation",
    DELETION_GUARD,
  ),
  authority(
    "branch.merge.detached_remote_delete",
    "protected_branch_delete",
    "git_branch_delete",
    "src/dispatcher/branch-manager.ts:943",
    "enforced",
    "TASK-1312 guard gates the detached-merge cleanup pair",
    "protected_branch_mutation",
    DELETION_GUARD,
  ),
  authority(
    "branch.retention.local_delete",
    "protected_branch_delete",
    "git_branch_delete",
    "src/dispatcher/branch-manager.ts:1447",
    "enforced",
    "Retention delete consumes the shared resolveProtectedBranches set before deleting",
    "protected_branch_mutation",
    DELETION_GUARD,
  ),
  authority(
    "branch.retention.remote_delete",
    "protected_branch_delete",
    "git_branch_delete",
    "src/dispatcher/branch-manager.ts:1456",
    "enforced",
    "Sweep consumes the shared resolveProtectedBranches set before deleting",
    "protected_branch_mutation",
    DELETION_GUARD,
  ),
  authority(
    "branch.dispatch.stale_delete",
    "protected_branch_delete",
    "git_branch_delete",
    "src/monitor/dispatch-manager.ts:695",
    "enforced",
    "TASK-1312 guard checked before the monitor stale-branch delete",
    "protected_branch_mutation",
    DELETION_GUARD,
  ),
  // ── secret_exposure ──
  authority(
    "secret.output_sealer.commit",
    "secret_exposure",
    "git_commit",
    "src/dispatcher/output-snapshot.ts:306",
    "producer_only",
    "TASK-1312 scan detects at seal time; the commit itself precedes detection",
    "secret_exposure",
  ),
  authority(
    "secret.lifecycle.commit",
    "secret_exposure",
    "git_commit",
    "src/dispatcher/lifecycle-manager.ts:793",
    "uncovered",
    "Commits task lifecycle changes without a secret detector",
  ),
  authority(
    "secret.autocommit.commit",
    "secret_exposure",
    "git_commit",
    "src/dispatcher/branch-manager.ts:533",
    "uncovered",
    "Automatic commit authority lacks a secret detector",
  ),
  authority(
    "secret.task_branch.push",
    "secret_exposure",
    "git_push",
    "src/dispatcher/branch-manager.ts:410",
    "uncovered",
    "Publishes task branch without a secret detector",
  ),
  authority(
    "secret.merge.detached_push",
    "secret_exposure",
    "git_push",
    "src/dispatcher/branch-manager.ts:842",
    "uncovered",
    "Publishes merge target without a secret detector",
  ),
  authority(
    "secret.merge.target_push",
    "secret_exposure",
    "git_push",
    "src/dispatcher/branch-manager.ts:1043",
    "uncovered",
    "Publishes target branch without a secret detector",
  ),
  authority(
    "secret.status.commit",
    "secret_exposure",
    "git_commit",
    "src/dispatcher/branch-manager.ts:1145",
    "uncovered",
    "Commits task status without a secret detector",
  ),
  authority(
    "secret.status.push",
    "secret_exposure",
    "git_push",
    "src/dispatcher/branch-manager.ts:1156",
    "uncovered",
    "Pushes caller-selected target without a secret detector",
  ),
  authority(
    "secret.canonical_spec.commit",
    "secret_exposure",
    "git_commit",
    "src/monitor/server.ts:621",
    "uncovered",
    "Commits canonical task spec without a secret detector",
  ),
  authority(
    "secret.canonical_spec.push",
    "secret_exposure",
    "git_push",
    "src/monitor/server.ts:665",
    "uncovered",
    "Pushes current branch without a secret detector",
  ),
  authority(
    "secret.subtask.commit",
    "secret_exposure",
    "git_commit",
    "src/preflight/subtask-writer.ts:152",
    "uncovered",
    "Commits generated subtasks without a secret detector",
  ),
  authority(
    "secret.federation.detached_push",
    "secret_exposure",
    "git_push",
    "src/monitor/federation/orchestration.ts:187",
    "uncovered",
    "Federation merge target publication lacks a secret detector",
  ),
  authority(
    "secret.federation.target_push",
    "secret_exposure",
    "git_push",
    "src/monitor/federation/orchestration.ts:317",
    "uncovered",
    "Federation target publication lacks a secret detector",
  ),
  authority(
    "secret.wiki.commit",
    "secret_exposure",
    "git_commit",
    "src/monitor/routes/wiki.ts:924",
    "uncovered",
    "Cross-repo wiki commit lacks a secret detector",
  ),
  authority(
    "secret.wiki.push",
    "secret_exposure",
    "git_push",
    "src/monitor/routes/wiki.ts:971",
    "uncovered",
    "Cross-repo wiki publication lacks a secret detector",
  ),
  {
    kind: "exclusion",
    boundaryId: "exclude.worker.git_commit",
    safetyCode: "secret_exposure",
    operation: "git_commit",
    sourceAnchor: "src/worker/tools/git.ts:125",
    exclusion: "observed_dead",
    rationale: "Deprecated worker commit helper is not registered",
  },
  // ── machinery_tamper (family extension; see module header) ──
  authority(
    "machinery.seal.conformance",
    "machinery_tamper",
    "verification_machinery_write",
    "src/dispatcher/output-snapshot.ts:397",
    "producer_only",
    "TASK-1312 seal conformance detects post-commit; not pre-side-effect",
    "machinery_tamper",
  ),
  authority(
    "machinery.verification.barrier",
    "machinery_tamper",
    "verification_machinery_write",
    "src/judgment/producers/machinery-integrity.ts:1",
    "producer_only",
    "TASK-1313 barrier is config-gated default-off; a dormant guard is not structural enforcement",
    "machinery_tamper",
  ),
  authority(
    "machinery.resume.validation",
    "machinery_tamper",
    "verification_machinery_write",
    "src/judgment/producers/machinery-integrity.ts:1",
    "producer_only",
    "TASK-1313 resume validation is config-gated default-off",
    "machinery_tamper",
  ),
] as const;

/** Audit the shipped inventory. The committed coverage test pins this. */
export function auditSafetyCoverage(): SafetyBoundaryAuditResult {
  return auditSafetyBoundaries(SAFETY_BOUNDARY_INVENTORY);
}

/**
 * Stages deliberately EXCLUDED from producer-signal injection (round-2
 * F9b). These are stage-level wiring exclusions, not authority
 * operations — forcing them into SAFETY_BOUNDARY_OPERATIONS would
 * misdeclare them as protected operations, so they are recorded as
 * their own typed export. The committed test pins the completeness
 * invariant: exclusions plus injection targets cover every judgment
 * stage exactly.
 */
export const STAGE_INJECTION_TARGETS = [
  "loop_diff",
  "judge",
] as const satisfies readonly JudgmentStage[];

export const STAGE_INJECTION_EXCLUSIONS = [
  {
    stage: "post_judge",
    reason:
      "facts were already injected and judged one stage earlier at the judge gate; duplicate injection is noise",
  },
  {
    stage: "readiness",
    reason:
      "producer facts derive from sealed attempts and worker runs, which do not exist before dispatch",
  },
  {
    stage: "docs_review",
    reason:
      "producer facts derive from sealed attempts and worker runs, which are not observable at docs review",
  },
  {
    stage: "loop_brief",
    reason: "the brief gate precedes the build; no sealed attempt or worker-run facts exist yet",
  },
] as const satisfies readonly { stage: JudgmentStage; reason: string }[];
