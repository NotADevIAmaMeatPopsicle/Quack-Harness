import {
  hostHasCapacity,
  hostSupports,
  normalizeCapabilities,
  type FederatedHost,
} from "./host-registry.js";
import type { BlockReasonCode } from "../workflow/workflow-state-types.js";

export interface FederatedRouteRequest {
  taskId: string;
  jobType: "intake" | "verify" | "fix" | "dispatch";
  requiredCapabilities?: string[];
  preferredHostId?: string;
  hosts: FederatedHost[];
}

export interface FederatedRouteAssignment {
  ok: true;
  host: FederatedHost;
  requiredCapabilities: string[];
  fallbackUsed: boolean;
  decision: {
    reason: string;
    candidatesConsidered: string[];
  };
}

export interface FederatedRouteFailure {
  ok: false;
  retryable: boolean;
  blockReasonCode: BlockReasonCode;
  error: string;
  requiredCapabilities: string[];
  fallback: {
    attemptedHostId?: string;
    candidatesConsidered: string[];
    reason: string;
  };
}

export type FederatedRouteResult = FederatedRouteAssignment | FederatedRouteFailure;

function defaultCapabilityForJob(jobType: FederatedRouteRequest["jobType"]): string {
  switch (jobType) {
    case "intake":
      return "intake";
    case "verify":
      return "verify";
    case "fix":
      return "fix";
    case "dispatch":
      return "dispatch";
  }
}

export function routeFederatedJob(input: FederatedRouteRequest): FederatedRouteResult {
  const requiredCapabilities = normalizeCapabilities(
    input.requiredCapabilities && input.requiredCapabilities.length > 0
      ? input.requiredCapabilities
      : [defaultCapabilityForJob(input.jobType)],
  );
  const capableHosts = input.hosts
    .filter((host) => host.enabled)
    .filter((host) => hostSupports(host, requiredCapabilities));
  const candidates = capableHosts.filter(hostHasCapacity);
  const candidatesConsidered = candidates.map((host) => host.id);

  if (input.preferredHostId) {
    const preferredCapable = capableHosts.find((host) => host.id === input.preferredHostId);
    const preferred = candidates.find((host) => host.id === input.preferredHostId);
    if (!preferredCapable) {
      return {
        ok: false,
        retryable: true,
        blockReasonCode: "pending_remote_listener",
        error: "preferred_host_unavailable",
        requiredCapabilities,
        fallback: {
          attemptedHostId: input.preferredHostId,
          candidatesConsidered,
          reason: "Preferred host is disabled or lacks required capabilities.",
        },
      };
    }
    if (!hostHasCapacity(preferredCapable)) {
      const fallback = candidates.find((host) => host.healthy && host.id !== preferredCapable.id);
      if (fallback) {
        return {
          ok: true,
          host: fallback,
          requiredCapabilities,
          fallbackUsed: true,
          decision: {
            reason: `Preferred host ${preferredCapable.id} is at capacity; assigned ${fallback.id}.`,
            candidatesConsidered,
          },
        };
      }
      return {
        ok: false,
        retryable: true,
        blockReasonCode: "pending_remote_listener",
        error: "host_at_capacity",
        requiredCapabilities,
        fallback: {
          attemptedHostId: preferredCapable.id,
          candidatesConsidered: capableHosts.map((host) => host.id),
          reason: "Preferred host is currently at capacity.",
        },
      };
    }
    if (!preferred) {
      return {
        ok: false,
        retryable: true,
        blockReasonCode: "pending_remote_listener",
        error: "preferred_host_unavailable",
        requiredCapabilities,
        fallback: {
          attemptedHostId: input.preferredHostId,
          candidatesConsidered,
          reason: "Preferred host is unavailable after capacity filtering.",
        },
      };
    }
    if (!preferred.healthy) {
      const fallback = candidates.find((host) => host.healthy && host.id !== preferred.id);
      if (fallback) {
        return {
          ok: true,
          host: fallback,
          requiredCapabilities,
          fallbackUsed: true,
          decision: {
            reason: `Preferred host ${preferred.id} is unhealthy; assigned ${fallback.id}.`,
            candidatesConsidered,
          },
        };
      }
      return {
        ok: false,
        retryable: true,
        blockReasonCode: "host_unhealthy",
        error: "host_unhealthy",
        requiredCapabilities,
        fallback: {
          attemptedHostId: preferred.id,
          candidatesConsidered,
          reason: "Preferred host is unhealthy and no healthy fallback exists.",
        },
      };
    }
    return {
      ok: true,
      host: preferred,
      requiredCapabilities,
      fallbackUsed: false,
      decision: {
        reason: `Assigned preferred host ${preferred.id}.`,
        candidatesConsidered,
      },
    };
  }

  const host = candidates.find((candidate) => candidate.healthy);
  if (host) {
    return {
      ok: true,
      host,
      requiredCapabilities,
      fallbackUsed: false,
      decision: {
        reason: `Assigned first healthy capable host ${host.id}.`,
        candidatesConsidered,
      },
    };
  }

  if (candidates.length === 0 && capableHosts.length > 0) {
    return {
      ok: false,
      retryable: true,
      blockReasonCode: "pending_remote_listener",
      error: "host_at_capacity",
      requiredCapabilities,
      fallback: {
        attemptedHostId: input.preferredHostId,
        candidatesConsidered: capableHosts.map((host) => host.id),
        reason: "Capable hosts exist but are currently at capacity.",
      },
    };
  }

  return {
    ok: false,
    retryable: candidates.length > 0,
    blockReasonCode: candidates.length > 0 ? "host_unhealthy" : "pending_remote_listener",
    error: candidates.length > 0 ? "host_unhealthy" : "no_capable_listener",
    requiredCapabilities,
    fallback: {
      attemptedHostId: input.preferredHostId,
      candidatesConsidered,
      reason:
        candidates.length > 0
          ? "Capable hosts exist but all are unhealthy."
          : "No enabled host advertises the required capabilities.",
    },
  };
}
