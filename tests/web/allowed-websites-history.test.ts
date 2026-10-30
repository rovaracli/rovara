import { expect, it } from "vitest";
import { readWebsiteRequests, retainWebsiteRequest, selectWebsiteRequest, websiteRequestStorageKey } from "../../packages/ui/src/screens/admin/projects/allowed-websites-history.js";
const scope = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64), project: "payments" };
const attempt = (n = 1) => ({ operation: "save" as const, body: { expectedOrgId: scope.orgId, requestId: `${String(n).padStart(8, "0")}-1111-4111-8111-111111111111`, expectedRevision: 1, expectedContextDigest: "a".repeat(64), allowedDomains: [] } });
function storage() { const values = new Map<string, string>();return { values, get: (key: string) => values.get(key), set: (key: string, value: string) => { values.set(key, value); } }; }
it("retains UUID and exact normalized body with checked readback in one scoped key", () => {
 const s = storage();retainWebsiteRequest(s, scope, attempt());const history = readWebsiteRequests(s, scope);
 expect(history.requests).toEqual([attempt()]);expect(history.selectedIndex).toBe(0);expect([...s.values.keys()]).toEqual([websiteRequestStorageKey(scope)]);
});
it("caps history at ten requests and validates a selected historical index", () => {
 const s = storage();for (let n = 1; n <= 12; n += 1) retainWebsiteRequest(s, scope, attempt(n));
 const history = readWebsiteRequests(s, scope);expect(history.requests).toHaveLength(10);expect(history.requests[0]?.body.requestId).toBe(attempt(3).body.requestId);
 expect(selectWebsiteRequest(s, scope, 0)).toEqual(attempt(3));expect(readWebsiteRequests(s, scope).selectedIndex).toBe(0);expect(() => selectWebsiteRequest(s, scope, -1)).toThrow();expect(() => selectWebsiteRequest(s, scope, 10)).toThrow();
});
it("same UUID/body selects its prior entry but different bodies cannot reuse it", () => {
 const s = storage();retainWebsiteRequest(s, scope, attempt());retainWebsiteRequest(s, scope, attempt());expect(readWebsiteRequests(s, scope).requests).toHaveLength(1);
 expect(() => retainWebsiteRequest(s, scope, { ...attempt(), body: { ...attempt().body, allowedDomains: ["different.acme.dev"] } })).toThrow();
});
it("failed or altered storage readback refuses retention before a request can be sent", () => {
 const s = storage();expect(() => retainWebsiteRequest({ get: s.get, set: () => undefined }, scope, attempt())).toThrow();
 expect(() => retainWebsiteRequest({ get: s.get, set: (key: string) => s.set(key, "tampered") }, scope, attempt())).toThrow();
});
it("foreign scope, extra body fields and invalid selected indexes fail closed", () => {
 const s = storage();retainWebsiteRequest(s, scope, attempt());const key = websiteRequestStorageKey(scope), valid = s.get(key)!;
 for (const mutate of [(v: Record<string, unknown>) => ({ ...v, developerId: "b".repeat(64) }), (v: Record<string, unknown>) => ({ ...v, selectedIndex: 99 }), (v: Record<string, unknown>) => ({ ...v, requests: [{ ...attempt(), body: { ...attempt().body, definition: {} } }] })]) {
  s.set(key, JSON.stringify(mutate(JSON.parse(valid) as Record<string, unknown>)));expect(() => readWebsiteRequests(s, scope)).toThrow();
 }
});
it("another person or company never loads a previous person's request body", () => {
 const s = storage();retainWebsiteRequest(s, scope, attempt());expect(readWebsiteRequests(s, { ...scope, developerId: "b".repeat(64) }).requests).toEqual([]);
 expect(readWebsiteRequests(s, { ...scope, orgId: "org_bbbbbbbbbbbbbbbbbbbb" }).requests).toEqual([]);
});
it("retains approval and rejection bodies without losing the reviewed proposal or acknowledgement", () => {
 const s = storage(), proposalId = attempt(8).body.requestId;
 const approval = { operation: "approve" as const, proposalId, body: { expectedOrgId: scope.orgId, requestId: attempt(9).body.requestId, soleOwnerAcknowledged: true } };
 const rejection = { operation: "reject" as const, proposalId, body: { expectedOrgId: scope.orgId, requestId: attempt(10).body.requestId, reason: "  No longer needed  " } };
 retainWebsiteRequest(s, scope, approval);retainWebsiteRequest(s, scope, rejection);
 expect(readWebsiteRequests(s, scope).requests).toEqual([approval, { ...rejection, body: { ...rejection.body, reason: "No longer needed" } }]);
});
