import { getClaudeSdkEnvironment } from "../sdk/claude-auth.js";
// ─── Agent Worker ───────────────────────────────────────────────────
// Core SDK integration: creates a Claude Agent SDK session, assembles
// the system prompt, configures MCP tools and hooks, runs the agent
// to completion, and returns a structured AgentResult.
//
// Uses the same ESM dynamic import pattern as depth-evaluator.ts and
// enrichment-agent.ts for the Claude Agent SDK (ESM-only package).

import { resolve as pathResolve } from "node:path";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { AgentMessage, AgentResult, TaskContext, VerificationResult } from "../core/types.js";
import { buildSystemPrompt, buildTaskPrompt } from "./prompt-builder.js";
import { createToolServer, createGitToolServer } from "./tools/server.js";
import type { ToolServerResult } from "./tools/server.js";
import { checkBashCommand, checkWritePath } from "../hooks/bash-guard.js";
import { checkGitFloor, GIT_FLOOR_REASON } from "./git-floor.js";
import {
  classifyGitMutation,
  resolveProtectedBranches,
} from "../judgment/producers/branch-mutation.js";
import { classifyDeployCommand } from "../judgment/producers/deploy-classifier.js";
import { verifyBeforeStop } from "../hooks/verify-before-stop.js";
import type { IEventWriter } from "../monitor/event-emitter.js";
import { getSdkPermissionOptions } from "../sdk/permission-mode.js";
import { parseTaskFile } from "../core/task-parser.js";
import { runCodexImplementationAgent } from "./codex-agent-worker.js";

// ─── SDK type shims ─────────────────────────────────────────────────
// Defined locally to avoid ESM/CJS import issues with the SDK package.
// These mirror the actual SDK types (see sdk.d.ts) but avoid ESM imports.

/** Content block within a BetaMessage (assistant responses) */
interface ContentBlock {
  type: string;
  text?: string; // type === "text"
  name?: string; // type === "tool_use"
  id?: string; // type === "tool_use"
  input?: Record<string, unknown>; // type === "tool_use"
}

/** Catch-all for any SDK message type */
interface SDKMessage {
  type: string;
  subtype?: string;
  [key: string]: unknown;
}

/** Per-model usage data — matches sdk.d.ts ModelUsage */
interface SDKModelUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens: number;
  cacheCreationInputTokens: number;
  costUSD: number;
}

/** SDK result on success — fields match sdk.d.ts SDKResultSuccess */
interface SDKSuccessResult {
  type: "result";
  subtype: "success";
  result: string;
  total_cost_usd: number;
  num_turns: number;
  modelUsage: Record<string, SDKModelUsage>;
}

/** SDK result on error — fields match sdk.d.ts SDKResultError.
 * TASK-1314: the subtype union mirrors the SDK's CLOSED set; the
 * runtime mapping still fails closed on anything unrecognized. */
interface SDKErrorResult {
  type: "result";
  subtype:
    | "error_during_execution"
    | "error_max_turns"
    | "error_max_budget_usd"
    | "error_max_structured_output_retries";
  total_cost_usd: number;
  num_turns: number;
  errors: string[];
}

// TASK-1314: bounds for SDK error detail carried on results and events.
const MAX_RESULT_ERROR_ITEMS = 10;
const MAX_RESULT_ERROR_ITEM_CHARS = 500;
const MAX_RESULT_ERROR_AGGREGATE_CHARS = 4000;
const TRUNCATION_MARKER = "…(truncated)";
const MANAGED_DOCKER_IMAGE_ALLOWLIST_ENV = "QUACK_TRUSTED_MANAGED_DOCKER_IMAGES";

function sanitizedAgentEnvironment(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => key.toUpperCase() !== MANAGED_DOCKER_IMAGE_ALLOWLIST_ENV,
    ),
  );
}

/**
 * Bound the SDK's errors[] per the TASK-1314 contract. HARD caps
 * (round-2 F2: marker space is reserved INSIDE the caps): at most
 * MAX_RESULT_ERROR_ITEMS items, every emitted item ≤
 * MAX_RESULT_ERROR_ITEM_CHARS chars INCLUDING any marker, and the
 * emitted aggregate ≤ MAX_RESULT_ERROR_AGGREGATE_CHARS chars.
 */
function boundResultErrors(errors: string[] | undefined): string[] | undefined {
  if (!errors || errors.length === 0) return undefined;
  const marker = TRUNCATION_MARKER;
  const out: string[] = [];
  let total = 0;
  let truncatedAnywhere = errors.length > MAX_RESULT_ERROR_ITEMS;
  for (const raw of errors.slice(0, MAX_RESULT_ERROR_ITEMS)) {
    let item = raw;
    if (item.length > MAX_RESULT_ERROR_ITEM_CHARS) {
      item = item.slice(0, MAX_RESULT_ERROR_ITEM_CHARS - marker.length) + marker;
      truncatedAnywhere = true;
    }
    if (total + item.length > MAX_RESULT_ERROR_AGGREGATE_CHARS) {
      const remaining = MAX_RESULT_ERROR_AGGREGATE_CHARS - total;
      if (remaining > marker.length) {
        out.push(item.slice(0, remaining - marker.length) + marker);
        total += remaining;
      }
      truncatedAnywhere = true;
      break;
    }
    out.push(item);
    total += item.length;
  }
  if (truncatedAnywhere && out.length > 0 && !out[out.length - 1].endsWith(marker)) {
    // Rewrite the tail to carry the marker WITHIN both caps (round-2b:
    // when even the marker cannot fit the aggregate room at the current
    // tail — e.g. a tiny last item at a nearly-full aggregate — drop
    // tail items until it can).
    while (out.length > 0) {
      const last = out[out.length - 1];
      const othersTotal = out.slice(0, -1).reduce((sum, item) => sum + item.length, 0);
      const room = Math.min(
        MAX_RESULT_ERROR_ITEM_CHARS,
        MAX_RESULT_ERROR_AGGREGATE_CHARS - othersTotal,
      );
      if (room >= marker.length) {
        const budget = room - marker.length;
        out[out.length - 1] = last.slice(0, Math.min(last.length, budget)) + marker;
        break;
      }
      out.pop();
    }
  }
  return out;
}

interface SDKHookInput {
  hook_event_name: string;
  tool_name?: string;
  tool_input?: unknown;
}

interface SDKHookOutput {
  decision?: "approve" | "block";
  reason?: string;
  systemMessage?: string;
  hookSpecificOutput?: {
    hookEventName: string;
    permissionDecision?: "allow" | "deny" | "ask";
    permissionDecisionReason?: string;
    updatedInput?: Record<string, unknown>;
  };
}

type SDKHookCallback = (
  input: SDKHookInput,
  toolUseID: string | undefined,
  options: { signal: AbortSignal },
) => Promise<SDKHookOutput>;

interface SDKHookCallbackMatcher {
  matcher?: string;
  hooks: SDKHookCallback[];
  timeout?: number;
}

type SDKHooks = Partial<Record<"PreToolUse" | "Stop", SDKHookCallbackMatcher[]>>;

type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<SDKMessage, void>;

// ─── Lazy SDK loading ───────────────────────────────────────────────

let _queryFn: QueryFn | undefined;

async function getQueryFn(): Promise<QueryFn> {
  if (_queryFn) return _queryFn;
  const sdk: { query: QueryFn } = await import("@anthropic-ai/claude-agent-sdk");
  _queryFn = sdk.query;
  return _queryFn;
}

/**
 * Override the query function used internally. Primarily for testing.
 * @param fn - The replacement query function, or undefined to reset
 */
export function _setQueryFn(fn: QueryFn | undefined): void {
  _queryFn = fn;
}

// ─── Disallowed tools ───────────────────────────────────────────────

/** Tools that the agent is never allowed to use */
const DISALLOWED_TOOLS = ["WebSearch", "WebFetch", "Task", "AskUserQuestion"];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ─── Agent Worker ───────────────────────────────────────────────────

export interface RunAgentOptions {
  /** Override the model (defaults to adapter.config.agent.model) */
  model?: string;
  /** Override maxTurns (defaults to adapter.config.agent.maxTurns) */
  maxTurns?: number;
  /** Override maxBudgetUsd (defaults to adapter.config.agent.maxBudgetPerTask).
   *  Used by the dispatcher to pass a reduced budget for retry attempts. */
  maxBudgetUsd?: number;
  /** Skip MCP server creation (for testing) */
  skipMcpServers?: boolean;
  /** Resume a previous session by its Claude session ID.
   *  When provided, the SDK loads the full conversation history and
   *  continues from where it left off. Uses forkSession to preserve
   *  the original session for audit. */
  resumeSessionId?: string;
  /** Judge feedback for retry-after-REVISE resume. When set alongside
   *  resumeSessionId, uses this as the resume prompt instead of the
   *  generic "continue implementing" message. The agent already has the
   *  full task context in its session history — this prompt only carries
   *  the judge's specific complaints for surgical fixes. */
  retryFeedback?: string;
}

/**
 * Run the agent worker for a single task.
 *
 * This is the heart of Quack: it creates a Claude Agent SDK session,
 * assembles the system prompt, configures MCP tools and hooks, and
 * runs the agent to completion.
 *
 * @param taskId - The task identifier (e.g., "TASK-008")
 * @param context - The assembled task context from context-assembler
 * @param adapter - The project adapter with config and conventions
 * @param options - Optional overrides for model, maxTurns, etc.
 * @returns Structured AgentResult with outcome, files, verification, cost
 */
export async function runAgent(
  taskId: string,
  context: TaskContext,
  adapter: ProjectAdapter,
  options?: RunAgentOptions,
  events?: IEventWriter,
): Promise<AgentResult> {
  // The implementation provider is adapter-explicit and additive. Existing
  // adapters (including configs constructed by older callers/tests) continue
  // down the Claude Agent SDK path when `runner` is absent.
  if ((adapter.config.agent.runner ?? "claude-sdk") === "codex-cli") {
    return runCodexImplementationAgent(taskId, context, adapter, options, events);
  }

  const model = options?.model ?? adapter.config.agent.model;
  const maxTurns = options?.maxTurns ?? adapter.config.agent.maxTurns;
  const maxBudget = options?.maxBudgetUsd ?? adapter.config.agent.maxBudgetPerTask;

  // Build prompts
  const systemPrompt = buildSystemPrompt(adapter, context.claudeMd);
  const taskPrompt = buildTaskPrompt(taskId, context);
  const parsedTaskForVerification = (() => {
    try {
      return parseTaskFile(context.taskSpec);
    } catch {
      return undefined;
    }
  })();

  // Set up MCP servers
  const mcpServers: Record<string, ToolServerResult> = {};
  if (!options?.skipMcpServers) {
    const [verifyServer, gitServer] = await Promise.all([
      createToolServer(adapter, { task: parsedTaskForVerification }),
      createGitToolServer(adapter),
    ]);
    mcpServers["quack-verify"] = verifyServer;
    mcpServers["quack-git"] = gitServer;
  }

  // Build hooks for the Agent SDK. This must use the SDK's HookEvent-keyed
  // matcher shape; ad-hoc { type, name, fn } descriptors are ignored.
  //
  // Git-write deny floor (TASK-865, hardened TASK-1312): the post-worker
  // output sealer is the canonical writer. The floor evaluation lives in
  // worker/git-floor.ts (segment splitting, option prefixes, wrapper
  // stripping, plumbing verbs); denials that classify as branch-mutation
  // attempts are additionally recorded as safety facts (attempt
  // visibility) instead of vanishing into the SDK transcript.
  const protectedBranchesForFacts = resolveProtectedBranches(adapter.config.git);
  const productionMarkers = adapter.config.deploy?.productionMarkers ?? {};
  // TASK-1313: PRE-FILTER fact carrier for the judge stage (F14) — the
  // SSE emits below keep their noise filters; this collects everything.
  const collectedSafetyFacts: NonNullable<AgentResult["safetyFacts"]> = [];

  // Count consecutive Bash denials so we can inject Stuck-Loop Detection
  // guidance after the worker has clearly fallen into a sandbox-thrash
  // pattern (TASK-908). Reset on the next allowed Bash call.
  let consecutiveBashDenials = 0;
  const STUCK_DENIAL_THRESHOLD = 5;
  const STUCK_DENIAL_HINT =
    "\n\nSTUCK-LOOP DETECTION: 5+ Bash commands have been denied in a row by the sandbox. " +
    "Stop trying variations of the same command. Either:\n" +
    ' - Use the MCP `verify` tool with scope: "blocker" to bail out cleanly so the judge can review your partial work, OR\n' +
    " - Use one of the allowed Bash patterns (`npx jest *`, `npx tsc *`, `npm install *`, `npm ci *`, `npm --prefix * run *`, `npm --prefix * test *`, `git status`, `git diff`, `git log`, `git rev-parse`, `git merge-base`, `git show`, `git fetch`, `ls *`, `cat *`, `mkdir *`).\n" +
    "Do NOT keep trying variants like `npm test`, `npm run lint`, `git stash` — those will keep getting blocked.";

  const bashGuardHook: SDKHookCallback = (input) => {
    if (input.hook_event_name !== "PreToolUse" || input.tool_name !== "Bash") {
      return Promise.resolve({});
    }
    const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
    const command = typeof toolInput.command === "string" ? toolInput.command : "";

    // First: deny git write operations regardless of adapter sandbox config.
    const floor = checkGitFloor(command);
    if (floor.denied) {
      consecutiveBashDenials += 1;
      // Attempt visibility (TASK-1312): denied branch-mutation attempts
      // become recorded safety facts. Plain write-verb denials (git add/
      // commit) stay event-silent — they are sealer-redundancy noise.
      const allMutationFacts = classifyGitMutation(command, protectedBranchesForFacts);
      collectedSafetyFacts.push(...allMutationFacts);
      const mutationFacts = allMutationFacts.filter((fact) => fact.mutationClass !== "write");
      if (mutationFacts.length > 0) {
        events?.emit("safety_fact", {
          origin: "worker_bash_denial",
          facts: mutationFacts,
        });
      }
      const stuckHint = consecutiveBashDenials >= STUCK_DENIAL_THRESHOLD ? STUCK_DENIAL_HINT : "";
      return Promise.resolve({
        systemMessage: `Bash command blocked by Quack: ${GIT_FLOOR_REASON}${stuckHint}`,
        hookSpecificOutput: {
          hookEventName: "PreToolUse",
          permissionDecision: "deny",
          permissionDecisionReason: GIT_FLOOR_REASON + stuckHint,
        },
      });
    }

    const result = checkBashCommand(command, adapter.config.sandbox);
    if (result.allowed) {
      consecutiveBashDenials = 0;
      // Deploy-shaped observation (TASK-1312 Producer B): resolved-
      // destination facts are recorded; shape-only stays silent (noise).
      const allDeployFacts = classifyDeployCommand(command, productionMarkers);
      collectedSafetyFacts.push(...allDeployFacts);
      const deployFacts = allDeployFacts.filter((fact) => fact.tier === "resolved_destination");
      if (deployFacts.length > 0) {
        events?.emit("safety_fact", {
          origin: "worker_bash_observation",
          facts: deployFacts,
        });
      }
      return Promise.resolve({});
    }

    consecutiveBashDenials += 1;
    const stuckHint = consecutiveBashDenials >= STUCK_DENIAL_THRESHOLD ? STUCK_DENIAL_HINT : "";
    if (consecutiveBashDenials === STUCK_DENIAL_THRESHOLD) {
      events?.emit("worker_sandbox_thrash", {
        consecutiveDenials: consecutiveBashDenials,
        latestCommand: command.slice(0, 200),
      });
    }
    const reason = result.reason ?? "Command blocked by bash guard";
    return Promise.resolve({
      systemMessage: `Bash command blocked by Quack: ${reason}${stuckHint}`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason + stuckHint,
      },
    });
  };

  const writeGuardHook: SDKHookCallback = (input) => {
    if (
      input.hook_event_name !== "PreToolUse" ||
      (input.tool_name !== "Write" && input.tool_name !== "Edit")
    ) {
      return Promise.resolve({});
    }
    const toolInput = isRecord(input.tool_input) ? input.tool_input : {};
    const filePath = typeof toolInput.file_path === "string" ? toolInput.file_path : "";
    if (!filePath) return Promise.resolve({});

    // TASK-1313 S6: the agent must not edit its own success criteria.
    // Round-2 F6: canonical-absolute comparison — `..` segments, mixed
    // separators, and Windows case differences cannot dodge the guard.
    if (context.taskSpecPath) {
      const canonical = (value: string): string =>
        pathResolve(adapter.projectRoot, value).replace(/\\/g, "/").toLowerCase();
      if (canonical(filePath) === canonical(context.taskSpecPath)) {
        const specReason =
          "Editing the active task's own spec file is not permitted: the spec is the contract this run is judged against.";
        return Promise.resolve({
          systemMessage: `File write blocked by Quack: ${specReason}`,
          hookSpecificOutput: {
            hookEventName: "PreToolUse",
            permissionDecision: "deny",
            permissionDecisionReason: specReason,
          },
        });
      }
    }

    const result = checkWritePath(filePath, adapter.config.sandbox, adapter.projectRoot);
    if (result.allowed) return Promise.resolve({});

    const reason = result.reason ?? "Write blocked by sandbox config";
    return Promise.resolve({
      systemMessage: `File write blocked by Quack: ${reason}`,
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: reason,
      },
    });
  };

  const stopHook: SDKHookCallback = async (input) => {
    if (input.hook_event_name !== "Stop") return {};
    events?.emit("verification_start", {
      commandCount: adapter.config.verification.commands.length,
    });
    const result = await verifyBeforeStop(adapter, {
      task: parsedTaskForVerification,
      // Round-2 F8: machinery-integrity mismatches surface as
      // verification_integrity safety facts on the session stream.
      onIntegrityMismatch: (mismatches) => {
        events?.emit("safety_fact", {
          origin: "verification_integrity",
          facts: [],
          integrityMismatches: mismatches as Array<{
            path: string;
            reason: "hash_mismatch" | "worktree_only" | "authoritative_only";
          }>,
        });
      },
    });
    const verificationCommands = result.verification.commands.map((command) => ({
      name: command.name,
      passed: command.passed,
      required: command.required,
      status: command.status,
    }));
    events?.emit("verification_result", {
      allPassed: result.verification.allPassed,
      commands: verificationCommands,
    });
    if (!result.canStop) {
      return {
        decision: "block",
        reason: result.feedback,
        systemMessage: result.feedback,
      };
    }
    lastVerification = result.verification;
    return {};
  };

  const hooks: SDKHooks = {
    PreToolUse: [
      { matcher: "Bash", hooks: [bashGuardHook] },
      { matcher: "Write|Edit", hooks: [writeGuardHook] },
    ],
    Stop: [{ hooks: [stopHook] }],
  };

  // Track state
  const messages: AgentMessage[] = [];
  const filesModified = new Set<string>();
  let turnNumber = 0;
  let totalCostUsd = 0;
  // TASK-1314: the terminal result message drives the outcome mapping.
  let lastResult: SDKSuccessResult | SDKErrorResult | undefined;
  let lastVerification: VerificationResult | null = null;
  let claudeSessionId: string | undefined;

  // Run the agent
  try {
    const queryFn = await getQueryFn();

    // Note: The Agent SDK automatically manages prompt caching for the
    // systemPrompt and tool definitions. No explicit cache_control configuration
    // is needed — the SDK handles cache breakpoints internally. Content ordering
    // in buildSystemPrompt and buildTaskPrompt is structured for optimal cache
    // hit rates (most-stable content first).
    //
    // Observation masking (reducing context by trimming old tool results) is not
    // currently supported by the Agent SDK. The SDK has PreCompact hooks and
    // compact_boundary messages but no direct conversation history manipulation.
    // The claude-progress.txt pattern in the system prompt serves as a workaround,
    // allowing the agent to recover state after context compaction.
    // When resuming, use a minimal prompt that tells the agent to continue.
    // The full conversation history is loaded by the SDK from the session.
    const isResume = !!options?.resumeSessionId;
    const prompt = isResume
      ? (options?.retryFeedback ??
        "Continue implementing the task from where you left off. Check git status and your recent changes to understand current state. Read claude-progress.txt if it exists.")
      : taskPrompt;

    const queryResult = queryFn({
      prompt,
      options: {
        model,
        maxTurns,
        // System prompt is only needed for new sessions — resumed sessions
        // already have it in their conversation history.
        ...(isResume ? {} : { systemPrompt }),
        disallowedTools: DISALLOWED_TOOLS,
        ...(maxBudget > 0 ? { maxBudgetUsd: maxBudget } : {}),
        ...getSdkPermissionOptions(),
        cwd: adapter.projectRoot,
        // The operator-owned managed-Docker image allowlist is control-plane
        // policy, not workload input. Direct CLI SDK sessions otherwise inherit
        // the host environment and could disclose or mutate that policy value.
        env: getClaudeSdkEnvironment(adapter.config.agent.apiKeys, sanitizedAgentEnvironment()),
        ...(Object.keys(mcpServers).length > 0 ? { mcpServers } : {}),
        hooks,
        // Resume support: load previous session and fork to preserve original
        ...(isResume && options?.resumeSessionId
          ? { resume: options.resumeSessionId, forkSession: true }
          : {}),
      },
    });

    for await (const message of queryResult) {
      // Capture Claude session ID from first message that carries it
      if (!claudeSessionId && typeof (message as Record<string, unknown>).session_id === "string") {
        claudeSessionId = (message as Record<string, unknown>).session_id as string;
      }

      // ── Assistant messages ──────────────────────────────────────
      // SDKAssistantMessage has { message: BetaMessage } where
      // BetaMessage.content is an array of ContentBlocks, NOT a string.
      if (message.type === "assistant") {
        // Only increment on the first assistant message (turn 1).
        // Subsequent turns are counted when we receive a user (tool result)
        // message, which matches the SDK's turn definition:
        // "A turn consists of a user message and assistant response."
        if (turnNumber === 0) turnNumber = 1;
        const betaMsg = (message as { message?: { content?: ContentBlock[] | string } }).message;
        const blocks = betaMsg?.content;

        // Extract text and tool uses from content blocks
        const textParts: string[] = [];
        const toolUses: { name: string; input: Record<string, unknown> }[] = [];

        if (Array.isArray(blocks)) {
          for (const block of blocks) {
            if (block.type === "text" && block.text) {
              textParts.push(block.text);
            } else if (block.type === "tool_use" && block.name) {
              toolUses.push({ name: block.name, input: block.input ?? {} });
            }
          }
        } else if (typeof blocks === "string") {
          textParts.push(blocks);
        }

        const content = textParts.join("\n");
        messages.push({
          role: "assistant",
          content,
          timestamp: new Date().toISOString(),
          turnNumber,
        });
        events?.emit("agent_turn", {
          turnNumber,
          role: "assistant",
          contentPreview: content.slice(0, 200),
        });

        // Emit tool use events and track file modifications
        for (const tool of toolUses) {
          const filePath =
            typeof tool.input.file_path === "string"
              ? tool.input.file_path
              : typeof tool.input.path === "string"
                ? tool.input.path
                : undefined;

          const bashCommand =
            tool.name === "Bash" && typeof tool.input.command === "string"
              ? tool.input.command.slice(0, 200)
              : undefined;

          events?.emit("agent_tool_use", {
            turnNumber,
            toolName: tool.name,
            ...(filePath ? { filePath } : {}),
            ...(bashCommand ? { bashCommand } : {}),
          });

          // Track files touched by write operations
          if ((tool.name === "Write" || tool.name === "Edit") && filePath) {
            filesModified.add(filePath);
          }
        }
      }

      // ── User messages (tool results) ───────────────────────────
      // Each user message (tool result) marks the start of a new SDK turn.
      // This aligns our count with the SDK's maxTurns enforcement.
      if (message.type === "user") {
        turnNumber++;
        messages.push({
          role: "user",
          content: "[tool results]",
          timestamp: new Date().toISOString(),
          turnNumber,
        });
      }

      // ── Result messages (success or error) ─────────────────────
      // Both SDKResultSuccess and SDKResultError carry total_cost_usd and session_id
      if (message.type === "result") {
        const resultMsg = message as unknown as SDKSuccessResult | SDKErrorResult;
        lastResult = resultMsg;
        if (resultMsg.total_cost_usd !== undefined) {
          totalCostUsd = resultMsg.total_cost_usd;
        }
        if (resultMsg.num_turns !== undefined) {
          turnNumber = resultMsg.num_turns;
        }
        // Capture session_id from result (most reliable source)
        const resultSessionId = (message as Record<string, unknown>).session_id;
        if (typeof resultSessionId === "string") {
          claudeSessionId = resultSessionId;
        }

        // Extract cache metrics from modelUsage (SDKResultSuccess only)
        if (resultMsg.subtype === "success") {
          const successResult = resultMsg;
          if (successResult.modelUsage) {
            let totalCacheRead = 0;
            let totalCacheCreation = 0;
            let totalInput = 0;

            for (const usage of Object.values(successResult.modelUsage)) {
              totalCacheRead += usage.cacheReadInputTokens ?? 0;
              totalCacheCreation += usage.cacheCreationInputTokens ?? 0;
              totalInput += usage.inputTokens ?? 0;
            }

            const totalAllInput =
              totalCacheRead +
              totalCacheCreation +
              (totalInput - totalCacheRead - totalCacheCreation);
            const uncached = Math.max(0, totalInput - totalCacheRead - totalCacheCreation);
            const hitRate =
              totalAllInput > 0 ? Math.round((totalCacheRead / totalAllInput) * 100) : 0;

            events?.emit("cache_metrics", {
              cacheReadInputTokens: totalCacheRead,
              cacheCreationInputTokens: totalCacheCreation,
              uncachedInputTokens: uncached,
              cacheHitRate: hitRate,
            });
          }
        }

        // The result message is the final meaningful message from the SDK.
        // Break immediately — the async generator may never signal done if
        // MCP connections or SDK transport remain open, which causes the
        // process to hang indefinitely.
        break;
      }
    }

    // Allow the SDK's fire-and-forget async operations (handleControlRequest,
    // MCP cleanup) to settle before the dispatcher proceeds to the judge.
    // The SDK calls handleControlRequest without await; these dangling promises
    // need at least one event loop tick to resolve/reject. Without this, the
    // dispatcher can start the judge session while the agent's SDK transport
    // is still winding down, triggering "ProcessTransport is not ready" errors.
    await new Promise((resolve) => setTimeout(resolve, 500));

    const modifiedFiles = Array.from(filesModified);

    // TASK-1314: derive the outcome from the terminal result message.
    // The SDK's error-subtype union is closed; anything unrecognized —
    // or a stream that ended with NO result at all — fails CLOSED to
    // `failure`, never success. SDK errors[] is bounded and surfaced on
    // both the result and the agent_complete event (the standing repo
    // gotcha: always log SDKResultError.errors[]).
    let outcome: AgentResult["outcome"] = "success";
    let errorText: string | undefined;
    let boundedErrors: string[] | undefined;
    if (!lastResult) {
      outcome = "failure";
      errorText = "SDK stream ended without a result message";
    } else if (lastResult.subtype !== "success") {
      const subtype: string = lastResult.subtype;
      switch (subtype) {
        case "error_max_turns":
          outcome = "max_turns";
          break;
        case "error_max_budget_usd":
          outcome = "budget_exceeded";
          break;
        case "error_during_execution":
        case "error_max_structured_output_retries":
          outcome = "failure";
          break;
        default:
          // Future SDK subtype: fail closed.
          outcome = "failure";
          break;
      }
      boundedErrors = boundResultErrors(lastResult.errors);
      errorText = boundedErrors ? `${subtype}: ${boundedErrors.join(" | ")}` : subtype;
    }

    events?.emit("agent_complete", {
      outcome,
      turnsUsed: turnNumber,
      totalCostUsd,
      filesModified: modifiedFiles,
      claudeSessionId,
      ...(boundedErrors ? { errors: boundedErrors } : {}),
    });

    return {
      taskId,
      outcome,
      filesModified: modifiedFiles,
      ...(collectedSafetyFacts.length > 0 ? { safetyFacts: [...collectedSafetyFacts] } : {}),
      filesCreated: [],
      verification: lastVerification,
      turnsUsed: turnNumber,
      totalCostUsd,
      messages,
      ...(errorText ? { error: errorText } : {}),
      claudeSessionId,
    };
  } catch (err: unknown) {
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Determine outcome based on error type
    let outcome: AgentResult["outcome"] = "failure";
    if (errorMessage.includes("timeout") || errorMessage.includes("timed out")) {
      outcome = "timeout";
    } else if (
      errorMessage.includes("budget") ||
      errorMessage.includes("cost") ||
      errorMessage.includes("rate limit")
    ) {
      outcome = "budget_exceeded";
    }

    const modifiedFiles = Array.from(filesModified);

    events?.emit("agent_complete", {
      outcome,
      turnsUsed: turnNumber,
      totalCostUsd,
      filesModified: modifiedFiles,
      claudeSessionId,
    });

    return {
      taskId,
      outcome,
      filesModified: modifiedFiles,
      ...(collectedSafetyFacts.length > 0 ? { safetyFacts: [...collectedSafetyFacts] } : {}),
      filesCreated: [],
      verification: lastVerification,
      turnsUsed: turnNumber,
      totalCostUsd,
      messages,
      error: errorMessage,
      claudeSessionId,
    };
  }
}
