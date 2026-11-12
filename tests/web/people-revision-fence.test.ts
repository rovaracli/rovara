// @vitest-environment jsdom
// Every write of the People tab, the merge rules, the collaborator approvals switch and the product decisions is fenced by the revision the page read WHEN THE EDITOR OPENED, never by the live query at click time.
// A focus refetch or a realtime reset can bring a newer revision while a dialog is open; an old draft must still be sent under the OLD revision so the server answers CHANGE_STALE instead of letting it overwrite
// somebody else's change. A stale answer keeps what the person typed and offers "Discard my changes and reload", after which the next open reads the newer revision.
import { expect, it } from "vitest";
import { act, screen, fireEvent, waitFor, within } from "@testing-library/react";
import { PROJECT_PEOPLE_STALE_MESSAGE } from "@agentx/cloud-contracts/web";
import type { ApiRequest } from "../../packages/ui/src/host.js";
import { ID, approvals, decision, mountProject, peopleView, settings, type Answer, type Options } from "./support/people-fixture.js";

// jsdom has no ResizeObserver, which the switch inside a form measures with.
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
const ok = (body: unknown): Answer => ({ status: 200, body });
const refusal = (status: number, code: string, message: string): Answer => ({ status, body: { error: { code, message } } });
const STALE: Answer = refusal(409, "CHANGE_STALE", PROJECT_PEOPLE_STALE_MESSAGE);
const SETTINGS_STALE = "Someone changed these settings. Reload and try again.";
const GET = (path: string) => (request: ApiRequest) => request.method === "GET" && request.path === path;

/** The server now has newer state: refetch the query as a window focus or a realtime reset would, and wait until the page has it. */
async function refetched(f: ReturnType<typeof mountProject>, key: readonly string[], path: string): Promise<void> {
  const before = f.calls(GET(path)).length;
  await act(async () => { await f.query.invalidateQueries({ queryKey: key }); });
  await waitFor(() => { expect(f.calls(GET(path)).length).toBeGreaterThan(before); });
  await act(async () => { await new Promise(resolve => setTimeout(resolve, 20)); });
}
/** The panel itself: the rest of the overview answers what it answers, and any alert there is not the panel's. */
const panel = async () => (await screen.findByRole("heading", { name: "Product decisions" })).closest("section")!;
const writes = (f: ReturnType<typeof mountProject>, match: RegExp) => f.calls(request => request.method !== "GET" && match.test(request.path)).map(request => request.body as Record<string, unknown>);

it("role change: the open dialog sends the revision it opened under (7) though the page now has 9; the stale answer keeps the draft; discarding then reopening uses 9", async () => {
  let stale = true;
  const options: Options = { people: ok(peopleView()), write: request => request.method === "PUT" ? (stale ? STALE : ok({ member: { developerId: ID.sam, role: "viewer" }, revision: 10 })) : undefined };
  const f = mountProject(options);
  fireEvent.click(await screen.findByRole("button", { name: "Change role for Sam Ortiz" }));
  fireEvent.change(await screen.findByLabelText("Role", { exact: true }), { target: { value: "viewer" } });
  options.people = ok(peopleView({ revision: 9 }));
  await refetched(f, ["project", "payments", "people"], "/v1/app/projects/payments/people");
  fireEvent.click(screen.getByRole("button", { name: "Save role" }));
  expect((await screen.findByRole("alert")).textContent).toBe(PROJECT_PEOPLE_STALE_MESSAGE);
  expect(writes(f, /\/people\//u).map(body => body["expectedRevision"])).toEqual([7]);
  expect(screen.getByLabelText<HTMLSelectElement>("Role", { exact: true }).value).toBe("viewer");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save role" }).disabled).toBe(true);
  stale = false;
  fireEvent.click(screen.getByRole("button", { name: "Discard my changes and reload" }));
  await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
  fireEvent.click(await screen.findByRole("button", { name: "Change role for Sam Ortiz" }));
  fireEvent.change(await screen.findByLabelText("Role", { exact: true }), { target: { value: "viewer" } });
  fireEvent.click(screen.getByRole("button", { name: "Save role" }));
  await screen.findByText("Sam Ortiz is now viewer.");
  expect(writes(f, /\/people\//u).map(body => body["expectedRevision"])).toEqual([7, 9]);
  f.close();
});

it("add: the open dialog sends the revision it opened under, and a stale answer keeps the chosen person and role", async () => {
  const options: Options = { people: ok(peopleView()), write: request => request.method === "PUT" ? STALE : undefined };
  const f = mountProject(options);
  fireEvent.click(await screen.findByRole("button", { name: "Add a person" }));
  const who = await screen.findByLabelText<HTMLSelectElement>("Person", { exact: true });
  await waitFor(() => { expect([...who.options].map(option => option.textContent)).toContain("Ana Silva"); });
  fireEvent.change(who, { target: { value: ID.ana } });
  fireEvent.change(screen.getByLabelText("Role", { exact: true }), { target: { value: "collaborator" } });
  options.people = ok(peopleView({ revision: 9 }));
  await refetched(f, ["project", "payments", "people"], "/v1/app/projects/payments/people");
  fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
  expect((await screen.findByRole("alert")).textContent).toBe(PROJECT_PEOPLE_STALE_MESSAGE);
  expect(writes(f, /\/people\//u).map(body => body["expectedRevision"])).toEqual([7]);
  expect(screen.getByLabelText<HTMLSelectElement>("Person", { exact: true }).value).toBe(ID.ana);
  expect(screen.getByLabelText<HTMLSelectElement>("Role", { exact: true }).value).toBe("collaborator");
  expect(screen.getByRole("button", { name: "Discard my changes and reload" })).toBeTruthy();
  f.close();
});

it("remove: the open dialog sends the revision it opened under, and a stale answer offers the discard", async () => {
  const options: Options = { people: ok(peopleView()), write: request => request.method === "DELETE" ? STALE : undefined };
  const f = mountProject(options);
  fireEvent.click(await screen.findByRole("button", { name: "Remove Lee Park from the project" }));
  await screen.findByRole("button", { name: "Remove from project" });
  options.people = ok(peopleView({ revision: 9 }));
  await refetched(f, ["project", "payments", "people"], "/v1/app/projects/payments/people");
  fireEvent.click(screen.getByRole("button", { name: "Remove from project" }));
  expect((await screen.findByRole("alert")).textContent).toBe(PROJECT_PEOPLE_STALE_MESSAGE);
  expect(writes(f, /\/people\//u).map(body => body["expectedRevision"])).toEqual([7]);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Remove from project" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard my changes and reload" }));
  await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
  f.close();
});

it("merge rules: the dialog keeps its opening revision (3) and its opening draft though the page now has 5; the stale answer keeps what was typed; reopening uses 5", async () => {
  let stale = true;
  const options: Options = { settings: ok(settings()), write: request => request.path.endsWith("/code-settings") ? (stale ? refusal(400, "CONFIG_INVALID", SETTINGS_STALE) : ok(settings({ mergeMethod: "merge", revision: 6 }))) : undefined };
  const f = mountProject(options);
  fireEvent.click(await screen.findByRole("button", { name: "Change merge rules" }));
  fireEvent.change(await screen.findByLabelText("Merge method"), { target: { value: "merge" } });
  fireEvent.change(screen.getByLabelText(/Reviewers Rovara asks/u), { target: { value: "my-draft-reviewer" } });
  options.settings = ok(settings({ revision: 5, codeReviewers: ["someone-else"] }));
  await refetched(f, ["project", "payments", "code-settings"], "/v1/app/projects/payments/code-settings");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe(SETTINGS_STALE);
  expect(writes(f, /code-settings/u).map(body => body["expectedRevision"])).toEqual([3]);
  expect(screen.getByLabelText<HTMLTextAreaElement>(/Reviewers Rovara asks/u).value).toBe("my-draft-reviewer");
  expect(screen.getByLabelText<HTMLSelectElement>("Merge method").value).toBe("merge");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save" }).disabled).toBe(true);
  stale = false;
  fireEvent.click(screen.getByRole("button", { name: "Discard my changes and reload" }));
  await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
  fireEvent.click(await screen.findByRole("button", { name: "Change merge rules" }));
  fireEvent.change(await screen.findByLabelText("Merge method"), { target: { value: "merge" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => { expect(writes(f, /code-settings/u)).toHaveLength(2); });
  expect(writes(f, /code-settings/u).map(body => body["expectedRevision"])).toEqual([3, 5]);
  f.close();
});

it("collaborator approvals: the question holds the revision it was asked under (2) though the page now has 4; a stale answer offers the discard; asking again uses 4", async () => {
  let stale = true;
  const options: Options = { approvals: ok(approvals()), write: request => request.path.endsWith("/collaborator-approvals") ? (stale ? STALE : ok(approvals({ enabled: false, revision: 5 }))) : undefined };
  const f = mountProject(options);
  fireEvent.click(await screen.findByRole("switch", { name: "Let collaborators approve low-risk product decisions" }));
  await screen.findByRole("button", { name: "Turn off" });
  options.approvals = ok(approvals({ revision: 4 }));
  await refetched(f, ["project", "payments", "collaborator-approvals"], "/v1/app/projects/payments/collaborator-approvals");
  fireEvent.click(screen.getByRole("button", { name: "Turn off" }));
  expect((await screen.findByRole("alert")).textContent).toBe(PROJECT_PEOPLE_STALE_MESSAGE);
  expect(writes(f, /collaborator-approvals/u).map(body => body["expectedRevision"])).toEqual([2]);
  stale = false;
  fireEvent.click(screen.getByRole("button", { name: "Discard my changes and reload" }));
  await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
  fireEvent.click(await screen.findByRole("switch", { name: "Let collaborators approve low-risk product decisions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
  await waitFor(() => { expect(writes(f, /collaborator-approvals/u)).toHaveLength(2); });
  expect(writes(f, /collaborator-approvals/u).map(body => body["expectedRevision"])).toEqual([2, 4]);
  f.close();
});

it("approve a decision: the question holds the revision it was asked under (4) though the list now has 6; a stale answer offers the discard; asking again uses 6", async () => {
  let stale = true;
  const options: Options = { path: "/app/projects/payments", decisions: ok({ decisions: [decision()] }), write: request => request.method === "POST" ? (stale ? STALE : ok({ decision: decision({ status: "approved", revision: 7 }) })) : undefined };
  const f = mountProject(options);
  fireEvent.click(await screen.findByRole("button", { name: "Approve: Request a refund" }));
  await screen.findByRole("button", { name: "Approve" });
  options.decisions = ok({ decisions: [decision({ revision: 6 })] });
  await refetched(f, ["project", "payments", "product-decisions"], "/v1/app/projects/payments/product-decisions");
  fireEvent.click(screen.getByRole("button", { name: "Approve" }));
  expect((await screen.findByRole("alert")).textContent).toBe(PROJECT_PEOPLE_STALE_MESSAGE);
  expect(writes(f, /product-decisions\//u).map(body => body["expectedRevision"])).toEqual([4]);
  stale = false;
  fireEvent.click(screen.getByRole("button", { name: "Discard my changes and reload" }));
  await waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
  fireEvent.click(await screen.findByRole("button", { name: "Approve: Request a refund" }));
  fireEvent.click(await screen.findByRole("button", { name: "Approve" }));
  await waitFor(() => { expect(writes(f, /product-decisions\//u)).toHaveLength(2); });
  expect(writes(f, /product-decisions\//u).map(body => body["expectedRevision"])).toEqual([4, 6]);
  f.close();
});

it("answer a decision: the draft holds the revision of its first word (4) though the list now has 6; a stale answer keeps the typed answer and offers the discard", async () => {
  const options: Options = { path: "/app/projects/payments", decisions: ok({ decisions: [decision()] }), write: request => request.method === "POST" ? STALE : undefined };
  const f = mountProject(options);
  const box = await screen.findByLabelText("Add your answer");
  fireEvent.change(box, { target: { value: "Use the second" } });
  options.decisions = ok({ decisions: [decision({ revision: 6 })] });
  await refetched(f, ["project", "payments", "product-decisions"], "/v1/app/projects/payments/product-decisions");
  fireEvent.change(screen.getByLabelText("Add your answer"), { target: { value: "Use the second wording" } });
  fireEvent.click(screen.getByRole("button", { name: "Add answer" }));
  expect((await within(await panel()).findByRole("alert")).textContent).toBe(PROJECT_PEOPLE_STALE_MESSAGE);
  expect(writes(f, /product-decisions\//u).map(body => body["expectedRevision"])).toEqual([4]);
  expect(screen.getByLabelText<HTMLTextAreaElement>("Add your answer").value).toBe("Use the second wording");
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add answer" }).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Discard my changes and reload" }));
  await waitFor(() => { expect(screen.getByLabelText<HTMLTextAreaElement>("Add your answer").value).toBe(""); });
  f.close();
});

it("a 403 TASK_ACCESS_DENIED hides the People tab content and the decisions panel the same way a 404 does", async () => {
  for (const denied of [refusal(404, "NOT_FOUND", "Not found."), refusal(403, "TASK_ACCESS_DENIED", "You can't see this.")]) {
    const f = mountProject({ people: denied, decisions: denied, approvals: denied });
    expect(await screen.findByText("People isn't available for this project.")).toBeTruthy();
    f.close();
    const h = mountProject({ approvals: denied });
    expect(await screen.findByText("This setting isn't available for this project.")).toBeTruthy();
    h.close();
    const g = mountProject({ path: "/app/projects/payments", decisions: denied });
    expect(await screen.findByText("Product decisions aren't available for this project.")).toBeTruthy();
    g.close();
  }
});
