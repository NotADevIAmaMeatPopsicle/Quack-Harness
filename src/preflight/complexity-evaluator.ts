// ─── Complexity Evaluator ──────────────────────────────────────────
// Threshold-based evaluation of task complexity to recommend
// decomposition before dispatch. Purely deterministic — no LLM calls.

import type { ParsedTask, ContextSizeEstimate, FileModification } from "../core/types.js";
import type { ComplexityResult, ComplexityThresholds, FeatureCluster } from "./preflight-types.js";
import { DEFAULT_COMPLEXITY_THRESHOLDS } from "./preflight-types.js";

/**
 * Evaluate task complexity against configurable thresholds.
 * Returns recommendDecomposition: true when ANY threshold is exceeded.
 *
 * @param task - The parsed task specification
 * @param contextEstimate - Token estimates from context assembly
 * @param thresholds - Configurable complexity thresholds (defaults provided)
 * @returns ComplexityResult with recommendation and reason
 */
export function evaluateComplexity(
  task: ParsedTask,
  contextEstimate: ContextSizeEstimate,
  thresholds: ComplexityThresholds = DEFAULT_COMPLEXITY_THRESHOLDS,
): ComplexityResult {
  const filesToModify = task.filesToModify.length;
  const successCriteria = task.successCriteria.length;
  const estimatedContextTokens = contextEstimate.total;

  const reasons: string[] = [];

  if (filesToModify > thresholds.maxFilesBeforeDecompose) {
    reasons.push(
      `${filesToModify} files to modify exceeds limit of ${thresholds.maxFilesBeforeDecompose}`,
    );
  }

  if (successCriteria > thresholds.maxCriteriaBeforeDecompose) {
    reasons.push(
      `${successCriteria} success criteria exceeds limit of ${thresholds.maxCriteriaBeforeDecompose}`,
    );
  }

  if (estimatedContextTokens > thresholds.maxContextTokensBeforeDecompose) {
    reasons.push(
      `${estimatedContextTokens} estimated context tokens exceeds limit of ${thresholds.maxContextTokensBeforeDecompose}`,
    );
  }

  // Feature clustering
  const clusters = clusterCriteriaByFile(task.successCriteria, task.filesToModify);
  const independentFeatures = countIndependentClusters(clusters);

  if (independentFeatures > thresholds.maxIndependentFeatures) {
    reasons.push(
      `${independentFeatures} independent feature groups exceeds limit of ${thresholds.maxIndependentFeatures}`,
    );
  }

  const recommendDecomposition = reasons.length > 0;
  const reason = recommendDecomposition
    ? `Recommend decomposition: ${reasons.join("; ")}`
    : "Task complexity within acceptable thresholds";

  return {
    filesToModify,
    successCriteria,
    estimatedContextTokens,
    independentFeatures,
    featureClusters: clusters,
    recommendDecomposition,
    reason,
  };
}

/**
 * Tokenize a criterion string for matching.
 * Split on whitespace and common punctuation, lowercase, filter tokens < 3 chars.
 */
function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_./,;:()[\]{}'"!?]+/)
    .filter((t) => t.length >= 3);
}

/**
 * Extract matchable segments from a file path.
 * "src/monitor/public/index.html" → ["src", "monitor", "public", "index", "html"]
 */
function pathSegments(filePath: string): string[] {
  return filePath
    .toLowerCase()
    .split(/[\\/.]/)
    .filter((s) => s.length >= 3);
}

/**
 * Score how well a criterion matches a file.
 * Returns count of criterion tokens that match any path segment (substring match, min 3 chars).
 */
function matchScore(criterionTokens: string[], segments: string[]): number {
  let score = 0;
  for (const token of criterionTokens) {
    for (const seg of segments) {
      if (seg.includes(token) || token.includes(seg)) {
        score++;
        break; // count each token once
      }
    }
  }
  return score;
}

/**
 * Group success criteria by file association using path-segment matching.
 *
 * For each criterion:
 * 1. Tokenize: split on whitespace and punctuation, lowercase, filter tokens < 3 chars
 * 2. For each file in filesToModify, extract path segments:
 *    "src/monitor/public/index.html" → ["src", "monitor", "public", "index", "html"]
 * 3. A criterion matches a file if ANY criterion token is a case-insensitive
 *    substring of ANY path segment (or vice versa), with a minimum match length of 3.
 * 4. Each criterion is assigned to its BEST matching file (most token matches).
 *    Ties broken by first file in filesToModify order.
 * 5. Criteria matching NO file are collected into a single "unmapped" cluster
 *    (NOT individual singletons — that would over-count independent features).
 *
 * @param criteria - Success criteria strings
 * @param filesToModify - Files that will be modified
 * @returns Array of FeatureCluster objects
 */
export function clusterCriteriaByFile(
  criteria: string[],
  filesToModify: FileModification[],
): FeatureCluster[] {
  const fileToIndices = new Map<string, number[]>();
  const unmappedIndices: number[] = [];

  // For each criterion, find best-matching file
  for (let i = 0; i < criteria.length; i++) {
    const criterion = criteria[i];
    const tokens = tokenize(criterion);

    let bestFile: string | null = null;
    let bestScore = 0;

    for (const file of filesToModify) {
      const segments = pathSegments(file.path);
      const score = matchScore(tokens, segments);
      if (score > bestScore) {
        bestScore = score;
        bestFile = file.path;
      }
    }

    if (bestFile && bestScore > 0) {
      if (!fileToIndices.has(bestFile)) {
        fileToIndices.set(bestFile, []);
      }
      fileToIndices.get(bestFile)!.push(i);
    } else {
      unmappedIndices.push(i);
    }
  }

  const clusters: FeatureCluster[] = [];

  // Build file-based clusters
  for (const [filePath, indices] of fileToIndices.entries()) {
    const basename = filePath.split(/[\\/]/).pop() || filePath;
    clusters.push({
      label: basename,
      criteriaIndices: indices,
      files: [filePath],
    });
  }

  // Add unmapped cluster if non-empty
  if (unmappedIndices.length > 0) {
    clusters.push({
      label: "unmapped",
      criteriaIndices: unmappedIndices,
      files: [],
    });
  }

  return clusters;
}

/**
 * Count clusters with zero file overlap as independent features.
 * The "unmapped" cluster (files=[]) is always counted as 1 independent feature if non-empty.
 */
export function countIndependentClusters(clusters: FeatureCluster[]): number {
  let count = 0;

  for (let i = 0; i < clusters.length; i++) {
    const cluster = clusters[i];
    if (cluster.files.length === 0) {
      // Unmapped cluster — always independent if non-empty
      if (cluster.criteriaIndices.length > 0) {
        count++;
      }
      continue;
    }

    // Check for overlap with other clusters
    let hasOverlap = false;
    for (let j = 0; j < clusters.length; j++) {
      if (i === j) continue;
      const other = clusters[j];
      if (other.files.length === 0) continue; // unmapped doesn't overlap

      // Check if any file is in both clusters
      const overlap = cluster.files.some((f) => other.files.includes(f));
      if (overlap) {
        hasOverlap = true;
        break;
      }
    }

    if (!hasOverlap) {
      count++;
    }
  }

  return count;
}
