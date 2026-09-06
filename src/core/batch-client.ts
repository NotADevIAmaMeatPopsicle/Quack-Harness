// ─── Batch Client ───────────────────────────────────────────────────
// Wraps the Anthropic Message Batches API for asynchronous batch
// processing at 50% cost discount. Used for non-latency-sensitive
// operations like gate depth evaluation and judge evaluation.

/** A single request within a batch submission. */
export interface BatchRequest {
  /** Developer-provided unique ID for matching results */
  id: string;
  /** Model to use for this request */
  model: string;
  /** System prompt content */
  systemPrompt: string;
  /** User message content */
  userMessage: string;
  /** Maximum tokens to generate */
  maxTokens: number;
  /** JSON schema for structured output (optional) */
  outputFormat?: Record<string, unknown>;
}

/** Result for a single request within a completed batch. */
export interface BatchResult {
  /** The custom_id from the original request */
  id: string;
  /** Parsed response content (text or structured JSON) */
  response: unknown;
  /** Whether this individual request succeeded or failed */
  status: "success" | "error";
  /** Estimated cost in USD (based on token usage) */
  costUsd: number;
  /** Error message if status is "error" */
  error?: string;
}

/** Configuration for batch processing behavior. */
export interface BatchConfig {
  /** Whether batch processing is enabled */
  enabled: boolean;
  /** Minimum items to batch (below this, fall back to sequential) */
  minBatchSize: number;
  /** Maximum seconds to wait before sending a partial batch */
  maxWaitSeconds: number;
  /** Polling interval in ms when waiting for batch completion */
  pollIntervalMs: number;
  /** Maximum ms to wait for batch completion before timing out */
  timeoutMs: number;
}

/** Default batch configuration values. */
export const DEFAULT_BATCH_CONFIG: BatchConfig = {
  enabled: false,
  minBatchSize: 2,
  maxWaitSeconds: 30,
  pollIntervalMs: 5000,
  timeoutMs: 300000,
};

// ─── API response types ──────────────────────────────────────────────

/** Shape of the batch creation response from Anthropic API. */
interface ApiBatchResponse {
  id: string;
  type: "message_batch";
  processing_status: "in_progress" | "canceling" | "ended";
  request_counts: {
    processing: number;
    succeeded: number;
    errored: number;
    canceled: number;
    expired: number;
  };
  results_url: string | null;
  created_at: string;
  expires_at: string;
  ended_at: string | null;
}

/** Shape of a single result item in the JSONL results file. */
interface ApiResultItem {
  custom_id: string;
  result: {
    type: "succeeded" | "errored" | "canceled" | "expired";
    message?: {
      content: Array<{ type: string; text?: string }>;
      usage?: {
        input_tokens: number;
        output_tokens: number;
      };
    };
    error?: {
      type: string;
      message: string;
    };
  };
}

// ─── Cost estimation (per-million-token pricing) ──────────────────────

/** Batch API pricing is 50% of standard rates. */
const BATCH_INPUT_COST_PER_MTOK: Record<string, number> = {
  "claude-opus-4-6": 2.5,
  "claude-sonnet-4-6": 1.5,
  "claude-haiku-4-5-20251001": 0.5,
};

const BATCH_OUTPUT_COST_PER_MTOK: Record<string, number> = {
  "claude-opus-4-6": 12.5,
  "claude-sonnet-4-6": 7.5,
  "claude-haiku-4-5-20251001": 2.5,
};

function estimateCost(model: string, inputTokens: number, outputTokens: number): number {
  const inputRate = BATCH_INPUT_COST_PER_MTOK[model] ?? 1.5;
  const outputRate = BATCH_OUTPUT_COST_PER_MTOK[model] ?? 7.5;
  return (inputTokens * inputRate + outputTokens * outputRate) / 1_000_000;
}

// ─── BatchClient class ──────────────────────────────────────────────

const API_BASE = "https://api.anthropic.com/v1/messages/batches";
const API_VERSION = "2023-06-01";

/**
 * Client for the Anthropic Message Batches API.
 *
 * Submits batches of message requests for asynchronous processing
 * at 50% cost discount. Handles submission, polling, and result
 * retrieval.
 */
export class BatchClient {
  private readonly apiKey: string;
  private readonly config: BatchConfig;

  /**
   * Function used for HTTP requests. Defaults to global fetch.
   * Can be overridden for testing via _setFetchFn().
   */
  private fetchFn: typeof fetch;

  constructor(apiKey: string, config?: Partial<BatchConfig>) {
    this.apiKey = apiKey;
    this.config = { ...DEFAULT_BATCH_CONFIG, ...config };
    this.fetchFn = globalThis.fetch.bind(globalThis);
  }

  /**
   * Override the fetch function used for HTTP requests.
   * Primarily for testing — avoids making real API calls.
   */
  _setFetchFn(fn: typeof fetch): void {
    this.fetchFn = fn;
  }

  /**
   * Submit a batch of requests for asynchronous processing.
   *
   * @param requests - Array of batch requests to submit
   * @returns The batch ID for tracking
   * @throws Error if the API request fails
   */
  async submitBatch(requests: BatchRequest[]): Promise<string> {
    if (requests.length === 0) {
      throw new Error("Cannot submit an empty batch");
    }

    const apiRequests = requests.map((req) => ({
      custom_id: req.id,
      params: {
        model: req.model,
        max_tokens: req.maxTokens,
        system: req.systemPrompt,
        messages: [{ role: "user" as const, content: req.userMessage }],
      },
    }));

    const response = await this.fetchFn(API_BASE, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "X-Api-Key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
      body: JSON.stringify({ requests: apiRequests }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Batch API submission failed (${response.status}): ${errorBody}`);
    }

    const batchResponse = (await response.json()) as ApiBatchResponse;
    return batchResponse.id;
  }

  /**
   * Poll the status of a submitted batch.
   *
   * @param batchId - The batch ID returned from submitBatch
   * @returns Current status and results (if complete)
   */
  async pollBatch(batchId: string): Promise<{ status: string; results?: BatchResult[] }> {
    const response = await this.fetchFn(`${API_BASE}/${batchId}`, {
      method: "GET",
      headers: {
        "X-Api-Key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Batch API poll failed (${response.status}): ${errorBody}`);
    }

    const batchStatus = (await response.json()) as ApiBatchResponse;

    if (batchStatus.processing_status !== "ended") {
      return { status: batchStatus.processing_status };
    }

    // Batch is complete — fetch results
    if (!batchStatus.results_url) {
      return {
        status: "ended",
        results: [],
      };
    }

    const results = await this.fetchResults(batchStatus.results_url, "");
    return { status: "ended", results };
  }

  /**
   * Submit a batch and wait for all results, polling at the configured interval.
   *
   * @param requests - Array of batch requests to submit
   * @param pollIntervalMs - Override polling interval (defaults to config)
   * @returns Array of batch results for all requests
   * @throws Error if the batch times out or fails
   */
  async submitAndWait(requests: BatchRequest[], pollIntervalMs?: number): Promise<BatchResult[]> {
    const batchId = await this.submitBatch(requests);
    const interval = pollIntervalMs ?? this.config.pollIntervalMs;
    const deadline = Date.now() + this.config.timeoutMs;

    while (Date.now() < deadline) {
      const { status, results } = await this.pollBatch(batchId);

      if (status === "ended" && results) {
        return results;
      }

      if (Date.now() + interval > deadline) {
        throw new Error(`Batch ${batchId} timed out after ${this.config.timeoutMs}ms`);
      }

      await this.sleep(interval);
    }

    throw new Error(`Batch ${batchId} timed out after ${this.config.timeoutMs}ms`);
  }

  /**
   * Fetch and parse the JSONL results from the results URL.
   */
  private async fetchResults(resultsUrl: string, defaultModel: string): Promise<BatchResult[]> {
    const response = await this.fetchFn(resultsUrl, {
      method: "GET",
      headers: {
        "X-Api-Key": this.apiKey,
        "anthropic-version": API_VERSION,
      },
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Failed to fetch batch results (${response.status}): ${errorBody}`);
    }

    const body = await response.text();
    const lines = body.split("\n").filter((line) => line.trim().length > 0);

    return lines.map((line) => {
      const item = JSON.parse(line) as ApiResultItem;
      return this.parseResultItem(item, defaultModel);
    });
  }

  /**
   * Parse a single JSONL result item into a BatchResult.
   */
  private parseResultItem(item: ApiResultItem, defaultModel: string): BatchResult {
    if (item.result.type === "succeeded" && item.result.message) {
      const textBlocks = item.result.message.content
        .filter((block) => block.type === "text" && block.text)
        .map((block) => block.text!);

      const responseText = textBlocks.join("");
      const usage = item.result.message.usage;
      const costUsd = usage
        ? estimateCost(defaultModel, usage.input_tokens, usage.output_tokens)
        : 0;

      return {
        id: item.custom_id,
        response: responseText,
        status: "success",
        costUsd,
      };
    }

    // Error, canceled, or expired
    const errorMsg = item.result.error?.message ?? `Request ${item.result.type}: ${item.custom_id}`;

    return {
      id: item.custom_id,
      response: null,
      status: "error",
      costUsd: 0,
      error: errorMsg,
    };
  }

  /**
   * Sleep for the specified number of milliseconds.
   */
  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
