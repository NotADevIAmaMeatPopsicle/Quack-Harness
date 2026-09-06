// ─── Global Config ─────────────────────────────────────────────────
// Manages persistent global configuration at ~/.quack/config.json.
// Stores registered projects, per-project settings, and monitor defaults.

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

import type { WorkerEnrollmentManifest, WorkerInstallCommand } from "../worker/enrollment-types.js";

// ─── Schema ────────────────────────────────────────────────────────

export interface ProjectEntry {
  /** Absolute path to the project root */
  path: string;
  /** Auto-run prep on task changes */
  autoPrep: boolean;
  /** Auto-run preflight on task changes */
  autoPreflight: boolean;
}

export interface MonitorSettings {
  /** HTTP port for the monitor dashboard */
  port: number;
}

export interface RemoteInstance {
  /** Unique identifier (slug from alias) */
  id: string;
  /** Human-readable display name (e.g. "my_remote_server") */
  alias: string;
  /** Hostname or IP of the remote machine */
  host: string;
  /** Local port for the SSH tunnel (dashboard connects to localhost:<localPort>) */
  localPort: number;
  /** Remote monitor port on the target machine */
  remotePort: number;
  /** SSH user@host string (e.g. "<your-username>@<remote-ip>") */
  sshTarget: string;
  /** Path to SSH private key (e.g. "~/.ssh/my_remote_server") */
  sshKeyPath: string;
  /** Health check interval in ms (default 30000) */
  healthCheckInterval?: number;
  /** Whether this remote is enabled */
  enabled: boolean;
}

export interface DeploymentMonitorLink {
  /** Short label shown in the UI. */
  label: string;
  /** Absolute URL for the external system. */
  url: string;
  /** Optional explanatory note. */
  description?: string;
}

export type DeploymentProbeKind = "json" | "html" | "text";

export interface DeploymentMonitorComponent {
  /** Stable identifier for the component; derived from label when omitted. */
  id?: string;
  /** Human-readable display name (for example "Web app staging"). */
  label: string;
  /** Absolute URL to probe for this component. */
  url: string;
  /** How the probe should treat the response body. Defaults to html. */
  probe?: DeploymentProbeKind;
  /** Optional category badge such as frontend, api, or worker. */
  category?: string;
  /** Free-form operator note. */
  notes?: string;
  /** Optional tags for filtering/grouping in the UI. */
  tags?: string[];
  /** Whether this component should be actively monitored. Defaults to true. */
  enabled?: boolean;
}

export interface DeploymentMonitorAwsAlarm {
  /** Exact CloudWatch alarm name to track. */
  name: string;
  /** Optional operator-friendly label. */
  label?: string;
}

export interface DeploymentMonitorAwsHealthCheck {
  /** Route53 health check ID. */
  id: string;
  /** Optional operator-friendly label. */
  label?: string;
  /** Optional path summary for the UI. */
  path?: string;
}

export interface DeploymentMonitorAwsLogGroup {
  /** Exact CloudWatch log group name. */
  name: string;
  /** Optional operator-friendly label. */
  label?: string;
  /** Age threshold before the log group is considered stale. */
  freshnessMinutes?: number;
}

export interface DeploymentMonitorAwsTopic {
  /** Exact SNS topic ARN. */
  arn: string;
  /** Optional operator-friendly label. */
  label?: string;
}

export interface DeploymentMonitorAwsExpectedMetric {
  /** CloudWatch namespace. */
  namespace: string;
  /** CloudWatch metric name expected to exist. */
  metricName: string;
  /** Optional operator-friendly label. */
  label?: string;
}

export interface DeploymentMonitorAwsBudget {
  /** Exact AWS Budget name. */
  name: string;
  /** Optional operator-friendly label. */
  label?: string;
}

export interface DeploymentMonitorAwsDashboard {
  /** Exact CloudWatch dashboard name. */
  name: string;
  /** Optional operator-friendly label. */
  label?: string;
}

export interface DeploymentMonitorAwsConfig {
  /** AWS account ID for validation and budget lookups. */
  accountId?: string;
  /** Region for CloudWatch, logs, and SNS calls. */
  region?: string;
  /** CloudWatch alarms that should exist for this environment. */
  alarms?: DeploymentMonitorAwsAlarm[];
  /** Route53 health checks covering the environment. */
  healthChecks?: DeploymentMonitorAwsHealthCheck[];
  /** Log groups used as freshness signals. */
  logGroups?: DeploymentMonitorAwsLogGroup[];
  /** SNS topics that should have subscribers. */
  topics?: DeploymentMonitorAwsTopic[];
  /** CloudWatch metrics that should be publishing data. */
  expectedMetrics?: DeploymentMonitorAwsExpectedMetric[];
  /** Budgets that should exist for this environment. */
  budgets?: DeploymentMonitorAwsBudget[];
  /** Dashboards that should exist for this environment. */
  dashboards?: DeploymentMonitorAwsDashboard[];
}

export interface DeploymentMonitor {
  /** Stable identifier for the monitored environment. */
  id: string;
  /** Human-readable display name (for example "Example staging"). */
  label: string;
  /** Service or app family this environment belongs to. */
  service?: string;
  /** Environment name such as staging, prod, qa, or preview. */
  environment: string;
  /** Hosting provider, for example aws. */
  provider: string;
  /** Optional provider region (for example us-east-1). */
  region?: string;
  /** Optional primary app URL used for HTML reachability checks. */
  appUrl?: string;
  /** Health endpoint to probe for status payloads. */
  healthUrl: string;
  /** Free-form operator notes. */
  notes?: string;
  /** Tags for filtering/grouping in the UI. */
  tags?: string[];
  /** Helpful links such as frontend, health, docs, or console targets. */
  links?: DeploymentMonitorLink[];
  /** Additional named components to probe alongside the core health/app checks. */
  components?: DeploymentMonitorComponent[];
  /** Optional AWS observability resources to inspect alongside runtime probes. */
  aws?: DeploymentMonitorAwsConfig;
  /** Whether the environment should be actively monitored. */
  enabled: boolean;
}

export type ControlPlaneMonitorKind =
  | "headnode-monitor"
  | "operator-sidecar"
  | "local-monitor"
  | "listener"
  | "custom";

export type ControlPlaneMonitorRoute = "primary" | "fallback" | "auxiliary";

export interface ControlPlaneMonitor {
  id?: string;
  label: string;
  kind?: ControlPlaneMonitorKind;
  /**
   * Route role for the control plane endpoint. `primary` should be the normal
   * canonical route, `fallback` should be a documented backup path, and
   * `auxiliary` is for related checks that do not represent the operator's
   * current base URL.
   */
  route?: ControlPlaneMonitorRoute;
  url: string;
  /** Additional base URLs that should be considered this same route. */
  routeAliases?: string[];
  probe?: DeploymentProbeKind;
  notes?: string;
  tags?: string[];
  enabled?: boolean;
}

export interface WorkerEnrollmentProfileRepo {
  id: string;
  label: string;
  sourceUrl: string;
  branch?: string;
  destination?: string;
  required?: boolean;
}

export interface WorkerEnrollmentProfileProject {
  id: string;
  label: string;
  repoId: string;
  pathAlias: string;
  primary?: boolean;
  installCommands?: WorkerInstallCommand[];
  probeCommands?: WorkerInstallCommand[];
  capabilityProbes?: Array<{
    capability: string;
    command: WorkerInstallCommand;
    description?: string;
  }>;
}

export interface WorkerEnrollmentProfile {
  id: string;
  label: string;
  controlBaseUrl?: string;
  runtimePort?: number;
  maxConcurrentJobs?: number;
  pollMs?: number;
  persistence?: WorkerEnrollmentManifest["worker"]["persistence"];
  capabilities?: string[];
  repos: WorkerEnrollmentProfileRepo[];
  projects: WorkerEnrollmentProfileProject[];
  manualSteps?: string[];
  env?: Array<{
    name: string;
    mode: "inline" | "manual";
    value?: string;
    placeholder?: string;
    description?: string;
    secretRef?: string;
  }>;
  secrets?: Array<{
    id: string;
    mode: "auto" | "manual";
    envName?: string;
    sourceEnvVar?: string;
    placeholder?: string;
    description?: string;
  }>;
}

export interface GlobalConfig {
  projects: ProjectEntry[];
  monitor: MonitorSettings;
  /** Active project ID last selected in the monitor UI/API. */
  activeProjectId?: string;
  remoteInstances?: RemoteInstance[];
  deploymentMonitors?: DeploymentMonitor[];
  controlPlaneMonitors?: ControlPlaneMonitor[];
  /** Legacy compatibility flag. Public builds have no built-in deployment targets. */
  disableBuiltInDeploymentMonitors?: boolean;
  workerProfiles?: WorkerEnrollmentProfile[];
}

const DEFAULT_CONFIG: GlobalConfig = {
  projects: [],
  monitor: { port: 3333 },
  activeProjectId: undefined,
  remoteInstances: [],
  deploymentMonitors: [],
  controlPlaneMonitors: [],
  disableBuiltInDeploymentMonitors: false,
  workerProfiles: [],
};

// ─── Path helpers ──────────────────────────────────────────────────

/**
 * Returns the home directory used for Quack global state.
 * QUACK_HOME is an opt-in override for tests and alternate host layouts.
 */
export function getConfigHome(): string {
  const explicitHome = process.env.QUACK_HOME?.trim();
  if (explicitHome) {
    return path.resolve(explicitHome);
  }
  return os.homedir();
}

/**
 * Returns the path to ~/.quack/config.json.
 */
export function getConfigPath(): string {
  return path.join(getConfigHome(), ".quack", "config.json");
}

/**
 * Normalize a project path for dedup comparison.
 * Uses path.resolve() and lowercases the drive letter on Windows.
 */
function normalizePath(p: string): string {
  let resolved = path.resolve(p);
  // Lowercase drive letter on Windows (C:\foo → c:\foo)
  if (process.platform === "win32" && /^[A-Z]:/.test(resolved)) {
    resolved = resolved[0].toLowerCase() + resolved.slice(1);
  }
  return resolved;
}

// ─── Load / Save ───────────────────────────────────────────────────

/**
 * Load the global config. Returns defaults if file is missing.
 * Throws on malformed JSON.
 */
export function loadGlobalConfig(): GlobalConfig {
  const configPath = getConfigPath();

  let raw: string;
  try {
    raw = fs.readFileSync(configPath, "utf-8");
  } catch (err: unknown) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      return { ...DEFAULT_CONFIG, projects: [] };
    }
    throw err;
  }

  const parsed = JSON.parse(raw.replace(/^\uFEFF/, "")) as Partial<GlobalConfig>;

  // Merge with defaults for forward compatibility
  return {
    projects: Array.isArray(parsed.projects)
      ? parsed.projects.map((p) => ({
          path: typeof p.path === "string" ? p.path : "",
          autoPrep: typeof p.autoPrep === "boolean" ? p.autoPrep : false,
          autoPreflight: typeof p.autoPreflight === "boolean" ? p.autoPreflight : false,
        }))
      : [],
    monitor: {
      port:
        parsed.monitor && typeof parsed.monitor.port === "number"
          ? parsed.monitor.port
          : DEFAULT_CONFIG.monitor.port,
    },
    activeProjectId:
      typeof parsed.activeProjectId === "string" && parsed.activeProjectId.trim().length > 0
        ? parsed.activeProjectId.trim()
        : undefined,
    remoteInstances: Array.isArray((parsed as Record<string, unknown>).remoteInstances)
      ? ((parsed as Record<string, unknown>).remoteInstances as RemoteInstance[])
      : [],
    deploymentMonitors: Array.isArray((parsed as Record<string, unknown>).deploymentMonitors)
      ? ((parsed as Record<string, unknown>).deploymentMonitors as DeploymentMonitor[])
      : [],
    controlPlaneMonitors: Array.isArray((parsed as Record<string, unknown>).controlPlaneMonitors)
      ? ((parsed as Record<string, unknown>).controlPlaneMonitors as ControlPlaneMonitor[])
      : [],
    disableBuiltInDeploymentMonitors:
      (parsed as Record<string, unknown>).disableBuiltInDeploymentMonitors === true,
    workerProfiles: Array.isArray((parsed as Record<string, unknown>).workerProfiles)
      ? ((parsed as Record<string, unknown>).workerProfiles as WorkerEnrollmentProfile[])
      : [],
  };
}

/**
 * Save the global config. Creates ~/.quack/ directory if needed.
 * Uses atomic write (write .tmp then rename), with direct-write fallback on Windows.
 */
export function saveGlobalConfig(config: GlobalConfig): void {
  const configPath = getConfigPath();
  const dir = path.dirname(configPath);

  fs.mkdirSync(dir, { recursive: true });

  const content = JSON.stringify(config, null, 2) + "\n";
  const tmpPath = configPath + ".tmp";

  fs.writeFileSync(tmpPath, content, "utf-8");

  try {
    fs.renameSync(tmpPath, configPath);
  } catch {
    // rename can fail on Windows if target file is open; fall back to direct write
    fs.writeFileSync(configPath, content, "utf-8");
    try {
      fs.unlinkSync(tmpPath);
    } catch {
      // Ignore cleanup failure
    }
  }
}

// ─── Project operations ────────────────────────────────────────────

/**
 * Register a project in the global config. Deduplicates by normalized path.
 */
export function registerProject(
  projectPath: string,
  settings?: Partial<Pick<ProjectEntry, "autoPrep" | "autoPreflight">>,
): void {
  const config = loadGlobalConfig();
  const normalized = normalizePath(projectPath);

  // Check for duplicates
  const exists = config.projects.some((p) => normalizePath(p.path) === normalized);
  if (exists) return; // Already registered — no-op

  config.projects.push({
    path: path.resolve(projectPath), // Store resolved but not lowercased
    autoPrep: settings?.autoPrep ?? false,
    autoPreflight: settings?.autoPreflight ?? false,
  });

  saveGlobalConfig(config);
}

/**
 * Unregister a project from the global config.
 * Returns true if the project was found and removed, false otherwise.
 */
export function unregisterProject(projectPath: string): boolean {
  const config = loadGlobalConfig();
  const normalized = normalizePath(projectPath);

  const before = config.projects.length;
  config.projects = config.projects.filter((p) => normalizePath(p.path) !== normalized);

  if (config.projects.length === before) return false;

  saveGlobalConfig(config);
  return true;
}

/**
 * Update settings for a registered project.
 * Throws if the project is not registered.
 */
export function updateProjectSettings(
  projectPath: string,
  settings: Partial<Pick<ProjectEntry, "autoPrep" | "autoPreflight">>,
): void {
  const config = loadGlobalConfig();
  const normalized = normalizePath(projectPath);

  const entry = config.projects.find((p) => normalizePath(p.path) === normalized);
  if (!entry) {
    throw new Error(`Project not registered: ${projectPath}`);
  }

  if (settings.autoPrep !== undefined) entry.autoPrep = settings.autoPrep;
  if (settings.autoPreflight !== undefined) entry.autoPreflight = settings.autoPreflight;

  saveGlobalConfig(config);
}

/**
 * Update the monitor section of the global config.
 */
export function updateMonitorSettings(settings: Partial<MonitorSettings>): void {
  const config = loadGlobalConfig();

  if (settings.port !== undefined) config.monitor.port = settings.port;

  saveGlobalConfig(config);
}

// ─── Remote Instance helpers ──────────────────────────────────────

/**
 * Generate an ID slug from an alias.
 */
export function slugifyAlias(alias: string): string {
  return alias
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

/**
 * Validate a remote instance configuration.
 * Returns an array of error strings (empty = valid).
 */
export function validateRemoteInstance(
  instance: Partial<RemoteInstance>,
  existingIds?: string[],
): string[] {
  const errors: string[] = [];

  if (!instance.alias || instance.alias.trim().length === 0) {
    errors.push("alias is required");
  } else if (existingIds) {
    const id = slugifyAlias(instance.alias);
    if (existingIds.includes(id)) {
      errors.push(`alias "${instance.alias}" is already in use`);
    }
  }

  if (!instance.host || !/^[\w.-]+$/.test(instance.host)) {
    errors.push("host must be a valid hostname or IP");
  }

  if (
    instance.localPort == null ||
    !Number.isInteger(instance.localPort) ||
    instance.localPort < 1024 ||
    instance.localPort > 65535
  ) {
    errors.push("localPort must be an integer between 1024 and 65535");
  }

  if (
    instance.remotePort == null ||
    !Number.isInteger(instance.remotePort) ||
    instance.remotePort < 1024 ||
    instance.remotePort > 65535
  ) {
    errors.push("remotePort must be an integer between 1024 and 65535");
  }

  if (!instance.sshTarget || !/^\w+@[\w.-]+$/.test(instance.sshTarget)) {
    errors.push("sshTarget must match user@host format");
  }

  if (!instance.sshKeyPath || instance.sshKeyPath.trim().length === 0) {
    errors.push("sshKeyPath is required");
  }

  return errors;
}
