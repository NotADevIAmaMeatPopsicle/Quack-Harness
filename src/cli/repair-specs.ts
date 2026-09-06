// ─── repair-specs CLI ───────────────────────────────────────────────
// Batch-run the deterministic, intent-safe spec normalizer over a task
// directory. Dry-run by default: reports which unparseable specs are
// deterministically repairable (and how) without touching any file.
// With --write, repaired content is written back.
//
// This is the operator tool for pre-existing backlogs: the task watcher
// only repairs on file add/change events (ignoreInitial), so specs that
// were already failing when the monitor started never get repaired by it.

import * as fs from "node:fs";
import * as path from "node:path";
import { parseTaskFile } from "../core/task-parser.js";
import { normalizeSpec } from "../core/spec-normalizer.js";
import { verifyRepairIsAdditive } from "../core/repair-guard.js";

interface RepairSpecsOptions {
  write?: boolean;
  json?: boolean;
}

interface FileReport {
  file: string;
  result: "ok" | "repairable" | "repaired" | "unresolved";
  actions?: string[];
  error?: string;
}

const SPEC_FILE_PATTERN = /^(?:TASK-.+|SAURUS-REM-\d{3}.*)\.md$/;

export function repairSpecsCommand(dir: string, options: RepairSpecsOptions = {}): void {
  const resolved = path.resolve(dir);
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory()) {
    console.error(`Not a directory: ${resolved}`);
    process.exitCode = 1;
    return;
  }

  const files = fs
    .readdirSync(resolved)
    .filter((f) => SPEC_FILE_PATTERN.test(f))
    .sort();

  const reports: FileReport[] = [];

  for (const file of files) {
    const filePath = path.join(resolved, file);
    let content: string;
    try {
      content = fs.readFileSync(filePath, "utf-8");
    } catch (err) {
      reports.push({ file, result: "unresolved", error: `read failed: ${String(err)}` });
      continue;
    }

    try {
      parseTaskFile(content, filePath);
      reports.push({ file, result: "ok" });
      continue;
    } catch {
      // falls through to repair
    }

    const idMatch = file.match(/^((?:TASK-\d+(?:-[A-Z])?|SAURUS-REM-\d{3}))/);
    const det = normalizeSpec(content, { taskIdHint: idMatch?.[1] });

    if (!det.resolved || !det.changed) {
      reports.push({ file, result: "unresolved", error: det.parseError });
      continue;
    }

    // Belt-and-suspenders: never write anything the guard rejects.
    const guard = verifyRepairIsAdditive(content, det.content);
    if (!guard.ok) {
      reports.push({
        file,
        result: "unresolved",
        error: `guard rejected repair: ${guard.violations.slice(0, 3).join("; ")}`,
      });
      continue;
    }

    if (options.write) {
      fs.writeFileSync(filePath, det.content, "utf-8");
      reports.push({ file, result: "repaired", actions: det.actions });
    } else {
      reports.push({ file, result: "repairable", actions: det.actions });
    }
  }

  const summary = {
    dir: resolved,
    total: reports.length,
    ok: reports.filter((r) => r.result === "ok").length,
    repairable: reports.filter((r) => r.result === "repairable").length,
    repaired: reports.filter((r) => r.result === "repaired").length,
    unresolved: reports.filter((r) => r.result === "unresolved").length,
    write: Boolean(options.write),
  };

  if (options.json) {
    console.log(JSON.stringify({ summary, reports }, null, 2));
    return;
  }

  for (const r of reports) {
    if (r.result === "ok") continue;
    if (r.result === "unresolved") {
      console.log(`UNRESOLVED  ${r.file}  ${r.error ?? ""}`);
    } else {
      console.log(
        `${r.result.toUpperCase().padEnd(11)} ${r.file}  [${(r.actions ?? []).join(", ")}]`,
      );
    }
  }
  console.log(
    `\n${summary.total} specs: ${summary.ok} ok, ${summary.repairable} repairable, ` +
      `${summary.repaired} repaired, ${summary.unresolved} unresolved` +
      (options.write ? "" : "  (dry-run; use --write to apply)"),
  );
}
