// Security review follow-up (2026-11-06): the `card_decision` record a high design or plan card makes for its decide-grade sign-in. Only the person who pressed may decide it, it is never a card of its
// own, and the decide sign-in for it comes back to the card on its task page (decide-web), for the browser holding the decide session for that very record.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createPendingChange, getAnyApproval } from "../../packages/broker/src/agents/approvals.js";
import { CARD_DECISION_RULE } from "../../packages/broker/src/aws/developer-routes/card-decide-grade.js";
import { routeDecidePage } from "../../packages/broker/src/aws/decide-web.js";
import { DECIDE_COOKIE, csrfTokenFor } from "../../packages/broker/src/developer/decide-session.js";
import { ARJUN, CELL, PRIYA } from "../support/agent-session-world.js";
import { mergeWorld } from "../support/rovara-code-merge-world.js";

describe("the card_decision record of a high card's decide-grade sign-in", () => {
  beforeEach(() => { process.env.DECISION_CARDS_ENABLED = "1"; });
  afterEach(() => { delete process.env.DECISION_CARDS_ENABLED; });

  async function made() {
    const w = mergeWorld();
    const cardId = `approve_plan:${w.taskId}`;
    const returnPath = `/app/sessions/ses_${"a".repeat(20)}?decision=${encodeURIComponent(cardId)}`;
    const record = await createPendingChange(w.deps, {
      orgId: w.orgId, requestId: randomUUID(), requestedBy: PRIYA, subject: { kind: "card_decision", taskId: w.taskId, cardId, contentVersion: "v1", returnPath },
      changes: ["Confirm the high-risk decision you pressed Approve on."], approvers: { kind: "rule", rule: CARD_DECISION_RULE, candidates: [] },
    });
    return { w, record, returnPath };
  }
  const open = (w: ReturnType<typeof mergeWorld>, approvalId: string, cookie?: string) => routeDecidePage(w.context(), { method: "GET", headers: cookie === undefined ? {} : { cookie: `${DECIDE_COOKIE}=${cookie}` }, body: undefined } as never, new URL(`https://cell.example/v1/app/approve/${approvalId}`));

  it("only the person who pressed may decide it; the decide sign-in returns to the card on the task page, for the browser holding that record's decide session only", async () => {
    const { w, record, returnPath } = await made();
    expect((await w.kind.inspect({ orgId: w.orgId, developerId: PRIYA, approvalId: record.approvalId })).status).toBe("open");
    expect((await w.kind.inspect({ orgId: w.orgId, developerId: ARJUN, approvalId: record.approvalId })).status).toBe("forbidden");
    expect(await w.kind.returnPath?.({ orgId: w.orgId, developerId: ARJUN, approvalId: record.approvalId })).toBeUndefined();
    // Back from the email-code sign-in (the callback wrote the session for this record): the task page, focused on the card.
    expect(await open(w, record.approvalId, await w.browser(PRIYA, record.approvalId))).toMatchObject({ statusCode: 302, headers: { location: returnPath } });
    // No decide session, or one for another approval: the approval's own card-only page, as before.
    expect(await open(w, record.approvalId)).toMatchObject({ statusCode: 302, headers: { location: `/app/decisions/approve_request/${record.approvalId}` } });
    expect(await open(w, record.approvalId, await w.browser(PRIYA, `apr_${"b".repeat(20)}`))).toMatchObject({ statusCode: 302, headers: { location: `/app/decisions/approve_request/${record.approvalId}` } });
  });

  it("final review: with the cards OFF the decide sign-in still returns to the task page, and the confirmation page never decides a card_decision (its Approve would spend the session)", async () => {
    delete process.env.DECISION_CARDS_ENABLED;
    const { w, record, returnPath } = await made();
    const cookie = await w.browser(PRIYA, record.approvalId);
    expect(await open(w, record.approvalId, cookie)).toMatchObject({ statusCode: 302, headers: { location: returnPath } });
    const posted = await routeDecidePage(w.context(), {
      method: "POST", path: `/v1/app/approve/${record.approvalId}`, requestId: "r",
      headers: { cookie: `${DECIDE_COOKIE}=${cookie}`, origin: CELL, "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ decision: "approve", csrf: csrfTokenFor(cookie) }).toString(),
    }, new URL(`${CELL}/v1/app/approve/${record.approvalId}`));
    expect(posted.statusCode).toBe(409);
    expect(posted.body).toContain("Decide this on its card in the task.");
    expect((await getAnyApproval(w.deps, w.orgId, record.approvalId))?.status, "nothing was decided").toBe("PENDING");
  });

  it("a record whose return is not a task page is never followed", async () => {
    const w = mergeWorld();
    const record = await createPendingChange(w.deps, {
      orgId: w.orgId, requestId: randomUUID(), requestedBy: PRIYA, subject: { kind: "card_decision", taskId: w.taskId, cardId: `approve_plan:${w.taskId}`, contentVersion: "v1", returnPath: "https://evil.example/app/sessions/x" },
      changes: ["x"], approvers: { kind: "rule", rule: CARD_DECISION_RULE, candidates: [] },
    });
    expect(await open(w, record.approvalId, await w.browser(PRIYA, record.approvalId))).toMatchObject({ statusCode: 302, headers: { location: `/app/decisions/approve_request/${record.approvalId}` } });
  });
});
