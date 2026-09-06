import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ParsedTask } from "../core/types.js";
import type { EventReader } from "../monitor/event-reader.js";
import { buildStrictDuplicateClaimantIndex } from "../core/duplicate-claimants.js";
import { listTaskClaimantDeclarations } from "../core/task-file-resolver.js";
import {
  isClaimantDiagnosticSession,
  type ClaimantDiagnosticPayload,
  type QuackEvent,
} from "../monitor/event-types.js";
import { loadLatestReviewBundleForTask } from "../review/docs-gate.js";
import {
  type DocsJobEventRecord,
  projectWorkflowState,
  type WorkflowProjectionRecord,
} from "./state-projector.js";
import { WorkflowProjectionStore } from "./projection-store.js";

export interface WorkflowStateResolverInput {
  projectRoot: string;
  taskDir?: string;
  task: ParsedTask;
  reader: EventReader;
  hostId?: string;
}

function parseJsonlLines<T>(raw: string): T[] {
  const records: T[] = [];
  for (const line of raw.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      records.push(JSON.parse(trimmed) as T);
    } catch {
      // Ignore malformed event lines; projector reads best-effort artifacts.
    }
  }
  return records;
}

async function loadDocsJobEvents(
  projectRoot: string,
  taskId: string,
): Promise<DocsJobEventRecord[]> {
  const eventDir = path.join(projectRoot, ".quack", "docs-pipeline", "job-events");
  let entries: string[];
  try {
    entries = await fs.readdir(eventDir);
  } catch {
    return [];
  }

  const records: DocsJobEventRecord[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".jsonl")) continue;
    const filePath = path.join(eventDir, entry);
    const raw = await fs.readFile(filePath, "utf-8");
    for (const record of parseJsonlLines<DocsJobEventRecord>(raw)) {
      if (record.taskId === taskId) {
        records.push(record);
      }
    }
  }
  return records;
}

export async function resolveWorkflowState(
  input: WorkflowStateResolverInput,
): Promise<WorkflowProjectionRecord> {
  const allSessions = input.reader
    .getAllSessions()
    .filter((session) => session.taskId === input.task.id);
  const sessions = allSessions.filter((session) => !isClaimantDiagnosticSession(session));
  const allEvents = allSessions.flatMap((session) =>
    input.reader.getSessionEvents(session.sessionId),
  );
  const diagnosticEvents = allEvents.filter(
    (event): event is QuackEvent & { payload: ClaimantDiagnosticPayload } =>
      event.stage === "recording_claimant_diagnostic",
  );
  const events = allEvents.filter((event) => event.stage !== "recording_claimant_diagnostic");
  const latestDiagnostic = [...diagnosticEvents].sort((a, b) =>
    b.timestamp.localeCompare(a.timestamp),
  )[0]?.payload;

  let claimantDiagnostic: ClaimantDiagnosticPayload | undefined;
  if (latestDiagnostic) {
    if (input.taskDir) {
      const currentIndex = await buildStrictDuplicateClaimantIndex(() =>
        listTaskClaimantDeclarations(input.taskDir as string),
      );
      if (currentIndex.status === "unavailable") {
        claimantDiagnostic = {
          ...latestDiagnostic,
          kind: "claimant-index-unavailable",
          claimants: [],
          reason: currentIndex.reason,
        };
      } else {
        const currentClaimants = currentIndex.contested.get(input.task.id);
        if (currentClaimants) {
          claimantDiagnostic = {
            ...latestDiagnostic,
            kind: "duplicate-claimants",
            claimants: [...currentClaimants],
            reason:
              `Task ${input.task.id} has a contested id claimed by: ` + currentClaimants.join(", "),
          };
        }
      }
    } else {
      claimantDiagnostic = latestDiagnostic;
    }
  }
  const latestReview = await loadLatestReviewBundleForTask(input.projectRoot, input.task.id);
  const docsEvents = await loadDocsJobEvents(input.projectRoot, input.task.id);

  const projection = projectWorkflowState({
    task: input.task,
    sessions,
    events,
    claimantDiagnostic,
    latestReview,
    docsEvents,
    hostId: input.hostId,
  });

  return projection;
}

export async function refreshWorkflowStateProjection(
  input: WorkflowStateResolverInput,
): Promise<WorkflowProjectionRecord> {
  const projection = await resolveWorkflowState(input);
  const store = new WorkflowProjectionStore(input.projectRoot);
  await store.save(projection);
  return projection;
}
