import { expect, it, vi } from "vitest";
import { developerOrgKey, orgMemberKey, orgMetaKey, type OrgId } from "@agentx/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
const orgId = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId, developerId = "a".repeat(64), now = Date.parse("2026-10-30T14:30:00Z");
function fixture() {
 const db = new FakeDynamoDb();db.set({ ...orgMetaKey(orgId), orgId });db.set({ ...orgMemberKey(orgId, developerId), orgId, developerId, role: "owner" });db.set({ ...developerOrgKey(developerId), orgId, role: "owner" });db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, provider: "cloud", revoked: false });
 let calls = 0;const deps = { documentClient: db, tableName: "state", signInTableName: "signin", now: () => now, runtimeStatus: async () => { calls++;return { rows: [], malformedKinds: [] as string[] }; } };
 return { db, deps, caller: { orgId, developerId, browserSession: true as const }, calls: () => calls };
}
for (const mode of ["bearer", "member", "revoked", "company", "pointer", "closed"]) it(`B35 ${mode} refuses without runtime reads`, async () => {
 const { readOrgServiceStatus } = await import("../../packages/broker/src/org/service-status.js"), f = fixture();
 if (mode === "member") f.db.set({ ...orgMemberKey(orgId, developerId), orgId, developerId, role: "member" });
 if (mode === "revoked") f.db.set({ pk: `DEVELOPER#${developerId}`, sk: "META", developerId, revoked: true });
 if (mode === "pointer") f.db.set({ ...developerOrgKey(developerId), orgId: "org_bbbbbbbbbbbbbbbbbbbb", role: "owner" });
 if (mode === "closed") f.db.set({ ...orgMetaKey(orgId), orgId, closedAt: new Date(now).toISOString() });
 await expect(readOrgServiceStatus(f.deps, mode === "bearer" ? { orgId, developerId } : f.caller, { expectedOrgId: mode === "company" ? "org_bbbbbbbbbbbbbbbbbbbb" : orgId })).rejects.toBeDefined();expect(f.calls()).toBe(0);
});
it("B35 rechecks live company authority after evidence", async () => {
 const { readOrgServiceStatus } = await import("../../packages/broker/src/org/service-status.js"), f = fixture();f.deps.runtimeStatus = async () => { f.db.set({ ...orgMetaKey(orgId), orgId, closingAt: new Date(now).toISOString() });return { rows: [], malformedKinds: [] }; };
 await expect(readOrgServiceStatus(f.deps, f.caller, { expectedOrgId: orgId })).rejects.toMatchObject({ code: "FORBIDDEN" });
});
it("B35 reads stop at thirty per person before runtime evidence", async () => {
 const { readOrgServiceStatus } = await import("../../packages/broker/src/org/service-status.js"), f = fixture();for (let n = 0; n < 30; n++) await readOrgServiceStatus(f.deps, f.caller, { expectedOrgId: orgId });
 await expect(readOrgServiceStatus(f.deps, f.caller, { expectedOrgId: orgId })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });expect(f.calls()).toBe(30);
});

it("B35 a timed-out stored read returns fixed unknowns and ignores a late result", async () => {
 vi.useFakeTimers();try {
  const { readOrgServiceStatus } = await import("../../packages/broker/src/org/service-status.js"), f = fixture();let finish: ((value: { rows: never[]; malformedKinds: string[] }) => void) | undefined;
  f.deps.runtimeStatus = () => new Promise(resolve => { finish = resolve; });
  const pending = readOrgServiceStatus(f.deps, f.caller, { expectedOrgId: orgId });await vi.advanceTimersByTimeAsync(5001);
  const result = await pending;expect(result.checks.every(row => row.observation === "unknown" && row.reason === "unavailable")).toBe(true);
  finish?.({ rows: [], malformedKinds: [] });expect(result.checks[0]?.reason).toBe("unavailable");
 } finally { vi.useRealTimers(); }
});
it("B35 company budget caps combined reads from different live admins at 120", async () => {
 const { readOrgServiceStatus } = await import("../../packages/broker/src/org/service-status.js"), f = fixture();
 for (const letter of ["a", "b", "c", "d", "e"]) {
  const id = letter.repeat(64);f.db.set({ ...orgMemberKey(orgId, id), orgId, developerId: id, role: "admin" });f.db.set({ ...developerOrgKey(id), orgId, role: "admin" });f.db.set({ pk: `DEVELOPER#${id}`, sk: "META", developerId: id, provider: "cloud", revoked: false });
  const caller = { ...f.caller, developerId: id };if (letter === "e") await expect(readOrgServiceStatus(f.deps, caller, { expectedOrgId: orgId })).rejects.toMatchObject({ code: "TOO_MANY_REQUESTS" });
  else for (let n = 0; n < 30; n++) await readOrgServiceStatus(f.deps, caller, { expectedOrgId: orgId });
 }expect(f.calls()).toBe(120);
});
