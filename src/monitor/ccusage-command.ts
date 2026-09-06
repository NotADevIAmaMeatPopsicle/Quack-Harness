import * as fs from "node:fs";
import * as path from "node:path";

export interface CcusageCommand {
  command: string;
  argsPrefix: string[];
  shell: boolean;
  source: "ccusage" | "npx";
}

function uniquePaths(entries: Array<string | undefined>, platform: NodeJS.Platform): string[] {
  const seen = new Set<string>();
  const result: string[] = [];

  for (const entry of entries) {
    if (!entry) continue;
    const trimmed = entry.trim();
    if (!trimmed) continue;
    const normalized = path.normalize(trimmed);
    const key = platform === "win32" ? normalized.toLowerCase() : normalized;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(normalized);
  }

  return result;
}

function splitPath(env: NodeJS.ProcessEnv): string[] {
  const raw = env.PATH ?? env.Path ?? env.path ?? "";
  return raw
    .split(path.delimiter)
    .map((entry) => entry.trim())
    .filter(Boolean);
}

function candidateDirs(env: NodeJS.ProcessEnv, platform: NodeJS.Platform): string[] {
  const pathEntries = splitPath(env);

  if (platform !== "win32") {
    return uniquePaths(pathEntries, platform);
  }

  return uniquePaths(
    [
      env.APPDATA ? path.join(env.APPDATA, "npm") : undefined,
      env.npm_config_prefix,
      env.ProgramFiles ? path.join(env.ProgramFiles, "nodejs") : undefined,
      env["ProgramFiles(x86)"] ? path.join(env["ProgramFiles(x86)"], "nodejs") : undefined,
      ...pathEntries,
    ],
    platform,
  );
}

function findExecutable(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
  names: string[],
): string | null {
  for (const dir of candidateDirs(env, platform)) {
    for (const name of names) {
      const candidate = path.join(dir, name);
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }
  }

  return null;
}

export function resolveCcusageCommand(
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): CcusageCommand {
  if (platform === "win32") {
    const direct = findExecutable(env, platform, ["ccusage.cmd", "ccusage.exe", "ccusage.bat"]);
    if (direct) {
      return {
        command: direct,
        argsPrefix: [],
        shell: true,
        source: "ccusage",
      };
    }

    const npx = findExecutable(env, platform, ["npx.cmd", "npx.exe", "npx.bat"]);
    return {
      command: npx ?? "npx",
      argsPrefix: ["ccusage"],
      shell: true,
      source: "npx",
    };
  }

  const direct = findExecutable(env, platform, ["ccusage"]);
  if (direct) {
    return {
      command: direct,
      argsPrefix: [],
      shell: false,
      source: "ccusage",
    };
  }

  const npx = findExecutable(env, platform, ["npx"]);
  return {
    command: npx ?? "npx",
    argsPrefix: ["ccusage"],
    shell: false,
    source: "npx",
  };
}
