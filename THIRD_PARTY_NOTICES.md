# Third-party notices

Quack Harness depends on packages installed from the npm lockfiles. The following direct runtime dependencies are distributed under the MIT License:

- `better-sqlite3`
- `chokidar`
- `commander`
- `express`
- `zod`
- `@tanstack/react-query`
- `@tanstack/react-table`
- `react`
- `react-dom`
- `react-router-dom`
- `zustand`

`@anthropic-ai/claude-agent-sdk` is not MIT-licensed. The version currently resolved by the root lockfile (`0.2.42`) states: “© Anthropic PBC. All rights reserved. Use is subject to the Legal Agreements” linked from that package's `LICENSE.md`. Review the [Claude Code legal and compliance terms](https://code.claude.com/docs/en/legal-and-compliance) before use or redistribution.

Development dependencies, their transitive dependencies, exact resolved versions, integrity hashes, and source locations are recorded in `package-lock.json` and `frontend/package-lock.json`. Their upstream license texts and attribution requirements continue to apply.

This notice is informational and does not replace the license terms of any dependency.
