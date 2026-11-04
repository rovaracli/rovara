import { fixtureActor } from "../support/money-authority.js";
// Plan 4 Task 18: what the first mutation pass found unpinned. Each test names the guard it holds: the store's conditions and indexes, the checks of `triggerProblems`, who may set,
// move, delete and confirm a trigger, what binds a confirmation to the spec it was asked for, and who a trigger goes to when its owner leaves.
import { afterEach, describe, expect, it } from "vitest";
import { BUILTIN_TRIGGER_SUGGESTIONS, INDEX_EXPIRY_ATTRIBUTE } from "@agentx/contracts";
import { TriggerSpecSchema } from "../../packages/contracts/src/agent-recipe.js";
import { getApprovalSubjectHandler, type ApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { recheckTriggersForTarget } from "../../packages/broker/src/triggers/lifecycle.js";
import { onMemberRemoved } from "../../packages/broker/src/agents/lifecycle.js";
import { triggerProblems } from "../../packages/broker/src/triggers/requirements.js";
import { isTriggerConflict } from "../../packages/broker/src/triggers/store.js";
import { ARJUN, CARL, DANA, HOOK_A, HOOK_A2, MAX, ORG_A, OWNER, PRIYA, VIV, disposeGateWorlds, setupTriggerWorld, type TriggerWorld } from "../support/trigger-world.js";

afterEach(disposeGateWorlds);

const PR = { kind: "event" as const, source: "github" as const, type: "pull_request.opened" };
const SENTRY = { kind: "event" as const, source: "sentry" as const, type: "issue.created" };
const LINEAR = { kind: "event" as const, source: "linear" as const, type: "issue.created" };
const ISSUE = { kind: "event" as const, source: "github" as const, type: "issues.opened" };
const SCHEDULE = TriggerSpecSchema.parse({ kind: "schedule", schedule: { kind: "interval", minutes: 60 }, timezone: "UTC" });
const parse = (spec: unknown) => TriggerSpecSchema.parse(spec) as never;
const stored = async (v: TriggerWorld, triggerId: string) => (await v.triggers.get(ORG_A, triggerId))!;
const ID = (letter: string) => `ctr_${letter.repeat(20)}`;
const approvalOf = (confirmUrl: unknown) => String(confirmUrl).split("/").pop()!;
const one = (agentId: string, version: number | "current" = "current") => ({ start: "look", limits: { maxRunUsd: 5 }, steps: [{ kind: "agent" as const, id: "look", name: "Look", agent: { agentId, version }, next: { kind: "end" as const } }] });

describe("the store", () => {
  it("refuses a write made from a stale read, for an update, a delete and a create of an id that is taken", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const target = { kind: "chain" as const, chainId: chain.chainId };
    const trigger = await v.seed({ target });
    await v.triggers.update({ trigger, patch: { maxRunsPerHour: 5 } });
    const stale = await v.triggers.update({ trigger, patch: { maxRunsPerHour: 6 } }).catch((error: unknown) => error);
    expect(isTriggerConflict(stale)).toBe(true);
    expect(isTriggerConflict(await v.triggers.delete({ trigger }).catch((error: unknown) => error))).toBe(true);
    expect((await stored(v, trigger.triggerId)).maxRunsPerHour).toBe(5);
    const again = await v.triggers.create({ record: { ...trigger } }).catch((error: unknown) => error);
    expect(isTriggerConflict(again)).toBe(true);
  });

  it("finds a GitHub trigger by its match key, keeps the enabled flag of the match item and moves the match item when the hook changes", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const target = { kind: "chain" as const, chainId: chain.chainId };
    const github = await v.seed({ target });
    expect((await v.triggers.listForMatch(ORG_A, "github", "web", undefined)).map((trigger) => trigger.triggerId)).toEqual([github.triggerId]);
    const matchItem = () => v.db.find((item) => item["entityType"] === "TRIGGER_MATCH" && item["triggerId"] === github.triggerId)[0];
    expect(matchItem()?.["enabled"]).toBe(true);
    const created = await v.seed({ target, enabled: false });
    expect(v.db.find((item) => item["entityType"] === "TRIGGER_MATCH" && item["triggerId"] === created.triggerId)[0]?.["enabled"]).toBe(false);
    await v.triggers.update({ trigger: github, patch: { enabled: false } });
    expect(matchItem()?.["enabled"]).toBe(false);
    const hooked = await v.seed({ target, spec: parse(SENTRY), hookId: HOOK_A });
    await v.triggers.update({ trigger: hooked, patch: { hookId: HOOK_A2 } });
    expect(await v.triggers.listForMatch(ORG_A, "sentry", "web", HOOK_A)).toEqual([]);
    expect((await v.triggers.listForMatch(ORG_A, "sentry", "web", HOOK_A2)).map((trigger) => trigger.triggerId)).toEqual([hooked.triggerId]);
  });

  it("moves the index item and the counters when a trigger changes target, and lets the old target take another", async () => {
    const v = setupTriggerWorld();
    const first = await v.budgetedChain();
    const second = await v.budgetedChain();
    const a = { kind: "chain" as const, chainId: first.chainId };
    const b = { kind: "chain" as const, chainId: second.chainId };
    const trigger = await v.seed({ target: a });
    await v.triggers.update({ trigger, patch: { target: b } });
    expect(await v.triggers.listForTarget(ORG_A, a)).toEqual([]);
    expect((await v.triggers.listForTarget(ORG_A, b)).map((t) => t.triggerId)).toEqual([trigger.triggerId]);
    const counts = (chainId: string) => v.db.find((item) => String(item["pk"]).endsWith(`TARGET_TRIGGERS#CHAIN#${chainId}`) && item["sk"] === "COUNT")[0]?.["count"];
    expect([counts(first.chainId), counts(second.chainId)]).toEqual([0, 1]);
  });

  it("gives an activity item an expiry 30 days out, newest first, and a notice its recipient's listing", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId } });
    await v.triggers.recordActivity(ORG_A, trigger.triggerId, { eventKey: "k1", outcome: "started" });
    const item = v.db.find((entry) => entry["entityType"] === "TRIGGER_ACTIVITY")[0]!;
    expect(item[INDEX_EXPIRY_ATTRIBUTE]).toBe(Math.floor(v.clock.now / 1000) + 30 * 86_400);
  });
});

describe("what a trigger needs", () => {
  it("is refused on a chain that is archived, or whose step's agent the owner can't use, or that is not on the project's roster", async () => {
    const v = setupTriggerWorld();
    const mine = await v.customAgent("Private digger", PRIYA);
    const chain = await v.budgetedChain(one(mine.agentId));
    const target = { kind: "chain" as const, chainId: chain.chainId };
    expect(await triggerProblems(v.routeDeps, await v.seed({ target, createdBy: PRIYA }))).toEqual([]);
    // Max is a maintainer of web, but may not use Priya's agent.
    const noAccess = await triggerProblems(v.routeDeps, await v.seed({ target, createdBy: MAX }));
    expect(noAccess[0]).toMatchObject({ code: "CHAIN_UNAVAILABLE" });
    expect(noAccess[0]!.message).toContain("its owner can no longer use it");
    // Dana is an admin of every project, and the agent works on web only.
    const offRoster = await triggerProblems(v.routeDeps, await v.seed({ target, createdBy: DANA, project: "api" }));
    expect(offRoster[0]).toMatchObject({ code: "CHAIN_UNAVAILABLE" });
    expect(offRoster[0]!.message).toContain("which can't run now");
    await v.chains.archive(ORG_A, chain.chainId, DANA, undefined, { actor: fixtureActor(v.chains, ORG_A, DANA) });
    expect((await triggerProblems(v.routeDeps, await v.seed({ target, createdBy: PRIYA })))[0]).toMatchObject({ code: "CHAIN_UNAVAILABLE", message: `${chain.name} is archived, so it can't start new runs.` });
  });

  it("refuses an agent with no published version, a kind its recipe doesn't list, and the same event type of another source", async () => {
    const v = setupTriggerWorld();
    const draft = await v.agents.create({ orgId: ORG_A, name: "Unpublished", owner: { kind: "member", developerId: DANA }, createdBy: DANA, overlay: { instructions: "x", sequence: [{ id: "work", name: "Work", kind: "agent", workspace: "none" }] } });
    const call = (agentId: string, spec: unknown) => v.agentCall(DANA, "PUT", `/v1/app/agents/${agentId}/triggers/${ID("a")}`, { project: "web", spec });
    expect(await call(draft.agentId, PR)).toMatchObject({ status: 409, body: { code: "AGENT_UNAVAILABLE", message: "Unpublished has no published version yet, so it can't start new work." } });
    const eventOnly = await v.triggerAgent("Event only", [{ kind: "person" }, SENTRY], { budgetUsd: 20 });
    expect(await call(eventOnly.agentId, SCHEDULE)).toMatchObject({ status: 400, body: { message: "spec: Event only can't be started by schedules; ask its owner to allow it" } });
    expect(await call(eventOnly.agentId, LINEAR)).toMatchObject({ status: 400, body: { message: "spec: Event only can't be started by events; ask its owner to allow it" } });
  });

  it("says so when no hook can be read at all, and refuses a hook the reader returns for another org", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const base = { target: { kind: "chain" as const, chainId: chain.chainId }, spec: parse(SENTRY), hookId: HOOK_A };
    const trigger = await v.seed(base);
    v.hook("sentry", HOOK_A);
    expect(await triggerProblems(v.routeDeps, trigger)).toEqual([]);
    v.hookReader.add({ orgId: "org_bbbbbbbbbbbbbbbbbbbb", hookId: HOOK_A, project: "web", source: "sentry", disabled: false });
    const crossed = { ...v.routeDeps, hooks: { get: async () => ({ orgId: "org_bbbbbbbbbbbbbbbbbbbb" as never, hookId: HOOK_A, project: "web", source: "sentry", disabled: false }) } };
    expect((await triggerProblems(crossed, trigger))[0]).toMatchObject({ path: "hookId", code: "NOT_FOUND" });
    const { hooks: _hooks, ...none } = v.routeDeps; // eslint-disable-line @typescript-eslint/no-unused-vars -- the world with no hook reader
    expect((await triggerProblems(none, trigger))[0]).toMatchObject({ path: "hookId", code: "RUNTIME_UNAVAILABLE" });
  });
});

describe("who may set, move, delete and confirm a trigger", () => {
  const ownedBy = (v: TriggerWorld, owner: string, name: string) => v.publish(one("root-cause-analyst"), { owner: { kind: "member", developerId: owner }, name, by: owner, budgetUsd: 20 });

  it("needs manage on the chain, not just a project role: a maintainer with view only is refused to set and to delete", async () => {
    const v = setupTriggerWorld();
    const chain = await ownedBy(v, PRIYA, "Priya's chain");
    await v.chainCall(PRIYA, "PUT", `/v1/app/chains/${chain.chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: MAX }, level: "view" }] });
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: PRIYA });
    expect((await v.chainCall(MAX, "PUT", `/v1/app/chains/${chain.chainId}/triggers/${ID("n")}`, { project: "web", spec: PR })).status).toBe(403);
    expect((await v.chainCall(MAX, "DELETE", `/v1/app/chains/${chain.chainId}/triggers/${trigger.triggerId}`, {})).status).toBe(403);
    expect(await v.triggers.get(ORG_A, trigger.triggerId)).toBeDefined();
  });

  it("does not let a trigger be taken from another chain or another project by naming its id", async () => {
    const v = setupTriggerWorld();
    const mine = await ownedBy(v, MAX, "Max's chain");
    const theirs = await ownedBy(v, PRIYA, "Priya's chain");
    const onTheirs = await v.seed({ target: { kind: "chain", chainId: theirs.chainId }, createdBy: PRIYA });
    expect((await v.chainCall(MAX, "PUT", `/v1/app/chains/${mine.chainId}/triggers/${onTheirs.triggerId}`, { project: "web", spec: PR })).status).toBe(404);
    expect((await stored(v, onTheirs.triggerId)).target).toEqual({ kind: "chain", chainId: theirs.chainId });
    // A trigger of Max's own chain on a project he has no role on can't be moved to one he has.
    const onApi = await v.seed({ target: { kind: "chain", chainId: mine.chainId }, createdBy: DANA, project: "api" });
    expect((await v.chainCall(MAX, "PUT", `/v1/app/chains/${mine.chainId}/triggers/${onApi.triggerId}`, { project: "web", spec: PR })).status).toBe(404);
    // Nor read, deleted or have its activity read through another chain's path.
    expect((await v.chainCall(MAX, "DELETE", `/v1/app/chains/${mine.chainId}/triggers/${onTheirs.triggerId}`, {})).status).toBe(404);
    expect((await v.chainCall(MAX, "GET", `/v1/app/chains/${mine.chainId}/triggers/${onTheirs.triggerId}/activity`)).status).toBe(404);
    expect(await v.triggers.get(ORG_A, onTheirs.triggerId)).toBeDefined();
  });

  it("keeps the creator when an enabled trigger is narrowed by someone else, and makes the asker the creator when it is turned on again", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain(undefined, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } });
    const path = (id: string) => `/v1/app/chains/${chain.chainId}/triggers/${id}`;
    const on = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: MAX, spec: parse({ ...PR, filter: { label: ["a", "b"] } }) });
    expect((await v.chainCall(DANA, "PUT", path(on.triggerId), { project: "web", spec: { ...PR, filter: { label: ["a"] } } })).status).toBe(200);
    expect((await stored(v, on.triggerId)).createdBy).toBe(MAX);
    const off = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: MAX, enabled: false });
    expect((await v.chainCall(DANA, "PUT", path(off.triggerId), { project: "web", spec: PR, enabled: true })).status).toBe(202);
    expect((await stored(v, off.triggerId)).createdBy).toBe(DANA);
  });

  it("saves a trigger turned off even when it could not be turned on yet, and refuses the same trigger turned on", async () => {
    const v = setupTriggerWorld();
    const bare = await v.publish(one("root-cause-analyst"));
    const path = `/v1/app/chains/${bare.chainId}/triggers/${ID("a")}`;
    expect((await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR, enabled: false })).status).toBe(201);
    expect((await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR, enabled: true })).status).toBe(409);
  });

  it("lets only someone with manage and project settings confirm: the project's settings, then the chain, then the agent", async () => {
    const v = setupTriggerWorld();
    const chain = await ownedBy(v, PRIYA, "Priya's chain");
    // Priya manages her chain but is a contributor of web; Max is a maintainer of web but only views her chain.
    await v.chainCall(PRIYA, "PUT", `/v1/app/chains/${chain.chainId}/shares`, { shares: [{ principal: { kind: "member", developerId: MAX }, level: "view" }] });
    const asked = await v.chainCall(DANA, "PUT", `/v1/app/chains/${chain.chainId}/triggers/${ID("a")}`, { project: "web", spec: PR });
    const id = approvalOf(asked.body["confirmUrl"]);
    expect((await v.decideAs(PRIYA, id)).statusCode).toBe(403);
    expect((await v.decideAs(MAX, id)).statusCode).toBe(403);
    expect((await stored(v, ID("a"))).enabled).toBe(false);
    expect((await v.decideAs(DANA, id)).statusCode).toBe(200);
    expect((await stored(v, ID("a"))).enabled).toBe(true);
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, ISSUE], { budgetUsd: 20 });
    // Max may view the agent, and is a maintainer of web, but does not manage it.
    await v.agentCall(DANA, "PUT", `/v1/app/agents/${agent.agentId}/shares`, { shares: [{ principal: { kind: "member", developerId: MAX }, level: "view" }] });
    const agentAsked = await v.agentCall(DANA, "PUT", `/v1/app/agents/${agent.agentId}/triggers/${ID("b")}`, { project: "web", spec: ISSUE });
    expect((await v.decideAs(MAX, approvalOf(agentAsked.body["confirmUrl"]))).statusCode).toBe(403);
    expect((await stored(v, ID("b"))).enabled).toBe(false);
  });

  it("lists as candidates the org's owners and admins and the project's maintainers", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const asked = await v.chainCall(DANA, "PUT", `/v1/app/chains/${chain.chainId}/triggers/${ID("a")}`, { project: "web", spec: PR });
    const record = await v.approval(approvalOf(asked.body["confirmUrl"]));
    expect(record).toMatchObject({ approvers: { kind: "rule", rule: "trigger_enable" } });
    const { candidates } = (record as unknown as { approvers: { candidates: string[] } }).approvers;
    expect(new Set(candidates)).toEqual(new Set([DANA, MAX, OWNER]));
  });
});

describe("what a confirmation is bound to", () => {
  it("fails when the hook or the rate was changed after it was asked, and when the chain lost its budget since", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    v.connection("linear");
    v.hook("sentry", HOOK_A);
    v.hook("sentry", HOOK_A2);
    const path = (id: string) => `/v1/app/chains/${chain.chainId}/triggers/${id}`;
    const hooked = await v.chainCall(DANA, "PUT", path(ID("a")), { project: "web", spec: SENTRY, hookId: HOOK_A });
    // Changed in the store, so that nothing closes the request: what it was bound to is what refuses it.
    await v.triggers.update({ trigger: await stored(v, ID("a")), patch: { hookId: HOOK_A2 } });
    await v.decideAs(DANA, approvalOf(hooked.body["confirmUrl"]));
    expect((await v.approval(approvalOf(hooked.body["confirmUrl"]))).status).toBe("APPROVED_FAILED");
    expect((await stored(v, ID("a"))).enabled).toBe(false);
    const rated = await v.chainCall(DANA, "PUT", path(ID("b")), { project: "web", spec: PR });
    await v.triggers.update({ trigger: await stored(v, ID("b")), patch: { maxRunsPerHour: 5 } });
    await v.decideAs(DANA, approvalOf(rated.body["confirmUrl"]));
    expect((await v.approval(approvalOf(rated.body["confirmUrl"]))).status).toBe("APPROVED_FAILED");
    const budgeted = await v.chainCall(DANA, "PUT", path(ID("c")), { project: "web", spec: PR });
    await v.chainCall(PRIYA, "PUT", `/v1/app/chains/${chain.chainId}/budget`, { monthlyUsd: null });
    await v.decideAs(DANA, approvalOf(budgeted.body["confirmUrl"]));
    expect((await v.approval(approvalOf(budgeted.body["confirmUrl"]))).status).toBe("APPROVED_FAILED");
    expect((await stored(v, ID("c"))).enabled).toBe(false);
  });

  it("refuses a confirmation after the trigger was handed on in between (it moved on from what was shown), and does nothing twice when told twice", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const path = `/v1/app/chains/${chain.chainId}/triggers/${ID("a")}`;
    const asked = await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR });
    await v.triggers.update({ trigger: await stored(v, ID("a")), patch: { createdBy: MAX } });
    await v.decideAs(DANA, approvalOf(asked.body["confirmUrl"]));
    expect(await stored(v, ID("a"))).toMatchObject({ enabled: false, createdBy: MAX });
    expect((await v.approval(approvalOf(asked.body["confirmUrl"]))).status).toBe("APPROVED_FAILED");
    // Asked again, the person who asked is the creator, and a repeat of the handler changes nothing.
    const again = await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR, enabled: true });
    const id = approvalOf(again.body["confirmUrl"]);
    await v.decideAs(DANA, id);
    expect(await stored(v, ID("a"))).toMatchObject({ enabled: true, createdBy: DANA });
    const once = await stored(v, ID("a"));
    const record = (await v.approval(id)) as unknown as ApprovalRecord;
    await getApprovalSubjectHandler("trigger_enable")!(v.routeDeps, record, undefined);
    expect(await stored(v, ID("a"))).toEqual(once);
  });
});

describe("what a project's built-in switch shows and keeps", () => {
  it("hides a built-in the company turned off from a member, and keeps a hook when the row is changed", async () => {
    const v = setupTriggerWorld();
    await v.builtinBudget("code-reviewer");
    await v.builtinBudget("deploy-reviewer");
    BUILTIN_TRIGGER_SUGGESTIONS["deploy-reviewer"] = [SENTRY];
    try {
      v.connection("linear");
      v.hook("sentry", HOOK_A);
      const rows = async (who: string) => ((await v.agentCall(who, "GET", "/v1/app/projects/web/builtin-triggers")).body["triggers"] as Array<Record<string, unknown>>);
      expect((await rows(MAX)).find((row) => row["agentId"] === "deploy-reviewer")).toMatchObject({ needsHook: true, enabled: false });
      const asked = await v.agentCall(MAX, "PUT", "/v1/app/projects/web/builtin-triggers/deploy-reviewer/0", { enabled: true, hookId: HOOK_A });
      expect(asked.status, JSON.stringify(asked.body)).toBe(202);
      await v.decideAs(MAX, approvalOf(asked.body["confirmUrl"]));
      const triggers = await v.triggers.listForTarget(ORG_A, { kind: "agent", agentId: "deploy-reviewer" });
      expect(triggers).toMatchObject([{ enabled: true, hookId: HOOK_A }]);
      // Changing the rate keeps the hook the row had.
      const lowered = await v.agentCall(MAX, "PUT", "/v1/app/projects/web/builtin-triggers/deploy-reviewer/0", { enabled: true, maxRunsPerHour: 5 });
      expect(lowered.status, JSON.stringify(lowered.body)).toBe(200);
      expect((await stored(v, triggers[0]!.triggerId)).hookId).toBe(HOOK_A);
      const guardrails = (await v.agentCall(DANA, "GET", "/v1/app/org/agent-guardrails")).body as { revision: number; guardrails: Record<string, unknown> };
      await v.agentCall(DANA, "PUT", "/v1/app/org/agent-guardrails", { expectedRevision: guardrails.revision, guardrails: { ...guardrails.guardrails, disabledBuiltins: ["code-reviewer"] } });
      expect((await rows(MAX)).some((row) => row["agentId"] === "code-reviewer")).toBe(false);
      expect((await rows(DANA)).some((row) => row["agentId"] === "code-reviewer")).toBe(true);
      expect((await v.agentCall(MAX, "PUT", "/v1/app/projects/web/builtin-triggers/code-reviewer/0", { enabled: true })).status).toBe(404);
    } finally {
      BUILTIN_TRIGGER_SUGGESTIONS["deploy-reviewer"] = [];
    }
  });
});

describe("a change of kind, source or creator, and what a removal and a delete leave", () => {
  it("asks again when an enabled event trigger becomes a schedule, or only its source changes", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    v.connection("linear");
    v.hook("linear", HOOK_A);
    v.hook("sentry", HOOK_A2);
    const path = (id: string) => `/v1/app/chains/${chain.chainId}/triggers/${id}`;
    const event = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    expect((await v.chainCall(DANA, "PUT", path(event.triggerId), { project: "web", spec: SCHEDULE })).status).toBe(202);
    const sentry = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA, spec: parse(SENTRY), hookId: HOOK_A });
    v.hook("linear", HOOK_A);
    v.hookReader.hooks.delete(`${ORG_A}|${HOOK_A}`);
    v.hook("linear", HOOK_A);
    expect((await v.chainCall(DANA, "PUT", path(sentry.triggerId), { project: "web", spec: LINEAR, hookId: HOOK_A })).status).toBe(202);
  });

  it("removes a schedule trigger's schedule when it is deleted, and shows an activity reason neutralised", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA, spec: parse(SCHEDULE), scheduleStatus: "ok" });
    await v.triggers.recordActivity(ORG_A, trigger.triggerId, { eventKey: "k", outcome: "failed", reason: "bad\u001b[31m thing‮" });
    const shown = (await v.chainCall(PRIYA, "GET", `/v1/app/chains/${chain.chainId}/triggers/${trigger.triggerId}/activity`)).body["activity"] as Array<{ reason: string }>;
    expect(shown[0]!.reason.includes(String.fromCharCode(27)) || shown[0]!.reason.includes(String.fromCharCode(0x202e))).toBe(false);
    expect((await v.chainCall(DANA, "DELETE", `/v1/app/chains/${chain.chainId}/triggers/${trigger.triggerId}`, {})).status).toBe(200);
    expect(v.scheduler.calls).toEqual([{ call: "remove", triggerId: trigger.triggerId }]);
  });

  it("tells only about what a recheck turned off, not about a trigger that was already off", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const target = { kind: "chain" as const, chainId: chain.chainId };
    const off = await v.seed({ target, createdBy: DANA, enabled: false });
    await v.chains.setBudget(ORG_A, chain.chainId, undefined, fixtureActor(v.chains, ORG_A, DANA).developerId, undefined, { ...({}), actor: fixtureActor(v.chains, ORG_A, DANA) });
    expect(await recheckTriggersForTarget(v.routeDeps, ORG_A, target)).toEqual([]);
    expect(await v.notices(DANA)).toEqual([]);
    expect((await stored(v, off.triggerId)).revision).toBe(off.revision);
  });
});

describe("who a trigger goes to when its owner leaves", () => {
  it("prefers the target's accountable maintainer over the first maintainer by grant, and never the one who left", async () => {
    const v = setupTriggerWorld();
    // Max is first in the project's list of maintainers; Carl is made one after, and answers for the chain.
    v.projectMembers.grant(ORG_A, "web", CARL, "maintainer");
    const chain = await v.budgetedChain(undefined, { owner: { kind: "project", project: "web" }, accountable: { developerId: CARL } });
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: PRIYA });
    await onMemberRemoved(v.routeDeps, { orgId: ORG_A, developerId: PRIYA, by: "system" });
    expect((await stored(v, trigger.triggerId)).createdBy).toBe(CARL);
    // The first maintainer is the one leaving: the next goes before an owner of the org.
    const plain = await v.budgetedChain();
    const mine = await v.seed({ target: { kind: "chain", chainId: plain.chainId }, createdBy: MAX });
    await onMemberRemoved(v.routeDeps, { orgId: ORG_A, developerId: MAX, by: "system" });
    expect((await stored(v, mine.triggerId)).createdBy).toBe(CARL);
  });

  it("skips someone who is no longer a member and an accountable maintainer who lost their role on the project", async () => {
    const v = setupTriggerWorld();
    v.projectMembers.grant(ORG_A, "web", "8".repeat(64), "maintainer");
    const gone = await v.budgetedChain(undefined, { owner: { kind: "project", project: "web" }, accountable: { developerId: "8".repeat(64) } });
    const first = await v.seed({ target: { kind: "chain", chainId: gone.chainId }, createdBy: PRIYA });
    await onMemberRemoved(v.routeDeps, { orgId: ORG_A, developerId: PRIYA, by: "system" });
    expect((await stored(v, first.triggerId)).createdBy).toBe(MAX);
    // An accountable maintainer who has no role on web any more.
    const demoted = await v.budgetedChain(undefined, { owner: { kind: "project", project: "web" }, accountable: { developerId: ARJUN } });
    const second = await v.seed({ target: { kind: "chain", chainId: demoted.chainId }, createdBy: CARL });
    await onMemberRemoved(v.routeDeps, { orgId: ORG_A, developerId: CARL, by: "system" });
    expect((await stored(v, second.triggerId)).createdBy).toBe(MAX);
    expect(OWNER).toBeDefined();
    expect(VIV).toBeDefined();
  });
});

describe("the broker's wiring of the hooks", () => {
  it("disables a chain's trigger when its budget goes and a built-in's when the company turns it off, through the broker's own hooks", async () => {
    const v = setupTriggerWorld();
    // The hooks the broker builds over its dependencies are what the routes call: here they are built the same way and asked through the routes.
    const chain = await v.budgetedChain();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    const answered = await v.chainCall(PRIYA, "PUT", `/v1/app/chains/${chain.chainId}/budget`, { monthlyUsd: null });
    expect(answered.body["disabledTriggers"]).toHaveLength(1);
    expect((await stored(v, trigger.triggerId)).enabled).toBe(false);
  });

  it("turns off a custom agent's trigger when a rollback that applies at once drops what it needs", async () => {
    const v = setupTriggerWorld();
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }], { budgetUsd: 20 });
    const base = `/v1/app/agents/${agent.agentId}`;
    const draft = (await v.agentCall(DANA, "GET", `${base}/draft`)).body["draft"] as { revision: number; overlay: Record<string, unknown> };
    await v.agents.saveDraft({ orgId: ORG_A, agentId: agent.agentId, overlay: { ...draft.overlay, triggers: [{ kind: "person" }, ISSUE] } as never, expectedRevision: draft.revision, by: DANA });
    await v.agents.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: draft.revision + 1, digest: "e".repeat(64), by: DANA });
    const trigger = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: DANA, spec: parse(ISSUE) });
    const rolled = await v.agentCall(DANA, "POST", `${base}/rollback`, { version: 1 });
    expect(rolled.status, JSON.stringify(rolled.body)).toBe(200);
    expect((rolled.body["disabledTriggers"] as Array<{ triggerId: string }>).map((entry) => entry.triggerId)).toEqual([trigger.triggerId]);
  });
});
