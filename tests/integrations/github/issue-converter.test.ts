// ─── Issue Converter Tests ──────────────────────────────────────────

import { buildPlannerPrompt } from "../../../src/integrations/github/issue-converter";
import type { GitHubIssue } from "../../../src/integrations/github/github-types";

describe("Issue Converter", () => {
  it("should build planner prompt from issue with all fields", () => {
    const issue: GitHubIssue = {
      number: 42,
      title: "Add feature",
      body: "Detailed description",
      labels: ["enhancement", "priority-high"],
      assignees: ["dev1"],
      comments: [{ author: "reviewer", body: "Good idea", createdAt: "2024-01-01T00:00:00Z" }],
      referencedFiles: ["src/app.ts", "src/utils.ts"],
      linkedPRs: [],
      state: "open",
      url: "https://github.com/owner/repo/issues/42",
    };

    const prompt = buildPlannerPrompt(issue);

    expect(prompt).toContain("GitHub Issue #42");
    expect(prompt).toContain("Add feature");
    expect(prompt).toContain("Detailed description");
    expect(prompt).toContain("enhancement");
    expect(prompt).toContain("@dev1");
    expect(prompt).toContain("@reviewer");
    expect(prompt).toContain("Good idea");
    expect(prompt).toContain("`src/app.ts`");
    expect(prompt).toContain("https://github.com/owner/repo/issues/42");
  });

  it("should handle issue with no optional fields", () => {
    const issue: GitHubIssue = {
      number: 1,
      title: "Minimal issue",
      body: "",
      labels: [],
      assignees: [],
      comments: [],
      referencedFiles: [],
      linkedPRs: [],
      state: "open",
      url: "https://github.com/owner/repo/issues/1",
    };

    const prompt = buildPlannerPrompt(issue);

    expect(prompt).toContain("GitHub Issue #1");
    expect(prompt).toContain("Minimal issue");
    expect(prompt).not.toContain("## Labels");
    expect(prompt).not.toContain("## Assignees");
    expect(prompt).not.toContain("## Discussion");
  });

  it("should extract file references from body and comments", () => {
    const issue: GitHubIssue = {
      number: 2,
      title: "Fix bug",
      body: "Check `lib/parser.ts` for the issue",
      labels: [],
      assignees: [],
      comments: [{ author: "dev", body: "Also see `lib/lexer.ts`", createdAt: "2024-01-01" }],
      referencedFiles: ["lib/parser.ts", "lib/lexer.ts"],
      linkedPRs: [],
      state: "open",
      url: "https://github.com/owner/repo/issues/2",
    };

    const prompt = buildPlannerPrompt(issue);

    expect(prompt).toContain("`lib/parser.ts`");
    expect(prompt).toContain("`lib/lexer.ts`");
  });
});
