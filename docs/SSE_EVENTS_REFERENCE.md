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

### Session lifecycle

- `session_start`
- `session_complete`
- `session_error`
- `agent_stuck_warning`
- `cost_update`

### Readiness and planning

- `gate_start`
- `gate_result`
- `enrichment_start`
- `enrichment_complete`
- `blueprint_start`
- `blueprint_complete`
- `blueprint_awaiting_approval`

### Execution and verification

- `worker_start`
- `worker_progress`
- `verification_start`
- `verification_result`
- `judge_start`
- `judge_result`
- `retry_start`

### Queue and federation

- `queue_update`
- `federated_job_status`
- `federated_worker_event`
- `listener_status`
- `lease_update`

### Review and judgment

- `review_started`
- `review_completed`
- `judgment_evaluation`
- `judgment_decision`

The exact payload depends on the stage. Read it defensively and use the TypeScript definitions in `src/monitor/event-types.ts` and `src/judgment/judgment-events.ts` as the authoritative contracts for the installed version.

## Reconnection

Browsers reconnect automatically after an interrupted SSE connection. Consumers should tolerate duplicate events and rebuild authoritative state from the corresponding REST endpoint after reconnecting. Do not treat an SSE message as the sole durable record of a state transition.

## Security

When dashboard authentication is enabled, the browser sends its same-site session cookie with the stream request. Keep the monitor on loopback unless remote access is intentionally protected. Do not place service tokens in event-stream URLs because URLs can be retained in logs and browser history.
