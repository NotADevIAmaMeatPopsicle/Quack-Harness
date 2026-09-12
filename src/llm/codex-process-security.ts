// Shared process-boundary hardening for every Codex CLI runner.
//
// The Codex process needs a small amount of host context plus its own model
// credential. It must not inherit Quack service tokens or unrelated secrets.
// The fixed CLI overrides additionally keep credentials needed by Codex itself
// out of model-launched shell commands.

export interface CodexProcessSecurityConfig {
  codexHome?: string;
  provider?: string;
  credentialEnvVar?: string;
}

const SAFE_ENV_NAME = /^[A-Z_][A-Z0-9_]*$/;

// OS/runtime variables only. Deliberately excludes proxy variables because
// proxy URLs can embed credentials; headless hosts should configure networking
// in the Codex profile instead.
const CORE_ENV_NAMES = [
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "WINDIR",
  "COMSPEC",
  "TEMP",
  "TMP",
  "TMPDIR",
  "HOME",
  "USERPROFILE",
  "HOMEDRIVE",
  "HOMEPATH",
  "APPDATA",
  "LOCALAPPDATA",
  "PROGRAMDATA",
  "PROGRAMFILES",
  "PROGRAMFILES(X86)",
  "USER",
  "LOGNAME",
  "SHELL",
  "LANG",
  "LC_ALL",
  "TZ",
  "SSL_CERT_FILE",
  "SSL_CERT_DIR",
  "NODE_EXTRA_CA_CERTS",
] as const;

const SHELL_SAFE_ENV_NAMES = CORE_ENV_NAMES;

function readEnvironmentValue(
  source: NodeJS.ProcessEnv,
  requestedName: string,
): { name: string; value: string } | undefined {
  const actualName = Object.keys(source).find(
    (name) => name.toUpperCase() === requestedName.toUpperCase(),
  );
  const value = actualName ? source[actualName] : undefined;
  return actualName && value !== undefined ? { name: actualName, value } : undefined;
}

function defaultCredentialEnvVar(provider?: string): string {
  return provider?.toLowerCase() === "azure" ? "AZURE_OPENAI_API_KEY" : "OPENAI_API_KEY";
}

/**
 * Construct the complete environment for the Codex CLI process. No ambient
 * variable outside this allowlist crosses the process boundary.
 */
export function buildCodexProcessEnv(
  config: CodexProcessSecurityConfig,
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const name of CORE_ENV_NAMES) {
    const entry = readEnvironmentValue(source, name);
    if (entry) result[entry.name] = entry.value;
  }

  const ambientCodexHome = readEnvironmentValue(source, "CODEX_HOME");
  if (config.codexHome) {
    result.CODEX_HOME = config.codexHome;
  } else if (ambientCodexHome) {
    result[ambientCodexHome.name] = ambientCodexHome.value;
  }

  const credentialEnvVar = config.credentialEnvVar ?? defaultCredentialEnvVar(config.provider);
  if (!SAFE_ENV_NAME.test(credentialEnvVar) || credentialEnvVar.startsWith("QUACK_")) {
    throw new Error(
      "Codex credentialEnvVar must be an uppercase environment name outside the QUACK_* namespace",
    );
  }
  const credential = readEnvironmentValue(source, credentialEnvVar);
  if (credential) result[credential.name] = credential.value;

  return result;
}

/**
 * Fixed Codex config overrides for model-launched shell commands. `core`
 * retains only basic OS variables, while the explicit filters and Codex's
 * default KEY/SECRET/TOKEN filter exclude Quack and credential-like names.
 */
export function codexShellEnvironmentPolicyArgs(): string[] {
  const filters = [
    ...SHELL_SAFE_ENV_NAMES.map((name) => `"${name}"="include"`),
    '"QUACK_*"="exclude"',
    '"*KEY*"="exclude"',
    '"*TOKEN*"="exclude"',
    '"*SECRET*"="exclude"',
    '"*PASSWORD*"="exclude"',
    '"*CREDENTIAL*"="exclude"',
    '"*AUTH*"="exclude"',
  ].join(",");
  return [
    "-c",
    'shell_environment_policy.inherit="core"',
    "-c",
    "shell_environment_policy.ignore_default_excludes=false",
    "-c",
    "shell_environment_policy.set={}",
    "-c",
    `shell_environment_policy.filters={${filters}}`,
  ];
}
