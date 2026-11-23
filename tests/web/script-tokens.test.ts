// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AutomationKeysReadScreen } from "../../packages/ui/src/screens/account-setup-read/AutomationKeysReadScreen.js";
import { ReadEntry } from "../../packages/ui/src/screens/account-setup-read/ReadEntry.js";
import { identity } from "./read-only/account-setup-read/fixtures.js";
import { CreateAutomationKey } from "../../packages/ui/src/screens/account/CreateAutomationKey.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { token, secret } from "./support/script-token-fixture.js";

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); localStorage.clear(); sessionStorage.clear(); });
function mount(respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>, form = false, role = "owner") {
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: identity } : respond(r));
 const copyText = vi.fn<(text: string) => Promise<void>>(async () => undefined); f.host.copyText = copyText;
 f.host.currentPath = () => "/app/account/automation-keys";
 const query = createQueryClient();
 query.setQueryData(["nav"], { me: { developerId: "person", name: "Priya", orgRole: role }, org: { name: "Acme" } });
 const router = createMemoryRouter([
  { path: "/app/account/automation-keys", element: form ? h(CreateAutomationKey, { onCreated: () => undefined }) : h(ReadEntry, { title: "Automation keys", children: h(AutomationKeysReadScreen) }) },
  { path: "/elsewhere", element: h("p", {}, "Elsewhere") },
 ], { initialEntries: ["/app/account/automation-keys"] });
 const tree = () => h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(RouterProvider, { router }) }) });
 const ui = renderUi(tree());
 return { ...f, copyText, query, router, rerender: () => ui.rerender(h("div", { "data-theme": "light" }, tree())), close: () => { ui.unmount(); router.dispose(); query.clear(); } };
}
const list = { status: 200, body: { tokens: [token] } };
it.each([
 { zone: "America/New_York", created: "11/17/2026, 1:00:00 PM EST", expires: "12/17/2026, 1:00:00 PM EST", used: "11/18/2026, 7:30:45 PM EST" },
 { zone: "Asia/Tokyo", created: "11/18/2026, 3:00:00 AM GMT+9", expires: "12/18/2026, 3:00:00 AM GMT+9", used: "11/19/2026, 9:30:45 AM GMT+9" },
])("shows key times in the viewer's $zone zone, including the zone", async ({ zone, created, expires, used }) => {
 vi.stubEnv("TZ", zone);
 const f = mount(() => ({ status: 200, body: { tokens: [{ ...token, lastUsedAt: "2026-11-19T00:30:45.123Z" }] } }));
 try {
  await screen.findByText("Nightly CI");
  const text = screen.getByRole("table", { name: "Automation keys" }).textContent ?? "";
  expect(text).toContain(`Created ${created} · Expires ${expires}`);
  expect(text).toContain(`Last used ${used}`);
 } finally { f.close(); }
});

it.each([undefined, "2026-11-19T00:30:45.123Z"])("preserves exact UTC ISO timestamps in tooltips (last used: %s)", async lastUsedAt => {
 const f = mount(() => ({ status: 200, body: { tokens: [{ ...token, ...(lastUsedAt === undefined ? {} : { lastUsedAt }) }] } }));
 try {
  await screen.findByText("Nightly CI");
  for (const at of [token.createdAt, token.expiresAt, ...(lastUsedAt === undefined ? [] : [lastUsedAt])]) {
   expect(screen.getByTitle(at).getAttribute("datetime")).toBe(at);
  }
  if (lastUsedAt === undefined) expect(screen.getByRole("table", { name: "Automation keys" }).textContent).toContain("Never used");
 } finally { f.close(); }
});

async function fill() {
 fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Nightly CI" } });
 fireEvent.change(screen.getByLabelText("Projects (one name per line)"), { target: { value: "web" } });
 fireEvent.click(screen.getByRole("button", { name: "Create automation key" }));
}

it.each(["owner", "admin", "member"].flatMap(role => [true, false, undefined].map(canCreate => ({ role, canCreate }))))("uses only Code's canCreate=$canCreate signal for $role", async ({ role, canCreate }) => {
  const f = mount(() => ({ status: 200, body: { tokens: [{ ...token, secret }], secret, ...(canCreate === undefined ? {} : { canCreate }) } }), false, role);
  await screen.findByText("Nightly CI");
  expect(screen.getByText("rvst_…aaaaaaaa")).toBeTruthy();
  expect(screen.getByText(/wiki/)).toBeTruthy();
  if (canCreate === true) {
   fireEvent.click(screen.getByRole("button", { name: "Create automation key" }));
   expect(await screen.findByLabelText("Name")).toBeTruthy();
   expect(screen.queryByRole("button", { name: "Confirm it's you" })).toBeNull();
  } else {
   expect(screen.queryByRole("button", { name: /Create/ })).toBeNull();
  }
  expect(document.body.textContent).not.toContain(secret);
  expect(JSON.stringify(f.query.getQueryCache().getAll().map(q => q.state.data))).not.toContain(secret);
  f.close();
});

it("confirms revoke, sends it once and refreshes the list", async () => {
 let revoked = false;
 const f = mount(r => {
  if (r.method === "GET") return { status: 200, body: { tokens: [{ ...token, status: revoked ? "revoked" : "active" }] } };
  revoked = true; return { status: 200, body: { token: { ...token, status: "revoked" } } };
 });
 fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 fireEvent.click(screen.getByRole("button", { name: "Keep key" }));
 expect(screen.queryByRole("dialog")).toBeNull();
 fireEvent.click(screen.getByRole("button", { name: "Revoke Nightly CI" }));
 fireEvent.click(screen.getByRole("button", { name: "Revoke key" }));
 await screen.findByText("Revoked");
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toEqual([[expect.objectContaining({ path: "/v1/app/script-tokens/stk_aaaaaaaaaaaaaaaaaaaa/revoke", retry: "never" })]]);
 expect(screen.queryByRole("button", { name: "Revoke Nightly CI" })).toBeNull();
 f.close();
});

it.each([404, 501, 403, 502])("uses fixed words for list error %s", async status => {
 const f = mount(() => ({ status, body: { error: { code: "NOT_FOUND", message: status === 404 ? "route not found" : secret } } }));
 await screen.findByText(status === 404 || status === 501 ? "Automation keys are not available yet." : status === 403 ? "You can't manage these automation keys." : "Couldn't load automation keys. Try again.");
 expect(document.body.textContent).not.toContain(secret); f.close();
});

it("the create form is there at once and sends nothing until submitted (no step-up since owner DEC 254zzz73)", async () => {
 const f = mount(() => list, true);
 expect(await screen.findByRole("button", { name: "Create automation key" })).toBeTruthy();
 expect(screen.queryByRole("button", { name: "Confirm it's you" })).toBeNull();
 expect(f.host.signIn).not.toHaveBeenCalled();
 expect(f.request).not.toHaveBeenCalled(); f.close();
});

it("shows the creation secret once, copies on request, never stores/caches/logs it, and forgets it on navigation", async () => {
 const spies = ["log", "info", "warn", "error", "debug"].map(method => vi.spyOn(console, method as "log").mockImplementation(() => undefined));
 const local = vi.spyOn(Storage.prototype, "setItem");
 const f = mount(() => ({ status: 201, body: { token, secret } }), true);
 await fill();
 await screen.findByText(secret);
 expect(screen.getByText(/You won't be able to see this key again/)).toBeTruthy();
 f.rerender();
 expect(screen.getAllByText(secret)).toHaveLength(1);
 expect(f.copyText).not.toHaveBeenCalled();
 fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
 await waitFor(() => expect(f.copyText).toHaveBeenCalledWith(secret));
 expect(f.request.mock.calls[0]?.[0]).toMatchObject({ method: "POST", path: "/v1/app/script-tokens", retry: "never", body: { name: "Nightly CI", projects: ["web"], permissions: ["read"], days: 30 } });
 expect(JSON.stringify([...f.storage])).not.toContain(secret);
 expect(JSON.stringify(local.mock.calls)).not.toContain(secret);
 expect(JSON.stringify(f.query.getQueryCache().getAll().map(q => q.state.data))).not.toContain(secret);
 expect(f.query.getMutationCache().getAll()).toHaveLength(0);
 expect(JSON.stringify(spies.flatMap(spy => spy.mock.calls))).not.toContain(secret);
 await act(() => f.router.navigate("/elsewhere"));
 expect(document.body.textContent).not.toContain(secret);
 await act(() => f.router.navigate("/app/account/automation-keys"));
 expect(document.body.textContent).not.toContain(secret);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 f.close();
});

it("B14: offers a read-only Wiki permission and sends it when ticked", async () => {
 const f = mount(() => ({ status: 201, body: { token, secret } }), true);
 fireEvent.change(await screen.findByLabelText("Name"), { target: { value: "Nightly CI" } });
 fireEvent.change(screen.getByLabelText("Projects (one name per line)"), { target: { value: "web" } });
 fireEvent.click(screen.getByLabelText("Wiki (read only)"));
 expect(screen.getByText(/can't change them/)).toBeTruthy();
 fireEvent.click(screen.getByRole("button", { name: "Create automation key" }));
 await screen.findByText(secret);
 expect(f.request.mock.calls[0]?.[0]).toMatchObject({ method: "POST", path: "/v1/app/script-tokens", body: { permissions: ["read", "wiki"] } });
 f.close();
});

it("dismisses the secret without offering to show it again", async () => {
 const f = mount(() => ({ status: 201, body: { token, secret } }), true);
 await fill(); await screen.findByText(secret);
 fireEvent.click(screen.getByRole("button", { name: "I've saved the key" }));
 expect(document.body.textContent).not.toContain(secret);
 f.rerender(); expect(document.body.textContent).not.toContain(secret); f.close();
});

it("clears the secret before a browser history snapshot can preserve it", async () => {
 const f = mount(() => ({ status: 201, body: { token, secret } }), true);
 await fill(); await screen.findByText(secret);
 act(() => { window.dispatchEvent(new Event("pagehide")); });
 expect(document.body.textContent).not.toContain(secret);
 act(() => { window.dispatchEvent(new Event("pageshow")); });
 f.rerender(); expect(document.body.textContent).not.toContain(secret); f.close();
});

it("discards a creation answer that arrives after navigation", async () => {
 let finish!: (value: ApiResponse) => void;
 const f = mount(() => new Promise(resolve => { finish = resolve; }), true);
 await fill(); await act(() => f.router.navigate("/elsewhere"));
 await act(async () => { finish({ status: 201, body: { token, secret } }); });
 await act(() => f.router.navigate("/app/account/automation-keys"));
 expect(document.body.textContent).not.toContain(secret); f.close();
});

it("a 403 refusal (the wrong person, whatever Code's code) is fixed words with no sign-in step, and never echoes the server", async () => {
 const f = mount(() => ({ status: 403, body: { error: { code: "REAUTH_REQUIRED", message: secret } } }), true);
 await fill(); await screen.findByText("You can't manage these automation keys.");
 expect(screen.queryByRole("button", { name: "Confirm it's you" })).toBeNull();
 expect(f.host.signIn).not.toHaveBeenCalled();
 expect(document.body.textContent).not.toContain(secret); f.close();
});

it("never echoes a creation or clipboard failure containing the secret", async () => {
 const f = mount(() => ({ status: 409, body: { error: { code: "CONFLICT", message: secret } } }), true);
 await fill(); await screen.findByText("You may have reached the limit of automation keys. Revoke one you no longer need, then try again.");
 expect(document.body.textContent).not.toContain(secret); f.close();
 const g = mount(() => ({ status: 201, body: { token, secret } }), true);
 g.host.copyText = vi.fn(async () => { throw new Error(secret); });
 await fill(); await screen.findByText(secret);
 fireEvent.click(screen.getByRole("button", { name: "Copy key" }));
 await screen.findByText("Couldn't copy the key. Select and copy it yourself.");
 expect(screen.getAllByText(secret)).toHaveLength(1); g.close();
});
