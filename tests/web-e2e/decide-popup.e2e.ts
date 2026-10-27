import { test, expect } from "./support/csp.js";
// The app opens a confirmation page through its host (openExternal: window.open with "noopener,noreferrer"), so the page that asked cannot reach the page that decides.
// Both pages carry Cross-Origin-Opener-Policy: same-origin (the shell since 87cf6928f), and two same-origin pages with the same policy share a browsing context group, so a bare
// window.open of the confirmation page would no longer be severed by the policy alone: the product path is what keeps it apart, and this test drives that path (the Home
// card's button), not a hand-made window.open.
test("a confirmation popup severs its app opener and no decision is posted", async ({ page, request, context, baseURL }) => {
 await request.post("/__mock/scenario", { data: { name: "home" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.goto("/app");await expect(page.getByText("2 things need you")).toBeVisible();
 const popup = page.waitForEvent("popup");await page.getByRole("button", { name: "Review plan" }).click();
 const confirmation = await popup;await expect(confirmation.getByRole("button", { name: "Approve", exact: true })).toBeVisible();
 await expect(confirmation).toHaveURL(/\/v1\/app\/approve\/apr_/);
 // The confirmation page cannot reach the app that opened it, and the app holds no handle to the confirmation page.
 expect(await confirmation.evaluate(() => window.opener === null)).toBe(true);
 const response = await confirmation.reload();expect(response?.headers()["cross-origin-opener-policy"]).toBe("same-origin");
 const requests = await (await request.get("/__mock/requests")).json() as Array<{ method: string; path: string }>;
 expect(requests.filter(value => value.method === "POST" && value.path.startsWith("/v1/app/approve/"))).toEqual([]);await confirmation.close();
});
