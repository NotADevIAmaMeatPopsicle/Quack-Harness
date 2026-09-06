/**
 * Tests for TASK-085: Structured Test Results Panel & Baseline Visualization.
 *
 * Validates that the dashboard HTML includes all required UI elements,
 * CSS classes, and JavaScript functions for the structured results panel,
 * dispatch dashboard, view toggle, SSE event handling, and baseline badges.
 */

import * as fs from "node:fs";
import * as path from "node:path";

// ─── HTML content loaded once ────────────────────────────────────
const htmlPath = path.join(__dirname, "..", "..", "src", "monitor", "public", "index.html");
const html = fs.readFileSync(htmlPath, "utf-8");

// ─── Structured Results Panel ────────────────────────────────────

describe("Structured Test Results Panel", () => {
  it("has the structured results panel element with correct id", () => {
    expect(html).toContain('id="testingResultsPanel"');
  });

  it("panel is hidden by default (display:none)", () => {
    expect(html).toMatch(/id="testingResultsPanel"[^>]*style="display:none"/);
  });

  it("has the summary bar element", () => {
    expect(html).toContain('id="testingSummaryBar"');
    expect(html).toContain("testing-summary-bar");
  });

  it("has the suite accordion element", () => {
    expect(html).toContain('id="testingSuiteAccordion"');
    expect(html).toContain("testing-suite-accordion");
  });

  it("defines renderStructuredResults function", () => {
    expect(html).toContain("function renderStructuredResults(result)");
  });

  it("defines renderTestSummaryBar function", () => {
    expect(html).toContain("function renderTestSummaryBar(result)");
  });

  it("defines renderSuiteAccordion function", () => {
    expect(html).toContain("function renderSuiteAccordion(result)");
  });
});

// ─── Suite Accordion ─────────────────────────────────────────────

describe("Suite Accordion", () => {
  it("has CSS for suite rows", () => {
    expect(html).toContain(".testing-suite-row");
    expect(html).toContain(".testing-suite-header");
  });

  it("has toggle function for suite bodies", () => {
    expect(html).toContain("function toggleSuiteBody(idx)");
  });

  it("defines renderSuiteRow function", () => {
    expect(html).toContain("function renderSuiteRow(suite, idx, baseline)");
  });

  it("suite body is hidden by default and shown when expanded", () => {
    expect(html).toContain(".testing-suite-body {");
    expect(html).toContain("display: none;");
    expect(html).toContain(".testing-suite-body.expanded { display: block; }");
  });

  it("chevron rotates when expanded", () => {
    expect(html).toContain(".testing-suite-chevron.expanded");
    expect(html).toContain("rotate(90deg)");
  });

  it("renderSuiteRow expands failed suites by default", () => {
    // The const expanded = hasFailed ? 'expanded' : '' pattern
    expect(html).toMatch(/const hasFailed = failed > 0/);
    expect(html).toMatch(/const expanded = hasFailed \? 'expanded' : ''/);
  });
});

// ─── Failure Detail Cards ────────────────────────────────────────

describe("Failure Detail Cards", () => {
  it("defines renderFailureCard function", () => {
    expect(html).toContain("function renderFailureCard(failure, baseline)");
  });

  it("has CSS for failure cards", () => {
    expect(html).toContain(".testing-failure-card");
    expect(html).toContain(".testing-failure-header");
    expect(html).toContain(".testing-failure-name");
    expect(html).toContain(".testing-failure-message");
  });

  it("renders stack trace in a collapsible details element", () => {
    expect(html).toContain(".testing-failure-stack");
    expect(html).toMatch(/testing-failure-stack.*summary/s);
    expect(html).toContain("Stack trace");
  });

  it("escapes failure content with esc() function", () => {
    // failure name, message, and stack should all be escaped
    expect(html).toMatch(/\$\{esc\(testName\)\}/);
    expect(html).toMatch(/\$\{esc\(message\)\}/);
    expect(html).toMatch(/\$\{esc\(stack\)\}/);
  });
});

// ─── Baseline Badges ─────────────────────────────────────────────

describe("Baseline Badges", () => {
  it("has CSS for all three badge variants", () => {
    expect(html).toContain(".testing-baseline-badge.new");
    expect(html).toContain(".testing-baseline-badge.preexisting");
    expect(html).toContain(".testing-baseline-badge.fixed");
  });

  it("uses failureListContains for baseline comparison (not .includes)", () => {
    // Must NOT use .includes() on TestFailure[] arrays
    expect(html).toContain("function failureListContains(list, testName)");
    expect(html).toContain("failureListContains(baseline.newFailures, testName)");
    expect(html).toContain("failureListContains(baseline.preExisting, testName)");
  });

  it("failureListContains uses .some() to check object properties", () => {
    // Should use .some(f => f.testName === testName || f.fullName === testName)
    expect(html).toMatch(/list\.some\(f =>/);
  });

  it("defines failureName helper to extract name from TestFailure objects", () => {
    expect(html).toContain("function failureName(f)");
    // Should handle string fallback
    expect(html).toMatch(/typeof f === 'string'/);
    // Should access object properties
    expect(html).toMatch(/f\.testName \|\| f\.fullName/);
  });

  it("new failures are expanded by default via baselineBadge check", () => {
    expect(html).toMatch(/const isNew = baselineBadge\.includes\('new'\)/);
    expect(html).toMatch(/const cardOpen = isNew \? 'open' : ''/);
  });
});

// ─── Newly Fixed Section ─────────────────────────────────────────

describe("Newly Fixed Section", () => {
  it("defines renderNewlyFixedSection function", () => {
    expect(html).toContain("function renderNewlyFixedSection(newlyFixed)");
  });

  it("has encouraging green CSS styling", () => {
    expect(html).toContain(".testing-newly-fixed-section");
    expect(html).toContain(".testing-newly-fixed-title");
    // Green color
    expect(html).toMatch(/testing-newly-fixed-title[\s\S]*?color: var\(--green\)/);
  });

  it("uses failureName() to extract test names (not raw object stringification)", () => {
    // Must use failureName(test) not esc(test)
    expect(html).toMatch(/\$\{esc\(failureName\(test\)\)\}/);
  });

  it("renders newly fixed section when baseline has newlyFixed entries", () => {
    expect(html).toMatch(
      /result\.baseline && result\.baseline\.newlyFixed && result\.baseline\.newlyFixed\.length > 0/,
    );
    expect(html).toContain("renderNewlyFixedSection(result.baseline.newlyFixed)");
  });
});

// ─── View Toggle ─────────────────────────────────────────────────

describe("View Toggle (Structured / Raw Output)", () => {
  it("has toggle buttons", () => {
    expect(html).toContain("testing-view-toggle");
    expect(html).toContain("testing-view-btn");
  });

  it("Structured button is active by default in the panel", () => {
    expect(html).toMatch(/testing-view-btn active.*Structured/);
  });

  it("Raw Output button is available", () => {
    expect(html).toContain(">Raw Output<");
  });

  it("defines switchTestingView function", () => {
    expect(html).toContain("function switchTestingView(view)");
  });

  it("prevents switching to structured when no data available", () => {
    // Guard: if no currentTestResults, don't switch to structured
    expect(html).toMatch(/view === 'structured' && !currentTestResults/);
  });

  it("has raw view container in structured panel", () => {
    expect(html).toContain('id="testingRawView"');
    expect(html).toContain('id="testingConsoleStructured"');
  });
});

// ─── Raw Output Fallback ─────────────────────────────────────────

describe("Raw Output Fallback", () => {
  it("has fallback console panel with correct id", () => {
    expect(html).toContain('id="testingConsolePanel"');
    expect(html).toContain('id="testingConsole"');
  });

  it("appendTestingOutput function still writes to testingConsole", () => {
    expect(html).toContain("function appendTestingOutput(text)");
    expect(html).toContain("getElementById('testingConsole')");
  });

  it("appendTestingOutput mirrors to structured raw view", () => {
    expect(html).toContain("getElementById('testingConsoleStructured')");
  });

  it("clear output resets structured panel state", () => {
    expect(html).toContain("function testingClearOutput()");
    // Should reset currentTestResults and restore console panel
    expect(html).toMatch(/currentTestResults = null/);
    expect(html).toMatch(/testingResultsPanel.*display.*none/);
    expect(html).toMatch(/testingConsolePanel.*display.*block/);
  });
});

// ─── SSE Event Integration ───────────────────────────────────────

describe("SSE Event Handling", () => {
  it("handleTestingEvent handles test_run_complete", () => {
    expect(html).toContain("event.stage === 'test_run_complete'");
    expect(html).toContain("updateStructuredResults(event.payload)");
  });

  it("handleTestingEvent handles test_result_summary", () => {
    expect(html).toContain("event.stage === 'test_result_summary'");
    expect(html).toContain("updateTestResultSummary(event.payload)");
  });

  it("handleTestingEvent handles test_dashboard_update", () => {
    expect(html).toContain("event.stage === 'test_dashboard_update'");
    expect(html).toContain("fetchTestingDashboard()");
  });

  it("handleEvent routes test events to handleTestingEvent", () => {
    expect(html).toMatch(
      /event\.stage === 'test_run_complete' \|\| event\.stage === 'test_result_summary' \|\| event\.stage === 'test_dashboard_update'/,
    );
  });

  it("updateStructuredResults fetches full results when taskId present", () => {
    expect(html).toContain("function updateStructuredResults(payload)");
    expect(html).toContain("fetchTestResults(payload.taskId)");
  });
});

// ─── Dispatch Test Results Dashboard ─────────────────────────────

describe("Dispatch Test Results Dashboard", () => {
  it("has the dashboard panel element", () => {
    expect(html).toContain('id="testingDashboardPanel"');
    expect(html).toContain('id="testingDashboardBody"');
  });

  it("defines fetchTestingDashboard function", () => {
    expect(html).toContain("function fetchTestingDashboard()");
  });

  it("fetches from /api/testing/dashboard endpoint", () => {
    expect(html).toContain("/api/testing/dashboard");
  });

  it("handles 404 gracefully when endpoint not available", () => {
    expect(html).toMatch(/res\.status === 404/);
    expect(html).toContain("Dispatch results will appear here");
    expect(html).toContain("TASK-084");
  });

  it("defines renderTestingDashboard function", () => {
    expect(html).toContain("function renderTestingDashboard(data)");
  });

  it("renders per-task rows from taskResults", () => {
    expect(html).toContain("data.taskResults");
    expect(html).toContain("testing-dashboard-table");
  });

  it("task rows show pass/fail counts and baseline classification", () => {
    expect(html).toMatch(/tr\.totalTests/);
    expect(html).toMatch(/tr\.passed/);
    expect(html).toMatch(/tr\.failed/);
    expect(html).toMatch(/tr\.newFailures/);
    expect(html).toMatch(/tr\.preExisting/);
    expect(html).toMatch(/tr\.newlyFixed/);
  });

  it("fetchTestingDashboard is called on testing tab activation", () => {
    // In switchTab and in reconnection
    const matches = html.match(/fetchTestingDashboard\(\)/g);
    expect(matches).not.toBeNull();
    expect(matches!.length).toBeGreaterThanOrEqual(2);
  });

  it("extracts commandHealth data for pass rate", () => {
    expect(html).toContain("data.commandHealth");
    expect(html).toContain("testingCommandHealthData");
  });
});

// ─── Task Detail Drill-Down ──────────────────────────────────────

describe("Task Detail Drill-Down", () => {
  it("task rows are clickable via toggleDashboardTaskDetail", () => {
    expect(html).toContain("function toggleDashboardTaskDetail(taskId)");
    expect(html).toContain("toggleDashboardTaskDetail(");
  });

  it("clicking fetches detailed results from /api/tasks/:id/test-results", () => {
    expect(html).toContain("function fetchTestResults(taskId)");
    expect(html).toMatch(/\/api\/tasks\/.*\/test-results/);
  });

  it("shows loading state while fetching", () => {
    expect(html).toContain("testing-task-detail-loading");
    expect(html).toContain("Loading test details");
  });

  it("renders inline detail panel with summary and failures", () => {
    expect(html).toContain("function renderDashboardTaskDetail(container, taskId, result)");
    expect(html).toContain("testing-task-detail-panel");
  });

  it("has Open in Structured View button", () => {
    expect(html).toContain("function showDetailInStructuredPanel(taskId)");
    expect(html).toContain("Open in Structured View");
  });

  it("toggles off when same task is clicked again", () => {
    expect(html).toMatch(/expandedDashboardTaskId === taskId/);
  });
});

// ─── Verification Commands Table ─────────────────────────────────

describe("Verification Commands Table", () => {
  it("shows color-coded status badges", () => {
    expect(html).toContain("✓ PASS");
    expect(html).toContain("✗ FAIL");
    expect(html).toContain("testing-cmd-status");
  });

  it("has Pass Rate column header", () => {
    expect(html).toContain("<th>Pass Rate</th>");
  });

  it("renders pass rate from commandHealth data", () => {
    expect(html).toContain("testing-pass-rate");
    expect(html).toContain("testingCommandHealthData[cmd.name]");
    expect(html).toMatch(/health\.passRate/);
  });

  it("has CSS for pass rate badge variants", () => {
    expect(html).toContain(".testing-pass-rate.high");
    expect(html).toContain(".testing-pass-rate.medium");
    expect(html).toContain(".testing-pass-rate.low");
    expect(html).toContain(".testing-pass-rate.none");
  });

  it("shows dash when no health data available", () => {
    // Default: <span class="testing-pass-rate none">-</span>
    expect(html).toMatch(/testing-pass-rate none.*-/);
  });
});

// ─── No Regression ───────────────────────────────────────────────

describe("No Regression: existing testing functionality preserved", () => {
  it("testingRun function still exists", () => {
    expect(html).toContain("function testingRun(name)");
    expect(html).toContain("/api/testing/run");
  });

  it("testingStop function still exists", () => {
    expect(html).toContain("function testingStop()");
  });

  it("Quick Actions panel still has run buttons", () => {
    expect(html).toContain("testingRun('test')");
    expect(html).toContain("testingRun('lint')");
    expect(html).toContain("testingRun('build')");
  });

  it("testingRunning flag preserved", () => {
    expect(html).toContain("testingRunning");
  });

  it("loadTestingHistory still called on tab switch", () => {
    expect(html).toContain("loadTestingHistory()");
  });

  it("loadTestingCommands still called on tab switch", () => {
    expect(html).toContain("loadTestingCommands()");
  });
});
