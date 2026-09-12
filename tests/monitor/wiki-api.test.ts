import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";
import { execFileSync } from "node:child_process";

const authState = {
  serviceTokens: [] as Array<{
    id: string;
    tokenHash: string;
    scopes: string[];
    enabled?: boolean;
  }>,
};

jest.mock("../../src/monitor/auth", () => {
  const actual =
    jest.requireActual<typeof import("../../src/monitor/auth")>("../../src/monitor/auth");
  return {
    ...actual,
    initAuthConfig: () => ({
      users: [],
      apiKeys: [],
      serviceTokens: authState.serviceTokens,
      sessionSecret: "test",
      sessionTtlMs: 86400000,
    }),
  };
});

import { hashServiceToken } from "../../src/monitor/auth";
import { createMonitorServer } from "../../src/monitor/server";

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-wiki-api-"));
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, {
    recursive: true,
    force: true,
    maxRetries: 20,
    retryDelay: 100,
  });
}

function runGit(cwd: string, ...args: string[]): string {
  return execFileSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      GIT_TERMINAL_PROMPT: "0",
    },
  }).trim();
}

function initWikiRepo(root: string): { remoteDir: string } {
  const remoteDir = makeTempDir();
  fs.mkdirSync(path.join(root, "wiki", "quack"), { recursive: true });
  fs.mkdirSync(path.join(root, "raw", "platform", "changelog"), { recursive: true });
  fs.mkdirSync(path.join(root, "schema"), { recursive: true });

  fs.writeFileSync(
    path.join(root, "wiki", "index.md"),
    [
      "# Project Wiki",
      "",
      "Master index for Quack and related systems.",
      "",
      "- [[wiki/quack/overview|Quack Overview]]",
      "",
      "## Related Pages",
      "",
      "- [[wiki/quack/overview]]",
      "",
      "*Last updated: 2026-05-04*",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "wiki", "quack", "overview.md"),
    [
      "# Quack Overview",
      "",
      "Runtime summary for the Quack platform and monitor.",
      "",
      "See also [[wiki/index|Wiki Index]].",
      "",
      "## Related Pages",
      "",
      "- [[wiki/index]]",
      "",
      "*Last updated: 2026-05-04*",
      "",
    ].join("\n"),
    "utf8",
  );
  fs.writeFileSync(
    path.join(root, "schema", "rules.md"),
    "# Rules\n\nSchema rules live here.\n",
    "utf8",
  );

  runGit(root, "init");
  runGit(root, "config", "user.name", "Quack Test");
  runGit(root, "config", "user.email", "quack-test@example.com");
  runGit(root, "add", ".");
  runGit(root, "commit", "-m", "Initial wiki import");

  runGit(remoteDir, "init", "--bare");
  runGit(root, "remote", "add", "origin", remoteDir);
  runGit(root, "push", "-u", "origin", "HEAD");

  return { remoteDir };
}

async function httpRequest(
  url: string,
  options: {
    method?: "GET" | "POST";
    headers?: Record<string, string>;
    body?: unknown;
  } = {},
): Promise<{ status: number; body: string; json: unknown }> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? "" : JSON.stringify(options.body);
    const req = http.request(
      url,
      {
        method: options.method ?? "GET",
        headers: {
          Accept: "application/json",
          ...(payload
            ? {
                "Content-Type": "application/json",
                "Content-Length": String(Buffer.byteLength(payload)),
              }
            : {}),
          ...(options.headers ?? {}),
        },
      },
      (res) => {
        let body = "";
        res.on("data", (chunk) => {
          body += String(chunk);
        });
        res.on("end", () => {
          let json: unknown = null;
          try {
            json = JSON.parse(body);
          } catch {
            json = null;
          }
          resolve({
            status: res.statusCode ?? 0,
            body,
            json,
          });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    if (payload) {
      req.write(payload);
    }
    req.end();
  });
}

describe("wiki monitor APIs", () => {
  let logDir: string;
  let wikiRoot: string;
  let remoteDir: string;
  let tempDirs: string[];
  let stopServer: (() => Promise<void>) | undefined;

  beforeEach(() => {
    authState.serviceTokens = [];
    logDir = makeTempDir();
    wikiRoot = makeTempDir();
    ({ remoteDir } = initWikiRepo(wikiRoot));
    tempDirs = [logDir, wikiRoot, remoteDir];
  });

  afterEach(async () => {
    if (stopServer) {
      await stopServer();
      stopServer = undefined;
    }
    authState.serviceTokens = [];
    for (const dir of tempDirs) {
      removeTempDir(dir);
    }
  });

  it("serves wiki status, index, page detail, and search results", async () => {
    const serverObj = createMonitorServer({
      logDir,
      port: 0,
      host: "127.0.0.1",
      wikiRoot,
    });
    const { port, stop } = await serverObj.start();
    stopServer = stop;

    const status = await httpRequest(`http://127.0.0.1:${port}/api/wiki/status`);
    expect(status.status).toBe(200);
    const statusBody = status.json as {
      available: boolean;
      root: string;
      git: { available: boolean; branch: string | null };
      topLevelEntries: string[];
    };
    expect(statusBody.available).toBe(true);
    expect(statusBody.root).toBe(wikiRoot);
    expect(statusBody.git.available).toBe(true);
    expect(statusBody.topLevelEntries).toEqual(expect.arrayContaining(["raw", "schema", "wiki"]));

    const index = await httpRequest(`http://127.0.0.1:${port}/api/wiki/index`);
    expect(index.status).toBe(200);
    const indexBody = index.json as {
      count: number;
      entries: Array<{ path: string; title: string }>;
    };
    expect(indexBody.count).toBeGreaterThanOrEqual(3);
    expect(indexBody.entries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "wiki/index.md", title: "Project Wiki" }),
        expect.objectContaining({ path: "wiki/quack/overview.md", title: "Quack Overview" }),
      ]),
    );

    const page = await httpRequest(
      `http://127.0.0.1:${port}/api/wiki/page?path=${encodeURIComponent("wiki/index.md")}`,
    );
    expect(page.status).toBe(200);
    const pageBody = page.json as {
      title: string;
      summary: string;
      path: string;
      links: Array<{ resolvedPath: string | null }>;
    };
    expect(pageBody.path).toBe("wiki/index.md");
    expect(pageBody.title).toBe("Project Wiki");
    expect(pageBody.summary).toContain("Master index");
    expect(pageBody.links[0]?.resolvedPath).toBe("wiki/quack/overview.md");

    const search = await httpRequest(
      `http://127.0.0.1:${port}/api/wiki/search?q=${encodeURIComponent("monitor")}`,
    );
    expect(search.status).toBe(200);
    const searchBody = search.json as { results: Array<{ path: string; title: string }> };
    expect(searchBody.results).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "wiki/quack/overview.md", title: "Quack Overview" }),
      ]),
    );
  });

  it("creates changelog artifacts, commits them, and refuses a local-path publication remote", async () => {
    const serverObj = createMonitorServer({
      logDir,
      port: 0,
      host: "127.0.0.1",
      wikiRoot,
    });
    const { port, stop } = await serverObj.start();
    stopServer = stop;

    const createArtifact = await httpRequest(
      `http://127.0.0.1:${port}/api/wiki/artifacts/changelog`,
      {
        method: "POST",
        body: {
          taskId: "TASK-999",
          date: "2026-05-04",
          title: "Wiki API rollout",
          summary: "Quack now exposes a monitor-owned wiki API.",
          whatChanged: [
            "Added read, search, and write routes for project-wiki.",
            "Added git commit and push helpers for remote agent workflows.",
          ],
          verification: ["Targeted monitor wiki API tests: PASS"],
        },
      },
    );
    expect(createArtifact.status).toBe(201);
    const artifactBody = createArtifact.json as {
      path: string;
      reviewArtifact?: { action: string; pagePath: string };
    };
    expect(artifactBody.path).toBe("raw/platform/changelog/2026-05-04-task-999.md");
    expect(artifactBody.reviewArtifact).toEqual(
      expect.objectContaining({
        action: "changelog_entry",
        pagePath: "raw/platform/changelog/2026-05-04-task-999.md",
      }),
    );

    const gitStatusBefore = await httpRequest(`http://127.0.0.1:${port}/api/wiki/git/status`);
    expect(gitStatusBefore.status).toBe(200);
    const gitBeforeBody = gitStatusBefore.json as {
      dirty: boolean;
      changedFiles: Array<{ path: string }>;
    };
    expect(gitBeforeBody.dirty).toBe(true);
    expect(gitBeforeBody.changedFiles).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ path: "raw/platform/changelog/2026-05-04-task-999.md" }),
      ]),
    );

    const commit = await httpRequest(`http://127.0.0.1:${port}/api/wiki/git/commit`, {
      method: "POST",
      body: {
        all: true,
        message: "wiki: add TASK-999 changelog",
      },
    });
    expect(commit.status).toBe(200);

    const push = await httpRequest(`http://127.0.0.1:${port}/api/wiki/git/push`, {
      method: "POST",
      body: {},
    });
    expect(push.status).toBe(409);
    expect((push.json as { error: string }).error).toContain(
      "Wiki publication requires a GitHub network origin",
    );

    const hostileRemote = await httpRequest(`http://127.0.0.1:${port}/api/wiki/git/push`, {
      method: "POST",
      body: { remote: "attacker" },
    });
    expect(hostileRemote.status).toBe(400);

    const localHead = runGit(wikiRoot, "rev-parse", "HEAD");
    const branch = runGit(wikiRoot, "branch", "--show-current");
    const remoteHead = runGit(wikiRoot, "rev-parse", `origin/${branch}`);
    expect(localHead).toBeTruthy();
    expect(remoteHead).not.toBe(localHead);
  });

  it("creates bug report artifacts in the raw bug-report stream", async () => {
    const serverObj = createMonitorServer({
      logDir,
      port: 0,
      host: "127.0.0.1",
      wikiRoot,
    });
    const { port, stop } = await serverObj.start();
    stopServer = stop;

    const createArtifact = await httpRequest(
      `http://127.0.0.1:${port}/api/wiki/artifacts/bug-report`,
      {
        method: "POST",
        body: {
          date: "2026-05-04",
          slug: "qpi-009-judge-retry-crash",
          title: "Judge retry crash leaves dispatch stuck",
          summary: "Judge subprocess exits with code 1 after retry and blocks the dispatch lane.",
          severity: "high",
          status: "open",
          taskId: "TASK-915",
          linkedTasks: ["TASK-915"],
          reproduction: [
            "Queue TASK-915 on Headnode.",
            "Observe the judge subprocess exit after the retry path starts.",
          ],
          nextSteps: [
            "Classify retryable judge failures.",
            "Surface the failure class in monitoring.",
          ],
        },
      },
    );
    expect(createArtifact.status).toBe(201);
    const artifactBody = createArtifact.json as {
      path: string;
      artifactType: string;
    };
    expect(artifactBody.path).toBe(
      "raw/platform/bug-reports/2026-05-04-qpi-009-judge-retry-crash.md",
    );
    expect(artifactBody.artifactType).toBe("bug-report");

    const artifactText = fs.readFileSync(path.join(wikiRoot, artifactBody.path), "utf8");
    expect(artifactText).toContain("kind: bug-report");
    expect(artifactText).toContain("severity: high");
    expect(artifactText).toContain("## Reproduction");
    expect(artifactText).toContain("TASK-915");
  });

  it("enforces service-token scopes on the shared /v1/wiki endpoints", async () => {
    authState.serviceTokens = [
      {
        id: "wiki-reader",
        tokenHash: hashServiceToken("wiki-reader-token"),
        scopes: ["wiki:read"],
        enabled: true,
      },
    ];

    const serverObj = createMonitorServer({
      logDir,
      port: 0,
      host: "127.0.0.1",
      wikiRoot,
    });
    const { port, stop } = await serverObj.start();
    stopServer = stop;

    const noToken = await httpRequest(`http://127.0.0.1:${port}/v1/wiki/status`);
    expect(noToken.status).toBe(401);

    const withReadToken = await httpRequest(`http://127.0.0.1:${port}/v1/wiki/status`, {
      headers: {
        "X-Quack-Service-Token": "wiki-reader-token",
      },
    });
    expect(withReadToken.status).toBe(200);

    const writeDenied = await httpRequest(`http://127.0.0.1:${port}/v1/wiki/page`, {
      method: "POST",
      headers: {
        "X-Quack-Service-Token": "wiki-reader-token",
      },
      body: {
        path: "raw/platform/changelog/2026-05-04-task-1000.md",
        content: "# denied\n",
      },
    });
    expect(writeDenied.status).toBe(403);
  });
});
