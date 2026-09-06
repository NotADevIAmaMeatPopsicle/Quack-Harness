import * as path from "node:path";
import {
  applyAdapterWorkerOverlay,
  computeAdapterBundleMetadata,
  loadAdapter,
} from "../../src/core/adapter-loader";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig, LegacyVerificationCommand } from "../../src/core/types";

const FIXTURES_DIR = path.resolve(__dirname, "..", "fixtures", "adapters");

describe("loadAdapter", () => {
  describe("minimal adapter", () => {
    let adapter: ProjectAdapter;

    beforeAll(async () => {
      adapter = await loadAdapter(path.join(FIXTURES_DIR, "minimal"));
    });

    it("should load and validate the config", () => {
      expect(adapter.config.version).toBe("1.0");
      expect(adapter.config.project.name).toBe("minimal-project");
      expect(adapter.config.project.root).toBe(".");
      expect(adapter.config.project.taskDir).toBe("docs/tasks");
      expect(adapter.config.project.conventionsDir).toBe("docs/conventions");
    });

    it("should apply agent defaults when agent section is omitted", () => {
      expect(adapter.config.agent.model).toBe("claude-opus-4-6");
      expect(adapter.config.agent.judgeModel).toBe("claude-sonnet-4-6");
      expect(adapter.config.agent.enrichModel).toBe("claude-sonnet-4-6");
      expect(adapter.config.agent.maxTurns).toBe(50);
      expect(adapter.config.agent.maxBudgetPerTask).toBe(5.0);
      expect(adapter.config.agent.maxRetries).toBe(1);
    });

    it("should apply sandbox defaults when sandbox section is omitted", () => {
      expect(adapter.config.sandbox.writablePaths).toEqual(["src/", "tests/"]);
      // TASK-1313 decision 2 (ratified): the Tier-S machinery paths joined
      // the deniedPaths defaults. This assertion was left behind by that
      // change; restored here rather than left red on main.
      expect(adapter.config.sandbox.deniedPaths).toEqual([
        ".env",
        ".env.*",
        ".quack/adapter.json",
        ".quack/verify.js",
        ".quack/judge-criteria.md",
        ".quack/conventions.md",
        ".quack/convention-checks/",
        ".quack/templates/",
      ]);
      expect(adapter.config.sandbox.allowedBashPatterns).toEqual([]);
      expect(adapter.config.sandbox.deniedBashPatterns).toEqual([]);
    });

    it("should apply git defaults", () => {
      expect(adapter.config.git.baseBranch).toBe("main");
      expect(adapter.config.git.branchPrefix).toBe("quack/");
      expect(adapter.config.git.autoCreatePr).toBe(true);
      expect(adapter.config.git.autoPush).toBe(true);
    });

    it("should apply logging defaults", () => {
      expect(adapter.config.logging.level).toBe("debug");
      expect(adapter.config.logging.retainDays).toBe(30);
    });

    it("should load conventions.md", () => {
      expect(adapter.conventionsDoc).toContain("Project Conventions");
      expect(adapter.conventionsDoc).toContain("async/await");
    });

    it("should return empty string when judge-criteria.md is missing", () => {
      expect(adapter.judgeCriteria).toBe("");
    });

    it("should return empty array when convention-checks/ is missing", () => {
      expect(adapter.conventionCheckScripts).toEqual([]);
    });

    it("should resolve projectRoot to an absolute path", () => {
      expect(path.isAbsolute(adapter.projectRoot)).toBe(true);
    });

    it("should set verification commands", () => {
      expect(adapter.config.verification.commands).toHaveLength(1);
      // Fixture uses the legacy `command` shape; narrow the union so the
      // .command property is in scope (StructuredVerificationCommand uses
      // cmd + args instead).
      const cmd0 = adapter.config.verification.commands[0] as LegacyVerificationCommand;
      expect(cmd0.name).toBe("tests");
      expect(cmd0.command).toBe("npm test");
      expect(cmd0.required).toBe(true);
    });

    it("should default conventionChecks to empty array", () => {
      expect(adapter.config.verification.conventionChecks).toEqual([]);
    });
  });

  describe("full adapter", () => {
    let adapter: ProjectAdapter;

    beforeAll(async () => {
      adapter = await loadAdapter(path.join(FIXTURES_DIR, "full"));
    });

    it("should load all config fields", () => {
      expect(adapter.config.version).toBe("1.0");
      expect(adapter.config.project.name).toBe("full-project");
      expect(adapter.config.$schema).toBe("https://quack.dev/adapter-schema.json");
    });

    it("should use explicitly provided agent values (not defaults)", () => {
      expect(adapter.config.agent.maxTurns).toBe(75);
      expect(adapter.config.agent.maxBudgetPerTask).toBe(8.0);
      expect(adapter.config.agent.maxRetries).toBe(2);
    });

    it("should use explicitly provided sandbox values (not defaults)", () => {
      expect(adapter.config.sandbox.writablePaths).toEqual(["src/", "tests/", "docs/"]);
      expect(adapter.config.sandbox.deniedPaths).toContain("infrastructure/");
      expect(adapter.config.sandbox.allowedBashPatterns).toContain("npm test *");
      expect(adapter.config.sandbox.deniedBashPatterns).toContain("rm *");
    });

    it("should use explicitly provided git values", () => {
      expect(adapter.config.git.baseBranch).toBe("develop");
      expect(adapter.config.git.autoCreatePr).toBe(false);
      expect(adapter.config.git.autoPush).toBe(false);
    });

    it("should use explicitly provided logging values", () => {
      expect(adapter.config.logging.level).toBe("info");
      expect(adapter.config.logging.retainDays).toBe(14);
    });

    it("should load all verification commands", () => {
      expect(adapter.config.verification.commands).toHaveLength(3);
      const names = adapter.config.verification.commands.map((c) => c.name);
      expect(names).toEqual(["tests", "typecheck", "lint"]);
    });

    it("should load convention checks", () => {
      expect(adapter.config.verification.conventionChecks).toHaveLength(1);
      expect(adapter.config.verification.conventionChecks[0].name).toBe("layer-violations");
      expect(adapter.config.verification.conventionChecks[0].conventionRef).toBe("ADR-012");
    });

    it("should load conventions.md", () => {
      expect(adapter.conventionsDoc).toContain("Architecture Rules");
      expect(adapter.conventionsDoc).toContain("ADR-012");
    });

    it("should load judge-criteria.md", () => {
      expect(adapter.judgeCriteria).toContain("Project-Specific Evaluation Criteria");
      expect(adapter.judgeCriteria).toContain("tenant_id filtering");
    });

    it("should discover convention check scripts", () => {
      expect(adapter.conventionCheckScripts).toHaveLength(1);
      expect(adapter.conventionCheckScripts[0]).toContain("check-1.js");
      expect(path.isAbsolute(adapter.conventionCheckScripts[0])).toBe(true);
    });
  });

  describe("missing adapter.json", () => {
    it("should throw with 'quack init' message when .quack/adapter.json is missing", async () => {
      await expect(loadAdapter(path.join(FIXTURES_DIR, "missing"))).rejects.toThrow(
        "No .quack/adapter.json found. Run 'quack init' to create one.",
      );
    });
  });

  describe("invalid adapter.json", () => {
    it("should throw Zod validation errors for invalid config", async () => {
      await expect(loadAdapter(path.join(FIXTURES_DIR, "invalid"))).rejects.toThrow(
        /Invalid adapter config/,
      );
    });

    it("should include field-level error details", async () => {
      try {
        await loadAdapter(path.join(FIXTURES_DIR, "invalid"));
        fail("Expected loadAdapter to throw");
      } catch (err: unknown) {
        const message = (err as Error).message;
        // The invalid config has empty project.name and missing required fields
        expect(message).toContain("project");
      }
    });
  });

  describe("missing optional files", () => {
    it("should return empty string for missing conventions.md", async () => {
      // The 'missing' fixture has no .quack dir at all, so we test with a
      // fixture that has adapter.json but no companion files.
      // The minimal fixture has conventions.md but no judge-criteria.md.
      const adapter = await loadAdapter(path.join(FIXTURES_DIR, "minimal"));
      expect(adapter.judgeCriteria).toBe("");
    });

    it("should return empty array for missing convention-checks/", async () => {
      const adapter = await loadAdapter(path.join(FIXTURES_DIR, "minimal"));
      expect(adapter.conventionCheckScripts).toEqual([]);
    });
  });

  describe("gate config", () => {
    it("loads adapter with gate.requiredSections set", async () => {
      const adapter = await loadAdapter(path.join(FIXTURES_DIR, "gate-required-sections"));
      expect(adapter.config.gate).toBeDefined();
      expect(adapter.config.gate!.requiredSections).toEqual(["filesToModify"]);
    });

    it("loads adapter without gate block (gate is undefined)", async () => {
      const adapter = await loadAdapter(path.join(FIXTURES_DIR, "minimal"));
      expect(adapter.config.gate).toBeUndefined();
    });
  });

  describe("adapter bundle metadata", () => {
    let adapter: ProjectAdapter;

    beforeAll(async () => {
      adapter = await loadAdapter(path.join(FIXTURES_DIR, "full"));
    });

    it("computes a deterministic shared bundle hash that ignores machine-local values", () => {
      const hostA = computeAdapterBundleMetadata(adapter.config);
      const hostBConfig: AdapterConfig = {
        ...adapter.config,
        project: {
          ...adapter.config.project,
          root: "C:/Users/worker/example-service",
        },
        agent: {
          ...adapter.config.agent,
          apiKeys: {
            pool: ["local-secret-key"],
            strategy: "least-used",
            cooldownMs: 90000,
          },
        },
        logging: {
          ...adapter.config.logging,
          dir: "C:/Users/worker/.quack/logs",
        },
        workerOverlay: {
          projectRoot: "C:/Users/worker/example-service",
          logDir: "C:/Users/worker/.quack/logs",
          endpoints: {
            headnode: "http://127.0.0.1:3333",
          },
          shell: {
            preferred: "pwsh",
            bashPath: "C:/Program Files/Git/bin/bash.exe",
          },
          capabilities: {
            docker: false,
          },
        },
      };

      const hostB = computeAdapterBundleMetadata(hostBConfig);

      expect(hostA.sharedHash).toBe(hostB.sharedHash);
      expect(hostA.normalizedConfig.project.root).toBe("<machine-local:project.root>");
      expect(hostA.normalizedConfig.logging.dir).toBe("<machine-local:logging.dir>");
      expect(hostA.normalizedConfig.workerOverlay).toBeUndefined();
      expect(hostA.machineLocalFields).toEqual(
        expect.arrayContaining(["project.root", "logging.dir", "agent.apiKeys", "workerOverlay"]),
      );
    });

    it("changes the shared bundle hash when shared validation policy changes", () => {
      const baseline = computeAdapterBundleMetadata(adapter.config);
      const changed: AdapterConfig = {
        ...adapter.config,
        verification: {
          ...adapter.config.verification,
          commands: [
            {
              ...adapter.config.verification.commands[0],
              required: false,
            },
            ...adapter.config.verification.commands.slice(1),
          ],
        },
      };

      expect(computeAdapterBundleMetadata(changed).sharedHash).not.toBe(baseline.sharedHash);
    });

    it("applies typed worker overlays deterministically", () => {
      const effective = applyAdapterWorkerOverlay({
        ...adapter.config,
        workerOverlay: {
          projectRoot: "/worker/project",
          taskDir: "worker/tasks",
          logDir: "/worker/logs",
          endpoints: {
            headnode: "http://headnode:3333",
          },
          shell: {
            preferred: "bash",
            bashPath: "/usr/bin/bash",
          },
          capabilities: {
            docker: true,
          },
        },
      });

      expect(effective.project.root).toBe("/worker/project");
      expect(effective.project.taskDir).toBe("worker/tasks");
      expect(effective.logging.dir).toBe("/worker/logs");
      expect(effective.workerOverlay?.endpoints?.headnode).toBe("http://headnode:3333");
      expect(effective.workerOverlay?.capabilities?.docker).toBe(true);
    });
  });
});
