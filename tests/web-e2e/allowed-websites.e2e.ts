import { test, expect } from "./support/csp.js";
import { activate } from "./support/keyboard.js";
import { evidenceShot } from "./support/screenshot.js";
import { checkA11y } from "./support/axe.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
test.beforeEach(async ({ context, request, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
});
test("B33 website proposal retains its UUID across reload with status-only recovery", async ({ page, request }, testInfo) => {
 await page.goto("/app/admin/projects/payments");await activate(page.getByRole("button", { name: "Edit allowed websites", exact: true }));
 await page.getByRole("textbox", { name: "Allowed websites, one hostname per line" }).fill("xn--bcher-kva.acme.dev");
 await activate(page.getByRole("button", { name: "Review website change", exact: true }));await expect(page.getByText("Add: xn--bcher-kva.acme.dev", { exact: true })).toBeVisible();
 await activate(page.getByRole("button", { name: "Propose website additions", exact: true }));await expect(page.getByText(/Proposal retained/)).toBeVisible();
 await page.reload();await activate(page.getByRole("button", { name: "Edit allowed websites", exact: true }));
 await expect(page.getByText(/A saved request is available/)).toBeVisible();await activate(page.getByRole("button", { name: "Check request status", exact: true }));await expect(page.getByText(/Proposal retained/)).toBeVisible();
 const requests = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string }>;
 expect(requests.filter(r => r.method === "POST" && r.path.endsWith("/allowed-websites/proposals"))).toHaveLength(1);
 await checkA11y(page, { theme: "light" });await evidenceShot(page, { path: testInfo.outputPath("b33-proposal.png"), fullPage: true });
});
test("B33 proposer reviews cancellation and sends it once", async ({ page, request }) => {
 await page.goto("/app/admin/projects/payments");await activate(page.getByRole("button", { name: "Edit allowed websites", exact: true }));
 await page.getByRole("textbox", { name: "Allowed websites, one hostname per line" }).fill("docs.acme.dev");await activate(page.getByRole("button", { name: "Review website change", exact: true }));await activate(page.getByRole("button", { name: "Propose website additions", exact: true }));await expect(page.getByText(/Proposal retained/)).toBeVisible();
 await activate(page.getByRole("button", { name: "Refresh canonical website settings", exact: true }));await activate(page.getByRole("button", { name: "Review proposal cancellation", exact: true }));
 await expect(page.getByText(/Review cancellation of this proposal/)).toBeVisible();await activate(page.getByRole("button", { name: "Cancel reviewed proposal", exact: true }));await expect(page.getByText(/Receipt confirmed/)).toBeVisible();
 const requests = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string }>;
 expect(requests.filter(r => r.method === "POST" && /\/allowed-websites\/proposals\/[^/]+\/cancel$/.test(r.path))).toHaveLength(1);
 await checkA11y(page, { theme: "light" });
});
test("B33 audited sole-owner approval stays staff-pending and direct removal refreshes canonical focus", async ({ page, request }) => {
 await page.goto("/app/admin/projects/payments");await activate(page.getByRole("button", { name: "Edit allowed websites", exact: true }));
 const list = page.getByRole("textbox", { name: "Allowed websites, one hostname per line" });await list.fill("docs.acme.dev");await activate(page.getByRole("button", { name: "Review website change", exact: true }));await activate(page.getByRole("button", { name: "Propose website additions", exact: true }));await expect(page.getByText(/Proposal retained/)).toBeVisible();
 await activate(page.getByRole("button", { name: "Refresh canonical website settings", exact: true }));await expect(page.getByRole("button", { name: "Review sole-owner exception", exact: true })).toBeDisabled();
 await page.getByRole("checkbox", { name: /sole company owner/ }).check();await activate(page.getByRole("button", { name: "Review sole-owner exception", exact: true }));await activate(page.getByRole("button", { name: "Approve reviewed proposal", exact: true }));await expect(page.getByText(/Receipt confirmed/)).toBeVisible();
 await activate(page.getByRole("button", { name: "Refresh canonical website settings", exact: true }));await expect(page.getByRole("heading", { name: "Current project websites", exact: true })).toBeFocused();await expect(page.getByText("docs.acme.dev · staff pending", { exact: true })).toBeVisible();
 await list.fill("");await activate(page.getByRole("button", { name: "Review website change", exact: true }));await activate(page.getByRole("button", { name: "Save website removal", exact: true }));await expect(page.getByText(/Earlier request applied at revision 3/)).toBeVisible();
 await activate(page.getByRole("button", { name: "Refresh canonical website settings", exact: true }));await expect(page.getByRole("heading", { name: "Current project websites", exact: true })).toBeFocused();await expect(page.getByText("docs.acme.dev · staff pending", { exact: true })).toHaveCount(0);
 const evidence = await (await request.get("/__mock/admin-evidence")).json() as { audit: { action: string; facts?: { mode?: string } }[] };
 expect(evidence.audit.filter(event => event.action === "project.allowed_domains_changed").map(event => event.facts?.mode)).toEqual(["sole_owner_exception", "direct_narrowing"]);await checkA11y(page, { theme: "light" });
});
