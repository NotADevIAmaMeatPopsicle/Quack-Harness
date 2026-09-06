// ─── File Heartbeat Tests ────────────────────────────────────────────

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import { FileHeartbeat } from "../../src/dispatcher/file-heartbeat.js";

describe("FileHeartbeat", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-heartbeat-"));
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  test("starts and stops without error", () => {
    const hb = new FileHeartbeat(tmpDir);
    hb.start();
    hb.stop();
  });

  test("idempotent start — calling start twice does not throw", () => {
    const hb = new FileHeartbeat(tmpDir);
    hb.start();
    hb.start(); // should be a no-op
    hb.stop();
  });

  test("idempotent stop — calling stop twice does not throw", () => {
    const hb = new FileHeartbeat(tmpDir);
    hb.start();
    hb.stop();
    hb.stop(); // should be a no-op
  });

  test("returns null for getLastModification before any file changes", () => {
    const hb = new FileHeartbeat(tmpDir);
    hb.start();
    expect(hb.getLastModification()).toBeNull();
    hb.stop();
  });

  test("returns Infinity for getSilentMs before any file changes", () => {
    const hb = new FileHeartbeat(tmpDir);
    hb.start();
    expect(hb.getSilentMs()).toBe(Infinity);
    hb.stop();
  });

  test("detects .ts file creation", (done) => {
    const hb = new FileHeartbeat(tmpDir);
    hb.start();

    // Give chokidar time to initialize, then create a file
    setTimeout(() => {
      fs.writeFileSync(path.join(tmpDir, "test.ts"), "const x = 1;");
    }, 200);

    // Wait for chokidar to pick it up
    setTimeout(() => {
      const mod = hb.getLastModification();
      expect(mod).not.toBeNull();
      expect(mod!.file).toContain("test.ts");
      expect(hb.getSilentMs()).toBeLessThan(5000);
      hb.stop();
      done();
    }, 1500);
  }, 10000);

  test("detects .json file modification", (done) => {
    // Create the file before watching
    const filePath = path.join(tmpDir, "config.json");
    fs.writeFileSync(filePath, "{}");

    const hb = new FileHeartbeat(tmpDir);
    hb.start();

    setTimeout(() => {
      fs.writeFileSync(filePath, '{ "updated": true }');
    }, 200);

    setTimeout(() => {
      const mod = hb.getLastModification();
      expect(mod).not.toBeNull();
      expect(mod!.file).toContain("config.json");
      hb.stop();
      done();
    }, 1500);
  }, 10000);

  test("ignores node_modules directory", (done) => {
    const nodeModules = path.join(tmpDir, "node_modules");
    fs.mkdirSync(nodeModules, { recursive: true });

    const hb = new FileHeartbeat(tmpDir);
    hb.start();

    setTimeout(() => {
      fs.writeFileSync(path.join(nodeModules, "dep.js"), "module.exports = {};");
    }, 200);

    setTimeout(() => {
      expect(hb.getLastModification()).toBeNull();
      hb.stop();
      done();
    }, 1500);
  }, 10000);

  test("ignores .git directory", (done) => {
    const gitDir = path.join(tmpDir, ".git");
    fs.mkdirSync(gitDir, { recursive: true });

    const hb = new FileHeartbeat(tmpDir);
    hb.start();

    setTimeout(() => {
      fs.writeFileSync(path.join(gitDir, "HEAD"), "ref: refs/heads/main");
    }, 200);

    setTimeout(() => {
      expect(hb.getLastModification()).toBeNull();
      hb.stop();
      done();
    }, 1500);
  }, 10000);

  test("ignores non-watched extensions", (done) => {
    const hb = new FileHeartbeat(tmpDir);
    hb.start();

    setTimeout(() => {
      fs.writeFileSync(path.join(tmpDir, "image.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    }, 200);

    setTimeout(() => {
      expect(hb.getLastModification()).toBeNull();
      hb.stop();
      done();
    }, 1500);
  }, 10000);

  test("custom ignore patterns are respected", (done) => {
    const customDir = path.join(tmpDir, "build");
    fs.mkdirSync(customDir, { recursive: true });

    const hb = new FileHeartbeat(tmpDir, { ignorePatterns: ["**/build/**"] });
    hb.start();

    setTimeout(() => {
      fs.writeFileSync(path.join(customDir, "output.js"), "compiled code");
    }, 200);

    setTimeout(() => {
      expect(hb.getLastModification()).toBeNull();
      hb.stop();
      done();
    }, 1500);
  }, 10000);
});
