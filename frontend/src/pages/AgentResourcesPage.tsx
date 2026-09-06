import { useQuery } from "@tanstack/react-query";

import { PageHeader } from "../components/PageHeader";

interface AgentResourceListEntry {
  id: string;
  title: string;
  description: string;
  category: string;
  relativePath: string;
  available: boolean;
  sizeBytes: number | null;
  modifiedAt: string | null;
}

interface AgentResourcesResponse {
  repoRoot: string;
  count: number;
  resources: AgentResourceListEntry[];
}

async function fetchAgentResources(): Promise<AgentResourcesResponse> {
  const response = await fetch("/api/agent-resources", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Failed to load agent resources (HTTP ${response.status})`);
  }
  return (await response.json()) as AgentResourcesResponse;
}

function formatBytes(value: number | null): string {
  if (value === null) return "—";
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  return `${(value / (1024 * 1024)).toFixed(2)} MB`;
}

function formatModified(value: string | null): string {
  if (!value) return "—";
  try {
    return new Date(value).toLocaleString();
  } catch {
    return value;
  }
}

function groupByCategory(
  resources: AgentResourceListEntry[],
): Array<{ category: string; entries: AgentResourceListEntry[] }> {
  const map = new Map<string, AgentResourceListEntry[]>();
  for (const resource of resources) {
    const list = map.get(resource.category);
    if (list) {
      list.push(resource);
    } else {
      map.set(resource.category, [resource]);
    }
  }
  // Preserve insertion order of categories from the registry.
  return Array.from(map.entries()).map(([category, entries]) => ({ category, entries }));
}

export function AgentResourcesPage() {
  const query = useQuery({
    queryKey: ["agent-resources"],
    queryFn: fetchAgentResources,
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
  });

  return (
    <section className="page page-agent-resources">
      <PageHeader
        title="Documentation"
        subtitle="Public project guides and references served directly from this repository."
      />

      {query.isLoading ? (
        <p className="page-state">Loading agent resources…</p>
      ) : query.isError ? (
        <p className="page-state error">
          {query.error instanceof Error ? query.error.message : "Unknown error"}
        </p>
      ) : query.data ? (
        <>
          <p className="page-meta">
            {query.data.count} document{query.data.count === 1 ? "" : "s"} available from this repository
          </p>
          {groupByCategory(query.data.resources).map(({ category, entries }) => (
            <article key={category} className="agent-resources-group">
              <h2 className="agent-resources-group-title">{category}</h2>
              <table className="agent-resources-table">
                <thead>
                  <tr>
                    <th scope="col">Document</th>
                    <th scope="col">Description</th>
                    <th scope="col">Path</th>
                    <th scope="col" className="numeric">
                      Size
                    </th>
                    <th scope="col">Modified</th>
                    <th scope="col">Actions</th>
                  </tr>
                </thead>
                <tbody>
                  {entries.map((entry) => (
                    <tr
                      key={entry.id}
                      className={entry.available ? undefined : "agent-resources-row-missing"}
                    >
                      <td>
                        <strong>{entry.title}</strong>
                      </td>
                      <td>{entry.description}</td>
                      <td>
                        <code>{entry.relativePath}</code>
                      </td>
                      <td className="numeric">{formatBytes(entry.sizeBytes)}</td>
                      <td>{formatModified(entry.modifiedAt)}</td>
                      <td>
                        {entry.available ? (
                          <div className="agent-resources-actions">
                            <a
                              className="btn btn-secondary"
                              href={`/api/agent-resources/${entry.id}`}
                              target="_blank"
                              rel="noopener noreferrer"
                            >
                              View
                            </a>
                            <a
                              className="btn"
                              href={`/api/agent-resources/${entry.id}/download`}
                            >
                              Download
                            </a>
                          </div>
                        ) : (
                          <span className="page-meta">Not on disk</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </article>
          ))}
        </>
      ) : null}
    </section>
  );
}
