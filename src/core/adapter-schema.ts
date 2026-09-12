import { isIP } from "node:net";
import { z } from "zod";
import { ReviewerRunnerConfigSchema } from "../review/reviewer-config.js";
import { JudgmentConfigSchema } from "../judgment/runner/intent-judgment-config.js";

// ─── Sub-schemas ────────────────────────────────────────────────────

function isCanonicalSha512Sri(value: string): boolean {
  if (!/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) return false;
  const encoded = value.slice("sha512-".length);
  try {
    const digest = Buffer.from(encoded, "base64");
    return digest.length === 64 && digest.toString("base64") === encoded;
  } catch {
    return false;
  }
}

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

export const CodexImplementationWorkerConfigSchema = z
  .object({
    binaryPath: z.string().min(1).default("codex"),
    /** Hard floor: implementation may write only inside the selected worktree. */
    sandbox: z.literal("workspace-write").default("workspace-write"),
    /** CODEX_HOME override for an unattended/headless authenticated profile. */
    codexHome: z.string().min(1).optional(),
    /** Optional named Codex CLI profile. */
    profile: z.string().min(1).optional(),
    /** Optional provider id, passed as a fixed model_provider override. */
    provider: z
      .string()
      .regex(/^[A-Za-z0-9._-]+$/)
      .optional(),
    /** Provider API-key environment variable copied into the scrubbed Codex env. */
    credentialEnvVar: z
      .string()
      .regex(/^[A-Z_][A-Z0-9_]*$/)
      .refine((name) => !name.startsWith("QUACK_"), {
        message: "credentialEnvVar cannot use the QUACK_* namespace",
      })
      .optional(),
    /** Wall-clock ceiling; expiry kills the complete Codex process tree. */
    timeoutMs: z.number().int().positive().default(1_800_000),
  })
  .strict();

export const AdapterAgentConfigSchema = z.object({
  /** Implementation backend. Existing adapters remain on the Claude SDK. */
  runner: z.enum(["claude-sdk", "codex-cli"]).default("claude-sdk"),
  model: z.string().default("claude-opus-4-6"),
  judgeModel: z.string().default("claude-sonnet-4-6"),
  enrichModel: z.string().default("claude-sonnet-4-6"),
  maxTurns: z.number().int().positive().default(50),
  maxBudgetPerTask: z.number().positive().default(5.0),
  maxRetries: z.number().int().min(0).default(1),
  codex: CodexImplementationWorkerConfigSchema.optional(),
  apiKeys: z
    .object({
      pool: z
        .array(
          z
            .string()
            .regex(
              /^env:ANTHROPIC_API_KEY(?:_\d+)?$/,
              "Use named Anthropic key references such as env:ANTHROPIC_API_KEY_2",
            ),
        )
        .min(1),
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

const VERIFICATION_RESERVED_ENV_NAMES = new Set([
  "APPDATA",
  "BASHOPTS",
  "BASH_ENV",
  "CODEX_HOME",
  "COMSPEC",
  "ENV",
  "HOME",
  "HOMEDRIVE",
  "HOMEPATH",
  "LOCALAPPDATA",
  "NODE_OPTIONS",
  "NODE_PATH",
  "PATH",
  "PATHEXT",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYLIB",
  "RUBYOPT",
  "SHELLOPTS",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "ZDOTDIR",
]);
const VERIFICATION_RESERVED_ENV_PREFIXES = ["DYLD_", "GIT_", "LD_", "NPM_CONFIG_", "QUACK_"];

const VerificationCommandEnvironmentSchema = z
  .record(z.string(), z.string())
  .superRefine((environment, context) => {
    for (const name of Object.keys(environment)) {
      const normalized = name.toUpperCase();
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(normalized)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: "Environment variable names must use letters, digits, and underscores",
        });
      } else if (
        VERIFICATION_RESERVED_ENV_NAMES.has(normalized) ||
        VERIFICATION_RESERVED_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: "Reserved process, runtime, package-manager, or isolation variable",
        });
      }
    }
  });

const VerificationCommandBaseSchema = z.object({
  name: z.string().min(1),
  required: z.boolean(),
  timeout: z.number().int().positive(),
  phase: z.enum(["fast", "thorough", "all"]).default("all"),
  environment: z.enum(["host", "docker"]).default("host"),
  docker: VerificationCommandDockerConfigSchema.optional(),
});

export const VerificationCommandSchema = z.union([
  VerificationCommandBaseSchema.extend({
    command: z.string().min(1),
    cmd: z.never().optional(),
    args: z.never().optional(),
    cwd: z.string().optional(),
    env: VerificationCommandEnvironmentSchema.optional(),
  }),
  VerificationCommandBaseSchema.extend({
    command: z.never().optional(),
    cmd: z.string().min(1),
    args: z.array(z.string()),
    cwd: z.string().optional(),
    env: VerificationCommandEnvironmentSchema.optional(),
  }),
]);

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

export const DockerVerificationSandboxConfigSchema = z
  .object({
    image: z
      .string()
      .regex(
        /^(?:docker\.io\/library\/)?node(?::[A-Za-z0-9._-]+)?@sha256:[a-fA-F0-9]{64}$/,
        "dockerSandbox.image must be an immutable official Node image digest",
      ),
    pidsLimit: z.number().int().min(16).max(4096).default(256),
    memoryMb: z.number().int().min(128).max(32768).default(2048),
    cpus: z.number().positive().max(16).default(2),
    tmpfsSizeMb: z.number().int().min(16).max(4096).default(256),
    dependencyRoots: z
      .array(
        z
          .string()
          .refine(
            (value) =>
              value === "." ||
              (/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) &&
                !value.split("/").some((segment) => segment === "." || segment === "..")),
            "dependency roots must be normalized relative paths",
          ),
      )
      .min(1)
      .max(32)
      .refine((values) => new Set(values).size === values.length, "dependency roots must be unique")
      .default(["."]),
    allowedRegistryOrigins: z
      .array(
        z
          .string()
          .url()
          .refine((value) => {
            try {
              const url = new URL(value);
              return (
                url.protocol === "https:" &&
                !url.username &&
                !url.password &&
                !url.port &&
                url.pathname === "/" &&
                !url.search &&
                !url.hash &&
                isIP(url.hostname) === 0
              );
            } catch {
              return false;
            }
          }, "registries must be credential-free HTTPS hostname origins"),
      )
      .min(1)
      .max(16)
      .refine((values) => new Set(values).size === values.length, "registry origins must be unique")
      .default(["https://registry.npmjs.org"]),
    offlineNativeRebuilds: z
      .array(
        z
          .object({
            dependencyRoot: z
              .string()
              .refine(
                (value) =>
                  value === "." ||
                  (/^[A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*$/.test(value) &&
                    !value.split("/").some((segment) => segment === "." || segment === "..")),
                "native rebuild dependency roots must be normalized relative paths",
              ),
            packageName: z
              .string()
              .regex(
                /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/,
                "native rebuild package names must be normalized npm names",
              ),
            version: z
              .string()
              .regex(
                /^(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/,
                "native rebuild versions must be exact semantic versions",
              ),
            integrity: z
              .string()
              .refine(
                isCanonicalSha512Sri,
                "native rebuild integrity must be a canonical 64-byte sha512 SRI",
              ),
            installScript: z
              .string()
              .min(1)
              .max(512)
              .refine(
                (value) => !/[\0\r\n]/.test(value),
                "native rebuild install scripts cannot contain control lines",
              ),
          })
          .strict(),
      )
      .max(16)
      .refine(
        (values) =>
          new Set(values.map((entry) => `${entry.dependencyRoot}\0${entry.packageName}`)).size ===
          values.length,
        "native rebuild packages must be unique within each dependency root",
      )
      .default([]),
    setupTimeoutMs: z.number().int().positive().max(3_600_000).default(600_000),
    maxContextBytes: z
      .number()
      .int()
      .positive()
      .max(2 * 1024 * 1024 * 1024)
      .default(512 * 1024 * 1024),
    maxOutputBytes: z
      .number()
      .int()
      .min(1024)
      .max(10 * 1024 * 1024)
      .default(1024 * 1024),
  })
  .strict();

export const AdapterVerificationConfigSchema = z
  .object({
    hostExecution: z.enum(["direct", "codex-sandbox", "docker-sandbox"]).default("direct"),
    dockerSandbox: DockerVerificationSandboxConfigSchema.optional(),
    commands: z
      .array(VerificationCommandSchema)
      .min(1, "At least one verification command is required"),
    conventionChecks: z.array(ConventionCheckSchema).default([]),
    postJudge: PostJudgeConfigSchema,
    smartTesting: SmartTestingConfigSchema,
    tieredTesting: TieredTestingConfigSchema,
    retention: RetentionConfigSchema,
  })
  .superRefine((config, ctx) => {
    if (config.hostExecution === "docker-sandbox" && !config.dockerSandbox) {
      ctx.addIssue({
        code: "custom",
        path: ["dockerSandbox"],
        message: "dockerSandbox is required when hostExecution is docker-sandbox",
      });
    }
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
  disposablePaths: z.array(z.string()).optional(),
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

/**
 * Opt-in providers for structured, read-only pipeline evaluation stages.
 * Each field is independent; absence preserves the existing Claude SDK path.
 */
export const EvaluationProvidersConfigSchema = z
  .object({
    readinessDepth: ReviewerRunnerConfigSchema.optional(),
    specReview: ReviewerRunnerConfigSchema.optional(),
    blueprint: ReviewerRunnerConfigSchema.optional(),
    taskDecomposition: ReviewerRunnerConfigSchema.optional(),
    childSpecMaterialization: ReviewerRunnerConfigSchema.optional(),
    judge: ReviewerRunnerConfigSchema.optional(),
    semanticPostJudge: ReviewerRunnerConfigSchema.optional(),
    lifecycleVerify: ReviewerRunnerConfigSchema.optional(),
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

const WORKTREE_INIT_RESERVED_ENV_NAMES = new Set([
  "APPDATA",
  "BASH_ENV",
  "COMSPEC",
  "ENV",
  "HOMEDRIVE",
  "HOMEPATH",
  "HOME",
  "LD_LIBRARY_PATH",
  "LD_PRELOAD",
  "LOCALAPPDATA",
  "PATH",
  "PATHEXT",
  "PYTHONHOME",
  "PYTHONPATH",
  "PYTHONSTARTUP",
  "RUBYLIB",
  "RUBYOPT",
  "SHELLOPTS",
  "SYSTEMROOT",
  "TEMP",
  "TMP",
  "TMPDIR",
  "USERPROFILE",
  "WINDIR",
  "ZDOTDIR",
]);
const WORKTREE_INIT_RESERVED_ENV_PREFIXES = ["DYLD_", "GIT_CONFIG_", "NODE_", "NPM_"];

const WorktreeInitEnvironmentSchema = z
  .record(z.string(), z.string())
  .superRefine((environment, context) => {
    for (const name of Object.keys(environment)) {
      const normalized = name.toUpperCase();
      if (!/^[A-Z_][A-Z0-9_]*$/u.test(normalized)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: "Environment variable names must use letters, digits, and underscores",
        });
      } else if (
        WORKTREE_INIT_RESERVED_ENV_NAMES.has(normalized) ||
        WORKTREE_INIT_RESERVED_ENV_PREFIXES.some((prefix) => normalized.startsWith(prefix))
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          path: [name],
          message: "Reserved process, runtime, package-manager, or isolation variable",
        });
      }
    }
  });

export const WorktreeInitStepSchema = z.object({
  /** Shell command to run, e.g. "npm ci" or "pip install -r requirements.txt" */
  command: z.string().min(1),
  /** Working directory relative to the worktree root. Defaults to worktree root. */
  cwd: z.string().optional(),
  /** Non-reserved variables merged into Quack's stripped initialization environment. */
  env: WorktreeInitEnvironmentSchema.optional(),
  /** Human-readable label for logging/event emission */
  label: z.string().optional(),
});

export const DispatchConfigSchema = z.object({
  /**
   * Optional explicit list of init steps to run after worktree creation.
   * Each entry is either a plain shell command string or a structured step object.
   * When omitted, safe npm auto-discovery is used. An explicit [] disables init.
   */
  worktreeInit: z.array(z.union([z.string(), WorktreeInitStepSchema])).optional(),
});

// ─── Runtime Check schema ──────────────────────────────────────────

export const RuntimeCheckConfigSchema = z
  .object({
    /** Required acknowledgement: the configured server executes with host authority. */
    execution: z.literal("direct-trusted"),
    startCommand: z.string().min(1),
    healthUrl: z.string().url(),
    routes: z.array(z.string()),
    baseUrl: z.string().url(),
    startupTimeoutMs: z.number().int().positive().optional(),
    routeTimeoutMs: z.number().int().positive().optional(),
  })
  .strict();

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
    runtimeCheck: RuntimeCheckConfigSchema.optional(),
    workerOverlay: AdapterWorkerOverlayConfigSchema,
    executionMode: z.enum(["dispatch", "loop"]).default("dispatch"),
    loop: LoopConfigSchema.optional(),
    evaluationProviders: EvaluationProvidersConfigSchema.optional(),
    judgment: JudgmentConfigSchema.optional(),
  }),
);

export type InferredAdapterConfig = z.infer<typeof AdapterConfigSchema>;
