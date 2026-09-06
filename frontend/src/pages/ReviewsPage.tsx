import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";

import { getReview, listReviews } from "../api/client";
import { PageHeader } from "../components/PageHeader";
import { formatDateTime } from "../lib/format";

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
  });

  useEffect(() => {
    const nextId = reviews.data?.reviews[0]?.reviewId;
    if (!selectedReviewId && nextId) {
      setSelectedReviewId(nextId);
    }
  }, [reviews.data, selectedReviewId]);

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
                <th>Merge ready</th>
                <th>Docs impact</th>
                <th>Created</th>
              </tr>
            </thead>
            <tbody>
              {reviews.data.reviews.map((review) => (
                <tr
                  key={review.reviewId}
                  className={review.reviewId === selectedReviewId ? "is-selected" : undefined}
                  onClick={() => setSelectedReviewId(review.reviewId)}
                  style={{ cursor: "pointer" }}
                >
                  <td className="mono">{review.reviewId}</td>
                  <td className="mono">{review.taskId}</td>
                  <td>{review.verdict}</td>
                  <td>{review.mergeReady ? "Yes" : "No"}</td>
                  <td>{review.docsImpact ?? "-"}</td>
                  <td className="muted">{formatDateTime(review.createdAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
      <section className="card">
        <div className="card-header">
          <h2>Review Detail</h2>
          {selectedReviewId && <span className="mono">{selectedReviewId}</span>}
        </div>
        {!selectedReviewId && <p className="empty-state">Select a review bundle to inspect its persisted detail.</p>}
        {reviewDetail.isLoading && selectedReviewId && <p>Loading detail...</p>}
        {reviewDetail.isError && selectedReviewId && <p className="error">Failed to load the selected review.</p>}
        {reviewDetail.data && (
          <pre className="stream pre-wrap">
            {JSON.stringify(reviewDetail.data.review, null, 2)}
          </pre>
        )}
      </section>
    </div>
  );
}
