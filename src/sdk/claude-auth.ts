import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { stripVTControlCharacters } from "node:util";
import { KeyManager } from "../dispatcher/key-manager.js";
import type { AdapterAgentConfig } from "../core/types.js";

export type ClaudeApiKeys = NonNullable<AdapterAgentConfig["apiKeys"]>;
export type ClaudeAuthMode = "api-key" | "oauth" | "cli-managed" | "conflict";
export interface ClaudeAuthPresence {
  mode: ClaudeAuthMode;
  apiKeyPresent: boolean;
  oauthTokenPresent: boolean;
  explicitPool: boolean;
  error?: string;
}

export class ClaudeAuthConfigurationError extends Error {
  readonly code = "CLAUDE_AUTH_CONFLICT";
  constructor(message: string) {
    super(message);
    this.name = "ClaudeAuthConfigurationError";
  }
}

interface AuthScope {
  keyManager?: KeyManager;
  apiKeys?: ClaudeApiKeys;
}
const scopes = new AsyncLocalStorage<AuthScope>();
const pools = new WeakMap<ClaudeApiKeys, KeyManager>();

/** Scope only an already resolved project, including non-HTTP background work. */
export function withClaudeAuthScope<T>(keyManager: KeyManager | undefined, operation: () => T): T {
  return scopes.run({ keyManager }, operation);
}

function configuredManager(apiKeys: ClaudeApiKeys): KeyManager {
  let manager = pools.get(apiKeys);
  if (!manager) {
    manager = new KeyManager(apiKeys);
    pools.set(apiKeys, manager);
  }
  return manager;
}

export function withClaudeApiKeysScope<T>(
  apiKeys: ClaudeApiKeys | undefined,
  operation: () => T,
): T {
  return scopes.run({ apiKeys }, operation);
}

export function isClaudeCredentialEnvironmentName(name: string): boolean {
  return /^(?:ANTHROPIC_API_KEY(?:_\d+)?|CLAUDE_CODE_OAUTH_TOKEN)$/i.test(name);
}

function valueOf(environment: NodeJS.ProcessEnv, name: string): string | undefined {
  const value = Object.entries(environment).find(([key]) => key.toUpperCase() === name)?.[1];
  return value?.trim() ? value : undefined;
}

export function inspectClaudeAuth(
  environment: NodeJS.ProcessEnv = process.env,
  explicitPool = false,
): ClaudeAuthPresence {
  const apiKeyPresent = Object.entries(environment).some(
    ([key, value]) => /^ANTHROPIC_API_KEY(?:_\d+)?$/i.test(key) && Boolean(value?.trim()),
  );
  const oauthTokenPresent = Boolean(valueOf(environment, "CLAUDE_CODE_OAUTH_TOKEN"));
  const conflict = apiKeyPresent && oauthTokenPresent && !explicitPool;
  const missingPrimary =
    apiKeyPresent &&
    !oauthTokenPresent &&
    !explicitPool &&
    !valueOf(environment, "ANTHROPIC_API_KEY");
  return {
    mode:
      conflict || missingPrimary
        ? "conflict"
        : explicitPool || valueOf(environment, "ANTHROPIC_API_KEY")
          ? "api-key"
          : oauthTokenPresent
            ? "oauth"
            : "cli-managed",
    apiKeyPresent,
    oauthTokenPresent,
    explicitPool,
    ...(conflict
      ? {
          error:
            "Both Anthropic API keys and a Claude OAuth token are configured. Remove the unintended credential family or configure agent.apiKeys.pool explicitly.",
        }
      : {}),
    ...(missingPrimary
      ? {
          error:
            "Numbered Anthropic API credentials require an explicit agent.apiKeys.pool or a primary ANTHROPIC_API_KEY.",
        }
      : {}),
  };
}

export function selectClaudeApiKey(keyManager: KeyManager): {
  apiKey: string;
  envVar: string;
  keyId: string;
  envVars: string[];
  explicitPool: boolean;
} {
  const selected = keyManager.getNextKey();
  if (!selected)
    throw new ClaudeAuthConfigurationError(
      "The configured Claude API-key pool has no available key. Check its named environment references and cooldowns.",
    );
  const apiKey = keyManager.getKeyValue(selected.id);
  if (!apiKey?.trim())
    throw new ClaudeAuthConfigurationError(
      "The selected Claude API credential is unavailable. Refusing to fall back to another authentication method.",
    );
  return {
    apiKey,
    envVar: selected.envVar,
    keyId: selected.id,
    envVars: keyManager.getEnvironmentNames(),
    explicitPool: keyManager.hasExplicitPool(),
  };
}

/** Never mutate process.env. Undefined values deliberately override SDK env inheritance. */
export function buildClaudeChildEnvironment(
  environment: NodeJS.ProcessEnv = process.env,
  selected?: {
    apiKey: string;
    envVar?: string;
    keyId?: string;
    envVars?: readonly string[];
    explicitPool: boolean;
  },
  preserveSelectedReference = false,
): NodeJS.ProcessEnv {
  const presence = inspectClaudeAuth(environment, selected?.explicitPool === true);
  if (presence.error) throw new ClaudeAuthConfigurationError(presence.error);
  const result = { ...environment };
  for (const name of Object.keys(result)) {
    if (isClaudeCredentialEnvironmentName(name) || /^(?:CLAUDECODE|CLAUDE_CODE)$/i.test(name)) {
      result[name] = undefined;
    }
  }
  result.ANTHROPIC_API_KEY = undefined;
  result.CLAUDE_CODE_OAUTH_TOKEN = undefined;
  result.CLAUDECODE = undefined;
  result.CLAUDE_CODE = undefined;
  for (const name of selected?.envVars ?? []) result[name] = undefined;
  if (selected) {
    if (!selected.apiKey.trim())
      throw new ClaudeAuthConfigurationError("The selected Claude API credential is empty.");
    result.ANTHROPIC_API_KEY = selected.apiKey;
    if (preserveSelectedReference && selected.envVar) result[selected.envVar] = selected.apiKey;
  } else if (presence.mode === "api-key") {
    result.ANTHROPIC_API_KEY = valueOf(environment, "ANTHROPIC_API_KEY");
  } else if (presence.mode === "oauth") {
    result.CLAUDE_CODE_OAUTH_TOKEN = valueOf(environment, "CLAUDE_CODE_OAUTH_TOKEN");
  }
  return result;
}

export function getClaudeSdkEnvironment(
  apiKeys?: ClaudeApiKeys,
  environment: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const scope = scopes.getStore();
  const configured = apiKeys ?? scope?.apiKeys;
  const explicitPool = Array.isArray(configured?.pool) && configured.pool.length > 0;
  const manager = explicitPool ? configuredManager(configured) : scope?.keyManager;
  return buildClaudeChildEnvironment(
    environment,
    manager ? selectClaudeApiKey(manager) : undefined,
  );
}

/** Fingerprint is private cache identity, never returned by health or written to logs. */
export function claudeAuthFingerprint(
  environment: NodeJS.ProcessEnv,
  credentialNames: readonly string[] = [],
): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        Object.entries(environment)
          .filter(
            ([name]) =>
              isClaudeCredentialEnvironmentName(name) ||
              credentialNames.includes(name) ||
              ["HOME", "USERPROFILE", "CLAUDE_CONFIG_DIR"].includes(name),
          )
          .sort(([left], [right]) => left.localeCompare(right)),
      ),
    )
    .digest("hex");
}

export function sanitizeClaudeDiagnostic(
  value: string,
  environment: NodeJS.ProcessEnv = process.env,
): string {
  let text = value;
  const secrets = Object.entries(environment)
    .filter(
      ([name, secret]) => /(?:KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL)/i.test(name) && Boolean(secret),
    )
    .map(([, secret]) => secret!)
    .sort((left, right) => right.length - left.length);
  for (const secret of secrets) text = text.split(secret).join("[redacted]");
  text = stripVTControlCharacters(text)
    .replace(/\bsk-ant-[A-Za-z0-9_-]+/g, "[redacted]")
    .replace(/\bBearer\s+[^\s"']+/gi, "Bearer [redacted]");
  return Array.from(text)
    .filter((character) => {
      const code = character.charCodeAt(0);
      return (code >= 32 && code !== 127) || code === 9 || code === 10 || code === 13;
    })
    .join("");
}
