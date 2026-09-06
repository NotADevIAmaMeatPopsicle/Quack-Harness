import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { listSessions } from "../api/client";
import type { MonitorSessionSummary } from "../api/contracts";
import { PageHeader } from "../components/PageHeader";

const PER_PAGE_OPTIONS = [10, 50, 100, 250];
const HIDDEN_FAILURE_STATUSES = "error,canceled";
const HIDDEN_FAILURE_OUTCOMES = "rejected,agent_failed,canceled";

export function SessionsPage() {
  const [page, setPage] = useState(1);
  const [perPage, setPerPage] = useState(50);
  const [showFailed, setShowFailed] = useState(false);

  const sessions = useQuery({
    queryKey: ["sessions", { page, perPage, showFailed }],
    queryFn: () => listSessions({
      page,
      perPage,
      sort: "startTime",
      order: "desc",
      excludeStatus: showFailed ? undefined : HIDDEN_FAILURE_STATUSES,
      excludeOutcome: showFailed ? undefined : HIDDEN_FAILURE_OUTCOMES,
    }),
    placeholderData: (prev) => prev,
    refetchInterval: 30000,
  });

  return (
    <div className="page">
      <PageHeader
        title="Sessions"
        subtitle="Recent dispatch and federation history with failed/canceled visibility parity."
      />

      <div className="toolbar">
        <label className="toolbar-toggle">
          <input
            type="checkbox"
            checked={showFailed}
            onChange={(e) => {
              setShowFailed(e.target.checked);
              setPage(1);
            }}
          />
          Show failed/canceled
        </label>
        <span className="toolbar-spacer" />
        <span className="toolbar-label">Per page</span>
        <select
          className="input"
          value={perPage}
          onChange={(e) => {
            setPerPage(Number(e.target.value));
            setPage(1);
          }}
        >
          {PER_PAGE_OPTIONS.map((value) => (
            <option key={value} value={value}>{value}</option>
          ))}
        </select>
      </div>

      <section className="card">
        {sessions.isLoading && !sessions.data && <p>Loading...</p>}
        {sessions.isError && <p className="error">Failed to load sessions.</p>}
        {sessions.data && (
          <>
            <p className="muted">
              Page {sessions.data.pagination.page} of {sessions.data.pagination.totalPages}
              {" | "}
              {sessions.data.pagination.totalItems} total
              {!showFailed && " | failures hidden"}
            </p>
            <table className="table">
              <thead>
                <tr>
                  <th>Session</th>
                  <th>Task</th>
                  <th>Title</th>
                  <th>Status</th>
                  <th>Outcome</th>
                  <th>Cost (USD)</th>
                  <th>Duration</th>
                  <th>Turns</th>
                  <th>Started</th>
                </tr>
              </thead>
              <tbody>
                {sessions.data.sessions.map((session) => (
                  <tr key={session.sessionId}>
                    <td className="mono">{session.sessionId}</td>
                    <td className="mono">
                      <Link to={`/tasks/${encodeURIComponent(session.taskId)}`}>{session.taskId}</Link>
                    </td>
                    <td>{session.title ?? "-"}</td>
                    <td>
                      <span className={`pill ${sessionStatusPillClass(session.status)}`}>
                        {displayLabel(session.status)}
                      </span>
                    </td>
                    <td>
                      {session.outcome
                        ? (
                          <span className={`pill ${sessionOutcomePillClass(session.outcome)}`}>
                            {displayLabel(session.outcome)}
                          </span>
                        )
                        : <span className="muted">-</span>}
                    </td>
                    <td>{formatCurrency(session.totalCostUsd)}</td>
                    <td>{formatDuration(session.durationMs)}</td>
                    <td>{formatOptionalNumber(session.turnsUsed)}</td>
                    <td className="muted">{formatTimestamp(session.startTime)}</td>
                  </tr>
                ))}
                {sessions.data.sessions.length === 0 && (
                  <tr>
                    <td colSpan={9} className="muted" style={{ textAlign: "center", padding: 24 }}>
                      No sessions match the current filters.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>

            {sessions.data.pagination.totalPages > 1 && (
              <div className="pagination">
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!sessions.data.pagination.hasPreviousPage}
                  onClick={() => setPage((current) => Math.max(1, current - 1))}
                >
                  Prev
                </button>
                <span className="muted">
                  Page {sessions.data.pagination.page} of {sessions.data.pagination.totalPages}
                </span>
                <button
                  type="button"
                  className="btn btn-sm"
                  disabled={!sessions.data.pagination.hasNextPage}
                  onClick={() => setPage((current) => current + 1)}
                >
                  Next
                </button>
              </div>
            )}
          </>
        )}
      </section>
    </div>
  );
}

function sessionStatusPillClass(status: MonitorSessionSummary["status"]): string {
  switch (status) {
    case "active":
      return "pill-active";
    case "completed":
      return "pill-success";
    case "error":
      return "pill-error";
    default:
      return "pill-muted";
  }
}

function sessionOutcomePillClass(outcome: string): string {
  switch (outcome.toLowerCase()) {
    case "approved":
    case "success":
      return "pill-success";
    case "rejected":
    case "agent_failed":
      return "pill-error";
    case "canceled":
      return "pill-muted";
    default:
      return "pill-active";
  }
}

function displayLabel(value: string): string {
  return value.replace(/_/g, " ");
}

function formatCurrency(value: number | null | undefined): string {
  return typeof value === "number" ? `$${value.toFixed(2)}` : "-";
}

function formatOptionalNumber(value: number | null | undefined): string {
  return typeof value === "number" ? String(value) : "-";
}

function formatDuration(value: number | null | undefined): string {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return "-";
  }
  if (value < 1000) {
    return `${Math.round(value)} ms`;
  }

  const totalSeconds = Math.round(value / 1000);
  if (totalSeconds < 60) {
    return `${totalSeconds}s`;
  }

  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (minutes < 60) {
    return seconds > 0 ? `${minutes}m ${seconds}s` : `${minutes}m`;
  }

  const hours = Math.floor(minutes / 60);
  const remainingMinutes = minutes % 60;
  return remainingMinutes > 0 ? `${hours}h ${remainingMinutes}m` : `${hours}h`;
}

function formatTimestamp(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    return value;
  }
  return parsed.toLocaleString();
}
