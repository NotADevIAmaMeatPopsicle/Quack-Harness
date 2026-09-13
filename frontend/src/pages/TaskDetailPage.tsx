import { useEffect, useRef, useState } from "react";
import { useParams, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import {
  getTaskPrep,
  listProjects,
  getFullPreflightJob,
  reconcileFullPreflightJob,
  replanTask,
  getTaskRuns,
  prepTask,
  preflightTask,
  startTask,
  stopTask,
} from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { confirmDialog } from "../components/ConfirmDialog";
import { toast } from "../components/Toast";
import type { FullPreflightJob } from "../api/contracts";

export function TaskDetailPage() {
  const { taskId = "" } = useParams<{ taskId: string }>();
  const queryClient = useQueryClient();
  const initiatedJob = useRef<string>();
  const projects = useQuery({ queryKey: ["projects"], queryFn: listProjects });
  const projectId = projects.data?.activeProjectId ??
    (projects.data?.projects.length === 1 ? projects.data.projects[0].id : undefined);
  const currentScope = useRef({ taskId, projectId });
  currentScope.current = { taskId, projectId };
  const [preflightNotice, setPreflightNotice] = useState<{
    taskId: string; projectId: string; jobId?: string; text: string;
  }>();
  const preflightKey = ["full-preflight-job", projectId, taskId];
  const preflight = useQuery({
    queryKey: preflightKey,
    queryFn: () => getFullPreflightJob(taskId, projectId!),
    enabled: Boolean(taskId && projectId), retry: false,
    refetchInterval: (query) => {
      if (query.state.error) return false;
      const status = query.state.data?.job?.status;
      return status === "accepted" || status === "running" ? 1000 : false;
    },
  });
  const job = preflight.data?.job;
  const preflightRunning = job?.status === "accepted" || job?.status === "running";
  const recoveryRequired = job?.status === "recovery_required";

  const runs = useQuery({
    queryKey: ["task-runs", taskId],
    queryFn: () => getTaskRuns(taskId),
    enabled: Boolean(taskId),
  });

  const prep = useQuery({
    queryKey: ["task-prep", projectId, taskId],
    queryFn: () => getTaskPrep(taskId, projectId!),
    enabled: Boolean(taskId && projectId),
    retry: false,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["task-runs", taskId] });
    void queryClient.invalidateQueries({ queryKey: ["task-prep", projectId, taskId] });
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
    mutationFn: (scope: { taskId: string; projectId: string }) => prepTask(scope.taskId, scope.projectId),
    onSuccess: () => { toast.success(`Prep started`); invalidate(); },
    onError: (err) => toast.error(`Prep failed`, err instanceof Error ? err.message : String(err)),
  });
  const runPreflight = useMutation({
    mutationFn: (scope: { taskId: string; projectId: string; replan: boolean; fresh?: boolean }) => scope.replan
      ? replanTask(scope.taskId, scope.projectId) : preflightTask(scope.taskId, scope.projectId, scope.fresh),
    onMutate: () => { setPreflightNotice(undefined); initiatedJob.current = undefined; },
    onSuccess: (response, scope) => {
      if (scope.projectId === currentScope.current.projectId && scope.taskId === currentScope.current.taskId) {
        initiatedJob.current = scope.fresh && response.created !== true ? undefined : response.job?.jobId;
        if (scope.fresh && response.created !== true) setPreflightNotice({ ...scope, jobId: response.job?.jobId,
          text: response.created === false ? "Another preflight was already running. No fresh run was started."
            : "The monitor did not confirm a fresh start. Check status before retrying." });
      }
      queryClient.setQueryData(["full-preflight-job", scope.projectId, scope.taskId], response);
    },
    onError: (err, scope) => {
      if (scope.projectId === currentScope.current.projectId && scope.taskId === currentScope.current.taskId) {
        const text = err instanceof Error ? err.message : String(err);
        setPreflightNotice({ ...scope, text });
        toast.error("Preflight could not start", text);
      }
      void queryClient.invalidateQueries({ queryKey: ["full-preflight-job", scope.projectId, scope.taskId] });
    },
  });

  const confirmReplan = (): void => {
    const scope = { taskId, projectId: projectId!, replan: true };
    void (async () => {
      if (await confirmDialog({ title: "Replan blueprint?",
        message: "Reject the current brief and generate a replacement? The replacement will require fresh approval.",
        confirmLabel: "Reject and replan" })) runPreflight.mutate(scope);
    })();
  };

  const reconcile = useMutation({
    mutationFn: (attempt: FullPreflightJob) => reconcileFullPreflightJob(attempt),
    onSuccess: (response, attempt) => queryClient.setQueryData(["full-preflight-job", attempt.projectId, attempt.taskId], response),
    onError: (err) => toast.error("Recovery failed", err instanceof Error ? err.message : String(err)),
  });
  const confirmRecovery = (): void => {
    const attempt = job;
    if (!attempt) return;
    void (async () => {
      if (await confirmDialog({ title: "Reconcile interrupted preflight?",
        message: "Confirm that the original preflight process and all of its child processes have stopped before releasing this attempt for retry.",
        confirmLabel: "I confirmed they stopped" })) reconcile.mutate(attempt);
    })();
  };

  useEffect(() => {
    if (!job || initiatedJob.current !== job.jobId || (job.status !== "completed" && job.status !== "failed")) return;
    initiatedJob.current = undefined;
    if (job.status === "failed") toast.error("Preflight failed", job.error);
    else if (job.result?.degraded || job.result?.mode === "deterministic") toast.info("Preflight finished with limited checks");
    else toast.info("Preflight report ready", job.result?.gate.ready ? "Readiness passed" : "Readiness needs attention");
    void queryClient.invalidateQueries({ queryKey: ["task-prep", projectId, taskId] });
    void queryClient.invalidateQueries({ queryKey: ["tasks"] });
  }, [job, queryClient, taskId, projectId]);

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
        <button type="button" className="btn" disabled={!projectId || runPrep.isPending} onClick={() => runPrep.mutate({ taskId, projectId: projectId! })}>Prep</button>
        <button type="button" className="btn" disabled={!projectId || preflight.isLoading || runPreflight.isPending || preflightRunning || recoveryRequired}
          onClick={() => runPreflight.mutate({ taskId, projectId: projectId!, replan: false })}>{preflightRunning || runPreflight.isPending ? "Running preflight…" : job ? "Run preflight again" : "Preflight"}</button>
      </PageHeader>

      <section className="card" aria-label="Full preflight status">
        <h2>Full preflight</h2>
        <button type="button" className="btn" disabled={!projectId || preflight.isLoading || runPreflight.isPending || preflightRunning || recoveryRequired}
          onClick={() => runPreflight.mutate({ taskId, projectId: projectId!, replan: false, fresh: true })}>Run fresh preflight</button>
        <p className="muted">Rerun checks without reusing the cached report. May use model credits.</p>
        {preflightNotice?.taskId === taskId && preflightNotice.projectId === projectId &&
          (!preflightNotice.jobId || preflightNotice.jobId === job?.jobId) && <p role="status">{preflightNotice.text}</p>}
        {!projectId && <p className="muted">{projects.isLoading ? "Loading project…" : "Select an active project in Settings to run preflight."}</p>}
        {preflight.isLoading && projectId && <p>Checking the latest attempt…</p>}
        {preflight.isError && <>
          <p className="error">Unable to refresh preflight status. The last known state is shown below.</p>
          <p className="muted">{preflight.error instanceof Error ? preflight.error.message : String(preflight.error)}</p>
        </>}
        {preflightRunning && <p role="status">{job?.status === "accepted" ? "Queued. Waiting for the preflight worker…" : "Running preflight…"}</p>}
        {job?.status === "failed" && <p className="error" role="status">Preflight failed: {job.error ?? "The worker did not return a valid report."}</p>}
        {job?.claimants?.length ? <p>Conflicting task files: {job.claimants.join(", ")}</p> : null}
        {recoveryRequired && <>
          <p className="error">Recovery required. {job?.error}</p>
          <button type="button" className="btn" disabled={reconcile.isPending} onClick={confirmRecovery}>Reconcile interrupted run</button>
        </>}
        {job?.status === "completed" && job.result && <>
          <p role="status">Preflight completed. {job.result.gate.gateSkipped ? "Readiness was not evaluated." :
            job.result.gate.ready ? "Readiness passed." : "Readiness needs attention."}</p>
          {(job.result.degraded || job.result.mode === "deterministic") && <p className="error">Limited checks: {job.result.degraded?.reason ?? "Only deterministic checks ran; model-dependent checks were skipped."}</p>}
          {(job.result.blueprint.fidelity?.status === "failed" || job.result.blueprint.structured?.fidelity?.status === "failed" || job.result.blueprint.structuredPreserved || (job.replan && !job.result.blueprint.formattedMarkdown.trim())) &&
            <p className="error">The replacement blueprint needs attention. An older cached blueprint may have been retained.</p>}
          {job.result.gate.reason && <p>{job.result.gate.reason}</p>}
          <details><summary>View this attempt’s report</summary><pre className="stream" style={{ maxHeight: 320 }}>{JSON.stringify(job.result, null, 2)}</pre></details>
        </>}
        {job && <p className="muted mono">Attempt {job.jobId}</p>}
        {job?.eventError && <p className="muted">Some progress events could not be saved. This status comes from the durable attempt record.</p>}
        {job?.replan && <>
          <p className="muted">A failed or incomplete replacement keeps the old brief blocked. Replan explicitly to generate another replacement; it will need fresh approval.</p>
          <button type="button" className="btn" disabled={!projectId || preflightRunning || runPreflight.isPending || recoveryRequired} onClick={confirmReplan}>Replan blueprint</button>
        </>}
        {projectId && <button type="button" className="btn" disabled={preflight.isFetching} onClick={() => void preflight.refetch()}>Check status</button>}
        {!job && !preflight.isLoading && !preflight.isError && projectId && <p className="muted">No full-preflight attempt yet.</p>}
      </section>

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
