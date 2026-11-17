import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { AdminPage, FAKE_CODE_URL, ROUTES } from "./pages/index.js";

// Cost and time (Feature A, slice A3) through Cloud on the pretend Code: Cloud reads Code's one-row-per-task report as the signed-in company owner, groups it and sends whole cents; the page
// draws it. The pretend Code serves the rows each test sets (POST /__fake/report); with none set it answers 404 and the page says "not connected yet".
const DAY = 86_400_000;
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
function task(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: `task_${String(n).padStart(4, "0")}`, project: "web", title: `Task ${String(n)}`, origin: "web", path: "full", state: "merged", startedAt: iso(NOW - 6 * DAY), firstPrAt: iso(NOW - 5 * DAY), endedAt: iso(NOW - 4 * DAY),
    prsOpened: 1, prsMerged: 1, prLinks: [`https://github.com/acme/web/pull/${String(n)}`], costMicros: 12_000_000, currency: "USD", unpricedCalls: 0, ...over,
  };
}
async function setReport(page: Page, tasks: unknown[], features: unknown[]): Promise<void> {
  const answer = await page.request.post(`${FAKE_CODE_URL}/__fake/report`, { data: { tasks, features } });
  expect(answer.status()).toBe(200);
}
test.afterEach(async ({ page }) => { await page.request.post(`${FAKE_CODE_URL}/__fake/report`, { data: { reset: true } }); });

// Every range is "this month" by default; keep the tasks inside it whatever the day (the report counts a task in the range it started in).
const thisMonth = () => { const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0); return start.getTime(); };
const inMonth = (hoursIn: number) => iso(thisMonth() + hoursIn * 3_600_000);
const NORMAL_TASKS = [
  task(1, { feature: { id: "f_checkout", source: "tracker" }, startedAt: inMonth(1), firstPrAt: inMonth(25), endedAt: inMonth(49), costMicros: 212_340_000 }),
  task(2, { feature: { id: "f_checkout", source: "chosen" }, startedAt: inMonth(2), state: "open", endedAt: undefined, firstPrAt: undefined, prsOpened: 0, prsMerged: 0, costMicros: 3_330_000, unpricedCalls: 3, project: "api", origin: "slack" }),
  task(3, { feature: { id: "f_search", source: "inherited" }, startedAt: inMonth(3), firstPrAt: inMonth(5), endedAt: inMonth(9), costMicros: 55_550_000 }),
  task(4, { startedAt: inMonth(4), state: "closed", prsOpened: 0, prsMerged: 0, firstPrAt: undefined, endedAt: inMonth(6), costMicros: 11_110_000, origin: "linear", path: "quick" }),
];
const FEATURES = [{ id: "f_checkout", name: "Checkout v2", state: "open" }, { id: "f_search", name: "Search", state: "done" }];

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(context: string, options: unknown): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run("main", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
  });
}
const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });

test("Cost and time says it is not connected yet while Code has no report, and the nav has the link", async ({ page }) => {
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costReport);
  await expect(admin.heading("Cost and time")).toBeVisible();
  await admin.expectNotConnected("The cost report");
  await expect(admin.link("Cost and time")).toHaveAttribute("aria-current", "page");
});

test("Cost and time draws the four numbers, by feature with No feature last, by project, and a feature's page", async ({ page }, info) => {
  await setReport(page, NORMAL_TASKS, FEATURES);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costReport);
  const stats = admin.stats("Cost and time in this range");
  // 212.34 + 3.33 + 55.55 + 11.11 = 282.33, and the 3 calls Code could not price make it a floor.
  await expect(stats).toContainText("$282.33 or more");
  await expect(stats).toContainText("3 calls not priced");
  await expect(stats).toContainText("of 2 opened"); // merged pull requests: 2 of the 2 opened
  const table = admin.table("Cost and time by feature");
  await expect(table.getByRole("row")).toHaveCount(4);
  await expect(table.getByRole("row").nth(1)).toContainText("Checkout v2");
  await expect(table.getByRole("row").nth(1)).toContainText("$215.67 or more");
  await expect(table.getByRole("row").nth(3)).toContainText("No feature");
  await expect(table).not.toContainText(/Waiting on people|Send-backs/u);
  await shot(page, info, "normal-feature-light");
  await page.getByRole("tab", { name: "By project" }).click();
  await expect(admin.table("Cost and time by project").getByRole("row").nth(1)).toContainText("web");
  await page.getByRole("tab", { name: "By feature" }).click();
  await page.getByRole("link", { name: "Checkout v2" }).click();
  await expect(admin.heading("Checkout v2")).toBeVisible();
  await expect(page.getByText("How tasks got here: 1 chosen by a person, 1 from the tracker.")).toBeVisible();
  const tasks = admin.table("Tasks in this feature");
  await expect(tasks.getByRole("row")).toHaveCount(3);
  await expect(tasks).toContainText("Task 1");
  await expect(tasks.getByRole("link", { name: "1 merged of 1" })).toHaveAttribute("href", "https://github.com/acme/web/pull/1");
  await shot(page, info, "feature-light");
  await page.getByRole("link", { name: "Back to Cost and time" }).click();
  await expect(admin.heading("Cost and time")).toBeVisible();
});

test("a filter narrows the report and the CSV is what it shows", async ({ page }) => {
  await setReport(page, NORMAL_TASKS, FEATURES);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costReport);
  await page.getByLabel("Where it started").selectOption("slack");
  await expect(admin.stats("Cost and time in this range")).toContainText("$3.33 or more");
  await expect(admin.table("Cost and time by feature").getByRole("row")).toHaveCount(2);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toBe("cost-and-time-by-feature.csv");
  const csv = readFileSync((await download.path()), "utf8");
  expect(csv.split("\r\n")[0]).toContain("Feature,Tasks");
  expect(csv).toContain("Checkout v2,1,0,0,3.33,yes,3");
  expect(csv).not.toContain("Search");
});

test("a task titled like a formula is exported with an apostrophe in front", async ({ page }) => {
  await setReport(page, [task(1, { feature: { id: "f_bad", source: "chosen" }, startedAt: inMonth(1) })], [{ id: "f_bad", name: "=HYPERLINK(\"http://evil.example\",\"x\")", state: "open" }]);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costReport);
  await expect(admin.table("Cost and time by feature")).toContainText("=HYPERLINK(");
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  expect(readFileSync((await download.path()), "utf8")).toContain("\"'=HYPERLINK(");
});

test("an empty range says so", async ({ page }, info) => {
  await setReport(page, [], []);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costReport);
  await expect(page.getByTestId("report-empty")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await shot(page, info, "empty-light");
});

test("many features are paged 25 a page, and a made-up feature is not found", async ({ page }, info) => {
  const tasks = Array.from({ length: 60 }, (_, n) => task(n + 1, { feature: { id: `f_${String(n)}`, source: "chosen" }, startedAt: inMonth(1 + n), costMicros: (100 - n) * 1_000_000 }));
  const features = Array.from({ length: 60 }, (_, n) => ({ id: `f_${String(n)}`, name: `Feature ${String(n).padStart(2, "0")}`, state: n % 3 === 0 ? "done" : "open" }));
  await setReport(page, tasks, features);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costReport);
  await expect(admin.table("Cost and time by feature").getByRole("row")).toHaveCount(26);
  await expect(page.getByText("Showing 1 to 25 of 60")).toBeVisible();
  await shot(page, info, "many-light");
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("Showing 26 to 50 of 60")).toBeVisible();
  await page.goto(ROUTES.admin.costFeature("f_nothing"));
  await expect(admin.heading("Feature not found")).toBeVisible();
});

for (const scheme of ["light", "dark"] as const) {
  test(`Cost and time and a feature's page have no accessibility violations in ${scheme}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await setReport(page, NORMAL_TASKS, FEATURES);
    const admin = new AdminPage(page);
    await admin.open(ROUTES.admin.costReport);
    await expect(admin.table("Cost and time by feature")).toBeVisible();
    expect(await violations(page)).toEqual([]);
    if (scheme === "dark") await shot(page, info, "normal-feature-dark");
    await page.goto(ROUTES.admin.costFeature("f_checkout"));
    await expect(admin.table("Tasks in this feature")).toBeVisible();
    expect(await violations(page)).toEqual([]);
    if (scheme === "dark") await shot(page, info, "feature-dark");
  });
}

test("at the narrowest admin width the page does not scroll sideways, and on a phone the whole admin area asks for a larger screen", async ({ page }, info) => {
  await setReport(page, NORMAL_TASKS, FEATURES);
  const admin = new AdminPage(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto(ROUTES.admin.costReport);
  await expect(admin.heading("Cost and time")).toBeVisible();
  await expect(admin.table("Cost and time by feature")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await shot(page, info, "narrow-1024-light");
  await page.emulateMedia({ colorScheme: "dark" });
  await shot(page, info, "narrow-1024-dark");
  // Every admin page is for a larger screen (AdminLayout): at phone width Cost and time is not drawn and no amount is read.
  await page.emulateMedia({ colorScheme: "light" });
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(ROUTES.admin.costReport);
  await expect(page.getByTestId("admin-narrow")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await shot(page, info, "phone-light");
});
