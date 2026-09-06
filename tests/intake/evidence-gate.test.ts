// ─── Evidence gate tests ────────────────────────────────────────────
// Per Blueprint §9: ≥12 cases covering empty nonClaims, unresolvable
// branch (with + without git fetch retry), unresolvable commitRange,
// all-SKIP / all-FAIL tests, mixed PASS+FAIL, shell-metachar refusal.
//
// Branch resolution uses a separate origin-bare repo so we can simulate
// the "branch exists on origin but not locally until git fetch" scenario.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runEvidenceGate } from "../../src/intake/evidence-gate.js";
import type { ValidationIntakePayload } from "../../src/intake/task-intake.js";

// ─── Fixtures / helpers ────────────────────────────────────────────

interface TempRepoPair {
  /** Working clone — the projectRoot the gate runs against. */
  workRoot: string;
  /** Bare repo that serves as `origin`. */
  originRoot: string;
}

function makeTempRepoPair(): TempRepoPair {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-evidence-gate-"));
  const originRoot = path.join(baseDir, "origin.git");
  const workRoot = path.join(baseDir, "work");

  fs.mkdirSync(originRoot, { recursive: true });
  fs.mkdirSync(workRoot, { recursive: true });

  // Bare repo as origin.
  execSync("git init -q --bare -b main", { cwd: originRoot, stdio: "ignore" });

  // Working clone.
  execSync("git init -q -b main", { cwd: workRoot, stdio: "ignore" });
  execSync("git config user.email test@quack.local", { cwd: workRoot, stdio: "ignore" });
  execSync("git config user.name Quack-Test", { cwd: workRoot, stdio: "ignore" });
  execSync("git config commit.gpgsign false", { cwd: workRoot, stdio: "ignore" });
  // Normalize to forward slashes for cross-platform git path handling.
  const originForGit = originRoot.replace(/\\/g, "/");
  execSync(`git remote add origin "${originForGit}"`, { cwd: workRoot, stdio: "ignore" });

  return { workRoot, originRoot };
}

function commitFile(repoRoot: string, relPath: string, content: string, message: string): void {
  const absPath = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf-8");
  execSync(`git add ${JSON.stringify(relPath)}`, { cwd: repoRoot, stdio: "ignore" });
  execSync(`git commit -q -m ${JSON.stringify(message)}`, { cwd: repoRoot, stdio: "ignore" });
}

function checkoutBranch(repoRoot: string, branch: string): void {
  execSync(`git checkout -q -b ${JSON.stringify(branch)}`, { cwd: repoRoot, stdio: "ignore" });
}

function makePayload(overrides: Partial<ValidationIntakePayload> = {}): ValidationIntakePayload {
  return {
    schemaVersion: 1,
    project: "demo",
    branch: "feature/test",
    commitRange: "HEAD~1..HEAD",
    scope: ["src/a.ts"],
    tests: [{ name: "spec", result: "PASS", evidence: "log.txt" }],
    screenshots: [],
    nonClaims: ["package-lock.json"], // non-empty by default; cases override.
    knownRisks: [],
    submitter: "tester",
    submittedAt: "2026-05-31T00:00:00Z",
    ...overrides,
  } as ValidationIntakePayload;
}

describe("runEvidenceGate", () => {
  let repoRoot: string;
  let cleanupRoot: string;

  beforeEach(() => {
    const pair = makeTempRepoPair();
    repoRoot = pair.workRoot;
    cleanupRoot = path.dirname(pair.workRoot); // baseDir for both work + origin
    commitFile(repoRoot, "README.md", "seed\n", "seed");
    commitFile(repoRoot, "src/a.ts", "export const a = 1;\n", "add a");
    checkoutBranch(repoRoot, "feature/test");
    // Push the feature branch to origin so ls-remote sees it.
    execSync("git push -q origin feature/test", { cwd: repoRoot, stdio: "ignore" });
  });

  afterEach(() => {
    fs.rmSync(cleanupRoot, { recursive: true, force: true });
  });

  // ─── (a) Happy path → PASS, no deficiencies. ───────────────────
  it("PASS when all evidence checks succeed", async () => {
    const result = await runEvidenceGate(repoRoot, makePayload());
    expect(result.verdict).toBe("PASS");
    expect(result.deficiencies).toEqual([]);
  });

  // ─── (b) Empty nonClaims → REVISE with non-bypass deficiency. ──
  // SPEC SUCCESS CRITERION SC8.
  it("REVISE on empty nonClaims with non-bypass rule deficiency", async () => {
    const result = await runEvidenceGate(repoRoot, makePayload({ nonClaims: [] }));
    expect(result.verdict).toBe("REVISE");
    expect(result.deficiencies).toEqual(
      expect.arrayContaining([expect.stringContaining("nonClaims must be non-empty")]),
    );
    expect(result.deficiencies.some((d) => d.includes("TASK-1106 non-bypass rule"))).toBe(true);
  });

  // ─── (c) All-SKIP tests → REVISE. ──────────────────────────────
  it("REVISE when all tests are SKIP", async () => {
    const result = await runEvidenceGate(
      repoRoot,
      makePayload({
        tests: [
          { name: "spec-1", result: "SKIP", evidence: "log-1.txt" },
          { name: "spec-2", result: "SKIP", evidence: "log-2.txt" },
        ],
      }),
    );
    expect(result.verdict).toBe("REVISE");
    expect(
      result.deficiencies.some((d) => d.includes('at least one entry with result === "PASS"')),
    ).toBe(true);
  });

  // ─── (d) Mixed 1 PASS + 1 FAIL → PASS (>=1 PASS rule). ─────────
  it("PASS when at least one test PASSes alongside FAILs", async () => {
    const result = await runEvidenceGate(
      repoRoot,
      makePayload({
        tests: [
          { name: "spec-1", result: "FAIL", evidence: "log-1.txt" },
          { name: "spec-2", result: "PASS", evidence: "log-2.txt" },
        ],
      }),
    );
    expect(result.verdict).toBe("PASS");
    expect(result.deficiencies).toEqual([]);
  });

  // ─── (e) Branch unresolvable → retry path fires and sets fetched=true.
  //
  // Real git `ls-remote` queries the remote LIVE, so a deterministic
  // "first-miss then second-success" without mocking child_process is not
  // achievable purely with on-disk fixtures. We instead assert the retry
  // CODEPATH fired by checking that `fetched` is true when the first
  // ls-remote misses. The follow-up "still unresolvable after retry" still
  // ends in REVISE — the load-bearing claim is that the gate attempted
  // the fetch retry rather than failing on the first miss.
  it("sets fetched=true and REVISEs when branch never exists on origin", async () => {
    const result = await runEvidenceGate(
      repoRoot,
      makePayload({ branch: "feature/never-existed" }),
    );
    expect(result.verdict).toBe("REVISE");
    expect(result.fetched).toBe(true);
    expect(result.deficiencies.some((d) => d.includes("did not resolve on origin"))).toBe(true);
  });

  // ─── (f) Different unresolvable branch — same retry behaviour. ─
  it("REVISE when branch cannot be resolved on origin (alternate name)", async () => {
    const result = await runEvidenceGate(
      repoRoot,
      makePayload({ branch: "feature/does-not-exist" }),
    );
    expect(result.verdict).toBe("REVISE");
    expect(result.fetched).toBe(true);
    expect(result.deficiencies.some((d) => d.includes("did not resolve on origin"))).toBe(true);
  });

  // ─── (g) commitRange unresolvable → REVISE. ────────────────────
  it("REVISE when commitRange does not resolve via git rev-list", async () => {
    const result = await runEvidenceGate(
      repoRoot,
      makePayload({ commitRange: "deadbeef..feedface" }),
    );
    expect(result.verdict).toBe("REVISE");
    expect(result.deficiencies.some((d) => d.includes("did not resolve via git rev-list"))).toBe(
      true,
    );
  });

  // ─── (h) Shell-metachar in commitRange → throws BEFORE git. ────
  it("refuses commitRange with shell metacharacters before invoking git", async () => {
    for (const commitRange of ["a..b; rm -rf /", "$(curl evil)..HEAD", "a..b`x`", "a..b\nINJ"]) {
      await expect(runEvidenceGate(repoRoot, makePayload({ commitRange }))).rejects.toThrow(
        /shell metacharacters|newlines/,
      );
    }
  });

  // ─── (i) Unsafe branch (regex violation) → throws. ─────────────
  it("refuses branch failing the safe-name regex", async () => {
    await expect(
      runEvidenceGate(repoRoot, makePayload({ branch: "feature/has spaces" })),
    ).rejects.toThrow(/match/);
  });

  // ─── (j) PASS without retry sets no `fetched` field. ───────────
  it("does NOT set fetched flag when branch resolves on first try", async () => {
    const result = await runEvidenceGate(repoRoot, makePayload());
    expect(result.verdict).toBe("PASS");
    expect(result.fetched).toBeUndefined();
  });

  // ─── (k) All-FAIL tests → REVISE (only PASS counts). ───────────
  it("REVISE when all tests are FAIL", async () => {
    const result = await runEvidenceGate(
      repoRoot,
      makePayload({
        tests: [
          { name: "spec-1", result: "FAIL", evidence: "log-1.txt" },
          { name: "spec-2", result: "FAIL", evidence: "log-2.txt" },
        ],
      }),
    );
    expect(result.verdict).toBe("REVISE");
    expect(
      result.deficiencies.some((d) => d.includes('at least one entry with result === "PASS"')),
    ).toBe(true);
  });

  // ─── (l) Multiple deficiencies surfaced in one pass. ───────────
  it("collects all deficiencies in a single response (no short-circuit)", async () => {
    const result = await runEvidenceGate(
      repoRoot,
      makePayload({
        nonClaims: [],
        tests: [{ name: "spec", result: "SKIP", evidence: "log.txt" }],
        commitRange: "deadbeef..feedface",
      }),
    );
    expect(result.verdict).toBe("REVISE");
    expect(result.deficiencies.length).toBeGreaterThanOrEqual(3);
    expect(result.deficiencies.some((d) => d.includes("nonClaims must be non-empty"))).toBe(true);
    expect(
      result.deficiencies.some((d) => d.includes('at least one entry with result === "PASS"')),
    ).toBe(true);
    expect(result.deficiencies.some((d) => d.includes("commitRange"))).toBe(true);
  });
});
