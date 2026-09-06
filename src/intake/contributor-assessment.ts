import type { WorkflowLane, WorkflowRiskLevel } from "../workflow/workflow-state-types.js";
import type { LaneClassification } from "./lane-classifier.js";
import type { RemoteTaskIntakeRequest } from "./task-intake.js";

export type ContributorReadinessStatus = "ready_for_intake" | "needs_enrichment" | "manual_review";

export interface ContributorQualityGate {
  ready: boolean;
  status: ContributorReadinessStatus;
  score: number;
  blockers: string[];
  warnings: string[];
}

export interface ContributorSuggestedRoute {
  lane: WorkflowLane;
  riskLevel: WorkflowRiskLevel;
  reason: string;
}

export interface ContributorSuggestedFederationJob {
  jobType: "intake" | "verify" | "fix" | "dispatch";
  requiredCapabilities: string[];
  preferredHostId?: string;
}

export interface ContributorIntakeAssessment {
  qualityGate: ContributorQualityGate;
  missingFields: string[];
  recommendedCapabilities: string[];
  suggestedRoute: ContributorSuggestedRoute;
  suggestedFederationJob: ContributorSuggestedFederationJob;
  handoffHints: string[];
}

interface CapabilityRule {
  capability: string;
  needles: string[];
}

const CAPABILITY_RULES: CapabilityRule[] = [
  {
    capability: "staging-db",
    needles: [
      "dev/staging database",
      "staging database",
      "dev database",
      "live-data",
      "live data",
      "seeded rows",
      "seed row",
    ],
  },
  {
    capability: "database",
    needles: [
      "database",
      "postgres",
      "mysql",
      "sqlite",
      "migration",
      "backfill",
      "seed",
      "db env",
      "db ",
    ],
  },
  {
    capability: "backend",
    needles: ["/api/", "endpoint", "controller", "route", "service", "backend", "server"],
  },
  {
    capability: "auth",
    needles: ["auth", "token", "jwt", "session", "permission", "admin-auth", "scoped token"],
  },
  {
    capability: "docker",
    needles: ["docker", "compose", "container"],
  },
  {
    capability: "browser",
    needles: ["browser", "playwright", "visual", "screenshot", "ui "],
  },
  {
    capability: "tailnet",
    needles: ["tailscale", "tailnet", "headnode", "worker-b"],
  },
];

function normalize(value: string): string {
  return value.trim().toLowerCase();
}

function addUnique(target: string[], value: string): void {
  if (!target.includes(value)) {
    target.push(value);
  }
}

function metadataList(metadata: Record<string, unknown>, key: string): string[] {
  const value = metadata[key];
  if (Array.isArray(value)) {
    return value
      .filter((item): item is string => typeof item === "string")
      .map((item) => item.trim())
      .filter((item) => item.length > 0);
  }
  if (typeof value === "string" && value.trim().length > 0) {
    return [value.trim()];
  }
  return [];
}

function metadataText(metadata: Record<string, unknown>, key: string): string {
  const value = metadata[key];
  return typeof value === "string" ? value.trim() : "";
}

function buildSearchText(input: RemoteTaskIntakeRequest): string {
  const metadataValues = Object.values(input.metadata)
    .flatMap((value) => {
      if (typeof value === "string") return [value];
      if (Array.isArray(value)) {
        return value.filter((item): item is string => typeof item === "string");
      }
      return [];
    })
    .join(" ");

  return normalize(
    [
      input.title,
      input.description,
      input.tags.join(" "),
      input.files.join(" "),
      metadataValues,
    ].join(" "),
  );
}

function inferCapabilities(input: RemoteTaskIntakeRequest): string[] {
  const capabilities: string[] = [];
  for (const explicit of metadataList(input.metadata, "requiredCapabilities")) {
    addUnique(capabilities, normalize(explicit));
  }

  const text = buildSearchText(input);
  for (const rule of CAPABILITY_RULES) {
    if (rule.needles.some((needle) => text.includes(needle))) {
      addUnique(capabilities, rule.capability);
    }
  }

  for (const file of input.files.map(normalize)) {
    if (file.includes("/routes/") || file.includes("/controllers/")) {
      addUnique(capabilities, "backend");
    }
    if (file.includes("migration") || file.endsWith(".sql") || file.includes("schema")) {
      addUnique(capabilities, "database");
    }
    if (file.includes("docker") || file.includes("compose")) {
      addUnique(capabilities, "docker");
    }
  }

  return capabilities;
}

function inferJobType(
  input: RemoteTaskIntakeRequest,
): ContributorSuggestedFederationJob["jobType"] {
  const text = buildSearchText(input);
  if (
    text.includes("verify") ||
    text.includes("verification") ||
    text.includes("protocol") ||
    text.includes("confirm")
  ) {
    return "verify";
  }
  if (text.includes("fix") || text.includes("repair")) {
    return "fix";
  }
  if (text.includes("dispatch") || text.includes("implement") || text.includes("build")) {
    return "dispatch";
  }
  return "intake";
}

function scoreIntake(input: RemoteTaskIntakeRequest, missingFields: string[]): number {
  let score = 3.2;
  if (input.taskId) score += 0.25;
  if (input.tags.length > 0) score += 0.25;
  if (input.files.length > 0) score += 0.35;
  if (input.description.length >= 160) score += 0.4;
  if (metadataList(input.metadata, "successCriteria").length >= 2) score += 0.55;
  if (metadataList(input.metadata, "testingRequirements").length >= 1) score += 0.35;
  if (
    metadataList(input.metadata, "evidenceProtocol").length > 0 ||
    metadataText(input.metadata, "evidenceProtocol").length > 0
  ) {
    score += 0.35;
  }

  score -= Math.min(missingFields.length * 0.15, 0.45);
  return Math.max(0, Math.min(5, Number(score.toFixed(1))));
}

export function assessContributorIntake(
  input: RemoteTaskIntakeRequest,
  classification: LaneClassification,
): ContributorIntakeAssessment {
  const missingFields: string[] = [];
  const blockers: string[] = [];
  const warnings: string[] = [];

  if (!input.taskId) missingFields.push("taskId");
  if (input.files.length === 0) missingFields.push("files");
  if (input.tags.length === 0) missingFields.push("tags");
  if (input.description.length < 160) missingFields.push("description.detail");
  if (metadataList(input.metadata, "successCriteria").length < 2) {
    missingFields.push("metadata.successCriteria");
  }
  if (metadataList(input.metadata, "testingRequirements").length === 0) {
    missingFields.push("metadata.testingRequirements");
  }

  const capabilities = inferCapabilities(input);
  const jobType = inferJobType(input);
  const needsRuntimeEvidence =
    jobType === "verify" ||
    capabilities.includes("database") ||
    capabilities.includes("staging-db") ||
    capabilities.includes("docker");

  if (needsRuntimeEvidence && capabilities.length === 0) {
    blockers.push("missing_required_capabilities");
  }
  if (
    needsRuntimeEvidence &&
    metadataList(input.metadata, "evidenceProtocol").length === 0 &&
    metadataText(input.metadata, "evidenceProtocol").length === 0
  ) {
    missingFields.push("metadata.evidenceProtocol");
  }
  if (classification.lane === "human_required") {
    warnings.push("classified_human_required");
  }
  if (capabilities.includes("database") || capabilities.includes("staging-db")) {
    warnings.push("requires_reachable_database_or_seed_fixture");
  }
  if (capabilities.includes("auth")) {
    warnings.push("requires_scoped_auth_token");
  }

  const score = scoreIntake(input, missingFields);
  const status: ContributorReadinessStatus =
    blockers.length > 0 ? "manual_review" : score >= 4.5 ? "ready_for_intake" : "needs_enrichment";

  return {
    qualityGate: {
      ready: status === "ready_for_intake",
      status,
      score,
      blockers,
      warnings,
    },
    missingFields,
    recommendedCapabilities: capabilities,
    suggestedRoute: {
      lane: classification.lane,
      riskLevel: classification.riskLevel,
      reason: classification.reasons.join(", "),
    },
    suggestedFederationJob: {
      jobType,
      requiredCapabilities: capabilities,
      preferredHostId: capabilities.includes("staging-db") ? "headnode" : undefined,
    },
    handoffHints: [
      "Call POST /v1/intake/tasks/validate before creating the intake record.",
      "Include metadata.successCriteria and metadata.testingRequirements as arrays.",
      "For live-data or DB verification, include metadata.evidenceProtocol and metadata.requiredCapabilities.",
      "Use the returned classification and capability hints when requesting a federated job.",
    ],
  };
}
