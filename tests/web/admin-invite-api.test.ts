import { expect, it } from "vitest";
import { createInviteAdminApi } from "../../packages/ui/src/api/invite-admin.js";
import { ApiError } from "../../packages/ui/src/api/errors.js";
import { fakeHost } from "./support/fake-host.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa", id = "11111111-1111-4111-8111-111111111111", other = "22222222-2222-4222-8222-222222222222", body = { requestId: other, expectedRevision: 0 };
const pending = { orgId, inviteId: id, role: "member", revision: 0, status: "pending", expiresAt: "2026-11-02T12:00:00Z", checkedAt: "2026-10-27T12:00:00Z" };
async function code(work: Promise<unknown>) { return work.then(() => "done", error => error instanceof ApiError ? error.code : "unexpected"); }
for (const status of [0, 429, 503, 202]) it(`does not automatically resend a ${status} revoke result`, async () => {
 const f = fakeHost(async () => { if (status === 0) throw new Error("private fixture");return { status, body: { error: { code: status === 429 ? "TOO_MANY_REQUESTS" : "AUDIT_UNAVAILABLE", message: "private fixture" } } }; });const result = await code(createInviteAdminApi(f.host, orgId).revoke(id, body));expect(result).toBe(status === 0 ? "NETWORK_ERROR" : status === 429 ? "TOO_MANY_REQUESTS" : status === 202 ? "PENDING" : "AUDIT_UNAVAILABLE");expect(f.request.mock.calls.length).toBe(1);
});
for (const status of [401, 403]) it(`preserves a transport's pre-send ${status} authority refusal without resending`, async () => {
 const f = fakeHost(async () => { throw new ApiError(status, status === 401 ? "AUTH_REQUIRED" : "FORBIDDEN", "private fixture"); });expect(await code(createInviteAdminApi(f.host, orgId).revoke(id, body))).toBe(status === 401 ? "AUTH_REQUIRED" : "FORBIDDEN");expect(f.request.mock.calls.length).toBe(1);expect(f.host.signIn).toHaveBeenCalledTimes(status === 401 ? 1 : 0);
});
it("rejects wrong scope/ID, unknown terminal states and extra identity fields before exposing status", async () => {
 for (const bad of [{ ...pending, orgId: "org_bbbbbbbbbbbbbbbbbbbb" }, { ...pending, inviteId: other }, { ...pending, status: "future" }, { ...pending, email: "private fixture" }, { ...pending, revision: -1 }, { ...pending, status: "revoked" }]) { const f = fakeHost(async () => ({ status: 200, body: bad }));expect(await code(createInviteAdminApi(f.host, orgId).status(id))).toBe("INVALID_RESPONSE"); }
});
it("validates expected revision and response identity without inheriting retry or storing opaque fields", async () => {
 const f = fakeHost(async () => ({ status: 200, body: { inviteId: id, revision: 1, revokedAt: "2026-10-27T12:00:00Z" } })), api = createInviteAdminApi(f.host, orgId);
 for (const revision of [-1, 1.5, Number.MAX_SAFE_INTEGER]) expect(await code(api.revoke(id, { ...body, expectedRevision: revision }))).toBe("CONFIG_INVALID");expect(await code(api.revoke("bad-id", body))).toBe("CONFIG_INVALID");expect(f.request.mock.calls.length).toBe(0);
 for (const bad of [{ inviteId: other, revision: 1, revokedAt: "2026-10-27T12:00:00Z" }, { inviteId: id, revision: 2, revokedAt: "2026-10-27T12:00:00Z" }, { inviteId: id, revision: 1, revokedAt: "2026-10-27T12:00:00Z", token: "private fixture" }]) { f.request.mockResolvedValue({ status: 200, body: bad });expect(await code(api.revoke(id, body))).toBe("INVALID_RESPONSE"); }
});
