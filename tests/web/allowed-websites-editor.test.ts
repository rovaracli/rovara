// @vitest-environment jsdom
import { createElement as h } from "react";
import { expect, it } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import { AppHostProvider } from "../../packages/ui/src/host.js";
import { AllowedWebsitesEditor } from "../../packages/ui/src/screens/admin/projects/AllowedWebsitesEditor.js";
import { fakeHost } from "./support/fake-host.js";
import { renderUi } from "./support/render.js";
const scope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), project: "payments" };
const review = { kind: "review", status: "review", orgId: scope.orgId, project: scope.project, baseRevision: 1, contextDigest: "b".repeat(64), allowedDomains: ["xn--bcher-kva.acme.dev"], defaultDomains: ["github.com"], staffDomains: [{ domain: "xn--bcher-kva.acme.dev", status: "pending" }], liveProposal: null };
it("reviews the canonical diff and durably retains a UUID before one explicit narrowing POST", async () => {
 const f = fakeHost(async input => {
  if (input.method === "GET") return { status: 200, body: review };
  expect(f.storage.size).toBe(1);const body = input.body as { requestId: string };
  expect([...f.storage.values()][0]).toContain(body.requestId);
  return { status: 200, body: { kind: "receipt", status: "applied", receipt: { requestId: body.requestId, state: "applied", mode: "direct_narrowing", resultRevision: 2, createdAt: "2026-10-29T21:00:00.000Z" } } };
 });
 renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 await screen.findByLabelText("Allowed websites, one hostname per line");
 expect(screen.getByText("github.com")).toBeTruthy();expect(screen.getAllByText(/xn--bcher-kva/).length).toBeGreaterThan(0);
 fireEvent.change(screen.getByLabelText("Allowed websites, one hostname per line"), { target: { value: "" } });
 fireEvent.click(screen.getByRole("button", { name: "Review website change" }));
 await screen.findByText(/Remove: xn--bcher-kva/);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 fireEvent.click(screen.getByRole("button", { name: "Save website removal" }));
 await screen.findByText(/Receipt confirmed/);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
});
it("keeps an ambiguous request status-only until explicit same-request resend", async () => {
 const f = fakeHost(async input => input.method === "POST" ? { status: 503, body: {} } : input.path.includes("/requests/") ? { status: 404, body: {} } : { status: 200, body: review });
 renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 await screen.findByLabelText("Allowed websites, one hostname per line");
 fireEvent.change(screen.getByLabelText("Allowed websites, one hostname per line"), { target: { value: "" } });
 fireEvent.click(screen.getByRole("button", { name: "Review website change" }));
 fireEvent.click(await screen.findByRole("button", { name: "Save website removal" }));
 await screen.findByText(/outcome is unconfirmed/);
 fireEvent.click(screen.getByRole("button", { name: "Check request status" }));
 await screen.findByRole("button", { name: "Resend same request" });
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1));
 fireEvent.click(screen.getByRole("button", { name: "Resend same request" }));
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(2));
 const bodies = f.request.mock.calls.filter(([r]) => r.method === "POST").map(([r]) => r.body);expect(bodies[0]).toEqual(bodies[1]);
});
it("a live disabled scope removes the editor and ignores a delayed mutation", async () => {
 let finish!: (value: { status: number; body: unknown }) => void;
 const f = fakeHost(async input => input.method === "GET" ? { status: 200, body: review } : new Promise(resolve => { finish = resolve; }));
 const mounted = renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 await screen.findByLabelText("Allowed websites, one hostname per line");
 fireEvent.change(screen.getByLabelText("Allowed websites, one hostname per line"), { target: { value: "" } });
 fireEvent.click(screen.getByRole("button", { name: "Review website change" }));
 fireEvent.click(await screen.findByRole("button", { name: "Save website removal" }));
 expect(screen.getByRole("button", { name: "Save website removal" })).toHaveProperty("disabled", true);
 mounted.rerender(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: false }) }));
 finish({ status: 401, body: {} });await Promise.resolve();
 expect(screen.queryByRole("region", { name: "Allowed websites editor" })).toBeNull();expect(f.host.signIn).not.toHaveBeenCalled();
});
it("a refused addition requires a fresh server review and UUID", async () => {
 const f = fakeHost(async input => input.method === "GET" ? { status: 200, body: review } : { status: 409, body: { error: { code: "CHANGE_STALE" } } });
 renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 await screen.findByLabelText("Allowed websites, one hostname per line");
 fireEvent.change(screen.getByLabelText("Allowed websites, one hostname per line"), { target: { value: "new.acme.dev" } });
 fireEvent.click(screen.getByRole("button", { name: "Review website change" }));
 fireEvent.click(await screen.findByRole("button", { name: "Propose website additions" }));
 await screen.findByText(/request was refused/);
 const before = f.request.mock.calls.filter(([r]) => r.method === "GET").length;
 fireEvent.click(screen.getByRole("button", { name: "Refresh canonical website settings" }));
 await screen.findByRole("button", { name: "Review website change" });
 expect(f.request.mock.calls.filter(([r]) => r.method === "GET").length).toBe(before + 1);
 fireEvent.change(screen.getByLabelText("Allowed websites, one hostname per line"), { target: { value: "new.acme.dev" } });
 fireEvent.click(screen.getByRole("button", { name: "Review website change" }));
 fireEvent.click(await screen.findByRole("button", { name: "Propose website additions" }));
 await waitFor(() => expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(2));
 const ids = f.request.mock.calls.filter(([r]) => r.method === "POST").map(([r]) => (r.body as { requestId: string }).requestId);expect(ids[0]).not.toBe(ids[1]);
});
const proposal = { kind: "proposal", proposalId: "88888888-1111-4111-8111-111111111111", proposedBy: "c".repeat(64), status: "pending", baseRevision: 1, beforeDomains: review.allowedDomains, afterDomains: ["new.acme.dev"], createdAt: "2026-10-29T21:00:00.000Z", expiresAt: "2026-10-30T21:00:00.000Z" };
it("reviews another person's pending proposal before an explicit approval with a durable new UUID", async () => {
 const f = fakeHost(async input => {
  if (input.method === "GET") return { status: 200, body: { ...review, liveProposal: proposal } };
  expect(input.path).toContain(`/proposals/${proposal.proposalId}/approve`);
  const body = input.body as { requestId: string; soleOwnerAcknowledged: boolean };expect(body.soleOwnerAcknowledged).toBe(false);expect([...f.storage.values()][0]).toContain(body.requestId);
  return { status: 200, body: { kind: "receipt", status: "applied", proposalId: proposal.proposalId, receipt: { requestId: body.requestId, proposalId: proposal.proposalId, state: "applied", mode: "second_person", resultRevision: 2, createdAt: proposal.createdAt } } };
 });
 renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 fireEvent.click(await screen.findByRole("button", { name: "Review proposal approval" }));
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 fireEvent.click(await screen.findByRole("button", { name: "Approve reviewed proposal" }));await screen.findByText(/Receipt confirmed/);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
});
it("self approval requires an explicit sole-owner acknowledgement before review", async () => {
 const f = fakeHost(async () => ({ status: 200, body: { ...review, liveProposal: { ...proposal, proposedBy: scope.developerId } } }));
 renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 const approve = await screen.findByRole("button", { name: "Review sole-owner exception" });expect(approve).toHaveProperty("disabled", true);
 fireEvent.click(screen.getByRole("checkbox", { name: /sole company owner/ }));expect(approve).toHaveProperty("disabled", false);
 fireEvent.click(approve);await screen.findByRole("button", { name: "Approve reviewed proposal" });
 expect([...f.storage.values()][0]).toContain('"soleOwnerAcknowledged":true');
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
});
for (const decision of ["cancel", "reject"] as const) it(`reviews and retains a ${decision} without sending on selection`, async () => {
 const self = decision === "cancel", pending = { ...proposal, proposedBy: self ? scope.developerId : proposal.proposedBy };
 const f = fakeHost(async input => input.method === "GET" ? { status: 200, body: { ...review, liveProposal: pending } } : { status: 200, body: { kind: "receipt", proposalId: proposal.proposalId, status: self ? "cancelled" : "rejected", receipt: { requestId: (input.body as { requestId: string }).requestId, proposalId: proposal.proposalId, state: self ? "cancelled" : "rejected", createdAt: proposal.createdAt } } });
 renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 fireEvent.click(await screen.findByRole("button", { name: self ? "Review proposal cancellation" : "Review proposal rejection" }));
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 fireEvent.click(screen.getByRole("button", { name: self ? "Cancel reviewed proposal" : "Reject reviewed proposal" }));await screen.findByText(/Receipt confirmed/);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 expect(f.request.mock.calls.find(([r]) => r.method === "POST")?.[0].path).toContain(`/proposals/${proposal.proposalId}/${decision}`);
});
it("historical request selection checks status only and never sends a stored body", async () => {
 const { retainWebsiteRequest } = await import("../../packages/ui/src/screens/admin/projects/allowed-websites-history.js");
 const f = fakeHost(async input => input.path.includes("/requests/") ? { status: 404, body: {} } : { status: 200, body: review });
 const ids = ["11111111-1111-4111-8111-111111111111", "22222222-1111-4111-8111-111111111111"];
 for (const requestId of ids) retainWebsiteRequest(f.host.storage, scope, { operation: "save", body: { expectedOrgId: scope.orgId, requestId, expectedRevision: 1, expectedContextDigest: review.contextDigest, allowedDomains: [] } });
 renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 const selection = await screen.findByRole("combobox", { name: "Earlier website request" });
 fireEvent.change(selection, { target: { value: "0" } });
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
 fireEvent.click(screen.getByRole("button", { name: "Check request status" }));
 await screen.findByRole("button", { name: "Resend same request" });
 expect(f.request.mock.calls.some(([r]) => r.path.includes(`/requests/${ids[0]}`))).toBe(true);
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
});
it("an old read cannot replace a new editor after scope reactivation", async () => {
 let finish!: (value: { status: number; body: unknown }) => void, reads = 0;
 const f = fakeHost(async () => ++reads === 1 ? new Promise(resolve => { finish = resolve; }) : { status: 200, body: review });
 const mounted = renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 await waitFor(() => expect(reads).toBe(1));
 mounted.rerender(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: false }) }));
 mounted.rerender(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 await screen.findByRole("button", { name: "Review website change" });
 const { act } = await import("@testing-library/react");await act(async () => { finish({ status: 401, body: {} });await new Promise(resolve => setTimeout(resolve, 0)); });
 expect(screen.getByRole("button", { name: "Review website change" })).toBeTruthy();expect(screen.queryByText(/could not be checked/)).toBeNull();expect(f.host.signIn).not.toHaveBeenCalled();
});
it("retains the POST button focus through ambiguity", async () => {
 const f = fakeHost(async input => input.method === "GET" ? { status: 200, body: review } : { status: 503, body: {} });
 renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 await screen.findByLabelText("Allowed websites, one hostname per line");fireEvent.change(screen.getByLabelText("Allowed websites, one hostname per line"), { target: { value: "" } });fireEvent.click(screen.getByRole("button", { name: "Review website change" }));
 const send = await screen.findByRole("button", { name: "Save website removal" });send.focus();fireEvent.click(send);await screen.findByText(/outcome is unconfirmed/);
 expect(document.activeElement).toBe(send);expect(send).toHaveProperty("disabled", true);
});
it("the canonical editor has accessible controls and one live announcement", async () => {
 const { expectNoAxeViolations } = await import("./support/axe.js");const f = fakeHost(async () => ({ status: 200, body: review }));
 const view = renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 await screen.findByRole("button", { name: "Review website change" });expect(screen.getAllByRole("status")).toHaveLength(1);await expectNoAxeViolations(view.container);
});
it("focuses a changed canonical summary after refresh and preserves the earlier receipt separately", async () => {
 let saved = false;
 const f = fakeHost(async input => {
  if (input.method === "GET") return { status: 200, body: saved ? { ...review, baseRevision: 3, contextDigest: "c".repeat(64), allowedDomains: ["later.acme.dev"], staffDomains: [{ domain: "later.acme.dev", status: "approved" }] } : review };
  saved = true;return { status: 200, body: { kind: "receipt", status: "applied", receipt: { requestId: (input.body as { requestId: string }).requestId, state: "applied", mode: "direct_narrowing", resultRevision: 2, createdAt: proposal.createdAt } } };
 });
 renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 await screen.findByLabelText("Allowed websites, one hostname per line");fireEvent.change(screen.getByLabelText("Allowed websites, one hostname per line"), { target: { value: "" } });fireEvent.click(screen.getByRole("button", { name: "Review website change" }));fireEvent.click(await screen.findByRole("button", { name: "Save website removal" }));
 await screen.findByText(/Receipt confirmed/);fireEvent.click(screen.getByRole("button", { name: "Refresh canonical website settings" }));
 const summary = await screen.findByRole("heading", { name: "Current project websites" });await screen.findByText(/later.acme.dev · staff approved/);
 expect(document.activeElement).toBe(summary);expect(screen.getByText(/Earlier request applied at revision 2/)).toBeTruthy();expect(screen.getAllByRole("status")).toHaveLength(1);
});
it("keeps mandatory websites in a collapsed read-only disclosure beside the editable list", async () => {
 const f = fakeHost(async () => ({ status: 200, body: review }));renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 await screen.findByRole("button", { name: "Review website change" });
 const summary = screen.getByText("Always-allowed websites (1)", { exact: true }), disclosure = summary.closest("details");
 expect(disclosure).not.toBeNull();expect(disclosure?.open).toBe(false);fireEvent.click(summary);
 expect(disclosure?.querySelector("li")?.textContent).toBe("github.com");expect(disclosure?.querySelector("input,textarea,button")).toBeNull();
 expect(screen.getByRole("textbox", { name: "Allowed websites, one hostname per line" })).toHaveProperty("value", "xn--bcher-kva.acme.dev");
});

for (const status of ["applied", "rejected", "cancelled", "expired", "stale"] as const) it(`reports a retained ${status} proposal without pending approval instructions or a POST`, async () => {
 const { retainWebsiteRequest } = await import("../../packages/ui/src/screens/admin/projects/allowed-websites-history.js");
 const f = fakeHost(async input => ({ status: 200, body: input.path.includes("/requests/") ? { ...proposal, status } : review }));
 retainWebsiteRequest(f.host.storage, scope, { operation: "propose", body: { expectedOrgId: scope.orgId, requestId: proposal.proposalId, expectedRevision: 1, expectedContextDigest: review.contextDigest, allowedDomains: proposal.afterDomains } });
 renderUi(h(AppHostProvider, { host: f.host, children: h(AllowedWebsitesEditor, { ...scope, enabled: true }) }));
 fireEvent.click(await screen.findByRole("button", { name: "Check request status" }));
 await screen.findByText(`Proposal status: ${status}. Refresh canonical website settings to see the current list.`);
 expect(screen.queryByText(/different eligible person must review/)).toBeNull();
 expect(screen.queryByRole("button", { name: "Resend same request" })).toBeNull();
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(0);
});
