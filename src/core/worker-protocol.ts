export const WORKER_COMMAND_PROTOCOL_VERSION = "worker-command-v1" as const;

export type WorkerRuntimeRole = "headnode" | "worker";
export type RuntimeStateAuthority = "canonical" | "cache" | "localSmokeOnly";

export interface RuntimeAuthorityDescriptor {
  runtimeRole: WorkerRuntimeRole;
  stateAuthority: RuntimeStateAuthority;
  canonicalBaseUrl: string | null;
  localDbAuthoritative: boolean;
}

export type WorkerCommandKind =
  | "git_pull"
  | "refresh_project"
  | "worker.refresh"
  | "probe_capabilities"
  | "collect_diagnostics"
  | "sync_wiki";

export type WorkerCommandResultStatus =
  | "accepted"
  | "running"
  | "completed"
  | "failed"
  | "retryable"
  | "non_retryable";

export type WorkerCommandErrorCategory =
  | "transport"
  | "auth"
  | "tool_missing"
  | "bad_payload"
  | "project_not_found"
  | "platform_mismatch"
  | "execution_failed"
  | "not_supported"
  | "unknown";

export interface WorkerStructuredExec {
  cmd: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
}

export interface WorkerCommandEnvelopeBase {
  commandId: string;
  protocolVersion: typeof WORKER_COMMAND_PROTOCOL_VERSION;
  kind: WorkerCommandKind;
  issuedAt: string;
  issuedBy?: string;
  correlationId?: string;
  targetProjectId?: string;
  taskId?: string;
  notes?: string;
}

export interface GitPullWorkerCommand extends WorkerCommandEnvelopeBase {
  kind: "git_pull";
  payload: {
    remote?: string;
    targetBranch: string;
    ffOnly?: boolean;
    repoPathKey?: string;
  };
}

export interface RefreshProjectWorkerCommand extends WorkerCommandEnvelopeBase {
  kind: "refresh_project";
  payload: {
    repoPathKey?: string;
    exec?: WorkerStructuredExec[];
  };
}

export interface ProbeCapabilitiesWorkerCommand extends WorkerCommandEnvelopeBase {
  kind: "probe_capabilities";
  payload: {
    refreshListenerHeartbeat?: boolean;
  };
}

export interface WorkerRefreshCommand extends WorkerCommandEnvelopeBase {
  kind: "worker.refresh";
  payload: {
    reason: string;
    repos?: string[];
    branches?: Record<string, string>;
    runInstall?: boolean;
    runCapabilityProbes?: boolean;
    applyProfile?: boolean;
    maxDirtyAction?: "block" | "stash";
  };
}

export interface CollectDiagnosticsWorkerCommand extends WorkerCommandEnvelopeBase {
  kind: "collect_diagnostics";
  payload: {
    includeJobs?: boolean;
    includeHealth?: boolean;
  };
}

export interface SyncWikiWorkerCommand extends WorkerCommandEnvelopeBase {
  kind: "sync_wiki";
  payload: {
    mode: "status" | "pull";
  };
}

export type WorkerCommandEnvelope =
  | GitPullWorkerCommand
  | RefreshProjectWorkerCommand
  | WorkerRefreshCommand
  | ProbeCapabilitiesWorkerCommand
  | CollectDiagnosticsWorkerCommand
  | SyncWikiWorkerCommand;

export interface WorkerCommandResult {
  commandId: string;
  protocolVersion: typeof WORKER_COMMAND_PROTOCOL_VERSION;
  kind: WorkerCommandKind;
  status: WorkerCommandResultStatus;
  acknowledgedAt: string;
  startedAt?: string;
  completedAt?: string;
  durationMs?: number;
  exitCode?: number;
  message?: string;
  errorCategory?: WorkerCommandErrorCategory;
  stdoutSnippet?: string;
  stderrSnippet?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerCommandResultSummary {
  kind: WorkerCommandKind;
  status: WorkerCommandResultStatus;
  completedAt?: string;
  durationMs?: number;
  errorCategory?: WorkerCommandErrorCategory;
  message?: string;
  metadata?: Record<string, unknown>;
}

export function isWorkerRuntimeRole(value: unknown): value is WorkerRuntimeRole {
  return value === "headnode" || value === "worker";
}

export function isWorkerCommandKind(value: unknown): value is WorkerCommandKind {
  return (
    value === "git_pull" ||
    value === "refresh_project" ||
    value === "worker.refresh" ||
    value === "probe_capabilities" ||
    value === "collect_diagnostics" ||
    value === "sync_wiki"
  );
}

export function isWorkerCommandEnvelope(value: unknown): value is WorkerCommandEnvelope {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.commandId === "string" &&
    record.protocolVersion === WORKER_COMMAND_PROTOCOL_VERSION &&
    isWorkerCommandKind(record.kind) &&
    typeof record.issuedAt === "string" &&
    typeof record.payload === "object" &&
    record.payload !== null
  );
}

export function summarizeWorkerCommandResult(
  result: WorkerCommandResult | undefined,
): WorkerCommandResultSummary | undefined {
  if (!result) return undefined;
  return {
    kind: result.kind,
    status: result.status,
    completedAt: result.completedAt ?? result.acknowledgedAt,
    durationMs: result.durationMs,
    errorCategory: result.errorCategory,
    message: result.message,
  };
}
