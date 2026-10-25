// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
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
 fireEvent.change(project, { target: { value: "payments" } });fireEvent.click(screen.getByRole("button", { name: "Continue" }));
 expect(await screen.findByRole("textbox", { name: "What should Payments Expert do?" })).toBeTruthy();f.close();
});
it("keeps the old owner when transfer needs administrator approval", async () => {
 const f = renderAgents({ path, reply: async () => ({ status: 202, body: { status: "NEEDS_ADMIN_APPROVAL", spendRequestId: "spr_aaaaaaaaaaaaaaaaaaaa", message: "This would take Arjun over the owner budget cap." } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Change owner" }));fireEvent.change(await screen.findByRole("combobox", { name: "New owner" }), { target: { value: "b".repeat(64) } });fireEvent.click(screen.getByRole("button", { name: "Save owner" }));
 await screen.findByText("This would take Arjun over the owner budget cap.");expect(f.request.mock.calls.find(([request]) => request.method === "PUT")?.[0].body).toMatchObject({ requestId: expect.any(String), owner: { kind: "member", developerId: "b".repeat(64) } });
 expect(f.query.getQueryData<{ agent: { owner: unknown } }>(["agent", AGENT_FIXTURE_ID])?.agent.owner).toEqual(agentProfile().agent.owner);f.close();
});
it("replaces cached profile details when access is lost", async () => {
 const f = renderAgents({ path });await screen.findByRole("heading", { name: "Payments Expert" });f.request.mockResolvedValue({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } });
 await f.query.invalidateQueries({ queryKey: ["agent", AGENT_FIXTURE_ID] });await waitFor(() => expect(screen.getByRole("heading", { name: "Not found" })).toBeTruthy());expect(screen.queryByText("Check refund idempotency.")).toBeNull();f.close();
});
for (const theme of ["light", "dark"] as const) it("has an accessible profile in " + theme, async () => { const f = renderAgents({ path, theme });await screen.findByRole("heading", { name: "Payments Expert" });await expectNoAxeViolations(f.container);f.close(); });
