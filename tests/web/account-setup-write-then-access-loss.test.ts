// @vitest-environment jsdom
// G5 ship, F7 (TOP-REVIEW-FAILURES 14): after a SUCCESSFUL write, an access signal (401) on the re-read makes the page-level access-lost block say "Your change went through."
// (a sign-in unlink: "Sign-in removed. You've been signed out; sign in again with another method."), NEVER "Nothing was changed". Without any write, a plain read failure shows
// the neutral default "Rovara couldn't read this page." (never a false "Nothing was changed"). One test per write: revoke, GitHub unlink, Slack switch, Change name, sign-in unlink, Create key.
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema, ScriptTokenMetadataListSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { token, secret } from "./support/script-token-fixture.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const LOST: ApiResponse = { status: 401, body: { error: { code: "AUTH_REQUIRED", message: "Sign in again." } } };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const WENT = "Your change went through.", REMOVED = "Sign-in removed. You've been signed out; sign in again with another method.", NEUTRAL = "Rovara couldn't read this page.", FALSE_SAFE = "Nothing was changed";
const ME = "/v1/app/me", SIGN_INS = "/v1/app/me/sign-ins", GITHUB = "/v1/app/me/github", SLACK = "/v1/app/me/lessons-slack", KEYS = "/v1/app/script-tokens";
const keysAnswer = { ...ScriptTokenMetadataListSchema.parse({ tokens: [token] }), canCreate: true };
const created = { status: 201, body: { token: { ...token, tokenId: "stk_bbbbbbbbbbbbbbbbbbbb", name: "New key" }, secret } } as const;

/** Once a write has answered 200 (or from the start, `lostAtStart`), EVERY read answers 401 AUTH_REQUIRED: the session is gone. Unlinking a sign-in ends every session, so that is the normal path. */
function mount(path: string, options: { lostAtStart?: boolean; keepAccess?: boolean } = {}) {
 let lost = options.lostAtStart === true, other = false;
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: "owner", nameChosen: true }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const beta = AppMeResponseSchema.parse({ ...identity, org: { ...identity.org, orgId: "org_bbbbbbbbbbbbbbbbbbbb", name: "Beta" } });
 const f = fakeHost(async (r: ApiRequest) => {
  if (r.path === "/v1/app/nav") return ok(nav);
  if (r.method === "GET" && lost) return LOST;
  if (r.method === "GET") return r.path === ME ? ok(other ? beta : identity) : r.path === SIGN_INS ? ok({ signIns: [{ method: "github", primary: true }, { method: "slack", primary: false, linkedAt: "2026-11-10T00:00:00Z" }] })
   : r.path === GITHUB ? ok({ linked: true, login: "priya-dev", linkedAt: "2026-11-17T12:00:00Z" }) : r.path === SLACK ? ok({ optOut: false }) : r.path === KEYS ? ok(keysAnswer) : ok({});
  if (options.keepAccess !== true) lost = true; // the write itself is answered; every later read is refused
  if (r.method === "PUT" && r.path === "/v1/app/me/name") return ok({ name: "Priya R", nameChosen: true });
  if (r.method === "PUT" && r.path === SLACK) return ok({ optOut: true });
  if (r.method === "POST" && r.path === KEYS) return created;
  if (r.method === "POST") return ok({ token: { ...token, status: "revoked" } });
  return ok({ unlinked: true });
 });
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, router, query, switchCompany: (to = true) => { other = to; }, loseAccess: () => { lost = true; }, close: () => { view.unmount(); router.dispose(); query.clear(); cleanup(); } };
}
type Page = ReturnType<typeof mount>;
const writes = (f: Page) => f.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET");
const has = (text: string) => (document.body.textContent ?? "").includes(text);
/** The page-level access-lost block (the identity read's), once the session is gone; every G5 write has already succeeded when this is called. */
async function accessLostBlock(f: Page, code: string) {
 await f.query.invalidateQueries({ queryKey: ["g5-account-setup"] });
 await screen.findByText(code, { selector: "code" });
 return screen.getByRole("alert").closest("section") as HTMLElement;
}
const safeLine = (block: HTMLElement) => within(block).getByText("What is safe").nextElementSibling?.textContent;

describe("a successful write, then an access signal on the re-read", () => {
 it("Revoke: Your change went through.", async () => {
  const f = mount("/app/account/automation-keys");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
   fireEvent.click(within(await screen.findByRole("dialog", { name: "Revoke this automation key?" })).getByRole("button", { name: "Revoke key" }));
   await waitFor(() => expect(writes(f)).toHaveLength(1));
   expect(safeLine(await accessLostBlock(f, "AUTOMATION-KEYS-READ-FAILED"))).toBe(WENT);
   expect(has(FALSE_SAFE)).toBe(false);
  } finally { f.close(); }
 });
 it("GitHub unlink: Your change went through.", async () => {
  const f = mount("/app/account/github");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Disconnect your GitHub account" }));
   fireEvent.click(within(await screen.findByRole("dialog", { name: "Unlink your GitHub account?" })).getByRole("button", { name: "Unlink GitHub" }));
   await waitFor(() => expect(writes(f)).toEqual([expect.objectContaining({ method: "DELETE", path: GITHUB })]));
   expect(safeLine(await accessLostBlock(f, "PERSONAL-GITHUB-READ-FAILED"))).toBe(WENT);
   expect(has(FALSE_SAFE)).toBe(false);
  } finally { f.close(); }
 });
 it("Slack switch: Your change went through.", async () => {
  const f = mount("/app/account");
  try {
   fireEvent.click(await screen.findByRole("switch", { name: "Don't learn from my Slack messages" }));
   await waitFor(() => expect(writes(f)).toHaveLength(1));
   expect(safeLine(await accessLostBlock(f, "ACCOUNT-READ-FAILED"))).toBe(WENT);
   expect(has(FALSE_SAFE)).toBe(false);
  } finally { f.close(); }
 });
 it("Change name: Your change went through.", async () => {
  const f = mount("/app/account");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change name" }));
   const dialog = await screen.findByRole("dialog", { name: "Your name" });
   fireEvent.change(within(dialog).getByLabelText("Your name"), { target: { value: "Priya R" } });
   fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
   await waitFor(() => expect(writes(f)).toEqual([expect.objectContaining({ method: "PUT", path: "/v1/app/me/name" })]));
   expect(safeLine(await accessLostBlock(f, "ACCOUNT-READ-FAILED"))).toBe(WENT);
   expect(has(FALSE_SAFE)).toBe(false);
  } finally { f.close(); }
 });
 it("Sign-in unlink (the normal path: every session ends): Sign-in removed ... signed out, never Nothing was changed", async () => {
  const f = mount("/app/account");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Unlink Slack" }));
   fireEvent.click(within(await screen.findByRole("dialog", { name: "Unlink Slack?" })).getByRole("button", { name: "Unlink Slack" }));
   await waitFor(() => expect(writes(f)).toEqual([expect.objectContaining({ method: "DELETE", path: "/v1/app/me/sign-ins/slack" })]));
   expect(safeLine(await accessLostBlock(f, "ACCOUNT-READ-FAILED"))).toBe(REMOVED);
   expect(has(FALSE_SAFE)).toBe(false);
  } finally { f.close(); }
 });
 it("Create key: Your change went through.", async () => {
  const f = mount("/app/account/automation-keys");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Create automation key" }));
   const dialog = await screen.findByRole("dialog", { name: "Create automation key" });
   fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "New key" } });
   fireEvent.change(within(dialog).getByLabelText("Projects (one name per line)"), { target: { value: "api" } });
   fireEvent.click(within(dialog).getByRole("button", { name: "Create automation key" }));
   await waitFor(() => expect(writes(f)).toHaveLength(1));
   expect(safeLine(await accessLostBlock(f, "AUTOMATION-KEYS-READ-FAILED"))).toBe(WENT);
   expect(has(FALSE_SAFE)).toBe(false);
  } finally { f.close(); }
 });
});

describe("no write was made", () => {
 it("a plain read failure (401 on the first read) shows the neutral default, never Nothing was changed", async () => {
  for (const [path, code] of [["/app/account", "ACCOUNT-READ-FAILED"], ["/app/account/automation-keys", "AUTOMATION-KEYS-READ-FAILED"]] as const) {
   const f = mount(path, { lostAtStart: true });
   try {
    await screen.findByText(code, { selector: "code" });
    expect(safeLine(screen.getByRole("alert").closest("section") as HTMLElement)).toBe(NEUTRAL);
    expect(has(FALSE_SAFE)).toBe(false);
    expect(has(WENT)).toBe(false);
    expect(writes(f)).toHaveLength(0);
   } finally { f.close(); }
  }
 });
});

describe("F8: a remembered write belongs to the person and company that made it", () => {
 it("a revoke in Acme, a switch to Beta, then a 401: Beta says the neutral default, never Your change went through.", async () => {
  const f = mount("/app/account/automation-keys", { keepAccess: true });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
   fireEvent.click(within(await screen.findByRole("dialog", { name: "Revoke this automation key?" })).getByRole("button", { name: "Revoke key" }));
   await screen.findByTestId("key-revoked-notice");
   // Who you are now answers as another company (Beta); the page settles on Beta. Only then does access end.
   f.switchCompany();
   await f.query.invalidateQueries({ queryKey: ["g5-account-setup"] });
   await f.query.invalidateQueries({ queryKey: ["g5-account-setup"] });
   await waitFor(() => expect(has("Beta")).toBe(true));
   f.loseAccess();
   expect(has(WENT)).toBe(false);
   const block = await accessLostBlock(f, "AUTOMATION-KEYS-READ-FAILED");
   expect(safeLine(block)).toBe(NEUTRAL);
   expect(has(WENT)).toBe(false);
   expect(has(FALSE_SAFE)).toBe(false);
  } finally { f.close(); }
 });
 it("Acme, Beta, then back to Acme (same person and company as the write): a switch clears it, so the neutral default is said", async () => {
  const f = mount("/app/account/automation-keys", { keepAccess: true });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
   fireEvent.click(within(await screen.findByRole("dialog", { name: "Revoke this automation key?" })).getByRole("button", { name: "Revoke key" }));
   await screen.findByTestId("key-revoked-notice");
   f.switchCompany(true);
   await f.query.invalidateQueries({ queryKey: ["g5-account-setup"] }); await f.query.invalidateQueries({ queryKey: ["g5-account-setup"] });
   await waitFor(() => expect(has("Beta")).toBe(true));
   f.switchCompany(false);
   await f.query.invalidateQueries({ queryKey: ["g5-account-setup"] }); await f.query.invalidateQueries({ queryKey: ["g5-account-setup"] });
   await waitFor(() => expect(has("Beta")).toBe(false));
   f.loseAccess();
   expect(safeLine(await accessLostBlock(f, "AUTOMATION-KEYS-READ-FAILED"))).toBe(NEUTRAL);
   expect(has(WENT)).toBe(false);
  } finally { f.close(); }
 });
});
