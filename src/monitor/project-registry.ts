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
import { withDecompositionAdmissionFence } from "../preflight/decomposition-transaction-journal.js";

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
  stopWatcher?: () => Promise<void>;
  /** Task file watcher (auto-discovery + repair + preflight) */
  taskWatcher?: { close: () => Promise<void> } | null;
  /** SQLite database for runtime state (NoopDB if native module unavailable) */
  db: QuackDB | NoopDB;
  /** Health metadata for the runtime DB backing this project. */
  dbState?: ProjectDbState;
}

export type ProjectEventWatcherTeardownState = "not-attempted" | "closed" | "failed";

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

    const roots = Array.from(this.projects.values(), (project) => project.rootPath);
    for (const project of this.projects.values()) {
      const manager = project.dispatchManager as
        | (DispatchManager & {
            setDockerRegisteredProjectRoots?: (registeredRoots: readonly string[]) => void;
          })
        | null;
      manager?.setDockerRegisteredProjectRoots?.(roots);
    }

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
    const roots = Array.from(this.projects.values(), (project) => project.rootPath);
    for (const project of this.projects.values()) {
      const manager = project.dispatchManager as
        | (DispatchManager & {
            setDockerRegisteredProjectRoots?: (registeredRoots: readonly string[]) => void;
          })
        | null;
      manager?.setDockerRegisteredProjectRoots?.(roots);
    }
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
        pool: adapter.config.agent.apiKeys.pool,
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
    adapter.trustedLocalReadRemotePaths,
    (taskId, dispatch) => withDecompositionAdmissionFence(adapter, taskId, dispatch, db),
  );

  dispatchManager.setObservationProjectId(projectId);

  if (eventCallback) {
    dispatchManager.setEventCallback(eventCallback);
  }

  const prepCache = new PrepCache(adapter.projectRoot);
  const prepWorker = new PrepWorker(
    adapter.projectRoot,
    quackBin,
    {},
    {
      keyManager: keyManager ?? undefined,
      logDir,
      projectId,
      onTerminal: (job) =>
        eventCallback?.(
          job.status === "completed" ? "prep_job_completed" : "prep_failed",
          job.taskId,
          { ...job },
        ),
    },
  );
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
        (taskId, dispatch) => withDecompositionAdmissionFence(adapter, taskId, dispatch, db),
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
export async function teardownProjectContext(
  context: ProjectContext,
  options: { eventWatcherState?: ProjectEventWatcherTeardownState } = {},
): Promise<void> {
  const failures: Error[] = [];
  const asyncCleanups: Array<{ label: string; promise: Promise<void> }> = [];
  let dispatchTerminationConfirmed = true;
  let prepTerminationConfirmed = true;

  const recordFailure = (label: string, reason: unknown): void => {
    const cause = reason instanceof Error ? reason : new Error(String(reason));
    failures.push(new Error(`${label}: ${cause.message}`, { cause }));
  };
  const runSyncCleanup = (label: string, cleanup: () => void): void => {
    try {
      cleanup();
    } catch (error: unknown) {
      recordFailure(label, error);
    }
  };
  const queueAsyncCleanup = (label: string, cleanup: () => Promise<void>): void => {
    try {
      asyncCleanups.push({ label, promise: cleanup() });
    } catch (error: unknown) {
      recordFailure(label, error);
    }
  };

  // Close dispatch/prep admission before the first await so no new child can
  // appear while dynamic project unregistration is tearing the context down.
  runSyncCleanup("dispatch admission drain", () => context.dispatchManager?.beginTerminalDrain());
  runSyncCleanup("prep admission drain", () => context.prepWorker?.beginTerminalDrain());
  runSyncCleanup("dispatch process termination", () => {
    if (context.dispatchManager && !context.dispatchManager.killAll()) {
      dispatchTerminationConfirmed = false;
      throw new Error("one or more dispatch process trees could not be confirmed stopped");
    }
  });
  if (context.dispatchManager && dispatchTerminationConfirmed) {
    queueAsyncCleanup("dispatch process close", async () => {
      if (!(await context.dispatchManager!.waitForIdle())) {
        dispatchTerminationConfirmed = false;
        throw new Error("timed out waiting for dispatch child handles or exit cleanup to finish");
      }
      if (context.dispatchManager!.hasPendingOperatorStopCleanup()) {
        dispatchTerminationConfirmed = false;
        throw new Error("operator-stop recovery cleanup remains unconfirmed");
      }
    });
  }
  runSyncCleanup("prep process termination", () => {
    if (context.prepWorker && !context.prepWorker.killAll()) {
      prepTerminationConfirmed = false;
      throw new Error("one or more prep process trees could not be confirmed stopped");
    }
  });
  if (context.prepWorker && prepTerminationConfirmed) {
    queueAsyncCleanup("prep process close", async () => {
      if (!(await context.prepWorker!.waitForIdle())) {
        prepTerminationConfirmed = false;
        throw new Error("timed out waiting for prep child handles to close");
      }
    });
  }

  const eventWatcherState = options.eventWatcherState ?? "not-attempted";
  const stopWatcher = context.stopWatcher;
  if (eventWatcherState === "failed") {
    // The server already attempted this watcher during the current shutdown
    // pass. Do not invoke it twice in one pass, but retain it and fail teardown
    // so the project database stays open and a later stop can retry safely.
    recordFailure("event watcher close", "the earlier shutdown-phase attempt failed");
  } else if (eventWatcherState === "not-attempted" && stopWatcher) {
    queueAsyncCleanup("event watcher close", async () => {
      await stopWatcher();
      if (context.stopWatcher === stopWatcher) context.stopWatcher = undefined;
    });
  }

  const taskWatcher = context.taskWatcher;
  if (taskWatcher) {
    queueAsyncCleanup("task watcher close", async () => {
      await taskWatcher.close();
      if (context.taskWatcher === taskWatcher) context.taskWatcher = null;
    });
  }

  runSyncCleanup("progress detector stop", () => context.progressDetector.stopChecking());
  runSyncCleanup("dispatch queue stop", () => context.dispatchQueue?.stop());
  runSyncCleanup("prep scheduler stop", () => context.prepScheduler?.stop());

  // Wait until all file-system handles have had a chance to close. Preserve
  // every rejection instead of treating Promise.allSettled as success.
  const watcherResults = await Promise.allSettled(
    asyncCleanups.map(async ({ label, promise }) => {
      try {
        await promise;
      } catch (error: unknown) {
        recordFailure(label, error);
      }
    }),
  );
  // The wrapper promises above are expected to fulfill, but retain a defensive
  // check so a future refactor cannot silently discard a cleanup rejection.
  watcherResults.forEach((result, index) => {
    if (result.status === "rejected") {
      recordFailure(asyncCleanups[index]?.label ?? "asynchronous cleanup", result.reason);
    }
  });

  // A child with unconfirmed termination may still be using the project DB.
  // Keep it open and keep the registry entry so the caller can retry safely.
  if (dispatchTerminationConfirmed && prepTerminationConfirmed && failures.length === 0) {
    runSyncCleanup("database close", () => context.db.close());
  }

  if (failures.length > 0) {
    throw new AggregateError(failures, `Failed to fully tear down project ${context.id}`);
  }
}
