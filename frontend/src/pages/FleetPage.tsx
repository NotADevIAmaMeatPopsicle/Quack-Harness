import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  cancelFederationJob,
  fleetEmergencyStop,
  fleetPause,
  fleetResume,
  getFederationQueue,
  getFleetHealth,
  getFleetStatus,
  getFleetVelocity,
} from "../api/client";
import type { FederationJobSummary } from "../api/contracts";
import { confirmDialog } from "../components/ConfirmDialog";
import { PageHeader } from "../components/PageHeader";
import { toast } from "../components/Toast";
import { formatCurrency, formatDateTime, formatSilentDuration } from "../lib/format";

export function FleetPage() {
  const queryClient = useQueryClient();
  const queue = useQuery({
    queryKey: ["federation-queue"],
    queryFn: getFederationQueue,
    refetchInterval: 5000,
  });
  const status = useQuery({
    queryKey: ["fleet-status"],
    queryFn: getFleetStatus,
    refetchInterval: 5000,
  });
  const velocity = useQuery({
    queryKey: ["fleet-velocity"],
    queryFn: getFleetVelocity,
    refetchInterval: 5000,
  });
  const health = useQuery({
    queryKey: ["fleet-health"],
    queryFn: getFleetHealth,
    refetchInterval: 5000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["federation-queue"] });
    void queryClient.invalidateQueries({ queryKey: ["fleet-status"] });
    void queryClient.invalidateQueries({ queryKey: ["fleet-velocity"] });
    void queryClient.invalidateQueries({ queryKey: ["fleet-health"] });
  };

  const pauseFleet = useMutation({
    mutationFn: () => fleetPause("Manual pause from UI 2.0"),
    onSuccess: () => {
      toast.success("Fleet paused");
      invalidate();
    },
    onError: (error: unknown) => {
      toast.error("Failed to pause fleet", error instanceof Error ? error.message : String(error));
    },
  });

  const resumeFleet = useMutation({
    mutationFn: fleetResume,
    onSuccess: () => {
      toast.success("Fleet resumed");
      invalidate();
    },
    onError: (error: unknown) => {
      toast.error("Failed to resume fleet", error instanceof Error ? error.message : String(error));
    },
  });

  const emergencyStop = useMutation({
    mutationFn: () => fleetEmergencyStop("Emergency stop from UI 2.0"),
    onSuccess: () => {
      toast.success("Emergency stop sent");
      invalidate();
    },
    onError: (error: unknown) => {
      toast.error("Emergency stop failed", error instanceof Error ? error.message : String(error));
    },
  });

  const cancelJob = useMutation({
    mutationFn: (job: FederationJobSummary) => cancelFederationJob(job.jobId, job.projectId),
    onSuccess: (_, job) => {
      toast.success(`Canceled ${job.jobId}`);
      invalidate();
    },
    onError: (error: unknown, job) => {
      toast.error(
        `Failed to cancel ${job.jobId}`,
        error instanceof Error ? error.message : String(error),
      );
    },
  });

  const confirmEmergencyStop = (): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: "Emergency stop fleet?",
        message: "This kills active work immediately and aborts the local dispatch queue.",
        confirmLabel: "Emergency stop",
        danger: true,
      });
      if (ok) {
        emergencyStop.mutate();
      }
    })();
  };

  const confirmCancelJob = (job: FederationJobSummary): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: `Cancel ${job.jobId}?`,
        message: `Cancel federated work for ${job.taskId}.`,
        confirmLabel: "Cancel job",
        danger: true,
      });
      if (ok) {
        cancelJob.mutate(job);
      }
    })();
  };

  const activeAgents = health.data?.agents ?? [];
  const warningAgents = activeAgents.filter(
    (agent) =>
      agent.status === "warning" || agent.status === "critical" || agent.status === "stuck",
  );
  const activeSnapshots = velocity.data?.activeSnapshots ?? [];
  const canPause = status.data?.state === "running";
  const canResume = status.data?.state === "paused" || status.data?.state === "emergency_stopped";

  return (
    <div className="page">
      <PageHeader
        title="Fleet"
        subtitle="Federation queue, listener hosts, and fleet-wide controls."
      >
        {status.data && (
          <span className={`pill ${fleetPillClass(status.data.state)}`}>{status.data.state}</span>
        )}
        {canPause && (
          <button
            type="button"
            className="btn"
            onClick={() => pauseFleet.mutate()}
            disabled={pauseFleet.isPending}
          >
            Pause
          </button>
        )}
        {canResume && (
          <button
            type="button"
            className="btn"
            onClick={() => resumeFleet.mutate()}
            disabled={resumeFleet.isPending}
          >
            Resume
          </button>
        )}
        <button
          type="button"
          className="btn btn-danger"
          onClick={confirmEmergencyStop}
          disabled={emergencyStop.isPending}
        >
          Emergency stop
        </button>
      </PageHeader>

      {queue.data?.summary?.listenerRegistry?.healthy === false && (
        <div className="card" role="alert">
          <strong>Listener registry needs attention</strong>
          <p>Valid workers remain listed below. Invalid registrations cannot receive work.</p>
          <ul>
            {queue.data.summary.listenerRegistry.issues.map((issue) => (
              <li key={`${issue.file}:${issue.code}`}>
                <code>{issue.file}</code>: {issue.reason}
              </li>
            ))}
          </ul>
        </div>
      )}

      <section className="card">
        <div className="metrics-grid">
          <MetricCard
            label="Fleet state"
            value={status.data?.state ?? "-"}
            detail={status.data?.reason ?? "No fleet pause reason"}
          />
          <MetricCard
            label="Active jobs"
            value={String(status.data?.activeJobs ?? 0)}
            detail={`${queue.data?.jobs.length ?? 0} visible federation jobs`}
          />
          <MetricCard
            label="Velocity watch"
            value={String(activeSnapshots.length)}
            detail={velocity.data?.config.enabled ? "active snapshots" : "disabled"}
          />
          <MetricCard
            label="Agent health alerts"
            value={String(warningAgents.length)}
            detail={`${activeAgents.length} tracked agents`}
          />
        </div>
      </section>

      {queue.data?.listeners && queue.data.listeners.length > 0 && (
        <section className="card">
          <h2>Listeners</h2>
          <table className="table">
            <thead>
              <tr>
                <th>Host</th>
                <th>Status</th>
                <th>Active jobs</th>
                <th>Max concurrent</th>
                <th>Capabilities</th>
                <th>Last heartbeat</th>
              </tr>
            </thead>
            <tbody>
              {queue.data.listeners.map((host) => (
                <tr key={host.hostId}>
                  <td className="mono">{host.hostId}</td>
                  <td>{host.status}</td>
                  <td>{host.activeJobs ?? 0}</td>
                  <td>{host.maxConcurrent ?? 1}</td>
                  <td className="muted">{host.capabilities?.join(", ") || "-"}</td>
                  <td className="muted">{formatDateTime(host.lastHeartbeatAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </section>
      )}

      <section className="card">
        <h2>Federation Queue</h2>
        {queue.isLoading && <p>Loading...</p>}
        {queue.isError && <p className="error">Failed to load federation queue.</p>}
        {queue.data && (
          <table className="table">
            <thead>
              <tr>
                <th>Job</th>
                <th>Task</th>
                <th>Status</th>
                <th>Next action</th>
                <th>Host</th>
                <th>Lease expires</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {queue.data.jobs.map((job) => (
                <tr key={job.jobId}>
                  <td className="mono">{job.jobId}</td>
                  <td className="mono">{job.taskId}</td>
                  <td>{job.status}</td>
                  <td>{job.nextAction ?? "-"}</td>
                  <td className="mono">{job.assignedHostId ?? job.preferredHostId ?? "-"}</td>
                  <td className="muted">{formatDateTime(job.leaseExpiresAt)}</td>
                  <td>
                    <div className="table-actions">
                      {canCancelJob(job.status) && (
                        <button
                          type="button"
                          className="btn btn-sm btn-danger"
                          onClick={() => confirmCancelJob(job)}
                          disabled={cancelJob.isPending}
                        >
                          Cancel
                        </button>
                      )}
                    </div>
                  </td>
                </tr>
              ))}
              {queue.data.jobs.length === 0 && (
                <tr>
                  <td colSpan={7} className="empty-state">
                    No federated jobs are queued right now.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Cost Velocity</h2>
        {!velocity.data && <p className="empty-state">No velocity data yet.</p>}
        {velocity.data && (
          <>
            <p className="muted">
              {velocity.data.config.enabled
                ? `Warn ${velocity.data.config.warnMultiplier}x, kill ${velocity.data.config.killMultiplier}x`
                : "Cost velocity monitoring is disabled."}
              {velocity.data.baseline &&
                ` Baseline ${velocity.data.baseline.medianCostPerMinute.toFixed(4)}/min across ${velocity.data.baseline.sampleCount} tasks.`}
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Multiplier</th>
                  <th>Cost/min</th>
                  <th>Current cost</th>
                </tr>
              </thead>
              <tbody>
                {activeSnapshots.map((snapshot) => (
                  <tr key={snapshot.taskId}>
                    <td className="mono">{snapshot.taskId}</td>
                    <td>{snapshot.status}</td>
                    <td>{snapshot.multiplier.toFixed(1)}x</td>
                    <td>{formatCurrency(snapshot.costPerMinute)}</td>
                    <td>{formatCurrency(snapshot.currentCostUsd)}</td>
                  </tr>
                ))}
                {activeSnapshots.length === 0 && (
                  <tr>
                    <td colSpan={5} className="empty-state">
                      No active dispatches to monitor.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </>
        )}
      </section>

      <section className="card">
        <h2>Agent Health</h2>
        {health.isError && <p className="error">Failed to load active agent health.</p>}
        {health.data && (
          <table className="table">
            <thead>
              <tr>
                <th>Task</th>
                <th>Status</th>
                <th>Silent</th>
                <th>Last activity</th>
                <th>Turns</th>
                <th>Cost</th>
              </tr>
            </thead>
            <tbody>
              {health.data.agents.map((agent) => (
                <tr key={agent.taskId}>
                  <td className="mono">{agent.taskId}</td>
                  <td>{agent.status}</td>
                  <td>{formatSilentDuration(agent.silentMs)}</td>
                  <td className="muted">
                    {agent.lastActivity
                      ? `${agent.lastActivity.type}: ${agent.lastActivity.detail}`
                      : "-"}
                  </td>
                  <td>{agent.turnCount}</td>
                  <td>{formatCurrency(agent.cumulativeCostUsd)}</td>
                </tr>
              ))}
              {health.data.agents.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-state">
                    No active local agents are being tracked right now.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}

function MetricCard(props: { label: string; value: string; detail?: string }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{props.label}</div>
      <div className="metric-value">{props.value}</div>
      {props.detail && <div className="metric-subtle">{props.detail}</div>}
    </div>
  );
}

function canCancelJob(status: string): boolean {
  return !["completed", "failed", "rejected", "blocked", "canceled", "merged"].includes(status);
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
