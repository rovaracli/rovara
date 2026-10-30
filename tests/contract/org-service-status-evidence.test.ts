import { expect, it } from "vitest";
const now = Date.parse("2026-10-30T14:30:00Z");
const row = (hours = 72, state = "READY") => ({ kind: "web", profileId: "private-profile", state, qualifiedAt: new Date(now - 86400000).toISOString(), expiresAt: new Date(now + hours * 3600000).toISOString() });
for (const [hours, observation] of [[72, "qualified"], [48, "qualified"], [47, "warning"], [0, "expired"], [-1, "expired"]] as const) it(`B35 stored expiry ${hours}h is ${observation}`, async () => {
 const { projectRuntimeStatus } = await import("../../packages/broker/src/org/service-status.js");const result = projectRuntimeStatus({ rows: [row(hours)], malformedKinds: [] }, now);
 expect(result[0]).toMatchObject({ kind: "web", state: "ready", observation });expect(JSON.stringify(result)).not.toMatch(/private-profile|qualifiedAt|renewCommand|--apply/);
});
it("B35 absent and malformed rows are distinct unknown observations", async () => {
 const { projectRuntimeStatus } = await import("../../packages/broker/src/org/service-status.js");
 expect(projectRuntimeStatus({ rows: [], malformedKinds: [] }, now)[0]).toMatchObject({ observation: "unknown", reason: "not_observed" });
 expect(projectRuntimeStatus({ rows: [], malformedKinds: ["web"] }, now)[0]).toMatchObject({ observation: "unknown", reason: "invalid_evidence" });
});
for (const change of ["future", "reversed", "state", "duplicate"] as const) it(`B35 ${change} stored evidence is never qualified`, async () => {
 const { projectRuntimeStatus } = await import("../../packages/broker/src/org/service-status.js");const value = row();
 if (change === "future") value.qualifiedAt = new Date(now + 1000).toISOString();
 if (change === "reversed") value.expiresAt = value.qualifiedAt;
 if (change === "state") value.state = "private-state";
 const result = projectRuntimeStatus({ rows: change === "duplicate" ? [value, value] : [value], malformedKinds: [] }, now);expect(result[0]).toMatchObject({ state: "unknown", observation: "unknown", reason: "invalid_evidence" });expect(JSON.stringify(result)).not.toContain("private-state");
});
