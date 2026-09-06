import type { Express, Request, Response } from "express";

import type {
  ControlPlaneMonitor,
  ControlPlaneMonitorRoute,
  DeploymentMonitor,
  DeploymentMonitorAwsAlarm,
  DeploymentMonitorAwsBudget,
  DeploymentMonitorAwsConfig,
  DeploymentMonitorAwsDashboard,
  DeploymentMonitorAwsExpectedMetric,
  DeploymentMonitorAwsHealthCheck,
  DeploymentMonitorAwsLogGroup,
  DeploymentMonitorAwsTopic,
  DeploymentMonitorComponent,
  DeploymentMonitorLink,
  DeploymentProbeKind,
} from "../../core/global-config.js";
import type {
  ControlPlaneMonitoringStatus,
  ControlPlaneProbeStatus,
  DeploymentMonitoringResponse,
  DeploymentMonitorComponentStatus,
  DeploymentMonitorIdentity,
  DeploymentMonitorRollup,
  DeploymentMonitorStatus,
  DeploymentProbeResult,
} from "../api-contracts.js";
import { collectAwsObservability } from "../aws-observability.js";

type DeploymentMonitorSource = "configured" | "default";

interface ResolvedDeploymentComponent {
  id: string;
  label: string;
  url: string;
  probe: DeploymentProbeKind;
  category: string;
  notes?: string;
  tags: string[];
  enabled: boolean;
}

interface ResolvedDeploymentMonitor {
  id: string;
  label: string;
  service?: string;
  environment: string;
  provider: string;
  region?: string;
  appUrl?: string;
  healthUrl: string;
  notes?: string;
  tags: string[];
  links: DeploymentMonitorLink[];
  components: ResolvedDeploymentComponent[];
  aws?: DeploymentMonitorAwsConfig;
  enabled: boolean;
  source: DeploymentMonitorSource;
}

interface ResolvedControlPlaneMonitor {
  id: string;
  label: string;
  kind: "headnode-monitor" | "operator-sidecar" | "local-monitor" | "listener" | "custom";
  route: ControlPlaneMonitorRoute;
  url: string;
  routeAliases: string[];
  probe: DeploymentProbeKind;
  notes?: string;
  tags: string[];
  enabled: boolean;
}

const DEFAULT_DEPLOYMENT_MONITORS: DeploymentMonitor[] = [];

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function slugifyId(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-|-$/g, "");
}

function appendUniqueLink(links: DeploymentMonitorLink[], candidate: DeploymentMonitorLink): void {
  if (!links.some((link) => link.url === candidate.url)) {
    links.push(candidate);
  }
}

function normalizeProbeKind(value: unknown, fallback: DeploymentProbeKind): DeploymentProbeKind {
  if (value === "json" || value === "html" || value === "text") {
    return value;
  }
  return fallback;
}

function normalizeComponent(
  raw: DeploymentMonitorComponent,
  fallbackPrefix: string,
): ResolvedDeploymentComponent | null {
  if (!isNonEmptyString(raw.url) || !isNonEmptyString(raw.label)) {
    return null;
  }

  const label = raw.label.trim();
  return {
    id: isNonEmptyString(raw.id) ? raw.id.trim() : slugifyId(`${fallbackPrefix}-${label}`),
    label,
    url: raw.url.trim(),
    probe: normalizeProbeKind(raw.probe, "html"),
    category: isNonEmptyString(raw.category) ? raw.category.trim() : "component",
    notes: isNonEmptyString(raw.notes) ? raw.notes.trim() : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter(isNonEmptyString).map((tag) => tag.trim()) : [],
    enabled: raw.enabled !== false,
  };
}

function normalizeControlPlaneMonitor(
  raw: ControlPlaneMonitor,
): ResolvedControlPlaneMonitor | null {
  if (!isNonEmptyString(raw.url) || !isNonEmptyString(raw.label)) {
    return null;
  }
  const label = raw.label.trim();
  const kind =
    raw.kind === "headnode-monitor" ||
    raw.kind === "operator-sidecar" ||
    raw.kind === "local-monitor" ||
    raw.kind === "listener" ||
    raw.kind === "custom"
      ? raw.kind
      : "custom";
  const route =
    raw.route === "primary" || raw.route === "fallback" || raw.route === "auxiliary"
      ? raw.route
      : "auxiliary";

  return {
    id: isNonEmptyString(raw.id) ? raw.id.trim() : slugifyId(`${kind}-${label}`),
    label,
    kind,
    route,
    url: raw.url.trim(),
    routeAliases: Array.isArray(raw.routeAliases)
      ? raw.routeAliases.filter(isNonEmptyString).map((alias) => alias.trim())
      : [],
    probe: normalizeProbeKind(raw.probe, "json"),
    notes: isNonEmptyString(raw.notes) ? raw.notes.trim() : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter(isNonEmptyString).map((tag) => tag.trim()) : [],
    enabled: raw.enabled !== false,
  };
}

function normalizeAwsAlarm(raw: DeploymentMonitorAwsAlarm): DeploymentMonitorAwsAlarm | null {
  if (!isNonEmptyString(raw.name)) {
    return null;
  }

  return {
    name: raw.name.trim(),
    label: isNonEmptyString(raw.label) ? raw.label.trim() : undefined,
  };
}

function normalizeAwsHealthCheck(
  raw: DeploymentMonitorAwsHealthCheck,
): DeploymentMonitorAwsHealthCheck | null {
  if (!isNonEmptyString(raw.id)) {
    return null;
  }

  return {
    id: raw.id.trim(),
    label: isNonEmptyString(raw.label) ? raw.label.trim() : undefined,
    path: isNonEmptyString(raw.path) ? raw.path.trim() : undefined,
  };
}

function normalizeAwsLogGroup(
  raw: DeploymentMonitorAwsLogGroup,
): DeploymentMonitorAwsLogGroup | null {
  if (!isNonEmptyString(raw.name)) {
    return null;
  }

  return {
    name: raw.name.trim(),
    label: isNonEmptyString(raw.label) ? raw.label.trim() : undefined,
    freshnessMinutes:
      typeof raw.freshnessMinutes === "number" && Number.isFinite(raw.freshnessMinutes)
        ? raw.freshnessMinutes
        : undefined,
  };
}

function normalizeAwsTopic(raw: DeploymentMonitorAwsTopic): DeploymentMonitorAwsTopic | null {
  if (!isNonEmptyString(raw.arn)) {
    return null;
  }

  return {
    arn: raw.arn.trim(),
    label: isNonEmptyString(raw.label) ? raw.label.trim() : undefined,
  };
}

function normalizeAwsExpectedMetric(
  raw: DeploymentMonitorAwsExpectedMetric,
): DeploymentMonitorAwsExpectedMetric | null {
  if (!isNonEmptyString(raw.namespace) || !isNonEmptyString(raw.metricName)) {
    return null;
  }

  return {
    namespace: raw.namespace.trim(),
    metricName: raw.metricName.trim(),
    label: isNonEmptyString(raw.label) ? raw.label.trim() : undefined,
  };
}

function normalizeAwsBudget(raw: DeploymentMonitorAwsBudget): DeploymentMonitorAwsBudget | null {
  if (!isNonEmptyString(raw.name)) {
    return null;
  }

  return {
    name: raw.name.trim(),
    label: isNonEmptyString(raw.label) ? raw.label.trim() : undefined,
  };
}

function normalizeAwsDashboard(
  raw: DeploymentMonitorAwsDashboard,
): DeploymentMonitorAwsDashboard | null {
  if (!isNonEmptyString(raw.name)) {
    return null;
  }

  return {
    name: raw.name.trim(),
    label: isNonEmptyString(raw.label) ? raw.label.trim() : undefined,
  };
}

function normalizeAwsConfig(
  raw: unknown,
  fallbackRegion?: string,
): DeploymentMonitorAwsConfig | undefined {
  if (!isRecord(raw)) {
    return undefined;
  }

  const alarms = Array.isArray(raw.alarms)
    ? raw.alarms
        .map((alarm) => normalizeAwsAlarm(alarm as DeploymentMonitorAwsAlarm))
        .filter((alarm): alarm is DeploymentMonitorAwsAlarm => alarm !== null)
    : [];
  const healthChecks = Array.isArray(raw.healthChecks)
    ? raw.healthChecks
        .map((healthCheck) =>
          normalizeAwsHealthCheck(healthCheck as DeploymentMonitorAwsHealthCheck),
        )
        .filter(
          (healthCheck): healthCheck is DeploymentMonitorAwsHealthCheck => healthCheck !== null,
        )
    : [];
  const logGroups = Array.isArray(raw.logGroups)
    ? raw.logGroups
        .map((logGroup) => normalizeAwsLogGroup(logGroup as DeploymentMonitorAwsLogGroup))
        .filter((logGroup): logGroup is DeploymentMonitorAwsLogGroup => logGroup !== null)
    : [];
  const topics = Array.isArray(raw.topics)
    ? raw.topics
        .map((topic) => normalizeAwsTopic(topic as DeploymentMonitorAwsTopic))
        .filter((topic): topic is DeploymentMonitorAwsTopic => topic !== null)
    : [];
  const expectedMetrics = Array.isArray(raw.expectedMetrics)
    ? raw.expectedMetrics
        .map((metric) => normalizeAwsExpectedMetric(metric as DeploymentMonitorAwsExpectedMetric))
        .filter((metric): metric is DeploymentMonitorAwsExpectedMetric => metric !== null)
    : [];
  const budgets = Array.isArray(raw.budgets)
    ? raw.budgets
        .map((budget) => normalizeAwsBudget(budget as DeploymentMonitorAwsBudget))
        .filter((budget): budget is DeploymentMonitorAwsBudget => budget !== null)
    : [];
  const dashboards = Array.isArray(raw.dashboards)
    ? raw.dashboards
        .map((dashboard) => normalizeAwsDashboard(dashboard as DeploymentMonitorAwsDashboard))
        .filter((dashboard): dashboard is DeploymentMonitorAwsDashboard => dashboard !== null)
    : [];

  const accountId =
    typeof raw.accountId === "string" && raw.accountId.trim().length > 0
      ? raw.accountId.trim()
      : undefined;
  const region =
    typeof raw.region === "string" && raw.region.trim().length > 0
      ? raw.region.trim()
      : fallbackRegion;

  if (
    accountId === undefined &&
    region === undefined &&
    alarms.length === 0 &&
    healthChecks.length === 0 &&
    logGroups.length === 0 &&
    topics.length === 0 &&
    expectedMetrics.length === 0 &&
    budgets.length === 0 &&
    dashboards.length === 0
  ) {
    return undefined;
  }

  return {
    accountId,
    region,
    alarms,
    healthChecks,
    logGroups,
    topics,
    expectedMetrics,
    budgets,
    dashboards,
  };
}

function normalizeMonitor(
  raw: DeploymentMonitor,
  source: DeploymentMonitorSource,
): ResolvedDeploymentMonitor | null {
  if (!isNonEmptyString(raw.healthUrl)) return null;

  const label = isNonEmptyString(raw.label) ? raw.label.trim() : raw.healthUrl.trim();
  const id = isNonEmptyString(raw.id) ? raw.id.trim() : slugifyId(label);
  const appUrl = isNonEmptyString(raw.appUrl) ? raw.appUrl.trim() : undefined;
  const healthUrl = raw.healthUrl.trim();
  const links: DeploymentMonitorLink[] = [];

  if (appUrl) {
    appendUniqueLink(links, { label: "App", url: appUrl });
  }
  appendUniqueLink(links, { label: "Health", url: healthUrl });

  for (const link of raw.links ?? []) {
    if (!isNonEmptyString(link?.label) || !isNonEmptyString(link?.url)) continue;
    appendUniqueLink(links, {
      label: link.label.trim(),
      url: link.url.trim(),
      description: isNonEmptyString(link.description) ? link.description.trim() : undefined,
    });
  }

  const components = (raw.components ?? [])
    .map((component) => normalizeComponent(component, id))
    .filter((component): component is ResolvedDeploymentComponent => component !== null);
  const aws = normalizeAwsConfig(
    raw.aws,
    isNonEmptyString(raw.region) ? raw.region.trim() : undefined,
  );

  return {
    id: id || slugifyId(healthUrl),
    label,
    service: isNonEmptyString(raw.service) ? raw.service.trim() : undefined,
    environment: isNonEmptyString(raw.environment) ? raw.environment.trim() : "unknown",
    provider: isNonEmptyString(raw.provider) ? raw.provider.trim() : "unknown",
    region: isNonEmptyString(raw.region) ? raw.region.trim() : undefined,
    appUrl,
    healthUrl,
    notes: isNonEmptyString(raw.notes) ? raw.notes.trim() : undefined,
    tags: Array.isArray(raw.tags) ? raw.tags.filter(isNonEmptyString).map((tag) => tag.trim()) : [],
    links,
    components,
    aws,
    enabled: raw.enabled !== false,
    source,
  };
}

async function resolveDeploymentMonitors(): Promise<{
  defaulted: boolean;
  monitors: ResolvedDeploymentMonitor[];
}> {
  const { loadGlobalConfig } = await import("../../core/global-config.js");
  const config = loadGlobalConfig();
  const configured = (config.deploymentMonitors ?? [])
    .map((monitor) => normalizeMonitor(monitor, "configured"))
    .filter((monitor): monitor is ResolvedDeploymentMonitor => monitor !== null);

  // User-configured monitors are authoritative. The public distribution has
  // no built-in account, hostname, or cloud-resource assumptions.
  const disableBuiltIns = config.disableBuiltInDeploymentMonitors === true;
  const configuredIds = new Set(configured.map((monitor) => monitor.id));
  const builtIns = disableBuiltIns
    ? []
    : DEFAULT_DEPLOYMENT_MONITORS.filter((monitor) => !configuredIds.has(monitor.id))
        .map((monitor) => normalizeMonitor(monitor, "default"))
        .filter((monitor): monitor is ResolvedDeploymentMonitor => monitor !== null);

  return {
    defaulted: false,
    monitors: [...configured, ...builtIns],
  };
}

async function resolveControlPlaneMonitors(): Promise<ResolvedControlPlaneMonitor[]> {
  const { loadGlobalConfig } = await import("../../core/global-config.js");
  const config = loadGlobalConfig();
  return (config.controlPlaneMonitors ?? [])
    .map((monitor) => normalizeControlPlaneMonitor(monitor))
    .filter((monitor): monitor is ResolvedControlPlaneMonitor => monitor !== null);
}

function truncatePreview(body: string): string | undefined {
  const trimmed = body.trim();
  if (!trimmed) return undefined;
  return trimmed.length > 400 ? `${trimmed.slice(0, 400)}...` : trimmed;
}

function acceptHeaderForProbe(probe: DeploymentProbeKind): string {
  switch (probe) {
    case "json":
      return "application/json, text/plain;q=0.8, */*;q=0.5";
    case "text":
      return "text/plain, text/html;q=0.8, application/json;q=0.6, */*;q=0.5";
    case "html":
    default:
      return "text/html, application/xhtml+xml;q=0.9, */*;q=0.5";
  }
}

async function probeUrl(url: string, probe: DeploymentProbeKind): Promise<DeploymentProbeResult> {
  const startedAt = Date.now();
  const checkedAt = new Date().toISOString();

  try {
    const response = await fetch(url, {
      headers: {
        Accept: acceptHeaderForProbe(probe),
        "User-Agent": "Quack-Monitor/deployment-monitoring",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(8000),
    });

    const body = await response.text();
    const contentType = response.headers.get("content-type") ?? undefined;
    let payload: unknown;

    if (
      probe === "json" ||
      contentType?.includes("json") ||
      body.trim().startsWith("{") ||
      body.trim().startsWith("[")
    ) {
      try {
        payload = JSON.parse(body) as unknown;
      } catch {
        // Keep the text preview when the payload is not valid JSON.
      }
    }

    return {
      ok: response.ok,
      checkedAt,
      statusCode: response.status,
      statusText: response.statusText,
      latencyMs: Date.now() - startedAt,
      contentType,
      finalUrl: response.url,
      bodyPreview: truncatePreview(body),
      payload,
    };
  } catch (err: unknown) {
    return {
      ok: false,
      checkedAt,
      latencyMs: Date.now() - startedAt,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function buildDisabledProbeResult(message = "Monitor is disabled."): DeploymentProbeResult {
  return {
    ok: false,
    checkedAt: new Date().toISOString(),
    statusText: "Disabled",
    error: message,
  };
}

async function probeControlPlaneMonitor(
  monitor: ResolvedControlPlaneMonitor,
): Promise<ControlPlaneProbeStatus> {
  if (!monitor.enabled) {
    return {
      descriptor: monitor,
      state: "disabled",
      probe: buildDisabledProbeResult(),
    };
  }
  const probe = await probeUrl(monitor.url, monitor.probe);
  return {
    descriptor: monitor,
    state: probe.ok ? "healthy" : "offline",
    probe,
  };
}

function buildControlPlaneSummary(probes: ControlPlaneProbeStatus[]): DeploymentMonitorRollup {
  return {
    totalChecks: probes.length,
    healthyChecks: probes.filter((probe) => probe.state === "healthy").length,
    failingChecks: probes.filter((probe) => probe.state === "offline").length,
    disabledChecks: probes.filter((probe) => probe.state === "disabled").length,
  };
}

function normalizeUrlOrigin(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.origin.toLowerCase();
  } catch {
    return undefined;
  }
}

function requestBaseUrl(req: Request): string | undefined {
  const host = req.get("host");
  if (!host) return undefined;
  const forwardedProto = req.get("x-forwarded-proto")?.split(",")[0]?.trim();
  const protocol = forwardedProto || req.protocol || "http";
  return `${protocol}://${host}`;
}

function buildControlPlaneRouteSummary(
  probes: ControlPlaneProbeStatus[],
  req: Request,
): ControlPlaneMonitoringStatus["routeSummary"] {
  const requestBase = requestBaseUrl(req);
  const requestOrigin = normalizeUrlOrigin(requestBase);
  const activeProbe = requestOrigin
    ? probes.find((probe) => {
        const routeOrigins = [probe.descriptor.url, ...probe.descriptor.routeAliases].map((value) =>
          normalizeUrlOrigin(value),
        );
        return routeOrigins.includes(requestOrigin);
      })
    : undefined;
  const primaryProbes = probes.filter((probe) => probe.descriptor.route === "primary");
  const fallbackProbes = probes.filter((probe) => probe.descriptor.route === "fallback");
  const activeRoute = activeProbe?.descriptor.route ?? "unknown";
  const primaryHealthyFromProbes =
    primaryProbes.length === 0 ? null : primaryProbes.some((probe) => probe.state === "healthy");
  const fallbackHealthyFromProbes =
    fallbackProbes.length === 0 ? null : fallbackProbes.some((probe) => probe.state === "healthy");
  const primaryHealthy = activeRoute === "primary" ? true : primaryHealthyFromProbes;
  const fallbackHealthy = activeRoute === "fallback" ? true : fallbackHealthyFromProbes;

  let message: string;
  if (activeRoute === "fallback") {
    message =
      primaryHealthy === false
        ? "Using fallback control-plane route while primary is unhealthy."
        : "Using fallback control-plane route; primary route should be checked before switching back.";
  } else if (activeRoute === "primary") {
    message =
      fallbackHealthy === true
        ? "Using primary control-plane route; fallback route is also healthy."
        : "Using primary control-plane route.";
  } else if (activeRoute === "auxiliary") {
    message = "Current request matched an auxiliary control-plane monitor.";
  } else {
    message = "Current request did not match a configured control-plane monitor route.";
  }

  return {
    requestBaseUrl: requestBase,
    activeRoute,
    activeMonitorId: activeProbe?.descriptor.id,
    primaryHealthy,
    fallbackHealthy,
    primaryMonitorIds: primaryProbes.map((probe) => probe.descriptor.id),
    fallbackMonitorIds: fallbackProbes.map((probe) => probe.descriptor.id),
    message,
  };
}

async function probeControlPlane(req: Request): Promise<ControlPlaneMonitoringStatus> {
  const monitors = await resolveControlPlaneMonitors();
  const probes = await Promise.all(monitors.map((monitor) => probeControlPlaneMonitor(monitor)));
  return {
    summary: buildControlPlaneSummary(probes),
    routeSummary: buildControlPlaneRouteSummary(probes, req),
    probes,
  };
}

async function probeComponent(
  component: ResolvedDeploymentComponent,
  monitorEnabled: boolean,
): Promise<DeploymentMonitorComponentStatus> {
  if (!monitorEnabled || !component.enabled) {
    return {
      component,
      state: "disabled",
      probe: buildDisabledProbeResult(),
    };
  }

  const probe = await probeUrl(component.url, component.probe);
  return {
    component,
    state: probe.ok ? "healthy" : "offline",
    probe,
  };
}

function parseTimestamp(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    const millis = value > 1_000_000_000_000 ? value : value * 1000;
    const parsed = new Date(millis);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  if (typeof value === "string" && value.trim().length > 0) {
    const trimmed = value.trim();
    if (/^\d+$/.test(trimmed)) {
      return parseTimestamp(Number(trimmed));
    }
    const parsed = new Date(trimmed);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}

function extractIdentity(health: DeploymentProbeResult): DeploymentMonitorIdentity | undefined {
  const payload = health.payload;
  if (!isRecord(payload)) return undefined;

  const nested = [payload];
  if (isRecord(payload.data)) nested.push(payload.data);
  if (isRecord(payload.result)) nested.push(payload.result);

  const pickString = (...keys: string[]): string | undefined => {
    for (const record of nested) {
      for (const key of keys) {
        const value = record[key];
        if (typeof value === "string" && value.trim().length > 0) {
          return value.trim();
        }
      }
    }
    return undefined;
  };

  const pickNumber = (...keys: string[]): number | undefined => {
    for (const record of nested) {
      for (const key of keys) {
        const value = record[key];
        if (typeof value === "number" && Number.isFinite(value)) {
          return value;
        }
      }
    }
    return undefined;
  };

  const pickTimestamp = (...keys: string[]): string | undefined => {
    for (const record of nested) {
      for (const key of keys) {
        const parsed = parseTimestamp(record[key]);
        if (parsed) return parsed;
      }
    }
    return undefined;
  };

  const identity: DeploymentMonitorIdentity = {
    status: pickString("status", "state"),
    version: pickString("version", "build", "releaseVersion"),
    commit: pickString("commit", "sha", "gitSha", "revision"),
    uptimeSeconds: pickNumber("uptimeSeconds", "uptime"),
    reportedAt: pickTimestamp("timestamp", "reportedAt", "checkedAt"),
  };

  if (
    identity.status === undefined &&
    identity.version === undefined &&
    identity.commit === undefined &&
    identity.uptimeSeconds === undefined &&
    identity.reportedAt === undefined
  ) {
    return undefined;
  }

  return identity;
}

function buildRollup(
  monitorEnabled: boolean,
  health: DeploymentProbeResult,
  app: DeploymentProbeResult | null,
  components: DeploymentMonitorComponentStatus[],
): DeploymentMonitorRollup {
  const totalChecks = 1 + (app ? 1 : 0) + components.length;
  if (!monitorEnabled) {
    return {
      totalChecks,
      healthyChecks: 0,
      failingChecks: 0,
      disabledChecks: totalChecks,
    };
  }

  const healthyChecks =
    (health.ok ? 1 : 0) +
    (app?.ok ? 1 : 0) +
    components.filter((component) => component.state === "healthy").length;

  const failingChecks =
    (health.ok ? 0 : 1) +
    (app && !app.ok ? 1 : 0) +
    components.filter((component) => component.state === "offline").length;

  const disabledChecks = components.filter((component) => component.state === "disabled").length;

  return {
    totalChecks,
    healthyChecks,
    failingChecks,
    disabledChecks,
  };
}

function deriveMonitorState(
  monitor: ResolvedDeploymentMonitor,
  health: DeploymentProbeResult,
  app: DeploymentProbeResult | null,
  components: DeploymentMonitorComponentStatus[],
): DeploymentMonitorStatus["state"] {
  if (!monitor.enabled) return "disabled";
  if (!health.ok) return "offline";
  if ((app && !app.ok) || components.some((component) => component.state === "offline")) {
    return "degraded";
  }
  return "healthy";
}

async function probeMonitor(monitor: ResolvedDeploymentMonitor): Promise<DeploymentMonitorStatus> {
  if (!monitor.enabled) {
    const health = buildDisabledProbeResult();
    const app = monitor.appUrl ? buildDisabledProbeResult() : null;
    const components = await Promise.all(
      monitor.components.map((component) => probeComponent(component, false)),
    );

    return {
      monitor,
      state: "disabled",
      health,
      app,
      components,
      rollup: buildRollup(false, health, app, components),
      identity: undefined,
      aws: undefined,
    };
  }

  const [health, app, components, aws] = await Promise.all([
    probeUrl(monitor.healthUrl, "json"),
    monitor.appUrl ? probeUrl(monitor.appUrl, "html") : Promise.resolve(null),
    Promise.all(monitor.components.map((component) => probeComponent(component, true))),
    monitor.aws ? collectAwsObservability(monitor.aws) : Promise.resolve(undefined),
  ]);

  return {
    monitor,
    state: deriveMonitorState(monitor, health, app, components),
    health,
    app,
    components,
    rollup: buildRollup(true, health, app, components),
    identity: extractIdentity(health),
    aws,
  };
}

export function registerDeploymentMonitoringRoutes(app: Express): void {
  app.get("/api/monitoring/environments", async (_req: Request, res: Response) => {
    try {
      const { defaulted, monitors } = await resolveDeploymentMonitors();
      const [environments, controlPlane] = await Promise.all([
        Promise.all(monitors.map((monitor) => probeMonitor(monitor))),
        probeControlPlane(_req),
      ]);
      res.json({
        defaulted,
        checkedAt: new Date().toISOString(),
        environments,
        controlPlane,
      } satisfies DeploymentMonitoringResponse);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      res.status(500).json({
        error: "Failed to load deployment monitoring status.",
        details: message,
      });
    }
  });
}
