import * as fs from "node:fs";
import * as http from "node:http";
import * as os from "node:os";
import * as path from "node:path";

import { QuackDB } from "../../src/db";
import { createMonitorServer } from "../../src/monitor/server";
import { computeContentHash } from "../../src/monitor/prep-cache";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));

interface HttpResult {
  status: number;
  body: string;
}

function makeTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), "quack-enrichment-candidate-"));
}

function removeTempDir(dir: string): void {
  fs.rmSync(dir, { recursive: true, force: true, maxRetries: 20, retryDelay: 100 });
}

function request(method: string, url: string, body?: unknown): Promise<HttpResult> {
  const payload = body === undefined ? undefined : JSON.stringify(body);
  return new Promise((resolve, reject) => {
    const req = http.request(
      url,
      {
        method,
        headers: payload
          ? {
              "Content-Type": "application/json",
              "Content-Length": Buffer.byteLength(payload),
            }
          : undefined,
      },
      (res) => {
        let text = "";
        res.setEncoding("utf8");
        res.on("data", (chunk) => {
          text += chunk;
        });
        res.on("end", () => {
          resolve({ status: res.statusCode ?? 0, body: text });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

interface TaskContentOptions {
  currentState?: string;
  recommendedApproach?: string;
  files?: Array<{ file: string; action: string; notes: string }>;
  successCriteria?: string[];
  testingRequirements?: string[];
  extraSections?: string;
}

function taskContent(options: TaskContentOptions = {}): string {
  const files = options.files ?? [
    { file: "src/monitor/server.ts", action: "Modify", notes: "Add candidate route." },
  ];
  const successCriteria = options.successCriteria ?? ["Candidate route exists."];
  const testingRequirements = options.testingRequirements ?? [
    "API test covers the candidate route.",
  ];
  const currentState = options.currentState ?? "The current packet is intentionally thin.";
  const recommendedApproach =
    options.recommendedApproach ?? "Add a headnode API and deterministic safety gate.";

  return `# TASK-921-B: Enrichment Candidate Test

## Metadata
- **Priority:** P0-CRITICAL
- **Effort:** 2-4 hours
- **Status:** READY
- **Blocked By:** [TASK-921-A]
- **Blocks:** []
- **Tags:** [enrichment, worker]

## Problem Statement

Workers need a canonical way to submit materially better task specs.

## Current State

${currentState}

## Recommended Approach

${recommendedApproach}

## Files to Modify

| File | Action | Notes |
|---|---|---|
${files.map((file) => `| ${file.file} | ${file.action} | ${file.notes} |`).join("\n")}

## Success Criteria

${successCriteria.map((criterion) => `- [ ] ${criterion}`).join("\n")}

## Testing Requirements

- ${testingRequirements.map((requirement) => `[ ] ${requirement}`).join("\n- ")}

${options.extraSections ?? ""}
`;
}

function betterTaskContent(): string {
  return taskContent({
    currentState:
      "The current packet is intentionally thin and does not describe provenance, stale-hash conflicts, or cache invalidation.",
    recommendedApproach:
      "Add a headnode-only API, parse current and candidate packets structurally, persist readiness provenance, invalidate stale prep state, and keep the canonical write on Headnode.",
    files: [
      {
        file: "src/monitor/server.ts",
        action: "Modify",
        notes: "Add candidate route and write guard.",
      },
      {
        file: "src/monitor/readiness-service.ts",
        action: "Modify",
        notes: "Persist candidate provenance.",
      },
      {
        file: "tests/monitor/enrichment-candidates-api.test.ts",
        action: "Create",
        notes: "Cover accept/reject/dry-run paths.",
      },
    ],
    successCriteria: [
      "Candidate route exists.",
      "Accepted candidates preserve original success criteria.",
      "Accepted candidates record readiness provenance.",
    ],
    testingRequirements: [
      "API test covers the candidate route.",
      "API test rejects weaker verification.",
      "API test rejects stale base hashes.",
    ],
    extraSections: `## Additional Detail

The endpoint must preserve existing blockers and verification while adding
structured evidence for the material-better decision.
`,
  });
}

function weakerTaskContent(): string {
  return taskContent({
    testingRequirements: ["Manual glance only."],
  });
}

describe("external enrichment candidate intake", () => {
  let stopServer: (() => Promise<void>) | undefined;
  const tempDirs: string[] = [];

  async function startProject(initialContent = taskContent()): Promise<{
    baseUrl: string;
    projectRoot: string;
    taskPath: string;
  }> {
    const projectRoot = makeTempDir();
    const quackRoot = makeTempDir();
    tempDirs.push(projectRoot, quackRoot);
    fs.mkdirSync(path.join(projectRoot, ".quack"), { recursive: true });
    const taskDir = path.join(projectRoot, "docs", "tasks");
    fs.mkdirSync(taskDir, { recursive: true });
    const taskPath = path.join(taskDir, "TASK-921-B-enrichment-candidate-test.md");
    fs.writeFileSync(taskPath, initialContent, "utf-8");

    const server = createMonitorServer({
      port: 0,
      host: "127.0.0.1",
      quackRoot,
      projectRoot,
      taskDir,
    });
    const started = await server.start();
    stopServer = started.stop;
    return { baseUrl: `http://127.0.0.1:${started.port}`, projectRoot, taskPath };
  }

  afterEach(async () => {
    try {
      if (stopServer) {
        await stopServer();
      }
    } finally {
      stopServer = undefined;
      for (const tempDir of tempDirs.splice(0)) removeTempDir(tempDir);
    }
  });

  it("accepts a materially better candidate and records an accepted effective spec", async () => {
    const initial = taskContent();
    const { baseUrl, projectRoot, taskPath } = await startProject(initial);

    const response = await request("POST", `${baseUrl}/v1/tasks/TASK-921-B/enrichment-candidates`, {
      source: "worker",
      hostId: "contributor-laptop",
      branchName: "quack/TASK-921-B",
      baseSpecHash: computeContentHash(initial),
      candidateContent: betterTaskContent(),
      summary: "Adds missing persistence details and verification coverage.",
      evidence: [
        { kind: "analysis", summary: "Original packet lacked candidate rejection coverage." },
      ],
      applyMode: "accept-if-better",
    });
    const body = JSON.parse(response.body) as {
      decision: { accepted: boolean; reasons: string[] };
      applied: boolean;
      baseSpecHash: string;
      effectiveSpecHash: string;
    };

    expect(response.status).toBe(200);
    expect(body.decision.accepted).toBe(true);
    expect(body.applied).toBe(true);
    expect(fs.readFileSync(taskPath, "utf-8")).toContain(
      "Accepted candidates record readiness provenance",
    );

    const db = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    try {
      const rows = db.listEffectiveSpecs("TASK-921-B");
      expect(rows[0]).toMatchObject({
        base_spec_hash: body.baseSpecHash,
        effective_spec_hash: body.effectiveSpecHash,
        status: "accepted",
        source: "external_enrichment_candidate:worker",
      });
    } finally {
      db.close();
    }
  });

  it("rejects a candidate that weakens required verification", async () => {
    const initial = taskContent();
    const { baseUrl, taskPath } = await startProject(initial);

    const response = await request("POST", `${baseUrl}/v1/tasks/TASK-921-B/enrichment-candidates`, {
      source: "hermes",
      baseSpecHash: computeContentHash(initial),
      candidateContent: weakerTaskContent(),
      summary: "Weakens testing.",
      applyMode: "accept-if-better",
    });
    const body = JSON.parse(response.body) as {
      decision: { accepted: boolean; blockers: string[] };
      applied: boolean;
    };

    expect(response.status).toBe(422);
    expect(body.decision.accepted).toBe(false);
    expect(body.decision.blockers).toContain("deleted_testing_requirement");
    expect(body.applied).toBe(false);
    expect(fs.readFileSync(taskPath, "utf-8")).toBe(initial);
  });

  it("returns a structured conflict for stale base spec hashes", async () => {
    const { baseUrl } = await startProject(taskContent());

    const response = await request("POST", `${baseUrl}/v1/tasks/TASK-921-B/enrichment-candidates`, {
      source: "worker",
      baseSpecHash: "sha256-stale",
      candidateContent: betterTaskContent(),
      summary: "Stale candidate.",
      applyMode: "accept-if-better",
    });
    const body = JSON.parse(response.body) as {
      error: string;
      currentSpecHash: string;
      submittedBaseSpecHash: string;
    };

    expect(response.status).toBe(409);
    expect(body.error).toBe("base_spec_hash_mismatch");
    expect(body.submittedBaseSpecHash).toBe("sha256-stale");
    expect(body.currentSpecHash).not.toBe("sha256-stale");
  });

  it("propose mode stores candidate provenance without applying the task file", async () => {
    const initial = taskContent();
    const { baseUrl, projectRoot, taskPath } = await startProject(initial);

    const response = await request("POST", `${baseUrl}/v1/tasks/TASK-921-B/enrichment-candidates`, {
      source: "hermes",
      hostId: "hermes-local",
      branchName: "echo/TASK-921-B",
      baseSpecHash: computeContentHash(initial),
      candidateContent: betterTaskContent(),
      summary: "Store for admin review.",
      applyMode: "propose",
    });
    const body = JSON.parse(response.body) as {
      decision: { accepted: boolean };
      applied: boolean;
      persisted: boolean;
      effectiveSpecHash: string;
    };

    expect(response.status).toBe(200);
    expect(body.decision.accepted).toBe(true);
    expect(body.persisted).toBe(true);
    expect(body.applied).toBe(false);
    expect(fs.readFileSync(taskPath, "utf-8")).toBe(initial);

    const db = new QuackDB(path.join(projectRoot, ".quack", "quack.db"));
    try {
      const rows = db.listEffectiveSpecs("TASK-921-B");
      expect(rows[0]).toMatchObject({
        effective_spec_hash: body.effectiveSpecHash,
        status: "proposed",
        source: "external_enrichment_candidate:hermes",
      });
    } finally {
      db.close();
    }
  });

  it("dry-run scores the candidate without writing", async () => {
    const initial = taskContent();
    const { baseUrl, taskPath } = await startProject(initial);

    const response = await request("POST", `${baseUrl}/v1/tasks/TASK-921-B/enrichment-candidates`, {
      source: "admin",
      baseSpecHash: computeContentHash(initial),
      candidateContent: betterTaskContent(),
      summary: "Preview only.",
      applyMode: "dry-run",
    });
    const body = JSON.parse(response.body) as {
      decision: { accepted: boolean };
      applied: boolean;
      persisted: boolean;
    };

    expect(response.status).toBe(200);
    expect(body.decision.accepted).toBe(true);
    expect(body.applied).toBe(false);
    expect(body.persisted).toBe(false);
    expect(fs.readFileSync(taskPath, "utf-8")).toBe(initial);
  });
});
