import { expect, it } from "vitest";
import { createProjectSlackApi } from "../../packages/ui/src/api/project-slack.js";
import { ProjectSlackInventorySchema, ProjectSlackReceiptReaderSchema } from "../../packages/contracts/src/app-project-slack.js";
import { fakeHost } from "./support/fake-host.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa", project = "payments", teamId = "T0123456789", channelId = "C0123456789", requestId = "11111111-1111-4111-8111-111111111111", expectedContextDigest = "a".repeat(64);
const inventory = { orgId, project, workspaces: [teamId], bindings: [{ teamId, channelId, updatedAt: "2026-10-01T00:00:00Z" }], continuation: null, partial: false, limitReached: false, inspected: 1, botMembership: "not_verified" };
const review = { orgId, project, teamId, channelId, state: "linked", updatedAt: "2026-10-01T00:00:00Z", projectStatus: "active", contextDigest: expectedContextDigest, botMembership: "not_verified" };
const receipt = { kind: "receipt", orgId, project, receipt: { requestId, operation: "unbind", outcome: { teamId, channelId, removed: true }, receiptExpiresAt: "2026-10-31T00:00:00Z" } };
it("validates bounded stored evidence and preserves a nested business UUID beside tracing metadata", () => {
 expect(ProjectSlackInventorySchema.safeParse({ ...inventory, bindings: Array.from({ length: 101 }, () => inventory.bindings[0]) }).success).toBe(false);
 expect(ProjectSlackInventorySchema.safeParse({ ...inventory, continuation: "cursor", partial: false }).success).toBe(false);
 expect(ProjectSlackReceiptReaderSchema.parse({ ...receipt, requestId: "transport" })).toEqual(receipt);
});
it("uses company-pinned paths with retry never and exactly one explicit unbind POST", async () => {
 const f = fakeHost(async input => ({ status: 200, body: input.method === "POST" || input.path.includes("/requests/") ? receipt : input.path.includes("/review?") ? review : inventory })), api = createProjectSlackApi(f.host, orgId, project);
 expect(await api.list()).toEqual(inventory);expect(await api.review(teamId, channelId)).toEqual(review);expect(await api.unbind({ requestId, teamId, channelId, expectedContextDigest })).toEqual(receipt);expect(await api.status(requestId)).toEqual(receipt);
 expect(f.request.mock.calls.filter(([input]) => input.method === "POST")).toHaveLength(1);expect(f.request.mock.calls.every(([input]) => input.retry === "never")).toBe(true);
 expect(f.request.mock.calls.find(([input]) => input.method === "POST")?.[0]).toMatchObject({ path: `/v1/app/projects/${project}/slack-channel/unbind`, body: { expectedOrgId: orgId, requestId, teamId, channelId, expectedContextDigest } });
});
for (const status of [403, 429, 503]) it(`does not retry ${status} or expose raw Slack/project error text`, async () => {
 const f = fakeHost(async () => ({ status, body: { error: { code: "FORBIDDEN", message: "secret-project diagnostic" } } }));
 await expect(createProjectSlackApi(f.host, orgId, project).unbind({ requestId, teamId, channelId, expectedContextDigest })).rejects.toBeDefined();expect(f.request).toHaveBeenCalledTimes(1);
});
it("refuses another-company evidence and a mismatched receipt identity", async () => {
 const f = fakeHost(async input => ({ status: 200, body: input.method === "GET" ? { ...inventory, orgId: "org_bbbbbbbbbbbbbbbbbbbb" } : { ...receipt, receipt: { ...receipt.receipt, requestId: "22222222-1111-4111-8111-111111111111" } } })), api = createProjectSlackApi(f.host, orgId, project);
 await expect(api.list()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });await expect(api.unbind({ requestId, teamId, channelId, expectedContextDigest })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
it("B34 browser client proposes, reads pending state and explicitly approves with no automatic POST", async () => {
 const proposalId = requestId, approvalId = "22222222-2222-4222-8222-222222222222", pending = { kind: "proposal", orgId, project, proposal: { proposalId, by: "a".repeat(64), teamId, channelId, state: "pending", createdAt: "2026-10-30T00:00:00Z", expiresAt: "2026-10-31T00:00:00Z" } };
 const bound = { kind: "receipt", orgId, project, receipt: { requestId: approvalId, operation: "bind", outcome: { binding: { teamId, channelId, projectName: project, updatedAt: "2026-10-30T00:01:00Z" }, changed: true }, receiptExpiresAt: "2026-10-31T00:01:00Z" } };
 const f = fakeHost(async input => ({ status: 200, body: input.path.endsWith("/approve") ? bound : pending })), api = createProjectSlackApi(f.host, orgId, project);
 expect(await api.propose({ requestId, teamId, channelId, expectedContextDigest })).toEqual(pending);expect(await api.proposal()).toEqual(pending);expect(await api.proposal(proposalId)).toEqual(pending);
 expect(f.request.mock.calls.filter(([input]) => input.method === "POST")).toHaveLength(1);
 expect(await api.approve({ requestId: approvalId, proposalId, teamId, channelId })).toEqual(bound);
 expect(f.request.mock.calls.filter(([input]) => input.method === "POST")).toHaveLength(2);expect(f.request.mock.calls.every(([input]) => input.retry === "never")).toBe(true);
 expect(f.request.mock.calls.at(-1)?.[0]).toMatchObject({ path: `/v1/app/projects/${project}/slack-channel/proposals/${proposalId}/approve`, body: { expectedOrgId: orgId, requestId: approvalId } });
});
it("B34 browser client rejects a proposed target or approval outcome for a different channel", async () => {
 const approvalId = "22222222-2222-4222-8222-222222222222", pending = { kind: "proposal", orgId, project, proposal: { proposalId: requestId, by: "a".repeat(64), teamId, channelId: "C0987654321", state: "pending", createdAt: "2026-10-30T00:00:00Z", expiresAt: "2026-10-31T00:00:00Z" } };
 const f = fakeHost(async input => ({ status: 200, body: input.path.endsWith("/approve") ? { kind: "receipt", orgId, project, receipt: { requestId: approvalId, operation: "bind", outcome: { binding: { teamId, channelId: "C0987654321", projectName: project, updatedAt: "2026-10-30T00:01:00Z" }, changed: true }, receiptExpiresAt: "2026-10-31T00:01:00Z" } } : pending })), api = createProjectSlackApi(f.host, orgId, project);
 await expect(api.propose({ requestId, teamId, channelId, expectedContextDigest })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
 await expect(api.approve({ requestId: approvalId, proposalId: requestId, teamId, channelId })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});

for (const decision of ["cancel", "reject"] as const) it(`B35 ${decision} and decision readback pin the exact proposal and UUID without retries`, async () => {
 const proposalId = "22222222-2222-4222-8222-222222222222", result = { kind: "decision", orgId, project, decision: { requestId, proposalId, state: decision === "cancel" ? "cancelled" : "rejected", createdAt: "2026-10-30T00:00:00Z", expiresAt: "2026-10-31T00:00:00Z" } };
 const f = fakeHost(async () => ({ status: 200, body: result })), api = createProjectSlackApi(f.host, orgId, project);
 expect(await api.decide({ requestId, proposalId, decision })).toEqual(result);expect(await api.decisionStatus(requestId)).toEqual(result);
 expect(f.request.mock.calls[0]?.[0]).toMatchObject({ method: "POST", retry: "never", path: `/v1/app/projects/${project}/slack-channel/proposals/${proposalId}/${decision}`, body: { expectedOrgId: orgId, requestId } });
 expect(f.request.mock.calls[1]?.[0]).toMatchObject({ method: "GET", retry: "never", path: `/v1/app/projects/${project}/slack-channel/decisions/${requestId}?expectedOrgId=${orgId}` });
 const wrong = fakeHost(async () => ({ status: 200, body: { ...result, decision: { ...result.decision, proposalId: requestId } } }));
 await expect(createProjectSlackApi(wrong.host, orgId, project).decide({ requestId, proposalId, decision })).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
