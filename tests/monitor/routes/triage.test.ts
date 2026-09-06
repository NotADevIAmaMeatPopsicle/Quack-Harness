import { describe, it, expect, jest, beforeEach, afterEach } from "@jest/globals";
import * as os from "node:os";
import * as path from "node:path";
import * as fs from "node:fs";

const mockExecFileSync = jest.fn((..._args: unknown[]): unknown => {
  throw Object.assign(new Error("not a git repository"), {
    status: 128,
    stderr: "fatal: not a git repository",
  });
});

// Mock child_process to avoid real git calls
jest.mock("node:child_process", () => ({
  execSync: jest.fn().mockReturnValue(""),
  execFileSync: mockExecFileSync,
}));

import { computeTriage } from "../../../src/monitor/routes/triage.js";

// ─── Helpers ────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-triage-test-"));
  // Create standard directory structure
  fs.mkdirSync(path.join(tmpDir, "docs", "tasks"), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, ".quack"), { recursive: true });
});

afterEach(() => {
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

/** Generate a minimal valid TASK-*.md file. */
function makeTaskMd(opts: {
  id: string;
  title?: string;
  priority?: string;
  effort?: string;
  status?: string;
  blockedBy?: string[];
  blocks?: string[];
  tags?: string[];
  parentTask?: string;
}): string {
  const title = opts.title ?? `Task ${opts.id}`;
  const priority = opts.priority ?? "P2-MEDIUM";
  const effort = opts.effort ?? "1-2 days";
  const status = opts.status ?? "BACKLOG";
  const blockedBy = opts.blockedBy ?? [];
  const blocks = opts.blocks ?? [];
  const tags = opts.tags ?? [];
  const parentLine = opts.parentTask ? `- **Parent Task:** ${opts.parentTask}\n` : "";

  return `# ${opts.id}: ${title}

## Metadata
- **Priority:** ${priority}
- **Effort:** ${effort}
- **Status:** ${status}
- **Blocked By:** [${blockedBy.join(", ")}]
- **Blocks:** [${blocks.join(", ")}]
- **Tags:** [${tags.join(", ")}]
${parentLine}
## Problem Statement
Test problem statement for ${opts.id}

## Success Criteria
- [ ] Criterion one

## Testing Requirements
- [ ] Requirement one
`;
}

/** Write a task file into the temp project. */
function writeTask(opts: Parameters<typeof makeTaskMd>[0], filename?: string): void {
  const fname = filename ?? `${opts.id}.md`;
  fs.writeFileSync(path.join(tmpDir, "docs", "tasks", fname), makeTaskMd(opts), "utf-8");
}

/** Write adapter.json pointing to the default task dir. */
function writeAdapter(taskDir = "docs/tasks"): void {
  fs.writeFileSync(
    path.join(tmpDir, ".quack", "adapter.json"),
    JSON.stringify({ project: { taskDir } }),
    "utf-8",
  );
}

/** Write verified.json with given task entries. */
function writeVerifiedJson(
  tasks: Record<string, { verified: string; method: string; verdict: string }>,
): void {
  fs.writeFileSync(
    path.join(tmpDir, ".quack", "verified.json"),
    JSON.stringify({ tasks }),
    "utf-8",
  );
}

// ─── Tests ──────────────────────────────────────────────────────────

describe("computeTriage", () => {
  beforeEach(() => {
    mockExecFileSync.mockImplementation((): unknown => {
      throw Object.assign(new Error("not a git repository"), {
        status: 128,
        stderr: "fatal: not a git repository",
      });
    });
  });

  it("returns empty result for a project with no task files", async () => {
    writeAdapter();
    const result = await computeTriage(tmpDir);

    expect(result.projectId).toBe(path.basename(tmpDir));
    expect(result.generatedAt).toBeDefined();
    expect(result.summary.total).toBe(0);
    expect(result.parentTasks).toHaveLength(0);

    // All categories should exist but be empty
    for (const cat of result.categories) {
      expect(cat.count).toBe(0);
      expect(cat.tasks).toHaveLength(0);
    }
  });

  it("includes generated projection hygiene diagnostics", async () => {
    writeAdapter();
    mockExecFileSync.mockImplementation((_cmd: unknown, args: unknown): unknown => {
      const commandArgs = Array.isArray(args) ? args.map(String) : [];
      const joined = commandArgs.join(" ");
      if (joined === "rev-parse --is-inside-work-tree") return "true\n";
      if (joined.includes("ls-files --error-unmatch") && joined.includes(".quack/verified.json")) {
        return ".quack/verified.json\n";
      }
      throw Object.assign(new Error("git command failed"), {
        status: 1,
        stderr: "",
      });
    });

    const result = await computeTriage(tmpDir);

    expect(result.projectionHygiene.status).toBe("migration_required");
    expect(result.projectionHygiene.trackedGeneratedFiles).toContain(".quack/verified.json");
    expect(result.projectionHygiene.recommendedCommand).toContain(
      "--migrate-generated-projections",
    );
  });

  it("resolves dynamic blockers — all blockers complete promotes effective status to READY", async () => {
    writeAdapter();
    writeTask({ id: "TASK-100", status: "COMPLETE", blocks: ["TASK-101"] });
    writeTask({
      id: "TASK-101",
      status: "BACKLOG",
      blockedBy: ["TASK-100"],
    });

    const result = await computeTriage(tmpDir);

    const task101 = result.categories.flatMap((c) => c.tasks).find((t) => t.id === "TASK-101");
    expect(task101).toBeDefined();
    expect(task101!.allBlockersComplete).toBe(true);
    expect(task101!.effectiveStatus).toBe("READY");

    // Should be in the READY category, not BLOCKED or BACKLOG
    const readyCategory = result.categories.find((c) => c.name === "READY");
    expect(readyCategory!.tasks.some((t) => t.id === "TASK-101")).toBe(true);
  });

  it("detects partial blocker resolution — not all blockers complete", async () => {
    writeAdapter();
    writeTask({ id: "TASK-100", status: "COMPLETE", blocks: ["TASK-102"] });
    writeTask({
      id: "TASK-101",
      status: "IN_PROGRESS",
      blocks: ["TASK-102"],
    });
    writeTask({
      id: "TASK-102",
      status: "BACKLOG",
      blockedBy: ["TASK-100", "TASK-101"],
    });

    const result = await computeTriage(tmpDir);

    const task102 = result.categories.flatMap((c) => c.tasks).find((t) => t.id === "TASK-102");
    expect(task102).toBeDefined();
    expect(task102!.allBlockersComplete).toBe(false);
    expect(task102!.effectiveStatus).toBe("BACKLOG");

    // Should be in BLOCKED category
    const blockedCategory = result.categories.find((c) => c.name === "BLOCKED");
    expect(blockedCategory!.tasks.some((t) => t.id === "TASK-102")).toBe(true);
  });

  it("cross-references verified.json — verified COMPLETE task", async () => {
    writeAdapter();
    writeTask({ id: "TASK-100", status: "COMPLETE" });
    writeVerifiedJson({
      "TASK-100": {
        verified: "2026-03-01",
        method: "auto",
        verdict: "VERIFIED",
      },
    });

    const result = await computeTriage(tmpDir);

    const task100 = result.categories.flatMap((c) => c.tasks).find((t) => t.id === "TASK-100");
    expect(task100).toBeDefined();
    expect(task100!.verified).toBe(true);
    expect(task100!.verifiedEntry).toEqual({
      date: "2026-03-01",
      method: "auto",
      verdict: "VERIFIED",
    });

    // Should be in VERIFIED category
    const verifiedCategory = result.categories.find((c) => c.name === "VERIFIED");
    expect(verifiedCategory!.tasks.some((t) => t.id === "TASK-100")).toBe(true);
  });

  it("detects unverified COMPLETE task — no verified.json entry", async () => {
    writeAdapter();
    writeTask({ id: "TASK-100", status: "COMPLETE" });
    // No verified.json at all

    const result = await computeTriage(tmpDir);

    const task100 = result.categories.flatMap((c) => c.tasks).find((t) => t.id === "TASK-100");
    expect(task100).toBeDefined();
    expect(task100!.verified).toBe(false);
    expect(task100!.verifiedEntry).toBeUndefined();

    // Should be in COMPLETE_UNVERIFIED category
    const unverifiedCategory = result.categories.find((c) => c.name === "COMPLETE_UNVERIFIED");
    expect(unverifiedCategory!.tasks.some((t) => t.id === "TASK-100")).toBe(true);
  });

  it("correctly groups tasks into categories with accurate counts", async () => {
    writeAdapter();

    // VERIFIED: COMPLETE + verified.json
    writeTask({ id: "TASK-100", status: "COMPLETE" });
    writeVerifiedJson({
      "TASK-100": {
        verified: "2026-03-01",
        method: "auto",
        verdict: "VERIFIED",
      },
    });

    // COMPLETE_UNVERIFIED: COMPLETE, no verified entry
    writeTask({ id: "TASK-101", status: "COMPLETE" });

    // READY: explicit READY status
    writeTask({ id: "TASK-102", status: "READY" });

    // BACKLOG: BACKLOG with no blockers
    writeTask({ id: "TASK-103", status: "BACKLOG" });

    // REJECTED
    writeTask({ id: "TASK-104", status: "REJECTED" });

    // IN_PROGRESS
    writeTask({ id: "TASK-105", status: "IN_PROGRESS" });

    const result = await computeTriage(tmpDir);

    expect(result.summary.total).toBe(6);
    expect(result.summary.verified).toBe(1);
    expect(result.summary.completeUnverified).toBe(1);
    expect(result.summary.ready).toBe(1);
    expect(result.summary.backlog).toBe(1);
    expect(result.summary.rejected).toBe(1);
    expect(result.summary.inProgress).toBe(1);
    expect(result.summary.blocked).toBe(0);
    expect(result.summary.manual).toBe(0);
  });

  it("categorizes tasks with manual/infrastructure/interactive tags under MANUAL", async () => {
    writeAdapter();
    writeTask({
      id: "TASK-100",
      status: "BACKLOG",
      tags: ["manual"],
    });
    writeTask({
      id: "TASK-101",
      status: "BACKLOG",
      tags: ["infrastructure"],
    });
    writeTask({
      id: "TASK-102",
      status: "READY",
      tags: ["interactive"],
    });
    // A normal BACKLOG task without manual tags
    writeTask({ id: "TASK-103", status: "BACKLOG" });

    const result = await computeTriage(tmpDir);

    const manualCategory = result.categories.find((c) => c.name === "MANUAL");
    expect(manualCategory!.count).toBe(3);
    expect(manualCategory!.tasks.map((t) => t.id).sort()).toEqual([
      "TASK-100",
      "TASK-101",
      "TASK-102",
    ]);

    // TASK-103 should NOT be in MANUAL
    expect(manualCategory!.tasks.some((t) => t.id === "TASK-103")).toBe(false);

    expect(result.summary.manual).toBe(3);
    expect(result.summary.backlog).toBe(1);
  });

  it("skips malformed task files and still returns valid ones", async () => {
    writeAdapter();

    // Valid task
    writeTask({ id: "TASK-100", status: "BACKLOG" });

    // Malformed file — missing required sections
    fs.writeFileSync(
      path.join(tmpDir, "docs", "tasks", "TASK-999.md"),
      "# TASK-999: Broken task\n\nNo metadata section at all.\n",
      "utf-8",
    );

    // Suppress console.warn from the triage module
    const warnSpy = jest.spyOn(console, "warn").mockImplementation(() => {});

    const result = await computeTriage(tmpDir);

    // Only the valid task should appear
    expect(result.summary.total).toBe(1);
    const allTasks = result.categories.flatMap((c) => c.tasks);
    expect(allTasks).toHaveLength(1);
    expect(allTasks[0].id).toBe("TASK-100");

    // The malformed file should have triggered a console.warn
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining("TASK-999"));

    warnSpy.mockRestore();
  });

  it("falls back to docs/tasks when adapter.json is missing", async () => {
    // No adapter.json written — should still find tasks in docs/tasks
    writeTask({ id: "TASK-100", status: "BACKLOG" });

    const result = await computeTriage(tmpDir);

    expect(result.summary.total).toBe(1);
  });

  it("handles SOFT-VERIFIED verdict as verified", async () => {
    writeAdapter();
    writeTask({ id: "TASK-100", status: "COMPLETE" });
    writeVerifiedJson({
      "TASK-100": {
        verified: "2026-03-01",
        method: "auto",
        verdict: "SOFT-VERIFIED",
      },
    });

    const result = await computeTriage(tmpDir);

    const task100 = result.categories.flatMap((c) => c.tasks).find((t) => t.id === "TASK-100");
    expect(task100!.verified).toBe(true);

    const verifiedCategory = result.categories.find((c) => c.name === "VERIFIED");
    expect(verifiedCategory!.tasks.some((t) => t.id === "TASK-100")).toBe(true);
  });

  it("reads BOM-prefixed verified.json and still classifies verified tasks correctly", async () => {
    writeAdapter();
    writeTask({ id: "TASK-400", status: "COMPLETE" });
    fs.writeFileSync(
      path.join(tmpDir, ".quack", "verified.json"),
      "\uFEFF" +
        JSON.stringify({
          tasks: {
            "TASK-400": {
              verified: "2026-05-05",
              method: "/verify-task",
              verdict: "VERIFIED",
            },
          },
        }),
      "utf-8",
    );

    const result = await computeTriage(tmpDir);
    const verifiedCategory = result.categories.find((c) => c.name === "VERIFIED");
    expect(verifiedCategory!.tasks.some((task) => task.id === "TASK-400")).toBe(true);
  });
});
