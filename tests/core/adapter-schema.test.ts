import {
  AdapterGitConfigSchema,
  AdapterConfigSchema,
  BlueprintAutoApproveRulesSchema,
  JudgeAutoApproveRulesSchema,
  LoopConfigSchema,
} from "../../src/core/adapter-schema";
import { JudgmentConfigSchema } from "../../src/judgment/runner/intent-judgment-config";

describe("AdapterGitConfigSchema branchGroups", () => {
  test("accepts valid branchGroups config", () => {
    const parsed = AdapterGitConfigSchema.parse({
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: true,
      autoPush: true,
      branchGroups: {
        "web-app": {
          baseBranch: "feature/web-dashboard-ui",
          autoMergeTarget: "feature/web-dashboard-ui",
          description: "Web app dashboard work",
          taskPattern: "^TASK-(55[9-9]|56\\d|57[0-5])$",
        },
      },
    });

    expect(parsed.branchGroups?.["web-app"]?.baseBranch).toBe("feature/web-dashboard-ui");
    expect(parsed.branchGroups?.["web-app"]?.taskPattern).toBe("^TASK-(55[9-9]|56\\d|57[0-5])$");
  });

  test("rejects branch group missing baseBranch", () => {
    const invalid = {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: true,
      autoPush: true,
      branchGroups: {
        broken: {
          taskPattern: "^TASK-5\\d\\d$",
        },
      },
    };

    const result = AdapterGitConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test("keeps compatibility when branchGroups is absent", () => {
    const parsed = AdapterGitConfigSchema.parse({
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: true,
      autoPush: true,
    });

    expect(parsed.branchGroups).toBeUndefined();
    expect(parsed.baseBranch).toBe("main");
  });
});

describe("LoopConfigSchema", () => {
  test("root adapter defaults executionMode to dispatch", () => {
    const parsed = AdapterConfigSchema.parse({
      version: "1",
      project: {
        name: "test",
        root: ".",
        taskDir: "docs/tasks",
        conventionsDir: ".quack",
      },
      verification: {
        commands: [
          {
            name: "test",
            command: "npm test",
            required: true,
            timeout: 120_000,
          },
        ],
      },
      git: {
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "Implemented-by: Quack Agent",
      },
      logging: { dir: ".quack/logs" },
    });

    expect(parsed.executionMode).toBe("dispatch");
    expect(parsed.loop).toBeUndefined();
  });

  test("mounts strict reviewer configs and shared approval-rule schemas", () => {
    const parsed = LoopConfigSchema.parse({
      briefReview: {
        reviewer: { runner: "codex-cli", codex: { sandbox: "read-only" } },
        autoApproveWhen: { maxFiles: 2 },
      },
      diffReview: {
        reviewer: { runner: "claude-sdk" },
        autoApproveWhen: { maxDiffLines: 100 },
      },
    });

    expect(parsed.briefReview.autoApproveWhen).toEqual(
      BlueprintAutoApproveRulesSchema.parse({ maxFiles: 2 }),
    );
    expect(parsed.diffReview.autoApproveWhen).toEqual(
      JudgeAutoApproveRulesSchema.parse({ maxDiffLines: 100 }),
    );
    expect(parsed.recordOnFinalize).toBe(true);
  });

  test("rejects unknown nested reviewer keys", () => {
    const result = LoopConfigSchema.safeParse({
      briefReview: { reviewer: { unexpected: true } },
      diffReview: { reviewer: {} },
    });
    expect(result.success).toBe(false);
  });

  test("rejects every codex sandbox weaker than read-only", () => {
    const result = LoopConfigSchema.safeParse({
      briefReview: {
        reviewer: { runner: "codex-cli", codex: { sandbox: "danger-full-access" } },
      },
      diffReview: { reviewer: {} },
    });
    expect(result.success).toBe(false);
  });
});

describe("JudgmentConfigSchema", () => {
  test("defaults only the implemented docs-review stage to off", () => {
    expect(JudgmentConfigSchema.parse({})).toEqual({
      runner: {
        provider: "claude-sdk",
        model: "claude-sonnet-4-6",
        maxTurns: 5,
        timeoutMs: 120_000,
      },
      stages: {
        docsReview: { mode: "off" },
        readiness: { mode: "off" },
        loopBrief: { mode: "off" },
        loopDiff: { mode: "off" },
        judge: { mode: "off" },
      },
    });
  });

  test("accepts explicit shadow/enforce without changing executionMode", () => {
    for (const mode of ["shadow", "enforce"] as const) {
      const parsed = JudgmentConfigSchema.parse({
        runner: { model: "claude-opus-4-6" },
        stages: { docsReview: { mode } },
      });
      expect(parsed.stages.docsReview.mode).toBe(mode);
      expect(parsed.runner.model).toBe("claude-opus-4-6");
    }
  });

  test("rejects unknown providers, stages, and nested keys", () => {
    expect(() =>
      JudgmentConfigSchema.parse({
        runner: { provider: "codex-cli" },
      }),
    ).toThrow();
    expect(() =>
      JudgmentConfigSchema.parse({
        stages: { bogusStage: { mode: "enforce" } },
      }),
    ).toThrow();
    expect(
      JudgmentConfigSchema.parse({
        stages: { readiness: { mode: "enforce" } },
      }).stages.readiness.mode,
    ).toBe("enforce");
    // TASK-1316: the three new cutover stages accept modes explicitly.
    for (const stage of ["loopBrief", "loopDiff", "judge"] as const) {
      expect(
        JudgmentConfigSchema.parse({ stages: { [stage]: { mode: "shadow" } } }).stages[stage].mode,
      ).toBe("shadow");
    }
    expect(() =>
      JudgmentConfigSchema.parse({
        stages: { docsReview: { mode: "off", extra: true } },
      }),
    ).toThrow();
  });
});
