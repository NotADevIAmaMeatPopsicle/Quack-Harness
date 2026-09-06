// ─── Coordination Routes (TASK-926) ───────────────────────────────
// Agent-to-agent coordination broker. See docs/tasks/TASK-926-*.md.
//
// Surface: four endpoints under /v1/coordination/* backed by the
// coordination_messages SQLite table (migration v5).
//
// Auth: scoped service tokens with `coordination:read` and/or
// `coordination:write` scopes, mapped to participant identities via
// the static TOKEN_PARTICIPANT_MAP below.

import * as crypto from "node:crypto";

import type { Express, Request, Response } from "express";
import { z } from "zod";

import type { AuthService } from "../auth.js";

// ─── Participant + Token Mapping ──────────────────────────────────

// Human pair participants (operator/contributor/reviewer) plus the CC-inbox lane:
// `echo` = the Hermes gateway bot, which forwards Slack "@echo cc:" messages
// into the broker; `cc` = a Claude Code admin session that reads/acks them.
// The echo<->cc lane is deliberately separate from the human operator<->contributor lane
// so neither participant's GET feed sees the other lane's traffic.
const PARTICIPANT_IDS = ["operator", "contributor", "reviewer", "echo", "cc"] as const;
export type ParticipantId = (typeof PARTICIPANT_IDS)[number];

/**
 * Static map of service-token id → participant id. Adding a new participant
 * requires (1) issuing a token with this id via scripts/admin/issue-coordination-tokens.mjs,
 * and (2) extending this map.
 */
const TOKEN_PARTICIPANT_MAP: Record<string, ParticipantId> = {
  "coord-operator": "operator",
  "coord-contributor": "contributor",
  "coord-reviewer": "reviewer",
  "coord-echo": "echo",
  "coord-cc": "cc",
};

function participantForToken(tokenId: string): ParticipantId | null {
  return TOKEN_PARTICIPANT_MAP[tokenId] ?? null;
}

/**
 * Participant lanes. A message may only flow between participants in the SAME
 * lane. This isolates the CC-inbox lane (echo<->cc) from the human pair lane
 * (operator/contributor/reviewer): a coord-echo or coord-cc token can never write into a
 * human inbox, and vice versa. Existing human<->human traffic (any pair among
 * operator/contributor/reviewer) is unaffected because they share the "human" lane.
 */
const PARTICIPANT_LANE: Record<ParticipantId, "human" | "cc-inbox"> = {
  operator: "human",
  contributor: "human",
  reviewer: "human",
  echo: "cc-inbox",
  cc: "cc-inbox",
};

function sameLane(a: ParticipantId, b: ParticipantId): boolean {
  return PARTICIPANT_LANE[a] === PARTICIPANT_LANE[b];
}

// ─── Helpers ──────────────────────────────────────────────────────

export function pairId(from: ParticipantId, to: ParticipantId): string {
  return [from, to].sort((a, b) => a.localeCompare(b)).join(":");
}

function generateMessageId(): string {
  return "msg_" + crypto.randomBytes(6).toString("hex");
}

function generateTopicId(from: ParticipantId, to: ParticipantId): string {
  const ts = Date.now().toString(36);
  const tag = crypto.randomBytes(3).toString("hex");
  const ordered = [from, to].sort((a, b) => a.localeCompare(b)).join("_");
  return `topic_${ordered}_${ts}${tag}`;
}

// ─── Schemas ──────────────────────────────────────────────────────

const participantSchema = z.enum(PARTICIPANT_IDS);
const kindSchema = z.enum(["ask", "fyi", "blocked", "reply"]);

const contextSchema = z
  .object({
    branch: z.string().trim().min(1).max(200).optional(),
    sha: z.string().trim().min(1).max(64).optional(),
    files: z.array(z.string().trim().min(1).max(500)).max(50).optional(),
    taskId: z.string().trim().min(1).max(100).optional(),
    // Slack round-trip routing for the echo<->cc CC-inbox lane. Lets the CC
    // session reply into the originating Slack thread (via `hermes send`) after
    // it handles a forwarded "@echo cc:" message. Optional + additive; the
    // human operator<->contributor lane never sets it.
    slack: z
      .object({
        channel: z.string().trim().min(1).max(64),
        threadTs: z.string().trim().min(1).max(64).optional(),
        user: z.string().trim().min(1).max(64).optional(),
      })
      .strict()
      .optional(),
  })
  .strict()
  .optional();

const postMessageBodySchema = z
  .object({
    from: participantSchema,
    to: participantSchema,
    kind: kindSchema,
    body: z.string().trim().min(1).max(16000),
    subject: z.string().trim().min(1).max(200).optional(),
    topicId: z.string().trim().min(1).max(128).optional(),
    parentId: z.string().trim().min(1).max(64).optional(),
    context: contextSchema,
  })
  .strict()
  .refine((v) => v.from !== v.to, {
    message: "`from` and `to` must differ",
    path: ["to"],
  });

const getMessagesQuerySchema = z
  .object({
    for: participantSchema,
    status: z.enum(["unread", "read", "replied", "all"]).default("unread"),
    since: z
      .string()
      .trim()
      .regex(/^\d{4}-\d{2}-\d{2}T/, "since must be ISO 8601")
      .optional(),
    topic: z.string().trim().min(1).max(128).optional(),
    limit: z.coerce.number().int().min(1).max(200).default(100),
  })
  .strict();

const ackBodySchema = z
  .object({
    status: z.enum(["read", "replied"]),
    replyId: z.string().trim().min(1).max(64).optional(),
  })
  .strict();

// ─── Row + Response Types ─────────────────────────────────────────

interface CoordinationMessageRow {
  message_id: string;
  topic_id: string | null;
  parent_id: string | null;
  pair_id: string;
  from_id: string;
  to_id: string;
  kind: string;
  subject: string | null;
  body: string;
  context_json: string | null;
  status: string;
  posted_at: string;
  ack_at: string | null;
  reply_id: string | null;
}

interface CoordinationMessageResponse {
  messageId: string;
  topicId: string | null;
  parentId: string | null;
  from: ParticipantId;
  to: ParticipantId;
  kind: string;
  subject: string | null;
  body: string;
  context: Record<string, unknown> | null;
  status: string;
  postedAt: string;
  ackAt: string | null;
  replyId: string | null;
}

function rowToResponse(row: CoordinationMessageRow): CoordinationMessageResponse {
  let context: Record<string, unknown> | null = null;
  if (row.context_json) {
    try {
      context = JSON.parse(row.context_json) as Record<string, unknown>;
    } catch {
      context = null;
    }
  }
  return {
    messageId: row.message_id,
    topicId: row.topic_id,
    parentId: row.parent_id,
    from: row.from_id as ParticipantId,
    to: row.to_id as ParticipantId,
    kind: row.kind,
    subject: row.subject,
    body: row.body,
    context,
    status: row.status,
    postedAt: row.posted_at,
    ackAt: row.ack_at,
    replyId: row.reply_id,
  };
}

// ─── SSE Subscriber Pool ──────────────────────────────────────────

interface CoordinationSubscriber {
  id: string;
  participant: ParticipantId;
  res: Response;
}

class CoordinationSubscriberPool {
  private subscribers: CoordinationSubscriber[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  add(participant: ParticipantId, res: Response, req: Request): string {
    const id = `coord-sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const origin = req.headers.origin;
    const headers: Record<string, string> = {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
    };
    if (origin) {
      headers["Access-Control-Allow-Origin"] = origin;
      headers["Access-Control-Allow-Credentials"] = "true";
    }
    res.writeHead(200, headers);
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId: id, participant })}\n\n`);

    const sub: CoordinationSubscriber = { id, participant, res };
    this.subscribers.push(sub);

    res.on("close", () => {
      this.subscribers = this.subscribers.filter((s) => s.id !== id);
    });

    return id;
  }

  emit(message: CoordinationMessageResponse): void {
    const payload = JSON.stringify(message);
    for (const sub of this.subscribers) {
      if (sub.participant !== message.to) continue;
      try {
        sub.res.write(`event: message\ndata: ${payload}\n\n`);
      } catch {
        // disconnected; cleaned up on res.close
      }
    }
  }

  startHeartbeat(intervalMs = 25_000): void {
    if (this.heartbeatInterval) return;
    this.heartbeatInterval = setInterval(() => {
      const comment = `:ping ${new Date().toISOString()}\n\n`;
      for (const sub of this.subscribers) {
        try {
          sub.res.write(comment);
        } catch {
          // ignore
        }
      }
    }, intervalMs);
    this.heartbeatInterval.unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  count(): number {
    return this.subscribers.length;
  }

  closeAll(): void {
    this.stopHeartbeat();
    for (const sub of this.subscribers) {
      try {
        sub.res.end();
      } catch {
        // ignore
      }
    }
    this.subscribers = [];
  }
}

// ─── Auth Helper ──────────────────────────────────────────────────

function authenticateCoordinationRequest(
  req: Request,
  res: Response,
  authService: AuthService,
  requiredScope: "coordination:read" | "coordination:write",
): { ok: true; participant: ParticipantId; tokenId: string } | null {
  const headerValue = req.header("x-quack-service-token");
  const token = typeof headerValue === "string" ? headerValue.trim() : undefined;
  const result = authService.validateServiceToken(token, requiredScope);

  if (!result.ok) {
    res.status(result.status).json({
      ok: false,
      error: result.error,
      message: result.message,
    });
    return null;
  }

  const participant = participantForToken(result.tokenId);
  if (!participant) {
    res.status(403).json({
      ok: false,
      error: "service_token_not_a_participant",
      message: `Service token ${result.tokenId} is not bound to a coordination participant.`,
    });
    return null;
  }

  return { ok: true, participant, tokenId: result.tokenId };
}

// ─── DB Accessor ──────────────────────────────────────────────────

// Structural view of the raw better-sqlite3 handle (QuackDB.raw()), covering
// only what these routes use. better-sqlite3 is lazily required elsewhere, so
// its types are not imported here.
interface CoordinationDbStatement {
  run(...params: unknown[]): unknown;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface CoordinationDb {
  prepare(sql: string): CoordinationDbStatement;
}

export interface CoordinationDeps {
  authService: AuthService;
  getDb: () => CoordinationDb;
  /** For tests: inject a subscriber pool. */
  subscriberPool?: CoordinationSubscriberPool;
}

// ─── Route Registration ──────────────────────────────────────────

export function registerCoordinationRoutes(
  app: Express,
  deps: CoordinationDeps,
): { closeAll: () => void } {
  const pool = deps.subscriberPool ?? new CoordinationSubscriberPool();
  pool.startHeartbeat();

  // ─── POST /v1/coordination/messages ─────────────────────────────
  app.post("/v1/coordination/messages", (req, res) => {
    const auth = authenticateCoordinationRequest(req, res, deps.authService, "coordination:write");
    if (!auth) return;

    const parsed = postMessageBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        ok: false,
        error: "validation_failed",
        details: parsed.error.flatten(),
      });
      return;
    }

    if (parsed.data.from !== auth.participant) {
      res.status(403).json({
        ok: false,
        error: "from_participant_mismatch",
        message: `Token bound to participant '${auth.participant}'; cannot post as '${parsed.data.from}'.`,
      });
      return;
    }

    // Lane isolation: reject any message that crosses between the human pair
    // lane (operator/contributor/reviewer) and the CC-inbox lane (echo/cc). Without this, a
    // valid coord-echo/coord-cc token could write directly into a human inbox.
    if (!sameLane(parsed.data.from, parsed.data.to)) {
      res.status(403).json({
        ok: false,
        error: "cross_lane_forbidden",
        message: `Participants '${parsed.data.from}' and '${parsed.data.to}' are in different coordination lanes.`,
      });
      return;
    }

    const db = deps.getDb();
    const messageId = generateMessageId();
    const topicId = parsed.data.topicId ?? generateTopicId(parsed.data.from, parsed.data.to);
    const postedAt = new Date().toISOString();
    const computedPairId = pairId(parsed.data.from, parsed.data.to);

    // Validate parent_id, if provided, exists in the same pair
    if (parsed.data.parentId) {
      const parentRow = db
        .prepare("SELECT pair_id FROM coordination_messages WHERE message_id = ?")
        .get(parsed.data.parentId) as { pair_id?: string } | undefined;
      if (!parentRow) {
        res.status(422).json({
          ok: false,
          error: "parent_id_not_found",
          message: `Parent message ${parsed.data.parentId} does not exist.`,
        });
        return;
      }
      if (parentRow.pair_id !== computedPairId) {
        res.status(422).json({
          ok: false,
          error: "parent_id_pair_mismatch",
          message: `Parent message ${parsed.data.parentId} belongs to a different pair.`,
        });
        return;
      }
    }

    db.prepare(
      `INSERT INTO coordination_messages
        (message_id, topic_id, parent_id, pair_id, from_id, to_id, kind, subject, body, context_json, status, posted_at, ack_at, reply_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'unread', ?, NULL, NULL)`,
    ).run(
      messageId,
      topicId,
      parsed.data.parentId ?? null,
      computedPairId,
      parsed.data.from,
      parsed.data.to,
      parsed.data.kind,
      parsed.data.subject ?? null,
      parsed.data.body,
      parsed.data.context ? JSON.stringify(parsed.data.context) : null,
      postedAt,
    );

    const inserted = db
      .prepare("SELECT * FROM coordination_messages WHERE message_id = ?")
      .get(messageId) as CoordinationMessageRow;

    const response = rowToResponse(inserted);

    // Fan out via SSE
    pool.emit(response);

    res.status(201).json({
      ok: true,
      messageId,
      topicId,
      postedAt,
    });
  });

  // ─── GET /v1/coordination/messages ──────────────────────────────
  app.get("/v1/coordination/messages", (req, res) => {
    const auth = authenticateCoordinationRequest(req, res, deps.authService, "coordination:read");
    if (!auth) return;

    const parsed = getMessagesQuerySchema.safeParse(req.query);
    if (!parsed.success) {
      res.status(422).json({
        ok: false,
        error: "validation_failed",
        details: parsed.error.flatten(),
      });
      return;
    }

    if (parsed.data.for !== auth.participant) {
      res.status(403).json({
        ok: false,
        error: "for_participant_mismatch",
        message: `Token bound to participant '${auth.participant}'; cannot query for '${parsed.data.for}'.`,
      });
      return;
    }

    const db = deps.getDb();
    const filters: string[] = ["to_id = ?"];
    const params: Array<string | number> = [parsed.data.for];

    if (parsed.data.status !== "all") {
      filters.push("status = ?");
      params.push(parsed.data.status);
    }
    if (parsed.data.since) {
      filters.push("posted_at > ?");
      params.push(parsed.data.since);
    }
    if (parsed.data.topic) {
      filters.push("topic_id = ?");
      params.push(parsed.data.topic);
    }

    const sql = `
      SELECT *
      FROM coordination_messages
      WHERE ${filters.join(" AND ")}
      ORDER BY posted_at ASC
      LIMIT ?
    `;
    params.push(parsed.data.limit);

    const rows = db.prepare(sql).all(...params) as CoordinationMessageRow[];
    const messages = rows.map(rowToResponse);

    const cursor = rows.length === parsed.data.limit ? rows[rows.length - 1].posted_at : null;

    res.status(200).json({
      ok: true,
      messages,
      cursor,
    });
  });

  // ─── POST /v1/coordination/messages/:id/ack ─────────────────────
  app.post("/v1/coordination/messages/:messageId/ack", (req, res) => {
    const auth = authenticateCoordinationRequest(req, res, deps.authService, "coordination:read");
    if (!auth) return;

    const parsed = ackBodySchema.safeParse(req.body);
    if (!parsed.success) {
      res.status(422).json({
        ok: false,
        error: "validation_failed",
        details: parsed.error.flatten(),
      });
      return;
    }

    const messageId = req.params.messageId;
    const db = deps.getDb();
    const row = db
      .prepare("SELECT * FROM coordination_messages WHERE message_id = ?")
      .get(messageId) as CoordinationMessageRow | undefined;

    if (!row) {
      res.status(404).json({
        ok: false,
        error: "message_not_found",
        message: `Message ${messageId} does not exist.`,
      });
      return;
    }

    if (row.to_id !== auth.participant) {
      res.status(403).json({
        ok: false,
        error: "ack_not_authorized",
        message: `Only the recipient (${row.to_id}) can ack this message.`,
      });
      return;
    }

    // Status transitions: unread → read → replied. Allow same-state ack as no-op success.
    // Block backwards transitions (replied → read, replied → unread, read → unread).
    const currentStatus = row.status;
    const targetStatus = parsed.data.status;
    const transitions: Record<string, string[]> = {
      unread: ["read", "replied"],
      read: ["replied"],
      replied: [],
    };
    const allowed = transitions[currentStatus] ?? [];
    if (currentStatus !== targetStatus && !allowed.includes(targetStatus)) {
      res.status(422).json({
        ok: false,
        error: "invalid_status_transition",
        message: `Cannot transition from '${currentStatus}' to '${targetStatus}'.`,
      });
      return;
    }

    const ackAt = new Date().toISOString();
    db.prepare(
      `UPDATE coordination_messages
       SET status = ?, ack_at = ?, reply_id = COALESCE(?, reply_id)
       WHERE message_id = ?`,
    ).run(targetStatus, ackAt, parsed.data.replyId ?? null, messageId);

    res.status(200).json({
      ok: true,
      messageId,
      status: targetStatus,
      ackAt,
    });
  });

  // ─── GET /v1/coordination/stream (SSE) ──────────────────────────
  app.get("/v1/coordination/stream", (req, res) => {
    const auth = authenticateCoordinationRequest(req, res, deps.authService, "coordination:read");
    if (!auth) return;

    const forParam = typeof req.query.for === "string" ? req.query.for : "";
    const forParsed = participantSchema.safeParse(forParam);
    if (!forParsed.success) {
      res.status(422).json({
        ok: false,
        error: "validation_failed",
        message: "Query param 'for' must be a valid participant id.",
      });
      return;
    }
    if (forParsed.data !== auth.participant) {
      res.status(403).json({
        ok: false,
        error: "for_participant_mismatch",
        message: `Token bound to participant '${auth.participant}'; cannot stream for '${forParsed.data}'.`,
      });
      return;
    }

    pool.add(forParsed.data, res, req);
  });

  return {
    closeAll: () => pool.closeAll(),
  };
}

// Exported for tests
export const __testing__ = {
  pairId,
  generateMessageId,
  generateTopicId,
  TOKEN_PARTICIPANT_MAP,
  CoordinationSubscriberPool,
};
