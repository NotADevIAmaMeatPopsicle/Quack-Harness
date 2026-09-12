// ─── TASK-1305: codex-cli review runner — mocked-spawn behavior matrix ─

import { EventEmitter } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { ChildProcess } from "node:child_process";
import {
  _setSpawnFn,
  buildCodexArgs,
  newTreeDirt,
  runCodexCliReview,
  type SpawnFn,
} from "../../src/review/codex-cli-runner";
import { ReviewerRunnerConfigSchema } from "../../src/review/reviewer-config";
import type { ReviewRequest } from "../../src/review/reviewer-types";
import { codexShellEnvironmentPolicyArgs } from "../../src/llm/codex-process-security";

const CODEX_CONFIG = ReviewerRunnerConfigSchema.parse({ runner: "codex-cli" });
const ORIGINAL_QUACK_SENTINEL = process.env.QUACK_SENTINEL_SECRET;
const ORIGINAL_OPENAI_CREDENTIAL = process.env.OPENAI_API_KEY;

class FakeChild extends EventEmitter {
  stdout = new EventEmitter();
  stderr = new EventEmitter();
  pid = 4242;
  killed = false;
  kill(): boolean {
    this.killed = true;
    return true;
  }
}

interface SpawnCall {
  cmd: string;
  args: string[];
  opts: { cwd?: string; env?: NodeJS.ProcessEnv };
}

interface FakeSpawnScript {
  onCodex: (child: FakeChild, call: SpawnCall) => void;
  /** Single response for every git call, an ARRAY served per call in
   *  order (last repeats — QPI-050's before/after captures make two
   *  calls), or "hang". */
  git?: { code: number; stdout: string } | Array<{ code: number; stdout: string }> | "hang";
}

function installFakeSpawn(script: FakeSpawnScript): {
  calls: SpawnCall[];
  codexChildren: FakeChild[];
} {
  const calls: SpawnCall[] = [];
  const codexChildren: FakeChild[] = [];
  let gitCallIndex = 0;
  _setSpawnFn(((cmd: string, args: string[], options: SpawnCall["opts"]) => {
    const call: SpawnCall = { cmd, args, opts: options };
    calls.push(call);
    const child = new FakeChild();
    if (cmd === "git") {
      const configured = script.git ?? { code: 0, stdout: "" };
      if (configured !== "hang") {
        const g = Array.isArray(configured)
          ? configured[Math.min(gitCallIndex, configured.length - 1)]
          : configured;
        gitCallIndex += 1;
        setImmediate(() => {
          if (g.stdout.length > 0) child.stdout.emit("data", g.stdout);
          child.emit("close", g.code, null);
        });
      }
      // "hang": never emits close — the runner's bounded check must cope
    } else if (cmd === "taskkill") {
      setImmediate(() => child.emit("close", 0, null));
    } else {
      codexChildren.push(child);
      setImmediate(() => script.onCodex(child, call));
    }
    return child as unknown as ChildProcess;
  }) as SpawnFn);
  return { calls, codexChildren };
}

const VERDICT_JSON = JSON.stringify({
  verdict: "SHIP",
  summary: "artifact survives refutation",
  confidence: 0.7,
  findings: [],
});

let tmpRoot: string;

beforeEach(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-codex-runner-"));
});

afterEach(() => {
  _setSpawnFn(undefined);
  fs.rmSync(tmpRoot, { recursive: true, force: true });
  if (ORIGINAL_QUACK_SENTINEL === undefined) {
    delete process.env.QUACK_SENTINEL_SECRET;
  } else {
    process.env.QUACK_SENTINEL_SECRET = ORIGINAL_QUACK_SENTINEL;
  }
  if (ORIGINAL_OPENAI_CREDENTIAL === undefined) {
    delete process.env.OPENAI_API_KEY;
  } else {
    process.env.OPENAI_API_KEY = ORIGINAL_OPENAI_CREDENTIAL;
  }
});

function request(overrides: Partial<ReviewRequest> = {}): ReviewRequest {
  return {
    kind: "diff",
    taskId: "TASK-9002",
    taskSpec: "# TASK-9002: spec text",
    artifact: "diff --git a/x b/x\n+added line",
    projectRoot: tmpRoot,
    ...overrides,
  };
}

describe("buildCodexArgs", () => {
  it("always pins --sandbox read-only and is not caller-extensible", () => {
    const args = buildCodexArgs(CODEX_CONFIG, "C:/req.md", "C:/proj", "C:/out.txt");
    expect(args[0]).toBe("exec");
    const sandboxIdx = args.indexOf("--sandbox");
    expect(sandboxIdx).toBeGreaterThan(0);
    expect(args[sandboxIdx + 1]).toBe("read-only");
    expect(args).toContain("--cd");
    expect(args[args.indexOf("--cd") + 1]).toBe("C:/proj");
    expect(args[args.indexOf("--output-last-message") + 1]).toBe("C:/out.txt");
    expect(args[args.length - 1]).toContain("C:/req.md");
    const shellPolicy = codexShellEnvironmentPolicyArgs();
    expect(args.slice(3, 3 + shellPolicy.length)).toEqual(shellPolicy);
    // escalation flags are unrepresentable in our argv
    expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(args).not.toContain("--full-auto");
  });

  it("includes -m only when a model is configured", () => {
    expect(buildCodexArgs(CODEX_CONFIG, "r.md", "p")).not.toContain("-m");
    const withModel = ReviewerRunnerConfigSchema.parse({
      runner: "codex-cli",
      model: "gpt-5.3-codex-spark",
    });
    const args = buildCodexArgs(withModel, "r.md", "p");
    expect(args[args.indexOf("-m") + 1]).toBe("gpt-5.3-codex-spark");
  });

  it("passes a configured profile as a fixed -p pair", () => {
    const withProfile = ReviewerRunnerConfigSchema.parse({
      runner: "codex-cli",
      codex: { profile: "openai" },
    });
    const args = buildCodexArgs(withProfile, "r.md", "p");
    expect(args[args.indexOf("-p") + 1]).toBe("openai");
  });

  it("pins a configured model provider without caller-defined argv", () => {
    const withProvider = ReviewerRunnerConfigSchema.parse({
      runner: "codex-cli",
      codex: { provider: "openai" },
    });
    const args = buildCodexArgs(withProvider, "r.md", "p");
    expect(args[args.indexOf("-c") + 1]).toBe('model_provider="openai"');
  });
});

describe("runCodexCliReview", () => {
  it("completes on stdout JSON: exact argv, request file on disk, clean tree", async () => {
    process.env.QUACK_SENTINEL_SECRET = "must-not-cross-process-boundary";
    process.env.OPENAI_API_KEY = "selected-provider-credential";
    const { calls } = installFakeSpawn({
      onCodex: (child) => {
        child.stdout.emit("data", VERDICT_JSON);
        child.emit("close", 0, null);
      },
      git: { code: 0, stdout: "" },
    });

    const result = await runCodexCliReview(request(), CODEX_CONFIG);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.verdict).toBe("SHIP");
    expect(result.treeDirtyAfterReview).toBe(false);
    expect(result.runner).toBe("codex-cli");

    // the request file exists and carries the full prompt (argv stays short)
    expect(result.requestFile).toBeDefined();
    const requestContent = fs.readFileSync(result.requestFile!, "utf-8");
    expect(requestContent).toContain("READ-ONLY REVIEW");
    expect(requestContent).toContain("TASK-9002: spec text");
    expect(requestContent).toContain("+added line");

    // the recorded argv is EXACTLY what buildCodexArgs constructs
    const codexCall = calls.find((c) => c.cmd === CODEX_CONFIG.codex.binaryPath);
    expect(codexCall).toBeDefined();
    const outIdx = codexCall!.args.indexOf("--output-last-message");
    const outputFile = codexCall!.args[outIdx + 1];
    expect(codexCall!.args).toEqual(
      buildCodexArgs(CODEX_CONFIG, result.requestFile!, tmpRoot, outputFile),
    );
    expect(codexCall!.opts.cwd).toBe(tmpRoot);
    expect(codexCall!.opts.env?.OPENAI_API_KEY).toBe("selected-provider-credential");
    expect(codexCall!.opts.env?.QUACK_SENTINEL_SECRET).toBeUndefined();

    // JSON round-trip (approval-file persistence contract)
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });

  it("prefers the --output-last-message file over stdout", async () => {
    installFakeSpawn({
      onCodex: (child, call) => {
        const outIdx = call.args.indexOf("--output-last-message");
        fs.writeFileSync(call.args[outIdx + 1], VERDICT_JSON, "utf-8");
        child.stdout.emit("data", "streaming noise, not the verdict");
        child.emit("close", 0, null);
      },
    });

    const result = await runCodexCliReview(request(), CODEX_CONFIG);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.verdict).toBe("SHIP");
    expect(result.rawText).toBe(VERDICT_JSON);
  });

  it("passes CODEX_HOME to the subprocess only when configured", async () => {
    const config = ReviewerRunnerConfigSchema.parse({
      runner: "codex-cli",
      codex: { codexHome: "C:/codex-headless" },
    });
    const { calls } = installFakeSpawn({
      onCodex: (child) => {
        child.stdout.emit("data", VERDICT_JSON);
        child.emit("close", 0, null);
      },
    });

    await runCodexCliReview(request(), config);
    const codexCall = calls.find((c) => c.cmd === "codex");
    expect(codexCall!.opts.env?.CODEX_HOME).toBe("C:/codex-headless");

    calls.length = 0;
    const { calls: calls2 } = installFakeSpawn({
      onCodex: (child) => {
        child.stdout.emit("data", VERDICT_JSON);
        child.emit("close", 0, null);
      },
    });
    await runCodexCliReview(request(), CODEX_CONFIG);
    const plainCall = calls2.find((c) => c.cmd === "codex");
    expect(plainCall!.opts.env?.CODEX_HOME).toBe(process.env.CODEX_HOME);
  });

  it("maps ENOENT to unavailable with an actionable message", async () => {
    installFakeSpawn({
      onCodex: (child) => {
        const err = new Error("spawn codex ENOENT") as NodeJS.ErrnoException;
        err.code = "ENOENT";
        child.emit("error", err);
      },
    });

    const result = await runCodexCliReview(request(), CODEX_CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("unavailable");
    expect(result.message).toContain('"codex"');
    expect(result.requestFile).toBeDefined();
  });

  it("maps a non-ENOENT spawn error event to spawn_failed", async () => {
    installFakeSpawn({
      onCodex: (child) => {
        const err = new Error("EACCES: permission denied") as NodeJS.ErrnoException;
        err.code = "EACCES";
        child.emit("error", err);
      },
    });

    const result = await runCodexCliReview(request(), CODEX_CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("spawn_failed");
  });

  it("maps a synchronously-throwing spawn to spawn_failed (never rejects)", async () => {
    _setSpawnFn((() => {
      throw new Error("0xC0000142 spawn pressure");
    }) as SpawnFn);

    const result = await runCodexCliReview(request(), CODEX_CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("spawn_failed");
    expect(result.message).toContain("0xC0000142");
  });

  it("maps a non-zero exit to session_error with exitCode and stderrTail", async () => {
    installFakeSpawn({
      onCodex: (child) => {
        child.stderr.emit("data", "auth expired: run codex login\n");
        child.emit("close", 2, null);
      },
    });

    const result = await runCodexCliReview(request(), CODEX_CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("session_error");
    expect(result.exitCode).toBe(2);
    expect(result.stderrTail).toContain("auth expired");
  });

  it("maps exit 0 with no valid verdict to parse_failed, never a verdict", async () => {
    installFakeSpawn({
      onCodex: (child) => {
        child.stdout.emit("data", "looks good to me, shipping it!");
        child.emit("close", 0, null);
      },
    });

    const result = await runCodexCliReview(request(), CODEX_CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("parse_failed");
    expect(result.exitCode).toBe(0);
    expect(result.rawText).toContain("looks good");
  });

  it("tree-kills and reports timeout when the subprocess hangs", async () => {
    const { calls, codexChildren } = installFakeSpawn({
      onCodex: () => {
        /* never closes */
      },
    });

    const config = ReviewerRunnerConfigSchema.parse({
      runner: "codex-cli",
      timeoutMs: 60,
    });
    const result = await runCodexCliReview(request(), config);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("timeout");
    expect(result.message).toContain("60ms");
    expect(result.message).toContain("4242");

    const killAttempted =
      calls.some((c) => c.cmd === "taskkill") || codexChildren.some((c) => c.killed);
    expect(killAttempted).toBe(true);
  });

  it("flags NEW dirt that appeared during a supposedly read-only review", async () => {
    installFakeSpawn({
      onCodex: (child) => {
        child.stdout.emit("data", VERDICT_JSON);
        child.emit("close", 0, null);
      },
      // QPI-050: clean before the review, dirty after — the reviewer's.
      git: [
        { code: 0, stdout: "" },
        { code: 0, stdout: " M src/tampered.ts\n" },
      ],
    });

    const result = await runCodexCliReview(request(), CODEX_CONFIG);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.treeDirtyAfterReview).toBe(true);
  });

  it("QPI-050: pre-existing dirt (the pipeline's adapter sync) is NOT attributed to the reviewer", async () => {
    installFakeSpawn({
      onCodex: (child) => {
        child.stdout.emit("data", VERDICT_JSON);
        child.emit("close", 0, null);
      },
      // Identical dirt before and after — the worktree was born dirty.
      git: { code: 0, stdout: " M .quack/adapter.json\n" },
    });

    const result = await runCodexCliReview(request(), CODEX_CONFIG);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.treeDirtyAfterReview).toBe(false);
  });

  it("QPI-050: the runner-owned output file is pre-created into the baseline", async () => {
    installFakeSpawn({
      onCodex: (child) => {
        // Codex never writes the output file in this scenario — its
        // existence afterward proves the runner pre-created it BEFORE
        // the baseline capture.
        child.stdout.emit("data", VERDICT_JSON);
        child.emit("close", 0, null);
      },
    });

    const req = request();
    const result = await runCodexCliReview(req, CODEX_CONFIG);
    expect(result.status).toBe("completed");

    const reviewsDir = path.join(req.projectRoot, ".quack", "logs", "reviews");
    const lastFiles = fs.readdirSync(reviewsDir).filter((f) => f.endsWith(".last.txt"));
    expect(lastFiles.length).toBe(1);
  });

  it("QPI-050: newTreeDirt attributes only lines absent from the baseline", () => {
    expect(newTreeDirt([], [" M src/x.ts"])).toEqual([" M src/x.ts"]);
    expect(newTreeDirt([" M .quack/adapter.json"], [" M .quack/adapter.json"])).toEqual([]);
    expect(
      newTreeDirt([" M .quack/adapter.json"], [" M .quack/adapter.json", "?? src/new.ts"]),
    ).toEqual(["?? src/new.ts"]);
    // Dirt that DISAPPEARED during review is not new dirt either.
    expect(newTreeDirt([" M src/x.ts"], [])).toEqual([]);
  });

  it("omits the dirty flag when the git check itself fails", async () => {
    installFakeSpawn({
      onCodex: (child) => {
        child.stdout.emit("data", VERDICT_JSON);
        child.emit("close", 0, null);
      },
      git: { code: 128, stdout: "" },
    });

    const result = await runCodexCliReview(request(), CODEX_CONFIG);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.treeDirtyAfterReview).toBeUndefined();
  });

  it("maps request-file write failures to session_error (catch-all; never rejects)", async () => {
    const fileAsRoot = path.join(tmpRoot, "not-a-dir.txt");
    fs.writeFileSync(fileAsRoot, "plain file", "utf-8");
    installFakeSpawn({
      onCodex: (child) => {
        child.emit("close", 0, null);
      },
    });

    const result = await runCodexCliReview(request({ projectRoot: fileAsRoot }), CODEX_CONFIG);
    expect(result.status).toBe("runner_error");
    if (result.status !== "runner_error") return;
    expect(result.errorKind).toBe("session_error");
  });

  it("settles (never hangs) when post-exit processing hits a poisoned anchor path", async () => {
    // NUL-poisoned citation: fs.existsSync THROWS on such paths. Without the
    // post-exit guard + hardened audit this left run() pending forever
    // (round-2 finding 1).
    const poisoned = JSON.stringify({
      verdict: "AMEND",
      summary: "poisoned anchor",
      findings: [{ severity: "should_fix", summary: "x", anchors: ["src/\u0000bad.ts:1"] }],
    });
    installFakeSpawn({
      onCodex: (child) => {
        child.stdout.emit("data", poisoned);
        child.emit("close", 0, null);
      },
    });

    const result = await runCodexCliReview(request(), CODEX_CONFIG);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.anchorsAudit).toEqual({
      total: 1,
      missing: ["src/\u0000bad.ts"],
    });
  });

  it("bounds the post-run tree check: a hung git status cannot block settle", async () => {
    installFakeSpawn({
      onCodex: (child) => {
        child.stdout.emit("data", VERDICT_JSON);
        child.emit("close", 0, null);
      },
      git: "hang",
    });

    // timeoutMs also caps the tree-check budget (min(10s, timeoutMs))
    const config = ReviewerRunnerConfigSchema.parse({
      runner: "codex-cli",
      timeoutMs: 80,
    });
    const result = await runCodexCliReview(request(), config);
    expect(result.status).toBe("completed");
    if (result.status !== "completed") return;
    expect(result.verdict).toBe("SHIP");
    expect(result.treeDirtyAfterReview).toBeUndefined();
  });

  it("round-trips a runner_error through JSON structurally intact", async () => {
    installFakeSpawn({
      onCodex: (child) => {
        child.stderr.emit("data", "boom");
        child.emit("close", 1, null);
      },
    });

    const result = await runCodexCliReview(request(), CODEX_CONFIG);
    expect(result.status).toBe("runner_error");
    expect(JSON.parse(JSON.stringify(result))).toEqual(result);
  });
});
