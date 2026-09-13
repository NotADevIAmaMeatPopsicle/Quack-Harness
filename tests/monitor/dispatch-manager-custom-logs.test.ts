import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { loadAdapter } from "../../src/core/adapter-loader";
import { resolveRevisionRuntimeContext } from "../../src/dispatcher/revision-preparation";
import { DispatchManager } from "../../src/monitor/dispatch-manager";
import { unlinkNativeWorktreeLinks } from "../../src/monitor/worktree-runtime-directories";

interface WorktreeAccess {
  createWorktree(
    taskId: string,
    options?: { linkRuntimeDirectories?: boolean },
  ): string | undefined;
  unlinkJunctions(worktreePath: string): void;
  prepareNativeRuntimeDirectories(worktreePath: string, reused?: boolean): void;
  removeWorktree(worktreePath: string): boolean;
}

describe("native worktree configured log visibility", () => {
  let fixtureRoot: string;
  const managers: DispatchManager[] = [];

  beforeEach(() => {
    fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-custom-logs-"));
  });

  afterEach(() => {
    for (const manager of managers.splice(0)) manager.killAll();
    // Every shared target in these fixtures is under this disposable root.
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  });

  function git(cwd: string, ...args: string[]): string {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
    }).trim();
  }

  function setup(logSetting: string, ignored = true) {
    const repo = path.join(fixtureRoot, "project");
    const origin = path.join(fixtureRoot, "origin.git");
    fs.mkdirSync(repo);
    git(fixtureRoot, "init", "--bare", origin);
    git(repo, "init", "-b", "dev");
    git(repo, "config", "user.email", "quack@example.test");
    git(repo, "config", "user.name", "Quack Test");
    fs.mkdirSync(path.join(repo, ".quack"));
    const configured =
      logSetting === "absolute-internal"
        ? path.join(repo, "var", "quack", "logs")
        : logSetting === "absolute-external"
          ? path.join(fixtureRoot, "external-logs")
          : logSetting;
    fs.writeFileSync(
      path.join(repo, ".quack", "adapter.json"),
      JSON.stringify({
        version: "1.0",
        project: {
          name: "custom-log-fixture",
          root: ".",
          taskDir: "docs/tasks",
          conventionsDir: "docs/conventions",
        },
        verification: {
          commands: [{ name: "fixture", command: "node --version", required: true, timeout: 30 }],
        },
        git: {
          baseBranch: "dev",
          branchPrefix: "quack/",
          commitFormat: "[{taskId}] {message}",
          commitTrailer: "Implemented-by: Quack",
        },
        dispatch: { worktreeInit: [] },
        logging: { dir: configured },
      }),
    );
    fs.writeFileSync(
      path.join(repo, ".gitignore"),
      [
        ".quack/logs",
        ".quack/prep",
        ".quack/worktrees/",
        ...(ignored ? [".quack/custom-logs", "var/quack/logs"] : []),
      ].join("\n") + "\n",
    );
    fs.writeFileSync(path.join(repo, "tracked.txt"), "fixture\n");
    git(repo, "add", ".");
    git(repo, "commit", "-m", "fixture");
    git(repo, "remote", "add", "origin", origin);
    git(repo, "push", "-u", "origin", "dev");
    const logDir = path.resolve(repo, configured);
    fs.mkdirSync(logDir, { recursive: true });
    const manager = new DispatchManager(
      repo,
      process.execPath,
      undefined,
      undefined,
      logDir,
      undefined,
      [origin],
    );
    managers.push(manager);
    return { repo, origin, logDir, manager, access: manager as unknown as WorktreeAccess };
  }

  test.each([
    ".quack/logs",
    ".quack/custom-logs",
    "var/quack/logs",
    "absolute-internal",
    "absolute-external",
  ])("shares events, approvals and checkpoints for %s", async (setting) => {
    const { repo, logDir, access } = setup(setting);
    const worktree = access.createWorktree("TASK-LOGS");
    expect(worktree).toBeDefined();
    const adapter = await loadAdapter(worktree!);
    const childLogs = path.resolve(adapter.projectRoot, adapter.config.logging.dir);
    fs.mkdirSync(path.join(childLogs, "approvals"), { recursive: true });
    fs.writeFileSync(path.join(childLogs, "events.jsonl"), "event\n");
    fs.writeFileSync(path.join(childLogs, "approvals", "TASK-LOGS.json"), "approval");
    fs.writeFileSync(path.join(childLogs, "checkpoint-TASK-LOGS.json"), "checkpoint");
    expect(fs.readFileSync(path.join(logDir, "events.jsonl"), "utf8")).toBe("event\n");
    const revision = resolveRevisionRuntimeContext(repo, "TASK-LOGS", logDir, worktree);
    expect(fs.readFileSync(path.join(revision.logDir, "approvals", "TASK-LOGS.json"), "utf8")).toBe(
      "approval",
    );
    expect(fs.readFileSync(path.join(revision.logDir, "checkpoint-TASK-LOGS.json"), "utf8")).toBe(
      "checkpoint",
    );
    expect(git(worktree!, "status", "--porcelain")).toBe("");
    access.unlinkJunctions(worktree!);
    git(repo, "worktree", "remove", "--force", worktree!);
    expect(fs.readFileSync(path.join(logDir, "events.jsonl"), "utf8")).toBe("event\n");
  });

  test("Docker creation does not add native runtime links", () => {
    const { access } = setup(".quack/custom-logs");
    const worktree = access.createWorktree("TASK-DOCKER-CONTROL", {
      linkRuntimeDirectories: false,
    });
    expect(worktree).toBeDefined();
    expect(fs.existsSync(path.join(worktree!, ".quack", "custom-logs"))).toBe(false);
    expect(fs.existsSync(path.join(worktree!, ".quack", "logs"))).toBe(false);
    expect(fs.existsSync(path.join(worktree!, ".quack", "prep"))).toBe(false);
  });

  test("refuses a custom log directory visible to Git without a shared fallback", () => {
    const { access, manager } = setup(".quack/custom-logs", false);
    expect(() => access.createWorktree("TASK-UNIGNORED")).toThrow(/must be ignored by Git/);
    expect(manager.getJob("TASK-UNIGNORED")).toBeUndefined();
  });

  test("refuses parent-relative external logs rather than writing a different tree", () => {
    const { access } = setup("../external-logs");
    expect(() => access.createWorktree("TASK-PARENT")).toThrow(/parent-relative external/);
    expect(fs.existsSync(path.join(fixtureRoot, "project", ".quack", "external-logs"))).toBe(false);
  });

  test("reuses a saved binding and restores a missing link after manager restart", () => {
    const { repo, origin, access, logDir } = setup(".quack/custom-logs");
    const worktree = access.createWorktree("TASK-REUSE")!;
    fs.writeFileSync(path.join(logDir, "checkpoint-TASK-REUSE.json"), "preserved");
    fs.unlinkSync(path.join(worktree, ".quack", "custom-logs"));
    const restarted = new DispatchManager(
      repo,
      process.execPath,
      undefined,
      undefined,
      logDir,
      undefined,
      [origin],
    );
    managers.push(restarted);
    (restarted as unknown as WorktreeAccess).prepareNativeRuntimeDirectories(worktree, true);
    expect(
      fs.readFileSync(
        path.join(worktree, ".quack", "custom-logs", "checkpoint-TASK-REUSE.json"),
        "utf8",
      ),
    ).toBe("preserved");
  });

  test("the real reuse dispatch refuses a changed log binding before starting a child", () => {
    const { repo, origin, access, logDir } = setup(".quack/custom-logs");
    const worktree = access.createWorktree("TASK-REUSE")!;
    fs.writeFileSync(path.join(logDir, "preserved.txt"), "original");
    const nextLogs = path.join(repo, "var", "quack", "logs");
    const adapterPath = path.join(repo, ".quack", "adapter.json");
    const changed = JSON.parse(fs.readFileSync(adapterPath, "utf8")) as {
      logging: { dir: string };
    };
    changed.logging.dir = nextLogs;
    fs.writeFileSync(adapterPath, JSON.stringify(changed));
    fs.writeFileSync(path.join(worktree, ".quack", "adapter.json"), JSON.stringify(changed));
    const restarted = new DispatchManager(
      repo,
      process.execPath,
      undefined,
      undefined,
      nextLogs,
      undefined,
      [origin],
    );
    managers.push(restarted);
    expect(() => restarted.start("TASK-REUSE", { reuseWorktree: true })).toThrow(
      /configured log location changed/,
    );
    expect(restarted.getJob("TASK-REUSE")).toBeUndefined();
    expect(fs.readFileSync(path.join(logDir, "preserved.txt"), "utf8")).toBe("original");
    // Cleanup uses actual links, not the new manager's configured path.
    (restarted as unknown as WorktreeAccess).unlinkJunctions(worktree);
    git(repo, "worktree", "remove", "--force", worktree);
    expect(fs.readFileSync(path.join(logDir, "preserved.txt"), "utf8")).toBe("original");
  });

  test.each(["wrong-target", "real-directory", "ancestor-link", "wrong-prep"])(
    "refuses unsafe reused topology: %s",
    (mode) => {
      const { access, logDir } = setup("var/quack/logs");
      const worktree = access.createWorktree("TASK-CONFLICT")!;
      const mirror = path.join(worktree, "var", "quack", "logs");
      const unrelated = path.join(fixtureRoot, "unrelated");
      fs.mkdirSync(unrelated);
      fs.writeFileSync(path.join(unrelated, "sentinel.txt"), "keep");
      if (mode === "wrong-prep") {
        const prep = path.join(worktree, ".quack", "prep");
        if (fs.existsSync(prep)) fs.unlinkSync(prep);
        fs.symlinkSync(unrelated, prep, "junction");
      } else {
        fs.unlinkSync(mirror);
        if (mode === "wrong-target") fs.symlinkSync(unrelated, mirror, "junction");
        if (mode === "real-directory") fs.mkdirSync(mirror);
        if (mode === "ancestor-link") {
          fs.rmdirSync(path.dirname(mirror));
          fs.symlinkSync(unrelated, path.dirname(mirror), "junction");
        }
      }
      expect(() => access.prepareNativeRuntimeDirectories(worktree, true)).toThrow(
        /Unsafe worktree runtime/,
      );
      expect(fs.readFileSync(path.join(unrelated, "sentinel.txt"), "utf8")).toBe("keep");
      expect(fs.existsSync(path.join(unrelated, "logs"))).toBe(false);
      access.unlinkJunctions(worktree);
      expect(fs.existsSync(logDir)).toBe(true);
      expect(fs.readFileSync(path.join(unrelated, "sentinel.txt"), "utf8")).toBe("keep");
    },
  );

  test("cleanup unlinks nested and dangling junctions without visiting their targets", () => {
    const worktree = path.join(fixtureRoot, "worktree");
    const shared = path.join(fixtureRoot, "shared");
    fs.mkdirSync(path.join(worktree, "nested"), { recursive: true });
    fs.mkdirSync(shared);
    fs.writeFileSync(path.join(shared, "sentinel.txt"), "keep");
    fs.symlinkSync(shared, path.join(worktree, "nested", "logs"), "junction");
    fs.symlinkSync(path.join(fixtureRoot, "absent"), path.join(worktree, "dangling"), "junction");
    unlinkNativeWorktreeLinks(worktree);
    fs.rmSync(worktree, { recursive: true });
    expect(fs.readFileSync(path.join(shared, "sentinel.txt"), "utf8")).toBe("keep");
  });

  test("refuses a tracked directory instead of replacing its contents with a log link", () => {
    const { repo, logDir, access } = setup("var/quack/logs");
    fs.writeFileSync(path.join(logDir, "tracked.txt"), "preserve tracked content");
    git(repo, "add", "-f", "var/quack/logs/tracked.txt");
    git(repo, "commit", "-m", "tracked conflict");
    git(repo, "push", "origin", "dev");
    // Tracked content fails the ignore guard before link replacement is attempted.
    expect(() => access.createWorktree("TASK-TRACKED")).toThrow(/must be ignored by Git/);
    expect(
      fs.readFileSync(
        path.join(
          repo,
          ".quack",
          "worktrees",
          "TASK-TRACKED",
          "var",
          "quack",
          "logs",
          "tracked.txt",
        ),
        "utf8",
      ),
    ).toBe("preserve tracked content");
  });

  test("link removal failure prevents Git and recursive filesystem removal", () => {
    const { repo, origin, logDir, access } = setup(".quack/custom-logs");
    const worktree = access.createWorktree("TASK-PRESERVE")!;
    fs.writeFileSync(path.join(logDir, "sentinel.txt"), "keep");
    const manager = new DispatchManager(
      repo,
      process.execPath,
      { method: "worktree", dockerCleanup: false },
      undefined,
      logDir,
      undefined,
      [origin],
    );
    managers.push(manager);
    // Fault injection at the unlink boundary; Git and fixture filesystem remain real.
    const nativeFs = jest.requireActual<typeof import("node:fs")>("node:fs");
    const unlink = jest.spyOn(nativeFs, "unlinkSync").mockImplementationOnce(() => {
      throw new Error("fixture unlink denied");
    });
    try {
      expect((manager as unknown as WorktreeAccess).removeWorktree(worktree)).toBe(false);
      expect(fs.existsSync(path.join(worktree, "tracked.txt"))).toBe(true);
      expect(git(repo, "worktree", "list", "--porcelain")).toContain("TASK-PRESERVE");
      expect(fs.readFileSync(path.join(logDir, "sentinel.txt"), "utf8")).toBe("keep");
    } finally {
      unlink.mockRestore();
    }
  });

  test("refuses a monitor log location different from the loaded adapter", () => {
    const { repo, origin } = setup(".quack/custom-logs");
    const manager = new DispatchManager(
      repo,
      process.execPath,
      undefined,
      undefined,
      path.join(fixtureRoot, "other-monitor-logs"),
      undefined,
      [origin],
    );
    managers.push(manager);
    expect(() => (manager as unknown as WorktreeAccess).createWorktree("TASK-MISMATCH")).toThrow(
      /monitor and adapter log locations disagree/,
    );
    expect(manager.getJob("TASK-MISMATCH")).toBeUndefined();
  });

  test("refuses missing adapter logging even with an external monitor directory", () => {
    const { repo, origin } = setup("absolute-external");
    const adapterPath = path.join(repo, ".quack", "adapter.json");
    const raw = JSON.parse(fs.readFileSync(adapterPath, "utf8")) as Record<string, unknown>;
    delete raw.logging;
    fs.writeFileSync(adapterPath, JSON.stringify(raw));
    const manager = new DispatchManager(
      repo,
      process.execPath,
      undefined,
      undefined,
      path.join(fixtureRoot, "external-logs"),
      undefined,
      [origin],
    );
    managers.push(manager);
    expect(() =>
      (manager as unknown as WorktreeAccess).createWorktree("TASK-MISSING-CONFIG"),
    ).toThrow(/cannot validate adapter logging/);
  });

  test("refuses worktree-local log drift that the shared bundle hash excludes", () => {
    const { access } = setup(".quack/custom-logs");
    const worktree = access.createWorktree("TASK-CHILD-DRIFT")!;
    const adapterPath = path.join(worktree, ".quack", "adapter.json");
    const raw = JSON.parse(fs.readFileSync(adapterPath, "utf8")) as { logging: { dir: string } };
    raw.logging.dir = "var/quack/logs";
    fs.writeFileSync(adapterPath, JSON.stringify(raw));
    expect(() => access.prepareNativeRuntimeDirectories(worktree, true)).toThrow(
      /monitor and adapter log locations disagree/,
    );
  });

  test("refuses an unignored default log directory with the documented migration error", () => {
    const { repo, access } = setup(".quack/logs");
    const ignorePath = path.join(repo, ".gitignore");
    fs.writeFileSync(ignorePath, fs.readFileSync(ignorePath, "utf8").replace(".quack/logs\n", ""));
    git(repo, "add", ".gitignore");
    git(repo, "commit", "-m", "unignored default fixture");
    git(repo, "push", "origin", "dev");
    expect(() => access.createWorktree("TASK-UNIGNORED-DEFAULT")).toThrow(
      /must be ignored by Git before dispatch/,
    );
  });

  test("cleans native links when a Docker selection has no Docker configuration", () => {
    const { repo, origin, logDir } = setup(".quack/custom-logs");
    const manager = new DispatchManager(
      repo,
      process.execPath,
      { method: "docker" },
      undefined,
      logDir,
      undefined,
      [origin],
    );
    managers.push(manager);
    const access = manager as unknown as WorktreeAccess;
    const worktree = access.createWorktree("TASK-NATIVE-FALLBACK")!;
    fs.writeFileSync(path.join(logDir, "sentinel.txt"), "keep");
    access.unlinkJunctions(worktree);
    expect(fs.existsSync(path.join(worktree, ".quack", "custom-logs"))).toBe(false);
    expect(fs.existsSync(`${worktree}.runtime-log.json`)).toBe(false);
    expect(fs.readFileSync(path.join(logDir, "sentinel.txt"), "utf8")).toBe("keep");
  });

  test("refuses an unpropagated host-local log edit before the child can write elsewhere", () => {
    const { repo, origin } = setup(".quack/logs");
    const adapterPath = path.join(repo, ".quack", "adapter.json");
    const raw = JSON.parse(fs.readFileSync(adapterPath, "utf8")) as { logging: { dir: string } };
    raw.logging.dir = ".quack/custom-logs";
    fs.writeFileSync(adapterPath, JSON.stringify(raw));
    const manager = new DispatchManager(
      repo,
      process.execPath,
      undefined,
      undefined,
      path.join(repo, ".quack", "custom-logs"),
      undefined,
      [origin],
    );
    managers.push(manager);
    expect(() =>
      (manager as unknown as WorktreeAccess).createWorktree("TASK-LOCAL-CONFIG"),
    ).toThrow(/monitor and adapter log locations disagree/);
    expect(manager.getJob("TASK-LOCAL-CONFIG")).toBeUndefined();
  });

  test.each(["native-origin", "docker-origin", "invalid-receipt"])(
    "a Docker-configured manager preserves cleanup boundaries for %s",
    (originKind) => {
      const { repo, origin, logDir, access } = setup("var/quack/logs");
      const worktree = access.createWorktree("TASK-METHOD-CHANGE", {
        linkRuntimeDirectories: originKind !== "docker-origin",
      })!;
      const mirror = path.join(worktree, "var", "quack", "logs");
      const receipt = `${worktree}.runtime-log.json`;
      fs.writeFileSync(path.join(logDir, "sentinel.txt"), "keep");
      if (originKind === "docker-origin") {
        fs.mkdirSync(path.dirname(mirror), { recursive: true });
        fs.symlinkSync(logDir, mirror, "junction");
      } else if (originKind === "invalid-receipt") {
        fs.writeFileSync(receipt, JSON.stringify({ worktreePath: repo, logDir }));
      }
      const manager = new DispatchManager(
        repo,
        process.execPath,
        {
          method: "docker",
          docker: {
            image: "quack-test:fixture",
            volumes: [],
            envPassthrough: [],
            resourceLimits: { memoryMb: 512, cpus: 1 },
            networkMode: "none",
            cleanupPolicy: "remove",
          },
        },
        undefined,
        path.join(repo, ".quack", "logs"),
        undefined,
        [origin],
      );
      managers.push(manager);
      const cleanup = () => (manager as unknown as WorktreeAccess).unlinkJunctions(worktree);
      if (originKind === "invalid-receipt") {
        expect(cleanup).toThrow(/invalid log binding receipt/);
        expect(fs.existsSync(receipt)).toBe(true);
        expect(fs.lstatSync(mirror).isSymbolicLink()).toBe(true);
      } else {
        cleanup();
        // A Docker-origin tree does not grant the native recursive link sweep.
        expect(fs.existsSync(mirror)).toBe(originKind === "docker-origin");
        expect(fs.existsSync(receipt)).toBe(false);
      }
      expect(fs.readFileSync(path.join(logDir, "sentinel.txt"), "utf8")).toBe("keep");
    },
  );
});
