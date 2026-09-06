import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";

import { normalizeClaimantTaskId } from "../core/duplicate-claimants.js";
import { EventWriter } from "./event-emitter.js";
import { EventReader } from "./event-reader.js";
import {
  CLAIMANT_DIAGNOSTIC_OUTCOME,
  CLAIMANT_DIAGNOSTIC_SESSION_PREFIX,
  type ClaimantDiagnosticPayload,
  type SessionEntry,
} from "./event-types.js";

export type ClaimantDiagnostic = ClaimantDiagnosticPayload;

export function claimantDiagnosticSessionId(
  taskId: string,
  commitSha: string,
  kind: ClaimantDiagnostic["kind"],
): string {
  const normalizedTaskId = normalizeClaimantTaskId(taskId).toLowerCase();
  const digest = crypto
    .createHash("sha256")
    .update(`${normalizeClaimantTaskId(taskId)}\0${commitSha}\0${kind}`)
    .digest("hex")
    .slice(0, 20);
  return `${CLAIMANT_DIAGNOSTIC_SESSION_PREFIX}${normalizedTaskId}-${digest}`;
}

function parseSessionLines(filePath: string): SessionEntry[] {
  if (!fs.existsSync(filePath)) return [];
  return fs
    .readFileSync(filePath, "utf-8")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as SessionEntry];
      } catch {
        return [];
      }
    });
}

/**
 * Persist and independently verify both files in the EventWriter durability
 * pair. A retry repairs whichever half was missing after a prior crash.
 */
export async function persistClaimantDiagnostic(args: {
  logDir: string;
  project: string;
  diagnostic: ClaimantDiagnostic;
}): Promise<void> {
  await Promise.resolve();
  const diagnostic: ClaimantDiagnostic = {
    ...args.diagnostic,
    taskId: normalizeClaimantTaskId(args.diagnostic.taskId),
    claimants: [...args.diagnostic.claimants].sort((a, b) => a.localeCompare(b)),
  };
  const sessionId = claimantDiagnosticSessionId(
    diagnostic.taskId,
    diagnostic.commitSha,
    diagnostic.kind,
  );
  const sessionsPath = path.join(args.logDir, "sessions.jsonl");
  const reader = new EventReader(args.logDir);
  const matchingEvents = reader
    .getSessionEvents(sessionId)
    .filter(
      (event) =>
        event.stage === "recording_claimant_diagnostic" &&
        event.taskId === diagnostic.taskId &&
        (event.payload as ClaimantDiagnosticPayload).commitSha === diagnostic.commitSha &&
        (event.payload as ClaimantDiagnosticPayload).kind === diagnostic.kind,
    );
  const matchingSessions = parseSessionLines(sessionsPath).filter(
    (session) => session.sessionId === sessionId,
  );

  const writer = new EventWriter({
    sessionId,
    taskId: diagnostic.taskId,
    project: args.project,
    logDir: args.logDir,
  });
  writer.title = `Claimant diagnostic for ${diagnostic.taskId}`;

  if (matchingEvents.length === 0) {
    writer.emit("recording_claimant_diagnostic", diagnostic);
  }
  if (matchingSessions.length === 0) {
    writer.recordSession("completed", {
      outcome: CLAIMANT_DIAGNOSTIC_OUTCOME,
      title: writer.title,
    });
  }

  const freshReader = new EventReader(args.logDir);
  const verifiedEvents = freshReader
    .getSessionEvents(sessionId)
    .filter(
      (event) =>
        event.stage === "recording_claimant_diagnostic" &&
        event.taskId === diagnostic.taskId &&
        (event.payload as ClaimantDiagnosticPayload).commitSha === diagnostic.commitSha &&
        (event.payload as ClaimantDiagnosticPayload).kind === diagnostic.kind,
    );
  const verifiedSessions = parseSessionLines(sessionsPath).filter(
    (session) => session.sessionId === sessionId,
  );
  const discoverable = freshReader
    .getAllSessions()
    .some((session) => session.sessionId === sessionId);
  if (verifiedEvents.length < 1 || verifiedSessions.length < 1 || !discoverable) {
    throw new Error(
      `Claimant diagnostic ${diagnostic.taskId}@${diagnostic.commitSha} is not durable.`,
    );
  }
}
