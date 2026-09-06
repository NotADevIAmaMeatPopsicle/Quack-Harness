// ─── MCP Tool Server ────────────────────────────────────────────────
// Creates in-process MCP servers that register the verify and git
// tools, returning config objects suitable for passing to the SDK's
// `mcpServers` option.
//
// Because the Claude Agent SDK is ESM-only and this project uses
// CommonJS (Node16 module resolution), we must use dynamic import()
// to load the SDK at runtime.

import { z } from "zod";

import type { ProjectAdapter } from "../../core/adapter-loader.js";
import type { ParsedTask } from "../../core/types.js";
import { createVerifyToolDefinition } from "./verify.js";
import { createGitToolDefinitions } from "./git.js";
import {
  resolveAuthoritativeRoot,
  restoreMachineryFile,
} from "../../judgment/producers/machinery-integrity.js";

/**
 * The shape returned by createSdkMcpServer.
 * Declared here to avoid a type-only import that requires resolution-mode.
 */
export interface ToolServerResult {
  type: "sdk";
  name: string;
  instance: unknown;
}

/**
 * Create an MCP server with the verify tool registered, configured
 * for the given project adapter.
 *
 * Returns a server config object that can be passed directly into
 * the SDK's `mcpServers` option under a key name like `"quack-verify"`.
 *
 * This function is async because the SDK must be dynamically imported
 * (it is ESM-only and this project uses CommonJS).
 */
export async function createToolServer(
  adapter: ProjectAdapter,
  options?: { task?: ParsedTask },
): Promise<ToolServerResult> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const { tool, createSdkMcpServer } = sdk;

  const verifyDef = createVerifyToolDefinition(adapter, options);

  const verifyTool = tool(
    "verify",
    verifyDef.description,
    {
      scope: z.string().describe(verifyDef.scopeDescription),
    },
    async (args: { scope: string }) => {
      const text = await verifyDef.handler(args.scope);
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );

  // TASK-1313 S6/F9: the machinery-integrity barrier can fail
  // verification closed, and the git floor denies checkout/reset — this
  // tool is the agent's ONLY recovery path: it copies the AUTHORITATIVE
  // version of a named Tier-S file over the worktree copy (that
  // direction only; Tier-S paths only; structurally a no-op outside
  // worktrees because authoritative == projectRoot there).
  const authoritativeRoot = resolveAuthoritativeRoot(adapter.projectRoot);
  const restoreTool = tool(
    "restore_machinery",
    "Restore the authoritative version of a verification-machinery file " +
      "(.quack/adapter.json, verify.js, judge-criteria.md, conventions.md, " +
      "convention-checks/*, templates/*) over the worktree copy. Use this " +
      "when the machinery-integrity check blocks verification.",
    {
      path: z.string().describe("Repo-relative Tier-S machinery path to restore"),
    },
    async (args: { path: string }) => {
      const result = await restoreMachineryFile(adapter.projectRoot, authoritativeRoot, args.path);
      const text = result.restored
        ? `Restored ${args.path} from the authoritative project copy.`
        : `Could not restore ${args.path}: ${result.reason ?? "unknown error"}`;
      return {
        content: [{ type: "text" as const, text }],
      };
    },
  );

  const server = createSdkMcpServer({
    name: "quack-verify",
    version: "1.0.0",
    tools: [verifyTool, restoreTool],
  });

  return server as ToolServerResult;
}

/**
 * Create an MCP server with READ-ONLY git tools registered, configured
 * for the given project adapter.
 *
 * Registers: git_status, git_diff, git_log.
 *
 * Write operations (add/commit/push/etc.) are intentionally NOT exposed.
 * The post-worker output sealer (`src/dispatcher/output-snapshot.ts`) is
 * the canonical writer — it stages mergeable paths and commits with the
 * adapter's commitFormat after the worker exits, with deterministic
 * exclusion of transient artifacts. Routing all writes through the sealer
 * eliminates per-task permission-prompt friction inside the worker (the
 * SDK's `bypassPermissions` mode does not cover MCP tools, so writes via
 * MCP would prompt).
 */
export async function createGitToolServer(adapter: ProjectAdapter): Promise<ToolServerResult> {
  const sdk = await import("@anthropic-ai/claude-agent-sdk");
  const { tool, createSdkMcpServer } = sdk;

  const gitDefs = createGitToolDefinitions(adapter.projectRoot);

  // Build SDK tool objects for each (read-only) git tool definition.
  const gitStatusTool = tool("git_status", gitDefs[0].description, {}, async () => {
    const text = await gitDefs[0].handler({});
    return { content: [{ type: "text" as const, text }] };
  });

  const gitDiffTool = tool(
    "git_diff",
    gitDefs[1].description,
    {
      staged: z.boolean().optional().describe("If true, show staged changes (--cached)"),
    },
    async (args: { staged?: boolean }) => {
      const text = await gitDefs[1].handler({ staged: args.staged ?? false });
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const gitLogTool = tool(
    "git_log",
    gitDefs[2].description,
    {
      count: z.number().optional().describe("Number of commits to show (default 10, max 50)"),
    },
    async (args: { count?: number }) => {
      const text = await gitDefs[2].handler({ count: args.count ?? 10 });
      return { content: [{ type: "text" as const, text }] };
    },
  );

  const server = createSdkMcpServer({
    name: "quack-git",
    version: "2.0.0",
    tools: [gitStatusTool, gitDiffTool, gitLogTool],
  });

  return server as ToolServerResult;
}
