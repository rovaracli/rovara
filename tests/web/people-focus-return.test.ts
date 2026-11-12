// @vitest-environment jsdom
// Focus after a dialog closes (WCAG 2.4.3): back on the button that opened it, on cancel and after a save alike; where the opener is gone after a save (a removed person's row, an approved decision's buttons) it lands on
// the heading beside where it was, never on the page. Covers every dialog of the People tab, the merge rules, the collaborator approvals question and the approve-a-decision question.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { ApiRequest } from "../../packages/ui/src/host.js";
import { ID, approvals, decision, mountProject, peopleView, settings, type Answer, type Options } from "./support/people-fixture.js";

// jsdom has no ResizeObserver, which the switch inside a form measures with.
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
const ok = (body: unknown): Answer => ({ status: 200, body });
const inDialog = (name: string) => screen.findByRole("button", { name });
const gone = () => waitFor(() => { expect(screen.queryByRole("dialog")).toBeNull(); });
/** Focus is on the element `find` returns now that the dialog is gone. */
async function focusedOn(find: () => HTMLElement): Promise<void> { await gone();await waitFor(() => { expect(document.activeElement).toBe(find()); }); }
const button = (name: string) => () => screen.getByRole("button", { name });
const sw = () => screen.getByRole("switch", { name: "Let collaborators approve low-risk product decisions" });
const roleChangeOk = (request: ApiRequest): Answer | undefined => request.method === "PUT" ? ok({ member: { developerId: ID.sam, role: "viewer" }, revision: 8 }) : undefined;

it("change role: focus returns to the Change role button on cancel and after saving", async () => {
  const f = mountProject({ write: roleChangeOk });
  fireEvent.click(await screen.findByRole("button", { name: "Change role for Sam Ortiz" }));
  fireEvent.click(await inDialog("Cancel"));
  await focusedOn(button("Change role for Sam Ortiz"));
  fireEvent.click(screen.getByRole("button", { name: "Change role for Sam Ortiz" }));
  fireEvent.change(await screen.findByLabelText("Role", { exact: true }), { target: { value: "viewer" } });
  fireEvent.click(await inDialog("Save role"));
  await focusedOn(button("Change role for Sam Ortiz"));
  f.close();
});

it("add a person: focus returns to the Add a person button on cancel and after adding", async () => {
  const f = mountProject({ write: roleChangeOk });
  fireEvent.click(await screen.findByRole("button", { name: "Add a person" }));
  fireEvent.click(await inDialog("Cancel"));
  await focusedOn(button("Add a person"));
  fireEvent.click(screen.getByRole("button", { name: "Add a person" }));
  const who = await screen.findByLabelText<HTMLSelectElement>("Person", { exact: true });
  await waitFor(() => { expect([...who.options].map(option => option.textContent)).toContain("Ana Silva"); });
  fireEvent.change(who, { target: { value: ID.ana } });
  fireEvent.click(await inDialog("Add to project"));
  await focusedOn(button("Add a person"));
  f.close();
});

it("remove: focus returns to the Remove button on cancel; after the person is removed (their row is gone) it lands on the People heading", async () => {
  const options: Options = { write: request => { if (request.method !== "DELETE") return undefined;options.people = ok(peopleView({ revision: 8, members: peopleView().members.filter(person => person.developerId !== ID.lee) }));return ok({ developerId: ID.lee, removed: true, revision: 8 }); } };
  const f = mountProject(options);
  fireEvent.click(await screen.findByRole("button", { name: "Remove Lee Park from the project" }));
  fireEvent.click(await inDialog("Cancel"));
  await focusedOn(button("Remove Lee Park from the project"));
  fireEvent.click(screen.getByRole("button", { name: "Remove Lee Park from the project" }));
  fireEvent.click(await inDialog("Remove from project"));
  await focusedOn(() => screen.getByRole("heading", { name: "People", level: 2 }));
  expect(screen.queryByRole("button", { name: "Remove Lee Park from the project" })).toBeNull();
  f.close();
});

it("invite: focus returns to the Invite button on cancel and after Done", async () => {
  const f = mountProject({ orgRole: "member", write: request => {
    if (request.path !== "/v1/app/org/invites/reviewed") return undefined;
    const body = request.body as Record<string, unknown>;
    return ok({ receipt: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", requestId: String(body["requestId"]), inviteId: "11111111-1111-4111-8111-111111111111", role: "member", createdAt: "2026-11-11T10:00:00.000Z", expiresAt: "2026-11-18T10:00:00.000Z", project: body["project"] }, email: "sent" });
  } });
  fireEvent.click(await screen.findByRole("button", { name: "Invite into this project" }));
  fireEvent.click(await inDialog("Cancel"));
  await focusedOn(button("Invite into this project"));
  fireEvent.click(screen.getByRole("button", { name: "Invite into this project" }));
  fireEvent.change(await screen.findByLabelText("Colleague's email"), { target: { value: "a@acme.com" } });
  fireEvent.click(await inDialog("Send invite"));
  fireEvent.click(await inDialog("Done"));
  await focusedOn(button("Invite into this project"));
  f.close();
});

it("merge rules: focus returns to the Change merge rules button on cancel and after saving", async () => {
  const f = mountProject({ settings: ok(settings()), write: request => request.path.endsWith("/code-settings") ? ok(settings({ mergeMethod: "merge", revision: 4 })) : undefined });
  fireEvent.click(await screen.findByRole("button", { name: "Change merge rules" }));
  fireEvent.click(await inDialog("Cancel"));
  await focusedOn(button("Change merge rules"));
  fireEvent.click(screen.getByRole("button", { name: "Change merge rules" }));
  fireEvent.change(await screen.findByLabelText("Merge method"), { target: { value: "merge" } });
  fireEvent.click(await inDialog("Save"));
  await focusedOn(button("Change merge rules"));
  f.close();
});

it("collaborator approvals: focus returns to the switch on cancel and after confirming", async () => {
  const f = mountProject({ approvals: ok(approvals()), write: request => request.path.endsWith("/collaborator-approvals") ? ok(approvals({ enabled: false, revision: 3 })) : undefined });
  fireEvent.click(await screen.findByRole("switch", { name: "Let collaborators approve low-risk product decisions" }));
  fireEvent.click(await inDialog("Cancel"));
  await focusedOn(sw);
  fireEvent.click(sw());
  fireEvent.click(await inDialog("Turn off"));
  await focusedOn(sw);
  f.close();
});

it("approve a decision: focus returns to its Approve button on cancel; after approving (the buttons are gone) it lands on the decision's heading", async () => {
  const options: Options = { path: "/app/projects/payments", decisions: ok({ decisions: [decision()] }), write: request => { if (request.method !== "POST") return undefined;options.decisions = ok({ decisions: [decision({ status: "approved", revision: 5, approved: { optionId: "o2", by: { developerId: ID.maya, name: "Maya Chen" }, role: "maintainer", at: "2026-11-11T10:00:00.000Z", class: "product" } })] });return ok({ decision: decision({ status: "approved", revision: 5 }) }); } };
  const f = mountProject(options);
  fireEvent.click(await screen.findByRole("button", { name: "Approve: Request a refund" }));
  fireEvent.click(await inDialog("Cancel"));
  await focusedOn(button("Approve: Request a refund"));
  fireEvent.click(screen.getByRole("button", { name: "Approve: Request a refund" }));
  fireEvent.click(await inDialog("Approve"));
  await focusedOn(() => screen.getByRole("heading", { name: "Which wording should the refund button use?" }));
  expect(screen.queryByRole("button", { name: /^Approve:/u })).toBeNull();
  f.close();
});
