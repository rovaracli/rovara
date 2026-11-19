// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { h } from "./support/h.js";
import { howWeWorkHost, type Handler } from "./support/how-we-work-fixture.js";
import { OPUS, SONNET, effective, mid, stageEntry, stageModelsBody } from "./support/stage-models-fixture.js";

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

describe("model rows (read only: editing is hidden, DEC 254zzz113/115/116)", () => {
 it("shows a maintainer no model or effort picker, no switch and no Save draft, and sends no draft read", async () => {
  const f = await open();
  await waitFor(() => expect(within(card("Build")).getByText("Opus 5.5", { selector: "[data-stage='build'] *" })).toBeTruthy());
  expect(screen.queryByRole("combobox")).toBeNull();
  expect(screen.queryByRole("switch")).toBeNull();
  expect(screen.queryByRole("button", { name: "Save draft" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Review changes" })).toBeNull();
  expect(f.sent().filter(request => request.method !== "GET")).toEqual([]);
 });

 it("shows each reviewer's result on its own in the one Review card, with no picker", async () => {
  await open({ stages: { code_review: stageEntry("code_review", { effective: effective(OPUS) }), security_review: stageEntry("security_review", { effective: effective(SONNET) }) } });
  const review = card("Review");
  await waitFor(() => expect(within(review).getByText("Code review")).toBeTruthy());
  expect(within(review).getByText("Security review")).toBeTruthy();
  expect(within(review).getByText("Opus 5.5", { selector: "[data-stage='code_review'] *" })).toBeTruthy();
  expect(within(review).getByText("Sonnet 4.6", { selector: "[data-stage='security_review'] *" })).toBeTruthy();
  expect(within(review).queryByRole("combobox")).toBeNull();
 });

 it("titles the Plan card for both stages and shows each stage's result on its own, with no picker", async () => {
  await open({ stages: { understand: stageEntry("understand", { effective: effective(OPUS) }), plan: stageEntry("plan", { effective: effective(SONNET, { decidedBy: "project", reason: "PROJECT_SELECTION" }) }) } });
  const plan = card("Plan (and Understand)");
  await waitFor(() => expect(within(plan).getByText("Understand")).toBeTruthy());
  expect(within(plan).getByText("Plan", { selector: "p" })).toBeTruthy();
  expect(within(plan).getByText("Opus 5.5", { selector: "[data-stage='understand'] *" })).toBeTruthy();
  expect(within(plan).getByText("Sonnet 4.6", { selector: "[data-stage='plan'] *" })).toBeTruthy();
  expect(screen.queryByRole("region", { name: "Understand" })).toBeNull();
  expect(within(plan).queryByRole("combobox")).toBeNull();
 });

 it("shows a locked stage with Locked by company and the link to the company page, and no stage has a picker", async () => {
  await open({ stages: { build: stageEntry("build", { locked: true, companyDefault: { model: mid(OPUS), thinkingLevel: null }, effective: effective(OPUS, { decidedBy: "company", locked: true, reason: "COMPANY_LOCK" }), notice: { code: "STAGE_LOCKED", fixHref: "/app/admin/how-we-work" } }) } });
  const build = card("Build");
  await waitFor(() => expect(within(build).getAllByText("Locked by company").length).toBeGreaterThan(0));
  expect(within(build).queryByRole("switch")).toBeNull();
  expect(within(build).getByText("Opus 5.5")).toBeTruthy();
  expect(within(build).getByRole("link", { name: /company/iu }).getAttribute("href")).toBe("/app/admin/how-we-work");
  expect(screen.queryByRole("combobox")).toBeNull();
 });

 it("shows a stage that is not editable with its result", async () => {
  await open({ stages: { plan: stageEntry("plan", { editable: false }) } });
  await waitFor(() => expect(within(card("Plan (and Understand)")).getByText("Opus 5.5", { selector: "[data-stage='plan'] *" })).toBeTruthy());
  expect(screen.queryByRole("combobox")).toBeNull();
 });

 it("shows the picked-because line, the fixed words for each reason, and Cost unavailable", async () => {
  await open({ stages: { build: stageEntry("build", { effective: effective(SONNET, { decidedBy: "project", reason: "PROJECT_SELECTION" }) }), plan: stageEntry("plan", { effective: effective(OPUS, { decidedBy: "company", reason: "COMPANY_DEFAULT" }) }) } });
  await waitFor(() => expect(within(card("Build")).getByText("Picked because: Project model setting")).toBeTruthy());
  expect(within(card("Plan (and Understand)")).getByText("Picked because: Company default", { selector: "[data-stage='plan'] *" })).toBeTruthy();
  expect(within(card("Build")).getByText("Cost unavailable")).toBeTruthy();
 });

 it("says when a company lock stops the project's own choice from being used", async () => {
  await open({ stages: { build: stageEntry("build", { projectChoice: { model: mid(SONNET) }, locked: true, companyDefault: { model: mid(OPUS), thinkingLevel: null }, effective: effective(OPUS, { decidedBy: "company", locked: true, reason: "COMPANY_LOCK" }), notice: { code: "STAGE_LOCKED", fixHref: "/app/admin/how-we-work" } }) } });
  await waitFor(() => expect(within(card("Build")).getByText("Your project's choice (Sonnet 4.6) isn't used while the company locks this stage.")).toBeTruthy());
  expect(within(card("Build")).queryByRole("combobox")).toBeNull();
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

 it("names no model, only the note, when the stage-models read is not there", async () => {
  await open({ read: () => ({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } }) });
  expect(within(card("Build")).queryByText("anthropic/claude-sonnet-4-6")).toBeNull();
  expect(within(card("Build")).getByText("The models of this stage can't be shown right now. Reload to try again.")).toBeTruthy();
  expect(within(card("Build")).queryByRole("combobox")).toBeNull();
 });

 it.each(["light", "dark"] as const)("passes axe in the %s theme", async theme => {
  const f = await open({ theme, stages: { plan_check: stageEntry("plan_check", { refusal: { code: "LOCK_UNSATISFIABLE", fixHref: "/app/admin/how-we-work" } }) } });
  await waitFor(() => expect(within(card("Build")).getByText("Opus 5.5", { selector: "[data-stage='build'] *" })).toBeTruthy());
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
 it("says in fixed words when another company's model could not be used", async () => {
  await open({ stages: review("BUILTIN_DEFAULT", { otherCompanyFailed: true }) });
  await waitFor(() => expect(within(card("Review")).getAllByText("Review uses GPT-5 Codex (same company as the builder: the other company's model could not be used)")).toHaveLength(2));
 });
});

describe("the one-time review-default notice (hidden: the hosted Code does not serve it, DEC 254zzz113/115/116)", () => {
 const GPT_REVIEW = "openai/gpt-5-codex";
 const onDefault = { code_review: stageEntry("code_review", { effective: effective(GPT_REVIEW, { reason: "DEFAULT_DIFFERENT_COMPANY" }) }), security_review: stageEntry("security_review", { effective: effective(GPT_REVIEW, { reason: "DEFAULT_DIFFERENT_COMPANY" }) }) };
 it("shows no notice and no dismiss button even while reviews use another company's model, and never reads or writes the notice", async () => {
  const f = await open({ stages: onDefault });
  await waitFor(() => expect(within(card("Review")).getByText("Code review")).toBeTruthy());
  expect(screen.queryByRole("region", { name: "Reviews now use a different company's model" })).toBeNull();
  expect(screen.queryByText(/Reviews now use a different company/)).toBeNull();
  expect(f.calls().some(call => call.includes("review-default-notice"))).toBe(false);
 });
});
