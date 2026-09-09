// ─── Project Registry ──────────────────────────────────────────────
// Manages multiple project contexts in a single monitor instance.
// Each project has its own adapter, event reader, dispatch manager, etc.

import * as path from "node:path";
import { EventReader } from "./event-reader.js";
import { DispatchManager } from "./dispatch-manager.js";
import { PrepCache } from "./prep-cache.js";
import { PrepWorker } from "./prep-worker.js";
import { PrepScheduler } from "./prep-scheduler.js";
import { FleetController } from "../dispatcher/fleet-controller.js";
import { CostVelocityTracker } from "../dispatcher/cost-velocity.js";
import { ProgressDetector } from "./progress-detector.js";
import { TaskService } from "./task-service.js";
import { listDuplicateClaimants } from "../core/task-file-resolver.js";
import { DispatchQueue } from "../queue/index.js";
import { KeyManager } from "../dispatcher/key-manager.js";
import { QuackDB, NoopDB } from "../db/index.js";
import { ReadinessService } from "./readiness-service.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { DispatchEventCallback } from "./dispatch-manager.js";

export interface ProjectDbState {
  dbPath: string;
  mode: "sqlite" | "noop";
  degraded: boolean;
  error?: string;
}

/**
 * A single project context with all its associated services.
 */
export interface ProjectContext {
  /** Unique project identifier (slug from project name) */
  id: string;
  /** Human-readable project name */
  name: string;
  /** Absolute path to project root */
  rootPath: string;
  /** Absolute path to .quack/logs */
  logDir: string;
  /** Project adapter config */
  adapter: ProjectAdapter;
  /** Event reader for this project's logs */
  eventReader: EventReader;
  /** Dispatch manager (if available) */
  dispatchManager: DispatchManager | null;
  /** Task service (if available) */
  taskService: TaskService | null;
  /** Prep cache (if available) */
  prepCache: PrepCache | null;
  /** Prep worker (if available) */
  prepWorker: PrepWorker | null;
  /** Prep scheduler (if available) */
  prepScheduler: PrepScheduler | null;
  /** Fleet controller (if available) */
  fleetController: FleetController | null;
  /** Cost velocity tracker */
  costVelocityTracker: CostVelocityTracker;
  /** Progress detector (stuck agent detection) */
  progressDetector: ProgressDetector;
  /** Dispatch queue (if available) */
  dispatchQueue: DispatchQueue | null;
  /** API key manager (if configured) */
  keyManager: KeyManager | null;
  /** Cleanup function to stop the chokidar event watcher */
  stopWatcher?: () => void;
  /** Task file watcher (auto-discovery + repair + preflight) */
  taskWatcher?: { close: () => Promise<void> } | null;
  /** SQLite database for runtime state (NoopDB if native module unavailable) */
  db: QuackDB | NoopDB;
  /** Health metadata for the runtime DB backing this project. */
  dbState?: ProjectDbState;
}

/**
 * Registry managing multiple project contexts.
 */
export class ProjectRegistry {
  private projects = new Map<string, ProjectContext>();
  private activeProjectId: string | null = null;

  /**
   * Register a new project context.
   * @param context Project context to register
   * @throws Error if a project with the same ID is already registered
   */
  register(context: ProjectContext): void {
    if (this.projects.has(context.id)) {
      throw new Error(`Project ${context.id} is already registered`);
    }
    this.projects.set(context.id, context);

    // Set as active if it's the first project
    if (this.activeProjectId === null) {
      this.activeProjectId = context.id;
    }
  }

  /**
   * Unregister a project.
   * @param id Project ID
   * @returns Removed project context or undefined if not found
   */
  unregister(id: string): ProjectContext | undefined {
    const context = this.projects.get(id);
    if (!context) return undefined;
    this.projects.delete(id);
    // Switch active project if we're removing the active one
    if (this.activeProjectId === id) {
      const remaining = [...this.projects.keys()];
      this.activeProjectId = remaining.length > 0 ? remaining[0] : null;
    }
    return context;
  }

  /**
   * Get a project by ID.
   * @param id Project ID
   * @returns Project context or undefined if not found
   */
  getProject(id: string): ProjectContext | undefined {
    return this.projects.get(id);
  }

  /**
   * List all registered projects.
   * @returns Array of all project contexts
   */
  listProjects(): ProjectContext[] {
    return Array.from(this.projects.values());
  }

  /**
   * Get the currently active project.
   * @returns Active project context or undefined if no active project
   */
  getActiveProject(): ProjectContext | undefined {
    if (this.activeProjectId === null) {
      return undefined;
    }
    return this.projects.get(this.activeProjectId);
  }

  /**
   * Set the active project.
   * @param id Project ID to set as active
   * @throws Error if project ID is not registered
   */
  setActiveProject(id: string): void {
    if (!this.projects.has(id)) {
      throw new Error(`Project ${id} not found`);
    }
    this.activeProjectId = id;
  }

  /**
   * Get the active project ID.
   * @returns Active project ID or null if no active project
   */
  getActiveProjectId(): string | null {
    return this.activeProjectId;
  }

  /**
   * Check if a project is registered.
   * @param id Project ID
   * @returns True if project is registered
   */
  hasProject(id: string): boolean {
    return this.projects.has(id);
  }

  /**
   * Get the number of registered projects.
   * @returns Project count
   */
  count(): number {
    return this.projects.size;
  }
}

/**
 * Generate a project ID slug from a project name.
 * Converts to lowercase, replaces spaces/special chars with hyphens.
 */
export function generateProjectId(name: string): string {
  return name
    .toLowerCase()
    .trim()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export function initializeProjectDb(
  dbPath: string,
  projectName: string,
): { db: QuackDB | NoopDB; dbState: ProjectDbState } {
  try {
    return {
      db: new QuackDB(dbPath),
      dbState: {
        dbPath,
        mode: "sqlite",
        degraded: false,
      },
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[${projectName}] SQLite init failed, using noop DB:`, message);
    return {
      db: new NoopDB(),
      dbState: {
        dbPath,
        mode: "noop",
        degraded: true,
        error: message,
      },
    };
  }
}

/**
 * Build a ProjectContext from a project root path and adapter.
 */
export function buildProjectContext(
  adapter: ProjectAdapter,
  quackBin: string,
  eventCallback?: DispatchEventCallback,
): ProjectContext {
  const projectId = generateProjectId(adapter.config.project.name);
  const logDir = path.resolve(adapter.projectRoot, adapter.config.logging.dir);
  const dbPath = path.resolve(adapter.projectRoot, ".quack", "quack.db");
  const { db, dbState } = initializeProjectDb(dbPath, adapter.config.project.name);

  const eventReader = new EventReader(logDir);
  const taskService = new TaskService(adapter.projectRoot, adapter.config.project.taskDir);

  // Load isolation config from adapter
  const isolationConfig = adapter.config.isolation;

  // Initialize KeyManager if apiKeys config is present
  const keyManager = adapter.config.agent.apiKeys
    ? new KeyManager({
        strategy: adapter.config.agent.apiKeys.strategy,
        cooldownMs: adapter.config.agent.apiKeys.cooldownMs,
      })
    : null;

  const dispatchManager = new DispatchManager(
    adapter.projectRoot,
    quackBin,
    isolationConfig,
    keyManager ?? undefined,
    // QPI-043: the durable child-exit write must target the SAME log dir
    // the EventReader watches, including a customized logging.dir.
    logDir,
    async (taskId) => ({
      taskId,
      claimants: await listDuplicateClaimants(taskService.getTaskDirectory(), taskId),
    }),
  );

  if (eventCallback) {
    dispatchManager.setEventCallback(eventCallback);
  }

  const prepCache = new PrepCache(adapter.projectRoot);
  const prepWorker = new PrepWorker(adapter.projectRoot, quackBin);
  const readiness = new ReadinessService({
    projectRoot: adapter.projectRoot,
    taskService,
    prepCache,
    db,
  });

  // Load configs from adapter
  const autoPrepConfig = adapter.config.automation?.autoPrep;
  const queueConfig = adapter.config.queue;

  const prepScheduler = autoPrepConfig
    ? new PrepScheduler(
        prepWorker,
        prepCache,
        taskService,
        autoPrepConfig,
        () => {
          // Event callback handled at server level
        },
        {
          isPrepCurrent: (taskId) => readiness.isPrepCurrent(taskId),
          // TASK-1318 (round-3 F2): without the store, BOTH the terminal
          // predicate and backlog hygiene fall back to spec status alone
          // and the routing is inert. Passing the handle rather than the
          // root is what puts them on one resolution.
          db,
        },
      )
    : null;

  const fleetController = new FleetController(
    dispatchManager,
    prepScheduler,
    adapter.projectRoot,
    prepWorker,
  );

  const costVelocityTracker = new CostVelocityTracker(adapter.config.costVelocity);
  const progressDetector = new ProgressDetector(adapter.config.stuckDetection);

  // Build dispatch queue
  const dispatchQueue = queueConfig
    ? new DispatchQueue(
        dispatchManager,
        taskService,
        eventReader,
        queueConfig,
        logDir,
        () => {
          // Event callback handled at server level
        },
        db,
      )
    : null;

  return {
    id: projectId,
    name: adapter.config.project.name,
    rootPath: adapter.projectRoot,
    logDir,
    adapter,
    eventReader,
    dispatchManager,
    taskService,
    prepCache,
    prepWorker,
    prepScheduler,
    fleetController,
    costVelocityTracker,
    progressDetector,
    dispatchQueue,
    keyManager,
    db,
    dbState,
  };
}

/**
 * Tear down a ProjectContext, stopping all running services.
 */
export function teardownProjectContext(context: ProjectContext): void {
  // Stop file watcher
  context.stopWatcher?.();
  // Stop task watcher
  void context.taskWatcher?.close();
  // Stop progress detector
  context.progressDetector.stopChecking();
  // Stop dispatch queue (if running)
  context.dispatchQueue?.stop();
  // Stop prep scheduler (if running)
  context.prepScheduler?.stop();
  // Close SQLite database
  context.db.close();
  // Note: DispatchManager, FleetController, etc. are stateless and don't need explicit cleanup
}
