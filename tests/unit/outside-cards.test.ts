// Decision journey slice 3b (security review 2026-11-06): the outside approval card's handler, for both kinds (`apr_`, `spr_`), over the confirmation page's own kind seam and its decide-grade sign-in.
// It adds no authority and asks for no less: a token is refused; a fresh web sign-in of any method (GitHub included) is NOT enough, only a decide session (an email code from a clean sign-in, for this
// approval, this member, unused, within 10 minutes); an Auditor decides nothing; the kind's live evaluation decides who may; the decision is the kind's own with the decide session's proof (its real method).
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { outsideCardHandler, outsideEvidenceOpened } from "../../packages/broker/src/aws/developer-routes/outside-cards.js";
import { DecideStore } from "../../packages/broker/src/developer/decide-session.js";
import type { DecideInspection, DecideKind, DecideKinds } from "../../packages/broker/src/developer/decide-kinds.js";
import type { AuditProof } from "@agentx/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const PERSON = "b".repeat(64);
const VIEW = { title: "Raise the run limit to $20", facts: [{ label: "Amount", value: "$18" }] };

function world(inspection: DecideInspection, role: "member" | "auditor" = "member", options: { decideThrows?: boolean } = {}) {
  const db = new FakeDynamoDb();
  seedMembership(db, PERSON, { orgId: TEST_ORG, role });
  const store = new DecideStore({ documentClient: db, tableName: "state", now: () => Date.now() });
  /** A web session signed in `agoMs` ago with `amr` (GitHub, Google, SAML): never decide-grade on its own. */
  const webSession = (agoMs: number, amr = "github") => {
    const id = randomUUID();
    db.set({ pk: `SESSION#${id}`, sk: "META", sessionId: id, developerId: PERSON, amr, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, authTime: new Date(Date.now() - agoMs).toISOString() });
    return id;
  };
  /** A decide session, as decide-signin writes it after an email-code sign-in from a clean sign-in. */
  const decideSession = async (approvalId: string, extra: { agoSeconds?: number; developerId?: string } = {}) => {
    const cookie = `cookie-${randomUUID()}-${"x".repeat(20)}`;
    const signedInAt = Math.floor(Date.now() / 1000) - (extra.agoSeconds ?? 30);
    await store.putSession(cookie, { orgId: TEST_ORG, developerId: extra.developerId ?? PERSON, approvalId, signedInAt, method: "email_code", csrfHash: "h".repeat(64), expiresAt: signedInAt + 600 });
    return cookie;
  };
  const decided: Array<{ approvalId: string; decision: string; proof: AuditProof }> = [];
  const opened: string[] = [];
  const kind: DecideKind = {
    inspect: async () => inspection,
    decide: async (target, decision, proof) => { if (options.decideThrows === true) throw new Error("apply failed"); decided.push({ approvalId: target.approvalId, decision, proof });return { message: "Done." }; },
    opened: async (target) => { opened.push(target.approvalId); },
  };
  const kinds: DecideKinds = { apr: kind, spr: kind };
  const deps = { documentClient: db, tableName: "state", developer: { signInTableName: "state" }, now: () => Date.now() } as never;
  const handlerFor = (cookie: string | undefined) => outsideCardHandler(deps, kinds, { cookie, store, now: () => Date.now() });
  const caller = (browser = true) => ({ orgId: TEST_ORG, developerId: PERSON, sessionId: webSession(0), orgRole: "member", amr: "github", name: "Ben", ...(browser ? { browserSession: true as const } : {}) }) as never;
  const input = (approvalId: string) => ({ card: {} as never, item: { kind: "approve_request", subjectId: approvalId, prefix: approvalId.slice(0, 3) } as never, requestId: randomUUID() });
  return { handlerFor, decideSession, caller, input, decided, opened, store, kinds };
}

const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code);

describe.each(["apr_aaaaaaaaaaaaaaaaaaaa", "spr_aaaaaaaaaaaaaaaaaaaa"])("the outside approval card (%s)", (approvalId) => {
  it("allowed only with the decide-grade sign-in; the proof is the decide session's, with its real method; the session is spent", async () => {
    const w = world({ status: "open", view: VIEW });
    const cookie = await w.decideSession(approvalId);
    expect(await w.handlerFor(cookie).approve(w.caller(), w.input(approvalId))).toEqual({ kind: "done" });
    expect(w.decided).toEqual([{ approvalId, decision: "approve", proof: expect.objectContaining({ kind: "fresh_sign_in", method: "email_code", sessionRef: expect.stringMatching(/^[0-9a-f]{64}$/u) as unknown }) as unknown }]);
    expect(await w.store.getSession(cookie)).toBeUndefined();
    // The same cookie again: spent, so a new decide sign-in is asked for.
    expect(await failure(w.handlerFor(cookie).approve(w.caller(), w.input(approvalId)))).toBe("REAUTH_REQUIRED");
    const decline = await w.decideSession(approvalId);
    expect(await w.handlerFor(decline).reject!(w.caller(), { ...w.input(approvalId), reason: "other" })).toEqual({ kind: "done" });
    expect(w.decided.at(-1)).toMatchObject({ decision: "decline" });
  });
  it("a fresh web sign-in of any method (GitHub, Google, SAML) is not decide-grade: REAUTH_REQUIRED, nothing decided", async () => {
    const w = world({ status: "open", view: VIEW });
    expect(await failure(w.handlerFor(undefined).approve(w.caller(), w.input(approvalId)))).toBe("REAUTH_REQUIRED");
    expect(w.decided).toEqual([]);
  });
  it("a decide session for another approval, another member, or older than 10 minutes is not enough", async () => {
    const w = world({ status: "open", view: VIEW });
    const other = await w.decideSession(approvalId.slice(0, 4) + "b".repeat(20));
    const someoneElse = await w.decideSession(approvalId, { developerId: "c".repeat(64) });
    const old = await w.decideSession(approvalId, { agoSeconds: 20 * 60 });
    for (const cookie of [other, someoneElse, old]) expect(await failure(w.handlerFor(cookie).approve(w.caller(), w.input(approvalId)))).toBe("REAUTH_REQUIRED");
    expect(w.decided).toEqual([]);
  });
  it("not allowed or no longer open: the kind's live evaluation says so, nothing is decided, and the decide session is kept", async () => {
    for (const [inspection, reason] of [[{ status: "forbidden", who: "a project maintainer" }, "forbidden"], [{ status: "decided", by: "Ada", at: "2026-11-06T10:00:00.000Z" }, "stale"], [{ status: "expired", at: "2026-11-06T10:00:00.000Z" }, "stale"], [{ status: "not_found" }, "stale"]] as const) {
      const w = world(inspection);
      const cookie = await w.decideSession(approvalId);
      expect(await w.handlerFor(cookie).approve(w.caller(), w.input(approvalId))).toEqual({ kind: "refused", reason });
      expect(w.decided).toEqual([]);
      expect(await w.store.getSession(cookie)).toMatchObject({ approvalId });
    }
  });
  it("a token is refused; an Auditor decides nothing; a decision that fails gives the decide session back", async () => {
    const open: DecideInspection = { status: "open", view: VIEW };
    const token = world(open);
    expect(await token.handlerFor(await token.decideSession(approvalId)).approve(token.caller(false), token.input(approvalId))).toEqual({ kind: "refused", reason: "forbidden" });
    const auditor = world(open, "auditor");
    expect(await auditor.handlerFor(await auditor.decideSession(approvalId)).approve(auditor.caller(), auditor.input(approvalId))).toEqual({ kind: "refused", reason: "forbidden" });
    const failing = world(open, "member", { decideThrows: true });
    const cookie = await failing.decideSession(approvalId);
    await expect(failing.handlerFor(cookie).approve(failing.caller(), failing.input(approvalId))).rejects.toThrow("apply failed");
    expect(await failing.store.getSession(cookie)).toMatchObject({ approvalId });
    expect((await failing.store.getSession(cookie))?.usedAt).toBeUndefined();
    expect([...token.decided, ...auditor.decided]).toEqual([]);
  });
  it("the kind records its page as read when the card's evidence is opened, never at the press, and only while this person may still decide it", async () => {
    const w = world({ status: "open", view: VIEW });
    await w.handlerFor(await w.decideSession(approvalId)).approve(w.caller(), w.input(approvalId));
    expect(w.opened).toEqual([]);
    await outsideEvidenceOpened(w.kinds, w.caller(), approvalId);
    expect(w.opened).toEqual([approvalId]);
    const closed = world({ status: "forbidden", who: "someone" });
    await outsideEvidenceOpened(closed.kinds, closed.caller(), approvalId);
    expect(closed.opened).toEqual([]);
  });
});
