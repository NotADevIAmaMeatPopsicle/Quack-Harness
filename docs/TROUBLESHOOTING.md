# Troubleshooting

## The build cannot find frontend dependencies

The root install does not install the nested Vite project. Install both dependency sets:

```bash
npm ci
npm --prefix frontend ci
npm run build
```

## The monitor starts but no project appears

Pass an explicit project path and confirm that it contains `.quack/adapter.json`:

```bash
node dist/index.js monitor --project <PROJECT_PATH> --port 3333
```

Validate JSON syntax and review the adapter paths against the [configuration reference](ADAPTER_CONFIG_REFERENCE.md).

## Agent-backed commands report a missing key

Copy `.env.example` to `.env`, add a valid provider key locally, and confirm `.env` remains ignored. Never paste real credentials into task specifications, logs, screenshots, or issue reports.

## A task does not pass readiness checks

Confirm that the task contains a clear objective, bounded scope, testable success criteria, file-level integration guidance, testing requirements, dependencies, and explicit non-goals. Run:

```bash
node dist/index.js prep TASK-001 --project <PROJECT_PATH>
node dist/index.js preflight TASK-001 --project <PROJECT_PATH>
```

Use the diagnostic output to improve the task rather than bypassing the gate.

## A verification command works manually but fails in Quack Harness

Check the command's working directory, environment variables, timeout, and shell compatibility. Commands run from the target project context defined by its adapter. Prefer portable commands and avoid assumptions about a particular username or absolute machine path.

## Tests do not exit

Look for open servers, watchers, database handles, or timers. Server-side intervals should be released during teardown and should not keep Jest workers alive unnecessarily.

## Worktree creation fails

Check that:

- the base branch exists locally
- the repository has no stale lock files
- the configured worktree directory is writable
- Git credentials can access the configured remote
- another process is not using the intended branch or worktree path

Do not use destructive Git cleanup commands until you have identified the exact worktree and preserved uncommitted work.

## A worker cannot reach the headnode

Verify the configured URL, TLS certificate, service-token scope, firewall policy, and clock synchronization. Use `example.test` addresses in shared diagnostics, and redact tokens before opening an issue.

## Where to report a problem

Use a GitHub issue for reproducible, non-sensitive bugs. Follow [SECURITY.md](../SECURITY.md) for vulnerabilities or suspected credential exposure.
