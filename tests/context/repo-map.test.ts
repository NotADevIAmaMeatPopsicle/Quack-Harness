import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import {
  generateRepoMap,
  formatRepoMap,
  parseExports,
  type RepoMapEntry,
} from "../../src/context/repo-map";

// ─── parseExports ────────────────────────────────────────────────────

describe("parseExports", () => {
  it("extracts exported functions", () => {
    const content = `
export function authenticate(user: string): boolean {
  return true;
}
export async function fetchData(): Promise<void> {}
`;
    const exports = parseExports(content);
    expect(exports).toContain("authenticate");
    expect(exports).toContain("fetchData");
  });

  it("extracts exported classes", () => {
    const content = `
export class UserService {
  getUser() {}
}
export abstract class BaseService {}
`;
    const exports = parseExports(content);
    expect(exports).toContain("UserService");
    expect(exports).toContain("BaseService");
  });

  it("extracts exported interfaces", () => {
    const content = `
export interface ParsedTask {
  id: string;
}
export interface TaskContext {
  spec: string;
}
`;
    const exports = parseExports(content);
    expect(exports).toContain("ParsedTask");
    expect(exports).toContain("TaskContext");
  });

  it("extracts exported types", () => {
    const content = `
export type TaskPriority = "HIGH" | "LOW";
export type AgentFit = "high" | "medium";
`;
    const exports = parseExports(content);
    expect(exports).toContain("TaskPriority");
    expect(exports).toContain("AgentFit");
  });

  it("extracts exported const/let/var", () => {
    const content = `
export const MAX_RETRIES = 3;
export let counter = 0;
export var legacy = true;
`;
    const exports = parseExports(content);
    expect(exports).toContain("MAX_RETRIES");
    expect(exports).toContain("counter");
    expect(exports).toContain("legacy");
  });

  it("extracts exported enums", () => {
    const content = `
export enum Status {
  READY = "READY",
  DONE = "DONE",
}
`;
    const exports = parseExports(content);
    expect(exports).toContain("Status");
  });

  it("extracts named re-exports", () => {
    const content = `
export { foo, bar } from "./utils";
export { baz as qux } from "./helpers";
`;
    const exports = parseExports(content);
    expect(exports).toContain("foo");
    expect(exports).toContain("bar");
    expect(exports).toContain("qux"); // renamed via 'as'
    expect(exports).not.toContain("baz"); // original name excluded
  });

  it("extracts export default", () => {
    const content = `
export default class MyClass {}
`;
    const exports = parseExports(content);
    expect(exports).toContain("MyClass");
  });

  it("extracts anonymous export default", () => {
    const content = `
export default {
  key: "value",
};
`;
    const exports = parseExports(content);
    expect(exports).toContain("default");
  });

  it("deduplicates export names", () => {
    const content = `
export function foo() {}
export function foo() {} // duplicate
`;
    const exports = parseExports(content);
    expect(exports.filter((e) => e === "foo")).toHaveLength(1);
  });

  it("returns empty array for files with no exports", () => {
    const content = `
const internal = 42;
function helper() {}
`;
    const exports = parseExports(content);
    expect(exports).toHaveLength(0);
  });
});

// ─── generateRepoMap ─────────────────────────────────────────────────

describe("generateRepoMap", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-repo-map-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeFile(relativePath: string, content: string): void {
    const absolutePath = path.join(tmpDir, relativePath);
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
    fs.writeFileSync(absolutePath, content, "utf-8");
  }

  it("finds TypeScript exports correctly", async () => {
    writeFile(
      "src/core/types.ts",
      `export interface ParsedTask { id: string; }
export type TaskPriority = "HIGH" | "LOW";
export function parseTask() {}
`,
    );

    const entries = await generateRepoMap(tmpDir, ["src/**/*.ts"]);

    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe("src/core/types.ts");
    expect(entries[0].exports).toContain("ParsedTask");
    expect(entries[0].exports).toContain("TaskPriority");
    expect(entries[0].exports).toContain("parseTask");
  });

  it("handles class names and function signatures", async () => {
    writeFile(
      "src/worker/agent.ts",
      `export class AgentWorker {
  async run() {}
}
export async function runAgent(opts: RunOptions): Promise<Result> {}
export abstract class BaseWorker {}
`,
    );

    const entries = await generateRepoMap(tmpDir, ["src/**/*.ts"]);

    expect(entries).toHaveLength(1);
    expect(entries[0].exports).toContain("AgentWorker");
    expect(entries[0].exports).toContain("runAgent");
    expect(entries[0].exports).toContain("BaseWorker");
  });

  it("respects maxFiles limit", async () => {
    // Create 10 files
    for (let i = 0; i < 10; i++) {
      writeFile(`src/file${i.toString().padStart(2, "0")}.ts`, `export const value${i} = ${i};`);
    }

    const entries = await generateRepoMap(tmpDir, ["src/**/*.ts"], {
      maxFiles: 3,
    });

    expect(entries).toHaveLength(3);
  });

  it("excludes test files by default", async () => {
    writeFile("src/core/types.ts", "export interface Foo {}");
    writeFile("src/core/types.test.ts", 'describe("types", () => {});');

    const entries = await generateRepoMap(tmpDir, ["src/**/*.ts"]);

    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe("src/core/types.ts");
  });

  it("excludes node_modules by default", async () => {
    writeFile("src/index.ts", "export const main = 1;");
    writeFile("node_modules/some-pkg/index.ts", "export const pkg = 1;");

    const entries = await generateRepoMap(tmpDir, ["**/*.ts"]);

    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe("src/index.ts");
  });

  it("excludes dist by default", async () => {
    writeFile("src/index.ts", "export const main = 1;");
    writeFile("dist/index.ts", "export const compiled = 1;");

    const entries = await generateRepoMap(tmpDir, ["**/*.ts"]);

    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe("src/index.ts");
  });

  it("supports custom exclude patterns", async () => {
    writeFile("src/core/types.ts", "export interface Foo {}");
    writeFile("src/generated/auto.ts", "export const auto = 1;");

    const entries = await generateRepoMap(tmpDir, ["src/**/*.ts"], {
      excludePatterns: ["**/generated/**"],
    });

    expect(entries).toHaveLength(1);
    expect(entries[0].file).toBe("src/core/types.ts");
  });

  it("returns empty entries for empty directory", async () => {
    const entries = await generateRepoMap(tmpDir, ["src/**/*.ts"]);
    expect(entries).toHaveLength(0);
  });

  it("returns empty entries for non-existent directory", async () => {
    const entries = await generateRepoMap(path.join(tmpDir, "nonexistent"), ["src/**/*.ts"]);
    expect(entries).toHaveLength(0);
  });

  it("counts lines correctly", async () => {
    writeFile(
      "src/index.ts",
      `line 1
line 2
line 3
export const x = 1;
`,
    );

    const entries = await generateRepoMap(tmpDir, ["src/**/*.ts"]);
    expect(entries[0].lineCount).toBe(5); // 4 lines + trailing newline = 5
  });

  it("sorts entries by file path", async () => {
    writeFile("src/z.ts", "export const z = 1;");
    writeFile("src/a.ts", "export const a = 1;");
    writeFile("src/m.ts", "export const m = 1;");

    const entries = await generateRepoMap(tmpDir, ["src/**/*.ts"]);

    expect(entries.map((e) => e.file)).toEqual(["src/a.ts", "src/m.ts", "src/z.ts"]);
  });

  it("handles JavaScript files", async () => {
    writeFile("src/utils.js", "export function helper() {}");

    const entries = await generateRepoMap(tmpDir, ["src/**/*.js"]);
    expect(entries).toHaveLength(1);
    expect(entries[0].exports).toContain("helper");
  });
});

// ─── formatRepoMap ───────────────────────────────────────────────────

describe("formatRepoMap", () => {
  it("produces compact output with file paths and exports", () => {
    const entries: RepoMapEntry[] = [
      {
        file: "src/core/types.ts",
        exports: ["ParsedTask", "TaskContext", "AgentResult"],
        lineCount: 428,
      },
      {
        file: "src/worker/agent-worker.ts",
        exports: ["runAgent", "RunAgentOptions"],
        lineCount: 394,
      },
    ];

    const output = formatRepoMap(entries);

    expect(output).toContain("## Repository Map");
    expect(output).toContain("src/core/types.ts (428 lines): ParsedTask, TaskContext, AgentResult");
    expect(output).toContain("src/worker/agent-worker.ts (394 lines): runAgent, RunAgentOptions");
  });

  it("shows (no exports) for files without exports", () => {
    const entries: RepoMapEntry[] = [{ file: "src/config.ts", exports: [], lineCount: 10 }];

    const output = formatRepoMap(entries);
    expect(output).toContain("src/config.ts (10 lines): (no exports)");
  });

  it("returns (empty) for zero entries", () => {
    const output = formatRepoMap([]);
    expect(output).toContain("## Repository Map");
    expect(output).toContain("(empty)");
  });

  it("produces output under 5K tokens for typical project", () => {
    // Simulate a project with 50 files, ~3 exports each
    const entries: RepoMapEntry[] = [];
    for (let i = 0; i < 50; i++) {
      entries.push({
        file: `src/module${i}/handler.ts`,
        exports: [`Handler${i}`, `Config${i}`, `create${i}`],
        lineCount: 100 + i,
      });
    }

    const output = formatRepoMap(entries);
    // Rough estimate: 1 token ~ 4 chars, so 5K tokens ~ 20K chars
    expect(output.length).toBeLessThan(20000);
  });
});
