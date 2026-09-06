import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import {
  buildRegistry,
  loadRegistry,
  saveRegistry,
  updateRegistry,
} from "../../src/templates/template-registry.js";
import {
  createDivergentTaskFixture,
  type FixtureCreationOrder,
} from "../helpers/divergent-task-fixture.js";

describe("template-registry", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "quack-template-test-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("buildRegistry", () => {
    it("should build registry from completed tasks", async () => {
      // Setup test task directory
      const tasksDir = path.join(tempDir, "docs", "tasks");
      await fs.mkdir(tasksDir, { recursive: true });

      // Create a completed task - copy from a real task file for guaranteed parsing
      const taskContent =
        "# TASK-001: Test Task\n\n## Metadata\n- **Priority:** P2-MEDIUM\n- **Effort:** 2-4 hours\n- **Status:** COMPLETE\n- **Tags:** dashboard, ui\n\n## Problem Statement\nAdd a new dashboard widget.\n\n## Current State\nNo widget exists.\n\n## Recommended Approach\nCreate widget component.\n\n## Files to Modify\n| File | Action | Notes |\n|------|--------|-------|\n| src/monitor/widget.ts | Create | Widget component |\n\n## Success Criteria\n- [ ] Widget renders\n\n## Testing Requirements\n- [ ] Unit tests pass\n";
      await fs.writeFile(path.join(tasksDir, "TASK-001.md"), taskContent, "utf-8");

      // Create session log
      const logsDir = path.join(tempDir, ".quack", "logs");
      await fs.mkdir(logsDir, { recursive: true });

      const sessionData = {
        taskId: "TASK-001",
        sessionId: "session-1",
        outcome: "approved",
        costUsd: 5.0,
        turnsUsed: 10,
        retriesUsed: 0,
        taskTags: ["dashboard", "ui"],
        targetFiles: ["src/monitor/widget.ts"],
        criteriaResults: [{ criterion: "Widget renders", status: "PASS" }],
        feedbackThemes: [],
        gateScore: 4.5,
        complexity: { filesToModify: 1, successCriteria: 1 },
      };
      await fs.writeFile(
        path.join(logsDir, "sessions.jsonl"),
        JSON.stringify(sessionData) + "\n",
        "utf-8",
      );

      // Build registry
      const registry = await buildRegistry(tempDir);

      expect(registry.templates.length).toBe(1);
      expect(registry.templates[0].sourceTaskId).toBe("TASK-001");
      expect(registry.templates[0].category).toBe("dashboard-feature");
      expect(registry.templates[0].successRate).toBe(1.0);
      expect(registry.templates[0].avgCostUsd).toBe(5.0);
    });

    it("should skip non-complete tasks", async () => {
      const tasksDir = path.join(tempDir, "docs", "tasks");
      await fs.mkdir(tasksDir, { recursive: true });

      const taskContent =
        "# TASK-002: Backlog Task\n\n## Metadata\n- **Priority:** P2-MEDIUM\n- **Effort:** 2-4 hours\n- **Status:** BACKLOG\n- **Tags:** api\n\n## Problem Statement\nAdd API endpoint.\n\n## Current State\nNot started.\n\n## Recommended Approach\nCreate endpoint.\n\n## Files to Modify\n| File | Action | Notes |\n|------|--------|-------|\n| src/api/handler.ts | Create | API handler |\n\n## Success Criteria\n- [ ] Endpoint works\n\n## Testing Requirements\n- [ ] Tests pass\n";
      await fs.writeFile(path.join(tasksDir, "TASK-002.md"), taskContent, "utf-8");

      const logsDir = path.join(tempDir, ".quack", "logs");
      await fs.mkdir(logsDir, { recursive: true });
      await fs.writeFile(path.join(logsDir, "sessions.jsonl"), "", "utf-8");

      const registry = await buildRegistry(tempDir);

      expect(registry.templates.length).toBe(0);
    });

    it("should calculate category stats correctly", async () => {
      const tasksDir = path.join(tempDir, "docs", "tasks");
      await fs.mkdir(tasksDir, { recursive: true });

      // Create two dashboard tasks
      for (let i = 1; i <= 2; i++) {
        const taskContent = `# TASK-00${i}: Dashboard Task ${i}\n\n## Metadata\n- **Priority:** P2-MEDIUM\n- **Effort:** 2-4 hours\n- **Status:** COMPLETE\n- **Tags:** dashboard\n\n## Problem Statement\nDashboard task.\n\n## Current State\nNone.\n\n## Recommended Approach\nImplement.\n\n## Files to Modify\n| File | Action | Notes |\n|------|--------|-------|\n| src/monitor/widget${i}.ts | Create | Widget |\n\n## Success Criteria\n- [ ] Done\n\n## Testing Requirements\n- [ ] Tests\n`;
        await fs.writeFile(path.join(tasksDir, `TASK-00${i}.md`), taskContent, "utf-8");
      }

      const logsDir = path.join(tempDir, ".quack", "logs");
      await fs.mkdir(logsDir, { recursive: true });

      const sessions = [
        {
          taskId: "TASK-001",
          sessionId: "s1",
          outcome: "approved",
          costUsd: 5.0,
          turnsUsed: 10,
          retriesUsed: 0,
          taskTags: ["dashboard"],
          targetFiles: [],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 4,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
        {
          taskId: "TASK-002",
          sessionId: "s2",
          outcome: "approved",
          costUsd: 3.0,
          turnsUsed: 8,
          retriesUsed: 0,
          taskTags: ["dashboard"],
          targetFiles: [],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 4,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
      ];
      await fs.writeFile(
        path.join(logsDir, "sessions.jsonl"),
        sessions.map((s) => JSON.stringify(s)).join("\n") + "\n",
        "utf-8",
      );

      const registry = await buildRegistry(tempDir);

      expect(registry.categoryStats["dashboard-feature"].count).toBe(2);
      expect(registry.categoryStats["dashboard-feature"].avgSuccessRate).toBe(1.0);
      expect(registry.categoryStats["dashboard-feature"].avgCostUsd).toBe(4.0);
    });
  });

  describe("loadRegistry", () => {
    it("should load registry from disk", async () => {
      const registryPath = path.join(tempDir, ".quack", "templates", "task-templates.json");
      await fs.mkdir(path.dirname(registryPath), { recursive: true });

      const registry = {
        updatedAt: "2024-01-01T00:00:00Z",
        templates: [
          {
            category: "testing" as const,
            sourceTaskId: "TASK-001",
            specTemplate: "Test template",
            successRate: 1.0,
            avgCostUsd: 2.0,
            filePatterns: ["tests/"],
            fileCount: 1,
            tags: ["testing"],
          },
        ],
        categoryStats: {
          "new-module": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          integration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "bug-fix": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          refactor: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "dashboard-feature": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "api-endpoint": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          testing: { count: 1, avgSuccessRate: 1.0, avgCostUsd: 2.0 },
          configuration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          infrastructure: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        },
      };
      await fs.writeFile(registryPath, JSON.stringify(registry, null, 2));

      const loaded = await loadRegistry(tempDir);

      expect(loaded.templates.length).toBe(1);
      expect(loaded.templates[0].sourceTaskId).toBe("TASK-001");
    });

    it("should return empty registry if file does not exist", async () => {
      const loaded = await loadRegistry(tempDir);

      expect(loaded.templates.length).toBe(0);
      expect(loaded.categoryStats["testing"].count).toBe(0);
    });
  });

  describe("saveRegistry", () => {
    it("should save registry to disk", async () => {
      const registry = {
        updatedAt: "2024-01-01T00:00:00Z",
        templates: [],
        categoryStats: {
          "new-module": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          integration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "bug-fix": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          refactor: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "dashboard-feature": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          "api-endpoint": { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          testing: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          configuration: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
          infrastructure: { count: 0, avgSuccessRate: 0, avgCostUsd: 0 },
        },
      };

      await saveRegistry(registry, tempDir);

      const registryPath = path.join(tempDir, ".quack", "templates", "task-templates.json");
      const content = await fs.readFile(registryPath, "utf-8");
      const loaded = JSON.parse(content) as { updatedAt: string };

      expect(loaded.updatedAt).toBe("2024-01-01T00:00:00Z");
    });
  });

  describe("updateRegistry", () => {
    it.each<FixtureCreationOrder>(["child-first", "parent-first"])(
      "resolves a descriptive completed parent when the divergent files were created %s",
      async (order) => {
        const fixture = createDivergentTaskFixture(order, {
          prefix: "quack-template-registry-selection-",
          parent: {
            title: "Completed parent template",
            status: "COMPLETE",
            tags: ["parent-template"],
            targetFiles: ["src/parent/widget.ts"],
          },
          child: {
            title: "Completed child template",
            status: "COMPLETE",
            tags: ["child-template"],
            targetFiles: ["src/child/widget.ts"],
          },
        });
        try {
          const logsDir = path.join(fixture.root, ".quack", "logs");
          await fs.mkdir(logsDir, { recursive: true });
          const session = {
            taskId: "TASK-100",
            sessionId: "parent-session",
            outcome: "approved",
            costUsd: 2,
            turnsUsed: 4,
            retriesUsed: 0,
            taskTags: ["parent-template"],
            targetFiles: ["src/parent/widget.ts"],
            criteriaResults: [],
            feedbackThemes: [],
            gateScore: 5,
            complexity: { filesToModify: 1, successCriteria: 1 },
          };
          await fs.writeFile(
            path.join(logsDir, "sessions.jsonl"),
            `${JSON.stringify(session)}\n`,
            "utf-8",
          );

          await updateRegistry(fixture.root, "TASK-100");

          const registry = await loadRegistry(fixture.root);
          expect(registry.templates).toHaveLength(1);
          expect(registry.templates[0]).toMatchObject({
            sourceTaskId: "TASK-100",
            tags: ["parent-template"],
          });
          expect(registry.templates[0].tags).not.toContain("child-template");
        } finally {
          fixture.cleanup();
        }
      },
    );

    it("should incrementally add a new task to an existing registry", async () => {
      // Setup: create a pre-existing registry with one template
      const tasksDir = path.join(tempDir, "docs", "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      const logsDir = path.join(tempDir, ".quack", "logs");
      await fs.mkdir(logsDir, { recursive: true });

      // Create two completed tasks
      const task1Content =
        "# TASK-001: Dashboard Widget\n\n## Metadata\n- **Priority:** P2-MEDIUM\n- **Effort:** 2-4 hours\n- **Status:** COMPLETE\n- **Tags:** dashboard, ui\n\n## Problem Statement\nAdd widget.\n\n## Current State\nNone.\n\n## Recommended Approach\nCreate it.\n\n## Files to Modify\n| File | Action | Notes |\n|------|--------|-------|\n| src/monitor/widget.ts | Create | Widget |\n\n## Success Criteria\n- [ ] Widget renders\n\n## Testing Requirements\n- [ ] Tests pass\n";
      const task2Content =
        "# TASK-002: API Endpoint\n\n## Metadata\n- **Priority:** P2-MEDIUM\n- **Effort:** 2-4 hours\n- **Status:** COMPLETE\n- **Tags:** api, backend\n\n## Problem Statement\nAdd endpoint.\n\n## Current State\nNone.\n\n## Recommended Approach\nCreate it.\n\n## Files to Modify\n| File | Action | Notes |\n|------|--------|-------|\n| src/api/handler.ts | Create | Handler |\n\n## Success Criteria\n- [ ] Endpoint works\n\n## Testing Requirements\n- [ ] Tests pass\n";
      await fs.writeFile(path.join(tasksDir, "TASK-001.md"), task1Content, "utf-8");
      await fs.writeFile(path.join(tasksDir, "TASK-002.md"), task2Content, "utf-8");

      // Session logs for both tasks
      const sessions = [
        {
          taskId: "TASK-001",
          sessionId: "s1",
          outcome: "approved",
          costUsd: 5.0,
          turnsUsed: 10,
          retriesUsed: 0,
          taskTags: ["dashboard"],
          targetFiles: [],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 4,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
        {
          taskId: "TASK-002",
          sessionId: "s2",
          outcome: "approved",
          costUsd: 3.0,
          turnsUsed: 8,
          retriesUsed: 0,
          taskTags: ["api"],
          targetFiles: [],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 4,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
      ];
      await fs.writeFile(
        path.join(logsDir, "sessions.jsonl"),
        sessions.map((s) => JSON.stringify(s)).join("\n") + "\n",
        "utf-8",
      );

      // Build initial registry with just TASK-001
      const initialRegistry = await buildRegistry(tempDir);
      // Verify it has both tasks from full build
      expect(initialRegistry.templates.length).toBe(2);

      // Now save a registry with only TASK-001 to simulate pre-existing state
      const preExistingRegistry = {
        ...initialRegistry,
        templates: initialRegistry.templates.filter((t) => t.sourceTaskId === "TASK-001"),
      };
      // Recalc stats for 1 template only
      preExistingRegistry.categoryStats["api-endpoint"] = {
        count: 0,
        avgSuccessRate: 0,
        avgCostUsd: 0,
      };
      preExistingRegistry.categoryStats["dashboard-feature"] = {
        count: 1,
        avgSuccessRate: 1.0,
        avgCostUsd: 5.0,
      };
      await saveRegistry(preExistingRegistry, tempDir);

      // Verify pre-existing has 1 template
      const before = await loadRegistry(tempDir);
      expect(before.templates.length).toBe(1);
      expect(before.templates[0].sourceTaskId).toBe("TASK-001");

      // Incrementally add TASK-002
      await updateRegistry(tempDir, "TASK-002");

      // Verify: now has 2 templates
      const after = await loadRegistry(tempDir);
      expect(after.templates.length).toBe(2);
      expect(after.templates.map((t) => t.sourceTaskId).sort()).toEqual(["TASK-001", "TASK-002"]);
      expect(after.categoryStats["api-endpoint"].count).toBe(1);
      expect(after.categoryStats["dashboard-feature"].count).toBe(1);
    });

    it("should replace existing template when updating same task", async () => {
      const tasksDir = path.join(tempDir, "docs", "tasks");
      await fs.mkdir(tasksDir, { recursive: true });
      const logsDir = path.join(tempDir, ".quack", "logs");
      await fs.mkdir(logsDir, { recursive: true });

      const taskContent =
        "# TASK-001: Dashboard Widget\n\n## Metadata\n- **Priority:** P2-MEDIUM\n- **Effort:** 2-4 hours\n- **Status:** COMPLETE\n- **Tags:** dashboard\n\n## Problem Statement\nAdd widget.\n\n## Current State\nNone.\n\n## Recommended Approach\nCreate it.\n\n## Files to Modify\n| File | Action | Notes |\n|------|--------|-------|\n| src/monitor/widget.ts | Create | Widget |\n\n## Success Criteria\n- [ ] Done\n\n## Testing Requirements\n- [ ] Tests\n";
      await fs.writeFile(path.join(tasksDir, "TASK-001.md"), taskContent, "utf-8");

      // Two sessions: first rejected, second approved
      const sessions = [
        {
          taskId: "TASK-001",
          sessionId: "s1",
          outcome: "rejected",
          costUsd: 5.0,
          turnsUsed: 10,
          retriesUsed: 0,
          taskTags: ["dashboard"],
          targetFiles: [],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 4,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
        {
          taskId: "TASK-001",
          sessionId: "s2",
          outcome: "approved",
          costUsd: 3.0,
          turnsUsed: 8,
          retriesUsed: 0,
          taskTags: ["dashboard"],
          targetFiles: [],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 4,
          complexity: { filesToModify: 1, successCriteria: 1 },
        },
      ];
      await fs.writeFile(
        path.join(logsDir, "sessions.jsonl"),
        sessions.map((s) => JSON.stringify(s)).join("\n") + "\n",
        "utf-8",
      );

      // Build initial registry
      const initial = await buildRegistry(tempDir);
      await saveRegistry(initial, tempDir);
      expect(initial.templates.length).toBe(1);
      expect(initial.templates[0].successRate).toBe(0.5); // 1/2

      // Update the same task — should replace, not duplicate
      await updateRegistry(tempDir, "TASK-001");

      const updated = await loadRegistry(tempDir);
      expect(updated.templates.length).toBe(1); // Still 1, not 2
      expect(updated.templates[0].sourceTaskId).toBe("TASK-001");
    });
  });
});
