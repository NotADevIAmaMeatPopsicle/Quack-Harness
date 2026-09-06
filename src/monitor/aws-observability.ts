import { execFile } from "node:child_process";
import { promisify } from "node:util";

import type {
  DeploymentMonitorAwsAlarm,
  DeploymentMonitorAwsBudget,
  DeploymentMonitorAwsConfig,
  DeploymentMonitorAwsDashboard,
  DeploymentMonitorAwsExpectedMetric,
  DeploymentMonitorAwsHealthCheck,
  DeploymentMonitorAwsLogGroup,
  DeploymentMonitorAwsTopic,
} from "../core/global-config.js";
import type {
  DeploymentMonitorAwsAlarmStatus,
  DeploymentMonitorAwsBudgetStatus,
  DeploymentMonitorAwsDashboardStatus,
  DeploymentMonitorAwsExpectedMetricStatus,
  DeploymentMonitorAwsHealthCheckStatus,
  DeploymentMonitorAwsLogGroupStatus,
  DeploymentMonitorAwsStatus,
  DeploymentMonitorAwsSummary,
  DeploymentMonitorAwsTopicStatus,
} from "./api-contracts.js";

const execFileAsync = promisify(execFile);
const AWS_CACHE_TTL_MS = 25_000;
const DEFAULT_LOG_FRESHNESS_MINUTES = 360;

interface CacheEntry {
  expiresAt: number;
  value?: DeploymentMonitorAwsStatus;
  inflight?: Promise<DeploymentMonitorAwsStatus>;
}

const awsObservabilityCache = new Map<string, CacheEntry>();

interface StsIdentityResponse {
  Account?: string;
}

interface DescribeAlarmsResponse {
  MetricAlarms?: Array<{
    AlarmName?: string;
    StateValue?: string;
    StateReason?: string;
    StateUpdatedTimestamp?: string;
    Namespace?: string;
    MetricName?: string;
  }>;
}

interface Route53HealthCheckStatusResponse {
  HealthCheckObservations?: Array<{
    Region?: string;
    IPAddress?: string;
    CheckedTime?: string;
    StatusReport?: {
      Status?: string;
      CheckedTime?: string;
    };
  }>;
}

interface DescribeLogGroupsResponse {
  logGroups?: Array<{
    logGroupName?: string;
    storedBytes?: number;
    retentionInDays?: number;
  }>;
}

interface DescribeLogStreamsResponse {
  logStreams?: Array<{
    lastEventTimestamp?: number;
    lastIngestionTime?: number;
  }>;
}

interface ListSubscriptionsByTopicResponse {
  Subscriptions?: Array<{
    SubscriptionArn?: string;
    Endpoint?: string;
    Protocol?: string;
  }>;
}

interface ListMetricsResponse {
  Metrics?: Array<{
    MetricName?: string;
  }>;
}

interface DescribeBudgetsResponse {
  Budgets?: Array<{
    BudgetName?: string;
    TimeUnit?: string;
    BudgetLimit?: {
      Amount?: string;
      Unit?: string;
    };
    CalculatedSpend?: {
      ActualSpend?: {
        Amount?: string;
        Unit?: string;
      };
    };
  }>;
}

interface ListDashboardsResponse {
  DashboardEntries?: Array<{
    DashboardName?: string;
    LastModified?: string;
  }>;
}

function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }
  return String(error);
}

function buildCacheKey(config: DeploymentMonitorAwsConfig): string {
  return JSON.stringify(config);
}

async function runAwsJson<T>(args: string[], timeoutMs = 12_000): Promise<T> {
  const { stdout } = await execFileAsync("aws", [...args, "--output", "json"], {
    env: {
      ...process.env,
      AWS_PAGER: "",
    },
    windowsHide: true,
    timeout: timeoutMs,
    maxBuffer: 4 * 1024 * 1024,
  });

  const trimmed = stdout.trim();
  if (!trimmed) {
    return {} as T;
  }

  return JSON.parse(trimmed) as T;
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
    const parsed = new Date(value.trim());
    if (!Number.isNaN(parsed.getTime())) {
      return parsed.toISOString();
    }
  }

  return undefined;
}

function labelForName(name: string, label?: string): string {
  return label?.trim() || name;
}

function labelForMetric(metric: DeploymentMonitorAwsExpectedMetric): string {
  return metric.label?.trim() || `${metric.namespace} / ${metric.metricName}`;
}

function mapAlarmState(value: string | undefined): DeploymentMonitorAwsAlarmStatus["state"] {
  switch (value) {
    case "ALARM":
      return "alarm";
    case "INSUFFICIENT_DATA":
      return "insufficient_data";
    case "OK":
      return "ok";
    default:
      return "missing";
  }
}

function mapTopicState(confirmedSubscriptions: number): DeploymentMonitorAwsTopicStatus["state"] {
  return confirmedSubscriptions > 0 ? "wired" : "unwired";
}

function mapDashboardState(present: boolean): DeploymentMonitorAwsDashboardStatus["state"] {
  return present ? "present" : "missing";
}

function buildEmptySummary(): DeploymentMonitorAwsSummary {
  return {
    totalResources: 0,
    issueCount: 0,
    alertingAlarms: 0,
    insufficientDataAlarms: 0,
    unhealthyHealthChecks: 0,
    staleLogGroups: 0,
    unwiredTopics: 0,
    missingMetrics: 0,
    budgetAlerts: 0,
    missingResources: 0,
  };
}

function deriveLogState(
  lastEventAt: string | undefined,
  freshnessMinutes: number,
): DeploymentMonitorAwsLogGroupStatus["state"] {
  if (!lastEventAt) {
    return "empty";
  }

  const ageMinutes = (Date.now() - Date.parse(lastEventAt)) / 60_000;
  return ageMinutes <= freshnessMinutes ? "fresh" : "stale";
}

function isMissingResourceError(error: unknown): boolean {
  const message = toErrorMessage(error);
  return /NotFound|NoSuch|ResourceNotFound|404/i.test(message);
}

async function loadAlarms(
  region: string,
  alarms: DeploymentMonitorAwsAlarm[],
): Promise<DeploymentMonitorAwsAlarmStatus[]> {
  if (alarms.length === 0) {
    return [];
  }

  const payload = await runAwsJson<DescribeAlarmsResponse>([
    "cloudwatch",
    "describe-alarms",
    "--region",
    region,
    "--alarm-names",
    ...alarms.map((alarm) => alarm.name),
  ]);

  const byName = new Map(
    (payload.MetricAlarms ?? [])
      .filter((alarm) => typeof alarm.AlarmName === "string")
      .map((alarm) => [alarm.AlarmName as string, alarm]),
  );

  return alarms.map((alarm) => {
    const resolved = byName.get(alarm.name);
    if (!resolved) {
      return {
        name: alarm.name,
        label: labelForName(alarm.name, alarm.label),
        state: "missing",
      };
    }

    return {
      name: alarm.name,
      label: labelForName(alarm.name, alarm.label),
      state: mapAlarmState(resolved.StateValue),
      namespace: resolved.Namespace,
      metricName: resolved.MetricName,
      reason: resolved.StateReason,
      updatedAt: parseTimestamp(resolved.StateUpdatedTimestamp),
    };
  });
}

function classifyHealthCheckObservation(status: string | undefined): boolean {
  return typeof status === "string" && /^Success\b/i.test(status);
}

async function loadHealthChecks(
  healthChecks: DeploymentMonitorAwsHealthCheck[],
): Promise<DeploymentMonitorAwsHealthCheckStatus[]> {
  return Promise.all(
    healthChecks.map(async (healthCheck) => {
      try {
        const payload = await runAwsJson<Route53HealthCheckStatusResponse>([
          "route53",
          "get-health-check-status",
          "--health-check-id",
          healthCheck.id,
        ]);

        const observations = payload.HealthCheckObservations ?? [];
        const healthyRegions = observations.filter((observation) =>
          classifyHealthCheckObservation(observation.StatusReport?.Status),
        ).length;
        const totalRegions = observations.length;
        const state: DeploymentMonitorAwsHealthCheckStatus["state"] =
          totalRegions === 0
            ? "unknown"
            : healthyRegions === totalRegions
              ? "healthy"
              : "unhealthy";

        const lastCheckedAt = observations
          .map((observation) =>
            parseTimestamp(observation.StatusReport?.CheckedTime ?? observation.CheckedTime),
          )
          .filter((value): value is string => Boolean(value))
          .sort()
          .at(-1);

        const failingObservation = observations.find(
          (observation) => !classifyHealthCheckObservation(observation.StatusReport?.Status),
        );

        return {
          id: healthCheck.id,
          label: labelForName(healthCheck.id, healthCheck.label),
          path: healthCheck.path,
          state,
          healthyRegions,
          totalRegions,
          lastCheckedAt,
          detail: failingObservation?.StatusReport?.Status || observations[0]?.StatusReport?.Status,
        };
      } catch (error) {
        if (isMissingResourceError(error)) {
          return {
            id: healthCheck.id,
            label: labelForName(healthCheck.id, healthCheck.label),
            path: healthCheck.path,
            state: "missing",
            healthyRegions: 0,
            totalRegions: 0,
          };
        }
        throw error;
      }
    }),
  );
}

async function loadLogGroups(
  region: string,
  logGroups: DeploymentMonitorAwsLogGroup[],
): Promise<DeploymentMonitorAwsLogGroupStatus[]> {
  if (logGroups.length === 0) {
    return [];
  }

  const payload = await runAwsJson<DescribeLogGroupsResponse>([
    "logs",
    "describe-log-groups",
    "--region",
    region,
  ]);

  const byName = new Map(
    (payload.logGroups ?? [])
      .filter((logGroup) => typeof logGroup.logGroupName === "string")
      .map((logGroup) => [logGroup.logGroupName as string, logGroup]),
  );

  return Promise.all(
    logGroups.map(async (logGroup) => {
      const resolved = byName.get(logGroup.name);
      const freshnessMinutes = logGroup.freshnessMinutes ?? DEFAULT_LOG_FRESHNESS_MINUTES;

      if (!resolved) {
        return {
          name: logGroup.name,
          label: labelForName(logGroup.name, logGroup.label),
          state: "missing",
          freshnessMinutes,
        };
      }

      try {
        const streams = await runAwsJson<DescribeLogStreamsResponse>([
          "logs",
          "describe-log-streams",
          "--region",
          region,
          "--log-group-name",
          logGroup.name,
          "--order-by",
          "LastEventTime",
          "--descending",
          "--limit",
          "1",
        ]);

        const stream = streams.logStreams?.[0];
        const lastEventAt = parseTimestamp(stream?.lastEventTimestamp ?? stream?.lastIngestionTime);
        const ageMinutes = lastEventAt
          ? Math.max(0, Math.round((Date.now() - Date.parse(lastEventAt)) / 60_000))
          : undefined;

        return {
          name: logGroup.name,
          label: labelForName(logGroup.name, logGroup.label),
          state: deriveLogState(lastEventAt, freshnessMinutes),
          lastEventAt,
          ageMinutes,
          storedBytes: resolved.storedBytes,
          retentionInDays: resolved.retentionInDays,
          freshnessMinutes,
        };
      } catch (error) {
        if (isMissingResourceError(error)) {
          return {
            name: logGroup.name,
            label: labelForName(logGroup.name, logGroup.label),
            state: "missing",
            freshnessMinutes,
          };
        }
        throw error;
      }
    }),
  );
}

async function loadTopics(
  region: string,
  topics: DeploymentMonitorAwsTopic[],
): Promise<DeploymentMonitorAwsTopicStatus[]> {
  return Promise.all(
    topics.map(async (topic) => {
      try {
        const payload = await runAwsJson<ListSubscriptionsByTopicResponse>([
          "sns",
          "list-subscriptions-by-topic",
          "--region",
          region,
          "--topic-arn",
          topic.arn,
        ]);

        const subscriptions = payload.Subscriptions ?? [];
        const pendingSubscriptions = subscriptions.filter(
          (subscription) => subscription.SubscriptionArn === "PendingConfirmation",
        ).length;
        const confirmedSubscriptions = subscriptions.filter(
          (subscription) =>
            typeof subscription.SubscriptionArn === "string" &&
            subscription.SubscriptionArn !== "PendingConfirmation" &&
            subscription.SubscriptionArn !== "Deleted",
        ).length;

        return {
          arn: topic.arn,
          label: labelForName(topic.arn, topic.label),
          state: mapTopicState(confirmedSubscriptions),
          subscriptions: subscriptions.length,
          confirmedSubscriptions,
          pendingSubscriptions,
        };
      } catch (error) {
        if (isMissingResourceError(error)) {
          return {
            arn: topic.arn,
            label: labelForName(topic.arn, topic.label),
            state: "missing",
            subscriptions: 0,
            confirmedSubscriptions: 0,
            pendingSubscriptions: 0,
          };
        }
        throw error;
      }
    }),
  );
}

async function loadExpectedMetrics(
  region: string,
  expectedMetrics: DeploymentMonitorAwsExpectedMetric[],
): Promise<DeploymentMonitorAwsExpectedMetricStatus[]> {
  if (expectedMetrics.length === 0) {
    return [];
  }

  const byNamespace = new Map<string, DeploymentMonitorAwsExpectedMetric[]>();
  for (const metric of expectedMetrics) {
    const current = byNamespace.get(metric.namespace) ?? [];
    current.push(metric);
    byNamespace.set(metric.namespace, current);
  }

  const results = await Promise.all(
    Array.from(byNamespace.entries()).map(async ([namespace, metrics]) => {
      const payload = await runAwsJson<ListMetricsResponse>([
        "cloudwatch",
        "list-metrics",
        "--region",
        region,
        "--namespace",
        namespace,
      ]);

      const names = new Map<string, number>();
      for (const metric of payload.Metrics ?? []) {
        if (typeof metric.MetricName !== "string") {
          continue;
        }
        names.set(metric.MetricName, (names.get(metric.MetricName) ?? 0) + 1);
      }

      return metrics.map((metric) => {
        const discoveredMetrics = names.get(metric.metricName) ?? 0;
        return {
          namespace: metric.namespace,
          metricName: metric.metricName,
          label: labelForMetric(metric),
          state: discoveredMetrics > 0 ? "present" : "missing",
          discoveredMetrics,
        } satisfies DeploymentMonitorAwsExpectedMetricStatus;
      });
    }),
  );

  return results.flat();
}

async function loadBudgets(
  accountId: string,
  budgets: DeploymentMonitorAwsBudget[],
): Promise<DeploymentMonitorAwsBudgetStatus[]> {
  if (budgets.length === 0) {
    return [];
  }

  const payload = await runAwsJson<DescribeBudgetsResponse>([
    "budgets",
    "describe-budgets",
    "--account-id",
    accountId,
    "--region",
    "us-east-1",
  ]);

  const byName = new Map(
    (payload.Budgets ?? [])
      .filter((budget) => typeof budget.BudgetName === "string")
      .map((budget) => [budget.BudgetName as string, budget]),
  );

  return budgets.map((budget) => {
    const resolved = byName.get(budget.name);
    if (!resolved) {
      return {
        name: budget.name,
        label: labelForName(budget.name, budget.label),
        state: "missing",
      };
    }

    const actualAmount = Number(resolved.CalculatedSpend?.ActualSpend?.Amount);
    const limitAmount = Number(resolved.BudgetLimit?.Amount);
    const numericActual = Number.isFinite(actualAmount) ? actualAmount : undefined;
    const numericLimit = Number.isFinite(limitAmount) ? limitAmount : undefined;

    return {
      name: budget.name,
      label: labelForName(budget.name, budget.label),
      state:
        numericActual !== undefined &&
        numericLimit !== undefined &&
        numericLimit > 0 &&
        numericActual > numericLimit
          ? "alerting"
          : "ok",
      actualAmount: numericActual,
      limitAmount: numericLimit,
      unit: resolved.BudgetLimit?.Unit || resolved.CalculatedSpend?.ActualSpend?.Unit,
      timeUnit: resolved.TimeUnit,
    };
  });
}

async function loadDashboards(
  region: string,
  dashboards: DeploymentMonitorAwsDashboard[],
): Promise<DeploymentMonitorAwsDashboardStatus[]> {
  if (dashboards.length === 0) {
    return [];
  }

  const payload = await runAwsJson<ListDashboardsResponse>([
    "cloudwatch",
    "list-dashboards",
    "--region",
    region,
  ]);

  const byName = new Map(
    (payload.DashboardEntries ?? [])
      .filter((dashboard) => typeof dashboard.DashboardName === "string")
      .map((dashboard) => [dashboard.DashboardName as string, dashboard]),
  );

  return dashboards.map((dashboard) => {
    const resolved = byName.get(dashboard.name);
    return {
      name: dashboard.name,
      label: labelForName(dashboard.name, dashboard.label),
      state: mapDashboardState(Boolean(resolved)),
      lastModified: parseTimestamp(resolved?.LastModified),
    };
  });
}

function buildSummary(
  status: Omit<DeploymentMonitorAwsStatus, "summary" | "state">,
): DeploymentMonitorAwsSummary {
  return {
    totalResources:
      status.alarms.length +
      status.healthChecks.length +
      status.logGroups.length +
      status.topics.length +
      status.expectedMetrics.length +
      status.budgets.length +
      status.dashboards.length,
    issueCount:
      status.alarms.filter((alarm) => alarm.state !== "ok").length +
      status.healthChecks.filter((healthCheck) => healthCheck.state !== "healthy").length +
      status.logGroups.filter((logGroup) => logGroup.state !== "fresh").length +
      status.topics.filter((topic) => topic.state !== "wired").length +
      status.expectedMetrics.filter((metric) => metric.state !== "present").length +
      status.budgets.filter((budget) => budget.state !== "ok").length +
      status.dashboards.filter((dashboard) => dashboard.state !== "present").length +
      status.warnings.length,
    alertingAlarms: status.alarms.filter((alarm) => alarm.state === "alarm").length,
    insufficientDataAlarms: status.alarms.filter((alarm) => alarm.state === "insufficient_data")
      .length,
    unhealthyHealthChecks: status.healthChecks.filter(
      (healthCheck) => healthCheck.state !== "healthy",
    ).length,
    staleLogGroups: status.logGroups.filter((logGroup) => logGroup.state !== "fresh").length,
    unwiredTopics: status.topics.filter((topic) => topic.state !== "wired").length,
    missingMetrics: status.expectedMetrics.filter((metric) => metric.state !== "present").length,
    budgetAlerts: status.budgets.filter((budget) => budget.state !== "ok").length,
    missingResources:
      status.alarms.filter((alarm) => alarm.state === "missing").length +
      status.healthChecks.filter((healthCheck) => healthCheck.state === "missing").length +
      status.logGroups.filter((logGroup) => logGroup.state === "missing").length +
      status.topics.filter((topic) => topic.state === "missing").length +
      status.budgets.filter((budget) => budget.state === "missing").length +
      status.dashboards.filter((dashboard) => dashboard.state === "missing").length,
  };
}

async function collectAwsObservabilityUncached(
  config: DeploymentMonitorAwsConfig,
): Promise<DeploymentMonitorAwsStatus> {
  const checkedAt = new Date().toISOString();
  const region = config.region?.trim() || "us-east-1";

  try {
    const identity = await runAwsJson<StsIdentityResponse>(["sts", "get-caller-identity"]);

    const warnings: string[] = [];
    const accountId = identity.Account ?? config.accountId;
    if (config.accountId && accountId && config.accountId.trim() !== accountId.trim()) {
      warnings.push(
        `AWS account mismatch: expected ${config.accountId.trim()} but monitor is authenticated to ${accountId.trim()}.`,
      );
    }

    const [alarms, healthChecks, logGroups, topics, expectedMetrics, budgets, dashboards] =
      await Promise.all([
        loadAlarms(region, config.alarms ?? []),
        loadHealthChecks(config.healthChecks ?? []),
        loadLogGroups(region, config.logGroups ?? []),
        loadTopics(region, config.topics ?? []),
        loadExpectedMetrics(region, config.expectedMetrics ?? []),
        accountId
          ? loadBudgets(accountId, config.budgets ?? [])
          : Promise.resolve(
              (config.budgets ?? []).map(
                (budget) =>
                  ({
                    name: budget.name,
                    label: labelForName(budget.name, budget.label),
                    state: "missing",
                  }) satisfies DeploymentMonitorAwsBudgetStatus,
              ),
            ),
        loadDashboards(region, config.dashboards ?? []),
      ]);

    const baseStatus = {
      accountId,
      region,
      checkedAt,
      warnings,
      alarms,
      healthChecks,
      logGroups,
      topics,
      expectedMetrics,
      budgets,
      dashboards,
    };

    const summary = buildSummary(baseStatus);
    return {
      ...baseStatus,
      summary,
      state: summary.issueCount > 0 ? "degraded" : "healthy",
    };
  } catch (error) {
    const message = toErrorMessage(error);
    return {
      accountId: config.accountId,
      region,
      checkedAt,
      state: "unavailable",
      summary: buildEmptySummary(),
      warnings: [message],
      error: message,
      alarms: [],
      healthChecks: [],
      logGroups: [],
      topics: [],
      expectedMetrics: [],
      budgets: [],
      dashboards: [],
    };
  }
}

export async function collectAwsObservability(
  config: DeploymentMonitorAwsConfig,
): Promise<DeploymentMonitorAwsStatus> {
  const cacheKey = buildCacheKey(config);
  const now = Date.now();
  const cached = awsObservabilityCache.get(cacheKey);

  if (cached?.value && cached.expiresAt > now) {
    return cached.value;
  }

  if (cached?.inflight) {
    return cached.inflight;
  }

  const inflight = collectAwsObservabilityUncached(config)
    .then((value) => {
      awsObservabilityCache.set(cacheKey, {
        expiresAt: Date.now() + AWS_CACHE_TTL_MS,
        value,
      });
      return value;
    })
    .catch((error) => {
      awsObservabilityCache.delete(cacheKey);
      throw error;
    });

  awsObservabilityCache.set(cacheKey, {
    expiresAt: now + AWS_CACHE_TTL_MS,
    inflight,
  });

  return inflight;
}

export function resetAwsObservabilityCache(): void {
  awsObservabilityCache.clear();
}
