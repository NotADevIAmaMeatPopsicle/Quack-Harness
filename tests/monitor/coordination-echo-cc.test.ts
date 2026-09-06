import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";

// ─── CC-inbox lane (echo <-> cc) coordination-broker tests ───────────
//
// Bite-proof intent: every assertion here FAILS on pre-change code, where
// PARTICIPANT_IDS is only [operator, contributor, reviewer] and coord-echo / coord-cc are
// not in TOKEN_PARTICIPANT_MAP (echo/cc post+query would 422 at the enum,
// and the tokens would 403 service_token_not_a_participant). The lane
// isolation and slack-context round-trip cases lock the new behavior in.

function makeTempDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function sha256(value: string): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

// Raw tokens the tests send; only their hashes are persisted (mirrors prod).
const TOK = {
  echo: "cc-inbox-test-echo-token",
  cc: "cc-inbox-test-cc-token",
  contributor: "cc-inbox-test-contributor-token",
  operator: "cc-inbox-test-operator-token",
};

function writeAuthConfig(quackRoot: string): void {
  const dir = path.join(quackRoot, ".quack");
  fs.mkdirSync(dir, { recursive: true });
  const coordScopes = ["coordination:read", "coordination:write"];
  fs.writeFileSync(
    path.join(dir, "auth.json"),
    JSON.stringify(
      {
        users: [],
        serviceTokens: [
          { id: "coord-echo", tokenHash: sha256(TOK.echo), scopes: coordScopes, enabled: true },
          { id: "coord-cc", tokenHash: sha256(TOK.cc), scopes: coordScopes, enabled: true },
          {
            id: "coord-contributor",
            tokenHash: sha256(TOK.contributor),
            scopes: coordScopes,
            enabled: true,
          },
          {
            id: "coord-operator",
            tokenHash: sha256(TOK.operator),
            scopes: coordScopes,
            enabled: true,
          },
        ],
        sessionSecret: "test",
        sessionTtlMs: 86400000,
      },
      null,
      2,
    ),
    "utf-8",
  );
}

async function pause(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function cleanupDir(targetPath: string): Promise<void> {
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      fs.rmSync(targetPath, { recursive: true, force: true, maxRetries: 4, retryDelay: 75 });
      return;
    } catch {
      await pause(125);
    }
  }
}

function req(
  method: "GET" | "POST",
  url: string,
  token: string,
  data?: Record<string, unknown>,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const urlObj = new URL(url);
    const postData = data ? JSON.stringify(data) : undefined;
    const headers: Record<string, string | number> = {};
    if (token) headers["X-Quack-Service-Token"] = token;
    if (postData) {
      headers["Content-Type"] = "application/json";
      headers["Content-Length"] = Buffer.byteLength(postData);
    }
    const r = http.request(
      {
        hostname: urlObj.hostname,
        port: urlObj.port,
        path: urlObj.pathname + urlObj.search,
        method,
        headers,
      },
      (res) => {
        let body = "";
        res.on("data", (chunk: Buffer | string) => {
          body += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      },
    );
    r.on("error", reject);
    if (postData) r.write(postData);
    r.end();
  });
}

describe("coordination broker: CC-inbox echo<->cc lane", () => {
  let projectRoot: string;
  let quackRoot: string;
  let stop: (() => Promise<void>) | null = null;
  let baseUrl: string;

  beforeEach(async () => {
    projectRoot = makeTempDir("quack-coord-project-");
    quackRoot = makeTempDir("quack-coord-root-");
    fs.mkdirSync(path.join(projectRoot, ".quack", "logs"), { recursive: true });
    writeAuthConfig(quackRoot);

    const port = 48000 + Math.floor(Math.random() * 1000);
    const server = createMonitorServer({
      projectRoot,
      taskDir: "docs/tasks",
      logDir: path.join(projectRoot, ".quack", "logs"),
      quackRoot,
      port,
    });
    const started = await server.start();
    stop = started.stop;
    baseUrl = `http://127.0.0.1:${port}`;
    await pause(150);
  });

  afterEach(async () => {
    if (stop) {
      await stop();
      stop = null;
    }
    await pause(150);
    await cleanupDir(projectRoot);
    await cleanupDir(quackRoot);
  });

  it("echo posts to cc, cc reads it, then acks read->replied (with slack context round-trip)", async () => {
    const posted = await req("POST", `${baseUrl}/v1/coordination/messages`, TOK.echo, {
      from: "echo",
      to: "cc",
      kind: "ask",
      subject: "from Slack",
      body: "@echo cc: please check the deploy status",
      context: { slack: { channel: "C0BA9AE96BT", threadTs: "1779300000.001", user: "Operator" } },
    });
    expect(posted.status).toBe(201);
    const postedBody = JSON.parse(posted.body) as { ok: boolean; messageId: string };
    expect(postedBody.ok).toBe(true);
    expect(postedBody.messageId).toMatch(/^msg_/);

    // cc sees exactly the one unread message, with slack routing preserved.
    const unread = await req(
      "GET",
      `${baseUrl}/v1/coordination/messages?for=cc&status=unread`,
      TOK.cc,
    );
    expect(unread.status).toBe(200);
    const unreadBody = JSON.parse(unread.body) as {
      messages: Array<{
        messageId: string;
        from: string;
        to: string;
        body: string;
        context: { slack?: { channel: string; threadTs?: string } };
      }>;
    };
    expect(unreadBody.messages).toHaveLength(1);
    const msg = unreadBody.messages[0];
    expect(msg.from).toBe("echo");
    expect(msg.to).toBe("cc");
    expect(msg.context.slack).toEqual({
      channel: "C0BA9AE96BT",
      threadTs: "1779300000.001",
      user: "Operator",
    });

    // cc acks unread -> read, then read -> replied.
    const ackRead = await req(
      "POST",
      `${baseUrl}/v1/coordination/messages/${msg.messageId}/ack`,
      TOK.cc,
      { status: "read" },
    );
    expect(ackRead.status).toBe(200);
    const ackReplied = await req(
      "POST",
      `${baseUrl}/v1/coordination/messages/${msg.messageId}/ack`,
      TOK.cc,
      { status: "replied" },
    );
    expect(ackReplied.status).toBe(200);
    expect(JSON.parse(ackReplied.body)).toMatchObject({ ok: true, status: "replied" });

    // No longer unread.
    const afterAck = await req(
      "GET",
      `${baseUrl}/v1/coordination/messages?for=cc&status=unread`,
      TOK.cc,
    );
    expect((JSON.parse(afterAck.body) as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it("keeps the echo<->cc lane isolated from the human contributor lane", async () => {
    await req("POST", `${baseUrl}/v1/coordination/messages`, TOK.echo, {
      from: "echo",
      to: "cc",
      kind: "fyi",
      body: "cc-only traffic",
    });
    // contributor's feed must not see echo<->cc traffic (different pair).
    const contributorFeed = await req(
      "GET",
      `${baseUrl}/v1/coordination/messages?for=contributor&status=all`,
      TOK.contributor,
    );
    expect(contributorFeed.status).toBe(200);
    expect((JSON.parse(contributorFeed.body) as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it("blocks cross-lane writes: echo cannot post into a human inbox (operator)", async () => {
    // The decisive isolation guarantee: a valid coord-echo token must not be
    // able to write into the human pair lane. Bite: without the lane check
    // this returns 201 and the message lands in operator's inbox.
    const resp = await req("POST", `${baseUrl}/v1/coordination/messages`, TOK.echo, {
      from: "echo",
      to: "operator",
      kind: "ask",
      body: "cross-lane injection attempt",
    });
    expect(resp.status).toBe(403);
    expect(JSON.parse(resp.body)).toMatchObject({ error: "cross_lane_forbidden" });

    // And operator's inbox is empty (nothing leaked in).
    const operatorFeed = await req(
      "GET",
      `${baseUrl}/v1/coordination/messages?for=operator&status=all`,
      TOK.operator,
    );
    expect((JSON.parse(operatorFeed.body) as { messages: unknown[] }).messages).toHaveLength(0);
  });

  it("leaves the human pair lane working: operator can post to contributor", async () => {
    // Regression guard: the lane check must not restrict existing human<->human
    // traffic (all three humans share the 'human' lane).
    const resp = await req("POST", `${baseUrl}/v1/coordination/messages`, TOK.operator, {
      from: "operator",
      to: "contributor",
      kind: "fyi",
      body: "human lane still open",
    });
    expect(resp.status).toBe(201);
    const contributorFeed = await req(
      "GET",
      `${baseUrl}/v1/coordination/messages?for=contributor&status=unread`,
      TOK.contributor,
    );
    expect(
      (JSON.parse(contributorFeed.body) as { messages: Array<{ from: string }> }).messages,
    ).toHaveLength(1);
  });

  it("rejects an echo token posting as cc (from_participant_mismatch)", async () => {
    const resp = await req("POST", `${baseUrl}/v1/coordination/messages`, TOK.echo, {
      from: "cc",
      to: "echo",
      kind: "fyi",
      body: "spoofed sender",
    });
    expect(resp.status).toBe(403);
    expect(JSON.parse(resp.body)).toMatchObject({ error: "from_participant_mismatch" });
  });

  it("rejects a malformed slack context block (strict schema)", async () => {
    const resp = await req("POST", `${baseUrl}/v1/coordination/messages`, TOK.echo, {
      from: "echo",
      to: "cc",
      kind: "ask",
      body: "bad routing",
      context: { slack: { threadTs: "1779300000.001" } }, // missing required channel
    });
    expect(resp.status).toBe(422);
    expect(JSON.parse(resp.body)).toMatchObject({ error: "validation_failed" });
  });
});
