// @vitest-environment jsdom
import { describe, expect, it } from "vitest";
import { act, screen, within } from "@testing-library/react";
import { lessonItem } from "../../../../packages/cloud-server/src/lessons-routes.js";
import { mount } from "./mount.js";
import { bodies, lesson, responder, ROOT } from "./fixtures.js";

describe("REVIEW-1 server lesson compatibility", () => {
 it("renders the real Cloud lesson mapper response in the live Learned lists", async () => {
  const answer = responder();
  mount("/app/projects/payments?tab=lessons", async request => {
   if (new URL(request.path, "https://fixture.invalid").pathname !== ROOT + "/lessons") return answer(request);
   return { status: 200, body: { project: "payments", list: "approved", canDecide: true, lessons: [lessonItem(lesson)] } };
  });
  expect(await screen.findByRole("heading", { name: "Retry only idempotent calls" })).toBeTruthy();
  expect(screen.getByText(/Bound retries to three attempts/)).toBeTruthy();
 });
});

describe("REVIEW-1 How we work read hierarchy", () => {
 it("keeps the approved read regions in order with honest unsupported facts", async () => {
  mount();
  const follows = await screen.findByRole("heading", { name: "Rules for every task in this project" });
  const design = await screen.findByRole("heading", { name: "Design review" });
  const repo = screen.getByRole("heading", { name: "Instructions from the repo" });
  expect(follows.compareDocumentPosition(design) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(design.compareDocumentPosition(repo) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  expect(screen.getByText("We can’t tell yet which instruction files or skills were found in this repo.")).toBeTruthy();
  expect(screen.getByText("We can’t tell yet. This read does not report the setting for new tasks.")).toBeTruthy();
  expect(await screen.findByText("On for new tasks")).toBeTruthy();
  expect(screen.queryByText(/We found AGENTS.md/)).toBeNull();
 });
 for (const [mode, expected] of [["always", "On for new tasks"], ["auto", "When the task needs design decisions"], ["never", "Off for new tasks"]] as const) {
  it("reads design review " + mode + " from the current playbook", async () => {
   const data = bodies();data.playbook.playbook.designReview!.mode = mode;
   mount(undefined, responder(data));
   expect(await screen.findByText(expected)).toBeTruthy();
   expect(screen.queryByText("Use company default · effective On")).toBeNull();
  });
 }
 it("uses company availability before a stored design-review setting", async () => {
  const data = bodies();data.playbook.designReviewAllowed = false;
  mount(undefined, responder(data));
  expect(await screen.findByText("Not enabled for this company.")).toBeTruthy();
  expect(screen.queryByText("On for new tasks")).toBeNull();
 });
 it("does not infer design review from a playbook without the setting", async () => {
  const data = bodies();delete data.playbook.playbook.designReview;
  mount(undefined, responder(data));
  expect(await screen.findByText("We can’t tell yet. No current setting was returned.")).toBeTruthy();
  expect(screen.queryByText("On for new tasks")).toBeNull();
 });
 it("keeps the read regions when playbook settings are unsupported", async () => {
  const answer = responder();mount(undefined, async r => r.path.endsWith("/playbook") ? { status: 501, body: {} } : answer(r));
  expect(await screen.findByText("We can’t tell yet. The current setting could not be read.")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Instructions from the repo" })).toBeTruthy();
  expect(screen.queryByText("On for new tasks")).toBeNull();
 });
 it("R1 drops previously read design-review facts after an access refusal", async () => {
  let fail = false;const answer = responder();
  const view = mount(undefined, async r => fail && r.path.endsWith("/playbook") ? { status: 403, body: {} } : answer(r));
  await screen.findByText("On for new tasks");fail = true;
  await act(async () => { await view.query.invalidateQueries(); });
  expect(await screen.findByText("We can’t tell yet. The current setting could not be read.")).toBeTruthy();
  expect(screen.queryByText("On for new tasks")).toBeNull();
  const settings = screen.getByRole("region", { name: "Design review" });
  expect(within(settings).getByRole("button", { name: "Load again" })).toBeTruthy();
 });
});
