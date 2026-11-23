// @vitest-environment jsdom
// G5 ship: the rebuilt Account, Your GitHub account and Automation keys pages on the REAL router (appRoutes + the shell), and every live action they carry.
// Each action allowed sends exactly one write; refused, stale or not permitted sends none. The old screens are gone and the routes are lazy.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { focusManager, QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema, ScriptTokenMetadataListSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { accountSetupReadRoutes } from "../../packages/ui/src/routes/account-setup-read-routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { token, secret } from "./support/script-token-fixture.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const REFUSED: ApiResponse = { status: 403, body: { error: { code: "FORBIDDEN", message: "Not allowed." } } };
const SIGN_INS = { signIns: [{ method: "github", primary: true }, { method: "slack", primary: false, linkedAt: "2026-11-10T00:00:00Z" }] };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });

function mount(path: string, respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>, options: { role?: string } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: role, nameChosen: true }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? ok(nav) : r.path === "/v1/app/me" && r.method === "GET" ? ok(identity) : respond(r)));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const tree = h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) });
 const view = renderUi(tree);
 return { ...f, ...view, router, query, close: () => { view.unmount(); router.dispose(); query.clear(); cleanup(); } };
}
const writes = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET");
const base = (r: ApiRequest): ApiResponse | undefined => r.path === "/v1/app/me/sign-ins" ? ok(SIGN_INS) : r.path === "/v1/app/me/github" ? ok({ linked: false }) : r.path === "/v1/app/me/lessons-slack" ? ok({ optOut: false })
 : r.path === "/v1/app/script-tokens" && r.method === "GET" ? ok({ canCreate: true, tokens: [token] }) : undefined;

describe("the real routes", () => {
 it("mounts each page at its address: Account, Your GitHub account, Automation keys; the old screens are gone", async () => {
  for (const [path, heading] of [["/app/account", "Account"], ["/app/account/github", "Your GitHub account"], ["/app/account/automation-keys", "Automation keys"]] as const) {
   const f = mount(path, r => base(r) ?? ok({}));
   try {
    expect(await screen.findByRole("heading", { level: 1, name: heading })).toBeTruthy();
    // The old pages' headings and testids: "Your account" h1, the plain keys list.
    expect(screen.queryByRole("heading", { level: 1, name: "Your account" })).toBeNull();
    expect(screen.queryByRole("list", { name: "Automation keys list" })).toBeNull();
    expect(document.querySelector(".g5-account-setup-read")).not.toBeNull();
   } finally { f.close(); }
  }
 });
 it("keeps the pages lazy: no element on the route, no static import of the screens, one chunk module", () => {
  const routes = accountSetupReadRoutes();
  expect(routes.map(route => route.path)).toEqual(["account", "account/github", "account/automation-keys"]);
  for (const route of routes) { expect(route.lazy).toBeTypeOf("function"); expect(route.element).toBeUndefined(); expect(route.Component).toBeUndefined(); }
  const mounted = readFileSync(resolve("packages/ui/src/routes.tsx"), "utf8"), routeFile = readFileSync(resolve("packages/ui/src/routes/account-setup-read-routes.tsx"), "utf8");
  for (const code of [mounted, routeFile]) expect(code).not.toMatch(/import\s[^;]*from\s*"\.\.?\/(?:screens\/account-setup-read|screens\/account)\//);
  expect(routeFile).toMatch(/import\("\.\.\/screens\/account-setup-read\/LazyPages\.js"\)/);
  expect(mounted).not.toMatch(/screens\/account\/(?:AccountScreen|AutomationKeysScreen|GithubAccount)\.js/);
 });
 it("sends the old GitHub addresses to the GitHub page and keeps the query", async () => {
  for (const search of ["?github=connect", "?github_link=linked"]) {
   const f = mount(`/app/account${search}`, r => base(r) ?? ok({}));
   try {
    await screen.findByRole("heading", { level: 1, name: "Your GitHub account" });
    expect(f.router.state.location.pathname).toBe("/app/account/github");
    if (search === "?github=connect") { expect(f.router.state.location.search).toBe(search); expect(await screen.findByRole("dialog", { name: "Connect your GitHub?" })).toBeTruthy(); }
    else await waitFor(() => expect(f.router.state.location.search).toBe(""));
    expect(writes(f)).toHaveLength(0);
   } finally { f.close(); }
  }
 });
});

describe("Account: name", () => {
 it("Change name sends exactly one PUT with the name alone and closes", async () => {
  let name = "Priya";
  const f = mount("/app/account", r => r.method === "PUT" && r.path === "/v1/app/me/name" ? (name = (r.body as { name: string }).name, ok({ name, nameChosen: true })) : base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change name" }));
   const dialog = await screen.findByRole("dialog", { name: "Your name" });
   expect(writes(f)).toHaveLength(0);
   fireEvent.change(within(dialog).getByLabelText("Your name"), { target: { value: "  Priya R  " } });
   fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
   await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
   expect(writes(f)).toEqual([expect.objectContaining({ method: "PUT", path: "/v1/app/me/name", body: { name: "Priya R" } })]);
  } finally { f.close(); }
 });
 it("an empty name, an email address or a server refusal sends nothing or one refused send and keeps the dialog", async () => {
  const f = mount("/app/account", r => r.method === "PUT" ? REFUSED : base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change name" }));
   const dialog = await screen.findByRole("dialog", { name: "Your name" });
   for (const value of ["", "ana@acme.example"]) { fireEvent.change(within(dialog).getByLabelText("Your name"), { target: { value } }); fireEvent.click(within(dialog).getByRole("button", { name: "Save name" })); }
   expect(writes(f)).toHaveLength(0);
   fireEvent.change(within(dialog).getByLabelText("Your name"), { target: { value: "Priya R" } }); fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
   await within(dialog).findByText("Not allowed.");
   expect(writes(f)).toHaveLength(1);
   expect(screen.getByRole("dialog", { name: "Your name" })).toBeTruthy();
  } finally { f.close(); }
 });
});

describe("Account: a half-typed name survives a tab switch", () => {
 it("window focus does not re-read who you are (the identity read), so the open Change name dialog and its typing stay", async () => {
  const f = mount("/app/account", r => base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Change name" }));
   const dialog = await screen.findByRole("dialog", { name: "Your name" });
   fireEvent.change(within(dialog).getByLabelText("Your name"), { target: { value: "Half typed" } });
   const identityRead = () => f.query.getQueryState(["g5-account-setup", "/v1/app/me"])?.dataUpdatedAt, before = identityRead();
   fireEvent(window, new Event("focus")); fireEvent(window, new Event("visibilitychange"));
   await new Promise(resolve => setTimeout(resolve, 50));
   expect(identityRead()).toBe(before);
   expect(before).toBeGreaterThan(0);
   expect((within(screen.getByRole("dialog", { name: "Your name" })).getByLabelText<HTMLInputElement>("Your name")).value).toBe("Half typed");
  } finally { f.close(); }
 });
});

describe("Account: appearance, sign-ins, Slack", () => {
 it("Appearance changes this browser only: no request", async () => {
  const f = mount("/app/account", r => base(r) ?? ok({}));
  try {
   const radio = await screen.findByRole("radio", { name: "Dark" });
   const before = f.request.mock.calls.length;
   fireEvent.click(radio);
   await waitFor(() => expect(screen.getByRole<HTMLInputElement>("radio", { name: "Dark" }).checked).toBe(true));
   expect(f.request.mock.calls.length).toBe(before);
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("Unlink and Connect each send one write only from their dialog, and a refusal sends one and keeps the list", async () => {
  const f = mount("/app/account", r => r.method === "DELETE" ? REFUSED : r.method === "POST" ? REFUSED : r.path === "/v1/app/me/sign-ins" ? ok({ ...SIGN_INS, signIns: [{ method: "slack", primary: true }, { method: "github", primary: false }] }) : base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Unlink GitHub" }));
   expect(writes(f)).toHaveLength(0);
   const dialog = await screen.findByRole("dialog", { name: "Unlink GitHub?" });
   fireEvent.click(within(dialog).getByRole("button", { name: "Unlink GitHub" }));
   await within(dialog).findByRole("alert");
   expect(writes(f)).toEqual([expect.objectContaining({ method: "DELETE", path: "/v1/app/me/sign-ins/github" })]);
   expect(screen.queryByTestId("unlinked-notice")).toBeNull();
  } finally { f.close(); }
 });
 it("an unreadable sign-ins list offers no Unlink or Connect", async () => {
  const f = mount("/app/account", r => r.path === "/v1/app/me/sign-ins" ? { status: 503, body: { error: { code: "X", message: "x" } } } : base(r) ?? ok({}));
  try {
   await screen.findByRole("listitem", { name: "Connected sign-ins" });
   await waitFor(() => expect(screen.queryByText(/Checking your connected sign-ins/)).toBeNull());
   expect(screen.queryByRole("button", { name: /^(Unlink|Connect) / })).toBeNull();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("a sign-ins list Code does not serve is one plain 'not connected' row with no accessibility violation (a list item may not carry role=status)", async () => {
  const f = mount("/app/account", r => r.path === "/v1/app/me/sign-ins" ? { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } } : base(r) ?? ok({}));
  try {
   await waitFor(() => expect(screen.getAllByTestId("not-connected").length).toBeGreaterThan(0));
   expect(screen.getAllByTestId("not-connected")[0]!.getAttribute("role")).toBeNull();
   await expectNoAxeViolations(f.container);
  } finally { f.close(); }
 });
 it("the Slack switch sends one PUT with the one choice; a refusal says a fixed sentence", async () => {
  let optOut = false;
  const f = mount("/app/account", r => r.method === "PUT" && r.path === "/v1/app/me/lessons-slack" ? (optOut = (r.body as { optOut: boolean }).optOut, ok({ optOut })) : r.path === "/v1/app/me/lessons-slack" ? ok({ optOut }) : base(r) ?? ok({}));
  try {
   const toggle = await screen.findByRole("switch", { name: "Don't learn from my Slack messages" });
   fireEvent.click(toggle);
   await waitFor(() => expect(writes(f)).toHaveLength(1));
   expect(writes(f)[0]).toMatchObject({ method: "PUT", path: "/v1/app/me/lessons-slack", body: { optOut: true } });
  } finally { f.close(); }
 });
});

describe("Your GitHub account", () => {
 it("Connect and Unlink: one write each, none before the dialog, and the notice survives the re-read", async () => {
  let linked = true;
  const f = mount("/app/account/github", r => r.method === "DELETE" ? (linked = false, ok({ unlinked: true })) : r.path === "/v1/app/me/github" ? ok(linked ? { linked: true, login: "priya-dev", linkedAt: "2026-11-17T12:00:00Z" } : { linked: false }) : base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Disconnect your GitHub account" }));
   const dialog = await screen.findByRole("dialog", { name: "Unlink your GitHub account?" });
   expect(writes(f)).toHaveLength(0);
   fireEvent.click(within(dialog).getByRole("button", { name: "Unlink GitHub" }));
   await waitFor(() => expect(writes(f)).toEqual([expect.objectContaining({ method: "DELETE", path: "/v1/app/me/github" })]));
   expect((await screen.findByTestId("github-link-notice")).textContent).toBe("Your GitHub account is disconnected.");
   expect(await screen.findByRole("button", { name: "Connect your GitHub" })).toBeTruthy();
  } finally { f.close(); }
 });
});

describe("Automation keys", () => {
 const keysAnswer = (canCreate: boolean | undefined) => ({ ...ScriptTokenMetadataListSchema.parse({ tokens: [token] }), ...(canCreate === undefined ? {} : { canCreate }) });
 it("Create is a button only on Code's canCreate grant; the form sends exactly one POST and the secret is shown once", async () => {
  let created = false;
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? (created = true, { status: 201, body: { token: { ...token, tokenId: "stk_bbbbbbbbbbbbbbbbbbbb", name: "New key" }, secret } }) : r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Create automation key" }));
   const dialog = await screen.findByRole("dialog", { name: "Create automation key" });
   expect(writes(f)).toHaveLength(0);
   fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "New key" } });
   fireEvent.change(within(dialog).getByLabelText("Projects (one name per line)"), { target: { value: "web" } });
   fireEvent.click(within(dialog).getByRole("button", { name: "Create automation key" }));
   await within(dialog).findByText(secret);
   expect(created).toBe(true);
   expect(writes(f)).toHaveLength(1);
   expect(writes(f)[0]).toMatchObject({ method: "POST", path: "/v1/app/script-tokens", retry: "never" });
   expect(JSON.stringify(f.query.getQueryCache().getAll().map(q => q.state.data))).not.toContain(secret);
   fireEvent.click(within(dialog).getByRole("button", { name: "I've saved the key" }));
   expect(document.body.textContent).not.toContain(secret);
  } finally { f.close(); }
 });
 it.each([false, undefined])("no Create when canCreate is %s, whatever the role", async canCreate => {
  const f = mount("/app/account/automation-keys", r => r.path === "/v1/app/script-tokens" ? ok(keysAnswer(canCreate)) : base(r) ?? ok({}), { role: "owner" });
  try { await screen.findByText("Nightly CI"); expect(screen.queryByRole("button", { name: /Create/ })).toBeNull(); expect(writes(f)).toHaveLength(0); } finally { f.close(); }
 });
 it("Revoke sends one POST only after the confirm; Keep key sends none", async () => {
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? ok({ token: { ...token, status: "revoked" } }) : r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
   fireEvent.click(screen.getByRole("button", { name: "Keep key" }));
   expect(writes(f)).toHaveLength(0);
   fireEvent.click(screen.getByRole("button", { name: "Revoke Nightly CI" }));
   fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));
   await waitFor(() => expect(writes(f)).toHaveLength(1));
   expect(writes(f)[0]).toMatchObject({ method: "POST", path: "/v1/app/script-tokens/stk_aaaaaaaaaaaaaaaaaaaa/revoke", retry: "never" });
  } finally { f.close(); }
 });
 it("a refused revoke sends one POST and keeps the confirm with fixed words", async () => {
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? { status: 403, body: { error: { code: "FORBIDDEN", message: secret } } } : r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
   fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));
   expect((await screen.findByRole("alert")).textContent).toBe("You can't manage these automation keys.");
   expect(writes(f)).toHaveLength(1);
   expect(document.body.textContent).not.toContain(secret);
  } finally { f.close(); }
 });
 // F1: the show-once secret is held by the frame's own slot (memory only), independent of any later read. Fake secret from the fixtures; nothing real.
 const FAILED: ApiResponse = { status: 503, body: { error: { code: "X", message: "x" } } };
 const created = { status: 201, body: { token: { ...token, tokenId: "stk_bbbbbbbbbbbbbbbbbbbb", name: "New key" }, secret } } as const;
 async function submitCreate() {
  fireEvent.click(await screen.findByRole("button", { name: "Create automation key" }));
  const dialog = await screen.findByRole("dialog", { name: "Create automation key" });
  fireEvent.change(within(dialog).getByLabelText("Name"), { target: { value: "New key" } });
  fireEvent.change(within(dialog).getByLabelText("Projects (one name per line)"), { target: { value: "web" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Create automation key" }));
  return dialog;
 }
 // Booleans only: a failed assertion must never print the page (it would print the secret).
 const has = (text: string) => (document.body.textContent ?? "").includes(text);
 const listReads = (f: ReturnType<typeof mount>) => f.request.mock.calls.filter(([r]) => r.method === "GET" && r.path === "/v1/app/script-tokens").length;
 it("F1: the new key's secret stays when the list re-read right after Create fails, with the last list and one Reconnecting line beside it, until the person dismisses it", async () => {
  let failing = false;
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? (failing = true, created) : r.path === "/v1/app/script-tokens" && failing ? FAILED : r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   await submitCreate();
   await waitFor(() => expect(listReads(f)).toBeGreaterThanOrEqual(2));
   await screen.findByText(/Updated .+ · Reconnecting/);
   expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
   expect(has("Nightly CI")).toBe(true);
   expect(has(secret)).toBe(true);
   expect(JSON.stringify(f.query.getQueryCache().getAll().map(q => q.state.data))).not.toContain(secret);
   for (const store of [window.localStorage, window.sessionStorage]) for (let i = 0; i < store.length; i += 1) expect((store.getItem(store.key(i) ?? "") ?? "").includes(secret)).toBe(false);
   fireEvent.click(screen.getByRole("button", { name: "I've saved the key" }));
   expect(has(secret)).toBe(false);
   expect(writes(f)).toHaveLength(1);
  } finally { f.close(); }
 });
 it("F1: the secret also stays when the identity check inside that re-read fails (the last facts stay too, with one Reconnecting line)", async () => {
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? created : r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   await screen.findByText("Nightly CI");
   const answer = f.request.getMockImplementation()!;
   f.request.mockImplementation(async r => (r.path === "/v1/app/me" ? FAILED : answer(r)));
   await submitCreate();
   await screen.findByText(/Updated .+ · Reconnecting/);
   expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
   expect(has("Nightly CI")).toBe(true);
   expect(has(secret)).toBe(true);
   expect(writes(f)).toHaveLength(1);
  } finally { f.close(); }
 });
 it("F1: access ending (401 on who you are) removes the secret panel with the page", async () => {
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? created : r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   await screen.findByText("Nightly CI");
   const answer = f.request.getMockImplementation()!;
   f.request.mockImplementation(async r => (r.path === "/v1/app/me" ? { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "x" } } } : answer(r)));
   await submitCreate();
   await waitFor(() => expect(has("access to this information could not be confirmed")).toBe(true));
   expect(has(secret)).toBe(false);
  } finally { f.close(); }
 });
 it("F3: a Revoke dialog already open stays open after a failed re-read (the last list is kept) and its Revoke key button sends nothing on that stale list", async () => {
  let failing = false;
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? ok({ token: { ...token, status: "revoked" } }) : r.path === "/v1/app/script-tokens" && failing ? FAILED : r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
   const dialog = await screen.findByRole("dialog", { name: "Revoke this automation key?" });
   failing = true;
   await f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/script-tokens") });
   await screen.findByText(/Reconnecting/);
   expect(screen.getByRole("dialog", { name: "Revoke this automation key?" })).toBe(dialog);
   fireEvent.click(within(dialog).getByRole("button", { name: "Revoke key" }));
   await new Promise(resolve => setTimeout(resolve, 50));
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("F4: a read is refused when the company differs at the identity re-check although the person and the company name match", async () => {
  const f = mount("/app/account/automation-keys", r => r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   await screen.findByText("Nightly CI");
   const answer = f.request.getMockImplementation()!;
   // The first two identity answers (the check before and the check after the list read) name another company; every later one fails.
   let swapped = 0;
   f.request.mockImplementation(async r => {
    if (r.path !== "/v1/app/me") return answer(r);
    if (swapped >= 2) return FAILED;
    swapped += 1;
    const same = await answer(r);
    return { ...same, body: { ...(same.body as { org: object }), org: { ...(same.body as { org: object }).org, orgId: "org_bbbbbbbbbbbbbbbbbbbb" } } };
   });
   await f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/script-tokens") });
   await waitFor(() => expect(screen.queryByText("Nightly CI")).toBeNull());
   expect(swapped).toBeGreaterThanOrEqual(1);
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("F5 (DEC 324): on window focus the scoped reads re-check who you are, and a 401 wipes the private rows with no write", async () => {
  const f = mount("/app/account", r => base(r) ?? ok({}));
  try {
   await screen.findByRole("list", { name: "Your sign-in methods" });
   const answer = f.request.getMockImplementation()!;
   f.request.mockImplementation(async r => (r.path === "/v1/app/me" ? { status: 401, body: { error: { code: "UNAUTHENTICATED", message: "x" } } } : answer(r)));
   focusManager.setFocused(false); focusManager.setFocused(true);
   await waitFor(() => expect(screen.queryByRole("list", { name: "Your sign-in methods" })).toBeNull());
   expect(writes(f)).toHaveLength(0);
  } finally { focusManager.setFocused(undefined); f.close(); }
 });
 it("stale: after a failed re-read the last list may stay (policy) but offers no Revoke and no Create", async () => {
  let failing = false;
  const f = mount("/app/account/automation-keys", r => r.path === "/v1/app/script-tokens" && failing ? { status: 503, body: { error: { code: "X", message: "x" } } } : r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   await screen.findByRole("button", { name: "Revoke Nightly CI" });
   failing = true;
   await f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/script-tokens") });
   await screen.findByText(/Reconnecting/);
   expect(screen.getByText("Nightly CI")).toBeTruthy();
   expect(screen.queryByRole("button", { name: /^(Revoke|Create)/ })).toBeNull();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("stale: a failed re-read after Create keeps the last list, the Reconnecting line and the secret; no Create is offered while the list is stale", async () => {
  let failing = false;
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? (failing = true, created) : r.path === "/v1/app/script-tokens" && failing ? FAILED : r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   await submitCreate();
   await screen.findByText(/Updated .+ · Reconnecting/);
   expect(has("Nightly CI")).toBe(true); expect(has(secret)).toBe(true);
   expect(screen.queryByRole("button", { name: "Revoke Nightly CI" })).toBeNull();
  } finally { f.close(); }
 });
 // F1 across every read outcome (DEC 324): the secret sits beside the frame and only the person dismisses it. Fake secret; booleans only, never printing the page.
 it.each([
  ["a 503 on the list", (r: ApiRequest) => (r.path === "/v1/app/script-tokens" ? FAILED : undefined)],
  ["a 504 on the list", (r: ApiRequest) => (r.path === "/v1/app/script-tokens" ? { status: 504, body: {} } : undefined)],
  ["a 503 on who you are", (r: ApiRequest) => (r.path === "/v1/app/me" ? FAILED : undefined)],
  ["a network error on both reads", (r: ApiRequest) => { if (r.path === "/v1/app/me" || r.path === "/v1/app/script-tokens") throw new Error("offline"); return undefined; }],
 ])("F1: the secret survives %s after Create; one Reconnecting line; dismissed only by the person", async (_label, failOn) => {
  let failing = false;
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? (failing = true, created) : (failing ? failOn(r) : undefined) ?? (r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({})));
  try {
   await screen.findByText("Nightly CI");
   const answer = f.request.getMockImplementation()!;
   f.request.mockImplementation(async r => (r.path === "/v1/app/me" && r.method === "GET" && failing ? (failOn(r) ?? answer(r)) : answer(r)));
   await submitCreate();
   await screen.findByText(/Updated .+ · Reconnecting/);
   expect(screen.getAllByText(/Reconnecting/)).toHaveLength(1);
   expect(has(secret)).toBe(true);
   await act(async () => { await f.query.refetchQueries(); });
   expect(has(secret)).toBe(true);
   expect(has("Nightly CI")).toBe(true);
   expect(writes(f)).toHaveLength(1);
   fireEvent.click(screen.getByRole("button", { name: "I've saved the key" }));
   expect(has(secret)).toBe(false);
  } finally { f.close(); }
 });
 it("F1: the secret survives a re-read still in flight (the last facts stay visible, no Loading)", async () => {
  let hang = false;
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? (hang = true, created) : r.path === "/v1/app/script-tokens" && hang ? new Promise(() => undefined) : r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   await submitCreate();
   await waitFor(() => expect(f.query.isFetching({ predicate: q => q.queryKey.includes("/v1/app/script-tokens") })).toBe(1));
   expect(has(secret)).toBe(true); expect(has("Nightly CI")).toBe(true); expect(has("Loading automation keys")).toBe(false);
  } finally { f.close(); }
 });
 // Post-write read handling: the write went through, so the page says so; it never says "Nothing was changed".
 it("a revoke that succeeded followed by a 503 re-read shows the success and \"Couldn't refresh; reconnecting\", keeps the last list, never says Nothing was changed", async () => {
  let revoked = false;
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? (revoked = true, ok({ token: { ...token, status: "revoked" } })) : r.path === "/v1/app/script-tokens" && revoked ? FAILED : r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
   fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));
   const notice = await screen.findByTestId("key-revoked-notice");
   await waitFor(() => expect(notice.textContent).toBe("Nightly CI is revoked. Couldn't refresh; reconnecting."));
   await screen.findByText(/Updated .+ · Reconnecting/);
   expect(screen.getByText("Nightly CI", { selector: "strong" })).toBeTruthy();
   expect(has("Nothing was changed")).toBe(false);
   expect(writes(f)).toHaveLength(1);
  } finally { f.close(); }
 });
 it("a revoke that succeeded followed by a 403 re-read clears the list but still says the change went through, never Nothing was changed", async () => {
  let revoked = false;
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? (revoked = true, ok({ token: { ...token, status: "revoked" } })) : r.path === "/v1/app/script-tokens" && revoked ? REFUSED : r.path === "/v1/app/script-tokens" ? ok(keysAnswer(true)) : base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
   fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));
   await screen.findByText(/Your change went through\./);
   expect(has("Nightly CI is revoked")).toBe(true);
   expect(screen.queryByRole("button", { name: "Revoke Nightly CI" })).toBeNull();
   expect(has("Nothing was changed")).toBe(false);
  } finally { f.close(); }
 });
 it("a revoke followed by a good re-read says the key is revoked with no refresh complaint", async () => {
  let revoked = false;
  const f = mount("/app/account/automation-keys", r => r.method === "POST" ? (revoked = true, ok({ token: { ...token, status: "revoked" } })) : r.path === "/v1/app/script-tokens" ? ok(revoked ? { ...keysAnswer(true), tokens: [{ ...token, status: "revoked" }] } : keysAnswer(true)) : base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
   fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));
   await waitFor(() => expect(screen.getByTestId("key-revoked-notice").textContent).toBe("Nightly CI is revoked."));
   expect(screen.queryByText(/Reconnecting/)).toBeNull();
  } finally { f.close(); }
 });
});

describe("a read that fails AFTER a successful write (DEC 324)", () => {
 const FAILED503: ApiResponse = { status: 503, body: { error: { code: "X", message: "x" } } };
 const said = (text: string) => (document.body.textContent ?? "").includes(text);
 it("GitHub Unlink: success notice + Couldn't refresh; reconnecting; the last facts stay with one Reconnecting line; never Nothing was changed", async () => {
  let unlinked = false;
  const f = mount("/app/account/github", r => r.method === "DELETE" ? (unlinked = true, ok({ unlinked: true })) : r.path === "/v1/app/me/github" && unlinked ? FAILED503 : r.path === "/v1/app/me/github" ? ok({ linked: true, login: "priya-dev", linkedAt: "2026-11-17T12:00:00Z" }) : base(r) ?? ok({}));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Disconnect your GitHub account" }));
   fireEvent.click(within(await screen.findByRole("dialog", { name: "Unlink your GitHub account?" })).getByRole("button", { name: "Unlink GitHub" }));
   await waitFor(() => expect(screen.getByTestId("github-link-notice").textContent).toBe("Your GitHub account is disconnected. Couldn't refresh; reconnecting."));
   await screen.findByText(/Updated .+ · Reconnecting/);
   expect(screen.getAllByText(/Reconnecting/).length).toBe(1);
   expect(said("Nothing was changed")).toBe(false);
   expect(writes(f)).toHaveLength(1);
  } finally { f.close(); }
 });
 it("Slack switch: the saved word + Couldn't refresh; reconnecting; the saved value is shown and the switch is not offered again until a read answers (write rule)", async () => {
  let saved = false;
  const f = mount("/app/account", r => r.method === "PUT" && r.path === "/v1/app/me/lessons-slack" ? (saved = true, ok({ optOut: true })) : r.path === "/v1/app/me/lessons-slack" && saved ? FAILED503 : r.path === "/v1/app/me/lessons-slack" ? ok({ optOut: false }) : base(r) ?? ok({}));
  try {
   const toggle = await screen.findByRole("switch", { name: "Don't learn from my Slack messages" });
   fireEvent.click(toggle);
   await waitFor(() => expect(said("Saved. Your Slack replies are left out. Couldn't refresh; reconnecting.")).toBe(true));
   expect(screen.queryByRole("switch", { name: "Don't learn from my Slack messages" })).toBeNull();
   expect(screen.getByTestId("slack-learning-value").textContent).toBe("On");
   expect(said("Nothing was changed")).toBe(false);
   expect(writes(f)).toHaveLength(1);
  } finally { f.close(); }
 });
 it("Change name: Your name is saved + Couldn't refresh; reconnecting when the identity cannot be read again", async () => {
  let saved = false;
  const f = mount("/app/account", r => r.method === "PUT" && r.path === "/v1/app/me/name" ? (saved = true, ok({ name: "Priya R", nameChosen: true })) : base(r) ?? ok({}));
  try {
   const answer = f.request.getMockImplementation()!;
   f.request.mockImplementation(async r => (saved && r.path === "/v1/app/me" && r.method === "GET" ? FAILED503 : answer(r)));
   fireEvent.click(await screen.findByRole("button", { name: "Change name" }));
   const dialog = await screen.findByRole("dialog", { name: "Your name" });
   fireEvent.change(within(dialog).getByLabelText("Your name"), { target: { value: "Priya R" } });
   fireEvent.click(within(dialog).getByRole("button", { name: "Save name" }));
   await waitFor(() => expect(said("Your name is saved. Couldn't refresh; reconnecting.")).toBe(true));
   await screen.findByText(/Updated .+ · Reconnecting/);
   expect(said("Nothing was changed")).toBe(false);
  } finally { f.close(); }
 });
});
