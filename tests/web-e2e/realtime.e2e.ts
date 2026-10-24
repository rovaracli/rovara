import { test, expect } from "./support/csp.js";
import { mockRealtime } from "./support/realtime.js";
test("the realtime harness delivers subscribed notices and drops connections", async ({ page, context, request, baseURL }) => {
 const realtime = await mockRealtime(page);await request.post("/__mock/scenario", { data: { name: "shell" } });await context.addCookies([{ name: "__Host-agentx_review_session", value: "11111111-1111-4111-8111-111111111111", url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await page.goto("/app");await expect(page.getByRole("heading", { name: "Home", exact: true })).toBeVisible();
 await page.evaluate(() => {
 window.__fixtureNotices = [];window.__fixtureClosed = false;
 const socket = new WebSocket("wss://localhost/event/realtime");
 socket.addEventListener("open", () => socket.send(JSON.stringify({ type: "connection_init" })));
 socket.addEventListener("message", event => { const frame = JSON.parse(String(event.data)) as { type: string; event?: string[] };if (frame.type === "connection_ack") socket.send(JSON.stringify({ type: "subscribe", id: "fixture-user", channel: "/fixture/user" }));else if (frame.type === "data") window.__fixtureNotices?.push(...(frame.event ?? [])); });
 socket.addEventListener("close", () => { window.__fixtureClosed = true; });
 });
 await expect.poll(() => realtime.connections()).toBe(1);await realtime.push({ type: "home.changed", revision: 2 });expect(await page.evaluate(() => window.__fixtureNotices)).toEqual([JSON.stringify({ type: "home.changed", revision: 2 })]);await realtime.drop();expect(await page.evaluate(() => window.__fixtureClosed)).toBe(true);
});
declare global { interface Window { __fixtureNotices?: string[]; __fixtureClosed?: boolean } }
