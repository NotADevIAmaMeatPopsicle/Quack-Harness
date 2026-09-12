import { z } from "zod";

const positiveVerdicts = new Set(["VERIFIED", "SOFT-VERIFIED"]);
const identifier = z.string().regex(/^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/);
const text = z
  .string()
  .trim()
  .min(1)
  .refine(
    (value) =>
      Array.from(value).every((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code >= 0x20 && code !== 0x7f;
      }),
    "Control characters are not allowed",
  );
const date = z.string().refine((value) => {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(parsed) && new Date(parsed).toISOString().slice(0, 10) === value;
}, "verifiedAt must be a valid ISO calendar date");

export const verificationCursorSchema = z.string().superRefine((value, ctx) => {
  const parsed = Date.parse(value);
  if (
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value) ||
    !Number.isFinite(parsed) ||
    new Date(parsed).toISOString().slice(0, 19) !== value.slice(0, 19)
  ) {
    ctx.addIssue({ code: "custom", message: "invalid_updated_at" });
  } else if (parsed > Date.now() + 5 * 60 * 1000) {
    ctx.addIssue({ code: "custom", message: "updated_at_in_future" });
  }
});

/** One write contract for the canonical store and both verified POST surfaces. */
export const verificationEntrySchema = z
  .object({
    taskId: identifier,
    verdict: z.enum(["VERIFIED", "FAILED", "REJECTED", "SOFT-VERIFIED", "CANNOT_VERIFY"]),
    commitSha: text.max(128),
    method: text.max(256),
    criteriaChecked: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    criteriaPassed: z.number().int().min(0).max(Number.MAX_SAFE_INTEGER),
    notes: z.string().nullable().optional(),
    verifiedAt: date.optional(),
    updatedAt: verificationCursorSchema.optional(),
    reviewId: identifier.optional(),
    workflowId: identifier.optional(),
  })
  .strict()
  .superRefine((entry, ctx) => {
    if (entry.criteriaPassed > entry.criteriaChecked) {
      ctx.addIssue({
        code: "custom",
        path: ["criteriaPassed"],
        message: "criteriaPassed cannot exceed criteriaChecked",
      });
    }
    // Failure/rejection evidence may have no commit (e.g. the existing n/a reject path).
    // A positive verification must identify a Git object, never a probe placeholder.
    if (
      positiveVerdicts.has(entry.verdict) &&
      !/^(?:[a-fA-F0-9]{7,40}|[a-fA-F0-9]{64})$/.test(entry.commitSha)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["commitSha"],
        message:
          "Positive verification requires a hexadecimal Git commit ID (7-40 or 64 characters)",
      });
    }
  });

/** Keep the public snake-case API while rejecting misspelled/extra write fields. */
export const verifiedApiPayloadSchema = z
  .object({
    verdict: z.unknown(),
    commit: z.unknown().optional(),
    method: z.unknown().optional(),
    criteria_checked: z.unknown().optional(),
    criteria_passed: z.unknown().optional(),
    notes: z.unknown().optional(),
    verified: z.unknown().optional(),
    updated_at: z.unknown().optional(),
    reviewId: z.unknown().optional(),
    workflowId: z.unknown().optional(),
    requireReview: z.union([z.boolean(), z.literal("true"), z.literal("false")]).optional(),
    projectId: z.string().min(1).optional(),
  })
  .strict();

export function parseVerifiedApiEntry(taskId: string, payload: unknown) {
  const body = verifiedApiPayloadSchema.parse(payload);
  return verificationEntrySchema.parse({
    taskId,
    verdict: body.verdict,
    commitSha: body.commit === undefined ? "unknown" : body.commit,
    method: body.method === undefined ? "api" : body.method,
    criteriaChecked: body.criteria_checked === undefined ? 0 : body.criteria_checked,
    criteriaPassed: body.criteria_passed === undefined ? 0 : body.criteria_passed,
    notes: body.notes === undefined ? null : body.notes,
    verifiedAt: body.verified,
    updatedAt: body.updated_at,
    reviewId: body.reviewId,
    workflowId: body.workflowId,
  });
}
