// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import type { ApiResponse } from "../../packages/ui/src/host.js";
import { createAgentApi } from "../../packages/ui/src/api/agents.js";
import { renderAgents } from "./support/agent-render.js";
import { fakeHost } from "./support/fake-host.js";
import { agentAllows } from "../../packages/ui/src/screens/agents/agent-access.js";
import { agentDirectory, agentProfile } from "./support/agent-fixture.js";
import { expectNoAxeViolations } from "./support/axe.js";
it("keeps directory scope in the URL and sends the exact selected scope", async () => {
 const f = renderAgents();await screen.findByRole("link", { name: "Payments Expert" });
 for (const [label, scope] of [["Mine", "mine"], ["Shared with me", "shared"], ["Built in", "builtin"], ["All", "all"]] as const) {
  fireEvent.mouseDown(screen.getByRole("tab", { name: label }), { button: 0, ctrlKey: false });
  await waitFor(() => expect(f.request.mock.calls.some(([request]) => request.path === "/v1/app/agents?scope=" + scope)).toBe(true));
 }
 expect(screen.getByRole("link", { name: "New agent" }).getAttribute("href")).toBe("/app/agents/new");f.close();
});
it("opens the profile in context without replacing the loaded directory", async () => {
 const f = renderAgents(), link = await screen.findByRole("link", { name: "Payments Expert" }), list = screen.getByRole("list", { name: "Shared workflows" });
 link.focus();fireEvent.click(link);await screen.findByRole("dialog", { name: "Payments Expert" });expect(list.isConnected).toBe(true);
 fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));await waitFor(() => expect(document.activeElement).toBe(link));
 expect(f.router.state.location.pathname).toBe("/app/agents");f.close();
});
it("preserves project scope without inventing a second scope filter", async () => {
 const f = fakeHost(async () => ({ status: 200, body: agentDirectory() }));await createAgentApi(f.host).list("shared", "payments");
 expect(f.request.mock.calls[0]?.[0].path).toBe("/v1/app/agents?project=payments");
});
for (const theme of ["light", "dark"] as const) it("has an accessible directory in " + theme, async () => { const f = renderAgents({ theme });await screen.findByRole("link", { name: "Payments Expert" });await expectNoAxeViolations(f.container);f.close(); });
it("removes a cached private profile title and row after its contextual read is denied", async () => {
 const f = renderAgents();fireEvent.click(await screen.findByRole("link", { name: "Payments Expert" }));await screen.findByRole("dialog", { name: "Payments Expert" });
 let release: (response: ApiResponse) => void = () => undefined;
 const pendingList = new Promise<ApiResponse>(resolve => { release = resolve; });
 f.request.mockImplementation(async request => request.path.startsWith("/v1/app/agents?") ? pendingList : { status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } });try { await f.query.invalidateQueries({ queryKey: ["agent", "agt_aaaaaaaaaaaaaaaaaaaa"], exact: true });await screen.findByRole("heading", { name: "Not found" });
 expect(screen.queryByRole("dialog", { name: "Payments Expert" })).toBeNull();expect(screen.queryByText("Check refund idempotency.")).toBeNull();fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));await waitFor(() => expect(screen.queryByRole("link", { name: "Payments Expert" })).toBeNull()); } finally { release({ status: 200, body: { agents: [] } });f.close(); }
});
it("rejects malformed workflow and project identifiers before transport", () => {
 const f = fakeHost(), api = createAgentApi(f.host);for (const id of ["../agents", "agt_bad", "ses_aaaaaaaaaaaaaaaaaaaa"]) expect(() => api.read(id)).toThrow();expect(() => api.list("all", "payments/other")).toThrow();expect(() => api.spend("agt_aaaaaaaaaaaaaaaaaaaa", "2026-13")).toThrow();expect(f.request).not.toHaveBeenCalled();
});

it("keeps newer access values readable without granting any action", async () => {
 const base = agentProfile(), f = fakeHost(async () => ({ status: 200, body: { ...base, agent: { ...base.agent, access: "future_manager" } } })), read = await createAgentApi(f.host).read(base.agent.agentId);
 expect(read.agent.access).toBe("unknown");for (const wanted of ["use", "edit", "manage"] as const) expect(agentAllows(read.agent, wanted)).toBe(false);
});

it("uses profile permissions even when the retained directory summary had stronger access", async () => { const base = agentProfile(), f = renderAgents({ profile: agentProfile({ agent: { ...base.agent, access: "view" } }) });fireEvent.click(await screen.findByRole("link", { name: "Payments Expert" }));await screen.findByRole("dialog", { name: "Payments Expert" });expect(screen.queryByRole("button", { name: "Review update" })).toBeNull();expect(screen.queryByRole("link", { name: "Edit" })).toBeNull();expect(screen.queryByRole("button", { name: "Share" })).toBeNull();f.close(); });
