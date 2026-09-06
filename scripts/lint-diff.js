#!/usr/bin/env node
// Scope eslint to the .ts files changed vs the dispatch base branch.
// Mirrors /verify-task Phase 4 — pre-existing main-branch lint debt is not
// the worker's problem; only the diff matters.
//
// Resolution of base branch:
//   1. QUACK_LINT_BASE env var (set by dispatcher when it knows)
//   2. origin/main fallback
//
// Exits 0 when there are no changed .ts files (nothing to lint),
// 0 when eslint finds no errors in changed files,
// and the eslint exit code (1+) on lint errors.
//
// Filed under TASK-906 — replaces `npm run lint` over the whole repo as the
// dispatcher's verify hook.

const { execSync, spawnSync } = require("node:child_process");

const BASE = process.env.QUACK_LINT_BASE || "origin/main";

function diffFiles() {
  // We want everything that differs from BASE in the working tree:
  // committed-ahead changes (commits BASE..HEAD) AND uncommitted edits.
  // The dispatcher's verify hook runs BEFORE auto-commit, so the worker's
  // diff is uncommitted at that point — `git diff BASE` (no dots) captures
  // it because it compares working tree (not HEAD) against BASE.
  try {
    const tree = execSync(`git diff --name-only ${BASE} -- '*.ts'`, {
      encoding: "utf-8",
    });
    const staged = execSync(`git diff --name-only --cached ${BASE} -- '*.ts'`, {
      encoding: "utf-8",
    });
    const set = new Set(
      [...tree.split("\n"), ...staged.split("\n")]
        .map((s) => s.trim())
        .filter(Boolean),
    );
    return [...set];
  } catch (e) {
    process.stderr.write(
      `[lint:diff] Could not diff against ${BASE}: ${e.message}. Falling back to lint over working-tree edits only.\n`,
    );
    try {
      const out = execSync(`git diff --name-only HEAD -- '*.ts'`, {
        encoding: "utf-8",
      });
      const staged = execSync(`git diff --name-only --cached HEAD -- '*.ts'`, {
        encoding: "utf-8",
      });
      const set = new Set(
        [...out.split("\n"), ...staged.split("\n")]
          .map((s) => s.trim())
          .filter(Boolean),
      );
      return [...set];
    } catch {
      return [];
    }
  }
}

const files = diffFiles().filter((f) => /\.ts$/.test(f));

if (files.length === 0) {
  process.stdout.write(
    `[lint:diff] No .ts files changed vs ${BASE}; nothing to lint.\n`,
  );
  process.exit(0);
}

process.stdout.write(
  `[lint:diff] Linting ${files.length} changed file(s) vs ${BASE}:\n`,
);
for (const f of files) process.stdout.write(`  ${f}\n`);

const result = spawnSync("npx", ["eslint", ...files], {
  stdio: "inherit",
  shell: process.platform === "win32",
});
process.exit(result.status ?? 0);
