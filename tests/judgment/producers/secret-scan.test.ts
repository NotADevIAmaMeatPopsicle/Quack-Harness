// ─── Producer C tests (TASK-1312) ───────────────────────────────────
// Every secret below is SYNTHETIC (constructed inline; never a real
// credential shape from any live system).

import { scanForSecrets } from "../../../src/judgment/producers/secret-scan";

const FAKE_PEM = [
  "-----BEGIN RSA PRIVATE KEY-----",
  "MIIFakeBodyLine1AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
  "MIIFakeBodyLine2AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
  "-----END RSA PRIVATE KEY-----",
].join("\n");

const FAKE_GHP = "ghp_" + "Ab1".repeat(12); // 36-char body

describe("scanForSecrets — safety tier (complete-format only)", () => {
  it("detects a full PEM private key block", () => {
    const summary = scanForSecrets([{ file: "src/config.ts", content: FAKE_PEM }]);
    expect(summary.safetyCount).toBe(1);
    expect(summary.findings[0].patternId).toBe("pem_private_key");
    expect(summary.findings[0].candidateSafetyCode).toBe("secret_exposure");
  });

  it("PEM header WITHOUT body/footer is not safety-tier", () => {
    const summary = scanForSecrets([
      { file: "src/x.ts", content: "-----BEGIN RSA PRIVATE KEY-----" },
    ]);
    expect(summary.safetyCount).toBe(0);
  });

  it("detects a full-format github token", () => {
    const summary = scanForSecrets([
      { file: "src/client.ts", content: `const t = "${FAKE_GHP}";` },
    ]);
    expect(summary.safetyCount).toBe(1);
    expect(summary.findings[0].patternId).toBe("github_token");
  });

  it("detects slack tokens", () => {
    const summary = scanForSecrets([
      { file: "src/s.ts", content: "token: xoxb-1234567890-abcdefghij" },
    ]);
    expect(summary.safetyCount).toBe(1);
  });

  it("round-2: slack-shaped text without numeric structure is NOT safety", () => {
    const summary = scanForSecrets([{ file: "src/s.ts", content: "token: xoxb-not-a-real-token" }]);
    expect(summary.safetyCount).toBe(0);
  });

  it("round-2: PEM with MISMATCHED labels is not safety-tier", () => {
    const mismatched = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "MIIFakeBodyLine1AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
      "MIIFakeBodyLine2AAAABBBBCCCCDDDDEEEEFFFFGGGGHHHH",
      "-----END EC PRIVATE KEY-----",
    ].join("\n");
    const summary = scanForSecrets([{ file: "src/x.ts", content: mismatched }]);
    expect(summary.findings.filter((f) => f.patternId === "pem_private_key")).toHaveLength(0);
  });

  it("round-2: AWS pairing requires proximity (within 10 lines)", () => {
    const syntheticSecret = "A1b2C3d4".repeat(5);
    const farApart = [
      "aws_access_key_id = AKIA" + "ABCDEFGHIJKLMNOP",
      ...Array.from({ length: 20 }, (_, i) => `// filler line ${i}`),
      `aws_secret_access_key = ${syntheticSecret}`,
    ].join("\n");
    const summary = scanForSecrets([{ file: "deploy/creds.ini", content: farApart }]);
    const secretFinding = summary.findings.find((f) => f.patternId === "aws_secret_assignment");
    expect(secretFinding?.tier).toBe("human_review");
  });
});

describe("scanForSecrets — human_review tier", () => {
  it("an AWS access-key id ALONE is an identifier, not a secret", () => {
    const summary = scanForSecrets([
      { file: "src/aws.ts", content: "const keyId = 'AKIA" + "ABCDEFGHIJKLMNOP';" },
    ]);
    expect(summary.safetyCount).toBe(0);
    expect(summary.humanReviewCount).toBe(1);
    expect(summary.findings[0].patternId).toBe("aws_access_key_id");
  });

  it("key id + plausible secret assignment in the same content promotes the pair", () => {
    // 40-char mixed-class synthetic secret, no placeholder markers.
    const syntheticSecret = "A1b2C3d4".repeat(5);
    const content = [
      "aws_access_key_id = AKIA" + "ABCDEFGHIJKLMNOP",
      `aws_secret_access_key = ${syntheticSecret}`,
    ].join("\n");
    const summary = scanForSecrets([{ file: "deploy/creds.ini", content }]);
    const secretFinding = summary.findings.find((f) => f.patternId === "aws_secret_assignment");
    expect(secretFinding?.tier).toBe("safety");
  });

  it("JWT-shaped strings stay human_review", () => {
    const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.abcdefghijklmnop";
    const summary = scanForSecrets([{ file: "src/j.ts", content: jwt }]);
    expect(summary.safetyCount).toBe(0);
    expect(summary.humanReviewCount).toBeGreaterThanOrEqual(1);
  });

  it("credential assignments stay human_review", () => {
    const summary = scanForSecrets([{ file: "src/c.ts", content: `password = "hunter2hunter2"` }]);
    expect(summary.humanReviewCount).toBeGreaterThanOrEqual(1);
    expect(summary.safetyCount).toBe(0);
  });

  it("40-hex git SHAs do NOT trigger the entropy heuristic", () => {
    const summary = scanForSecrets([
      {
        file: "docs/x.md",
        content: "merged at 84dfa41961dcd39fabf4311c1907a5eda5f139f1 yesterday",
      },
    ]);
    expect(summary.findings).toHaveLength(0);
  });
});

describe("scanForSecrets — demotions", () => {
  it("placeholder-looking safety matches demote to human_review", () => {
    const pem = FAKE_PEM.replace("MIIFakeBodyLine1", "REDACTED-EXAMPLE-");
    const summary = scanForSecrets([{ file: "docs/example.md", content: pem }]);
    expect(summary.safetyCount).toBe(0);
    expect(summary.findings[0].demotedBy).toBe("placeholder");
  });

  it("fixture-path hits demote but stay VISIBLE", () => {
    const summary = scanForSecrets([
      { file: "tests/fixtures/token.ts", content: `const t = "${FAKE_GHP}";` },
    ]);
    expect(summary.safetyCount).toBe(0);
    expect(summary.humanReviewCount).toBe(1);
    expect(summary.findings[0].demotedBy).toBe("fixture_path");
  });

  it(".test. files count as fixture paths", () => {
    const summary = scanForSecrets([
      { file: "src/auth.test.ts", content: `const t = "${FAKE_GHP}";` },
    ]);
    expect(summary.findings[0].demotedBy).toBe("fixture_path");
  });
});

describe("scanForSecrets — masking invariant (no raw match ever escapes)", () => {
  it("findings carry masked excerpts only", () => {
    const summary = scanForSecrets([{ file: "src/a.ts", content: `${FAKE_GHP}\n${FAKE_PEM}` }]);
    const serialized = JSON.stringify(summary);
    expect(serialized).not.toContain(FAKE_GHP);
    expect(serialized).not.toContain("MIIFakeBodyLine1");
    for (const finding of summary.findings) {
      expect(finding.maskedExcerpt).toMatch(/^.{4}…\(\d+ chars\)$/);
    }
  });
});

describe("scanForSecrets — line attribution", () => {
  it("reports the 1-based line of the match", () => {
    const summary = scanForSecrets([{ file: "src/a.ts", content: `line1\nline2\n${FAKE_GHP}` }]);
    expect(summary.findings[0].line).toBe(3);
  });
});
