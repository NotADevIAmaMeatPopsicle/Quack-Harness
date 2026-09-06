import type { VerifiedRow } from "../../db/types.js";
import {
  recordVerification,
  type NormalizedVerificationEntry,
  type VerificationStoreProject,
} from "../verification-store.js";
import type { FederationPeerConfig } from "./peer-config.js";
import type { TaskService } from "../task-service.js";
import { listTaskClaimantDeclarations } from "../../core/task-file-resolver.js";
import { buildStrictDuplicateClaimantIndex } from "../../core/duplicate-claimants.js";

export interface VerifiedSyncProject extends VerificationStoreProject {
  projectId?: string;
  taskService?: TaskService | null;
  taskDir?: string;
}

interface VerifiedSyncResponse {
  ok?: boolean;
  rows?: VerifiedRow[];
}

function extractStructuredNoteValue(
  notes: string | null | undefined,
  key: "reviewId" | "workflowId",
): string | undefined {
  if (!notes) return undefined;
  const match = notes.match(new RegExp(`${key}=([^;\\s]+)`));
  return match?.[1];
}

function authHeaders(peer: FederationPeerConfig): Record<string, string> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  if (peer.serviceToken) {
    headers.Authorization = `Bearer ${peer.serviceToken}`;
    headers["X-Quack-Service-Token"] = peer.serviceToken;
  }
  return headers;
}

function latestLocalCursor(project: VerifiedSyncProject): string | undefined {
  let latest: string | undefined;
  for (const row of project.db.getAllVerified().values()) {
    const cursor = row.updated_at ?? row.verified_at;
    if (!latest || cursor.localeCompare(latest) > 0) {
      latest = cursor;
    }
  }
  return latest;
}

function verificationEntryFromRow(row: VerifiedRow): NormalizedVerificationEntry {
  return {
    taskId: row.task_id,
    verdict: row.verdict as NormalizedVerificationEntry["verdict"],
    commitSha: row.commit_sha,
    method: row.method,
    criteriaChecked: row.criteria_checked,
    criteriaPassed: row.criteria_passed,
    notes: row.notes ?? undefined,
    verifiedAt: row.verified_at,
    updatedAt: row.updated_at ?? row.verified_at,
    reviewId: extractStructuredNoteValue(row.notes, "reviewId"),
    workflowId: extractStructuredNoteValue(row.notes, "workflowId"),
  };
}

export async function pushVerificationToPeer(
  project: VerifiedSyncProject,
  peer: FederationPeerConfig,
  entry: NormalizedVerificationEntry,
): Promise<void> {
  if (!peer.pushOnWrite) return;

  const payload: { entries: NormalizedVerificationEntry[]; projectId?: string } = {
    entries: [entry],
  };
  // Multi-project peers reject unscoped writes (TASK-1301,
  // PROJECT_SCOPE_REQUIRED): configure peer.remoteProjectId for them.
  // No local-id fallback — guessing the peer's project id is the exact
  // failure mode the guard exists to prevent; unscoped pushes remain valid
  // against single-project peers.
  if (peer.remoteProjectId) {
    payload.projectId = peer.remoteProjectId;
  }

  const response = await fetch(`${peer.url}/v1/federation/verified`, {
    method: "POST",
    headers: authHeaders(peer),
    body: JSON.stringify(payload),
  });
  if (!response.ok) {
    throw new Error(`peer returned ${response.status}`);
  }
}

export async function pullVerifiedFromPeer(
  project: VerifiedSyncProject,
  peer: FederationPeerConfig,
): Promise<{ fetched: number; applied: number; skipped: number; latestCursor?: string }> {
  const params = new URLSearchParams();
  const since = latestLocalCursor(project);
  if (since) params.set("since", since);
  params.set("limit", String(peer.limit));
  if (peer.remoteProjectId) params.set("projectId", peer.remoteProjectId);

  const response = await fetch(`${peer.url}/v1/federation/verified?${params.toString()}`, {
    headers: authHeaders(peer),
  });
  if (!response.ok) {
    throw new Error(`peer returned ${response.status}`);
  }

  const body = (await response.json()) as VerifiedSyncResponse;
  const rows = body.rows ?? [];
  const taskService = project.taskService;
  const claimantIndex = await buildStrictDuplicateClaimantIndex(
    taskService
      ? () => listTaskClaimantDeclarations(taskService.getTaskDirectory())
      : project.taskDir
        ? () => listTaskClaimantDeclarations(project.taskDir as string)
        : undefined,
  );
  let applied = 0;
  let skipped = 0;
  let latestCursor: string | undefined;

  for (const row of rows) {
    const result = await recordVerification(
      project,
      verificationEntryFromRow(row),
      { syncToPeers: false },
      claimantIndex,
    );
    if (result.applied) {
      applied += 1;
    } else {
      skipped += 1;
    }

    const cursor = row.updated_at ?? row.verified_at;
    if (!latestCursor || cursor.localeCompare(latestCursor) > 0) {
      latestCursor = cursor;
    }
  }

  return { fetched: rows.length, applied, skipped, latestCursor };
}

export function startPeriodicVerifiedSync(
  project: VerifiedSyncProject,
  peer: FederationPeerConfig,
): () => void {
  if (peer.syncIntervalMs <= 0) return () => undefined;

  const timer = setInterval(() => {
    void pullVerifiedFromPeer(project, peer).catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(
        `[verification-sync] periodic pull failed for ${project.projectId ?? project.projectRoot ?? "unknown"}: ${msg}`,
      );
    });
  }, peer.syncIntervalMs);
  timer.unref();
  return () => clearInterval(timer);
}
