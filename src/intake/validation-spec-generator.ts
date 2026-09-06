import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";

import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { ValidationIntakePayload } from "./task-intake.js";

/**
 * Arguments for {@link generateValidationSpec}.
 *
 * - `projectRoot` — absolute path to the target project root. Must equal
 *   `adapter.projectRoot`; passed explicitly so callers don't accidentally
 *   target a different root than the adapter was loaded for.
 * - `adapter` — loaded project adapter; `adapter.config.project.taskDir`
 *   determines where the generated TASK-NNNN-<slug>.md lands. NO hardcoded
 *   `docs/tasks/` fallback per blueprint §13 risk: spec-generator reads
 *   adapter.config.project.taskDir only.
 * - `intakeId` — the IntakeStore record id (e.g. `intake-abcdef0123456789`).
 *   Drives the evidence sub-directory at
 *   `.quack/intake/<intakeId>/evidence/`.
 * - `payload` — the validated `ValidationIntakePayload` from a passed-gates
 *   submission.
 */
export interface ValidationSpecGeneratorArgs {
  projectRoot: string;
  adapter: ProjectAdapter;
  intakeId: string;
  payload: ValidationIntakePayload;
}

/**
 * Result of a successful {@link generateValidationSpec} call.
 *
 * - `taskId` — newly allocated `TASK-NNNN` id (or the existing id if the
 *   call is replaying an earlier idempotent submission).
 * - `specPath` — absolute path to the freshly-written spec file under the
 *   adapter-declared task directory.
 * - `evidencePath` — absolute path to the per-intake evidence directory
 *   (`<projectRoot>/.quack/intake/<intakeId>/evidence/`).
 */
export interface ValidationSpecGeneratorResult {
  taskId: string;
  specPath: string;
  evidencePath: string;
}

/**
 * Generate a deterministic validation-intake spec file for a passed-gates
 * payload.
 *
 * MVP contract (per TASK-1106 Blueprint §3 spec-generator notes):
 *  - Project-aware: uses `adapter.config.project.taskDir` (NO hardcoded
 *    `docs/tasks/` fallback). Honours example's
 *    `docs/page-by-page-audit/follow-up-tasks/` overlay.
 *  - Deterministic template render — NO Agent SDK call. Same input ⇒
 *    same output, byte-for-byte (subject to existing-id allocation when
 *    re-running against a directory that already contains the previously
 *    written file).
 *  - Atomic write: mirrors `planner/task-writer.ts:140-194` (tmp file then
 *    rename; cleanup on failure; `.plan.lock` to prevent concurrent
 *    allocator races).
 *  - Idempotent: when a TASK file for this submission already exists
 *    (matched by intakeId-derived slug + payload content fingerprint
 *    embedded in the spec metadata), the existing taskId + path is
 *    returned without rewriting.
 *  - Evidence: copies referenced repo-relative files (from
 *    `payload.tests[].evidence` and `payload.screenshots[].file`) into
 *    `<projectRoot>/.quack/intake/<intakeId>/evidence/`. URL-shaped
 *    pointers (http://, https://) are recorded in the spec but NOT
 *    fetched (admin verifies out-of-band).
 *
 * @param args see {@link ValidationSpecGeneratorArgs}.
 * @returns the allocated taskId, the absolute spec path, and the absolute
 *   per-intake evidence directory path.
 * @throws if the adapter taskDir is missing/invalid, the task allocator
 *   cannot acquire the `.plan.lock`, or filesystem I/O fails. NEVER throws
 *   on an already-extant matching spec — that case returns the existing id.
 */
export async function generateValidationSpec(
  args: ValidationSpecGeneratorArgs,
): Promise<ValidationSpecGeneratorResult> {
  const { projectRoot, adapter, intakeId, payload } = args;

  // ── 1. Resolve target task dir from adapter (no hardcoded fallback). ──
  const taskDirRel = adapter.config.project.taskDir;
  if (!taskDirRel || taskDirRel.trim().length === 0) {
    throw new Error("Adapter config.project.taskDir is empty; cannot place validation spec.");
  }
  const taskDir = path.resolve(projectRoot, taskDirRel);
  await fs.mkdir(taskDir, { recursive: true });

  // Evidence directory is per-intake; always created so callers can safely
  // assume the dir exists when reading evidencePath back.
  const evidenceDir = path.resolve(projectRoot, ".quack", "intake", intakeId, "evidence");
  await fs.mkdir(evidenceDir, { recursive: true });

  // ── 2. Compute the payload fingerprint and target slug. ─────────────
  // Fingerprint encodes the inputs that DEFINE this submission:
  //   (project, branch, commitRange) — the natural key from blueprint §6.
  // It is embedded in the spec metadata and is what idempotency checks
  // against when scanning existing files.
  const fingerprint = computePayloadFingerprint(payload);
  const slug = buildSlug(payload, fingerprint);

  // ── 3. Idempotency check. ──────────────────────────────────────────
  // Walk the task dir; if any existing TASK-NNNN file already encodes
  // the same fingerprint in its metadata, return it.
  const existingMatch = await findExistingSpecByFingerprint(taskDir, fingerprint);
  if (existingMatch) {
    return {
      taskId: existingMatch.taskId,
      specPath: existingMatch.specPath,
      evidencePath: evidenceDir,
    };
  }

  // ── 4. Allocate next free TASK-NNNN id. ────────────────────────────
  // Lock around id allocation + write to prevent concurrent submissions
  // racing for the same numeric id. Mirrors task-writer.ts:140-194.
  const lockPath = path.join(taskDir, ".plan.lock");
  try {
    await fs.writeFile(lockPath, `${process.pid}\n${new Date().toISOString()}\n`, { flag: "wx" });
  } catch {
    throw new Error(`Another plan operation is in progress. If stale, delete ${lockPath}`);
  }

  const fileName = `__pending__-${process.pid}-${Date.now()}`;
  const tempPath = path.join(taskDir, `${fileName}.tmp`);
  let finalSpecPath: string | undefined;

  try {
    // After acquiring the lock, re-check for an existing match — another
    // worker may have written between our pre-lock scan and now.
    const lateMatch = await findExistingSpecByFingerprint(taskDir, fingerprint);
    if (lateMatch) {
      return {
        taskId: lateMatch.taskId,
        specPath: lateMatch.specPath,
        evidencePath: evidenceDir,
      };
    }

    const existingIds = await getExistingTaskIds(taskDir);
    const taskId = allocateNextTaskId(existingIds);

    // ── 5. Copy referenced evidence files. ─────────────────────────
    // Done BEFORE writing the spec so the spec's Evidence Bundle section
    // can list the actually-copied destination paths (relative).
    const copyReport = await copyEvidenceFiles({
      projectRoot,
      evidenceDir,
      tests: payload.tests,
      screenshots: payload.screenshots,
    });

    // ── 6. Render the spec body. ───────────────────────────────────
    const content = renderValidationSpec({
      taskId,
      intakeId,
      payload,
      fingerprint,
      copyReport,
    });

    // ── 7. Atomic write: tmp file then rename. ─────────────────────
    const finalName = `${taskId}-${slug}.md`;
    finalSpecPath = path.join(taskDir, finalName);

    await fs.writeFile(tempPath, content, "utf-8");
    await fs.rename(tempPath, finalSpecPath);

    return {
      taskId,
      specPath: finalSpecPath,
      evidencePath: evidenceDir,
    };
  } catch (err) {
    // Cleanup on failure — leave no half-written tmp files behind.
    await fs.unlink(tempPath).catch(() => {});
    if (finalSpecPath) {
      await fs.unlink(finalSpecPath).catch(() => {});
    }
    throw err;
  } finally {
    await fs.unlink(lockPath).catch(() => {});
  }
}

// ─── Internal helpers ───────────────────────────────────────────────

/**
 * Stable fingerprint of the submission's natural key. Used for idempotency
 * detection across re-POSTs of the same (project, branch, commitRange).
 *
 * Returns the 16-char prefix of a sha256 hash — long enough to make
 * collision cryptographically negligible and short enough to read in
 * a spec metadata header.
 */
function computePayloadFingerprint(payload: ValidationIntakePayload): string {
  const seed = `${payload.project}${payload.branch}${payload.commitRange}`;
  return crypto.createHash("sha256").update(seed).digest("hex").slice(0, 16);
}

/**
 * Build a filesystem-safe slug for the generated spec filename. Uses the
 * branch name as the visible label and appends the fingerprint to keep
 * filenames unique across same-branch resubmissions in unrelated commit
 * ranges (cannot occur in practice because the idempotency check fires
 * first, but the slug stays stable so repeat scans land on the same name).
 */
function buildSlug(payload: ValidationIntakePayload, fingerprint: string): string {
  const branchPart = payload.branch
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  const safeBranch = branchPart.length > 0 ? branchPart : "validation";
  return `validate-${safeBranch}-${fingerprint.slice(0, 8)}`;
}

interface ExistingSpecMatch {
  taskId: string;
  specPath: string;
}

/**
 * Scan the task directory for a previously-generated validation spec
 * whose embedded fingerprint matches the provided value. Returns the
 * first hit (deterministic ordering: ascending TASK-NNNN id).
 *
 * The fingerprint lives in a `<!-- validation-fingerprint: XXXX -->`
 * HTML comment immediately after the `# TASK-NNNN: ...` header. Spec
 * files generated by other paths (forward intake, planner) don't carry
 * this comment and are skipped.
 */
async function findExistingSpecByFingerprint(
  taskDir: string,
  fingerprint: string,
): Promise<ExistingSpecMatch | undefined> {
  let entries: string[];
  try {
    entries = await fs.readdir(taskDir);
  } catch {
    return undefined;
  }

  const specFiles = entries.filter((entry) => /^TASK-\d{3,}.*\.md$/.test(entry)).sort();

  for (const entry of specFiles) {
    const filePath = path.join(taskDir, entry);
    let head: string;
    try {
      // Read only the first 4 KB — fingerprint is in the metadata header.
      const handle = await fs.open(filePath, "r");
      try {
        const buf = Buffer.alloc(4096);
        const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
        head = buf.subarray(0, bytesRead).toString("utf-8");
      } finally {
        await handle.close();
      }
    } catch {
      continue;
    }

    if (head.includes(`validation-fingerprint: ${fingerprint}`)) {
      const idMatch = entry.match(/^(TASK-\d{3,})/);
      if (idMatch) {
        return { taskId: idMatch[1], specPath: filePath };
      }
    }
  }
  return undefined;
}

/**
 * Mirror of `planner/task-writer.ts::getExistingTaskIds` — scans the task
 * directory and returns the set of allocated TASK-NNN ids (3+ digits).
 *
 * Kept private here rather than importing from task-writer so the spec
 * generator has zero coupling to the planner module.
 */
async function getExistingTaskIds(taskDir: string): Promise<Set<string>> {
  try {
    const entries = await fs.readdir(taskDir);
    const ids = new Set<string>();
    for (const entry of entries) {
      const match = entry.match(/^(TASK-(\d{3,}))/);
      if (match) ids.add(match[1]);
    }
    return ids;
  } catch {
    return new Set();
  }
}

/**
 * Allocate the next free `TASK-NNNN` id by scanning the existing-id set
 * for the highest numeric suffix and incrementing.
 *
 * Pads to at least 4 digits (the TASK-1100+ generation; example backlog is
 * already past TASK-1000). Existing TASK-NNN three-digit ids continue to
 * be honored — they don't collide because we always allocate above the
 * current maximum.
 */
function allocateNextTaskId(existingIds: Set<string>): string {
  let maxNum = 0;
  for (const id of existingIds) {
    const match = id.match(/^TASK-(\d+)$/);
    if (match) {
      const num = Number.parseInt(match[1], 10);
      if (Number.isFinite(num) && num > maxNum) {
        maxNum = num;
      }
    }
  }
  const next = maxNum + 1;
  const padded = String(next).padStart(4, "0");
  return `TASK-${padded}`;
}

interface CopiedEvidenceItem {
  originalRef: string;
  destination: string;
  category: "test" | "screenshot";
  status: "copied" | "url-skipped" | "missing-source";
}

interface CopyEvidenceArgs {
  projectRoot: string;
  evidenceDir: string;
  tests: ValidationIntakePayload["tests"];
  screenshots: ValidationIntakePayload["screenshots"];
}

interface CopyEvidenceReport {
  items: CopiedEvidenceItem[];
}

/**
 * Copy each test-evidence + screenshot file referenced in the payload into
 * the per-intake evidence directory. URL-shaped references are recorded
 * verbatim in the report (status: `url-skipped`) — the admin verifies the
 * remote artifact out-of-band. Missing source files do not throw; the spec
 * surfaces the failure so the reviewer can act.
 */
async function copyEvidenceFiles(args: CopyEvidenceArgs): Promise<CopyEvidenceReport> {
  const { projectRoot, evidenceDir, tests, screenshots } = args;
  const items: CopiedEvidenceItem[] = [];

  const seenDestinations = new Set<string>();

  for (const test of tests) {
    const item = await copySingle({
      projectRoot,
      evidenceDir,
      reference: test.evidence,
      category: "test",
      seenDestinations,
    });
    items.push(item);
  }
  for (const screenshot of screenshots) {
    const item = await copySingle({
      projectRoot,
      evidenceDir,
      reference: screenshot.file,
      category: "screenshot",
      seenDestinations,
    });
    items.push(item);
  }

  return { items };
}

interface CopySingleArgs {
  projectRoot: string;
  evidenceDir: string;
  reference: string;
  category: "test" | "screenshot";
  seenDestinations: Set<string>;
}

async function copySingle(args: CopySingleArgs): Promise<CopiedEvidenceItem> {
  const { projectRoot, evidenceDir, reference, category, seenDestinations } = args;

  // URL-shaped refs: record but do NOT fetch.
  if (/^https?:\/\//i.test(reference)) {
    return {
      originalRef: reference,
      destination: reference,
      category,
      status: "url-skipped",
    };
  }

  // Resolve to an absolute source path. Absolute refs are honored as-is;
  // relative refs are resolved against the project root.
  const sourcePath = path.isAbsolute(reference) ? reference : path.resolve(projectRoot, reference);

  let destName = sanitizeEvidenceDestName(reference);
  // Ensure uniqueness if two entries reference the same basename.
  let dedupSuffix = 1;
  while (seenDestinations.has(destName)) {
    const ext = path.extname(destName);
    const base = ext.length > 0 ? destName.slice(0, -ext.length) : destName;
    destName = `${base}-${dedupSuffix}${ext}`;
    dedupSuffix++;
  }
  seenDestinations.add(destName);
  const destination = path.join(evidenceDir, destName);

  try {
    const stat = await fs.stat(sourcePath);
    if (!stat.isFile()) {
      return {
        originalRef: reference,
        destination,
        category,
        status: "missing-source",
      };
    }
    await fs.copyFile(sourcePath, destination);
    return {
      originalRef: reference,
      destination,
      category,
      status: "copied",
    };
  } catch {
    return {
      originalRef: reference,
      destination,
      category,
      status: "missing-source",
    };
  }
}

/**
 * Convert an evidence reference (possibly with sub-directories) into a
 * single safe filename for the flat per-intake evidence directory.
 * Replaces path separators with `__` so the original layout is recoverable
 * by inspection but no nested mkdir is needed.
 */
function sanitizeEvidenceDestName(reference: string): string {
  // Strip any leading `./` and normalize path separators to `/`.
  const trimmed = reference.replace(/^\.\/+/, "").replace(/\\/g, "/");
  // Drop drive letters (e.g. `C:`) — keep just the path portion.
  const noDrive = trimmed.replace(/^[A-Za-z]:/, "");
  // Strip leading slash so the result is always a relative filename.
  const noLead = noDrive.replace(/^\/+/, "");
  // Flatten and sanitize: any character outside the safe set becomes `_`.
  const flattened = noLead.replace(/\//g, "__");
  const safe = flattened.replace(/[^A-Za-z0-9._-]+/g, "_");
  return safe.length > 0 ? safe : "evidence";
}

interface RenderArgs {
  taskId: string;
  intakeId: string;
  payload: ValidationIntakePayload;
  fingerprint: string;
  copyReport: CopyEvidenceReport;
}

/**
 * Render the deterministic markdown body for a validation-intake spec.
 *
 * Required sections (per Blueprint §3, §10, and spec-generator test cases
 * c/d/e/f):
 *   - `# TASK-NNNN: Validate <branch>` header followed by fingerprint
 *     comment.
 *   - `## Metadata` — Priority, Effort, Status (VERIFYING), Intake Type
 *     (validation), Intake ID, Submitter, Submitted At.
 *   - `## Already Built` — branch, commitRange, scope (verbatim).
 *   - `## What This Task Validates` — derived checklist of scope × tests.
 *   - `## Evidence Bundle` — every test + screenshot reference with its
 *     copy status.
 *   - `## Non-Claims` — verbatim payload.nonClaims (empty marker if not
 *     supplied; the Quack-side evidence gate handles non-bypass rule).
 *   - `## Known Risks` — verbatim payload.knownRisks (or "None declared").
 *   - `## Success Criteria` — handoff line + admin-verify expectation.
 *   - `## Testing Requirements` — re-run / re-verify checklist.
 */
function renderValidationSpec(args: RenderArgs): string {
  const { taskId, intakeId, payload, fingerprint, copyReport } = args;
  const lines: string[] = [];

  const headerTitle = `Validate ${payload.branch}`;
  lines.push(`# ${taskId}: ${headerTitle}`);
  lines.push(`<!-- validation-fingerprint: ${fingerprint} -->`);
  lines.push("");

  // ── Metadata ───────────────────────────────────────────────────────
  lines.push("## Metadata");
  lines.push("- **Priority:** P2-MEDIUM");
  lines.push("- **Effort:** S");
  lines.push("- **Status:** VERIFYING");
  lines.push("- **Intake Type:** validation");
  lines.push("- **Schema Version:** 1");
  lines.push(`- **Intake ID:** ${intakeId}`);
  lines.push(`- **Submitter:** ${payload.submitter}`);
  lines.push(`- **Submitted At:** ${payload.submittedAt}`);
  lines.push(`- **Project:** ${payload.project}`);
  lines.push("- **Blocked By:** []");
  lines.push("- **Blocks:** []");
  lines.push("- **Tags:** [validation-intake]");
  lines.push("");

  // ── Already Built ─────────────────────────────────────────────────
  lines.push("## Already Built");
  lines.push("");
  lines.push(
    "This task wraps a branch the submitter has already implemented; Quack ran the scope-hygiene and evidence gates and accepted the bundle for admin verification.",
  );
  lines.push("");
  lines.push(`- **Branch:** \`${payload.branch}\``);
  lines.push(`- **Commit Range:** \`${payload.commitRange}\``);
  lines.push("- **Scope (claimed files):**");
  for (const file of payload.scope) {
    lines.push(`  - \`${file}\``);
  }
  lines.push("");

  // ── What This Task Validates ──────────────────────────────────────
  lines.push("## What This Task Validates");
  lines.push("");
  lines.push("Admin runs `/verify-task` against the branch above and confirms each item below.");
  lines.push("");
  for (const file of payload.scope) {
    lines.push(`- [ ] \`${file}\` — changes match the submitted scope`);
  }
  for (const test of payload.tests) {
    lines.push(
      `- [ ] Test \`${test.name}\` — result \`${test.result}\` (evidence: \`${test.evidence}\`)`,
    );
  }
  lines.push("");

  // ── Evidence Bundle ───────────────────────────────────────────────
  lines.push("## Evidence Bundle");
  lines.push("");
  lines.push(
    "Files copied into `.quack/intake/<intakeId>/evidence/`. URL references are recorded verbatim — the admin verifies them out-of-band.",
  );
  lines.push("");
  if (copyReport.items.length === 0) {
    lines.push("- _(no evidence references in payload)_");
  } else {
    lines.push("| Category | Reference | Destination | Status |");
    lines.push("|----------|-----------|-------------|--------|");
    for (const item of copyReport.items) {
      const destDisplay =
        item.status === "url-skipped" ? item.destination : path.basename(item.destination);
      lines.push(
        `| ${item.category} | \`${item.originalRef}\` | \`${destDisplay}\` | ${item.status} |`,
      );
    }
  }
  lines.push("");

  // ── Non-Claims ────────────────────────────────────────────────────
  lines.push("## Non-Claims");
  lines.push("");
  lines.push(
    "Files / areas / behaviors this branch deliberately does NOT cover. Suppresses scope-drift REVISE in the scope-hygiene gate.",
  );
  lines.push("");
  if (payload.nonClaims.length === 0) {
    lines.push("- _(none declared — evidence gate enforces non-empty)_");
  } else {
    for (const claim of payload.nonClaims) {
      lines.push(`- ${claim}`);
    }
  }
  lines.push("");

  // ── Known Risks ───────────────────────────────────────────────────
  lines.push("## Known Risks");
  lines.push("");
  if (payload.knownRisks.length === 0) {
    lines.push("- _(none declared)_");
  } else {
    for (const risk of payload.knownRisks) {
      lines.push(`- ${risk}`);
    }
  }
  lines.push("");

  // ── Success Criteria ──────────────────────────────────────────────
  lines.push("## Success Criteria");
  lines.push("");
  lines.push("- [ ] Admin `/verify-task` PASS for the branch, against scope + tests above");
  lines.push('- [ ] Verified record written with `method: "validation-intake"` + `reviewId`');
  lines.push("- [ ] All evidence items in this spec reproducible from the recorded paths");
  lines.push("");

  // ── Testing Requirements ──────────────────────────────────────────
  lines.push("## Testing Requirements");
  lines.push("");
  lines.push(
    "- [ ] Re-run every test listed in `What This Task Validates` and confirm result matches the submission",
  );
  lines.push(
    "- [ ] Confirm `git diff --name-only " +
      payload.commitRange +
      "` against `scope` + `nonClaims` (admin runs `/verify-task` scope-hygiene phase)",
  );
  lines.push("- [ ] Visually inspect every screenshot listed in the Evidence Bundle");
  lines.push("");

  // ── Context References ────────────────────────────────────────────
  lines.push("## Context References");
  lines.push("");
  lines.push(`- Intake record: \`.quack/intake/${intakeId}/\``);
  lines.push(`- Evidence bundle: \`.quack/intake/${intakeId}/evidence/\``);
  lines.push("- See `docs/QUACK_ADMIN_OPERATING_MANUAL.md` §Validation Intake");
  lines.push("");

  return lines.join("\n");
}
