import * as fs from "node:fs";
import * as path from "node:path";

import { loadAdapter } from "../core/adapter-loader.js";
import { QuackDB } from "../db/index.js";
import { reconcileSpecStatuses } from "./reconcile-spec-status-lib.js";

interface CliOptions {
  apply: boolean;
  projectRoot: string;
}

function printUsage(): void {
  console.log(
    [
      "Usage: node dist/scripts/reconcile-spec-status.js [--apply] [--project-root <path>]",
      "",
      "Options:",
      "  --apply                 Rewrite spec Status lines to match quack.db task_status rows.",
      "  --project-root <path>   Target project root (defaults to current working directory).",
      "  --project <path>        Alias for --project-root.",
      "  --help                  Show this help text.",
    ].join("\n"),
  );
}

function parseArgs(argv: string[]): CliOptions | null {
  let apply = false;
  let projectRoot = process.cwd();

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--help" || arg === "-h") {
      printUsage();
      return null;
    }
    if (arg === "--apply") {
      apply = true;
      continue;
    }
    if (arg === "--project-root" || arg === "--project") {
      const next = argv[index + 1];
      if (!next) {
        throw new Error(`${arg} requires a path value.`);
      }
      projectRoot = next;
      index += 1;
      continue;
    }
    throw new Error(`Unknown argument: ${arg}`);
  }

  return {
    apply,
    projectRoot: path.resolve(projectRoot),
  };
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  if (!options) return;

  const dbPath = path.join(options.projectRoot, ".quack", "quack.db");
  if (!fs.existsSync(dbPath)) {
    throw new Error(`Quack DB not found at ${dbPath}. Pass --project-root for the target repo.`);
  }

  const adapter = await loadAdapter(options.projectRoot);
  const taskDir = path.resolve(options.projectRoot, adapter.config.project.taskDir);
  const db = new QuackDB(dbPath);

  try {
    const result = await reconcileSpecStatuses(taskDir, db.getAllStatuses(), {
      apply: options.apply,
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: options.apply ? "apply" : "dry-run",
          projectRoot: options.projectRoot,
          dbPath,
          taskDir,
          ...result,
        },
        null,
        2,
      ),
    );
  } finally {
    db.close();
  }
}

void main().catch((err: unknown) => {
  const message = err instanceof Error ? err.message : String(err);
  console.error(`[reconcile-spec-status] ${message}`);
  process.exitCode = 1;
});
