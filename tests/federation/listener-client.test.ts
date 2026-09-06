import { ListenerClient, type ListenerTransport } from "../../src/federation/listener-client";

describe("ListenerClient", () => {
  it("retries retryable listener failures", async () => {
    let calls = 0;
    const transport: ListenerTransport = () => {
      calls += 1;
      if (calls < 3) {
        return Promise.resolve({ statusCode: 503, body: { error: "unavailable" } });
      }
      return Promise.resolve({ statusCode: 202, body: { ok: true } });
    };
    const client = new ListenerClient("http://listener.local", {
      retries: 2,
      backoffMs: 0,
      transport,
    });

    const result = await client.submit("/v1/federation/jobs", { taskId: "TASK-838" });

    expect(result).toEqual({
      ok: true,
      retryable: false,
      attempts: 3,
      statusCode: 202,
      body: { ok: true },
    });
  });

  it("does not retry non-retryable client failures", async () => {
    let calls = 0;
    const transport: ListenerTransport = () => {
      calls += 1;
      return Promise.resolve({ statusCode: 403, body: { error: "scope" } });
    };
    const client = new ListenerClient("http://listener.local", {
      retries: 2,
      backoffMs: 0,
      transport,
    });

    const result = await client.submit("/v1/federation/jobs", { taskId: "TASK-838" });

    expect(calls).toBe(1);
    expect(result).toMatchObject({
      ok: false,
      retryable: false,
      attempts: 1,
      statusCode: 403,
    });
  });

  it("returns a retryable contract after transport exceptions exhaust", async () => {
    const transport: ListenerTransport = () => Promise.reject(new Error("network down"));
    const client = new ListenerClient("http://listener.local", {
      retries: 1,
      backoffMs: 0,
      transport,
    });

    const result = await client.status("/api/health");

    expect(result).toMatchObject({
      ok: false,
      retryable: true,
      attempts: 2,
      error: "network down",
    });
  });
});
