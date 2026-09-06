// ─── Dispatch Manager ──────────────────────────────────────────────
// Manages child processes for task dispatch. Spawns `node dist/index.js
// run TASK-NNN` as a subprocess so the Agent SDK can create its own
// Claude Code session (avoiding the nested session blocker).
//
// Uses git worktrees for branch isolation: each dispatched task runs in
// its own worktree so branch switches don't affect the main working
// directory. Falls back to shared working directory if worktrees fail.
//
// The dispatch writes JSONL events to .quack/logs/ — the monitor's
// existing chokidar watcher picks them up and streams via SSE.

import { spawn, execSync, execFileSync, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type {
  AdapterFreshnessMetadata,
  BranchCleanupOwnerOverride,
  BranchCleanupPolicyConfig,
  IsolationConfig,
} from "../core/types.js";
import { resolvePrepStorageDirSync } from "../core/prep-storage.js";
import { computeAdapterBundleMetadata } from "../core/adapter-loader.js";
import { AdapterConfigSchema } from "../core/adapter-schema.js";
import {
  assertBranchDeletionAllowed,
  DEFAULT_PROTECTED_BRANCHES,
} from "../judgment/producers/branch-mutation.js";

/** Tier-S companion FILES the worktree refresh copies + hashes (TASK-1313). */
const MACHINERY_ASSET_FILES = [
  "adapter.json",
  "conventions.md",
  "judge-criteria.md",
  "verify.js",
] as const;
import { DockerManager, type DockerContainer } from "../dispatcher/docker-manager.js";
import { appendDispatchChildExit } from "./child-exit-log.js";
import { cleanupWorktreeContainers } from "../dispatcher/docker-cleanup.js";
import {
  removeWorktree as lifecycleRemoveWorktree,
  prepareWorktreeFrontendDeps,
} from "../dispatcher/worktree-lifecycle.js";
import { isRateLimitError, parseRetryAfter, type KeyManager } from "../dispatcher/key-manager.js";
import {
  archivePausedRunState,
  PausedRunRefusalError,
  resolvePausedRunState,
} from "../dispatcher/paused-run-state.js";
import type { JobProvenance } from "./federation/types.js";
import { readSpecStaleMarker, recoveryAdviceFor } from "../core/spec-identity.js";
import {
  assertUncontestedClaimant,
  type DuplicateClaimantCheck,
} from "../core/duplicate-claimants.js";

export interface DispatchJob {
  taskId: string;
  sessionId: string;
  pid: number;
  startedAt: string;
  status: "running" | "completed" | "failed" | "stopped" | "awaiting_approval";
  exitCode?: number;
  output: string[];
  worktreePath?: string;
  /** QPI-043: the signal that terminated the child, when it was killed
   *  rather than exiting on its own. Absent for a normal exit. */
  killedBySignal?: string;
  /**
   * TASK-1332 (QPI-045, round-2 R2-5): this run REFUSED to consume an
   * artifact whose spec contract had moved, rather than crashing. The
   * job still reads `failed` because the child exited non-zero and the
   * status union is consumed in many places, but a refusal must not be
   * triaged as a crash. Stale artifacts recover by replan; contested
   * ownership recovers by removing or renaming the extra claimant file.
   * Decided from a durable on-disk marker, not a lifecycle callback.
   */
  specStale?: { verdict: string; reason: string; refusedAt: string };
  branchName?: string;
  commitSha?: string;
  containerId?: string;
  /** Which API key ID was used for this dispatch (e.g. "key-1", "key-2") */
  keyId?: string;
  federatedJobId?: string;
  federatedHostId?: string;
  federatedHostAlias?: string;
  federatedHostEndpoint?: string;
  federatedLeaseId?: string;
  /** TASK-1323: how this dispatch entered the system (channel + identity + origin). */
  provenance?: JobProvenance;
}

export interface StartOptions {
  skipGate?: boolean;
  skipDepthOnly?: boolean;
  model?: string;
  maxTurns?: number;
  maxBudget?: number;
  resume?: boolean;
  parentTaskId?: string;
  sharedBranchName?: string;
  /** Judge feedback to inject as retry context (used by force-retry) */
  judgeFeedback?: string;
  /** Reuse existing worktree if present (used by revision dispatch) */
  reuseWorktree?: boolean;
  /** Force clean start: delete existing branch + checkpoint regardless of state */
  forceClean?: boolean;
  /**
   * TASK-1326 (QPI-042): proceed even though this task is paused at a
   * human gate, archiving the paused run's state first. An EXPLICIT
   * operator decision — never inferred from request shape or a header
   * (the TASK-1323 F1 lesson).
   */
  overridePausedRun?: boolean;
  /** Federated scheduler job id when a listener starts local work for a leased job. */
  federatedJobId?: string;
  /** Federated worker/listener host id for worker provenance. */
  federatedHostId?: string;
  /** Human label for the worker host, if known. */
  federatedHostAlias?: string;
  /** Base URL or endpoint label for the worker host, if known. */
  federatedHostEndpoint?: string;
  /** Active lease id assigned by the headnode scheduler. */
  federatedLeaseId?: string;
  /** TASK-1323: entry provenance, stamped by the calling surface (HTTP
   *  routes derive it from route + request shape). When a caller fails
   *  to stamp it, `start()` falls back to an api-direct record with the
   *  marker principal `unattributed-local-start` — every current caller
   *  is an HTTP handler or a queue item enqueued by one, so the channel
   *  is honest and the principal flags the imprecision. */
  provenance?: JobProvenance;
  /** Prebuilt async claimant result for the synchronous start seam. */
  duplicateClaimantCheck?: DuplicateClaimantCheck;
}

export type DispatchEventCallback = (
  stage:
    | "container_created"
    | "container_stopped"
    | "container_error"
    | "worktree_failed"
    // QPI-043: how the dispatch child STOPPED (exit code and, crucially,
    // the SIGNAL). Reported through this typed lifecycle callback so it
    // reaches the durable event log; the in-memory job record does not
    // survive a monitor restart, which is exactly how the first attempt
    // at this instrumentation was lost.
    | "dispatch_child_exit"
    // TASK-1313 S5 (round-2 F7): the stale-branch deletion guard fires
    // BEFORE any event session exists, so its refusal reports through
    // this typed lifecycle callback rather than a premature session.
    | "branch_guard_refusal"
    // TASK-1326: an operator overrode a gate pause and the prior run's
    // branch/checkpoint/pend were archived. Durable by the same
    // reasoning as dispatch_child_exit — an archive nobody can find is
    // a deletion with extra steps.
    | "paused_run_archived",
  taskId: string,
  payload: Record<string, unknown>,
) => void;

export interface ManagedWorktreeRecord {
  taskId: string;
  path: string;
  rootKind: "quack" | "hermes" | "claude";
  exists: boolean;
  registered: boolean;
  branchName?: string;
  owner?: string;
  ownerProvenance: string[];
  allowedPrefix?: string;
  protectedOwner: boolean;
  requiresOwnerOverride: boolean;
  lastModifiedAt?: string;
  ageMs: number;
  jobStatus?: DispatchJob["status"];
  activeJob: boolean;
  dirty: boolean;
  evidenceFiles: string[];
  pruneEligible: boolean;
  skipReasons: string[];
}

export interface ManagedWorktreeCleanupResult {
  checkedAt: string;
  dryRun: boolean;
  maxAgeMs: number;
  policy: ResolvedWorktreeCleanupPolicy;
  scanned: number;
  pruneEligible: number;
  candidates: ManagedWorktreeRecord[];
  pruned: string[];
  retained: ManagedWorktreeRecord[];
}

/** Default max runtime before watchdog kills a stuck dispatch (2 hours) */
const DEFAULT_WATCHDOG_TIMEOUT_MS = 2 * 60 * 60 * 1000;
const DEFAULT_BRANCH_RETENTION_DAYS = 1;
const DEFAULT_ALLOWED_BRANCH_PREFIXES = ["quack/TASK-"];
const DEFAULT_PROTECTED_OWNERS = ["contributor"];
const DEFAULT_PROTECTED_PATTERNS = ["contributor/**", "*/contributor/**"];

type ManagedWorktreeRootKind = ManagedWorktreeRecord["rootKind"];

interface ManagedWorktreeRoot {
  kind: ManagedWorktreeRootKind;
  root: string;
}

interface ResolvedWorktreeCleanupPolicy {
  enabled: boolean;
  retentionDays: number;
  allowedPrefixes: string[];
  protectedOwners: string[];
  protectedPatterns: string[];
  requireOwnerOverride: boolean;
}

function pathExistsViaLstat(candidate: string): boolean {
  try {
    fs.lstatSync(candidate);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ENOENT";
  }
}

function shortHash(hash: string | undefined): string {
  if (!hash) return "unknown";
  return hash.length > 19 ? `${hash.slice(0, 19)}...` : hash;
}

function globToRegExp(pattern: string): RegExp {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*\*/g, ".*")
    .replace(/\*/g, "[^/]*");
  return new RegExp(`^${escaped}$`, "i");
}

function matchesPattern(value: string, patterns: string[]): string | undefined {
  return patterns.find((pattern) => globToRegExp(pattern).test(value));
}

function normalizeOwner(value: string | undefined): string | undefined {
  const trimmed = value?.trim().toLowerCase();
  return trimmed || undefined;
}

function allowedPrefixForBranch(
  branch: string | undefined,
  allowedPrefixes: string[],
): string | undefined {
  if (!branch) return undefined;
  return allowedPrefixes.find((prefix) => branch.startsWith(prefix));
}

export class DispatchManager {
  private jobs = new Map<string, DispatchJob>();
  private processes = new Map<string, ChildProcess>();
  private dockerManager: DockerManager | null = null;
  private onEvent?: DispatchEventCallback;
  private keyManager?: KeyManager;
  private watchdogTimer?: ReturnType<typeof setInterval>;
  /** Set to true when worktree creation fails — blocks parallel dispatch */
  private worktreeDegraded = false;

  /** Where the durable event jsonl files live (QPI-043 exit facts). */
  private readonly logDir: string;

  constructor(
    private readonly projectRoot: string,
    private readonly quackBin: string,
    private readonly isolationConfig?: IsolationConfig,
    keyManager?: KeyManager,
    logDir?: string,
    private readonly claimantResolver?: (taskId: string) => Promise<DuplicateClaimantCheck>,
  ) {
    if (isolationConfig?.method === "docker" && isolationConfig.docker) {
      this.dockerManager = new DockerManager(projectRoot, isolationConfig.docker);
    }
    this.keyManager = keyManager;
    this.logDir = logDir ?? path.join(projectRoot, ".quack", "logs");
  }

  private shouldCleanupDockerForWorktree(): boolean {
    return this.isolationConfig?.dockerCleanup !== false;
  }

  private cleanupDockerForWorktree(worktreePath: string): void {
    if (!this.shouldCleanupDockerForWorktree()) return;
    cleanupWorktreeContainers(worktreePath, {
      info: (message: string) => console.log(message),
      warn: (message: string) => console.warn(message),
    });
  }

  private createJunction(targetPath: string, junctionPath: string): void {
    if (pathExistsViaLstat(junctionPath)) return;
    fs.symlinkSync(targetPath, junctionPath, "junction");
  }

  private managedWorktreesRoot(): string {
    return path.join(this.projectRoot, ".quack", "worktrees");
  }

  private managedWorktreeRoots(): ManagedWorktreeRoot[] {
    return [
      { kind: "quack", root: this.managedWorktreesRoot() },
      { kind: "hermes", root: path.join(this.projectRoot, ".hermes-worktrees") },
      { kind: "claude", root: path.join(this.projectRoot, ".claude", "worktrees") },
    ];
  }

  private readBranchCleanupPolicy(): ResolvedWorktreeCleanupPolicy {
    const adapterPath = path.join(this.projectRoot, ".quack", "adapter.json");
    let config: BranchCleanupPolicyConfig | undefined;
    let branchRetentionDays: number | undefined;
    try {
      const raw = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as unknown;
      const parsed = AdapterConfigSchema.safeParse(raw);
      if (parsed.success) {
        config = parsed.data.git.branchCleanup;
        branchRetentionDays = parsed.data.git.branchRetentionDays;
      }
    } catch {
      // Missing or invalid adapter config falls back to conservative policy.
    }

    return {
      enabled: config?.enabled ?? true,
      retentionDays: config?.retentionDays ?? branchRetentionDays ?? DEFAULT_BRANCH_RETENTION_DAYS,
      allowedPrefixes: config?.allowedPrefixes ?? DEFAULT_ALLOWED_BRANCH_PREFIXES,
      protectedOwners: (config?.protectedOwners ?? DEFAULT_PROTECTED_OWNERS).map((owner) =>
        owner.toLowerCase(),
      ),
      protectedPatterns: config?.protectedPatterns ?? DEFAULT_PROTECTED_PATTERNS,
      requireOwnerOverride: config?.requireOwnerOverride ?? true,
    };
  }

  private resolveWorktreeOwner(
    kind: ManagedWorktreeRootKind,
    taskId: string,
    branchName: string | undefined,
    policy: ResolvedWorktreeCleanupPolicy,
  ): { owner?: string; provenance: string[]; allowedPrefix?: string } {
    const subject = branchName ?? taskId;
    const lower = subject.toLowerCase();
    const provenance: string[] = [];
    const branchAllowedPrefix = allowedPrefixForBranch(branchName, policy.allowedPrefixes);
    const taskAllowedPrefix = branchName
      ? undefined
      : this.inferAllowedPrefixForUnregisteredWorktree(kind, taskId, policy.allowedPrefixes);

    if (branchAllowedPrefix) provenance.push(`allowedPrefix:${branchAllowedPrefix}`);
    if (taskAllowedPrefix) provenance.push(`inferredPrefix:${taskAllowedPrefix}`);

    const protectedPattern =
      matchesPattern(subject, policy.protectedPatterns) ??
      matchesPattern(taskId, policy.protectedPatterns);
    if (protectedPattern) {
      provenance.push(`protectedPattern:${protectedPattern}`);
      return {
        owner: lower.includes("contributor")
          ? "contributor"
          : normalizeOwner(lower.split(/[/-]/)[0]),
        provenance,
        allowedPrefix: branchAllowedPrefix ?? taskAllowedPrefix,
      };
    }

    if (lower.match(/(^|[/_-])(contributor)([/_-]|$)/)) {
      provenance.push("name:contributor");
      return {
        owner: "contributor",
        provenance,
        allowedPrefix: branchAllowedPrefix ?? taskAllowedPrefix,
      };
    }

    if (branchName?.toLowerCase().startsWith("echo/task-") || kind === "hermes") {
      provenance.push(kind === "hermes" ? "root:.hermes-worktrees" : "prefix:echo/TASK-");
      return {
        owner: "hermes",
        provenance,
        allowedPrefix: branchAllowedPrefix ?? taskAllowedPrefix,
      };
    }

    if (branchName?.toLowerCase().startsWith("codex/") || kind === "claude") {
      provenance.push(kind === "claude" ? "root:.claude/worktrees" : "prefix:codex/");
      return {
        owner: kind === "claude" ? "claude" : "codex",
        provenance,
        allowedPrefix: branchAllowedPrefix ?? taskAllowedPrefix,
      };
    }

    if (branchName?.toLowerCase().startsWith("quack/task-") || kind === "quack") {
      provenance.push(kind === "quack" ? "root:.quack/worktrees" : "prefix:quack/TASK-");
      return {
        owner: "quack",
        provenance,
        allowedPrefix: branchAllowedPrefix ?? taskAllowedPrefix,
      };
    }

    return {
      provenance,
      allowedPrefix: branchAllowedPrefix ?? taskAllowedPrefix,
    };
  }

  private inferAllowedPrefixForUnregisteredWorktree(
    kind: ManagedWorktreeRootKind,
    taskId: string,
    allowedPrefixes: string[],
  ): string | undefined {
    if (!/^TASK-\d+/i.test(taskId)) return undefined;
    if (kind === "quack" && allowedPrefixes.includes("quack/TASK-")) return "quack/TASK-";
    if (kind === "hermes" && allowedPrefixes.includes("echo/TASK-")) return "echo/TASK-";
    return undefined;
  }

  private readRegisteredWorktreePaths(): Set<string> {
    try {
      const output = execFileSync("git", ["worktree", "list", "--porcelain"], {
        cwd: this.projectRoot,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
      });
      const paths = output
        .split(/\r?\n/)
        .filter((line) => line.startsWith("worktree "))
        .map((line) => line.slice("worktree ".length).trim())
        .filter(Boolean)
        .map((entry) => path.resolve(entry));
      return new Set(paths);
    } catch {
      return new Set<string>();
    }
  }

  listManagedWorktrees(
    maxAgeMs = 24 * 60 * 60 * 1000,
    nowMs = Date.now(),
  ): ManagedWorktreeRecord[] {
    const policy = this.readBranchCleanupPolicy();
    const registeredPaths = this.readRegisteredWorktreePaths();
    const records: ManagedWorktreeRecord[] = [];

    for (const { kind, root } of this.managedWorktreeRoots()) {
      if (!fs.existsSync(root)) continue;
      for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const taskId = entry.name;
        const worktreePath = path.join(root, taskId);
        let stat: fs.Stats | undefined;
        try {
          stat = fs.statSync(worktreePath);
        } catch {
          stat = undefined;
        }
        const ageMs = stat ? Math.max(0, nowMs - stat.mtimeMs) : Number.POSITIVE_INFINITY;
        const registered = registeredPaths.has(path.resolve(worktreePath));
        const job = kind === "quack" ? this.jobs.get(taskId) : undefined;
        const activeJob = job?.status === "running" || job?.status === "awaiting_approval";
        const branchName = registered
          ? this.gitOutput(worktreePath, ["branch", "--show-current"]) || undefined
          : undefined;
        const statusOutput = registered
          ? this.gitOutput(worktreePath, ["status", "--short"])
          : undefined;
        const unpushedCommits = registered
          ? Number(
              this.gitOutput(worktreePath, ["rev-list", "--count", "HEAD", "--not", "--remotes"]) ||
                "0",
            )
          : 0;
        const dirty = typeof statusOutput === "string" && statusOutput.trim().length > 0;
        const evidenceFiles = [
          "PROGRESS.md",
          "claude-progress.txt",
          "HERMES_HANDOFF.md",
          "HANDOFF.md",
        ].filter((fileName) => fs.existsSync(path.join(worktreePath, fileName)));
        const ownership = this.resolveWorktreeOwner(kind, taskId, branchName, policy);
        const protectedOwner = ownership.owner
          ? policy.protectedOwners.includes(ownership.owner)
          : false;
        const requiresOwnerOverride = protectedOwner && policy.requireOwnerOverride;
        const skipReasons: string[] = [];
        if (!policy.enabled) skipReasons.push("cleanup_disabled");
        if (!ownership.allowedPrefix) skipReasons.push("disallowed_prefix");
        if (requiresOwnerOverride) skipReasons.push("protected_owner");
        if (activeJob) skipReasons.push("active_job");
        if (ageMs < maxAgeMs) skipReasons.push("fresh");
        if (evidenceFiles.length > 0) skipReasons.push("evidence_files_present");
        if (dirty) skipReasons.push("dirty_git_state");
        if (unpushedCommits > 0) skipReasons.push("unpushed_commits");
        if (registered && statusOutput === undefined) skipReasons.push("git_status_unavailable");
        if ((kind === "hermes" || kind === "claude") && branchName) {
          skipReasons.push("active_git_branch");
        }
        const pruneEligible = skipReasons.length === 0;

        records.push({
          taskId,
          path: worktreePath,
          rootKind: kind,
          exists: fs.existsSync(worktreePath),
          registered,
          branchName,
          owner: ownership.owner,
          ownerProvenance: ownership.provenance,
          allowedPrefix: ownership.allowedPrefix,
          protectedOwner,
          requiresOwnerOverride,
          lastModifiedAt: stat?.mtime.toISOString(),
          ageMs,
          jobStatus: job?.status,
          activeJob,
          dirty,
          evidenceFiles,
          pruneEligible,
          skipReasons,
        });
      }
    }

    return records.sort((a, b) => a.path.localeCompare(b.path));
  }

  pruneManagedWorktrees(options?: {
    dryRun?: boolean;
    maxAgeMs?: number;
    nowMs?: number;
    ownerOverride?: BranchCleanupOwnerOverride;
  }): ManagedWorktreeCleanupResult {
    const checkedAt = new Date().toISOString();
    const dryRun = options?.dryRun !== false;
    const maxAgeMs = options?.maxAgeMs ?? 24 * 60 * 60 * 1000;
    const policy = this.readBranchCleanupPolicy();
    const records = this.listManagedWorktrees(maxAgeMs, options?.nowMs);
    const overrideOwner = normalizeOwner(options?.ownerOverride?.owner);
    const overrideReason = options?.ownerOverride?.reason.trim();
    const candidates = records.filter((record) => {
      if (record.pruneEligible) return true;
      if (!record.requiresOwnerOverride || !record.owner || !overrideReason) return false;
      if (overrideOwner !== record.owner) return false;
      const remainingSkips = record.skipReasons.filter((reason) => reason !== "protected_owner");
      return remainingSkips.length === 0;
    });
    const pruned: string[] = [];

    if (!dryRun) {
      for (const record of candidates) {
        try {
          this.cleanupDockerForWorktree(record.path);
          this.unlinkJunctions(record.path);
          if (record.registered) {
            execFileSync("git", ["worktree", "remove", record.path, "--force"], {
              cwd: this.projectRoot,
              stdio: ["ignore", "ignore", "ignore"],
            });
          } else {
            fs.rmSync(record.path, { recursive: true, force: true });
          }
          if (fs.existsSync(record.path)) {
            fs.rmSync(record.path, { recursive: true, force: true });
          }
          pruned.push(record.path);
        } catch {
          // Leave failures in retained[] for operator follow-up.
        }
      }
      try {
        execFileSync("git", ["worktree", "prune"], {
          cwd: this.projectRoot,
          stdio: ["ignore", "ignore", "ignore"],
        });
      } catch {
        // Best effort only.
      }
    }

    const retained = dryRun ? records : records.filter((record) => !pruned.includes(record.path));
    return {
      checkedAt,
      dryRun,
      maxAgeMs,
      policy,
      scanned: records.length,
      pruneEligible: candidates.length,
      candidates,
      pruned,
      retained,
    };
  }

  /**
   * Set a callback for container lifecycle events (used by monitor SSE).
   */
  setEventCallback(cb: DispatchEventCallback): void {
    this.onEvent = cb;
  }

  /**
   * Check Docker availability. Call on startup when isolation.method is "docker".
   * Throws if Docker daemon is not reachable.
   */
  async checkDockerAvailability(): Promise<string> {
    if (!this.dockerManager) {
      throw new Error("Docker isolation is not configured");
    }
    return this.dockerManager.checkDocker();
  }

  /**
   * Remove junction symlinks inside a worktree's .quack/ directory
   * BEFORE any recursive directory removal. On Windows, rmSync with
   * recursive:true follows junctions and deletes the target contents.
   * Unlinking first prevents wiping shared log/prep directories.
   */
  private unlinkJunctions(worktreePath: string): void {
    const wtQuack = path.join(worktreePath, ".quack");
    for (const name of ["logs", "prep"]) {
      const junctionPath = path.join(wtQuack, name);
      try {
        const stat = fs.lstatSync(junctionPath);
        if (stat.isSymbolicLink()) {
          fs.unlinkSync(junctionPath);
        }
      } catch {
        // junction doesn't exist or already removed — fine
      }
    }
  }

  private readAdapterBundle(adapterPath: string): string | undefined {
    try {
      const raw = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as unknown;
      const parsed = AdapterConfigSchema.safeParse(raw);
      if (!parsed.success) return undefined;
      return computeAdapterBundleMetadata(parsed.data).sharedHash;
    } catch {
      return undefined;
    }
  }

  private copyAdapterAsset(mainQuack: string, wtQuack: string, fileName: string): void {
    const source = path.join(mainQuack, fileName);
    const target = path.join(wtQuack, fileName);
    if (fs.existsSync(source)) {
      fs.copyFileSync(source, target);
    } else if (fs.existsSync(target)) {
      fs.rmSync(target, { force: true });
    }
  }

  private ensureWorktreeAdapterFreshness(worktreePath: string): AdapterFreshnessMetadata {
    const mainQuack = path.join(this.projectRoot, ".quack");
    const wtQuack = path.join(worktreePath, ".quack");
    const mainAdapter = path.join(mainQuack, "adapter.json");
    const wtAdapter = path.join(wtQuack, "adapter.json");
    const authoritativeHash = this.readAdapterBundle(mainAdapter);

    if (!authoritativeHash) {
      return {
        status: "unknown",
        reason: "authoritative adapter bundle is unavailable or invalid",
      };
    }

    fs.mkdirSync(wtQuack, { recursive: true });
    const localHash = this.readAdapterBundle(wtAdapter);
    // TASK-1313 (round-1 F10): the refresh decision is driven by a
    // SEPARATE machinery-asset hash over the Tier-S companion files —
    // the federation-facing sharedHash (normalized adapter.json only)
    // keeps its external comparison semantics untouched. This closes
    // the companion-file gap: a conventions.md/judge-criteria.md/
    // verify.js drift now triggers a re-copy even when adapter.json is
    // unchanged. (Tier-S DIRECTORIES stay residual here; the worktree
    // copies are seeded at creation and validated by the S3 barrier.)
    const machineryHash = (quackDir: string): string => {
      const hash = createHash("sha256");
      for (const fileName of MACHINERY_ASSET_FILES) {
        const filePath = path.join(quackDir, fileName);
        try {
          hash.update(fileName);
          hash.update(fs.readFileSync(filePath));
        } catch {
          hash.update(`${fileName}:absent`);
        }
      }
      return hash.digest("hex");
    };
    // Round-2 F5: the machinery-hash recopy is gated on an opted-in
    // safetyFloor mode — non-opted adapters keep exactly the pre-1313
    // freshness behavior (adapter.json bundle hash only, 3-file copy).
    const machineryModesActive = ((): boolean => {
      try {
        const raw = JSON.parse(fs.readFileSync(path.join(mainQuack, "adapter.json"), "utf-8")) as {
          judgment?: { safetyFloor?: Record<string, { mode?: string }> };
        };
        const floor = raw.judgment?.safetyFloor;
        if (!floor) return false;
        return Object.values(floor).some(
          (entry) => entry && entry.mode !== undefined && entry.mode !== "off",
        );
      } catch {
        return false;
      }
    })();
    if (
      localHash === authoritativeHash &&
      (!machineryModesActive || machineryHash(wtQuack) === machineryHash(mainQuack))
    ) {
      return { status: "fresh", localHash, authoritativeHash };
    }

    const filesToCopy = machineryModesActive
      ? MACHINERY_ASSET_FILES
      : (["adapter.json", "conventions.md", "judge-criteria.md"] as const);
    for (const fileName of filesToCopy) {
      this.copyAdapterAsset(mainQuack, wtQuack, fileName);
    }

    const refreshedHash = this.readAdapterBundle(wtAdapter);
    if (refreshedHash === authoritativeHash) {
      return {
        status: "refreshed",
        localHash: refreshedHash,
        authoritativeHash,
        reason: localHash
          ? `refreshed stale worktree adapter bundle from ${shortHash(localHash)} to ${shortHash(authoritativeHash)}`
          : "restored missing worktree adapter bundle from authoritative project adapter",
      };
    }

    return {
      status: "stale",
      localHash: refreshedHash ?? localHash,
      authoritativeHash,
      reason:
        "worktree adapter bundle could not be refreshed to match the authoritative project adapter",
    };
  }

  /**
   * Create an isolated git worktree for a task dispatch.
   * Returns the worktree path, or undefined if worktree creation fails
   * (falls back to shared working directory).
   */
  private createWorktree(taskId: string): string | undefined {
    const worktreeBase = path.join(this.projectRoot, ".quack", "worktrees");
    const worktreePath = path.join(worktreeBase, taskId);

    try {
      fs.mkdirSync(worktreeBase, { recursive: true });

      // Clean up stale worktree from a previous failed run.
      // Route through lifecycleRemoveWorktree so any leftover Docker
      // compose services from a previously-crashed dispatch are torn down
      // before the worktree directory is removed.
      if (fs.existsSync(worktreePath)) {
        this.unlinkJunctions(worktreePath);
        const dockerCleanup = this.shouldCleanupDockerForWorktree();
        lifecycleRemoveWorktree(worktreePath, taskId, this.projectRoot, dockerCleanup);
        // Fallback: if git worktree remove failed inside lifecycle, force-remove
        if (fs.existsSync(worktreePath)) {
          try {
            fs.rmSync(worktreePath, { recursive: true, force: true });
          } catch {
            // ignore — best effort
          }
          try {
            execSync("git worktree prune", {
              cwd: this.projectRoot,
              stdio: "ignore",
            });
          } catch {
            // ignore prune failures
          }
        }
      }

      // Delete stale task branch from a previous dispatch (Pattern 22 fix).
      // When a dispatch is killed or fails, the branch retains stale commits.
      // createWorktree() is only called for fresh dispatches (not revision/resume),
      // so deleting the branch here ensures the dispatcher creates a clean one.
      // We read the git config from adapter.json to construct the branch name
      // and choose the canonical remote base for the worktree.
      let branchPrefix = "quack/";
      let baseBranch = "main";
      let configuredProtected: string[] | undefined;
      try {
        const adapterPath = path.join(this.projectRoot, ".quack", "adapter.json");
        if (fs.existsSync(adapterPath)) {
          const adapterJson = JSON.parse(fs.readFileSync(adapterPath, "utf-8")) as {
            git?: {
              baseBranch?: string;
              branchPrefix?: string;
              protectedBranches?: string[];
            };
          };
          branchPrefix = adapterJson?.git?.branchPrefix ?? "quack/";
          baseBranch = adapterJson?.git?.baseBranch ?? "main";
          configuredProtected = adapterJson?.git?.protectedBranches;
        }
      } catch {
        // Use defaults on parse failure
      }
      const staleBranch = `${branchPrefix}${taskId}`;
      // Centralized deletion guard (TASK-1312): this raw `branch -D` is one
      // of the four deletion sites and must never touch a protected branch.
      const protectedSet = [
        ...new Set([...(configuredProtected ?? DEFAULT_PROTECTED_BRANCHES), baseBranch]),
      ];
      const staleGuard = assertBranchDeletionAllowed(staleBranch, protectedSet);
      if (!staleGuard.allowed) {
        console.warn(
          `[dispatch] ${staleGuard.reason ?? "protected branch"} — skipping stale-branch cleanup`,
        );
        this.onEvent?.("branch_guard_refusal", taskId, {
          branch: staleBranch,
          reason: staleGuard.reason ?? "protected branch",
          site: "stale_branch_cleanup",
        });
      } else {
        try {
          execSync(`git rev-parse --verify ${staleBranch}`, {
            cwd: this.projectRoot,
            stdio: "pipe",
          });
          // Branch exists — delete it so the dispatcher creates a fresh one
          execSync(`git branch -D ${staleBranch}`, {
            cwd: this.projectRoot,
            stdio: "pipe",
          });
          console.log(`[dispatch] Deleted stale branch ${staleBranch} for clean re-dispatch`);
        } catch {
          // Branch doesn't exist — nothing to clean
        }
      }

      const baseRef = `origin/${baseBranch}`;
      try {
        execSync(`git fetch origin ${baseBranch}:refs/remotes/origin/${baseBranch}`, {
          cwd: this.projectRoot,
          stdio: "pipe",
        });
        execSync(`git rev-parse --verify ${baseRef}`, {
          cwd: this.projectRoot,
          stdio: "pipe",
        });
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`Failed to refresh ${baseRef} before worktree creation: ${msg}`);
      }

      // Create detached worktree from the freshly fetched remote base. Detached
      // avoids conflicts with branches already checked out in the main worktree.
      execSync(`git worktree add --detach "${worktreePath}" ${baseRef}`, {
        cwd: this.projectRoot,
        encoding: "utf-8",
      });

      // Create junctions for gitignored .quack subdirectories so that
      // events written in the worktree reach the monitor's log watcher.
      const mainQuack = path.join(this.projectRoot, ".quack");
      const wtQuack = path.join(worktreePath, ".quack");
      fs.mkdirSync(wtQuack, { recursive: true });

      // Junction: worktree/.quack/logs → main/.quack/logs
      const mainLogs = path.join(mainQuack, "logs");
      const wtLogs = path.join(wtQuack, "logs");
      fs.mkdirSync(mainLogs, { recursive: true });
      this.createJunction(mainLogs, wtLogs);

      // Junction: worktree/.quack/prep → main/.quack/prep
      const mainPrep = resolvePrepStorageDirSync(this.projectRoot);
      const wtPrep = path.join(wtQuack, "prep");
      if (fs.existsSync(mainPrep)) {
        try {
          this.createJunction(mainPrep, wtPrep);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          console.warn(`[dispatch] prep junction setup failed for ${taskId}: ${msg}`);
        }
      }

      this.ensureWorktreeAdapterFreshness(worktreePath);

      // Symlink frontend/node_modules into the worktree so that
      // `npm run build:frontend` succeeds without a full npm install.
      // frontend/node_modules is gitignored and not materialized by
      // `git worktree add` — this is the root cause of TASK-891 post-judge
      // build failures (Pattern 44). Non-fatal: if the source doesn't exist
      // yet (fresh clone), logs a warning and skips.
      prepareWorktreeFrontendDeps(worktreePath, this.projectRoot, taskId);

      if (this.worktreeDegraded) {
        console.log("[dispatch] Worktree isolation recovered; parallel dispatch re-enabled.");
      }
      this.worktreeDegraded = false;
      return worktreePath;
    } catch (err) {
      // Worktree creation failed — set degraded flag and emit event
      const msg = err instanceof Error ? err.message : String(err);
      console.error(`[dispatch] Worktree creation failed for ${taskId}: ${msg}`);
      console.error(
        "[dispatch] Worktree isolation degraded — parallel dispatch blocked until restart",
      );
      this.worktreeDegraded = true;

      // Emit event so dashboard/SSE can surface the failure
      this.onEvent?.("worktree_failed", taskId, {
        error: msg,
        fallback: "shared_directory",
      });

      // Clean up partial worktree
      try {
        if (fs.existsSync(worktreePath)) {
          this.unlinkJunctions(worktreePath);
          fs.rmSync(worktreePath, { recursive: true, force: true });
        }
        execSync("git worktree prune", {
          cwd: this.projectRoot,
          stdio: "ignore",
        });
      } catch {
        // ignore cleanup failures
      }

      return undefined;
    }
  }

  /**
   * Remove a git worktree after the task dispatch finishes.
   * Delegates docker cleanup + git worktree remove to worktree-lifecycle.ts.
   * Keeps a fallback fs.rmSync for locked-file scenarios (Windows).
   */
  private removeWorktree(worktreePath: string): void {
    const dockerCleanup = this.shouldCleanupDockerForWorktree();
    this.unlinkJunctions(worktreePath);
    // Use worktree-lifecycle as single entry point for docker cleanup + git remove
    lifecycleRemoveWorktree(
      worktreePath,
      this.getTaskIdFromPath(worktreePath),
      this.projectRoot,
      dockerCleanup,
    );
    // Fallback: if git worktree remove failed, try direct filesystem removal
    if (fs.existsSync(worktreePath)) {
      try {
        fs.rmSync(worktreePath, { recursive: true, force: true });
      } catch {
        // ignore — best effort
      }
      try {
        execSync("git worktree prune", {
          cwd: this.projectRoot,
          stdio: "ignore",
        });
      } catch {
        // ignore prune failures
      }
    }
  }

  /**
   * Extract task ID from a worktree path (e.g. .quack/worktrees/TASK-826 -> TASK-826).
   */
  private getTaskIdFromPath(worktreePath: string): string {
    return worktreePath.split("/").pop() ?? worktreePath;
  }

  /**
   * Check if a pending judge approval file exists for the given task,
   * created during or after the given timestamp. Used by the exit handler
   * to detect awaiting_judge_approval exits vs. regular failures.
   */
  /**
   * Is EITHER human gate pending for this dispatch?
   *
   * QPI-041: this used to check only `<taskId>-judge.json`, so a run that
   * paused at the BLUEPRINT gate was not recognised as paused. It exited
   * non-zero (correctly, it had not finished), the parent recorded
   * `failed`, and federation reported "local dispatch failed" with
   * `nextAction: investigate_failed_worker`.
   *
   * In loop mode the brief gate is the FIRST gate every run reaches, so
   * the un-handled case was the common one, and the consequence was not
   * cosmetic: the operator re-POSTed what looked dead, and the re-POST
   * destroyed the paused run's checkpoint (QPI-042).
   */
  private isApprovalPending(taskId: string, afterTimestamp: string): boolean {
    return (
      this.isGateApprovalPending(`${taskId}.json`, afterTimestamp) ||
      this.isGateApprovalPending(`${taskId}-judge.json`, afterTimestamp)
    );
  }

  /**
   * TASK-1332 (QPI-045): a spec-staleness REFUSAL exits non-zero, so
   * without this it is indistinguishable from a crash — the exact
   * misclassification QPI-041 made about a pause. Decided from DISK and
   * scoped to THIS run, so an older refusal never explains a later exit.
   *
   * Round 3 (R3-3): shared by the worktree AND docker exit handlers. The
   * first cut lived inline in the worktree handler only, so every Docker
   * dispatch lost the classification entirely.
   */
  private classifySpecStaleExit(
    job: DispatchJob,
    taskId: string,
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void {
    if (code === 0 || signal) return;
    const stale = readSpecStaleMarker(this.logDir, taskId, job.startedAt);
    if (!stale) return;
    job.specStale = {
      verdict: stale.verdict,
      reason: stale.reason,
      refusedAt: stale.refusedAt,
    };
    // Round 4 (R4-1): the advice FOLLOWS THE VERDICT. This line used to
    // hardcode replan, which contradicted the refusal's own message and,
    // for a `diverged` verdict, sent the operator at the one action that
    // provably reproduces the refusal.
    job.output.push(
      `[dispatch] REFUSED, not crashed: ${stale.reason} ` +
        `Nothing was deleted; the approval record, checkpoint and worktree are ` +
        `intact. ${recoveryAdviceFor(stale.verdict)}`,
    );
  }

  private isGateApprovalPending(fileName: string, afterTimestamp: string): boolean {
    try {
      // Round-2 F3 (partial): this read hardcoded `.quack/logs` while the
      // class already carries the resolved log dir, so on a custom
      // `logging.dir` a real pause was classified as a FAILED exit —
      // QPI-041's symptom, from a different cause. The wider
      // logging.dir threading (resolveTaskRuntimeLogDir, the approve
      // routes) stays with QPI-044; this one line is inside the pause
      // path this task owns.
      const approvalPath = path.join(this.logDir, "approvals", fileName);
      if (!fs.existsSync(approvalPath)) return false;
      const data = JSON.parse(fs.readFileSync(approvalPath, "utf-8")) as {
        state?: string;
        createdAt?: string;
      };
      // Must be pending AND created during this dispatch (not a stale file)
      return (
        data.state === "pending" &&
        !!data.createdAt &&
        new Date(data.createdAt).getTime() >= new Date(afterTimestamp).getTime()
      );
    } catch {
      return false;
    }
  }

  /**
   * Refresh the main working tree after a squash merge lands on the
   * checked-out branch. Without this, new files from the merge exist
   * in git history but not on disk (Pattern 17: Stale Working Tree).
   *
   * Uses `git checkout HEAD -- .` to update the working tree from the
   * latest commit without changing branches. This is safe — it only
   * updates tracked files to match HEAD, preserving untracked files.
   */
  private refreshMainWorkingTree(): void {
    try {
      // Pull the latest commits that were pushed from the worktree
      execSync("git pull --ff-only", {
        cwd: this.projectRoot,
        stdio: "ignore",
        timeout: 15_000,
      });
    } catch {
      // Pull may fail if no remote configured or conflicts — that's ok,
      // the checkout below will still refresh from whatever HEAD is.
    }

    try {
      execSync("git checkout HEAD -- .", {
        cwd: this.projectRoot,
        stdio: "ignore",
        timeout: 15_000,
      });
    } catch {
      // Best-effort — don't fail the job over a refresh failure
    }
  }

  private gitOutput(cwd: string | undefined, args: string[]): string | undefined {
    if (!cwd) return undefined;
    try {
      return execFileSync("git", args, {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 10_000,
      }).trim();
    } catch {
      return undefined;
    }
  }

  private inferBranchNameFromOutput(job: DispatchJob): string | undefined {
    for (const line of [...job.output].reverse()) {
      const match = line.match(/^\s*(?:Branch|Branch preserved):\s+(\S+)/);
      if (match?.[1]) return match[1];
    }
    return undefined;
  }

  private captureGitMetadata(job: DispatchJob, worktreePath?: string): void {
    const branchName =
      job.branchName ??
      this.gitOutput(worktreePath, ["branch", "--show-current"]) ??
      this.inferBranchNameFromOutput(job);

    const commitSha =
      job.commitSha ??
      this.gitOutput(worktreePath, ["rev-parse", "HEAD"]) ??
      (branchName
        ? this.gitOutput(this.projectRoot, ["rev-parse", "--verify", branchName])
        : undefined);

    if (branchName) job.branchName = branchName;
    if (commitSha) job.commitSha = commitSha;
  }

  private processExists(pid: number | undefined): boolean | undefined {
    if (!pid || pid <= 0) return undefined;
    try {
      process.kill(pid, 0);
      return true;
    } catch (err: unknown) {
      const code =
        typeof err === "object" && err && "code" in err
          ? String((err as { code?: unknown }).code)
          : "";
      return code === "EPERM" ? true : false;
    }
  }

  private reconcileRunningJobs(): void {
    for (const [taskId, job] of this.jobs) {
      if (job.status !== "running") continue;

      const child = this.processes.get(taskId);
      const childExitCode = child?.exitCode;
      const childSignalCode = child?.signalCode;
      if (childExitCode !== null && childExitCode !== undefined) {
        job.exitCode = childExitCode;
        job.status = childExitCode === 0 ? "completed" : "failed";
        this.captureGitMetadata(job, job.worktreePath);
        this.processes.delete(taskId);
        continue;
      }
      if (childSignalCode) {
        job.exitCode = job.exitCode ?? 1;
        job.status = "failed";
        job.output.push(
          `[dispatch] Child process exited by signal ${childSignalCode}; marking job failed.`,
        );
        this.captureGitMetadata(job, job.worktreePath);
        this.processes.delete(taskId);
        continue;
      }

      const alive = this.processExists(job.pid);
      if (alive === false) {
        job.exitCode = job.exitCode ?? 1;
        job.status = "failed";
        job.output.push(
          `[dispatch] Child process pid ${job.pid} is no longer alive; marking job failed and preserving worktree.`,
        );
        this.captureGitMetadata(job, job.worktreePath);
        this.processes.delete(taskId);
      }
    }
  }

  /**
   * Start dispatching a task. Returns the job info immediately.
   * Branches between Docker and worktree isolation based on config.
   */
  start(
    taskId: string,
    options?: StartOptions,
    claimantCheck?: DuplicateClaimantCheck,
  ): DispatchJob {
    // Prevent double-dispatch
    const existing = this.getActiveJob(taskId);
    let deleteAwaitingApproval = false;
    if (existing) {
      // Allow resume of tasks awaiting judge approval — the worktree has
      // agent commits that must be preserved for the post-judge session.
      if (existing.status === "awaiting_approval" && options?.resume) {
        deleteAwaitingApproval = true;
      } else if (existing.status === "awaiting_approval") {
        // QPI-045 addendum: this covers BOTH gates (blueprint pend since
        // QPI-041 widened the pause detection), so the message must not
        // claim "judge" — that mislabel sent an operator hunting the
        // wrong gate during the TASK-1273 recycle.
        throw new Error(
          `Task ${taskId} is awaiting human approval at a gate. ` +
            `Approve or reject via the dashboard, or stop the task first.`,
        );
      } else {
        throw new Error(`Task ${taskId} is already running (pid ${existing.pid})`);
      }
    }

    // Block parallel dispatch when worktree isolation is degraded.
    // Without worktrees, all tasks share the same git directory — parallel
    // dispatches would race on branch checkouts and contaminate each other.
    if (this.worktreeDegraded) {
      const activeJobs = this.getActiveJobs().filter(
        (job) => !(deleteAwaitingApproval && job.taskId === taskId),
      );
      if (activeJobs.length > 0) {
        const running = activeJobs.map((j) => j.taskId).join(", ");
        throw new Error(
          `Worktree isolation is degraded (creation failed). ` +
            `Cannot dispatch ${taskId} while ${running} is running in the shared directory. ` +
            `Wait for active tasks to finish, or restart the monitor to retry worktree creation.`,
        );
      }
    }

    // ── TASK-1326 (QPI-042): the DURABLE half of the pause guard ──────
    // The in-memory check above is the same protection read from
    // `this.jobs`, and a monitor restart empties that map (QPI-047) —
    // the very restart that makes the queue look dead and invites the
    // re-POST. This check reads the approval records from DISK, and it
    // MUST stay ahead of startWorktree/startDocker: createWorktree()
    // removes the worktree and force-deletes the task branch, so by the
    // time the child dispatcher could object, the paused judge-gate
    // run's committed work is already gone.
    // Round-2 F1: `resume` does NOT bypass. Every legitimate resume
    // flow decides the pend FIRST — blueprint/judge approve set the
    // state, reject and loop-revise delete the record, replan rejects it
    // — so by the time they call start() there is no pending record and
    // this check is a no-op for them. A generic `/resume` or
    // `quack run --resume` against a STILL-PENDING gate is not those
    // flows: it is the clobber, wearing resume's clothes, and it can
    // reach createWorktree() (and its `branch -D`) whenever the worktree
    // is gone. Only the explicit override proceeds.
    const paused = resolvePausedRunState(this.logDir, taskId);
    if (paused && !options?.overridePausedRun) {
      throw new PausedRunRefusalError(taskId, paused);
    }

    assertUncontestedClaimant(claimantCheck ?? options?.duplicateClaimantCheck);

    if (deleteAwaitingApproval) {
      this.jobs.delete(taskId);
    }

    if (paused) {
      // Fail-closed by design: archivePausedRunState throws rather
      // than let an override proceed over unarchived state.
      const archived = archivePausedRunState(this.projectRoot, this.logDir, taskId, paused);
      this.onEvent?.("paused_run_archived", taskId, {
        taskId,
        gate: paused.gate,
        pendOpenedAt: paused.createdAt,
        ...archived,
      });
      console.log(
        `[dispatch] ${taskId}: operator override of a ${paused.gate}-gate pause; archived ` +
          [archived.branchRef, archived.checkpointPath, archived.approvalPath]
            .filter(Boolean)
            .join(", "),
      );
    }

    // TASK-1323: no dispatch proceeds without provenance. Callers stamp
    // the real channel; this fallback only marks a path that forgot.
    const effectiveOptions: StartOptions = {
      ...(options ?? {}),
      provenance: options?.provenance ?? {
        channel: "api-direct",
        principal: "unattributed-local-start",
      },
    };

    if (this.isolationConfig?.method === "docker" && this.dockerManager) {
      return this.startDocker(taskId, effectiveOptions);
    }
    return this.startWorktree(taskId, effectiveOptions);
  }

  /**
   * Start a task dispatch using git worktree isolation.
   * Falls back to shared working directory if worktrees fail.
   */
  private startWorktree(taskId: string, options?: StartOptions): DispatchJob {
    // Reuse existing worktree for revision or resume dispatches
    // (preserves prior branch + committed changes from stalled runs)
    let worktreePath: string | undefined;
    const shouldReuse = options?.reuseWorktree || options?.resume;
    if (shouldReuse) {
      const existing = path.join(this.projectRoot, ".quack", "worktrees", taskId);
      if (fs.existsSync(existing)) {
        // Verify the worktree has commits from the prior run
        try {
          const commits = execSync(`git -C "${existing}" log --oneline -10`, {
            encoding: "utf-8",
            timeout: 5000,
          }).trim();
          const count = commits ? commits.split("\n").length : 0;
          console.log(
            `[dispatch] Reusing existing worktree for ${taskId} (${count} commits found)`,
          );
        } catch {
          console.log(`[dispatch] Reusing existing worktree for ${taskId} (commit check skipped)`);
        }
        worktreePath = existing;
      } else {
        worktreePath = this.createWorktree(taskId);
      }
    } else {
      worktreePath = this.createWorktree(taskId);
    }
    const workDir = worktreePath ?? this.projectRoot;
    const adapterFreshness = worktreePath
      ? this.ensureWorktreeAdapterFreshness(worktreePath)
      : undefined;
    if (adapterFreshness?.status === "stale") {
      throw new Error(
        `Blocked ${taskId}: stale worktree adapter bundle ` +
          `(local ${shortHash(adapterFreshness.localHash)}, authoritative ${shortHash(adapterFreshness.authoritativeHash)})`,
      );
    }

    // If no worktree, record current branch for restore-after-exit fallback
    let originalBranch: string | undefined;
    if (!worktreePath) {
      try {
        originalBranch = execSync("git rev-parse --abbrev-ref HEAD", {
          cwd: this.projectRoot,
          encoding: "utf-8",
        }).trim();
      } catch {
        // Not a git repo or git not available — skip restore
      }
    }

    const sessionId = `quack-${taskId}-${Date.now()}`;
    const args = ["run", taskId, "--project", workDir];

    if (options?.skipGate) args.push("--skip-gate");
    if (options?.skipDepthOnly) args.push("--skip-depth-only");
    if (options?.resume) args.push("--resume");
    if (options?.forceClean) args.push("--force-clean");
    // TASK-1326: the override decision was made HERE, at the seam that
    // archived the prior run. The child must inherit it or the
    // dispatcher-side guard would refuse the very dispatch the operator
    // just authorized.
    if (options?.overridePausedRun) args.push("--override-paused-run");
    if (options?.model) args.push("--model", options.model);
    if (options?.maxTurns) args.push("--max-turns", String(options.maxTurns));
    if (options?.maxBudget) args.push("--max-budget", String(options.maxBudget));

    // Write judge feedback to a temp file if provided (for force-retry)
    const childEnv: Record<string, string> = {};
    if (options?.judgeFeedback) {
      const feedbackDir = path.join(workDir, ".quack", "logs");
      fs.mkdirSync(feedbackDir, { recursive: true });
      const feedbackPath = path.join(feedbackDir, `retry-feedback-${taskId}.md`);
      fs.writeFileSync(feedbackPath, options.judgeFeedback, "utf-8");
      childEnv.QUACK_RETRY_FEEDBACK = feedbackPath;
    }
    if (options?.federatedJobId) childEnv.QUACK_FEDERATED_JOB_ID = options.federatedJobId;
    if (options?.federatedHostId) childEnv.QUACK_FEDERATED_HOST_ID = options.federatedHostId;
    if (options?.federatedHostAlias)
      childEnv.QUACK_FEDERATED_HOST_ALIAS = options.federatedHostAlias;
    if (options?.federatedHostEndpoint)
      childEnv.QUACK_FEDERATED_HOST_ENDPOINT = options.federatedHostEndpoint;
    if (options?.federatedLeaseId) childEnv.QUACK_FEDERATED_LEASE_ID = options.federatedLeaseId;
    if (options?.provenance) childEnv.QUACK_PROVENANCE = JSON.stringify(options.provenance);

    // Select API key from key manager (if available)
    if (this.keyManager) {
      const selectedKey = this.keyManager.getNextKey();
      if (!selectedKey) {
        throw new Error("All API keys are rate-limited. Wait for cooldown to expire.");
      }
      const keyValue = this.keyManager.getKeyValue(selectedKey.id);
      if (keyValue) {
        childEnv.ANTHROPIC_API_KEY = keyValue;
        childEnv.QUACK_SELECTED_KEY_ID = selectedKey.id; // Track which key was used
      }
    }

    const child = spawn("node", [this.quackBin, ...args], {
      cwd: workDir,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        // Clear CLAUDECODE env var so the Agent SDK doesn't detect nesting
        CLAUDECODE: undefined,
        CLAUDE_CODE: undefined,
        // Clear ANTHROPIC_API_KEY unless the key manager explicitly set one.
        // When absent, the SDK CLI uses the Max subscription's OAuth auth
        // instead of a potentially depleted API key from the parent env.
        ...(childEnv.ANTHROPIC_API_KEY ? {} : { ANTHROPIC_API_KEY: undefined }),
        ...childEnv,
      },
    });

    // Track which key was selected for this dispatch (for rate limit handling + per-key cost)
    const selectedKeyId = childEnv.QUACK_SELECTED_KEY_ID;

    const job: DispatchJob = {
      taskId,
      sessionId,
      pid: child.pid ?? 0,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
      worktreePath,
      keyId: selectedKeyId,
      federatedJobId: options?.federatedJobId,
      federatedHostId: options?.federatedHostId,
      federatedHostAlias: options?.federatedHostAlias,
      federatedHostEndpoint: options?.federatedHostEndpoint,
      federatedLeaseId: options?.federatedLeaseId,
      provenance: options?.provenance,
    };
    if (adapterFreshness) {
      job.output.push(
        `[adapter-freshness] ${adapterFreshness.status}` +
          ` local=${shortHash(adapterFreshness.localHash)} authoritative=${shortHash(adapterFreshness.authoritativeHash)}` +
          (adapterFreshness.reason ? ` (${adapterFreshness.reason})` : ""),
      );
    }

    this.captureProcessOutput(child, job);

    child.on("exit", (code, signal) => {
      void (async () => {
        job.exitCode = code ?? 1;
        // QPI-043: the SIGNAL was being discarded. Node delivers
        // `(code, signal)`, and a process killed by a signal arrives as
        // `code: null, signal: "SIGKILL"`, so `code ?? 1` recorded a
        // SIGKILLed child as a plain exit-1 failure. A child killed from
        // OUTSIDE (the OOM killer, an operator, a supervisor) was
        // therefore indistinguishable from one that failed on its own,
        // and it wrote no stderr because it never ran another line.
        //
        // That is precisely the shape that made TASK-1273 round 2 look
        // like it vanished for no reason. Recording the signal does not
        // prevent the kill; it makes the difference between "it crashed"
        // and "something killed it" READABLE, which is the whole reason
        // that investigation cost two lanes an evening.
        // The exit facts must land ON DISK, not just in process memory.
        //
        // Round 3 proved the in-memory job is not enough: `this.jobs` is
        // a Map, so a monitor restart or a fresh dispatch for the same
        // task erases the record. Round 4 then proved the lifecycle
        // callback is not enough either: every server wiring site is a
        // bare sse.broadcast, so an event routed through `this.onEvent`
        // reaches connected dashboards and NOTHING else — the "durable"
        // event never touched disk, which is why run 4 produced zero
        // exit evidence. The write now goes through the session event
        // writer into the child session's own events jsonl; the callback
        // is only the fallback when that write fails.
        let exitFactsDurable = false;
        try {
          appendDispatchChildExit({
            logDir: this.logDir,
            taskId,
            jobSessionId: sessionId,
            jobStartedAt: job.startedAt,
            exitCode: code,
            signal: signal ?? null,
            worktreePath: worktreePath ?? null,
          });
          exitFactsDurable = true;
        } catch {
          // Instrumentation must never take down the exit handler — an
          // uncaught throw here would kill the monitor via the
          // process-level uncaughtException handler.
        }
        if (!exitFactsDurable) {
          this.onEvent?.("dispatch_child_exit", taskId, {
            exitCode: code,
            signal: signal ?? null,
            killed: Boolean(signal),
            worktreePath: worktreePath ?? null,
            at: new Date().toISOString(),
          });
        }

        if (signal) {
          job.killedBySignal = signal;
          job.output.push(
            `[dispatch] Child terminated by signal ${signal} (not a self-exit). ` +
              `If this is SIGKILL with no other output, suspect the OOM killer: ` +
              `check \`dmesg -T | grep -i "killed process"\` around ${new Date().toISOString()}.`,
          );
        }
        this.processes.delete(taskId);

        // Detect a pending human gate: the subprocess exits non-zero when
        // it pauses for approval. Keep the job alive so the
        // double-dispatch guard blocks fresh dispatches and the worktree
        // (with agent commits) is preserved for the resume.
        //
        // QPI-041: this now covers the BLUEPRINT gate as well as the judge
        // gate. A signal-killed child is never a pause, so it is excluded.
        if (code !== 0 && !signal && this.isApprovalPending(taskId, job.startedAt)) {
          job.status = "awaiting_approval";
          job.output.push(
            `[dispatch] Task awaiting human approval — worktree preserved at ${worktreePath ?? "shared directory"}`,
          );
          return;
        }

        this.classifySpecStaleExit(job, taskId, code, signal);

        job.status = code === 0 ? "completed" : "failed";
        this.captureGitMetadata(job, worktreePath);

        // Detect rate limit errors and trigger key rotation + re-dispatch
        if (code !== 0 && this.keyManager && selectedKeyId && isRateLimitError(code, job.output)) {
          const retryAfterMs = parseRetryAfter(job.output);
          this.keyManager.markRateLimited(selectedKeyId, retryAfterMs);
          job.output.push(
            `[key-rotation] Key ${selectedKeyId} rate-limited, cooldown ${retryAfterMs ?? this.keyManager.getCooldownMs()}ms`,
          );

          // Attempt re-dispatch with a different key if available
          if (this.keyManager.hasAvailableKeys()) {
            const claimantCheck = this.claimantResolver
              ? await this.claimantResolver(taskId)
              : undefined;
            try {
              assertUncontestedClaimant(claimantCheck);
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              job.output.push(`[key-rotation] Re-dispatch refused: ${msg}`);
              job.status = "failed";
              this.jobs.set(taskId, job);
              return;
            }
            job.output.push(`[key-rotation] Re-dispatching ${taskId} with next available key`);
            if (worktreePath) {
              this.removeWorktree(worktreePath);
            }
            try {
              this.jobs.delete(taskId);
              this.start(
                taskId,
                {
                  ...options,
                  duplicateClaimantCheck: claimantCheck,
                },
                claimantCheck,
              );
            } catch (err) {
              const msg = err instanceof Error ? err.message : String(err);
              job.output.push(`[key-rotation] Re-dispatch failed: ${msg}`);
              job.status = "failed";
              this.jobs.set(taskId, job);
            }
            return; // Skip normal cleanup — re-dispatch handles it
          } else {
            job.output.push("[key-rotation] No available keys for re-dispatch");
          }
        }

        if (worktreePath) {
          // After successful dispatch with auto-merge, the target branch
          // may have new commits from the squash merge. If the main working
          // directory has that branch checked out, its index is stale —
          // new files exist in git history but not on disk (Pattern 17).
          // Refresh the main working tree to match HEAD.
          if (code === 0) {
            this.refreshMainWorkingTree();
            // Only clean up worktree on success — on failure, preserve the
            // worktree and branch so work is recoverable for manual merge
            // or /fix-task. Lost branches on auto-merge failure is a data
            // loss bug (discovered 2026-03-29).
            this.removeWorktree(worktreePath);
          } else {
            this.cleanupDockerForWorktree(worktreePath);
            job.output.push(
              `[worktree] Preserved ${worktreePath} — dispatch failed, branch retained for recovery`,
            );
          }
        } else if (originalBranch) {
          // Fallback: restore branch if no worktree was used
          try {
            execSync(`git checkout ${originalBranch}`, {
              cwd: this.projectRoot,
              stdio: "ignore",
            });
          } catch {
            // Best-effort restore — don't fail the job over this
          }
        }
      })().catch((err: unknown) => {
        const message = err instanceof Error ? err.message : String(err);
        job.status = "failed";
        job.output.push(`[exit-handler] ${message}`);
        this.jobs.set(taskId, job);
      });
    });

    child.on("error", (err) => {
      job.status = "failed";
      job.output.push(`[error] ${err.message}`);
      this.processes.delete(taskId);

      // Clean up worktree on spawn error
      if (worktreePath) {
        this.removeWorktree(worktreePath);
      }
    });

    this.jobs.set(taskId, job);
    this.processes.set(taskId, child);

    return job;
  }

  /**
   * Start a task dispatch using Docker container isolation.
   * Creates a container, then runs the agent inside it via `docker exec`.
   */
  private startDocker(taskId: string, options?: StartOptions): DispatchJob {
    const sessionId = `quack-${taskId}-${Date.now()}`;
    const job: DispatchJob = {
      taskId,
      sessionId,
      pid: 0,
      startedAt: new Date().toISOString(),
      status: "running",
      output: [],
      federatedJobId: options?.federatedJobId,
      federatedHostId: options?.federatedHostId,
      federatedHostAlias: options?.federatedHostAlias,
      federatedHostEndpoint: options?.federatedHostEndpoint,
      federatedLeaseId: options?.federatedLeaseId,
      provenance: options?.provenance,
    };

    this.jobs.set(taskId, job);

    // Container creation is async — kick it off and wire up the exec
    const dockerMgr = this.dockerManager!;
    dockerMgr
      .createContainer(taskId)
      .then((containerInfo) => {
        job.containerId = containerInfo.containerId;

        // Emit container_created event
        this.onEvent?.("container_created", taskId, {
          containerId: containerInfo.containerId,
          image: containerInfo.image,
          resourceLimits: this.isolationConfig?.docker?.resourceLimits ?? {},
        });

        // Build the agent command to run inside the container
        const agentCmd = ["node", this.quackBin, "run", taskId, "--project", "/workspace"];
        if (options?.skipGate) agentCmd.push("--skip-gate");
        if (options?.skipDepthOnly) agentCmd.push("--skip-depth-only");
        if (options?.resume) agentCmd.push("--resume");
        // TASK-1326: the docker child inherits the override too.
        if (options?.overridePausedRun) agentCmd.push("--override-paused-run");
        if (options?.model) agentCmd.push("--model", options.model);
        if (options?.maxTurns) agentCmd.push("--max-turns", String(options.maxTurns));
        if (options?.maxBudget) agentCmd.push("--max-budget", String(options.maxBudget));

        const env: Record<string, string> = {};
        // Clear nesting detection vars
        env.CLAUDECODE = "";
        env.CLAUDE_CODE = "";
        if (options?.federatedJobId) env.QUACK_FEDERATED_JOB_ID = options.federatedJobId;
        if (options?.federatedHostId) env.QUACK_FEDERATED_HOST_ID = options.federatedHostId;
        if (options?.federatedHostAlias)
          env.QUACK_FEDERATED_HOST_ALIAS = options.federatedHostAlias;
        if (options?.federatedHostEndpoint)
          env.QUACK_FEDERATED_HOST_ENDPOINT = options.federatedHostEndpoint;
        if (options?.federatedLeaseId) env.QUACK_FEDERATED_LEASE_ID = options.federatedLeaseId;
        if (options?.provenance) env.QUACK_PROVENANCE = JSON.stringify(options.provenance);

        // Select API key from key manager (if available)
        if (this.keyManager) {
          const selectedKey = this.keyManager.getNextKey();
          if (!selectedKey) {
            throw new Error("All API keys are rate-limited. Wait for cooldown to expire.");
          }
          const keyValue = this.keyManager.getKeyValue(selectedKey.id);
          if (keyValue) {
            env.ANTHROPIC_API_KEY = keyValue;
            env.QUACK_SELECTED_KEY_ID = selectedKey.id;
          }
        }

        // Track which key was selected for this Docker dispatch
        const dockerKeyId = env.QUACK_SELECTED_KEY_ID;
        if (dockerKeyId) {
          job.keyId = dockerKeyId;
        }

        const child = dockerMgr.execAgent(containerInfo.containerId, agentCmd, env);
        job.pid = child.pid ?? 0;

        this.captureProcessOutput(child, job);
        this.processes.set(taskId, child);

        child.on("exit", (code, signal) => {
          void (async () => {
            job.exitCode = code ?? 1;
            // QPI-043: durable exit facts, same contract as the primary
            // exit handler (docker children have no worktree; the SSE
            // callback is the fallback when the durable write fails).
            let dockerExitFactsDurable = false;
            try {
              appendDispatchChildExit({
                logDir: this.logDir,
                taskId,
                jobSessionId: sessionId,
                jobStartedAt: job.startedAt,
                exitCode: code,
                signal: signal ?? null,
                worktreePath: null,
              });
              dockerExitFactsDurable = true;
            } catch {
              // Never let instrumentation break the exit handler.
            }
            if (!dockerExitFactsDurable) {
              this.onEvent?.("dispatch_child_exit", taskId, {
                exitCode: code,
                signal: signal ?? null,
                killed: Boolean(signal),
                worktreePath: null,
                at: new Date().toISOString(),
              });
            }
            if (signal) {
              job.killedBySignal = signal;
              job.output.push(`[dispatch] Child terminated by signal ${signal} (not a self-exit).`);
            }
            job.status = code === 0 ? "completed" : "failed";
            this.classifySpecStaleExit(job, taskId, code, signal ?? null);
            this.processes.delete(taskId);

            // Detect rate limit errors in Docker dispatch and trigger key rotation + re-dispatch
            if (
              code !== 0 &&
              this.keyManager &&
              dockerKeyId &&
              isRateLimitError(code, job.output)
            ) {
              const retryAfterMs = parseRetryAfter(job.output);
              this.keyManager.markRateLimited(dockerKeyId, retryAfterMs);
              job.output.push(
                `[key-rotation] Key ${dockerKeyId} rate-limited, cooldown ${retryAfterMs ?? this.keyManager.getCooldownMs()}ms`,
              );

              // Attempt re-dispatch with a different key if available
              if (this.keyManager.hasAvailableKeys()) {
                const claimantCheck = this.claimantResolver
                  ? await this.claimantResolver(taskId)
                  : undefined;
                try {
                  assertUncontestedClaimant(claimantCheck);
                } catch (err) {
                  const msg = err instanceof Error ? err.message : String(err);
                  job.output.push(`[key-rotation] Re-dispatch refused: ${msg}`);
                  job.status = "failed";
                  this.jobs.set(taskId, job);
                  return;
                }
                job.output.push(`[key-rotation] Re-dispatching ${taskId} with next available key`);

                // Emit container_stopped event before cleanup
                this.onEvent?.("container_stopped", taskId, {
                  containerId: containerInfo.containerId,
                  reason: "rate-limited, re-dispatching with new key",
                  exitCode: code,
                });

                // Stop the failed container, then re-dispatch
                dockerMgr
                  .stopContainer(containerInfo.containerId, true)
                  .catch(() => {
                    // Best-effort cleanup
                  })
                  .finally(() => {
                    try {
                      this.jobs.delete(taskId);
                      this.start(
                        taskId,
                        {
                          ...options,
                          duplicateClaimantCheck: claimantCheck,
                        },
                        claimantCheck,
                      );
                    } catch (err) {
                      const msg = err instanceof Error ? err.message : String(err);
                      job.output.push(`[key-rotation] Re-dispatch failed: ${msg}`);
                      job.status = "failed";
                      this.jobs.set(taskId, job);
                    }
                  });
                return; // Skip normal cleanup — re-dispatch handles it
              } else {
                job.output.push("[key-rotation] No available keys for re-dispatch");
              }
            }

            // Emit container_stopped event
            this.onEvent?.("container_stopped", taskId, {
              containerId: containerInfo.containerId,
              reason: code === 0 ? "completed" : "agent exited with error",
              exitCode: code,
            });

            const failed = code !== 0;
            // Extract git results before cleanup (container may be removed)
            dockerMgr
              .extractResults(containerInfo.containerId)
              .then((results) => {
                if (results.diff) {
                  job.output.push(
                    `[docker-results] branch=${results.branch}, diff=${results.diff.length} bytes`,
                  );
                }
              })
              .catch(() => {
                // Best-effort — container may already be dead
              })
              .finally(() => {
                dockerMgr.stopContainer(containerInfo.containerId, failed).catch(() => {
                  // Best-effort cleanup
                });
              });
          })().catch((err: unknown) => {
            const message = err instanceof Error ? err.message : String(err);
            job.status = "failed";
            job.output.push(`[exit-handler] ${message}`);
            this.jobs.set(taskId, job);
          });
        });

        child.on("error", (err) => {
          job.status = "failed";
          job.output.push(`[error] ${err.message}`);
          this.processes.delete(taskId);

          // Emit container_error event
          this.onEvent?.("container_error", taskId, {
            containerId: containerInfo.containerId,
            error: err.message,
          });

          // On error, skip result extraction and go straight to cleanup
          dockerMgr.stopContainer(containerInfo.containerId, true).catch(() => {
            // Best-effort cleanup
          });
        });
      })
      .catch((err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err);
        job.status = "failed";
        job.output.push(`[docker-error] ${msg}`);

        // Emit container_error event
        this.onEvent?.("container_error", taskId, {
          containerId: "",
          error: msg,
        });
      });

    return job;
  }

  /**
   * Capture stdout/stderr from a child process into the job output buffer.
   */
  private captureProcessOutput(child: ChildProcess, job: DispatchJob): void {
    child.stdout?.on("data", (data: Buffer) => {
      try {
        const lines = data.toString().split("\n").filter(Boolean);
        job.output.push(...lines);
        if (job.output.length > 200) {
          job.output.splice(0, job.output.length - 200);
        }
      } catch (err) {
        console.error("[dispatch] stdout capture error (non-fatal):", err);
      }
    });

    child.stderr?.on("data", (data: Buffer) => {
      try {
        const lines = data.toString().split("\n").filter(Boolean);
        job.output.push(...lines.map((l) => `[stderr] ${l}`));
        if (job.output.length > 200) {
          job.output.splice(0, job.output.length - 200);
        }
      } catch (err) {
        console.error("[dispatch] stderr capture error (non-fatal):", err);
      }
    });
  }

  /**
   * Stop a running dispatch by sending SIGTERM.
   * Also stops the Docker container if one was used.
   */
  stop(taskId: string): boolean {
    const job = this.jobs.get(taskId);

    // Handle awaiting_approval jobs (no running process to kill)
    if (job?.status === "awaiting_approval") {
      job.status = "stopped";
      if (job.worktreePath) {
        job.output.push(
          `[worktree] Preserved ${job.worktreePath} — task stopped, branch retained for recovery`,
        );
      }
      return true;
    }

    const child = this.processes.get(taskId);
    if (!child) return false;

    child.kill("SIGTERM");
    if (job) job.status = "stopped";
    this.processes.delete(taskId);

    // Preserve worktree on manual stop — work may be partially done.
    // The branch and commits remain available for /fix-task or manual recovery.
    if (job?.worktreePath) {
      job.output.push(
        `[worktree] Preserved ${job.worktreePath} — task stopped, branch retained for recovery`,
      );
    }

    // Clean up Docker container if one was created
    if (job?.containerId && this.dockerManager) {
      this.dockerManager.stopContainer(job.containerId, true).catch(() => {
        // Best-effort cleanup
      });
    }

    return true;
  }

  /**
   * Get all jobs (active + completed).
   */
  getAllJobs(): DispatchJob[] {
    this.reconcileRunningJobs();
    return Array.from(this.jobs.values());
  }

  /**
   * Get active (running) jobs.
   */
  /**
   * Whether worktree isolation has failed and dispatch is in degraded mode.
   * When true, only one task can run at a time (shared directory fallback).
   */
  isWorktreeDegraded(): boolean {
    return this.worktreeDegraded;
  }

  getActiveJobs(): DispatchJob[] {
    this.reconcileRunningJobs();
    return Array.from(this.jobs.values()).filter((j) => j.status === "running");
  }

  /**
   * Get the active job for a specific task, if any.
   */
  getActiveJob(taskId: string): DispatchJob | undefined {
    this.reconcileRunningJobs();
    const job = this.jobs.get(taskId);
    if (!job) return undefined;
    // Include awaiting_approval: the worktree has agent commits that
    // must not be destroyed by a fresh createWorktree() call.
    return job.status === "running" || job.status === "awaiting_approval" ? job : undefined;
  }

  /**
   * Get job by task ID (any status).
   */
  getJob(taskId: string): DispatchJob | undefined {
    return this.jobs.get(taskId);
  }

  /**
   * Clean up completed/failed jobs older than the given age.
   */
  cleanup(maxAgeMs = 3600000): void {
    const cutoff = Date.now() - maxAgeMs;
    for (const [taskId, job] of this.jobs) {
      // Don't clean up awaiting_approval jobs — worktree has agent commits
      if (
        job.status !== "running" &&
        job.status !== "awaiting_approval" &&
        new Date(job.startedAt).getTime() < cutoff
      ) {
        this.jobs.delete(taskId);
      }
    }
  }

  /**
   * Start a watchdog timer that kills dispatch processes running longer than
   * the given timeout. Checks every 60 seconds. Prevents hung dispatches
   * from consuming resources indefinitely (e.g. when the SDK async generator
   * fails to signal completion).
   */
  startWatchdog(timeoutMs = DEFAULT_WATCHDOG_TIMEOUT_MS): void {
    if (this.watchdogTimer) return; // Already running
    this.watchdogTimer = setInterval(() => {
      const now = Date.now();
      for (const [taskId, job] of this.jobs) {
        if (job.status !== "running") continue;
        const elapsed = now - new Date(job.startedAt).getTime();
        if (elapsed > timeoutMs) {
          const child = this.processes.get(taskId);
          if (child) {
            job.output.push(
              `[watchdog] Killing stuck dispatch after ${Math.round(elapsed / 60000)}min`,
            );
            child.kill("SIGTERM");
            // Force-kill after 10 seconds if SIGTERM doesn't work
            setTimeout(() => {
              if (this.processes.has(taskId)) {
                child.kill("SIGKILL");
              }
            }, 10_000).unref();
          }
        }
      }
    }, 60_000);
    this.watchdogTimer.unref(); // Don't keep the process alive
  }

  /**
   * Stop the watchdog timer.
   */
  stopWatchdog(): void {
    if (this.watchdogTimer) {
      clearInterval(this.watchdogTimer);
      this.watchdogTimer = undefined;
    }
  }

  /**
   * Kill all running processes (for graceful shutdown).
   * Also cleans up all Docker containers if Docker isolation is active.
   */
  killAll(): void {
    for (const [taskId, child] of this.processes) {
      child.kill("SIGTERM");
      const job = this.jobs.get(taskId);
      if (job) {
        job.status = "stopped";
        // Clean up any worktrees
        if (job.worktreePath) {
          this.removeWorktree(job.worktreePath);
        }
      }
    }
    this.processes.clear();

    // Clean up all Docker containers
    if (this.dockerManager) {
      this.dockerManager.cleanupAll().catch(() => {
        // Best-effort cleanup on shutdown
      });
    }
  }

  /**
   * Get active Docker containers (delegates to DockerManager).
   */
  getActiveContainers(): DockerContainer[] {
    return this.dockerManager?.getActiveContainers() ?? [];
  }

  /**
   * Clean up all Docker containers (for emergency stop).
   * No-op if Docker isolation is not active.
   */
  async cleanupAllContainers(): Promise<void> {
    if (this.dockerManager) {
      await this.dockerManager.cleanupAll();
    }
  }
}
