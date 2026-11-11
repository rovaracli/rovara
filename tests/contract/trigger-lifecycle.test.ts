// Plan 4 Task 18: what happens to triggers and chains when a member leaves or is merged into another. A trigger is handed to someone who could own it, or turned off with the
// people who should know told; a chain follows Plan 3's agent rules. Nothing fails silently.
import "../support/automations-on.js";
import { afterEach, describe, expect, it } from "vitest";
import { TriggerSpecSchema } from "@rovara-code/contracts";
import { onMemberRemoved, onMembersMerged } from "../../packages/broker/src/agents/lifecycle.js";
import { onTriggerOwnersRemoved } from "../../packages/broker/src/triggers/lifecycle.js";
import { INVESTIGATE_THEN_FIX } from "../support/chain-examples.js";
import { orgMemberKey } from "../../packages/cloud-contracts/src/org-node.js";
import { ARJUN, CARL, DANA, MAX, ORG_A, OWNER, PRIYA, VIV, disposeGateWorlds, setupTriggerWorld, type TriggerWorld } from "../support/trigger-world.js";

afterEach(disposeGateWorlds);

const SYSTEM_BY = "system";
const stored = async (v: TriggerWorld, triggerId: string) => (await v.triggers.get(ORG_A, triggerId))!;
const removal = (v: TriggerWorld, developerId: string) => onMemberRemoved(v.routeDeps, { orgId: ORG_A, developerId, by: SYSTEM_BY });
const projectChain = (v: TriggerWorld, accountable: string = MAX) => v.budgetedChain(undefined, { owner: { kind: "project", project: "web" }, accountable: { developerId: accountable } });

describe("a member who created triggers is removed", () => {
  it("moves each of their triggers to the target's accountable maintainer, with an activity item, a notice to the new creator and an event on the target", async () => {
    const v = setupTriggerWorld();
    const chain = await projectChain(v);
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, { kind: "event", source: "github", type: "issues.opened" }], { budgetUsd: 20, owner: MAX });
    const target = { kind: "chain" as const, chainId: chain.chainId };
    const made = [
      await v.seed({ target, createdBy: CARL }),
      await v.seed({ target, createdBy: CARL, spec: TriggerSpecSchema.parse({ kind: "event", source: "github", type: "issues.opened" }) as never }),
      await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: CARL, spec: TriggerSpecSchema.parse({ kind: "event", source: "github", type: "issues.opened" }) as never }),
    ];
    await removal(v, CARL);
    for (const trigger of made) expect(await stored(v, trigger.triggerId)).toMatchObject({ createdBy: MAX, enabled: true });
    expect((await v.triggers.listByCreator(ORG_A, CARL))).toEqual([]);
    expect((await v.triggers.listByCreator(ORG_A, MAX)).map((trigger) => trigger.triggerId).sort()).toEqual(made.map((trigger) => trigger.triggerId).sort());
    const notices = await v.notices(MAX);
    expect(notices).toHaveLength(3);
    expect(notices[0]).toBe(`Max now owns trigger "github pull request opened" on ${chain.name} because Carl left.`);
    for (const trigger of made) expect((await v.triggers.listActivity(ORG_A, trigger.triggerId)).length).toBe(1);
    expect(v.targetEvents(target).filter((event) => event["kind"] === "trigger_owner_changed")).toHaveLength(2);
  });

  it("picks the first grant maintainer of the project when the target has no accountable maintainer", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: CARL });
    await removal(v, CARL);
    expect((await stored(v, trigger.triggerId)).createdBy).toBe(MAX);
  });

  it("skips a maintainer who can't use a step's agent and picks the next who can", async () => {
    const v = setupTriggerWorld();
    // An agent only Priya and the org's owners and admins can use: Max, a maintainer of web, can't.
    const agent = await v.customAgent("Private digger", PRIYA);
    const chain = await v.budgetedChain({ start: "look", limits: { maxRunUsd: 5 }, steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: agent.agentId, version: "current" }, next: { kind: "end" } }] });
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: CARL });
    await removal(v, CARL);
    expect((await stored(v, trigger.triggerId)).createdBy).toBe(OWNER);
    expect(await v.notices(MAX)).toEqual([]);
    expect(await v.notices(OWNER)).toHaveLength(1);
  });

  it("turns the trigger off with the exact reason and tells the project's maintainers and the org's owners when nobody qualifies", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: OWNER });
    // The only owner is the one who leaves: the project's maintainer (Max) can't use what Priya's chain uses, and no other owner is left.
    const agent = await v.customAgent("Private digger", PRIYA);
    const only = await v.budgetedChain({ start: "look", limits: { maxRunUsd: 5 }, steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: agent.agentId, version: "current" }, next: { kind: "end" } }] });
    const stuck = await v.seed({ target: { kind: "chain", chainId: only.chainId }, createdBy: OWNER });
    await onTriggerOwnersRemoved(v.routeDeps, { orgId: ORG_A, developerId: OWNER });
    expect(await stored(v, stuck.triggerId)).toMatchObject({ enabled: false, disabledReason: "no remaining member could own this trigger", createdBy: OWNER });
    expect((await v.notices(MAX)).filter((text) => text.includes("turned off"))).toEqual([`${only.name}'s trigger "github pull request opened" was turned off: no remaining member could own this trigger.`]);
    expect((await v.triggers.listActivity(ORG_A, stuck.triggerId))[0]).toMatchObject({ outcome: "disabled", reason: "no remaining member could own this trigger" });
    // The other trigger could go to Max, who can use what its chain uses.
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: true, createdBy: MAX });
  });

  it("turns off a trigger nobody can own, whatever the removal's marker does, and repeating it changes nothing", async () => {
    const v = setupTriggerWorld();
    const agent = await v.customAgent("Private digger", PRIYA);
    const chain = await v.budgetedChain({ start: "look", limits: { maxRunUsd: 5 }, steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: agent.agentId, version: "current" }, next: { kind: "end" } }] });
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: OWNER });
    await onTriggerOwnersRemoved(v.routeDeps, { orgId: ORG_A, developerId: OWNER });
    const first = await stored(v, trigger.triggerId);
    const noticesBefore = (await v.notices(MAX)).length;
    await onTriggerOwnersRemoved(v.routeDeps, { orgId: ORG_A, developerId: OWNER });
    expect(await stored(v, trigger.triggerId)).toEqual(first);
    expect((await v.notices(MAX)).length).toBe(noticesBefore);
  });

  it("decides a write approval created earlier with the new creator, not the old one", async () => {
    const v = setupTriggerWorld();
    const chain = await projectChain(v, MAX);
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: CARL });
    const { writerEligible } = await import("../../packages/broker/src/chains/write-approvers.js");
    const record = { kind: "write", orgId: ORG_A, project: "web", subject: { taskId: "task-1", stepId: "s" } } as never;
    // The task is a chain task of an event-started run of this trigger.
    const run = await (await import("../../packages/broker/src/chains/runner.js")).startChainRun(v.routeDeps as never, { system: "event", owner: { developerId: CARL } }, {
      orgId: ORG_A, chainId: chain.chainId, project: "web", origin: "event", requestId: "5f6c2f6c-1a0b-4d44-9a7c-5d1d1e6c8a10",
      startedBy: { kind: "event", triggerId: trigger.triggerId, eventKey: "github:1", source: "github", type: "pull_request.opened", title: "A pull request" },
    } as never);
    const taskId = [...v.tasks.keys()][0]!;
    void run;
    const asked = { ...(record as object), subject: { taskId, stepId: "s" } } as never;
    expect(await writerEligible(v.routeDeps, asked, { orgId: ORG_A, developerId: CARL, orgRole: "member" })).toBe(true);
    await removal(v, CARL);
    expect(await writerEligible(v.routeDeps, asked, { orgId: ORG_A, developerId: CARL, orgRole: "member" })).toBe(false);
    expect(await writerEligible(v.routeDeps, asked, { orgId: ORG_A, developerId: MAX, orgRole: "member" })).toBe(true);
    void ARJUN; void VIV;
  });
});

describe("two accounts are merged", () => {
  it("rewrites createdBy to the survivor and moves the index item, and repeating changes nothing", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const target = { kind: "chain" as const, chainId: chain.chainId };
    const one = await v.seed({ target, createdBy: CARL });
    const two = await v.seed({ target, createdBy: CARL });
    const merge = () => onMembersMerged(v.routeDeps, { orgId: ORG_A, survivorId: PRIYA, duplicateId: CARL });
    await merge();
    expect((await stored(v, one.triggerId)).createdBy).toBe(PRIYA);
    expect((await stored(v, two.triggerId)).createdBy).toBe(PRIYA);
    expect(await v.triggers.listByCreator(ORG_A, CARL)).toEqual([]);
    expect((await v.triggers.listByCreator(ORG_A, PRIYA)).map((trigger) => trigger.triggerId).sort()).toEqual([one.triggerId, two.triggerId]);
    const after = await stored(v, one.triggerId);
    await merge();
    expect(await stored(v, one.triggerId)).toEqual(after);
  });
});

describe("chains of a member who is removed or merged", () => {
  const chainOf = async (v: TriggerWorld, owner: string, name: string, budgetUsd = 10) => v.publish(INVESTIGATE_THEN_FIX, { owner: { kind: "member", developerId: owner }, name, by: owner, budgetUsd });

  it("moves a removed member's chains to the first org owner with an owner_changed event, drops their shares and moves an accountable id to another grant maintainer", async () => {
    const v = setupTriggerWorld();
    const mine = await chainOf(v, CARL, "Carl's chain");
    const shared = await chainOf(v, PRIYA, "Priya's chain");
    await v.chainCall(PRIYA, "PUT", `/v1/app/chains/${shared.chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: CARL }, level: "view" }] });
    const projectOwned = await projectChain(v, CARL);
    await removal(v, CARL);
    expect((await v.chains.get(ORG_A, mine.chainId))?.owner).toEqual({ kind: "member", developerId: OWNER });
    const moved = v.targetEvents({ kind: "chain", chainId: mine.chainId }).filter((event) => event["kind"] === "owner_changed");
    expect(moved).toHaveLength(1);
    expect(moved[0]).toMatchObject({ to: { kind: "member", developerId: OWNER }, cause: { kind: "member_removed", developerId: CARL } });
    expect((await v.chains.get(ORG_A, projectOwned.chainId))?.accountable).toEqual({ developerId: MAX });
    expect(await v.chains.listShares(ORG_A, shared.chainId)).toEqual([]);
    expect((await v.chains.get(ORG_A, shared.chainId))?.owner).toEqual({ kind: "member", developerId: PRIYA });
  });

  it("counts a moved chain's budget in the new owner's total and asks an admin to confirm when it leaves them over the cap", async () => {
    const v = setupTriggerWorld();
    await chainOf(v, CARL, "Big chain", 80);
    await chainOf(v, OWNER, "Owner's chain", 60);
    await removal(v, CARL);
    const asked = v.logs.filter((entry) => entry.event === "owner_cap.exceeded_by_move").map((entry) => entry.fields);
    const requests = v.db.find((item) => item["entityType"] === "SPEND_REQUEST");
    expect(asked.length + requests.length).toBeGreaterThan(0);
    const note = [...asked, ...requests].map((entry) => JSON.stringify(entry)).join(" ");
    expect(note).toContain(OWNER);
  });

  it("rewrites owner, accountable and shares of a merged duplicate to the survivor", async () => {
    const v = setupTriggerWorld();
    const mine = await chainOf(v, CARL, "Carl's chain");
    const shared = await chainOf(v, MAX, "Max's chain");
    await v.chainCall(MAX, "PUT", `/v1/app/chains/${shared.chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: CARL }, level: "edit" }] });
    const projectOwned = await projectChain(v, CARL);
    await onMembersMerged(v.routeDeps, { orgId: ORG_A, survivorId: PRIYA, duplicateId: CARL });
    expect((await v.chains.get(ORG_A, mine.chainId))?.owner).toEqual({ kind: "member", developerId: PRIYA });
    expect((await v.chains.get(ORG_A, projectOwned.chainId))?.accountable).toEqual({ developerId: PRIYA });
    expect((await v.chains.listShares(ORG_A, shared.chainId)).map((share) => share.principal)).toEqual([{ kind: "member", developerId: PRIYA }]);
    await onMembersMerged(v.routeDeps, { orgId: ORG_A, survivorId: PRIYA, duplicateId: CARL });
    expect((await v.chains.get(ORG_A, mine.chainId))?.owner).toEqual({ kind: "member", developerId: PRIYA });
    expect(DANA).toBeDefined();
  });
});

// Plan 5 Task 21 (merge Open (g)): the last owner leaves. `onMemberRemoved` used to stop at "no owner to hand things to" before any mover ran, so the triggers they created stayed
// enabled with no owner (dispatch refuses them) and nobody was told. The removal itself now turns them off and tells an org admin.
describe("the last owner leaves", () => {
  const unownable = async (v: TriggerWorld, createdBy: string) => {
    const agent = await v.customAgent("Private digger", PRIYA);
    const chain = await v.budgetedChain({ start: "look", limits: { maxRunUsd: 5 }, steps: [{ kind: "agent", id: "look", name: "Look", agent: { agentId: agent.agentId, version: "current" }, next: { kind: "end" } }] });
    return { chain, trigger: await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy }) };
  };
  const reason = "no remaining member could own this trigger";

  it("turns their triggers off through the removal itself, and tells the org's admin", async () => {
    const v = setupTriggerWorld();
    const { chain, trigger } = await unownable(v, OWNER);
    await removal(v, OWNER);
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: false, disabledReason: reason, createdBy: OWNER });
    expect((await v.triggers.listActivity(ORG_A, trigger.triggerId))[0]).toMatchObject({ outcome: "disabled", reason });
    expect((await v.notices(DANA)).filter((text) => text.includes("turned off"))).toEqual([`${chain.name}'s trigger "github pull request opened" was turned off: ${reason}.`]);
  });

  it("tells the org's admin and the project's maintainer, and no other member", async () => {
    const v = setupTriggerWorld();
    const { trigger } = await unownable(v, OWNER);
    await removal(v, OWNER);
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: false });
    expect((await v.notices(MAX)).filter((text) => text.includes("turned off"))).toHaveLength(1);
    expect((await v.notices(DANA)).filter((text) => text.includes("turned off"))).toHaveLength(1);
    // Members who are neither are not told.
    expect((await v.notices(VIV)).filter((text) => text.includes("turned off"))).toEqual([]);
  });

  it("tells at most the five longest-standing admins", async () => {
    const v = setupTriggerWorld();
    const { trigger } = await unownable(v, OWNER);
    const admins = ["a1", "b2", "c3", "d4", "e5", "f6", "a7"].map((pair) => pair.repeat(32));
    admins.forEach((developerId, index) => {
      v.db.set({ ...orgMemberKey(ORG_A, developerId), entityType: "ORG_MEMBER", orgId: ORG_A, developerId, role: "admin", joinedAt: `2026-09-0${String(index + 1)}T00:00:00.000Z` });
    });
    await removal(v, OWNER);
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: false });
    const told = await Promise.all(admins.map(async (id) => (await v.notices(id)).filter((text) => text.includes("turned off")).length));
    // DANA (joined 2026-10-01) is after all seven: the first five by joining are told.
    expect(told).toEqual([1, 1, 1, 1, 1, 0, 0]);
    expect((await v.notices(DANA)).filter((text) => text.includes("turned off"))).toEqual([]);
  });

  it("does not count the admin who is leaving among the admins told (they would take a place of the five)", async () => {
    const v = setupTriggerWorld();
    const { trigger } = await unownable(v, OWNER);
    // The one who leaves is the longest-standing admin and nobody holds the owner role: the next five are told.
    v.db.set({ ...v.db.get(orgMemberKey(ORG_A, OWNER))!, role: "admin" });
    const others = ["a1", "b2", "c3", "d4", "e5", "f6"].map((pair) => pair.repeat(32));
    others.forEach((developerId, index) => {
      v.db.set({ ...orgMemberKey(ORG_A, developerId), entityType: "ORG_MEMBER", orgId: ORG_A, developerId, role: "admin", joinedAt: `2026-09-0${String(index + 2)}T00:00:00.000Z` });
    });
    await removal(v, OWNER);
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: false });
    const told = await Promise.all(others.map(async (id) => (await v.notices(id)).filter((text) => text.includes("turned off")).length));
    expect(told).toEqual([1, 1, 1, 1, 1, 0]);
  });

  it("hands a trigger to a maintainer who can own it, as for any removal, and says so", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: OWNER });
    await removal(v, OWNER);
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: true, createdBy: MAX });
    expect((await v.notices(DANA)).filter((text) => text.includes("turned off"))).toEqual([]);
  });

  it("changes nothing a second time, and leaves other people's triggers alone", async () => {
    const v = setupTriggerWorld();
    const { trigger } = await unownable(v, OWNER);
    const other = await v.seed({ target: { kind: "chain", chainId: (await v.budgetedChain()).chainId }, createdBy: MAX });
    await removal(v, OWNER);
    const first = await stored(v, trigger.triggerId);
    expect(first).toMatchObject({ enabled: false, disabledReason: reason });
    const told = (await v.notices(DANA)).length;
    expect(told).toBeGreaterThan(0);
    await removal(v, OWNER);
    expect(await stored(v, trigger.triggerId)).toEqual(first);
    expect((await v.notices(DANA)).length).toBe(told);
    expect(await stored(v, other.triggerId)).toMatchObject({ enabled: true, createdBy: MAX });
  });

  it("still turns the trigger off when no admin or maintainer is left to tell, and says so in the log", async () => {
    const v = setupTriggerWorld();
    const { trigger } = await unownable(v, OWNER);
    v.db.set({ ...v.db.get(orgMemberKey(ORG_A, DANA))!, role: "member" });
    v.projectMembers.revoke(ORG_A, "web", MAX);
    await removal(v, OWNER);
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: false, disabledReason: reason });
    expect(v.logs.map((entry) => entry.event)).toContain("trigger.no_one_to_tell");
    // A repeat finds the trigger off already and says nothing more (Review M-7).
    await removal(v, OWNER);
    expect(v.logs.filter((entry) => entry.event === "trigger.no_one_to_tell")).toHaveLength(1);
  });

  it("keeps the marker when a mover fails, so the next run turns the trigger off", async () => {
    const v = setupTriggerWorld();
    const { trigger } = await unownable(v, OWNER);
    v.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" }, times: 1 });
    await expect(removal(v, OWNER)).rejects.toBeDefined();
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: true });
    await removal(v, OWNER);
    expect(await stored(v, trigger.triggerId)).toMatchObject({ enabled: false });
  });
});
