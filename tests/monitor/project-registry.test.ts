import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  ProjectRegistry,
  buildProjectContext,
  generateProjectId,
  teardownProjectContext,
} from "../../src/monitor/project-registry";
import { EventReader } from "../../src/monitor/event-reader";
import { EventWriter } from "../../src/monitor/event-emitter";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";

// ─── Helpers ─────────────────────────────────────────────────────

function makeMinimalAdapter(name: string, rootPath: string): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0.0",
    project: {
      name,
      root: rootPath,
      taskDir: "docs/tasks",
      conventionsDir: ".quack",
    },
    agent: {
      model: "claude-opus-4-20250514",
      judgeModel: "claude-sonnet-4-20250514",
      enrichModel: "claude-sonnet-4-20250514",
      maxTurns: 30,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: {
      commands: [],
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: [],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      branchPrefix: "quack",
      baseBranch: "main",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Automated-By: Quack",
      autoCreatePr: false,
      autoPush: false,
    },
    logging: {
      dir: ".quack/logs",
      level: "info",
      retainDays: 30,
    },
  };

  return {
    projectRoot: rootPath,
    config,
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("ProjectRegistry", () => {
  describe("generateProjectId", () => {
    it("converts project name to slug", () => {
      expect(generateProjectId("My Project")).toBe("my-project");
      expect(generateProjectId("Quack Agent")).toBe("quack-agent");
      expect(generateProjectId("Space  Shooter")).toBe("space-shooter");
    });

    it("handles special characters", () => {
      expect(generateProjectId("Project-Name_123")).toBe("project-name-123");
      expect(generateProjectId("Project@#$%Name")).toBe("project-name");
    });

    it("trims leading/trailing hyphens", () => {
      expect(generateProjectId("-project-")).toBe("project");
      expect(generateProjectId("___project___")).toBe("project");
    });

    it("handles empty strings", () => {
      expect(generateProjectId("")).toBe("");
      expect(generateProjectId("   ")).toBe("");
    });
  });

  describe("buildProjectContext DB state", () => {
    it("records healthy sqlite state when the project DB opens", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-project-db-ok-"));
      try {
        fs.mkdirSync(path.join(root, ".quack", "logs"), { recursive: true });
        fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });

        const context = buildProjectContext(
          makeMinimalAdapter("Healthy Project", root),
          "/fake/quack.js",
        );

        expect(context.dbState).toMatchObject({
          degraded: false,
          mode: "sqlite",
          dbPath: path.join(root, ".quack", "quack.db"),
        });

        teardownProjectContext(context);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });

    it("records degraded noop state when the project DB cannot open", () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-project-db-bad-"));
      try {
        fs.mkdirSync(path.join(root, "docs", "tasks"), { recursive: true });

        const context = buildProjectContext(
          makeMinimalAdapter("Broken Project", root),
          "/fake/quack.js",
        );

        expect(context.dbState?.degraded).toBe(true);
        expect(context.dbState?.mode).toBe("noop");
        expect(context.dbState?.dbPath).toBe(path.join(root, ".quack", "quack.db"));
        expect(context.dbState?.error).toBeTruthy();

        teardownProjectContext(context);
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe("register and get", () => {
    it("registers and retrieves a project", () => {
      const registry = new ProjectRegistry();
      const adapter = makeMinimalAdapter("Test Project", "/tmp/test");

      const context = {
        id: generateProjectId(adapter.config.project.name),
        name: adapter.config.project.name,
        rootPath: adapter.projectRoot,
        logDir: "/tmp/test/.quack/logs",
        adapter,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      registry.register(context);

      const retrieved = registry.getProject("test-project");
      expect(retrieved).toBeDefined();
      expect(retrieved?.name).toBe("Test Project");
      expect(retrieved?.rootPath).toBe("/tmp/test");
    });

    it("throws error when registering duplicate project ID", () => {
      const registry = new ProjectRegistry();
      const adapter = makeMinimalAdapter("Test Project", "/tmp/test");

      const context = {
        id: "test-project",
        name: "Test Project",
        rootPath: "/tmp/test",
        logDir: "/tmp/test/.quack/logs",
        adapter,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      registry.register(context);

      expect(() => registry.register(context)).toThrow("already registered");
    });

    it("returns undefined for non-existent project", () => {
      const registry = new ProjectRegistry();
      expect(registry.getProject("nonexistent")).toBeUndefined();
    });
  });

  describe("listProjects", () => {
    it("returns empty array when no projects registered", () => {
      const registry = new ProjectRegistry();
      expect(registry.listProjects()).toEqual([]);
    });

    it("returns all registered projects", () => {
      const registry = new ProjectRegistry();
      const adapter1 = makeMinimalAdapter("Project One", "/tmp/p1");
      const adapter2 = makeMinimalAdapter("Project Two", "/tmp/p2");

      const context1 = {
        id: generateProjectId(adapter1.config.project.name),
        name: adapter1.config.project.name,
        rootPath: adapter1.projectRoot,
        logDir: "/tmp/p1/.quack/logs",
        adapter: adapter1,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      const context2 = {
        id: generateProjectId(adapter2.config.project.name),
        name: adapter2.config.project.name,
        rootPath: adapter2.projectRoot,
        logDir: "/tmp/p2/.quack/logs",
        adapter: adapter2,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      registry.register(context1);
      registry.register(context2);

      const projects = registry.listProjects();
      expect(projects).toHaveLength(2);
      expect(projects.map((p) => p.name)).toEqual(["Project One", "Project Two"]);
    });
  });

  describe("active project management", () => {
    it("sets first registered project as active", () => {
      const registry = new ProjectRegistry();
      const adapter = makeMinimalAdapter("Test Project", "/tmp/test");

      const context = {
        id: "test-project",
        name: "Test Project",
        rootPath: "/tmp/test",
        logDir: "/tmp/test/.quack/logs",
        adapter,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      registry.register(context);

      expect(registry.getActiveProjectId()).toBe("test-project");
      expect(registry.getActiveProject()?.name).toBe("Test Project");
    });

    it("switches active project", () => {
      const registry = new ProjectRegistry();
      const adapter1 = makeMinimalAdapter("Project One", "/tmp/p1");
      const adapter2 = makeMinimalAdapter("Project Two", "/tmp/p2");

      const context1 = {
        id: "project-one",
        name: "Project One",
        rootPath: "/tmp/p1",
        logDir: "/tmp/p1/.quack/logs",
        adapter: adapter1,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      const context2 = {
        id: "project-two",
        name: "Project Two",
        rootPath: "/tmp/p2",
        logDir: "/tmp/p2/.quack/logs",
        adapter: adapter2,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      registry.register(context1);
      registry.register(context2);

      expect(registry.getActiveProjectId()).toBe("project-one");

      registry.setActiveProject("project-two");
      expect(registry.getActiveProjectId()).toBe("project-two");
      expect(registry.getActiveProject()?.name).toBe("Project Two");
    });

    it("throws error when setting non-existent project as active", () => {
      const registry = new ProjectRegistry();
      expect(() => registry.setActiveProject("nonexistent")).toThrow("not found");
    });

    it("returns undefined when no active project", () => {
      const registry = new ProjectRegistry();
      expect(registry.getActiveProject()).toBeUndefined();
      expect(registry.getActiveProjectId()).toBeNull();
    });
  });

  describe("hasProject and count", () => {
    it("checks project existence", () => {
      const registry = new ProjectRegistry();
      const adapter = makeMinimalAdapter("Test Project", "/tmp/test");

      const context = {
        id: "test-project",
        name: "Test Project",
        rootPath: "/tmp/test",
        logDir: "/tmp/test/.quack/logs",
        adapter,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      expect(registry.hasProject("test-project")).toBe(false);

      registry.register(context);

      expect(registry.hasProject("test-project")).toBe(true);
      expect(registry.hasProject("nonexistent")).toBe(false);
    });

    it("returns correct project count", () => {
      const registry = new ProjectRegistry();
      expect(registry.count()).toBe(0);

      const adapter1 = makeMinimalAdapter("Project One", "/tmp/p1");
      const context1 = {
        id: "project-one",
        name: "Project One",
        rootPath: "/tmp/p1",
        logDir: "/tmp/p1/.quack/logs",
        adapter: adapter1,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      registry.register(context1);
      expect(registry.count()).toBe(1);

      const adapter2 = makeMinimalAdapter("Project Two", "/tmp/p2");
      const context2 = {
        id: "project-two",
        name: "Project Two",
        rootPath: "/tmp/p2",
        logDir: "/tmp/p2/.quack/logs",
        adapter: adapter2,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      registry.register(context2);
      expect(registry.count()).toBe(2);
    });
  });

  describe("project isolation", () => {
    let tmpDir: string;
    let logDirA: string;
    let logDirB: string;

    beforeEach(() => {
      tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-isolation-"));
      logDirA = path.join(tmpDir, "projectA", ".quack", "logs");
      logDirB = path.join(tmpDir, "projectB", ".quack", "logs");
      fs.mkdirSync(logDirA, { recursive: true });
      fs.mkdirSync(logDirB, { recursive: true });
    });

    afterEach(() => {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    });

    it("EventReader instances are isolated — events in Project A are not visible in Project B", () => {
      const readerA = new EventReader(logDirA);
      const readerB = new EventReader(logDirB);

      // Write a session event to Project A's log directory
      const writer = new EventWriter({
        sessionId: "session-001",
        taskId: "TASK-001",
        project: "project-a",
        logDir: logDirA,
      });
      writer.recordSession("active");
      writer.emit("session_start", {
        taskId: "TASK-001",
        model: "test-model",
        maxTurns: 10,
        maxBudget: 5.0,
      });

      // Project A should see the session
      const sessionsA = readerA.getAllSessions();
      expect(sessionsA).toHaveLength(1);
      expect(sessionsA[0].taskId).toBe("TASK-001");
      expect(sessionsA[0].project).toBe("project-a");

      // Project B should NOT see Project A's session
      const sessionsB = readerB.getAllSessions();
      expect(sessionsB).toHaveLength(0);

      // Project A should have events, Project B should not
      const eventsA = readerA.getSessionEvents("session-001");
      expect(eventsA).toHaveLength(1);
      expect(eventsA[0].stage).toBe("session_start");

      const eventsB = readerB.getSessionEvents("session-001");
      expect(eventsB).toHaveLength(0);
    });

    it("multiple projects in a registry have fully isolated event readers", () => {
      const registry = new ProjectRegistry();

      const adapterA = makeMinimalAdapter("Project Alpha", path.join(tmpDir, "projectA"));
      const adapterB = makeMinimalAdapter("Project Beta", path.join(tmpDir, "projectB"));

      const contextA = {
        id: generateProjectId(adapterA.config.project.name),
        name: adapterA.config.project.name,
        rootPath: adapterA.projectRoot,
        logDir: logDirA,
        adapter: adapterA,
        eventReader: new EventReader(logDirA),
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      const contextB = {
        id: generateProjectId(adapterB.config.project.name),
        name: adapterB.config.project.name,
        rootPath: adapterB.projectRoot,
        logDir: logDirB,
        adapter: adapterB,
        eventReader: new EventReader(logDirB),
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      registry.register(contextA);
      registry.register(contextB);

      // Write events to Project Alpha's log directory
      const writerA = new EventWriter({
        sessionId: "alpha-session",
        taskId: "TASK-ALPHA",
        project: contextA.id,
        logDir: logDirA,
      });
      writerA.recordSession("completed", { outcome: "approved", totalCostUsd: 1.5 });
      writerA.emit("session_start", {
        taskId: "TASK-ALPHA",
        model: "test-model",
        maxTurns: 10,
        maxBudget: 5.0,
      });

      // Write different events to Project Beta's log directory
      const writerB = new EventWriter({
        sessionId: "beta-session",
        taskId: "TASK-BETA",
        project: contextB.id,
        logDir: logDirB,
      });
      writerB.recordSession("active");

      // Verify isolation through the registry
      const projectAlpha = registry.getProject("project-alpha")!;
      const projectBeta = registry.getProject("project-beta")!;

      const alphaSessions = projectAlpha.eventReader.getAllSessions();
      expect(alphaSessions).toHaveLength(1);
      expect(alphaSessions[0].taskId).toBe("TASK-ALPHA");
      expect(alphaSessions[0].outcome).toBe("approved");

      const betaSessions = projectBeta.eventReader.getAllSessions();
      expect(betaSessions).toHaveLength(1);
      expect(betaSessions[0].taskId).toBe("TASK-BETA");
      expect(betaSessions[0].outcome).toBeUndefined();

      // Cross-check: Alpha shouldn't see Beta's session and vice versa
      const alphaEvents = projectAlpha.eventReader.getSessionEvents("beta-session");
      expect(alphaEvents).toHaveLength(0);

      const betaEvents = projectBeta.eventReader.getSessionEvents("alpha-session");
      expect(betaEvents).toHaveLength(0);
    });

    it("dispatch managers are separate instances per project", () => {
      const registry = new ProjectRegistry();

      const adapterA = makeMinimalAdapter("Dispatch A", path.join(tmpDir, "projectA"));
      const adapterB = makeMinimalAdapter("Dispatch B", path.join(tmpDir, "projectB"));

      // Create minimal contexts with separate dispatch managers
      const contextA = {
        id: generateProjectId(adapterA.config.project.name),
        name: adapterA.config.project.name,
        rootPath: adapterA.projectRoot,
        logDir: logDirA,
        adapter: adapterA,
        eventReader: new EventReader(logDirA),
        dispatchManager: { getActiveJobs: () => [{ taskId: "TASK-A-001" }] } as never,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      const contextB = {
        id: generateProjectId(adapterB.config.project.name),
        name: adapterB.config.project.name,
        rootPath: adapterB.projectRoot,
        logDir: logDirB,
        adapter: adapterB,
        eventReader: new EventReader(logDirB),
        dispatchManager: { getActiveJobs: () => [] } as never,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      registry.register(contextA);
      registry.register(contextB);

      // Dispatch A has one active job, Dispatch B has none
      const pA = registry.getProject("dispatch-a")!;
      const pB = registry.getProject("dispatch-b")!;

      expect(pA.dispatchManager!.getActiveJobs()).toHaveLength(1);
      expect(pB.dispatchManager!.getActiveJobs()).toHaveLength(0);

      // They are different instances
      expect(pA.dispatchManager).not.toBe(pB.dispatchManager);
    });

    it("broadcasts each dynamic project root to every existing Docker manager", () => {
      const registry = new ProjectRegistry();
      const rootA = path.join(tmpDir, "projectA");
      const rootB = path.join(tmpDir, "projectB");
      const adapterA = makeMinimalAdapter("Docker A", rootA);
      const adapterB = makeMinimalAdapter("Docker B", rootB);
      const updateA = jest.fn();
      const updateB = jest.fn();
      const contextFor = (
        id: string,
        rootPath: string,
        adapter: ProjectAdapter,
        update: jest.Mock,
      ) => ({
        id,
        name: adapter.config.project.name,
        rootPath,
        logDir: path.join(rootPath, ".quack", "logs"),
        adapter,
        eventReader: {} as EventReader,
        dispatchManager: { setDockerRegisteredProjectRoots: update } as never,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      });

      registry.register(contextFor("docker-a", rootA, adapterA, updateA));
      registry.register(contextFor("docker-b", rootB, adapterB, updateB));

      expect(updateA).toHaveBeenLastCalledWith([rootA, rootB]);
      expect(updateB).toHaveBeenLastCalledWith([rootA, rootB]);

      registry.unregister("docker-b");
      expect(updateA).toHaveBeenLastCalledWith([rootA]);
    });
  });

  describe("unregister", () => {
    it("removes a project from the registry", () => {
      const registry = new ProjectRegistry();
      const adapter = makeMinimalAdapter("Test Project", "/tmp/test");

      const context = {
        id: "test-project",
        name: "Test Project",
        rootPath: "/tmp/test",
        logDir: "/tmp/test/.quack/logs",
        adapter,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      registry.register(context);
      expect(registry.count()).toBe(1);

      const removed = registry.unregister("test-project");
      expect(removed).toBeDefined();
      expect(removed?.name).toBe("Test Project");
      expect(registry.count()).toBe(0);
      expect(registry.getProject("test-project")).toBeUndefined();
    });

    it("returns undefined when unregistering non-existent project", () => {
      const registry = new ProjectRegistry();
      const removed = registry.unregister("nonexistent");
      expect(removed).toBeUndefined();
    });

    it("switches active project when removing the active one", () => {
      const registry = new ProjectRegistry();
      const adapter1 = makeMinimalAdapter("Project One", "/tmp/p1");
      const adapter2 = makeMinimalAdapter("Project Two", "/tmp/p2");

      const context1 = {
        id: "project-one",
        name: "Project One",
        rootPath: "/tmp/p1",
        logDir: "/tmp/p1/.quack/logs",
        adapter: adapter1,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      const context2 = {
        id: "project-two",
        name: "Project Two",
        rootPath: "/tmp/p2",
        logDir: "/tmp/p2/.quack/logs",
        adapter: adapter2,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      registry.register(context1);
      registry.register(context2);

      // Project One is active by default
      expect(registry.getActiveProjectId()).toBe("project-one");

      // Remove active project
      registry.unregister("project-one");

      // Active project should switch to Project Two
      expect(registry.getActiveProjectId()).toBe("project-two");
      expect(registry.getActiveProject()?.name).toBe("Project Two");
    });

    it("sets active project to null when removing the last project", () => {
      const registry = new ProjectRegistry();
      const adapter = makeMinimalAdapter("Test Project", "/tmp/test");

      const context = {
        id: "test-project",
        name: "Test Project",
        rootPath: "/tmp/test",
        logDir: "/tmp/test/.quack/logs",
        adapter,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: {} as never,
        dispatchQueue: null,
        keyManager: null,
        db: { close: jest.fn() } as never,
      };

      registry.register(context);
      expect(registry.getActiveProjectId()).toBe("test-project");

      registry.unregister("test-project");
      expect(registry.getActiveProjectId()).toBeNull();
      expect(registry.getActiveProject()).toBeUndefined();
    });
  });

  describe("teardownProjectContext", () => {
    it("calls all cleanup functions on a project context", () => {
      const stopWatcher = jest.fn();
      const stopChecking = jest.fn();
      const stopQueue = jest.fn();
      const stopScheduler = jest.fn();

      const adapter = makeMinimalAdapter("Test Project", "/tmp/test");
      const dbClose = jest.fn();
      const context = {
        id: "test-project",
        name: "Test Project",
        rootPath: "/tmp/test",
        logDir: "/tmp/test/.quack/logs",
        adapter,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: { stop: stopScheduler } as never,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: { stopChecking } as never,
        dispatchQueue: { stop: stopQueue } as never,
        keyManager: null,
        stopWatcher,
        db: { close: dbClose } as never,
      };

      teardownProjectContext(context);

      expect(stopWatcher).toHaveBeenCalledTimes(1);
      expect(stopChecking).toHaveBeenCalledTimes(1);
      expect(stopQueue).toHaveBeenCalledTimes(1);
      expect(stopScheduler).toHaveBeenCalledTimes(1);
      expect(dbClose).toHaveBeenCalledTimes(1);
    });

    it("handles undefined optional services gracefully", () => {
      const stopChecking = jest.fn();
      const adapter = makeMinimalAdapter("Test Project", "/tmp/test");

      const context = {
        id: "test-project",
        name: "Test Project",
        rootPath: "/tmp/test",
        logDir: "/tmp/test/.quack/logs",
        adapter,
        eventReader: {} as never,
        dispatchManager: null,
        taskService: null,
        prepCache: null,
        prepWorker: null,
        prepScheduler: null,
        fleetController: null,
        costVelocityTracker: {} as never,
        progressDetector: { stopChecking } as never,
        dispatchQueue: null,
        keyManager: null,
        stopWatcher: undefined,
        db: { close: jest.fn() } as never,
      };

      // Should not throw when optional services are null/undefined
      expect(() => teardownProjectContext(context)).not.toThrow();
      expect(stopChecking).toHaveBeenCalledTimes(1);
    });
  });
});
