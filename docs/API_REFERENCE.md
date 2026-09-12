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
- Unavailable authoritative state or malformed stored evidence uses `503`.
- Project-aware routes accept `projectId` in the query, body, or `X-Project-Id` header where documented by an error response.

## Health and projects

| Method | Route                             | Purpose                       |
| ------ | --------------------------------- | ----------------------------- |
| `GET`  | `/api/health`                     | Process, build, and UI health |
| `GET`  | `/api/projects`                   | Registered projects           |
| `PUT`  | `/api/projects/active/:projectId` | Select the active project     |
| `GET`  | `/api/remotes`                    | Configured remote monitors    |

```bash
curl -s http://127.0.0.1:3333/api/health
```

## Tasks and sessions

| Method | Route                             | Purpose                            |
| ------ | --------------------------------- | ---------------------------------- |
| `GET`  | `/api/tasks`                      | List parsed tasks and parse errors |
| `GET`  | `/api/tasks/:taskId`              | Read one task                      |
| `POST` | `/api/tasks/:taskId/prep`         | Run readiness preparation          |
| `POST` | `/api/tasks/:taskId/start`        | Start an authorized local dispatch |
| `POST` | `/api/tasks/:taskId/stop`         | Stop a running dispatch            |
| `POST` | `/api/tasks/:taskId/resume`       | Resume from a checkpoint           |
| `POST` | `/api/tasks/:taskId/verify`       | Run verification                   |
| `GET`  | `/api/sessions`                   | List execution sessions            |
| `GET`  | `/api/sessions/:sessionId/events` | Read session events                |

```bash
curl -s "http://127.0.0.1:3333/api/tasks?projectId=<PROJECT_ID>"
```

## Queue and fleet

| Method | Route                                                      | Purpose                                                             |
| ------ | ---------------------------------------------------------- | ------------------------------------------------------------------- |
| `GET`  | `/api/queue`                                               | Local queue state                                                   |
| `POST` | `/api/queue/enqueue`                                       | Enqueue task IDs                                                    |
| `POST` | `/api/queue/start`                                         | Start queue processing                                              |
| `POST` | `/api/queue/pause`                                         | Pause queue processing                                              |
| `POST` | `/api/queue/resume`                                        | Resume queue processing                                             |
| `POST` | `/api/queue/stop`                                          | Stop queue processing                                               |
| `GET`  | `/api/fleet/status`                                        | Fleet state and limits                                              |
| `POST` | `/api/fleet/emergency-stop`                                | Stop active fleet work                                              |
| `GET`  | `/api/fleet/prep-shutdown-survivors`                       | List unconfirmed Windows or POSIX prep trees                        |
| `POST` | `/api/fleet/prep-shutdown-survivors/:taskId/reconcile`     | Acknowledge an independently verified stopped prep tree             |
| `GET`  | `/api/fleet/shared-checkout-shutdown-survivor`             | Read unconfirmed shared-checkout tree ownership                     |
| `POST` | `/api/fleet/shared-checkout-shutdown-survivor/reconcile`   | Acknowledge an independently verified stopped shared-checkout tree  |
| `GET`  | `/api/fleet/worktree-shutdown-survivors`                   | List unconfirmed Windows worktree process trees                     |
| `POST` | `/api/fleet/worktree-shutdown-survivors/:taskId/reconcile` | Acknowledge an independently verified stopped worktree process tree |

Survivor reconciliation is deliberately explicit. Read the current record, independently verify that the entire process tree is gone, then post its exact confirmation token (plus the session ID for shared-checkout or worktree records and the ownership ID for shared-checkout records) with `processTreeConfirmedStopped: true`. Stale tokens or ownership generations return `409`; the monitor never re-signals a PID or process-group ID recovered from disk. Reconciling a worktree survivor clears only the shutdown evidence and does not delete the preserved worktree.

## Federation

| Method | Route                                    | Required scope     | Purpose                              |
| ------ | ---------------------------------------- | ------------------ | ------------------------------------ |
| `GET`  | `/v1/federation/queue`                   | `federation:read`  | Queue, host, and merge-lane state    |
| `POST` | `/v1/federation/queue`                   | `federation:write` | Enqueue a federated job              |
| `GET`  | `/v1/federation/jobs/:jobId`             | `federation:read`  | Read one federated job               |
| `POST` | `/v1/federation/jobs/:jobId/events`      | `federation:write` | Report worker progress or completion |
| `POST` | `/v1/federation/jobs/:jobId/lease/renew` | `federation:write` | Renew a worker lease                 |
| `POST` | `/v1/federation/jobs/:jobId/cancel`      | `federation:write` | Cancel a job                         |
| `GET`  | `/v1/federation/verified`                | `federation:read`  | Read verification ledger rows        |
| `POST` | `/v1/federation/verified`                | `federation:write` | Record verification rows             |

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

| Route family                  | Purpose                                 |
| ----------------------------- | --------------------------------------- |
| `/v1/workflows/*`             | Workflow state and evidence events      |
| `/v1/reviews/*`               | Review bundle submission and inspection |
| `/api/tasks/:taskId/verified` | Record a human verification decision    |
| `/api/tasks/:taskId/advisory` | Read task advisories                    |

## Monitoring, testing, and documentation

| Route family        | Purpose                                                 |
| ------------------- | ------------------------------------------------------- |
| `/api/testing/*`    | Verification command inventory, execution, and history  |
| `/api/monitoring/*` | Configured environment health                           |
| `/api/wiki/*`       | Local project documentation reads and authorized writes |
| `/api/costs*`       | Recorded usage and cost summaries                       |
| `/api/analytics/*`  | Aggregate outcomes and failure patterns                 |

## Server-sent events

Connect to `/api/events/stream`. Optional query parameters narrow the stream to a session or project. See [SSE events](SSE_EVENTS_REFERENCE.md) for event names and payload examples.

```js
const events = new EventSource("http://127.0.0.1:3333/api/events/stream");
events.onmessage = (event) => console.log(JSON.parse(event.data));
```

## Recovery and terminal observations

### POST /api/diag/claude-auth

Runs one explicit Claude authentication probe for the resolved project. Normal
write authorization applies; configured service credentials require
`admin:write`. Multi-project writes must identify the project. The response
contains `claudeAuth.configuration`, `claudeAuth.probe` and `claudeAuth.ready`.

The probe has no tools, a three-turn limit, a $0.05 budget and a ten-second
timeout. Results are cached for one minute; concurrent requests share a probe.
Credential changes invalidate its cached result. HTTP `200` means the selected
credential completed the probe; `503` reports conflict, failure or timeout.
Credential values are not returned.

Health GETs only read this evidence. `ready: null` with `probe.status: unprobed`
means no current probe has established authentication. CLI login is not inferred
from the presence or absence of environment tokens.

### GET /api/tasks/:id/prep/job

Returns `{ "job": PrepJob }` for the latest observed preparation attempt,
including after a monitor restart. Terminal observations contain `jobId`,
`completedAt`, `exitCode`, `signal`, a validated `result` or `error`, and bounded
sanitized `diagnostics.stdout` and `diagnostics.stderr` with truncation flags.
Malformed stored evidence returns `503`; an absent attempt returns `404`.
Normal project selection and read authorization apply.

`completed` means the child computed a valid gate result. Inspect
`result.outcome`: `rejected` is a completed readiness decision and does not make
the task ready. The job stays `running` until child stdio closes. Durable
observations do not recreate active process ownership.

### GET /api/tasks/:id/prep

Returns the current cached `PrepResult` with these fields:

| Field                    | Type                                 | Meaning                                                 |
| ------------------------ | ------------------------------------ | ------------------------------------------------------- |
| `taskId`                 | string                               | Task identifier                                         |
| `preparedAt`             | string                               | Preparation time in ISO 8601 format                     |
| `schemaValid`            | boolean                              | Schema validation outcome                               |
| `schemaErrors`           | string[]                             | Schema validation errors                                |
| `depthScore`             | number                               | Depth evaluation from 0 to 5; required threshold is 4.7 |
| `depthReady`             | boolean                              | Depth readiness decision                                |
| `deficiencies`           | string[]                             | Issues found by depth evaluation                        |
| `outcome`                | `"pass" \| "enriched" \| "rejected"` | Gate outcome                                            |
| `recommendDecomposition` | boolean, optional                    | Whether decomposition is recommended                    |
| `decompositionReason`    | string, optional                     | Explanation of that recommendation                      |
| `stale`                  | boolean                              | Whether the cached input is outdated                    |
| `contentHash`            | string, optional                     | Hash of preparation inputs                              |

The gate field is `depthScore`. The broader preflight result uses a separate
`gate.score` field. A missing or outdated prep result returns `404`; an outdated
result includes `stale: true` and `currentSpecHash`. The response also includes
the latest observed `job` when available, independently of readiness cache state.

### GET /api/tasks/:id/dispatch/observation

Requires `projectId`, `jobId`, `hostId`, `leaseId` and `sessionId` query fields.
Together with the path task ID, these identify one exact attempt. Missing fields
return `400`, an absent or mismatched attempt returns `404`, and unavailable or
malformed stored evidence returns `503`. Existing project authorization applies.

The response is `{ identity, job, settled, source }`; `source` is `memory` or
`durable`. A terminal result is settled only after child stdio and owned exit
work finish. `completedAt` is its completion time. Durable observations neither
restore process ownership nor authorize a new start. A newer same-task run
cannot supply the older attempt's result.

An internal credential retry can record `job.replacementSessionId` only after
the host admits a child with the same project, task, job, host and lease. A
listener follows that explicit successor and rejects cycles. Verification and
merge evidence must belong to the exact session with matching start identity.

### Listener diagnostics and queue recovery

`GET /v1/listeners` includes `registryHealth`;
`GET /v1/federation/queue` includes `summary.listenerRegistry`. Both expose
`healthy`, `unavailable` and `issues` with file identity, code and bounded reason.
Valid sibling workers remain visible when another record is malformed. Corrupt
bytes remain available for repair, and static fallback cannot replace that
worker's identity. An unreadable record needed by mutation or identity checking
returns `503` with `listener_registry_unavailable`.

Repeating `POST /v1/federation/queue` with the same project, task, job type and
execution intent reuses the unfinished job and returns `reused: true`, preserving
its original provenance. Conflicting intent, ambiguous unfinished records or a
manual-recovery block returns `409` with `federated_queue_conflict`.

Scheduler ticks and completed prep observations revisit only recognized
recoverable pre-start blocks. Each decision rereads the job under its owner
fence and checks current task declarations, content, readiness, dependencies and
host state. Completion replay also recognizes historical dependency tuples
whose `retryable` field is absent; it performs the same current-authority checks.
A computed prep rejection remains blocked. Human gates, manual uncertainty,
prior worker activity and retained leases are not automatically released.
Fleet pause and monitor drain still prevent assignment.

### Verification integrity

Verification GETs do not update timestamps, append history, change task status
or rewrite `.quack/verified.json`. An unavailable verification database returns
`503` rather than an empty authoritative result.

`POST /api/tasks/:id/verified` and `POST /v1/federation/verified` use the same
canonical schema: supported verdicts, a nonempty method, nonnegative safe integer
counts with passed no greater than checked, real ISO calendar dates, and UTC
write cursors no more than five minutes ahead. Review/workflow identifiers may
not contain path separators; unknown write fields are rejected. Invalid payloads
return `400`. A federation batch is validated before its first entry is written.

Positive `VERIFIED` and `SOFT-VERIFIED` records require a hexadecimal Git commit
identifier: 7-40 characters, or a full 64-character SHA-256 identifier. A failure
or rejection can use a meaningful placeholder such as `n/a` when no commit
exists. Reviews supply this implementation identity as top-level `commitSha`,
independently of any documentation artifact's commit.

A review without valid implementation evidence can still preserve its review
bundle, but its ledger bridge reports `ledger.error` and creates no positive
verification record. Check `ledger.applied`; a successful review response alone
does not prove the ledger write succeeded. Documentation readiness and verified
implementation remain separate from permission to merge.

Projection updates require a healthy SQLite database and serialize across
processes. A missing projection can be created; malformed or unreadable existing
evidence is preserved and reported. Database rows are authoritative for IDs they
contain, while unreconciled JSON-only evidence is retained. Repair corrupt
evidence explicitly before retrying reconciliation.

## Compatibility and discovery

The route implementation in `src/monitor/server.ts` and `src/monitor/routes/` is authoritative. For generated clients, capture representative responses from the exact version you deploy; no OpenAPI stability guarantee is made before `1.0`.
