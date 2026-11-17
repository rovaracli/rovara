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

/** Coming back from Code's step-up page: the nonce this tab stored, in the return address (as admin.spec.ts does). */
async function openConfirmed(admin: AdminPage, page: Page): Promise<void> {
  await admin.open(ROUTES.admin.people);
  await page.evaluate(() => window.localStorage.setItem("rovara.stepup.nonce", JSON.stringify({ nonce: "e2e-roles", at: Date.now() })));
  await admin.open(`${ROUTES.admin.people}?confirmed=e2e-roles`);
}

test("Members shows who can do what and only the role buttons the viewer may use; a change asks to confirm it's you first", async ({ page }, testInfo) => {
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
  await expect(admin.freshSignIn).toHaveAttribute("data-state", "ask");
  await expect(page.getByRole("button", { name: "Confirm role change" })).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("role-change-confirm-first.png"), fullPage: true });
  const asked = page.waitForRequest(request => request.url().includes("/v1/auth/browser/authorize") && request.url().includes("step_up=1"));
  await page.getByTestId("fresh-sign-in-start").click();
  expect(decodeURIComponent((await asked).url())).toMatch(/return_to=\/app\/admin\/people\?confirmed=[0-9a-f-]{36}/u);
  expect(puts).toHaveLength(0);
});

test("after confirming, Make admin sends the role and verifies it against the list", async ({ page }, testInfo) => {
  const { puts } = await serveMembers(page, () => ({ status: 200, body: { developerId: MAYA, role: "admin" } }));
  const admin = new AdminPage(page);
  await openConfirmed(admin, page);
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

test("refusals are fixed sentences: the last owner, and a confirmation that is too old", async ({ page }, testInfo) => {
  let answer = { status: 409, body: { error: { code: "LAST_OWNER", message: "server words never shown" } } };
  await serveMembers(page, () => answer);
  const admin = new AdminPage(page);
  await openConfirmed(admin, page);
  await page.getByRole("button", { name: "Make Maya an admin" }).click();
  await page.getByRole("button", { name: "Confirm role change" }).click();
  await expect(page.getByText("A company needs at least one owner. Make someone else an owner first.")).toBeVisible();
  await expect(page.getByText("server words never shown")).toHaveCount(0);
  await page.screenshot({ path: testInfo.outputPath("role-change-last-owner.png"), fullPage: true });
  await page.getByRole("button", { name: "Close dialog" }).click();
  answer = { status: 403, body: { error: { code: "REAUTH_REQUIRED", message: "server words never shown" } } };
  await page.getByRole("button", { name: "Make Maya an admin" }).click();
  await page.getByRole("button", { name: "Confirm role change" }).click();
  await expect(admin.freshSignIn).toHaveAttribute("data-state", "needed");
  await page.screenshot({ path: testInfo.outputPath("role-change-confirm-again.png"), fullPage: true });
});

test("Roles explained shows the same who-can-do-what table", async ({ page }) => {
  const admin = new AdminPage(page);
  await admin.open(ROUTES.admin.people + "/roles");
  await expect(admin.table("Who can do what")).toContainText("Owner");
});
