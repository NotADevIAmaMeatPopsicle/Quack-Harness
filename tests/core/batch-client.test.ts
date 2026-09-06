import { BatchClient, BatchRequest, DEFAULT_BATCH_CONFIG } from "../../src/core/batch-client";
import { batchEvaluateTaskDepth, _setQueryFn } from "../../src/gate/depth-evaluator";
import { batchJudge, _setQueryFn as _setJudgeQueryFn } from "../../src/judge/llm-judge";
import type { ParsedTask, BatchConfig as TypesBatchConfig } from "../../src/core/types";
import type { JudgeInput } from "../../src/judge/llm-judge";
import type { ProjectAdapter } from "../../src/core/adapter-loader";
import { BatchConfigSchema, AdapterConfigSchema } from "../../src/core/adapter-schema";

// ─── Mock fetch helpers ─────────────────────────────────────────────

type MockFetchFn = (input: string | URL | Request, init?: RequestInit) => Promise<Response>;

/**
 * Creates a mock Response object for testing fetch calls.
 * Only implements the fields used by BatchClient (ok, status, text, json).
 */
function mockResponse(body: unknown, status = 200, ok = true): Response {
  const bodyStr = typeof body === "string" ? body : JSON.stringify(body);
  return {
    ok,
    status,
    text: () => Promise.resolve(bodyStr),
    json: () => Promise.resolve(typeof body === "string" ? (JSON.parse(bodyStr) as unknown) : body),
  } as unknown as Response;
}

/**
 * Safely convert fetch input to string for URL checking.
 */
function inputToString(input: string | URL | Request): string {
  if (typeof input === "string") return input;
  if (input instanceof URL) return input.toString();
  return input.url;
}

/**
 * Creates a standard batch creation response.
 */
function makeBatchCreationResponse(batchId: string) {
  return {
    id: batchId,
    type: "message_batch",
    processing_status: "in_progress",
    request_counts: { processing: 2, succeeded: 0, errored: 0, canceled: 0, expired: 0 },
    results_url: null,
    created_at: "2024-01-01T00:00:00Z",
    expires_at: "2024-01-02T00:00:00Z",
    ended_at: null,
  };
}

/**
 * Creates a batch status response (in_progress or ended).
 */
function makeBatchStatusResponse(
  batchId: string,
  status: "in_progress" | "ended",
  resultsUrl?: string,
) {
  return {
    id: batchId,
    type: "message_batch",
    processing_status: status,
    request_counts: {
      processing: status === "ended" ? 0 : 2,
      succeeded: status === "ended" ? 2 : 0,
      errored: 0,
      canceled: 0,
      expired: 0,
    },
    results_url: resultsUrl ?? null,
    created_at: "2024-01-01T00:00:00Z",
    expires_at: "2024-01-02T00:00:00Z",
    ended_at: status === "ended" ? "2024-01-01T00:05:00Z" : null,
  };
}

/**
 * Creates JSONL results content for succeeded requests.
 */
function makeResultsJsonl(
  results: Array<{
    customId: string;
    text: string;
    inputTokens?: number;
    outputTokens?: number;
  }>,
): string {
  return results
    .map((r) =>
      JSON.stringify({
        custom_id: r.customId,
        result: {
          type: "succeeded",
          message: {
            content: [{ type: "text", text: r.text }],
            usage: {
              input_tokens: r.inputTokens ?? 100,
              output_tokens: r.outputTokens ?? 50,
            },
          },
        },
      }),
    )
    .join("\n");
}

/**
 * Creates a JSONL result line for an errored request.
 */
function makeErrorResultJsonl(customId: string, errorMsg: string): string {
  return JSON.stringify({
    custom_id: customId,
    result: {
      type: "errored",
      error: { type: "invalid_request", message: errorMsg },
    },
  });
}

/**
 * Creates a valid ParsedTask for testing.
 */
function makeTask(id: string): ParsedTask {
  return {
    id,
    title: `Test task ${id}`,
    priority: "P2-MEDIUM",
    effort: "1-2 hours",
    status: "BACKLOG",
    supersededBy: [],
    supersedes: [],
    relevanceReview: "",
    blockedBy: [],
    blocks: [],
    conventions: [],
    tags: [],
    problemStatement: "Test problem",
    currentState: "Test state",
    recommendedApproach: "Test approach",
    filesToModify: [],
    successCriteria: ["Tests pass"],
    testingRequirements: ["Unit tests"],
    contextReferences: [],
    rawContent: `# ${id}: Test task\n\nTest content for ${id}`,
  };
}

// ─── SDK message type for mock queries ──────────────────────────────

interface MockSDKMessage {
  type: string;
  subtype?: string;
  result?: string;
  [key: string]: unknown;
}

type MockQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncGenerator<MockSDKMessage, void>;

/**
 * Wraps a sync generator as an async generator.
 */
function wrapSyncAsAsync(
  syncGen: Generator<MockSDKMessage, void>,
): AsyncGenerator<MockSDKMessage, void> {
  return {
    next: () => Promise.resolve(syncGen.next()),
    return: (value: void) => Promise.resolve(syncGen.return(value)),
    throw: (e: unknown) => Promise.resolve(syncGen.throw(e)),
    [Symbol.asyncIterator]() {
      return this;
    },
  };
}

// ─── BatchClient Tests ──────────────────────────────────────────────

describe("BatchClient", () => {
  const TEST_API_KEY = "test-api-key-123";

  describe("constructor", () => {
    test("should use default config values", () => {
      const client = new BatchClient(TEST_API_KEY);
      expect(client).toBeDefined();
    });

    test("should accept partial config overrides", () => {
      const client = new BatchClient(TEST_API_KEY, {
        pollIntervalMs: 1000,
        timeoutMs: 60000,
      });
      expect(client).toBeDefined();
    });
  });

  describe("submitBatch", () => {
    test("should send correct API request format", async () => {
      const client = new BatchClient(TEST_API_KEY);
      const calls: Array<{ url: string; init: RequestInit }> = [];

      const mockFetch: MockFetchFn = (input, init) => {
        calls.push({ url: inputToString(input), init: init! });
        return Promise.resolve(mockResponse(makeBatchCreationResponse("batch_123")));
      };
      client._setFetchFn(mockFetch as typeof fetch);

      const requests: BatchRequest[] = [
        {
          id: "req-1",
          model: "claude-sonnet-4-6",
          systemPrompt: "You are a helpful assistant.",
          userMessage: "Hello world",
          maxTokens: 1024,
        },
        {
          id: "req-2",
          model: "claude-sonnet-4-6",
          systemPrompt: "You are a helpful assistant.",
          userMessage: "Goodbye world",
          maxTokens: 1024,
        },
      ];

      const batchId = await client.submitBatch(requests);

      expect(batchId).toBe("batch_123");
      expect(calls).toHaveLength(1);

      const call = calls[0];
      expect(call.url).toBe("https://api.anthropic.com/v1/messages/batches");
      expect(call.init.method).toBe("POST");

      const headers = call.init.headers as Record<string, string>;
      expect(headers["X-Api-Key"]).toBe(TEST_API_KEY);
      expect(headers["anthropic-version"]).toBe("2023-06-01");
      expect(headers["Content-Type"]).toBe("application/json");

      const body = JSON.parse(call.init.body as string) as {
        requests: Array<{
          custom_id: string;
          params: {
            model: string;
            max_tokens: number;
            system: string;
            messages: Array<{ role: string; content: string }>;
          };
        }>;
      };
      expect(body.requests).toHaveLength(2);
      expect(body.requests[0].custom_id).toBe("req-1");
      expect(body.requests[0].params.model).toBe("claude-sonnet-4-6");
      expect(body.requests[0].params.max_tokens).toBe(1024);
      expect(body.requests[0].params.system).toBe("You are a helpful assistant.");
      expect(body.requests[0].params.messages).toEqual([{ role: "user", content: "Hello world" }]);
    });

    test("should throw on empty batch", async () => {
      const client = new BatchClient(TEST_API_KEY);
      await expect(client.submitBatch([])).rejects.toThrow("Cannot submit an empty batch");
    });

    test("should throw on API error response", async () => {
      const client = new BatchClient(TEST_API_KEY);
      const mockFetch: MockFetchFn = () => {
        return Promise.resolve(mockResponse("Rate limit exceeded", 429, false));
      };
      client._setFetchFn(mockFetch as typeof fetch);

      await expect(
        client.submitBatch([
          {
            id: "req-1",
            model: "claude-sonnet-4-6",
            systemPrompt: "test",
            userMessage: "test",
            maxTokens: 1024,
          },
        ]),
      ).rejects.toThrow("Batch API submission failed (429)");
    });
  });

  describe("pollBatch", () => {
    test("should return in_progress status when batch is still processing", async () => {
      const client = new BatchClient(TEST_API_KEY);
      const mockFetch: MockFetchFn = () => {
        return Promise.resolve(mockResponse(makeBatchStatusResponse("batch_123", "in_progress")));
      };
      client._setFetchFn(mockFetch as typeof fetch);

      const result = await client.pollBatch("batch_123");
      expect(result.status).toBe("in_progress");
      expect(result.results).toBeUndefined();
    });

    test("should return results when batch is complete", async () => {
      const client = new BatchClient(TEST_API_KEY);
      let callCount = 0;

      const mockFetch: MockFetchFn = (input) => {
        callCount++;
        const url = inputToString(input);

        if (url.includes("/results")) {
          return Promise.resolve(
            mockResponse(
              makeResultsJsonl([
                { customId: "req-1", text: "Response 1" },
                { customId: "req-2", text: "Response 2" },
              ]),
            ),
          );
        }

        return Promise.resolve(
          mockResponse(
            makeBatchStatusResponse(
              "batch_123",
              "ended",
              "https://api.anthropic.com/v1/messages/batches/batch_123/results",
            ),
          ),
        );
      };
      client._setFetchFn(mockFetch as typeof fetch);

      const result = await client.pollBatch("batch_123");
      expect(result.status).toBe("ended");
      expect(result.results).toHaveLength(2);
      expect(result.results![0].id).toBe("req-1");
      expect(result.results![0].status).toBe("success");
      expect(result.results![0].response).toBe("Response 1");
      expect(result.results![1].id).toBe("req-2");
      expect(callCount).toBe(2); // status + results
    });

    test("should return empty results when ended with no results_url", async () => {
      const client = new BatchClient(TEST_API_KEY);
      const mockFetch: MockFetchFn = () => {
        return Promise.resolve(mockResponse(makeBatchStatusResponse("batch_123", "ended")));
      };
      client._setFetchFn(mockFetch as typeof fetch);

      const result = await client.pollBatch("batch_123");
      expect(result.status).toBe("ended");
      expect(result.results).toEqual([]);
    });

    test("should handle errored results in JSONL", async () => {
      const client = new BatchClient(TEST_API_KEY);
      const mockFetch: MockFetchFn = (input) => {
        const url = inputToString(input);
        if (url.includes("/results")) {
          const jsonl = [
            makeResultsJsonl([{ customId: "req-1", text: "OK" }]),
            makeErrorResultJsonl("req-2", "Invalid model"),
          ].join("\n");
          return Promise.resolve(mockResponse(jsonl));
        }
        return Promise.resolve(
          mockResponse(
            makeBatchStatusResponse(
              "batch_123",
              "ended",
              "https://api.anthropic.com/v1/messages/batches/batch_123/results",
            ),
          ),
        );
      };
      client._setFetchFn(mockFetch as typeof fetch);

      const result = await client.pollBatch("batch_123");
      expect(result.results).toHaveLength(2);
      expect(result.results![0].status).toBe("success");
      expect(result.results![1].status).toBe("error");
      expect(result.results![1].error).toBe("Invalid model");
      expect(result.results![1].costUsd).toBe(0);
    });

    test("should throw on poll API error", async () => {
      const client = new BatchClient(TEST_API_KEY);
      const mockFetch: MockFetchFn = () => {
        return Promise.resolve(mockResponse("Not found", 404, false));
      };
      client._setFetchFn(mockFetch as typeof fetch);

      await expect(client.pollBatch("batch_999")).rejects.toThrow("Batch API poll failed (404)");
    });
  });

  describe("submitAndWait", () => {
    test("should poll until complete and return results", async () => {
      const client = new BatchClient(TEST_API_KEY, {
        timeoutMs: 10000,
        pollIntervalMs: 10,
      });

      let pollCount = 0;

      const mockFetch: MockFetchFn = (input, init) => {
        const url = inputToString(input);
        const method = init?.method ?? "GET";

        if (method === "POST") {
          return Promise.resolve(mockResponse(makeBatchCreationResponse("batch_456")));
        }

        if (url.includes("/results")) {
          return Promise.resolve(
            mockResponse(makeResultsJsonl([{ customId: "req-1", text: "Result 1" }])),
          );
        }

        pollCount++;
        if (pollCount < 3) {
          return Promise.resolve(mockResponse(makeBatchStatusResponse("batch_456", "in_progress")));
        }
        return Promise.resolve(
          mockResponse(
            makeBatchStatusResponse(
              "batch_456",
              "ended",
              "https://api.anthropic.com/v1/messages/batches/batch_456/results",
            ),
          ),
        );
      };
      client._setFetchFn(mockFetch as typeof fetch);

      const results = await client.submitAndWait([
        {
          id: "req-1",
          model: "claude-sonnet-4-6",
          systemPrompt: "test",
          userMessage: "test",
          maxTokens: 1024,
        },
      ]);

      expect(results).toHaveLength(1);
      expect(results[0].id).toBe("req-1");
      expect(results[0].response).toBe("Result 1");
      expect(pollCount).toBeGreaterThanOrEqual(3);
    });

    test("should throw on timeout", async () => {
      const client = new BatchClient(TEST_API_KEY, {
        timeoutMs: 50,
        pollIntervalMs: 10,
      });

      const mockFetch: MockFetchFn = (_input, init) => {
        if (init?.method === "POST") {
          return Promise.resolve(mockResponse(makeBatchCreationResponse("batch_timeout")));
        }
        return Promise.resolve(
          mockResponse(makeBatchStatusResponse("batch_timeout", "in_progress")),
        );
      };
      client._setFetchFn(mockFetch as typeof fetch);

      await expect(
        client.submitAndWait([
          {
            id: "req-1",
            model: "claude-sonnet-4-6",
            systemPrompt: "test",
            userMessage: "test",
            maxTokens: 1024,
          },
        ]),
      ).rejects.toThrow("timed out");
    });

    test("should respect custom poll interval", async () => {
      const client = new BatchClient(TEST_API_KEY, {
        timeoutMs: 5000,
        pollIntervalMs: 100,
      });

      let pollCount = 0;
      const mockFetch: MockFetchFn = (input, init) => {
        if (init?.method === "POST") {
          return Promise.resolve(mockResponse(makeBatchCreationResponse("batch_poll")));
        }
        const url = inputToString(input);
        if (url.includes("/results")) {
          return Promise.resolve(
            mockResponse(makeResultsJsonl([{ customId: "req-1", text: "OK" }])),
          );
        }
        pollCount++;
        if (pollCount >= 2) {
          return Promise.resolve(
            mockResponse(
              makeBatchStatusResponse(
                "batch_poll",
                "ended",
                "https://api.anthropic.com/v1/messages/batches/batch_poll/results",
              ),
            ),
          );
        }
        return Promise.resolve(mockResponse(makeBatchStatusResponse("batch_poll", "in_progress")));
      };
      client._setFetchFn(mockFetch as typeof fetch);

      const results = await client.submitAndWait(
        [
          {
            id: "req-1",
            model: "claude-sonnet-4-6",
            systemPrompt: "test",
            userMessage: "test",
            maxTokens: 1024,
          },
        ],
        5,
      );

      expect(results).toHaveLength(1);
    });
  });

  describe("cost estimation", () => {
    test("should estimate cost based on model and token usage", async () => {
      const client = new BatchClient(TEST_API_KEY);
      const mockFetch: MockFetchFn = (input) => {
        const url = inputToString(input);
        if (url.includes("/results")) {
          return Promise.resolve(
            mockResponse(
              makeResultsJsonl([
                {
                  customId: "req-1",
                  text: "Result",
                  inputTokens: 1000,
                  outputTokens: 500,
                },
              ]),
            ),
          );
        }
        return Promise.resolve(
          mockResponse(
            makeBatchStatusResponse(
              "batch_cost",
              "ended",
              "https://api.anthropic.com/v1/messages/batches/batch_cost/results",
            ),
          ),
        );
      };
      client._setFetchFn(mockFetch as typeof fetch);

      const result = await client.pollBatch("batch_cost");
      expect(result.results).toHaveLength(1);
      expect(result.results![0].costUsd).toBeGreaterThan(0);
    });
  });

  describe("partial failures", () => {
    test("should handle mix of success and error results", async () => {
      const client = new BatchClient(TEST_API_KEY);
      const mockFetch: MockFetchFn = (input) => {
        const url = inputToString(input);
        if (url.includes("/results")) {
          const jsonl = [
            JSON.stringify({
              custom_id: "req-1",
              result: {
                type: "succeeded",
                message: {
                  content: [{ type: "text", text: "Success" }],
                  usage: { input_tokens: 100, output_tokens: 50 },
                },
              },
            }),
            JSON.stringify({
              custom_id: "req-2",
              result: { type: "expired" },
            }),
            JSON.stringify({
              custom_id: "req-3",
              result: { type: "canceled" },
            }),
          ].join("\n");
          return Promise.resolve(mockResponse(jsonl));
        }
        return Promise.resolve(
          mockResponse(
            makeBatchStatusResponse(
              "batch_partial",
              "ended",
              "https://api.anthropic.com/v1/messages/batches/batch_partial/results",
            ),
          ),
        );
      };
      client._setFetchFn(mockFetch as typeof fetch);

      const result = await client.pollBatch("batch_partial");
      expect(result.results).toHaveLength(3);
      expect(result.results![0].status).toBe("success");
      expect(result.results![1].status).toBe("error");
      expect(result.results![1].error).toContain("expired");
      expect(result.results![2].status).toBe("error");
      expect(result.results![2].error).toContain("canceled");
    });
  });
});

// ─── DEFAULT_BATCH_CONFIG Tests ──────────────────────────────────────

describe("DEFAULT_BATCH_CONFIG", () => {
  test("should have batch disabled by default", () => {
    expect(DEFAULT_BATCH_CONFIG.enabled).toBe(false);
  });

  test("should have sensible defaults", () => {
    expect(DEFAULT_BATCH_CONFIG.minBatchSize).toBe(2);
    expect(DEFAULT_BATCH_CONFIG.maxWaitSeconds).toBe(30);
    expect(DEFAULT_BATCH_CONFIG.pollIntervalMs).toBe(5000);
    expect(DEFAULT_BATCH_CONFIG.timeoutMs).toBe(300000);
  });
});

// ─── batchEvaluateTaskDepth Tests ────────────────────────────────────

describe("batchEvaluateTaskDepth", () => {
  afterEach(() => {
    _setQueryFn(undefined);
  });

  /**
   * Creates a mock query function for sequential fallback testing.
   */
  function createMockQueryForSequential(): {
    fn: MockQueryFn;
    calls: Array<{ prompt: string }>;
  } {
    const calls: Array<{ prompt: string }> = [];

    function* makeGen(): Generator<MockSDKMessage, void> {
      yield {
        type: "result",
        subtype: "success",
        result: JSON.stringify({
          ready: true,
          overall_score: 4.8,
          scores: { clarity: 5, scope: 5, testability: 5, conventions: 5 },
          deficiencies: [],
          enrichment_suggestions: [],
        }),
      };
    }

    const fn: MockQueryFn = function (params) {
      calls.push({ prompt: params.prompt });
      return wrapSyncAsAsync(makeGen());
    };

    return { fn, calls };
  }

  test("should fall back to sequential when batch is disabled", async () => {
    const { fn, calls } = createMockQueryForSequential();
    _setQueryFn(fn);

    const tasks = [
      { task: makeTask("TASK-001"), conventionsSummary: "conventions" },
      { task: makeTask("TASK-002"), conventionsSummary: "conventions" },
      { task: makeTask("TASK-003"), conventionsSummary: "conventions" },
    ];

    const config: TypesBatchConfig = {
      enabled: false,
      minBatchSize: 2,
      maxWaitSeconds: 30,
      pollIntervalMs: 5000,
      timeoutMs: 300000,
    };

    const results = await batchEvaluateTaskDepth(tasks, undefined, config);

    expect(results.size).toBe(3);
    expect(results.get("TASK-001")?.ready).toBe(true);
    expect(results.get("TASK-002")?.ready).toBe(true);
    expect(results.get("TASK-003")?.ready).toBe(true);
    expect(calls).toHaveLength(3);
  });

  test("should fall back to sequential when tasks < minBatchSize", async () => {
    const { fn, calls } = createMockQueryForSequential();
    _setQueryFn(fn);

    const tasks = [{ task: makeTask("TASK-001"), conventionsSummary: "conventions" }];

    const config: TypesBatchConfig = {
      enabled: true,
      minBatchSize: 2,
      maxWaitSeconds: 30,
      pollIntervalMs: 5000,
      timeoutMs: 300000,
    };

    const results = await batchEvaluateTaskDepth(tasks, undefined, config);

    expect(results.size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("should fall back to sequential when no batchConfig provided", async () => {
    const { fn, calls } = createMockQueryForSequential();
    _setQueryFn(fn);

    const tasks = [
      { task: makeTask("TASK-001"), conventionsSummary: "conventions" },
      { task: makeTask("TASK-002"), conventionsSummary: "conventions" },
    ];

    const results = await batchEvaluateTaskDepth(tasks);

    expect(results.size).toBe(2);
    expect(calls).toHaveLength(2);
  });

  test("should handle empty tasks array", async () => {
    const results = await batchEvaluateTaskDepth([]);
    expect(results.size).toBe(0);
  });
});

// ─── batchJudge Tests ────────────────────────────────────────────────

describe("batchJudge", () => {
  afterEach(() => {
    _setJudgeQueryFn(undefined);
  });

  /**
   * Creates a minimal mock adapter for testing.
   */
  function makeMockAdapter(): ProjectAdapter {
    return {
      config: {
        version: "1.0",
        project: {
          name: "test",
          root: "/test",
          taskDir: "docs/tasks",
          conventionsDir: "docs/conventions",
        },
        agent: {
          model: "claude-sonnet-4-6",
          judgeModel: "claude-sonnet-4-6",
          enrichModel: "claude-sonnet-4-6",
          maxTurns: 50,
          maxBudgetPerTask: 5.0,
          maxRetries: 1,
        },
        verification: {
          commands: [{ name: "test", command: "npm test", required: true, timeout: 60000 }],
          conventionChecks: [],
        },
        sandbox: {
          writablePaths: ["src/"],
          deniedPaths: [".env"],
          allowedBashPatterns: [],
          deniedBashPatterns: [],
        },
        git: {
          baseBranch: "main",
          branchPrefix: "quack/",
          commitFormat: "[{taskId}] {message}",
          commitTrailer: "",
          autoCreatePr: true,
          autoPush: true,
        },
        logging: {
          dir: ".quack/logs",
          level: "debug" as const,
          retainDays: 30,
        },
      },
      projectRoot: "/test",
      judgeCriteria: "",
      conventions: {},
    } as unknown as ProjectAdapter;
  }

  function makeJudgeInput(taskId: string): JudgeInput {
    return {
      taskSpec: `# ${taskId}: Test task\n\nTest content`,
      gitDiff: `diff --git a/test.ts b/test.ts\n+new line`,
      verificationResults: {
        allPassed: true,
        commands: [{ name: "test", passed: true, output: "OK" }],
        conventionChecks: [],
      },
      task: makeTask(taskId),
      changedFiles: ["test.ts"],
    };
  }

  /**
   * Creates a mock query function that returns a judge verdict.
   */
  function createJudgeMockQuery(): {
    fn: MockQueryFn;
    calls: number[];
  } {
    const calls: number[] = [];

    function* makeGen(): Generator<MockSDKMessage, void> {
      yield {
        type: "result",
        subtype: "success",
        result: JSON.stringify({
          verdict: "APPROVE",
          confidence: 0.9,
          scope_violations: [],
          criteria_gaps: [],
          quality_issues: [],
          feedback: "All good",
        }),
      };
    }

    const fn: MockQueryFn = function (_params) {
      calls.push(1);
      return wrapSyncAsAsync(makeGen());
    };

    return { fn, calls };
  }

  test("should fall back to sequential when batch is disabled", async () => {
    const { fn, calls } = createJudgeMockQuery();
    _setJudgeQueryFn(fn);

    const adapter = makeMockAdapter();
    const inputs = [makeJudgeInput("TASK-001"), makeJudgeInput("TASK-002")];

    const config: TypesBatchConfig = {
      enabled: false,
      minBatchSize: 2,
      maxWaitSeconds: 30,
      pollIntervalMs: 5000,
      timeoutMs: 300000,
    };

    const results = await batchJudge(inputs, adapter, undefined, config);

    expect(results.size).toBe(2);
    expect(results.get("TASK-001")?.verdict).toBe("APPROVE");
    expect(results.get("TASK-002")?.verdict).toBe("APPROVE");
    expect(calls).toHaveLength(2);
  });

  test("should fall back when inputs < minBatchSize", async () => {
    const { fn, calls } = createJudgeMockQuery();
    _setJudgeQueryFn(fn);

    const adapter = makeMockAdapter();
    const inputs = [makeJudgeInput("TASK-001")];

    const config: TypesBatchConfig = {
      enabled: true,
      minBatchSize: 3,
      maxWaitSeconds: 30,
      pollIntervalMs: 5000,
      timeoutMs: 300000,
    };

    const results = await batchJudge(inputs, adapter, undefined, config);

    expect(results.size).toBe(1);
    expect(calls).toHaveLength(1);
  });

  test("should use task ID as key when available", async () => {
    const { fn } = createJudgeMockQuery();
    _setJudgeQueryFn(fn);

    const adapter = makeMockAdapter();
    const inputs = [makeJudgeInput("TASK-042")];

    const results = await batchJudge(inputs, adapter);

    expect(results.has("TASK-042")).toBe(true);
  });

  test("should handle empty inputs array", async () => {
    const adapter = makeMockAdapter();
    const results = await batchJudge([], adapter);
    expect(results.size).toBe(0);
  });
});

// ─── Adapter Schema BatchConfig Tests ─────────────────────────────────

describe("BatchConfigSchema", () => {
  test("should parse valid batch config", () => {
    const result = BatchConfigSchema.parse({
      enabled: true,
      minBatchSize: 3,
      maxWaitSeconds: 60,
      pollIntervalMs: 10000,
      timeoutMs: 600000,
    });

    expect(result.enabled).toBe(true);
    expect(result.minBatchSize).toBe(3);
  });

  test("should apply defaults for missing fields", () => {
    const result = BatchConfigSchema.parse({});

    expect(result.enabled).toBe(false);
    expect(result.minBatchSize).toBe(2);
    expect(result.maxWaitSeconds).toBe(30);
    expect(result.pollIntervalMs).toBe(5000);
    expect(result.timeoutMs).toBe(300000);
  });

  test("should reject invalid minBatchSize", () => {
    expect(() =>
      BatchConfigSchema.parse({
        enabled: true,
        minBatchSize: 0,
      }),
    ).toThrow();
  });

  test("should reject negative timeoutMs", () => {
    expect(() =>
      BatchConfigSchema.parse({
        enabled: true,
        timeoutMs: -1,
      }),
    ).toThrow();
  });
});

// ─── AdapterConfig with batchConfig Tests ────────────────────────────

describe("AdapterConfigSchema with batchConfig", () => {
  test("should accept adapter config with batchConfig", () => {
    const config = {
      version: "1.0",
      project: {
        name: "test",
        root: ".",
        taskDir: "docs/tasks",
        conventionsDir: "docs/conventions",
      },
      verification: {
        commands: [{ name: "test", command: "npm test", required: true, timeout: 60000 }],
      },
      git: {
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "",
      },
      logging: {
        dir: ".quack/logs",
      },
      batchConfig: {
        enabled: true,
        minBatchSize: 3,
      },
    };

    const result = AdapterConfigSchema.parse(config) as {
      batchConfig?: { enabled: boolean; minBatchSize: number };
    };
    expect(result.batchConfig?.enabled).toBe(true);
    expect(result.batchConfig?.minBatchSize).toBe(3);
  });

  test("should accept adapter config without batchConfig", () => {
    const config = {
      version: "1.0",
      project: {
        name: "test",
        root: ".",
        taskDir: "docs/tasks",
        conventionsDir: "docs/conventions",
      },
      verification: {
        commands: [{ name: "test", command: "npm test", required: true, timeout: 60000 }],
      },
      git: {
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "",
      },
      logging: {
        dir: ".quack/logs",
      },
    };

    const result = AdapterConfigSchema.parse(config) as { batchConfig?: unknown };
    expect(result.batchConfig).toBeUndefined();
  });
});
