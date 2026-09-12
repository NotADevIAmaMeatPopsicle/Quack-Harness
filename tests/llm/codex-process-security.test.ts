import {
  buildCodexProcessEnv,
  codexShellEnvironmentPolicyArgs,
} from "../../src/llm/codex-process-security";

describe("Codex process security boundary", () => {
  const source: NodeJS.ProcessEnv = {
    PATH: "C:/Windows/System32",
    TEMP: "C:/Temp",
    CODEX_HOME: "C:/Codex/Home",
    AZURE_OPENAI_API_KEY: "selected-azure-key",
    OPENAI_API_KEY: "unselected-openai-key",
    ANTHROPIC_API_KEY: "unrelated-key",
    QUACK_SERVICE_TOKEN: "quack-sentinel",
    DATABASE_PASSWORD: "database-sentinel",
    SENTINEL_SECRET: "generic-sentinel",
  };

  test("passes only OS context, CODEX_HOME, and the selected provider credential", () => {
    expect(buildCodexProcessEnv({ provider: "azure" }, source)).toEqual({
      PATH: "C:/Windows/System32",
      TEMP: "C:/Temp",
      CODEX_HOME: "C:/Codex/Home",
      AZURE_OPENAI_API_KEY: "selected-azure-key",
    });
  });

  test("supports a validated custom credential name without admitting QUACK secrets", () => {
    const customSource = {
      ...source,
      COMPANY_OPENAI_CREDENTIAL: "selected-custom-key",
    };
    expect(
      buildCodexProcessEnv({ credentialEnvVar: "COMPANY_OPENAI_CREDENTIAL" }, customSource),
    ).toMatchObject({ COMPANY_OPENAI_CREDENTIAL: "selected-custom-key" });
    expect(
      buildCodexProcessEnv({ credentialEnvVar: "COMPANY_OPENAI_CREDENTIAL" }, customSource),
    ).not.toHaveProperty("QUACK_SERVICE_TOKEN");
    expect(() => buildCodexProcessEnv({ credentialEnvVar: "QUACK_SERVICE_TOKEN" }, source)).toThrow(
      "outside the QUACK_* namespace",
    );
  });

  test("pins the exact shell environment policy passed to Codex", () => {
    const allowedShellNames = [
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
    ];
    expect(codexShellEnvironmentPolicyArgs()).toEqual([
      "-c",
      'shell_environment_policy.inherit="core"',
      "-c",
      "shell_environment_policy.ignore_default_excludes=false",
      "-c",
      "shell_environment_policy.set={}",
      "-c",
      `shell_environment_policy.filters={${[
        ...allowedShellNames.map((name) => `"${name}"="include"`),
        '"QUACK_*"="exclude"',
        '"*KEY*"="exclude"',
        '"*TOKEN*"="exclude"',
        '"*SECRET*"="exclude"',
        '"*PASSWORD*"="exclude"',
        '"*CREDENTIAL*"="exclude"',
        '"*AUTH*"="exclude"',
      ].join(",")}}`,
    ]);
  });
});
