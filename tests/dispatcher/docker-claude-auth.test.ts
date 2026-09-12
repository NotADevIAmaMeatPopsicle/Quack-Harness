import * as childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  DockerManager,
  TRUSTED_MANAGED_DOCKER_IMAGES_ENV,
} from "../../src/dispatcher/docker-manager";
import { _setDockerExecutableForTests } from "../../src/dispatcher/docker-cleanup";
import { KeyManager } from "../../src/dispatcher/key-manager";
import { selectClaudeApiKey } from "../../src/sdk/claude-auth";

jest.mock("node:child_process", () => ({
  ...jest.requireActual<typeof import("node:child_process")>("node:child_process"),
  spawn: jest.fn(),
}));

describe("Docker Claude credential precedence", () => {
  const originalEnvironment = process.env;
  const image = `node@sha256:${"a".repeat(64)}`;
  let root: string;
  const spawnSpy = jest.mocked(childProcess.spawn);
  beforeEach(() => {
    process.env = {
      ...originalEnvironment,
      [TRUSTED_MANAGED_DOCKER_IMAGES_ENV]: JSON.stringify([image]),
    };
    for (const name of Object.keys(process.env))
      if (/^(?:ANTHROPIC_API_KEY(?:_\d+)?|CLAUDE_CODE_OAUTH_TOKEN)$/i.test(name))
        delete process.env[name];
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-auth-"));
    _setDockerExecutableForTests(process.execPath);
    spawnSpy.mockReturnValue(new EventEmitter() as unknown as childProcess.ChildProcess);
  });
  afterEach(() => {
    spawnSpy.mockReset();
    _setDockerExecutableForTests(undefined);
    process.env = originalEnvironment;
    fs.rmSync(root, { recursive: true, force: true });
  });
  function manager(passthrough = ["ANTHROPIC_API_KEY"]): DockerManager {
    return new DockerManager(
      root,
      {
        image,
        volumes: [],
        envPassthrough: passthrough,
        resourceLimits: { memoryMb: 4096, cpus: 2 },
        networkMode: "bridge",
        cleanupPolicy: "remove",
      },
      root,
    );
  }
  function flags(): string[] {
    return spawnSpy.mock.calls[0][1] as string[];
  }

  it("keeps a selected rotated key after passthrough and clears OAuth in the actual exec args", () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "fixture-primary",
      ANTHROPIC_API_KEY_2: "fixture-second",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
    });
    const pool = new KeyManager({ pool: ["env:ANTHROPIC_API_KEY_2"] });
    manager([
      "ANTHROPIC_API_KEY",
      "ANTHROPIC_API_KEY_2",
      "CLAUDE_CODE_OAUTH_TOKEN",
      TRUSTED_MANAGED_DOCKER_IMAGES_ENV,
    ]).execAgent(
      "fixture-container",
      ["node", "agent.js"],
      { ANTHROPIC_API_KEY: "fixture-primary" },
      selectClaudeApiKey(pool),
    );
    expect(flags().filter((argument) => argument.startsWith("ANTHROPIC_API_KEY="))).toEqual([
      "ANTHROPIC_API_KEY=fixture-second",
    ]);
    expect(flags()).toContain("CLAUDE_CODE_OAUTH_TOKEN=");
    expect(flags()).not.toContain("CLAUDE_CODE_OAUTH_TOKEN=fixture-oauth");
    expect(
      flags().some((argument) => argument.startsWith(`${TRUSTED_MANAGED_DOCKER_IMAGES_ENV}=`)),
    ).toBe(false);
  });

  it("refuses an unselected conflict even if an environment marker claims selection", () => {
    Object.assign(process.env, {
      ANTHROPIC_API_KEY: "fixture-primary",
      CLAUDE_CODE_OAUTH_TOKEN: "fixture-oauth",
    });
    expect(() =>
      manager().execAgent("fixture-container", ["node", "agent.js"], {
        QUACK_SELECTED_KEY_ID: "key-1",
      }),
    ).toThrow("Both Anthropic API keys");
    expect(spawnSpy).not.toHaveBeenCalled();
  });

  it("passes OAuth only when the Docker environment policy admits it", () => {
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fixture-oauth";
    expect(() => manager().execAgent("fixture-container", ["node", "agent.js"])).toThrow(
      "not admitted by Docker envPassthrough",
    );
    expect(spawnSpy).not.toHaveBeenCalled();
    manager(["CLAUDE_CODE_OAUTH_TOKEN"]).execAgent("fixture-container", ["node", "agent.js"]);
    expect(flags()).toContain("CLAUDE_CODE_OAUTH_TOKEN=fixture-oauth");
    expect(flags()).toContain("ANTHROPIC_API_KEY=");
  });
});
