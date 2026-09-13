import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { chromium, type Browser } from "playwright";
import { loadAdapter } from "../../src/core/adapter-loader";
import { createMonitorServer } from "../../src/monitor/server";
import * as trustedNode from "../../src/monitor/trusted-node-launch";
import { taskSpec, writeAdapter } from "../helpers/duplicate-claimants-fixture";

jest.mock("../../src/monitor/auth", () => ({
  ...jest.requireActual<object>("../../src/monitor/auth"),
  initAuthConfig: () => ({ users: [], sessionSecret: "test", sessionTtlMs: 86400000 }),
}));
jest.setTimeout(45_000);

describe("React prep project scope", () => {
  let root: string;
  let stop: (() => Promise<void>) | undefined;
  let browser: Browser | undefined;
  let child: EventEmitter & { pid: number; exitCode: number | null; signalCode: null; stdout: EventEmitter; stderr: EventEmitter };
  afterEach(async () => {
    await browser?.close(); browser = undefined;
    if (child?.exitCode === null) { child.exitCode = 1; child.emit("exit", 1, null); child.emit("close", 1, null); }
    await stop?.(); stop = undefined; jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });
  test.each(["list", "detail", "no-active-project"])("%s Prep submits the captured project on a real two-project monitor", async view => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-react-prep-"));
    const roots = [path.join(root, "alpha"), path.join(root, "beta")];
    for (const projectRoot of roots) {
      fs.mkdirSync(path.join(projectRoot, "docs/tasks"), { recursive: true });
      fs.writeFileSync(path.join(projectRoot, "docs/tasks/TASK-1357.md"), taskSpec("TASK-1357"));
      writeAdapter(projectRoot, { project: { name: path.basename(projectRoot), root: projectRoot,
        taskDir: "docs/tasks", conventionsDir: ".quack" } });
    }
    child = Object.assign(new EventEmitter(), { pid: 54545, exitCode: null, signalCode: null,
      stdout: new EventEmitter(), stderr: new EventEmitter() });
    const launch = jest.spyOn(trustedNode, "spawnTrustedNode").mockImplementation(options => {
      if (options.args[0] !== "prep") throw new Error("Unexpected child launch");
      return { child: child as unknown as ChildProcess, executablePath: process.execPath, processId: child.pid };
    });
    const monitor = createMonitorServer({ host: "127.0.0.1", port: 0, quackRoot: root,
      projectAdapters: await Promise.all(roots.map(projectRoot => loadAdapter(projectRoot))),
      uiBuildDir: path.resolve(__dirname, "../../frontend/dist") });
    const started = await monitor.start(); stop = started.stop;
    const origin = `http://127.0.0.1:${started.port}`;
    browser = await chromium.launch({ headless: true }); const page = await browser.newPage();
    const reads: string[] = []; page.on("request", request => {
      if (request.method() === "GET" && new URL(request.url()).pathname.endsWith("/prep")) reads.push(request.url());
    });
    if (view === "no-active-project") await page.route("**/api/projects", route => route.fulfill({ json: {
      projects: [{ id: "alpha", name: "alpha" }, { id: "beta", name: "beta" }], activeProjectId: null,
    } }));
    await page.goto(`${origin}/tasks${view === "list" ? "" : "/TASK-1357"}`);
    if (view === "no-active-project") {
      await page.getByText("Select an active project in Settings to run preflight.", { exact: true }).waitFor();
      expect(await page.getByRole("button", { name: "Prep", exact: true }).isDisabled()).toBe(true);
      expect(launch).not.toHaveBeenCalled(); return;
    }
    const posted = page.waitForResponse(response => response.request().method() === "POST" && new URL(response.url()).pathname.endsWith("/prep"));
    await page.getByRole("button", { name: "Prep", exact: true }).click();
    const response = await posted;
    expect(response.status()).toBe(200);
    const projectId = new URL(response.url()).searchParams.get("project");
    expect(projectId).toBeTruthy(); expect(launch).toHaveBeenCalledTimes(1);
    const projectsResponse = await fetch(`${origin}/api/projects`);
    const projects = await projectsResponse.json() as Array<{ id: string; path: string }>;
    const target = projects.find(project => project.id === projectId)!;
    expect(target).toBeDefined();
    expect(launch.mock.calls[0][0].cwd).toBe(target.path);
    if (view === "detail") expect(reads.length).toBeGreaterThan(0);
    for (const read of reads) expect(new URL(read).searchParams.get("project")).toBe(projectId);
  });
});
