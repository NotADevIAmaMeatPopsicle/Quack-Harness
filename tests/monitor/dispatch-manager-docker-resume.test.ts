/* eslint-disable @typescript-eslint/no-require-imports */
import { execFileSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { inspectValidatedDockerResumeArchive } from "../../src/dispatcher/docker-runtime-bridge";
import type { DockerPublicationJournal } from "../../src/dispatcher/docker-publication-recovery";

const publishDockerPromotedResult = jest.fn();
const resumeDockerPromotedResult = jest.fn();
const initializeDockerPublicationRecovery = jest.fn();
jest.mock("../../src/dispatcher/docker-host-publication", () => ({
  initializeDockerPublicationRecovery,
  publishDockerPromotedResult,
  resumeDockerPromotedResult,
}));

const { DispatchManager } =
  require("../../src/monitor/dispatch-manager") as typeof import("../../src/monitor/dispatch-manager");

class FakeChild extends EventEmitter {
  pid = 43210;
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  kill = jest.fn();
}

function git(cwd: string, args: string[]): string {
  return execFileSync("git", args, { cwd, encoding: "utf-8" }).trim();
}

function writeJson(filePath: string, value: unknown): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(value)}\n`, "utf-8");
}

function validBlueprint(taskId: string) {
  return {
    taskId,
    fileAnalyses: [],
    codeExamples: [],
    verificationPatterns: [],
    antiPatterns: [],
    preconditions: [],
  };
}

async function flush(count = 8): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

describe("DispatchManager exact Docker approval resume", () => {
  let root: string;
  let projectRoot: string;
  let worktreePath: string;
  let baseHead: string;

  beforeEach(() => {
    jest.clearAllMocks();
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-resume-"));
    projectRoot = path.join(root, "project");
    worktreePath = path.join(projectRoot, ".quack", "worktrees", "TASK-018-A");
    fs.mkdirSync(projectRoot, { recursive: true });
    git(projectRoot, ["init", "--initial-branch=main"]);
    git(projectRoot, ["config", "user.email", "fixture@example.invalid"]);
    git(projectRoot, ["config", "user.name", "Fixture"]);
    fs.writeFileSync(path.join(projectRoot, "README.md"), "fixture\n", "utf-8");
    git(projectRoot, ["add", "README.md"]);
    git(projectRoot, ["commit", "-m", "initial"]);
    baseHead = git(projectRoot, ["rev-parse", "HEAD"]);
    git(projectRoot, ["branch", "quack/TASK-018", baseHead]);
    fs.mkdirSync(path.dirname(worktreePath), { recursive: true });
    git(projectRoot, ["worktree", "add", "--detach", worktreePath, baseHead]);
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    fs.mkdirSync(path.join(projectRoot, ".quack", "prep"), { recursive: true });
    publishDockerPromotedResult.mockResolvedValue({ warnings: [] });
    resumeDockerPromotedResult.mockResolvedValue({ warnings: [] });
    initializeDockerPublicationRecovery.mockImplementation(
      (taskId: string, _projectRoot: string, _branch: string, options: Record<string, unknown>) => {
        const recovery = options.recovery as { rootDir: string; publicationId: string };
        return Promise.resolve(
          path.join(recovery.rootDir, `${taskId}-${recovery.publicationId}.json`),
        );
      },
    );
  });

  afterEach(() => {
    try {
      git(projectRoot, ["worktree", "remove", "--force", worktreePath]);
    } catch {
      // A successful manager cleanup may already have removed it.
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("restart restores shared lineage and a publication failure preserves the exact pointer for retry", async () => {
    const taskId = "TASK-018-A";
    const parentTaskId = "TASK-018";
    const sharedBranchName = "quack/TASK-018";
    const children = [new FakeChild(), new FakeChild(), new FakeChild()];
    const created: Array<{
      runtimeDir: string;
      options: Record<string, unknown>;
      container: Record<string, unknown>;
    }> = [];
    const dockerManager = {
      reconcileExistingContainers: jest.fn().mockResolvedValue({
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
      }),
      createContainer: jest.fn(
        (_taskId: string, receivedWorktree: string, options: Record<string, unknown>) => {
          const runtimeDir = path.join(receivedWorktree, ".quack", "docker-runtime", randomUUID());
          fs.mkdirSync(runtimeDir, { recursive: true });
          const container = {
            containerId: `container-${created.length + 1}`,
            containerName: `container-${created.length + 1}`,
            taskId,
            image: "fixture",
            workDir: "/workspace",
            logsVolume: `/workspace/.quack/docker-runtime/${path.basename(runtimeDir)}`,
            worktreePath: receivedWorktree,
            runtimeLogDir: runtimeDir,
            gitDir: `/workspace/.quack/docker-git/${created.length + 1}`,
            privateGitDir: path.join(
              receivedWorktree,
              ".quack",
              "docker-git",
              String(created.length + 1),
            ),
            gitObjectsDir: path.join(projectRoot, ".git", "objects"),
            dotGitOverlay: path.join(root, `overlay-${created.length + 1}`),
            authoritativeRef: `refs/heads/${sharedBranchName}`,
            authoritativeHead: baseHead,
            authoritativeWorktreeGitDir: path.dirname(
              fs.realpathSync.native(
                path.resolve(
                  worktreePath,
                  fs
                    .readFileSync(path.join(worktreePath, ".git"), "utf-8")
                    .trim()
                    .replace(/^gitdir:\s*/i, ""),
                ),
              ),
            ),
            ...(typeof options.resumeStateDir === "string"
              ? (() => {
                  const inspected = inspectValidatedDockerResumeArchive(
                    options.resumeStateDir,
                    taskId,
                  );
                  return {
                    resumeSource: {
                      archiveName: inspected.archiveName,
                      dispatchSessionId: inspected.dispatchSessionId,
                      eventSessionId: inspected.eventSessionId,
                      ownershipId: inspected.ownershipId,
                      approvedGate: inspected.approvedGate,
                      gitState: inspected.gitState,
                      parentTaskId: inspected.parentTaskId,
                      sharedBranchName: inspected.sharedBranchName,
                    },
                  };
                })()
              : {}),
            parentTaskId,
            sharedBranchName,
            startedAt: new Date().toISOString(),
            status: "running" as const,
          };
          created.push({ runtimeDir, options, container });
          return Promise.resolve(container);
        },
      ),
      execAgent: jest.fn().mockImplementation(() => children[created.length - 1]),
      stopContainer: jest.fn(() => Promise.resolve({ removed: true, retained: false })),
      forceRemoveContainer: jest.fn(() => Promise.resolve(true)),
      extractResults: jest.fn(() =>
        Promise.resolve({
          diff: "diff --git a/README.md b/README.md",
          log: "candidate",
          branch: sharedBranchName,
        }),
      ),
      sealPrivateGitForResume: jest.fn((_container: unknown, ownershipId: string) => ({
        authoritativeRef: `refs/heads/${sharedBranchName}`,
        baseHead,
        candidateHead: "b".repeat(40),
        sealedRef: `refs/quack/docker-resume/${taskId}/${ownershipId}`,
      })),
      preparePrivateGitForPublication: jest.fn((_container: unknown, ownershipId: string) => ({
        authoritativeRef: `refs/heads/${sharedBranchName}`,
        baseHead,
        candidateHead: "c".repeat(40),
        sealedRef: `refs/quack/docker-publication/${taskId}/${ownershipId}`,
      })),
      sealPreparedPublicationRef: jest.fn((binding: unknown) => binding),
      releaseSealedResumeRef: jest.fn(() => true),
      releaseSealedPublicationRef: jest.fn(() => true),
      getActiveContainers: jest.fn(() => []),
      getTrackedContainers: jest.fn(() => []),
      abortPendingCommands: jest.fn(),
      cleanupAll: jest.fn(() => Promise.resolve({ removedTaskIds: [], failedTaskIds: [] })),
      getContainer: jest.fn(),
      containerPathForHost: jest.fn(() => "/quack-runtime/dist/index.js"),
    };

    const manager = new DispatchManager(projectRoot, path.join(projectRoot, "dist", "index.js"), {
      method: "docker",
      docker: {
        image: "fixture",
        volumes: [],
        envPassthrough: [],
        resourceLimits: { memoryMb: 512, cpus: 1 },
        networkMode: "none",
        cleanupPolicy: "remove",
      },
    });
    (manager as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;
    (manager as unknown as { createWorktree(): string }).createWorktree = () => worktreePath;
    (manager as unknown as { removeWorktree(): void }).removeWorktree = () => undefined;

    const first = manager.start(taskId, {
      skipGate: true,
      parentTaskId,
      sharedBranchName,
      provenance: { channel: "api-direct", principal: "initial-operator" },
    });
    await flush();
    const firstCreate = created[0];
    const firstSessionId = first.sessionId;
    const startedAt = first.startedAt;
    fs.appendFileSync(
      path.join(firstCreate.runtimeDir, `events-${firstSessionId}.jsonl`),
      `${JSON.stringify({
        sessionId: firstSessionId,
        taskId,
        project: path.basename(projectRoot),
        timestamp: new Date().toISOString(),
        stage: "session_start",
        payload: {
          model: "fixture",
          maxTurns: 10,
          maxBudget: 1,
          taskId,
          federated: false,
          provenance: { channel: "api-direct", principal: "initial-operator" },
        },
      })}\n`,
      "utf-8",
    );
    writeJson(path.join(firstCreate.runtimeDir, `checkpoint-${taskId}.json`), {
      taskId,
      sessionId: firstSessionId,
      completedStages: ["gate", "blueprint"],
      parentTaskId,
      featureBranch: sharedBranchName,
      totalCostUsd: 0,
      retriesUsed: 0,
      updatedAt: startedAt,
      startedAt,
    });
    writeJson(path.join(firstCreate.runtimeDir, "approvals", `${taskId}.json`), {
      taskId,
      state: "pending",
      blueprint: validBlueprint(taskId),
      createdAt: startedAt,
    });
    children[0].emit("exit", 1, null);
    await flush(12);

    expect(first.status).toBe("awaiting_approval");
    const pausedDir = manager.getDockerPausedRuntimeDir(taskId)!;
    const approvalPath = path.join(pausedDir, "approvals", `${taskId}.json`);
    const approval = JSON.parse(fs.readFileSync(approvalPath, "utf-8")) as Record<string, unknown>;
    writeJson(approvalPath, {
      ...approval,
      state: "approved",
      approvedBy: "operator",
      decidedAt: new Date(Date.now() + 10).toISOString(),
    });

    // A fresh manager models monitor restart. The HTTP approval route supplies
    // only the exact archive; parent/shared lineage must come from the sealed
    // host-owned pointer rather than from process memory.
    const restarted = new DispatchManager(projectRoot, path.join(projectRoot, "dist", "index.js"), {
      method: "docker",
      docker: {
        image: "fixture",
        volumes: [],
        envPassthrough: [],
        resourceLimits: { memoryMb: 512, cpus: 1 },
        networkMode: "none",
        cleanupPolicy: "remove",
      },
    });
    (restarted as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;
    (restarted as unknown as { createWorktree(): string }).createWorktree = () => worktreePath;
    (restarted as unknown as { removeWorktree(worktree: string): void }).removeWorktree = (
      worktree,
    ) => {
      git(projectRoot, ["worktree", "remove", "--force", worktree]);
    };

    publishDockerPromotedResult.mockImplementationOnce(
      (
        _taskId: string,
        _projectRoot: string,
        branch: string,
        publicationOptions: {
          parentTaskId?: string;
          sharedBranchName?: string;
          recovery: {
            rootDir: string;
            publicationId: string;
            gitState: Record<string, unknown>;
            worktreePath: string;
            worktreeSessionId: string;
            worktreeOwnershipId: string;
            preserveWorktree: boolean;
            sourceResume?: Record<string, unknown>;
          };
        },
      ) => {
        const recoveryPath = path.join(
          publicationOptions.recovery.rootDir,
          `${taskId}-${publicationOptions.recovery.publicationId}.json`,
        );
        writeJson(recoveryPath, {
          version: 1,
          publicationId: publicationOptions.recovery.publicationId,
          taskId,
          projectRoot: fs.realpathSync.native(projectRoot),
          branch,
          targetBranch: "main",
          parentTaskId: publicationOptions.parentTaskId,
          sharedBranchName: publicationOptions.sharedBranchName,
          repository: { pushUrlHash: "d".repeat(64) },
          gitState: publicationOptions.recovery.gitState,
          worktreePath: fs.realpathSync.native(publicationOptions.recovery.worktreePath),
          worktreeSessionId: publicationOptions.recovery.worktreeSessionId,
          worktreeOwnershipId: publicationOptions.recovery.worktreeOwnershipId,
          preserveWorktree: publicationOptions.recovery.preserveWorktree,
          sourceResume: publicationOptions.recovery.sourceResume,
          requirements: {
            push: true,
            pullRequest: false,
            merge: false,
            status: false,
            cleanup: false,
          },
          progress: { promotedAt: new Date().toISOString() },
          state: "pending",
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lastError: {
            step: "push",
            detail: "push temporarily unavailable",
            at: new Date().toISOString(),
          },
        });
        return Promise.reject(new Error("push temporarily unavailable"));
      },
    );
    const resumed = restarted.start(taskId, {
      resume: true,
      dockerResumeStateDir: pausedDir,
      provenance: { channel: "api-direct", principal: "approving-operator" },
    });
    await flush();
    expect(created[1].options).toEqual(
      expect.objectContaining({
        resumeStateDir: pausedDir,
        authoritativeBranch: sharedBranchName,
        parentTaskId,
        sharedBranchName,
      }),
    );
    const secondSessionId = resumed.sessionId;
    fs.appendFileSync(
      path.join(created[1].runtimeDir, `events-${secondSessionId}.jsonl`),
      `${JSON.stringify({
        sessionId: secondSessionId,
        taskId,
        project: path.basename(projectRoot),
        timestamp: new Date().toISOString(),
        stage: "session_start",
        payload: {
          model: "fixture",
          maxTurns: 10,
          maxBudget: 1,
          taskId,
          federated: false,
          provenance: { channel: "api-direct", principal: "approving-operator" },
        },
      })}\n`,
      "utf-8",
    );
    children[1].emit("exit", 0, null);
    await flush(12);
    expect(initializeDockerPublicationRecovery).toHaveBeenCalledTimes(1);
    expect(dockerManager.sealPreparedPublicationRef).toHaveBeenCalledTimes(1);
    expect(publishDockerPromotedResult).toHaveBeenCalledTimes(1);
    expect(initializeDockerPublicationRecovery.mock.invocationCallOrder[0]).toBeLessThan(
      dockerManager.sealPreparedPublicationRef.mock.invocationCallOrder[0],
    );
    expect(dockerManager.sealPreparedPublicationRef.mock.invocationCallOrder[0]).toBeLessThan(
      publishDockerPromotedResult.mock.invocationCallOrder[0],
    );
    expect(resumed.status).toBe("failed");
    expect(resumed.output.join("\n")).toContain("push temporarily unavailable");
    expect(restarted.getDockerPausedRuntimeDir(taskId)).toBe(pausedDir);
    expect(dockerManager.releaseSealedResumeRef).not.toHaveBeenCalled();
    expect(dockerManager.releaseSealedPublicationRef).not.toHaveBeenCalled();
    expect(fs.existsSync(worktreePath)).toBe(true);

    resumeDockerPromotedResult.mockImplementationOnce((_root: string, recoveryPath: string) => {
      const journal = JSON.parse(fs.readFileSync(recoveryPath, "utf-8")) as Record<string, unknown>;
      const completedAt = new Date().toISOString();
      writeJson(recoveryPath, {
        ...journal,
        progress: {
          ...(journal.progress as Record<string, unknown>),
          pushedAt: completedAt,
        },
        state: "complete",
        updatedAt: completedAt,
      });
      return Promise.resolve({ warnings: [], recoveryPath });
    });
    const retried = restarted.start(taskId, {
      resume: true,
      dockerResumeStateDir: pausedDir,
      provenance: { channel: "api-direct", principal: "retrying-operator" },
    });
    await flush(12);
    expect(retried.status).toBe("completed");
    expect(created).toHaveLength(2);
    expect(resumeDockerPromotedResult).toHaveBeenCalledTimes(1);
    expect(restarted.getDockerPausedRuntimeDir(taskId)).toBeUndefined();
    expect(dockerManager.releaseSealedResumeRef).toHaveBeenCalledTimes(1);
    expect(dockerManager.releaseSealedPublicationRef).toHaveBeenCalled();
  });

  test("refuses publication when a resumed result differs from its judge-approved diff hash", async () => {
    const taskId = "TASK-018-A";
    const parentTaskId = "TASK-018";
    const sharedBranchName = "quack/TASK-018";
    const child = new FakeChild();
    const runtimeDir = path.join(worktreePath, ".quack", "docker-runtime", randomUUID());
    const approvedDiff = "diff --git a/README.md b/README.md\n+approved\n";
    const resultDiff = "diff --git a/README.md b/README.md\n+different\n";
    const approvedDiffHash = createHash("sha256").update(approvedDiff, "utf-8").digest("hex");
    const sourceSessionId = `quack-${taskId}-${randomUUID()}`;
    const sourceOwnershipId = randomUUID();
    fs.mkdirSync(runtimeDir, { recursive: true });

    const dockerManager = {
      reconcileExistingContainers: jest.fn().mockResolvedValue({
        discoveredTaskIds: [],
        ambiguousContainerIds: [],
        removedTaskIds: [],
        failedTaskIds: [],
      }),
      createContainer: jest.fn().mockResolvedValue({
        containerId: "container-diff-mismatch",
        containerName: "container-diff-mismatch",
        taskId,
        image: "fixture",
        workDir: "/workspace",
        logsVolume: `/workspace/.quack/docker-runtime/${path.basename(runtimeDir)}`,
        worktreePath,
        runtimeLogDir: runtimeDir,
        gitDir: "/workspace/.quack/docker-git/diff-mismatch",
        privateGitDir: path.join(worktreePath, ".quack", "docker-git", "diff-mismatch"),
        gitObjectsDir: path.join(projectRoot, ".git", "objects"),
        dotGitOverlay: path.join(root, "overlay-diff-mismatch"),
        authoritativeRef: `refs/heads/${sharedBranchName}`,
        authoritativeHead: baseHead,
        authoritativeWorktreeGitDir: path.dirname(
          fs.realpathSync.native(
            path.resolve(
              worktreePath,
              fs
                .readFileSync(path.join(worktreePath, ".git"), "utf-8")
                .trim()
                .replace(/^gitdir:\s*/i, ""),
            ),
          ),
        ),
        resumeSource: {
          archiveName: `resume-${sourceOwnershipId}`,
          dispatchSessionId: sourceSessionId,
          eventSessionId: sourceSessionId,
          ownershipId: sourceOwnershipId,
          approvedGate: "judge" as const,
          approvedDiffHash,
          gitState: {
            authoritativeRef: `refs/heads/${sharedBranchName}`,
            baseHead,
            candidateHead: "b".repeat(40),
            sealedRef: `refs/quack/docker-resume/${taskId}/${sourceOwnershipId}`,
          },
          parentTaskId,
          sharedBranchName,
        },
        parentTaskId,
        sharedBranchName,
        startedAt: new Date().toISOString(),
        status: "running" as const,
      }),
      execAgent: jest.fn(() => child),
      stopContainer: jest.fn(() => Promise.resolve({ removed: true, retained: false })),
      forceRemoveContainer: jest.fn(() => Promise.resolve(true)),
      extractResults: jest.fn(() =>
        Promise.resolve({ diff: resultDiff, log: "candidate", branch: sharedBranchName }),
      ),
      sealPrivateGitForResume: jest.fn(),
      preparePrivateGitForPublication: jest.fn(),
      sealPreparedPublicationRef: jest.fn((binding: unknown) => binding),
      releaseSealedResumeRef: jest.fn(() => true),
      releaseSealedPublicationRef: jest.fn(() => true),
      getActiveContainers: jest.fn(() => []),
      getTrackedContainers: jest.fn(() => []),
      abortPendingCommands: jest.fn(),
      cleanupAll: jest.fn(() => Promise.resolve({ removedTaskIds: [], failedTaskIds: [] })),
      getContainer: jest.fn(),
      containerPathForHost: jest.fn(() => "/quack-runtime/dist/index.js"),
    };
    const manager = new DispatchManager(projectRoot, path.join(projectRoot, "dist", "index.js"), {
      method: "docker",
      docker: {
        image: "fixture",
        volumes: [],
        envPassthrough: [],
        resourceLimits: { memoryMb: 512, cpus: 1 },
        networkMode: "none",
        cleanupPolicy: "remove",
      },
    });
    (manager as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;
    (manager as unknown as { createWorktree(): string }).createWorktree = () => worktreePath;
    (manager as unknown as { removeWorktree(): void }).removeWorktree = () => undefined;

    const job = manager.start(taskId, {
      skipGate: true,
      parentTaskId,
      sharedBranchName,
      provenance: { channel: "api-direct", principal: "approving-operator" },
    });
    await flush();
    fs.appendFileSync(
      path.join(runtimeDir, `events-${job.sessionId}.jsonl`),
      `${JSON.stringify({
        sessionId: job.sessionId,
        taskId,
        project: path.basename(projectRoot),
        timestamp: new Date().toISOString(),
        stage: "session_start",
        payload: {
          model: "fixture",
          maxTurns: 10,
          maxBudget: 1,
          taskId,
          federated: false,
          provenance: { channel: "api-direct", principal: "approving-operator" },
        },
      })}\n`,
      "utf-8",
    );
    child.emit("exit", 0, null);
    await flush(12);

    expect(createHash("sha256").update(resultDiff, "utf-8").digest("hex")).not.toBe(
      approvedDiffHash,
    );
    expect(job.status).toBe("failed");
    expect(job.output.join("\n")).toContain(
      "resumed Git result differs from the exact judge-approved diff",
    );
    expect(dockerManager.extractResults).toHaveBeenCalledTimes(1);
    expect(dockerManager.preparePrivateGitForPublication).not.toHaveBeenCalled();
    expect(initializeDockerPublicationRecovery).not.toHaveBeenCalled();
    expect(publishDockerPromotedResult).not.toHaveBeenCalled();
    expect(job.publicationRecoveryPath).toBeUndefined();
  });

  test("completed publication preserves a worktree retained with its container", () => {
    const taskId = "TASK-KEEP";
    const publicationId = randomUUID();
    const retainedWorktree = path.join(projectRoot, ".quack", "worktrees", taskId);
    fs.mkdirSync(retainedWorktree, { recursive: true });
    const survivorPath = path.join(
      projectRoot,
      ".quack",
      "logs",
      "worktree-survivors",
      `${taskId}.json`,
    );
    writeJson(survivorPath, { retained: true });
    const recoveryPath = path.join(
      projectRoot,
      ".quack",
      "logs",
      "docker-publications",
      `${taskId}-${publicationId}.json`,
    );
    const completedAt = new Date().toISOString();
    const journal: DockerPublicationJournal = {
      version: 1,
      publicationId,
      taskId,
      projectRoot: fs.realpathSync.native(projectRoot),
      branch: `quack/${taskId}`,
      targetBranch: "main",
      gitState: {
        authoritativeRef: `refs/heads/quack/${taskId}`,
        baseHead: "a".repeat(40),
        candidateHead: "b".repeat(40),
        sealedRef: `refs/quack/docker-publication/${taskId}/${publicationId}`,
      },
      worktreePath: fs.realpathSync.native(retainedWorktree),
      worktreeSessionId: `quack-${taskId}-${randomUUID()}`,
      worktreeOwnershipId: publicationId,
      preserveWorktree: true,
      requirements: {
        push: false,
        pullRequest: false,
        merge: false,
        status: false,
        cleanup: false,
      },
      progress: { promotedAt: completedAt },
      state: "complete",
      createdAt: completedAt,
      updatedAt: completedAt,
    };
    writeJson(recoveryPath, journal);

    const dockerManager = {
      releaseSealedResumeRef: jest.fn(() => true),
      releaseSealedPublicationRef: jest.fn(() => true),
    };
    const manager = new DispatchManager(projectRoot, path.join(projectRoot, "dist", "index.js"), {
      method: "docker",
      docker: {
        image: "fixture",
        volumes: [],
        envPassthrough: [],
        resourceLimits: { memoryMb: 512, cpus: 1 },
        networkMode: "none",
        cleanupPolicy: "always_keep",
      },
    });
    (manager as unknown as { dockerManager: typeof dockerManager }).dockerManager = dockerManager;
    const removeWorktree = jest.fn();
    (manager as unknown as { removeWorktree(worktree: string): void }).removeWorktree =
      removeWorktree;
    const job = {
      taskId,
      sessionId: journal.worktreeSessionId,
      pid: 0,
      startedAt: completedAt,
      status: "running" as const,
      output: [] as string[],
      worktreePath: retainedWorktree,
      worktreeOwnershipId: publicationId,
      publicationRecoveryPath: recoveryPath,
    };

    (
      manager as unknown as {
        finalizeDockerPublicationRecovery(
          currentJob: typeof job,
          currentRecoveryPath: string,
          currentJournal: DockerPublicationJournal,
        ): void;
      }
    ).finalizeDockerPublicationRecovery(job, recoveryPath, journal);

    expect(dockerManager.releaseSealedPublicationRef).toHaveBeenCalledWith(journal.gitState);
    expect(removeWorktree).not.toHaveBeenCalled();
    expect(fs.existsSync(retainedWorktree)).toBe(true);
    expect(fs.existsSync(survivorPath)).toBe(true);
    expect(fs.existsSync(recoveryPath)).toBe(false);
    expect(job.output.join("\n")).toContain("explicit cleanup is required");
  });
});
