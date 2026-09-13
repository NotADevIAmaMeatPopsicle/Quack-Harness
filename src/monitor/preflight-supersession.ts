import * as fs from "node:fs";
import * as path from "node:path";
import type { ProjectAdapter } from "../core/adapter-loader.js";
import { generateProjectId } from "../core/project-id.js";
import { resolveAuthoritativeProjectRoot } from "../core/task-state-overlay.js";
import { computeSchemaPolicyHash } from "../gate/schema-policy.js";
import type { BlueprintApproval } from "../dispatcher/blueprint-approval.js";
import type { PreflightResult } from "../preflight/preflight-types.js";
import { computeContentHash } from "./prep-cache.js";
import { PreflightJobStore, type PreflightJob } from "./preflight-job-store.js";

/** Follow the same managed-worktree topology as authoritative task identity.
 * Check every candidate so a worktree-local DB cannot hide its owner's barrier. */
function stores(adapter: ProjectAdapter): PreflightJobStore[] {
  const roots = resolveAuthoritativeProjectRoot(adapter.projectRoot).candidates;
  return [...new Set(roots.map((root) => fs.realpathSync(root)))].map((root) =>
    new PreflightJobStore(root, generateProjectId(adapter.config.project.name)));
}

export async function assertNoPreflightSupersession(adapter: ProjectAdapter, taskId: string): Promise<void> {
  for (const store of stores(adapter)) {
    await store.repairTerminalIndex(taskId);
    const job = store.supersession(taskId);
    if (job) throw new Error(`PREFLIGHT_REPLAN_PENDING: ${taskId} replacement ${job.jobId} is ${job.status}; finish or recover replan before dispatch.`);
  }
}

/** This receipt retires exactly one rejected record; never an approved/pending one. */
export function replacementForRejection(adapter: ProjectAdapter, taskId: string, logDir: string,
  approval: BlueprintApproval | null, contentHash: string): PreflightJob | undefined {
  if (approval?.state !== "rejected") return undefined;
  const filename = path.join(logDir, "approvals", `${taskId}.json`);
  const raw = fs.readFileSync(filename, "utf8");
  if (JSON.stringify(JSON.parse(raw)) !== JSON.stringify(approval)) return undefined;
  const approvalDirectory = fs.realpathSync(logDir);
  const digest = computeContentHash(raw);
  for (const store of stores(adapter)) {
    const job = store.completedReplan(taskId);
    if (job?.replan && job.result && job.replan.approvalDigest === digest &&
      fs.realpathSync(job.replan.approvalLogDir) === approvalDirectory &&
      job.result.contentHash === contentHash &&
      job.input.schemaPolicyHash === computeSchemaPolicyHash(adapter.config.gate?.requiredSections) &&
      job.input.readinessJudgmentMode === (adapter.config.judgment?.stages.readiness.mode ?? "off")) return job;
  }
  return undefined;
}

export function consumesReplacement(report: PreflightResult | undefined, job: PreflightJob | undefined): boolean {
  return !!report && !!job?.result && report.timestamp === job.result.timestamp &&
    report.contentHash === job.result.contentHash && report.schemaPolicyHash === job.result.schemaPolicyHash &&
    JSON.stringify(report.blueprint) === JSON.stringify(job.result.blueprint) && !report.blueprint.structuredPreserved;
}
