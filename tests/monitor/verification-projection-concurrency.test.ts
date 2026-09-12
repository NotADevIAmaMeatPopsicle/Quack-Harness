import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { QuackDB } from "../../src/db";
import { recordVerification } from "../../src/monitor/verification-store";

function waitMessage(child: ChildProcess, type: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const onMessage = (message: unknown): void => {
      if ((message as { type?: string }).type === type) {
        child.off("message", onMessage);
        child.off("exit", onExit);
        child.off("error", onError);
        resolve();
      }
    };
    const onExit = (code: number | null): void => {
      reject(new Error(`Child exited ${String(code)} before ${type}`));
    };
    const onError = (error: Error): void => {
      reject(error);
    };
    child.on("message", onMessage);
    child.once("exit", onExit);
    child.once("error", onError);
  });
}

describe("QPI-013 cross-process verification serialization", () => {
  test.each(["different-task", "same-task", "regenerate"])(
    "serializes %s behind an in-flight canonical publication",
    async (mode) => {
      const root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-verification-process-"));
      fs.mkdirSync(path.join(root, ".quack"));
      const db = new QuackDB(path.join(root, ".quack", "quack.db"));
      const childTask = mode === "same-task" ? "TASK-100" : "TASK-200";
      const child = spawn(
        process.execPath,
        [path.join(__dirname, "../helpers/verification-process-worker.cjs"), root, mode, childTask],
        {
          stdio: ["ignore", "ignore", "pipe", "ipc"],
          windowsHide: true,
        },
      );
      let stderr = "";
      child.stderr?.on("data", (chunk: Buffer) => {
        stderr += chunk.toString("utf8");
      });
      const messages: string[] = [];
      child.on("message", (message: unknown) => {
        messages.push((message as { type: string }).type);
      });
      const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
      let release!: () => void;
      let announceRead!: () => void;
      const mayPublish = new Promise<void>((resolve) => {
        release = resolve;
      });
      const readStarted = new Promise<void>((resolve) => {
        announceRead = resolve;
      });
      let first: Promise<unknown> | undefined;
      try {
        await waitMessage(child, "ready");
        first = recordVerification(
          { projectRoot: root, db },
          {
            taskId: "TASK-100",
            verdict: "VERIFIED",
            commitSha: "abc1234",
            method: "api",
            criteriaChecked: 1,
            criteriaPassed: 1,
            verifiedAt: "2026-05-02",
            updatedAt: "2026-05-02T12:00:00.000Z",
          },
          {
            afterProjectionReadForTest: async () => {
              announceRead();
              await mayPublish;
            },
          },
        );
        await readStarted;
        const attempting = waitMessage(child, "attempting");
        child.send("go");
        await attempting;
        await new Promise<void>((resolve) => setTimeout(resolve, 125));
        const enteredEarly = messages.includes("projection_read") || messages.includes("done");
        const during = db.getVerified(childTask);
        release();
        await first;
        const code = await exited;
        expect({ code, stderr }).toEqual({ code: 0, stderr: "" });
        expect(enteredEarly).toBe(false);
        if (mode === "different-task") expect(during).toBeUndefined();
        if (mode === "same-task") expect(during?.commit_sha).toBe("abc1234");
        const projection = JSON.parse(
          fs.readFileSync(path.join(root, ".quack", "verified.json"), "utf8"),
        ) as { tasks: Record<string, { commit: string }> };
        expect(Object.keys(projection.tasks)).toEqual(
          mode === "different-task" ? ["TASK-100", "TASK-200"] : ["TASK-100"],
        );
        if (mode !== "regenerate") {
          expect(projection.tasks[childTask].commit).toBe("def5678");
          expect(db.getVerified(childTask)?.commit_sha).toBe("def5678");
        }
        expect(fs.existsSync(path.join(root, ".quack", "verified.json.lock"))).toBe(false);
      } finally {
        release?.();
        await first?.catch(() => undefined);
        if (child.exitCode === null) child.kill();
        await exited;
        db.close();
        fs.rmSync(root, { recursive: true, force: true });
      }
    },
    30_000,
  );
});
