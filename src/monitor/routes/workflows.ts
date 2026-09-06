// ─── Workflow + Review Routes ───────────────────────────────────────
// Four conceptually-related route subgroups share this module because
// they all live on the lifecycle/review side of the pipeline:
//
//   /v1/workflows/*         Federated verify + fix workflow records.
//   /v1/reviews             Review bundle creation (verdict + docs gate
//                           + optional docs pipeline broadcast).
//   /v1/reviews/:id         Review bundle read.
//   /v1/jobs/:id/events     Append docs-change events to a job's JSONL
//                           ledger and broadcast over SSE.
//   /v1/support-content     Tail of the support-content JSONL feed.
//
// All write paths broadcast SSE explicitly through the injected sse
// manager, matching the spec's "SSE broadcasts remain explicit at
// route/service boundaries" requirement.

import * as path from "node:path";
import * as fsPromises from "node:fs/promises";
import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { SSEManager } from "../sse-manager.js";
import type { TaskService } from "../task-service.js";
import type { EventWriter } from "../event-emitter.js";
import type { JudgmentConfig } from "../../judgment/runner/intent-judgment-config.js";
import { runVerifyWorkflow } from "../../workflows/verify-orchestrator.js";
import { runFixWorkflow } from "../../workflows/fix-orchestrator.js";
import { WorkflowStore } from "../../workflows/workflow-store.js";
import {
  evaluateReviewGateWithJudgment,
  blockedOnlyByDocsDebt,
  persistReviewBundle,
  requiredActionsForDocsImpact,
  runDocsPipeline,
  type DocsImpact,
  type ReviewBundleInput,
  type WikiAction,
} from "../../review/docs-gate.js";
import { validationDetails } from "../../intake/task-intake.js";
import type {
  RecordOptions,
  RecordVerificationResult,
  VerificationEntry,
  VerificationStoreProject,
} from "../verification-store.js";
import {
  buildStrictDuplicateClaimantIndex,
  type DuplicateClaimantIndex,
} from "../../core/duplicate-claimants.js";
import { listTaskClaimantDeclarations } from "../../core/task-file-resolver.js";

export interface WorkflowRouteProject {
  projectId: string;
  projectRoot?: string;
  taskService?: TaskService | null;
  /** TASK-1203: the verified-ledger handle; present when the project has a real DB. */
  db?: VerificationStoreProject["db"];
  judgmentConfig?: JudgmentConfig;
}

/** Ledger sub-result carried in the POST /v1/reviews 201 payload (TASK-1203). */
export interface ReviewLedgerResult {
  applied: boolean;
  skippedReason?: string;
  error?: string;
}

export interface WorkflowRouteDeps {
  resolveProject: (req: Request) => WorkflowRouteProject;
  /** TASK-1301: write-route project resolution — refuses to default to the
   *  active project on multi-project registries (PROJECT_SCOPE_REQUIRED). */
  resolveProjectForWrite: (
    req: Request,
  ) =>
    | { ok: true; project: WorkflowRouteProject }
    | { ok: false; status: number; body: Record<string, unknown> };
  createWorkflowWriter: (
    p: WorkflowRouteProject,
    workflowId: string,
    taskId: string,
    title: string,
  ) => EventWriter;
  resolveAndBroadcastProjection: (
    p: WorkflowRouteProject,
    taskId: string | undefined,
  ) => Promise<unknown>;
  sse: SSEManager;
  /** TASK-1203: the canonical ledger writer, injected for testability. */
  recordVerification: (
    p: VerificationStoreProject,
    entry: VerificationEntry,
    options?: RecordOptions,
    claimantIndex?: DuplicateClaimantIndex,
  ) => Promise<RecordVerificationResult>;
  /** TASK-1203: fired only on an APPLIED ledger write (unblock parity:
   *  federation release + scheduler tick + queue refresh, wired in server.ts).
   *  Failures are caught and logged; they never fail the review response. */
  onLedgerApplied?: (p: WorkflowRouteProject, taskId: string) => Promise<void>;
}

export function registerWorkflowRoutes(app: Express, deps: WorkflowRouteDeps): void {
  const { resolveProject, createWorkflowWriter, resolveAndBroadcastProjection, sse } = deps;

  // ─── Federated verify/fix workflow endpoints ─────────────────────

  app.post("/v1/workflows/verify", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot || !p.taskService) {
      res.status(404).json({ error: "Task service not configured" });
      return;
    }

    const phaseResultSchema = z.object({
      name: z.string().trim().min(1),
      status: z.enum(["passed", "failed", "skipped"]),
      summary: z.string().trim().min(1).optional(),
    });
    const schema = z.object({
      taskId: z.string().trim().min(1),
      workflowId: z.string().trim().min(1).optional(),
      reviewId: z.string().trim().min(1).optional(),
      requireReview: z.boolean().optional(),
      criteriaChecked: z.number().int().nonnegative().optional(),
      criteriaPassed: z.number().int().nonnegative().optional(),
      phaseResults: z.array(phaseResultSchema).optional(),
      notes: z.string().optional(),
    });

    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_verify_workflow_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    try {
      const body = parsed.data;
      const task = await p.taskService.getTask(body.taskId);
      if (!task) {
        res.status(404).json({
          error: "task_not_found",
          message: `Task ${body.taskId} not found.`,
          taskId: body.taskId,
        });
        return;
      }

      const result = await runVerifyWorkflow({
        projectRoot: p.projectRoot,
        task,
        projectId: p.projectId,
        workflowId: body.workflowId,
        reviewId: body.reviewId,
        requireReview: body.requireReview,
        criteriaChecked: body.criteriaChecked,
        criteriaPassed: body.criteriaPassed,
        phaseResults: body.phaseResults,
        notes: body.notes,
      });

      const writer = createWorkflowWriter(p, result.record.workflowId, task.id, task.title);
      writer.recordSession("completed", {
        outcome: `workflow_verify_${result.verdict.toLowerCase()}`,
        title: task.title,
      });
      writer.emit("lifecycle_verify_start", {
        taskId: task.id,
        workflowId: result.record.workflowId,
        projectId: p.projectId,
        reviewId: body.reviewId,
      });
      writer.emit("lifecycle_verify_result", {
        taskId: task.id,
        workflowId: result.record.workflowId,
        projectId: p.projectId,
        verified: result.verdict === "VERIFIED",
        verdict: result.verdict,
        blockReasonCode: result.record.blockReasonCode,
        findings:
          result.record.attempts[0]?.phaseResults.map((phase) => ({
            criterion: phase.name,
            status: phase.status,
            evidence: phase.summary ?? phase.status,
          })) ?? [],
      });
      const projection = await resolveAndBroadcastProjection(p, task.id);

      res.status(result.statusCode).json({
        ok: result.verdict === "VERIFIED",
        verdict: result.verdict,
        workflowId: result.record.workflowId,
        taskId: task.id,
        record: result.record,
        projection,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to run verify workflow: ${msg}` });
    }
  });

  app.post("/v1/workflows/fix", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot || !p.taskService) {
      res.status(404).json({ error: "Task service not configured" });
      return;
    }

    const schema = z.object({
      taskId: z.string().trim().min(1),
      workflowId: z.string().trim().min(1).optional(),
      failureContext: z
        .object({
          issues: z.array(z.string().trim().min(1)).default([]),
        })
        .optional(),
      issues: z.array(z.string().trim().min(1)).optional(),
      fixed: z.boolean().optional(),
      maxAttempts: z.number().int().min(1).max(10).optional(),
    });

    const parsed = schema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_fix_workflow_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }

    try {
      const body = parsed.data;
      const task = await p.taskService.getTask(body.taskId);
      if (!task) {
        res.status(404).json({
          error: "task_not_found",
          message: `Task ${body.taskId} not found.`,
          taskId: body.taskId,
        });
        return;
      }

      const issues = body.failureContext?.issues ?? body.issues ?? [];
      const result = await runFixWorkflow({
        projectRoot: p.projectRoot,
        task,
        projectId: p.projectId,
        workflowId: body.workflowId,
        issues,
        fixed: body.fixed,
        maxAttempts: body.maxAttempts,
      });
      const attempt = result.record.attempts[result.record.attempts.length - 1];
      const writer = createWorkflowWriter(p, result.record.workflowId, task.id, task.title);
      writer.recordSession("completed", {
        outcome: result.exhausted ? "workflow_fix_exhausted" : "workflow_fix_recorded",
        title: task.title,
      });
      writer.emit("lifecycle_fix_start", {
        taskId: task.id,
        workflowId: result.record.workflowId,
        projectId: p.projectId,
        attempt: attempt?.attempt ?? 1,
        issues,
      });
      writer.emit("lifecycle_fix_complete", {
        taskId: task.id,
        workflowId: result.record.workflowId,
        projectId: p.projectId,
        attempt: attempt?.attempt ?? 1,
        fixed: body.fixed === true,
        exhausted: result.exhausted,
      });
      if (result.exhausted) {
        writer.emit("lifecycle_fix_exhausted", {
          taskId: task.id,
          workflowId: result.record.workflowId,
          projectId: p.projectId,
          attempts: result.record.attempts.length,
          remainingIssues: issues,
          blockReasonCode: "workflow_attempts_exhausted",
        });
      }
      const projection = await resolveAndBroadcastProjection(p, task.id);

      res.status(result.statusCode).json({
        ok: !result.exhausted,
        exhausted: result.exhausted,
        workflowId: result.record.workflowId,
        taskId: task.id,
        attempt,
        record: result.record,
        projection,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to run fix workflow: ${msg}` });
    }
  });

  app.get("/v1/workflows/:workflowId", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const workflowId = req.params.workflowId as string;
    const store = new WorkflowStore(p.projectRoot);
    const record = await store.get(workflowId);
    if (!record) {
      res.status(404).json({
        error: "workflow_not_found",
        message: `Workflow ${workflowId} not found.`,
        workflowId,
      });
      return;
    }

    res.json({ ok: true, workflowId, record });
  });

  // ─── Review bundle endpoints ─────────────────────────────────────

  app.get("/v1/reviews", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const reviewsDir = path.join(p.projectRoot, ".quack", "reviews");
    try {
      const entries = await fsPromises.readdir(reviewsDir, { withFileTypes: true });
      const reviewFiles = entries.filter(
        (entry) =>
          entry.isFile() && entry.name.endsWith(".json") && entry.name !== "latest-by-task.json",
      );

      const reviews = (
        await Promise.all(
          reviewFiles.map(async (entry) => {
            try {
              const reviewPath = path.join(reviewsDir, entry.name);
              const raw = await fsPromises.readFile(reviewPath, "utf-8");
              const parsed = JSON.parse(raw) as Record<string, unknown>;
              const gate = parsed.gate as Record<string, unknown> | undefined;
              const mergeReady = gate?.mergeReady === true;
              const verdict = typeof parsed.verdict === "string" ? parsed.verdict : "UNKNOWN";

              return {
                reviewId:
                  typeof parsed.reviewId === "string"
                    ? parsed.reviewId
                    : entry.name.replace(/\.json$/u, ""),
                taskId: typeof parsed.taskId === "string" ? parsed.taskId : "",
                verdict,
                createdAt: typeof parsed.createdAt === "string" ? parsed.createdAt : "",
                updatedAt: typeof parsed.updatedAt === "string" ? parsed.updatedAt : undefined,
                reviewer: typeof parsed.reviewer === "string" ? parsed.reviewer : undefined,
                needsHumanReview: !mergeReady || verdict !== "VERIFIED",
                mergeReady,
                docsImpact: typeof parsed.docsImpact === "string" ? parsed.docsImpact : undefined,
                summary: typeof parsed.summary === "string" ? parsed.summary : undefined,
              };
            } catch {
              return null;
            }
          }),
        )
      ).filter((review): review is NonNullable<typeof review> => review !== null);

      reviews.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      res.json({ reviews });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOENT")) {
        res.json({ reviews: [] });
        return;
      }
      res.status(500).json({ error: `Failed to list reviews: ${message}` });
    }
  });

  app.post("/v1/reviews", async (req: Request, res: Response) => {
    const scope = deps.resolveProjectForWrite(req);
    if (!scope.ok) {
      res.status(scope.status).json(scope.body);
      return;
    }
    const p = scope.project;
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const wikiActionSchema = z.enum(["changelog_entry", "feature_page_update", "support_bundle"]);

    const reviewSchema = z.object({
      taskId: z.string().min(1),
      verdict: z.enum(["VERIFIED", "PARTIAL", "FAILED"]).default("VERIFIED"),
      docsImpact: z
        .enum(["none", "changelog_only", "feature_page_update", "support_bundle"])
        .optional(),
      requiredWikiActions: z.array(wikiActionSchema).optional(),
      wikiArtifacts: z
        .array(
          z.object({
            pagePath: z.string().min(1),
            commitSha: z.string().min(1),
            linkedTaskIds: z.array(z.string().min(1)).default([]),
            action: wikiActionSchema.optional(),
          }),
        )
        .optional(),
      supportDocCandidates: z
        .array(
          z.object({
            title: z.string().min(1),
            summary: z.string().min(1),
            productArea: z.string().optional(),
            linkedTaskIds: z.array(z.string().min(1)).optional(),
            tags: z.array(z.string().min(1)).optional(),
          }),
        )
        .optional(),
      findings: z
        .array(
          z.object({
            title: z.string().min(1),
            severity: z.enum(["P1", "P2", "P3"]),
            status: z.enum(["open", "resolved", "waived"]).optional(),
            file: z.string().optional(),
          }),
        )
        .optional(),
      summary: z.string().optional(),
      reviewNotes: z.string().optional(),
      reviewer: z.string().optional(),
      /** TASK-1203: the code commit this review verified; recorded on the ledger row. */
      commitSha: z.string().trim().min(1).optional(),
    });

    const parsed = reviewSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid review payload",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    try {
      const input = parsed.data;
      const docsImpact: DocsImpact =
        input.docsImpact ?? (input.verdict === "VERIFIED" ? "changelog_only" : "none");

      let taskContent: string | undefined;
      let taskFilePath: string | null | undefined;
      if (p.taskService) {
        taskFilePath =
          (await p.taskService.getTaskFilePath(input.taskId)) ??
          (await p.taskService.getRawTaskFilePath(input.taskId));
        if (taskFilePath) {
          try {
            taskContent = await fsPromises.readFile(taskFilePath, "utf-8");
          } catch {
            taskContent = undefined;
          }
        }
      }

      const gate = await evaluateReviewGateWithJudgment(
        {
          ...input,
          docsImpact,
        } as ReviewBundleInput,
        taskContent,
        { config: p.judgmentConfig },
      );

      const reviewId = `review-${input.taskId.toLowerCase()}-${Date.now()}`;
      const createdAt = new Date().toISOString();
      const requiredWikiActions: WikiAction[] =
        gate.requiredWikiActions.length > 0
          ? gate.requiredWikiActions
          : requiredActionsForDocsImpact(docsImpact);

      const persisted = {
        ...input,
        docsImpact,
        requiredWikiActions,
        reviewId,
        createdAt,
        gate,
      };

      const reviewPath = await persistReviewBundle(p.projectRoot, persisted);

      if (gate.judgmentDecision || gate.judgmentProjectionFailure) {
        const reviewWriter = createWorkflowWriter(
          p,
          reviewId,
          input.taskId,
          `Docs review ${input.taskId}`,
        );
        if (gate.judgmentOrchestration) {
          reviewWriter.emit("judgment_evaluation", {
            taskId: input.taskId,
            stage: "docs_review",
            sequence: 0,
            final: false,
            orchestration: gate.judgmentOrchestration,
          });
        }
        if (gate.judgmentDecision) {
          reviewWriter.emit("judgment_decision", {
            taskId: input.taskId,
            stage: "docs_review",
            sequence: gate.judgmentOrchestration ? 1 : 0,
            final: true,
            decision: gate.judgmentDecision,
          });
        } else if (gate.judgmentProjectionFailure) {
          reviewWriter.emit("judgment_projection_failed", {
            taskId: input.taskId,
            stage: "docs_review",
            ...gate.judgmentProjectionFailure,
          });
        }
      }

      // ─── TASK-1203: verified-ledger bridge ─────────────────────
      // Ordering contract: persist → judgment SSE → bridge → docs pipeline.
      // The bridge is isolated: a ledger failure surfaces as
      // ledger.error in the 201 payload and never breaks the review
      // flow that existed before it.
      let ledger: ReviewLedgerResult | undefined;
      // TASK-1328: the ledger write is NOT gated on the docs gate.
      // `mergeReady` is a judgment about DOCS DEBT; the verified row is a
      // fact about whether the work was verified. Letting one decide the
      // other produced the worst available failure: `persistReviewBundle`
      // runs above, so a 422 left a healthy-LOOKING review bundle on disk
      // with no canonical row behind it, and an operator who read the
      // bundle back - the obvious check - saw a closed task. Four example
      // rows sat like that on 2026-08-10 (TOTAL_VERIFIED=611, MATCHED=0
      // for TASK-1284/1288/1289/1290) while the hub reasonably believed
      // they were closed. The gate still blocks merge-readiness, still
      // returns 422, and the docs pipeline below is still gated on it.
      // The unmet actions stay in the REVIEW BUNDLE, which holds them
      // structurally; they are deliberately NOT stamped into the row,
      // because `skipIfExistingVerdict` would make that breadcrumb
      // permanent and it would outlive the debt it describes.
      if (input.verdict === "VERIFIED" && blockedOnlyByDocsDebt(gate)) {
        if (!taskFilePath) {
          // Phantom ids may exist in the closure store, but they never
          // reach the verified ledger or task_status (mirrors the
          // on-merge scanner's unregistered rule).
          ledger = { applied: false, skippedReason: "unknown-task" };
        } else if (p.db && p.projectRoot) {
          try {
            const taskService = p.taskService;
            const claimantIndex = await buildStrictDuplicateClaimantIndex(
              taskService
                ? () => listTaskClaimantDeclarations(taskService.getTaskDirectory())
                : undefined,
            );
            const result = await deps.recordVerification(
              { projectRoot: p.projectRoot, db: p.db },
              {
                taskId: input.taskId,
                verdict: "VERIFIED",
                commitSha: input.commitSha ?? "unknown",
                method: "v1-review",
                criteriaChecked: 0,
                criteriaPassed: 0,
                reviewId,
                notes: input.summary,
              },
              { skipIfExistingVerdict: ["VERIFIED"] },
              claimantIndex,
            );
            ledger = { applied: result.applied, skippedReason: result.skippedReason };
            if (result.applied && deps.onLedgerApplied) {
              try {
                await deps.onLedgerApplied(p, input.taskId);
              } catch (err: unknown) {
                const msg = err instanceof Error ? err.message : String(err);
                console.error(
                  `[reviews-bridge] onLedgerApplied failed for ${input.taskId}: ${msg}`,
                );
              }
            }
          } catch (err: unknown) {
            const msg = err instanceof Error ? err.message : String(err);
            ledger = { applied: false, error: msg };
            console.error(`[reviews-bridge] ledger write failed for ${input.taskId}: ${msg}`);
          }
        }
      }

      let docsPipeline: Record<string, unknown> | undefined;
      if (gate.mergeReady && input.verdict === "VERIFIED") {
        const pipeline = await runDocsPipeline(p.projectRoot, persisted);
        docsPipeline = {
          changelogPath: pipeline.changelogPath,
          featureUpdatesPath: pipeline.featureUpdatesPath,
          supportContentPath: pipeline.supportContentPath,
          emittedSupportRecords: pipeline.emittedSupportRecords,
        };

        sse.broadcast({
          sessionId: "docs",
          taskId: input.taskId,
          project: p.projectId,
          timestamp: new Date().toISOString(),
          stage: "docs_change_event",
          payload: {
            reviewId,
            taskId: input.taskId,
            docsImpact,
            requiredWikiActions,
            wikiArtifacts: input.wikiArtifacts?.length ?? 0,
            supportDocCandidates: input.supportDocCandidates?.length ?? 0,
            mergeReady: gate.mergeReady,
          },
        });
      }

      const responsePayload = {
        ok: gate.mergeReady,
        mergeReady: gate.mergeReady,
        reviewId,
        taskId: input.taskId,
        verdict: input.verdict,
        docsImpact,
        requiredWikiActions,
        gate,
        reviewPath,
        docsPipeline,
        ledger,
      };

      if (!gate.mergeReady) {
        res.status(422).json(responsePayload);
        return;
      }

      res.status(201).json(responsePayload);
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to persist review: ${msg}` });
    }
  });

  app.get("/v1/reviews/:id", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const reviewId = req.params.id as string;
    const reviewPath = path.join(p.projectRoot, ".quack", "reviews", `${reviewId}.json`);
    try {
      const raw = await fsPromises.readFile(reviewPath, "utf-8");
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      res.json({ ok: true, reviewId, reviewPath, review: parsed });
    } catch {
      res.status(404).json({
        error: "review_not_found",
        message: `Review bundle ${reviewId} not found.`,
        reviewId,
      });
    }
  });

  // ─── Job-level events (docs-change ledger) ───────────────────────

  app.post("/v1/jobs/:id/events", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const payloadSchema = z.object({
      eventType: z.literal("docs_change_event"),
      taskId: z.string().optional(),
      timestamp: z.string().optional(),
      payload: z.object({
        docsImpact: z.enum(["none", "changelog_only", "feature_page_update", "support_bundle"]),
        requiredWikiActions: z
          .array(z.enum(["changelog_entry", "feature_page_update", "support_bundle"]))
          .optional(),
        wikiArtifacts: z
          .array(
            z.object({
              pagePath: z.string().min(1),
              commitSha: z.string().min(1),
              linkedTaskIds: z.array(z.string().min(1)).default([]),
              action: z
                .enum(["changelog_entry", "feature_page_update", "support_bundle"])
                .optional(),
            }),
          )
          .optional(),
        supportDocCandidates: z
          .array(
            z.object({
              title: z.string().min(1),
              summary: z.string().min(1),
            }),
          )
          .optional(),
        summary: z.string().optional(),
      }),
    });

    const parsed = payloadSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "Invalid job event payload",
        details: parsed.error.issues.map((issue) => ({
          path: issue.path.join("."),
          message: issue.message,
        })),
      });
      return;
    }

    try {
      const jobId = req.params.id as string;
      const body = parsed.data;
      const event = {
        jobId,
        eventType: body.eventType,
        taskId: body.taskId ?? "",
        timestamp: body.timestamp ?? new Date().toISOString(),
        payload: body.payload,
      };

      const eventDir = path.join(p.projectRoot, ".quack", "docs-pipeline", "job-events");
      await fsPromises.mkdir(eventDir, { recursive: true });
      const eventPath = path.join(eventDir, `${jobId}.jsonl`);
      await fsPromises.appendFile(eventPath, JSON.stringify(event) + "\n", "utf-8");

      sse.broadcast({
        sessionId: `job-${jobId}`,
        taskId: body.taskId ?? "",
        project: p.projectId,
        timestamp: event.timestamp,
        stage: "docs_change_event",
        payload: {
          ...body.payload,
          taskId: body.taskId ?? "",
          jobId,
        },
      });

      res.status(202).json({
        ok: true,
        accepted: true,
        jobId,
        eventType: body.eventType,
        eventPath,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: `Failed to persist job event: ${msg}` });
    }
  });

  // ─── Support content tail ────────────────────────────────────────

  app.get("/v1/support-content", async (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(404).json({ error: "Project root not configured" });
      return;
    }

    const rawLimit = Number(req.query.limit);
    const limit =
      Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(Math.floor(rawLimit), 500) : 100;
    const since = typeof req.query.since === "string" ? req.query.since : undefined;
    const taskIdFilter = typeof req.query.taskId === "string" ? req.query.taskId : undefined;

    const supportPath = path.join(
      p.projectRoot,
      ".quack",
      "docs-pipeline",
      "support-content.jsonl",
    );
    try {
      const raw = await fsPromises.readFile(supportPath, "utf-8");
      const lines = raw
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0);

      const records: Array<Record<string, unknown>> = [];
      for (let i = lines.length - 1; i >= 0; i -= 1) {
        try {
          const parsed = JSON.parse(lines[i]) as Record<string, unknown>;
          const generatedAt = typeof parsed.generatedAt === "string" ? parsed.generatedAt : "";
          const taskId = typeof parsed.taskId === "string" ? parsed.taskId : "";

          if (since && generatedAt && generatedAt < since) continue;
          if (taskIdFilter && taskIdFilter !== taskId) continue;

          records.push(parsed);
          if (records.length >= limit) break;
        } catch {
          // ignore malformed lines
        }
      }

      res.json({
        ok: true,
        count: records.length,
        limit,
        since: since ?? null,
        taskId: taskIdFilter ?? null,
        records,
      });
    } catch {
      res.json({
        ok: true,
        count: 0,
        limit,
        since: since ?? null,
        taskId: taskIdFilter ?? null,
        records: [],
      });
    }
  });
}
