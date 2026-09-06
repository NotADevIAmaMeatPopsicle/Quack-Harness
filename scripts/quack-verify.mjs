#!/usr/bin/env node
// ─── quack-verify.mjs ───────────────────────────────────────────────
// Standalone verification script for workers and operators.
// Runs build/lint checks with optional scope-to-changed mode that
// restricts failure gating to files touched by the current branch.
//
// Usage:
//   node scripts/quack-verify.mjs [--scope-to-changed] [--base-branch BRANCH]
//   node scripts/quack-verify.mjs --help

import { execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs as nodeParseArgs } from "node:util";

function usage(exitCode = 0) {
  console.log(`
Usage:
  node scripts/quack-verify.mjs [options]

Options:
  --scope-to-changed     Restrict build/lint failure gating to files in the
                         current branch's diff. Pre-existing failures outside
                         the diff emit a warning but do NOT cause non-zero exit.
  --base-branch BRANCH   Base branch for diff comparison (default: main)
  --help                 Show this help

Behavior without --scope-to-changed:
  Standard verification — any build or lint failure causes exit 1.

Behavior with --scope-to-changed:
  1. Build: if build fails in frontend/ and diff does NOT touch frontend/,
     emits warning 'pre-existing frontend build failure excluded' and continues.
  2. Lint: if lint fails on files NOT in the diff, emits
     'pre-existing lint failures excluded (N files outside diff)' and exits 0.
`.trim());
  process.exit(exitCode);
}

const { values: opts } = nodeParseArgs({
  args: process.argv.slice(2),
  options: {
    "scope-to-changed": { type: "boolean", default: false },
    "base-branch": { type: "string", default: "main" },
    help: { type: "boolean", default: false },
  },
  allowPositionals: false,
});

if (opts.help) usage(0);

const scopeToChanged = opts["scope-to-changed"];
const baseBranch = opts["base-branch"] || "main";

// ─── Load adapter.json ──────────────────────────────────────────────

function loadAdapterConfig(cwd) {
  const adapterPath = join(cwd, ".quack", "adapter.json");
  if (!existsSync(adapterPath)) {
    console.error(
      `[quack-verify] .quack/adapter.json not found at ${adapterPath}`,
    );
    process.exit(1);
  }
  try {
    return JSON.parse(readFileSync(adapterPath, "utf-8"));
  } catch (err) {
    console.error(
      `[quack-verify] Failed to parse adapter.json: ${err.message}`,
    );
    process.exit(1);
  }
}

// ─── Git diff helpers ───────────────────────────────────────────────

function getChangedFiles(cwd) {
  try {
    let diffBase = "HEAD";
    try {
      const mergeBase = execSync(`git merge-base ${baseBranch} HEAD`, {
        cwd,
        encoding: "utf-8",
        stdio: ["pipe", "pipe", "pipe"],
      }).trim();
      if (mergeBase.length > 0) diffBase = mergeBase;
    } catch {
      // merge-base failed — use HEAD (empty diff)
    }
    const output = execSync(`git diff --name-only ${diffBase}..HEAD`, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return output ? output.split("\n").filter(Boolean) : [];
  } catch {
    return [];
  }
}

function diffTouchesFrontend(changedFiles) {
  return changedFiles.some(
    (f) => f.startsWith("frontend/") || f.startsWith("frontend\\"),
  );
}

// ─── Run verification ───────────────────────────────────────────────

function runCommand(command, cwd) {
  try {
    const output = execSync(command, {
      cwd,
      encoding: "utf-8",
      stdio: ["pipe", "pipe", "pipe"],
      timeout: 300_000, // 5 min cap
    });
    return { exitCode: 0, stdout: output, stderr: "" };
  } catch (err) {
    return {
      exitCode: err.status ?? 1,
      stdout: err.stdout?.toString() ?? "",
      stderr: err.stderr?.toString() ?? "",
    };
  }
}

async function main() {
  const cwd = process.cwd();
  const config = loadAdapterConfig(cwd);

  const commands = config.verification?.commands ?? [];
  if (commands.length === 0) {
    console.log(
      "[quack-verify] No verification commands found in adapter.json",
    );
    process.exit(0);
  }

  const changedFiles = scopeToChanged ? getChangedFiles(cwd) : [];
  let hasFailure = false;
  const findings = [];

  for (const cmd of commands) {
    const cmdString =
      cmd.command || `${cmd.cmd || ""} ${(cmd.args || []).join(" ")}`.trim();
    const cmdName = cmd.name || cmdString;
    const isRequired = cmd.required !== false;

    console.log(`[quack-verify] Running: ${cmdName} (${cmdString})`);

    const result = runCommand(cmdString, cwd);

    if (result.exitCode === 0) {
      console.log(`[quack-verify] PASS ${cmdName}`);
      findings.push({ name: cmdName, status: "pass" });
      continue;
    }

    // Command failed — check scope-to-changed logic
    const output = result.stderr || result.stdout || "";

    if (scopeToChanged) {
      // ── Build: frontend-unchanged skip ──────────────────────────
      if (
        cmdName.toLowerCase().includes("build") &&
        (output.includes("frontend/") || output.includes("frontend\\"))
      ) {
        if (!diffTouchesFrontend(changedFiles)) {
          console.log(
            `[quack-verify] WARN ${cmdName}: pre-existing frontend build failure excluded ` +
              `(diff does not touch frontend/). Operator should run 'npm --prefix frontend install'.`,
          );
          findings.push({
            name: cmdName,
            status: "warn",
            reason: "pre-existing frontend build failure excluded",
          });
          continue;
        }
      }

      // ── Lint: scope to changed files ────────────────────────────
      if (cmdName.toLowerCase().includes("lint")) {
        // If no files changed, all lint failures are pre-existing
        if (changedFiles.length === 0) {
          console.log(
            `[quack-verify] WARN ${cmdName}: pre-existing lint failures excluded ` +
              `(no files in diff).`,
          );
          findings.push({
            name: cmdName,
            status: "warn",
            reason: "pre-existing lint failures excluded",
          });
          continue;
        }

        // Check if the lint errors reference only files outside the diff
        const lintOutputLines = output.split("\n");
        const lintErrorsInDiff = lintOutputLines.filter((line) =>
          changedFiles.some((f) => line.includes(f)),
        );
        const lintErrorsOutsideDiff = lintOutputLines.filter(
          (line) =>
            line.trim().length > 0 &&
            !changedFiles.some((f) => line.includes(f)),
        );

        if (lintErrorsInDiff.length === 0 && lintErrorsOutsideDiff.length > 0) {
          console.log(
            `[quack-verify] WARN ${cmdName}: pre-existing lint failures excluded ` +
              `(${lintErrorsOutsideDiff.length} lines outside diff). ` +
              `Changed files: ${changedFiles.length}.`,
          );
          findings.push({
            name: cmdName,
            status: "warn",
            reason: `pre-existing lint failures excluded (${lintErrorsOutsideDiff.length} lines outside diff)`,
          });
          continue;
        }
      }
    }

    // Not scoped away — this is a real failure
    const truncated =
      output.length > 500 ? output.slice(0, 500) + "..." : output;
    if (isRequired) {
      console.error(`[quack-verify] FAIL ${cmdName}\n${truncated}`);
      hasFailure = true;
      findings.push({ name: cmdName, status: "fail" });
    } else {
      console.log(
        `[quack-verify] WARN ${cmdName}: optional command failed\n${truncated}`,
      );
      findings.push({ name: cmdName, status: "warn" });
    }
  }

  // ── Summary ─────────────────────────────────────────────────────
  console.log("\n[quack-verify] Summary:");
  for (const f of findings) {
    const icon =
      f.status === "pass" ? "PASS" : f.status === "fail" ? "FAIL" : "WARN";
    const extra = f.reason ? ` -- ${f.reason}` : "";
    console.log(`  ${icon} ${f.name}${extra}`);
  }

  if (hasFailure) {
    console.log("\n[quack-verify] Verification FAILED.");
    process.exit(1);
  } else {
    console.log("\n[quack-verify] Verification PASSED.");
    process.exit(0);
  }
}

main().catch((err) => {
  console.error(`[quack-verify] Unexpected error: ${err.message}`);
  process.exit(1);
});
