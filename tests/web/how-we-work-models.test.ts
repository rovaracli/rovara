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
function setup(options: { canEdit?: boolean; stages?: Record<string, Json>; read?: (draft: string | null) => unknown; handle?: Handler; overlay?: Record<string, unknown>; theme?: "light" | "dark" } = {}) {
 const cell = howWeWorkHost({ ...(options.canEdit === undefined ? {} : { canEdit: options.canEdit }), ...(options.overlay === undefined ? {} : { overlay: options.overlay }), handle: (request, url) => options.handle?.(request, url) ?? stageModels(options.read ?? (() => stageModelsBody(options.stages)))(request, url) }), query = createQueryClient();
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

 it("writes the different-vendor toggle as differentCompanyFrom: Build on the review, Plan on the plan check", async () => {
  const f = await open();
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
  expect(within(card("Plan")).getByText("Picked because: Company default")).toBeTruthy();
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
  expect(within(card("Plan")).getByRole("combobox", { name: "Model" })).toBeTruthy();
 });

 it("says when a company lock stops the project's own choice from being used", async () => {
  await open({ stages: { build: stageEntry("build", { projectChoice: { model: mid(SONNET) }, locked: true, companyDefault: { model: mid(OPUS), thinkingLevel: null }, effective: effective(OPUS, { decidedBy: "company", locked: true, reason: "COMPANY_LOCK" }), notice: { code: "STAGE_LOCKED", fixHref: "/app/admin/how-we-work" } }) } });
  await waitFor(() => expect(within(card("Build")).getByText("Your project's choice (Sonnet 4.6) isn't used while the company locks this stage.")).toBeTruthy());
  expect(within(card("Build")).queryByRole("combobox")).toBeNull();
 });

 it("shows a stage that is not editable read only", async () => {
  await open({ stages: { plan: stageEntry("plan", { editable: false }) } });
  await waitFor(() => expect(within(card("Plan")).getByText("Opus 5.5")).toBeTruthy());
  expect(within(card("Plan")).queryByRole("combobox")).toBeNull();
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

 it("says the draft changed when the read is refused as stale", async () => {
  await open({ read: draft => draft === null ? stageModelsBody() : { status: 409, body: { error: { code: "DRAFT_STALE", message: "Stale." } } } });
  expect(await screen.findByText("This draft changed. Reload and try again.")).toBeTruthy();
 });

 it("keeps the read-only rows and the old note when the stage-models read is not there", async () => {
  await open({ read: () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } }) });
  expect(within(card("Build")).getByText("anthropic/claude-sonnet-4-6")).toBeTruthy();
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
  const body = await saved(f);
  expect(body.overlay.steps!.build).toEqual({ instructions: "Run the linter.", thinkingLevel: "low" });
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
