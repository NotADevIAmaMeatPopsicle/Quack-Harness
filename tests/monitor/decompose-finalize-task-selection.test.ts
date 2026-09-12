// TASK-1334 S1-R4: HTTP decompose finalize resolves the PARENT once.
//
// PRE-CHANGE OBSERVATION (2447d7ba, ablation worktree, 2026-08-16): the
// unparseable-child arms FAILED in both creation orders (the route parsed the
// prefix-selected child and errored); the valid-child arms PASSED pre-change
// exactly as predicted below, which is why they are documented as steady-state
// coverage rather than proof.
// The valid-child arm is intentionally steady-state coverage and cannot expose
// the old split read/write by itself; the unparseable-child arm covers it.

import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";

import type { ChildDraft, DecompositionTopology } from "../../src/preflight/decompose-types";
import { computeDecompositionParentHash } from "../../src/preflight/task-decomposer";
import { createMonitorServer } from "../../src/monitor/server";

function spec(id: string, status = "READY", title = "selection fixture"): string {
  return [
    `# ${id}: ${title}`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 4-6 hours",
    `- **Status:** ${status}`,
    "- **Blocked By:** []",
    "- **Blocks:** []",
    "- **Tags:** fixture",
    "",
    "## Problem Statement",
    `${id} must resolve to its own authoritative file before decomposition so another prefix-matching task cannot be mutated.`,
    "",
    "## Current State",
    "The fixture has not been decomposed.",
    "",
    "## Recommended Approach",
    "Create two independently dispatchable child tasks.",
    "",
    "## Files to Modify",
    "",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    "| `src/fixture-a.ts` | Create | First fixture module |",
    "| `src/fixture-b.ts` | Create | Final fixture module |",
    "",
    "## Success Criteria",
    "- [ ] The first child owns fixture A",
    "- [ ] The final child verifies fixture B",
    "",
    "## Testing Requirements",
    "- [ ] Exercise the real directory",
    "- [ ] Verify the parent changes while the existing child remains byte-identical",
    "",
    "## Anti-Patterns",
    "- Do not select a task file by filename prefix alone",
    "",
    "## Context References",
    "- Parent task: TASK-100",
    "",
  ].join("\n");
}

function makeDraft(suffix: "A" | "B"): ChildDraft {
  const subtaskId = `TASK-100-${suffix}`;
  const title = suffix === "A" ? "generated first child" : "generated final child";
  const filePath = suffix === "A" ? "src/fixture-a.ts" : "src/fixture-b.ts";
  const criterion =
    suffix === "A" ? "The first child owns fixture A" : "The final child verifies fixture B";
  const blockedBy = suffix === "A" ? "[]" : "[TASK-100-A]";
  const markdown = [
    `# ${subtaskId}: ${title}`,
    "",
    "## Metadata",
    "- **Priority:** P2-MEDIUM",
    "- **Effort:** 2-3 hours",
    "- **Status:** READY",
    `- **Blocked By:** ${blockedBy}`,
    "- **Blocks:** []",
    "- **Tags:** fixture, decomposition",
    "",
    "## Problem Statement",
    `${subtaskId} owns one bounded fixture module and must remain independently dispatchable without changing its sibling's implementation scope.`,
    "",
    "## Current State",
    "The assigned fixture module does not exist yet and has no implementation coverage.",
    "",
    "## Recommended Approach",
    "Create only the assigned module, follow the parent contract, and verify its exact behavior.",
    "",
    "## Files to Modify",
    "",
    "| File | Action | Notes |",
    "|------|--------|-------|",
    `| \`${filePath}\` | Create | Owned fixture module |`,
    "",
    "## Success Criteria",
    `- [ ] ${criterion}`,
    "",
    "## Testing Requirements",
    "- [ ] Exercise the owned fixture behavior",
    "- [ ] Verify the task identity remains stable",
    "",
    "## Anti-Patterns",
    "- Do not widen the child beyond its assigned fixture module",
    "",
    "## Context References",
    "- Parent task: TASK-100",
    "",
  ].join("\n");
  return {
    subtaskId,
    title,
    markdown,
    sectionsPresent: [
      "Problem Statement",
      "Current State",
      "Recommended Approach",
      "Files to Modify",
      "Success Criteria",
      "Testing Requirements",
    ],
    prepScore: 4.8,
    prepReady: true,
    deficiencies: [],
  };
}

function makeDrafts(): ChildDraft[] {
  return [makeDraft("A"), makeDraft("B")];
}

function makeTopology(parentContent: string): DecompositionTopology {
  return {
    parentTaskId: "TASK-100",
    parentContentHash: computeDecompositionParentHash(parentContent),
    subtasks: [
      {
        id: "TASK-100-A",
        title: "generated first child",
        filesToModify: [
          { path: "src/fixture-a.ts", action: "Create", notes: "First fixture module" },
        ],
        successCriteria: ["The first child owns fixture A"],
        dependsOn: [],
        isFinal: false,
      },
      {
        id: "TASK-100-B",
        title: "generated final child",
        filesToModify: [
          { path: "src/fixture-b.ts", action: "Create", notes: "Final fixture module" },
        ],
        successCriteria: ["The final child verifies fixture B"],
        dependsOn: ["TASK-100-A"],
        isFinal: true,
      },
    ],
    coverageReport: {
      fileOwnership: [
        { filePath: "src/fixture-a.ts", ownedBy: "TASK-100-A", isShared: false },
        { filePath: "src/fixture-b.ts", ownedBy: "TASK-100-B", isShared: false },
      ],
      criterionOwnership: [
        { criterion: "The first child owns fixture A", ownedBy: ["TASK-100-A"] },
        { criterion: "The final child verifies fixture B", ownedBy: ["TASK-100-B"] },
      ],
      unmappedFiles: [],
      unmappedCriteria: [],
      duplicatedFiles: [],
      hasCoverageGap: false,
    },
  };
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

function writePassingPrep(projectRoot: string): void {
  const prepDir = path.join(projectRoot, ".quack", "prep");
  fs.mkdirSync(prepDir, { recursive: true });
  fs.writeFileSync(
    path.join(prepDir, "TASK-100.json"),
    JSON.stringify({
      taskId: "TASK-100",
      preparedAt: new Date(Date.now() + 1000).toISOString(),
      schemaValid: true,
      schemaErrors: [],
      depthScore: 4.8,
      depthReady: true,
      deficiencies: [],
      outcome: "pass",
      stale: false,
    }),
    "utf-8",
  );
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

const cases = [
  ["unparseable", "child-first"],
  ["unparseable", "parent-first"],
  ["valid", "child-first"],
  ["valid", "parent-first"],
] as const;

/**
 * Both CREATION orders for both child shapes. Creating the child first is what
 * reproduces the defect on NTFS, but that is a property of this filesystem
 * rather than a guarantee, so neither result is allowed to depend on it.
 */
describe.each(cases)(
  "TASK-1334: HTTP finalize writes the parent (%s child, %s)",
  (childShape, order) => {
    let root: string;
    let taskDir: string;
    let parentPath: string;
    let childPath: string;
    let childBefore: string;
    let adapterPath: string;
    let stopServer: (() => Promise<void>) | undefined;

    beforeEach(() => {
      root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-http-decompose-selection-"));
      taskDir = path.join(root, "docs", "tasks");
      fs.mkdirSync(taskDir, { recursive: true });
      parentPath = path.join(taskDir, "TASK-100-parent.md");
      childPath = path.join(taskDir, "TASK-100-0-child.md");

      const childContent =
        childShape === "valid" ? spec("TASK-100-Z") : "unparseable child sentinel\n";
      const files: Array<[string, string]> = [
        [childPath, childContent],
        [parentPath, spec("TASK-100")],
      ];
      for (const [filePath, fileContent] of order === "child-first"
        ? files
        : [...files].reverse()) {
        fs.writeFileSync(filePath, fileContent, "utf-8");
      }
      childBefore = fs.readFileSync(childPath, "utf-8");
      adapterPath = writeAdapter(root);
      fs.mkdirSync(path.join(root, ".quack", "logs"), { recursive: true });
      fs.writeFileSync(path.join(root, ".quack", "logs", "sessions.jsonl"), "", "utf-8");
      execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
      execFileSync("git", ["config", "user.email", "quack-test@example.com"], { cwd: root });
      execFileSync("git", ["config", "user.name", "Quack Test"], { cwd: root });
      execFileSync("git", ["config", "commit.gpgsign", "false"], { cwd: root });
      execFileSync("git", ["add", ".quack/adapter.json", "docs/tasks"], { cwd: root });
      execFileSync("git", ["commit", "-q", "-m", "fixture"], { cwd: root });

      // Finalize compares the parent spec mtime with this record, so the prep
      // fixture must be written only after both task files exist.
      writePassingPrep(root);
    });

    afterEach(async () => {
      if (stopServer) {
        await stopServer();
        stopServer = undefined;
      }
      fs.rmSync(root, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
    });

    it("reproduces the wrong-pick condition, so the fixture is not vacuous", () => {
      // The CONTROL. If the naive selector ever stops preferring the child on
      // this order, the fixture no longer exercises the defect and the
      // assertion below would pass for the wrong reason.
      const naive = fs
        .readdirSync(taskDir)
        .find((f) => f.startsWith("TASK-100") && f.endsWith(".md"));
      expect(naive).toBeDefined();
      if (order === "child-first") {
        expect(naive).toBe("TASK-100-0-child.md");
      }
    });

    it("finalizes the parent tracker, writes the draft, and preserves the child", async () => {
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

      const response = await postJson(started.port, "/api/tasks/TASK-100/decompose", {
        mode: "finalize",
        reviewAcknowledged: true,
        drafts: makeDrafts(),
        plan: makeTopology(spec("TASK-100")),
      });

      expect(response).toMatchObject({ status: 200, body: { ok: true } });
      expect(response.body.parentStatusUpdated).toBe(true);
      expect(response.body.subtaskIds).toEqual(["TASK-100-A", "TASK-100-B"]);

      const parentAfter = fs.readFileSync(parentPath, "utf-8");
      expect(parentAfter).toContain("**Status:** DECOMPOSED");
      expect(parentAfter).toContain("## Decomposition Summary");
      expect(fs.existsSync(path.join(taskDir, "TASK-100-A-generated-first-child.md"))).toBe(true);
      expect(fs.existsSync(path.join(taskDir, "TASK-100-B-generated-final-child.md"))).toBe(true);
      expect(fs.readFileSync(childPath, "utf-8")).toBe(childBefore);
    });
  },
);
