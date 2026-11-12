import type { Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { mockReviews } from "./support/review-groups-mock.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Review groups (switch: localStorage `rovara.reviews` = "v2"). Off: the project page and the task page are today's, and no review route is called. On: a maintainer edits a project's groups and saves them under the
// revision; a person claims the task's waiting review and then releases it. Each at 390 and 1280, in both themes, with no sideways scroll, 44px controls, and axe clean.
// Set ROVARA_REVIEW_SHOTS to a folder for the pictures.
const shots = process.env.ROVARA_REVIEW_SHOTS ?? ".test-build/web-e2e/review-groups";
const SESSION = "ses_aaaaaaaaaaaaaaaaaaaa";
type Fixtures = Parameters<Parameters<typeof test>[2]>[0];
async function enter(page: Page, { context, request, baseURL }: Pick<Fixtures, "context" | "request" | "baseURL">, scenario: string, theme: "light" | "dark", width: number, on: boolean) {
 await request.post("/__mock/scenario", { data: { name: scenario } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
 await page.addInitScript(values => { if (sessionStorage.getItem("__seeded") === null) { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value);sessionStorage.setItem("__seeded", "1"); } }, { "rovara.theme": theme, ...(on ? { "rovara.reviews": "v2" } : {}) });
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const smallTargets = (page: Page, selector: string) => page.locator(selector).evaluateAll(nodes => nodes.filter(node => { const box = node.getBoundingClientRect();return box.width > 0 && box.height > 0 && box.height < 44; }).map(node => node.textContent));
test("off: no Review groups section, no review card, and no review route is called", async ({ page, context, request, baseURL }) => {
 await enter(page, { context, request, baseURL }, "project", "light", 1280, false);
 const mock = await mockReviews(page), urls: string[] = [];page.on("request", request => { urls.push(request.url()); });
 await page.goto("/app/projects/payments");await expect(page.getByRole("heading", { name: "Running now" })).toBeVisible();await page.waitForLoadState("networkidle");
 await expect(page.getByRole("heading", { name: "Review groups" })).toHaveCount(0);
 await request.post("/__mock/scenario", { data: { name: "workspace" } });await page.goto("/app/sessions/" + SESSION);await expect(page.getByRole("heading", { name: "Fix duplicate refunds" })).toBeVisible();await page.waitForLoadState("networkidle");
 await expect(page.getByRole("region", { name: "Pull request review" })).toHaveCount(0);expect(mock.reviewRequests()).toHaveLength(0);
 // Not even the lazy chunks of the two screens are downloaded.
 expect(urls.filter(url => /ReviewGroupsSection|TaskReviewCard|reviews-/u.test(url))).toEqual([]);expect(urls.length).toBeGreaterThan(5);
});
for (const theme of ["light", "dark"] as const) for (const width of [1280, 390] as const) {
 test(`on at ${String(width)} in ${theme}: a maintainer edits the groups, then a person claims the waiting review and releases it`, async ({ page, context, request, baseURL }) => {
  await enter(page, { context, request, baseURL }, "project", theme, width, true);
  const mock = await mockReviews(page);
  // The project page: read the groups, rename one, add a person and a group, save.
  await page.goto("/app/projects/payments");
  const section = page.getByRole("region", { name: "Review groups" });await expect(section.getByRole("heading", { name: "Backend" })).toBeVisible();
  await expect(section.getByText("no longer a contributor")).toBeVisible();await expect(section.getByRole("note")).toContainText("It doesn't let anyone approve");
  await section.scrollIntoViewIfNeeded();expect(await noSidewaysScroll(page)).toBe(true);await checkA11y(page, { theme });await evidenceShot(page, { path: `${shots}/groups-read-${theme}-${String(width)}.png`, fullPage: false });
  await section.getByRole("button", { name: "Edit groups" }).click();
  await expect(section.getByLabel("Name").first()).toBeFocused();
  await section.getByLabel("Name").first().fill("Backend team");
  const picker = section.getByLabel("Add a person to Backend team");await expect(picker).toBeEnabled();await expect(picker.locator("option")).toHaveText(["Choose a person", "Omar", "Lena"]);await picker.selectOption({ label: "Lena" });
  await section.getByRole("button", { name: "Add a group" }).click();await section.getByLabel("Name").last().fill("Security");
  expect(await smallTargets(page, ".rv-review-editor button, .rv-review-editor select, .rv-review-editor input")).toEqual([]);expect(await noSidewaysScroll(page)).toBe(true);
  await checkA11y(page, { theme });await evidenceShot(page, { path: `${shots}/groups-edit-${theme}-${String(width)}.png`, fullPage: false });
  await section.getByRole("button", { name: "Save groups" }).click();
  await expect(section.getByText("Review groups saved.")).toBeVisible();await expect(section.getByRole("heading", { name: "Backend team" })).toBeVisible();await expect(section.getByRole("heading", { name: "Security" })).toBeVisible();
  await expect(section.getByRole("button", { name: "Edit groups" })).toBeFocused();
  const save = mock.writes().find(write => write.path === "review-groups")!.body;expect(save["expectedRevision"]).toBe(3);expect(save["groups"]).toEqual([{ groupId: mock.ids.GROUP_BACKEND, name: "Backend team", members: [mock.ids.PRIYA, mock.ids.LENA] }, { groupId: mock.ids.GROUP_PAYMENTS, name: "Payments", members: [mock.ids.OMAR] }, { name: "Security", members: [] }]);
  await checkA11y(page, { theme });await evidenceShot(page, { path: `${shots}/groups-saved-${theme}-${String(width)}.png`, fullPage: false });
  // The task page: the card shows the waiting, aged review; Claim, then Release.
  await request.post("/__mock/scenario", { data: { name: "workspace" } });await page.goto("/app/sessions/" + SESSION);
  const card = page.getByRole("region", { name: "Pull request review" });await expect(card.getByText("Aged: waiting 30 hours")).toBeVisible();await expect(card.getByText("Nobody has claimed this review yet.")).toBeVisible();
  await expect(card.getByText("It doesn't let anyone approve")).toBeVisible();await expect(card.getByRole("button", { name: "Release" })).toHaveCount(0);
  await card.scrollIntoViewIfNeeded();expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page, ".rv-review-card button")).toEqual([]);await checkA11y(page, { theme });await evidenceShot(page, { path: `${shots}/card-waiting-${theme}-${String(width)}.png`, fullPage: false });
  await card.getByRole("button", { name: "Claim review" }).click();
  const dialog = page.getByRole("dialog", { name: "Claim this review?" });await expect(dialog).toBeVisible();await expect(dialog.getByText("It doesn't let anyone approve")).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);expect(await smallTargets(page, "[role=dialog] button, [role=dialog] select")).toEqual([]);await checkA11y(page, { theme });await evidenceShot(page, { path: `${shots}/card-claim-dialog-${theme}-${String(width)}.png`, fullPage: false });
  await dialog.getByRole("button", { name: "Claim", exact: true }).click();
  await expect(card.getByText(/Claimed by Priya for the Backend group/u)).toBeVisible();await expect(card.getByText("Waiting to ask GitHub")).toBeVisible();await expect(card.getByText("You claimed this review.")).toBeVisible();
  await expect(card.getByRole("button", { name: "Claim review" })).toHaveCount(0);await expect(card.getByText("It doesn't let anyone approve")).toBeVisible();
  await checkA11y(page, { theme });await evidenceShot(page, { path: `${shots}/card-claimed-${theme}-${String(width)}.png`, fullPage: false });
  await card.getByRole("button", { name: "Release" }).click();await page.getByRole("dialog", { name: "Release this review?" }).getByRole("button", { name: "Release", exact: true }).click();
  await expect(card.getByText("Nobody has claimed this review yet.")).toBeVisible();await expect(card.getByRole("button", { name: "Claim review" })).toBeVisible();
  const claims = mock.writes().filter(write => write.path === "claim" || write.path === "release");expect(claims.map(write => write.path)).toEqual(["claim", "release"]);
  expect(claims[0]!.body).toMatchObject({ expectedRevision: 4, reviewKey: "f".repeat(64), groupId: mock.ids.GROUP_BACKEND });expect(claims[1]!.body["expectedRevision"]).toBe(5);
  expect(await noSidewaysScroll(page)).toBe(true);await checkA11y(page, { theme });
 });
}
