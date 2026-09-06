// ─── File Heartbeat ─────────────────────────────────────────────────
// Monitors a work directory for file modifications as a secondary signal
// for stuck agent detection. If the agent writes files via Bash or other
// tools that don't produce JSONL events, the file heartbeat catches it.
//
// Uses chokidar (already a project dependency) to watch for changes.

import chokidar from "chokidar";

export interface FileHeartbeatOptions {
  /** Glob patterns to ignore (added to defaults). */
  ignorePatterns?: string[];
}

const DEFAULT_IGNORE = ["**/node_modules/**", "**/.git/**", "**/dist/**", "**/.quack/**"];

const WATCHED_EXTENSIONS = /\.(ts|js|json|md|tsx|jsx|css|html|yaml|yml|toml|py)$/;

export class FileHeartbeat {
  private watcher: chokidar.FSWatcher | null = null;
  private lastModification: { file: string; timestamp: number } | null = null;
  private readonly workDir: string;
  private readonly ignored: string[];

  constructor(workDir: string, options?: FileHeartbeatOptions) {
    this.workDir = workDir;
    this.ignored = [...DEFAULT_IGNORE, ...(options?.ignorePatterns ?? [])];
  }

  /**
   * Start watching the work directory for file changes.
   */
  start(): void {
    if (this.watcher) return;

    try {
      this.watcher = chokidar.watch(this.workDir, {
        ignored: this.ignored,
        ignoreInitial: true,
        persistent: false,
        depth: 10,
        ignorePermissionErrors: true,
        usePolling: process.platform === "win32",
        interval: 1000,
      });

      const onFileChange = (filePath: string) => {
        if (WATCHED_EXTENSIONS.test(filePath)) {
          this.lastModification = {
            file: filePath,
            timestamp: Date.now(),
          };
        }
      };

      this.watcher.on("add", onFileChange);
      this.watcher.on("change", onFileChange);
      this.watcher.on("error", (err: unknown) => {
        console.error("[file-heartbeat] chokidar error (non-fatal):", err);
      });
    } catch (err) {
      console.error("[file-heartbeat] Failed to start watcher (non-fatal):", err);
    }
  }

  /**
   * Stop watching. Safe to call multiple times.
   */
  stop(): void {
    if (this.watcher) {
      try {
        void this.watcher.close();
      } catch (err) {
        console.error("[file-heartbeat] Error closing watcher (non-fatal):", err);
      }
      this.watcher = null;
    }
  }

  /**
   * Get the last file modification event, or null if none detected.
   */
  getLastModification(): { file: string; timestamp: number } | null {
    return this.lastModification;
  }

  /**
   * Get milliseconds since the last file modification.
   * Returns Infinity if no modifications have been detected.
   */
  getSilentMs(): number {
    if (!this.lastModification) return Infinity;
    return Date.now() - this.lastModification.timestamp;
  }
}
