import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";

import type { AdapterBundleMetadata, AdapterConfig } from "./types.js";
import { AdapterConfigSchema } from "./adapter-schema.js";

// ─── ProjectAdapter interface ───────────────────────────────────────
// Defined here (not in types.ts) per task instructions.

export interface ProjectAdapter {
  /** Validated adapter configuration */
  config: AdapterConfig;
  /** Absolute path to the project root */
  projectRoot: string;
  /** Content of .quack/conventions.md (empty string if missing) */
  conventionsDoc: string;
  /** Content of .quack/judge-criteria.md (empty string if missing) */
  judgeCriteria: string;
  /** Absolute paths to scripts found in .quack/convention-checks/ */
  conventionCheckScripts: string[];
  /** Individual ADR/convention files keyed by filename (without extension) */
  adrDocs: Record<string, string>;
  /** Stable shared adapter policy metadata for worker/headnode comparison */
  adapterBundle: AdapterBundleMetadata;
}

const MACHINE_LOCAL_ADAPTER_FIELDS = [
  "project.root",
  "logging.dir",
  "agent.apiKeys",
  "workerOverlay",
];

// ─── Helper: read a file or return fallback ─────────────────────────

async function readFileOrDefault(filePath: string, fallback: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (hasErrorCode(err) && err.code === "ENOENT") {
      return fallback;
    }
    throw err;
  }
}

function hasErrorCode(err: unknown): err is { code: string } {
  return (
    typeof err === "object" &&
    err !== null &&
    "code" in err &&
    typeof (err as Record<string, unknown>).code === "string"
  );
}

function cloneConfig(config: AdapterConfig): AdapterConfig {
  return JSON.parse(JSON.stringify(config)) as AdapterConfig;
}

function sortForStableJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((item) => sortForStableJson(item));
  }
  if (value && typeof value === "object") {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value).sort((a, b) => a.localeCompare(b))) {
      sorted[key] = sortForStableJson((value as Record<string, unknown>)[key]);
    }
    return sorted;
  }
  return value;
}

function stableStringify(value: unknown): string {
  return JSON.stringify(sortForStableJson(value));
}

export function normalizeAdapterBundleConfig(config: AdapterConfig): AdapterConfig {
  const normalized = cloneConfig(config);
  normalized.project.root = "<machine-local:project.root>";
  normalized.logging.dir = "<machine-local:logging.dir>";
  delete normalized.agent.apiKeys;
  delete normalized.workerOverlay;
  return normalized;
}

export function computeAdapterBundleMetadata(
  config: AdapterConfig,
  authority: AdapterBundleMetadata["authority"] = "headnode",
): AdapterBundleMetadata {
  const normalizedConfig = normalizeAdapterBundleConfig(config);
  const hash = createHash("sha256").update(stableStringify(normalizedConfig)).digest("hex");
  return {
    authority,
    sharedHash: `sha256:${hash}`,
    normalizedConfig,
    machineLocalFields: [...MACHINE_LOCAL_ADAPTER_FIELDS],
  };
}

export function applyAdapterWorkerOverlay(config: AdapterConfig): AdapterConfig {
  const effective = cloneConfig(config);
  const overlay = effective.workerOverlay;
  if (!overlay) return effective;

  if (overlay.projectRoot) {
    effective.project.root = overlay.projectRoot;
  }
  if (overlay.taskDir) {
    effective.project.taskDir = overlay.taskDir;
  }
  if (overlay.logDir) {
    effective.logging.dir = overlay.logDir;
  }
  return effective;
}

// ─── Helper: discover scripts in a directory ────────────────────────

async function discoverScripts(dirPath: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(dirPath, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isFile())
      .map((entry) => path.join(dirPath, entry.name))
      .sort();
  } catch (err: unknown) {
    if (hasErrorCode(err) && err.code === "ENOENT") {
      return [];
    }
    throw err;
  }
}

// ─── Helper: load ADR/convention markdown files from directories ────

const MAX_ADR_FILES = 30;
const MAX_ADR_FILE_SIZE = 20 * 1024; // 20KB

async function loadAdrDocs(dirs: string[]): Promise<Record<string, string>> {
  const docs: Record<string, string> = {};
  let count = 0;

  for (const dir of dirs) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (err: unknown) {
      if (hasErrorCode(err) && err.code === "ENOENT") continue;
      throw err;
    }

    const mdFiles = entries
      .filter((e) => e.isFile() && e.name.endsWith(".md"))
      .sort((a, b) => a.name.localeCompare(b.name));

    for (const entry of mdFiles) {
      if (count >= MAX_ADR_FILES) break;
      const filePath = path.join(dir, entry.name);
      try {
        const stat = await fs.stat(filePath);
        if (stat.size > MAX_ADR_FILE_SIZE) continue;
        const content = await fs.readFile(filePath, "utf-8");
        const key = entry.name.replace(/\.md$/, "");
        if (!docs[key]) {
          docs[key] = content;
          count++;
        }
      } catch {
        // Skip unreadable files
      }
    }
  }

  return docs;
}

// ─── Main loader ────────────────────────────────────────────────────

export async function loadAdapter(projectRoot: string): Promise<ProjectAdapter> {
  const absoluteRoot = path.resolve(projectRoot);
  const quackDir = path.join(absoluteRoot, ".quack");
  const adapterJsonPath = path.join(quackDir, "adapter.json");

  // 1. Read adapter.json
  let rawJson: string;
  try {
    rawJson = await fs.readFile(adapterJsonPath, "utf-8");
  } catch (err: unknown) {
    if (hasErrorCode(err) && err.code === "ENOENT") {
      throw new Error("No .quack/adapter.json found. Run 'quack init' to create one.");
    }
    throw err;
  }

  // 2. Parse JSON
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch {
    throw new Error(`Invalid JSON in ${adapterJsonPath}: file is not valid JSON`);
  }

  // 3. Validate with Zod schema
  const result = AdapterConfigSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `  - ${issue.path.join(".")}: ${issue.message}`)
      .join("\n");
    throw new Error(`Invalid adapter config in ${adapterJsonPath}:\n${issues}`);
  }

  const config: AdapterConfig = result.data;

  // 4. Read companion files
  const conventionsDoc = await readFileOrDefault(path.join(quackDir, "conventions.md"), "");
  const judgeCriteria = await readFileOrDefault(path.join(quackDir, "judge-criteria.md"), "");

  // 5. Discover convention check scripts
  const conventionCheckScripts = await discoverScripts(path.join(quackDir, "convention-checks"));

  // 6. Load ADR/convention docs from .quack/ and conventionsDir
  const adrSearchDirs = [quackDir];
  if (config.project.conventionsDir) {
    adrSearchDirs.push(path.resolve(absoluteRoot, config.project.conventionsDir));
  }
  const adrDocs = await loadAdrDocs(adrSearchDirs);

  return {
    config,
    projectRoot: absoluteRoot,
    conventionsDoc,
    judgeCriteria,
    conventionCheckScripts,
    adrDocs,
    adapterBundle: computeAdapterBundleMetadata(config),
  };
}
