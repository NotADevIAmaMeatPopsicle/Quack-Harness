import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { taskSpec, writeTestAdapter } from "./divergent-task-fixture";

export function createDeclaredParentFixture(order: "forward" | "reverse"): {
  root: string;
  taskDir: string;
  parentPath: string;
  firstPath: string;
  secondPath: string;
  malformedPath: string;
  git(args: string[]): string;
  cleanup(): void;
} {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-1336b-parent-"));
  const taskDir = path.join(root, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  writeTestAdapter(root);
  const parentPath = path.join(taskDir, "TASK-9000-descriptive-parent.md");
  const firstPath = path.join(taskDir, "TASK-8000-descriptive-first.md");
  const secondPath = path.join(taskDir, "TASK-7000-descriptive-second.md");
  const malformedPath = path.join(taskDir, "TASK-100-C-unparseable-child.md");
  const child = (id: string, status: string) =>
    taskSpec(id, { status }).replace("## Metadata", "Parent Task: TASK-100\n\n## Metadata");
  const entries = [
    [parentPath, taskSpec("TASK-100", { status: "IN_PROGRESS" })],
    [firstPath, child("TASK-100-A", "READY")],
    [secondPath, child("TASK-100-B", "COMPLETE")],
    [malformedPath, "# TASK-100-C: malformed child\nParent Task: TASK-100\n"],
  ];
  for (const [file, content] of order === "forward" ? entries : [...entries].reverse())
    fs.writeFileSync(file, content);
  const git = (args: string[]): string =>
    execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
  git(["init", "-b", "main"]);
  git(["config", "user.name", "Quack Fixture"]);
  git(["config", "user.email", "quack@example.invalid"]);
  git(["add", "."]);
  git(["commit", "-m", "Declared parent fixture"]);
  return {
    root,
    taskDir,
    parentPath,
    firstPath,
    secondPath,
    malformedPath,
    git,
    cleanup: () =>
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 }),
  };
}
