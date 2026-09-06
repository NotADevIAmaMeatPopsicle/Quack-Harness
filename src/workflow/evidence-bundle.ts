import { z } from "zod";

import {
  CANONICAL_BLOCK_REASON_CODES,
  CANONICAL_DOCS_IMPACTS,
  CANONICAL_LANES,
  CANONICAL_RISK_LEVELS,
  CANONICAL_WIKI_ACTIONS,
  CANONICAL_WORKFLOW_STATES,
  type WikiAction,
} from "./workflow-state-types.js";

const commandEvidenceSchema = z.object({
  name: z.string().min(1),
  command: z.string().optional(),
  status: z.enum(["passed", "failed", "skipped"]),
  exitCode: z.number().int().optional(),
  durationMs: z.number().nonnegative().optional(),
  summary: z.string().optional(),
  outputPath: z.string().optional(),
});

const findingEvidenceSchema = z.object({
  title: z.string().min(1),
  severity: z.enum(["P1", "P2", "P3"]),
  status: z.enum(["open", "resolved", "waived"]).default("open"),
  file: z.string().optional(),
});

const wikiArtifactSchema = z.object({
  pagePath: z.string().min(1),
  commitSha: z.string().min(1),
  linkedTaskIds: z.array(z.string().min(1)).default([]),
  action: z.enum(CANONICAL_WIKI_ACTIONS).optional(),
});

const supportDocCandidateSchema = z.object({
  title: z.string().min(1),
  summary: z.string().min(1),
  productArea: z.string().optional(),
  linkedTaskIds: z.array(z.string().min(1)).default([]),
  tags: z.array(z.string().min(1)).default([]),
});

const outputAttemptSchema = z.object({
  attempt: z.number().int().positive(),
  kind: z.enum(["worker", "retry", "lifecycle_fix"]),
  commitSha: z.string().optional(),
  baseSha: z.string().optional(),
  changedFiles: z.array(z.string().min(1)).default([]),
  manifestPath: z.string().min(1),
  diffPath: z.string().min(1),
  sealedAt: z.string().min(1),
});

export const evidenceBundleSchema = z.object({
  taskId: z.string().min(1),
  intakeId: z.string().optional(),
  workflowId: z.string().optional(),
  reviewId: z.string().optional(),
  verificationRecordId: z.string().optional(),
  jobId: z.string().optional(),
  hostId: z.string().optional(),
  sessionId: z.string().optional(),
  workflowState: z.enum(CANONICAL_WORKFLOW_STATES).optional(),
  blockReasonCode: z.enum(CANONICAL_BLOCK_REASON_CODES).optional(),
  lane: z.enum(CANONICAL_LANES).optional(),
  riskLevel: z.enum(CANONICAL_RISK_LEVELS).optional(),
  changedFiles: z.array(z.string().min(1)).default([]),
  outputAttempts: z.array(outputAttemptSchema).default([]),
  buildResults: z.array(commandEvidenceSchema).default([]),
  testResults: z.array(commandEvidenceSchema).default([]),
  lintResults: z.array(commandEvidenceSchema).default([]),
  findings: z.array(findingEvidenceSchema).default([]),
  review: z
    .object({
      reviewId: z.string().optional(),
      verdict: z.enum(["VERIFIED", "PARTIAL", "FAILED"]).optional(),
      mergeReady: z.boolean().optional(),
      docsImpact: z.enum(CANONICAL_DOCS_IMPACTS).optional(),
      requiredWikiActions: z.array(z.enum(CANONICAL_WIKI_ACTIONS)).default([]),
      missingWikiActions: z.array(z.enum(CANONICAL_WIKI_ACTIONS)).default([]),
      wikiArtifacts: z.array(wikiArtifactSchema).default([]),
      supportDocCandidates: z.array(supportDocCandidateSchema).default([]),
    })
    .optional(),
  verification: z
    .object({
      verificationRecordId: z.string().optional(),
      verdict: z.enum(["VERIFIED", "REJECTED", "PARTIAL"]).optional(),
      criteriaChecked: z.number().int().nonnegative().optional(),
      criteriaPassed: z.number().int().nonnegative().optional(),
      commitSha: z.string().optional(),
      verifiedAt: z.string().optional(),
    })
    .optional(),
  docs: z
    .object({
      docsImpact: z.enum(CANONICAL_DOCS_IMPACTS).optional(),
      requiredWikiActions: z.array(z.enum(CANONICAL_WIKI_ACTIONS)).default([]),
      wikiArtifacts: z.array(wikiArtifactSchema).default([]),
      supportDocCandidates: z.array(supportDocCandidateSchema).default([]),
      supportContentRecords: z.number().int().nonnegative().default(0),
      lastDocsEventAt: z.string().optional(),
    })
    .optional(),
  updatedAt: z.string().optional(),
});

export type CommandEvidence = z.infer<typeof commandEvidenceSchema>;
export type FindingEvidence = z.infer<typeof findingEvidenceSchema>;
export type WikiArtifactEvidence = z.infer<typeof wikiArtifactSchema>;
export type SupportDocCandidateEvidence = z.infer<typeof supportDocCandidateSchema>;
export type OutputAttemptEvidence = z.infer<typeof outputAttemptSchema>;
export type EvidenceBundle = z.infer<typeof evidenceBundleSchema>;
export type EvidenceBundleInput = z.input<typeof evidenceBundleSchema>;

function sortStrings(values: string[]): string[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function sortWikiActions(values: WikiAction[]): WikiAction[] {
  return [...new Set(values)].sort((a, b) => a.localeCompare(b));
}

function mergeByKey<T>(base: T[], update: T[], keyFn: (value: T) => string): T[] {
  const byKey = new Map<string, T>();
  for (const item of base) {
    byKey.set(keyFn(item), item);
  }
  for (const item of update) {
    byKey.set(keyFn(item), item);
  }
  return [...byKey.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([, value]) => value);
}

function commandKey(value: CommandEvidence): string {
  return value.name;
}

function findingKey(value: FindingEvidence): string {
  return [value.severity, value.file ?? "", value.title].join("|");
}

function wikiArtifactKey(value: WikiArtifactEvidence): string {
  return [value.action ?? "", value.pagePath, value.commitSha].join("|");
}

function supportCandidateKey(value: SupportDocCandidateEvidence): string {
  return [value.productArea ?? "", value.title, value.summary].join("|");
}

function outputAttemptKey(value: OutputAttemptEvidence): string {
  return [value.attempt, value.kind, value.commitSha ?? "", value.manifestPath].join("|");
}

export function parseEvidenceBundle(input: unknown): EvidenceBundle {
  return evidenceBundleSchema.parse(input);
}

export function createEvidenceBundle(input: EvidenceBundleInput): EvidenceBundle {
  return parseEvidenceBundle(input);
}

function mergeReview(
  base: EvidenceBundle["review"],
  update: EvidenceBundle["review"],
): EvidenceBundle["review"] {
  if (!base && !update) return undefined;
  if (!base) return update;
  if (!update) return base;

  return {
    ...base,
    ...update,
    requiredWikiActions: sortWikiActions([
      ...(base.requiredWikiActions ?? []),
      ...(update.requiredWikiActions ?? []),
    ]),
    missingWikiActions: sortWikiActions([
      ...(base.missingWikiActions ?? []),
      ...(update.missingWikiActions ?? []),
    ]),
    wikiArtifacts: mergeByKey(
      base.wikiArtifacts ?? [],
      update.wikiArtifacts ?? [],
      wikiArtifactKey,
    ),
    supportDocCandidates: mergeByKey(
      base.supportDocCandidates ?? [],
      update.supportDocCandidates ?? [],
      supportCandidateKey,
    ),
  };
}

function mergeDocs(
  base: EvidenceBundle["docs"],
  update: EvidenceBundle["docs"],
): EvidenceBundle["docs"] {
  if (!base && !update) return undefined;
  if (!base) return update;
  if (!update) return base;

  return {
    ...base,
    ...update,
    requiredWikiActions: sortWikiActions([
      ...(base.requiredWikiActions ?? []),
      ...(update.requiredWikiActions ?? []),
    ]),
    wikiArtifacts: mergeByKey(
      base.wikiArtifacts ?? [],
      update.wikiArtifacts ?? [],
      wikiArtifactKey,
    ),
    supportDocCandidates: mergeByKey(
      base.supportDocCandidates ?? [],
      update.supportDocCandidates ?? [],
      supportCandidateKey,
    ),
    supportContentRecords: update.supportContentRecords ?? base.supportContentRecords ?? 0,
  };
}

export function mergeEvidenceBundles(
  baseInput: EvidenceBundleInput,
  updateInput: EvidenceBundleInput,
): EvidenceBundle {
  const base = createEvidenceBundle(baseInput);
  const update = createEvidenceBundle(updateInput);

  return createEvidenceBundle({
    ...base,
    ...update,
    changedFiles: sortStrings([...base.changedFiles, ...update.changedFiles]),
    outputAttempts: mergeByKey(base.outputAttempts, update.outputAttempts, outputAttemptKey),
    buildResults: mergeByKey(base.buildResults, update.buildResults, commandKey),
    testResults: mergeByKey(base.testResults, update.testResults, commandKey),
    lintResults: mergeByKey(base.lintResults, update.lintResults, commandKey),
    findings: mergeByKey(base.findings, update.findings, findingKey),
    review: mergeReview(base.review, update.review),
    verification: {
      ...base.verification,
      ...update.verification,
    },
    docs: mergeDocs(base.docs, update.docs),
    updatedAt: update.updatedAt ?? base.updatedAt,
  });
}

export function updateEvidenceBundle(
  base: EvidenceBundleInput,
  update: EvidenceBundleInput,
): EvidenceBundle {
  return mergeEvidenceBundles(base, update);
}
