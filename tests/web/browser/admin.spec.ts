import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { expect, test, type Page } from "@playwright/test";
import { AccountPage, AdminPage, ROUTES } from "./pages/index.js";

// The admin area on the pretend Code (Hybrid 1, DEC 223). Priya signs in as an administrator. Cloud serves none of the company routes against the pretend Code, so every
// page must say "not connected yet" and stop loading; the pages that show numbers or lists are given a served route here with `page.route`, and say so in the spec.
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const SPEND = {
  spentThisMonthUsd: 412.6, remainingUsd: 549.2, heldUsd: 38.2, limitUsd: 961.8, runsOutOn: "2026-11-29", costPerMergedChangeUsd: 3.84, mergedCount: 96, month: "2026-11",
  byProject: [{ name: "evals-api", spentUsd: 201.4, heldUsd: 21, limitUsd: 400, taskStopUsd: 8, mergedCount: 52, paidFrom: "Company Gemini account" }, { name: "prompt-router", spentUsd: 171.6, heldUsd: 17.2, limitUsd: 172, taskStopUsd: 8, mergedCount: 37, paidFrom: "Company Gemini account" }],
  byPerson: [{ name: "Priya Raman", role: "Admin", spentUsd: 148.2, allowanceUsd: 300, allowanceSource: "own", tasks: 41, mergedCount: 38 }, { name: "Sam Okoye", role: "Member", spentUsd: 139.9, allowanceUsd: 150, allowanceSource: "company_default", tasks: 36, mergedCount: 31 }],
};

async function serve(page: Page, path: string, body: unknown, status = 200): Promise<void> {
  await page.route(`**/v1/web${path}`, route => (route.request().method() === "GET" ? route.fulfill(json(body, status)) : route.fallback()));
}

test("the admin area has five groups in a sidebar, not 14 flat tabs", async ({ page }) => {
  const admin = new AdminPage(page);
  await admin.open();
  await expect(admin.groupHeadings).toHaveText(["People and access", "Money", "Work and rules", "AI and connections", "Oversight"]);
  await expect(admin.link("Overview")).toHaveAttribute("aria-current", "page");
  // The sidebar is a column beside the page, not a row of tabs above it.
  const nav = await admin.nav.boundingBox(), main = await page.locator(".rv-admin-surface").boundingBox();
  expect(nav !== null && main !== null && main.x >= nav.x + nav.width - 1 && Math.abs(main.y - nav.y) < 80).toBe(true);
  await expect(admin.link("Sign-in factors")).toHaveCount(0);
  await admin.link("Sign-in clients").click();
  await expect(admin.heading("Sign-in clients")).toBeVisible();
  await expect(admin.link("Sign-in clients")).toHaveAttribute("aria-current", "page");
});

test("Spending says it is not connected yet when Cloud has no spending read", async ({ page }) => {
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.spending);
  await expect(admin.heading("Spending")).toBeVisible();
  await admin.expectNotConnected("Company spending");
});

test("Spending shows real amounts, by project (people are on their own page), and the over-budget state", async ({ page }) => {
  await serve(page, "/org/spend", SPEND);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.spending);
  const stats = admin.stats("Spending in November");
  await expect(stats).toContainText("$412.60");
  await expect(stats).toContainText("$38.20");
  await expect(stats).toContainText("$549.20");
  await expect(admin.table("Spending by project")).toContainText("evals-api");
  await expect(admin.table("Spending by project")).toContainText("$0.40 left");
  // Per-person spending is on People and limits only (owner rule D2): a link here, no table, no names.
  await expect(page.getByRole("table", { name: "Spending by person" })).toHaveCount(0);
  await expect(page.getByText("Sam Okoye")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "People and limits" }).first()).toHaveAttribute("href", "/app/admin/money/people");
  await expect(page.getByText("This month's budget is used up")).toHaveCount(0);
  // Over budget: Rovara says so, by how much, and where to raise the limit.
  await page.unroute("**/v1/web/org/spend");
  await serve(page, "/org/spend", { ...SPEND, spentThisMonthUsd: 966.3, remainingUsd: -4.5, limitUsd: 961.8 });
  await page.reload();
  await expect(page.getByText("This month's budget is used up")).toBeVisible();
  await expect(page.getByRole("link", { name: "See limits" })).toBeVisible();
});

test("Overview shows this month's money and the people at a glance", async ({ page }) => {
  await serve(page, "/org/spend", SPEND);
  const admin = new AdminPage(page);
  await admin.open();
  await expect(admin.stats("At a glance")).toContainText("$412.60");
  await expect(page.getByRole("link", { name: "Open Spending", exact: true })).toBeVisible();
});

for (const screen of [
  { name: "Sign-in clients", path: ROUTES.admin.signInClients, what: "Sign-in clients" },
]) {
  test(`${screen.name} says it is not connected yet instead of loading forever`, async ({ page }) => {
    const admin = new AdminPage(page);
    await admin.open(screen.path);
    await admin.expectNotConnected(screen.what);
  });
}

// Company settings is served for real: Cloud's company backend runs in memory (CLOUD_COMPANY_DATA=memory in playwright.config.ts) for the company the pretend Code's access check names.
test("Company settings reads Cloud's company backend and says the model gateway needs a monthly cap", async ({ page }) => {
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.settings);
  await expect(admin.heading("Company settings")).toBeVisible();
  await expect(page.getByText("No company rules yet")).toBeVisible();
  await expect(page.getByText("Set a monthly cap to use the model gateway.")).toBeVisible();
  await expect(page.getByText(/No monthly cap is set/u)).toBeVisible();
  await expect(admin.notConnected).toHaveCount(0);
});

test("Spending and the Overview say the same, and link to where the cap is set", async ({ page }) => {
  await serve(page, "/org/spend", SPEND);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.spending);
  const banner = page.getByRole("region", { name: "Set a monthly cap to use the model gateway." });
  await expect(banner).toBeVisible();
  await banner.getByRole("link", { name: "Set the cap" }).click();
  await expect(page).toHaveURL(/\/app\/admin\/settings#monthly-cap/u);
  await admin.open(ROUTES.admin.home);
  await expect(page.getByRole("region", { name: "Set a monthly cap to use the model gateway." })).toBeVisible();
});

// The settings PUTs below are answered here, never by the local Cloud: a saved cap would stay in its store and change what later specs read.
async function answerSettingsWrites(page: Page): Promise<void> {
  await page.route("**/v1/web/org/settings", route => (route.request().method() === "PUT" ? route.fulfill(json({ companyId: "org_aaaaaaaaaaaaaaaaaaaa", version: 2, settings: {} })) : route.fallback()));
}

test("changing the cap needs no step-up (owner DEC 254zzz73): the editor opens at once and the change is sent", async ({ page }) => {
  await answerSettingsWrites(page);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.settings);
  await page.getByRole("button", { name: "Change rules" }).click();
  await expect(admin.freshSignIn).toHaveCount(0);
  await page.getByLabel("Company monthly cap (USD)").fill("2500");
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect(page.getByText(/Saved\. The new rules apply/u)).toBeVisible();
  await expect(admin.freshSignIn).toHaveCount(0);
});

// Every write goes through the browser host's one signed-write path: it carries its body's SHA-256 in x-amz-content-sha256 (Cloud #48, behind CloudFront).
test("the settings write carries the body hash like every other write", async ({ page }) => {
  const writes: Array<{ method: string; url: string; hash: string | undefined; body: string | null }> = [];
  page.on("request", request => { if (request.method() !== "GET" && request.url().includes("/v1/web/")) writes.push({ method: request.method(), url: request.url(), hash: request.headers()["x-amz-content-sha256"], body: request.postData() }); });
  await answerSettingsWrites(page);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.settings);
  await page.getByRole("button", { name: "Change rules" }).click();
  await page.getByLabel("Company monthly cap (USD)").fill("0");
  await expect(page.getByText("A $0 cap blocks all model gateway use.")).toBeVisible();
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect.poll(() => writes.some(write => write.method === "PUT" && write.url.endsWith("/v1/web/org/settings"))).toBe(true);
  for (const write of writes.filter(entry => entry.url.endsWith("/v1/web/org/settings"))) {
    expect(write.hash, `${write.method} ${write.url}`).toBe(createHash("sha256").update(write.body ?? "").digest("hex"));
  }
});

test("Your account has no confirmation email or passkeys, and never asks for sign-in factors (owner DEC 254zzz73)", async ({ page }) => {
  const asked: string[] = [];
  page.on("request", request => { if (request.url().includes("/sign-in-factors")) asked.push(request.url()); });
  const account = new AccountPage(page);
  await account.open();
  await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Confirmation email" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Passkeys" })).toHaveCount(0);
  expect(asked).toEqual([]);
});

test("the account menu leads to the account page", async ({ page }) => {
  await page.goto(ROUTES.home);
  await page.getByTestId("account-menu").click();
  await page.getByRole("link", { name: "Your account page" }).click();
  await expect(page).toHaveURL(/\/app\/account/u);
});

// Contrast and structure in a real browser (jsdom cannot judge colour), in both themes, on the pages that carry the new colours: the stat tiles, the meters, the
// over-budget flags and the "not connected yet" boxes.
const axeSource = readFileSync(createRequire(import.meta.url).resolve("axe-core/axe.min.js"), "utf8");
async function violations(page: Page): Promise<string[]> {
  await page.evaluate(axeSource);
  return page.evaluate(async () => {
    const result = await (window as unknown as { axe: { run(context: string): Promise<{ violations: Array<{ id: string; nodes: Array<{ target: unknown }> }> }> } }).axe.run("main");
    return result.violations.map((violation) => `${violation.id}: ${JSON.stringify(violation.nodes.map((node) => node.target))}`);
  });
}
for (const scheme of ["light", "dark"] as const) {
  test(`Spending (amounts, flags, not-connected boxes) has no accessibility violations in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await serve(page, "/org/spend", { ...SPEND, spentThisMonthUsd: 966.3, remainingUsd: -4.5, byProject: [{ ...SPEND.byProject[0]!, spentUsd: 410 }, SPEND.byProject[1]!] });
    const admin = new AdminPage(page);
    await admin.open(ROUTES.admin.spending);
    await expect(admin.table("Spending by project")).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
  test(`Account has no accessibility violations in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    const account = new AccountPage(page);
    await account.open();
    await expect(page.getByRole("heading", { name: "Your account" })).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
}
