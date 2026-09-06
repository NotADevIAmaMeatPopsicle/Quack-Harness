import type { WorkerRuntimeRole } from "../core/worker-protocol.js";

export interface WorkerInstallCommand {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  optional?: boolean;
  description?: string;
}

export interface WorkerCapabilityProbeSpec {
  capability: string;
  command: WorkerInstallCommand;
  description?: string;
}

export interface WorkerRepoSpec {
  id: string;
  label: string;
  sourceUrl: string;
  branch: string;
  destination: string;
  required: boolean;
}

export interface WorkerProjectInstallSpec {
  id: string;
  label: string;
  repoId: string;
  pathAlias: string;
  primary?: boolean;
  installCommands: WorkerInstallCommand[];
  probeCommands: WorkerInstallCommand[];
  capabilityProbes?: WorkerCapabilityProbeSpec[];
}

export interface WorkerEnvSpec {
  name: string;
  mode: "inline" | "manual";
  value?: string;
  placeholder?: string;
  description?: string;
  secretRef?: string;
}

export interface WorkerSecretSpec {
  id: string;
  mode: "auto" | "manual";
  envName?: string;
  sourceEnvVar?: string;
  placeholder?: string;
  description?: string;
}

export interface WorkerEnrollmentManifest {
  version: "worker-enrollment-v1";
  enrollmentId: string;
  issuedAt: string;
  expiresAt: string;
  controlPlane: {
    baseUrl: string;
    runtimeRole: WorkerRuntimeRole;
  };
  worker: {
    hostId: string;
    alias: string;
    capabilities: string[];
    maxConcurrentJobs: number;
    runtimePort: number;
    persistence: "manual" | "run-key" | "scheduled-task-logon" | "scheduled-task-startup";
    pollMs: number;
  };
  prerequisites: Array<{
    id: string;
    label: string;
    required: boolean;
    checkCommand?: WorkerInstallCommand;
    notes?: string;
  }>;
  repos: WorkerRepoSpec[];
  projects: WorkerProjectInstallSpec[];
  env: WorkerEnvSpec[];
  secrets: WorkerSecretSpec[];
  manualSteps: string[];
}

export type WorkerEnrollmentProgressPhase =
  | "bootstrap"
  | "prerequisites"
  | "repo_sync"
  | "dependency_install"
  | "env_write"
  | "capability_probe"
  | "runtime_start"
  | "runtime_health"
  | "listener_register"
  | "completed";

export type WorkerEnrollmentProgressState = "running" | "completed" | "failed" | "waiting";

export interface WorkerEnrollmentProgressEvent {
  id: string;
  phase: WorkerEnrollmentProgressPhase;
  state: WorkerEnrollmentProgressState;
  message: string;
  timestamp: string;
  detail?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerCapabilityProbeResult {
  capability: string;
  status: "passed" | "failed" | "withheld" | "deferred";
  projectId?: string;
  message: string;
  command?: WorkerInstallCommand;
}

export type WorkerRepoFreshnessStatus =
  | "missing"
  | "current"
  | "behind"
  | "ahead"
  | "diverged"
  | "wrong_branch"
  | "dirty"
  | "unknown";

export interface WorkerRepoFreshness {
  repoId: string;
  label: string;
  sourceUrl: string;
  expectedBranch: string;
  path?: string;
  exists: boolean;
  currentBranch?: string;
  localCommit?: string;
  remoteCommit?: string;
  dirty: boolean;
  ahead: number;
  behind: number;
  fastForwarded?: boolean;
  status: WorkerRepoFreshnessStatus;
  blockers: string[];
  repairCommand?: string;
}

export type WorkerCapabilityTier =
  | "base"
  | "project"
  | "browser"
  | "docker"
  | "auth"
  | "staging-db";

export interface WorkerCapabilityReadiness {
  capability: string;
  tier: WorkerCapabilityTier;
  requested: boolean;
  status: WorkerCapabilityProbeResult["status"];
  projectId?: string;
  message: string;
  command?: WorkerInstallCommand;
  repairCommand?: string;
}

export interface WorkerEnrollmentRepairAction {
  id: string;
  label: string;
  command: string;
  reason: string;
}

export interface WorkerEnrollmentReadiness {
  status: "pending" | "ready" | "blocked" | "degraded" | "expired";
  score: number;
  trustedForWork: boolean;
  blockedCapabilities: string[];
  blockers: string[];
  warnings: string[];
  repoFreshness: WorkerRepoFreshness[];
  capabilities: WorkerCapabilityReadiness[];
  repairActions: WorkerEnrollmentRepairAction[];
  updatedAt: string;
}

export interface WorkerEnrollmentInstallStatus {
  state:
    | "pending"
    | "bootstrap_consumed"
    | "installing"
    | "registered"
    | "healthy"
    | "needs_follow_up"
    | "failed"
    | "expired";
  progressPercent: number;
  currentStep?: WorkerEnrollmentProgressPhase;
  lastMessage?: string;
  lastEventAt?: string;
  bootstrapConsumed: boolean;
  listenerRegistered: boolean;
  listenerHealthy: boolean;
  runtimeHealthy: boolean;
  manualFollowUpPending: boolean;
  manualFollowUpCount: number;
  requestedCapabilities: string[];
  advertisedCapabilities: string[];
  capabilityWarnings: string[];
}

export interface WorkerEnrollmentListenerStatus {
  hostId: string;
  alias?: string;
  registeredAt?: string;
  lastHealthCheckAt?: string;
  healthy: boolean;
  currentLoad?: number;
  maxConcurrentJobs?: number;
  capabilities: string[];
  runtimeRole?: WorkerRuntimeRole;
  protocolVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerEnrollmentSessionSummary {
  enrollmentId: string;
  hostId: string;
  alias: string;
  profileId: string;
  projectId: string;
  createdAt: string;
  expiresAt: string;
  consumedAt?: string;
  createdBy: string;
  status: "pending" | "consumed" | "expired";
  runtimePort: number;
  capabilities: string[];
  persistence: WorkerEnrollmentManifest["worker"]["persistence"];
}

export interface WorkerEnrollmentTargetRoots {
  windows?: string;
  posix?: string;
}
