import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Create a stable temp dir for the test suite
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "quack-proj-cli-"));

// Mock os.homedir before importing modules that use global-config
jest.mock("node:os", () => {
  const actual = jest.requireActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

import { projectsCommand } from "../../src/cli/projects";
import { loadGlobalConfig, registerProject } from "../../src/core/global-config";

beforeEach(() => {
  // Clean the .quack dir before each test
  const quackDir = path.join(tmpHome, ".quack");
  if (fs.existsSync(quackDir)) {
    fs.rmSync(quackDir, { recursive: true, force: true });
  }
  jest.spyOn(process, "exit").mockImplementation((() => {}) as never);
  jest.spyOn(console, "log").mockImplementation(() => {});
  jest.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(() => {
  jest.restoreAllMocks();
});

afterAll(() => {
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("projectsCommand", () => {
  it("should list projects when no flags given (empty)", () => {
    projectsCommand({});

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("No projects registered"));
  });

  it("should list registered projects", () => {
    const projDir = path.join(tmpHome, "test-proj");
    fs.mkdirSync(path.join(projDir, ".quack"), { recursive: true });
    fs.writeFileSync(path.join(projDir, ".quack", "adapter.json"), "{}", "utf-8");
    registerProject(projDir);

    projectsCommand({});

    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Projects (1)"));
  });

  it("should add a project with --add", () => {
    const projDir = path.join(tmpHome, "add-proj");
    fs.mkdirSync(path.join(projDir, ".quack"), { recursive: true });
    fs.writeFileSync(path.join(projDir, ".quack", "adapter.json"), "{}", "utf-8");

    projectsCommand({ add: projDir });

    const config = loadGlobalConfig();
    expect(config.projects).toHaveLength(1);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Registered"));
  });

  it("should reject --add when no adapter exists", () => {
    const projDir = path.join(tmpHome, "no-adapter");
    fs.mkdirSync(projDir, { recursive: true });

    projectsCommand({ add: projDir });

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("No .quack/adapter.json"));
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("should remove a project with --remove", () => {
    const projDir = path.join(tmpHome, "rm-proj");
    fs.mkdirSync(path.join(projDir, ".quack"), { recursive: true });
    fs.writeFileSync(path.join(projDir, ".quack", "adapter.json"), "{}", "utf-8");
    registerProject(projDir);

    projectsCommand({ remove: projDir });

    const config = loadGlobalConfig();
    expect(config.projects).toHaveLength(0);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("Unregistered"));
  });

  it("should error on --remove for nonexistent project", () => {
    projectsCommand({ remove: "/tmp/nonexistent-proj-xxxx" });

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Not found in registry"));
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(process.exit).toHaveBeenCalledWith(1);
  });

  it("should update monitor port with --port", () => {
    projectsCommand({ port: "9999" });

    const config = loadGlobalConfig();
    expect(config.monitor.port).toBe(9999);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining("9999"));
  });

  it("should reject invalid port", () => {
    projectsCommand({ port: "not-a-number" });

    expect(console.error).toHaveBeenCalledWith(expect.stringContaining("Invalid port"));
    // eslint-disable-next-line @typescript-eslint/unbound-method
    expect(process.exit).toHaveBeenCalledWith(1);
  });
});
