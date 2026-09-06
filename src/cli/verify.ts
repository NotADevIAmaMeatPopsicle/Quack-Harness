// ─── CLI: quack verify ───────────────────────────────────────────────
// Run verification only on the current branch, without running the agent.

import { loadAdapter } from "../core/adapter-loader.js";
import { runVerification, formatVerificationResult } from "../worker/tools/verify.js";

export async function verifyCommand(taskId: string, options: { project?: string }): Promise<void> {
  const projectPath = options.project ?? process.cwd();

  try {
    const adapter = await loadAdapter(projectPath);

    console.log(`\nVerifying ${taskId}\n${"=".repeat(40)}\n`);
    console.log(`Project: ${adapter.config.project.name}`);
    console.log(`Root: ${adapter.projectRoot}\n`);

    const result = await runVerification(adapter, "all");
    console.log(formatVerificationResult(result));
    console.log();

    if (result.allPassed) {
      console.log("All verification checks passed.");
      process.exit(0);
    } else {
      const failedCommands = result.commands.filter((c) => !c.passed);
      const failedChecks = result.conventionChecks.filter((c) => !c.passed);
      const totalFailed = failedCommands.length + failedChecks.length;
      console.log(`${totalFailed} check(s) failed.`);
      process.exit(1);
    }
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
