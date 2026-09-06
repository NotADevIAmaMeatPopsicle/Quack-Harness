// ─── Spec Review Types ─────────────────────────────────────────────
// Types for the spec ambiguity reviewer that detects whether task
// specifications contain language that can be interpreted in multiple
// ways, leading to agent misimplementation.
//
// Orthogonal to depth evaluation: depth checks "how much detail",
// spec review checks "how unambiguous".

export interface SpecReviewResult {
  /** Number of ambiguous items found across all dimensions */
  ambiguityCount: number;
  /** Overall risk level — calculated deterministically AFTER LLM returns findings */
  riskLevel: "low" | "medium" | "high";
  /** Per-criterion findings */
  findings: AmbiguityFinding[];
  /** Suggested clarifications to add to the spec */
  suggestedClarifications: string[];
}

export interface AmbiguityFinding {
  /** Which success criterion (by index, 0-based) */
  criterionIndex: number;
  /** The criterion text */
  criterionText: string;
  /** Which dimension was triggered */
  dimension:
    | "criterion_ambiguity"
    | "interface_gap"
    | "file_mapping"
    | "visual_ambiguity"
    | "ownership_ambiguity"
    | "integration_gap";
  /** Human-readable explanation of the ambiguity */
  explanation: string;
  /** A specific clarification question to resolve it */
  clarificationQuestion: string;
  /** Severity: 'high' = likely to cause agent failure, 'medium' = may cause issues */
  severity: "high" | "medium";
}
