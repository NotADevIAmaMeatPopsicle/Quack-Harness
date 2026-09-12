import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { withDockerPublicationRecoveryLock } from "../../src/dispatcher/docker-host-publication";
import * as trustedGit from "../../src/worker/trusted-executable";

const runActualGit = trustedGit.runTrustedGitResult;

interface Fixture {
  root: string;
  recoveryPath: string;
  publicationId: string;
  lockRef: string;
  sealedRef: string;
  journalBytes: Buffer;
}

interface OwnedFixture {
  root: string;
  testName: string;
  startedAt: number;
  stages: Array<{ stage: string; elapsedMs: number }>;
  body: Promise<void>;
  settled: boolean;
  passed: boolean;
  preserve: boolean;
  error?: string;
}

const ownedFixtures = new Set<OwnedFixture>();

function removeOwnedRoot(root: string): void {
  const target = path.resolve(root);
  if (
    !target.startsWith(path.resolve(os.tmpdir()) + path.sep) ||
    !path.basename(target).startsWith("quack-native-publication-lock-")
  ) {
    throw new Error("Refusing removal outside the native publication fixture");
  }
  fs.rmSync(target, { recursive: true, force: true });
}

function withFixture(operation: (fixture: Fixture) => Promise<void>): Promise<void> {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-native-publication-lock-"));
  const owned: OwnedFixture = {
    root,
    testName: expect.getState().currentTestName ?? "unknown native lock test",
    startedAt: Date.now(),
    stages: [],
    body: Promise.resolve(),
    settled: false,
    passed: false,
    preserve: false,
  };
  const recordStage = (stage: string) => {
    owned.stages.push({ stage, elapsedMs: Date.now() - owned.startedAt });
  };
  ownedFixtures.add(owned);
  owned.body = (async () => {
    try {
      recordStage("setup-start");
      const executable = trustedGit.resolveTrustedExecutable(
        "git",
        root,
        "native publication fixture Git",
      );
      execFileSync(executable, ["-C", root, "init", "--initial-branch=main"], {
        cwd: path.dirname(executable),
        env: trustedGit.buildTrustedGitEnvironment(executable),
        encoding: "utf8",
        windowsHide: true,
        timeout: 15_000,
        stdio: "pipe",
      });
      const publicationId = randomUUID();
      const recoveryPath = path.join(root, `${publicationId}.json`);
      const journalBytes = Buffer.from("publication journal sentinel\n");
      fs.writeFileSync(recoveryPath, journalBytes);
      recordStage("operation-start");
      await operation({
        root,
        recoveryPath,
        publicationId,
        lockRef: `refs/quack/docker-publication-lock/TASK-990002/${publicationId}`,
        sealedRef: `refs/quack/docker-publication/TASK-990002/${publicationId}`,
        journalBytes,
      });
      owned.passed = true;
    } catch (error: unknown) {
      owned.error = error instanceof Error ? error.message : String(error);
      throw error;
    } finally {
      owned.settled = true;
      recordStage("operation-settled");
    }
  })();
  return owned.body;
}

async function settleFixtures(): Promise<void> {
  const fixtures = [...ownedFixtures];
  const pending = fixtures.filter((fixture) => !fixture.settled);
  // Jest stops awaiting a timed-out test, but its native work keeps running.
  // Keep subsequent tests out until that complete body has settled, and retain
  // its evidence even if the body eventually satisfies every assertion.
  for (const fixture of pending) {
    fixture.preserve = true;
    fixture.stages.push({
      stage: "teardown-found-running-body",
      elapsedMs: Date.now() - fixture.startedAt,
    });
  }
  let deadline: NodeJS.Timeout | undefined;
  try {
    if (pending.length > 0) {
      await Promise.race([
        Promise.allSettled(pending.map((fixture) => fixture.body)),
        new Promise<void>((resolve) => {
          deadline = setTimeout(resolve, 25_000);
        }),
      ]);
    }
  } finally {
    if (deadline) clearTimeout(deadline);
  }
  for (const fixture of fixtures) {
    const evidence = {
      root: fixture.root,
      testName: fixture.testName,
      startedAt: fixture.startedAt,
      stages: fixture.stages,
      settled: fixture.settled,
      passed: fixture.passed,
      preserve: fixture.preserve,
      error: fixture.error,
    };
    const contents = JSON.stringify(evidence, null, 2) + "\n";
    const diagnosticDirectory = process.env.QUACK_NATIVE_LOCK_DIAGNOSTIC_DIR;
    if (diagnosticDirectory) {
      fs.mkdirSync(diagnosticDirectory, { recursive: true });
      fs.writeFileSync(
        path.join(diagnosticDirectory, `${path.basename(fixture.root)}.json`),
        contents,
      );
    }
    if (fixture.settled && fixture.passed && !fixture.preserve) {
      removeOwnedRoot(fixture.root);
    } else {
      fs.writeFileSync(path.join(fixture.root, "fixture-outcome.json"), contents);
      console.warn(`Native publication lock fixture retained at ${fixture.root}`);
    }
    if (fixture.settled) ownedFixtures.delete(fixture);
  }
  if (ownedFixtures.size > 0) {
    throw new Error(
      "Native publication fixture is still running; preserving its ownership and files",
    );
  }
}

const git = (root: string, args: string[]) =>
  runActualGit(root, args, { timeoutMs: 15_000, maxBuffer: 1024 * 1024 });

describe("Docker publication locks with native Git", () => {
  beforeEach(() => {
    if (ownedFixtures.size > 0) {
      throw new Error("Previous native publication fixture has not settled");
    }
  });
  afterEach(settleFixtures, 30_000);
  afterAll(settleFixtures, 30_000);

  test("retains recovery ownership after a failed delete and timed-out readback", async () => {
    await withFixture(async (fixture) => {
      // No input is sent, so real Git waits on its owned stdin pipe until the
      // trusted runner's deadline. This produces an actual unknown exit code.
      const timeout = await runActualGit(fixture.root, ["hash-object", "--stdin"], {
        timeoutMs: 100,
        maxBuffer: 1024 * 1024,
      });
      expect(timeout.stdout).toBe("");
      expect(timeout.stderr).toBe("");
      let blockedDelete = false;
      let failedReadback = false;
      const intercept = jest
        .spyOn(trustedGit, "runTrustedGitResult")
        .mockImplementation(async (root, args, options) => {
          if (
            root === fixture.root &&
            args[0] === "update-ref" &&
            args[1] === "-d" &&
            args[2] === fixture.lockRef &&
            !blockedDelete
          ) {
            blockedDelete = true;
            return { exitCode: 1, stdout: "", stderr: "injected lock deletion refusal" };
          }
          if (
            root === fixture.root &&
            blockedDelete &&
            !failedReadback &&
            args[0] === "rev-parse" &&
            args.at(-1) === fixture.lockRef
          ) {
            failedReadback = true;
            return timeout;
          }
          return await runActualGit(root, args, options);
        });
      const identity = {
        projectRoot: fixture.root,
        publicationId: fixture.publicationId,
        gitState: { sealedRef: fixture.sealedRef },
      };
      const operation = jest.fn<Promise<string>, []>().mockResolvedValue("published");
      try {
        await expect(
          withDockerPublicationRecoveryLock(fixture.recoveryPath, identity, operation),
        ).rejects.toThrow(/could not verify durable recovery lock release/);
        expect(blockedDelete).toBe(true);
        expect(failedReadback).toBe(true);
        expect(timeout.exitCode).not.toBe(0);
        expect(timeout.exitCode).not.toBe(1);
        expect(operation).toHaveBeenCalledTimes(1);
        expect(
          (await git(fixture.root, ["show-ref", "--verify", "--hash", fixture.lockRef])).exitCode,
        ).toBe(0);
      } finally {
        intercept.mockRestore();
      }
      // The still-live publisher must be allowed to reconcile its own retained
      // inactive lock, rather than strand it as another active operation.
      await expect(
        withDockerPublicationRecoveryLock(fixture.recoveryPath, identity, operation),
      ).resolves.toBe("published");
      expect(operation).toHaveBeenCalledTimes(2);
      expect(
        (await git(fixture.root, ["show-ref", "--verify", "--quiet", fixture.lockRef])).exitCode,
      ).toBe(1);
      expect(fs.readFileSync(fixture.recoveryPath)).toEqual(fixture.journalBytes);
    });
  });

  // Two audited acquisition/release cycles run 101 native Git invocations.
  // This is a cumulative fixture budget; production command limits stay intact.
  test("acquires an absent lock, exposes its exact owner, and releases for reacquisition", async () => {
    await withFixture(async (fixture) => {
      const operation = jest.fn(async () => {
        const ref = await git(fixture.root, ["show-ref", "--verify", "--hash", fixture.lockRef]);
        expect(ref.exitCode).toBe(0);
        const object = await git(fixture.root, ["cat-file", "blob", ref.stdout.trim()]);
        expect(object.exitCode).toBe(0);
        expect(JSON.parse(object.stdout) as unknown).toEqual(
          expect.objectContaining({ publicationId: fixture.publicationId, pid: process.pid }),
        );
        return "published";
      });
      for (let attempt = 0; attempt < 2; attempt += 1) {
        await expect(
          withDockerPublicationRecoveryLock(
            fixture.recoveryPath,
            {
              projectRoot: fixture.root,
              publicationId: fixture.publicationId,
              gitState: { sealedRef: fixture.sealedRef },
            },
            operation,
          ),
        ).resolves.toBe("published");
        expect(
          (await git(fixture.root, ["show-ref", "--verify", "--quiet", fixture.lockRef])).exitCode,
        ).toBe(1);
      }
      expect(operation).toHaveBeenCalledTimes(2);
      expect(fs.readFileSync(fixture.recoveryPath)).toEqual(fixture.journalBytes);
      expect(fs.readdirSync(fixture.root).filter((name) => name.endsWith(".lock-owner"))).toEqual(
        [],
      );
    });
  }, 30_000);

  test.each([
    ["malformed", "not-a-git-object\n"],
    ["dangling", `${"f".repeat(40)}\n`],
    ["dangling symbolic", "ref: refs/quack/missing-lock-target\n"],
  ])("preserves a %s lock ref and refuses the operation", async (_label, contents) => {
    await withFixture(async (fixture) => {
      const refPath = path.join(fixture.root, ".git", ...fixture.lockRef.split("/"));
      fs.mkdirSync(path.dirname(refPath), { recursive: true });
      const bytes = Buffer.from(contents);
      fs.writeFileSync(refPath, bytes);
      const operation = jest.fn<Promise<string>, []>().mockResolvedValue("must not publish");
      await expect(
        withDockerPublicationRecoveryLock(
          fixture.recoveryPath,
          {
            projectRoot: fixture.root,
            publicationId: fixture.publicationId,
            gitState: { sealedRef: fixture.sealedRef },
          },
          operation,
        ),
      ).rejects.toThrow(/could not acquire the durable recovery lock/);
      expect(operation).not.toHaveBeenCalled();
      expect(fs.readFileSync(refPath)).toEqual(bytes);
      expect(fs.readFileSync(fixture.recoveryPath)).toEqual(fixture.journalBytes);
      expect(fs.readdirSync(fixture.root).filter((name) => name.endsWith(".lock-owner"))).toEqual(
        [],
      );
    });
  });
});
