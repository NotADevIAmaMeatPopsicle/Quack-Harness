// ─── Decompose API Endpoint Tests ──────────────────────────────────
// Tests for POST /api/tasks/:id/decompose staged contract.
// Covers plan / materialize / finalize modes, refusal codes, and
// side-effect guarantees.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { execFileSync } from "node:child_process";

import { createMonitorServer } from "../../src/monitor/server";
import { loadAdapter } from "../../src/core/adapter-loader";
import { parseTaskFile } from "../../src/core/task-parser";
import { QuackDB } from "../../src/db/quack-db";
import type { ChildDraft, DecompositionTopology } from "../../src/preflight/decompose-types";
import { finalizeDecompositionTransaction } from "../../src/preflight/decomposition-finalizer";
import {
  createDecompositionTransactionJournal,
  listPendingDecompositionStatusProjections,
  updateDecompositionTransactionJournal,
} from "../../src/preflight/decomposition-transaction-journal";
import { planSubtaskSpecWrites } from "../../src/preflight/subtask-writer";
import { computeDecompositionParentHash } from "../../src/preflight/task-decomposer";
import * as blueprintAgent from "../../src/blueprint/blueprint-agent";
import * as taskDecomposer from "../../src/preflight/task-decomposer";

// Prevent tests from picking up real .quack/auth.json
jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

// ─── Helpers ─────────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-test-decompose-"));
}

function makeTaskFile(id: string, status: string, fileCount = 3): string {
  const files = Array.from(
    { length: fileCount },
    (_, i) => `| \`src/module-${i}.ts\` | Create | Module ${i} |`,
  ).join("\n");

  const criteria = Array.from(
    { length: fileCount },
    (_, i) => `- [ ] Criterion ${i + 1} is satisfied`,
  ).join("\n");

  return [
    `# ${id}: Test Decomposition Task`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 12-16 hours",
    `- **Status:** ${status}`,
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** test",
    "",
    "## Problem Statement",
    "This is a test task that needs decomposition. It has multiple files and criteria.",
    "",
    "## Current State",
    "Nothing exists yet.",
    "",
    "## Recommended Approach",
    "Implement the modules in order.",
    "",
    "## Files to Modify",
    "",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    files,
    "",
    "## Success Criteria",
    criteria,
    "",
    "## Testing Requirements",
    "- [ ] Unit tests for each module",
    "- [ ] Integration tests",
    "",
    "## Anti-Patterns",
    "- Do not skip tests",
    "",
    "## Context References",
    "- src/core/types.ts",
  ].join("\n");
}

function makeChildDraft(subtaskId: string, title: string, ready: boolean) {
  const isFinal = subtaskId.endsWith("-B");
  const moduleIndex = isFinal ? 1 : 0;
  const criterionIndex = isFinal ? 2 : 1;
  const blockedBy = isFinal ? `[${subtaskId.replace(/-B$/, "-A")}]` : "[]";
  const prepScore = ready ? 4.5 : 2.0;
  const markdown = [
    `# ${subtaskId}: ${title}`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 4-6 hours",
    "- **Status:** READY",
    `- **Blocked By:** ${blockedBy}`,
    "- **Tags:** test",
    "",
    "## Problem Statement",
    "This child task implements a specific module with detailed requirements, integration guidance, explicit ownership boundaries, and independently verifiable behavior.",
    "",
    "## Current State",
    "The module does not exist yet and needs to be created from scratch.",
    "",
    "## Recommended Approach",
    "Create the module following the existing patterns in the codebase.",
    "",
    "## Files to Modify",
    "",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    `| \`src/module-${moduleIndex}.ts\` | Create | Main module |`,
    "",
    "## Success Criteria",
    `- [ ] Criterion ${criterionIndex} is satisfied`,
    "",
    "## Testing Requirements",
    "- [ ] Unit test for the main function",
    "- [ ] Edge case: empty input returns empty result",
    "",
    "## Anti-Patterns",
    "- Do not skip tests",
    "",
    "## Context References",
    "- src/core/types.ts",
  ].join("\n");

  const submittedMarkdown = ready
    ? markdown
    : markdown
        .replace(
          "This child task implements a specific module with detailed requirements and integration guidance.",
          `This subtask is part of ${subtaskId.replace(/-[A-Z]$/, "")} decomposition.`,
        )
        .replace(
          "The module does not exist yet and needs to be created from scratch.",
          `Parent task ${subtaskId.replace(/-[A-Z]$/, "")} was decomposed into multiple subtasks.`,
        )
        .replace(
          "Create the module following the existing patterns in the codebase.",
          "Follow the implementation patterns from the parent task's blueprint.",
        );

  return {
    subtaskId,
    title,
    markdown: submittedMarkdown,
    sectionsPresent: [
      "Problem Statement",
      "Current State",
      "Recommended Approach",
      "Files to Modify",
      "Success Criteria",
      "Testing Requirements",
      "Anti-Patterns",
      "Context References",
    ],
    prepScore,
    prepReady: ready,
    deficiencies: ready ? [] : ["Prep score below threshold"],
  };
}

function makeTopology(parentContent: string, draft: ChildDraft): DecompositionTopology {
  const finalDraft = makeChildDraft("TASK-900-B", "Child B", true);
  return {
    parentTaskId: "TASK-900",
    parentContentHash: computeDecompositionParentHash(parentContent),
    subtasks: [
      {
        id: draft.subtaskId,
        title: draft.title,
        filesToModify: [{ path: "src/module-0.ts", action: "Create", notes: "Module 0" }],
        successCriteria: ["Criterion 1 is satisfied"],
        dependsOn: [],
        isFinal: false,
      },
      {
        id: finalDraft.subtaskId,
        title: finalDraft.title,
        filesToModify: [{ path: "src/module-1.ts", action: "Create", notes: "Module 1" }],
        successCriteria: ["Criterion 2 is satisfied"],
        dependsOn: ["TASK-900-A"],
        isFinal: true,
      },
    ],
    coverageReport: {
      fileOwnership: [
        { filePath: "src/module-0.ts", ownedBy: draft.subtaskId, isShared: false },
        { filePath: "src/module-1.ts", ownedBy: finalDraft.subtaskId, isShared: false },
      ],
      criterionOwnership: [
        { criterion: "Criterion 1 is satisfied", ownedBy: [draft.subtaskId] },
        { criterion: "Criterion 2 is satisfied", ownedBy: [finalDraft.subtaskId] },
      ],
      unmappedFiles: [],
      unmappedCriteria: [],
      duplicatedFiles: [],
      duplicatedCriteria: [],
      hasCoverageGap: false,
    },
  };
}

function makePrepResult(taskId: string, score: number, ready: boolean) {
  return {
    taskId,
    preparedAt: new Date().toISOString(),
    schemaValid: true,
    schemaErrors: [],
    depthScore: score,
    depthReady: ready,
    deficiencies: ready ? [] : ["Score below threshold"],
    outcome: ready ? "pass" : "rejected",
    stale: false,
  };
}

async function httpPost(
  url: string,
  data?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = data ? JSON.stringify(data) : "";

    const options = {
      hostname: urlObj.hostname,
      port: urlObj.port,
      path: urlObj.pathname,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(postData),
      },
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk: Buffer) => (body += chunk.toString("utf-8")));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
      res.on("error", reject);
    });

    req.on("error", reject);
    if (postData) req.write(postData);
    req.end();
  });
}

function git(root: string, args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
}

// ─── Tests ───────────────────────────────────────────────────────

describe("Decompose API Endpoint", () => {
  let logDir: string;
  let projectRoot: string;
  let stopServer: (() => Promise<void>) | undefined;
  let baseUrl: string;

  beforeEach(() => {
    logDir = makeTempDir();
    projectRoot = makeTempDir();
    // Create minimal project structure
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    const quackDir = path.join(projectRoot, ".quack");
    fs.mkdirSync(quackDir, { recursive: true });
    fs.writeFileSync(
      path.join(quackDir, "adapter.json"),
      JSON.stringify({
        version: "1.0",
        project: {
          name: "test",
          language: "typescript",
          taskDir: "docs/tasks",
          root: projectRoot,
          conventionsDir: "docs/conventions",
        },
        agent: {},
        verification: {
          commands: [{ name: "build", command: "echo ok", required: true, timeout: 60000 }],
        },
        git: {
          baseBranch: "main",
          branchPrefix: "quack/",
          commitFormat: "[{taskId}] {message}",
          commitTrailer: "Automated-By: Quack",
          autoPush: false,
        },
        logging: {
          level: "info",
          dir: ".quack/logs",
          sessionDir: ".quack/logs",
        },
      }),
      "utf-8",
    );

    // Write a test task file
    fs.writeFileSync(
      path.join(taskDir, "TASK-900-test-decompose.md"),
      makeTaskFile("TASK-900", "READY", 2),
      "utf-8",
    );
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: projectRoot });
    execFileSync("git", ["config", "user.email", "quack-test@example.com"], {
      cwd: projectRoot,
    });
    execFileSync("git", ["config", "user.name", "Quack Test"], { cwd: projectRoot });
    execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: projectRoot });
    execFileSync("git", ["add", ".quack/adapter.json", "docs/tasks"], { cwd: projectRoot });
    execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: projectRoot });
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    jest.restoreAllMocks();
  });

  async function startServer(): Promise<number> {
    const serverObj = createMonitorServer({
      logDir,
      port: 0,
      host: "127.0.0.1",
      projectRoot,
      adapterPath: path.join(projectRoot, ".quack", "adapter.json"),
      taskDir: "docs/tasks",
    });
    const started = await serverObj.start();
    stopServer = started.stop;
    baseUrl = `http://127.0.0.1:${started.port}`;
    return started.port;
  }

  async function leaveInterruptedDecomposition(): Promise<{
    parentPath: string;
    parentOriginal: string;
    childPaths: string[];
  }> {
    const adapter = await loadAdapter(projectRoot);
    const parentPath = path.join(projectRoot, "docs", "tasks", "TASK-900-test-decompose.md");
    const parentOriginal = fs.readFileSync(parentPath, "utf-8");
    const parentTarget = parentOriginal.replace("- **Status:** READY", "- **Status:** DECOMPOSED");
    const drafts = [
      makeChildDraft("TASK-900-A", "Recover first child", true),
      makeChildDraft("TASK-900-B", "Recover final child", true),
    ];
    const planned = planSubtaskSpecWrites(drafts, adapter);
    const prepared = await createDecompositionTransactionJournal({
      adapter,
      parentTaskId: "TASK-900",
      parentFilePath: parentPath,
      parentOriginalContent: parentOriginal,
      parentTargetContent: parentTarget,
      plannedWrites: planned,
    });
    fs.writeFileSync(parentPath, parentTarget, "utf-8");
    for (const item of planned) fs.writeFileSync(item.filePath, item.draft.markdown, "utf-8");
    await updateDecompositionTransactionJournal(
      prepared.journalPath,
      prepared.journal,
      "children_written",
    );
    return { parentPath, parentOriginal, childPaths: planned.map((item) => item.filePath) };
  }

  it("recovers an interrupted decomposition before the monitor opens admission", async () => {
    const interrupted = await leaveInterruptedDecomposition();

    await startServer();

    expect(fs.readFileSync(interrupted.parentPath, "utf-8")).toBe(interrupted.parentOriginal);
    for (const childPath of interrupted.childPaths) expect(fs.existsSync(childPath)).toBe(false);
  });

  it("runs the recovery fence again before a direct dispatch admission", async () => {
    await startServer();
    const interrupted = await leaveInterruptedDecomposition();

    const response = await httpPost(`${baseUrl}/api/tasks/TASK-999/start`, {
      localSmokeOnly: true,
      skipGate: true,
    });

    expect(response.status).toBe(404);
    expect(fs.readFileSync(interrupted.parentPath, "utf-8")).toBe(interrupted.parentOriginal);
    for (const childPath of interrupted.childPaths) expect(fs.existsSync(childPath)).toBe(false);
  });

  it("drains the exact committed decomposition projection once before startup admission", async () => {
    const adapter = await loadAdapter(projectRoot);
    const parentPath = path.join(projectRoot, "docs", "tasks", "TASK-900-test-decompose.md");
    const parentContent = fs.readFileSync(parentPath, "utf-8");
    const parentTask = parseTaskFile(parentContent, parentPath);
    const firstDraft = makeChildDraft("TASK-900-A", "Child A", true);
    const finalized = await finalizeDecompositionTransaction({
      adapter,
      parentTask,
      parentFilePath: parentPath,
      parentContent,
      topology: makeTopology(parentContent, firstDraft),
      drafts: [firstDraft, makeChildDraft("TASK-900-B", "Child B", true)],
    });
    expect(finalized.commit).toMatchObject({ committed: true, recoveryPending: true });
    expect(await listPendingDecompositionStatusProjections(adapter)).toHaveLength(1);

    const dbPath = path.join(projectRoot, ".quack", "quack.db");
    const seedDb = new QuackDB(dbPath);
    seedDb.setStatus("TASK-900", "READY", "fixture");
    seedDb.close();
    const projectionWrites = jest.spyOn(QuackDB.prototype, "setStatus");

    await startServer();
    const inspectDb = new QuackDB(dbPath);
    const firstProjection = inspectDb.getStatus("TASK-900");
    inspectDb.close();
    expect(firstProjection).toMatchObject({
      status: "DECOMPOSED",
      updated_by: `decomposition:${finalized.commit.statusProjectionId}`,
    });
    expect(
      projectionWrites.mock.calls.filter(
        ([taskId, status, source]) =>
          taskId === "TASK-900" &&
          status === "DECOMPOSED" &&
          source === firstProjection?.updated_by,
      ),
    ).toHaveLength(1);
    expect(await listPendingDecompositionStatusProjections(adapter)).toEqual([]);

    await stopServer?.();
    stopServer = undefined;
    await startServer();
    expect(
      projectionWrites.mock.calls.filter(
        ([taskId, status, source]) =>
          taskId === "TASK-900" &&
          status === "DECOMPOSED" &&
          source === firstProjection?.updated_by,
      ),
    ).toHaveLength(1);
  });

  it("does not treat an unjournaled DECOMPOSED spec edit as authoritative DB evidence", async () => {
    const parentPath = path.join(projectRoot, "docs", "tasks", "TASK-900-test-decompose.md");
    fs.writeFileSync(parentPath, makeTaskFile("TASK-900", "DECOMPOSED", 2), "utf-8");
    const dbPath = path.join(projectRoot, ".quack", "quack.db");
    const seedDb = new QuackDB(dbPath);
    seedDb.setStatus("TASK-900", "READY", "runtime-authority");
    seedDb.close();

    await startServer();

    const inspectDb = new QuackDB(dbPath);
    expect(inspectDb.getStatus("TASK-900")).toMatchObject({
      status: "READY",
      updated_by: "runtime-authority",
    });
    inspectDb.close();
  });

  // ── approve:true rejection ─────────────────────────────────────────

  it("rejects approve:true with DECOMPOSE_REVIEW_REQUIRED", async () => {
    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      approve: true,
    });
    expect(status).toBe(400);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.refusalCode).toBe("DECOMPOSE_REVIEW_REQUIRED");
    expect(data.refusalMessage).toContain("staged decomposition workflow");
  });

  // ── invalid mode rejection ──────────────────────────────────────────

  it("rejects invalid mode with structured error", async () => {
    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "invalid",
    });
    expect(status).toBe(400);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.refusalMessage).toContain("Invalid mode");
  });

  // ── task not found ──────────────────────────────────────────────────

  it("returns 404 for non-existent task", async () => {
    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-999/decompose`, {
      mode: "plan",
    });
    // Task file doesn't exist (not in the task list either)
    expect(status).toBe(404);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.error).toBeDefined();
  });

  it("plan reports a hash-stale parent prep result as not ready and asks for prep again", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify({
        ...makePrepResult("TASK-900", 4.8, true),
        preparedAt: new Date(Date.now() + 60_000).toISOString(),
        contentHash: "not-the-current-parent-content-hash",
      }),
      "utf-8",
    );

    const parentContent = makeTaskFile("TASK-900", "READY", 2);
    const child = makeChildDraft("TASK-900-A", "Child A", true);
    const blueprintSpy = jest
      .spyOn(blueprintAgent, "generateBlueprint")
      .mockResolvedValue({ fileAnalyses: [] } as never);
    const decompositionSpy = jest
      .spyOn(taskDecomposer, "decomposeTask")
      .mockResolvedValue(makeTopology(parentContent, child));

    try {
      await startServer();
      const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
        mode: "plan",
      });

      expect(status).toBe(200);
      const data = JSON.parse(body) as {
        ok: boolean;
        parentReadiness: { score: number; ready: boolean; deficiencies: string[] };
      };
      expect(data.ok).toBe(true);
      expect(data.parentReadiness).toMatchObject({ score: 4.8, ready: false });
      expect(data.parentReadiness.deficiencies).toEqual(
        expect.arrayContaining([expect.stringMatching(/run prep again/i)]),
      );
    } finally {
      decompositionSpy.mockRestore();
      blueprintSpy.mockRestore();
    }
  });

  // ── finalize: DECOMPOSE_REVIEW_REQUIRED ─────────────────────────────

  it("finalize refuses without reviewAcknowledged", async () => {
    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
    });
    expect(status).toBe(400);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.refusalCode).toBe("DECOMPOSE_REVIEW_REQUIRED");
    expect(data.mode).toBe("finalize");
  });

  // ── finalize: DECOMPOSE_PARENT_NOT_READY (no prep result) ──────────

  it("finalize refuses when parent has no prep result", async () => {
    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [makeChildDraft("TASK-900-A", "Child A", true)],
    });
    expect(status).toBe(400);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.refusalCode).toBe("DECOMPOSE_PARENT_NOT_READY");
    expect(data.parentReadiness).toBeDefined();
    expect((data.parentReadiness as { ready: boolean }).ready).toBe(false);
  });

  // ── finalize: DECOMPOSE_PARENT_NOT_READY (low score) ───────────────

  it("finalize refuses when parent prep score is below threshold", async () => {
    // Write a low-score prep result
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 2.5, false)),
      "utf-8",
    );

    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [makeChildDraft("TASK-900-A", "Child A", true)],
    });
    expect(status).toBe(400);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.refusalCode).toBe("DECOMPOSE_PARENT_NOT_READY");
    const parentReadiness = data.parentReadiness as { score: number; ready: boolean };
    expect(parentReadiness.score).toBe(2.5);
    expect(parentReadiness.ready).toBe(false);
  });

  it("finalize refuses a hash-stale passing parent prep result", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify({
        ...makePrepResult("TASK-900", 4.8, true),
        preparedAt: new Date(Date.now() + 60_000).toISOString(),
        contentHash: "not-the-current-parent-content-hash",
      }),
      "utf-8",
    );

    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [makeChildDraft("TASK-900-A", "Child A", true)],
    });

    expect(status).toBe(400);
    const response = JSON.parse(body) as {
      ok: boolean;
      mode: string;
      refusalCode: string;
      parentReadiness: { score: number; ready: boolean; deficiencies: string[] };
    };
    expect(response).toMatchObject({
      ok: false,
      mode: "finalize",
      refusalCode: "DECOMPOSE_PARENT_NOT_READY",
      parentReadiness: {
        score: 4.8,
        ready: false,
      },
    });
    expect(response.parentReadiness.deficiencies).toEqual(
      expect.arrayContaining([expect.stringMatching(/stale/i)]),
    );
  });

  // ── finalize: DECOMPOSE_DRAFT_INVALID (no drafts) ──────────────────

  it("finalize refuses when no drafts are provided", async () => {
    // Write a passing prep result so parent gate passes
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );

    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
    });
    expect(status).toBe(400);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.refusalCode).toBe("DECOMPOSE_DRAFT_INVALID");
    expect(data.refusalMessage).toContain("No child drafts");
  });

  it("finalize returns a structured draft refusal for drafts containing null", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );

    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [null],
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      mode: "finalize",
      refusalCode: "DECOMPOSE_DRAFT_INVALID",
      malformedDraftIndexes: [0],
    });
  });

  it("finalize returns a structured plan refusal for a null subtask row", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );
    const child = makeChildDraft("TASK-900-A", "Child A", true);
    const malformedPlan = {
      ...makeTopology(makeTaskFile("TASK-900", "READY", 2), child),
      subtasks: [null],
    };

    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [child],
      plan: malformedPlan,
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      mode: "finalize",
      refusalCode: "DECOMPOSE_PLAN_INVALID",
    });
  });

  it("finalize returns a structured plan refusal for a malformed nested file row", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );
    const child = makeChildDraft("TASK-900-A", "Child A", true);
    const malformedPlan = makeTopology(makeTaskFile("TASK-900", "READY", 2), child);
    (malformedPlan.subtasks[0] as unknown as { filesToModify: unknown[] }).filesToModify = [null];

    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [child],
      plan: malformedPlan,
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      mode: "finalize",
      refusalCode: "DECOMPOSE_PLAN_INVALID",
    });
  });

  it("finalize rejects a single-child plan without writing or committing", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );
    const parentContent = makeTaskFile("TASK-900", "READY", 2);
    const child = makeChildDraft("TASK-900-A", "Child A", true);
    const singlePlan = makeTopology(parentContent, child);
    singlePlan.subtasks = [{ ...singlePlan.subtasks[0], isFinal: true }];
    const initialHead = git(projectRoot, ["rev-parse", "HEAD"]);

    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [child],
      plan: singlePlan,
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      mode: "finalize",
      refusalCode: "DECOMPOSE_PLAN_INVALID",
    });
    expect(git(projectRoot, ["rev-parse", "HEAD"])).toBe(initialHead);
    expect(
      fs.readFileSync(
        path.join(projectRoot, "docs", "tasks", "TASK-900-test-decompose.md"),
        "utf-8",
      ),
    ).toContain("**Status:** READY");
    expect(
      fs
        .readdirSync(path.join(projectRoot, "docs", "tasks"))
        .filter((name) => name.startsWith("TASK-900-A-")),
    ).toEqual([]);
  });

  // ── finalize: DECOMPOSE_DRAFT_BELOW_THRESHOLD ──────────────────────

  it("finalize refuses when child draft prep score is below threshold", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );

    await startServer();
    const failedDraft = makeChildDraft("TASK-900-A", "Weak Child", false);
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [failedDraft],
    });
    expect(status).toBe(400);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.refusalCode).toBe("DECOMPOSE_DRAFT_BELOW_THRESHOLD");
    const failed = data.failedDrafts as Array<{ subtaskId: string }>;
    expect(failed).toBeDefined();
    expect(failed).toHaveLength(1);
    expect(failed[0].subtaskId).toBe("TASK-900-A");
  });

  // ── finalize: DECOMPOSE_DRAFT_INVALID (parse error) ────────────────

  it("finalize refuses when child draft has parse error", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );

    await startServer();
    const badDraft = {
      ...makeChildDraft("TASK-900-A", "Bad Child", true),
      markdown: "# this is not a parseable Quack child task",
      parseError: undefined,
      prepScore: 5,
      prepReady: true,
    };
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [badDraft],
    });
    expect(status).toBe(400);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.refusalCode).toBe("DECOMPOSE_DRAFT_INVALID");
  });

  it("finalize ignores forged passing quality metadata and rechecks Markdown", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );

    await startServer();
    const forgedDraft = {
      ...makeChildDraft("TASK-900-A", "Forged Child", true),
      markdown: "",
      prepScore: 5,
      prepReady: true,
      deficiencies: [],
      parseError: undefined,
    };
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [forgedDraft, makeChildDraft("TASK-900-B", "Child B", true)],
    });

    expect(status).toBe(400);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.refusalCode).toBe("DECOMPOSE_DRAFT_INVALID");
    const failed = data.failedDrafts as Array<{ prepScore: number; prepThreshold: number }>;
    expect(failed[0]).toMatchObject({ prepScore: 0, prepThreshold: 4 });
  });

  it("finalize rejects a high-scoring draft whose scope does not match its plan", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );

    const child = makeChildDraft("TASK-900-A", "Child A", true);
    const forgedDraft = {
      ...child,
      prepScore: 5,
      prepReady: true,
      deficiencies: [],
      markdown: child.markdown.replace(
        "## Testing Requirements",
        "- [ ] Provider-added behavior outside the reviewed plan\n\n## Testing Requirements",
      ),
    };
    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [forgedDraft, makeChildDraft("TASK-900-B", "Child B", true)],
      plan: makeTopology(makeTaskFile("TASK-900", "READY", 2), child),
    });

    expect(status).toBe(400);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.refusalCode).toBe("DECOMPOSE_DRAFT_INVALID");
    expect(JSON.stringify(data.failedDrafts)).toContain("Unexpected assigned criteria");
    expect(
      fs.readFileSync(
        path.join(projectRoot, "docs", "tasks", "TASK-900-test-decompose.md"),
        "utf-8",
      ),
    ).toContain("**Status:** READY");
  });

  it("finalize rejects a plan bound to different parent content", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );

    const child = makeChildDraft("TASK-900-A", "Child A", true);
    const stalePlan = makeTopology(makeTaskFile("TASK-900", "READY", 2), child);
    stalePlan.parentContentHash = "forged-stale-parent-hash";
    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [child, makeChildDraft("TASK-900-B", "Child B", true)],
      plan: stalePlan,
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      refusalCode: "DECOMPOSE_PLAN_INVALID",
    });
  });

  it("finalize rejects a forged non-sequential child identity", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );

    const child = makeChildDraft("TASK-900-A", "Child A", true);
    const forgedChild = makeChildDraft("TASK-900-FOO", "Forged Child", true);
    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [child, makeChildDraft("TASK-900-B", "Child B", true)],
      plan: makeTopology(makeTaskFile("TASK-900", "READY", 2), forgedChild),
    });

    expect(status).toBe(400);
    expect(JSON.parse(body)).toMatchObject({
      ok: false,
      refusalCode: "DECOMPOSE_PLAN_INVALID",
    });
    expect(
      fs
        .readdirSync(path.join(projectRoot, "docs", "tasks"))
        .filter((name) => name.startsWith("TASK-900-FOO")),
    ).toEqual([]);
  });

  // ── finalize: DECOMPOSE_COVERAGE_GAP ───────────────────────────────

  it("finalize refuses when coverage report has gaps", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );

    const child = makeChildDraft("TASK-900-A", "Child A", true);
    const forgedPlan = makeTopology(makeTaskFile("TASK-900", "READY", 2), child);
    forgedPlan.subtasks[0].filesToModify = [];
    // The submitted report lies; finalize must recompute from subtasks.
    forgedPlan.coverageReport.hasCoverageGap = false;
    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [child, makeChildDraft("TASK-900-B", "Child B", true)],
      plan: forgedPlan,
    });
    expect(status).toBe(400);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.refusalCode).toBe("DECOMPOSE_COVERAGE_GAP");
    expect(data.unmappedFiles).toContain("src/module-0.ts");
  });

  // ── finalize: DECOMPOSE_WRITE_LOCKED ───────────────────────────────

  it("finalize refuses when write lock is held", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );

    // Create a lock file to simulate a concurrent operation
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.writeFileSync(
      path.join(taskDir, ".decompose.lock"),
      `99999\n${new Date().toISOString()}`,
      "utf-8",
    );

    const child = makeChildDraft("TASK-900-A", "Child A", true);
    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [child, makeChildDraft("TASK-900-B", "Child B", true)],
      plan: makeTopology(makeTaskFile("TASK-900", "READY", 2), child),
    });
    expect(status).toBe(409);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(false);
    expect(data.refusalCode).toBe("DECOMPOSE_WRITE_LOCKED");
  });

  // ── finalize: successful write ──────────────────────────────────────

  it("finalize succeeds when all gates pass and writes child files", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );

    const initialHead = git(projectRoot, ["rev-parse", "HEAD"]);
    const unrelatedPath = path.join(projectRoot, "operator-notes.txt");
    fs.writeFileSync(unrelatedPath, "keep this staged\n", "utf-8");
    git(projectRoot, ["add", "--", "operator-notes.txt"]);
    const unrelatedIndexBefore = git(projectRoot, ["show", ":operator-notes.txt"]);

    await startServer();
    const goodDraft = makeChildDraft("TASK-900-A", "child-a-scope", true);
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      enqueue: true,
      drafts: [goodDraft, makeChildDraft("TASK-900-B", "Child B", true)],
      plan: makeTopology(makeTaskFile("TASK-900", "READY", 2), goodDraft),
    });
    expect(status).toBe(200);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.mode).toBe("finalize");
    expect(data.subtaskIds).toContain("TASK-900-A");
    expect(data.subtaskIds).toContain("TASK-900-B");
    expect(data.writtenPaths).toBeDefined();
    expect((data.writtenPaths as string[]).length).toBeGreaterThan(0);
    expect(data.parentStatusUpdated).toBe(true);
    expect(data.recoveryPending).toBe(false);
    expect(data.statusProjectionId).toMatch(/^[0-9a-f]{64}$/);

    // Verify parent was rewritten as tracker
    const taskDir = path.join(projectRoot, "docs", "tasks");
    const parentContent = fs.readFileSync(
      path.join(taskDir, "TASK-900-test-decompose.md"),
      "utf-8",
    );
    expect(parentContent).toContain("DECOMPOSED");
    expect(parentContent).toContain("Decomposition Summary");
    expect(parentContent).toContain("not be dispatched directly");

    // Verify child file was created
    const childFiles = fs.readdirSync(taskDir).filter((f) => f.startsWith("TASK-900-A"));
    expect(childFiles.length).toBeGreaterThan(0);
    const finalChildFiles = fs.readdirSync(taskDir).filter((f) => f.startsWith("TASK-900-B"));
    expect(finalChildFiles.length).toBeGreaterThan(0);

    // Finalize creates exactly one parent+children commit before enqueue, so
    // dispatcher worktrees can resolve every child from HEAD. Unrelated index
    // state remains staged and is not absorbed into that commit.
    expect(git(projectRoot, ["rev-list", "--count", `${initialHead}..HEAD`])).toBe("1");
    expect(git(projectRoot, ["show", "HEAD:docs/tasks/TASK-900-test-decompose.md"])).toContain(
      "**Status:** DECOMPOSED",
    );
    expect(git(projectRoot, ["show", `HEAD:docs/tasks/${childFiles[0]}`])).toContain(
      "# TASK-900-A:",
    );
    expect(git(projectRoot, ["diff", "--cached", "--name-only"])).toBe("operator-notes.txt");
    expect(git(projectRoot, ["show", ":operator-notes.txt"])).toBe(unrelatedIndexBefore);
  });

  it("returns committed recovery-pending and suppresses enqueue when DB projection fails", async () => {
    const prepDir = path.join(projectRoot, ".quack", "prep");
    fs.mkdirSync(prepDir, { recursive: true });
    fs.writeFileSync(
      path.join(prepDir, "TASK-900.json"),
      JSON.stringify(makePrepResult("TASK-900", 4.8, true)),
      "utf-8",
    );
    await startServer();
    jest.spyOn(QuackDB.prototype, "setStatus").mockImplementation((_, __, updatedBy) => {
      if (updatedBy.startsWith("decomposition:")) {
        throw new Error("synthetic authoritative DB outage");
      }
    });
    const child = makeChildDraft("TASK-900-A", "Child A", true);

    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      enqueue: true,
      drafts: [child, makeChildDraft("TASK-900-B", "Child B", true)],
      plan: makeTopology(makeTaskFile("TASK-900", "READY", 2), child),
    });

    expect(status).toBe(200);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data).toMatchObject({
      ok: true,
      mode: "finalize",
      taskId: "TASK-900",
      recoveryPending: true,
      enqueuedItems: [],
    });
    expect(data).not.toHaveProperty("refusalCode", "DECOMPOSE_WRITE_FAILED");
    expect(data.statusProjectionId).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(data.warnings)).toContain("synthetic authoritative DB outage");
    const adapter = await loadAdapter(projectRoot);
    expect(await listPendingDecompositionStatusProjections(adapter)).toHaveLength(1);
  });

  // ── plan mode: side-effect free ─────────────────────────────────────

  describe("plan mode side-effect guarantees", () => {
    it("plan mode with dryRun:true maps to plan (backward compat)", async () => {
      // dryRun:true should map to mode=plan — but since plan calls LLM
      // for blueprint generation, we verify that dryRun:false does NOT
      // map to finalize (must be mode=plan)
      await startServer();
      const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
        dryRun: false,
      });
      // dryRun:false defaults to mode=plan (no default write behavior)
      // This may fail if blueprint agent cannot run (no API key),
      // but it should NOT default to finalize or approve
      // A 500 from missing API key is acceptable — it proves no auto-write
      expect([200, 500]).toContain(status);
      if (status === 200) {
        const data = JSON.parse(body) as Record<string, unknown>;
        expect(data.mode).toBe("plan");
      }
      // Verify no child files were written
      const taskDir = path.join(projectRoot, "docs", "tasks");
      const files = fs.readdirSync(taskDir);
      const childFiles = files.filter(
        (f) => f.startsWith("TASK-900-A") || f.startsWith("TASK-900-B"),
      );
      expect(childFiles).toHaveLength(0);
    });
  });

  // ── materialize mode: side-effect free ──────────────────────────────

  describe("materialize mode side-effect guarantees", () => {
    it("materialize does not write files even if it fails", async () => {
      await startServer();
      // materialize without plan will try to run blueprint + decompose
      // which may fail without an API key, but should NOT write any files
      const { status } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
        mode: "materialize",
      });
      // 200 or 500 depending on LLM availability — either way, no files
      expect([200, 500]).toContain(status);

      const taskDir = path.join(projectRoot, "docs", "tasks");
      const files = fs.readdirSync(taskDir);
      const childFiles = files.filter(
        (f) => f.startsWith("TASK-900-A") || f.startsWith("TASK-900-B"),
      );
      expect(childFiles).toHaveLength(0);
    });
  });
});
