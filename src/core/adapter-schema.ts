import { z } from "zod";
import { ReviewerRunnerConfigSchema } from "../review/reviewer-config.js";
import { JudgmentConfigSchema } from "../judgment/runner/intent-judgment-config.js";

// ─── Sub-schemas ────────────────────────────────────────────────────

export const TestPatternConfigSchema = z.object({
  testDir: z.string(),
  sourceDir: z.string(),
  suffixes: z.array(z.string()).default([]),
  prefixes: z.array(z.string()).default([]),
  autoConventions: z.array(z.string()).default([]),
});

export const AdapterProjectConfigSchema = z.object({
  name: z.string().min(1, "project.name must not be empty"),
  root: z.string().min(1, "project.root must not be empty"),
  taskDir: z.string().min(1, "project.taskDir must not be empty"),
  conventionsDir: z.string().min(1, "project.conventionsDir must not be empty"),
  testPatterns: TestPatternConfigSchema.optional(),
});

export const AdapterAgentConfigSchema = z.object({
  model: z.string().default("claude-opus-4-6"),
  judgeModel: z.string().default("claude-sonnet-4-6"),
  enrichModel: z.string().default("claude-sonnet-4-6"),
  maxTurns: z.number().int().positive().default(50),
  maxBudgetPerTask: z.number().positive().default(5.0),
  maxRetries: z.number().int().min(0).default(1),
  apiKeys: z
    .object({
      pool: z.array(z.string()).min(1),
      strategy: z.enum(["round-robin", "least-used", "least-cost"]).default("round-robin"),
      cooldownMs: z.number().int().positive().default(60000),
    })
    .optional(),
});

export const RevisionConfigSchema = z
  .object({
    maxBudget: z.number().positive().default(2.0),
    maxTurns: z.number().int().positive().default(50),
  })
  .optional();

export const VerificationCommandDockerConfigSchema = z.object({
  composeFile: z.string().min(1),
  service: z.string().min(1),
  warmUp: z.boolean().default(false),
  dependsOn: z.array(z.string()).default([]),
});

export const VerificationCommandSchema = z.object({
  name: z.string().min(1),
  command: z.string().min(1),
  required: z.boolean(),
  timeout: z.number().int().positive(),
  phase: z.enum(["fast", "thorough", "all"]).default("all"),
  environment: z.enum(["host", "docker"]).default("host"),
  docker: VerificationCommandDockerConfigSchema.optional(),
});

export const ConventionCheckSchema = z.object({
  name: z.string().min(1),
  description: z.string(),
  command: z.string().min(1),
  conventionRef: z.string(),
});

export const PostJudgeConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    layers: z
      .array(z.enum(["deterministic", "structural", "semantic"]))
      .default(["deterministic", "structural", "semantic"]),
    model: z.string().default("claude-haiku-4-5-20251001"),
    failOnBuildError: z.boolean().default(true),
    failOnTestError: z.boolean().default(true),
    failOnLintError: z.boolean().default(false),
    maxSemanticTokens: z.number().int().positive().default(12000),
  })
  .optional();

export const SmartTestingConfigSchema = z
  .object({
    enabled: z.boolean().default(true),
    mode: z.enum(["related", "full"]).default("related"),
    baselineEnabled: z.boolean().default(true),
    failOnPreExisting: z.boolean().default(false),
    outputDir: z.string().default(".quack/test-results"),
  })
  .optional();

export const TieredTestingConfigSchema = z
  .object({
    enabled: z.boolean().default(false),
    dockerCommand: z.string().optional(),
    tier3Frequency: z.number().int().positive().default(5),
    outputDir: z.string().default(".quack/test-results"),
  })
  .optional();

export const RetentionConfigSchema = z
  .object({
    maxResults: z.number().int().positive().default(50),
    maxAgeDays: z.number().int().positive().default(30),
    keepBaselines: z.boolean().default(true),
  })
  .optional();

export const AdapterVerificationConfigSchema = z.object({
  commands: z
    .array(VerificationCommandSchema)
    .min(1, "At least one verification command is required"),
  conventionChecks: z.array(ConventionCheckSchema).default([]),
  postJudge: PostJudgeConfigSchema,
  smartTesting: SmartTestingConfigSchema,
  tieredTesting: TieredTestingConfigSchema,
  retention: RetentionConfigSchema,
});

export const AdapterSandboxConfigSchema = z.object({
  writablePaths: z.array(z.string()).default(["src/", "tests/"]),
  // TASK-1313 (ratified decision 2): Tier-S verification machinery is
  // denied by DEFAULT — the agent must not edit the files that decide
  // whether its work passed. SHARP EDGE: zod defaults NEVER merge into
  // an explicitly configured array; adapters that set deniedPaths keep
  // exactly their list and must add these entries themselves.
  deniedPaths: z
    .array(z.string())
    .default([
      ".env",
      ".env.*",
      ".quack/adapter.json",
      ".quack/verify.js",
      ".quack/judge-criteria.md",
      ".quack/conventions.md",
      ".quack/convention-checks/",
      ".quack/templates/",
    ]),
  allowedBashPatterns: z.array(z.string()).default([]),
  deniedBashPatterns: z.array(z.string()).default([]),
});

export const BranchGroupSchema = z.object({
  baseBranch: z.string().min(1),
  autoMergeTarget: z.string().optional(),
  description: z.string().optional(),
  taskPattern: z.string().optional(),
});

export const BranchCleanupPolicyConfigSchema = z.object({
  enabled: z.boolean().default(true),
  retentionDays: z.number().positive().optional(),
  allowedPrefixes: z.array(z.string().min(1)).optional(),
  protectedOwners: z.array(z.string().min(1)).optional(),
  protectedPatterns: z.array(z.string().min(1)).optional(),
  requireOwnerOverride: z.boolean().default(true),
  scheduled: z
    .object({
      enabled: z.boolean().optional(),
      apply: z.boolean().optional(),
      intervalMinutes: z.number().positive().optional(),
    })
    .optional(),
});

export const AdapterGitConfigSchema = z.object({
  baseBranch: z.string().default("main"),
  branchPrefix: z.string().default("quack/"),
  commitFormat: z.string().min(1),
  commitTrailer: z.string(),
  autoCreatePr: z.boolean().default(true),
  autoPush: z.boolean().default(true),
  autoMerge: z.boolean().default(false),
  autoMergeTarget: z.string().optional(),
  autoMergeStrategy: z.enum(["squash", "merge", "rebase"]).default("squash"),
  branchGroups: z.record(z.string(), BranchGroupSchema).optional(),
  protectedBranches: z.array(z.string()).optional(),
  branchRetentionDays: z.number().positive().optional(),
  branchCleanup: BranchCleanupPolicyConfigSchema.optional(),
});

export const AdapterLoggingConfigSchema = z.object({
  dir: z.string().min(1),
  level: z.enum(["debug", "info", "warn", "error"]).default("debug"),
  retainDays: z.number().int().positive().default(30),
});

export const AdapterWorkerOverlayConfigSchema = z
  .object({
    projectRoot: z.string().min(1).optional(),
    taskDir: z.string().min(1).optional(),
    logDir: z.string().min(1).optional(),
    endpoints: z.record(z.string(), z.string()).optional(),
    shell: z
      .object({
        preferred: z.enum(["bash", "cmd", "powershell", "pwsh", "wsl"]).optional(),
        bashPath: z.string().min(1).optional(),
        nodePath: z.string().min(1).optional(),
      })
      .optional(),
    capabilities: z.record(z.string(), z.boolean()).optional(),
  })
  .optional();

// ─── Automation schemas ─────────────────────────────────────────────

export const AutoPrepConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxConcurrent: z.number().int().positive().default(1),
  cooldownSeconds: z.number().int().min(0).default(30),
  maxPerHour: z.number().int().positive().default(20),
  maxBudgetPerHour: z.number().positive().default(2.0),
  priorityOrder: z
    .enum(["priority_then_id", "id_only", "dependency_chain"])
    .default("priority_then_id"),
  skipPrepped: z.boolean().default(true),
});

export const AutomationConfigSchema = z.object({
  autoPrep: AutoPrepConfigSchema.default({
    enabled: false,
    maxConcurrent: 1,
    cooldownSeconds: 30,
    maxPerHour: 20,
    maxBudgetPerHour: 2.0,
    priorityOrder: "priority_then_id",
    skipPrepped: true,
  }),
});

// ─── Fleet Budget Schema ────────────────────────────────────────────

export const FleetBudgetConfigSchema = z.object({
  dailyCapUsd: z.number().positive().default(25.0),
  hourlyCapUsd: z.number().positive().default(10.0),
  perWaveCapUsd: z.number().positive().default(15.0),
  alertThresholds: z.array(z.number().min(0).max(100)).default([50, 75, 90]),
  enforceHard: z.boolean().default(true),
});

// ─── Cost Velocity Schema ─────────────────────────────────────────

export const CostVelocityConfigSchema = z.object({
  enabled: z.boolean().default(false),
  windowMinutes: z.number().positive().default(5),
  warnMultiplier: z.number().positive().default(3),
  killMultiplier: z.number().positive().default(5),
  minSamplesForBaseline: z.number().int().positive().default(5),
});

// ─── Stuck Detection Schema ──────────────────────────────────────

export const StuckDetectionConfigSchema = z.object({
  enabled: z.boolean().default(true),
  warningMinutes: z.number().positive().default(5),
  criticalMinutes: z.number().positive().default(10),
  killMinutes: z.number().positive().default(15),
  checkIntervalSeconds: z.number().positive().default(30),
  fileHeartbeat: z.boolean().default(true),
});

// ─── Deterministic Check Schema ────────────────────────────────────

export const DeterministicCheckSchema = z.object({
  name: z.string().min(1),
  criterionMatch: z.string().min(1),
  type: z.enum(["grep", "file_exists", "file_not_exists"]),
  pattern: z.string().min(1),
  glob: z.string().optional(),
  severity: z.enum(["warning", "flag"]).default("flag"),
});

// ─── Model Routing Schema ─────────────────────────────────────────

export const ModelRoutingConfigSchema = z.object({
  gateModel: z.string().default("claude-haiku-4-5-20251001"),
  enrichModel: z.string().default("claude-haiku-4-5-20251001"),
  plannerModel: z.string().default("claude-haiku-4-5-20251001"),
  workerModel: z.string().default("claude-sonnet-4-6"),
  workerComplexModel: z.string().default("claude-opus-4-6"),
  judgeModel: z.string().default("claude-sonnet-4-6"),
  retryEscalation: z.boolean().default(true),
});

// ─── Gate Config Schema ──────────────────────────────────────────

export const GateConfigSchema = z.object({
  requiredSections: z
    .array(z.enum(["currentState", "recommendedApproach", "filesToModify"]))
    .default([]),
});

// ─── Batch Config Schema ──────────────────────────────────────────

export const BatchConfigSchema = z.object({
  enabled: z.boolean().default(false),
  minBatchSize: z.number().int().positive().default(2),
  maxWaitSeconds: z.number().positive().default(30),
  pollIntervalMs: z.number().positive().default(5000),
  timeoutMs: z.number().positive().default(300000),
});

// ─── Docker Isolation schemas ─────────────────────────────────────

export const DockerIsolationConfigSchema = z.object({
  image: z.string().default("node:20-slim"),
  buildContext: z.string().optional(),
  volumes: z.array(z.string()).default([]),
  envPassthrough: z.array(z.string()).default(["ANTHROPIC_API_KEY"]),
  resourceLimits: z
    .object({
      memoryMb: z.number().int().positive().default(4096),
      cpus: z.number().positive().default(2),
      storageMb: z.number().int().positive().optional(),
    })
    .default({ memoryMb: 4096, cpus: 2 }),
  networkMode: z.enum(["bridge", "host", "none"]).default("bridge"),
  preInstallCommand: z.string().optional(),
  cleanupPolicy: z.enum(["remove", "keep_on_failure", "always_keep"]).default("remove"),
});

export const IsolationConfigSchema = z.object({
  method: z.enum(["worktree", "docker"]).default("worktree"),
  dockerCleanup: z.boolean().default(true),
  docker: DockerIsolationConfigSchema.optional(),
});

// ─── Dispatch Queue Schema ──────────────────────────────────────────

export const DispatchQueueConfigSchema = z.object({
  maxConcurrent: z.number().int().positive().default(1),
  cooldownBetweenTasksMs: z.number().int().min(0).default(5000),
  failurePropagation: z
    .enum(["fail_fast", "skip_dependents", "continue_all"])
    .default("skip_dependents"),
  fleetBudgetUsd: z.number().min(0).default(0),
  pauseOnFailure: z.boolean().default(false),
  persistState: z.boolean().default(true),
  autoStartOnEnqueue: z.boolean().default(false),
});

// ─── Preflight Config Schema ─────────────────────────────────────────

export const ComplexityThresholdsSchema = z.object({
  maxFilesBeforeDecompose: z.number().int().positive().default(6),
  maxCriteriaBeforeDecompose: z.number().int().positive().default(8),
  maxContextTokensBeforeDecompose: z.number().int().positive().default(35000),
  maxIndependentFeatures: z.number().int().positive().default(3),
});

export const AutoDecomposeConfigSchema = z.object({
  enabled: z.boolean().default(false),
  maxSubtasks: z.number().int().min(2).max(6).default(4),
  writeSpecs: z.boolean().default(true),
  /** Minimum parent prep depth score required before finalize is allowed */
  parentPrepThreshold: z.number().min(0).max(5).default(4.0),
});

export const BlueprintAutoApproveRulesSchema = z.object({
  maxFiles: z.number().int().positive().default(3),
  maxCriteria: z.number().int().positive().default(5),
  minBlueprintScore: z.number().min(0).max(1).default(0.8),
  requireDecomposition: z.boolean().default(false),
});

export const JudgeAutoApproveRulesSchema = z.object({
  requireVerificationPass: z.boolean().default(true),
  maxFilesChanged: z.number().int().positive().default(3),
  maxDiffLines: z.number().int().positive().default(200),
});

export const PreflightConfigSchema = z.object({
  autoRun: z.boolean().default(false),
  complexityThresholds: ComplexityThresholdsSchema.default({
    maxFilesBeforeDecompose: 6,
    maxCriteriaBeforeDecompose: 8,
    maxContextTokensBeforeDecompose: 35000,
    maxIndependentFeatures: 3,
  }),
  specReview: z
    .object({
      enabled: z.boolean().default(true),
      model: z.string().default("claude-haiku-4-5-20251001"),
    })
    .default({ enabled: true, model: "claude-haiku-4-5-20251001" }),
  blueprintApproval: z
    .object({
      enabled: z.boolean().default(false),
      autoApproveWhen: BlueprintAutoApproveRulesSchema.default({
        maxFiles: 3,
        maxCriteria: 5,
        minBlueprintScore: 0.8,
        requireDecomposition: false,
      }),
      approvalTimeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
  judgeApproval: z
    .object({
      enabled: z.boolean().default(false),
      autoApproveWhen: JudgeAutoApproveRulesSchema.default({
        requireVerificationPass: true,
        maxFilesChanged: 3,
        maxDiffLines: 200,
      }),
      approvalTimeoutMs: z.number().int().positive().optional(),
    })
    .optional(),
  autoDecompose: AutoDecomposeConfigSchema.default({
    enabled: false,
    maxSubtasks: 4,
    writeSpecs: true,
    parentPrepThreshold: 4.0,
  }),
});

export const LoopConfigSchema = z
  .object({
    briefReview: z
      .object({
        reviewer: ReviewerRunnerConfigSchema.default({
          runner: "claude-sdk",
          maxTurns: 30,
          timeoutMs: 600_000,
          codex: { binaryPath: "codex", sandbox: "read-only" },
        }),
        requireCrossModel: z.boolean().default(false),
        autoApproveWhen: BlueprintAutoApproveRulesSchema.optional(),
      })
      .strict(),
    diffReview: z
      .object({
        reviewer: ReviewerRunnerConfigSchema.default({
          runner: "claude-sdk",
          maxTurns: 30,
          timeoutMs: 600_000,
          codex: { binaryPath: "codex", sandbox: "read-only" },
        }),
        requireCrossModel: z.boolean().default(false),
        autoApproveWhen: JudgeAutoApproveRulesSchema.optional(),
      })
      .strict(),
    models: z
      .object({
        investigate: z.string().min(1).optional(),
        build: z.string().min(1).optional(),
        judge: z.string().min(1).optional(),
      })
      .strict()
      .optional(),
    recordOnFinalize: z.boolean().default(true),
  })
  .strict();

// ─── Enrichment auto-commit schema (TASK-922) ───────────────────────

/**
 * Controls whether the legacy auto-enrich endpoints
 * (`POST /api/tasks/:id/enrich` auto-approve path and
 * `POST /api/tasks/:id/enrich/approve`) commit and push the
 * enriched task spec to the canonical clone after writing it to disk.
 *
 * Default is `enabled: false` so operator/laptop clones preserve the
 * current "write only, no git" behavior. Headnode-style canonical
 * clones flip `enabled: true` to keep the working tree clean and
 * advance dev with the enrichment in a single step.
 */
export const EnrichmentAutoCommitConfigSchema = z.object({
  /** Master switch. Defaults to false so non-canonical clones do not auto-commit. */
  enabled: z.boolean().default(false),
  /** When true, push the commit to origin/<baseBranch>. When false, commit locally only. */
  push: z.boolean().default(true),
  /**
   * Commit message template. Supports {taskId}, {baseSpecHash}, {effectiveSpecHash}
   * substitutions. Defaults to a stable spec-channel commit prefix.
   */
  commitMessageTemplate: z.string().min(1).default("spec(enrich): {taskId} auto-enrichment"),
  /**
   * Branches on which auto-commit MUST NOT run. Defends against accidentally
   * writing to protected branches even when the canonical clone is checked
   * out to one. Defaults to the common protected branch names.
   */
  skipBranches: z.array(z.string().min(1)).default(["main", "production", "staging", "prod"]),
});

export const EnrichmentConfigSchema = z.object({
  autoCommit: EnrichmentAutoCommitConfigSchema.default({
    enabled: false,
    push: true,
    commitMessageTemplate: "spec(enrich): {taskId} auto-enrichment",
    skipBranches: ["main", "production", "staging", "prod"],
  }),
});

// ─── Validation Intake schema (TASK-1106) ─────────────────────────────

/**
 * Per-project Validation Intake tuning. Optional and additive — adapters
 * without this block fall back to defaults.
 *
 * `.strict()` so unknown keys fail loudly rather than silently dropping
 * (matches the wire-payload `.strict()` policy in src/intake/task-intake.ts).
 *
 * Note: This config is intentionally part of the shared adapter bundle hash
 * (NOT in MACHINE_LOCAL_ADAPTER_FIELDS in adapter-loader.ts) so federated
 * workers cannot diverge from headnode policy on what counts as scope drift.
 */
export const ValidationIntakeConfigSchema = z
  .object({
    /**
     * Maximum allowed `changed_but_unclaimed` file count before the
     * scope-hygiene gate REVISEs (when nonClaims is empty). Default: 5.
     */
    driftThreshold: z.number().int().nonnegative().default(5),
  })
  .strict();

// ─── Integrations schema ────────────────────────────────────────────

const GitHubConfigSchema = z.object({
  owner: z.string().min(1, "GitHub owner is required"),
  repo: z.string().min(1, "GitHub repo is required"),
  importLabel: z.string().optional().default("quack-ready"),
  publishLabel: z.string().optional().default("quack-task"),
  pollEnabled: z.boolean().optional().default(false),
  pollIntervalMs: z.number().int().positive().optional().default(300000),
  statusSyncIntervalMs: z.number().int().positive().optional().default(600000),
  reportBack: z.boolean().optional().default(true),
  closeOnMerge: z.boolean().optional().default(true),
  labels: z
    .object({
      ready: z.string().optional().default("quack-ready"),
      inProgress: z.string().optional().default("quack-in-progress"),
      approved: z.string().optional().default("quack-approved"),
      rejected: z.string().optional().default("quack-rejected"),
      task: z.string().optional().default("quack-task"),
    })
    .optional(),
});

const IntegrationsConfigSchema = z.object({
  github: GitHubConfigSchema.optional(),
});

// ─── Worktree Init schema ────────────────────────────────────────────

export const WorktreeInitStepSchema = z.object({
  /** Shell command to run, e.g. "npm ci" or "pip install -r requirements.txt" */
  command: z.string().min(1),
  /** Working directory relative to the worktree root. Defaults to worktree root. */
  cwd: z.string().optional(),
  /** Additional environment variables to set for this step */
  env: z.record(z.string(), z.string()).optional(),
  /** Human-readable label for logging/event emission */
  label: z.string().optional(),
});

export const DispatchConfigSchema = z.object({
  /**
   * Optional explicit list of init steps to run after worktree creation.
   * Each entry is either a plain shell command string or a structured step object.
   * When omitted, auto-discovery is used (finds package.json files, runs npm ci).
   */
  worktreeInit: z.array(z.union([z.string(), WorktreeInitStepSchema])).optional(),
});

// ─── Recording (TASK-1201) ──────────────────────────────────────────

export const RecordingConfigSchema = z.object({
  /** Record-on-merge scanner; absent section means defaults at the use site (enabled, 5 min). */
  onMerge: z
    .object({
      enabled: z.boolean().default(true),
      intervalMs: z.number().int().positive().default(300_000),
    })
    .optional(),
});

// ─── Root schema ────────────────────────────────────────────────────

export const AdapterConfigSchema = z.preprocess(
  (data) => {
    // Provide default values for optional nested objects
    const input = data as Record<string, unknown>;
    return {
      ...input,
      agent: input.agent ?? {},
      sandbox: input.sandbox ?? {},
    };
  },
  z.object({
    $schema: z.string().optional(),
    version: z.string().min(1, "version is required"),
    project: AdapterProjectConfigSchema,
    agent: AdapterAgentConfigSchema,
    verification: AdapterVerificationConfigSchema,
    sandbox: AdapterSandboxConfigSchema,
    git: AdapterGitConfigSchema,
    logging: AdapterLoggingConfigSchema,
    deploy: z
      .object({
        productionMarkers: z
          .object({
            registries: z.array(z.string()).optional(),
            environments: z.array(z.string()).optional(),
            extraCommandPatterns: z.array(z.string()).optional(),
          })
          .optional(),
      })
      .optional(),
    automation: AutomationConfigSchema.optional(),
    fleetBudget: FleetBudgetConfigSchema.optional(),
    costVelocity: CostVelocityConfigSchema.optional(),
    stuckDetection: StuckDetectionConfigSchema.optional(),
    deterministicChecks: z.array(DeterministicCheckSchema).optional(),
    isolation: IsolationConfigSchema.optional(),
    modelRouting: ModelRoutingConfigSchema.optional(),
    gate: GateConfigSchema.optional(),
    batchConfig: BatchConfigSchema.optional(),
    queue: DispatchQueueConfigSchema.optional(),
    preflight: PreflightConfigSchema.optional(),
    revision: RevisionConfigSchema,
    recording: RecordingConfigSchema.optional(),
    integrations: IntegrationsConfigSchema.optional(),
    dispatch: DispatchConfigSchema.optional(),
    enrichment: EnrichmentConfigSchema.optional(),
    validationIntake: ValidationIntakeConfigSchema.optional(),
    workerOverlay: AdapterWorkerOverlayConfigSchema,
    executionMode: z.enum(["dispatch", "loop"]).default("dispatch"),
    loop: LoopConfigSchema.optional(),
    judgment: JudgmentConfigSchema.optional(),
  }),
);

export type InferredAdapterConfig = z.infer<typeof AdapterConfigSchema>;
