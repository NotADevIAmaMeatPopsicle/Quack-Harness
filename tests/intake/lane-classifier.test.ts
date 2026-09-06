import { classifyIntakeLane } from "../../src/intake/lane-classifier";

describe("classifyIntakeLane", () => {
  it("routes manual and infrastructure indicators to human_required", () => {
    const result = classifyIntakeLane({
      title: "Deploy systemd listener on production host",
      description: "Requires ssh and service restart.",
      tags: ["infrastructure"],
      files: ["ops/quack-monitor.service"],
      priority: "P1-HIGH",
    });

    expect(result.lane).toBe("human_required");
    expect(result.riskLevel).toBe("high");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["infrastructure_tag", "deploy_or_operations"]),
    );
  });

  it("routes docs-only work to low-risk auto", () => {
    const result = classifyIntakeLane({
      title: "Update workflow docs",
      description: "Document the new projection API.",
      tags: ["docs"],
      files: ["docs/API_REFERENCE.md"],
      priority: "P3-LOW",
    });

    expect(result).toEqual({
      lane: "auto",
      riskLevel: "low",
      reasons: ["docs_only"],
    });
  });

  it("routes risky code changes to guarded_auto with deterministic reasons", () => {
    const result = classifyIntakeLane({
      title: "Add auth authorization checks",
      description: "Touches OAuth permissions and database schema.",
      tags: ["security"],
      files: ["src/auth/token-store.ts", "migrations/20260426-auth.sql"],
      priority: "P1-HIGH",
    });

    expect(result.lane).toBe("guarded_auto");
    expect(result.riskLevel).toBe("high");
    expect(result.reasons).toEqual(["security_sensitive", "data_or_migration", "complex_change"]);
  });

  it("routes scoped token verification to guarded automation instead of manual", () => {
    const result = classifyIntakeLane({
      title: "Mint a example-scoped token for waitlist verification",
      description: "Use auth to create a short-lived token for a dev database protocol.",
      tags: ["verification", "backend"],
      files: ["src/src/routes/waitlist.routes.js"],
      priority: "P1-HIGH",
    });

    expect(result.lane).toBe("guarded_auto");
    expect(result.riskLevel).toBe("high");
    expect(result.reasons).toEqual(
      expect.arrayContaining(["security_sensitive", "data_or_migration"]),
    );
  });

  it("always emits at least one reason for sparse code requests", () => {
    const result = classifyIntakeLane({
      title: "Fix button alignment",
      description: "Small frontend polish.",
      files: ["src/ui/button.tsx"],
    });

    expect(result.lane).toBe("guarded_auto");
    expect(result.riskLevel).toBe("medium");
    expect(result.reasons).toEqual(["guarded_code_change"]);
  });
});
