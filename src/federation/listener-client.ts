import * as http from "node:http";
import * as https from "node:https";

export interface ListenerRequest {
  method: "GET" | "POST";
  url: string;
  body?: unknown;
  timeoutMs: number;
}

export interface ListenerResponse {
  statusCode: number;
  body: unknown;
}

export type ListenerTransport = (request: ListenerRequest) => Promise<ListenerResponse>;

export interface ListenerClientOptions {
  retries?: number;
  timeoutMs?: number;
  backoffMs?: number;
  transport?: ListenerTransport;
}

export interface ListenerClientResult {
  ok: boolean;
  retryable: boolean;
  attempts: number;
  statusCode?: number;
  body?: unknown;
  error?: string;
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function defaultTransport(request: ListenerRequest): Promise<ListenerResponse> {
  return new Promise((resolve, reject) => {
    const url = new URL(request.url);
    const payload = request.body === undefined ? undefined : JSON.stringify(request.body);
    const client = url.protocol === "https:" ? https : http;
    const req = client.request(
      {
        hostname: url.hostname,
        port: url.port,
        path: `${url.pathname}${url.search}`,
        method: request.method,
        timeout: request.timeoutMs,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        let raw = "";
        res.on("data", (chunk: Buffer | string) => {
          raw += typeof chunk === "string" ? chunk : chunk.toString("utf-8");
        });
        res.on("end", () => {
          try {
            resolve({ statusCode: res.statusCode ?? 0, body: raw ? JSON.parse(raw) : null });
          } catch {
            resolve({ statusCode: res.statusCode ?? 0, body: raw });
          }
        });
      },
    );
    req.on("timeout", () => {
      req.destroy(new Error("listener request timed out"));
    });
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

export class ListenerClient {
  private readonly retries: number;
  private readonly timeoutMs: number;
  private readonly backoffMs: number;
  private readonly transport: ListenerTransport;

  constructor(
    private readonly baseUrl: string,
    options: ListenerClientOptions = {},
  ) {
    this.retries = options.retries ?? 2;
    this.timeoutMs = options.timeoutMs ?? 5000;
    this.backoffMs = options.backoffMs ?? 100;
    this.transport = options.transport ?? defaultTransport;
  }

  async submit(path: string, body: unknown): Promise<ListenerClientResult> {
    return this.request("POST", path, body);
  }

  async status(path: string): Promise<ListenerClientResult> {
    return this.request("GET", path);
  }

  async cancel(path: string, body: unknown): Promise<ListenerClientResult> {
    return this.request("POST", path, body);
  }

  private async request(
    method: ListenerRequest["method"],
    path: string,
    body?: unknown,
  ): Promise<ListenerClientResult> {
    let attempts = 0;
    let lastError = "";

    for (let attempt = 0; attempt <= this.retries; attempt += 1) {
      attempts = attempt + 1;
      try {
        const response = await this.transport({
          method,
          url: new URL(path, this.baseUrl).toString(),
          body,
          timeoutMs: this.timeoutMs,
        });
        const ok = response.statusCode >= 200 && response.statusCode < 300;
        const retryable = response.statusCode >= 500 || response.statusCode === 429;
        if (ok || !retryable || attempt === this.retries) {
          return {
            ok,
            retryable,
            attempts,
            statusCode: response.statusCode,
            body: response.body,
          };
        }
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt === this.retries) {
          return {
            ok: false,
            retryable: true,
            attempts,
            error: lastError,
          };
        }
      }
      if (this.backoffMs > 0) {
        await delay(this.backoffMs * attempts);
      }
    }

    return {
      ok: false,
      retryable: true,
      attempts,
      error: lastError || "listener request failed",
    };
  }
}
