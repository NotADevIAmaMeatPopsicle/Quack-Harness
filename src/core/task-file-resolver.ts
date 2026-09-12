import * as fs from "node:fs/promises";
import * as fsSync from "node:fs";
import * as path from "node:path";

import { groupTaskClaimantsByDeclaredId } from "./duplicate-claimants.js";
import { matchTaskHeading, parseTaskFile } from "./task-parser.js";
import type { ParsedTask } from "./types.js";

export interface ResolvedTaskFile {
  fileName: string;
  filePath: string;
  content: string;
  task: ParsedTask | null;
  /** Sorted only when this candidate population has multiple declarations. */
  duplicateClaimants: string[];
}

// Identity ownership follows parseable declarations, not filenames. A
// differently named Markdown file can still claim a task id and must prevent
// writes/dispatches that assume the id has one canonical owner. Non-task
// documents simply fail parsing and are ignored.
const TASK_DECLARATION_FILE_PATTERN = /\.md$/i;

/** The one candidate predicate. Both the async and sync listers use it so
 *  they cannot drift (TASK-1332 round 7). */
function isCandidateName(entry: string, taskId: string): boolean {
  const normalizedTaskId = taskId.trim().toLowerCase();
  const normalizedEntry = entry.toLowerCase();
  return (
    normalizedEntry === `${normalizedTaskId}.md` ||
    (normalizedEntry.startsWith(`${normalizedTaskId}-`) && normalizedEntry.endsWith(".md"))
  );
}

/**
 * The one entry-TYPE policy, for the same reason (TASK-1332 round 8, R8-2).
 *
 * Round 7's sync twin filtered with `isFile()` while the async lister
 * filtered nothing, so the two disagreed on symlinks: on the Linux
 * headnode a symlinked `TASK-100.md` is listed and followed by `readFile`
 * on the async path and EXCLUDED by `isFile()` on the sync one. The
 * dispatcher would load it while identity resolution returned UNKNOWN,
 * which silently disables the pre-gate divergence check, a fail-open,
 * because UNKNOWN never blocks.
 *
 * Symlinks are ACCEPTED, matching what `readFile` has always done, so this
 * changes no dispatcher behaviour; directories are rejected, which only
 * removes entries that would have thrown on read anyway.
 */
function isCandidateEntry(entry: { isFile(): boolean; isSymbolicLink(): boolean }): boolean {
  return entry.isFile() || entry.isSymbolicLink();
}

export async function listTaskFileCandidates(taskDir: string, taskId: string): Promise<string[]> {
  try {
    return (await fs.readdir(taskDir, { withFileTypes: true }))
      .filter((entry) => isCandidateEntry(entry) && isCandidateName(entry.name, taskId))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * TASK-1332 round 7 (R7-1): the SYNC twin, added here rather than
 * reimplemented by the caller.
 *
 * `resolveCurrentSpecIdentity` is synchronous and is called inline in
 * argument position at every approval creation site, so it cannot await.
 * Round 6 had it reach for `pickBestRawTaskFileCandidate` alone, which is
 * only the FALLBACK half of what the dispatcher does, the dispatcher
 * parses candidates and matches `task.id` FIRST. That divergence is a
 * false refusal: with a descriptive file whose H1 names a different task,
 * the dispatcher loads the exact file while the identity check hashed the
 * descriptive one.
 *
 * Two resolvers with two answers is the defect this series keeps paying
 * for, so the algorithm lives here, once, and the sync path is a twin of
 * the async one rather than a second opinion.
 */
export function listTaskFileCandidatesSync(taskDir: string, taskId: string): string[] {
  try {
    return fsSync
      .readdirSync(taskDir, { withFileTypes: true })
      .filter((entry) => isCandidateEntry(entry) && isCandidateName(entry.name, taskId))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
}

/**
 * Find a contested declared id across the full TaskService filename
 * population. This is a directory query, not a resolver hot-path helper.
 */
export async function listDuplicateClaimants(taskDir: string, taskId: string): Promise<string[]> {
  let declarations: Array<{ fileName: string; declaredId: string }>;
  try {
    declarations = await listTaskClaimantDeclarations(taskDir);
  } catch {
    return [];
  }

  const requestedId = taskId.trim().toUpperCase();
  const claimants = groupTaskClaimantsByDeclaredId(declarations).get(requestedId) ?? [];
  return claimants.length > 1 ? [...claimants].sort() : [];
}

/**
 * Synchronous full-directory twin for identity resolution. Directory-read
 * failure intentionally returns no duplicate claimants: the parsed resolver
 * immediately enumerates the same directory and degrades to the existing
 * not-found/unverifiable result. Recorder writes instead use the strict
 * unavailable index and fail closed.
 */
export function listDuplicateClaimantsSync(taskDir: string, taskId: string): string[] {
  let declarations: Array<{ fileName: string; declaredId: string }>;
  try {
    declarations = listTaskClaimantDeclarationsSync(taskDir);
  } catch {
    return [];
  }

  const requestedId = taskId.trim().toUpperCase();
  const claimants = groupTaskClaimantsByDeclaredId(declarations).get(requestedId) ?? [];
  return claimants.length > 1 ? [...claimants].sort() : [];
}

/**
 * Produce every parseable task declaration from one directory enumeration.
 * Directory access failures are intentionally observable so strict consumers
 * can fail closed. Individual unreadable or unparseable candidates still do
 * not declare an id, matching listDuplicateClaimants.
 */
export async function listTaskClaimantDeclarations(
  taskDir: string,
): Promise<Array<{ fileName: string; declaredId: string }>> {
  const entries: fsSync.Dirent[] = await fs.readdir(taskDir, { withFileTypes: true });

  const declarations: Array<{ fileName: string; declaredId: string }> = [];
  for (const entry of entries) {
    if (!isCandidateEntry(entry) || !TASK_DECLARATION_FILE_PATTERN.test(entry.name)) {
      continue;
    }

    const filePath = path.join(taskDir, entry.name);
    try {
      const content = await fs.readFile(filePath, "utf-8");
      declarations.push({
        fileName: entry.name,
        declaredId: parseTaskFile(content, filePath).id,
      });
    } catch {
      // Unreadable and unparseable files do not declare an id.
    }
  }

  return declarations;
}

/** Synchronous twin of {@link listTaskClaimantDeclarations}. */
export function listTaskClaimantDeclarationsSync(
  taskDir: string,
): Array<{ fileName: string; declaredId: string }> {
  const entries = fsSync.readdirSync(taskDir, { withFileTypes: true });
  const declarations: Array<{ fileName: string; declaredId: string }> = [];

  for (const entry of entries) {
    if (!isCandidateEntry(entry) || !TASK_DECLARATION_FILE_PATTERN.test(entry.name)) {
      continue;
    }

    const filePath = path.join(taskDir, entry.name);
    try {
      const content = fsSync.readFileSync(filePath, "utf-8");
      declarations.push({
        fileName: entry.name,
        declaredId: parseTaskFile(content, filePath).id,
      });
    } catch {
      // Unreadable and unparseable files do not declare an id.
    }
  }

  return declarations;
}

/** Sync twin of {@link resolveParsedTaskFile}: parsed-first, id-matched. */
/**
 * Is this filename an unambiguous PARENT spec for `taskId`?
 *
 * Exported (TASK-1332 round 10, R10-1) because the raw fallback and the
 * spec-identity resolver both need it and had two copies of the rule. The
 * fallback previously accepted whatever the loose picker returned, so with
 * only an UNPARSEABLE `TASK-100-A-child.md` present a request for
 * `TASK-100` resolved to the child, and `taskExists` then read that as
 * proof the parent exists, permitting an on-merge SOFT-VERIFIED record for
 * a task with no spec.
 */
export function isParentTaskFileName(taskId: string, fileName: string): boolean {
  const id = taskId.trim().toUpperCase();
  const upper = path.basename(fileName).toUpperCase();
  if (upper === `${id}.MD`) return true;
  if (!upper.startsWith(`${id}-`)) return false;
  // A subtask suffix (`-A`, `-B`, ...) is not the parent.
  return !/^[A-Z](?:-|\.MD$)/.test(upper.slice(id.length + 1));
}

export function pickBestRawTaskFileCandidate(taskId: string, candidates: string[]): string | null {
  const normalizedTaskId = taskId.trim().toLowerCase();
  const canonicalTaskId = taskId.trim().toUpperCase();
  const baseTaskMatch = canonicalTaskId.match(/^(TASK-\d+)$/);

  if (baseTaskMatch) {
    const canonicalParent = candidates.find((candidate) => {
      if (!candidate.toUpperCase().startsWith(`${canonicalTaskId}-`)) {
        return false;
      }

      const remainder = candidate.slice(canonicalTaskId.length + 1);
      return !/^[A-Z](?:-|\.md$)/.test(remainder);
    });
    if (canonicalParent) return canonicalParent;
  }

  const exactMatch = candidates.find((candidate) => {
    const normalizedCandidate = candidate.toLowerCase();
    return (
      normalizedCandidate === `${normalizedTaskId}.md` ||
      normalizedCandidate.startsWith(`${normalizedTaskId}-`)
    );
  });
  return exactMatch ?? null;
}

/**
 * Candidates split into the only three things they can be
 * (TASK-1332 round 9, R9-1).
 *
 * Round 8 stopped a MISMATCHED parse being returned as `task`, and left
 * the same file being returned as `filePath`, which `resolveTaskFilePath`
 * hands to routes that then REWRITE it under the requested id. So
 * `/v1/tasks/TASK-100/enrichment-candidates` could atomically replace
 * `TASK-100-A-child.md` and commit it as TASK-100. Fixing the field and
 * not the path is this series' recurring mechanism once more: one
 * producer moved, the other kept the retired answer.
 *
 * The classification is the fix, because it removes the wrong file from
 * consideration entirely rather than from one accessor:
 *
 *  - **matched**, parses, and declares the requested id. Usable.
 *  - **unparseable**, does not parse at all. Eligible for the raw
 *    fallback, which is precisely what that fallback exists for.
 *  - **foreign**, parses CLEANLY and declares a DIFFERENT id. Never
 *    usable for this task by any accessor. A clean parse naming another
 *    task is not a parse error, and round 8's rationale ("parse-error
 *    consumers need the raw content") does not cover it.
 */
interface ClassifiedCandidates {
  matched?: ResolvedTaskFile;
  /** File names that parse to a DIFFERENT id. Excluded from every path. */
  foreign: Set<string>;
  candidates: string[];
  duplicateClaimants: string[];
}

async function classifyTaskFileCandidates(
  taskDir: string,
  taskId: string,
): Promise<ClassifiedCandidates> {
  const candidates = await listTaskFileCandidates(taskDir, taskId);
  const foreign = new Set<string>();
  const declarations: Array<{ fileName: string; declaredId: string }> = [];
  let matched: ResolvedTaskFile | undefined;

  for (const taskFile of candidates) {
    const filePath = path.join(taskDir, taskFile);
    let content: string;
    try {
      content = await fs.readFile(filePath, "utf-8");
    } catch {
      continue; // unreadable: neither usable nor provably foreign
    }
    let task: ParsedTask;
    try {
      task = parseTaskFile(content, filePath);
    } catch {
      continue;
    }
    declarations.push({ fileName: taskFile, declaredId: task.id });
    if (task.id !== taskId) {
      foreign.add(taskFile);
    } else if (!matched) {
      matched = {
        fileName: taskFile,
        filePath,
        content,
        task,
        duplicateClaimants: [],
      };
    }
  }

  const claimants = groupTaskClaimantsByDeclaredId(declarations).get(taskId) ?? [];
  const duplicateClaimants = claimants.length > 1 ? [...claimants].sort() : [];
  if (matched) matched.duplicateClaimants = duplicateClaimants;
  return { matched, foreign, candidates, duplicateClaimants };
}

/** Sync twin of {@link classifyTaskFileCandidates}. */
function classifyTaskFileCandidatesSync(taskDir: string, taskId: string): ClassifiedCandidates {
  const candidates = listTaskFileCandidatesSync(taskDir, taskId);
  const foreign = new Set<string>();
  const declarations: Array<{ fileName: string; declaredId: string }> = [];
  let matched: ResolvedTaskFile | undefined;

  for (const taskFile of candidates) {
    const filePath = path.join(taskDir, taskFile);
    let content: string;
    try {
      content = fsSync.readFileSync(filePath, "utf-8");
    } catch {
      continue;
    }
    let task: ParsedTask;
    try {
      task = parseTaskFile(content, filePath);
    } catch {
      continue;
    }
    declarations.push({ fileName: taskFile, declaredId: task.id });
    if (task.id !== taskId) {
      foreign.add(taskFile);
    } else if (!matched) {
      matched = {
        fileName: taskFile,
        filePath,
        content,
        task,
        duplicateClaimants: [],
      };
    }
  }

  const claimants = groupTaskClaimantsByDeclaredId(declarations).get(taskId) ?? [];
  const duplicateClaimants = claimants.length > 1 ? [...claimants].sort() : [];
  if (matched) matched.duplicateClaimants = duplicateClaimants;
  return { matched, foreign, candidates, duplicateClaimants };
}

/** Candidates a RAW fallback may choose from: never a foreign parse. */
function rawEligible(classified: ClassifiedCandidates): string[] {
  return classified.candidates.filter((c) => !classified.foreign.has(c));
}

export async function resolveParsedTaskFile(
  taskDir: string,
  taskId: string,
): Promise<ResolvedTaskFile | null> {
  return (await classifyTaskFileCandidates(taskDir, taskId)).matched ?? null;
}

/** Sync twin of {@link resolveParsedTaskFile}, returning the matched bundle. */
export function resolveParsedTaskFileSync(
  taskDir: string,
  taskId: string,
): ResolvedTaskFile | null {
  return classifyTaskFileCandidatesSync(taskDir, taskId).matched ?? null;
}

/** Narrow path-only compatibility accessor for the sync parsed resolver. */
export function resolveParsedTaskFileSyncPath(
  taskDir: string,
  taskId: string,
): { fileName: string; filePath: string } | null {
  const matched = resolveParsedTaskFileSync(taskDir, taskId);
  return matched ? { fileName: matched.fileName, filePath: matched.filePath } : null;
}

/**
 * Sync candidate set for a raw fallback, with foreign parses removed
 * (TASK-1332 round 9). The identity resolver applies its own, stricter,
 * parent-name rules on top of this.
 */
export function listRawEligibleTaskFileCandidatesSync(taskDir: string, taskId: string): string[] {
  return rawEligible(classifyTaskFileCandidatesSync(taskDir, taskId));
}

export async function resolveTaskFile(
  taskDir: string,
  taskId: string,
): Promise<ResolvedTaskFile | null> {
  const classified = await classifyTaskFileCandidates(taskDir, taskId);
  if (classified.matched) return classified.matched;

  // R9-1: the fallback chooses only from candidates that are NOT another
  // task's spec, so no accessor, `task`, `filePath` or `content`, can
  // hand a caller a different task's file.
  //
  // R10-1: and it must be an unambiguous PARENT name. Excluding foreign
  // parses was not enough, because an UNPARSEABLE child is not foreign -
  // it is exactly what the raw fallback exists for, so `TASK-100` still
  // resolved to an unparseable `TASK-100-A-child.md`. The `?? eligible[0]`
  // tail went with it: a "pick something, anything" default is how a
  // fallback ends up certifying the wrong file.
  const eligible = rawEligible(classified).filter((c) => isParentTaskFileName(taskId, c));
  const match = pickBestRawTaskFileCandidate(taskId, eligible);
  if (!match) return null;

  const filePath = path.join(taskDir, match);
  const content = await fs.readFile(filePath, "utf-8");
  // Everything here is unparseable by construction, so `task` is null.
  return {
    fileName: match,
    filePath,
    content,
    task: null,
    duplicateClaimants: classified.duplicateClaimants,
  };
}

export async function resolveTaskFilePath(taskDir: string, taskId: string): Promise<string | null> {
  return (await resolveTaskFile(taskDir, taskId))?.filePath ?? null;
}

/**
 * TASK-1334: does this CONTENT declare the task it is about to be written as?
 *
 * Resolving the target path correctly is only half the guarantee. The step-1
 * investigation found that both enrichment writes can persist content whose H1
 * declares a DIFFERENT task, so a correct path plus wrong content still lands
 * `# TASK-999` inside `TASK-100`'s file. Target identity and replacement
 * identity are separate properties and need separate guards.
 *
 * TASK-1334 round 1 (R3) gave this three outcomes; round 2 (R2-2) made it
 * PARSER-EQUIVALENT and retired the two-way `declaredIdMismatch` wrapper,
 * whose null-on-unrecognized was fail-open and whose last caller (the
 * `/enrich` write) now refuses unrecognized content like its sibling.
 *
 * The first version matched case-insensitively with a bare separator
 * lookahead, on the recorded belief that the parser did the same. That belief
 * was FALSE: `parseH1` is case-sensitive and requires a separator plus title,
 * or an id-only heading. A guard looser than the parser meant
 * `/enrich/approve` could persist headings the parser then threw on, turning
 * a live spec into a parse-error file, while the old rationale worried about
 * the opposite failure (false refusals) that a shared rule makes impossible
 * by construction. Note the old rationale was also wrong that `/enrich`
 * refuses id-less content earlier: `extractSpecBody` checks only that the
 * literal `# TASK-` prefix exists somewhere, so `# TASK-: no id` passed it.
 *
 * The heading rule therefore has ONE producer: `matchTaskHeading` in
 * `task-parser.ts`, consumed by `parseH1` and by this guard, so the two can
 * never drift again. BOM and leading-whitespace tolerance here mirror the
 * parser's line handling. `unrecognized` covers content whose first `# `
 * heading the parser would reject, and content with no heading at all;
 * callers refuse both, because a body that does not declare its task must
 * never be written over a spec that does.
 */
export type DeclaredIdVerdict =
  | { kind: "match"; declared: string }
  | { kind: "mismatch"; declared: string }
  | { kind: "unrecognized" };

export function classifyDeclaredId(content: string, taskId: string): DeclaredIdVerdict {
  const withoutBom = content.charCodeAt(0) === 0xfeff ? content.slice(1) : content;
  for (const rawLine of withoutBom.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line.startsWith("# ")) continue;
    const heading = line.slice(2).trim();
    const matched = matchTaskHeading(heading);
    if (!matched) return { kind: "unrecognized" };
    return matched.id === taskId.trim().toUpperCase()
      ? { kind: "match", declared: matched.id }
      : { kind: "mismatch", declared: matched.id };
  }
  return { kind: "unrecognized" };
}
