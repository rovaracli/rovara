// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within, act } from "@testing-library/react";
import { createMemoryRouter, RouterProvider } from "react-router";
import { QueryClientProvider, focusManager } from "@tanstack/react-query";
import { AppNavSchema, AppMeResponseSchema, ModelSelectionPolicyAppliedSchema, ModelSelectionPolicyPendingSchema, ModelSelectionPolicyPutSchema, ModelSelectionPolicyResponseSchema, STAGE_MODEL_THINKING_LEVELS, StepSettingsSchema, StepThinkingLevelSchema } from "@agentx/contracts/web";
import { appRoutes } from "../../packages/ui/src/routes.js";
import { AppHostProvider, type ApiRequest, type ApiResponse } from "../../packages/ui/src/host.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { ThemeProvider } from "../../packages/ui/src/theme.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { COMPANY_BUILD, REQUEST_ID, applied, companyCandidates, companyPolicyRaw, mid, needsConfirmation, previewPage } from "./support/company-policy-raw.js";

const POLICY = "/v1/app/org/model-selection-policy";
const features = { localAgents: false, admin: true, usage: false, chains: false, describe: false, notices: false };
type Handler = (request: ApiRequest) => ApiResponse | undefined | Promise<ApiResponse | undefined>;
function mount(options: { role?: "owner" | "admin" | "member"; path?: string; theme?: "light" | "dark"; handle?: Handler; policy?: unknown; width?: number; refocusRereads?: boolean } = {}) {
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
 const query = createQueryClient();if (options.refocusRereads === true) query.setDefaultOptions({ queries: { staleTime: 0, retry: false, refetchOnWindowFocus: true, refetchOnReconnect: true } });query.setQueryData(["nav"], nav);f.storage.set("rovara.theme", options.theme ?? "light");
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
  for (const name of ["Plan (and Understand)", "Plan check", "Build", "Review (code and security)", "Pull request"]) expect(card(name)).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Understand" })).toBeNull();
  expect(card("Build").textContent).toContain("Model: " + COMPANY_BUILD);
  expect(effort("Build").value).toBe("medium");
  expect(effort("Plan check").value).toBe("low");
  expect(effort("Review (code and security)").value).toBe("null");
  expect(lock("Review (code and security)").getAttribute("aria-checked")).toBe("true");
  expect(lock("Build").getAttribute("aria-checked")).toBe("false");
  expect(card("Plan (and Understand)").textContent).toContain("Model: Rovara's default");
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
  expect([...STAGE_MODEL_THINKING_LEVELS]).toEqual([...StepThinkingLevelSchema.options]);
  for (const level of [...STAGE_MODEL_THINKING_LEVELS, null]) {
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
  fireEvent.click(lock("Plan (and Understand)"));
  expect(within(card("Plan (and Understand)")).getByText("To lock this stage, set its model, effort and, for a checking stage, the vendor rule first.")).toBeTruthy();
  await review();
  expect((await screen.findByRole("alert")).textContent).toBe("A locked stage needs a model, an effort (or Model default) and, for a checking stage, a vendor rule. Check: Plan (and Understand).");
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

describe("review defaults (owner decision 2026-11-02)", () => {
 const vendor = (name: string, reference: string) => within(card(name)).getByRole("switch", { name: "Different vendor than " + reference });
 it("shows the different-vendor switch on, with the default's words, for a checking step nobody has set a model or rule for", async () => {
  await open({ policy: companyPolicyRaw({ code_review: { thinkingLevel: null, locked: false }, security_review: { thinkingLevel: null, locked: false } }) });
  expect(vendor("Plan check", "Plan").getAttribute("aria-checked")).toBe("true");
  expect(within(card("Plan check")).getByText("Not set: this step uses the strongest model from a different company than the step it checks, when your company has one available.")).toBeTruthy();
  expect(vendor("Review (code and security)", "Build").getAttribute("aria-checked")).toBe("true");
 });
 it("keeps it off, without the note, where a model is set and no vendor rule", async () => {
  await open({ policy: companyPolicyRaw({ plan_check: { model: mid(COMPANY_BUILD), thinkingLevel: "low", locked: false } }) });
  expect(vendor("Plan check", "Plan").getAttribute("aria-checked")).toBe("false");
  expect(within(card("Plan check")).queryByText(/Not set: this step uses/)).toBeNull();
 });
 it("turning the default off saves the explicit different-model rule; turning it on again removes it and returns to the default (nothing left to save)", async () => {
  const f = await open();
  expect(vendor("Plan check", "Plan").getAttribute("aria-checked")).toBe("true");
  fireEvent.click(vendor("Plan check", "Plan"));
  expect(vendor("Plan check", "Plan").getAttribute("aria-checked")).toBe("false");
  await review();
  await screen.findByText("This list may be incomplete.");
  expect((f.previews()[0]!.body as { stepOverrides: Record<string, unknown> }).stepOverrides.plan_check).toEqual({ thinkingLevel: "low", differentFrom: { stage: "plan", level: "model" }, locked: false });
  fireEvent.click(vendor("Plan check", "Plan"));
  expect(vendor("Plan check", "Plan").getAttribute("aria-checked")).toBe("true");
  expect(screen.getByRole("button", { name: "Review changes" }).hasAttribute("disabled")).toBe(true);
 });
 it("writes the vendor rule when it is turned on only where the default cannot hold: the row has a model", async () => {
  const f = await open({ policy: companyPolicyRaw({ plan_check: { model: mid(COMPANY_BUILD), thinkingLevel: "low", locked: false } }) });
  expect(vendor("Plan check", "Plan").getAttribute("aria-checked")).toBe("false");
  fireEvent.click(vendor("Plan check", "Plan"));
  await review();
  await screen.findByText("This list may be incomplete.");
  expect((f.previews()[0]!.body as { stepOverrides: Record<string, unknown> }).stepOverrides.plan_check).toEqual({ model: mid(COMPANY_BUILD), thinkingLevel: "low", differentFrom: { stage: "plan", level: "vendor" }, locked: false });
 });
 it("takes the switch's default from the server's answer, not from the row: with no server answer a bare row is off", async () => {
  const policy = companyPolicyRaw() as Record<string, unknown>;delete policy.reviewDefaults;
  await open({ policy });
  expect(vendor("Plan check", "Plan").getAttribute("aria-checked")).toBe("false");
  expect(within(card("Plan check")).queryByText(/Not set: this step uses/)).toBeNull();
 });
 it("leaves a row alone when the default is turned on while it already applies", async () => {
  await open();
  expect(screen.getByRole("button", { name: "Review changes" }).hasAttribute("disabled")).toBe(true);
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
 it("says WORKFLOW_MODE_UNMAPPED in its fixed sentence, by its code and never the server's words", async () => {
  await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 409, body: { error: { code: "WORKFLOW_MODE_UNMAPPED", message: "private detail" } } } : undefined });
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await save();
  expect((await screen.findByRole("alert")).textContent).toBe("This kind of work has no model stage, so no model can be chosen for it.");
  expect(screen.queryByText(/private detail/)).toBeNull();
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
 for (const message of ["Company reviewer models must differ from the stage they check. Set same-model exceptions per project in How we work.", "A chosen company model is unavailable. Review model sources."]) {
  it(`shows the server's own words for a 403 MODEL_NOT_ALLOWED, not the permission sentence: ${message.slice(0, 30)}`, async () => {
   // The body is what the broker sends: no `reason` field.
   await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 403, body: { error: { code: "MODEL_NOT_ALLOWED", message } } } : undefined });
   fireEvent.change(effort("Build"), { target: { value: "high" } });
   await save();
   expect((await screen.findByRole("alert")).textContent).toBe(message);
  });
 }
 it("clears a choice back to Rovara's default by leaving it out of the overrides", async () => {
  const f = await open();
  fireEvent.change(effort("Plan check"), { target: { value: "inherit" } });
  await save();
  await screen.findByText("Saved. New tasks use these defaults; running tasks keep theirs.");
  expect(Object.keys((f.puts()[0]!.body as { stepOverrides: Record<string, unknown> }).stepOverrides).sort()).toEqual(["build", "code_review", "security_review"]);
 });
});

const refocus = async () => { await act(async () => { focusManager.setFocused(false);focusManager.setFocused(true); }); };
const gate = () => { let open!: () => void;const opened = new Promise<void>(resolve => { open = resolve; });return { opened, open }; };

describe("a window refocus", () => {
 it("keeps unsaved edits and an open review, and reads nothing again", async () => {
  const f = await open({ refocusRereads: true });
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await review();
  await screen.findByRole("region", { name: "Review of company changes" });
  await refocus();
  await new Promise(resolve => { setTimeout(resolve, 50); });
  expect(f.calls().filter(call => call === "GET " + POLICY)).toHaveLength(1);
  expect(effort("Build").value).toBe("high");
  expect(screen.getByRole("region", { name: "Review of company changes" })).toBeTruthy();
 });
 it("during a save still shows the confirmation message", async () => {
  const held = gate();
  await open({ refocusRereads: true, handle: async request => { if (request.method === "PUT" && request.path === POLICY) { await held.opened;return { status: 202, body: needsConfirmation("https://cell.example", (request.body as { requestId: string }).requestId) }; } return undefined; } });
  fireEvent.click(lock("Review (code and security)"));
  await save();
  await refocus();
  await new Promise(resolve => { setTimeout(resolve, 50); });
  held.open();
  expect(await screen.findByText("Another company admin must confirm this less-safe change.")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Open confirmation" })).toBeTruthy();
 });
 it("during a save still shows the stale-settings message", async () => {
  const held = gate();
  await open({ refocusRereads: true, handle: async request => { if (request.method === "PUT" && request.path === POLICY) { await held.opened;return { status: 409, body: { error: { code: "POLICY_STALE", message: "Stale." } } }; } return undefined; } });
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await save();
  await refocus();
  await new Promise(resolve => { setTimeout(resolve, 50); });
  held.open();
  expect((await screen.findByRole("alert")).textContent).toContain("The model settings changed. Reload and try again.");
 });
});

describe("after a save that did not go through, or a page that is out of date", () => {
 it("keeps Review changes and Save disabled after a stale answer until Reload", async () => {
  await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 409, body: { error: { code: "POLICY_STALE", message: "Stale." } } } : undefined });
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await save();
  await screen.findByText(/The model settings changed/);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save company defaults" }).disabled).toBe(true);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(screen.queryByText(/The model settings changed/)).toBeNull());
 });
 it("says the page couldn't reload when the read after a save fails, and disables Save until Reload", async () => {
  let reads = 0;
  const f = await open({ handle: request => { if (request.method === "GET" && request.path === POLICY && ++reads > 1 && reads < 3) return { status: 400, body: { error: { code: "BAD_REQUEST", message: "x" } } };return undefined; } });
  fireEvent.change(effort("Build"), { target: { value: "high" } });
  await save();
  expect(await screen.findByText("Saved, but the page couldn't reload. Reload to see the latest.")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save company defaults" }).disabled).toBe(true);
  expect(f.puts()).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "Reload" }));
  await waitFor(() => expect(screen.queryByText(/couldn't reload/)).toBeNull());
  expect(screen.getByRole("region", { name: "Build" })).toBeTruthy();
 });
});

describe("the company answers are lane C's contract shapes", () => {
 it("parses the fixtures with lane C's strict schemas, so the page is tested against what the server sends", () => {
  expect(ModelSelectionPolicyResponseSchema.safeParse({ ...companyPolicyRaw(), candidates: companyCandidates() }).success).toBe(true);
  expect(ModelSelectionPolicyAppliedSchema.safeParse(applied(5)).success).toBe(true);
  expect(ModelSelectionPolicyPendingSchema.safeParse(needsConfirmation("https://cell.example", REQUEST_ID, "2026-10-30T12:00:00.000Z")).success).toBe(true);
  expect(ModelSelectionPolicyPendingSchema.safeParse(needsConfirmation("https://cell.example", REQUEST_ID, { available: false, availableAt: null, reasonCode: "OTHER_ADMIN_EXISTS" })).success).toBe(true);
 });
 it("accepts a 200 that differs from lane C's applied answer only by an extra field, so a newer server does not turn a save into a failure", async () => {
  await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 200, body: { ...applied(5, (request.body as { requestId: string }).requestId), futureField: 1 } } : undefined });
  fireEvent.click(lock("Review (code and security)"));
  await save();
  expect(await screen.findByText("Saved. New tasks use these defaults; running tasks keep theirs.")).toBeTruthy();
  expect(screen.queryByRole("alert")).toBeNull();
 });
 it("refuses a 200 that answers another request, even when it is otherwise a valid applied answer", async () => {
  await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 200, body: applied(5, "22222222-2222-4222-8222-222222222222") } : undefined });
  fireEvent.click(lock("Review (code and security)"));
  await save();
  expect((await screen.findByRole("alert")).textContent).toBe("Couldn't save the company defaults. Try again.");
  expect(screen.queryByText(/Saved\./)).toBeNull();
 });
});

describe("the company 202 and the model list", () => {
 it("lists what needs confirming from the answer's changes", async () => {
  await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 202, body: needsConfirmation("https://cell.example", (request.body as { requestId: string }).requestId) } : undefined });
  fireEvent.click(lock("Review (code and security)"));
  await save();
  expect(await screen.findByText("A stage lock is removed")).toBeTruthy();
 });
 it("shows no self-confirm time when the sole-owner path is not yet available", async () => {
  await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 202, body: needsConfirmation("https://cell.example", (request.body as { requestId: string }).requestId, { available: false, availableAt: null, reasonCode: "OTHER_ADMIN_EXISTS" }) } : undefined });
  fireEvent.click(lock("Review (code and security)"));
  await save();
  expect(await screen.findByText("Another company admin must confirm this.")).toBeTruthy();
  expect(screen.queryByText(/only admin/)).toBeNull();
 });
 it("does not take a 202 without the confirmation fields as a save", async () => {
  await open({ handle: request => request.method === "PUT" && request.path === POLICY ? { status: 202, body: { version: 1, status: "NEEDS_CONFIRMATION" } } : undefined });
  fireEvent.click(lock("Review (code and security)"));
  await save();
  expect((await screen.findByRole("alert")).textContent).toBe("Couldn't save the company defaults. Try again.");
  expect(screen.queryByText(/Saved\./)).toBeNull();
 });
 it("offers a model picker where the read lists models, with only verified ones selectable, and writes the choice", async () => {
  const f = await open({ policy: { ...companyPolicyRaw(), candidates: companyCandidates() } });
  const model = within(card("Plan (and Understand)")).getByRole<HTMLSelectElement>("combobox", { name: "Model" });
  expect(screen.queryByText("Pick models after the model list is available.")).toBeNull();
  const options = Object.fromEntries(Array.from(model.options).filter(option => option.value !== "").map(option => [option.value || option.textContent, option.disabled]));
  expect(options["openai/gpt-5-codex"]).toBe(true);
  expect(options[COMPANY_BUILD]).toBe(false);
  fireEvent.change(model, { target: { value: COMPANY_BUILD } });
  await review();
  await screen.findByText("This list may be incomplete.");
  expect((f.previews()[0]!.body as { stepOverrides: Record<string, unknown> }).stepOverrides.plan).toEqual({ model: mid(COMPANY_BUILD), locked: false });
 });
});

describe("a missing model list is unavailable, an empty one is an answer", () => {
 it("shows a stage the read gives no list for read only, with the note, while stages with a list keep their picker", async () => {
  const { plan: _plan, ...rest } = companyCandidates();void _plan;
  await open({ policy: { ...companyPolicyRaw(), candidates: rest } });
  expect(screen.getByText("Pick models after the model list is available.")).toBeTruthy();
  expect(within(card("Plan (and Understand)")).queryByRole("combobox", { name: "Model" })).toBeNull();
  expect(card("Plan (and Understand)").textContent).toContain("Model: Rovara's default");
  expect(within(card("Build")).getByRole("combobox", { name: "Model" })).toBeTruthy();
 });
 it("shows a stage with an empty list as having no verified models (a picker with Rovara's default only), never as unavailable", async () => {
  await open({ policy: { ...companyPolicyRaw(), candidates: { ...companyCandidates(), plan: [] } } });
  expect(screen.queryByText("Pick models after the model list is available.")).toBeNull();
  const model = within(card("Plan (and Understand)")).getByRole<HTMLSelectElement>("combobox", { name: "Model" });
  expect(Array.from(model.options).filter(option => option.value !== "")).toEqual([]);
  expect(model.value).toBe("");
  expect(within(card("Plan (and Understand)")).getByText("No verified models are listed for this stage yet.")).toBeTruthy();
  expect(within(card("Build")).queryByText("No verified models are listed for this stage yet.")).toBeNull();
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

describe("the Plan (and Understand) row", () => {
 it("writes one value to both stages, and sends no Understand row of its own", async () => {
  const f = await open();
  fireEvent.change(effort("Plan (and Understand)"), { target: { value: "high" } });
  await review();
  await screen.findByText("This list may be incomplete.");
  const sent = (f.previews()[0]!.body as { stepOverrides: Record<string, unknown> }).stepOverrides;
  expect(sent.understand).toEqual({ thinkingLevel: "high", locked: false });
  expect(sent.plan).toEqual(sent.understand);
 });
 it("reads its value from Plan and says so when Understand differs, then sets both the same", async () => {
  const f = await open({ policy: companyPolicyRaw({ plan: { thinkingLevel: "low", locked: false }, understand: { thinkingLevel: "high", locked: false } }) });
  expect(effort("Plan (and Understand)").value).toBe("low");
  expect(within(card("Plan (and Understand)")).getByText(/Plan and Understand have different settings today/)).toBeTruthy();
  expect(within(card("Review (code and security)")).queryByText(/different settings today/)).toBeNull();
  fireEvent.change(effort("Plan (and Understand)"), { target: { value: "medium" } });
  await review();
  await screen.findByText("This list may be incomplete.");
  const sent = (f.previews()[0]!.body as { stepOverrides: Record<string, { thinkingLevel: string }> }).stepOverrides;
  expect(sent.plan!.thinkingLevel).toBe("medium");
  expect(sent.understand).toEqual(sent.plan);
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
