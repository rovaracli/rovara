// Plan 4 Task 18, Opus review fixes (2026-10-23): I-2 (a built-in's trigger id belongs to the built-in), I-3 and M-3 (a request to turn a trigger on dies with the state it was
// made for, and only the latest one can be confirmed), M-1 (the owner rule checks `use` on a custom agent) and M-2 (a missing chain store fails closed). I-1 (no link in
// the gate_waiting event) is in chain-gates.test.ts and chain-view.test.ts.
import { afterEach, describe, expect, it } from "vitest";
import { TriggerSpecSchema } from "@rovara-code/contracts";
import { orgOpenApprovalKey } from "@agentx/cloud-contracts";
import { getApprovalSubjectHandler } from "../../packages/broker/src/agents/approvals.js";
import { builtinTriggerIdFor } from "../../packages/broker/src/triggers/routes.js";
import { closeTriggerEnableApproval } from "../../packages/broker/src/triggers/lifecycle.js";
import { ownerQualifies, triggerProblems } from "../../packages/broker/src/triggers/requirements.js";
import { CARL, DANA, MAX, ORG_A, PRIYA, disposeGateWorlds, rid, setupTriggerWorld, type TriggerWorld } from "../support/trigger-world.js";

afterEach(disposeGateWorlds);

const ISSUE = { kind: "event" as const, source: "github" as const, type: "issues.opened" };
const PR_OPENED = { kind: "event", source: "github", type: "pull_request.opened" };
const stored = async (v: TriggerWorld, triggerId: string) => (await v.triggers.get(ORG_A, triggerId))!;
const approvalOf = (called: { body: Record<string, unknown> }) => String(called.body["confirmUrl"]).split("/").pop()!;
const ID = (letter: string) => `ctr_${letter.repeat(20)}`;
/** What confirming through the API as `who` did: "went through" or the refusal's code. */
const confirmed = (v: TriggerWorld, who: string, approvalId: string) => v.decideRoute(who, approvalId).then(() => "went through", (error: { code?: string }) => error.code);

describe("I-2: a built-in's trigger id is the built-in's", () => {
  async function agentWorld() {
    const v = setupTriggerWorld();
    await v.builtinBudget("code-reviewer");
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, ISSUE], { budgetUsd: 20 });
    return { v, agent, builtinId: builtinTriggerIdFor(ORG_A, "web", "code-reviewer", 0) };
  }

  it("refuses a trigger of a custom agent put under an id the switch derives, for this project and for another, and stores nothing", async () => {
    const { v, agent, builtinId } = await agentWorld();
    for (const id of [builtinId, builtinTriggerIdFor(ORG_A, "api", "code-reviewer", 0), builtinTriggerIdFor(ORG_A, "web", "rovara-code", 3)]) {
      const put = await v.agentCall(DANA, "PUT", `/v1/app/agents/${agent.agentId}/triggers/${id}`, { project: "web", spec: ISSUE, enabled: false });
      expect(put.status, id).toBe(400);
      expect(await v.triggers.get(ORG_A, id)).toBeUndefined();
    }
    // An id of one's own is still fine.
    expect((await v.agentCall(DANA, "PUT", `/v1/app/agents/${agent.agentId}/triggers/${ID("a")}`, { project: "web", spec: ISSUE, enabled: false })).status).toBe(201);
  });

  it("leaves a record under the id that is not this built-in's on this project alone: the switch refuses it, on or off, and its row does not show it", async () => {
    const { v, agent, builtinId } = await agentWorld();
    const foreign = await v.triggers.create({ record: {
      orgId: ORG_A, triggerId: builtinId, target: { kind: "agent", agentId: agent.agentId }, project: "web", spec: TriggerSpecSchema.parse(ISSUE) as never, enabled: true, maxRunsPerHour: 30, createdBy: DANA,
    } });
    const otherProject = await v.triggers.create({ record: {
      orgId: ORG_A, triggerId: builtinTriggerIdFor(ORG_A, "web", "code-reviewer", 1), target: { kind: "agent", agentId: "code-reviewer" }, project: "api", spec: TriggerSpecSchema.parse(PR_OPENED) as never, enabled: true, maxRunsPerHour: 30, createdBy: DANA,
    } });
    for (const enabled of [true, false]) {
      const put = await v.agentCall(MAX, "PUT", "/v1/app/projects/web/builtin-triggers/code-reviewer/0", { enabled });
      expect(put.status, String(enabled)).toBe(400);
    }
    expect(await stored(v, builtinId)).toEqual(foreign);
    const rows = (await v.agentCall(MAX, "GET", "/v1/app/projects/web/builtin-triggers")).body["triggers"] as Array<Record<string, unknown>>;
    expect(rows.find((row) => row["agentId"] === "code-reviewer" && row["index"] === 0)).toMatchObject({ enabled: false });
    expect(rows.find((row) => row["agentId"] === "code-reviewer" && row["index"] === 0)).not.toHaveProperty("triggerId");
    expect(JSON.stringify(rows)).not.toContain(foreign.triggerId);
    expect(JSON.stringify(rows)).not.toContain(otherProject.triggerId);
  });
});

describe("I-2: a record of another project under the id is not this project's row", () => {
  it("is refused by the switch and hidden from its row", async () => {
    const v = setupTriggerWorld();
    await v.builtinBudget("code-reviewer");
    const id = builtinTriggerIdFor(ORG_A, "web", "code-reviewer", 0);
    await v.triggers.create({ record: { orgId: ORG_A, triggerId: id, target: { kind: "agent", agentId: "code-reviewer" }, project: "api", spec: TriggerSpecSchema.parse(PR_OPENED) as never, enabled: true, maxRunsPerHour: 30, createdBy: DANA } });
    expect((await v.agentCall(MAX, "PUT", "/v1/app/projects/web/builtin-triggers/code-reviewer/0", { enabled: false })).status).toBe(400);
    const rows = (await v.agentCall(MAX, "GET", "/v1/app/projects/web/builtin-triggers")).body["triggers"] as Array<Record<string, unknown>>;
    expect(rows.find((row) => row["agentId"] === "code-reviewer")).toMatchObject({ enabled: false });
  });
});

describe("I-3 and M-3: a request to turn a trigger on dies with the state it was made for", () => {
  /** A project-owned chain, so that Dana (an admin) and Max (a maintainer of web) may both ask. */
  async function projectChain() {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain(undefined, { owner: { kind: "project", project: "web" }, accountable: { developerId: MAX } } as never);
    const path = `/v1/app/chains/${chain.chainId}/triggers/${ID("a")}`;
    return { v, chain, path };
  }

  it("closes the pending request when the trigger is turned off, and confirming it later turns nothing on", async () => {
    const { v, path } = await projectChain();
    const asked = await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR_OPENED });
    expect(asked.status).toBe(202);
    const approvalId = approvalOf(asked);
    expect((await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR_OPENED, enabled: false })).status).toBe(200);
    expect(await v.approval(approvalId)).toMatchObject({ status: "EXPIRED", closedBy: "system" });
    expect(await confirmed(v, DANA, approvalId)).toBe("APPROVAL_CLOSED");
    expect((await stored(v, ID("a"))).enabled).toBe(false);
  });

  it("closes the pending request when the spec changes, and only the new request turns the new spec on", async () => {
    const { v, path } = await projectChain();
    const first = await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR_OPENED });
    const second = await v.chainCall(DANA, "PUT", path, { project: "web", spec: { ...PR_OPENED, filter: { label: ["bug"] } }, enabled: true });
    expect(second.status, JSON.stringify(second.body)).toBe(202);
    expect(await v.approval(approvalOf(first))).toMatchObject({ status: "EXPIRED" });
    expect(await confirmed(v, DANA, approvalOf(first))).toBe("APPROVAL_CLOSED");
    expect((await stored(v, ID("a"))).enabled).toBe(false);
    expect(await confirmed(v, DANA, approvalOf(second))).toBe("went through");
    expect(await stored(v, ID("a"))).toMatchObject({ enabled: true, spec: { filter: { label: ["bug"] } } });
  });

  it("lets only the latest request for the same spec be confirmed, and makes its requester the creator", async () => {
    const { v, path } = await projectChain();
    const byDana = await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR_OPENED });
    const byMax = await v.chainCall(MAX, "PUT", path, { project: "web", spec: PR_OPENED, enabled: true });
    expect(byMax.status, JSON.stringify(byMax.body)).toBe(202);
    expect(await confirmed(v, DANA, approvalOf(byDana))).toBe("APPROVAL_CLOSED");
    expect(await stored(v, ID("a"))).toMatchObject({ enabled: false, createdBy: MAX });
    expect(await confirmed(v, DANA, approvalOf(byMax))).toBe("went through");
    expect(await stored(v, ID("a"))).toMatchObject({ enabled: true, createdBy: MAX });
  });

  it("refuses a request that was bound to an earlier revision of the trigger even when nothing closed it", async () => {
    const { v, path } = await projectChain();
    const asked = await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR_OPENED });
    // A write to the trigger that the close does not see (what a repair or a recheck would do): the approval was bound to the revision it was shown.
    await v.triggers.update({ trigger: await stored(v, ID("a")), patch: { disabledReason: "waiting for someone to confirm turning it on (again)" } });
    // The decision is recorded and applying it is refused (the page says it did not go through).
    await confirmed(v, DANA, approvalOf(asked));
    expect((await v.approval(approvalOf(asked))).status).toBe("APPROVED_FAILED");
    expect((await stored(v, ID("a"))).enabled).toBe(false);
  });

  it("clears the pending request from the trigger when it is confirmed, and answers a repeat of a closed request as closed", async () => {
    const { v, path } = await projectChain();
    const requestId = rid();
    const asked = await v.chainCall(DANA, "PUT", path, { requestId, project: "web", spec: PR_OPENED });
    expect((await stored(v, ID("a"))).pendingApprovalId).toBe(approvalOf(asked));
    await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR_OPENED, enabled: false });
    expect((await stored(v, ID("a"))).pendingApprovalId).toBeUndefined();
    expect(await v.chainCall(DANA, "PUT", path, { requestId, project: "web", spec: PR_OPENED })).toMatchObject({ status: 409, body: { code: "APPROVAL_CLOSED" } });
    const again = await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR_OPENED, enabled: true });
    expect(await confirmed(v, DANA, approvalOf(again))).toBe("went through");
    expect(await stored(v, ID("a"))).toMatchObject({ enabled: true });
    expect((await stored(v, ID("a"))).pendingApprovalId).toBeUndefined();
  });

  it("closes only a pending request that is this trigger's own", async () => {
    const { v, path } = await projectChain();
    const asked = await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR_OPENED });
    const deps = v.routeDeps;
    expect(await closeTriggerEnableApproval(deps, ORG_A, ID("b"), approvalOf(asked), "x")).toBe(false);
    expect(await closeTriggerEnableApproval(deps, ORG_A, ID("a"), "not-an-approval", "x")).toBe(false);
    const pending = await v.approval(approvalOf(asked));
    expect(pending.status).toBe("PENDING");
    expect(v.db.get(orgOpenApprovalKey(ORG_A, pending.createdAt, approvalOf(asked) as never)), "listed in the company's open index while PENDING").toBeDefined();
    expect(await closeTriggerEnableApproval(deps, ORG_A, ID("a"), approvalOf(asked), "x")).toBe(true);
    expect(v.db.get(orgOpenApprovalKey(ORG_A, pending.createdAt, approvalOf(asked) as never)), "dropped with the close").toBeUndefined();
    expect(await closeTriggerEnableApproval(deps, ORG_A, ID("a"), approvalOf(asked), "x")).toBe(false);
  });

  it("still finishes a confirmation that was applied and told again", async () => {
    const { v, path } = await projectChain();
    const asked = await v.chainCall(DANA, "PUT", path, { project: "web", spec: PR_OPENED });
    expect(await confirmed(v, DANA, approvalOf(asked))).toBe("went through");
    // The sweep tells the handler again (it did not hear the first time): the trigger has moved on since, and the handler still finishes quietly.
    await getApprovalSubjectHandler("trigger_enable")!(v.routeDeps, await v.approval(approvalOf(asked)));
    expect((await stored(v, ID("a"))).enabled).toBe(true);
  });
});

describe("M-1: the owner of a custom agent's trigger must still be able to use the agent", () => {
  it("reports a creator without `use` on the agent, and accepts one who is shared the agent", async () => {
    const v = setupTriggerWorld();
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, ISSUE], { budgetUsd: 20, owner: DANA });
    const trigger = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: CARL, spec: TriggerSpecSchema.parse(ISSUE) as never });
    const problems = await triggerProblems(v.routeDeps, trigger);
    expect(problems.map((problem) => problem.path)).toContain("createdBy");
    expect(problems.find((problem) => problem.path === "createdBy")!.message).toContain("can no longer use Triage bot");
    expect(await ownerQualifies(v.routeDeps, trigger, CARL)).toBe(false);
    expect((await v.agentCall(DANA, "PUT", `/v1/app/agents/${agent.agentId}/shares`, { shares: [{ principal: { kind: "member", developerId: CARL }, level: "use" }] })).status).toBe(200);
    expect(await triggerProblems(v.routeDeps, trigger)).toEqual([]);
    expect(await ownerQualifies(v.routeDeps, trigger, CARL)).toBe(true);
  });

  it("wants `use`, not `view`", async () => {
    const v = setupTriggerWorld();
    const agent = await v.triggerAgent("Triage bot", [{ kind: "person" }, ISSUE], { budgetUsd: 20, owner: DANA });
    const trigger = await v.seed({ target: { kind: "agent", agentId: agent.agentId }, createdBy: CARL, spec: TriggerSpecSchema.parse(ISSUE) as never });
    await v.agentCall(DANA, "PUT", `/v1/app/agents/${agent.agentId}/shares`, { shares: [{ principal: { kind: "member", developerId: CARL }, level: "view" }] });
    expect((await triggerProblems(v.routeDeps, trigger)).map((problem) => problem.path)).toContain("createdBy");
    expect(await ownerQualifies(v.routeDeps, trigger, CARL)).toBe(false);
  });

  it("asks nothing of a built-in, which everyone may use", async () => {
    const v = setupTriggerWorld();
    await v.builtinBudget("code-reviewer");
    const trigger = await v.seed({ target: { kind: "agent", agentId: "code-reviewer" }, createdBy: CARL, spec: TriggerSpecSchema.parse(PR_OPENED) as never });
    expect(await triggerProblems(v.routeDeps, trigger)).toEqual([]);
    expect(await ownerQualifies(v.routeDeps, trigger, CARL)).toBe(true);
  });
});

describe("M-2: without a chain store a chain trigger does not qualify", () => {
  it("answers a problem from triggerProblems and false from ownerQualifies", async () => {
    const v = setupTriggerWorld();
    const chain = await v.budgetedChain();
    const trigger = await v.seed({ target: { kind: "chain", chainId: chain.chainId }, createdBy: DANA });
    expect(await triggerProblems(v.routeDeps, trigger)).toEqual([]);
    const without = { ...v.routeDeps, chains: undefined } as unknown as typeof v.routeDeps;
    expect(await triggerProblems(without, trigger)).toEqual([expect.objectContaining({ path: "target", code: "RUNTIME_UNAVAILABLE" })]);
    expect(await ownerQualifies(without, trigger, PRIYA)).toBe(false);
    expect(await ownerQualifies(v.routeDeps, trigger, PRIYA)).toBe(true);
  });
});
