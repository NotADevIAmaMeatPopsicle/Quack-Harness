// ─── Testing Routes ─────────────────────────────────────────────────
// REST API routes for the dashboard's "testing" tab: list verification
// commands, run/stop/status a command, history, and a dedicated SSE stream
// for live test output. The route module owns no business logic — testRunner
// + the closure-scoped adapter readers do the work.

import type { Express, Request, Response } from "express";

import type { TestRunner } from "../server.js";
import type { SSEManager } from "../sse-manager.js";
import type { RuntimeAuthorityDescriptor } from "../../core/worker-protocol.js";
import type {
  AdapterFreshnessMetadata,
  AdapterGitConfig,
  SmartTestingConfig,
  VerificationCommand,
} from "../../core/types.js";
import { verificationCommandShellString } from "../../core/types.js";

export interface TestingRouteProject {
  projectRoot?: string;
  adapterPath?: string;
}

export interface TestingRouteDeps {
  resolveProject: (req: Request) => TestingRouteProject;
  testRunner: TestRunner | null;
  sse: SSEManager;
  getVerificationCommands: (adapterPath?: string) => VerificationCommand[];
  getSmartTestingConfig: (adapterPath?: string) => SmartTestingConfig | undefined;
  getAdapterGitConfig: (adapterPath?: string) => AdapterGitConfig | null;
  getAdapterFreshness: (adapterPath?: string) => AdapterFreshnessMetadata | undefined;
  authority: RuntimeAuthorityDescriptor;
}

export function registerTestingRoutes(app: Express, deps: TestingRouteDeps): void {
  const {
    resolveProject,
    testRunner,
    sse,
    getVerificationCommands,
    getSmartTestingConfig,
    getAdapterGitConfig,
    getAdapterFreshness,
    authority,
  } = deps;

  app.get("/api/testing/commands", (req: Request, res: Response) => {
    const p = resolveProject(req);
    res.setHeader("X-Quack-State-Authority", authority.stateAuthority);
    res.setHeader("X-Quack-Local-Db-Authoritative", String(authority.localDbAuthoritative));
    res.json(getVerificationCommands(p.adapterPath));
  });

  app.post("/api/testing/run", (req: Request, res: Response) => {
    const p = resolveProject(req);
    if (!p.projectRoot) {
      res.status(500).json({ error: "No project root configured" });
      return;
    }
    if (!testRunner) {
      res.status(500).json({ error: "Test runner not available" });
      return;
    }

    const body = req.body as Record<string, unknown> | undefined;
    const name = typeof body?.command === "string" ? body.command : "";
    const force = body?.force === true;

    if (!name) {
      res.status(400).json({ error: "Missing required field: command" });
      return;
    }

    // Find the verification command by name
    const commands = getVerificationCommands(p.adapterPath);
    const cmd = commands.find((c) => c.name === name);
    if (!cmd) {
      res.status(400).json({ error: `Unknown command: ${name}` });
      return;
    }

    if (testRunner.isRunning()) {
      res.status(409).json({ error: "A command is already running" });
      return;
    }

    try {
      const smartTesting = getSmartTestingConfig(p.adapterPath);
      const gitConfig = getAdapterGitConfig(p.adapterPath);
      const adapterFreshness = getAdapterFreshness(p.adapterPath);
      const cmdShellString = verificationCommandShellString(cmd);
      const started = testRunner.start(cmd.name, cmdShellString, {
        timeoutMs: cmd.timeout,
        force,
        smartTesting,
        baseBranch: gitConfig?.baseBranch ?? "main",
        adapterFreshness,
      });
      res.json({
        ok: true,
        name: cmd.name,
        command: cmdShellString,
        adapterFreshness,
        authority,
        ...started,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      res.status(500).json({ error: msg });
    }
  });

  app.get("/api/testing/status", (_req: Request, res: Response) => {
    if (!testRunner) {
      res.json({ running: false, name: "", command: "", authority });
      return;
    }
    res.json({ ...testRunner.getStatus(), authority });
  });

  app.post("/api/testing/stop", (_req: Request, res: Response) => {
    if (!testRunner) {
      res.status(404).json({ error: "Test runner not available" });
      return;
    }
    const stopped = testRunner.stop();
    if (stopped) {
      res.json({ ok: true, message: "Command stopped" });
    } else {
      res.status(404).json({ error: "No command is running" });
    }
  });

  app.get("/api/testing/history", (_req: Request, res: Response) => {
    if (!testRunner) {
      res.json([]);
      return;
    }
    res.json(testRunner.getHistory());
  });

  app.get("/api/testing/stream", (req: Request, res: Response) => {
    // Dedicated SSE endpoint for testing output.
    // Clients filter by stage=testing_output.
    sse.addClient(res, undefined, req);
  });
}
