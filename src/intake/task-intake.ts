import { z } from "zod";

import {
  CANONICAL_LANES,
  CANONICAL_RISK_LEVELS,
  type WorkflowLane,
  type WorkflowRiskLevel,
} from "../workflow/workflow-state-types.js";
import type { LaneClassification, IntakeClassificationReason } from "./lane-classifier.js";

const taskIdSchema = z.string().regex(/^TASK-\d+(?:-[A-Z])?$/, {
  message: "taskId must match TASK-NNN or TASK-NNN-A",
});

const stringListSchema = z.array(z.string().trim().min(1)).default([]);
const metadataSchema = z.record(z.string(), z.unknown()).default({});

export const remoteTaskIntakeSchema = z.object({
  /**
   * Discriminator added by TASK-1106. `"forward"` is the original
   * spec → code → verified intake flow (Honk-inspired). `"validation"` is the
   * branch + evidence → validated → verified flow whose payload is parsed
   * separately against {@link validationIntakePayloadSchema}.
   *
   * Default `"forward"` preserves backwards compatibility for every existing
   * caller — pre-TASK-1106 records and clients that omit the field continue to
   * read/write as forward intake.
   *
   * The parent schema stays NON-strict on purpose: the validation payload
   * fields (`schemaVersion`, `branch`, `commitRange`, `scope`, `tests`,
   * `screenshots`, `nonClaims`, `knownRisks`, `submittedAt`) coexist on the
   * same request body when `intakeType === "validation"`. The route handler
   * peeks at this discriminator, then re-parses the body against
   * `validationIntakePayloadSchema` for the validation-only fields. Making
   * the parent `.strict()` would reject those fields outright.
   */
  intakeType: z.enum(["forward", "validation"]).default("forward"),
  taskId: taskIdSchema.optional(),
  title: z.string().trim().min(1),
  description: z.string().trim().min(1),
  source: z.string().trim().min(1).default("remote"),
  requestedBy: z.string().trim().min(1).optional(),
  idempotencyKey: z.string().trim().min(1).optional(),
  priority: z.enum(["P0-CRITICAL", "P1-HIGH", "P2-MEDIUM", "P3-LOW"]).default("P2-MEDIUM"),
  tags: stringListSchema,
  files: stringListSchema,
  requestedLane: z.enum(CANONICAL_LANES).optional(),
  metadata: metadataSchema,
});

// ─── Validation Intake payload (TASK-1106, schemaVersion:1) ────────────

/**
 * Branches whose names must never appear in a Validation Intake payload.
 * Validation Intake is for branch-first work; direct mainline edits are
 * Forward Intake's domain. Mirrors the example-side JSON Schema's `not.enum`.
 */
const PROTECTED_BRANCHES = ["dev", "staging", "prod", "main", "master"] as const;

/**
 * Single test-run entry on a Validation Intake payload.
 *
 * `.strict()` so unknown fields are rejected — mirrors the JSON Schema's
 * `additionalProperties: false` at the item level. This is the TASK-1107
 * anti-pattern guard: no `.env` blobs, no untyped fields, no surprise keys
 * sneaking through the wire.
 */
const validationTestEntrySchema = z
  .object({
    name: z.string().min(1),
    result: z.enum(["PASS", "FAIL", "SKIP"]),
    evidence: z.string().min(1),
  })
  .strict();

/**
 * Single screenshot entry on a Validation Intake payload. `.strict()` per the
 * same anti-pattern guard as {@link validationTestEntrySchema}.
 */
const validationScreenshotEntrySchema = z
  .object({
    file: z.string().min(1),
    caption: z.string().min(1),
  })
  .strict();

/**
 * Validation Intake payload (schemaVersion:1).
 *
 * Cross-repo coupling note: this Zod schema MUST stay accept/reject-equal with
 * the example-side JSON Schema at
 * `example-service/.claude/helpers/validation-intake-schema.json`. The
 * Jest test at `tests/intake/validation-intake-schema-compat.test.ts` runs a
 * shared fixture set through BOTH validators and asserts equal verdicts; bump
 * both sides in lockstep when changing `schemaVersion`.
 *
 * Every nested object is `.strict()` because the example JSON Schema sets
 * `additionalProperties: false` at every level — bare `z.object()` would
 * silently accept extra fields like `{ ..., secret: "leak" }` and the two
 * validators would disagree. CRITICAL.
 *
 * `schemaVersion` is `z.literal(1)` (REQUIRED, not defaulted) so v2 clients
 * fail loudly against a v1 server (and vice versa) until both sides catch up.
 *
 * `nonClaims` is allowed to be an empty array at the SHAPE level (matching
 * the JSON Schema mirror). The semantic non-bypass rule (`nonClaims` must be
 * non-empty for the intake to PASS) is enforced one layer higher by
 * `src/intake/evidence-gate.ts` with an explicit HTTP 422 REVISE.
 */
export const validationIntakePayloadSchema = z
  .object({
    schemaVersion: z.literal(1),
    project: z
      .string()
      .min(1)
      .regex(/^[A-Za-z0-9_.-]+$/),
    branch: z
      .string()
      .min(1)
      .regex(/^[\w./-]+$/)
      .refine((b) => !(PROTECTED_BRANCHES as readonly string[]).includes(b), {
        message: "branch must not be a protected branch (dev/staging/prod/main/master)",
      }),
    commitRange: z
      .string()
      .min(1)
      .refine((s) => !/[`$;]/.test(s) && !/\n|\r/.test(s), {
        message: "commitRange must not contain shell metacharacters (backtick, $, ;) or newlines",
      }),
    scope: z.array(z.string().min(1)).min(1),
    tests: z.array(validationTestEntrySchema).min(1),
    screenshots: z.array(validationScreenshotEntrySchema),
    nonClaims: z.array(z.string().min(1)),
    knownRisks: z.array(z.string().min(1)),
    submitter: z.string().min(1),
    submittedAt: z.string().datetime({ offset: true }),
  })
  .strict();

export type ValidationIntakePayload = z.infer<typeof validationIntakePayloadSchema>;
export type ValidationIntakePayloadInput = z.input<typeof validationIntakePayloadSchema>;

export const intakeRouteDecisionSchema = z.object({
  lane: z.enum(CANONICAL_LANES),
  riskLevel: z.enum(CANONICAL_RISK_LEVELS).optional(),
  actor: z.string().trim().min(1),
  reason: z.string().trim().min(1).optional(),
  reasons: stringListSchema,
  metadata: metadataSchema,
});

export type RemoteTaskIntakeInput = z.input<typeof remoteTaskIntakeSchema>;
export type RemoteTaskIntakeRequest = z.infer<typeof remoteTaskIntakeSchema>;
export type IntakeRouteDecisionInput = z.input<typeof intakeRouteDecisionSchema>;
export type IntakeRouteDecision = z.infer<typeof intakeRouteDecisionSchema>;

export type TaskIntakeStatus = "classified" | "routed";

export interface PersistedRouteDecision {
  lane: WorkflowLane;
  riskLevel: WorkflowRiskLevel;
  actor: string;
  reason?: string;
  reasons: string[];
  metadata: Record<string, unknown>;
  routedAt: string;
}

export interface TaskIntakeRecord {
  intakeId: string;
  workflowId: string;
  sessionId: string;
  status: TaskIntakeStatus;
  taskId?: string;
  source: string;
  title: string;
  description: string;
  priority: RemoteTaskIntakeRequest["priority"];
  tags: string[];
  files: string[];
  requestedBy?: string;
  idempotencyKey?: string;
  requestedLane?: WorkflowLane;
  metadata: Record<string, unknown>;
  classification: LaneClassification;
  route?: PersistedRouteDecision;
  projectId?: string;
  createdAt: string;
  updatedAt: string;
  /**
   * TASK-1106 intake-type discriminator. Absent on pre-TASK-1106 records;
   * readers MUST default to `"forward"` when undefined. `"validation"` records
   * carry the original payload on {@link validationPayload}.
   */
  intakeType?: "forward" | "validation";
  /**
   * TASK-1106 Validation Intake payload preserved verbatim on the record so
   * later replay paths (idempotency, admin /verify-task handoff) have the
   * exact bundle that was POSTed. Only populated when
   * `intakeType === "validation"`.
   */
  validationPayload?: ValidationIntakePayload;
}

export interface IntakeValidationError {
  path: string;
  message: string;
}

export function validationDetails(error: z.ZodError): IntakeValidationError[] {
  return error.issues.map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
}

export function toClassificationInput(input: RemoteTaskIntakeRequest): {
  title: string;
  description: string;
  tags: string[];
  files: string[];
  priority: string;
  requestedLane?: WorkflowLane;
} {
  return {
    title: input.title,
    description: input.description,
    tags: input.tags,
    files: input.files,
    priority: input.priority,
    requestedLane: input.requestedLane,
  };
}

export function createRouteDecision(
  input: IntakeRouteDecision,
  fallbackRiskLevel: WorkflowRiskLevel,
  routedAt: string,
): PersistedRouteDecision {
  return {
    lane: input.lane,
    riskLevel: input.riskLevel ?? fallbackRiskLevel,
    actor: input.actor,
    reason: input.reason,
    reasons: input.reasons.length > 0 ? input.reasons : ["operator_route"],
    metadata: input.metadata,
    routedAt,
  };
}

export function routeClassification(route: PersistedRouteDecision): LaneClassification {
  return {
    lane: route.lane,
    riskLevel: route.riskLevel,
    reasons: route.reasons as IntakeClassificationReason[],
  };
}
