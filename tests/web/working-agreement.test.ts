// @vitest-environment jsdom
// The Working agreement (exp/working-agreement): off by default (the project page and the task page are today's), and with the switch on every rule shows where it comes from. Each origin comes from what the broker sent,
// a lock is explained by a "Why?" link, a change waiting for a second admin says so, and a source the page cannot read is listed as "Not available yet" instead of being guessed.
import { describe, expect, it } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";
import { QueryClientProvider } from "@tanstack/react-query";
import { DESIGN_REVIEW_DEFAULT_SETTING, ProjectPlaybookResponseSchema } from "@agentx/contracts/web";
import { AGREEMENT_STORAGE_KEY, isWorkingAgreementOn } from "../../packages/ui/src/screens/agreement/agreement-flags.js";
import { ORIGIN_LABEL, T, type Origin } from "../../packages/ui/src/screens/agreement/agreement-text.js";
import { brief, companyRulesRows, designReviewRows, isLocked, knownFailingRows, layerRows, learningRows, lessonsRows, modelRows, originOfMark, taskRows, type AgreementRow } from "../../packages/ui/src/screens/agreement/agreement-rows.js";
import { CompanyRulesSummaryReader } from "../../packages/ui/src/api/agreement.js";
import { WorkingAgreementPanel } from "../../packages/ui/src/screens/agreement/WorkingAgreementPanel.js";
import { ProjectScreen } from "../../packages/ui/src/screens/project/ProjectScreen.js";
import { PipelineTab } from "../../packages/ui/src/screens/session/PipelineTab.js";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { Announcer } from "../../packages/ui/src/design/Announcer.js";
import { createQueryClient } from "../../packages/ui/src/api/query.js";
import { renderUi } from "./support/render.js";
import { expectNoAxeViolations } from "./support/axe.js";
import { fakeHost } from "./support/fake-host.js";
import { h } from "./support/h.js";
import { howWeWorkHost } from "./support/how-we-work-fixture.js";
import { howWeWorkView } from "./support/how-we-work-view.js";
import { designReviewFixture, designTaskSession } from "./support/design-review-fixture.js";
import { agreementBody, agreementHost, learning, models, playbook, policy, rules, type AgreementWorld, type Part } from "./support/agreement-fixture.js";
import { view as lessonsView } from "./support/lessons-fixture.js";

// jsdom has no ResizeObserver, which the checkbox on the How we work tab measures with.
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
const byId = (rows: readonly AgreementRow[], id: string) => rows.find(row => row.id === id);
const origins = (rows: readonly AgreementRow[]) => Object.fromEntries(rows.map(row => [row.id, row.origin]));

describe("the switch", () => {
 it("is off unless the device key says v2", () => {
  const f = fakeHost();
  expect(isWorkingAgreementOn(f.host)).toBe(false);
  for (const value of ["", "v1", "true", "V2", "1"]) { f.storage.set(AGREEMENT_STORAGE_KEY, value);expect(isWorkingAgreementOn(f.host)).toBe(false); }
  f.storage.set(AGREEMENT_STORAGE_KEY, "v2");expect(isWorkingAgreementOn(f.host)).toBe(true);
  expect(isWorkingAgreementOn({ storage: { get() { throw new Error("blocked"); }, set() { /* none */ } } })).toBe(false);
  expect(AGREEMENT_STORAGE_KEY).toBe("rovara.agreement");
 });
});

describe("origin mapping", () => {
 it("a company lock beats the source, a Rovara lock is its own origin, and every unlocked source maps to one origin", () => {
  expect(originOfMark({ source: "company", locked: true, lockedBy: "company" })).toBe("company-lock");
  expect(originOfMark({ source: "project", locked: true, lockedBy: "company" })).toBe("company-lock");
  expect(originOfMark({ source: "rovara", locked: true, lockedBy: "rovara" })).toBe("rovara-fixed");
  expect(originOfMark({ source: "company", locked: false })).toBe("company-default");
  expect(originOfMark({ source: "project", locked: false })).toBe("project-choice");
  expect(originOfMark({ source: "rovara", locked: false })).toBe("rovara-default");
  // A lock the broker did not attribute falls back to the source rather than inventing a locker.
  expect(originOfMark({ source: "company", locked: true })).toBe("company-default");
 });
 it("every origin has words, and only the two locks are locked", () => {
  const all: Origin[] = ["company-lock", "company-default", "project-choice", "task-choice", "rovara-default", "rovara-fixed"];
  expect(all.map(origin => ORIGIN_LABEL[origin])).toEqual(["Company lock", "Company default", "Project choice", "Task choice", "Rovara default", "Built into Rovara"]);
  expect(all.filter(origin => isLocked({ origin }))).toEqual(["company-lock", "rovara-fixed"]);
 });
 it("brief folds white space and cuts a long rule at 160 characters", () => {
  expect(brief("a\n  b\tc")).toBe("a b c");
  expect(brief("x".repeat(160))).toHaveLength(160);
  const cut = brief("y".repeat(400));
  expect([...cut]).toHaveLength(160);expect(cut.endsWith("…")).toBe(true);
 });
});

describe("rows from the How we work layers", () => {
 const { project, steps } = layerRows(howWeWorkView());
 it("the process and each project-wide rule carry the layer's own version", () => {
  expect(byId(project, "process")).toMatchObject({ origin: "project-choice", version: 2, value: "The project's own process" });
  expect(byId(project, "rule-0")).toMatchObject({ title: "Rule for every step", value: "Keep changes small.", origin: "project-choice", version: 2 });
 });
 it("a built-in process has no version and reads as Rovara's", () => {
  const builtin = layerRows(howWeWorkView({ process: { kind: "builtin", agentId: "agt_cccccccccccccccccccc" }, rules: [] }));
  expect(builtin.project).toEqual([{ id: "process", title: "How this project works", value: "Rovara Code's built-in process", origin: "rovara-default", source: "layers" }]);
 });
 it("per step: a company lock, Rovara's fixed facts, the built-in instructions as one line, and a project instruction with its version", () => {
  const stage = (id: string) => steps.find(step => step.id === id)!.rows;
  expect(byId(stage("plan_critic"), "plan_critic:different")).toMatchObject({ title: "Checked by a different AI company from", value: "Plan", origin: "company-lock" });
  expect(byId(stage("plan_critic"), "plan_critic:tools")?.origin).toBe("rovara-fixed");
  expect(byId(stage("plan_critic"), "plan_critic:read-only")).toMatchObject({ origin: "rovara-fixed", value: "Nothing: it can read files but not change them" });
  expect(byId(stage("plan"), "plan:instructions-builtin")).toMatchObject({ origin: "rovara-default", value: "Rovara's own instructions for this step" });
  expect(byId(stage("plan"), "plan:instructions-1")).toMatchObject({ value: "Keep changes small.", origin: "project-choice", version: 2 });
  expect(byId(stage("build"), "build:instructions-0")).toMatchObject({ value: "Run the linter.", origin: "project-choice", version: 2 });
  expect(byId(stage("check"), "check:checked-0")).toMatchObject({ title: "How it's checked", value: "npm test", origin: "rovara-default" });
  expect(stage("plan").filter(row => row.id.includes("instructions-builtin"))).toHaveLength(1);
 });
 it("a second opinion setting is shown with its own origin", () => {
  const view = howWeWorkView();
  const stages = (view.stages as Array<Record<string, unknown>>).map(stage => stage.id === "review" ? { ...stage, who: { ...(stage.who as object), secondOpinion: { value: "on", source: "company", locked: true, lockedBy: "company" } } } : stage);
  const review = layerRows({ ...view, stages } as never).steps.find(step => step.id === "review")!.rows;
  expect(byId(review, "review:second")).toMatchObject({ title: "Second opinion from another AI company", origin: "company-lock" });
 });
});

describe("design review rows", () => {
 const read = (body: unknown) => ProjectPlaybookResponseSchema.parse(body);
 it("a locked field is a company lock, a changed field is the project's, an untouched one is Rovara's default", () => {
  const rows = designReviewRows(read(playbook()))!;
  expect(origins(rows)).toEqual({ "design-review:mode": "project-choice", "design-review:tier": "rovara-default", "design-review:allowSkip": "company-lock", "design-review:capUsdPerTask": "rovara-default", "design-review:highRiskApprover": "rovara-default" });
  expect(byId(rows, "design-review:mode")?.value).toMatch(/^Always/u);
  expect(byId(rows, "design-review:capUsdPerTask")?.value).toBe("$15.00. Above it, a person decides.");
 });
 it("with Rovara's own defaults nothing is a project choice", () => {
  const rows = designReviewRows(read(playbook({ designReviewLocked: [] }, { ...DESIGN_REVIEW_DEFAULT_SETTING, highRiskApprover: { kind: "maintainers" } })))!;
  expect(new Set(rows.map(row => row.origin))).toEqual(new Set(["rovara-default"]));
 });
 it("a company that has not allowed design review is one company lock; a stage that does not exist gives no rows; an unreadable setting says so", () => {
  expect(designReviewRows(read({ playbook: { revision: 1, defaultProcess: { kind: "builtin" } }, designReviewAllowed: false }))).toEqual([{ id: "design-review", title: "Design review", value: "Not turned on by your company", origin: "company-lock", source: "design-review" }]);
  expect(designReviewRows(read({ playbook: { revision: 1, defaultProcess: { kind: "builtin" } } }))).toBeUndefined();
  const unreadable = designReviewRows(read(playbook({ designReviewUnreadable: true }, { mode: "never" })))!;
  expect(byId(unreadable, "design-review:mode")?.value).toMatch(/couldn't be read/u);
 });
});

describe("model, lessons, learning, known failing and company rule rows", () => {
 it("a model row follows the resolver's own reason, names the model by its label and never shows an id", () => {
  const rows = modelRows(models());
  expect(origins(rows)).toMatchObject({ "model:build": "project-choice", "model:code_review": "company-lock", "model:plan": "rovara-default" });
  expect(rows.map(row => row.value).join(" ")).not.toMatch(/claude-|gpt-|\//u);
  expect(byId(rows, "model:build")?.title).toBe("Model for build");
 });
 it("lessons: a company preset is a lock, a waiting change is pending, the default mode is Rovara's, another mode is the project's", () => {
  const locked = lessonsRows(lessonsView({ preset: "regulated", presetLockedByCompany: true, lockedByCompany: true, mode: "On" }));
  expect(origins(locked)).toEqual({ "lessons:mode": "company-lock", "lessons:preset": "company-lock" });
  const own = lessonsRows(lessonsView({ preset: "regulated", mode: "Collect", presetProposal: { changeId: "chg_1", to: "standard", mine: false, soleOwner: false, expiresAt: 1 } }));
  expect(origins(own)).toEqual({ "lessons:mode": "project-choice", "lessons:preset": "project-choice" });
  expect(byId(own, "lessons:preset")?.pending).toBe(true);
  expect(byId(own, "lessons:mode")?.pending).toBeUndefined();
  const plain = lessonsRows(lessonsView({ preset: "standard", mode: "Suggest" }));
  expect(origins(plain)).toEqual({ "lessons:mode": "rovara-default", "lessons:preset": "rovara-default" });
 });
 it("a value a newer server sent that this version cannot read gets no row, and no origin is claimed for it", () => {
  const unknown = lessonsRows({ ...lessonsView({}), mode: "unknown", preset: "unknown" } as never);
  expect(unknown).toEqual([]);
  expect(taskRows({ agent: { version: "unknown", builtin: false } })[0]).not.toHaveProperty("version");
 });
 it("learning from review comments: locked is the company's, on is the project's, off is the default, a proposal is pending", () => {
  expect(learningRows(learning({ prComments: "off", locked: true, lockedBy: "company" }))[0]).toMatchObject({ origin: "company-lock", value: "Off" });
  expect(learningRows(learning({ prComments: "on" }))[0]).toMatchObject({ origin: "project-choice", value: "On" });
  expect(learningRows(learning({ prComments: "off" }))[0]!.origin).toBe("rovara-default");
  expect(learningRows(learning({ prComments: "off", pendingProposal: { id: "prop_1" } }))[0]!.pending).toBe(true);
 });
 it("known failing tests: always two people is a lock, off is the default, a request to turn it off is pending", () => {
  expect(knownFailingRows(policy())[0]).toMatchObject({ origin: "company-lock", value: "Two people must agree" });
  expect(knownFailingRows(policy({ alwaysTwoPeople: false }))[0]).toMatchObject({ origin: "rovara-default" });
  expect(knownFailingRows(policy({ pendingLoosening: true }))[0]!.pending).toBe(true);
  expect(knownFailingRows(policy({ pendingLoosening: false }))[0]!.pending).toBeUndefined();
 });
 it("company rules: the count in words, a lock while any rule is required, the version and a waiting proposal", () => {
  expect(companyRulesRows({ required: 2, preferred: 1, version: 3, pending: true })[0]).toMatchObject({ value: "3 company rules apply (2 required, 1 preferred)", origin: "company-lock", version: 3, pending: true, manage: "company-rules" });
  expect(companyRulesRows({ required: 0, preferred: 1, pending: false })[0]).toMatchObject({ value: "1 company rule applies (0 required, 1 preferred)", origin: "company-default" });
  expect(companyRulesRows({ required: 0, preferred: 0, pending: false })[0]).toMatchObject({ value: "No company rules yet", origin: "company-default" });
 });
 it("the company rules reader takes counts only, and refuses anything it cannot read", () => {
  expect(CompanyRulesSummaryReader.parse(rules(2, 1))).toEqual({ required: 2, preferred: 1, pending: false, version: 3 });
  expect(CompanyRulesSummaryReader.parse(rules(0, 0, { pending: { proposalId: "x" } }))).toEqual({ required: 0, preferred: 0, pending: true });
  for (const bad of [null, "x", {}, { current: {} }, { current: { rules: [{ priority: "must" }] } }]) expect(() => CompanyRulesSummaryReader.parse(bad)).toThrow();
 });
 it("task rows: a person's Design first or Skip is a task choice; Auto follows the project; the process comes from the agent", () => {
  expect(taskRows({ designReview: { decidedBy: "person" } })[0]).toMatchObject({ origin: "task-choice", value: "A person asked for design first" });
  expect(taskRows({ designReview: { decidedBy: "person_skip" } })[0]).toMatchObject({ origin: "task-choice", value: "A person skipped it" });
  expect(taskRows({ designReview: { decidedBy: "auto" } })[0]!.origin).toBe("rovara-default");
  expect(taskRows({ designReview: { decidedBy: "always" } })[0]!.origin).toBe("project-choice");
  expect(taskRows({ designReview: { decidedBy: "never" } })).toEqual([]);
  expect(taskRows({ agent: { version: 4, builtin: false } })[0]).toMatchObject({ origin: "project-choice", version: 4 });
  expect(taskRows({ agent: { version: "draft", builtin: true } })[0]).toMatchObject({ origin: "rovara-default" });
  expect(taskRows({ agent: { version: "draft", builtin: true } })[0]).not.toHaveProperty("version");
  expect(taskRows({})).toEqual([]);
 });
});

function panel(world: AgreementWorld = {}, variant: "project" | "task" = "project", task?: Parameters<typeof taskRows>[0]) {
 const f = agreementHost(world), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(WorkingAgreementPanel, { project: "payments", variant, ...(task === undefined ? {} : { task }) }) }) }) }) }));
 return { ...f, ...ui, query };
}
const rowOf = (title: string | RegExp) => screen.getAllByText(title)[0]!.closest("li") as HTMLElement;
const settled = async () => { await waitFor(() => expect(document.querySelector(".rv-agree")?.getAttribute("aria-busy")).toBe("false")); };

describe("the panel", () => {
 it("shows each rule with its origin chip, the version, and a Why? link on a lock only", async () => {
  panel();
  expect(await screen.findByRole("heading", { name: "Working agreement", level: 2 })).toBeTruthy();await settled();
  const skip = rowOf("Design review: skipping");
  expect(within(skip).getByText("Company lock")).toBeTruthy();
  expect(within(skip).getByText("Why?")).toBeTruthy();
  const mode = rowOf("Design review: when it runs");
  expect(within(mode).getByText("Project choice")).toBeTruthy();expect(within(mode).queryByText("Why?")).toBeNull();
  const process = rowOf("How this project works");
  expect(within(process).getByText("Version 2")).toBeTruthy();
  expect(within(rowOf("Company rules")).getByText("Version 3")).toBeTruthy();
  // The lock chip is the company-lock kind (accent colour with a lock icon), and an ordinary origin is a plain chip.
  expect(skip.querySelector(".rv-chip-company-lock svg")).toBeTruthy();
  expect(mode.querySelector(".rv-chip-company-lock")).toBeNull();
 });
 it("explains a company lock: an admin is pointed to Company settings, anyone else to an admin; a Rovara fact says it is fixed for safety", async () => {
  panel();await settled();
  const skip = rowOf("Design review: skipping");
  fireEvent.click(within(skip).getByText("Why?"));
  expect(within(skip).getByText(/^Your company set this, and a project can.t change it\./u)).toBeTruthy();
  expect(within(skip).getByRole("link", { name: "How we work in Company settings" }).getAttribute("href")).toBe("/app/admin/how-we-work");
  expect(within(skip).queryByText(/ask a company admin/u)).toBeNull();
  // A step's fixed facts.
  fireEvent.click(screen.getAllByText(/^Plan check/u).find(node => node.tagName === "SUMMARY")!);
  const readOnly = rowOf("What it may change");
  fireEvent.click(within(readOnly).getByText("Why?"));
  expect(within(readOnly).getByText(T.WHY_ROVARA)).toBeTruthy();
 });
 it("a member who is not an admin is told to ask one, and gets no link into Company settings", async () => {
  panel({ admin: false });await settled();
  const skip = rowOf("Design review: skipping");
  fireEvent.click(within(skip).getByText("Why?"));
  expect(within(skip).getByText(/To ask for a change, ask a company admin\./u)).toBeTruthy();
  expect(within(skip).queryByRole("link")).toBeNull();
  expect(screen.queryByRole("link", { name: /Company rules in Company settings/u })).toBeNull();
 });
 it("says how many company rules apply, and links an admin to Company rules", async () => {
  panel();await settled();
  const row = rowOf("Company rules");
  expect(within(row).getByText("3 company rules apply (2 required, 1 preferred)")).toBeTruthy();
  expect(within(row).getAllByRole("link", { name: "Company rules in Company settings" })[0]!.getAttribute("href")).toBe("/app/admin/company-rules");
 });
 it("says Waiting for a second admin on a protected change that is pending, and only there", async () => {
  panel({ lessons: lessonsView({ preset: "regulated", presetLockedByCompany: false, presetProposal: { changeId: "chg_1", to: "standard", mine: false, soleOwner: false, expiresAt: 1 } }), policy: policy({ pendingLoosening: true }), learning: learning({ pendingProposal: { id: "prop_1" } }), rules: rules(1, 0, { pending: { proposalId: "p" } }) });await settled();
  expect(screen.getAllByText(T.PENDING)).toHaveLength(4);
  for (const title of ["Who approves lessons", "Marking a failing test as known", "Learn from pull request review comments", "Company rules"]) expect(within(rowOf(title)).getByText(T.PENDING)).toBeTruthy();
  expect(within(rowOf("Learning from work")).queryByText(T.PENDING)).toBeNull();
 });
 it("shows nothing as pending when nothing is", async () => {
  panel();await settled();
  expect(screen.queryByText(T.PENDING)).toBeNull();
 });
 it("lists a source that is not served as Not available yet, with no guessed rows, and always the merge and approval settings", async () => {
  panel({ off: ["rules", "playbook", "models"] });await settled();
  const missing = screen.getByRole("list", { name: T.SECTION_MISSING });
  for (const name of ["Company rules", "Design review", "AI models by step"]) expect(within(within(missing).getByText(name).closest("li") as HTMLElement).getByText(T.MISSING)).toBeTruthy();
  for (const name of [/^Merge rules/u, /^Approval settings/u]) expect(within(within(missing).getByText(name).closest("li") as HTMLElement).getByText(T.MISSING)).toBeTruthy();
  expect(screen.queryByText(/^Design review: /u)).toBeNull();
  expect(screen.queryByText("Company rules", { selector: ".rv-agree-title" })).toBeNull();
  expect(screen.queryByText(T.SECTION_MODELS, { selector: "h3" })).toBeNull();
  // The rest still shows.
  expect(screen.getByText("Who approves lessons")).toBeTruthy();
 });
 it("a design review stage the install does not have is also Not available yet", async () => {
  panel({ playbook: { playbook: { revision: 1, defaultProcess: { kind: "builtin" } } } });await settled();
  expect(within(within(screen.getByRole("list", { name: T.SECTION_MISSING })).getByText("Design review").closest("li") as HTMLElement).getByText(T.MISSING)).toBeTruthy();
 });
 it("a read that failed says so and can be tried again", async () => {
  const f = panel({ broken: ["policy"] });await settled();
  const row = within(screen.getByRole("list", { name: T.SECTION_MISSING })).getByText("Known failing tests").closest("li") as HTMLElement;
  expect(within(row).getByText(new RegExp(T.FAILED.replace("?", "\\?"), "u"))).toBeTruthy();
  const before = f.calls().filter(call => call.endsWith("known-failing-policy")).length;
  fireEvent.click(within(row).getByRole("button", { name: T.RETRY }));
  await waitFor(() => expect(f.calls().filter(call => call.endsWith("known-failing-policy")).length).toBeGreaterThan(before));
 });
 it("with every source missing it still renders the heading and the lists of what is missing, and no row", async () => {
  panel({ off: ["view", "playbook", "models", "lessons", "learning", "policy", "rules"] });await settled();
  expect(screen.getByRole("heading", { name: "Working agreement" })).toBeTruthy();
  expect(document.querySelectorAll(".rv-agree-row")).toHaveLength(0);
  expect(within(screen.getByRole("list", { name: T.SECTION_MISSING })).getAllByText(T.MISSING)).toHaveLength(9);
 });
 it("shows the models by their names, the steps as closed sections, and no raw id or code", async () => {
  panel();await settled();
  const models = screen.getByRole("list", { name: T.SECTION_MODELS });
  expect(within(models).getAllByRole("listitem").length).toBeGreaterThanOrEqual(2);
  expect(within(rowOf("Model for code review")).getByText("Company lock")).toBeTruthy();
  const steps = [...document.querySelectorAll<HTMLDetailsElement>(".rv-agree-step")];
  expect(steps.map(step => step.querySelector("summary")!.textContent.replace(/ \(.*\)$/u, ""))).toEqual(["Plan", "Plan check", "Build", "Checks", "Review", "Pull request"]);
  expect(steps.every(step => !step.open)).toBe(true);
  expect(document.querySelector(".rv-agree")!.textContent).not.toMatch(/claude-|gpt-|COMPANY_LOCK|BUILTIN_DEFAULT|company-lock|rovara-fixed|undefined|\[object/u);
 });
 it("writes nothing: it only reads", async () => {
  const f = panel();await settled();
  expect(f.request.mock.calls.every(([request]) => request.method === "GET")).toBe(true);
 });
 it("text from a rule is shown as plain text", async () => {
  const view = howWeWorkView({ rules: [{ value: "<img src=x onerror=alert(1)> **bold** ‮gnp", source: "project", locked: false }] });
  panel({ view });await settled();
  expect(document.querySelector(".rv-agree img")).toBeNull();
  expect(screen.getByText(/<img src=x onerror=alert\(1\)> \*\*bold\*\* \[U\+202E\]gnp/u)).toBeTruthy();
 });
 it("passes axe, with a lock explained and a step opened", async () => {
  const f = panel();await settled();
  fireEvent.click(within(rowOf("Design review: skipping")).getByText("Why?"));
  (document.querySelector(".rv-agree-step") as HTMLDetailsElement).open = true;
  await expectNoAxeViolations(f.container);
 });
 it("the compact task version: the project-wide rules and the task's own choices, no models and no steps", async () => {
  const f = panel({}, "task", { designReview: { decidedBy: "person" }, agent: { version: 2, builtin: false } });
  expect(await screen.findByRole("heading", { name: "Working agreement", level: 3 })).toBeTruthy();await settled();
  expect(within(rowOf("Design review for this task")).getByText("Task choice")).toBeTruthy();
  expect(within(rowOf("Process this task runs")).getByText("Version 2")).toBeTruthy();
  expect(screen.queryByText(T.SECTION_MODELS)).toBeNull();expect(document.querySelector(".rv-agree-step")).toBeNull();
  expect(screen.getByText(T.TASK_INTRO)).toBeTruthy();
  expect(within(screen.getByRole("list", { name: T.SECTION_MISSING })).getByText(/^The rules this task started with/u)).toBeTruthy();
  expect(f.calls().some(call => call.endsWith("/stage-models"))).toBe(false);
  await expectNoAxeViolations(f.container);
 });
});

describe("where it is placed", () => {
 function project(on: boolean) {
  const calls: string[] = [];
  const cell = howWeWorkHost({ handle: async (request, url) => {
   calls.push(url.pathname);
   const part = ({ "/v1/app/projects/payments/playbook": "playbook", "/v1/app/projects/payments/lessons": "lessons", "/v1/app/org/known-failing-policy": "policy", "/v1/app/org/company-rules": "rules" } as Record<string, Part>)[url.pathname];
   if (request.method === "GET" && part !== undefined) return agreementBody({}, part);
   return undefined;
  } });
  if (on) cell.storage.set(AGREEMENT_STORAGE_KEY, "v2");
  const query = createQueryClient();
  const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments?tab=how-we-work"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }));
  return { ...cell, ...ui, calls };
 }
 it("off: the How we work tab is today's, and nothing of the panel is requested", async () => {
  const f = project(false);
  await screen.findByRole("heading", { name: "Build" });
  expect(screen.queryByRole("heading", { name: "Working agreement" })).toBeNull();
  expect(f.calls).not.toContain("/v1/app/org/company-rules");
  expect(document.querySelector(".rv-agree")).toBeNull();
 });
 it("on: the panel sits above the stage cards on the How we work tab", async () => {
  project(true);
  const heading = await screen.findByRole("heading", { name: "Working agreement", level: 2 });
  await screen.findByRole("heading", { name: "Build" });
  const build = screen.getByRole("heading", { name: "Build" });
  expect(heading.compareDocumentPosition(build) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  await waitFor(() => expect(screen.getByText("3 company rules apply (2 required, 1 preferred)")).toBeTruthy());
 });
 function task(on: boolean, review = designReviewFixture({ decidedBy: "person" })) {
  const f = agreementHost({}), query = createQueryClient(), session = designTaskSession(review);
  if (on) f.storage.set(AGREEMENT_STORAGE_KEY, "v2");
  const ui = renderUi(h(AppHostProvider, { host: f.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { children: h(Announcer, { children: h(PipelineTab, { session, task: (session.body as unknown as { task: never }).task }) }) }) }) }));
  return { ...f, ...ui };
 }
 it("the task page: off shows no section and reads nothing; on shows one closed section that reads only when opened", async () => {
  const off = task(false);
  expect(screen.queryByText("Working agreement")).toBeNull();
  expect(off.calls().filter(call => call.includes("company-rules"))).toEqual([]);
  off.unmount();
  const on = task(true);
  const summary = await screen.findByText("Working agreement", { selector: "summary" });
  expect(on.calls().filter(call => call.includes("company-rules"))).toEqual([]);
  fireEvent.click(summary);
  expect(await screen.findByRole("heading", { name: "Working agreement", level: 3 })).toBeTruthy();
  await waitFor(() => expect(within(rowOf("Design review for this task")).getByText("Task choice")).toBeTruthy());
  expect(on.calls().filter(call => call.includes("company-rules"))).toHaveLength(1);
 });
});
