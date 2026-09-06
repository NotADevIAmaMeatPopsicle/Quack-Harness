// ─── Progress Watcher Tests ────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { ProgressWatcher } from "../../src/dispatcher/progress-watcher.js";

describe("ProgressWatcher", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-progress-test-"));
  });

  afterEach(async () => {
    // Wait a bit for any watchers to fully close
    await new Promise((resolve) => setTimeout(resolve, 100));
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("readProgress", () => {
    it("should return null if PROGRESS.md does not exist", () => {
      const result = ProgressWatcher.readProgress(tmpDir);
      expect(result).toBeNull();
    });

    it("should parse a well-formatted PROGRESS.md file", () => {
      const content = `## Completed
- [x] Created src/analytics/types.ts with RunAnalysis interface
- [x] Implemented post-run-analyzer.ts

## In Progress
- [ ] Wiring analytics updater into dispatcher

## Remaining
- [ ] Gate advisor implementation
- [ ] Dashboard analytics panel

## Issues Encountered
- EventReader.getAllSessions() returns stale data
  Workaround: filter by sessionId

## Cost So Far
- ~$2.30 after 15 turns
`;

      fs.writeFileSync(path.join(tmpDir, "PROGRESS.md"), content);
      const result = ProgressWatcher.readProgress(tmpDir);

      expect(result).not.toBeNull();
      expect(result?.completed).toHaveLength(2);
      expect(result?.completed[0]).toBe(
        "Created src/analytics/types.ts with RunAnalysis interface",
      );
      expect(result?.completed[1]).toBe("Implemented post-run-analyzer.ts");

      expect(result?.inProgress).toHaveLength(1);
      expect(result?.inProgress[0]).toBe("Wiring analytics updater into dispatcher");

      expect(result?.remaining).toHaveLength(2);
      expect(result?.remaining[0]).toBe("Gate advisor implementation");
      expect(result?.remaining[1]).toBe("Dashboard analytics panel");

      expect(result?.issues.length).toBeGreaterThan(0);
      expect(result?.rawContent).toBe(content);
    });

    it("should handle missing sections gracefully", () => {
      const content = `## Completed
- [x] Did something

## Remaining
- [ ] Do something else
`;

      fs.writeFileSync(path.join(tmpDir, "PROGRESS.md"), content);
      const result = ProgressWatcher.readProgress(tmpDir);

      expect(result).not.toBeNull();
      expect(result?.completed).toHaveLength(1);
      expect(result?.inProgress).toHaveLength(0);
      expect(result?.remaining).toHaveLength(1);
      expect(result?.issues).toHaveLength(0);
    });

    it("should handle an empty PROGRESS.md file", () => {
      fs.writeFileSync(path.join(tmpDir, "PROGRESS.md"), "");
      const result = ProgressWatcher.readProgress(tmpDir);

      expect(result).not.toBeNull();
      expect(result?.completed).toHaveLength(0);
      expect(result?.inProgress).toHaveLength(0);
      expect(result?.remaining).toHaveLength(0);
      expect(result?.issues).toHaveLength(0);
      expect(result?.rawContent).toBe("");
    });

    it("should parse items with different checkbox formats", () => {
      const content = `## Completed
- [X] Uppercase X
- [x] lowercase x

## In Progress
- [] No space checkbox
- [ ] Space checkbox
`;

      fs.writeFileSync(path.join(tmpDir, "PROGRESS.md"), content);
      const result = ProgressWatcher.readProgress(tmpDir);

      expect(result).not.toBeNull();
      expect(result?.completed).toHaveLength(2);
      expect(result?.inProgress).toHaveLength(2);
    });

    it("should parse multi-line issues section", () => {
      const content = `## Issues Encountered
- First issue line
  Additional context
- Second issue
`;

      fs.writeFileSync(path.join(tmpDir, "PROGRESS.md"), content);
      const result = ProgressWatcher.readProgress(tmpDir);

      expect(result).not.toBeNull();
      expect(result?.issues.length).toBeGreaterThan(0);
    });

    it("should include a valid ISO lastUpdated timestamp", () => {
      fs.writeFileSync(path.join(tmpDir, "PROGRESS.md"), "## Completed\n- [x] Item");
      const result = ProgressWatcher.readProgress(tmpDir);

      expect(result).not.toBeNull();
      expect(result?.lastUpdated).toBeDefined();
      // Verify it's a valid ISO date string
      const parsed = new Date(result!.lastUpdated);
      expect(parsed.getTime()).not.toBeNaN();
    });
  });

  describe("resume context injection", () => {
    it("should format progress for taskSpec injection on checkpoint resume", () => {
      const content = `## Completed
- [x] Implemented feature A
- [x] Added tests for feature A

## In Progress
- [ ] Wiring into server.ts

## Remaining
- [ ] Dashboard integration

## Issues Encountered
- Import path was wrong, fixed by using relative import
`;
      fs.writeFileSync(path.join(tmpDir, "PROGRESS.md"), content);
      const progress = ProgressWatcher.readProgress(tmpDir);

      expect(progress).not.toBeNull();

      // Simulate the dispatcher's resume injection pattern (dispatcher.ts Step 4b)
      let taskSpec = "# TASK-099: Original task spec";
      if (progress) {
        taskSpec += `\n\n---\n\n## Previous Session Progress\n\n${progress.rawContent}`;
      }

      expect(taskSpec).toContain("## Previous Session Progress");
      expect(taskSpec).toContain("Implemented feature A");
      expect(taskSpec).toContain("Wiring into server.ts");
      expect(taskSpec).toContain("Dashboard integration");
      expect(taskSpec).toContain("Import path was wrong");
      // Original spec should still be present
      expect(taskSpec).toContain("# TASK-099: Original task spec");
    });

    it("should not inject progress when PROGRESS.md does not exist", () => {
      const progress = ProgressWatcher.readProgress(tmpDir);
      expect(progress).toBeNull();

      // Simulate the dispatcher's guard: only inject if progress exists
      let taskSpec = "# TASK-099: Original task spec";
      if (progress) {
        taskSpec += `\n\n---\n\n## Previous Session Progress\n\n${progress.rawContent}`;
      }

      // taskSpec should remain unchanged
      expect(taskSpec).toBe("# TASK-099: Original task spec");
      expect(taskSpec).not.toContain("Previous Session Progress");
    });
  });

  describe("watch", () => {
    it("should trigger callback when PROGRESS.md is created", (done) => {
      const watcher = ProgressWatcher.watch(tmpDir, (progress) => {
        expect(progress.completed).toHaveLength(1);
        void watcher.close();
        done();
      });

      // Write after a short delay to ensure watcher is ready
      setTimeout(() => {
        fs.writeFileSync(path.join(tmpDir, "PROGRESS.md"), "## Completed\n- [x] Test item");
      }, 100);
    }, 10000);

    it("should trigger callback when PROGRESS.md is modified", (done) => {
      // Create initial file before starting the watcher
      const progressPath = path.join(tmpDir, "PROGRESS.md");
      fs.writeFileSync(progressPath, "## Completed\n- [x] Initial");

      // Give the OS a moment to release file handles before starting watcher
      setTimeout(() => {
        const watcher = ProgressWatcher.watch(tmpDir, (progress) => {
          // Any callback means the file change was detected
          expect(progress.completed.length).toBeGreaterThanOrEqual(1);
          void watcher.close();
          setTimeout(done, 100);
        });

        // Wait for watcher to fully initialize, then modify
        setTimeout(() => {
          fs.writeFileSync(progressPath, "## Completed\n- [x] Initial\n- [x] Updated");
        }, 500);
      }, 200);
    }, 10000);
  });
});
