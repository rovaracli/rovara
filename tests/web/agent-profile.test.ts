// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import { renderAgents } from "./support/agent-render.js";
import { agentProfile, AGENT_FIXTURE_ID } from "./support/agent-fixture.js";
import { expectNoAxeViolations } from "./support/axe.js";
const path = "/app/agents/" + AGENT_FIXTURE_ID;
it("shows the real layered method and an honest unset run limit", async () => {
 const f = renderAgents({ path });await screen.findByRole("heading", { name: "Payments Expert" });
 expect(screen.getByText("Check refund idempotency.")).toBeTruthy();expect(screen.getByText("From Issue triage")).toBeTruthy();
 expect(screen.getAllByText("No limit").length).toBeGreaterThan(0);expect(screen.getByText("Suggested from recent runs")).toBeTruthy();f.close();
});
it("does not offer editing or sharing to a view sharee", async () => {
 const base = agentProfile(), f = renderAgents({ path, profile: agentProfile({ agent: { ...base.agent, access: "view" } }) });await screen.findByRole("heading", { name: "Payments Expert" });
 expect(screen.queryByRole("button", { name: "Share" })).toBeNull();expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();expect(screen.queryByRole("button", { name: "Start session" })).toBeNull();f.close();
});
it("asks which project before opening the actual start form", async () => {
 const f = renderAgents({ path });fireEvent.click(await screen.findByRole("button", { name: "Start session" }));
 const project = await screen.findByRole("combobox", { name: "Project" });expect(project.querySelectorAll("option").length).toBe(3);expect(screen.queryByRole("textbox", { name: /What should/ })).toBeNull();
 fireEvent.change(project, { target: { value: "payments" } });await waitFor(() => expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(false));fireEvent.click(screen.getByRole("button", { name: "Continue" }));
 expect(await screen.findByRole("textbox", { name: "What should Payments Expert do?" })).toBeTruthy();f.close();
});
it("keeps the old owner when transfer needs administrator approval", async () => {
 const f = renderAgents({ path, reply: async () => ({ status: 202, body: { status: "NEEDS_ADMIN_APPROVAL", spendRequestId: "spr_aaaaaaaaaaaaaaaaaaaa", message: "This would take Arjun over the owner budget cap." } }) });
 await screen.findByRole("heading", { name: "Payments Expert" });fireEvent.click(screen.getByText("Sharing and versions"));fireEvent.click(await screen.findByRole("button", { name: "Change owner" }));fireEvent.change(await screen.findByRole("combobox", { name: "New owner" }), { target: { value: "b".repeat(64) } });fireEvent.click(screen.getByRole("button", { name: "Save owner" }));
 await screen.findByText("This would take Arjun over the owner budget cap.");expect(f.request.mock.calls.find(([request]) => request.method === "PUT")?.[0].body).toMatchObject({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, owner: { kind: "member", developerId: "b".repeat(64) } });
 expect(f.query.getQueryData<{ agent: { owner: unknown } }>(["agent", AGENT_FIXTURE_ID])?.agent.owner).toEqual(agentProfile().agent.owner);f.close();
});
it("replaces cached profile details when access is lost", async () => {
 const f = renderAgents({ path });await screen.findByRole("heading", { name: "Payments Expert" });f.request.mockResolvedValue({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } });
 await f.query.invalidateQueries({ queryKey: ["agent", AGENT_FIXTURE_ID] });await waitFor(() => expect(screen.getByRole("heading", { name: "Not found" })).toBeTruthy());expect(screen.queryByText("Check refund idempotency.")).toBeNull();f.close();
});
for (const theme of ["light", "dark"] as const) it("has an accessible profile in " + theme, async () => { const f = renderAgents({ path, theme });await screen.findByRole("heading", { name: "Payments Expert" });await expectNoAxeViolations(f.container);f.close(); });

it("offers no draft editor or sharing on a built-in", async () => {
 const base = agentProfile(), f = renderAgents({ path: "/app/agents/ticket-triage", profile: agentProfile({ agent: { ...base.agent, agentId: "ticket-triage", builtin: true, owner: undefined, access: "manage", pinnedVersion: 1, latestVersion: 2 } }) });
 await screen.findByRole("heading", { name: "Payments Expert" });expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();expect(screen.queryByRole("button", { name: "Share" })).toBeNull();expect(screen.getByRole("button", { name: "Adopt v2" })).toBeTruthy();f.close();
});
it("keeps built-in adoption pending until a real read has the new pin", async () => {
 const base = agentProfile(), builtin = agentProfile({ agent: { ...base.agent, agentId: "ticket-triage", builtin: true, owner: undefined, access: "manage", pinnedVersion: 1, latestVersion: 2 } }), f = renderAgents({ path: "/app/agents/ticket-triage", profile: builtin, reply: async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", changes: ["This version can write to GitHub."], confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Adopt v2" }));await screen.findByText("Waiting for you to confirm in your browser");expect(screen.getByText("This version can write to GitHub.")).toBeTruthy();
 const updated = agentProfile({ ...builtin, agent: { ...builtin.agent, pinnedVersion: 2 } });await act(() => f.query.setQueryData(["agent", "ticket-triage"], updated));expect(screen.queryByText("Done")).toBeNull();expect(screen.getByText("Waiting for you to confirm in your browser")).toBeTruthy();
 f.setProfile(updated);await f.query.invalidateQueries({ queryKey: ["agent", "ticket-triage"], exact: true });await waitFor(() => expect(screen.queryByText("Waiting for you to confirm in your browser")).toBeNull());f.close();
});
it("uses the owning manage-only sharing rule for editors", async () => {
 const base = agentProfile(), f = renderAgents({ path, profile: agentProfile({ agent: { ...base.agent, access: "edit" } }) });await screen.findByRole("heading", { name: "Payments Expert" });expect(screen.getByRole("link", { name: "Edit" })).toBeTruthy();expect(screen.queryByRole("button", { name: "Share" })).toBeNull();f.close();
});
it("preserves existing shares when adding a teammate and sends only input fields", async () => {
 const f = renderAgents({ path, shares: [{ principal: { kind: "project", project: "payments" }, level: "use", grantedBy: "a".repeat(64), grantedAt: "2026-10-23T12:00:00.000Z" }], reply: async () => ({ status: 200, body: { shares: [] } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Share" }));await screen.findByRole("button", { name: "Remove" });fireEvent.change(await screen.findByRole("combobox", { name: "Person" }), { target: { value: "b".repeat(64) } });fireEvent.change(screen.getByRole("combobox", { name: "Access level" }), { target: { value: "edit" } });fireEvent.click(screen.getByRole("button", { name: "Add share" }));await screen.findByText("Sharing updated");
 expect(f.request.mock.calls.find(([request]) => request.method === "PUT")?.[0].body).toMatchObject({ requestId: expect.stringMatching(/^[0-9a-f-]{36}$/) as unknown, shares: [{ principal: { kind: "project", project: "payments" }, level: "use" }, { principal: { kind: "member", developerId: "b".repeat(64) }, level: "edit" }] });f.close();
});
it("refuses to erase a newer share type it does not understand", async () => {
 const f = renderAgents({ path, shares: [{ principal: { kind: "future_team", id: "private-group" }, level: "use", grantedBy: "a".repeat(64), grantedAt: "2026-10-23T12:00:00.000Z" }] });fireEvent.click(await screen.findByRole("button", { name: "Share" }));await screen.findByText("This sharing includes a newer access type. Refresh before changing it.");expect(screen.getByRole<HTMLButtonElement>("button", { name: "Add share" }).disabled).toBe(true);expect(f.request.mock.calls.some(([request]) => request.method === "PUT")).toBe(false);f.close();
});

it("checks that the selected project really offers this workflow before asking for a task", async () => {
 const f = renderAgents({ path, agentOnProject: false });fireEvent.click(await screen.findByRole("button", { name: "Start session" }));fireEvent.change(await screen.findByRole("combobox", { name: "Project" }), { target: { value: "checkout" } });
 await screen.findByText("This workflow isn't available on that project. Choose another project.");expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(true);expect(screen.queryByRole("textbox", { name: /What should/ })).toBeNull();f.close();
});

it("keeps a pending update with its workflow when another cached profile opens", async () => {
 const base = agentProfile(), f = renderAgents({ path: "/app/agents/ticket-triage", profile: agentProfile({ agent: { ...base.agent, agentId: "ticket-triage", builtin: true, pinnedVersion: 1, latestVersion: 2 } }), reply: async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: ["Changes the built-in workflow."] } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Adopt v2" }));await screen.findByText("Waiting for you to confirm in your browser");
 const next = agentProfile({ agent: { ...base.agent, agentId: "agt_bbbbbbbbbbbbbbbbbbbb", name: "Cached workflow" } });f.query.setQueryData(["agent", next.agent.agentId], next);f.setProfile(next);await act(() => f.router.navigate("/app/agents/" + next.agent.agentId));await screen.findByRole("heading", { name: "Cached workflow" });expect(screen.queryByText("Waiting for you to confirm in your browser")).toBeNull();f.close();
});
