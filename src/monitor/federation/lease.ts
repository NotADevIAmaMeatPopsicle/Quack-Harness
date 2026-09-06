// ─── Federation Lease Helpers ──────────────────────────────────────
// Lease creation, expiry detection, and the canonical TTL constant.
// See docs/QUEUE_AND_FEDERATION_OPERATOR_MODEL.md §2.3 for lease
// semantics (soft reservation, watcher reclaim).

import type { FederatedJobLease, FederatedJobRecord } from "./types.js";

export const DEFAULT_FEDERATED_LEASE_TTL_MS = 30 * 60 * 1000;

export function federationNow(): string {
  return new Date().toISOString();
}

export function createFederatedLease(
  jobId: string,
  hostId: string,
  now: string,
  leaseTtlMs: number | undefined,
): FederatedJobLease {
  const ttl = Math.max(1, leaseTtlMs ?? DEFAULT_FEDERATED_LEASE_TTL_MS);
  return {
    leaseId: `${jobId}:${hostId}:${Date.parse(now).toString(36)}`,
    hostId,
    acquiredAt: now,
    expiresAt: new Date(Date.parse(now) + ttl).toISOString(),
  };
}

export function leaseExpired(job: FederatedJobRecord, nowMs = Date.now()): boolean {
  if (!job.lease?.expiresAt) return false;
  return Date.parse(job.lease.expiresAt) <= nowMs;
}
