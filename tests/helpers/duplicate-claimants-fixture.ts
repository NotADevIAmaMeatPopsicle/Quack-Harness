import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

export type DuplicateFixtureKind = "candidate-scoped" | "cross-population";
export type DuplicateFixtureOrder = "forward" | "reverse";

export const DUPLICATE_FIXTURE_CASES = [
  ["candidate-scoped", "forward"],
  ["candidate-scoped", "reverse"],
  ["cross-population", "forward"],
  ["cross-population", "reverse"],
] as const;

export function taskSpec(
  id: string,
  options: { status?: string; title?: string; extra?: string } = {},
): string {
  const status = options.status ?? "READY";
  const title = options.title ?? "duplicate claimant fixture";
  return [
    `# ${id}: ${title}`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 4-6 hours",
    `- **Status:** ${status}`,
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** fixture, duplicate-claimants",
    "",
    "## Problem Statement",
    `${id} exercises a destructive writer against real task files.`,
    "",
    "## Current State",
    "The task has not been changed by the writer.",
    "",
    "## Recommended Approach",
    "Refuse writes when more than one file declares the requested id.",
    "",
    "## Files to Modify",
    "",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/fixture.ts` | Modify | Exercise the fixture |",
    "",
    "## Success Criteria",
    "- [ ] The intended task spec is the only mutation target",
    "- [ ] Ambiguous mutation is refused",
    "",
    "## Testing Requirements",
    "- [ ] Exercise real files in both creation orders",
    options.extra ?? "",
    "",
  ].join("\n");
}

export interface DuplicateFixture {
  root: string;
  taskDir: string;
  claimantPaths: string[];
  claimants: string[];
  before: Map<string, string>;
}

export function createDuplicateFixture(
  prefix: string,
  kind: DuplicateFixtureKind,
  order: DuplicateFixtureOrder,
  options: { status?: string } = {},
): DuplicateFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const taskDir = path.join(root, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(root, ".quack", "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".quack", "logs", "sessions.jsonl"), "", "utf-8");

  const names =
    kind === "candidate-scoped"
      ? ["TASK-100-a.md", "TASK-100-b.md"]
      : ["TASK-100-a.md", "TASK-999-b.md"];
  const entries = names.map((name) => [name, taskSpec("TASK-100", options)] as const);
  const creationEntries = order === "forward" ? entries : [...entries].reverse();
  for (const [name, content] of creationEntries) {
    fs.writeFileSync(path.join(taskDir, name), content, "utf-8");
  }

  const claimantPaths = names.map((name) => path.join(taskDir, name));
  return {
    root,
    taskDir,
    claimantPaths,
    claimants: [...names].sort(),
    before: new Map(
      claimantPaths.map((filePath) => [filePath, fs.readFileSync(filePath, "utf-8")]),
    ),
  };
}

export function createSingleClaimantFixture(prefix: string): DuplicateFixture {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const taskDir = path.join(root, "docs", "tasks");
  fs.mkdirSync(taskDir, { recursive: true });
  fs.mkdirSync(path.join(root, ".quack", "logs"), { recursive: true });
  fs.writeFileSync(path.join(root, ".quack", "logs", "sessions.jsonl"), "", "utf-8");
  const filePath = path.join(taskDir, "TASK-100-a.md");
  fs.writeFileSync(filePath, taskSpec("TASK-100"), "utf-8");
  return {
    root,
    taskDir,
    claimantPaths: [filePath],
    claimants: [],
    before: new Map([[filePath, fs.readFileSync(filePath, "utf-8")]]),
  };
}

export function expectClaimantsUnchanged(fixture: DuplicateFixture): void {
  for (const filePath of fixture.claimantPaths) {
    expect(fs.readFileSync(filePath, "utf-8")).toBe(fixture.before.get(filePath));
  }
}

export function expectNoWriterArtifacts(fixture: DuplicateFixture): void {
  expect(
    fs
      .readdirSync(fixture.taskDir)
      .filter(
        (name) =>
          name.endsWith(".tmp") ||
          name.endsWith(".enriched.md") ||
          /^TASK-100-(?:[A-Z]|FU\d+)-/.test(name),
      ),
  ).toEqual([]);
}

export function writeAdapter(root: string, overrides: Record<string, unknown> = {}): string {
  const adapterPath = path.join(root, ".quack", "adapter.json");
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(
    adapterPath,
    JSON.stringify({
      version: "1.0",
      project: {
        name: "duplicate-claimants-fixture",
        root,
        taskDir: "docs/tasks",
        conventionsDir: "docs/conventions",
      },
      agent: {},
      verification: {
        commands: [{ name: "fixture", command: "echo ok", required: true, timeout: 60_000 }],
      },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "Automated-By: Quack",
        autoPush: false,
      },
      logging: { level: "info", dir: ".quack/logs", sessionDir: ".quack/logs" },
      ...overrides,
    }),
    "utf-8",
  );
  return adapterPath;
}

export async function postJson(
  port: number,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const request = http.request(
      {
        hostname: "localhost",
        port,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(encoded),
        },
      },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString("utf-8");
        });
        response.on("end", () => {
          resolve({
            status: response.statusCode ?? 0,
            body: JSON.parse(responseBody) as Record<string, unknown>,
          });
        });
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.write(encoded);
    request.end();
  });
}

export function expectPinnedHttpRefusal(
  response: { status: number; body: Record<string, unknown> },
  claimants: string[],
): void {
  expect(response.status).toBe(409);
  expect(response.body).toEqual({
    ok: false,
    error: "duplicate_claimants",
    taskId: "TASK-100",
    claimants,
    message: `Task TASK-100 has duplicate claimants: ${claimants.join(", ")}. Refusing to write until the id has one owner.`,
  });
}

export function removeFixture(root: string): void {
  fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}
