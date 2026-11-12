import type { APIRequestContext, BrowserContext, Page } from "@playwright/test";
import { test, expect as baseExpect } from "./support/csp.js";
import { checkA11y } from "./support/axe.js";
import { evidenceShot } from "./support/screenshot.js";
import { FIXTURE_SESSION } from "../web/support/fixtures.js";
// Settings > Internal addresses (owner decision 123). Every answer is a fixture fed through page.route that follows packages/cloud-contracts/src/app-private-addresses.ts and the server's rules
// (packages/broker/src/org/private-addresses.ts): adding waits for a different admin, removing applies at once, a save names the revision it started from, an approval names the proposal it showed.
// ROVARA_PRIVATE_ADDRESSES_SHOTS names the folder for the pictures.
const expect = baseExpect.configure({ timeout: 15_000 });
const shots = process.env.ROVARA_PRIVATE_ADDRESSES_SHOTS ?? ".test-build/web-e2e/admin-private-addresses";
const ROUTE = /\/v1\/web\/org\/private-addresses(\?.*)?$/u;
const LONG = `${"n".repeat(40)}.${"m".repeat(43)}.example:8081`;
const D = (n: number) => String(n).repeat(64).slice(0, 64);
type Viewer = "first" | "second";
interface Pending { changeId: string; entries: string[]; added: string[]; removed: string[]; digest: string; by: Viewer }

/** A stateful stand-in for the server. `failGet` answers the read with 500 (a load failure), `off` with 404 (an install with no routed private network). */
function fakeServer(options: { entries?: string[]; pending?: Pending; unreadable?: boolean; reauth?: boolean; off?: boolean; failGet?: boolean } = {}) {
 const model = { revision: options.entries === undefined ? 0 : 1, entries: options.entries ?? [], pending: options.pending, viewer: "first" as Viewer, unreadable: options.unreadable === true, failGet: options.failGet === true };
 const state = () => ({
  revision: model.revision, entries: model.entries, digest: D(model.revision + 1), max: 16, openPorts: [443, 8081], canChange: true, ...(model.unreadable ? { unreadable: true } : {}),
  ...(model.pending === undefined ? {} : { pending: { changeId: model.pending.changeId, entries: model.pending.entries, digest: model.pending.digest, added: model.pending.added, removed: model.pending.removed, proposedByYou: model.pending.by === model.viewer, expiresAt: "2026-11-19T09:00:00.000Z" } }),
 });
 const posts: Array<Record<string, unknown>> = [];
 const refuse = (status: number, code: string, message: string) => ({ status, json: { error: { code, message } } });
 async function handle(page: Page) {
  await page.route(ROUTE, route => {
   if (options.off === true) return route.fulfill(refuse(404, "NOT_FOUND", "none"));
   if (route.request().method() === "GET") return model.failGet ? route.fulfill(refuse(500, "INTERNAL", "down")) : route.fulfill({ json: state() });
   const body = route.request().postDataJSON() as Record<string, unknown>;posts.push(body);
   if (body.action === "propose") {
    if (body.expectedRevision !== model.revision) return route.fulfill(refuse(409, "CHANGE_STALE", "The list changed meanwhile. Reload and try again."));
    const next = (body.entries as string[]).map(entry => entry.toLowerCase()).sort();
    const added = next.filter(entry => !model.entries.includes(entry)), removed = model.entries.filter(entry => !next.includes(entry));
    if (added.length === 0) { model.entries = next;model.revision += 1;model.unreadable = false;return route.fulfill({ json: { status: "applied", ...state() } }); }
    model.pending = { changeId: "chg_0123456789abcdef", entries: next, added, removed, digest: D(9), by: model.viewer };
    return route.fulfill({ status: 202, json: { status: "needs_approval", changeId: model.pending.changeId, ...state() } });
   }
   if (body.action === "approve") {
    if (options.reauth === true) return route.fulfill(refuse(403, "REAUTH_REQUIRED", "Sign in again to approve this. It needs a sign-in within the last 10 minutes."));
    if (model.pending === undefined || body.changeId !== model.pending.changeId || body.expectedDigest !== model.pending.digest) return route.fulfill(refuse(409, "CHANGE_STALE", "The proposal is not the list you were shown. Reload and check it again."));
    model.entries = model.pending.entries;model.pending = undefined;model.revision += 1;return route.fulfill({ json: { status: "applied", ...state() } });
   }
   model.pending = undefined;return route.fulfill({ json: { status: "withdrawn", ...state() } });
  });
 }
 return { model, posts, handle };
}
async function enter(page: Page, context: BrowserContext, request: APIRequestContext, baseURL: string | undefined, width: number, server: ReturnType<typeof fakeServer>) {
 await request.post("/__mock/scenario", { data: { name: "admin" } });
 await context.addCookies([{ name: "__Host-agentx_review_session", value: FIXTURE_SESSION, url: baseURL!, secure: true, httpOnly: true, sameSite: "Strict" }]);
 await server.handle(page);
 await page.emulateMedia({ reducedMotion: "reduce" });await page.clock.setFixedTime(new Date("2026-11-12T12:00:00Z"));await page.setViewportSize({ width, height: width < 800 ? 844 : 900 });
}
const noSidewaysScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth && document.body.scrollWidth <= innerWidth);
async function settled(page: Page) {
 await expect(page.getByRole("heading", { name: "Internal addresses", level: 1 })).toBeVisible();
 await expect(page.getByRole("progressbar")).toHaveCount(0);await page.waitForLoadState("networkidle");
}
const field = (page: Page) => page.getByLabel("One host:port per line");

test("an empty list: nothing allowed, the open ports, and an editor", async ({ page, context, request, baseURL }) => {
 const server = fakeServer();
 await enter(page, context, request, baseURL, 1280, server);await page.goto("/app/admin/private-addresses");await settled(page);
 await expect(page.getByText("None. Tasks reach no internal address.")).toBeVisible();
 await expect(page.getByText("Ports workers may open on this install: 443, 8081.")).toBeVisible();
 await expect(page.getByRole("group", { name: "Security and sign-in" }).getByRole("link", { name: "Internal addresses" })).toBeVisible();
 await expect(page.getByRole("button", { name: "Save" })).toBeDisabled();
 await evidenceShot(page, { path: `${shots}/empty-1280.png`, fullPage: true });
});

test("the current list with my own pending proposal: no approval for me, only Withdraw", async ({ page, context, request, baseURL }) => {
 const server = fakeServer({ entries: ["10.20.0.15:443"], pending: { changeId: "chg_0123456789abcdef", entries: ["10.20.0.15:443", "nexus.corp.example:8081"], added: ["nexus.corp.example:8081"], removed: [], digest: D(9), by: "first" } });
 await enter(page, context, request, baseURL, 1280, server);await page.goto("/app/admin/private-addresses");await settled(page);
 const waiting = page.getByRole("region", { name: "Waiting for a second owner or admin" });
 await expect(waiting).toContainText("You proposed this list.");
 await expect(waiting.getByRole("button", { name: "Review and approve" })).toHaveCount(0);
 await expect(waiting.getByRole("button", { name: "Withdraw" })).toBeVisible();
 await evidenceShot(page, { path: `${shots}/mine-pending-1280.png`, fullPage: true });
});

test("another admin's proposal: approved through the dialog, which sends the proposal it showed", async ({ page, context, request, baseURL }) => {
 const server = fakeServer({ entries: ["10.20.0.15:443"], pending: { changeId: "chg_0123456789abcdef", entries: ["10.20.0.15:443", "nexus.corp.example:8081"], added: ["nexus.corp.example:8081"], removed: [], digest: D(9), by: "second" } });
 await enter(page, context, request, baseURL, 1280, server);await page.goto("/app/admin/private-addresses");await settled(page);
 const opener = page.getByRole("button", { name: "Review and approve" });
 await opener.click();
 const dialog = page.getByRole("dialog", { name: "Approve this list?" });
 await expect(dialog.getByRole("list", { name: "Adds" })).toContainText("nexus.corp.example:8081");
 await checkA11y(page, { theme: "light" });
 await evidenceShot(page, { path: `${shots}/approve-dialog-1280.png`, fullPage: true });
 await dialog.getByRole("button", { name: "Approve this list" }).click();
 await expect(page.getByText(/^Approved\./u)).toBeVisible();
 await expect(page.getByRole("list", { name: "Allowed now" })).toContainText("nexus.corp.example:8081");
 expect(server.posts).toEqual([{ action: "approve", changeId: "chg_0123456789abcdef", expectedDigest: D(9) }]);
});

test("a save that removes an address confirms first, then names what it removed", async ({ page, context, request, baseURL }) => {
 const server = fakeServer({ entries: ["10.20.0.15:443", "10.20.0.16:443"] });
 await enter(page, context, request, baseURL, 1280, server);await page.goto("/app/admin/private-addresses");await settled(page);
 await field(page).fill("10.20.0.15:443");
 const save = page.getByRole("button", { name: "Save" });
 await save.click();
 const dialog = page.getByRole("dialog", { name: "Remove these addresses now?" });
 await expect(dialog).toContainText("Running workers restart now; a running task is interrupted and retried.");
 await expect(dialog.getByRole("list", { name: "Removes" })).toContainText("10.20.0.16:443");
 await evidenceShot(page, { path: `${shots}/remove-confirm-1280.png`, fullPage: true });
 await dialog.getByRole("button", { name: "Cancel" }).click();
 await expect(save).toBeFocused();
 expect(server.posts).toEqual([]);
 await save.click();await page.getByRole("dialog", { name: "Remove these addresses now?" }).getByRole("button", { name: "Remove and save" }).click();
 await expect(page.getByText(/^Saved\. Removed 10\.20\.0\.16:443: closed now/u)).toBeVisible();
 expect(server.posts).toEqual([{ action: "propose", expectedRevision: 1, entries: ["10.20.0.15:443"] }]);
});

test("stale on save: the draft is kept, the server's sentence shown, and Discard reloads", async ({ page, context, request, baseURL }) => {
 const server = fakeServer({ entries: ["10.20.0.15:443"] });
 await enter(page, context, request, baseURL, 1280, server);await page.goto("/app/admin/private-addresses");await settled(page);
 await field(page).fill("10.20.0.15:443\n10.20.0.17:443");
 // Another admin changes the list meanwhile.
 server.model.entries = [];server.model.revision = 2;
 await page.getByRole("button", { name: "Save" }).click();
 await expect(page.getByText("The list changed meanwhile. Reload and try again.")).toBeVisible();
 await expect(field(page)).toHaveValue("10.20.0.15:443\n10.20.0.17:443");
 expect(server.posts).toEqual([{ action: "propose", expectedRevision: 1, entries: ["10.20.0.15:443", "10.20.0.17:443"] }]);
 await evidenceShot(page, { path: `${shots}/stale-1280.png`, fullPage: true });
 await page.getByRole("button", { name: "Discard my changes and reload" }).click();
 await expect(field(page)).toHaveValue("");
 await expect(page.getByText("None. Tasks reach no internal address.")).toBeVisible();
});

test("REAUTH on approve offers Sign in again and does not redirect by itself", async ({ page, context, request, baseURL }) => {
 const server = fakeServer({ entries: [], reauth: true, pending: { changeId: "chg_0123456789abcdef", entries: ["10.20.0.15:443"], added: ["10.20.0.15:443"], removed: [], digest: D(9), by: "second" } });
 await enter(page, context, request, baseURL, 1280, server);await page.goto("/app/admin/private-addresses");await settled(page);
 await page.getByRole("button", { name: "Review and approve" }).click();
 await page.getByRole("dialog", { name: "Approve this list?" }).getByRole("button", { name: "Approve this list" }).click();
 await expect(page.getByText("Sign in again to approve this. It needs a sign-in within the last 10 minutes.")).toBeVisible();
 await expect(page.getByRole("button", { name: "Sign in again" })).toBeVisible();
 await page.waitForLoadState("networkidle");expect(new URL(page.url()).pathname).toBe("/app/admin/private-addresses");
});

test("an unreadable stored list says so", async ({ page, context, request, baseURL }) => {
 const server = fakeServer({ entries: [], unreadable: true });
 await enter(page, context, request, baseURL, 1280, server);await page.goto("/app/admin/private-addresses");await settled(page);
 await expect(page.getByRole("alert").first()).toContainText("The saved list can't be read");
 await evidenceShot(page, { path: `${shots}/unreadable-1280.png`, fullPage: true });
});

test("a load failure offers Try again, which reads again", async ({ page, context, request, baseURL }) => {
 const server = fakeServer({ entries: ["10.20.0.15:443"], failGet: true });
 await enter(page, context, request, baseURL, 1280, server);await page.goto("/app/admin/private-addresses");
 await expect(page.getByText("The list could not be read.")).toBeVisible();
 server.model.failGet = false;
 await page.getByRole("button", { name: "Try again" }).click();
 await settled(page);
 await expect(page.getByRole("list", { name: "Allowed now" })).toContainText("10.20.0.15:443");
});

test("an install with no routed private network (404) shows no link", async ({ page, context, request, baseURL }) => {
 const server = fakeServer({ off: true });
 await enter(page, context, request, baseURL, 1280, server);await page.goto("/app/admin");
 await expect(page.getByRole("group", { name: "Security and sign-in" }).getByRole("link", { name: "Audit" })).toBeVisible();
 await page.waitForLoadState("networkidle");
 await expect(page.getByRole("link", { name: "Internal addresses" })).toHaveCount(0);
});

for (const width of [390, 1280] as const) for (const theme of ["light", "dark"] as const) {
 test(`${String(width)} px, ${theme}: long names wrap, no sideways scroll, axe clean, with a pending proposal and a draft`, async ({ page, context, request, baseURL }) => {
  const server = fakeServer({ entries: ["10.20.0.15:443", LONG], pending: { changeId: "chg_0123456789abcdef", entries: ["10.20.0.15:443", LONG, `a${LONG}`], added: [`a${LONG}`], removed: [], digest: D(9), by: "second" } });
  await enter(page, context, request, baseURL, width, server);await page.goto("/app/admin/private-addresses");await settled(page);
  await field(page).fill(`10.20.0.15:443\n${LONG}\nb${LONG}`);
  expect(await noSidewaysScroll(page)).toBe(true);
  await checkA11y(page, { theme });
  await evidenceShot(page, { path: `${shots}/page-${String(width)}-${theme}.png`, fullPage: true });
  await page.getByRole("button", { name: "Review and approve" }).click();
  await expect(page.getByRole("dialog", { name: "Approve this list?" })).toBeVisible();
  expect(await noSidewaysScroll(page)).toBe(true);
  await checkA11y(page, { theme });
 });
}
