import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";
import { once } from "node:events";

import express from "express";

import { registerTemplateRoutes, type ProjectContext } from "../../src/monitor/routes/templates";
import { taskSpec, type FixtureCreationOrder } from "../helpers/divergent-task-fixture";

async function post(
  port: number,
  body: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  const payload = JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        hostname: "127.0.0.1",
        port,
        path: "/api/templates/extract",
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (response) => {
        let responseBody = "";
        response.on("data", (chunk) => {
          responseBody += String(chunk);
        });
        response.on("end", () => resolve({ status: response.statusCode ?? 0, body: responseBody }));
        response.on("error", reject);
      },
    );
    request.on("error", reject);
    request.end(payload);
  });
}

describe("TASK-1339-B: template extraction route canonical selection", () => {
  it.each<FixtureCreationOrder>(["child-first", "parent-first"])(
    "uses the custom taskDir and descriptive parent when created %s",
    async (order) => {
      const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "quack-template-route-selection-"));
      const relativeTaskDir = "custom/task-specs";
      const taskDir = path.join(projectRoot, "custom", "task-specs");
      fs.mkdirSync(taskDir, { recursive: true });
      const files: Array<[string, string]> = [
        [
          path.join(taskDir, "TASK-100-A-child.md"),
          taskSpec("TASK-100-A", { status: "COMPLETE", tags: ["child-template"] }),
        ],
        [
          path.join(taskDir, "TASK-100-parent.md"),
          taskSpec("TASK-100", { status: "COMPLETE", tags: ["parent-template"] }),
        ],
      ];
      for (const [filePath, content] of order === "child-first" ? files : [...files].reverse()) {
        fs.writeFileSync(filePath, content, "utf-8");
      }

      const logsDir = path.join(projectRoot, ".quack", "logs");
      fs.mkdirSync(logsDir, { recursive: true });
      fs.writeFileSync(
        path.join(logsDir, "sessions.jsonl"),
        `${JSON.stringify({
          taskId: "TASK-100",
          sessionId: "parent-session",
          outcome: "approved",
          costUsd: 1,
          turnsUsed: 1,
          retriesUsed: 0,
          taskTags: ["parent-template"],
          targetFiles: ["src/task-100.ts"],
          criteriaResults: [],
          feedbackThemes: [],
          gateScore: 5,
          complexity: { filesToModify: 1, successCriteria: 1 },
        })}\n`,
        "utf-8",
      );

      const app = express();
      app.use(express.json());
      registerTemplateRoutes(
        app,
        () =>
          ({
            projectRoot,
            taskDir: relativeTaskDir,
          }) as ProjectContext,
      );
      const server = app.listen(0, "127.0.0.1");
      try {
        await once(server, "listening");
        const address = server.address();
        if (!address || typeof address === "string")
          throw new Error("Expected an assigned test port");

        const response = await post(address.port, { taskId: "TASK-100" });

        expect(response.status).toBe(200);
        const data = JSON.parse(response.body) as {
          ok: boolean;
          template: { sourceTaskId: string; tags: string[] };
        };
        expect(data).toMatchObject({
          ok: true,
          template: { sourceTaskId: "TASK-100", tags: ["parent-template"] },
        });
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
        fs.rmSync(projectRoot, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
      }
    },
  );
});
