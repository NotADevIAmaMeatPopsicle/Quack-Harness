import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import { spawn } from "node:child_process";
import type { Express, Request, Response } from "express";
import { z } from "zod";

import { validationDetails } from "../../intake/task-intake.js";

type WikiRootSource = "configured" | "env" | "detected" | "missing";

interface WikiGitChange {
  path: string;
  status: string;
}

interface WikiGitStatus {
  available: boolean;
  branch: string | null;
  upstream: string | null;
  headSha: string | null;
  ahead: number;
  behind: number;
  dirty: boolean;
  changedFiles: WikiGitChange[];
}

interface WikiStatusResponse {
  available: boolean;
  root: string | null;
  source: WikiRootSource;
  checkedPaths: string[];
  topLevelEntries: string[];
  git: WikiGitStatus;
}

interface WikiIndexEntry {
  path: string;
  section: string;
  title: string;
  summary: string;
  modifiedAt: string;
  sizeBytes: number;
  taskIds: string[];
}

interface WikiIndexResponse {
  root: string;
  count: number;
  entries: WikiIndexEntry[];
}

interface WikiTreeEntry {
  path: string;
  name: string;
  kind: "file" | "dir";
  sizeBytes: number | null;
  modifiedAt: string | null;
}

interface WikiTreeResponse {
  root: string;
  path: string;
  entries: WikiTreeEntry[];
}

interface WikiLinkRef {
  raw: string;
  target: string;
  label: string;
  resolvedPath: string | null;
}

interface WikiPageResponse {
  root: string;
  path: string;
  title: string;
  summary: string;
  frontmatter: Record<string, string | string[]>;
  content: string;
  body: string;
  modifiedAt: string;
  sizeBytes: number;
  sha256: string;
  taskIds: string[];
  links: WikiLinkRef[];
}

interface WikiSearchResult {
  path: string;
  title: string;
  summary: string;
  snippet: string;
  modifiedAt: string;
  score: number;
  taskIds: string[];
}

interface WikiSearchResponse {
  query: string;
  count: number;
  results: WikiSearchResult[];
}

interface WikiWriteResponse {
  ok: true;
  path: string;
  created: boolean;
  appended: boolean;
  modifiedAt: string;
  sizeBytes: number;
  sha256: string;
}

interface WikiArtifactResponse extends WikiWriteResponse {
  artifactType: "changelog" | "bug-report";
  reviewArtifact?: {
    pagePath: string;
    linkedTaskIds: string[];
    action: "changelog_entry";
  };
}

interface WikiGitActionResponse {
  ok: true;
  stdout: string;
  stderr: string;
  git: WikiGitStatus;
}

const MARKDOWN_EXTENSIONS = new Set([".md", ".markdown"]);
const HIDDEN_ROOTS = new Set([".git", ".obsidian", "node_modules"]);
const SEARCH_LIMIT_DEFAULT = 25;
const SEARCH_LIMIT_MAX = 100;

const writeModeSchema = z.enum(["create", "overwrite", "append"]);

const writePageSchema = z.object({
  path: z.string().trim().min(1),
  content: z.string(),
  mode: writeModeSchema.optional(),
  expectedSha256: z.string().trim().min(1).optional(),
  createDirectories: z.boolean().optional(),
});

const changelogArtifactSchema = z.object({
  taskId: z.string().trim().min(1),
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  project: z.string().trim().min(1).default("quack"),
  category: z.string().trim().min(1).default("quack"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  tags: z.array(z.string().trim().min(1)).default([]),
  linkedTasks: z.array(z.string().trim().min(1)).default([]),
  whatChanged: z.array(z.string().trim().min(1)).default([]),
  verification: z.array(z.string().trim().min(1)).default([]),
  overwrite: z.boolean().optional(),
});

const bugArtifactSchema = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().min(1),
  project: z.string().trim().min(1).default("quack"),
  category: z.string().trim().min(1).default("quack"),
  severity: z.string().trim().min(1).default("medium"),
  status: z.string().trim().min(1).default("open"),
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  slug: z.string().trim().min(1).optional(),
  taskId: z.string().trim().min(1).optional(),
  linkedTasks: z.array(z.string().trim().min(1)).default([]),
  tags: z.array(z.string().trim().min(1)).default([]),
  impact: z.string().trim().min(1).optional(),
  reproduction: z.array(z.string().trim().min(1)).default([]),
  notes: z.array(z.string().trim().min(1)).default([]),
  nextSteps: z.array(z.string().trim().min(1)).default([]),
  overwrite: z.boolean().optional(),
});

const gitCommitSchema = z.object({
  message: z.string().trim().min(1),
  paths: z.array(z.string().trim().min(1)).default([]),
  all: z.boolean().optional(),
});

const gitPullSchema = z.object({
  rebase: z.boolean().optional(),
  autostash: z.boolean().optional(),
  remote: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
});

const gitPushSchema = z.object({
  remote: z.string().trim().min(1).optional(),
  branch: z.string().trim().min(1).optional(),
  setUpstream: z.boolean().optional(),
});

class WikiRouteError extends Error {
  status: number;
  details?: unknown;

  constructor(status: number, message: string, details?: unknown) {
    super(message);
    this.name = "WikiRouteError";
    this.status = status;
    this.details = details;
  }
}

interface WikiRouteDeps {
  quackRoot: string;
  wikiRoot?: string;
  requireServiceScopeWhenConfigured: (req: Request, res: Response, scope: string) => boolean;
  requireServiceScopeAnyWhenConfigured: (req: Request, res: Response, scopes: string[]) => boolean;
}

interface WikiRepoResolution {
  root: string | null;
  source: WikiRootSource;
  checkedPaths: string[];
}

interface FileMatter {
  frontmatter: Record<string, string | string[]>;
  body: string;
}

function uniquePaths(
  values: Array<{ value: string; source: WikiRootSource }>,
): Array<{ value: string; source: WikiRootSource }> {
  const seen = new Set<string>();
  const result: Array<{ value: string; source: WikiRootSource }> = [];
  for (const entry of values) {
    const normalized = path.resolve(entry.value);
    if (seen.has(normalized)) continue;
    seen.add(normalized);
    result.push({ value: normalized, source: entry.source });
  }
  return result;
}

function detectWikiRepo(deps: WikiRouteDeps): WikiRepoResolution {
  const envRoot = process.env.QUACK_WIKI_ROOT;
  const candidates = uniquePaths([
    ...(deps.wikiRoot ? [{ value: deps.wikiRoot, source: "configured" as const }] : []),
    ...(envRoot ? [{ value: envRoot, source: "env" as const }] : []),
    { value: path.resolve(deps.quackRoot, "..", "project-wiki"), source: "detected" as const },
  ]);

  const checkedPaths = candidates.map((candidate) => candidate.value);
  for (const candidate of candidates) {
    try {
      const stat = fs.statSync(candidate.value);
      if (stat.isDirectory()) {
        return {
          root: candidate.value,
          source: candidate.source,
          checkedPaths,
        };
      }
    } catch {
      // Ignore missing candidates and continue.
    }
  }

  return {
    root: null,
    source: "missing",
    checkedPaths,
  };
}

function isMarkdownPath(relativePath: string): boolean {
  return MARKDOWN_EXTENSIONS.has(path.extname(relativePath).toLowerCase());
}

function ensureRelativePath(
  input: string,
  opts: { allowEmpty?: boolean; requireMarkdown?: boolean } = {},
): string {
  const raw = input.trim().replace(/\\/g, "/");
  if (!raw) {
    if (opts.allowEmpty) return "";
    throw new WikiRouteError(400, "path is required");
  }
  if (/^[A-Za-z]:\//.test(raw) || raw.startsWith("/") || raw.startsWith("\\")) {
    throw new WikiRouteError(400, `Absolute paths are not allowed: ${input}`);
  }

  const normalized = path.posix.normalize(raw);
  if (normalized === "." && opts.allowEmpty) return "";
  const parts = normalized.split("/").filter(Boolean);
  if (parts.length === 0) {
    if (opts.allowEmpty) return "";
    throw new WikiRouteError(400, "path is required");
  }
  if (
    parts.some(
      (part) => part === "." || part === ".." || HIDDEN_ROOTS.has(part) || part.startsWith("."),
    )
  ) {
    throw new WikiRouteError(400, `Path is outside the allowed wiki roots: ${input}`);
  }
  const relativePath = parts.join("/");
  if (opts.requireMarkdown && !isMarkdownPath(relativePath)) {
    throw new WikiRouteError(400, `Only markdown paths are supported: ${input}`);
  }
  return relativePath;
}

function resolveAbsolutePath(root: string, relativePath: string): string {
  const absolutePath = relativePath ? path.resolve(root, ...relativePath.split("/")) : root;
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new WikiRouteError(400, `Path escapes the wiki root: ${relativePath}`);
  }
  return absolutePath;
}

function sha256(content: string): string {
  return crypto.createHash("sha256").update(content).digest("hex");
}

function todayIsoDate(): string {
  return new Date().toISOString().slice(0, 10);
}

function slugify(value: string): string {
  return value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/-{2,}/g, "-");
}

function taskFileSlug(taskId: string): string {
  return slugify(taskId);
}

function formatFrontmatterArray(values: string[]): string {
  return `[${values.join(", ")}]`;
}

function parseFrontmatter(content: string): FileMatter {
  const match = content.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) {
    return {
      frontmatter: {},
      body: content,
    };
  }

  const raw = match[1] ?? "";
  const frontmatter: Record<string, string | string[]> = {};
  for (const line of raw.split(/\r?\n/)) {
    const separator = line.indexOf(":");
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    const value = line.slice(separator + 1).trim();
    if (!key || !value) continue;
    if (value.startsWith("[") && value.endsWith("]")) {
      const items = value
        .slice(1, -1)
        .split(",")
        .map((item) => item.trim().replace(/^['"]|['"]$/g, ""))
        .filter(Boolean);
      frontmatter[key] = items;
      continue;
    }
    frontmatter[key] = value.replace(/^['"]|['"]$/g, "");
  }

  return {
    frontmatter,
    body: content.slice(match[0].length),
  };
}

function extractTitle(markdown: string, fallbackPath: string): string {
  const heading = markdown.match(/^#\s+(.+)$/m);
  if (heading?.[1]) return heading[1].trim();
  const stem = path.posix.basename(fallbackPath, path.posix.extname(fallbackPath));
  return stem.replace(/[-_]+/g, " ");
}

function extractSummary(markdown: string): string {
  const lines = markdown.split(/\r?\n/);
  let sawTitle = false;
  const summaryLines: string[] = [];

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) {
      if (sawTitle && summaryLines.length > 0) break;
      continue;
    }
    if (!sawTitle && trimmed.startsWith("# ")) {
      sawTitle = true;
      continue;
    }
    if (trimmed.startsWith("## ")) break;
    if (trimmed.startsWith("---")) continue;
    if (trimmed.startsWith("```")) continue;
    if (trimmed.startsWith("|")) continue;
    summaryLines.push(trimmed);
    if (summaryLines.join(" ").length >= 220) break;
  }

  return summaryLines.join(" ").trim();
}

function extractTaskIds(content: string): string[] {
  const matches = content.match(/\bTASK-\d+[A-Z0-9-]*\b/g) ?? [];
  return [...new Set(matches)];
}

function isVisibleEntry(name: string, isDirectory: boolean): boolean {
  if (!name || name.startsWith(".")) return false;
  if (HIDDEN_ROOTS.has(name)) return false;
  if (isDirectory) return true;
  return isMarkdownPath(name);
}

async function listTopLevelEntries(root: string): Promise<string[]> {
  const entries = await fsPromises.readdir(root, { withFileTypes: true });
  return entries
    .filter((entry) => isVisibleEntry(entry.name, entry.isDirectory()))
    .map((entry) => entry.name)
    .sort((a, b) => a.localeCompare(b));
}

async function collectMarkdownPaths(root: string, relativePath = ""): Promise<string[]> {
  const absolutePath = resolveAbsolutePath(root, relativePath);
  const entries = await fsPromises.readdir(absolutePath, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
    if (!isVisibleEntry(entry.name, entry.isDirectory())) continue;
    const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      files.push(...(await collectMarkdownPaths(root, childRelative)));
      continue;
    }
    files.push(childRelative);
  }

  return files;
}

async function buildIndexEntry(root: string, relativePath: string): Promise<WikiIndexEntry> {
  const absolutePath = resolveAbsolutePath(root, relativePath);
  const [content, stat] = await Promise.all([
    fsPromises.readFile(absolutePath, "utf8"),
    fsPromises.stat(absolutePath),
  ]);
  const matter = parseFrontmatter(content);
  return {
    path: relativePath,
    section: relativePath.includes("/") ? relativePath.split("/")[0] : "root",
    title: extractTitle(matter.body, relativePath),
    summary: extractSummary(matter.body),
    modifiedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
    taskIds: extractTaskIds(content),
  };
}

function normalizeLinkTarget(value: string): string {
  return value.trim().replace(/\\/g, "/").replace(/\.md$/i, "");
}

function resolveWikiLinkTarget(
  target: string,
  currentPath: string,
  availablePaths: string[],
): string | null {
  const normalizedTarget = normalizeLinkTarget(target);
  if (!normalizedTarget) return null;

  const availableNoExt = availablePaths.map((entry) => ({
    full: entry,
    noExt: entry.replace(/\.md$/i, ""),
    basename: path.posix.basename(entry, path.posix.extname(entry)),
  }));
  const currentDir = path.posix.dirname(currentPath);
  const candidateKeys = [
    normalizedTarget,
    path.posix.join(currentDir, normalizedTarget),
    normalizedTarget.startsWith("wiki/") ||
    normalizedTarget.startsWith("raw/") ||
    normalizedTarget.startsWith("schema/")
      ? normalizedTarget
      : `wiki/${normalizedTarget}`,
  ];

  for (const key of candidateKeys) {
    const exact = availableNoExt.find((entry) => entry.noExt === key);
    if (exact) return exact.full;
  }

  const basenameExact = availableNoExt.filter((entry) => entry.basename === normalizedTarget);
  if (basenameExact.length === 1) return basenameExact[0].full;

  const suffixMatch = availableNoExt.filter((entry) =>
    entry.basename.endsWith(`-${normalizedTarget}`),
  );
  if (suffixMatch.length === 1) return suffixMatch[0].full;

  return null;
}

function extractWikiLinks(
  body: string,
  currentPath: string,
  availablePaths: string[],
): WikiLinkRef[] {
  const links: WikiLinkRef[] = [];
  const seen = new Set<string>();
  const regex = /\[\[([^\]|]+)(?:\|([^\]]+))?\]\]/g;
  let match: RegExpExecArray | null = regex.exec(body);
  while (match) {
    const target = (match[1] ?? "").trim();
    const label = (match[2] ?? match[1] ?? "").trim();
    const raw = match[0];
    const key = `${raw}::${target}::${label}`;
    if (!seen.has(key)) {
      seen.add(key);
      links.push({
        raw,
        target,
        label,
        resolvedPath: resolveWikiLinkTarget(target, currentPath, availablePaths),
      });
    }
    match = regex.exec(body);
  }
  return links;
}

function escapeSnippet(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function buildSearchSnippet(body: string, query: string): string {
  const flat = escapeSnippet(body);
  const lower = flat.toLowerCase();
  const index = lower.indexOf(query.toLowerCase());
  if (index === -1) return flat.slice(0, 220);
  const start = Math.max(0, index - 60);
  const end = Math.min(flat.length, index + query.length + 120);
  const prefix = start > 0 ? "..." : "";
  const suffix = end < flat.length ? "..." : "";
  return `${prefix}${flat.slice(start, end)}${suffix}`;
}

async function searchWiki(root: string, query: string, limit: number): Promise<WikiSearchResult[]> {
  const files = await collectMarkdownPaths(root);
  const normalizedQuery = query.trim().toLowerCase();
  if (!normalizedQuery) return [];

  const results: WikiSearchResult[] = [];
  for (const relativePath of files) {
    const absolutePath = resolveAbsolutePath(root, relativePath);
    const [content, stat] = await Promise.all([
      fsPromises.readFile(absolutePath, "utf8"),
      fsPromises.stat(absolutePath),
    ]);
    const matter = parseFrontmatter(content);
    const title = extractTitle(matter.body, relativePath);
    const summary = extractSummary(matter.body);
    const haystack = `${relativePath}\n${title}\n${summary}\n${matter.body}`.toLowerCase();
    const matchIndex = haystack.indexOf(normalizedQuery);
    if (matchIndex === -1) continue;

    let score = 10;
    if (relativePath.toLowerCase().includes(normalizedQuery)) score += 40;
    if (title.toLowerCase().includes(normalizedQuery)) score += 30;
    if (summary.toLowerCase().includes(normalizedQuery)) score += 20;

    results.push({
      path: relativePath,
      title,
      summary,
      snippet: buildSearchSnippet(matter.body, query),
      modifiedAt: stat.mtime.toISOString(),
      score,
      taskIds: extractTaskIds(content),
    });
  }

  return results.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path)).slice(0, limit);
}

function parseBranchHeader(header: string): {
  branch: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
} {
  const raw = header.replace(/^##\s*/, "").trim();
  const bracketStart = raw.indexOf(" [");
  const head = bracketStart >= 0 ? raw.slice(0, bracketStart) : raw;
  const bracket = bracketStart >= 0 ? raw.slice(bracketStart + 2, -1) : "";
  const branchMatch = head.match(/^([^.\s]+)(?:\.\.\.([^\s]+))?/);
  const branch = branchMatch?.[1] ?? null;
  const upstream = branchMatch?.[2] ?? null;
  let ahead = 0;
  let behind = 0;
  const aheadMatch = bracket.match(/ahead\s+(\d+)/);
  const behindMatch = bracket.match(/behind\s+(\d+)/);
  if (aheadMatch?.[1]) ahead = Number(aheadMatch[1]);
  if (behindMatch?.[1]) behind = Number(behindMatch[1]);
  return { branch, upstream, ahead, behind };
}

async function runGit(
  root: string,
  args: string[],
): Promise<{ stdout: string; stderr: string; exitCode: number }> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", ["-C", root, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: "0",
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer | string) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk: Buffer | string) => {
      stderr += String(chunk);
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        stdout: stdout.trim(),
        stderr: stderr.trim(),
        exitCode: code ?? 0,
      });
    });
  });
}

async function readGitStatus(root: string): Promise<WikiGitStatus> {
  const inside = await runGit(root, ["rev-parse", "--is-inside-work-tree"]);
  if (inside.exitCode !== 0 || inside.stdout !== "true") {
    return {
      available: false,
      branch: null,
      upstream: null,
      headSha: null,
      ahead: 0,
      behind: 0,
      dirty: false,
      changedFiles: [],
    };
  }

  const [status, head] = await Promise.all([
    runGit(root, ["status", "--porcelain=v1", "-b", "-uall"]),
    runGit(root, ["rev-parse", "HEAD"]),
  ]);
  if (status.exitCode !== 0) {
    throw new WikiRouteError(500, status.stderr || "Failed to read wiki git status");
  }

  const lines = status.stdout.split(/\r?\n/).filter(Boolean);
  const header = lines[0] ?? "";
  const branchInfo = parseBranchHeader(header);
  const changedFiles = lines.slice(1).map((line) => ({
    status: line.slice(0, 2).trim() || "??",
    path: line.slice(3).trim(),
  }));

  return {
    available: true,
    branch: branchInfo.branch,
    upstream: branchInfo.upstream,
    headSha: head.exitCode === 0 ? head.stdout : null,
    ahead: branchInfo.ahead,
    behind: branchInfo.behind,
    dirty: changedFiles.length > 0,
    changedFiles,
  };
}

// eslint-disable-next-line @typescript-eslint/require-await
async function requireWikiRoot(
  deps: WikiRouteDeps,
): Promise<WikiRepoResolution & { root: string }> {
  const repo = detectWikiRepo(deps);
  if (!repo.root) {
    throw new WikiRouteError(404, "Wiki root could not be located", {
      checkedPaths: repo.checkedPaths,
    });
  }
  return {
    ...repo,
    root: repo.root,
  };
}

async function buildWikiStatus(deps: WikiRouteDeps): Promise<WikiStatusResponse> {
  const repo = detectWikiRepo(deps);
  if (!repo.root) {
    return {
      available: false,
      root: null,
      source: repo.source,
      checkedPaths: repo.checkedPaths,
      topLevelEntries: [],
      git: {
        available: false,
        branch: null,
        upstream: null,
        headSha: null,
        ahead: 0,
        behind: 0,
        dirty: false,
        changedFiles: [],
      },
    };
  }

  const [entries, git] = await Promise.all([
    listTopLevelEntries(repo.root),
    readGitStatus(repo.root),
  ]);

  return {
    available: true,
    root: repo.root,
    source: repo.source,
    checkedPaths: repo.checkedPaths,
    topLevelEntries: entries,
    git,
  };
}

async function readWikiPage(root: string, relativePath: string): Promise<WikiPageResponse> {
  const normalizedPath = ensureRelativePath(relativePath, { requireMarkdown: true });
  const absolutePath = resolveAbsolutePath(root, normalizedPath);
  let content: string;
  let stat: Awaited<ReturnType<typeof fsPromises.stat>>;
  try {
    [content, stat] = await Promise.all([
      fsPromises.readFile(absolutePath, "utf8"),
      fsPromises.stat(absolutePath),
    ]);
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new WikiRouteError(404, `Wiki page not found: ${normalizedPath}`, { cause: msg });
  }

  const matter = parseFrontmatter(content);
  const availablePaths = await collectMarkdownPaths(root);
  return {
    root,
    path: normalizedPath,
    title: extractTitle(matter.body, normalizedPath),
    summary: extractSummary(matter.body),
    frontmatter: matter.frontmatter,
    content,
    body: matter.body,
    modifiedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
    sha256: sha256(content),
    taskIds: extractTaskIds(content),
    links: extractWikiLinks(matter.body, normalizedPath, availablePaths),
  };
}

async function writeWikiPage(
  root: string,
  inputPath: string,
  content: string,
  options: {
    mode?: "create" | "overwrite" | "append";
    expectedSha256?: string;
    createDirectories?: boolean;
  } = {},
): Promise<WikiWriteResponse> {
  const relativePath = ensureRelativePath(inputPath, { requireMarkdown: true });
  const absolutePath = resolveAbsolutePath(root, relativePath);
  const mode = options.mode ?? "overwrite";
  const createDirectories = options.createDirectories ?? true;

  let existingContent: string | null = null;
  let existed = false;
  try {
    existingContent = await fsPromises.readFile(absolutePath, "utf8");
    existed = true;
  } catch {
    existed = false;
  }

  if (options.expectedSha256 && sha256(existingContent ?? "") !== options.expectedSha256) {
    throw new WikiRouteError(409, `Wiki page changed since it was last read: ${relativePath}`, {
      expectedSha256: options.expectedSha256,
      actualSha256: sha256(existingContent ?? ""),
    });
  }

  if (mode === "create" && existed) {
    throw new WikiRouteError(409, `Wiki page already exists: ${relativePath}`);
  }

  if (createDirectories) {
    await fsPromises.mkdir(path.dirname(absolutePath), { recursive: true });
  }

  const nextContent = mode === "append" ? `${existingContent ?? ""}${content}` : content;
  await fsPromises.writeFile(absolutePath, nextContent, "utf8");
  const stat = await fsPromises.stat(absolutePath);

  return {
    ok: true,
    path: relativePath,
    created: !existed,
    appended: mode === "append",
    modifiedAt: stat.mtime.toISOString(),
    sizeBytes: stat.size,
    sha256: sha256(nextContent),
  };
}

function buildChangelogMarkdown(input: z.infer<typeof changelogArtifactSchema>): {
  path: string;
  content: string;
  linkedTaskIds: string[];
} {
  const date = input.date ?? todayIsoDate();
  const linkedTaskIds = [...new Set([input.taskId, ...input.linkedTasks])];
  const tags = [...new Set([input.project, input.category, ...input.tags])];
  const heading = `${date} - ${input.taskId} VERIFIED: ${input.title}`;

  const lines = [
    "---",
    `date: ${date}`,
    `project: ${input.project}`,
    "kind: changelog",
    `category: ${input.category}`,
    `tags: ${formatFrontmatterArray(tags)}`,
    `linkedTasks: ${formatFrontmatterArray(linkedTaskIds)}`,
    "---",
    "",
    `# ${heading}`,
    "",
    "## Summary",
    "",
    input.summary,
    "",
    "## What Changed",
    "",
    ...(input.whatChanged.length > 0
      ? input.whatChanged.map((item) => `- ${item}`)
      : ["- Details pending update."]),
    "",
    "## Verification",
    "",
    ...(input.verification.length > 0
      ? input.verification.map((item) => `- ${item}`)
      : ["- Verification notes pending."]),
    "",
  ];

  return {
    path: `raw/platform/changelog/${date}-${taskFileSlug(input.taskId)}.md`,
    content: lines.join("\n"),
    linkedTaskIds,
  };
}

function buildBugReportMarkdown(input: z.infer<typeof bugArtifactSchema>): {
  path: string;
  content: string;
} {
  const date = input.date ?? todayIsoDate();
  const slug = input.slug
    ? slugify(input.slug)
    : input.taskId
      ? taskFileSlug(input.taskId)
      : slugify(input.title);
  const linkedTaskIds = input.taskId
    ? [...new Set([input.taskId, ...input.linkedTasks])]
    : [...new Set(input.linkedTasks)];
  const tags = [...new Set([input.project, input.category, "bug", input.severity, ...input.tags])];

  const lines = [
    "---",
    `date: ${date}`,
    `project: ${input.project}`,
    "kind: bug-report",
    `category: ${input.category}`,
    `severity: ${input.severity}`,
    `status: ${input.status}`,
    `tags: ${formatFrontmatterArray(tags)}`,
    ...(linkedTaskIds.length > 0 ? [`linkedTasks: ${formatFrontmatterArray(linkedTaskIds)}`] : []),
    "---",
    "",
    `# ${date} - Bug Report: ${input.title}`,
    "",
    "## Summary",
    "",
    input.summary,
    "",
    ...(input.impact ? ["## Impact", "", input.impact, ""] : []),
    ...(input.reproduction.length > 0
      ? ["## Reproduction", "", ...input.reproduction.map((item) => `- ${item}`), ""]
      : []),
    ...(input.notes.length > 0
      ? ["## Notes", "", ...input.notes.map((item) => `- ${item}`), ""]
      : []),
    ...(input.nextSteps.length > 0
      ? ["## Next Steps", "", ...input.nextSteps.map((item) => `- ${item}`), ""]
      : []),
  ];

  return {
    path: `raw/platform/bug-reports/${date}-${slug}.md`,
    content: lines.join("\n"),
  };
}

async function commitWikiChanges(
  root: string,
  input: z.infer<typeof gitCommitSchema>,
): Promise<WikiGitActionResponse> {
  if (input.all === true && input.paths.length > 0) {
    throw new WikiRouteError(400, "Specify either all=true or an explicit paths[] list, not both.");
  }

  if (input.all === true) {
    const addAll = await runGit(root, ["add", "-A"]);
    if (addAll.exitCode !== 0) {
      throw new WikiRouteError(409, addAll.stderr || "Failed to stage wiki changes.");
    }
  } else {
    const normalizedPaths = input.paths.map((entry) => ensureRelativePath(entry));
    if (normalizedPaths.length === 0) {
      throw new WikiRouteError(400, "Provide paths[] or set all=true when creating a wiki commit.");
    }
    const addSelected = await runGit(root, ["add", "--", ...normalizedPaths]);
    if (addSelected.exitCode !== 0) {
      throw new WikiRouteError(
        409,
        addSelected.stderr || "Failed to stage the requested wiki paths.",
      );
    }
  }

  const staged = await runGit(root, ["diff", "--cached", "--name-only"]);
  if (staged.exitCode !== 0) {
    throw new WikiRouteError(409, staged.stderr || "Failed to inspect staged wiki changes.");
  }
  if (!staged.stdout.trim()) {
    throw new WikiRouteError(409, "No staged wiki changes to commit.");
  }

  const commit = await runGit(root, ["commit", "-m", input.message]);
  if (commit.exitCode !== 0) {
    throw new WikiRouteError(
      409,
      commit.stderr || commit.stdout || "Failed to commit wiki changes.",
    );
  }

  return {
    ok: true,
    stdout: commit.stdout,
    stderr: commit.stderr,
    git: await readGitStatus(root),
  };
}

async function pullWikiChanges(
  root: string,
  input: z.infer<typeof gitPullSchema>,
): Promise<WikiGitActionResponse> {
  const args = ["pull"];
  if (input.rebase !== false) args.push("--rebase");
  if (input.autostash === true) args.push("--autostash");
  if (input.remote) args.push(input.remote);
  if (input.branch) args.push(input.branch);
  const pull = await runGit(root, args);
  if (pull.exitCode !== 0) {
    throw new WikiRouteError(409, pull.stderr || pull.stdout || "Failed to pull wiki changes.");
  }
  return {
    ok: true,
    stdout: pull.stdout,
    stderr: pull.stderr,
    git: await readGitStatus(root),
  };
}

async function pushWikiChanges(
  root: string,
  input: z.infer<typeof gitPushSchema>,
): Promise<WikiGitActionResponse> {
  const git = await readGitStatus(root);
  const branch = input.branch ?? git.branch;
  if (!branch) {
    throw new WikiRouteError(409, "Wiki repo does not have an active branch to push.");
  }

  const args = ["push"];
  if (input.setUpstream === true) args.push("--set-upstream");
  args.push(input.remote ?? "origin", branch);
  const push = await runGit(root, args);
  if (push.exitCode !== 0) {
    throw new WikiRouteError(409, push.stderr || push.stdout || "Failed to push wiki changes.");
  }
  return {
    ok: true,
    stdout: push.stdout,
    stderr: push.stderr,
    git: await readGitStatus(root),
  };
}

function sendWikiError(res: Response, err: unknown, fallback: string): void {
  if (err instanceof WikiRouteError) {
    res.status(err.status).json({
      error: err.message,
      details: err.details,
    });
    return;
  }
  const message = err instanceof Error ? err.message : fallback;
  res.status(500).json({ error: message });
}

interface WikiRouteGuards {
  allowRead: (req: Request, res: Response) => boolean;
  allowWrite: (req: Request, res: Response) => boolean;
  allowSync: (req: Request, res: Response) => boolean;
}

function registerMount(
  app: Express,
  prefix: string,
  deps: WikiRouteDeps,
  guards: WikiRouteGuards,
): void {
  app.get(`${prefix}/status`, async (_req: Request, res: Response) => {
    if (!guards.allowRead(_req, res)) return;
    try {
      res.json(await buildWikiStatus(deps));
    } catch (err: unknown) {
      sendWikiError(res, err, "Failed to read wiki status.");
    }
  });

  app.get(`${prefix}/index`, async (req: Request, res: Response) => {
    if (!guards.allowRead(req, res)) return;
    try {
      const repo = await requireWikiRoot(deps);
      const pathPrefix =
        typeof req.query.pathPrefix === "string"
          ? ensureRelativePath(req.query.pathPrefix, { allowEmpty: true })
          : "";
      const files = await collectMarkdownPaths(repo.root, pathPrefix);
      const entries = await Promise.all(
        files.map((relativePath) => buildIndexEntry(repo.root, relativePath)),
      );
      res.json({
        root: repo.root,
        count: entries.length,
        entries,
      } satisfies WikiIndexResponse);
    } catch (err: unknown) {
      sendWikiError(res, err, "Failed to build wiki index.");
    }
  });

  app.get(`${prefix}/tree`, async (req: Request, res: Response) => {
    if (!guards.allowRead(req, res)) return;
    try {
      const repo = await requireWikiRoot(deps);
      const relativePath =
        typeof req.query.path === "string"
          ? ensureRelativePath(req.query.path, { allowEmpty: true })
          : "";
      const absolutePath = resolveAbsolutePath(repo.root, relativePath);
      const stat = await fsPromises.stat(absolutePath);
      if (!stat.isDirectory()) {
        throw new WikiRouteError(400, `Path is not a directory: ${relativePath}`);
      }

      const entries = await fsPromises.readdir(absolutePath, { withFileTypes: true });
      const responseEntries: WikiTreeEntry[] = [];
      for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
        if (!isVisibleEntry(entry.name, entry.isDirectory())) continue;
        const childRelative = relativePath ? `${relativePath}/${entry.name}` : entry.name;
        if (entry.isDirectory()) {
          responseEntries.push({
            path: childRelative,
            name: entry.name,
            kind: "dir",
            sizeBytes: null,
            modifiedAt: null,
          });
          continue;
        }
        const childStat = await fsPromises.stat(resolveAbsolutePath(repo.root, childRelative));
        responseEntries.push({
          path: childRelative,
          name: entry.name,
          kind: "file",
          sizeBytes: childStat.size,
          modifiedAt: childStat.mtime.toISOString(),
        });
      }

      res.json({
        root: repo.root,
        path: relativePath,
        entries: responseEntries,
      } satisfies WikiTreeResponse);
    } catch (err: unknown) {
      sendWikiError(res, err, "Failed to list wiki directory.");
    }
  });

  app.get(`${prefix}/page`, async (req: Request, res: Response) => {
    if (!guards.allowRead(req, res)) return;
    try {
      const repo = await requireWikiRoot(deps);
      const requestedPath = typeof req.query.path === "string" ? req.query.path : "";
      res.json(await readWikiPage(repo.root, requestedPath));
    } catch (err: unknown) {
      sendWikiError(res, err, "Failed to read wiki page.");
    }
  });

  app.get(`${prefix}/search`, async (req: Request, res: Response) => {
    if (!guards.allowRead(req, res)) return;
    try {
      const repo = await requireWikiRoot(deps);
      const query = typeof req.query.q === "string" ? req.query.q.trim() : "";
      const limitRaw =
        typeof req.query.limit === "string" ? Number(req.query.limit) : SEARCH_LIMIT_DEFAULT;
      const limit = Number.isFinite(limitRaw)
        ? Math.max(1, Math.min(SEARCH_LIMIT_MAX, limitRaw))
        : SEARCH_LIMIT_DEFAULT;
      const results = await searchWiki(repo.root, query, limit);
      res.json({
        query,
        count: results.length,
        results,
      } satisfies WikiSearchResponse);
    } catch (err: unknown) {
      sendWikiError(res, err, "Failed to search wiki.");
    }
  });

  app.post(`${prefix}/page`, async (req: Request, res: Response) => {
    if (!guards.allowWrite(req, res)) return;
    const parsed = writePageSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_wiki_write_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }
    try {
      const repo = await requireWikiRoot(deps);
      const result = await writeWikiPage(repo.root, parsed.data.path, parsed.data.content, {
        mode: parsed.data.mode,
        expectedSha256: parsed.data.expectedSha256,
        createDirectories: parsed.data.createDirectories,
      });
      res.status(result.created ? 201 : 200).json(result);
    } catch (err: unknown) {
      sendWikiError(res, err, "Failed to write wiki page.");
    }
  });

  app.post(`${prefix}/artifacts/changelog`, async (req: Request, res: Response) => {
    if (!guards.allowWrite(req, res)) return;
    const parsed = changelogArtifactSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_wiki_changelog_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }
    try {
      const repo = await requireWikiRoot(deps);
      const artifact = buildChangelogMarkdown(parsed.data);
      const write = await writeWikiPage(repo.root, artifact.path, artifact.content, {
        mode: parsed.data.overwrite === true ? "overwrite" : "create",
        createDirectories: true,
      });
      res.status(write.created ? 201 : 200).json({
        ...write,
        artifactType: "changelog",
        reviewArtifact: {
          pagePath: artifact.path,
          linkedTaskIds: artifact.linkedTaskIds,
          action: "changelog_entry",
        },
      } satisfies WikiArtifactResponse);
    } catch (err: unknown) {
      sendWikiError(res, err, "Failed to create wiki changelog artifact.");
    }
  });

  app.post(`${prefix}/artifacts/bug-report`, async (req: Request, res: Response) => {
    if (!guards.allowWrite(req, res)) return;
    const parsed = bugArtifactSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_wiki_bug_report_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }
    try {
      const repo = await requireWikiRoot(deps);
      const artifact = buildBugReportMarkdown(parsed.data);
      const write = await writeWikiPage(repo.root, artifact.path, artifact.content, {
        mode: parsed.data.overwrite === true ? "overwrite" : "create",
        createDirectories: true,
      });
      res.status(write.created ? 201 : 200).json({
        ...write,
        artifactType: "bug-report",
      } satisfies WikiArtifactResponse);
    } catch (err: unknown) {
      sendWikiError(res, err, "Failed to create wiki bug report artifact.");
    }
  });

  app.get(`${prefix}/git/status`, async (req: Request, res: Response) => {
    if (!guards.allowRead(req, res)) return;
    try {
      const repo = await requireWikiRoot(deps);
      res.json(await readGitStatus(repo.root));
    } catch (err: unknown) {
      sendWikiError(res, err, "Failed to read wiki git status.");
    }
  });

  app.post(`${prefix}/git/commit`, async (req: Request, res: Response) => {
    if (!guards.allowSync(req, res)) return;
    const parsed = gitCommitSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_wiki_git_commit_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }
    try {
      const repo = await requireWikiRoot(deps);
      res.json(await commitWikiChanges(repo.root, parsed.data));
    } catch (err: unknown) {
      sendWikiError(res, err, "Failed to commit wiki changes.");
    }
  });

  app.post(`${prefix}/git/pull`, async (req: Request, res: Response) => {
    if (!guards.allowSync(req, res)) return;
    const parsed = gitPullSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_wiki_git_pull_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }
    try {
      const repo = await requireWikiRoot(deps);
      res.json(await pullWikiChanges(repo.root, parsed.data));
    } catch (err: unknown) {
      sendWikiError(res, err, "Failed to pull wiki changes.");
    }
  });

  app.post(`${prefix}/git/push`, async (req: Request, res: Response) => {
    if (!guards.allowSync(req, res)) return;
    const parsed = gitPushSchema.safeParse(req.body ?? {});
    if (!parsed.success) {
      res.status(400).json({
        error: "invalid_wiki_git_push_payload",
        details: validationDetails(parsed.error),
      });
      return;
    }
    try {
      const repo = await requireWikiRoot(deps);
      res.json(await pushWikiChanges(repo.root, parsed.data));
    } catch (err: unknown) {
      sendWikiError(res, err, "Failed to push wiki changes.");
    }
  });
}

export function registerWikiRoutes(app: Express, deps: WikiRouteDeps): void {
  registerMount(app, "/api/wiki", deps, {
    allowRead: () => true,
    allowWrite: () => true,
    allowSync: () => true,
  });

  registerMount(app, "/v1/wiki", deps, {
    allowRead: (req, res) =>
      deps.requireServiceScopeAnyWhenConfigured(req, res, [
        "wiki:read",
        "wiki:write",
        "wiki:sync",
        "admin:read",
        "admin:write",
        "federation:write",
      ]),
    allowWrite: (req, res) =>
      deps.requireServiceScopeAnyWhenConfigured(req, res, [
        "wiki:write",
        "wiki:sync",
        "admin:write",
        "federation:write",
      ]),
    allowSync: (req, res) =>
      deps.requireServiceScopeAnyWhenConfigured(req, res, [
        "wiki:sync",
        "admin:write",
        "federation:write",
      ]),
  });
}
