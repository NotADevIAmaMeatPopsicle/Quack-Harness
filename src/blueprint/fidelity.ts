// ─── Brief Fidelity Audit (TASK-1324, Tier D) ──────────────────────
// The deterministic, zero-LLM audit that runs on every FRESHLY
// synthesized brief before it can reach a cache, a pend, or a builder.
// Sixteen example review rounds proved the synthesizer can contradict a
// correct spec (unexported imports, inverted decided facts) and that the
// cross-model reviewer was the only thing catching it from outside; this
// module is that check moved INSIDE the pipeline, for the surfaces that
// are mechanically checkable.
//
// Scope honesty (the whole design): the typed directive surface
// (importsToUse / entryPoints) gets full export resolution; every file
// reference gets an existence check; free-text prose gets NOTHING here —
// the cross-model reviewer remains the semantic backstop.
//
// Placement contract (round-1 F1, refined at build time): the stamp runs
// inside generateBlueprint at every return path (success + all four
// fallback classes), which covers BOTH live synthesis sites (preflight
// and the dispatcher's inline path) by construction, plus the
// dispatcher's own timeout stub minted outside generateBlueprint. The
// ONE deliberately un-audited stub is cached-blueprint.ts's legacy-cache
// placeholder: pre-1324 legacy caches keep their TASK-1306 tolerance
// contract, and absent fidelity reads as "not checked", never as "ok".

import * as fs from "node:fs";
import * as path from "node:path";
import type { Blueprint, BriefFidelityResult, BriefFidelityViolation } from "./blueprint-types.js";

/** Escape a symbol for use inside a RegExp. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Throw-safe existence check with `:line` / `:line-line` suffix
 * stripping. Semantics credited to `auditFindingAnchors`
 * (src/review/verdict-extract.ts:200-215): existsSync can THROW on
 * malformed paths (embedded NUL bytes from garbled LLM output) and a
 * thrown check counts as missing. Re-implemented rather than imported to
 * keep blueprint/ free of a review/ dependency for six lines; the
 * round-1 "extend, don't fork" disposition is honored at the semantic
 * level and this credit is the audit trail.
 */
function anchorFileExists(anchor: string, projectRoot: string): boolean {
  const filePart = anchor.trim().replace(/:\d+(?:-\d+)?$/, "");
  if (filePart.length === 0) return false;
  try {
    return fs.existsSync(path.resolve(projectRoot, filePart));
  } catch {
    return false;
  }
}

/**
 * Deterministic export resolution for `symbol` in `source`.
 * Recognized forms (TypeScript/ESM — the target repos' convention):
 *   export [async] function|class|const|let|var|enum <symbol>   → value
 *   export type|interface <symbol>                              → type
 *   export { <symbol> }, export { x as <symbol> } [from "..."]  → ambiguous
 *   export type { <symbol> }                                    → type
 * Round-2 F3: a directive whose only match is TYPE-space does not
 * satisfy a runtime (value) import — directing a builder to call an
 * interface is the round-12 class in type clothing. Brace lists without
 * `type` are AMBIGUOUS and accepted for either kind (classifying them
 * would need cross-file resolution; the tolerance is one-sided and
 * documented). Not recognized at all (loud human-gate boundary, not
 * silent): `export default`, CommonJS `module.exports`, `export * from`.
 */
function resolveExport(source: string, symbol: string): "value" | "type" | "ambiguous" | "none" {
  const escaped = escapeRegExp(symbol);
  const valueDeclaration = new RegExp(
    `export\\s+(?:async\\s+)?(?:function|class|const|let|var|enum)\\s+${escaped}\\b`,
  );
  const typeDeclaration = new RegExp(`export\\s+(?:type|interface)\\s+${escaped}\\b`);
  const typeBraceList = new RegExp(`export\\s+type\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`);
  const braceList = new RegExp(`export\\s*\\{[^}]*\\b${escaped}\\b[^}]*\\}`);
  if (valueDeclaration.test(source)) return "value";
  if (typeDeclaration.test(source) || typeBraceList.test(source)) return "type";
  if (braceList.test(source)) return "ambiguous";
  return "none";
}

/**
 * Round-2 F2: conservative extractor for path-shaped references inside
 * free-text prose fields (patternToFollow, integrationPoints,
 * currentStructure). Only tokens that unambiguously look like repo file
 * paths (contain a slash, end in a known source extension, optional
 * :line suffix) are extracted — prose existence checks must not fail a
 * brief over ordinary sentences.
 */
const PROSE_PATH_RE =
  /(?:^|[\s(`'"])([A-Za-z0-9_.@-]+(?:\/[A-Za-z0-9_.@-]+)+\.(?:ts|tsx|js|jsx|mjs|cjs|json|md|py|css|html))(?::\d+(?:-\d+)?)?(?=$|[\s)`'",;:])/g;

function extractProsePaths(text: string): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(PROSE_PATH_RE)) {
    const candidate = match[1];
    // 2b C2: dependency paths are not repo anchors — prose legitimately
    // mentions node_modules internals without claiming they are project
    // files. Scoped segments (@scope) ARE matched by the class above.
    if (candidate.includes("node_modules/")) continue;
    found.add(candidate);
  }
  return [...found];
}

/**
 * Run the Tier D audit. Total function: never throws — unreadable
 * targets are violations, not crashes (a crashing auditor that silently
 * passed briefs would be QPI-046 all over again).
 */
export function auditBriefFidelity(brief: Blueprint, projectRoot: string): BriefFidelityResult {
  const violations: BriefFidelityViolation[] = [];
  const imports = brief.importsToUse ?? [];
  const entryPoints = brief.entryPoints ?? [];

  // Empty-brief rule (round-1 F5; closes QPI-046 legs 1-2): the
  // createMinimalBlueprint stub shape — no analyses AND no directives —
  // is a FAILED brief, never a vacuous pass. Before this rule the stub
  // was cached as clean structured success and auto-approved.
  if (brief.fileAnalyses.length === 0 && imports.length === 0 && entryPoints.length === 0) {
    return {
      status: "failed",
      violations: [
        {
          kind: "empty_brief",
          detail:
            "Brief has zero fileAnalyses and zero typed directives — the " +
            "agent-failure stub shape. Re-synthesize; do not approve.",
        },
      ],
      checkedAt: new Date().toISOString(),
      scope: "typed-surface+file-existence",
    };
  }

  // File existence for every referenced file. Create-action analyses are
  // exempt (the file legitimately does not exist yet); Modify / Delete /
  // Reference must exist, as must every directive's source file.
  // Deduped so one bad path yields one violation regardless of how many
  // surfaces mention it.
  const flaggedMissing = new Set<string>();
  const flagMissing = (filePath: string, detail: string): void => {
    if (flaggedMissing.has(filePath)) return;
    flaggedMissing.add(filePath);
    violations.push({ kind: "missing_file", detail, anchor: filePath });
  };

  const createTargets = new Set(
    brief.fileAnalyses
      .filter((a) => a.action === "Create" && a.filePath)
      .map((a) => a.filePath.trim().replace(/:\d+(?:-\d+)?$/, "")),
  );

  for (const analysis of brief.fileAnalyses) {
    if (!analysis.filePath || analysis.action === "Create") continue;
    if (!anchorFileExists(analysis.filePath, projectRoot)) {
      flagMissing(
        analysis.filePath,
        `fileAnalyses ${analysis.action} target does not exist: ${analysis.filePath}`,
      );
    }
  }

  // Round-2 F2: the anchor-bearing STRUCTURED surfaces beyond
  // fileAnalyses — codeExamples.file and handBack anchors get the same
  // existence check ("[new file]" and Create targets are exempt).
  for (const example of brief.codeExamples) {
    if (!example.file || example.before === "[new file]") continue;
    const bare = example.file.trim().replace(/:\d+(?:-\d+)?$/, "");
    if (createTargets.has(bare)) continue;
    if (!anchorFileExists(example.file, projectRoot)) {
      flagMissing(bare, `codeExamples references a nonexistent file: ${example.file}`);
    }
  }
  for (const item of brief.handBack ?? []) {
    for (const anchor of item.anchors ?? []) {
      const bare = anchor.trim().replace(/:\d+(?:-\d+)?$/, "");
      if (!bare || createTargets.has(bare)) continue;
      if (!anchorFileExists(anchor, projectRoot)) {
        flagMissing(bare, `handBack anchor does not exist: ${anchor}`);
      }
    }
  }

  // Round-2 F2: path-shaped references inside free-text prose fields get
  // existence-only checks via the conservative extractor.
  for (const analysis of brief.fileAnalyses) {
    const prose = [analysis.patternToFollow, analysis.integrationPoints, analysis.currentStructure]
      .filter(Boolean)
      .join("\n");
    for (const prosePath of extractProsePaths(prose)) {
      if (createTargets.has(prosePath)) continue;
      if (!anchorFileExists(prosePath, projectRoot)) {
        flagMissing(
          prosePath,
          `fileAnalyses prose for ${analysis.filePath} references a nonexistent file: ${prosePath}`,
        );
      }
    }
  }

  // Typed directives: file must exist AND the symbol must be exported in
  // the directed KIND-space (round-2 F3: a type-only export does not
  // satisfy a runtime import; ambiguous brace lists tolerate either).
  const directives: Array<{ symbol: string; file: string; label: string; kind: "value" | "type" }> =
    [
      ...imports.map((d) => ({
        symbol: d.symbol,
        file: d.fromFile,
        label: "importsToUse",
        kind: d.kind ?? ("value" as const),
      })),
      ...entryPoints.map((d) => ({
        symbol: d.symbol,
        file: d.file,
        label: "entryPoints",
        kind: "value" as const,
      })),
    ];
  for (const directive of directives) {
    if (!anchorFileExists(directive.file, projectRoot)) {
      flagMissing(
        directive.file.trim().replace(/:\d+(?:-\d+)?$/, ""),
        `${directive.label} directive names a nonexistent file: ${directive.symbol} from ${directive.file}`,
      );
      continue;
    }
    let source: string;
    try {
      source = fs.readFileSync(path.resolve(projectRoot, directive.file), "utf-8");
    } catch {
      flagMissing(
        directive.file,
        `${directive.label} directive file is unreadable: ${directive.file}`,
      );
      continue;
    }
    const exportKind = resolveExport(source, directive.symbol);
    if (exportKind === "none") {
      violations.push({
        kind: "unexported_symbol",
        detail:
          `${directive.label} directive names a symbol that is not exported: ` +
          `${directive.symbol} from ${directive.file} (the round-12 failure class)`,
        anchor: directive.file,
      });
    } else if (exportKind === "type" && directive.kind !== "type") {
      violations.push({
        kind: "type_only_export",
        detail:
          `${directive.label} directive treats a TYPE-only export as a runtime symbol: ` +
          `${directive.symbol} from ${directive.file} (mark it kind:"type" if a type import was intended)`,
        anchor: directive.file,
      });
    }
  }

  return {
    status: violations.length > 0 ? "failed" : "ok",
    violations,
    checkedAt: new Date().toISOString(),
    scope: "typed-surface+file-existence",
  };
}

/**
 * Convenience stamp: returns the brief with a freshly computed fidelity
 * result, OVERWRITING any prior value (LLM-authored fidelity can never
 * survive a fresh synthesis — the stampBriefProvenance pattern).
 */
export function stampBriefFidelity(brief: Blueprint, projectRoot: string): Blueprint {
  return { ...brief, fidelity: auditBriefFidelity(brief, projectRoot) };
}
