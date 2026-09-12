import * as path from "node:path";

type ResolveRepository =
  typeof import("../../../src/worker/trusted-executable").resolveTrustedGitHubRepository;
type RunGitHub = typeof import("../../../src/worker/trusted-executable").runTrustedGitHubResult;

const mockResolveRepository = jest.fn<
  ReturnType<ResolveRepository>,
  Parameters<ResolveRepository>
>();
const mockRunGitHub = jest.fn<ReturnType<RunGitHub>, Parameters<RunGitHub>>();

jest.mock("../../../src/worker/trusted-executable", () => ({
  resolveTrustedGitHubRepository: (...args: Parameters<ResolveRepository>) =>
    mockResolveRepository(...args),
  runTrustedGitHubResult: (...args: Parameters<RunGitHub>) => mockRunGitHub(...args),
}));

import {
  assertIssueCommentUrl,
  assertIssueUrl,
  runBoundGitHubCommand,
} from "../../../src/integrations/github/trusted-github";

const REPOSITORY = { host: "github.com", owner: "Org", repo: "Repo" };

describe("trusted GitHub integration boundary", () => {
  beforeEach(() => {
    mockResolveRepository.mockReset().mockResolvedValue(REPOSITORY);
    mockRunGitHub.mockReset().mockResolvedValue({ exitCode: 0, stdout: "ok", stderr: "" });
  });

  it("audits adapter identity, binds the exact repository, and preserves stdin", async () => {
    const inputRoot = path.join("fixture", "project");
    const canonicalRoot = path.resolve(inputRoot);

    await expect(
      runBoundGitHubCommand(
        inputRoot,
        { owner: "Org", repo: "Repo" },
        ["issue", "create", "--body-file", "-"],
        { input: "trusted body", timeoutMs: 1234, maxBuffer: 5678 },
      ),
    ).resolves.toMatchObject({ repository: REPOSITORY, stdout: "ok" });

    expect(mockResolveRepository).toHaveBeenCalledWith(canonicalRoot, {
      timeoutMs: 1234,
      maxBuffer: 5678,
      trustedBoundaryRoot: canonicalRoot,
      expectedRepository: { owner: "Org", repo: "Repo" },
    });
    expect(mockRunGitHub).toHaveBeenCalledWith(
      canonicalRoot,
      ["issue", "create", "--body-file", "-"],
      {
        timeoutMs: 1234,
        maxBuffer: 5678,
        trustedBoundaryRoot: canonicalRoot,
        expectedRepository: REPOSITORY,
        input: "trusted body",
      },
    );
  });

  it("turns a nonzero trusted runner result into a fail-closed error", async () => {
    mockRunGitHub.mockResolvedValueOnce({ exitCode: 1, stdout: "", stderr: "denied" });

    await expect(
      runBoundGitHubCommand(path.resolve("fixture", "project"), { owner: "Org", repo: "Repo" }, [
        "issue",
        "view",
        "1",
      ]),
    ).rejects.toThrow("denied");
  });

  it("rejects issue and comment URLs outside the audited identity", () => {
    expect(() =>
      assertIssueUrl("https://github.com/attacker/Repo/issues/42", REPOSITORY, 42),
    ).toThrow("does not match github.com/Org/Repo#42");
    expect(() =>
      assertIssueCommentUrl(
        "https://github.com/Org/Repo/issues/42#issuecomment-not-a-number",
        REPOSITORY,
        42,
      ),
    ).toThrow("valid issue comment URL");
  });

  it("accepts issue URLs on an audited GitHub Enterprise HTTPS port", () => {
    const repository = { host: "ghe.example.test:8443", owner: "Org", repo: "Repo" };

    expect(assertIssueUrl("https://ghe.example.test:8443/Org/Repo/issues/42", repository, 42)).toBe(
      "https://ghe.example.test:8443/Org/Repo/issues/42",
    );
    expect(() =>
      assertIssueUrl("https://ghe.example.test:9443/Org/Repo/issues/42", repository, 42),
    ).toThrow("does not match");
  });
});
