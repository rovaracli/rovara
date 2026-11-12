import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { installPeopleMock, DECISION_ID } from "./support/people-mock.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Lane exp/project-people: the project's product decisions panel and the collaborator approvals switch (switch `rovara.people` = "v2"), at 1280 and 390, light and dark.
const shots = process.env.ROVARA_PEOPLE_SHOTS ?? ".test-build/web-e2e/people";
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number) {
 await request.post("/__mock/scenario", { data: { name: "project" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
 await page.addInitScript(() => { localStorage.setItem("rovara.people", "v2"); });
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);

for (const width of [1280, 390] as const) {
 test(`a decision is approved from the project page at ${String(width)}; axe clean in both themes`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width);const mock = await installPeopleMock(page);await page.goto("/app/projects/payments");
  const panel = page.getByRole("region", { name: "Product decisions" });
  await expect(panel.getByRole("heading", { name: "Which wording should the refund button use?" })).toBeVisible();await expect(panel.getByText("Low risk")).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: `${shots}/decision-light-${String(width)}.png`, fullPage: true });
  await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: `${shots}/decision-dark-${String(width)}.png`, fullPage: true });
  await panel.getByRole("button", { name: "Approve: Request a refund" }).click();await page.getByRole("dialog").getByRole("button", { name: "Approve", exact: true }).click();
  await expect(panel.getByText("Approved:")).toBeVisible();await expect(panel.getByRole("button", { name: /^Approve:/u })).toHaveCount(0);
  const approvals = mock.sent.filter(item => item.method === "POST" && item.path.endsWith("/product-decisions/" + DECISION_ID));expect(approvals).toHaveLength(1);
  expect(approvals[0]!.body).toMatchObject({ action: "approve", optionId: "o2", expectedRevision: 4 });
  expect(await noSidewaysScroll(page)).toBe(true);await checkA11y(page, { theme: "dark" });
 });
 test(`an empty list is a calm empty state at ${String(width)}, and the collaborator approvals switch changes under its revision`, async ({ page, context, request, baseURL }) => {
  await enter(page, context, request, baseURL, width);const mock = await installPeopleMock(page, { decisions: false });await page.goto("/app/projects/payments");
  await expect(page.getByText("No product decisions waiting")).toBeVisible();await checkA11y(page, { theme: "light" });
  await page.goto("/app/projects/payments?tab=people");
  const toggle = page.getByRole("switch", { name: "Let collaborators approve low-risk product decisions" });await expect(toggle).toBeChecked();await toggle.click();await page.getByRole("dialog").getByRole("button", { name: "Turn off", exact: true }).click();await expect(toggle).not.toBeChecked();
  const writes = mock.sent.filter(item => item.method === "PUT" && item.path.endsWith("/collaborator-approvals"));expect(writes).toHaveLength(1);expect(writes[0]!.body).toMatchObject({ enabled: false, expectedRevision: 2 });
  await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: `${shots}/approvals-dark-${String(width)}.png`, fullPage: true });
 });
}
