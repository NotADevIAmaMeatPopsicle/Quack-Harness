import { useQuery } from "@tanstack/react-query";

import { getFederationQueue, getFleetHealth, getFleetStatus, getHealth } from "../api/client";
import type { FederationHostSummary, FederationJobSummary } from "../api/contracts";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../lib/format";

const ACTIVE_JOB_STATUSES = new Set(["queued", "assigned", "running", "verifying", "fixing"]);

interface OverviewAlert {
  key: string;
  title: string;
  detail: string;
  tone: "good" | "warn" | "critical" | "accent" | "muted";
}

export function OverviewPage() {
  const health = useQuery({
    queryKey: ["health"],
    queryFn: getHealth,
    refetchInterval: 5000,
  });
  const queue = useQuery({
    queryKey: ["federation-queue"],
    queryFn: getFederationQueue,
    refetchInterval: 5000,
  });
  const fleetStatus = useQuery({
    queryKey: ["fleet-status"],
    queryFn: getFleetStatus,
    refetchInterval: 5000,
  });
  const fleetHealth = useQuery({
    queryKey: ["fleet-health"],
    queryFn: getFleetHealth,
    refetchInterval: 5000,
  });

  const hosts = [...(queue.data?.summary?.hosts ?? [])].sort(compareHostsForOverview);
  const jobs = queue.data?.jobs ?? [];
  const statusCounts = queue.data?.summary?.byStatus ?? {};
  const onlineHosts = hosts.filter((host) => host.healthy).length;
  const staleHosts = hosts.filter((host) => host.healthy && isHostStale(host.lastHealthCheckAt));
  const offlineHosts = hosts.filter((host) => !host.healthy);
  const saturatedHosts = hosts.filter((host) => isHostAtCapacity(host));
  const availableHosts = hosts.filter((host) => isHostDispatchReady(host));
  const totalCapacity = hosts.reduce((sum, host) => sum + (host.maxConcurrentJobs || 1), 0);
  const currentLoad = hosts.reduce((sum, host) => sum + (host.currentLoad || 0), 0);
  const readyCapacity = availableHosts.reduce((sum, host) => sum + availableSlots(host), 0);
  const activeJobs = jobs.filter((job) => ACTIVE_JOB_STATUSES.has(job.status));
  const blockedJobs = jobs.filter((job) => job.status === "blocked");
  const backlogJobs = (statusCounts.queued ?? 0) + blockedJobs.length;
  const warningAgents = (fleetHealth.data?.agents ?? []).filter((agent) =>
    agent.status === "warning" || agent.status === "critical" || agent.status === "stuck");
  const verificationWarnings = hosts.filter(hasVerificationToolingWarning);
  const loadPercent = totalCapacity > 0 ? Math.min(100, (currentLoad / totalCapacity) * 100) : 0;

  const overviewAlerts = buildOverviewAlerts({
    hosts,
    availableHosts,
    staleHosts,
    offlineHosts,
    saturatedHosts,
    blockedJobs,
    backlogJobs,
    warningAgents: warningAgents.length,
    verificationWarnings: verificationWarnings.length,
    stateAuthority: health.data?.stateAuthority,
    localDbAuthoritative: health.data?.localDbAuthoritative,
  });
  const activeSignals = overviewAlerts.filter((alert) => alert.tone === "warn" || alert.tone === "critical").length;

  return (
    <div className="page overview-page">
      <PageHeader
        title="Overview"
        subtitle="Headnode control plane, live worker capacity, and the signals an admin should scan before queueing the next task."
      >
        {health.data && (
          <span className={`pill ${healthPillClass(health.data.status)}`}>
            {health.data.status}
          </span>
        )}
        {fleetStatus.data && (
          <span className={`pill ${fleetPillClass(fleetStatus.data.state)}`}>
            fleet {fleetStatus.data.state}
          </span>
        )}
      </PageHeader>

      <section className="card overview-hero">
        <div className="overview-hero-copy">
          <div className="overview-eyebrow">Swarm Control Plane</div>
          <h2 className="overview-hero-title">Headnode dashboard for dispatch, drift, and worker readiness</h2>
          <p className="overview-hero-text">
            Start here before every dispatch. The goal is a five-second read on open lanes, stale or offline
            workers, queue pressure, and whether the headnode is safe to hand the next task to the swarm.
          </p>
          <div className="overview-meta">
            <span className="overview-meta-pill">
              UI {health.data?.uiMode ?? "legacy"}
            </span>
            <span className="overview-meta-pill">
              Last refresh {formatDateTime(health.data?.timestamp)}
            </span>
            <span className="overview-meta-pill">
              Commit {formatCommit(health.data?.commit)}
            </span>
            {health.data?.legacyUiPath && (
              <a className="overview-meta-link" href={health.data.legacyUiPath}>
                Open legacy dashboard
              </a>
            )}
          </div>
        </div>

        <div className="overview-hero-grid">
          <MetricCard
            label="Workers Online"
            value={`${onlineHosts}/${hosts.length || 0}`}
            detail={formatOnlineDetail(hosts.length, staleHosts.length, offlineHosts.length)}
            tone={onlineHosts === hosts.length && hosts.length > 0 ? "good" : hosts.length === 0 ? "muted" : "warn"}
          />
          <MetricCard
            label="Ready Lanes"
            value={`${readyCapacity}/${totalCapacity || 0}`}
            detail={totalCapacity > 0 ? `${availableHosts.length} host${pluralize(availableHosts.length)} ready for dispatch` : "No worker capacity reported"}
            tone={readyCapacity === 0 ? "warn" : "good"}
          />
          <MetricCard
            label="Active Jobs"
            value={String(activeJobs.length)}
            detail={`${statusCounts.running ?? 0} running, ${statusCounts.assigned ?? 0} assigned`}
            tone={activeJobs.length === 0 ? "muted" : "accent"}
          />
          <MetricCard
            label="Risk Signals"
            value={String(activeSignals)}
            detail={formatRiskSummary(
              staleHosts.length,
              offlineHosts.length,
              blockedJobs.length,
              warningAgents.length,
              verificationWarnings.length,
            )}
            tone={activeSignals === 0 ? "good" : "warn"}
          />
        </div>
      </section>

      <section className="card card-section">
        <div className="card-header">
          <div>
            <h2>Attention Board</h2>
            <p className="muted">
              The conditions that should change how you dispatch, verify, or pause before the next queue action.
            </p>
          </div>
          <span className={`pill ${activeSignals === 0 ? "pill-success" : "pill-IN_PROGRESS"}`}>
            {activeSignals === 0 ? "all clear" : `${activeSignals} active`}
          </span>
        </div>
        <div className="overview-alert-grid">
          {overviewAlerts.map((alert) => (
            <OverviewAlertCard key={alert.key} alert={alert} />
          ))}
        </div>
      </section>

      <section className="card">
        <div className="card-header">
          <div>
            <h2>Worker Hosts</h2>
            <p className="muted">
              Host readiness, lane usage, heartbeat freshness, and capability coverage from the federation scheduler.
            </p>
          </div>
          <div className="overview-section-badges">
            <span className="overview-section-badge">ready lanes {readyCapacity}</span>
            <span className="overview-section-badge">{staleHosts.length} stale</span>
            <span className="overview-section-badge">{onlineHosts} online</span>
          </div>
        </div>

        {queue.isLoading && <p>Loading worker hosts...</p>}
        {queue.isError && <p className="error">Failed to load worker host telemetry.</p>}
        {!queue.isLoading && !queue.isError && hosts.length === 0 && (
          <p className="empty-state">No worker heartbeats have been recorded yet.</p>
        )}
        {hosts.length > 0 && (
          <div className="overview-host-grid">
            {hosts.map((host) => (
              <WorkerHostCard key={host.id} host={host} jobs={jobs} />
            ))}
          </div>
        )}
      </section>

      <div className="overview-lower-grid">
        <section className="card card-section">
          <div className="card-header">
            <div>
              <h2>Dispatch Watch</h2>
              <p className="muted">
                Queue shape, running work, and the next signs of pressure before another task enters the swarm.
              </p>
            </div>
            <span className={`pill ${queueStatusPillClass(activeJobs.length, backlogJobs)}`}>
              {activeJobs.length > 0 ? "active" : "clear"}
            </span>
          </div>
          <div className="overview-status-grid">
            <StatusStat label="Queued" value={statusCounts.queued ?? 0} />
            <StatusStat label="Assigned" value={statusCounts.assigned ?? 0} />
            <StatusStat label="Running" value={statusCounts.running ?? 0} />
            <StatusStat label="Blocked" value={statusCounts.blocked ?? 0} />
            <StatusStat label="Completed" value={statusCounts.completed ?? 0} />
            <StatusStat label="Failed" value={statusCounts.failed ?? 0} />
          </div>
          <div className="overview-loadbar">
            <div className="overview-loadbar-track">
              <div className="overview-loadbar-fill" style={{ width: `${loadPercent}%` }} />
            </div>
            <div className="overview-loadbar-label">
              Worker utilization {currentLoad}/{totalCapacity || 0}
            </div>
          </div>
          <div className="overview-queue-list">
            {activeJobs.slice(0, 4).map((job) => (
              <div key={job.jobId} className="overview-queue-item">
                <div className="overview-queue-primary">
                  <div className="mono">{job.taskId}</div>
                  <div className="muted">{resolveJobHostLabel(job, hosts)}</div>
                </div>
                <FederationJobStatusPill status={job.status} />
                <div className="overview-queue-secondary">
                  <div>{job.nextAction ?? "in progress"}</div>
                  <div className="muted">Lease {formatDateTime(job.leaseExpiresAt)}</div>
                </div>
              </div>
            ))}
            {activeJobs.length === 0 && (
              <div className="empty-state">No active federated jobs right now.</div>
            )}
          </div>
        </section>

        <section className="card card-section">
          <div className="card-header">
            <div>
              <h2>Dispatch Readiness</h2>
              <p className="muted">
                Healthy hosts with fresh heartbeats and free lanes that can safely take the next task.
              </p>
            </div>
            <span className={`pill ${availableHosts.length > 0 ? "pill-success" : "pill-IN_PROGRESS"}`}>
              {availableHosts.length > 0 ? "ready" : "hold"}
            </span>
          </div>
          <div className="overview-ready-list">
            {availableHosts.slice(0, 4).map((host) => (
              <ReadyHostRow key={host.id} host={host} />
            ))}
            {availableHosts.length === 0 && (
              <div className="empty-state">No host has a fresh heartbeat and open lane right now.</div>
            )}
          </div>
          <div className="overview-footnote">
            Prefer fresh-heartbeat hosts with open lanes before forcing work onto a stale or saturated machine.
          </div>
        </section>

        <section className="card card-section">
          <div className="card-header">
            <div>
              <h2>Headnode Pulse</h2>
              <p className="muted">
                Monitor build, fleet posture, and local agent warnings that affect admin confidence.
              </p>
            </div>
            <span className={`pill ${healthPillClass(health.data?.status ?? "error")}`}>
              {health.data?.status ?? "offline"}
            </span>
          </div>
          <dl className="kv">
            <dt>Project root</dt>
            <dd className="mono">{health.data?.projectRoot ?? "-"}</dd>
            <dt>Build</dt>
            <dd>{formatDateTime(health.data?.builtAt)}</dd>
            <dt>Fleet state</dt>
            <dd>{fleetStatus.data?.state ?? "-"}</dd>
            <dt>Merge lane</dt>
            <dd>{queue.data?.summary?.mergeLaneActive ? "active" : "idle"}</dd>
            <dt>Connected clients</dt>
            <dd>{String(health.data?.clients ?? 0)}</dd>
            <dt>Local active jobs</dt>
            <dd>{String(health.data?.activeJobs ?? 0)}</dd>
            <dt>Agent alerts</dt>
            <dd>{String(warningAgents.length)}</dd>
            <dt>State authority</dt>
            <dd>{health.data?.stateAuthority ?? "-"}</dd>
            <dt>Local DB</dt>
            <dd>{health.data?.localDbAuthoritative === false ? "cache only" : "authoritative"}</dd>
            <dt>Legacy UI</dt>
            <dd>{health.data?.legacyUiPath ?? "-"}</dd>
          </dl>
          <div className="overview-agent-strip">
            {warningAgents.length > 0 ? (
              warningAgents.slice(0, 3).map((agent) => (
                <div key={agent.taskId} className="overview-agent-alert">
                  <span className={`overview-agent-dot ${agent.status}`} />
                  <div>
                    <div className="mono">{agent.taskId}</div>
                    <div className="muted">{agent.status} - {Math.round(agent.silentMs / 60000)}m quiet</div>
                  </div>
                </div>
              ))
            ) : (
              <div className="empty-state">No warning or stuck local agents.</div>
            )}
          </div>
        </section>
      </div>
    </div>
  );
}

function WorkerHostCard(props: { host: FederationHostSummary; jobs: FederationJobSummary[] }) {
  const { host, jobs } = props;
  const loadPercent = host.maxConcurrentJobs > 0
    ? Math.min(100, ((host.currentLoad || 0) / host.maxConcurrentJobs) * 100)
    : 0;
  const activeTaskIds = jobs
    .filter((job) => ACTIVE_JOB_STATUSES.has(job.status) && resolveJobHostId(job) === host.id)
    .map((job) => job.taskId);
  const hostStale = isHostStale(host.lastHealthCheckAt);
  const openSlots = availableSlots(host);
  const verificationToolingMissing = hasVerificationToolingWarning(host);
  const stateTone = hostStateTone(host, hostStale, openSlots);
  const stateLabel = hostStateLabel(host, hostStale, openSlots, activeTaskIds.length);

  return (
    <article className={`worker-host-card worker-host-card-${stateTone}`}>
      <div className="worker-host-header">
        <div>
          <div className="worker-host-role">{describeHostRole(host)}</div>
          <div className="worker-host-name">{host.alias || host.id}</div>
          {(host.alias && host.alias !== host.id) && (
            <div className="worker-host-id mono">{host.id}</div>
          )}
        </div>
        <span className={`pill ${hostStatusPillClass(host, hostStale, openSlots)}`}>
          {stateLabel}
        </span>
      </div>

      <div className={`worker-host-state worker-host-state-${stateTone}`}>
        {describeHostState(host, hostStale, openSlots, activeTaskIds.length)}
      </div>

      <div className="worker-host-load">
        <div className="worker-host-load-label">
          <span>Load</span>
          <strong>{host.currentLoad || 0}/{host.maxConcurrentJobs || 1}</strong>
        </div>
        <div className="worker-host-loadbar">
          <div className="worker-host-loadfill" style={{ width: `${loadPercent}%` }} />
        </div>
      </div>

      <div className="worker-host-metrics-grid">
        <HostMetricCard
          label="Heartbeat"
          value={formatHeartbeatAge(host.lastHealthCheckAt)}
          tone={hostStale ? "warn" : "good"}
        />
        <HostMetricCard
          label="Commit"
          value={formatCommit(host.repoCommit)}
          mono
          tone={host.repoCommit ? "neutral" : "warn"}
        />
        <HostMetricCard
          label="Open slots"
          value={String(openSlots)}
          tone={openSlots > 0 && host.healthy && !hostStale ? "good" : "warn"}
        />
        <HostMetricCard
          label="Assignments"
          value={String(activeTaskIds.length)}
          tone={activeTaskIds.length > 0 ? "accent" : "neutral"}
        />
        <HostMetricCard
          label="Runtime"
          value={host.runtimeRole ?? "unknown"}
          tone={host.runtimeRole === "worker" ? "good" : "warn"}
        />
        <HostMetricCard
          label="Protocol"
          value={host.protocolVersion ?? "legacy"}
          tone={host.protocolVersion ? "neutral" : "warn"}
        />
      </div>

      {activeTaskIds.length > 0 ? (
        <div className="worker-host-active-list">
          {activeTaskIds.map((taskId) => (
            <span key={taskId} className="worker-active-chip mono">
              {taskId}
            </span>
          ))}
        </div>
      ) : (
        <div className="worker-host-active-empty">No active assignments.</div>
      )}

      <div className="worker-host-capabilities">
        {host.capabilities.map((capability) => (
          <span key={capability} className="worker-cap-chip">{capability}</span>
        ))}
        {verificationToolingMissing && (
          <span className="worker-cap-chip warning">verify tooling missing</span>
        )}
      </div>

      {host.lastCommand && (
        <div className="worker-host-state worker-host-state-neutral">
          Last command: {host.lastCommand.kind} | {host.lastCommand.status}
          {host.lastCommand.message ? ` | ${host.lastCommand.message}` : ""}
        </div>
      )}
    </article>
  );
}

function HostMetricCard(props: {
  label: string;
  value: string;
  mono?: boolean;
  tone: "good" | "warn" | "accent" | "neutral";
}) {
  return (
    <div className={`worker-host-metric-card worker-host-metric-card-${props.tone}`}>
      <span>{props.label}</span>
      <strong className={props.mono ? "mono" : undefined}>{props.value}</strong>
    </div>
  );
}

function MetricCard(props: {
  label: string;
  value: string;
  detail?: string;
  tone?: "good" | "warn" | "accent" | "muted";
}) {
  return (
    <div className={`metric-card metric-card-${props.tone ?? "muted"}`}>
      <div className="metric-label">{props.label}</div>
      <div className="metric-value">{props.value}</div>
      {props.detail && <div className="metric-subtle">{props.detail}</div>}
    </div>
  );
}

function StatusStat(props: { label: string; value: number }) {
  return (
    <div className="overview-status-stat">
      <div className="overview-status-label">{props.label}</div>
      <div className="overview-status-value">{props.value}</div>
    </div>
  );
}

function OverviewAlertCard(props: { alert: OverviewAlert }) {
  const { alert } = props;
  return (
    <div className={`overview-alert-card overview-alert-card-${alert.tone}`}>
      <div className="overview-alert-label">{alert.title}</div>
      <div className="overview-alert-detail">{alert.detail}</div>
    </div>
  );
}

function ReadyHostRow(props: { host: FederationHostSummary }) {
  const { host } = props;
  return (
    <div className="overview-ready-item">
      <div>
        <div className="overview-ready-name">{host.alias || host.id}</div>
        <div className="muted">{describeHostRole(host)}</div>
      </div>
      <div className="overview-ready-meta">
        <strong>{availableSlots(host)} open</strong>
        <span>{formatHeartbeatAge(host.lastHealthCheckAt)}</span>
      </div>
    </div>
  );
}

function FederationJobStatusPill(props: { status: string }) {
  return (
    <span className={`pill ${federationJobPillClass(props.status)}`}>
      {props.status}
    </span>
  );
}

function healthPillClass(status: string): string {
  switch (status) {
    case "ok":
      return "pill-success";
    case "degraded":
      return "pill-IN_PROGRESS";
    default:
      return "pill-REJECTED";
  }
}

function fleetPillClass(state: string): string {
  switch (state) {
    case "running":
      return "pill-success";
    case "paused":
      return "pill-IN_PROGRESS";
    case "emergency_stopped":
      return "pill-REJECTED";
    default:
      return "pill-muted";
  }
}

function queueStatusPillClass(activeJobs: number, backlogJobs: number): string {
  if (backlogJobs > 0) return "pill-IN_PROGRESS";
  if (activeJobs > 0) return "pill-success";
  return "pill-muted";
}

function federationJobPillClass(status: string): string {
  switch (status) {
    case "running":
    case "completed":
      return "pill-success";
    case "assigned":
    case "queued":
    case "verifying":
    case "fixing":
      return "pill-IN_PROGRESS";
    case "failed":
    case "blocked":
    case "canceled":
      return "pill-REJECTED";
    default:
      return "pill-muted";
  }
}

function resolveJobHostId(job: FederationJobSummary): string | undefined {
  return job.assignedHostId ?? job.hostId ?? job.preferredHostId;
}

function resolveJobHostLabel(job: FederationJobSummary, hosts: FederationHostSummary[]): string {
  const hostId = resolveJobHostId(job);
  if (!hostId) return "unassigned";
  return hosts.find((host) => host.id === hostId)?.alias || hostId;
}

function formatCommit(value?: string): string {
  if (!value) return "-";
  return value.slice(0, 8);
}

function formatHeartbeatAge(value?: string): string {
  if (!value) return "never";
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return value;
  const deltaMs = Math.max(0, Date.now() - then);
  const seconds = Math.round(deltaMs / 1000);
  if (seconds < 60) return `${seconds}s ago`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}

function isHostStale(value?: string): boolean {
  if (!value) return true;
  const then = Date.parse(value);
  if (!Number.isFinite(then)) return true;
  return (Date.now() - then) > 5 * 60 * 1000;
}

function isHostAtCapacity(host: FederationHostSummary): boolean {
  return host.maxConcurrentJobs > 0 && (host.currentLoad || 0) >= host.maxConcurrentJobs;
}

function availableSlots(host: FederationHostSummary): number {
  return Math.max(0, (host.maxConcurrentJobs || 1) - (host.currentLoad || 0));
}

function isHostDispatchReady(host: FederationHostSummary): boolean {
  return host.healthy && !isHostStale(host.lastHealthCheckAt) && availableSlots(host) > 0;
}

function hasVerificationToolingWarning(host: FederationHostSummary): boolean {
  return host.capabilities.includes("verify")
    && host.metadata?.verificationToolchain === "missing";
}

function describeHostRole(host: FederationHostSummary): string {
  if (host.id === "headnode") {
    return "Headnode";
  }

  const focusAreas: string[] = [];
  if (host.capabilities.includes("browser")) focusAreas.push("browser");
  if (host.capabilities.includes("backend")) focusAreas.push("backend");
  if (host.capabilities.includes("auth")) focusAreas.push("auth");
  if (host.capabilities.includes("intake")) focusAreas.push("intake");
  if (host.capabilities.includes("verify")) focusAreas.push("verify");

  if (focusAreas.length === 0) {
    return "Swarm worker";
  }

  return `${focusAreas.slice(0, 2).join(" + ")} worker`;
}

function hostStateTone(
  host: FederationHostSummary,
  hostStale: boolean,
  openSlots: number,
): "good" | "warn" | "accent" | "critical" {
  if (!host.healthy) return "critical";
  if (hostStale) return "warn";
  if (openSlots === 0) return "accent";
  return "good";
}

function hostStatusPillClass(host: FederationHostSummary, hostStale: boolean, openSlots: number): string {
  if (!host.healthy) return "pill-REJECTED";
  if (hostStale) return "pill-IN_PROGRESS";
  if (openSlots === 0) return "pill-active";
  return "pill-success";
}

function hostStateLabel(
  host: FederationHostSummary,
  hostStale: boolean,
  openSlots: number,
  activeAssignments: number,
): string {
  if (!host.healthy) return "offline";
  if (hostStale) return "stale";
  if (openSlots === 0) return "busy";
  if (activeAssignments > 0) return "active";
  return "ready";
}

function describeHostState(
  host: FederationHostSummary,
  hostStale: boolean,
  openSlots: number,
  activeAssignments: number,
): string {
  if (!host.healthy) {
    return `Offline. Last heartbeat ${formatHeartbeatAge(host.lastHealthCheckAt)}.`;
  }
  if (hostStale) {
    return host.lastHealthCheckAt
      ? `Heartbeat is stale at ${formatHeartbeatAge(host.lastHealthCheckAt)}. Hold new dispatch unless needed.`
      : "No heartbeat recorded yet. Hold new dispatch unless needed.";
  }
  if (openSlots === 0) {
    return `At capacity with ${host.currentLoad || 0}/${host.maxConcurrentJobs || 1} lanes occupied.`;
  }
  if (activeAssignments > 0) {
    return `${openSlots} open lane${pluralize(openSlots)} with ${activeAssignments} active task${pluralize(activeAssignments)}.`;
  }
  return `${openSlots} open lane${pluralize(openSlots)}. Ready for the next dispatch.`;
}

function formatOnlineDetail(totalHosts: number, staleHosts: number, offlineHosts: number): string {
  if (totalHosts === 0) return "No workers registered";

  const details: string[] = [];
  if (staleHosts > 0) details.push(`${staleHosts} stale`);
  if (offlineHosts > 0) details.push(`${offlineHosts} offline`);

  if (details.length === 0) {
    return "No stale heartbeats";
  }

  return details.join(", ");
}

function formatRiskSummary(
  staleHosts: number,
  offlineHosts: number,
  blockedJobs: number,
  warningAgents: number,
  verificationWarnings: number,
): string {
  const details: string[] = [];
  if (offlineHosts > 0) details.push(`${offlineHosts} offline`);
  if (staleHosts > 0) details.push(`${staleHosts} stale`);
  if (blockedJobs > 0) details.push(`${blockedJobs} blocked`);
  if (warningAgents > 0) details.push(`${warningAgents} agent alert${pluralize(warningAgents)}`);
  if (verificationWarnings > 0) details.push(`${verificationWarnings} verify warning${pluralize(verificationWarnings)}`);
  return details.join(", ") || "No live risk flags";
}

function buildOverviewAlerts(input: {
  hosts: FederationHostSummary[];
  availableHosts: FederationHostSummary[];
  staleHosts: FederationHostSummary[];
  offlineHosts: FederationHostSummary[];
  saturatedHosts: FederationHostSummary[];
  blockedJobs: FederationJobSummary[];
  backlogJobs: number;
  warningAgents: number;
  verificationWarnings: number;
  stateAuthority?: "canonical" | "cache" | "localSmokeOnly";
  localDbAuthoritative?: boolean;
}): OverviewAlert[] {
  const workerAttentionCount = input.staleHosts.length + input.offlineHosts.length;

  return [
    {
      key: "authority",
      title: input.localDbAuthoritative === false ? "Local state is cache-only" : "Canonical state writer",
      detail: input.localDbAuthoritative === false
        ? `Shared task, verified, review, and merge state must use the ${input.stateAuthority ?? "cache"} headnode path`
        : "This monitor can write canonical task, verified, review, and merge state",
      tone: input.localDbAuthoritative === false ? "warn" : "good",
    },
    {
      key: "dispatch",
      title: input.availableHosts.length > 0 ? "Dispatch lanes available" : "Dispatch lanes saturated",
      detail: input.availableHosts.length > 0
        ? `${input.availableHosts.length} host${pluralize(input.availableHosts.length)} can take work now`
        : "No host currently has both a fresh heartbeat and free capacity",
      tone: input.availableHosts.length > 0 ? "good" : "critical",
    },
    {
      key: "workers",
      title: workerAttentionCount > 0 ? "Worker attention needed" : "Worker heartbeats clean",
      detail: workerAttentionCount > 0
        ? `${input.staleHosts.length} stale, ${input.offlineHosts.length} offline`
        : `${input.hosts.length} host${pluralize(input.hosts.length)} reporting with fresh health checks`,
      tone: workerAttentionCount > 0 ? "warn" : "good",
    },
    {
      key: "queue",
      title: input.blockedJobs.length > 0 ? "Blocked work in queue" : input.backlogJobs > 0 ? "Backlog waiting" : "Queue is clear",
      detail: input.blockedJobs.length > 0
        ? `${input.blockedJobs.length} blocked job${pluralize(input.blockedJobs.length)} need follow-up`
        : input.backlogJobs > 0
          ? `${input.backlogJobs} job${pluralize(input.backlogJobs)} waiting for lanes or remediation`
          : `${input.saturatedHosts.length} saturated host${pluralize(input.saturatedHosts.length)} right now`,
      tone: input.blockedJobs.length > 0 ? "critical" : input.backlogJobs > 0 ? "warn" : "muted",
    },
    {
      key: "agents",
      title: input.warningAgents > 0 ? "Local agent noise" : input.verificationWarnings > 0 ? "Verify tool drift" : "Agent watch is quiet",
      detail: input.warningAgents > 0
        ? `${input.warningAgents} warning or stuck local agent${pluralize(input.warningAgents)}`
        : input.verificationWarnings > 0
          ? `${input.verificationWarnings} host${pluralize(input.verificationWarnings)} missing verify tooling`
          : "No local warning agents or verify toolchain drift detected",
      tone: input.warningAgents > 0 ? "warn" : input.verificationWarnings > 0 ? "accent" : "good",
    },
  ];
}

function compareHostsForOverview(left: FederationHostSummary, right: FederationHostSummary): number {
  const score = hostOverviewRank(left) - hostOverviewRank(right);
  if (score !== 0) return score;
  return (left.alias || left.id).localeCompare(right.alias || right.id);
}

function hostOverviewRank(host: FederationHostSummary): number {
  if (host.id === "headnode") return -100;
  if (!host.healthy) return -80;
  if (isHostStale(host.lastHealthCheckAt)) return -60;
  if (isHostAtCapacity(host)) return -20;
  return 0;
}

function pluralize(value: number): string {
  return value === 1 ? "" : "s";
}
