# Getting started

This guide builds Quack Harness, creates an adapter in a separate example project, and starts the local monitor.

## 1. Install dependencies

Requirements:

- Node.js 20.19 or newer
- npm
- Git

```bash
git clone https://github.com/NotADevIAmaMeatPopsicle/Quack-Harness.git
cd Quack-Harness
npm ci
npm run build
```

The root `npm ci` installs the locked frontend dependencies through the
repository's `postinstall` script.

Confirm the CLI starts:

```bash
node dist/index.js --help
```

## 2. Configure provider access

Copy `.env.example` to `.env` and replace placeholders only on your machine:

```bash
cp .env.example .env
```

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

## Next steps

- [Adapter configuration](ADAPTER_CONFIG_REFERENCE.md)
- [CLI reference](CLI_REFERENCE.md)
- [HTTP API reference](API_REFERENCE.md)
- [Monitor guide](MONITOR_GUIDE.md)
- [Troubleshooting](TROUBLESHOOTING.md)
