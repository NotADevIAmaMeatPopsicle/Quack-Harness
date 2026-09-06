// ─── Verify Before Stop Hook ────────────────────────────────────────
// Stop hook that runs the project's verification suite before the
// agent is allowed to finish. If any required verification command
// fails, the hook returns feedback to the agent so it can fix issues.
//
// This implements the architecture principle: "the agent cannot finish
// without passing verification."

import type { ProjectAdapter } from "../core/adapter-loader.js";
import type { ParsedTask, VerificationResult } from "../core/types.js";
import { runVerification, formatVerificationResult } from "../worker/tools/verify.js";

/**
 * Result of the stop hook check.
 */
export interface StopHookResult {
  /** Whether the agent is allowed to stop */
  canStop: boolean;
  /** Human-readable feedback for the agent if it cannot stop */
  feedback: string;
  /** The full verification result */
  verification: VerificationResult;
}

/**
 * Run the verification suite and determine whether the agent can stop.
 *
 * If verification passes, canStop is true.
 * If verification fails, canStop is false and feedback contains
 * the formatted failure details for the agent to act on.
 *
 * @param adapter - The project adapter with verification config
 * @returns StopHookResult indicating whether the agent can stop
 */
export async function verifyBeforeStop(
  adapter: ProjectAdapter,
  options?: {
    task?: ParsedTask;
    /** Round-2 F8: sink for machinery-integrity mismatches — the worker
     * wires this to `safety_fact` (origin `verification_integrity`). */
    onIntegrityMismatch?: (mismatches: Array<{ path: string; reason: string }>) => void;
  },
): Promise<StopHookResult> {
  let verification: VerificationResult;

  try {
    verification = await runVerification(adapter, "all", {
      task: options?.task,
      onIntegrityMismatch: options?.onIntegrityMismatch,
    });
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      canStop: false,
      feedback: `Verification could not run: ${message}\n\nPlease fix the issue and try again.`,
      verification: {
        allPassed: false,
        commands: [
          {
            name: "verification-error",
            passed: false,
            output: message,
          },
        ],
        conventionChecks: [],
      },
    };
  }

  if (verification.allPassed) {
    return {
      canStop: true,
      feedback: formatVerificationResult(verification),
      verification,
    };
  }

  // Build feedback for the agent
  const formatted = formatVerificationResult(verification);
  const feedback = [
    "STOP BLOCKED: Verification failed. You must fix the following issues before finishing.",
    "",
    formatted,
    "",
    "Fix all failing checks, then call `verify` again to confirm.",
  ].join("\n");

  return {
    canStop: false,
    feedback,
    verification,
  };
}
