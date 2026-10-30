import { expect, it } from "vitest";
import { retainSlackRequest, readSlackRequests, selectSlackRequest, slackRequestStorageKey, slackRequestCanResend } from "../../packages/ui/src/screens/admin/projects/project-slack-history.js";
import { fakeHost } from "./support/fake-host.js";
const scope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), project: "payments" }, at = Date.parse("2026-10-30T07:25:00Z");
const request = (n = 1) => ({ reviewedAt: new Date(at).toISOString(), body: { expectedOrgId: scope.orgId, requestId: `11111111-1111-4111-8111-${String(n).padStart(12, "0")}`, teamId: "T0123456789", channelId: "C0123456789", expectedContextDigest: "b".repeat(64) } });
it("retains exact reviewed UUID/body in one bounded scoped key with checked selection", () => {
 const f = fakeHost();for (let n = 1; n <= 12; n++) retainSlackRequest(f.host.storage, scope, request(n));
 const history = readSlackRequests(f.host.storage, scope);expect(history.requests).toHaveLength(10);expect(history.selectedIndex).toBe(9);expect(f.storage.size).toBe(1);
 expect(selectSlackRequest(f.host.storage, scope, 0)).toEqual(request(3));expect(readSlackRequests(f.host.storage, scope).selectedIndex).toBe(0);expect(() => selectSlackRequest(f.host.storage, scope, -1)).toThrow();
});
it("same UUID cannot acquire a different reviewed body or timestamp", () => {
 const f = fakeHost();retainSlackRequest(f.host.storage, scope, request());retainSlackRequest(f.host.storage, scope, request());
 expect(() => retainSlackRequest(f.host.storage, scope, { ...request(), body: { ...request().body, channelId: "C9999999999" } })).toThrow();
 expect(readSlackRequests(f.host.storage, scope).requests).toHaveLength(1);
});
it("requires exact storage readback before a request can be sent", () => {
 const f = fakeHost(), broken = { get: (key: string) => f.host.storage.get(key), set: () => {} };expect(() => retainSlackRequest(broken, scope, request())).toThrow();
});
it("refuses a foreign scope, invalid history index and untrusted fields", () => {
 const f = fakeHost();retainSlackRequest(f.host.storage, scope, request());const key = slackRequestStorageKey(scope), value = JSON.parse(f.storage.get(key)!) as Record<string, unknown>;
 f.storage.set(key, JSON.stringify({ ...value, selectedIndex: 9 }));expect(() => readSlackRequests(f.host.storage, scope)).toThrow();
 f.storage.set(key, JSON.stringify({ ...value, developerId: "b".repeat(64) }));expect(() => readSlackRequests(f.host.storage, scope)).toThrow();
});
it("never resends an expired or future-dated request even after a status 404", () => {
 expect(slackRequestCanResend(request(), at + 86399999)).toBe(true);expect(slackRequestCanResend(request(), at + 86400000)).toBe(false);expect(slackRequestCanResend(request(), at - 1)).toBe(false);
});
it("B34 proposal and approval recovery share the same ten-entry bound and UUID ownership with unlinks", async () => {
 const historyApi = await import("../../packages/ui/src/screens/admin/projects/project-slack-history.js"), f = fakeHost();
 retainSlackRequest(f.host.storage, scope, request(1));
 for (let n = 2; n <= 12; n++) historyApi.retainSlackBindRequest(f.host.storage, scope, { ...request(n), operation: "propose" });
 expect(f.storage.size).toBe(1);expect(readSlackRequests(f.host.storage, scope).requests).toHaveLength(0);expect(historyApi.readSlackBindRequests(f.host.storage, scope).requests).toHaveLength(10);
 expect(() => retainSlackRequest(f.host.storage, scope, request(12))).toThrow();
 expect(historyApi.selectSlackBindRequest(f.host.storage, scope, 0)).toMatchObject({ operation: "propose", body: { requestId: request(3).body.requestId } });
});
it("B34 approval resend also expires at its proposal deadline", async () => {
 const historyApi = await import("../../packages/ui/src/screens/admin/projects/project-slack-history.js"), f = fakeHost();
 const item = { operation: "approve" as const, reviewedAt: new Date(at).toISOString(), proposalExpiresAt: new Date(at + 60000).toISOString(), body: { expectedOrgId: scope.orgId, requestId: request().body.requestId, proposalId: request(2).body.requestId, teamId: "T0123456789", channelId: "C0123456789" } };
 historyApi.retainSlackBindRequest(f.host.storage, scope, item);expect(slackRequestCanResend(item, at + 59999)).toBe(true);expect(slackRequestCanResend(item, at + 60000)).toBe(false);
});
