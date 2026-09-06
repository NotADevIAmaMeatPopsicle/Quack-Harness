import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

// Create a stable temp dir for the test suite
const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "quack-cfg-"));
const originalQuackHome = process.env.QUACK_HOME;

// Mock os.homedir before importing the module under test
jest.mock("node:os", () => {
  const actual = jest.requireActual<typeof import("node:os")>("node:os");
  return {
    ...actual,
    homedir: () => tmpHome,
  };
});

import {
  getConfigHome,
  getConfigPath,
  loadGlobalConfig,
  saveGlobalConfig,
  registerProject,
  unregisterProject,
  updateProjectSettings,
  updateMonitorSettings,
  validateRemoteInstance,
  slugifyAlias,
} from "../../src/core/global-config";
import type { GlobalConfig, RemoteInstance } from "../../src/core/global-config";

beforeEach(() => {
  delete process.env.QUACK_HOME;
  // Clean the .quack dir before each test
  const quackDir = path.join(tmpHome, ".quack");
  if (fs.existsSync(quackDir)) {
    fs.rmSync(quackDir, { recursive: true, force: true });
  }
});

afterAll(() => {
  if (typeof originalQuackHome === "string") {
    process.env.QUACK_HOME = originalQuackHome;
  } else {
    delete process.env.QUACK_HOME;
  }
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

describe("getConfigPath", () => {
  it("should return ~/.quack/config.json", () => {
    const configPath = getConfigPath();
    expect(configPath).toBe(path.join(tmpHome, ".quack", "config.json"));
  });

  it("prefers QUACK_HOME when set", () => {
    const previousQuackHome = process.env.QUACK_HOME;
    const overrideHome = path.join(tmpHome, "override-home");
    process.env.QUACK_HOME = overrideHome;
    try {
      expect(getConfigHome()).toBe(overrideHome);
      expect(getConfigPath()).toBe(path.join(overrideHome, ".quack", "config.json"));
    } finally {
      if (typeof previousQuackHome === "string") {
        process.env.QUACK_HOME = previousQuackHome;
      } else {
        delete process.env.QUACK_HOME;
      }
    }
  });
});

describe("loadGlobalConfig", () => {
  it("should return defaults when file is missing", () => {
    const config = loadGlobalConfig();
    expect(config.projects).toEqual([]);
    expect(config.monitor.port).toBe(3333);
  });

  it("should read valid config from file", () => {
    const configDir = path.join(tmpHome, ".quack");
    fs.mkdirSync(configDir, { recursive: true });
    const data: GlobalConfig = {
      projects: [{ path: "/tmp/proj", autoPrep: true, autoPreflight: false }],
      monitor: { port: 4444 },
      activeProjectId: "tmp-proj",
    };
    fs.writeFileSync(path.join(configDir, "config.json"), JSON.stringify(data), "utf-8");

    const config = loadGlobalConfig();
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0].path).toBe("/tmp/proj");
    expect(config.projects[0].autoPrep).toBe(true);
    expect(config.monitor.port).toBe(4444);
    expect(config.activeProjectId).toBe("tmp-proj");
  });

  it("should tolerate a UTF-8 BOM in the config file", () => {
    const configDir = path.join(tmpHome, ".quack");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      `\uFEFF${JSON.stringify({ projects: [], monitor: { port: 4445 } })}`,
      "utf-8",
    );

    const config = loadGlobalConfig();
    expect(config.monitor.port).toBe(4445);
  });

  it("should throw on malformed JSON", () => {
    const configDir = path.join(tmpHome, ".quack");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(path.join(configDir, "config.json"), "not valid json{{{", "utf-8");

    expect(() => loadGlobalConfig()).toThrow();
  });

  it("should apply defaults for missing fields", () => {
    const configDir = path.join(tmpHome, ".quack");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ projects: [] }),
      "utf-8",
    );

    const config = loadGlobalConfig();
    expect(config.monitor.port).toBe(3333);
  });

  it("should sanitize project entries with missing fields", () => {
    const configDir = path.join(tmpHome, ".quack");
    fs.mkdirSync(configDir, { recursive: true });
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ projects: [{ path: "/foo" }] }),
      "utf-8",
    );

    const config = loadGlobalConfig();
    expect(config.projects[0].autoPrep).toBe(false);
    expect(config.projects[0].autoPreflight).toBe(false);
  });
});

describe("saveGlobalConfig", () => {
  it("should create directory and write JSON", () => {
    const config: GlobalConfig = {
      projects: [{ path: "/tmp/proj", autoPrep: false, autoPreflight: true }],
      monitor: { port: 5555 },
      activeProjectId: "tmp-proj",
    };
    saveGlobalConfig(config);

    const raw = fs.readFileSync(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw) as GlobalConfig;
    expect(parsed.projects).toHaveLength(1);
    expect(parsed.monitor.port).toBe(5555);
    expect(parsed.activeProjectId).toBe("tmp-proj");
  });

  it("should overwrite existing config", () => {
    saveGlobalConfig({
      projects: [],
      monitor: { port: 1111 },
    });
    saveGlobalConfig({
      projects: [{ path: "/new", autoPrep: false, autoPreflight: false }],
      monitor: { port: 2222 },
    });

    const config = loadGlobalConfig();
    expect(config.projects).toHaveLength(1);
    expect(config.monitor.port).toBe(2222);
  });
});

describe("registerProject", () => {
  it("should add a new project entry", () => {
    registerProject("/tmp/my-project");

    const config = loadGlobalConfig();
    expect(config.projects).toHaveLength(1);
    expect(config.projects[0].autoPrep).toBe(false);
    expect(config.projects[0].autoPreflight).toBe(false);
  });

  it("should accept custom settings", () => {
    registerProject("/tmp/my-project", {
      autoPrep: true,
      autoPreflight: true,
    });

    const config = loadGlobalConfig();
    expect(config.projects[0].autoPrep).toBe(true);
    expect(config.projects[0].autoPreflight).toBe(true);
  });

  it("should deduplicate by normalized path", () => {
    registerProject("/tmp/my-project");
    registerProject("/tmp/my-project");

    const config = loadGlobalConfig();
    expect(config.projects).toHaveLength(1);
  });

  it("should allow different paths", () => {
    registerProject("/tmp/proj-a");
    registerProject("/tmp/proj-b");

    const config = loadGlobalConfig();
    expect(config.projects).toHaveLength(2);
  });
});

describe("unregisterProject", () => {
  it("should remove a registered project", () => {
    registerProject("/tmp/proj");
    const removed = unregisterProject("/tmp/proj");
    expect(removed).toBe(true);

    const config = loadGlobalConfig();
    expect(config.projects).toHaveLength(0);
  });

  it("should return false if project not found", () => {
    const removed = unregisterProject("/tmp/nonexistent");
    expect(removed).toBe(false);
  });
});

describe("updateProjectSettings", () => {
  it("should merge settings for a registered project", () => {
    registerProject("/tmp/proj");
    updateProjectSettings("/tmp/proj", { autoPrep: true });

    const config = loadGlobalConfig();
    expect(config.projects[0].autoPrep).toBe(true);
    expect(config.projects[0].autoPreflight).toBe(false);
  });

  it("should throw if project is not registered", () => {
    expect(() => updateProjectSettings("/tmp/nonexistent", { autoPrep: true })).toThrow(
      "Project not registered",
    );
  });
});

describe("updateMonitorSettings", () => {
  it("should update the monitor port", () => {
    updateMonitorSettings({ port: 9999 });

    const config = loadGlobalConfig();
    expect(config.monitor.port).toBe(9999);
  });

  it("should preserve other config sections", () => {
    registerProject("/tmp/proj");
    updateMonitorSettings({ port: 7777 });

    const config = loadGlobalConfig();
    expect(config.projects).toHaveLength(1);
    expect(config.monitor.port).toBe(7777);
  });
});

describe("slugifyAlias", () => {
  it("lowercases and replaces non-alphanumeric with dashes", () => {
    expect(slugifyAlias("My Remote Server")).toBe("my-remote-server");
  });

  it("strips leading/trailing dashes", () => {
    expect(slugifyAlias("--test--")).toBe("test");
  });

  it("handles underscores", () => {
    expect(slugifyAlias("my_remote_server")).toBe("my-remote-server");
  });
});

describe("validateRemoteInstance", () => {
  const validInstance: Partial<RemoteInstance> = {
    alias: "my_remote_server",
    host: "203.0.113.100",
    localPort: 3334,
    remotePort: 3334,
    sshTarget: "user@203.0.113.100",
    sshKeyPath: "~/.ssh/my_remote_server",
    enabled: true,
  };

  it("returns empty array for valid instance", () => {
    expect(validateRemoteInstance(validInstance)).toEqual([]);
  });

  it("rejects missing alias", () => {
    const errors = validateRemoteInstance({ ...validInstance, alias: "" });
    expect(errors).toContainEqual(expect.stringContaining("alias"));
  });

  it("rejects duplicate alias", () => {
    const errors = validateRemoteInstance(validInstance, ["my-remote-server"]);
    expect(errors).toContainEqual(expect.stringContaining("already in use"));
  });

  it("rejects invalid host", () => {
    const errors = validateRemoteInstance({ ...validInstance, host: "bad host!" });
    expect(errors).toContainEqual(expect.stringContaining("host"));
  });

  it("rejects port out of range", () => {
    const errors = validateRemoteInstance({ ...validInstance, localPort: 80 });
    expect(errors).toContainEqual(expect.stringContaining("localPort"));
  });

  it("rejects invalid sshTarget", () => {
    const errors = validateRemoteInstance({
      ...validInstance,
      sshTarget: "not-valid",
    });
    expect(errors).toContainEqual(expect.stringContaining("sshTarget"));
  });

  it("rejects empty sshKeyPath", () => {
    const errors = validateRemoteInstance({
      ...validInstance,
      sshKeyPath: "",
    });
    expect(errors).toContainEqual(expect.stringContaining("sshKeyPath"));
  });
});

describe("remoteInstances in GlobalConfig", () => {
  it("round-trips remoteInstances through save/load", () => {
    const remote: RemoteInstance = {
      id: "my-remote-server",
      alias: "my_remote_server",
      host: "203.0.113.100",
      localPort: 3334,
      remotePort: 3334,
      sshTarget: "user@203.0.113.100",
      sshKeyPath: "~/.ssh/my_remote_server",
      healthCheckInterval: 30000,
      enabled: true,
    };

    const config: GlobalConfig = {
      projects: [],
      monitor: { port: 3333 },
      remoteInstances: [remote],
    };

    saveGlobalConfig(config);
    const loaded = loadGlobalConfig();

    expect(loaded.remoteInstances).toHaveLength(1);
    expect(loaded.remoteInstances![0]).toEqual(remote);
  });

  it("defaults to empty array when not present in file", () => {
    // Save config without remoteInstances
    const config = { projects: [], monitor: { port: 3333 } };
    const configPath = getConfigPath();
    fs.mkdirSync(path.dirname(configPath), { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify(config), "utf-8");

    const loaded = loadGlobalConfig();
    expect(loaded.remoteInstances).toEqual([]);
  });
});
