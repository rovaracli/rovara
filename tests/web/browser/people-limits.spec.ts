import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page, type TestInfo } from "@playwright/test";
import { AdminPage, ROUTES } from "./pages/index.js";

// People and limits (cost report slice A6, decision D2) in Chromium on the pretend Code. The page's data route (Cloud's GET /v1/web/org/people-limits) needs the gateway's
// meter, which the pretend Cloud does not have, so it is served here with `page.route` (the route itself, its admin gate and its company scoping are covered by
// tests/unit/people-limits-routes.test.ts). Priya signs in as the company owner.
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const AL = "1".repeat(64), BO = "2".repeat(64), CY = "3".repeat(64), DI = "4".repeat(64);
const ROWS = [
  { developerId: AL, name: "Al Mendes", spentCents: 1234, limitCents: 5000, limitSource: "own" },
  { developerId: BO, name: "Bo Tanaka", spentCents: 4600, limitCents: 5000, limitSource: "company_default" },
  { developerId: CY, name: "Cy Okafor", spentCents: 5100, limitCents: 5000, limitSource: "company_default" },
  { developerId: DI, name: "Di Varga", spentCents: 999, limitCents: null, limitSource: "none" },
];
const BODY = { month: "2026-11", projects: ["api", "web"], people: ROWS };
async function serve(page: Page, body: unknown = BODY, status = 200): Promise<string[]> {
  const asked: string[] = [];
  await page.route("**/v1/web/org/people-limits**", route => { asked.push(new URL(route.request().url()).search); return route.fulfill(json(body, status)); });
  return asked;
}
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(context: string, options: unknown): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run("main", { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"] } });
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
  });
}
const shot = (page: Page, info: TestInfo, name: string) => page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });

test("People and limits is a link in Money, says it is not connected yet while Cloud has no gateway meter, and draws no amount", async ({ page }) => {
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.peopleLimits);
  await expect(admin.heading("People and limits")).toBeVisible();
  await admin.expectNotConnected("People and limits");
  await expect(admin.link("People and limits")).toHaveAttribute("aria-current", "page");
  await expect(page.getByRole("table")).toHaveCount(0);
});

test("People and limits draws the people in name order with spend against their limit, filters by project and links to the limit page", async ({ page }, info) => {
  const asked = await serve(page);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.peopleLimits);
  const table = admin.table("People and limits");
  await expect(table.getByRole("row")).toHaveCount(5);
  await expect(table.getByRole("row").nth(1)).toContainText("Al Mendes");
  await expect(table.getByRole("row").nth(1)).toContainText("$12.34");
  await expect(table.getByRole("row").nth(1)).toContainText("set for this person");
  await expect(table.getByRole("row").nth(3)).toContainText("Over the limit");
  await expect(table.getByRole("row").nth(4)).toContainText("No limit set");
  await expect(table.getByRole("columnheader")).toHaveText(["Person", "Spent this month (all projects)", "Monthly limit", "Standing", "Change"]);
  await expect(table.getByRole("button")).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(/merged|rank|quality|score|total/iu);
  await shot(page, info, "people-limits-light");
  await page.getByLabel("Show people on").selectOption("web");
  await expect.poll(() => asked.some(search => search === "?project=web")).toBe(true);
  await page.getByRole("link", { name: "Change the limit for Bo Tanaka" }).click();
  await expect(page).toHaveURL(new RegExp(`/app/admin/money/limits\\?person=${BO}$`, "u"));
  await expect(admin.heading("Spending limits")).toBeVisible();
});

test("a refused or failed read draws no amount, in words that echo nothing", async ({ page }) => {
  await serve(page, { error: { code: "RUNTIME_UNAVAILABLE", message: "secret outage text" } }, 503);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.peopleLimits);
  await expect(page.getByTestId("people-limits-error")).toContainText("Couldn't load people's spending.");
  await expect(page.locator("main")).not.toContainText("secret outage text");
  await expect(page.getByRole("table")).toHaveCount(0);
});

for (const scheme of ["light", "dark"] as const) {
  test(`People and limits has no accessibility violations in ${scheme}`, async ({ page }, info) => {
    await page.emulateMedia({ colorScheme: scheme });
    await serve(page);
    const admin = new AdminPage(page);
    await admin.open(ROUTES.admin.peopleLimits);
    await expect(admin.table("People and limits")).toBeVisible();
    expect(await violations(page)).toEqual([]);
    if (scheme === "dark") await shot(page, info, "people-limits-dark");
  });
}

test("at the narrowest admin width the page does not scroll sideways, and on a phone the admin area asks for a larger screen", async ({ page }, info) => {
  await serve(page);
  const admin = new AdminPage(page);
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto(ROUTES.admin.peopleLimits);
  await expect(admin.table("People and limits")).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await shot(page, info, "people-limits-narrow-1024");
  await page.setViewportSize({ width: 390, height: 800 });
  await page.goto(ROUTES.admin.peopleLimits);
  await expect(page.getByTestId("admin-narrow")).toBeVisible();
  await expect(page.getByRole("table")).toHaveCount(0);
  expect(await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth)).toBeLessThanOrEqual(0);
  await shot(page, info, "people-limits-phone");
});
