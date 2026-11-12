// @vitest-environment jsdom
// The controller's review of the People lane: a collaborator's own role is always an option in Change role (even where the server's assignableRoles omits it); the viewer's exact role is preferred when the server sends it;
// a maintainer is never shown a link to copy; the last grant-maintainer's Change role and Remove are off up front with the reason; a stale answer shows the server's own words; a row that is not a grant says who sets it.
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, within } from "@testing-library/react";
import { fixedRowWords, emailOutcomeWords, LAST_MAINTAINER_HINT } from "../../packages/ui/src/screens/project/people/people-text.js";
import { ID, approvals, member, mountProject, peopleView, type Answer } from "./support/people-fixture.js";

// jsdom has no ResizeObserver, which the switch inside a form measures with.
globalThis.ResizeObserver ??= class { observe(): void { /* none */ } unobserve(): void { /* none */ } disconnect(): void { /* none */ } };
const ok = (body: unknown): Answer => ({ status: 200, body });
const row = async (name: string) => (await screen.findByText(name)).closest("tr")!;

it("a collaborator's own Change role opens on Collaborator, which is an option though assignableRoles omits it, and Save works once another role is chosen", async () => {
  let body: Record<string, unknown> | undefined;
  const f = mountProject({ people: ok(peopleView({}, { assignableRoles: ["maintainer", "contributor", "viewer"] })), write: request => { if (request.method === "PUT") { body = request.body as Record<string, unknown>;return ok({ member: { developerId: ID.priya, role: "viewer" }, revision: 8 }); } return undefined; } });
  fireEvent.click(await screen.findByRole("button", { name: "Change role for Priya Rao" }));
  const select = await screen.findByLabelText<HTMLSelectElement>("Role", { exact: true });
  expect(select.value).toBe("collaborator");
  expect([...select.options].filter(option => option.value !== "").map(option => option.textContent)).toEqual(["Collaborator", "Maintainer", "Contributor", "Viewer"]);
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save role" }).disabled).toBe(true);
  fireEvent.change(select, { target: { value: "viewer" } });
  expect(screen.getByRole<HTMLButtonElement>("button", { name: "Save role" }).disabled).toBe(false);
  fireEvent.click(screen.getByRole("button", { name: "Save role" }));
  await screen.findByText("Priya Rao is now viewer.");
  expect(body).toMatchObject({ role: "viewer", expectedRevision: 7 });
  f.close();
});

it("the viewer's exact role comes from viewer.projectRole when the server sends it, ahead of the roster row", async () => {
  const f = mountProject({ people: ok(peopleView({ members: [member(ID.maya, "Maya Chen", "viewer")] }, { role: "viewer", projectRole: "collaborator", canManageMembers: false, assignableRoles: [], canInvite: false, invitableRoles: [], canEditCodeSettings: false })) });
  await row("Maya Chen");
  expect(screen.getByText(/Your role here:/u).textContent).toBe("Everyone on this project and their role. Your role here: Collaborator.");
  f.close();
});

it("a maintainer is never shown a link to copy, even if the server returns inviteUrl; an owner or admin is", async () => {
  const answer = (email: string) => (request: { path: string; body?: unknown }): Answer | undefined => {
    if (request.path !== "/v1/app/org/invites/reviewed") return undefined;
    const body = request.body as Record<string, unknown>;
    return ok({ receipt: { orgId: "org_aaaaaaaaaaaaaaaaaaaa", requestId: String(body["requestId"]), inviteId: "11111111-1111-4111-8111-111111111111", role: "member", createdAt: "2026-11-11T10:00:00.000Z", expiresAt: "2026-11-18T10:00:00.000Z", project: body["project"] }, inviteUrl: "https://cell.example/join#invite=" + "A".repeat(43), email });
  };
  for (const orgRole of ["member", "admin"] as const) {
    const f = mountProject({ orgRole, write: answer("failed") });
    f.host.copyText = async () => undefined;
    fireEvent.click(await screen.findByRole("button", { name: "Invite into this project" }));
    fireEvent.change(await screen.findByLabelText("Colleague's email"), { target: { value: "a@acme.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Send invite" }));
    await screen.findByRole("button", { name: "Done" });
    expect(screen.queryByRole("button", { name: "Copy invite link" }) !== null).toBe(orgRole === "admin");
    expect(screen.getByRole("status").textContent).toBe(emailOutcomeWords("failed", orgRole === "admin"));
    if (orgRole === "member") expect(screen.getByRole("status").textContent).toMatch(/ask a company owner or admin/u);
    f.close();
  }
});

it("the last grant-maintainer's Change role and Remove are off up front, with the reason beside them; with a second maintainer they are on", async () => {
  const only = mountProject({ people: ok(peopleView({ members: [member(ID.maya, "Maya Chen", "maintainer"), member(ID.sam, "Sam Ortiz", "contributor"), member(ID.admin, "Dana Admin", "maintainer", { source: "org_role" })] })) });
  const maya = await row("Maya Chen");
  expect(within(maya).getByRole<HTMLButtonElement>("button", { name: "Change role for Maya Chen" }).disabled).toBe(true);
  expect(within(maya).getByRole<HTMLButtonElement>("button", { name: "Remove Maya Chen from the project" }).disabled).toBe(true);
  expect(within(maya).getByText(LAST_MAINTAINER_HINT)).toBeTruthy();
  expect(within(maya).getByRole("button", { name: "Change role for Maya Chen" }).getAttribute("aria-describedby")).toBe(within(maya).getByText(LAST_MAINTAINER_HINT).id);
  expect(within(await row("Sam Ortiz")).getByRole<HTMLButtonElement>("button", { name: "Change role for Sam Ortiz" }).disabled).toBe(false);
  only.close();
  const two = mountProject();
  const first = await row("Maya Chen");
  expect(within(first).getByRole<HTMLButtonElement>("button", { name: "Change role for Maya Chen" }).disabled).toBe(false);
  expect(screen.queryByText(LAST_MAINTAINER_HINT)).toBeNull();
  two.close();
});

it("a stale approvals answer shows the server's own words, not a fixed sentence", async () => {
  const words = "this setting was changed by someone else since you loaded it; reload and try again";
  const f = mountProject({ approvals: ok(approvals()), write: request => request.path.endsWith("/collaborator-approvals") ? { status: 409, body: { error: { code: "CHANGE_STALE", message: words } } } : undefined });
  fireEvent.click(await screen.findByRole("switch", { name: "Let collaborators approve low-risk product decisions" }));
  fireEvent.click(await screen.findByRole("button", { name: "Turn off" }));
  expect((await screen.findByRole("alert")).textContent).toBe(words);
  await waitFor(() => { expect(screen.getByRole("button", { name: "Discard my changes and reload" })).toBeTruthy(); });
  f.close();
});

it("a row the page cannot change says who sets it", () => {
  expect(fixedRowWords("org_role")).toBe("Set by their company role");
  expect(fixedRowWords("channel")).toBe("Set by the project's Slack channel");
});
