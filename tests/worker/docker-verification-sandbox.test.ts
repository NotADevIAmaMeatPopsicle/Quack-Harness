import { randomUUID } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import { computeAdapterBundleMetadata, type ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig, DockerVerificationSandboxConfig } from "../../src/core/types";
import {
  _setDockerVerificationCommandRunner,
  _setDockerVerificationDelay,
  _setDockerVerificationDnsResolver,
  _setDockerVerificationExecutableResolver,
  DockerVerificationSession,
  stageDockerVerificationContext,
  validateDockerDependencyMetadata,
  type DockerVerificationResult,
} from "../../src/worker/docker-verification-sandbox";
import { runVerification } from "../../src/worker/tools/verify";

const repoRoot = path.resolve(__dirname, "..", "..");
const IMAGE_DIGEST = "83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5";
const NODE_IMAGE = `node:22-bookworm-slim@sha256:${IMAGE_DIGEST}`;
const FULL_IMAGE_DIGEST = "8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d";
const FULL_NODE_IMAGE = `node:22-bookworm@sha256:${FULL_IMAGE_DIGEST}`;
const REGISTRY = "https://registry.npmjs.org";
const BETTER_SQLITE_INTEGRITY =
  "sha512-RxD2Vd96sQDjQr20kdP+F+dK/1OUNiVOl200vKBZY8u0vTwysfolF6Hq+3ZK2+h8My9YvZhHsF+RSGZW2VYrPQ==";
const BETTER_SQLITE_REBUILD = {
  dependencyRoot: ".",
  packageName: "better-sqlite3",
  version: "12.8.0",
  integrity: BETTER_SQLITE_INTEGRITY,
  installScript: "prebuild-install || node-gyp rebuild --release",
} as const;

const sandboxConfig: DockerVerificationSandboxConfig = {
  image: NODE_IMAGE,
  pidsLimit: 64,
  memoryMb: 512,
  cpus: 1,
  tmpfsSizeMb: 64,
  dependencyRoots: ["."],
  allowedRegistryOrigins: [REGISTRY],
  setupTimeoutMs: 60_000,
  maxContextBytes: 16 * 1024 * 1024,
  maxOutputBytes: 1024,
};

function realDockerImagesAvailable(): boolean {
  if (process.env.QUACK_RUN_DOCKER_INTEGRATION === "0") return false;
  const info = spawnSync("docker", ["info", "--format", "{{.ServerVersion}}"], {
    encoding: "utf8",
    timeout: 5_000,
    windowsHide: true,
  });
  if (info.status !== 0 || !info.stdout.trim()) return false;
  const images = spawnSync("docker", ["image", "inspect", NODE_IMAGE, FULL_NODE_IMAGE], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
  });
  return images.status === 0;
}

const dockerIntegrationTest = realDockerImagesAvailable() ? test : test.skip;

function success(stdout = ""): DockerVerificationResult {
  return { exitCode: 0, stdout, stderr: "", timedOut: false };
}

async function writeLockedPackage(root: string, dependency = false): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      ...(dependency ? { dependencies: { example: "1.0.0" } } : {}),
    }),
  );
  await fs.writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      name: "fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "fixture",
          version: "1.0.0",
          ...(dependency ? { dependencies: { example: "1.0.0" } } : {}),
        },
        ...(dependency
          ? {
              "node_modules/example": {
                version: "1.0.0",
                resolved: `${REGISTRY}/example/-/example-1.0.0.tgz`,
                integrity: "sha512-QUJDRA==",
              },
            }
          : {}),
      },
    }),
  );
}

async function writeNativeLockedPackage(root: string): Promise<void> {
  await fs.mkdir(root, { recursive: true });
  await fs.writeFile(
    path.join(root, "package.json"),
    JSON.stringify({
      name: "native-fixture",
      version: "1.0.0",
      dependencies: { "better-sqlite3": "12.8.0" },
    }),
  );
  await fs.writeFile(
    path.join(root, "package-lock.json"),
    JSON.stringify({
      name: "native-fixture",
      version: "1.0.0",
      lockfileVersion: 3,
      packages: {
        "": {
          name: "native-fixture",
          version: "1.0.0",
          dependencies: { "better-sqlite3": "12.8.0" },
        },
        "node_modules/better-sqlite3": {
          version: "12.8.0",
          resolved: `${REGISTRY}/better-sqlite3/-/better-sqlite3-12.8.0.tgz`,
          integrity: BETTER_SQLITE_INTEGRITY,
          hasInstallScript: true,
        },
      },
    }),
  );
}

describe("disposable Docker verification sandbox", () => {
  let fixtureRoot: string;

  beforeEach(async () => {
    fixtureRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-docker-verify-test-"));
    _setDockerVerificationDnsResolver(() =>
      Promise.resolve([{ address: "104.16.24.34", family: 4 }]),
    );
    _setDockerVerificationDelay(() => Promise.resolve());
  });

  afterEach(async () => {
    _setDockerVerificationCommandRunner(undefined);
    _setDockerVerificationExecutableResolver(undefined);
    _setDockerVerificationDnsResolver(undefined);
    _setDockerVerificationDelay(undefined);
    await fs.rm(fixtureRoot, { recursive: true, force: true });
  });

  test("stages only safe worktree files and overlays authoritative verification machinery", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    const authoritative = path.join(fixtureRoot, "authoritative");
    await writeLockedPackage(worktree);
    await fs.mkdir(path.join(worktree, "src"));
    await fs.mkdir(path.join(worktree, "node_modules", "unsafe"), { recursive: true });
    await fs.mkdir(path.join(worktree, "dist"));
    await fs.mkdir(path.join(worktree, ".quack"));
    await fs.mkdir(path.join(authoritative, ".quack", "convention-checks"), { recursive: true });
    await fs.writeFile(path.join(worktree, "src", "feature.ts"), "export const safe = true;\n");
    await fs.writeFile(path.join(worktree, ".git"), "gitdir: outside\n");
    await fs.writeFile(path.join(worktree, ".env.production"), "TOKEN=secret\n");
    await fs.writeFile(path.join(worktree, "id_ed25519"), "private key\n");
    await fs.writeFile(path.join(worktree, "node_modules", "unsafe", "index.js"), "bad\n");
    await fs.writeFile(path.join(worktree, "dist", "bundle.js"), "built\n");
    await fs.writeFile(path.join(worktree, ".quack", "adapter.json"), "worker-tampered\n");
    await fs.writeFile(path.join(authoritative, ".quack", "adapter.json"), "authoritative\n");
    await fs.writeFile(path.join(authoritative, ".quack", "test.config.json"), "{}\n");
    await fs.writeFile(
      path.join(authoritative, ".quack", "convention-checks", "policy.js"),
      "process.exit(0);\n",
    );
    await fs.writeFile(path.join(authoritative, ".quack", "quack.db"), "runtime database\n");

    const staged = await stageDockerVerificationContext({
      worktreeRoot: worktree,
      authoritativeRoot: authoritative,
      config: sandboxConfig,
      deniedPaths: [".quack/"],
    });
    try {
      await expect(
        fs.readFile(path.join(staged.workspaceRoot, "src", "feature.ts"), "utf8"),
      ).resolves.toContain("safe");
      await expect(
        fs.readFile(path.join(staged.machineryRoot, "adapter.json"), "utf8"),
      ).resolves.toBe("authoritative\n");
      await expect(
        fs.readFile(path.join(staged.machineryRoot, "test.config.json")),
      ).resolves.toBeDefined();
      await expect(
        fs.readFile(path.join(staged.machineryRoot, "convention-checks", "policy.js")),
      ).resolves.toBeDefined();
      for (const excluded of [
        ".git",
        ".env.production",
        "id_ed25519",
        path.join("node_modules", "unsafe", "index.js"),
        path.join("dist", "bundle.js"),
        path.join(".quack", "quack.db"),
      ]) {
        await expect(fs.lstat(path.join(staged.workspaceRoot, excluded))).rejects.toMatchObject({
          code: "ENOENT",
        });
      }
      await expect(fs.lstat(path.join(staged.workspaceRoot, ".quack"))).rejects.toMatchObject({
        code: "ENOENT",
      });
      await expect(fs.lstat(path.join(staged.contextRoot, "Dockerfile"))).rejects.toMatchObject({
        code: "ENOENT",
      });
    } finally {
      await fs.rm(staged.contextRoot, { recursive: true, force: true });
    }
  });

  test("rejects aliases and project npm configuration before Docker is invoked", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    const outside = path.join(fixtureRoot, "outside");
    await writeLockedPackage(worktree);
    await fs.mkdir(outside);
    await fs.writeFile(path.join(outside, "secret.txt"), "secret\n");
    await fs.symlink(
      outside,
      path.join(worktree, "escape"),
      process.platform === "win32" ? "junction" : "dir",
    );
    await expect(
      stageDockerVerificationContext({
        worktreeRoot: worktree,
        authoritativeRoot: worktree,
        config: sandboxConfig,
        deniedPaths: ["../outside"],
      }),
    ).rejects.toThrow(/deniedPaths\[0\].*safe relative pattern/i);
    await expect(
      stageDockerVerificationContext({
        worktreeRoot: worktree,
        authoritativeRoot: worktree,
        config: sandboxConfig,
        deniedPaths: ["escape"],
      }),
    ).rejects.toThrow(/denied path is aliased/i);

    await fs.rm(path.join(worktree, "escape"), { recursive: true, force: true });
    await fs.writeFile(path.join(worktree, ".npmrc"), "//registry.npmjs.org/:_authToken=secret\n");
    await expect(
      stageDockerVerificationContext({
        worktreeRoot: worktree,
        authoritativeRoot: worktree,
        config: sandboxConfig,
        deniedPaths: [],
      }),
    ).rejects.toThrow(/refuses project \.npmrc/i);

    await fs.rm(path.join(worktree, ".npmrc"));
    await fs.writeFile(
      path.join(worktree, "innocent-looking.txt"),
      [
        "-----BEGIN OPENSSH PRIVATE KEY-----",
        "A1b2C3d4E5f6G7h8I9j0K1l2M3n4O5p6Q7r8S9t0U1v2W3x4",
        "-----END OPENSSH PRIVATE KEY-----",
      ].join("\n"),
    );
    await expect(
      stageDockerVerificationContext({
        worktreeRoot: worktree,
        authoritativeRoot: worktree,
        config: sandboxConfig,
        deniedPaths: [],
      }),
    ).rejects.toThrow(/refused safety-tier secret material/i);
  });

  test("stages scanner source and synthetic key fixtures but rejects real-shaped keys", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    await writeLockedPackage(worktree);
    const scannerRelative = path.join("src", "judgment", "producers", "secret-scan.ts");
    const fixtureRelative = path.join("tests", "fixtures", "synthetic-private-key.ts");
    await fs.mkdir(path.join(worktree, path.dirname(scannerRelative)), { recursive: true });
    await fs.mkdir(path.join(worktree, path.dirname(fixtureRelative)), { recursive: true });
    await fs.copyFile(path.join(repoRoot, scannerRelative), path.join(worktree, scannerRelative));
    const syntheticPem = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIFakeBodyLine1AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
      "MIIFakeBodyLine2AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");
    await fs.writeFile(
      path.join(worktree, fixtureRelative),
      `export const SYNTHETIC_PRIVATE_KEY = ${JSON.stringify(syntheticPem)};\n`,
    );

    const staged = await stageDockerVerificationContext({
      worktreeRoot: worktree,
      authoritativeRoot: worktree,
      config: sandboxConfig,
      deniedPaths: [],
    });
    try {
      await expect(
        fs.readFile(path.join(staged.workspaceRoot, scannerRelative), "utf8"),
      ).resolves.toContain("scanForSecrets");
      await expect(
        fs.readFile(path.join(staged.workspaceRoot, fixtureRelative), "utf8"),
      ).resolves.toContain("SYNTHETIC_PRIVATE_KEY");
    } finally {
      await fs.rm(staged.contextRoot, { recursive: true, force: true });
    }

    await fs.writeFile(path.join(worktree, "src", "runtime-credential.txt"), syntheticPem);
    await expect(
      stageDockerVerificationContext({
        worktreeRoot: worktree,
        authoritativeRoot: worktree,
        config: sandboxConfig,
        deniedPaths: [],
      }),
    ).rejects.toThrow(/refused safety-tier secret material.*runtime-credential\.txt/i);
  });

  test("rejects an oversized sparse file before attempting a full-content read", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    await writeLockedPackage(worktree);
    const sparsePath = path.join(worktree, "z-sparse.bin");
    await fs.writeFile(sparsePath, "x");
    await fs.truncate(sparsePath, sandboxConfig.maxContextBytes + 1);
    const fsPromisesModule = jest.requireActual<typeof import("node:fs")>("node:fs").promises;
    const readSpy = jest.spyOn(fsPromisesModule, "readFile");

    try {
      await expect(
        stageDockerVerificationContext({
          worktreeRoot: worktree,
          authoritativeRoot: worktree,
          config: sandboxConfig,
          deniedPaths: [],
        }),
      ).rejects.toThrow(/context exceeds limit/i);
      expect(
        readSpy.mock.calls.some(
          ([candidate]) => typeof candidate === "string" && path.resolve(candidate) === sparsePath,
        ),
      ).toBe(false);
    } finally {
      readSpy.mockRestore();
    }
  });

  test("fails closed when one file exceeds the bounded secret-scan size", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    await writeLockedPackage(worktree);
    const sparsePath = path.join(worktree, "large-source.txt");
    await fs.writeFile(sparsePath, "x");
    await fs.truncate(sparsePath, 8 * 1024 * 1024 + 1);

    await expect(
      stageDockerVerificationContext({
        worktreeRoot: worktree,
        authoritativeRoot: worktree,
        config: sandboxConfig,
        deniedPaths: [],
      }),
    ).rejects.toThrow(/bounded secret-scan limit.*large-source\.txt/i);
  });

  test("rejects an in-place same-size source mutation between scanning and staging", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    await writeLockedPackage(worktree);
    await fs.mkdir(path.join(worktree, "src"));
    const sourcePath = path.join(worktree, "src", "race.txt");
    await fs.writeFile(sourcePath, "original\n");
    const originalMetadata = await fs.stat(sourcePath);
    const mutableFsPromises = jest.requireActual<typeof import("node:fs")>("node:fs").promises;
    const realWriteFile = mutableFsPromises.writeFile.bind(mutableFsPromises);
    const lstatSpy = jest.spyOn(mutableFsPromises, "lstat");
    let mutated = false;
    const writeSpy = jest
      .spyOn(mutableFsPromises, "writeFile")
      .mockImplementation(async (target, data, options) => {
        if (
          !mutated &&
          typeof target === "string" &&
          target.endsWith(path.join("workspace", "src", "race.txt"))
        ) {
          mutated = true;
          await realWriteFile(sourcePath, "MUTATED\n");
          await fs.utimes(sourcePath, originalMetadata.atime, originalMetadata.mtime);
        }
        await realWriteFile(target, data, options);
      });

    try {
      await expect(
        stageDockerVerificationContext({
          worktreeRoot: worktree,
          authoritativeRoot: worktree,
          config: sandboxConfig,
          deniedPaths: [],
        }),
      ).rejects.toThrow(/source changed during staging.*race\.txt/i);
      expect(mutated).toBe(true);
      expect(lstatSpy).toHaveBeenCalledWith(sourcePath, { bigint: true });
    } finally {
      writeSpy.mockRestore();
      lstatSpy.mockRestore();
    }
  });

  test("supports explicit nested package roots and rejects unsafe manifest or lock metadata", async () => {
    const workspace = path.join(fixtureRoot, "workspace");
    await writeLockedPackage(workspace);
    await writeLockedPackage(path.join(workspace, "frontend"), true);
    await expect(
      validateDockerDependencyMetadata({
        workspaceRoot: workspace,
        dependencyRoots: [".", "frontend"],
        allowedRegistryOrigins: [REGISTRY],
      }),
    ).resolves.toBeUndefined();

    await fs.writeFile(
      path.join(workspace, "frontend", "package.json"),
      JSON.stringify({
        name: "fixture",
        version: "1.0.0",
        dependencies: { bad: "https://evil.example/bad.tgz" },
      }),
    );
    await expect(
      validateDockerDependencyMetadata({
        workspaceRoot: workspace,
        dependencyRoots: ["frontend"],
        allowedRegistryOrigins: [REGISTRY],
      }),
    ).rejects.toThrow(/Unsafe dependencies spec/i);

    await writeLockedPackage(path.join(workspace, "frontend"), true);
    const lockPath = path.join(workspace, "frontend", "package-lock.json");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as Record<string, unknown>;
    const packages = lock.packages as Record<string, Record<string, unknown>>;
    packages["node_modules/example"].resolved = "https://evil.example/example.tgz";
    await fs.writeFile(lockPath, JSON.stringify(lock));
    await expect(
      validateDockerDependencyMetadata({
        workspaceRoot: workspace,
        dependencyRoots: ["frontend"],
        allowedRegistryOrigins: [REGISTRY],
      }),
    ).rejects.toThrow(/outside the configured registry origins/i);

    await writeLockedPackage(path.join(workspace, "frontend"), true);
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "root", version: "1.0.0", workspaces: ["frontend"] }),
    );
    await expect(
      validateDockerDependencyMetadata({
        workspaceRoot: workspace,
        dependencyRoots: ["frontend"],
        allowedRegistryOrigins: [REGISTRY],
      }),
    ).rejects.toThrow(/implicit workspace/i);
  });

  test("requires exact lock attestations for every offline native rebuild", async () => {
    const workspace = path.join(fixtureRoot, "native-workspace");
    await writeNativeLockedPackage(workspace);
    await expect(
      validateDockerDependencyMetadata({
        workspaceRoot: workspace,
        dependencyRoots: ["."],
        allowedRegistryOrigins: [REGISTRY],
        offlineNativeRebuilds: [{ ...BETTER_SQLITE_REBUILD, integrity: "sha512-QUJDRA==" }],
      }),
    ).rejects.toThrow(/not an exact sha512 SRI/i);

    await writeNativeLockedPackage(workspace);
    await expect(
      validateDockerDependencyMetadata({
        workspaceRoot: workspace,
        dependencyRoots: ["."],
        allowedRegistryOrigins: [REGISTRY],
        offlineNativeRebuilds: [BETTER_SQLITE_REBUILD],
      }),
    ).resolves.toBeUndefined();

    const lockPath = path.join(workspace, "package-lock.json");
    const lock = JSON.parse(await fs.readFile(lockPath, "utf8")) as {
      packages: Record<string, Record<string, unknown>>;
    };
    lock.packages["node_modules/better-sqlite3"].integrity = "sha512-QUJDRA==";
    await fs.writeFile(lockPath, JSON.stringify(lock));
    await expect(
      validateDockerDependencyMetadata({
        workspaceRoot: workspace,
        dependencyRoots: ["."],
        allowedRegistryOrigins: [REGISTRY],
        offlineNativeRebuilds: [BETTER_SQLITE_REBUILD],
      }),
    ).rejects.toThrow(/does not match its exact version, integrity, and install-script/i);

    await writeNativeLockedPackage(workspace);
    await expect(
      validateDockerDependencyMetadata({
        workspaceRoot: workspace,
        dependencyRoots: ["."],
        allowedRegistryOrigins: [REGISTRY],
        offlineNativeRebuilds: [{ ...BETTER_SQLITE_REBUILD, dependencyRoot: "frontend" }],
      }),
    ).rejects.toThrow(/root is not configured/i);
  });

  test("fails closed for IP-literal, private-resolution, and mutable-root Docker executables", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    await writeLockedPackage(worktree);
    const fakeDocker = path.join(worktree, process.platform === "win32" ? "docker.exe" : "docker");
    await fs.writeFile(fakeDocker, "fake");
    _setDockerVerificationExecutableResolver(() => fakeDocker);
    await expect(
      DockerVerificationSession.create({
        worktreeRoot: worktree,
        authoritativeRoot: worktree,
        config: { ...sandboxConfig, allowedRegistryOrigins: ["https://127.0.0.1"] },
        deniedPaths: [],
      }),
    ).rejects.toThrow(/credential-free HTTPS hostname origin/i);

    _setDockerVerificationDnsResolver(() => Promise.resolve([{ address: "10.0.0.8", family: 4 }]));
    await expect(
      DockerVerificationSession.create({
        worktreeRoot: worktree,
        authoritativeRoot: worktree,
        config: sandboxConfig,
        deniedPaths: [],
      }),
    ).rejects.toThrow(/non-global address/i);

    _setDockerVerificationDnsResolver(() => Promise.resolve([{ address: "fc00::1", family: 6 }]));
    await expect(
      DockerVerificationSession.create({
        worktreeRoot: worktree,
        authoritativeRoot: worktree,
        config: sandboxConfig,
        deniedPaths: [],
      }),
    ).rejects.toThrow(/non-global address/i);

    _setDockerVerificationDnsResolver(() =>
      Promise.resolve([{ address: "104.16.24.34", family: 4 }]),
    );
    await expect(
      DockerVerificationSession.create({
        worktreeRoot: worktree,
        authoritativeRoot: worktree,
        config: sandboxConfig,
        deniedPaths: [],
      }),
    ).rejects.toThrow(/executable resolves inside the worktree/i);

    _setDockerVerificationExecutableResolver(() => path.join(process.cwd(), "package.json"));
    await expect(
      DockerVerificationSession.create({
        worktreeRoot: worktree,
        authoritativeRoot: worktree,
        config: sandboxConfig,
        deniedPaths: [],
      }),
    ).rejects.toThrow(/executable resolves inside the host working directory/i);

    const authoritative = path.join(fixtureRoot, "authoritative");
    const authoritativeDocker = path.join(
      authoritative,
      process.platform === "win32" ? "docker.exe" : "docker",
    );
    await fs.mkdir(authoritative);
    await fs.writeFile(authoritativeDocker, "fake");
    _setDockerVerificationExecutableResolver(() => authoritativeDocker);
    await expect(
      DockerVerificationSession.create({
        worktreeRoot: worktree,
        authoritativeRoot: authoritative,
        config: sandboxConfig,
        deniedPaths: [],
      }),
    ).rejects.toThrow(/executable resolves inside the authoritative project/i);
  });

  test("sweeps labeled resources from a crashed owner before creating a new session", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    const dockerExecutable = path.join(
      fixtureRoot,
      process.platform === "win32" ? "docker.exe" : "docker",
    );
    await writeLockedPackage(worktree);
    await fs.writeFile(dockerExecutable, "trusted");
    const staleSession = "a".repeat(32);
    let staleContainerPresent = true;
    const invocations: string[][] = [];
    _setDockerVerificationExecutableResolver(() => dockerExecutable);
    _setDockerVerificationCommandRunner((_executable, args) => {
      invocations.push([...args]);
      const filterIndex = args.indexOf("--filter");
      const filter = filterIndex >= 0 ? args[filterIndex + 1] : undefined;
      if (
        args[0] === "container" &&
        args[1] === "ls" &&
        filter === "label=com.quack.verification-session"
      ) {
        return Promise.resolve(success(`${staleSession}|2147483646|${Date.now() - 10_000}\n`));
      }
      if (
        args[0] === "container" &&
        args[1] === "ls" &&
        filter === `label=com.quack.verification-session=${staleSession}`
      ) {
        return Promise.resolve(success(staleContainerPresent ? "stale-container\n" : ""));
      }
      if (args[0] === "rm" && args.includes("stale-container")) staleContainerPresent = false;
      if (args[0] === "image" && args[1] === "inspect") {
        return Promise.resolve(success(JSON.stringify([`node@sha256:${IMAGE_DIGEST}`])));
      }
      if (args[0] === "inspect") return Promise.resolve(success("172.30.0.2"));
      return Promise.resolve(success());
    });

    const session = await DockerVerificationSession.create({
      worktreeRoot: worktree,
      authoritativeRoot: worktree,
      config: sandboxConfig,
      deniedPaths: [],
    });
    await session.dispose();

    expect(staleContainerPresent).toBe(false);
    expect(invocations.some((args) => args[0] === "rm" && args.includes("stale-container"))).toBe(
      true,
    );
  });

  test("sweeps only manifest-proven stale source snapshots from the dedicated temp root", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    const dockerExecutable = path.join(
      fixtureRoot,
      process.platform === "win32" ? "docker.exe" : "docker",
    );
    await writeLockedPackage(worktree);
    await fs.writeFile(dockerExecutable, "trusted");
    const staleSession = randomUUID().replace(/-/g, "").toLowerCase();
    const tempParent = path.join(await fs.realpath(os.tmpdir()), "quack-verification-sessions-v1");
    const staleRoot = path.join(tempParent, staleSession);
    const unrelatedRoot = path.join(tempParent, `unrelated-${staleSession}`);
    await fs.mkdir(path.join(staleRoot, "workspace"), { recursive: true });
    await fs.mkdir(unrelatedRoot, { recursive: true });
    await fs.writeFile(path.join(staleRoot, "workspace", "source.ts"), "sensitive source\n");
    await fs.writeFile(
      path.join(staleRoot, ".quack-verification-session.json"),
      `${JSON.stringify({
        version: 1,
        sessionId: staleSession,
        ownerPid: 2147483646,
        createdAt: Date.now() - 10_000,
      })}\n`,
    );
    _setDockerVerificationExecutableResolver(() => dockerExecutable);
    _setDockerVerificationCommandRunner((_executable, args) => {
      if (args[0] === "image")
        return Promise.resolve(success(JSON.stringify([`node@sha256:${IMAGE_DIGEST}`])));
      if (args[0] === "inspect") return Promise.resolve(success("172.30.0.2"));
      return Promise.resolve(success());
    });

    try {
      const session = await DockerVerificationSession.create({
        worktreeRoot: worktree,
        authoritativeRoot: worktree,
        config: sandboxConfig,
        deniedPaths: [],
      });
      await session.dispose();
      await expect(fs.lstat(staleRoot)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(fs.lstat(unrelatedRoot)).resolves.toBeDefined();
    } finally {
      await fs.rm(staleRoot, { recursive: true, force: true });
      await fs.rm(unrelatedRoot, { recursive: true, force: true });
    }
  });

  test("retries disposal after a transient cleanup verification failure", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    const dockerExecutable = path.join(
      fixtureRoot,
      process.platform === "win32" ? "docker.exe" : "docker",
    );
    await writeLockedPackage(worktree);
    await fs.writeFile(dockerExecutable, "trusted");
    let failVerificationContainerCheck = false;
    let verificationContainerChecks = 0;
    _setDockerVerificationExecutableResolver(() => dockerExecutable);
    _setDockerVerificationCommandRunner((_executable, args) => {
      if (args[0] === "image" && args[1] === "inspect") {
        return Promise.resolve(success(JSON.stringify([`node@sha256:${IMAGE_DIGEST}`])));
      }
      if (args[0] === "inspect") return Promise.resolve(success("172.30.0.2\n"));
      const filterIndex = args.indexOf("--filter");
      const filter = filterIndex >= 0 ? args[filterIndex + 1] : "";
      if (
        args[0] === "container" &&
        args[1] === "ls" &&
        filter.startsWith("name=^/quack-verify-") &&
        !filter.includes("-setup") &&
        !filter.includes("-proxy")
      ) {
        verificationContainerChecks += 1;
        if (failVerificationContainerCheck) {
          failVerificationContainerCheck = false;
          return Promise.resolve(success("quack-verify-still-present\n"));
        }
      }
      return Promise.resolve(success());
    });

    const session = await DockerVerificationSession.create({
      worktreeRoot: worktree,
      authoritativeRoot: worktree,
      config: sandboxConfig,
      deniedPaths: [],
    });
    failVerificationContainerCheck = true;

    await expect(session.dispose()).rejects.toThrow(/verification container still exists/i);
    const runAfterDisposeFailure = await session.run(
      { cwd: worktree, executable: "node", args: ["--version"] },
      1_000,
    );
    expect(runAfterDisposeFailure.exitCode).toBe(1);
    expect(runAfterDisposeFailure.stderr).toContain("already disposing or disposed");
    await expect(session.dispose()).resolves.toBeUndefined();
    const checksAfterSuccess = verificationContainerChecks;
    await expect(session.dispose()).resolves.toBeUndefined();
    expect(verificationContainerChecks).toBe(checksAfterSuccess);
    expect(verificationContainerChecks).toBe(2);
  });

  test("makes cleanup-failed sessions eligible for a later stale-resource sweep", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    const dockerExecutable = path.join(
      fixtureRoot,
      process.platform === "win32" ? "docker.exe" : "docker",
    );
    await writeLockedPackage(worktree);
    await fs.writeFile(dockerExecutable, "trusted");

    let firstSessionId: string | undefined;
    let firstCreatedAt: number | undefined;
    let failFirstExactCheck = false;
    let exposeFailedSession = false;
    let staleContainerPresent = false;
    _setDockerVerificationExecutableResolver(() => dockerExecutable);
    _setDockerVerificationCommandRunner((_executable, args) => {
      const sessionLabel = args.find((value) =>
        value.startsWith("com.quack.verification-session="),
      );
      const createdAtLabel = args.find((value) =>
        value.startsWith("com.quack.verification-created-at="),
      );
      if (!firstSessionId && sessionLabel && createdAtLabel) {
        firstSessionId = sessionLabel.slice(sessionLabel.indexOf("=") + 1);
        firstCreatedAt = Number(createdAtLabel.slice(createdAtLabel.indexOf("=") + 1));
      }

      if (args[0] === "image" && args[1] === "inspect") {
        return Promise.resolve(success(JSON.stringify([`node@sha256:${IMAGE_DIGEST}`])));
      }
      if (args[0] === "inspect") return Promise.resolve(success("172.30.0.2\n"));

      const filterIndex = args.indexOf("--filter");
      const filter = filterIndex >= 0 ? args[filterIndex + 1] : undefined;
      if (
        failFirstExactCheck &&
        typeof filter === "string" &&
        firstSessionId &&
        filter === `name=^/quack-verify-${firstSessionId}$`
      ) {
        failFirstExactCheck = false;
        return Promise.resolve(success("verification-container-still-present\n"));
      }
      if (
        exposeFailedSession &&
        args[0] === "container" &&
        args[1] === "ls" &&
        filter === "label=com.quack.verification-session" &&
        firstSessionId &&
        firstCreatedAt
      ) {
        return Promise.resolve(success(`${firstSessionId}|${process.pid}|${firstCreatedAt}\n`));
      }
      if (
        args[0] === "container" &&
        args[1] === "ls" &&
        firstSessionId &&
        filter === `label=com.quack.verification-session=${firstSessionId}`
      ) {
        return Promise.resolve(success(staleContainerPresent ? "stale-container\n" : ""));
      }
      if (args[0] === "rm" && args.includes("stale-container")) {
        staleContainerPresent = false;
      }
      return Promise.resolve(success());
    });

    const failedSession = await DockerVerificationSession.create({
      worktreeRoot: worktree,
      authoritativeRoot: worktree,
      config: sandboxConfig,
      deniedPaths: [],
    });
    failFirstExactCheck = true;
    await expect(failedSession.dispose()).rejects.toThrow(/verification container still exists/i);

    exposeFailedSession = true;
    staleContainerPresent = true;
    const replacementSession = await DockerVerificationSession.create({
      worktreeRoot: worktree,
      authoritativeRoot: worktree,
      config: sandboxConfig,
      deniedPaths: [],
    });

    expect(staleContainerPresent).toBe(false);
    await replacementSession.dispose();
    await failedSession.dispose();
  });

  test("uses volume copy, allowlisted setup networking, offline hardened execution, argv, and verified cleanup", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    const trustedBin = path.join(fixtureRoot, "trusted-bin");
    const dockerExecutable = path.join(
      trustedBin,
      process.platform === "win32" ? "docker.exe" : "docker",
    );
    await writeLockedPackage(worktree, true);
    await fs.mkdir(path.join(worktree, ".quack"));
    await fs.mkdir(trustedBin);
    await fs.writeFile(dockerExecutable, "trusted");
    await fs.writeFile(path.join(worktree, "source.txt"), "host-original\n");
    await fs.mkdir(path.join(worktree, "config"));
    await fs.writeFile(path.join(worktree, "config", "local.json"), "DOCKER_DENIED_SENTINEL\n");
    await fs.writeFile(path.join(worktree, ".quack", "adapter.json"), "{}\n");

    const invocations: Array<{
      executable: string;
      args: string[];
      cwd: string;
      env: NodeJS.ProcessEnv;
    }> = [];
    _setDockerVerificationExecutableResolver(() => dockerExecutable);
    _setDockerVerificationCommandRunner((executable, args, options) => {
      invocations.push({ executable, args: [...args], cwd: options.cwd, env: options.env });
      if (args[0] === "image" && args[1] === "inspect")
        return Promise.resolve(success(JSON.stringify([`node@sha256:${IMAGE_DIGEST}`])));
      if (args[0] === "inspect") return Promise.resolve(success("172.30.0.2\n"));
      if (
        (args[0] === "container" || args[0] === "volume" || args[0] === "network") &&
        args[1] === "ls"
      )
        return Promise.resolve(success(""));
      if (args.includes("printf tampered > .quack/convention-checks/policy.js")) {
        const immutableMachinery = invocations.some(
          (entry) =>
            entry.args[0] === "create" &&
            entry.args.some((arg) => arg.endsWith("target=/workspace/.quack,readonly")),
        );
        return Promise.resolve(
          immutableMachinery
            ? { exitCode: 1, stdout: "", stderr: "Read-only file system", timedOut: false }
            : success("tampered"),
        );
      }
      if (args.includes("read-policy")) return Promise.resolve(success("original policy\n"));
      if (args.includes("config/local.json"))
        return Promise.resolve({
          exitCode: 1,
          stdout: "",
          stderr: "ENOENT",
          timedOut: false,
        });
      if (args.includes("emit-output"))
        return Promise.resolve(success(`\u001b[31m${"x".repeat(2_000)}\u0000`));
      return Promise.resolve(success());
    });

    const session = await DockerVerificationSession.create({
      worktreeRoot: worktree,
      authoritativeRoot: worktree,
      config: sandboxConfig,
      deniedPaths: ["config/local.json"],
    });
    const result = await session.run(
      { cwd: worktree, executable: "node", args: ["emit-output", "arg with spaces"] },
      5_000,
    );
    const tamper = await session.run(
      { cwd: worktree, command: "printf tampered > .quack/convention-checks/policy.js" },
      5_000,
    );
    const trustedCheck = await session.run(
      { cwd: worktree, executable: "node", args: ["read-policy"] },
      5_000,
    );
    const deniedRead = await session.run(
      { cwd: worktree, executable: "cat", args: ["config/local.json"] },
      5_000,
    );
    const workspaceCopy = invocations.find(
      (entry) => entry.args[0] === "cp" && entry.args[2]?.endsWith(":/workspace"),
    );
    const stagedWorkspace = workspaceCopy?.args[1];
    expect(stagedWorkspace).toBeDefined();
    await expect(
      fs.lstat(path.join(stagedWorkspace!, "config", "local.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await session.dispose();

    expect(result.stdout).not.toContain("\u001b");
    expect(result.stdout).not.toContain("\u0000");
    expect(result.stdout).toContain("output truncated");
    expect(tamper).toMatchObject({ exitCode: 1, stderr: "Read-only file system" });
    expect(trustedCheck).toMatchObject({ exitCode: 0, stdout: "original policy\n" });
    expect(deniedRead).toMatchObject({ exitCode: 1, stdout: "", stderr: "ENOENT" });
    expect(`${deniedRead.stdout}${deniedRead.stderr}`).not.toContain("DOCKER_DENIED_SENTINEL");
    expect(await fs.readFile(path.join(worktree, "source.txt"), "utf8")).toBe("host-original\n");
    expect(invocations.some((entry) => entry.args[0] === "build")).toBe(false);
    const copy = invocations.find((entry) => entry.args[0] === "cp");
    expect(copy?.args.join(" ")).not.toContain(worktree);
    expect(
      invocations.some((entry) => entry.args[0] === "network" && entry.args.includes("--internal")),
    ).toBe(true);
    const proxyCreate = invocations.find(
      (entry) =>
        entry.args[0] === "create" &&
        entry.args.some((arg) => arg.includes("QV_ALLOWED_REGISTRIES")),
    );
    expect(proxyCreate?.args.join(" ")).toContain("104.16.24.34");
    expect(proxyCreate?.args).toEqual(
      expect.arrayContaining(["--dns", "127.0.0.1", "--pull", "never"]),
    );
    const npmSetup = invocations.find((entry) => entry.args.includes("/usr/local/bin/npm"));
    const npmConfigInitialization = invocations.find(
      (entry) =>
        entry.args.includes("/usr/bin/touch") &&
        entry.args.includes("/tmp/quack-npm-userconfig") &&
        entry.args.includes("/tmp/quack-npm-globalconfig"),
    );
    expect(npmConfigInitialization?.args.slice(-3)).toEqual([
      "/usr/bin/touch",
      "/tmp/quack-npm-userconfig",
      "/tmp/quack-npm-globalconfig",
    ]);
    expect(npmSetup?.args).toEqual(
      expect.arrayContaining([
        "--env",
        "NPM_CONFIG_USERCONFIG=/tmp/quack-npm-userconfig",
        "--env",
        "NPM_CONFIG_GLOBALCONFIG=/tmp/quack-npm-globalconfig",
        "--env",
        "NO_PROXY=",
        "ci",
        "--ignore-scripts",
        "--workspaces=false",
        "--include-workspace-root=false",
        `--registry=${REGISTRY}/`,
      ]),
    );
    expect(npmSetup?.args).not.toContain("NPM_CONFIG_USERCONFIG=/dev/null");
    expect(npmSetup?.args).not.toContain("NPM_CONFIG_GLOBALCONFIG=/dev/null");
    const verifyCreate = invocations.find(
      (entry) => entry.args[0] === "create" && entry.args.includes("none"),
    );
    expect(verifyCreate?.args).toEqual(
      expect.arrayContaining([
        "--network",
        "none",
        "--read-only",
        "--cap-drop",
        "ALL",
        "--security-opt",
        "no-new-privileges:true",
        "--pids-limit",
        "64",
        "--memory",
        "512m",
        "--cpus",
        "1",
        "--user",
        "65532:65532",
      ]),
    );
    expect(verifyCreate?.args).not.toContain("-v");
    expect(verifyCreate?.args.join(" ")).not.toContain(worktree);
    expect(verifyCreate?.args).toEqual(
      expect.arrayContaining([
        expect.stringMatching(
          /^type=volume,source=quack-verify-[a-f0-9]{32}-machinery,target=\/workspace\/\.quack,readonly$/,
        ),
      ]),
    );
    const execution = invocations.find((entry) => entry.args.includes("emit-output"));
    expect(execution?.args.slice(-3)).toEqual(["node", "emit-output", "arg with spaces"]);
    expect(execution?.executable).toBe(await fs.realpath(dockerExecutable));
    expect(execution?.cwd).toBe(trustedBin);
    expect(execution?.env.OPENAI_API_KEY).toBeUndefined();
    expect(execution?.env.QUACK_SERVICE_TOKEN).toBeUndefined();
    expect(invocations.some((entry) => entry.args[0] === "network" && entry.args[1] === "ls")).toBe(
      true,
    );
    expect(invocations.some((entry) => entry.args[0] === "volume" && entry.args[1] === "ls")).toBe(
      true,
    );
    expect(invocations.some((entry) => entry.args[0] === "image" && entry.args[1] === "rm")).toBe(
      false,
    );
  });

  test("rebuilds only an exactly attested native package after setup egress is removed", async () => {
    const worktree = path.join(fixtureRoot, "native-worktree");
    const dockerExecutable = path.join(
      fixtureRoot,
      process.platform === "win32" ? "docker.exe" : "docker",
    );
    await writeNativeLockedPackage(worktree);
    await fs.writeFile(dockerExecutable, "trusted");
    const invocations: string[][] = [];
    _setDockerVerificationExecutableResolver(() => dockerExecutable);
    _setDockerVerificationCommandRunner((_executable, args) => {
      invocations.push([...args]);
      if (args[0] === "image" && args[1] === "inspect") {
        return Promise.resolve(success(JSON.stringify([`node@sha256:${FULL_IMAGE_DIGEST}`])));
      }
      if (args[0] === "inspect") return Promise.resolve(success("172.30.0.2\n"));
      return Promise.resolve(success());
    });

    const session = await DockerVerificationSession.create({
      worktreeRoot: worktree,
      authoritativeRoot: worktree,
      config: {
        ...sandboxConfig,
        image: FULL_NODE_IMAGE,
        offlineNativeRebuilds: [BETTER_SQLITE_REBUILD],
      },
      deniedPaths: [],
    });
    await session.dispose();

    const npmInstallIndex = invocations.findIndex(
      (args) => args.includes("/usr/local/bin/npm") && args.includes("ci"),
    );
    const proxyRemovalIndex = invocations.findIndex(
      (args) => args[0] === "rm" && args[1] === "-f" && args[2]?.endsWith("-proxy"),
    );
    const setupDisconnectIndex = invocations.findIndex(
      (args) => args[0] === "network" && args[1] === "disconnect",
    );
    const networkInspectionIndex = invocations.findIndex(
      (args) => args[0] === "container" && args[1] === "inspect",
    );
    const attestationIndex = invocations.findIndex(
      (args) =>
        args.includes("/usr/local/bin/node") &&
        args.some((arg) => arg.includes("native rebuild package identity")),
    );
    const rebuildIndex = invocations.findIndex(
      (args) => args.includes("/usr/local/bin/npm") && args.includes("rebuild"),
    );
    const setupRemovalIndex = invocations.findIndex(
      (args) => args[0] === "rm" && args[1] === "-f" && args[2]?.endsWith("-setup"),
    );
    for (const index of [
      npmInstallIndex,
      proxyRemovalIndex,
      setupDisconnectIndex,
      networkInspectionIndex,
      attestationIndex,
      rebuildIndex,
      setupRemovalIndex,
    ]) {
      expect(index).toBeGreaterThanOrEqual(0);
    }
    expect(npmInstallIndex).toBeLessThan(proxyRemovalIndex);
    expect(proxyRemovalIndex).toBeLessThan(setupDisconnectIndex);
    expect(setupDisconnectIndex).toBeLessThan(networkInspectionIndex);
    expect(networkInspectionIndex).toBeLessThan(attestationIndex);
    expect(attestationIndex).toBeLessThan(rebuildIndex);
    expect(rebuildIndex).toBeLessThan(setupRemovalIndex);
    const rebuild = invocations[rebuildIndex];
    expect(rebuild).toEqual(
      expect.arrayContaining([
        "--env",
        "NPM_CONFIG_IGNORE_SCRIPTS=false",
        "--env",
        "NPM_CONFIG_OFFLINE=true",
        "--env",
        "NPM_CONFIG_BUILD_FROM_SOURCE=true",
        "--env",
        "NPM_CONFIG_NODEDIR=/usr/local",
        "/usr/local/bin/npm",
        "rebuild",
        "better-sqlite3",
        "--foreground-scripts",
        "--offline",
        "--build-from-source",
      ]),
    );
    expect(rebuild.filter((arg) => arg === "better-sqlite3")).toHaveLength(1);
    expect(rebuild.join(" ")).not.toContain("http://172.30.0.2");
  });

  dockerIntegrationTest(
    "installs a real locked dependency with isolated npm config files",
    async () => {
      const worktree = path.join(fixtureRoot, "real-docker-worktree");
      await fs.mkdir(worktree, { recursive: true });
      await fs.writeFile(
        path.join(worktree, "package.json"),
        JSON.stringify({
          name: "quack-docker-npm-config-regression",
          version: "1.0.0",
          dependencies: { "@babel/compat-data": "7.29.7" },
        }),
      );
      await fs.writeFile(
        path.join(worktree, "package-lock.json"),
        JSON.stringify({
          name: "quack-docker-npm-config-regression",
          version: "1.0.0",
          lockfileVersion: 3,
          requires: true,
          packages: {
            "": {
              name: "quack-docker-npm-config-regression",
              version: "1.0.0",
              dependencies: { "@babel/compat-data": "7.29.7" },
            },
            "node_modules/@babel/compat-data": {
              version: "7.29.7",
              resolved: "https://registry.npmjs.org/@babel/compat-data/-/compat-data-7.29.7.tgz",
              integrity:
                "sha512-locTkQyKvwIEgBzVrn8693ebc97F2U8ZHjbXwDXJ5Fn2TCpNwTlKcaKLkdHop5c/icOFE7qt7Q9JC5hnKNa6Gg==",
              engines: { node: ">=6.9.0" },
            },
          },
        }),
      );
      _setDockerVerificationCommandRunner(undefined);
      _setDockerVerificationExecutableResolver(undefined);
      _setDockerVerificationDnsResolver(undefined);
      _setDockerVerificationDelay(undefined);

      let session: DockerVerificationSession | undefined;
      try {
        session = await DockerVerificationSession.create({
          worktreeRoot: worktree,
          authoritativeRoot: worktree,
          config: sandboxConfig,
          deniedPaths: [],
        });
        const result = await session.run(
          {
            cwd: worktree,
            executable: "node",
            args: [
              "-e",
              "const fs=require('node:fs');process.stdout.write(String(fs.existsSync('node_modules/@babel/compat-data/package.json')))",
            ],
          },
          30_000,
        );
        expect(result).toMatchObject({ exitCode: 0, stdout: "true", timedOut: false });
      } finally {
        await session?.dispose();
      }
    },
    180_000,
  );

  dockerIntegrationTest(
    "compiles and loads the pinned better-sqlite3 addon with setup networking removed",
    async () => {
      const worktree = path.join(fixtureRoot, "real-native-worktree");
      await fs.mkdir(worktree, { recursive: true });
      await fs.copyFile(path.join(repoRoot, "package.json"), path.join(worktree, "package.json"));
      await fs.copyFile(
        path.join(repoRoot, "package-lock.json"),
        path.join(worktree, "package-lock.json"),
      );
      _setDockerVerificationCommandRunner(undefined);
      _setDockerVerificationExecutableResolver(undefined);
      _setDockerVerificationDnsResolver(undefined);
      _setDockerVerificationDelay(undefined);

      let session: DockerVerificationSession | undefined;
      try {
        session = await DockerVerificationSession.create({
          worktreeRoot: worktree,
          authoritativeRoot: worktree,
          config: {
            ...sandboxConfig,
            image: FULL_NODE_IMAGE,
            pidsLimit: 256,
            memoryMb: 4096,
            cpus: 2,
            tmpfsSizeMb: 512,
            setupTimeoutMs: 600_000,
            maxContextBytes: 64 * 1024 * 1024,
            maxOutputBytes: 1024 * 1024,
            offlineNativeRebuilds: [BETTER_SQLITE_REBUILD],
          },
          deniedPaths: [],
        });
        const result = await session.run(
          {
            cwd: worktree,
            executable: "node",
            args: [
              "-e",
              "const Database=require('better-sqlite3');const db=new Database(':memory:');process.stdout.write(String(db.prepare('select 42 as answer').get().answer));db.close();",
            ],
          },
          30_000,
        );
        expect(result).toMatchObject({ exitCode: 0, stdout: "42", timedOut: false });
      } finally {
        await session?.dispose();
      }
    },
    900_000,
  );

  test("installs every configured nested package root", async () => {
    const worktree = path.join(fixtureRoot, "worktree");
    const dockerExecutable = path.join(
      fixtureRoot,
      process.platform === "win32" ? "docker.exe" : "docker",
    );
    await writeLockedPackage(worktree);
    await writeLockedPackage(path.join(worktree, "frontend"));
    await fs.writeFile(dockerExecutable, "trusted");
    const invocations: string[][] = [];
    _setDockerVerificationExecutableResolver(() => dockerExecutable);
    _setDockerVerificationCommandRunner((_executable, args) => {
      invocations.push([...args]);
      if (args[0] === "image")
        return Promise.resolve(success(JSON.stringify([`node@sha256:${IMAGE_DIGEST}`])));
      if (args[0] === "inspect") return Promise.resolve(success("172.30.0.2"));
      return Promise.resolve(success());
    });
    const session = await DockerVerificationSession.create({
      worktreeRoot: worktree,
      authoritativeRoot: worktree,
      config: { ...sandboxConfig, dependencyRoots: [".", "frontend"] },
      deniedPaths: [],
    });
    await session.dispose();
    const npmRuns = invocations.filter((args) => args.includes("/usr/local/bin/npm"));
    expect(npmRuns).toHaveLength(2);
    expect(npmRuns.map((args) => args[args.indexOf("--workdir") + 1])).toEqual([
      "/workspace",
      "/workspace/frontend",
    ]);
  });

  test("runVerification uses authoritative docker mode and removes a timed-out container", async () => {
    const projectRoot = path.join(fixtureRoot, "project");
    const worktree = path.join(projectRoot, ".quack", "worktrees", "TASK-DOCKER");
    const dockerExecutable = path.join(
      fixtureRoot,
      process.platform === "win32" ? "docker.exe" : "docker",
    );
    await fs.mkdir(path.join(projectRoot, ".quack"), { recursive: true });
    await fs.mkdir(path.join(worktree, ".quack"), { recursive: true });
    await fs.mkdir(path.join(worktree, "config"));
    await writeLockedPackage(worktree);
    await fs.writeFile(path.join(worktree, "config", "local.json"), "DENIED_CONFIG_SENTINEL\n");
    await fs.writeFile(dockerExecutable, "trusted");
    const authoritativeConfig: AdapterConfig = {
      version: "1.0",
      project: { name: "docker-test", root: ".", taskDir: "docs/tasks", conventionsDir: ".quack" },
      agent: {
        model: "claude-opus-4-6",
        judgeModel: "claude-sonnet-4-6",
        enrichModel: "claude-sonnet-4-6",
        maxTurns: 10,
        maxBudgetPerTask: 1,
        maxRetries: 0,
      },
      verification: {
        hostExecution: "docker-sandbox",
        dockerSandbox: sandboxConfig,
        commands: [
          { name: "build", cmd: "node", args: ["--version"], required: true, timeout: 5_000 },
        ],
        conventionChecks: [
          {
            name: "policy",
            description: "policy",
            command: "node .quack/convention-checks/policy.js",
            conventionRef: "POLICY",
          },
        ],
      },
      sandbox: {
        writablePaths: ["src/"],
        deniedPaths: [".git/", ".quack/adapter.json", "config/local.json"],
        allowedBashPatterns: [],
        deniedBashPatterns: [],
      },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "Implemented-by: Quack",
        autoCreatePr: false,
        autoPush: false,
      },
      logging: { dir: ".quack/logs", level: "debug", retainDays: 7 },
    };
    const localConfig: AdapterConfig = {
      ...authoritativeConfig,
      verification: { ...authoritativeConfig.verification, hostExecution: "direct" },
      sandbox: { ...authoritativeConfig.sandbox, deniedPaths: [] },
    };
    await fs.writeFile(
      path.join(projectRoot, ".quack", "adapter.json"),
      JSON.stringify(authoritativeConfig),
    );
    await fs.writeFile(path.join(worktree, ".quack", "adapter.json"), JSON.stringify(localConfig));
    const adapter: ProjectAdapter = {
      config: localConfig,
      projectRoot: worktree,
      conventionsDoc: "",
      judgeCriteria: "",
      conventionCheckScripts: [],
      adrDocs: {},
      adapterBundle: computeAdapterBundleMetadata(localConfig),
    };
    const invocations: string[][] = [];
    let commandTimedOut = false;
    let exactLabelVolumeChecks = 0;
    let lateVolumePresent = false;
    let deniedFileWasStaged: boolean | undefined;
    _setDockerVerificationExecutableResolver(() => dockerExecutable);
    _setDockerVerificationCommandRunner((_executable, args) => {
      invocations.push([...args]);
      if (args[0] === "image")
        return Promise.resolve(success(JSON.stringify([`node@sha256:${IMAGE_DIGEST}`])));
      if (args[0] === "inspect") return Promise.resolve(success("172.30.0.2"));
      if (args[0] === "cp" && args[2]?.endsWith(":/workspace")) {
        const stagedWorkspace = args[1].replace(/[\\/]\.$/, "");
        deniedFileWasStaged = existsSync(path.join(stagedWorkspace, "config", "local.json"));
      }
      if (args.includes("--version")) {
        commandTimedOut = true;
        return Promise.resolve({ exitCode: 1, stdout: "", stderr: "timed out", timedOut: true });
      }
      const filterIndex = args.indexOf("--filter");
      const filter = filterIndex >= 0 ? args[filterIndex + 1] : undefined;
      if (
        commandTimedOut &&
        args[0] === "volume" &&
        args[1] === "ls" &&
        filter?.startsWith("label=com.quack.verification-session=")
      ) {
        exactLabelVolumeChecks += 1;
        if (exactLabelVolumeChecks === 2) lateVolumePresent = true;
        return Promise.resolve(success(lateVolumePresent ? "late-volume\n" : ""));
      }
      if (args[0] === "volume" && args[1] === "rm" && args.includes("late-volume")) {
        lateVolumePresent = false;
      }
      return Promise.resolve(success());
    });

    const result = await runVerification(adapter, "all");
    expect(result.allPassed).toBe(false);
    expect(deniedFileWasStaged).toBe(false);
    expect(result.commands[0]).toMatchObject({ name: "build", passed: false });
    expect(invocations.find((args) => args.includes("--version"))?.slice(-2)).toEqual([
      "node",
      "--version",
    ]);
    expect(
      invocations
        .find((args) => args.includes("node .quack/convention-checks/policy.js"))
        ?.slice(-3),
    ).toEqual(["/bin/sh", "-lc", "node .quack/convention-checks/policy.js"]);
    expect(invocations.some((args) => args[0] === "rm" && args[1] === "-f")).toBe(true);
    expect(invocations.some((args) => args[0] === "container" && args[1] === "ls")).toBe(true);
    expect(invocations.some((args) => args[0] === "volume" && args.includes("late-volume"))).toBe(
      true,
    );
    expect(lateVolumePresent).toBe(false);
  });
});
