// ─── Event Emitter ─────────────────────────────────────────────────
// Writes QuackEvent records to JSONL files in .quack/logs/.
// Two files per run:
//   sessions.jsonl        — one line per session (index)
//   events-{sessionId}.jsonl — full event timeline
//
// The emitter is append-only and crash-safe. Each write is a single
// appendFileSync call followed by a newline.

import * as fs from "node:fs";
import * as path from "node:path";

import type { QuackEvent, EventStage, EventPayload, SessionEntry } from "./event-types.js";

// ─── IEventWriter interface ────────────────────────────────────────

export interface IEventWriter {
  readonly sessionId: string;
  readonly taskId: string;
  readonly project: string;
  title?: string;
  emit(stage: EventStage, payload: EventPayload): void;
  recordSession(
    status: SessionEntry["status"],
    extra?: Partial<
      Pick<SessionEntry, "outcome" | "totalCostUsd" | "durationMs" | "turnsUsed" | "title">
    >,
  ): void;
}

/**
 * Resolve a log directory inside a linked git worktree back to the matching
 * path in the primary checkout. The mutable-worker guard can temporarily move
 * the worktree's entire ignored `.quack` tree, so even an ordinary directory
 * at `.quack/logs` is not a durable event destination. Git's `commondir`
 * pointer gives us the primary checkout without requiring another process.
 */
export function resolveDurableEventLogDir(logDir: string): string {
  const absoluteLogDir = path.resolve(logDir);
  let candidateRoot = absoluteLogDir;
  let reachedFilesystemRoot = false;

  while (!reachedFilesystemRoot) {
    const gitMarker = path.join(candidateRoot, ".git");
    try {
      if (fs.statSync(gitMarker).isFile()) {
        const pointer = fs.readFileSync(gitMarker, "utf-8").trim();
        const match = /^gitdir:\s*(.+)$/i.exec(pointer);
        if (!match) return absoluteLogDir;

        const worktreeGitDir = path.resolve(candidateRoot, match[1]);
        const commonDirFile = path.join(worktreeGitDir, "commondir");
        const commonGitDir = fs.existsSync(commonDirFile)
          ? path.resolve(worktreeGitDir, fs.readFileSync(commonDirFile, "utf-8").trim())
          : path.resolve(worktreeGitDir, "..", "..");
        const primaryRoot = path.dirname(commonGitDir);
        const relativeLogDir = path.relative(candidateRoot, absoluteLogDir);
        if (!relativeLogDir.startsWith("..") && !path.isAbsolute(relativeLogDir)) {
          return path.resolve(primaryRoot, relativeLogDir);
        }
        return absoluteLogDir;
      }
      if (fs.statSync(gitMarker).isDirectory()) return absoluteLogDir;
    } catch {
      // Keep walking toward the filesystem root until a git marker is found.
    }

    const parent = path.dirname(candidateRoot);
    reachedFilesystemRoot = parent === candidateRoot;
    candidateRoot = parent;
  }

  return absoluteLogDir;
}

// ─── EventWriter ───────────────────────────────────────────────────

export class EventWriter implements IEventWriter {
  readonly sessionId: string;
  readonly taskId: string;
  readonly project: string;
  readonly logDir: string;
  title?: string;

  private readonly sessionsFile: string;
  private readonly eventsFile: string;

  constructor(options: { sessionId: string; taskId: string; project: string; logDir: string }) {
    this.sessionId = options.sessionId;
    this.taskId = options.taskId;
    this.project = options.project;

    // Worktree dispatches expose the authoritative project log directory
    // through a junction/symlink. The Codex denied-path guard temporarily
    // quarantines that link while the mutable worker runs. Resolve the target
    // once at construction so the host-side event stream remains appendable
    // even while the workspace-facing link is intentionally absent.
    const durableLogDir = resolveDurableEventLogDir(options.logDir);
    fs.mkdirSync(durableLogDir, { recursive: true });
    this.logDir = fs.realpathSync.native(durableLogDir);

    this.sessionsFile = path.join(this.logDir, "sessions.jsonl");
    this.eventsFile = path.join(this.logDir, `events-${this.sessionId}.jsonl`);
  }

  emit(stage: EventStage, payload: EventPayload): void {
    const event: QuackEvent = {
      sessionId: this.sessionId,
      taskId: this.taskId,
      project: this.project,
      timestamp: new Date().toISOString(),
      stage,
      payload,
    };

    fs.appendFileSync(this.eventsFile, JSON.stringify(event) + "\n", "utf-8");
  }

  recordSession(
    status: SessionEntry["status"],
    extra?: Partial<
      Pick<SessionEntry, "outcome" | "totalCostUsd" | "durationMs" | "turnsUsed" | "title">
    >,
  ): void {
    const entry: SessionEntry = {
      sessionId: this.sessionId,
      taskId: this.taskId,
      project: this.project,
      title: this.title,
      startTime: new Date().toISOString(),
      status,
      ...extra,
    };

    fs.appendFileSync(this.sessionsFile, JSON.stringify(entry) + "\n", "utf-8");
  }
}

// ─── Session ID generator ──────────────────────────────────────────

export function generateSessionId(taskId: string): string {
  const now = new Date();
  const pad2 = (n: number) => String(n).padStart(2, "0");
  const dateStr =
    `${now.getFullYear()}${pad2(now.getMonth() + 1)}${pad2(now.getDate())}` +
    `-${pad2(now.getHours())}${pad2(now.getMinutes())}${pad2(now.getSeconds())}`;
  return `quack-${taskId}-${dateStr}`;
}

// ─── No-op writer ──────────────────────────────────────────────────

const noopWriter: IEventWriter = {
  sessionId: "noop",
  taskId: "noop",
  project: "noop",
  title: undefined,
  emit(): void {
    // intentionally empty
  },
  recordSession(): void {
    // intentionally empty
  },
};

/**
 * Returns a no-op IEventWriter that silently discards all events.
 * Use this when event logging is not configured.
 */
export function createNoOpWriter(): IEventWriter {
  return noopWriter;
}
