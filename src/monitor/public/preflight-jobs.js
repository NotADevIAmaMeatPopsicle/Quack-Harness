/* Durable full-preflight controller shared by the legacy row and detail actions. */
(function (global) {
  'use strict';
  const active = job => job && (job.status === 'accepted' || job.status === 'running');
  function label(state) {
    const job = state.job;
    if (state.error) return 'Status unavailable';
    if (state.pending) return 'Starting preflight…';
    if (!job) return 'Pre-Flight';
    if (job.status === 'accepted') return 'Queued preflight…';
    if (job.status === 'running') return 'Running preflight…';
    if (job.status === 'failed') return 'Preflight failed';
    if (job.status === 'recovery_required') return 'Recovery required';
    const result = job.result;
    if (result?.degraded || result?.mode === 'deterministic') return 'Limited checks';
    if (result?.blueprint?.structuredPreserved || result?.blueprint?.fidelity?.status === 'failed' ||
        result?.blueprint?.structured?.fidelity?.status === 'failed' ||
        (job.replan && !(result?.blueprint?.hasMarkdown ?? result?.blueprint?.formattedMarkdown?.trim()))) return 'Blueprint needs attention';
    if (result?.gate?.gateSkipped) return 'Readiness not evaluated';
    return result?.gate?.ready ? 'Preflight report ready' : 'Readiness needs attention';
  }

  function create({ getScope, onChange, fetcher = global.fetch.bind(global), pollMs = 1000 }) {
    let scopeKey;
    let generation = 0;
    let sequence = 0;
    let states = new Map();
    let listError;
    const timers = new Map();
    function sync() {
      const scope = getScope();
      const key = JSON.stringify([scope.apiBase, scope.projectId]);
      if (key !== scopeKey) {
        for (const timer of timers.values()) clearTimeout(timer);
        timers.clear(); states = new Map(); listError = undefined;
        scopeKey = key; generation++;
      }
      return { ...scope, generation };
    }
    function current(scope) { return sync().generation === scope.generation; }
    function state(taskId) { sync(); return states.get(taskId) || { error: listError }; }
    function changed(taskId) { onChange(taskId, state(taskId)); }
    function cancel(taskId) { clearTimeout(timers.get(taskId)); timers.delete(taskId); }
    function schedule(taskId, scope) {
      cancel(taskId);
      if (active(state(taskId).job) && !state(taskId).paused) {
        timers.set(taskId, setTimeout(() => { if (current(scope)) void refresh(taskId, false); }, pollMs));
      }
    }
    async function request(scope, route, body) {
      if (!scope.projectId) throw new Error('Select an active project before checking preflight.');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10000);
      try {
        const response = await fetcher(`${scope.apiBase}${route}?project=${encodeURIComponent(scope.projectId)}`, {
          signal: controller.signal,
          ...(body ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) } : {}),
        });
        const data = await response.json();
        if (!response.ok) throw new Error(data.error || `Status request failed (${response.status})`);
        return data;
      } finally { clearTimeout(timeout); }
    }
    function accept(taskId, job, scope, extra = {}) {
      if (!current(scope)) return;
      const previous = state(taskId);
      // A slower list/read cannot roll back a newer attempt or a later revision.
      if (previous.job && job && (previous.job.acceptedAt > job.acceptedAt ||
          (previous.job.jobId === job.jobId && previous.job.revision > job.revision))) return;
      if (previous.job?.jobId === job?.jobId && job?.reportSummary && !previous.job.reportSummary &&
          previous.job.revision === job.revision) job = previous.job;
      states.set(taskId, { job, failures: 0, sequence: ++sequence,
        ...(previous.job?.jobId === job?.jobId ? { notice: previous.notice } : {}), ...extra });
      changed(taskId); schedule(taskId, scope);
    }
    async function refresh(taskId, latest = true) {
      const scope = sync();
      cancel(taskId);
      const before = state(taskId);
      if (before.pending || before.reading) return;
      const readSequence = ++sequence;
      states.set(taskId, { ...before, reading: true, sequence: readSequence });
      const id = !latest && before.job ? before.job.jobId : 'latest';
      try {
        const data = await request(scope, `/api/tasks/${encodeURIComponent(taskId)}/preflight/jobs/${id}`);
        if (current(scope) && state(taskId).sequence === readSequence) accept(taskId, data.job, scope, { actionError: before.actionError });
      } catch (error) {
        if (!current(scope) || state(taskId).sequence !== readSequence) return;
        const failures = (before.failures || 0) + 1;
        states.set(taskId, { ...before, reading: false, failures, paused: failures >= 3, error: error.message });
        changed(taskId); schedule(taskId, scope);
      }
    }
    async function load() {
      const scope = sync();
      const listSequence = sequence;
      try {
        const data = await request(scope, '/api/preflight/jobs');
        if (!current(scope)) return;
        listError = undefined;
        for (const job of data.jobs) if (!state(job.taskId).pending && !state(job.taskId).reading &&
          (state(job.taskId).sequence || 0) <= listSequence) accept(job.taskId, job, scope);
        for (const issue of data.storageIssues || []) {
          if (issue.taskId) {
            const before = state(issue.taskId);
            states.set(issue.taskId, { ...before, error: issue.message, paused: true });
            cancel(issue.taskId); changed(issue.taskId);
          } else listError = issue.message;
        }
      } catch (error) {
        if (!current(scope)) return;
        listError = error.message;
        for (const [taskId, before] of states) {
          states.set(taskId, { ...before, error: error.message }); changed(taskId);
        }
      }
    }
    async function submit(taskId, replan, fresh) {
      const scope = sync();
      const before = state(taskId);
      if (before.pending || active(before.job) || before.job?.status === 'recovery_required') return;
      cancel(taskId);
      states.set(taskId, { ...before, pending: true, error: undefined, actionError: undefined, notice: undefined, sequence: ++sequence });
      changed(taskId);
      try {
        const data = await request(scope, `/api/tasks/${encodeURIComponent(taskId)}/${replan ? 'blueprint/replan' : 'preflight'}`,
          fresh ? { force: true, preserveApprovals: true } : { force: replan });
        if (!data.job?.jobId) throw new Error('The monitor did not return a durable attempt. Check status before retrying.');
        const notice = fresh && data.created !== true
          ? data.created === false ? 'Another preflight was already running. No fresh run was started.'
            : 'The monitor did not confirm a fresh start. Check status before retrying.'
          : undefined;
        accept(taskId, data.job, scope, { notice });
      } catch (error) {
        if (!current(scope)) return;
        states.set(taskId, { ...before, reading: false, pending: false, notice: undefined, sequence: ++sequence, actionError: error.message }); changed(taskId);
        // A lost response can still have reserved work. Recover it without another POST.
        await refresh(taskId);
      }
    }
    async function reconcile(taskId, confirmed) {
      if (!confirmed) return;
      const scope = sync(); const before = state(taskId); const job = before.job;
      if (!job || job.status !== 'recovery_required' || before.pending) return;
      states.set(taskId, { ...before, reading: false, pending: true, sequence: ++sequence }); changed(taskId);
      try {
        const data = await request(scope, `/api/tasks/${encodeURIComponent(taskId)}/preflight/jobs/${job.jobId}/reconcile`, {
          revision: job.revision, confirmationToken: job.confirmationToken, processTreeConfirmedStopped: true,
        });
        accept(taskId, data.job, scope);
      } catch (error) {
        if (!current(scope)) return;
        states.set(taskId, { ...before, reading: false, pending: false, sequence: ++sequence, error: error.message }); changed(taskId);
      }
    }
    function event(event) {
      const taskId = event.taskId || event.payload?.taskId;
      const jobId = event.payload?.jobId;
      if (!taskId || !jobId) return;
      const scope = sync();
      if (event.project && event.project !== scope.projectId) return;
      const before = state(taskId);
      if (!before.job) { void refresh(taskId); return; }
      if (before.job.jobId !== jobId) return;
      // Pipeline completion is advisory. Only a durable GET can publish terminal status.
      if (event.stage?.startsWith('preflight_job_') || event.stage === 'preflight_complete' ||
          event.stage?.startsWith('blueprint_replan_')) void refresh(taskId, false);
    }
    const start = (taskId, replan = false) => submit(taskId, replan, false);
    const fresh = taskId => submit(taskId, false, true);
    return { state, sync, load, refresh, start, fresh, reconcile, event, label, active };
  }
  global.QuackPreflightJobs = { create, label, active };
})(window);
