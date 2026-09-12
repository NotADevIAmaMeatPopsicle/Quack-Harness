import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import { afterEach, beforeEach, describe, expect, test } from "@jest/globals";

import { runTrustedGitSync } from "../../src/dispatcher/trusted-git.js";
import {
  directGitTransportTarget,
  isSupportedNetworkGitUrl,
  resolveTrustedExecutable,
} from "../../src/worker/trusted-executable.js";

const HOST_GIT = resolveTrustedExecutable("git", path.resolve(__dirname, "..", ".."), "test Git");

function fixtureGit(cwd: string, args: readonly string[]): string {
  return execFileSync(HOST_GIT, ["-C", cwd, ...args], {
    cwd: path.dirname(HOST_GIT),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

describe("trusted dispatcher git", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fsPromises.mkdtemp(path.join(os.tmpdir(), "quack-trusted-git-test-"));
  });

  afterEach(async () => {
    await fsPromises.rm(tmpDir, { recursive: true, force: true });
  });

  test("does not execute a cwd-local git shadow binary", async () => {
    const marker = path.join(tmpDir, "shadow-ran.txt");
    if (process.platform === "win32") {
      await fsPromises.writeFile(
        path.join(tmpDir, "git.cmd"),
        `@echo shadow>"${marker}"\r\n`,
        "utf8",
      );
      await fsPromises.writeFile(path.join(tmpDir, "git.exe"), "not an executable", "utf8");
    } else {
      const shadow = path.join(tmpDir, "git");
      await fsPromises.writeFile(shadow, `#!/bin/sh\necho shadow > '${marker}'\n`, "utf8");
      await fsPromises.chmod(shadow, 0o755);
    }

    const output = runTrustedGitSync(["--version"], tmpDir);

    expect(output).toMatch(/^git version /);
    expect(fs.existsSync(marker)).toBe(false);
  });

  test("disables repository hooks with the operating-system null device", async () => {
    runTrustedGitSync(["init"], tmpDir);
    expect(runTrustedGitSync(["rev-parse", "--is-inside-work-tree"], tmpDir).trim()).toBe("true");
    const marker = path.join(tmpDir, "hook-ran.txt");
    const hookPath = path.join(tmpDir, ".git", "hooks", "pre-commit");
    const portableMarker = marker.replace(/\\/g, "/").replace(/'/g, "'\\''");
    await fsPromises.writeFile(
      hookPath,
      `#!/bin/sh\nprintf unsafe > '${portableMarker}'\n`,
      "utf8",
    );
    await fsPromises.chmod(hookPath, 0o755);
    await fsPromises.writeFile(path.join(tmpDir, "tracked.txt"), "safe\n", "utf8");

    runTrustedGitSync(["add", "--", "tracked.txt"], tmpDir);
    runTrustedGitSync(
      [
        "-c",
        "user.name=Quack Test",
        "-c",
        "user.email=quack@example.invalid",
        "commit",
        "-m",
        "trusted commit",
      ],
      tmpDir,
    );

    expect(fs.existsSync(marker)).toBe(false);
  });

  test("fails closed on repository config that can execute or redirect host Git", async () => {
    const vectors: Array<{ key: string; operation: string; args: string[] }> = [
      { key: "filter.quack.clean", operation: "add", args: ["add", "--", "tracked.txt"] },
      { key: "filter.quack.process", operation: "add", args: ["add", "--", "tracked.txt"] },
      { key: "diff.external", operation: "diff", args: ["diff", "HEAD"] },
      { key: "diff.quack.textconv", operation: "diff", args: ["diff", "HEAD"] },
      { key: "core.sshCommand", operation: "fetch", args: ["fetch", "origin"] },
      { key: "core.fsmonitor", operation: "diff", args: ["diff", "HEAD"] },
      { key: "gpg.program", operation: "commit", args: ["commit", "-m", "unsafe"] },
      { key: "credential.helper", operation: "fetch", args: ["fetch", "origin"] },
      { key: "remote.origin.proxy", operation: "fetch", args: ["fetch", "origin"] },
      { key: "core.worktree", operation: "add", args: ["add", "--", "tracked.txt"] },
      { key: "include.path", operation: "fetch", args: ["fetch", "origin"] },
    ];

    for (const [index, vector] of vectors.entries()) {
      const root = path.join(tmpDir, `repo-${index}`);
      const marker = path.join(root, "host-helper-ran.txt");
      await fsPromises.mkdir(root);
      fixtureGit(root, ["init", "-b", "main"]);
      fixtureGit(root, ["config", "user.name", "Quack Test"]);
      fixtureGit(root, ["config", "user.email", "quack@example.invalid"]);
      await fsPromises.writeFile(path.join(root, "tracked.txt"), "safe\n", "utf8");
      await fsPromises.writeFile(
        path.join(root, ".gitattributes"),
        "*.txt filter=quack diff=quack\n",
        "utf8",
      );
      fixtureGit(root, ["add", "tracked.txt", ".gitattributes"]);
      fixtureGit(root, ["commit", "-m", "seed"]);

      const helperScript = path.join(root, "host-helper.cjs");
      await fsPromises.writeFile(
        helperScript,
        `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "unsafe"); process.exit(1);\n`,
        "utf8",
      );
      const helperCommand = `"${process.execPath}" "${helperScript}"`;
      const value =
        vector.key === "core.worktree"
          ? path.join(root, "redirected-worktree")
          : vector.key === "include.path"
            ? helperScript
            : helperCommand;
      fixtureGit(root, ["config", "--local", vector.key, value]);
      await fsPromises.writeFile(path.join(root, "tracked.txt"), "changed\n", "utf8");

      expect(() => runTrustedGitSync(vector.args, root)).toThrow(
        new RegExp(`unsafe Git configuration key "${vector.key}"`, "i"),
      );
      expect(fs.existsSync(marker)).toBe(false);
    }
  });

  test("refuses repository-selected local transports before remote hooks can execute", async () => {
    const project = path.join(tmpDir, "project");
    const remote = path.join(project, "attacker-controlled.git");
    const marker = path.join(project, "receive-hook-ran.txt");
    await fsPromises.mkdir(project);
    fixtureGit(project, ["init", "-b", "main"]);
    fixtureGit(project, ["config", "user.name", "Quack Test"]);
    fixtureGit(project, ["config", "user.email", "quack@example.invalid"]);
    await fsPromises.writeFile(path.join(project, "tracked.txt"), "safe\n", "utf8");
    fixtureGit(project, ["add", "tracked.txt"]);
    fixtureGit(project, ["commit", "-m", "seed"]);
    fixtureGit(project, ["init", "--bare", remote]);
    fixtureGit(project, ["remote", "add", "origin", remote]);

    const portableMarker = marker.replace(/\\/g, "/").replace(/'/g, "'\\''");
    const receiveHook = path.join(remote, "hooks", "pre-receive");
    await fsPromises.writeFile(
      receiveHook,
      `#!/bin/sh\nprintf unsafe > '${portableMarker}'\n`,
      "utf8",
    );
    await fsPromises.chmod(receiveHook, 0o755);

    for (const args of [
      ["fetch", "origin"],
      ["push", "origin", "main"],
    ]) {
      expect(() => runTrustedGitSync(args, project)).toThrow(
        /Refusing local or helper-backed Git transport URL/iu,
      );
    }
    expect(fs.existsSync(marker)).toBe(false);
  });

  test.each([
    "https://github.com/example/repository.git",
    "ssh://git@github.com/example/repository.git",
    "git+ssh://git@github.com/example/repository.git",
    "ssh+git://git@github.com/example/repository.git",
    "git@github.com:example/repository.git",
  ])("allows standard network transport policy for %s", (remoteUrl) => {
    expect(isSupportedNetworkGitUrl(remoteUrl)).toBe(true);
  });

  test("parses common option-bearing network transport forms", () => {
    expect(directGitTransportTarget(["fetch", "--depth", "1", "origin"])).toBe("origin");
    expect(
      directGitTransportTarget([
        "clone",
        "--branch",
        "main",
        "https://github.com/example/repository.git",
      ]),
    ).toBe("https://github.com/example/repository.git");
    expect(
      directGitTransportTarget([
        "clone",
        "-c",
        "advice.detachedHead=false",
        "ssh://git@github.com/example/repository.git",
      ]),
    ).toBe("ssh://git@github.com/example/repository.git");
    expect(directGitTransportTarget(["push", "-u", "origin", "main"])).toBe("origin");
  });

  test.each([
    ["clone", path.join("C:\\", "attacker", "repository.git"), "clone-target"],
    ["fetch", "file:///attacker/repository.git"],
    ["push", "../attacker-controlled.git", "HEAD"],
    ["fetch", "ext::attacker-helper"],
    ["fetch", "foo::attacker-helper"],
    ["fetch", "C:relative.git"],
  ])("refuses direct local transport arguments: git %s", (...args) => {
    expect(() => runTrustedGitSync(args, tmpDir)).toThrow(
      /Refusing local or helper-backed Git transport (?:target|URL)/iu,
    );
  });

  test.each(["-s", "--shared"])("rejects clone shared-object option %s", (sharedOption) => {
    expect(() =>
      runTrustedGitSync(
        ["clone", sharedOption, path.join(tmpDir, "attacker.git"), "clone-target"],
        tmpDir,
      ),
    ).toThrow(new RegExp(`unsafe trusted Git argument: ${sharedOption}`, "i"));
  });

  test.each([
    ["--config", "core.hooksPath=attacker-hooks"],
    ["--config=filter.payload.process=attacker-helper"],
    ["--config", "fetch.bundleURI=file:///attacker/repository.bundle"],
  ])("rejects unsafe clone configuration form %s", (...cloneConfig) => {
    expect(() =>
      runTrustedGitSync(
        ["clone", ...cloneConfig, "https://github.com/example/repository.git", "clone-target"],
        tmpDir,
      ),
    ).toThrow(/unsafe Git configuration key/iu);
  });

  test.each([
    ["--bundle-uri", "file:///attacker/repository.bundle"],
    ["--bundle-uri=https://example.invalid/repository.bundle"],
  ])("rejects clone auxiliary transport option %s", (...bundleOption) => {
    expect(() =>
      runTrustedGitSync(
        ["clone", ...bundleOption, "https://github.com/example/repository.git", "clone-target"],
        tmpDir,
      ),
    ).toThrow(/unsafe trusted Git argument: --bundle-uri/iu);
  });

  test.each([
    ["fetch.bundleURI", "file:///attacker/repository.bundle"],
    ["transfer.bundleURI", "file:///attacker/repository.bundle"],
    ["bundle.payload.uri", "file:///attacker/repository.bundle"],
    ["remote.origin.promisor", "true"],
    ["remote.origin.partialCloneFilter", "blob:none"],
    ["extensions.partialClone", "origin"],
  ])("rejects auxiliary transport configuration %s", (key, value) => {
    fixtureGit(tmpDir, ["init", "-b", "main"]);
    fixtureGit(tmpDir, ["remote", "add", "origin", "https://example.invalid/repository.git"]);
    fixtureGit(tmpDir, ["config", "--local", key, value]);

    expect(() => runTrustedGitSync(["fetch", "--dry-run", "origin"], tmpDir)).toThrow(
      new RegExp(
        `unsafe Git configuration key "${key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"`,
        "i",
      ),
    );
  });

  test("allows only an audited operator-listed bare repository for local read transports", async () => {
    const origin = path.join(tmpDir, "origin.git");
    const otherOrigin = path.join(tmpDir, "other-origin.git");
    const project = path.join(tmpDir, "project");
    const cloneParent = path.join(tmpDir, "clone-parent");
    await fsPromises.mkdir(project);
    await fsPromises.mkdir(cloneParent);
    fixtureGit(tmpDir, ["init", "--bare", origin]);
    fixtureGit(tmpDir, ["init", "--bare", otherOrigin]);
    fixtureGit(project, ["init", "-b", "main"]);
    fixtureGit(project, ["config", "user.name", "Quack Test"]);
    fixtureGit(project, ["config", "user.email", "quack@example.invalid"]);
    await fsPromises.writeFile(path.join(project, "tracked.txt"), "seed\n", "utf8");
    fixtureGit(project, ["add", "tracked.txt"]);
    fixtureGit(project, ["commit", "-m", "seed"]);
    fixtureGit(project, ["remote", "add", "origin", origin]);
    fixtureGit(project, ["push", "origin", "main"]);

    const trustedOptions = { trustedLocalReadRemotePaths: [origin] };
    fixtureGit(project, ["update-ref", "-d", "refs/remotes/origin/main"]);
    runTrustedGitSync(["fetch", "origin"], project, trustedOptions);
    expect(fixtureGit(project, ["rev-parse", "refs/remotes/origin/main"])).toBe(
      fixtureGit(project, ["rev-parse", "refs/heads/main"]),
    );
    expect(
      runTrustedGitSync(
        ["fetch", "origin", "main:refs/remotes/origin/allowlisted-main"],
        project,
        trustedOptions,
      ),
    ).toBe("");
    expect(
      runTrustedGitSync(["ls-remote", "origin", "refs/heads/main"], project, trustedOptions),
    ).toMatch(/refs\/heads\/main/u);
    runTrustedGitSync(["clone", "--branch", "main", origin, "clone"], cloneParent, trustedOptions);
    expect(fs.existsSync(path.join(cloneParent, "clone", "tracked.txt"))).toBe(true);

    expect(() => runTrustedGitSync(["push", "origin", "main"], project, trustedOptions)).toThrow(
      /Refusing local or helper-backed Git transport URL/iu,
    );
    expect(() =>
      runTrustedGitSync(["clone", otherOrigin, "other-clone"], cloneParent, trustedOptions),
    ).toThrow(/Refusing non-allowlisted local Git read transport/iu);
  });

  test("audits an allowlisted bare remote before starting upload-pack", async () => {
    const origin = path.join(tmpDir, "origin.git");
    const project = path.join(tmpDir, "project");
    await fsPromises.mkdir(project);
    fixtureGit(tmpDir, ["init", "--bare", origin]);
    fixtureGit(project, ["init", "-b", "main"]);
    fixtureGit(project, ["remote", "add", "origin", origin]);
    fixtureGit(origin, ["config", "uploadpack.packObjectsHook", "attacker-helper"]);

    expect(() =>
      runTrustedGitSync(["fetch", "origin"], project, {
        trustedLocalReadRemotePaths: [origin],
      }),
    ).toThrow(/unsafe Git configuration key "uploadpack\.packObjectsHook"/iu);
  });

  test("refuses a local submodule URL before submodule update starts", () => {
    const localSubmodule = path.join(tmpDir, "attacker-submodule.git");
    fixtureGit(tmpDir, ["init", "-b", "main"]);
    fixtureGit(tmpDir, ["config", "--file", ".gitmodules", "submodule.payload.path", "payload"]);
    fixtureGit(tmpDir, [
      "config",
      "--file",
      ".gitmodules",
      "submodule.payload.url",
      localSubmodule,
    ]);

    expect(() => runTrustedGitSync(["submodule", "update", "--init"], tmpDir)).toThrow(
      /Refusing local or helper-backed Git transport URL in "submodule\.payload\.url"/iu,
    );
  });

  test("skips an authoritative-project PATH shim for add commit diff and fetch in a worktree", async () => {
    const origin = path.join(tmpDir, "origin.git");
    const project = path.join(tmpDir, "project");
    const worktree = path.join(project, ".quack", "worktrees", "TASK-PATH-SHIM");
    const shimDirectory = path.join(project, "mutable-bin");
    const shim = path.join(shimDirectory, process.platform === "win32" ? "git.exe" : "git");
    await fsPromises.mkdir(project);
    fixtureGit(tmpDir, ["init", "--bare", origin]);
    fixtureGit(project, ["init", "-b", "main"]);
    fixtureGit(project, ["config", "user.name", "Quack Test"]);
    fixtureGit(project, ["config", "user.email", "quack@example.invalid"]);
    await fsPromises.writeFile(path.join(project, "tracked.txt"), "seed\n", "utf8");
    fixtureGit(project, ["add", "tracked.txt"]);
    fixtureGit(project, ["commit", "-m", "seed"]);
    fixtureGit(project, ["remote", "add", "origin", origin]);
    fixtureGit(project, ["push", "-u", "origin", "main"]);
    await fsPromises.mkdir(path.dirname(worktree), { recursive: true });
    fixtureGit(project, ["worktree", "add", "-b", "quack/TASK-PATH-SHIM", worktree, "main"]);
    await fsPromises.mkdir(shimDirectory);
    await fsPromises.writeFile(shim, "this is not a Git executable\n", "utf8");
    if (process.platform !== "win32") await fsPromises.chmod(shim, 0o755);

    const environment: NodeJS.ProcessEnv = {
      ...process.env,
      PATH: [shimDirectory, path.dirname(HOST_GIT)].join(path.delimiter),
    };
    expect(resolveTrustedExecutable("git", worktree, "test Git", environment, project)).toBe(
      fs.realpathSync.native(HOST_GIT),
    );

    await fsPromises.writeFile(path.join(worktree, "tracked.txt"), "changed\n", "utf8");
    const options = {
      timeoutMs: 10_000,
      maxBuffer: 1024 * 1024,
      environment,
      // A legacy caller may still pass the immediate worktree. The trusted
      // launcher must widen this to the inferred authoritative project root.
      trustedBoundaryRoot: worktree,
    };
    expect(runTrustedGitSync(["add", "--", "tracked.txt"], worktree, options)).toBe("");
    expect(
      runTrustedGitSync(
        [
          "-c",
          "user.name=Quack Test",
          "-c",
          "user.email=quack@example.invalid",
          "commit",
          "-m",
          "trusted worktree commit",
        ],
        worktree,
        options,
      ),
    ).toContain("trusted worktree commit");
    expect(runTrustedGitSync(["diff", "HEAD^..HEAD"], worktree, options)).toContain("+changed");
    fixtureGit(project, ["remote", "set-url", "origin", "https://127.0.0.1:1/origin.git"]);
    expect(() =>
      runTrustedGitSync(["fetch", "origin"], worktree, { ...options, timeoutMs: 2_000 }),
    ).toThrow();
  });
});
