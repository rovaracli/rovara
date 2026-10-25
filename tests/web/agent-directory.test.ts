// @vitest-environment jsdom
import { expect, it } from "vitest";
import { screen, fireEvent, waitFor } from "@testing-library/react";
import { createAgentApi } from "../../packages/ui/src/api/agents.js";
import { renderAgents } from "./support/agent-render.js";
import { fakeHost } from "./support/fake-host.js";
import { agentDirectory } from "./support/agent-fixture.js";
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
 f.request.mockResolvedValue({ status: 404, body: { error: { code: "NOT_FOUND", message: "Not found." } } });await f.query.invalidateQueries({ queryKey: ["agent", "agt_aaaaaaaaaaaaaaaaaaaa"], exact: true });await screen.findByRole("heading", { name: "Not found" });
 expect(screen.queryByRole("dialog", { name: "Payments Expert" })).toBeNull();expect(screen.queryByText("Check refund idempotency.")).toBeNull();fireEvent.click(screen.getByRole("button", { name: "Close dialog" }));await waitFor(() => expect(screen.queryByRole("link", { name: "Payments Expert" })).toBeNull());f.close();
});
