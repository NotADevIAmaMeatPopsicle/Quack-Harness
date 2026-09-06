import { useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";

import { getCcusage, getCosts, refreshCcusage } from "../api/client";
import type { CcusageResponse } from "../api/contracts";
import { PageHeader } from "../components/PageHeader";
import { toast } from "../components/Toast";
import { formatCurrency, formatDateTime, formatDurationMs, formatNumber } from "../lib/format";

type CcusageRange = "month" | "7d" | "30d" | "90d";

const RANGE_OPTIONS: Array<{ value: CcusageRange; label: string }> = [
  { value: "month", label: "This month" },
  { value: "7d", label: "Last 7 days" },
  { value: "30d", label: "Last 30 days" },
  { value: "90d", label: "Last 90 days" },
];

export function CostsPage() {
  const [range, setRange] = useState<CcusageRange>("month");
  const costs = useQuery({
    queryKey: ["costs"],
    queryFn: getCosts,
    refetchInterval: 30000,
  });
  const ccusage = useQuery({
    queryKey: ["ccusage"],
    queryFn: getCcusage,
    refetchInterval: 60000,
    retry: false,
  });
  const refresh = useMutation({
    mutationFn: refreshCcusage,
    onSuccess: () => {
      toast.success("ccusage refresh started");
      void ccusage.refetch();
    },
    onError: (error: unknown) => {
      toast.error("ccusage refresh failed", error instanceof Error ? error.message : String(error));
    },
  });

  const currentMonthKey = new Date().toISOString().slice(0, 7);
  const monthDays = costs.data?.byDay.filter((day) => day.date.startsWith(currentMonthKey)) ?? [];
  const quackMonthCost = costs.data?.monthToDateCostUsd
    ?? monthDays.reduce((sum, day) => sum + day.costUsd, 0);
  const quackMonthSessions = costs.data?.monthToDateSessionCount
    ?? monthDays.reduce((sum, day) => sum + day.sessions, 0);
  const monthLabel = new Date(`${currentMonthKey}-01T00:00:00`).toLocaleString(undefined, {
    month: "long",
    year: "numeric",
  });

  const filteredCcusage = filterCcusageByRange(ccusage.data, range);
  const accountMonthCost = sumCcusageCostForMonth(ccusage.data, currentMonthKey);
  const otherMonthCost = Math.max(accountMonthCost - quackMonthCost, 0);
  const rangeCost = filteredCcusage?.totals.totalCost ?? 0;
  const rangeTokens = filteredCcusage?.totals.totalTokens ?? 0;
  const rangeCacheRead = filteredCcusage?.totals.cacheReadTokens ?? 0;
  const rangeCacheCreate = filteredCcusage?.totals.cacheCreationTokens ?? 0;

  return (
    <div className="page">
      <PageHeader
        title="Costs"
        subtitle="Quack cost history plus local Claude Code account usage from ccusage."
      >
        <button
          type="button"
          className="btn"
          onClick={() => refresh.mutate()}
          disabled={refresh.isPending}
        >
          Refresh ccusage
        </button>
      </PageHeader>
      <section className="card">
        {costs.isLoading && <p>Loading...</p>}
        {costs.isError && <p className="error">Failed to load costs.</p>}
        {costs.data && (
          <div className="detail-stack">
            <div className="metrics-grid">
              <MetricCard
                label="Quack total"
                value={formatCurrency(costs.data.totalCostUsd)}
                detail={`${formatNumber(costs.data.sessionCount)} sessions`}
              />
              <MetricCard
                label="Month to date"
                value={formatCurrency(quackMonthCost)}
                detail={`${formatNumber(quackMonthSessions)} dispatched sessions`}
              />
              <MetricCard
                label="Last 7 days"
                value={formatCurrency(costs.data.last7DaysCostUsd)}
                detail={`Average ${formatCurrency(costs.data.avgCostPerSession)} per session`}
              />
              <MetricCard
                label="Last 30 days"
                value={formatCurrency(costs.data.last30DaysCostUsd)}
                detail={`Today ${formatCurrency(costs.data.todayCostUsd)}`}
              />
            </div>

            <div className="card-section">
              <div className="card-header">
                <h2>Account Month Split</h2>
                <span className="muted">{monthLabel}</span>
              </div>
              {ccusage.isLoading && !ccusage.data && <p className="empty-state">Loading ccusage data...</p>}
              {ccusage.data === null && (
                <p className="empty-state">
                  ccusage is not available on this host. Install it with <span className="mono">npm i -g ccusage</span>.
                </p>
              )}
              {ccusage.data && (
                <>
                  <div className="metrics-grid">
                    <MetricCard label="Account month" value={formatCurrency(accountMonthCost)} detail={`${monthLabel} API-equivalent usage`} />
                    <MetricCard label="Quack-tracked" value={formatCurrency(quackMonthCost)} detail={`${Math.round(percentOf(quackMonthCost, accountMonthCost))}% of account month`} />
                    <MetricCard label="Other usage" value={formatCurrency(otherMonthCost)} detail="admin, terminal, and non-Quack usage" />
                  </div>
                  <div className="split-bar" aria-hidden="true">
                    <div
                      className="split-bar-segment accent"
                      style={{ width: `${Math.max(percentOf(quackMonthCost, accountMonthCost), quackMonthCost > 0 ? 2 : 0)}%` }}
                    />
                    <div
                      className="split-bar-segment purple"
                      style={{ width: `${Math.max(percentOf(otherMonthCost, accountMonthCost), otherMonthCost > 0 ? 2 : 0)}%` }}
                    />
                  </div>
                  <div className="legend">
                    <span><span className="legend-swatch accent" />Quack</span>
                    <span><span className="legend-swatch purple" />Other</span>
                  </div>
                  {ccusage.data.stale && (
                    <p className="muted">
                      ccusage cache is stale{ccusage.data.refreshing ? " and refreshing in the background" : ""}.
                    </p>
                  )}
                </>
              )}
            </div>

            <div className="card-section">
              <div className="card-header">
                <h2>Claude Code Usage</h2>
                <select
                  className="input"
                  value={range}
                  onChange={(event) => setRange(event.target.value as CcusageRange)}
                >
                  {RANGE_OPTIONS.map((option) => (
                    <option key={option.value} value={option.value}>{option.label}</option>
                  ))}
                </select>
              </div>
              {ccusage.data && (
                <>
                  <div className="metrics-grid">
                    <MetricCard label="Range total" value={formatCurrency(rangeCost)} detail={`${filteredCcusage?.daily.length ?? 0} active days`} />
                    <MetricCard label="Total tokens" value={formatNumber(rangeTokens)} detail={`${formatNumber(filteredCcusage?.totals.inputTokens ?? 0)} in / ${formatNumber(filteredCcusage?.totals.outputTokens ?? 0)} out`} />
                    <MetricCard
                      label="Cache efficiency"
                      value={`${Math.round(percentOf(rangeCacheRead, rangeTokens))}%`}
                      detail={`${formatNumber(rangeCacheRead)} read / ${formatNumber(rangeCacheCreate)} created`}
                    />
                  </div>
                  <table className="table">
                    <thead>
                      <tr>
                        <th>Date</th>
                        <th>Cost</th>
                        <th>Total tokens</th>
                        <th>Input</th>
                        <th>Output</th>
                      </tr>
                    </thead>
                    <tbody>
                      {(filteredCcusage?.daily ?? []).map((day) => (
                        <tr key={day.date}>
                          <td className="mono">{day.date}</td>
                          <td>{formatCurrency(day.totalCost)}</td>
                          <td>{formatNumber(day.totalTokens)}</td>
                          <td>{formatNumber(day.inputTokens)}</td>
                          <td>{formatNumber(day.outputTokens)}</td>
                        </tr>
                      ))}
                      {(filteredCcusage?.daily.length ?? 0) === 0 && (
                        <tr>
                          <td colSpan={5} className="empty-state">No ccusage records in this range yet.</td>
                        </tr>
                      )}
                    </tbody>
                  </table>
                </>
              )}
            </div>

            <div className="card-section">
              <div className="card-header">
                <h2>Per-task Quack Cost</h2>
                {costs.data.refreshedAt && <span className="muted">Refreshed {formatDateTime(costs.data.refreshedAt)}</span>}
              </div>
              <table className="table">
                <thead>
                  <tr>
                    <th>Task</th>
                    <th>Cost</th>
                    <th>Outcome</th>
                    <th>Date</th>
                    <th>Duration</th>
                    <th>Turns</th>
                  </tr>
                </thead>
                <tbody>
                  {costs.data.byTask.map((row) => (
                    <tr key={row.taskId + (row.date ?? "")}>
                      <td className="mono">{row.taskId}</td>
                      <td>{formatCurrency(row.costUsd)}</td>
                      <td>{row.outcome ?? "-"}</td>
                      <td className="muted">{formatDateTime(row.date)}</td>
                      <td>{formatDurationMs(row.durationMs)}</td>
                      <td>{formatNumber(row.turnsUsed)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}

function MetricCard(props: { label: string; value: string; detail?: string }) {
  return (
    <div className="metric-card">
      <div className="metric-label">{props.label}</div>
      <div className="metric-value">{props.value}</div>
      {props.detail && <div className="metric-subtle">{props.detail}</div>}
    </div>
  );
}

function filterCcusageByRange(data: CcusageResponse | null | undefined, range: CcusageRange) {
  if (!data) {
    return null;
  }

  const cutoff = ccusageCutoff(range);
  const daily = data.daily.filter((entry) => entry.date >= cutoff);
  const totals = daily.reduce((acc, entry) => {
    acc.inputTokens += entry.inputTokens;
    acc.outputTokens += entry.outputTokens;
    acc.cacheCreationTokens += entry.cacheCreationTokens;
    acc.cacheReadTokens += entry.cacheReadTokens;
    acc.totalCost += entry.totalCost;
    acc.totalTokens += entry.totalTokens;
    return acc;
  }, {
    inputTokens: 0,
    outputTokens: 0,
    cacheCreationTokens: 0,
    cacheReadTokens: 0,
    totalCost: 0,
    totalTokens: 0,
  });

  return { daily, totals };
}

function ccusageCutoff(range: CcusageRange): string {
  const now = new Date();
  if (range === "month") {
    return now.toISOString().slice(0, 7) + "-01";
  }

  const days = range === "90d" ? 90 : range === "30d" ? 30 : 7;
  const cutoff = new Date(now);
  cutoff.setDate(cutoff.getDate() - (days - 1));
  return cutoff.toISOString().slice(0, 10);
}

function sumCcusageCostForMonth(data: CcusageResponse | null | undefined, monthKey: string): number {
  if (!data) {
    return 0;
  }

  return data.daily
    .filter((entry) => entry.date.startsWith(monthKey))
    .reduce((sum, entry) => sum + entry.totalCost, 0);
}

function percentOf(value: number, total: number): number {
  if (total <= 0) {
    return 0;
  }
  return Math.min((value / total) * 100, 100);
}
