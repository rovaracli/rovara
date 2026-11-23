// @vitest-environment jsdom
import { inViewerZones, VIEWER_INSTANT } from "./support/viewer-zones.js";
// "Your GitHub account" on Your account (L4-GH): the linked login (or none), Connect (no step-up since owner DEC 254zzz73), GitHub's own address only, Unlink, "not connected yet" while
// Code serves no such route, and fixed words for what a link return says.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { githubLinkNotice, readGithubLinkStart, readMyGithub } from "../../packages/ui/src/api/github-link.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { expectNoAxeViolations } from "./support/axe.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const NOT_ON_CODE = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } };
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const SIGN_INS = { signIns: [{ method: "github", primary: true }], linkable: ["slack", "github"] };
const NONE = { linked: false };
const LINKED = { linked: true, login: "priya-dev", linkedAt: "2026-11-10T00:00:00Z" };
const GITHUB = "https://github.com/login/oauth/authorize?client_id=Iv1.client&state=abc";
const seeded = new Map<string, string>();
beforeEach(() => { seeded.clear(); });

function mount(path: string, respond: (r: ApiRequest) => ApiResponse | Promise<ApiResponse>) {
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: "owner" }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async r => (r.path === "/v1/app/nav" ? { status: 200, body: nav } : r.path === "/v1/app/me" ? { status: 200, body: identity } : r.path === "/v1/app/me/sign-ins" ? ok(SIGN_INS) : respond(r)));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 for (const [key, value] of seeded) f.storage.set(key, value);
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, router, query, close: () => { view.unmount(); router.dispose(); query.clear(); cleanup(); } };
}
const writes = (f: ReturnType<typeof mount>) => f.request.mock.calls.map(([r]) => r).filter(r => r.method !== "GET");
const section = async () => within(await screen.findByRole("region", { name: "Your GitHub account" }));

describe("Your GitHub account readers", () => {
 it("reads only the two shapes, a plain login and a real time, and GitHub's own login page", () => {
  expect(readMyGithub({ linked: false, extra: 1 })).toEqual({ linked: false });
  expect(readMyGithub({ linked: true, login: "priya-dev", linkedAt: "2026-11-10T00:00:00Z", token: "x" })).toEqual({ linked: true, login: "priya-dev", linkedAt: "2026-11-10T00:00:00Z" });
  expect(readMyGithub({ linked: true, login: "priya-dev", linkedAt: "soon" })).toEqual({ linked: true, login: "priya-dev" });
  for (const bad of [{}, { linked: true }, { linked: true, login: "<b>" }, { linked: "yes" }, "x", null]) expect(() => readMyGithub(bad)).toThrow();
  expect(readGithubLinkStart({ authorizeUrl: GITHUB }).authorizeUrl).toBe(GITHUB);
  for (const bad of ["https://evil.example/login/oauth/authorize", "http://github.com/login/oauth/authorize", "https://github.com.evil.example/login/oauth/authorize", "https://github.com/other", "javascript:alert(1)", 4]) expect(() => readGithubLinkStart({ authorizeUrl: bad })).toThrow();
 });
 it("says one fixed sentence per landing word and nothing for any other", () => {
  expect(githubLinkNotice("linked")?.tone).toBe("ok");
  for (const word of ["cancelled", "taken", "exists", "not_available", "start_again", "unavailable"]) expect(githubLinkNotice(word)?.tone).toBe("bad");
  // "reauth" (the old step-up landing word) is gone with the step-up: an old link says nothing.
  for (const word of ["toString", "<script>", "", "constructor", null, "reauth"]) expect(githubLinkNotice(word)).toBeUndefined();
 });
});

describe("Your GitHub account section", () => {
 it("says not connected yet while Code serves no such route", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/github" ? NOT_ON_CODE : ok({})));
  try { const s = await section(); await waitFor(() => expect(s.getByTestId("not-connected")).toBeTruthy()); expect(s.queryByRole("button", { name: /Connect|Unlink/ })).toBeNull(); } finally { f.close(); }
 });
 it("with no account linked offers Connect and says it is not a sign-in", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/github" ? ok(NONE) : ok({})));
  try { const s = await section(); expect(await s.findByRole("button", { name: "Connect your GitHub" })).toBeTruthy(); expect(s.getByText(/does not sign you in with GitHub/)).toBeTruthy(); expect(s.queryByRole("button", { name: /Disconnect/ })).toBeNull(); } finally { f.close(); }
 });
 it("shows the linked login as plain text with an Unlink", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/github" ? ok({ ...LINKED, login: "priya-dev" }) : ok({})));
  try { const s = await section(); expect((await s.findByTestId("github-login")).textContent).toBe("priya-dev"); expect(s.getByRole("button", { name: "Disconnect your GitHub account" })).toBeTruthy(); expect(s.queryByRole("button", { name: "Connect your GitHub" })).toBeNull(); } finally { f.close(); }
 });
 it("offers Continue straight away (no step-up), and writes nothing until it is pressed", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/github" ? ok(NONE) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Connect your GitHub" }));
   const dialog = await screen.findByRole("dialog", { name: "Connect your GitHub?" });
   expect(within(dialog).queryByTestId("fresh-sign-in")).toBeNull();
   expect(within(dialog).getByRole("button", { name: "Continue to GitHub" })).toBeTruthy();
   expect(writes(f)).toHaveLength(0);
  } finally { f.close(); }
 });
 it("starts the connect with an empty body and sends the browser to GitHub's address", async () => {
  const f = mount("/app/account?github=connect", r => (r.method === "POST" && r.path === "/v1/app/me/github/link" ? ok({ authorizeUrl: GITHUB }) : r.path === "/v1/app/me/github" ? ok(NONE) : ok({})));
  const navigate = vi.spyOn(f.host, "navigate");
  try {
   const dialog = await screen.findByRole("dialog", { name: "Connect your GitHub?" });
   fireEvent.click(within(dialog).getByRole("button", { name: "Continue to GitHub" }));
   await waitFor(() => expect(navigate).toHaveBeenCalledWith(GITHUB));
   expect(writes(f)).toEqual([expect.objectContaining({ method: "POST", path: "/v1/app/me/github/link", body: {} })]);
  } finally { f.close(); }
 });
 it("does not go anywhere when the answer is not GitHub's login page", async () => {
  const f = mount("/app/account?github=connect", r => (r.method === "POST" ? ok({ authorizeUrl: "https://evil.example/x" }) : r.path === "/v1/app/me/github" ? ok(NONE) : ok({})));
  const navigate = vi.spyOn(f.host, "navigate");
  try {
   const dialog = await screen.findByRole("dialog", { name: "Connect your GitHub?" });
   fireEvent.click(within(dialog).getByRole("button", { name: "Continue to GitHub" }));
   await within(dialog).findByRole("alert");
   expect(navigate).not.toHaveBeenCalled();
  } finally { f.close(); }
 });
 it("shows Cloud's refusal in its own words, with no step-up to go back to", async () => {
  const f = mount("/app/account?github=connect", r => (r.method === "POST" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "Start again from Rovara." } } } : r.path === "/v1/app/me/github" ? ok(NONE) : ok({})));
  try {
   const dialog = await screen.findByRole("dialog", { name: "Connect your GitHub?" });
   fireEvent.click(within(dialog).getByRole("button", { name: "Continue to GitHub" }));
   expect((await within(dialog).findByRole("alert")).textContent).toContain("Start again from Rovara.");
   expect(within(dialog).queryByTestId("fresh-sign-in")).toBeNull();
  } finally { f.close(); }
 });
 it("unlinks after a confirmation dialog, then shows none linked", async () => {
  let linked = true;
  const f = mount("/app/account", r => (r.method === "DELETE" && r.path === "/v1/app/me/github" ? (linked = false, ok({ unlinked: true })) : r.path === "/v1/app/me/github" ? ok(linked ? LINKED : NONE) : ok({})));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Disconnect your GitHub account" }));
   const dialog = await screen.findByRole("dialog", { name: "Unlink your GitHub account?" });
   expect(writes(f)).toHaveLength(0);
   fireEvent.click(within(dialog).getByRole("button", { name: "Unlink GitHub" }));
   await waitFor(() => expect(writes(f)).toEqual([expect.objectContaining({ method: "DELETE", path: "/v1/app/me/github" })]));
   await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
   expect(await screen.findByRole("button", { name: "Connect your GitHub" })).toBeTruthy();
   expect(screen.getByTestId("github-link-notice").textContent).toBe("Your GitHub account is disconnected.");
  } finally { f.close(); }
 });
 it("shows a fixed sentence for each link return and cleans the address", async () => {
  for (const word of ["linked", "cancelled", "taken", "exists", "not_available", "start_again", "unavailable"]) {
   const f = mount(`/app/account?github_link=${word}`, r => (r.path === "/v1/app/me/github" ? ok(NONE) : ok({})));
   try { expect((await screen.findByTestId("github-link-notice")).textContent).toBe(githubLinkNotice(word)!.text); await waitFor(() => expect(f.router.state.location.search).toBe("")); } finally { f.close(); }
  }
  const f = mount("/app/account?github_link=%3Cscript%3E", r => (r.path === "/v1/app/me/github" ? ok(NONE) : ok({})));
  try { await screen.findByRole("button", { name: "Connect your GitHub" }); expect(screen.queryByTestId("github-link-notice")).toBeNull(); } finally { f.close(); }
 });
 it("has no accessibility violations", async () => {
  const f = mount("/app/account", r => (r.path === "/v1/app/me/github" ? ok(LINKED) : ok({})));
  try { await screen.findByTestId("github-login"); await expectNoAxeViolations(f.container); } finally { f.close(); }
 });
});

it("renders the GitHub connection date in both viewer zones", async () => {
 await inViewerZones(async expected => {
  const f = mount("/app/account", r => r.path === "/v1/app/me/github" ? ok({ ...LINKED, linkedAt: VIEWER_INSTANT }) : ok({}));
  try { await screen.findByText("priya-dev");expect(f.container.textContent).toContain(expected.date); } finally { f.close(); }
 });
});
