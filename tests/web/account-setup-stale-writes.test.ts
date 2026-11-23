// @vitest-environment jsdom
// G5 ship, F6 + sweep (DEC 254zzz324 "retained facts never grant write authority"): EVERY G5 write action is offered only on a FRESH read and refuses at send time on a
// stale one (a failed re-read that kept the last facts). Per action: fresh read -> one send; stale read -> the control is hidden AND a direct send attempt (from a dialog or form
// that was already open) is refused with zero sends. Also: the one Reconnecting line sits right under the page header, the same place G2's pages put it.
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
const FAILED: ApiResponse = { status: 503, body: { error: { code: "X", message: "x" } } };
const REFUSAL = "Can't tell yet: this page hasn't confirmed it is up to date. Nothing was changed.";
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

const ME = "/v1/app/me", SIGN_INS = "/v1/app/me/sign-ins", GITHUB = "/v1/app/me/github", SLACK = "/v1/app/me/lessons-slack", KEYS = "/v1/app/script-tokens";
const keysAnswer = { ...ScriptTokenMetadataListSchema.parse({ tokens: [token] }), canCreate: true };
const created = { status: 201, body: { token: { ...token, tokenId: "stk_bbbbbbbbbbbbbbbbbbbb", name: "New key" }, secret } } as const;
/** Sign-ins as Code serves them: GitHub is how the person signed in, Slack is connected (Unlink Slack) unless `slack: false` (Connect Slack). */
const signIns = (slack: boolean) => ({ signIns: [{ method: "github", primary: true }, ...(slack ? [{ method: "slack", primary: false, linkedAt: "2026-11-10T00:00:00Z" }] : [])] });

interface Scene { slack?: boolean; linked?: boolean }
function mount(path: string, scene: Scene = {}) {
 const failing = new Set<string>();
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: "owner", nameChosen: true }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async (r: ApiRequest) => {
  if (r.path === "/v1/app/nav") return ok(nav);
  if (r.method === "GET" && failing.has(r.path)) return FAILED;
  if (r.path === ME && r.method === "GET") return ok(identity);
  if (r.method === "PUT" && r.path === "/v1/app/me/name") return ok({ name: "Priya R", nameChosen: true });
  if (r.method === "PUT" && r.path === SLACK) return ok({ optOut: true });
  if (r.method === "POST" && r.path === "/v1/app/me/sign-ins/link") return ok({ authorizeUrl: "https://slack.com/openid/connect/authorize?state=x" });
  if (r.method === "POST" && r.path === "/v1/app/me/github/link") return ok({ authorizeUrl: "https://github.com/login/oauth/authorize?state=x" });
  if (r.method === "POST" && r.path === KEYS) return created;
  if (r.method === "POST") return ok({ token: { ...token, status: "revoked" } });
  if (r.method === "DELETE") return ok({ unlinked: true });
  if (r.path === SIGN_INS) return ok(signIns(scene.slack ?? true));
  if (r.path === GITHUB) return ok(scene.linked === false ? { linked: false } : { linked: true, login: "priya-dev", linkedAt: "2026-11-17T12:00:00Z" });
  if (r.path === SLACK) return ok({ optOut: false });
  if (r.path === KEYS) return ok(keysAnswer);
  return ok({});
 });
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 /** The path's last good read is kept and its next read fails (a 503): the page is now showing stale facts. */
 const goStale = async (readPath: string) => {
  failing.add(readPath);
  // The GitHub page reads its link under its own key ["account", "github"]; every other read carries its path in its key.
  await query.refetchQueries({ predicate: q => q.queryKey.includes(readPath) || (readPath === GITHUB && q.queryKey[0] === "account" && q.queryKey[1] === "github") });
  await screen.findByText(/Updated .+ · Reconnecting/);
 };
 return { ...f, ...view, router, query, goStale, close: () => { view.unmount(); router.dispose(); query.clear(); cleanup(); } };
}
type Page = ReturnType<typeof mount>;
const writes = (f: Page) => f.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET");
const has = (text: string) => (document.body.textContent ?? "").includes(text);
const settle = () => new Promise(resolve => setTimeout(resolve, 40));
const identityKey = (f: Page) => f.query.getQueryCache().findAll({ queryKey: ["g5-account-setup", ME], exact: true })[0]!.queryKey;

describe("Change name (AccountReadScreen ChangeName + NameForm)", () => {
 it("fresh: one PUT", async () => {
  const f = mount("/app/account");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change name" }));
   const dialog = await screen.findByRole("dialog", { name: "Your name" });
   fireEvent.change(within(dialog).getByLabelText("Your name"), { target: { value: "Priya R" } });
   fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
   await waitFor(() => expect(writes(f)).toHaveLength(1));
  } finally { f.close(); }
 });
 it("stale identity: the button is hidden", async () => {
  const f = mount("/app/account");
  try {
   await screen.findByRole("button", { name: "Change name" });
   await f.goStale(ME);
   expect(screen.queryByRole("button", { name: /^(Change name|Choose a name)$/ })).toBeNull();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("stale identity: a Save name already open is refused with zero sends and says why", async () => {
  const f = mount("/app/account");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change name" }));
   const dialog = await screen.findByRole("dialog", { name: "Your name" });
   fireEvent.change(within(dialog).getByLabelText("Your name"), { target: { value: "Priya R" } });
   await f.goStale(ME);
   fireEvent.click(within(screen.getByRole("dialog", { name: "Your name" })).getByRole("button", { name: "Save name" }));
   await settle();
   expect(writes(f)).toHaveLength(0);
   expect(has(REFUSAL)).toBe(true);
  } finally { f.close(); }
 });
});

describe("the Slack learning switch (SlackLearningSwitch)", () => {
 it("fresh: one PUT", async () => {
  const f = mount("/app/account");
  try {
   fireEvent.click(await screen.findByRole("switch", { name: "Don't learn from my Slack messages" }));
   await waitFor(() => expect(writes(f)).toHaveLength(1));
  } finally { f.close(); }
 });
 it("stale: the switch is hidden, the last saved value is still said, zero sends", async () => {
  const f = mount("/app/account");
  try {
   await screen.findByRole("switch", { name: "Don't learn from my Slack messages" });
   await f.goStale(SLACK);
   expect(screen.queryByRole("switch", { name: "Don't learn from my Slack messages" })).toBeNull();
   expect(screen.getByTestId("slack-learning-value").textContent).toBe("Off");
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("stale identity (who you are cannot be re-read): the switch is hidden too", async () => {
  const f = mount("/app/account");
  try {
   await screen.findByRole("switch", { name: "Don't learn from my Slack messages" });
   await f.goStale(ME);
   expect(screen.queryByRole("switch", { name: "Don't learn from my Slack messages" })).toBeNull();
  } finally { f.close(); }
 });
});

describe("Connect a sign-in (ConnectedSignIns)", () => {
 it("fresh: Continue to Slack sends one POST", async () => {
  const f = mount("/app/account", { slack: false });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Connect Slack" }));
   fireEvent.click(within(await screen.findByRole("dialog", { name: "Connect Slack?" })).getByRole("button", { name: "Continue to Slack" }));
   await waitFor(() => expect(writes(f)).toHaveLength(1));
  } finally { f.close(); }
 });
 it("stale: the Connect buttons are hidden", async () => {
  const f = mount("/app/account", { slack: false });
  try {
   await screen.findByRole("button", { name: "Connect Slack" });
   await f.goStale(SIGN_INS);
   expect(screen.queryByRole("button", { name: /^Connect (Slack|GitHub)$/ })).toBeNull();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("stale: a Continue to Slack already open is refused with zero sends", async () => {
  const f = mount("/app/account", { slack: false });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Connect Slack" }));
   await screen.findByRole("dialog", { name: "Connect Slack?" });
   await f.goStale(SIGN_INS);
   fireEvent.click(within(screen.getByRole("dialog", { name: "Connect Slack?" })).getByRole("button", { name: "Continue to Slack" }));
   await settle();
   expect(writes(f)).toHaveLength(0);
   expect(has(REFUSAL)).toBe(true);
  } finally { f.close(); }
 });
 it("no read yet (the list never answered): a deep-linked Continue to Slack is refused with zero sends", async () => {
  const f = mount("/app/account?connect=slack", { slack: false });
  try {
   // The sign-ins list is served only after this point; the dialog is open from the address already.
   const dialog = await screen.findByRole("dialog", { name: "Connect Slack?" });
   f.query.getQueryCache().findAll({ predicate: q => q.queryKey.includes(SIGN_INS) }).forEach(q => { q.setState({ ...q.state, data: undefined, dataUpdatedAt: 0, status: "pending", fetchStatus: "idle" }); });
   fireEvent.click(within(dialog).getByRole("button", { name: "Continue to Slack" }));
   await settle();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
});

describe("Unlink a sign-in (ConnectedSignIns)", () => {
 it("fresh: Unlink Slack sends one DELETE", async () => {
  const f = mount("/app/account");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Unlink Slack" }));
   fireEvent.click(within(await screen.findByRole("dialog", { name: "Unlink Slack?" })).getByRole("button", { name: "Unlink Slack" }));
   await waitFor(() => expect(writes(f)).toEqual([expect.objectContaining({ method: "DELETE", path: "/v1/app/me/sign-ins/slack" })]));
  } finally { f.close(); }
 });
 it("F6 (PROBE-E1): a 503 re-read shows Reconnecting and NO Unlink button", async () => {
  const f = mount("/app/account");
  try {
   await screen.findByRole("button", { name: "Unlink Slack" });
   await f.goStale(SIGN_INS);
   expect(screen.queryByRole("button", { name: /^Unlink / })).toBeNull();
   expect(screen.getByText("Slack")).toBeTruthy();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("stale: an Unlink Slack dialog already open is refused with zero sends", async () => {
  const f = mount("/app/account");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Unlink Slack" }));
   await screen.findByRole("dialog", { name: "Unlink Slack?" });
   await f.goStale(SIGN_INS);
   fireEvent.click(within(screen.getByRole("dialog", { name: "Unlink Slack?" })).getByRole("button", { name: "Unlink Slack" }));
   await settle();
   expect(writes(f)).toHaveLength(0);
   expect(has(REFUSAL)).toBe(true);
   expect(screen.queryByTestId("unlinked-notice")).toBeNull();
  } finally { f.close(); }
 });
 it("stale identity: no Unlink and no Connect on the list", async () => {
  const f = mount("/app/account");
  try {
   await screen.findByRole("button", { name: "Unlink Slack" });
   await f.goStale(ME);
   expect(screen.queryByRole("button", { name: /^(Unlink|Connect) / })).toBeNull();
  } finally { f.close(); }
 });
});

describe("your GitHub account (GithubAccountReadScreen)", () => {
 it("fresh: Unlink sends one DELETE; Connect sends one POST", async () => {
  const f = mount("/app/account/github");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Disconnect your GitHub account" }));
   fireEvent.click(within(await screen.findByRole("dialog", { name: "Unlink your GitHub account?" })).getByRole("button", { name: "Unlink GitHub" }));
   await waitFor(() => expect(writes(f)).toHaveLength(1));
  } finally { f.close(); }
  const g = mount("/app/account/github", { linked: false });
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Connect your GitHub" }));
   fireEvent.click(within(await screen.findByRole("dialog", { name: "Connect your GitHub?" })).getByRole("button", { name: "Continue to GitHub" }));
   await waitFor(() => expect(writes(g)).toEqual([expect.objectContaining({ method: "POST", path: "/v1/app/me/github/link" })]));
  } finally { g.close(); }
 });
 it("F6 (PROBE-E2): a 503 re-read shows Reconnecting and NO Unlink / Disconnect button", async () => {
  const f = mount("/app/account/github");
  try {
   await screen.findByRole("button", { name: "Disconnect your GitHub account" });
   await f.goStale(GITHUB);
   expect(screen.queryByRole("button", { name: "Disconnect your GitHub account" })).toBeNull();
   expect(screen.queryByRole("button", { name: "Unlink" })).toBeNull();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("stale: an Unlink dialog already open is refused with zero sends", async () => {
  const f = mount("/app/account/github");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Disconnect your GitHub account" }));
   await screen.findByRole("dialog", { name: "Unlink your GitHub account?" });
   await f.goStale(GITHUB);
   fireEvent.click(within(screen.getByRole("dialog", { name: "Unlink your GitHub account?" })).getByRole("button", { name: "Unlink GitHub" }));
   await settle();
   expect(writes(f)).toHaveLength(0);
   expect(has(REFUSAL)).toBe(true);
  } finally { f.close(); }
 });
 it("stale: Connect your GitHub is hidden (no dialog open)", async () => {
  const f = mount("/app/account/github", { linked: false });
  try {
   await screen.findByRole("button", { name: "Connect your GitHub" });
   await f.goStale(GITHUB);
   expect(screen.queryByRole("button", { name: "Connect your GitHub" })).toBeNull();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("stale: a Continue to GitHub already open is refused with zero sends", async () => {
  const f = mount("/app/account/github", { linked: false });
  try {
   await screen.findByRole("button", { name: "Connect your GitHub" });
   fireEvent.click(screen.getByRole("button", { name: "Connect your GitHub" }));
   await screen.findByRole("dialog", { name: "Connect your GitHub?" });
   await f.goStale(GITHUB);
   fireEvent.click(within(screen.getByRole("dialog", { name: "Connect your GitHub?" })).getByRole("button", { name: "Continue to GitHub" }));
   await settle();
   expect(writes(f)).toHaveLength(0);
   expect(has(REFUSAL)).toBe(true);
  } finally { f.close(); }
 });
 it("stale identity: no Unlink on the GitHub page", async () => {
  const f = mount("/app/account/github");
  try {
   await screen.findByRole("button", { name: "Disconnect your GitHub account" });
   await f.goStale(ME);
   expect(screen.queryByRole("button", { name: "Disconnect your GitHub account" })).toBeNull();
  } finally { f.close(); }
 });
});

describe("Automation keys (AutomationKeysReadScreen)", () => {
 it("fresh: Revoke sends one POST", async () => {
  const f = mount("/app/account/automation-keys");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
   fireEvent.click(within(await screen.findByRole("dialog", { name: "Revoke this automation key?" })).getByRole("button", { name: "Revoke key" }));
   await waitFor(() => expect(writes(f)).toHaveLength(1));
  } finally { f.close(); }
 });
 it("stale: Revoke and Create are hidden; a Revoke key already open is refused with zero sends and says why", async () => {
  const f = mount("/app/account/automation-keys");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
   await screen.findByRole("dialog", { name: "Revoke this automation key?" });
   await f.goStale(KEYS);
   fireEvent.click(within(screen.getByRole("dialog", { name: "Revoke this automation key?" })).getByRole("button", { name: "Revoke key" }));
   await settle();
   expect(writes(f)).toHaveLength(0);
   expect(has(REFUSAL)).toBe(true);
   fireEvent.click(within(screen.getByRole("dialog", { name: "Revoke this automation key?" })).getByRole("button", { name: "Keep key" }));
   expect(screen.queryByRole("button", { name: /^(Revoke|Create automation key)/ })).toBeNull();
  } finally { f.close(); }
 });
 it("fresh: Create sends one POST and the secret is shown once", async () => {
  const f = mount("/app/account/automation-keys");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Create automation key" }));
   const dialog = await screen.findByRole("dialog", { name: "Create automation key" });
   fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "New key" } });
   fireEvent.change(within(dialog).getByLabelText("Projects (one name per line)"), { target: { value: "api" } });
   fireEvent.click(within(dialog).getByRole("button", { name: "Create automation key" }));
   await waitFor(() => expect(has(secret)).toBe(true));
   expect(writes(f)).toHaveLength(1);
  } finally { f.close(); }
 });
 it("stale: the Create form already open is refused with zero sends (the key's secret is never asked for)", async () => {
  const f = mount("/app/account/automation-keys");
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Create automation key" }));
   const dialog = await screen.findByRole("dialog", { name: "Create automation key" });
   fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "New key" } });
   fireEvent.change(within(dialog).getByLabelText("Projects (one name per line)"), { target: { value: "api" } });
   await f.goStale(KEYS);
   fireEvent.click(within(screen.getByRole("dialog", { name: "Create automation key" })).getByRole("button", { name: "Create automation key" }));
   await settle();
   expect(writes(f)).toHaveLength(0);
   expect(has(REFUSAL)).toBe(true);
   expect(has(secret)).toBe(false);
  } finally { f.close(); }
 });
 it("stale identity: no Revoke and no Create button", async () => {
  const f = mount("/app/account/automation-keys");
  try {
   await screen.findByRole("button", { name: "Revoke Nightly CI" });
   await f.goStale(ME);
   expect(screen.queryByRole("button", { name: /^(Revoke|Create automation key)/ })).toBeNull();
   expect(identityKey(f)).toBeDefined();
  } finally { f.close(); }
 });
});

describe("the one Reconnecting line sits right under the page header (G2's placement)", () => {
 it.each([
  ["/app/account", SIGN_INS, "Account"],
  ["/app/account/github", GITHUB, "Your GitHub account"],
  ["/app/account/automation-keys", KEYS, "Automation keys"],
 ])("%s: one line, directly after the header, before the page body", async (path, readPath, title) => {
  const f = mount(path);
  try {
   await screen.findByRole("heading", { level: 1, name: title });
   await waitFor(() => expect(document.querySelector("section[aria-label='Your account'], section[aria-label='Your GitHub account'], section[aria-label='Automation keys']")).not.toBeNull());
   await f.goStale(readPath);
   const lines = document.querySelectorAll("[data-stale-line]");
   expect(lines).toHaveLength(1);
   const header = screen.getByRole("heading", { level: 1, name: title }).closest("header")!;
   expect(header.nextElementSibling).toBe(lines[0]);
   expect(lines[0]!.nextElementSibling?.tagName).toBe("SECTION");
  } finally { f.close(); }
 });
});
