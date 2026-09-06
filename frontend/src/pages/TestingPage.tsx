import { useEffect, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import {
  getTestingCommands,
  getTestingHistory,
  getTestingStatus,
  runTestingCommand,
  stopTestingCommand,
} from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { toast } from "../components/Toast";
import { formatDateTime, formatDurationMs } from "../lib/format";
import { sseHub, type SseEnvelope } from "../sse/stream";

export function TestingPage() {
  const queryClient = useQueryClient();
  const [force, setForce] = useState(false);

  const commands = useQuery({
    queryKey: ["testing-commands"],
    queryFn: getTestingCommands,
  });
  const history = useQuery({
    queryKey: ["testing-history"],
    queryFn: getTestingHistory,
    refetchInterval: 5000,
  });
  const status = useQuery({
    queryKey: ["testing-status"],
    queryFn: getTestingStatus,
    refetchInterval: 2000,
  });

  const [stream, setStream] = useState<SseEnvelope[]>([]);
  useEffect(() => {
    const unsubscribe = sseHub.subscribe("testing", (envelope) => {
      if (envelope.stage === "testing_output") {
        setStream((prev) => [...prev.slice(-49), envelope]);
      }
    });
    return unsubscribe;
  }, []);

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["testing-history"] });
    void queryClient.invalidateQueries({ queryKey: ["testing-status"] });
  };

  const runCommand = useMutation({
    mutationFn: (name: string) => runTestingCommand(name, force),
    onSuccess: (_, name) => {
      toast.success(`Started ${name}`);
      invalidate();
    },
    onError: (error: unknown, name) => {
      toast.error(`Failed to run ${name}`, error instanceof Error ? error.message : String(error));
    },
  });

  const stopCommand = useMutation({
    mutationFn: stopTestingCommand,
    onSuccess: () => {
      toast.success("Stopped active test command");
      invalidate();
    },
    onError: (error: unknown) => {
      toast.error("Failed to stop active command", error instanceof Error ? error.message : String(error));
    },
  });

  const activeCommand = status.data?.running ? status.data.name : null;

  return (
    <div className="page">
      <PageHeader
        title="Testing"
        subtitle="Run adapter verification commands, watch the live stream, and review recent results."
      >
        <span className={`pill ${status.data?.running ? "pill-IN_PROGRESS" : "pill-muted"}`}>
          {status.data?.running ? `Running ${status.data.name}` : "Idle"}
        </span>
        {status.data?.running && (
          <button
            type="button"
            className="btn btn-danger"
            onClick={() => stopCommand.mutate()}
            disabled={stopCommand.isPending}
          >
            Stop
          </button>
        )}
      </PageHeader>

      <section className="card">
        <div className="card-header">
          <h2>Commands</h2>
          <label className="toolbar-toggle">
            <input
              type="checkbox"
              checked={force}
              onChange={(event) => setForce(event.target.checked)}
            />
            Force rerun
          </label>
        </div>
        {commands.isLoading && <p>Loading...</p>}
        {commands.isError && <p className="error">Failed to load testing commands.</p>}
        {commands.data && (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Command</th>
                <th>Timeout</th>
                <th>Required</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {commands.data.commands.map((cmd) => (
                <tr key={cmd.name}>
                  <td className="mono">{cmd.name}</td>
                  <td className="mono">{cmd.command}</td>
                  <td>{cmd.timeout ? formatDurationMs(cmd.timeout) : "-"}</td>
                  <td>{cmd.required ? <span className="badge">required</span> : "-"}</td>
                  <td>
                    <div className="table-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => runCommand.mutate(cmd.name)}
                        disabled={runCommand.isPending || stopCommand.isPending || Boolean(status.data?.running)}
                      >
                        Run
                      </button>
                      {activeCommand === cmd.name && <span className="pill pill-IN_PROGRESS">running</span>}
                    </div>
                  </td>
                </tr>
              ))}
              {commands.data.commands.length === 0 && (
                <tr>
                  <td colSpan={5} className="empty-state">No verification commands configured for the active project.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Recent Runs</h2>
        {history.isError && <p className="error">Failed to load recent test runs.</p>}
        {history.data && (
          <table className="table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Status</th>
                <th>Exit</th>
                <th>Started</th>
                <th>Finished</th>
                <th>Duration</th>
              </tr>
            </thead>
            <tbody>
              {history.data.runs.map((run) => (
                <tr key={run.id}>
                  <td className="mono">{run.name}</td>
                  <td>{run.status}</td>
                  <td>{run.exitCode ?? "-"}</td>
                  <td className="muted">{formatDateTime(run.startedAt)}</td>
                  <td className="muted">{formatDateTime(run.finishedAt)}</td>
                  <td>{formatDurationMs(run.durationMs)}</td>
                </tr>
              ))}
              {history.data.runs.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-state">No test runs have been recorded yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>

      <section className="card">
        <h2>Live Output (last 50 events)</h2>
        <pre className="stream">
          {stream.length === 0 ? "(silent)" : stream.map((entry) => JSON.stringify(entry.payload)).join("\n")}
        </pre>
      </section>
    </div>
  );
}
