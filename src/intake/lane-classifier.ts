import type { WorkflowLane, WorkflowRiskLevel } from "../workflow/workflow-state-types.js";

export const INTAKE_CLASSIFICATION_REASONS = [
  "manual_tag",
  "infrastructure_tag",
  "interactive_tag",
  "deploy_or_operations",
  "credential_or_secret",
  "security_sensitive",
  "data_or_migration",
  "high_priority",
  "complex_change",
  "docs_only",
  "tests_only",
  "low_risk_code_change",
  "guarded_code_change",
  "fallback_guarded",
  "requested_human_required",
  "operator_route",
] as const;

export type IntakeClassificationReason = (typeof INTAKE_CLASSIFICATION_REASONS)[number];

export interface LaneClassificationInput {
  title: string;
  description: string;
  tags?: string[];
  files?: string[];
  priority?: string;
  requestedLane?: WorkflowLane;
}

export interface LaneClassification {
  lane: WorkflowLane;
  riskLevel: WorkflowRiskLevel;
  reasons: IntakeClassificationReason[];
}

const HUMAN_TAGS = new Set(["manual", "requires-manual", "human", "interactive"]);

const INFRA_TAGS = new Set([
  "infra",
  "infrastructure",
  "ops",
  "operations",
  "deploy",
  "deployment",
  "production",
]);

const COMPLEX_TAGS = new Set([
  "architecture",
  "refactor",
  "migration",
  "database",
  "security",
  "auth",
]);

const DOC_EXTENSIONS = [".md", ".mdx", ".rst", ".txt"];
const TEST_PATH_PARTS = ["/test/", "/tests/", "/__tests__/", ".test.", ".spec."];

function normalizeList(values: string[] | undefined): string[] {
  return (values ?? [])
    .map((value) => value.trim().toLowerCase())
    .filter((value) => value.length > 0);
}

function includesAny(value: string, needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}

function isDocsFile(filePath: string): boolean {
  const lower = filePath.toLowerCase();
  return (
    lower.startsWith("docs/") ||
    lower.startsWith("wiki/") ||
    DOC_EXTENSIONS.some((extension) => lower.endsWith(extension))
  );
}

function isTestFile(filePath: string): boolean {
  const lower = filePath.toLowerCase().replace(/\\/g, "/");
  return TEST_PATH_PARTS.some((part) => lower.includes(part));
}

function addReason(
  reasons: IntakeClassificationReason[],
  reason: IntakeClassificationReason,
): void {
  if (!reasons.includes(reason)) {
    reasons.push(reason);
  }
}

export function classifyIntakeLane(input: LaneClassificationInput): LaneClassification {
  const tags = normalizeList(input.tags);
  const files = normalizeList(input.files);
  const text = `${input.title} ${input.description}`.toLowerCase();
  const reasons: IntakeClassificationReason[] = [];

  const hasHumanTag = tags.some((tag) => HUMAN_TAGS.has(tag));
  const hasInfraTag = tags.some((tag) => INFRA_TAGS.has(tag));
  const hasComplexTag = tags.some((tag) => COMPLEX_TAGS.has(tag));
  const hasDeployText = includesAny(text, [
    "deploy",
    "production",
    "rollback",
    "ssh",
    "vpn",
    "systemd",
  ]);
  const hasCredentialText = includesAny(text, [
    "secret",
    "credential",
    "api key",
    "password",
    "private key",
    "token secret",
  ]);
  const hasSecurityText = includesAny(text, ["security", "auth", "permission", "oauth", "token"]);
  const hasDataText = includesAny(text, ["migration", "schema", "database", "backfill"]);
  const hasRiskyFile = files.some((file) =>
    includesAny(file, [
      ".github/workflows/",
      "dockerfile",
      "docker-compose",
      "infra/",
      "migrations/",
      "schema",
      "package-lock.json",
    ]),
  );

  if (hasHumanTag) addReason(reasons, "manual_tag");
  if (hasInfraTag) addReason(reasons, "infrastructure_tag");
  if (tags.includes("interactive")) addReason(reasons, "interactive_tag");
  if (hasDeployText) addReason(reasons, "deploy_or_operations");
  if (hasCredentialText) addReason(reasons, "credential_or_secret");
  if (hasSecurityText) addReason(reasons, "security_sensitive");
  if (hasDataText || hasRiskyFile) addReason(reasons, "data_or_migration");
  if (input.priority === "P0-CRITICAL") addReason(reasons, "high_priority");
  if (hasComplexTag) addReason(reasons, "complex_change");

  if (
    input.requestedLane === "human_required" ||
    hasHumanTag ||
    hasInfraTag ||
    hasDeployText ||
    hasCredentialText
  ) {
    if (input.requestedLane === "human_required") {
      addReason(reasons, "requested_human_required");
    }
    return {
      lane: "human_required",
      riskLevel: "high",
      reasons,
    };
  }

  const docsOnly = files.length > 0 && files.every(isDocsFile);
  const testsOnly = files.length > 0 && files.every(isTestFile);
  if (docsOnly) addReason(reasons, "docs_only");
  if (testsOnly) addReason(reasons, "tests_only");

  const highRisk =
    hasSecurityText ||
    hasDataText ||
    hasRiskyFile ||
    hasComplexTag ||
    input.priority === "P0-CRITICAL";

  if (highRisk) {
    if (reasons.length === 0) addReason(reasons, "guarded_code_change");
    return {
      lane: "guarded_auto",
      riskLevel: "high",
      reasons,
    };
  }

  if (docsOnly || testsOnly) {
    return {
      lane: "auto",
      riskLevel: "low",
      reasons,
    };
  }

  if (files.length > 0) {
    addReason(
      reasons,
      input.priority === "P3-LOW" ? "low_risk_code_change" : "guarded_code_change",
    );
    return {
      lane: input.priority === "P3-LOW" ? "auto" : "guarded_auto",
      riskLevel: input.priority === "P3-LOW" ? "low" : "medium",
      reasons,
    };
  }

  addReason(reasons, "fallback_guarded");
  return {
    lane: "guarded_auto",
    riskLevel: "medium",
    reasons,
  };
}
