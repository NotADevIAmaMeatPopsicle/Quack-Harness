// ─── Task Spec Types ───────────────────────────────────────────────

import type { TaskStatus } from "./task-status.js";
import type { ReviewerRunnerConfig } from "../review/reviewer-config.js";
import type { JudgmentConfig } from "../judgment/runner/intent-judgment-config.js";
import type {
  JudgeJudgmentTraceEntry,
  JudgmentDecision,
  JudgmentProjectionFailure,
} from "../judgment/judgment-types.js";

export type { TaskStatus };

export type TaskPriority = "P0-CRITICAL" | "P1-HIGH" | "P2-MEDIUM" | "P3-LOW";
export type ExecutionMode = "dispatch" | "loop";

export interface FileModification {
  path: string;
  action: "Create" | "Modify" | "Delete" | "Reference";
  notes: string;
}

export type BacklogHygieneIssueCode =
  | "duplicate_id"
  | "superseded"
  | "status_on_hold"
  | "status_rejected";

export interface BacklogHygieneIssue {
  code: BacklogHygieneIssueCode;
  message: string;
  relatedTaskIds?: string[];
  relatedFiles?: string[];
}

export interface TaskBacklogHygiene {
  dispatchBlocked: boolean;
  reasons: BacklogHygieneIssue[];
}

export interface DuplicateTaskIdWarning {
  taskId: string;
  files: string[];
}

export interface SupersededTaskWarning {
  taskId: string;
  supersededBy: string[];
}

export interface ExcludedTaskCandidate {
  taskId: string;
  title: string;
  status: TaskStatus;
  reasons: BacklogHygieneIssue[];
}

export interface BacklogHygieneReport {
  duplicateIds: DuplicateTaskIdWarning[];
  supersededTasks: SupersededTaskWarning[];
  excludedCandidates: ExcludedTaskCandidate[];
}

export interface ParsedTask {
  id: string;
  title: string;
  priority: TaskPriority;
  effort: string;
  status: TaskStatus;
  /** Optional per-task dispatch target branch override */
  targetBranch?: string;
  /** Optional per-task execution-mode override. */
  executionMode?: ExecutionMode;
  /** Non-fatal parser advisories (normalization, tolerant metadata parsing). */
  parseWarnings?: string[];
  supersededBy: string[];
  supersedes: string[];
  relevanceReview: string;
  blockedBy: string[];
  blocks: string[];
  conventions: string[];
  tags: string[];
  problemStatement: string;
  currentState: string;
  recommendedApproach: string;
  filesToModify: FileModification[];
  successCriteria: string[];
  testingRequirements: string[];
  contextReferences: string[];
  /** TASK-1324: machine-readable decided facts from a `## Decided Facts`
   *  section (one bullet per fact). Feeds the brief synthesizer's
   *  constraint block; absent section = no Tier S fidelity claim. */
  decidedFacts?: string[];
  rawContent: string;
}

// ─── Adapter Config Types ──────────────────────────────────────────

export interface TestPatternConfig {
  testDir: string;
  sourceDir: string;
  suffixes: string[];
  prefixes: string[];
  autoConventions: string[];
}

export interface AdapterProjectConfig {
  name: string;
  root: string;
  taskDir: string;
  conventionsDir: string;
  testPatterns?: TestPatternConfig;
}

export interface AdapterAgentConfig {
  model: string;
  judgeModel: string;
  enrichModel: string;
  maxTurns: number;
  maxBudgetPerTask: number;
  maxRetries: number;
  apiKeys?: {
    pool: string[];
    strategy: "round-robin" | "least-used" | "least-cost";
    cooldownMs: number;
  };
}

export interface RevisionConfig {
  maxBudget: number;
  maxTurns: number;
}

/** Record-on-merge scanner settings (TASK-1201). */
export interface RecordingOnMergeConfig {
  /** Default true; the scanner only adds SOFT-VERIFIED rows and is guard-railed. */
  enabled: boolean;
  /** Scan interval in ms. Default 300000 (5 min). */
  intervalMs: number;
}

export interface RecordingConfig {
  onMerge?: RecordingOnMergeConfig;
}

export interface ModelRoutingConfig {
  gateModel: string;
  enrichModel: string;
  plannerModel: string;
  workerModel: string;
  workerComplexModel: string;
  judgeModel: string;
  retryEscalation: boolean;
}

export interface VerificationCommandDockerConfig {
  composeFile: string;
  service: string;
  warmUp: boolean;
  dependsOn: string[];
}

/**
 * Fields shared by both the legacy shell-string verification command and the
 * structured cross-platform form (TASK-866).
 */
export interface VerificationCommandBase {
  name: string;
  required: boolean;
  timeout: number;
  /** Phase controls when this command runs. Default: "all" (runs everywhere). */
  phase?: "fast" | "thorough" | "all";
  /** Execution environment. Default: "host". */
  environment?: "host" | "docker";
  docker?: VerificationCommandDockerConfig;
}

/**
 * Legacy form: `command` is a single shell string passed to a host shell. Works
 * cross-platform when the string only invokes binaries on PATH; brittle when
 * it contains pipes, redirects, or POSIX-tool dependencies (Windows hosts have
 * to find Git Bash + ensure /usr/bin is on PATH for `dirname` and friends —
 * see ISSUES-2026-04-29 §4 for the failure mode).
 *
 * Adapters are encouraged to migrate to {@link StructuredVerificationCommand};
 * the loader auto-normalizes simple shell-feature-free strings.
 */
export interface LegacyVerificationCommand extends VerificationCommandBase {
  command: string;
  /** Optional cwd relative to project root (legacy form). */
  cwd?: string;
  /** Additional env vars merged into process.env (legacy form). */
  env?: Record<string, string>;
}

/**
 * Structured form (TASK-866): `cmd` + `args[]` are passed to
 * `child_process.spawn(cmd, args, { shell: false })`. No shell parsing, no
 * Windows POSIX-PATH fix-up needed. Identical behavior on Mac/Linux/Windows/
 * WSL/Docker.
 */
export interface StructuredVerificationCommand extends VerificationCommandBase {
  cmd: string;
  args: string[];
  /** Optional cwd relative to project root. */
  cwd?: string;
  /** Additional env vars merged into process.env. */
  env?: Record<string, string>;
}

export type VerificationCommand = LegacyVerificationCommand | StructuredVerificationCommand;

/** Type guard: does this command use the structured (cmd+args) shape? */
export function isStructuredVerificationCommand(
  command: VerificationCommand,
): command is StructuredVerificationCommand {
  return (
    "cmd" in command &&
    typeof command.cmd === "string" &&
    "args" in command &&
    Array.isArray(command.args)
  );
}

/**
 * Return a shell-string representation of a verification command, for display,
 * logging, and pattern-matching (`isTestCommand`, `shouldUseMappedTestRunner`).
 *
 * For legacy commands this is the original `command` field. For structured
 * commands it joins `cmd` + `args[]` with shell-style quoting of args that
 * contain whitespace or shell metachars. The returned string is safe for
 * display but is NOT guaranteed to round-trip through a shell — execution
 * paths must dispatch on shape via {@link isStructuredVerificationCommand}.
 */
export function verificationCommandShellString(command: VerificationCommand): string {
  if (isStructuredVerificationCommand(command)) {
    const parts = [command.cmd, ...command.args].map((arg) => {
      if (/[\s"'$`\\|&;<>()*?]/.test(arg)) {
        return `"${arg.replace(/"/g, '\\"')}"`;
      }
      return arg;
    });
    return parts.join(" ");
  }
  return command.command;
}

export interface ConventionCheck {
  name: string;
  description: string;
  command: string;
  conventionRef: string;
}

export interface PostJudgeConfig {
  enabled: boolean;
  layers: ("deterministic" | "structural" | "semantic")[];
  model: string;
  failOnBuildError: boolean;
  failOnTestError: boolean;
  failOnLintError: boolean;
  maxSemanticTokens: number;
}

export interface VerificationFinding {
  criterion: string;
  status: "pass" | "fail" | "warn";
  evidence: string;
}

export interface PostJudgeResult {
  verified: boolean;
  buildPassed: boolean;
  testsPassed: boolean;
  lintPassed: boolean;
  testCount: number;
  findings: VerificationFinding[];
  summary: string;
  /** True when deterministic checks all pass but LLM-based checks (semantic/structural) disagree — surface for human review */
  needsReview?: boolean;
  /** Additive Phase-2 projection; absent on legacy persisted results. */
  judgmentDecision?: JudgmentDecision;
}

/** Adapter-level tiered testing configuration (stored in adapter.json) */
export interface TieredTestingConfig {
  /** Whether tiered testing is enabled */
  enabled: boolean;
  /** Docker command prefix for running tests */
  dockerCommand?: string;
  /** How often to run Tier 3 full suite: number of merges between runs */
  tier3Frequency: number;
  /** Output directory for test result artifacts */
  outputDir: string;
}

export interface AdapterVerificationConfig {
  commands: VerificationCommand[];
  conventionChecks: ConventionCheck[];
  postJudge?: PostJudgeConfig;
  smartTesting?: SmartTestingConfig;
  tieredTesting?: TieredTestingConfig;
  retention?: RetentionConfig;
}

export interface AdapterSandboxConfig {
  writablePaths: string[];
  deniedPaths: string[];
  allowedBashPatterns: string[];
  deniedBashPatterns: string[];
}

export interface AdapterGitConfig {
  baseBranch: string;
  branchPrefix: string;
  commitFormat: string;
  commitTrailer: string;
  autoCreatePr: boolean;
  autoPush: boolean;
  autoMerge?: boolean;
  autoMergeTarget?: string;
  autoMergeStrategy?: "squash" | "merge" | "rebase";
  branchGroups?: Record<string, BranchGroup>;
  /** Branches that must never be auto-deleted. Defaults to ["main", "dev", "staging", "prod"] */
  protectedBranches?: string[];
  /**
   * Minimum age in days before a merged branch is eligible for auto-deletion.
   * Default: 1 (24 hours). Used by deleteAfterMerge() and sweep().
   */
  branchRetentionDays?: number;
  branchCleanup?: BranchCleanupPolicyConfig;
}

export interface BranchCleanupPolicyConfig {
  enabled: boolean;
  retentionDays?: number;
  allowedPrefixes?: string[];
  protectedOwners?: string[];
  protectedPatterns?: string[];
  requireOwnerOverride?: boolean;
  scheduled?: {
    enabled?: boolean;
    apply?: boolean;
    intervalMinutes?: number;
  };
}

export interface BranchCleanupOwnerOverride {
  owner: string;
  reason: string;
}

export interface BranchGroup {
  baseBranch: string;
  autoMergeTarget?: string;
  description?: string;
  taskPattern?: string;
}

export interface AdapterLoggingConfig {
  dir: string;
  level: "debug" | "info" | "warn" | "error";
  retainDays: number;
}

export interface AdapterWorkerOverlayConfig {
  /** Host-local checkout root for this worker. */
  projectRoot?: string;
  /** Host-local task directory override, relative to projectRoot unless absolute. */
  taskDir?: string;
  /** Host-local log directory for Quack runtime artifacts. */
  logDir?: string;
  /** Host-local service endpoints, keyed by purpose, such as headnode or monitor. */
  endpoints?: Record<string, string>;
  /** Host-local shell/runtime preferences. */
  shell?: {
    preferred?: "bash" | "cmd" | "powershell" | "pwsh" | "wsl";
    bashPath?: string;
    nodePath?: string;
  };
  /** Probe-backed capabilities this worker may advertise. */
  capabilities?: Record<string, boolean>;
}

export interface AdapterBundleMetadata {
  /** Source of the shared bundle metadata; Headnode should publish as headnode. */
  authority: "headnode" | "local";
  /** Deterministic hash of shared adapter policy after machine-local fields are normalized out. */
  sharedHash: string;
  /** Normalized shared adapter config used to compute sharedHash. */
  normalizedConfig: AdapterConfig;
  /** Dot-paths intentionally excluded or normalized before hashing. */
  machineLocalFields: string[];
}

export interface AutoPrepConfig {
  enabled: boolean;
  maxConcurrent: number;
  cooldownSeconds: number;
  maxPerHour: number;
  maxBudgetPerHour: number;
  priorityOrder: "priority_then_id" | "id_only" | "dependency_chain";
  skipPrepped: boolean;
}

export interface AutomationConfig {
  autoPrep: AutoPrepConfig;
}

export interface FleetBudgetConfig {
  dailyCapUsd: number;
  hourlyCapUsd: number;
  perWaveCapUsd: number;
  alertThresholds: number[];
  enforceHard: boolean;
}

export interface CostVelocityConfig {
  enabled: boolean;
  windowMinutes: number;
  warnMultiplier: number;
  killMultiplier: number;
  minSamplesForBaseline: number;
}

export interface StuckDetectionConfig {
  enabled: boolean;
  warningMinutes: number;
  criticalMinutes: number;
  killMinutes: number;
  checkIntervalSeconds: number;
  fileHeartbeat: boolean;
}

// ─── Isolation Types ──────────────────────────────────────────────

export type IsolationMethod = "worktree" | "docker";

export interface DockerIsolationConfig {
  image: string;
  buildContext?: string;
  volumes: string[];
  envPassthrough: string[];
  resourceLimits: {
    memoryMb: number;
    cpus: number;
    storageMb?: number;
  };
  networkMode: "bridge" | "host" | "none";
  preInstallCommand?: string;
  cleanupPolicy: "remove" | "keep_on_failure" | "always_keep";
}

export interface IsolationConfig {
  method: IsolationMethod;
  /** Whether to run docker compose down during worktree teardown. Default: true */
  dockerCleanup?: boolean;
  docker?: DockerIsolationConfig;
}

export interface BatchConfig {
  enabled: boolean;
  minBatchSize: number;
  maxWaitSeconds: number;
  pollIntervalMs: number;
  timeoutMs: number;
}

export interface PreflightConfig {
  /** Auto-run pre-flight when tasks are registered */
  autoRun: boolean;
  /** Complexity thresholds for decomposition recommendation */
  complexityThresholds: {
    maxFilesBeforeDecompose: number;
    maxCriteriaBeforeDecompose: number;
    maxContextTokensBeforeDecompose: number;
    maxIndependentFeatures: number;
  };
  /** Spec review configuration */
  specReview?: {
    enabled: boolean;
    model: string;
  };
  /** Blueprint approval gate configuration */
  blueprintApproval?: {
    enabled: boolean;
    autoApproveWhen: {
      maxFiles: number;
      maxCriteria: number;
      minBlueprintScore: number;
      requireDecomposition: boolean;
    };
    /** Timeout in ms for pending approvals. Expired approvals auto-reject. Default: 24h */
    approvalTimeoutMs?: number;
  };
  /** Judge approval gate configuration */
  judgeApproval?: {
    enabled: boolean;
    autoApproveWhen: {
      requireVerificationPass: boolean;
      maxFilesChanged: number;
      maxDiffLines: number;
    };
    /** Timeout in ms for pending approvals. Expired approvals auto-reject. Default: 24h */
    approvalTimeoutMs?: number;
  };
  /** Auto-decomposition configuration */
  autoDecompose?: {
    enabled: boolean;
    maxSubtasks: number;
    writeSpecs: boolean;
    /** Minimum parent prep depth score required before finalize is allowed */
    parentPrepThreshold?: number;
  };
}

export interface BlueprintAutoApproveRules {
  maxFiles: number;
  maxCriteria: number;
  minBlueprintScore: number;
  requireDecomposition: boolean;
}

export interface JudgeAutoApproveRules {
  requireVerificationPass: boolean;
  maxFilesChanged: number;
  maxDiffLines: number;
}

export interface LoopConfig {
  briefReview: {
    reviewer: ReviewerRunnerConfig;
    requireCrossModel: boolean;
    autoApproveWhen?: BlueprintAutoApproveRules;
  };
  diffReview: {
    reviewer: ReviewerRunnerConfig;
    requireCrossModel: boolean;
    autoApproveWhen?: JudgeAutoApproveRules;
  };
  models?: {
    investigate?: string;
    build?: string;
    judge?: string;
  };
  recordOnFinalize: boolean;
}

export interface IntegrationsConfig {
  github?: GitHubConfig;
}

export interface GitHubConfig {
  owner: string;
  repo: string;
  importLabel?: string;
  publishLabel?: string;
  pollEnabled?: boolean;
  pollIntervalMs?: number;
  statusSyncIntervalMs?: number;
  reportBack?: boolean;
  closeOnMerge?: boolean;
  labels?: {
    ready?: string;
    inProgress?: string;
    approved?: string;
    rejected?: string;
    task?: string;
  };
}

export interface AdapterConfig {
  $schema?: string;
  version: string;
  project: AdapterProjectConfig;
  agent: AdapterAgentConfig;
  verification: AdapterVerificationConfig;
  sandbox: AdapterSandboxConfig;
  git: AdapterGitConfig;
  logging: AdapterLoggingConfig;
  /** Production-deploy markers for the TASK-1312 deploy classifier. */
  deploy?: {
    productionMarkers?: {
      registries?: string[];
      environments?: string[];
      extraCommandPatterns?: string[];
    };
  };
  automation?: AutomationConfig;
  fleetBudget?: FleetBudgetConfig;
  costVelocity?: CostVelocityConfig;
  stuckDetection?: StuckDetectionConfig;
  deterministicChecks?: DeterministicCheck[];
  isolation?: IsolationConfig;
  modelRouting?: ModelRoutingConfig;
  gate?: GateConfig;
  batchConfig?: BatchConfig;
  queue?: DispatchQueueConfig;
  preflight?: PreflightConfig;
  revision?: RevisionConfig;
  recording?: RecordingConfig;
  integrations?: IntegrationsConfig;
  dispatch?: DispatchConfig;
  enrichment?: EnrichmentConfig;
  validationIntake?: ValidationIntakeConfig;
  runtimeCheck?: RuntimeCheckConfig;
  workerOverlay?: AdapterWorkerOverlayConfig;
  executionMode?: ExecutionMode;
  loop?: LoopConfig;
  judgment?: JudgmentConfig;
}

/**
 * TASK-922: Auto-commit configuration for the legacy auto-enrichment endpoints.
 * When `enabled: true`, `POST /api/tasks/:id/enrich` (auto-approve write) and
 * `POST /api/tasks/:id/enrich/approve` will `git add` + `git commit` the
 * enriched spec file and (when `push: true`) push to origin after the disk
 * write. Default is `enabled: false` so operator/laptop clones preserve the
 * prior write-only behavior unless they opt in.
 */
export interface EnrichmentAutoCommitConfig {
  /** Master switch. Defaults to false so non-canonical clones do not auto-commit. */
  enabled: boolean;
  /** When true, push the commit to origin/<currentBranch>. When false, commit locally only. */
  push: boolean;
  /** Commit message template; `{taskId}` is substituted at runtime. */
  commitMessageTemplate: string;
  /** Branches on which auto-commit MUST NOT run (e.g. `main`, `production`). */
  skipBranches: string[];
}

export interface EnrichmentConfig {
  autoCommit: EnrichmentAutoCommitConfig;
}

/**
 * TASK-1106: Per-project tuning for the Validation Intake type. Optional and
 * additive; absent block falls back to the defaults below.
 *
 * Drift policy is SHARED across workers (intentionally NOT listed in
 * MACHINE_LOCAL_ADAPTER_FIELDS in adapter-loader.ts), so workers cannot diverge
 * from headnode policy on what counts as "scope drift" — the value is part of
 * the adapter bundle hash.
 */
export interface ValidationIntakeConfig {
  /**
   * Maximum allowed `changed_but_unclaimed` file count before the scope-hygiene
   * gate REVISEs (when nonClaims is empty). Default: 5.
   */
  driftThreshold: number;
}

export interface DispatchQueueConfig {
  maxConcurrent: number;
  cooldownBetweenTasksMs: number;
  failurePropagation: "fail_fast" | "skip_dependents" | "continue_all";
  fleetBudgetUsd: number;
  pauseOnFailure: boolean;
  persistState: boolean;
  autoStartOnEnqueue: boolean;
}

// ─── Worktree Init Types ──────────────────────────────────────────

/** A single explicit worktree initialization step. */
export interface WorktreeInitStep {
  /** Shell command to run, e.g. "npm ci" */
  command: string;
  /** Working directory relative to the worktree root. Defaults to worktree root. */
  cwd?: string;
  /** Additional environment variables merged with process.env for this step */
  env?: Record<string, string>;
  /** Human-readable label used in log output and event emission */
  label?: string;
}

/**
 * Structured result from runWorktreeInit().
 * Always returned — never throws — callers decide whether to abort on failure.
 */
export interface WorktreeInitResult {
  /** True only when ALL steps completed with exit code 0 */
  success: boolean;
  /** Total number of steps attempted */
  stepsRun: number;
  /** Per-step error details for any step that failed */
  errors: Array<{
    /** The command or label that failed */
    step: string;
    /** Human-readable error message */
    message: string;
    /** Process exit code if available */
    exitCode?: number;
  }>;
}

/** Adapter-level dispatch configuration (top-level `dispatch` key in adapter.json). */
export interface DispatchConfig {
  /**
   * Explicit list of init steps to run after worktree creation.
   * When omitted, auto-discovery runs: finds all package.json files
   * (excluding node_modules/) up to 3 levels deep, runs npm ci for each.
   */
  worktreeInit?: Array<string | WorktreeInitStep>;
}

// ─── Testing / Monitor Types ──────────────────────────────────────

export interface TestRunResult {
  name: string;
  command: string;
  exitCode: number | null;
  durationMs: number;
  startedAt: string;
  finishedAt: string;
  projectId?: string;
  gitSha?: string;
  /** Structured artifact task id (e.g. TASK-601 or manual-<timestamp>) when available */
  taskId?: string;
  /** True when smart manual run skipped due clean git state + unchanged HEAD */
  skippedNoChanges?: boolean;
  /** Adapter freshness metadata captured when this run started. */
  adapterFreshness?: AdapterFreshnessMetadata;
}

export interface RetentionConfig {
  maxResults: number;
  maxAgeDays: number;
  keepBaselines: boolean;
}

/** Aggregate testing dashboard data */
export interface TestDashboardData {
  latest: {
    totalTests: number;
    passed: number;
    failed: number;
    skipped: number;
    passRate: number;
    durationMs: number;
    timestamp: string;
    taskId: string;
  } | null;
  taskResults: Array<{
    taskId: string;
    timestamp: string;
    totalTests: number;
    passed: number;
    failed: number;
    newFailures: number;
    preExisting: number;
    fixed: number;
    allPreExisting: boolean;
    durationMs: number;
  }>;
  slowestSuites: Array<{
    path: string;
    avgDurationMs: number;
    testCount: number;
  }>;
  flakyTests: Array<{
    fullName: string;
    suitePath: string;
    failureCount: number;
    taskIds: string[];
  }>;
  recentManualRuns: TestRunResult[];
  commandHealth: Array<{
    name: string;
    lastExitCode: number | null;
    lastRunAt: string | null;
    lastDurationMs: number | null;
    recentPassRate: number;
  }>;
}

// ─── Smart Testing Types ──────────────────────────────────────────

/** Adapter-level smart testing configuration (stored in adapter.json) */
export interface SmartTestingConfig {
  enabled: boolean;
  mode: "related" | "full";
  baselineEnabled: boolean;
  failOnPreExisting: boolean;
  outputDir: string;
}

/** Runtime config passed to the smart test runner for a single run */
export interface SmartTestConfig {
  mode: "related" | "full" | "baseline";
  workDir: string;
  baseBranch: string;
  outputDir: string;
  taskId: string;
  timeout: number;
}

/** Individual test failure record */
export interface TestFailure {
  suitePath: string;
  ancestorTitles: string[];
  testName: string;
  fullName: string;
  message: string;
  stack?: string;
}

/** Per-suite breakdown */
export interface SuiteResult {
  path: string;
  passed: number;
  failed: number;
  skipped: number;
  duration: number;
}

/** Comparison of current run against a baseline */
export interface BaselineComparison {
  preExisting: TestFailure[];
  newFailures: TestFailure[];
  newlyFixed: TestFailure[];
  allFailuresPreExisting: boolean;
}

/** Structured test result with optional baseline comparison */
export interface TestSuiteResult {
  totalTests: number;
  passed: number;
  failed: number;
  skipped: number;
  durationMs: number;
  suites: SuiteResult[];
  failures: TestFailure[];
  exitCode: number;
  baseline?: BaselineComparison;
  timestamp: string;
}

// ─── Readiness Gate Types ──────────────────────────────────────────

export interface GateConfig {
  requiredSections: Array<"currentState" | "recommendedApproach" | "filesToModify">;
}

export interface SchemaCheckResult {
  valid: boolean;
  missing: string[];
  warnings: string[];
}

export enum TaskType {
  Code = "code",
  Architecture = "architecture",
  Test = "test",
  Documentation = "documentation",
}

export interface DepthScores {
  [key: string]: number | undefined;
  clarity?: number;
  scope?: number;
  testability?: number;
  conventions?: number;
  /** How specific is the implementation guidance? (file:line refs, function signatures, before/after) */
  implementationSpecificity?: number;
  /** Can each success criterion be verified by grep/file-check? */
  verificationClarity?: number;
  /** Does the task cover all architectural layers implied by the problem statement? */
  completeness?: number;
  decisionPoints?: number;
  alternativesCoverage?: number;
  adrTemplateCompliance?: number;
  crossReferenceCompleteness?: number;
  testScopeDefinition?: number;
  targetCoverageAreas?: number;
  infrastructureReferences?: number;
  assertionPatterns?: number;
  scopeDefinition?: number;
  sourceMaterialReferences?: number;
  outputFormatRequirements?: number;
}

export interface DepthEvalResult {
  taskType: TaskType;
  threshold: number;
  ready: boolean;
  overallScore: number;
  scores: DepthScores;
  deficiencies: string[];
  enrichmentSuggestions: string[];
}

export interface EnrichedTask {
  original: ParsedTask;
  enriched: ParsedTask;
  diff: string;
  approved: boolean;
}

export type GateResult = (
  | { outcome: "pass"; task: ParsedTask; advisories?: string[] }
  | { outcome: "enriched"; task: EnrichedTask; advisories?: string[] }
  | { outcome: "rejected"; reason: string; details: SchemaCheckResult | DepthEvalResult }
) & {
  judgmentDecision?: JudgmentDecision;
  /** TASK-1315: attached when the readiness intent cutover ran (mode != off). */
  judgmentOrchestration?: import("../judgment/judgment-types.js").JudgmentOrchestrationResult;
};

// ─── Task Selection Types ──────────────────────────────────────────

export type AgentFit = "high" | "medium" | "low";

export interface TaskSelection {
  taskId: string;
  priority: TaskPriority;
  effort: string;
  blockedBy: string[];
  conventions: string[];
  hasTestCriteria: boolean;
  readinessScore: number;
  estimatedAgentFit: AgentFit;
}

// ─── Blueprint Verification Pattern ───────────────────────────────

export interface VerificationPattern {
  criterion: string;
  checkType: "grep" | "grep_count" | "file_exists" | "file_not_exists";
  pattern: string;
  fileGlob: string;
  expectedMatches?: number;
}

// ─── Context Size Estimation Types ────────────────────────────────

/**
 * Per-section token breakdown for a TaskContext.
 * Populated by the token estimator at the end of assembleContext().
 */
export interface ContextSizeEstimate {
  taskSpec: number;
  blueprint: number;
  repoMap: number;
  relevantFiles: number;
  relatedPatterns: number;
  existingTests: number;
  conventions: number;
  claudeMd: number;
  total: number;
  withinBudget: boolean;
}

// ─── Context Assembly Types ────────────────────────────────────────

export interface TaskContext {
  taskSpec: string;
  /**
   * TASK-1313 S6: repo-relative path of the ACTIVE task's spec file,
   * threaded from resolveTaskFile so the worker's write guard can refuse
   * the agent editing its own success criteria mid-run.
   */
  taskSpecPath?: string;
  conventions: Record<string, string>;
  conventionsSummary: string;
  relevantFiles: string[];
  relatedPatterns: string[];
  existingTests: string[];
  claudeMd: string[];
  /** Lightweight signature map of the codebase (~2-5K tokens) */
  repoMap?: string;
  /** Implementation blueprint generated by Blueprint Agent (TASK-043) */
  blueprint?: string;
  /** Raw verification patterns from Blueprint Agent for compliance checking */
  blueprintPatterns?: VerificationPattern[];
  /** Token estimates for each context section (populated by assembleContext) */
  contextSizeEstimate?: ContextSizeEstimate;
  /** Similar completed work from template matching (TASK-058) */
  similarWork?: {
    taskId: string;
    category: string;
    spec: string;
    diff: string;
    matchReasons: string[];
  };
  /** Pre-extracted codebase patterns (always-on, deterministic, <2s) */
  codebasePatterns?: string;
}

// ─── Verification Types ────────────────────────────────────────────

export interface VerifyCommandResult {
  name: string;
  passed: boolean;
  output: string;
}

export type AdapterFreshnessStatus = "fresh" | "refreshed" | "stale" | "unknown";

export interface AdapterFreshnessMetadata {
  status: AdapterFreshnessStatus;
  localHash?: string;
  authoritativeHash?: string;
  reason?: string;
}

export interface VerificationResult {
  allPassed: boolean;
  commands: VerifyCommandResult[];
  conventionChecks: VerifyCommandResult[];
  adapterFreshness?: AdapterFreshnessMetadata;
}

// ─── Judge Types ───────────────────────────────────────────────────

export type JudgeVerdict = "APPROVE" | "REVISE" | "REJECT";

/**
 * Result of a deterministic spec compliance check.
 * Runs before the LLM judge to catch "mentioned vs enforced" gaps.
 */
export interface ComplianceCheckResult {
  /** The success criterion text */
  criterion: string;
  /**
   * TASK-1320: the criterion's position in `task.successCriteria`.
   * OPTIONAL by design (round-1 R1-6) so cached, replayed and
   * revise-loop payloads created before this change keep working via
   * legacy text grouping. Absence means "no index", never "index 0".
   */
  criterionIndex?: number;
  /** Which pattern was matched */
  patternMatched: string;
  /** Whether code evidence was found */
  found: boolean;
  /** File:line references where pattern was found (or empty) */
  evidence: string[];
  /** What was checked */
  description: string;
  /** Severity level */
  severity: "warning" | "flag";
}

/**
 * Adapter-configurable deterministic check (from adapter.json).
 */
export interface DeterministicCheck {
  /** Name of the check */
  name: string;
  /** Criterion text substring to match (case-insensitive) */
  criterionMatch: string;
  /** Type of check to perform */
  type: "grep" | "file_exists" | "file_not_exists";
  /** Pattern for grep, or path for file checks */
  pattern: string;
  /** Files to search (glob) — only for grep type */
  glob?: string;
  /** Severity level */
  severity: "warning" | "flag";
}

/**
 * Structured evaluation of a single success criterion.
 * Distinguishes between "topic mentioned" and "behavior enforced".
 */
export interface CriterionEvaluation {
  /** The success criterion text from the task spec */
  criterion: string;
  /**
   * TASK-1320: the criterion's position in the spec, as the JUDGE
   * reported it.
   *
   * This is a CLAIM, not a fact: an LLM produced it. It is trusted only
   * after the echoed `criterion` text matches the spec text at that
   * position EXACTLY under normalization (round-1 R1-1 established that
   * corroborating one LLM field against another with a fuzzy threshold
   * is circular, and that any threshold below 1.0 is the fuzzy matching
   * this replaces under a different name).
   *
   * Optional: older cached judge results and models that omit it must
   * keep working, falling back to text matching unchanged.
   */
  criterionIndex?: number;
  /** Evaluation status for this criterion */
  status: "PASS" | "FAIL" | "PARTIAL";
  /** File:line reference or code path where enforcement was found */
  evidence: string;
  /** Explanation of why this status was assigned */
  reasoning: string;
  /** Type of enforcement detected */
  enforcement_type: "deterministic_code" | "llm_instruction_only" | "not_implemented";
}

/**
 * A post-parse enforcement demotion applied to a judge result (TASK-1200).
 * Records why a PASS criterion was demoted to PARTIAL so operators and fix
 * rounds can distinguish a real miss from a crude-signal artifact.
 */
export interface EnforcementDemotion {
  /** The success criterion text as echoed by the judge */
  criterion: string;
  /** Which constraint rule fired */
  rule: "llm_instruction_only" | "not_implemented" | "compliance_conflict";
  from: "PASS";
  to: "PARTIAL";
  /** Why; for compliance_conflict, names the pattern(s) that found no evidence */
  detail: string;
}

/** A non-blocking follow-up item suggested by the judge on APPROVE. */
export interface FollowUpItem {
  /** Short title for the follow-up task */
  title: string;
  /** What should be done and why */
  description: string;
  /** Category of follow-up work */
  type: "optimization" | "edge_case" | "testing" | "refactoring" | "scope_gap";
  /** Estimated effort for the follow-up */
  estimatedEffort?: "1-2 hours" | "2-3 hours" | "3-4 hours" | "4-6 hours";
}

export interface JudgeResult {
  verdict: JudgeVerdict;
  confidence: number;
  scopeViolations: string[];
  criteriaGaps: string[];
  qualityIssues: string[];
  feedback: string;
  /** Pre-judge deterministic compliance check results */
  complianceChecks?: ComplianceCheckResult[];
  /** Structured per-criterion evaluations */
  criteriaEvaluation?: CriterionEvaluation[];
  /** Post-parse enforcement demotions (TASK-1200); present when any criterion was demoted */
  enforcementDemotions?: EnforcementDemotion[];
  /** Non-blocking follow-up items (only on APPROVE) */
  followUpItems?: FollowUpItem[];
  /** Claude Agent SDK session ID — used for judge session resume */
  claudeSessionId?: string;
  /** Raw -> enforcement -> path-audit normalized trace for the successful call. */
  judgmentTrace?: JudgeJudgmentTraceEntry[];
  /** Latest normalized judge-stage decision; additive compatibility projection. */
  judgmentDecision?: JudgmentDecision;
  judgmentProjectionFailure?: JudgmentProjectionFailure;
}

// Agent output seal: durable git evidence captured after each worker attempt.
export type AgentOutputSnapshotKind = "worker" | "retry" | "lifecycle_fix";

export interface AgentOutputSnapshotFile {
  status: string;
  path: string;
  previousPath?: string;
}

export interface AgentOutputSnapshot {
  taskId: string;
  attempt: number;
  kind: AgentOutputSnapshotKind;
  sealedAt: string;
  diffBase: string;
  diffRef: string;
  baseSha: string;
  headShaBefore: string;
  headShaAfter: string;
  sealedCommitSha?: string;
  branchName?: string;
  worktreePath: string;
  manifestPath: string;
  diffPath: string;
  statusPath: string;
  nameStatusPath: string;
  gitDiff: string;
  diffStat: string;
  statusShort: string;
  changedFiles: string[];
  nameStatus: AgentOutputSnapshotFile[];
  filesStaged: number;
  excludedFiles: string[];
  claudeSessionId?: string;
  empty: boolean;
  /**
   * TASK-1313: producer results carried on the typed snapshot so
   * checkpoint restores can re-derive judgment signals without
   * re-sealing (they previously lived only in manifest.json).
   * Type-only imports from judgment/producers — no runtime cycle.
   */
  sealConformance?: import("../judgment/producers/seal-conformance.js").SealConformanceSummary;
  secretScan?: import("../judgment/producers/secret-scan.js").SecretScanSummary;
}

// ─── Agent Worker Types ───────────────────────────────────────────

export type AgentMessageRole = "user" | "assistant" | "system";

export interface AgentMessage {
  role: AgentMessageRole;
  content: string;
  timestamp: string;
  turnNumber: number;
}

export interface AgentResult {
  taskId: string;
  outcome: TaskOutcome;
  filesModified: string[];
  filesCreated: string[];
  verification: VerificationResult | null;
  turnsUsed: number;
  totalCostUsd: number;
  messages: AgentMessage[];
  error?: string;
  /** Claude Agent SDK session ID — used for session resume */
  claudeSessionId?: string;
  /**
   * TASK-1313: PRE-FILTER producer facts accumulated by the worker's
   * bash-guard hooks (branch-mutation attempt classifications incl.
   * plain writes, and deploy classifications incl. shape-only) so the
   * judge stage can receive them as injected signals. Absent = none.
   */
  safetyFacts?: Array<
    | import("../judgment/producers/branch-mutation.js").BranchMutationFact
    | import("../judgment/producers/deploy-classifier.js").DeployFact
  >;
}

// ─── Dispatch Result Types ────────────────────────────────────────

export type DispatchOutcome =
  | "approved"
  | "rejected"
  | "needs_review"
  | "no_changes"
  | "gate_failed"
  | "agent_failed"
  | "awaiting_approval"
  | "awaiting_judge_approval"
  | "safety_stop"
  /**
   * TASK-1332 (QPI-045, round-2 R2-5): the run refused to consume an
   * artifact whose spec contract no longer matches, or could not be
   * verified against. RECOVERABLE and distinct from `error`: nothing
   * crashed and nothing was destroyed. Stale or unverifiable artifacts
   * recover by replan; a contested id recovers by removing or renaming
   * the extra claimant file. Kept separate so the control plane can stop
   * calling a deliberate refusal a failure, the same mistake QPI-041
   * made about a pause.
   */
  | "spec_changed"
  | "error";

export interface DispatchResult {
  taskId: string;
  outcome: DispatchOutcome;
  prUrl?: string;
  branchName?: string;
  agentResult?: AgentResult;
  judgeResult?: JudgeResult;
  gateResult?: GateResult;
  retriesUsed: number;
  error?: string;
  autoMerged?: boolean;
  mergeCommitSha?: string;
  lifecycleResult?: LifecycleResult;
  outputSnapshots?: AgentOutputSnapshot[];
}

// ─── Prior Run Context (for structured retry) ────────────────────

export interface PriorRunContext {
  /** Judge feedback text from prior attempt */
  judgeFeedback: string;
  /** Per-criterion evaluations that failed/partial */
  failedCriteria: CriterionEvaluation[];
  /** Verification commands that failed */
  failedVerification: VerifyCommandResult[];
  /** Files modified by the prior agent run */
  filesModified: string[];
}

// ─── Lifecycle Types ─────────────────────────────────────────────

export interface VerifiedJsonEntry {
  verified: string;
  commit: string;
  /**
   * Provenance of the verified-record write. TASK-1106 adds `validation-intake`
   * for branch+evidence verification flows, and (cleanup) documents the live
   * federated/reconcile method values that were previously omitted from this
   * union despite being written to disk by `recordVerification()`. Readers no
   * longer need `as` casts to surface these values.
   */
  method:
    | "pipeline"
    | "verify-task"
    | "manual"
    | "soft-verified"
    | "api"
    | "validation-intake"
    | "forward-intake"
    | "federated-orchestrator"
    | "federation-sync"
    | "reconcile"
    | "on-merge"
    | "loop-finalize"
    | "v1-review"
    | "migration-scan";
  verdict: "VERIFIED" | "FAILED" | "SOFT-VERIFIED" | "REJECTED";
  criteriaChecked: number;
  criteriaPassed: number;
  notes: string;
}

export interface LifecycleResult {
  verified: boolean;
  fixAttemptsUsed: number;
  statusUpdated: boolean;
  blockersResolved: string[];
  parentCompleted: string | null;
  verificationFindings: VerificationFinding[];
  error?: string;
}

// ─── Runtime Check Types ─────────────────────────────────────────

export interface RuntimeCheckConfig {
  startCommand: string;
  healthUrl: string;
  routes: string[];
  baseUrl: string;
  startupTimeoutMs?: number;
  routeTimeoutMs?: number;
}

export interface RuntimeRouteResult {
  route: string;
  loaded: boolean;
  statusCode: number | null;
  consoleErrors: string[];
  uncaughtExceptions: string[];
  screenshotPath?: string;
  durationMs: number;
}

export interface RuntimeCheckResult {
  available: boolean;
  serverStarted: boolean;
  routeResults: RuntimeRouteResult[];
  screenshots: string[];
  warnings: string[];
  error?: string;
}

// ─── Session / Result Types ────────────────────────────────────────

export type TaskOutcome =
  | "success"
  | "failure"
  | "timeout"
  | "budget_exceeded"
  // TASK-1314: SDK error_max_turns maps here; joins the dispatcher's
  // recoverable-resume class (a resumed session gets a fresh allotment).
  | "max_turns";

export interface SessionResult {
  sessionId: string;
  taskId: string;
  project: string;
  startTime: string;
  endTime: string;
  durationMs: number;
  model: string;
  totalCostUsd: number;
  turnsUsed: number;
  turnsMax: number;
  readinessGate: {
    schemaValid: boolean;
    depthScore: number;
    enriched: boolean;
  };
  filesModified: string[];
  filesCreated: string[];
  verification: VerificationResult;
  judgeResult: JudgeResult;
  result: TaskOutcome;
  prUrl?: string;
}
