type Readiness = "ready" | "not-ready" | "unknown" | "incomplete";
type DocumentationReadiness = "ready" | "not-ready" | "unknown";
type IssueDisposition = "blocking" | "nonblocking" | "unknown";

interface ReviewIssueView {
  code: string;
  message: string;
  disposition: IssueDisposition;
  field?: string;
  blockReasonCode?: string;
}

interface ReviewFindingView {
  title: string;
  severity: "P1" | "P2" | "P3" | "unknown";
  status: "open" | "resolved" | "waived" | "unknown";
  file?: string;
}

interface ReviewArtifactView {
  pagePath?: string;
  commitSha?: string;
  linkedTaskIds: string[];
  action?: string;
  incomplete: boolean;
}

export interface ReviewReadinessView {
  taskId: string | null;
  reviewId: string | null;
  verdict: string;
  documentation: DocumentationReadiness;
  readiness: Readiness;
  evidenceProblems: string[];
  issues: ReviewIssueView[];
  findings: ReviewFindingView[];
  actions: { required: string[]; missing: string[] };
  artifacts: ReviewArtifactView[];
  summary?: string;
  reviewer?: string;
  reviewNotes?: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseIssues(raw: unknown, problems: string[]): ReviewIssueView[] {
  if (!Array.isArray(raw)) {
    problems.push("gate.issues is missing or not an array");
    return [];
  }
  const result: ReviewIssueView[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      problems.push("gate.issues contains a non-object member");
      continue;
    }
    const code = typeof item.code === "string" ? item.code : "";
    const message = typeof item.message === "string" ? item.message : "";
    if (!code || !message) {
      problems.push("gate.issues member is missing code or message");
      continue;
    }
    let disposition: IssueDisposition;
    if (item.blocking === true) {
      disposition = "blocking";
    } else if (item.blocking === false) {
      disposition = "nonblocking";
    } else {
      disposition = "unknown";
      problems.push(`gate.issues member "${code}" has non-boolean blocking field`);
    }
    result.push({
      code,
      message,
      disposition,
      field: typeof item.field === "string" ? item.field : undefined,
      blockReasonCode: typeof item.blockReasonCode === "string" ? item.blockReasonCode : undefined,
    });
  }
  return result;
}

function parseFindings(raw: unknown, problems: string[]): ReviewFindingView[] {
  if (raw === undefined || raw === null) {
    // Optional field; valid absence
    return [];
  }
  if (!Array.isArray(raw)) {
    problems.push("findings is not an array");
    return [];
  }
  const result: ReviewFindingView[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      problems.push("findings contains a non-object member");
      continue;
    }
    const title = typeof item.title === "string" ? item.title : "";
    if (!title) {
      problems.push("findings member is missing title");
      continue;
    }
    let severity: ReviewFindingView["severity"];
    if (item.severity === "P1" || item.severity === "P2" || item.severity === "P3") {
      severity = item.severity;
    } else {
      severity = "unknown";
      problems.push(`findings member "${title}" has unknown severity`);
    }
    let status: ReviewFindingView["status"];
    if (item.status === undefined || item.status === null) {
      // Omitted status means open per producer
      status = "open";
    } else if (item.status === "open" || item.status === "resolved" || item.status === "waived") {
      status = item.status;
    } else {
      status = "unknown";
      problems.push(`findings member "${title}" has unknown status`);
    }
    result.push({
      title,
      severity,
      status,
      file: typeof item.file === "string" ? item.file : undefined,
    });
  }
  return result;
}

function parseArtifacts(raw: unknown, problems: string[]): ReviewArtifactView[] {
  if (raw === undefined || raw === null) {
    // Optional field; valid absence
    return [];
  }
  if (!Array.isArray(raw)) {
    problems.push("wikiArtifacts is not an array");
    return [];
  }
  const result: ReviewArtifactView[] = [];
  for (const item of raw) {
    if (!isRecord(item)) {
      problems.push("wikiArtifacts contains a non-object member");
      result.push({ linkedTaskIds: [], incomplete: true });
      continue;
    }
    const pagePath = typeof item.pagePath === "string" ? item.pagePath : undefined;
    const commitSha = typeof item.commitSha === "string" ? item.commitSha : undefined;
    let linkedTaskIds: string[] = [];
    if (Array.isArray(item.linkedTaskIds)) {
      linkedTaskIds = item.linkedTaskIds.filter((id): id is string => typeof id === "string");
    }

    let incomplete = false;
    if (!pagePath) {
      problems.push("wikiArtifacts member is missing pagePath");
      incomplete = true;
    }
    if (!commitSha) {
      problems.push("wikiArtifacts member is missing commitSha");
      incomplete = true;
    }
    if (!Array.isArray(item.linkedTaskIds) || linkedTaskIds.length === 0) {
      problems.push("wikiArtifacts member is missing linkedTaskIds");
      incomplete = true;
    }

    result.push({
      pagePath,
      commitSha,
      linkedTaskIds,
      action: typeof item.action === "string" ? item.action : undefined,
      incomplete,
    });
  }
  return result;
}

function parseStringArray(raw: unknown, fieldName: string, problems: string[]): string[] | null {
  if (!Array.isArray(raw)) {
    problems.push(`${fieldName} is missing or not an array`);
    return null;
  }
  const result: string[] = [];
  for (const item of raw) {
    if (typeof item !== "string") {
      problems.push(`${fieldName} contains a non-string member`);
      return null;
    }
    result.push(item);
  }
  return result;
}

function hasContradiction(
  mergeReady: boolean,
  issues: ReviewIssueView[],
  missingActions: string[] | null,
  findings: ReviewFindingView[],
): boolean {
  if (!mergeReady) return false;
  // mergeReady true plus a blocking issue
  if (issues.some((i) => i.disposition === "blocking")) return true;
  // mergeReady true plus missing required action
  if (missingActions !== null && missingActions.length > 0) return true;
  // mergeReady true plus open P1 finding
  if (findings.some((f) => f.severity === "P1" && f.status === "open")) return true;
  return false;
}

export function presentReviewReadiness(value: unknown): ReviewReadinessView {
  const problems: string[] = [];

  if (!isRecord(value)) {
    return {
      taskId: null,
      reviewId: null,
      verdict: "unknown",
      documentation: "unknown",
      readiness: "incomplete",
      evidenceProblems: ["review is not an object"],
      issues: [],
      findings: [],
      actions: { required: [], missing: [] },
      artifacts: [],
    };
  }

  const taskId = typeof value.taskId === "string" ? value.taskId : null;
  const reviewId = typeof value.reviewId === "string" ? value.reviewId : null;

  if (!taskId) problems.push("review.taskId is missing or not a string");
  if (!reviewId) problems.push("review.reviewId is missing or not a string");

  const verdict = typeof value.verdict === "string" ? value.verdict : null;
  if (!verdict) {
    problems.push("review.verdict is missing or not a string");
  } else if (verdict !== "VERIFIED" && verdict !== "PARTIAL" && verdict !== "FAILED") {
    problems.push(`review.verdict "${verdict}" is not a recognized value`);
  }

  const verdictDisplay = verdict ?? "unknown";

  // Parse gate
  let mergeReady: boolean | undefined;
  let documentation: DocumentationReadiness;
  let issues: ReviewIssueView[] = [];
  let requiredActions: string[] | null = null;
  let missingActions: string[] | null = null;
  let hasIncompleteGateArrays = false;

  const gate = value.gate;
  if (!isRecord(gate)) {
    problems.push("review.gate is missing or not an object");
    documentation = "unknown";
    hasIncompleteGateArrays = true;
  } else {
    if (gate.mergeReady === true) {
      mergeReady = true;
      documentation = "ready";
    } else if (gate.mergeReady === false) {
      mergeReady = false;
      documentation = "not-ready";
    } else {
      // Missing or wrong type — unknown, never truthy coercion
      documentation = "unknown";
    }

    issues = parseIssues(gate.issues, problems);
    if (!Array.isArray(gate.issues)) {
      hasIncompleteGateArrays = true;
    }

    requiredActions = parseStringArray(gate.requiredWikiActions, "gate.requiredWikiActions", problems);
    if (requiredActions === null) hasIncompleteGateArrays = true;

    missingActions = parseStringArray(gate.missingWikiActions, "gate.missingWikiActions", problems);
    if (missingActions === null) hasIncompleteGateArrays = true;
  }

  const findings = parseFindings(value.findings, problems);
  const artifacts = parseArtifacts(value.wikiArtifacts, problems);

  const hasArtifactIncomplete = artifacts.some((a) => a.incomplete);
  const hasIssueUnknownBlocking = issues.some((i) => i.disposition === "unknown");
  const hasFindingUnknown = findings.some((f) => f.severity === "unknown" || f.status === "unknown");

  const isStructurallyIncomplete =
    !taskId ||
    !reviewId ||
    !verdict ||
    (verdict !== "VERIFIED" && verdict !== "PARTIAL" && verdict !== "FAILED") ||
    !isRecord(gate) ||
    hasIncompleteGateArrays ||
    hasArtifactIncomplete ||
    hasIssueUnknownBlocking ||
    hasFindingUnknown;

  const contradictory =
    mergeReady !== undefined
      ? hasContradiction(mergeReady, issues, missingActions, findings)
      : false;

  if (contradictory) {
    problems.push("gate.mergeReady true contradicts blocking issues, missing actions, or open P1 findings");
  }

  let readiness: Readiness;
  if (isStructurallyIncomplete || contradictory) {
    readiness = "incomplete";
  } else if (mergeReady === undefined) {
    readiness = "unknown";
  } else if (verdict === "VERIFIED" && mergeReady === true) {
    readiness = "ready";
  } else {
    readiness = "not-ready";
  }

  return {
    taskId,
    reviewId,
    verdict: verdictDisplay,
    documentation,
    readiness,
    evidenceProblems: problems,
    issues,
    findings,
    actions: {
      required: requiredActions ?? [],
      missing: missingActions ?? [],
    },
    artifacts,
    summary: typeof value.summary === "string" ? value.summary : undefined,
    reviewer: typeof value.reviewer === "string" ? value.reviewer : undefined,
    reviewNotes: typeof value.reviewNotes === "string" ? value.reviewNotes : undefined,
  };
}
