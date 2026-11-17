// @vitest-environment jsdom
// DEC 240: the "AI for your agents" page (company admins). Three choices in plain words, no prices: Rovara's AI (charged per use), the
// company's own Anthropic key, and its own Bedrock shown as coming soon. A change waits for the fresh sign-in step and sends the source
// with the version read; "not connected yet" when Cloud has no company data.
import { beforeEach, describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { readAgentAi } from "../../packages/ui/src/api/admin-agent-ai.js";
import { visibleAdminGroups } from "../../packages/ui/src/screens/admin/admin-nav.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";

const me = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
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
 return { ...f, ...view, close: () => { view.unmount(); router.dispose(); query.clear(); } };
}
function confirmedPath(path: string, nonce = "n-1"): string { seeded.set("rovara.stepup.nonce", JSON.stringify({ nonce, at: Date.now() })); return `${path}?confirmed=${nonce}`; }
const view = (source: string | null, version: number, keyConnected: boolean | null = true) => ({ source, version, canChange: true, anthropicKeyConnected: keyConnected, choices: [{ source: "rovara", available: true }, { source: "anthropic_key", available: true }, { source: "bedrock_byo", available: false }] });

describe("AI for your agents page", () => {
 it("is a company-admin link in AI and connections", () => {
  expect(visibleAdminGroups("owner", false).find(group => group.id === "ai")!.links.map(link => link.label)).toContain("AI for your agents");
  expect(visibleAdminGroups("admin", false).find(group => group.id === "ai")?.links.map(link => link.label) ?? []).not.toContain("AI for your agents");
 });
 it("reads only the shape it expects", () => {
  expect(readAgentAi({ ...view("rovara", 3), choices: [{ source: "rovara", available: true }, { source: "bedrock_byo", available: "yes" }, { source: "<b>", available: true }], anthropicKeyConnected: "no" }))
   .toEqual({ source: "rovara", version: 3, available: { rovara: true, anthropic_key: false, bedrock_byo: false, openai_key: false, openrouter_key: false }, anthropicKeyConnected: null, listed: ["rovara", "anthropic_key", "bedrock_byo"], openaiKeyConnected: null, openrouterKeyConnected: null });
  expect(() => readAgentAi({ source: "openai", version: 1 })).toThrow();
  expect(() => readAgentAi({ source: null })).toThrow();
 });
 it("shows the three choices in plain words, your own Bedrock coming soon and not choosable, and no price", async () => {
  const f = mount("/app/admin/agent-ai", () => ({ status: 200, body: view(null, 0, false) }));
  try {
   expect((await screen.findByTestId("agent-ai-rovara")).textContent).toMatch(/Rovara's AI.*Charged per use/u);
   expect(screen.getByTestId("agent-ai-anthropic_key").textContent).toMatch(/Your own Anthropic key/u);
   expect(screen.getByTestId("agent-ai-bedrock_byo").textContent).toMatch(/Your own Bedrock \(coming soon\)/u);
   expect((screen.getByTestId("agent-ai-bedrock_byo").querySelector("input") as HTMLInputElement).disabled).toBe(true);
   expect(screen.getByTestId("agent-ai-no-key")).toBeTruthy();
   expect(screen.getByTestId("agent-ai-unset")).toBeTruthy();
   expect(document.body.textContent).not.toMatch(/\$\s?\d/u);
   // Before the fresh sign-in: no save.
   expect(screen.getByTestId("fresh-sign-in")).toBeTruthy();
   expect(screen.queryByRole("button", { name: "Save" })).toBeNull();
  } finally { f.close(); }
 });
 it("saves the picked source with the version read", async () => {
  const sent: ApiRequest[] = [];
  let saved: string | null = "anthropic_key"; let version = 4;
  const f = mount(confirmedPath("/app/admin/agent-ai"), (r) => { if (r.method === "PUT") { sent.push(r); saved = (r.body as { source: string }).source; version += 1; } return { status: 200, body: view(saved, version) }; });
  try {
   const rovara = (await screen.findByTestId("agent-ai-rovara")).querySelector("input") as HTMLInputElement;
   fireEvent.click(rovara);
   fireEvent.click(screen.getByRole("button", { name: "Save" }));
   await waitFor(() => { expect(sent).toHaveLength(1); });
   expect(sent[0]!.path).toBe("/v1/app/org/agent-ai");
   expect(sent[0]!.body).toEqual({ expectedVersion: 4, source: "rovara" });
   expect(await screen.findByText(/Agents now use Rovara's AI/u)).toBeTruthy();
  } finally { f.close(); }
 });
 it("DEC 254t: lists the own OpenAI / OpenRouter key only when Cloud lists it, not choosable until its key is connected", async () => {
  const listed = { ...view("anthropic_key", 2), choices: [...view(null, 0).choices, { source: "openai_key", available: false }, { source: "openrouter_key", available: true }], openaiKeyConnected: false, openrouterKeyConnected: true };
  const f = mount("/app/admin/agent-ai", () => ({ status: 200, body: listed }));
  try {
   expect((await screen.findByTestId("agent-ai-openai_key")).textContent).toMatch(/Your own OpenAI key/u);
   expect((screen.getByTestId("agent-ai-openai_key").querySelector("input") as HTMLInputElement).disabled).toBe(true);
   expect(screen.getByTestId("agent-ai-no-openai-key")).toBeTruthy();
   expect((screen.getByTestId("agent-ai-openrouter_key").querySelector("input") as HTMLInputElement).disabled).toBe(false);
   expect(screen.queryByTestId("agent-ai-no-openrouter-key")).toBeNull();
  } finally { f.close(); }
  const today = mount("/app/admin/agent-ai", () => ({ status: 200, body: view(null, 0) }));
  try {
   await screen.findByTestId("agent-ai-rovara");
   expect(screen.queryByTestId("agent-ai-openai_key")).toBeNull();
   expect(screen.queryByTestId("agent-ai-openrouter_key")).toBeNull();
  } finally { today.close(); }
 });
 it("says not connected yet when Cloud has no company data", async () => {
  const f = mount("/app/admin/agent-ai", () => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } }));
  try { expect(await screen.findByTestId("not-connected")).toBeTruthy(); } finally { f.close(); }
 });
});
