// The decide-grade sign-in in tests: what the decide sign-in's callback writes (decide-signin.ts) for one approval after an email code from a clean sign-in, and the approval a card's
// REAUTH_REQUIRED (reason `decide_sign_in`) made that sign-in for.
import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import { DECIDE_COOKIE, DecideStore, decideProofOf } from "../../packages/broker/src/developer/decide-session.js";
import { TEST_ORG } from "./orgs.js";

/** Writes a decide session for `approvalId`, as the email-code callback does, and returns the browser cookie and the proof the decision must carry. */
export async function decideSessionFor(db: unknown, developerId: string, approvalId: string, options: { tableName?: string; orgId?: string; agoSeconds?: number } = {}): Promise<{ cookie: string; proof: ReturnType<typeof decideProofOf> }> {
  const value = `${randomUUID()}-${"x".repeat(20)}`;
  const signedInAt = Math.floor(Date.now() / 1000) - (options.agoSeconds ?? 30);
  const session = { orgId: (options.orgId ?? TEST_ORG) as never, developerId, approvalId, signedInAt, method: "email_code" as const, csrfHash: "h".repeat(64), expiresAt: signedInAt + 600 };
  await new DecideStore({ documentClient: db as never, tableName: options.tableName ?? "signin", now: () => Date.now() }).putSession(value, session);
  return { cookie: `${DECIDE_COOKIE}=${value}`, proof: decideProofOf(value, session) };
}

/** The `card_decision` approval a high card's REAUTH_REQUIRED made: from its decide sign-in link, which must return to that approval. */
export function signInApprovalOf(body: unknown): string {
  const error = (body as { error?: { code?: string; reason?: string; signInUrl?: string } }).error;
  expect(error).toMatchObject({ code: "REAUTH_REQUIRED", reason: "decide_sign_in" });
  const url = new URL(error!.signInUrl!, "https://cell.example");
  expect(url.pathname).toBe("/v1/auth/decide/identify");
  const back = /^\/v1\/app\/approve\/(apr_[0-9a-z]{20})$/u.exec(url.searchParams.get("return") ?? "");
  expect(back, "the decide sign-in returns to the approval it was made for").not.toBeNull();
  return back![1]!;
}
