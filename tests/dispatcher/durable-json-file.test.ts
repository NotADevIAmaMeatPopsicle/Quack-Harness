import { randomUUID } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
  reconcileDurableJsonInstall,
  syncDirectoryDurably,
  trustedWindowsPowerShellPath,
  writeJsonAtomicDurable,
} from "../../src/dispatcher/durable-json-file";

describe("durable JSON files", () => {
  test("never treats Node directory fsync as a Windows namespace barrier", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-durable-json-"));
    const actualFs = jest.requireActual<typeof import("node:fs")>("node:fs");
    const realOpen = actualFs.openSync;
    let observedFlags: string | number | undefined;
    const open = jest.spyOn(actualFs, "openSync").mockImplementation((file, flags, mode) => {
      observedFlags = flags;
      return realOpen(file, flags, mode);
    });
    try {
      if (process.platform === "win32") {
        expect(() => syncDirectoryDurably(root)).toThrow(/not a supported Windows/);
        expect(observedFlags).toBeUndefined();
      } else {
        syncDirectoryDurably(root);
        expect(observedFlags).toBe(fs.constants.O_RDONLY);
      }
    } finally {
      open.mockRestore();
    }

    if (process.platform !== "win32") {
      const sync = jest.spyOn(actualFs, "fsyncSync").mockImplementationOnce(() => {
        throw Object.assign(new Error("unsupported directory barrier"), { code: "ENOTSUP" });
      });
      try {
        expect(() => syncDirectoryDurably(root)).toThrow(/unsupported directory barrier/);
      } finally {
        sync.mockRestore();
      }
    }
    fs.rmSync(root, { recursive: true, force: true });
  });

  test("exclusive installation never replaces an existing final path", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-durable-json-"));
    const target = path.join(root, "journal.json");
    try {
      fs.writeFileSync(target, "original\n", "utf-8");
      expect(() => writeJsonAtomicDurable(target, { replacement: true }, true)).toThrow();
      expect(fs.readFileSync(target, "utf-8")).toBe("original\n");
      expect(fs.readdirSync(root)).toEqual(["journal.json"]);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  (process.platform === "win32" ? test.skip : test)(
    "orders POSIX namespace barriers around link publication and temp unlink",
    () => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-durable-json-"));
      const target = path.join(root, "journal.json");
      const actualFs = jest.requireActual<typeof import("node:fs")>("node:fs");
      const descriptors = new Map<number, string>();
      const events: string[] = [];
      const realOpen = actualFs.openSync;
      const realFsync = actualFs.fsyncSync;
      const realLink = actualFs.linkSync;
      const realRemove = actualFs.rmSync;
      const open = jest.spyOn(actualFs, "openSync").mockImplementation((file, flags, mode) => {
        const fd = realOpen(file, flags, mode);
        descriptors.set(fd, String(file));
        return fd;
      });
      const sync = jest.spyOn(actualFs, "fsyncSync").mockImplementation((fd) => {
        events.push(descriptors.get(fd) === root ? "directory" : "file");
        return realFsync(fd);
      });
      const link = jest.spyOn(actualFs, "linkSync").mockImplementation((source, destination) => {
        events.push("link");
        return realLink(source, destination);
      });
      const remove = jest.spyOn(actualFs, "rmSync").mockImplementation((candidate, options) => {
        if (String(candidate).startsWith(`${target}.`) && String(candidate).endsWith(".tmp")) {
          events.push("unlink");
        }
        return realRemove(candidate, options);
      });
      try {
        writeJsonAtomicDurable(target, { ordered: true }, true);
      } finally {
        open.mockRestore();
        sync.mockRestore();
        link.mockRestore();
        remove.mockRestore();
      }
      try {
        const linkAt = events.indexOf("link");
        const unlinkAt = events.indexOf("unlink");
        expect(events.slice(0, linkAt)).toContain("directory");
        expect(events.slice(linkAt + 1, unlinkAt)).toContain("directory");
        expect(events.slice(unlinkAt + 1)).toContain("directory");
      } finally {
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
  );

  test("a failed no-replace install leaves no partial final path or temp", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-durable-json-"));
    const target = path.join(root, "journal.json");
    const actualFs = jest.requireActual<typeof import("node:fs")>("node:fs");
    const actualChildProcess =
      jest.requireActual<typeof import("node:child_process")>("node:child_process");
    let invokedExecutable: string | undefined;
    let invokedOptions: { shell?: boolean } | undefined;
    const install =
      process.platform === "win32"
        ? jest
            .spyOn(actualChildProcess, "execFileSync")
            .mockImplementationOnce((file, _args, options) => {
              invokedExecutable = String(file);
              invokedOptions = options as { shell?: boolean };
              throw Object.assign(new Error("simulated install failure"), { code: "EIO" });
            })
        : jest.spyOn(actualFs, "linkSync").mockImplementationOnce(() => {
            throw Object.assign(new Error("simulated install failure"), { code: "EIO" });
          });
    try {
      expect(() => writeJsonAtomicDurable(target, { value: 1 }, true)).toThrow(
        /simulated install failure/,
      );
      expect(fs.existsSync(target)).toBe(false);
      expect(fs.readdirSync(root)).toEqual([]);
      if (process.platform === "win32") {
        expect(invokedExecutable).toBe(trustedWindowsPowerShellPath());
        expect(path.win32.isAbsolute(invokedExecutable!)).toBe(true);
        expect(invokedOptions?.shell).toBe(false);
      }
    } finally {
      install.mockRestore();
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("reconciles a crash after hard-link installation without replacing content", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-durable-json-"));
    const target = path.join(root, "journal.json");
    const installedTemp = `${target}.123.${randomUUID()}.tmp`;
    try {
      fs.writeFileSync(installedTemp, '{\n  "durable": true\n}\n', "utf-8");
      fs.linkSync(installedTemp, target);
      expect(fs.existsSync(target)).toBe(true);
      expect(fs.lstatSync(target).nlink).toBe(2);
      reconcileDurableJsonInstall(target);
      expect(fs.readFileSync(target, "utf-8")).toContain('"durable": true');
      expect(fs.existsSync(installedTemp)).toBe(false);
      expect(fs.lstatSync(target).nlink).toBe(1);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("does not report an update durable when the installed-file barrier fails", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-durable-json-"));
    const target = path.join(root, "journal.json");
    writeJsonAtomicDurable(target, { progress: "old" });
    const actualFs = jest.requireActual<typeof import("node:fs")>("node:fs");
    const realFsync = actualFs.fsyncSync;
    let calls = 0;
    const sync = jest.spyOn(actualFs, "fsyncSync").mockImplementation((fd) => {
      calls += 1;
      if (calls === 2) {
        throw Object.assign(new Error("simulated installed-file barrier failure"), { code: "EIO" });
      }
      return realFsync(fd);
    });
    try {
      expect(() => writeJsonAtomicDurable(target, { progress: "preparedMerge" })).toThrow(
        /installed-file barrier failure/,
      );
    } finally {
      sync.mockRestore();
    }
    try {
      expect(fs.readFileSync(target, "utf-8")).toContain('"progress": "old"');
      expect(() => reconcileDurableJsonInstall(target)).not.toThrow();
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
