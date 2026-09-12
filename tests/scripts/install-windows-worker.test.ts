import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { spawnSync } from "node:child_process";

// The harness substitutes all process/network ownership queries and startup
// registration. Immediate starts/health/listener calls are captured by mocks;
// actual child services, network calls, termination and registry writes are forbidden.
const windowsDescribe = process.platform === "win32" ? describe : describe.skip;
const sourceScript = path.resolve(__dirname, "../../scripts/admin/install-windows-worker.ps1");
const harness = path.resolve(__dirname, "../fixtures/install-windows-worker.ps1");
const roots: string[] = [];

interface FixtureResult {
  error: string | null;
  events: Array<{ taskName: string; execute: string; arguments: string; trigger: string }>;
  launches: Array<{
    filePath: string;
    windowStyle: string;
    arguments: string[];
    commandLine: string;
  }>;
  listenerCalls: string[][];
  healthCalls: string[][];
  importedEnvironments: Array<{
    source: string;
    repoPath: string;
    projectPaths: Record<string, string>;
    capabilityReportPath: string;
  }>;
  parsedWrappers: number;
}

function invoke(
  scenario:
    | "clear"
    | "busy-port"
    | "owned-wrapper"
    | "unscoped-listener"
    | "other-worker"
    | "start",
) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-windows-install-"));
  roots.push(root);
  const repo = path.join(root, "repo's café files");
  const project = path.join(root, "project's résumé files");
  fs.mkdirSync(repo);
  fs.mkdirSync(project);
  const context = path.join(root, "context.json");
  const resultFile = path.join(root, "result.json");
  fs.writeFileSync(
    context,
    JSON.stringify({ repo, project, scenario, script: sourceScript, resultFile }),
  );
  const result = spawnSync(
    "powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", harness],
    {
      cwd: root,
      env: { ...process.env, QUACK_INSTALL_FIXTURE_CONTEXT: context },
      shell: false,
      windowsHide: true,
      encoding: "utf8",
      timeout: 15_000,
      maxBuffer: 1024 * 1024,
    },
  );
  const evidence = fs.existsSync(resultFile)
    ? (JSON.parse(fs.readFileSync(resultFile, "utf8")) as FixtureResult)
    : undefined;
  return { repo, project, result, evidence };
}

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

windowsDescribe("packaged Windows worker persistence helper", () => {
  it("generates scoped wrappers with quoted paths through mocked startup registration", () => {
    const f = invoke("clear");
    expect(f.result.error).toBeUndefined();
    expect(f.result.status).toBe(0);
    expect(f.evidence?.error).toBeNull();
    expect(f.evidence?.parsedWrappers).toBe(2);
    expect(f.evidence?.events.map((event) => event.taskName)).toEqual([
      "QuackWorkerRuntime-fixture-host",
      "QuackWorkerListener-fixture-host",
    ]);
    for (const event of f.evidence?.events ?? []) {
      expect(event.execute).toBe("powershell.exe");
      expect(event.trigger).toBe("logon");
      expect(event.arguments).toContain('-File "' + path.join(f.repo, ".quack"));
    }
    const listener = fs.readFileSync(
      path.join(f.repo, ".quack", "run-fixture-host-listener.ps1"),
      "utf8",
    );
    expect(listener).toContain("daemon --host-id 'fixture-host'");
    expect(listener).not.toContain("Stop-Process");
    const environment = fs.readFileSync(
      path.join(f.repo, ".quack", "fixture-host-worker.env"),
      "utf8",
    );
    expect(environment).toContain("QUACK_BASE_URL=http://127.0.0.1:3333");
    expect(environment).toContain("example-alias");
  });

  it.each(["busy-port", "owned-wrapper", "unscoped-listener"] as const)(
    "refuses %s before writing installation state or registering startup",
    (scenario) => {
      const f = invoke(scenario);
      expect(f.result.status).toBe(1);
      expect(f.evidence?.error).toContain("Worker installation refused");
      expect(f.evidence?.error).toContain("No process was stopped");
      expect(f.evidence?.events).toEqual([]);
      expect(fs.existsSync(path.join(f.repo, ".quack"))).toBe(false);
      expect(fs.existsSync(path.join(f.project, ".quack"))).toBe(false);
    },
  );

  it("preserves a distinctly scoped listener belonging to another worker", () => {
    const f = invoke("other-worker");
    expect(f.result.status).toBe(0);
    expect(f.evidence?.error).toBeNull();
    expect(f.evidence?.events).toHaveLength(2);
  });

  it("quotes immediate wrapper starts and round-trips Unicode paths through all env readers", () => {
    const f = invoke("start");
    expect(f.result.error).toBeUndefined();
    expect(f.result.status).toBe(0);
    expect(f.evidence?.error).toBeNull();
    expect(f.evidence?.parsedWrappers).toBe(2);
    expect(f.evidence?.launches).toEqual(
      ["runtime", "listener"].map((kind) => {
        const quotedPath = '"' + path.join(f.repo, ".quack", `run-fixture-host-${kind}.ps1`) + '"';
        return {
          filePath: "powershell.exe",
          windowStyle: "Hidden",
          arguments: ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", quotedPath],
          commandLine: "-NoProfile -ExecutionPolicy Bypass -File " + quotedPath,
        };
      }),
    );
    expect(f.evidence?.listenerCalls).toEqual([
      [".\\scripts\\quack-listener.mjs", "once", "--json"],
    ]);
    expect(f.evidence?.healthCalls).toEqual([["-s", "http://127.0.0.1:3337/api/health"]]);
    expect(f.evidence?.importedEnvironments.map((entry) => entry.source).sort()).toEqual([
      "immediate-listener",
      "run-fixture-host-listener.ps1",
      "run-fixture-host-runtime.ps1",
    ]);
    for (const entry of f.evidence?.importedEnvironments ?? []) {
      expect(entry.repoPath).toBe(f.repo);
      expect(entry.projectPaths).toEqual({
        example: f.project,
        "example-alias": f.project,
        quack: f.repo,
      });
      expect(entry.capabilityReportPath).toBe(
        path.join(f.repo, ".quack", "fixture-host-capabilities.json"),
      );
    }
    const command = fs.readFileSync(
      path.join(f.repo, ".quack", "run-fixture-host-runtime.cmd"),
      "ascii",
    );
    expect(command).toContain('cd /d "%~dp0.."');
    expect(command).toContain('-File "%~dp0run-fixture-host-runtime.ps1"');
    expect(command).not.toContain(f.repo);
  });
});
