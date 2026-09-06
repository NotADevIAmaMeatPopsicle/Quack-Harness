// ─── TASK-1324 S3: enforcement wiring pins ─────────────────────────
// A fidelity-failed brief must be structurally un-approvable and unable
// to destroy a good cached brief: the auto-approve predicate (both
// modes consult it), the loop-gate eligibility axis, and the monotonic
// cache guard at the single preflight persist point.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { evaluateAutoApprove } from "../../src/dispatcher/blueprint-approval";
import { resolveCachedBlueprint } from "../../src/blueprint/cached-blueprint";
import { PrepCache } from "../../src/monitor/prep-cache";
import type { Blueprint, BriefFidelityResult } from "../../src/blueprint/blueprint-types";
import type { PreflightResult } from "../../src/preflight/preflight-types";

const RULES = { maxFiles: 10, maxCriteria: 10, minBlueprintScore: 0, requireDecomposition: false };

function fidelity(status: "ok" | "failed"): BriefFidelityResult {
  return {
    status,
    violations: status === "failed" ? [{ kind: "empty_brief", detail: "stub shape" }] : [],
    checkedAt: "2026-08-10T04:00:00.000Z",
    scope: "typed-surface+file-existence",
  };
}

function brief(partial: Partial<Blueprint>): Blueprint {
  return {
    taskId: "TASK-999",
    fileAnalyses: [],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
    preconditions: [],
    ...partial,
  };
}

function preflightResult(partial: {
  contentHash: string;
  timestamp: string;
  structured?: Blueprint;
}): PreflightResult {
  return {
    taskId: "TASK-999",
    timestamp: partial.timestamp,
    contentHash: partial.contentHash,
    gate: { ready: true, score: 48, dimensions: {}, readinessJudgmentMode: "off" },
    blueprint: {
      fileAnalyses: partial.structured?.fileAnalyses.length ?? 0,
      codeExamples: 0,
      verificationPatterns: 0,
      antiPatterns: 0,
      formattedMarkdown: "# brief",
      ...(partial.structured ? { structured: partial.structured } : {}),
    },
    contextEstimate: {
      totalTokens: 0,
      breakdown: {},
      warnings: [],
    } as unknown as PreflightResult["contextEstimate"],
    complexity: { recommendDecomposition: false } as unknown as PreflightResult["complexity"],
    mode: "full",
  } as PreflightResult;
}

describe("TASK-1324 S3: auto-approve predicate", () => {
  it("refuses a fidelity-failed brief even when every threshold passes", () => {
    const failed = brief({ fidelity: fidelity("failed") });
    expect(evaluateAutoApprove(failed, undefined, RULES)).toBe(false);
  });

  it("still approves a fidelity-ok brief and tolerates absent fidelity (legacy)", () => {
    expect(evaluateAutoApprove(brief({ fidelity: fidelity("ok") }), undefined, RULES)).toBe(true);
    expect(evaluateAutoApprove(brief({}), undefined, RULES)).toBe(true);
  });
});

describe("TASK-1324 S5: fidelity seam tripwire", () => {
  // The compile guarantee is the seam INSIDE generateBlueprint (every
  // fresh synthesis leaves stamped) plus the dispatcher timeout stub
  // stamping its own. These source pins are the tripwire for a refactor
  // that quietly removes either — same pattern as the 1323 grep-pin.
  const read = (rel: string): string =>
    fs.readFileSync(path.resolve(__dirname, "..", "..", rel), "utf-8");

  it("generateBlueprint stamps at its return seam (race + catch fallback)", () => {
    const source = read("src/blueprint/blueprint-agent.ts");
    const stamps = source.match(/stampBriefFidelity\(/g) ?? [];
    expect(stamps.length).toBeGreaterThanOrEqual(2);
    expect(source).toMatch(/stampBriefFidelity\(\s*await Promise\.race/);
  });

  it("the dispatcher timeout stub stamps its own fidelity", () => {
    const source = read("src/dispatcher/dispatcher.ts");
    expect(source).toMatch(/stampBriefFidelity\(createMinimalBlueprint\(taskId\)/);
  });

  it("the legacy-cache placeholder stays un-audited but reattaches a persisted verdict", () => {
    const source = read("src/blueprint/cached-blueprint.ts");
    expect(source).not.toContain("stampBriefFidelity");
    expect(source).toContain("the stub itself is NOT audited");
    // Round-2 F1: the persisted verdict reattaches on BOTH resolution arms.
    expect(source).toContain("persistedFidelity");
  });
});

describe("TASK-1324 S3: monotonic cache guard", () => {
  let projectRoot: string;
  let cache: PrepCache;

  const goodBrief = brief({
    fileAnalyses: [
      {
        filePath: "src/x.ts",
        action: "Modify",
        currentStructure: "n/a",
        integrationPoints: "n/a",
        patternToFollow: "n/a",
      },
    ],
    fidelity: fidelity("ok"),
  });
  const failedBrief = brief({ fidelity: fidelity("failed") });

  beforeEach(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-monotonic-"));
    cache = new PrepCache(projectRoot);
  });

  afterEach(() => {
    fs.rmSync(projectRoot, { recursive: true, force: true });
  });

  it("preserves a cached fidelity-ok brief when a failed synthesis tries to overwrite it (same hash)", async () => {
    await cache.writePreflight(
      preflightResult({
        contentHash: "hash-1",
        timestamp: "2026-08-10T01:00:00.000Z",
        structured: goodBrief,
      }),
    );
    await cache.writePreflight(
      preflightResult({
        contentHash: "hash-1",
        timestamp: "2026-08-10T02:00:00.000Z",
        structured: failedBrief,
      }),
    );

    const stored = await cache.readPreflight("TASK-999", "hash-1");
    expect(stored?.blueprint.structured?.fidelity?.status).toBe("ok");
    expect(stored?.blueprint.structured?.fileAnalyses).toHaveLength(1);
    expect(stored?.blueprint.structuredPreserved).toMatchObject({
      reason: "fidelity_monotonic_guard",
      preservedFrom: "2026-08-10T01:00:00.000Z",
    });
    // The fresh result's own metadata still wrote (the guard splices the
    // blueprint section only).
    expect(stored?.timestamp).toBe("2026-08-10T02:00:00.000Z");
  });

  it("stands aside when the contentHash changed (the spec moved; the old brief is obsolete)", async () => {
    await cache.writePreflight(
      preflightResult({
        contentHash: "hash-1",
        timestamp: "2026-08-10T01:00:00.000Z",
        structured: goodBrief,
      }),
    );
    await cache.writePreflight(
      preflightResult({
        contentHash: "hash-2",
        timestamp: "2026-08-10T02:00:00.000Z",
        structured: failedBrief,
      }),
    );

    const stored = await cache.readPreflight("TASK-999", "hash-2");
    expect(stored?.blueprint.structured?.fidelity?.status).toBe("failed");
    expect(stored?.blueprint.structuredPreserved).toBeUndefined();
  });

  it("writes a failed brief plainly when no prior cache exists (nothing to protect)", async () => {
    await cache.writePreflight(
      preflightResult({
        contentHash: "hash-1",
        timestamp: "2026-08-10T01:00:00.000Z",
        structured: failedBrief,
      }),
    );
    const stored = await cache.readPreflight("TASK-999", "hash-1");
    expect(stored?.blueprint.structured?.fidelity?.status).toBe("failed");
    expect(stored?.blueprint.structuredPreserved).toBeUndefined();
  });

  it("round-2 F4: the guard splices contextEstimate and complexity from the preserved synthesis", async () => {
    const good = preflightResult({
      contentHash: "hash-1",
      timestamp: "2026-08-10T01:00:00.000Z",
      structured: goodBrief,
    });
    (good.complexity as unknown as { recommendDecomposition: boolean }).recommendDecomposition =
      false;
    await cache.writePreflight(good);

    const fresh = preflightResult({
      contentHash: "hash-1",
      timestamp: "2026-08-10T02:00:00.000Z",
      structured: failedBrief,
    });
    (fresh.complexity as unknown as { recommendDecomposition: boolean }).recommendDecomposition =
      true;
    await cache.writePreflight(fresh);

    const stored = await cache.readPreflight("TASK-999", "hash-1");
    // Everything derived from the preserved synthesis travels with it.
    expect(
      (stored?.complexity as unknown as { recommendDecomposition: boolean }).recommendDecomposition,
    ).toBe(false);
    expect(stored?.blueprint.structuredPreserved?.reason).toBe("fidelity_monotonic_guard");
  });
});

describe("TASK-1324 round-2 F1: fidelity survives the structured size-drop", () => {
  it("resolveCachedBlueprint reattaches the persisted verdict to the size-drop stub", () => {
    const failed: BriefFidelityResult = fidelity("failed");
    const cached = preflightResult({
      contentHash: "hash-1",
      timestamp: "2026-08-10T01:00:00.000Z",
    });
    // Simulate the 256KB honesty guard: no structured object, but the
    // verdict persisted beside it (preflight-runner round-2 F1 leg).
    cached.blueprint.fidelity = failed;
    cached.blueprint.formattedMarkdown = "# big brief";

    const resolved = resolveCachedBlueprint(cached);
    expect(resolved?.structured).toBe(false);
    expect(resolved?.blueprint.fidelity?.status).toBe("failed");
  });

  it("a rehydrated structured brief keeps its OWN verdict over the sidecar", () => {
    const cached = preflightResult({
      contentHash: "hash-1",
      timestamp: "2026-08-10T01:00:00.000Z",
      structured: brief({
        fileAnalyses: [
          {
            filePath: "src/x.ts",
            action: "Modify",
            currentStructure: "n/a",
            integrationPoints: "n/a",
            patternToFollow: "n/a",
          },
        ],
        fidelity: fidelity("ok"),
      }),
    });
    cached.blueprint.fidelity = fidelity("failed"); // stale sidecar must not override
    const resolved = resolveCachedBlueprint(cached);
    expect(resolved?.structured).toBe(true);
    expect(resolved?.blueprint.fidelity?.status).toBe("ok");
  });
});
