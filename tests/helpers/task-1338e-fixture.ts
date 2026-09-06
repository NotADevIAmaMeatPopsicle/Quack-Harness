import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { taskSpec, writeTestAdapter, type FixtureCreationOrder } from "./divergent-task-fixture";

export type ClaimantPopulation = "candidate" | "cross-population";

export interface ContestedTaskFixture {
  root: string;
  taskDir: string;
  relativeTaskDir: string;
  taskId: string;
  claimants: string[];
  claimantPaths: string[];
  cleanup(): void;
}

export function createContestedTaskFixture(
  order: FixtureCreationOrder,
  population: ClaimantPopulation,
  options: {
    taskId?: string;
    relativeTaskDir?: string;
    status?: string;
    prefix?: string;
    withAdapter?: boolean;
    reportBack?: boolean;
  } = {},
): ContestedTaskFixture {
  const taskId = options.taskId ?? "TASK-500";
  const relativeTaskDir = options.relativeTaskDir ?? "docs/tasks";
  const root = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? "quack-task-1338e-"));
  const taskDir = path.join(root, relativeTaskDir);
  fs.mkdirSync(taskDir, { recursive: true });

  const firstName = `${taskId}-alpha.md`;
  const secondName = population === "candidate" ? `${taskId}-zeta.md` : "SAURUS-REM-500-shadow.md";
  const files: Array<[string, string]> = [
    [
      firstName,
      taskSpec(taskId, {
        title: `${taskId} alpha claimant`,
        status: options.status ?? "BACKLOG",
        tags: ["alpha-claimant"],
      }),
    ],
    [
      secondName,
      taskSpec(taskId, {
        title: `${taskId} second claimant`,
        status: options.status ?? "BACKLOG",
        tags: ["second-claimant"],
      }),
    ],
  ];

  for (const [fileName, content] of order === "child-first" ? files : [...files].reverse()) {
    fs.writeFileSync(path.join(taskDir, fileName), content, "utf-8");
  }

  if (options.withAdapter) {
    const adapterPath = writeTestAdapter(root, {
      reportBack: options.reportBack ?? false,
      pollEnabled: false,
    });
    const adapter = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as {
      project: { taskDir: string };
    };
    adapter.project.taskDir = relativeTaskDir.replace(/\\/g, "/");
    fs.writeFileSync(adapterPath, JSON.stringify(adapter, null, 2), "utf-8");
  }

  const claimants = [firstName, secondName].sort((a, b) => a.localeCompare(b));
  return {
    root,
    taskDir,
    relativeTaskDir,
    taskId,
    claimants,
    claimantPaths: claimants.map((fileName) => path.join(taskDir, fileName)),
    cleanup: () =>
      fs.rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 20,
        retryDelay: 100,
      }),
  };
}

export function writeSessionLog(projectRoot: string, taskIds: readonly string[]): void {
  const logsDir = path.join(projectRoot, ".quack", "logs");
  fs.mkdirSync(logsDir, { recursive: true });
  const rows = taskIds.map((taskId) => ({
    taskId,
    sessionId: `${taskId}-session`,
    startTime: "2026-08-18T12:00:00.000Z",
    endTime: "2026-08-18T12:01:00.000Z",
    outcome: "approved",
    costUsd: 1,
    turnsUsed: 1,
    retriesUsed: 0,
    taskTags: ["fixture"],
    targetFiles: [`src/${taskId.toLowerCase()}.ts`],
    criteriaResults: [],
    feedbackThemes: [],
    gateScore: 5,
    complexity: { filesToModify: 1, successCriteria: 1 },
  }));
  fs.writeFileSync(
    path.join(logsDir, "sessions.jsonl"),
    `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`,
    "utf-8",
  );
}

export function writeSyncMap(
  projectRoot: string,
  entries: Array<{
    taskId: string;
    issueNumber: number;
    taskStatus: string;
  }>,
  timestamp = "2026-08-18T00:00:00.000Z",
): string {
  const syncPath = path.join(projectRoot, ".quack", "sync", "github-sync.json");
  fs.mkdirSync(path.dirname(syncPath), { recursive: true });
  fs.writeFileSync(
    syncPath,
    JSON.stringify(
      {
        entries: entries.map((entry) => ({
          ...entry,
          direction: "published",
          createdAt: timestamp,
          lastSyncedAt: timestamp,
          issueState: "open",
        })),
      },
      null,
      2,
    ),
    "utf-8",
  );
  return syncPath;
}
