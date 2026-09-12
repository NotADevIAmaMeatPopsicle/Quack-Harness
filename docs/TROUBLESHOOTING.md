# Troubleshooting

## The build cannot find frontend dependencies

The root `npm ci` installs the nested Vite project through `postinstall`. If the
frontend packages are missing, rerun the root install without `--ignore-scripts`:

```bash
npm ci
npm run build
```

If you intentionally installed with `--ignore-scripts`, install the frontend
dependencies explicitly with `npm --prefix frontend ci` before building.

## A tarball install looks for frontend source or rejects missing assets

Use a current packed release artifact built through `npm pack`. A packed
installation uses prebuilt assets and must not need a `frontend/` directory.
If installation reports a missing CLI, UI asset, build identity, public
document, or worker helper, preserve the tarball checksum and report the
incomplete artifact. Do not bypass the check with `--ignore-scripts` or copy
unrelated output into the installed package.

The supported Node range is 20.19+ within Node 20, or 22.12+ within Node 22.
Other major versions and earlier Node 22 releases are outside this release's
declared dependency contract. Native SQLite installation errors should include
the Node version and platform in a redacted bug report.

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

## Windows worker installation reports an active process or occupied port

The installer does not terminate processes. Stop the intended worker runtime
and listener through their owning terminal, scheduled task, or service, then
retry. Inspect the reported PID before taking action. A legacy relative-path
listener cannot be attributed safely and also requires an explicit stop or
operator reconciliation. Do not stop an unrelated process just to free a port;
select the intended available runtime port instead.

Git for Windows supplies the supported Bash/POSIX tools for verification.
If automatic detection fails, configure `QUACK_BASH_PATH` with the absolute
Git Bash executable and `QUACK_POSIX_BIN_DIR` with its `usr/bin` and `bin`
directories. Preserve the worker's service token in local configuration;
never include it in issue reports or command transcripts.

## Where to report a problem

Use a GitHub issue for reproducible, non-sensitive bugs. Follow [SECURITY.md](../SECURITY.md) for vulnerabilities or suspected credential exposure.
