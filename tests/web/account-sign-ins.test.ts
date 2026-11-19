// @vitest-environment jsdom
// "Connected sign-ins" on Your account (DEC 254w): the person's sign-in methods (the first one marked and never removable), Connect for each linkable method not yet
// connected, Unlink for a connected one (no step-up in front of either since owner DEC 254zzz73), "not connected yet" while Code serves no such route, and fixed words for what a link
// return says. Removing one ends every sign-in, and the page says so.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { linkNotice, readLinkStart, readMySignIns } from "../../packages/ui/src/api/sign-ins.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const NOT_ON_CODE = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } };
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const github = { signIns: [{ method: "github", primary: true }], linkable: ["slack", "github"] };
const slackFirst = { signIns: [{ method: "slack", primary: true }], linkable: ["slack", "github"] };
const both = { signIns: [{ method: "github", primary: true }, { method: "slack", primary: false, linkedAt: "2026-11-10T00:00:00Z" }], linkable: ["slack", "github"] };
const seeded = new Map<string, string>();
beforeEach(() => { seeded.clear(); });

function mount(path: string, respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>) {
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : respond(r)));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 for (const [key, value] of seeded) f.storage.set(key, value);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, router, query, close: () => { view.unmount(); router.dispose(); query.clear(); cleanup(); } };
}
const writes = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET");

describe("Connected sign-ins readers", () => {
 it("reads only methods that are the right shape, and a provider address that is https on the method's own host", () => {
  expect(readMySignIns({ signIns: [{ method: "slack", primary: false, linkedAt: "2026-11-10T00:00:00Z" }, { method: "<b>", primary: true }, { method: "github", primary: "y" }, 7, { method: "github", primary: true, linkedAt: "soon" }] }))
   .toEqual({ signIns: [{ method: "slack", primary: false, linkedAt: "2026-11-10T00:00:00Z" }, { method: "github", primary: true }] });
  expect(() => readMySignIns({})).toThrow();
  expect(readLinkStart({ authorizeUrl: "https://slack.com/openid/connect/authorize?state=x" }, "slack").authorizeUrl).toBe("https://slack.com/openid/connect/authorize?state=x");
  for (const bad of ["https://evil.example/x", "http://slack.com/x", "https://slack.com.evil.example/x", "https://github.com/x", "javascript:alert(1)", 4]) expect(() => readLinkStart({ authorizeUrl: bad }, "slack")).toThrow();
 });
 it("says one fixed sentence per landing word and nothing for any other", () => {
  expect(linkNotice("slack", null)?.text).toBe("Slack is connected. You can now sign in with it too.");
  expect(linkNotice(null, "cancelled")?.tone).toBe("bad");
  expect(linkNotice(null, "refused")?.text).toBe("That sign-in can't be connected to your account.");
  expect(linkNotice(null, "failed")?.text).toBe("That sign-in couldn't be connected. Try again.");
  for (const word of ["toString", "<script>", "", "constructor"]) { expect(linkNotice(word, null)).toBeUndefined(); expect(linkNotice(null, word)).toBeUndefined(); }
 });
});

describe("Connected sign-ins section", () => {
 it("says not connected yet while Code serves no such route", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/sign-ins" ? NOT_ON_CODE : ok({})));
  try { await screen.findByRole("heading", { name: "Your account" }); await waitFor(() => expect(screen.getAllByTestId("not-connected").length).toBeGreaterThan(0)); expect(screen.queryByRole("button", { name: /^Connect / })).toBeNull(); } finally { f.close(); }
 });
 it("lists the methods, marks the first, gives it no Unlink, and offers Connect only for the linkable methods not yet connected", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/sign-ins" ? ok(github) : ok({})));
  try {
   const list = await screen.findByRole("list", { name: "Your sign-in methods" });
   expect(within(list).getByText("GitHub").parentElement!.textContent).toContain("how you first signed in");
   expect(within(list).queryByRole("button", { name: /Unlink/ })).toBeNull();
   expect(screen.getByRole("button", { name: "Connect Slack" })).toBeTruthy();
   expect(screen.queryByRole("button", { name: "Connect GitHub" })).toBeNull();
  } finally { f.close(); }
 });
 it("offers Unlink for a connected method and Connect only for the one still missing", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/sign-ins" ? ok(both) : ok({})));
  try {
   const list = await screen.findByRole("list", { name: "Your sign-in methods" });
   expect(within(list).getAllByRole("button")).toHaveLength(1);
   expect(within(list).getByRole("button", { name: "Unlink Slack" })).toBeTruthy();
   expect(screen.queryByRole("button", { name: /^Connect / })).toBeNull();
  } finally { f.close(); }
 });
 it("offers Connect only for the method still missing when the first is Slack", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/sign-ins" ? ok(slackFirst) : ok({})));
  try {
   await screen.findByRole("list", { name: "Your sign-in methods" });
   expect(screen.queryByRole("button", { name: "Connect Slack" })).toBeNull();
   expect(screen.getByRole("button", { name: "Connect GitHub" })).toBeTruthy();
  } finally { f.close(); }
 });
 it("offers Continue straight away (no step-up), and writes nothing until it is pressed", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/sign-ins" ? ok(github) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Connect Slack" }));
   const dialog = await screen.findByRole("dialog", { name: "Connect Slack?" });
   expect(within(dialog).queryByTestId("fresh-sign-in")).toBeNull();
   expect(within(dialog).getByRole("button", { name: "Continue to Slack" })).toBeTruthy();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("starts the connect and sends the browser to the provider's address", async () => {
  const f = mount("/app/account?connect=slack", r => (r.method === "POST" && r.path === "/v1/app/me/sign-ins/link" ? ok({ authorizeUrl: "https://slack.com/openid/connect/authorize?state=lnk_x" }) : r.path === "/v1/app/me/sign-ins" ? ok(github) : ok({})));
  const navigate = vi.spyOn(f.host, "navigate");
  try {
   const dialog = await screen.findByRole("dialog", { name: "Connect Slack?" });
   fireEvent.click(within(dialog).getByRole("button", { name: "Continue to Slack" }));
   await waitFor(() => expect(navigate).toHaveBeenCalledWith("https://slack.com/openid/connect/authorize?state=lnk_x"));
   expect(writes(f)).toEqual([expect.objectContaining({ method: "POST", path: "/v1/app/me/sign-ins/link", body: { method: "slack" } })]);
  } finally { f.close(); }
 });
 it("does not go anywhere when the answer is not the method's own provider page", async () => {
  const f = mount("/app/account?connect=slack", r => (r.method === "POST" ? ok({ authorizeUrl: "https://evil.example/x" }) : r.path === "/v1/app/me/sign-ins" ? ok(github) : ok({})));
  const navigate = vi.spyOn(f.host, "navigate");
  try {
   const dialog = await screen.findByRole("dialog", { name: "Connect Slack?" });
   fireEvent.click(within(dialog).getByRole("button", { name: "Continue to Slack" }));
   await within(dialog).findByRole("alert");
   expect(navigate).not.toHaveBeenCalled();
  } finally { f.close(); }
 });
 it("shows Cloud's refusal in its own words, with no step-up to go back to", async () => {
  const f = mount("/app/account?connect=slack", r => (r.method === "POST" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "That sign-in can't be connected to your account." } } } : r.path === "/v1/app/me/sign-ins" ? ok(github) : ok({})));
  try {
   const dialog = await screen.findByRole("dialog", { name: "Connect Slack?" });
   fireEvent.click(within(dialog).getByRole("button", { name: "Continue to Slack" }));
   expect((await within(dialog).findByRole("alert")).textContent).toContain("That sign-in can't be connected to your account.");
   expect(within(dialog).queryByTestId("fresh-sign-in")).toBeNull();
   expect(f.host.signIn).not.toHaveBeenCalled();
  } finally { f.close(); }
 });
 it("offers Unlink straight away (no step-up) and writes nothing until it is pressed", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/sign-ins" ? ok(both) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Unlink Slack" }));
   const dialog = await screen.findByRole("dialog", { name: "Unlink Slack?" });
   expect(within(dialog).queryByTestId("fresh-sign-in")).toBeNull();
   expect(within(dialog).getByRole("button", { name: "Unlink Slack" })).toBeTruthy();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("unlinks, says every sign-in ended, and offers to sign in again without asking the server more", async () => {
  const f = mount("/app/account?unlink=slack", r => (r.method === "DELETE" ? ok({ removed: true }) : r.path === "/v1/app/me/sign-ins" ? ok(both) : ok({})));
  try {
   const dialog = await screen.findByRole("dialog", { name: "Unlink Slack?" });
   fireEvent.click(within(dialog).getByRole("button", { name: "Unlink Slack" }));
   const notice = await screen.findByTestId("unlinked-notice");
   expect(notice.textContent).toContain("every sign-in of yours has ended");
   expect(writes(f)).toEqual([expect.objectContaining({ method: "DELETE", path: "/v1/app/me/sign-ins/slack" })]);
   const reads = f.request.mock.calls.filter(([r]) => r.path === "/v1/app/me/sign-ins").length;
   // The dialog closes asynchronously and hides the rest of the page from the accessibility tree until it has: wait for it, then find the button.
   await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
   fireEvent.click(await within(notice).findByRole("button", { name: "Sign in again" }));
   expect(vi.mocked(f.host.signIn)).toHaveBeenCalledWith("/app/live");
   expect(f.request.mock.calls.filter(([r]) => r.path === "/v1/app/me/sign-ins").length).toBe(reads);
   expect(screen.queryByRole("button", { name: /Unlink|Connect/ })).toBeNull();
  } finally { f.close(); }
 });
 it("says Code's first-method refusal in Cloud's words and keeps the list", async () => {
  const f = mount("/app/account?unlink=slack", r => (r.method === "DELETE" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "This is the first way this person signs in, so it can't be removed." } } } : r.path === "/v1/app/me/sign-ins" ? ok(both) : ok({})));
  try {
   const dialog = await screen.findByRole("dialog", { name: "Unlink Slack?" });
   fireEvent.click(within(dialog).getByRole("button", { name: "Unlink Slack" }));
   expect((await within(dialog).findByRole("alert")).textContent).toContain("first way this person signs in");
   expect(screen.queryByTestId("unlinked-notice")).toBeNull();
  } finally { f.close(); }
 });
 it("shows a fixed sentence for each link return and cleans the address", async () => {
  for (const [path, text] of [["/app/account?linked=slack", "Slack is connected. You can now sign in with it too."], ["/app/account?link=cancelled", "Connecting that sign-in was cancelled. Nothing changed."], ["/app/account?link=refused", "That sign-in can't be connected to your account."], ["/app/account?link=failed", "That sign-in couldn't be connected. Try again."]] as const) {
   const f = mount(path, r => (r.path === "/v1/app/me/sign-ins" ? ok(both) : ok({})));
   try { expect((await screen.findByTestId("link-notice")).textContent).toBe(text); await waitFor(() => expect(f.router.state.location.search).toBe("")); } finally { f.close(); }
  }
  const f = mount("/app/account?linked=%3Cscript%3E&link=toString", r => (r.path === "/v1/app/me/sign-ins" ? ok(both) : ok({})));
  try { await screen.findByRole("list", { name: "Your sign-in methods" }); expect(screen.queryByTestId("link-notice")).toBeNull(); } finally { f.close(); }
 });
 it("has no accessibility violations", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/sign-ins" ? ok(both) : ok({})));
  try { await screen.findByRole("list", { name: "Your sign-in methods" }); await expectNoAxeViolations(f.container); } finally { f.close(); }
 });
});
