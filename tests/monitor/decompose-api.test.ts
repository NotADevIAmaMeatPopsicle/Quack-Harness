// ─── Decompose API Endpoint Tests ──────────────────────────────────
// Tests for POST /api/tasks/:id/decompose staged contract.
// Covers plan / materialize / finalize modes, refusal codes, and
// side-effect guarantees.

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";

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
  const prepScore = ready ? 4.5 : 2.0;
  const markdown = [
    `# ${subtaskId}: ${title}`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 4-6 hours",
    "- **Status:** READY",
    "- **Blocked By:** []",
    "- **Tags:** test",
    "",
    "## Problem Statement",
    "This child task implements a specific module with detailed requirements and integration guidance.",
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
    `| \`src/module.ts\` | Create | Main module |`,
    "",
    "## Success Criteria",
    "- [ ] Module exists and passes tests",
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

  return {
    subtaskId,
    title,
    markdown,
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
      makeTaskFile("TASK-900", "READY"),
      "utf-8",
    );
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
  });

  async function startServer(): Promise<number> {
    const port = 30000 + Math.floor(Math.random() * 10000);
    const serverObj = createMonitorServer({
      logDir,
      port,
      projectRoot,
      adapterPath: path.join(projectRoot, ".quack", "adapter.json"),
      taskDir: "docs/tasks",
    });
    const { stop } = await serverObj.start();
    stopServer = stop;
    baseUrl = `http://localhost:${port}`;
    return port;
  }

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
      parseError: "Missing required section: Success Criteria",
      prepReady: false,
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

  // ── finalize: DECOMPOSE_COVERAGE_GAP ───────────────────────────────

  it("finalize refuses when coverage report has gaps", async () => {
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
      drafts: [makeChildDraft("TASK-900-A", "Child A", true)],
      plan: {
        parentTaskId: "TASK-900",
        subtasks: [],
        coverageReport: {
          fileOwnership: [],
          criterionOwnership: [],
          unmappedFiles: ["src/module-0.ts"],
          unmappedCriteria: ["Criterion 1 is satisfied"],
          duplicatedFiles: [],
          hasCoverageGap: true,
        },
      },
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

    await startServer();
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [makeChildDraft("TASK-900-A", "Child A", true)],
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

    await startServer();
    const goodDraft = makeChildDraft("TASK-900-A", "child-a-scope", true);
    const { status, body } = await httpPost(`${baseUrl}/api/tasks/TASK-900/decompose`, {
      mode: "finalize",
      reviewAcknowledged: true,
      drafts: [goodDraft],
      plan: {
        parentTaskId: "TASK-900",
        subtasks: [
          {
            id: "TASK-900-A",
            title: "child-a-scope",
            filesToModify: [{ path: "src/module-0.ts", action: "Create" }],
            successCriteria: ["Criterion 1 is satisfied"],
            dependsOn: [],
            isFinal: true,
          },
        ],
        coverageReport: {
          fileOwnership: [{ filePath: "src/module-0.ts", ownedBy: "TASK-900-A", isShared: false }],
          criterionOwnership: [{ criterion: "Criterion 1 is satisfied", ownedBy: ["TASK-900-A"] }],
          unmappedFiles: [],
          unmappedCriteria: [],
          duplicatedFiles: [],
          hasCoverageGap: false,
        },
      },
    });
    expect(status).toBe(200);
    const data = JSON.parse(body) as Record<string, unknown>;
    expect(data.ok).toBe(true);
    expect(data.mode).toBe("finalize");
    expect(data.subtaskIds).toContain("TASK-900-A");
    expect(data.writtenPaths).toBeDefined();
    expect((data.writtenPaths as string[]).length).toBeGreaterThan(0);
    expect(data.parentStatusUpdated).toBe(true);

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
