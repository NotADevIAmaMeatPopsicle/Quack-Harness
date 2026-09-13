import { z } from "zod";
import { loadFederationPeerConfig } from "./peer-config.js";
import { loadFederatedJob } from "./store.js";
import { isSafeFederatedJobId } from "./job-id.js";

const boundedId = z.string().min(1).max(512);
const claimSchema = z.object({
  projectId: boundedId,
  jobId: boundedId,
  taskId: boundedId,
  hostId: boundedId,
  status: z.enum(["assigned", "running", "verifying", "fixing"]),
  lease: z.object({
    leaseId: boundedId,
    hostId: boundedId,
    expiresAt: z.string().min(1).max(64),
  }),
});

export type VerifiedFederatedStartClaim = z.infer<typeof claimSchema>;
export type FederatedStartRefusalReason = "config_invalid" | "claim_mismatch" |
  "peer_unreachable" | "peer_timeout" | "peer_status" | "peer_response_invalid";

export interface FederatedStartClaimInput {
  projectRoot?: string;
  projectId?: string;
  taskId: string;
  jobId?: string;
  hostId?: string;
  leaseId?: string;
  onRefusal?: (reason: FederatedStartRefusalReason) => void;
}

const MAX_RESPONSE_BYTES = 1024 * 1024;
const AUTHORITY_TIMEOUT_MS = 5_000;

async function readAuthorityJob(url: URL, serviceToken: string): Promise<
  { ok: true; value: unknown } | { ok: false; reason: FederatedStartRefusalReason }
> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), AUTHORITY_TIMEOUT_MS);
  timeout.unref();
  try {
    const response = await fetch(url, {
      headers: { "X-Quack-Service-Token": serviceToken },
      redirect: "error",
      signal: controller.signal,
    });
    if (!response.ok) return { ok: false, reason: "peer_status" };
    if (!response.body) return { ok: false, reason: "peer_response_invalid" };
    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let length = 0;
    try {
      let chunk = await reader.read();
      while (!chunk.done) {
        const bytes: unknown = chunk.value;
        if (!(bytes instanceof Uint8Array)) return { ok: false, reason: "peer_response_invalid" };
        length += bytes.byteLength;
        if (length > MAX_RESPONSE_BYTES) return { ok: false, reason: "peer_response_invalid" };
        chunks.push(bytes);
        chunk = await reader.read();
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        return { ok: false, reason: "peer_response_invalid" };
      }
      if (!parsed || typeof parsed !== "object" || !("ok" in parsed) ||
          parsed.ok !== true || !("job" in parsed)) return { ok: false, reason: "peer_response_invalid" };
      return { ok: true, value: parsed.job };
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  } catch {
    return { ok: false, reason: controller.signal.aborted ? "peer_timeout" : "peer_unreachable" };
  } finally {
    controller.abort();
    clearTimeout(timeout);
  }
}

/** Read fresh authority at each caller fence. Never install/cache a remote job. */
export async function resolveFederatedStartClaim(
  input: FederatedStartClaimInput,
): Promise<VerifiedFederatedStartClaim | undefined> {
  const refuse = (reason: FederatedStartRefusalReason): undefined => {
    try { input.onRefusal?.(reason); } catch { /* Diagnostics cannot change refusal. */ }
    return undefined;
  };
  // Job IDs also become local filenames; reject traversal before any store read.
  if (!input.projectRoot || !input.projectId || !input.jobId ||
      !isSafeFederatedJobId(input.jobId) ||
      !input.hostId || !input.leaseId) return refuse("claim_mismatch");
  try {
    const peer = await loadFederationPeerConfig(input.projectRoot);
    let raw: unknown;
    let expectedProjectId = input.projectId;
    if (peer?.startAuthority) {
      const token = peer.serviceToken?.trim();
      if (!token || !peer.remoteProjectId) {
        return refuse("config_invalid");
      }
      if (peer.startAuthority.hostId !== input.hostId) return refuse("claim_mismatch");
      const base = new URL(peer.url);
      if (!["http:", "https:"].includes(base.protocol) || base.username || base.password ||
          base.search || base.hash) return refuse("config_invalid");
      const url = new URL(`${peer.url}/v1/federation/jobs/${encodeURIComponent(input.jobId)}`);
      url.searchParams.set("projectId", peer.remoteProjectId);
      const response = await readAuthorityJob(url, token);
      if (!response.ok) return refuse(response.reason);
      raw = response.value;
      expectedProjectId = peer.remoteProjectId;
    } else {
      raw = await loadFederatedJob(input.projectRoot, input.jobId);
    }
    const parsed = claimSchema.safeParse(raw);
    if (!parsed.success) return refuse("claim_mismatch");
    const record = parsed.data;
    const expiry = Date.parse(record.lease.expiresAt);
    if (record.projectId !== expectedProjectId || record.jobId !== input.jobId ||
        record.taskId !== input.taskId || record.hostId !== input.hostId ||
        record.lease.hostId !== input.hostId || record.lease.leaseId !== input.leaseId ||
        !Number.isFinite(expiry) || expiry <= Date.now()) return refuse("claim_mismatch");
    return record;
  } catch {
    // Express 4's early async route has no error boundary. Config, network and
    // parsing failures must become the named refusal, without leaking secrets.
    return refuse("config_invalid");
  }
}
