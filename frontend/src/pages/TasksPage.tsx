import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import {
  listTasks,
  prepTask,
  startTask,
  stopTask,
  updateTaskStatus,
} from "../api/client";
import { TASK_STATUSES, type TaskStatus, type TaskSummary } from "../api/contracts";
import { PageHeader } from "../components/PageHeader";
import { confirmDialog } from "../components/ConfirmDialog";
import { toast } from "../components/Toast";

const PER_PAGE_OPTIONS = [25, 50, 100, 200];
const STATUS_FILTER_OPTIONS = [
  { value: "", label: "All statuses" },
  { value: "BACKLOG,READY", label: "Open (Backlog + Ready)" },
  { value: "IN_PROGRESS", label: "In progress" },
  { value: "VERIFYING", label: "Verifying" },
  { value: "COMPLETE,VERIFIED", label: "Done" },
  { value: "BLOCKED,ON_HOLD", label: "Blocked" },
  { value: "REJECTED", label: "Rejected" },
];

export function TasksPage() {
  const queryClient = useQueryClient();
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [status, setStatus] = useState("");
  const [q, setQ] = useState("");
  const [qDraft, setQDraft] = useState("");
  const [sort, setSort] = useState("id");
  const [order, setOrder] = useState<"asc" | "desc">("asc");

  const tasks = useQuery({
    queryKey: ["tasks", { page, perPage, status, q, sort, order }],
    queryFn: () => listTasks({ page, perPage, status, q, sort, order }),
    placeholderData: (prev) => prev,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };

  const confirmStartTask = (taskId: string): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: `Start ${taskId}?`,
        message: `Dispatch ${taskId} via the readiness gate. This will spend tokens.`,
        confirmLabel: "Start",
      });
      if (ok) start.mutate(taskId);
    })();
  };

  const confirmStopTask = (taskId: string): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: `Stop ${taskId}?`,
        message: "This kills the running dispatch. The task can be re-started later.",
        confirmLabel: "Stop",
        danger: true,
      });
      if (ok) stop.mutate(taskId);
    })();
  };

  const start = useMutation({
    mutationFn: (taskId: string) => startTask(taskId),
    onSuccess: (data, taskId) => {
      toast.success(`Started ${taskId}`, data.jobId ? `Job ${data.jobId}` : data.message);
      invalidate();
    },
    onError: (err: unknown, taskId) => {
      toast.error(`Failed to start ${taskId}`, err instanceof Error ? err.message : String(err));
    },
  });

  const stop = useMutation({
    mutationFn: (taskId: string) => stopTask(taskId),
    onSuccess: (_, taskId) => {
      toast.success(`Stopped ${taskId}`);
      invalidate();
    },
    onError: (err, taskId) => {
      toast.error(`Failed to stop ${taskId}`, err instanceof Error ? err.message : String(err));
    },
  });

  const prep = useMutation({
    mutationFn: (taskId: string) => prepTask(taskId),
    onSuccess: (_, taskId) => {
      toast.success(`Prep started for ${taskId}`);
      invalidate();
    },
    onError: (err, taskId) => {
      toast.error(`Prep failed for ${taskId}`, err instanceof Error ? err.message : String(err));
    },
  });

  const setStatusM = useMutation({
    mutationFn: ({ taskId, newStatus }: { taskId: string; newStatus: TaskStatus }) =>
      updateTaskStatus(taskId, newStatus),
    onSuccess: (_, vars) => {
      toast.success(`${vars.taskId} → ${vars.newStatus}`);
      invalidate();
    },
    onError: (err, vars) => {
      toast.error(`Status update failed for ${vars.taskId}`, err instanceof Error ? err.message : String(err));
    },
  });

  const onSubmitSearch = (e: React.FormEvent) => {
    e.preventDefault();
    setQ(qDraft.trim());
    setPage(1);
  };

  const sortBy = (field: string) => {
    if (sort === field) {
      setOrder((o) => (o === "asc" ? "desc" : "asc"));
    } else {
      setSort(field);
      setOrder("asc");
    }
    setPage(1);
  };

  return (
    <div className="page">
      <PageHeader
        title="Tasks"
        subtitle="Backlog. Click a task ID to drill in. Status edit + Start/Prep/Stop are inline."
      />

      <form className="toolbar" onSubmit={onSubmitSearch}>
        <input
          type="search"
          className="input"
          placeholder="Search title or ID…"
          value={qDraft}
          onChange={(e) => setQDraft(e.target.value)}
          style={{ minWidth: 220 }}
        />
        <button type="submit" className="btn btn-sm">Search</button>
        <select
          className="input"
          value={status}
          onChange={(e) => { setStatus(e.target.value); setPage(1); }}
        >
          {STATUS_FILTER_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>{opt.label}</option>
          ))}
        </select>
        <span className="toolbar-spacer" />
        <span className="toolbar-label">Per page</span>
        <select
          className="input"
          value={perPage}
          onChange={(e) => { setPerPage(Number(e.target.value)); setPage(1); }}
        >
          {PER_PAGE_OPTIONS.map((n) => <option key={n} value={n}>{n}</option>)}
        </select>
      </form>

      <section className="card">
        {tasks.isLoading && !tasks.data && <p>Loading…</p>}
        {tasks.isError && <p className="error">Failed to load tasks.</p>}
        {tasks.data && (
          <>
            <p className="muted">
              {tasks.data.filteredTaskCount} of {tasks.data.taskCount} tasks
              {tasks.data.pagination && (
                <> · page {tasks.data.pagination.page} of {tasks.data.pagination.totalPages}</>
              )}
              {tasks.data.parseErrors.length > 0 && (
                <> · <span className="error">{tasks.data.parseErrors.length} parse errors</span></>
              )}
            </p>
            <table className="table">
              <thead>
                <tr>
                  <SortableTh field="id" sort={sort} order={order} onClick={sortBy}>ID</SortableTh>
                  <SortableTh field="title" sort={sort} order={order} onClick={sortBy}>Title</SortableTh>
                  <SortableTh field="priority" sort={sort} order={order} onClick={sortBy}>Priority</SortableTh>
                  <th>Status</th>
                  <th style={{ width: 280 }}>Actions</th>
                </tr>
              </thead>
              <tbody>
                {tasks.data.tasks.map((task) => (
                  <TaskRow
                    key={task.id}
                    task={task}
                    busy={
                      (start.isPending && start.variables === task.id)
                      || (stop.isPending && stop.variables === task.id)
                      || (prep.isPending && prep.variables === task.id)
                      || (setStatusM.isPending && setStatusM.variables?.taskId === task.id)
                    }
                    onStart={() => confirmStartTask(task.id)}
                    onStop={() => confirmStopTask(task.id)}
                    onPrep={() => prep.mutate(task.id)}
                    onStatusChange={(newStatus) => setStatusM.mutate({ taskId: task.id, newStatus })}
                  />
                ))}
                {tasks.data.tasks.length === 0 && (
                  <tr><td colSpan={5} className="muted" style={{ textAlign: "center", padding: 24 }}>
                    No tasks match the current filters.
                  </td></tr>
                )}
              </tbody>
            </table>

            {tasks.data.pagination && tasks.data.pagination.totalPages > 1 && (
              <div className="pagination">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!tasks.data.pagination.hasPreviousPage}
                  onClick={() => setPage((p) => Math.max(1, p - 1))}
                >‹ Prev</button>
                <span className="muted">
                  Page {tasks.data.pagination.page} of {tasks.data.pagination.totalPages}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!tasks.data.pagination.hasNextPage}
                  onClick={() => setPage((p) => p + 1)}
                >Next ›</button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function SortableTh({
  field, sort, order, onClick, children,
}: {
  field: string;
  sort: string;
  order: "asc" | "desc";
  onClick: (field: string) => void;
  children: React.ReactNode;
}) {
  const isActive = sort === field;
  return (
    <th>
      <button
        type="button"
        className="btn btn-sm"
        onClick={() => onClick(field)}
        style={{ background: "transparent", border: "none", color: isActive ? "var(--accent)" : "var(--muted)", padding: 0 }}
      >
        {children} {isActive ? (order === "asc" ? "↑" : "↓") : ""}
      </button>
    </th>
  );
}

function TaskRow({
  task, busy, onStart, onStop, onPrep, onStatusChange,
}: {
  task: TaskSummary;
  busy: boolean;
  onStart: () => void;
  onStop: () => void;
  onPrep: () => void;
  onStatusChange: (newStatus: TaskStatus) => void;
}) {
  const status = task.effectiveStatus ?? task.status;
  const inProgress = status === "IN_PROGRESS" || status === "VERIFYING";
  return (
    <tr>
      <td className="mono">
        <Link to={`/tasks/${encodeURIComponent(task.id)}`}>{task.id}</Link>
      </td>
      <td>{task.title}</td>
      <td>{task.priority}</td>
      <td>
        <select
          className="input"
          value={task.status}
          onChange={(e) => onStatusChange(e.target.value as TaskStatus)}
          disabled={busy}
          aria-label={`Status for ${task.id}`}
        >
          {TASK_STATUSES.map((s) => <option key={s} value={s}>{s}</option>)}
        </select>
        {task.effectiveStatus && task.effectiveStatus !== task.status && (
          <span className={"pill pill-" + status} style={{ marginLeft: 6 }}>
            eff: {status}
          </span>
        )}
      </td>
      <td>
        <div className="btn-row">
          {!inProgress && (
            <button type="button" className="btn btn-sm btn-primary" onClick={onStart} disabled={busy}>
              Start
            </button>
          )}
          {inProgress && (
            <button type="button" className="btn btn-sm btn-danger" onClick={onStop} disabled={busy}>
              Stop
            </button>
          )}
          <button type="button" className="btn btn-sm" onClick={onPrep} disabled={busy}>
            Prep
          </button>
        </div>
      </td>
    </tr>
  );
}
