// ─── Machinery Integrity (TASK-1313 S3/S4) ──────────────────────────
// Compares the worktree's Tier-S verification machinery against the
// authoritative root's copies. Mounted at the TOP of the shared
// verification executor (covers the Stop hook AND the in-session MCP
// verify tool — round-1 F3) and at the resume-validation sites.
//
// Fail-closed direction only: a mismatch or worktree-only file is a
// `machinery_tamper` fact. Missing on both sides is clean. Non-worktree
// roots compare to themselves and are structurally clean.
//
// The paired `restoreMachineryFile` helper is the worker's recovery path
// (round-1 F9: the git floor denies checkout/reset, so the agent cannot
// git-revert): it copies the AUTHORITATIVE version over the worktree
// copy — that direction only, Tier-S paths only.

import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";

import {
  resolveSafetyFloorConfig,
  SafetyFloorConfigSchema,
  type ResolvedSafetyFloorConfig,
} from "../runner/intent-judgment-config.js";
import { TIER_S_EXACT_PATHS, TIER_S_PREFIX_PATHS } from "./seal-conformance.js";

export interface MachineryMismatch {
  /** Repo-relative path (forward slashes). */
  path: string;
  reason: "hash_mismatch" | "worktree_only" | "authoritative_only";
}

export interface MachineryIntegrityResult {
  clean: boolean;
  /** True when worktreeRoot resolves to the authoritative root itself. */
  selfCompare: boolean;
  mismatches: MachineryMismatch[];
}

async function hashFile(filePath: string): Promise<string | undefined> {
  try {
    const buffer = await fs.readFile(filePath);
    return createHash("sha256").update(buffer).digest("hex");
  } catch {
    return undefined;
  }
}

async function listPrefixFiles(root: string, prefix: string): Promise<string[]> {
  const dir = path.join(root, prefix);
  try {
    const entries = await fs.readdir(dir, { withFileTypes: true, recursive: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) =>
        path
          .relative(root, path.join(entry.parentPath ?? entry.path, entry.name))
          .replace(/\\/g, "/"),
      );
  } catch {
    return [];
  }
}

/** Every Tier-S relative path present on either side. */
async function collectTierSPaths(
  worktreeRoot: string,
  authoritativeRoot: string,
): Promise<string[]> {
  const paths = new Set<string>(TIER_S_EXACT_PATHS);
  for (const prefix of TIER_S_PREFIX_PATHS) {
    for (const relative of await listPrefixFiles(worktreeRoot, prefix)) {
      paths.add(relative);
    }
    for (const relative of await listPrefixFiles(authoritativeRoot, prefix)) {
      paths.add(relative);
    }
  }
  return [...paths].sort();
}

export function isTierSPath(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return (
    (TIER_S_EXACT_PATHS as readonly string[]).includes(normalized) ||
    TIER_S_PREFIX_PATHS.some((prefix) => normalized.startsWith(prefix))
  );
}

/**
 * Compare Tier-S machinery between the worktree and the authoritative
 * root. Never throws; unreadable files count as absent.
 */
export async function checkMachineryIntegrity(
  worktreeRoot: string,
  authoritativeRoot: string,
): Promise<MachineryIntegrityResult> {
  const resolvedWorktree = path.resolve(worktreeRoot);
  const resolvedAuthoritative = path.resolve(authoritativeRoot);
  if (resolvedWorktree === resolvedAuthoritative) {
    return { clean: true, selfCompare: true, mismatches: [] };
  }

  const mismatches: MachineryMismatch[] = [];
  for (const relative of await collectTierSPaths(resolvedWorktree, resolvedAuthoritative)) {
    const worktreeHash = await hashFile(path.join(resolvedWorktree, relative));
    const authoritativeHash = await hashFile(path.join(resolvedAuthoritative, relative));
    if (worktreeHash === authoritativeHash) continue;
    if (worktreeHash === undefined) {
      mismatches.push({ path: relative, reason: "authoritative_only" });
    } else if (authoritativeHash === undefined) {
      mismatches.push({ path: relative, reason: "worktree_only" });
    } else {
      mismatches.push({ path: relative, reason: "hash_mismatch" });
    }
  }
  return { clean: mismatches.length === 0, selfCompare: false, mismatches };
}

/**
 * Resolve the authoritative project root for a (possibly worktree)
 * root. Same semantics as the sealer's resolveEvidenceProjectRoot —
 * duplicated here deliberately: the worker layer must not import from
 * the dispatcher layer.
 */
export function resolveAuthoritativeRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  const parts = resolved.split(/[\\/]+/);
  const quackIndex = parts.lastIndexOf(".quack");
  if (quackIndex >= 0 && parts[quackIndex + 1] === "worktrees") {
    const root = parts.slice(0, quackIndex).join(path.sep);
    if (root === "") return path.parse(resolved).root;
    return root;
  }
  return resolved;
}

/**
 * Read the AUTHORITATIVE root's safetyFloor config (round-1 F7: never
 * the worktree copy at an enforcement point). Unreadable or invalid
 * config resolves to all-off — the operator-controlled side must be
 * well-formed for enforcement to arm; failures are conservative, not
 * throwing.
 */
export async function readAuthoritativeSafetyFloor(
  authoritativeRoot: string,
): Promise<ResolvedSafetyFloorConfig> {
  const off = resolveSafetyFloorConfig(undefined);
  try {
    const raw = await fs.readFile(path.join(authoritativeRoot, ".quack", "adapter.json"), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return off;
    const judgment = (parsed as Record<string, unknown>).judgment;
    if (typeof judgment !== "object" || judgment === null) return off;
    const floor = (judgment as Record<string, unknown>).safetyFloor;
    if (floor === undefined) return off;
    const result = SafetyFloorConfigSchema.safeParse(floor);
    if (!result.success) return off;
    return resolveSafetyFloorConfig(result.data);
  } catch {
    return off;
  }
}

export interface RestoreMachineryResult {
  restored: boolean;
  reason?: string;
}

/**
 * Copy the AUTHORITATIVE version of one Tier-S file over the worktree
 * copy. Refuses non-Tier-S paths and traversal; safe direction only.
 */
export async function restoreMachineryFile(
  worktreeRoot: string,
  authoritativeRoot: string,
  relativePath: string,
): Promise<RestoreMachineryResult> {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  if (normalized.includes("..")) {
    return { restored: false, reason: "path traversal refused" };
  }
  if (!isTierSPath(normalized)) {
    return {
      restored: false,
      reason: `"${normalized}" is not a Tier-S machinery path`,
    };
  }
  const source = path.join(path.resolve(authoritativeRoot), normalized);
  const target = path.join(path.resolve(worktreeRoot), normalized);
  // Round-2 F3: refuse symlinked targets and symlinked parent chains —
  // a planted link must not let the restore write outside the worktree.
  const symlinkEscape = async (): Promise<boolean> => {
    const worktreeReal = await fs.realpath(path.resolve(worktreeRoot));
    let probe = target;
    let prev: string | null = null;
    while (probe !== prev) {
      try {
        const stat = await fs.lstat(probe);
        if (stat.isSymbolicLink()) return true;
      } catch {
        // Nonexistent component: keep walking up.
      }
      prev = probe;
      probe = path.dirname(probe);
    }
    const parentReal = await fs.realpath(path.dirname(target)).catch(() => path.dirname(target));
    const contained = parentReal === worktreeReal || parentReal.startsWith(worktreeReal + path.sep);
    return !contained;
  };
  try {
    if (await symlinkEscape()) {
      return { restored: false, reason: "symlinked path refused" };
    }
    const content = await fs.readFile(source);
    await fs.mkdir(path.dirname(target), { recursive: true });
    await fs.writeFile(target, content);
    return { restored: true };
  } catch (err: unknown) {
    // A file absent from the authoritative root means the worktree copy
    // should not exist at all: delete it to restore parity.
    try {
      await fs.access(source);
    } catch {
      try {
        await fs.unlink(target);
        return { restored: true };
      } catch {
        return {
          restored: false,
          reason: "authoritative copy absent and worktree copy could not be removed",
        };
      }
    }
    const message = err instanceof Error ? err.message : String(err);
    return { restored: false, reason: message };
  }
}

/** Human-readable feedback block for enforce-mode verification failure. */
export function formatIntegrityFeedback(result: MachineryIntegrityResult): string {
  const lines = result.mismatches.map((mismatch) => `  - ${mismatch.path} (${mismatch.reason})`);
  return [
    "MACHINERY INTEGRITY CHECK FAILED: the following verification-",
    "controlling files differ from the authoritative project copies.",
    "Verification will not run until they are restored. Use the",
    "restore_machinery tool with each path below to restore the",
    "authoritative version (git checkout/reset are not available):",
    ...lines,
  ].join("\n");
}
