// Decision journey slice 3b: the outside approval card's handler, for both kinds (`apr_`, `spr_`), over the confirmation page's own kind seam. It adds no authority: a token is refused, a stale sign-in asks
// again, an Auditor decides nothing, the kind's live evaluation decides who may, and the decision is the kind's own with the fresh sign-in as its proof.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { outsideCardHandler } from "../../packages/broker/src/aws/developer-routes/outside-cards.js";
import type { DecideInspection, DecideKind, DecideKinds } from "../../packages/broker/src/developer/decide-kinds.js";
import type { AuditProof } from "@agentx/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";

const PERSON = "b".repeat(64);
const VIEW = { title: "Raise the run limit to $20", facts: [{ label: "Amount", value: "$18" }] };

function world(inspection: DecideInspection, role: "member" | "auditor" = "member") {
  const db = new FakeDynamoDb();
  seedMembership(db, PERSON, { orgId: TEST_ORG, role });
  const session = (agoMs: number) => {
    const id = randomUUID();
    db.set({ pk: `SESSION#${id}`, sk: "META", sessionId: id, developerId: PERSON, amr: "oidc", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 600, authTime: new Date(Date.now() - agoMs).toISOString() });
    return id;
  };
  const decided: Array<{ approvalId: string; decision: string; proof: AuditProof }> = [];
  const opened: string[] = [];
  const kind: DecideKind = {
    inspect: async () => inspection,
    decide: async (target, decision, proof) => { decided.push({ approvalId: target.approvalId, decision, proof });return { message: "Done." }; },
    opened: async (target) => { opened.push(target.approvalId); },
  };
  const kinds: DecideKinds = { apr: kind, spr: kind };
  const deps = { documentClient: db, tableName: "state", developer: { signInTableName: "state" }, now: () => Date.now() } as never;
  const handler = outsideCardHandler(deps, kinds);
  const caller = (sessionId: string, browser = true) => ({ orgId: TEST_ORG, developerId: PERSON, sessionId, orgRole: "member", amr: "oidc", name: "Ben", ...(browser ? { browserSession: true as const } : {}) }) as never;
  const input = (approvalId: string) => ({ card: {} as never, item: { kind: "approve_request", subjectId: approvalId, prefix: approvalId.slice(0, 3) } as never, requestId: randomUUID() });
  return { handler, session, caller, input, decided, opened };
}

const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string }) => error.code);

describe.each(["apr_aaaaaaaaaaaaaaaaaaaa", "spr_aaaaaaaaaaaaaaaaaaaa"])("the outside approval card (%s)", (approvalId) => {
  it("allowed: from a browser after a recent sign-in, the kind decides, with the sign-in as its proof (and the card counts as the page that was read)", async () => {
    const w = world({ status: "open", view: VIEW });
    expect(await w.handler.approve(w.caller(w.session(0)), w.input(approvalId))).toEqual({ kind: "done" });
    expect(w.decided).toEqual([{ approvalId, decision: "approve", proof: expect.objectContaining({ kind: "fresh_sign_in", method: "email_code" }) as unknown }]);
    expect(w.opened).toEqual([approvalId]);
    expect(await w.handler.reject!(w.caller(w.session(0)), { ...w.input(approvalId), reason: "other" })).toEqual({ kind: "done" });
    expect(w.decided.at(-1)).toMatchObject({ decision: "decline" });
  });
  it("not allowed: the kind's live evaluation says so, and nothing is decided", async () => {
    const w = world({ status: "forbidden", who: "a project maintainer" });
    expect(await w.handler.approve(w.caller(w.session(0)), w.input(approvalId))).toEqual({ kind: "refused", reason: "forbidden" });
    expect(w.decided).toEqual([]);
  });
  it("already decided or expired: stale, and nothing is decided", async () => {
    for (const inspection of [{ status: "decided", by: "Ada", at: "2026-11-06T10:00:00.000Z" }, { status: "expired", at: "2026-11-06T10:00:00.000Z" }, { status: "not_found" }] as DecideInspection[]) {
      const w = world(inspection);
      expect(await w.handler.approve(w.caller(w.session(0)), w.input(approvalId))).toEqual({ kind: "refused", reason: "stale" });
      expect(w.decided).toEqual([]);
    }
  });
  it("a stale sign-in asks to sign in again; a token is refused; an Auditor decides nothing", async () => {
    const open: DecideInspection = { status: "open", view: VIEW };
    const stale = world(open);
    expect(await failure(stale.handler.approve(stale.caller(stale.session(20 * 60_000)), stale.input(approvalId)))).toBe("REAUTH_REQUIRED");
    const token = world(open);
    expect(await token.handler.approve(token.caller(token.session(0), false), token.input(approvalId))).toEqual({ kind: "refused", reason: "forbidden" });
    const auditor = world(open, "auditor");
    expect(await auditor.handler.approve(auditor.caller(auditor.session(0)), auditor.input(approvalId))).toEqual({ kind: "refused", reason: "forbidden" });
    expect([...stale.decided, ...token.decided, ...auditor.decided]).toEqual([]);
  });
});
