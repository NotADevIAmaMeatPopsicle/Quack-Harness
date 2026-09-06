import type { WorkerCommandResultSummary, WorkerRuntimeRole } from "../core/worker-protocol.js";

export interface FederatedHost {
  id: string;
  alias?: string;
  baseUrl?: string;
  capabilities: string[];
  enabled: boolean;
  healthy: boolean;
  lastHealthCheckAt?: string;
  currentLoad?: number;
  maxConcurrentJobs?: number;
  repoCommit?: string;
  projectPaths?: Record<string, string>;
  runtimeRole?: WorkerRuntimeRole;
  protocolVersion?: string;
  lastCommand?: WorkerCommandResultSummary;
  metadata?: Record<string, unknown>;
}

export interface FederatedJobEnvelope {
  jobId: string;
  taskId: string;
  jobType: "intake" | "verify" | "fix" | "dispatch";
  requiredCapabilities: string[];
  correlationId: string;
}

export function normalizeCapabilities(values: string[] | undefined): string[] {
  return [
    ...new Set(
      (values ?? []).map((value) => value.trim().toLowerCase()).filter((value) => value.length > 0),
    ),
  ].sort((a, b) => a.localeCompare(b));
}

export function hostSupports(host: FederatedHost, requiredCapabilities: string[]): boolean {
  const capabilities = new Set(normalizeCapabilities(host.capabilities));
  return requiredCapabilities.every((capability) => capabilities.has(capability));
}

export function hostHasCapacity(host: FederatedHost): boolean {
  const maxConcurrentJobs = host.maxConcurrentJobs ?? 1;
  const currentLoad = host.currentLoad ?? 0;
  return currentLoad < maxConcurrentJobs;
}
