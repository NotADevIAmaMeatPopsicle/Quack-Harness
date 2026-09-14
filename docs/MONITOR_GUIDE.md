# Monitor guide

The monitor is an Express server that hosts the API, server-sent events, and the compiled React interface.

## Start locally

Build the backend and frontend, then point the monitor at an adapter-enabled project:

```bash
npm run build
node dist/index.js monitor --project <PROJECT_PATH> --host 127.0.0.1 --port 3333
```

Open `http://localhost:3333`.

## Main views

- **Overview:** project health, active sessions, queue state, and recent activity
- **Tasks:** parsed task specifications and readiness state
- **Queue:** queued, assigned, running, and completed jobs
- **Testing:** verification commands and recent results
- **Costs:** recorded provider usage and configured limits
- **Workers:** enrolled hosts, capabilities, leases, and heartbeats
- **Monitoring:** operator-configured application and control-plane health checks
- **Settings:** project registration and safe runtime configuration

Available routes depend on the build and configured features. The UI calls relative API paths so it can be hosted locally or behind a secured reverse proxy.

## Reviews: readiness and blockers

The Reviews table presents the code **Verdict** separately from the **Documentation gate**. A list flag of **Ready** means the gate recorded an affirmative value; **Not confirmed** means it was false or absent; **Unknown** means the evidence could not be determined. The list value is not combined merge readiness and does not distinguish a missing gate from a recorded negative one.

The detail panel shows a combined summary for the selected review. The four possible states are:

- **Ready for operator review** — explicit VERIFIED verdict plus an explicit ready documentation gate, with no structural inconsistency or contradiction in the evidence.
- **Not ready** — the verdict or gate is explicitly negative.
- **Unknown** — the gate readiness value could not be determined.
- **Incomplete evidence** — required fields are missing, malformed, or the recorded values contradict each other (for example, a ready gate alongside blocking issues or open P1 findings).

Only an explicit VERIFIED verdict plus an explicit ready documentation gate and consistent evidence can produce the positive summary. A FAILED or PARTIAL verdict is never ready, even when documentation is ready. A valid false gate stays negative even with no blocking issues.

The list and selected detail each refresh every ten seconds independently. After a selection change, background refresh, or failed detail request, cached readiness is suppressed until current evidence arrives. The panel shows **Loading review details…** while a fetch is in progress and **Unable to refresh review details** when a refresh fails, without showing a cached positive banner.

Each review in the table is selected using a native button that supports Tab, Enter, and Space and displays its pressed state. Switching reviews, loading, failed fetches, and empty lists cannot show a previous review's readiness as current.

Artifact paths and commit identifiers are displayed as inert text, not links. The full persisted payload is available under the collapsed **Raw review JSON** disclosure for diagnostics.

This read-only page cannot approve or merge changes.

## Configuration

The monitor reads registered projects and optional environment monitors from the Quack configuration file. Use synthetic values in shared examples:

```json
{
  "projects": [
    { "path": "<PROJECT_PATH>", "autoPrep": false, "autoPreflight": false }
  ],
  "monitor": { "port": 3333 },
  "deploymentMonitors": [
    {
      "id": "example-staging",
      "label": "Example staging",
      "service": "example-service",
      "environment": "staging",
      "provider": "other",
      "appUrl": "https://app.example.test",
      "healthUrl": "https://app.example.test/health",
      "enabled": true
    }
  ]
}
```

Do not commit local project paths, private network addresses, account identifiers, or credentials.

## Remote access

The monitor controls repositories and agent jobs and binds to `127.0.0.1` by default. Do not expose it directly to the public internet. A non-loopback `--host` requires authentication, TLS, network allowlists, explicit CORS origins, scoped service tokens, and least-privilege repository credentials.

For distributed operation, configure one headnode URL explicitly and enroll worker hosts with the minimum capabilities they require. Replace examples with your own trusted endpoint, such as `https://headnode.example.test`.

## Health and events

Use the health endpoint for basic process checks:

```bash
curl http://localhost:3333/api/health
```

The dashboard receives live updates through server-sent events. Event names and payloads are documented in [SSE_EVENTS_REFERENCE.md](SSE_EVENTS_REFERENCE.md).

## Prep and preflight progress

Both dashboards show durable preflight attempts separately from cached results.
Use **Run fresh preflight** to rerun checks without reusing the cached report;
this may use model credits and preserves existing approvals. The dashboard
reports when a request joins an already running attempt. Replanning a blueprint
is a separate action that requires fresh approval of the replacement.

Readiness labels distinguish current passing prep, rejection, invalid stored
prep, stale history and missing prep. Score tooltips identify the source. A
prep badge does not summarize every scheduler prerequisite. Interrupted or
damaged attempts retain their evidence and recovery action after reload.
Keep `.quack/preflight-jobs/` ignored and preserve its files for recovery;
stopping a monitor does not certify an unknown former process as stopped.

## Screenshots

Public screenshots must use fixture data, consistent viewport sizes, and application-only captures. The release gallery is stored in `docs/assets/screenshots/` after metadata inspection.
