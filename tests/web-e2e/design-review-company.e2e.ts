// Design review (DR-FU4), in a real browser: the company's Design review card on the company How we work page (allowed, default mode, rules; allowing waits for a different admin), and the project's card, which says why
// it is off where the company has not allowed design review and offers Off, Auto and Always where it has. The mock cell answers the ordinary views; each test adds what the broker would send.
import type { Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";

test.beforeEach(async ({ context, request, baseURL, page }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.route("**/v1/web/org/model-sources", route => route.fulfill({ json: { sources: [], order: ["rovara"] } }));
});

type State = { revision: number; allowed: boolean; defaultMode: "never" | "auto" | "always"; lock: Record<string, unknown>; unreadable: boolean; pending?: { changeId: string; proposedByYou: boolean; expiresAt: string } };
async function company(page: Page, initial: State) {
 let state = initial;
 const posts: Array<Record<string, unknown>> = [];
 await page.route("**/v1/web/org/design-review", async route => {
  const req = route.request();
  if (req.method() === "GET") return route.fulfill({ json: state });
  const body = req.postDataJSON() as Record<string, unknown>;posts.push(body);
  if (body.action === "save") { state = { ...state, revision: state.revision + 1, defaultMode: body.defaultMode as State["defaultMode"], lock: body.lock as Record<string, unknown> }; return route.fulfill({ json: { status: "applied", ...state } }); }
  if (body.action === "allow" && body.allowed === true) { state = { ...state, pending: { changeId: "chg_1", proposedByYou: true, expiresAt: "2026-11-11T12:00:00.000Z" } }; return route.fulfill({ status: 202, json: { status: "needs_approval", changeId: "chg_1", ...state } }); }
  state = { ...state, revision: state.revision + 1, allowed: false }; return route.fulfill({ json: { status: "applied", ...state } });
 });
 return posts;
}

test("a company admin allows design review, which waits for a different admin, then sets the default and the rules", async ({ page }) => {
 const posts = await company(page, { revision: 0, allowed: false, defaultMode: "never", lock: {}, unreadable: false });
 await page.setViewportSize({ width: 1280, height: 1100 });
 await page.goto("/app/admin/how-we-work");
 const card = page.getByRole("region", { name: "Design review", exact: true });
 await expect(card.getByRole("switch", { name: "Allow design review in this company" })).toHaveAttribute("aria-checked", "false");
 await expect(card.getByLabel("Projects that have not chosen")).toHaveValue("never");
 await card.getByRole("switch", { name: "Allow design review in this company" }).click();
 await expect(card.getByText("Waiting for a different admin to confirm.")).toBeVisible();
 await expect(card.getByText("You asked to allow design review. A different admin has to confirm it here.")).toBeVisible();
 expect(posts[0]).toEqual({ action: "allow", expectedRevision: 0, allowed: true });
 await card.getByLabel("Projects that have not chosen").selectOption("auto");
 await card.getByLabel("Design review at least").selectOption("auto");
 await card.getByLabel("Tier at least").selectOption("standard");
 await card.getByRole("switch", { name: "Nobody can skip design review" }).click();
 await card.getByLabel("Highest cost limit per task (USD)").fill("8");
 await card.getByRole("button", { name: "Save default and rules" }).click();
 await expect(card.getByText("Saved. New design reviews use these settings; running ones keep theirs.")).toBeVisible();
 expect(posts[1]).toEqual({ action: "save", expectedRevision: 0, defaultMode: "auto", lock: { mode: "auto", tierAtLeast: "standard", allowSkip: false, capCeilingUsd: 8 } });
 await checkA11y(page, { theme: "light" });await checkA11y(page, { theme: "dark" });
 await page.setViewportSize({ width: 360, height: 800 });
 expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

test("the card is not on the page while design review is off in the environment", async ({ page }) => {
 await page.route("**/v1/web/org/design-review", route => route.fulfill({ status: 404, json: { error: { code: "NOT_FOUND", message: "Not found." } } }));
 await page.setViewportSize({ width: 1280, height: 900 });
 await page.goto("/app/admin/how-we-work");
 await expect(page.getByRole("heading", { name: "How we work (company)", exact: true })).toBeVisible();
 await expect(page.getByRole("region", { name: "Design review", exact: true })).toHaveCount(0);
});

test("the project's card says why it is off where the company has not allowed design review, and offers Off, Auto and Always where it has", async ({ page, request }) => {
 await request.post("/__mock/scenario", { data: { name: "project" } });
 let allowed = false;
 await page.route("**/v1/web/projects/payments/playbook", route => route.fulfill({ json: allowed
  ? { designReviewAllowed: true, playbook: { revision: 2, defaultProcess: { kind: "builtin" }, designReview: { mode: "never", tier: "standard", allowSkip: true, capUsdPerTask: 10, highRiskApprover: { kind: "maintainers" } } } }
  : { designReviewAllowed: false, playbook: { revision: 2, defaultProcess: { kind: "builtin" } } } }));
 await page.setViewportSize({ width: 1280, height: 1100 });
 await page.goto("/app/projects/payments?tab=how-we-work");
 const card = page.getByRole("region", { name: "Design review", exact: true });
 await expect(card.getByText("Design review is not turned on for your company, so it does not run in this project.")).toBeVisible();
 await expect(card.getByRole("region", { name: "Design review settings editor" })).toHaveCount(0);
 await checkA11y(page, { theme: "light" });
 allowed = true;
 await page.reload();
 const editor = page.getByRole("region", { name: "Design review", exact: true }).getByRole("region", { name: "Design review settings editor" });
 const modes = editor.getByLabel("When it runs").locator("option");
 await expect(modes).toHaveText(["Choose", "Off: no design review unless someone asks for design first", "Auto: Rovara decides from the request", "Always: every code change gets a design review"]);
 await expect(editor.getByLabel("When it runs")).toHaveValue("never");
 await checkA11y(page, { theme: "dark" });
});
