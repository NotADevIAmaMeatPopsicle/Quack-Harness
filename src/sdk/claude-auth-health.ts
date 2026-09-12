import type { KeyManager } from "../dispatcher/key-manager.js";
import {
  buildClaudeChildEnvironment,
  claudeAuthFingerprint,
  inspectClaudeAuth,
  sanitizeClaudeDiagnostic,
  type ClaudeAuthPresence,
} from "./claude-auth.js";
import { getSdkPermissionOptions } from "./permission-mode.js";

interface ProbeMessage {
  type: string;
  subtype?: string;
  errors?: string[];
}
type Query = (input: {
  prompt: string;
  options: Record<string, unknown>;
}) => AsyncGenerator<ProbeMessage, void> & { close?: () => void };
export interface ClaudeAuthProbeResult {
  status: "unprobed" | "running" | "passed" | "failed" | "timed_out";
  checkedAt?: string;
  expiresAt?: string;
  error?: string;
  /** A successful probe establishes one selected credential, not every pool key. */
  coverage: "selected-credential";
}
export interface ClaudeAuthHealth {
  configuration: ClaudeAuthPresence;
  probe: ClaudeAuthProbeResult;
  ready: boolean | null;
}

/** Explicit probes only: GET health reads cached evidence and never starts SDK work. */
export class ClaudeAuthHealthProbe {
  private cached?: { identity: string; result: ClaudeAuthProbeResult };
  private pending?: { identity: string; promise: Promise<ClaudeAuthProbeResult> };
  constructor(
    private readonly runtime: {
      query?: Query;
      loadQuery?: () => Promise<Query>;
      now?: () => number;
      timeoutMs?: number;
      ttlMs?: number;
      credentialNames?: readonly string[];
    } = {},
  ) {}

  private identity(environment: NodeJS.ProcessEnv, projectPolicy: string): string {
    return `${projectPolicy}:${claudeAuthFingerprint(environment, this.runtime.credentialNames)}`;
  }

  snapshot(
    environment: NodeJS.ProcessEnv,
    explicitPool = false,
    projectPolicy = "",
  ): ClaudeAuthHealth {
    const configuration = inspectClaudeAuth(environment, explicitPool);
    if (explicitPool)
      configuration.apiKeyPresent = (this.runtime.credentialNames ?? []).some((name) =>
        Boolean(environment[name]?.trim()),
      );
    if (explicitPool && !configuration.apiKeyPresent)
      configuration.error =
        "The configured Claude API-key pool has no credential present in the environment.";
    const identity = this.identity(environment, projectPolicy);
    const now = (this.runtime.now ?? Date.now)();
    let probe: ClaudeAuthProbeResult = { status: "unprobed", coverage: "selected-credential" };
    if (this.pending?.identity === identity) probe = { ...probe, status: "running" };
    else if (this.cached?.identity === identity && Date.parse(this.cached.result.expiresAt!) > now)
      probe = this.cached.result;
    return {
      configuration,
      probe,
      ready:
        configuration.error ||
        configuration.mode === "conflict" ||
        probe.status === "failed" ||
        probe.status === "timed_out"
          ? false
          : probe.status === "passed"
            ? true
            : null,
    };
  }

  async probe(
    environment: NodeJS.ProcessEnv,
    resolveEnvironment: () => NodeJS.ProcessEnv = () => buildClaudeChildEnvironment(environment),
    projectPolicy = "",
  ): Promise<ClaudeAuthProbeResult> {
    const identity = this.identity(environment, projectPolicy);
    const current = this.snapshot(environment, false, projectPolicy).probe;
    if (this.pending?.identity === identity) return this.pending.promise;
    if (this.pending) {
      await this.pending.promise;
      return this.probe(environment, resolveEnvironment, projectPolicy);
    }
    if (current.status !== "unprobed") return current;
    const promise = this.performProbe(resolveEnvironment);
    this.pending = { identity, promise };
    try {
      const result = await promise;
      this.cached = { identity, result };
      return result;
    } finally {
      if (this.pending?.promise === promise) this.pending = undefined;
    }
  }

  private async performProbe(
    resolveEnvironment: () => NodeJS.ProcessEnv,
  ): Promise<ClaudeAuthProbeResult> {
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let queryResult: ReturnType<Query> | undefined;
    let cleanupError: string | undefined;
    let environment: NodeJS.ProcessEnv = {};
    const now = this.runtime.now ?? Date.now;
    const ttlMs = Math.min(300_000, Math.max(1_000, this.runtime.ttlMs ?? 60_000));
    let result: ClaudeAuthProbeResult;
    try {
      const execute = async (): Promise<ClaudeAuthProbeResult> => {
        environment = resolveEnvironment();
        const query =
          this.runtime.query ??
          (this.runtime.loadQuery
            ? await this.runtime.loadQuery()
            : ((await import("@anthropic-ai/claude-agent-sdk")).query as unknown as Query));
        // A slow import may settle after the deadline. Never start a paid child then.
        if (controller.signal.aborted)
          return {
            status: "timed_out",
            coverage: "selected-credential",
            error: "Claude authentication probe timed out",
          };
        queryResult = query({
          prompt: "Reply with OK.",
          options: {
            model: "claude-haiku-4-5-20251001",
            maxTurns: 3,
            maxBudgetUsd: 0.05,
            tools: [],
            allowedTools: [],
            disallowedTools: [
              "Read",
              "Glob",
              "Grep",
              "Edit",
              "Write",
              "Bash",
              "WebSearch",
              "WebFetch",
            ],
            ...getSdkPermissionOptions(),
            env: environment,
            abortController: controller,
          },
        });
        for await (const message of queryResult) {
          if (message.type !== "result") continue;
          if (message.subtype === "success")
            return { status: "passed", coverage: "selected-credential" };
          return {
            status: "failed",
            coverage: "selected-credential",
            error: sanitizeClaudeDiagnostic(
              message.errors?.join("; ") ?? "Claude returned an unsuccessful probe result",
              environment,
            ).slice(0, 2000),
          };
        }
        return {
          status: "failed",
          coverage: "selected-credential",
          error: "Claude probe ended without a result",
        };
      };
      const deadline = new Promise<ClaudeAuthProbeResult>((resolve) => {
        timer = setTimeout(
          () => {
            controller.abort();
            resolve({
              status: "timed_out",
              coverage: "selected-credential",
              error: "Claude authentication probe timed out",
            });
          },
          Math.min(30_000, Math.max(100, this.runtime.timeoutMs ?? 10_000)),
        );
      });
      result = await Promise.race([execute(), deadline]);
    } catch (error) {
      result = {
        status: "failed",
        coverage: "selected-credential",
        error: sanitizeClaudeDiagnostic(
          error instanceof Error ? error.message : String(error),
          environment,
        ).slice(0, 2000),
      };
    } finally {
      if (timer) clearTimeout(timer);
      controller.abort();
      try {
        queryResult?.close?.();
      } catch (error) {
        cleanupError = sanitizeClaudeDiagnostic(
          error instanceof Error ? error.message : String(error),
          environment,
        ).slice(0, 2000);
      }
    }
    if (cleanupError && result.status === "passed") {
      result = {
        status: "failed",
        coverage: "selected-credential",
        error: `Claude probe cleanup failed: ${cleanupError}`,
      };
    }
    const completed = now();
    return {
      ...result,
      checkedAt: new Date(completed).toISOString(),
      expiresAt: new Date(completed + ttlMs).toISOString(),
    };
  }
}

interface ProjectClaudeAuthProbe {
  manager: KeyManager | null | undefined;
  policy: string;
  probe: ClaudeAuthHealthProbe;
}

/** Cached evidence belongs to one trusted project registration and ordered pool policy. */
export class ProjectClaudeAuthProbeCache {
  private readonly projects = new Map<string, ProjectClaudeAuthProbe>();

  constructor(
    private readonly runtime: ConstructorParameters<typeof ClaudeAuthHealthProbe>[0] = {},
  ) {}

  forProject(
    projectId: string,
    projectRoot: string | undefined,
    manager: KeyManager | null | undefined,
  ): ProjectClaudeAuthProbe {
    const credentialNames = manager?.getEnvironmentNames() ?? [];
    const policy = JSON.stringify([
      projectId,
      projectRoot,
      manager?.hasExplicitPool() ?? false,
      credentialNames,
    ]);
    const previous = this.projects.get(projectId);
    if (previous && previous.manager === manager && previous.policy === policy) return previous;
    const current = {
      manager,
      policy,
      probe: new ClaudeAuthHealthProbe({ ...this.runtime, credentialNames }),
    };
    this.projects.set(projectId, current);
    return current;
  }

  delete(projectId: string): void {
    this.projects.delete(projectId);
  }
}
