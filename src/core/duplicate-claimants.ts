/** A parseable task file and the id declared by its H1. */
export interface TaskClaimantDeclaration {
  fileName: string;
  declaredId: string;
}

export type DuplicateClaimantIndex =
  | { status: "scanned"; contested: Map<string, string[]> }
  | { status: "unavailable"; reason: string };

/**
 * Strict, non-collapsing claimant index for creator-side ownership checks.
 * Unlike {@link DuplicateClaimantIndex}, a single claimant is retained: a
 * creator must refuse the *second* claimant before the id becomes contested.
 */
export type TaskClaimantIndex =
  | { status: "scanned"; claimants: Map<string, string[]> }
  | { status: "unavailable"; reason: string };

export type DuplicateClaimantScanProducer = () => Promise<readonly TaskClaimantDeclaration[]>;

export async function buildStrictTaskClaimantIndex(
  producer?: DuplicateClaimantScanProducer,
): Promise<TaskClaimantIndex> {
  if (!producer) {
    return {
      status: "unavailable",
      reason: "TaskService is unavailable for claimant scan.",
    };
  }

  try {
    const declarations = await producer();
    const normalized = declarations.map((declaration) => ({
      fileName: declaration.fileName,
      declaredId: normalizeClaimantTaskId(declaration.declaredId),
    }));
    const claimants = groupTaskClaimantsByDeclaredId(normalized);
    for (const [taskId, fileNames] of claimants) {
      claimants.set(
        taskId,
        [...fileNames].sort((a, b) => a.localeCompare(b)),
      );
    }
    return { status: "scanned", claimants };
  } catch (err: unknown) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      status: "unavailable",
      reason: `Claimant scan failed: ${detail}`,
    };
  }
}

export async function buildStrictDuplicateClaimantIndex(
  producer?: DuplicateClaimantScanProducer,
): Promise<DuplicateClaimantIndex> {
  const index = await buildStrictTaskClaimantIndex(producer);
  if (index.status === "unavailable") {
    return {
      status: "unavailable",
      reason:
        index.reason === "TaskService is unavailable for claimant scan."
          ? "TaskService is unavailable for duplicate claimant scan."
          : index.reason.replace("Claimant scan", "Duplicate claimant scan"),
    };
  }

  const contested = new Map<string, string[]>();
  for (const [taskId, claimants] of index.claimants) {
    if (claimants.length > 1) contested.set(taskId, [...claimants]);
  }
  return { status: "scanned", contested };
}

export function normalizeClaimantTaskId(taskId: string): string {
  const trimmed = taskId.trim().toUpperCase();
  return trimmed.match(/\bTASK-\d+(?:-[A-Z]+)?\b/)?.[0] ?? trimmed;
}

/**
 * Group parsed task files by declared id without changing encounter order.
 * Consumers that need deterministic sorted output must sort a copy.
 */
export function groupTaskClaimantsByDeclaredId(
  declarations: readonly TaskClaimantDeclaration[],
): Map<string, string[]> {
  const filesByDeclaredId = new Map<string, string[]>();

  for (const declaration of declarations) {
    const existing = filesByDeclaredId.get(declaration.declaredId) ?? [];
    existing.push(declaration.fileName);
    filesByDeclaredId.set(declaration.declaredId, existing);
  }

  return filesByDeclaredId;
}

/** Build the shared operator-facing refusal message for a contested id. */
export function formatDuplicateClaimantsMessage(
  taskId: string,
  claimants: readonly string[],
): string {
  return `Task ${taskId} has duplicate claimants: ${claimants.join(", ")}. Refusing to write until the id has one owner.`;
}

export interface DuplicateClaimantCheck {
  taskId: string;
  claimants: string[];
}

export interface DuplicateClaimantRefusal extends DuplicateClaimantCheck {
  error: "duplicate_claimants";
  message: string;
  retryable?: true;
}

export function duplicateClaimantRefusalForIndex(
  index: DuplicateClaimantIndex,
  taskId: string,
): DuplicateClaimantRefusal | undefined {
  const normalizedTaskId = normalizeClaimantTaskId(taskId);
  if (index.status === "unavailable") {
    return {
      error: "duplicate_claimants",
      taskId: normalizedTaskId,
      claimants: [],
      message: `Task ${normalizedTaskId} duplicate claimant scan unavailable: ${index.reason} Refusing admission until the scan succeeds.`,
      retryable: true,
    };
  }

  const claimants = index.contested.get(normalizedTaskId);
  if (!claimants) return undefined;
  return duplicateClaimantRefusal({ taskId: normalizedTaskId, claimants });
}

export function duplicateClaimantRefusal(check: DuplicateClaimantCheck): DuplicateClaimantRefusal {
  return {
    error: "duplicate_claimants",
    taskId: check.taskId,
    claimants: [...check.claimants],
    message: formatDuplicateClaimantsMessage(check.taskId, check.claimants),
  };
}

export class DuplicateClaimantAdmissionError extends Error {
  readonly code = "duplicate_claimants";
  readonly taskId: string;
  readonly claimants: string[];

  constructor(check: DuplicateClaimantCheck) {
    super(formatDuplicateClaimantsMessage(check.taskId, check.claimants));
    this.name = "DuplicateClaimantAdmissionError";
    this.taskId = check.taskId;
    this.claimants = [...check.claimants];
  }
}

export function assertUncontestedClaimant(check: DuplicateClaimantCheck | undefined): void {
  if (check && check.claimants.length > 1) {
    throw new DuplicateClaimantAdmissionError(check);
  }
}
