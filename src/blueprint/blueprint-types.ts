// ─── Blueprint Types ────────────────────────────────────────────────
// Type definitions for the Blueprint Agent output.
// The Blueprint Agent pre-digests the codebase and produces code-level
// implementation details before dispatch, reducing agent exploration time.

/**
 * Analysis of a single file that will be created, modified, or deleted.
 */
export interface FileAnalysis {
  /** Relative path to the file (e.g., "src/blueprint/blueprint-agent.ts") */
  filePath: string;
  /** What action will be taken on this file. Mirrors FileModification.action so
   *  task.filesToModify entries can map directly into FileAnalysis without an
   *  explicit narrow. "Reference" means the file is read for context only and
   *  must NOT be modified. */
  action: "Create" | "Modify" | "Delete" | "Reference";
  /** Current structure: key exports, classes, functions with line numbers */
  currentStructure: string;
  /** Integration points: where new code connects to existing code */
  integrationPoints: string;
  /** Pattern to follow: existing code pattern to mimic (file:line reference) */
  patternToFollow: string;
}

/**
 * Before/after code example showing how to implement a specific change.
 */
export interface CodeExample {
  /** File path for this example */
  file: string;
  /** Description of what this example demonstrates */
  description: string;
  /** Current code snippet (or "[new file]" for new files) */
  before: string;
  /** Expected code snippet after changes */
  after: string;
}

/**
 * Deterministic verification pattern derived from a success criterion.
 * Can be checked via grep, file existence, or other deterministic methods.
 */
export interface VerificationPattern {
  /** The success criterion text from the task spec */
  criterion: string;
  /** Type of deterministic check to perform */
  checkType: "grep" | "grep_count" | "file_exists" | "file_not_exists";
  /** Regex pattern (for grep) or file path (for file checks) */
  pattern: string;
  /** Target file(s) as a glob pattern (for grep checks) */
  fileGlob: string;
  /** Expected minimum match count (for grep_count type only) */
  expectedMatches?: number;
}

/**
 * Provenance + re-validation of the brief against the tree it was GENERATED
 * from (TASK-1306).
 *
 * SEMANTICS: baseSha/baseBranch record the checkout the blueprint agent
 * actually READ (adapter.projectRoot HEAD at generation time) — the
 * investigation substrate. They are NOT a promise about the dispatch
 * worktree, which is created later from origin/<base>; the loop gate
 * (TASK-1307) compares this SHA against the dispatch tree to surface
 * staleness. That comparison is what this provenance exists for.
 *
 * baseBranch/baseSha/validatedAt are stamped by CODE after generation and
 * never trusted from the LLM; observations carry the agent's re-validation
 * findings (stale anchors, moved files, spec claims the tree contradicts).
 */
export interface BriefBaseValidation {
  baseBranch: string;
  baseSha: string;
  validatedAt: string;
  /** Agent-reported observations from re-validating the spec against the current tree */
  observations: string[];
}

/**
 * An adjacent issue surfaced during investigation (TASK-1306).
 * Operator information, NOT a work order — the formatter renders these
 * under an explicit out-of-scope preamble so the worker never treats
 * them as tasks.
 */
export interface BriefHandBackItem {
  summary: string;
  detail?: string;
  /** file or file:line citations */
  anchors?: string[];
}

/**
 * TASK-1324: a typed import directive — the synthesizer must emit the
 * imports it directs the builder to use HERE (the prose may repeat them,
 * but this surface is authoritative), so Tier D can mechanically verify
 * the symbol is exported from the named file. The round-12 failure class
 * (a brief directing an unexported symbol) dies on this surface.
 */
export interface BriefImportDirective {
  /** The symbol the builder is told to import/call. */
  symbol: string;
  /** Repo-relative file the symbol is claimed to come from. */
  fromFile: string;
  /**
   * Round-2 F3: "type" marks a type-only import (satisfied by `export
   * type` / `export interface`). Absent or "value" means RUNTIME use —
   * a symbol whose only export is type-space FAILS the audit, because
   * directing a builder to call an interface is the round-12 class in
   * type clothing.
   */
  kind?: "value" | "type";
}

/** TASK-1324: a typed entry-point directive (same contract as imports). */
export interface BriefEntryPointDirective {
  symbol: string;
  file: string;
}

/** TASK-1324: one mechanically-found fidelity violation. */
export interface BriefFidelityViolation {
  kind: "missing_file" | "unexported_symbol" | "type_only_export" | "empty_brief";
  /** Human-readable description with the offending directive/anchor. */
  detail: string;
  /** file or file:line the violation anchors to, when applicable. */
  anchor?: string;
}

/**
 * TASK-1324: the deterministic fidelity audit result, stamped by the
 * PIPELINE (never the LLM) after synthesis at both generation sites.
 * `failed` briefs are never auto-approvable. An empty or effectively
 * empty brief (the createMinimalBlueprint stub shape) is `failed`, not
 * vacuously ok. Data, never control flow beyond the approval predicate.
 */
export interface BriefFidelityResult {
  status: "ok" | "failed";
  violations: BriefFidelityViolation[];
  /** ISO timestamp of the audit. Stamped by code. */
  checkedAt: string;
  /**
   * Honest boundary marker: free-text prose received existence-only
   * checks; only the typed directive surface got export resolution.
   */
  scope: "typed-surface+file-existence";
}

/**
 * Complete implementation blueprint generated by the Blueprint Agent.
 * Contains all code-level detail needed to implement a task without
 * extensive codebase exploration.
 *
 * TASK-1306 enriches this into the loop's Brief artifact: the optional
 * brief fields below are additive — older blueprints (and the minimal
 * fallback) simply omit them.
 */
export interface Blueprint {
  /** Task ID this blueprint is for */
  taskId: string;
  /** Per-file analysis with integration points and patterns */
  fileAnalyses: FileAnalysis[];
  /** Before/after code examples for key changes */
  codeExamples: CodeExample[];
  /** Deterministic verification patterns for success criteria */
  verificationPatterns: VerificationPattern[];
  /** Anti-patterns: explicit "do NOT" instructions based on common failures */
  antiPatterns: string[];
  /** Preconditions: things that must be true before starting implementation */
  preconditions: string[];

  // ── Brief fields (TASK-1306, all optional/additive) ─────────────
  /** 1 when brief fields are populated. Stamped by code. */
  briefSchemaVersion?: number;
  /** ISO timestamp of generation. Stamped by code. */
  generatedAt?: string;
  /** Provenance + re-validation against the generation tree. */
  baseValidation?: BriefBaseValidation;
  /** Adjacent issues surfaced for the operator. NOT work orders. */
  handBack?: BriefHandBackItem[];
  /** ADR/convention constraints the implementation must honor. */
  constraints?: string[];
  /** Test files/suites to re-baseline before building. */
  testsToRebaseline?: string[];

  // ── Fidelity fields (TASK-1324, all optional/additive) ──────────
  /** Typed import directives — the auditable surface (see BriefImportDirective). */
  importsToUse?: BriefImportDirective[];
  /** Typed entry-point directives — same contract. */
  entryPoints?: BriefEntryPointDirective[];
  /** The spec's decided facts this brief claims to honor (echo of
   *  ParsedTask.decidedFacts — a diffable fidelity surface for the gate
   *  and reviewer; `undefined` when the spec has no Decided Facts). */
  specFacts?: string[];
  /** Pipeline-stamped deterministic audit result. NEVER LLM-authored:
   *  the normalizer carries it tolerantly (the cached path needs it),
   *  and the generation path OVERWRITES it unconditionally after
   *  synthesis — the stampBriefProvenance pattern. */
  fidelity?: BriefFidelityResult;
}

/**
 * Loop vocabulary: the Brief IS the enriched Blueprint (v2 design §5 —
 * evolution, not replacement).
 *
 * Boundary rule: the review ARTIFACT handed to a ReviewerRunner at the
 * brief gate is formatBlueprintForPrompt(brief) — the MARKDOWN — never
 * this object (ReviewRequest.artifact is a string by type).
 */
export type Brief = Blueprint;
