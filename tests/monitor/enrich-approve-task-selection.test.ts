// TASK-1334 S1-R4: enrich approve resolves the PARENT once on real disk.
//
// PRE-CHANGE OBSERVATION (2447d7ba, ablation worktree, 2026-08-16): all four
// arms FAILED; approve wrote the child instead of the parent, and content
// declaring TASK-999 was accepted with 200 because no declared-id guard
// existed before the slice.

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { createMonitorServer } from "../../src/monitor/server";

function spec(id: string, status = "READY"): string {
  return [
    `# ${id}: selection fixture`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 1-2 hours",
    `- **Status:** ${status}`,
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** fixture",
    "",
    "## Problem Statement",
    `${id} must resolve to its own file.`,
    "",
    "## Success Criteria",
    "- [ ] The correct spec changes",
    "",
    "## Testing Requirements",
    "- [ ] Exercise the real directory",
    "",
  ].join("\n");
}

function writeAdapter(projectRoot: string): string {
  const adapterPath = path.join(projectRoot, ".quack", "adapter.json");
  fs.mkdirSync(path.dirname(adapterPath), { recursive: true });
  fs.writeFileSync(
    adapterPath,
    JSON.stringify({
      version: "1.0",
      project: {
        name: "selection-fixture",
        root: projectRoot,
        taskDir: "docs/tasks",
        conventionsDir: "docs/conventions",
      },
      agent: {},
      verification: {
        commands: [{ name: "fixture", command: "echo ok", required: true, timeout: 60000 }],
      },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "Automated-By: Quack",
        autoPush: false,
      },
      logging: { level: "info", dir: ".quack/logs", sessionDir: ".quack/logs" },
    }),
    "utf-8",
  );
  return adapterPath;
}

async function postJson(
  port: number,
  pathname: string,
  body: Record<string, unknown>,
): Promise<{ status: number; body: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const encoded = JSON.stringify(body);
    const req = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: pathname,
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(encoded),
        },
      },
      (res) => {
        let responseBody = "";
        res.on("data", (chunk: Buffer) => {
          responseBody += chunk.toString("utf-8");
        });
        res.on("end", () => {
          resolve({
            status: res.statusCode ?? 0,
            body: JSON.parse(responseBody) as Record<string, unknown>,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.write(encoded);
    req.end();
  });
}

/**
 * Both CREATION orders. Creating the child first is what reproduces the defect
 * on NTFS, but that is a property of this filesystem rather than a guarantee,
 * so neither result is allowed to depend on it.
 */
describe.each([["child-first"], ["parent-first"]])(
  "TASK-1334: enrich approve writes the parent, not its subtask (%s)",
  (order) => {
    let root: string;
    let taskDir: string;
    let parentPath: string;
    let childPath: string;
    let parentBefore: string;
    let childBefore: string;
    let adapterPath: string;
    let stopServer: (() => Promise<void>) | undefined;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-enrich-approve-selection-"));
      taskDir = path.join(root, "docs", "tasks");
      fs.mkdirSync(taskDir, { recursive: true });
      parentPath = path.join(taskDir, "TASK-100-parent.md");
      childPath = path.join(taskDir, "TASK-100-A-child.md");

      const files: Array<[string, string]> = [
        [childPath, spec("TASK-100-A")],
        [parentPath, spec("TASK-100")],
      ];
      for (const [filePath, fileContent] of order === "child-first"
        ? files
        : [...files].reverse()) {
        fs.writeFileSync(filePath, fileContent, "utf-8");
      }
      parentBefore = fs.readFileSync(parentPath, "utf-8");
      childBefore = fs.readFileSync(childPath, "utf-8");
      adapterPath = writeAdapter(root);
      fs.mkdirSync(path.join(root, ".quack", "logs"), { recursive: true });
      fs.writeFileSync(path.join(root, ".quack", "logs", "sessions.jsonl"), "", "utf-8");
    });

    afterEach(async () => {
      if (stopServer) {
        await stopServer();
        stopServer = undefined;
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    async function startServer(): Promise<number> {
      const server = createMonitorServer({
        logDir: path.join(root, ".quack", "logs"),
        port: 0,
        host: "127.0.0.1",
        projectRoot: root,
        taskDir: "docs/tasks",
        adapterPath,
        quackRoot: root,
      });
      const started = await server.start();
      stopServer = started.stop;
      return started.port;
    }

    it("reproduces the wrong-pick condition, so the fixture is not vacuous", () => {
      // The CONTROL. If the naive selector ever stops preferring the child on
      // this order, the fixture no longer exercises the defect and the
      // assertion below would pass for the wrong reason.
      const naive = fs
        .readdirSync(taskDir)
        .find((f) => f.startsWith("TASK-100") && f.endsWith(".md"));
      expect(naive).toBeDefined();
      if (order === "child-first") {
        expect(naive).toBe("TASK-100-A-child.md");
      }
    });

    it("atomically approves parent-declared content only to the parent", async () => {
      const approvedContent = `${spec("TASK-100")}\n## Approved Enrichment\nparent only\n`;
      const port = await startServer();

      const response = await postJson(port, "/api/tasks/TASK-100/enrich/approve", {
        content: approvedContent,
      });

      expect(response.status).toBe(200);
      expect(response.body.ok).toBe(true);
      expect(response.body.filePath).toBe(parentPath);
      expect(fs.readFileSync(parentPath, "utf-8")).toBe(approvedContent);
      expect(fs.readFileSync(childPath, "utf-8")).toBe(childBefore);
    });

    it("refuses a different declared id without changing either file", async () => {
      const port = await startServer();

      const response = await postJson(port, "/api/tasks/TASK-100/enrich/approve", {
        content: spec("TASK-999"),
      });

      expect(response.status).toBe(400);
      expect(String(response.body.error)).toContain("TASK-999");
      expect(fs.readFileSync(parentPath, "utf-8")).toBe(parentBefore);
      expect(fs.readFileSync(childPath, "utf-8")).toBe(childBefore);
    });

    it("refuses a heading the parser would throw on, without changing either file", async () => {
      // Round 2 (R2-2): the old guard was case-insensitive while parseH1 is
      // not, so this content was ACCEPTED and persisted as a file the parser
      // then rejected, turning a live spec into a parse error.
      const port = await startServer();

      const response = await postJson(port, "/api/tasks/TASK-100/enrich/approve", {
        content: "# task-100: lowercase heading\n\nbody\n",
      });

      expect(response.status).toBe(400);
      expect(fs.readFileSync(parentPath, "utf-8")).toBe(parentBefore);
      expect(fs.readFileSync(childPath, "utf-8")).toBe(childBefore);
    });
  },
);
