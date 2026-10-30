// Follow-up M2: switching a project back to the built-in Rovara Code is a "less safe" change when the project's process layer is stricter than the built-in. It then waits for a second
// person (the process layer's approvers, with the process self-confirm rules and the sole-owner exception) instead of applying at once. Nothing lost, or pointing at the layer, stays immediate.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID, agentXError, type AgentId, type OrgRole } from "../../packages/contracts/src/index.js";
import { decideApproval, getAnyApproval } from "../../packages/broker/src/agents/approvals.js";
import { publishDraft } from "../../packages/broker/src/agents/changes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import { readProjectPlaybook } from "../../packages/broker/src/playbook/project-playbook-store.js";
import { putProjectPlaybook, type ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { ARJUN, MAX, OLA, ORG_A, PRIYA } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const ROLES: Record<string, OrgRole> = { [OLA]: "admin" };
const callerOf = (w: MergeWorld, who: string) => ({ ...w.caller(who), orgRole: ROLES[who] ?? "member" });
function world(): MergeWorld {
  const w = baseWorld();
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  return w;
}
function playbookDeps(w: MergeWorld, extra: Partial<ProjectPlaybookDependencies> = {}): ProjectPlaybookDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit, approvals: w.deps,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
    ...extra,
  };
}
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; statusCode?: number; message: string }) => ({ code: error.code, status: error.statusCode, message: error.message }));
type Steps = Record<string, { instructions?: string; timeoutMinutes?: number | null; stepBudgetUsd?: number | null }>;
async function setDraft(w: MergeWorld, agentId: AgentId, steps: Steps) {
  const agent = (await w.store.get(ORG_A, agentId))!;
  await w.store.saveDraft({ orgId: ORG_A, agentId, overlay: { steps }, expectedRevision: agent.draftRevision, by: MAX });
}
const publish = async (w: MergeWorld, who: string, agentId: AgentId) => {
  const agent = (await w.store.get(ORG_A, agentId))!;
  return publishDraft(w.deps, callerOf(w, who), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
};
const approvalIdOf = (w: MergeWorld, result: { applied: boolean }) => w.approvalIdOf((result as unknown as { confirmUrl: string }).confirmUrl);
const decide = (w: MergeWorld, who: string, approvalId: string, decision: "APPROVE" | "DECLINE" = "APPROVE") => decideApproval(w.deps, callerOf(w, who), approvalId, { requestId: randomUUID(), decision });
const playbook = (w: MergeWorld) => readProjectPlaybook(playbookDeps(w), ORG_A, "web");
const toBuiltin = async (w: MergeWorld, who = MAX, deps = playbookDeps(w)) => putProjectPlaybook(deps, callerOf(w, who), "web", { expectedRevision: (await playbook(w)).revision, defaultProcess: { kind: "builtin" } });
const changedEvents = (w: MergeWorld) => w.audit.recordedBy("playbook.default_process_changed");

/** A process layer with its first (safe) version published, so the playbook points at it. `steps` is the overlay of a second version, confirmed by an org admin when it needs that (undefined: stay at v1). */
async function layerWith(w: MergeWorld, steps?: Steps): Promise<AgentId> {
  const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
  expect(await publish(w, MAX, agentId)).toMatchObject({ applied: true, value: { version: 1 } });
  if (steps !== undefined) {
    await setDraft(w, agentId, steps);
    const waiting = await publish(w, MAX, agentId);
    if (!waiting.applied) await decide(w, OLA, approvalIdOf(w, waiting));
    expect((await w.store.get(ORG_A, agentId))!.currentVersion).toBe(2);
  }
  expect((await playbook(w)).defaultProcess).toEqual({ kind: "project_process", agentId });
  return agentId;
}
const STRICT: Steps = { review: { instructions: "Be strict about tests." } };

describe("switching back to the built-in when the layer is stricter", () => {
  it("answers 202 NEEDS_CONFIRMATION with the confirmation link and what is lost, and changes nothing", async () => {
    const w = world();
    await layerWith(w, STRICT);
    const before = await playbook(w);
    const events = changedEvents(w).length;
    const reply = await toBuiltin(w);
    expect(reply.statusCode).toBe(202);
    expect(reply.body).toMatchObject({ status: "NEEDS_CONFIRMATION", code: "REAUTH_REQUIRED" });
    const body = reply.body as { confirmUrl: string; changes: string[] };
    expect(body.confirmUrl).toContain("/");
    expect(body.changes.join("\n")).toContain('Changes the instructions of the review step "Review"');
    expect(await playbook(w)).toEqual(before);
    expect(changedEvents(w)).toHaveLength(events);
  });

  it("a layer with a lower step time or a spending limit is stricter too (the follow-up M1 rules, read from the layer towards the built-in)", async () => {
    const w = world();
    await layerWith(w, { build: { timeoutMinutes: 30 } });
    expect((await toBuiltin(w)).statusCode).toBe(202);
    const other = world();
    await layerWith(other, { build: { stepBudgetUsd: 5 } });
    expect((await toBuiltin(other)).statusCode).toBe(202);
  });

  it("a layer that is stricter by the ordinary rules (an always-ask rule the built-in lacks, a lower autonomy) is held too, not only by the process rules", async () => {
    const w = world();
    const layer = await layerWith(w);
    const draft = (await w.store.get(ORG_A, layer))!;
    await w.store.saveDraft({ orgId: ORG_A, agentId: layer, overlay: { approvals: { alwaysAsk: ["github_merge_*"] }, autonomy: "suggest" }, expectedRevision: draft.draftRevision, by: MAX });
    expect(await publish(w, MAX, layer)).toMatchObject({ applied: true, value: { version: 2 } });
    const reply = await toBuiltin(w);
    expect(reply.statusCode).toBe(202);
    const changes = (reply.body as { changes: string[] }).changes.join("\n");
    expect(changes).toContain('Removes or changes the always-ask rule "github_merge_*"');
    expect(changes).toContain("Raises the agent's autonomy");
  });

  it("refuses the requester's own confirmation while another approver exists, and leaves the playbook alone", async () => {
    const w = world();
    await layerWith(w, STRICT);
    const approvalId = w.approvalIdOf(((await toBuiltin(w)).body as { confirmUrl: string }).confirmUrl);
    expect(await failure(decide(w, MAX, approvalId))).toMatchObject({ code: "PROCESS_SELF_CONFIRM", status: 403 });
    expect((await getAnyApproval(w.deps, ORG_A, approvalId))!.status).toBe("PENDING");
    expect((await playbook(w)).defaultProcess.kind).toBe("project_process");
  });

  it("applies when another maintainer confirms it, and records playbook.default_process_changed by the confirmer", async () => {
    const w = world();
    await layerWith(w, STRICT);
    const expected = (await playbook(w)).revision;
    const events = changedEvents(w).length;
    const approvalId = w.approvalIdOf(((await toBuiltin(w)).body as { confirmUrl: string }).confirmUrl);
    await decide(w, OLA, approvalId);
    expect((await getAnyApproval(w.deps, ORG_A, approvalId))!.status).toBe("APPROVED_DONE");
    expect(await playbook(w)).toEqual({ revision: expected + 1, defaultProcess: { kind: "builtin" } });
    expect(changedEvents(w)).toHaveLength(events + 1);
    expect(changedEvents(w).at(-1)).toMatchObject({ actor: { id: OLA }, facts: { revision: expected + 1, processKind: "builtin" } });
  });

  it("counts a project maintainer with manage_agents as another approver", async () => {
    const w = world();
    w.grant(ARJUN, "web", "maintainer");
    await layerWith(w, STRICT);
    // Ola, who confirmed the stricter version as an admin, is a plain member from here, so nobody else is left to confirm (the decision checks the role it was judged under).
    w.member(ORG_A, OLA, "member");
    const approvalId = w.approvalIdOf(((await toBuiltin(w)).body as { confirmUrl: string }).confirmUrl);
    expect(await failure(decide(w, MAX, approvalId))).toMatchObject({ code: "PROCESS_SELF_CONFIRM" });
    await decide(w, ARJUN, approvalId);
    expect((await playbook(w)).defaultProcess.kind).toBe("builtin");
  });

  it("lets the requester confirm when they are the only eligible approver, with a fresh sign-in", async () => {
    const w = world();
    await layerWith(w, STRICT);
    // Ola, who confirmed the stricter version as an admin, is a plain member from here, so nobody else is left to confirm (the decision checks the role it was judged under).
    w.member(ORG_A, OLA, "member");
    const approvalId = w.approvalIdOf(((await toBuiltin(w)).body as { confirmUrl: string }).confirmUrl);
    expect(await w.kind.decide({ orgId: ORG_A, developerId: MAX, approvalId }, "approve", { kind: "none" } as never).then(() => "decided", (error: { code?: string }) => error.code)).toBe("FORBIDDEN");
    expect((await playbook(w)).defaultProcess.kind).toBe("project_process");
    await w.decide(approvalId, await w.browser(MAX, approvalId));
    expect((await playbook(w)).defaultProcess.kind).toBe("builtin");
    expect(changedEvents(w).at(-1)).toMatchObject({ actor: { id: MAX }, facts: { processKind: "builtin" } });
  });

  it("the confirmation page names the change, the project and what is lost", async () => {
    const w = world();
    await layerWith(w, STRICT);
    const approvalId = w.approvalIdOf(((await toBuiltin(w)).body as { confirmUrl: string }).confirmUrl);
    const inspected = await w.kind.inspect({ orgId: ORG_A, developerId: OLA, approvalId });
    expect(inspected).toMatchObject({ status: "open", view: { title: "Switch a project back to the built-in way of working" } });
    const view = (inspected as unknown as { view: { facts: Array<{ label: string; value: string }>; paragraphs: string[] } }).view;
    expect(view.facts).toEqual(expect.arrayContaining([{ label: "Project", value: "web" }]));
    expect(view.paragraphs.join("\n")).toContain('Changes the instructions of the review step "Review"');
  });

  it("someone who cannot approve changes in the project cannot confirm it", async () => {
    const w = world();
    await layerWith(w, STRICT);
    const approvalId = w.approvalIdOf(((await toBuiltin(w)).body as { confirmUrl: string }).confirmUrl);
    expect(await failure(decide(w, PRIYA, approvalId))).toMatchObject({ code: "FORBIDDEN" });
    expect((await playbook(w)).defaultProcess.kind).toBe("project_process");
  });

  it("a decline changes nothing", async () => {
    const w = world();
    await layerWith(w, STRICT);
    const approvalId = w.approvalIdOf(((await toBuiltin(w)).body as { confirmUrl: string }).confirmUrl);
    await decide(w, MAX, approvalId, "DECLINE");
    expect((await getAnyApproval(w.deps, ORG_A, approvalId))!.status).toBe("DECLINED");
    expect((await playbook(w)).defaultProcess.kind).toBe("project_process");
  });

  it("a confirmation after the playbook changed is refused, and so is one after the layer published a new version (both are asked again)", async () => {
    const w = world();
    const layer = await layerWith(w, STRICT);
    const first = w.approvalIdOf(((await toBuiltin(w)).body as { confirmUrl: string }).confirmUrl);
    // The playbook is written again (same pointer, new revision).
    await putProjectPlaybook(playbookDeps(w), callerOf(w, MAX), "web", { expectedRevision: (await playbook(w)).revision, defaultProcess: { kind: "project_process", agentId: layer } });
    await decide(w, OLA, first);
    expect((await getAnyApproval(w.deps, ORG_A, first))!.status).toBe("APPROVED_FAILED");
    expect((await playbook(w)).defaultProcess.kind).toBe("project_process");

    const second = w.approvalIdOf(((await toBuiltin(w)).body as { confirmUrl: string }).confirmUrl);
    await setDraft(w, layer, { review: { instructions: "Be even stricter." } });
    const waiting = await publish(w, MAX, layer);
    await decide(w, OLA, approvalIdOf(w, waiting));
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(3);
    await decide(w, OLA, second);
    expect((await getAnyApproval(w.deps, ORG_A, second))!.status).toBe("APPROVED_FAILED");
    expect((await playbook(w)).defaultProcess.kind).toBe("project_process");
  });

  it("fails closed when the approvals are not available: nothing is switched", async () => {
    const w = world();
    await layerWith(w, STRICT);
    expect(await failure(toBuiltin(w, MAX, playbookDeps(w, { approvals: undefined })))).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect((await playbook(w)).defaultProcess.kind).toBe("project_process");
  });
});

describe("switching back to the built-in when nothing is lost stays immediate", () => {
  it("a layer no stricter than the built-in switches at once with a 200 and the audit event", async () => {
    const w = world();
    await layerWith(w);
    const expected = (await playbook(w)).revision;
    const events = changedEvents(w).length;
    const reply = await toBuiltin(w);
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ playbook: { revision: expected + 1, defaultProcess: { kind: "builtin" } } });
    expect(changedEvents(w)).toHaveLength(events + 1);
  });

  it("a layer that is only looser than the built-in (a build instruction) switches at once", async () => {
    const w = world();
    const layer = await layerWith(w);
    await setDraft(w, layer, { build: { instructions: "Run the linter." } });
    expect(await publish(w, MAX, layer)).toMatchObject({ applied: true });
    expect((await w.store.get(ORG_A, layer))!.currentVersion).toBe(2);
    expect((await toBuiltin(w)).statusCode).toBe(200);
  });

  it("pointing at the layer is immediate even when the layer is stricter, and switching to the built-in from the built-in is too", async () => {
    const w = world();
    const layer = await layerWith(w);
    expect((await toBuiltin(w)).statusCode).toBe(200);
    await setDraft(w, layer, STRICT);
    await decide(w, OLA, approvalIdOf(w, await publish(w, MAX, layer)));
    const back = await putProjectPlaybook(playbookDeps(w), callerOf(w, MAX), "web", { expectedRevision: (await playbook(w)).revision, defaultProcess: { kind: "project_process", agentId: layer } });
    expect(back.statusCode).toBe(200);
    expect((await playbook(w)).defaultProcess.kind).toBe("project_process");
    expect((await toBuiltin(w)).statusCode).toBe(202);
    const idle = world();
    expect((await toBuiltin(idle)).statusCode).toBe(200);
    expect((await toBuiltin(idle)).statusCode).toBe(200);
  });

  it("a layer that is archived but still the project's default is compared all the same (fix round 1, I2): archiving it first is no way round the second person", async () => {
    const w = world();
    const layer = await layerWith(w, STRICT);
    // The route refuses to archive the current default now; a layer archived before that rule is still held to the compare.
    await w.store.archive(ORG_A, layer, MAX);
    expect((await toBuiltin(w)).statusCode).toBe(202);
  });

  it("a layer with no published version, or one that is gone, loses nothing", async () => {
    const w = world();
    const { agentId } = await postProjectProcess(playbookDeps(w), w.caller(MAX), "web");
    expect(agentId).toBeDefined();
    expect((await toBuiltin(w)).statusCode).toBe(200);
  });

  it("a layer that caps a step's time is stricter than the built-in's no limit, whatever the cap (fix round 1, I1)", async () => {
    const w = world();
    const layer = await layerWith(w, { build: { timeoutMinutes: 30 } });
    await setDraft(w, layer, { build: { timeoutMinutes: 200 } });
    await decide(w, OLA, approvalIdOf(w, await publish(w, MAX, layer)));
    const reply = await toBuiltin(w);
    expect(reply.statusCode).toBe(202);
    expect((reply.body as { changes: string[] }).changes.join("\n")).toContain('Removes the time limit of the step "Build"');
  });

  it("a stale revision is still PLAYBOOK_STALE (409) and a non-maintainer still cannot", async () => {
    const w = world();
    await layerWith(w, STRICT);
    expect(await failure(putProjectPlaybook(playbookDeps(w), callerOf(w, MAX), "web", { expectedRevision: 0, defaultProcess: { kind: "builtin" } }))).toMatchObject({ code: "PLAYBOOK_STALE", status: 409 });
    expect(await failure(toBuiltin(w, PRIYA))).toMatchObject({ code: "FORBIDDEN" });
    expect(ROVARA_CODE_AGENT_ID).toBeDefined();
  });
});
