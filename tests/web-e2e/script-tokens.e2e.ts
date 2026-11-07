// UX5b: the Script tokens screen in a real browser. Make a token (shown once, gone when the dialog closes and after a reload), its row in the list, revoke it after confirming,
// and the page at phone width with no sideways scroll; axe in light and dark. The token routes are answered here, in the page, with a token built at run time.
import type { Locator, Page, Route } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";

const fakeSecret = () => ["rvst", "a".repeat(20), "c".repeat(20), "Z".repeat(43)].join("_");

/** The dialog's opening animation, finished: axe reads colours mid-fade otherwise. */
const settled = (dialog: Locator) => dialog.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });

async function mount(page: Page) {
 const tokens: Array<Record<string, unknown>> = [];
 const writes: string[] = [];
 await page.route("**/v1/web/nav", async (route: Route) => {
  const answer = await route.fetch();
  const nav = await answer.json() as { features: Record<string, unknown> };
  await route.fulfill({ response: answer, json: { ...nav, features: { ...nav.features, scriptTokens: true } } });
 });
 await page.route("**/v1/web/script-tokens", async (route: Route) => {
  const request = route.request();
  if (request.method() === "GET") return route.fulfill({ json: { tokens } });
  writes.push("POST");
  const body = request.postDataJSON() as { name: string; projects: string[]; permissions: string[]; days: number };
  const now = Date.parse("2026-11-07T09:00:00.000Z");
  const token = { tokenId: "stk_cccccccccccccccccccc", name: body.name, hint: "rvst_…cccccccc", projects: body.projects, permissions: body.permissions, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + body.days * 86_400_000).toISOString(), status: "active", mine: true };
  tokens.unshift(token);
  return route.fulfill({ status: 201, json: { token, secret: fakeSecret() } });
 });
 await page.route("**/v1/web/script-tokens/*", async (route: Route) => {
  writes.push(route.request().method());
  const id = new URL(route.request().url()).pathname.split("/").at(-1);
  const found = tokens.find(token => token.tokenId === id)!;
  Object.assign(found, { status: "revoked", revokedAt: "2026-11-07T10:00:00.000Z" });
  return route.fulfill({ json: { token: found } });
 });
 return { tokens, writes };
}

test.beforeEach(async ({ context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "shell" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
});

test("makes a token shown once, lists it and revokes it after confirming", async ({ page }, info) => {
 const mock = await mount(page);
 await page.goto("/app");
 await page.getByRole("link", { name: "Script tokens" }).first().click();
 await expect(page.getByRole("heading", { name: "Script tokens", level: 1 })).toBeVisible();
 await expect(page.getByText("No script tokens yet.")).toBeVisible();
 await page.getByRole("textbox", { name: "Name", exact: true }).fill("CI deploy");
 await page.getByRole("checkbox", { name: "payments" }).click();
 await page.getByRole("checkbox", { name: "Start tasks" }).click();
 await page.getByLabel("Expires after").selectOption("90");
 await page.getByRole("button", { name: "Make token" }).click();
 const dialog = page.getByRole("dialog", { name: "Copy your token now" });
 await expect(dialog.getByLabel("Token")).toHaveValue(fakeSecret());
 await settled(dialog);
 await checkA11y(page, { theme: "light" });
 await evidenceShot(page, { path: info.outputPath("script-token-shown-once.png") });
 await dialog.getByRole("button", { name: "Done" }).click();
 await expect(dialog).toBeHidden();
 expect(await page.content()).not.toContain(fakeSecret());
 const row = page.getByRole("listitem", { name: "CI deploy" });
 await expect(row.getByText("rvst_…cccccccc")).toBeVisible();
 await expect(row.getByText("Read tasks, Start tasks")).toBeVisible();
 await expect(row.getByText(/Active, expires Feb 5, 2027 UTC/u)).toBeVisible();
 await expect(row.getByText("Never")).toBeVisible();
 // Gone for good: a reload lists the token but never shows it again.
 await page.reload();
 await expect(page.getByRole("listitem", { name: "CI deploy" })).toBeVisible();
 expect(await page.content()).not.toContain(fakeSecret());
 await checkA11y(page, { theme: "dark" });
 await page.getByRole("listitem", { name: "CI deploy" }).getByRole("button", { name: "Revoke" }).click();
 const confirm = page.getByRole("dialog", { name: "Revoke this token?" });
 await expect(confirm).toBeVisible();
 expect(mock.writes).toEqual(["POST"]);
 await confirm.getByRole("button", { name: "Revoke token" }).click();
 await expect(confirm).toBeHidden();
 await expect(page.getByRole("listitem", { name: "CI deploy" }).getByText(/^Revoked/u)).toBeVisible();
 await expect(page.getByRole("listitem", { name: "CI deploy" }).getByRole("button", { name: "Revoke" })).toHaveCount(0);
 expect(mock.writes).toEqual(["POST", "DELETE"]);
});

for (const [theme, width] of [["light", 390], ["dark", 360]] as const) {
 test(`fits a phone at ${width}px in ${theme} with no sideways scroll`, async ({ page }, info) => {
  const mock = await mount(page);
  mock.tokens.push({ tokenId: "stk_dddddddddddddddddddd", name: "A long-named nightly integration job for payments", hint: "rvst_…dddddddd", projects: ["payments"], permissions: ["read", "start"], createdAt: "2026-11-07T09:00:00.000Z", expiresAt: "2026-12-07T09:00:00.000Z", lastUsedAt: "2026-11-07T09:30:00.000Z", status: "active", mine: true });
  await page.emulateMedia({ colorScheme: theme });
  await page.setViewportSize({ width, height: 844 });
  await page.goto("/app/settings/script-tokens");
  await expect(page.getByRole("heading", { name: "Script tokens", level: 1 })).toBeVisible();
  await expect(page.getByRole("listitem", { name: /A long-named nightly/u })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.getByRole("textbox", { name: "Name", exact: true }).fill("Phone job");
  await page.getByRole("checkbox", { name: "payments" }).click();
  await page.getByRole("button", { name: "Make token" }).click();
  await expect(page.getByRole("dialog", { name: "Copy your token now" })).toBeVisible();
  await settled(page.getByRole("dialog", { name: "Copy your token now" }));
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await checkA11y(page, { theme });
  await evidenceShot(page, { path: info.outputPath(`script-tokens-phone-${width}.png`), fullPage: true });
 });
}
