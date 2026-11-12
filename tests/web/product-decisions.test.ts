// @vitest-environment jsdom
// The project's product decisions panel (switch `rovara.people` = "v2"): a calm empty state, the question, options, risk and answers, approve and answer under the revision read, a refusal said in plain words from the
// server's `approveRefusal`, a stale answer reloading the list, and the server's own refusal text shown as it came.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { PROJECT_PEOPLE_STALE_MESSAGE } from "@agentx/cloud-contracts/web";
import { expectNoAxeViolations } from "./support/axe.js";
import { DECISION_ID, decision, mountProject, type Answer } from "./support/people-fixture.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Any v4 request id. */
const anyId = (): unknown => expect.stringMatching(UUID);
const ok = (body: unknown): Answer => ({ status: 200, body });
const list = (...decisions: unknown[]): Answer => ok({ decisions });
const OVERVIEW = "/app/projects/payments";
/** The panel itself: the rest of the overview answers what it answers, and any alert there is not the panel's. */
const panel = async () => (await screen.findByRole("heading", { name: "Product decisions" })).closest("section")!;
const reads = (f: ReturnType<typeof mountProject>) => f.calls(request => request.method === "GET" && request.path.endsWith("/product-decisions")).length;

it("switch off: no panel and no request for decisions (and the same page with the switch on does show it, so the check can fail)", async () => {
  const control = mountProject({ path: OVERVIEW });
  await screen.findByText("No product decisions waiting");
  control.close();
  const f = mountProject({ on: false, path: OVERVIEW });
  await screen.findByRole("heading", { name: "payments" });
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(screen.queryByRole("heading", { name: "Product decisions" })).toBeNull();
  expect(f.calls(request => request.path.includes("product-decisions"))).toEqual([]);
  f.close();
});

it("an empty list is a calm empty state, not an error", async () => {
  const f = mountProject({ path: OVERVIEW });
  expect(await screen.findByText("No product decisions waiting")).toBeTruthy();
  expect(within(await panel()).queryByRole("alert")).toBeNull();
  f.close();
});

it("shows the question, its options, risk and the answers so far", async () => {
  const f = mountProject({ path: OVERVIEW, decisions: list(decision({ risk: "medium", answers: [{ by: { developerId: "a".repeat(64), name: "Priya Rao" }, text: "Option two reads better", at: "2026-11-10T11:00:00.000Z" }] })) });
  expect(await screen.findByRole("heading", { name: "Which wording should the refund button use?" })).toBeTruthy();
  expect(screen.getByText("Refund now")).toBeTruthy();
  expect(screen.getByText("Request a refund")).toBeTruthy();
  expect(screen.getByText("Medium risk")).toBeTruthy();
  expect(screen.getByText("Option two reads better")).toBeTruthy();
  f.close();
});

it("approving sends the option id and the revision read, with a request id, then reloads the list", async () => {
  let body: Record<string, unknown> | undefined, path = "";
  const f = mountProject({ path: OVERVIEW, decisions: list(decision()), write: request => { if (request.method === "POST") { body = request.body as Record<string, unknown>;path = request.path;return ok({ decision: decision({ status: "approved", revision: 5 }) }); } return undefined; } });
  fireEvent.click(await screen.findByRole("button", { name: "Approve: Request a refund" }));
  await screen.findByText("Approved.");
  expect(path).toBe("/v1/app/projects/payments/product-decisions/" + DECISION_ID);
  expect(body).toEqual({ action: "approve", requestId: anyId(), expectedRevision: 4, optionId: "o2" });
  await waitFor(() => { expect(reads(f)).toBeGreaterThan(1); });
  f.close();
});

it("answering sends the text under the revision read; it is a note, and the approve buttons are the reader's own powers", async () => {
  let body: Record<string, unknown> | undefined;
  const f = mountProject({ path: OVERVIEW, decisions: list(decision({ you: { canAnswer: true, canApprove: false, approveRefusal: "role_not_allowed" } })), write: request => { if (request.method === "POST") { body = request.body as Record<string, unknown>;return ok({ decision: decision() }); } return undefined; } });
  expect(await screen.findByText(/Your role in this project can't approve this decision/u)).toBeTruthy();
  expect(screen.queryByRole("button", { name: /^Approve:/u })).toBeNull();
  fireEvent.change(screen.getByLabelText("Add your answer"), { target: { value: "  Use the second wording  " } });
  fireEvent.click(screen.getByRole("button", { name: "Add answer" }));
  await screen.findByText("Your answer was added.");
  expect(body).toEqual({ action: "answer", requestId: anyId(), expectedRevision: 4, text: "Use the second wording" });
  f.close();
});

it("each refusal reason has its own plain words, and a reader who can do neither sees no form", async () => {
  const words: Record<string, RegExp> = {
    role_not_allowed: /Your role in this project can't approve this decision/u,
    collaborator_approvals_off: /Collaborators can't approve decisions in this project right now: a maintainer has turned that off/u,
    fresh_sign_in_required: /Sign in again to approve/u,
  };
  for (const [reason, expected] of Object.entries(words)) {
    const f = mountProject({ path: OVERVIEW, decisions: list(decision({ you: { canAnswer: false, canApprove: false, approveRefusal: reason } })) });
    expect(await screen.findByText(expected)).toBeTruthy();
    expect(screen.queryByRole("button", { name: /^Approve:/u })).toBeNull();
    expect(screen.queryByLabelText("Add your answer")).toBeNull();
    f.close();
  }
});

it("a stale answer says so and reloads the list; any other refusal is the server's own words", async () => {
  const f = mountProject({ path: OVERVIEW, decisions: list(decision()), write: () => ({ status: 409, body: { error: { code: "CHANGE_STALE", message: "x" } } }) });
  fireEvent.click(await screen.findByRole("button", { name: "Approve: Refund now" }));
  expect((await within(await panel()).findByRole("alert")).textContent).toBe(PROJECT_PEOPLE_STALE_MESSAGE);
  await waitFor(() => { expect(reads(f)).toBeGreaterThan(1); });
  f.close();
  const words = "Collaborators can approve only low-risk product decisions.";
  const g = mountProject({ path: OVERVIEW, decisions: list(decision()), write: () => ({ status: 403, body: { error: { code: "FORBIDDEN", message: words } } }) });
  fireEvent.click(await screen.findByRole("button", { name: "Approve: Refund now" }));
  expect((await within(await panel()).findByRole("alert")).textContent).toBe(words);
  g.close();
});

it("an approved decision shows who approved which option and offers nothing more", async () => {
  const f = mountProject({ path: OVERVIEW, decisions: list(decision({ status: "approved", approved: { optionId: "o1", by: { developerId: "a".repeat(64), name: "Maya Chen" }, role: "maintainer", at: "2026-11-10T12:00:00.000Z", class: "product" }, you: { canAnswer: true, canApprove: true } })) });
  expect((await screen.findByRole("status")).textContent).toContain("Refund now");
  expect(screen.queryByRole("button", { name: /^Approve:/u })).toBeNull();
  expect(screen.queryByLabelText("Add your answer")).toBeNull();
  f.close();
});

it("the panel has no axe violations, light and dark", async () => {
  for (const theme of ["light", "dark"] as const) {
    document.documentElement.setAttribute("data-theme", theme);
    const f = mountProject({ path: OVERVIEW, decisions: list(decision()) });
    await screen.findByRole("heading", { name: "Which wording should the refund button use?" });
    await expectNoAxeViolations(screen.getByRole("heading", { name: "Product decisions" }).closest("section")!);
    f.close();
  }
});
