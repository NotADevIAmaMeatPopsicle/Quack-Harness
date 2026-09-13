import { createHash } from "node:crypto";

// Bump when fixed validateTaskSchema semantics change (e.g. statuses/priorities),
// not only when the configurable requiredSections set changes.
export const SCHEMA_POLICY_VERSION = 1;

export function computeSchemaPolicyHash(requiredSections: readonly string[] = []): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        version: SCHEMA_POLICY_VERSION,
        requiredSections: [...new Set(requiredSections)].sort(),
      }),
    )
    .digest("hex");
}

export const DEFAULT_SCHEMA_POLICY_HASH = computeSchemaPolicyHash();

/** Missing is unknown, including under the default empty-section policy. */
export function matchesSchemaPolicy(stored: unknown, expected: string): boolean {
  return typeof stored === "string" && /^[a-f0-9]{64}$/.test(stored) && stored === expected;
}
