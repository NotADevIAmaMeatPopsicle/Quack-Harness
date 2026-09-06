import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { GitHubConfig } from "../../src/integrations/github/github-types";

export type FixtureCreationOrder = "child-first" | "parent-first";

export interface FixtureSpecOptions {
  title?: string;
  status?: string;
  tags?: string[];
  targetFiles?: string[];
  successCriteria?: string[];
  testingRequirements?: string[];
  repairPlaceholder?: boolean;
}

export interface DivergentTaskFixture {
  root: string;
  taskDir: string;
  parentPath: string;
  childPath: string;
  parentContent: string;
  childContent: string;
  parentBefore: string;
  childBefore: string;
  naiveSelection: string | undefined;
  cleanup(): void;
}

export function taskSpec(id: string, options: FixtureSpecOptions = {}): string {
  const title = options.title ?? `${id} fixture`;
  const status = options.status ?? "READY";
  const tags = options.tags ?? ["fixture"];
  const targetFiles = options.targetFiles ?? [`src/${id.toLowerCase()}.ts`];
  const successCriteria = options.successCriteria ?? [`${id} resolves canonically`];
  const testingRequirements = options.testingRequirements ?? ["Exercise the real directory"];
  const problem = options.repairPlaceholder
    ? `${id} needs review ${"(repair placeholder)"}.`
    : `${id} must resolve to its own file.`;

  return [
    `# ${id}: ${title}`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 1-2 hours",
    `- **Status:** ${status}`,
    "- **Blocked By:** []",
    "- **Blocks:** []",
    `- **Tags:** [${tags.join(", ")}]`,
    "",
    "## Problem Statement",
    problem,
    "",
    "## Current State",
    `${id} current state.`,
    "",
    "## Recommended Approach",
    `${id} recommended approach.`,
    "",
    "## Files to Modify",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    ...targetFiles.map((file) => `| ${file} | Modify | ${id} fixture |`),
    "",
    "## Success Criteria",
    ...successCriteria.map((criterion) => `- [ ] ${criterion}`),
    "",
    "## Testing Requirements",
    ...testingRequirements.map((requirement) => `- [ ] ${requirement}`),
    "",
  ].join("\n");
}

export function createDivergentTaskFixture(
  order: FixtureCreationOrder,
  options: { parent?: FixtureSpecOptions; child?: FixtureSpecOptions; prefix?: string } = {},
): DivergentTaskFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), options.prefix ?? "quack-prefix-selection-"));
  const taskDir = path.join(root, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });

  const parentPath = path.join(taskDir, "TASK-100-parent.md");
  const childPath = path.join(taskDir, "TASK-100-A-child.md");
  const parentContent = taskSpec("TASK-100", options.parent);
  const childContent = taskSpec("TASK-100-A", options.child);
  const files: Array<[string, string]> = [
    [childPath, childContent],
    [parentPath, parentContent],
  ];
  for (const [filePath, content] of order === "child-first" ? files : [...files].reverse()) {
    fs.writeFileSync(filePath, content, "utf-8");
  }

  return {
    root,
    taskDir,
    parentPath,
    childPath,
    parentContent,
    childContent,
    parentBefore: fs.readFileSync(parentPath, "utf-8"),
    childBefore: fs.readFileSync(childPath, "utf-8"),
    naiveSelection: fs
      .readdirSync(taskDir)
      .find((entry) => entry.startsWith("TASK-100") && entry.endsWith(".md")),
    cleanup: () => {
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    },
  };
}

export function writeTestAdapter(projectRoot: string, github?: Partial<GitHubConfig>): string {
  const adapterPath = path.join(projectRoot, ".quack", "adapter.json");
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(
    adapterPath,
    JSON.stringify({
      version: "1.0",
      project: {
        name: "prefix-selection-fixture",
        root: projectRoot,
        taskDir: "docs/tasks",
        conventionsDir: "docs/conventions",
      },
      agent: {},
      verification: {
        commands: [{ name: "fixture", command: "node --version", required: true, timeout: 60000 }],
      },
      sandbox: {
        writablePaths: ["src/**", "tests/**"],
        deniedPaths: [],
        allowedBashPatterns: [],
        deniedBashPatterns: [],
      },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "Automated-By: Quack",
        autoPush: false,
      },
      logging: { level: "info", dir: ".quack/logs", sessionDir: ".quack/logs" },
      ...(github
        ? {
            integrations: {
              github: {
                owner: "fixture-owner",
                repo: "fixture-repo",
                ...github,
              },
            },
          }
        : {}),
    }),
    "utf-8",
  );
  return adapterPath;
}
