import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { AdminPage, FAKE_CODE_URL, ROUTES } from "./pages/index.js";

// Cost and time actions (lane L4-CR4) through Cloud on the pretend Code, which follows Code's own rules for the five changes: New feature, Rename, Merge into, Mark done or reopen and Move to feature.
const DAY = 86_400_000;
const FT = (letter: string) => `ft_${letter.repeat(20)}`;
const F_CHECKOUT = FT("a"), F_SEARCH = FT("b"), F_OLD = FT("c");
const NOW = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const thisMonth = () => { const start = new Date(); start.setUTCDate(1); start.setUTCHours(0, 0, 0, 0); return start.getTime(); };
const inMonth = (hoursIn: number) => iso(thisMonth() + hoursIn * 3_600_000);
function task(n: number, over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    taskId: `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`, project: "web", title: `Task ${String(n)}`, origin: "web", path: "full", state: "merged", startedAt: inMonth(1 + n), firstPrAt: inMonth(5 + n), endedAt: inMonth(9 + n),
    prsOpened: 1, prsMerged: 1, prLinks: [`https://github.com/acme/web/pull/${String(n)}`], costMicros: 12_000_000, currency: "USD", unpricedCalls: 0, ...over,
  };
}
const TASKS = () => [
  task(1, { feature: { id: F_CHECKOUT, source: "tracker" } }), task(2, { feature: { id: F_CHECKOUT, source: "chosen" } }), task(3, { feature: { id: F_SEARCH, source: "inherited" } }), task(4, {}), task(5, {}),
];
const FEATURES = () => [{ id: F_CHECKOUT, name: "Checkout v2", state: "open" }, { id: F_SEARCH, name: "Search", state: "open" }, { id: F_OLD, name: "Old work", state: "done" }];
async function setReport(page: Page, tasks: unknown[] = TASKS(), features: unknown[] = FEATURES()): Promise<void> {
  expect((await page.request.post(`${FAKE_CODE_URL}/__fake/report`, { data: { tasks, features } })).status()).toBe(200);
}
test.afterEach(async ({ page }) => { await page.request.post(`${FAKE_CODE_URL}/__fake/report`, { data: { reset: true } }); });
void NOW; void DAY;

const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(context: string, options: unknown): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown; html: string; any: Array<{ message: string }> }> }> }> } }).axe.run("body", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => `${JSON.stringify(node.target)} ${node.html.slice(0, 80)} ${node.any.map((check) => check.message).join(" ")}`))}`);
  });
}
const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
const dialog = (page: Page) => page.getByRole("dialog");

test("New feature: a name, a confirm, and the new feature's page opens", async ({ page }, info) => {
  await setReport(page);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costReport);
  await expect(admin.table("Cost and time by feature")).toBeVisible();
  await shot(page, info, "actions-report-light");
  await page.getByRole("button", { name: "New feature" }).click();
  await expect(dialog(page).getByRole("button", { name: "Make feature" })).toBeDisabled();
  await dialog(page).getByLabel("Feature name").fill("Billing v3");
  await shot(page, info, "new-feature-dialog-light");
  await dialog(page).getByRole("button", { name: "Make feature" }).click();
  await expect(admin.heading("Billing v3")).toBeVisible();
  await expect(page.getByTestId("report-empty")).toBeVisible();
  await expect(dialog(page)).toHaveCount(0);
});

test("a name that is taken keeps the confirm open with Code's refusal in Cloud's words", async ({ page }, info) => {
  await setReport(page);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costReport);
  await page.getByRole("button", { name: "New feature" }).click();
  await dialog(page).getByLabel("Feature name").fill("Search");
  await dialog(page).getByRole("button", { name: "Make feature" }).click();
  await expect(page.getByTestId("report-action-error")).toHaveText("A feature with that name already exists.");
  await expect(dialog(page)).toBeVisible();
  await shot(page, info, "name-taken-light");
  await page.keyboard.press("Escape");
  await expect(dialog(page)).toHaveCount(0);
});

test("Rename changes the name, Mark done and Reopen change the state", async ({ page }, info) => {
  await setReport(page);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costFeature(F_CHECKOUT));
  await expect(admin.table("Tasks in this feature")).toBeVisible();
  await shot(page, info, "feature-actions-light");
  await page.getByRole("button", { name: "Rename" }).click();
  await expect(dialog(page).getByRole("button", { name: "Rename" })).toBeDisabled();
  await dialog(page).getByLabel("Feature name").fill("Checkout v3");
  await dialog(page).getByRole("button", { name: "Rename" }).click();
  await expect(admin.heading("Checkout v3")).toBeVisible();
  await page.getByRole("button", { name: "Mark done" }).click();
  await shot(page, info, "mark-done-dialog-light");
  await dialog(page).getByRole("button", { name: "Mark done" }).click();
  await expect(page.getByRole("button", { name: "Reopen" })).toBeVisible();
  await expect(page.getByText("Done", { exact: true }).first()).toBeVisible();
  await page.getByRole("button", { name: "Reopen" }).click();
  await dialog(page).getByRole("button", { name: "Reopen" }).click();
  await expect(page.getByRole("button", { name: "Mark done" })).toBeVisible();
});

test("Merge into moves the tasks to the other feature and opens it", async ({ page }, info) => {
  await setReport(page);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costFeature(F_SEARCH));
  await expect(admin.table("Tasks in this feature")).toBeVisible();
  await page.getByRole("button", { name: "Merge into" }).click();
  await expect(dialog(page)).toContainText("can't be brought back");
  await expect(dialog(page).getByRole("button", { name: "Merge" })).toBeDisabled();
  await dialog(page).getByLabel("Merge into").selectOption({ label: "Checkout v2" });
  await shot(page, info, "merge-dialog-light");
  await dialog(page).getByRole("button", { name: "Merge" }).click();
  await expect(admin.heading("Checkout v2")).toBeVisible();
  await expect(admin.table("Tasks in this feature").getByRole("row")).toHaveCount(4);
  // The merged feature is gone.
  await page.goto(ROUTES.admin.costFeature(F_SEARCH));
  await expect(admin.heading("Feature not found")).toBeVisible();
});

test("Move to feature files a task from No feature, and No feature takes one back", async ({ page }, info) => {
  await setReport(page);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.costFeature("none"));
  const tasks = admin.table("Tasks in this feature");
  await expect(tasks.getByRole("row")).toHaveCount(3);
  for (const name of ["Rename", "Merge into", "Mark done"]) await expect(page.getByRole("button", { name })).toHaveCount(0);
  await page.getByRole("button", { name: "Move Task 4 to a feature" }).click();
  const choices = dialog(page).getByLabel("Move to feature");
  await expect(choices.locator("option")).toHaveText(["Choose a feature", "Checkout v2", "Search"]);
  await choices.selectOption({ label: "Checkout v2" });
  await shot(page, info, "move-dialog-light");
  await dialog(page).getByRole("button", { name: "Move task" }).click();
  await expect(tasks.getByRole("row")).toHaveCount(2);
  await page.goto(ROUTES.admin.costFeature(F_CHECKOUT));
  await expect(tasks).toContainText("Task 4");
  await page.getByRole("button", { name: "Move Task 4 to a feature" }).click();
  await dialog(page).getByLabel("Move to feature").selectOption({ label: "No feature" });
  await dialog(page).getByRole("button", { name: "Move task" }).click();
  await expect(tasks).not.toContainText("Task 4");
});

for (const scheme of ["light", "dark"] as const) {
  test(`the feature page with a confirm open has no accessibility violations in ${scheme}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await setReport(page);
    const admin = new AdminPage(page);
    await admin.open(ROUTES.admin.costFeature(F_CHECKOUT));
    await expect(admin.table("Tasks in this feature")).toBeVisible();
    expect(await violations(page)).toEqual([]);
    await page.getByRole("button", { name: "Merge into" }).click();
    await expect(dialog(page)).toBeVisible();
    // The confirm fades in; axe reads the colours mid-fade unless it waits for the end.
    await expect(dialog(page)).toHaveCSS("opacity", "1");
    await page.waitForFunction(() => document.getAnimations().every((animation) => animation.playState !== "running"));
    expect(await violations(page)).toEqual([]);
    if (scheme === "dark") await shot(page, info, "merge-dialog-dark");
  });
}

test("at the narrowest admin width the feature page with its actions does not scroll sideways", async ({ page }, info) => {
  await setReport(page);
  const admin = new AdminPage(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await admin.open(ROUTES.admin.costFeature(F_CHECKOUT));
  await expect(admin.table("Tasks in this feature")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await shot(page, info, "feature-actions-1024-light");
});
