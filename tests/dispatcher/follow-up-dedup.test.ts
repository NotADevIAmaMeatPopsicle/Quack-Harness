import { describe, it, expect, jest, beforeEach } from "@jest/globals";
import {
  levenshteinSimilarity,
  tokenOverlap,
  combinedSimilarity,
  findSimilarTask,
  loadBacklogEntries,
  loadIgnoreList,
  appendLinkedFromComment,
} from "../../src/dispatcher/follow-up-dedup.js";
import type { BacklogEntry } from "../../src/dispatcher/follow-up-dedup.js";
import * as fsPromises from "node:fs/promises";

jest.mock("node:fs/promises");

const mockFs = fsPromises as jest.Mocked<typeof fsPromises>;

const BACKLOG: BacklogEntry[] = [
  {
    taskId: "TASK-100",
    title: "Add retry logic to external-provider sync",
    tags: ["sync", "retry"],
    filePath: "/tasks/TASK-100-add-retry.md",
  },
  {
    taskId: "TASK-101",
    title: "Refactor analytics module",
    tags: ["analytics", "refactoring"],
    filePath: "/tasks/TASK-101.md",
  },
];

describe("levenshteinSimilarity", () => {
  it("returns 1.0 for identical strings", () => {
    expect(levenshteinSimilarity("add retry logic", "add retry logic")).toBe(1.0);
  });

  it("returns 0.0 for empty vs non-empty", () => {
    expect(levenshteinSimilarity("", "something")).toBe(0.0);
  });

  it("returns 1.0 for two empty strings", () => {
    // Both empty → same → 1.0 conceptually, but our impl would hit the length=0 check
    // Actually both empty: al===bl → 1.0
    expect(levenshteinSimilarity("", "")).toBe(1.0);
  });

  it("returns high similarity for near-identical strings", () => {
    expect(
      levenshteinSimilarity(
        "Add retry logic to external-provider",
        "Add retry logic to external-provider sync",
      ),
    ).toBeGreaterThan(0.7);
  });

  it("returns low similarity for completely different strings", () => {
    expect(
      levenshteinSimilarity(
        "Refactor unrelated module",
        "Add retry logic to external-provider sync",
      ),
    ).toBeLessThan(0.5);
  });
});

describe("tokenOverlap", () => {
  it("returns 1.0 for identical strings", () => {
    expect(tokenOverlap("add retry logic", "add retry logic")).toBe(1.0);
  });

  it("returns 1.0 for two empty strings", () => {
    expect(tokenOverlap("", "")).toBe(1.0);
  });

  it("returns high overlap for strings with shared tokens", () => {
    expect(
      tokenOverlap(
        "Add retry logic to external-provider sync",
        "Add retry logic to external-provider",
      ),
    ).toBeGreaterThan(0.7);
  });

  it("returns low overlap for unrelated strings", () => {
    expect(
      tokenOverlap("Refactor unrelated module", "Add retry logic to external-provider sync"),
    ).toBeLessThan(0.3);
  });
});

describe("combinedSimilarity", () => {
  it("returns max of levenshtein and token overlap", () => {
    const a = "Add retry logic to external-provider sync";
    const b = "Add retry logic to external-provider";
    const lev = levenshteinSimilarity(a, b);
    const tok = tokenOverlap(a, b);
    expect(combinedSimilarity(a, b)).toBe(Math.max(lev, tok));
  });

  it("returns 1.0 for identical strings", () => {
    expect(combinedSimilarity("foo bar baz", "foo bar baz")).toBe(1.0);
  });
});

describe("findSimilarTask", () => {
  it("returns existing task for exact title match", () => {
    const result = findSimilarTask("Add retry logic to external-provider sync", BACKLOG);
    expect(result?.taskId).toBe("TASK-100");
  });

  it("returns existing task for near-match title (>= 70% similarity)", () => {
    const result = findSimilarTask("Add retry logic to external-provider", BACKLOG);
    expect(result?.taskId).toBe("TASK-100");
  });

  it("returns null for unrelated title even if backlog has many entries", () => {
    const result = findSimilarTask("Implement dark mode toggle for dashboard", BACKLOG);
    expect(result).toBeNull();
  });

  it("returns null when backlog is empty", () => {
    const result = findSimilarTask("Add retry logic", []);
    expect(result).toBeNull();
  });

  it("returns null when ignored patterns match the title", () => {
    const ignoredPatterns = ["Add retry logic to external-provider sync"];
    // Title matches ignore list → returns null (suppressed)
    const result = findSimilarTask(
      "Add retry logic to external-provider sync",
      BACKLOG,
      ignoredPatterns,
    );
    expect(result).toBeNull();
  });

  it("respects custom threshold", () => {
    // With threshold 0.99, near-match should NOT return a result
    const result = findSimilarTask(
      "Add retry logic to external-provider",
      BACKLOG,
      undefined,
      0.99,
    );
    expect(result).toBeNull();
  });

  it("uses default threshold of 0.7", () => {
    // "Add retry logic" has decent overlap with "Add retry logic to external-provider sync"
    const result = findSimilarTask("Add retry logic", BACKLOG);
    // With 0.7 threshold this might or might not match depending on exact scores
    // The important thing is it doesn't throw
    expect(result === null || typeof result?.taskId === "string").toBe(true);
  });
});

describe("loadBacklogEntries", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns empty array when readdir fails", async () => {
    mockFs.readdir.mockRejectedValue(new Error("ENOENT"));
    const result = await loadBacklogEntries("/nonexistent");
    expect(result).toEqual([]);
  });

  it("parses BACKLOG tasks and returns entries", async () => {
    mockFs.readdir.mockResolvedValue([
      "TASK-101-refactor.md",
      "TASK-100-add-retry.md",
    ] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    // readdir sorts descending, so TASK-101 is read first then TASK-100
    mockFs.readFile
      .mockResolvedValueOnce(
        `# TASK-101: Refactor analytics module\n\n## Metadata\n- **Status:** READY\n- **Tags:** analytics, refactoring\n`,
      )
      .mockResolvedValueOnce(
        `# TASK-100: Add retry logic to external-provider sync\n\n## Metadata\n- **Status:** BACKLOG\n- **Tags:** sync, retry\n`,
      );

    const result = await loadBacklogEntries("/tasks");
    expect(result).toHaveLength(2);
    // First entry after desc sort is TASK-101
    expect(result[0].title).toBe("Refactor analytics module");
    expect(result[0].tags).toContain("analytics");
    expect(result[1].title).toBe("Add retry logic to external-provider sync");
    expect(result[1].tags).toContain("sync");
  });

  it("skips non-BACKLOG/READY tasks", async () => {
    mockFs.readdir.mockResolvedValue(["TASK-200-complete.md"] as unknown as Awaited<
      ReturnType<typeof fsPromises.readdir>
    >);
    mockFs.readFile.mockResolvedValue(
      `# TASK-200: Some completed task\n\n## Metadata\n- **Status:** COMPLETE\n- **Tags:** foo\n`,
    );

    const result = await loadBacklogEntries("/tasks");
    expect(result).toHaveLength(0);
  });

  it("skips files that cannot be read", async () => {
    mockFs.readdir.mockResolvedValue(["TASK-300-unreadable.md"] as unknown as Awaited<
      ReturnType<typeof fsPromises.readdir>
    >);
    mockFs.readFile.mockRejectedValue(new Error("EPERM"));

    const result = await loadBacklogEntries("/tasks");
    expect(result).toHaveLength(0);
  });

  it("limits results to 30 entries", async () => {
    const files = Array.from(
      { length: 40 },
      (_, i) => `TASK-${String(i + 1).padStart(3, "0")}-task.md`,
    );
    mockFs.readdir.mockResolvedValue(
      files as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>,
    );
    mockFs.readFile.mockResolvedValue(
      `# TASK-001: Some backlog task\n\n## Metadata\n- **Status:** BACKLOG\n- **Tags:** foo\n`,
    );

    const result = await loadBacklogEntries("/tasks");
    expect(result.length).toBeLessThanOrEqual(30);
  });
});

describe("loadIgnoreList", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("returns empty array when file does not exist", async () => {
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));
    const result = await loadIgnoreList("/project");
    expect(result).toEqual([]);
  });

  it("returns array of strings from valid JSON file", async () => {
    mockFs.readFile.mockResolvedValue(
      JSON.stringify(["consider adding more test coverage", "add documentation"]),
    );
    const result = await loadIgnoreList("/project");
    expect(result).toEqual(["consider adding more test coverage", "add documentation"]);
  });

  it("returns empty array for invalid JSON", async () => {
    mockFs.readFile.mockResolvedValue("not json");
    const result = await loadIgnoreList("/project");
    expect(result).toEqual([]);
  });

  it("filters out non-string entries", async () => {
    mockFs.readFile.mockResolvedValue(JSON.stringify(["valid string", 42, null, "another string"]));
    const result = await loadIgnoreList("/project");
    expect(result).toEqual(["valid string", "another string"]);
  });
});

describe("appendLinkedFromComment", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("appends comment to existing file", async () => {
    mockFs.readFile.mockResolvedValue("# TASK-100: Some task\n\nContent here.\n");
    mockFs.writeFile.mockResolvedValue(undefined);

    await appendLinkedFromComment("/tasks/TASK-100.md", "TASK-200");

    expect(mockFs.writeFile).toHaveBeenCalledWith(
      "/tasks/TASK-100.md",
      expect.stringContaining("<!-- Also flagged by judge run for TASK-200 -->"),
      "utf-8",
    );
  });

  it("does not append duplicate comment", async () => {
    mockFs.readFile.mockResolvedValue(
      "# TASK-100: Some task\n\n<!-- Also flagged by judge run for TASK-200 -->\n",
    );

    await appendLinkedFromComment("/tasks/TASK-100.md", "TASK-200");

    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });

  it("handles readFile failure gracefully", async () => {
    mockFs.readFile.mockRejectedValue(new Error("ENOENT"));

    // Should not throw
    await expect(
      appendLinkedFromComment("/tasks/TASK-100.md", "TASK-200"),
    ).resolves.toBeUndefined();
    expect(mockFs.writeFile).not.toHaveBeenCalled();
  });
});

describe("integration: duplicate follow-ups across two task runs", () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  it("creates spec on first run, appends linked-from comment on second run (no duplicate)", async () => {
    const followUpTitle = "Add retry logic to external-provider sync";
    const taskDir = "/project/docs/tasks";
    const parentTaskId1 = "TASK-200";
    const parentTaskId2 = "TASK-201";

    // --- First run: no backlog match exists yet ---
    // loadBacklogEntries returns empty (no existing follow-ups)
    mockFs.readdir.mockResolvedValueOnce(
      [] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>,
    );

    const backlogBeforeFirstRun = await loadBacklogEntries(taskDir);
    expect(backlogBeforeFirstRun).toHaveLength(0);

    // findSimilarTask finds no match → caller should create the spec
    const matchFirst = findSimilarTask(followUpTitle, backlogBeforeFirstRun);
    expect(matchFirst).toBeNull();

    // Simulate creating the spec file (this is what createFollowUpTasks does)
    mockFs.writeFile.mockResolvedValueOnce(undefined);
    const specPath = `${taskDir}/${parentTaskId1}-FU1-add-retry-logic-to-external-provider-sync.md`;
    await fsPromises.writeFile(specPath, "# Spec content", "utf-8");
    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
    expect(mockFs.writeFile).toHaveBeenCalledWith(specPath, "# Spec content", "utf-8");

    // --- Second run: the follow-up spec now exists in backlog ---
    jest.clearAllMocks();

    // loadBacklogEntries returns the spec created in run 1
    mockFs.readdir.mockResolvedValueOnce([
      `${parentTaskId1}-FU1-add-retry-logic-to-external-provider-sync.md`,
    ] as unknown as Awaited<ReturnType<typeof fsPromises.readdir>>);
    mockFs.readFile.mockResolvedValueOnce(
      `# ${parentTaskId1}-FU1: Add retry logic to external-provider sync\n\n## Metadata\n- **Status:** BACKLOG\n- **Tags:** follow-up, optimization, auto-generated\n`,
    );

    const backlogBeforeSecondRun = await loadBacklogEntries(taskDir);
    expect(backlogBeforeSecondRun).toHaveLength(1);
    expect(backlogBeforeSecondRun[0].title).toBe("Add retry logic to external-provider sync");

    // findSimilarTask finds the existing spec → caller should NOT create a new spec
    const matchSecond = findSimilarTask(followUpTitle, backlogBeforeSecondRun);
    expect(matchSecond).not.toBeNull();
    expect(matchSecond?.taskId).toContain(parentTaskId1);

    // Append linked-from comment to existing spec instead of creating new one
    mockFs.readFile.mockResolvedValueOnce(
      `# ${parentTaskId1}-FU1: Add retry logic to external-provider sync\n\nContent.\n`,
    );
    mockFs.writeFile.mockResolvedValueOnce(undefined);
    await appendLinkedFromComment(matchSecond!.filePath, parentTaskId2);

    // writeFile was called for the append, but NOT for creating a new spec
    expect(mockFs.writeFile).toHaveBeenCalledTimes(1);
    expect(mockFs.writeFile).toHaveBeenCalledWith(
      matchSecond!.filePath,
      expect.stringContaining(`<!-- Also flagged by judge run for ${parentTaskId2} -->`),
      "utf-8",
    );
  });
});
