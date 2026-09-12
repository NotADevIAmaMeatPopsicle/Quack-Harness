import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import type { DockerIsolationConfig } from "../../src/core/types";
import {
  clearDockerPublicationRecovery,
  initializeDockerPublicationRecovery,
  readDockerPublicationRecovery,
  type DockerHostPublicationOptions,
  type DockerHostPublicationResult,
  type DockerPublicationJournal,
} from "../../src/dispatcher/docker-host-publication";
import { DockerManager } from "../../src/dispatcher/docker-manager";
import {
  resolveTrustedDockerExecutable,
  trustedDockerEnvironment,
} from "../../src/dispatcher/docker-cleanup";
import {
  buildTrustedGitEnvironment,
  resolveTrustedExecutable,
} from "../../src/worker/trusted-executable";

const execFileAsync = promisify(execFile);
const describeWithDocker = process.env.QUACK_RUN_DOCKER_E2E === "1" ? describe : describe.skip;
const IMAGE =
  "node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d";
const ORIGIN = "https://quack-publication.invalid/fixture/docker-e2e.git";

interface PublicationPhaseReport {
  phase: "lost-response" | "resume";
  pid: number;
  processNonce: string;
  expectedFailure?: { step: string; message: string };
  result?: DockerHostPublicationResult;
  journal: DockerPublicationJournal;
  deliveries: Array<{
    kind: string;
    before: string | null;
    after: string | null;
    exitCode: number;
  }>;
}

describeWithDocker("DockerManager real Docker isolation", () => {
  jest.setTimeout(120_000);
  let activeBody: Promise<void> | undefined;
  let settled = true;
  let retainFixture = false;
  let fixtureRoot: string | undefined;

  afterAll(async () => {
    if (!activeBody || settled) return;
    // Jest timeout does not cancel a test body. Preserve its live ownership;
    // its own finally performs cleanup after all admitted operations return.
    retainFixture = true;
    let timer: NodeJS.Timeout | undefined;
    try {
      await Promise.race([
        activeBody.catch(() => undefined),
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, 5_000);
        }),
      ]);
      if (!settled) throw new Error(`Docker proof remains active; retained at ${fixtureRoot}`);
    } finally {
      if (timer) clearTimeout(timer);
    }
  });

  test("commits privately, then recovers exact host publication in a fresh process", () => {
    settled = false;
    activeBody = provePublication().finally(() => {
      settled = true;
    });
    return activeBody;
  });

  async function provePublication(): Promise<void> {
    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-e2e-"));
    fixtureRoot = tempRoot;
    const quackRoot = path.resolve(__dirname, "../..");
    const projectRoot = path.join(tempRoot, "project");
    const remoteRoot = path.join(tempRoot, "origin.git");
    const taskId = "TASK-990001";
    const branch = `quack/${taskId}`;
    const worktreePath = path.join(projectRoot, ".quack", "worktrees", taskId);
    const stateRoot = path.join(tempRoot, "state");
    const artifacts = process.env.QUACK_DOCKER_E2E_EVIDENCE_DIR
      ? path.join(path.resolve(process.env.QUACK_DOCKER_E2E_EVIDENCE_DIR), randomUUID())
      : fs.mkdtempSync(path.join(os.tmpdir(), "quack-docker-proof-evidence-"));
    fs.mkdirSync(artifacts, { recursive: true });
    const writeEvidence = (name: string, value: unknown) =>
      fs.writeFileSync(path.join(artifacts, name), `${JSON.stringify(value, null, 2)}\n`);
    const gitExecutable = resolveTrustedExecutable("git", quackRoot, "Docker fixture Git");
    const gitEnvironment = buildTrustedGitEnvironment(gitExecutable);
    const dockerExecutable = resolveTrustedDockerExecutable([quackRoot, tempRoot]);
    const dockerEnvironment = trustedDockerEnvironment(dockerExecutable);
    const git = async (cwd: string, ...args: string[]): Promise<string> => {
      const result = await execFileAsync(
        gitExecutable,
        ["-C", cwd, "-c", `core.hooksPath=${os.devNull}`, ...args],
        {
          cwd: path.dirname(gitExecutable),
          env: gitEnvironment,
          encoding: "utf8",
          windowsHide: true,
          timeout: 30_000,
          maxBuffer: 1024 * 1024,
        },
      );
      return result.stdout.trim();
    };
    const docker = async (...args: string[]): Promise<string> => {
      const result = await execFileAsync(dockerExecutable, args, {
        cwd: path.dirname(dockerExecutable),
        env: dockerEnvironment,
        encoding: "utf8",
        windowsHide: true,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
      });
      return result.stdout.trim();
    };
    const assertContainerAbsent = async (containerId: string): Promise<void> => {
      let missing = false;
      try {
        await docker("inspect", "--type", "container", containerId);
      } catch (error: unknown) {
        missing = /no such (?:object|container)/i.test(
          String((error as { stderr?: string }).stderr ?? error),
        );
      }
      expect(missing).toBe(true);
    };
    const config: DockerIsolationConfig = {
      image: IMAGE,
      volumes: [],
      envPassthrough: [],
      resourceLimits: { memoryMb: 512, cpus: 1 },
      networkMode: "none",
      cleanupPolicy: "remove",
    };
    let manager: DockerManager | undefined;
    let containerId: string | undefined;
    let worktreeCreated = false;
    let passed = false;
    let cleanupConfirmed = false;

    function removeVerifiedTempRoot(): void {
      const target = path.resolve(tempRoot);
      try {
        if (
          !target.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
          !path.basename(target).startsWith("quack-docker-e2e-")
        ) {
          throw new Error("Refusing cleanup outside this disposable fixture");
        }
        fs.rmSync(target, { recursive: true, force: true });
      } catch (error: unknown) {
        writeEvidence("outcome.json", {
          passed,
          cleanupConfirmed: false,
          retained: true,
          fixtureRoot: tempRoot,
          artifacts,
          cleanupError: String(error),
        });
        throw error;
      }
    }

    async function runPhase(
      phase: PublicationPhaseReport["phase"],
      recoveryPath: string,
      options: DockerHostPublicationOptions,
    ): Promise<PublicationPhaseReport> {
      const helper = path.join(quackRoot, "tests", "helpers", "docker-publication-process.cjs");
      const inputPath = path.join(artifacts, `${phase}-input.json`);
      const reportPath = path.join(artifacts, `${phase}-report.json`);
      fs.writeFileSync(
        inputPath,
        `${JSON.stringify(
          {
            phase,
            quackRoot,
            fixtureRoot: tempRoot,
            projectRoot,
            bareRoot: remoteRoot,
            taskId,
            branch,
            recoveryPath,
            options,
            reportPath,
            transportLog: path.join(artifacts, `${phase}-transport.jsonl`),
          },
          null,
          2,
        )}\n`,
      );
      try {
        const output = await execFileAsync(process.execPath, [helper, inputPath], {
          cwd: quackRoot,
          env: { ...gitEnvironment, NODE_ENV: "test", GH_HOST: "quack-publication.invalid" },
          windowsHide: true,
          encoding: "utf8",
          timeout: 90_000,
          maxBuffer: 1024 * 1024,
        });
        fs.writeFileSync(path.join(artifacts, `${phase}-stdout.txt`), output.stdout);
        fs.writeFileSync(path.join(artifacts, `${phase}-stderr.txt`), output.stderr);
        writeEvidence(`${phase}-exit.json`, {
          executable: process.execPath,
          helper,
          exitCode: 0,
          signal: null,
        });
      } catch (error: unknown) {
        const failure = error as {
          stdout?: string;
          stderr?: string;
          code?: unknown;
          signal?: unknown;
        };
        writeEvidence(`${phase}-failure.json`, {
          code: failure.code,
          signal: failure.signal,
          message: String(error),
        });
        fs.writeFileSync(path.join(artifacts, `${phase}-stdout.txt`), failure.stdout ?? "");
        fs.writeFileSync(path.join(artifacts, `${phase}-stderr.txt`), failure.stderr ?? "");
        throw error;
      }
      return JSON.parse(fs.readFileSync(reportPath, "utf8")) as PublicationPhaseReport;
    }

    try {
      const buildInfo = JSON.parse(
        fs.readFileSync(path.join(quackRoot, "dist", "build-info.json"), "utf8"),
      ) as { commit: string };
      const head = await git(quackRoot, "rev-parse", "HEAD");
      expect(head.startsWith(buildInfo.commit)).toBe(true);
      // Inspect this exact locally present digest before create; never pull.
      const image = JSON.parse(await docker("image", "inspect", IMAGE)) as Array<{
        Id: string;
        RepoDigests: string[];
      }>;
      expect(image).toHaveLength(1);
      expect(image[0].Id).toMatch(/^sha256:[a-f0-9]{64}$/);
      writeEvidence("identity.json", {
        head,
        buildInfo,
        node: process.version,
        git: await git(quackRoot, "--version"),
        image,
        fixtureRoot: tempRoot,
        artifacts,
        sourceHash: createHash("sha256").update(fs.readFileSync(__filename)).digest("hex"),
        helperHash: createHash("sha256")
          .update(
            fs.readFileSync(path.join(quackRoot, "tests/helpers/docker-publication-process.cjs")),
          )
          .digest("hex"),
        compiledPublicationHash: createHash("sha256")
          .update(
            fs.readFileSync(path.join(quackRoot, "dist/dispatcher/docker-host-publication.js")),
          )
          .digest("hex"),
      });
      fs.mkdirSync(path.join(projectRoot, ".quack", "prep"), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
      fs.mkdirSync(path.join(projectRoot, "docs", "tasks"), { recursive: true });
      fs.writeFileSync(
        path.join(projectRoot, ".quack", "adapter.json"),
        `${JSON.stringify(
          {
            version: "1.0",
            project: {
              name: "docker-e2e",
              root: ".",
              taskDir: "docs/tasks",
              conventionsDir: "docs",
            },
            agent: {
              model: "fixture",
              judgeModel: "fixture",
              enrichModel: "fixture",
              maxTurns: 10,
              maxBudgetPerTask: 1,
              maxRetries: 0,
            },
            verification: {
              commands: [{ name: "noop", command: "true", required: true, timeout: 1000 }],
              conventionChecks: [],
            },
            sandbox: { writablePaths: ["source.txt"], deniedPaths: [] },
            git: {
              baseBranch: "main",
              branchPrefix: "quack/",
              commitFormat: "[{taskId}] {message}",
              commitTrailer: "",
              autoPush: true,
              autoCreatePr: false,
              autoMerge: true,
              autoMergeTarget: "main",
              autoMergeStrategy: "squash",
              branchCleanup: { enabled: false },
            },
            logging: { dir: ".quack/logs", level: "info", retainDays: 1 },
          },
          null,
          2,
        )}\n`,
      );
      fs.writeFileSync(
        path.join(projectRoot, "docs", "tasks", `${taskId}.md`),
        `# ${taskId}: Docker publication fixture\n\n## Metadata\n- **Priority:** P1-HIGH\n- **Effort:** 1 hour\n- **Status:** READY\n- **Blocked By:** []\n- **Tags:** [test]\n\n## Problem Statement\nExercise private Git publication.\n\n## Current State\nThe fixture is unchanged.\n\n## Recommended Approach\nCommit one isolated edit.\n\n## Files to Modify\n| File | Action | Notes |\n|------|--------|-------|\n| source.txt | Modify | Add one line |\n\n## Success Criteria\n- [ ] The host publishes the exact container commit.\n\n## Testing Requirements\n- [ ] Verify the source checkout is untouched before host promotion.\n`,
      );
      fs.writeFileSync(
        path.join(projectRoot, ".gitignore"),
        ".quack/worktrees/\n.quack/logs/\n.quack/prep/\n",
      );
      fs.writeFileSync(path.join(projectRoot, "source.txt"), "authoritative\n");
      await git(projectRoot, "init", "--initial-branch=main");
      await git(projectRoot, "config", "user.email", "quack-e2e@example.invalid");
      await git(projectRoot, "config", "user.name", "Quack E2E");
      await git(projectRoot, "config", "commit.gpgsign", "false");
      await git(projectRoot, "add", ".");
      await git(projectRoot, "commit", "-m", "initial");
      await git(tempRoot, "init", "--bare", remoteRoot);
      // The sole setup push is to this explicit newly-created bare repository.
      await git(projectRoot, "push", remoteRoot, "main:refs/heads/main");
      await git(projectRoot, "remote", "add", "origin", ORIGIN);
      await git(projectRoot, "worktree", "add", "-b", branch, worktreePath, "HEAD");
      worktreeCreated = true;
      const base = await git(projectRoot, "rev-parse", "HEAD");

      manager = new DockerManager(projectRoot, config, stateRoot);
      writeEvidence("docker-version.json", { server: await manager.checkDocker() });
      const container = await manager.createContainer(taskId, worktreePath);
      containerId = container.containerId;
      writeEvidence("container.json", container);
      const metadata = [
        path.join(projectRoot, "source.txt"),
        path.join(projectRoot, ".git", "HEAD"),
        path.join(projectRoot, ".git", "config"),
        path.join(projectRoot, ".git", "index"),
        path.join(worktreePath, ".git"),
        ...["HEAD", "index", "commondir", "gitdir"].map((name) =>
          path.join(container.authoritativeWorktreeGitDir!, name),
        ),
      ];
      const snapshot = async () => ({
        refs: await git(projectRoot, "for-each-ref", "--format=%(refname) %(objectname)"),
        bareRefs: await git(remoteRoot, "for-each-ref", "--format=%(refname) %(objectname)"),
        files: Object.fromEntries(
          metadata.map((file) => [
            file,
            createHash("sha256").update(fs.readFileSync(file)).digest("hex"),
          ]),
        ),
      });
      const before = await snapshot();
      const child = manager.execAgent(container.containerId, [
        "sh",
        "-lc",
        [
          "git config --global --add safe.directory /workspace",
          "git config user.email quack-e2e@example.invalid",
          "git config user.name 'Quack E2E'",
          "test ! -e /quack-git",
          '! sh -c "printf tamper >> /quack-git-objects/info/quack-tamper"',
          '! sh -c "printf tamper > /workspace/.git"',
          '! sh -c "printf tamper > /workspace/.quack/adapter.json"',
          '! sh -c "printf tamper > /workspace/.quack/prep/forged.json"',
          "printf 'container commit\\n' >> source.txt",
          "git add source.txt",
          "git commit -m 'container commit'",
        ].join(" && "),
      ]);
      let stdout = "";
      let stderr = "";
      child.stdout?.setEncoding("utf8");
      child.stderr?.setEncoding("utf8");
      child.stdout?.on("data", (chunk: string) => {
        stdout += chunk;
      });
      child.stderr?.on("data", (chunk: string) => {
        stderr += chunk;
      });
      const [exitCode, signal] = (await once(child, "close")) as [number | null, string | null];
      fs.writeFileSync(path.join(artifacts, "container-stdout.txt"), stdout);
      fs.writeFileSync(path.join(artifacts, "container-stderr.txt"), stderr);
      writeEvidence("container-exit.json", { pid: child.pid, exitCode, signal });
      expect(exitCode).toBe(0);
      expect(signal).toBeNull();
      expect(stderr).not.toMatch(/fatal:|error:/i);
      const after = await snapshot();
      writeEvidence("private-git-isolation.json", { before, after });
      expect(after).toEqual(before);
      const stopped = await manager.stopContainer(container.containerId);
      writeEvidence("container-stop.json", stopped);
      expect(stopped).toEqual({ removed: true, retained: false });
      await assertContainerAbsent(container.containerId);
      const extracted = await manager.extractResults(container);
      expect(extracted.branch).toBe(branch);
      expect(extracted.log).toContain("container commit");
      expect(
        fs.readFileSync(path.join(worktreePath, "source.txt"), "utf8").replace(/\r\n/g, "\n"),
      ).toBe("authoritative\ncontainer commit\n");
      expect(fs.readFileSync(path.join(projectRoot, "source.txt"), "utf8")).toBe("authoritative\n");
      expect(await git(projectRoot, "rev-parse", branch)).toBe(base);

      const publicationId = randomUUID();
      const gitState = manager.preparePrivateGitForPublication(container, publicationId);
      const options: DockerHostPublicationOptions = {
        recovery: {
          rootDir: path.join(stateRoot, "publication"),
          publicationId,
          gitState,
          worktreePath,
          worktreeSessionId: `quack-${taskId}-${randomUUID()}`,
          worktreeOwnershipId: publicationId,
          preserveWorktree: false,
        },
      };
      const recoveryPath = await initializeDockerPublicationRecovery(
        taskId,
        projectRoot,
        branch,
        options,
      );
      expect(readDockerPublicationRecovery(recoveryPath).gitState).toEqual(gitState);
      manager.sealPreparedPublicationRef(gitState);
      expect(await git(projectRoot, "rev-parse", gitState.sealedRef)).toBe(gitState.candidateHead);
      expect(await git(projectRoot, "rev-parse", branch)).toBe(base);
      const first = await runPhase("lost-response", recoveryPath, options);
      expect(first.expectedFailure?.step).toBe("push");
      expect(first.journal.progress.promotedAt).toBeDefined();
      expect(first.journal.progress.pushedAt).toBeUndefined();
      expect(first.journal.progress.mergedAt).toBeUndefined();
      expect(first.deliveries.filter((entry) => entry.kind === "task-push")).toHaveLength(1);
      expect(await git(remoteRoot, "rev-parse", branch)).toBe(gitState.candidateHead);
      expect(await git(remoteRoot, "rev-parse", "main")).toBe(base);
      const second = await runPhase("resume", recoveryPath, options);
      expect(second.processNonce).not.toBe(first.processNonce);
      expect(second.result?.autoMerged).toBe(true);
      expect(second.journal.state).toBe("complete");
      expect(second.deliveries.filter((entry) => entry.kind === "task-push")).toEqual([]);
      const merged = second.result!.mergeCommitSha!;
      const remoteHead = await git(remoteRoot, "rev-parse", "main");
      expect(await git(remoteRoot, "rev-parse", `${remoteHead}^`)).toBe(merged);
      expect(await git(remoteRoot, "show", "main:source.txt")).toBe(
        "authoritative\ncontainer commit",
      );
      expect(await git(remoteRoot, "show", `main:docs/tasks/${taskId}.md`)).toContain(
        "**Status:** COMPLETE",
      );
      expect(await git(projectRoot, "rev-parse", branch)).toBe(gitState.candidateHead);
      expect(await git(projectRoot, "rev-parse", "main")).toBe(base);
      expect(fs.readFileSync(path.join(projectRoot, "source.txt"), "utf8")).toBe("authoritative\n");
      writeEvidence("publication-accepted.json", {
        firstProcess: first.pid,
        secondProcess: second.pid,
        gitState,
        mergeCommit: merged,
        remoteHead,
        journal: second.journal,
      });
      expect(manager.releaseSealedPublicationRef(gitState)).toBe(true);
      expect(clearDockerPublicationRecovery(recoveryPath, publicationId)).toBe(true);
      expect(
        await git(
          projectRoot,
          "for-each-ref",
          "--format=%(refname)",
          "refs/quack/docker-publication/",
          "refs/quack/docker-publication-prepared/",
          "refs/quack/docker-publication-lock/",
        ),
      ).toBe("");
      expect(fs.readdirSync(path.dirname(recoveryPath))).toEqual([]);
      passed = true;
    } catch (error: unknown) {
      writeEvidence("failure.json", {
        message: String(error),
        stack: error instanceof Error ? error.stack : undefined,
        fixtureRoot: tempRoot,
      });
      throw error;
    } finally {
      try {
        if (manager) {
          const cleanup = await manager.cleanupAll({ includeRetained: true });
          writeEvidence("cleanup.json", cleanup);
          expect(cleanup.failedTaskIds).toEqual([]);
          expect(cleanup.retainedTaskIds ?? []).toEqual([]);
          expect(manager.getTrackedContainers()).toEqual([]);
          expect(manager.getUnresolvedContainers()).toEqual([]);
          if (containerId) await assertContainerAbsent(containerId);
        }
        if (worktreeCreated && passed && !retainFixture) {
          await git(projectRoot, "worktree", "remove", "--force", worktreePath);
          const remaining = await git(projectRoot, "worktree", "list", "--porcelain");
          writeEvidence("worktrees-after.json", { remaining });
          expect(
            remaining.split(/\r?\n/).filter((line) => line.startsWith("worktree ")),
          ).toHaveLength(1);
        }
        cleanupConfirmed = true;
      } finally {
        writeEvidence("outcome.json", {
          passed,
          cleanupConfirmed,
          retained: !passed || !cleanupConfirmed || retainFixture,
          fixtureRoot: tempRoot,
          artifacts,
        });
        if (passed && cleanupConfirmed && !retainFixture) {
          removeVerifiedTempRoot();
        } else {
          console.warn(`Docker proof fixture retained at ${tempRoot}; evidence ${artifacts}`);
        }
      }
    }
  }
});
