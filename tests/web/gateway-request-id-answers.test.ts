// The broker's one reply helper (packages/broker/src/aws/json-reply.ts) adds the gateway's `requestId` to every object a route answers.
// A web client that reads an answer with a strict contract must set it aside, or a good answer reads as "unreadable" (QA-03 on staging 0.5.3).
import { expect, it } from "vitest";
import { createBudgetSettingsApi } from "../../packages/ui/src/api/budget-settings.js";
import { createDecisionsApi } from "../../packages/ui/src/api/decisions.js";
import { createInviteAdminApi } from "../../packages/ui/src/api/invite-admin.js";
import { createTaskStopEditingApi } from "../../packages/ui/src/api/task-stop-editing.js";
import { fakeHost } from "./support/fake-host.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa", id = "11111111-1111-4111-8111-111111111111", gateway = { requestId: "gw-request-1" };
const answer = (body: unknown) => fakeHost(async () => ({ status: 200, body: { ...(body as object), ...gateway } }));
const budget = { orgId, checkedAt: "2026-10-27T12:00:00Z", coverage: "monthly_base_settings_only", orgMonthly: { kind: "limited", microdollars: 500_000_000, source: "configured" }, memberDefaultMonthly: { kind: "limited", microdollars: 29_000_000, source: "configured" }, memberOverrideCount: 0, memberOverrideCoverage: "configured_only_membership_not_checked", topUps: "not_checked", usage: "not_checked", enforcement: "not_checked" };
it("reads the monthly base budgets from an answer that carries the gateway requestId", async () => {
 const value = await createBudgetSettingsApi(answer(budget).host, orgId).get();
 expect(value).toEqual(budget);
});
it("still refuses an unknown field other than the gateway requestId", async () => {
 await expect(createBudgetSettingsApi(answer({ ...budget, surprise: 1 }).host, orgId).get()).rejects.toMatchObject({ code: "INVALID_RESPONSE" });
});
it("reads an invite status from an answer that carries the gateway requestId", async () => {
 const status = { orgId, inviteId: id, role: "member", revision: 0, status: "pending", expiresAt: "2026-11-02T12:00:00Z", checkedAt: "2026-10-27T12:00:00Z" };
 expect(await createInviteAdminApi(answer(status).host, orgId).status(id)).toEqual(status);
});
it("reads a revoke answer that carries the gateway requestId", async () => {
 const revoked = { inviteId: id, revokedAt: "2026-10-27T12:00:00Z", revision: 1 };
 expect(await createInviteAdminApi(answer(revoked).host, orgId).revoke(id, { requestId: "22222222-2222-4222-8222-222222222222", expectedRevision: 0 })).toEqual(revoked);
});
it("reads the task stop editing context from an answer that carries the gateway requestId", async () => {
 const context = { orgId, scopeKind: "company", revision: 3, sourceDigest: "c".repeat(64), policy: { kind: "limited", stopMicrousd: 2_000_000 } };
 expect(await createTaskStopEditingApi(answer(context).host, orgId).get()).toEqual(context);
});
it("reads the evidence-opened answer that carries the gateway requestId", async () => {
 const opened = { cardId: "approve_plan:a", opened: true, recorded: true };
 const decision = { card: { id: "approve_plan:a" }, digest: "d1" } as never;
 expect(await createDecisionsApi(answer(opened).host).evidenceOpened(decision)).toEqual(opened);
});
