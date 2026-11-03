// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { howWeWorkView } from "./support/how-we-work-view.js";
import { LAYER, draftBody, howWeWorkHost, type Handler } from "./support/how-we-work-fixture.js";
import { StepThinkingLevelSchema } from "@agentx/contracts/web";
import { OPUS, SONNET, candidates, effective, keyOf, mid, stageEntry, stageModelsBody } from "./support/stage-models-fixture.js";

const PATH = "/v1/app/projects/payments/stage-models";
type Json = Record<string, unknown>;
/** Answers the stage-models read; `body` can depend on whether a draft was asked for. */
const stageModels = (body: (draft: string | null) => unknown): Handler => (_request, url) => {
 if (url.pathname !== PATH) return undefined;
 const answer = body(url.searchParams.get("draft"));
 return typeof answer === "object" && answer !== null && "status" in answer ? answer as { status: number; body: unknown } : { status: 200, body: answer };
};
function setup(options: { canEdit?: boolean; stages?: Record<string, Json>; read?: (draft: string | null) => unknown; handle?: Handler; overlay?: Record<string, unknown>; theme?: "light" | "dark"; view?: unknown } = {}) {
 const cell = howWeWorkHost({ ...(options.view === undefined ? {} : { view: options.view }), ...(options.canEdit === undefined ? {} : { canEdit: options.canEdit }), ...(options.overlay === undefined ? {} : { overlay: options.overlay }), handle: (request, url) => options.handle?.(request, url) ?? stageModels(options.read ?? (() => stageModelsBody(options.stages)))(request, url) }), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments?tab=how-we-work"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: options.theme ?? "light" });
 return { ...cell, ...ui, query };
}
const card = (name: string) => screen.getByRole("region", { name });
const open = async (options: Parameters<typeof setup>[0] = {}) => { const world = setup(options);await screen.findByRole("heading", { name: "Build" });return world; };
const picker = (stage: string, name: string | RegExp = "Model") => within(card(stage)).getByRole<HTMLSelectElement>("combobox", { name });
const puts = (f: ReturnType<typeof setup>) => f.sent().filter(request => request.method === "PUT" && request.path.endsWith("/draft"));
const saved = async (f: ReturnType<typeof setup>) => { fireEvent.click(screen.getByRole("button", { name: "Save draft" }));await screen.findByText("Draft saved. Review changes to publish it.");return puts(f).at(-1)!.body as { overlay: { steps?: Record<string, Record<string, unknown>> }; expectedRevision: number }; };
const opus = { provider: "anthropic", modelId: "claude-opus-5-5" }, sonnet = { provider: "anthropic", modelId: "claude-sonnet-4-6" };

describe("editable model rows", () => {
 it("reads the draft's stage models for a maintainer and lists only verified models as selectable", async () => {
  const f = await open();
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  expect(f.calls()).toContain("GET /v1/app/projects/payments/stage-models");
  expect(f.request.mock.calls.map(([request]) => request.path)).toContain(PATH + "?draft=3");
  const options = Object.fromEntries(Array.from(picker("Build").options).filter(option => option.value !== "").map(option => [option.textContent, option.disabled]));
  expect(Object.entries(options).filter(([, disabled]) => !disabled).map(([name]) => name)).toEqual(expect.arrayContaining(["Rovara's default", "Opus 5.5", "Sonnet 4.6"]));
  expect(Object.keys(options).filter(name => options[name]).sort()).toEqual([
   "GPT-5 Codex: Not verified for your account. Ask an admin to check it in AI & connections.",
   "Gemini 3 Pro: This project does not allow this model.",
   "Grok 5: Verification for this model has expired. Check it again.",
  ]);
  expect(Object.keys(options).filter(name => !options[name])).toHaveLength(3);
 });

 it("chooses a model and effort and saves them into the draft's step settings, keeping what else the step holds", async () => {
  const f = await open();
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  fireEvent.change(picker("Build"), { target: { value: OPUS } });
  fireEvent.change(picker("Build", "Effort"), { target: { value: "high" } });
  const body = await saved(f);
  expect(body.overlay.steps!.build).toEqual({ instructions: "Run the linter.", model: opus, thinkingLevel: "high" });
  expect(body.expectedRevision).toBe(3);
  expect(f.sent().map(request => request.method + " " + request.path).slice(-2)).toEqual(["POST /v1/app/projects/payments/playbook/process", `PUT /v1/app/agents/${LAYER}/draft`]);
 });

 it("offers only the thinking levels the step settings accept, plus Model default", async () => {
  await open();
  await waitFor(() => expect(picker("Build", "Effort")).toBeTruthy());
  const values = Array.from(picker("Build", "Effort").options).filter(option => option.value !== "").map(option => option.value);
  expect(values).toEqual(["inherit", "null", "off", "minimal", "low", "medium", "high"]);
  for (const value of values.filter(value => value !== "inherit" && value !== "null")) expect(StepThinkingLevelSchema.safeParse(value).success).toBe(true);
  expect(values).not.toContain("xhigh");
 });

 it("removes the model field from the saved draft for Rovara's default, and keeps the step's other settings", async () => {
  const f = await open({ overlay: { steps: { build: { instructions: "Run the linter.", model: sonnet, thinkingLevel: "low" } } }, stages: { build: stageEntry("build", { projectChoice: { model: mid(SONNET), thinkingLevel: "low" }, effective: effective(SONNET, { decidedBy: "project", reason: "PROJECT_CHOICE" }) }) } });
  await waitFor(() => expect(picker("Build").value).toBe(SONNET));
  fireEvent.change(picker("Build"), { target: { value: "__default" } });
  const body = await saved(f);
  expect(body.overlay.steps!.build).toEqual({ instructions: "Run the linter.", thinkingLevel: "low" });
  expect("model" in body.overlay.steps!.build!).toBe(false);
 });

 it("saves effort null for Model default", async () => {
  const f = await open();
  await waitFor(() => expect(picker("Build", "Effort")).toBeTruthy());
  fireEvent.change(picker("Build", "Effort"), { target: { value: "null" } });
  const body = await saved(f);
  expect(body.overlay.steps!.build!.thinkingLevel).toBeNull();
  expect("model" in body.overlay.steps!.build!).toBe(false);
 });

 it("writes the different-vendor toggle as differentCompanyFrom: Build on the review, Plan on the plan check (where a company model means the rule must be written)", async () => {
  const companyModel = { companyDefault: { model: mid(OPUS), thinkingLevel: null } };
  const f = await open({ stages: { code_review: stageEntry("code_review", companyModel), security_review: stageEntry("security_review", companyModel), plan_check: stageEntry("plan_check", companyModel) } });
  await waitFor(() => expect(within(card("Review")).getByRole("switch", { name: "Different vendor than Build" })).toBeTruthy());
  expect(within(card("Plan check")).queryByRole("switch", { name: "Different vendor than Build" })).toBeNull();
  expect(within(card("Build")).queryByRole("switch")).toBeNull();
  fireEvent.click(within(card("Review")).getByRole("switch", { name: "Different vendor than Build" }));
  fireEvent.click(within(card("Plan check")).getByRole("switch", { name: "Different vendor than Plan" }));
  const body = await saved(f);
  expect(body.overlay.steps!.review).toEqual({ differentCompanyFrom: "build" });
  expect(body.overlay.steps!.plan_critic).toEqual({ differentCompanyFrom: "plan" });
 });

 it("has one Review picker that writes one value, and shows each reviewer's result on its own", async () => {
  const f = await open({ stages: { code_review: stageEntry("code_review", { effective: effective(OPUS) }), security_review: stageEntry("security_review", { effective: effective(SONNET) }) } });
  const review = card("Review");
  await waitFor(() => expect(within(review).getAllByRole("combobox", { name: "Review (code and security)" })).toHaveLength(1));
  expect(within(review).getByText("Code review")).toBeTruthy();
  expect(within(review).getByText("Security review")).toBeTruthy();
  expect(within(review).getByText("Opus 5.5", { selector: "[data-stage='code_review'] *" })).toBeTruthy();
  expect(within(review).getByText("Sonnet 4.6", { selector: "[data-stage='security_review'] *" })).toBeTruthy();
  fireEvent.change(picker("Review", "Review (code and security)"), { target: { value: SONNET } });
  const body = await saved(f);
  expect(body.overlay.steps!.review).toEqual({ model: sonnet });
  expect(Object.keys(body.overlay.steps!).sort()).toEqual(["build", "review"]);
 });

 it("shows the picked-because line, the fixed words for each reason, and Cost unavailable", async () => {
  await open({ stages: { build: stageEntry("build", { effective: effective(SONNET, { decidedBy: "project", reason: "PROJECT_SELECTION" }) }), plan: stageEntry("plan", { effective: effective(OPUS, { decidedBy: "company", reason: "COMPANY_DEFAULT" }) }) } });
  await waitFor(() => expect(within(card("Build")).getByText("Picked because: Project model setting")).toBeTruthy());
  expect(within(card("Plan (and Understand)")).getByText("Picked because: Company default", { selector: "[data-stage='plan'] *" })).toBeTruthy();
  expect(within(card("Build")).getByText("Cost unavailable")).toBeTruthy();
 });

 it("shows a locked stage read only with Locked by company and the link to the company page", async () => {
  await open({ stages: { build: stageEntry("build", { locked: true, companyDefault: { model: mid(OPUS), thinkingLevel: null }, effective: effective(OPUS, { decidedBy: "company", locked: true, reason: "COMPANY_LOCK" }), notice: { code: "STAGE_LOCKED", fixHref: "/app/admin/how-we-work" } }) } });
  const build = card("Build");
  await waitFor(() => expect(within(build).getAllByText("Locked by company").length).toBeGreaterThan(0));
  expect(within(build).queryByRole("combobox")).toBeNull();
  expect(within(build).queryByRole("switch")).toBeNull();
  expect(within(build).getByText("Opus 5.5")).toBeTruthy();
  expect(within(build).getByRole("link", { name: /company/iu }).getAttribute("href")).toBe("/app/admin/how-we-work");
  expect(within(card("Plan (and Understand)")).getByRole("combobox", { name: "Model" })).toBeTruthy();
 });

 it("says when a company lock stops the project's own choice from being used", async () => {
  await open({ stages: { build: stageEntry("build", { projectChoice: { model: mid(SONNET) }, locked: true, companyDefault: { model: mid(OPUS), thinkingLevel: null }, effective: effective(OPUS, { decidedBy: "company", locked: true, reason: "COMPANY_LOCK" }), notice: { code: "STAGE_LOCKED", fixHref: "/app/admin/how-we-work" } }) } });
  await waitFor(() => expect(within(card("Build")).getByText("Your project's choice (Sonnet 4.6) isn't used while the company locks this stage.")).toBeTruthy());
  expect(within(card("Build")).queryByRole("combobox")).toBeNull();
 });

 it("titles the Plan card for both stages, shows each stage's result on its own, and writes one value to the Plan step", async () => {
  const f = await open({ stages: { understand: stageEntry("understand", { effective: effective(OPUS) }), plan: stageEntry("plan", { effective: effective(SONNET, { decidedBy: "project", reason: "PROJECT_SELECTION" }) }) } });
  const plan = card("Plan (and Understand)");
  await waitFor(() => expect(within(plan).getAllByRole("combobox", { name: "Model" })).toHaveLength(1));
  expect(within(plan).getByText("Understand")).toBeTruthy();
  expect(within(plan).getByText("Plan", { selector: "p" })).toBeTruthy();
  expect(within(plan).getByText("Opus 5.5", { selector: "[data-stage='understand'] *" })).toBeTruthy();
  expect(within(plan).getByText("Sonnet 4.6", { selector: "[data-stage='plan'] *" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Understand" })).toBeNull();
  fireEvent.change(picker("Plan (and Understand)"), { target: { value: OPUS } });
  const body = await saved(f);
  expect(body.overlay.steps!.plan).toEqual({ model: opus });
  expect(Object.keys(body.overlay.steps!)).not.toContain("understand");
 });

 it("says a member runs no model in the plain words, except Understand using the Plan model: not for a reviewer, not for Plan itself", async () => {
  await open({ stages: { security_review: stageEntry("security_review", { editable: false, notApplicable: true }) } });
  await waitFor(() => expect(within(card("Review")).getByText("This stage does not use a model.", { selector: "[data-stage='security_review'] *" })).toBeTruthy());
  expect(within(card("Review")).queryByText(/Uses the/)).toBeNull();
 });

 it("says a Plan that runs no model does not use one, even with Understand applicable", async () => {
  await open({ stages: { plan: stageEntry("plan", { editable: false, notApplicable: true }) } });
  const plan = card("Plan (and Understand)");
  await waitFor(() => expect(within(plan).getByText("This stage does not use a model.", { selector: "[data-stage='plan'] *" })).toBeTruthy());
  expect(within(plan).queryByText(/Uses the/)).toBeNull();
  expect(within(plan).getByText("Opus 5.5", { selector: "[data-stage='understand'] *" })).toBeTruthy();
 });

 it("keeps the Plan card editable when Understand runs no model of its own, says it uses the Plan model, and saves the shared value", async () => {
  const f = await open({ stages: { understand: stageEntry("understand", { editable: false, notApplicable: true }) } });
  const plan = card("Plan (and Understand)");
  await waitFor(() => expect(within(plan).getAllByRole("combobox", { name: "Model" })).toHaveLength(1));
  expect(within(plan).getByText("Uses the Plan model.", { selector: "[data-stage='understand'] *" })).toBeTruthy();
  expect(within(plan).queryByText("The model for this stage can't be changed here.")).toBeNull();
  fireEvent.change(picker("Plan (and Understand)"), { target: { value: SONNET } });
  fireEvent.change(picker("Plan (and Understand)", "Effort"), { target: { value: "low" } });
  const body = await saved(f);
  expect(body.overlay.steps!.plan).toEqual({ model: sonnet, thinkingLevel: "low" });
 });

 it("keeps the card read only when a member that does run a model is not editable or is locked", async () => {
  await open({ stages: { understand: stageEntry("understand", { editable: false }) } });
  await waitFor(() => expect(within(card("Plan (and Understand)")).getAllByText("Opus 5.5").length).toBeGreaterThan(0));
  expect(within(card("Plan (and Understand)")).queryByRole("combobox")).toBeNull();
 });

 it("keeps the card read only when a member that runs a model is locked by the company", async () => {
  await open({ stages: { understand: stageEntry("understand", { locked: true, effective: effective(OPUS, { decidedBy: "company", locked: true, reason: "COMPANY_LOCK" }), notice: { code: "STAGE_LOCKED", fixHref: "/app/admin/how-we-work" } }) } });
  await waitFor(() => expect(within(card("Plan (and Understand)")).getAllByText("Locked by company").length).toBeGreaterThan(0));
  expect(within(card("Plan (and Understand)")).queryByRole("combobox")).toBeNull();
 });

 it("shows a stage that is not editable read only", async () => {
  await open({ stages: { plan: stageEntry("plan", { editable: false }) } });
  await waitFor(() => expect(within(card("Plan (and Understand)")).getByText("Opus 5.5", { selector: "[data-stage='plan'] *" })).toBeTruthy());
  expect(within(card("Plan (and Understand)")).queryByRole("combobox")).toBeNull();
  expect(within(card("Build")).getByRole("combobox", { name: "Model" })).toBeTruthy();
 });

 it("shows a refusal with the table's sentence and its fix link, and no model", async () => {
  await open({ stages: { plan_check: stageEntry("plan_check", { refusal: { code: "NO_VERIFIED_CANDIDATE", fixHref: "/app/admin/connections" } }) } });
  const check = card("Plan check");
  await waitFor(() => expect(within(check).getByText("No verified model can run this stage.")).toBeTruthy());
  expect(within(check).getByRole("link", { name: /fix/iu }).getAttribute("href")).toBe("/app/admin/connections");
 });

 it("gives a viewer the published result only, with no controls and no draft read", async () => {
  const f = await open({ canEdit: false, stages: { build: stageEntry("build", { effective: effective(SONNET, { decidedBy: "project", reason: "PROJECT_CHOICE" }) }) } });
  await waitFor(() => expect(within(card("Build")).getByText("Sonnet 4.6")).toBeTruthy());
  expect(within(card("Build")).getByText("Picked because: Set in this project")).toBeTruthy();
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(f.request.mock.calls.map(([request]) => request.path).filter(path => path.startsWith(PATH))).toEqual([PATH]);
  expect(f.calls().filter(call => call.endsWith("/draft"))).toEqual([]);
 });

 it("reads the stale draft by its code only: a PLAYBOOK_STALE refusal is not the draft having changed", async () => {
  await open({ read: draft => draft === null ? stageModelsBody() : { status: 409, body: { error: { code: "PLAYBOOK_STALE", message: "DRAFT_STALE: This process draft changed. Reload and try again." } } } });
  // The draft read failed (the page says it can't show the models), and that is not the stale-draft notice.
  await waitFor(() => expect(within(card("Build")).getByText("The models of this stage can't be shown right now. Reload to try again.")).toBeTruthy());
  expect(screen.queryByRole("region", { name: "Draft changed" })).toBeNull();
 });

 it("says the draft changed when the read is refused as stale", async () => {
  await open({ read: draft => draft === null ? stageModelsBody() : { status: 409, body: { error: { code: "DRAFT_STALE", message: "Stale." } } } });
  expect(await screen.findByText("This draft changed. Reload and try again.")).toBeTruthy();
 });

 it("names no model, only the note, when the stage-models read is not there", async () => {
  await open({ read: () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } }) });
  expect(within(card("Build")).queryByText("anthropic/claude-sonnet-4-6")).toBeNull();
  expect(within(card("Build")).getByText("The models of this stage can't be shown right now. Reload to try again.")).toBeTruthy();
  expect(within(card("Build")).queryByRole("combobox")).toBeNull();
 });

 it("does not count a choice put back to what the draft holds as an edit", async () => {
  await open();
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  fireEvent.change(picker("Build"), { target: { value: OPUS } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save draft" }).disabled).toBe(false);
  fireEvent.change(picker("Build"), { target: { value: "__default" } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save draft" }).disabled).toBe(true);
 });

 it("drops a pending model edit when the stage becomes locked, and Save draft goes quiet", async () => {
  let stages: Record<string, Json> = {};
  const f = await open({ read: () => stageModelsBody(stages) });
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  fireEvent.change(picker("Build"), { target: { value: OPUS } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save draft" }).disabled).toBe(false);
  stages = { build: stageEntry("build", { locked: true, companyDefault: { model: mid(SONNET), thinkingLevel: null }, effective: effective(SONNET, { decidedBy: "company", locked: true, reason: "COMPANY_LOCK" }), notice: { code: "STAGE_LOCKED", fixHref: "/app/admin/how-we-work" } }) };
  await f.query.invalidateQueries();
  await waitFor(() => expect(within(card("Build")).queryByRole("combobox")).toBeNull());
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save draft" }).disabled).toBe(true);
  expect(puts(f)).toEqual([]);
  expect(screen.getByText("Some changes were removed because the company locked a stage or a model is no longer verified.")).toBeTruthy();
 });

 it("drops a pending model edit when the stage stops being editable", async () => {
  let stages: Record<string, Json> = {};
  const f = await open({ read: () => stageModelsBody(stages) });
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  fireEvent.change(picker("Build"), { target: { value: OPUS } });
  stages = { build: stageEntry("build", { editable: false }) };
  await f.query.invalidateQueries();
  await waitFor(() => expect(within(card("Build")).queryByRole("combobox")).toBeNull());
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save draft" }).disabled).toBe(true);
 });

 it("shows a model the account cannot call disabled, with the broker's own words, and does not let it be chosen", async () => {
  const sentence = "This model isn't enabled for your AWS account. Enable it in the Bedrock console, or Rovara will use another model.";
  const f = await open({ read: () => stageModelsBody({ build: stageEntry("build", { candidates: candidates().map(candidate => keyOf(candidate.model) === OPUS ? { ...candidate, unusableReason: sentence } : candidate) }) }) });
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  const opus = Array.from(picker("Build").options).find(option => option.value === OPUS)!;
  expect(opus.disabled).toBe(true);
  expect(opus.textContent).toBe("Opus 5.5: " + sentence);
  const sonnet = Array.from(picker("Build").options).find(option => option.value === SONNET)!;
  expect(sonnet.disabled).toBe(false);
  expect(sonnet.textContent).toBe("Sonnet 4.6");
  expect(f.calls()).toContain("GET /v1/app/projects/payments/stage-models");
 });

 it("drops a pending model edit when the chosen model is no longer verified, and keeps the other edits", async () => {
  let aged = false;
  const f = await open({ read: () => stageModelsBody({ build: stageEntry("build", { candidates: candidates().map(candidate => aged && keyOf(candidate.model) === OPUS ? { ...candidate, status: "stale" } : candidate) }) }) });
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  fireEvent.change(picker("Build"), { target: { value: OPUS } });
  fireEvent.change(picker("Build", "Effort"), { target: { value: "low" } });
  aged = true;
  await f.query.invalidateQueries();
  await waitFor(() => expect(picker("Build").value).toBe("__default"));
  expect(picker("Build", "Effort").value).toBe("low");
  expect(screen.getByText("Some changes were removed because the company locked a stage or a model is no longer verified.")).toBeTruthy();
  const body = await saved(f);
  expect(body.overlay.steps!.build).toEqual({ instructions: "Run the linter.", thinkingLevel: "low" });
  expect(screen.queryByText("Some changes were removed because the company locked a stage or a model is no longer verified.")).toBeNull();
 });

 it("discards pending model edits when the read is refused as stale", async () => {
  let stale = false;
  const f = await open({ read: () => stale ? { status: 409, body: { error: { code: "DRAFT_STALE", message: "Stale." } } } : stageModelsBody() });
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  fireEvent.change(picker("Build"), { target: { value: OPUS } });
  stale = true;
  await f.query.invalidateQueries();
  expect(await screen.findByText("This draft changed. Reload and try again.")).toBeTruthy();
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save draft" }).disabled).toBe(true);
  expect(puts(f)).toEqual([]);
 });

 it("discards pending model edits when the draft revision changes under the person, and says so", async () => {
  let moved = false;
  const f = await open({ handle: (request, url) => moved && url.pathname === `/v1/app/agents/${LAYER}/draft` && request.method === "GET" ? { status: 200, body: draftBody({ instructions: "Keep changes small." }, 4) } : undefined });
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  fireEvent.change(picker("Build"), { target: { value: OPUS } });
  moved = true;
  await f.query.invalidateQueries();
  expect(await screen.findByText("This draft changed. Reload and try again.")).toBeTruthy();
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save draft" }).disabled).toBe(true));
  expect(picker("Build").value).toBe("__default");
  expect(puts(f)).toEqual([]);
 });

 it("never writes model choices onto a draft someone else saved after the last fetch: no write, the message, the choices dropped", async () => {
  let moved = false;
  const f = await open({ handle: (request, url) => moved && url.pathname === `/v1/app/agents/${LAYER}/draft` && request.method === "GET" ? { status: 200, body: draftBody({ instructions: "Keep changes small." }, 4) } : undefined });
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  fireEvent.change(picker("Build"), { target: { value: OPUS } });
  moved = true;
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText("This draft changed. Reload and try again.")).toBeTruthy();
  expect(puts(f)).toEqual([]);
  expect(screen.queryByText("Draft saved. Review changes to publish it.")).toBeNull();
  await waitFor(() => expect(picker("Build").value).toBe("__default"));
 });

 it("keeps the rule text the person typed when the model choices are dropped for a moved draft", async () => {
  let moved = false;
  const f = await open({ handle: (request, url) => moved && url.pathname === `/v1/app/agents/${LAYER}/draft` && request.method === "GET" ? { status: 200, body: draftBody({ instructions: "Keep changes small." }, 4) } : undefined });
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  fireEvent.change(picker("Build"), { target: { value: OPUS } });
  fireEvent.change(screen.getByRole("textbox", { name: "Project rules" }), { target: { value: "Be careful." } });
  moved = true;
  fireEvent.click(screen.getByRole("button", { name: "Save draft" }));
  expect(await screen.findByText("This draft changed. Reload and try again.")).toBeTruthy();
  expect(puts(f)).toEqual([]);
  expect((screen.getByRole<HTMLTextAreaElement>("textbox", { name: "Project rules" })).value).toBe("Be careful.");
 });

 it("writes the first model choices of a project that has no process layer yet (nothing to have moved)", async () => {
  const f = await open({ view: howWeWorkView({ process: { kind: "builtin", agentId: "rovara-code" }, rules: [] }), overlay: {} });
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  fireEvent.change(picker("Build"), { target: { value: OPUS } });
  const body = await saved(f);
  expect(body.overlay.steps!.build).toEqual({ model: opus });
  expect(screen.queryByText("This draft changed. Reload and try again.")).toBeNull();
  expect(f.sent().map(request => request.method + " " + request.path)).toContain("POST /v1/app/projects/payments/playbook/process");
 });

 it("saves model choices when the draft is still at the revision they were made on", async () => {
  const f = await open();
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  fireEvent.change(picker("Build"), { target: { value: OPUS } });
  const body = await saved(f);
  expect(body.expectedRevision).toBe(3);
  expect(body.overlay.steps!.build!.model).toEqual(opus);
 });

 it("still saves a valid edit after the read refreshes without changing anything", async () => {
  const f = await open();
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  fireEvent.change(picker("Build"), { target: { value: OPUS } });
  await f.query.invalidateQueries();
  await waitFor(() => expect(f.request.mock.calls.filter(([request]) => request.path.startsWith(PATH)).length).toBeGreaterThan(1));
  expect(picker("Build").value).toBe(OPUS);
  const body = await saved(f);
  expect(body.overlay.steps!.build).toEqual({ instructions: "Run the linter.", model: opus });
 });

 it.each(["light", "dark"] as const)("passes axe in the %s theme", async theme => {
  const f = await open({ theme, stages: { plan_check: stageEntry("plan_check", { refusal: { code: "LOCK_UNSATISFIABLE", fixHref: "/app/admin/how-we-work" } }) } });
  await waitFor(() => expect(picker("Build")).toBeTruthy());
  await expectNoAxeViolations(f.container);
 });
});

describe("review defaults (owner decision 2026-11-02)", () => {
 const review = (reason: string, extra: Json = {}) => ({ code_review: stageEntry("code_review", { effective: effective(GPT_REVIEW, { reason, ...extra }) }), security_review: stageEntry("security_review", { effective: effective(GPT_REVIEW, { reason, ...extra }) }) });
 const GPT_REVIEW = "openai/gpt-5-codex";
 it("shows a review step's reason in the three fixed phrases, and the ordinary words for a step that is not a check", async () => {
  await open({ stages: review("DEFAULT_DIFFERENT_COMPANY") });
  await waitFor(() => expect(within(card("Review")).getByText("Picked because: default: different company", { selector: "[data-stage='code_review'] *" })).toBeTruthy());
  expect(within(card("Review")).getByText("Picked because: default: different company", { selector: "[data-stage='security_review'] *" })).toBeTruthy();
  expect(within(card("Build")).getByText("Picked because: Rovara's default")).toBeTruthy();
 });
 it("says your choice for a project or company choice and company lock for a lock", async () => {
  const choice = await open({ stages: review("PROJECT_CHOICE", { decidedBy: "project" }) });
  await waitFor(() => expect(within(card("Review")).getByText("Picked because: your choice", { selector: "[data-stage='code_review'] *" })).toBeTruthy());
  choice.unmount();
  await open({ stages: { code_review: stageEntry("code_review", { locked: true, effective: effective(GPT_REVIEW, { reason: "COMPANY_LOCK", decidedBy: "company", locked: true }) }), security_review: stageEntry("security_review", { locked: true, effective: effective(GPT_REVIEW, { reason: "COMPANY_LOCK", decidedBy: "company", locked: true }) }) } });
  await waitFor(() => expect(within(card("Review")).getByText("Picked because: company lock", { selector: "[data-stage='code_review'] *" })).toBeTruthy());
 });
 it("says in fixed words that the review is on the builder's company when no other company's model is available, and the plan check likewise", async () => {
  await open({ stages: { ...review("BUILTIN_DEFAULT", { noOtherCompany: true }), plan_check: stageEntry("plan_check", { effective: effective(SONNET, { noOtherCompany: true }) }) } });
  await waitFor(() => expect(within(card("Review")).getAllByText("Review uses GPT-5 Codex (same company as the builder: no other company's model is available)")).toHaveLength(2));
  expect(within(card("Review")).getAllByText("Picked because: default: different company").length).toBe(2);
  expect(within(card("Plan check")).getByText("Plan check uses Sonnet 4.6 (same company as the planner: no other company's model is available)")).toBeTruthy();
  expect(within(card("Build")).queryByText(/same company as the/)).toBeNull();
 });
 it("turning the switch on where a project saved the different-model rule removes that rule: back to the default, so a Claude-only company still reviews", async () => {
  const optedOut = { projectChoice: { differentFrom: { stage: "build", level: "model" } } };
  const f = await open({ overlay: { steps: { review: { differentCompanyFrom: null } } }, stages: { code_review: stageEntry("code_review", { ...optedOut, effective: effective(OPUS) }), security_review: stageEntry("security_review", { ...optedOut, effective: effective(OPUS) }) } });
  const toggle = () => within(card("Review")).getByRole("switch", { name: "Different vendor than Build" });
  await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
  fireEvent.click(toggle());
  const body = await saved(f);
  expect(body.overlay.steps?.review ?? {}).not.toHaveProperty("differentCompanyFrom");
 });
 it("says in fixed words when another company's model could not be used", async () => {
  await open({ stages: review("BUILTIN_DEFAULT", { otherCompanyFailed: true }) });
  await waitFor(() => expect(within(card("Review")).getAllByText("Review uses GPT-5 Codex (same company as the builder: the other company's model could not be used)")).toHaveLength(2));
 });
 it("shows the different-vendor switch on while the default applies, and turning it off writes the explicit different-model rule", async () => {
  const f = await open({ stages: review("DEFAULT_DIFFERENT_COMPANY") });
  const toggle = () => within(card("Review")).getByRole("switch", { name: "Different vendor than Build" });
  await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("true"));
  fireEvent.click(toggle());
  const body = await saved(f);
  expect(body.overlay.steps!.review).toEqual({ differentCompanyFrom: null });
 });
 it("keeps the switch off for a step with a project choice and no rule, and turning it on writes the vendor rule", async () => {
  const chosen = { projectChoice: { model: mid(GPT_REVIEW) } };
  const f = await open({ stages: { code_review: stageEntry("code_review", { ...chosen, effective: effective(GPT_REVIEW, { reason: "PROJECT_CHOICE", decidedBy: "project" }) }), security_review: stageEntry("security_review", { ...chosen, effective: effective(GPT_REVIEW, { reason: "PROJECT_CHOICE", decidedBy: "project" }) }) } });
  const toggle = () => within(card("Review")).getByRole("switch", { name: "Different vendor than Build" });
  await waitFor(() => expect(toggle().getAttribute("aria-checked")).toBe("false"));
  fireEvent.click(toggle());
  expect((await saved(f)).overlay.steps!.review).toEqual({ differentCompanyFrom: "build" });
 });
});

describe("the one-time review-default notice (owner decision 2026-11-02)", () => {
 const NOTICE = "/v1/app/org/review-default-notice", GPT_REVIEW = "openai/gpt-5-codex";
 const onDefault = (reason = "DEFAULT_DIFFERENT_COMPANY") => ({ code_review: stageEntry("code_review", { effective: effective(GPT_REVIEW, { reason }) }), security_review: stageEntry("security_review", { effective: effective(GPT_REVIEW, { reason }) }) });
 const region = () => screen.getByRole("region", { name: "Reviews now use a different company's model" });
 const answering = (state: { dismissed: boolean; canDismiss: boolean }, onPost?: (request: { body?: unknown }) => { status: number; body: unknown } | undefined): Handler => (request, url) => {
  if (url.pathname !== NOTICE) return undefined;
  if (request.method === "POST") return onPost?.(request) ?? { status: 200, body: { dismissed: true, canDismiss: state.canDismiss } };
  return { status: 200, body: state };
 };
 it("tells every member which model the reviews use, in the fixed words, and lets an owner or admin dismiss it", async () => {
  const f = await open({ stages: onDefault(), handle: answering({ dismissed: false, canDismiss: true }) });
  await waitFor(() => expect(region()).toBeTruthy());
  expect(region().textContent).toContain("Reviews now use a model from a different company: GPT-5 Codex. Change it here.");
  expect(within(region()).getByRole("link", { name: "Change it here." }).getAttribute("href")).toBe("/app/admin/how-we-work");
  fireEvent.click(within(region()).getByRole("button", { name: "Dismiss" }));
  await waitFor(() => expect(screen.queryByRole("region", { name: "Reviews now use a different company's model" })).toBeNull());
  const posts = f.sent().filter(request => request.path === NOTICE);
  expect(posts).toHaveLength(1);
  expect(posts[0]!.body).toEqual({ action: "dismiss" });
 });
 it("shows a member the same words with nothing to press", async () => {
  await open({ stages: onDefault(), handle: answering({ dismissed: false, canDismiss: false }) });
  await waitFor(() => expect(region()).toBeTruthy());
  expect(region().textContent).toContain("Reviews now use a model from a different company: GPT-5 Codex. Change it here.");
  expect(within(region()).queryByRole("button")).toBeNull();
  expect(within(region()).queryByRole("link")).toBeNull();
 });
 it("is not shown once the company dismissed it", async () => {
  const f = await open({ stages: onDefault(), handle: answering({ dismissed: true, canDismiss: true }) });
  // The read ran, so the notice is hidden because of its answer, not because nothing was asked.
  await waitFor(() => expect(f.calls()).toContain("GET " + NOTICE));
  expect(screen.queryByRole("region", { name: "Reviews now use a different company's model" })).toBeNull();
 });
 it("is shown only while a review step is on the new default", async () => {
  const f = await open({ stages: onDefault("PROJECT_CHOICE"), handle: answering({ dismissed: false, canDismiss: true }) });
  await waitFor(() => expect(f.calls()).toContain("GET " + NOTICE));
  expect(screen.queryByRole("region", { name: "Reviews now use a different company's model" })).toBeNull();
 });
 it("counts only review steps: a step that is not a check never makes the notice", async () => {
  const f = await open({ stages: { build: stageEntry("build", { effective: effective(GPT_REVIEW, { reason: "DEFAULT_DIFFERENT_COMPANY" }) }) }, handle: answering({ dismissed: false, canDismiss: true }) });
  await waitFor(() => expect(f.calls()).toContain("GET " + NOTICE));
  expect(screen.queryByRole("region", { name: "Reviews now use a different company's model" })).toBeNull();
 });
 it("sends one dismissal for a double press", async () => {
  const f = await open({ stages: onDefault(), handle: answering({ dismissed: false, canDismiss: true }) });
  await waitFor(() => expect(region()).toBeTruthy());
  const press = within(region()).getByRole("button", { name: "Dismiss" });
  fireEvent.click(press);fireEvent.click(press);
  await waitFor(() => expect(screen.queryByRole("region", { name: "Reviews now use a different company's model" })).toBeNull());
  expect(f.sent().filter(request => request.path === NOTICE)).toHaveLength(1);
 });
 it("keeps the notice and says so when the dismissal is refused", async () => {
  await open({ stages: onDefault(), handle: answering({ dismissed: false, canDismiss: true }, () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: "no" } } })) });
  await waitFor(() => expect(region()).toBeTruthy());
  fireEvent.click(within(region()).getByRole("button", { name: "Dismiss" }));
  expect((await within(region()).findByRole("alert")).textContent).toBe("Only a company owner or admin can dismiss this notice.");
  expect(region()).toBeTruthy();
 });
});
