#!/usr/bin/env node

import { Command } from "commander";
import packageJson from "../package.json";

import { runCommand } from "./cli/run.js";
import { waveCommand } from "./cli/wave.js";
import { verifyCommand } from "./cli/verify.js";
import { enrichCommand } from "./cli/enrich.js";
import { initCommand } from "./cli/init.js";
import { statusCommand } from "./cli/status.js";
import { monitorCommand } from "./cli/monitor.js";
import { prepCommand } from "./cli/prep.js";
import { preflightCommand } from "./cli/preflight.js";
import { planCommand } from "./cli/plan.js";
import { queueCommand } from "./cli/queue.js";
import { decomposeCommand } from "./cli/decompose.js";
import { handleImport } from "./cli/import.js";
import { handlePublish } from "./cli/publish.js";
import { migrateGitHubSyncMap } from "./cli/migrate-github-sync-map.js";
import { handleSync } from "./cli/sync.js";
import { templatesCommand } from "./cli/templates.js";
import { reviseCommand } from "./cli/revise.js";
import { projectsCommand } from "./cli/projects.js";
import { overnightCommand } from "./cli/overnight.js";
import { repairDbCommand } from "./cli/repair-db.js";
import { repairSpecsCommand } from "./cli/repair-specs.js";
import { repairStateCommand } from "./cli/repair-state.js";
import { repairFederationLockCommand } from "./cli/repair-federation-lock.js";
import { workerEnrollCommand, workerInstallCommand, workerRuntimeCommand } from "./cli/worker.js";

const program = new Command();

program
  .name("quack")
  .description("Codebase-agnostic background coding agent system")
  .version(packageJson.version);

program
  .command("run <taskId>")
  .description("Execute a single task")
  .option("--dry-run", "Show what would happen without executing")
  .option("--skip-gate", "Skip LLM readiness gate (use with --dry-run)")
  .option(
    "--skip-depth-only",
    "Skip depth evaluation and enrichment but keep deterministic gate checks",
  )
  .option("--project <path>", "Path to project root (default: cwd)")
  .option("--model <model>", "Override agent model")
  .option("--max-turns <n>", "Override max turns", parseInt)
  .option("--max-budget <n>", "Override max budget (USD)", parseFloat)
  .option("--output-format <format>", "Output format: text (default) or stream-json")
  .option("--resume", "Resume from a previous checkpoint instead of starting fresh")
  .option("--force-clean", "Delete existing branch and checkpoint, start fresh")
  .option(
    "--override-paused-run",
    "Discard a run paused at a human gate (its branch, checkpoint and pending record are archived first)",
  )
  .action(
    (
      taskId: string,
      options: {
        dryRun?: boolean;
        skipGate?: boolean;
        skipDepthOnly?: boolean;
        project?: string;
        model?: string;
        maxTurns?: number;
        maxBudget?: number;
        outputFormat?: string;
        resume?: boolean;
        forceClean?: boolean;
        overridePausedRun?: boolean;
      },
    ) => {
      void runCommand(taskId, options);
    },
  );

program
  .command("wave <waveNumber>")
  .description("Batch execute a wave of tasks")
  .option("--parallel <count>", "Number of parallel tasks", "1")
  .option("--project <path>", "Path to project root (default: cwd)")
  .action((waveNumber: string, options: { parallel: string; project?: string }) => {
    void waveCommand(waveNumber, options);
  });

program
  .command("verify <taskId>")
  .description("Run verification only (no agent)")
  .option("--project <path>", "Path to project root (default: cwd)")
  .action((taskId: string, options: { project?: string }) => {
    void verifyCommand(taskId, options);
  });

program
  .command("enrich <taskId>")
  .description("Run readiness gate + enrichment only")
  .option("--project <path>", "Path to project root (default: cwd)")
  .action((taskId: string, options: { project?: string }) => {
    void enrichCommand(taskId, options);
  });

program
  .command("init <projectPath>")
  .description("Bootstrap adapter for a new project")
  .option("--project <path>", "Path to project root (default: cwd)")
  .option("--analyze", "Run intelligent analysis (validates commands, LLM strategy advisor)")
  .action((projectPath: string, options: { project?: string; analyze?: boolean }) => {
    void initCommand(projectPath, options);
  });

program
  .command("status")
  .description("Show task backlog status")
  .option("--project <path>", "Path to project root (default: cwd)")
  .action((options: { project?: string }) => {
    void statusCommand(options);
  });

program
  .command("monitor")
  .description("Start the headnode web monitoring dashboard")
  .option("--port <port>", "HTTP port (default: 3333)", "3333")
  .option("--host <host>", "Bind host (default: 127.0.0.1)", "127.0.0.1")
  .option(
    "--project <path>",
    "Path to project root (default: cwd, repeatable for multi-project)",
    (value, previous: string[] | string | undefined) => {
      // Collect multiple --project flags into an array
      if (Array.isArray(previous)) {
        return [...previous, value];
      } else if (previous) {
        return [previous, value];
      } else {
        return [value];
      }
    },
  )
  .action((options: { port?: string; host?: string; project?: string | string[] }) => {
    void monitorCommand(options);
  });

program
  .command("worker-runtime")
  .description("Start the headless loopback worker runtime")
  .option("--port <port>", "HTTP port (default: 3337)", "3337")
  .option("--host <host>", "Bind host (default: 127.0.0.1)", "127.0.0.1")
  .option(
    "--project <path>",
    "Path to project root (repeatable for multi-project)",
    (value, previous: string[] | string | undefined) => {
      if (Array.isArray(previous)) {
        return [...previous, value];
      } else if (previous) {
        return [previous, value];
      }
      return [value];
    },
  )
  .action((options: { port?: string; host?: string; project?: string | string[] }) => {
    void workerRuntimeCommand(options);
  });

const workerProgram = program
  .command("worker")
  .description("Worker runtime, enrollment, and install helpers");

workerProgram
  .command("runtime")
  .description("Start the headless loopback worker runtime")
  .option("--port <port>", "HTTP port (default: 3337)", "3337")
  .option("--host <host>", "Bind host (default: 127.0.0.1)", "127.0.0.1")
  .option(
    "--project <path>",
    "Path to project root (repeatable for multi-project)",
    (value, previous: string[] | string | undefined) => {
      if (Array.isArray(previous)) {
        return [...previous, value];
      } else if (previous) {
        return [previous, value];
      }
      return [value];
    },
  )
  .action((options: { port?: string; host?: string; project?: string | string[] }) => {
    void workerRuntimeCommand(options);
  });

workerProgram
  .command("enroll")
  .description("Create a one-time worker enrollment bundle from the headnode")
  .requiredOption("--host-id <id>", "Stable worker host ID")
  .option("--alias <name>", "Human-friendly worker alias")
  .option("--profile-id <id>", "Worker enrollment profile ID")
  .option("--project-id <id>", "Project binding for the enrollment")
  .option("--runtime-port <port>", "Override worker runtime port")
  .option("--max-concurrent-jobs <count>", "Override max concurrent jobs")
  .option("--capabilities <csv>", "Comma-separated requested capabilities override")
  .option("--persistence <mode>", "Override persistence mode from the worker profile")
  .option("--ttl-minutes <n>", "Enrollment TTL in minutes")
  .option(
    "--target-root-windows <path>",
    "Populate the Windows bootstrap command with a concrete worker root",
  )
  .option(
    "--target-root-posix <path>",
    "Populate the POSIX bootstrap command with a concrete worker root",
  )
  .option("--control-base-url <url>", "Headnode control-plane base URL", "http://127.0.0.1:3333")
  .option("--api-key <key>", "Dashboard API key for auth-enabled headnodes (or use QUACK_API_KEY)")
  .option("--bundle", "Print a contributor-ready onboarding bundle")
  .option("--json", "Print the raw enrollment payload JSON")
  .action(
    (options: {
      controlBaseUrl?: string;
      apiKey?: string;
      hostId?: string;
      alias?: string;
      profileId?: string;
      projectId?: string;
      runtimePort?: string;
      maxConcurrentJobs?: string;
      capabilities?: string;
      persistence?: "manual" | "run-key" | "scheduled-task-logon" | "scheduled-task-startup";
      ttlMinutes?: string;
      targetRootWindows?: string;
      targetRootPosix?: string;
      json?: boolean;
      bundle?: boolean;
    }) => {
      void workerEnrollCommand(options);
    },
  );

workerProgram
  .command("install")
  .description("Consume a worker enrollment bootstrap token and prepare a worker host")
  .requiredOption("--bootstrap-token <token>", "One-time bootstrap token from the headnode")
  .option("--control-base-url <url>", "Headnode control-plane base URL", "http://127.0.0.1:3333")
  .option(
    "--target-root <path>",
    "Worker root directory (default: cwd or the parent of an existing Quack checkout)",
  )
  .option(
    "--listener-base-url <url>",
    "Advertised listener URL (auto-detected from Tailscale when omitted)",
  )
  .option("--persistence <mode>", "Override persistence mode from the manifest")
  .option("--repair", "Refresh an existing worker root with the same manifest-driven install path")
  .option("--start", "Explicitly start the runtime/listener after preparing the worker")
  .option("--no-start", "Prepare files and repos but do not start the runtime/listener")
  .option("--dry-run", "Print the install actions without executing them")
  .action(
    (options: {
      bootstrapToken: string;
      controlBaseUrl?: string;
      targetRoot?: string;
      listenerBaseUrl?: string;
      persistence?: "manual" | "run-key" | "scheduled-task-logon" | "scheduled-task-startup";
      repair?: boolean;
      start?: boolean;
      dryRun?: boolean;
    }) => {
      void workerInstallCommand(options);
    },
  );

program
  .command("prep <taskId>")
  .description("Run gate checks and cache result (used by monitor API)")
  .option("--project <path>", "Path to project root (default: cwd)")
  .action((taskId: string, options: { project?: string }) => {
    void prepCommand(taskId, options);
  });

program
  .command("preflight <taskId>")
  .description("Run pre-flight pipeline (gate + blueprint + context estimate + complexity)")
  .option("--project <path>", "Path to project root (default: cwd)")
  .option("--json", "Output machine-readable JSON")
  .option("--force", "Skip cache and re-run")
  .action((taskId: string, options: { project?: string; json?: boolean; force?: boolean }) => {
    void preflightCommand(taskId, options);
  });

program
  .command("plan <prompt>")
  .description("Generate task specs from a raw prompt")
  .option("--project <path>", "Path to project root (default: cwd)")
  .option("--model <model>", "Override planner model")
  .option("--max-tasks <n>", "Max tasks to generate (default: 10)", parseInt)
  .option("--dry-run", "Print generated specs without writing files")
  .option("--start-id <n>", "Starting task number (auto-detect if not provided)", parseInt)
  .action(
    (
      prompt: string,
      options: {
        project?: string;
        model?: string;
        maxTasks?: number;
        dryRun?: boolean;
        startId?: number;
      },
    ) => {
      void planCommand(prompt, options);
    },
  );

program
  .command("decompose <taskId>")
  .description("Decompose a complex task into focused subtasks (staged: plan|materialize|finalize)")
  .option("--project <path>", "Path to project root (default: cwd)")
  .option("--mode <mode>", "Staged mode: plan (default), materialize, or finalize")
  .option("--dry-run", "Alias for --mode plan (backward compat)")
  .option("--plan-file <path>", "Path to topology JSON from a previous plan run")
  .option("--drafts-file <path>", "Path to drafts JSON from a previous materialize run")
  .option("--review-acknowledged", "Acknowledge child draft review (required for finalize)")
  .option("--enqueue", "Enqueue subtasks in dispatch queue after finalize")
  .option("--max-subtasks <n>", "Max subtasks to generate, 2-6 (default: 4)", parseInt)
  .option("--port <n>", "Monitor server port for enqueue (default: 3333)", parseInt)
  .action(
    (
      taskId: string,
      options: {
        project?: string;
        mode?: string;
        dryRun?: boolean;
        planFile?: string;
        draftsFile?: string;
        reviewAcknowledged?: boolean;
        enqueue?: boolean;
        maxSubtasks?: number;
        port?: number;
      },
    ) => {
      const typedMode = options.mode as "plan" | "materialize" | "finalize" | undefined;
      void decomposeCommand(taskId, { ...options, mode: typedMode });
    },
  );

program
  .command("repair-specs")
  .description(
    "Deterministically normalize task specs that fail to parse (intent-safe: envelope fixes and gating TBD placeholders only; dry-run by default)",
  )
  .argument("<dir>", "Directory containing TASK-*.md / SAURUS-REM-*.md specs")
  .option("--write", "Write repaired specs back to disk (default: dry-run report)")
  .option("--json", "Output a JSON report")
  .action((dir: string, options: { write?: boolean; json?: boolean }) => {
    void repairSpecsCommand(dir, options);
  });

program
  .command("repair-db")
  .description("Inspect, back up, and optionally rebuild a project's Quack SQLite DB")
  .option("--project <path>", "Path to project root (default: cwd)")
  .option("--db-path <path>", "Explicit path to quack.db (overrides --project)")
  .option("--rebuild", "Replace the DB after backing up existing artifacts")
  .action((options: { project?: string; dbPath?: string; rebuild?: boolean }) => {
    repairDbCommand(options);
  });

program
  .command("repair-state")
  .description(
    "Rebuild/reconcile a project's Quack DB, verification projection, and peer sync state",
  )
  .option("--project <path>", "Path to project root (default: cwd)")
  .option("--db-path <path>", "Explicit path to quack.db (overrides --project)")
  .option("--rebuild-db", "Replace the DB after backing up existing artifacts")
  .option("--peer-url <url>", "Headnode base URL for federation verified sync")
  .option("--peer-project-id <id>", "Remote project id for federation verified sync")
  .option(
    "--service-token <token>",
    "Literal service token to use now (or persist when no env var is supplied)",
  )
  .option(
    "--service-token-env <name>",
    "Env var name to persist in peer.json (for example QUACK_SERVICE_TOKEN)",
  )
  .option("--write-peer-config", "Write/update .quack/federation/peer.json before reconciling")
  .option("--no-pull-peer", "Skip the verified-row pull even when peer config exists")
  .option("--migrate-generated-projections", "Inspect or migrate generated projection git hygiene")
  .option("--dry-run", "Preview generated projection migration actions without writing")
  .option("--apply", "Apply generated projection migration actions")
  .action(
    (options: {
      project?: string;
      dbPath?: string;
      rebuildDb?: boolean;
      peerUrl?: string;
      peerProjectId?: string;
      serviceToken?: string;
      serviceTokenEnv?: string;
      writePeerConfig?: boolean;
      pullPeer?: boolean;
      migrateGeneratedProjections?: boolean;
      dryRun?: boolean;
      apply?: boolean;
    }) => {
      void repairStateCommand(options);
    },
  );

program
  .command("repair-federation-lock <jobId>")
  .description("Inspect or explicitly recover one stale pre-v2 federation lock while offline")
  .option("--project <path>", "Path to project root (default: cwd)")
  .option("--stale-ms <milliseconds>", "Minimum lock age (default: 30000)")
  .option("--apply", "Apply the inspected recovery transaction")
  .option("--confirm-offline", "Attest every Quack process sharing the project is stopped")
  .option("--expected-fingerprint <sha256>", "Bind apply to the exact dry-run evidence")
  .action(
    (
      jobId: string,
      options: {
        project?: string;
        staleMs?: string;
        apply?: boolean;
        confirmOffline?: boolean;
        expectedFingerprint?: string;
      },
    ) => {
      void repairFederationLockCommand(jobId, options);
    },
  );

program
  .command("queue [taskIds...]")
  .description("Queue management (enqueue, start, pause, status)")
  .option("--all", "Enqueue all eligible tasks")
  .option("--start", "Start processing the queue")
  .option("--pause", "Pause the queue")
  .option("--resume", "Resume from paused state")
  .option("--stop", "Stop the queue (wait for running tasks)")
  .option("--abort", "Abort the queue (kill running tasks)")
  .option("--status", "Show queue status")
  .option("--port <n>", "Monitor port (default: 3333)", "3333")
  .option("--project <path>", "Path to project root (default: cwd)")
  .action(
    (
      taskIds: string[],
      options: {
        all?: boolean;
        start?: boolean;
        pause?: boolean;
        resume?: boolean;
        stop?: boolean;
        abort?: boolean;
        status?: boolean;
        port?: string;
        project?: string;
      },
    ) => {
      void queueCommand(taskIds, options);
    },
  );

program
  .command("import")
  .description("Import GitHub issue as task spec")
  .requiredOption("--from <source>", "Import source (only 'github' supported)")
  .option("--issue <number>", "Issue number to import", parseInt)
  .option("--label <label>", "Import all issues with label")
  .option("--auto-dispatch", "Auto-dispatch after import (skip gate)")
  .option("--project <path>", "Path to project root (default: cwd)")
  .action(
    (options: {
      from: string;
      issue?: number;
      label?: string;
      autoDispatch?: boolean;
      project?: string;
    }) => {
      void handleImport(options);
    },
  );

program
  .command("publish [taskId]")
  .description("Publish task spec to GitHub as issue")
  .option("--all-backlog", "Publish all BACKLOG tasks")
  .option("--project <path>", "Path to project root (default: cwd)")
  .action((taskId: string | undefined, options: { allBacklog?: boolean; project?: string }) => {
    void handlePublish({ taskId, ...options });
  });

program
  .command("migrate-github-sync-map")
  .description("Migrate legacy GitHub sync-map task ids to declared ids")
  .requiredOption("--project <path>", "Path to the project root")
  .option("--dry-run", "Print the exact report without writing map or report files")
  .action((options: { project: string; dryRun?: boolean }) => {
    void migrateGitHubSyncMap(options);
  });

program
  .command("sync")
  .description("Sync task status with GitHub issues")
  .option("--github", "Force full sync to GitHub")
  .option("--status", "Show sync status")
  .option("--project <path>", "Path to project root (default: cwd)")
  .action((options: { github?: boolean; status?: boolean; project?: string }) => {
    void handleSync(options);
  });

program
  .command("templates")
  .description("Task template library management")
  .option("--rebuild", "Rebuild template registry from all completed tasks")
  .option("--list", "List templates grouped by category")
  .option("--match <taskId>", "Find best matching template for a task")
  .option("--project <path>", "Path to project root (default: cwd)")
  .action((options: { rebuild?: boolean; list?: boolean; match?: string; project?: string }) => {
    void templatesCommand(options);
  });

program
  .command("revise <taskId>")
  .description("Re-dispatch a task with revision feedback")
  .option("--feedback <text>", "Revision feedback")
  .option("--from-pr <number>", "Extract feedback from PR number", parseInt)
  .option("--max-budget <n>", "Override max budget (USD)", parseFloat)
  .option("--max-turns <n>", "Override max turns", parseInt)
  .option("--project <path>", "Path to project root (default: cwd)")
  .action(
    (
      taskId: string,
      options: {
        feedback?: string;
        fromPr?: number;
        maxBudget?: number;
        maxTurns?: number;
        project?: string;
      },
    ) => {
      void reviseCommand(taskId, options);
    },
  );

program
  .command("projects")
  .description("Manage the global project registry")
  .option("--add <path>", "Register a project by path")
  .option("--remove <path>", "Unregister a project by path")
  .option("--set-auto-prep <bool>", "Set autoPrep for cwd project (true/false)")
  .option("--set-auto-preflight <bool>", "Set autoPreflight for cwd project (true/false)")
  .option("--port <port>", "Set default monitor port")
  .action(
    (options: {
      add?: string;
      remove?: string;
      setAutoPrep?: string;
      setAutoPreflight?: string;
      port?: string;
    }) => {
      void projectsCommand(options);
    },
  );

program
  .command("overnight")
  .description("Run a guarded overnight prep/dispatch/verify loop")
  .option("--project <path>", "Path to project root (default: cwd)")
  .option("--monitor-url <url>", "Monitor base URL (default: http://localhost:3333)")
  .option("--task-ids <ids>", "Comma/space separated task IDs to process")
  .option("--source-branch <branch>", "Inventory task files changed on this branch")
  .option("--target-branch <branch>", "Branch to diff source branch against (default: dev)")
  .option("--checkpoint <path>", "Checkpoint JSON path")
  .option("--min-score <n>", "Minimum prep depth score (default: 4.5)")
  .option("--max-prep-attempts <n>", "Max prep attempts before manual_review (default: 2)")
  .option("--max-enrichment-attempts <n>", "Max auto-enrichment attempts (default: 1)")
  .option("--max-dispatch-attempts <n>", "Max dispatch attempts per task (default: 1)")
  .option("--max-dispatches <n>", "Max dispatches to start in this runner invocation")
  .option(
    "--active-dispatch-limit <n>",
    "Allowed active dispatches before waiting/halting (default: 1)",
  )
  .option(
    "--poll-interval-ms <n>",
    "Wait interval when the dispatch lane is occupied (default: 60000)",
  )
  .option(
    "--auto-enrich",
    "Call monitor enrichment for low-score tasks and approve returned content",
  )
  .option(
    "--no-auto-decompose",
    "Do not automatically write subtasks when preflight recommends decomposition",
  )
  .option(
    "--max-subtasks <n>",
    "Maximum subtasks to generate when auto-decomposing, 2-6 (default: 4)",
  )
  .option("--no-verify-after-dispatch", "Do not call the verify API after approved dispatches")
  .option("--full-gate", "Do not skip the gate on dispatch, even after prep passes")
  .option("--allow-parse-errors", "Warn/checkpoint parse errors instead of halting")
  .option("--max-infra-failures <n>", "Quack infra failures allowed before halting (default: 1)")
  .option("--max-budget-usd <n>", "Stop when observed session cost reaches this cap")
  .option(
    "--dry-run",
    "Build/update the in-memory plan without monitor mutations or checkpoint writes",
  )
  .option("--once", "Run one lane action and exit")
  .option("--max-cycles <n>", "Safety cap on loop cycles")
  .option("--model <model>", "Override worker model for dispatch")
  .option("--max-turns <n>", "Override worker max turns", parseInt)
  .option("--max-budget <n>", "Override worker max budget", parseFloat)
  .option(
    "--federation-dispatch",
    "Dispatch through /v1/federation/queue (requires QUACK_SERVICE_TOKEN; auto-enabled when token is set)",
  )
  .option(
    "--preferred-host-id <hostId>",
    "Preferred federation host for dispatched jobs (e.g. headnode)",
  )
  .option(
    "--allow-low-preflight-on-federation-dispatch",
    "Pass allowLowPreflight:true to the federation queue",
  )
  .option(
    "--auto-acknowledge-decompose-review",
    "Automatically finalize decomposed subtasks without operator review (use with caution in unattended runs)",
  )
  .action(
    (options: {
      project?: string;
      monitorUrl?: string;
      taskIds?: string;
      sourceBranch?: string;
      targetBranch?: string;
      checkpoint?: string;
      minScore?: string;
      maxPrepAttempts?: string;
      maxEnrichmentAttempts?: string;
      maxDispatchAttempts?: string;
      maxDispatches?: string;
      activeDispatchLimit?: string;
      pollIntervalMs?: string;
      autoEnrich?: boolean;
      autoDecompose?: boolean;
      maxSubtasks?: string;
      noVerifyAfterDispatch?: boolean;
      fullGate?: boolean;
      allowParseErrors?: boolean;
      maxInfraFailures?: string;
      maxBudgetUsd?: string;
      dryRun?: boolean;
      once?: boolean;
      maxCycles?: string;
      model?: string;
      maxTurns?: string;
      maxBudget?: string;
      federationDispatch?: boolean;
      preferredHostId?: string;
      allowLowPreflightOnFederationDispatch?: boolean;
      autoAcknowledgeDecomposeReview?: boolean;
    }) => {
      void overnightCommand(options);
    },
  );

program.parse();
