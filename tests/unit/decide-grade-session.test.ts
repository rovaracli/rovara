// The decide-grade sign-in rule (`isDecideGradeSession`, card-decide-grade.ts), one clause at a time: the live card press and the Approvers adapter's browser-step-up both use it, so each clause is pinned here.
import { describe, expect, it } from "vitest";
import { isDecideGradeSession } from "../../packages/broker/src/aws/developer-routes/card-decide-grade.js";
import type { DecideSession } from "../../packages/broker/src/developer/decide-session.js";

const NOW = 1_800_000_000;
const WHO = { orgId: "org_aaaaaaaaaaaaaaaaaaaa", developerId: "a".repeat(64) };
const session = (over: Partial<DecideSession> = {}): DecideSession => ({ orgId: WHO.orgId, developerId: WHO.developerId, approvalId: "apr_00000000000000000000", signedInAt: NOW - 60, method: "email_code", csrfHash: "x", expiresAt: NOW + 540, ...over });

describe("the decide-grade sign-in", () => {
  it("is this person's unused email-code session in their company, unexpired and at most ten minutes old", () => {
    expect(isDecideGradeSession(session(), WHO, NOW)).toBe(true);
    expect(isDecideGradeSession(session({ signedInAt: NOW - 600, expiresAt: NOW + 1 }), WHO, NOW)).toBe(true);
  });

  it("refuses each clause on its own", () => {
    expect(isDecideGradeSession(undefined, WHO, NOW)).toBe(false);
    expect(isDecideGradeSession(session({ usedAt: "2026-11-11T00:00:00.000Z" }), WHO, NOW)).toBe(false);
    expect(isDecideGradeSession(session({ orgId: "org_bbbbbbbbbbbbbbbbbbbb" }), WHO, NOW)).toBe(false);
    expect(isDecideGradeSession(session({ developerId: "b".repeat(64) }), WHO, NOW)).toBe(false);
    expect(isDecideGradeSession(session({ method: "password" as never }), WHO, NOW)).toBe(false);
    expect(isDecideGradeSession(session({ expiresAt: NOW }), WHO, NOW)).toBe(false);
    // Signed in eleven minutes ago, with an expiry someone stretched: the age rule still refuses it.
    expect(isDecideGradeSession(session({ signedInAt: NOW - 601, expiresAt: NOW + 600 }), WHO, NOW)).toBe(false);
  });
});
