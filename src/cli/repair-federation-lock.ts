import {
  repairFederatedJobLockOffline,
  type OfflineFederatedLockRecoveryResult,
} from "../monitor/federation/offline-lock-recovery.js";

export interface RepairFederationLockCommandOptions {
  project?: string;
  staleMs?: string;
  apply?: boolean;
  confirmOffline?: boolean;
  expectedFingerprint?: string;
}

function parseStaleMs(value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) {
    throw new Error("--stale-ms must be a positive integer");
  }
  return parsed;
}

function printResult(result: OfflineFederatedLockRecoveryResult): void {
  if (result.status === "eligible") {
    console.log(`Federation lock is eligible for offline recovery: ${result.lockPath}`);
    console.log(`Kind: ${result.kind}`);
    console.log(`Age: ${Math.floor(result.ageMs)} ms`);
    console.log(`Fingerprint: ${result.fingerprint}`);
    console.log(
      "Stop every Quack monitor, listener, scheduler, and worker that can access this project before applying.",
    );
    console.log(
      `Apply: quack repair-federation-lock ${result.jobId} --project <path> --apply --confirm-offline --expected-fingerprint ${result.fingerprint}`,
    );
    return;
  }
  if (result.status === "recovered") {
    console.log(`Recovered stale federation lock: ${result.lockPath}`);
    console.log(`Fingerprint: ${result.fingerprint}`);
    return;
  }
  if (result.status === "staging-cleaned") {
    console.log(`Cleaned orphaned offline recovery staging: ${result.lockPath}`);
    console.log(`Artifacts removed: ${result.removedArtifacts}`);
    console.log(`Fingerprint: ${result.fingerprint}`);
    return;
  }
  console.error(`Offline federation lock recovery ${result.status}: ${result.reason}`);
  process.exitCode = result.status === "absent" ? 0 : 1;
}

export async function repairFederationLockCommand(
  jobId: string,
  options: RepairFederationLockCommandOptions = {},
): Promise<void> {
  try {
    const result = await repairFederatedJobLockOffline({
      projectRoot: options.project ?? process.cwd(),
      jobId,
      staleMs: parseStaleMs(options.staleMs),
      apply: options.apply,
      confirmOffline: options.confirmOffline,
      expectedFingerprint: options.expectedFingerprint,
    });
    printResult(result);
  } catch (error: unknown) {
    console.error(`Error: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
