import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  getQueue,
  queueAbort,
  queueCancel,
  queuePause,
  queueRemove,
  queueResume,
  queueRetry,
  queueStart,
  queueStop,
} from "../api/client";
import type { QueueItemSummary, QueueSummaryResponse } from "../api/contracts";
import { PageHeader } from "../components/PageHeader";
import { confirmDialog } from "../components/ConfirmDialog";
import { toast } from "../components/Toast";

const ITEM_STATUS_ORDER: Record<string, number> = {
  running: 0,
  ready: 1,
  queued: 2,
  blocked: 3,
  failed: 4,
  completed: 5,
  skipped: 6,
  stopped: 7,
};

export function QueuePage() {
  const queryClient = useQueryClient();
  const queue = useQuery({
    queryKey: ["queue"],
    queryFn: getQueue,
    refetchInterval: 5000,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["queue"] });
  };

  const startQ = useMutation({
    mutationFn: queueStart,
    onSuccess: () => {
      toast.success("Queue started");
      invalidate();
    },
    onError: (error) => {
      toast.error("Start failed", error instanceof Error ? error.message : String(error));
    },
  });

  const pauseQ = useMutation({
    mutationFn: () => queuePause("Manual pause from UI 2.0"),
    onSuccess: () => {
      toast.success("Queue paused");
      invalidate();
    },
    onError: (error) => {
      toast.error("Pause failed", error instanceof Error ? error.message : String(error));
    },
  });

  const resumeQ = useMutation({
    mutationFn: queueResume,
    onSuccess: () => {
      toast.success("Queue resumed");
      invalidate();
    },
    onError: (error) => {
      toast.error("Resume failed", error instanceof Error ? error.message : String(error));
    },
  });

  const stopQ = useMutation({
    mutationFn: queueStop,
    onSuccess: () => {
      toast.success("Queue stopped");
      invalidate();
    },
    onError: (error) => {
      toast.error("Stop failed", error instanceof Error ? error.message : String(error));
    },
  });

  const abortQ = useMutation({
    mutationFn: queueAbort,
    onSuccess: () => {
      toast.success("Queue aborted", "Active task killed");
      invalidate();
    },
    onError: (error) => {
      toast.error("Abort failed", error instanceof Error ? error.message : String(error));
    },
  });

  const cancelItem = useMutation({
    mutationFn: (taskId: string) => queueCancel(taskId),
    onSuccess: (_, taskId) => {
      toast.success(`${taskId} cancelled`);
      invalidate();
    },
    onError: (error, taskId) => {
      toast.error(`Cancel failed for ${taskId}`, error instanceof Error ? error.message : String(error));
    },
  });

  const retryItem = useMutation({
    mutationFn: (taskId: string) => queueRetry(taskId),
    onSuccess: (_, taskId) => {
      toast.success(`${taskId} re-queued`);
      invalidate();
    },
    onError: (error, taskId) => {
      toast.error(`Retry failed for ${taskId}`, error instanceof Error ? error.message : String(error));
    },
  });

  const removeItem = useMutation({
    mutationFn: (taskId: string) => queueRemove(taskId),
    onSuccess: (_, taskId) => {
      toast.success(`${taskId} removed`);
      invalidate();
    },
    onError: (error, taskId) => {
      toast.error(`Remove failed for ${taskId}`, error instanceof Error ? error.message : String(error));
    },
  });

  const confirmStopQueue = (): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: "Stop queue?",
        message: "Allow the active task to finish, then halt new dispatches.",
        confirmLabel: "Stop",
      });
      if (ok) {
        stopQ.mutate();
      }
    })();
  };

  const confirmAbortQueue = (): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: "Abort queue?",
        message: "Kill all running queue work immediately. Use only when something is wedged.",
        confirmLabel: "Abort",
        danger: true,
      });
      if (ok) {
        abortQ.mutate();
      }
    })();
  };

  const confirmCancelItem = (item: QueueItemSummary): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: `Cancel ${item.taskId}?`,
        message: item.status === "running"
          ? "Stop the active dispatch and mark this queue item stopped."
          : "Mark this queued item stopped. You can remove it afterward if needed.",
        confirmLabel: "Cancel",
        danger: item.status === "running",
      });
      if (ok) {
        cancelItem.mutate(item.taskId);
      }
    })();
  };

  const confirmRemoveItem = (taskId: string): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: `Remove ${taskId}?`,
        message: "Permanently remove this item from the queue history.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (ok) {
        removeItem.mutate(taskId);
      }
    })();
  };

  const running = queue.data?.running ?? false;
  const paused = queue.data?.paused ?? false;
  const canAbort = running || paused;
  const items = queue.data ? [...queue.data.items].sort(sortQueueItems) : [];
  const queueState = queue.data ? queueStateMeta(queue.data) : { label: "Idle", pillClass: "pill-BACKLOG" };
  const maxConcurrent = queue.data?.maxConcurrent ?? queue.data?.config.maxConcurrent;

  return (
    <div className="page">
      <PageHeader
        title="Local Dispatch Queue"
        subtitle="DispatchQueue state. Federation queue lives under Fleet."
      >
        {!running && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => startQ.mutate()}
            disabled={startQ.isPending}
          >
            Start
          </button>
        )}
        {running && !paused && (
          <button
            type="button"
            className="btn"
            onClick={() => pauseQ.mutate()}
            disabled={pauseQ.isPending}
          >
            Pause
          </button>
        )}
        {running && paused && (
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => resumeQ.mutate()}
            disabled={resumeQ.isPending}
          >
            Resume
          </button>
        )}
        {(running || paused) && (
          <button
            type="button"
            className="btn"
            onClick={confirmStopQueue}
            disabled={stopQ.isPending}
          >
            Stop
          </button>
        )}
        {canAbort && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={confirmAbortQueue}
            disabled={abortQ.isPending}
          >
            Abort
          </button>
        )}
      </PageHeader>

      <section className="card">
        {queue.isLoading && !queue.data && <p>Loading...</p>}
        {queue.isError && <p className="error">Failed to load queue.</p>}
        {queue.data && (
          <>
            <p className="muted">
              <span className={`pill ${queueState.pillClass}`}>{queueState.label}</span>
              {" | "}{queue.data.stats.total} items
              {" | "}{queue.data.stats.running} running
              {" | "}{queue.data.stats.ready} ready
              {typeof maxConcurrent === "number" && ` | maxConcurrent=${maxConcurrent}`}
              {queue.data.activeTaskIds.length > 0 && ` | active: ${queue.data.activeTaskIds.join(", ")}`}
              {queue.data.paused && queue.data.pauseReason && ` | reason: ${queue.data.pauseReason}`}
              {" | "}{formatCurrency(queue.data.stats.totalCostUsd)} spent
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Task</th>
                  <th>Status</th>
                  <th>Priority</th>
                  <th>Enqueued</th>
                  <th>Detail</th>
                  <th style={{ width: 220 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {items.length === 0 && (
                  <tr>
                    <td colSpan={6} className="muted" style={{ textAlign: "center", padding: 24 }}>
                      Queue is empty.
                    </td>
                  </tr>
                )}
                {items.map((item) => {
                  const canCancel = item.status === "queued" || item.status === "ready" || item.status === "running";
                  const canRetry = item.status === "failed";
                  const canRemove = !canCancel && item.status !== "running";
                  const detail = queueItemDetail(item);
                  const isProblemRow = item.status === "failed" || item.status === "blocked";

                  return (
                    <tr key={item.taskId}>
                      <td className="mono">
                        <Link to={`/tasks/${encodeURIComponent(item.taskId)}`}>{item.taskId}</Link>
                      </td>
                      <td>
                        <span className={`pill ${queueItemStatusPillClass(item.status)}`}>
                          {displayLabel(item.status)}
                        </span>
                      </td>
                      <td>{item.priority ?? "-"}</td>
                      <td className="muted">{formatTimestamp(item.enqueuedAt)}</td>
                      <td
                        className={isProblemRow ? "error" : "muted"}
                        style={{ maxWidth: 280, overflow: "hidden", textOverflow: "ellipsis" }}
                        title={detail}
                      >
                        {detail}
                      </td>
                      <td>
                        <div className="btn-row">
                          {canCancel && (
                            <button
                              type="button"
                              className="btn btn-sm"
                              onClick={() => confirmCancelItem(item)}
                              disabled={cancelItem.isPending && cancelItem.variables === item.taskId}
                            >
                              Cancel
                            </button>
                          )}
                          {canRetry && (
                            <button
                              type="button"
                              className="btn btn-sm btn-primary"
                              onClick={() => retryItem.mutate(item.taskId)}
                              disabled={retryItem.isPending && retryItem.variables === item.taskId}
                            >
                              Retry
                            </button>
                          )}
                          {canRemove && (
                            <button
                              type="button"
                              className="btn btn-sm btn-danger"
                              onClick={() => confirmRemoveItem(item.taskId)}
                              disabled={removeItem.isPending && removeItem.variables === item.taskId}
                            >
                              Remove
                            </button>
                          )}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </>
        )}
      </section>
    </div>
  );
}

function sortQueueItems(a: QueueItemSummary, b: QueueItemSummary): number {
  const statusDelta = (ITEM_STATUS_ORDER[a.status] ?? 99) - (ITEM_STATUS_ORDER[b.status] ?? 99);
  if (statusDelta !== 0) {
    return statusDelta;
  }

  const priorityDelta = (a.priorityWeight ?? 99) - (b.priorityWeight ?? 99);
  if (priorityDelta !== 0) {
    return priorityDelta;
  }

  return (a.enqueuedAt ?? "").localeCompare(b.enqueuedAt ?? "");
}

function queueStateMeta(queue: QueueSummaryResponse): { label: string; pillClass: string } {
  switch (queue.state) {
    case "running":
      return { label: "Running", pillClass: "pill-IN_PROGRESS" };
    case "waiting":
      return { label: "Waiting", pillClass: "pill-READY" };
    case "paused":
      return { label: "Paused", pillClass: "pill-ON_HOLD" };
    case "done":
      return { label: "Done", pillClass: "pill-COMPLETE" };
    case "stopped":
      return { label: "Stopped", pillClass: "pill-ON_HOLD" };
    case "idle":
    default:
      return { label: "Idle", pillClass: "pill-BACKLOG" };
  }
}

function queueItemStatusPillClass(status: string): string {
  switch (status) {
    case "running":
      return "pill-IN_PROGRESS";
    case "ready":
      return "pill-READY";
    case "completed":
      return "pill-COMPLETE";
    case "failed":
    case "blocked":
      return "pill-BLOCKED";
    case "skipped":
    case "stopped":
      return "pill-ON_HOLD";
    case "queued":
    default:
      return "pill-BACKLOG";
  }
}

function queueItemDetail(item: QueueItemSummary): string {
  if (item.error) {
    return item.error;
  }
  if (item.blockedReason) {
    return item.blockedReason;
  }
  if (item.blockedBy && item.blockedBy.length > 0) {
    return `Waiting on ${item.blockedBy.join(", ")}`;
  }
  if (item.status === "running" && item.startedAt) {
    return `Started ${formatTimestamp(item.startedAt)}`;
  }
  if (item.outcome) {
    return displayLabel(item.outcome);
  }
  if (item.completedAt) {
    return `Finished ${formatTimestamp(item.completedAt)}`;
  }
  return "-";
}

function displayLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function formatCurrency(value: number | null | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "$0.00";
}

function formatTimestamp(value: string | undefined): string {
  if (!value) {
    return "-";
  }
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}
