import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { chromium, type Browser, type Page, type Route } from "playwright";
import { createMonitorServer } from "../../src/monitor/server";

jest.setTimeout(30_000);

function ready(reviewId = "review-a", taskId = "TASK-1001") {
  return {
    reviewId,
    taskId,
    verdict: "VERIFIED",
    docsImpact: "changelog_only",
    createdAt: "2026-09-14T12:00:00Z",
    findings: [{ title: "Minor style issue", severity: "P3", status: "resolved" }],
    wikiArtifacts: [
      {
        pagePath: "docs/changelog/example.md",
        commitSha: "abc1234",
        linkedTaskIds: [taskId],
        action: "changelog_entry",
      },
    ],
    gate: {
      mergeReady: true,
      requiredWikiActions: ["changelog_entry"],
      missingWikiActions: [] as string[],
      issues: [] as Array<{ code: string; message: string; blocking: boolean }>,
    },
  };
}
function blocked(reviewId = "review-b", taskId = "TASK-1002") {
  const bundle = ready(reviewId, taskId);
  bundle.gate.mergeReady = false;
  bundle.gate.missingWikiActions = ["changelog_entry"];
  bundle.gate.issues = [{ code: "missing_docs", message: "Add the changelog", blocking: true }];
  return bundle;
}

type Bundle = Record<string, unknown>;

describe("Reviews dashboard readiness and blockers", () => {
  let root: string;
  let browser: Browser | undefined;
  let page: Page;
  let stop: (() => Promise<void>) | undefined;
  let port: number;

  function write(bundle: Bundle) {
    fs.writeFileSync(
      path.join(root, ".quack/reviews", `${String(bundle.reviewId)}.json`),
      JSON.stringify(bundle),
    );
  }
  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "quack-reviews-browser-"));
    fs.mkdirSync(path.join(root, ".quack/reviews"), { recursive: true });
    fs.writeFileSync(
      path.join(root, ".quack/auth.json"),
      JSON.stringify({ users: [], sessionSecret: "fixture", sessionTtlMs: 86400000 }),
    );
    jest.spyOn(console, "log").mockImplementation(() => undefined);
    jest.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(async () => {
    try {
      await browser?.close();
    } finally {
      browser = undefined;
      try {
        await stop?.();
      } finally {
        stop = undefined;
        jest.restoreAllMocks();
        fs.rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
      }
    }
  });
  async function boot(...bundles: Bundle[]) {
    bundles.forEach(write);
    const uiBuildDir = path.resolve(__dirname, "../../frontend/dist");
    if (!fs.existsSync(path.join(uiBuildDir, "index.html")))
      throw new Error("Build frontend first");
    const monitor = createMonitorServer({
      projectRoot: root,
      quackRoot: root,
      taskDir: "docs/tasks",
      logDir: path.join(root, ".quack/logs"),
      host: "127.0.0.1",
      port: 0,
      uiBuildDir,
    });
    const started = await monitor.start();
    stop = started.stop;
    port = started.port;
    browser = await chromium.launch({ headless: true });
    page = await browser.newPage();
    page.setDefaultTimeout(5000);
  }
  async function open() {
    await page.goto(`http://127.0.0.1:${port}/reviews`);
  }
  function panel() {
    return page.getByRole("region", { name: "Review Detail", exact: true });
  }
  function button(id: string) {
    return page.getByRole("button", { name: `Select review ${id}`, exact: true });
  }
  async function summary(value: string, timeout = 5000) {
    await panel()
      .locator("p")
      .filter({ hasText: `Summary: ${value}` })
      .first()
      .waitFor({ timeout });
  }
  async function noReady() {
    expect(await panel().getByText("Ready for operator review", { exact: true }).count()).toBe(0);
  }
  async function detailResponse(value: unknown) {
    await page.route("**/v1/reviews/review-a*", (route) => route.fulfill({ json: value }));
  }
  async function renderDetail(bundle: Bundle) {
    await boot(ready());
    await detailResponse({ ok: true, reviewId: "review-a", review: bundle });
    await open();
  }
  async function holdDetail(id: string) {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => {
      release = resolve;
    });
    await page.route(`**/v1/reviews/${id}*`, async (route: Route) => {
      await pending;
      await route.continue();
    });
    return release;
  }

  test("shows well-formed ready bundle identity and subsections", async () => {
    await boot(ready());
    await open();
    await summary("Ready for operator review");
    await panel().getByRole("heading", { name: "TASK-1001 / review-a" }).waitFor();
    for (const name of [
      "Code verification",
      "Documentation gate",
      "Blocking issues",
      "Other issues",
      "Findings",
      "Documentation actions",
      "Artifacts",
    ]) {
      await panel().getByRole("heading", { name, exact: true }).waitFor();
    }
    expect(await panel().innerText()).toContain("P3 � Minor style issue (resolved)");
    expect(await panel().innerText()).toContain("Missing: None missing");
    await panel().getByText("docs/changelog/example.md", { exact: true }).waitFor();
    await panel().getByText("abc1234", { exact: true }).waitFor();
    expect(await panel().locator("details").getAttribute("open")).toBeNull();
    expect(await panel().locator("a").count()).toBe(0);
    await page.getByRole("columnheader", { name: "Documentation gate", exact: true }).waitFor();
    expect(await page.getByRole("columnheader", { name: "Merge ready" }).count()).toBe(0);
  });

  test.each(["FAILED", "PARTIAL"])("%s with ready docs stays not-ready", async (verdict) => {
    await renderDetail({ ...ready(), verdict });
    await summary("Not ready");
    await noReady();
    await panel().getByText(verdict, { exact: true }).waitFor();
    await panel().getByText("Ready", { exact: true }).waitFor();
  });
  test("docs-blocked review shows blocking, other issues, findings and missing actions", async () => {
    const bundle = blocked("review-a");
    bundle.gate.issues.push({ code: "advice", message: "Optional follow-up", blocking: false });
    await renderDetail(bundle);
    await summary("Not ready");
    await noReady();
    const text = await panel().innerText();
    expect(text).toContain("missing_docs: Add the changelog");
    expect(text).toContain("[nonblocking] advice: Optional follow-up");
    expect(text).toContain("Missing: changelog_entry");
  });
  test("a false gate with no issues remains negative", async () => {
    const bundle = ready();
    bundle.gate.mergeReady = false;
    await renderDetail(bundle);
    await summary("Not ready");
    await noReady();
  });
  test.each([undefined, "true", 1, null])(
    "invalid mergeReady %s stays unknown",
    async (mergeReady) => {
      const bundle = ready();
      await renderDetail({ ...bundle, gate: { ...bundle.gate, mergeReady } });
      await summary("Unknown");
      await noReady();
    },
  );
  const malformed: Array<[string, (bundle: ReturnType<typeof ready>) => Bundle]> = [
    ["null issue", (b) => ({ ...b, gate: { ...b.gate, issues: [null] } })],
    [
      "partial issue",
      (b) => ({
        ...b,
        gate: { ...b.gate, issues: [{ message: "Keep this message", blocking: false }] },
      }),
    ],
    [
      "nonboolean blocking",
      (b) => ({
        ...b,
        gate: {
          ...b.gate,
          issues: [{ code: "x", message: "Keep this message", blocking: "false" }],
        },
      }),
    ],
    ["missing gate arrays", (b) => ({ ...b, gate: { mergeReady: true } })],
    [
      "mixed actions",
      (b) => ({ ...b, gate: { ...b.gate, requiredWikiActions: ["Keep this action", 7] } }),
    ],
    ["wrong findings shape", (b) => ({ ...b, findings: "bad" })],
    ["null findings", (b) => ({ ...b, findings: null })],
    ["null finding", (b) => ({ ...b, findings: [null] })],
    [
      "unknown severity",
      (b) => ({ ...b, findings: [{ title: "Keep this finding", severity: "P9" }] }),
    ],
    [
      "null status",
      (b) => ({ ...b, findings: [{ title: "Keep this finding", severity: "P3", status: null }] }),
    ],
    [
      "unknown status",
      (b) => ({
        ...b,
        findings: [{ title: "Keep this finding", severity: "P3", status: "closed" }],
      }),
    ],
    ["null artifacts", (b) => ({ ...b, wikiArtifacts: null })],
    [
      "mixed linked IDs",
      (b) => ({
        ...b,
        wikiArtifacts: [{ ...b.wikiArtifacts[0], linkedTaskIds: ["TASK-1001", 7] }],
      }),
    ],
    [
      "partial artifact",
      (b) => ({
        ...b,
        wikiArtifacts: [{ pagePath: "docs/changelog/example.md", linkedTaskIds: [] }],
      }),
    ],
    [
      "blocking contradiction",
      (b) => ({
        ...b,
        gate: { ...b.gate, issues: [{ code: "blocked", message: "Blocked", blocking: true }] },
      }),
    ],
    [
      "missing action contradiction",
      (b) => ({ ...b, gate: { ...b.gate, missingWikiActions: ["changelog_entry"] } }),
    ],
    [
      "omitted P1 status means open",
      (b) => ({ ...b, findings: [{ title: "Open blocker", severity: "P1" }] }),
    ],
  ];
  test.each(malformed)("%s suppresses Ready and retains usable text", async (_name, mutate) => {
    const bundle = mutate(ready());
    await renderDetail(bundle);
    await summary("Incomplete evidence");
    await noReady();
    if (JSON.stringify(bundle).includes("Keep this"))
      expect(await panel().innerText()).toContain("Keep this");
    if (JSON.stringify(bundle).includes("docs/changelog/example.md")) {
      await panel().getByText("docs/changelog/example.md", { exact: true }).waitFor();
    }
  });
  test("omitted optional arrays and empty artifact links are valid", async () => {
    const bundle: Bundle = ready();
    delete bundle.findings;
    delete bundle.wikiArtifacts;
    await renderDetail(bundle);
    await summary("Ready for operator review");
    expect(await panel().innerText()).toContain("None recorded");
  });
  test("empty artifact links and omitted non-P1 status are valid", async () => {
    const bundle = ready();
    bundle.wikiArtifacts[0].linkedTaskIds = [];
    await renderDetail({ ...bundle, findings: [{ title: "Open note", severity: "P2" }] });
    await summary("Ready for operator review");
    expect(await panel().innerText()).toContain("Open note (open)");
  });
  test.each([
    null,
    { ok: false },
    { ok: true, reviewId: "wrong", review: ready() },
    { ok: true, reviewId: "review-a", review: { ...ready(), reviewId: "wrong" } },
    { ok: true, reviewId: "review-a", review: [] },
  ])("invalid envelope shows error: %j", async (response) => {
    await boot(ready());
    await detailResponse(response);
    await open();
    await panel().getByRole("alert").waitFor();
    await noReady();
  });

  test("keyboard selection uses Tab, Enter, Space, pressed state and visible focus", async () => {
    await boot(ready(), blocked());
    await open();
    await button("review-a").waitFor();
    let focused = false;
    for (let i = 0; i < 40; i++) {
      await page.keyboard.press("Tab");
      focused = await button("review-b").evaluate("el => el === document.activeElement");
      if (focused) break;
    }
    expect(focused).toBe(true);
    expect(await button("review-b").evaluate("el => getComputedStyle(el).outlineStyle")).not.toBe(
      "none",
    );
    await page.keyboard.press("Space");
    await summary("Not ready");
    expect(await button("review-b").getAttribute("aria-pressed")).toBe("true");
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Enter");
    await summary("Ready for operator review");
    expect(await button("review-a").getAttribute("aria-pressed")).toBe("true");
    expect(await button("review-b").getAttribute("aria-pressed")).toBe("false");
  });
  test("raw JSON is closed by default, keyboard operated, and markup is inert", async () => {
    const markup = '<img src=x onerror="window.injected=true">';
    await boot({ ...ready(), summary: markup });
    await open();
    await summary("Ready for operator review");
    const details = panel().locator("details");
    expect(await details.getAttribute("open")).toBeNull();
    expect(await panel().locator("img").count()).toBe(0);
    expect(await panel().innerText()).toContain(markup);
    await button("review-a").focus();
    await page.keyboard.press("Tab");
    expect(await details.locator("summary").evaluate("el => el === document.activeElement")).toBe(
      true,
    );
    await page.keyboard.press("Enter");
    await details.locator("pre").waitFor();
    expect(await details.locator("pre").innerText()).toContain("review-a");
    expect(await details.locator("pre").innerText()).toContain("onerror");
    expect(await page.evaluate("window.injected")).toBeUndefined();
    await page.keyboard.press("Space");
    expect(await details.getAttribute("open")).toBeNull();
  });
  test("initial loading hides readiness and failed detail displays an alert", async () => {
    await boot(ready());
    const release = await holdDetail("review-a");
    await open();
    await panel().getByRole("status").waitFor();
    await noReady();
    release();
    await summary("Ready for operator review");
  });
  test("failed detail fetch shows error", async () => {
    await boot(ready());
    await page.route("**/v1/reviews/review-a*", (route) =>
      route.fulfill({ status: 500, body: "failed" }),
    );
    await open();
    await panel().getByRole("alert").waitFor();
    await noReady();
  });
  test("delayed A-to-B hides A readiness", async () => {
    await boot(ready(), blocked());
    await open();
    await button("review-a").click();
    await summary("Ready for operator review");
    const release = await holdDetail("review-b");
    await button("review-b").click();
    await panel().getByRole("status").waitFor();
    await noReady();
    release();
    await summary("Not ready");
  });
  test("A-to-B-to-A within five seconds refetches changed A without cached Ready", async () => {
    await boot(ready(), blocked());
    let requests = 0;
    page.on("request", (req) => {
      if (new URL(req.url()).pathname === "/v1/reviews/review-a") requests++;
    });
    await open();
    await button("review-a").click();
    await summary("Ready for operator review");
    const start = Date.now();
    const initial = requests;
    await button("review-b").click();
    await summary("Not ready");
    write(blocked("review-a", "TASK-1001"));
    const release = await holdDetail("review-a");
    await button("review-a").click();
    await panel().getByRole("status").waitFor();
    await noReady();
    expect(Date.now() - start).toBeLessThan(5000);
    // Receipt of the held request proves a new fetch rather than reuse of cached detail.
    await page.waitForFunction("document.querySelector('[role=\"status\"]') !== null");
    expect(requests).toBeGreaterThan(initial);
    release();
    await summary("Not ready");
    await noReady();
  });
  test("own detail poll updates while list responses stay byte-identical", async () => {
    await boot(ready());
    let listBody: string | undefined;
    let polls = 0;
    await page.route(/\/v1\/reviews(?:\?.*)?$/, async (route) => {
      polls++;
      if (listBody === undefined) listBody = await (await route.fetch()).text();
      await route.fulfill({ contentType: "application/json", body: listBody });
    });
    await open();
    await summary("Ready for operator review");
    write(blocked("review-a", "TASK-1001"));
    await summary("Not ready", 15000);
    await noReady();
    expect(polls).toBeGreaterThan(1);
    expect(await page.locator("tbody tr").innerText()).toContain("Ready");
  });
  test("success-to-refresh-error suppresses cached readiness", async () => {
    await boot(ready());
    await open();
    await summary("Ready for operator review");
    await page.route("**/v1/reviews/review-a*", (route) =>
      route.fulfill({ status: 500, body: "failed" }),
    );
    await panel().getByRole("alert").waitFor({ timeout: 15000 });
    await noReady();
  });
  test("successful list removal selects remaining review, then empty clears selection", async () => {
    await boot(ready(), blocked());
    await open();
    await button("review-a").click();
    await summary("Ready for operator review");
    fs.rmSync(path.join(root, ".quack/reviews/review-a.json"));
    await summary("Not ready", 15000);
    expect(await button("review-b").getAttribute("aria-pressed")).toBe("true");
    fs.rmSync(path.join(root, ".quack/reviews/review-b.json"));
    await page
      .getByText("No review bundles have been recorded yet.", { exact: true })
      .waitFor({ timeout: 15000 });
    await panel()
      .getByText("Select a review bundle to inspect its persisted detail.", { exact: true })
      .waitFor();
    await noReady();
  });
  test("list error retains selected review", async () => {
    await boot(ready(), blocked());
    await open();
    await button("review-b").click();
    await summary("Not ready");
    await page.route(/\/v1\/reviews(?:\?.*)?$/, (route) =>
      route.fulfill({ status: 500, body: "failed" }),
    );
    await page
      .getByText("Failed to load review bundles.", { exact: true })
      .waitFor({ timeout: 15000 });
    await summary("Not ready");
    expect(await button("review-b").getAttribute("aria-pressed")).toBe("true");
  });
});
