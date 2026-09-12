/* eslint-disable @typescript-eslint/no-require-imports */
import { createHash, randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { DockerResumeSourceBinding } from "../../src/dispatcher/docker-runtime-bridge";

const trustedRepository = { host: "github.com", owner: "org", repo: "repo" };
const ORIGIN_PUSH_URL = "https://github.com/org/repo.git";
const ORIGIN_BINDING = {
  pushUrlHash: createHash("sha256").update(ORIGIN_PUSH_URL).digest("hex"),
  github: {
    selector: "github.com/org/repo",
    host: "github.com",
    nameWithOwner: "org/repo",
  },
};
const execFileCalls: Array<{
  file: string;
  args: readonly string[];
  cwd?: string;
  expectedRepository?: typeof trustedRepository;
}> = [];
let pushFailure: Error | undefined;
let remoteHeadOverrides: Array<string | undefined> = [];
const recoveryLockRefs = new Map<string, string>();
const recoveryLockObjects = new Map<string, string>();
const recoveryPreparedRefs = new Map<string, string>();
let recoveryLockObjectCounter = 0;
let recoveryLockReplacementOnRelease: string | undefined;
let recoveryGit:
  | { base: string; candidate: string; current: string; sealed?: string; remote?: string }
  | undefined;

jest.mock("node:child_process", () => {
  const actualFs = jest.requireActual<typeof import("node:fs")>("node:fs");
  const execFile = jest.fn();
  (execFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
  ): Promise<{ stdout: string; stderr: string }> => {
    if (!file.toLowerCase().endsWith("powershell.exe")) {
      return Promise.reject(new Error(`unexpected process-incarnation command ${file}`));
    }
    return Promise.resolve({ stdout: "638930000000000000", stderr: "" });
  };
  const execFileSync = jest.fn(
    (file: string, _args: readonly string[], options: { env?: NodeJS.ProcessEnv }): Buffer => {
      if (!file.toLowerCase().endsWith("powershell.exe")) {
        throw new Error(`unexpected durable namespace command ${file}`);
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
      return Buffer.alloc(0);
    },
  );
  return { execFile, execFileSync };
});

jest.mock("../../src/worker/trusted-executable", () => ({
  runTrustedGitResult: (
    projectRoot: string,
    args: readonly string[],
    options?: { expectedRepository?: typeof trustedRepository },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    execFileCalls.push({
      file: "git",
      args,
      cwd: projectRoot,
      ...(options?.expectedRepository ? { expectedRepository: options.expectedRepository } : {}),
    });
    if (recoveryGit) {
      if (args[0] === "hash-object") {
        recoveryLockObjectCounter += 1;
        const objectId = recoveryLockObjectCounter.toString(16).padStart(40, "0");
        recoveryLockObjects.set(objectId, fs.readFileSync(String(args.at(-1)), "utf-8"));
        return Promise.resolve({ exitCode: 0, stdout: `${objectId}\n`, stderr: "" });
      }
      if (args[0] === "cat-file" && args[1] === "blob") {
        const value = recoveryLockObjects.get(String(args[2]));
        return Promise.resolve(
          value === undefined
            ? { exitCode: 128, stdout: "", stderr: "missing object" }
            : { exitCode: 0, stdout: value, stderr: "" },
        );
      }
      if (args[0] === "rev-parse") {
        const ref = String(args.at(-1)).replace(/\^\{commit\}$/u, "");
        if (args.includes("--quiet")) {
          const value = ref.startsWith("refs/quack/docker-publication-lock/")
            ? recoveryLockRefs.get(ref)
            : ref.startsWith("refs/quack/docker-publication-prepared/")
              ? recoveryPreparedRefs.get(ref)
              : ref.startsWith("refs/quack/docker-publication/")
                ? recoveryGit.sealed
                : recoveryGit.current;
          return Promise.resolve(
            value
              ? { exitCode: 0, stdout: `${value}\n`, stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "" },
          );
        }
        if (/^[a-f0-9]{40,64}$/iu.test(ref)) {
          return Promise.resolve({ exitCode: 0, stdout: `${ref}\n`, stderr: "" });
        }
        const stdout = ref.startsWith("refs/quack/docker-publication/")
          ? recoveryGit.sealed
          : recoveryGit.current;
        return Promise.resolve({ exitCode: 0, stdout: `${stdout}\n`, stderr: "" });
      }
      if (args[0] === "show-ref") {
        const ref = String(args.at(-1));
        if (ref.startsWith("refs/quack/docker-publication-lock/")) {
          const value = recoveryLockRefs.get(ref);
          return Promise.resolve(
            value
              ? { exitCode: 0, stdout: `${value}\n`, stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "missing ref" },
          );
        }
        if (ref.startsWith("refs/quack/docker-publication/")) {
          return Promise.resolve(
            recoveryGit.sealed
              ? { exitCode: 0, stdout: `${recoveryGit.sealed}\n`, stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "missing ref" },
          );
        }
        if (ref.startsWith("refs/quack/docker-publication-prepared/")) {
          const value = recoveryPreparedRefs.get(ref);
          return Promise.resolve(
            value
              ? { exitCode: 0, stdout: `${value}\n`, stderr: "" }
              : { exitCode: 1, stdout: "", stderr: "missing ref" },
          );
        }
        if (recoveryGit.current) {
          return Promise.resolve({ exitCode: 0, stdout: `${recoveryGit.current}\n`, stderr: "" });
        }
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "missing ref" });
      }
      if (args[0] === "update-ref") {
        const ref = args[1] === "-d" ? String(args[2]) : String(args[1]);
        if (ref.startsWith("refs/quack/docker-publication-lock/")) {
          if (args[1] === "-d") {
            recoveryLockRefs.delete(ref);
            if (recoveryLockReplacementOnRelease) {
              recoveryLockRefs.set(ref, recoveryLockReplacementOnRelease);
            }
          } else recoveryLockRefs.set(ref, String(args[2]));
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        }
        if (ref.startsWith("refs/quack/docker-publication-prepared/")) {
          if (args[1] === "-d") recoveryPreparedRefs.delete(ref);
          else recoveryPreparedRefs.set(ref, String(args[2]));
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        }
        if (ref.startsWith("refs/quack/docker-publication/")) {
          if (args[1] === "-d") recoveryGit.sealed = "";
          else recoveryGit.sealed = String(args[2]);
          return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
        }
        recoveryGit.current = String(args[2]);
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      if (args[0] === "merge-base") {
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
      if (args[0] === "ls-remote") {
        const remoteHead =
          remoteHeadOverrides.length > 0 ? remoteHeadOverrides.shift() : recoveryGit.remote;
        return Promise.resolve({
          exitCode: 0,
          stdout: remoteHead
            ? `${remoteHead}\trefs/heads/${String(args.at(-1)).replace("refs/heads/", "")}\n`
            : "",
          stderr: "",
        });
      }
      if (args[0] === "push") {
        if (pushFailure) {
          return Promise.resolve({ exitCode: 1, stdout: "", stderr: pushFailure.message });
        }
        recoveryGit.remote =
          args.includes("--delete") || args.some((arg) => arg.startsWith(":refs/heads/"))
            ? undefined
            : recoveryGit.candidate;
        return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
      }
    }
    return Promise.resolve({
      exitCode: pushFailure && args[0] === "push" ? 1 : 0,
      stdout: "",
      stderr: pushFailure && args[0] === "push" ? pushFailure.message : "",
    });
  },
  runTrustedGitHubResult: (
    projectRoot: string,
    args: readonly string[],
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> => {
    execFileCalls.push({ file: "gh", args, cwd: projectRoot });
    return Promise.resolve({ exitCode: 0, stdout: "", stderr: "" });
  },
}));

const resolveOriginRepository = jest.fn(() =>
  Promise.resolve({ ...ORIGIN_BINDING, pushUrl: ORIGIN_PUSH_URL }),
);
const resolveBoundOriginRepository = jest.fn(() =>
  Promise.resolve({ ...ORIGIN_BINDING, pushUrl: ORIGIN_PUSH_URL }),
);
jest.mock("../../src/dispatcher/github-repository", () => ({
  isGitOriginBinding: (value: unknown) =>
    typeof value === "object" && value !== null && "pushUrlHash" in value,
  persistentOriginRepositoryBinding: (value: { pushUrlHash: string; github?: unknown }) => ({
    pushUrlHash: value.pushUrlHash,
    ...(value.github ? { github: value.github } : {}),
  }),
  resolveBoundOriginRepository,
  resolveOriginRepository,
}));

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
const recoverPullRequestCandidate = jest.fn();
jest.mock("../../src/dispatcher/pr-creator", () => ({
  createPullRequest,
  recoverPullRequestCandidate,
}));

const {
  initializeDockerPublicationRecovery,
  publishDockerPromotedResult,
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

async function successfulPullRequestCreation(input: {
  ownershipMarker?: string;
  onCandidate?: (candidate: {
    url: string;
    ownershipMarker: string;
    state: "pending" | "accepted" | "closed";
  }) => void | Promise<void>;
}): Promise<{ success: true; prUrl: string }> {
  const prUrl = "https://github.com/org/repo/pull/1";
  if (input.ownershipMarker && input.onCandidate) {
    await input.onCandidate({
      url: prUrl,
      ownershipMarker: input.ownershipMarker,
      state: "pending",
    });
    await input.onCandidate({
      url: prUrl,
      ownershipMarker: input.ownershipMarker,
      state: "accepted",
    });
  }
  return { success: true, prUrl };
}

describe("Docker host publication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    execFileCalls.splice(0);
    pushFailure = undefined;
    remoteHeadOverrides = [];
    recoveryLockRefs.clear();
    recoveryLockObjects.clear();
    recoveryPreparedRefs.clear();
    recoveryLockObjectCounter = 0;
    recoveryLockReplacementOnRelease = undefined;
    recoveryGit = undefined;
    loadAdapter.mockResolvedValue(adapter());
    resolveTaskFile.mockResolvedValue(resolvedTask());
    resolveOriginRepository.mockResolvedValue({
      ...ORIGIN_BINDING,
      pushUrl: ORIGIN_PUSH_URL,
    });
    resolveBoundOriginRepository.mockResolvedValue({
      ...ORIGIN_BINDING,
      pushUrl: ORIGIN_PUSH_URL,
    });
    createPullRequest.mockImplementation(successfulPullRequestCreation);
    recoverPullRequestCandidate.mockImplementation(
      (_projectRoot: string, candidate: { url: string; ownershipMarker: string }) =>
        Promise.resolve({ ...candidate, state: "accepted" as const }),
    );
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
    expect(execFileCalls.find((call) => call.args[0] === "push")?.expectedRepository).toEqual(
      trustedRepository,
    );
    expect(createPullRequest).toHaveBeenCalledWith(
      expect.objectContaining({
        taskId: "TASK-101",
        baseBranch: "main",
        headBranch: "quack/TASK-101",
      }),
      expect.any(Object),
    );
    expect(mergeBranchToTarget).toHaveBeenCalledWith(
      "TASK-101",
      expect.any(Object),
      "https://github.com/org/repo/pull/1",
      "main",
      undefined,
      "quack/TASK-101",
      {
        repository: trustedRepository,
        headBranch: "quack/TASK-101",
        baseBranch: "main",
        headOid: "b".repeat(40),
      },
      "b".repeat(40),
      trustedRepository,
      undefined,
      expect.objectContaining({ pushUrl: ORIGIN_PUSH_URL }),
    );
    expect(result).toEqual(
      expect.objectContaining({ autoMerged: true, mergeCommitSha: "c".repeat(40) }),
    );
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("initializes recovery before sealing and later reconstructs the exact candidate seal", async () => {
    const fixture = durablePublication("TASK-101");
    recoveryGit!.sealed = undefined;

    const recoveryPath = await initializeDockerPublicationRecovery(
      "TASK-101",
      fixture.root,
      "quack/TASK-101",
      fixture.options,
    );
    expect(readDockerPublicationRecovery(recoveryPath)).toEqual(
      expect.objectContaining({ state: "pending", generation: 0, repository: ORIGIN_BINDING }),
    );

    await expect(
      publishDockerPromotedResult("TASK-101", fixture.root, "quack/TASK-101", fixture.options),
    ).resolves.toEqual(expect.objectContaining({ recoveryPath }));
    expect(recoveryGit!.sealed).toBe(fixture.options.recovery.gitState.candidateHead);
    const completed = readDockerPublicationRecovery(recoveryPath);
    expect(completed.generation).toBeGreaterThan(0);
    expect(completed.previousDigest).toMatch(/^[a-f0-9]{64}$/u);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("replaces only an identity-matching crash-truncated initial journal", async () => {
    const fixture = durablePublication("TASK-101");
    const artifact = initialJournalFixture(fixture);
    fs.mkdirSync(fixture.recoveryRoot, { recursive: true });
    const cut = artifact.bytes.indexOf(Buffer.from('"updatedAt": "', "utf-8")) + 19;
    fs.writeFileSync(artifact.recoveryPath, artifact.bytes.subarray(0, cut));

    await expect(
      publishDockerPromotedResult("TASK-101", fixture.root, "quack/TASK-101", fixture.options),
    ).resolves.toEqual(expect.objectContaining({ recoveryPath: artifact.recoveryPath }));
    expect(readDockerPublicationRecovery(artifact.recoveryPath).state).toBe("complete");
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("serializes concurrent publishers with the durable Git-ref recovery lock", async () => {
    const fixture = durablePublication("TASK-101");
    const artifact = initialJournalFixture(fixture);
    fs.mkdirSync(fixture.recoveryRoot, { recursive: true });
    let release!: () => void;
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entered = new Promise<void>((resolve) => {
      void withDockerPublicationRecoveryLock(
        artifact.recoveryPath,
        {
          projectRoot: fixture.root,
          publicationId: fixture.options.recovery.publicationId,
          gitState: { sealedRef: fixture.options.recovery.gitState.sealedRef },
        },
        async () => {
          resolve();
          await held;
        },
      ).then(() => undefined);
    });
    await entered;

    await expect(
      withDockerPublicationRecoveryLock(
        artifact.recoveryPath,
        {
          projectRoot: fixture.root,
          publicationId: fixture.options.recovery.publicationId,
          gitState: { sealedRef: fixture.options.recovery.gitState.sealedRef },
        },
        () => Promise.resolve(),
      ),
    ).rejects.toThrow(/another publisher owns/);
    release();
    await new Promise((resolve) => setImmediate(resolve));
    expect(recoveryLockRefs.size).toBe(0);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("never removes a different lock token installed after exact release", async () => {
    const fixture = durablePublication("TASK-101");
    const replacement = "f".repeat(40);
    recoveryLockReplacementOnRelease = replacement;
    await expect(
      withDockerPublicationRecoveryLock(
        initialJournalFixture(fixture).recoveryPath,
        {
          projectRoot: fixture.root,
          publicationId: fixture.options.recovery.publicationId,
          gitState: { sealedRef: fixture.options.recovery.gitState.sealedRef },
        },
        () => Promise.resolve("done"),
      ),
    ).resolves.toBe("done");
    expect([...recoveryLockRefs.values()]).toEqual([replacement]);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("reclaims a lock whose PID belongs to a different process incarnation", async () => {
    const fixture = durablePublication("TASK-101");
    const staleObject = "e".repeat(40);
    const lockRef = fixture.options.recovery.gitState.sealedRef.replace(
      "refs/quack/docker-publication/",
      "refs/quack/docker-publication-lock/",
    );
    recoveryLockObjects.set(
      staleObject,
      JSON.stringify({
        version: 1,
        publicationId: fixture.options.recovery.publicationId,
        pid: process.pid,
        processStartedAt: "2020-01-01T00:00:00.000Z",
        processIncarnation: "win32:stale-incarnation",
        acquiredAt: "2020-01-01T00:00:00.000Z",
        nonce: randomUUID(),
      }),
    );
    recoveryLockRefs.set(lockRef, staleObject);

    await expect(
      withDockerPublicationRecoveryLock(
        initialJournalFixture(fixture).recoveryPath,
        {
          projectRoot: fixture.root,
          publicationId: fixture.options.recovery.publicationId,
          gitState: { sealedRef: fixture.options.recovery.gitState.sealedRef },
        },
        () => Promise.resolve("reclaimed"),
      ),
    ).resolves.toBe("reclaimed");
    expect(recoveryLockRefs.size).toBe(0);
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("retains a merged branch when its Docker worktree is preserved", async () => {
    const fixture = durablePublication("TASK-KEEP");
    fixture.options.recovery.preserveWorktree = true;
    const result = await publishDockerPromotedResult(
      "TASK-KEEP",
      fixture.root,
      "quack/TASK-KEEP",
      fixture.options,
    );
    expect(result.warnings).toContain("retained-with-worktree");
    expect(deleteAfterMerge).not.toHaveBeenCalled();
    expect(readDockerPublicationRecovery(result.recoveryPath!).progress.cleanupOutcome).toBe(
      "retained-with-worktree",
    );
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("rejects shell-significant branch characters before resolving publication credentials", async () => {
    const fixture = durablePublication("TASK-UNSAFE", "quack/TASK-UNSAFE;touch-pwned");
    buildBranchName.mockReturnValueOnce("quack/TASK-UNSAFE;touch-pwned");
    await expect(
      publishDockerPromotedResult(
        "TASK-UNSAFE",
        fixture.root,
        "quack/TASK-UNSAFE;touch-pwned",
        fixture.options,
      ),
    ).rejects.toThrow(/refused branch/);
    expect(resolveOriginRepository).not.toHaveBeenCalled();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("retains the journal when the remote branch advances before PR creation", async () => {
    const fixture = durablePublication("TASK-ADVANCED");
    remoteHeadOverrides = [undefined, "b".repeat(40), "d".repeat(40)];

    await expect(
      publishDockerPromotedResult(
        "TASK-ADVANCED",
        fixture.root,
        "quack/TASK-ADVANCED",
        fixture.options,
      ),
    ).rejects.toEqual(
      expect.objectContaining({
        name: "DockerPublicationIncompleteError",
        step: "pull-request",
      }),
    );
    expect(createPullRequest).not.toHaveBeenCalled();
    const journalPath = fs
      .readdirSync(fixture.recoveryRoot)
      .map((name) => path.join(fixture.recoveryRoot, name))
      .find((candidatePath) => candidatePath.endsWith(".json"));
    expect(journalPath).toBeDefined();
    expect(readDockerPublicationRecovery(journalPath!).repository).toEqual(ORIGIN_BINDING);
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
    expect(readDockerPublicationRecovery(result.recoveryPath!).repository).toEqual(ORIGIN_BINDING);

    const pushCount = execFileCalls.filter((call) => call.args[0] === "push").length;
    resolveBoundOriginRepository.mockRejectedValueOnce(new Error("Git origin changed"));
    await expect(resumeDockerPromotedResult(fixture.root, result.recoveryPath!)).rejects.toEqual(
      expect.objectContaining({ name: "DockerPublicationIncompleteError", step: "validation" }),
    );
    expect(execFileCalls.filter((call) => call.args[0] === "push")).toHaveLength(pushCount);
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
      expect.objectContaining({ headBranch: "quack/TASK-018", baseBranch: "main" }),
      expect.any(Object),
    );
    expect(mergeBranchToTarget).toHaveBeenCalledWith(
      "TASK-018-C",
      expect.any(Object),
      "https://github.com/org/repo/pull/1",
      "main",
      undefined,
      "quack/TASK-018",
      {
        repository: trustedRepository,
        headBranch: "quack/TASK-018",
        baseBranch: "main",
        headOid: "b".repeat(40),
      },
      "b".repeat(40),
      trustedRepository,
      undefined,
      expect.objectContaining({ pushUrl: ORIGIN_PUSH_URL }),
    );
    expect(deleteAfterMerge).toHaveBeenCalledWith("quack/TASK-018", expect.any(Object), {
      baseBranch: "main",
      expectedRepository: trustedRepository,
      expectedSourceOid: "b".repeat(40),
      expectedMergedCommit: "c".repeat(40),
      expectedOriginPushUrl: ORIGIN_PUSH_URL,
    });
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

  test("passes the sealed candidate commit to a deliberate no-PR auto-merge", async () => {
    const fixture = durablePublication("TASK-NO-PR");
    loadAdapter.mockResolvedValue({
      ...adapter({ autoCreatePr: false, autoMerge: true }),
      projectRoot: fixture.root,
    });

    await publishDockerPromotedResult(
      "TASK-NO-PR",
      fixture.root,
      "quack/TASK-NO-PR",
      fixture.options,
    );

    expect(createPullRequest).not.toHaveBeenCalled();
    expect(mergeBranchToTarget).toHaveBeenCalledWith(
      "TASK-NO-PR",
      expect.any(Object),
      undefined,
      "main",
      undefined,
      "quack/TASK-NO-PR",
      undefined,
      "b".repeat(40),
      trustedRepository,
      expect.any(Object),
      expect.objectContaining({ pushUrl: ORIGIN_PUSH_URL }),
    );
    const mergeCalls = mergeBranchToTarget.mock.calls as unknown as unknown[][];
    const recovery = mergeCalls[0]?.[9] as {
      preparedRef?: string;
      onPrepared?: unknown;
    };
    expect(recovery.preparedRef).toMatch(/^refs\/quack\/docker-publication-prepared\//u);
    expect(typeof recovery.onPrepared).toBe("function");
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("durably resumes an exact prepared no-PR merge after losing the merge response", async () => {
    const fixture = durablePublication("TASK-PREPARED");
    loadAdapter.mockResolvedValue({
      ...adapter({ autoCreatePr: false, autoMerge: true }),
      projectRoot: fixture.root,
    });
    const prepared = {
      strategy: "squash" as const,
      candidateHead: "b".repeat(40),
      targetHead: "d".repeat(40),
      resultHead: "c".repeat(40),
      preparedRef: fixture.options.recovery.gitState.sealedRef.replace(
        "refs/quack/docker-publication/",
        "refs/quack/docker-publication-prepared/",
      ),
    };
    mergeBranchToTarget.mockImplementationOnce((...args: unknown[]) => {
      const recovery = args[9] as {
        onPrepared?: (value: typeof prepared) => void;
      };
      recoveryPreparedRefs.set(prepared.preparedRef, prepared.resultHead);
      recovery.onPrepared?.(prepared);
      return Promise.reject(new Error("lost merge response"));
    });

    let recoveryPath: string | undefined;
    try {
      await publishDockerPromotedResult(
        "TASK-PREPARED",
        fixture.root,
        "quack/TASK-PREPARED",
        fixture.options,
      );
    } catch (error: unknown) {
      recoveryPath =
        typeof error === "object" && error !== null && "recoveryPath" in error
          ? String((error as { recoveryPath?: unknown }).recoveryPath)
          : undefined;
    }
    expect(recoveryPath).toBeDefined();
    expect(readDockerPublicationRecovery(recoveryPath!).progress.preparedMerge).toEqual(
      expect.objectContaining(prepared),
    );

    mergeBranchToTarget.mockImplementationOnce((...args: unknown[]) => {
      const recovery = args[9] as { prepared?: typeof prepared };
      expect(recovery.prepared).toEqual(prepared);
      return Promise.resolve({ success: true, mergeCommitSha: prepared.resultHead });
    });
    await expect(resumeDockerPromotedResult(fixture.root, recoveryPath!)).resolves.toEqual(
      expect.objectContaining({ mergeCommitSha: prepared.resultHead }),
    );
    expect(recoveryPreparedRefs.has(prepared.preparedRef)).toBe(false);
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

    createPullRequest.mockImplementation(successfulPullRequestCreation);
    mergeBranchToTarget.mockRejectedValueOnce(new Error("merge unavailable"));
    await expect(resumeDockerPromotedResult(root, recoveryPath!)).rejects.toEqual(
      expect.objectContaining({ name: "DockerPublicationIncompleteError", step: "merge" }),
    );
    expect(execFileCalls.filter((call) => call.args[0] === "push")).toHaveLength(1);

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
    expect(mergeBranchToTarget).toHaveBeenCalledTimes(2);

    deleteAfterMerge.mockResolvedValue({ deleted: true, remoteDeleted: true });
    await expect(resumeDockerPromotedResult(root, recoveryPath!)).resolves.toEqual(
      expect.objectContaining({
        prUrl: "https://github.com/org/repo/pull/1",
        autoMerged: true,
        mergeCommitSha: "c".repeat(40),
        recoveryPath,
      }),
    );
    expect(readDockerPublicationRecovery(recoveryPath!).state).toBe("complete");
    expect(
      execFileCalls.filter(
        (call) => call.args[0] === "push" && !call.args.some((arg) => arg.startsWith(":")),
      ),
    ).toHaveLength(1);
    expect(deleteAfterMerge).toHaveBeenCalledTimes(2);
    expect(readDockerPublicationRecovery(recoveryPath!).repository).toEqual(ORIGIN_BINDING);
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("recovers a durably recorded pending PR candidate before creating another", async () => {
    const fixture = durablePublication("TASK-PENDING-PR");
    const prUrl = "https://github.com/org/repo/pull/77";
    const recoveryPath = path.join(
      fixture.recoveryRoot,
      `TASK-PENDING-PR-${fixture.options.recovery.publicationId}.json`,
    );
    createPullRequest.mockImplementationOnce(
      async (input: {
        ownershipMarker: string;
        onCandidate: (candidate: {
          url: string;
          ownershipMarker: string;
          state: "pending";
        }) => void | Promise<void>;
      }) => {
        await input.onCandidate({
          url: prUrl,
          ownershipMarker: input.ownershipMarker,
          state: "pending",
        });
        throw new Error("host stopped after candidate persistence");
      },
    );

    await expect(
      publishDockerPromotedResult(
        "TASK-PENDING-PR",
        fixture.root,
        "quack/TASK-PENDING-PR",
        fixture.options,
      ),
    ).rejects.toMatchObject({
      name: "DockerPublicationIncompleteError",
      step: "pull-request",
    });
    expect(readDockerPublicationRecovery(recoveryPath).progress.pullRequestCandidate).toEqual(
      expect.objectContaining({ url: prUrl, state: "pending" }),
    );

    recoverPullRequestCandidate.mockRejectedValueOnce(
      new Error("Pull request does not contain the unique Quack ownership marker"),
    );
    await expect(resumeDockerPromotedResult(fixture.root, recoveryPath)).rejects.toMatchObject({
      name: "DockerPublicationIncompleteError",
      step: "pull-request",
    });
    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(readDockerPublicationRecovery(recoveryPath).progress.pullRequestCandidate).toEqual(
      expect.objectContaining({ url: prUrl, state: "pending" }),
    );

    recoverPullRequestCandidate.mockResolvedValueOnce({
      url: prUrl,
      ownershipMarker: `<!-- quack-publication:${fixture.options.recovery.publicationId} -->`,
      state: "accepted",
    });
    await expect(resumeDockerPromotedResult(fixture.root, recoveryPath)).resolves.toEqual(
      expect.objectContaining({ prUrl, autoMerged: true }),
    );
    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(recoverPullRequestCandidate).toHaveBeenCalledTimes(2);
    const completed = readDockerPublicationRecovery(recoveryPath);
    expect(completed.progress.prUrl).toBe(prUrl);
    expect(completed.progress.pullRequestCandidate?.state).toBe("accepted");
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("rejects a journal that records pullRequestAt without a PR URL", () => {
    const fixture = durablePublication("TASK-BAD-PR-TUPLE");
    const artifact = initialJournalFixture(fixture, "TASK-BAD-PR-TUPLE");
    fs.mkdirSync(fixture.recoveryRoot, { recursive: true });
    fs.writeFileSync(artifact.recoveryPath, artifact.bytes);
    const journal = readDockerPublicationRecovery(artifact.recoveryPath);
    journal.progress = {
      promotedAt: "2020-01-01T00:00:01.000Z",
      pushedAt: "2020-01-01T00:00:02.000Z",
      pullRequestAt: "2020-01-01T00:00:03.000Z",
    };
    fs.writeFileSync(artifact.recoveryPath, `${JSON.stringify(journal, null, 2)}\n`, "utf-8");

    expect(() => readDockerPublicationRecovery(artifact.recoveryPath)).toThrow(
      /inconsistent progress or ownership/,
    );
    expect(mergeBranchToTarget).not.toHaveBeenCalled();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });

  test("refuses a changed origin binding after the journal has pushed", async () => {
    const fixture = durablePublication("TASK-LEGACY-PUSHED");
    createPullRequest.mockRejectedValueOnce(new Error("pause after push"));

    let recoveryPath: string | undefined;
    try {
      await publishDockerPromotedResult(
        "TASK-LEGACY-PUSHED",
        fixture.root,
        "quack/TASK-LEGACY-PUSHED",
        fixture.options,
      );
    } catch (error: unknown) {
      recoveryPath =
        typeof error === "object" && error !== null && "recoveryPath" in error
          ? String((error as { recoveryPath?: unknown }).recoveryPath)
          : undefined;
    }
    expect(recoveryPath).toBeDefined();
    resolveBoundOriginRepository.mockRejectedValueOnce(new Error("Git origin changed"));

    await expect(resumeDockerPromotedResult(fixture.root, recoveryPath!)).rejects.toEqual(
      expect.objectContaining({
        name: "DockerPublicationIncompleteError",
        step: "validation",
      }),
    );
    expect(readDockerPublicationRecovery(recoveryPath!).lastError?.detail).toContain(
      "Git origin changed",
    );
    expect(createPullRequest).toHaveBeenCalledTimes(1);
    expect(mergeBranchToTarget).not.toHaveBeenCalled();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  });
});
