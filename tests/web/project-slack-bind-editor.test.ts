// @vitest-environment jsdom
import { createElement as h } from "react";
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { SlackLinksEditor } from "../../packages/ui/src/screens/admin/projects/SlackLinksEditor.js";
import { retainSlackBindRequest, retainSlackRequest } from "../../packages/ui/src/screens/admin/projects/project-slack-history.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
const scope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), project: "payments" }, teamId = "T0123456789", channelId = "C0123456789";
const inventory = { orgId: scope.orgId, project: scope.project, workspaces: [teamId], bindings: [], continuation: null, partial: false, limitReached: false, inspected: 0, botMembership: "not_verified" };
const target = { orgId: scope.orgId, project: scope.project, teamId, channelId, state: "unlinked", projectStatus: "active", contextDigest: "b".repeat(64), botMembership: "not_verified" };
function envelope(proposal: unknown) { return { kind: "proposal", orgId: scope.orgId, project: scope.project, proposal }; }
it("B34 reviews a new link, requests approval, then separately reviews a sole-owner exception", async () => {
 let pending: unknown = null;
 const f = fakeHost(async input => {
  if (input.method === "GET") return { status: 200, body: input.path.includes("/review?") ? target : input.path.includes("/proposals/") ? envelope(pending) : inventory };
  const body = input.body as { requestId: string };expect(f.storage.size).toBe(1);expect([...f.storage.values()][0]).toContain(body.requestId);
  if (input.path.endsWith("/approve")) return { status: 200, body: { kind: "receipt", orgId: scope.orgId, project: scope.project, receipt: { requestId: body.requestId, operation: "bind", outcome: { changed: true, binding: { teamId, channelId, projectName: scope.project, updatedAt: new Date().toISOString() } }, receiptExpiresAt: new Date(Date.now() + 86400000).toISOString() } } };
  const now = Date.now();pending = { proposalId: body.requestId, by: scope.developerId, teamId, channelId, state: "pending", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() };return { status: 200, body: envelope(pending) };
 });
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));
 fireEvent.click(await screen.findByRole("button", { name: "Link a Slack channel" }));
 fireEvent.change(await screen.findByLabelText("Slack workspace ID"), { target: { value: teamId } });fireEvent.change(screen.getByLabelText("Slack channel ID"), { target: { value: channelId } });
 fireEvent.click(screen.getByRole("button", { name: "Review channel link" }));const propose = await screen.findByRole("button", { name: "Request channel link approval" });
 expect(screen.getByText(/People in this channel gain/)).toBeTruthy();expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);propose.focus();fireEvent.click(propose);
 fireEvent.click(await screen.findByRole("button", { name: "Review sole-owner exception" }));const approve = await screen.findByRole("button", { name: "Apply reviewed sole-owner exception" });expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);expect(screen.getByText(/last 24 hours/)).toBeTruthy();
 approve.focus();fireEvent.click(approve);await screen.findByText(/Link receipt confirmed/);expect(document.activeElement).toBe(approve);expect(approve.getAttribute("aria-disabled")).toBe("true");fireEvent.click(approve);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(2);expect(f.request.mock.calls.some(([r]) => r.path.endsWith("/unbind"))).toBe(false);expect(screen.getAllByRole("status")).toHaveLength(1);
});
it("B34 reopening an ambiguous proposal is status-only and never posts its stored body", async () => {
 const id = "11111111-1111-4111-8111-111111111111", now = Date.now(), pending = { proposalId: id, by: scope.developerId, teamId, channelId, state: "pending", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() };
 const f = fakeHost(async input => ({ status: 200, body: input.path.includes("/proposals/") ? envelope(pending) : inventory }));
 retainSlackBindRequest(f.host.storage, scope, { operation: "propose", reviewedAt: new Date(now).toISOString(), body: { expectedOrgId: scope.orgId, requestId: id, teamId, channelId, expectedContextDigest: "b".repeat(64) } });
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));fireEvent.click(await screen.findByRole("button", { name: "Link a Slack channel" }));
 fireEvent.click(await screen.findByRole("button", { name: "Check Slack link request status" }));await screen.findByRole("button", { name: "Review sole-owner exception" });
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
});
it("B34 an expired saved approval remains status-only after a receipt 404", async () => {
 const now = Date.now(), f = fakeHost(async input => input.path.includes("/requests/") ? { status: 404, body: {} } : { status: 200, body: input.path.includes("/proposals/") ? envelope(null) : inventory });
 retainSlackBindRequest(f.host.storage, scope, { operation: "approve", reviewedAt: new Date(now - 86400000).toISOString(), proposalExpiresAt: new Date(now - 1).toISOString(), body: { expectedOrgId: scope.orgId, requestId: "11111111-1111-4111-8111-111111111111", proposalId: "22222222-2222-4222-8222-222222222222", teamId, channelId } });
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));fireEvent.click(await screen.findByRole("button", { name: "Link a Slack channel" }));fireEvent.click(await screen.findByRole("button", { name: "Check Slack link request status" }));
 await screen.findByText(/saved link request has expired/);expect(screen.queryByRole("button", { name: "Resend same Slack link request" })).toBeNull();await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0));
});
it("B34 an expired live proposal permits a fresh review without resending it", async () => {
 const now = Date.now() - 86400001, pending = { proposalId: "11111111-1111-4111-8111-111111111111", by: scope.developerId, teamId, channelId, state: "pending", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() };
 const f = fakeHost(async input => ({ status: 200, body: input.path.includes("/proposals/") ? envelope(pending) : inventory }));
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));fireEvent.click(await screen.findByRole("button", { name: "Link a Slack channel" }));
 await screen.findByRole("button", { name: "Review channel link" });expect(screen.queryByRole("button", { name: "Review sole-owner exception" })).toBeNull();expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
});
it("B34 a different admin explicitly reviews the pending target and has one accessible outcome", async () => {
 const now = Date.now(), pending = { proposalId: "11111111-1111-4111-8111-111111111111", by: "b".repeat(64), teamId, channelId, state: "pending", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() };
 const f = fakeHost(async input => ({ status: 200, body: input.path.includes("/review?") ? target : input.path.includes("/proposals/") ? envelope(pending) : inventory }));
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));fireEvent.click(await screen.findByRole("button", { name: "Link a Slack channel" }));fireEvent.click(await screen.findByRole("button", { name: "Review pending Slack link" }));
 await screen.findByRole("button", { name: "Approve reviewed Slack link" });expect(screen.queryByRole("button", { name: "Apply reviewed sole-owner exception" })).toBeNull();expect(screen.getAllByRole("status")).toHaveLength(1);expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 const { expectNoAxeViolations } = await import("./support/axe.js");await expectNoAxeViolations(view.container);
});
it("B34 teardown discards a late link-proposal 401 without redirecting the next scope", async () => {
 let finish!: (value: { status: number; body: unknown }) => void;
 const f = fakeHost(async input => input.method === "POST" ? new Promise(resolve => { finish = resolve; }) : { status: 200, body: input.path.includes("/review?") ? target : input.path.includes("/proposals/") ? envelope(null) : inventory });
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));fireEvent.click(await screen.findByRole("button", { name: "Link a Slack channel" }));fireEvent.change(await screen.findByLabelText("Slack workspace ID"), { target: { value: teamId } });fireEvent.change(screen.getByLabelText("Slack channel ID"), { target: { value: channelId } });fireEvent.click(screen.getByRole("button", { name: "Review channel link" }));fireEvent.click(await screen.findByRole("button", { name: "Request channel link approval" }));
 await waitFor(() => expect(finish).toBeDefined());view.rerender(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: false }) }));finish({ status: 401, body: {} });await Promise.resolve();expect(f.host.signIn).not.toHaveBeenCalled();expect(screen.queryByRole("region", { name: "Slack channel link approval" })).toBeNull();
});

it("B34 closing link approval refreshes the parent's history after shared-ledger eviction", async () => {
 const now = Date.now(), f = fakeHost(async input => {
  if (input.method === "GET" && input.path.includes("/proposals/22222222")) return { status: 200, body: envelope({ proposalId: "22222222-2222-4222-8222-222222222222", by: scope.developerId, teamId, channelId, state: "applied", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString(), mode: "second_person", decidedBy: "b".repeat(64), decidedAt: new Date(now).toISOString() }) };
  if (input.method === "GET") return { status: 200, body: input.path.includes("/review?") ? target : input.path.includes("/proposals/") ? envelope(null) : inventory };
  const body = input.body as { requestId: string };return { status: 200, body: envelope({ proposalId: body.requestId, by: scope.developerId, teamId, channelId, state: "pending", createdAt: new Date(now).toISOString(), expiresAt: new Date(now + 86400000).toISOString() }) };
 });
 const body = { expectedOrgId: scope.orgId, teamId, channelId, expectedContextDigest: "b".repeat(64) };
 for (let n = 1; n <= 9; n++) retainSlackRequest(f.host.storage, scope, { reviewedAt: new Date(now).toISOString(), body: { ...body, requestId: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}` } });
 retainSlackBindRequest(f.host.storage, scope, { operation: "propose", reviewedAt: new Date(now).toISOString(), body: { ...body, requestId: "22222222-2222-4222-8222-222222222222" } });
 renderUi(h(AppHostProvider, { host: f.host, children: h(SlackLinksEditor, { ...scope, enabled: true }) }));const entry = await screen.findByRole("button", { name: "Link a Slack channel" });
 expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Earlier Slack request" }).options).toHaveLength(9);fireEvent.click(entry);
 expect(screen.queryByLabelText("Earlier Slack request")).toBeNull();fireEvent.click(await screen.findByRole("button", { name: "Check Slack link request status" }));fireEvent.click(await screen.findByRole("button", { name: "Refresh Slack link approval" }));
 fireEvent.change(await screen.findByLabelText("Slack workspace ID"), { target: { value: teamId } });fireEvent.change(screen.getByLabelText("Slack channel ID"), { target: { value: channelId } });fireEvent.click(screen.getByRole("button", { name: "Review channel link" }));fireEvent.click(await screen.findByRole("button", { name: "Request channel link approval" }));await screen.findByRole("button", { name: "Review sole-owner exception" });
 fireEvent.click(screen.getByRole("button", { name: "Close channel link approval" }));expect(screen.getByRole<HTMLSelectElement>("combobox", { name: "Earlier Slack request" }).options).toHaveLength(8);expect(document.activeElement).toBe(entry);
});
