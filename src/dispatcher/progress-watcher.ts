// ─── Progress Watcher ───────────────────────────────────────────────
// Reads and watches PROGRESS.md files in worktrees for agent progress
// tracking. Provides parsed progress reports and file change detection
// for SSE events.

import * as fs from "node:fs";
import * as path from "node:path";
import chokidar from "chokidar";

export interface ProgressReport {
  completed: string[];
  inProgress: string[];
  remaining: string[];
  issues: string[];
  rawContent: string;
  lastUpdated: string;
}

export class ProgressWatcherHandle {
  private watcher: chokidar.FSWatcher;

  constructor(watcher: chokidar.FSWatcher) {
    this.watcher = watcher;
  }

  /** Stop watching the progress file and release resources. */
  async stop(): Promise<void> {
    await this.watcher.close();
  }

  /** Direct access to the underlying chokidar watcher for backward compatibility. */
  close(): Promise<void> {
    return this.watcher.close();
  }
}

export class ProgressWatcher {
  /**
   * Read and parse the progress file from a worktree.
   * Returns null if the file does not exist.
   */
  static readProgress(worktreePath: string): ProgressReport | null {
    const progressPath = path.join(worktreePath, "PROGRESS.md");
    if (!fs.existsSync(progressPath)) return null;

    try {
      const content = fs.readFileSync(progressPath, "utf-8");
      const completed: string[] = [];
      const inProgress: string[] = [];
      const remaining: string[] = [];
      const issues: string[] = [];

      // Parse sections using regex
      const completedMatch = content.match(/## Completed\s+([\s\S]*?)(?=\n## |$)/i);
      if (completedMatch) {
        const lines = completedMatch[1].split("\n").filter((l) => l.trim().startsWith("-"));
        completed.push(...lines.map((l) => l.replace(/^-\s*\[x\]\s*/i, "").trim()));
      }

      const inProgressMatch = content.match(/## In Progress\s+([\s\S]*?)(?=\n## |$)/i);
      if (inProgressMatch) {
        const lines = inProgressMatch[1].split("\n").filter((l) => l.trim().startsWith("-"));
        inProgress.push(...lines.map((l) => l.replace(/^-\s*\[\s*\]\s*/i, "").trim()));
      }

      const remainingMatch = content.match(/## Remaining\s+([\s\S]*?)(?=\n## |$)/i);
      if (remainingMatch) {
        const lines = remainingMatch[1].split("\n").filter((l) => l.trim().startsWith("-"));
        remaining.push(...lines.map((l) => l.replace(/^-\s*\[\s*\]\s*/i, "").trim()));
      }

      const issuesMatch = content.match(/## Issues Encountered\s+([\s\S]*?)(?=\n## |$)/i);
      if (issuesMatch) {
        const lines = issuesMatch[1]
          .split("\n")
          .filter((l) => l.trim().length > 0 && !l.trim().startsWith("#"));
        issues.push(...lines.map((l) => l.trim()));
      }

      return {
        completed,
        inProgress,
        remaining,
        issues,
        rawContent: content,
        lastUpdated: new Date().toISOString(),
      };
    } catch (err) {
      console.error("[progress-watcher] readProgress error (non-fatal):", err);
      return null;
    }
  }

  /**
   * Watch for progress file changes, emit callback when updated.
   * Returns the chokidar watcher instance.
   */
  static watch(
    worktreePath: string,
    onUpdate: (report: ProgressReport) => void,
  ): ProgressWatcherHandle {
    const progressPath = path.join(worktreePath, "PROGRESS.md");
    const watcher = chokidar.watch(progressPath, {
      ignoreInitial: true,
      persistent: false,
      // Use polling for cross-platform reliability (single file, low overhead)
      usePolling: true,
      interval: 2000,
      ignorePermissionErrors: true,
    });

    watcher.on("change", () => {
      try {
        const progress = ProgressWatcher.readProgress(worktreePath);
        if (progress) {
          onUpdate(progress);
        }
      } catch (err) {
        console.error("[progress-watcher] change event error (non-fatal):", err);
      }
    });

    watcher.on("add", () => {
      try {
        const progress = ProgressWatcher.readProgress(worktreePath);
        if (progress) {
          onUpdate(progress);
        }
      } catch (err) {
        console.error("[progress-watcher] add event error (non-fatal):", err);
      }
    });

    watcher.on("error", (err: unknown) => {
      console.error("[progress-watcher] chokidar error (non-fatal):", err);
    });

    return new ProgressWatcherHandle(watcher);
  }
}
