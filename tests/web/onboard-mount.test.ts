// @vitest-environment jsdom
// G5 ship: /app/onboard on the REAL router. The rebuilt setup frames (company setup progress, workflows for setup, setup run progress, setup run journal)
// carry the LIVE wizard steps (same components as before, one implementation): no wizard action is lost, the live steps do not depend on the read frames.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { checklist, github, run, journal, offered, slack } from "./read-only/account-setup-read/fixtures.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const project = { name: "web", description: "Customer fixes", status: "active", latestRevision: 2, repositories: [{ fullName: "acme/web", defaultBranch: "main" }], myRole: "maintainer", setup: { status: "failed", failedStep: "Install dependencies failed" }, settings: { setupCommands: ["npm ci"], testCommands: ["npm test"], devcontainer: null, allowedDomains: [] }, createdAt: "2026-10-23T12:00:00.000Z", createdBy: { developerId: "a".repeat(64), name: "Maya" } };
afterEach(() => { cleanup(); });

function mount(path: string, options: { role?: string; connected?: boolean } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const identity = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: role, nameChosen: true }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const reply = (r: ApiRequest): ApiResponse => {
  if (r.path === "/v1/app/nav") return ok(nav);
  if (r.path === "/v1/app/me") return ok(identity);
  if (r.method !== "GET") return ok({ project, warnings: [] });
  if (r.path === "/v1/app/github/installations") return ok({ installations: options.connected === false ? [] : [{ installationId: 55, accountLogin: "acme", accountType: "Organization", repositorySelection: "selected", status: "active" }] });
  if (r.path === "/v1/app/github/connections") return ok({ installations: options.connected === false ? [] : [{ installationId: 55, accountLogin: "acme", status: "active", connectedAt: "2026-11-17T12:00:00Z", connectedBy: { kind: "operator" } }] });
  if (r.path === "/v1/app/slack") return ok(slack);
  if (r.path === "/v1/app/projects/web") return ok(project);
  if (r.path === "/v1/app/projects/web/setup-status") return ok(checklist);
  if (r.path === "/v1/app/projects/web/setup-agent") return ok(run);
  if (r.path === "/v1/app/projects/web/setup-agent/journal") return ok(journal);
  if (r.path.startsWith("/v1/app/agents?")) return ok(r.path.includes("scope=all") ? offered : { agents: [] });
  if (r.path === "/v1/app/org") return ok({ org: identity.org, role });
  if (r.path.startsWith("/v1/app/github/repository-choices")) return ok({ repositories: [], incomplete: false });
  return ok({});
 };
 const f = fakeHost(async r => reply(r));
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...view, router, query, close: () => { view.unmount(); router.dispose(); query.clear(); cleanup(); } };
}
void github;
const h1s = () => screen.getAllByRole("heading", { level: 1 }).map(node => node.textContent);

describe("/app/onboard on the real router", () => {
 it("company wizard: the Company setup progress frame with the live steps under it, one h1", async () => {
  const f = mount("/app/onboard", { connected: false });
  try {
   expect(await screen.findByRole("heading", { level: 1, name: "Company setup progress" })).toBeTruthy();
   expect(h1s()).toEqual(["Company setup progress"]);
   expect(await screen.findByRole("heading", { level: 2, name: "Set up your company" })).toBeTruthy();
   // The live step: nothing about it was dropped (progress list, the GitHub step and its own controls).
   expect(screen.getByRole("navigation", { name: "Onboarding progress" })).toBeTruthy();
   expect(await screen.findByRole("heading", { level: 2, name: "Connect GitHub" })).toBeTruthy();
   expect(screen.getByRole("list", { name: "Observed connections" })).toBeTruthy();
   expect(screen.getByText("Read back from Rovara. The steps below make the changes.")).toBeTruthy();
   expect(screen.queryByText("Nothing here can be edited from this page.")).toBeNull();
  } finally { f.close(); }
 });
 it("the live steps stay when the read frame cannot read who you are", async () => {
  const f = mount("/app/onboard", { connected: false });
  try {
   await screen.findByRole("heading", { level: 2, name: "Connect GitHub" });
   // A later access-ended identity read (403) ends the frame's facts, not the live step.
   f.request.mockImplementation(async r => (r.path === "/v1/app/me" && f.request.mock.calls.length > 0 ? { status: 403, body: { error: { code: "FORBIDDEN", message: "x" } } } : { status: 200, body: {} }));
   await f.query.refetchQueries({ predicate: q => q.queryKey.includes("/v1/app/me") && q.queryKey[0] === "g5-account-setup" });
   await waitFor(() => expect(screen.queryByRole("list", { name: "Observed connections" })).toBeNull());
   expect(screen.getByRole("heading", { level: 2, name: "Connect GitHub" })).toBeTruthy();
  } finally { f.close(); }
 });
 it("workflows for setup: the frame with the live Agents step (Rovara Code prechecked), no write", async () => {
  const f = mount("/app/onboard?project=web&step=agents");
  try {
   expect(await screen.findByRole("heading", { level: 1, name: "web" })).toBeTruthy();
   expect(await screen.findByRole("checkbox", { name: "Rovara Code" })).toHaveProperty("checked", true);
   expect(screen.getByText(/The step below is where they are added\./)).toBeTruthy();
   expect(f.request.mock.calls.every(([r]) => r.method === "GET")).toBe(true);
  } finally { f.close(); }
 });
 it("F2: an access-ended identity read leaves the live Agents step and its half-made choice in place", async () => {
  const f = mount("/app/onboard?project=web&step=agents");
  try {
   const box = await screen.findByRole("checkbox", { name: "Rovara Code" });
   expect(box).toHaveProperty("checked", true);
   fireEvent.click(box);
   expect(screen.getByRole("checkbox", { name: "Rovara Code" })).toHaveProperty("checked", false);
   const answer = f.request.getMockImplementation()!;
   f.request.mockImplementation(async r => (r.path === "/v1/app/me" ? { status: 403, body: { error: { code: "FORBIDDEN", message: "x" } } } : answer(r)));
   await f.query.refetchQueries({ predicate: q => q.queryKey[0] === "g5-account-setup" && q.queryKey.includes("/v1/app/me") });
   await waitFor(() => expect((document.body.textContent ?? "").includes("SETUP-AGENTS-READ-FAILED")).toBe(true));
   expect(screen.getByRole("checkbox", { name: "Rovara Code" })).toHaveProperty("checked", false);
  } finally { f.close(); }
 });
 it("setup step: the live commands form, with the run progress and journal read views under it (owner), none for a member", async () => {
  const f = mount("/app/onboard?project=web&step=setup");
  try {
   expect(await screen.findByLabelText("Setup commands")).toHaveProperty("value", "npm ci");
   const region = await screen.findByRole("region", { name: "Setup run progress" });
   expect(region).toBeTruthy();
   expect(await screen.findByRole("region", { name: "Setup run journal" })).toBeTruthy();
   expect(screen.getByRole("heading", { level: 2, name: "Setup run, read back from Rovara" })).toBeTruthy();
   expect(within(region).getByText("Setup is running")).toBeTruthy();
  } finally { f.close(); }
  const m = mount("/app/onboard?project=web&step=setup", { role: "member" });
  try {
   await screen.findByText(/Only owners and admins can add projects/);
   await waitFor(() => expect(document.querySelector(".g5-skeleton-rows")).toBeNull());
   expect(screen.queryByRole("region", { name: "Setup run progress" })).toBeNull();
  } finally { m.close(); }
 });
 it("the older invite and first-task steps are the live page alone", async () => {
  const f = mount("/app/onboard?project=web&step=invite");
  try {
   await screen.findByRole("heading", { level: 1, name: "Set up web" });
   expect(screen.queryByRole("region", { name: "Setup run progress" })).toBeNull();
   expect(document.querySelector(".g5-account-setup-read")).toBeNull();
  } finally { f.close(); }
 });
 it("is a lazy route with no static import of the screen or the page", () => {
  const route = appRoutes(features).flatMap(entry => entry.children ?? [entry]).find(entry => entry.path === "onboard");
  expect(route?.lazy).toBeTypeOf("function"); expect(route?.element).toBeUndefined(); expect(route?.Component).toBeUndefined();
  const code = readFileSync(resolve("packages/ui/src/routes.tsx"), "utf8");
  expect(code).toMatch(/import\("\.\/screens\/account-setup-read\/OnboardPage\.js"\)/);
  expect(code).not.toMatch(/import\s[^;]*from\s*"\.\/screens\/(?:onboarding|account-setup-read)\//);
  expect(code).not.toMatch(/import\("\.\/screens\/onboarding\/OnboardScreen\.js"\)/);
 });
});
