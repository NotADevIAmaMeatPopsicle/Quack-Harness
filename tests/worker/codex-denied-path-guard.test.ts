import { execFileSync } from "node:child_process";
import * as fsSync from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { AdapterSandboxConfig } from "../../src/core/types";
import {
  prepareCodexDeniedPathGuard as prepareCodexDeniedPathGuardOperation,
  recoverCodexDeniedPathQuarantine as recoverCodexDeniedPathQuarantineOperation,
} from "../../src/worker/codex-denied-path-guard";

jest.mock("node:fs/promises", () => {
  const actual = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
  return {
    ...actual,
    rename: jest.fn(actual.rename),
  };
});

const REAL_GIT_CASE_TIMEOUT_MS = 30_000;
const registerTest = test;

interface DeniedGuardFixtureRun {
  root: string;
  externalRoots: string[];
  settled: boolean;
  bodyPassed: boolean;
  completion: Promise<void>;
  record: (phase: string, details?: Record<string, unknown>) => void;
  preserve: (reason: string) => Promise<void>;
}

let activeFixture: DeniedGuardFixtureRun | undefined;

function createFixtureRun(root: string): DeniedGuardFixtureRun {
  const startedAt = Date.now();
  const externalRoots: string[] = [];
  const testName = expect.getState().currentTestName;
  let evidenceDir: string | undefined;
  if (process.env.QUACK_CODEX_GUARD_DIAGNOSTICS === "1") {
    const parent = path.join(process.cwd(), ".dev", "codex-guard-diagnostics");
    fsSync.mkdirSync(parent, { recursive: true });
    evidenceDir = fsSync.mkdtempSync(path.join(parent, "run-"));
  }
  let captureFailed = false;
  const record = (phase: string, details: Record<string, unknown> = {}): void => {
    if (!evidenceDir || captureFailed) return;
    try {
      const fd = fsSync.openSync(path.join(evidenceDir, "phases.jsonl"), "a", 0o600);
      try {
        fsSync.writeSync(
          fd,
          JSON.stringify({ phase, elapsedMs: Date.now() - startedAt, ...details }) + "\n",
        );
        fsSync.fsyncSync(fd);
      } finally {
        fsSync.closeSync(fd);
      }
    } catch (error) {
      captureFailed = true;
      console.warn("Codex denied-path fixture phase capture failed", error);
    }
  };
  let preserved = false;
  const preserve = async (reason: string): Promise<void> => {
    if (preserved) return;
    preserved = true;
    record("fixture.preserved", { reason, root, externalRoots, testName });
    console.warn("Preserved Codex denied-path fixture", {
      reason,
      root,
      externalRoots,
      testName,
      evidenceDir,
    });
    if (evidenceDir) {
      try {
        // Best-effort observation before joining late work. Never follow fixture links.
        await fs.cp(root, path.join(evidenceDir, "failure-snapshot"), {
          recursive: true,
          dereference: false,
        });
      } catch (error) {
        console.warn("Codex denied-path fixture snapshot failed; original root retained", error);
      }
    }
  };
  record("fixture.created", { root, testName, timeoutMs: REAL_GIT_CASE_TIMEOUT_MS });
  return {
    root,
    externalRoots,
    settled: true,
    bodyPassed: false,
    completion: Promise.resolve(),
    record,
    preserve,
  };
}

function ownFixtureWork<T>(
  fixture: DeniedGuardFixtureRun,
  phase: "setup" | "body",
  work: () => Promise<T>,
): Promise<T> {
  fixture.settled = false;
  fixture.record(`${phase}.started`);
  const pending = Promise.resolve()
    .then(work)
    .then(
      (result) => {
        if (phase === "body") fixture.bodyPassed = true;
        fixture.record(`${phase}.completed`);
        return result;
      },
      (error: unknown) => {
        fixture.record(`${phase}.failed`, { error: String(error) });
        throw error;
      },
    )
    .finally(() => {
      fixture.settled = true;
    });
  // Observe rejection as well as fulfillment; the original promise still fails Jest.
  fixture.completion = pending.then(
    () => undefined,
    () => undefined,
  );
  return pending;
}

function ownCase(work: () => Promise<void>): Promise<void> {
  if (!activeFixture) return Promise.reject(new Error("Missing Codex denied-path fixture"));
  return ownFixtureWork(activeFixture, "body", work);
}

async function joinFixture(fixture: DeniedGuardFixtureRun): Promise<boolean> {
  let deadline: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      fixture.completion.then(() => true),
      new Promise<boolean>((resolve) => {
        deadline = setTimeout(() => resolve(false), REAL_GIT_CASE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (deadline !== undefined) clearTimeout(deadline);
  }
}

// Return the original promise: recovery intentionally memoizes concurrent callers.
function observeFixtureOperation<T>(label: string, work: () => Promise<T>): Promise<T> {
  const fixture = activeFixture;
  fixture?.record(`${label}.started`);
  try {
    const pending = work();
    void pending.then(
      () => fixture?.record(`${label}.completed`),
      (error: unknown) => fixture?.record(`${label}.failed`, { error: String(error) }),
    );
    return pending;
  } catch (error) {
    fixture?.record(`${label}.failed`, { error: String(error) });
    throw error;
  }
}

function observeFixtureSyncOperation<T>(label: string, work: () => T): T {
  const fixture = activeFixture;
  fixture?.record(`${label}.started`);
  try {
    const result = work();
    fixture?.record(`${label}.completed`);
    return result;
  } catch (error) {
    fixture?.record(`${label}.failed`, { error: String(error) });
    throw error;
  }
}

const prepareCodexDeniedPathGuard = (
  ...args: Parameters<typeof prepareCodexDeniedPathGuardOperation>
) => observeFixtureOperation("guard.prepare", () => prepareCodexDeniedPathGuardOperation(...args));
const recoverCodexDeniedPathQuarantine = (
  ...args: Parameters<typeof recoverCodexDeniedPathQuarantineOperation>
) =>
  observeFixtureOperation("guard.recover", () =>
    recoverCodexDeniedPathQuarantineOperation(...args),
  );

describe("Codex denied-path guard", () => {
  let fixtureRoot: string;
  let repositoryRoot: string;
  let projectRoot: string;
  let externalRoots: string[];
  let fixtureAdmissionRefused = false;
  // Real local Git inventories and restoration share this bounded fixture budget.
  const test = (name: string, work: () => Promise<void>): void => {
    registerTest(name, () => ownCase(work), REAL_GIT_CASE_TIMEOUT_MS);
  };
  const registerWindowsTest = process.platform === "win32" ? registerTest : registerTest.skip;
  const sandbox: AdapterSandboxConfig = {
    writablePaths: ["src/"],
    deniedPaths: [".git/"],
    allowedBashPatterns: [],
    deniedBashPatterns: [],
  };

  beforeEach(() => {
    fixtureAdmissionRefused = Boolean(activeFixture && !activeFixture.settled);
    if (fixtureAdmissionRefused) {
      throw new Error(
        "Previous Codex denied-path fixture is still running; refusing to reset shared state",
      );
    }
    fixtureRoot = fsSync.mkdtempSync(path.join(os.tmpdir(), "quack-codex-fixture-"));
    const fixture = createFixtureRun(fixtureRoot);
    activeFixture = fixture;
    externalRoots = fixture.externalRoots;
    return ownFixtureWork(fixture, "setup", async () => {
      // Quarantines are siblings of the guarded worktree. Give every test its
      // own parent so even an intentionally malformed/unattributable manifest
      // cannot leak into the shared OS temp directory and affect another suite.
      repositoryRoot = path.join(fixtureRoot, "repository");
      projectRoot = path.join(fixtureRoot, "worktree");
      await fs.mkdir(repositoryRoot);
      observeFixtureSyncOperation("fixture.git", () =>
        execFileSync("git", ["init"], { cwd: repositoryRoot, stdio: "ignore" }),
      );
      observeFixtureSyncOperation("fixture.git", () =>
        execFileSync("git", ["config", "user.email", "quack-tests@example.invalid"], {
          cwd: repositoryRoot,
        }),
      );
      observeFixtureSyncOperation("fixture.git", () =>
        execFileSync("git", ["config", "user.name", "Quack Tests"], {
          cwd: repositoryRoot,
        }),
      );
      await fs.writeFile(
        path.join(repositoryRoot, ".gitignore"),
        "node_modules/\nignored-cache/\n.env.*\n",
      );
      await fs.mkdir(path.join(repositoryRoot, "src"), { recursive: true });
      await fs.writeFile(path.join(repositoryRoot, "src", "tracked.ts"), "export {};\n");
      observeFixtureSyncOperation("fixture.git", () =>
        execFileSync("git", ["add", "."], { cwd: repositoryRoot }),
      );
      observeFixtureSyncOperation("fixture.git", () =>
        execFileSync("git", ["commit", "-m", "fixture"], {
          cwd: repositoryRoot,
          stdio: "ignore",
        }),
      );
      observeFixtureSyncOperation("fixture.git", () =>
        execFileSync("git", ["worktree", "add", "-b", "codex-guard-test", projectRoot], {
          cwd: repositoryRoot,
          stdio: "ignore",
        }),
      );
    });
  }, REAL_GIT_CASE_TIMEOUT_MS);

  afterEach(async () => {
    if (fixtureAdmissionRefused || !activeFixture) return;
    const fixture = activeFixture;
    const preserve = !fixture.bodyPassed;
    if (preserve) await fixture.preserve("failed_or_unfinished_before_teardown");
    if (!(await joinFixture(fixture))) {
      await fixture.preserve("body_did_not_settle_before_cleanup_deadline");
      throw new Error(`Codex denied-path fixture is still running; retained at ${fixture.root}`);
    }
    if (preserve) return;
    try {
      // Windows can briefly retain handles after settled Git/Node work.
      const options = { recursive: true, force: true, maxRetries: 20, retryDelay: 100 };
      await fs.rm(fixture.root, options);
      for (const externalRoot of fixture.externalRoots) {
        await fs.rm(externalRoot, options);
      }
      fixture.record("fixture.cleaned");
    } catch (error) {
      await fixture.preserve("cleanup_failed_after_settlement");
      throw error;
    }
  }, REAL_GIT_CASE_TIMEOUT_MS + 5_000);

  async function matchingQuarantineRoots(targetProjectRoot: string): Promise<string[]> {
    const canonicalProjectRoot = await fs.realpath(targetProjectRoot);
    const parent = path.dirname(canonicalProjectRoot);
    const matches: string[] = [];
    for (const entry of await fs.readdir(parent, { withFileTypes: true })) {
      if (!entry.isDirectory() || !entry.name.startsWith(".quack-codex-denied-")) {
        continue;
      }
      const candidate = path.join(parent, entry.name);
      try {
        const manifest = JSON.parse(
          await fs.readFile(path.join(candidate, "manifest.json"), "utf8"),
        ) as { projectRoot?: unknown };
        const normalizeForComparison = (value: string): string => {
          const normalized = path.normalize(value);
          return process.platform === "win32" ? normalized.toLowerCase() : normalized;
        };
        if (
          typeof manifest.projectRoot === "string" &&
          normalizeForComparison(manifest.projectRoot) ===
            normalizeForComparison(canonicalProjectRoot)
        ) {
          matches.push(candidate);
        }
      } catch {
        // A different test may intentionally retain malformed recovery data.
      }
    }
    return matches;
  }

  async function findQuarantineRoot(): Promise<string> {
    const [candidate] = await matchingQuarantineRoots(projectRoot);
    if (candidate) return candidate;
    throw new Error(`No quarantine manifest found for ${projectRoot}`);
  }

  test("quarantines arbitrary ignored paths outside writable roots and restores exact bytes", async () => {
    const dependencyFile = path.join(projectRoot, "node_modules", "demo-package", "cache.js");
    await fs.mkdir(path.dirname(dependencyFile), { recursive: true });
    await fs.writeFile(dependencyFile, "original dependency bytes\n");
    const ignoredCache = path.join(projectRoot, "ignored-cache", "state.bin");
    await fs.mkdir(path.dirname(ignoredCache), { recursive: true });
    await fs.writeFile(ignoredCache, "original ignored bytes\n");
    await fs.writeFile(path.join(projectRoot, ".env.example"), "API_TOKEN=replace-me\n");

    const gitPointerBefore = await fs.readFile(path.join(projectRoot, ".git"), "utf8");
    const guard = await prepareCodexDeniedPathGuard(projectRoot, sandbox);

    await expect(fs.stat(path.join(projectRoot, "node_modules"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(projectRoot, "ignored-cache"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.join(projectRoot, ".env.example"))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await fs.mkdir(path.dirname(dependencyFile), { recursive: true });
    await fs.writeFile(dependencyFile, "model-created replacement\n");
    await fs.mkdir(path.dirname(ignoredCache), { recursive: true });
    await fs.writeFile(ignoredCache, "model-created ignored replacement\n");

    const result = await guard.finish();

    expect(result.restored).toBe(true);
    expect(result.violations).toEqual(
      expect.arrayContaining([
        "node_modules",
        "node_modules/demo-package/cache.js",
        "ignored-cache",
        "ignored-cache/state.bin",
      ]),
    );
    await expect(fs.readFile(dependencyFile, "utf8")).resolves.toBe("original dependency bytes\n");
    await expect(fs.readFile(ignoredCache, "utf8")).resolves.toBe("original ignored bytes\n");
    await expect(fs.readFile(path.join(projectRoot, ".env.example"), "utf8")).resolves.toBe(
      "API_TOKEN=replace-me\n",
    );
    await expect(fs.readFile(path.join(projectRoot, ".git"), "utf8")).resolves.toBe(
      gitPointerBefore,
    );
  });

  const windowsGitShadowTest = process.platform === "win32" ? test : registerTest.skip;
  windowsGitShadowTest(
    "does not execute a worktree git.exe during inventory or restoration",
    async () => {
      const commandInterpreter = process.env.ComSpec;
      if (!commandInterpreter) throw new Error("ComSpec is required for the Windows regression");
      await fs.copyFile(commandInterpreter, path.join(projectRoot, "git.exe"));

      const guard = await prepareCodexDeniedPathGuard(projectRoot, sandbox);
      await expect(guard.finish()).resolves.toEqual({ violations: [], restored: true });
    },
  );

  test("provides an independent disposable dependency mirror and restores trusted bytes", async () => {
    const dependencyRoot = path.join(projectRoot, "node_modules", "demo-package");
    const dependencyFile = path.join(dependencyRoot, "index.js");
    await fs.mkdir(dependencyRoot, { recursive: true });
    await fs.writeFile(dependencyFile, "module.exports = 'trusted dependency';\n");
    await fs.writeFile(
      path.join(dependencyRoot, "package.json"),
      `${JSON.stringify({ name: "demo-package", main: "index.js" })}\n`,
    );

    const guard = await prepareCodexDeniedPathGuard(projectRoot, {
      ...sandbox,
      disposablePaths: ["node_modules/"],
    });
    const quarantineRoot = await findQuarantineRoot();
    const manifest = JSON.parse(
      await fs.readFile(path.join(quarantineRoot, "manifest.json"), "utf8"),
    ) as {
      policy: { disposablePaths: string[] };
      items: Array<{ relativePath: string; backupName: string }>;
    };
    const dependencyItem = manifest.items.find((item) => item.relativePath === "node_modules");
    expect(dependencyItem).toBeDefined();
    expect(manifest.policy.disposablePaths).toEqual(["node_modules"]);

    expect(
      execFileSync(
        process.execPath,
        ["-e", "process.stdout.write(require('./node_modules/demo-package'))"],
        { cwd: projectRoot, encoding: "utf8" },
      ),
    ).toBe("trusted dependency");
    await fs.writeFile(dependencyFile, "module.exports = 'model mutation';\n");
    await fs.writeFile(path.join(dependencyRoot, "model-created.js"), "throw new Error();\n");

    await expect(
      fs.readFile(
        path.join(quarantineRoot, dependencyItem!.backupName, "demo-package", "index.js"),
        "utf8",
      ),
    ).resolves.toBe("module.exports = 'trusted dependency';\n");

    await expect(guard.finish()).resolves.toEqual({ violations: [], restored: true });
    await expect(fs.readFile(dependencyFile, "utf8")).resolves.toBe(
      "module.exports = 'trusted dependency';\n",
    );
    await expect(fs.stat(path.join(dependencyRoot, "model-created.js"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("restores disposable dependencies through orphan recovery without trusting mirror changes", async () => {
    const dependencyFile = path.join(projectRoot, "node_modules", "demo-package", "index.js");
    await fs.mkdir(path.dirname(dependencyFile), { recursive: true });
    await fs.writeFile(dependencyFile, "trusted dependency\n");
    await prepareCodexDeniedPathGuard(projectRoot, {
      ...sandbox,
      disposablePaths: ["node_modules"],
    });
    const quarantineRoot = await findQuarantineRoot();

    await fs.writeFile(dependencyFile, "untrusted mirror mutation\n");
    await fs.writeFile(path.join(projectRoot, "node_modules", "new.bin"), "untrusted\n");

    await expect(recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot)).resolves.toEqual({
      violations: [],
      restored: true,
    });
    await expect(fs.readFile(dependencyFile, "utf8")).resolves.toBe("trusted dependency\n");
    await expect(fs.stat(path.join(projectRoot, "node_modules", "new.bin"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("preserves self-contained dependency aliases inside the disposable mirror", async () => {
    const nodeModules = path.join(projectRoot, "node_modules");
    const dependencyRoot = path.join(nodeModules, "demo-package");
    const dependencyFile = path.join(dependencyRoot, "index.js");
    await fs.mkdir(dependencyRoot, { recursive: true });
    await fs.writeFile(dependencyFile, "trusted dependency\n");
    const alias = path.join(nodeModules, "demo-alias");
    await fs.symlink(
      process.platform === "win32" ? dependencyRoot : "demo-package",
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    const guard = await prepareCodexDeniedPathGuard(projectRoot, {
      ...sandbox,
      disposablePaths: ["node_modules/"],
    });

    await expect(fs.readFile(path.join(alias, "index.js"), "utf8")).resolves.toBe(
      "trusted dependency\n",
    );
    await fs.writeFile(path.join(alias, "index.js"), "mirror mutation through alias\n");
    await expect(guard.finish()).resolves.toEqual({ violations: [], restored: true });
    await expect(fs.readFile(dependencyFile, "utf8")).resolves.toBe("trusted dependency\n");
    await expect(fs.readFile(path.join(alias, "index.js"), "utf8")).resolves.toBe(
      "trusted dependency\n",
    );
  });

  test("refuses a disposable path that is not an existing exact protected root", async () => {
    await expect(
      prepareCodexDeniedPathGuard(projectRoot, {
        ...sandbox,
        disposablePaths: ["node_modules/"],
      }),
    ).rejects.toThrow("must name an existing exact denied or ignored root");
    await expect(matchingQuarantineRoots(projectRoot)).resolves.toEqual([]);

    await expect(
      prepareCodexDeniedPathGuard(projectRoot, {
        ...sandbox,
        disposablePaths: ["node_*/"],
      }),
    ).rejects.toThrow("must name an exact path");
    await expect(matchingQuarantineRoots(projectRoot)).resolves.toEqual([]);
  });

  test("refuses a disposable dependency tree with an alias that escapes the mirror", async () => {
    const dependencyRoot = path.join(projectRoot, "node_modules", "demo-package");
    await fs.mkdir(dependencyRoot, { recursive: true });
    await fs.writeFile(path.join(dependencyRoot, "index.js"), "module.exports = true;\n");
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-dependency-outside-"));
    externalRoots.push(externalRoot);
    await fs.writeFile(path.join(externalRoot, "trusted.txt"), "outside sentinel\n");
    await fs.symlink(
      externalRoot,
      path.join(projectRoot, "node_modules", "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      prepareCodexDeniedPathGuard(projectRoot, {
        ...sandbox,
        disposablePaths: ["node_modules/"],
      }),
    ).rejects.toThrow("contains an alias that escapes the disposable root");

    await expect(fs.readFile(path.join(externalRoot, "trusted.txt"), "utf8")).resolves.toBe(
      "outside sentinel\n",
    );
    await expect(matchingQuarantineRoots(projectRoot)).resolves.toEqual([]);
  });

  test("refuses a disposable dependency tree containing an external hard-linked file", async () => {
    const externalFile = path.join(fixtureRoot, "outside-secret.txt");
    await fs.writeFile(externalFile, "outside sentinel\n");
    const linkedFile = path.join(projectRoot, "node_modules", "demo-package", "innocent.txt");
    await fs.mkdir(path.dirname(linkedFile), { recursive: true });
    await fs.link(externalFile, linkedFile);

    await expect(
      prepareCodexDeniedPathGuard(projectRoot, {
        ...sandbox,
        disposablePaths: ["node_modules/"],
      }),
    ).rejects.toThrow("hard-linked file");

    await expect(fs.readFile(externalFile, "utf8")).resolves.toBe("outside sentinel\n");
    await expect(fs.readFile(linkedFile, "utf8")).resolves.toBe("outside sentinel\n");
    await expect(matchingQuarantineRoots(projectRoot)).resolves.toEqual([]);
  });

  test("restores non-writable ignore rules before removing newly hidden paths", async () => {
    const ignoreFile = path.join(projectRoot, ".gitignore");
    const originalRules = await fs.readFile(ignoreFile, "utf8");
    const guard = await prepareCodexDeniedPathGuard(projectRoot, sandbox);

    // Simulate a model removing an original rule before creating bytes that
    // would have been ignored under the pre-run policy.
    await fs.writeFile(ignoreFile, "different-cache/\n");
    const hiddenReplacement = path.join(projectRoot, "ignored-cache", "new.bin");
    await fs.mkdir(path.dirname(hiddenReplacement), { recursive: true });
    await fs.writeFile(hiddenReplacement, "model-created hidden bytes\n");

    const result = await guard.finish();

    expect(result.restored).toBe(true);
    expect(result.violations).toEqual(
      expect.arrayContaining([".gitignore", "ignored-cache", "ignored-cache/new.bin"]),
    );
    await expect(fs.readFile(ignoreFile, "utf8")).resolves.toBe(originalRules);
    await expect(fs.stat(hiddenReplacement)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("refuses a hard-linked copy-backed ignore rule before quarantine", async () => {
    const ignoreFile = path.join(projectRoot, ".gitignore");
    const externalFile = path.join(fixtureRoot, "outside-ignore.txt");
    const originalRules = await fs.readFile(ignoreFile, "utf8");
    await fs.writeFile(externalFile, originalRules);
    await fs.unlink(ignoreFile);
    await fs.link(externalFile, ignoreFile);

    await expect(prepareCodexDeniedPathGuard(projectRoot, sandbox)).rejects.toThrow(
      "hard-linked file",
    );

    await expect(fs.readFile(externalFile, "utf8")).resolves.toBe(originalRules);
    await expect(matchingQuarantineRoots(projectRoot)).resolves.toEqual([]);
  });

  test("refuses launch while a wildcard-matched secret file is present", async () => {
    const secretFile = path.join(projectRoot, ".env.local");
    await fs.writeFile(secretFile, "API_TOKEN=sentinel\n");

    await expect(prepareCodexDeniedPathGuard(projectRoot, sandbox)).rejects.toThrow(
      "secret-bearing denied path .env.local cannot be guaranteed unreadable",
    );
    await expect(fs.readFile(secretFile, "utf8")).resolves.toBe("API_TOKEN=sentinel\n");
  });

  test("refuses a full git directory before creating recovery state", async () => {
    await expect(prepareCodexDeniedPathGuard(repositoryRoot, sandbox)).rejects.toThrow(
      "requires a disposable git worktree",
    );
    await expect(matchingQuarantineRoots(repositoryRoot)).resolves.toEqual([]);
  });

  test("rejects a project-root denied path before inventory or recovery-state creation", async () => {
    await expect(
      prepareCodexDeniedPathGuard(projectRoot, {
        ...sandbox,
        deniedPaths: ["."],
      }),
    ).rejects.toThrow("unsafe deniedPaths[0]");

    await expect(matchingQuarantineRoots(projectRoot)).resolves.toEqual([]);
    await expect(fs.readFile(path.join(projectRoot, "src", "tracked.ts"), "utf8")).resolves.toMatch(
      /^export \{\};\r?\n$/,
    );
  });

  const posixTest = process.platform === "win32" ? registerTest.skip : test;
  posixTest("rejects a denied path nested beneath a symlink that escapes the project", async () => {
    const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-codex-outside-"));
    externalRoots.push(externalRoot);
    await fs.writeFile(path.join(externalRoot, "secret.txt"), "outside sentinel\n");
    await fs.symlink(externalRoot, path.join(projectRoot, "linked"), "dir");

    await expect(
      prepareCodexDeniedPathGuard(projectRoot, {
        ...sandbox,
        deniedPaths: ["linked/secret.txt"],
      }),
    ).rejects.toThrow("destination parent contains a filesystem alias");

    await expect(fs.readFile(path.join(externalRoot, "secret.txt"), "utf8")).resolves.toBe(
      "outside sentinel\n",
    );
    await expect(matchingQuarantineRoots(projectRoot)).resolves.toEqual([]);
  });

  const windowsTest = process.platform === "win32" ? test : registerTest.skip;
  windowsTest(
    "rejects a denied path nested beneath a junction that escapes the project",
    async () => {
      const externalRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-codex-outside-"));
      externalRoots.push(externalRoot);
      await fs.writeFile(path.join(externalRoot, "secret.txt"), "outside sentinel\n");
      await fs.symlink(externalRoot, path.join(projectRoot, "linked"), "junction");

      await expect(
        prepareCodexDeniedPathGuard(projectRoot, {
          ...sandbox,
          deniedPaths: ["linked/secret.txt"],
        }),
      ).rejects.toThrow("destination parent contains a filesystem alias");

      await expect(fs.readFile(path.join(externalRoot, "secret.txt"), "utf8")).resolves.toBe(
        "outside sentinel\n",
      );
      await expect(matchingQuarantineRoots(projectRoot)).resolves.toEqual([]);
    },
  );

  test("rejects an in-project alias in a denied path parent", async () => {
    const alias = path.join(projectRoot, "linked-inside");
    await fs.symlink(
      path.join(projectRoot, "src"),
      alias,
      process.platform === "win32" ? "junction" : "dir",
    );

    await expect(
      prepareCodexDeniedPathGuard(projectRoot, {
        ...sandbox,
        deniedPaths: ["linked-inside/tracked.ts"],
      }),
    ).rejects.toThrow("destination parent contains a filesystem alias");

    await expect(fs.readFile(path.join(projectRoot, "src", "tracked.ts"), "utf8")).resolves.toMatch(
      /^export \{\};\r?\n$/,
    );
    await expect(matchingQuarantineRoots(projectRoot)).resolves.toEqual([]);
  });

  test("returns a stable no-op guard when there are no protected roots", async () => {
    const guard = await prepareCodexDeniedPathGuard(projectRoot, {
      ...sandbox,
      writablePaths: ["*"],
      deniedPaths: [],
    });

    const first = guard.finish();
    const second = guard.finish();
    expect(second).toBe(first);
    await expect(first).resolves.toEqual({ violations: [], restored: true });
    await expect(matchingQuarantineRoots(projectRoot)).resolves.toEqual([]);
  });

  test("restores the worktree pointer before failed ignored-path discovery", async () => {
    const dependencyFile = path.join(projectRoot, "node_modules", "pkg", "index.js");
    await fs.mkdir(path.dirname(dependencyFile), { recursive: true });
    await fs.writeFile(dependencyFile, "original\n");
    const gitPointer = await fs.readFile(path.join(projectRoot, ".git"), "utf8");
    const guard = await prepareCodexDeniedPathGuard(projectRoot, sandbox);
    await fs.rm(path.join(projectRoot, ".git"), { force: true });
    await fs.writeFile(path.join(projectRoot, ".git"), "gitdir: missing-worktree\n");

    await expect(guard.finish()).rejects.toThrow("Cannot inventory git-ignored paths");

    await expect(fs.readFile(path.join(projectRoot, ".git"), "utf8")).resolves.toBe(gitPointer);
    await expect(fs.readFile(dependencyFile, "utf8")).resolves.toBe("original\n");
  });

  test("recovers moved roots and protected-file copies from a durable manifest", async () => {
    const guardedSandbox: AdapterSandboxConfig = {
      ...sandbox,
      deniedPaths: [...sandbox.deniedPaths, ".quack/"],
    };
    const quackFile = path.join(projectRoot, ".quack", "adapter.json");
    await fs.mkdir(path.dirname(quackFile), { recursive: true });
    await fs.writeFile(quackFile, "original adapter bytes\n");
    const gitPointerBefore = await fs.readFile(path.join(projectRoot, ".git"), "utf8");

    await prepareCodexDeniedPathGuard(projectRoot, guardedSandbox);
    const quarantineRoot = await findQuarantineRoot();
    const manifest = JSON.parse(
      await fs.readFile(path.join(quarantineRoot, "manifest.json"), "utf8"),
    ) as {
      projectRoot: string;
      items: Array<{ relativePath: string; backupName: string; mode: string }>;
    };

    expect(await fs.realpath(manifest.projectRoot)).toBe(await fs.realpath(projectRoot));
    expect(manifest.items).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ relativePath: ".git", mode: "copy" }),
        expect.objectContaining({ relativePath: ".quack", mode: "move" }),
      ]),
    );
    await expect(fs.stat(path.join(projectRoot, ".quack"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    // Simulate Codex recreating the moved destination and mutating the
    // protected worktree pointer before its abruptly terminated owner exits.
    await fs.mkdir(path.dirname(quackFile), { recursive: true });
    await fs.writeFile(quackFile, "replacement adapter bytes\n");
    await fs.rm(path.join(projectRoot, ".git"), { force: true });
    await fs.writeFile(path.join(projectRoot, ".git"), "gitdir: attacker-controlled\n");

    const result = await recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot);

    expect(result.restored).toBe(true);
    expect(result.violations).toEqual(
      expect.arrayContaining([".git", ".quack", ".quack/adapter.json"]),
    );
    await expect(fs.readFile(quackFile, "utf8")).resolves.toBe("original adapter bytes\n");
    await expect(fs.readFile(path.join(projectRoot, ".git"), "utf8")).resolves.toBe(
      gitPointerBefore,
    );
    await expect(fs.stat(quarantineRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("uses the manifest-bound policy to remove denied and ignored roots created before orphan recovery", async () => {
    const guardedSandbox: AdapterSandboxConfig = {
      ...sandbox,
      deniedPaths: [...sandbox.deniedPaths, ".quack/", "forbidden-*"],
    };
    const quackFile = path.join(projectRoot, ".quack", "adapter.json");
    await fs.mkdir(path.dirname(quackFile), { recursive: true });
    await fs.writeFile(quackFile, "original adapter bytes\n");
    await prepareCodexDeniedPathGuard(projectRoot, guardedSandbox);
    const quarantineRoot = await findQuarantineRoot();

    // Simulate an interrupted worker replacing its mutable adapter config and
    // creating both an explicit denied root and a git-ignored root.
    await fs.mkdir(path.dirname(quackFile), { recursive: true });
    await fs.writeFile(
      quackFile,
      JSON.stringify({ sandbox: { writablePaths: ["."], deniedPaths: [] } }),
    );
    const forbiddenFile = path.join(projectRoot, "forbidden-new", "payload.txt");
    await fs.mkdir(path.dirname(forbiddenFile), { recursive: true });
    await fs.writeFile(forbiddenFile, "new denied bytes\n");
    const ignoredFile = path.join(projectRoot, "ignored-cache", "payload.txt");
    await fs.mkdir(path.dirname(ignoredFile), { recursive: true });
    await fs.writeFile(ignoredFile, "new ignored bytes\n");

    await recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot);

    await expect(fs.readFile(quackFile, "utf8")).resolves.toBe("original adapter bytes\n");
    await expect(fs.stat(path.dirname(forbiddenFile))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(fs.stat(path.dirname(ignoredFile))).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(quarantineRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("memoizes concurrent finish calls onto the same restoration promise", async () => {
    const ignoredCache = path.join(projectRoot, "ignored-cache", "state.bin");
    await fs.mkdir(path.dirname(ignoredCache), { recursive: true });
    await fs.writeFile(ignoredCache, "original\n");
    const guard = await prepareCodexDeniedPathGuard(projectRoot, sandbox);
    const quarantineRoot = await findQuarantineRoot();

    const first = guard.finish();
    const second = guard.finish();

    expect(second).toBe(first);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
    expect(firstResult).toEqual({ violations: [], restored: true });
    await expect(fs.readFile(ignoredCache, "utf8")).resolves.toBe("original\n");
    await expect(fs.stat(quarantineRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("atomically shares concurrent public orphan-recovery calls", async () => {
    const guardedSandbox: AdapterSandboxConfig = {
      ...sandbox,
      deniedPaths: [...sandbox.deniedPaths, ".quack/"],
    };
    const quackFile = path.join(projectRoot, ".quack", "adapter.json");
    await fs.mkdir(path.dirname(quackFile), { recursive: true });
    await fs.writeFile(quackFile, "original\n");
    await prepareCodexDeniedPathGuard(projectRoot, guardedSandbox);
    const quarantineRoot = await findQuarantineRoot();

    const first = recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot);
    const second = recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot);

    expect(second).toBe(first);
    const [firstResult, secondResult] = await Promise.all([first, second]);
    expect(secondResult).toBe(firstResult);
    await expect(fs.readFile(quackFile, "utf8")).resolves.toBe("original\n");
    await expect(fs.stat(quarantineRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("does not race to reclaim a stale recovery lock automatically", async () => {
    const ignoredCache = path.join(projectRoot, "ignored-cache", "state.bin");
    await fs.mkdir(path.dirname(ignoredCache), { recursive: true });
    await fs.writeFile(ignoredCache, "original\n");
    await prepareCodexDeniedPathGuard(projectRoot, sandbox);
    const quarantineRoot = await findQuarantineRoot();
    const deadPid = 2_000_000_000;
    await fs.writeFile(
      path.join(quarantineRoot, "recovery.lock"),
      `${JSON.stringify({ pid: deadPid })}\n`,
    );

    await expect(
      recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot, {
        reclaimRecoveryLockForPid: deadPid,
      }),
    ).rejects.toThrow("automatic reclaim is unsafe");

    await expect(
      fs.readFile(path.join(quarantineRoot, "recovery.lock"), "utf8"),
    ).resolves.toContain(String(deadPid));
    await expect(fs.readFile(path.join(quarantineRoot, "0"), "utf8")).resolves.toBeDefined();
  });

  test("completes recovery after a prior attempt already restored a moved root", async () => {
    const guardedSandbox: AdapterSandboxConfig = {
      ...sandbox,
      deniedPaths: [...sandbox.deniedPaths, ".quack/"],
    };
    const quackFile = path.join(projectRoot, ".quack", "adapter.json");
    await fs.mkdir(path.dirname(quackFile), { recursive: true });
    await fs.writeFile(quackFile, "original\n");
    await prepareCodexDeniedPathGuard(projectRoot, guardedSandbox);
    const quarantineRoot = await findQuarantineRoot();
    const manifest = JSON.parse(
      await fs.readFile(path.join(quarantineRoot, "manifest.json"), "utf8"),
    ) as {
      items: Array<{ relativePath: string; backupName: string; mode: string }>;
    };
    const movedItem = manifest.items.find((item) => item.relativePath === ".quack");
    expect(movedItem).toBeDefined();

    // Simulate a process dying after the move-back but before its final
    // inventory check and quarantine-directory deletion.
    await fs.rename(path.join(quarantineRoot, movedItem!.backupName), path.dirname(quackFile));

    await expect(recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot)).resolves.toEqual(
      expect.objectContaining({ restored: true }),
    );
    await expect(fs.readFile(quackFile, "utf8")).resolves.toBe("original\n");
    await expect(fs.stat(quarantineRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  test("preserves a concurrently recreated destination and its backup when preparation rollback fails", async () => {
    const guardedSandbox: AdapterSandboxConfig = {
      ...sandbox,
      deniedPaths: [...sandbox.deniedPaths, ".quack/", "fail-root/"],
    };
    const quackFile = path.join(projectRoot, ".quack", "adapter.json");
    await fs.mkdir(path.dirname(quackFile), { recursive: true });
    await fs.writeFile(quackFile, "original adapter\n");
    const failFile = path.join(projectRoot, "fail-root", "payload.txt");
    await fs.mkdir(path.dirname(failFile), { recursive: true });
    await fs.writeFile(failFile, "original failure root\n");
    const realRename =
      jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises").rename;
    const renameMock = jest.mocked(fs.rename);
    renameMock.mockImplementation(async (source, target) => {
      if (path.normalize(String(source)) === path.normalize(path.dirname(failFile))) {
        await fs.mkdir(path.dirname(quackFile), { recursive: true });
        await fs.writeFile(path.join(path.dirname(quackFile), "recreated.txt"), "new bytes\n");
        throw new Error("forced preparation failure");
      }
      return realRename(source, target);
    });

    try {
      await expect(prepareCodexDeniedPathGuard(projectRoot, guardedSandbox)).rejects.toThrow(
        "quarantine rollback failed",
      );
    } finally {
      renameMock.mockImplementation(realRename);
    }

    const quarantineRoot = await findQuarantineRoot();
    const manifest = JSON.parse(
      await fs.readFile(path.join(quarantineRoot, "manifest.json"), "utf8"),
    ) as {
      items: Array<{ relativePath: string; backupName: string }>;
    };
    const movedItem = manifest.items.find((item) => item.relativePath === ".quack");
    expect(movedItem).toBeDefined();
    await expect(
      fs.readFile(path.join(projectRoot, ".quack", "recreated.txt"), "utf8"),
    ).resolves.toBe("new bytes\n");
    await expect(
      fs.readFile(path.join(quarantineRoot, movedItem!.backupName, "adapter.json"), "utf8"),
    ).resolves.toBe("original adapter\n");
  });

  test("rejects a cross-project manifest without changing or deleting recovery data", async () => {
    const guardedSandbox: AdapterSandboxConfig = {
      ...sandbox,
      deniedPaths: [...sandbox.deniedPaths, ".quack/"],
    };
    const quackFile = path.join(projectRoot, ".quack", "adapter.json");
    await fs.mkdir(path.dirname(quackFile), { recursive: true });
    await fs.writeFile(quackFile, "original\n");
    await prepareCodexDeniedPathGuard(projectRoot, guardedSandbox);
    const quarantineRoot = await findQuarantineRoot();
    const otherProjectRoot = `${projectRoot}-other`;
    await fs.mkdir(otherProjectRoot, { recursive: true });

    await expect(
      recoverCodexDeniedPathQuarantine(otherProjectRoot, quarantineRoot),
    ).rejects.toThrow("canonical projectRoot mismatch");
    await expect(fs.stat(quarantineRoot)).resolves.toBeDefined();
    await expect(fs.stat(path.join(projectRoot, ".quack"))).rejects.toMatchObject({
      code: "ENOENT",
    });

    await recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot);
    await expect(fs.readFile(quackFile, "utf8")).resolves.toBe("original\n");
    await fs.rm(otherProjectRoot, { recursive: true, force: true });
  });

  test("preserves malformed manifests and their backups without touching destinations", async () => {
    const guardedSandbox: AdapterSandboxConfig = {
      ...sandbox,
      deniedPaths: [...sandbox.deniedPaths, ".quack/"],
    };
    const quackFile = path.join(projectRoot, ".quack", "adapter.json");
    await fs.mkdir(path.dirname(quackFile), { recursive: true });
    await fs.writeFile(quackFile, "original\n");
    await prepareCodexDeniedPathGuard(projectRoot, guardedSandbox);
    const quarantineRoot = await findQuarantineRoot();
    const manifestPath = path.join(quarantineRoot, "manifest.json");
    const originalManifest = await fs.readFile(manifestPath, "utf8");
    await fs.writeFile(manifestPath, "{ definitely not valid JSON", "utf8");
    await fs.mkdir(path.dirname(quackFile), { recursive: true });
    await fs.writeFile(quackFile, "replacement\n");

    await expect(recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot)).rejects.toThrow(
      "Invalid Codex denied-path quarantine manifest",
    );
    await expect(fs.stat(quarantineRoot)).resolves.toBeDefined();
    await expect(fs.readFile(quackFile, "utf8")).resolves.toBe("replacement\n");

    await fs.writeFile(manifestPath, originalManifest, "utf8");
    await recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot);
    await expect(fs.readFile(quackFile, "utf8")).resolves.toBe("original\n");
  });

  test("rejects a manifest that marks a copy-backed file as disposable", async () => {
    const dependencyFile = path.join(projectRoot, "node_modules", "demo-package", "index.js");
    await fs.mkdir(path.dirname(dependencyFile), { recursive: true });
    await fs.writeFile(dependencyFile, "trusted dependency\n");
    await prepareCodexDeniedPathGuard(projectRoot, {
      ...sandbox,
      disposablePaths: ["node_modules/"],
    });
    const quarantineRoot = await findQuarantineRoot();
    const manifestPath = path.join(quarantineRoot, "manifest.json");
    const originalManifest = await fs.readFile(manifestPath, "utf8");
    const manifest = JSON.parse(originalManifest) as {
      policy: { disposablePaths: string[] };
    };
    manifest.policy.disposablePaths = [".git"];
    await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await expect(recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot)).rejects.toThrow(
      "is not a safe moved directory root",
    );
    await expect(fs.stat(quarantineRoot)).resolves.toBeDefined();
    await expect(fs.readFile(dependencyFile, "utf8")).resolves.toBe("trusted dependency\n");

    await fs.writeFile(manifestPath, originalManifest, "utf8");
    await recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot);
    await expect(fs.readFile(dependencyFile, "utf8")).resolves.toBe("trusted dependency\n");
  });

  test("retains recovery evidence when a backup cannot reproduce the original inventory", async () => {
    const guardedSandbox: AdapterSandboxConfig = {
      ...sandbox,
      deniedPaths: [...sandbox.deniedPaths, ".quack/"],
    };
    const quackFile = path.join(projectRoot, ".quack", "adapter.json");
    await fs.mkdir(path.dirname(quackFile), { recursive: true });
    await fs.writeFile(quackFile, "original\n");
    await prepareCodexDeniedPathGuard(projectRoot, guardedSandbox);
    const quarantineRoot = await findQuarantineRoot();
    const manifest = JSON.parse(
      await fs.readFile(path.join(quarantineRoot, "manifest.json"), "utf8"),
    ) as {
      items: Array<{ relativePath: string; backupName: string; mode: string }>;
    };
    const movedItem = manifest.items.find((item) => item.relativePath === ".quack");
    expect(movedItem).toBeDefined();
    await fs.writeFile(
      path.join(quarantineRoot, movedItem!.backupName, "adapter.json"),
      "corrupted backup\n",
    );

    await expect(recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot)).rejects.toThrow(
      "backup inventory mismatch for .quack",
    );
    await expect(fs.stat(quarantineRoot)).resolves.toBeDefined();
    await expect(fs.stat(path.join(projectRoot, ".quack"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  test("accepts an exact protected-file destination when its copy backup is corrupt", async () => {
    const guardedSandbox: AdapterSandboxConfig = {
      ...sandbox,
      deniedPaths: [...sandbox.deniedPaths, ".quack/"],
    };
    const quackFile = path.join(projectRoot, ".quack", "adapter.json");
    await fs.mkdir(path.dirname(quackFile), { recursive: true });
    await fs.writeFile(quackFile, "original\n");
    const gitPointer = await fs.readFile(path.join(projectRoot, ".git"), "utf8");
    await prepareCodexDeniedPathGuard(projectRoot, guardedSandbox);
    const quarantineRoot = await findQuarantineRoot();
    const manifest = JSON.parse(
      await fs.readFile(path.join(quarantineRoot, "manifest.json"), "utf8"),
    ) as {
      items: Array<{ relativePath: string; backupName: string; mode: string }>;
    };
    const copiedItem = manifest.items.find((item) => item.mode === "copy");
    expect(copiedItem).toBeDefined();
    const copyBackup = path.join(quarantineRoot, copiedItem!.backupName);
    await fs.rm(copyBackup, { force: true });
    await fs.writeFile(copyBackup, "corrupt copy\n");

    await expect(recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot)).resolves.toEqual(
      expect.objectContaining({ restored: true }),
    );

    await expect(fs.readFile(path.join(projectRoot, ".git"), "utf8")).resolves.toBe(gitPointer);
    await expect(fs.readFile(quackFile, "utf8")).resolves.toBe("original\n");
    await expect(fs.stat(quarantineRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  registerTest.each([
    [
      "destination",
      (item: Record<string, unknown>) => {
        item.relativePath = "../escape";
      },
    ],
    [
      "dot-segment destination",
      (item: Record<string, unknown>) => {
        item.relativePath = "nested/./alias";
      },
    ],
    [
      "empty-segment destination",
      (item: Record<string, unknown>) => {
        item.relativePath = "nested//alias";
      },
    ],
    [
      "backup",
      (item: Record<string, unknown>) => {
        item.backupName = "../escape";
      },
    ],
  ])(
    "rejects a manifest whose %s path escapes its recovery boundary",
    (_label, mutate) =>
      ownCase(async () => {
        const guardedSandbox: AdapterSandboxConfig = {
          ...sandbox,
          deniedPaths: [...sandbox.deniedPaths, ".quack/"],
        };
        const quackFile = path.join(projectRoot, ".quack", "adapter.json");
        await fs.mkdir(path.dirname(quackFile), { recursive: true });
        await fs.writeFile(quackFile, "original\n");
        await prepareCodexDeniedPathGuard(projectRoot, guardedSandbox);
        const quarantineRoot = await findQuarantineRoot();
        const manifestPath = path.join(quarantineRoot, "manifest.json");
        const originalManifest = await fs.readFile(manifestPath, "utf8");
        const manifest = JSON.parse(originalManifest) as {
          items: Array<Record<string, unknown>>;
        };
        const movedItem = manifest.items.find((item) => item.mode === "move");
        expect(movedItem).toBeDefined();
        mutate(movedItem!);
        await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

        await expect(recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot)).rejects.toThrow(
          "Invalid Codex denied-path quarantine manifest",
        );
        await expect(fs.stat(quarantineRoot)).resolves.toBeDefined();
        await expect(fs.stat(path.join(projectRoot, ".quack"))).rejects.toMatchObject({
          code: "ENOENT",
        });

        await fs.writeFile(manifestPath, originalManifest, "utf8");
        await recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot);
        await expect(fs.readFile(quackFile, "utf8")).resolves.toBe("original\n");
      }),
    REAL_GIT_CASE_TIMEOUT_MS,
  );

  registerWindowsTest.each(["C:escape", "NUL"])(
    "rejects the Windows alias hazard %s in a manifest destination",
    (unsafePath) =>
      ownCase(async () => {
        const guardedSandbox: AdapterSandboxConfig = {
          ...sandbox,
          deniedPaths: [...sandbox.deniedPaths, ".quack/"],
        };
        const quackFile = path.join(projectRoot, ".quack", "adapter.json");
        await fs.mkdir(path.dirname(quackFile), { recursive: true });
        await fs.writeFile(quackFile, "original\n");
        await prepareCodexDeniedPathGuard(projectRoot, guardedSandbox);
        const quarantineRoot = await findQuarantineRoot();
        const manifestPath = path.join(quarantineRoot, "manifest.json");
        const originalManifest = await fs.readFile(manifestPath, "utf8");
        const manifest = JSON.parse(originalManifest) as {
          items: Array<Record<string, unknown>>;
        };
        const movedItem = manifest.items.find((item) => item.mode === "move");
        expect(movedItem).toBeDefined();
        movedItem!.relativePath = unsafePath;
        await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

        await expect(recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot)).rejects.toThrow(
          "unsafe item",
        );
        await expect(fs.stat(quarantineRoot)).resolves.toBeDefined();
        await expect(fs.stat(path.join(projectRoot, ".quack"))).rejects.toMatchObject({
          code: "ENOENT",
        });

        await fs.writeFile(manifestPath, originalManifest, "utf8");
        await recoverCodexDeniedPathQuarantine(projectRoot, quarantineRoot);
        await expect(fs.readFile(quackFile, "utf8")).resolves.toBe("original\n");
      }),
    REAL_GIT_CASE_TIMEOUT_MS,
  );
});
