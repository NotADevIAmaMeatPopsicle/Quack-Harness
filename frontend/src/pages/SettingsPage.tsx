import { useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";

import { addProject, listProjects, removeProject, setActiveProject } from "../api/client";
import type { ProjectSummary } from "../api/contracts";
import { confirmDialog } from "../components/ConfirmDialog";
import { PageHeader } from "../components/PageHeader";
import { toast } from "../components/Toast";

export function SettingsPage() {
  const queryClient = useQueryClient();
  const [projectPath, setProjectPath] = useState("");

  const projects = useQuery({
    queryKey: ["projects"],
    queryFn: listProjects,
  });

  const invalidate = (): void => {
    void queryClient.invalidateQueries({ queryKey: ["projects"] });
  };

  const activateProject = useMutation({
    mutationFn: (projectId: string) => setActiveProject(projectId),
    onSuccess: (_, projectId) => {
      toast.success(`Activated ${projectId}`);
      invalidate();
    },
    onError: (error: unknown, projectId) => {
      toast.error(`Failed to activate ${projectId}`, error instanceof Error ? error.message : String(error));
    },
  });

  const registerProject = useMutation({
    mutationFn: (path: string) => addProject(path),
    onSuccess: (data) => {
      toast.success(`Registered ${data.name}`, data.path);
      setProjectPath("");
      invalidate();
    },
    onError: (error: unknown) => {
      toast.error("Failed to register project", error instanceof Error ? error.message : String(error));
    },
  });

  const unregisterProject = useMutation({
    mutationFn: (projectId: string) => removeProject(projectId),
    onSuccess: (_, projectId) => {
      toast.success(`Removed ${projectId}`);
      invalidate();
    },
    onError: (error: unknown, projectId) => {
      toast.error(`Failed to remove ${projectId}`, error instanceof Error ? error.message : String(error));
    },
  });

  const submitProject = (event: React.FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const normalized = projectPath.trim();
    if (!normalized) {
      return;
    }
    registerProject.mutate(normalized);
  };

  const confirmRemoveProject = (project: ProjectSummary): void => {
    void (async () => {
      const ok = await confirmDialog({
        title: `Remove ${project.name}?`,
        message: "This unregisters the project from the monitor. It does not delete the repo on disk.",
        confirmLabel: "Remove",
        danger: true,
      });
      if (ok) {
        unregisterProject.mutate(project.id);
      }
    })();
  };

  return (
    <div className="page">
      <PageHeader
        title="Settings"
        subtitle="Project registry and active-project controls for the monitor."
      />
      <section className="card">
        <div className="card-header">
          <h2>Projects</h2>
          {projects.data?.activeProjectId && (
            <span className="muted">Active project: <span className="mono">{projects.data.activeProjectId}</span></span>
          )}
        </div>
        <form className="form-inline" onSubmit={submitProject}>
          <input
            type="text"
            className="input input-grow"
            placeholder="Register project path..."
            value={projectPath}
            onChange={(event) => setProjectPath(event.target.value)}
          />
          <button
            type="submit"
            className="btn"
            disabled={registerProject.isPending || projectPath.trim().length === 0}
          >
            Register
          </button>
        </form>
        {projects.isLoading && <p>Loading...</p>}
        {projects.isError && <p className="error">Failed to load projects.</p>}
        {projects.data && (
          <table className="table">
            <thead>
              <tr>
                <th>ID</th>
                <th>Name</th>
                <th>Path</th>
                <th>Adapter</th>
                <th>Active</th>
                <th>Actions</th>
              </tr>
            </thead>
            <tbody>
              {projects.data.projects.map((project) => (
                <tr key={project.id}>
                  <td className="mono">{project.id}</td>
                  <td>{project.name}</td>
                  <td className="mono muted">{project.path}</td>
                  <td>{project.adapterName ?? "-"}</td>
                  <td>{project.id === projects.data.activeProjectId ? "Yes" : ""}</td>
                  <td>
                    <div className="table-actions">
                      <button
                        type="button"
                        className="btn btn-sm"
                        onClick={() => activateProject.mutate(project.id)}
                        disabled={activateProject.isPending || project.id === projects.data.activeProjectId}
                      >
                        Set active
                      </button>
                      <button
                        type="button"
                        className="btn btn-sm btn-danger"
                        onClick={() => confirmRemoveProject(project)}
                        disabled={unregisterProject.isPending}
                      >
                        Remove
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
              {projects.data.projects.length === 0 && (
                <tr>
                  <td colSpan={6} className="empty-state">No projects are registered yet.</td>
                </tr>
              )}
            </tbody>
          </table>
        )}
      </section>
    </div>
  );
}
