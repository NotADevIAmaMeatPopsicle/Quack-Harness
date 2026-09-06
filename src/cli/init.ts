// ─── CLI: quack init ─────────────────────────────────────────────────
// Bootstrap a project adapter by scanning the project and generating
// starter adapter.json + conventions.md in .quack/.

import * as fs from "node:fs/promises";
import * as path from "node:path";

import { scanProject } from "../bootstrap/project-scanner.js";
import { generateAdapter } from "../bootstrap/adapter-generator.js";

// ─── Helpers ────────────────────────────────────────────────────────

function formatScanSummary(scan: Awaited<ReturnType<typeof scanProject>>): string {
  const lines: string[] = [];
  lines.push("[SCANNING PROJECT]");

  if (scan.language !== "unknown") {
    const langLabel = {
      node: "Node.js",
      python: "Python",
      rust: "Rust",
      go: "Go",
      unknown: "Unknown",
    }[scan.language];
    lines.push(`  Detected: ${langLabel} project`);
  } else {
    lines.push("  Warning: Could not detect project language");
  }

  if (scan.testCommand) {
    lines.push(`  Test command: ${scan.testCommand}`);
  }

  for (const fw of scan.testFrameworks) {
    lines.push(`  Found: ${fw.configFile} (${fw.name})`);
  }

  for (const bt of scan.buildTools) {
    lines.push(`  Found: ${bt.configFile} (${bt.name})`);
  }

  if (scan.hasTypeScript) {
    lines.push("  Found: tsconfig.json (TypeScript)");
  }
  if (scan.hasDocker) {
    lines.push("  Found: Docker configuration");
  }
  if (scan.hasEnvExample) {
    lines.push("  Found: .env.example");
  }

  for (const dir of scan.sourceDirs) {
    lines.push(`  Found: ${dir} directory`);
  }

  for (const doc of scan.docFiles) {
    if (!["README.md", "CLAUDE.md"].includes(doc)) continue;
    lines.push(`  Found: ${doc}`);
  }

  if (scan.hasExistingQuackDir) {
    lines.push("  Warning: .quack/ directory already exists!");
  }

  return lines.join("\n");
}

// ─── Main command ───────────────────────────────────────────────────

export async function initCommand(
  projectPath: string,
  _options: { project?: string; analyze?: boolean },
): Promise<void> {
  const resolvedPath = path.resolve(projectPath);

  console.log(`\nquack init: ${resolvedPath}\n`);

  // 1. Scan the project
  let scan: Awaited<ReturnType<typeof scanProject>>;
  try {
    scan = await scanProject(resolvedPath);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error scanning project: ${message}`);
    process.exit(1);
  }

  // 2. Show scan results
  console.log(formatScanSummary(scan));
  console.log("");

  // 3. Check for existing .quack/ directory
  const quackDir = path.join(resolvedPath, ".quack");
  if (scan.hasExistingQuackDir) {
    console.error(
      "Error: .quack/ directory already exists.\n" +
        "Remove it manually or use a different project path.\n" +
        "Aborting to prevent overwriting existing configuration.",
    );
    process.exit(1);
  }

  // 4. Generate adapter
  let generated: ReturnType<typeof generateAdapter>;
  try {
    generated = generateAdapter(scan);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error generating adapter: ${message}`);
    process.exit(1);
  }

  // 4.5. Run analysis if --analyze flag is set
  if (_options.analyze) {
    console.log("[RUNNING INTELLIGENT ANALYSIS]\n");
    try {
      const { validateCommands } = await import("../bootstrap/command-validator.js");
      const { analyzeIntake } = await import("../bootstrap/intake-analyzer.js");

      const { verificationCommandShellString: vcShellString } = await import("../core/types.js");
      const verificationCommands = generated.adapterConfig.verification.commands.map((cmd) => ({
        name: cmd.name,
        command: vcShellString(cmd),
      }));

      console.log("  Validating commands...");
      const commandValidation = await validateCommands(resolvedPath, verificationCommands);

      for (const result of commandValidation) {
        const statusSymbol =
          result.status === "pass"
            ? "✓"
            : result.status === "fail"
              ? "✗"
              : result.status === "timeout"
                ? "⏱"
                : "○";
        console.log(
          `    ${statusSymbol} ${result.name}: ${result.status} (${result.durationMs}ms)${result.testCount ? ` - ${result.testCount} tests` : ""}`,
        );
      }
      console.log("");

      console.log("  Running LLM analysis...");
      const analysis = await analyzeIntake(scan, commandValidation);

      console.log("\n[TESTING STRATEGY]");
      console.log(`  Primary: ${analysis.testingStrategy.primaryCommand.command}`);
      console.log(`    ${analysis.testingStrategy.primaryCommand.rationale}`);
      if (analysis.testingStrategy.targetedCommand) {
        console.log(`  Targeted: ${analysis.testingStrategy.targetedCommand.command}`);
        console.log(`    ${analysis.testingStrategy.targetedCommand.rationale}`);
      }
      if (analysis.testingStrategy.fullSuiteCommand) {
        console.log(`  Full Suite: ${analysis.testingStrategy.fullSuiteCommand.command}`);
        console.log(`    ${analysis.testingStrategy.fullSuiteCommand.rationale}`);
      }
      console.log(
        `  Estimated Full Suite Time: ${analysis.testingStrategy.estimatedFullSuiteTime}`,
      );
      console.log("");

      console.log("[ADAPTER REVIEW]");
      console.log(`  Confidence: ${analysis.adapterReview.confidence}`);
      if (analysis.adapterReview.suggestions.length > 0) {
        console.log("  Suggestions:");
        for (const suggestion of analysis.adapterReview.suggestions) {
          console.log(`    - ${suggestion}`);
        }
      }
      console.log("");

      // Replace conventions.md with LLM-generated content
      generated.conventionsMd = analysis.conventionsAnalysis;
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`Warning: Analysis failed: ${message}`);
      console.error("Continuing with standard generation...\n");
    }
  }

  // 5. Create .quack/ directory and write files
  try {
    await fs.mkdir(quackDir, { recursive: true });

    const adapterJsonPath = path.join(quackDir, "adapter.json");
    const conventionsMdPath = path.join(quackDir, "conventions.md");

    await fs.writeFile(
      adapterJsonPath,
      JSON.stringify(generated.adapterConfig, null, 2) + "\n",
      "utf-8",
    );

    await fs.writeFile(conventionsMdPath, generated.conventionsMd, "utf-8");

    // Write TESTING.md
    const testingMdPath = path.join(quackDir, "TESTING.md");
    await fs.writeFile(testingMdPath, generated.testingConventionMd, "utf-8");

    // Write test-existence convention check
    const conventionChecksDir = path.join(quackDir, "convention-checks");
    await fs.mkdir(conventionChecksDir, { recursive: true });
    const checkScriptPath = path.join(conventionChecksDir, "test-existence-check.js");
    await fs.writeFile(checkScriptPath, generated.testExistenceCheckJs, "utf-8");

    // Write test-existence config
    const checkConfigPath = path.join(quackDir, "test-existence.config.json");
    await fs.writeFile(checkConfigPath, generated.testExistenceConfigJson, "utf-8");

    // Create the task directory too
    const taskDir = path.join(resolvedPath, generated.adapterConfig.project.taskDir);
    await fs.mkdir(taskDir, { recursive: true });

    // Create logs directory
    const logsDir = path.join(quackDir, "logs");
    await fs.mkdir(logsDir, { recursive: true });

    console.log("[GENERATING ADAPTER]");
    console.log(`  Created: ${path.relative(resolvedPath, adapterJsonPath)}`);
    console.log(`    - Test command: ${scan.testCommand || "(none detected)"}`);
    console.log(`    - Writable: ${generated.adapterConfig.sandbox.writablePaths.join(", ")}`);
    console.log(`    - Denied: ${generated.adapterConfig.sandbox.deniedPaths.join(", ")}`);
    console.log("");
    console.log(`  Created: ${path.relative(resolvedPath, conventionsMdPath)}`);
    if (scan.claudeMdContent) {
      console.log("    - Extracted conventions from CLAUDE.md");
    } else if (scan.readmeContent) {
      console.log("    - Extracted notes from README.md");
    }
    console.log("    - REVIEW THIS FILE -- it is a starting point, not gospel");
    console.log("");
    console.log(`  Created: ${path.relative(resolvedPath, testingMdPath)}`);
    console.log("    - Testing conventions for agent guidance");
    console.log("");
    console.log(`  Created: ${path.relative(resolvedPath, checkScriptPath)}`);
    console.log(`  Created: ${path.relative(resolvedPath, checkConfigPath)}`);
    console.log("");
    console.log(`  Created: ${path.relative(resolvedPath, taskDir)}/`);
    console.log(`  Created: ${path.relative(resolvedPath, logsDir)}/`);
    console.log("");

    // Auto-register in global config (non-fatal)
    try {
      const { registerProject } = await import("../core/global-config.js");
      registerProject(resolvedPath);
      console.log(`  Registered in global config (~/.quack/config.json)`);
      console.log("");
    } catch {
      // Non-fatal — global config write failure shouldn't block init
    }

    console.log("[NEXT STEPS]");
    console.log("  1. Review .quack/conventions.md and edit as needed");
    console.log("  2. Review .quack/TESTING.md and customize testing patterns");
    console.log("  3. Review .quack/adapter.json and adjust verification commands");
    console.log(
      `  4. Create your first task: ${generated.adapterConfig.project.taskDir}/TASK-001-<name>.md`,
    );
    console.log("  5. Run: quack run TASK-001 --dry-run");
    console.log("  6. Run: quack monitor (auto-loads registered projects)");
    console.log("");
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error writing files: ${message}`);
    process.exit(1);
  }
}
