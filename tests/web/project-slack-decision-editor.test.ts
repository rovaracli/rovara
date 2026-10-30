// @vitest-environment jsdom
import { createElement as h } from "react";
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SlackBindEditor } from "../../packages/ui/src/screens/admin/projects/SlackBindEditor.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
const scope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), project: "payments" }, teamId = "T0123456789", channelId = "C0123456789", proposalId = "11111111-1111-4111-8111-111111111111";
function pending(by = scope.developerId) { const now = Date.now();return { proposalId, by, teamId, channelId, state: "pending", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() }; }
for (const decision of ["cancel", "reject"] as const) it(`B35 explicitly reviews and confirms ${decision} with a retained UUID, never binding the channel`, async () => {
 const proposal = pending(decision === "reject" ? "b".repeat(64) : scope.developerId);
 const f = fakeHost(async input => {
  if (input.method === "GET") return { status: 200, body: { kind: "proposal", orgId: scope.orgId, project: scope.project, proposal } };
  const body = input.body as { requestId: string };expect([...f.storage.values()][0]).toContain(body.requestId);
  return { status: 200, body: { kind: "decision", orgId: scope.orgId, project: scope.project, decision: { requestId: body.requestId, proposalId, state: decision === "cancel" ? "cancelled" : "rejected", createdAt: new Date().toISOString(), expiresAt: proposal.expiresAt } } };
 });
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackBindEditor, { ...scope, onClose: () => {} }) }));
 fireEvent.click(await screen.findByRole("button", { name: decision === "cancel" ? "Review cancellation" : "Review rejection" }));
 expect(f.request.mock.calls.filter(([input]) => input.method === "POST")).toHaveLength(0);
 fireEvent.click(await screen.findByRole("button", { name: decision === "cancel" ? "Confirm cancellation" : "Confirm rejection" }));
 await screen.findByText(/Decision receipt confirmed/);
 expect(f.request.mock.calls.filter(([input]) => input.method === "POST")).toHaveLength(1);
 expect(f.request.mock.calls.at(-1)?.[0].path).toBe(`/v1/app/projects/payments/slack-channel/proposals/${proposalId}/${decision}`);
 expect(f.request.mock.calls.some(([input]) => input.path.endsWith("/approve"))).toBe(false);
});
it("B35 reload recovers a saved decision with status only even after the LIVE pointer was cleared", async () => {
 const history = await import("../../packages/ui/src/screens/admin/projects/project-slack-history.js"), proposal = pending(), f = fakeHost(async input => ({ status: 200, body: input.path.includes("/decisions/") ? { kind: "decision", orgId: scope.orgId, project: scope.project, decision: { requestId: "22222222-2222-4222-8222-222222222222", proposalId, state: "cancelled", createdAt: new Date().toISOString(), expiresAt: proposal.expiresAt } } : { kind: "proposal", orgId: scope.orgId, project: scope.project, proposal: null } }));
 history.retainSlackDecisionRequest(f.host.storage, scope, { operation: "cancel", reviewedAt: new Date().toISOString(), proposalExpiresAt: proposal.expiresAt, body: { expectedOrgId: scope.orgId, requestId: "22222222-2222-4222-8222-222222222222", proposalId, teamId, channelId } });
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackBindEditor, { ...scope, onClose: () => {} }) }));
 fireEvent.click(await screen.findByRole("button", { name: "Review saved Slack decisions" }));
 fireEvent.click(await screen.findByRole("button", { name: "Check Slack decision status" }));
 await screen.findByText(/Decision receipt confirmed/);await waitFor(() => expect(f.request.mock.calls.filter(([input]) => input.method === "POST")).toHaveLength(0));
});

it("B35 an unconfirmed decision needs a status 404 and an explicit same-body resend", async () => {
 const proposal = pending();let posts = 0;
 const f = fakeHost(async input => {
  if (input.path.includes("/decisions/")) return { status: 404, body: { error: { code: "NOT_FOUND" } } };
  if (input.method === "GET") return { status: 200, body: { kind: "proposal", orgId: scope.orgId, project: scope.project, proposal } };
  posts++;if (posts === 1) throw new Error("Response lost");const body = input.body as { requestId: string };return { status: 200, body: { kind: "decision", orgId: scope.orgId, project: scope.project, decision: { requestId: body.requestId, proposalId, state: "cancelled", createdAt: new Date().toISOString(), expiresAt: proposal.expiresAt } } };
 });
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackBindEditor, { ...scope, onClose: () => {} }) }));
 fireEvent.click(await screen.findByRole("button", { name: "Review cancellation" }));fireEvent.click(await screen.findByRole("button", { name: "Confirm cancellation" }));
 fireEvent.click(await screen.findByRole("button", { name: "Check Slack decision status" }));fireEvent.click(await screen.findByRole("button", { name: "Resend same Slack decision" }));await screen.findByText(/Decision receipt confirmed/);
 const sent = f.request.mock.calls.map(([input]) => input).filter(input => input.method === "POST");expect(sent).toHaveLength(2);expect(sent[0]?.body).toEqual(sent[1]?.body);expect(sent.every(input => input.retry === "never")).toBe(true);
});
it("B35 expired saved decisions cannot be resent after a status 404", async () => {
 const history = await import("../../packages/ui/src/screens/admin/projects/project-slack-history.js"), f = fakeHost(async input => ({ status: input.path.includes("/decisions/") ? 404 : 200, body: input.path.includes("/decisions/") ? { error: { code: "NOT_FOUND" } } : { kind: "proposal", orgId: scope.orgId, project: scope.project, proposal: null } }));
 history.retainSlackDecisionRequest(f.host.storage, scope, { operation: "cancel", reviewedAt: new Date(Date.now() - 86400001).toISOString(), proposalExpiresAt: new Date(Date.now() - 1).toISOString(), body: { expectedOrgId: scope.orgId, requestId: "22222222-2222-4222-8222-222222222222", proposalId, teamId, channelId } });
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackBindEditor, { ...scope, onClose: () => {} }) }));fireEvent.click(await screen.findByRole("button", { name: "Review saved Slack decisions" }));fireEvent.click(await screen.findByRole("button", { name: "Check Slack decision status" }));
 await screen.findByText(/No decision receipt confirmed/);expect(screen.queryByRole("button", { name: "Resend same Slack decision" })).toBeNull();expect(f.request.mock.calls.filter(([input]) => input.method === "POST")).toHaveLength(0);
});
