import * as fs from "node:fs";
import * as path from "node:path";
import { runTrustedGitSync } from "../dispatcher/trusted-git.js";

export class UnsafeWorktreeRuntimeError extends Error {
  constructor(message: string) {
    super(`Unsafe worktree runtime directories: ${message}`);
    this.name = "UnsafeWorktreeRuntimeError";
  }
}

function statIfPresent(candidate: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(candidate);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new UnsafeWorktreeRuntimeError(`cannot inspect ${candidate}: ${String(error)}`);
  }
}

function contains(parent: string, candidate: string): boolean {
  const relative = path.relative(parent, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`))
  );
}

function sameLocation(left: string, right: string): boolean {
  return path.relative(fs.realpathSync(left), fs.realpathSync(right)) === "";
}

function assertDirectory(candidate: string): void {
  const stat = statIfPresent(candidate);
  if (!stat?.isDirectory() || stat.isSymbolicLink()) {
    throw new UnsafeWorktreeRuntimeError(`expected a real directory at ${candidate}`);
  }
}

function ensureRealParents(root: string, candidate: string): void {
  if (!contains(root, candidate) || path.relative(root, candidate) === "") {
    throw new UnsafeWorktreeRuntimeError(`link escapes or replaces worktree ${root}`);
  }
  assertDirectory(root);
  let current = root;
  for (const segment of path
    .relative(root, path.dirname(candidate))
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    if (!statIfPresent(current)) fs.mkdirSync(current);
    assertDirectory(current);
  }
}

function ensureIgnored(worktree: string, relative: string): void {
  try {
    runTrustedGitSync(
      ["check-ignore", "--quiet", "--", relative.split(path.sep).join("/")],
      worktree,
    );
  } catch {
    throw new UnsafeWorktreeRuntimeError(
      `log path ${relative} must be ignored by Git before dispatch`,
    );
  }
}

function ensureLink(root: string, destination: string, target: string): void {
  ensureRealParents(root, destination);
  const existing = statIfPresent(destination);
  if (existing) {
    if (!existing.isSymbolicLink()) {
      throw new UnsafeWorktreeRuntimeError(`refusing to replace real path ${destination}`);
    }
    try {
      if (sameLocation(destination, target)) return;
    } catch {
      // A dangling or unreadable link cannot prove the intended target.
    }
    throw new UnsafeWorktreeRuntimeError(
      `existing link ${destination} has a different or unreadable target`,
    );
  }
  fs.symlinkSync(target, destination, "junction");
}

function bindingPath(worktree: string): string {
  return path.join(path.dirname(worktree), `${path.basename(worktree)}.runtime-log.json`);
}

/** Host-side evidence of native origin, outside the container workspace mount.
 * An invalid receipt must preserve the tree instead of granting a wider sweep. */
export function hasNativeWorktreeBinding(worktreePath: string): boolean {
  const worktree = path.resolve(worktreePath);
  const receipt = bindingPath(worktree);
  const stat = statIfPresent(receipt);
  if (!stat) return false;
  try {
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 64 * 1024) {
      throw new Error("not a bounded regular receipt");
    }
    const binding = JSON.parse(fs.readFileSync(receipt, "utf8")) as {
      worktreePath?: unknown;
      logDir?: unknown;
    } | null;
    if (
      binding?.worktreePath !== worktree ||
      typeof binding.logDir !== "string" ||
      !path.isAbsolute(binding.logDir)
    ) {
      throw new Error("binding identity mismatch");
    }
    return true;
  } catch {
    throw new UnsafeWorktreeRuntimeError(`invalid log binding receipt ${receipt}`);
  }
}

export interface NativeRuntimeDirectories {
  projectRoot: string;
  worktreePath: string;
  logDir: string;
  configuredLogDir?: string;
  prepDir: string;
  reused?: boolean;
}

export function prepareNativeRuntimeDirectories(options: NativeRuntimeDirectories): void {
  try {
    prepareDirectories(options);
  } catch (error) {
    if (error instanceof UnsafeWorktreeRuntimeError) throw error;
    throw new UnsafeWorktreeRuntimeError(`cannot establish log topology: ${String(error)}`);
  }
}

function prepareDirectories(options: NativeRuntimeDirectories): void {
  const project = path.resolve(options.projectRoot);
  const worktree = path.resolve(options.worktreePath);
  const logs = path.resolve(project, options.logDir);
  const worktreeRoot = path.join(project, ".quack", "worktrees");
  if (path.dirname(worktree) !== worktreeRoot) {
    throw new UnsafeWorktreeRuntimeError(`not an immediate managed worktree: ${worktree}`);
  }
  assertDirectory(worktreeRoot);
  assertDirectory(worktree);
  const relative = path.relative(project, logs);
  const internal = contains(project, logs);
  if (
    contains(logs, worktreeRoot) ||
    contains(worktreeRoot, logs) ||
    contains(path.join(project, ".git"), logs) ||
    contains(logs, options.prepDir) ||
    contains(options.prepDir, logs)
  ) {
    throw new UnsafeWorktreeRuntimeError(
      `log path aliases project metadata, worktrees or prep: ${logs}`,
    );
  }
  if (!internal && options.configuredLogDir && !path.isAbsolute(options.configuredLogDir)) {
    throw new UnsafeWorktreeRuntimeError(
      "parent-relative external log paths change meaning in a worktree; configure an absolute path",
    );
  }
  const mirroredLogs = internal ? path.join(worktree, relative) : undefined;
  if (mirroredLogs) ensureIgnored(worktree, relative);

  const receipt = bindingPath(worktree);
  const receiptStat = statIfPresent(receipt);
  if (receiptStat) {
    if (!receiptStat.isFile() || receiptStat.isSymbolicLink()) {
      throw new UnsafeWorktreeRuntimeError(`invalid log binding receipt ${receipt}`);
    }
    let binding: { worktreePath?: unknown; logDir?: unknown };
    try {
      binding = JSON.parse(fs.readFileSync(receipt, "utf8")) as typeof binding;
    } catch {
      throw new UnsafeWorktreeRuntimeError(`unreadable log binding receipt ${receipt}`);
    }
    if (binding.worktreePath !== worktree || binding.logDir !== logs) {
      throw new UnsafeWorktreeRuntimeError(
        "configured log location changed; preserve the existing run and restore its original log configuration before resuming",
      );
    }
  } else if (options.reused) {
    // A legacy worktree may be adopted only when its existing mirror proves
    // where its run state lives. Missing evidence is not permission to relocate it.
    const existing = mirroredLogs ? statIfPresent(mirroredLogs) : undefined;
    let matches = false;
    try {
      matches = Boolean(
        mirroredLogs && existing?.isSymbolicLink() && sameLocation(mirroredLogs, logs),
      );
    } catch {
      // Dangling legacy links cannot establish the prior run's identity.
    }
    if (!matches) {
      throw new UnsafeWorktreeRuntimeError(
        "existing worktree has no verifiable log binding; preserve it for recovery",
      );
    }
  }

  fs.mkdirSync(logs, { recursive: true });
  if (mirroredLogs) ensureLink(worktree, mirroredLogs, logs);
  const mirroredPrep = path.join(worktree, ".quack", "prep");
  if (fs.existsSync(options.prepDir)) {
    ensureLink(worktree, mirroredPrep, options.prepDir);
  } else if (statIfPresent(mirroredPrep)) {
    throw new UnsafeWorktreeRuntimeError(
      "worktree prep path exists without its authoritative source",
    );
  }
  if (!receiptStat) {
    fs.writeFileSync(receipt, JSON.stringify({ worktreePath: worktree, logDir: logs }), {
      flag: "wx",
    });
  }
}

/** Called only after the manager's ownership/recovery checks and before Git or
 * filesystem removal. Never follow a reparse point, even after config changes. */
export function unlinkNativeWorktreeLinks(worktreePath: string): void {
  const root = path.resolve(worktreePath);
  if (!statIfPresent(root)) return;
  assertDirectory(root);
  const visit = (directory: string): void => {
    for (const name of fs.readdirSync(directory)) {
      const candidate = path.join(directory, name);
      const stat = statIfPresent(candidate);
      if (!stat) continue;
      if (stat.isSymbolicLink()) fs.unlinkSync(candidate);
      else if (stat.isDirectory()) visit(candidate);
    }
  };
  try {
    visit(root);
    const receipt = bindingPath(root);
    if (statIfPresent(receipt)) fs.unlinkSync(receipt);
  } catch (error) {
    throw new UnsafeWorktreeRuntimeError(
      `link cleanup failed; preserving worktree: ${String(error)}`,
    );
  }
}
