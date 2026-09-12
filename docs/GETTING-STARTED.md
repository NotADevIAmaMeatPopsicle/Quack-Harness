# Getting started

This guide builds Quack Harness, creates an adapter in a separate example project, and starts the local monitor.

## 1. Install dependencies

Requirements:

- Node.js 20.19 or later in the 20.x series, or 22.12 or later in the 22.x series
- npm
- Git

```bash
git clone https://github.com/NotADevIAmaMeatPopsicle/Quack-Harness.git
cd Quack-Harness
npm ci
npm run build
```

The root `npm ci` installs the locked frontend dependencies through `postinstall`.
Source installation requires the checked-in frontend manifest and lockfile.
Run it with lifecycle scripts enabled so the subsequent build has its inputs.

Confirm the CLI starts:

```bash
node dist/index.js --help
```

To use a packed artifact, obtain the release tarball or run `npm pack` from a
source checkout. Prepack rebuilds clean output before creating the tarball.
Install it into a separate directory with production dependencies:

```bash
npm install --prefix ./quack-install --omit=dev /absolute/path/to/quack-harness-0.3.0.tgz
node ./quack-install/node_modules/quack-harness/dist/index.js --help
node ./quack-install/node_modules/quack-harness/dist/index.js --version
```

The packed artifact includes the compiled CLI, modern and legacy monitor UI,
public documentation, and worker helper scripts. It requires no frontend
checkout, TypeScript, Vite, or Git metadata to install. Git remains required
for commands that operate on repositories. Native runtime dependencies still
run their installation scripts, so do not use `--ignore-scripts`.

The examples below use the source checkout CLI path. For a packed installation,
substitute the installed `node_modules/quack-harness/dist/index.js` path.
This is a tarball installation route; it does not assume npm registry publication.

## 2. Configure provider access

For a source checkout, copy `.env.example` to `.env` and replace placeholders
only on your machine:

```bash
cp .env.example .env
```

For a packed installation, set the provider environment variables through your
shell or local service configuration; environment files are not bundled.

`ANTHROPIC_API_KEY` is required for agent, planner, enrichment, and judge operations. The monitor and deterministic commands can be explored without placing a key in Git.

## 3. Prepare a target project

Use a disposable or version-controlled project that you are authorized to modify:

```bash
node dist/index.js init <PROJECT_PATH>
```

Review the generated `.quack/adapter.json` before running an agent. Pay particular attention to writable paths, denied paths, allowed commands, verification commands, base branch, model selection, and budget limits.

The example in [`adapters/examples/node-typescript/`](../adapters/examples/node-typescript/) is a safe starting point.

## 4. Add a task

Place a structured Markdown task in the adapter's configured task directory. A task should state its objective, scope, success criteria, expected files, testing requirements, dependencies, and explicit non-goals.

Run readiness checks before execution:

```bash
node dist/index.js prep TASK-001 --project <PROJECT_PATH>
node dist/index.js preflight TASK-001 --project <PROJECT_PATH>
```

## 5. Verify or run

Run project verification without an agent:

```bash
node dist/index.js verify TASK-001 --project <PROJECT_PATH>
```

Run the task only after reviewing the adapter and task contract:

```bash
node dist/index.js run TASK-001 --project <PROJECT_PATH>
```

The dispatcher creates an isolated worktree and records run evidence under ignored runtime paths.

## 6. Start the monitor

```bash
node dist/index.js monitor --project <PROJECT_PATH> --host 127.0.0.1 --port 3333
```

Open `http://localhost:3333`. Keep the monitor bound to a trusted interface unless authentication and network controls are configured.

Windows worker enrollment includes the persistence helper used by `worker
install`. Stop the intended worker runtime and listener explicitly before
installing or repairing persistence. A busy port, an active matching wrapper,
or a legacy listener without an attributable repository/host causes refusal
before helper configuration writes; unrelated, explicitly scoped workers are
preserved. Startup-mode registration still requires the privileges appropriate
to the selected mode. See [Troubleshooting](TROUBLESHOOTING.md).

## Next steps

- [Adapter configuration](ADAPTER_CONFIG_REFERENCE.md)
- [CLI reference](CLI_REFERENCE.md)
- [HTTP API reference](API_REFERENCE.md)
- [Monitor guide](MONITOR_GUIDE.md)
- [Troubleshooting](TROUBLESHOOTING.md)
