// ─── Ghost Prep Sweep (QPI-048 leg h) ──────────────────────────────
// Auto-decompose writes child PREP artifacts (prep/TASK-NNN-A.json,
// prep/TASK-NNN-A-preflight.json) outside git, so reverting the child
// SPEC files (the sanctioned cleanup for a bad decomposition) leaves
// ghost prep state behind — the TASK-1273 cycle carried ghost children
// through a clone revert and the dispatch gate then enforced records
// against them. This sweep detects and (on apply) removes prep
// artifacts for SUBTASK-shaped ids whose child spec no longer exists
// while the parent spec does — precisely the decompose-ghost class, so
// unrelated prep for renamed or historical tasks is never touched.

import * as fs from "node:fs";
import * as path from "node:path";

export interface GhostPrepEntry {
  taskId: string;
  parentId: string;
  files: string[];
}

export interface GhostPrepSweepResult {
  scanned: number;
  ghosts: GhostPrepEntry[];
  removedFiles: string[];
  applied: boolean;
}

const SUBTASK_ID_RE = /^(TASK-\d+)-([A-Z]+)$/;
const H1_TASK_ID_RE = /^#\s+(TASK-\d+(?:-[A-Z]+)?)\b/;
const SPEC_STATUS_RE = /\*\*Status:\*\*/;
// Measured: across 1835 real spec files in the two live backlogs, ZERO
// specs carry their Status field beyond this offset.
const HEAD_BYTES = 4000;

function prepArtifactTaskId(fileName: string): string | null {
  if (!fileName.endsWith(".json")) return null;
  const base = fileName.endsWith("-preflight.json")
    ? fileName.slice(0, -"-preflight.json".length)
    : fileName.slice(0, -".json".length);
  return base.length > 0 ? base : null;
}

/**
 * What a single markdown file in the task dir DECLARES about itself:
 * the task id in its H1, and whether it is a task SPEC at all rather
 * than some other document about that task.
 *
 * The spec marker is a declared `**Status:**` in the head, NOT an
 * `## Metadata` section and NOT `parseTaskFile` success. Both stricter
 * options were measured against the two real backlogs (1548 example +
 * 287 Quack files) before this line was written:
 *   - requiring `## Metadata` misses 8 genuine example specs that carry
 *     Status directly under the H1 — the tolerant shape TASK-1300 (P0-5)
 *     taught the parser to accept;
 *   - `parseTaskFile` itself rejects 13 genuine Quack specs (this
 *     series' own 1302/1305/1306/1324/1325 among them) over unrelated
 *     required sections, and far more example specs.
 * Every file the real parser ACCEPTS also passes this marker in both
 * corpora, so the marker is a superset of the platform's own notion of
 * a task and cannot miss a spec the platform would parse. Residual,
 * named rather than hidden: a non-spec document carrying a `**Status:**`
 * line reads as a spec (two TASK-623 debrief notes do); it can only
 * matter for a parent with no real spec of its own, and TASK-623 has
 * one, so the measured set is unchanged.
 */
interface SpecDeclaration {
  declaredId: string | null;
  isSpec: boolean;
}

function readSpecDeclaration(taskDirAbs: string, name: string): SpecDeclaration {
  let head: string;
  try {
    head = fs.readFileSync(path.join(taskDirAbs, name), "utf-8").slice(0, HEAD_BYTES);
  } catch {
    return { declaredId: null, isSpec: false };
  }

  // Round-2d F1: QUOTED markdown is not the document's own markdown. A
  // notes file that shows a spec's H1 inside a fenced block, and
  // mentions a Status field somewhere, was being indexed as that task's
  // spec — over-delete, and easy to hit in a repo whose generated docs
  // quote anchors constantly. Both signals are therefore read outside
  // fences and outside YAML frontmatter, in one pass.
  const lines = head.split(/\r?\n/);
  let declaredId: string | null = null;
  let sawHeading = false;
  let isSpec = false;
  let inFence = false;
  let inFrontmatter = lines[0]?.trim() === "---";

  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    if (inFrontmatter) {
      if (i > 0 && line.trim() === "---") inFrontmatter = false;
      continue;
    }
    if (/^\s{0,3}(```|~~~)/.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;

    if (!isSpec && SPEC_STATUS_RE.test(line)) isSpec = true;
    if (!sawHeading && /^#{1,6}\s/.test(line)) {
      sawHeading = true; // only the FIRST real heading can be the H1
      const match = H1_TASK_ID_RE.exec(line);
      if (match) declaredId = match[1];
    }
  }
  return { declaredId, isSpec };
}

/**
 * One bounded read per markdown file, consulted by both existence
 * checks below. Built lazily — only a subtask-shaped prep candidate
 * makes it worth reading the backlog.
 */
interface SpecIndex {
  /** Ids declared by files that are task SPECS. */
  specIds: Set<string>;
  /** Ids declared in any H1, spec or not. */
  declaredIds: Set<string>;
}

function buildSpecIndex(taskDirAbs: string, specFiles: string[]): SpecIndex {
  const index: SpecIndex = { specIds: new Set(), declaredIds: new Set() };
  for (const name of specFiles) {
    const declaration = readSpecDeclaration(taskDirAbs, name);
    if (!declaration.declaredId) continue;
    index.declaredIds.add(declaration.declaredId);
    if (declaration.isSpec) index.specIds.add(declaration.declaredId);
  }
  return index;
}

/**
 * THE INVARIANT (three review rounds got here): both existence checks
 * fail toward NOT deleting, and they are deliberately asymmetric
 * because their failure directions are opposite.
 *
 * CHILD side — GENEROUS. A false "the child is still here" only skips a
 * sweep; a false "the child is gone" DELETES live prep. So a child
 * counts as present on a filename match OR an H1 declaration
 * (round-2c F2: a child spec whose filename does not carry its id —
 * the same filename-undecidability that started this — was invisible to
 * the old filename-only check and its live prep was swept).
 *
 * PARENT side — STRICT. A false "the parent is here" turns the
 * whole-family-left case (explicitly out of scope) into a deletion, so
 * the parent must be declared by a real task SPEC. Round-2c F1 found
 * the fold's own motivating example was itself the counter-example:
 * the live `TASK-1106-IMPLEMENTATION-BLUEPRINT.md` carries the H1
 * `# TASK-1106 Implementation Blueprint` and is an auto-authored
 * workflow document, not TASK-1106's spec — the previous H1-only check
 * (`\s*[:\s]` accepts the space, so the missing colon changed nothing)
 * read it as the parent and would have swept a family whose spec never
 * existed. Unreadable or truncated candidates carry neither an id nor
 * the spec marker, so they fail to the safe side by construction.
 */
function childSpecExists(taskId: string, specFiles: string[], index: SpecIndex): boolean {
  if (specFiles.some((name) => name === `${taskId}.md` || name.startsWith(`${taskId}-`))) {
    return true;
  }
  return index.declaredIds.has(taskId);
}

function parentSpecExists(parentId: string, index: SpecIndex): boolean {
  return index.specIds.has(parentId);
}

export function sweepGhostPrepState(
  projectRoot: string,
  taskDir: string,
  apply: boolean,
): GhostPrepSweepResult {
  const prepDir = path.join(projectRoot, ".quack", "prep");
  const taskDirAbs = path.resolve(projectRoot, taskDir);
  const result: GhostPrepSweepResult = {
    scanned: 0,
    ghosts: [],
    removedFiles: [],
    applied: apply,
  };
  if (!fs.existsSync(prepDir) || !fs.existsSync(taskDirAbs)) return result;

  let specFiles: string[];
  try {
    specFiles = fs.readdirSync(taskDirAbs).filter((f) => f.endsWith(".md"));
  } catch {
    return result;
  }

  const byTask = new Map<string, string[]>();
  for (const name of fs.readdirSync(prepDir)) {
    const taskId = prepArtifactTaskId(name);
    if (!taskId) continue;
    result.scanned += 1;
    const existing = byTask.get(taskId) ?? [];
    existing.push(name);
    byTask.set(taskId, existing);
  }

  const candidates = [...byTask.keys()].filter((taskId) => SUBTASK_ID_RE.test(taskId));
  if (candidates.length === 0) return result;
  const specIndex = buildSpecIndex(taskDirAbs, specFiles);

  for (const [taskId, files] of byTask) {
    const match = SUBTASK_ID_RE.exec(taskId);
    if (!match) continue; // conservative: subtask-shaped ids only
    const parentId = match[1];
    // Ghost = child spec gone while the parent spec still exists (the
    // decompose-revert shape). A missing PARENT means the whole task
    // family left — out of this sweep's scope.
    if (childSpecExists(taskId, specFiles, specIndex)) continue;
    if (!parentSpecExists(parentId, specIndex)) continue;

    result.ghosts.push({ taskId, parentId, files: [...files].sort() });
    if (apply) {
      for (const file of files) {
        try {
          fs.unlinkSync(path.join(prepDir, file));
          result.removedFiles.push(file);
        } catch {
          // Leave partial removals visible: the file stays listed in
          // ghosts but absent from removedFiles.
        }
      }
    }
  }

  result.ghosts.sort((a, b) => a.taskId.localeCompare(b.taskId));
  result.removedFiles.sort();
  return result;
}
