import { startTransition, useDeferredValue, useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSearchParams } from "react-router-dom";

import type { WikiIndexEntry, WikiPageResponse, WikiSearchResult } from "../api/contracts";
import { getWikiIndex, getWikiPage, getWikiStatus, searchWiki } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime, formatNumber } from "../lib/format";
import { renderWikiHtml } from "../lib/wiki-markdown";

const SECTION_ORDER = ["wiki", "raw", "schema", "root"];

const QUICK_LINKS = [
  {
    label: "Master Index",
    path: "wiki/index.md",
    summary: "Start here for the canonical cross-project map.",
  },
  {
    label: "Quack Overview",
    path: "wiki/quack/overview.md",
    summary: "High-signal Quack architecture and feature summary.",
  },
  {
    label: "Platform Issues",
    path: "wiki/quack/platform-issues.md",
    summary: "Known Quack platform defects and operator workarounds.",
  },
  {
    label: "Bug Report Artifacts",
    path: "raw/platform/bug-reports/index.md",
    summary: "Raw bug-report writebacks created by the wiki API.",
  },
] as const;

export function WikiPage() {
  const [searchParams, setSearchParams] = useSearchParams();
  const [filter, setFilter] = useState("");
  const deferredFilter = useDeferredValue(filter);
  const selectedPath = searchParams.get("path") ?? "";
  const normalizedFilter = deferredFilter.trim();
  const normalizedFilterLower = normalizedFilter.toLowerCase();

  const status = useQuery({
    queryKey: ["wiki-status"],
    queryFn: getWikiStatus,
    refetchInterval: 30_000,
    refetchOnWindowFocus: false,
  });

  const index = useQuery({
    queryKey: ["wiki-index"],
    queryFn: () => getWikiIndex(),
    refetchInterval: 60_000,
    refetchOnWindowFocus: false,
    enabled: status.data?.available === true,
  });

  useEffect(() => {
    const entries = index.data?.entries ?? [];
    if (entries.length === 0) return;
    if (selectedPath && entries.some((entry) => entry.path === selectedPath)) return;
    const defaultEntry = entries.find((entry) => entry.path === "wiki/index.md") ?? entries[0];
    if (!defaultEntry) return;
    startTransition(() => {
      setSearchParams({ path: defaultEntry.path }, { replace: true });
    });
  }, [index.data, selectedPath, setSearchParams]);

  const search = useQuery({
    queryKey: ["wiki-search", normalizedFilter],
    queryFn: () => searchWiki(normalizedFilter, 40),
    enabled: normalizedFilter.length > 0 && status.data?.available === true,
    refetchOnWindowFocus: false,
  });

  const page = useQuery({
    queryKey: ["wiki-page", selectedPath],
    queryFn: () => getWikiPage(selectedPath),
    enabled: selectedPath.length > 0 && status.data?.available === true,
  });

  const allEntries = index.data?.entries ?? [];
  const fallbackFilteredEntries = allEntries.filter((entry) => {
    if (!normalizedFilterLower) return true;
    return `${entry.path}\n${entry.title}\n${entry.summary}`.toLowerCase().includes(normalizedFilterLower);
  });
  const quickLinks = QUICK_LINKS.filter((link) => allEntries.some((entry) => entry.path === link.path));
  const showingServerSearch = normalizedFilter.length > 0 && !!search.data && !search.isError;
  const searchResultCount = showingServerSearch
    ? search.data?.count ?? 0
    : fallbackFilteredEntries.length;

  function openPath(path: string): void {
    startTransition(() => {
      setSearchParams({ path });
    });
  }

  return (
    <section className="page page-wiki">
      <PageHeader
        title="Wiki"
        subtitle="project-wiki browser for operators and agents. Read pages, search the corpus, and inspect the canonical repo state without leaving Quack."
      >
        {status.data?.available ? (
          <span className={`pill ${status.data.git.dirty ? "pill-IN_PROGRESS" : "pill-success"}`}>
            {status.data.git.dirty ? "wiki dirty" : "wiki clean"}
          </span>
        ) : (
          <span className="pill pill-BLOCKED">wiki unavailable</span>
        )}
      </PageHeader>

      {status.isLoading ? <p className="page-state">Loading wiki status...</p> : null}
      {status.isError ? (
        <p className="page-state error">
          {status.error instanceof Error ? status.error.message : "Failed to load wiki status."}
        </p>
      ) : null}

      {status.data && (
        <section className="wiki-status-grid">
          <article className="card wiki-status-card">
            <h2>Repo</h2>
            {status.data.available ? (
              <>
                <div className="wiki-status-value mono">{status.data.root}</div>
                <p className="muted">
                  Discovered via {status.data.source}. Top-level entries: {status.data.topLevelEntries.join(", ") || "-"}
                </p>
              </>
            ) : (
              <>
                <div className="wiki-status-value">Not found</div>
                <p className="muted">Checked: {(status.data.checkedPaths ?? []).join(" | ") || "-"}</p>
              </>
            )}
          </article>

          <article className="card wiki-status-card">
            <h2>Git</h2>
            <div className="wiki-status-value">
              {status.data.git.available ? (status.data.git.branch ?? "detached") : "not a git repo"}
            </div>
            <p className="muted">
              {status.data.git.available
                ? `ahead ${status.data.git.ahead}, behind ${status.data.git.behind}, changed files ${status.data.git.changedFiles.length}`
                : "Git metadata is unavailable for this root."}
            </p>
          </article>

          <article className="card wiki-status-card">
            <h2>Corpus</h2>
            <div className="wiki-status-value">{formatNumber(index.data?.count ?? 0)}</div>
            <p className="muted">
              Markdown pages indexed across wiki, raw, schema, and root docs.
            </p>
          </article>
        </section>
      )}

      <div className="wiki-layout">
        <aside className="card wiki-sidebar">
          <div className="wiki-sidebar-header">
            <div>
              <h2>Pages</h2>
              <p className="muted">
                {searchResultCount} match{searchResultCount === 1 ? "" : "es"}
              </p>
            </div>
            <input
              className="input wiki-search-input"
              type="search"
              value={filter}
              onChange={(event) => setFilter(event.target.value)}
              placeholder="Search full wiki body, titles, and paths"
            />
            <p className="wiki-search-help">
              Quick links surface the main operator pages. Search uses the backend corpus search when a query is present.
            </p>
          </div>

          {index.isLoading ? <p className="page-state">Indexing wiki...</p> : null}
          {index.isError ? (
            <p className="page-state error">
              {index.error instanceof Error ? index.error.message : "Failed to load wiki index."}
            </p>
          ) : null}

          <div className="wiki-section-list">
            {quickLinks.length > 0 ? (
              <section className="wiki-section-group wiki-quick-links">
                <div className="wiki-section-title">
                  <span>Quick links</span>
                  <span>{quickLinks.length}</span>
                </div>
                <div className="wiki-entry-list">
                  {quickLinks.map((link) => (
                    <WikiSidebarButton
                      key={link.path}
                      path={link.path}
                      title={link.label}
                      summary={link.summary}
                      selected={selectedPath === link.path}
                      extraClass="is-quick-link"
                      onOpenPath={openPath}
                    />
                  ))}
                </div>
              </section>
            ) : null}

            {normalizedFilter.length > 0 ? (
              <>
                {search.isLoading ? <p className="page-state">Searching wiki...</p> : null}
                {search.isError ? (
                  <p className="page-state error">
                    {search.error instanceof Error
                      ? `${search.error.message} Showing path/title matches only.`
                      : "Wiki search failed. Showing path/title matches only."}
                  </p>
                ) : null}
                {showingServerSearch ? (
                  search.data.results.length > 0 ? (
                    <section className="wiki-section-group">
                      <div className="wiki-section-title">
                        <span>Search</span>
                        <span>{search.data.results.length}</span>
                      </div>
                      <div className="wiki-entry-list">
                        {search.data.results.map((result) => (
                          <WikiSearchButton
                            key={result.path}
                            result={result}
                            selected={selectedPath === result.path}
                            onOpenPath={openPath}
                          />
                        ))}
                      </div>
                    </section>
                  ) : (
                    <p className="page-state">No wiki matches for "{normalizedFilter}".</p>
                  )
                ) : (
                  <WikiSectionGroups
                    entries={fallbackFilteredEntries}
                    selectedPath={selectedPath}
                    onOpenPath={openPath}
                  />
                )}
              </>
            ) : (
              <WikiSectionGroups
                entries={allEntries}
                selectedPath={selectedPath}
                onOpenPath={openPath}
              />
            )}
          </div>
        </aside>

        <article className="card wiki-reader">
          {page.isLoading ? <p className="page-state">Loading wiki page...</p> : null}
          {page.isError ? (
            <p className="page-state error">
              {page.error instanceof Error ? page.error.message : "Failed to load wiki page."}
            </p>
          ) : null}
          {page.data ? <WikiReader page={page.data} onOpenPath={openPath} /> : null}
        </article>
      </div>
    </section>
  );
}

function WikiSectionGroups({
  entries,
  selectedPath,
  onOpenPath,
}: {
  entries: WikiIndexEntry[];
  selectedPath: string;
  onOpenPath: (path: string) => void;
}) {
  return (
    <>
      {SECTION_ORDER.map((section) => {
        const sectionEntries = entries.filter((entry) => entry.section === section);
        if (sectionEntries.length === 0) return null;
        return (
          <section key={section} className="wiki-section-group">
            <div className="wiki-section-title">
              <span>{section}</span>
              <span>{sectionEntries.length}</span>
            </div>
            <div className="wiki-entry-list">
              {sectionEntries.map((entry) => (
                <WikiSidebarButton
                  key={entry.path}
                  path={entry.path}
                  title={entry.title}
                  summary={entry.summary}
                  selected={selectedPath === entry.path}
                  onOpenPath={onOpenPath}
                />
              ))}
            </div>
          </section>
        );
      })}
    </>
  );
}

function WikiSearchButton({
  result,
  selected,
  onOpenPath,
}: {
  result: WikiSearchResult;
  selected: boolean;
  onOpenPath: (path: string) => void;
}) {
  return (
    <WikiSidebarButton
      path={result.path}
      title={result.title}
      summary={result.snippet || result.summary}
      selected={selected}
      extraClass="is-search-result"
      onOpenPath={onOpenPath}
    />
  );
}

function WikiSidebarButton({
  path,
  title,
  summary,
  selected,
  onOpenPath,
  extraClass = "",
}: {
  path: string;
  title: string;
  summary: string;
  selected: boolean;
  onOpenPath: (path: string) => void;
  extraClass?: string;
}) {
  const className = `wiki-entry-button${selected ? " is-active" : ""}${extraClass ? ` ${extraClass}` : ""}`;

  return (
    <button
      type="button"
      className={className}
      onClick={() => onOpenPath(path)}
    >
      <strong>{title}</strong>
      <span className="wiki-entry-path mono">{path}</span>
      {summary ? <span className="wiki-entry-summary wiki-entry-snippet">{summary}</span> : null}
    </button>
  );
}

function WikiReader({
  page,
  onOpenPath,
}: {
  page: WikiPageResponse;
  onOpenPath: (path: string) => void;
}) {
  const html = renderWikiHtml(page.body, page.links);
  const frontmatterEntries = Object.entries(page.frontmatter);

  return (
    <div className="wiki-reader-body">
      <div className="wiki-reader-header">
        <div>
          <div className="wiki-reader-path mono">{page.path}</div>
          <h2 className="wiki-reader-title">{page.title}</h2>
          {page.summary ? <p className="wiki-reader-summary">{page.summary}</p> : null}
        </div>
        <div className="wiki-reader-meta">
          <span className="badge">updated {formatDateTime(page.modifiedAt)}</span>
          <span className="badge">{formatNumber(page.sizeBytes)} bytes</span>
          {page.taskIds.map((taskId) => (
            <span key={taskId} className="badge">
              {taskId}
            </span>
          ))}
        </div>
      </div>

      {frontmatterEntries.length > 0 ? (
        <div className="wiki-frontmatter">
          {frontmatterEntries.map(([key, value]) => (
            <div key={key} className="wiki-frontmatter-row">
              <span className="wiki-frontmatter-key">{key}</span>
              <span className="wiki-frontmatter-value">
                {Array.isArray(value) ? value.join(", ") : value}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      <div
        className="wiki-markdown"
        onClick={(event) => {
          const target = event.target;
          if (!(target instanceof HTMLElement)) return;
          const anchor = target.closest("a[data-wiki-path]");
          if (!(anchor instanceof HTMLAnchorElement)) return;
          const nextPath = anchor.getAttribute("data-wiki-path");
          if (!nextPath) return;
          event.preventDefault();
          onOpenPath(nextPath);
        }}
        dangerouslySetInnerHTML={{ __html: html }}
      />
    </div>
  );
}
