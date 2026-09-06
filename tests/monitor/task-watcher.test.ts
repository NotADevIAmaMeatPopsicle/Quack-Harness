import * as fs from "node:fs";
import * as fsp from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { TaskWatcher } from "../../src/monitor/task-watcher";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { ParsedTask } from "../../src/core/types";

// ─── Helpers ──────────────────────────────────────────────────────

function createMockAdapter(): ProjectAdapter {
  return {
    config: {
      project: { name: "test-project", taskDir: "docs/tasks" },
      agent: {},
      verification: { commands: [] },
    },
    conventionsDoc: "Use TypeScript strict mode.",
    projectRoot: "/test/project",
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

// ─── Tests ────────────────────────────────────────────────────────

describe("TaskWatcher", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsp.mkdtemp(path.join(os.tmpdir(), "quack-tw-"));
  });

  afterEach(async () => {
    await fsp.rm(tmpDir, { recursive: true, force: true });
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
