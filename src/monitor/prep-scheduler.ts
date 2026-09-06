// ─── Prep Scheduler ────────────────────────────────────────────────
// Orchestrates auto-prep: works through the task backlog running gate
// checks with configurable rate limiting. Off by default.

import type { AutoPrepConfig } from "../core/types.js";
import type { EventStage, EventPayload } from "./event-types.js";
import type { PrepWorker } from "./prep-worker.js";
import type { PrepCache } from "./prep-cache.js";
import type { TaskService } from "./task-service.js";
import type { QuackDB } from "../db/quack-db.js";
import type { NoopDB } from "../db/noop-db.js";
import { PrepQueue } from "./prep-queue.js";
import { isTaskSuppressedFromAutomation } from "../core/task-hygiene.js";
import { isTerminalTaskStatus } from "./task-projection.js";

export interface PrepSchedulerStatus {
  enabled: boolean;
  running: boolean;
  queueSize: number;
  activePreps: number;
  prepsThisHour: number;
  maxPerHour: number;
  costThisHour: number;
  maxBudgetPerHour: number;
  totalProcessed: number;
  parseErrorCount: number;
  parseErrors: Array<{ file: string; error: string }>;
}

type EventCallback = (stage: EventStage, payload: EventPayload) => void;

interface PrepSchedulerDeps {
  isPrepCurrent?: (taskId: string) => Promise<boolean>;
  /**
   * The project's runtime store, which decides eligibility (TASK-1318
   * S2, corrected by round-3 F2).
   *
   * This replaced a `projectRoot` string that the scheduler used to open
   * its OWN read-only overlay. That produced two independent resolutions
   * of the same question in one pass, and they disagreed: the routed
   * predicate below saw the runtime row, while `backlogHygiene` arrived
   * precomputed from a `listTasks()` call made with NO database and so
   * still carried a SPEC-derived `status_rejected`. A task whose runtime
   * row said BACKLOG and whose markdown said REJECTED passed the
   * predicate and was then suppressed by hygiene anyway. The spec still
   * decided; the routing just moved where it decided.
   *
   * Handing the store to `listTasks` collapses both answers onto the one
   * projection pass, so `effectiveStatus` and `backlogHygiene` are
   * resolved from the same evidence and cannot contradict each other.
   *
   * Optional because the scheduler is constructed positionally from two
   * wirings, but NOT decorative: without it eligibility is spec-only,
   * which is the behavior TASK-1318 retires. A missing store is warned
   * about once per instance rather than guessed.
   */
  db?: QuackDB | NoopDB;
}

const ONE_HOUR_MS = 60 * 60 * 1000;
const POLL_INTERVAL_MS = 2000;

export class PrepScheduler {
  private queue = new PrepQueue();
  private running = false;
  private config: AutoPrepConfig;
  private onEvent?: EventCallback;

  // Rate limiting state
  private prepStartTimes: number[] = [];
  private prepCosts: number[] = [];
  private totalProcessed = 0;
  private parseErrors: Array<{ file: string; error: string }> = [];

  // Timer handles
  private loopTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimers = new Map<string, ReturnType<typeof setInterval>>();

  /** One wiring complaint per instance, not one per pass. */
  private warnedMissingDb = false;

  constructor(
    private readonly prepWorker: PrepWorker,
    private readonly prepCache: PrepCache,
    private readonly taskService: TaskService,
    config: AutoPrepConfig,
    onEvent?: EventCallback,
    private readonly deps: PrepSchedulerDeps = {},
  ) {
    this.config = { ...config };
    this.onEvent = onEvent;
    this.queue.setPriorityOrder(config.priorityOrder);
  }

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;

    // Scan all tasks and build queue.
    //
    // Round-3 F2: the store goes IN. `listTasks` batch-reads
    // `task_status` once, projects `effectiveStatus` through the shared
    // resolver, and folds status hygiene from that same resolved value
    // (TASK-1318 S2c). Calling it without the store is what left the
    // spec deciding suppression after the predicate had been routed.
    this.warnOnceIfStoreMissing();
    const { tasks, parseErrors } = await this.taskService.listTasks(
      undefined,
      undefined,
      this.deps.db,
    );
    this.parseErrors = parseErrors;
    if (parseErrors.length > 0) {
      this.emit("auto_prep_parse_errors", {
        parseErrorCount: parseErrors.length,
        parseErrors: parseErrors.slice(0, 25),
      });
    }
    const eligibility = await Promise.all(
      tasks.map(async (t) => ({
        task: t,
        skipCurrentPrep: this.config.skipPrepped ? await this.isPrepCurrent(t.id) : false,
      })),
    );
    const eligible = eligibility
      .filter(({ task, skipCurrentPrep }) => {
        // TASK-1318 S2: resolve DB-over-spec BEFORE the predicate runs.
        // Round-2 F1 caught this site with a modernized predicate reading a
        // raw-spec INPUT, which is a rename rather than a retirement: a
        // runtime row saying the task was finished got ignored, and the
        // markdown line still decided.
        //
        // Round-3 F2: the resolution is now the projection's, not a second
        // one of the scheduler's own. `effectiveStatus` is what
        // `buildTaskProjection` got from the shared resolver over the
        // runtime row and the spec line, byte-identical to `task.status`
        // whenever the store is silent, and it is the SAME value the
        // hygiene fold below was computed from.
        const resolvedStatus = task.effectiveStatus;

        // Skip finished tasks, using `isTerminalTaskStatus`, which counts
        // REJECTED. That REVERSES the call recorded in round-2 F5. The
        // earlier rationale was "REJECTED work may legitimately need
        // re-prep after fixes"; it never held, because backlog hygiene
        // suppresses REJECTED from automation on the very next line, so
        // the exemption bought no re-prep at all. The question this site
        // asks is "is this task finished", and a rejected task IS
        // finished. `isCompleteStatus` stays the answer to the different
        // question "does this satisfy a dependency", where REJECTED must
        // NOT count; the two must never merge.
        //
        // The predicate only bites once the input above is routed, because
        // hygiene catches a SPEC-rejected task either way. What the pair
        // newly excludes is a task the RUNTIME store rejected while its
        // spec still reads READY.
        if (isTerminalTaskStatus(resolvedStatus)) return false;
        // Hygiene arrives precomputed from `listTasks()`, and round-3 F2
        // made that call carry the store, so its ON_HOLD and REJECTED
        // rules are evaluated against the resolved status (TASK-1318 S2c
        // moved status hygiene into the projection pass for exactly this).
        // Both directions now work: a runtime REJECTED under a READY spec
        // is suppressed, and a spec REJECTED under a runtime BACKLOG is
        // NOT.
        //
        // `isTaskSuppressedFromAutomation` falls back to RAW spec status
        // when `backlogHygiene` is absent, which would reopen the very
        // door this closed. It is unreachable for `listTasks` output, but
        // that is a claim about ANOTHER module, so round-4b declined to
        // confirm it from here and was right to. It is pinned instead, in
        // tests/monitor/spec-db-conflict-surfaces ("every summary from
        // listTasks carries backlogHygiene"), alongside the pin that
        // `effectiveStatus` equals the overlay answer this site used to
        // compute for itself.
        if (isTaskSuppressedFromAutomation(task)) return false;
        // Skip already prepped if configured
        if (skipCurrentPrep) return false;
        return true;
      })
      .map(({ task }) => task);

    this.queue.clear();
    this.queue.enqueue(eligible);

    this.emit("auto_prep_started", { queueSize: this.queue.size() });
    await this.scheduleNext();
  }

  stop(): void {
    if (!this.running) return;
    this.running = false;

    // Clear timers
    if (this.loopTimer) {
      clearTimeout(this.loopTimer);
      this.loopTimer = null;
    }
    for (const timer of this.pollTimers.values()) {
      clearInterval(timer);
    }
    this.pollTimers.clear();

    this.emit("auto_prep_paused", {
      reason: "stopped",
      queueRemaining: this.queue.size(),
    });
  }

  isRunning(): boolean {
    return this.running;
  }

  getStatus(): PrepSchedulerStatus {
    this.cleanExpiredWindows();
    return {
      enabled: this.config.enabled,
      running: this.running,
      queueSize: this.queue.size(),
      activePreps: this.prepWorker.getActiveJobs().length,
      prepsThisHour: this.prepStartTimes.length,
      maxPerHour: this.config.maxPerHour,
      costThisHour: this.prepCosts.reduce((sum, c) => sum + c, 0),
      maxBudgetPerHour: this.config.maxBudgetPerHour,
      totalProcessed: this.totalProcessed,
      parseErrorCount: this.parseErrors.length,
      parseErrors: this.parseErrors,
    };
  }

  getQueue(): string[] {
    return this.queue.toArray();
  }

  updateConfig(config: AutoPrepConfig): void {
    this.config = { ...config };
    this.queue.setPriorityOrder(config.priorityOrder);
  }

  // ─── Internal ──────────────────────────────────────────────────────

  private async scheduleNext(): Promise<void> {
    if (!this.running) return;

    if (this.queue.isEmpty()) {
      this.emit("auto_prep_queue_empty", { totalProcessed: this.totalProcessed });
      this.running = false;
      return;
    }

    this.cleanExpiredWindows();
    const limitResult = this.checkRateLimits();

    if (limitResult.blocked) {
      if (limitResult.type === "budget") {
        this.emit("auto_prep_budget_exceeded", {
          hourlySpend: this.prepCosts.reduce((s, c) => s + c, 0),
          hourlyLimit: this.config.maxBudgetPerHour,
        });
      } else {
        this.emit("auto_prep_rate_limited", {
          limitType: limitResult.type!,
          resumeAt: new Date(Date.now() + limitResult.waitMs).toISOString(),
        });
      }

      // Schedule retry after wait period
      this.loopTimer = setTimeout(() => {
        this.loopTimer = null;
        void this.scheduleNext();
      }, limitResult.waitMs);
      return;
    }

    // Dequeue and start
    const task = this.queue.dequeue();
    if (!task) return;

    // Double-check: skip if already prepped (may have been prepped manually since queue was built)
    if (this.config.skipPrepped && (await this.isPrepCurrent(task.id))) {
      await this.scheduleNext();
      return;
    }

    // Skip if already running
    if (this.prepWorker.getActiveJob(task.id)) {
      await this.scheduleNext();
      return;
    }

    try {
      this.prepWorker.start(task.id);
      this.prepStartTimes.push(Date.now());

      // Poll for completion
      const pollTimer = setInterval(() => {
        const current = this.prepWorker.getJob(task.id);
        if (!current || current.status === "running") return;

        // Job finished
        clearInterval(pollTimer);
        this.pollTimers.delete(task.id);
        this.totalProcessed++;

        // Record cost (depth evaluation cost is not directly available from PrepJob,
        // use a small estimated cost per prep or 0 if not available)
        if (current.result) {
          // Depth evaluation cost is approximately $0.01-0.05 per task
          // Use 0 as placeholder — actual cost tracking requires event log parsing
          this.prepCosts.push(0);
        }

        // Schedule next task
        void this.scheduleNext();
      }, POLL_INTERVAL_MS).unref();

      this.pollTimers.set(task.id, pollTimer);
    } catch {
      // Prep start failed (e.g., already running) — skip and continue
      await this.scheduleNext();
    }
  }

  /**
   * Complain once per instance when the scheduler was constructed
   * without a runtime store (round-3 F2).
   *
   * Without it BOTH halves of eligibility, the terminal predicate and
   * the hygiene fold, are decided by spec status alone, which is the
   * behavior TASK-1318 retires. It is a wiring defect rather than a
   * runtime condition, so it is worth exactly one loud line rather than
   * one per pass.
   */
  private warnOnceIfStoreMissing(): void {
    if (this.deps.db) return;
    if (this.warnedMissingDb) return;
    this.warnedMissingDb = true;
    console.warn(
      "[prep-scheduler] no runtime store was supplied, so auto-prep eligibility and backlog hygiene are " +
        "decided from spec status alone and a runtime task_status row cannot override either; pass `db` " +
        "in the scheduler deps to route it (TASK-1318 S2, round-3 F2)",
    );
  }

  private async isPrepCurrent(taskId: string): Promise<boolean> {
    if (this.deps.isPrepCurrent) {
      return this.deps.isPrepCurrent(taskId);
    }
    return this.prepCache.exists(taskId);
  }

  private checkRateLimits(): { blocked: boolean; type?: string; waitMs: number } {
    const now = Date.now();

    // Check concurrent limit
    const activeCount = this.prepWorker.getActiveJobs().length;
    if (activeCount >= this.config.maxConcurrent) {
      return { blocked: true, type: "concurrent", waitMs: POLL_INTERVAL_MS };
    }

    // Check cooldown
    if (this.prepStartTimes.length > 0) {
      const lastStart = this.prepStartTimes[this.prepStartTimes.length - 1];
      const elapsed = now - lastStart;
      const cooldownMs = this.config.cooldownSeconds * 1000;
      if (elapsed < cooldownMs) {
        return { blocked: true, type: "cooldown", waitMs: cooldownMs - elapsed };
      }
    }

    // Check hourly count
    if (this.prepStartTimes.length >= this.config.maxPerHour) {
      const oldest = this.prepStartTimes[0];
      const waitMs = oldest + ONE_HOUR_MS - now;
      return { blocked: true, type: "hourly_count", waitMs: Math.max(waitMs, 1000) };
    }

    // Check hourly budget
    const hourlyCost = this.prepCosts.reduce((sum, c) => sum + c, 0);
    if (hourlyCost >= this.config.maxBudgetPerHour) {
      // Wait until oldest cost entry expires
      const waitMs =
        this.prepStartTimes.length > 0 ? this.prepStartTimes[0] + ONE_HOUR_MS - now : ONE_HOUR_MS;
      return { blocked: true, type: "budget", waitMs: Math.max(waitMs, 1000) };
    }

    return { blocked: false, waitMs: 0 };
  }

  private cleanExpiredWindows(): void {
    const cutoff = Date.now() - ONE_HOUR_MS;
    // Remove expired entries from the front (they're in chronological order)
    while (this.prepStartTimes.length > 0 && this.prepStartTimes[0] < cutoff) {
      this.prepStartTimes.shift();
      // Keep costs array in sync
      if (this.prepCosts.length > 0) {
        this.prepCosts.shift();
      }
    }
  }

  private emit(stage: EventStage, payload: EventPayload): void {
    this.onEvent?.(stage, payload);
  }
}
