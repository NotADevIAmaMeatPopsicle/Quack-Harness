import { buildClaudeChildEnvironment } from "../sdk/claude-auth.js";
import type { ScanResult } from "./project-scanner.js";
import type { CommandValidation, TestingStrategy, AdapterReviewResult } from "./intake-types.js";
import path from "node:path";
import fs from "node:fs/promises";

// ─── SDK Integration ───────────────────────────────────────────────

/**
 * Minimal SDK message shape for the async generator.
 */
interface SDKMessage {
  type: string;
  subtype?: string;
}

/**
 * Type for the SDK query function.
 */
type QueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<SDKMessage, void>;

/**
 * Lazily loaded reference to the SDK's query function.
 */
let _queryFn: QueryFn | undefined;

/**
 * Dynamically imports the Claude Agent SDK's query function.
 */
async function getQueryFn(): Promise<QueryFn> {
  if (_queryFn) return _queryFn;
  const sdk: { query: QueryFn } = await import("@anthropic-ai/claude-agent-sdk");
  _queryFn = sdk.query;
  return _queryFn;
}

/**
 * Override the query function used internally. Primarily for testing.
 */
export function _setQueryFn(fn: QueryFn | undefined): void {
  _queryFn = fn;
}

// ─── Intake Analysis ───────────────────────────────────────────────

export interface IntakeAnalysisResult {
  testingStrategy: TestingStrategy;
  conventionsAnalysis: string;
  adapterReview: AdapterReviewResult;
}

export async function analyzeIntake(
  scan: ScanResult,
  validationResults: CommandValidation[],
): Promise<IntakeAnalysisResult> {
  // Bootstrap has no target adapter. Decide host auth before any parallel work,
  // without borrowing the unrelated active project's ambient credential pool.
  const environment = Object.freeze(buildClaudeChildEnvironment());
  // Run all three analyses against the same immutable auth snapshot.
  const [testingStrategy, conventionsAnalysis, adapterReview] = await Promise.all([
    analyzeTestingStrategy(scan, validationResults, environment),
    analyzeConventions(scan, environment),
    reviewAdapter(scan, validationResults, environment),
  ]);

  return {
    testingStrategy,
    conventionsAnalysis,
    adapterReview,
  };
}

// ─── Testing Strategy Advisor ──────────────────────────────────────

async function analyzeTestingStrategy(
  scan: ScanResult,
  validationResults: CommandValidation[],
  environment: NodeJS.ProcessEnv,
): Promise<TestingStrategy> {
  const query = await getQueryFn();

  const prompt = buildTestingStrategyPrompt(scan, validationResults);

  let responseText = "";
  for await (const msg of query({
    prompt,
    options: {
      env: environment,
      model: "claude-sonnet-4-6",
      maxTokens: 2000,
    },
  })) {
    if (msg.type === "text") {
      responseText += (msg as { type: string; text: string }).text;
    }
  }

  return parseTestingStrategyResponse(responseText);
}

function buildTestingStrategyPrompt(
  scan: ScanResult,
  validationResults: CommandValidation[],
): string {
  const testScripts = Object.entries(scan.scriptCommands)
    .filter(([name]) => /test/.test(name))
    .map(([name, cmd]) => `  ${name}: ${cmd}`)
    .join("\n");

  const validationSummary = validationResults
    .map(
      (v) =>
        `  ${v.name}: ${v.status} (${v.durationMs}ms)${v.testCount ? ` - ${v.testCount} tests` : ""}`,
    )
    .join("\n");

  return `You are a testing strategy advisor for a code agent project intake system.

Project Information:
- Language: ${scan.language}
- Test Suite Size: ${scan.testSuiteSize} (${scan.testFileCount} test files)
- Test Framework: ${scan.testFrameworks.map((f) => f.name).join(", ") || "unknown"}

Available Test Scripts:
${testScripts || "  (none detected)"}

Available Test Scripts (non-test):
${
  Object.entries(scan.scriptCommands)
    .filter(([name]) => !/test/.test(name))
    .map(([name, cmd]) => `  ${name}: ${cmd}`)
    .join("\n") || "  (none)"
}

Command Validation Results:
${validationSummary}

Task Context:
The Quack agent system runs verification after each task implementation. For large test suites (100+ files, 10+ minute runs), running the full suite on every verification is wasteful. For small suites (<20 files, <1 minute), running the full suite is fine.

Your job: Recommend a testing strategy with:
1. Primary command - what should run on every verification (required)
2. Targeted command - optional, for running only tests related to changed files
3. Full suite command - optional, for comprehensive validation before merging

Return JSON in this format:
{
  "primaryCommand": { "command": "...", "rationale": "..." },
  "targetedCommand": { "command": "...", "rationale": "..." },
  "fullSuiteCommand": { "command": "...", "rationale": "..." },
  "estimatedFullSuiteTime": "~2 minutes",
  "recommendations": ["...", "..."]
}

Keep responses concise and actionable.`;
}

function parseTestingStrategyResponse(responseText: string): TestingStrategy {
  // Extract JSON from response (may be wrapped in markdown code fence)
  const jsonMatch = /\{[\s\S]*\}/.exec(responseText);
  if (!jsonMatch) {
    throw new Error("Failed to parse testing strategy response: no JSON found");
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      primaryCommand: { command: string; rationale: string };
      targetedCommand?: { command: string; rationale: string };
      fullSuiteCommand?: { command: string; rationale: string };
      estimatedFullSuiteTime: string;
      recommendations: string[];
    };

    return parsed;
  } catch (err) {
    throw new Error(
      `Failed to parse testing strategy JSON: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

// ─── Conventions Analyzer ──────────────────────────────────────────

async function analyzeConventions(
  scan: ScanResult,
  environment: NodeJS.ProcessEnv,
): Promise<string> {
  const query = await getQueryFn();

  const prompt = await buildConventionsPrompt(scan);

  let responseText = "";
  for await (const msg of query({
    prompt,
    options: {
      env: environment,
      model: "claude-sonnet-4-6",
      maxTokens: 4000,
    },
  })) {
    if (msg.type === "text") {
      responseText += (msg as { type: string; text: string }).text;
    }
  }

  return responseText;
}

async function buildConventionsPrompt(scan: ScanResult): Promise<string> {
  let configFiles = "";

  // Read config files if they exist
  if (scan.hasTypeScript) {
    const tsconfigPath = path.join(scan.projectPath, "tsconfig.json");
    try {
      const content = await fs.readFile(tsconfigPath, "utf-8");
      configFiles += `\n## tsconfig.json\n\`\`\`json\n${content.substring(0, 1000)}\n\`\`\`\n`;
    } catch {
      // File doesn't exist or can't be read
    }
  }

  // Read ESLint config
  for (const filename of [".eslintrc.json", ".eslintrc.js", "eslint.config.js"]) {
    const eslintPath = path.join(scan.projectPath, filename);
    try {
      const content = await fs.readFile(eslintPath, "utf-8");
      configFiles += `\n## ${filename}\n\`\`\`\n${content.substring(0, 1000)}\n\`\`\`\n`;
      break;
    } catch {
      // Try next file
    }
  }

  // Read Prettier config
  for (const filename of [".prettierrc", ".prettierrc.json", "prettier.config.js"]) {
    const prettierPath = path.join(scan.projectPath, filename);
    try {
      const content = await fs.readFile(prettierPath, "utf-8");
      configFiles += `\n## ${filename}\n\`\`\`\n${content.substring(0, 500)}\n\`\`\`\n`;
      break;
    } catch {
      // Try next file
    }
  }

  return `You are a conventions analyzer for a code agent project intake system.

Generate a conventions.md file that captures the coding standards and patterns a code agent should follow when working on this project.

Project Information:
- Language: ${scan.language}
- Framework: ${scan.frameworkType || "unknown"}
- Has TypeScript: ${scan.hasTypeScript}
- Detected Linters: ${scan.linters.map((l) => l.name).join(", ") || "none"}

Config Files:
${configFiles || "(no config files found)"}

Existing Documentation:
${scan.claudeMdContent ? `\n## CLAUDE.md (first 500 chars)\n${scan.claudeMdContent.substring(0, 500)}\n` : ""}
${scan.readmeContent ? `\n## README.md (first 300 chars)\n${scan.readmeContent.substring(0, 300)}\n` : ""}

Generate a conventions.md file that includes:
1. Code style and formatting rules (from config files)
2. TypeScript strictness settings and what they mean for the agent
3. Linting rules that must be followed
4. Import/export patterns
5. Testing patterns (describe/it structure, assertion style)
6. File organization conventions

Keep it concise and actionable. Focus on what the agent MUST follow, not general best practices.`;
}

// ─── Adapter Reviewer ──────────────────────────────────────────────

async function reviewAdapter(
  scan: ScanResult,
  validationResults: CommandValidation[],
  environment: NodeJS.ProcessEnv,
): Promise<AdapterReviewResult> {
  const query = await getQueryFn();

  const prompt = buildAdapterReviewPrompt(scan, validationResults);

  let responseText = "";
  for await (const msg of query({
    prompt,
    options: {
      env: environment,
      model: "claude-sonnet-4-6",
      maxTokens: 1500,
    },
  })) {
    if (msg.type === "text") {
      responseText += (msg as { type: string; text: string }).text;
    }
  }

  return parseAdapterReviewResponse(responseText, scan);
}

function buildAdapterReviewPrompt(
  scan: ScanResult,
  validationResults: CommandValidation[],
): string {
  const validationSummary = validationResults
    .map((v) => `  ${v.name}: ${v.status}${v.exitCode !== null ? ` (exit ${v.exitCode})` : ""}`)
    .join("\n");

  return `You are an adapter configuration reviewer for a code agent project intake system.

Review this generated adapter configuration and identify any issues or suggestions.

Project Information:
- Language: ${scan.language}
- Source directories: ${scan.sourceDirs.join(", ")}
- Test suite size: ${scan.testSuiteSize} (${scan.testFileCount} files)
- Has TypeScript: ${scan.hasTypeScript}
- Is Monorepo: ${scan.isMonorepo}

Generated Configuration:
- Writable paths: src/, lib/, tests/, test/
- Verification commands: ${validationResults.map((v) => v.name).join(", ")}
- Base branch: ${scan.gitDefaultBranch || "main"}

Command Validation Results:
${validationSummary}

Review for:
1. Are writable paths correct? Missing any important directories?
2. Are verification commands appropriate for the project?
3. Any failing commands that need attention?
4. Should maxBudgetPerTask be adjusted based on project complexity?
5. Any other configuration issues?

Return JSON in this format:
{
  "suggestions": ["...", "..."],
  "confidence": "high" | "medium" | "low"
}

Base confidence on: how many commands passed, whether the project structure is standard, whether there are any obvious issues.`;
}

function parseAdapterReviewResponse(responseText: string, _scan: ScanResult): AdapterReviewResult {
  // Extract JSON from response
  const jsonMatch = /\{[\s\S]*\}/.exec(responseText);
  if (!jsonMatch) {
    // Fallback if LLM didn't return JSON
    return {
      suggestions: ["Manual review recommended - LLM response format was invalid"],
      confidence: "low",
    };
  }

  try {
    const parsed = JSON.parse(jsonMatch[0]) as {
      suggestions: string[];
      confidence: "high" | "medium" | "low";
    };

    return parsed;
  } catch {
    return {
      suggestions: ["Manual review recommended - LLM response could not be parsed"],
      confidence: "low",
    };
  }
}
