import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { AdminRunManager, classifyAdminRunStageLine } from "../../src/monitor/admin-run-manager";

describe("admin run manager", () => {
  it("classifies overnight output into pollable stages", () => {
    expect(classifyAdminRunStageLine("[overnight] gate TASK-943", "starting")).toBe("gate");
    expect(classifyAdminRunStageLine("[overnight] spec review TASK-943", "gate")).toBe(
      "spec_review",
    );
    expect(classifyAdminRunStageLine("[overnight] blueprint TASK-943", "spec_review")).toBe(
      "blueprint",
    );
    expect(classifyAdminRunStageLine("[overnight] analysis TASK-943", "blueprint")).toBe(
      "analysis",
    );
    expect(classifyAdminRunStageLine("[overnight] prep TASK-943", "starting")).toBe("prep");
    expect(classifyAdminRunStageLine("[overnight] enrich TASK-943", "prep")).toBe("enrich");
    expect(classifyAdminRunStageLine("[overnight] decompose TASK-943", "prep")).toBe("decompose");
    expect(classifyAdminRunStageLine("[overnight] dispatch TASK-943-A", "decompose")).toBe(
      "dispatch",
    );
    expect(
      classifyAdminRunStageLine("[overnight] waiting: dispatch lane occupied", "dispatch"),
    ).toBe("waiting");
    expect(classifyAdminRunStageLine("Overnight Runner Summary", "waiting")).toBe("summarizing");
    expect(classifyAdminRunStageLine("Halted: task parse errors present", "summarizing")).toBe(
      "halted",
    );
  });

  it("keeps current stage when output has no progress signal", () => {
    expect(classifyAdminRunStageLine("ordinary command output", "prep")).toBe("prep");
  });

  it("starts overnight runs in the background with bounded dry-run args", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-admin-run-"));
    const argvPath = path.join(tempDir, "argv.json");
    const scriptPath = path.join(tempDir, "fake-quack.js");
    fs.writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.ADMIN_RUN_TEST_ARGV_PATH, JSON.stringify(process.argv.slice(2)));",
        "console.log('[overnight] prep TASK-943');",
        "setTimeout(() => process.exit(0), 10);",
      ].join("\n"),
      "utf-8",
    );

    process.env.ADMIN_RUN_TEST_ARGV_PATH = argvPath;
    const manager = new AdminRunManager(scriptPath);
    const snapshot = manager.startOvernight({
      projectId: "example-service",
      projectRoot: tempDir,
      monitorUrl: "http://localhost:3333",
      taskIds: ["TASK-943"],
      allowParseErrors: true,
      once: true,
      maxDispatches: 0,
      maxCycles: 1,
      maxSubtasks: 4,
      autoEnrich: true,
      dryRun: true,
    });

    expect(snapshot.status).toBe("running");
    await waitForFile(argvPath);
    const args = JSON.parse(fs.readFileSync(argvPath, "utf-8")) as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "overnight",
        "--project",
        tempDir,
        "--task-ids",
        "TASK-943",
        "--allow-parse-errors",
        "--once",
        "--max-dispatches",
        "0",
        "--max-cycles",
        "1",
        "--max-subtasks",
        "4",
        "--auto-enrich",
        "--dry-run",
      ]),
    );

    await waitForRunStatus(manager, snapshot.runId, "completed");
    delete process.env.ADMIN_RUN_TEST_ARGV_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("passes federation dispatch args when options are set", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-admin-fed-"));
    const argvPath = path.join(tempDir, "argv.json");
    const scriptPath = path.join(tempDir, "fake-quack.js");
    fs.writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.ADMIN_RUN_TEST_ARGV_PATH, JSON.stringify(process.argv.slice(2)));",
        "setTimeout(() => process.exit(0), 10);",
      ].join("\n"),
      "utf-8",
    );

    process.env.ADMIN_RUN_TEST_ARGV_PATH = argvPath;
    const manager = new AdminRunManager(scriptPath);
    const snapshot = manager.startOvernight({
      projectId: "example-service",
      projectRoot: tempDir,
      monitorUrl: "http://localhost:3333",
      taskIds: ["TASK-924"],
      once: true,
      dryRun: true,
      federationDispatch: true,
      preferredHostId: "headnode",
      allowLowPreflightOnFederationDispatch: true,
    });

    expect(snapshot.status).toBe("running");
    await waitForFile(argvPath);
    const args = JSON.parse(fs.readFileSync(argvPath, "utf-8")) as string[];
    expect(args).toEqual(
      expect.arrayContaining([
        "--federation-dispatch",
        "--preferred-host-id",
        "headnode",
        "--allow-low-preflight-on-federation-dispatch",
      ]),
    );

    await waitForRunStatus(manager, snapshot.runId, "completed");
    delete process.env.ADMIN_RUN_TEST_ARGV_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("includes --auto-acknowledge-decompose-review when option is true", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-admin-ackdecomp-"));
    const argvPath = path.join(tempDir, "argv.json");
    const scriptPath = path.join(tempDir, "fake-quack.js");
    fs.writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.ADMIN_RUN_TEST_ARGV_PATH, JSON.stringify(process.argv.slice(2)));",
        "setTimeout(() => process.exit(0), 10);",
      ].join("\n"),
      "utf-8",
    );

    process.env.ADMIN_RUN_TEST_ARGV_PATH = argvPath;
    const manager = new AdminRunManager(scriptPath);
    manager.startOvernight({
      projectId: "example-service",
      projectRoot: tempDir,
      monitorUrl: "http://localhost:3333",
      taskIds: ["TASK-925"],
      once: true,
      dryRun: true,
      autoAcknowledgeDecomposeReview: true,
    });

    await waitForFile(argvPath);
    const args = JSON.parse(fs.readFileSync(argvPath, "utf-8")) as string[];
    expect(args).toContain("--auto-acknowledge-decompose-review");

    delete process.env.ADMIN_RUN_TEST_ARGV_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("omits --auto-acknowledge-decompose-review when option is false or unset", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-admin-noackdecomp-"));
    const argvPath = path.join(tempDir, "argv.json");
    const scriptPath = path.join(tempDir, "fake-quack.js");
    fs.writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.ADMIN_RUN_TEST_ARGV_PATH, JSON.stringify(process.argv.slice(2)));",
        "setTimeout(() => process.exit(0), 10);",
      ].join("\n"),
      "utf-8",
    );

    process.env.ADMIN_RUN_TEST_ARGV_PATH = argvPath;
    const manager = new AdminRunManager(scriptPath);
    manager.startOvernight({
      projectId: "example-service",
      projectRoot: tempDir,
      monitorUrl: "http://localhost:3333",
      taskIds: ["TASK-925"],
      once: true,
      dryRun: true,
      autoAcknowledgeDecomposeReview: false,
    });

    await waitForFile(argvPath);
    const args = JSON.parse(fs.readFileSync(argvPath, "utf-8")) as string[];
    expect(args).not.toContain("--auto-acknowledge-decompose-review");

    delete process.env.ADMIN_RUN_TEST_ARGV_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("omits federation args when options are not set", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-admin-nofed-"));
    const argvPath = path.join(tempDir, "argv.json");
    const scriptPath = path.join(tempDir, "fake-quack.js");
    fs.writeFileSync(
      scriptPath,
      [
        "const fs = require('node:fs');",
        "fs.writeFileSync(process.env.ADMIN_RUN_TEST_ARGV_PATH, JSON.stringify(process.argv.slice(2)));",
        "setTimeout(() => process.exit(0), 10);",
      ].join("\n"),
      "utf-8",
    );

    process.env.ADMIN_RUN_TEST_ARGV_PATH = argvPath;
    const manager = new AdminRunManager(scriptPath);
    manager.startOvernight({
      projectId: "example-service",
      projectRoot: tempDir,
      monitorUrl: "http://localhost:3333",
      taskIds: ["TASK-924"],
      once: true,
      dryRun: true,
    });

    await waitForFile(argvPath);
    const args = JSON.parse(fs.readFileSync(argvPath, "utf-8")) as string[];
    expect(args).not.toContain("--federation-dispatch");
    expect(args).not.toContain("--preferred-host-id");
    expect(args).not.toContain("--allow-low-preflight-on-federation-dispatch");

    delete process.env.ADMIN_RUN_TEST_ARGV_PATH;
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("keeps a pollable heartbeat while the child process is quiet", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-admin-heartbeat-"));
    const scriptPath = path.join(tempDir, "quiet-quack.js");
    fs.writeFileSync(scriptPath, "setTimeout(() => process.exit(0), 150);\n", "utf-8");

    const manager = new AdminRunManager(scriptPath, { heartbeatIntervalMs: 20 });
    const snapshot = manager.startOvernight({
      projectId: "example-service",
      projectRoot: tempDir,
      monitorUrl: "http://localhost:3333",
      taskIds: ["TASK-898"],
      once: true,
      dryRun: true,
    });

    expect(snapshot.watchdog.status).toBe("healthy");
    const heartbeat = await waitForHeartbeatAfter(
      manager,
      snapshot.runId,
      snapshot.lastHeartbeatAt,
    );
    expect(heartbeat.lastHeartbeatAt).not.toBe(snapshot.lastHeartbeatAt);
    expect(heartbeat.lastOutputAt).toBe(snapshot.lastOutputAt);
    expect(heartbeat.watchdog.status).toBe("healthy");

    await waitForRunStatus(manager, snapshot.runId, "completed");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it("uses checkpoint currentStage to surface deeper stage timing and watchdog guidance", async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-admin-checkpoint-stage-"));
    const checkpointPath = path.join(tempDir, "admin-runs", "checkpoint.json");
    const scriptPath = path.join(tempDir, "quiet-quack.js");
    fs.writeFileSync(scriptPath, "setTimeout(() => process.exit(0), 200);\n", "utf-8");

    const manager = new AdminRunManager(scriptPath, { heartbeatIntervalMs: 20 });
    const snapshot = manager.startOvernight({
      projectId: "example-service",
      projectRoot: tempDir,
      monitorUrl: "http://localhost:3333",
      taskIds: ["TASK-901"],
      checkpointPath,
      once: true,
      dryRun: true,
    });

    const staleAt = new Date(Date.now() - 60_000).toISOString();
    fs.mkdirSync(path.dirname(checkpointPath), { recursive: true });
    fs.writeFileSync(
      checkpointPath,
      JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          currentStage: {
            stage: "blueprint",
            status: "running",
            startedAt: staleAt,
            lastHeartbeatAt: new Date().toISOString(),
            lastOutputAt: staleAt,
            staleAfterMs: 10,
            recommendedAction: "Inspect blueprint generation runtime.",
            taskId: "TASK-901",
            detail: "Generating implementation blueprint.",
          },
        },
        null,
        2,
      ),
      "utf-8",
    );

    await new Promise((resolve) => setTimeout(resolve, 40));
    const run = await manager.getRun(snapshot.runId);
    expect(run?.stage).toBe("blueprint");
    expect(run?.checkpoint?.currentStage?.stage).toBe("blueprint");
    expect(run?.watchdog.status).toBe("stale_output");
    expect(run?.watchdog.recommendedAction).toBe("Inspect blueprint generation runtime.");

    await waitForRunStatus(manager, snapshot.runId, "completed");
    fs.rmSync(tempDir, { recursive: true, force: true });
  });
});

async function waitForFile(filePath: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    if (fs.existsSync(filePath)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for ${filePath}`);
}

async function waitForRunStatus(
  manager: AdminRunManager,
  runId: string,
  status: "completed" | "failed" | "stopped",
): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = await manager.getRun(runId);
    if (run?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for admin run ${runId} to reach ${status}`);
}

async function waitForHeartbeatAfter(
  manager: AdminRunManager,
  runId: string,
  previousHeartbeat: string,
) {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const run = await manager.getRun(runId);
    if (run && run.lastHeartbeatAt !== previousHeartbeat) return run;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out waiting for admin run ${runId} heartbeat`);
}
