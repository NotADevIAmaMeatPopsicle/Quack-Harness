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

## Screenshots

Public screenshots must use fixture data, consistent viewport sizes, and application-only captures. The release gallery is stored in `docs/assets/screenshots/` after metadata inspection.
