import { assessContributorIntake } from "../../src/intake/contributor-assessment";
import { classifyIntakeLane } from "../../src/intake/lane-classifier";
import { remoteTaskIntakeSchema, toClassificationInput } from "../../src/intake/task-intake";

function assess(payload: unknown) {
  const parsed = remoteTaskIntakeSchema.parse(payload);
  const classification = classifyIntakeLane(toClassificationInput(parsed));
  return assessContributorIntake(parsed, classification);
}

describe("assessContributorIntake", () => {
  it("marks detailed live-data verification payloads ready and infers capabilities", () => {
    const assessment = assess({
      taskId: "TASK-953",
      title: "Waitlist live-data match protocol",
      description: [
        "Run the waitlist live-data protocol against a reachable dev/staging database.",
        "Boot the backend with valid DB env, mint a example-scoped token, seed one waitlist entry,",
        "call matches and near-misses endpoints, then deliberately break provider eligibility.",
      ].join(" "),
      source: "contributor-claude-code",
      requestedBy: "contributor",
      priority: "P1-HIGH",
      tags: ["verification", "backend", "database", "waitlist"],
      files: ["src/src/routes/waitlist.routes.js", "src/src/services/waitlist.service.js"],
      metadata: {
        successCriteria: [
          "Match evidence includes real gap/provider/duration/service gates.",
          "Near-miss evidence explains deliberately broken provider or duration eligibility.",
        ],
        testingRequirements: [
          "GET /api/waitlist/matches?days=7",
          "GET /api/waitlist/near-misses?days=7",
        ],
        evidenceProtocol: [
          "Seed one appointment waitlist entry.",
          "Clean up seeded rows after verification.",
        ],
        requiredCapabilities: ["backend", "staging-db"],
      },
    });

    expect(assessment.qualityGate).toMatchObject({
      ready: true,
      status: "ready_for_intake",
      score: 5,
    });
    expect(assessment.recommendedCapabilities).toEqual(
      expect.arrayContaining(["backend", "staging-db", "database", "auth"]),
    );
    expect(assessment.suggestedFederationJob).toMatchObject({
      jobType: "verify",
      preferredHostId: "headnode",
    });
  });

  it("flags sparse contributor requests for enrichment before intake", () => {
    const assessment = assess({
      title: "Fix waitlist",
      description: "Make the waitlist better.",
      source: "contributor-claude-code",
    });

    expect(assessment.qualityGate.ready).toBe(false);
    expect(assessment.qualityGate.status).toBe("needs_enrichment");
    expect(assessment.missingFields).toEqual(
      expect.arrayContaining([
        "taskId",
        "files",
        "tags",
        "metadata.successCriteria",
        "metadata.testingRequirements",
      ]),
    );
  });
});
