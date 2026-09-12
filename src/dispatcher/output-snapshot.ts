import * as fs from "node:fs/promises";
import * as path from "node:path";

import type { ProjectAdapter } from "../core/adapter-loader.js";
import {
  evaluateSealConformance,
  type SealConformanceSummary,
} from "../judgment/producers/seal-conformance.js";
import {
  scanForSecrets,
  type SecretScanFileInput,
  type SecretScanSummary,
} from "../judgment/producers/secret-scan.js";
import type {
  AgentOutputSnapshot,
  AgentOutputSnapshotFile,
  AgentOutputSnapshotKind,
} from "../core/types.js";
import type { IEventWriter } from "../monitor/event-emitter.js";
import { runTrustedGitResult } from "../worker/trusted-executable.js";

const MAX_BUFFER = 10 * 1024 * 1024;
const GIT_TIMEOUT_MS = 30_000;
const FULL_GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;

let evidenceRefsResolvedHook: (() => Promise<void>) | undefined;

/** @internal Test seam for deterministic ref/worktree race coverage. */
export function _setOutputSnapshotEvidenceRefsResolvedHook(
  hook: (() => Promise<void>) | undefined,
): void {
  evidenceRefsResolvedHook = hook;
}

export interface SealAgentOutputInput {
  taskId: string;
  adapter: ProjectAdapter;
  events: IEventWriter;
  attempt: number;
  kind: AgentOutputSnapshotKind;
  diffBase?: string;
  branchName?: string;
  claudeSessionId?: string;
}

interface GitResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

async function runGit(
  args: readonly string[],
  cwd: string,
  options: {
    allowFailure?: boolean;
    trustedLocalReadRemotePaths?: readonly string[];
  } = {},
): Promise<GitResult> {
  try {
    const result = await runTrustedGitResult(cwd, args, {
      timeoutMs: GIT_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER,
      ...(options.trustedLocalReadRemotePaths
        ? { trustedLocalReadRemotePaths: options.trustedLocalReadRemotePaths }
        : {}),
    });
    if (result.exitCode === 0 || options.allowFailure) return result;
    throw new Error(result.stderr || result.stdout || "git command failed");
  } catch (err: unknown) {
    if (options.allowFailure) {
      return { exitCode: 1, stdout: "", stderr: String(err) };
    }
    throw err;
  }
}

function normalizeRepoPath(filePath: string): string {
  return filePath.replace(/\\/g, "/").replace(/^\.\/+/, "");
}

function stripOuterQuotes(value: string): string {
  if (value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1);
  }
  return value;
}

// ── Git short-format path parsing (TASK-1314 round-2 F1) ────────────
// Git C-quotes paths containing spaces/non-ASCII (`"new name.txt"`,
// octal UTF-8 byte escapes like `\303\251`). The old parser stripped
// the OUTERMOST quotes of the whole remainder before the rename split,
// leaving a stray quote on rename destinations, and the backslash
// normalize corrupted octal escapes into separators. This parser reads
// quote-aware tokens and decodes C-escapes to real bytes, so the
// progress check and the seal staging classify the same REAL paths.

const C_ESCAPE_MAP: Record<string, number> = {
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  "\\": 0x5c,
  '"': 0x22,
};

/** Decode the CONTENTS of a git C-quoted string (between the quotes). */
function decodeCQuoted(contents: string): string {
  const bytes: number[] = [];
  for (let i = 0; i < contents.length; i++) {
    const ch = contents[i];
    if (ch !== "\\") {
      for (const byte of Buffer.from(ch, "utf8")) bytes.push(byte);
      continue;
    }
    const next = contents[i + 1];
    if (next !== undefined && next >= "0" && next <= "7") {
      let octal = "";
      while (octal.length < 3) {
        const digit = contents[i + 1 + octal.length];
        if (digit === undefined || digit < "0" || digit > "7") break;
        octal += digit;
      }
      bytes.push(parseInt(octal, 8) & 0xff);
      i += octal.length;
      continue;
    }
    if (next !== undefined && next in C_ESCAPE_MAP) {
      bytes.push(C_ESCAPE_MAP[next]);
      i += 1;
      continue;
    }
    // Unknown escape: keep the character literally.
    if (next !== undefined) {
      for (const byte of Buffer.from(next, "utf8")) bytes.push(byte);
      i += 1;
    }
  }
  return Buffer.from(bytes).toString("utf8");
}

/**
 * Read one path token from a status remainder starting at `start`.
 * Quoted tokens end at the closing unescaped quote; unquoted tokens run
 * to the ` -> ` rename separator or end of line (git quotes any name
 * containing spaces, so an unquoted token never contains the arrow).
 * Returns the decoded path and the index just past the token.
 */
function readGitPathToken(text: string, start: number): [string, number] {
  if (text[start] === '"') {
    let i = start + 1;
    while (i < text.length) {
      if (text[i] === "\\") {
        i += 2;
        continue;
      }
      if (text[i] === '"') break;
      i += 1;
    }
    return [decodeCQuoted(text.slice(start + 1, i)), Math.min(i + 1, text.length)];
  }
  const arrowIdx = text.indexOf(" -> ", start);
  const end = arrowIdx === -1 ? text.length : arrowIdx;
  return [text.slice(start, end), end];
}

interface StatusPaths {
  path: string;
  previousPath?: string;
  isRename: boolean;
  statusCode: string;
}

function statusPaths(line: string): StatusPaths | undefined {
  const remainder = line.slice(3);
  const [first, next] = readGitPathToken(remainder, 0);
  let destination = first;
  let previousPath: string | undefined;
  if (remainder.startsWith(" -> ", next)) {
    previousPath = normalizeRepoPath(first.trim());
    [destination] = readGitPathToken(remainder, next + 4);
  }
  const trimmed = destination.trim();
  if (!trimmed) return undefined;
  return {
    path: normalizeRepoPath(trimmed),
    ...(previousPath ? { previousPath } : {}),
    isRename: Boolean(previousPath && line.slice(0, 2).includes("R")),
    statusCode: line.slice(0, 2),
  };
}

const EXCLUDED_EXACT_PATHS = new Set([
  "PROGRESS.md",
  ".quack",
  ".quack/",
  ".quack/prep",
  ".quack/runtime-prep",
  ".quack/logs",
  ".quack/workflows",
  ".quack/workflow-projections",
  ".quack/local-test-runs",
  ".quack/runtime-logs",
  ".quack/worktrees",
  ".quack/evidence",
  ".quack/analytics",
  ".quack/federation",
  ".quack/reviews",
  ".quack/verify-worktrees",
  ".quack/verified.json",
  ".quack/quack.db",
  ".quack/quack.db-shm",
  ".quack/quack.db-wal",
  ".quack/tier3-merge-count.json",
]);

const EXCLUDED_PREFIXES = [
  ".quack/prep/",
  ".quack/runtime-prep/",
  ".quack/logs/",
  ".quack/workflows/",
  ".quack/workflow-projections/",
  ".quack/local-test-runs/",
  ".quack/runtime-logs/",
  ".quack/worktrees/",
  ".quack/evidence/",
  ".quack/analytics/",
  ".quack/federation/",
  ".quack/reviews/",
  ".quack/verify-worktrees/",
];

function isExcludedOutputPath(filePath: string): boolean {
  const normalized = normalizeRepoPath(filePath);
  return (
    EXCLUDED_EXACT_PATHS.has(normalized) ||
    EXCLUDED_PREFIXES.some((prefix) => normalized.startsWith(prefix))
  );
}

function parseChangedFiles(nameStatus: string): AgentOutputSnapshotFile[] {
  return nameStatus
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parts = line.split("\t").map((part) => stripOuterQuotes(part.trim()));
      const status = parts[0] ?? "";
      if (status.startsWith("R") || status.startsWith("C")) {
        return {
          status,
          previousPath: normalizeRepoPath(parts[1] ?? ""),
          path: normalizeRepoPath(parts[2] ?? parts[1] ?? ""),
        };
      }
      return {
        status,
        path: normalizeRepoPath(parts[1] ?? parts[0] ?? ""),
      };
    })
    .filter((entry) => entry.path.length > 0);
}

/**
 * Classify `git status --short` lines into sealer-included vs excluded
 * (transient) paths. Exported for TASK-1314: the dispatcher's resume
 * progress check reuses THIS classification so "progress worth
 * resuming" and "work the sealer would commit" share one definition.
 */
export function parseStatus(statusShort: string): {
  included: string[];
  includedToStage: string[];
  excluded: string[];
  mixedPolicyRenames: Array<{ previousPath: string; path: string }>;
} {
  const included: string[] = [];
  const includedToStage: string[] = [];
  const excluded: string[] = [];
  const mixedPolicyRenames: Array<{ previousPath: string; path: string }> = [];
  for (const line of statusShort.split(/\r?\n/)) {
    if (!line.trim()) continue;
    const paths = statusPaths(line);
    if (!paths) continue;
    if (paths.isRename && paths.previousPath) {
      const previousExcluded = isExcludedOutputPath(paths.previousPath);
      const destinationExcluded = isExcludedOutputPath(paths.path);
      if (previousExcluded !== destinationExcluded) {
        mixedPolicyRenames.push({ previousPath: paths.previousPath, path: paths.path });
        excluded.push(paths.previousPath, paths.path);
      } else if (destinationExcluded) {
        excluded.push(paths.previousPath, paths.path);
      } else {
        // `git commit --only` needs both endpoints to record the deletion and
        // addition as one rename. Destination-only silently leaves the old
        // path staged and seals an incomplete change.
        included.push(paths.previousPath, paths.path);
        if (paths.statusCode[1] !== " ") includedToStage.push(paths.path);
      }
    } else if (isExcludedOutputPath(paths.path)) {
      excluded.push(paths.path);
    } else {
      included.push(paths.path);
      if (paths.statusCode === "??" || paths.statusCode[1] !== " ") {
        includedToStage.push(paths.path);
      }
    }
  }
  return {
    included: [...new Set(included)],
    includedToStage: [...new Set(includedToStage)],
    excluded: [...new Set(excluded)],
    mixedPolicyRenames,
  };
}

function safeSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "-");
}

const SECRET_SCAN_MAX_FILE_BYTES = 512 * 1024;

export interface SecretScanInputsResult {
  inputs: SecretScanFileInput[];
  /** Added/renamed/copied binary files that could not be text-scanned. */
  unscannedBinaries: string[];
  /** Files whose complete contents could not be inspected safely. */
  unscannedSafetyFiles: Array<{ path: string; reason: "oversized" | "unreadable" }>;
}

/**
 * Build secret-scan inputs (TASK-1312 Producer C): per-file added diff
 * lines PLUS full contents of added/renamed/copied text files from the
 * immutable sealed commit. Rename-only changes carry no added hunks, so the
 * blob itself is required. Quoted `diff --git` headers (core.quotepath) are
 * unquoted. Oversized or unreadable blobs surface as safety facts; binary
 * blobs surface in `unscannedBinaries` for human review. Exported for tests.
 */
export async function buildSecretScanInputs(
  gitDiff: string,
  nameStatus: AgentOutputSnapshotFile[],
  cwd: string,
  sealedCommitSha: string,
): Promise<SecretScanInputsResult> {
  if (!FULL_GIT_OBJECT_ID.test(sealedCommitSha)) {
    throw new Error("Secret scan requires an immutable sealed commit identity");
  }
  const inputs: SecretScanFileInput[] = [];
  const unscannedBinaries: string[] = [];
  const unscannedSafetyFiles: SecretScanInputsResult["unscannedSafetyFiles"] = [];

  let currentFile: string | null = null;
  let added: string[] = [];
  const flush = (): void => {
    if (currentFile && added.length > 0) {
      inputs.push({ file: currentFile, content: added.join("\n") });
    }
    added = [];
  };
  for (const line of gitDiff.split(/\r?\n/)) {
    const header = /^diff --git "?a\/.*?"? "?b\/(.+?)"?$/.exec(line);
    if (header) {
      flush();
      currentFile = header[1];
      continue;
    }
    if (line.startsWith("+") && !line.startsWith("+++")) {
      added.push(line.slice(1));
    }
  }
  flush();

  for (const file of nameStatus) {
    const status = file.status.charAt(0);
    if (status !== "A" && status !== "R" && status !== "C") continue;
    try {
      const object = `${sealedCommitSha}:${file.path}`;
      const sizeResult = await runGit(["cat-file", "-s", object], cwd);
      const rawSize = sizeResult.stdout.trim();
      if (!/^\d+$/.test(rawSize)) throw new Error("invalid Git blob size");
      const size = Number(rawSize);
      if (!Number.isSafeInteger(size) || size < 0) throw new Error("invalid Git blob size");
      if (size > SECRET_SCAN_MAX_FILE_BYTES) {
        unscannedSafetyFiles.push({ path: file.path, reason: "oversized" });
        continue;
      }
      const blobResult = await runGit(["cat-file", "blob", object], cwd);
      const buffer = Buffer.from(blobResult.stdout, "utf8");
      // The trusted runner decodes stdout as UTF-8. Any lossy decode changes
      // the byte count, so classify it as binary rather than scanning a
      // transformed representation as though it were complete evidence.
      if (buffer.length !== size) {
        unscannedBinaries.push(file.path);
        continue;
      }
      if (buffer.subarray(0, 8192).includes(0)) {
        unscannedBinaries.push(file.path);
        continue;
      }
      inputs.push({ file: file.path, content: buffer.toString("utf-8") });
    } catch {
      // An unreadable worker-controlled file is not equivalent to a clean
      // scan. Preserve sealing, but surface a safety-tier fact so promotion
      // cannot proceed on incomplete evidence.
      unscannedSafetyFiles.push({ path: file.path, reason: "unreadable" });
    }
  }
  return { inputs, unscannedBinaries, unscannedSafetyFiles };
}

export function resolveEvidenceProjectRoot(projectRoot: string): string {
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

async function resolveDiffRef(
  adapter: ProjectAdapter,
  diffBase?: string,
): Promise<{ diffBase: string; diffRef: string }> {
  const cwd = adapter.projectRoot;
  const base = diffBase ?? adapter.config.git.baseBranch;
  if (diffBase) return { diffBase: base, diffRef: base };

  await runGit(["fetch", "origin", `${base}:refs/remotes/origin/${base}`], cwd, {
    allowFailure: true,
    ...(adapter.trustedLocalReadRemotePaths
      ? { trustedLocalReadRemotePaths: adapter.trustedLocalReadRemotePaths }
      : {}),
  });
  const verifyRemote = await runGit(["rev-parse", "--verify", `origin/${base}`], cwd, {
    allowFailure: true,
  });
  if (verifyRemote.exitCode === 0 && verifyRemote.stdout.trim()) {
    return { diffBase: base, diffRef: `origin/${base}` };
  }

  const verifyLocal = await runGit(["rev-parse", "--verify", base], cwd, { allowFailure: true });
  if (verifyLocal.exitCode === 0 && verifyLocal.stdout.trim()) {
    return { diffBase: base, diffRef: base };
  }

  return { diffBase: base, diffRef: base };
}

async function revParse(cwd: string, ref: string): Promise<string> {
  const result = await runGit(["rev-parse", "--verify", `${ref}^{commit}`], cwd);
  const sha = result.stdout.trim();
  if (!FULL_GIT_OBJECT_ID.test(sha)) {
    throw new Error(`git rev-parse returned an invalid commit identity for ${ref}`);
  }
  return sha;
}

async function commitIncludedChanges(
  taskId: string,
  adapter: ProjectAdapter,
  includedFiles: string[],
  includedToStage: string[],
): Promise<{ filesStaged: number; message?: string; sha?: string }> {
  const cwd = adapter.projectRoot;
  if (includedFiles.length === 0) return { filesStaged: 0 };

  // Only stage paths with unstaged bytes. Already-staged rename/deletion
  // sources no longer exist in either the worktree or index, so asking `add`
  // to match them fails. They remain in includedFiles for the commit pathset.
  if (includedToStage.length > 0) {
    const add = await runGit(["add", "--all", "--", ...includedToStage], cwd, {
      allowFailure: true,
    });
    if (add.exitCode !== 0) {
      throw new Error(`git add failed for included output: ${add.stderr || add.stdout}`);
    }
  }

  // Restrict both the inventory and commit to paths classified as task output.
  // The worker may have pre-staged transient or denied evidence before sealing;
  // a plain `git commit` would silently include those unrelated index entries.
  const stagedResult = await runGit(
    ["diff", "--cached", "--name-only", "-z", "--", ...includedFiles],
    cwd,
  );
  const stagedFiles = stagedResult.stdout.split("\0").filter(Boolean);
  if (stagedFiles.length === 0) {
    return { filesStaged: 0 };
  }

  const msg = adapter.config.git.commitFormat
    .replace("{taskId}", taskId)
    .replace("{message}", "auto-commit: sealed agent output before judge");
  const fullMsg = adapter.config.git.commitTrailer
    ? `${msg}\n\n${adapter.config.git.commitTrailer}`
    : msg;
  const commit = await runGit(["commit", "--only", "-m", fullMsg, "--", ...includedFiles], cwd, {
    allowFailure: true,
  });
  if (commit.exitCode !== 0) {
    throw new Error(`git commit failed: ${commit.stderr || commit.stdout}`);
  }

  const sha = await revParse(cwd, "HEAD");
  return { filesStaged: stagedFiles.length, message: fullMsg, sha };
}

export async function sealAgentOutputAttempt(
  input: SealAgentOutputInput,
): Promise<AgentOutputSnapshot> {
  const { taskId, adapter, events, attempt, kind } = input;
  const cwd = adapter.projectRoot;
  const sealedAt = new Date().toISOString();

  events.emit("agent_output_seal_start", {
    taskId,
    attempt,
    kind,
    diffBase: input.diffBase ?? adapter.config.git.baseBranch,
  });

  try {
    const headShaBefore = await revParse(cwd, "HEAD");
    const statusBefore = (await runGit(["status", "--short"], cwd)).stdout.trimEnd();
    const { included, includedToStage, excluded, mixedPolicyRenames } = parseStatus(statusBefore);
    if (mixedPolicyRenames.length > 0) {
      const details = mixedPolicyRenames
        .map(({ previousPath, path: destination }) => `${previousPath} -> ${destination}`)
        .join(", ");
      throw new Error(`Refusing to seal rename across the output inclusion boundary: ${details}`);
    }
    const commitResult = await commitIncludedChanges(taskId, adapter, included, includedToStage);
    if (commitResult.filesStaged > 0 && commitResult.message) {
      events.emit("auto_commit", {
        filesStaged: commitResult.filesStaged,
        commitMessage: commitResult.message,
      });
    }

    const headShaAfter = await revParse(cwd, "HEAD");
    const { diffBase, diffRef } = await resolveDiffRef(adapter, input.diffBase);
    const baseSha = await revParse(cwd, diffRef);
    await evidenceRefsResolvedHook?.();
    const evidenceRange = `${baseSha}...${headShaAfter}`;
    // These three views form the complete sealed evidence used by the policy
    // and secret scanners. A failed command (including maxBuffer truncation)
    // is not an empty/partial diff and must abort the seal. Use immutable
    // commit identities so a concurrent ref move cannot split the views.
    const diffResult = await runGit(["diff", evidenceRange], cwd);
    const statResult = await runGit(["diff", "--stat", evidenceRange], cwd);
    const nameStatusResult = await runGit(
      // Explicit rename/copy detection (round-2): rename-only changes
      // must surface as R records so the secret scan reads their content.
      ["diff", "--name-status", "--find-renames", "--find-copies", evidenceRange],
      cwd,
    );
    const gitDiff = diffResult.stdout.trim();
    const diffStat = statResult.stdout.trim();
    const nameStatus = parseChangedFiles(nameStatusResult.stdout);
    const changedFiles = [...new Set(nameStatus.map((file) => file.path))].sort();

    // TASK-1312 Producers C + D: observational conformance + secret scan
    // over the sealed change-set. Must never break sealing — any failure
    // degrades to "no producer data" rather than a seal error.
    let sealConformance: SealConformanceSummary | undefined;
    let secretScan: SecretScanSummary | undefined;
    try {
      sealConformance = evaluateSealConformance({
        changedFiles: nameStatus.map((file) => ({
          path: file.path,
          status: file.status,
        })),
        sandbox: adapter.config.sandbox,
        activeSpecPrefix: `${adapter.config.project.taskDir.replace(/\\/g, "/").replace(/\/+$/, "")}/${taskId}`,
      });
      const scanInputs = await buildSecretScanInputs(gitDiff, nameStatus, cwd, headShaAfter);
      secretScan = scanForSecrets(scanInputs.inputs);
      // Round-2 F11: bound the carried arrays — checkpoints serialize the
      // whole snapshot, so producer blocks are capped (full detail stays
      // in the manifest-adjacent evidence, counts stay exact).
      const FACT_CAP = 200;
      if (sealConformance && sealConformance.facts.length > FACT_CAP) {
        sealConformance = {
          ...sealConformance,
          facts: sealConformance.facts.slice(0, FACT_CAP),
        };
      }
      if (secretScan.findings.length > FACT_CAP) {
        secretScan = {
          ...secretScan,
          findings: secretScan.findings.slice(0, FACT_CAP),
        };
      }
      for (const binaryPath of scanInputs.unscannedBinaries) {
        secretScan.findings.push({
          kind: "secret",
          tier: "human_review",
          patternId: "binary_file_unscanned",
          file: binaryPath,
          maskedExcerpt: "(binary file — not text-scanned)",
        });
        secretScan.humanReviewCount++;
      }
      for (const unscanned of scanInputs.unscannedSafetyFiles) {
        secretScan.findings.push({
          kind: "secret",
          tier: "safety",
          patternId: `${unscanned.reason}_file_unscanned`,
          file: unscanned.path,
          maskedExcerpt: `(${unscanned.reason} file — complete secret scan unavailable)`,
          candidateSafetyCode: "secret_exposure",
        });
        secretScan.safetyCount++;
      }
    } catch {
      sealConformance = undefined;
      secretScan = undefined;
    }

    const evidenceRoot = path.join(
      resolveEvidenceProjectRoot(adapter.projectRoot),
      ".quack",
      "evidence",
      taskId,
      safeSegment(events.sessionId),
      `attempt-${String(attempt).padStart(2, "0")}-${safeSegment(kind)}`,
    );
    await fs.mkdir(evidenceRoot, { recursive: true });

    const manifestPath = path.join(evidenceRoot, "manifest.json");
    const diffPath = path.join(evidenceRoot, "diff.patch");
    const statusPath = path.join(evidenceRoot, "status.txt");
    const nameStatusPath = path.join(evidenceRoot, "name-status.txt");

    const snapshot: AgentOutputSnapshot = {
      taskId,
      attempt,
      kind,
      sealedAt,
      diffBase,
      diffRef,
      baseSha,
      headShaBefore,
      headShaAfter,
      sealedCommitSha: commitResult.sha,
      branchName: input.branchName,
      worktreePath: cwd,
      manifestPath,
      diffPath,
      statusPath,
      nameStatusPath,
      gitDiff,
      diffStat,
      statusShort: statusBefore,
      changedFiles,
      nameStatus,
      filesStaged: commitResult.filesStaged,
      excludedFiles: excluded,
      claudeSessionId: input.claudeSessionId,
      empty: gitDiff.length === 0,
      ...(sealConformance ? { sealConformance } : {}),
      ...(secretScan ? { secretScan } : {}),
    };

    await fs.writeFile(diffPath, gitDiff + (gitDiff ? "\n" : ""), "utf-8");
    await fs.writeFile(statusPath, statusBefore + (statusBefore ? "\n" : ""), "utf-8");
    await fs.writeFile(
      nameStatusPath,
      nameStatusResult.stdout.trim() + (nameStatusResult.stdout.trim() ? "\n" : ""),
      "utf-8",
    );
    await fs.writeFile(manifestPath, JSON.stringify(snapshot, null, 2) + "\n", "utf-8");

    if (sealConformance) {
      // Best-effort emission (round-2): a failed event write must never
      // convert an already-created seal into a seal failure.
      try {
        events.emit("seal_conformance", {
          taskId,
          attempt,
          kind,
          tierSCount: sealConformance.tierSCount,
          tierRCount: sealConformance.tierRCount,
          deniedPathCount: sealConformance.deniedPathCount,
          outsideWritableCount: sealConformance.outsideWritableCount,
          cleanCount: sealConformance.cleanCount,
          facts: sealConformance.facts,
          secretScan: {
            safetyCount: secretScan?.safetyCount ?? 0,
            humanReviewCount: secretScan?.humanReviewCount ?? 0,
          },
        });
      } catch {
        // Observational producer emission is never seal-fatal.
      }
    }

    events.emit("agent_output_sealed", {
      taskId,
      attempt,
      kind,
      sealedCommitSha: commitResult.sha,
      baseSha,
      headSha: headShaAfter,
      changedFiles,
      filesStaged: commitResult.filesStaged,
      excludedFiles: excluded,
      manifestPath,
      diffPath,
      diffLines: gitDiff ? gitDiff.split(/\r?\n/).length : 0,
    });

    return snapshot;
  } catch (err: unknown) {
    const error = err instanceof Error ? err.message : String(err);
    events.emit("agent_output_seal_failed", {
      taskId,
      attempt,
      kind,
      error,
    });
    events.emit("session_error", {
      error: `Agent output seal failed: ${error}`,
      failedStage: "agent_output_seal",
    });
    throw new Error(`Agent output seal failed: ${error}`);
  }
}
