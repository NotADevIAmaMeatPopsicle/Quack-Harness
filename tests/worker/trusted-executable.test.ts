import { execFileSync } from "node:child_process";
import {
  appendFileSync,
  chmodSync,
  copyFileSync,
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { devNull, tmpdir } from "node:os";
import path from "node:path";
import {
  buildTrustedGitEnvironment,
  parseTrustedGitHubRepository,
  readTrustedCoreWorktree,
  resolveTrustedGitHubCli,
  resolveTrustedGitHubRepository,
  resolveTrustedExecutable,
  runTrustedGitHubResult,
  runTrustedGitHubIssuePageResult,
  runTrustedGitResult,
  unsetTrustedCoreWorktree,
} from "../../src/worker/trusted-executable";

describe("trusted worker executables", () => {
  const windowsTest = process.platform === "win32" ? test : test.skip;

  test("parses SSH repository identity but rejects credentials in HTTPS remotes", () => {
    expect(parseTrustedGitHubRepository("ssh://git@github.com/org/repo.git")).toEqual({
      host: "github.com",
      owner: "org",
      repo: "repo",
    });
    expect(() =>
      parseTrustedGitHubRepository("https://operator-token@github.com/org/repo.git"),
    ).toThrow("unsupported URL credentials");
    expect(parseTrustedGitHubRepository("https://ghe.example.test:8443/org/repo.git")).toEqual({
      host: "ghe.example.test:8443",
      owner: "org",
      repo: "repo",
    });
    expect(() =>
      parseTrustedGitHubRepository("https://ghe.example.test:65536/org/repo.git"),
    ).toThrow("not a valid GitHub URL");
  });

  windowsTest("skips a mutable-project executable shadow during PATH resolution", () => {
    const commandInterpreter = process.env.ComSpec;
    if (!commandInterpreter) throw new Error("ComSpec is required for the Windows regression");
    const tempRoot = mkdtempSync(path.join(tmpdir(), "quack-trusted-executable-"));
    const projectRoot = path.join(tempRoot, "worktree");
    const trustedRoot = path.join(tempRoot, "trusted-bin");
    mkdirSync(projectRoot);
    mkdirSync(trustedRoot);
    const shadow = path.join(projectRoot, "codex.exe");
    const trusted = path.join(trustedRoot, "codex.exe");
    copyFileSync(commandInterpreter, shadow);
    copyFileSync(commandInterpreter, trusted);

    try {
      expect(
        resolveTrustedExecutable("codex", projectRoot, "Codex CLI", {
          PATH: [projectRoot, trustedRoot].join(path.delimiter),
        }),
      ).toBe(trusted);
      expect(resolveTrustedExecutable(trusted, projectRoot, "Codex CLI", process.env)).toBe(
        trusted,
      );
      expect(() => resolveTrustedExecutable(shadow, projectRoot, "Codex CLI", process.env)).toThrow(
        "resolves inside the mutable project",
      );
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test("builds a minimal Git environment without service credentials or Git overrides", () => {
    const executable = process.platform === "win32" ? "C:\\trusted\\git.exe" : "/trusted/bin/git";
    const environment = buildTrustedGitEnvironment(executable, {
      PATH: process.env.PATH,
      HOME: "/trusted-home",
      SYSTEMROOT: "C:\\Windows",
      OPENAI_API_KEY: "secret",
      QUACK_SERVICE_TOKEN: "secret",
      GIT_DIR: "/attacker-controlled",
      GIT_CONFIG_GLOBAL: "/attacker-controlled",
    });

    expect(environment.HOME).toBe("/trusted-home");
    expect(environment.OPENAI_API_KEY).toBeUndefined();
    expect(environment.QUACK_SERVICE_TOKEN).toBeUndefined();
    expect(environment.GIT_DIR).toBeUndefined();
    expect(environment.GIT_CONFIG_NOSYSTEM).toBe("1");
    expect(environment.GIT_CONFIG_GLOBAL).toBe(process.platform === "win32" ? "NUL" : devNull);
    expect(environment.GIT_ATTR_NOSYSTEM).toBe("1");
    expect(environment.GIT_TERMINAL_PROMPT).toBe("0");
    expect(environment.GIT_CONFIG_COUNT).toBeUndefined();
    expect(environment.GIT_CONFIG_KEY_0).toBeUndefined();
    expect(environment.GIT_CONFIG_VALUE_0).toBeUndefined();
    expect(environment.PATH?.split(path.delimiter)[0]).toBe(path.dirname(executable));
  });

  test("resolves GitHub CLI and its Git dependency past mutable PATH shadows", () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "quack-trusted-gh-"));
    const projectRoot = path.join(tempRoot, "project");
    const trustedRoot = path.join(tempRoot, "trusted-bin");
    mkdirSync(projectRoot);
    mkdirSync(trustedRoot);
    const extension = process.platform === "win32" ? ".exe" : "";
    const shadowGit = path.join(projectRoot, `git${extension}`);
    const shadowGh = path.join(projectRoot, `gh${extension}`);
    const trustedGit = path.join(trustedRoot, `git${extension}`);
    const trustedGh = path.join(trustedRoot, `gh${extension}`);
    if (process.platform === "win32") {
      const commandInterpreter = process.env.ComSpec;
      if (!commandInterpreter) throw new Error("ComSpec is required for the Windows regression");
      for (const destination of [shadowGit, shadowGh, trustedGit, trustedGh]) {
        copyFileSync(commandInterpreter, destination);
      }
    } else {
      for (const destination of [shadowGit, shadowGh, trustedGit, trustedGh]) {
        writeFileSync(destination, "#!/bin/sh\nexit 0\n", "utf8");
        chmodSync(destination, 0o755);
      }
    }

    try {
      const sourceEnvironment = Object.fromEntries(
        Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
      );
      const resolved = resolveTrustedGitHubCli(projectRoot, {
        ...sourceEnvironment,
        PATH: [projectRoot, trustedRoot].join(path.delimiter),
        GH_TOKEN: "operator-token",
        GH_CONFIG_DIR: projectRoot,
        QUACK_SERVICE_TOKEN: "must-not-leak",
        GIT_DIR: path.join(projectRoot, ".git"),
      });

      expect(resolved.executable).toBe(realpathSync.native(trustedGh));
      expect(resolved.environment.PATH?.split(path.delimiter)[0]).toBe(
        path.dirname(realpathSync.native(trustedGh)),
      );
      expect(resolved.environment.PATH).toContain(path.dirname(realpathSync.native(trustedGit)));
      expect(resolved.environment.GH_TOKEN).toBe("operator-token");
      expect(resolved.environment.GH_PROMPT_DISABLED).toBe("1");
      expect(resolved.environment.GH_CONFIG_DIR).toBeUndefined();
      expect(resolved.environment.QUACK_SERVICE_TOKEN).toBeUndefined();
      expect(resolved.environment.GIT_DIR).toBeUndefined();
    } finally {
      rmSync(tempRoot, { recursive: true, force: true });
    }
  });

  test.each(["pull request", "issue page"] as const)(
    "runs the %s read from a neutral cwd with an audited repository",
    async (readKind) => {
      const tempRoot = mkdtempSync(path.join(tmpdir(), "quack-trusted-gh-run-"));
      const projectRoot = path.join(tempRoot, "project");
      const trustedRoot = path.join(tempRoot, "trusted-bin");
      mkdirSync(projectRoot);
      mkdirSync(trustedRoot);
      const git = resolveTrustedExecutable("git", projectRoot, "test Git");
      const extension = process.platform === "win32" ? ".exe" : "";
      const trustedGh = path.join(trustedRoot, `gh${extension}`);
      const shadowGh = path.join(projectRoot, `gh${extension}`);
      const shadowGit = path.join(projectRoot, `git${extension}`);
      const trustedCapture = path.join(trustedRoot, "capture.json");
      const shadowCapture = path.join(projectRoot, "shadow.json");
      const script = (capturePath: string): string =>
        `let input="";process.stdin.setEncoding("utf8");process.stdin.on("data",chunk=>{input+=chunk});process.stdin.on("end",()=>require("node:fs").writeFileSync(${JSON.stringify(capturePath)}, JSON.stringify({cwd:process.cwd(),args:process.argv.slice(2),input,env:{GH_HOST:process.env.GH_HOST,GH_TOKEN:process.env.GH_TOKEN,GH_CONFIG_DIR:process.env.GH_CONFIG_DIR,PATH:process.env.PATH}})));\n`;
      try {
        execFileSync(git, ["-C", projectRoot, "init", "-b", "main"], { stdio: "ignore" });
        execFileSync(
          git,
          ["-C", projectRoot, "remote", "add", "origin", "git@github.com:org/repo.git"],
          { stdio: "ignore" },
        );
        if (process.platform === "win32") {
          copyFileSync(process.execPath, trustedGh);
          copyFileSync(process.execPath, shadowGh);
          copyFileSync(process.execPath, shadowGit);
        } else {
          copyFileSync(process.execPath, trustedGh);
          copyFileSync(process.execPath, shadowGh);
          chmodSync(trustedGh, 0o755);
          chmodSync(shadowGh, 0o755);
          writeFileSync(shadowGit, "#!/bin/sh\nexit 91\n", "utf8");
          chmodSync(shadowGit, 0o755);
        }
        writeFileSync(path.join(trustedRoot, "pr"), script(trustedCapture), "utf8");
        writeFileSync(path.join(trustedRoot, "api"), script(trustedCapture), "utf8");
        writeFileSync(path.join(projectRoot, "pr"), script(shadowCapture), "utf8");
        const sourceEnvironment = Object.fromEntries(
          Object.entries(process.env).filter(([name]) => name.toUpperCase() !== "PATH"),
        );
        const executionOptions = {
          timeoutMs: 10_000,
          maxBuffer: 1024 * 1024,
          expectedRepository: { host: "github.com", owner: "org", repo: "repo" },
          input: "trusted body\n",
          environment: {
            ...sourceEnvironment,
            PATH: [projectRoot, trustedRoot, path.dirname(git)].join(path.delimiter),
            GH_TOKEN: "operator-token",
            GH_HOST: "github.com",
            GH_CONFIG_DIR: projectRoot,
          },
        };
        const cursor = 'opaque-cursor" owner:attacker/repository';
        const result =
          readKind === "issue page"
            ? await runTrustedGitHubIssuePageResult(projectRoot, cursor, executionOptions)
            : await runTrustedGitHubResult(
                projectRoot,
                ["pr", "view", "https://github.com/org/repo/pull/42", "--json", "url"],
                executionOptions,
              );

        expect(result.exitCode).toBe(0);
        expect(existsSync(shadowCapture)).toBe(false);
        const capture = JSON.parse(readFileSync(trustedCapture, "utf8")) as {
          cwd: string;
          args: string[];
          input: string;
          env: Record<string, string | undefined>;
        };
        expect(realpathSync.native(capture.cwd)).toBe(realpathSync.native(trustedRoot));
        if (readKind === "issue page") {
          expect(capture.args).toEqual(["graphql", "--input", "-"]);
          const request = JSON.parse(capture.input) as { query: string; variables: unknown };
          expect(request.variables).toEqual({ owner: "org", name: "repo", after: cursor });
          expect(request.query).toContain("issues(first: 25, after: $after");
          expect(request.query).toContain("states: [OPEN, CLOSED]");
          expect(request.query).toContain("orderBy: {field: CREATED_AT, direction: ASC}");
          expect(request.query).not.toContain(cursor);
          expect(request.query).not.toContain("search");
        } else {
          expect(capture.args).toEqual([
            "view",
            "https://github.com/org/repo/pull/42",
            "--json",
            "url",
            "--repo",
            "github.com/org/repo",
          ]);
          expect(capture.input).toBe("trusted body\n");
        }
        expect(capture.env).toMatchObject({
          GH_HOST: "github.com",
          GH_TOKEN: "operator-token",
        });
        expect(capture.env.GH_CONFIG_DIR).toBeUndefined();
        expect(capture.env.PATH).not.toContain(projectRoot);
      } finally {
        rmSync(tempRoot, { recursive: true, force: true });
      }
    },
  );

  test("rejects unsafe repository config before a credential-bearing GitHub launch", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "quack-trusted-gh-config-"));
    const git = resolveTrustedExecutable("git", root, "test Git");
    try {
      execFileSync(git, ["-C", root, "init", "-b", "main"], { stdio: "ignore" });
      execFileSync(
        git,
        ["-C", root, "remote", "add", "origin", "https://github.com/org/repo.git"],
        { stdio: "ignore" },
      );
      execFileSync(git, ["-C", root, "config", "credential.helper", "!unsafe-helper"], {
        stdio: "ignore",
      });

      await expect(
        resolveTrustedGitHubRepository(root, {
          timeoutMs: 10_000,
          maxBuffer: 1024 * 1024,
          expectedRepository: { owner: "org", repo: "repo" },
        }),
      ).rejects.toThrow('unsafe Git configuration key "credential.helper"');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a repository identity mismatch before GitHub receives credentials", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "quack-trusted-gh-identity-"));
    const git = resolveTrustedExecutable("git", root, "test Git");
    try {
      execFileSync(git, ["-C", root, "init", "-b", "main"], { stdio: "ignore" });
      execFileSync(
        git,
        ["-C", root, "remote", "add", "origin", "https://github.com/attacker/repo.git"],
        { stdio: "ignore" },
      );

      await expect(
        resolveTrustedGitHubRepository(root, {
          timeoutMs: 10_000,
          maxBuffer: 1024 * 1024,
          expectedRepository: { owner: "org", repo: "repo" },
        }),
      ).rejects.toThrow("does not match expected repository");
      await expect(
        runTrustedGitHubIssuePageResult(root, undefined, {
          timeoutMs: 10_000,
          maxBuffer: 1024 * 1024,
          expectedRepository: { owner: "org", repo: "repo" },
        }),
      ).rejects.toThrow("does not match expected repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a Git push when origin pushurl differs from the sealed repository", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quack-trusted-git-pushurl-"));
    const git = resolveTrustedExecutable("git", root, "test Git");
    try {
      execFileSync(git, ["-C", root, "init", "-b", "main"], { stdio: "ignore" });
      execFileSync(
        git,
        ["-C", root, "remote", "add", "origin", "https://github.com/org/repo.git"],
        { stdio: "ignore" },
      );
      execFileSync(
        git,
        [
          "-C",
          root,
          "remote",
          "set-url",
          "--push",
          "origin",
          "https://github.com/attacker/repo.git",
        ],
        { stdio: "ignore" },
      );

      expect(() =>
        runTrustedGitResult(root, ["push", "origin", "HEAD:refs/heads/main"], {
          timeoutMs: 10_000,
          maxBuffer: 1024 * 1024,
          expectedRepository: { host: "github.com", owner: "org", repo: "repo" },
        }),
      ).toThrow("does not match expected repository");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects a Git push with multiple configured push destinations", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quack-trusted-git-pushurl-many-"));
    const git = resolveTrustedExecutable("git", root, "test Git");
    try {
      execFileSync(git, ["-C", root, "init", "-b", "main"], { stdio: "ignore" });
      execFileSync(
        git,
        ["-C", root, "remote", "add", "origin", "https://github.com/org/repo.git"],
        { stdio: "ignore" },
      );
      execFileSync(
        git,
        ["-C", root, "config", "--add", "remote.origin.pushurl", "https://github.com/org/repo.git"],
        { stdio: "ignore" },
      );
      execFileSync(
        git,
        ["-C", root, "config", "--add", "remote.origin.pushurl", "https://github.com/org/repo.git"],
        { stdio: "ignore" },
      );

      expect(() =>
        runTrustedGitResult(root, ["push", "origin", "HEAD:refs/heads/main"], {
          timeoutMs: 10_000,
          maxBuffer: 1024 * 1024,
          expectedRepository: { host: "github.com", owner: "org", repo: "repo" },
        }),
      ).toThrow("without one exact transport destination");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("refuses repository config changed after its trusted baseline", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "quack-git-config-attestation-"));
    const git = resolveTrustedExecutable("git", root, "test Git");
    const runFixtureGit = (args: string[]): void => {
      execFileSync(git, ["-C", root, ...args], {
        cwd: path.dirname(git),
        stdio: "ignore",
      });
    };
    try {
      runFixtureGit(["init", "-b", "main"]);
      const baseline = await runTrustedGitResult(root, ["status", "--short"], {
        timeoutMs: 10_000,
        maxBuffer: 1024 * 1024,
      });
      expect(baseline.exitCode).toBe(0);

      appendFileSync(path.join(root, ".git", "config"), "\n[user]\n\tname = changed\n");

      expect(() =>
        runTrustedGitResult(root, ["status", "--short"], {
          timeoutMs: 10_000,
          maxBuffer: 1024 * 1024,
        }),
      ).toThrow("Git configuration changed outside trusted Git execution");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("repairs core.worktree through direct trusted metadata access", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quack-core-worktree-repair-"));
    const git = resolveTrustedExecutable("git", root, "test Git");
    const runFixtureGit = (args: string[]): void => {
      execFileSync(git, ["-C", root, ...args], {
        cwd: path.dirname(git),
        stdio: "ignore",
      });
    };
    const leaked = path.join(root, ".quack", "worktrees", "TASK-REPAIR");
    const shadowMarker = path.join(root, "shadow-ran.txt");
    try {
      runFixtureGit(["init", "-b", "main"]);
      runFixtureGit(["config", "--local", "core.worktree", leaked]);
      if (process.platform === "win32") {
        writeFileSync(
          path.join(root, "git.cmd"),
          `@echo off\r\necho unsafe>"${shadowMarker}"\r\nexit /b 91\r\n`,
        );
        writeFileSync(path.join(root, "git.exe"), "not an executable", "utf8");
      } else {
        const shadow = path.join(root, "git");
        writeFileSync(shadow, `#!/bin/sh\necho unsafe > '${shadowMarker}'\nexit 91\n`, "utf8");
        chmodSync(shadow, 0o755);
      }

      expect(readTrustedCoreWorktree(root)).toBe(leaked);
      expect(unsetTrustedCoreWorktree(root, leaked)).toBe(true);
      expect(readTrustedCoreWorktree(root)).toBeUndefined();
      expect(existsSync(shadowMarker)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the last duplicate core.worktree value and removes only the leaked value", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quack-core-worktree-duplicate-"));
    const git = resolveTrustedExecutable("git", root, "test Git");
    const runFixtureGit = (args: string[]): string =>
      execFileSync(git, ["-C", root, ...args], {
        cwd: path.dirname(git),
        encoding: "utf8",
      }).trim();
    const operatorValue = path.join(root, "operator-worktree");
    const leakedValue = path.join(root, ".quack", "worktrees", "TASK-DUPLICATE");
    try {
      runFixtureGit(["init", "-b", "main"]);
      mkdirSync(operatorValue);
      mkdirSync(leakedValue, { recursive: true });
      runFixtureGit(["config", "--local", "--add", "core.worktree", operatorValue]);
      runFixtureGit(["config", "--local", "--add", "core.worktree", leakedValue]);

      expect(runFixtureGit(["config", "--get", "core.worktree"])).toBe(leakedValue);
      expect(readTrustedCoreWorktree(root)).toBe(leakedValue);
      expect(unsetTrustedCoreWorktree(root, leakedValue)).toBe(true);
      expect(readTrustedCoreWorktree(root)).toBe(operatorValue);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("honors config.worktree precedence over the common repository config", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quack-core-worktree-local-"));
    const git = resolveTrustedExecutable("git", root, "test Git");
    const runFixtureGit = (args: string[]): string =>
      execFileSync(git, ["-C", root, ...args], {
        cwd: path.dirname(git),
        encoding: "utf8",
      }).trim();
    const commonValue = path.join(root, "operator-worktree");
    const leakedValue = path.join(root, ".quack", "worktrees", "TASK-LOCAL");
    try {
      runFixtureGit(["init", "-b", "main"]);
      mkdirSync(commonValue);
      mkdirSync(leakedValue, { recursive: true });
      runFixtureGit(["config", "--local", "extensions.worktreeConfig", "true"]);
      runFixtureGit(["config", "--local", "core.worktree", commonValue]);
      runFixtureGit(["config", "--worktree", "core.worktree", leakedValue]);

      expect(runFixtureGit(["config", "--get", "core.worktree"])).toBe(leakedValue);
      expect(readTrustedCoreWorktree(root)).toBe(leakedValue);
      expect(unsetTrustedCoreWorktree(root, leakedValue)).toBe(true);
      expect(readTrustedCoreWorktree(root)).toBe(commonValue);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("ignores config.worktree until extensions.worktreeConfig is enabled", () => {
    const root = mkdtempSync(path.join(tmpdir(), "quack-core-worktree-disabled-"));
    const git = resolveTrustedExecutable("git", root, "test Git");
    const runFixtureGit = (args: string[]): void => {
      execFileSync(git, ["-C", root, ...args], {
        cwd: path.dirname(git),
        stdio: "ignore",
      });
    };
    const leakedValue = path.join(root, ".quack", "worktrees", "TASK-DISABLED");
    try {
      runFixtureGit(["init", "-b", "main"]);
      mkdirSync(leakedValue, { recursive: true });
      runFixtureGit([
        "config",
        "--file",
        path.join(root, ".git", "config.worktree"),
        "core.worktree",
        leakedValue,
      ]);

      expect(readTrustedCoreWorktree(root)).toBeUndefined();
      runFixtureGit(["config", "--local", "extensions.worktreeConfig", "true"]);
      expect(readTrustedCoreWorktree(root)).toBe(leakedValue);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("accepts a registered sibling worktree but rejects a copied metadata pointer", async () => {
    const fixture = mkdtempSync(path.join(tmpdir(), "quack-linked-worktree-trust-"));
    const repository = path.join(fixture, "repository");
    const worktree = path.join(fixture, "worktree");
    const fakeCheckout = path.join(fixture, "fake-checkout");
    const shimDirectory = path.join(repository, "mutable-bin");
    mkdirSync(repository);
    const git = resolveTrustedExecutable("git", repository, "test Git");
    const runFixtureGit = (cwd: string, args: string[]): void => {
      execFileSync(git, ["-C", cwd, ...args], {
        cwd: path.dirname(git),
        stdio: "ignore",
      });
    };
    try {
      runFixtureGit(repository, ["init", "-b", "main"]);
      runFixtureGit(repository, ["config", "user.email", "quack@example.invalid"]);
      runFixtureGit(repository, ["config", "user.name", "Quack Test"]);
      writeFileSync(path.join(repository, "tracked.txt"), "seed\n", "utf8");
      runFixtureGit(repository, ["add", "tracked.txt"]);
      runFixtureGit(repository, ["commit", "-m", "seed"]);
      runFixtureGit(repository, ["worktree", "add", "-b", "linked-test", worktree]);

      mkdirSync(shimDirectory);
      const shim = path.join(shimDirectory, process.platform === "win32" ? "git.exe" : "git");
      writeFileSync(shim, "not a Git executable\n", "utf8");
      if (process.platform !== "win32") chmodSync(shim, 0o755);
      const environment: NodeJS.ProcessEnv = {
        ...process.env,
        PATH: [shimDirectory, path.dirname(git)].join(path.delimiter),
      };

      await expect(
        runTrustedGitResult(worktree, ["status", "--short"], {
          timeoutMs: 10_000,
          maxBuffer: 1024 * 1024,
          environment,
        }),
      ).resolves.toMatchObject({ exitCode: 0 });

      mkdirSync(fakeCheckout);
      copyFileSync(path.join(worktree, ".git"), path.join(fakeCheckout, ".git"));
      expect(() =>
        runTrustedGitResult(fakeCheckout, ["status", "--short"], {
          timeoutMs: 10_000,
          maxBuffer: 1024 * 1024,
          environment,
        }),
      ).toThrow("backlink does not identify this checkout");
    } finally {
      rmSync(fixture, { recursive: true, force: true });
    }
  });
});
