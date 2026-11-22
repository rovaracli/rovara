// @vitest-environment jsdom
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import "./support/render.js";
import { DecisionCardsViewReaderSchema, DecisionOutcomeReaderSchema } from "@agentx/contracts/web";
import { createDecisionsApi, readDecisions } from "../../packages/ui/src/api/decisions.js";
import { createApiClient } from "../../packages/ui/src/api/client.js";
import { createDesignReviewApi } from "../../packages/ui/src/api/design-review.js";
import { fakeHost } from "./support/fake-host.js";
import { meFixture } from "./support/fixtures.js";
const fixture = JSON.parse(readFileSync("tests/fixtures/code-decision-cards.json", "utf8")) as { views: Record<string, unknown> };
it.each(["changes", "reject"])("R3/R6a: a %s result still waiting for confirmation retains its shared decision lock", async operation => {
 const decision = readDecisions(DecisionCardsViewReaderSchema.parse(fixture.views[operation === "reject" ? "approve_dependency" : "approve_plan_with_choices"]))[0]!;
 const me = meFixture(), identity = { orgId: me.org.orgId, developerId: me.developer.id };
 const f = fakeHost(async r => ({ status: 200, body: r.path === "/v1/app/me" ? me : { cardId: decision.card.id, outcome: "needs_confirmation", confirmUrl: "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa" } }));
 const send = () => operation === "changes" ? createDecisionsApi(f.host).requestChanges(decision, "Please add a regression") : createDecisionsApi(f.host).reject(decision, "not_now");
 expect(await send()).toMatchObject({ kind: "needs_confirmation" });
 expect(await createDecisionsApi(f.host).hasUnknownApproval(decision, identity)).toBe(true);
 await expect(send()).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
});
// A 202 needs_confirmation (the contract's "the person decides on its confirmation page") passes through the shared decision path with its frozen request; any other 202 is unknown.
it.each(["approve", "changes", "reject"])("a 202 needs_confirmation to %s passes through, retains the shared decision lock and sends once", async operation => {
 const decision = readDecisions(DecisionCardsViewReaderSchema.parse(fixture.views[operation === "reject" ? "approve_dependency" : "approve_plan_with_choices"]))[0]!;
 const me = meFixture(), identity = { orgId: me.org.orgId, developerId: me.developer.id }, confirmUrl = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : { status: 202, body: { cardId: decision.card.id, outcome: "needs_confirmation", confirmUrl } });
 const send = () => operation === "approve" ? createDecisionsApi(f.host).approve(decision, undefined, undefined, undefined, identity) : operation === "changes" ? createDecisionsApi(f.host).requestChanges(decision, "Please add a regression") : createDecisionsApi(f.host).reject(decision, "not_now");
 expect(await send()).toMatchObject({ kind: "needs_confirmation", confirmUrl });
 expect(await createDecisionsApi(f.host).hasUnknownApproval(decision, identity)).toBe(true);
 await expect(send()).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
});
it.each(["changes", "reject"])("a 202 that is not a confirmation request for this card is unknown for %s", async operation => {
 const decision = readDecisions(DecisionCardsViewReaderSchema.parse(fixture.views[operation === "reject" ? "approve_dependency" : "approve_plan_with_choices"]))[0]!;
 for (const body of [{ cardId: decision.card.id, outcome: "rejected", remainingTabs: [] }]) {
  const me = meFixture(), f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : { status: 202, body });
  await expect(operation === "changes" ? createDecisionsApi(f.host).requestChanges(decision, "Please add a regression") : createDecisionsApi(f.host).reject(decision, "not_now")).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
 }
});

// Published confirmation shapes remain pending only for callers explicitly opting in.
const confirmUrl = "https://cell.example/v1/app/approve/apr_aaaaaaaaaaaaaaaaaaaa";
const pendingBodies = [
 { cardId: "approve_plan:fixture", outcome: "needs_confirmation", confirmUrl },
 { status: "NEEDS_CONFIRMATION", confirmUrl, changes: [] },
 { status: "NEEDS_OWNER_APPROVAL", confirmUrl, changes: [] },
 { status: "NEEDS_ADMIN_APPROVAL", spendRequestId: "spr_aaaaaaaaaaaaaaaaaaaa", message: "An owner must approve this." },
];
it.each(pendingBodies)("the shared client preserves the documented confirmation input %# only with the decision option", async body => {
 const f = fakeHost(async () => ({ status: 202, body }));
 const client = createApiClient(f.host);
 const result = await client.send("POST", "/v1/app/decisions/fixture/approve", {}, DecisionOutcomeReaderSchema, { retry: "never", pendingIsUnknown: true, confirmationIsPending: true });
 expect(result).toMatchObject("outcome" in body ? { kind: "done", value: body } : { kind: body.status === "NEEDS_ADMIN_APPROVAL" ? "needs_admin_approval" : "needs_confirmation" });
 for (const option of [undefined, false]) await expect(client.send("POST", "/v1/app/tasks/fixture/answer", {}, DecisionOutcomeReaderSchema, { retry: "never", pendingIsUnknown: true, ...(option === undefined ? {} : { confirmationIsPending: option }) })).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
});
it.each([{}, { status: "FUTURE_APPROVAL" }, { cardId: "approve_plan:fixture", outcome: "approved", remainingTabs: [] }, { outcome: "needs_confirmation", confirmUrl }])("the shared client keeps an unknown or malformed 202 unknown %#", async body => {
 const f = fakeHost(async () => ({ status: 202, body }));
 await expect(createApiClient(f.host).send("POST", "/v1/app/decisions/fixture/approve", {}, DecisionOutcomeReaderSchema, { retry: "never", pendingIsUnknown: true, confirmationIsPending: true })).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
});
it("the shared client leaves callers without pendingIsUnknown unchanged", async () => {
 const f = fakeHost(async () => ({ status: 202, body: pendingBodies[1] }));
 expect(await createApiClient(f.host).send("POST", "/v1/app/agents/fixture", {}, DecisionOutcomeReaderSchema, { retry: "never" })).toMatchObject({ kind: "needs_confirmation", confirmUrl });
});
it.each(["approve", "changes", "reject"])("a confirmation naming another card stays unknown for %s at either accepted status", async operation => {
 for (const status of [200, 202]) {
  const decision = readDecisions(DecisionCardsViewReaderSchema.parse(fixture.views[operation === "reject" ? "approve_dependency" : "approve_plan_with_choices"]))[0]!;
  const me = meFixture(), identity = { orgId: me.org.orgId, developerId: me.developer.id };
  const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : { status, body: { cardId: "approve_plan:other", outcome: "needs_confirmation", confirmUrl } });
  const send = () => operation === "approve" ? createDecisionsApi(f.host).approve(decision, undefined, undefined, undefined, identity) : operation === "changes" ? createDecisionsApi(f.host).requestChanges(decision, "Please add a regression") : createDecisionsApi(f.host).reject(decision, "not_now");
  await expect(send()).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
  await expect(send()).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
  expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
 }
});
it.each(pendingBodies.slice(1))("the spend choice keeps the documented confirmation pending %# and sends once", async body => {
 const view = DecisionCardsViewReaderSchema.parse(fixture.views["approve_spend"]), taskId = "11111111-1111-4111-8111-111111111111";
 const action = { kind: "choose" as const, method: "POST" as const, href: `/v1/app/tasks/${taskId}/design-review/spend/raise-cap`, label: "Raise cap" };
 const decision = readDecisions(DecisionCardsViewReaderSchema.parse({ ...view, cards: [{ ...view.cards[0]!, taskId, actions: [action] }] }))[0]!;
 const me = meFixture();
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : { status: 202, body });
 const send = () => createDesignReviewApi(f.host).chooseSpend(decision, action, "frozen-spend-request");
 await expect(send()).rejects.toMatchObject({ code: "PENDING" });
 await expect(send()).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
});

it.each([{}, { cardId: "approve_spend:fixture", outcome: "approved", remainingTabs: [] }])("an unknown 202 spend choice stays locked %#", async body => {
 const view = DecisionCardsViewReaderSchema.parse(fixture.views["approve_spend"]), taskId = "11111111-1111-4111-8111-111111111111";
 const action = { kind: "choose" as const, method: "POST" as const, href: `/v1/app/tasks/${taskId}/design-review/spend/raise-cap`, label: "Raise cap" };
 const decision = readDecisions(DecisionCardsViewReaderSchema.parse({ ...view, cards: [{ ...view.cards[0]!, taskId, actions: [action] }] }))[0]!;
 const me = meFixture();
 const f = fakeHost(async r => r.path === "/v1/app/me" ? { status: 200, body: me } : { status: 202, body });
 const send = () => createDesignReviewApi(f.host).chooseSpend(decision, action, "frozen-spend-request");
 await expect(send()).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
 await expect(send()).rejects.toMatchObject({ code: "APPROVAL_UNKNOWN" });
 expect(f.request.mock.calls.filter(([r]) => r.method === "POST")).toHaveLength(1);
});
