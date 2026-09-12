import { execFile } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import {
  deleteAfterMerge,
  mergeBranchToTarget,
  type PreparedTargetMerge,
} from "../../src/dispatcher/branch-manager";
import {
  DockerPublicationIncompleteError,
  withDockerPublicationRecoveryLock,
} from "../../src/dispatcher/docker-host-publication";
import {
  resolveOriginRepository,
  type GitOriginIdentity,
} from "../../src/dispatcher/github-repository";

import * as trustedGit from "../../src/worker/trusted-executable";

const execFileAsync = promisify(execFile);
const actualTrustedGitResult = trustedGit.runTrustedGitResult;
const fixtureTransports = new Map<
  string,
  { projectRoot: string; remoteRoot: string; remoteUrl: string }
>();

function localFixtureTransport(cwd: string, args: readonly string[]): readonly string[] {
  if (!["push", "fetch", "ls-remote"].includes(args[0] ?? "")) return args;
  const fixture = fixtureTransports.get(path.resolve(cwd));
  if (!fixture) return args;
  let destinations = 0;
  const mapped = args.map((arg) => {
    if (arg !== "origin" && arg !== fixture.remoteUrl) return arg;
    destinations += 1;
    return fixture.remoteRoot;
  });
  if (destinations !== 1)
    throw new Error("Fixture transport requires one exact origin destination");
  return mapped;
}

// Only the final transport is substituted with this test's disposable bare repo.
// Production repository selection, local Git, source/target refs, prepared journal
// and recovery locks remain real. Trusted transport refusal has separate tests.
async function fixtureTrustedTransport(
  cwd: string,
  args: readonly string[],
  options: trustedGit.TrustedGitExecutionOptions,
): Promise<trustedGit.TrustedGitResult> {
  if (!["push", "fetch", "ls-remote"].includes(args[0] ?? ""))
    return actualTrustedGitResult(cwd, args, options);
  const common = await actualTrustedGitResult(cwd, ["rev-parse", "--git-common-dir"], options);
  if (common.exitCode !== 0) throw new Error("Fixture Git common directory is unavailable");
  const commonDirectory = fs.realpathSync(path.resolve(cwd, common.stdout.trim()));
  const fixture = [...fixtureTransports.values()].find(
    (entry) => fs.realpathSync(path.join(entry.projectRoot, ".git")) === commonDirectory,
  );
  if (!fixture) throw new Error("Refusing transport outside an owned publication fixture");
  const origin = await actualTrustedGitResult(
    cwd,
    ["remote", "get-url", "--push", "--all", "origin"],
    options,
  );
  if (origin.exitCode !== 0 || origin.stdout.trim() !== fixture.remoteUrl)
    throw new Error("Refusing a changed fixture origin identity");
  const repository = trustedGit.parseTrustedGitHubRepository(fixture.remoteUrl);
  if (args[0] === "push" && !options.expectedRepository)
    throw new Error("Refusing an unbound publication push in the fixture");
  if (
    options.expectedRepository &&
    (options.expectedRepository.host !== repository.host ||
      options.expectedRepository.owner !== repository.owner ||
      options.expectedRepository.repo !== repository.repo)
  )
    throw new Error("Refusing a mismatched publication repository in the fixture");
  let destinations = 0;
  const mapped = args.map((arg) => {
    if (arg !== "origin" && arg !== fixture.remoteUrl) return arg;
    destinations += 1;
    return fixture.remoteRoot;
  });
  if (destinations !== 1) throw new Error("Refusing an unexpected publication transport operand");
  let result: trustedGit.TrustedGitResult;
  try {
    const output = await execFileAsync("git", mapped, {
      cwd,
      encoding: "utf-8",
      windowsHide: true,
      timeout: options.timeoutMs,
      maxBuffer: options.maxBuffer,
    });
    result = { exitCode: 0, stdout: String(output.stdout), stderr: String(output.stderr) };
  } catch (error: unknown) {
    const failed = error as { code?: unknown; stdout?: string; stderr?: string };
    result = {
      exitCode: typeof failed.code === "number" ? failed.code : 1,
      stdout: failed.stdout ?? "",
      stderr: failed.stderr ?? String(error),
    };
  }
  const after = await actualTrustedGitResult(
    cwd,
    ["remote", "get-url", "--push", "--all", "origin"],
    options,
  );
  if (after.exitCode !== 0 || after.stdout.trim() !== fixture.remoteUrl)
    throw new Error("Fixture origin changed during publication transport");
  return result;
}

async function git(cwd: string, args: readonly string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const result = await execFileAsync("git", [...localFixtureTransport(cwd, args)], {
    cwd,
    encoding: "utf-8",
    ...(env ? { env: { ...process.env, ...env } } : {}),
  });
  return String(result.stdout).trim();
}

function adapter(projectRoot: string, strategy: "merge" | "rebase" | "squash"): ProjectAdapter {
  return {
    projectRoot,
    config: {
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "",
        autoPush: true,
        autoCreatePr: false,
        autoMerge: true,
        autoMergeTarget: "main",
        autoMergeStrategy: strategy,
      },
    },
  } as ProjectAdapter;
}

async function fixture(strategy: "merge" | "rebase" | "squash"): Promise<{
  root: string;
  projectRoot: string;
  taskId: string;
  branch: string;
  candidateHead: string;
  targetHead: string;
  preparedRef: string;
  adapter: ProjectAdapter;
  repository: GitOriginIdentity;
}> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), `quack-publication-${strategy}-`));
  const projectRoot = path.join(root, "project");
  const remoteRoot = path.join(root, "origin.git");
  const taskId = `TASK-${strategy.toUpperCase()}-RECOVERY`;
  const branch = `quack/${taskId}`;
  const preparedRef = `refs/quack/docker-publication-prepared/${taskId}/test`;
  fs.mkdirSync(projectRoot, { recursive: true });
  await git(projectRoot, ["init", "--initial-branch=main"]);
  await git(projectRoot, ["config", "user.email", "publication-test@example.invalid"]);
  await git(projectRoot, ["config", "user.name", "Publication Test"]);
  fs.writeFileSync(path.join(projectRoot, "base.txt"), "base\n", "utf-8");
  await git(projectRoot, ["add", "."]);
  await git(projectRoot, ["commit", "-m", "base"]);
  await git(root, ["init", "--bare", remoteRoot]);
  await git(projectRoot, ["remote", "add", "origin", remoteRoot]);
  await git(projectRoot, ["push", "-u", "origin", "main"]);

  await git(projectRoot, ["checkout", "-b", branch]);
  fs.writeFileSync(path.join(projectRoot, "candidate.txt"), `${strategy}\n`, "utf-8");
  await git(projectRoot, ["add", "candidate.txt"]);
  await git(projectRoot, ["commit", "-m", `[${taskId}] candidate`], {
    GIT_AUTHOR_DATE: "2020-01-01T00:00:00Z",
    GIT_COMMITTER_DATE: "2020-01-01T00:00:00Z",
  });
  const candidateHead = await git(projectRoot, ["rev-parse", "HEAD"]);
  await git(projectRoot, ["push", "-u", "origin", branch]);

  await git(projectRoot, ["checkout", "main"]);
  fs.writeFileSync(path.join(projectRoot, "target.txt"), "target advanced\n", "utf-8");
  await git(projectRoot, ["add", "target.txt"]);
  await git(projectRoot, ["commit", "-m", "advance target"]);
  const targetHead = await git(projectRoot, ["rev-parse", "HEAD"]);
  await git(projectRoot, ["push", "origin", "main"]);
  const remoteUrl = `https://${process.env.GH_HOST ?? "github.com"}/example-fixtures/${path.basename(root)}.git`;
  fixtureTransports.set(path.resolve(projectRoot), { projectRoot, remoteRoot, remoteUrl });
  await git(projectRoot, ["remote", "set-url", "origin", remoteUrl]);
  const repository = await resolveOriginRepository(projectRoot);
  return {
    root,
    projectRoot,
    taskId,
    branch,
    candidateHead,
    targetHead,
    preparedRef,
    adapter: adapter(projectRoot, strategy),
    repository,
  };
}

describe("candidate-bound no-PR publication recovery with real Git", () => {
  jest.setTimeout(60_000);

  beforeEach(() => {
    jest.spyOn(trustedGit, "runTrustedGitResult").mockImplementation(fixtureTrustedTransport);
  });
  afterEach(() => {
    jest.restoreAllMocks();
    fixtureTransports.clear();
  });

  test.each(["merge", "squash", "rebase"] as const)(
    "%s persists a prepared identity, replays an accepted target push, and cleans the exact source",
    async (strategy) => {
      const state = await fixture(strategy);
      try {
        let prepared: PreparedTargetMerge | undefined;
        await expect(
          mergeBranchToTarget(
            state.taskId,
            state.adapter,
            undefined,
            "main",
            undefined,
            state.branch,
            undefined,
            state.candidateHead,
            trustedGit.parseTrustedGitHubRepository(state.repository.pushUrl),
            {
              preparedRef: state.preparedRef,
              onPrepared: (value) => {
                prepared = value;
                throw new Error("simulated crash before the caller records merge completion");
              },
            },
            state.repository,
          ),
        ).rejects.toThrow(/simulated crash/);

        expect(prepared).toBeDefined();
        expect(prepared!.strategy).toBe(strategy);
        expect(prepared!.candidateHead).toBe(state.candidateHead);
        expect(prepared!.targetHead).toBe(state.targetHead);
        expect(prepared!.resultHead).toMatch(/^[a-f0-9]{40,64}$/u);
        expect(prepared!.preparedRef).toBe(state.preparedRef);
        expect(
          await git(state.projectRoot, ["ls-remote", "--heads", "origin", "refs/heads/main"]),
        ).toContain(state.targetHead);

        const evidence = prepared!;
        // Callback persistence failures are ambiguous: journal bytes may be
        // visible even though their final barrier reported an error. Keep the
        // exact ref so either journal outcome remains safely replayable.
        expect(await git(state.projectRoot, ["rev-parse", evidence.preparedRef])).toBe(
          evidence.resultHead,
        );
        await git(state.projectRoot, [
          "push",
          `--force-with-lease=refs/heads/main:${evidence.targetHead}`,
          "origin",
          `${evidence.resultHead}:refs/heads/main`,
        ]);
        await git(state.projectRoot, ["reset", "--hard", evidence.resultHead]);
        fs.writeFileSync(
          path.join(state.projectRoot, `after-${strategy}.txt`),
          "landed after publication\n",
          "utf-8",
        );
        await git(state.projectRoot, ["add", `after-${strategy}.txt`]);
        await git(state.projectRoot, ["commit", "-m", "advance after publication"]);
        const advancedTarget = await git(state.projectRoot, ["rev-parse", "HEAD"]);
        await git(state.projectRoot, ["push", "origin", "main"]);
        expect(advancedTarget).not.toBe(evidence.resultHead);

        const replayPrepared = jest.fn();
        const replay = await mergeBranchToTarget(
          state.taskId,
          state.adapter,
          undefined,
          "main",
          undefined,
          state.branch,
          undefined,
          state.candidateHead,
          trustedGit.parseTrustedGitHubRepository(state.repository.pushUrl),
          {
            prepared: evidence,
            preparedRef: state.preparedRef,
            onPrepared: replayPrepared,
          },
          state.repository,
        );
        expect(replay).toEqual({ success: true, mergeCommitSha: evidence.resultHead });
        expect(replayPrepared).not.toHaveBeenCalled();

        const cleanup = await deleteAfterMerge(state.branch, state.adapter, {
          minAgeDays: 0,
          expectedHeadCommit: state.candidateHead,
          expectedMergedCommit: evidence.resultHead,
          expectedOriginPushUrl: state.repository.pushUrl,
        });
        expect(cleanup).toEqual({ deleted: true, localDeleted: true, remoteDeleted: true });
        await expect(
          git(state.projectRoot, ["show-ref", "--verify", `refs/heads/${state.branch}`]),
        ).rejects.toBeDefined();
        expect(
          await git(state.projectRoot, [
            "ls-remote",
            "--heads",
            "origin",
            `refs/heads/${state.branch}`,
          ]),
        ).toBe("");
      } finally {
        fs.rmSync(state.root, { recursive: true, force: true });
      }
    },
  );

  test.each(["merge", "squash", "rebase"] as const)(
    "%s treats a target that already contains the sealed candidate as an idempotent success",
    async (strategy) => {
      const state = await fixture(strategy);
      try {
        // Model a hard crash after preservePreparedTarget won its CAS but
        // before the journal's onPrepared write became durable.
        await git(state.projectRoot, ["update-ref", state.preparedRef, state.candidateHead]);
        await git(state.projectRoot, [
          "merge",
          "--no-ff",
          state.candidateHead,
          "-m",
          `pre-integrate ${strategy}`,
        ]);
        const integratedTarget = await git(state.projectRoot, ["rev-parse", "HEAD"]);
        await git(state.projectRoot, ["push", "origin", "main"]);
        const onPrepared = jest.fn();

        const result = await mergeBranchToTarget(
          state.taskId,
          state.adapter,
          undefined,
          "main",
          undefined,
          state.branch,
          undefined,
          state.candidateHead,
          trustedGit.parseTrustedGitHubRepository(state.repository.pushUrl),
          { preparedRef: state.preparedRef, onPrepared },
          state.repository,
        );

        expect(result).toEqual({ success: true, mergeCommitSha: integratedTarget });
        expect(onPrepared).not.toHaveBeenCalled();
        expect(
          await git(state.projectRoot, ["ls-remote", "--heads", "origin", "refs/heads/main"]),
        ).toContain(integratedTarget);
        await expect(
          git(state.projectRoot, ["show-ref", "--verify", state.preparedRef]),
        ).rejects.toBeDefined();
      } finally {
        fs.rmSync(state.root, { recursive: true, force: true });
      }
    },
  );

  test.each(["squash", "rebase"] as const)(
    "%s treats an independently applied candidate patch as an idempotent success",
    async (strategy) => {
      const state = await fixture(strategy);
      try {
        fs.writeFileSync(path.join(state.projectRoot, "candidate.txt"), `${strategy}\n`, "utf-8");
        await git(state.projectRoot, ["add", "candidate.txt"]);
        await git(state.projectRoot, ["commit", "-m", `apply ${strategy} patch independently`]);
        const integratedTarget = await git(state.projectRoot, ["rev-parse", "HEAD"]);
        await git(state.projectRoot, ["push", "origin", "main"]);
        expect(
          await git(state.projectRoot, [
            "merge-base",
            "--is-ancestor",
            state.candidateHead,
            integratedTarget,
          ]).then(
            () => true,
            () => false,
          ),
        ).toBe(false);
        const onPrepared = jest.fn();

        const result = await mergeBranchToTarget(
          state.taskId,
          state.adapter,
          undefined,
          "main",
          undefined,
          state.branch,
          undefined,
          state.candidateHead,
          trustedGit.parseTrustedGitHubRepository(state.repository.pushUrl),
          { preparedRef: state.preparedRef, onPrepared },
          state.repository,
        );

        expect(result).toEqual({ success: true, mergeCommitSha: integratedTarget });
        expect(onPrepared).not.toHaveBeenCalled();
      } finally {
        fs.rmSync(state.root, { recursive: true, force: true });
      }
    },
  );

  test("squash does not mistake a historically applied then reverted patch for current content", async () => {
    const state = await fixture("squash");
    try {
      fs.writeFileSync(path.join(state.projectRoot, "candidate.txt"), "squash\n", "utf-8");
      await git(state.projectRoot, ["add", "candidate.txt"]);
      await git(state.projectRoot, ["commit", "-m", "apply candidate patch independently"]);
      await git(state.projectRoot, ["revert", "--no-edit", "HEAD"]);
      const revertedTarget = await git(state.projectRoot, ["rev-parse", "HEAD"]);
      await git(state.projectRoot, ["push", "origin", "main"]);
      let prepared: PreparedTargetMerge | undefined;

      const result = await mergeBranchToTarget(
        state.taskId,
        state.adapter,
        undefined,
        "main",
        undefined,
        state.branch,
        undefined,
        state.candidateHead,
        trustedGit.parseTrustedGitHubRepository(state.repository.pushUrl),
        {
          preparedRef: state.preparedRef,
          onPrepared: (value) => {
            prepared = value;
          },
        },
        state.repository,
      );

      expect(result.success).toBe(true);
      expect(result.mergeCommitSha).not.toBe(revertedTarget);
      expect(prepared?.resultHead).toBe(result.mergeCommitSha);
      expect(await git(state.projectRoot, ["show", `${result.mergeCommitSha}:candidate.txt`])).toBe(
        "squash",
      );
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("cleanup refuses a source branch that moved after its prepared result was validated", async () => {
    const state = await fixture("squash");
    try {
      let prepared: PreparedTargetMerge | undefined;
      await expect(
        mergeBranchToTarget(
          state.taskId,
          state.adapter,
          undefined,
          "main",
          undefined,
          state.branch,
          undefined,
          state.candidateHead,
          trustedGit.parseTrustedGitHubRepository(state.repository.pushUrl),
          {
            preparedRef: state.preparedRef,
            onPrepared: (value) => {
              prepared = value;
              throw new Error("stop after preparation");
            },
          },
          state.repository,
        ),
      ).rejects.toThrow(/stop after preparation/);
      const evidence = prepared!;
      await git(state.projectRoot, [
        "push",
        `--force-with-lease=refs/heads/main:${evidence.targetHead}`,
        "origin",
        `${evidence.resultHead}:refs/heads/main`,
      ]);
      await git(state.projectRoot, [
        "update-ref",
        `refs/heads/${state.branch}`,
        evidence.resultHead,
        state.candidateHead,
      ]);
      await git(state.projectRoot, [
        "push",
        `--force-with-lease=refs/heads/${state.branch}:${state.candidateHead}`,
        "origin",
        `${evidence.resultHead}:refs/heads/${state.branch}`,
      ]);

      const replay = await mergeBranchToTarget(
        state.taskId,
        state.adapter,
        undefined,
        "main",
        undefined,
        state.branch,
        undefined,
        state.candidateHead,
        trustedGit.parseTrustedGitHubRepository(state.repository.pushUrl),
        {
          prepared: evidence,
          preparedRef: state.preparedRef,
          onPrepared: jest.fn(),
        },
        state.repository,
      );
      expect(replay).toEqual({ success: true, mergeCommitSha: evidence.resultHead });

      const cleanup = await deleteAfterMerge(state.branch, state.adapter, {
        minAgeDays: 0,
        expectedHeadCommit: state.candidateHead,
        expectedMergedCommit: evidence.resultHead,
        expectedOriginPushUrl: state.repository.pushUrl,
      });
      expect(cleanup).toEqual({ deleted: false, reason: "head-mismatch" });
      expect(await git(state.projectRoot, ["rev-parse", `refs/heads/${state.branch}`])).toBe(
        evidence.resultHead,
      );
      expect(
        await git(state.projectRoot, [
          "ls-remote",
          "--heads",
          "origin",
          `refs/heads/${state.branch}`,
        ]),
      ).toContain(evidence.resultHead);
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("cleanup treats a real-Git stale leased deletion as success only when the remote ref is absent", async () => {
    const state = await fixture("squash");
    try {
      let prepared: PreparedTargetMerge | undefined;
      const publication = await mergeBranchToTarget(
        state.taskId,
        state.adapter,
        undefined,
        "main",
        undefined,
        state.branch,
        undefined,
        state.candidateHead,
        trustedGit.parseTrustedGitHubRepository(state.repository.pushUrl),
        {
          preparedRef: state.preparedRef,
          onPrepared: (value) => {
            prepared = value;
          },
        },
        state.repository,
      );
      expect(publication.success).toBe(true);
      await git(state.projectRoot, ["push", "origin", `:refs/heads/${state.branch}`]);

      const cleanup = await deleteAfterMerge(state.branch, state.adapter, {
        minAgeDays: 0,
        expectedHeadCommit: state.candidateHead,
        expectedMergedCommit: prepared!.resultHead,
        expectedOriginPushUrl: state.repository.pushUrl,
      });

      expect(cleanup).toEqual({ deleted: true, localDeleted: true, remoteDeleted: true });
      await expect(
        git(state.projectRoot, ["rev-parse", "--verify", `refs/heads/${state.branch}`]),
      ).rejects.toBeDefined();
      expect(
        await git(state.projectRoot, [
          "ls-remote",
          "--heads",
          "origin",
          `refs/heads/${state.branch}`,
        ]),
      ).toBe("");
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("cleanup retains an exact source after the target is reset off its prepared result", async () => {
    const state = await fixture("squash");
    try {
      let prepared: PreparedTargetMerge | undefined;
      const publication = await mergeBranchToTarget(
        state.taskId,
        state.adapter,
        undefined,
        "main",
        undefined,
        state.branch,
        undefined,
        state.candidateHead,
        trustedGit.parseTrustedGitHubRepository(state.repository.pushUrl),
        {
          preparedRef: state.preparedRef,
          onPrepared: (value) => {
            prepared = value;
          },
        },
        state.repository,
      );
      expect(publication.success).toBe(true);
      const evidence = prepared!;

      await git(state.projectRoot, [
        "update-ref",
        "-d",
        `refs/heads/${state.branch}`,
        state.candidateHead,
      ]);
      await git(state.projectRoot, [
        "push",
        `--force-with-lease=refs/heads/main:${evidence.resultHead}`,
        "origin",
        `${evidence.targetHead}:refs/heads/main`,
      ]);
      // This is the exact local restoration performed by the durable host
      // cleanup retry before it re-enters the shared cleanup policy.
      await git(state.projectRoot, [
        "update-ref",
        `refs/heads/${state.branch}`,
        state.candidateHead,
        "0".repeat(state.candidateHead.length),
      ]);

      const cleanup = await deleteAfterMerge(state.branch, state.adapter, {
        minAgeDays: 0,
        expectedHeadCommit: state.candidateHead,
        expectedMergedCommit: evidence.resultHead,
        expectedOriginPushUrl: state.repository.pushUrl,
      });

      expect(cleanup).toEqual({ deleted: false, reason: "not-merged" });
      expect(await git(state.projectRoot, ["rev-parse", `refs/heads/${state.branch}`])).toBe(
        state.candidateHead,
      );
      expect(
        await git(state.projectRoot, [
          "ls-remote",
          "--heads",
          "origin",
          `refs/heads/${state.branch}`,
        ]),
      ).toContain(state.candidateHead);
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("an orphaned deterministic prepared ref is replaced with an exact lease before retry", async () => {
    const state = await fixture("squash");
    try {
      // This is the durable footprint of a process dying after ref creation but
      // before its onPrepared journal write became visible.
      await git(state.projectRoot, ["update-ref", state.preparedRef, state.candidateHead]);
      let prepared: PreparedTargetMerge | undefined;
      const result = await mergeBranchToTarget(
        state.taskId,
        state.adapter,
        undefined,
        "main",
        undefined,
        state.branch,
        undefined,
        state.candidateHead,
        trustedGit.parseTrustedGitHubRepository(state.repository.pushUrl),
        {
          preparedRef: state.preparedRef,
          onPrepared: (value) => {
            prepared = value;
          },
        },
        state.repository,
      );

      expect(result).toEqual({ success: true, mergeCommitSha: prepared!.resultHead });
      expect(prepared!.resultHead).not.toBe(state.candidateHead);
      expect(await git(state.projectRoot, ["rev-parse", state.preparedRef])).toBe(
        prepared!.resultHead,
      );
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("atomically gives one concurrent recovery ownership after a dead lock", async () => {
    const state = await fixture("merge");
    const publicationId = "11111111-1111-4111-8111-111111111111";
    const sealedRef = `refs/quack/docker-publication/${state.taskId}/${publicationId}`;
    const lockRef = sealedRef.replace(
      "refs/quack/docker-publication/",
      "refs/quack/docker-publication-lock/",
    );
    const staleOwnerPath = path.join(state.root, "stale-lock-owner.json");
    const recoveryPath = path.join(state.root, `${state.taskId}-${publicationId}.json`);
    const staleOwner = {
      version: 1,
      publicationId,
      pid: 2_147_483_647,
      processStartedAt: "2020-01-01T00:00:00.000Z",
      processIncarnation: "test:dead",
      acquiredAt: "2020-01-01T00:00:00.000Z",
      nonce: "22222222-2222-4222-8222-222222222222",
    };
    try {
      fs.writeFileSync(staleOwnerPath, `${JSON.stringify(staleOwner)}\n`, "utf-8");
      const staleObject = await git(state.projectRoot, ["hash-object", "-w", "--", staleOwnerPath]);
      await git(state.projectRoot, ["update-ref", lockRef, staleObject]);

      let entered = 0;
      let releaseWinner!: () => void;
      const winnerGate = new Promise<void>((resolve) => {
        releaseWinner = resolve;
      });
      let signalEntered!: () => void;
      const enteredGate = new Promise<void>((resolve) => {
        signalEntered = resolve;
      });
      const identity = {
        projectRoot: state.projectRoot,
        publicationId,
        gitState: { sealedRef },
      };
      const contender = () =>
        withDockerPublicationRecoveryLock(recoveryPath, identity, async () => {
          entered += 1;
          signalEntered();
          await winnerGate;
          return "owned";
        });

      const attempts = [contender(), contender()];
      const settledAttempts = Promise.allSettled(attempts);
      await enteredGate;
      await new Promise<void>((resolve) => setTimeout(resolve, 100));
      expect(entered).toBe(1);
      releaseWinner();
      const settled = await settledAttempts;

      expect(settled.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      const rejection = settled.find((result) => result.status === "rejected");
      expect(rejection?.status).toBe("rejected");
      const rejectionReason: unknown =
        rejection?.status === "rejected" ? rejection.reason : undefined;
      expect(rejectionReason).toBeInstanceOf(DockerPublicationIncompleteError);
      if (!(rejectionReason instanceof DockerPublicationIncompleteError)) {
        throw new Error("expected the losing lock contender to fail validation");
      }
      expect(rejectionReason.step).toBe("validation");
      await expect(git(state.projectRoot, ["show-ref", "--verify", lockRef])).rejects.toBeDefined();
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("acquires and releases a missing durable lock ref with real Git", async () => {
    const state = await fixture("merge");
    const publicationId = "33333333-3333-4333-8333-333333333333";
    const sealedRef = `refs/quack/docker-publication/${state.taskId}/${publicationId}`;
    const lockRef = sealedRef.replace(
      "refs/quack/docker-publication/",
      "refs/quack/docker-publication-lock/",
    );
    const recoveryPath = path.join(state.root, `${state.taskId}-${publicationId}.json`);
    try {
      await expect(
        withDockerPublicationRecoveryLock(
          recoveryPath,
          {
            projectRoot: state.projectRoot,
            publicationId,
            gitState: { sealedRef },
          },
          () => Promise.resolve("owned"),
        ),
      ).resolves.toBe("owned");
      await expect(
        git(state.projectRoot, ["rev-parse", "--verify", "--quiet", lockRef]),
      ).rejects.toBeDefined();
    } finally {
      fs.rmSync(state.root, { recursive: true, force: true });
    }
  });

  test("allows the same publication lock ref to be held in two different repositories", async () => {
    const first = await fixture("merge");
    const second = await fixture("merge");
    const publicationId = "44444444-4444-4444-8444-444444444444";
    const sealedRef = `refs/quack/docker-publication/${first.taskId}/${publicationId}`;
    try {
      await expect(
        withDockerPublicationRecoveryLock(
          path.join(first.root, `${first.taskId}-${publicationId}.json`),
          {
            projectRoot: first.projectRoot,
            publicationId,
            gitState: { sealedRef },
          },
          () =>
            withDockerPublicationRecoveryLock(
              path.join(second.root, `${second.taskId}-${publicationId}.json`),
              {
                projectRoot: second.projectRoot,
                publicationId,
                gitState: { sealedRef },
              },
              () => Promise.resolve("both-owned"),
            ),
        ),
      ).resolves.toBe("both-owned");
    } finally {
      fs.rmSync(first.root, { recursive: true, force: true });
      fs.rmSync(second.root, { recursive: true, force: true });
    }
  });
});
