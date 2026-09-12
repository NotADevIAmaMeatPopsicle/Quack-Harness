import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

import type { ProjectAdapter } from "../../src/core/adapter-loader";
import type { AdapterConfig } from "../../src/core/types";
import {
  consumeDecompositionDispatchAdmission,
  createDecompositionDispatchAdmissionMarker,
  DECOMPOSITION_ADMISSION_HASH_ENV,
  DECOMPOSITION_ADMISSION_MARKER_ENV,
  DECOMPOSITION_ADMISSION_TOKEN_ENV,
  removeDecompositionDispatchAdmissionScope,
  revokeDecompositionDispatchAdmission,
} from "../../src/preflight/decomposition-dispatch-admission";

function adapterFor(projectRoot: string): ProjectAdapter {
  return {
    projectRoot,
    conventionsDoc: "",
    judgeCriteria: "",
    conventionCheckScripts: [],
    adrDocs: {},
    config: {
      version: "1.0",
      project: {
        name: "admission-test",
        root: ".",
        taskDir: "docs/tasks",
        conventionsDir: ".quack",
      },
      agent: {
        model: "test",
        judgeModel: "test",
        enrichModel: "test",
        maxTurns: 10,
        maxBudgetPerTask: 1,
        maxRetries: 0,
      },
      verification: { commands: [], conventionChecks: [] },
      sandbox: {
        writablePaths: [],
        deniedPaths: [],
        allowedBashPatterns: [],
        deniedBashPatterns: [],
      },
      git: {
        baseBranch: "main",
        branchPrefix: "quack/",
        commitFormat: "[{taskId}] {message}",
        commitTrailer: "",
        autoCreatePr: false,
        autoPush: false,
      },
      logging: { dir: ".quack/logs", level: "debug", retainDays: 30 },
    } as AdapterConfig,
    adapterBundle: {
      authority: "local",
      sharedHash: "admission-test",
      normalizedConfig: {} as AdapterConfig,
      machineLocalFields: [],
    },
  };
}

describe("managed decomposition dispatch admission", () => {
  let root: string;
  let adapter: ProjectAdapter;

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "quack-dispatch-admission-"));
    adapter = adapterFor(root);
  });

  afterEach(async () => {
    await fs.rm(root, { recursive: true, force: true });
  });

  test("requires and consumes a matching one-use monitor marker", async () => {
    const hash = "a".repeat(64);
    const admission = createDecompositionDispatchAdmissionMarker({
      projectRoot: root,
      taskId: "TASK-006",
      contentHash: hash,
    });
    const { environment } = admission;
    const replay = { ...environment };
    const mutableFs = jest.requireActual<typeof import("node:fs/promises")>("node:fs/promises");
    const originalOpen = mutableFs.open;
    const openSpy = jest
      .spyOn(mutableFs, "open")
      .mockImplementation((...args) => originalOpen(...args));

    try {
      await expect(
        consumeDecompositionDispatchAdmission(adapter, "TASK-006", environment),
      ).resolves.toBe(hash);
      expect(environment).toEqual({});
      await expect(
        consumeDecompositionDispatchAdmission(adapter, "TASK-006", replay),
      ).rejects.toMatchObject({ code: "ENOENT" });
      const admissionDirectory = path.join(root, ".quack", "decomposition-admissions");
      const directorySyncCalls = openSpy.mock.calls
        .map((args, index) => ({ args, index }))
        .filter(({ args }) => path.resolve(String(args[0])) === path.resolve(admissionDirectory));
      const tombstoneMutation = openSpy.mock.calls.findIndex(
        (args) => String(args[0]).includes(".consumed-") && args[1] === "r+",
      );
      expect(directorySyncCalls).toHaveLength(3);
      expect(directorySyncCalls[0].index).toBeLessThan(tombstoneMutation);
    } finally {
      openSpy.mockRestore();
    }
  });

  test("does not trust a user-settable hash without the monitor marker proof", async () => {
    const partialEnvironment = {
      [DECOMPOSITION_ADMISSION_HASH_ENV]: "b".repeat(64),
    };
    await expect(
      consumeDecompositionDispatchAdmission(adapter, "TASK-006", partialEnvironment),
    ).resolves.toBeUndefined();
    expect(partialEnvironment).toEqual({});
  });

  test("rejects a marker whose token or task identity was forged", async () => {
    const { environment } = createDecompositionDispatchAdmissionMarker({
      projectRoot: root,
      taskId: "TASK-006",
      contentHash: "c".repeat(64),
    });
    const forged = {
      ...environment,
      [DECOMPOSITION_ADMISSION_TOKEN_ENV]: "00000000-0000-0000-0000-000000000000",
    };

    await expect(
      consumeDecompositionDispatchAdmission(adapter, "TASK-006", forged),
    ).rejects.toThrow("does not match");
    expect(forged).toEqual({});
    expect(environment[DECOMPOSITION_ADMISSION_MARKER_ENV]).toMatch(/^dispatch-TASK-006-/);
  });

  test("round-trips a supported SAURUS task identity", async () => {
    const hash = "d".repeat(64);
    const { environment } = createDecompositionDispatchAdmissionMarker({
      projectRoot: root,
      taskId: "SAURUS-REM-123",
      contentHash: hash,
    });

    await expect(
      consumeDecompositionDispatchAdmission(adapter, "SAURUS-REM-123", environment),
    ).resolves.toBe(hash);
  });

  test("keeps markers inside the execution root when logs are a junction", async () => {
    const outside = await fs.mkdtemp(path.join(os.tmpdir(), "quack-shared-logs-"));
    await fs.mkdir(path.join(root, ".quack"), { recursive: true });
    try {
      await fs.symlink(
        outside,
        path.join(root, ".quack", "logs"),
        process.platform === "win32" ? "junction" : "dir",
      );
    } catch (error) {
      if (["EPERM", "EACCES", "ENOSYS"].includes((error as NodeJS.ErrnoException).code ?? "")) {
        await fs.rm(outside, { recursive: true, force: true });
        return;
      }
      throw error;
    }

    try {
      const { environment } = createDecompositionDispatchAdmissionMarker({
        projectRoot: root,
        taskId: "TASK-006",
        contentHash: "e".repeat(64),
      });
      const markerPath = path.join(
        root,
        ".quack",
        "decomposition-admissions",
        environment[DECOMPOSITION_ADMISSION_MARKER_ENV],
      );
      await expect(fs.access(markerPath)).resolves.toBeUndefined();
      await expect(
        consumeDecompositionDispatchAdmission(adapter, "TASK-006", environment),
      ).resolves.toBe("e".repeat(64));
      expect(await fs.readdir(outside)).toEqual([]);
    } finally {
      await fs.unlink(path.join(root, ".quack", "logs")).catch(() => undefined);
      await fs.rm(outside, { recursive: true, force: true });
    }
  });

  test("isolates Docker admissions in separate host-only dispatch directories", async () => {
    const first = createDecompositionDispatchAdmissionMarker({
      projectRoot: root,
      taskId: "TASK-006",
      contentHash: "f".repeat(64),
      isolatedDirectory: true,
    });
    const second = createDecompositionDispatchAdmissionMarker({
      projectRoot: root,
      taskId: "TASK-007",
      contentHash: "1".repeat(64),
      isolatedDirectory: true,
    });

    expect(first.hostDirectory).not.toBe(second.hostDirectory);
    expect(first.environment[DECOMPOSITION_ADMISSION_MARKER_ENV]).toBe("marker.json");
    try {
      const marker = JSON.parse(
        await fs.readFile(path.join(first.hostDirectory, "marker.json"), "utf-8"),
      ) as { taskId: string; token: string };
      expect(marker).toMatchObject({
        taskId: "TASK-006",
        token: first.environment[DECOMPOSITION_ADMISSION_TOKEN_ENV],
      });
      await expect(
        fs.access(path.join(second.hostDirectory, "marker.json")),
      ).resolves.toBeUndefined();
    } finally {
      removeDecompositionDispatchAdmissionScope(root, first.hostDirectory);
      removeDecompositionDispatchAdmissionScope(root, second.hostDirectory);
    }
  });

  test("revokes only the exact untransferred marker and releases its isolated scope", async () => {
    const admission = createDecompositionDispatchAdmissionMarker({
      projectRoot: root,
      taskId: "TASK-006",
      contentHash: "2".repeat(64),
      isolatedDirectory: true,
    });
    const forged = {
      ...admission,
      environment: {
        ...admission.environment,
        [DECOMPOSITION_ADMISSION_TOKEN_ENV]: "00000000-0000-4000-8000-000000000000",
      },
    };

    expect(() => revokeDecompositionDispatchAdmission(root, forged)).toThrow("ownership changed");
    await expect(
      fs.access(path.join(admission.hostDirectory, "marker.json")),
    ).resolves.toBeUndefined();

    revokeDecompositionDispatchAdmission(root, admission);
    await expect(fs.access(admission.hostDirectory)).rejects.toMatchObject({ code: "ENOENT" });
    expect(() =>
      createDecompositionDispatchAdmissionMarker({
        projectRoot: root,
        taskId: "TASK-006",
        contentHash: "2".repeat(64),
        isolatedDirectory: true,
      }),
    ).not.toThrow();
  });

  test("keeps an unresolved isolated scope as a same-task admission barrier", () => {
    const admission = createDecompositionDispatchAdmissionMarker({
      projectRoot: root,
      taskId: "TASK-006",
      contentHash: "3".repeat(64),
      isolatedDirectory: true,
    });

    try {
      expect(() =>
        createDecompositionDispatchAdmissionMarker({
          projectRoot: root,
          taskId: "TASK-006",
          contentHash: "3".repeat(64),
          isolatedDirectory: true,
        }),
      ).toThrow("admission scope remains unresolved");
    } finally {
      removeDecompositionDispatchAdmissionScope(root, admission.hostDirectory);
    }
  });
});
