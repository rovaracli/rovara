// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema, ModelSelectionPolicyPutSchema, StepSettingsSchema, StepThinkingLevelSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { COMPANY_EFFORT_LEVELS } from "../../packages/ui/src/api/stage-models.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { COMPANY_BUILD, REQUEST_ID, applied, companyCandidates, companyPolicyRaw, mid, needsConfirmation, previewPage } from "./support/company-policy-raw.js";

const POLICY = "/v1/app/org/model-selection-policy";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
type Handler = (request: ApiRequest) => ApiResponse | undefined | Promise<ApiResponse | undefined>;
function mount(options: { role?: "owner" | "admin" | "member"; path?: string; theme?: "light" | "dark"; handle?: Handler; policy?: unknown; width?: number } = {}) {
 const role = options.role ?? "owner";
 const nav = AppNavSchema.parse({ me: { developerId: "a".repeat(64), name: "Priya", orgRole: role }, org: { name: "Acme" }, homeCount: 0, projects: [], shared: { agents: [], sessions: [] }, features: { ...features, admin: true } });
 const me = AppMeResponseSchema.parse({ developer: { id: "a".repeat(64), name: "Priya", orgRole: role }, org: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", name: "Acme", plan: "team" }, identities: [] });
 const f = fakeHost(async request => {
  const custom = await options.handle?.(request);
  if (custom !== undefined) return custom;
  const path = request.path.split("?")[0];
  if (path === "/v1/app/nav") return { status: 200, body: nav };
  if (path === "/v1/app/me") return { status: 200, body: me };
  if (path === POLICY && request.method === "GET") return { status: 200, body: options.policy ?? companyPolicyRaw() };
  if (path === POLICY + "/preview") return { status: 200, body: previewPage((request.body as { cursor?: string }).cursor) };
  if (path === POLICY && request.method === "PUT") return { status: 200, body: applied(5, (request.body as { requestId: string }).requestId) };
  if (path === "/v1/app/org/model-sources") return { status: 200, body: { sources: [], order: ["rovara"] } };
  return { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } };
 });
 f.host.kind = "web";f.host.origin = "https://cell.example";f.host.viewport = { width: () => options.width ?? 1280, subscribe: () => () => undefined };
 const query = createQueryClient();query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", options.theme ?? "light");
 const router = createMemoryRouter(appRoutes(nav.features), { initialEntries: [options.path ?? "/app/admin/how-we-work"] });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(ThemeProvider, { host: f.host, children: h(RouterProvider, { router }) }) }) }), { theme: options.theme ?? "light" });
 const sent = () => f.request.mock.calls.map(([request]) => request).filter(request => request.method !== "GET");
 const calls = () => f.request.mock.calls.map(([request]) => request.method + " " + request.path.split("?")[0]);
 return { ...f, ...view, query, router, sent, calls, puts: () => sent().filter(request => request.method === "PUT" && request.path === POLICY), previews: () => sent().filter(request => request.path === POLICY + "/preview") };
}
const open = async (options: Parameters<typeof mount>[0] = {}) => { const world = mount(options);await screen.findByRole("heading", { name: "How we work (company)" });await screen.findByRole("region", { name: "Build" });return world; };
const card = (name: string) => screen.getByRole("region", { name });
const effort = (name: string) => within(card(name)).getByRole<HTMLSelectElement>("combobox", { name: "Effort" });
const lock = (name: string) => within(card(name)).getByRole("switch", { name: "Lock this stage" });
const review = async () => { fireEvent.click(screen.getByRole("button", { name: "Review changes" })); };
const save = async () => { await review();fireEvent.click(await screen.findByRole("button", { name: "Save company defaults" })); };

describe("the link from AI & connections", () => {
 it("is on the Code step models tab and leads to the company page", async () => {
  mount({ path: "/app/admin/models/steps" });
  const link = await screen.findByRole("link", { name: "Set company defaults and locks in How we work" });
  expect(link.getAttribute("href")).toBe("/app/admin/how-we-work");
  expect(await screen.findByText("Effective step choices, policy scope, selection reasons and approved fallbacks cannot be verified in this view yet.")).toBeTruthy();
 });
});

describe("the company cards", () => {
 it("shows a card per stage with its saved model, effort and lock, and reads the policy", async () => {
  const f = await open();
  expect(f.calls().filter(call => call === "GET " + POLICY)).toHaveLength(1);
  for (const name of ["Understand", "Plan", "Plan check", "Build", "Review (code and security)", "Pull request"]) expect(card(name)).toBeTruthy();
  expect(card("Build").textContent).toContain("Model: " + COMPANY_BUILD);
  expect(effort("Build").value).toBe("medium");
  expect(effort("Plan check").value).toBe("low");
  expect(effort("Review (code and security)").value).toBe("null");
  expect(lock("Review (code and security)").getAttribute("aria-checked")).toBe("true");
  expect(lock("Build").getAttribute("aria-checked")).toBe("false");
  expect(card("Plan").textContent).toContain("Model: Rovara's default");
  expect(within(card("Review (code and security)")).getByRole("switch", { name: "Different vendor than Build" }).getAttribute("aria-checked")).toBe("true");
  expect(within(card("Plan check")).getByRole("switch", { name: "Different vendor than Plan" })).toBeTruthy();
  expect(within(card("Build")).queryByRole("switch", { name: /Different vendor/ })).toBeNull();
  expect(screen.getByText("Pick models after the model list is available.")).toBeTruthy();
 });
 it("offers only the effort levels the step settings accept, plus Model default and Rovara's default, and no model control", async () => {
  await open();
  const offered = Array.from(effort("Build").options).map(option => option.value).filter(value => value !== "");
  expect(offered).toEqual(["inherit", "null", "off", "minimal", "low", "medium", "high"]);
  expect(within(card("Build")).queryByRole("combobox", { name: "Model" })).toBeNull();
 });
 it("offers nothing the step settings would refuse: every option fits them and lane C's policy PUT, and xhigh (which only lane C's scale holds) is not offered", () => {
  expect([...COMPANY_EFFORT_LEVELS]).toEqual([...StepThinkingLevelSchema.options]);
  for (const level of [...COMPANY_EFFORT_LEVELS, null]) {
   expect(StepSettingsSchema.safeParse({ thinkingLevel: level }).success).toBe(true);
   expect(ModelSelectionPolicyPutSchema.safeParse({ version: 1, requestId: REQUEST_ID, expectedRevision: 4, stepOverrides: { build: { model: mid(COMPANY_BUILD), thinkingLevel: level, locked: false } } }).success).toBe(true);
  }
  expect(StepSettingsSchema.safeParse({ thinkingLevel: "xhigh" }).success).toBe(false);
 });
 it("shows the API's 403 as the denied state", async () => {
  mount({ handle: request => request.path === POLICY ? { status: 403, body: { error: { code: "FORBIDDEN", message: "No." } } } : undefined });
  expect(await screen.findByText("You don't have permission to view this information.")).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Build" })).toBeNull();
 });
 it("shows an ordinary member the existing admin denial, with no policy read", async () => {
  const f = mount({ role: "member" });
  expect(await screen.findByRole("heading", { name: "Administration unavailable" })).toBeTruthy();
  expect(f.calls()).not.toContain("GET " + POLICY);
 });
 it("shows a phone the larger-screen message, as other admin pages do", async () => {
  const f = mount({ width: 360 });
  expect(await screen.findByText(/Open this on a larger screen/)).toBeTruthy();
  expect(f.calls()).not.toContain("GET " + POLICY);
 });
});

describe("locks need a complete tuple", () => {
 it("blocks saving a lock on a stage with no model, with a fixed message and no preview or save", async () => {
  const f = await open();
  fireEvent.click(lock("Plan"));
  expect(within(card("Plan")).getByText("To lock this stage, set its model, effort and, for a checking stage, the vendor rule first.")).toBeTruthy();
  await review();
  expect((await screen.findByRole("alert")).textContent).toBe("A locked stage needs a model, an effort (or Model default) and, for a checking stage, a vendor rule. Check: Plan.");
  expect(f.previews()).toHaveLength(0);
  expect(f.puts()).toHaveLength(0);
 });
 it("blocks a lock whose effort is not set, and accepts Model default (null) as an effort", async () => {
  const f = await open();
  fireEvent.change(effort("Build"), { target: { value: "inherit" } });
  fireEvent.click(lock("Build"));
  await review();
  expect((await screen.findByRole("alert")).textContent).toContain("Check: Build.");
  expect(f.previews()).toHaveLength(0);
  fireEvent.change(effort("Build"), { target: { value: "null" } });
  await review();
  await screen.findByText("This list may be incomplete.");
  expect(f.previews()).toHaveLength(1);
  expect((f.previews()[0]!.body as { stepOverrides: Record<string, unknown> }).stepOverrides.build).toEqual({ model: mid(COMPANY_BUILD), thinkingLevel: null, locked: true });
 });
 it("blocks a locked checking stage that has no different-vendor rule", async () => {
  const f = await open({ policy: companyPolicyRaw({ plan_check: { model: mid(COMPANY_BUILD), thinkingLevel: "low", locked: true } }) });
  expect(within(card("Plan check")).getByText(/To lock this stage/)).toBeTruthy();
  fireEvent.change(effort("Plan check"), { target: { value: "high" } });
  await review();
  expect((await screen.findByRole("alert")).textContent).toContain("Check: Plan check.");
  fireEvent.click(within(card("Plan check")).getByRole("switch", { name: "Different vendor than Plan" }));
  await review();
  await screen.findByText("This list may be incomplete.");
  expect((f.previews()[0]!.body as { stepOverrides: Record<string, unknown> }).stepOverrides.plan_check).toEqual({ model: mid(COMPANY_BUILD), thinkingLevel: "high", differentFrom: { stage: "plan", level: "vendor" }, locked: true });
 });
});

describe("Review changes", () => {
 it("lists affected projects a page at a time, marked incomplete, with fixed sentences and no counts", async () => {
  const f = await open();
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await review();
  await screen.findByText("This list may be incomplete.");
  const first = f.previews()[0]!.body as { version: number; expectedRevision: number; stepOverrides: Record<string, unknown>; cursor?: string };
  expect(first).toMatchObject({ version: 1, expectedRevision: 4 });
  expect(first.cursor).toBeUndefined();
  expect(Object.keys(first.stepOverrides).sort()).toEqual(["build", "code_review", "plan_check", "security_review"]);
  expect(screen.getByText("payments").parentElement!.textContent).toContain("Will change");
  expect(screen.getByText("payments").parentElement!.textContent).toContain("Your company locked this stage's model choice.");
  expect(screen.getByText("checkout").parentElement!.textContent).toContain("Will be blocked");
  expect(screen.getByText("checkout").parentElement!.textContent).toContain("Your company's rules do not allow this model.");
  expect(screen.getByText("checkout").parentElement!.textContent).toContain("This project couldn't be checked.");
  expect(screen.getByText("ledger").parentElement!.textContent).toContain("No change");
  expect(screen.getByText("mobile").parentElement!.textContent).toContain("Couldn't be checked");
  expect(screen.queryByText("billing")).toBeNull();
  const panel = screen.getByRole("region", { name: "Review of company changes" });
  expect(panel.textContent).not.toMatch(/\d/);
  fireEvent.click(within(panel).getByRole("button", { name: "Show more" }));
  await screen.findByText("billing");
  expect((f.previews()[1]!.body as { cursor?: string }).cursor).toBe("5");
  expect(screen.getByText("payments")).toBeTruthy();
  expect(within(panel).queryByRole("button", { name: "Show more" })).toBeNull();
  expect(panel.textContent).not.toMatch(/\d/);
  expect(f.puts()).toHaveLength(0);
 });
 it("says so when the preview fails, and still lets the person save", async () => {
  await open({ handle: request => request.path === POLICY + "/preview" ? { status: 503, body: { error: { code: "UNAVAILABLE", message: "private detail" } } } : undefined });
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await review();
  expect(await screen.findByText("Couldn't check which projects are affected. You can still save.")).toBeTruthy();
  expect(screen.queryByText("private detail")).toBeNull();
  expect(screen.getByRole("button", { name: "Save company defaults" })).toBeTruthy();
 });
 it("is not offered until something changed, and an edit after the review clears it", async () => {
  await open();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(true);
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await review();
  await screen.findByRole("region", { name: "Review of company changes" });
  fireEvent.change(effort("Build"), { target: { value: "low" } });
  expect(screen.queryByRole("region", { name: "Review of company changes" })).toBeNull();
  fireEvent.change(effort("Build"), { target: { value: "medium" } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(true);
 });
});

describe("Save", () => {
 it("sends the full overrides with a request id and the expected revision, writes both reviewers from the Review row, and says what applies", async () => {
  const f = await open();
  fireEvent.change(effort("Review (code and security)"), { target: { value: "high" } });
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await save();
  expect(await screen.findByText("Saved. New tasks use these defaults; running tasks keep theirs.")).toBeTruthy();
  const body = f.puts()[0]!.body as { version: number; requestId: string; expectedRevision: number; stepOverrides: Record<string, unknown> };
  expect(body.version).toBe(1);
  expect(body.requestId).toMatch(/^[0-9a-f-]{36}$/);
  expect(body.expectedRevision).toBe(4);
  expect(ModelSelectionPolicyPutSchema.safeParse(body).success).toBe(true);
  expect(body.stepOverrides).toEqual({
   build: { model: mid(COMPANY_BUILD), thinkingLevel: "high", locked: false },
   code_review: { model: mid("anthropic/claude-opus-5-5"), thinkingLevel: "high", differentFrom: { stage: "build", level: "vendor" }, locked: true },
   security_review: { model: mid("anthropic/claude-opus-5-5"), thinkingLevel: "high", differentFrom: { stage: "build", level: "vendor" }, locked: true },
   plan_check: { thinkingLevel: "low", locked: false },
  });
 });
 it("reads the policy again after a save", async () => {
  const f = await open();
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await save();
  await screen.findByText("Saved. New tasks use these defaults; running tasks keep theirs.");
  await waitFor(() => expect(f.calls().filter(call => call === "GET " + POLICY).length).toBeGreaterThan(1));
 });
 it("says another admin must confirm a less-safe change, with the confirmation link", async () => {
  const f = await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 202, body: needsConfirmation("https://cell.example", (request.body as { requestId: string }).requestId) } : undefined });
  fireEvent.click(lock("Review (code and security)"));
  await save();
  expect(await screen.findByText("Another company admin must confirm this less-safe change.")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open confirmation" }));
  expect(f.host.openExternal).toHaveBeenCalledWith("https://cell.example/v1/app/approve/" + "A".repeat(43));
  expect(screen.queryByText(/Saved\./)).toBeNull();
 });
 it("tells a single admin when they can confirm it themselves", async () => {
  await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 202, body: needsConfirmation("https://cell.example", (request.body as { requestId: string }).requestId, "2026-10-30T12:00:00.000Z") } : undefined });
  fireEvent.click(lock("Review (code and security)"));
  await save();
  expect(await screen.findByText("You're the only admin. You can confirm this yourself after 10/30/2026, 12:00:00 PM UTC (a 24-hour safety wait).")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open confirmation" })).toBeTruthy();
  expect(screen.queryByText("Another company admin must confirm this less-safe change.")).toBeNull();
 });
 it("shows no link for a confirmation address that is not this app's", async () => {
  await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 202, body: needsConfirmation("https://evil.example", (request.body as { requestId: string }).requestId) } : undefined });
  fireEvent.click(lock("Review (code and security)"));
  await save();
  expect(await screen.findByText("Another company admin must confirm this less-safe change.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Open confirmation" })).toBeNull();
 });
 it("says the settings changed on a stale revision, and Reload reads them again", async () => {
  let stale = true;
  const f = await open({ handle: request => request.method === "PUT" && request.path === POLICY && stale ? { status: 409, body: { error: { code: "POLICY_STALE", message: "Stale." } } } : undefined });
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await save();
  expect((await screen.findByRole("alert")).textContent).toContain("The model settings changed. Reload and try again.");
  stale = false;
  const before = f.calls().filter(call => call === "GET " + POLICY).length;
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(f.calls().filter(call => call === "GET " + POLICY).length).toBe(before + 1));
  await waitFor(() => expect(screen.queryByText(/The model settings changed/)).toBeNull());
 });
 it("says a refusal in its fixed sentence and never shows the server's words", async () => {
  await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 400, body: { error: { code: "LOCK_UNSATISFIABLE", message: "private detail" } } } : undefined });
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await save();
  expect((await screen.findByRole("alert")).textContent).toBe("The company lock cannot be met with verified models.");
  expect(screen.queryByText(/private detail/)).toBeNull();
 });
 it("keeps the same request id when the same save is tried again after a failure, and a new one after an edit", async () => {
  let fail = true;
  const f = await open({ handle: request => request.method === "PUT" && request.path === POLICY && fail ? { status: 500, body: { error: { code: "SERVER_ERROR", message: "x" } } } : undefined });
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await save();
  expect((await screen.findByRole("alert")).textContent).toBe("Couldn't save the company defaults. Try again.");
  fail = false;
  fireEvent.click(screen.getByRole("button", { name: "Save company defaults" }));
  await screen.findByText("Saved. New tasks use these defaults; running tasks keep theirs.");
  const ids = f.puts().map(request => (request.body as { requestId: string }).requestId);
  expect(ids).toHaveLength(2);
  expect(ids[0]).toBe(ids[1]);
 });
 it("shows the API's 403 on save as a permission message", async () => {
  await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 403, body: { error: { code: "FORBIDDEN", message: "No." } } } : undefined });
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await save();
  expect((await screen.findByRole("alert")).textContent).toBe("You don't have permission to change the company defaults.");
 });
 it("clears a choice back to Rovara's default by leaving it out of the overrides", async () => {
  const f = await open();
  fireEvent.change(effort("Plan check"), { target: { value: "inherit" } });
  await save();
  await screen.findByText("Saved. New tasks use these defaults; running tasks keep theirs.");
  expect(Object.keys((f.puts()[0]!.body as { stepOverrides: Record<string, unknown> }).stepOverrides).sort()).toEqual(["build", "code_review", "security_review"]);
 });
});

describe("a Review row whose reviewers differ", () => {
 it("says so, and sets both the same on a change", async () => {
  const f = await open({ policy: companyPolicyRaw({ security_review: { model: mid("anthropic/claude-opus-5-5"), thinkingLevel: "low", locked: false } }) });
  expect(within(card("Review (code and security)")).getByText(/have different settings today/)).toBeTruthy();
  fireEvent.change(effort("Review (code and security)"), { target: { value: "high" } });
  await review();
  await screen.findByText("This list may be incomplete.");
  const overrides = f.previews()[0]!.body as { stepOverrides: Record<string, { thinkingLevel: string; locked: boolean }> };
  expect(overrides.stepOverrides.code_review).toEqual(overrides.stepOverrides.security_review);
  expect(overrides.stepOverrides.code_review!.thinkingLevel).toBe("high");
 });
});

describe("accessibility", () => {
 for (const theme of ["light", "dark"] as const) it(`has no axe violations in ${theme}, with the review open`, async () => {
  const f = await open({ theme });
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await review();
  await screen.findByText("This list may be incomplete.");
  await act(async () => { await expectNoAxeViolations(f.container); });
 });
});
