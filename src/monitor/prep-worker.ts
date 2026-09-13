import * as path from "node:path";
import type { KeyManager } from "../dispatcher/key-manager.js";
import { parsePrepGateResult, type PrepGateResult } from "./prep-job-result.js";
import { PrepJobStore } from "./prep-job-store.js";
import {
  OwnedCommandWorker, type OwnedCommandJob, type OwnedCommandWorkerRuntime,
  type OwnedCommandShutdownOptions, type OwnedCommandShutdownResult,
  type OwnedCommandShutdownSurvivor,
} from "./owned-command-worker.js";

export type PrepJob = OwnedCommandJob<PrepGateResult>;
export type PrepWorkerRuntime = OwnedCommandWorkerRuntime;
export type PrepShutdownOptions = OwnedCommandShutdownOptions;
export type PrepShutdownResult = OwnedCommandShutdownResult;
export type PrepShutdownSurvivor = OwnedCommandShutdownSurvivor;
export interface PrepWorkerOptions {
  keyManager?: KeyManager;
  logDir?: string;
  projectId?: string;
  onTerminal?: (job: PrepJob) => void;
}

/** Existing prep API; only the process lifecycle is shared with full preflight. */
export class PrepWorker extends OwnedCommandWorker<PrepGateResult> {
  constructor(projectRoot: string, quackBin: string,
    runtime: PrepWorkerRuntime = {}, options: PrepWorkerOptions = {}) {
    super(projectRoot, quackBin, runtime, {
      label: "Prep", survivorNamespace: "prep-shutdown-survivors", outputLimit: 64 * 1024,
      // Preserve prep's established UTF-16 character bound and Unicode receipts.
      outputUnit: "characters",
      keyManager: options.keyManager,
      commandArgs: (taskId) => ["prep", taskId, "--project", projectRoot],
      parseResult: (value, _jobId, sanitize) => {
        const result = parsePrepGateResult(value);
        result.schemaErrors = result.schemaErrors.map(sanitize);
        result.deficiencies = result.deficiencies.map(sanitize);
        return result;
      },
      store: new PrepJobStore(options.logDir ?? path.join(projectRoot, ".quack", "logs"),
        options.projectId ?? path.basename(projectRoot)),
      onTerminal: options.onTerminal,
    });
  }

  start(taskId: string): PrepJob { return super.start(taskId); }
}
