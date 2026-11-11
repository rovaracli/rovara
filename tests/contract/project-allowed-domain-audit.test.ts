import { describe, expect, it } from "vitest";
import { AuditEventInputSchema } from "../../packages/cloud-contracts/src/audit.js";
import { auditProjectAllowedDomains } from "../../packages/broker/src/audit/allowed-domains.js";

const base = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", actor: { kind: "member" as const, id: "a".repeat(64) }, occurredAt: "2026-10-29T21:00:00.000Z", occurrence: "request1", projectName: "payments", requestId: "11111111-1111-4111-8111-111111111111", proposalId: "22222222-2222-4222-8222-222222222222", fromRevision: 1, toRevision: 2, added: 50, removed: 50, beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64) };
describe("allowed-domain summary audit", () => {
 it.each(["proposed", "rejected", "cancelled", "changed"] as const)("records the approved %s vocabulary without domain strings in permanent facts", action => {
  const event = auditProjectAllowedDomains({ ...base, action, ...(action === "changed" ? { mode: "second_person" as const } : {}) });
  expect(AuditEventInputSchema.safeParse(event).success).toBe(true);
  expect(event.action).toBe(`project.allowed_domains_${action}`);
  expect(event.facts).toMatchObject({ fromRevision: 1, toRevision: 2, added: 50, removed: 50 });
  expect(event.facts).not.toHaveProperty("beforeDigest");expect(event.facts).not.toHaveProperty("afterDigest");
  expect(event.details).toEqual([{ subject: "org", fields: { beforeDigest: "a".repeat(64), afterDigest: "b".repeat(64) } }]);
 });
 it.each(["initial", "direct_narrowing", "second_person", "sole_owner_exception"] as const)("records the %s change mode", mode => {
  const event = auditProjectAllowedDomains({ ...base, action: "changed", mode });
  expect(AuditEventInputSchema.parse(event).facts?.mode).toBe(mode);
 });
 it("keeps occurrence identity stable on replay and distinct on a fresh request", () => {
  const event = auditProjectAllowedDomains({ ...base, action: "changed", mode: "second_person" });
  expect(auditProjectAllowedDomains({ ...base, action: "changed", mode: "second_person" }).eventId).toBe(event.eventId);
  expect(auditProjectAllowedDomains({ ...base, occurrence: "request2", action: "changed", mode: "second_person" }).eventId).not.toBe(event.eventId);
 });
});
