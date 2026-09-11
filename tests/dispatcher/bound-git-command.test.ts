import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";

import {
  BOUND_GIT_REMOTE,
  createBoundGitCommand,
  runBoundGitCommand,
} from "../../src/dispatcher/bound-git-command";

const execFileAsync = promisify(execFile);

interface RewriteFixture {
  root: string;
  projectRoot: string;
  trustedRemote: string;
  attackerRemote: string;
  trustedHead: string;
  attackerHead: string;
  baseHead: string;
  environment: NodeJS.ProcessEnv;
}

async function git(
  cwd: string,
  args: readonly string[],
  environment: NodeJS.ProcessEnv = process.env,
): Promise<string> {
  const { stdout } = await execFileAsync("git", [...args], {
    cwd,
    encoding: "utf-8",
    env: environment,
  });
  return String(stdout).trim();
}

async function optionalRef(repository: string, ref: string): Promise<string | undefined> {
  try {
    return await git(repository, ["rev-parse", "--verify", ref]);
  } catch {
    return undefined;
  }
}

async function installRewrite(
  projectRoot: string,
  configFile: string | undefined,
  attackerRemote: string,
  trustedRemote: string,
  variable: "insteadOf" | "pushInsteadOf",
): Promise<void> {
  const scope = configFile ? ["--file", configFile] : ["--local"];
  await git(projectRoot, [
    "config",
    ...scope,
    "--add",
    `url.${attackerRemote}.${variable}`,
    trustedRemote,
  ]);
}

async function expectRewriteScopes(
  state: RewriteFixture,
  variable: "insteadOf" | "pushInsteadOf",
): Promise<void> {
  const configured = await git(
    state.projectRoot,
    ["config", "--show-scope", "--get-all", `url.${state.attackerRemote}.${variable}`],
    state.environment,
  );
  expect(configured.split(/\r?\n/u).map((line) => line.split(/\s+/u)[0])).toEqual(
    expect.arrayContaining(["system", "global", "local", "command"]),
  );
}

async function rewriteFixture(variable: "insteadOf" | "pushInsteadOf"): Promise<RewriteFixture> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `quack-bound-git-${variable}-`));
  const projectRoot = path.join(root, "project");
  const trustedRemote = path.join(root, "trusted.git");
  const attackerRemote = path.join(root, "attacker.git");
  const globalConfig = path.join(root, "global.config");
  const systemConfig = path.join(root, "system.config");
  fs.mkdirSync(projectRoot, { recursive: true });

  await git(projectRoot, ["init", "--initial-branch=main"]);
  await git(projectRoot, ["config", "user.email", "bound-git-test@example.invalid"]);
  await git(projectRoot, ["config", "user.name", "Bound Git Test"]);
  fs.writeFileSync(path.join(projectRoot, "base.txt"), "base\n", "utf-8");
  await git(projectRoot, ["add", "base.txt"]);
  await git(projectRoot, ["commit", "-m", "base"]);
  const baseHead = await git(projectRoot, ["rev-parse", "HEAD"]);

  await git(root, ["init", "--bare", trustedRemote]);
  await git(root, ["init", "--bare", attackerRemote]);
  await git(projectRoot, ["remote", "add", "origin", trustedRemote]);
  await git(projectRoot, ["push", trustedRemote, `${baseHead}:refs/heads/main`]);
  await git(projectRoot, ["push", attackerRemote, `${baseHead}:refs/heads/main`]);
  await git(projectRoot, ["push", trustedRemote, `${baseHead}:refs/heads/delete-probe`]);
  await git(projectRoot, ["push", attackerRemote, `${baseHead}:refs/heads/delete-probe`]);

  fs.writeFileSync(path.join(projectRoot, "trusted.txt"), "trusted\n", "utf-8");
  await git(projectRoot, ["add", "trusted.txt"]);
  await git(projectRoot, ["commit", "-m", "trusted read head"]);
  const trustedHead = await git(projectRoot, ["rev-parse", "HEAD"]);
  await git(projectRoot, ["push", trustedRemote, `${trustedHead}:refs/heads/read-probe`]);

  fs.writeFileSync(path.join(projectRoot, "attacker.txt"), "attacker\n", "utf-8");
  await git(projectRoot, ["add", "attacker.txt"]);
  await git(projectRoot, ["commit", "-m", "attacker read head"]);
  const attackerHead = await git(projectRoot, ["rev-parse", "HEAD"]);
  await git(projectRoot, ["push", attackerRemote, `${attackerHead}:refs/heads/read-probe`]);

  await installRewrite(projectRoot, undefined, attackerRemote, trustedRemote, variable);
  await installRewrite(projectRoot, globalConfig, attackerRemote, trustedRemote, variable);
  await installRewrite(projectRoot, systemConfig, attackerRemote, trustedRemote, variable);

  const environment: NodeJS.ProcessEnv = {
    ...process.env,
    GIT_CONFIG_SYSTEM: systemConfig,
    GIT_CONFIG_GLOBAL: globalConfig,
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: `url.${attackerRemote}.${variable}`,
    GIT_CONFIG_VALUE_0: trustedRemote,
    GIT_CONFIG_KEY_17: "url.file:///stale/.insteadOf",
    GIT_CONFIG_VALUE_17: "quack-publication://",
  };
  delete environment.GIT_CONFIG_NOSYSTEM;

  return {
    root,
    projectRoot,
    trustedRemote,
    attackerRemote,
    trustedHead,
    attackerHead,
    baseHead,
    environment,
  };
}

describe("bound Git command transport", () => {
  jest.setTimeout(60_000);

  test("inherited insteadOf cannot redirect ls-remote, fetch, push, or delete", async () => {
    const state = await rewriteFixture("insteadOf");
    try {
      await expectRewriteScopes(state, "insteadOf");
      const ordinary = await git(
        state.projectRoot,
        ["ls-remote", "--heads", state.trustedRemote, "refs/heads/read-probe"],
        state.environment,
      );
      expect(ordinary).toContain(state.attackerHead);

      const inspected = await runBoundGitCommand(
        ["ls-remote", "--heads", BOUND_GIT_REMOTE, "refs/heads/read-probe"],
        state.projectRoot,
        state.trustedRemote,
        state.environment,
      );
      expect(inspected.exitCode).toBe(0);
      expect(inspected.stdout).toContain(state.trustedHead);

      const missingMapping = createBoundGitCommand(
        ["ls-remote", "--heads", BOUND_GIT_REMOTE, "refs/heads/read-probe"],
        state.trustedRemote,
        state.environment,
      );
      missingMapping.environment.GIT_CONFIG_COUNT = "2";
      let missingMappingFailed = false;
      try {
        await execFileAsync("git", missingMapping.args, {
          cwd: state.projectRoot,
          encoding: "utf-8",
          env: missingMapping.environment,
        });
      } catch {
        missingMappingFailed = true;
      }
      expect(missingMappingFailed).toBe(true);

      const fetched = await runBoundGitCommand(
        ["fetch", BOUND_GIT_REMOTE, "read-probe:refs/remotes/quack-test/read-probe"],
        state.projectRoot,
        state.trustedRemote,
        state.environment,
      );
      expect(fetched.exitCode).toBe(0);
      expect(
        await git(state.projectRoot, ["rev-parse", "refs/remotes/quack-test/read-probe"]),
      ).toBe(state.trustedHead);

      const pushed = await runBoundGitCommand(
        ["push", BOUND_GIT_REMOTE, `${state.trustedHead}:refs/heads/bound-push`],
        state.projectRoot,
        state.trustedRemote,
        state.environment,
      );
      expect(pushed.exitCode).toBe(0);
      expect(await optionalRef(state.trustedRemote, "refs/heads/bound-push")).toBe(
        state.trustedHead,
      );
      expect(await optionalRef(state.attackerRemote, "refs/heads/bound-push")).toBeUndefined();

      const deleted = await runBoundGitCommand(
        ["push", BOUND_GIT_REMOTE, ":refs/heads/delete-probe"],
        state.projectRoot,
        state.trustedRemote,
        state.environment,
      );
      expect(deleted.exitCode).toBe(0);
      expect(await optionalRef(state.trustedRemote, "refs/heads/delete-probe")).toBeUndefined();
      expect(await optionalRef(state.attackerRemote, "refs/heads/delete-probe")).toBe(
        state.baseHead,
      );
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("inherited pushInsteadOf cannot redirect push or delete", async () => {
    const state = await rewriteFixture("pushInsteadOf");
    try {
      await expectRewriteScopes(state, "pushInsteadOf");
      await git(
        state.projectRoot,
        ["push", state.trustedRemote, `${state.attackerHead}:refs/heads/ordinary-redirect`],
        state.environment,
      );
      expect(
        await optionalRef(state.trustedRemote, "refs/heads/ordinary-redirect"),
      ).toBeUndefined();
      expect(await optionalRef(state.attackerRemote, "refs/heads/ordinary-redirect")).toBe(
        state.attackerHead,
      );

      const pushed = await runBoundGitCommand(
        ["push", BOUND_GIT_REMOTE, `${state.trustedHead}:refs/heads/bound-push`],
        state.projectRoot,
        state.trustedRemote,
        state.environment,
      );
      expect(pushed.exitCode).toBe(0);
      expect(await optionalRef(state.trustedRemote, "refs/heads/bound-push")).toBe(
        state.trustedHead,
      );
      expect(await optionalRef(state.attackerRemote, "refs/heads/bound-push")).toBeUndefined();

      const deleted = await runBoundGitCommand(
        ["push", BOUND_GIT_REMOTE, ":refs/heads/delete-probe"],
        state.projectRoot,
        state.trustedRemote,
        state.environment,
      );
      expect(deleted.exitCode).toBe(0);
      expect(await optionalRef(state.trustedRemote, "refs/heads/delete-probe")).toBeUndefined();
      expect(await optionalRef(state.attackerRemote, "refs/heads/delete-probe")).toBe(
        state.baseHead,
      );
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("keeps credential-bearing origins out of argv and redacts Git output", async () => {
    const credentialUrl = "https://actor:super-secret@example.invalid/org/repository.git";
    const inheritedEnvironment = {
      ...process.env,
      GIT_CONFIG_COUNT: "8",
      GIT_CONFIG_KEY_0: "url.file:///attacker/.insteadOf",
      GIT_CONFIG_VALUE_0: credentialUrl,
      GIT_CONFIG_KEY_7: "url.file:///stale/.insteadOf",
      GIT_CONFIG_VALUE_7: "quack-publication://",
      GIT_CONFIG_PARAMETERS: "'url.file:///stale/.insteadOf=quack-publication://'",
    };

    const first = createBoundGitCommand(
      ["remote", "-v", BOUND_GIT_REMOTE],
      credentialUrl,
      inheritedEnvironment,
    );
    const second = createBoundGitCommand(
      ["remote", "-v", BOUND_GIT_REMOTE],
      credentialUrl,
      inheritedEnvironment,
    );
    expect(first.args.join(" ")).not.toContain(credentialUrl);
    expect(first.args).not.toEqual(second.args);
    expect(first.environment.GIT_CONFIG_COUNT).toBe("4");
    expect(first.environment.GIT_CONFIG_KEY_7).toBeUndefined();
    expect(first.environment.GIT_CONFIG_VALUE_7).toBeUndefined();
    expect(first.environment.GIT_CONFIG_PARAMETERS).toBeUndefined();
    expect(Object.values(first.environment)).toContain(`url.${credentialUrl}.insteadOf`);

    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-bound-git-credentials-"));
    try {
      await git(root, ["init"]);
      const result = await runBoundGitCommand(
        ["remote", "-v"],
        root,
        credentialUrl,
        inheritedEnvironment,
      );
      expect(result.exitCode).toBe(0);
      expect(result.stdout).not.toContain(credentialUrl);
      expect(result.stdout).not.toContain("super-secret");
      expect(result.stdout).toContain("[bound-origin]");
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
