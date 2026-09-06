// ─── SSE Manager ───────────────────────────────────────────────────
// Manages Server-Sent Events connections for the monitor dashboard.
// Handles client registration, broadcasting, session filtering,
// and heartbeat keep-alive.

import type { Request, Response } from "express";
import type { QuackEvent } from "./event-types.js";

interface SSEClient {
  id: string;
  res: Response;
  sessionFilter?: string;
}

export class SSEManager {
  private clients: SSEClient[] = [];
  private heartbeatInterval: ReturnType<typeof setInterval> | null = null;

  addClient(res: Response, sessionFilter?: string, req?: Request): string {
    const id = `sse-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const origin = req?.headers.origin;

    // Set SSE headers — only include CORS headers for cross-origin requests.
    // Setting "Access-Control-Allow-Origin: *" with credentials breaks cookie auth.
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

    // Send initial connection event
    res.write(`event: connected\ndata: ${JSON.stringify({ clientId: id })}\n\n`);

    const client: SSEClient = { id, res, sessionFilter };
    this.clients.push(client);

    // Remove client on close
    res.on("close", () => {
      this.clients = this.clients.filter((c) => c.id !== id);
    });

    return id;
  }

  broadcast(event: QuackEvent): void {
    let data: string;
    try {
      data = JSON.stringify(event);
    } catch (err) {
      console.error("[sse] Failed to serialize event (non-fatal):", err);
      if (err instanceof Error) {
        console.error("[sse] serialization error details:", {
          message: err.message,
          stage: event.stage,
          sessionId: event.sessionId,
        });
      }
      return;
    }

    for (const client of this.clients) {
      // Apply session filter if set
      if (client.sessionFilter && client.sessionFilter !== event.sessionId) {
        continue;
      }

      try {
        client.res.write(`event: quack-event\ndata: ${data}\n\n`);
      } catch {
        // Client disconnected — will be cleaned up on close
      }
    }
  }

  getClientCount(): number {
    return this.clients.length;
  }

  startHeartbeat(intervalMs = 30_000): void {
    if (this.heartbeatInterval) return;

    this.heartbeatInterval = setInterval(() => {
      const comment = `:heartbeat ${new Date().toISOString()}\n\n`;
      for (const client of this.clients) {
        try {
          client.res.write(comment);
        } catch {
          // Client disconnected
        }
      }
    }, intervalMs).unref();
  }

  stopHeartbeat(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }
  }

  closeAll(): void {
    this.stopHeartbeat();
    for (const client of this.clients) {
      try {
        client.res.end();
      } catch {
        // ignore
      }
    }
    this.clients = [];
  }
}
