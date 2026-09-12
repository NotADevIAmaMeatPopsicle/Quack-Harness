import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { PrepCache } from "../../src/monitor/prep-cache";
import type { PreflightResult } from "../../src/preflight/preflight-types";

describe("PrepCache", () => {
  let tmpDir: string;
  let cache: PrepCache;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-prep-cache-"));
    cache = new PrepCache(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("write and read", () => {
    it("writes and reads prep result", async () => {
      const result = {
        taskId: "TASK-001",
        preparedAt: "2024-01-01T10:00:00.000Z",
        schemaValid: true,
        schemaErrors: [],
        depthScore: 4.5,
        depthReady: true,
        deficiencies: [],
        outcome: "pass" as const,
      };

      await cache.write(result);
      const read = await cache.read("TASK-001");

      expect(read).not.toBeNull();
      expect(read!.taskId).toBe("TASK-001");
      expect(read!.schemaValid).toBe(true);
      expect(read!.depthScore).toBe(4.5);
      expect(read!.outcome).toBe("pass");
      expect(read!.stale).toBe(false);
    });

    it("returns null for non-existent result", async () => {
      const result = await cache.read("TASK-999");
      expect(result).toBeNull();
    });

    it("creates .quack/prep directory if missing", async () => {
      const result = {
        taskId: "TASK-001",
        preparedAt: "2024-01-01T10:00:00.000Z",
        schemaValid: true,
        schemaErrors: [],
        depthScore: 4.0,
        depthReady: true,
        deficiencies: [],
        outcome: "pass" as const,
      };

      await cache.write(result);

      const prepDir = path.join(tmpDir, ".quack", "prep");
      expect(fs.existsSync(prepDir)).toBe(true);
    });

    it("falls back to runtime-prep when .quack/prep is a legacy pointer file", async () => {
      const quackDir = path.join(tmpDir, ".quack");
      fs.mkdirSync(quackDir, { recursive: true });
      fs.writeFileSync(
        path.join(quackDir, "prep"),
        "/root/example-service-dev/.quack/prep\n",
        "utf-8",
      );

      const result = {
        taskId: "TASK-001",
        preparedAt: "2024-01-01T10:00:00.000Z",
        schemaValid: true,
        schemaErrors: [],
        depthScore: 4.0,
        depthReady: true,
        deficiencies: [],
        outcome: "pass" as const,
      };

      await cache.write(result);

      expect(fs.existsSync(path.join(tmpDir, ".quack", "runtime-prep", "TASK-001.json"))).toBe(
        true,
      );
      expect(cache.exists("TASK-001")).toBe(true);
    });
  });

  describe("staleness detection", () => {
    it("marks result as stale when task file is newer", async () => {
      const taskFile = path.join(tmpDir, "TASK-001.md");
      fs.writeFileSync(taskFile, "# TASK-001", "utf-8");

      // Write prep result
      const result = {
        taskId: "TASK-001",
        preparedAt: new Date(Date.now() - 5000).toISOString(), // 5 seconds ago
        schemaValid: true,
        schemaErrors: [],
        depthScore: 4.0,
        depthReady: true,
        deficiencies: [],
        outcome: "pass" as const,
      };
      await cache.write(result);

      // Wait a bit, then modify task file
      await new Promise((resolve) => setTimeout(resolve, 100));
      fs.writeFileSync(taskFile, "# TASK-001 modified", "utf-8");

      // Read with task file path
      const read = await cache.read("TASK-001", taskFile);
      expect(read).not.toBeNull();
      expect(read!.stale).toBe(true);
    });

    it("marks result as fresh when task file is older", async () => {
      const taskFile = path.join(tmpDir, "TASK-001.md");
      fs.writeFileSync(taskFile, "# TASK-001", "utf-8");

      // Wait a bit before writing prep result
      await new Promise((resolve) => setTimeout(resolve, 100));

      const result = {
        taskId: "TASK-001",
        preparedAt: new Date().toISOString(),
        schemaValid: true,
        schemaErrors: [],
        depthScore: 4.0,
        depthReady: true,
        deficiencies: [],
        outcome: "pass" as const,
      };
      await cache.write(result);

      const read = await cache.read("TASK-001", taskFile);
      expect(read).not.toBeNull();
      expect(read!.stale).toBe(false);
    });

    it("returns not stale when no task file path provided", async () => {
      const result = {
        taskId: "TASK-001",
        preparedAt: new Date().toISOString(),
        schemaValid: true,
        schemaErrors: [],
        depthScore: 4.0,
        depthReady: true,
        deficiencies: [],
        outcome: "pass" as const,
      };
      await cache.write(result);

      const read = await cache.read("TASK-001");
      expect(read).not.toBeNull();
      expect(read!.stale).toBe(false);
    });
  });

  describe("invalidate", () => {
    it("deletes cached prep result", async () => {
      const result = {
        taskId: "TASK-001",
        preparedAt: new Date().toISOString(),
        schemaValid: true,
        schemaErrors: [],
        depthScore: 4.0,
        depthReady: true,
        deficiencies: [],
        outcome: "pass" as const,
      };
      await cache.write(result);

      expect(cache.exists("TASK-001")).toBe(true);

      const deleted = await cache.invalidate("TASK-001");
      expect(deleted).toBe(true);
      expect(cache.exists("TASK-001")).toBe(false);
    });

    it("returns false when invalidating non-existent result", async () => {
      const deleted = await cache.invalidate("TASK-999");
      expect(deleted).toBe(false);
    });
  });

  describe("exists", () => {
    it("returns true when prep result exists", async () => {
      const result = {
        taskId: "TASK-001",
        preparedAt: new Date().toISOString(),
        schemaValid: true,
        schemaErrors: [],
        depthScore: 4.0,
        depthReady: true,
        deficiencies: [],
        outcome: "pass" as const,
      };
      await cache.write(result);

      expect(cache.exists("TASK-001")).toBe(true);
    });

    it("returns false when prep result does not exist", () => {
      expect(cache.exists("TASK-999")).toBe(false);
    });
  });

  describe("preflight cache", () => {
    function makePreflightResult(taskId: string, contentHash: string): PreflightResult {
      return {
        taskId,
        timestamp: new Date().toISOString(),
        contentHash,
        gate: { ready: true, score: 5, dimensions: {} },
        blueprint: {
          fileAnalyses: 2,
          codeExamples: 1,
          verificationPatterns: 1,
          antiPatterns: 0,
          formattedMarkdown: "## Blueprint\n\nPreflight blueprint content",
        },
        contextEstimate: {
          taskSpec: 500,
          blueprint: 1000,
          repoMap: 800,
          relevantFiles: 2000,
          relatedPatterns: 300,
          existingTests: 700,
          conventions: 400,
          claudeMd: 300,
          total: 6000,
          withinBudget: true,
        },
        complexity: {
          filesToModify: 3,
          successCriteria: 5,
          estimatedContextTokens: 6000,
          independentFeatures: 2,
          featureClusters: [
            { label: "server.ts", criteriaIndices: [0, 1], files: ["src/server.ts"] },
            { label: "client.ts", criteriaIndices: [2], files: ["src/client.ts"] },
          ],
          recommendDecomposition: false,
          reason: "Within thresholds",
        },
      };
    }

    it("writes and reads preflight result", async () => {
      const result = makePreflightResult("TASK-001", "abc123hash");

      await cache.writePreflight(result);
      const read = await cache.readPreflight("TASK-001");

      expect(read).not.toBeNull();
      expect(read!.taskId).toBe("TASK-001");
      expect(read!.contentHash).toBe("abc123hash");
      expect(read!.blueprint.formattedMarkdown).toContain("Blueprint");
      expect(read!.complexity.recommendDecomposition).toBe(false);
    });

    it("returns null when content hash does not match", async () => {
      const result = makePreflightResult("TASK-001", "original_hash");
      await cache.writePreflight(result);

      const read = await cache.readPreflight("TASK-001", "different_hash");
      expect(read).toBeNull();
    });

    it("returns result when content hash matches", async () => {
      const result = makePreflightResult("TASK-001", "matching_hash");
      await cache.writePreflight(result);

      const read = await cache.readPreflight("TASK-001", "matching_hash");
      expect(read).not.toBeNull();
      expect(read!.taskId).toBe("TASK-001");
    });

    it("TASK-1315: readiness-mode fingerprint invalidates authority reads across a flip", async () => {
      // Legacy cache (no readinessJudgmentMode) = off-era.
      const legacy = makePreflightResult("TASK-001", "hash_a");
      await cache.writePreflight(legacy);
      expect(await cache.readPreflight("TASK-001", "hash_a", "off")).not.toBeNull();
      expect(await cache.readPreflight("TASK-001", "hash_a", "shadow")).toBeNull();
      expect(await cache.readPreflight("TASK-001", "hash_a", "enforce")).toBeNull();
      // Non-authority readers (no expected mode) are unchanged.
      expect(await cache.readPreflight("TASK-001", "hash_a")).not.toBeNull();

      // Mode-stamped cache matches its own mode only.
      const stamped = makePreflightResult("TASK-001", "hash_a");
      stamped.gate = { ...stamped.gate, readinessJudgmentMode: "shadow" };
      await cache.writePreflight(stamped);
      expect(await cache.readPreflight("TASK-001", "hash_a", "shadow")).not.toBeNull();
      expect(await cache.readPreflight("TASK-001", "hash_a", "off")).toBeNull();
      expect(await cache.readPreflight("TASK-001", "hash_a", "enforce")).toBeNull();
    });

    it("returns null for non-existent preflight result", async () => {
      const read = await cache.readPreflight("TASK-999");
      expect(read).toBeNull();
    });

    it("invalidates preflight result", async () => {
      const result = makePreflightResult("TASK-001", "abc123hash");
      await cache.writePreflight(result);

      const deleted = await cache.invalidatePreflight("TASK-001");
      expect(deleted).toBe(true);

      const read = await cache.readPreflight("TASK-001");
      expect(read).toBeNull();
    });

    it("returns false when invalidating non-existent preflight", async () => {
      const deleted = await cache.invalidatePreflight("TASK-999");
      expect(deleted).toBe(false);
    });

    it("stores preflight in separate file from prep result", async () => {
      // Write both prep and preflight
      await cache.write({
        taskId: "TASK-001",
        preparedAt: new Date().toISOString(),
        schemaValid: true,
        schemaErrors: [],
        depthScore: 4.0,
        depthReady: true,
        deficiencies: [],
        outcome: "pass",
      });
      await cache.writePreflight(makePreflightResult("TASK-001", "hash123"));

      // Both should be readable independently
      const prep = await cache.read("TASK-001");
      const preflight = await cache.readPreflight("TASK-001");

      expect(prep).not.toBeNull();
      expect(preflight).not.toBeNull();
      expect(prep!.taskId).toBe("TASK-001");
      expect(preflight!.taskId).toBe("TASK-001");

      // Verify they're stored in different files
      const prepDir = path.join(tmpDir, ".quack", "prep");
      expect(fs.existsSync(path.join(prepDir, "TASK-001.json"))).toBe(true);
      expect(fs.existsSync(path.join(prepDir, "TASK-001-preflight.json"))).toBe(true);
    });
  });
});
