// ─── Event Reader ──────────────────────────────────────────────────
// Reads JSONL event files from .quack/logs/ and provides:
//   - getAllSessions(): list of session index entries
//   - getSessionEvents(): full event timeline for one session
//   - watch(): file watcher that emits new events via callback
//
// Uses chokidar for reliable file watching on Windows.

import * as fs from "node:fs";
import * as path from "node:path";

import {
  isClaimantDiagnosticSession,
  type QuackEvent,
  type SessionEntry,
  type CostSummary,
} from "./event-types.js";
import { resolveRunScopedPauseState } from "../dispatcher/paused-run-state.js";
import { buildCostSummaryFromSessions, eventSessionToCostSummarySession } from "./cost-summary.js";

// ─── JSONL parser helper ───────────────────────────────────────────

function parseJsonlFile<T>(filePath: string): T[] {
  if (!fs.existsSync(filePath)) return [];
  try {
    const stat = fs.lstatSync(filePath);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.nlink !== 1) return [];
  } catch {
    return [];
  }

  const content = fs.readFileSync(filePath, "utf-8");
  const results: T[] = [];

  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      results.push(JSON.parse(trimmed) as T);
    } catch {
      // skip malformed lines
    }
  }

  return results;
}

// ─── EventReader ───────────────────────────────────────────────────

export class EventReader {
  readonly logDir: string;
  private readonly sessionsFile: string;

  constructor(logDir: string) {
    this.logDir = logDir;
    this.sessionsFile = path.join(logDir, "sessions.jsonl");
  }

  private runtimeFiles(fileName: string): string[] {
    const files = [path.join(this.logDir, fileName)];
    const dockerRoot = path.join(this.logDir, "docker-import");
    if (!fs.existsSync(dockerRoot)) return files;
    try {
      for (const entry of fs.readdirSync(dockerRoot, { withFileTypes: true })) {
        if (!entry.isDirectory() || entry.isSymbolicLink()) continue;
        const candidate = path.join(dockerRoot, entry.name, fileName);
        try {
          const stat = fs.lstatSync(candidate);
          if (stat.isFile() && !stat.isSymbolicLink() && stat.nlink === 1) files.push(candidate);
        } catch {
          // Missing or unreadable per-dispatch output is ignored.
        }
      }
    } catch {
      // Keep root logging available when a runtime subtree is unreadable.
    }
    return files;
  }

  /**
   * Get all sessions, deduplicated by sessionId.
   * When a session has multiple entries (e.g., "active" then "completed"),
   * the latest entry wins — so completed sessions show cost/duration/outcome.
   */
  getAllSessions(): SessionEntry[] {
    const raw = this.runtimeFiles("sessions.jsonl").flatMap((file) =>
      parseJsonlFile<SessionEntry>(file),
    );
    const map = new Map<string, { entry: SessionEntry; index: number }>();

    for (let i = 0; i < raw.length; i++) {
      const entry = raw[i];
      const existing = map.get(entry.sessionId);
      // Later entries override earlier ones (active → completed)
      if (!existing || entry.status !== "active") {
        map.set(entry.sessionId, {
          entry: existing ? { ...existing.entry, ...entry } : entry,
          index: i,
        });
      }
    }

    // Sort newest first by startTime, then by file order (higher index = newer)
    return Array.from(map.values())
      .sort((a, b) => {
        const timeDiff =
          new Date(b.entry.startTime).getTime() - new Date(a.entry.startTime).getTime();
        return timeDiff !== 0 ? timeDiff : b.index - a.index;
      })
      .map((item) => item.entry);
  }

  /** Session history that is allowed to drive execution state. */
  getExecutionSessions(): SessionEntry[] {
    return this.getAllSessions().filter((session) => !isClaimantDiagnosticSession(session));
  }

  /**
   * Aggregate cost data across all sessions.
   */
  getCostSummary(): CostSummary {
    const sessions = this.getExecutionSessions();
    return buildCostSummaryFromSessions(sessions.map(eventSessionToCostSummarySession));
  }

  getSessionEvents(sessionId: string): QuackEvent[] {
    return this.runtimeFiles(`events-${sessionId}.jsonl`).flatMap((file) =>
      parseJsonlFile<QuackEvent>(file),
    );
  }

  getSessionEventsAfter(sessionId: string, afterTimestamp: string): QuackEvent[] {
    return this.getSessionEvents(sessionId).filter((e) => e.timestamp > afterTimestamp);
  }

  /**
   * Mark stale "active" sessions as "error" by appending a corrective entry.
   * A session is stale if it's been "active" for longer than maxAgeMs (default 2 hours).
   * Returns the number of sessions cleaned up.
   */
  cleanupStaleSessions(maxAgeMs: number = 2 * 60 * 60 * 1000): number {
    const sessions = this.getExecutionSessions();
    const cutoff = Date.now() - maxAgeMs;
    let cleaned = 0;

    for (const session of sessions) {
      if (session.status === "active" && new Date(session.startTime).getTime() < cutoff) {
        this.markSessionError(session);
        cleaned++;
      }
    }

    return cleaned;
  }

  /**
   * Mark ALL "active" sessions as "error". Called on monitor startup when
   * there are no running child processes — any "active" session is orphaned.
   * Returns the number of sessions cleaned up.
   */
  cleanupOrphanedSessions(): number {
    const sessions = this.getExecutionSessions();
    let cleaned = 0;

    for (const session of sessions) {
      if (session.status !== "active") continue;
      // TASK-1329 round-2 R2-1: "no running children" is TRUE for a run paused
      // at a human gate too, because the child exits at the gate by design. This
      // sweep runs at STARTUP - precisely the restart the pause is supposed to
      // survive - and marking it `monitor_crash` here happens BEFORE the
      // pause-aware recovery sweep can protect it, which made that protection
      // largely decorative. A pend belonging to THIS session's run means the run
      // is waiting on a human, not orphaned.
      if (
        session.taskId &&
        session.startTime &&
        resolveRunScopedPauseState(this.logDir, session.taskId, session.startTime)
      ) {
        continue;
      }
      this.markSessionError(session, "monitor_crash");
      cleaned++;
    }

    return cleaned;
  }

  private markSessionError(session: SessionEntry, outcome = "error"): void {
    const entry: SessionEntry = {
      sessionId: session.sessionId,
      taskId: session.taskId,
      project: session.project,
      title: session.title,
      startTime: session.startTime,
      status: "error",
      outcome,
      durationMs: Date.now() - new Date(session.startTime).getTime(),
    };
    try {
      fs.appendFileSync(this.sessionsFile, JSON.stringify(entry) + "\n", "utf-8");
    } catch (err) {
      console.error("[event-reader] markSessionError file write failed (non-fatal):", err);
    }
  }

  getEscalations(): Array<{ session: SessionEntry; events: QuackEvent[] }> {
    const sessions = this.getExecutionSessions();
    const escalations: Array<{ session: SessionEntry; events: QuackEvent[] }> = [];

    for (const session of sessions) {
      if (
        session.status === "error" ||
        session.outcome === "rejected" ||
        session.outcome === "agent_failed"
      ) {
        const events = this.getSessionEvents(session.sessionId);
        escalations.push({ session, events });
      }
    }

    return escalations;
  }

  /**
   * Watch for new events using chokidar.
   * Calls onEvent for each new event line appended to any events-*.jsonl file.
   * Returns a stop function.
   */
  async watch(onEvent: (event: QuackEvent) => void): Promise<() => void> {
    // Dynamic import chokidar (ESM-compatible)
    const chokidar = await import("chokidar");

    const fileSizes = new Map<string, number>();

    const watcher = chokidar.watch(
      [
        path.join(this.logDir, "events-*.jsonl"),
        path.join(this.logDir, "docker-import", "*", "events-*.jsonl"),
      ],
      {
        persistent: true,
        ignoreInitial: true,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 50 },
        usePolling: process.platform === "win32",
        interval: 500,
        ignorePermissionErrors: true,
        followSymlinks: false,
      },
    );

    watcher.on("error", (err: unknown) => {
      console.error("[event-reader] chokidar watcher error (non-fatal):", err);
      if (err instanceof Error) {
        console.error("[event-reader] error details:", {
          message: err.message,
          code: (err as NodeJS.ErrnoException).code,
          path: (err as NodeJS.ErrnoException).path,
        });
      }
    });

    const processNewContent = (filePath: string) => {
      try {
        const identity = fs.lstatSync(filePath);
        if (!identity.isFile() || identity.isSymbolicLink() || identity.nlink !== 1) return;
        const stats = fs.statSync(filePath);
        const previousSize = fileSizes.get(filePath) ?? 0;

        if (stats.size <= previousSize) return;

        // Read only the new bytes
        const fd = fs.openSync(filePath, "r");
        const newBytes = Buffer.alloc(stats.size - previousSize);
        fs.readSync(fd, newBytes, 0, newBytes.length, previousSize);
        fs.closeSync(fd);

        fileSizes.set(filePath, stats.size);

        const newContent = newBytes.toString("utf-8");
        for (const line of newContent.split("\n")) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const event = JSON.parse(trimmed) as QuackEvent;
            onEvent(event);
          } catch {
            // skip malformed lines
          }
        }
      } catch (err) {
        console.error("[event-reader] processNewContent error (non-fatal):", err);
        if (err instanceof Error) {
          console.error("[event-reader] file operation failed:", {
            message: err.message,
            code: (err as NodeJS.ErrnoException).code,
            path: filePath,
          });
        }
      }
    };

    watcher.on("add", (filePath: string) => {
      fileSizes.set(filePath, 0);
      processNewContent(filePath);
    });

    watcher.on("change", (filePath: string) => {
      processNewContent(filePath);
    });

    return () => {
      void watcher.close();
    };
  }
}
