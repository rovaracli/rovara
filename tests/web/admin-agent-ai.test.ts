// @vitest-environment jsdom
// DEC 240: the "AI for your agents" page (company admins). Three choices in plain words, no prices: Rovara's AI (charged per use), the
// company's own Anthropic key, and its own Bedrock shown as coming soon. A change (no step-up since owner DEC 254zzz73) sends the source
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
import { parseEndpointModels } from "../../packages/ui/src/screens/admin/agent-ai/AgentAiScreen.js";
import { visibleAdminGroups } from "../../packages/ui/src/screens/admin/admin-nav.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
// A fake endpoint key built at runtime (no key-shaped literal in the source; the public CI copy scans for them).
const FAKE_ENDPOINT_KEY = ["ep", "fake", "z".repeat(16)].join("-");

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
const view = (source: string | null, version: number, keyConnected: boolean | null = true) => ({ source, version, canChange: true, anthropicKeyConnected: keyConnected, choices: [{ source: "rovara", available: true }, { source: "anthropic_key", available: true }, { source: "bedrock_byo", available: false }] });

describe("AI for your agents page", () => {
 it("is a company-admin link in AI and connections", () => {
  expect(visibleAdminGroups("owner", false).find(group => group.id === "ai")!.links.map(link => link.label)).toContain("AI for your agents");
  expect(visibleAdminGroups("admin", false).find(group => group.id === "ai")?.links.map(link => link.label) ?? []).not.toContain("AI for your agents");
 });
 it("reads only the shape it expects", () => {
  expect(readAgentAi({ ...view("rovara", 3), choices: [{ source: "rovara", available: true }, { source: "bedrock_byo", available: "yes" }, { source: "<b>", available: true }], anthropicKeyConnected: "no" }))
   .toEqual({ source: "rovara", effectiveSource: null, sourceIsDefault: false, version: 3, available: { rovara: true, anthropic_key: false, bedrock_byo: false, openai_key: false, openrouter_key: false, custom_endpoint: false }, anthropicKeyConnected: null, listed: ["rovara", "anthropic_key", "bedrock_byo"], openaiKeyConnected: null, openrouterKeyConnected: null, endpointConnected: null, keysRevision: null });
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
   // No step-up: the Save is there at once, and no sign-in step is shown.
   expect(screen.queryByTestId("fresh-sign-in")).toBeNull();
   expect(screen.getByRole("button", { name: "Save" })).toBeTruthy();
  } finally { f.close(); }
 });
 it("reads the default only for a company with nothing saved, and only a real source", () => {
  expect(readAgentAi({ ...view(null, 0), effectiveSource: "rovara", sourceIsDefault: true })).toMatchObject({ source: null, effectiveSource: "rovara", sourceIsDefault: true });
  // A saved choice, a missing flag, or a made-up source never reads as a default.
  expect(readAgentAi({ ...view("anthropic_key", 1), effectiveSource: "rovara", sourceIsDefault: true })).toMatchObject({ effectiveSource: null, sourceIsDefault: false });
  expect(readAgentAi({ ...view(null, 0), effectiveSource: "rovara" })).toMatchObject({ effectiveSource: null, sourceIsDefault: false });
  expect(readAgentAi({ ...view(null, 0), effectiveSource: "<b>", sourceIsDefault: true })).toMatchObject({ effectiveSource: null, sourceIsDefault: false });
 });
 it("an exempt company on the default sees Rovara's AI as its source with a Use your own key action, and saving Rovara's AI is explicit", async () => {
  const sent: ApiRequest[] = [];
  const f = mount("/app/admin/agent-ai", (r) => { if (r.method === "PUT") sent.push(r); return { status: 200, body: { ...view(null, 0, false), effectiveSource: "rovara", sourceIsDefault: true } }; });
  try {
   expect((await screen.findByTestId("agent-ai-default")).textContent).toMatch(/Rovara's AI by default/u);
   expect(screen.queryByTestId("agent-ai-unset")).toBeNull();
   expect(document.body.textContent).toMatch(/Rovara's AI \(the default for your company\)/u);
   // No key yet: the action leads to the key page.
   expect(screen.getByTestId("agent-ai-use-own-key").getAttribute("href")).toBe("/app/admin/learning-ai");
   expect(((await screen.findByTestId("agent-ai-rovara")).querySelector("input") as HTMLInputElement).checked).toBe(true);
   const save = await screen.findByRole("button", { name: "Save" });
   expect((save as HTMLButtonElement).disabled).toBe(false);
   fireEvent.click(save);
   await waitFor(() => expect(sent).toHaveLength(1));
   expect(sent[0]!.body).toEqual({ expectedVersion: 0, source: "rovara" });
  } finally { f.close(); }
 });
 it("with a key connected, Use your own key picks the own-key choice", async () => {
  const f = mount("/app/admin/agent-ai", () => ({ status: 200, body: { ...view(null, 0, true), effectiveSource: "rovara", sourceIsDefault: true } }));
  try {
   fireEvent.click(await screen.findByRole("button", { name: "Use your own key" }));
   await waitFor(() => expect(((screen.getByTestId("agent-ai-anthropic_key")).querySelector("input") as HTMLInputElement).checked).toBe(true));
  } finally { f.close(); }
 });
 it("a company not on the default sees today's words (no default line)", async () => {
  const f = mount("/app/admin/agent-ai", () => ({ status: 200, body: view(null, 0, false) }));
  try {
   expect(await screen.findByTestId("agent-ai-unset")).toBeTruthy();
   expect(screen.queryByTestId("agent-ai-default")).toBeNull();
  } finally { f.close(); }
 });
 it("saves the picked source with the version read", async () => {
  const sent: ApiRequest[] = [];
  let saved: string | null = "anthropic_key"; let version = 4;
  const f = mount("/app/admin/agent-ai", (r) => { if (r.method === "PUT") { sent.push(r); saved = (r.body as { source: string }).source; version += 1; } return { status: 200, body: view(saved, version) }; });
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
 it("DEC 254t (A3): connects the company's own endpoint (key write-only) with the revision read; models one per line", async () => {
  expect(parseEndpointModels("our-coder=openai/gpt-5-mini\n  fast = anthropic/claude-haiku-4-5 \n")).toEqual([{ name: "our-coder", catalog: { provider: "openai", modelId: "gpt-5-mini" } }, { name: "fast", catalog: { provider: "anthropic", modelId: "claude-haiku-4-5" } }]);
  for (const bad of ["", "noequals", "=openai/x", "name=nocatalog", "name=openai/", Array.from({ length: 21 }, (_, i) => `m${String(i)}=openai/x`).join("\n")]) expect(parseEndpointModels(bad)).toBeUndefined();
  const sent: ApiRequest[] = [];
  const listed = { ...view(null, 0), choices: [...view(null, 0).choices, { source: "custom_endpoint", available: false }], endpointConnected: false, keysRevision: 7 };
  const f = mount("/app/admin/agent-ai", (r) => { if (r.method === "PUT") sent.push(r); return { status: 200, body: listed }; });
  try {
   expect((await screen.findByTestId("agent-ai-custom_endpoint")).textContent).toMatch(/Your own endpoint/u);
   expect(screen.getByTestId("agent-ai-no-endpoint")).toBeTruthy();
   fireEvent.change(screen.getByLabelText("Address (https, port 443)"), { target: { value: "https://llm.example.com/v1" } });
   fireEvent.change(screen.getByLabelText("Key"), { target: { value: FAKE_ENDPOINT_KEY } });
   fireEvent.change(screen.getByLabelText("Models, one per line: name=provider/model"), { target: { value: "our-coder=openai/gpt-5-mini" } });
   fireEvent.click(screen.getByRole("button", { name: "Connect endpoint" }));
   await waitFor(() => { expect(sent).toHaveLength(1); });
   expect(sent[0]!.path).toBe("/v1/app/org/agent-ai/endpoint");
   expect(sent[0]!.body).toMatchObject({ expectedRevision: 7, baseUrl: "https://llm.example.com/v1", key: FAKE_ENDPOINT_KEY, models: [{ name: "our-coder", catalog: { provider: "openai", modelId: "gpt-5-mini" } }] });
   expect(typeof (sent[0]!.body as { requestId: unknown }).requestId).toBe("string");
   await waitFor(() => { expect((screen.getByLabelText<HTMLInputElement>("Key")).value).toBe(""); });
  } finally { f.close(); }
 });
 it("says not connected yet when Cloud has no company data", async () => {
  const f = mount("/app/admin/agent-ai", () => ({ status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "not connected" } } }));
  try { expect(await screen.findByTestId("not-connected")).toBeTruthy(); } finally { f.close(); }
 });
});
