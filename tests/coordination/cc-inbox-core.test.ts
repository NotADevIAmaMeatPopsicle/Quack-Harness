// ─── TASK-1304: CC-inbox delivery core — ordering contract matrix ───

import {
  formatDeliveryLine,
  processMessages,
  summarizeUnread,
  type CcInboxIo,
  type CcInboxMessage,
} from "../../src/coordination/cc-inbox-core";

function msg(overrides: Partial<CcInboxMessage> = {}): CcInboxMessage {
  return {
    messageId: "msg-1",
    status: "unread",
    from: "operator",
    kind: "cc",
    subject: "subject line",
    body: "hello cc",
    context: { slack: { channel: "C0BA9AE96BT", threadTs: "1752.001", user: "U08FATG8SCX" } },
    postedAt: "2026-07-15T02:00:00.000Z",
    ...overrides,
  };
}

function makeIo(overrides: Partial<CcInboxIo> = {}): {
  io: CcInboxIo;
  events: string[];
} {
  const events: string[] = [];
  const io: CcInboxIo = {
    emit: (line) => events.push(`emit:${line}`),
    ack: (id) => {
      events.push(`ack:${id}`);
      return Promise.resolve(true);
    },
    warn: (line) => events.push(`warn:${line}`),
    ...overrides,
  };
  return { io, events };
}

describe("formatDeliveryLine", () => {
  test("keeps today's field contract exactly and adds redelivery=false for unread", () => {
    const parsed = JSON.parse(formatDeliveryLine(msg())) as Record<string, unknown>;
    expect(parsed).toEqual({
      cc_inbox: true,
      messageId: "msg-1",
      from: "operator",
      kind: "cc",
      subject: "subject line",
      body: "hello cc",
      slack: { channel: "C0BA9AE96BT", threadTs: "1752.001", user: "U08FATG8SCX" },
      postedAt: "2026-07-15T02:00:00.000Z",
      redelivery: false,
    });
  });

  test("marks redelivery for non-unread emissions and nulls missing slack context", () => {
    const parsed = JSON.parse(
      formatDeliveryLine(msg({ status: "read", context: undefined, subject: undefined })),
    ) as {
      redelivery: boolean;
      slack: Record<string, unknown>;
      subject: unknown;
    };
    expect(parsed.redelivery).toBe(true);
    expect(parsed.slack).toEqual({ channel: null, threadTs: null, user: null });
    expect(parsed.subject).toBeNull();
  });
});

describe("processMessages — ordering contract", () => {
  test("emits BEFORE acking for every message", async () => {
    const { io, events } = makeIo();
    const result = await processMessages([msg()], new Set(), io);
    expect(result).toEqual({ emitted: 1, acked: 1, ackFailures: 0 });
    expect(events[0].startsWith("emit:")).toBe(true);
    expect(events[1]).toBe("ack:msg-1");
  });

  test("a throwing emit leaves the message un-acked and un-counted", async () => {
    const { io, events } = makeIo({
      emit: () => {
        throw new Error("stdout gone");
      },
    });
    await expect(processMessages([msg()], new Set(), io)).rejects.toThrow("stdout gone");
    expect(events.some((e) => e.startsWith("ack:"))).toBe(false);
  });

  test("a failing ack warns, counts ackFailures, and the emission stands", async () => {
    const { io, events } = makeIo({ ack: () => Promise.resolve(false) });
    const result = await processMessages([msg()], new Set(), io);
    expect(result).toEqual({ emitted: 1, acked: 0, ackFailures: 1 });
    expect(events.filter((e) => e.startsWith("emit:"))).toHaveLength(1);
    expect(events.some((e) => e.startsWith("warn:") && e.includes("redelivery"))).toBe(true);
  });

  test("a throwing ack is caught, warned, and counted — never fatal", async () => {
    const { io } = makeIo({ ack: () => Promise.reject(new Error("broker down")) });
    const result = await processMessages([msg()], new Set(), io);
    expect(result).toEqual({ emitted: 1, acked: 0, ackFailures: 1 });
  });

  test("seen-set dedups within an invocation", async () => {
    const seen = new Set<string>();
    const { io } = makeIo();
    const first = await processMessages([msg(), msg()], seen, io);
    expect(first.emitted).toBe(1);
    const second = await processMessages([msg()], seen, io);
    expect(second.emitted).toBe(0);
  });

  test("non-unread messages emit as redelivery and are never acked", async () => {
    const { io, events } = makeIo();
    const result = await processMessages([msg({ status: "read" })], new Set(), io);
    expect(result).toEqual({ emitted: 1, acked: 0, ackFailures: 0 });
    expect(events.some((e) => e.startsWith("ack:"))).toBe(false);
    const line = JSON.parse(events[0].slice(5)) as { redelivery: boolean };
    expect(line.redelivery).toBe(true);
  });

  test("noAck emits without acking unread messages", async () => {
    const { io, events } = makeIo();
    const result = await processMessages([msg()], new Set(), io, { noAck: true });
    expect(result).toEqual({ emitted: 1, acked: 0, ackFailures: 0 });
    expect(events.some((e) => e.startsWith("ack:"))).toBe(false);
  });

  test("messages without a messageId are skipped defensively", async () => {
    const { io } = makeIo();
    const result = await processMessages([msg({ messageId: "" })], new Set(), io);
    expect(result.emitted).toBe(0);
  });
});

describe("summarizeUnread (--check)", () => {
  test("reports count and the oldest postedAt", () => {
    const summary = summarizeUnread([
      msg({ messageId: "a", postedAt: "2026-07-15T03:00:00.000Z" }),
      msg({ messageId: "b", postedAt: "2026-07-15T01:00:00.000Z" }),
      msg({ messageId: "c", postedAt: undefined }),
    ]);
    expect(summary).toEqual({
      cc_check: true,
      unread: 3,
      oldestPostedAt: "2026-07-15T01:00:00.000Z",
    });
  });

  test("empty inbox reports zero with null oldest", () => {
    expect(summarizeUnread([])).toEqual({ cc_check: true, unread: 0, oldestPostedAt: null });
  });
});
