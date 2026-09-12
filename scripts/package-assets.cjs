"use strict";

const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");

const PUBLIC_RESOURCES = Object.freeze([
  "README.md",
  "ARCHITECTURE.md",
  "SECURITY.md",
  "docs/GETTING-STARTED.md",
  "docs/ADAPTER_CONFIG_REFERENCE.md",
  "docs/CLI_REFERENCE.md",
  "docs/API_REFERENCE.md",
  "docs/TROUBLESHOOTING.md",
]);

const RUNTIME_SCRIPTS = Object.freeze([
  "scripts/postinstall.cjs",
  "scripts/package-assets.cjs",
  "scripts/quack-listener.mjs",
  "scripts/quack-verify.mjs",
  "scripts/admin/install-windows-worker.ps1",
]);

const REQUIRED_FILES = Object.freeze([
  "package.json",
  "LICENSE",
  "CHANGELOG.md",
  "dist/index.js",
  "dist/index.d.ts",
  "dist/build-info.json",
  "dist/monitor/public/index.html",
  "dist/monitor/ui/index.html",
  ...RUNTIME_SCRIPTS,
  ...PUBLIC_RESOURCES,
]);

function pathExists(filePath) {
  try {
    fs.statSync(filePath);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}

function requireFile(root, relativePath) {
  const absolutePath = path.resolve(root, relativePath);
  const relative = path.relative(root, absolutePath);
  if (relative.startsWith(`..${path.sep}`) || relative === ".." || path.isAbsolute(relative)) {
    throw new Error(`Package asset escapes its root: ${relativePath}`);
  }
  const stats = fs.statSync(absolutePath);
  if (!stats.isFile() || stats.size === 0) {
    throw new Error(`Required package file is empty or not a file: ${relativePath}`);
  }
  return absolutePath;
}

function localUiReferences(html) {
  const references = [];
  for (const match of html.matchAll(/(?:src|href)=["']([^"']+)["']/gu)) {
    const value = match[1];
    if (/^(?:[a-z][a-z0-9+.-]*:|\/\/|#)/iu.test(value)) continue;
    const withoutQuery = value.split(/[?#]/u)[0];
    if (withoutQuery) references.push(decodeURIComponent(withoutQuery).replace(/^\/+/, ""));
  }
  return [...new Set(references)];
}

function assertPackagedRuntime(root) {
  for (const relativePath of REQUIRED_FILES) requireFile(root, relativePath);
  const uiRoot = path.join(root, "dist", "monitor", "ui");
  const html = fs.readFileSync(path.join(uiRoot, "index.html"), "utf8");
  const uiReferences = localUiReferences(html);
  if (!uiReferences.some((reference) => /\.js$/u.test(reference))) {
    throw new Error("The packaged modern UI has no compiled JavaScript entry point.");
  }
  for (const reference of uiReferences) requireFile(uiRoot, reference);
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8"));
  const build = JSON.parse(fs.readFileSync(path.join(root, "dist", "build-info.json"), "utf8"));
  if (build.version !== manifest.version || typeof build.commit !== "string" || !build.commit) {
    throw new Error("Packaged build identity is missing or does not match the package version.");
  }
  return { manifest, build, uiReferences };
}

function runNpm(root, args) {
  const npmCli = process.env.npm_execpath;
  if (!npmCli || !path.isAbsolute(npmCli) || !fs.statSync(npmCli).isFile()) {
    throw new Error("Run this package lifecycle through npm so its absolute npm CLI is available.");
  }
  const result = spawnSync(process.execPath, [npmCli, ...args], {
    cwd: root,
    shell: false,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    const error = new Error(
      `npm ${args.join(" ")} failed (${result.signal ? `signal ${result.signal}` : `exit ${result.status}`}).`,
    );
    error.exitCode = result.status === null ? 1 : result.status;
    throw error;
  }
}

module.exports = {
  PUBLIC_RESOURCES,
  RUNTIME_SCRIPTS,
  REQUIRED_FILES,
  pathExists,
  requireFile,
  localUiReferences,
  assertPackagedRuntime,
  runNpm,
};
