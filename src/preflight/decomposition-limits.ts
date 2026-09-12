export const MIN_DECOMPOSITION_SUBTASKS = 2;
export const DEFAULT_MAX_DECOMPOSITION_SUBTASKS = 4;
export const MAX_DECOMPOSITION_SUBTASKS = 6;

/** Resolve the one supported child-count contract used by every stage. */
export function resolveDecompositionMaxSubtasks(
  value: number | undefined,
  fallback = DEFAULT_MAX_DECOMPOSITION_SUBTASKS,
): number {
  const resolved = value ?? fallback;
  if (
    !Number.isInteger(resolved) ||
    resolved < MIN_DECOMPOSITION_SUBTASKS ||
    resolved > MAX_DECOMPOSITION_SUBTASKS
  ) {
    throw new RangeError(
      `Decomposition maxSubtasks must be an integer from ${MIN_DECOMPOSITION_SUBTASKS} to ${MAX_DECOMPOSITION_SUBTASKS}.`,
    );
  }
  return resolved;
}

/**
 * Resolve the maximum a planning request is allowed to carry forward.
 * The request/default controls the desired fan-out, while the adapter value
 * is an operator-owned ceiling that no staged plan may exceed.
 */
export function resolveEffectiveDecompositionMaxSubtasks(
  requested: number | undefined,
  configured: number | undefined,
): number {
  const requestedMax = resolveDecompositionMaxSubtasks(requested);
  const configuredMax = resolveDecompositionMaxSubtasks(configured);
  return Math.min(requestedMax, configuredMax);
}

export function hasValidDecompositionChildCount(count: number, maxSubtasks: number): boolean {
  if (!Number.isInteger(count)) return false;
  let resolvedMax: number;
  try {
    resolvedMax = resolveDecompositionMaxSubtasks(maxSubtasks);
  } catch {
    return false;
  }
  return count >= MIN_DECOMPOSITION_SUBTASKS && count <= resolvedMax;
}
