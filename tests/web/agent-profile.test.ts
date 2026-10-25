// @vitest-environment jsdom
import { expect, it, vi } from "vitest";
import { screen, fireEvent, waitFor, act } from "@testing-library/react";
import type { ApiResponse } from "../../packages/ui/src/host.js";
import { liveFixture } from "./support/live-fixture.js";
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
 await act(() => f.query.invalidateQueries({ queryKey: ["agent", AGENT_FIXTURE_ID], exact: true }));expect(screen.getByText("This would take Arjun over the owner budget cap.")).toBeTruthy();
 expect(f.query.getQueryData<{ agent: { owner: unknown } }>(["agent", AGENT_FIXTURE_ID])?.agent.owner).toEqual(agentProfile().agent.owner);f.close();
});
it("replaces cached profile details when access is lost", async () => {
 const f = renderAgents({ path });await screen.findByRole("heading", { name: "Payments Expert" });f.request.mockResolvedValue({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } });
 await act(() => f.query.invalidateQueries({ queryKey: ["agent", AGENT_FIXTURE_ID] }));await waitFor(() => expect(screen.getByRole("heading", { name: "Not found" })).toBeTruthy());expect(screen.queryByText("Check refund idempotency.")).toBeNull();f.close();
});
for (const theme of ["light", "dark"] as const) it("has an accessible profile in " + theme, async () => { const f = renderAgents({ path, theme });await screen.findByRole("heading", { name: "Payments Expert" });await expectNoAxeViolations(f.container);f.close(); });

it("offers no draft editor or sharing on a built-in", async () => {
 const base = agentProfile(), f = renderAgents({ path: "/app/agents/ticket-triage", profile: agentProfile({ agent: { ...base.agent, agentId: "ticket-triage", builtin: true, owner: undefined, access: "manage", pinnedVersion: 1, latestVersion: 2 } }) });
 await screen.findByRole("heading", { name: "Payments Expert" });expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();expect(screen.queryByRole("button", { name: "Share" })).toBeNull();expect(screen.getByRole("button", { name: "Adopt v2" })).toBeTruthy();f.close();
});
it("keeps built-in adoption pending until a real read has the new pin", async () => {
 const base = agentProfile(), builtin = agentProfile({ agent: { ...base.agent, agentId: "ticket-triage", builtin: true, owner: undefined, access: "manage", pinnedVersion: 1, latestVersion: 2 } }), f = renderAgents({ path: "/app/agents/ticket-triage", profile: builtin, reply: async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", changes: ["This version can write to GitHub."], confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Adopt v2" }));await screen.findByText("Waiting for you to confirm in your browser");expect(screen.getByText("This version can write to GitHub.")).toBeTruthy();expect(f.request.mock.calls.find(([request]) => request.path.endsWith("/adopt"))?.[0].body).toMatchObject({ version: 2 });await act(() => f.query.invalidateQueries({ queryKey: ["agent", "ticket-triage"], exact: true }));expect(screen.getByText("Waiting for you to confirm in your browser")).toBeTruthy();
 const updated = agentProfile({ ...builtin, agent: { ...builtin.agent, pinnedVersion: 2 } });await act(() => f.query.setQueryData(["agent", "ticket-triage"], updated));expect(screen.queryByText("Done")).toBeNull();expect(screen.getByText("Waiting for you to confirm in your browser")).toBeTruthy();
 f.setProfile(updated);await act(() => f.query.invalidateQueries({ queryKey: ["agent", "ticket-triage"], exact: true }));await waitFor(() => expect(screen.queryByText("Waiting for you to confirm in your browser")).toBeNull());f.close();
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
it("uses the canonical directory summary for a profile's available base update", async () => { const f = renderAgents({ path });expect(await screen.findByRole("button", { name: "Review update" })).toBeTruthy();f.close(); });
it("keeps company sharing pending until a real read has the requested level", async () => {
 const shares: unknown[] = [], f = renderAgents({ path, shares, reply: async () => ({ status: 202, body: { status: "NEEDS_CONFIRMATION", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa", changes: ["Everyone in your company can use this workflow."] } }) });
 fireEvent.click(await screen.findByRole("button", { name: "Share" }));fireEvent.change(await screen.findByRole("combobox", { name: "Share with" }), { target: { value: "org" } });fireEvent.change(screen.getByRole("combobox", { name: "Access level" }), { target: { value: "use" } });const add = screen.getByRole<HTMLButtonElement>("button", { name: "Add share" });await waitFor(() => expect(add.disabled).toBe(false));fireEvent.click(add);
 await screen.findByText("Waiting for you to confirm in your browser");expect(screen.getByText("Everyone in your company can use this workflow.")).toBeTruthy();
 const applied = { principal: { kind: "org" }, level: "use", grantedBy: "a".repeat(64), grantedAt: "2026-10-23T12:00:00.000Z" };
 await act(() => f.query.setQueryData(["agent", AGENT_FIXTURE_ID, "shares"], { shares: [applied] }));expect(screen.queryByText("Sharing updated")).toBeNull();expect(screen.getByText("Waiting for you to confirm in your browser")).toBeTruthy();
 for (const wrong of [undefined, { ...applied, level: "view" }, { ...applied, principal: { kind: "member", developerId: "a".repeat(64) } }]) { shares.splice(0, shares.length, ...(wrong === undefined ? [] : [wrong]));await act(() => f.query.invalidateQueries({ queryKey: ["agent", AGENT_FIXTURE_ID, "shares"], exact: true }));expect(screen.queryByText("Sharing updated")).toBeNull();expect(screen.getByText("Waiting for you to confirm in your browser")).toBeTruthy(); }
 shares.splice(0, shares.length, applied);await act(() => f.query.invalidateQueries({ queryKey: ["agent", AGENT_FIXTURE_ID, "shares"], exact: true }));await screen.findByText("Sharing updated");f.close();
});
it("reads the actual draft revision before reviewing its base update", async () => {
 const f = renderAgents({ path, reply: async () => ({ status: 200, body: { draft: { revision: 10, overlay: { instructions: "Retain refund checks." }, extends: { agentId: "ticket-triage", version: 2 }, updatedBy: "a".repeat(64), updatedAt: "2026-10-23T12:00:00.000Z" }, changes: ["/base/version"] } }) });const navigate = vi.spyOn(f.host, "navigate");fireEvent.click(await screen.findByRole("button", { name: "Review update" }));await waitFor(() => expect(navigate).toHaveBeenCalledWith("/app/agents/" + AGENT_FIXTURE_ID + "/edit?review=base"));expect(f.request.mock.calls.find(([request]) => request.path.endsWith("/update-base"))?.[0].body).toMatchObject({ expectedRevision: 9 });f.close();
});
it("keeps a refused base update in place and shows the real conflict", async () => {
 const f = renderAgents({ path, reply: async () => ({ status: 409, body: { error: { code: "AGENT_REVISION_CONFLICT", message: "The draft changed. Reload it before changing its base." } } }) });const navigate = vi.spyOn(f.host, "navigate");fireEvent.click(await screen.findByRole("button", { name: "Review update" }));await screen.findByText("The draft changed. Reload it before changing its base.");expect(navigate).not.toHaveBeenCalled();expect(screen.getByRole("heading", { name: "Payments Expert" })).toBeTruthy();f.close();
});
it("confirms archive before writing and only removes Start after the returned view changes", async () => {
 const base = agentProfile(), archived = agentProfile({ agent: { ...base.agent, status: "archived" } }), f = renderAgents({ path, reply: async () => ({ status: 200, body: { agent: archived.agent } }) });fireEvent.click(await screen.findByRole("button", { name: "Archive" }));expect(f.request.mock.calls.some(([request]) => request.path.endsWith("/archive"))).toBe(false);f.setProfile(archived);fireEvent.click(screen.getByRole("button", { name: "Archive workflow" }));await waitFor(() => expect(screen.queryByRole("dialog", { name: "Archive this workflow?" })).toBeNull());expect(screen.queryByRole("button", { name: "Start session" })).toBeNull();expect(screen.getByText("Archived")).toBeTruthy();expect(f.request.mock.calls.filter(([request]) => request.path.endsWith("/archive"))).toHaveLength(1);f.close();
});

it("keeps the excluded code start out of a built-in profile", async () => { const base = agentProfile(), f = renderAgents({ path: "/app/agents/rovara-code", profile: agentProfile({ agent: { ...base.agent, agentId: "rovara-code", builtin: true, owner: undefined, pinnedVersion: 1, latestVersion: 1 } }) });await screen.findByRole("heading", { name: "Payments Expert" });expect(screen.queryByRole("button", { name: "Start session" })).toBeNull();f.close(); });

for (const projectOption of [{ projectRole: "viewer" as const }, { projectStatus: "archived" as const }]) it("does not offer projects that cannot start work: " + JSON.stringify(projectOption), async () => { const f = renderAgents({ path, ...projectOption });fireEvent.click(await screen.findByRole("button", { name: "Start session" }));await screen.findByText("No projects where you can start work are available.");expect(screen.getByRole("combobox", { name: "Project" }).querySelectorAll("option")).toHaveLength(1);expect(screen.getByRole<HTMLButtonElement>("button", { name: "Continue" }).disabled).toBe(true);f.close(); });

it("shows at most twenty distinct current tasks for this method and keeps the latest snapshot", async () => {
 const tiles = Array.from({ length: 25 }, (_, index) => liveFixture({ sessionId: "ses_" + String(index).padStart(20, "0"), title: "Work " + index, actions: [] }));
 const f = renderAgents({ path, live: [tiles[0]!, { ...tiles[0]!, step: "Verifying", updatedAt: "2026-10-23T13:00:00.000Z" }, ...tiles.slice(1), liveFixture({ title: "Another method's work", agent: { agentId: "agt_bbbbbbbbbbbbbbbbbbbb", name: "Other", version: 1 } })] });await screen.findByRole("heading", { name: "Payments Expert" });fireEvent.click(screen.getByText("Working on now"));await screen.findByRole("link", { name: "Work 0" });expect(screen.getAllByRole("article")).toHaveLength(20);expect(screen.getAllByRole("link", { name: "Work 0" })).toHaveLength(1);expect(screen.getByRole("link", { name: "Work 19" })).toBeTruthy();expect(screen.getByText("Verifying")).toBeTruthy();expect(screen.queryByText("Another method's work")).toBeNull();f.close();
});
it("subscribes current work only after its successful read, refreshes on notices and stops on close", async () => {
 const tiles: ReturnType<typeof liveFixture>[] = [];let release: (response: ApiResponse) => void = () => undefined, first = true;const initial = new Promise<ApiResponse>(resolve => { release = resolve; });
 const f = renderAgents({ path, liveReply: async () => { if (first) { first = false;return initial; }return { status: 200, body: { tiles } }; } });await screen.findByRole("heading", { name: "Payments Expert" });expect(f.realtimeToken).not.toHaveBeenCalled();fireEvent.click(screen.getByText("Working on now"));await screen.findByLabelText("Loading current work");expect(f.realtimeToken).not.toHaveBeenCalled();release({ status: 200, body: { tiles } });await waitFor(() => expect(f.sockets).toHaveLength(1));const socket = f.sockets[0]!.socket;
 act(() => { socket.open();socket.message({ type: "connection_ack", connectionTimeoutMs: 900_000 }); });await waitFor(() => expect(socket.sent.some(frame => frame.type === "subscribe")).toBe(true));const subscription = socket.sent.find(frame => frame.type === "subscribe")!;
 tiles.push(liveFixture({ title: "Newly started work", actions: [] }));act(() => socket.message({ type: "data", id: subscription.id, event: [JSON.stringify({ type: "session.updated", sessionId: tiles[0]!.sessionId, revision: 2 })] }));await screen.findByRole("link", { name: "Newly started work" });fireEvent.click(screen.getByText("Working on now"));await waitFor(() => expect(socket.closed).toBe(true));f.close();
});
