// @vitest-environment jsdom
// Track record (v1.2 slice 1), the app: the How we work cards say what each checking stage has earned, in plain words, and a confirmation shows the stage's lines beside each less-safe change.
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
import { diffBody, howWeWorkHost, howWeWorkView, type Handler } from "./support/how-we-work-fixture.js";
import { record, stageRecords } from "./support/how-we-work-view.js";

const REVERTS = "Reverts after merge aren't tracked yet";
/** The view as the broker sends it, with `change` applied to the raw object (a record the strict schema would refuse, as a newer server could send). */
const raw = (change: (stages: Array<Record<string, unknown>>) => void = () => undefined) => { const view = structuredClone(howWeWorkView()) as { stages: Array<Record<string, unknown>> };for (const entry of view.stages) if (stageRecords[entry.id as string] !== undefined) entry.trackRecord = structuredClone(stageRecords[entry.id as string]);change(view.stages);return view; };
function setup(options: { view?: unknown; handle?: Handler } = {}) {
 const cell = howWeWorkHost({ view: raw(), ...options }), query = createQueryClient();
 const ui = renderUi(h(AppHostProvider, { host: cell.host, children: h(QueryClientProvider, { client: query, children: h(MemoryRouter, { initialEntries: ["/app/projects/payments?tab=how-we-work"], children: h(Announcer, { children: h(Routes, { children: h(Route, { path: "/app/projects/:name", element: h(ProjectScreen, {}) }) }) }) }) }) }), { theme: "light" });
 return { ...cell, ...ui };
}
const card = (name: string) => screen.getByRole("region", { name });
const open = async (options: Parameters<typeof setup>[0] = {}) => { const world = setup(options);await screen.findByRole("heading", { name: "Build" });return world; };
const stageOf = (stages: Array<Record<string, unknown>>, id: string) => stages.find(entry => entry.id === id)!;

describe("the record on each card", () => {
 it("says the person approved the plan N of M times on the plan check, with no limits line", async () => {
  await open();
  const group = within(card("Plan check")).getByRole("group", { name: "Track record" });
  expect(within(group).getByText("Plan check")).toBeTruthy();
  expect(within(group).getByText("The person approved the plan 14 of 17 times (last 30 days)")).toBeTruthy();
  expect(group.querySelectorAll(".rv-hww-record-limits")).toHaveLength(0);
 });

 it("gives the review one record for code review and one for security review, with the limits and the reverts sentence", async () => {
  await open();
  const group = within(card("Review")).getByRole("group", { name: "Track record" });
  expect(within(group).getByText("Code review")).toBeTruthy();
  expect(within(group).getByText("No changes requested by a person on 9 of 10 merged PRs (last 30 days)")).toBeTruthy();
  expect(within(group).getByText(`2 closed unmerged · 3 merged without a person's review · ${REVERTS}`)).toBeTruthy();
  expect(within(group).getByText("Security review")).toBeTruthy();
  expect(within(group).getByText("Not enough history yet (6 so far)")).toBeTruthy();
  expect(within(group).getByText(REVERTS)).toBeTruthy();
 });

 it("says CI passed on N of M PRs where tests said they prove the change on the Checks card", async () => {
  await open();
  const group = within(card("Checks")).getByRole("group", { name: "Track record" });
  expect(within(group).getByText("CI passed on 14 of 16 PRs where tests said they prove the change (last 30 days)")).toBeTruthy();
  expect(within(group).getByText("CI failures unrelated to the change also count")).toBeTruthy();
 });

 it("shows the cap, and still shows the record when the filter hides every setting row", async () => {
  await open({ view: raw(stages => { stageOf(stages, "plan_critic").trackRecord = [record("plan_ready", 1500, 400, { capped: true })]; }) });
  fireEvent.click(screen.getByRole("radio", { name: "Locked" }));
  expect(within(card("Checks")).getByText(/Nothing here is changed or locked/u)).toBeTruthy();
  expect(within(card("Checks")).getByText(/CI passed on 14 of 16 PRs/u)).toBeTruthy();
  expect(within(card("Plan check")).getByText("The person approved the plan 1500 of 1900 times (last 30 days) (based on the latest 2000)")).toBeTruthy();
 });

 it("shows no record, and no zero, for a stage whose record was not read, and none on the other stages", async () => {
  await open({ view: raw(stages => { delete stageOf(stages, "plan_critic").trackRecord; }) });
  expect(within(card("Plan check")).queryByRole("group", { name: "Track record" })).toBeNull();
  expect(within(card("Plan check")).queryByText(/Not enough history|of \d+ times/u)).toBeNull();
  for (const name of ["Build", "Pull request"]) expect(within(card(name)).queryByRole("group", { name: "Track record" })).toBeNull();
 });

 it("leaves out a claim this version does not know, and never names the PR risk claim", async () => {
  await open({ view: raw(stages => { stageOf(stages, "review").trackRecord = [record("some_new_claim", 3, 1), record("review_pass:CRITIC", 9, 1)]; }) });
  const group = within(card("Review")).getByRole("group", { name: "Track record" });
  expect(within(group).queryByText("some_new_claim")).toBeNull();
  expect(within(group).getByText("Code review")).toBeTruthy();
  expect(document.body.textContent).not.toMatch(/risk_low|rated low risk|Early signal/u);
 });

 it("has no accessibility violations with the records shown", async () => {
  const world = await open();
  await expectNoAxeViolations(world.container);
 });
});

describe("a confirmation shows the stage's record beside each less-safe change", () => {
 const reasons = ["Changes the instructions of the review step \"Review\"", "Raises the agent's autonomy from suggest to run", "Changes the instructions of the plan check \"Plan check\""];
 const lessSafeDiff: Handler = (request, url) => url.pathname.endsWith("/diff") ? { status: 200, body: diffBody(2, ["Changes the review instructions"], reasons) } : undefined;
 const publish = async () => { fireEvent.click(await screen.findByRole("button", { name: "Review changes" })); const dialog = await screen.findByRole("dialog", { name: "Review changes" });await within(dialog).findByText("What changes");return dialog; };
 const item = (dialog: HTMLElement, text: string) => within(dialog).getByText(text).closest("li")!;

 it("in the review dialog: the review's lines under a review change, the plan check's under a plan check change, and nothing under a change about no stage", async () => {
  await open({ handle: lessSafeDiff });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  const dialog = await publish();
  const review = item(dialog, reasons[0]!);
  expect(within(review).getByText("No changes requested by a person on 9 of 10 merged PRs (last 30 days)")).toBeTruthy();
  expect(within(review).getByText(`2 closed unmerged · 3 merged without a person's review · ${REVERTS}`)).toBeTruthy();
  expect(within(review).getByText("Not enough history yet (6 so far)")).toBeTruthy();
  expect(within(item(dialog, reasons[2]!)).getByText("The person approved the plan 14 of 17 times (last 30 days)")).toBeTruthy();
  expect(within(item(dialog, reasons[1]!)).queryByRole("group", { name: "Track record" })).toBeNull();
  expect(item(dialog, reasons[1]!).textContent).toBe(reasons[1]);
 });

 it("after the publish is sent for confirmation: the same lines under each change that waits", async () => {
  await open({ handle: (request, url) => url.pathname.endsWith("/publish") ? { status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", confirmUrl: "https://cell.example/v1/app/approve/abc123", changes: [reasons[0], reasons[1]] } } : lessSafeDiff(request, url) });
  await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Review changes" }).disabled).toBe(false));
  const dialog = await publish();
  fireEvent.click(within(dialog).getByRole("button", { name: "Publish" }));
  await within(dialog).findByText("Sent for confirmation: someone else who can approve changes in this project confirms it.");
  const waiting = within(dialog).getAllByRole("status").find(node => node.textContent?.includes("Sent for confirmation"))!;
  const first = within(waiting).getByText(reasons[0]!).closest("li")!;
  expect(within(first).getByText("No changes requested by a person on 9 of 10 merged PRs (last 30 days)")).toBeTruthy();
  expect(within(within(waiting).getByText(reasons[1]!).closest("li")!).queryByRole("group", { name: "Track record" })).toBeNull();
 });
});
