import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { PrepCache, computeContentHash, ConventionCheckCache } from "../../src/monitor/prep-cache";

// ─── computeContentHash ──────────────────────────────────────────────

describe("computeContentHash", () => {
  it("produces consistent hashes for the same input", () => {
    const hash1 = computeContentHash("# TASK-001\nSome content");
    const hash2 = computeContentHash("# TASK-001\nSome content");
    expect(hash1).toBe(hash2);
  });

  it("produces different hashes for different content", () => {
    const hash1 = computeContentHash("# TASK-001\nContent A");
    const hash2 = computeContentHash("# TASK-001\nContent B");
    expect(hash1).not.toBe(hash2);
  });

  it("includes file hashes in the computation", () => {
    const hashWithout = computeContentHash("# TASK-001");
    const hashWith = computeContentHash("# TASK-001", ["abc123", "def456"]);
    expect(hashWithout).not.toBe(hashWith);
  });

  it("produces different hashes for different file hash arrays", () => {
    const hash1 = computeContentHash("# TASK-001", ["abc123"]);
    const hash2 = computeContentHash("# TASK-001", ["def456"]);
    expect(hash1).not.toBe(hash2);
  });

  it("returns a 64-character hex string (SHA-256)", () => {
    const hash = computeContentHash("test");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ─── PrepCache content-hash features ─────────────────────────────────

describe("PrepCache content-hash", () => {
  let tmpDir: string;
  let cache: PrepCache;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-prep-hash-"));
    cache = new PrepCache(tmpDir);
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const makeResult = (overrides?: Record<string, unknown>) => ({
    taskId: "TASK-001",
    preparedAt: new Date().toISOString(),
    schemaValid: true,
    schemaErrors: [] as string[],
    depthScore: 4.0,
    depthReady: true,
    deficiencies: [] as string[],
    outcome: "pass" as const,
    ...overrides,
  });

  describe("write with contentHash", () => {
    it("persists contentHash to disk", async () => {
      const hash = computeContentHash("task content");
      await cache.write(makeResult({ contentHash: hash }));

      const filePath = path.join(tmpDir, ".quack", "prep", "TASK-001.json");
      const raw = JSON.parse(fs.readFileSync(filePath, "utf-8")) as Record<string, unknown>;
      expect(raw.contentHash).toBe(hash);
    });
  });

  describe("read with contentHash", () => {
    it("returns non-stale when content hash matches", async () => {
      const hash = computeContentHash("task content");
      // Write with an old preparedAt so timestamp would be stale
      const taskFile = path.join(tmpDir, "TASK-001.md");
      fs.writeFileSync(taskFile, "# TASK-001", "utf-8");

      await cache.write(
        makeResult({
          contentHash: hash,
          preparedAt: new Date(Date.now() - 60000).toISOString(),
        }),
      );

      // Modify the task file so it would be stale by timestamp
      await new Promise((resolve) => setTimeout(resolve, 50));
      fs.writeFileSync(taskFile, "# TASK-001 modified", "utf-8");

      // But pass the same hash — should be non-stale
      const result = await cache.read("TASK-001", taskFile, hash);
      expect(result).not.toBeNull();
      expect(result!.stale).toBe(false);
    });

    it("falls back to timestamp staleness when hash does not match", async () => {
      const hash = computeContentHash("original content");
      const differentHash = computeContentHash("different content");

      const taskFile = path.join(tmpDir, "TASK-001.md");
      fs.writeFileSync(taskFile, "# TASK-001", "utf-8");

      await cache.write(
        makeResult({
          contentHash: hash,
          preparedAt: new Date(Date.now() - 60000).toISOString(),
        }),
      );

      await new Promise((resolve) => setTimeout(resolve, 50));
      fs.writeFileSync(taskFile, "# TASK-001 modified", "utf-8");

      // Pass a different hash — should fall back to timestamp check (stale)
      const result = await cache.read("TASK-001", taskFile, differentHash);
      expect(result).not.toBeNull();
      expect(result!.stale).toBe(true);
    });

    it("handles missing contentHash in cached result gracefully", async () => {
      // Write without contentHash
      await cache.write(makeResult());

      const result = await cache.read("TASK-001", undefined, "some-hash");
      expect(result).not.toBeNull();
      // No contentHash in cached result, so it should not match
      expect(result!.stale).toBe(false); // no taskFilePath, default non-stale
    });
  });

  describe("readByHash", () => {
    it("returns cached result when hash matches", async () => {
      const hash = computeContentHash("task spec content");
      await cache.write(makeResult({ contentHash: hash }));

      const result = await cache.readByHash("TASK-001", hash);
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("TASK-001");
      expect(result!.stale).toBe(false);
      expect(result!.contentHash).toBe(hash);
    });

    it("returns null when hash does not match", async () => {
      const hash = computeContentHash("original");
      const differentHash = computeContentHash("different");
      await cache.write(makeResult({ contentHash: hash }));

      const result = await cache.readByHash("TASK-001", differentHash);
      expect(result).toBeNull();
    });

    it("returns null when no cached result exists", async () => {
      const result = await cache.readByHash("TASK-999", "any-hash");
      expect(result).toBeNull();
    });

    it("returns null when cached result has no contentHash", async () => {
      await cache.write(makeResult());

      const result = await cache.readByHash("TASK-001", "any-hash");
      expect(result).toBeNull();
    });
  });

  describe("backward compatibility", () => {
    it("read still works without contentHash parameter", async () => {
      await cache.write(makeResult());

      const result = await cache.read("TASK-001");
      expect(result).not.toBeNull();
      expect(result!.taskId).toBe("TASK-001");
      expect(result!.stale).toBe(false);
    });

    it("PrepResult without contentHash still serializes/deserializes", async () => {
      const result = makeResult();
      await cache.write(result);

      const read = await cache.read("TASK-001");
      expect(read).not.toBeNull();
      expect(read!.contentHash).toBeUndefined();
    });
  });
});

// ─── ConventionCheckCache ────────────────────────────────────────────

describe("ConventionCheckCache", () => {
  let cache: ConventionCheckCache;

  beforeEach(() => {
    cache = new ConventionCheckCache();
  });

  describe("hashFiles", () => {
    it("produces consistent hashes for the same file contents", () => {
      const files = new Map([
        ["src/foo.ts", "export const foo = 1;"],
        ["src/bar.ts", "export const bar = 2;"],
      ]);
      const hash1 = ConventionCheckCache.hashFiles(files);
      const hash2 = ConventionCheckCache.hashFiles(files);
      expect(hash1).toBe(hash2);
    });

    it("produces different hashes for different file contents", () => {
      const files1 = new Map([["src/foo.ts", "version 1"]]);
      const files2 = new Map([["src/foo.ts", "version 2"]]);
      const hash1 = ConventionCheckCache.hashFiles(files1);
      const hash2 = ConventionCheckCache.hashFiles(files2);
      expect(hash1).not.toBe(hash2);
    });

    it("produces different hashes for different file paths", () => {
      const files1 = new Map([["src/foo.ts", "same content"]]);
      const files2 = new Map([["src/bar.ts", "same content"]]);
      const hash1 = ConventionCheckCache.hashFiles(files1);
      const hash2 = ConventionCheckCache.hashFiles(files2);
      expect(hash1).not.toBe(hash2);
    });

    it("is order-independent (sorts by path)", () => {
      const files1 = new Map([
        ["src/b.ts", "b"],
        ["src/a.ts", "a"],
      ]);
      const files2 = new Map([
        ["src/a.ts", "a"],
        ["src/b.ts", "b"],
      ]);
      expect(ConventionCheckCache.hashFiles(files1)).toBe(ConventionCheckCache.hashFiles(files2));
    });
  });

  describe("get and set", () => {
    it("returns null for unknown check name", () => {
      expect(cache.get("unknown-check", "some-hash")).toBeNull();
    });

    it("returns cached results when hash matches", () => {
      const results = [{ name: "lint", passed: true, output: "ok" }];
      cache.set("lint-check", "hash-abc", results);

      const cached = cache.get("lint-check", "hash-abc");
      expect(cached).toEqual(results);
    });

    it("returns null when hash does not match", () => {
      const results = [{ name: "lint", passed: true, output: "ok" }];
      cache.set("lint-check", "hash-abc", results);

      expect(cache.get("lint-check", "hash-different")).toBeNull();
    });

    it("overwrites previous entry for the same check name", () => {
      const results1 = [{ name: "lint", passed: true, output: "ok" }];
      const results2 = [{ name: "lint", passed: false, output: "fail" }];

      cache.set("lint-check", "hash-1", results1);
      cache.set("lint-check", "hash-2", results2);

      expect(cache.get("lint-check", "hash-1")).toBeNull();
      expect(cache.get("lint-check", "hash-2")).toEqual(results2);
    });
  });

  describe("invalidate", () => {
    it("removes a cached entry", () => {
      cache.set("lint-check", "hash-abc", []);
      expect(cache.invalidate("lint-check")).toBe(true);
      expect(cache.get("lint-check", "hash-abc")).toBeNull();
    });

    it("returns false for non-existent entry", () => {
      expect(cache.invalidate("non-existent")).toBe(false);
    });
  });

  describe("clear", () => {
    it("removes all cached entries", () => {
      cache.set("check-1", "hash-1", []);
      cache.set("check-2", "hash-2", []);
      cache.clear();
      expect(cache.size).toBe(0);
    });
  });

  describe("size", () => {
    it("returns the number of cached entries", () => {
      expect(cache.size).toBe(0);
      cache.set("check-1", "hash-1", []);
      expect(cache.size).toBe(1);
      cache.set("check-2", "hash-2", []);
      expect(cache.size).toBe(2);
    });
  });
});
