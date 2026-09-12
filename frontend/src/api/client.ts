// ─── Quack Monitor API Client ──────────────────────────────────────
// Thin typed wrapper over fetch. Path-relative — Vite dev proxy and the
// production deploy both serve the frontend from the same origin as the
// monitor.
//
// All methods throw on non-2xx; callers (TanStack Query) decide retry.

import type {
  CcusageResponse,
  CostSummaryResponse,
  DashboardAuthStatusResponse,
  DashboardLoginResponse,
  DeploymentMonitoringResponse,
  FleetHealthResponse,
  FleetStatusResponse,
  FleetVelocityResponse,
  FederationQueueResponse,
  HealthResponse,
  ManagedWorktreeInventoryResponse,
  ManagedWorktreePruneResponse,
  ProjectSummary,
  ProjectsResponse,
  QueueSummaryResponse,
  ReviewDetailResponse,
  ReviewListResponse,
  SessionListResponse,
  TaskListResponse,
  TaskStatus,
  WorkerEnrollmentCreateRequest,
  WorkerEnrollmentCreateResponse,
  WorkerEnrollmentDetailResponse,
  WorkerEnrollmentListResponse,
  WorkerEnrollmentProfilesResponse,
  TestingCommandsResponse,
  TestingHistoryResponse,
  TestingStatusResponse,
  WikiIndexResponse,
  WikiPageResponse,
  WikiSearchResponse,
  WikiStatusResponse,
} from "./contracts";

export class QuackApiError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly body?: unknown,
  ) {
    super(message);
    this.name = "QuackApiError";
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(init?.headers ?? {}),
    },
  });
  if (!response.ok) {
    let body: unknown;
    try {
      body = await response.json();
    } catch {
      body = await response.text();
    }
    const message =
      typeof body === "object" && body && "error" in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new QuackApiError(response.status, message, body);
  }
  if (response.status === 204) {
    return undefined as T;
  }
  return response.json() as Promise<T>;
}

// ─── Health ────────────────────────────────────────────────────────

export const getHealth = (): Promise<HealthResponse> => request("/api/health");

export const getAuthStatus = (): Promise<DashboardAuthStatusResponse> =>
  request("/api/auth/status");

export const loginDashboard = (payload: {
  username: string;
  password: string;
}): Promise<DashboardLoginResponse> =>
  request("/api/auth/login", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const logoutDashboard = (): Promise<{ ok: true }> =>
  request("/api/auth/logout", {
    method: "POST",
    body: JSON.stringify({}),
  });

export const getManagedWorktrees = (
  maxAgeHours?: number,
): Promise<ManagedWorktreeInventoryResponse> =>
  request(`/api/worktrees${buildQuery({ maxAgeHours })}`);

export const pruneManagedWorktrees = (
  payload: { dryRun?: boolean; maxAgeHours?: number } = {},
): Promise<ManagedWorktreePruneResponse> =>
  request("/api/worktrees/prune", {
    method: "POST",
    body: JSON.stringify(payload),
  });

// ─── Tasks ─────────────────────────────────────────────────────────

export interface ListTasksOptions {
  page?: number;
  perPage?: number;
  status?: string;
  excludeStatus?: string;
  q?: string;
  sort?: string;
  order?: "asc" | "desc";
}

function buildQuery(options: Record<string, string | number | undefined> | object): string {
  const entries = Object.entries(options as Record<string, unknown>)
    .filter(([, value]) => value !== undefined && value !== "")
    .map(([key, value]) => [key, String(value)] as [string, string]);
  if (entries.length === 0) return "";
  return "?" + new URLSearchParams(entries).toString();
}

export const listTasks = (options: ListTasksOptions = {}): Promise<TaskListResponse> =>
  request(`/api/tasks${buildQuery(options)}`);

export const updateTaskStatus = (
  taskId: string,
  status: TaskStatus,
): Promise<{ ok: true; taskId: string; status: TaskStatus }> =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/status`, {
    method: "POST",
    body: JSON.stringify({ status }),
  });

// ─── Sessions ──────────────────────────────────────────────────────

export interface ListSessionsOptions {
  page?: number;
  perPage?: number;
  status?: string;
  excludeStatus?: string;
  outcome?: string;
  excludeOutcome?: string;
  sort?: string;
  order?: "asc" | "desc";
}

export const listSessions = (options: ListSessionsOptions = {}): Promise<SessionListResponse> =>
  request(`/api/sessions${buildQuery({ ...options, paged: 1 })}`);

// ─── Costs ─────────────────────────────────────────────────────────

export const getCosts = (): Promise<CostSummaryResponse> => request("/api/costs");

export const getCcusage = (): Promise<CcusageResponse | null> =>
  request<CcusageResponse>("/api/ccusage").catch((error: unknown) => {
    if (error instanceof QuackApiError && error.statusCode === 404) {
      return null;
    }
    throw error;
  });

export const refreshCcusage = (): Promise<{ status: string }> =>
  request("/api/ccusage/refresh", {
    method: "POST",
    body: JSON.stringify({}),
  });

// ─── Local dispatch queue ──────────────────────────────────────────

export const getQueue = (): Promise<QueueSummaryResponse> => request("/api/queue");

// ─── Federation ────────────────────────────────────────────────────

export const getFederationQueue = (): Promise<FederationQueueResponse> =>
  request<FederationQueueResponse>("/v1/federation/queue").then((raw) => {
    const hosts = raw.summary?.hosts ?? [];
    return {
      ...raw,
      jobs: raw.jobs.map((job) => ({
        ...job,
        assignedHostId: job.assignedHostId ?? job.hostId,
      })),
      listeners:
        raw.listeners ??
        hosts.map((host) => ({
          hostId: host.id,
          status: host.healthy ? "online" : "offline",
          lastHeartbeatAt: host.lastHealthCheckAt,
          maxConcurrent: host.maxConcurrentJobs,
          activeJobs: host.currentLoad,
          capabilities: host.capabilities,
        })),
    };
  });

// ─── Reviews ───────────────────────────────────────────────────────

export const listReviews = (): Promise<ReviewListResponse> => request("/v1/reviews");

export const getReview = (reviewId: string): Promise<ReviewDetailResponse> =>
  request(`/v1/reviews/${encodeURIComponent(reviewId)}`);

// ─── Testing ───────────────────────────────────────────────────────

export const getTestingCommands = (): Promise<TestingCommandsResponse> =>
  request<TestingCommandsResponse | TestingCommandsResponse["commands"]>(
    "/api/testing/commands",
  ).then((raw) => (Array.isArray(raw) ? { commands: raw } : raw));

export const getTestingStatus = (): Promise<TestingStatusResponse> =>
  request("/api/testing/status");

export const getTestingHistory = (): Promise<TestingHistoryResponse> => {
  // Current backend returns a bare array. Wrap so TanStack Query has a
  // stable response shape for v1 of the UI.
  return request<
    | TestingHistoryResponse
    | { runs?: TestingHistoryResponse["runs"] }
    | TestingHistoryResponse["runs"]
  >("/api/testing/history").then((raw) => {
    if (Array.isArray(raw)) return { runs: raw };
    if (raw && "runs" in raw && Array.isArray(raw.runs)) return { runs: raw.runs };
    return { runs: [] };
  });
};

// ─── Projects ──────────────────────────────────────────────────────

export const listProjects = (): Promise<ProjectsResponse> =>
  request<ProjectsResponse | ProjectSummary[]>("/api/projects").then((raw) => {
    if (!Array.isArray(raw)) {
      return raw;
    }

    return {
      projects: raw,
      activeProjectId: raw.find((project) => project.active)?.id ?? null,
    };
  });

export const getDeploymentMonitoring = (): Promise<DeploymentMonitoringResponse> =>
  request("/api/monitoring/environments");

export const getWorkerEnrollmentProfiles = (): Promise<WorkerEnrollmentProfilesResponse> =>
  request("/api/workers/enrollment-profiles");

export const listWorkerEnrollments = (): Promise<WorkerEnrollmentListResponse> =>
  request("/api/workers/enrollments");

export const getWorkerEnrollment = (
  enrollmentId: string,
): Promise<WorkerEnrollmentDetailResponse> =>
  request(`/api/workers/enrollments/${encodeURIComponent(enrollmentId)}`);

export const createWorkerEnrollment = (
  payload: WorkerEnrollmentCreateRequest,
): Promise<WorkerEnrollmentCreateResponse> =>
  request("/api/workers/enrollments", {
    method: "POST",
    body: JSON.stringify(payload),
  });

export const setActiveProject = (
  projectId: string,
): Promise<{ ok: true; activeProjectId: string }> =>
  request("/api/projects/active", {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });

export const addProject = (
  projectPath: string,
): Promise<{ ok: true; projectId: string; name: string; path: string }> =>
  request("/api/projects", {
    method: "POST",
    body: JSON.stringify({ path: projectPath }),
  });

export const removeProject = (
  projectId: string,
): Promise<{ ok: true; removedProjectId: string; activeProjectId?: string | null }> =>
  request(`/api/projects/${encodeURIComponent(projectId)}`, {
    method: "DELETE",
  });

export const getWikiStatus = (): Promise<WikiStatusResponse> => request("/api/wiki/status");

export const getWikiIndex = (pathPrefix?: string): Promise<WikiIndexResponse> =>
  request(`/api/wiki/index${buildQuery({ pathPrefix })}`);

export const getWikiPage = (path: string): Promise<WikiPageResponse> =>
  request(`/api/wiki/page${buildQuery({ path })}`);

export const searchWiki = (q: string, limit = 25): Promise<WikiSearchResponse> =>
  request(`/api/wiki/search${buildQuery({ q, limit })}`);

// ─── Task mutations (TASK-879) ─────────────────────────────────────

export interface StartTaskOptions {
  skipGate?: boolean;
  model?: string;
  maxTurns?: number;
  maxBudget?: number;
}

export const startTask = (
  taskId: string,
  options: StartTaskOptions = {},
): Promise<{ ok: boolean; jobId?: string; message?: string }> =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/start`, {
    method: "POST",
    body: JSON.stringify(options),
  });

export const stopTask = (taskId: string): Promise<{ ok: boolean; message?: string }> =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/stop`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const prepTask = (taskId: string): Promise<unknown> =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/prep`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const preflightTask = (taskId: string): Promise<unknown> =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/preflight`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const getTaskRuns = (taskId: string): Promise<unknown[]> =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/runs`);

export const getTaskPrep = (taskId: string): Promise<unknown> =>
  request(`/api/tasks/${encodeURIComponent(taskId)}/prep`);

// ─── Queue mutations ───────────────────────────────────────────────

export const queueStart = (): Promise<{ ok: true }> =>
  request("/api/queue/start", { method: "POST", body: JSON.stringify({}) });

export const queuePause = (reason?: string): Promise<{ ok: true }> =>
  request("/api/queue/pause", { method: "POST", body: JSON.stringify({ reason }) });

export const queueResume = (): Promise<{ ok: true }> =>
  request("/api/queue/resume", { method: "POST", body: JSON.stringify({}) });

export const queueStop = (): Promise<{ ok: true }> =>
  request("/api/queue/stop", { method: "POST", body: JSON.stringify({}) });

export const queueAbort = (): Promise<{ ok: true }> =>
  request("/api/queue/abort", { method: "POST", body: JSON.stringify({}) });

export const queueCancel = (taskId: string): Promise<{ ok: true; message: string }> =>
  request(`/api/queue/tasks/${encodeURIComponent(taskId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const queueRetry = (taskId: string): Promise<{ ok: true; message: string }> =>
  request(`/api/queue/tasks/${encodeURIComponent(taskId)}/retry`, {
    method: "POST",
    body: JSON.stringify({}),
  });

export const queueRemove = (taskId: string): Promise<{ ok: true; message: string }> =>
  request(`/api/queue/tasks/${encodeURIComponent(taskId)}`, { method: "DELETE" });

// ─── Federation mutations ──────────────────────────────────────────

export const cancelFederationJob = (jobId: string, projectId: string): Promise<unknown> =>
  request(`/v1/federation/jobs/${encodeURIComponent(jobId)}/cancel`, {
    method: "POST",
    body: JSON.stringify({ projectId }),
  });

// ─── Testing mutations ─────────────────────────────────────────────

export const runTestingCommand = (name: string, force = false): Promise<unknown> =>
  request("/api/testing/run", {
    method: "POST",
    body: JSON.stringify({ command: name, force }),
  });

export const stopTestingCommand = (): Promise<{ ok: boolean; message?: string }> =>
  request("/api/testing/stop", { method: "POST", body: JSON.stringify({}) });

// ─── Fleet mutations ───────────────────────────────────────────────

export const fleetEmergencyStop = (reason: string): Promise<unknown> =>
  request("/api/fleet/emergency-stop", {
    method: "POST",
    body: JSON.stringify({ reason }),
  });

export const getFleetStatus = (): Promise<FleetStatusResponse> => request("/api/fleet/status");

export const fleetPause = (reason?: string): Promise<unknown> =>
  request("/api/fleet/pause", {
    method: "POST",
    body: JSON.stringify({ reason }),
  });

export const fleetResume = (): Promise<unknown> =>
  request("/api/fleet/resume", { method: "POST", body: JSON.stringify({}) });

export const getFleetVelocity = (): Promise<FleetVelocityResponse> =>
  request("/api/fleet/velocity");

export const getFleetHealth = (): Promise<FleetHealthResponse> => request("/api/fleet/health");
