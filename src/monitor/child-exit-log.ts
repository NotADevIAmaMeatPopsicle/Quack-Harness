// ─── Dispatch child exit — durable log (QPI-043) ────────────────────
// The exit facts of a dispatch child (exit code, signal, killed) must
// outlive both the child AND the monitor. Two instrumentation attempts
// failed before this module existed: the in-memory DispatchJob dies with
// a monitor restart, and the typed lifecycle callback reaches SSE only
// (every server wiring site is a bare sse.broadcast), so a "durable"
// event routed through it never touched disk.
//
// This module appends a `dispatch_child_exit` event into the events
// jsonl of the CHILD's own session — the same file an investigator is
// already reading for the stage timeline — resolved via sessions.jsonl.
// When the child never recorded a session (death before the dispatcher
// booted), the facts still land durably under the monitor's job session
// id so a file exists to grep.

import { EventWriter } from "./event-emitter.js";
import { EventReader } from "./event-reader.js";
import type { DispatchChildExitPayload } from "./event-types.js";

export type ChildExitSessionResolution = "child-session" | "latest-task-session" | "job-fallback";

export interface AppendDispatchChildExitOptions {
  /** The monitor's resolved log dir — the same dir EventReader watches. */
  logDir: string;
  taskId: string;
  /** Monitor-side job session id; the durable fallback target. */
  jobSessionId: string;
  /** ISO timestamp the monitor spawned the child. */
  jobStartedAt: string;
  exitCode: number | null;
  signal: string | null;
  worktreePath: string | null;
}

export interface AppendDispatchChildExitResult {
  sessionId: string;
  resolution: ChildExitSessionResolution;
}

export function appendDispatchChildExit(
  options: AppendDispatchChildExitOptions,
): AppendDispatchChildExitResult {
  const reader = new EventReader(options.logDir);
  const taskSessions = reader.getExecutionSessions().filter((s) => s.taskId === options.taskId);

  // getExecutionSessions returns newest-first, so find() picks the newest
  // session that started at/after the spawn — the one THIS child
  // created. Both timestamps are same-host toISOString values, so the
  // lexicographic compare is a time compare.
  let resolution: ChildExitSessionResolution = "job-fallback";
  let target = taskSessions.find((s) => s.startTime >= options.jobStartedAt);
  if (target) {
    resolution = "child-session";
  } else if (taskSessions.length > 0) {
    // Every session predates this spawn (a resume reusing an earlier
    // session, or a child that died before its first recordSession this
    // run). The newest session for the task is still the file an
    // investigator will open.
    target = taskSessions[0];
    resolution = "latest-task-session";
  }

  const sessionId = target?.sessionId ?? options.jobSessionId;
  const project = target?.project ?? "unknown";

  const writer = new EventWriter({
    sessionId,
    taskId: options.taskId,
    project,
    logDir: options.logDir,
  });

  const payload: DispatchChildExitPayload = {
    taskId: options.taskId,
    exitCode: options.exitCode,
    signal: options.signal,
    killed: Boolean(options.signal),
    worktreePath: options.worktreePath,
    at: new Date().toISOString(),
    sessionResolution: resolution,
  };
  writer.emit("dispatch_child_exit", payload);

  return { sessionId, resolution };
}
