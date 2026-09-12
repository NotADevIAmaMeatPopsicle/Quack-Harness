import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import {
  computeAdapterBundleMetadata,
  type ProjectAdapter,
} from "../../src/core/adapter-loader.js";
import type { AdapterConfig } from "../../src/core/types.js";
import { runVerification } from "../../src/worker/tools/verify.js";
import { _setSandboxedVerificationRunner } from "../../src/worker/verification-sandbox.js";

describe("runVerification codex-sandbox routing", () => {
  let projectRoot: string;

  beforeEach(async () => {
    projectRoot = await fs.mkdtemp(path.join(os.tmpdir(), "quack-verify-route-"));
    await fs.mkdir(path.join(projectRoot, ".quack"), { recursive: true });
  });

  afterEach(async () => {
    _setSandboxedVerificationRunner(undefined);
    await fs.rm(projectRoot, { recursive: true, force: true });
  });

  function adapter(): ProjectAdapter {
    const config: AdapterConfig = {
      version: "1.0",
      project: {
        name: "sandbox-route",
        root: ".",
        taskDir: "docs/tasks",
        conventionsDir: ".quack",
      },
      agent: {
        runner: "codex-cli",
        model: "gpt-5.5",
        judgeModel: "claude-sonnet-4-6",
        enrichModel: "claude-sonnet-4-6",
        maxTurns: 10,
        maxBudgetPerTask: 1,
        maxRetries: 0,
        codex: {
          binaryPath: process.execPath,
          sandbox: "workspace-write",
          timeoutMs: 60_000,
        },
      },
      verification: {
        hostExecution: "codex-sandbox",
        commands: [
          {
            name: "tests",
            command: "npm test",
            required: true,
            timeout: 30_000,
          },
        ],
        conventionChecks: [
          {
            name: "policy",
            description: "policy",
            command: "node policy.js",
            conventionRef: "POLICY",
          },
        ],
      },
      sandbox: {
        writablePaths: ["src/"],
        deniedPaths: [".git/"],
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
    return {
      config,
      projectRoot,
      conventionsDoc: "",
      judgeCriteria: "",
      conventionCheckScripts: [],
      adrDocs: {},
      adapterBundle: computeAdapterBundleMetadata(config),
    };
  }

  test("routes commands and convention checks through the contained sandbox", async () => {
    const invocations: string[][] = [];
    _setSandboxedVerificationRunner((input) => {
      invocations.push(input.args ?? []);
      return Promise.resolve({
        exitCode: 0,
        stdout: invocations.length === 1 ? "Tests: 1 passed, 1 total" : "policy ok",
        stderr: "",
        timedOut: false,
        descendantsContained: true,
      });
    });

    const result = await runVerification(adapter(), "all");

    expect(result.allPassed).toBe(true);
    expect(invocations).toHaveLength(2);
    expect(
      invocations.every((args) => args.includes("permissions.quack_verify.network.enabled=false")),
    ).toBe(true);
  });

  test("does not fall back to direct execution after sandbox refusal", async () => {
    _setSandboxedVerificationRunner(() =>
      Promise.resolve({
        exitCode: 1,
        stdout: "",
        stderr: "sandbox unavailable",
        timedOut: false,
        descendantsContained: true,
      }),
    );

    const result = await runVerification(adapter(), "tests");

    expect(result.allPassed).toBe(false);
    expect(result.commands[0].output).toContain("sandbox unavailable");
  });
});
