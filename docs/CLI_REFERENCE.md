# CLI Reference

Complete reference for all Quack CLI commands. For installation and first-time setup, see [GETTING-STARTED.md](./GETTING-STARTED.md).

For live admin/operator sessions, the CLI and the live swarm are different
surfaces. `quack run` is for direct local execution in a normal shell. The
canonical live swarm path is Headnode `POST /v1/federation/queue`; do not run
`quack run` from inside an active Claude Code or Codex admin loop.

## Invoking Quack

After installation, commands are available as `quack <command>`. On systems where `npm link` does not add `quack` to your PATH, use the equivalent:

```bash
node dist/index.js <command> [args] [flags]
```

Both forms are identical. All examples below use the `quack` shorthand.

## Quick Reference

| Command | Arguments | Description |
|---------|-----------|-------------|
| `run` | `<taskId>` | Execute a single task through the full pipeline |
| `wave` | `<waveNumber>` | Execute the dependency-ready task frontier |
| `verify` | `<taskId>` | Run verification checks only (no agent) |
| `enrich` | `<taskId>` | Run readiness gate and auto-enrichment only |
| `init` | `<projectPath>` | Bootstrap a `.quack/` adapter for a new project |
| `status` | _(none)_ | Show task backlog status and readiness |
| `monitor` | _(none)_ | Start the web monitoring dashboard |
| `prep` | `<taskId>` | Run gate checks and write result to prep cache |
| `preflight` | `<taskId>` | Run full pre-flight pipeline (gate + blueprint + estimate) |
| `plan` | `<prompt>` | Generate task specs from a natural language prompt |
| `decompose` | `<taskId>` | Decompose a complex task into focused subtasks |
| `queue` | `[taskIds...]` | Queue management: enqueue, start, pause, status |
| `overnight` | _(none)_ | Guarded overnight prep/dispatch/verify runner |
| `repair-state` | _(none)_ | Reconcile Quack DB/projections and repair generated projection git hygiene |

The `--project <path>` flag is available on every command. It defaults to the current working directory.

---

## repair-state

Reconciles Quack's local DB/projection state and can migrate generated
projection files out of git tracking.

```bash
quack repair-state --project /path/to/project
quack repair-state --project /path/to/project --migrate-generated-projections --dry-run
quack repair-state --project /path/to/project --migrate-generated-projections --apply
```

Generated projection migration only touches `.quack/verified.json` and
`.quack/reviews/latest-by-task.json`: it appends exact `.gitignore` entries and
runs `git rm --cached -f` for tracked generated projections. It leaves
individual `.quack/reviews/<reviewId>.json` audit bundles alone and does not
commit automatically.

---

## run

Execute a single task through the full dispatch pipeline: gate, branch, context assembly, agent, verification, and judge.

For live swarm dispatch from an operator workstation, queue work through
`POST /v1/federation/queue` on Headnode instead of calling this CLI from a
nested admin session.

```
quack run <taskId> [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project <path>` | string | cwd | Path to project root containing `.quack/` |
| `--dry-run` | boolean | false | Show what would happen without executing; runs gate and context assembly only |
| `--skip-gate` | boolean | false | Skip the LLM readiness gate (useful with `--dry-run` for inspection) |
| `--model <model>` | string | from adapter | Override the agent model for this run |
| `--max-turns <n>` | integer | from adapter | Override max API turns (capped to adapter `maxTurns`) |
| `--max-budget <n>` | float | from adapter | Override max cost in USD (capped to adapter `maxBudgetPerTask`) |
| `--output-format <format>` | string | `text` | Output format: `text` (human-readable) or `stream-json` (newline-delimited JSON events) |
| `--resume` | boolean | false | Resume from a previous checkpoint instead of starting fresh |

CLI overrides for `--max-turns` and `--max-budget` are silently capped to the adapter limits — they cannot exceed what is configured in `adapter.json`.

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Task approved (pipeline completed successfully) |
| `1` | Error or pipeline failure (gate, agent, or unexpected error) |
| `2` | Task rejected by judge |

### Examples

```bash
# Standard run
quack run TASK-001 --project /path/to/project

# Dry run: inspect gate result and context without executing
quack run TASK-001 --dry-run --project /path/to/project

# Override model and budget
quack run TASK-001 --model claude-opus-4-6 --max-budget 10.00

# Stream events as JSON (for CI or scripting)
quack run TASK-001 --output-format stream-json

# Resume a previously checkpointed session
quack run TASK-001 --resume
```

---

## wave

Dispatch the current dependency-ready frontier as a numbered wave. The number is
an operator-facing run label; readiness is always computed from current task/DB
status and declared dependencies.

```
quack wave <waveNumber> [flags]
```

Every selected task runs through the same `quack run` child path used by the
monitor. Dispatch normally uses an isolated worktree; if worktree creation
fails, the shared-checkout fallback is serialized. `--parallel` limits
concurrent children, and remaining ready tasks wait for a slot. A failed task is
reported without cancelling its siblings, and the command exits nonzero after
the whole selected wave settles.
If degraded isolation leaves the shared checkout paused for human approval,
later tasks are refused until that pause is resolved or stopped.
`SIGINT` and `SIGTERM` stop active dispatches, stop the wave watchdog, and wait
briefly for worker cleanup before returning a signal-specific exit code.

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project <path>` | string | cwd | Path to project root |
| `--parallel <count>` | integer | `1` | Maximum number of tasks running concurrently |

### Examples

```bash
# Run the current ready frontier as wave 1
quack wave 1 --project /path/to/project

# Run the current ready frontier with up to 3 concurrent tasks
quack wave 2 --parallel 3 --project /path/to/project
```

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Every selected task completed successfully (or no task was ready and no parse error occurred) |
| `1` | At least one task failed, stopped, paused for approval, could not start, disappeared, or a task spec could not be parsed |

---

## verify

Run verification commands (build, test, lint) and convention checks on the current branch, without running the agent. Useful for checking whether an existing branch already passes all checks.

```
quack verify <taskId> [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project <path>` | string | cwd | Path to project root |

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | All verification checks passed |
| `1` | One or more checks failed (or an error occurred) |

### Examples

```bash
quack verify TASK-001 --project /path/to/project
```

---

## enrich

Run the readiness gate (schema validation + LLM depth evaluation) on a task, and if the task is under-specified, use the enrichment agent to improve it. Prompts for approval before writing changes.

```
quack enrich <taskId> [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project <path>` | string | cwd | Path to project root |

### Approval prompt

After enrichment completes, the command shows a diff and asks:

```
Approve enrichment? (y/n/edit):
```

- `y` — Write the enriched content back to the task file
- `n` — Leave the task file unchanged
- `edit` - Write enriched content to `.quack/enriched/<taskId>.enriched.md` for manual editing

### Exit codes

| Code | Meaning |
|------|---------|
| `0` | Gate already passes, or enrichment approved and written |
| `1` | Unrecognized response or unexpected error |
| `2` | Gate rejected (not enrichable), or enrichment rejected by user |

### Examples

```bash
quack enrich TASK-001 --project /path/to/project
```

---

## init

Bootstrap a new project by scanning it and generating a starter `.quack/` directory with `adapter.json`, `conventions.md`, `TESTING.md`, and a convention check script.

```
quack init <projectPath> [flags]
```

### Arguments

| Argument | Description |
|----------|-------------|
| `projectPath` | Absolute or relative path to the project root to initialize |

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project <path>` | string | cwd | (Unused in practice — `projectPath` is the positional argument) |

### What gets created

| File | Description |
|------|-------------|
| `.quack/adapter.json` | Main config, auto-populated from scan results |
| `.quack/conventions.md` | Coding standards (extracted from CLAUDE.md or README if present) |
| `.quack/TESTING.md` | Testing conventions for agent guidance |
| `.quack/convention-checks/test-existence-check.js` | Convention check script |
| `.quack/test-existence.config.json` | Config for the test existence check |
| `<taskDir>/` | Empty task directory (path from adapter) |
| `.quack/logs/` | Log directory |

If `.quack/` already exists, `init` aborts without overwriting anything.

### Detected languages

The scanner detects: `node`, `python`, `rust`, `go`. Unknown projects still generate a usable adapter with placeholders.

### Examples

```bash
# Bootstrap a project at an absolute path
quack init /path/to/my-project

# Bootstrap the current directory
quack init .
```

After running, review `.quack/conventions.md` and `.quack/adapter.json` before running any tasks. See [GETTING-STARTED.md](./GETTING-STARTED.md) for guidance on what to edit.

---

## status

Print a summary of the task backlog: totals by status and priority, plus the list of eligible (unblocked, BACKLOG) tasks sorted by priority.

```
quack status [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project <path>` | string | cwd | Path to project root |

### Output

- Task counts grouped by status (`IN_PROGRESS`, `READY`, `BACKLOG`, `VERIFYING`, `COMPLETE`, `REJECTED`)
- Task counts grouped by priority (`P0-CRITICAL`, `P1-HIGH`, `P2-MEDIUM`, `P3-LOW`)
- List of eligible tasks (unblocked BACKLOG tasks) with ID, priority, and title
- Any parse errors found in task files

### Examples

```bash
quack status --project /path/to/project
```

---

## monitor

Start the web monitoring dashboard. Watches `.quack/logs/` for JSONL event files and streams them to the browser via SSE. Also exposes the dispatch REST API.

```
quack monitor [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--port <port>` | integer | `3333` | HTTP port to listen on |
| `--host <host>` | string | `127.0.0.1` | Bind host; IPv6 addresses are bracketed in displayed URLs |
| `--project <path>` | string | cwd | Path to project root. Repeatable for multi-project mode |

The `--project` flag can be specified multiple times to load multiple projects:

```bash
quack monitor --project /path/to/project-a --project /path/to/project-b
```

### URLs (single-project mode)

| URL | Description |
|-----|-------------|
| `http://localhost:3333` | Dashboard UI |
| `http://localhost:3333/api/events/stream` | SSE event stream |
| `http://localhost:3333/api/health` | Health check |

### URLs (multi-project mode)

Adds:

| URL | Description |
|-----|-------------|
| `http://localhost:3333/api/projects` | List all registered projects |

### Examples

```bash
# Single-project monitor
quack monitor --project /path/to/project

# Custom port
quack monitor --port 4000 --project /path/to/project

# Multi-project
quack monitor --project /path/to/project-a --project /path/to/project-b
```

These URLs describe the monitor you started on the current host. A distributed
deployment can expose a separately secured headnode and attach worker hosts;
choose ports and network controls appropriate for your environment.

The monitor must be running for `queue` subcommands and the dispatch REST API to work. Stop it with `Ctrl+C`.

---

## worker-runtime

Start the headless loopback worker runtime without serving the operator UI.

```
quack worker-runtime [flags]
quack worker runtime [flags]
```

### Common flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--port <port>` | integer | `3337` | Worker runtime HTTP port |
| `--host <host>` | string | `127.0.0.1` | Bind host |
| `--project <path>` | string, repeatable | current project / global config | Project(s) this worker runtime should serve |

### Notes

- `quack worker-runtime` and `quack worker runtime` are equivalent.
- Worker runtimes are intentionally loopback/headless and report to Headnode
  through the listener protocol rather than serving the Quack UI.

---

## worker enroll

Create a one-time worker enrollment bundle from the headnode. This is the
operator-side CLI equivalent of the Monitoring page's `Worker Enrollment`
panel.

```
quack worker enroll --host-id <id> [flags]
```

### Common flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--control-base-url <url>` | string | `http://127.0.0.1:3333` | Headnode base URL |
| `--api-key <key>` | string | `QUACK_API_KEY` | Dashboard API key for auth-enabled headnodes |
| `--host-id <id>` | string | required | Stable worker host ID |
| `--alias <name>` | string | host ID | Human-friendly worker alias |
| `--profile-id <id>` | string | headnode default | Worker enrollment profile |
| `--project-id <id>` | string | profile primary project | Project binding |
| `--capabilities <csv>` | string | profile capabilities | Comma-separated capability override |
| `--max-concurrent-jobs <n>` | integer | profile default | Override worker concurrency |
| `--persistence <mode>` | string | profile default | Startup mode |
| `--ttl-minutes <n>` | integer | `60` | Enrollment token lifetime |
| `--target-root-windows <path>` | string | unset | Populate the Windows command with a concrete worker root |
| `--target-root-posix <path>` | string | unset | Populate the POSIX command with a concrete worker root |
| `--bundle` | flag | `false` | Print a contributor-ready onboarding bundle |
| `--json` | flag | `false` | Print the raw JSON payload |

### Example

```bash
quack worker enroll \
  --control-base-url http://127.0.0.1:3333 \
  --host-id contributor-gaming-machine \
  --profile-id example-worker \
  --target-root-windows "<PROJECT_PATH>\QuackWorkers\example-worker"
```

The response includes a one-time bootstrap token plus copy-ready install and
repair commands for both Windows and POSIX hosts.

---

## worker install

Consume a one-time bootstrap token and prepare or refresh a worker host.

```
quack worker install --bootstrap-token <token> [flags]
```

### Common flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--control-base-url <url>` | string | `http://127.0.0.1:3333` | Headnode base URL |
| `--target-root <path>` | string | inferred from cwd | Worker root directory |
| `--listener-base-url <url>` | string | auto-detected | Advertised listener URL |
| `--persistence <mode>` | string | manifest default | Override persistence mode |
| `--repair` | flag | `false` | Refresh an existing worker root with the same manifest-driven path |
| `--no-start` | flag | `false` | Prepare files but do not start runtime/listener |
| `--dry-run` | flag | `false` | Print the plan without executing it |

### Behavior

- runs prerequisite checks
- clones or fast-forwards Quack and project repos
- executes manifest-driven install and probe commands
- writes `.quack/<hostId>-worker.env`, project env stubs, and a capability report
- starts the headless worker runtime and listener
- posts progress to the headnode until the worker is healthy

### Example

```bash
node dist/index.js worker install \
  --control-base-url http://127.0.0.1:3333 \
  --bootstrap-token qenr_... \
  --target-root "<PROJECT_PATH>\QuackWorkers\example-worker" \
  --start
```

Use `--repair` with a fresh one-time enrollment to refresh an already-enrolled
worker after Quack or project setup changes.

---

## prep

Run gate checks (schema validation + LLM depth evaluation) for a task and write the result to `.quack/prep/<taskId>.json`. This is the same operation that the monitor's "Prep Task" button triggers.

```
quack prep <taskId> [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project <path>` | string | cwd | Path to project root |

### Output

Prints a single JSON object to stdout:

```json
{
  "schemaValid": true,
  "schemaErrors": [],
  "depthScore": 4,
  "depthReady": true,
  "deficiencies": [],
  "outcome": "pass"
}
```

Also writes the result to `.quack/prep/<taskId>.json` for the monitor to read.

### Examples

```bash
quack prep TASK-001 --project /path/to/project
```

---

## preflight

Run the full pre-flight pipeline: readiness gate, blueprint generation, context size estimation, and complexity evaluation. Results are cached to `.quack/prep/` and reused by the dispatcher.

```
quack preflight <taskId> [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project <path>` | string | cwd | Path to project root |
| `--json` | boolean | false | Output machine-readable JSON instead of human-readable text |
| `--force` | boolean | false | Skip cache and re-run even if a cached result exists |

### Output (human-readable)

```
── Pre-Flight Report: TASK-001 ──

Gate: PASS (score: 4)
  clarity: 4
  scope: 5
  testability: 4
  ...

Blueprint:
  File analyses: 6
  Code examples: 4
  Verification patterns: 3
  Anti-patterns: 1

Context Estimate (tokens):
  Task spec: 1200
  Blueprint: 3400
  ...
  Total: 18500
  Within budget: true

Complexity:
  Files to modify: 4
  Success criteria: 7
  Est. context tokens: 18500
  Recommend decomposition: false
  Reason: Within all thresholds
```

### Examples

```bash
# Human-readable report
quack preflight TASK-001 --project /path/to/project

# JSON output for scripting
quack preflight TASK-001 --json --project /path/to/project

# Force re-run, bypassing cache
quack preflight TASK-001 --force --project /path/to/project
```

---

## plan

Generate one or more TASK-NNN.md spec files from a natural language prompt. The planner agent reads your codebase (read-only) to understand the existing architecture before writing specs.

```
quack plan "<prompt>" [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project <path>` | string | cwd | Path to project root |
| `--model <model>` | string | from adapter `modelRouting.plannerModel` | Override the planner model |
| `--max-tasks <n>` | integer | `10` | Maximum number of task specs to generate |
| `--dry-run` | boolean | false | Print generated specs to stdout without writing files |
| `--start-id <n>` | integer | auto-detected | Starting task number (auto-detects next available number if not set) |

### Examples

```bash
# Generate tasks from a prompt (writes files to task dir)
quack plan "Add rate limiting to the API endpoints" --project /path/to/project

# Preview without writing
quack plan "Refactor the authentication module" --dry-run --project /path/to/project

# Limit to 3 tasks
quack plan "Migrate database to PostgreSQL" --max-tasks 3

# Start numbering from TASK-050
quack plan "Add caching layer" --start-id 50

# Use a specific model
quack plan "Add WebSocket support" --model claude-opus-4-6
```

Review generated specs before dispatching — the planner gives a strong starting point, but verify that file paths and integration details are correct.

---

## decompose

Decompose a complex task into focused subtasks. Evaluates complexity first; aborts if the task does not exceed thresholds. Generates blueprint, splits by file cluster, and writes subtask spec files.

```
quack decompose <taskId> [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project <path>` | string | cwd | Path to project root |
| `--dry-run` | boolean | false | Show decomposition plan without writing any files |
| `--enqueue` | boolean | false | Enqueue generated subtasks in the dispatch queue after writing |
| `--max-subtasks <n>` | integer | `4` | Maximum number of subtasks to generate |
| `--port <n>` | integer | `3333` | Monitor server port, used only when `--enqueue` is set |

### Complexity thresholds

Decomposition is recommended when any of the following is exceeded (configurable via `adapter.json` `preflight.complexityThresholds`):

- More than 6 files to modify
- More than 10 success criteria
- Context estimate exceeds 35,000 tokens

If none of these thresholds are exceeded, `decompose` exits with code 1 and prints a message explaining why decomposition is not recommended.

### Examples

```bash
# Decompose and write subtask files
quack decompose TASK-042 --project /path/to/project

# Preview decomposition plan only
quack decompose TASK-042 --dry-run

# Decompose and immediately enqueue subtasks
quack decompose TASK-042 --enqueue --port 3333

# Limit to 3 subtasks
quack decompose TASK-042 --max-subtasks 3
```

When `--enqueue` is set, the monitor must be running on the specified port.

---

## queue

Manage the dispatch queue. All subcommands communicate with the monitor REST API; the monitor must be running. Without a subcommand flag and without task IDs, prints usage.

```
quack queue [taskIds...] [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project <path>` | string | cwd | Path to project root |
| `--port <n>` | integer | `3333` | Monitor server port |
| `--all` | boolean | false | Enqueue all eligible tasks |
| `--start` | boolean | false | Start processing the queue |
| `--pause` | boolean | false | Pause the queue (running tasks complete) |
| `--resume` | boolean | false | Resume a paused queue |
| `--stop` | boolean | false | Stop the queue (wait for running tasks to finish) |
| `--abort` | boolean | false | Abort the queue (kill all running tasks immediately) |
| `--status` | boolean | false | Print current queue status |

### Examples

```bash
# Enqueue specific tasks
quack queue TASK-031 TASK-033

# Enqueue all eligible tasks
quack queue --all

# Enqueue all and immediately start processing
quack queue --all --start

# Show queue status
quack queue --status

# Pause the queue
quack queue --pause

# Resume after pausing
quack queue --resume

# Stop gracefully (running tasks finish before stopping)
quack queue --stop

# Kill all running tasks immediately
quack queue --abort

# Use a non-default port
quack queue --status --port 4000
```

`--stop` and `--abort` differ: `--stop` lets in-flight tasks finish, `--abort` kills them immediately.

---

## overnight

Run a guarded overnight operator loop: inventory tasks, prep one task at a time,
dispatch at most one Quack worker, optionally enrich low-score specs, verify
approved work, and checkpoint every decision.

```
quack overnight [flags]
```

### Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--project <path>` | string | cwd | Target project root |
| `--monitor-url <url>` | string | `http://localhost:3333` | Headnode/monitor base URL |
| `--task-ids <ids>` | string | READY tasks | Comma/space separated task IDs |
| `--source-branch <branch>` | string | none | Add task files changed on a teammate branch |
| `--target-branch <branch>` | string | `dev` | Diff base for `--source-branch` |
| `--checkpoint <path>` | string | `.quack/overnight-runs/<date>-overnight-run.json` | Resume/checkpoint file |
| `--min-score <n>` | number | `4.5` | Minimum prep depth score |
| `--max-prep-attempts <n>` | integer | `2` | Prep attempts before manual review |
| `--auto-enrich` | boolean | false | Use monitor enrichment and approve returned content |
| `--max-enrichment-attempts <n>` | integer | `1` | Auto-enrichment attempts per task |
| `--max-dispatches <n>` | integer | unlimited | Dispatch start cap for this invocation |
| `--active-dispatch-limit <n>` | integer | `1` | Hard active worker limit |
| `--no-verify-after-dispatch` | boolean | false | Skip post-approval verify API call |
| `--full-gate` | boolean | false | Re-run the full gate during dispatch |
| `--allow-parse-errors` | boolean | false | Do not halt when unrelated task parse errors exist |
| `--max-infra-failures <n>` | integer | `1` | Halt after this many Quack infra failures |
| `--max-budget-usd <n>` | number | none | Halt after observed session cost reaches cap |
| `--dry-run` | boolean | false | Plan without monitor mutations or checkpoint writes |
| `--once` | boolean | false | Execute one lane action and exit |
| `--federation-dispatch` | boolean | auto | Dispatch through `/v1/federation/queue` instead of `/api/tasks/:id/start`. Auto-enabled when `QUACK_SERVICE_TOKEN` is set. |
| `--preferred-host-id <hostId>` | string | none | Preferred federation host for dispatched jobs (e.g. `headnode`) |
| `--allow-low-preflight-on-federation-dispatch` | boolean | false | Pass `allowLowPreflight:true` to the federation queue |
| `--auto-acknowledge-decompose-review` | boolean | false | When `--auto-decompose` is enabled, proceed to finalize without operator review. Without this flag the runner stops at `manual_review` after materialization so an operator can inspect drafts before committing child specs. |

### Environment Variables

| Variable | Required | Description |
|----------|----------|-------------|
| `QUACK_SERVICE_TOKEN` | When using `--federation-dispatch` | Service token for the `X-Quack-Service-Token` header. When set, federation dispatch is auto-enabled unless `--federation-dispatch` is explicitly omitted. If federation dispatch is requested but the token is missing, the runner marks the task as `quack_infra` failure with an actionable error. |

### Examples

```bash
# Standard Contributor branch overnight intake/run on Headnode
quack overnight \
  --project /srv/example-service-dev \
  --source-branch contributor/feature-branch \
  --target-branch dev \
  --auto-enrich \
  --max-dispatches 10

# Safer rehearsal: one decision only, no writes or dispatches
quack overnight --project /srv/example-service-dev \
  --task-ids TASK-894,TASK-895 --once --dry-run

# Live swarm dispatch through federation queue on Headnode
QUACK_SERVICE_TOKEN=your-token quack overnight \
  --project /srv/example-service-dev \
  --federation-dispatch \
  --preferred-host-id headnode \
  --source-branch contributor/feature-branch \
  --target-branch dev \
  --auto-enrich \
  --max-dispatches 5
```

### Dispatch Modes

The overnight runner supports two dispatch modes:

- **Direct mode** (default when no `QUACK_SERVICE_TOKEN`): Posts to
  `POST /api/tasks/:id/start`. Suitable for local development smoke tests and
  worker-internal federated starts. If the headnode rejects direct dispatch with
  `direct_dispatch_blocked_in_swarm_mode`, the task is classified as
  `quack_infra` with an actionable message telling the operator to set
  `QUACK_SERVICE_TOKEN` and use `--federation-dispatch`.

- **Federation mode** (`--federation-dispatch` or auto-enabled with
  `QUACK_SERVICE_TOKEN`): Posts to `POST /v1/federation/queue` with the
  service token in `X-Quack-Service-Token`. The federation scheduler assigns
  the job to an available host. The runner stores the returned `jobId` on the
  task record and reconciles federation job state during its poll loop. Terminal
  states (`completed`, `failed`, `blocked`, `canceled`) are mapped to overnight
  task statuses. Completed jobs require verification/merge evidence to reach
  `completed`; otherwise they are routed to `manual_review`.

The standard lane policy is intentionally conservative: one active dispatch and
one prep/enrichment action at a time. If the runner sees a Quack infrastructure
failure such as missing adapter dependencies, worktree setup problems, or
`0/0` test evidence, it halts so the platform can be fixed before more tasks
consume turns.
