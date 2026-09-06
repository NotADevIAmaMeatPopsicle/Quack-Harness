// ─── Docker Health Check Tests ──────────────────────────────────────

import { checkDockerHealth, requiresDocker } from "../../src/utils/docker-health";
import * as childProcess from "node:child_process";

jest.mock("node:child_process");

const mockedExecFile = childProcess.execFile as unknown as jest.Mock;

describe("docker-health", () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  describe("checkDockerHealth", () => {
    it("returns available=true with version when Docker is running", async () => {
      mockedExecFile.mockImplementation(
        (
          _cmd: string,
          _args: string[],
          _opts: unknown,
          cb: (err: null, result: { stdout: string }) => void,
        ) => {
          cb(null, { stdout: "27.5.1\n" });
        },
      );

      const result = await checkDockerHealth();

      expect(result.available).toBe(true);
      expect(result.version).toBe("27.5.1");
      expect(result.error).toBeUndefined();
    });

    it("returns available=false with error when Docker is not running", async () => {
      mockedExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
          cb(new Error("Cannot connect to the Docker daemon"));
        },
      );

      const result = await checkDockerHealth();

      expect(result.available).toBe(false);
      expect(result.error).toContain("Cannot connect to the Docker daemon");
      expect(result.version).toBeUndefined();
    });

    it("returns available=false when docker command not found", async () => {
      const err = new Error("spawn docker ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      mockedExecFile.mockImplementation(
        (_cmd: string, _args: string[], _opts: unknown, cb: (err: Error) => void) => {
          cb(err);
        },
      );

      const result = await checkDockerHealth();

      expect(result.available).toBe(false);
      expect(result.error).toContain("ENOENT");
    });
  });

  describe("requiresDocker", () => {
    it("returns true when a required command references docker", () => {
      const commands = [
        { command: "docker compose build test-runner", required: true },
        { command: "npm run lint", required: true },
      ];
      expect(requiresDocker(commands)).toBe(true);
    });

    it("returns false when no commands reference docker", () => {
      const commands = [
        { command: "npm run build", required: true },
        { command: "npm test", required: true },
        { command: "npm run lint", required: true },
      ];
      expect(requiresDocker(commands)).toBe(false);
    });

    it("ignores non-required docker commands", () => {
      const commands = [
        { command: "docker compose run tests", required: false },
        { command: "npm run lint", required: true },
      ];
      expect(requiresDocker(commands)).toBe(false);
    });

    it("returns false for empty commands array", () => {
      expect(requiresDocker([])).toBe(false);
    });

    it("matches docker keyword case-insensitively", () => {
      const commands = [{ command: "Docker compose --profile testing build", required: true }];
      expect(requiresDocker(commands)).toBe(true);
    });

    it("does not false-positive on words containing docker as substring", () => {
      // "Dockerfile" — \bdocker\b won't match because "f" follows without boundary
      const commands = [{ command: "cat Dockerfile", required: true }];
      expect(requiresDocker(commands)).toBe(false);
    });
  });
});
