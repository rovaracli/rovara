import { createHash } from "node:crypto";
import { expect, test, type Page, type Request } from "@playwright/test";
import { AdminPage, ROUTES } from "./pages/index.js";

// The Members page's role changes (guided onboarding PR 12a; design section 4, DEC 254l items 2 and 9) on the pretend Code. Priya signs in as the
// company owner. The pretend Code has no member routes, so the list and the role change are served here with `page.route` at Cloud's /v1/web paths
// (the Cloud route itself, proxying Code's, is covered by tests/unit/member-role-routes.test.ts).
const json = (body: unknown, status = 200) => ({ status, contentType: "application/json", body: JSON.stringify(body) });
const PRIYA = createHash("sha256").update("fake-code:priya").digest("hex");
const MAYA = "b".repeat(64), OLU = "c".repeat(64), ARI = "d".repeat(64);
const people = (mayaRole = "member") => ({ members: [
  { developerId: PRIYA, name: "Priya", role: "owner", identities: ["slack"], joinedAt: "2026-10-01T00:00:00Z" },
  { developerId: MAYA, name: "Maya", role: mayaRole, identities: ["github"], joinedAt: "2026-10-02T00:00:00Z" },
  { developerId: ARI, name: "Ari", role: "admin", identities: ["slack"], joinedAt: "2026-10-03T00:00:00Z" },
  { developerId: OLU, name: "Olu", role: "owner", identities: ["slack"], joinedAt: "2026-10-04T00:00:00Z" },
] });

async function serveMembers(page: Page, put: (request: Request) => { status: number; body: unknown }): Promise<{ puts: Request[] }> {
  const puts: Request[] = [];
  let mayaRole = "member";
  await page.route("**/v1/web/org/members", route => route.fulfill(json(people(mayaRole))));
  await page.route(`**/v1/web/org/members/${MAYA}/role`, route => {
    puts.push(route.request());
    const answer = put(route.request());
    if (answer.status === 200) mayaRole = (answer.body as { role: string }).role;
    return route.fulfill(json(answer.body, answer.status));
  });
  return { puts };
}

/** Opens the Members page (no step-up since owner DEC 254zzz73). */
async function openPeople(admin: AdminPage): Promise<void> {
  await admin.open(ROUTES.admin.people);
}

test("Members shows who can do what and only the role buttons the viewer may use; a change opens its review with no sign-in step", async ({ page }, testInfo) => {
  const { puts } = await serveMembers(page, () => ({ status: 500, body: {} }));
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.people);
  const who = admin.table("Who can do what");
  await expect(who).toContainText("make or change owners and disconnect GitHub, Slack or Linear");
  await expect(who).toContainText("make people members or admins");
  await expect(who).toContainText("Work in the projects they're in.");
  await expect(page.getByRole("button", { name: "Make Maya an admin" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Make Maya an owner" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Make Olu a member" })).toBeVisible();
  await expect(page.getByRole("button", { name: /^Make Priya/u })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("members-owner.png"), fullPage: true });
  await page.getByRole("button", { name: "Make Maya an admin" }).click();
  await expect(admin.freshSignIn).toHaveCount(0);
  await expect(page.getByRole("button", { name: "Confirm role change" })).toBeVisible();
  await page.screenshot({ path: testInfo.outputPath("role-change-review.png"), fullPage: true });
  expect(puts).toHaveLength(0);
});

test("Make admin sends the role and verifies it against the list", async ({ page }, testInfo) => {
  const { puts } = await serveMembers(page, () => ({ status: 200, body: { developerId: MAYA, role: "admin" } }));
  const admin = new AdminPage(page);
  await openPeople(admin);
  await page.getByRole("button", { name: "Make Maya an admin" }).click();
  await expect(page.getByText("New role: Admin")).toBeVisible();
  await page.getByRole("button", { name: "Confirm role change" }).click();
  await expect(page.getByText("Company role verified: Admin.", { exact: true })).toBeVisible();
  expect(puts).toHaveLength(1);
  const body = puts[0]!.postDataJSON() as Record<string, unknown>;
  expect(Object.keys(body).sort()).toEqual(["expectedRole", "requestId", "role"]);
  expect(body).toMatchObject({ role: "admin", expectedRole: "member" });
  await page.screenshot({ path: testInfo.outputPath("role-change-verified.png"), fullPage: true });
});

test("refusals are fixed sentences: the last owner", async ({ page }, testInfo) => {
  const answer = { status: 409, body: { error: { code: "LAST_OWNER", message: "server words never shown" } } };
  await serveMembers(page, () => answer);
  const admin = new AdminPage(page);
  await openPeople(admin);
  await page.getByRole("button", { name: "Make Maya an admin" }).click();
  await page.getByRole("button", { name: "Confirm role change" }).click();
  await expect(page.getByText("You're the only owner; add another owner first")).toBeVisible();
  await expect(page.getByText("server words never shown")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("role-change-last-owner.png"), fullPage: true });
  await expect(admin.freshSignIn).toHaveCount(0);
});

test("an open role dialog and its refusal survive a narrow window, a focus and a visibility change (nothing is unmounted)", async ({ page }) => {
  await serveMembers(page, () => ({ status: 409, body: { error: { code: "LAST_OWNER", message: "server words never shown" } } }));
  const admin = new AdminPage(page);
  await openPeople(admin);
  await page.getByRole("button", { name: "Make Maya an admin" }).click();
  await expect(page.getByText("New role: Admin")).toBeVisible();
  await page.getByRole("button", { name: "Confirm role change" }).click();
  await expect(page.getByText("You're the only owner; add another owner first")).toBeVisible();
  await page.evaluate(() => { document.querySelector('[role="dialog"]')?.setAttribute("data-mark", "same"); });
  await page.setViewportSize({ width: 600, height: 720 });
  await expect(page.getByTestId("admin-narrow")).toBeVisible();
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.evaluate(() => { window.dispatchEvent(new Event("focus")); document.dispatchEvent(new Event("visibilitychange")); });
  await page.waitForTimeout(500);
  await expect(page.locator('[role="dialog"][data-mark="same"]')).toBeVisible();
  await expect(page.getByText("You're the only owner; add another owner first")).toBeVisible();
  await page.getByRole("button", { name: "Close dialog" }).click();
});

test("Roles explained shows the same who-can-do-what table", async ({ page }) => {
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.people + "/roles");
  await expect(admin.table("Who can do what")).toContainText("Owner");
});
