# HTTP API reference

The monitor exposes a JSON API and a server-sent event stream on its configured host and port. The default base URL is `http://127.0.0.1:3333`.

This is a pre-`1.0` API. Clients should tolerate additive fields and pin the Quack Harness version they integrate with.

## Authentication

When no dashboard users, API keys, or service tokens are configured, the loopback server can be used without credentials. Once dashboard authentication is enabled, state-changing `/api/*` requests require an authenticated admin session or an authorized API key. Viewer sessions are read-only.

Federation and worker endpoints use scoped service tokens:

```http
Authorization: Bearer <SERVICE_TOKEN>
```

or:

```http
X-Quack-Service-Token: <SERVICE_TOKEN>
```

Queue and job reads require an authenticated dashboard principal or a token with `federation:read` or `federation:write` whenever access controls are configured.

The monitor binds to loopback by default. If you deliberately bind it to another interface, place it behind TLS and network access controls and configure authentication before use.

## Response conventions

- Successful responses are JSON unless a route serves a file or SSE stream.
- Validation failures use HTTP `400` or `422` and include an `error` field.
- Authentication and authorization failures use `401` or `403`.
- Missing projects, tasks, sessions, or jobs use `404`.
- State conflicts use `409`.
- Project-aware routes accept `projectId` in the query, body, or `X-Project-Id` header where documented by an error response.

## Health and projects

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/health` | Process, build, and UI health |
| `GET` | `/api/projects` | Registered projects |
| `PUT` | `/api/projects/active/:projectId` | Select the active project |
| `GET` | `/api/remotes` | Configured remote monitors |

```bash
curl -s http://127.0.0.1:3333/api/health
```

## Tasks and sessions

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/tasks` | List parsed tasks and parse errors |
| `GET` | `/api/tasks/:taskId` | Read one task |
| `POST` | `/api/tasks/:taskId/prep` | Run readiness preparation |
| `POST` | `/api/tasks/:taskId/start` | Start an authorized local dispatch |
| `POST` | `/api/tasks/:taskId/stop` | Stop a running dispatch |
| `POST` | `/api/tasks/:taskId/resume` | Resume from a checkpoint |
| `POST` | `/api/tasks/:taskId/verify` | Run verification |
| `GET` | `/api/sessions` | List execution sessions |
| `GET` | `/api/sessions/:sessionId/events` | Read session events |

```bash
curl -s "http://127.0.0.1:3333/api/tasks?projectId=<PROJECT_ID>"
```

## Queue and fleet

| Method | Route | Purpose |
| --- | --- | --- |
| `GET` | `/api/queue` | Local queue state |
| `POST` | `/api/queue/enqueue` | Enqueue task IDs |
| `POST` | `/api/queue/start` | Start queue processing |
| `POST` | `/api/queue/pause` | Pause queue processing |
| `POST` | `/api/queue/resume` | Resume queue processing |
| `POST` | `/api/queue/stop` | Stop queue processing |
| `GET` | `/api/fleet/status` | Fleet state and limits |
| `POST` | `/api/fleet/emergency-stop` | Stop active fleet work |

## Federation

| Method | Route | Required scope | Purpose |
| --- | --- | --- | --- |
| `GET` | `/v1/federation/queue` | `federation:read` | Queue, host, and merge-lane state |
| `POST` | `/v1/federation/queue` | `federation:write` | Enqueue a federated job |
| `GET` | `/v1/federation/jobs/:jobId` | `federation:read` | Read one federated job |
| `POST` | `/v1/federation/jobs/:jobId/events` | `federation:write` | Report worker progress or completion |
| `POST` | `/v1/federation/jobs/:jobId/lease/renew` | `federation:write` | Renew a worker lease |
| `POST` | `/v1/federation/jobs/:jobId/cancel` | `federation:write` | Cancel a job |
| `GET` | `/v1/federation/verified` | `federation:read` | Read verification ledger rows |
| `POST` | `/v1/federation/verified` | `federation:write` | Record verification rows |

```bash
curl -s http://127.0.0.1:3333/v1/federation/queue \
  -H "Authorization: Bearer <SERVICE_TOKEN>" \
  -H "X-Project-Id: <PROJECT_ID>"
```

## Workers and listeners

Worker enrollment routes create short-lived bootstrap material. Listener routes register worker capabilities, accept heartbeats, and deliver commands. Use narrowly scoped service tokens and never place bootstrap secrets in source control or logs.

The main route families are:

- `/api/workers/*` for dashboard-driven enrollment
- `/v1/workers/*` for machine bootstrap and progress
- `/v1/listeners/*` for registration, heartbeats, status, and commands

## Reviews and verification

| Route family | Purpose |
| --- | --- |
| `/v1/workflows/*` | Workflow state and evidence events |
| `/v1/reviews/*` | Review bundle submission and inspection |
| `/api/tasks/:taskId/verified` | Record a human verification decision |
| `/api/tasks/:taskId/advisory` | Read task advisories |

## Monitoring, testing, and documentation

| Route family | Purpose |
| --- | --- |
| `/api/testing/*` | Verification command inventory, execution, and history |
| `/api/monitoring/*` | Configured environment health |
| `/api/wiki/*` | Local project documentation reads and authorized writes |
| `/api/costs*` | Recorded usage and cost summaries |
| `/api/analytics/*` | Aggregate outcomes and failure patterns |

## Server-sent events

Connect to `/api/events/stream`. Optional query parameters narrow the stream to a session or project. See [SSE events](SSE_EVENTS_REFERENCE.md) for event names and payload examples.

```js
const events = new EventSource("http://127.0.0.1:3333/api/events/stream");
events.onmessage = (event) => console.log(JSON.parse(event.data));
```

## Compatibility and discovery

The route implementation in `src/monitor/server.ts` and `src/monitor/routes/` is authoritative. For generated clients, capture representative responses from the exact version you deploy; no OpenAPI stability guarantee is made before `1.0`.
