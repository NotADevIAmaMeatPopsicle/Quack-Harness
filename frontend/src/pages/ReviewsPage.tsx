import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { getReview, listReviews } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../lib/format";
import { presentReviewReadiness } from "../lib/review-readiness";

export function ReviewsPage() {
  const [selectedReviewId, setSelectedReviewId] = useState<string | null>(null);
  const reviews = useQuery({
    queryKey: ["reviews"],
    queryFn: listReviews,
    refetchInterval: 10000,
  });
  const reviewDetail = useQuery({
    queryKey: ["review", selectedReviewId],
    queryFn: () => getReview(selectedReviewId!),
    enabled: Boolean(selectedReviewId),
    refetchInterval: 10000,
    staleTime: 0,
    refetchOnMount: "always",
  });

  useEffect(() => {
    if (!reviews.isSuccess) return;
    setSelectedReviewId((current) => {
      if (current && reviews.data.reviews.some((review) => review.reviewId === current)) {
        return current;
      }
      return reviews.data.reviews[0]?.reviewId ?? null;
    });
  }, [reviews.data, reviews.isSuccess]);

  const detailReview = reviewDetail.data?.review;
  const detailMatches =
    reviewDetail.isSuccess &&
    !reviewDetail.isFetching &&
    !reviewDetail.isError &&
    reviewDetail.data?.ok === true &&
    reviewDetail.data.reviewId === selectedReviewId &&
    detailReview !== null &&
    typeof detailReview === "object" &&
    !Array.isArray(detailReview) &&
    "reviewId" in detailReview &&
    detailReview.reviewId === selectedReviewId;
  const readiness = detailMatches ? presentReviewReadiness(detailReview) : null;

  function gateLabel(mergeReady?: boolean): string {
    if (mergeReady === true) return "Ready";
    if (mergeReady === false) return "Not confirmed";
    return "Unknown";
  }

  function readinessSummaryText(r: ReturnType<typeof presentReviewReadiness>): string {
    switch (r.readiness) {
      case "ready":
        return "Ready for operator review";
      case "not-ready":
        return "Not ready";
      case "unknown":
        return "Unknown";
      case "incomplete":
        return "Incomplete evidence";
    }
  }

  return (
    <div className="page">
      <PageHeader
        title="Reviews"
        subtitle="Review bundles, docs gate state, and the persisted detail payload for verification closeout."
      />
      <section className="card">
        {reviews.isLoading && <p>Loading...</p>}
        {reviews.isError && <p className="error">Failed to load review bundles.</p>}
        {reviews.data && reviews.data.reviews.length === 0 && (
          <p className="empty-state">No review bundles have been recorded yet.</p>
        )}
        {reviews.data && reviews.data.reviews.length > 0 && (
          <table className="table">
            <thead>
              <tr>
                <th>Review</th>
                <th>Task</th>
                <th>Verdict</th>
                <th>Documentation gate</th>
                <th>Docs impact</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {reviews.data.reviews.map((review) => (
                <tr
                  key={review.reviewId}
                  className={review.reviewId === selectedReviewId ? "is-selected" : undefined}
                >
                  <td>
                    <button
                      type="button"
                      className="btn btn-sm mono"
                      aria-label={`Select review ${review.reviewId}`}
                      aria-pressed={review.reviewId === selectedReviewId}
                      onClick={() => setSelectedReviewId(review.reviewId)}
                    >
                      {review.reviewId}
                    </button>
                  </td>
                  <td className="mono">{review.taskId}</td>
                  <td>{review.verdict}</td>
                  <td>{gateLabel(review.mergeReady)}</td>
                  <td>{review.docsImpact ?? "-"}</td>
                  <td className="muted">{formatDateTime(review.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card" aria-labelledby="review-detail-heading">
        <div className="card-header">
          <h2 id="review-detail-heading">Review Detail</h2>
          {selectedReviewId && <span className="mono">{selectedReviewId}</span>}
        </div>
        {!selectedReviewId && (
          <p className="empty-state">Select a review bundle to inspect its persisted detail.</p>
        )}
        {selectedReviewId && reviewDetail.isFetching && !readiness && (
          <p role="status">Loading review details…</p>
        )}
        {selectedReviewId &&
          !reviewDetail.isFetching &&
          (reviewDetail.isError || (reviewDetail.isSuccess && !readiness)) && (
            <p className="error" role="alert">
              Unable to refresh review details
            </p>
          )}
        {selectedReviewId &&
          !reviewDetail.isFetching &&
          !reviewDetail.isError &&
          !readiness &&
          !reviewDetail.isSuccess && <p role="status">Loading review details…</p>}
        {readiness && (
          <div>
            <h3>
              {readiness.taskId ?? "Unknown task"} / {readiness.reviewId ?? "Unknown review"}
            </h3>
            <p>
              <strong>Summary:</strong> <span>{readinessSummaryText(readiness)}</span>
            </p>
            {readiness.evidenceProblems.length > 0 && (
              <ul className="error">
                {readiness.evidenceProblems.map((problem, i) => (
                  <li key={i}>{problem}</li>
                ))}
              </ul>
            )}

            <h4>Code verification</h4>
            <p>{readiness.verdict}</p>

            <h4>Documentation gate</h4>
            <p>
              {readiness.documentation === "ready"
                ? "Ready"
                : readiness.documentation === "not-ready"
                  ? "Not confirmed"
                  : "Unknown"}
            </p>

            <h4>Blocking issues</h4>
            {readiness.issues.filter((i) => i.disposition === "blocking").length === 0 ? (
              <p className="muted">None recorded</p>
            ) : (
              <ul>
                {readiness.issues
                  .filter((i) => i.disposition === "blocking")
                  .map((issue, idx) => (
                    <li key={idx}>
                      <strong>{issue.code}</strong>
                      {issue.field ? ` (${issue.field})` : ""}: {issue.message}
                      {issue.blockReasonCode ? ` [${issue.blockReasonCode}]` : ""}
                    </li>
                  ))}
              </ul>
            )}

            <h4>Other issues</h4>
            {readiness.issues.filter((i) => i.disposition !== "blocking").length === 0 ? (
              <p className="muted">None recorded</p>
            ) : (
              <ul>
                {readiness.issues
                  .filter((i) => i.disposition !== "blocking")
                  .map((issue, idx) => (
                    <li key={idx}>
                      <span className="muted">[{issue.disposition}]</span>{" "}
                      <strong>{issue.code}</strong>
                      {issue.field ? ` (${issue.field})` : ""}: {issue.message}
                    </li>
                  ))}
              </ul>
            )}

            <h4>Findings</h4>
            {readiness.findings.length === 0 ? (
              <p className="muted">None recorded</p>
            ) : (
              <ul>
                {readiness.findings.map((finding, idx) => (
                  <li key={idx}>
                    <strong>{finding.severity}</strong> — {finding.title}{" "}
                    <span className="muted">({finding.status})</span>
                    {finding.file ? <span className="mono"> {finding.file}</span> : null}
                  </li>
                ))}
              </ul>
            )}

            <h4>Documentation actions</h4>
            <p>
              <strong>Required:</strong>{" "}
              {readiness.actions.required.length === 0
                ? "None required"
                : readiness.actions.required.join(", ")}
            </p>
            <p>
              <strong>Missing:</strong>{" "}
              {readiness.actions.missing.length === 0
                ? "None missing"
                : readiness.actions.missing.join(", ")}
            </p>

            <h4>Artifacts</h4>
            {readiness.artifacts.length === 0 ? (
              <p className="muted">None recorded</p>
            ) : (
              <ul>
                {readiness.artifacts.map((artifact, idx) => (
                  <li key={idx}>
                    {artifact.pagePath ? (
                      <span className="mono">{artifact.pagePath}</span>
                    ) : (
                      <span className="error">missing path</span>
                    )}{" "}
                    {artifact.commitSha ? (
                      <span className="mono">{artifact.commitSha}</span>
                    ) : (
                      <span className="error">missing commit</span>
                    )}
                    {artifact.action ? <span className="muted"> ({artifact.action})</span> : null}
                    {artifact.incomplete ? (
                      <span className="error"> — incomplete artifact evidence</span>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}

            {readiness.summary && (
              <p>
                <strong>Review summary:</strong> {readiness.summary}
              </p>
            )}
            {readiness.reviewer && (
              <p>
                <strong>Reviewer:</strong> {readiness.reviewer}
              </p>
            )}
            {readiness.reviewNotes && (
              <p>
                <strong>Review notes:</strong> {readiness.reviewNotes}
              </p>
            )}

            <details>
              <summary>Raw review JSON</summary>
              <pre className="stream pre-wrap">
                {JSON.stringify(reviewDetail.data?.review, null, 2)}
              </pre>
            </details>
          </div>
        )}
        {selectedReviewId && reviewDetail.isSuccess && !readiness && !reviewDetail.isFetching && (
          <details>
            <summary>Raw review JSON</summary>
            <pre className="stream pre-wrap">
              {JSON.stringify(reviewDetail.data?.review, null, 2)}
            </pre>
          </details>
        )}
      </section>
    </div>
  );
}
