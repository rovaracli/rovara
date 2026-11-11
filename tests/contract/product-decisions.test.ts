// Product decisions (W11, A-23, DN-6; experience decisions 14 and 36; owner answer Q8): who may answer and approve one, by role, risk and the project's switch; that a collaborator's approval is a
// `class: product` record that nothing deciding a code review, a merge or CODEOWNERS reads; revision fencing, replay, company scoping, browser-only writes and the audit.
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { approvalPlaceDecision, DEFAULT_RECENT_SIGN_IN_SETTING, ProductDecisionsResponseSchema, type ProductDecisionRisk, type ProductDecisionView } from "@agentx/cloud-contracts";
import { PRODUCT_DECISION_REFUSALS, raiseProductDecision } from "../../packages/broker/src/product-decisions/store.js";
import { CARA, KIT, LENA, NEO, OTHER_ORG, OTTO, PRIYA, PROJECT, SAM, TASK_ID, collaboratorBench, errorOf, type CollaboratorBench } from "../support/collaborator-bench.js";
import { TEST_ORG } from "../support/orgs.js";
import type { Developer } from "../support/developer-task-broker.js";

const LIST = `/v1/app/projects/${PROJECT}/product-decisions`;
const SWITCH = `/v1/app/projects/${PROJECT}/collaborator-approvals`;
const OPTIONS = [{ id: "a", label: "Show the banner on checkout" }, { id: "b", label: "Show it on the cart" }];

async function raised(b: CollaboratorBench, risk: ProductDecisionRisk = "low", requestId = randomUUID().replaceAll("-", "")): Promise<string> {
  return (await raiseProductDecision(b.deps, { orgId: TEST_ORG, project: PROJECT, taskId: TASK_ID, requestId, raise: { question: "Where should the banner go?", options: OPTIONS, risk }, raisedBy: { kind: "system", id: "rovara" } })).decisionId;
}
const withoutRequestId = (body: Record<string, unknown>) => { const { requestId: _requestId, ...rest } = body; return rest; }; // eslint-disable-line @typescript-eslint/no-unused-vars -- the harness adds the request id to every answer
const decisionsOf = async (b: CollaboratorBench, who: Developer) => ProductDecisionsResponseSchema.parse(withoutRequestId((await b.web(who, "GET", LIST)).body)).decisions;
const revisionOf = async (b: CollaboratorBench, id: string) => (await decisionsOf(b, PRIYA)).find((d) => d.decisionId === id)!.revision;
const approve = async (b: CollaboratorBench, who: Developer, id: string, extra: Record<string, unknown> = {}) =>
  b.web(who, "POST", `${LIST}/${id}`, { action: "approve", requestId: randomUUID(), expectedRevision: await revisionOf(b, id), optionId: "a", ...extra });
const answer = async (b: CollaboratorBench, who: Developer, id: string, text = "The checkout page, please") =>
  b.web(who, "POST", `${LIST}/${id}`, { action: "answer", requestId: randomUUID(), expectedRevision: await revisionOf(b, id), text });
const productItems = (b: CollaboratorBench) => b.db.find((item) => String(item.sk).startsWith("PRODUCT_DECISION"));

describe("who may approve a product decision", () => {
  it("a LOW one: the task's owner, a maintainer, a company admin and a collaborator may; a contributor who does not own the task and a viewer may not", async () => {
    for (const [who, allowed, role] of [[KIT, true, "owner"], [PRIYA, true, "maintainer"], [LENA, true, "maintainer"], [CARA, true, "collaborator"], [NEO, false, undefined], [SAM, false, undefined]] as const) {
      const b = await collaboratorBench();
      const id = await raised(b);
      const reply = await approve(b, who, id);
      expect(reply.status, `${who.name}: ${JSON.stringify(reply.body)}`).toBe(allowed ? 200 : 403);
      if (allowed) expect((reply.body.decision as ProductDecisionView).approved).toMatchObject({ optionId: "a", role, class: "product", by: { developerId: who.developerId } });
      else {
        expect(errorOf(reply)?.message).toBe(PRODUCT_DECISION_REFUSALS["role_not_allowed"]);
        expect((await decisionsOf(b, PRIYA))[0]).toMatchObject({ status: "open", revision: 1 });
        expect(b.audit.recordedBy("product_decision.approved")).toEqual([]);
      }
    }
  });

  it("the task's owner decides as its owner only while their live role may still start work: an owner who is a viewer now decides nothing", async () => {
    const b = await collaboratorBench();
    const id = await raised(b);
    b.grant(KIT, "viewer");
    expect((await approve(b, KIT, id)).status).toBe(403);
    b.grant(KIT, "collaborator");
    // As a collaborator now, a low one under the switch, by that role (not as the owner).
    const reply = await approve(b, KIT, id);
    expect((reply.body.decision as ProductDecisionView).approved).toMatchObject({ role: "collaborator" });
  });

  it("a MEDIUM one needs a maintainer or the task's owner: a collaborator is refused", async () => {
    const b = await collaboratorBench();
    const id = await raised(b, "medium");
    expect((await decisionsOf(b, CARA))[0]!.you).toEqual({ canAnswer: true, canApprove: false, approveRefusal: "role_not_allowed" });
    const refused = await approve(b, CARA, id);
    expect(refused.status).toBe(403);
    expect(errorOf(refused)?.message).toBe(PRODUCT_DECISION_REFUSALS["role_not_allowed"]);
    expect((await approve(b, PRIYA, id)).status).toBe(200);
  });

  it("a HIGH one is not approved here by anyone (it needs a fresh sign-in on its task page): refused, never approved without it", async () => {
    const b = await collaboratorBench();
    const id = await raised(b, "high");
    for (const who of [PRIYA, KIT, CARA]) expect((await approve(b, who, id)).status, who.name).toBe(403);
    expect((await decisionsOf(b, PRIYA))[0]!.you).toMatchObject({ canApprove: false, approveRefusal: "fresh_sign_in_required" });
  });

  it("with the project's switch OFF a collaborator is refused even a low one; the owner and maintainers still decide; turned on again it works", async () => {
    const b = await collaboratorBench();
    const first = await raised(b);
    expect((await b.web(PRIYA, "PUT", SWITCH, { requestId: randomUUID(), enabled: false, expectedRevision: 0 })).status).toBe(200);
    expect((await decisionsOf(b, CARA))[0]!.you).toEqual({ canAnswer: true, canApprove: false, approveRefusal: "collaborator_approvals_off" });
    const refused = await approve(b, CARA, first);
    expect(refused.status).toBe(403);
    expect(errorOf(refused)?.message).toBe(PRODUCT_DECISION_REFUSALS["collaborator_approvals_off"]);
    expect((await approve(b, KIT, first)).status).toBe(200);
    const second = await raised(b);
    expect((await b.web(PRIYA, "PUT", SWITCH, { requestId: randomUUID(), enabled: true, expectedRevision: 1 })).status).toBe(200);
    expect((await approve(b, CARA, second)).status).toBe(200);
  });

  it("a collaborator approves only PRODUCT decisions: the same rule refuses it a coding plan, a design and a merge at any risk", () => {
    for (const kind of ["plan", "design", "merge"] as const) for (const risk of ["low", "medium"] as const) {
      const verdict = approvalPlaceDecision({ kind, risk, answer: "approve", place: "browser", decider: { role: "collaborator", linked: true }, settings: { recentSignIn: DEFAULT_RECENT_SIGN_IN_SETTING, collaboratorApprovals: true }, freshSignIn: false, nowMs: Date.now() });
      expect(verdict, `${kind} ${risk}`).toMatchObject({ allowed: false, reason: "role_not_allowed" });
    }
  });
});

describe("a collaborator's approval never counts toward code", () => {
  it("writes only the product decision and the audit: no review, approval, merge or code-owner record", async () => {
    const b = await collaboratorBench();
    const id = await raised(b);
    await decisionsOf(b, PRIYA); await decisionsOf(b, CARA);
    const before = new Set(b.db.find(() => true).map((item) => `${String(item.pk)}|${String(item.sk)}`));
    expect((await b.web(CARA, "POST", `${LIST}/${id}`, { action: "approve", requestId: randomUUID(), expectedRevision: 1, optionId: "a" })).status).toBe(200);
    const added = b.db.find((item) => !before.has(`${String(item.pk)}|${String(item.sk)}`)).map((item) => item.entityType);
    // Besides the decision itself (changed in place, below), only the audit's pending item.
    expect(added.every((kind) => kind === "AUDIT_PENDING")).toBe(true);
    expect((await decisionsOf(b, PRIYA))[0]!.approved).toMatchObject({ class: "product", role: "collaborator" });
  });

  it("is read by nothing that decides a merge, a code review or CODEOWNERS (those read the code host's reviews only)", () => {
    for (const file of ["packages/broker/src/rovara-code/merge.ts", "packages/broker/src/rovara-code/approval.ts", "packages/broker/src/rovara-code/code-owners.ts", "packages/broker/src/rovara-code/merge-tracking.ts", "packages/broker/src/decisions/merge-source.ts"]) {
      const source = readFileSync(file, "utf8");
      expect(source, file).not.toMatch(/product-decisions|PRODUCT_DECISION|productDecision/u);
    }
  });
});

describe("answering a product decision", () => {
  it("is open to a collaborator, a contributor and the owner and maintainers, never to a viewer; an answer settles nothing", async () => {
    const b = await collaboratorBench();
    const id = await raised(b, "high");
    for (const who of [CARA, NEO, KIT, PRIYA]) expect((await answer(b, who, id)).status, who.name).toBe(200);
    const viewer = await answer(b, SAM, id);
    expect(viewer.status).toBe(403);
    const decision = (await decisionsOf(b, SAM))[0]!;
    expect(decision).toMatchObject({ status: "open", revision: 5 });
    expect(decision.answers.map((a) => a.by.developerId)).toEqual([CARA, NEO, KIT, PRIYA].map((who) => who.developerId));
    expect(decision.you).toMatchObject({ canAnswer: false, canApprove: false });
    // The audit says who answered which decision; the answer's words are never a fact.
    const events = b.audit.recordedBy("product_decision.answered");
    expect(events).toHaveLength(4);
    expect(JSON.stringify(events.map((event) => event.facts))).not.toContain("checkout");
  });
});

describe("revisions, replays and a settled decision", () => {
  it("refuses a stale revision, answers a replay with the decision and writes nothing, refuses the same id with another body, and refuses deciding twice", async () => {
    const b = await collaboratorBench();
    const id = await raised(b);
    expect(errorOf(await b.web(CARA, "POST", `${LIST}/${id}`, { action: "approve", requestId: randomUUID(), expectedRevision: 7, optionId: "a" }))?.code).toBe("CHANGE_STALE");
    expect(errorOf(await b.web(CARA, "POST", `${LIST}/${id}`, { action: "approve", requestId: randomUUID(), expectedRevision: 1, optionId: "zz" }))?.code).toBe("CONFIG_INVALID");
    const requestId = randomUUID();
    const body = { action: "approve", requestId, expectedRevision: 1, optionId: "a" };
    const first = await b.web(CARA, "POST", `${LIST}/${id}`, body);
    expect(first.status).toBe(200);
    const items = JSON.stringify(productItems(b));
    const replay = await b.web(CARA, "POST", `${LIST}/${id}`, body);
    expect(replay.status).toBe(200);
    expect((replay.body.decision as ProductDecisionView).approved).toEqual((first.body.decision as ProductDecisionView).approved);
    expect(JSON.stringify(productItems(b))).toBe(items);
    expect(b.audit.recordedBy("product_decision.approved")).toHaveLength(1);
    expect(errorOf(await b.web(CARA, "POST", `${LIST}/${id}`, { ...body, optionId: "b" }))?.code).toBe("CONFIG_INVALID");
    expect(errorOf(await b.web(PRIYA, "POST", `${LIST}/${id}`, { action: "approve", requestId: randomUUID(), expectedRevision: 2, optionId: "b" }))?.code).toBe("CHANGE_STALE");
  });

  it("raises one decision for a retried raise, and refuses a raise on a task of another project or company", async () => {
    const b = await collaboratorBench();
    const requestId = "raise-request-0001";
    expect(await raised(b, "low", requestId)).toBe(await raised(b, "low", requestId));
    expect(productItems(b).filter((item) => item.entityType === "PRODUCT_DECISION")).toHaveLength(1);
    expect(b.audit.recordedBy("product_decision.raised")).toHaveLength(1);
    await expect(raiseProductDecision(b.deps, { orgId: OTHER_ORG, project: PROJECT, taskId: TASK_ID, requestId: "raise-request-0002", raise: { question: "Q?", options: OPTIONS, risk: "low" }, raisedBy: { kind: "system", id: "rovara" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(raiseProductDecision(b.deps, { orgId: TEST_ORG, project: "other", taskId: TASK_ID, requestId: "raise-request-0003", raise: { question: "Q?", options: OPTIONS, risk: "low" }, raisedBy: { kind: "system", id: "rovara" } })).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("company scoping and browser-only writes", () => {
  it("never shows or decides another company's decision: its maintainer of a same-named project sees none, and pressing the id is 404 writing nothing", async () => {
    const b = await collaboratorBench();
    const id = await raised(b);
    expect(await decisionsOf(b, OTTO)).toEqual([]);
    const pressed = await b.web(OTTO, "POST", `${LIST}/${id}`, { action: "approve", requestId: randomUUID(), expectedRevision: 1, optionId: "a" });
    expect(pressed.status).toBe(404);
    expect(errorOf(pressed)?.message).not.toContain(id);
    expect((await decisionsOf(b, PRIYA))[0]).toMatchObject({ status: "open", revision: 1 });
  });

  it("refuses a decide without a live browser session (a sign-in token), before anything is read or written; reading with a token is allowed", async () => {
    const b = await collaboratorBench();
    const id = await raised(b);
    const token = await b.dev(PRIYA, "POST", `${LIST}/${id}`, { action: "approve", requestId: randomUUID(), expectedRevision: 1, optionId: "a" });
    expect(token.status).toBe(403);
    expect(errorOf(token)?.message).toContain("live browser session");
    expect((await b.dev(PRIYA, "GET", LIST)).status).toBe(200);
    expect((await decisionsOf(b, PRIYA))[0]).toMatchObject({ status: "open", revision: 1 });
  });

  it("audits an approval with fixed words: who, the decision, its risk, the role the rule saw and class product; never the question or an option's words", async () => {
    const b = await collaboratorBench();
    const id = await raised(b);
    await approve(b, CARA, id);
    const [event] = b.audit.recordedBy("product_decision.approved");
    expect(event).toMatchObject({ orgId: TEST_ORG, actor: { kind: "member", id: CARA.developerId }, target: { kind: "task", id: TASK_ID }, facts: { decisionId: id, risk: "low", role: "collaborator", optionId: "a", revision: 2, class: "product" } });
    expect(JSON.stringify(event!.facts)).not.toMatch(/banner|checkout/u);
  });
});
