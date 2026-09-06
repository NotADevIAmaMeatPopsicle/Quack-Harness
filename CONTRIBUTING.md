# Contributing

Thank you for helping improve Quack Harness.

## Development setup

```bash
git clone https://github.com/NotADevIAmaMeatPopsicle/Quack-Harness.git
cd Quack-Harness
npm ci
npm --prefix frontend ci
npm run build
npm test
```

Use Node.js 20.19 or newer. Copy `.env.example` to `.env` only when you need provider-backed commands; never commit that file or real credentials.

## Before opening a pull request

Run the checks relevant to your change:

```bash
npm run build
npm test
npm run lint
npm run format:check
npm --prefix frontend run typecheck
```

Keep changes focused, add tests for behavior changes, and update public documentation when a command, configuration field, endpoint, or user workflow changes.

By submitting a contribution, you confirm that you have the right to provide it and agree that it is licensed under the repository's [GNU Affero General Public License v3.0](LICENSE) (`AGPL-3.0-only`).

## Code style

- TypeScript is compiled in strict mode.
- Prefer explicit types at subsystem boundaries.
- Use `async`/`await` for asynchronous work.
- Catch errors at process, API, or integration boundaries and return useful context.
- Keep project-specific assumptions in adapters rather than Quack Harness core.
- Server-side timers should not keep test processes alive unnecessarily.

## Pull requests

A useful pull request explains:

- the problem being solved
- the design and important tradeoffs
- the tests or manual checks performed
- any compatibility or migration impact
- screenshots for visible UI changes

Do not include task transcripts, local worktree state, generated evidence dumps, personal paths, private URLs, or credentials.

## Security reports

Do not open a public issue for a suspected vulnerability. Follow [SECURITY.md](SECURITY.md).
