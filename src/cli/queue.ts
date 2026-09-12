// ─── CLI: quack queue ──────────────────────────────────────────────
// Queue management commands: enqueue, start, pause, resume, status.
// Interacts with the monitor API if running, otherwise prints instructions.

import * as http from "node:http";

interface QueueCommandOptions {
  project?: string;
  port?: string;
  start?: boolean;
  pause?: boolean;
  resume?: boolean;
  stop?: boolean;
  abort?: boolean;
  status?: boolean;
  all?: boolean;
  maxConcurrent?: string;
}

/**
 * Make an HTTP request to the monitor API.
 */
function apiRequest(
  port: number,
  method: string,
  path: string,
  body?: Record<string, unknown>,
): Promise<unknown> {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : undefined;

    const options: http.RequestOptions = {
      hostname: "localhost",
      port,
      path,
      method,
      headers: data
        ? {
            "Content-Type": "application/json",
            "Content-Length": Buffer.byteLength(data),
          }
        : {},
    };

    const req = http.request(options, (res) => {
      let responseData = "";

      res.on("data", (chunk) => {
        responseData += chunk;
      });

      res.on("end", () => {
        try {
          const parsed = JSON.parse(responseData) as Record<string, unknown>;
          if (res.statusCode && res.statusCode >= 200 && res.statusCode < 300) {
            resolve(parsed);
          } else {
            const errorMsg =
              typeof parsed.error === "string" ? parsed.error : `HTTP ${res.statusCode}`;
            reject(new Error(errorMsg));
          }
        } catch {
          reject(new Error(`Failed to parse response: ${responseData}`));
        }
      });
    });

    req.on("error", (err) => {
      reject(err);
    });

    if (data) {
      req.write(data);
    }

    req.end();
  });
}

export async function queueCommand(taskIds: string[], options: QueueCommandOptions): Promise<void> {
  const port = parseInt(options.port ?? "3333", 10);

  try {
    // Health check first
    await apiRequest(port, "GET", "/api/health");
  } catch {
    console.error(`Error: Monitor is not running on port ${port}.`);
    console.error(`Start the monitor with: quack monitor --port ${port}`);
    process.exit(1);
  }

  try {
    // Status check
    if (options.status) {
      const result = (await apiRequest(port, "GET", "/api/queue")) as {
        config: Record<string, unknown>;
        stats: Record<string, unknown>;
        items: Array<Record<string, unknown>>;
      };

      console.log("\nQueue Status");
      console.log("=".repeat(40));
      const awaitingApproval = Number(result.stats.awaitingApproval ?? 0);
      const activeCount = Number(result.stats.running ?? 0) + awaitingApproval;
      console.log(`State: ${activeCount > 0 ? "Running" : "Idle"}`);
      console.log(`Total items: ${String(result.stats.total)}`);
      console.log(`  Queued: ${String(result.stats.queued)}`);
      console.log(`  Ready: ${String(result.stats.ready)}`);
      console.log(`  Running: ${String(result.stats.running)}`);
      console.log(`  Awaiting approval: ${awaitingApproval}`);
      console.log(`  Completed: ${String(result.stats.completed)}`);
      console.log(`  Failed: ${String(result.stats.failed)}`);
      console.log(`  Blocked: ${String(result.stats.blocked)}`);
      console.log(`  Skipped: ${String(result.stats.skipped)}`);
      console.log(`\nTotal cost: $${Number(result.stats.totalCostUsd).toFixed(2)}`);
      console.log(`Max concurrent: ${String(result.config.maxConcurrent)}`);
      console.log(`Failure mode: ${String(result.config.failurePropagation)}`);

      if (result.items.length > 0) {
        console.log("\nQueue Items:");
        for (const item of result.items as Array<{
          taskId: string;
          status: string;
          priority: number;
          blockedBy: string[];
        }>) {
          const blocked =
            item.blockedBy.length > 0 ? ` (blocked by: ${item.blockedBy.join(", ")})` : "";
          console.log(`  ${item.taskId} [${item.status}]${blocked}`);
        }
      }

      process.exit(0);
    }

    // Lifecycle commands
    if (options.start) {
      await apiRequest(port, "POST", "/api/queue/start");
      console.log("Queue started.");
      process.exit(0);
    }

    if (options.pause) {
      await apiRequest(port, "POST", "/api/queue/pause", { reason: "CLI pause" });
      console.log("Queue paused.");
      process.exit(0);
    }

    if (options.resume) {
      await apiRequest(port, "POST", "/api/queue/resume");
      console.log("Queue resumed.");
      process.exit(0);
    }

    if (options.stop) {
      await apiRequest(port, "POST", "/api/queue/stop");
      console.log("Queue stopped (running tasks will complete).");
      process.exit(0);
    }

    if (options.abort) {
      await apiRequest(port, "POST", "/api/queue/abort");
      console.log("Queue aborted (running tasks killed).");
      process.exit(0);
    }

    // Enqueue commands
    if (options.all) {
      const result = (await apiRequest(port, "POST", "/api/queue/enqueue-all")) as {
        count: number;
      };
      console.log(`Enqueued ${result.count} eligible task(s).`);
      process.exit(0);
    }

    if (taskIds.length > 0) {
      const result = (await apiRequest(port, "POST", "/api/queue/enqueue", {
        taskIds,
      })) as { items: Array<Record<string, unknown>> };
      console.log(`Enqueued ${result.items.length} task(s).`);
      for (const item of result.items as Array<{ taskId: string }>) {
        console.log(`  ${item.taskId}`);
      }
      process.exit(0);
    }

    // Default: show usage
    console.log("Usage: quack queue [TASK-IDs...] [options]");
    console.log("\nOptions:");
    console.log("  --all           Enqueue all eligible tasks");
    console.log("  --start         Start processing the queue");
    console.log("  --pause         Pause the queue");
    console.log("  --resume        Resume from paused state");
    console.log("  --stop          Stop the queue (wait for running tasks)");
    console.log("  --abort         Abort the queue (kill running tasks)");
    console.log("  --status        Show queue status");
    console.log("  --port <n>      Monitor port (default: 3333)");
    console.log("\nExamples:");
    console.log("  quack queue TASK-031 TASK-033     # Enqueue specific tasks");
    console.log("  quack queue --all --start         # Enqueue all and start");
    console.log("  quack queue --status              # Check queue status");
    console.log("  quack queue --pause               # Pause the queue");
    process.exit(0);
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${message}`);
    process.exit(1);
  }
}
