/* eslint-disable @typescript-eslint/no-require-imports */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { DockerResumeSourceBinding } from "../../src/dispatcher/docker-runtime-bridge";
import { findDockerPublicationRecovery } from "../../src/dispatcher/docker-publication-recovery";

const execFileCalls: Array<{
  file: string;
  args: readonly string[];
  rawArgs: readonly string[];
  cwd?: string;
  env?: NodeJS.ProcessEnv;
}> = [];
let pushFailure: Error | undefined;
const recoveryPreparedRefs = new Map<string, string>();
const recoveryLockRefs = new Map<string, string>();
const recoveryLockObjects = new Map<string, string>();
let recoveryLockObjectCounter = 0;
let recoveryLockReleaseFailures = 0;
let recoveryLockDeleteThenFail = 0;
let recoveryLockInstallThenFail = 0;
let recoveryLockConfirmationReadFailures = 0;
let recoveryLockReplacementOnRelease: string | undefined;
let durableMoveAfterRenameFailures = 0;
let recoveryGit:
  | { base: string; candidate: string; current: string; sealed?: string; remote?: string }
  | undefined;
const ORIGIN_PUSH_URL = "https://github.com/org/repo.git";
let currentOriginPushUrl = ORIGIN_PUSH_URL;
const ORIGIN_BINDING = {
  pushUrlHash: createHash("sha256").update(ORIGIN_PUSH_URL).digest("hex"),
  github: {
    selector: "github.com/org/repo",
    host: "github.com",
    nameWithOwner: "org/repo",
  },
};

jest.mock("node:child_process", () => {
  const actualFs = jest.requireActual<typeof import("node:fs")>("node:fs");
  const mockExecFile = jest.fn();
  const mockExecFileSync = jest.fn(
    (file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }): Buffer => {
      if (!file.toLowerCase().endsWith("powershell.exe")) {
        throw new Error(`unexpected synchronous command ${file}`);
      }
      const source = options.env?.QUACK_DURABLE_SOURCE;
      const target = options.env?.QUACK_DURABLE_TARGET;
      const replace = options.env?.QUACK_DURABLE_REPLACE === "1";
      if (!source || !target) throw new Error("missing durable move identity");
      if (!replace && actualFs.existsSync(target)) {
        throw Object.assign(new Error("target exists"), { code: "EEXIST" });
      }
      if (replace) actualFs.rmSync(target, { force: true });
      actualFs.renameSync(source, target);
      if (durableMoveAfterRenameFailures > 0) {
        durableMoveAfterRenameFailures -= 1;
        throw Object.assign(new Error("simulated post-rename durability failure"), {
          code: "EIO",
        });
      }
      return Buffer.alloc(0);
    },
  );
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
    args: readonly string[],
    options: { cwd?: string; env?: NodeJS.ProcessEnv },
  ): Promise<{ stdout: string; stderr: string }> => {
    const rawArgs = args;
    execFileCalls.push({ file, args, rawArgs, cwd: options.cwd, env: options.env });
    if (file.toLowerCase().endsWith("powershell.exe")) {
      return Promise.resolve({ stdout: "638930000000000000", stderr: "" });
    }
    if (file === "git" && args[0] === "remote" && args[1] === "get-url") {
      return Promise.resolve({ stdout: `${currentOriginPushUrl}\n`, stderr: "" });
    }
    if (file === "git" && recoveryGit) {
      if (args[0] === "hash-object") {
        recoveryLockObjectCounter += 1;
        const objectId = recoveryLockObjectCounter.toString(16).padStart(40, "0");
        recoveryLockObjects.set(objectId, actualFs.readFileSync(String(args.at(-1)), "utf-8"));
        return Promise.resolve({ stdout: `${objectId}\n`, stderr: "" });
      }
      if (args[0] === "cat-file" && args[1] === "blob") {
        const value = recoveryLockObjects.get(String(args[2]));
        return value === undefined
          ? Promise.reject(Object.assign(new Error("missing object"), { code: 128 }))
          : Promise.resolve({ stdout: value, stderr: "" });
      }
      if (args[0] === "rev-parse") {
        const ref = args.at(-1);
        const exactRef = String(ref).replace(/\^\{commit\}$/u, "");
        if (exactRef.startsWith("refs/quack/docker-publication-lock/")) {
          const lockObject = recoveryLockRefs.get(exactRef);
          if (lockObject && recoveryLockConfirmationReadFailures > 0) {
            recoveryLockConfirmationReadFailures -= 1;
            return Promise.reject(
              Object.assign(new Error("transient lock confirmation failure"), { code: 128 }),
            );
          }
          return lockObject
            ? Promise.resolve({ stdout: `${lockObject}\n`, stderr: "" })
            : Promise.reject(Object.assign(new Error("missing ref"), { code: 1 }));
        }
        if (exactRef.startsWith("refs/quack/docker-publication-prepared/")) {
          const preparedHead = recoveryPreparedRefs.get(exactRef);
          return preparedHead
            ? Promise.resolve({ stdout: `${preparedHead}\n`, stderr: "" })
            : Promise.reject(Object.assign(new Error("missing ref"), { code: 1 }));
        }
        if (/^[a-f0-9]{40,64}$/iu.test(exactRef)) {
          return Promise.resolve({ stdout: `${exactRef}\n`, stderr: "" });
        }
        const stdout = exactRef.startsWith("refs/quack/docker-publication/")
          ? recoveryGit.sealed
          : recoveryGit.current;
        if (!stdout) {
          return Promise.reject(Object.assign(new Error("missing ref"), { code: 1 }));
        }
        return Promise.resolve({ stdout: `${stdout}\n`, stderr: "" });
      }
      if (args[0] === "show-ref") {
        const exactRef = String(args.at(-1));
        if (exactRef.startsWith("refs/quack/docker-publication-lock/")) {
          const lockObject = recoveryLockRefs.get(exactRef);
          return lockObject
            ? Promise.resolve({ stdout: `${lockObject}\n`, stderr: "" })
            : Promise.reject(Object.assign(new Error("missing ref"), { code: 1 }));
        }
        if (exactRef.startsWith("refs/quack/docker-publication-prepared/")) {
          const preparedHead = recoveryPreparedRefs.get(exactRef);
          return preparedHead
            ? Promise.resolve({ stdout: `${preparedHead}\n`, stderr: "" })
            : Promise.reject(Object.assign(new Error("missing ref"), { code: 1 }));
        }
        if (recoveryGit.current) {
          return Promise.resolve({ stdout: `${recoveryGit.current}\n`, stderr: "" });
        }
        return Promise.reject(Object.assign(new Error("missing ref"), { code: 1 }));
      }
      if (args[0] === "update-ref") {
        const exactRef = args[1] === "-d" ? String(args[2]) : String(args[1]);
        if (exactRef.startsWith("refs/quack/docker-publication-lock/")) {
          const deleting = args[1] === "-d";
          const next = deleting ? undefined : String(args[2]);
          const expected = String(args[3]);
          const current = recoveryLockRefs.get(exactRef);
          const expectedMissing = /^0+$/u.test(expected);
          if (
            (expectedMissing && current !== undefined) ||
            (!expectedMissing && current !== expected)
          ) {
            return Promise.reject(
              Object.assign(new Error("compare-and-swap failed"), { code: 128 }),
            );
          }
          if (deleting && recoveryLockReleaseFailures > 0) {
            recoveryLockReleaseFailures -= 1;
            return Promise.reject(
              Object.assign(new Error("transient lock release failure"), { code: 128 }),
            );
          }
          if (deleting && recoveryLockDeleteThenFail > 0) {
            recoveryLockDeleteThenFail -= 1;
            recoveryLockRefs.delete(exactRef);
            return Promise.reject(
              Object.assign(new Error("ambiguous lock release result"), { code: 128 }),
            );
          }
          if (!deleting && recoveryLockInstallThenFail > 0) {
            recoveryLockInstallThenFail -= 1;
            recoveryLockRefs.set(exactRef, next!);
            return Promise.reject(
              Object.assign(new Error("ambiguous lock acquisition result"), { code: 128 }),
            );
          }
          if (deleting) {
            recoveryLockRefs.delete(exactRef);
            if (recoveryLockReplacementOnRelease) {
              recoveryLockRefs.set(exactRef, recoveryLockReplacementOnRelease);
            }
          } else recoveryLockRefs.set(exactRef, next!);
          return Promise.resolve({ stdout: "", stderr: "" });
        }
        if (exactRef.startsWith("refs/quack/docker-publication-prepared/")) {
          if (args[1] === "-d") recoveryPreparedRefs.delete(exactRef);
          else recoveryPreparedRefs.set(exactRef, String(args[2]));
          return Promise.resolve({ stdout: "", stderr: "" });
        }
        if (exactRef.startsWith("refs/quack/docker-publication/")) {
          if (args[1] === "-d") recoveryGit.sealed = undefined;
          else recoveryGit.sealed = String(args[2]);
          return Promise.resolve({ stdout: "", stderr: "" });
        }
        recoveryGit.current = String(args[2]);
        return Promise.resolve({ stdout: "", stderr: "" });
      }
      if (args[0] === "merge-base") return Promise.resolve({ stdout: "", stderr: "" });
      if (args[0] === "ls-remote") {
        return Promise.resolve({
          stdout: recoveryGit.remote
            ? `${recoveryGit.remote}\trefs/heads/${String(args.at(-1)).replace("refs/heads/", "")}\n`
            : "",
          stderr: "",
        });
      }
      if (args[0] === "push") {
        if (pushFailure) return Promise.reject(pushFailure);
        const deletesBranch =
          args.includes("--delete") || args.some((argument) => argument.startsWith(":refs/heads/"));
        recoveryGit.remote = deletesBranch ? undefined : recoveryGit.candidate;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
    }
    return pushFailure && args[0] === "push"
      ? Promise.reject(pushFailure)
      : Promise.resolve({ stdout: "", stderr: "" });
  };
  return { execFile: mockExecFile, execFileSync: mockExecFileSync };
});

const loadAdapter = jest.fn();
jest.mock("../../src/core/adapter-loader", () => ({ loadAdapter }));

const resolveTaskFile = jest.fn();
jest.mock("../../src/core/task-file-resolver", () => ({ resolveTaskFile }));

const buildBranchName = jest.fn((taskId: string) => `quack/${taskId}`);
const deleteAfterMerge = jest.fn();
const mergeBranchToTarget = jest.fn();
const updateTaskFileStatus = jest.fn();
jest.mock("../../src/dispatcher/branch-manager", () => ({
  buildBranchName,
  deleteAfterMerge,
  mergeBranchToTarget,
  updateTaskFileStatus,
}));

const createPullRequest = jest.fn();
jest.mock("../../src/dispatcher/pr-creator", () => ({ createPullRequest }));

const {
  publishDockerPromotedResult,
  initializeDockerPublicationRecovery,
  readDockerPublicationRecovery,
  resumeDockerPromotedResult,
  withDockerPublicationRecoveryLock,
} =
  require("../../src/dispatcher/docker-host-publication") as typeof import("../../src/dispatcher/docker-host-publication");

function adapter(overrides: Record<string, unknown> = {}): ProjectAdapter {
  return {
    projectRoot: "/trusted/project",
    config: {
      project: { name: "fixture", root: ".", taskDir: "docs/tasks", conventionsDir: "docs" },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "",
        autoPush: true,
        autoCreatePr: true,
        autoMerge: true,
        ...overrides,
      },
    },
  } as ProjectAdapter;
}

function resolvedTask(successCriteria: string[] = ["implementation works"]) {
  return {
    filePath: "/trusted/project/docs/tasks/TASK.md",
    content: "# Task\n\n## Success Criteria\n- [ ] implementation works\n",
    duplicateClaimants: [],
    task: { title: "Fixture task", successCriteria },
  };
}

function durablePublication(
  taskId: string,
  branch = `quack/${taskId}`,
): {
  root: string;
  recoveryRoot: string;
  options: {
    recovery: {
      rootDir: string;
      publicationId: string;
      gitState: {
        authoritativeRef: string;
        baseHead: string;
        candidateHead: string;
        sealedRef: string;
      };
      worktreePath: string;
      worktreeSessionId: string;
      worktreeOwnershipId: string;
      preserveWorktree: boolean;
      sourceResume?: DockerResumeSourceBinding;
    };
  };
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-publish-"));
  const worktreePath = path.join(root, "worktree");
  const recoveryRoot = path.join(root, ".quack", "logs", "docker-publications");
  fs.mkdirSync(worktreePath, { recursive: true });
  const base = "a".repeat(40);
  const candidate = "b".repeat(40);
  const publicationId = randomUUID();
  recoveryGit = { base, candidate, current: base, sealed: candidate };
  loadAdapter.mockResolvedValue({ ...adapter(), projectRoot: root });
  return {
    root,
    recoveryRoot,
    options: {
      recovery: {
        rootDir: recoveryRoot,
        publicationId,
        gitState: {
          authoritativeRef: `refs/heads/${branch}`,
          baseHead: base,
          candidateHead: candidate,
          sealedRef: `refs/quack/docker-publication/${taskId}/${publicationId}`,
        },
        worktreePath,
        worktreeSessionId: `quack-${taskId}-${randomUUID()}`,
        worktreeOwnershipId: publicationId,
        preserveWorktree: false,
      },
    },
  };
}

function initialJournalFixture(
  fixture: ReturnType<typeof durablePublication>,
  taskId = "TASK-101",
  timestamp = "2020-01-01T00:00:00.000Z",
): { recoveryPath: string; bytes: Buffer } {
  const recovery = fixture.options.recovery;
  const journal = {
    version: 1,
    publicationId: recovery.publicationId,
    taskId,
    projectRoot: fs.realpathSync.native(fixture.root),
    branch: `quack/${taskId}`,
    targetBranch: "main",
    repository: ORIGIN_BINDING,
    gitState: recovery.gitState,
    worktreePath: fs.realpathSync.native(recovery.worktreePath),
    worktreeSessionId: recovery.worktreeSessionId,
    worktreeOwnershipId: recovery.worktreeOwnershipId,
    preserveWorktree: recovery.preserveWorktree,
    requirements: { push: true, pullRequest: true, merge: true, status: true, cleanup: true },
    progress: {},
    state: "pending",
    generation: 0,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
  return {
    recoveryPath: path.join(fixture.recoveryRoot, `${taskId}-${recovery.publicationId}.json`),
    bytes: Buffer.from(`${JSON.stringify(journal, null, 2)}\n`, "utf-8"),
  };
}

describe("Docker host publication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    execFileCalls.splice(0);
    pushFailure = undefined;
    recoveryPreparedRefs.clear();
    recoveryLockRefs.clear();
    recoveryLockObjects.clear();
    recoveryLockObjectCounter = 0;
    recoveryLockReleaseFailures = 0;
    recoveryLockDeleteThenFail = 0;
    recoveryLockInstallThenFail = 0;
    recoveryLockConfirmationReadFailures = 0;
    recoveryLockReplacementOnRelease = undefined;
    durableMoveAfterRenameFailures = 0;
    currentOriginPushUrl = ORIGIN_PUSH_URL;
    recoveryGit = undefined;
    loadAdapter.mockResolvedValue(adapter());
    resolveTaskFile.mockResolvedValue(resolvedTask());
    createPullRequest.mockResolvedValue({
      success: true,
      prUrl: "https://example.test/pull/1",
    });
    mergeBranchToTarget.mockResolvedValue({ success: true, mergeCommitSha: "c".repeat(40) });
    updateTaskFileStatus.mockResolvedValue({ success: true });
    deleteAfterMerge.mockResolvedValue({ deleted: true });
  });

  test("publishes a normal promoted branch from the trusted host", async () => {
    const fixture = durablePublication("TASK-101");
    const result = await publishDockerPromotedResult(
      "TASK-101",
      fixture.root,
      "quack/TASK-101",
      fixture.options,
    );

    expect(execFileCalls.some((call) => call.args[0] === "update-ref")).toBe(true);
    expect(execFileCalls.some((call) => call.args[0] === "push")).toBe(true);
    const boundPush = execFileCalls.find((call) => call.args[0] === "push");
    const boundRemote = String(boundPush?.args[1]);
    expect(boundRemote).toMatch(
      /^quack-bound-[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu,
    );
    expect(boundPush?.rawArgs.join(" ")).not.toContain(ORIGIN_PUSH_URL);
    expect(boundPush?.env?.GIT_CONFIG_COUNT).toBe("4");
    expect(
      Object.entries(boundPush?.env ?? {}).filter(([key]) => /^GIT_CONFIG_KEY_[0-9]+$/u.test(key)),
    ).toEqual(
      expect.arrayContaining([
        expect.arrayContaining([expect.any(String), `remote.${boundRemote}.url`]),
        expect.arrayContaining([expect.any(String), `remote.${boundRemote}.pushurl`]),
        expect.arrayContaining([expect.any(String), `url.${ORIGIN_PUSH_URL}.insteadOf`]),
        expect.arrayContaining([expect.any(String), `url.${ORIGIN_PUSH_URL}.pushInsteadOf`]),
      ]),
    );
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "TASK-101",
        baseBranch: "main",
        headBranch: "quack/TASK-101",
        headCommitSha: fixture.options.recovery.gitState.candidateHead,
      }),
      expect.any(Object),
      expect.objectContaining({ selector: "github.com/org/repo" }),
    );
    expect(mergeBranchToTarget).toHaveBeenCalledWith(
      "TASK-101",
      expect.any(Object),
      "https://example.test/pull/1",
      "main",
      undefined,
      "quack/TASK-101",
      fixture.options.recovery.gitState.candidateHead,
      undefined,
      expect.objectContaining({ pushUrlHash: ORIGIN_BINDING.pushUrlHash }),
    );
    expect(result).toEqual(
      expect.objectContaining({ autoMerged: true, mergeCommitSha: "c".repeat(40) }),
    );
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test.each(["before", "after"] as const)(
    "recovers a fresh journal when the process stops %s the candidate seal",
    async (boundary) => {
      const fixture = durablePublication("TASK-101");
      recoveryGit!.sealed = undefined;
      const recoveryPath = await initializeDockerPublicationRecovery(
        "TASK-101",
        fixture.root,
        "quack/TASK-101",
        fixture.options,
      );
      expect(findDockerPublicationRecovery(fixture.recoveryRoot, "TASK-101")?.path).toBe(
        recoveryPath,
      );
      expect(recoveryLockRefs.size).toBe(0);
      if (boundary === "after") {
        recoveryGit!.sealed = fixture.options.recovery.gitState.candidateHead;
      }

      await expect(
        publishDockerPromotedResult("TASK-101", fixture.root, "quack/TASK-101", fixture.options),
      ).resolves.toEqual(expect.objectContaining({ recoveryPath }));

      expect(recoveryGit!.sealed).toBe(fixture.options.recovery.gitState.candidateHead);
      expect(readDockerPublicationRecovery(recoveryPath).state).toBe("complete");
      fs.rmSync(fixture.root, { recursive: true, force: true });
    },
  );

  test("replaces only an identity-matching crash-truncated initial journal", async () => {
    const fixture = durablePublication("TASK-101");
    const artifact = initialJournalFixture(fixture);
    fs.mkdirSync(fixture.recoveryRoot, { recursive: true });
    const cut = artifact.bytes.indexOf(Buffer.from('"updatedAt": "', "utf-8")) + 19;
    fs.writeFileSync(artifact.recoveryPath, artifact.bytes.subarray(0, cut));

    const result = await publishDockerPromotedResult(
      "TASK-101",
      fixture.root,
      "quack/TASK-101",
      fixture.options,
    );

    expect(result.recoveryPath).toBe(artifact.recoveryPath);
    expect(readDockerPublicationRecovery(artifact.recoveryPath).state).toBe("complete");
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("refuses to replace a crash-truncated journal with different ownership", async () => {
    const fixture = durablePublication("TASK-101");
    const artifact = initialJournalFixture(fixture);
    fs.mkdirSync(fixture.recoveryRoot, { recursive: true });
    const foreign = Buffer.from(artifact.bytes);
    const candidateOffset = foreign.indexOf(Buffer.from("b".repeat(40), "utf-8"));
    foreign[candidateOffset] = "c".charCodeAt(0);
    fs.writeFileSync(artifact.recoveryPath, foreign.subarray(0, candidateOffset + 2));

    await expect(
      publishDockerPromotedResult("TASK-101", fixture.root, "quack/TASK-101", fixture.options),
    ).rejects.toThrow(/JSON|schema/);
    expect(fs.readFileSync(artifact.recoveryPath)).toEqual(
      foreign.subarray(0, candidateOffset + 2),
    );
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("refuses to remove a truncated journal before its ownership is complete", async () => {
    const fixture = durablePublication("TASK-101");
    const artifact = initialJournalFixture(fixture);
    fs.mkdirSync(fixture.recoveryRoot, { recursive: true });
    const partial = artifact.bytes.subarray(0, artifact.bytes.indexOf(Buffer.from('"gitState"')));
    fs.writeFileSync(artifact.recoveryPath, partial);

    await expect(
      publishDockerPromotedResult("TASK-101", fixture.root, "quack/TASK-101", fixture.options),
    ).rejects.toThrow(/JSON|schema/);
    expect(fs.readFileSync(artifact.recoveryPath)).toEqual(partial);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("reconciles the exact hard-link crash window before resuming publication", async () => {
    const fixture = durablePublication("TASK-101");
    const artifact = initialJournalFixture(fixture);
    fs.mkdirSync(fixture.recoveryRoot, { recursive: true });
    const temporary = `${artifact.recoveryPath}.123.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, artifact.bytes);
    fs.linkSync(temporary, artifact.recoveryPath);
    expect(fs.lstatSync(artifact.recoveryPath).nlink).toBe(2);

    await expect(
      publishDockerPromotedResult("TASK-101", fixture.root, "quack/TASK-101", fixture.options),
    ).resolves.toEqual(expect.objectContaining({ recoveryPath: artifact.recoveryPath }));

    expect(fs.existsSync(temporary)).toBe(false);
    expect(fs.lstatSync(artifact.recoveryPath).nlink).toBe(1);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("removes an identity-matching orphan install temp before retrying initial creation", async () => {
    const fixture = durablePublication("TASK-101");
    const artifact = initialJournalFixture(fixture);
    fs.mkdirSync(fixture.recoveryRoot, { recursive: true });
    const temporary = `${artifact.recoveryPath}.123.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, artifact.bytes);

    await expect(
      publishDockerPromotedResult("TASK-101", fixture.root, "quack/TASK-101", fixture.options),
    ).resolves.toEqual(expect.objectContaining({ recoveryPath: artifact.recoveryPath }));

    expect(fs.existsSync(temporary)).toBe(false);
    expect(readDockerPublicationRecovery(artifact.recoveryPath).state).toBe("complete");
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("reclaims an inactive same-process lock after transient exact release failure", async () => {
    const fixture = durablePublication("TASK-101");
    const recoveryPath = initialJournalFixture(fixture).recoveryPath;
    const identity = {
      projectRoot: fixture.root,
      publicationId: fixture.options.recovery.publicationId,
      gitState: { sealedRef: fixture.options.recovery.gitState.sealedRef },
    };
    recoveryLockReleaseFailures = 1;

    await expect(
      withDockerPublicationRecoveryLock(recoveryPath, identity, () => Promise.resolve("first")),
    ).rejects.toThrow(/release was not confirmed/);
    expect(recoveryLockRefs.size).toBe(1);

    const retryOperation = jest.fn(() => Promise.resolve("second"));
    await expect(
      withDockerPublicationRecoveryLock(recoveryPath, identity, retryOperation),
    ).resolves.toBe("second");
    expect(retryOperation).toHaveBeenCalledTimes(1);
    expect(recoveryLockRefs.size).toBe(0);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("does not remove a different lock token installed after exact release", async () => {
    const fixture = durablePublication("TASK-101");
    const recoveryPath = initialJournalFixture(fixture).recoveryPath;
    const replacement = "f".repeat(40);
    recoveryLockReplacementOnRelease = replacement;

    await expect(
      withDockerPublicationRecoveryLock(
        recoveryPath,
        {
          projectRoot: fixture.root,
          publicationId: fixture.options.recovery.publicationId,
          gitState: { sealedRef: fixture.options.recovery.gitState.sealedRef },
        },
        () => Promise.resolve("published"),
      ),
    ).resolves.toBe("published");

    expect([...recoveryLockRefs.values()]).toEqual([replacement]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("accepts an ambiguous release error only after exact readback proves absence", async () => {
    const fixture = durablePublication("TASK-101");
    const recoveryPath = initialJournalFixture(fixture).recoveryPath;
    recoveryLockDeleteThenFail = 1;

    await expect(
      withDockerPublicationRecoveryLock(
        recoveryPath,
        {
          projectRoot: fixture.root,
          publicationId: fixture.options.recovery.publicationId,
          gitState: { sealedRef: fixture.options.recovery.gitState.sealedRef },
        },
        () => Promise.resolve("published"),
      ),
    ).resolves.toBe("published");

    expect(recoveryLockRefs.size).toBe(0);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("accepts an ambiguous lock acquisition only after exact token readback", async () => {
    const fixture = durablePublication("TASK-101");
    const recoveryPath = initialJournalFixture(fixture).recoveryPath;
    recoveryLockInstallThenFail = 1;
    const operation = jest.fn(() => Promise.resolve("published"));

    await expect(
      withDockerPublicationRecoveryLock(
        recoveryPath,
        {
          projectRoot: fixture.root,
          publicationId: fixture.options.recovery.publicationId,
          gitState: { sealedRef: fixture.options.recovery.gitState.sealedRef },
        },
        operation,
      ),
    ).resolves.toBe("published");

    expect(operation).toHaveBeenCalledTimes(1);
    expect(recoveryLockRefs.size).toBe(0);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("reclaims an exact lock after its successful acquisition confirmation fails", async () => {
    const fixture = durablePublication("TASK-101");
    const recoveryPath = initialJournalFixture(fixture).recoveryPath;
    const identity = {
      projectRoot: fixture.root,
      publicationId: fixture.options.recovery.publicationId,
      gitState: { sealedRef: fixture.options.recovery.gitState.sealedRef },
    };
    recoveryLockConfirmationReadFailures = 1;

    await expect(
      withDockerPublicationRecoveryLock(recoveryPath, identity, () => Promise.resolve("first")),
    ).rejects.toThrow(/could not confirm durable recovery lock acquisition/);
    expect(recoveryLockRefs.size).toBe(1);

    await expect(
      withDockerPublicationRecoveryLock(recoveryPath, identity, () => Promise.resolve("retry")),
    ).resolves.toBe("retry");
    expect(recoveryLockRefs.size).toBe(0);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("blocks an untracked live incarnation but reclaims the same PID after reuse", async () => {
    const fixture = durablePublication("TASK-101");
    const recoveryPath = initialJournalFixture(fixture).recoveryPath;
    const identity = {
      projectRoot: fixture.root,
      publicationId: fixture.options.recovery.publicationId,
      gitState: { sealedRef: fixture.options.recovery.gitState.sealedRef },
    };
    const lockRef = identity.gitState.sealedRef.replace(
      "refs/quack/docker-publication/",
      "refs/quack/docker-publication-lock/",
    );
    recoveryLockReleaseFailures = 1;
    await expect(
      withDockerPublicationRecoveryLock(recoveryPath, identity, () => Promise.resolve("first")),
    ).rejects.toThrow(/release was not confirmed/);
    const retainedObject = recoveryLockRefs.get(lockRef)!;
    const retainedOwner = JSON.parse(recoveryLockObjects.get(retainedObject)!) as Record<
      string,
      unknown
    >;

    const unknownLiveObject = "e".repeat(40);
    recoveryLockObjects.set(
      unknownLiveObject,
      JSON.stringify({ ...retainedOwner, nonce: randomUUID() }),
    );
    recoveryLockRefs.set(lockRef, unknownLiveObject);
    await expect(
      withDockerPublicationRecoveryLock(recoveryPath, identity, () => Promise.resolve("unsafe")),
    ).rejects.toThrow(/another publisher owns/);

    const reusedPidObject = "d".repeat(40);
    recoveryLockObjects.set(
      reusedPidObject,
      JSON.stringify({
        ...retainedOwner,
        processIncarnation: `stale:${String(retainedOwner.processIncarnation)}`,
        nonce: randomUUID(),
      }),
    );
    recoveryLockRefs.set(lockRef, reusedPidObject);
    await expect(
      withDockerPublicationRecoveryLock(recoveryPath, identity, () => Promise.resolve("reclaimed")),
    ).resolves.toBe("reclaimed");
    expect(recoveryLockRefs.size).toBe(0);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("advances and pushes a non-final parent branch without premature PR, merge, or deletion", async () => {
    const fixture = durablePublication("TASK-018-A", "quack/TASK-018");
    const result = await publishDockerPromotedResult("TASK-018-A", fixture.root, "quack/TASK-018", {
      ...fixture.options,
      parentTaskId: "TASK-018",
      sharedBranchName: "quack/TASK-018",
    });

    expect(execFileCalls.some((call) => call.args[0] === "push")).toBe(true);
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(mergeBranchToTarget).not.toHaveBeenCalled();
    expect(deleteAfterMerge).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({ warnings: [] }));
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("retries a shared parent push without losing its exact approval lineage", async () => {
    const taskId = "TASK-018-A";
    const parentTaskId = "TASK-018";
    const sharedBranchName = "quack/TASK-018";
    const fixture = durablePublication(taskId, sharedBranchName);
    const resumeOwnershipId = randomUUID();
    const resumeSessionId = `quack-${taskId}-${randomUUID()}`;
    const sourceResume = {
      archiveName: `${taskId}-${resumeOwnershipId}`,
      dispatchSessionId: resumeSessionId,
      eventSessionId: resumeSessionId,
      ownershipId: resumeOwnershipId,
      approvedGate: "blueprint" as const,
      gitState: {
        authoritativeRef: `refs/heads/${sharedBranchName}`,
        baseHead: "a".repeat(40),
        candidateHead: "a".repeat(40),
        sealedRef: `refs/quack/docker-resume/${taskId}/${resumeOwnershipId}`,
      },
      parentTaskId,
      sharedBranchName,
    };
    fixture.options.recovery.sourceResume = sourceResume;
    pushFailure = new Error("shared push unavailable");

    let recoveryPath: string | undefined;
    try {
      await publishDockerPromotedResult(taskId, fixture.root, sharedBranchName, {
        ...fixture.options,
        parentTaskId,
        sharedBranchName,
      });
    } catch (error: unknown) {
      expect(error).toEqual(
        expect.objectContaining({
          name: "DockerPublicationIncompleteError",
          step: "push",
        }),
      );
      recoveryPath =
        typeof error === "object" && error !== null && "recoveryPath" in error
          ? String((error as { recoveryPath?: unknown }).recoveryPath)
          : undefined;
    }

    expect(recoveryPath).toBeDefined();
    expect(readDockerPublicationRecovery(recoveryPath!).sourceResume).toEqual(sourceResume);
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(mergeBranchToTarget).not.toHaveBeenCalled();
    expect(deleteAfterMerge).not.toHaveBeenCalled();

    pushFailure = undefined;
    await expect(resumeDockerPromotedResult(fixture.root, recoveryPath!)).resolves.toEqual(
      expect.objectContaining({ warnings: [], recoveryPath }),
    );
    expect(readDockerPublicationRecovery(recoveryPath!).sourceResume).toEqual(sourceResume);
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(mergeBranchToTarget).not.toHaveBeenCalled();
    expect(deleteAfterMerge).not.toHaveBeenCalled();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("publishes and merges the final shared child from the exact parent branch", async () => {
    const fixture = durablePublication("TASK-018-C", "quack/TASK-018");
    resolveTaskFile.mockResolvedValue(
      resolvedTask(["All parent task success criteria verified against the integrated branch"]),
    );

    await publishDockerPromotedResult("TASK-018-C", fixture.root, "quack/TASK-018", {
      ...fixture.options,
      parentTaskId: "TASK-018",
      sharedBranchName: "quack/TASK-018",
    });

    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        headBranch: "quack/TASK-018",
        baseBranch: "main",
        headCommitSha: fixture.options.recovery.gitState.candidateHead,
      }),
      expect.any(Object),
      expect.objectContaining({ selector: "github.com/org/repo" }),
    );
    expect(mergeBranchToTarget).toHaveBeenCalledWith(
      "TASK-018-C",
      expect.any(Object),
      "https://example.test/pull/1",
      "main",
      undefined,
      "quack/TASK-018",
      fixture.options.recovery.gitState.candidateHead,
      undefined,
      expect.objectContaining({ pushUrlHash: ORIGIN_BINDING.pushUrlHash }),
    );
    expect(deleteAfterMerge).toHaveBeenCalledWith(
      "quack/TASK-018",
      expect.any(Object),
      expect.objectContaining({
        baseBranch: "main",
        expectedHeadCommit: fixture.options.recovery.gitState.candidateHead,
      }),
    );
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("checks cleanup against the journal's non-default merge target", async () => {
    const fixture = durablePublication("TASK-101");

    await publishDockerPromotedResult("TASK-101", fixture.root, "quack/TASK-101", {
      ...fixture.options,
      mergeTargetBranch: "release",
    });

    expect(deleteAfterMerge).toHaveBeenCalledWith(
      "quack/TASK-101",
      expect.any(Object),
      expect.objectContaining({
        baseBranch: "release",
        expectedHeadCommit: fixture.options.recovery.gitState.candidateHead,
      }),
    );
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("retains the source ref when its Docker worktree is intentionally preserved", async () => {
    const fixture = durablePublication("TASK-101");
    fixture.options.recovery.preserveWorktree = true;

    const result = await publishDockerPromotedResult(
      "TASK-101",
      fixture.root,
      "quack/TASK-101",
      fixture.options,
    );

    expect(deleteAfterMerge).not.toHaveBeenCalled();
    expect(result.warnings).toContain("retained-with-worktree");
    expect(readDockerPublicationRecovery(result.recoveryPath!).progress.cleanupOutcome).toBe(
      "retained-with-worktree",
    );
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("fails before publication when parent/shared identity is inconsistent", async () => {
    const fixture = durablePublication("TASK-018-A", "quack/TASK-018");
    await expect(
      publishDockerPromotedResult("TASK-018-A", fixture.root, "quack/TASK-018", {
        ...fixture.options,
        parentTaskId: "TASK-018",
        sharedBranchName: "quack/OTHER",
      }),
    ).rejects.toThrow(/expected quack\/TASK-018/);
    expect(execFileCalls).toHaveLength(0);
    expect(createPullRequest).not.toHaveBeenCalled();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("durably retries an exact branch push failure before PR or merge actions", async () => {
    const fixture = durablePublication("TASK-101");
    pushFailure = new Error("remote unavailable");
    let recoveryPath: string | undefined;
    try {
      await publishDockerPromotedResult(
        "TASK-101",
        fixture.root,
        "quack/TASK-101",
        fixture.options,
      );
    } catch (error: unknown) {
      expect(error).toEqual(expect.objectContaining({ step: "push" }));
      recoveryPath =
        typeof error === "object" && error !== null && "recoveryPath" in error
          ? String((error as { recoveryPath?: unknown }).recoveryPath)
          : undefined;
    }
    expect(recoveryPath).toBeDefined();
    const failed = readDockerPublicationRecovery(recoveryPath!);
    expect(typeof failed.progress.promotedAt).toBe("string");
    expect(failed.progress.pushedAt).toBeUndefined();
    expect(createPullRequest).not.toHaveBeenCalled();
    expect(mergeBranchToTarget).not.toHaveBeenCalled();
    expect(deleteAfterMerge).not.toHaveBeenCalled();

    pushFailure = undefined;
    await expect(resumeDockerPromotedResult(fixture.root, recoveryPath!)).resolves.toEqual(
      expect.objectContaining({ autoMerged: true, recoveryPath }),
    );
    expect(
      execFileCalls.filter(
        (call) => call.args[0] === "update-ref" && call.args[1] === "refs/heads/quack/TASK-101",
      ),
    ).toHaveLength(1);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("restart fails closed when origin changes after the journal is bound", async () => {
    const fixture = durablePublication("TASK-101");
    pushFailure = new Error("push unavailable");
    let recoveryPath: string | undefined;

    try {
      await publishDockerPromotedResult(
        "TASK-101",
        fixture.root,
        "quack/TASK-101",
        fixture.options,
      );
    } catch (error: unknown) {
      expect(error).toEqual(expect.objectContaining({ step: "push" }));
      recoveryPath =
        typeof error === "object" && error !== null && "recoveryPath" in error
          ? String((error as { recoveryPath?: unknown }).recoveryPath)
          : undefined;
    }

    expect(recoveryPath).toBeDefined();
    const persisted = fs.readFileSync(recoveryPath!, "utf-8");
    expect(persisted).not.toContain(ORIGIN_PUSH_URL);
    const pushCount = execFileCalls.filter((call) => call.args[0] === "push").length;
    pushFailure = undefined;
    currentOriginPushUrl = "https://github.com/attacker/redirect.git";

    let resumeError: unknown;
    try {
      await resumeDockerPromotedResult(fixture.root, recoveryPath!);
    } catch (error: unknown) {
      resumeError = error;
    }
    expect(resumeError).toBeInstanceOf(Error);
    if (!(resumeError instanceof Error)) throw new Error("Expected Docker recovery to fail");
    expect(resumeError.name).toBe("DockerPublicationIncompleteError");
    expect((resumeError as { step?: unknown }).step).toBe("validation");
    expect(resumeError.message).toContain("Git origin changed");
    expect(execFileCalls.filter((call) => call.args[0] === "push")).toHaveLength(pushCount);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("persists a no-PR prepared target result before the effect and resumes that exact result", async () => {
    const fixture = durablePublication("TASK-101");
    loadAdapter.mockResolvedValue({
      ...adapter({
        autoPush: true,
        autoCreatePr: false,
        autoMerge: true,
        autoMergeStrategy: "squash",
      }),
      projectRoot: fixture.root,
    });
    const prepared = {
      strategy: "squash" as const,
      candidateHead: fixture.options.recovery.gitState.candidateHead,
      targetHead: "c".repeat(40),
      resultHead: "d".repeat(40),
      preparedRef: fixture.options.recovery.gitState.sealedRef.replace(
        "refs/quack/docker-publication/",
        "refs/quack/docker-publication-prepared/",
      ),
    };
    mergeBranchToTarget.mockImplementationOnce((...args: unknown[]) => {
      const recovery = args[7] as {
        onPrepared?: (value: typeof prepared) => void;
      };
      recoveryPreparedRefs.set(prepared.preparedRef, prepared.resultHead);
      recovery.onPrepared?.(prepared);
      // Model the process dying after the remote accepted the exact prepared
      // result but before executePublication could record mergedAt.
      if (recoveryGit) recoveryGit.remote = prepared.resultHead;
      throw new Error("simulated crash after target push");
    });

    let recoveryPath: string | undefined;
    try {
      await publishDockerPromotedResult(
        "TASK-101",
        fixture.root,
        "quack/TASK-101",
        fixture.options,
      );
    } catch (error: unknown) {
      expect(error).toEqual(
        expect.objectContaining({ name: "DockerPublicationIncompleteError", step: "merge" }),
      );
      recoveryPath =
        typeof error === "object" && error !== null && "recoveryPath" in error
          ? String((error as { recoveryPath?: unknown }).recoveryPath)
          : undefined;
    }

    expect(recoveryPath).toBeDefined();
    const interrupted = readDockerPublicationRecovery(recoveryPath!);
    expect(interrupted.progress.preparedMerge).toMatchObject(prepared);
    expect(typeof interrupted.progress.preparedMerge?.preparedAt).toBe("string");
    expect(interrupted.progress.mergedAt).toBeUndefined();

    mergeBranchToTarget.mockImplementationOnce((...args: unknown[]) => {
      const recovery = args[7] as { prepared?: typeof prepared };
      expect(recovery.prepared).toEqual(prepared);
      return Promise.resolve({ success: true, mergeCommitSha: prepared.resultHead });
    });
    await expect(resumeDockerPromotedResult(fixture.root, recoveryPath!)).resolves.toEqual(
      expect.objectContaining({
        autoMerged: true,
        mergeCommitSha: prepared.resultHead,
        recoveryPath,
      }),
    );
    expect(deleteAfterMerge).toHaveBeenCalledWith(
      "quack/TASK-101",
      expect.any(Object),
      expect.objectContaining({
        baseBranch: "main",
        expectedHeadCommit: prepared.candidateHead,
        expectedMergedCommit: prepared.resultHead,
      }),
    );
    expect(recoveryPreparedRefs.has(prepared.preparedRef)).toBe(false);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("retains an installed preparedMerge and its ref across repeated durability failures", async () => {
    const fixture = durablePublication("TASK-101");
    const recoveryPath = initialJournalFixture(fixture).recoveryPath;
    loadAdapter.mockResolvedValue({
      ...adapter({
        autoPush: true,
        autoCreatePr: false,
        autoMerge: true,
        autoMergeStrategy: "squash",
      }),
      projectRoot: fixture.root,
    });
    const prepared = {
      strategy: "squash" as const,
      candidateHead: fixture.options.recovery.gitState.candidateHead,
      targetHead: "c".repeat(40),
      resultHead: "d".repeat(40),
      preparedRef: fixture.options.recovery.gitState.sealedRef.replace(
        "refs/quack/docker-publication/",
        "refs/quack/docker-publication-prepared/",
      ),
    };
    const actualFs = jest.requireActual<typeof import("node:fs")>("node:fs");
    const realFsync = actualFs.fsyncSync;
    let posixBarrierFailures = 0;
    let observedFailures = 0;
    let installedBeforePreparation: ReturnType<typeof actualFs.statSync> | undefined;
    const sync =
      process.platform === "win32"
        ? undefined
        : jest.spyOn(actualFs, "fsyncSync").mockImplementation((fd) => {
            if (
              posixBarrierFailures > 0 &&
              installedBeforePreparation !== undefined &&
              actualFs.existsSync(recoveryPath)
            ) {
              const opened = actualFs.fstatSync(fd);
              const installed = actualFs.statSync(recoveryPath);
              if (
                opened.isFile() &&
                opened.dev === installed.dev &&
                opened.ino === installed.ino &&
                (opened.dev !== installedBeforePreparation.dev ||
                  opened.ino !== installedBeforePreparation.ino)
              ) {
                posixBarrierFailures -= 1;
                observedFailures += 1;
                throw Object.assign(new Error("simulated post-rename durability failure"), {
                  code: "EIO",
                });
              }
            }
            return realFsync(fd);
          });
    mergeBranchToTarget.mockImplementationOnce((...args: unknown[]) => {
      const recovery = args[7] as { onPrepared?: (value: typeof prepared) => void };
      recoveryPreparedRefs.set(prepared.preparedRef, prepared.resultHead);
      if (process.platform === "win32") durableMoveAfterRenameFailures = 2;
      else {
        installedBeforePreparation = actualFs.statSync(recoveryPath);
        posixBarrierFailures = 2;
      }
      recovery.onPrepared?.(prepared);
      return Promise.resolve({ success: true, mergeCommitSha: prepared.resultHead });
    });

    try {
      await expect(
        publishDockerPromotedResult("TASK-101", fixture.root, "quack/TASK-101", fixture.options),
      ).rejects.toEqual(
        expect.objectContaining({ name: "DockerPublicationIncompleteError", step: "merge" }),
      );
      if (process.platform === "win32") expect(durableMoveAfterRenameFailures).toBe(0);
      else expect(observedFailures).toBe(2);
      const interrupted = readDockerPublicationRecovery(recoveryPath);
      expect(interrupted.progress.preparedMerge).toMatchObject(prepared);
      expect(recoveryPreparedRefs.get(prepared.preparedRef)).toBe(prepared.resultHead);

      mergeBranchToTarget.mockImplementationOnce((...args: unknown[]) => {
        const recovery = args[7] as { prepared?: typeof prepared };
        expect(recovery.prepared).toEqual(prepared);
        return Promise.resolve({ success: true, mergeCommitSha: prepared.resultHead });
      });
      await expect(resumeDockerPromotedResult(fixture.root, recoveryPath)).resolves.toEqual(
        expect.objectContaining({ autoMerged: true, mergeCommitSha: prepared.resultHead }),
      );
      const completed = readDockerPublicationRecovery(recoveryPath);
      expect(completed.progress.preparedMerge).toMatchObject(prepared);
      expect(completed.state).toBe("complete");
      expect(recoveryPreparedRefs.has(prepared.preparedRef)).toBe(false);
    } finally {
      sync?.mockRestore();
      fs.rmSync(fixture.root, { recursive: true, force: true });
    }
  });

  test("refuses host publication without a durable retry ownership binding", async () => {
    await expect(
      publishDockerPromotedResult("TASK-101", "/trusted/project", "quack/TASK-101"),
    ).rejects.toThrow(/durable recovery ownership is required/);
    expect(execFileCalls).toHaveLength(0);
  });

  test("durably resumes push, PR, merge, status, and cleanup without repeating confirmed steps", async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-publish-"));
    const worktreePath = path.join(root, "worktree");
    const recoveryRoot = path.join(root, ".quack", "logs", "docker-publications");
    fs.mkdirSync(worktreePath, { recursive: true });
    const base = "a".repeat(40);
    const candidate = "b".repeat(40);
    const publicationId = randomUUID();
    recoveryGit = { base, candidate, current: base, sealed: candidate };
    loadAdapter.mockResolvedValue({
      ...adapter({ autoPush: true, autoCreatePr: true, autoMerge: true }),
      projectRoot: root,
    });
    createPullRequest.mockRejectedValueOnce(new Error("PR unavailable"));

    let recoveryPath: string | undefined;
    try {
      await publishDockerPromotedResult("TASK-101", root, "quack/TASK-101", {
        recovery: {
          rootDir: recoveryRoot,
          publicationId,
          gitState: {
            authoritativeRef: "refs/heads/quack/TASK-101",
            baseHead: base,
            candidateHead: candidate,
            sealedRef: `refs/quack/docker-publication/TASK-101/${publicationId}`,
          },
          worktreePath,
          worktreeSessionId: `quack-TASK-101-${randomUUID()}`,
          worktreeOwnershipId: publicationId,
          preserveWorktree: false,
        },
      });
    } catch (error: unknown) {
      expect(error).toEqual(
        expect.objectContaining({
          name: "DockerPublicationIncompleteError",
          step: "pull-request",
        }),
      );
      recoveryPath =
        typeof error === "object" && error !== null && "recoveryPath" in error
          ? String((error as { recoveryPath?: unknown }).recoveryPath)
          : undefined;
    }
    expect(recoveryPath).toBeDefined();
    const initialProgress = readDockerPublicationRecovery(recoveryPath!).progress;
    expect(typeof initialProgress.promotedAt).toBe("string");
    expect(typeof initialProgress.pushedAt).toBe("string");
    expect(recoveryGit.current).toBe(candidate);
    expect(recoveryGit.remote).toBe(candidate);

    createPullRequest.mockResolvedValue({ success: true, prUrl: "https://example.test/pull/1" });
    mergeBranchToTarget.mockRejectedValueOnce(new Error("merge unavailable"));
    await expect(resumeDockerPromotedResult(root, recoveryPath!)).rejects.toEqual(
      expect.objectContaining({ name: "DockerPublicationIncompleteError", step: "merge" }),
    );
    expect(
      execFileCalls.filter(
        (call) =>
          call.args[0] === "push" && call.args.includes(`${candidate}:refs/heads/quack/TASK-101`),
      ),
    ).toHaveLength(1);

    mergeBranchToTarget.mockResolvedValue({ success: true, mergeCommitSha: "c".repeat(40) });
    updateTaskFileStatus.mockRejectedValueOnce(new Error("status unavailable"));
    await expect(resumeDockerPromotedResult(root, recoveryPath!)).rejects.toEqual(
      expect.objectContaining({ name: "DockerPublicationIncompleteError", step: "status" }),
    );
    expect(createPullRequest).toHaveBeenCalledTimes(2);

    updateTaskFileStatus.mockResolvedValue({ success: true });
    deleteAfterMerge.mockResolvedValueOnce({
      deleted: true,
      localDeleted: true,
      remoteDeleted: false,
    });
    await expect(resumeDockerPromotedResult(root, recoveryPath!)).rejects.toEqual(
      expect.objectContaining({ name: "DockerPublicationIncompleteError", step: "cleanup" }),
    );
    const partialCleanup = readDockerPublicationRecovery(recoveryPath!).progress;
    expect(typeof partialCleanup.cleanupLocalAt).toBe("string");
    expect(partialCleanup.cleanupAt).toBeUndefined();
    expect(mergeBranchToTarget).toHaveBeenCalledTimes(2);
    recoveryGit.current = "";

    deleteAfterMerge.mockResolvedValue({ deleted: true, remoteDeleted: true });
    await expect(resumeDockerPromotedResult(root, recoveryPath!)).resolves.toEqual(
      expect.objectContaining({
        prUrl: "https://example.test/pull/1",
        autoMerged: true,
        mergeCommitSha: "c".repeat(40),
        recoveryPath,
      }),
    );
    expect(readDockerPublicationRecovery(recoveryPath!).state).toBe("complete");
    expect(
      execFileCalls.filter(
        (call) =>
          call.args[0] === "push" && call.args.includes(`${candidate}:refs/heads/quack/TASK-101`),
      ),
    ).toHaveLength(1);
    expect(deleteAfterMerge).toHaveBeenCalledTimes(2);
    expect(deleteAfterMerge).toHaveBeenLastCalledWith(
      "quack/TASK-101",
      expect.any(Object),
      expect.objectContaining({
        baseBranch: "main",
        expectedHeadCommit: candidate,
        expectedMergedCommit: "c".repeat(40),
      }),
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("keeps the journal and remote source when a partial-cleanup retry no longer proves the target", async () => {
    const fixture = durablePublication("TASK-101");
    deleteAfterMerge.mockResolvedValueOnce({
      deleted: true,
      localDeleted: true,
      remoteDeleted: false,
    });

    let recoveryPath: string | undefined;
    try {
      await publishDockerPromotedResult(
        "TASK-101",
        fixture.root,
        "quack/TASK-101",
        fixture.options,
      );
    } catch (error: unknown) {
      expect(error).toEqual(
        expect.objectContaining({ name: "DockerPublicationIncompleteError", step: "cleanup" }),
      );
      recoveryPath =
        typeof error === "object" && error !== null && "recoveryPath" in error
          ? String((error as { recoveryPath?: unknown }).recoveryPath)
          : undefined;
    }
    expect(recoveryPath).toBeDefined();
    const retainedGit = recoveryGit;
    if (!retainedGit) throw new Error("expected recovery Git fixture state");
    retainedGit.current = "";
    deleteAfterMerge.mockResolvedValueOnce({ deleted: false, reason: "not-merged" });

    await expect(resumeDockerPromotedResult(fixture.root, recoveryPath!)).rejects.toEqual(
      expect.objectContaining({ name: "DockerPublicationIncompleteError", step: "cleanup" }),
    );

    const retained = readDockerPublicationRecovery(recoveryPath!);
    expect(retained.state).toBe("pending");
    expect(retained.progress.cleanupAt).toBeUndefined();
    expect(retainedGit.current).toBe(fixture.options.recovery.gitState.candidateHead);
    expect(retainedGit.remote).toBe(fixture.options.recovery.gitState.candidateHead);
    expect(deleteAfterMerge).toHaveBeenLastCalledWith(
      "quack/TASK-101",
      expect.any(Object),
      expect.objectContaining({
        baseBranch: "main",
        expectedHeadCommit: fixture.options.recovery.gitState.candidateHead,
        expectedMergedCommit: "c".repeat(40),
      }),
    );
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
});
