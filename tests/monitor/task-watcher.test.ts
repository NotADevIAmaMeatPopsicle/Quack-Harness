import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { TaskWatcher } from "../../src/monitor/task-watcher";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { ParsedTask } from "../../src/core/types";
import { listTaskClaimantDeclarations } from "../../src/core/task-file-resolver";
import { writeTaskFiles } from "../../src/planner/task-writer";
import { taskSpec } from "../helpers/duplicate-claimants-fixture";

// ─── Helpers ──────────────────────────────────────────────────────

let currentProjectRoot = "/test/project";

function createMockAdapter(): ProjectAdapter {
  return {
    config: {
      project: { name: "test-project", taskDir: "." },
      agent: {},
      verification: { commands: [] },
    },
    conventionsDoc: "Use TypeScript strict mode.",
    projectRoot: currentProjectRoot,
  } as unknown as ProjectAdapter;
}

const VALID_TASK = [
  "# TASK-001: Test Feature",
  "",
  "## Metadata",
  "- **Priority:** P1-HIGH",
  "- **Effort:** 2-4 hours",
  "- **Status:** READY",
  "- **Blocked By:** []",
  "- **Tags:** test",
  "",
  "## Problem Statement",
  "Need a test feature.",
  "",
  "## Success Criteria",
  "- Feature works",
  "",
  "## Testing Requirements",
  "- Unit tests for feature",
].join("\n");

const INVALID_TASK = [
  "# TASK-002: Broken Task",
  "",
  "## Metadata",
  "- **Priority:** P1-HIGH",
  "- **Effort:** 2 hours",
  "- **Status:** READY",
  "- **Blocked By:** []",
  "- **Tags:** broken",
  "",
  "## Problem Statement",
  "This task is missing Success Criteria and Testing Requirements.",
].join("\n");

// A spec the deterministic normalizer CANNOT fix (status prose with no
// recognizable leading token); exercises the LLM repair leg.
const UNRESOLVABLE_TASK = [
  "# TASK-002: Unresolvable Status Task",
  "",
  "## Metadata",
  "- **Priority:** P1-HIGH",
  "- **Effort:** 2 hours",
  "- **Status:** awaiting vendor sign-off",
  "",
  "## Problem Statement",
  "This task has a status value the normalizer cannot map.",
  "",
  "## Success Criteria",
  "- Something observable",
  "",
  "## Testing Requirements",
  "- Something tested",
].join("\n");

// Guard-compatible LLM repair output: envelope replacement WITH a same-field
// provenance note carrying the gating marker (LLM repairs must gate).
const UNRESOLVABLE_TASK_REPAIRED = UNRESOLVABLE_TASK.replace(
  "- **Status:** awaiting vendor sign-off",
  [
    "- **Status:** BLOCKED",
    '- **Status-Note:** original status "awaiting vendor sign-off" needs a human call (repair placeholder); confirm',
  ].join("\n"),
);

const COMPLETE_TASK = [
  "# TASK-003: Done Task",
  "",
  "## Metadata",
  "- **Priority:** P2-MEDIUM",
  "- **Effort:** 1 hour",
  "- **Status:** COMPLETE",
  "- **Blocked By:** []",
  "- **Tags:** done",
  "",
  "## Problem Statement",
  "This was already done.",
  "",
  "## Success Criteria",
  "- It was done",
  "",
  "## Testing Requirements",
  "- Verified it was done",
].join("\n");

const DECOMPOSED_TASK = VALID_TASK.replace("- **Status:** READY", "- **Status:** DECOMPOSED");

// ─── Tests ────────────────────────────────────────────────────────

describe("TaskWatcher", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "quack-tw-"));
    currentProjectRoot = tmpDir;
    execFileSync("git", ["init"], { cwd: tmpDir, stdio: "ignore" });
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
  });

  describe("lifecycle", () => {
    it("does not create a watcher after close wins the startup race", async () => {
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        {},
        { autoRepair: false, autoPreflight: false },
      );

      const starting = watcher.start();
      const closing = watcher.close();

      try {
        await Promise.all([starting, closing]);
        expect((watcher as unknown as { watcher: unknown }).watcher).toBeNull();
      } finally {
        // Keep the regression leak-free even if an assertion fails.
        await watcher.close();
      }
    });

    it("deduplicates concurrent starts onto one lifecycle promise", async () => {
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        {},
        { autoRepair: false, autoPreflight: false },
      );

      const firstStart = watcher.start();
      const secondStart = watcher.start();

      try {
        expect(secondStart).toBe(firstStart);
        await firstStart;
      } finally {
        await watcher.close();
      }
    });

    it("ignores a file event callback that arrives after close", async () => {
      const filePath = path.join(tmpDir, "TASK-001-late.md");
      fs.writeFileSync(filePath, VALID_TASK);
      const onNewTask = jest.fn<void, [ParsedTask, string]>();
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onNewTask },
        { debounceMs: 1, autoRepair: false, autoPreflight: false },
      );
      const internals = watcher as unknown as {
        scheduleProcess: (candidate: string) => void;
        debounceTimers: Map<string, ReturnType<typeof setTimeout>>;
      };

      await watcher.close();
      internals.scheduleProcess(filePath);
      await watcher.processFile(filePath);

      expect(internals.debounceTimers.size).toBe(0);
      expect(onNewTask).not.toHaveBeenCalled();
    });

    it("retains a watcher whose close rejects so cleanup can be retried", async () => {
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        {},
        { autoRepair: false, autoPreflight: false },
      );
      const close = jest
        .fn<Promise<void>, []>()
        .mockRejectedValueOnce(new Error("synthetic close failure"))
        .mockResolvedValueOnce(undefined);
      const internals = watcher as unknown as {
        watcher: { close: () => Promise<void> } | null;
      };
      const installedWatcher = { close };
      internals.watcher = installedWatcher;

      await expect(watcher.close()).rejects.toThrow("synthetic close failure");
      expect(internals.watcher).toBe(installedWatcher);
      await expect(watcher.close()).resolves.toBeUndefined();
      expect(internals.watcher).toBeNull();
      expect(close).toHaveBeenCalledTimes(2);
    });

    it("waits for an already-running file repair before close resolves", async () => {
      const filePath = path.join(tmpDir, "TASK-002-in-flight.md");
      fs.writeFileSync(filePath, UNRESOLVABLE_TASK);
      let releaseRepair!: (value: string) => void;
      let markRepairStarted!: () => void;
      const repairStarted = new Promise<void>((resolve) => {
        markRepairStarted = resolve;
      });
      const repairFn = jest.fn(
        () =>
          new Promise<string>((resolve) => {
            releaseRepair = resolve;
            markRepairStarted();
          }),
      );
      const onRepaired = jest.fn<void, [string, string, string[]]>();
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepaired },
        { autoRepair: true, autoPreflight: false, repairFn },
      );

      const processing = watcher.processFile(filePath);
      await repairStarted;
      let closeResolved = false;
      const closing = watcher.close().then(() => {
        closeResolved = true;
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(closeResolved).toBe(false);
      releaseRepair(UNRESOLVABLE_TASK_REPAIRED);
      await Promise.all([processing, closing]);
      expect(closeResolved).toBe(true);
      expect(onRepaired).toHaveBeenCalledTimes(1);
    });
  });

  describe("processFile", () => {
    it("calls onNewTask for a valid task file", async () => {
      const filePath = path.join(tmpDir, "TASK-001-test.md");
      fs.writeFileSync(filePath, VALID_TASK);

      const onNewTask = jest.fn<void, [ParsedTask, string]>();
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onNewTask },
        { autoRepair: false, autoPreflight: false },
      );

      await watcher.processFile(filePath);

      expect(onNewTask).toHaveBeenCalledTimes(1);
      expect(onNewTask).toHaveBeenCalledWith(expect.objectContaining({ id: "TASK-001" }), filePath);
    });

    it("calls onParseError for an invalid task file when autoRepair is off", async () => {
      const filePath = path.join(tmpDir, "TASK-002-broken.md");
      fs.writeFileSync(filePath, INVALID_TASK);

      const onParseError = jest.fn<void, [string, string]>();
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onParseError },
        { autoRepair: false, autoPreflight: false },
      );

      await watcher.processFile(filePath);

      expect(onParseError).toHaveBeenCalledTimes(1);
      expect(onParseError).toHaveBeenCalledWith(
        "TASK-002-broken.md",
        expect.stringContaining("Success Criteria"),
      );
    });

    it("deterministically repairs missing sections without calling the LLM", async () => {
      const filePath = path.join(tmpDir, "TASK-002-broken.md");
      fs.writeFileSync(filePath, INVALID_TASK);

      const onRepaired = jest.fn<void, [string, string, string[]]>();
      const onNewTask = jest.fn<void, [ParsedTask, string]>();
      const repairFn = jest.fn();

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepaired, onNewTask },
        { autoRepair: true, autoPreflight: false, repairFn },
      );

      await watcher.processFile(filePath);

      // The intent-safe normalizer handles missing sections; the LLM leg
      // must not run.
      expect(repairFn).not.toHaveBeenCalled();
      expect(onRepaired).toHaveBeenCalledTimes(1);
      expect(onRepaired).toHaveBeenCalledWith(
        "TASK-002",
        filePath,
        expect.arrayContaining([
          "success-criteria-placeholder",
          "testing-requirements-placeholder",
        ]),
      );

      // File is rewritten with gating placeholders, never invented content.
      const written = fs.readFileSync(filePath, "utf-8");
      expect(written).toContain("TASK-002");
      expect(written).toContain("Testing Requirements");
      expect(written).toContain("(repair placeholder)");
    });

    it("falls back to the LLM leg when the normalizer cannot resolve", async () => {
      const filePath = path.join(tmpDir, "TASK-002-unresolvable.md");
      fs.writeFileSync(filePath, UNRESOLVABLE_TASK);

      const onRepaired = jest.fn<void, [string, string, string[]]>();
      const repairFn = jest.fn().mockResolvedValue(UNRESOLVABLE_TASK_REPAIRED);

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepaired },
        { autoRepair: true, autoPreflight: false, repairFn },
      );

      await watcher.processFile(filePath);

      expect(repairFn).toHaveBeenCalledTimes(1);
      expect(onRepaired).toHaveBeenCalledTimes(1);
      const written = fs.readFileSync(filePath, "utf-8");
      expect(written).toContain("- **Status:** BLOCKED");
    });

    it("rejects an LLM repair that alters payload content (additive-only guard)", async () => {
      const filePath = path.join(tmpDir, "TASK-002-unresolvable.md");
      fs.writeFileSync(filePath, UNRESOLVABLE_TASK);

      const onRepairFailed = jest.fn<void, [string, string, string]>();
      const onRepaired = jest.fn<void, [string, string, string[]]>();
      // Fixes the envelope BUT also paraphrases the problem statement.
      const tampered = UNRESOLVABLE_TASK_REPAIRED.replace(
        "This task has a status value the normalizer cannot map.",
        "This task has an unusual status value.",
      );
      const repairFn = jest.fn().mockResolvedValue(tampered);

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepairFailed, onRepaired },
        { autoRepair: true, autoPreflight: false, repairFn },
      );

      await watcher.processFile(filePath);

      expect(onRepaired).not.toHaveBeenCalled();
      expect(onRepairFailed).toHaveBeenCalledTimes(1);
      expect(onRepairFailed).toHaveBeenCalledWith(
        "TASK-002",
        filePath,
        expect.stringContaining("additive-only guard"),
      );
      // The file must not be touched by a rejected repair.
      expect(fs.readFileSync(filePath, "utf-8")).toBe(UNRESOLVABLE_TASK);
    });

    it("rejects an LLM repair that fixes the envelope without gating (adversarial finding 7)", async () => {
      const filePath = path.join(tmpDir, "TASK-002-unresolvable.md");
      fs.writeFileSync(filePath, UNRESOLVABLE_TASK);

      const onRepairFailed = jest.fn<void, [string, string, string]>();
      const onRepaired = jest.fn<void, [string, string, string[]]>();
      // Guard-compatible (note present) but NO marker anywhere: the task
      // would become silently dispatchable.
      const ungated = UNRESOLVABLE_TASK.replace(
        "- **Status:** awaiting vendor sign-off",
        [
          "- **Status:** READY",
          '- **Status-Note:** original status "awaiting vendor sign-off"',
        ].join("\n"),
      );
      const repairFn = jest.fn().mockResolvedValue(ungated);

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepairFailed, onRepaired },
        { autoRepair: true, autoPreflight: false, repairFn },
      );

      await watcher.processFile(filePath);

      expect(onRepaired).not.toHaveBeenCalled();
      expect(onRepairFailed).toHaveBeenCalledWith(
        "TASK-002",
        filePath,
        expect.stringContaining("must leave the task gated"),
      );
      expect(fs.readFileSync(filePath, "utf-8")).toBe(UNRESOLVABLE_TASK);
    });

    it("repairMode 'deterministic' never invokes the LLM leg", async () => {
      const filePath = path.join(tmpDir, "TASK-002-unresolvable.md");
      fs.writeFileSync(filePath, UNRESOLVABLE_TASK);

      const onRepairFailed = jest.fn<void, [string, string, string]>();
      const onParseError = jest.fn<void, [string, string]>();
      const repairFn = jest.fn();

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepairFailed, onParseError },
        { repairMode: "deterministic", autoPreflight: false, repairFn },
      );

      await watcher.processFile(filePath);

      expect(repairFn).not.toHaveBeenCalled();
      expect(onRepairFailed).toHaveBeenCalledTimes(1);
      expect(onParseError).toHaveBeenCalledTimes(1);
      expect(fs.readFileSync(filePath, "utf-8")).toBe(UNRESOLVABLE_TASK);
    });

    it("calls onRepairFailed when repair produces unparseable output", async () => {
      const filePath = path.join(tmpDir, "TASK-002-broken.md");
      fs.writeFileSync(filePath, UNRESOLVABLE_TASK);

      const onRepairFailed = jest.fn<void, [string, string, string]>();
      const onParseError = jest.fn<void, [string, string]>();
      const repairFn = jest.fn().mockResolvedValue("this is not valid markdown task spec");

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepairFailed, onParseError },
        { autoRepair: true, autoPreflight: false, repairFn },
      );

      await watcher.processFile(filePath);

      expect(onRepairFailed).toHaveBeenCalledTimes(1);
      expect(onRepairFailed).toHaveBeenCalledWith("TASK-002", filePath, expect.any(String));
      expect(onParseError).toHaveBeenCalledTimes(1);
    });

    it("calls onRepairFailed when repair function throws", async () => {
      const filePath = path.join(tmpDir, "TASK-002-broken.md");
      fs.writeFileSync(filePath, UNRESOLVABLE_TASK);

      const onRepairFailed = jest.fn<void, [string, string, string]>();
      const onParseError = jest.fn<void, [string, string]>();
      const repairFn = jest.fn().mockRejectedValue(new Error("SDK error"));

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepairFailed, onParseError },
        { autoRepair: true, autoPreflight: false, repairFn },
      );

      await watcher.processFile(filePath);

      expect(onRepairFailed).toHaveBeenCalledTimes(1);
      expect(onParseError).toHaveBeenCalledTimes(1);
    });

    it("skips preflight for COMPLETE tasks", async () => {
      const filePath = path.join(tmpDir, "TASK-003-done.md");
      fs.writeFileSync(filePath, COMPLETE_TASK);

      const onNewTask = jest.fn<void, [ParsedTask, string]>();
      const onPreflightQueued = jest.fn<void, [string]>();
      const queuePreflight = jest.fn<void, [string]>();

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onNewTask, onPreflightQueued },
        { autoRepair: false, autoPreflight: true, queuePreflight },
      );

      await watcher.processFile(filePath);

      expect(onNewTask).toHaveBeenCalledTimes(1);
      expect(queuePreflight).not.toHaveBeenCalled();
      expect(onPreflightQueued).not.toHaveBeenCalled();
    });

    it("does not self-trigger preflight for a committed DECOMPOSED tracker", async () => {
      const filePath = path.join(tmpDir, "TASK-001-decomposed.md");
      fs.writeFileSync(filePath, DECOMPOSED_TASK);
      const onNewTask = jest.fn<void, [ParsedTask, string]>();
      const onPreflightQueued = jest.fn<void, [string]>();
      const onTerminalStatus = jest.fn();
      const queuePreflight = jest.fn<void, [string]>();
      const isPreflightCurrent = jest.fn();
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onNewTask, onPreflightQueued, onTerminalStatus },
        { autoRepair: false, autoPreflight: true, queuePreflight, isPreflightCurrent },
      );

      await watcher.processFile(filePath);

      expect(onNewTask).toHaveBeenCalledWith(
        expect.objectContaining({ id: "TASK-001", status: "DECOMPOSED" }),
        filePath,
      );
      expect(isPreflightCurrent).not.toHaveBeenCalled();
      expect(queuePreflight).not.toHaveBeenCalled();
      expect(onPreflightQueued).not.toHaveBeenCalled();
      expect(onTerminalStatus).not.toHaveBeenCalled();
    });

    it("queues preflight for non-complete tasks when cache is stale", async () => {
      const filePath = path.join(tmpDir, "TASK-001-test.md");
      fs.writeFileSync(filePath, VALID_TASK);

      const onPreflightQueued = jest.fn<void, [string]>();
      const queuePreflight = jest.fn<void, [string]>();
      const isPreflightCurrent = jest.fn().mockReturnValue(false);

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onPreflightQueued },
        { autoRepair: false, autoPreflight: true, queuePreflight, isPreflightCurrent },
      );

      await watcher.processFile(filePath);

      expect(queuePreflight).toHaveBeenCalledWith("TASK-001");
      expect(onPreflightQueued).toHaveBeenCalledWith("TASK-001");
    });

    it("skips preflight when cache is current", async () => {
      const filePath = path.join(tmpDir, "TASK-001-test.md");
      fs.writeFileSync(filePath, VALID_TASK);

      const onPreflightQueued = jest.fn<void, [string]>();
      const queuePreflight = jest.fn<void, [string]>();
      const isPreflightCurrent = jest.fn().mockReturnValue(true);

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onPreflightQueued },
        { autoRepair: false, autoPreflight: true, queuePreflight, isPreflightCurrent },
      );

      await watcher.processFile(filePath);

      expect(queuePreflight).not.toHaveBeenCalled();
      expect(onPreflightQueued).not.toHaveBeenCalled();
    });

    it("prevents concurrent processing of same file during async repair", async () => {
      const filePath = path.join(tmpDir, "TASK-002-broken.md");
      fs.writeFileSync(filePath, UNRESOLVABLE_TASK);

      const onRepaired = jest.fn<void, [string, string, string[]]>();
      const repairedContent = UNRESOLVABLE_TASK_REPAIRED;
      // Use a delayed repair function to simulate async work
      const repairFn = jest
        .fn()
        .mockImplementation(
          () => new Promise<string>((resolve) => setTimeout(() => resolve(repairedContent), 50)),
        );

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepaired },
        { autoRepair: true, autoPreflight: false, repairFn },
      );

      // Start two concurrent processes — second should be blocked by processing guard
      const p1 = watcher.processFile(filePath);
      const p2 = watcher.processFile(filePath);
      await Promise.all([p1, p2]);

      // Only one repair should have run (second was blocked while first was in-progress)
      expect(repairFn).toHaveBeenCalledTimes(1);
    });

    it("TASK-1345: deterministic promotion refuses an existing declared-id owner", async () => {
      const ownerName = "TASK-002-existing-owner.md";
      fs.writeFileSync(path.join(tmpDir, ownerName), taskSpec("TASK-002"));
      const filePath = path.join(tmpDir, "TASK-900-needs-normalization.md");
      fs.writeFileSync(filePath, INVALID_TASK);
      const onRepairFailed = jest.fn<void, [string, string, string]>();
      const onRepaired = jest.fn();
      const onNewTask = jest.fn();
      const queuePreflight = jest.fn();

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepairFailed, onRepaired, onNewTask },
        { repairMode: "deterministic", autoPreflight: true, queuePreflight },
      );
      await watcher.processFile(filePath);

      expect(fs.readFileSync(filePath, "utf-8")).toBe(INVALID_TASK);
      expect(onRepairFailed).toHaveBeenCalledWith(
        "TASK-002",
        filePath,
        expect.stringContaining(ownerName),
      );
      expect(onRepaired).not.toHaveBeenCalled();
      expect(onNewTask).not.toHaveBeenCalled();
      expect(queuePreflight).not.toHaveBeenCalled();
    });

    it("TASK-1345: LLM promotion refuses an existing declared-id owner", async () => {
      const ownerName = "TASK-002-existing-owner.md";
      fs.writeFileSync(path.join(tmpDir, ownerName), taskSpec("TASK-002"));
      const filePath = path.join(tmpDir, "TASK-901-needs-llm.md");
      fs.writeFileSync(filePath, UNRESOLVABLE_TASK);
      const onRepairFailed = jest.fn<void, [string, string, string]>();
      const onRepaired = jest.fn();
      const onNewTask = jest.fn();
      const queuePreflight = jest.fn();

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepairFailed, onRepaired, onNewTask },
        {
          repairMode: "full",
          autoPreflight: true,
          queuePreflight,
          repairFn: () => Promise.resolve(UNRESOLVABLE_TASK_REPAIRED),
        },
      );
      await watcher.processFile(filePath);

      expect(fs.readFileSync(filePath, "utf-8")).toBe(UNRESOLVABLE_TASK);
      expect(onRepairFailed).toHaveBeenCalledWith(
        "TASK-002",
        filePath,
        expect.stringContaining(ownerName),
      );
      expect(onRepaired).not.toHaveBeenCalled();
      expect(onNewTask).not.toHaveBeenCalled();
      expect(queuePreflight).not.toHaveBeenCalled();
    });

    it("TASK-1345: two concurrent promotions of one declared id admit exactly one", async () => {
      const firstPath = path.join(tmpDir, "TASK-900-first.md");
      const secondPath = path.join(tmpDir, "TASK-901-second.md");
      fs.writeFileSync(firstPath, INVALID_TASK);
      fs.writeFileSync(secondPath, INVALID_TASK);
      const firstRepaired = jest.fn();
      const secondRepaired = jest.fn();
      const firstFailed = jest.fn();
      const secondFailed = jest.fn();
      const first = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepaired: firstRepaired, onRepairFailed: firstFailed },
        { repairMode: "deterministic", autoPreflight: false },
      );
      const second = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepaired: secondRepaired, onRepairFailed: secondFailed },
        { repairMode: "deterministic", autoPreflight: false },
      );

      await Promise.all([first.processFile(firstPath), second.processFile(secondPath)]);

      expect(firstRepaired.mock.calls.length + secondRepaired.mock.calls.length).toBe(1);
      expect(firstFailed.mock.calls.length + secondFailed.mock.calls.length).toBe(1);
      const declarations = await listTaskClaimantDeclarations(tmpDir);
      expect(declarations.filter((item) => item.declaredId === "TASK-002")).toHaveLength(1);
      expect(
        [firstPath, secondPath].filter(
          (candidate) => fs.readFileSync(candidate, "utf-8") === INVALID_TASK,
        ),
      ).toHaveLength(1);
    });

    it("TASK-1345: planner and watcher racing one id admit exactly one creator", async () => {
      const filePath = path.join(tmpDir, "TASK-900-watcher-candidate.md");
      const watcherCandidate = INVALID_TASK.replace(/TASK-002/g, "TASK-700");
      fs.writeFileSync(filePath, watcherCandidate);
      const onRepaired = jest.fn();
      const onRepairFailed = jest.fn();
      const targetAdapter = {
        ...createMockAdapter(),
        projectRoot: tmpDir,
        config: {
          ...createMockAdapter().config,
          project: { name: "test-project", taskDir: "." },
          sandbox: {
            writablePaths: ["src/**"],
            deniedPaths: [],
            allowedBashPatterns: [],
            deniedBashPatterns: [],
          },
        },
      } as unknown as ProjectAdapter;
      const watcher = new TaskWatcher(
        tmpDir,
        targetAdapter,
        { onRepaired, onRepairFailed },
        { repairMode: "deterministic", autoPreflight: false },
      );

      await Promise.allSettled([
        watcher.processFile(filePath),
        writeTaskFiles(
          [{ id: "TASK-700", content: taskSpec("TASK-700", { title: "Planner candidate" }) }],
          targetAdapter,
        ),
      ]);

      const declarations = await listTaskClaimantDeclarations(tmpDir);
      expect(declarations.filter((item) => item.declaredId === "TASK-700")).toHaveLength(1);
      expect(onRepaired.mock.calls.length + onRepairFailed.mock.calls.length).toBe(1);
    });
  });

  describe("detectAddedSections", () => {
    it("detects sections added by the LLM repair leg", async () => {
      const filePath = path.join(tmpDir, "TASK-002-broken.md");
      // Unresolvable status (forces the LLM leg) AND missing Testing
      // Requirements (so the repair adds a section).
      const original = UNRESOLVABLE_TASK.replace(
        /\n## Testing Requirements\n- Something tested$/,
        "",
      );
      fs.writeFileSync(filePath, original);

      const repairedContent =
        original.replace(
          "- **Status:** awaiting vendor sign-off",
          [
            "- **Status:** BLOCKED",
            '- **Status-Note:** original status "awaiting vendor sign-off" needs a human call (repair placeholder); confirm',
          ].join("\n"),
        ) +
        "\n\n## Testing Requirements\n\n- [ ] TBD (repair placeholder): submitter must define real testing requirements\n";
      const onRepaired = jest.fn<void, [string, string, string[]]>();
      const repairFn = jest.fn().mockResolvedValue(repairedContent);

      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onRepaired },
        { autoRepair: true, autoPreflight: false, repairFn },
      );

      await watcher.processFile(filePath);

      // The onRepaired callback should receive the sectionsAdded
      expect(onRepaired).toHaveBeenCalledTimes(1);
      expect(onRepaired).toHaveBeenCalledWith(
        "TASK-002",
        filePath,
        expect.arrayContaining(["Testing Requirements"]),
      );
    });
  });

  describe("onTerminalStatus (TASK-914)", () => {
    const VERIFIED_TASK = COMPLETE_TASK.replace("Status:** COMPLETE", "Status:** VERIFIED");
    const REJECTED_TASK = COMPLETE_TASK.replace("Status:** COMPLETE", "Status:** REJECTED");

    it("fires onTerminalStatus when parsed spec status is COMPLETE", async () => {
      const filePath = path.join(tmpDir, "TASK-003-done.md");
      fs.writeFileSync(filePath, COMPLETE_TASK);

      const onTerminalStatus = jest.fn<
        void,
        [string, "COMPLETE" | "VERIFIED" | "REJECTED", string]
      >();
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onTerminalStatus },
        { autoRepair: false, autoPreflight: false },
      );

      await watcher.processFile(filePath);

      expect(onTerminalStatus).toHaveBeenCalledTimes(1);
      expect(onTerminalStatus).toHaveBeenCalledWith("TASK-003", "COMPLETE", filePath);
    });

    it("fires onTerminalStatus when parsed spec status is VERIFIED", async () => {
      const filePath = path.join(tmpDir, "TASK-003-verified.md");
      fs.writeFileSync(filePath, VERIFIED_TASK);

      const onTerminalStatus = jest.fn<
        void,
        [string, "COMPLETE" | "VERIFIED" | "REJECTED", string]
      >();
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onTerminalStatus },
        { autoRepair: false, autoPreflight: false },
      );

      await watcher.processFile(filePath);

      expect(onTerminalStatus).toHaveBeenCalledWith("TASK-003", "VERIFIED", filePath);
    });

    it("fires onTerminalStatus when parsed spec status is REJECTED", async () => {
      const filePath = path.join(tmpDir, "TASK-003-rejected.md");
      fs.writeFileSync(filePath, REJECTED_TASK);

      const onTerminalStatus = jest.fn<
        void,
        [string, "COMPLETE" | "VERIFIED" | "REJECTED", string]
      >();
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onTerminalStatus },
        { autoRepair: false, autoPreflight: false },
      );

      await watcher.processFile(filePath);

      expect(onTerminalStatus).toHaveBeenCalledWith("TASK-003", "REJECTED", filePath);
    });

    it("does NOT fire onTerminalStatus for non-terminal statuses (READY)", async () => {
      const filePath = path.join(tmpDir, "TASK-001-ready.md");
      fs.writeFileSync(filePath, VALID_TASK);

      const onTerminalStatus = jest.fn<
        void,
        [string, "COMPLETE" | "VERIFIED" | "REJECTED", string]
      >();
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onTerminalStatus },
        { autoRepair: false, autoPreflight: false },
      );

      await watcher.processFile(filePath);

      expect(onTerminalStatus).not.toHaveBeenCalled();
    });

    it("does NOT fire onTerminalStatus when parse fails", async () => {
      const filePath = path.join(tmpDir, "TASK-002-broken.md");
      fs.writeFileSync(filePath, INVALID_TASK);

      const onTerminalStatus = jest.fn<
        void,
        [string, "COMPLETE" | "VERIFIED" | "REJECTED", string]
      >();
      const onParseError = jest.fn<void, [string, string]>();
      const watcher = new TaskWatcher(
        tmpDir,
        createMockAdapter(),
        { onTerminalStatus, onParseError },
        { autoRepair: false, autoPreflight: false },
      );

      await watcher.processFile(filePath);

      expect(onParseError).toHaveBeenCalled();
      expect(onTerminalStatus).not.toHaveBeenCalled();
    });
  });
});
