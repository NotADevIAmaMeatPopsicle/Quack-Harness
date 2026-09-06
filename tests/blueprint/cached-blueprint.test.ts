// ─── TASK-1306: cached blueprint rehydration matrix ─────────────────

import { resolveCachedBlueprint } from "../../src/blueprint/cached-blueprint";
import type { Blueprint } from "../../src/blueprint/blueprint-types";
import type { PreflightResult } from "../../src/preflight/preflight-types";

const STRUCTURED: Blueprint = {
  taskId: "TASK-500",
  fileAnalyses: [
    {
      filePath: "src/a.ts",
      action: "Modify",
      currentStructure: "exports foo()",
      integrationPoints: "call site in bar()",
      patternToFollow: "src/b.ts:10",
    },
    {
      filePath: "src/b.ts",
      action: "Modify",
      currentStructure: "exports bar()",
      integrationPoints: "wired from a",
      patternToFollow: "src/a.ts:5",
    },
  ],
  codeExamples: [],
  verificationPatterns: [
    {
      criterion: "foo is exported",
      checkType: "grep",
      pattern: "export function foo",
      fileGlob: "src/a.ts",
    },
  ],
  antiPatterns: ["Do not stub"],
  preconditions: [],
  briefSchemaVersion: 1,
  generatedAt: "2026-07-15T00:00:00.000Z",
  baseValidation: {
    baseBranch: "main",
    baseSha: "abc123def456",
    validatedAt: "2026-07-15T00:00:00.000Z",
    observations: ["spec anchor src/a.ts:99 is stale (function moved to :120)"],
  },
};

function preflight(overrides: {
  structured?: unknown;
  formattedMarkdown?: string;
}): PreflightResult {
  return {
    taskId: "TASK-500",
    timestamp: "2026-07-15T00:00:00.000Z",
    contentHash: "hash",
    gate: { ready: true, score: 5, dimensions: {} },
    blueprint: {
      fileAnalyses: 2,
      codeExamples: 0,
      verificationPatterns: 1,
      antiPatterns: 1,
      formattedMarkdown: overrides.formattedMarkdown ?? "## Implementation Blueprint\n\ncontent",
      ...(overrides.structured !== undefined
        ? { structured: overrides.structured as Blueprint }
        : {}),
    },
    contextEstimate: {
      taskSpec: 1,
      blueprint: 1,
      repoMap: 0,
      relevantFiles: 0,
      relatedPatterns: 0,
      existingTests: 0,
      conventions: 0,
      claudeMd: 0,
      total: 2,
      withinBudget: true,
    },
    complexity: {
      filesToModify: 2,
      successCriteria: 1,
      estimatedContextTokens: 2,
      independentFeatures: 1,
      featureClusters: [],
      recommendDecomposition: false,
      reason: "",
    },
  };
}

describe("resolveCachedBlueprint", () => {
  it("returns null when there is no cache or no markdown (caller generates fresh)", () => {
    expect(resolveCachedBlueprint(null)).toBeNull();
    expect(resolveCachedBlueprint(undefined)).toBeNull();
    expect(resolveCachedBlueprint(preflight({ formattedMarkdown: "" }))).toBeNull();
  });

  it("rehydrates a well-formed structured object with real content", () => {
    const resolved = resolveCachedBlueprint(preflight({ structured: STRUCTURED }));
    expect(resolved).not.toBeNull();
    expect(resolved!.structured).toBe(true);
    expect(resolved!.blueprint.fileAnalyses).toHaveLength(2);
    expect(resolved!.blueprint.verificationPatterns).toHaveLength(1);
    expect(resolved!.blueprint.baseValidation?.baseSha).toBe("abc123def456");
    expect(resolved!.blueprint.briefSchemaVersion).toBe(1);
    expect(resolved!.blueprintMarkdown).toContain("Implementation Blueprint");
  });

  it("preserves persisted provenance stamps on the cache round-trip", () => {
    const resolved = resolveCachedBlueprint(preflight({ structured: STRUCTURED }));
    expect(resolved!.blueprint.baseValidation).toEqual(STRUCTURED.baseValidation);
    expect(resolved!.blueprint.generatedAt).toBe("2026-07-15T00:00:00.000Z");
  });

  it("falls back to the legacy stub when structured is absent (old cache)", () => {
    const resolved = resolveCachedBlueprint(preflight({}));
    expect(resolved).not.toBeNull();
    expect(resolved!.structured).toBe(false);
    expect(resolved!.blueprint.fileAnalyses).toHaveLength(0);
    expect(resolved!.blueprint.verificationPatterns).toHaveLength(0);
    expect(resolved!.blueprint.taskId).toBe("TASK-500");
  });

  it("falls back to the legacy stub when structured is partial/malformed — never a half-object", () => {
    // missing fileAnalyses array → validateBlueprint rejects
    const partial = { taskId: "TASK-500", codeExamples: [] };
    const resolved = resolveCachedBlueprint(preflight({ structured: partial }));
    expect(resolved).not.toBeNull();
    expect(resolved!.structured).toBe(false);
    expect(resolved!.blueprint.fileAnalyses).toHaveLength(0);

    const garbage = resolveCachedBlueprint(preflight({ structured: "not-an-object" }));
    expect(garbage!.structured).toBe(false);
  });

  it("normalizes junk inside an otherwise-valid structured object (single normalizer)", () => {
    const withJunk = {
      ...STRUCTURED,
      handBack: [
        { summary: "real item", anchors: ["src/x.ts:1"] },
        { summary: "   " },
        "not-an-object",
      ],
      constraints: ["keep express 4", 42, ""],
    };
    const resolved = resolveCachedBlueprint(preflight({ structured: withJunk }));
    expect(resolved!.structured).toBe(true);
    expect(resolved!.blueprint.handBack).toEqual([
      { summary: "real item", anchors: ["src/x.ts:1"] },
    ]);
    expect(resolved!.blueprint.constraints).toEqual(["keep express 4"]);
  });
});
