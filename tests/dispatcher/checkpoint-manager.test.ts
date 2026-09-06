import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { CheckpointManager } from "../../src/dispatcher/checkpoint-manager";
import type { DispatchCheckpoint, PipelineStage } from "../../src/dispatcher/checkpoint-types";

// ─── Test helpers ────────────────────────────────────────────────────

function makeCheckpoint(
  taskId: string,
  overrides: Partial<DispatchCheckpoint> = {},
): DispatchCheckpoint {
  return {
    taskId,
    sessionId: `quack-${taskId}-123`,
    completedStages: [],
    totalCostUsd: 0,
    retriesUsed: 0,
    updatedAt: new Date().toISOString(),
    startedAt: new Date().toISOString(),
    ...overrides,
  };
}

// ─── Test setup ─────────────────────────────────────────────────────

let tmpDir: string;
let mgr: CheckpointManager;

beforeEach(async () => {
  tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-checkpoint-test-"));
  mgr = new CheckpointManager(tmpDir);
});

afterEach(async () => {
  await fs.rm(tmpDir, { recursive: true, force: true });
});

// ─── Tests ──────────────────────────────────────────────────────────

describe("CheckpointManager", () => {
  describe("save and load", () => {
    test("should save and load a checkpoint", async () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate", "branch"],
        claudeSessionId: "session-abc-123",
        totalCostUsd: 1.5,
      });

      await mgr.save(cp);
      const loaded = await mgr.load("TASK-042");

      expect(loaded).not.toBeNull();
      expect(loaded!.taskId).toBe("TASK-042");
      expect(loaded!.completedStages).toEqual(["gate", "branch"]);
      expect(loaded!.claudeSessionId).toBe("session-abc-123");
      expect(loaded!.totalCostUsd).toBe(1.5);
    });

    test("should return null for non-existent checkpoint", async () => {
      const loaded = await mgr.load("TASK-999");
      expect(loaded).toBeNull();
    });

    test("should overwrite existing checkpoint", async () => {
      await mgr.save(makeCheckpoint("TASK-042", { totalCostUsd: 1.0 }));
      await mgr.save(makeCheckpoint("TASK-042", { totalCostUsd: 2.5 }));

      const loaded = await mgr.load("TASK-042");
      expect(loaded!.totalCostUsd).toBe(2.5);
    });

    test("should create log directory if it does not exist", async () => {
      const deepDir = path.join(tmpDir, "nested", "logs");
      const deepMgr = new CheckpointManager(deepDir);

      await deepMgr.save(makeCheckpoint("TASK-042"));
      const loaded = await deepMgr.load("TASK-042");
      expect(loaded).not.toBeNull();
    });
  });

  describe("delete", () => {
    test("should delete an existing checkpoint", async () => {
      await mgr.save(makeCheckpoint("TASK-042"));
      const deleted = await mgr.delete("TASK-042");

      expect(deleted).toBe(true);
      const loaded = await mgr.load("TASK-042");
      expect(loaded).toBeNull();
    });

    test("should return false for non-existent checkpoint", async () => {
      const deleted = await mgr.delete("TASK-999");
      expect(deleted).toBe(false);
    });
  });

  describe("list", () => {
    test("should list all checkpoints", async () => {
      await mgr.save(makeCheckpoint("TASK-001"));
      await mgr.save(makeCheckpoint("TASK-002"));
      await mgr.save(makeCheckpoint("TASK-003"));

      const checkpoints = await mgr.list();
      expect(checkpoints).toHaveLength(3);

      const taskIds = checkpoints.map((cp) => cp.taskId).sort();
      expect(taskIds).toEqual(["TASK-001", "TASK-002", "TASK-003"]);
    });

    test("should return empty array when no checkpoints exist", async () => {
      const checkpoints = await mgr.list();
      expect(checkpoints).toEqual([]);
    });

    test("should skip corrupted checkpoint files", async () => {
      await mgr.save(makeCheckpoint("TASK-001"));

      // Write a corrupted checkpoint file
      await fs.writeFile(path.join(tmpDir, "checkpoint-TASK-BAD.json"), "not valid json");

      const checkpoints = await mgr.list();
      expect(checkpoints).toHaveLength(1);
      expect(checkpoints[0].taskId).toBe("TASK-001");
    });

    test("should return empty array when directory does not exist", async () => {
      const nonExistentMgr = new CheckpointManager("/tmp/does-not-exist-12345");
      const checkpoints = await nonExistentMgr.list();
      expect(checkpoints).toEqual([]);
    });
  });

  describe("markStageComplete", () => {
    test("should create new checkpoint if none exists", async () => {
      const result = await mgr.markStageComplete("TASK-042", "gate", {
        sessionId: "session-abc",
        startedAt: "2026-01-01T00:00:00Z",
      });

      expect(result.taskId).toBe("TASK-042");
      expect(result.completedStages).toContain("gate");
      expect(result.sessionId).toBe("session-abc");
    });

    test("should add stage to existing checkpoint", async () => {
      await mgr.save(makeCheckpoint("TASK-042", { completedStages: ["gate"] }));

      const result = await mgr.markStageComplete("TASK-042", "branch", {
        branchName: "quack/TASK-042-feature",
      });

      expect(result.completedStages).toContain("gate");
      expect(result.completedStages).toContain("branch");
      expect(result.branchName).toBe("quack/TASK-042-feature");
    });

    test("should not duplicate stages", async () => {
      await mgr.save(makeCheckpoint("TASK-042", { completedStages: ["gate"] }));

      const result = await mgr.markStageComplete("TASK-042", "gate", {});
      expect(result.completedStages.filter((s) => s === "gate")).toHaveLength(1);
    });

    test("should merge updates into existing checkpoint", async () => {
      await mgr.save(
        makeCheckpoint("TASK-042", {
          completedStages: ["gate", "branch", "context"],
          totalCostUsd: 0,
        }),
      );

      const result = await mgr.markStageComplete("TASK-042", "agent", {
        claudeSessionId: "session-xyz",
        totalCostUsd: 2.5,
      });

      expect(result.completedStages).toContain("agent");
      expect(result.claudeSessionId).toBe("session-xyz");
      expect(result.totalCostUsd).toBe(2.5);
    });
  });

  describe("getResumeStage", () => {
    test("should return first incomplete stage", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate", "blueprint", "approve", "branch", "context"],
      });
      expect(mgr.getResumeStage(cp)).toBe("agent");
    });

    test("should return gate when nothing is completed", () => {
      const cp = makeCheckpoint("TASK-042", { completedStages: [] });
      expect(mgr.getResumeStage(cp)).toBe("gate");
    });

    test("should return pr when all stages complete", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: [
          "gate",
          "blueprint",
          "approve",
          "branch",
          "context",
          "agent",
          "commit",
          "judge_review",
          "judge",
          "pr",
        ] as PipelineStage[],
      });
      expect(mgr.getResumeStage(cp)).toBe("pr");
    });

    test("should skip to judge_review when agent is complete", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate", "blueprint", "approve", "branch", "context", "agent", "commit"],
      });
      expect(mgr.getResumeStage(cp)).toBe("judge_review");
    });

    test("should return blueprint when gate is complete but blueprint is not", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate"],
      });
      expect(mgr.getResumeStage(cp)).toBe("blueprint");
    });

    test("should return approve when blueprint is complete but approve is not", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate", "blueprint"],
      });
      expect(mgr.getResumeStage(cp)).toBe("approve");
    });

    test("should return branch when approve is complete", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate", "blueprint", "approve"],
      });
      expect(mgr.getResumeStage(cp)).toBe("branch");
    });
  });

  describe("rewindFrom", () => {
    test("rewinds agent and later stages while preserving branch and worker session", async () => {
      await mgr.save(
        makeCheckpoint("TASK-1307", {
          completedStages: [
            "gate",
            "blueprint",
            "approve",
            "branch",
            "agent",
            "commit",
            "judge_review",
            "judge",
          ],
          branchName: "codex/TASK-1307-loop-wiring",
          claudeSessionId: "worker-session",
          agentResult: {
            taskId: "TASK-1307",
            outcome: "success",
            filesModified: ["src/core/types.ts"],
            filesCreated: [],
            verification: null,
            turnsUsed: 10,
            totalCostUsd: 2,
            messages: [],
            claudeSessionId: "worker-session",
          },
          gitDiff: "diff --git a/a b/a",
          retriesUsed: 3,
          totalCostUsd: 4.5,
          outputSnapshots: [],
        }),
      );

      const rewound = await mgr.rewindFrom("TASK-1307", "agent");

      expect(rewound?.completedStages).toEqual(["gate", "blueprint", "approve", "branch"]);
      expect(rewound?.completedStages).not.toContain("context");
      expect(rewound).toMatchObject({
        branchName: "codex/TASK-1307-loop-wiring",
        claudeSessionId: "worker-session",
        retriesUsed: 0,
        totalCostUsd: 0,
      });
      expect(rewound?.agentResult).toBeUndefined();
      expect(rewound?.judgeResult).toBeUndefined();
      expect(rewound?.gitDiff).toBeUndefined();
      expect(rewound?.outputSnapshots).toBeUndefined();
      expect(mgr.isUsable(rewound!, 3)).toBe(true);
      expect(mgr.getResumeStage(rewound!)).toBe("context");
    });

    test("returns null without a checkpoint", async () => {
      await expect(mgr.rewindFrom("TASK-404", "agent")).resolves.toBeNull();
    });

    test("rewinds only the review and judge for a retry-side pending diff", async () => {
      const latestAgentResult = {
        taskId: "TASK-1307",
        outcome: "success" as const,
        filesModified: ["src/dispatcher/dispatcher.ts"],
        filesCreated: [],
        verification: null,
        turnsUsed: 4,
        totalCostUsd: 1.25,
        messages: [],
        claudeSessionId: "worker-session-retry",
      };
      await mgr.save(
        makeCheckpoint("TASK-1307", {
          completedStages: [
            "gate",
            "blueprint",
            "approve",
            "branch",
            "agent",
            "commit",
            "judge_review",
            "judge",
          ],
          branchName: "codex/TASK-1307-loop-wiring",
          claudeSessionId: "worker-session-retry",
          agentResult: latestAgentResult,
          gitDiff: "diff --git a/new.ts b/new.ts",
          retriesUsed: 1,
          totalCostUsd: 3.5,
          outputSnapshots: [],
          judgeResult: {
            verdict: "REVISE",
            confidence: 0.8,
            scopeViolations: [],
            criteriaGaps: [],
            qualityIssues: [],
            feedback: "Fix the retry diff",
          },
        }),
      );

      const rewound = await mgr.rewindFrom("TASK-1307", "judge_review");

      expect(rewound?.completedStages).toEqual([
        "gate",
        "blueprint",
        "approve",
        "branch",
        "agent",
        "commit",
      ]);
      expect(rewound).toMatchObject({
        agentResult: latestAgentResult,
        gitDiff: "diff --git a/new.ts b/new.ts",
        retriesUsed: 1,
        totalCostUsd: 3.5,
      });
      expect(rewound?.judgeResult).toBeUndefined();
      expect(mgr.getResumeStage(rewound!)).toBe("context");
    });
  });

  describe("isUsable", () => {
    test("should return true for valid checkpoint with incomplete stages", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate", "blueprint", "branch"],
      });
      expect(mgr.isUsable(cp)).toBe(true);
    });

    test("should return true for checkpoint with REVISE verdict and gitDiff", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate", "blueprint", "branch", "agent", "judge"],
        judgeResult: {
          verdict: "REVISE",
          confidence: 0.7,
          scopeViolations: [],
          criteriaGaps: ["missing tests"],
          qualityIssues: [],
          feedback: "Add tests",
        },
        gitDiff: "diff --git a/src/foo.ts b/src/foo.ts\n+some work",
      });
      expect(mgr.isUsable(cp)).toBe(true);
    });

    test("should return false for corrupted checkpoint (missing taskId)", () => {
      const cp = makeCheckpoint("TASK-042");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (cp as any).taskId = "";
      expect(mgr.isUsable(cp)).toBe(false);
    });

    test("should return false for corrupted checkpoint (missing sessionId)", () => {
      const cp = makeCheckpoint("TASK-042");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (cp as any).sessionId = "";
      expect(mgr.isUsable(cp)).toBe(false);
    });

    test("should return false for corrupted checkpoint (missing completedStages)", () => {
      const cp = makeCheckpoint("TASK-042");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any, @typescript-eslint/no-unsafe-member-access
      (cp as any).completedStages = null;
      expect(mgr.isUsable(cp)).toBe(false);
    });

    test("should return false for stale checkpoint (older than 7 days)", () => {
      const staleDate = new Date(Date.now() - 8 * 24 * 60 * 60 * 1000).toISOString();
      const cp = makeCheckpoint("TASK-042", {
        updatedAt: staleDate,
      });
      expect(mgr.isUsable(cp)).toBe(false);
    });

    test("should return true for recent checkpoint (within 7 days)", () => {
      const recentDate = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000).toISOString();
      const cp = makeCheckpoint("TASK-042", {
        updatedAt: recentDate,
        completedStages: ["gate", "branch"],
      });
      expect(mgr.isUsable(cp)).toBe(true);
    });

    test("should return false for REJECT verdict", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate", "blueprint", "branch", "agent", "judge"],
        judgeResult: {
          verdict: "REJECT",
          confidence: 0.9,
          scopeViolations: ["wrong approach"],
          criteriaGaps: [],
          qualityIssues: [],
          feedback: "Fundamentally wrong approach",
        },
      });
      expect(mgr.isUsable(cp)).toBe(false);
    });

    test("should return false for REVISE verdict with no gitDiff (no work done)", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate", "blueprint", "branch", "agent", "judge"],
        judgeResult: {
          verdict: "REVISE",
          confidence: 0.6,
          scopeViolations: [],
          criteriaGaps: ["everything"],
          qualityIssues: [],
          feedback: "No real changes",
        },
      });
      expect(mgr.isUsable(cp)).toBe(false);
    });

    test("should return false when retries exhausted with no gitDiff (maxRetries provided)", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate", "blueprint", "branch", "agent", "judge"],
        retriesUsed: 3,
        judgeResult: {
          verdict: "REVISE",
          confidence: 0.5,
          scopeViolations: [],
          criteriaGaps: ["tests"],
          qualityIssues: [],
          feedback: "Still missing tests",
        },
      });
      // maxRetries = 3, retriesUsed = 3, no gitDiff → unusable
      expect(mgr.isUsable(cp, 3)).toBe(false);
    });

    test("should return true when retries exhausted but gitDiff exists (has salvageable work)", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate", "blueprint", "branch", "agent", "judge"],
        retriesUsed: 3,
        judgeResult: {
          verdict: "REVISE",
          confidence: 0.5,
          scopeViolations: [],
          criteriaGaps: ["tests"],
          qualityIssues: [],
          feedback: "Still missing tests",
        },
        gitDiff: "diff --git a/src/foo.ts b/src/foo.ts\n+substantial work here",
      });
      // maxRetries = 3, retriesUsed = 3, but has gitDiff → usable (salvageable)
      expect(mgr.isUsable(cp, 3)).toBe(true);
    });

    test("should return true when retries not yet exhausted (maxRetries provided)", () => {
      const cp = makeCheckpoint("TASK-042", {
        completedStages: ["gate", "blueprint", "branch", "agent", "judge"],
        retriesUsed: 1,
        judgeResult: {
          verdict: "REVISE",
          confidence: 0.7,
          scopeViolations: [],
          criteriaGaps: ["tests"],
          qualityIssues: [],
          feedback: "Add more tests",
        },
        gitDiff: "some diff",
      });
      // maxRetries = 3, retriesUsed = 1 → still has retries left → usable
      expect(mgr.isUsable(cp, 3)).toBe(true);
    });
  });

  describe("checkpoint persistence format", () => {
    test("should store checkpoint as JSON with indentation", async () => {
      await mgr.save(makeCheckpoint("TASK-042"));

      const filePath = path.join(tmpDir, "checkpoint-TASK-042.json");
      const content = await fs.readFile(filePath, "utf-8");
      const parsed = JSON.parse(content) as { taskId: string; updatedAt: string };

      expect(parsed.taskId).toBe("TASK-042");
      // Should have updatedAt from save
      expect(parsed.updatedAt).toBeDefined();
    });

    test("should preserve agentResult in checkpoint", async () => {
      await mgr.save(
        makeCheckpoint("TASK-042", {
          agentResult: {
            taskId: "TASK-042",
            outcome: "success",
            filesModified: ["src/foo.ts"],
            filesCreated: [],
            verification: null,
            turnsUsed: 10,
            totalCostUsd: 1.5,
            messages: [],
            claudeSessionId: "session-123",
          },
        }),
      );

      const loaded = await mgr.load("TASK-042");
      expect(loaded!.agentResult).toBeDefined();
      expect(loaded!.agentResult!.claudeSessionId).toBe("session-123");
      expect(loaded!.agentResult!.filesModified).toEqual(["src/foo.ts"]);
    });
  });
});
