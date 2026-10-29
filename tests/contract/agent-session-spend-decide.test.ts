// Plan 5 Task 5: a session shows a budget request's link only to a person who may decide it NOW. `mayDecideSpendRequest` is false for a request that has
// run out its time and for one that is already decided, even for an approver who could have decided it while it was open.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { BudgetScope } from "@agentx/contracts";
import { createSpendRequest, decideSpendRequest, mayDecideSpendRequest } from "../../packages/broker/src/spend/requests.js";
import { effectiveLimits } from "../../packages/broker/src/spend/settings.js";
import { MAYA } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { ADA, BEN, month, setup } from "../support/spend-world.js";

const MEMBER: BudgetScope = { kind: "member", developerId: MAYA.developerId };

async function openRequest(t: Awaited<ReturnType<typeof setup>>) {
  const limit = (await effectiveLimits({ documentClient: t.db, tableName: "state", cloud: true }, { orgId: TEST_ORG, month: month(), scopes: [MEMBER] })).get(`MEMBER#${MAYA.developerId}`)!;
  return (await createSpendRequest(t.deps(), {
    orgId: TEST_ORG, kind: "month", scope: MEMBER, subject: `MONTH#${month()}#MEMBER#${MAYA.developerId}#system#${randomUUID()}`, amountUsd: 10, newLimitUsd: limit + 10,
    reason: "More for this month, please.", requestedBy: { kind: "system" },
  })).record;
}
const asker = (who: { developerId: string }) => ({ orgId: TEST_ORG, developerId: who.developerId });

describe("mayDecideSpendRequest", () => {
  it("is true for an approver of an open request, and false for someone who isn't one and for a request that isn't there", async () => {
    const t = await setup();
    const request = await openRequest(t);
    expect(await mayDecideSpendRequest(t.deps(), asker(ADA), request.spendRequestId)).toBe(true);
    expect(await mayDecideSpendRequest(t.deps(), asker(MAYA), request.spendRequestId)).toBe(false);
    expect(await mayDecideSpendRequest(t.deps(), asker(ADA), "spr_00000000000000000000")).toBe(false);
    expect(await mayDecideSpendRequest(t.deps(), asker(ADA), "not-an-id")).toBe(false);
  });

  it("is false once the request has run out its time", async () => {
    const t = await setup();
    const request = await openRequest(t);
    const later = Date.parse(request.expiresAt) + 1000;
    expect(await mayDecideSpendRequest(t.deps(() => Date.parse(request.expiresAt) - 1000), asker(ADA), request.spendRequestId)).toBe(true);
    expect(await mayDecideSpendRequest(t.deps(() => later), asker(ADA), request.spendRequestId)).toBe(false);
    expect(await mayDecideSpendRequest(t.deps(() => Date.parse(request.expiresAt)), asker(ADA), request.spendRequestId)).toBe(false);
  });

  it("is false once the request has been decided", async () => {
    const t = await setup();
    const request = await openRequest(t);
    await decideSpendRequest(t.deps(), t.caller(ADA, "owner"), request.spendRequestId, { requestId: randomUUID(), decision: "DENY" });
    expect(await mayDecideSpendRequest(t.deps(), asker(BEN), request.spendRequestId)).toBe(false);
    expect(await mayDecideSpendRequest(t.deps(), asker(ADA), request.spendRequestId)).toBe(false);
  });
});
