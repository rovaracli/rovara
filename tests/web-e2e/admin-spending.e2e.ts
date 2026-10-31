import { test, expect } from "./support/csp.js";
import { activate } from "./support/keyboard.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
test.beforeEach(async ({ context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });await request.post("/__mock/m47-task-stops");
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
});
test("reviews and applies an exact task stop through real cookie and transactional routes", async ({ page, request }) => {
 await page.goto("/app/admin/money/budgets");await expect(page.getByRole("table", { name: "Monthly base budgets" })).toBeVisible();
 await activate(page.getByRole("button", { name: "Load company task stop" }));await expect(page.getByLabel("Task stop amount (USD)")).toHaveValue("2");
 await page.getByLabel("Task stop amount (USD)").fill("1.234567");await activate(page.getByRole("button", { name: "Review task stop change" }));
 await expect(page.getByText("New task stop: $1.234567.", { exact: true })).toBeVisible();
 await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: "/private/tmp/rovara-m47-spending-review-light.png", fullPage: true });
 await checkA11y(page, { theme: "dark" });await evidenceShot(page, { path: "/private/tmp/rovara-m47-spending-review-dark.png", fullPage: true });
 await activate(page.getByRole("button", { name: "Apply tightening" }));await expect(page.getByText(/Task stop change applied/)).toBeVisible();await expect(page.getByText("Current task stop: $1.234567. Revision 2.")).toBeVisible();
 const calls = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string }>;
 expect(calls.filter(row => row.method === "PUT" && row.path === "/v1/web/org/task-stop-policy")).toHaveLength(1);
 const evidence = await (await request.get("/__mock/admin-evidence")).json() as { audit: Array<{ action: string }> };expect(evidence.audit.some(event => event.action === "spending.policy_changed")).toBe(true);
});
test("requests a loosening without changing current policy and refuses role loss", async ({ page, request }) => {
 await page.goto("/app/admin/money/budgets");await activate(page.getByRole("button", { name: "Load company task stop" }));await page.getByLabel("Task stop policy").selectOption("rovara_estimate");await activate(page.getByRole("button", { name: "Review task stop change" }));await activate(page.getByRole("button", { name: "Request loosening" }));
 await expect(page.getByText(/Task stop change requested/)).toBeVisible();await expect(page.getByText("Current task stop: $2.00. Revision 1.")).toBeVisible();await expect(page.getByRole("button", { name: "Approve original task stop change" })).toHaveCount(0);
 await request.post("/__mock/admin-role");await activate(page.getByRole("button", { name: "Cancel my task stop request" }));await expect(page.getByRole("alert")).toContainText("Couldn't confirm current Spending settings");
 const evidence = await (await request.get("/__mock/admin-evidence")).json() as { audit: Array<{ action: string }> };expect(evidence.audit.filter(event => event.action === "spending.policy_change_requested")).toHaveLength(1);expect(evidence.audit.filter(event => event.action === "spending.policy_change_decided")).toHaveLength(0);
});
test("edits the selected project's exact stop through the same live source fence", async ({ page }) => {
 await page.goto("/app/admin/money/budgets");await page.getByLabel("Project name for task stop").fill("payments");await activate(page.getByRole("button", { name: "Load project task stop" }));await expect(page.getByLabel("Task stop amount (USD)")).toHaveValue("2");
 await page.getByLabel("Task stop amount (USD)").fill("0.000001");await activate(page.getByRole("button", { name: "Review task stop change" }));await expect(page.getByText("New task stop: $0.000001.", { exact: true })).toBeVisible();await activate(page.getByRole("button", { name: "Apply tightening" }));await expect(page.getByText("Current task stop: $0.000001. Revision 2.")).toBeVisible();
});
