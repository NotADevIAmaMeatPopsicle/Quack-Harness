import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";
import * as http from "node:http";

import { createMonitorServer } from "../../src/monitor/server";

jest.mock("../../src/monitor/aws-observability", () => ({
  collectAwsObservability: jest.fn(
    (config: {
      accountId?: string;
      region?: string;
      alarms?: Array<{ name: string; label?: string }>;
      healthChecks?: Array<{ id: string; label?: string; path?: string }>;
      logGroups?: Array<{ name: string; label?: string; freshnessMinutes?: number }>;
      topics?: Array<{ arn: string; label?: string }>;
      expectedMetrics?: Array<{ namespace: string; metricName: string; label?: string }>;
      budgets?: Array<{ name: string; label?: string }>;
      dashboards?: Array<{ name: string; label?: string }>;
    }) => {
      const missingMetrics = (config.expectedMetrics ?? []).filter((metric) =>
        metric.metricName.includes("missing"),
      );
      const unwiredTopics = (config.topics ?? []).filter((topic) => topic.arn.includes("unwired"));
      const state = missingMetrics.length > 0 || unwiredTopics.length > 0 ? "degraded" : "healthy";

      return Promise.resolve({
        accountId: config.accountId ?? "000000000000",
        region: config.region ?? "us-east-1",
        checkedAt: "2026-05-04T12:00:00.000Z",
        state,
        summary: {
          totalResources:
            (config.alarms ?? []).length +
            (config.healthChecks ?? []).length +
            (config.logGroups ?? []).length +
            (config.topics ?? []).length +
            (config.expectedMetrics ?? []).length +
            (config.budgets ?? []).length +
            (config.dashboards ?? []).length,
          issueCount: missingMetrics.length + unwiredTopics.length,
          alertingAlarms: 0,
          insufficientDataAlarms: 0,
          unhealthyHealthChecks: 0,
          staleLogGroups: 0,
          unwiredTopics: unwiredTopics.length,
          missingMetrics: missingMetrics.length,
          budgetAlerts: 0,
          missingResources: 0,
        },
        warnings: state === "degraded" ? ["Custom CloudWatch signals are incomplete."] : [],
        alarms: (config.alarms ?? []).map((alarm) => ({
          name: alarm.name,
          label: alarm.label ?? alarm.name,
          state: "ok",
        })),
        healthChecks: (config.healthChecks ?? []).map((healthCheck) => ({
          id: healthCheck.id,
          label: healthCheck.label ?? healthCheck.id,
          path: healthCheck.path,
          state: "healthy",
          healthyRegions: 3,
          totalRegions: 3,
          lastCheckedAt: "2026-05-04T12:00:00.000Z",
        })),
        logGroups: (config.logGroups ?? []).map((logGroup) => ({
          name: logGroup.name,
          label: logGroup.label ?? logGroup.name,
          state: "fresh",
          lastEventAt: "2026-05-04T11:59:00.000Z",
          ageMinutes: 1,
          freshnessMinutes: logGroup.freshnessMinutes ?? 360,
        })),
        topics: (config.topics ?? []).map((topic) => ({
          arn: topic.arn,
          label: topic.label ?? topic.arn,
          state: topic.arn.includes("unwired") ? "unwired" : "wired",
          subscriptions: topic.arn.includes("unwired") ? 0 : 1,
          confirmedSubscriptions: topic.arn.includes("unwired") ? 0 : 1,
          pendingSubscriptions: 0,
        })),
        expectedMetrics: (config.expectedMetrics ?? []).map((metric) => ({
          namespace: metric.namespace,
          metricName: metric.metricName,
          label: metric.label ?? `${metric.namespace}/${metric.metricName}`,
          state: metric.metricName.includes("missing") ? "missing" : "present",
          discoveredMetrics: metric.metricName.includes("missing") ? 0 : 1,
        })),
        budgets: (config.budgets ?? []).map((budget) => ({
          name: budget.name,
          label: budget.label ?? budget.name,
          state: "ok",
          actualAmount: 42,
          limitAmount: 100,
          unit: "USD",
          timeUnit: "MONTHLY",
        })),
        dashboards: (config.dashboards ?? []).map((dashboard) => ({
          name: dashboard.name,
          label: dashboard.label ?? dashboard.name,
          state: "present",
          lastModified: "2026-05-04T12:00:00.000Z",
        })),
      });
    },
  ),
}));

jest.mock("../../src/monitor/auth", () => {
  const actual =
    jest.requireActual<typeof import("../../src/monitor/auth")>("../../src/monitor/auth");
  return {
    ...actual,
    initAuthConfig: () => ({
      users: [],
      sessionSecret: "test",
      sessionTtlMs: 86400000,
    }),
  };
});

let tmpHome = "";
function getTestConfigPath(): string {
  return path.join(tmpHome, ".quack", "config.json");
}
jest.mock("../../src/core/global-config", () => {
  const actual = jest.requireActual<typeof import("../../src/core/global-config")>(
    "../../src/core/global-config",
  );
  return {
    ...actual,
    getConfigPath: () => getTestConfigPath(),
    loadGlobalConfig: () => {
      try {
        const raw = fs.readFileSync(getTestConfigPath(), "utf-8");
        const parsed = JSON.parse(raw) as Record<string, unknown>;
        return {
          projects: Array.isArray(parsed.projects) ? parsed.projects : [],
          monitor:
            typeof parsed.monitor === "object" && parsed.monitor !== null
              ? parsed.monitor
              : { port: 3333 },
          remoteInstances: Array.isArray(parsed.remoteInstances) ? parsed.remoteInstances : [],
          deploymentMonitors: Array.isArray(parsed.deploymentMonitors)
            ? parsed.deploymentMonitors
            : [],
          controlPlaneMonitors: Array.isArray(parsed.controlPlaneMonitors)
            ? parsed.controlPlaneMonitors
            : [],
          disableBuiltInDeploymentMonitors: parsed.disableBuiltInDeploymentMonitors === true,
        };
      } catch {
        return {
          projects: [],
          monitor: { port: 3333 },
          remoteInstances: [],
          deploymentMonitors: [],
          controlPlaneMonitors: [],
          disableBuiltInDeploymentMonitors: false,
        };
      }
    },
    saveGlobalConfig: (config: unknown) => {
      const cp = getTestConfigPath();
      fs.mkdirSync(path.dirname(cp), { recursive: true });
      fs.writeFileSync(cp, JSON.stringify(config, null, 2), "utf-8");
    },
  };
});

const { collectAwsObservability: collectAwsObservabilityMock } = jest.requireMock<{
  collectAwsObservability: jest.Mock;
}>("../../src/monitor/aws-observability");

let monitorServer: http.Server;
let monitorBaseUrl: string;
let environmentServer: http.Server;
let environmentPort = 0;

async function httpGet(url: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    http
      .get(url, (res) => {
        let body = "";
        res.on("data", (chunk) => (body += chunk));
        res.on("end", () => resolve({ status: res.statusCode ?? 0, body }));
        res.on("error", reject);
      })
      .on("error", reject);
  });
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "quack-monitoring-srv-"));

beforeAll(async () => {
  tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "quack-monitoring-test-"));
  environmentServer = http.createServer((req, res) => {
    if (req.url === "/api/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "ok",
          environment: "staging",
          commit: "env-123",
        }),
      );
      return;
    }

    if (req.url === "/web-app") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><body>web-app staging</body></html>");
      return;
    }

    if (req.url === "/worker-health") {
      res.writeHead(503, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          status: "error",
          service: "background-worker",
        }),
      );
      return;
    }

    if (req.url === "/" || req.url === "") {
      res.writeHead(200, { "Content-Type": "text/html" });
      res.end("<!doctype html><html><body>staging frontend</body></html>");
      return;
    }

    res.writeHead(404, { "Content-Type": "text/plain" });
    res.end("not found");
  });

  await new Promise<void>((resolve) => {
    environmentServer.listen(0, "127.0.0.1", () => {
      const addr = environmentServer.address();
      if (addr && typeof addr === "object") {
        environmentPort = addr.port;
      }
      resolve();
    });
  });

  const logDir = path.join(tmpDir, "logs");
  fs.mkdirSync(logDir, { recursive: true });
  fs.writeFileSync(path.join(logDir, "sessions.jsonl"), "", "utf-8");

  const monitor = createMonitorServer({
    logDir,
    adapterPath: undefined,
    projectRoot: tmpDir,
  });

  await new Promise<void>((resolve) => {
    monitorServer = monitor.app.listen(0, "127.0.0.1", () => {
      const addr = monitorServer.address();
      if (addr && typeof addr === "object") {
        monitorBaseUrl = `http://127.0.0.1:${addr.port}`;
      }
      resolve();
    });
  });
});

afterAll(async () => {
  await new Promise<void>((resolve) => {
    monitorServer.close(() => resolve());
  });
  await new Promise<void>((resolve) => {
    environmentServer.close(() => resolve());
  });
  fs.rmSync(tmpDir, { recursive: true, force: true });
  fs.rmSync(tmpHome, { recursive: true, force: true });
});

beforeEach(() => {
  collectAwsObservabilityMock.mockClear();
  const configDir = path.join(tmpHome, ".quack");
  fs.mkdirSync(configDir, { recursive: true });
  fs.writeFileSync(
    path.join(configDir, "config.json"),
    JSON.stringify({
      projects: [],
      monitor: { port: 3333 },
      // Tests in this file isolate to the explicitly configured monitor.
      // The additive default (built-ins + user-configured) is exercised
      // in the dedicated "additive resolution" describe block below.
      disableBuiltInDeploymentMonitors: true,
      deploymentMonitors: [
        {
          id: "staging-local",
          label: "Staging local",
          service: "example-service",
          environment: "staging",
          provider: "aws",
          region: "us-east-1",
          appUrl: `http://127.0.0.1:${environmentPort}/`,
          healthUrl: `http://127.0.0.1:${environmentPort}/api/health`,
          tags: ["staging", "aws"],
          aws: {
            accountId: "000000000000",
            region: "us-east-1",
            alarms: [{ name: "staging-api-latency", label: "API latency" }],
            healthChecks: [{ id: "staging-health", label: "API health", path: "/api/health" }],
            logGroups: [{ name: "/staging/backend", label: "Backend logs", freshnessMinutes: 180 }],
            topics: [{ arn: "arn:aws:sns:us-east-1:000000000000:staging-alerts", label: "Alerts" }],
            expectedMetrics: [
              {
                namespace: "ExampleAssistant/API",
                metricName: "response_time_p95",
                label: "API latency p95",
              },
            ],
            budgets: [{ name: "staging-budget", label: "Budget" }],
            dashboards: [{ name: "staging-dashboard", label: "Dashboard" }],
          },
          enabled: true,
        },
      ],
      controlPlaneMonitors: [
        {
          id: "headnode-http",
          label: "Headnode HTTP",
          kind: "headnode-monitor",
          route: "primary",
          url: `http://127.0.0.1:${environmentPort}/api/health`,
          enabled: true,
        },
        {
          id: "operator-sidecar",
          label: "Operator sidecar",
          kind: "operator-sidecar",
          route: "auxiliary",
          url: `http://127.0.0.1:${environmentPort}/missing`,
          enabled: true,
        },
      ],
    }),
    "utf-8",
  );
});

describe("GET /api/monitoring/environments", () => {
  it("probes the configured deployment environment", async () => {
    const res = await httpGet(`${monitorBaseUrl}/api/monitoring/environments`);
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body) as {
      defaulted: boolean;
      environments: Array<{
        state: string;
        monitor: { id: string; source: string };
        health: {
          ok: boolean;
          statusCode?: number;
          payload?: { status?: string; commit?: string };
        };
        app?: { ok: boolean; statusCode?: number } | null;
        components: Array<{ component: { id: string }; state: string }>;
        rollup: { totalChecks: number; healthyChecks: number; failingChecks: number };
        identity?: { status?: string; commit?: string };
        aws?: {
          state: string;
          summary: { totalResources: number; issueCount: number };
        };
      }>;
    };

    expect(body.defaulted).toBe(false);
    expect(body.environments).toHaveLength(1);
    expect(body.environments[0]?.monitor.id).toBe("staging-local");
    expect(body.environments[0]?.monitor.source).toBe("configured");
    expect(body.environments[0]?.state).toBe("healthy");
    expect(body.environments[0]?.health.ok).toBe(true);
    expect(body.environments[0]?.health.statusCode).toBe(200);
    expect(body.environments[0]?.health.payload?.status).toBe("ok");
    expect(body.environments[0]?.health.payload?.commit).toBe("env-123");
    expect(body.environments[0]?.app?.ok).toBe(true);
    expect(body.environments[0]?.components).toEqual([]);
    expect(body.environments[0]?.rollup.totalChecks).toBe(2);
    expect(body.environments[0]?.rollup.healthyChecks).toBe(2);
    expect(body.environments[0]?.rollup.failingChecks).toBe(0);
    expect(body.environments[0]?.identity?.status).toBe("ok");
    expect(body.environments[0]?.identity?.commit).toBe("env-123");
    expect(body.environments[0]?.aws?.state).toBe("healthy");
    expect(body.environments[0]?.aws?.summary.totalResources).toBe(7);
    expect(body.environments[0]?.aws?.summary.issueCount).toBe(0);
    expect(collectAwsObservabilityMock).toHaveBeenCalledTimes(1);
  });

  it("marks disabled monitors without probing them", async () => {
    const configDir = path.join(tmpHome, ".quack");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        projects: [],
        monitor: { port: 3333 },
        disableBuiltInDeploymentMonitors: true,
        deploymentMonitors: [
          {
            id: "staging-disabled",
            label: "Staging disabled",
            environment: "staging",
            provider: "aws",
            healthUrl: `http://127.0.0.1:${environmentPort}/api/health`,
            enabled: false,
          },
        ],
      }),
      "utf-8",
    );

    const res = await httpGet(`${monitorBaseUrl}/api/monitoring/environments`);
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body) as {
      environments: Array<{
        state: string;
        health: { error?: string };
        app?: { error?: string } | null;
        components: Array<unknown>;
        rollup: { totalChecks: number; disabledChecks: number };
        aws?: unknown;
      }>;
    };

    expect(body.environments[0]?.state).toBe("disabled");
    expect(body.environments[0]?.health.error).toBe("Monitor is disabled.");
    expect(body.environments[0]?.components).toEqual([]);
    expect(body.environments[0]?.rollup.totalChecks).toBe(1);
    expect(body.environments[0]?.rollup.disabledChecks).toBe(1);
    expect(body.environments[0]?.aws).toBeUndefined();
    expect(collectAwsObservabilityMock).not.toHaveBeenCalled();
  });

  it("surfaces additional component checks and degrades when one fails", async () => {
    const configDir = path.join(tmpHome, ".quack");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        projects: [],
        monitor: { port: 3333 },
        disableBuiltInDeploymentMonitors: true,
        deploymentMonitors: [
          {
            id: "staging-expanded",
            label: "Staging expanded",
            service: "example-service",
            environment: "staging",
            provider: "aws",
            region: "us-east-1",
            appUrl: `http://127.0.0.1:${environmentPort}/`,
            healthUrl: `http://127.0.0.1:${environmentPort}/api/health`,
            components: [
              {
                id: "web-app-ui",
                label: "Web app frontend",
                url: `http://127.0.0.1:${environmentPort}/web-app`,
                probe: "html",
                category: "frontend",
              },
              {
                id: "worker-health",
                label: "Worker health",
                url: `http://127.0.0.1:${environmentPort}/worker-health`,
                probe: "json",
                category: "worker",
              },
            ],
            aws: {
              accountId: "000000000000",
              region: "us-east-1",
              alarms: [{ name: "worker-alarm" }],
              topics: [{ arn: "arn:aws:sns:us-east-1:000000000000:unwired-alerts" }],
              expectedMetrics: [
                {
                  namespace: "ExampleAssistant/API",
                  metricName: "missing_worker_signal",
                },
              ],
            },
            enabled: true,
          },
        ],
      }),
      "utf-8",
    );

    const res = await httpGet(`${monitorBaseUrl}/api/monitoring/environments`);
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body) as {
      environments: Array<{
        state: string;
        components: Array<{
          component: { id: string; category: string };
          state: string;
          probe: { ok: boolean; statusCode?: number };
        }>;
        rollup: { totalChecks: number; healthyChecks: number; failingChecks: number };
        aws?: {
          state: string;
          summary: { issueCount: number; unwiredTopics: number; missingMetrics: number };
          warnings: string[];
        };
      }>;
    };

    expect(body.environments[0]?.state).toBe("degraded");
    expect(body.environments[0]?.components).toHaveLength(2);
    expect(body.environments[0]?.components[0]?.component.id).toBe("web-app-ui");
    expect(body.environments[0]?.components[0]?.component.category).toBe("frontend");
    expect(body.environments[0]?.components[0]?.state).toBe("healthy");
    expect(body.environments[0]?.components[1]?.component.id).toBe("worker-health");
    expect(body.environments[0]?.components[1]?.state).toBe("offline");
    expect(body.environments[0]?.components[1]?.probe.ok).toBe(false);
    expect(body.environments[0]?.components[1]?.probe.statusCode).toBe(503);
    expect(body.environments[0]?.rollup.totalChecks).toBe(4);
    expect(body.environments[0]?.rollup.healthyChecks).toBe(3);
    expect(body.environments[0]?.rollup.failingChecks).toBe(1);
    expect(body.environments[0]?.aws?.state).toBe("degraded");
    expect(body.environments[0]?.aws?.summary.issueCount).toBe(2);
    expect(body.environments[0]?.aws?.summary.unwiredTopics).toBe(1);
    expect(body.environments[0]?.aws?.summary.missingMetrics).toBe(1);
    expect(body.environments[0]?.aws?.warnings).toEqual([
      "Custom CloudWatch signals are incomplete.",
    ]);
  });

  it("surfaces Quack control-plane reachability separately from app deployment health", async () => {
    const res = await httpGet(`${monitorBaseUrl}/api/monitoring/environments`);
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body) as {
      controlPlane?: {
        summary: {
          totalChecks: number;
          healthyChecks: number;
          failingChecks: number;
          disabledChecks: number;
        };
        probes: Array<{
          descriptor: {
            id: string;
            kind: string;
            label: string;
            route: string;
            routeAliases: string[];
          };
          state: string;
          probe: { ok: boolean; statusCode?: number };
        }>;
        routeSummary: {
          activeRoute: string;
          activeMonitorId?: string;
          primaryHealthy: boolean | null;
          fallbackHealthy: boolean | null;
        };
      };
    };

    expect(body.controlPlane?.summary).toMatchObject({
      totalChecks: 2,
      healthyChecks: 1,
      failingChecks: 1,
      disabledChecks: 0,
    });
    expect(body.controlPlane?.routeSummary).toMatchObject({
      activeRoute: "unknown",
      primaryHealthy: true,
      fallbackHealthy: null,
    });
    const probes = body.controlPlane?.probes ?? [];
    const headnodeProbe = probes.find((probe) => probe.descriptor.id === "headnode-http");
    const sidecarProbe = probes.find((probe) => probe.descriptor.id === "operator-sidecar");

    expect(headnodeProbe).toMatchObject({
      descriptor: { id: "headnode-http", kind: "headnode-monitor", route: "primary" },
      state: "healthy",
      probe: { ok: true, statusCode: 200 },
    });
    expect(sidecarProbe).toMatchObject({
      descriptor: { id: "operator-sidecar", kind: "operator-sidecar", route: "auxiliary" },
      state: "offline",
      probe: { ok: false, statusCode: 404 },
    });
  });

  it("identifies fallback control-plane route usage when the primary probe is unhealthy", async () => {
    const configDir = path.join(tmpHome, ".quack");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        projects: [],
        monitor: { port: 3333 },
        deploymentMonitors: [],
        disableBuiltInDeploymentMonitors: true,
        controlPlaneMonitors: [
          {
            id: "headnode-tailnet",
            label: "Headnode tailnet",
            kind: "headnode-monitor",
            route: "primary",
            url: `http://127.0.0.1:${environmentPort}/missing-primary`,
            enabled: true,
          },
          {
            id: "headnode-ssh-tunnel",
            label: "Headnode SSH tunnel",
            kind: "headnode-monitor",
            route: "fallback",
            url: `http://127.0.0.1:${environmentPort}/api/health`,
            routeAliases: [monitorBaseUrl],
            enabled: true,
          },
        ],
      }),
      "utf-8",
    );

    const res = await httpGet(`${monitorBaseUrl}/api/monitoring/environments`);
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body) as {
      controlPlane?: {
        routeSummary: {
          requestBaseUrl?: string;
          activeRoute: string;
          activeMonitorId?: string;
          primaryHealthy: boolean | null;
          fallbackHealthy: boolean | null;
          message: string;
        };
        probes: Array<{ descriptor: { id: string; route: string }; state: string }>;
      };
    };

    expect(body.controlPlane?.routeSummary).toMatchObject({
      requestBaseUrl: monitorBaseUrl,
      activeRoute: "fallback",
      activeMonitorId: "headnode-ssh-tunnel",
      primaryHealthy: false,
      fallbackHealthy: true,
      message: "Using fallback control-plane route while primary is unhealthy.",
    });
    expect(body.controlPlane?.probes).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          descriptor: expect.objectContaining({ id: "headnode-tailnet", route: "primary" }),
          state: "offline",
        }),
        expect.objectContaining({
          // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
          descriptor: expect.objectContaining({ id: "headnode-ssh-tunnel", route: "fallback" }),
          state: "healthy",
        }),
      ]),
    );
  });
});

describe("GET /api/monitoring/environments — explicit configuration", () => {
  it("returns only user-configured monitors", async () => {
    const configDir = path.join(tmpHome, ".quack");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({
        projects: [],
        monitor: { port: 3333 },
        deploymentMonitors: [
          {
            id: "project-wiki",
            label: "Project Wiki",
            environment: "production",
            provider: "self-hosted",
            appUrl: `http://127.0.0.1:${environmentPort}/`,
            healthUrl: `http://127.0.0.1:${environmentPort}/api/health`,
            enabled: true,
          },
        ],
      }),
      "utf-8",
    );

    const res = await httpGet(`${monitorBaseUrl}/api/monitoring/environments`);
    expect(res.status).toBe(200);

    const body = JSON.parse(res.body) as {
      defaulted: boolean;
      environments: Array<{ monitor: { id: string; source: string } }>;
    };

    expect(body.defaulted).toBe(false);
    expect(body.environments).toHaveLength(1);
    expect(body.environments[0]?.monitor.id).toBe("project-wiki");
    expect(body.environments[0]?.monitor.source).toBe("configured");
  });

  it("returns no monitors when none are configured", async () => {
    const configDir = path.join(tmpHome, ".quack");
    fs.writeFileSync(
      path.join(configDir, "config.json"),
      JSON.stringify({ projects: [], monitor: { port: 3333 }, deploymentMonitors: [] }),
      "utf-8",
    );

    const res = await httpGet(`${monitorBaseUrl}/api/monitoring/environments`);
    expect(res.status).toBe(200);
    const body = JSON.parse(res.body) as { defaulted: boolean; environments: unknown[] };
    expect(body.defaulted).toBe(false);
    expect(body.environments).toEqual([]);
  });
});
