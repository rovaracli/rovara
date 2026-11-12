import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { installPeopleMock, PEOPLE } from "./support/people-mock.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Lane exp/project-people: the project's People tab (switch `rovara.people` = "v2"). Edit a role, add and invite a person, at 1280 and 390, light and dark. Pictures go to .test-build/web-e2e/people/ (ROVARA_PEOPLE_SHOTS changes the folder).
const shots = process.env.ROVARA_PEOPLE_SHOTS ?? ".test-build/web-e2e/people";
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, store: Record<string, string>) {
 await request.post("/__mock/scenario", { data: { name: "project" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.emulateMedia({ colorScheme: "light", reducedMotion: "reduce" });
 await page.addInitScript(values => { for (const [key, value] of Object.entries(values)) localStorage.setItem(key, value); }, store);
 await mockRealtime(page);await page.setViewportSize({ width, height: 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
const wait = (page: Page) => page.waitForLoadState("networkidle");
// The routes the switch keeps shut, and the two lazy chunks that hold the screens (their file names start with the component's name).
const PEOPLE_ROUTES = /\/v1\/web\/projects\/payments\/(?:people|product-decisions|collaborator-approvals|code-settings)/u, PEOPLE_CHUNKS = /ProjectPeopleTab|ProductDecisionsPanel/u;
const watch = (page: Page) => { const routes: string[] = [], chunks: string[] = [];page.on("request", asked => { const url = asked.url();if (PEOPLE_ROUTES.test(url)) routes.push(url);if (PEOPLE_CHUNKS.test(url)) chunks.push(url); });return { routes, chunks }; };

for (const width of [1280, 390] as const) {
 test(`switch off at ${String(width)}: the project page has no People tab and reads nothing of it`, async ({ page, context, request, baseURL }) => {
  const seen = watch(page);
  await enter(page, context, request, baseURL, width, {});await installPeopleMock(page);await page.goto("/app/projects/payments?tab=people");
  await expect(page.getByRole("heading", { name: "payments", level: 1 })).toBeVisible();await expect(page.getByRole("tab", { name: "Overview", selected: true })).toBeVisible();
  await expect(page.getByRole("tab", { name: "People" })).toHaveCount(0);await wait(page);expect(seen.routes).toEqual([]);expect(seen.chunks).toEqual([]);
 });
 test(`People at ${String(width)}: change a role, add a person and invite one; axe clean in both themes`, async ({ page, context, request, baseURL }) => {
  const seen = watch(page);await enter(page, context, request, baseURL, width, { "rovara.people": "v2" });const mock = await installPeopleMock(page);await page.goto("/app/projects/payments?tab=people");
  await expect(page.getByRole("tab", { name: "People", selected: true })).toBeVisible();
  // The positive control of the off test: with the switch on the same watcher does see the routes and the chunk.
  expect(seen.chunks.some(url => /ProjectPeopleTab/u.test(url))).toBe(true);expect(seen.routes.some(url => /\/people/u.test(url))).toBe(true);
  const priya = page.getByRole("row", { name: /Priya Rao/u });await expect(priya).toContainText("Collaborator");
  await expect(page.getByRole("heading", { name: "Collaborator approvals" })).toBeVisible();await expect(page.getByRole("heading", { name: "Merge rules" })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: `${shots}/people-light-${String(width)}.png`, fullPage: true });
  // Change Sam's role to collaborator.
  await page.getByRole("button", { name: "Change role for Sam Ortiz" }).click();
  await page.getByLabel("Role", { exact: true }).selectOption("collaborator");await expect(page.getByRole("dialog").getByText(/Reads the project's work, comments, asks Rovara/u)).toBeVisible();
  await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: `${shots}/people-change-dark-${String(width)}.png` });
  await page.getByRole("button", { name: "Save role" }).click();
  await expect(page.getByText("Sam Ortiz is now collaborator.")).toBeVisible();await expect(page.getByRole("row", { name: /Sam Ortiz/u })).toContainText("Collaborator");
  // Focus is back on the button that opened the dialog (WCAG 2.4.3); Escape does the same.
  await expect(page.getByRole("button", { name: "Change role for Sam Ortiz" })).toBeFocused();
  await page.getByRole("button", { name: "Change role for Sam Ortiz" }).click();await expect(page.getByRole("dialog")).toBeVisible();await page.keyboard.press("Escape");await expect(page.getByRole("button", { name: "Change role for Sam Ortiz" })).toBeFocused();
  const put = mock.sent.filter(item => item.method === "PUT" && item.path.endsWith("/people/" + PEOPLE.sam));expect(put).toHaveLength(1);expect(put[0]!.body).toMatchObject({ role: "collaborator", expectedRevision: 7 });
  // Add Ana as a viewer; the picker offers her and not Sam (already on the project).
  await page.getByRole("button", { name: "Add a person" }).click();
  const who = page.getByLabel("Person", { exact: true });await expect(who.locator("option", { hasText: "Ana Silva" })).toHaveCount(1);await expect(who.locator("option", { hasText: "Sam Ortiz" })).toHaveCount(0);
  await who.selectOption(PEOPLE.ana);await page.getByLabel("Role", { exact: true }).selectOption("viewer");await page.getByRole("button", { name: "Add to project" }).click();
  await expect(page.getByText("Ana Silva was added as viewer.")).toBeVisible();await expect(page.getByRole("row", { name: /Ana Silva/u })).toContainText("Viewer");await expect(page.getByRole("button", { name: "Add a person" })).toBeFocused();
  // Invite a colleague into the project.
  await page.getByRole("button", { name: "Invite into this project" }).click();
  await page.getByLabel("Colleague's email").fill("new.person@acme.com");await page.getByLabel("Project role").selectOption("contributor");
  await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: `${shots}/people-invite-light-${String(width)}.png` });
  await page.getByRole("button", { name: "Send invite" }).click();await expect(page.getByText("Invite created and emailed.")).toBeVisible();
  const invites = mock.sent.filter(item => item.path === "org/invites/reviewed");expect(invites).toHaveLength(1);expect(invites[0]!.body).toMatchObject({ role: "member", email: "new.person@acme.com", project: { name: "payments", role: "contributor" } });
  await page.getByRole("button", { name: "Done" }).click();await expect(page.getByRole("button", { name: "Invite into this project" })).toBeFocused();
  expect(await noSidewaysScroll(page)).toBe(true);await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: `${shots}/people-dark-${String(width)}.png`, fullPage: true });
 });
}
