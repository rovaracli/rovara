// PRODUCT-EVAL-APPROVER-REREAD, Cloud's side: before Cloud changes a person's membership or role (a project member added or
// removed, an invite accepted), it withdraws every eval approval that person made, so the gateway's stage hold stops taking them
// at once. Fail closed: when the withdrawal can't be saved, the change is not made. The settings route records an approval from
// the moment its role check began, and the app sees whether an approval still counts. Two companies never meet.
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { storedEvalApprovals } from "../../packages/model-gateway/src/eval-approvals.js";
import { EVAL_APPROVAL_STALE } from "../../packages/model-gateway/src/product-eval.js";
import { EVAL_APPROVAL_FRESH_MS } from "../../packages/model-gateway/src/product-keys.js";
import { A, B, ISS, PEOPLE, START, world, write } from "./product-ai-world.js";

const approval = { selection: "all-questions", inputsDigest: "d".repeat(64), maxCalls: 50, maxCostMicros: 500_000 };
const APPROVAL = "/projects/web/product-ai/eval-approval";
const pamId = PEOPLE.pam!.developerId;

async function approved(w: ReturnType<typeof world>, who = "pam") {
  const cookie = await w.signIn(who, 30);
  const r = await w.call(cookie, "PUT", APPROVAL, write(0, { approval }));
  expect(r.status).toBe(200);
  return cookie;
}

describe("withdrawn before a membership change", () => {
  it("removing the approver from a project withdraws their approvals before Code is asked", async () => {
    const w = world();
    await approved(w);
    const source = storedEvalApprovals(w.store, () => w.clock.at);
    expect(await source.current(ISS, A, "web")).toMatchObject({ approver: { personId: pamId } });
    w.advance(1000);
    const ada = await w.signIn("ada", 30);
    const r = await w.call(ada, "DELETE", `/projects/web/members/${pamId}`);
    expect(r.status).toBe(200);
    expect(w.codeCalls).toEqual([`DELETE /v1/dev/client/projects/web/members/${pamId}`]);
    expect(await source.current(ISS, A, "web")).toBe(EVAL_APPROVAL_STALE);
    // The app sees it no longer counts; the audit says who withdrew whose approvals.
    const view = await w.call(ada, "GET", "/projects/web/product-ai");
    expect(view.body).toMatchObject({ evalApproval: { state: "withdrawn" } });
    expect((await w.audit.read(A, { max: 50 })).rows.map((r) => [r.action, r.subject])).toContainEqual(["product_ai.eval_approvals.withdrawn_for_member", `person:${pamId}`]);
  });

  it("adding (re-granting) a person to a project withdraws their approvals too", async () => {
    const w = world();
    await approved(w);
    w.advance(1000);
    const r = await w.call(await w.signIn("ada", 30), "PUT", `/projects/web/members/${pamId}`, { role: "contributor" });
    expect(r.status).toBe(200);
    expect(await storedEvalApprovals(w.store, () => w.clock.at).current(ISS, A, "web")).toBe(EVAL_APPROVAL_STALE);
  });

  it("accepting an invite withdraws the accepting person's approvals first", async () => {
    const w = world({ company: true });
    await approved(w);
    w.advance(1000);
    const token = randomBytes(32).toString("base64url");
    const at = new Date(w.clock.at).toISOString();
    await w.companies.createInvite({ inviteId: "00000000-0000-4000-8000-000000000001", requestId: "00000000-0000-4000-8000-000000000002", companyId: A, email: "pam@example.test", role: "member", state: "pending", tokenHash: createHash("sha256").update(token).digest("hex"), createdAt: at, createdBy: PEOPLE.ada!.developerId, expiresAt: new Date(w.clock.at + 86_400_000).toISOString(), revision: 1 });
    const r = await w.call(await w.signIn("pam", 30), "POST", "/org/invites/accept", { invite: token });
    expect(r.status).toBe(200);
    expect(await storedEvalApprovals(w.store, () => w.clock.at).current(ISS, A, "web")).toBe(EVAL_APPROVAL_STALE);
  });

  it("fails closed: when the withdrawal can't be saved, Code is never asked and nothing changes", async () => {
    let failing = false;
    const w = world({ beforeCommit: () => (failing ? false : undefined) });
    await approved(w);
    failing = true;
    const r = await w.call(await w.signIn("ada", 30), "DELETE", `/projects/web/members/${pamId}`);
    expect(r.status).toBe(503);
    expect(w.codeCalls).toEqual([]);
    // A person named any other way than their member id can't be matched, so the change is refused too.
    failing = false;
    const odd = await w.call(await w.signIn("ada", 30), "DELETE", "/projects/web/members/pam@example.test");
    expect(odd.status).toBe(400);
    expect(odd.raw).not.toContain("pam@example.test");
    expect(w.codeCalls).toEqual([]);
  });

  it("two companies: a change in company B never withdraws the same person's approvals in company A", async () => {
    const w = world();
    await approved(w);
    w.advance(1000);
    // Bea (company B) removes a member with Pam's id from B's project "web".
    expect((await w.call(await w.signIn("bea", 30), "DELETE", `/projects/web/members/${pamId}`)).status).toBe(200);
    expect(await storedEvalApprovals(w.store, () => w.clock.at).current(ISS, A, "web")).toMatchObject({ approver: { personId: pamId } });
    expect((await w.audit.read(A, { max: 50 })).rows.map((r) => r.action)).not.toContain("product_ai.eval_approvals.withdrawn_for_member");
    expect((await w.audit.read(B, { max: 50 })).rows.map((r) => r.action)).toContain("product_ai.eval_approvals.withdrawn_for_member");
  });

  it("only someone who may change the project's members withdraws anything: a contributor's attempt changes nothing", async () => {
    const w = world();
    await approved(w);
    w.advance(1000);
    const r = await w.call(await w.signIn("cal", 30), "DELETE", `/projects/web/members/${pamId}`);
    expect(r.status).toBe(403);
    expect(w.codeCalls).toEqual([]);
    expect(await storedEvalApprovals(w.store, () => w.clock.at).current(ISS, A, "web")).toMatchObject({ approver: { personId: pamId } });
    expect((await w.audit.read(A, { max: 50 })).rows.map((each) => each.action)).not.toContain("product_ai.eval_approvals.withdrawn_for_member");
  });

  it("audits only a change Code made", async () => {
    const w = world({ memberStatus: 403 });
    await approved(w);
    w.advance(1000);
    expect((await w.call(await w.signIn("ada", 30), "DELETE", `/projects/web/members/${pamId}`)).status).toBeGreaterThanOrEqual(400);
    expect((await w.audit.read(A, { max: 50 })).rows.map((each) => each.action)).not.toContain("product_ai.eval_approvals.withdrawn_for_member");
  });

  it("an approval whose role check raced Code's change is withdrawn too (withdrawn again after the change)", async () => {
    const hook: { raced?: () => Promise<unknown> } = {};
    const w = world({ duringMemberChange: async () => { await hook.raced?.(); } });
    hook.raced = async () => {
      // Pam's role check began after the first withdrawal and before Code removed her.
      w.advance(10);
      await w.store.setEvalApproval({ iss: ISS, cid: A, owner: "web", requestId: crypto.randomUUID(), expectedRevision: (await w.store.view(ISS, A, "web")).revision, actor: { id: pamId, role: "project_maintainer" }, approval, provider: "rovara-code", roleCheckedAt: w.clock.at });
      w.advance(10);
    };
    expect((await w.call(await w.signIn("ada", 30), "DELETE", `/projects/web/members/${pamId}`)).status).toBe(200);
    expect(await storedEvalApprovals(w.store, () => w.clock.at).current(ISS, A, "web")).toBe(EVAL_APPROVAL_STALE);
  });

  it("without product AI settings, member changes work as before (nothing to withdraw)", async () => {
    // product-ai-routes.test.ts covers the handler without productAi; here the route still answers when the store is healthy.
    const w = world();
    expect((await w.call(await w.signIn("ada", 30), "DELETE", `/projects/web/members/${pamId}`)).status).toBe(200);
  });
});

describe("the approval as the app sees it", () => {
  it("is dated from when the role check with Code began, not from the save after it", async () => {
    const w = world({ accessMs: 2000 });
    const pam = await w.signIn("pam", 30);
    expect((await w.call(pam, "PUT", APPROVAL, write(0, { approval }))).status).toBe(200);
    expect((await w.store.evalFor(ISS, A, "web")).approval?.approvedAt).toBe(START);
    // A withdrawal that landed while that check was in flight still catches it.
    const v = world({ accessMs: 2000 });
    const cookie = await v.signIn("pam", 30);
    const saving = v.call(cookie, "PUT", APPROVAL, write(0, { approval }));
    await v.store.withdrawApprovals(ISS, A, pamId);
    expect((await saving).status).toBe(200);
    expect(await storedEvalApprovals(v.store, () => v.clock.at).current(ISS, A, "web")).toBe(EVAL_APPROVAL_STALE);
  });

  it("counts for 15 minutes from the role check: current, then stale (approve again)", async () => {
    const w = world();
    const pam = await approved(w);
    expect((await w.call(pam, "GET", "/projects/web/product-ai")).body).toMatchObject({ evalApproval: { state: "current", approvedAt: START } });
    w.advance(EVAL_APPROVAL_FRESH_MS);
    expect((await w.call(pam, "GET", "/projects/web/product-ai")).body).toMatchObject({ evalApproval: { state: "stale" } });
  });
});
