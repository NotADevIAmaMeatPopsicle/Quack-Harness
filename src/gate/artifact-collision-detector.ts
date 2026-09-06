// ─── Artifact Collision Detector ────────────────────────────────────
// Pre-dispatch advisory check for spec references to artifacts that
// already exist in the target repo. Catches the class of bug surfaced by
// TASK-885 (spec said "create ADR-035" but ADR-035 already covered an
// unrelated decision; worker created ADR-047, lifecycle verifier then forced
// misleading ADR-035 references into CLAUDE docs to satisfy the literal
// criterion).
//
// Runs synchronously, no LLM. Advisory by contract (TASK-1300 / v2 P0-8):
// collisions never block the gate. They ride the gate result's deficiency
// list with the "ADVISORY:" prefix and surface structurally on
// PreflightResult.gate.advisories and the gate_artifact_collisions event.
//
// See docs/tasks/TASK-868-preflight-artifact-collision-detector.md.

import * as fs from "node:fs";
import * as path from "node:path";

import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { ParsedTask } from "../core/types.js";

export type CollisionIntent = "create" | "reference" | "ambiguous";

export interface ArtifactCollision {
  /** Short label for the artifact (e.g. "ADR-035", "docs/foo.md"). */
  artifact: string;
  /** Inferred authorial intent from surrounding spec text. */
  intent: CollisionIntent;
  /** Where the existing artifact lives. */
  existingAt: string;
  /** One-line summary of the existing artifact's scope (best-effort). */
  existingScope: string;
  /** Operator-actionable recommendation. */
  recommendedAction: string;
}

export interface ArtifactWarning {
  artifact: string;
  note: string;
}

export interface ArtifactCollisionReport {
  blockers: ArtifactCollision[];
  warnings: ArtifactWarning[];
}

const ADR_REFERENCE_RE = /\bADR-(\d{3,4})\b/g;
const FILE_CREATE_INTENT_VERBS = /\b(create|define|add|introduce|new|author)\b/i;
const FILE_REFERENCE_INTENT_VERBS =
  /\b(follow|per|see|references?|consistent with|aligns? with|extends?|builds? on)\b/i;

/**
 * Detect spec → existing-artifact collisions in a parsed task against a
 * project adapter. Synchronous + cheap (filesystem stat + adapter doc lookup,
 * no LLM). Returns advisories that the gate can fold into deficiencies.
 */
export function detectArtifactCollisions(
  task: ParsedTask,
  adapter: ProjectAdapter,
): ArtifactCollisionReport {
  const blockers: ArtifactCollision[] = [];
  const warnings: ArtifactWarning[] = [];

  detectAdrCollisions(task, adapter, blockers, warnings);
  detectFileCreateCollisions(task, adapter, blockers);

  return { blockers, warnings };
}

function detectAdrCollisions(
  task: ParsedTask,
  adapter: ProjectAdapter,
  blockers: ArtifactCollision[],
  warnings: ArtifactWarning[],
): void {
  const adrDocs = adapter.adrDocs ?? {};
  const text = task.rawContent ?? "";

  // Track ADR numbers we've already reported on so duplicates in the same
  // spec don't produce N copies of the same advisory.
  const reportedAdr = new Set<string>();

  for (const match of text.matchAll(ADR_REFERENCE_RE)) {
    const numStr = match[1];
    if (!numStr) continue;
    const num = parseInt(numStr, 10);
    const key = String(num).padStart(3, "0");

    if (reportedAdr.has(key)) continue;

    const existingDoc = adrDocs[key];
    if (!existingDoc) continue;

    reportedAdr.add(key);

    const window = extractWindow(text, match.index ?? 0, 80);
    const intent = classifyIntent(window);
    const existingScope = extractAdrTitle(existingDoc);
    const existingAt = `docs/architecture/decisions/${key}-*.md`;
    const nextFree = nextFreeAdrNumber(adrDocs, num);
    const nextFreeKey = String(nextFree).padStart(3, "0");

    if (intent === "create") {
      blockers.push({
        artifact: `ADR-${key}`,
        intent,
        existingAt,
        existingScope,
        recommendedAction:
          `ADR-${key} already exists ("${existingScope}"). ` +
          `Use ADR-${nextFreeKey} (next free) and update spec references; ` +
          `do not overwrite the existing ADR.`,
      });
    } else if (intent === "ambiguous") {
      warnings.push({
        artifact: `ADR-${key}`,
        note:
          `Spec mentions ${match[0]} which already exists ` +
          `("${existingScope}"). Verify whether the spec references ` +
          `the existing decision or intends to create a new ADR ` +
          `(in which case use ADR-${nextFreeKey}).`,
      });
    }
    // intent === "reference" → silently allowed; the spec is using the
    // existing ADR as background context, not creating it.
  }
}

function detectFileCreateCollisions(
  task: ParsedTask,
  adapter: ProjectAdapter,
  blockers: ArtifactCollision[],
): void {
  const projectRoot = adapter.projectRoot;
  if (!projectRoot) return;

  for (const file of task.filesToModify ?? []) {
    if (file.action !== "Create") continue;
    const relPath = file.path?.trim();
    if (!relPath) continue;

    // Refuse to stat absolute paths or paths that escape the project root.
    if (path.isAbsolute(relPath) || relPath.includes("..")) continue;

    const fullPath = path.join(projectRoot, relPath);
    let exists = false;
    try {
      exists = fs.existsSync(fullPath);
    } catch {
      // Filesystem errors are non-fatal; skip the check for this entry.
      continue;
    }
    if (!exists) continue;

    blockers.push({
      artifact: relPath,
      intent: "create",
      existingAt: relPath,
      existingScope: "Existing file in repository",
      recommendedAction:
        `${relPath} already exists in the repo. Change action to "Modify" if ` +
        `the spec intends to update the existing file, or rename the target ` +
        `path if it should genuinely be a new file.`,
    });
  }
}

function classifyIntent(window: string): CollisionIntent {
  const create = FILE_CREATE_INTENT_VERBS.test(window);
  const reference = FILE_REFERENCE_INTENT_VERBS.test(window);
  if (create && !reference) return "create";
  if (reference && !create) return "reference";
  if (create && reference) return "ambiguous";
  return "ambiguous";
}

function extractWindow(text: string, offset: number, half: number): string {
  const start = Math.max(0, offset - half);
  const end = Math.min(text.length, offset + half);
  return text.slice(start, end);
}

function extractAdrTitle(doc: string): string {
  const firstNonEmpty = doc
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.length > 0);
  if (!firstNonEmpty) return "untitled";
  return firstNonEmpty
    .replace(/^#+\s*/, "")
    .trim()
    .slice(0, 100);
}

function nextFreeAdrNumber(adrs: Record<string, string>, startAfter: number): number {
  for (let n = startAfter + 1; n < startAfter + 1000; n++) {
    const k = String(n).padStart(3, "0");
    if (!adrs[k]) return n;
  }
  return startAfter + 1;
}

/** Convert collision report into advisory deficiency strings for the gate result. */
export function collisionsToDeficiencies(report: ArtifactCollisionReport): string[] {
  return report.blockers.map(
    (b) => `ADVISORY: artifact collision — ${b.artifact}: ${b.recommendedAction}`,
  );
}

/** Combined advisory list (blockers + warnings) for surface on PrepResult. */
export function collisionsToAdvisories(
  report: ArtifactCollisionReport,
): Array<{ severity: "blocker" | "warning"; artifact: string; message: string }> {
  return [
    ...report.blockers.map((b) => ({
      severity: "blocker" as const,
      artifact: b.artifact,
      message: b.recommendedAction,
    })),
    ...report.warnings.map((w) => ({
      severity: "warning" as const,
      artifact: w.artifact,
      message: w.note,
    })),
  ];
}
