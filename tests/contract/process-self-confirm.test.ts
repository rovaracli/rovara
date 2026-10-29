// "How we work" (H4): a process layer's less-safe change (a plan check or review that changes) waits on the confirmation page, and the person who asked cannot confirm their own
// change unless they are the only one who could. Ordinary agents are judged and confirmed exactly as before.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID, type AgentId, type OrgRole } from "../../packages/contracts/src/index.js";
import { decideApproval, getAnyApproval } from "../../packages/broker/src/agents/approvals.js";
import { confirmedBySoleOwner } from "../../packages/broker/src/playbook/process-approvals.js";
import { publishDraft, rollbackAgent } from "../../packages/broker/src/agents/changes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import type { ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { ARJUN, MAX, OLA, ORG_A, PRIYA } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";
import { agentXError } from "../../packages/contracts/src/index.js";

const MESSAGE = "Someone else who can approve changes in this project must confirm this.";
const ROLES: Record<string, OrgRole> = { [OLA]: "admin" };
const callerOf = (w: MergeWorld, who: string) => ({ ...w.caller(who), orgRole: ROLES[who] ?? "member" });
function audited(w: MergeWorld): MergeWorld {
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  return w;
}
const world = () => audited(baseWorld());
function playbookDeps(w: MergeWorld): ProjectPlaybookDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
  };
}
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; statusCode?: number; message: string }) => ({ code: error.code, status: error.statusCode, message: error.message }));

/** The overlay sets the review step's instructions (`undefined` leaves the step alone) and Build's. */
async function setDraft(w: MergeWorld, agentId: AgentId, steps: Record<string, { instructions: string }>) {
  const agent = (await w.store.get(ORG_A, agentId))!;
  await w.store.saveDraft({ orgId: ORG_A, agentId, overlay: { steps }, expectedRevision: agent.draftRevision, by: MAX });
  return (await w.store.get(ORG_A, agentId))!;
}
const publish = async (w: MergeWorld, who: string, agentId: AgentId) => {
  const agent = (await w.store.get(ORG_A, agentId))!;
  return publishDraft(w.deps, callerOf(w, who), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
};

/** A process layer for web with its first (safe) version published. */
async function processLayer(w: MergeWorld): Promise<AgentId> {
  const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
  expect(await publish(w, MAX, agentId)).toMatchObject({ applied: true, value: { version: 1 } });
  return agentId;
}
/** An ordinary custom agent of the project, extending Rovara Code, with its first version published. */
async function ordinaryAgent(w: MergeWorld): Promise<AgentId> {
  const created = await w.store.create({ orgId: ORG_A, name: "reviewer", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
  expect(await publish(w, MAX, created.agentId)).toMatchObject({ applied: true });
  return created.agentId;
}
const approvalIdOf = (w: MergeWorld, result: { applied: boolean }) => w.approvalIdOf((result as unknown as { confirmUrl: string }).confirmUrl);
const body = (decision: "APPROVE" | "DECLINE" = "APPROVE") => ({ requestId: randomUUID(), decision });
const decide = (w: MergeWorld, who: string, approvalId: string, decision: "APPROVE" | "DECLINE" = "APPROVE") => decideApproval(w.deps, callerOf(w, who), approvalId, body(decision));

describe("what a process layer's publish waits for", () => {
  it("a changed review step's instructions wait for a person (202-style), where the same change to an ordinary agent applies at once", async () => {
    const w = world();
    const layer = await processLayer(w);
    await setDraft(w, layer, { review: { instructions: "Be strict about tests." } });
    const waiting = await publish(w, MAX, layer);
    expect(waiting).toMatchObject({ applied: false, changes: ['Changes the instructions of the review step "Review"'] });

    const ordinary = await ordinaryAgent(w);
    await setDraft(w, ordinary, { review: { instructions: "Be strict about tests." } });
    expect(await publish(w, MAX, ordinary)).toMatchObject({ applied: true, value: { version: 2 } });
  });

  it("a change to the build step's instructions applies at once", async () => {
    const w = world();
    const layer = await processLayer(w);
    await setDraft(w, layer, { build: { instructions: "Run the linter before you finish." } });
    expect(await publish(w, MAX, layer)).toMatchObject({ applied: true, value: { version: 2 } });
  });

  it("a rollback that undoes the review instructions of a process layer waits too, and an ordinary agent's does not", async () => {
    const w = world();
    const layer = await processLayer(w);
    await setDraft(w, layer, { build: { instructions: "Run the linter." } });
    expect(await publish(w, MAX, layer)).toMatchObject({ applied: true });
    // v1 has no review instructions; build a v3 that has them by confirming it, then roll back to v2 (which has none).
    await setDraft(w, layer, { build: { instructions: "Run the linter." }, review: { instructions: "Be strict." } });
    const waiting = await publish(w, MAX, layer);
    await decide(w, OLA, approvalIdOf(w, waiting));
    const rolled = await rollbackAgent(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, layer))!, { requestId: randomUUID(), version: 2 });
    expect(rolled).toMatchObject({ applied: false, changes: ['Changes the instructions of the review step "Review"'] });

    const ordinary = await ordinaryAgent(w);
    await setDraft(w, ordinary, { build: { instructions: "Run the linter." } });
    await publish(w, MAX, ordinary);
    await setDraft(w, ordinary, { build: { instructions: "Run the linter." }, review: { instructions: "Be strict." } });
    await publish(w, MAX, ordinary);
    expect(await rollbackAgent(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, ordinary))!, { requestId: randomUUID(), version: 2 })).toMatchObject({ applied: true });
  });
});

describe("the person who asked cannot confirm their own process change", () => {
  async function pending(w: MergeWorld, requester = MAX) {
    const layer = await processLayer(w);
    await setDraft(w, layer, { review: { instructions: "Be strict about tests." } });
    const waiting = await publish(w, requester, layer);
    expect(waiting.applied).toBe(false);
    return { layer, approvalId: approvalIdOf(w, waiting) };
  }

  it("refuses the requester with the fixed code and words (403) while another approver exists, and leaves the change pending", async () => {
    const w = world();
    const { layer, approvalId } = await pending(w);
    const refused = await failure(decide(w, MAX, approvalId));
    expect(refused).toEqual({ code: "PROCESS_SELF_CONFIRM", status: 403, message: `PROCESS_SELF_CONFIRM: ${MESSAGE}` });
    expect((await getAnyApproval(w.deps, ORG_A, approvalId))!.status).toBe("PENDING");
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
    expect(w.audit.recordedBy("process.published")).toHaveLength(1);
  });

  it("lets another maintainer confirm it: it applies, and the audit event says selfConfirmedSoleOwner false", async () => {
    const w = world();
    const { layer, approvalId } = await pending(w);
    await failure(decide(w, MAX, approvalId));
    await decide(w, OLA, approvalId);
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    expect(w.audit.recordedBy("process.published").at(-1)).toMatchObject({ actor: { id: OLA }, facts: { version: 2, safety: "less_safe", selfConfirmedSoleOwner: false } });
  });

  it("counts a project maintainer with manage_agents as another approver", async () => {
    const w = world();
    w.member(ORG_A, OLA, "member");
    w.grant(ARJUN, "web", "maintainer");
    const { layer, approvalId } = await pending(w);
    expect(await failure(decide(w, MAX, approvalId))).toMatchObject({ code: "PROCESS_SELF_CONFIRM" });
    await decide(w, ARJUN, approvalId);
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    expect(w.audit.recordedBy("process.published").at(-1)).toMatchObject({ facts: { selfConfirmedSoleOwner: false } });
  });

  it("does not count someone who can no longer approve (a contributor, or a maintainer removed since)", async () => {
    const w = world();
    w.member(ORG_A, OLA, "member");
    w.grant(ARJUN, "web", "maintainer");
    const { layer, approvalId } = await pending(w);
    w.members.revoke(ORG_A, "web", ARJUN);
    await decide(w, MAX, approvalId);
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
  });

  it("does not count the layer's accountable maintainer once they have lost the right to approve (the rule is read now)", async () => {
    const w = world();
    const layer = await processLayer(w);
    await setDraft(w, layer, { review: { instructions: "Be strict about tests." } });
    // Max stays the layer's accountable person but is no longer a maintainer; Ola, an org admin, is the only one who can approve.
    w.members.revoke(ORG_A, "web", MAX);
    const waiting = await publish(w, OLA, layer);
    expect(waiting.applied).toBe(false);
    await w.decide(approvalIdOf(w, waiting), await w.browser(OLA, approvalIdOf(w, waiting)));
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    expect(w.audit.recordedBy("process.published").at(-1)).toMatchObject({ actor: { id: OLA }, facts: { selfConfirmedSoleOwner: true } });
  });

  it("lets the requester confirm when they are the only eligible approver, with the fresh sign-in, and records selfConfirmedSoleOwner true", async () => {
    const w = world();
    w.member(ORG_A, OLA, "member");
    const { layer, approvalId } = await pending(w);
    // The confirmation page: a fresh sign-in is still required, and a bearer-style proof is not enough.
    const page = await w.kind.decide({ orgId: ORG_A, developerId: MAX, approvalId }, "approve", { kind: "none" } as never).then(() => "decided", (error: { code?: string }) => error.code);
    expect(page).toBe("FORBIDDEN");
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
    await w.decide(approvalId, await w.browser(MAX, approvalId));
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    expect(w.audit.recordedBy("process.published").at(-1)).toMatchObject({ actor: { id: MAX }, facts: { version: 2, safety: "less_safe", selfConfirmedSoleOwner: true } });
  });

  it("knows the requester through a merge: a duplicate account that was merged into the confirming member is the same person", async () => {
    const w = world();
    const DUPLICATE = "9".repeat(64);
    (w.deps as { resolveDeveloper?: (orgId: string, id: string) => Promise<string> }).resolveDeveloper = async (_orgId, id) => (id === DUPLICATE ? MAX : id);
    const layer = await processLayer(w);
    await setDraft(w, layer, { review: { instructions: "Be strict about tests." } });
    const agent = (await w.store.get(ORG_A, layer))!;
    const waiting = await publishDraft(w.deps, { ...callerOf(w, MAX), developerId: DUPLICATE }, agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    expect(waiting.applied).toBe(false);
    expect(await failure(decide(w, MAX, approvalIdOf(w, waiting)))).toMatchObject({ code: "PROCESS_SELF_CONFIRM" });
  });

  it("lets the requester decline their own request (it is not a confirmation)", async () => {
    const w = world();
    const { layer, approvalId } = await pending(w);
    await decide(w, MAX, approvalId, "DECLINE");
    expect((await getAnyApproval(w.deps, ORG_A, approvalId))!.status).toBe("DECLINED");
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
  });

  it("applies to a rollback of a process layer too", async () => {
    const w = world();
    const layer = await processLayer(w);
    await setDraft(w, layer, { review: { instructions: "Be strict." } });
    await decide(w, OLA, approvalIdOf(w, await publish(w, MAX, layer)));
    const rolled = await rollbackAgent(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, layer))!, { requestId: randomUUID(), version: 1 });
    expect(rolled.applied).toBe(false);
    const approvalId = approvalIdOf(w, rolled);
    expect(await failure(decide(w, MAX, approvalId))).toMatchObject({ code: "PROCESS_SELF_CONFIRM", status: 403, message: `PROCESS_SELF_CONFIRM: ${MESSAGE}` });
    await decide(w, OLA, approvalId);
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(1);
  });

  it("an ordinary agent's requester confirms their own change exactly as before", async () => {
    const w = world();
    const ordinary = await ordinaryAgent(w);
    // Turning on @-mentions is an ordinary less-safe change.
    const agent = (await w.store.get(ORG_A, ordinary))!;
    await w.store.saveDraft({ orgId: ORG_A, agentId: ordinary, overlay: { allowMentions: true }, expectedRevision: agent.draftRevision, by: MAX });
    const waiting = await publish(w, MAX, ordinary);
    expect(waiting.applied).toBe(false);
    await decide(w, MAX, approvalIdOf(w, waiting));
    expect((await w.store.get(ORG_A, ordinary))!.currentVersion).toBe(2);
    expect(w.audit.recordedBy("process.published")).toHaveLength(0);
    expect(w.audit.recordedBy("agent.published").at(-1)).toMatchObject({ actor: { id: MAX } });
  });

  it("the sole-owner flag is only ever true for a process layer, and only when the confirmer is the requester", async () => {
    const w = world();
    const record = { kind: "change", orgId: ORG_A, requestedBy: MAX } as never;
    expect(await confirmedBySoleOwner(w.deps, { purpose: "process" }, record, MAX)).toBe(true);
    expect(await confirmedBySoleOwner(w.deps, { purpose: "process" }, record, OLA)).toBe(false);
    expect(await confirmedBySoleOwner(w.deps, {}, record, MAX)).toBe(false);
    expect(await confirmedBySoleOwner(w.deps, { purpose: "process" }, { kind: "change", orgId: ORG_A } as never, MAX)).toBe(false);
  });

  it("someone who is not the requester and not an approver is refused as before", async () => {
    const w = world();
    const { approvalId } = await pending(w);
    expect(await failure(decide(w, PRIYA, approvalId))).toMatchObject({ code: "FORBIDDEN" });
  });
});
