/* Prep completion belongs to a worker attempt, never to a cache read. */
(function (global) {
  'use strict';
  const uuid = value => typeof value === 'string' && /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(value);
  const hash = value => typeof value === 'string' && /^[a-f0-9]{64}$/i.test(value);
  const policyHash = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
  const MIN_READY_SCORE = 4.7;
  const strings = value => Array.isArray(value) && value.every(item => typeof item === 'string');
  function validResult(r) {
    return r && typeof r === 'object' && !Array.isArray(r) && !('error' in r) &&
      typeof r.schemaValid === 'boolean' && strings(r.schemaErrors) &&
      Number.isFinite(r.depthScore) && r.depthScore >= 0 && r.depthScore <= 5 &&
      typeof r.depthReady === 'boolean' && strings(r.deficiencies) &&
      ['pass', 'enriched', 'rejected'].includes(r.outcome) &&
      (r.outcome !== 'rejected') === (r.schemaValid && r.depthReady) &&
      (!r.schemaValid || r.schemaErrors.length === 0) && (r.schemaValid || !r.depthReady) &&
      (r.contentHash === undefined || hash(r.contentHash)) &&
      (r.schemaPolicyHash === undefined || policyHash(r.schemaPolicyHash));
  }
  function passes(r) {
    return validResult(r) && r.schemaValid && r.depthReady && r.outcome !== 'rejected' && r.depthScore >= MIN_READY_SCORE;
  }
  function corresponding(result, prep) {
    return validResult(result) && validResult(prep) && prep.evidenceSource === 'prep_record' &&
      prep.stale === false && hash(result.contentHash) && policyHash(result.schemaPolicyHash) &&
      ['contentHash', 'schemaPolicyHash', 'schemaValid', 'depthScore', 'depthReady', 'outcome']
        .every(key => result[key] === prep[key]) &&
      ['schemaErrors', 'deficiencies'].every(key => JSON.stringify(result[key]) === JSON.stringify(prep[key]));
  }
  function create({ getScope, onChange, fetcher = global.fetch.bind(global), pollMs = 1000,
    observationMs = 90000, requestMs = 10000 }) {
    let key;
    let generation = 0;
    let states = new Map();
    const requests = new Set();
    const storageKey = () => `quack-prep-attempts:${key}`;
    function save() {
      try {
        global.sessionStorage?.setItem(storageKey(), JSON.stringify([...states]
          .filter(([, s]) => !['completed', 'failed'].includes(s.status))
          .map(([taskId, s]) => ({ taskId, jobId: s.jobId }))));
      } catch { /* Storage availability does not change attempt identity. */ }
    }
    function sync() {
      const scope = getScope();
      const next = JSON.stringify([scope.apiBase, scope.projectId || null]);
      if (next !== key) {
        for (const s of states.values()) clearTimeout(s.timer);
        for (const request of requests) request.abort();
        states = new Map(); key = next; generation++;
        try {
          const saved = JSON.parse(global.sessionStorage?.getItem(storageKey()) || '[]');
          if (Array.isArray(saved)) for (const item of saved) {
            if (typeof item?.taskId !== 'string' || !/^TASK-[A-Z0-9-]+$/i.test(item.taskId) ||
                item.jobId !== undefined && !uuid(item.jobId)) continue;
            const s = { scope: { ...scope, generation }, jobId: item.jobId, status: 'unconfirmed',
              deadline: Date.now() + observationMs, message: 'Reconnecting to the recorded prep attempt.' };
            states.set(item.taskId, s);
            s.timer = setTimeout(() => { if (current(item.taskId, s)) void read(item.taskId, s); }, 0);
          }
        } catch { /* Corrupt browser storage is not completion evidence. */ }
      }
      return { ...scope, generation };
    }
    function state(taskId) { sync(); return states.get(taskId); }
    function current(taskId, s) { return sync().generation === s.scope.generation && states.get(taskId) === s; }
    function publish(taskId, s) { if (current(taskId, s)) { save(); onChange(taskId, s); } }
    function pause(taskId, s, message, status = 'unconfirmed') {
      if (!current(taskId, s)) return;
      clearTimeout(s.timer); s.status = status; s.message = message; s.readiness = undefined;
      publish(taskId, s);
    }
    async function request(s, route, method = 'GET') {
      const controller = new AbortController(); requests.add(controller);
      const timeout = setTimeout(() => controller.abort(), requestMs);
      try {
        const query = s.scope.projectId ? `?project=${encodeURIComponent(s.scope.projectId)}` : '';
        const response = await fetcher(`${s.scope.apiBase}${route}${query}`, { method, signal: controller.signal });
        const data = await response.json();
        if (!response.ok) throw Object.assign(new Error(data.error || `Prep request failed (${response.status})`), { status: response.status, code: data.code });
        return data;
      } finally { clearTimeout(timeout); requests.delete(controller); }
    }
    const route = taskId => `/api/tasks/${encodeURIComponent(taskId)}/prep`;
    function schedule(taskId, s) {
      clearTimeout(s.timer);
      const remaining = s.deadline - Date.now();
      s.timer = setTimeout(() => {
        if (!current(taskId, s)) return;
        if (Date.now() >= s.deadline) pause(taskId, s, 'Status unconfirmed after 90 seconds. The worker may still be running. Check status to reconnect.');
        else void read(taskId, s);
      }, Math.max(0, Math.min(pollMs, remaining)));
    }
    async function read(taskId, s) {
      if (!current(taskId, s) || s.reading || s.status === 'completed' || s.status === 'failed') return;
      clearTimeout(s.timer); s.reading = true;
      try {
        const { job } = await request(s, `${route(taskId)}/job`);
        if (!current(taskId, s)) return;
        if (!job || !uuid(job.jobId) || job.taskId !== taskId ||
            !['running', 'completed', 'failed'].includes(job.status)) {
          pause(taskId, s, 'The monitor returned an invalid prep attempt. Check status; no completion was confirmed.'); return;
        }
        if (!s.jobId) {
          if (job.status !== 'running') {
            pause(taskId, s, 'Submission could not be confirmed. The latest terminal record is not proof of this request. You can explicitly start a new prep.', 'unavailable'); return;
          }
          s.jobId = job.jobId; s.observed = true;
        }
        if (job.jobId !== s.jobId) {
          pause(taskId, s, 'This attempt is no longer available through the latest-job endpoint. A different attempt is now recorded.', 'unavailable'); return;
        }
        s.job = job;
        if (job.status === 'running') {
          s.status = 'running'; s.message = s.observed ? 'Observing the running prep attempt; submission ownership is unconfirmed.' : undefined;
          publish(taskId, s); schedule(taskId, s); return;
        }
        if (job.status === 'failed') {
          s.status = 'failed'; s.message = typeof job.error === 'string' ? job.error : 'Prep worker failed.';
          publish(taskId, s); return;
        }
        if (!validResult(job.result)) {
          pause(taskId, s, 'The completed attempt has an invalid gate result. Current readiness is unavailable.'); return;
        }
        s.result = job.result;
        // This read establishes current correspondence, not cache attempt provenance.
        try {
          const prep = await request(s, route(taskId));
          if (!current(taskId, s)) return;
          s.readiness = corresponding(s.result, prep) ? prep : undefined;
        } catch { s.readiness = undefined; }
        if (!current(taskId, s)) return;
        s.status = 'completed'; s.message = s.readiness ? undefined : 'Current readiness unavailable: task, policy or evidence differs from this terminal report.';
        publish(taskId, s);
      } catch (error) {
        if (error.status === 404 && error.code === 'PREP_ATTEMPT_NOT_FOUND') {
          pause(taskId, s, 'No prep attempt is recorded. The earlier attempt cannot be recovered here. Start a new prep or check again.', 'missing');
        } else if (error.status === 503 && error.code === 'PREP_DIAGNOSTICS_UNAVAILABLE') {
          pause(taskId, s, 'Stored attempt diagnostics are unreadable. Check again or explicitly start a new prep.', 'unavailable');
        } else pause(taskId, s, `${error.name === 'AbortError' ? 'Prep status request timed out' : error.message}. Check status; the worker may still be running.`);
      } finally { s.reading = false; }
    }
    async function start(taskId) {
      const scope = sync(); const prior = state(taskId);
      // Ambiguous responses require observation. Explicit new attempts after a confirmed
      // missing/superseded record still pass the server's concurrency/admission guards.
      if (prior && !['completed', 'failed', 'missing', 'unavailable'].includes(prior.status)) return;
      if (prior) clearTimeout(prior.timer);
      const s = { scope, status: 'starting', deadline: Date.now() + observationMs };
      states.set(taskId, s); publish(taskId, s);
      try {
        const data = await request(s, route(taskId), 'POST');
        if (!current(taskId, s)) return;
        if (!uuid(data.jobId)) throw new Error('Prep submission returned no valid attempt ID');
        s.jobId = data.jobId; s.status = 'running'; publish(taskId, s);
      } catch (error) {
        if (!current(taskId, s)) return;
        s.actionError = error.name === 'AbortError' ? 'Prep submission timed out.' : error.message;
        // 409, lost response and admission refusal all recover through GET only.
      }
      await read(taskId, s);
    }
    async function refresh(taskId) {
      const scope = sync(); let s = state(taskId);
      if (s?.status === 'starting' || s?.reading) return;
      if (!s) { s = { scope, status: 'unconfirmed' }; states.set(taskId, s); }
      if (['completed', 'failed'].includes(s.status)) return;
      s.deadline = Date.now() + observationMs;
      await read(taskId, s);
    }
    // Reload recovery only observes a live worker. Old terminal records leave ordinary cache display alone.
    async function recover(taskId) {
      const scope = sync(); if (state(taskId)) return;
      const probe = { scope };
      try {
        const { job } = await request(probe, `${route(taskId)}/job`);
        if (sync().generation !== scope.generation || state(taskId) || job?.status !== 'running' || !uuid(job.jobId) || job.taskId !== taskId) return;
        const s = { scope, jobId: job.jobId, status: 'running', job, observed: true, deadline: Date.now() + observationMs };
        states.set(taskId, s); publish(taskId, s); schedule(taskId, s);
      } catch { /* no claimed attempt to recover */ }
    }
    function event(event) {
      if (!['prep_job_completed', 'prep_failed'].includes(event.stage)) return;
      const taskId = event.taskId; const s = state(taskId);
      if (!s || s.scope.projectId && event.project !== s.scope.projectId ||
          !uuid(event.payload?.jobId) || s.jobId !== event.payload.jobId) return;
      void read(taskId, s);
    }
    function readiness(taskId, prep) {
      const s = state(taskId); if (!s) return;
      if (s.status === 'completed') {
        s.readiness = corresponding(s.result, prep) ? prep : undefined;
        s.message = s.readiness ? undefined : 'Current readiness unavailable: task, policy or evidence differs from this terminal report.';
      }
      publish(taskId, s);
    }
    return { sync, state, start, refresh, recover, event, readiness };
  }
  global.QuackPrepJobs = { create, validResult, corresponding, passes, MIN_READY_SCORE };
})(window);
