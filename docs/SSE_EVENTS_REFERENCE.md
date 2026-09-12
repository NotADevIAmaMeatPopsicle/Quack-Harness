# Server-sent events

The monitor publishes lifecycle updates through a single server-sent events endpoint:

```http
GET http://127.0.0.1:3333/api/events/stream
```

The browser dashboard opens one connection and dispatches events by `stage`. Consumers should ignore unknown stages so additive releases remain compatible.

## Connection

```js
const stream = new EventSource("http://127.0.0.1:3333/api/events/stream");

stream.onmessage = (event) => {
  const update = JSON.parse(event.data);
  console.log(update.stage, update.payload);
};
```

Use a relative URL in browser applications hosted by the monitor:

```js
const stream = new EventSource("/api/events/stream");
```

Session and project filters may be supplied as query parameters where supported by the running version.

## Common envelope

Events use this general shape:

```ts
interface QuackEvent {
  sessionId: string;
  taskId?: string;
  project?: string;
  timestamp: string;
  stage: string;
  payload: Record<string, unknown>;
}
```

Fields may be added over time. `timestamp` is an ISO 8601 string. IDs are opaque and should not be parsed for business logic.

## Event groups

These are examples of declared stages, not an exhaustive inventory.

### Session lifecycle

- `session_start`
- `session_complete`
- `session_error`
- `dispatch_child_exit`
- `agent_stuck_warning`
- `cost_alert`

### Readiness and planning

- `gate_schema`
- `gate_depth`
- `gate_result`
- `prep_job_completed`
- `prep_failed`
- `preflight_complete`
- `blueprint_start`
- `blueprint_generated`
- `blueprint_pending_approval`

### Execution and verification

- `agent_turn`
- `agent_tool_use`
- `agent_complete`
- `verification_start`
- `verification_result`
- `judge_start`
- `judge_result`
- `retry_start`

### Queue and federation

- `dispatch_queue_started`
- `dispatch_queue_task_awaiting_approval`
- `dispatch_queue_task_completed`
- `dispatch_queue_task_blocked`
- `federated_job_submitted`
- `federated_job_assigned`
- `federated_job_status`
- `federated_job_event`

### Review and judgment

- `loop_brief_review`
- `loop_diff_review`
- `blueprint_approved`
- `blueprint_rejected`
- `judge_pending_approval`
- `judge_approved`
- `judge_rejected`
- `judgment_evaluation`
- `judgment_decision`

The exact payload depends on the stage. The TypeScript definitions in
`src/monitor/event-types.ts` and `src/judgment/judgment-events.ts` are the
authoritative contracts for the installed version.

## Terminal evidence

`prep_job_completed` and `prep_failed` carry the terminal `PrepJob` as their
payload. Its `jobId` identifies the attempt; the event's session identity uses
that job ID and its timestamp uses `completedAt`. Payload fields include
`taskId`, `status`, `exitCode`, `signal`, a validated `result` or `error`, and
bounded sanitized stdout/stderr diagnostics with truncation flags. A recorded
`persistenceError` means durable storage needs attention.

Preparation remains running until child stdio closes. A completed child can
return `result.outcome: "rejected"`; completion alone is not task readiness.
After reconnecting or restarting, read `GET /api/tasks/:id/prep/job` for the
latest durable observation and the prep endpoint for current readiness.

`dispatch_child_exit` records how a child stopped, including `exitCode`,
`signal`, `killed`, `operatorRequested` and `at`. An exit event does not by itself
establish completed verification, merge or cleanup. For federated worker
completion, match the exact project/task/job/host/lease/session identity and
read the dispatch observation endpoint's `settled` result. Never borrow evidence
from the latest same-task session. Durable observations do not restore active
process ownership.

## Reconnection

Browsers reconnect automatically after an interrupted SSE connection. Consumers should tolerate duplicate events and rebuild authoritative state from the corresponding REST endpoint after reconnecting. Do not treat an SSE message as the sole durable record of a state transition.

## Security

When dashboard authentication is enabled, the browser sends its same-site session cookie with the stream request. Keep the monitor on loopback unless remote access is intentionally protected. Do not place service tokens in event-stream URLs because URLs can be retained in logs and browser history.
