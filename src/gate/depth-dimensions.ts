import { DepthScores, TaskType } from "../core/types.js";

export interface DepthDimensionDefinition {
  rawKey: string;
  resultKey: keyof DepthScores & string;
  label: string;
  rubric: {
    low: string;
    medium: string;
    high: string;
  };
  optional?: boolean;
  fallbackRawKey?: string;
}

export interface TaskTypeDepthConfig {
  taskType: TaskType;
  threshold: number;
  title: string;
  dimensions: DepthDimensionDefinition[];
}

const CODE_DIMENSIONS: DepthDimensionDefinition[] = [
  {
    rawKey: "clarity",
    resultKey: "clarity",
    label: "Problem Clarity",
    rubric: {
      low: '1: Vague ("improve the system")',
      medium: '3: Directional ("add validation to the form fields")',
      high: '5: Precise ("add email format validation to the registration form\'s email field, returning 422 with field-level error on invalid input")',
    },
  },
  {
    rawKey: "scope",
    resultKey: "scope",
    label: "Scope Boundedness",
    rubric: {
      low: '1: Unbounded ("make it better")',
      medium: '3: Roughly bounded ("update the appointment module")',
      high: "5: Precisely bounded (explicit file list + success criteria checklist)",
    },
  },
  {
    rawKey: "testability",
    resultKey: "testability",
    label: "Testability",
    rubric: {
      low: '1: No test criteria ("code should be clean")',
      medium: '3: General test criteria ("all tests pass")',
      high: '5: Specific test criteria ("new unit test for validateEmail(), existing auth tests still pass")',
    },
  },
  {
    rawKey: "conventions",
    resultKey: "conventions",
    label: "Convention Anchoring",
    rubric: {
      low: "1: No references",
      medium: '3: General references ("follow existing patterns")',
      high: '5: Specific references ("follows ADR-012, see src/controllers/auth.controller.js for pattern")',
    },
  },
  {
    rawKey: "implementation_specificity",
    resultKey: "implementationSpecificity",
    label: "Implementation Specificity",
    rubric: {
      low: '1: No file references ("add a feature")',
      medium: '3: File list only ("modify src/server.ts, src/types.ts")',
      high: "5: Code-level detail (file:line references, function signatures, before/after examples, integration points)",
    },
    optional: true,
    fallbackRawKey: "clarity",
  },
  {
    rawKey: "verification_clarity",
    resultKey: "verificationClarity",
    label: "Verification Clarity",
    rubric: {
      low: '1: Prose-only criteria ("proper error handling", "follows best practices")',
      medium: '3: Testable but vague ("all tests pass", "no lint errors")',
      high: '5: Grep-verifiable criteria ("export function validateEmail in src/validators.ts", "test file exists at tests/validators.test.ts")',
    },
    optional: true,
    fallbackRawKey: "testability",
  },
  {
    rawKey: "completeness",
    resultKey: "completeness",
    label: "Completeness - Does the task cover ALL layers implied by the spec?",
    rubric: {
      low: "1: Multi-layer work is described but only one layer has success criteria",
      medium: "3: Primary layer is covered but secondary layers are only loosely captured",
      high: "5: Every layer implied by the task has corresponding success criteria and files",
    },
    optional: true,
    fallbackRawKey: "scope",
  },
];

const ARCHITECTURE_DIMENSIONS: DepthDimensionDefinition[] = [
  {
    rawKey: "decision_points",
    resultKey: "decisionPoints",
    label: "Decision Point Clarity",
    rubric: {
      low: "1: The architectural decision is ambiguous or unstated",
      medium: "3: The core decision is described, but important tradeoffs are implicit",
      high: "5: The architectural decision, drivers, and boundaries are explicit",
    },
  },
  {
    rawKey: "alternatives_coverage",
    resultKey: "alternativesCoverage",
    label: "Alternatives Coverage",
    rubric: {
      low: "1: No alternatives or rejected options are discussed",
      medium: "3: Some alternatives are mentioned but comparison criteria are thin",
      high: "5: Viable alternatives are compared with clear tradeoff reasoning",
    },
  },
  {
    rawKey: "adr_template_compliance",
    resultKey: "adrTemplateCompliance",
    label: "ADR Template Compliance",
    rubric: {
      low: "1: Missing required ADR sections or output structure",
      medium: "3: Most ADR structure is present but some required sections are vague",
      high: "5: The requested ADR/design template is complete and mechanically followable",
    },
  },
  {
    rawKey: "cross_reference_completeness",
    resultKey: "crossReferenceCompleteness",
    label: "Cross-Reference Completeness",
    rubric: {
      low: "1: No linked systems, documents, or code references are identified",
      medium: "3: Important references exist but leave material blind spots",
      high: "5: Related ADRs, docs, owners, and code surfaces are clearly referenced",
    },
  },
];

const TEST_DIMENSIONS: DepthDimensionDefinition[] = [
  {
    rawKey: "test_scope_definition",
    resultKey: "testScopeDefinition",
    label: "Test Scope Definition",
    rubric: {
      low: "1: The tests to add or update are ambiguous",
      medium: "3: The rough suite area is clear but exact test intent is thin",
      high: "5: Exact scenarios, suite boundaries, and stop conditions are explicit",
    },
  },
  {
    rawKey: "target_coverage_areas",
    resultKey: "targetCoverageAreas",
    label: "Target Coverage Areas",
    rubric: {
      low: "1: No specific flows, surfaces, or regressions are named",
      medium: "3: Primary coverage areas are named but important gaps remain",
      high: "5: Coverage areas map directly to flows, components, or regressions to prove",
    },
  },
  {
    rawKey: "infrastructure_references",
    resultKey: "infrastructureReferences",
    label: "Test Infrastructure References",
    rubric: {
      low: "1: Required fixtures, helpers, or environments are unstated",
      medium: "3: Some infrastructure is referenced but setup remains partly inferred",
      high: "5: Fixtures, harnesses, commands, and environment requirements are explicit",
    },
  },
  {
    rawKey: "assertion_patterns",
    resultKey: "assertionPatterns",
    label: "Assertion Patterns",
    rubric: {
      low: "1: Expected assertions are vague or purely outcome-based",
      medium: "3: Assertion intent is understandable but not specific enough to verify easily",
      high: "5: Expected assertions, matchers, or evidence checks are clearly described",
    },
  },
];

const DOCUMENTATION_DIMENSIONS: DepthDimensionDefinition[] = [
  {
    rawKey: "scope_definition",
    resultKey: "scopeDefinition",
    label: "Scope Definition",
    rubric: {
      low: "1: The doc change is broad or ambiguous",
      medium: "3: The audience and rough content are clear, but edges remain fuzzy",
      high: "5: The requested document scope, audience, and boundaries are explicit",
    },
  },
  {
    rawKey: "source_material_references",
    resultKey: "sourceMaterialReferences",
    label: "Source Material References",
    rubric: {
      low: "1: No source docs, commands, or implementation references are named",
      medium: "3: Some sources are named but important references are missing",
      high: "5: Canonical references and evidence sources are clearly identified",
    },
  },
  {
    rawKey: "output_format_requirements",
    resultKey: "outputFormatRequirements",
    label: "Output Format Requirements",
    rubric: {
      low: "1: Format or structure expectations are absent",
      medium: "3: The rough output format is known but exact structure is underspecified",
      high: "5: Required sections, formatting, and destination files are explicit",
    },
  },
];

const TASK_TYPE_CONFIGS: Record<TaskType, TaskTypeDepthConfig> = {
  [TaskType.Code]: {
    taskType: TaskType.Code,
    threshold: 4.7,
    title: "code implementation",
    dimensions: CODE_DIMENSIONS,
  },
  [TaskType.Architecture]: {
    taskType: TaskType.Architecture,
    threshold: 3.5,
    title: "architecture / ADR",
    dimensions: ARCHITECTURE_DIMENSIONS,
  },
  [TaskType.Test]: {
    taskType: TaskType.Test,
    threshold: 3.5,
    title: "test implementation",
    dimensions: TEST_DIMENSIONS,
  },
  [TaskType.Documentation]: {
    taskType: TaskType.Documentation,
    threshold: 3.0,
    title: "documentation",
    dimensions: DOCUMENTATION_DIMENSIONS,
  },
};

export function getTaskTypeDepthConfig(taskType: TaskType): TaskTypeDepthConfig {
  return TASK_TYPE_CONFIGS[taskType];
}

export function buildDepthResponseSchema(taskType: TaskType): Record<string, unknown> {
  const config = getTaskTypeDepthConfig(taskType);
  const properties = Object.fromEntries(
    config.dimensions.map((dimension) => [dimension.rawKey, { type: "number" }]),
  );
  const required = config.dimensions
    .filter((dimension) => !dimension.optional)
    .map((dimension) => dimension.rawKey);

  return {
    type: "object",
    properties: {
      ready: { type: "boolean" },
      overall_score: { type: "number" },
      scores: {
        type: "object",
        properties,
        required,
        additionalProperties: false,
      },
      deficiencies: {
        type: "array",
        items: { type: "string" },
      },
      enrichment_suggestions: {
        type: "array",
        items: { type: "string" },
      },
    },
    required: ["ready", "overall_score", "scores", "deficiencies", "enrichment_suggestions"],
    additionalProperties: false,
  };
}

export function buildDepthResponseExample(taskType: TaskType): string {
  const config = getTaskTypeDepthConfig(taskType);
  const scores = Object.fromEntries(config.dimensions.map((dimension) => [dimension.rawKey, "N"]));

  return JSON.stringify(
    {
      ready: true,
      overall_score: "1-5",
      scores,
      deficiencies: ["specific things that are missing or vague"],
      enrichment_suggestions: ["specific improvements that would raise the score"],
    },
    null,
    2,
  );
}

export function createEmptyDepthScores(taskType: TaskType): DepthScores {
  const config = getTaskTypeDepthConfig(taskType);
  const scores: DepthScores = {};

  for (const dimension of config.dimensions) {
    scores[dimension.resultKey] = 0;
  }

  return scores;
}
