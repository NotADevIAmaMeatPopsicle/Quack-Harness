import * as http from "node:http";

import express from "express";

import type { ManagedWorktreeRecord } from "../../src/monitor/dispatch-manager";
import { registerWorktreeRoutes } from "../../src/monitor/routes/worktrees";

async function listen(app: express.Express): Promise<{ server: http.Server; baseUrl: string }> {
  const server = http.createServer(app);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", () => resolve());
  });
  const address = server.address();
  if (!address || typeof address === "string") {
    throw new Error("Failed to bind test server");
  }
  return {
    server,
    baseUrl: `http://127.0.0.1:${address.port}`,
  };
}

async function close(server: http.Server): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.close((err) => (err ? reject(err) : resolve()));
  });
}

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  const response = await fetch(url);
  return {
    status: response.status,
    body: await response.text(),
  };
}

async function httpPost(
  url: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  return {
    status: response.status,
    body: await response.text(),
  };
}

describe("worktree API routes", () => {
  it("lists managed worktrees and summarizes prune eligibility", async () => {
    const records: ManagedWorktreeRecord[] = [
      {
        taskId: "TASK-001",
        path: "/tmp/worktrees/TASK-001",
        rootKind: "quack",
        exists: true,
        registered: true,
        branchName: "quack/TASK-001",
        owner: "quack",
        ownerProvenance: ["root:.quack/worktrees"],
        allowedPrefix: "quack/TASK-",
        protectedOwner: false,
        requiresOwnerOverride: false,
        lastModifiedAt: "2026-05-04T12:00:00.000Z",
        ageMs: 200_000_000,
        jobStatus: "completed",
        activeJob: false,
        dirty: false,
        evidenceFiles: [],
        pruneEligible: true,
        skipReasons: [],
      },
      {
        taskId: "TASK-002",
        path: "/tmp/worktrees/TASK-002",
        rootKind: "quack",
        exists: true,
        registered: false,
        owner: "quack",
        ownerProvenance: ["root:.quack/worktrees"],
        allowedPrefix: "quack/TASK-",
        protectedOwner: false,
        requiresOwnerOverride: false,
        ageMs: 2_000,
        activeJob: true,
        dirty: true,
        evidenceFiles: ["PROGRESS.md"],
        pruneEligible: false,
        skipReasons: ["active_job", "dirty_git_state", "evidence_files_present"],
      },
    ];
    const listManagedWorktrees = jest.fn(() => records);
    const pruneManagedWorktrees = jest.fn();

    const app = express();
    app.use(express.json());
    registerWorktreeRoutes(app, {
      resolveProject: () => ({
        projectId: "example-service",
        projectName: "Example Assistant MVP",
        dispatchManager: {
          listManagedWorktrees,
          pruneManagedWorktrees,
        },
      }),
    });

    const { server, baseUrl } = await listen(app);
    try {
      const response = await httpGet(`${baseUrl}/api/worktrees?maxAgeHours=48`);
      expect(response.status).toBe(200);

      const body = JSON.parse(response.body) as {
        projectId: string;
        summary: {
          scanned: number;
          pruneEligible: number;
          active: number;
          dirty: number;
          evidenceBearing: number;
          registered: number;
          orphaned: number;
        };
        records: Array<{ taskId: string }>;
        maxAgeMs: number;
      };
      expect(listManagedWorktrees).toHaveBeenCalledWith(48 * 60 * 60 * 1000);
      expect(body.projectId).toBe("example-service");
      expect(body.maxAgeMs).toBe(48 * 60 * 60 * 1000);
      expect(body.summary).toMatchObject({
        scanned: 2,
        pruneEligible: 1,
        active: 1,
        dirty: 1,
        evidenceBearing: 1,
        registered: 1,
        orphaned: 1,
      });
      expect(body.records.map((record) => record.taskId)).toEqual(["TASK-001", "TASK-002"]);
    } finally {
      await close(server);
    }
  });

  it("validates prune payloads and forwards dry-run settings", async () => {
    const pruneManagedWorktrees = jest.fn(() => ({
      checkedAt: "2026-05-04T13:00:00.000Z",
      dryRun: false,
      maxAgeMs: 72 * 60 * 60 * 1000,
      scanned: 1,
      pruneEligible: 1,
      candidates: [
        {
          taskId: "TASK-003",
          path: "/tmp/worktrees/TASK-003",
          rootKind: "quack" as const,
          exists: true,
          registered: false,
          owner: "quack",
          ownerProvenance: ["root:.quack/worktrees"],
          allowedPrefix: "quack/TASK-",
          protectedOwner: false,
          requiresOwnerOverride: false,
          ageMs: 300_000_000,
          activeJob: false,
          dirty: false,
          evidenceFiles: [],
          pruneEligible: true,
          skipReasons: [],
        },
      ],
      pruned: ["/tmp/worktrees/TASK-003"],
      retained: [],
      policy: {
        enabled: true,
        retentionDays: 1,
        allowedPrefixes: ["quack/TASK-"],
        protectedOwners: ["contributor"],
        protectedPatterns: ["contributor/**", "*/contributor/**"],
        requireOwnerOverride: true,
      },
    }));

    const app = express();
    app.use(express.json());
    registerWorktreeRoutes(app, {
      resolveProject: () => ({
        projectId: "example-service",
        projectName: "Example Assistant MVP",
        dispatchManager: {
          listManagedWorktrees: jest.fn(),
          pruneManagedWorktrees,
        },
      }),
    });

    const { server, baseUrl } = await listen(app);
    try {
      const invalid = await httpPost(`${baseUrl}/api/worktrees/prune`, {
        dryRun: "nope",
      } as unknown as Record<string, unknown>);
      expect(invalid.status).toBe(400);
      expect(JSON.parse(invalid.body)).toMatchObject({
        error: "invalid_worktree_prune_payload",
      });

      const response = await httpPost(`${baseUrl}/api/worktrees/prune`, {
        dryRun: false,
        maxAgeHours: 72,
        ownerOverride: {
          owner: "contributor",
          reason: "operator-confirmed stale rescue worktree",
        },
      });
      expect(response.status).toBe(200);
      expect(pruneManagedWorktrees).toHaveBeenCalledWith({
        dryRun: false,
        maxAgeMs: 72 * 60 * 60 * 1000,
        ownerOverride: {
          owner: "contributor",
          reason: "operator-confirmed stale rescue worktree",
        },
      });
      expect(JSON.parse(response.body)).toMatchObject({
        ok: true,
        result: {
          dryRun: false,
          pruned: ["/tmp/worktrees/TASK-003"],
        },
        summary: {
          scanned: 0,
          pruneEligible: 0,
        },
      });
    } finally {
      await close(server);
    }
  });

  it("returns 404 when a project has no dispatch manager", async () => {
    const app = express();
    app.use(express.json());
    registerWorktreeRoutes(app, {
      resolveProject: () => ({
        projectId: "example-service",
        projectName: "Example Assistant MVP",
        dispatchManager: null,
      }),
    });

    const { server, baseUrl } = await listen(app);
    try {
      const listed = await httpGet(`${baseUrl}/api/worktrees`);
      expect(listed.status).toBe(404);
      expect(JSON.parse(listed.body)).toMatchObject({
        error: "Dispatch manager not configured",
      });

      const pruned = await httpPost(`${baseUrl}/api/worktrees/prune`, {});
      expect(pruned.status).toBe(404);
      expect(JSON.parse(pruned.body)).toMatchObject({
        error: "Dispatch manager not configured",
      });
    } finally {
      await close(server);
    }
  });
});
