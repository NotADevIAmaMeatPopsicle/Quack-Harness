import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Tests for TASK-086: Testing Dashboard Metrics Strip, Trends & Flaky Test Detection.
 *
 * These tests verify the HTML structure and JavaScript functions added to the
 * monitor dashboard for metrics strip, pass rate trends, suite duration heatmap,
 * flaky test detection panel, and command health detail.
 */

const HTML_PATH = path.join(__dirname, "..", "..", "src", "monitor", "public", "index.html");

// Read the HTML once for all tests
let html: string;

beforeAll(() => {
  html = fs.readFileSync(HTML_PATH, "utf-8");
});

// ─── Metrics Strip HTML Structure ─────────────────────────────────

describe("Metrics Strip", () => {
  it("has the testing-metrics-strip container", () => {
    expect(html).toContain('class="testing-metrics-strip"');
    expect(html).toContain('id="testingMetricsStrip"');
  });

  it("has Total Tests metric card with value and delta elements", () => {
    expect(html).toContain('id="metricTotalTests"');
    expect(html).toContain('id="metricTotalTestsDelta"');
    expect(html).toContain(">Total Tests<");
  });

  it("has Pass Rate metric card with value and delta elements", () => {
    expect(html).toContain('id="metricPassRate"');
    expect(html).toContain('id="metricPassRateDelta"');
    expect(html).toContain(">Pass Rate<");
  });

  it("has Suite Time metric card with value and delta elements", () => {
    expect(html).toContain('id="metricSuiteTime"');
    expect(html).toContain('id="metricSuiteTimeDelta"');
    expect(html).toContain(">Suite Time<");
  });

  it("has Flaky Tests metric card with click handler", () => {
    expect(html).toContain('id="metricFlakyTests"');
    expect(html).toContain("scrollToFlaky()");
    expect(html).toContain(">Flaky Tests<");
  });

  it("has Command Health metric card with health dots", () => {
    expect(html).toContain('id="metricCommandHealth"');
    expect(html).toContain('id="metricHealthLabel"');
    expect(html).toContain(">Command Health<");
  });
});

// ─── Metrics Strip CSS ────────────────────────────────────────────

describe("Metrics Strip CSS", () => {
  it("defines testing-metrics-strip grid layout", () => {
    expect(html).toContain(".testing-metrics-strip");
    expect(html).toContain("grid-template-columns: repeat(5, 1fr)");
  });

  it("defines testing-metric-card, label, value, and delta styles", () => {
    expect(html).toContain(".testing-metric-card");
    expect(html).toContain(".testing-metric-label");
    expect(html).toContain(".testing-metric-value");
    expect(html).toContain(".testing-metric-delta");
  });
});

// ─── Pass Rate Trend ──────────────────────────────────────────────

describe("Pass Rate Trend", () => {
  it("has the trend panel with header", () => {
    expect(html).toContain('id="testingTrendBody"');
    expect(html).toContain("Pass Rate Trend");
  });

  it("has trend bar CSS classes", () => {
    expect(html).toContain(".testing-trend-bar");
    expect(html).toContain(".testing-trend-track");
    expect(html).toContain(".testing-trend-pass");
    expect(html).toContain(".testing-trend-fail");
  });

  it("renders trend bars from taskResults with pass/fail split", () => {
    expect(html).toContain("testing-trend-pass");
    expect(html).toContain("testing-trend-fail");
    // Bars show percentage
    expect(html).toContain("passRate.toFixed(1)");
  });

  it("shows empty state when no task results", () => {
    expect(html).toContain("No dispatch test results yet");
  });
});

// ─── Suite Duration Heatmap ───────────────────────────────────────

describe("Suite Duration Heatmap", () => {
  it("has the suites panel with header", () => {
    expect(html).toContain('id="testingSuitesBody"');
    expect(html).toContain("Slowest Test Suites");
  });

  it("defensively sorts suites by avgDurationMs descending and takes top 10", () => {
    expect(html).toMatch(
      /slowestSuites\.slice\(\)\.sort\(\(a,\s*b\)\s*=>\s*b\.avgDurationMs\s*-\s*a\.avgDurationMs\)\.slice\(0,\s*10\)/,
    );
  });

  it("applies color intensity based on duration", () => {
    // Verify the heatmap intensity calculation
    expect(html).toContain("suite.avgDurationMs / 5000");
  });

  it("shows empty state when no suite data", () => {
    expect(html).toContain("No suite data yet");
  });
});

// ─── Flaky Test Detection Panel ───────────────────────────────────

describe("Flaky Test Detection Panel", () => {
  it("has the flaky test panel hidden by default", () => {
    expect(html).toMatch(/id="testingFlakyPanel"[^>]*style="display:none"/);
  });

  it("has flaky test body container", () => {
    expect(html).toContain('id="testingFlakyBody"');
  });

  it("hides panel when no flaky tests detected", () => {
    expect(html).toContain("flakyTests.length === 0");
    expect(html).toContain("flakyPanel.style.display = 'none'");
  });

  it("shows panel when flaky tests exist", () => {
    // After the length check, sets display to empty to show it
    expect(html).toContain("flakyPanel.style.display = ''");
  });

  it("renders flaky test items with test name and occurrence count", () => {
    expect(html).toContain("testing-flaky-item");
    expect(html).toContain("testing-flaky-test");
    expect(html).toContain("testing-flaky-occurrences");
    expect(html).toContain("ft.failureCount");
  });

  it("renders task links in flaky test items", () => {
    expect(html).toContain("testing-flaky-task-link");
    expect(html).toContain("ft.taskIds");
  });

  it("defines openTaskDetail function for flaky test task navigation", () => {
    expect(html).toContain("function openTaskDetail(taskId)");
    // Should switch to tasks tab
    expect(html).toMatch(/openTaskDetail[\s\S]*switchTab\('tasks'\)/);
    // Should toggle task detail
    expect(html).toMatch(/openTaskDetail[\s\S]*toggleTaskDetail\(taskId\)/);
  });

  it("flaky panel header contains warning emoji", () => {
    expect(html).toContain("⚠ Flaky Tests");
  });
});

// ─── Command Health Detail ────────────────────────────────────────

describe("Command Health Detail", () => {
  it("has the command health panel with header", () => {
    expect(html).toContain('id="testingCommandHealthBody"');
    expect(html).toContain("Verification Command Health");
  });

  it("renders command health table with proper columns", () => {
    expect(html).toContain("testing-cmd-health-table");
    expect(html).toContain("Pass Rate (Last 10)");
  });

  it("uses recentPassRate for pass rate display", () => {
    expect(html).toContain("cmd.recentPassRate");
  });

  it("uses timeAgo for last run timestamp", () => {
    expect(html).toContain("timeAgo(cmd.lastRunAt)");
  });

  it("shows empty state when no command history", () => {
    expect(html).toContain("No command history yet");
  });
});

describe("Adapter Freshness Indicators", () => {
  it("has a testing adapter freshness status element", () => {
    expect(html).toContain('id="testingAdapterFreshness"');
    expect(html).toContain("Adapter freshness");
  });

  it("renders adapter freshness in run history", () => {
    expect(html).toContain("function adapterFreshnessBadge");
    expect(html).toContain("run.adapterFreshness");
    expect(html).toContain("<th>Adapter</th>");
  });

  it("has research validation drift taxonomy surfaces", () => {
    expect(html).toContain('id="researchValidationDrift"');
    expect(html).toContain('id="researchValidationTaxonomy"');
    expect(html).toContain("Validation Drift");
  });
});

// ─── Dashboard Data Loading ───────────────────────────────────────

describe("Dashboard Data Loading", () => {
  it("fetches from /api/testing/dashboard endpoint", () => {
    expect(html).toContain("/api/testing/dashboard");
  });

  it("defines loadTestingDashboard function", () => {
    expect(html).toContain("async function loadTestingDashboard()");
  });

  it("defines renderTestingDashboard function", () => {
    expect(html).toContain("function renderTestingDashboard(data)");
  });

  it("stores dashboard data in testingDashboardData variable", () => {
    expect(html).toContain("let testingDashboardData = null");
  });

  it("handles missing data gracefully with early return", () => {
    expect(html).toContain("data = data || testingDashboardData");
    expect(html).toContain("if (!data) return");
  });
});

// ─── SSE Event Integration ────────────────────────────────────────

describe("SSE Event Integration", () => {
  it("handles test_dashboard_update event to refresh dashboard", () => {
    expect(html).toContain("test_dashboard_update");
    // The handler should call loadTestingDashboard
    expect(html).toMatch(/test_dashboard_update[\s\S]*?loadTestingDashboard\(\)/);
  });
});

// ─── Tab Switch Integration ───────────────────────────────────────

describe("Tab Switch Integration", () => {
  it("loads dashboard data when switching to testing tab", () => {
    // In the switchTab function for 'testing'
    expect(html).toMatch(/tabName === 'testing'[\s\S]*?loadTestingDashboard\(\)/);
  });
});

// ─── Delta Computation ────────────────────────────────────────────

describe("Delta Computation", () => {
  it("computes deltas from taskResults when at least 2 results exist", () => {
    expect(html).toContain("taskResults.length >= 2");
  });

  it("computes total tests delta", () => {
    expect(html).toContain("latest.totalTests - (prev.totalTests || 0)");
  });

  it("computes pass rate delta", () => {
    expect(html).toContain("latest.passRate - (prev.passRate || 0)");
  });

  it("computes suite time delta", () => {
    expect(html).toContain("(latest.durationMs || 0) - (prev.durationMs || 0)");
  });

  it("clears delta elements when insufficient data", () => {
    // When no latest data, clears deltas
    expect(html).toContain("document.getElementById('metricTotalTestsDelta').textContent = ''");
    expect(html).toContain("document.getElementById('metricPassRateDelta').textContent = ''");
    expect(html).toContain("document.getElementById('metricSuiteTimeDelta').textContent = ''");
  });

  it("uses arrows and color coding for delta display", () => {
    // Arrows
    expect(html).toContain("'▲'");
    expect(html).toContain("'▼'");
    // Color coding
    expect(html).toContain("var(--green)");
    expect(html).toContain("var(--red)");
  });
});

// ─── No Charting Libraries ────────────────────────────────────────

describe("CSS-Only Visualizations", () => {
  it("does not include any charting library", () => {
    expect(html).not.toContain("Chart.js");
    expect(html).not.toContain("d3.js");
    expect(html).not.toMatch(/\bd3\./);
    expect(html).not.toContain("plotly");
    expect(html).not.toContain("highcharts");
  });
});

// ─── No Regression ────────────────────────────────────────────────

describe("No Regression of Existing Features", () => {
  it("preserves loadTestingCommands function", () => {
    expect(html).toContain("async function loadTestingCommands()");
  });

  it("preserves loadTestingHistory function", () => {
    expect(html).toContain("async function loadTestingHistory()");
  });

  it("preserves testingRun function", () => {
    expect(html).toContain("async function testingRun(");
  });

  it("preserves Quick Actions panel", () => {
    expect(html).toContain("Quick Actions");
    expect(html).toContain("testingRunTest");
    expect(html).toContain("testingRunAll");
  });

  it("preserves Live Output Console", () => {
    expect(html).toContain("testingConsole");
  });

  it("preserves Run History panel", () => {
    expect(html).toContain("testingHistoryBody");
  });
});
