// ─── Task Watcher ──────────────────────────────────────────────────
// Watches the task directory for new/changed TASK-*.md / SAURUS-REM-*.md
// files and automatically: (1) attempts to parse them, (2) if parse fails,
// repairs intent-safely: the deterministic spec normalizer first, then
// (repairMode "full") the LLM spec-repair agent, both hard-gated by the
// additive-only repair guard, (3) if parse succeeds, queues preflight.
// See docs/SPEC_REPAIR.md for the repair contract.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseTaskFile, TaskParseError } from "../core/task-parser.js";
import { normalizeSpec, hasUnresolvedRepairMarkers } from "../core/spec-normalizer.js";
import { verifyRepairIsAdditive } from "../core/repair-guard.js";
import type { ParsedTask } from "../core/types.js";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import {
  TaskCreationIdentityConflictError,
  TaskCreationScanUnavailableError,
} from "../core/task-creation-reservation.js";
import { computeContentHash } from "./prep-cache.js";
import {
  CanonicalTaskSpecMutationError,
  withCanonicalTaskSpecMutationFence,
} from "../preflight/canonical-task-spec-mutation.js";

export interface TaskWatcherCallbacks {
  /** Called when a new task file is detected and successfully parsed */
  onNewTask?: (task: ParsedTask, filePath: string) => void;
  /** Called when spec repair fixed a task file. The third argument is the
   *  list of sections added (LLM leg) or normalizer action keys
   *  (deterministic leg). */
  onRepaired?: (taskId: string, filePath: string, sectionsAdded: string[]) => void;
  /** Called when a task file fails to parse (before or after repair attempt) */
  onParseError?: (file: string, error: string) => void;
  /** Called when a preflight run is queued for a task */
  onPreflightQueued?: (taskId: string) => void;
  /** Called when spec repair fails */
  onRepairFailed?: (taskId: string, filePath: string, error: string) => void;
  /**
   * Called when a parsed task's status is terminal (COMPLETE / VERIFIED /
   * REJECTED) and parse succeeded. Lets the server wire spec-side admin
   * bumps into the DB `task_status` table — TASK-914. The wiring must
   * be idempotent (only setStatus when DB row is non-terminal or absent).
   */
  onTerminalStatus?: (
    taskId: string,
    status: "COMPLETE" | "VERIFIED" | "REJECTED",
    filePath: string,
  ) => void;
}

export interface TaskWatcherOptions {
  /** Debounce delay in ms (default: 2000) */
  debounceMs?: number;
  /** Whether to attempt spec repair on parse failures (default: true) */
  autoRepair?: boolean;
  /**
   * Repair strategy on parse failures (default derived from autoRepair:
   * true -> "full", false -> "off").
   * - "off": never modify files; report the parse error only.
   * - "deterministic": run the intent-safe spec normalizer only (no LLM).
   * - "full": normalizer first, then the LLM spec-repair agent as fallback.
   * Both legs are gated by the additive-only repair guard; a repair that
   * touches payload content the submitter wrote is rejected.
   */
  repairMode?: "off" | "deterministic" | "full";
  /** Whether to auto-queue preflight on successful parse (default: true) */
  autoPreflight?: boolean;
  /** Function to check if a preflight cache exists and is current */
  isPreflightCurrent?: (taskId: string, contentHash: string) => boolean | Promise<boolean>;
  /** Function to queue a preflight run */
  queuePreflight?: (taskId: string) => void;
  /** Spec repair function (injectable for testing) */
  repairFn?: (
    rawContent: string,
    filePath: string,
    parseError: string,
    adapter: ProjectAdapter,
  ) => Promise<string>;
}

/**
 * Watches the task directory for new/changed TASK-*.md files.
 *
 * On file add/change:
 * 1. Parse the file
 * 2. If parse fails and autoRepair is enabled → run repair agent → write back
 * 3. If parse succeeds → optionally queue preflight
 */
export class TaskWatcher {
  private watcher: { close: () => Promise<void> } | null = null;
  private startPromise: Promise<void> | null = null;
  private closeRequested = false;
  private debounceTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private processing = new Set<string>();
  private inFlightProcessing = new Set<Promise<void>>();
  private readonly debounceMs: number;
  private readonly autoRepair: boolean;
  private readonly repairMode: "off" | "deterministic" | "full";
  private readonly autoPreflight: boolean;

  constructor(
    private readonly taskDir: string,
    private readonly adapter: ProjectAdapter,
    private readonly callbacks: TaskWatcherCallbacks,
    private readonly options: TaskWatcherOptions = {},
  ) {
    this.debounceMs = options.debounceMs ?? 2000;
    this.autoRepair = options.autoRepair ?? true;
    this.repairMode = options.repairMode ?? (this.autoRepair ? "full" : "off");
    this.autoPreflight = options.autoPreflight ?? true;
  }

  /**
   * Start watching the task directory for TASK-*.md / SAURUS-REM-*.md files.
   */
  start(): Promise<void> {
    if (this.closeRequested) return Promise.resolve();
    if (this.startPromise) return this.startPromise;

    this.startPromise = this.startWatching();
    return this.startPromise;
  }

  private async startWatching(): Promise<void> {
    const chokidar = await import("chokidar");
    // close() may have won the race while the dynamic import was pending.
    // Never create a new native watcher after terminal cleanup has begun.
    if (this.closeRequested) return;

    const pattern = [
      path.join(this.taskDir, "TASK-*.md"),
      path.join(this.taskDir, "SAURUS-REM-*.md"),
    ];

    this.watcher = chokidar.watch(pattern, {
      ignoreInitial: true,
      awaitWriteFinish: { stabilityThreshold: 500, pollInterval: 100 },
      // Use polling on Windows to avoid fs.watch() returning undefined
      // (chokidar v3 bug triggered by rapid file changes)
      usePolling: process.platform === "win32",
      interval: 1000,
    });

    type WatcherOn = { on: (event: string, cb: (arg: string) => void) => void };
    const w = this.watcher as unknown as WatcherOn;

    w.on("error", (err: string) => {
      console.error("[task-watcher] chokidar error (non-fatal):", err);
    });

    w.on("add", (filePath: string) => {
      this.scheduleProcess(filePath);
    });

    w.on("change", (filePath: string) => {
      this.scheduleProcess(filePath);
    });
  }

  /**
   * Stop watching and clean up.
   */
  async close(): Promise<void> {
    // Fence admission synchronously, before waiting for a start already in
    // progress. This also makes close terminal and idempotent.
    this.closeRequested = true;

    // Clear all pending debounce timers
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();

    // startWatching() performs no further asynchronous work after it creates
    // the watcher. Awaiting it therefore covers both sides of the import race.
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // The start caller owns the startup failure. Cleanup still has to close
        // any watcher that may have been installed before that failure.
      }
    }

    if (this.watcher) {
      const watcher = this.watcher;
      await watcher.close();
      if (this.watcher === watcher) this.watcher = null;
    }

    // A debounce callback may already have entered processFile() before the
    // close fence was raised. Let that operation finish before callers close
    // project-scoped resources such as the database.
    await Promise.allSettled([...this.inFlightProcessing]);
  }

  /**
   * Schedule processing of a file with debouncing.
   */
  private scheduleProcess(filePath: string): void {
    // Chokidar may already have queued an event when close() starts. Do not
    // allow that callback to recreate a referenced debounce timer afterward.
    if (this.closeRequested) return;

    // Clear existing timer for this file
    const existing = this.debounceTimers.get(filePath);
    if (existing) clearTimeout(existing);

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      if (this.closeRequested) return;
      void this.processFile(filePath);
    }, this.debounceMs);

    this.debounceTimers.set(filePath, timer);
  }

  /**
   * Process a single task file: parse → repair → preflight.
   */
  processFile(filePath: string): Promise<void> {
    if (this.closeRequested) return Promise.resolve();

    // Prevent concurrent processing of the same file
    if (this.processing.has(filePath)) return Promise.resolve();
    this.processing.add(filePath);

    const operation = this.processFileTracked(filePath);
    this.inFlightProcessing.add(operation);
    void operation.then(
      () => this.inFlightProcessing.delete(operation),
      () => this.inFlightProcessing.delete(operation),
    );
    return operation;
  }

  private async processFileTracked(filePath: string): Promise<void> {
    try {
      let currentContent = fs.readFileSync(filePath, "utf-8");
      const fileName = path.basename(filePath);

      // Try to parse
      let task: ParsedTask;
      try {
        task = parseTaskFile(currentContent, filePath);
      } catch (err) {
        const errorMsg = err instanceof TaskParseError ? err.message : String(err);

        if (this.repairMode === "off") {
          this.callbacks.onParseError?.(fileName, errorMsg);
          return;
        }

        // Task ID from the filename (used for H1 recovery and reporting).
        const idMatch = fileName.match(/^((?:TASK-\d+(?:-[A-Z])?|SAURUS-REM-\d{3}))/);
        const taskIdHint = idMatch ? idMatch[1] : undefined;

        // Leg 1: deterministic, intent-safe normalizer (no LLM). Envelope
        // fixes and gating placeholders only; unresolvable specs fall
        // through unchanged (never a partial write).
        let repairedTask: ParsedTask | null = null;
        let detParseError: string | undefined;
        try {
          const det = normalizeSpec(currentContent, { taskIdHint });
          detParseError = det.parseError;
          if (det.resolved && det.changed) {
            repairedTask = parseTaskFile(det.content, filePath);
            try {
              await this.promoteRepair(filePath, currentContent, det.content, repairedTask.id);
            } catch (promotionErr) {
              if (this.reportPromotionRefusal(promotionErr, repairedTask.id, filePath)) {
                return;
              }
              throw promotionErr;
            }
            currentContent = det.content;
            this.callbacks.onRepaired?.(repairedTask.id, filePath, det.actions);
          }
        } catch (detErr) {
          detParseError = detErr instanceof Error ? detErr.message : String(detErr);
          repairedTask = null;
        }

        // Leg 2: LLM spec-repair agent, hard-gated by the additive-only
        // guard so it can never alter payload content the submitter wrote.
        if (!repairedTask && this.repairMode === "full") {
          try {
            const repairFn = this.options.repairFn ?? (await this.getDefaultRepairFn());
            const repaired = await repairFn(currentContent, filePath, errorMsg, this.adapter);

            const guard = verifyRepairIsAdditive(currentContent, repaired);
            if (!guard.ok) {
              throw new Error(
                `repair rejected by additive-only guard: ${guard.violations.slice(0, 3).join("; ")}`,
              );
            }

            // An LLM repair only runs where the deterministic normalizer
            // could not resolve, i.e. the fix required judgment. Judgment
            // repairs must always leave the task gated for a human; an LLM
            // output with no repair placeholder marker would be silently
            // dispatchable and is refused.
            if (!hasUnresolvedRepairMarkers(repaired)) {
              throw new Error(
                "repair rejected: LLM repairs must leave the task gated (no repair placeholder marker in output)",
              );
            }

            // Validate the repaired content parses successfully
            repairedTask = parseTaskFile(repaired, filePath);

            // Detect which sections were added
            const sectionsAdded = this.detectAddedSections(currentContent, repaired);

            // Write repaired content back
            try {
              await this.promoteRepair(filePath, currentContent, repaired, repairedTask.id);
            } catch (promotionErr) {
              if (this.reportPromotionRefusal(promotionErr, repairedTask.id, filePath)) {
                return;
              }
              throw promotionErr;
            }
            currentContent = repaired;

            this.callbacks.onRepaired?.(repairedTask.id, filePath, sectionsAdded);
          } catch (repairErr) {
            const repairMsg = repairErr instanceof Error ? repairErr.message : String(repairErr);
            const taskId = taskIdHint ?? fileName;
            this.callbacks.onRepairFailed?.(taskId, filePath, repairMsg);
            this.callbacks.onParseError?.(fileName, errorMsg);
            return;
          }
        }

        if (!repairedTask) {
          // Deterministic-only mode with an unresolvable spec.
          const taskId = taskIdHint ?? fileName;
          this.callbacks.onRepairFailed?.(taskId, filePath, detParseError ?? errorMsg);
          this.callbacks.onParseError?.(fileName, errorMsg);
          return;
        }

        // Continue with preflight using the repaired task
        task = repairedTask;
      }

      // Skip terminal tasks and decomposition trackers — none are dispatchable
      // parents, and re-preflighting a freshly committed DECOMPOSED tracker
      // would immediately collide with its own child specs. Also fire
      // the TASK-914 sync callback so the server can propagate terminal
      // spec-Status changes into the DB task_status table (the federation
      // scheduler reads DB-first for dependency resolution).
      if (
        task.status === "COMPLETE" ||
        task.status === "VERIFIED" ||
        task.status === "REJECTED" ||
        task.status === "DECOMPOSED"
      ) {
        this.callbacks.onNewTask?.(task, filePath);
        if (task.status !== "DECOMPOSED") {
          this.callbacks.onTerminalStatus?.(task.id, task.status, filePath);
        }
        return;
      }

      this.callbacks.onNewTask?.(task, filePath);

      // Queue preflight if enabled and needed
      if (this.autoPreflight && this.options.queuePreflight) {
        const contentHash = computeContentHash(currentContent);
        const isCurrent = await Promise.resolve(
          this.options.isPreflightCurrent?.(task.id, contentHash) ?? false,
        );
        if (!isCurrent) {
          this.options.queuePreflight(task.id);
          this.callbacks.onPreflightQueued?.(task.id);
        }
      }
    } catch (err) {
      const fileName = path.basename(filePath);
      const msg = err instanceof Error ? err.message : String(err);
      this.callbacks.onParseError?.(fileName, `Unexpected error: ${msg}`);
    } finally {
      this.processing.delete(filePath);
    }
  }

  /**
   * Promote an unparseable file only while every creator shares the same
   * declared-id reservation. The watched file itself is the intended owner;
   * any other filename already declaring the repaired id makes this a refusal.
   */
  private async promoteRepair(
    filePath: string,
    expectedContent: string,
    repairedContent: string,
    declaredId: string,
  ): Promise<void> {
    await withCanonicalTaskSpecMutationFence({
      adapter: this.adapter,
      taskId: declaredId,
      taskFilePath: filePath,
      expectedContent,
      replacementContent: repairedContent,
      allowUnparseableCurrent: true,
    });
  }

  private reportPromotionRefusal(err: unknown, declaredId: string, filePath: string): boolean {
    if (err instanceof CanonicalTaskSpecMutationError) {
      this.callbacks.onRepairFailed?.(declaredId, filePath, err.message);
      return true;
    }
    if (err instanceof TaskCreationIdentityConflictError) {
      const conflict = err.conflicts.find((item) => item.taskId === declaredId) ?? err.conflicts[0];
      this.callbacks.onRepairFailed?.(
        declaredId,
        filePath,
        `Repair promotion refused for ${declaredId}; existing claimants: ${conflict?.claimants.join(", ") ?? "unknown"}`,
      );
      return true;
    }
    if (err instanceof TaskCreationScanUnavailableError) {
      this.callbacks.onRepairFailed?.(
        declaredId,
        filePath,
        `Repair promotion refused for ${declaredId}; claimant scan unavailable: ${err.reason}`,
      );
      return true;
    }
    return false;
  }

  /**
   * Lazily load the default repair function to avoid importing the SDK at startup.
   */
  private async getDefaultRepairFn(): Promise<
    (
      rawContent: string,
      filePath: string,
      parseError: string,
      adapter: ProjectAdapter,
    ) => Promise<string>
  > {
    const { repairTaskSpec } = await import("../gate/spec-repair-agent.js");
    return repairTaskSpec;
  }

  /**
   * Detect which H2 sections were added in the repair.
   */
  private detectAddedSections(original: string, repaired: string): string[] {
    const extractSections = (text: string): Set<string> => {
      const sections = new Set<string>();
      for (const line of text.split(/\r?\n/)) {
        const match = line.match(/^##\s+(.+)/);
        if (match) sections.add(match[1].trim());
      }
      return sections;
    };

    const originalSections = extractSections(original);
    const repairedSections = extractSections(repaired);

    const added: string[] = [];
    for (const section of repairedSections) {
      if (!originalSections.has(section)) {
        added.push(section);
      }
    }
    return added;
  }
}
