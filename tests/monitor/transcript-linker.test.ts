import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

import { discoverTranscripts, copyTranscript } from "../../src/monitor/transcript-linker";

// ─── Helpers ─────────────────────────────────────────────────────

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function writeTranscriptLine(data: Record<string, unknown>): string {
  return JSON.stringify(data);
}

function writeTranscriptFile(
  dir: string,
  fileName: string,
  lines: Record<string, unknown>[],
  mtimeMs?: number,
): string {
  const filePath = path.join(dir, fileName);
  const content = lines.map((l) => writeTranscriptLine(l)).join("\n") + "\n";
  fs.writeFileSync(filePath, content, "utf-8");
  if (mtimeMs !== undefined) {
    const mtime = new Date(mtimeMs);
    fs.utimesSync(filePath, mtime, mtime);
  }
  return filePath;
}

// ─── Tests ──────────────────────────────────────────────────────

describe("transcript-linker", () => {
  describe("discoverTranscripts", () => {
    it("discovers transcript by branch name and time window", async () => {
      const claudeDir = makeTempDir("quack-transcript-test-");
      const projectDir = path.join(claudeDir, "projects", "my-project");
      fs.mkdirSync(projectDir, { recursive: true });

      const now = Date.now();
      writeTranscriptFile(
        projectDir,
        "abc-123.jsonl",
        [
          { type: "summary", sessionId: "abc-123", gitBranch: "quack/TASK-027-some-desc" },
          { type: "message", sessionId: "abc-123", message: { role: "user", content: "hello" } },
        ],
        now - 1000,
      );

      const results = await discoverTranscripts(
        "/fake/project",
        "TASK-027",
        now - 5000,
        now,
        claudeDir,
      );

      expect(results).toHaveLength(1);
      expect(results[0].claudeSessionId).toBe("abc-123");
      expect(results[0].sourcePath).toContain("abc-123.jsonl");
    });

    it("handles no matching transcript gracefully", async () => {
      const claudeDir = makeTempDir("quack-transcript-test-");
      const projectDir = path.join(claudeDir, "projects", "my-project");
      fs.mkdirSync(projectDir, { recursive: true });

      const now = Date.now();
      // Write a transcript with a different branch
      writeTranscriptFile(
        projectDir,
        "xyz-456.jsonl",
        [{ type: "summary", sessionId: "xyz-456", gitBranch: "main" }],
        now - 1000,
      );

      const results = await discoverTranscripts(
        "/fake/project",
        "TASK-027",
        now - 5000,
        now,
        claudeDir,
      );

      expect(results).toHaveLength(0);
    });

    it("handles missing .claude/projects directory", async () => {
      const claudeDir = makeTempDir("quack-transcript-test-");
      // Don't create the projects subdirectory

      const now = Date.now();
      const results = await discoverTranscripts(
        "/fake/project",
        "TASK-027",
        now - 5000,
        now,
        claudeDir,
      );

      expect(results).toHaveLength(0);
    });

    it("handles multiple matches and picks closest by timestamp", async () => {
      const claudeDir = makeTempDir("quack-transcript-test-");
      const projectDir = path.join(claudeDir, "projects", "my-project");
      fs.mkdirSync(projectDir, { recursive: true });

      const startTime = Date.now() - 10000;

      // Older transcript (further from start)
      writeTranscriptFile(
        projectDir,
        "old-session.jsonl",
        [{ type: "summary", sessionId: "old-session", gitBranch: "quack/TASK-027-desc" }],
        startTime - 2000,
      );

      // Closer transcript (nearer to start)
      writeTranscriptFile(
        projectDir,
        "close-session.jsonl",
        [{ type: "summary", sessionId: "close-session", gitBranch: "quack/TASK-027-desc" }],
        startTime + 500,
      );

      const results = await discoverTranscripts(
        "/fake/project",
        "TASK-027",
        startTime,
        Date.now(),
        claudeDir,
      );

      expect(results.length).toBeGreaterThanOrEqual(2);
      // Closest to startTime should be first
      expect(results[0].claudeSessionId).toBe("close-session");
    });

    it("filters out transcripts outside the time window", async () => {
      const claudeDir = makeTempDir("quack-transcript-test-");
      const projectDir = path.join(claudeDir, "projects", "my-project");
      fs.mkdirSync(projectDir, { recursive: true });

      const now = Date.now();
      // Write a transcript from a very long time ago
      writeTranscriptFile(
        projectDir,
        "ancient.jsonl",
        [{ type: "summary", sessionId: "ancient", gitBranch: "quack/TASK-027-desc" }],
        now - 3600000, // 1 hour ago
      );

      const results = await discoverTranscripts(
        "/fake/project",
        "TASK-027",
        now - 5000,
        now,
        claudeDir,
      );

      expect(results).toHaveLength(0);
    });

    it("scans multiple project subdirectories", async () => {
      const claudeDir = makeTempDir("quack-transcript-test-");
      const proj1 = path.join(claudeDir, "projects", "proj-a");
      const proj2 = path.join(claudeDir, "projects", "proj-b");
      fs.mkdirSync(proj1, { recursive: true });
      fs.mkdirSync(proj2, { recursive: true });

      const now = Date.now();
      writeTranscriptFile(
        proj2,
        "found-it.jsonl",
        [{ type: "summary", sessionId: "found-it", gitBranch: "quack/TASK-030" }],
        now - 1000,
      );

      const results = await discoverTranscripts(
        "/fake/project",
        "TASK-030",
        now - 5000,
        now,
        claudeDir,
      );

      expect(results).toHaveLength(1);
      expect(results[0].claudeSessionId).toBe("found-it");
    });
  });

  describe("copyTranscript", () => {
    it("copies transcript with correct naming", async () => {
      const srcDir = makeTempDir("quack-transcript-src-");
      const destDir = makeTempDir("quack-transcript-dest-");

      const srcPath = path.join(srcDir, "original.jsonl");
      fs.writeFileSync(srcPath, '{"type":"message"}\n', "utf-8");

      const result = await copyTranscript(srcPath, destDir, "quack-TASK-027-20240101-120000", 0);

      expect(result.success).toBe(true);
      expect(result.destPath).toContain(
        "transcript-quack-TASK-027-20240101-120000-attempt-0.jsonl",
      );
      expect(fs.existsSync(result.destPath!)).toBe(true);

      const content = fs.readFileSync(result.destPath!, "utf-8");
      expect(content).toBe('{"type":"message"}\n');
    });

    it("creates destination directory if it does not exist", async () => {
      const srcDir = makeTempDir("quack-transcript-src-");
      const destDir = path.join(makeTempDir("quack-transcript-dest-"), "nested", "logs");

      const srcPath = path.join(srcDir, "original.jsonl");
      fs.writeFileSync(srcPath, '{"line":1}\n', "utf-8");

      const result = await copyTranscript(srcPath, destDir, "sess-1", 2);

      expect(result.success).toBe(true);
      expect(fs.existsSync(result.destPath!)).toBe(true);
      expect(result.destPath).toContain("transcript-sess-1-attempt-2.jsonl");
    });

    it("handles missing source file gracefully", async () => {
      const destDir = makeTempDir("quack-transcript-dest-");

      const result = await copyTranscript(
        "/nonexistent/path/transcript.jsonl",
        destDir,
        "sess-1",
        0,
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("Failed to copy transcript");
    });
  });

  describe("API endpoint (via server)", () => {
    // These tests verify the transcript endpoint integration in server.ts
    // by creating transcript files in a temp log directory and testing
    // the GET /api/tasks/:id/transcript route.

    let logDir: string;
    let stopServer: (() => Promise<void>) | undefined;

    beforeEach(() => {
      logDir = makeTempDir("quack-transcript-api-");
      // Write sessions.jsonl so reader doesn't complain
      fs.writeFileSync(path.join(logDir, "sessions.jsonl"), "", "utf-8");
    });

    afterEach(async () => {
      if (stopServer) {
        await stopServer();
        stopServer = undefined;
      }
    });

    async function httpGet(url: string): Promise<{ status: number; body: string }> {
      const http = await import("node:http");
      return new Promise((resolve, reject) => {
        http
          .get(url, (res) => {
            let body = "";
            res.on("data", (chunk: Buffer) => (body += chunk.toString()));
            res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
            res.on("error", reject);
          })
          .on("error", reject);
      });
    }

    it("returns 404 for missing transcript", async () => {
      const { createMonitorServer } =
        (await import("../../src/monitor/server")) as typeof import("../../src/monitor/server");
      const server = createMonitorServer({ logDir, port: 0, host: "127.0.0.1" });
      const { port, stop } = await server.start();
      stopServer = stop;

      const { status, body } = await httpGet(
        `http://127.0.0.1:${port}/api/tasks/TASK-027/transcript?run=quack-TASK-027-20240101&attempt=0`,
      );

      expect(status).toBe(404);
      expect(JSON.parse(body)).toEqual({ error: "Transcript not found" });
    });

    it("returns 400 when run parameter is missing", async () => {
      const { createMonitorServer } =
        (await import("../../src/monitor/server")) as typeof import("../../src/monitor/server");
      const server = createMonitorServer({ logDir, port: 0, host: "127.0.0.1" });
      const { port, stop } = await server.start();
      stopServer = stop;

      const { status, body } = await httpGet(
        `http://127.0.0.1:${port}/api/tasks/TASK-027/transcript`,
      );

      expect(status).toBe(400);
      expect(JSON.parse(body)).toEqual({ error: "Missing required query parameter: run" });
    });

    it("returns transcript data for valid session", async () => {
      // Write a transcript file in the log directory
      const transcriptContent =
        '{"type":"message","role":"user"}\n{"type":"message","role":"assistant"}\n';
      const transcriptFile = "transcript-quack-TASK-027-20240101-120000-attempt-0.jsonl";
      fs.writeFileSync(path.join(logDir, transcriptFile), transcriptContent, "utf-8");

      const { createMonitorServer } =
        (await import("../../src/monitor/server")) as typeof import("../../src/monitor/server");
      const server = createMonitorServer({ logDir, port: 0, host: "127.0.0.1" });
      const { port, stop } = await server.start();
      stopServer = stop;

      const { status, body } = await httpGet(
        `http://127.0.0.1:${port}/api/tasks/TASK-027/transcript?run=quack-TASK-027-20240101-120000&attempt=0`,
      );

      expect(status).toBe(200);
      expect(body).toBe(transcriptContent);
    });

    it("defaults to attempt 0 when not specified", async () => {
      const transcriptContent = '{"type":"test"}\n';
      const transcriptFile = "transcript-sess-abc-attempt-0.jsonl";
      fs.writeFileSync(path.join(logDir, transcriptFile), transcriptContent, "utf-8");

      const { createMonitorServer } =
        (await import("../../src/monitor/server")) as typeof import("../../src/monitor/server");
      const server = createMonitorServer({ logDir, port: 0, host: "127.0.0.1" });
      const { port, stop } = await server.start();
      stopServer = stop;

      const { status, body } = await httpGet(
        `http://127.0.0.1:${port}/api/tasks/TASK-001/transcript?run=sess-abc`,
      );

      expect(status).toBe(200);
      expect(body).toBe(transcriptContent);
    });
  });
});
