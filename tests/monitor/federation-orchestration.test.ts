import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync, spawnSync } from "node:child_process";

import {
  acquireFederatedMergeLock,
  assertSafeGitRef,
  executeFederatedSquashMerge,
  readFederatedMergeLock,
  sealFederatedMergeBinding,
  setFederatedMergeLockRuntimeForTests,
  shouldReconcileFederatedJob,
} from "../../src/monitor/federation/orchestration.js";
import type { ProjectAdapter } from "../../src/core/adapter-loader.js";
import type { FederatedJobRecord } from "../../src/monitor/federation/types.js";
import { setFederatedJobLockOptionsForTests } from "../../src/monitor/federation/store.js";
import type {
  TrustedGitExecutionOptions,
  TrustedGitHubRepository,
  TrustedGitResult,
} from "../../src/worker/trusted-executable.js";
import { resolveTrustedExecutable } from "../../src/worker/trusted-executable.js";

const SOURCE_OID = "1111111111111111111111111111111111111111";
const MOVED_OID = "2222222222222222222222222222222222222222";
const MERGE_OID = "3333333333333333333333333333333333333333";
const TARGET_OID = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const PUBLICATION_NONCE = "00000000-0000-4000-8000-000000000001";
const REPOSITORY: TrustedGitHubRepository = {
  host: "github.com",
  owner: "trusted-owner",
  repo: "trusted-repo",
};
const HOST_GIT = resolveTrustedExecutable("git", process.cwd(), "test Git");

function gitResult(stdout = "", stderr = "", exitCode = 0): TrustedGitResult {
  return { stdout, stderr, exitCode };
}

function runRealGit(projectRoot: string, args: readonly string[]): TrustedGitResult {
  const result = spawnSync(HOST_GIT, [...args], {
    cwd: projectRoot,
    encoding: "utf-8",
    windowsHide: true,
  });
  return {
    exitCode: result.status ?? 1,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? result.error?.message ?? "",
  };
}

function createRealReceiptRepository(sourceCommitSha: string): {
  projectRoot: string;
  mergeCommitSha: string;
} {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-receipt-"));
  const projectRoot = path.join(fixtureRoot, "project");
  const remotePath = path.join(fixtureRoot, "remote.git");
  fs.mkdirSync(projectRoot);
  execFileSync(HOST_GIT, ["init", "--bare", remotePath], { encoding: "utf-8" });
  execFileSync(HOST_GIT, ["init", "--initial-branch=dev"], {
    cwd: projectRoot,
    encoding: "utf-8",
  });
  execFileSync(HOST_GIT, ["config", "user.name", "Quack Test"], { cwd: projectRoot });
  execFileSync(HOST_GIT, ["config", "user.email", "quack@example.invalid"], {
    cwd: projectRoot,
  });
  fs.writeFileSync(path.join(projectRoot, "receipt.txt"), "sealed publication\n", "utf-8");
  execFileSync(HOST_GIT, ["add", "receipt.txt"], { cwd: projectRoot });
  execFileSync(
    HOST_GIT,
    [
      "commit",
      "-m",
      "Federated publication",
      "-m",
      `Quack-Federated-Source: ${sourceCommitSha}\nQuack-Federated-Publication: ${PUBLICATION_NONCE}`,
    ],
    { cwd: projectRoot },
  );
  const mergeCommitSha = execFileSync(HOST_GIT, ["rev-parse", "HEAD"], {
    cwd: projectRoot,
    encoding: "utf-8",
  }).trim();
  execFileSync(HOST_GIT, ["remote", "add", "origin", remotePath], { cwd: projectRoot });
  execFileSync(HOST_GIT, ["push", "-u", "origin", "dev"], { cwd: projectRoot });
  execFileSync(HOST_GIT, ["config", "trailer.separators", "="], { cwd: projectRoot });
  return { projectRoot, mergeCommitSha };
}

function mergeRuntime(
  runGit: (
    projectRoot: string,
    args: readonly string[],
    options: TrustedGitExecutionOptions,
  ) => TrustedGitResult | Promise<TrustedGitResult>,
  repositories: TrustedGitHubRepository[] = [REPOSITORY],
) {
  const adapter = { projectRoot: "C:\\trusted-project" } as ProjectAdapter;
  let repositoryIndex = 0;
  return {
    loadAdapter: jest.fn(() => Promise.resolve(adapter)),
    resolveRepository: jest.fn(() => {
      const selected = repositories[Math.min(repositoryIndex, repositories.length - 1)];
      repositoryIndex += 1;
      if (!selected) throw new Error("missing repository fixture");
      return Promise.resolve(selected);
    }),
    runGit: jest.fn(
      (
        projectRoot: string,
        args: readonly string[],
        options: TrustedGitExecutionOptions,
      ): Promise<TrustedGitResult> => Promise.resolve(runGit(projectRoot, args, options)),
    ),
    createWorktreePath: jest.fn(() => "C:\\trusted-temp\\federation-merge"),
  };
}

function makeJob(overrides: Partial<FederatedJobRecord> = {}): FederatedJobRecord {
  return {
    jobId: "fed-task-001-test",
    taskId: "TASK-001",
    jobType: "dispatch",
    status: "queued",
    correlationId: "corr-task-001",
    requiredCapabilities: ["dispatch"],
    decision: {},
    createdAt: "2026-05-01T00:00:00.000Z",
    updatedAt: "2026-05-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("federation orchestration helpers", () => {
  test("shouldReconcileFederatedJob returns true for merge-ready review follow-up states", () => {
    expect(
      shouldReconcileFederatedJob(
        makeJob({
          status: "blocked",
          blockReasonCode: "review_linkage_required",
        }),
      ),
    ).toBe(true);

    expect(
      shouldReconcileFederatedJob(
        makeJob({
          status: "completed",
          nextAction: "record_merge_ready_review",
        }),
      ),
    ).toBe(true);

    expect(
      shouldReconcileFederatedJob(
        makeJob({
          status: "completed",
          autoMerge: true,
          nextAction: "merge_gate",
          branchName: "quack/TASK-001",
          commitSha: SOURCE_OID,
          targetBranch: "dev",
          mergeBinding: {
            version: 1,
            repository: REPOSITORY,
            sourceBranch: "quack/TASK-001",
            sourceCommitSha: SOURCE_OID,
            targetBranch: "dev",
            publicationNonce: PUBLICATION_NONCE,
            sealedAt: "2026-09-10T00:00:00.000Z",
          },
        }),
      ),
    ).toBe(true);

    expect(
      shouldReconcileFederatedJob(
        makeJob({
          status: "completed",
          autoMerge: true,
          nextAction: "merge_gate",
          branchName: "quack/TASK-001",
          commitSha: SOURCE_OID,
          targetBranch: "dev",
        }),
      ),
    ).toBe(true);
  });

  test("shouldReconcileFederatedJob ignores terminal failure states and unrelated blocked jobs", () => {
    expect(
      shouldReconcileFederatedJob(
        makeJob({
          status: "failed",
          error: "verification_failed",
        }),
      ),
    ).toBe(false);

    expect(
      shouldReconcileFederatedJob(
        makeJob({
          status: "blocked",
          blockReasonCode: "pending_manual_handoff",
          error: "task_not_found",
        }),
      ),
    ).toBe(false);
  });

  test("serializes two contenders while recovering stale merge and reclamation locks", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-lock-race-"));
    const federationDir = path.join(projectRoot, ".quack", "federation");
    const lockPath = path.join(federationDir, "merge.lock");
    const reclaimPath = `${lockPath}.reclaim`;
    fs.mkdirSync(federationDir, { recursive: true });
    const staleRecord = {
      version: 1,
      jobId: "interrupted-job",
      taskId: "TASK-000",
      ownerToken: "00000000-0000-4000-8000-000000000099",
      processId: 999999,
      acquiredAt: "2020-01-01T00:00:00.000Z",
    };
    fs.writeFileSync(lockPath, JSON.stringify(staleRecord), "utf-8");
    fs.writeFileSync(reclaimPath, JSON.stringify(staleRecord), "utf-8");
    const staleTime = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(lockPath, staleTime, staleTime);
    fs.utimesSync(reclaimPath, staleTime, staleTime);

    let releaseAdmission!: () => void;
    const admissionGate = new Promise<void>((resolve) => {
      releaseAdmission = resolve;
    });
    let firstAdmissionHeld!: () => void;
    const firstHeld = new Promise<void>((resolve) => {
      firstAdmissionHeld = resolve;
    });
    let admissionReleaseCount = 0;
    setFederatedJobLockOptionsForTests({
      retryMs: 2,
      waitTimeoutMs: 1_000,
      staleMs: 40,
      heartbeatMs: 5,
      currentProcessIdentityForTest: { bootId: "merge-lock-test", startedAt: "1" },
      processIdentityProbeForTest: (pid) =>
        Promise.resolve(
          pid === process.pid
            ? {
                state: "alive",
                identity: { bootId: "merge-lock-test", startedAt: "1" },
              }
            : { state: "dead" },
        ),
      beforeReleaseForTest: async ({ lockPath: heldPath }) => {
        if (!heldPath.endsWith("__federated-merge-admission__.lock")) return;
        admissionReleaseCount += 1;
        if (admissionReleaseCount !== 1) return;
        firstAdmissionHeld();
        await admissionGate;
      },
    });

    try {
      const first = acquireFederatedMergeLock(projectRoot, "fed-task-001-a", "TASK-001");
      await firstHeld;
      let secondSettled = false;
      const second = acquireFederatedMergeLock(projectRoot, "fed-task-002-b", "TASK-002").finally(
        () => {
          secondSettled = true;
        },
      );
      await new Promise<void>((resolve) => setTimeout(resolve, 20));
      expect(secondSettled).toBe(false);
      releaseAdmission();
      const contenders = await Promise.all([first, second]);
      const winners = contenders.filter((token): token is string => Boolean(token));
      expect(winners).toHaveLength(1);
      expect(JSON.parse(fs.readFileSync(lockPath, "utf-8"))).toMatchObject({
        ownerToken: winners[0],
      });
      expect(
        fs.readdirSync(federationDir).filter((entry) => entry.startsWith("merge.lock.reclaim")),
      ).toEqual([]);
    } finally {
      setFederatedJobLockOptionsForTests(undefined);
      releaseAdmission();
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("never steals an aged merge lock from its exact live process incarnation", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-live-merge-"));
    const lockPath = path.join(projectRoot, ".quack", "federation", "merge.lock");
    const identity = { bootId: "merge-lock-live", startedAt: "100" };
    setFederatedJobLockOptionsForTests({
      currentProcessIdentityForTest: identity,
      processIdentityProbeForTest: () => Promise.resolve({ state: "alive", identity }),
    });

    try {
      const first = await acquireFederatedMergeLock(projectRoot, "fed-task-live-a", "TASK-001");
      expect(first).toBeDefined();
      const record = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as Record<string, unknown>;
      record.acquiredAt = "2020-01-01T00:00:00.000Z";
      fs.writeFileSync(lockPath, JSON.stringify(record), "utf-8");
      const stale = new Date("2020-01-01T00:00:00.000Z");
      fs.utimesSync(lockPath, stale, stale);

      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-live-b", "TASK-002"),
      ).resolves.toBeUndefined();
      expect(JSON.parse(fs.readFileSync(lockPath, "utf-8"))).toMatchObject({
        ownerToken: first,
        processIdentity: identity,
      });
    } finally {
      setFederatedJobLockOptionsForTests(undefined);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("does not reclaim a byte-identical merge-lock replacement after stale authorization", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-stale-inode-"));
    const federationDir = path.join(projectRoot, ".quack", "federation");
    const lockPath = path.join(federationDir, "merge.lock");
    const ownerToken = "00000000-0000-4000-8000-000000000095";
    const ownerArtifact = `merge.lock.owner.${ownerToken}`;
    const staleOwner = {
      version: 2,
      jobId: "fed-task-stale-owner",
      taskId: "TASK-000",
      ownerToken,
      host: os.hostname(),
      processId: 995_001,
      processIdentity: { bootId: "stale-boot", startedAt: "1" },
      ownerArtifact,
      acquiredAt: "2020-01-01T00:00:00.000Z",
    };
    fs.mkdirSync(federationDir, { recursive: true });
    fs.writeFileSync(path.join(federationDir, ownerArtifact), JSON.stringify(staleOwner), "utf-8");
    fs.linkSync(path.join(federationDir, ownerArtifact), lockPath);
    let replacementIdentity: { dev: number; ino: number } | undefined;
    setFederatedJobLockOptionsForTests({
      currentProcessIdentityForTest: { bootId: "current-boot", startedAt: "2" },
      processIdentityProbeForTest: () => Promise.resolve({ state: "dead" }),
    });
    setFederatedMergeLockRuntimeForTests({
      renamePath: async (source, destination) => {
        if (
          source === lockPath &&
          path.basename(destination).startsWith("merge.lock.reclaim-quarantine.")
        ) {
          const bytes = fs.readFileSync(source);
          fs.unlinkSync(source);
          fs.writeFileSync(source, bytes);
          const stat = fs.lstatSync(source);
          replacementIdentity = { dev: stat.dev, ino: stat.ino };
        }
        await fs.promises.rename(source, destination);
      },
    });

    try {
      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-contender", "TASK-001"),
      ).resolves.toBeUndefined();
      expect(replacementIdentity).toBeDefined();
      const surviving = fs.lstatSync(lockPath);
      expect({ dev: surviving.dev, ino: surviving.ino }).toEqual(replacementIdentity);
      expect(await readFederatedMergeLock(projectRoot)).toMatchObject(staleOwner);
    } finally {
      setFederatedMergeLockRuntimeForTests(undefined);
      setFederatedJobLockOptionsForTests(undefined);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("binds stale merge-lock bytes and identity through one opened handle", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-snapshot-inode-"));
    const federationDir = path.join(projectRoot, ".quack", "federation");
    const lockPath = path.join(federationDir, "merge.lock");
    const ownerToken = "00000000-0000-4000-8000-000000000097";
    const ownerArtifact = `merge.lock.owner.${ownerToken}`;
    const ownerPath = path.join(federationDir, ownerArtifact);
    const staleOwner = {
      version: 2,
      jobId: "fed-task-snapshot-owner",
      taskId: "TASK-000",
      ownerToken,
      host: os.hostname(),
      processId: 997_001,
      processIdentity: { bootId: "stale-boot", startedAt: "1" },
      ownerArtifact,
      acquiredAt: "2020-01-01T00:00:00.000Z",
    };
    fs.mkdirSync(federationDir, { recursive: true });
    fs.writeFileSync(ownerPath, JSON.stringify(staleOwner), "utf-8");
    fs.linkSync(ownerPath, lockPath);
    let swapped = false;
    let replacementIdentity: { dev: number; ino: number } | undefined;
    setFederatedJobLockOptionsForTests({
      currentProcessIdentityForTest: { bootId: "current-boot", startedAt: "2" },
      processIdentityProbeForTest: () => Promise.resolve({ state: "dead" }),
    });
    setFederatedMergeLockRuntimeForTests({
      afterSnapshotReadForTest: (target) => {
        if (swapped || target !== lockPath) return;
        swapped = true;
        const bytes = fs.readFileSync(lockPath);
        fs.unlinkSync(lockPath);
        fs.writeFileSync(lockPath, bytes);
        const stat = fs.lstatSync(lockPath);
        replacementIdentity = { dev: stat.dev, ino: stat.ino };
      },
    });

    try {
      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-snapshot-contender", "TASK-001"),
      ).resolves.toBeUndefined();
      expect(swapped).toBe(true);
      const surviving = fs.lstatSync(lockPath);
      expect({ dev: surviving.dev, ino: surviving.ino }).toEqual(replacementIdentity);
      expect(await readFederatedMergeLock(projectRoot)).toMatchObject(staleOwner);

      setFederatedMergeLockRuntimeForTests({});
      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-snapshot-next", "TASK-002"),
      ).resolves.toEqual(expect.any(String));
      expect(await readFederatedMergeLock(projectRoot)).toMatchObject({
        jobId: "fed-task-snapshot-next",
      });
    } finally {
      setFederatedMergeLockRuntimeForTests(undefined);
      setFederatedJobLockOptionsForTests(undefined);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("restores an interrupted stale-merge quarantine before a later acquisition", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-stale-crash-"));
    const federationDir = path.join(projectRoot, ".quack", "federation");
    const lockPath = path.join(federationDir, "merge.lock");
    const ownerToken = "00000000-0000-4000-8000-000000000096";
    const ownerArtifact = `merge.lock.owner.${ownerToken}`;
    const staleOwner = {
      version: 2,
      jobId: "fed-task-stale-crash",
      taskId: "TASK-000",
      ownerToken,
      host: os.hostname(),
      processId: 996_001,
      processIdentity: { bootId: "stale-boot", startedAt: "1" },
      ownerArtifact,
      acquiredAt: "2020-01-01T00:00:00.000Z",
    };
    fs.mkdirSync(federationDir, { recursive: true });
    fs.writeFileSync(path.join(federationDir, ownerArtifact), JSON.stringify(staleOwner), "utf-8");
    fs.linkSync(path.join(federationDir, ownerArtifact), lockPath);
    let interrupted = false;
    setFederatedJobLockOptionsForTests({
      currentProcessIdentityForTest: { bootId: "current-boot", startedAt: "2" },
      processIdentityProbeForTest: () => Promise.resolve({ state: "dead" }),
    });
    setFederatedMergeLockRuntimeForTests({
      renamePath: async (source, destination) => {
        await fs.promises.rename(source, destination);
        if (
          !interrupted &&
          source === lockPath &&
          path.basename(destination).startsWith("merge.lock.reclaim-quarantine.")
        ) {
          interrupted = true;
          const error = new Error("injected post-rename interruption") as NodeJS.ErrnoException;
          error.code = "EIO";
          throw error;
        }
      },
    });

    try {
      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-crash-a", "TASK-001"),
      ).rejects.toThrow("injected post-rename interruption");
      expect(fs.existsSync(lockPath)).toBe(false);
      expect(
        fs
          .readdirSync(federationDir)
          .some((entry) => entry.startsWith("merge.lock.reclaim-quarantine.")),
      ).toBe(true);

      setFederatedMergeLockRuntimeForTests({});
      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-crash-b", "TASK-002"),
      ).resolves.toBeUndefined();
      expect(await readFederatedMergeLock(projectRoot)).toMatchObject(staleOwner);
      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-crash-c", "TASK-003"),
      ).resolves.toEqual(expect.any(String));
    } finally {
      setFederatedMergeLockRuntimeForTests(undefined);
      setFederatedJobLockOptionsForTests(undefined);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("bounds merge-owner scavenger probes by examined artifacts", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-owner-scan-"));
    const federationDir = path.join(projectRoot, ".quack", "federation");
    const identity = { bootId: "live-owner-boot", startedAt: "1" };
    fs.mkdirSync(federationDir, { recursive: true });
    let deadOwnerPath = "";
    for (let index = 0; index < 24; index += 1) {
      const ownerToken = `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`;
      const ownerArtifact = `merge.lock.owner.${ownerToken}`;
      const artifactPath = path.join(federationDir, ownerArtifact);
      fs.writeFileSync(
        artifactPath,
        JSON.stringify({
          version: 2,
          jobId: `historical-${index}`,
          taskId: `TASK-${index}`,
          ownerToken,
          host: os.hostname(),
          processId: 990_000 + index,
          processIdentity: identity,
          ownerArtifact,
          acquiredAt: "2020-01-01T00:00:00.000Z",
        }),
        "utf-8",
      );
      if (index === 20) deadOwnerPath = artifactPath;
    }
    let probes = 0;
    setFederatedJobLockOptionsForTests({
      currentProcessIdentityForTest: { bootId: "current-boot", startedAt: "2" },
      processIdentityProbeForTest: (pid) => {
        probes += 1;
        return Promise.resolve(pid === 990_020 ? { state: "dead" } : { state: "alive", identity });
      },
    });

    try {
      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-owner-scan", "TASK-001"),
      ).resolves.toEqual(expect.any(String));
      expect(probes).toBe(16);
      const beforeSecond = probes;
      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-owner-scan-two", "TASK-002"),
      ).resolves.toBeUndefined();
      expect(probes - beforeSecond).toBeLessThanOrEqual(16);
      expect(fs.existsSync(deadOwnerPath)).toBe(false);
    } finally {
      setFederatedJobLockOptionsForTests(undefined);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("publishes a complete canonical merge lock from a synced owner artifact", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-atomic-merge-"));
    const federationDir = path.join(projectRoot, ".quack", "federation");
    const lockPath = path.join(federationDir, "merge.lock");
    const interruptedOwner = path.join(federationDir, "merge.lock.owner.interrupted");
    fs.mkdirSync(federationDir, { recursive: true });
    fs.writeFileSync(interruptedOwner, "{", "utf-8");

    try {
      const ownerToken = await acquireFederatedMergeLock(
        projectRoot,
        "fed-task-atomic-a",
        "TASK-001",
      );
      expect(ownerToken).toBeDefined();
      const record = await readFederatedMergeLock(projectRoot);
      expect(record).toMatchObject({
        version: 2,
        jobId: "fed-task-atomic-a",
        taskId: "TASK-001",
        ownerToken,
      });
      const ownerArtifact = record?.ownerArtifact;
      expect(typeof ownerArtifact).toBe("string");
      const ownerPath = path.join(federationDir, ownerArtifact as string);
      const [canonicalStat, ownerStat] = [fs.lstatSync(lockPath), fs.lstatSync(ownerPath)];
      expect({ dev: canonicalStat.dev, ino: canonicalStat.ino }).toEqual({
        dev: ownerStat.dev,
        ino: ownerStat.ino,
      });
      expect(fs.readFileSync(ownerPath, "utf-8")).toBe(fs.readFileSync(lockPath, "utf-8"));
      expect(fs.existsSync(interruptedOwner)).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("recovers a merge lock after directory sync fails immediately after publication", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-sync-merge-"));
    const federationDir = path.join(projectRoot, ".quack", "federation");
    const syncFailure = new Error("injected merge directory sync failure");
    setFederatedMergeLockRuntimeForTests({
      syncDirectory: () => Promise.reject(syncFailure),
    });

    try {
      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-sync-a", "TASK-001"),
      ).rejects.toThrow(
        process.platform === "win32"
          ? "injected merge directory sync failure"
          : "Federation merge lock publication could not be made recoverable",
      );
      expect(
        fs.readdirSync(federationDir).some((entry) => entry.startsWith("merge.lock.release.")),
      ).toBe(true);

      setFederatedMergeLockRuntimeForTests({});
      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-sync-b", "TASK-002"),
      ).resolves.toEqual(expect.any(String));
      expect(await readFederatedMergeLock(projectRoot)).toMatchObject({
        jobId: "fed-task-sync-b",
      });
    } finally {
      setFederatedMergeLockRuntimeForTests(undefined);
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("keeps a malformed canonical merge lock fail closed", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-bad-merge-"));
    const lockPath = path.join(projectRoot, ".quack", "federation", "merge.lock");
    fs.mkdirSync(path.dirname(lockPath), { recursive: true });
    fs.writeFileSync(lockPath, "{", "utf-8");
    const stale = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(lockPath, stale, stale);

    try {
      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-malformed", "TASK-001"),
      ).resolves.toBeUndefined();
      await expect(readFederatedMergeLock(projectRoot)).rejects.toBeInstanceOf(SyntaxError);
      expect(fs.readFileSync(lockPath, "utf-8")).toBe("{");
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("keeps a malformed historical merge reclaim guard fail closed", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-bad-reclaim-"));
    const reclaimPath = path.join(projectRoot, ".quack", "federation", "merge.lock.reclaim");
    fs.mkdirSync(path.dirname(reclaimPath), { recursive: true });
    fs.writeFileSync(reclaimPath, "{", "utf-8");
    const stale = new Date("2020-01-01T00:00:00.000Z");
    fs.utimesSync(reclaimPath, stale, stale);

    try {
      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-malformed-guard", "TASK-001"),
      ).resolves.toBeUndefined();
      expect(fs.readFileSync(reclaimPath, "utf-8")).toBe("{");
      await expect(readFederatedMergeLock(projectRoot)).resolves.toBeUndefined();
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("rejects a copied merge release intent without hard-link provenance", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-copy-release-"));
    const federationDir = path.join(projectRoot, ".quack", "federation");
    const lockPath = path.join(federationDir, "merge.lock");

    try {
      const first = await acquireFederatedMergeLock(projectRoot, "fed-task-copy-a", "TASK-001");
      expect(first).toBeDefined();
      fs.copyFileSync(lockPath, path.join(federationDir, `merge.lock.release.${first}`));

      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-copy-b", "TASK-002"),
      ).resolves.toBeUndefined();
      expect(await readFederatedMergeLock(projectRoot)).toMatchObject({ ownerToken: first });
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("a delayed prior release cannot remove a replacement merge-lock owner", async () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-federation-old-release-"));
    const federationDir = path.join(projectRoot, ".quack", "federation");
    const lockPath = path.join(federationDir, "merge.lock");

    try {
      const priorToken = await acquireFederatedMergeLock(
        projectRoot,
        "fed-task-prior-owner",
        "TASK-001",
      );
      expect(priorToken).toBeDefined();
      const prior = JSON.parse(fs.readFileSync(lockPath, "utf-8")) as Record<string, unknown>;
      const priorOwnerPath = path.join(federationDir, prior.ownerArtifact as string);
      const priorReleasePath = path.join(federationDir, `merge.lock.release.${priorToken}`);
      const priorQuarantinePath = path.join(
        federationDir,
        `merge.lock.release-quarantine.${priorToken}`,
      );
      fs.linkSync(priorOwnerPath, priorReleasePath);
      fs.renameSync(lockPath, priorQuarantinePath);

      const replacementToken = "00000000-0000-4000-8000-0000000000aa";
      const replacementArtifact = `merge.lock.owner.${replacementToken}`;
      const replacementOwnerPath = path.join(federationDir, replacementArtifact);
      const replacement = {
        ...prior,
        jobId: "fed-task-replacement-owner",
        taskId: "TASK-002",
        ownerToken: replacementToken,
        ownerArtifact: replacementArtifact,
        acquiredAt: new Date().toISOString(),
      };
      fs.writeFileSync(replacementOwnerPath, JSON.stringify(replacement, null, 2), "utf-8");
      fs.linkSync(replacementOwnerPath, lockPath);

      await expect(
        acquireFederatedMergeLock(projectRoot, "fed-task-third-owner", "TASK-003"),
      ).resolves.toBeUndefined();
      expect(await readFederatedMergeLock(projectRoot)).toMatchObject({
        jobId: "fed-task-replacement-owner",
        ownerToken: replacementToken,
      });
      const [canonicalStat, replacementStat] = [
        fs.lstatSync(lockPath),
        fs.lstatSync(replacementOwnerPath),
      ];
      expect({ dev: canonicalStat.dev, ino: canonicalStat.ino }).toEqual({
        dev: replacementStat.dev,
        ino: replacementStat.ino,
      });
      expect(fs.existsSync(priorReleasePath)).toBe(false);
      expect(fs.existsSync(priorQuarantinePath)).toBe(false);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  test("assertSafeGitRef accepts normal refs and rejects dangerous values", () => {
    expect(() => assertSafeGitRef("origin/quack/TASK-884-B", "branchName")).not.toThrow();
    expect(() => assertSafeGitRef("dev", "targetBranch")).not.toThrow();

    expect(() => assertSafeGitRef("../evil", "branchName")).toThrow(
      "branchName contains unsafe characters.",
    );
    expect(() => assertSafeGitRef("-main", "targetBranch")).toThrow(
      "targetBranch contains unsafe characters.",
    );
  });

  test("seals the exact remote branch OID and audited repository", async () => {
    const runtime = mergeRuntime((_projectRoot, args) => {
      if (args[0] === "fetch") return gitResult();
      if (args[0] === "rev-parse") return gitResult(`${SOURCE_OID}\n`);
      throw new Error(`unexpected git call: ${args.join(" ")}`);
    });

    await expect(
      sealFederatedMergeBinding(
        {
          projectRoot: "C:\\trusted-project",
          taskId: "TASK-001",
          sourceBranch: "quack/TASK-001",
          sourceCommitSha: SOURCE_OID,
          targetBranch: "dev",
        },
        runtime,
      ),
    ).resolves.toMatchObject({
      version: 1,
      repository: REPOSITORY,
      sourceBranch: "quack/TASK-001",
      sourceCommitSha: SOURCE_OID,
      targetBranch: "dev",
    });
    expect(runtime.runGit).toHaveBeenCalledWith(
      "C:\\trusted-project",
      ["fetch", "origin", "refs/heads/quack/TASK-001:refs/remotes/origin/quack/TASK-001"],
      expect.objectContaining({ trustedBoundaryRoot: "C:\\trusted-project" }),
    );
  });

  test("refuses a branch that moved away from the reported completion commit", async () => {
    const runtime = mergeRuntime((_projectRoot, args) =>
      args[0] === "rev-parse" ? gitResult(`${MOVED_OID}\n`) : gitResult(),
    );

    await expect(
      sealFederatedMergeBinding(
        {
          projectRoot: "C:\\trusted-project",
          taskId: "TASK-001",
          sourceBranch: "quack/TASK-001",
          sourceCommitSha: SOURCE_OID,
          targetBranch: "dev",
        },
        runtime,
      ),
    ).rejects.toThrow("source branch no longer matches");
  });

  test("publishes only the sealed merge OID through the expected repository", async () => {
    const runtime = mergeRuntime((_projectRoot, args, options) => {
      if (args[0] === "rev-parse" && args[2] === "refs/remotes/origin/dev") {
        return gitResult(`${TARGET_OID}\n`);
      }
      if (args[0] === "rev-parse" && args[2]?.includes("origin/")) {
        return gitResult(`${SOURCE_OID}\n`);
      }
      if (args[0] === "rev-parse") return gitResult(`${MERGE_OID}\n`);
      if (args[0] === "status") return gitResult("M  src/example.ts\n");
      if (args[0] === "push") {
        expect(args).toEqual([
          "push",
          `--force-with-lease=refs/heads/dev:${TARGET_OID}`,
          "origin",
          `${MERGE_OID}:refs/heads/dev`,
        ]);
        expect(options.expectedRepository).toEqual(REPOSITORY);
      }
      return gitResult();
    });
    const binding = {
      version: 1 as const,
      repository: REPOSITORY,
      sourceBranch: "quack/TASK-001",
      sourceCommitSha: SOURCE_OID,
      targetBranch: "dev",
      publicationNonce: PUBLICATION_NONCE,
      sealedAt: "2026-09-10T00:00:00.000Z",
    };

    await expect(
      executeFederatedSquashMerge(
        {
          projectRoot: "C:\\trusted-project",
          taskId: "TASK-001",
          sourceBranch: binding.sourceBranch,
          sourceCommitSha: binding.sourceCommitSha,
          targetBranch: binding.targetBranch,
          binding,
        },
        runtime,
      ),
    ).resolves.toMatchObject({ ok: true, commitSha: MERGE_OID });
    expect(runtime.runGit).toHaveBeenCalledWith(
      "C:\\trusted-temp\\federation-merge",
      [
        "push",
        `--force-with-lease=refs/heads/dev:${TARGET_OID}`,
        "origin",
        `${MERGE_OID}:refs/heads/dev`,
      ],
      expect.objectContaining({ expectedRepository: REPOSITORY }),
    );
  });

  test.each([
    ["advance", "stale info: target advanced"],
    ["force-rewind", "stale info: target rewound"],
    ["deletion", "stale info: target deleted"],
  ])("refuses target %s after sealing its exact expected-old OID", async (_scenario, stderr) => {
    const runtime = mergeRuntime((_projectRoot, args) => {
      if (args[0] === "rev-parse" && args[2] === "refs/remotes/origin/dev") {
        return gitResult(`${TARGET_OID}\n`);
      }
      if (args[0] === "rev-parse" && args[2]?.includes("origin/")) {
        return gitResult(`${SOURCE_OID}\n`);
      }
      if (args[0] === "rev-parse") return gitResult(`${MERGE_OID}\n`);
      if (args[0] === "status") return gitResult("M  src/example.ts\n");
      if (args[0] === "push") {
        expect(args).toContain(`--force-with-lease=refs/heads/dev:${TARGET_OID}`);
        return gitResult("", stderr, 1);
      }
      return gitResult();
    });
    const binding = {
      version: 1 as const,
      repository: REPOSITORY,
      sourceBranch: "quack/TASK-001",
      sourceCommitSha: SOURCE_OID,
      targetBranch: "dev",
      publicationNonce: PUBLICATION_NONCE,
      sealedAt: "2026-09-10T00:00:00.000Z",
    };

    await expect(
      executeFederatedSquashMerge(
        {
          projectRoot: "C:\\trusted-project",
          taskId: "TASK-001",
          sourceBranch: binding.sourceBranch,
          sourceCommitSha: binding.sourceCommitSha,
          targetBranch: binding.targetBranch,
          binding,
        },
        runtime,
      ),
    ).resolves.toMatchObject({ ok: false, error: stderr });
  });

  test("refuses a source branch that advances after its binding was sealed", async () => {
    const runtime = mergeRuntime((_projectRoot, args) => {
      if (args[0] === "log") return gitResult();
      if (args[0] === "rev-parse") return gitResult(`${MOVED_OID}\n`);
      return gitResult();
    });
    const binding = {
      version: 1 as const,
      repository: REPOSITORY,
      sourceBranch: "quack/TASK-001",
      sourceCommitSha: SOURCE_OID,
      targetBranch: "dev",
      publicationNonce: PUBLICATION_NONCE,
      sealedAt: "2026-09-10T00:00:00.000Z",
    };

    await expect(
      executeFederatedSquashMerge(
        {
          projectRoot: "C:\\trusted-project",
          taskId: "TASK-001",
          sourceBranch: binding.sourceBranch,
          sourceCommitSha: binding.sourceCommitSha,
          targetBranch: binding.targetBranch,
          binding,
        },
        runtime,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "Federated source branch changed after merge was sealed.",
    });
    const calls = (
      runtime.runGit.mock.calls as Array<[string, readonly string[], TrustedGitExecutionOptions]>
    ).map(([, args]) => args);
    expect(calls.some((args) => args[0] === "worktree")).toBe(false);
    expect(calls.some((args) => args[0] === "push")).toBe(false);
  });

  test("fails closed when the trusted push destination is ambiguous", async () => {
    const runtime = mergeRuntime((_projectRoot, args, options) => {
      if (args[0] === "rev-parse" && args[2]?.includes("origin/")) {
        return gitResult(`${SOURCE_OID}\n`);
      }
      if (args[0] === "rev-parse") return gitResult(`${MERGE_OID}\n`);
      if (args[0] === "status") return gitResult("M  src/example.ts\n");
      if (args[0] === "push") {
        if (!options.expectedRepository) throw new Error("missing expected repository");
        throw new Error("Refusing Git push without one exact transport destination");
      }
      return gitResult();
    });
    const binding = {
      version: 1 as const,
      repository: REPOSITORY,
      sourceBranch: "quack/TASK-001",
      sourceCommitSha: SOURCE_OID,
      targetBranch: "dev",
      publicationNonce: PUBLICATION_NONCE,
      sealedAt: "2026-09-10T00:00:00.000Z",
    };

    await expect(
      executeFederatedSquashMerge(
        {
          projectRoot: "C:\\trusted-project",
          taskId: "TASK-001",
          sourceBranch: binding.sourceBranch,
          sourceCommitSha: binding.sourceCommitSha,
          targetBranch: binding.targetBranch,
          binding,
        },
        runtime,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "Refusing Git push without one exact transport destination",
    });
  });

  test("refuses a repository identity change before a persisted merge can resume", async () => {
    const runtime = mergeRuntime(
      () => gitResult(),
      [{ host: "github.com", owner: "attacker", repo: "redirect" }],
    );
    const binding = {
      version: 1 as const,
      repository: REPOSITORY,
      sourceBranch: "quack/TASK-001",
      sourceCommitSha: SOURCE_OID,
      targetBranch: "dev",
      publicationNonce: PUBLICATION_NONCE,
      sealedAt: "2026-09-10T00:00:00.000Z",
    };

    await expect(
      executeFederatedSquashMerge(
        {
          projectRoot: "C:\\trusted-project",
          taskId: "TASK-001",
          sourceBranch: binding.sourceBranch,
          sourceCommitSha: binding.sourceCommitSha,
          targetBranch: binding.targetBranch,
          binding,
        },
        runtime,
      ),
    ).resolves.toEqual({
      ok: false,
      error: "Federation repository changed after merge was sealed.",
      commands: 0,
    });
    expect(runtime.runGit).not.toHaveBeenCalled();
  });

  test("asks Git for the exact receipt across full history without emitting unrelated bodies", async () => {
    const runtime = mergeRuntime((_projectRoot, args) => {
      if (args[0] === "rev-parse") return gitResult(`${TARGET_OID}\n`);
      if (args.includes("log")) {
        return gitResult(
          [MERGE_OID, "\x1f", `${SOURCE_OID}\n`, "\x1f", `${PUBLICATION_NONCE}\n`, "\x1e"].join(""),
        );
      }
      return gitResult();
    });
    const binding = {
      version: 1 as const,
      repository: REPOSITORY,
      sourceBranch: "quack/TASK-001",
      sourceCommitSha: SOURCE_OID,
      targetBranch: "dev",
      publicationNonce: PUBLICATION_NONCE,
      sealedAt: "2026-09-10T00:00:00.000Z",
    };

    await expect(
      executeFederatedSquashMerge(
        {
          projectRoot: "C:\\trusted-project",
          taskId: "TASK-001",
          sourceBranch: binding.sourceBranch,
          sourceCommitSha: binding.sourceCommitSha,
          targetBranch: binding.targetBranch,
          binding,
        },
        runtime,
      ),
    ).resolves.toEqual({ ok: true, commitSha: MERGE_OID, commands: 1 });
    const calls = (
      runtime.runGit.mock.calls as Array<[string, readonly string[], TrustedGitExecutionOptions]>
    ).map(([, args]) => args);
    expect(calls.find((args) => args.includes("log"))).toEqual([
      "-c",
      "trailer.separators=:",
      "log",
      "--fixed-strings",
      `--grep=Quack-Federated-Publication: ${PUBLICATION_NONCE}`,
      "--max-count=2",
      "--format=%H%x1f%(trailers:key=Quack-Federated-Source,valueonly)%x1f%(trailers:key=Quack-Federated-Publication,valueonly)%x1e",
      "refs/remotes/origin/dev",
    ]);
    expect(calls).not.toContainEqual(
      expect.arrayContaining(["refs/heads/quack/TASK-001:refs/remotes/origin/quack/TASK-001"]),
    );
    expect(calls.some((args) => args[0] === "push")).toBe(false);
  });

  test("fails closed when a nonce-matched receipt names a different source commit", async () => {
    const runtime = mergeRuntime((_projectRoot, args) => {
      if (args[0] === "rev-parse") return gitResult(`${TARGET_OID}\n`);
      if (args.includes("log")) {
        return gitResult(`${MERGE_OID}\x1f${MOVED_OID}\n\x1f${PUBLICATION_NONCE}\n\x1e`);
      }
      return gitResult();
    });
    const binding = {
      version: 1 as const,
      repository: REPOSITORY,
      sourceBranch: "quack/TASK-001",
      sourceCommitSha: SOURCE_OID,
      targetBranch: "dev",
      publicationNonce: PUBLICATION_NONCE,
      sealedAt: "2026-09-10T00:00:00.000Z",
    };

    await expect(
      executeFederatedSquashMerge(
        {
          projectRoot: "C:\\trusted-project",
          taskId: "TASK-001",
          sourceBranch: binding.sourceBranch,
          sourceCommitSha: binding.sourceCommitSha,
          targetBranch: binding.targetBranch,
          binding,
        },
        runtime,
      ),
    ).resolves.toMatchObject({
      ok: false,
      error: "Federated publication receipt does not match the sealed source commit.",
    });
    const calls = (
      runtime.runGit.mock.calls as Array<[string, readonly string[], TrustedGitExecutionOptions]>
    ).map(([, args]) => args);
    expect(calls.some((args) => args[0] === "worktree")).toBe(false);
    expect(calls.some((args) => args[0] === "push")).toBe(false);
  });

  test("recovers a real receipt when repository trailer separators exclude colons", async () => {
    const fixture = createRealReceiptRepository(SOURCE_OID);
    const runtime = mergeRuntime((projectRoot, args) => runRealGit(projectRoot, args));
    const binding = {
      version: 1 as const,
      repository: REPOSITORY,
      sourceBranch: "quack/TASK-001",
      sourceCommitSha: SOURCE_OID,
      targetBranch: "dev",
      publicationNonce: PUBLICATION_NONCE,
      sealedAt: "2026-09-10T00:00:00.000Z",
    };

    try {
      expect(
        execFileSync(HOST_GIT, ["config", "--get", "trailer.separators"], {
          cwd: fixture.projectRoot,
          encoding: "utf-8",
        }).trim(),
      ).toBe("=");
      await expect(
        executeFederatedSquashMerge(
          {
            projectRoot: fixture.projectRoot,
            taskId: "TASK-001",
            sourceBranch: binding.sourceBranch,
            sourceCommitSha: binding.sourceCommitSha,
            targetBranch: binding.targetBranch,
            binding,
          },
          runtime,
        ),
      ).resolves.toEqual({ ok: true, commitSha: fixture.mergeCommitSha, commands: 1 });
      const calls = (
        runtime.runGit.mock.calls as Array<[string, readonly string[], TrustedGitExecutionOptions]>
      ).map(([, args]) => args);
      expect(calls.find((args) => args.includes("log"))?.slice(0, 3)).toEqual([
        "-c",
        "trailer.separators=:",
        "log",
      ]);
      expect(calls.some((args) => args.includes("worktree"))).toBe(false);
      expect(calls.some((args) => args.includes("push"))).toBe(false);
    } finally {
      fs.rmSync(path.dirname(fixture.projectRoot), { recursive: true, force: true });
    }
  });

  test("fails closed on a real non-colon-configured receipt for the wrong source", async () => {
    const fixture = createRealReceiptRepository(MOVED_OID);
    const runtime = mergeRuntime((projectRoot, args) => runRealGit(projectRoot, args));
    const binding = {
      version: 1 as const,
      repository: REPOSITORY,
      sourceBranch: "quack/TASK-001",
      sourceCommitSha: SOURCE_OID,
      targetBranch: "dev",
      publicationNonce: PUBLICATION_NONCE,
      sealedAt: "2026-09-10T00:00:00.000Z",
    };

    try {
      await expect(
        executeFederatedSquashMerge(
          {
            projectRoot: fixture.projectRoot,
            taskId: "TASK-001",
            sourceBranch: binding.sourceBranch,
            sourceCommitSha: binding.sourceCommitSha,
            targetBranch: binding.targetBranch,
            binding,
          },
          runtime,
        ),
      ).resolves.toMatchObject({
        ok: false,
        error: "Federated publication receipt does not match the sealed source commit.",
      });
      const calls = (
        runtime.runGit.mock.calls as Array<[string, readonly string[], TrustedGitExecutionOptions]>
      ).map(([, args]) => args);
      expect(calls.some((args) => args.includes("worktree"))).toBe(false);
      expect(calls.some((args) => args.includes("push"))).toBe(false);
    } finally {
      fs.rmSync(path.dirname(fixture.projectRoot), { recursive: true, force: true });
    }
  });
});
