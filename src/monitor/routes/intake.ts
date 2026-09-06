// ─── Intake Routes ──────────────────────────────────────────────────
// Two distinct intake families share this module because both are
// "ingest a thing into Quack":
//
//   /v1/intake/*  — Federated task intake (workflow + assessment).
//                   Persists via IntakeStore, classifies the lane, emits
//                   workflow events. Closure deps: resolveAndBroadcast
//                   Projection, emitIntakeCreated, emitIntakeRouted.
//
//   /api/scan + /api/intake/*  — Project bootstrap intake. Scans an
//                   external project path, generates a candidate adapter,
//                   runs validation/analysis, and writes .quack/ on
//                   apply. Stateless beyond the request body and dynamic
//                   imports — no closure deps beyond resolveProject.

import * as crypto from "node:crypto";
import * as path from "node:path";
import type { Express, Request, Response } from "express";

import { IntakeStore } from "../../intake/intake-store.js";
import {
  intakeRouteDecisionSchema,
  remoteTaskIntakeSchema,
  toClassificationInput,
  validationDetails,
  validationIntakePayloadSchema,
  type RemoteTaskIntakeRequest,
  type TaskIntakeRecord,
  type ValidationIntakePayload,
} from "../../intake/task-intake.js";
import { classifyIntakeLane } from "../../intake/lane-classifier.js";
import { assessContributorIntake } from "../../intake/contributor-assessment.js";
import { verificationCommandShellString } from "../../core/types.js";
import type {
  ValidationIntakeDryRunResult,
  ValidationIntakePersistResult,
} from "../../intake/validation-intake.js";

export interface IntakeRouteProject {
  projectId: string;
  projectRoot?: string;
}

/**
 * Dependency injection contract for validation-intake orchestrator entry points.
 * Per TASK-1106 Blueprint §7: the route module never imports the orchestrator
 * directly — server.ts wires it in so tests can swap mock implementations.
 */
export interface ValidationIntakeRouteDeps {
  runValidationIntakeDryRun: (args: {
    projectRoot: string;
    payload: ValidationIntakePayload;
  }) => Promise<ValidationIntakeDryRunResult>;
  runValidationIntakePersist: (args: {
    projectRoot: string;
    projectId: string;
    payload: ValidationIntakePayload;
    intakeRecordId: string;
  }) => Promise<ValidationIntakePersistResult>;
  generateValidationSpec: (args: {
    projectRoot: string;
    intakeId: string;
    payload: ValidationIntakePayload;
  }) => Promise<{ taskId: string; specPath: string; evidencePath: string }>;
}

export interface IntakeRouteDeps extends Partial<ValidationIntakeRouteDeps> {
  resolveProject: (req: Request) => IntakeRouteProject;
  emitIntakeCreated: (p: IntakeRouteProject, record: TaskIntakeRecord) => void;
  emitIntakeRouted: (p: IntakeRouteProject, record: TaskIntakeRecord) => void;
  // taskId may be undefined on intake records that have not yet been routed to a TASK-NNN id.
  resolveAndBroadcastProjection: (
    p: IntakeRouteProject,
    taskId: string | undefined,
  ) => Promise<unknown>;
}

/**
 * Derive the natural-key idempotency key for a validation-intake payload.
 * Per Blueprint §6: `sha256("validation:" + project + ":" + branch + ":" + commitRange).slice(0, 16)`.
 * Used by the route handler when the caller omits `idempotencyKey` — leverages
 * the existing IntakeStore.create() replay path without new dedup code.
 */
function deriveValidationIdempotencyKey(payload: ValidationIntakePayload): string {
  const seed = `validation:${payload.project}:${payload.branch}:${payload.commitRange}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

/**
 * Strip parent (`remoteTaskIntakeSchema`) fields from a raw request body so the
 * strict `validationIntakePayloadSchema` parse can succeed. The example-side
 * canonical wire body has none of these — but admin tooling and the
 * integration test may add `intakeType` (or other parent fields) for
 * client-side discriminator clarity. Strip them here so the strict schema's
 * `additionalProperties: false` equivalence with the example JSON Schema
 * stays load-bearing on the 11 validation fields.
 */
function stripParentIntakeFields(body: Record<string, unknown>): Record<string, unknown> {
  const parentOnly = new Set([
    "intakeType",
    "title",
    "description",
    "source",
    "requestedBy",
    "idempotencyKey",
    "priority",
    "tags",
    "files",
    "requestedLane",
    "metadata",
    "taskId",
  ]);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(body)) {
    if (parentOnly.has(key)) continue;
    out[key] = value;
  }
  return out;
}

export function registerIntakeRoutes(app: Express, deps: IntakeRouteDeps): void {
  const {
    resolveProject,
    emitIntakeCreated,
    emitIntakeRouted,
    resolveAndBroadcastProjection,
    runValidationIntakeDryRun,
    runValidationIntakePersist,
    generateValidationSpec,
  } = deps;

  // ─── Federated task intake (/v1/intake/*) ─────────────────────────

  app.post("/v1/intake/tasks/validate", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    // ─── TASK-1106 discriminator branch ─────────────────────────────
    // Peek at the raw body for the discriminator BEFORE running either
    // Zod schema. The canonical example wire body (per
    // .claude/helpers/validation-intake-schema.json with
    // additionalProperties:false) contains ONLY the 11 validation fields,
    // NO `title` / `description` that the parent forward schema requires
    // — so we cannot run the parent schema on a validation body without
    // a false 400 on missing title. The discriminator may be:
    //   - inside the body as `intakeType: "validation"` (admin tooling)
    //   - on the query string as `?intakeType=validation` (example
    //     /polish-handoff once it ships, until the JSON Schema permits
    //     the discriminator field on the wire body)
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const rawIntakeType =
      typeof rawBody.intakeType === "string"
        ? rawBody.intakeType
        : typeof req.query.intakeType === "string"
          ? req.query.intakeType
          : "forward";

    if (rawIntakeType === "validation") {
      if (!runValidationIntakeDryRun) {
        res.status(500).json({
          error: "validation_intake_unavailable",
          message: "Validation intake orchestrator is not wired into this server.",
        });
        return;
      }
      // Strip the parent-only discriminator (and any forward-only fields
      // a non-canonical client may have added) before running the strict
      // validation schema. Example's canonical body has none of these.
      const validationBody = stripParentIntakeFields(rawBody);
      const validationParsed = validationIntakePayloadSchema.safeParse(validationBody);
      if (!validationParsed.success) {
        res.status(400).json({
          error: "invalid_intake_payload",
          details: validationDetails(validationParsed.error),
        });
        return;
      }
      try {
        const dryRun = await runValidationIntakeDryRun({
          projectRoot: p.projectRoot,
          payload: validationParsed.data,
        });
        if (dryRun.verdict === "REVISE") {
          const deficiencies = [...dryRun.scopeHygiene.reasons, ...dryRun.evidence.deficiencies];
          res.status(422).json({
            ok: false,
            reason: "validation-intake-revise",
            deficiencies,
            scopeHygiene: dryRun.scopeHygiene,
            evidence: dryRun.evidence,
            driftThreshold: dryRun.driftThreshold,
            dryRun: true,
            intakeType: "validation",
          });
          return;
        }
        res.json({
          ok: true,
          valid: true,
          accepted: false,
          dryRun: true,
          intakeType: "validation",
          verdict: dryRun.verdict,
          scopeHygiene: dryRun.scopeHygiene,
          evidence: dryRun.evidence,
          driftThreshold: dryRun.driftThreshold,
        });
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Failed to run validation intake gates: ${msg}` });
        return;
      }
    }

    const parsed = remoteTaskIntakeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_intake_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    const input = parsed.data;
    const classification = classifyIntakeLane(toClassificationInput(input));
    const assessment = assessContributorIntake(input, classification);

    res.json({
      ok: true,
      valid: true,
      accepted: false,
      dryRun: true,
      taskId: input.taskId,
      classification,
      assessment,
    });
  });

  app.post("/v1/intake/tasks", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    // ─── TASK-1106 discriminator branch (persist path) ─────────────
    // Same discriminator semantics as the validate path — peek before
    // running the parent schema so a canonical example validation body
    // (no `title`, no `description`) does not 400 on parent-schema
    // requirements. Both gates run via runValidationIntakePersist; on
    // PASS the route generates the spec, then writes the intake record
    // via the existing IntakeStore so the natural-key replay path keeps
    // working.
    const rawBody = (req.body ?? {}) as Record<string, unknown>;
    const rawIntakeType =
      typeof rawBody.intakeType === "string"
        ? rawBody.intakeType
        : typeof req.query.intakeType === "string"
          ? req.query.intakeType
          : "forward";

    if (rawIntakeType === "validation") {
      if (!runValidationIntakePersist || !generateValidationSpec) {
        res.status(500).json({
          error: "validation_intake_unavailable",
          message: "Validation intake orchestrator is not wired into this server.",
        });
        return;
      }
      const validationBody = stripParentIntakeFields(rawBody);
      const validationParsed = validationIntakePayloadSchema.safeParse(validationBody);
      if (!validationParsed.success) {
        res.status(400).json({
          error: "invalid_intake_payload",
          details: validationDetails(validationParsed.error),
        });
        return;
      }
      try {
        const payload = validationParsed.data;
        // Allow callers to override the derived key (admin replay, retry
        // with different commit range, etc.). Falls back to the natural
        // (project, branch, commitRange) sha256.
        const callerKey =
          typeof rawBody.idempotencyKey === "string" ? rawBody.idempotencyKey : undefined;
        const idempotencyKey = callerKey ?? deriveValidationIdempotencyKey(payload);

        // Run the gates BEFORE persistence so we never write a record for
        // a REVISE outcome. The gates are read-only (git diff + ls-remote)
        // so re-running on replay is cheap and deterministic.
        const persist = await runValidationIntakePersist({
          projectRoot: p.projectRoot,
          projectId: p.projectId,
          payload,
          intakeRecordId: idempotencyKey,
        });
        if (persist.verdict === "REVISE") {
          const deficiencies = [...persist.scopeHygiene.reasons, ...persist.evidence.deficiencies];
          res.status(422).json({
            ok: false,
            reason: "validation-intake-revise",
            deficiencies,
            scopeHygiene: persist.scopeHygiene,
            evidence: persist.evidence,
            driftThreshold: persist.driftThreshold,
            intakeType: "validation",
          });
          return;
        }

        // Both gates PASSED — persist the IntakeStore record and generate
        // the spec. Order: store.create() FIRST so we anchor the per-intake
        // evidence dir at .quack/intake/<intakeId>/evidence/. The spec
        // generator is idempotent by fingerprint, so a replay POST returns
        // the same taskId/specPath/evidencePath without rewriting.
        const store = new IntakeStore(p.projectRoot);
        const classification = classifyIntakeLane({
          title: `Validate ${payload.branch}`,
          description: `Validation intake for ${payload.project}`,
          tags: ["validation-intake"],
          files: payload.scope,
          priority: "P2-MEDIUM",
          requestedLane: "human_required",
        });
        // Build the IntakeStore input. The example canonical body has none
        // of the parent forward fields, so we synthesize them here from
        // the validation payload. Admin tooling may include forward-style
        // overrides on the raw body — pick those up only when they look
        // safe (string types, non-empty strings).
        const rawTitle =
          typeof rawBody.title === "string" && rawBody.title.trim().length > 0
            ? rawBody.title.trim()
            : `Validate ${payload.branch}`;
        const rawDescription =
          typeof rawBody.description === "string" && rawBody.description.trim().length > 0
            ? rawBody.description.trim()
            : `Validation intake for project ${payload.project} on branch ${payload.branch}`;
        const rawSource =
          typeof rawBody.source === "string" && rawBody.source.trim().length > 0
            ? rawBody.source.trim()
            : "remote";
        const rawTags = Array.isArray(rawBody.tags)
          ? rawBody.tags.filter((t): t is string => typeof t === "string")
          : [];
        const intakeInput: RemoteTaskIntakeRequest = {
          intakeType: "validation",
          title: rawTitle,
          description: rawDescription,
          source: rawSource,
          requestedBy: payload.submitter,
          idempotencyKey,
          priority: "P2-MEDIUM",
          tags: Array.from(new Set([...rawTags, "validation-intake"])),
          files: payload.scope,
          requestedLane: "human_required",
          metadata: {},
        };
        const { record, replayed } = await store.create(
          intakeInput,
          classification,
          p.projectId,
          payload,
        );

        // Generate (or re-resolve) the spec under the adapter-declared
        // task dir. Spec generator is idempotent by content fingerprint.
        const specResult = await generateValidationSpec({
          projectRoot: p.projectRoot,
          intakeId: record.intakeId,
          payload,
        });

        if (!replayed) {
          emitIntakeCreated(p, record);
        }
        const projection = await resolveAndBroadcastProjection(p, specResult.taskId);

        res.status(replayed ? 200 : 201).json({
          ok: true,
          accepted: !replayed,
          replayed,
          intakeId: record.intakeId,
          taskId: specResult.taskId,
          workflowId: record.workflowId,
          status: "VERIFYING",
          intakeType: "validation",
          specPath: specResult.specPath,
          evidencePath: specResult.evidencePath,
          handoff: "admin-verify",
          scopeHygiene: persist.scopeHygiene,
          evidence: persist.evidence,
          driftThreshold: persist.driftThreshold,
          projection,
        });
        return;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        res.status(500).json({ error: `Failed to persist intake task: ${msg}` });
        return;
      }
    }

    // ─── Forward intake (existing behaviour) ───────────────────────
    const parsed = remoteTaskIntakeSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_intake_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    try {
      const input = parsed.data;
      const classification = classifyIntakeLane(toClassificationInput(input));
      const assessment = assessContributorIntake(input, classification);
      const store = new IntakeStore(p.projectRoot);
      const { record, replayed } = await store.create(input, classification, p.projectId);

      if (!replayed) {
        emitIntakeCreated(p, record);
      }
      const projection = await resolveAndBroadcastProjection(p, record.taskId);

      res.status(replayed ? 200 : 201).json({
        ok: true,
        accepted: !replayed,
        replayed,
        intakeId: record.intakeId,
        taskId: record.taskId,
        workflowId: record.workflowId,
        classification: record.classification,
        assessment,
        record,
        projection,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to persist intake task: ${msg}` });
    }
  });

  app.get("/v1/intake/tasks/:id", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const intakeId = req.params.id as string;
    const store = new IntakeStore(p.projectRoot);
    const record = await store.get(intakeId);
    if (!record) {
      res.status(404).json({
        error: "intake_not_found",
        message: `Intake task ${intakeId} not found.`,
        intakeId,
      });
      return;
    }

    res.json({ ok: true, intakeId, record });
  });

  app.post("/v1/intake/tasks/:id/route", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const parsed = intakeRouteDecisionSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_route_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    try {
      const intakeId = req.params.id as string;
      const store = new IntakeStore(p.projectRoot);
      const record = await store.route(intakeId, parsed.data);
      if (!record) {
        res.status(404).json({
          error: "intake_not_found",
          message: `Intake task ${intakeId} not found.`,
          intakeId,
        });
        return;
      }

      emitIntakeRouted(p, record);
      const projection = await resolveAndBroadcastProjection(p, record.taskId);

      res.json({
        ok: true,
        intakeId,
        taskId: record.taskId,
        workflowId: record.workflowId,
        route: record.route,
        record,
        projection,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to route intake task: ${msg}` });
    }
  });

  // ─── Project bootstrap intake (/api/scan + /api/intake/*) ─────────

  app.post("/api/scan", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(500).json({ error: "Scan not available (no project root)" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const targetPath = typeof body?.path === "string" ? body.path : p.projectRoot;

    try {
      const { scanProject } = await import("../../bootstrap/project-scanner.js");
      const scanResult = await scanProject(targetPath);

      res.json({
        ok: true,
        scan: scanResult,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to scan project: ${msg}` });
    }
  });

  app.post("/api/intake/scan", async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    const projectPath = typeof body?.projectPath === "string" ? body.projectPath : "";

    if (!projectPath) {
      res.status(400).json({ error: "Missing required field: projectPath" });
      return;
    }

    try {
      const { scanProject } = await import("../../bootstrap/project-scanner.js");
      const scanResult = await scanProject(projectPath);
      res.json({ ok: true, scan: scanResult });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to scan project: ${msg}` });
    }
  });

  app.post("/api/intake/generate", async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    const projectPath = typeof body?.projectPath === "string" ? body.projectPath : "";

    if (!projectPath) {
      res.status(400).json({ error: "Missing required field: projectPath" });
      return;
    }

    try {
      const { scanProject } = await import("../../bootstrap/project-scanner.js");
      const { generateAdapter } = await import("../../bootstrap/adapter-generator.js");

      const scanResult = await scanProject(projectPath);
      const generated = generateAdapter(scanResult);

      res.json({
        ok: true,
        adapterConfig: generated.adapterConfig,
        conventionsMd: generated.conventionsMd,
        testingConventionMd: generated.testingConventionMd,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to generate adapter: ${msg}` });
    }
  });

  app.post("/api/intake/analyze", async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    const projectPath = typeof body?.projectPath === "string" ? body.projectPath : "";

    if (!projectPath) {
      res.status(400).json({ error: "Missing required field: projectPath" });
      return;
    }

    try {
      const { scanProject } = await import("../../bootstrap/project-scanner.js");
      const { generateAdapter } = await import("../../bootstrap/adapter-generator.js");
      const { validateCommands } = await import("../../bootstrap/command-validator.js");
      const { analyzeIntake } = await import("../../bootstrap/intake-analyzer.js");

      // Scan project
      const scanResult = await scanProject(projectPath);

      // Generate adapter to get verification commands
      const generated = generateAdapter(scanResult);
      const verificationCommands = generated.adapterConfig.verification.commands.map((cmd) => ({
        name: cmd.name,
        command: verificationCommandShellString(cmd),
      }));

      // Validate commands
      const commandValidation = await validateCommands(projectPath, verificationCommands);

      // Run LLM analysis
      const analysis = await analyzeIntake(scanResult, commandValidation);

      // Calculate overall confidence
      const passedCommands = commandValidation.filter((c) => c.status === "pass").length;
      const totalCommands = commandValidation.length;
      let confidence: "high" | "medium" | "low" = "medium";
      if (passedCommands === totalCommands && analysis.adapterReview.confidence === "high") {
        confidence = "high";
      } else if (
        passedCommands < totalCommands / 2 ||
        analysis.adapterReview.confidence === "low"
      ) {
        confidence = "low";
      }

      // Build manual review items
      const manualReviewItems: string[] = [];
      if (commandValidation.some((c) => c.status === "fail")) {
        manualReviewItems.push("Some verification commands failed - review command configuration");
      }
      if (commandValidation.some((c) => c.status === "timeout")) {
        manualReviewItems.push("Some commands timed out - consider targeted testing strategies");
      }
      if (
        scanResult.testSuiteSize === "large" &&
        !generated.adapterConfig.verification.commands.some(
          (c) => c.name.includes("targeted") || c.name.includes("unit"),
        )
      ) {
        manualReviewItems.push("Large test suite detected but no targeted test command configured");
      }

      const report = {
        scan: scanResult,
        commandValidation,
        testingStrategy: analysis.testingStrategy,
        conventionsAnalysis: analysis.conventionsAnalysis,
        adapterReview: analysis.adapterReview,
        generatedAdapter: generated,
        confidence,
        manualReviewItems,
      };

      res.json({ ok: true, report });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to analyze intake: ${msg}` });
    }
  });

  app.post("/api/intake/apply", async (req: Request, res: Response) => {
    const body = req.body as Record<string, unknown> | undefined;
    const projectPath = typeof body?.projectPath === "string" ? body.projectPath : "";

    if (!projectPath) {
      res.status(400).json({ error: "Missing required field: projectPath" });
      return;
    }

    try {
      const fsPromises = await import("node:fs/promises");
      const quackDir = path.join(projectPath, ".quack");

      // Check if .quack/ already exists
      try {
        await fsPromises.access(quackDir);
        res.status(409).json({ error: ".quack/ directory already exists" });
        return;
      } catch {
        // Directory doesn't exist — good, proceed
      }

      const { scanProject } = await import("../../bootstrap/project-scanner.js");
      const { generateAdapter } = await import("../../bootstrap/adapter-generator.js");

      const scanResult = await scanProject(projectPath);
      const generated = generateAdapter(scanResult);

      // Create .quack/ and write files
      await fsPromises.mkdir(quackDir, { recursive: true });

      const filesCreated: string[] = [];

      const adapterJsonPath = path.join(quackDir, "adapter.json");
      await fsPromises.writeFile(
        adapterJsonPath,
        JSON.stringify(generated.adapterConfig, null, 2) + "\n",
        "utf-8",
      );
      filesCreated.push(".quack/adapter.json");

      const conventionsMdPath = path.join(quackDir, "conventions.md");
      await fsPromises.writeFile(conventionsMdPath, generated.conventionsMd, "utf-8");
      filesCreated.push(".quack/conventions.md");

      const testingMdPath = path.join(quackDir, "TESTING.md");
      await fsPromises.writeFile(testingMdPath, generated.testingConventionMd, "utf-8");
      filesCreated.push(".quack/TESTING.md");

      const conventionChecksDir = path.join(quackDir, "convention-checks");
      await fsPromises.mkdir(conventionChecksDir, { recursive: true });
      const checkScriptPath = path.join(conventionChecksDir, "test-existence-check.js");
      await fsPromises.writeFile(checkScriptPath, generated.testExistenceCheckJs, "utf-8");
      filesCreated.push(".quack/convention-checks/test-existence-check.js");

      const checkConfigPath = path.join(quackDir, "test-existence.config.json");
      await fsPromises.writeFile(checkConfigPath, generated.testExistenceConfigJson, "utf-8");
      filesCreated.push(".quack/test-existence.config.json");

      // Create logs directory
      const logsDir = path.join(quackDir, "logs");
      await fsPromises.mkdir(logsDir, { recursive: true });

      res.json({ ok: true, filesCreated });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to apply adapter: ${msg}` });
    }
  });
}
