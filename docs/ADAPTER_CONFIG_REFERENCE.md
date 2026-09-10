# Adapter configuration

Each target project configures Quack Harness through `<PROJECT_PATH>/.quack/adapter.json`. The adapter keeps repository-specific paths, commands, limits, and Git behavior outside the reusable orchestration core.

Start with [`adapters/examples/node-typescript/adapter.json`](../adapters/examples/node-typescript/adapter.json) and adjust it for a disposable branch before enabling agent execution.

## Minimal structure

```json
{
  "version": "1.0",
  "project": {
    "name": "example-project",
    "root": ".",
    "taskDir": "docs/tasks",
    "conventionsDir": "docs/conventions"
  },
  "agent": {
    "model": "claude-sonnet-4-6",
    "judgeModel": "claude-sonnet-4-6",
    "enrichModel": "claude-sonnet-4-6",
    "maxTurns": 80,
    "maxBudgetPerTask": 5,
    "maxRetries": 2
  },
  "sandbox": {
    "writablePaths": ["src/", "tests/"],
    "deniedPaths": [".git/", ".env", "node_modules/"],
    "allowedBashPatterns": ["npm test*", "npm run build*"],
    "deniedBashPatterns": ["git push*", "git reset --hard*"]
  },
  "verification": {
    "commands": [{ "name": "test", "command": "npm test", "required": true, "timeout": 300000 }],
    "conventionChecks": []
  },
  "git": {
    "baseBranch": "main",
    "branchPrefix": "quack/",
    "commitFormat": "[{taskId}] {message}",
    "autoCreatePr": false,
    "autoPush": false,
    "autoMerge": false
  },
  "logging": {
    "dir": ".quack/logs",
    "level": "info",
    "retainDays": 14
  }
}
```

## `project`

| Field            | Meaning                                              |
| ---------------- | ---------------------------------------------------- |
| `name`           | Human-readable project name                          |
| `root`           | Project root, normally `.`                           |
| `taskDir`        | Directory containing structured task Markdown        |
| `conventionsDir` | Directory containing referenced convention documents |
| `testPatterns`   | Optional source-to-test discovery rules              |

Paths are resolved under the target project. Task file references that are absolute or escape the project root are rejected.

## `agent`

| Field              | Meaning                                              |
| ------------------ | ---------------------------------------------------- |
| `model`            | Primary worker model                                 |
| `judgeModel`       | Model used for criterion review                      |
| `enrichModel`      | Model used to improve incomplete task specifications |
| `maxTurns`         | Per-run turn limit                                   |
| `maxBudgetPerTask` | Per-run provider budget in US dollars                |
| `maxRetries`       | Maximum implementation retries                       |

Model availability depends on the installed provider SDK and account.

## `sandbox`

`writablePaths` is an allowlist relative to the target project. `deniedPaths` takes precedence. Keep credentials, Git internals, dependency folders, generated builds, and adapter policy files denied.

`allowedBashPatterns` and `deniedBashPatterns` use full-command glob matching. An allowlist entry represents one command invocation; shell control operators, command substitution, pipelines, and redirection are rejected when an allowlist is active. Keep the list narrow and prefer deterministic package scripts.

## `verification`

Each command has a display `name`, shell `command`, `required` flag, and timeout in milliseconds. Required failures block successful completion. Optional convention checks can add repository-specific deterministic rules.

Smart testing can map changed source files to related test files and maintain a baseline. Treat it as an optimization; retain a required full verification command for release-critical changes.

## `git`

Configure the base branch, generated branch prefix, commit format, and optional pull-request behavior. Automatic push, pull-request creation, and merge are disabled in the example adapter. Enable them only after testing with least-privilege credentials and protected branches.

## `logging` and runtime state

Logs, checkpoints, databases, queue state, generated worktrees, and credentials are runtime data. Keep them under ignored `.quack/` paths or an external state directory. Do not commit them.

Docker isolation has a deliberately narrow host-mount contract:

- `logging.dir` must be exactly the project's `.quack/logs` directory. That host-owned tree is never writable by the container. Each dispatch writes to a fresh disposable output leaf inside its task worktree. A host bridge validates task, session, project, provenance, event type, and payload schema before copying live progress into the monitor log; control artifacts are imported only after container exit and are accepted from a strict allowlist.
- The task-specific Git worktree is mounted read-write. Quack's runtime, prep cache, and adapter policy files are separate read-only mounts. The container receives a private Git directory inside that disposable worktree and read-only access to the authoritative object store; it never receives writable authoritative refs, configuration, hooks, or linked-worktree metadata.
- A successful container result is content-address validated and pinned under a host-created recovery ref before publication. Push, pull-request creation, merge, task-status update, and branch cleanup run on the trusted host under a durable journal. If a required step fails, `resume` continues that exact publication without rerunning the container or discarding its approval/worktree ownership.
- Additional `volumes` must be explicit project-relative or project-contained bind sources ending in exactly `:ro`. They are remapped to the task worktree, checked for links and aliases, and may be mounted only below the inert `/quack-inputs/` namespace. Named volumes, operating-system/runtime destinations, and option variants such as `:ro,z`, `:Z`, or `:rw` are rejected.
- `keep_on_failure` and `always_keep` are durable retention policies. A confirmed stopped retained container does not block unrelated work, but the same task remains reserved until an operator explicitly cleans up retained resources.

## Optional capabilities

The schema also supports optional sections for:

- Docker or process isolation
- queue concurrency and failure policy
- fleet budgets and velocity limits
- worker profiles and federation
- GitHub issue synchronization
- model routing and preflight behavior
- deployment monitoring
- judgment and review policy

Defaults and validation are implemented in `src/core/adapter-schema.ts`. Add optional sections incrementally and validate with:

```bash
node dist/index.js status --project <PROJECT_PATH>
node dist/index.js preflight TASK-001 --project <PROJECT_PATH>
```

Never put provider keys, service tokens, personal paths, private URLs, or account identifiers in a committed adapter.
