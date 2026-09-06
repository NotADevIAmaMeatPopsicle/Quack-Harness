import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

import {
  createWorkerEnrollment,
  getAuthStatus,
  getFederationQueue,
  getDeploymentMonitoring,
  getHealth,
  getManagedWorktrees,
  getWorkerEnrollment,
  getWorkerEnrollmentProfiles,
  loginDashboard,
  listWorkerEnrollments,
  logoutDashboard,
  pruneManagedWorktrees,
} from "../api/client";
import type {
  ControlPlaneProbeStatus,
  DeploymentMonitorAwsAlarmStatus,
  DeploymentMonitorAwsBudgetStatus,
  DeploymentMonitorAwsHealthCheckStatus,
  DeploymentMonitorAwsLogGroupStatus,
  DeploymentMonitorAwsStatus,
  DeploymentMonitorAwsTopicStatus,
  DeploymentMonitorComponentStatus,
  DeploymentMonitorStatus,
  DeploymentProbeResult,
  FederationHostSummary,
  ManagedWorktreePruneResponse,
  WorkerCapabilityProbeResult,
  WorkerEnrollmentCreateRequest,
  WorkerEnrollmentCreateResponse,
  WorkerEnrollmentSessionView,
} from "../api/contracts";
import { PageHeader } from "../components/PageHeader";
import { toast } from "../components/Toast";
import { formatDateTime, formatDurationMs } from "../lib/format";

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumFractionDigits: 0,
});

export function MonitoringPage() {
  const queryClient = useQueryClient();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [hostId, setHostId] = useState("");
  const [alias, setAlias] = useState("");
  const [profileId, setProfileId] = useState("");
  const [projectId, setProjectId] = useState("");
  const [persistence, setPersistence] = useState<WorkerEnrollmentCreateRequest["persistence"] | "">("");
  const [capabilitiesInput, setCapabilitiesInput] = useState("");
  const [maxConcurrentJobs, setMaxConcurrentJobs] = useState("");
  const [ttlMinutes, setTtlMinutes] = useState("60");
  const [targetRootWindows, setTargetRootWindows] = useState("");
  const [targetRootPosix, setTargetRootPosix] = useState("");
  const [selectedEnrollmentId, setSelectedEnrollmentId] = useState("");
  const [enrollmentResult, setEnrollmentResult] = useState<WorkerEnrollmentCreateResponse | null>(null);
  const [worktreeActionResult, setWorktreeActionResult] = useState<ManagedWorktreePruneResponse | null>(null);
  const authStatus = useQuery({
    queryKey: ["auth-status"],
    queryFn: getAuthStatus,
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const monitoring = useQuery({
    queryKey: ["deployment-monitoring"],
    queryFn: getDeploymentMonitoring,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
  const runtimeHealth = useQuery({
    queryKey: ["monitor-health"],
    queryFn: getHealth,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });
  const authStateKnown = authStatus.isSuccess;
  const authEnabled = authStatus.data?.authEnabled ?? false;
  const isAuthenticated = authStatus.data?.authenticated === true;
  const protectedPanelsEnabled = authStateKnown && (!authEnabled || isAuthenticated);
  const needsDashboardLogin = authStateKnown && authEnabled && !isAuthenticated;
  const managedWorktrees = useQuery({
    queryKey: ["managed-worktrees"],
    queryFn: () => getManagedWorktrees(24),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    enabled: protectedPanelsEnabled,
  });
  const federation = useQuery({
    queryKey: ["federation-queue", "monitoring"],
    queryFn: getFederationQueue,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    enabled: protectedPanelsEnabled,
  });
  const workerProfiles = useQuery({
    queryKey: ["worker-enrollment-profiles"],
    queryFn: getWorkerEnrollmentProfiles,
    refetchOnWindowFocus: false,
    enabled: protectedPanelsEnabled,
  });
  const workerEnrollments = useQuery({
    queryKey: ["worker-enrollments"],
    queryFn: listWorkerEnrollments,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
    enabled: protectedPanelsEnabled,
  });
  const effectiveEnrollmentId = selectedEnrollmentId
    || enrollmentResult?.session.enrollmentId
    || workerEnrollments.data?.sessions[0]?.enrollmentId
    || "";
  const workerEnrollmentDetail = useQuery({
    queryKey: ["worker-enrollment-detail", effectiveEnrollmentId],
    queryFn: () => getWorkerEnrollment(effectiveEnrollmentId),
    refetchInterval: 5_000,
    refetchOnWindowFocus: true,
    enabled: protectedPanelsEnabled && effectiveEnrollmentId.length > 0,
  });
  const selectedProfile = useMemo(() => {
    const profiles = workerProfiles.data?.profiles ?? [];
    if (profiles.length === 0) return undefined;
    return profiles.find((profile) => profile.id === profileId) ?? profiles[0];
  }, [profileId, workerProfiles.data?.profiles]);
  const hostIdPreview = hostId.trim().length > 0
    ? hostId.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "worker-host"
    : "worker-host";
  const windowsRootPlaceholder = `C:\\Users\\<user>\\QuackWorkers\\${hostIdPreview}`;
  const posixRootPlaceholder = `$HOME/QuackWorkers/${hostIdPreview}`;
  const latestEnrollment = workerEnrollmentDetail.data
    ?? (enrollmentResult && enrollmentResult.session.enrollmentId === effectiveEnrollmentId ? enrollmentResult : null);
  const latestEnrollmentCreateResult = latestEnrollment && enrollmentResult?.session.enrollmentId === latestEnrollment.session.enrollmentId
    ? enrollmentResult
    : null;
  const loginMutation = useMutation({
    mutationFn: loginDashboard,
    onSuccess: (result) => {
      setPassword("");
      toast.success("Signed in", `${result.username} can now use protected monitoring controls.`);
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      void queryClient.invalidateQueries({ queryKey: ["managed-worktrees"] });
      void queryClient.invalidateQueries({ queryKey: ["federation-queue", "monitoring"] });
      void queryClient.invalidateQueries({ queryKey: ["worker-enrollment-profiles"] });
      void queryClient.invalidateQueries({ queryKey: ["worker-enrollments"] });
    },
    onError: (error: unknown) => {
      toast.error("Sign in failed", error instanceof Error ? error.message : String(error));
    },
  });
  const logoutMutation = useMutation({
    mutationFn: logoutDashboard,
    onSuccess: () => {
      setEnrollmentResult(null);
      setPassword("");
      toast.success("Signed out", "Protected monitoring controls were locked again.");
      void queryClient.invalidateQueries({ queryKey: ["auth-status"] });
      void queryClient.invalidateQueries({ queryKey: ["managed-worktrees"] });
      void queryClient.invalidateQueries({ queryKey: ["federation-queue", "monitoring"] });
      void queryClient.invalidateQueries({ queryKey: ["worker-enrollment-profiles"] });
      void queryClient.invalidateQueries({ queryKey: ["worker-enrollments"] });
    },
    onError: (error: unknown) => {
      toast.error("Sign out failed", error instanceof Error ? error.message : String(error));
    },
  });
  const createEnrollmentMutation = useMutation({
    mutationFn: createWorkerEnrollment,
    onSuccess: (result) => {
      setEnrollmentResult(result);
      setSelectedEnrollmentId(result.session.enrollmentId);
      toast.success("Worker enrollment created", `${result.session.hostId} is ready to bootstrap.`);
      void queryClient.invalidateQueries({ queryKey: ["worker-enrollments"] });
      void queryClient.invalidateQueries({ queryKey: ["worker-enrollment-detail", result.session.enrollmentId] });
    },
    onError: (error: unknown) => {
      toast.error("Worker enrollment failed", error instanceof Error ? error.message : String(error));
    },
  });
  const pruneWorktreesMutation = useMutation({
    mutationFn: pruneManagedWorktrees,
    onSuccess: (result) => {
      setWorktreeActionResult(result);
      toast.success(
        result.result.dryRun ? "Worktree prune preview ready" : "Managed worktrees pruned",
        result.result.dryRun
          ? `${result.result.candidates.length} candidate worktree(s) identified.`
          : `${result.result.pruned.length} worktree(s) removed.`,
      );
      void queryClient.invalidateQueries({ queryKey: ["managed-worktrees"] });
      void queryClient.invalidateQueries({ queryKey: ["monitor-health"] });
    },
    onError: (error: unknown) => {
      toast.error("Worktree cleanup failed", error instanceof Error ? error.message : String(error));
    },
  });

  const environments = monitoring.data?.environments ?? [];
  const controlPlane = monitoring.data?.controlPlane;
  const controlPlaneSummary = controlPlane?.summary;
  const healthyCount = environments.filter((entry) => entry.state === "healthy").length;
  const degradedCount = environments.filter((entry) => entry.state === "degraded").length;
  const offlineCount = environments.filter((entry) => entry.state === "offline").length;
  const totalChecks = environments.reduce((sum, entry) => sum + entry.rollup.totalChecks, 0);
  const failingChecks = environments.reduce((sum, entry) => sum + entry.rollup.failingChecks, 0);
  const awsIssueCount = environments.reduce(
    (sum, entry) => sum + (entry.aws?.summary.issueCount ?? 0),
    0,
  );
  const signalGapCount = environments.reduce(
    (sum, entry) =>
      sum
      + (entry.aws?.summary.unwiredTopics ?? 0)
      + (entry.aws?.summary.missingMetrics ?? 0),
    0,
  );
  const hosts = [...(federation.data?.summary?.hosts ?? [])].sort((a, b) =>
    (a.alias || a.id).localeCompare(b.alias || b.id),
  );
  const protocolMismatchCount = hosts.filter((host) => host.protocolVersion !== "worker-command-v1").length;
  const workerCommandIssueCount = hosts.filter(hasWorkerCommandIssue).length;
  const worktreeCandidates = worktreeActionResult?.result.candidates
    ?? managedWorktrees.data?.records.filter((record) => record.pruneEligible)
    ?? [];
  const sessionRecoveryProjects = runtimeHealth.data?.sessionRecovery?.projects ?? [];
  const managedWorktreesMetric = protectedPanelsEnabled
    ? `${managedWorktrees.data?.summary.pruneEligible ?? 0}/${managedWorktrees.data?.summary.scanned ?? 0}`
    : (authStateKnown ? "locked" : "...");
  const managedWorktreesDetail = protectedPanelsEnabled
    ? "prune-eligible / scanned"
    : (needsDashboardLogin
      ? "Sign in below to inspect and prune managed worktrees"
      : "Checking operator access");
  const protocolDriftMetric = protectedPanelsEnabled
    ? (federation.isError ? "n/a" : String(protocolMismatchCount))
    : (authStateKnown ? "locked" : "...");
  const protocolDriftDetail = protectedPanelsEnabled
    ? (federation.isError
      ? "Listener ledger is not exposed to this browser session on Headnode"
      : "workers not on worker-command-v1")
    : (needsDashboardLogin
      ? "Sign in below to inspect worker protocol drift"
      : "Checking operator access");
  const workerCommandIssueMetric = protectedPanelsEnabled
    ? (federation.isError ? "n/a" : String(workerCommandIssueCount))
    : (authStateKnown ? "locked" : "...");
  const workerCommandIssueDetail = protectedPanelsEnabled
    ? (federation.isError
      ? "Use the operator/API path for full listener command telemetry"
      : "retryable or failed worker commands")
    : (needsDashboardLogin
      ? "Sign in below to inspect protected worker telemetry"
      : "Checking operator access");

  return (
    <section className="page page-monitoring">
      <PageHeader
        title="Monitoring"
        subtitle="Runtime reachability plus AWS observability for the Example staging and production surfaces we have already built out."
      >
        {monitoring.data?.defaulted ? (
          <span className="pill pill-IN_PROGRESS">built-in AWS profile</span>
        ) : (
          <span className="pill pill-success">configured environments</span>
        )}
      </PageHeader>

      {monitoring.isLoading ? <p className="page-state">Loading deployment monitors...</p> : null}
      {monitoring.isError ? (
        <p className="page-state error">
          {monitoring.error instanceof Error
            ? monitoring.error.message
            : "Failed to load deployment monitoring."}
        </p>
      ) : null}
      {authStatus.isLoading ? <p className="page-state">Checking operator access...</p> : null}
      {authStatus.isError ? (
        <p className="page-state error">
          {authStatus.error instanceof Error
            ? authStatus.error.message
            : "Failed to determine dashboard authentication state."}
        </p>
      ) : null}
      {needsDashboardLogin ? (
        <section className="card card-section">
          <div className="card-header">
            <div>
              <h2>Operator Sign-In</h2>
              <p className="muted">
                Public deployment status is visible without a session. Sign in here to unlock worker enrollment, worktree cleanup, and other protected operator controls.
              </p>
            </div>
            <div className="overview-section-badges">
              <span className="pill pill-BLOCKED">sign in required</span>
            </div>
          </div>
          <form
            className="form-inline"
            onSubmit={(event) => {
              event.preventDefault();
              if (!username.trim() || !password) {
                toast.error("Username and password required", "Enter your dashboard credentials to unlock protected controls.");
                return;
              }
              loginMutation.mutate({
                username: username.trim(),
                password,
              });
            }}
          >
            <input
              type="text"
              className="input"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              placeholder="Username"
              autoComplete="username"
            />
            <input
              type="password"
              className="input"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              autoComplete="current-password"
            />
            <button type="submit" className="btn" disabled={loginMutation.isPending}>
              {loginMutation.isPending ? "Signing In..." : "Sign In"}
            </button>
            <a className="btn btn-secondary" href="/legacy">
              Legacy Login
            </a>
          </form>
        </section>
      ) : null}
      {authStateKnown && authEnabled && isAuthenticated ? (
        <section className="card">
          <div className="card-header">
            <div>
              <h2>Operator Session</h2>
              <p className="muted">
                Signed in as {authStatus.data?.username ?? "operator"}. Protected monitoring controls are unlocked on this browser session.
              </p>
            </div>
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => logoutMutation.mutate()}
              disabled={logoutMutation.isPending}
            >
              {logoutMutation.isPending ? "Signing Out..." : "Sign Out"}
            </button>
          </div>
        </section>
      ) : null}

      {monitoring.data && (
        <>
          <section className="card">
            <div className="metrics-grid">
              <MetricCard
                label="Tracked environments"
                value={String(environments.length)}
                detail={
                  monitoring.data.defaulted
                    ? "using built-in AWS staging + production profile"
                    : "from ~/.quack/config.json"
                }
              />
              <MetricCard
                label="Runtime healthy"
                value={String(healthyCount)}
                detail={`${totalChecks - failingChecks}/${totalChecks} runtime checks passing`}
              />
              <MetricCard
                label="Runtime incidents"
                value={String(degradedCount + offlineCount)}
                detail={`degraded ${degradedCount} | offline ${offlineCount}`}
              />
              <MetricCard
                label="Control plane"
                value={
                  controlPlaneSummary
                    ? `${controlPlaneSummary.healthyChecks}/${controlPlaneSummary.totalChecks}`
                    : "0/0"
                }
                detail={
                  controlPlaneSummary
                    ? `${controlPlaneSummary.failingChecks} failing | ${controlPlaneSummary.disabledChecks} disabled`
                    : "no control-plane probes configured"
                }
              />
              <MetricCard
                label="AWS issues"
                value={String(awsIssueCount)}
                detail="alarms, stale logs, missing resources, or CLI access warnings"
              />
              <MetricCard
                label="Signal gaps"
                value={String(signalGapCount)}
                detail="alert topics without subscribers or custom metrics with no data"
              />
            </div>
          </section>

          <section className="card card-section">
            <div className="card-header">
              <div>
                <h2>Control-Plane Reachability</h2>
                <p className="muted">
                  Headnode, operator sidecar, listener, and local monitor probes configured outside deployed app health.
                </p>
              </div>
              <div className="overview-section-badges">
                <span className={`pill ${controlPlanePillClass(controlPlaneSummary)}`}>
                  {controlPlaneSummary
                    ? `${controlPlaneSummary.healthyChecks}/${controlPlaneSummary.totalChecks} reachable`
                    : "not configured"}
                </span>
              </div>
            </div>
            {controlPlane?.probes.length ? (
              <div className="monitoring-check-grid">
                {controlPlane.probes.map((probe) => (
                  <ControlPlaneProbeCard key={probe.descriptor.id} probe={probe} />
                ))}
              </div>
            ) : (
              <p className="empty-state">
                No control-plane monitors are configured yet. Add `controlPlaneMonitors` to
                `~/.quack/config.json` to probe Headnode, the operator sidecar, local
                monitors, or listener endpoints.
              </p>
            )}
          </section>

          <section className="card card-section">
            <div className="card-header">
              <div>
                <h2>Headnode Hygiene</h2>
                <p className="muted">
                  Local control-plane health, session recovery, conservative worktree cleanup, and worker protocol drift from Headnode&apos;s point of view.
                </p>
              </div>
              <div className="overview-section-badges">
                <span className={`pill ${runtimeHealth.data?.status === "degraded" ? "pill-BLOCKED" : "pill-success"}`}>
                  {runtimeHealth.data?.status ?? "loading"}
                </span>
                <span className="overview-section-badge">
                  workers {hosts.length}
                </span>
              </div>
            </div>

            <div className="metrics-grid">
              <MetricCard
                label="DB backing"
                value={runtimeHealth.data?.dbDegraded ? "degraded" : "healthy"}
                detail={runtimeHealth.data?.dbIssues?.[0]?.error ?? "SQLite state is writable"}
              />
              <MetricCard
                label="Session recovery"
                value={String(runtimeHealth.data?.sessionRecovery?.totalCleaned ?? 0)}
                detail={runtimeHealth.data?.sessionRecovery?.lastRunAt
                  ? `last sweep ${formatDateTime(runtimeHealth.data.sessionRecovery.lastRunAt)}`
                  : "no recovery sweep data yet"}
              />
              <MetricCard
                label="Managed worktrees"
                value={managedWorktreesMetric}
                detail={managedWorktreesDetail}
              />
              <MetricCard
                label="Protocol drift"
                value={protocolDriftMetric}
                detail={protocolDriftDetail}
              />
              <MetricCard
                label="Recent command issues"
                value={workerCommandIssueMetric}
                detail={workerCommandIssueDetail}
              />
            </div>

            <div className="monitoring-hygiene-grid">
              <section className="monitoring-hygiene-panel">
                <div className="monitoring-section-title">Managed worktree cleanup</div>
                <p className="muted">
                  The prune path skips active, dirty, evidence-bearing, fresh, or unpushed worktrees by default.
                </p>
                {!authStateKnown ? <p className="muted">Checking operator access...</p> : null}
                {needsDashboardLogin ? (
                  <ProtectedPanelNotice message="Sign in above to inspect and prune managed worktrees from the Headnode headnode." />
                ) : null}
                {protectedPanelsEnabled ? (
                  <>
                    {managedWorktrees.isLoading ? <p className="muted">Scanning managed worktrees...</p> : null}
                    {managedWorktrees.isError ? (
                      <p className="page-state error">
                        {managedWorktrees.error instanceof Error
                          ? managedWorktrees.error.message
                          : "Failed to load managed worktrees."}
                      </p>
                    ) : null}
                    <div className="monitoring-hygiene-actions">
                      <button
                        type="button"
                        className="btn"
                        disabled={pruneWorktreesMutation.isPending}
                        onClick={() => {
                          pruneWorktreesMutation.mutate({ dryRun: true, maxAgeHours: 24 });
                        }}
                      >
                        {pruneWorktreesMutation.isPending ? "Working..." : "Dry Run Prune"}
                      </button>
                      <button
                        type="button"
                        className="btn btn-danger"
                        disabled={pruneWorktreesMutation.isPending || (managedWorktrees.data?.summary.pruneEligible ?? 0) === 0}
                        onClick={() => {
                          pruneWorktreesMutation.mutate({ dryRun: false, maxAgeHours: 24 });
                        }}
                      >
                        Apply Prune
                      </button>
                    </div>
                    {worktreeActionResult ? (
                      <div className="monitoring-hygiene-banner">
                        {worktreeActionResult.result.dryRun
                          ? `${worktreeActionResult.result.candidates.length} candidate worktree(s) would be removed.`
                          : `${worktreeActionResult.result.pruned.length} worktree(s) removed at ${formatDateTime(worktreeActionResult.result.checkedAt)}.`}
                      </div>
                    ) : null}
                    <div className="monitoring-mini-list">
                      {worktreeCandidates.slice(0, 8).map((record) => (
                        <div key={record.path} className="monitoring-mini-row">
                          <div>
                            <div className="mono">{record.taskId}</div>
                            <div className="muted">
                              {record.branchName ?? "detached"} | {record.lastModifiedAt ? formatDateTime(record.lastModifiedAt) : "mtime unavailable"}
                            </div>
                          </div>
                          <div className="monitoring-mini-row-meta">
                            <span className={`pill ${record.pruneEligible ? "pill-success" : "pill-IN_PROGRESS"}`}>
                              {record.pruneEligible ? "eligible" : "retained"}
                            </span>
                            {!record.pruneEligible && record.skipReasons.length > 0 ? (
                              <span className="badge">{record.skipReasons[0]}</span>
                            ) : null}
                          </div>
                        </div>
                      ))}
                      {worktreeCandidates.length === 0 ? (
                        <div className="empty-state">No clear orphaned worktrees are eligible for pruning right now.</div>
                      ) : null}
                    </div>
                  </>
                ) : null}
              </section>

              <section className="monitoring-hygiene-panel">
                <div className="monitoring-section-title">Worker protocol health</div>
                <p className="muted">
                  Typed worker commands are the normal path now; SSH and WSL wrappers are break-glass only.
                </p>
                {!authStateKnown ? <p className="muted">Checking operator access...</p> : null}
                {needsDashboardLogin ? (
                  <ProtectedPanelNotice message="Sign in above to inspect protected worker protocol telemetry and listener health." />
                ) : null}
                {protectedPanelsEnabled ? (
                  federation.isError ? (
                    <ProtectedPanelNotice message="Listener command telemetry is not exposed to browser sessions on this headnode yet. Use the operator/API path for the full worker ledger." />
                  ) : (
                    <div className="monitoring-mini-list">
                      {hosts.map((host) => {
                        const refreshDrift = summarizeWorkerRefreshDrift(host.lastCommand?.metadata);
                        return (
                          <div key={host.id} className="monitoring-mini-row">
                            <div>
                              <div>{host.alias || host.id}</div>
                              <div className="muted">
                                {host.runtimeRole ?? "unknown"} | {host.protocolVersion ?? "legacy"} | load {host.currentLoad ?? 0}/{host.maxConcurrentJobs ?? 1}
                              </div>
                              {refreshDrift ? (
                                <div className="muted">{refreshDrift}</div>
                              ) : null}
                            </div>
                            <div className="monitoring-mini-row-meta">
                              <span className={`pill ${host.healthy ? "pill-success" : "pill-REJECTED"}`}>
                                {host.healthy ? "healthy" : "offline"}
                              </span>
                              {host.lastCommand ? (
                                <span className={`badge ${hasWorkerCommandIssue(host) ? "badge-warn" : ""}`}>
                                  {host.lastCommand.kind} {host.lastCommand.status}
                                </span>
                              ) : null}
                            </div>
                          </div>
                        );
                      })}
                      {hosts.length === 0 ? (
                        <div className="empty-state">No worker hosts are currently registered.</div>
                      ) : null}
                    </div>
                  )
                ) : null}
              </section>

              <section className="monitoring-hygiene-panel">
                <div className="monitoring-section-title">Session recovery evidence</div>
                <p className="muted">
                  Automatic reconciliation turns stale `IN_PROGRESS` rows back into trustworthy task state.
                </p>
                <div className="monitoring-mini-list">
                  {sessionRecoveryProjects.map((project) => (
                    <div key={project.projectId} className="monitoring-mini-row">
                      <div>
                        <div>{project.projectName}</div>
                        <div className="muted">
                          cleaned {project.cleaned} | reasons {Object.keys(project.reasons).length}
                        </div>
                      </div>
                      <div className="monitoring-mini-row-meta">
                        {project.recoveredTaskIds.slice(0, 2).map((taskId) => (
                          <span key={taskId} className="badge mono">{taskId}</span>
                        ))}
                      </div>
                    </div>
                  ))}
                  {sessionRecoveryProjects.length === 0 ? (
                    <div className="empty-state">No session recovery sweeps have reported project data yet.</div>
                  ) : null}
                </div>
              </section>
            </div>
          </section>

          <section className="card card-section">
            <div className="card-header">
              <div>
                <h2>Worker Enrollment</h2>
                <p className="muted">
                  Generate one-time worker bootstrap commands from Headnode so new Tailscale contributors can come up as headless workers instead of secondary UI hosts.
                </p>
              </div>
              <div className="overview-section-badges">
                <span className="overview-section-badge">
                  profiles {workerProfiles.data?.profiles.length ?? 0}
                </span>
                <span className="overview-section-badge">
                  pending {workerEnrollments.data?.sessions.filter((session) => session.installStatus.state !== "healthy" && session.status !== "expired").length ?? 0}
                </span>
              </div>
            </div>

            <div className="worker-enrollment-grid">
              {!authStateKnown ? <p className="muted">Checking operator access...</p> : null}
              {needsDashboardLogin ? (
                <ProtectedPanelNotice message="Sign in above to generate one-time bootstrap tokens and install commands for new worker hosts." />
              ) : null}
              {protectedPanelsEnabled ? (
                <>
                  <form
                    className="worker-enrollment-form"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (!hostId.trim()) {
                        toast.error("Host ID required", "Choose a stable host ID before creating an enrollment.");
                        return;
                      }
                      const parsedMaxConcurrent = maxConcurrentJobs.trim().length > 0
                        ? Number.parseInt(maxConcurrentJobs, 10)
                        : undefined;
                      if (parsedMaxConcurrent !== undefined && (!Number.isInteger(parsedMaxConcurrent) || parsedMaxConcurrent < 1 || parsedMaxConcurrent > 16)) {
                        toast.error("Invalid concurrency", "Max concurrent jobs must be an integer between 1 and 16.");
                        return;
                      }
                      const parsedTtlMinutes = ttlMinutes.trim().length > 0
                        ? Number.parseInt(ttlMinutes, 10)
                        : undefined;
                      if (parsedTtlMinutes !== undefined && (!Number.isInteger(parsedTtlMinutes) || parsedTtlMinutes < 1 || parsedTtlMinutes > 1440)) {
                        toast.error("Invalid TTL", "TTL must be an integer between 1 and 1440 minutes.");
                        return;
                      }
                      const requestedCapabilities = capabilitiesInput
                        .split(",")
                        .map((entry) => entry.trim())
                        .filter(Boolean);
                      createEnrollmentMutation.mutate({
                        hostId: hostId.trim(),
                        alias: alias.trim() || undefined,
                        profileId: selectedProfile?.id,
                        projectId: projectId.trim() || selectedProfile?.defaultProjectId || undefined,
                        persistence: persistence || selectedProfile?.persistence || undefined,
                        capabilities: requestedCapabilities.length > 0 ? requestedCapabilities : undefined,
                        maxConcurrentJobs: parsedMaxConcurrent,
                        ttlMinutes: parsedTtlMinutes,
                        targetRootWindows: targetRootWindows.trim() || undefined,
                        targetRootPosix: targetRootPosix.trim() || undefined,
                      });
                    }}
                  >
                    <label>
                      <span>Host ID</span>
                      <input value={hostId} onChange={(event) => setHostId(event.target.value)} placeholder="contributor-laptop" />
                    </label>
                    <label>
                      <span>Alias</span>
                      <input value={alias} onChange={(event) => setAlias(event.target.value)} placeholder="contributor laptop" />
                    </label>
                    <label>
                      <span>Profile</span>
                      <select
                        value={profileId || selectedProfile?.id || ""}
                        onChange={(event) => setProfileId(event.target.value)}
                      >
                        {(workerProfiles.data?.profiles ?? []).map((profile) => (
                          <option key={profile.id} value={profile.id}>
                            {profile.label}
                          </option>
                        ))}
                      </select>
                    </label>
                    <label>
                      <span>Project</span>
                      <select
                        value={projectId || selectedProfile?.defaultProjectId || ""}
                        onChange={(event) => setProjectId(event.target.value)}
                        disabled={!selectedProfile}
                      >
                        {(selectedProfile?.projectIds ?? []).map((candidate) => (
                          <option key={candidate} value={candidate}>
                            {candidate}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="worker-enrollment-form-meta">
                      {selectedProfile ? (
                        <>
                          <span className="badge">runtime {selectedProfile.runtimePort}</span>
                          <span className="badge">max {selectedProfile.maxConcurrentJobs}</span>
                          <span className="badge">{selectedProfile.persistence}</span>
                          {selectedProfile.capabilities.map((capability) => (
                            <span key={capability} className="badge">
                              {capability}
                            </span>
                          ))}
                        </>
                      ) : (
                        <span className="badge">loading profiles</span>
                      )}
                    </div>
                    <div className="worker-enrollment-form-advanced">
                      <label>
                        <span>Persistence</span>
                        <select
                          value={persistence || selectedProfile?.persistence || ""}
                          onChange={(event) => setPersistence(event.target.value as WorkerEnrollmentCreateRequest["persistence"] | "")}
                        >
                          <option value="manual">manual</option>
                          <option value="run-key">run-key</option>
                          <option value="scheduled-task-logon">scheduled-task-logon</option>
                          <option value="scheduled-task-startup">scheduled-task-startup</option>
                        </select>
                      </label>
                      <label>
                        <span>Capabilities</span>
                        <input
                          value={capabilitiesInput}
                          onChange={(event) => setCapabilitiesInput(event.target.value)}
                          placeholder={selectedProfile?.capabilities.join(", ") || "dispatch, verify, fix"}
                        />
                      </label>
                      <label>
                        <span>Max concurrency</span>
                        <input
                          inputMode="numeric"
                          value={maxConcurrentJobs}
                          onChange={(event) => setMaxConcurrentJobs(event.target.value)}
                          placeholder={String(selectedProfile?.maxConcurrentJobs ?? 1)}
                        />
                      </label>
                      <label>
                        <span>TTL minutes</span>
                        <input
                          inputMode="numeric"
                          value={ttlMinutes}
                          onChange={(event) => setTtlMinutes(event.target.value)}
                          placeholder="60"
                        />
                      </label>
                      <label>
                        <span>Windows worker root</span>
                        <input
                          value={targetRootWindows}
                          onChange={(event) => setTargetRootWindows(event.target.value)}
                          placeholder={windowsRootPlaceholder}
                        />
                      </label>
                      <label>
                        <span>POSIX worker root</span>
                        <input
                          value={targetRootPosix}
                          onChange={(event) => setTargetRootPosix(event.target.value)}
                          placeholder={posixRootPlaceholder}
                        />
                      </label>
                    </div>
                    <button type="submit" className="btn" disabled={createEnrollmentMutation.isPending}>
                      {createEnrollmentMutation.isPending ? "Creating..." : "Create Enrollment"}
                    </button>
                  </form>

                  <div className="worker-enrollment-output">
                    <div className="monitoring-section-title">Latest bootstrap bundle</div>
                    {latestEnrollment ? (
                      <>
                        <div className="worker-enrollment-session-meta">
                          <span className="badge mono">{latestEnrollment.session.enrollmentId}</span>
                          <span className={`pill ${latestEnrollment.session.status === "pending" ? "pill-IN_PROGRESS" : latestEnrollment.session.status === "expired" ? "pill-REJECTED" : "pill-success"}`}>
                            session {latestEnrollment.session.status}
                          </span>
                          <span className={`pill ${enrollmentInstallPillClass(latestEnrollment.session.installStatus.state)}`}>
                            install {latestEnrollment.session.installStatus.state}
                          </span>
                          <span className="badge">{latestEnrollment.session.installStatus.progressPercent}%</span>
                          <span className="badge">expires {formatDateTime(latestEnrollment.session.expiresAt)}</span>
                        </div>
                        {workerEnrollmentDetail.isFetching ? (
                          <p className="muted">Refreshing worker install status...</p>
                        ) : null}
                        {latestEnrollmentCreateResult ? (
                          <>
                            <div className="worker-enrollment-output-actions">
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => {
                                  void copyToClipboard("Bootstrap token", latestEnrollmentCreateResult.bootstrapToken);
                                }}
                              >
                                Copy Token
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => {
                                  void copyToClipboard("Windows install command", latestEnrollmentCreateResult.installCommandWindows);
                                }}
                              >
                                Copy Windows Command
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => {
                                  void copyToClipboard("POSIX install command", latestEnrollmentCreateResult.installCommand);
                                }}
                              >
                                Copy POSIX Command
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => {
                                  void copyToClipboard("Windows repair command", latestEnrollmentCreateResult.repairCommandWindows);
                                }}
                              >
                                Copy Windows Repair
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => {
                                  void copyToClipboard("POSIX repair command", latestEnrollmentCreateResult.repairCommand);
                                }}
                              >
                                Copy POSIX Repair
                              </button>
                              <button
                                type="button"
                                className="btn btn-secondary"
                                onClick={() => {
                                  void copyToClipboard("Worker onboarding bundle", buildWorkerEnrollmentBundle(latestEnrollmentCreateResult));
                                }}
                              >
                                Copy Full Bundle
                              </button>
                            </div>
                            <div className="worker-enrollment-secret">
                              <strong>Bootstrap token</strong>
                              <code>{latestEnrollmentCreateResult.bootstrapToken}</code>
                            </div>
                            {(latestEnrollmentCreateResult.targetRoots.windows || latestEnrollmentCreateResult.targetRoots.posix) ? (
                              <div className="worker-enrollment-detail-list">
                                {latestEnrollmentCreateResult.targetRoots.windows ? (
                                  <div className="worker-enrollment-detail-row">
                                    <span className="muted">Windows root</span>
                                    <code className="worker-enrollment-inline-code">{latestEnrollmentCreateResult.targetRoots.windows}</code>
                                  </div>
                                ) : null}
                                {latestEnrollmentCreateResult.targetRoots.posix ? (
                                  <div className="worker-enrollment-detail-row">
                                    <span className="muted">POSIX root</span>
                                    <code className="worker-enrollment-inline-code">{latestEnrollmentCreateResult.targetRoots.posix}</code>
                                  </div>
                                ) : null}
                              </div>
                            ) : null}
                            <div className="worker-enrollment-command-group">
                              <div className="muted">Windows PowerShell</div>
                              <pre className="command-block">{latestEnrollmentCreateResult.installCommandWindows}</pre>
                            </div>
                            <div className="worker-enrollment-command-group">
                              <div className="muted">Windows repair / refresh</div>
                              <pre className="command-block">{latestEnrollmentCreateResult.repairCommandWindows}</pre>
                            </div>
                            <div className="worker-enrollment-command-group">
                              <div className="muted">POSIX shell</div>
                              <pre className="command-block">{latestEnrollmentCreateResult.installCommand}</pre>
                            </div>
                            <div className="worker-enrollment-command-group">
                              <div className="muted">POSIX repair / refresh</div>
                              <pre className="command-block">{latestEnrollmentCreateResult.repairCommand}</pre>
                            </div>
                          </>
                        ) : (
                          <p className="muted">
                            This view is still tracking the selected session, but the one-time bootstrap token is only shown immediately after creation. Create a fresh enrollment for this host to reissue copy-ready install and repair commands.
                          </p>
                        )}
                        <div className="worker-enrollment-detail-grid">
                          <section className="worker-enrollment-detail-section worker-enrollment-readiness-section">
                            <div className="monitoring-section-title">Readiness</div>
                            <div className="worker-enrollment-detail-list">
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Status</span>
                                <span className={`pill ${enrollmentReadinessPillClass(latestEnrollment.session.readiness.status)}`}>
                                  {latestEnrollment.session.readiness.status}
                                </span>
                              </div>
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Score</span>
                                <span>{latestEnrollment.session.readiness.score}/100</span>
                              </div>
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Trusted for work</span>
                                <span>{latestEnrollment.session.readiness.trustedForWork ? "yes" : "no"}</span>
                              </div>
                              {latestEnrollment.session.readiness.blockedCapabilities.length > 0 ? (
                                <div className="worker-enrollment-detail-row is-stacked">
                                  <span className="muted">Blocked capabilities</span>
                                  <div className="worker-enrollment-chip-list">
                                    {latestEnrollment.session.readiness.blockedCapabilities.map((capability) => (
                                      <span key={`blocked:${capability}`} className="badge badge-warn">
                                        {capability}
                                      </span>
                                    ))}
                                  </div>
                                </div>
                              ) : null}
                              {latestEnrollment.session.readiness.blockers.length > 0 ? (
                                <div className="worker-enrollment-manual-steps">
                                  {latestEnrollment.session.readiness.blockers.map((blocker) => (
                                    <div key={blocker} className="worker-enrollment-detail-row is-stacked">
                                      <span className="badge badge-warn">blocker</span>
                                      <span>{blocker}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="muted">No readiness blockers are currently reported.</div>
                              )}
                              {latestEnrollment.session.readiness.repairActions.length > 0 ? (
                                <div className="worker-enrollment-progress-list">
                                  {latestEnrollment.session.readiness.repairActions.map((action) => (
                                    <div key={action.id} className="worker-enrollment-progress-row is-waiting">
                                      <span className="badge">{action.label}</span>
                                      <span>{action.reason}</span>
                                      <code className="worker-enrollment-inline-code">{action.command}</code>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </section>

                          <section className="worker-enrollment-detail-section">
                            <div className="monitoring-section-title">Expected worker</div>
                            <div className="worker-enrollment-detail-list">
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Control plane</span>
                                <span className="mono">{latestEnrollment.manifestPreview.controlPlane.baseUrl}</span>
                              </div>
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Runtime role</span>
                                <span>{latestEnrollment.manifestPreview.controlPlane.runtimeRole}</span>
                              </div>
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Runtime port</span>
                                <span>{latestEnrollment.manifestPreview.worker.runtimePort}</span>
                              </div>
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Max concurrency</span>
                                <span>{latestEnrollment.manifestPreview.worker.maxConcurrentJobs}</span>
                              </div>
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Persistence</span>
                                <span>{latestEnrollment.manifestPreview.worker.persistence}</span>
                              </div>
                              <div className="worker-enrollment-detail-row is-stacked">
                                <div>
                                  <div>Requested capabilities</div>
                                  <div className="muted">Profile or operator-requested labels</div>
                                </div>
                                <div className="worker-enrollment-chip-list">
                                  {latestEnrollment.session.installStatus.requestedCapabilities.map((capability) => (
                                    <span key={`requested:${capability}`} className="badge">
                                      {capability}
                                    </span>
                                  ))}
                                </div>
                              </div>
                              <div className="worker-enrollment-chip-list">
                                {latestEnrollment.session.installStatus.advertisedCapabilities.map((capability) => (
                                  <span key={capability} className="badge">
                                    live {capability}
                                  </span>
                                ))}
                              </div>
                            </div>
                          </section>

                          <section className="worker-enrollment-detail-section">
                            <div className="monitoring-section-title">Install status</div>
                            <div className="worker-enrollment-detail-list">
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Current state</span>
                                <span>{latestEnrollment.session.installStatus.state}</span>
                              </div>
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Last update</span>
                                <span>{latestEnrollment.session.installStatus.lastEventAt ? formatDateTime(latestEnrollment.session.installStatus.lastEventAt) : "waiting"}</span>
                              </div>
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Runtime healthy</span>
                                <span>{latestEnrollment.session.installStatus.runtimeHealthy ? "yes" : "no"}</span>
                              </div>
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Listener registered</span>
                                <span>{latestEnrollment.session.installStatus.listenerRegistered ? "yes" : "no"}</span>
                              </div>
                              <div className="worker-enrollment-detail-row">
                                <span className="muted">Manual follow-up</span>
                                <span>{latestEnrollment.session.installStatus.manualFollowUpCount}</span>
                              </div>
                              {latestEnrollment.session.installStatus.lastMessage ? (
                                <div className="worker-enrollment-detail-row is-stacked">
                                  <span className="badge">latest</span>
                                  <span>{latestEnrollment.session.installStatus.lastMessage}</span>
                                </div>
                              ) : null}
                              {latestEnrollment.session.installStatus.capabilityWarnings.length > 0 ? (
                                <div className="worker-enrollment-manual-steps">
                                  {latestEnrollment.session.installStatus.capabilityWarnings.map((warning) => (
                                    <div key={warning} className="worker-enrollment-detail-row is-stacked">
                                      <span className="badge">warning</span>
                                      <span>{warning}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                              <div className="worker-enrollment-progress-list">
                                {latestEnrollment.progressEvents.map((event) => (
                                  <div key={event.id} className={`worker-enrollment-progress-row is-${event.state}`}>
                                    <span className="badge">{event.phase}</span>
                                    <span>{event.message}</span>
                                    <span className="muted">{formatDateTime(event.timestamp)}</span>
                                  </div>
                                ))}
                                {latestEnrollment.progressEvents.length === 0 ? (
                                  <div className="muted">No worker-side progress events have been reported yet.</div>
                                ) : null}
                              </div>
                            </div>
                          </section>

                          <section className="worker-enrollment-detail-section">
                            <div className="monitoring-section-title">Prerequisites</div>
                            <div className="worker-enrollment-detail-list">
                              {latestEnrollment.manifestPreview.prerequisites.map((prerequisite) => (
                                <div key={prerequisite.id} className="worker-enrollment-detail-row is-stacked">
                                  <div>
                                    <div>{prerequisite.label}</div>
                                    {prerequisite.notes ? <div className="muted">{prerequisite.notes}</div> : null}
                                  </div>
                                  {prerequisite.checkCommand ? (
                                    <code className="worker-enrollment-inline-code">
                                      {commandToString(prerequisite.checkCommand)}
                                    </code>
                                  ) : (
                                    <span className="badge">{prerequisite.required ? "required" : "optional"}</span>
                                  )}
                                </div>
                              ))}
                            </div>
                          </section>

                          <section className="worker-enrollment-detail-section">
                            <div className="monitoring-section-title">Repo plan</div>
                            <div className="worker-enrollment-detail-list">
                              {latestEnrollment.manifestPreview.repos.map((repo) => {
                                const freshness = latestEnrollment.session.readiness.repoFreshness.find((entry) => entry.repoId === repo.id);
                                return (
                                <div key={repo.id} className="worker-enrollment-detail-row is-stacked">
                                  <div>
                                    <div>{repo.label}</div>
                                    <div className="muted">{repo.destination} | branch {repo.branch}</div>
                                    {freshness ? (
                                      <div className="muted">
                                        status {freshness.status}
                                        {freshness.currentBranch ? ` | current ${freshness.currentBranch}` : ""}
                                        {freshness.behind || freshness.ahead ? ` | ${freshness.ahead} ahead, ${freshness.behind} behind` : ""}
                                        {freshness.dirty ? " | dirty" : ""}
                                      </div>
                                    ) : null}
                                  </div>
                                  <code className="worker-enrollment-inline-code">{repo.sourceUrl}</code>
                                  {freshness?.repairCommand ? (
                                    <code className="worker-enrollment-inline-code">{freshness.repairCommand}</code>
                                  ) : null}
                                </div>
                                );
                              })}
                            </div>
                          </section>

                          <section className="worker-enrollment-detail-section">
                            <div className="monitoring-section-title">Project setup</div>
                            <div className="worker-enrollment-detail-list">
                              {latestEnrollment.manifestPreview.projects.map((project) => (
                                <div key={project.id} className="worker-enrollment-project-block">
                                  <div className="worker-enrollment-detail-row">
                                    <span>{project.label}</span>
                                    <span className="muted">{project.primary ? "primary" : project.pathAlias}</span>
                                  </div>
                                  {project.installCommands.map((command, index) => (
                                    <code
                                      key={`${project.id}:install:${index}`}
                                      className="worker-enrollment-inline-code"
                                    >
                                      install: {commandToString(command)}
                                    </code>
                                  ))}
                                  {project.probeCommands.map((command, index) => (
                                    <code
                                      key={`${project.id}:probe:${index}`}
                                      className="worker-enrollment-inline-code"
                                    >
                                      probe: {commandToString(command)}
                                    </code>
                                  ))}
                                  {project.capabilityProbes?.map((probe) => (
                                    <code
                                      key={`${project.id}:capability:${probe.capability}`}
                                      className="worker-enrollment-inline-code"
                                    >
                                      capability {probe.capability}: {commandToString(probe.command)}
                                    </code>
                                  ))}
                                  {project.installCommands.length === 0 && project.probeCommands.length === 0 ? (
                                    <div className="muted">No extra project-specific commands.</div>
                                  ) : null}
                                </div>
                              ))}
                            </div>
                          </section>

                          <section className="worker-enrollment-detail-section">
                            <div className="monitoring-section-title">Live listener</div>
                            <div className="worker-enrollment-detail-list">
                              {latestEnrollment.session.listener ? (
                                <>
                                  <div className="worker-enrollment-detail-row">
                                    <span className="muted">Host</span>
                                    <span>{latestEnrollment.session.listener.alias || latestEnrollment.session.listener.hostId}</span>
                                  </div>
                                  <div className="worker-enrollment-detail-row">
                                    <span className="muted">Health</span>
                                    <span>{latestEnrollment.session.listener.healthy ? "healthy" : "degraded"}</span>
                                  </div>
                                  <div className="worker-enrollment-detail-row">
                                    <span className="muted">Last heartbeat</span>
                                    <span>{latestEnrollment.session.listener.lastHealthCheckAt ? formatDateTime(latestEnrollment.session.listener.lastHealthCheckAt) : "waiting"}</span>
                                  </div>
                                  <div className="worker-enrollment-chip-list">
                                    {latestEnrollment.session.listener.capabilities.map((capability) => (
                                      <span key={`listener:${capability}`} className="badge">
                                        {capability}
                                      </span>
                                    ))}
                                  </div>
                                </>
                              ) : (
                                <div className="muted">The headnode has not observed a listener for this host yet.</div>
                              )}
                              {latestEnrollment.session.readiness.capabilities.length > 0 ? (
                                <div className="worker-enrollment-progress-list">
                                  {latestEnrollment.session.readiness.capabilities.map((result) => (
                                    <div key={`${result.capability}:${result.projectId ?? "global"}`} className={`worker-enrollment-progress-row is-${capabilityReadinessTone(result.status)}`}>
                                      <span className="badge">{result.tier}</span>
                                      <span>{result.capability}</span>
                                      <span>{result.message}</span>
                                      <span className="muted">{result.requested ? "requested" : "derived"} | {result.status}</span>
                                      {result.command ? (
                                        <code className="worker-enrollment-inline-code">{commandToString(result.command)}</code>
                                      ) : null}
                                      {result.repairCommand ? (
                                        <code className="worker-enrollment-inline-code">{result.repairCommand}</code>
                                      ) : null}
                                    </div>
                                  ))}
                                </div>
                              ) : null}
                            </div>
                          </section>

                          <section className="worker-enrollment-detail-section">
                            <div className="monitoring-section-title">Env and follow-up</div>
                            <div className="worker-enrollment-detail-list">
                              {latestEnrollment.manifestPreview.env.map((entry) => (
                                <div key={entry.name} className="worker-enrollment-detail-row is-stacked">
                                  <div>
                                    <div>{entry.name}</div>
                                    <div className="muted">
                                      {entry.description ?? (entry.secretRef ? `secret ${entry.secretRef}` : entry.mode)}
                                    </div>
                                  </div>
                                  <span className="badge">
                                    {entry.mode === "inline"
                                      ? "provided at bootstrap"
                                      : (entry.placeholder ?? "manual value required")}
                                  </span>
                                </div>
                              ))}
                              {latestEnrollment.manifestPreview.env.length === 0 ? (
                                <div className="muted">No extra env keys in this bundle.</div>
                              ) : null}
                              {latestEnrollment.manifestPreview.manualSteps.length > 0 ? (
                                <div className="worker-enrollment-manual-steps">
                                  {latestEnrollment.manifestPreview.manualSteps.map((step) => (
                                    <div key={step} className="worker-enrollment-detail-row is-stacked">
                                      <span className="badge">manual</span>
                                      <span>{step}</span>
                                    </div>
                                  ))}
                                </div>
                              ) : (
                                <div className="muted">No manual follow-up is declared in this bundle.</div>
                              )}
                            </div>
                          </section>
                        </div>
                      </>
                    ) : (
                      <p className="muted">
                        Create an enrollment to generate the one-time bootstrap token and install command for a new worker host.
                      </p>
                    )}
                  </div>
                </>
              ) : null}
            </div>

            {protectedPanelsEnabled ? (
              <div className="worker-enrollment-session-list">
                {(workerEnrollments.data?.sessions ?? []).map((session) => (
                  <button
                    key={session.enrollmentId}
                    type="button"
                    className={`worker-enrollment-session-row${effectiveEnrollmentId === session.enrollmentId ? " is-selected" : ""}`}
                    onClick={() => setSelectedEnrollmentId(session.enrollmentId)}
                  >
                    <div>
                      <div className="mono">{session.hostId}</div>
                      <div className="muted">{session.alias} | project {session.projectId}</div>
                    </div>
                    <div className="worker-enrollment-session-badges">
                      <span className="badge">{session.profileId}</span>
                      <span className="badge">runtime {session.runtimePort}</span>
                      <span className="badge">{session.persistence}</span>
                      <span className={`pill ${session.status === "pending" ? "pill-IN_PROGRESS" : session.status === "consumed" ? "pill-success" : "pill-REJECTED"}`}>
                        {session.status}
                      </span>
                      <span className={`pill ${enrollmentInstallPillClass(session.installStatus.state)}`}>
                        {session.installStatus.state}
                      </span>
                      <span className={`pill ${enrollmentReadinessPillClass(session.readiness.status)}`}>
                        ready {session.readiness.score}
                      </span>
                    </div>
                    <div className="muted">
                      created {formatDateTime(session.createdAt)} | expires {formatDateTime(session.expiresAt)} | {session.installStatus.progressPercent}%
                    </div>
                  </button>
                ))}
                {(workerEnrollments.data?.sessions.length ?? 0) === 0 ? (
                  <div className="empty-state">No worker enrollments have been issued yet.</div>
                ) : null}
              </div>
            ) : null}
          </section>

          <div className="monitoring-grid">
            {environments.map((environment) => {
              const relatedLinks = filterRelatedLinks(environment);
              return (
                <article key={environment.monitor.id} className="card monitoring-card">
                  <div className="monitoring-card-header">
                    <div>
                      <div className="monitoring-eyebrow">
                        {environment.monitor.service ?? "deployment"} | {environment.monitor.environment}
                      </div>
                      <h2>{environment.monitor.label}</h2>
                      {environment.monitor.notes ? (
                        <p className="muted monitoring-notes">{environment.monitor.notes}</p>
                      ) : null}
                    </div>
                    <span className={`pill ${monitorStatePillClass(environment.state)}`}>{environment.state}</span>
                  </div>

                  <div className="monitoring-meta">
                    <span className="badge">{environment.monitor.provider}</span>
                    {environment.monitor.region ? <span className="badge">{environment.monitor.region}</span> : null}
                    <span className="badge">source: {environment.monitor.source}</span>
                    {environment.monitor.tags.map((tag) => (
                      <span key={tag} className="badge">
                        {tag}
                      </span>
                    ))}
                  </div>

                  <div className="monitoring-summary-grid">
                    <SummaryTile
                      label="Runtime checks"
                      value={`${environment.rollup.healthyChecks}/${environment.rollup.totalChecks}`}
                      tone={environment.rollup.failingChecks > 0 ? "warn" : "good"}
                    />
                    <SummaryTile
                      label="Runtime failing"
                      value={String(environment.rollup.failingChecks)}
                      tone={environment.rollup.failingChecks > 0 ? "warn" : "neutral"}
                    />
                    {environment.aws ? (
                      <SummaryTile
                        label="AWS posture"
                        value={environment.aws.state}
                        tone={awsStateTone(environment.aws)}
                      />
                    ) : null}
                    {environment.identity?.version ? (
                      <SummaryTile label="Version" value={environment.identity.version} tone="neutral" />
                    ) : null}
                    {environment.identity?.uptimeSeconds != null ? (
                      <SummaryTile
                        label="Reported uptime"
                        value={formatDurationMs(environment.identity.uptimeSeconds * 1000)}
                        tone="neutral"
                      />
                    ) : null}
                  </div>

                  {environment.identity || environment.aws?.accountId ? (
                    <div className="monitoring-meta">
                      {environment.identity?.status ? (
                        <span className="badge">service status: {environment.identity.status}</span>
                      ) : null}
                      {environment.identity?.commit ? (
                        <span className="badge mono">commit: {environment.identity.commit}</span>
                      ) : null}
                      {environment.identity?.reportedAt ? (
                        <span className="badge">reported: {formatDateTime(environment.identity.reportedAt)}</span>
                      ) : null}
                      {environment.aws?.accountId ? (
                        <span className="badge mono">aws account: {environment.aws.accountId}</span>
                      ) : null}
                    </div>
                  ) : null}

                  <section className="monitoring-section">
                    <div className="monitoring-section-title">Core probes</div>
                    <div className="monitoring-check-grid">
                      <ProbeCard
                        title="Health endpoint"
                        url={environment.monitor.healthUrl}
                        probe={environment.health}
                        badges={["api", "core"]}
                      />
                      {environment.app ? (
                        <ProbeCard
                          title="App reachability"
                          url={environment.monitor.appUrl ?? environment.monitor.healthUrl}
                          probe={environment.app}
                          badges={["frontend", "core"]}
                        />
                      ) : null}
                    </div>
                  </section>

                  {environment.components.length > 0 ? (
                    <section className="monitoring-section">
                      <div className="monitoring-section-title">Additional components</div>
                      <div className="monitoring-check-grid">
                        {environment.components.map((component) => (
                          <ComponentProbeCard key={component.component.id} component={component} />
                        ))}
                      </div>
                    </section>
                  ) : null}

                  {environment.aws ? (
                    <section className="monitoring-section">
                      <div className="monitoring-section-title">AWS observability</div>

                      <div className="monitoring-summary-grid">
                        <SummaryTile
                          label="Resources tracked"
                          value={String(environment.aws.summary.totalResources)}
                          tone="neutral"
                        />
                        <SummaryTile
                          label="AWS issues"
                          value={String(environment.aws.summary.issueCount)}
                          tone={environment.aws.summary.issueCount > 0 ? "warn" : "good"}
                        />
                        <SummaryTile
                          label="Alert routing gaps"
                          value={String(environment.aws.summary.unwiredTopics)}
                          tone={environment.aws.summary.unwiredTopics > 0 ? "warn" : "good"}
                        />
                        <SummaryTile
                          label="Missing metrics"
                          value={String(environment.aws.summary.missingMetrics)}
                          tone={environment.aws.summary.missingMetrics > 0 ? "warn" : "good"}
                        />
                      </div>

                      {environment.aws.error ? (
                        <div className="monitoring-warning-banner">{environment.aws.error}</div>
                      ) : null}

                      {environment.aws.warnings.length > 0 ? (
                        <ul className="monitoring-warning-list">
                          {environment.aws.warnings.map((warning) => (
                            <li key={`${environment.monitor.id}:${warning}`}>{warning}</li>
                          ))}
                        </ul>
                      ) : null}

                      <div className="monitoring-aws-grid">
                        {environment.aws.alarms.length > 0 ? (
                          <AwsPanel title="CloudWatch alarms">
                            {environment.aws.alarms.map((alarm) => (
                              <AwsItem
                                key={alarm.name}
                                label={alarm.label}
                                state={labelAlarmState(alarm.state)}
                                tone={alarmTone(alarm)}
                                detail={joinParts([alarm.namespace, alarm.metricName])}
                                meta={alarm.updatedAt ? formatDateTime(alarm.updatedAt) : undefined}
                                note={alarm.reason}
                              />
                            ))}
                          </AwsPanel>
                        ) : null}

                        {environment.aws.healthChecks.length > 0 ? (
                          <AwsPanel title="Route53 health checks">
                            {environment.aws.healthChecks.map((healthCheck) => (
                              <AwsItem
                                key={healthCheck.id}
                                label={healthCheck.label}
                                state={labelHealthCheckState(healthCheck.state)}
                                tone={healthCheckTone(healthCheck)}
                                detail={healthCheck.path}
                                meta={joinParts([
                                  `${healthCheck.healthyRegions}/${healthCheck.totalRegions} regions healthy`,
                                  healthCheck.lastCheckedAt
                                    ? `checked ${formatDateTime(healthCheck.lastCheckedAt)}`
                                    : undefined,
                                ])}
                                note={healthCheck.detail}
                              />
                            ))}
                          </AwsPanel>
                        ) : null}

                        {environment.aws.logGroups.length > 0 ? (
                          <AwsPanel title="CloudWatch log freshness">
                            {environment.aws.logGroups.map((logGroup) => (
                              <AwsItem
                                key={logGroup.name}
                                label={logGroup.label}
                                state={labelLogState(logGroup.state)}
                                tone={logGroupTone(logGroup)}
                                detail={logGroup.name}
                                meta={joinParts([
                                  logGroup.lastEventAt
                                    ? `last event ${formatDateTime(logGroup.lastEventAt)}`
                                    : undefined,
                                  logGroup.ageMinutes != null
                                    ? `${formatDurationMs(logGroup.ageMinutes * 60_000)} old`
                                    : undefined,
                                  `stale after ${formatDurationMs(logGroup.freshnessMinutes * 60_000)}`,
                                ])}
                              />
                            ))}
                          </AwsPanel>
                        ) : null}

                        {environment.aws.topics.length > 0 ? (
                          <AwsPanel title="SNS alert topics">
                            {environment.aws.topics.map((topic) => (
                              <AwsItem
                                key={topic.arn}
                                label={topic.label}
                                state={labelTopicState(topic.state)}
                                tone={topicTone(topic)}
                                detail={topic.arn}
                                meta={joinParts([
                                  `${topic.confirmedSubscriptions} confirmed`,
                                  topic.pendingSubscriptions > 0
                                    ? `${topic.pendingSubscriptions} pending`
                                    : undefined,
                                ])}
                              />
                            ))}
                          </AwsPanel>
                        ) : null}

                        {environment.aws.expectedMetrics.length > 0 ? (
                          <AwsPanel title="Custom metric signal">
                            {environment.aws.expectedMetrics.map((metric) => (
                              <AwsItem
                                key={`${metric.namespace}:${metric.metricName}`}
                                label={metric.label}
                                state={metric.state === "present" ? "Present" : "Missing"}
                                tone={metric.state === "present" ? "good" : "warn"}
                                detail={`${metric.namespace} / ${metric.metricName}`}
                                meta={`${metric.discoveredMetrics} matching metric definitions`}
                              />
                            ))}
                          </AwsPanel>
                        ) : null}

                        {environment.aws.budgets.length > 0 ? (
                          <AwsPanel title="Budgets">
                            {environment.aws.budgets.map((budget) => (
                              <AwsItem
                                key={budget.name}
                                label={budget.label}
                                state={labelBudgetState(budget.state)}
                                tone={budgetTone(budget)}
                                detail={budget.name}
                                meta={formatBudgetMeta(budget)}
                              />
                            ))}
                          </AwsPanel>
                        ) : null}

                        {environment.aws.dashboards.length > 0 ? (
                          <AwsPanel title="Dashboards">
                            {environment.aws.dashboards.map((dashboard) => (
                              <AwsItem
                                key={dashboard.name}
                                label={dashboard.label}
                                state={dashboard.state === "present" ? "Present" : "Missing"}
                                tone={dashboard.state === "present" ? "good" : "warn"}
                                detail={dashboard.name}
                                meta={dashboard.lastModified ? formatDateTime(dashboard.lastModified) : undefined}
                              />
                            ))}
                          </AwsPanel>
                        ) : null}
                      </div>
                    </section>
                  ) : null}

                  {relatedLinks.length > 0 ? (
                    <div className="monitoring-link-list">
                      {relatedLinks.map((link) => (
                        <a
                          key={`${environment.monitor.id}:${link.label}:${link.url}`}
                          className="monitoring-link"
                          href={link.url}
                          target="_blank"
                          rel="noreferrer"
                          title={link.description}
                        >
                          {link.label}
                        </a>
                      ))}
                    </div>
                  ) : null}

                  {environment.health.payload !== undefined || environment.health.bodyPreview ? (
                    <details className="monitoring-details">
                      <summary>Health payload</summary>
                      {environment.health.payload !== undefined ? (
                        <pre className="monitoring-payload">
                          {JSON.stringify(environment.health.payload, null, 2)}
                        </pre>
                      ) : environment.health.bodyPreview ? (
                        <pre className="monitoring-payload">{environment.health.bodyPreview}</pre>
                      ) : null}
                    </details>
                  ) : null}
                </article>
              );
            })}
          </div>

          {environments.length === 0 ? (
            <section className="card">
              <p className="empty-state">
                No deployment environments are configured yet. Add `deploymentMonitors` to
                `~/.quack/config.json` to expand beyond the built-in AWS profile.
              </p>
            </section>
          ) : null}
        </>
      )}
    </section>
  );
}

function hasWorkerCommandIssue(host: FederationHostSummary): boolean {
  return host.lastCommand?.status === "failed"
    || host.lastCommand?.status === "retryable"
    || host.lastCommand?.status === "non_retryable";
}

function summarizeWorkerRefreshDrift(metadata: Record<string, unknown> | undefined): string | undefined {
  const repos = metadata?.repos;
  if (!Array.isArray(repos)) return undefined;

  const repoSummaries = repos
    .map((repo) => {
      if (!repo || typeof repo !== "object") return undefined;
      const record = repo as Record<string, unknown>;
      const repoKey = typeof record.repoKey === "string" ? record.repoKey : "repo";
      const status = typeof record.status === "string" ? record.status : undefined;
      const blocker = typeof record.blocker === "string" ? record.blocker : undefined;
      if (status === "blocked") return `${repoKey}: ${blocker ?? "blocked"}`;
      if (status === "refreshed") return `${repoKey}: refreshed`;
      return undefined;
    })
    .filter((summary): summary is string => Boolean(summary));

  return repoSummaries.length > 0 ? `refresh ${repoSummaries.join(", ")}` : undefined;
}

function commandToString(command: {
  cmd: string;
  args: string[];
  cwd?: string;
}): string {
  const rendered = [command.cmd, ...command.args].join(" ");
  return command.cwd ? `(cd ${command.cwd} && ${rendered})` : rendered;
}

function enrollmentInstallPillClass(
  state: WorkerEnrollmentSessionView["installStatus"]["state"],
): string {
  switch (state) {
    case "healthy":
      return "pill-success";
    case "registered":
    case "installing":
    case "bootstrap_consumed":
      return "pill-IN_PROGRESS";
    case "failed":
    case "expired":
      return "pill-REJECTED";
    default:
      return "pill-BLOCKED";
  }
}

function enrollmentReadinessPillClass(
  status: WorkerEnrollmentSessionView["readiness"]["status"],
): string {
  switch (status) {
    case "ready":
      return "pill-success";
    case "pending":
    case "degraded":
      return "pill-IN_PROGRESS";
    case "expired":
    case "blocked":
      return "pill-REJECTED";
    default:
      return "pill-BLOCKED";
  }
}

function capabilityReadinessTone(
  status: WorkerCapabilityProbeResult["status"],
): "completed" | "failed" | "waiting" {
  switch (status) {
    case "passed":
    case "deferred":
      return "completed";
    case "failed":
      return "failed";
    default:
      return "waiting";
  }
}

function buildWorkerEnrollmentBundle(result: WorkerEnrollmentCreateResponse): string {
  const lines = [
    `Enrollment ID: ${result.session.enrollmentId}`,
    `Host ID: ${result.session.hostId}`,
    `Alias: ${result.session.alias}`,
    `Project ID: ${result.session.projectId}`,
    `Runtime port: ${result.session.runtimePort}`,
    `Persistence: ${result.session.persistence}`,
    `Expires: ${result.session.expiresAt}`,
    `Control plane: ${result.manifestPreview.controlPlane.baseUrl}`,
    "",
    "Requested capabilities:",
    ...result.session.installStatus.requestedCapabilities.map((capability) => `- ${capability}`),
    "",
    "Initially advertised capabilities:",
    ...result.session.installStatus.advertisedCapabilities.map((capability) => `- ${capability}`),
    "",
    "Prerequisites:",
    ...result.manifestPreview.prerequisites.map((prerequisite) =>
      `- ${prerequisite.label}${prerequisite.checkCommand ? ` :: ${commandToString(prerequisite.checkCommand)}` : ""}`,
    ),
    "",
    "Repos:",
    ...result.manifestPreview.repos.map((repo) =>
      `- ${repo.label} :: ${repo.sourceUrl} :: branch ${repo.branch} -> ${repo.destination}`,
    ),
    "",
    "Project setup:",
    ...result.manifestPreview.projects.flatMap((project) => [
      `- ${project.label}${project.primary ? " (primary)" : ""}`,
      ...project.installCommands.map((command) => `  install: ${commandToString(command)}`),
      ...project.probeCommands.map((command) => `  probe: ${commandToString(command)}`),
      ...(project.capabilityProbes ?? []).map((probe) => `  capability ${probe.capability}: ${commandToString(probe.command)}`),
    ]),
    "",
    "Env / follow-up:",
    ...result.manifestPreview.env.map((entry) =>
      `- ${entry.name} :: ${entry.mode === "inline" ? "provided at bootstrap" : (entry.placeholder ?? "manual value required")}`,
    ),
    ...result.manifestPreview.manualSteps.map((step) => `- ${step}`),
    ...result.capabilityResults.map((probe) => `- capability ${probe.capability}: ${probe.status} :: ${probe.message}`),
    "",
    "Bootstrap token:",
    result.bootstrapToken,
    "",
    ...(result.targetRoots.windows ? [`Windows target root: ${result.targetRoots.windows}`, ""] : []),
    ...(result.targetRoots.posix ? [`POSIX target root: ${result.targetRoots.posix}`, ""] : []),
    "Windows PowerShell:",
    result.installCommandWindows,
    "",
    "Windows repair / refresh:",
    result.repairCommandWindows,
    "",
    "POSIX shell:",
    result.installCommand,
    "",
    "POSIX repair / refresh:",
    result.repairCommand,
  ];
  return lines.join("\n");
}

async function copyToClipboard(label: string, value: string): Promise<void> {
  if (!navigator.clipboard?.writeText) {
    toast.error("Clipboard unavailable", `${label} could not be copied in this browser.`);
    return;
  }
  try {
    await navigator.clipboard.writeText(value);
    toast.success(`${label} copied`, "Ready to paste.");
  } catch (error) {
    toast.error(label, error instanceof Error ? error.message : "Copy failed.");
  }
}

function MetricCard(props: { label: string; value: string; detail?: string }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{props.label}</div>
      <div className="metric-value">{props.value}</div>
      {props.detail ? <div className="metric-subtle">{props.detail}</div> : null}
    </div>
  );
}

function ProtectedPanelNotice(props: { message: string }) {
  return <div className="empty-state">{props.message}</div>;
}

function SummaryTile(props: {
  label: string;
  value: string;
  tone: "good" | "warn" | "neutral";
}) {
  return (
    <div className={`monitoring-summary-tile is-${props.tone}`}>
      <div className="monitoring-summary-label">{props.label}</div>
      <div className="monitoring-summary-value">{props.value}</div>
    </div>
  );
}

function ComponentProbeCard({
  component,
}: {
  component: DeploymentMonitorComponentStatus;
}) {
  const badges = [component.component.category, ...component.component.tags];
  return (
    <ProbeCard
      title={component.component.label}
      url={component.component.url}
      probe={component.probe}
      badges={badges}
      note={component.component.notes}
    />
  );
}

function ControlPlaneProbeCard({
  probe,
}: {
  probe: ControlPlaneProbeStatus;
}) {
  const badges = [probe.descriptor.kind, ...probe.descriptor.tags];
  return (
    <ProbeCard
      title={probe.descriptor.label}
      url={probe.descriptor.url}
      probe={probe.probe}
      badges={badges}
      note={probe.descriptor.notes}
    />
  );
}

function ProbeCard({
  title,
  url,
  probe,
  badges = [],
  note,
}: {
  title: string;
  url: string;
  probe: DeploymentProbeResult;
  badges?: string[];
  note?: string;
}) {
  const tone = probeTone(probe);
  return (
    <section className={`monitoring-probe is-${tone}`}>
      <div className="monitoring-probe-header">
        <div className="monitoring-probe-title">{title}</div>
        {badges.length > 0 ? (
          <div className="monitoring-probe-badges">
            {badges.map((badge) => (
              <span key={`${title}:${badge}`} className="badge">
                {badge}
              </span>
            ))}
          </div>
        ) : null}
      </div>
      {note ? <div className="monitoring-probe-note">{note}</div> : null}
      <a className="monitoring-probe-url mono" href={url} target="_blank" rel="noreferrer">
        {url}
      </a>
      <div className="monitoring-probe-summary">
        {probeLabel(probe)}
        {probe.statusCode ? ` | HTTP ${probe.statusCode}` : ""}
        {probe.latencyMs != null ? ` | ${formatDurationMs(probe.latencyMs)}` : ""}
      </div>
      <div className="monitoring-probe-meta">
        <span>{formatDateTime(probe.checkedAt)}</span>
        {probe.finalUrl && probe.finalUrl !== url ? <span>redirected</span> : null}
        {probe.contentType ? <span>{probe.contentType}</span> : null}
      </div>
      {!probe.ok && probe.error ? (
        <div className="monitoring-probe-error">{probe.error}</div>
      ) : null}
    </section>
  );
}

function AwsPanel(props: { title: string; children: ReactNode }) {
  return (
    <section className="monitoring-aws-panel">
      <div className="monitoring-aws-panel-title">{props.title}</div>
      <div className="monitoring-aws-item-list">{props.children}</div>
    </section>
  );
}

function AwsItem(props: {
  label: string;
  state: string;
  tone: "good" | "warn" | "error" | "neutral";
  detail?: string;
  meta?: string;
  note?: string;
}) {
  return (
    <div className={`monitoring-aws-item is-${props.tone}`}>
      <div className="monitoring-aws-item-header">
        <div className="monitoring-aws-item-label">{props.label}</div>
        <span className={`monitoring-state-chip is-${props.tone}`}>{props.state}</span>
      </div>
      {props.detail ? <div className="monitoring-aws-item-detail mono">{props.detail}</div> : null}
      {props.meta ? <div className="monitoring-aws-item-meta">{props.meta}</div> : null}
      {props.note ? <div className="monitoring-aws-item-note">{props.note}</div> : null}
    </div>
  );
}

function probeTone(probe: DeploymentProbeResult): "ok" | "error" | "disabled" {
  if (probe.statusText === "Disabled") return "disabled";
  return probe.ok ? "ok" : "error";
}

function probeLabel(probe: DeploymentProbeResult): string {
  if (probe.statusText === "Disabled") return "Disabled";
  return probe.ok ? "OK" : "Issue";
}

function filterRelatedLinks(environment: DeploymentMonitorStatus) {
  const hiddenUrls = new Set<string>([
    environment.monitor.healthUrl,
    ...(environment.monitor.appUrl ? [environment.monitor.appUrl] : []),
    ...environment.components.map((component) => component.component.url),
  ]);

  return environment.monitor.links.filter((link) => !hiddenUrls.has(link.url));
}

function awsStateTone(
  aws: DeploymentMonitorAwsStatus,
): "good" | "warn" | "neutral" {
  switch (aws.state) {
    case "healthy":
      return "good";
    case "degraded":
    case "unavailable":
      return "warn";
    default:
      return "neutral";
  }
}

function joinParts(parts: Array<string | undefined>): string | undefined {
  const filtered = parts.filter((part): part is string => Boolean(part && part.trim().length > 0));
  return filtered.length > 0 ? filtered.join(" | ") : undefined;
}

function alarmTone(
  alarm: DeploymentMonitorAwsAlarmStatus,
): "good" | "warn" | "error" | "neutral" {
  switch (alarm.state) {
    case "ok":
      return "good";
    case "alarm":
      return "error";
    case "insufficient_data":
    case "missing":
      return "warn";
    default:
      return "neutral";
  }
}

function labelAlarmState(state: DeploymentMonitorAwsAlarmStatus["state"]): string {
  switch (state) {
    case "ok":
      return "OK";
    case "alarm":
      return "ALARM";
    case "insufficient_data":
      return "No data";
    case "missing":
      return "Missing";
    default:
      return state;
  }
}

function healthCheckTone(
  healthCheck: DeploymentMonitorAwsHealthCheckStatus,
): "good" | "warn" | "error" | "neutral" {
  switch (healthCheck.state) {
    case "healthy":
      return "good";
    case "unhealthy":
      return "error";
    case "unknown":
    case "missing":
      return "warn";
    default:
      return "neutral";
  }
}

function labelHealthCheckState(
  state: DeploymentMonitorAwsHealthCheckStatus["state"],
): string {
  switch (state) {
    case "healthy":
      return "Healthy";
    case "unhealthy":
      return "Unhealthy";
    case "unknown":
      return "Unknown";
    case "missing":
      return "Missing";
    default:
      return state;
  }
}

function logGroupTone(
  logGroup: DeploymentMonitorAwsLogGroupStatus,
): "good" | "warn" | "error" | "neutral" {
  switch (logGroup.state) {
    case "fresh":
      return "good";
    case "stale":
      return "warn";
    case "empty":
    case "missing":
      return "error";
    default:
      return "neutral";
  }
}

function labelLogState(state: DeploymentMonitorAwsLogGroupStatus["state"]): string {
  switch (state) {
    case "fresh":
      return "Fresh";
    case "stale":
      return "Stale";
    case "empty":
      return "Empty";
    case "missing":
      return "Missing";
    default:
      return state;
  }
}

function topicTone(
  topic: DeploymentMonitorAwsTopicStatus,
): "good" | "warn" | "error" | "neutral" {
  switch (topic.state) {
    case "wired":
      return "good";
    case "unwired":
      return "warn";
    case "missing":
      return "error";
    default:
      return "neutral";
  }
}

function labelTopicState(state: DeploymentMonitorAwsTopicStatus["state"]): string {
  switch (state) {
    case "wired":
      return "Subscribed";
    case "unwired":
      return "No subscribers";
    case "missing":
      return "Missing";
    default:
      return state;
  }
}

function budgetTone(
  budget: DeploymentMonitorAwsBudgetStatus,
): "good" | "warn" | "error" | "neutral" {
  switch (budget.state) {
    case "ok":
      return "good";
    case "alerting":
      return "warn";
    case "missing":
      return "error";
    default:
      return "neutral";
  }
}

function labelBudgetState(state: DeploymentMonitorAwsBudgetStatus["state"]): string {
  switch (state) {
    case "ok":
      return "Tracking";
    case "alerting":
      return "Over budget";
    case "missing":
      return "Missing";
    default:
      return state;
  }
}

function formatBudgetMeta(budget: DeploymentMonitorAwsBudgetStatus): string | undefined {
  const amountText =
    budget.actualAmount != null && budget.limitAmount != null
      ? `${formatCurrency(budget.actualAmount, budget.unit)} / ${formatCurrency(budget.limitAmount, budget.unit)}`
      : undefined;

  return joinParts([amountText, budget.timeUnit]);
}

function formatCurrency(value: number, unit?: string): string {
  if (unit === "USD" || unit === undefined) {
    return currencyFormatter.format(value);
  }
  return `${value.toFixed(0)} ${unit}`;
}

function monitorStatePillClass(state: DeploymentMonitorStatus["state"]): string {
  switch (state) {
    case "healthy":
      return "pill-success";
    case "degraded":
      return "pill-IN_PROGRESS";
    case "offline":
      return "pill-REJECTED";
    case "disabled":
      return "pill-muted";
    default:
      return "pill-muted";
  }
}

function controlPlanePillClass(
  summary: { totalChecks: number; failingChecks: number; disabledChecks: number } | undefined,
): string {
  if (!summary || summary.totalChecks === 0 || summary.disabledChecks === summary.totalChecks) {
    return "pill-muted";
  }
  return summary.failingChecks > 0 ? "pill-REJECTED" : "pill-success";
}
