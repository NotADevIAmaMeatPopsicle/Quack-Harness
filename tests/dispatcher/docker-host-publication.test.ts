/* eslint-disable @typescript-eslint/no-require-imports */
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { DockerResumeSourceBinding } from "../../src/dispatcher/docker-runtime-bridge";

const execFileCalls: Array<{ file: string; args: readonly string[]; cwd?: string }> = [];
let pushFailure: Error | undefined;
let recoveryGit:
  | { base: string; candidate: string; current: string; sealed: string; remote?: string }
  | undefined;

jest.mock("node:child_process", () => {
  const mockExecFile = jest.fn();
  (mockExecFile as unknown as Record<symbol, unknown>)[promisify.custom] = (
    file: string,
    args: readonly string[],
    options: { cwd?: string },
  ): Promise<{ stdout: string; stderr: string }> => {
    execFileCalls.push({ file, args, cwd: options.cwd });
    if (file === "git" && recoveryGit) {
      if (args[0] === "rev-parse") {
        const ref = args.at(-1);
        const stdout = ref?.startsWith("refs/quack/docker-publication/")
          ? recoveryGit.sealed
          : recoveryGit.current;
        return Promise.resolve({ stdout: `${stdout}\n`, stderr: "" });
      }
      if (args[0] === "show-ref") {
        if (recoveryGit.current) {
          return Promise.resolve({ stdout: `${recoveryGit.current}\n`, stderr: "" });
        }
        return Promise.reject(Object.assign(new Error("missing ref"), { code: 1 }));
      }
      if (args[0] === "update-ref") {
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
        recoveryGit.remote = args.includes("--delete") ? undefined : recoveryGit.candidate;
        return Promise.resolve({ stdout: "", stderr: "" });
      }
    }
    return pushFailure && args[0] === "push"
      ? Promise.reject(pushFailure)
      : Promise.resolve({ stdout: "", stderr: "" });
  };
  return { execFile: mockExecFile };
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

const { publishDockerPromotedResult, readDockerPublicationRecovery, resumeDockerPromotedResult } =
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

describe("Docker host publication", () => {
  beforeEach(() => {
    jest.clearAllMocks();
    execFileCalls.splice(0);
    pushFailure = undefined;
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
      "https://example.test/pull/1",
      "main",
      undefined,
      "quack/TASK-101",
    );
    expect(result).toEqual(
      expect.objectContaining({ autoMerged: true, mergeCommitSha: "c".repeat(40) }),
    );
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
      expect.objectContaining({ headBranch: "quack/TASK-018", baseBranch: "main" }),
      expect.any(Object),
    );
    expect(mergeBranchToTarget).toHaveBeenCalledWith(
      "TASK-018-C",
      expect.any(Object),
      "https://example.test/pull/1",
      "main",
      undefined,
      "quack/TASK-018",
    );
    expect(deleteAfterMerge).toHaveBeenCalledWith("quack/TASK-018", expect.any(Object));
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
    expect(execFileCalls.filter((call) => call.args[0] === "update-ref")).toHaveLength(1);
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

    createPullRequest.mockResolvedValue({ success: true, prUrl: "https://example.test/pull/1" });
    mergeBranchToTarget.mockRejectedValueOnce(new Error("merge unavailable"));
    await expect(resumeDockerPromotedResult(root, recoveryPath!)).rejects.toEqual(
      expect.objectContaining({ name: "DockerPublicationIncompleteError", step: "merge" }),
    );
    expect(
      execFileCalls.filter((call) => call.args[0] === "push" && call.args.includes("-u")),
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
    expect(mergeBranchToTarget).toHaveBeenCalledTimes(2);

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
      execFileCalls.filter((call) => call.args[0] === "push" && call.args.includes("-u")),
    ).toHaveLength(1);
    expect(deleteAfterMerge).toHaveBeenCalledTimes(1);
    expect(
      execFileCalls.some((call) => call.args[0] === "push" && call.args.includes("--delete")),
    ).toBe(true);
    fs.rmSync(root, { recursive: true, force: true });
  });
});
