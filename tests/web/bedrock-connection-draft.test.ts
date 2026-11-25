// @vitest-environment jsdom
// The "Your own Bedrock" form keeps its draft and starts from the SAVED connection (never a built-in Region), and "Check Bedrock
// connection" re-runs the test for the saved connection (POST /org/bedrock/check). Each test uses its own company: the draft lives
// per company and person for as long as the page does, which is the point.
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema } from "@agentx/contracts/web";
// LEGACY HARNESS (WIRING-1B): this pinned test drives the screen that used to be mounted at /app/admin/{money/report,ai-spending,product-ai}; see support/legacy-admin-routes.ts.
import { appRoutes } from "./support/legacy-admin-routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { h } from "./support/h.js";
import { viewerTime } from "../../packages/ui/src/design/viewer-time.js";

const SONNET = "claude-sonnet-5-5", HAIKU = "claude-haiku-5-5";
const developerId = "a".repeat(64);
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
const unavailable = { status: 501, body: { error: { code: "NOT_ON_CODE_YET", message: "Not available yet." } } };
function mount({ orgId, path = "/app/admin/ai-spending", role = "owner", width = 1280, overrides = {}, respond }: { orgId: string; path?: string; role?: "owner" | "admin" | "member"; width?: number; overrides?: Record<string, ApiResponse>; respond?: (r: ApiRequest) => ApiResponse | undefined }) {
 const liveFeatures = { ...features, admin: role !== "member" };
 const identity = { developer: { id: developerId, name: "Priya", orgRole: role }, org: { orgId, name: "Acme", plan: "team" }, identities: [] };
 const nav = AppNavSchema.parse({ me: { developerId, name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: liveFeatures });
 const steps = ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"].map(stage => ({ stage, setting: null, refused: false, effective: { model: stage === "understand" ? HAIKU : SONNET, companyDefault: true } }));
 steps.find(step => step.stage === "security_review")!.refused = true;
 const bodies: Record<string, unknown> = {
  "/v1/app/me": identity, "/v1/app/nav": nav,
  "/v1/app/github/installations": { installations: [{ installationId: 7, accountLogin: "Acme", accountType: "Organization", repositorySelection: "all", status: "active" }] },
  "/v1/app/connections": { connections: [] },
  "/v1/app/org/engine-model": { model: SONNET, source: "company", offered: [SONNET, HAIKU], preselect: SONNET, canChange: role !== "member" },
  "/v1/app/org/agent-models": { revision: 1, steps, offered: [SONNET, HAIKU], canChange: true },
  "/v1/app/org/learning-model": { model: HAIKU, source: "install", offered: [SONNET, HAIKU], preselect: HAIKU, canChange: true },
  "/v1/app/org/agent-ai": { version: 1, source: "openrouter_key", choices: [{ source: "openrouter_key", available: true }] },
  "/v1/app/org/settings": { version: 1, modelGateway: { ready: true }, settings: { budgets: { companyMonthlyUsdMicros: 500_000_000 } } },
  "/v1/app/org/model-sources": { orgId, developerId, revision: 1, order: ["openrouter_key"], sources: [{ source: "openrouter_key", available: true, connected: true, inOrder: true }] },
 };
 const f = fakeHost(async (r: ApiRequest) => respond?.(r) ?? overrides[r.path] ?? (r.path in bodies ? { status: 200, body: bodies[r.path] } : unavailable));
 f.host.storage = { get: key => localStorage.getItem(key) ?? undefined, set: (key, value) => { localStorage.setItem(key, value); } };
 f.host.features.admin = liveFeatures.admin; f.host.kind = "web"; f.host.viewport = { width: () => width, subscribe: () => () => undefined };
 const query = createQueryClient(); query.setQueryData(["nav"], nav);
 const router = createMemoryRouter(appRoutes(liveFeatures), { initialEntries: [path] });
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }));
 return { ...f, ...ui, query, router, identity, bodies, close() { ui.unmount(); router.dispose(); query.clear(); } };
}


const ROLE = "arn:aws:iam::123456789012:role/RovaraBedrockInvoke-fixture";
const HAIKU_ID = "eu.anthropic.claude-haiku-4-5-v1:0";
const empty = { revision: 0, canChange: true, connection: null, removedUntil: null, usage: "AWS bills your account." };
const saved = (state = "ready", over: Record<string, unknown> = {}) => ({ ...empty, revision: 1, connection: { connected: true, connectedAt: Date.UTC(2026, 10, 20), updatedAt: Date.UTC(2026, 10, 20), roleArn: ROLE, region: "eu-west-1", allowGlobal: false, checkedAt: Date.UTC(2026, 10, 20, 12), models: [{ name: "claude-haiku-4-5", id: HAIKU_ID, state }], productModels: [], ...over } });
const setup = (orgId: string, region: string) => ({ companyId: orgId, region, externalId: "rvb-" + "a".repeat(40), brokerRoleArn: "arn:aws:iam::123456789012:role/broker", templateUrl: "https://docs.example/template.json", presets: { "claude-haiku-4-5": HAIKU_ID, "claude-sonnet-5-5": "eu.anthropic.claude-sonnet-5-5" } });
async function form() { await screen.findByTestId("learning-model-current"); await screen.findByTestId("step-model-build"); fireEvent.click(await screen.findByText("Connect company AI")); return screen.findByRole("region", { name: "Your own Bedrock" }); }
function input(element: HTMLElement): HTMLInputElement { if (!(element instanceof HTMLInputElement)) throw new Error("not an input"); return element; }
function button(element: HTMLElement): HTMLButtonElement { if (!(element instanceof HTMLButtonElement)) throw new Error("not a button"); return element; }
const regionBox = (card: HTMLElement) => input(within(card).getByLabelText("Bedrock region"));
const arnBox = (card: HTMLElement) => input(within(card).getByLabelText("Bedrock role ARN"));

it("starts empty, with no built-in Region, until a Region is chosen; Load needs one", async () => {
 const orgId = "org_cccccccccccccccccccc"; localStorage.clear();
 const f = mount({ orgId, overrides: { "/v1/app/org/bedrock": { status: 200, body: empty } } });
 try {
  const card = await form(); await within(card).findByLabelText("Bedrock region");
  expect(regionBox(card).value).toBe("");
  expect(arnBox(card).value).toBe("");
  expect(button(within(card).getByRole("button", { name: "Load Bedrock models" })).disabled).toBe(true);
  fireEvent.change(regionBox(card), { target: { value: "eu-west-1" } });
  expect(button(within(card).getByRole("button", { name: "Load Bedrock models" })).disabled).toBe(false);
 } finally { f.close(); localStorage.clear(); }
});

it("a remount keeps the Region, the role ARN and the ticked models the person entered", async () => {
 const orgId = "org_dddddddddddddddddddd"; localStorage.clear();
 const respond = (r: ApiRequest) => r.path === "/v1/app/org/bedrock/setup/eu-west-1" ? { status: 200, body: setup(orgId, "eu-west-1") } : r.path === "/v1/app/org/bedrock" ? { status: 200, body: empty } : undefined;
 const first = mount({ orgId, respond });
 try {
  const card = await form(); await within(card).findByLabelText("Bedrock region");
  fireEvent.change(regionBox(card), { target: { value: "eu-west-1" } });
  fireEvent.click(within(card).getByRole("button", { name: "Load Bedrock models" }));
  fireEvent.click(await within(card).findByLabelText("claude-haiku-4-5"));
  fireEvent.change(arnBox(card), { target: { value: ROLE } });
 } finally { first.close(); }
 // The page is torn down and built again (a dialog closed and opened, a step swapped, a refetch): same company, same person.
 const second = mount({ orgId, respond });
 try {
  const card = await form(); await within(card).findByLabelText("Bedrock region");
  await waitFor(() => expect(regionBox(card).value).toBe("eu-west-1"));
  expect(arnBox(card).value).toBe(ROLE);
  expect(input(within(card).getByLabelText("claude-haiku-4-5")).checked).toBe(true);
  expect(within(card).getByLabelText("claude-sonnet-5-5")).toBeTruthy();
  expect(input(within(card).getByLabelText("claude-sonnet-5-5")).checked).toBe(false);
 } finally { second.close(); localStorage.clear(); }
});

it("a company's draft never shows to another company on the same page", async () => {
 localStorage.clear();
 const a = mount({ orgId: "org_eeeeeeeeeeeeeeeeeeee", overrides: { "/v1/app/org/bedrock": { status: 200, body: empty } } });
 try { const card = await form(); await within(card).findByLabelText("Bedrock region"); fireEvent.change(regionBox(card), { target: { value: "us-east-2" } }); fireEvent.change(arnBox(card), { target: { value: ROLE } }); } finally { a.close(); }
 const b = mount({ orgId: "org_ffffffffffffffffffff", overrides: { "/v1/app/org/bedrock": { status: 200, body: empty } } });
 try { const card = await form(); await within(card).findByLabelText("Bedrock region"); expect(regionBox(card).value).toBe(""); expect(arnBox(card).value).toBe(""); } finally { b.close(); localStorage.clear(); }
});

it("starts from the saved connection: its Region, its role ARN and its models, and a remount keeps a change made on top", async () => {
 const orgId = "org_gggggggggggggggggggg"; localStorage.clear();
 const first = mount({ orgId, overrides: { "/v1/app/org/bedrock": { status: 200, body: saved() } } });
 try {
  const card = await form(); await within(card).findByLabelText("Bedrock region");
  expect(regionBox(card).value).toBe("eu-west-1");
  expect(arnBox(card).value).toBe(ROLE);
  expect(input(within(card).getByLabelText("claude-haiku-4-5")).checked).toBe(true);
  fireEvent.change(regionBox(card), { target: { value: "eu-central-1" } });
 } finally { first.close(); }
 const second = mount({ orgId, overrides: { "/v1/app/org/bedrock": { status: 200, body: saved() } } });
 try {
  const card = await form(); await within(card).findByLabelText("Bedrock region");
  await waitFor(() => expect(regionBox(card).value).toBe("eu-central-1"));
  expect(arnBox(card).value).toBe(ROLE);
 } finally { second.close(); localStorage.clear(); }
});

it("a saved Region is never replaced by us-west-2, and a draft from before the save gives way to the saved connection once it is saved", async () => {
 const orgId = "org_hhhhhhhhhhhhhhhhhhhh"; localStorage.clear();
 const f = mount({ orgId, respond: r => r.path === "/v1/app/org/bedrock" ? { status: 200, body: r.method === "PUT" ? saved("ready", { region: "eu-west-3" }) : empty } : r.path === "/v1/app/org/bedrock/setup/eu-west-3" ? { status: 200, body: setup(orgId, "eu-west-3") } : undefined });
 try {
  const card = await form(); await within(card).findByLabelText("Bedrock region");
  fireEvent.change(regionBox(card), { target: { value: "eu-west-3" } });
  fireEvent.click(within(card).getByRole("button", { name: "Load Bedrock models" }));
  fireEvent.click(await within(card).findByLabelText("claude-haiku-4-5"));
  fireEvent.change(arnBox(card), { target: { value: ROLE } });
  fireEvent.click(within(card).getByRole("button", { name: "Check and save Bedrock" }));
  await within(card).findByText(/Region: eu-west-3/u);
  expect(regionBox(card).value).toBe("eu-west-3");
  expect(arnBox(card).value).toBe(ROLE);
 } finally { f.close(); localStorage.clear(); }
});

it("Check Bedrock connection re-runs the test for the saved connection and shows the new time and each model's result", async () => {
 const orgId = "org_iiiiiiiiiiiiiiiiiiii"; localStorage.clear();
 const checkedAt = Date.UTC(2026, 10, 25, 15, 30);
 const f = mount({ orgId, respond: r => r.path === "/v1/app/org/bedrock" && r.method === "GET" ? { status: 200, body: saved("no_answer") } : r.path === "/v1/app/org/bedrock/check" ? { status: 200, body: { ...saved("ready", { checkedAt }), revision: 2 } } : undefined });
 try {
  const card = await form();
  await within(card).findByText("claude-haiku-4-5: AWS did not answer, check again");
  fireEvent.click(within(card).getByRole("button", { name: "Check Bedrock connection" }));
  await within(card).findByText("claude-haiku-4-5: ready");
  const posts = f.request.mock.calls.map(([r]) => r).filter(r => r.method === "POST");
  expect(posts).toHaveLength(1);
  expect(posts[0]!.path).toBe("/v1/app/org/bedrock/check");
  const sent = posts[0]!.body as { requestId: string; expectedRevision: number };
  expect(Object.keys(sent).sort()).toEqual(["expectedRevision", "requestId"]);
  expect(sent.requestId).toMatch(/^[0-9a-f-]{36}$/u);
  expect(sent.expectedRevision).toBe(1);
  expect(within(card).getByText((text) => text.includes(`Checked: ${viewerTime(checkedAt)}`))).toBeTruthy();
  // Nothing is held after a re-check: Remove is still offered, and another check can follow.
  expect(within(card).getByRole("button", { name: "Remove Bedrock connection" })).toBeTruthy();
  expect(localStorage.getItem(`bedrock:${orgId}:${developerId}:connection`) ?? "").toBe("");
 } finally { f.close(); localStorage.clear(); }
});

it("a re-check Cloud or AWS could not do says so (a 429 with the seconds left) and holds nothing (a retry is safe)", async () => {
 const orgId = "org_jjjjjjjjjjjjjjjjjjjj"; localStorage.clear();
 let sent = 0;
 const f = mount({ orgId, respond: r => r.path === "/v1/app/org/bedrock" && r.method === "GET" ? { status: 200, body: saved() } : r.path === "/v1/app/org/bedrock/check" ? (++sent === 1 ? { status: 429, body: { error: { code: "RATE_LIMITED", message: "Bedrock was checked a moment ago. Wait about 30 seconds, then check again." } } } : sent === 2 ? { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "The Bedrock connection is unavailable right now. Nothing was saved. Try again." } } } : { status: 200, body: { ...saved(), revision: 2 } }) : undefined });
 try {
  const card = await form(); await within(card).findByText("claude-haiku-4-5: ready");
  const press = () => fireEvent.click(within(card).getByRole("button", { name: "Check Bedrock connection" }));
  press(); await within(card).findByText(/^Checked recently\. Try again in \d+ seconds\.$/u);
  expect(within(card).queryByText(/Rovara didn't confirm/u)).toBeNull();
  await waitFor(() => expect(button(within(card).getByRole("button", { name: "Check Bedrock connection" })).disabled).toBe(false));
  press(); await within(card).findByText("The Bedrock connection is unavailable right now. Nothing was saved. Try again.");
  expect(within(card).queryByText(/Rovara didn't confirm/u)).toBeNull();
  await waitFor(() => expect(button(within(card).getByRole("button", { name: "Check Bedrock connection" })).disabled).toBe(false));
  press(); await waitFor(() => expect(sent).toBe(3));
  expect(within(card).getByRole("button", { name: "Remove Bedrock connection" })).toBeTruthy();
 } finally { f.close(); localStorage.clear(); }
});

it("shows a state it does not know in generic words instead of failing, and AWS-did-not-answer is never worded as a model state", async () => {
 const orgId = "org_kkkkkkkkkkkkkkkkkkkk"; localStorage.clear();
 const body = saved("ready", { models: [{ name: "claude-haiku-4-5", id: HAIKU_ID, state: "some_future_state" }, { name: "claude-sonnet-5-5", id: "eu.anthropic.claude-sonnet-5-5", state: "no_answer" }] });
 const f = mount({ orgId, overrides: { "/v1/app/org/bedrock": { status: 200, body } } });
 try {
  const card = await form();
  await within(card).findByText("claude-haiku-4-5: not known, check again");
  expect(within(card).getByText("claude-sonnet-5-5: AWS did not answer, check again")).toBeTruthy();
  expect(within(card).queryByText(/unavailable/u)).toBeNull();
 } finally { f.close(); localStorage.clear(); }
});

it("a refused re-check shows the fresh read first: a 429 after another admin's check shows THEIR time and the seconds left", async () => {
 const orgId = "org_llllllllllllllllllll"; localStorage.clear();
 const justNow = Date.now() - 10_000; let reads = 0;
 const f = mount({ orgId, respond: r => r.path === "/v1/app/org/bedrock" && r.method === "GET" ? { status: 200, body: ++reads <= 2 ? saved() : { ...saved("no_answer", { checkedAt: justNow }), revision: 2 } } : r.path === "/v1/app/org/bedrock/check" ? { status: 429, body: { error: { code: "RATE_LIMITED", message: "Bedrock was checked a moment ago. Wait about 30 seconds, then check again." } } } : undefined });
 try {
  const card = await form(); await within(card).findByText("claude-haiku-4-5: ready");
  fireEvent.click(within(card).getByRole("button", { name: "Check Bedrock connection" }));
  const words = await within(card).findByText(/^Checked recently\. Try again in \d+ seconds\.$/u);
  const left = Number(/in (\d+) seconds/u.exec(words.textContent ?? "")?.[1]);
  expect(left).toBeGreaterThan(10); expect(left).toBeLessThanOrEqual(20);
  // The page shows what the fresh read said, not the older time and states beside "checked recently".
  expect(within(card).getByText(`claude-haiku-4-5: AWS did not answer, check again`)).toBeTruthy();
  expect(within(card).getByText((text) => text.includes(`Checked: ${viewerTime(justNow)}`))).toBeTruthy();
 } finally { f.close(); localStorage.clear(); }
});

it("a re-check refused as 403 (access lost) or 404 (the connection is gone) takes the connection and the role ARN off the screen", async () => {
 for (const [status, orgId] of [[403, "org_mmmmmmmmmmmmmmmmmmmm"], [404, "org_nnnnnnnnnnnnnnnnnnnn"]] as const) {
  localStorage.clear(); let gone = false;
  const f = mount({ orgId, respond: r => r.path === "/v1/app/org/bedrock" && r.method === "GET" ? { status: 200, body: gone ? empty : saved() } : r.path === "/v1/app/org/bedrock/check" ? (gone = status === 404, { status, body: { error: { code: status === 403 ? "FORBIDDEN" : "NOT_FOUND", message: status === 403 ? "Only a company admin can see or change the company's Bedrock connection." : "No Bedrock connection is saved for this company." } } }) : undefined });
  try {
   const card = await form(); await within(card).findByText("claude-haiku-4-5: ready");
   expect(within(card).getByText(ROLE)).toBeTruthy();
   fireEvent.click(within(card).getByRole("button", { name: "Check Bedrock connection" }));
   if (status === 403) await within(card).findByRole("alert");
   else await within(card).findByText("No Bedrock role is connected.");
   expect(within(card).queryByText(ROLE)).toBeNull();
   expect(within(card).queryByText("claude-haiku-4-5: ready")).toBeNull();
   expect(within(card).queryByDisplayValue(ROLE)).toBeNull();
  } finally { f.close(); localStorage.clear(); }
 }
});

it("a re-check answered without a newer revision is not shown as done", async () => {
 const orgId = "org_oooooooooooooooooooo"; localStorage.clear();
 const f = mount({ orgId, respond: r => r.path === "/v1/app/org/bedrock" && r.method === "GET" ? { status: 200, body: saved() } : r.path === "/v1/app/org/bedrock/check" ? { status: 200, body: saved() } : undefined });
 try {
  const card = await form(); await within(card).findByText("claude-haiku-4-5: ready");
  fireEvent.click(within(card).getByRole("button", { name: "Check Bedrock connection" }));
  await within(card).findByText("Couldn't check the connection. Try again.");
 } finally { f.close(); localStorage.clear(); }
});
