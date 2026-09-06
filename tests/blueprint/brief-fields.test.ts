// ─── TASK-1306: brief fields — parse carry-through, stamping, rendering ─

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import {
  extractBlueprintJson,
  stampBriefProvenance,
  validateBlueprint,
} from "../../src/blueprint/blueprint-agent";
import {
  buildBlueprintPrompt,
  formatBlueprintForPrompt,
} from "../../src/blueprint/blueprint-prompt";
import type { Blueprint } from "../../src/blueprint/blueprint-types";
import type { ParsedTask } from "../../src/core/types";

const LEGACY: Blueprint = {
  taskId: "TASK-600",
  fileAnalyses: [
    {
      filePath: "src/a.ts",
      action: "Modify",
      currentStructure: "exports foo()",
      integrationPoints: "call in bar()",
      patternToFollow: "src/b.ts:10",
    },
  ],
  codeExamples: [{ file: "src/a.ts", description: "wire foo", before: "old", after: "new" }],
  verificationPatterns: [
    {
      criterion: "foo exported",
      checkType: "grep",
      pattern: "export function foo",
      fileGlob: "src/a.ts",
    },
  ],
  antiPatterns: ["No stubs"],
  preconditions: ["tests pass"],
};

describe("validateBlueprint brief-field carry-through (the strip hazard)", () => {
  it("carries brief fields through extraction instead of stripping them", () => {
    const agentJson = JSON.stringify({
      ...LEGACY,
      baseValidation: { observations: ["anchor src/a.ts:99 is stale"] },
      handBack: [
        {
          summary: "dead code in src/old.ts",
          detail: "unused since v2",
          anchors: ["src/old.ts:1"],
        },
      ],
      constraints: ["express 4 only"],
      testsToRebaseline: ["tests/a.test.ts"],
    });

    const parsed = extractBlueprintJson(agentJson);
    expect(parsed).not.toBeNull();
    expect(parsed!.baseValidation?.observations).toEqual(["anchor src/a.ts:99 is stale"]);
    expect(parsed!.handBack).toHaveLength(1);
    expect(parsed!.handBack![0].summary).toContain("dead code");
    expect(parsed!.constraints).toEqual(["express 4 only"]);
    expect(parsed!.testsToRebaseline).toEqual(["tests/a.test.ts"]);
  });

  it("parses a legacy blueprint (no brief fields) with none invented", () => {
    const parsed = validateBlueprint(JSON.parse(JSON.stringify(LEGACY)));
    expect(parsed).not.toBeNull();
    expect(parsed!.briefSchemaVersion).toBeUndefined();
    expect(parsed!.baseValidation).toBeUndefined();
    expect(parsed!.handBack).toBeUndefined();
    expect(parsed!.constraints).toBeUndefined();
    expect(parsed!.testsToRebaseline).toBeUndefined();
  });

  it("drops junk brief entries without failing the parse", () => {
    const parsed = validateBlueprint({
      ...LEGACY,
      baseValidation: "not-an-object",
      handBack: [{ detail: "no summary" }, null, { summary: "kept" }],
      constraints: "not-an-array",
      testsToRebaseline: [1, 2, ""],
    });
    expect(parsed).not.toBeNull();
    expect(parsed!.baseValidation).toBeUndefined();
    expect(parsed!.handBack).toEqual([{ summary: "kept" }]);
    expect(parsed!.constraints).toBeUndefined();
    expect(parsed!.testsToRebaseline).toBeUndefined();
  });
});

describe("stampBriefProvenance (code-stamped, never LLM-trusted)", () => {
  let gitRoot: string;
  let bareDir: string;

  beforeAll(() => {
    // A real throwaway git repo so rev-parse works
    gitRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-brief-git-"));
    const git = (args: string[]): void => {
      execFileSync("git", args, { cwd: gitRoot, stdio: "ignore" });
    };
    git(["init", "-b", "main"]);
    git(["config", "user.email", "t@t"]);
    git(["config", "user.name", "t"]);
    fs.writeFileSync(path.join(gitRoot, "f.txt"), "x");
    git(["add", "."]);
    git(["commit", "-m", "init", "--no-gpg-sign"]);

    bareDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-brief-nogit-"));
  });

  afterAll(() => {
    fs.rmSync(gitRoot, { recursive: true, force: true });
    fs.rmSync(bareDir, { recursive: true, force: true });
  });

  it("overwrites LLM-authored stamps and preserves agent observations", () => {
    const withLies: Blueprint = {
      ...LEGACY,
      generatedAt: "1999-01-01T00:00:00.000Z",
      baseValidation: {
        baseBranch: "fabricated",
        baseSha: "deadbeef",
        validatedAt: "1999-01-01T00:00:00.000Z",
        observations: ["real agent observation"],
      },
    };

    const stamped = stampBriefProvenance(withLies, gitRoot);
    expect(stamped.briefSchemaVersion).toBe(1);
    expect(stamped.generatedAt).not.toBe("1999-01-01T00:00:00.000Z");
    expect(stamped.baseValidation!.baseBranch).toBe("main");
    expect(stamped.baseValidation!.baseSha).toMatch(/^[0-9a-f]{40}$/);
    expect(stamped.baseValidation!.baseSha).not.toBe("deadbeef");
    expect(stamped.baseValidation!.observations).toEqual(["real agent observation"]);
  });

  it("degrades to absent provenance on git failure, keeping observations, never throwing", () => {
    const withObs: Blueprint = {
      ...LEGACY,
      baseValidation: {
        baseBranch: "",
        baseSha: "",
        validatedAt: "",
        observations: ["kept even without git"],
      },
    };
    const stamped = stampBriefProvenance(withObs, bareDir);
    expect(stamped.briefSchemaVersion).toBe(1);
    expect(typeof stamped.generatedAt).toBe("string");
    expect(stamped.baseValidation!.baseSha).toBe("");
    expect(stamped.baseValidation!.observations).toEqual(["kept even without git"]);

    const noObs = stampBriefProvenance({ ...LEGACY }, bareDir);
    expect(noObs.baseValidation).toBeUndefined();
  });
});

describe("prompt contract + formatter rendering", () => {
  const task: ParsedTask = {
    id: "TASK-600",
    title: "t",
    priority: "P2-MEDIUM",
    effort: "1h",
    status: "READY",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: [],
    problemStatement: "p",
    currentState: "c",
    recommendedApproach: "r",
    filesToModify: [{ path: "src/a.ts", action: "Modify", notes: "" }],
    successCriteria: ["foo exported"],
    testingRequirements: [],
    contextReferences: [],
    rawContent: "# TASK-600",
  };

  it("instructs the agent that brief fields are optional and not to pad", () => {
    const prompt = buildBlueprintPrompt(task, "");
    expect(prompt).toContain("baseValidation");
    expect(prompt).toContain("handBack");
    expect(prompt).toContain("testsToRebaseline");
    expect(prompt).toContain("do NOT pad");
    expect(prompt).toContain("stamped by the system");
  });

  it("renders a legacy blueprint byte-identically (no brief sections)", () => {
    const rendered = formatBlueprintForPrompt(LEGACY);
    expect(rendered).not.toContain("Base Validation");
    expect(rendered).not.toContain("Hand-Back");
    expect(rendered).not.toContain("Constraints");
    expect(rendered).not.toContain("Tests to Re-Baseline");
  });

  it("renders brief sections, with hand-back under an explicit out-of-scope preamble", () => {
    const brief: Blueprint = {
      ...LEGACY,
      briefSchemaVersion: 1,
      generatedAt: "2026-07-15T00:00:00.000Z",
      baseValidation: {
        baseBranch: "main",
        baseSha: "abc123def4567890",
        validatedAt: "2026-07-15T00:00:00.000Z",
        observations: ["anchor moved"],
      },
      handBack: [{ summary: "dead code in src/old.ts", anchors: ["src/old.ts:1"] }],
      constraints: ["express 4 only"],
      testsToRebaseline: ["tests/a.test.ts"],
    };

    const rendered = formatBlueprintForPrompt(brief);
    expect(rendered).toContain("### Base Validation");
    expect(rendered).toContain("main@abc123def456");
    expect(rendered).toContain("- anchor moved");
    expect(rendered).toContain("### Constraints");
    expect(rendered).toContain("- express 4 only");
    expect(rendered).toContain("### Tests to Re-Baseline");
    expect(rendered).toContain("OUT OF SCOPE for this task");
    expect(rendered).toContain("Do NOT implement");
    expect(rendered).toContain("dead code in src/old.ts (src/old.ts:1)");
  });

  it("caps hand-back rendering at 8 items with an omission note", () => {
    const brief: Blueprint = {
      ...LEGACY,
      handBack: Array.from({ length: 11 }, (_, i) => ({ summary: `item ${i}` })),
    };
    const rendered = formatBlueprintForPrompt(brief);
    expect(rendered).toContain("item 7");
    expect(rendered).not.toContain("item 8");
    expect(rendered).toContain("8 of 11 hand-back items shown");
  });
});
