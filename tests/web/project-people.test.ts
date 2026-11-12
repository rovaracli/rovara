// @vitest-environment jsdom
// The project People tab (switch `rovara.people` = "v2"): the roster with Cloud's four roles, controls that follow the server's powers, change and remove under the revision read, a stale answer reloading the roster,
// the last-maintainer sentence shown as the server said it, adding a company member, inviting into the project (a maintainer must name an email; only an owner or admin may make a link), the merge rules (code settings)
// with the 202 "Waiting for an admin", and the collaborator approvals switch. Off, there is no tab and no request.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { PROJECT_LAST_MAINTAINER_MESSAGE, PROJECT_PEOPLE_STALE_MESSAGE } from "@agentx/cloud-contracts/web";
import { expectNoAxeViolations } from "./support/axe.js";
import { ID, approvals, member, mountProject, peopleView, settings, type Answer } from "./support/people-fixture.js";

// jsdom has no ResizeObserver, which the switch inside a form measures with.
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
/** Any v4 request id (the server needs one per write). */
const anyId = (): unknown => expect.stringMatching(UUID);
const row = async (name: string) => (await screen.findByText(name)).closest("tr")!;
const ok = (body: unknown): Answer => ({ status: 200, body });
const refusal = (status: number, code: string, message: string): Answer => ({ status, body: { error: { code, message } } });
const peopleReads = (f: ReturnType<typeof mountProject>) => f.calls(request => request.method === "GET" && request.path === "/v1/app/projects/payments/people").length;

it("switch off: no People tab, none of its requests, and ?tab=people is the overview as before (the same page with the switch on does show them, so the check can fail)", async () => {
  const control = mountProject();
  await screen.findByRole("tab", { name: "People", selected: true });
  control.close();
  const f = mountProject({ on: false });
  await screen.findByRole("heading", { name: "payments" });
  await new Promise(resolve => setTimeout(resolve, 80));
  expect(screen.queryByRole("tab", { name: "People" })).toBeNull();
  expect(screen.getByRole("tab", { name: "Overview", selected: true })).toBeTruthy();
  expect(f.calls(request => /people|code-settings|collaborator-approvals|product-decisions/u.test(request.path))).toEqual([]);
  expect(screen.queryByRole("heading", { name: "Product decisions" })).toBeNull();
  f.close();
});

it("switch on: the People tab shows each person's exact role, a collaborator as Collaborator", async () => {
  const f = mountProject();
  expect(await screen.findByRole("tab", { name: "People", selected: true })).toBeTruthy();
  expect(within(await row("Priya Rao")).getByText("Collaborator")).toBeTruthy();
  expect(within(await row("Maya Chen")).getByText("Maintainer")).toBeTruthy();
  expect(within(await row("Lee Park")).getByText("Viewer")).toBeTruthy();
  expect(within(await row("Dana Admin")).getByText("Company owner or admin")).toBeTruthy();
  f.close();
});

it("the viewer's own role is the exact one from the roster, so a collaborator is told Collaborator (the powers carry the viewer floor)", async () => {
  const f = mountProject({ people: ok(peopleView({ members: [member(ID.maya, "Maya Chen", "collaborator")] }, { role: "viewer", canManageMembers: false, assignableRoles: [], canInvite: false, invitableRoles: [], canEditCodeSettings: false })) });
  await row("Maya Chen");
  expect(screen.getByText(/Your role here:/u).textContent).toBe("Everyone on this project and their role. Your role here: Collaborator.");
  f.close();
});

it("a roster row from an older server (no projectRole) falls back to the three-role floor", async () => {
  const f = mountProject({ people: ok(peopleView({ members: [{ developerId: ID.lee, name: "Lee Park", role: "viewer", source: "grant" }] })) });
  expect(within(await row("Lee Park")).getByText("Viewer")).toBeTruthy();
  f.close();
});

it("powers drive the controls: without canManageMembers and canInvite there is no Add, Invite, Change or Remove", async () => {
  const f = mountProject({ people: ok(peopleView({}, { role: "contributor", canManageMembers: false, assignableRoles: [], canInvite: false, invitableRoles: [], canEditCodeSettings: false })), settings: ok(settings()) });
  await row("Priya Rao");
  expect(screen.queryByRole("button", { name: "Add a person" })).toBeNull();
  expect(screen.queryByRole("button", { name: "Invite into this project" })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Change role for/u })).toBeNull();
  expect(screen.queryByRole("button", { name: /^Remove /u })).toBeNull();
  expect(screen.queryByRole("columnheader", { name: "Actions" })).toBeNull();
  expect(screen.getByText(/Only a project maintainer, or a company owner or admin, can change who is on this project/u)).toBeTruthy();
  await screen.findByText("Only a project maintainer can change these.");
  expect(screen.queryByRole("button", { name: "Change merge rules" })).toBeNull();
  f.close();
});

it("powers drive the controls: a maintainer gets them, but a company owner's or admin's row has none", async () => {
  const f = mountProject();
  await row("Priya Rao");
  expect(screen.getByRole("button", { name: "Add a person" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Invite into this project" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Change role for Priya Rao" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Remove Priya Rao from the project" })).toBeTruthy();
  expect(within(await row("Dana Admin")).queryByRole("button")).toBeNull();
  f.close();
});

it("the role choices are exactly the server's assignableRoles: collaborator is offered when the server lists it, and only then", async () => {
  for (const [assignable, expected] of [[["maintainer", "contributor", "collaborator", "viewer"], ["Maintainer", "Contributor", "Collaborator", "Viewer"]], [["contributor", "viewer"], ["Contributor", "Viewer"]]] as const) {
    const f = mountProject({ people: ok(peopleView({}, { assignableRoles: assignable })) });
    fireEvent.click(await screen.findByRole("button", { name: "Change role for Sam Ortiz" }));
    const select = await screen.findByLabelText<HTMLSelectElement>("Role");
    expect([...select.options].filter(option => option.value !== "").map(option => option.textContent)).toEqual(expected);
    f.close();
  }
});

it("changing a role sends the role under the revision read, with a request id, then reloads the roster", async () => {
  let body: Record<string, unknown> | undefined, path = "";
  const f = mountProject({ write: request => { if (request.method === "PUT") { body = request.body as Record<string, unknown>;path = request.path;return ok({ member: { developerId: ID.sam, role: "viewer" }, revision: 8 }); } return undefined; } });
  fireEvent.click(await screen.findByRole("button", { name: "Change role for Sam Ortiz" }));
  fireEvent.change(await screen.findByLabelText("Role"), { target: { value: "collaborator" } });
  const before = peopleReads(f);
  fireEvent.click(screen.getByRole("button", { name: "Save role" }));
  await screen.findByText("Sam Ortiz is now collaborator.");
  expect(path).toBe("/v1/app/projects/payments/people/" + ID.sam);
  expect(body).toMatchObject({ role: "collaborator", expectedRevision: 7 });
  expect(String(body!["requestId"])).toMatch(UUID);
  await waitFor(() => { expect(peopleReads(f)).toBeGreaterThan(before); });
  f.close();
});

it("a stale answer (409 CHANGE_STALE) says so and reloads the roster", async () => {
  const f = mountProject({ write: request => request.method === "PUT" ? refusal(409, "CHANGE_STALE", PROJECT_PEOPLE_STALE_MESSAGE) : undefined });
  fireEvent.click(await screen.findByRole("button", { name: "Change role for Sam Ortiz" }));
  fireEvent.change(await screen.findByLabelText("Role"), { target: { value: "viewer" } });
  const before = peopleReads(f);
  fireEvent.click(screen.getByRole("button", { name: "Save role" }));
  expect((await screen.findByRole("alert")).textContent).toBe(PROJECT_PEOPLE_STALE_MESSAGE);
  await waitFor(() => { expect(peopleReads(f)).toBeGreaterThan(before); });
  f.close();
});

it("the last-maintainer refusal is shown as the server said it, on a role change and on a removal", async () => {
  const f = mountProject({ write: () => refusal(400, "CONFIG_INVALID", PROJECT_LAST_MAINTAINER_MESSAGE) });
  fireEvent.click(await screen.findByRole("button", { name: "Change role for Maya Chen" }));
  fireEvent.change(await screen.findByLabelText("Role"), { target: { value: "viewer" } });
  fireEvent.click(screen.getByRole("button", { name: "Save role" }));
  expect((await screen.findByRole("alert")).textContent).toBe(PROJECT_LAST_MAINTAINER_MESSAGE);
  fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove Maya Chen from the project" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove from project" }));
  expect((await screen.findByRole("alert")).textContent).toBe(PROJECT_LAST_MAINTAINER_MESSAGE);
  f.close();
});

it("removing a person sends DELETE with the request id and the revision read", async () => {
  let sent: { path: string; body: Record<string, unknown> } | undefined;
  const f = mountProject({ write: request => { if (request.method === "DELETE") { sent = { path: request.path, body: request.body as Record<string, unknown> };return ok({ developerId: ID.lee, removed: true, revision: 8 }); } return undefined; } });
  fireEvent.click(await screen.findByRole("button", { name: "Remove Lee Park from the project" }));
  fireEvent.click(await screen.findByRole("button", { name: "Remove from project" }));
  await screen.findByText("Lee Park was removed from the project.");
  expect(sent!.path).toBe("/v1/app/projects/payments/people/" + ID.lee);
  expect(sent!.body).toMatchObject({ expectedRevision: 7 });
  expect(String(sent!.body["requestId"])).toMatch(UUID);
  f.close();
});

it("adding a person offers only company members who are not on the project yet, and adds with the chosen role", async () => {
  let body: Record<string, unknown> | undefined, path = "";
  const f = mountProject({ write: request => { if (request.method === "PUT") { body = request.body as Record<string, unknown>;path = request.path;return ok({ member: { developerId: ID.ana, role: "viewer" }, revision: 8 }); } return undefined; } });
  fireEvent.click(await screen.findByRole("button", { name: "Add a person" }));
  const who = await screen.findByLabelText<HTMLSelectElement>("Person");
  await waitFor(() => { expect([...who.options].map(option => option.textContent)).toContain("Ana Silva"); });
  expect([...who.options].map(option => option.textContent)).not.toContain("Sam Ortiz");
  expect([...who.options].map(option => option.textContent)).not.toContain("Dana Admin");
  fireEvent.change(who, { target: { value: ID.ana } });
  fireEvent.change(screen.getByLabelText("Role"), { target: { value: "collaborator" } });
  fireEvent.click(screen.getByRole("button", { name: "Add to project" }));
  await screen.findByText("Ana Silva was added as collaborator.");
  expect(path).toBe("/v1/app/projects/payments/people/" + ID.ana);
  expect(body).toMatchObject({ role: "collaborator", expectedRevision: 7 });
  f.close();
});

it("a maintainer's invite must name an email and has no link option; it carries the project and role the server offers", async () => {
  let body: Record<string, unknown> | undefined;
  const f = mountProject({ orgRole: "member", people: ok(peopleView({}, { invitableRoles: ["contributor", "viewer"] })), write: request => {
    if (request.path !== "/v1/app/org/invites/reviewed") return undefined;
    body = request.body as Record<string, unknown>;
    const requestId = String(body["requestId"]);
    return ok({ receipt: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", requestId, inviteId: "11111111-1111-4111-8111-111111111111", role: "member", createdAt: "2026-11-11T10:00:00.000Z", expiresAt: "2026-11-18T10:00:00.000Z", project: body["project"] }, email: "sent" });
  } });
  fireEvent.click(await screen.findByRole("button", { name: "Invite into this project" }));
  expect(screen.queryByLabelText("Send it")).toBeNull();
  const role = await screen.findByLabelText<HTMLSelectElement>("Project role");
  expect([...role.options].filter(option => option.value !== "").map(option => option.textContent)).toEqual(["Contributor", "Viewer"]);
  fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
  expect((await screen.findByRole("alert")).textContent).toBe("Enter a valid colleague email.");
  expect(body).toBeUndefined();
  fireEvent.change(screen.getByLabelText("Colleague's email"), { target: { value: "New.Person@Acme.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
  await screen.findByText("Invite created and emailed.");
  expect(body).toMatchObject({ role: "member", email: "new.person@acme.com", sendEmail: true, project: { name: "payments", role: "contributor" } });
  f.close();
});

it("an owner or admin may make a shareable link instead: no email is sent, and the link can be copied", async () => {
  let body: Record<string, unknown> | undefined;
  const f = mountProject({ orgRole: "admin", write: request => {
    if (request.path !== "/v1/app/org/invites/reviewed") return undefined;
    body = request.body as Record<string, unknown>;
    return ok({ receipt: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", requestId: String(body["requestId"]), inviteId: "11111111-1111-4111-8111-111111111111", role: "member", createdAt: "2026-11-11T10:00:00.000Z", expiresAt: "2026-11-18T10:00:00.000Z", project: body["project"] }, inviteUrl: "https://cell.example/join#invite=" + "A".repeat(43) });
  } });
  const copied: string[] = [];
  f.host.copyText = async text => { copied.push(text); };
  fireEvent.click(await screen.findByRole("button", { name: "Invite into this project" }));
  fireEvent.change(await screen.findByLabelText("Send it"), { target: { value: "link" } });
  expect(screen.queryByLabelText("Colleague's email")).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
  fireEvent.click(await screen.findByRole("button", { name: "Copy invite link" }));
  await screen.findByRole("button", { name: "Link copied" });
  expect(body).not.toHaveProperty("email");
  expect(body).toMatchObject({ project: { name: "payments", role: "contributor" } });
  expect(copied).toEqual(["https://cell.example/join#invite=" + "A".repeat(43)]);
  f.close();
});

it("an invite the server refuses shows its words as they came", async () => {
  const words = "A maintainer's invite goes to one colleague's email address. Add their email; only an owner or admin can make a shareable link.";
  const f = mountProject({ orgRole: "member", write: () => refusal(400, "CONFIG_INVALID", words) });
  fireEvent.click(await screen.findByRole("button", { name: "Invite into this project" }));
  fireEvent.change(await screen.findByLabelText("Colleague's email"), { target: { value: "a@acme.com" } });
  fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
  expect((await screen.findByRole("alert")).textContent).toBe(words);
  f.close();
});

it("merge rules: read by anyone; a maintainer changes only what differs, under the revision read", async () => {
  let body: Record<string, unknown> | undefined;
  const f = mountProject({ write: request => { if (request.path.endsWith("/code-settings")) { body = request.body as Record<string, unknown>;return ok(settings({ mergeMethod: "merge", revision: 4 })); } return undefined; } });
  await screen.findByText("acme/payments-team");
  expect(screen.getByText("Squash and merge")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Change merge rules" }));
  fireEvent.change(await screen.findByLabelText("Merge method"), { target: { value: "merge" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => { expect(body).toBeDefined(); });
  expect(body).toEqual({ requestId: anyId(), expectedRevision: 3, mergeMethod: "merge" });
  f.close();
});

it("merge rules: a reviewer name that isn't one is refused before any request", async () => {
  let sent = false;
  const f = mountProject({ write: () => { sent = true;return undefined; } });
  fireEvent.click(await screen.findByRole("button", { name: "Change merge rules" }));
  fireEvent.change(await screen.findByLabelText(/Reviewers Rovara asks/u), { target: { value: "ok-person\nnot a/valid/name!" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toMatch(/isn't a reviewer name/u);
  expect(sent).toBe(false);
  f.close();
});

it("turning self-approval on answers 202: it says 'Waiting for an admin', changes nothing, and only an owner or admin is offered the confirmation", async () => {
  for (const canConfirm of [false, true]) {
    const f = mountProject({ people: ok(peopleView({}, { canConfirmSelfApproval: canConfirm })), write: request => request.path.endsWith("/code-settings") ? { status: 202, body: { status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED", changes: ["Turn on self-approval"], confirmUrl: "https://cell.example/v1/app/approve/abc123" } } : undefined });
    fireEvent.click(await screen.findByRole("button", { name: "Change merge rules" }));
    fireEvent.click(await screen.findByRole("switch", { name: /Let a person approve a pull request/u }));
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    expect((await screen.findAllByText("Waiting for an admin")).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/Nothing changes until one does/u).length).toBeGreaterThan(0);
    expect(screen.queryAllByRole("button", { name: "Open the confirmation" }).length > 0).toBe(canConfirm);
    f.close();
  }
});

it("a stale merge-rules save says so as the server did, and reloads", async () => {
  const words = "Someone changed these settings. Reload and try again.";
  const f = mountProject({ write: request => request.path.endsWith("/code-settings") ? refusal(400, "CONFIG_INVALID", words) : undefined });
  fireEvent.click(await screen.findByRole("button", { name: "Change merge rules" }));
  fireEvent.change(await screen.findByLabelText("Merge method"), { target: { value: "merge" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect((await screen.findByRole("alert")).textContent).toBe(words);
  f.close();
});

it("collaborator approvals: the maintainer's switch sends the new state under the revision read; a stale answer reloads", async () => {
  let body: Record<string, unknown> | undefined, reads = 0;
  const f = mountProject({ seen: request => { if (request.method === "GET" && request.path.endsWith("/collaborator-approvals")) reads += 1; }, write: request => { if (request.path.endsWith("/collaborator-approvals")) { body = request.body as Record<string, unknown>;return refusal(409, "CHANGE_STALE", PROJECT_PEOPLE_STALE_MESSAGE); } return undefined; } });
  const toggle = await screen.findByRole("switch", { name: "Let collaborators approve low-risk product decisions" });
  expect(toggle.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(toggle);
  expect(await screen.findByText(PROJECT_PEOPLE_STALE_MESSAGE)).toBeTruthy();
  expect(body).toEqual({ requestId: anyId(), enabled: false, expectedRevision: 2 });
  await waitFor(() => { expect(reads).toBeGreaterThan(1); });
  f.close();
});

it("collaborator approvals: without canChange there is no switch, only the state", async () => {
  const f = mountProject({ approvals: ok(approvals({ canChange: false, enabled: false })) });
  await screen.findByText(/Off\. Only a project maintainer can change this\./u);
  expect(screen.queryByRole("switch", { name: "Let collaborators approve low-risk product decisions" })).toBeNull();
  f.close();
});

it("the People tab has no axe violations, light and dark", async () => {
  for (const theme of ["light", "dark"] as const) {
    document.documentElement.setAttribute("data-theme", theme);
    const f = mountProject();
    await row("Priya Rao");
    await screen.findByRole("switch", { name: "Let collaborators approve low-risk product decisions" });
    await expectNoAxeViolations(f.container);
    f.close();
  }
});
