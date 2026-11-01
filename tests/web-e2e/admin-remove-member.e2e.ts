import type { APIRequestContext } from "@playwright/test";
import { test, expect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Member removal (v1.1): the People screen's "Remove from company", through the real broker routes over the admin fixture table.
test.beforeEach(async ({ context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
});
const writes = async (request: APIRequestContext) => (await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string }>).filter(row => row.method === "POST" && row.path.endsWith("/removal"));
test("previews a removal, lets the owner choose who takes over, sends it once and shows the receipt", async ({ page, request }) => {
 await request.post("/__mock/admin-add-member", { data: { name: "Cal" } });
 await page.goto("/app/admin/people");
 await page.getByRole("button", { name: "Remove Maya from company" }).click();
 const dialog = page.getByRole("dialog", { name: "Remove from company" });
 await expect(dialog.getByText("Goes to Priya")).toBeVisible();
 await expect(dialog.getByText("Ends now")).toBeVisible();
 await expect(dialog.getByText(/You'll need to reassign/)).toBeVisible();
 await dialog.getByRole("combobox", { name: "Who takes over?" }).selectOption({ label: "Cal" });
 await expect(dialog.getByText("Goes to Cal")).toBeVisible();
 await dialog.evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished)); });
 await checkA11y(page, { theme: "light" });
 await checkA11y(page, { theme: "dark" });
 expect(await writes(request)).toHaveLength(0);
 await dialog.getByRole("button", { name: "Remove Maya" }).click();
 await expect(page.getByText(/running tasks will stop after their current step/)).toBeVisible();
 await expect(page.getByRole("cell", { name: "Maya", exact: true })).toHaveCount(0);
 expect(await writes(request)).toHaveLength(1);
});
test("an owner cannot remove themselves from the list, and the other rows offer the action", async ({ page, request }) => {
 await request.post("/__mock/admin-add-member", { data: { name: "Cal" } });
 await page.goto("/app/admin/people");
 await expect(page.getByRole("button", { name: "Remove Priya from company" })).toHaveCount(0);
 await expect(page.getByRole("button", { name: "Remove Maya from company" })).toBeVisible();
 await expect(page.getByRole("button", { name: "Remove Cal from company" })).toBeVisible();
});
