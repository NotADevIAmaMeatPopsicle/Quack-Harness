// ─── SSE Connection Strategy ───────────────────────────────────────
// Quack Monitor exposes a single SSE feed at `/api/events/stream`. Every
// surface (queue, federation, fleet, testing, docs, workflow projection)
// broadcasts onto this single feed; clients filter by sessionId pattern
// or by event.stage.
//
// See docs/QUEUE_AND_FEDERATION_OPERATOR_MODEL.md §5.4 for the topology
// and the `sessionId` patterns:
//   - federation-{jobId}    per-job federation events
//   - dispatch-queue        local queue state
//   - fleet                 fleet control events
//   - testing               test runner output
//   - docs                  review/docs pipeline events
//   - workflow-projection   per-task workflow state changes
//
// Strategy: open ONE EventSource at app boot, maintain a Map<topic,
// Set<listener>>, and demux on receipt. Components subscribe via the
// `useSseTopic` hook (added in TASK-879 when real workflows land).

export interface SseEnvelope {
  sessionId: string;
  taskId?: string;
  project?: string;
  timestamp: string;
  stage: string;
  payload: Record<string, unknown>;
}

type Listener = (event: SseEnvelope) => void;

class SseHub {
  private source: EventSource | null = null;
  private listeners = new Map<string, Set<Listener>>();
  private status: "idle" | "connecting" | "open" | "closed" = "idle";
  private reconnectAttempts = 0;

  open(): void {
    if (this.source) return;
    this.status = "connecting";
    const source = new EventSource("/api/events/stream");
    source.onopen = () => {
      this.status = "open";
      this.reconnectAttempts = 0;
    };
    source.onmessage = (raw) => {
      try {
        if (typeof raw.data !== "string") {
          return;
        }
        const envelope = JSON.parse(raw.data) as SseEnvelope;
        this.dispatch(envelope);
      } catch {
        // ignore malformed; backend should always emit JSON
      }
    };
    source.onerror = () => {
      this.status = "closed";
      source.close();
      this.source = null;
      // Exponential backoff capped at 30s. EventSource has its own retry
      // baked in but only when the connection drops cleanly; on hard
      // failures we re-open manually.
      const delayMs = Math.min(30000, 500 * 2 ** this.reconnectAttempts);
      this.reconnectAttempts += 1;
      setTimeout(() => this.open(), delayMs);
    };
    this.source = source;
  }

  close(): void {
    this.source?.close();
    this.source = null;
    this.status = "closed";
  }

  /** Subscribe to envelopes whose sessionId matches `topic` exactly OR
   *  whose sessionId starts with `topic + "-"` (e.g., topic
   *  "federation" matches "federation-fed-task-123"). */
  subscribe(topic: string, listener: Listener): () => void {
    if (!this.listeners.has(topic)) {
      this.listeners.set(topic, new Set());
    }
    this.listeners.get(topic)!.add(listener);
    if (!this.source) this.open();
    return () => {
      this.listeners.get(topic)?.delete(listener);
    };
  }

  getStatus(): typeof this.status {
    return this.status;
  }

  private dispatch(envelope: SseEnvelope): void {
    for (const [topic, listeners] of this.listeners.entries()) {
      const matches = envelope.sessionId === topic
        || envelope.sessionId.startsWith(topic + "-");
      if (!matches) continue;
      for (const listener of listeners) {
        try {
          listener(envelope);
        } catch {
          // Swallow listener errors so one bad subscriber doesn't
          // break the hub.
        }
      }
    }
  }
}

export const sseHub = new SseHub();
