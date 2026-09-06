// ─── Authority audit tests (TASK-1313 S7) ───────────────────────────
// The COVERAGE PIN: the shipped inventory's audit result is asserted
// exactly, so any coverage regression (or dishonest completeness claim)
// fails the suite. INCOMPLETE families are pinned as incomplete — that
// is the truthful current state, not a defect in this test.

import {
  AUDITED_SAFETY_CODES,
  auditSafetyBoundaries,
  auditSafetyCoverage,
  SAFETY_BOUNDARY_INVENTORY,
  STAGE_INJECTION_EXCLUSIONS,
  STAGE_INJECTION_TARGETS,
} from "../../../src/judgment/producers/authority-audit";
import { JUDGMENT_STAGES, SAFETY_FLOOR_CODES } from "../../../src/judgment/judgment-types";

describe("audit model semantics (ported from codex-1312 @ 27116ad)", () => {
  it("missing_required_schema is excluded from audited codes", () => {
    expect(AUDITED_SAFETY_CODES).not.toContain("missing_required_schema");
    expect(AUDITED_SAFETY_CODES.length).toBe(SAFETY_FLOOR_CODES.length - 1);
  });

  it("an enforced authority requires a matching producer AND a guardRef", () => {
    const result = auditSafetyBoundaries([
      {
        kind: "authority",
        boundaryId: "x.enforced_without_guard",
        safetyCode: "protected_branch_delete",
        operation: "git_branch_delete",
        sourceAnchor: "src/somewhere.ts:1",
        rationale: "claims enforcement without a guard",
        authorityRef: "x.enforced_without_guard",
        coverage: "enforced",
        producer: "protected_branch_mutation",
      },
    ]);
    expect(result.issues.some((i) => i.code === "invalid_enforced_binding")).toBe(true);
    expect(result.complete).toBe(false);
  });

  it("an unrelated exclusion never excuses an uncovered family", () => {
    const result = auditSafetyBoundaries([
      {
        kind: "exclusion",
        boundaryId: "x.exclusion",
        safetyCode: "secret_exposure",
        operation: "git_commit",
        sourceAnchor: "src/somewhere.ts:1",
        rationale: "dead code",
        exclusion: "observed_dead",
      },
    ]);
    const secret = result.families.find((f) => f.safetyCode === "secret_exposure");
    // The exclusion does not represent the family: it stays unclaimed.
    expect(secret?.represented).toBe(false);
    expect(
      result.issues.some(
        (i) => i.code === "unclaimed_safety_family" && i.safetyCode === "secret_exposure",
      ),
    ).toBe(true);
  });

  it("observed absence alone is honest, complete coverage", () => {
    const result = auditSafetyBoundaries([
      {
        kind: "observed_absent",
        boundaryId: "x.absent",
        safetyCode: "protected_branch_history_rewrite",
        operation: "observed_absence",
        sourceAnchor: "src/somewhere.ts:1",
        rationale: "no force push exists",
        evidenceRef: "audit.rg.none",
      },
    ]);
    const family = result.families.find((f) => f.safetyCode === "protected_branch_history_rewrite");
    expect(family?.complete).toBe(true);
    expect(family?.authorityCount).toBe(0);
  });

  it("duplicate boundary ids and invalid declarations are issues", () => {
    const decl = SAFETY_BOUNDARY_INVENTORY[0];
    const result = auditSafetyBoundaries([decl, decl, { junk: true }]);
    expect(result.issues.some((i) => i.code === "duplicate_boundary_id")).toBe(true);
    expect(result.issues.some((i) => i.code === "invalid_declaration")).toBe(true);
  });
});

describe("THE COVERAGE PIN — shipped inventory truth", () => {
  const result = auditSafetyCoverage();

  it("every audited family is represented", () => {
    for (const family of result.families) {
      expect(family.represented).toBe(true);
    }
  });

  it("pins the per-family truth (update DELIBERATELY when coverage changes)", () => {
    const byCode = Object.fromEntries(result.families.map((f) => [f.safetyCode, f]));
    // Deploy scripts remain uncovered by ratified decision 3 (signal-only).
    expect(byCode.production_deploy).toMatchObject({
      authorityCount: 5,
      enforcedCount: 0,
      complete: false,
    });
    // The worker floor enforces history rewrites; observed absence covers pushes.
    expect(byCode.protected_branch_history_rewrite).toMatchObject({
      authorityCount: 1,
      enforcedCount: 1,
      complete: true,
    });
    // GitHub head deletion stays legacy-guard-only: family honest-incomplete.
    expect(byCode.protected_branch_delete).toMatchObject({
      authorityCount: 10,
      enforcedCount: 9,
      complete: false,
    });
    // Most commit/push authorities have no secret detector yet.
    expect(byCode.secret_exposure).toMatchObject({
      authorityCount: 15,
      enforcedCount: 0,
      complete: false,
    });
    // Config-gated default-off enforcement is producer_only by policy.
    expect(byCode.machinery_tamper).toMatchObject({
      authorityCount: 3,
      enforcedCount: 0,
      complete: false,
    });
  });

  it("the overall result is honestly INCOMPLETE", () => {
    expect(result.complete).toBe(false);
  });

  it("no invalid declarations or duplicate ids in the shipped inventory", () => {
    expect(result.issues.filter((i) => i.code === "invalid_declaration")).toEqual([]);
    expect(result.issues.filter((i) => i.code === "duplicate_boundary_id")).toEqual([]);
    expect(result.issues.filter((i) => i.code === "invalid_enforced_binding")).toEqual([]);
    expect(result.issues.filter((i) => i.code === "unclaimed_safety_family")).toEqual([]);
  });
});

describe("stage-injection exclusions (round-2 F9b)", () => {
  it("exclusions plus injection targets cover every judgment stage exactly", () => {
    const covered = [
      ...STAGE_INJECTION_TARGETS,
      ...STAGE_INJECTION_EXCLUSIONS.map((exclusion) => exclusion.stage),
    ].sort();
    expect(covered).toEqual([...JUDGMENT_STAGES].sort());
  });

  it("the injection targets are exactly the wired stages", () => {
    expect([...STAGE_INJECTION_TARGETS]).toEqual(["loop_diff", "judge"]);
  });

  it("every exclusion carries a substantive reason", () => {
    for (const exclusion of STAGE_INJECTION_EXCLUSIONS) {
      expect(exclusion.reason.length).toBeGreaterThan(20);
    }
  });
});
