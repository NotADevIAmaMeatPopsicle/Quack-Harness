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
    this.logDir = options.logDir;

    this.sessionsFile = path.join(this.logDir, "sessions.jsonl");
    this.eventsFile = path.join(this.logDir, `events-${this.sessionId}.jsonl`);

    // Ensure log directory exists
    fs.mkdirSync(this.logDir, { recursive: true });
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
