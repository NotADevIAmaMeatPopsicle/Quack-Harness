// ─── Import CLI Command ─────────────────────────────────────────────
// quack import --from github --issue 42
// quack import --from github --label quack-ready

import * as path from "node:path";

import { loadAdapter } from "../core/adapter-loader.js";
import { importIssue, importIssuesByLabel } from "../integrations/github/import-pipeline.js";

interface ImportOptions {
  from: string;
  issue?: number;
  label?: string;
  autoDispatch?: boolean;
  project?: string;
}

export async function handleImport(options: ImportOptions): Promise<void> {
  const projectRoot = options.project ? path.resolve(options.project) : process.cwd();
  const adapter = await loadAdapter(projectRoot);

  if (options.from !== "github") {
    console.error(`Error: Unknown import source "${options.from}". Only "github" is supported.`);
    process.exit(1);
  }

  if (!adapter.config.integrations?.github) {
    console.error("Error: GitHub integration not configured in adapter.json");
    console.error("Add an 'integrations.github' section with owner and repo.");
    process.exit(1);
  }

  try {
    if (options.issue) {
      // Import single issue
      console.log(`Importing GitHub issue #${options.issue}...`);
      const result = await importIssue(options.issue, adapter, options.autoDispatch || false);
      console.log(`✅ Created ${result.taskId} from issue #${result.issueNumber}`);

      if (result.gateResult) {
        if (result.gateResult.passed) {
          console.log(`✅ Readiness gate: PASSED (score: ${result.gateResult.depthScore}/5)`);
        } else {
          console.log(`⚠️  Readiness gate: FAILED`);
          if (result.gateResult.deficiencies && result.gateResult.deficiencies.length > 0) {
            console.log("   Deficiencies:");
            for (const def of result.gateResult.deficiencies) {
              console.log(`   - ${def}`);
            }
          }
        }
      }
    } else if (options.label) {
      // Import issues by label
      console.log(`Importing GitHub issues with label "${options.label}"...`);
      const results = await importIssuesByLabel(
        options.label,
        adapter,
        options.autoDispatch || false,
      );

      if (results.length === 0) {
        console.log("No new issues to import.");
      } else {
        console.log(`✅ Imported ${results.length} issue(s):`);
        for (const result of results) {
          console.log(`   - ${result.taskId} (from issue #${result.issueNumber})`);
        }
      }
    } else {
      console.error("Error: Must provide either --issue or --label");
      process.exit(1);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
