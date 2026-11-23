import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { AdminPage, FAKE_CODE_URL, ROUTES } from "./pages/index.js";

// Cost and time (Feature A, slice A3) through Cloud on the pretend Code: Cloud reads Code's one-row-per-task report as the signed-in company owner, groups it and sends whole cents; the page
// draws it. The pretend Code serves the rows each test sets (POST /__fake/report); with none set it answers 404 and the page says "not connected yet".
const DAY = 86_400_000;
/** Code's feature ids: `ft_` and 20 hex characters. */
const FT = (letter: string) => `ft_${letter.repeat(20)}`;
const F_CHECKOUT = FT("a"), F_SEARCH = FT("b"), F_BAD = FT("c");
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
function task(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, project: "web", title: `Task ${String(n)}`, origin: "web", path: "full", state: "merged", startedAt: iso(NOW - 6 * DAY), firstPrAt: iso(NOW - 5 * DAY), endedAt: iso(NOW - 4 * DAY),
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
  task(1, { feature: { id: F_CHECKOUT, source: "tracker" }, startedAt: inMonth(1), firstPrAt: inMonth(25), endedAt: inMonth(49), costMicros: 212_340_000 }),
  task(2, { feature: { id: F_CHECKOUT, source: "chosen" }, startedAt: inMonth(2), state: "open", endedAt: undefined, firstPrAt: undefined, prsOpened: 0, prsMerged: 0, costMicros: 3_330_000, unpricedCalls: 3, project: "api", origin: "slack" }),
  task(3, { feature: { id: F_SEARCH, source: "inherited" }, startedAt: inMonth(3), firstPrAt: inMonth(5), endedAt: inMonth(9), costMicros: 55_550_000 }),
  task(4, { startedAt: inMonth(4), state: "closed", prsOpened: 0, prsMerged: 0, firstPrAt: undefined, endedAt: inMonth(6), costMicros: 11_110_000, origin: "linear", path: "quick" }),
];
const FEATURES = [{ id: F_CHECKOUT, name: "Checkout v2", state: "open" }, { id: F_SEARCH, name: "Search", state: "done" }];

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
  // SELECTOR (WIRING-1B): the rebuilt page is titled "Money" (its Report tab); the nav link is still "Cost and time".
  await expect(admin.heading("Money")).toBeVisible();
  // SELECTOR: Code has no report yet (501): the rebuilt page says so in one quiet held line and draws no number, instead of the old "isn't connected to Rovara Code yet" card.
  await expect(page.getByText("Rovara can't read this here yet.")).toBeVisible();
  await expect(admin.loading).toHaveCount(0);
  await expect(page.getByRole("table")).toHaveCount(0);
  await expect(admin.link("Cost and time")).toHaveAttribute("aria-current", "page");
});

test("Cost and time draws the four numbers, by feature with No feature last, by project, and a feature's page", async ({ page }, info) => {
  await setReport(page, NORMAL_TASKS, FEATURES);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costReport);
  // SELECTOR (WIRING-1B): the rebuilt report draws its totals as the table's last row ("Task work in this report") and the price notes under it, not as four stat tiles.
  // 212.34 + 3.33 + 55.55 + 11.11 = 282.33, and the 3 calls Code could not price make it a floor.
  const table = admin.table("Cost and time by feature");
  await expect(table.getByRole("row").last()).toContainText("$282.33 or more");
  await expect(page.getByText("3 calls have no price yet, so the cost shown is a minimum.")).toBeVisible();
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByRole("row").nth(1)).toContainText("Checkout v2");
  await expect(table.getByRole("row").nth(1)).toContainText("$215.67 or more");
  await expect(table.getByRole("row").nth(3)).toContainText("No feature");
  await expect(table).not.toContainText(/Waiting on people|Send-backs/u);
  await shot(page, info, "normal-feature-light");
  await page.getByRole("tab", { name: "By project" }).click();
  await expect(admin.table("Cost and time by project").getByRole("row").nth(1)).toContainText("web");
  await page.getByRole("tab", { name: "By feature" }).click();
  await page.getByRole("link", { name: "Checkout v2" }).click();
  // SELECTOR (WIRING-1B): the feature page is titled "Manage features" with the feature in a level-2 card heading; "Back" is the Report breadcrumb. The rebuilt page draws the Merged chip for
  // a task's pull request and no "how tasks got here" line (neither is on the approved board), so those two assertions are not carried.
  await expect(admin.heading("Manage features")).toBeVisible();
  await expect(admin.featureHeading("Checkout v2")).toBeVisible();
  const tasks = admin.table("Tasks in this feature");
  await expect(tasks.getByRole("row")).toHaveCount(3);
  await expect(tasks).toContainText("Task 1");
  // The pull-request link and the Back link are restored (WIRING-1).
  await expect(tasks.getByRole("link", { name: "1 merged of 1" }).first()).toHaveAttribute("href", "https://github.com/acme/web/pull/1");
  await shot(page, info, "feature-light");
  await page.getByRole("link", { name: "Back to Cost and time" }).click();
  await expect(admin.heading("Money")).toBeVisible();
});

test("a filter narrows the report and the CSV is what it shows", async ({ page }) => {
  await setReport(page, NORMAL_TASKS, FEATURES);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costReport);
  // SELECTOR (WIRING-1B): the filters sit in one closed "Filter" disclosure; the totals are the table's last row.
  await admin.openFilter();
  await page.getByLabel("Where it started").selectOption("slack");
  await expect(admin.table("Cost and time by feature").getByRole("row").last()).toContainText("$3.33 or more");
  await expect(admin.table("Cost and time by feature").getByRole("row")).toHaveCount(3);
  const [download] = await Promise.all([page.waitForEvent("download"), page.getByRole("button", { name: "Download CSV" }).click()]);
  expect(download.suggestedFilename()).toBe("cost-and-time-by-feature.csv");
  const csv = readFileSync((await download.path()), "utf8");
  expect(csv.split("\r\n")[0]).toContain("Feature,Tasks");
  expect(csv).toContain("Checkout v2,1,0,0,3.33,yes,3");
  expect(csv).not.toContain("Search");
});

test("a task titled like a formula is exported with an apostrophe in front", async ({ page }) => {
  await setReport(page, [task(1, { feature: { id: F_BAD, source: "chosen" }, startedAt: inMonth(1) })], [{ id: F_BAD, name: "=HYPERLINK(\"http://evil.example\",\"x\")", state: "open" }]);
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
  // SELECTOR (WIRING-1B): the empty range is one line on the rebuilt page.
  await expect(page.getByText("No tasks in this range.")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  await shot(page, info, "empty-light");
});

test("many features are paged 25 a page, and a made-up feature is not found", async ({ page }, info) => {
  const tasks = Array.from({ length: 60 }, (_, n) => task(n + 1, { feature: { id: `ft_${n.toString(16).padStart(20, "0")}`, source: "chosen" }, startedAt: inMonth(1 + n), costMicros: (100 - n) * 1_000_000 }));
  const features = Array.from({ length: 60 }, (_, n) => ({ id: `ft_${n.toString(16).padStart(20, "0")}`, name: `Feature ${String(n).padStart(2, "0")}`, state: n % 3 === 0 ? "done" : "open" }));
  await setReport(page, tasks, features);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costReport);
  // Paging is back (WIRING-1 restore): 25 features a page plus the totals row, as on the live page.
  await expect(admin.table("Cost and time by feature").getByRole("row")).toHaveCount(27);
  await expect(page.getByText("Showing 1 to 25 of 60")).toBeVisible();
  await shot(page, info, "many-light");
  await page.getByRole("button", { name: "Next page" }).click();
  await expect(page.getByText("Showing 26 to 50 of 60")).toBeVisible();
  await page.goto(ROUTES.admin.costFeature(FT("f")));
  // SELECTOR: a made-up feature is a 404, which the rebuilt pages draw as the shared "access ended" block.
  await expect(page.getByRole("heading", { name: "Rovara can't show this page to you", level: 3 })).toBeVisible();
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
    await page.goto(ROUTES.admin.costFeature(F_CHECKOUT));
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
  await expect(admin.heading("Money")).toBeVisible();
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
