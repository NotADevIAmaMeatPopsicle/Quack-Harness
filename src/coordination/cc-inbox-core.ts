// ─── CC-inbox delivery core (TASK-1304 / P0-12) ─────────────────────
// The ordering-critical pipeline behind scripts/cc-inbox/poll.mjs,
// extracted so the at-least-once contract is unit-tested (the 1303
// testable-core + thin-invoker pattern).
//
// Contract: mark seen → EMIT FIRST → then ack unread→read. A crash at
// any instant may duplicate a delivery (visible, suppressible by the
// consumer via messageId + the broker's status) but can never lose one.
// Re-acks are safe: the broker treats same-state acks as 200 no-ops
// (routes/coordination.ts:557,567).

export interface CcInboxSlackContext {
  channel?: string | null;
  threadTs?: string | null;
  user?: string | null;
}

export interface CcInboxMessage {
  messageId: string;
  status: string;
  from?: string;
  kind?: string;
  subject?: string | null;
  body?: string;
  context?: { slack?: CcInboxSlackContext };
  postedAt?: string;
}

export interface CcInboxIo {
  /** Write one delivery line to stdout. Throwing aborts BEFORE the ack. */
  emit: (line: string) => void;
  /** Ack unread→read at the broker; resolve false on non-200. */
  ack: (messageId: string, to: "read") => Promise<boolean>;
  /** Non-fatal diagnostics (stderr). */
  warn: (line: string) => void;
}

export interface ProcessMessagesOptions {
  /** Debug: never ack (message re-lists every tick). */
  noAck?: boolean;
}

export interface ProcessMessagesResult {
  emitted: number;
  acked: number;
  ackFailures: number;
}

/**
 * Today's delivery-line JSON contract, field-for-field, plus
 * `redelivery`: true whenever the message is no longer unread at emit
 * time (`--drain-read` backlog re-emissions and races) so the consumer
 * has an explicit duplicate/redelivery signal.
 */
export function formatDeliveryLine(m: CcInboxMessage): string {
  const slack = m.context?.slack ?? {};
  return JSON.stringify({
    cc_inbox: true,
    messageId: m.messageId,
    from: m.from,
    kind: m.kind,
    subject: m.subject ?? null,
    body: m.body,
    slack: {
      channel: slack.channel ?? null,
      threadTs: slack.threadTs ?? null,
      user: slack.user ?? null,
    },
    postedAt: m.postedAt,
    redelivery: m.status !== "unread",
  });
}

export async function processMessages(
  messages: CcInboxMessage[],
  seen: Set<string>,
  io: CcInboxIo,
  options: ProcessMessagesOptions = {},
): Promise<ProcessMessagesResult> {
  let emitted = 0;
  let acked = 0;
  let ackFailures = 0;

  for (const message of messages) {
    if (!message.messageId || seen.has(message.messageId)) continue;
    seen.add(message.messageId);

    io.emit(formatDeliveryLine(message));
    emitted++;

    if (!options.noAck && message.status === "unread") {
      let ok = false;
      try {
        ok = await io.ack(message.messageId, "read");
      } catch (error: unknown) {
        io.warn(
          `ack read ${message.messageId} threw: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      if (ok) {
        acked++;
      } else {
        ackFailures++;
        io.warn(
          `ack read ${message.messageId} failed; message stays unread (will re-emit as redelivery)`,
        );
      }
    }
  }

  return { emitted, acked, ackFailures };
}

export interface UnreadSummary {
  cc_check: true;
  unread: number;
  oldestPostedAt: string | null;
}

/** The `--check` payload: pure read, acks nothing, emits no deliveries. */
export function summarizeUnread(messages: CcInboxMessage[]): UnreadSummary {
  let oldest: string | null = null;
  for (const message of messages) {
    const posted = message.postedAt ?? null;
    if (posted && (!oldest || posted.localeCompare(oldest) < 0)) {
      oldest = posted;
    }
  }
  return { cc_check: true, unread: messages.length, oldestPostedAt: oldest };
}
