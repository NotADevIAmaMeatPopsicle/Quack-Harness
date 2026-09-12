import { readFileSync } from "node:fs";
import * as path from "node:path";

import {
  AdapterGitConfigSchema,
  AdapterConfigSchema,
  AdapterSandboxConfigSchema,
  AdapterVerificationConfigSchema,
  AdapterWorkerOverlayConfigSchema,
  BlueprintAutoApproveRulesSchema,
  JudgeAutoApproveRulesSchema,
  LoopConfigSchema,
  RuntimeCheckConfigSchema,
  WorktreeInitStepSchema,
} from "../../src/core/adapter-schema";
import { JudgmentConfigSchema } from "../../src/judgment/runner/intent-judgment-config";

describe("AdapterWorkerOverlayConfigSchema trust boundary", () => {
  test("does not accept repository-authored local Git transport grants", () => {
    const parsed = AdapterWorkerOverlayConfigSchema.parse({
      trustedLocalReadRemotePaths: ["C:/sensitive/repository.git"],
    }) as Record<string, unknown>;

    expect(parsed.trustedLocalReadRemotePaths).toBeUndefined();
  });
});

describe("AdapterVerificationConfigSchema host execution", () => {
  const verification = {
    commands: [{ name: "test", command: "npm test", required: true, timeout: 120_000 }],
  };

  test("defaults host execution to direct", () => {
    expect(AdapterVerificationConfigSchema.parse(verification).hostExecution).toBe("direct");
  });

  test("accepts the contained boundaries and rejects unknown values", () => {
    expect(
      AdapterVerificationConfigSchema.parse({
        ...verification,
        hostExecution: "codex-sandbox",
      }).hostExecution,
    ).toBe("codex-sandbox");
    const docker = AdapterVerificationConfigSchema.parse({
      ...verification,
      hostExecution: "docker-sandbox",
      dockerSandbox: {
        image:
          "node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5",
      },
    });
    expect(docker.hostExecution).toBe("docker-sandbox");
    expect(docker.dockerSandbox).toMatchObject({
      pidsLimit: 256,
      memoryMb: 2048,
      cpus: 2,
      tmpfsSizeMb: 256,
      dependencyRoots: ["."],
      allowedRegistryOrigins: ["https://registry.npmjs.org"],
      offlineNativeRebuilds: [],
      setupTimeoutMs: 600_000,
    });
    expect(
      AdapterVerificationConfigSchema.safeParse({
        ...verification,
        hostExecution: "uncontained",
      }).success,
    ).toBe(false);
  });

  test("requires bounded dependency roots and HTTPS registry origins", () => {
    const base = {
      ...verification,
      hostExecution: "docker-sandbox" as const,
      dockerSandbox: {
        image:
          "node:22-bookworm-slim@sha256:83f487e0a63425e5b4d146fb5e5be574bcbe1b7b843d3ebafdd95eaf7767a7e5",
      },
    };
    expect(
      AdapterVerificationConfigSchema.safeParse({
        ...base,
        dockerSandbox: { ...base.dockerSandbox, dependencyRoots: [] },
      }).success,
    ).toBe(false);
    expect(
      AdapterVerificationConfigSchema.safeParse({
        ...base,
        dockerSandbox: {
          ...base.dockerSandbox,
          allowedRegistryOrigins: ["http://registry.npmjs.org"],
        },
      }).success,
    ).toBe(false);
  });

  test("requires an immutable official Node digest for docker-sandbox", () => {
    expect(
      AdapterVerificationConfigSchema.safeParse({
        ...verification,
        hostExecution: "docker-sandbox",
      }).success,
    ).toBe(false);
    expect(
      AdapterVerificationConfigSchema.safeParse({
        ...verification,
        hostExecution: "docker-sandbox",
        dockerSandbox: { image: "node:22-bookworm-slim" },
      }).success,
    ).toBe(false);
    expect(
      AdapterVerificationConfigSchema.safeParse({
        ...verification,
        hostExecution: "docker-sandbox",
        dockerSandbox: {
          image: `attacker.example/node@sha256:${"a".repeat(64)}`,
        },
      }).success,
    ).toBe(false);
  });

  test("accepts only exact, unique offline native rebuild attestations", () => {
    const base = {
      ...verification,
      hostExecution: "docker-sandbox" as const,
      dockerSandbox: {
        image:
          "node:22-bookworm@sha256:8a34c4ab3ea2c5cd194f07e317b2a8f09461d3c8b05c4e34c8ccd56d56024c4d",
        dependencyRoots: ["."],
      },
    };
    const rebuild = {
      dependencyRoot: ".",
      packageName: "better-sqlite3",
      version: "12.8.0",
      integrity:
        "sha512-RxD2Vd96sQDjQr20kdP+F+dK/1OUNiVOl200vKBZY8u0vTwysfolF6Hq+3ZK2+h8My9YvZhHsF+RSGZW2VYrPQ==",
      installScript: "prebuild-install || node-gyp rebuild --release",
    };
    expect(
      AdapterVerificationConfigSchema.safeParse({
        ...base,
        dockerSandbox: { ...base.dockerSandbox, offlineNativeRebuilds: [rebuild] },
      }).success,
    ).toBe(true);
    for (const invalid of [
      { ...rebuild, packageName: "--foreground-scripts" },
      { ...rebuild, version: "^12.8.0" },
      { ...rebuild, integrity: "sha256-QUJDRA==" },
      { ...rebuild, integrity: "sha512-QUJDRA==" },
      { ...rebuild, dependencyRoot: "../outside" },
      { ...rebuild, installScript: "node-gyp rebuild\nmalicious" },
    ]) {
      expect(
        AdapterVerificationConfigSchema.safeParse({
          ...base,
          dockerSandbox: { ...base.dockerSandbox, offlineNativeRebuilds: [invalid] },
        }).success,
      ).toBe(false);
    }
    expect(
      AdapterVerificationConfigSchema.safeParse({
        ...base,
        dockerSandbox: { ...base.dockerSandbox, offlineNativeRebuilds: [rebuild, rebuild] },
      }).success,
    ).toBe(false);
  });

  test("accepts structured verification argv and rejects ambiguous command forms", () => {
    expect(
      AdapterVerificationConfigSchema.safeParse({
        commands: [
          {
            name: "test",
            cmd: "npm",
            args: ["test", "--", "path with spaces"],
            required: true,
            timeout: 120_000,
          },
        ],
      }).success,
    ).toBe(true);
    expect(
      AdapterVerificationConfigSchema.safeParse({
        commands: [
          {
            name: "ambiguous",
            command: "npm test",
            cmd: "npm",
            args: ["test"],
            required: true,
            timeout: 120_000,
          },
        ],
      }).success,
    ).toBe(false);
  });
});

describe("Quack self-host adapter hardening contract", () => {
  test("keeps dependency mirrors disposable and verification sandboxed", () => {
    const adapter = AdapterConfigSchema.parse(
      JSON.parse(
        readFileSync(path.resolve(__dirname, "../../.quack/adapter.json"), "utf8"),
      ) as unknown,
    );

    expect(adapter.sandbox.disposablePaths).toEqual(["node_modules/", "frontend/node_modules/"]);
    expect(adapter.sandbox.writablePaths).toEqual(
      expect.arrayContaining([
        "package.json",
        "package-lock.json",
        "frontend/src/",
        "frontend/package.json",
        "frontend/package-lock.json",
        "frontend/playwright.config.ts",
      ]),
    );
    expect(adapter.sandbox.deniedPaths).toEqual(
      expect.arrayContaining([
        ".quack/adapter.json",
        ".quack/verify.js",
        ".quack/judge-criteria.md",
        "node_modules/",
        "frontend/node_modules/",
      ]),
    );
    expect(adapter.verification.hostExecution).toBe("codex-sandbox");
    expect(adapter.dispatch?.worktreeInit).toEqual([
      {
        command: "npm ci --ignore-scripts --no-audit --no-fund",
        cwd: ".",
        label: "npm ci (root)",
      },
      {
        command: "npm ci --ignore-scripts --no-audit --no-fund",
        cwd: "frontend",
        label: "npm ci (frontend)",
      },
    ]);
  });
});

describe("WorktreeInitStepSchema environment isolation", () => {
  test("accepts ordinary flags and rejects runtime/package-manager injection variables", () => {
    expect(
      WorktreeInitStepSchema.safeParse({
        command: "npm ci",
        env: { DEMO_BUILD: "true" },
      }).success,
    ).toBe(true);
    for (const name of ["NODE_OPTIONS", "node_path", "NPM_CONFIG_CACHE", "Path", "HOME"]) {
      expect(
        WorktreeInitStepSchema.safeParse({
          command: "npm ci",
          env: { [name]: "attacker-controlled" },
        }).success,
      ).toBe(false);
    }
  });
});

describe("RuntimeCheckConfigSchema host-authority acknowledgement", () => {
  const runtimeCheck = {
    startCommand: "npm run dev",
    healthUrl: "http://127.0.0.1:3000/health",
    routes: ["/"],
    baseUrl: "http://127.0.0.1:3000",
  };

  test("requires the explicit direct-trusted execution mode", () => {
    expect(RuntimeCheckConfigSchema.safeParse(runtimeCheck).success).toBe(false);
    expect(
      RuntimeCheckConfigSchema.safeParse({ ...runtimeCheck, execution: "direct-trusted" }).success,
    ).toBe(true);
    expect(
      RuntimeCheckConfigSchema.safeParse({ ...runtimeCheck, execution: "direct" }).success,
    ).toBe(false);
  });
});

describe("AdapterGitConfigSchema branchGroups", () => {
  test("accepts valid branchGroups config", () => {
    const parsed = AdapterGitConfigSchema.parse({
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: true,
      autoPush: true,
      branchGroups: {
        "web-app": {
          baseBranch: "feature/web-dashboard-ui",
          autoMergeTarget: "feature/web-dashboard-ui",
          description: "Web app dashboard work",
          taskPattern: "^TASK-(55[9-9]|56\\d|57[0-5])$",
        },
      },
    });

    expect(parsed.branchGroups?.["web-app"]?.baseBranch).toBe("feature/web-dashboard-ui");
    expect(parsed.branchGroups?.["web-app"]?.taskPattern).toBe("^TASK-(55[9-9]|56\\d|57[0-5])$");
  });

  test("rejects branch group missing baseBranch", () => {
    const invalid = {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: true,
      autoPush: true,
      branchGroups: {
        broken: {
          taskPattern: "^TASK-5\\d\\d$",
        },
      },
    };

    const result = AdapterGitConfigSchema.safeParse(invalid);
    expect(result.success).toBe(false);
  });

  test("keeps compatibility when branchGroups is absent", () => {
    const parsed = AdapterGitConfigSchema.parse({
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "Implemented-by: Quack Agent",
      autoCreatePr: true,
      autoPush: true,
    });

    expect(parsed.branchGroups).toBeUndefined();
    expect(parsed.baseBranch).toBe("main");
  });
});

describe("AdapterSandboxConfigSchema disposable paths", () => {
  test("keeps dependency mirroring opt-in and preserves explicit roots", () => {
    expect(AdapterSandboxConfigSchema.parse({}).disposablePaths).toBeUndefined();
    expect(
      AdapterSandboxConfigSchema.parse({ disposablePaths: ["node_modules/", "dist/"] })
        .disposablePaths,
    ).toEqual(["node_modules/", "dist/"]);
  });
});

describe("LoopConfigSchema", () => {
  test("root adapter defaults executionMode to dispatch", () => {
    const parsed = AdapterConfigSchema.parse({
      version: "1",
      project: {
        name: "test",
        root: ".",
        taskDir: "docs/tasks",
        conventionsDir: ".quack",
      },
      verification: {
        commands: [
          {
            name: "test",
            command: "npm test",
            required: true,
            timeout: 120_000,
          },
        ],
      },
      git: {
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "Implemented-by: Quack Agent",
      },
      logging: { dir: ".quack/logs" },
    });

    expect(parsed.executionMode).toBe("dispatch");
    expect(parsed.loop).toBeUndefined();
  });

  test("mounts strict reviewer configs and shared approval-rule schemas", () => {
    const parsed = LoopConfigSchema.parse({
      briefReview: {
        reviewer: { runner: "codex-cli", codex: { sandbox: "read-only" } },
        autoApproveWhen: { maxFiles: 2 },
      },
      diffReview: {
        reviewer: { runner: "claude-sdk" },
        autoApproveWhen: { maxDiffLines: 100 },
      },
    });

    expect(parsed.briefReview.autoApproveWhen).toEqual(
      BlueprintAutoApproveRulesSchema.parse({ maxFiles: 2 }),
    );
    expect(parsed.diffReview.autoApproveWhen).toEqual(
      JudgeAutoApproveRulesSchema.parse({ maxDiffLines: 100 }),
    );
    expect(parsed.recordOnFinalize).toBe(true);
  });

  test("rejects unknown nested reviewer keys", () => {
    const result = LoopConfigSchema.safeParse({
      briefReview: { reviewer: { unexpected: true } },
      diffReview: { reviewer: {} },
    });
    expect(result.success).toBe(false);
  });

  test("rejects every codex sandbox weaker than read-only", () => {
    const result = LoopConfigSchema.safeParse({
      briefReview: {
        reviewer: { runner: "codex-cli", codex: { sandbox: "danger-full-access" } },
      },
      diffReview: { reviewer: {} },
    });
    expect(result.success).toBe(false);
  });
});

describe("JudgmentConfigSchema", () => {
  test("defaults only the implemented docs-review stage to off", () => {
    expect(JudgmentConfigSchema.parse({})).toEqual({
      runner: {
        provider: "claude-sdk",
        model: "claude-sonnet-4-6",
        maxTurns: 5,
        timeoutMs: 120_000,
      },
      stages: {
        docsReview: { mode: "off" },
        readiness: { mode: "off" },
        loopBrief: { mode: "off" },
        loopDiff: { mode: "off" },
        judge: { mode: "off" },
      },
    });
  });

  test("accepts explicit shadow/enforce without changing executionMode", () => {
    for (const mode of ["shadow", "enforce"] as const) {
      const parsed = JudgmentConfigSchema.parse({
        runner: { model: "claude-opus-4-6" },
        stages: { docsReview: { mode } },
      });
      expect(parsed.stages.docsReview.mode).toBe(mode);
      expect(parsed.runner.model).toBe("claude-opus-4-6");
    }
  });

  test("accepts a strict, read-only Codex intent runner", () => {
    const parsed = JudgmentConfigSchema.parse({
      runner: {
        provider: "codex-cli",
        model: "gpt-5.6-terra",
        timeoutMs: 180_000,
        codex: {
          binaryPath: "codex",
          sandbox: "read-only",
          codexHome: "C:/Users/demo/.codex-headless",
          profile: "headless",
          provider: "azure",
        },
      },
    });
    expect(parsed.runner.provider).toBe("codex-cli");
    if (parsed.runner.provider !== "codex-cli") throw new Error("expected Codex config");
    expect(parsed.runner.codex.sandbox).toBe("read-only");
    expect(parsed.runner.codex.provider).toBe("azure");
  });

  test("rejects unsafe or incomplete Codex intent-runner config", () => {
    expect(() =>
      JudgmentConfigSchema.parse({
        runner: { provider: "codex-cli" },
      }),
    ).toThrow();
    expect(() =>
      JudgmentConfigSchema.parse({
        runner: {
          provider: "codex-cli",
          model: "gpt-5.6-terra",
          codex: { sandbox: "workspace-write" },
        },
      }),
    ).toThrow();
    expect(() =>
      JudgmentConfigSchema.parse({
        runner: {
          provider: "codex-cli",
          model: "gpt-5.6-terra",
          extraArgs: ["--dangerously-bypass-approvals-and-sandbox"],
        },
      }),
    ).toThrow();
  });

  test("rejects unknown providers, stages, and nested keys", () => {
    expect(() =>
      JudgmentConfigSchema.parse({
        runner: { provider: "unknown-cli" },
      }),
    ).toThrow();
    expect(() =>
      JudgmentConfigSchema.parse({
        stages: { bogusStage: { mode: "enforce" } },
      }),
    ).toThrow();
    expect(
      JudgmentConfigSchema.parse({
        stages: { readiness: { mode: "enforce" } },
      }).stages.readiness.mode,
    ).toBe("enforce");
    // TASK-1316: the three new cutover stages accept modes explicitly.
    for (const stage of ["loopBrief", "loopDiff", "judge"] as const) {
      expect(
        JudgmentConfigSchema.parse({ stages: { [stage]: { mode: "shadow" } } }).stages[stage].mode,
      ).toBe("shadow");
    }
    expect(() =>
      JudgmentConfigSchema.parse({
        stages: { docsReview: { mode: "off", extra: true } },
      }),
    ).toThrow();
  });
});
