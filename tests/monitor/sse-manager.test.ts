import type { Response } from "express";
import { SSEManager } from "../../src/monitor/sse-manager";
import type { QuackEvent, AgentTurnPayload } from "../../src/monitor/event-types";

// ─── Mock Response ───────────────────────────────────────────────

interface MockResponseState {
  res: Response;
  written: string[];
  headArgs: unknown[][];
  ended: { value: boolean };
  onHandlers: Record<string, (() => void)[]>;
}

function createMockResponse(): MockResponseState {
  const written: string[] = [];
  const headArgs: unknown[][] = [];
  const ended = { value: false };
  const onHandlers: Record<string, (() => void)[]> = {};

  const res = {
    writeHead: (...args: unknown[]) => {
      headArgs.push(args);
    },
    write: (data: string) => {
      written.push(data);
      return true;
    },
    end: () => {
      ended.value = true;
    },
    on: (event: string, handler: () => void) => {
      if (!onHandlers[event]) onHandlers[event] = [];
      onHandlers[event].push(handler);
    },
  } as unknown as Response;

  return { res, written, headArgs, ended, onHandlers };
}

function makeEvent(sessionId = "session-1", stage = "agent_turn"): QuackEvent {
  const payload: AgentTurnPayload = { turnNumber: 1, role: "assistant", contentPreview: "test" };
  return {
    sessionId,
    taskId: "TASK-001",
    project: "test",
    timestamp: new Date().toISOString(),
    stage: stage as QuackEvent["stage"],
    payload,
  };
}

// ─── Tests ───────────────────────────────────────────────────────

describe("SSEManager", () => {
  let manager: SSEManager;

  beforeEach(() => {
    manager = new SSEManager();
  });

  afterEach(() => {
    manager.closeAll();
  });

  describe("addClient", () => {
    it("sends SSE headers and connected event", () => {
      const { res, headArgs, written } = createMockResponse();
      manager.addClient(res);

      expect(headArgs).toHaveLength(1);
      expect(headArgs[0][0]).toBe(200);
      expect(headArgs[0][1]).toHaveProperty("Content-Type", "text/event-stream");

      expect(written).toHaveLength(1);
      expect(written[0]).toContain("event: connected");
    });

    it("returns a unique client ID", () => {
      const { res: res1 } = createMockResponse();
      const { res: res2 } = createMockResponse();

      const id1 = manager.addClient(res1);
      const id2 = manager.addClient(res2);

      expect(id1).not.toBe(id2);
      expect(id1).toMatch(/^sse-/);
    });

    it("tracks client count", () => {
      expect(manager.getClientCount()).toBe(0);

      const { res } = createMockResponse();
      manager.addClient(res);
      expect(manager.getClientCount()).toBe(1);
    });

    it("removes client on close", () => {
      const mock = createMockResponse();
      manager.addClient(mock.res);
      expect(manager.getClientCount()).toBe(1);

      // Simulate connection close
      mock.onHandlers.close[0]();
      expect(manager.getClientCount()).toBe(0);
    });
  });

  describe("broadcast", () => {
    it("sends event to all connected clients", () => {
      const mock1 = createMockResponse();
      const mock2 = createMockResponse();
      manager.addClient(mock1.res);
      manager.addClient(mock2.res);

      const event = makeEvent();
      manager.broadcast(event);

      // Each client gets: connected event + broadcast event
      expect(mock1.written).toHaveLength(2);
      expect(mock2.written).toHaveLength(2);

      expect(mock1.written[1]).toContain("event: quack-event");
      expect(mock1.written[1]).toContain("TASK-001");
    });

    it("respects session filter", () => {
      const mock1 = createMockResponse();
      const mock2 = createMockResponse();
      manager.addClient(mock1.res, "session-1");
      manager.addClient(mock2.res, "session-2");

      manager.broadcast(makeEvent("session-1"));

      // mock1 should get it (filter matches), mock2 should not
      expect(mock1.written).toHaveLength(2); // connected + event
      expect(mock2.written).toHaveLength(1); // connected only
    });

    it("sends to unfiltered clients regardless of session", () => {
      const mock = createMockResponse();
      manager.addClient(mock.res); // no filter

      manager.broadcast(makeEvent("any-session"));
      expect(mock.written).toHaveLength(2); // connected + event
    });
  });

  describe("heartbeat", () => {
    it("starts and stops heartbeat", () => {
      jest.useFakeTimers();

      const mock = createMockResponse();
      manager.addClient(mock.res);

      manager.startHeartbeat(1000);

      jest.advanceTimersByTime(1000);
      // connected + heartbeat
      expect(mock.written.length).toBeGreaterThan(1);

      const countBefore = mock.written.length;
      manager.stopHeartbeat();
      jest.advanceTimersByTime(5000);
      expect(mock.written.length).toBe(countBefore);

      jest.useRealTimers();
    });

    it("does not start duplicate heartbeats", () => {
      manager.startHeartbeat(1000);
      manager.startHeartbeat(1000);
      manager.stopHeartbeat();
      // No error — idempotent
    });
  });

  describe("closeAll", () => {
    it("ends all client connections", () => {
      const mock1 = createMockResponse();
      const mock2 = createMockResponse();
      manager.addClient(mock1.res);
      manager.addClient(mock2.res);

      manager.closeAll();

      expect(mock1.ended.value).toBe(true);
      expect(mock2.ended.value).toBe(true);
      expect(manager.getClientCount()).toBe(0);
    });
  });
});
