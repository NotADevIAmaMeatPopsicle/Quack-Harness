// ─── TASK-1303: residual ledger reconcile — core module matrix ──────

import {
  runResidualReconcile,
  selectLatestBundle,
  canonicalIdFromSpecFilename,
  RESIDUAL_WRITE_GUARD,
  type ResidualBundleEvidence,
  type ResidualReconcileDeps,
} from "../../src/monitor/residual-reconcile";

function bundle(overrides: Partial<ResidualBundleEvidence>): ResidualBundleEvidence {
  return {
    taskId: "TASK-1",
    verdict: "VERIFIED",
    mergeReady: true,
    reviewId: "review-1",
    createdAt: "2026-06-01T10:00:00.000Z",
    ...overrides,
  };
}

function makeDeps(overrides: Partial<ResidualReconcileDeps> = {}): {
  deps: ResidualReconcileDeps;
  recordCalls: Array<{
    request: Parameters<ResidualReconcileDeps["record"]>[0];
    options: Parameters<ResidualReconcileDeps["record"]>[1];
  }>;
} {
  const recordCalls: Array<{
    request: Parameters<ResidualReconcileDeps["record"]>[0];
    options: Parameters<ResidualReconcileDeps["record"]>[1];
  }> = [];
  const deps: ResidualReconcileDeps = {
    ledgerIds: () => new Set(),
    readBundles: () => [],
    statuses: () => [],
    specDoneIds: () => [],
    taskExists: () => true,
    record: (request, options) => {
      recordCalls.push({ request, options });
      return Promise.resolve({ applied: true });
    },
    log: () => undefined,
    ...overrides,
  };
  return { deps, recordCalls };
}

describe("selectLatestBundle", () => {
  test("updatedAt beats createdAt ordering", () => {
    const older = bundle({ reviewId: "r-old", createdAt: "2026-06-02T00:00:00.000Z" });
    const newer = bundle({
      reviewId: "r-new",
      createdAt: "2026-06-01T00:00:00.000Z",
      updatedAt: "2026-06-03T00:00:00.000Z",
    });
    expect(selectLatestBundle([older, newer])?.reviewId).toBe("r-new");
  });

  test("malformed timestamps rank oldest and can never win", () => {
    const malformed = bundle({ reviewId: "r-bad", createdAt: "yesterday-ish" });
    const valid = bundle({ reviewId: "r-good", createdAt: "2026-01-01T00:00:00.000Z" });
    expect(selectLatestBundle([malformed, valid])?.reviewId).toBe("r-good");
    expect(selectLatestBundle([valid, malformed])?.reviewId).toBe("r-good");
  });

  test("exact-tie breaks deterministically by reviewId", () => {
    const a = bundle({ reviewId: "r-aaa" });
    const b = bundle({ reviewId: "r-bbb" });
    expect(selectLatestBundle([a, b])?.reviewId).toBe("r-bbb");
    expect(selectLatestBundle([b, a])?.reviewId).toBe("r-bbb");
  });
});

describe("runResidualReconcile — class A", () => {
  test("latest VERIFIED+mergeReady bundle would-record on dry-run; nothing written", async () => {
    const { deps, recordCalls } = makeDeps({
      readBundles: () => [bundle({ taskId: "TASK-10", reviewId: "r-10" })],
    });
    const result = await runResidualReconcile(deps, {});
    expect(result.dryRun).toBe(true);
    expect(recordCalls).toHaveLength(0);
    expect(result.candidates).toEqual([
      expect.objectContaining({
        taskId: "TASK-10",
        class: "A",
        disposition: "would-record",
        reviewId: "r-10",
      }),
    ]);
  });

  test("a LATER FAILED bundle disqualifies the task entirely", async () => {
    const { deps, recordCalls } = makeDeps({
      readBundles: () => [
        bundle({ taskId: "TASK-11", reviewId: "r-ok", createdAt: "2026-06-01T00:00:00.000Z" }),
        bundle({
          taskId: "TASK-11",
          reviewId: "r-fail",
          verdict: "FAILED",
          createdAt: "2026-06-05T00:00:00.000Z",
        }),
      ],
    });
    const result = await runResidualReconcile(deps, { apply: true });
    expect(recordCalls).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
    expect(result.recorded).toBe(0);
  });

  test("bundles for tasks already in the ledger are ignored (REJECTED rows unreachable)", async () => {
    const { deps, recordCalls } = makeDeps({
      ledgerIds: () => new Set(["TASK-12"]),
      readBundles: () => [bundle({ taskId: "TASK-12" })],
    });
    const result = await runResidualReconcile(deps, { apply: true });
    expect(recordCalls).toHaveLength(0);
    expect(result.candidates).toHaveLength(0);
  });

  test("apply writes through the trust-REJECTED guard with v1-review provenance", async () => {
    const { deps, recordCalls } = makeDeps({
      readBundles: () => [bundle({ taskId: "TASK-13", reviewId: "r-13", commitSha: "abc1234" })],
    });
    const result = await runResidualReconcile(deps, { apply: true });
    expect(result.recorded).toBe(1);
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0].request).toMatchObject({
      taskId: "TASK-13",
      verdict: "VERIFIED",
      method: "v1-review",
      reviewId: "r-13",
      commitSha: "abc1234",
    });
    expect(recordCalls[0].request.notes).toContain("closure-store bundle r-13");
    // NOT NULL ledger columns must always be present (round-2 HIGH).
    expect(recordCalls[0].request.criteriaChecked).toBe(0);
    expect(recordCalls[0].request.criteriaPassed).toBe(0);
    expect(recordCalls[0].options).toEqual(RESIDUAL_WRITE_GUARD);
    expect(RESIDUAL_WRITE_GUARD.skipIfExistingVerdict).toEqual(["VERIFIED", "REJECTED"]);
  });

  test("missing bundle commit falls back to the literal unknown", async () => {
    const { deps, recordCalls } = makeDeps({
      readBundles: () => [bundle({ taskId: "TASK-14", commitSha: "  " })],
    });
    await runResidualReconcile(deps, { apply: true });
    expect(recordCalls[0].request.commitSha).toBe("unknown");
  });

  test("guard skips surface as skipped-existing (idempotent re-apply)", async () => {
    const { deps, recordCalls } = makeDeps({
      readBundles: () => [bundle({ taskId: "TASK-15" })],
      record: () => Promise.resolve({ applied: false, skippedReason: "existing-verdict" }),
    });
    void recordCalls;
    const result = await runResidualReconcile(deps, { apply: true });
    expect(result.recorded).toBe(0);
    expect(result.skippedExisting).toBe(1);
    expect(result.candidates[0]).toMatchObject({ disposition: "skipped-existing" });
  });
});

describe("runResidualReconcile — unregistered allowlist", () => {
  test("spec-less ids are advisories without the allowlist, even on apply", async () => {
    const { deps, recordCalls } = makeDeps({
      readBundles: () => [bundle({ taskId: "TASK-SAURUS-REM-001", reviewId: "r-s1" })],
      taskExists: () => false,
    });
    const result = await runResidualReconcile(deps, { apply: true });
    expect(recordCalls).toHaveLength(0);
    expect(result.unregisteredAdvisories).toBe(1);
    expect(result.candidates[0]).toMatchObject({
      taskId: "TASK-SAURUS-REM-001",
      disposition: "unregistered-advisory",
    });
  });

  test("exact-id allowlist writes with the operator-allowlist marker; near-miss ids stay advisories", async () => {
    const { deps, recordCalls } = makeDeps({
      readBundles: () => [
        bundle({ taskId: "TASK-SAURUS-REM-001", reviewId: "r-s1" }),
        bundle({ taskId: "TASK-SAURUS-REM-002", reviewId: "r-s2" }),
      ],
      taskExists: () => false,
    });
    const result = await runResidualReconcile(deps, {
      apply: true,
      allowUnregisteredIds: new Set(["TASK-SAURUS-REM-001"]),
    });
    expect(recordCalls).toHaveLength(1);
    expect(recordCalls[0].request.taskId).toBe("TASK-SAURUS-REM-001");
    expect(recordCalls[0].request.notes).toContain("registry: closure-store (operator allowlist)");
    expect(result.unregisteredAdvisories).toBe(1);
    expect(result.candidates.find((c) => c.taskId === "TASK-SAURUS-REM-002")).toMatchObject({
      disposition: "unregistered-advisory",
    });
  });
});

describe("canonicalIdFromSpecFilename", () => {
  test("extracts numeric, letter-suffixed, BS-style, and multi-segment Saurus ids", () => {
    expect(canonicalIdFromSpecFilename("TASK-949-some-slug.md")).toBe("TASK-949");
    expect(canonicalIdFromSpecFilename("TASK-949-C-invitation-flow.md")).toBe("TASK-949-C");
    expect(canonicalIdFromSpecFilename("TASK-838-J-deep-port.md")).toBe("TASK-838-J");
    expect(canonicalIdFromSpecFilename("TASK-BS-01-authz-audit.md")).toBe("TASK-BS-01");
    expect(canonicalIdFromSpecFilename("TASK-SAURUS-REM-001-detail.md")).toBe(
      "TASK-SAURUS-REM-001",
    );
    expect(canonicalIdFromSpecFilename("TASK-SAURUS-REM-001.md")).toBe("TASK-SAURUS-REM-001");
  });

  test("rejects non-task and non-markdown names", () => {
    expect(canonicalIdFromSpecFilename("PENDING-brand-performance.md")).toBeUndefined();
    expect(canonicalIdFromSpecFilename("TASK-949-slug.txt")).toBeUndefined();
    expect(canonicalIdFromSpecFilename("README.md")).toBeUndefined();
    expect(canonicalIdFromSpecFilename("TASK-.md")).toBeUndefined();
  });
});

describe("runResidualReconcile — classes B and C are report-only", () => {
  test("status-done tasks report and never write, on dry-run and apply alike", async () => {
    const { deps, recordCalls } = makeDeps({
      statuses: () => [
        ["TASK-20", "COMPLETE"],
        ["TASK-21", "VERIFIED"],
        ["TASK-22", "IN_PROGRESS"],
      ],
    });
    const result = await runResidualReconcile(deps, { apply: true });
    expect(recordCalls).toHaveLength(0);
    expect(result.reportOnly).toBe(2);
    expect(result.candidates.map((c) => c.taskId).sort()).toEqual(["TASK-20", "TASK-21"]);
    expect(result.candidates.every((c) => c.class === "B" && c.disposition === "report-only")).toBe(
      true,
    );
  });

  test("class B excludes ids covered by ledger or class A; class C excludes all above", async () => {
    const { deps, recordCalls } = makeDeps({
      ledgerIds: () => new Set(["TASK-30"]),
      readBundles: () => [bundle({ taskId: "TASK-31", reviewId: "r-31" })],
      statuses: () => [
        ["TASK-30", "COMPLETE"],
        ["TASK-31", "COMPLETE"],
        ["TASK-32", "COMPLETE"],
      ],
      specDoneIds: () => ["TASK-30", "TASK-31", "TASK-32", "TASK-33"],
    });
    const result = await runResidualReconcile(deps, {});
    void recordCalls;
    const byId = Object.fromEntries(result.candidates.map((c) => [c.taskId, c]));
    expect(byId["TASK-30"]).toBeUndefined();
    expect(byId["TASK-31"]).toMatchObject({ class: "A", disposition: "would-record" });
    expect(byId["TASK-32"]).toMatchObject({ class: "B" });
    expect(byId["TASK-33"]).toMatchObject({ class: "C", disposition: "report-only" });
  });
});
