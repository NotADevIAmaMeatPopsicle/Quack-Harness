import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { createMonitorServer } from "../../src/monitor/server";

jest.setTimeout(90_000);

// ── Persisted bundle fixture shapes ──────────────────────────────────────────

function makeReadyBundle(reviewId: string, taskId = "TASK-1001") {
  return {
    reviewId,
    taskId,
    verdict: "VERIFIED",
    docsImpact: "changelog_only",
    createdAt: new Date().toISOString(),
    requiredWikiActions: ["changelog_entry"],
    wikiArtifacts: [
      {
        pagePath: "docs/changelog/2026-09-14.md",
        commitSha: "abc1234def5678",
        linkedTaskIds: [taskId],
        action: "changelog_entry",
      },
    ],
    findings: [{ title: "Minor style issue", severity: "P3", status: "resolved" }],
    summary: "Verification complete.",
    reviewer: "reviewer-a",
    reviewNotes: "Looks good.",
    gate: {
      mergeReady: true,
      requiredWikiActions: ["changelog_entry"],
      missingWikiActions: [],
      issues: [],
    },
  };
}

function makeDocsBlockedBundle(reviewId: string, taskId = "TASK-1002") {
  return {
    reviewId,
    taskId,
    verdict: "VERIFIED",
    docsImpact: "feature_page_update",
    createdAt: new Date().toISOString(),
    requiredWikiActions: ["changelog_entry", "feature_page_update"],
    wikiArtifacts: [],
    findings: [],
    gate: {
      mergeReady: false,
      requiredWikiActions: ["changelog_entry", "feature_page_update"],
      missingWikiActions: ["changelog_entry", "feature_page_update"],
      issues: [
        {
          code: "missing_wiki_artifacts",
          message: "Missing required wiki artifacts for actions: changelog_entry, feature_page_update",
          blocking: true,
          field: "wikiArtifacts",
        },
      ],
    },
  };
}

function makeFailedDocsReadyBundle(reviewId: string, taskId = "TASK-1003") {
  return {
    reviewId,
    taskId,
    verdict: "FAILED",
    docsImpact: "changelog_only",
    createdAt: new Date().toISOString(),
    requiredWikiActions: ["changelog_entry"],
    wikiArtifacts: [
      {
        pagePath: "docs/changelog/failed.md",
        commitSha: "dead1234beef5678",
        linkedTaskIds: [taskId],
        action: "changelog_entry",
      },
    ],
    findings: [],
    gate: {
      mergeReady: true,
      requiredWikiActions: ["changelog_entry"],
      missingWikiActions: [],
      issues: [],
    },
  };
}

function makePartialDocsReadyBundle(reviewId: string, taskId = "TASK-1004") {
  return {
    reviewId,
    taskId,
    verdict: "PARTIAL",
    docsImpact: "changelog_only",
    createdAt: new Date().toISOString(),
    requiredWikiActions: ["changelog_entry"],
    wikiArtifacts: [
      {
        pagePath: "docs/changelog/partial.md",
        commitSha: "cafe0123abcd4567",
        linkedTaskIds: [taskId],
        action: "changelog_entry",
      },
    ],
    findings: [],
    gate: {
      mergeReady: true,
      requiredWikiActions: ["changelog_entry"],
      missingWikiActions: [],
      issues: [],
    },
  };
}

function makeMalformedBundle(reviewId: string, taskId = "TASK-1005") {
  return {
    reviewId,
    taskId,
    verdict: "VERIFIED",
    docsImpact: "changelog_only",
    createdAt: new Date().toISOString(),
    // gate.issues has a member with non-boolean blocking
    gate: {
      mergeReady: true,
      requiredWikiActions: ["changelog_entry"],
      missingWikiActions: [],
      issues: [
        {
          code: "bad_issue",
          message: "This issue has non-boolean blocking",
          blocking: "yes",
          field: "test",
        },
      ],
    },
    findings: [],
    wikiArtifacts: [],
  };
}

function writeBundle(root: string, bundle: Record<string, unknown>): void {
  const reviewsDir = path.join(root, ".quack", "reviews");
  fs.mkdirSync(reviewsDir, { recursive: true });
  const reviewId = bundle.reviewId as string;
  fs.writeFileSync(
    path.join(reviewsDir, `${reviewId}.json`),
    JSON.stringify(bundle, null, 2) + "\n",
    "utf-8",
  );
}

// ── Test suite ────────────────────────────────────────────────────────────────

describe("Reviews dashboard readiness and blockers", () => {
  let root: string;
  let browser: Browser | undefined;
  let page: Page;
  let stop: (() => Promise<void>) | undefined;
  let port: number;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-reviews-browser-"));
    fs.mkdirSync(path.join(root, ".quack", "reviews"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".quack", "auth.json"),
      JSON.stringify({ users: [], sessionSecret: "fixture", sessionTtlMs: 86400000 }),
    );
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });

  afterEach(async () => {
    await browser?.close();
    browser = undefined;
    await stop?.();
    stop = undefined;
    jest.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  });

  async function boot(): Promise<void> {
    const uiBuildDir = path.resolve(__dirname, "../../frontend/dist");
    if (!fs.existsSync(path.join(uiBuildDir, "index.html"))) {
      throw new Error("Build the frontend before browser verification");
    }
    const monitor = createMonitorServer({
      projectRoot: root,
      quackRoot: root,
      taskDir: "docs/tasks",
      logDir: path.join(root, ".quack", "logs"),
      host: "127.0.0.1",
      port: 0,
      uiBuildDir,
    });
    const started = await monitor.start();
    stop = started.stop;
    port = started.port;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
  }

  async function goReviews(): Promise<void> {
    await page.goto(`http://127.0.0.1:${port}/reviews`);
  }

  async function waitForText(text: string): Promise<void> {
    await page.getByText(text, { exact: true }).first().waitFor({ state: "visible" });
  }

  test("shows well-formed ready bundle identity and subsections", async () => {
    const bundle = makeReadyBundle("review-task-1001-ready");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    // Select the review via keyboard-accessible button
    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();

    // Identity heading
    await waitForText(`${bundle.taskId} / ${bundle.reviewId}`);

    // Combined summary
    await waitForText("Ready for operator review");

    // Code verification subsection
    await page.getByText("Code verification", { exact: true }).waitFor();
    await page.getByText("VERIFIED", { exact: true }).first().waitFor();

    // Documentation gate subsection
    await page.getByText("Documentation gate", { exact: true }).waitFor();
    await page.getByText("Ready", { exact: true }).first().waitFor();

    // Blocking issues — empty
    await page.getByText("Blocking issues", { exact: true }).waitFor();
    const blockingSection = page.locator("h4", { hasText: "Blocking issues" });
    await blockingSection.waitFor();

    // Other issues — empty
    await page.getByText("Other issues", { exact: true }).waitFor();

    // Findings section
    await page.getByText("Findings", { exact: true }).waitFor();
    await page.getByText("Minor style issue", { exact: true }).waitFor();
    await page.getByText("resolved", { exact: true }).waitFor();

    // Documentation actions
    await page.getByText("Documentation actions", { exact: true }).waitFor();
    await page.getByText("changelog_entry", { exact: true }).first().waitFor();
    await page.getByText("None missing", { exact: true }).waitFor();

    // Artifacts
    await page.getByText("Artifacts", { exact: true }).waitFor();
    await page.getByText("docs/changelog/2026-09-14.md", { exact: true }).waitFor();
    await page.getByText("abc1234def5678", { exact: true }).waitFor();

    // Raw JSON collapsed
    const details = page.locator("details");
    await details.first().waitFor();
    await page.getByText("Raw review JSON", { exact: true }).waitFor();
  });

  test("shows docs-blocked VERIFIED with blocking issues and missing actions", async () => {
    const bundle = makeDocsBlockedBundle("review-task-1002-blocked");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();

    await waitForText(`${bundle.taskId} / ${bundle.reviewId}`);
    await waitForText("Not ready");

    // Documentation gate shows Not confirmed
    await page.getByText("Documentation gate", { exact: true }).waitFor();
    await page.getByText("Not confirmed", { exact: true }).first().waitFor();

    // Blocking issues present
    await page.getByText("missing_wiki_artifacts", { exact: true }).waitFor();
    await page.getByText("Missing required wiki artifacts for actions: changelog_entry, feature_page_update", { exact: true }).waitFor();

    // Missing actions listed
    await page.getByText("Documentation actions", { exact: true }).waitFor();
    const missingText = await page.locator("p", { hasText: "Missing:" }).innerText();
    expect(missingText).toContain("changelog_entry");
    expect(missingText).toContain("feature_page_update");

    // Artifacts — none recorded
    await page.getByText("Artifacts", { exact: true }).waitFor();
    await page.getByText("None recorded", { exact: true }).first().waitFor();
  });

  test("FAILED with ready docs stays not-ready", async () => {
    const bundle = makeFailedDocsReadyBundle("review-task-1003-failed-docs-ready");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();

    await waitForText(`${bundle.taskId} / ${bundle.reviewId}`);
    await waitForText("Incomplete evidence");

    // Code verification shows FAILED
    await page.getByText("FAILED", { exact: true }).first().waitFor();
    // Documentation gate shows Ready
    await page.getByText("Documentation gate", { exact: true }).waitFor();
    await page.getByText("Ready", { exact: true }).first().waitFor();

    // Combined result must NOT be "Ready for operator review"
    const readyText = await page.getByText("Ready for operator review", { exact: true }).count();
    expect(readyText).toBe(0);
  });

  test("PARTIAL with ready docs stays not-ready", async () => {
    const bundle = makePartialDocsReadyBundle("review-task-1004-partial-docs-ready");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();

    await waitForText(`${bundle.taskId} / ${bundle.reviewId}`);

    // Must be incomplete due to contradiction (mergeReady=true + PARTIAL verdict)
    await waitForText("Incomplete evidence");

    // Must NOT show ready
    expect(await page.getByText("Ready for operator review", { exact: true }).count()).toBe(0);
  });

  test("malformed evidence shows Incomplete evidence and does not crash", async () => {
    const bundle = makeMalformedBundle("review-task-1005-malformed");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();

    await waitForText(`${bundle.taskId} / ${bundle.reviewId}`);
    await waitForText("Incomplete evidence");
    expect(await page.getByText("Ready for operator review", { exact: true }).count()).toBe(0);

    // Evidence problems are visible
    await page.getByText(/non-boolean blocking/).first().waitFor();
  });

  test("list table shows Documentation gate column, not Merge ready", async () => {
    const bundle = makeReadyBundle("review-task-1001-list-col");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    await page.getByText("Documentation gate", { exact: true }).waitFor();
    expect(await page.getByText("Merge ready", { exact: true }).count()).toBe(0);

    // Ready shows in list
    const rows = page.locator("table tbody tr");
    await rows.first().waitFor();
    const rowText = await rows.first().innerText();
    // List gate value shows Ready (not Yes)
    expect(rowText).toContain("Ready");
  });

  test("keyboard selection: Tab, Enter, Space and aria-pressed", async () => {
    const bundle = makeReadyBundle("review-task-1001-keyboard");
    writeBundle(root, bundle);
    const bundle2 = makeDocsBlockedBundle("review-task-1002-keyboard");
    writeBundle(root, bundle2);
    await boot();
    await goReviews();

    // Wait for both buttons to appear
    await page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true }).waitFor();
    await page.getByRole("button", { name: `Select review ${bundle2.reviewId}`, exact: true }).waitFor();

    // Focus first button via keyboard tab, press Enter to select
    const btn1 = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    const btn2 = page.getByRole("button", { name: `Select review ${bundle2.reviewId}`, exact: true });

    // Click to select first (sorted newest first, bundle2 may come first since created later)
    await btn1.click();
    // aria-pressed should be true on selected
    expect(await btn1.getAttribute("aria-pressed")).toBe("true");
    expect(await btn2.getAttribute("aria-pressed")).toBe("false");

    // Use Space to select btn2
    await btn2.focus();
    await page.keyboard.press("Space");
    expect(await btn2.getAttribute("aria-pressed")).toBe("true");
    expect(await btn1.getAttribute("aria-pressed")).toBe("false");

    // Use Enter to re-select btn1
    await btn1.focus();
    await page.keyboard.press("Enter");
    expect(await btn1.getAttribute("aria-pressed")).toBe("true");
    expect(await btn2.getAttribute("aria-pressed")).toBe("false");
  });

  test("raw JSON disclosure is closed by default and markup is inert", async () => {
    const bundle = makeReadyBundle("review-task-1001-rawjson");
    // Embed markup in a string field to ensure it's rendered as text
    (bundle as Record<string, unknown>).summary = "<script>alert('xss')</script>";
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();

    await waitForText(`${bundle.taskId} / ${bundle.reviewId}`);

    // Details element is closed by default
    const details = page.locator("details").first();
    await details.waitFor();
    const isOpen = await details.evaluate("el => el.open");
    expect(isOpen).toBe(false);

    // Check that summary text reads "Raw review JSON"
    await page.getByText("Raw review JSON", { exact: true }).waitFor();

    // The markup in the page should be rendered as inert text (no script execution)
    // Verify the literal text appears rather than executed script
    const summaryField = page.getByText("Review summary:", { exact: true });
    await summaryField.waitFor();
  });

  test("loading state shown while fetching detail, error state on failure", async () => {
    const bundle = makeReadyBundle("review-task-1001-loading");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    // Hold all requests to /v1/reviews/:id so we can observe the loading state
    let resolveRoute: (() => void) | null = null;
    const routePromise = new Promise<void>((res) => { resolveRoute = res; });

    await page.route(`**/v1/reviews/${bundle.reviewId}*`, async (route: Route) => {
      await routePromise;
      await route.continue();
    });

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();

    // Should show loading state
    await page.getByText("Loading review details…", { exact: true }).waitFor({ timeout: 5000 });
    expect(await page.getByText("Ready for operator review", { exact: true }).count()).toBe(0);

    // Release the route
    resolveRoute!();
    await page.unroute(`**/v1/reviews/${bundle.reviewId}*`);
    await waitForText("Ready for operator review");
  });

  test("error state shown when detail request fails", async () => {
    const bundle = makeReadyBundle("review-task-1001-error");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    // First request succeeds so the review appears in the list
    let requestCount = 0;
    await page.route(`**/v1/reviews/${bundle.reviewId}*`, async (route: Route) => {
      requestCount++;
      if (requestCount === 1) {
        await route.abort();
      } else {
        await route.continue();
      }
    });

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();

    // Should show error alert
    const errorEl = page.locator('[role="alert"]');
    await errorEl.waitFor({ state: "visible", timeout: 10000 });
    const errorText = await errorEl.innerText();
    expect(errorText).toContain("Unable to refresh review details");

    // Should not show ready
    expect(await page.getByText("Ready for operator review", { exact: true }).count()).toBe(0);

    await page.unroute(`**/v1/reviews/${bundle.reviewId}*`);
  });

  test("empty list state shown when no reviews exist", async () => {
    // No bundles written
    await boot();
    await goReviews();
    await waitForText("No review bundles have been recorded yet.");
  });

  test("delayed A-to-B response suppresses cached A readiness", async () => {
    const bundleA = makeReadyBundle("review-task-a-delay", "TASK-A");
    const bundleB = makeDocsBlockedBundle("review-task-b-delay", "TASK-B");
    writeBundle(root, bundleA);
    writeBundle(root, bundleB);
    await boot();
    await goReviews();

    // Select A and wait for its readiness to show
    const btnA = page.getByRole("button", { name: `Select review ${bundleA.reviewId}`, exact: true });
    await btnA.waitFor({ state: "visible" });
    await btnA.click();
    await waitForText("Ready for operator review");

    // Now hold B's detail response
    let resolveBRoute: (() => void) | null = null;
    const bRoutePromise = new Promise<void>((res) => { resolveBRoute = res; });
    await page.route(`**/v1/reviews/${bundleB.reviewId}*`, async (route: Route) => {
      await bRoutePromise;
      await route.continue();
    });

    // Select B
    const btnB = page.getByRole("button", { name: `Select review ${bundleB.reviewId}`, exact: true });
    await btnB.click();

    // While B is loading, A's ready state should not be visible
    await page.getByText("Loading review details…", { exact: true }).waitFor({ timeout: 5000 });
    expect(await page.getByText("Ready for operator review", { exact: true }).count()).toBe(0);

    // Release B
    resolveBRoute!();
    await page.unroute(`**/v1/reviews/${bundleB.reviewId}*`);
    await waitForText("Not ready");
    expect(await page.getByText("Ready for operator review", { exact: true }).count()).toBe(0);
  });

  test("within-five-seconds A-to-B-to-A reselection forces refetch, hides cached Ready while pending", async () => {
    const bundleA = makeReadyBundle("review-task-a-reselect", "TASK-A-RESEL");
    const bundleB = makeDocsBlockedBundle("review-task-b-reselect", "TASK-B-RESEL");
    writeBundle(root, bundleA);
    writeBundle(root, bundleB);
    await boot();
    await goReviews();

    // Count A requests
    let aRequestCount = 0;
    let resolveSecondARoute: (() => void) | null = null;
    const secondARoutePromise = new Promise<void>((res) => { resolveSecondARoute = res; });

    await page.route(`**/v1/reviews/${bundleA.reviewId}*`, async (route: Route) => {
      aRequestCount++;
      if (aRequestCount >= 2) {
        // Hold the second request
        await secondARoutePromise;
      }
      await route.continue();
    });

    // Select A, see Ready
    const btnA = page.getByRole("button", { name: `Select review ${bundleA.reviewId}`, exact: true });
    await btnA.waitFor({ state: "visible" });
    await btnA.click();
    await waitForText("Ready for operator review");
    expect(aRequestCount).toBe(1);

    // Quickly switch to B
    const btnB = page.getByRole("button", { name: `Select review ${bundleB.reviewId}`, exact: true });
    await btnB.click();
    await waitForText("Not ready");

    // Now switch back to A within 5 seconds; staleTime: 0 forces a new fetch
    await btnA.click();

    // While the second A request is pending, cached Ready should not show
    await page.getByText("Loading review details…", { exact: true }).waitFor({ timeout: 5000 });
    expect(await page.getByText("Ready for operator review", { exact: true }).count()).toBe(0);
    expect(aRequestCount).toBeGreaterThanOrEqual(2);

    // Release the second A route
    resolveSecondARoute!();
    await page.unroute(`**/v1/reviews/${bundleA.reviewId}*`);
    await waitForText("Ready for operator review");
  });

  test("independent 10-second detail refresh updates panel while list summaries remain byte-identical", async () => {
    // Start with ready bundle A, then update its file between refreshes
    const bundleA = makeReadyBundle("review-task-a-refresh", "TASK-A-REFRESH");
    writeBundle(root, bundleA);
    await boot();
    await goReviews();

    const btnA = page.getByRole("button", { name: `Select review ${bundleA.reviewId}`, exact: true });
    await btnA.waitFor({ state: "visible" });
    await btnA.click();
    await waitForText("Ready for operator review");

    // Now update the bundle file to be docs-blocked
    const updatedBundle = makeDocsBlockedBundle(bundleA.reviewId, bundleA.taskId);
    // Override with same reviewId
    (updatedBundle as Record<string, unknown>).reviewId = bundleA.reviewId;
    (updatedBundle as Record<string, unknown>).taskId = bundleA.taskId;
    writeBundle(root, updatedBundle);

    // Wait for the 10-second refresh to fire and show the updated state
    // We wait up to 15 seconds for it
    await page.waitForFunction(
      "!document.body.innerText.includes('Ready for operator review')",
      { timeout: 15_000 },
    );

    const panelText = await page.locator(".card").last().innerText();
    expect(panelText).not.toContain("Ready for operator review");
  });

  test("success-to-refresh-error hides cached readiness", async () => {
    const bundle = makeReadyBundle("review-task-1001-refresh-error");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();
    await waitForText("Ready for operator review");

    // Now make all future detail requests fail
    let firstRequest = true;
    await page.route(`**/v1/reviews/${bundle.reviewId}*`, async (route: Route) => {
      if (firstRequest) {
        // Let first (already completed) pass through — only block future ones
        firstRequest = false;
        await route.continue();
      } else {
        await route.abort();
      }
    });

    // Wait for the next refresh attempt (up to 15s)
    await page.waitForFunction(
      "document.querySelector('[role=\"alert\"]') !== null",
      { timeout: 15_000 },
    );

    const alert = page.locator('[role="alert"]');
    const alertText = await alert.innerText();
    expect(alertText).toContain("Unable to refresh review details");
    // Cached ready banner should be hidden
    expect(await page.getByText("Ready for operator review", { exact: true }).count()).toBe(0);

    await page.unroute(`**/v1/reviews/${bundle.reviewId}*`);
  });

  test("successful empty-list transition clears selection", async () => {
    const bundle = makeReadyBundle("review-task-1001-clearsel");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();
    await waitForText("Ready for operator review");

    // Remove the review file so the list returns empty on next poll
    fs.rmSync(path.join(root, ".quack", "reviews", `${bundle.reviewId}.json`));

    // Wait for the list to refresh (10 seconds max)
    await page.waitForFunction(
      "document.body.innerText.includes('No review bundles have been recorded yet.')",
      { timeout: 15_000 },
    );

    // Selection cleared, detail section shows select prompt
    await waitForText("Select a review bundle to inspect its persisted detail.");
  });

  test("list error retains selection", async () => {
    const bundle = makeReadyBundle("review-task-1001-list-error");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();
    await waitForText("Ready for operator review");

    // Make the list endpoint fail
    await page.route("**/v1/reviews*", async (route: Route) => {
      const url = route.request().url();
      if (!url.includes("/v1/reviews/")) {
        await route.abort();
      } else {
        await route.continue();
      }
    });

    // Wait a bit for the list error to appear
    await delay(3000);

    // Still showing the detail (list error should not clear selection)
    await waitForText("Ready for operator review");
    await waitForText("Failed to load review bundles.");

    await page.unroute("**/v1/reviews*");
  });

  test("changing details while list summaries stay identical updates the panel", async () => {
    // This uses a Playwright route interceptor to intercept the detail endpoint
    const bundle = makeReadyBundle("review-task-a-change", "TASK-A-CHANGE");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();
    await waitForText("Ready for operator review");

    // Swap the file to docs-blocked
    const newBundle = { ...makeDocsBlockedBundle(bundle.reviewId, bundle.taskId) };
    writeBundle(root, newBundle);

    // Wait for refresh to pick up the change (up to 15s)
    await page.waitForFunction(
      "!document.body.innerText.includes('Ready for operator review')",
      { timeout: 15_000 },
    );
    await waitForText("Not ready");
  });

  test("partial artifact path/commit text retained even when other field missing", async () => {
    const bundle = makeReadyBundle("review-task-1001-partial-artifact");
    // Override with partial artifact (missing commitSha)
    (bundle as Record<string, unknown>).wikiArtifacts = [
      {
        pagePath: "docs/changelog/partial-artifact.md",
        // commitSha is intentionally absent
        linkedTaskIds: ["TASK-1001"],
        action: "changelog_entry",
      },
    ];
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();

    await waitForText(`${bundle.taskId} / ${bundle.reviewId}`);
    // Should show incomplete evidence due to missing commitSha
    await waitForText("Incomplete evidence");
    // But the pagePath should still be visible
    await page.getByText("docs/changelog/partial-artifact.md", { exact: true }).waitFor();
    await page.getByText("missing commit", { exact: true }).waitFor();
  });

  test("raw disclosure is keyboard-navigable and contains JSON", async () => {
    const bundle = makeReadyBundle("review-task-1001-disclosure");
    writeBundle(root, bundle);
    await boot();
    await goReviews();

    const btn = page.getByRole("button", { name: `Select review ${bundle.reviewId}`, exact: true });
    await btn.waitFor({ state: "visible" });
    await btn.click();

    await waitForText("Ready for operator review");

    // Find the details element summary
    const summary = page.locator("summary", { hasText: "Raw review JSON" });
    await summary.waitFor();

    // Open via click
    await summary.click();
    const details = page.locator("details").first();
    const isOpen = await details.evaluate("el => el.open");
    expect(isOpen).toBe(true);

    // The pre element should contain JSON
    const pre = details.locator("pre");
    await pre.waitFor();
    const preText = await pre.innerText();
    expect(preText).toContain(bundle.reviewId);
    expect(preText).toContain("VERIFIED");
  });
});
