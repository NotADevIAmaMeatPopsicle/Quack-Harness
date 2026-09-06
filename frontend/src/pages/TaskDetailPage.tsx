import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getTaskPrep,
  getTaskRuns,
  prepTask,
  preflightTask,
  startTask,
  stopTask,
} from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { confirmDialog } from "../components/ConfirmDialog";
import { toast } from "../components/Toast";

export function TaskDetailPage() {
  const { taskId = "" } = useParams<{ taskId: string }>();
  const queryClient = useQueryClient();

  const runs = useQuery({
    queryKey: ["task-runs", taskId],
    queryFn: () => getTaskRuns(taskId),
    enabled: Boolean(taskId),
  });

  const prep = useQuery({
    queryKey: ["task-prep", taskId],
    queryFn: () => getTaskPrep(taskId),
    enabled: Boolean(taskId),
    retry: false,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["task-runs", taskId] });
    void queryClient.invalidateQueries({ queryKey: ["task-prep", taskId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  };

  const confirmStart = (): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: `Start ${taskId}?`,
        message: "Dispatch through the readiness gate. Spends tokens.",
        confirmLabel: "Start",
      });
      if (ok) start.mutate();
    })();
  };

  const confirmStop = (): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: `Stop ${taskId}?`,
        message: "Kills the running dispatch.",
        confirmLabel: "Stop",
        danger: true,
      });
      if (ok) stop.mutate();
    })();
  };

  const start = useMutation({
    mutationFn: () => startTask(taskId),
    onSuccess: (data) => {
      toast.success(`Started ${taskId}`, data.jobId ? `Job ${data.jobId}` : data.message);
      invalidate();
    },
    onError: (err) => toast.error(`Start failed`, err instanceof Error ? err.message : String(err)),
  });
  const stop = useMutation({
    mutationFn: () => stopTask(taskId),
    onSuccess: () => { toast.success(`Stopped ${taskId}`); invalidate(); },
    onError: (err) => toast.error(`Stop failed`, err instanceof Error ? err.message : String(err)),
  });
  const runPrep = useMutation({
    mutationFn: () => prepTask(taskId),
    onSuccess: () => { toast.success(`Prep started`); invalidate(); },
    onError: (err) => toast.error(`Prep failed`, err instanceof Error ? err.message : String(err)),
  });
  const runPreflight = useMutation({
    mutationFn: () => preflightTask(taskId),
    onSuccess: () => { toast.success(`Preflight started`); invalidate(); },
    onError: (err) => toast.error(`Preflight failed`, err instanceof Error ? err.message : String(err)),
  });

  return (
    <div className="page">
      <PageHeader title={taskId} subtitle={<Link to="/tasks">← Back to tasks</Link>}>
        <button
          type="button"
          className="btn btn-primary"
          disabled={start.isPending}
          onClick={confirmStart}
        >Start</button>
        <button
          type="button"
          className="btn btn-danger"
          disabled={stop.isPending}
          onClick={confirmStop}
        >Stop</button>
        <button type="button" className="btn" disabled={runPrep.isPending} onClick={() => runPrep.mutate()}>Prep</button>
        <button type="button" className="btn" disabled={runPreflight.isPending} onClick={() => runPreflight.mutate()}>Preflight</button>
      </PageHeader>

      <section className="card">
        <h2>Prep / Preflight Cache</h2>
        {prep.isLoading && <p>Loading…</p>}
        {prep.isError && <p className="muted">No cached prep yet. Click Prep to run one.</p>}
        {prep.data ? (
          <pre className="stream" style={{ maxHeight: 320 }}>{JSON.stringify(prep.data, null, 2)}</pre>
        ) : null}
      </section>

      <section className="card">
        <h2>Run History</h2>
        {runs.isLoading && <p>Loading…</p>}
        {runs.isError && <p className="error">Failed to load runs.</p>}
        {runs.data && Array.isArray(runs.data) && (
          <>
            <p className="muted">{runs.data.length} run{runs.data.length === 1 ? "" : "s"}</p>
            {runs.data.length === 0 && <p className="muted">No runs yet.</p>}
            {runs.data.length > 0 && (
              <pre className="stream" style={{ maxHeight: 320 }}>{JSON.stringify(runs.data, null, 2)}</pre>
            )}
          </>
        )}
      </section>
    </div>
  );
}
