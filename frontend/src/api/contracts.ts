// ─── Quack Monitor API Contracts (frontend mirror) ─────────────────
// Mirror of `src/monitor/api-contracts.ts`. Manually duplicated here to
// avoid coupling the frontend's TypeScript build to the backend's
// closure-scoped types. When the backend contracts change, update this
// file in lockstep.
//
// TODO(TASK-878 follow-up): replace this duplication with a shared types
// package once the federation hoist completes (TASK-884-B) and the
// backend's exported surface stabilizes.

// ─── Common ────────────────────────────────────────────────────────

export interface DashboardPagination {
  page: number;
  perPage: number;
  totalItems: number;
  totalPages: number;
  hasNextPage: boolean;
  hasPreviousPage: boolean;
}

export type DashboardSortOrder = "asc" | "desc";

export interface DashboardParseError {
  file: string;
  error: string;
}

export interface DashboardParseWarning {
  file: string;
  taskId: string;
  warnings: string[];
}

export type BacklogHygieneIssueCode =
  | "duplicate_id"
  | "superseded"
  | "status_on_hold"
  | "status_rejected";

export interface BacklogHygieneIssue {
  code: BacklogHygieneIssueCode;
  message: string;
  relatedTaskIds?: string[];
  relatedFiles?: string[];
}

export interface TaskBacklogHygiene {
  dispatchBlocked: boolean;
  reasons: BacklogHygieneIssue[];
}

export interface DuplicateTaskIdWarning {
  taskId: string;
  files: string[];
}

export interface SupersededTaskWarning {
  taskId: string;
  supersededBy: string[];
}

export interface ExcludedTaskCandidate {
  taskId: string;
  title: string;
  status: TaskStatus;
  reasons: BacklogHygieneIssue[];
}

export interface BacklogHygieneReport {
  duplicateIds: DuplicateTaskIdWarning[];
  supersededTasks: SupersededTaskWarning[];
  excludedCandidates: ExcludedTaskCandidate[];
}

// ─── Task statuses (mirror src/core/task-status.ts) ────────────────

export const TASK_STATUSES = [
  "BACKLOG",
  "READY",
  "IN_PROGRESS",
  "BLOCKED",
  "ON_HOLD",
  "DECOMPOSED",
  "VERIFYING",
  "COMPLETE",
  "VERIFIED",
  "REJECTED",
] as const;
export type TaskStatus = typeof TASK_STATUSES[number];

// ─── Tasks ──────────────────────────────────────────────────────────

export interface TaskSummary {
  id: string;
  title: string;
  priority: string;
  effort?: string;
  status: TaskStatus;
  effectiveStatus?: TaskStatus;
  statusSource?: "file" | "db" | "session";
  targetBranch?: string;
  supersededBy?: string[];
  supersedes?: string[];
  relevanceReview?: string;
  blockedBy: string[];
  blocks: string[];
  dependencyCount: number;
  isTerminal: boolean;
  tags?: string[];
  successCriteriaCount?: number;
  needsVerification?: boolean;
  parseWarnings?: string[];
  backlogHygiene?: TaskBacklogHygiene;
  branchGroup?: string;
}

export interface TaskListResponse {
  tasks: TaskSummary[];
  parseErrors: DashboardParseError[];
  parseWarnings: DashboardParseWarning[];
  hygiene?: BacklogHygieneReport;
  taskCount: number;
  filteredTaskCount: number;
  lastRefreshed: string;
  stale: boolean;
  warning?: string;
  pagination?: DashboardPagination;
}

export interface TaskStatusUpdateRequest {
  status: TaskStatus;
}

export interface TaskStatusUpdateResponse {
  ok: true;
  taskId: string;
  status: TaskStatus;
}

// ─── Sessions ──────────────────────────────────────────────────────

export interface MonitorSessionSummary {
  sessionId: string;
  taskId: string;
  title?: string | null;
  status: "active" | "completed" | "error";
  outcome?: string | null;
  startTime: string;
  totalCostUsd?: number | null;
  durationMs?: number | null;
  turnsUsed?: number | null;
}

export interface SessionListResponse {
  sessions: MonitorSessionSummary[];
  pagination: DashboardPagination;
}

export type LegacySessionListResponse = MonitorSessionSummary[];

export type TaskRunsResponse = MonitorSessionSummary[];

// ─── Costs ─────────────────────────────────────────────────────────

export interface CostSummaryByTaskRow {
  taskId: string;
  costUsd: number;
  outcome?: string | null;
  date?: string | null;
  durationMs?: number | null;
  turnsUsed?: number | null;
}

export interface CostSummary {
  totalCostUsd: number;
  sessionCount: number;
  avgCostPerSession: number;
  todayCostUsd: number;
  hourlyCostUsd?: number;
  monthToDateCostUsd?: number;
  monthToDateSessionCount?: number;
  last7DaysCostUsd: number;
  last30DaysCostUsd: number;
  byDay: Array<{ date: string; costUsd: number; sessions: number }>;
  byTask: CostSummaryByTaskRow[];
  refreshedAt?: string;
}

export type CostSummaryResponse = CostSummary;

// ─── Local dispatch queue ──────────────────────────────────────────

export interface QueueItemSummary {
  taskId: string;
  status: string;
  priority?: string;
  priorityWeight?: number;
  enqueuedAt?: string;
  startedAt?: string;
  completedAt?: string;
  blockedBy?: string[];
  blockedReason?: string;
  error?: string;
  lastError?: string;
  outcome?: string;
  costUsd?: number;
  durationMs?: number;
  retryCount?: number;
}

export type QueueState = "idle" | "waiting" | "running" | "paused" | "stopped" | "done";

export interface QueueConfigSummary {
  maxConcurrent: number;
  cooldownBetweenTasksMs: number;
  failurePropagation: "fail_fast" | "skip_dependents" | "continue_all";
  fleetBudgetUsd: number;
  pauseOnFailure: boolean;
  persistState: boolean;
  autoStartOnEnqueue: boolean;
}

export interface QueueStatsSummary {
  total: number;
  queued: number;
  ready: number;
  running: number;
  completed: number;
  failed: number;
  blocked: number;
  skipped: number;
  stopped: number;
  totalCostUsd: number;
  totalDurationMs: number;
  startedAt?: string;
  completedAt?: string;
}

export interface QueueSummaryResponse {
  state: QueueState;
  running: boolean;
  paused: boolean;
  pauseReason?: string;
  items: QueueItemSummary[];
  activeTaskIds: string[];
  activeTaskId?: string;
  maxConcurrent?: number;
  config: QueueConfigSummary;
  stats: QueueStatsSummary;
}

// ─── Federation ────────────────────────────────────────────────────

export interface FederationListenerSummary {
  hostId: string;
  status: string;
  lastHeartbeatAt?: string;
  maxConcurrent?: number;
  activeJobs?: number;
  capabilities?: string[];
}

export interface FederationHostSummary {
  id: string;
  alias?: string;
  baseUrl?: string;
  enabled: boolean;
  healthy: boolean;
  currentLoad: number;
  maxConcurrentJobs: number;
  capabilities: string[];
  repoCommit?: string;
  runtimeRole?: "headnode" | "worker";
  protocolVersion?: string;
  lastCommand?: {
    kind: "git_pull" | "refresh_project" | "worker.refresh" | "probe_capabilities" | "collect_diagnostics" | "sync_wiki";
    status: "accepted" | "running" | "completed" | "failed" | "retryable" | "non_retryable";
    completedAt?: string;
    durationMs?: number;
    errorCategory?: "transport" | "auth" | "tool_missing" | "bad_payload" | "project_not_found" | "platform_mismatch" | "execution_failed" | "not_supported" | "unknown";
    message?: string;
    metadata?: Record<string, unknown>;
  };
  lastHealthCheckAt?: string;
  metadata?: Record<string, unknown>;
}

export interface FederationJobSummary {
  jobId: string;
  taskId: string;
  status: string;
  nextAction?: string;
  hostId?: string;
  preferredHostId?: string;
  assignedHostId?: string;
  leaseExpiresAt?: string;
  createdAt?: string;
  updatedAt?: string;
  evidenceCount?: number;
}

export interface FederationQueueSummary {
  total: number;
  byStatus: Record<string, number>;
  mergeLaneActive: boolean;
  mergeLock?: Record<string, unknown>;
  activeDispatchJobs: number;
  activeDispatchByHost: Record<string, number>;
  hosts: FederationHostSummary[];
}

export interface FederationQueueResponse {
  ok?: boolean;
  jobs: FederationJobSummary[];
  listeners?: FederationListenerSummary[];
  summary?: FederationQueueSummary;
  pagination?: DashboardPagination;
}

// ─── Workflow / Reviews ────────────────────────────────────────────

export type WorkflowState =
  | "assigned"
  | "executing"
  | "verify_fix"
  | "reviewing"
  | "merged"
  | "failed"
  | "rejected"
  | "blocked"
  | "canceled";

export interface WorkflowStateResponse {
  taskId: string;
  state: WorkflowState;
  refreshedAt?: string;
}

export interface ReviewSummary {
  reviewId: string;
  taskId: string;
  verdict: string;
  createdAt: string;
  updatedAt?: string;
  reviewer?: string;
  needsHumanReview?: boolean;
  mergeReady?: boolean;
  docsImpact?: string;
  summary?: string;
}

export interface ReviewListResponse {
  reviews: ReviewSummary[];
  pagination?: DashboardPagination;
}

export interface ReviewDetailResponse {
  ok: true;
  reviewId: string;
  reviewPath?: string;
  review: Record<string, unknown>;
}

// ─── Testing ───────────────────────────────────────────────────────

export interface TestingCommandSummary {
  name: string;
  command: string;
  required?: boolean;
  timeout?: number;
  source?: string;
}

export interface TestingCommandsResponse {
  commands: TestingCommandSummary[];
  projectId?: string;
}

export interface TestingStatusResponse {
  running: boolean;
  name: string;
  command: string;
}

export interface TestingRunSummary {
  id: string;
  name: string;
  command: string;
  status: string;
  exitCode?: number | null;
  startedAt: string;
  finishedAt?: string;
  durationMs?: number | null;
}

export interface TestingHistoryResponse {
  runs: TestingRunSummary[];
  pagination?: DashboardPagination;
}

export interface DashboardAuthStatusResponse {
  authEnabled: boolean;
  authenticated?: boolean;
  username?: string;
  role?: string;
  expiresAt?: number;
}

export interface DashboardLoginResponse {
  username: string;
  role: string;
  expiresAt: number;
}

// ─── Projects / Settings ───────────────────────────────────────────

export type DeploymentMonitorSource = "configured" | "default";
export type DeploymentProbeKind = "json" | "html" | "text";

export interface DeploymentMonitorLink {
  label: string;
  url: string;
  description?: string;
}

export interface DeploymentMonitorDescriptor {
  id: string;
  label: string;
  service?: string;
  environment: string;
  provider: string;
  region?: string;
  appUrl?: string;
  healthUrl: string;
  notes?: string;
  tags: string[];
  links: DeploymentMonitorLink[];
  enabled: boolean;
  source: DeploymentMonitorSource;
}

export interface DeploymentMonitorComponentDescriptor {
  id: string;
  label: string;
  url: string;
  probe: DeploymentProbeKind;
  category: string;
  notes?: string;
  tags: string[];
  enabled: boolean;
}

export interface DeploymentProbeResult {
  ok: boolean;
  checkedAt: string;
  statusCode?: number;
  statusText?: string;
  latencyMs?: number;
  contentType?: string;
  finalUrl?: string;
  bodyPreview?: string;
  payload?: unknown;
  error?: string;
}

export interface DeploymentMonitorComponentStatus {
  component: DeploymentMonitorComponentDescriptor;
  state: "healthy" | "offline" | "disabled";
  probe: DeploymentProbeResult;
}

export interface DeploymentMonitorRollup {
  totalChecks: number;
  healthyChecks: number;
  failingChecks: number;
  disabledChecks: number;
}

export interface DeploymentMonitorIdentity {
  status?: string;
  version?: string;
  commit?: string;
  uptimeSeconds?: number;
  reportedAt?: string;
}

export interface DeploymentMonitorAwsAlarmStatus {
  name: string;
  label: string;
  state: "ok" | "alarm" | "insufficient_data" | "missing";
  namespace?: string;
  metricName?: string;
  reason?: string;
  updatedAt?: string;
}

export interface DeploymentMonitorAwsHealthCheckStatus {
  id: string;
  label: string;
  path?: string;
  state: "healthy" | "unhealthy" | "unknown" | "missing";
  healthyRegions: number;
  totalRegions: number;
  lastCheckedAt?: string;
  detail?: string;
}

export interface DeploymentMonitorAwsLogGroupStatus {
  name: string;
  label: string;
  state: "fresh" | "stale" | "empty" | "missing";
  lastEventAt?: string;
  ageMinutes?: number;
  storedBytes?: number;
  retentionInDays?: number;
  freshnessMinutes: number;
}

export interface DeploymentMonitorAwsTopicStatus {
  arn: string;
  label: string;
  state: "wired" | "unwired" | "missing";
  subscriptions: number;
  confirmedSubscriptions: number;
  pendingSubscriptions: number;
}

export interface DeploymentMonitorAwsExpectedMetricStatus {
  namespace: string;
  metricName: string;
  label: string;
  state: "present" | "missing";
  discoveredMetrics: number;
}

export interface DeploymentMonitorAwsBudgetStatus {
  name: string;
  label: string;
  state: "ok" | "alerting" | "missing";
  actualAmount?: number;
  limitAmount?: number;
  unit?: string;
  timeUnit?: string;
}

export interface DeploymentMonitorAwsDashboardStatus {
  name: string;
  label: string;
  state: "present" | "missing";
  lastModified?: string;
}

export interface DeploymentMonitorAwsSummary {
  totalResources: number;
  issueCount: number;
  alertingAlarms: number;
  insufficientDataAlarms: number;
  unhealthyHealthChecks: number;
  staleLogGroups: number;
  unwiredTopics: number;
  missingMetrics: number;
  budgetAlerts: number;
  missingResources: number;
}

export interface DeploymentMonitorAwsStatus {
  accountId?: string;
  region: string;
  checkedAt: string;
  state: "healthy" | "degraded" | "unavailable";
  summary: DeploymentMonitorAwsSummary;
  warnings: string[];
  error?: string;
  alarms: DeploymentMonitorAwsAlarmStatus[];
  healthChecks: DeploymentMonitorAwsHealthCheckStatus[];
  logGroups: DeploymentMonitorAwsLogGroupStatus[];
  topics: DeploymentMonitorAwsTopicStatus[];
  expectedMetrics: DeploymentMonitorAwsExpectedMetricStatus[];
  budgets: DeploymentMonitorAwsBudgetStatus[];
  dashboards: DeploymentMonitorAwsDashboardStatus[];
}

export interface DeploymentMonitorStatus {
  monitor: DeploymentMonitorDescriptor;
  state: "healthy" | "degraded" | "offline" | "disabled";
  health: DeploymentProbeResult;
  app?: DeploymentProbeResult | null;
  components: DeploymentMonitorComponentStatus[];
  rollup: DeploymentMonitorRollup;
  identity?: DeploymentMonitorIdentity;
  aws?: DeploymentMonitorAwsStatus;
}

export interface ControlPlaneMonitorDescriptor {
  id: string;
  label: string;
  kind: "headnode-monitor" | "operator-sidecar" | "local-monitor" | "listener" | "custom";
  url: string;
  probe: DeploymentProbeKind;
  notes?: string;
  tags: string[];
  enabled: boolean;
}

export interface ControlPlaneProbeStatus {
  descriptor: ControlPlaneMonitorDescriptor;
  state: "healthy" | "offline" | "disabled";
  probe: DeploymentProbeResult;
}

export interface ControlPlaneMonitoringStatus {
  summary: DeploymentMonitorRollup;
  probes: ControlPlaneProbeStatus[];
}

export interface DeploymentMonitoringResponse {
  defaulted: boolean;
  checkedAt: string;
  environments: DeploymentMonitorStatus[];
  controlPlane: ControlPlaneMonitoringStatus;
}

export interface ProjectSummary {
  id: string;
  name: string;
  path: string;
  active?: boolean;
  adapterName?: string;
  runtimeRole?: "headnode" | "worker";
  stateAuthority?: "canonical" | "cache" | "localSmokeOnly";
  canonicalBaseUrl?: string | null;
  localDbAuthoritative?: boolean;
}

export interface ProjectsResponse {
  projects: ProjectSummary[];
  activeProjectId?: string | null;
}

export interface WikiGitChange {
  path: string;
  status: string;
}

export interface WikiGitStatus {
  available: boolean;
  branch: string | null;
  upstream: string | null;
  headSha: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: WikiGitChange[];
}

export type WikiRootSource = "configured" | "env" | "detected" | "missing";

export interface WikiStatusResponse {
  available: boolean;
  root: string | null;
  source: WikiRootSource;
  checkedPaths: string[];
  topLevelEntries: string[];
  git: WikiGitStatus;
}

export interface WikiIndexEntry {
  path: string;
  section: string;
  title: string;
  summary: string;
  modifiedAt: string;
  sizeBytes: number;
  taskIds: string[];
}

export interface WikiIndexResponse {
  root: string;
  count: number;
  entries: WikiIndexEntry[];
}

export interface WikiTreeEntry {
  path: string;
  name: string;
  kind: "file" | "dir";
  sizeBytes: number | null;
  modifiedAt: string | null;
}

export interface WikiTreeResponse {
  root: string;
  path: string;
  entries: WikiTreeEntry[];
}

export interface WikiLinkRef {
  raw: string;
  target: string;
  label: string;
  resolvedPath: string | null;
}

export interface WikiPageResponse {
  root: string;
  path: string;
  title: string;
  summary: string;
  frontmatter: Record<string, string | string[]>;
  content: string;
  body: string;
  modifiedAt: string;
  sizeBytes: number;
  sha256: string;
  taskIds: string[];
  links: WikiLinkRef[];
}

export interface WikiSearchResult {
  path: string;
  title: string;
  summary: string;
  snippet: string;
  modifiedAt: string;
  score: number;
  taskIds: string[];
}

export interface WikiSearchResponse {
  query: string;
  count: number;
  results: WikiSearchResult[];
}

export interface WikiWriteResponse {
  ok: true;
  path: string;
  created: boolean;
  appended: boolean;
  modifiedAt: string;
  sizeBytes: number;
  sha256: string;
}

export interface WikiArtifactResponse extends WikiWriteResponse {
  artifactType: "changelog" | "bug-report";
  reviewArtifact?: {
    pagePath: string;
    linkedTaskIds: string[];
    action: "changelog_entry";
  };
}

export interface WikiGitActionResponse {
  ok: true;
  stdout: string;
  stderr: string;
  git: WikiGitStatus;
}

export interface FleetStatusResponse {
  state: "running" | "paused" | "emergency_stopped";
  activeJobs: number;
  reason?: string;
}

export interface FleetVelocitySnapshot {
  taskId: string;
  currentCostUsd: number;
  elapsedMinutes: number;
  costPerMinute: number;
  medianCostPerMinute: number;
  multiplier: number;
  status: "normal" | "warning" | "critical";
}

export interface FleetVelocityResponse {
  config: {
    enabled: boolean;
    windowMinutes: number;
    warnMultiplier: number;
    killMultiplier: number;
    minSamplesForBaseline: number;
  };
  baseline: {
    medianCostPerMinute: number;
    sampleCount: number;
  } | null;
  activeSnapshots: FleetVelocitySnapshot[];
}

export interface FleetHealthAgent {
  taskId: string;
  status: "healthy" | "slow" | "warning" | "critical" | "stuck";
  lastActivity: {
    type: string;
    detail: string;
    timestamp: string;
  } | null;
  silentMs: number;
  turnCount: number;
  toolUseCount: number;
  cumulativeCostUsd: number;
  startedAt: string;
  inLlmResponse: boolean;
}

export interface FleetHealthResponse {
  config: {
    enabled: boolean;
    warningMinutes: number;
    criticalMinutes: number;
    killMinutes: number;
    checkIntervalSeconds: number;
    fileHeartbeat: boolean;
  };
  agents: FleetHealthAgent[];
}

export interface CcusageModelBreakdown {
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  cost: number;
}

export interface CcusageDailyEntry {
  date: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalTokens: number;
  totalCost: number;
  modelBreakdowns?: CcusageModelBreakdown[];
}

export interface CcusageTotals {
  inputTokens: number;
  outputTokens: number;
  cacheCreationTokens: number;
  cacheReadTokens: number;
  totalCost: number;
  totalTokens: number;
}

export interface CcusageResponse {
  daily: CcusageDailyEntry[];
  totals: CcusageTotals;
  lastRefreshedAt?: string;
  lastFetchedDate?: string;
  loading?: boolean;
  stale?: boolean;
  refreshing?: boolean;
}

export type MonitorUiMode = "modern" | "legacy" | "headless";

// ─── Health ────────────────────────────────────────────────────────

export interface HealthDbIssue {
  projectId: string;
  projectName: string;
  dbPath?: string;
  error: string;
}

export interface HealthSessionRecoveryProjectSummary {
  projectId: string;
  projectName: string;
  cleaned: number;
  recoveredTaskIds: string[];
  reasons: Record<string, number>;
}

export interface HealthSessionRecoverySummary {
  lastRunAt: string;
  totalCleaned: number;
  projects: HealthSessionRecoveryProjectSummary[];
}

export interface ManagedWorktreeSummary {
  taskId: string;
  path: string;
  exists: boolean;
  registered: boolean;
  branchName?: string;
  lastModifiedAt?: string;
  ageMs: number;
  jobStatus?: "running" | "completed" | "failed" | "stopped" | "awaiting_approval";
  activeJob: boolean;
  dirty: boolean;
  evidenceFiles: string[];
  pruneEligible: boolean;
  skipReasons: string[];
}

export interface ManagedWorktreeInventorySummary {
  scanned: number;
  pruneEligible: number;
  active: number;
  dirty: number;
  evidenceBearing: number;
  registered: number;
  orphaned: number;
}

export interface ManagedWorktreeInventoryResponse {
  ok: true;
  projectId: string | null;
  projectName: string | null;
  checkedAt: string;
  maxAgeMs: number;
  summary: ManagedWorktreeInventorySummary;
  records: ManagedWorktreeSummary[];
}

export interface ManagedWorktreePruneResponse {
  ok: true;
  projectId: string | null;
  projectName: string | null;
  summary: ManagedWorktreeInventorySummary;
  result: {
    checkedAt: string;
    dryRun: boolean;
    maxAgeMs: number;
    scanned: number;
    pruneEligible: number;
    candidates: ManagedWorktreeSummary[];
    pruned: string[];
    retained: ManagedWorktreeSummary[];
  };
}

export interface HealthResponse {
  status: "ok" | "degraded" | "error";
  version?: string;
  commit?: string;
  branch?: string;
  builtAt?: string;
  logDir?: string;
  projectRoot?: string | null;
  projectCount?: number;
  clients?: number;
  activeJobs?: number;
  worktreeDegraded?: boolean;
  dbDegraded?: boolean;
  dbIssues?: HealthDbIssue[];
  sessionRecovery?: HealthSessionRecoverySummary;
  runtimeRole?: "headnode" | "worker";
  stateAuthority?: "canonical" | "cache" | "localSmokeOnly";
  canonicalBaseUrl?: string | null;
  localDbAuthoritative?: boolean;
  uiMode?: MonitorUiMode;
  legacyUiPath?: string;
  timestamp?: string;
}

export interface WorkerEnrollmentManifest {
  version: "worker-enrollment-v1";
  enrollmentId: string;
  issuedAt: string;
  expiresAt: string;
  controlPlane: {
    baseUrl: string;
    runtimeRole: "headnode" | "worker";
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
    checkCommand?: {
      cmd: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
      optional?: boolean;
      description?: string;
    };
    notes?: string;
  }>;
  repos: Array<{
    id: string;
    label: string;
    sourceUrl: string;
    branch: string;
    destination: string;
    required: boolean;
  }>;
  projects: Array<{
    id: string;
    label: string;
    repoId: string;
    pathAlias: string;
    primary?: boolean;
    installCommands: Array<{
      cmd: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
      optional?: boolean;
      description?: string;
    }>;
    probeCommands: Array<{
      cmd: string;
      args: string[];
      cwd?: string;
      env?: Record<string, string>;
      optional?: boolean;
      description?: string;
    }>;
    capabilityProbes?: Array<{
      capability: string;
      description?: string;
      command: {
        cmd: string;
        args: string[];
        cwd?: string;
        env?: Record<string, string>;
        optional?: boolean;
        description?: string;
      };
    }>;
  }>;
  env: Array<{
    name: string;
    mode: "inline" | "manual";
    value?: string;
    placeholder?: string;
    description?: string;
    secretRef?: string;
  }>;
  secrets: Array<{
    id: string;
    mode: "auto" | "manual";
    envName?: string;
    sourceEnvVar?: string;
    placeholder?: string;
    description?: string;
  }>;
  manualSteps: string[];
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
  persistence: "manual" | "run-key" | "scheduled-task-logon" | "scheduled-task-startup";
}

export interface WorkerEnrollmentProgressEvent {
  id: string;
  phase: "bootstrap" | "prerequisites" | "repo_sync" | "dependency_install" | "env_write" | "capability_probe" | "runtime_start" | "runtime_health" | "listener_register" | "completed";
  state: "running" | "completed" | "failed" | "waiting";
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
  command?: {
    cmd: string;
    args: string[];
    cwd?: string;
    env?: Record<string, string>;
    optional?: boolean;
    description?: string;
  };
}

export type WorkerCapabilityTier = "base" | "project" | "browser" | "docker" | "auth" | "staging-db";

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
  status: "missing" | "current" | "behind" | "ahead" | "diverged" | "wrong_branch" | "dirty" | "unknown";
  blockers: string[];
  repairCommand?: string;
}

export interface WorkerCapabilityReadiness {
  capability: string;
  tier: WorkerCapabilityTier;
  requested: boolean;
  status: WorkerCapabilityProbeResult["status"];
  projectId?: string;
  message: string;
  command?: WorkerCapabilityProbeResult["command"];
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
  state: "pending" | "bootstrap_consumed" | "installing" | "registered" | "healthy" | "needs_follow_up" | "failed" | "expired";
  progressPercent: number;
  currentStep?: WorkerEnrollmentProgressEvent["phase"];
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
  runtimeRole?: "headnode" | "worker";
  protocolVersion?: string;
  metadata?: Record<string, unknown>;
}

export interface WorkerEnrollmentSessionView extends WorkerEnrollmentSessionSummary {
  installStatus: WorkerEnrollmentInstallStatus;
  readiness: WorkerEnrollmentReadiness;
  listener?: WorkerEnrollmentListenerStatus | null;
}

export interface WorkerEnrollmentCreateRequest {
  hostId: string;
  alias?: string;
  profileId?: string;
  projectId?: string;
  runtimePort?: number;
  maxConcurrentJobs?: number;
  capabilities?: string[];
  persistence?: "manual" | "run-key" | "scheduled-task-logon" | "scheduled-task-startup";
  ttlMinutes?: number;
  targetRootWindows?: string;
  targetRootPosix?: string;
}

export interface WorkerEnrollmentCreateResponse {
  ok: true;
  session: WorkerEnrollmentSessionView;
  bootstrapToken: string;
  installCommand: string;
  installCommandWindows: string;
  repairCommand: string;
  repairCommandWindows: string;
  targetRoots: {
    windows?: string;
    posix?: string;
  };
  manifestPreview: WorkerEnrollmentManifest;
  progressEvents: WorkerEnrollmentProgressEvent[];
  capabilityResults: WorkerCapabilityProbeResult[];
}

export interface WorkerEnrollmentProfileSummary {
  id: string;
  label: string;
  runtimePort: number;
  maxConcurrentJobs: number;
  persistence: WorkerEnrollmentManifest["worker"]["persistence"];
  capabilities: string[];
  projectIds: string[];
  defaultProjectId: string | null;
}

export interface WorkerEnrollmentProfilesResponse {
  ok: true;
  profiles: WorkerEnrollmentProfileSummary[];
}

export interface WorkerEnrollmentListResponse {
  ok: true;
  sessions: WorkerEnrollmentSessionView[];
}

export interface WorkerEnrollmentDetailResponse {
  ok: true;
  session: WorkerEnrollmentSessionView;
  manifestPreview: WorkerEnrollmentManifest;
  progressEvents: WorkerEnrollmentProgressEvent[];
  capabilityResults: WorkerCapabilityProbeResult[];
}

export interface WorkerEnrollmentBootstrapResponse {
  ok: true;
  session: WorkerEnrollmentSessionView;
  manifest: WorkerEnrollmentManifest;
  workerToken: {
    id: string;
    token: string;
    scopes: string[];
  };
}
