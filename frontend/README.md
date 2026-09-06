# Quack Harness dashboard

Vite + React + TypeScript frontend for the Quack monitor.

Production behavior:

- `/` serves UI 2.0
- `/legacy` serves the classic dashboard fallback
- `/api/health` reports `uiMode` and `legacyUiPath`

## Stack

- Vite 7
- React 18
- TypeScript 5
- TanStack Query 5
- TanStack Table 8
- React Router 7
- Zustand 5

## Layout

```text
frontend/
  index.html
  vite.config.ts
  package.json
  src/
    main.tsx
    App.tsx
    index.css
    router/routes.tsx
    components/
    pages/
    api/
    sse/
    store/
```

## Routes

- `/`
- `/tasks`
- `/tasks/:taskId`
- `/sessions`
- `/queue`
- `/fleet`
- `/reviews`
- `/costs`
- `/testing`
- `/settings`

## Develop

```bash
cd frontend
npm install
npm run dev
```

The Vite dev server runs on `:5173` and proxies `/api/*` and `/v1/*` to
`QUACK_MONITOR_URL` (default `http://localhost:3333`).

## Build

Frontend-only build:

```bash
cd frontend
npm run typecheck
npm run build
```

Integrated production build from the repo root:

```bash
npm run build
```

That root build:

- compiles the monitor backend
- builds `frontend/`
- copies the classic dashboard to `dist/monitor/public`
- copies UI 2.0 to `dist/monitor/ui`

## SSE

`src/sse/stream.ts` opens a single `EventSource` at app boot and lets
pages subscribe by topic.

## API contracts

`src/api/contracts.ts` mirrors `src/monitor/api-contracts.ts`. Update
both together until the repo has a shared type surface.

Queue, lease, and federation behavior is described in the repository's
[architecture guide](../ARCHITECTURE.md).
