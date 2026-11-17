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
  await admin.link("Sign-in factors").click();
  await expect(admin.heading("Sign-in factors")).toBeVisible();
  await expect(admin.link("Sign-in factors")).toHaveAttribute("aria-current", "page");
});

test("Spending says it is not connected yet when Cloud has no spending read", async ({ page }) => {
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.spending);
  await expect(admin.heading("Spending")).toBeVisible();
  await admin.expectNotConnected("Company spending");
});

test("Spending shows real amounts, by project and by person, and the over-budget state", async ({ page }) => {
  await serve(page, "/org/spend", SPEND);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.spending);
  const stats = admin.stats("Spending in November");
  await expect(stats).toContainText("$412.60");
  await expect(stats).toContainText("$38.20");
  await expect(stats).toContainText("$549.20");
  await expect(admin.table("Spending by project")).toContainText("evals-api");
  await expect(admin.table("Spending by project")).toContainText("$0.40 left");
  await expect(admin.table("Spending by person")).toContainText("Sam Okoye");
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
  await expect(page.getByRole("link", { name: "Open Spending" })).toBeVisible();
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

test("changing the cap asks for the fresh sign-in first, and Cloud's own step-up check sends the person back to it", async ({ page }) => {
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.settings);
  await page.getByRole("button", { name: "Change rules" }).click();
  await expect(admin.freshSignIn).toHaveAttribute("data-state", "ask");
  await expect(page.getByLabel("Company monthly cap (USD)")).toHaveCount(0);
  // Back from Code's step-up page (the pretend Code does not set one in the token, so Cloud's own check refuses the change).
  await page.evaluate(() => window.localStorage.setItem("rovara.stepup.nonce", JSON.stringify({ nonce: "e2e-cap", at: Date.now() })));
  await page.goto(`${ROUTES.admin.settings}?confirmed=e2e-cap`);
  await page.getByRole("button", { name: "Change rules" }).click();
  await page.getByLabel("Company monthly cap (USD)").fill("2500");
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect(admin.freshSignIn).toHaveAttribute("data-state", "needed");
  await expect(page.getByLabel("Company monthly cap (USD)")).toHaveCount(0);
});

// Every write goes through the browser host's one signed-write path: it carries its body's SHA-256 in x-amz-content-sha256 (Cloud #48, behind CloudFront).
test("the settings write and a passkey removal carry the body hash like every other write", async ({ page }) => {
  const writes: Array<{ method: string; url: string; hash: string | undefined; body: string | null }> = [];
  page.on("request", request => { if (request.method() !== "GET" && request.url().includes("/v1/web/")) writes.push({ method: request.method(), url: request.url(), hash: request.headers()["x-amz-content-sha256"], body: request.postData() }); });
  await serve(page, "/me/sign-in-factors", { factorEmail: "p***@acme.test", passkeys: [{ credentialId: "key-one", createdAt: "2026-10-01T00:00:00Z" }] });
  await page.route("**/v1/web/me/passkeys/key-one", route => route.fulfill(json({})));
  // The first address opened signs the person in through Code (a redirect chain), so wait for the page itself before touching its storage: `goto` can resolve mid-chain.
  const account = new AccountPage(page);
  await account.open();
  await page.evaluate(() => window.localStorage.setItem("rovara.stepup.nonce", JSON.stringify({ nonce: "e2e-sign", at: Date.now() })));
  await account.open("?remove=key-one&confirmed=e2e-sign");
  await page.getByRole("button", { name: "Remove passkey" }).click();
  await expect.poll(() => writes.some(write => write.url.endsWith("/v1/web/me/passkeys/key-one"))).toBe(true);
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.settings);
  await page.evaluate(() => window.localStorage.setItem("rovara.stepup.nonce", JSON.stringify({ nonce: "e2e-sign2", at: Date.now() })));
  await admin.open(`${ROUTES.admin.settings}?confirmed=e2e-sign2`);
  await page.getByRole("button", { name: "Change rules" }).click();
  await page.getByLabel("Company monthly cap (USD)").fill("0");
  await expect(page.getByText("A $0 cap blocks all model gateway use.")).toBeVisible();
  await page.getByRole("button", { name: "Save rules" }).click();
  await expect.poll(() => writes.some(write => write.method === "PUT" && write.url.endsWith("/v1/web/org/settings"))).toBe(true);
  for (const write of writes.filter(entry => entry.url.endsWith("/v1/web/me/passkeys/key-one") || entry.url.endsWith("/v1/web/org/settings"))) {
    expect(write.hash, `${write.method} ${write.url}`).toBe(createHash("sha256").update(write.body ?? "").digest("hex"));
  }
});

test("Sign-in factors lists people and shows the fresh sign-in step before any change", async ({ page }) => {
  await serve(page, "/org/members", { members: [{ developerId: "b".repeat(64), name: "Maya", role: "member", identities: ["github"], joinedAt: "2026-10-01T00:00:00Z" }] });
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.signInFactors);
  await page.getByRole("button", { name: "Set confirmation email for Maya" }).click();
  await expect(admin.freshSignIn).toHaveAttribute("data-state", "ask");
  await expect(page.getByLabel("New confirmation email")).toHaveCount(0);
  // The button sends the person to Code's step-up page (through Cloud's sign-in), coming back to this step.
  const asked = page.waitForRequest(request => request.url().includes("/v1/auth/browser/authorize") && request.url().includes("step_up=1"));
  await page.getByTestId("fresh-sign-in-start").click();
  const url = (await asked).url();
  expect(url).toContain("return_to=");
  expect(decodeURIComponent(url)).toMatch(/confirmed=[0-9a-f-]{36}/u);
});

test("Your account says passkeys are not connected yet", async ({ page }) => {
  const account = new AccountPage(page);
  await account.open();
  await expect(page.getByTestId("not-connected").first()).toContainText("isn't connected to Rovara Code yet");
  await expect(page.getByRole("progressbar")).toHaveCount(0);
});

test("removing a passkey asks for the fresh sign-in first, then offers the removal after coming back", async ({ page }) => {
  await serve(page, "/me/sign-in-factors", { factorEmail: "p***@acme.test", passkeys: [{ credentialId: "key-one", createdAt: "2026-10-01T00:00:00Z", lastUsedAt: "2026-11-01T00:00:00Z" }] });
  const account = new AccountPage(page);
  await account.open();
  await expect(account.factorEmail).toHaveText("p***@acme.test");
  await account.passkeys.getByRole("button", { name: /Remove the passkey added/u }).click();
  await expect(account.freshSignIn).toHaveAttribute("data-state", "ask");
  await expect(page.getByRole("button", { name: "Remove passkey" })).toHaveCount(0);
  // Coming back from Code's step-up page lands on the same step, now confirmed.
  await page.evaluate(() => window.localStorage.setItem("rovara.stepup.nonce", JSON.stringify({ nonce: "e2e-nonce", at: Date.now() })));
  await page.goto(`${ROUTES.account}?remove=key-one&confirmed=e2e-nonce`);
  await expect(account.freshSignIn).toHaveAttribute("data-state", "done");
  await expect(page.getByRole("button", { name: "Remove passkey" })).toBeVisible();
  // A made-up address does not say confirmed.
  await page.evaluate(() => window.localStorage.clear());
  await page.goto(`${ROUTES.account}?remove=key-one&confirmed=1`);
  await expect(account.freshSignIn).toHaveAttribute("data-state", "ask");
  await expect(page).toHaveURL(/remove=key-one$/u);
});

test("the account menu leads to the account page", async ({ page }) => {
  await page.goto(ROUTES.home);
  await page.getByTestId("account-menu").click();
  await page.getByRole("link", { name: "Passkeys and confirmation email" }).click();
  await expect(page).toHaveURL(/\/app\/account/u);
});

// Contrast and structure in a real browser (jsdom cannot judge colour), in both themes, on the pages that carry the new colours: the stat tiles, the meters, the
// over-budget flags, the "not connected yet" boxes and the fresh sign-in panel.
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
  test(`Account and the fresh sign-in step have no accessibility violations in ${scheme}`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: scheme });
    await serve(page, "/me/sign-in-factors", { factorEmail: "p***@acme.test", passkeys: [{ credentialId: "key-one", createdAt: "2026-10-01T00:00:00Z" }] });
    const account = new AccountPage(page);
    await account.open("?remove=key-one");
    await expect(account.freshSignIn).toBeVisible();
    expect(await violations(page)).toEqual([]);
  });
}
