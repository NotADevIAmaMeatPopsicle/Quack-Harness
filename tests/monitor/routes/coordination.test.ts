// ─── Coordination Routes Tests (TASK-926) ────────────────────────
// Covers the 13 SC-6 cases from docs/tasks/TASK-926-*.md.
// Heavy: spins up a real monitor instance per test, seeds three tokens
// via the AuthService API, drives the four endpoints over real HTTP.

import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { createMonitorServer } from "../../../src/monitor/server";
import { pairId } from "../../../src/monitor/routes/coordination";

// We intentionally do NOT mock src/monitor/auth here — the real initAuthConfig
// reads .quack/auth.json from the tempdir projectRoot, which we seed via
// seedTokens() before starting the server. That gives us real service-token
// validation in the route handlers.

// ─── HTTP helpers (token-aware) ───────────────────────────────────

interface HttpResult {
  status: number;
  body: string;
  headers: http.IncomingHttpHeaders;
}

function httpJson(
  method: "GET" | "POST",
  url: string,
  opts: { token?: string; body?: Record<string, unknown> } = {},
): Promise<HttpResult> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const payload = opts.body ? JSON.stringify(opts.body) : "";
    const headers: http.OutgoingHttpHeaders = {};
    if (payload) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(payload);
    }
    if (opts.token) headers["X-Quack-Service-Token"] = opts.token;

    const req = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
      },
      (res) => {
        let buf = "";
        res.on("data", (c: Buffer) => (buf += c.toString()));
        res.on("end", () =>
          resolve({ status: res.statusCode ?? 0, body: buf, headers: res.headers }),
        );
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ─── Token seeding ────────────────────────────────────────────────

function hashServiceToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

interface SeededTokens {
  operator: string;
  contributor: string;
  reviewer: string;
}

function seedTokens(projectRoot: string): SeededTokens {
  const dir = path.join(projectRoot, ".quack");
  fs.mkdirSync(dir, { recursive: true });
  const operator = `qsvc_${crypto.randomBytes(8).toString("hex")}`;
  const contributor = `qsvc_${crypto.randomBytes(8).toString("hex")}`;
  const reviewer = `qsvc_${crypto.randomBytes(8).toString("hex")}`;
  const config = {
    users: [],
    serviceTokens: [
      {
        id: "coord-operator",
        tokenHash: hashServiceToken(operator),
        scopes: ["coordination:read", "coordination:write"],
        enabled: true,
      },
      {
        id: "coord-contributor",
        tokenHash: hashServiceToken(contributor),
        scopes: ["coordination:read", "coordination:write"],
        enabled: true,
      },
      {
        id: "coord-reviewer",
        tokenHash: hashServiceToken(reviewer),
        scopes: ["coordination:read", "coordination:write"],
        enabled: true,
      },
    ],
    apiKeys: [],
    sessionSecret: "test",
    sessionTtlMs: 86400000,
  };
  fs.writeFileSync(path.join(dir, "auth.json"), JSON.stringify(config, null, 2), "utf-8");
  return { operator, contributor, reviewer };
}

// ─── Test setup ───────────────────────────────────────────────────

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-coord-test-"));
}

describe("coordination routes (TASK-926)", () => {
  let projectRoot: string;
  let logDir: string;
  let tokens: SeededTokens;
  let baseUrl: string;
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(async () => {
    projectRoot = makeTempDir();
    logDir = makeTempDir();

    // Minimal project structure
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    const quackDir = path.join(projectRoot, ".quack");
    fs.mkdirSync(quackDir, { recursive: true });
    fs.writeFileSync(
      path.join(quackDir, "adapter.json"),
      JSON.stringify({
        project: { name: "test", language: "typescript", taskDir: "docs/tasks" },
        agent: {},
        verification: { commands: [] },
      }),
      "utf-8",
    );
    tokens = seedTokens(projectRoot);

    const serverObj = createMonitorServer({
      logDir,
      port: 0,
      host: "127.0.0.1",
      projectRoot,
      quackRoot: projectRoot, // ensures initAuthConfig reads our seeded .quack/auth.json
      adapterPath: path.join(projectRoot, ".quack", "adapter.json"),
      taskDir: "docs/tasks",
    });
    const { port, stop } = await serverObj.start();
    stopServer = stop;
    baseUrl = `http://127.0.0.1:${port}`;
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    try {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
    try {
      fs.rmSync(logDir, { recursive: true, force: true });
    } catch {
      /* ignore */
    }
  });

  // ─── pair_id canonicalization (SC-5) ─────────────────────────────
  it("pair_id is canonical regardless of from/to direction", () => {
    expect(pairId("contributor", "operator")).toBe(pairId("operator", "contributor"));
    expect(pairId("operator", "contributor")).toBe("operator:contributor");
    expect(pairId("reviewer", "operator")).toBe("operator:reviewer");
  });

  // ─── Test case 1: POST → row persisted with defaults ─────────────
  it("POST creates a message with defaults (status=unread, server topic + id)", async () => {
    const res = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.operator,
      body: {
        from: "operator",
        to: "contributor",
        kind: "ask",
        body: "Provider Schedules round-5 ready?",
      },
    });
    expect(res.status).toBe(201);
    const data = JSON.parse(res.body) as { messageId: string; topicId: string; postedAt: string };
    expect(data.messageId).toMatch(/^msg_[0-9a-f]{12}$/);
    expect(data.topicId).toMatch(/^topic_operator_contributor_/);
    expect(data.postedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  });

  // ─── Test case 2: from === to is rejected ────────────────────────
  it("POST rejects from === to with 422", async () => {
    const res = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.operator,
      body: { from: "operator", to: "operator", kind: "fyi", body: "talking to myself" },
    });
    expect(res.status).toBe(422);
  });

  // ─── Test case 3: token-vs-from mismatch is rejected ─────────────
  it("POST rejects when token participant != from with 403", async () => {
    // contributor's token tries to post as from=operator
    const res = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.contributor,
      body: { from: "operator", to: "contributor", kind: "ask", body: "spoofed" },
    });
    expect(res.status).toBe(403);
    const data = JSON.parse(res.body) as { error: string };
    expect(data.error).toBe("from_participant_mismatch");
  });

  // ─── Test case 4: parent_id must exist in same pair ──────────────
  it("POST with parentId requires parent to exist in same pair", async () => {
    // 4a: parent doesn't exist
    const noParent = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.operator,
      body: {
        from: "operator",
        to: "contributor",
        kind: "reply",
        body: "x",
        parentId: "msg_nonexistent",
      },
    });
    expect(noParent.status).toBe(422);
    expect((JSON.parse(noParent.body) as { error: string }).error).toBe("parent_id_not_found");

    // 4b: parent exists in DIFFERENT pair → rejected
    const operatorToContributor = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.operator,
      body: { from: "operator", to: "contributor", kind: "ask", body: "ping contributor" },
    });
    const parentInOtherPair = (JSON.parse(operatorToContributor.body) as { messageId: string })
      .messageId;

    const crossPair = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.operator,
      body: {
        from: "operator",
        to: "reviewer",
        kind: "reply",
        body: "cross-pair reply attempt",
        parentId: parentInOtherPair,
      },
    });
    expect(crossPair.status).toBe(422);
    expect((JSON.parse(crossPair.body) as { error: string }).error).toBe("parent_id_pair_mismatch");

    // 4c: parent exists in SAME pair → accepted
    const sameReply = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.contributor,
      body: {
        from: "contributor",
        to: "operator",
        kind: "reply",
        body: "yes ready",
        parentId: parentInOtherPair,
      },
    });
    expect(sameReply.status).toBe(201);
  });

  // ─── Test case 5: GET returns unread by default, scoped to token ─
  it("GET returns only unread messages scoped to the token's participant", async () => {
    // operator posts to contributor
    await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.operator,
      body: { from: "operator", to: "contributor", kind: "ask", body: "ping 1" },
    });
    // contributor posts to operator (different direction)
    await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.contributor,
      body: { from: "contributor", to: "operator", kind: "ask", body: "ping back" },
    });

    // contributor queries for=contributor → should see only operator→contributor
    const contributorView = await httpJson(
      "GET",
      `${baseUrl}/v1/coordination/messages?for=contributor`,
      {
        token: tokens.contributor,
      },
    );
    expect(contributorView.status).toBe(200);
    const contributorData = JSON.parse(contributorView.body) as {
      messages: Array<{ from: string; body: string }>;
    };
    expect(contributorData.messages.length).toBe(1);
    expect(contributorData.messages[0].from).toBe("operator");
    expect(contributorData.messages[0].body).toBe("ping 1");

    // operator queries for=operator → should see only contributor→operator
    const operatorView = await httpJson("GET", `${baseUrl}/v1/coordination/messages?for=operator`, {
      token: tokens.operator,
    });
    expect(operatorView.status).toBe(200);
    const operatorData = JSON.parse(operatorView.body) as { messages: Array<{ from: string }> };
    expect(operatorData.messages.length).toBe(1);
    expect(operatorData.messages[0].from).toBe("contributor");
  });

  // ─── Test case 6: GET ?for= mismatch is rejected ─────────────────
  it("GET rejects when ?for differs from token's bound participant", async () => {
    const res = await httpJson("GET", `${baseUrl}/v1/coordination/messages?for=operator`, {
      token: tokens.contributor,
    });
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { error: string }).error).toBe("for_participant_mismatch");
  });

  // ─── Test case 7: topic filter ───────────────────────────────────
  it("GET ?topic= filters to a single thread", async () => {
    // operator sends two messages on different topics
    const m1 = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.operator,
      body: {
        from: "operator",
        to: "contributor",
        kind: "ask",
        body: "topic A msg 1",
        topicId: "topic-A",
      },
    });
    await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.operator,
      body: {
        from: "operator",
        to: "contributor",
        kind: "ask",
        body: "topic B msg 1",
        topicId: "topic-B",
      },
    });
    // contributor replies on topic A
    await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.contributor,
      body: {
        from: "contributor",
        to: "operator",
        kind: "reply",
        body: "topic A reply",
        topicId: "topic-A",
        parentId: (JSON.parse(m1.body) as { messageId: string }).messageId,
      },
    });

    // contributor views topic-A only → should see operator's topic-A message
    const contributorTopicA = await httpJson(
      "GET",
      `${baseUrl}/v1/coordination/messages?for=contributor&topic=topic-A&status=all`,
      { token: tokens.contributor },
    );
    const contributorData = JSON.parse(contributorTopicA.body) as {
      messages: Array<{ topicId: string }>;
    };
    expect(contributorData.messages.length).toBe(1);
    expect(contributorData.messages[0].topicId).toBe("topic-A");
  });

  // ─── Test case 8: ack transitions + auth ────────────────────────
  it("ACK transitions status unread→read→replied; rejects backwards", async () => {
    const create = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.operator,
      body: { from: "operator", to: "contributor", kind: "ask", body: "for ack tests" },
    });
    const messageId = (JSON.parse(create.body) as { messageId: string }).messageId;

    // contributor acks unread → read
    const ack1 = await httpJson("POST", `${baseUrl}/v1/coordination/messages/${messageId}/ack`, {
      token: tokens.contributor,
      body: { status: "read" },
    });
    expect(ack1.status).toBe(200);
    expect((JSON.parse(ack1.body) as { status: string }).status).toBe("read");

    // contributor acks read → replied
    const ack2 = await httpJson("POST", `${baseUrl}/v1/coordination/messages/${messageId}/ack`, {
      token: tokens.contributor,
      body: { status: "replied", replyId: "msg_fakefakefake" },
    });
    expect(ack2.status).toBe(200);

    // contributor tries replied → read (backwards) → 422
    const ack3 = await httpJson("POST", `${baseUrl}/v1/coordination/messages/${messageId}/ack`, {
      token: tokens.contributor,
      body: { status: "read" },
    });
    expect(ack3.status).toBe(422);
    expect((JSON.parse(ack3.body) as { error: string }).error).toBe("invalid_status_transition");
  });

  // ─── Test case 9: ACK can only be done by recipient ─────────────
  it("ACK rejects when caller is not the message's recipient", async () => {
    const create = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.operator,
      body: { from: "operator", to: "contributor", kind: "ask", body: "addressed to contributor" },
    });
    const messageId = (JSON.parse(create.body) as { messageId: string }).messageId;

    // operator (the sender) tries to ack a message addressed to contributor → 403
    const res = await httpJson("POST", `${baseUrl}/v1/coordination/messages/${messageId}/ack`, {
      token: tokens.operator,
      body: { status: "read" },
    });
    expect(res.status).toBe(403);
    expect((JSON.parse(res.body) as { error: string }).error).toBe("ack_not_authorized");
  });

  // ─── Test case 10: missing token → 401 ───────────────────────────
  it("missing service token returns 401", async () => {
    const res = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      // no token
      body: { from: "operator", to: "contributor", kind: "ask", body: "anon" },
    });
    expect(res.status).toBe(401);
  });

  // ─── Test case 11: ACK on missing message → 404 ─────────────────
  it("ACK on nonexistent message returns 404", async () => {
    const res = await httpJson("POST", `${baseUrl}/v1/coordination/messages/msg_doesnotexist/ack`, {
      token: tokens.contributor,
      body: { status: "read" },
    });
    expect(res.status).toBe(404);
  });

  // ─── Test case 12: status=all returns everything for participant ─
  it("GET ?status=all returns read + replied + unread", async () => {
    const create = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.operator,
      body: { from: "operator", to: "contributor", kind: "fyi", body: "to be acked" },
    });
    const messageId = (JSON.parse(create.body) as { messageId: string }).messageId;
    await httpJson("POST", `${baseUrl}/v1/coordination/messages/${messageId}/ack`, {
      token: tokens.contributor,
      body: { status: "read" },
    });

    const allView = await httpJson(
      "GET",
      `${baseUrl}/v1/coordination/messages?for=contributor&status=all`,
      {
        token: tokens.contributor,
      },
    );
    expect(allView.status).toBe(200);
    const allData = JSON.parse(allView.body) as { messages: Array<{ status: string }> };
    expect(allData.messages.length).toBe(1);
    expect(allData.messages[0].status).toBe("read");

    // GET default (unread) should now return 0
    const unreadView = await httpJson(
      "GET",
      `${baseUrl}/v1/coordination/messages?for=contributor`,
      {
        token: tokens.contributor,
      },
    );
    const unreadData = JSON.parse(unreadView.body) as { messages: unknown[] };
    expect(unreadData.messages.length).toBe(0);
  });

  // ─── Test case 13: SSE stream delivers a posted message ─────────
  it("SSE stream pushes posted messages to a subscriber", async () => {
    // Open SSE stream as contributor
    const sseUrl = new URL(`${baseUrl}/v1/coordination/stream?for=contributor`);
    const received: string[] = [];
    let receivedConnected = false;

    const sseReq = await new Promise<http.ClientRequest>((resolve, reject) => {
      const req = http.request(
        {
          hostname: sseUrl.hostname,
          port: sseUrl.port,
          path: sseUrl.pathname + sseUrl.search,
          method: "GET",
          headers: {
            "X-Quack-Service-Token": tokens.contributor,
            Accept: "text/event-stream",
          },
        },
        (res) => {
          expect(res.statusCode).toBe(200);
          res.on("data", (chunk: Buffer) => {
            const block = chunk.toString();
            if (block.includes("event: connected")) receivedConnected = true;
            if (block.includes("event: message")) {
              const dataLine = block.split("\n").find((l) => l.startsWith("data:"));
              if (dataLine) received.push(dataLine.slice(5).trim());
            }
          });
        },
      );
      req.on("error", reject);
      req.end();
      // give it a moment to handshake
      setTimeout(() => resolve(req), 200);
    });

    // Wait until connected event arrived
    await new Promise((r) => setTimeout(r, 100));
    expect(receivedConnected).toBe(true);

    // Post a message operator → contributor
    const post = await httpJson("POST", `${baseUrl}/v1/coordination/messages`, {
      token: tokens.operator,
      body: { from: "operator", to: "contributor", kind: "ask", body: "live test" },
    });
    expect(post.status).toBe(201);

    // Give SSE a beat to deliver
    await new Promise((r) => setTimeout(r, 300));
    sseReq.destroy();

    expect(received.length).toBeGreaterThanOrEqual(1);
    const parsed = JSON.parse(received[0]) as { body: string; to: string };
    expect(parsed.body).toBe("live test");
    expect(parsed.to).toBe("contributor");
  });
});
