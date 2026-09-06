// ─── Machinery-integrity barrier at the SHARED executor (TASK-1313) ─
// Round-1 F3 / round-2 F10: the barrier mounts at the top of
// runVerification itself, so the in-session MCP verify tool (which
// calls the executor directly, before any Stop hook) is barred in
// enforce mode WITHOUT executing a single adapter command. The sentinel
// command proves execution: it writes a file when (and only when) the
// verification body actually runs.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";
import { runVerification } from "../../src/worker/tools/verify";

jest.setTimeout(30000);

const SENTINEL = "BARRIER_SENTINEL.txt";

function makeBarrierAdapter(worktreeRoot: string): ProjectAdapter {
  const config: AdapterConfig = {
    version: "1.0",
    project: {
      name: "barrier-test",
      root: ".",
      taskDir: "docs/tasks",
      conventionsDir: "docs/conventions",
    },
    agent: {
      model: "claude-opus-4-6",
      judgeModel: "claude-sonnet-4-6",
      enrichModel: "claude-sonnet-4-6",
      maxTurns: 50,
      maxBudgetPerTask: 5.0,
      maxRetries: 1,
    },
    verification: {
      commands: [
        {
          name: "sentinel",
          command: `node -e "require('fs').writeFileSync('${SENTINEL}','ran')"`,
          required: true,
          timeout: 60,
        },
      ],
      conventionChecks: [],
    },
    sandbox: {
      writablePaths: ["src/"],
      deniedPaths: [],
      allowedBashPatterns: [],
      deniedBashPatterns: [],
    },
    git: {
      baseBranch: "main",
      branchPrefix: "quack/",
      commitFormat: "[{taskId}] {message}",
      commitTrailer: "",
      autoCreatePr: false,
      autoPush: false,
    },
    logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
  };
  return {
    config,
    projectRoot: worktreeRoot,
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    adapterBundle: {
      authority: "local",
      sharedHash: "test-shared-hash",
      normalizedConfig: config,
      machineLocalFields: [],
    },
  };
}

describe("runVerification machinery barrier (shared-executor mount)", () => {
  let authoritative: string;
  let worktree: string;

  const write = (root: string, rel: string, content: string): void => {
    const filePath = path.join(root, rel);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
  };

  const setup = (adapterJson: string): void => {
    write(authoritative, ".quack/adapter.json", adapterJson);
    write(authoritative, ".quack/conventions.md", "authoritative conventions");
    write(worktree, ".quack/adapter.json", adapterJson);
    // The tamper: the worktree's Tier-S conventions differ.
    write(worktree, ".quack/conventions.md", "TAMPERED conventions");
  };

  beforeEach(() => {
    authoritative = fs.mkdtempSync(path.join(os.tmpdir(), "quack-barrier-"));
    worktree = path.join(authoritative, ".quack", "worktrees", "wt-1");
    fs.mkdirSync(worktree, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(authoritative, { recursive: true, force: true });
  });

  it("enforce: fails closed naming the path, WITHOUT executing adapter commands", async () => {
    setup(
      JSON.stringify({
        judgment: { safetyFloor: { preVerificationIntegrity: { mode: "enforce" } } },
      }),
    );

    // Round-2 F8: the mismatch sink fires before the enforce return —
    // the Stop hook threads this through to `verification_integrity`
    // safety facts.
    const sunk: Array<{ path: string; reason: string }> = [];
    const result = await runVerification(makeBarrierAdapter(worktree), "all", {
      onIntegrityMismatch: (mismatches) => sunk.push(...mismatches),
    });

    expect(sunk).toEqual([{ path: ".quack/conventions.md", reason: "hash_mismatch" }]);
    expect(result.allPassed).toBe(false);
    expect(result.commands).toHaveLength(1);
    expect(result.commands[0].name).toBe("machinery-integrity");
    expect(result.commands[0].passed).toBe(false);
    expect(result.commands[0].output).toContain(".quack/conventions.md");
    // The load-bearing claim: the sentinel command never ran.
    expect(fs.existsSync(path.join(worktree, SENTINEL))).toBe(false);
  });

  it("warn: the finding rides along visibly while the body executes", async () => {
    setup(
      JSON.stringify({
        judgment: { safetyFloor: { preVerificationIntegrity: { mode: "warn" } } },
      }),
    );

    const result = await runVerification(makeBarrierAdapter(worktree), "all");

    expect(result.commands[0].name).toBe("machinery-integrity");
    expect(result.commands[0].passed).toBe(true);
    expect(result.commands[0].output).toContain("WARN");
    expect(result.commands[0].output).toContain(".quack/conventions.md");
    // Control for the enforce case: the same sentinel command DID run.
    expect(fs.existsSync(path.join(worktree, SENTINEL))).toBe(true);
  });

  it("absent safetyFloor config: barrier not executed, behavior is pre-1313", async () => {
    setup(JSON.stringify({ version: "1.0" }));

    const result = await runVerification(makeBarrierAdapter(worktree), "all");

    expect(result.commands.some((c) => c.name === "machinery-integrity")).toBe(false);
    expect(fs.existsSync(path.join(worktree, SENTINEL))).toBe(true);
  });
});
