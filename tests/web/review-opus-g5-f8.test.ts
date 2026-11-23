// @vitest-environment jsdom
// Opus delta review of d22bc89fa (G5, F8): the remembered write is for the person AND company that made it.
// R1: same company, another person. R2: a write still in flight while the frame switches to another company, answered 200 after the switch.
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
import { token } from "./support/script-token-fixture.js";

const me = "a".repeat(64), other = "b".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const ok = (body: unknown): ApiResponse => ({ status: 200, body });
const LOST: ApiResponse = { status: 401, body: { error: { code: "AUTH_REQUIRED", message: "Sign in again." } } };
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
const WENT = "Your change went through.", NEUTRAL = "Rovara couldn't read this page.";
const ME = "/v1/app/me", KEYS = "/v1/app/script-tokens";
const keysAnswer = { ...ScriptTokenMetadataListSchema.parse({ tokens: [token] }), canCreate: true };
const has = (text: string) => (document.body.textContent ?? "").includes(text);
type Who = "acme" | "beta" | "acme-other-person";

function mount(path: string) {
 let lost = false, who: Who = "acme", release: (() => void) | undefined, holdWrite = false;
 const nav = AppNavSchema.parse({ me: { developerId: me, name: "Priya", orgRole: "owner" }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features });
 const acme = AppMeResponseSchema.parse({ developer: { id: me, name: "Priya", orgRole: "owner", nameChosen: true }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const answers: Record<Who, unknown> = {
  acme,
  beta: AppMeResponseSchema.parse({ ...acme, org: { ...acme.org, orgId: "org_bbbbbbbbbbbbbbbbbbbb", name: "Beta" } }),
  "acme-other-person": AppMeResponseSchema.parse({ ...acme, developer: { ...acme.developer, id: other, name: "Ravi" } }),
 };
 const f = fakeHost(async (r: ApiRequest) => {
  if (r.path === "/v1/app/nav") return ok(nav);
  if (r.method === "GET" && lost) return LOST;
  if (r.method === "GET") return r.path === ME ? ok(answers[who]) : r.path === KEYS ? ok(keysAnswer) : ok({});
  if (holdWrite) await new Promise<void>(resolve => { release = resolve; });
  return ok({ token: { ...token, status: "revoked" } });
 });
 const query = createQueryClient(); query.setQueryData(["nav"], nav); f.storage.set("rovara.theme", "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [path] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, query, become: (to: Who) => { who = to; }, hold: () => { holdWrite = true; }, release: () => release?.(), loseAccess: () => { lost = true; }, close: () => { view.unmount(); router.dispose(); query.clear(); cleanup(); } };
}
type Page = ReturnType<typeof mount>;
const reread = async (f: Page) => { await f.query.invalidateQueries({ queryKey: ["g5-account-setup"] }); await f.query.invalidateQueries({ queryKey: ["g5-account-setup"] }); };
async function lostLine(f: Page) {
 f.loseAccess();
 await f.query.invalidateQueries({ queryKey: ["g5-account-setup"] });
 await screen.findByText("AUTOMATION-KEYS-READ-FAILED", { selector: "code" });
 const block = screen.getByRole("alert").closest("section") as HTMLElement;
 return within(block).getByText("What is safe").nextElementSibling?.textContent;
}
async function revoke() {
 fireEvent.click(await screen.findByRole("button", { name: "Revoke Nightly CI" }));
 fireEvent.click(within(await screen.findByRole("dialog", { name: "Revoke this automation key?" })).getByRole("button", { name: "Revoke key" }));
}

describe("review F8 (d22bc89fa)", () => {
 it("R1 same company, another person: Priya's revoke is never Ravi's 'went through'", async () => {
  const f = mount("/app/account/automation-keys");
  try {
   await revoke(); await screen.findByTestId("key-revoked-notice");
   f.become("acme-other-person"); await reread(f);
   await waitFor(() => expect((f.query.getQueryData<{ developer?: { id: string } }>(["g5-account-setup", ME]))?.developer?.id).toBe(other));
   await screen.findByRole("button", { name: "Revoke Nightly CI" });
   expect(await lostLine(f)).toBe(NEUTRAL);
   expect(has(WENT)).toBe(false);
  } finally { f.close(); }
 });
 it("R0 control: same person and company, the write then a 401 still says it went through", async () => {
  const f = mount("/app/account/automation-keys");
  try {
   await revoke(); await screen.findByTestId("key-revoked-notice");
   await reread(f);
   expect(await lostLine(f)).toBe(WENT);
  } finally { f.close(); }
 });
 it("R2 a revoke in flight in Acme, the frame switches to Beta, the revoke answers 200: Beta never says 'went through'", async () => {
  const f = mount("/app/account/automation-keys");
  try {
   f.hold(); await revoke();
   await waitFor(() => expect(f.request.mock.calls.some(([r]) => r.method === "POST")).toBe(true));
   f.become("beta"); await reread(f);
   await waitFor(() => expect(has("Beta")).toBe(true));
   f.release();
   await new Promise(resolve => setTimeout(resolve, 20));
   expect(await lostLine(f)).toBe(NEUTRAL);
   expect(has(WENT)).toBe(false);
  } finally { f.close(); }
 });
});
