// "How we work" (H3): creating a project's process layer (POST /v1/app/projects/{p}/playbook/process), pointing the playbook at it when its first version is published
// (the publish, immediate or confirmed), its own audit events, and keeping process layers out of every list of agents a person chooses from.
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { ROVARA_CODE_AGENT_ID, agentKey, agentXError, projectPlaybookKey, recipeDigest, type AgentId, type OrgRole } from "../../packages/contracts/src/index.js";
import { getApproval, getApprovalSubjectHandler, type ApprovalRecord } from "../../packages/broker/src/agents/approvals.js";
import { listVisibleAgents, saveShares } from "../../packages/broker/src/agents/access.js";
import { publishDraft, resolveRecipe, rollbackAgent } from "../../packages/broker/src/agents/changes.js";
import { addToRoster, listRoster } from "../../packages/broker/src/agents/roster.js";
import { writeProjectPlaybook } from "../../packages/broker/src/playbook/project-playbook-store.js";
import { postProjectProcess } from "../../packages/broker/src/playbook/process-layer.js";
import type { ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { AgentStore } from "../../packages/broker/src/agents/store.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { projectMemberKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { TEST_ORG } from "../support/orgs.js";
import { ARJUN, MAX, OLA, ORG_A, PRIYA, ZED } from "../support/agent-session-world.js";
import { mergeWorld as baseWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";

const ROLES: Record<string, OrgRole> = { [OLA]: "admin" };
function playbookDeps(w: MergeWorld): ProjectPlaybookDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined || caller.orgId !== ORG_A) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
  };
}
const post = (w: MergeWorld, who: string, project = "web") => postProjectProcess(playbookDeps(w), w.caller(who), project);
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; statusCode?: number; message: string }) => ({ code: error.code, status: error.statusCode, message: error.message }));
const document = (w: MergeWorld, project = "web") => w.db.get(projectPlaybookKey(ORG_A, project)) as Record<string, unknown> | undefined;
const processLayers = async (w: MergeWorld) => (await w.store.list(ORG_A)).filter((agent) => agent.purpose === "process");
/** The world's agent store has no audit outbox; the audited tests give it the capture's. */
function audited(w: MergeWorld): MergeWorld {
  const store = new AgentStore({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  (w.deps as { store: AgentStore }).store = store;
  w.store = store;
  return w;
}
const mergeWorld = () => audited(baseWorld());
const callerOf = (w: MergeWorld, who: string) => ({ ...w.caller(who), orgRole: ROLES[who] ?? ("member") });

describe("POST /playbook/process", () => {
  it("creates one draft process layer that extends Rovara Code's adopted version, owned by the project", async () => {
    const w = mergeWorld();
    const answer = await post(w, MAX);
    expect(answer).toMatchObject({ draftRevision: 1 });
    expect(answer.currentVersion).toBeUndefined();
    const layers = await processLayers(w);
    expect(layers).toHaveLength(1);
    expect(layers[0]).toMatchObject({
      agentId: answer.agentId, purpose: "process", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX },
      name: "web process", description: "How Rovara Code works in this project.", status: "active",
    });
    expect(layers[0]!.currentVersion).toBeUndefined();
    const draft = (await w.store.getDraft(ORG_A, answer.agentId))!;
    expect(draft.overlay).toEqual({});
    expect(draft.extends).toEqual({ agentId: ROVARA_CODE_AGENT_ID, version: await w.store.pinnedBuiltinVersion(ORG_A, ROVARA_CODE_AGENT_ID) });
    // The playbook still points at the built-in until the first version is published.
    expect(document(w)).toBeUndefined();
  });

  it("answers the same layer to a second call, and to two calls at once", async () => {
    const w = mergeWorld();
    const first = await post(w, MAX);
    expect((await post(w, MAX)).agentId).toBe(first.agentId);
    const other = mergeWorld();
    const [a, b, c] = await Promise.all([post(other, MAX), post(other, OLA), post(other, MAX)]);
    expect(new Set([a.agentId, b.agentId, c.agentId]).size).toBe(1);
    expect(await processLayers(other)).toHaveLength(1);
    expect(await processLayers(w)).toHaveLength(1);
  });

  it("truncates a long project name to the agent name limit", async () => {
    const w = mergeWorld();
    const name = "p".repeat(58);
    w.members.addProject(ORG_A, name);
    w.members.grant(ORG_A, name, MAX, "maintainer");
    const answer = await post(w, MAX, name);
    const agent = (await w.store.get(ORG_A, answer.agentId))!;
    expect(agent.name.length).toBeLessThanOrEqual(60);
    expect(agent.name.startsWith("ppp")).toBe(true);
  });

  it("returns the layer the playbook already points at, with its current version", async () => {
    const w = mergeWorld();
    const first = await post(w, MAX);
    const agent = (await w.store.get(ORG_A, first.agentId))!;
    await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    expect((document(w) as { defaultProcess: unknown }).defaultProcess).toEqual({ kind: "project_process", agentId: first.agentId });
    expect(await post(w, MAX)).toEqual({ agentId: first.agentId, draftRevision: 1, currentVersion: 1 });
    expect(await processLayers(w)).toHaveLength(1);
  });

  it("refuses a contributor (403) and another organization's caller (404), and creates nothing", async () => {
    const w = mergeWorld();
    expect(await failure(post(w, PRIYA))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await failure(post(w, ZED))).toMatchObject({ code: "PROJECT_NOT_FOUND", status: 404 });
    expect(await failure(postProjectProcess(playbookDeps(w), w.caller(MAX, "org_bbbbbbbbbbbbbbbbbbbb"), "web"))).toMatchObject({ code: "PROJECT_NOT_FOUND", status: 404 });
    expect(await processLayers(w)).toHaveLength(0);
  });
});

describe("publishing a process layer", () => {
  it("points the playbook at it with the first version, records playbook.default_process_changed and process.published (not agent.published)", async () => {
    const w = mergeWorld();
    const { agentId } = await post(w, MAX);
    const agent = (await w.store.get(ORG_A, agentId))!;
    const published = await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    expect(published).toMatchObject({ applied: true, value: { version: 1 } });
    expect(document(w)).toMatchObject({ revision: 1, defaultProcess: { kind: "project_process", agentId } });
    expect(w.audit.recordedBy("playbook.default_process_changed")).toMatchObject([{ actor: { id: MAX }, target: { kind: "project", name: "web" }, facts: { revision: 1, processKind: "project_process" } }]);
    expect(w.audit.recordedBy("process.published")).toMatchObject([{ actor: { id: MAX }, target: { kind: "process", id: agentId }, facts: { version: 1, safety: "safe", selfConfirmedSoleOwner: false } }]);
    expect(w.audit.recordedBy("agent.published")).toEqual([]);
  });

  it("leaves the playbook alone when a later version is published, and when the project chose the built-in since", async () => {
    const w = mergeWorld();
    const { agentId } = await post(w, MAX);
    let agent = (await w.store.get(ORG_A, agentId))!;
    await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    // The maintainer sets the project back to the built-in.
    await writeProjectPlaybook({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit }, { orgId: ORG_A, project: "web", developerId: MAX, expectedRevision: 1, defaultProcess: { kind: "builtin" } });
    agent = (await w.store.get(ORG_A, agentId))!;
    await w.store.saveDraft({ orgId: ORG_A, agentId, overlay: { instructions: "Also run the linter." }, expectedRevision: agent.draftRevision, by: MAX });
    agent = (await w.store.get(ORG_A, agentId))!;
    const second = await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    expect(second).toMatchObject({ applied: true, value: { version: 2 } });
    expect(document(w)).toMatchObject({ revision: 2, defaultProcess: { kind: "builtin" } });
    expect(w.audit.recordedBy("process.published")).toHaveLength(2);
  });

  it("an ordinary custom agent publishes as before: agent.published, and no playbook is written", async () => {
    const w = mergeWorld();
    const created = await w.store.create({ orgId: ORG_A, name: "reviewer", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, createdBy: MAX });
    await publishDraft(w.deps, callerOf(w, MAX), created, { requestId: randomUUID(), expectedRevision: created.draftRevision });
    expect(w.audit.recordedBy("agent.published")).toHaveLength(1);
    expect(w.audit.recordedBy("process.published")).toEqual([]);
    expect(document(w)).toBeUndefined();
  });

  it("does the same through the confirmation path (a less safe first version confirmed on the page)", async () => {
    const w = mergeWorld();
    const { agentId } = await post(w, MAX);
    let agent = (await w.store.get(ORG_A, agentId))!;
    await w.store.saveDraft({ orgId: ORG_A, agentId, overlay: { steps: { review: { instructions: "Check the migrations." } } }, expectedRevision: agent.draftRevision, by: MAX });
    agent = (await w.store.get(ORG_A, agentId))!;
    const pending = await publishDraft(w.deps, w.caller(MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    expect(pending.applied).toBe(false);
    if (pending.applied) throw new Error("expected publication confirmation");
    const record = (await getApproval(w.deps, ORG_A, w.approvalIdOf(pending.confirmUrl)))!;
    await getApprovalSubjectHandler("agent_publish")!(w.deps, { ...record, decidedBy: OLA });
    expect(document(w)).toMatchObject({ revision: 1, defaultProcess: { kind: "project_process", agentId } });
    expect(w.audit.recordedBy("process.published")).toMatchObject([{ actor: { id: OLA }, target: { kind: "process", id: agentId }, facts: { version: 1, safety: "less_safe", selfConfirmedSoleOwner: false } }]);
    expect(w.audit.recordedBy("agent.published")).toEqual([]);
    expect(w.audit.recordedBy("playbook.default_process_changed")).toMatchObject([{ actor: { id: OLA } }]);
  });

  it("repairs the pointer when the same publish is asked again after the playbook write was lost", async () => {
    const w = mergeWorld();
    const { agentId } = await post(w, MAX);
    const agent = (await w.store.get(ORG_A, agentId))!;
    // The version committed, then the broker died before the playbook write.
    await w.store.publish({ orgId: ORG_A, agentId, expectedDraftRevision: agent.draftRevision, digest: recipeDigest(await resolveRecipe(w.deps, ORG_A, agentId, "draft")), by: MAX, expectedCurrentVersion: null });
    expect(document(w)).toBeUndefined();
    const again = await publishDraft(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, agentId))!, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    expect(again).toMatchObject({ applied: true, value: { version: 1 } });
    expect(document(w)).toMatchObject({ revision: 1, defaultProcess: { kind: "project_process", agentId } });
  });

  // Final review I1 (and H3 m1): the repair after a lost playbook write only applies while nobody has written the playbook since version 1 was published.
  const writer = (w: MergeWorld) => ({ documentClient: w.db, tableName: "state", now: () => w.clock.now, audit: w.audit.audit });
  const redrive = (w: MergeWorld, agentId: AgentId, draftRevision: number, digest: string) => getApprovalSubjectHandler("agent_publish")!(w.deps, {
    orgId: ORG_A, approvalId: "apr_r", decidedBy: OLA, requestedBy: MAX, subject: { kind: "agent_publish", agentId, draftRevision, digest },
  } as unknown as ApprovalRecord);

  it("a no-op republish of version 1, or a confirmation redriven, after the project was set back to the built-in leaves it on the built-in", async () => {
    const w = mergeWorld();
    const { agentId } = await post(w, MAX);
    const agent = (await w.store.get(ORG_A, agentId))!;
    await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    expect(document(w)).toMatchObject({ revision: 1, defaultProcess: { kind: "project_process", agentId } });
    w.clock.now += 60_000;
    await writeProjectPlaybook(writer(w), { orgId: ORG_A, project: "web", developerId: MAX, expectedRevision: 1, defaultProcess: { kind: "builtin" } });
    w.clock.now += 60_000;
    const again = await publishDraft(w.deps, callerOf(w, PRIYA), (await w.store.get(ORG_A, agentId))!, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    expect(again).toMatchObject({ applied: true, value: { version: 1 } });
    expect(document(w)).toMatchObject({ revision: 2, defaultProcess: { kind: "builtin" } });
    await redrive(w, agentId, agent.draftRevision, (await w.store.getVersion(ORG_A, agentId, 1))!.digest);
    expect(document(w)).toMatchObject({ revision: 2, defaultProcess: { kind: "builtin" } });
    expect(w.audit.recordedBy("playbook.default_process_changed")).toHaveLength(2);
  });

  it("still repairs a lost write when the playbook was last written before version 1 was published, by a republish or a redriven confirmation", async () => {
    for (const how of ["republish", "redrive"] as const) {
      const w = mergeWorld();
      // The project chose the built-in explicitly before it had a layer.
      await writeProjectPlaybook(writer(w), { orgId: ORG_A, project: "web", developerId: MAX, expectedRevision: 0, defaultProcess: { kind: "builtin" } });
      w.clock.now += 60_000;
      const { agentId } = await post(w, MAX);
      const agent = (await w.store.get(ORG_A, agentId))!;
      const digest = recipeDigest(await resolveRecipe(w.deps, ORG_A, agentId, "draft"));
      // Version 1 committed, then the broker died before the playbook write.
      await w.store.publish({ orgId: ORG_A, agentId, expectedDraftRevision: agent.draftRevision, digest, by: MAX, expectedCurrentVersion: null });
      w.clock.now += 60_000;
      if (how === "republish") await publishDraft(w.deps, callerOf(w, MAX), (await w.store.get(ORG_A, agentId))!, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
      else await redrive(w, agentId, agent.draftRevision, digest);
      expect(document(w), how).toMatchObject({ revision: 2, defaultProcess: { kind: "project_process", agentId } });
    }
  });

  it("audits process.rolled_back instead of agent.rolled_back for a rollback", async () => {
    const w = mergeWorld();
    const { agentId } = await post(w, MAX);
    let agent = (await w.store.get(ORG_A, agentId))!;
    await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    agent = (await w.store.get(ORG_A, agentId))!;
    await w.store.saveDraft({ orgId: ORG_A, agentId, overlay: { instructions: "Also run the linter." }, expectedRevision: agent.draftRevision, by: MAX });
    agent = (await w.store.get(ORG_A, agentId))!;
    await publishDraft(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), expectedRevision: agent.draftRevision });
    agent = (await w.store.get(ORG_A, agentId))!;
    expect(await rollbackAgent(w.deps, callerOf(w, MAX), agent, { requestId: randomUUID(), version: 1 })).toMatchObject({ applied: true });
    expect(w.audit.recordedBy("process.rolled_back")).toMatchObject([{ target: { kind: "process", id: agentId }, facts: { fromVersion: 2, toVersion: 1, safety: "safe" } }]);
    expect(w.audit.recordedBy("agent.rolled_back")).toEqual([]);
  });
});

describe("process layers are never offered as agents", () => {
  async function both(w: MergeWorld, project = "web") {
    const layer = project === "web" ? (await post(w, MAX, project)).agentId
      : (await w.store.create({ orgId: ORG_A, name: `${project} process`, owner: { kind: "project", project }, accountable: { developerId: MAX }, extends: ROVARA_CODE_AGENT_ID, purpose: "process", createdBy: MAX })).agentId;
    const ordinary = (await w.store.create({ orgId: ORG_A, name: "reviewer", owner: { kind: "project", project }, accountable: { developerId: MAX }, createdBy: MAX })).agentId;
    return { layer, ordinary };
  }
  const ids = (list: Array<{ agentId: AgentId }>) => list.map((agent) => agent.agentId);

  it("the agent directory (all, mine and a project's list) leaves the layer out and keeps an ordinary agent", async () => {
    const w = mergeWorld();
    const { layer, ordinary } = await both(w);
    for (const who of [MAX, OLA]) {
      const caller = callerOf(w, who);
      const all = ids(await listVisibleAgents(w.deps, caller, "all"));
      expect(all, `all for ${who}`).toContain(ordinary);
      expect(all, `all for ${who}`).not.toContain(layer);
      const project = ids(await listVisibleAgents(w.deps, caller, { project: "web" }));
      expect(project).toContain(ordinary);
      expect(project).not.toContain(layer);
    }
    // Direct reads of the agent by id still work for the project.
    expect((await w.store.get(ORG_A, layer))?.purpose).toBe("process");
  });

  it("shared with me leaves the layer out and keeps an ordinary agent", async () => {
    const w = mergeWorld();
    const { layer, ordinary } = await both(w, "ops");
    for (const id of [layer, ordinary]) {
      // A layer can't be shared any more (H8); one shared before then is stored here by sharing it while it is still unmarked.
      const meta = w.db.get(agentKey(ORG_A, id, "META"))!;
      const { purpose: _purpose, ...unmarked } = meta; // eslint-disable-line @typescript-eslint/no-unused-vars -- the mark comes off for the write
      w.db.set(unmarked);
      await saveShares(w.deps, ORG_A, MAX, (await w.store.get(ORG_A, id))!, [{ principal: { kind: "member", developerId: ARJUN }, level: "view" }]);
      w.db.set({ ...w.db.get(agentKey(ORG_A, id, "META"))!, ...(meta["purpose"] === undefined ? {} : { purpose: meta["purpose"] }) });
    }
    const shared = ids(await listVisibleAgents(w.deps, callerOf(w, ARJUN), "shared"));
    expect(shared).toContain(ordinary);
    expect(shared).not.toContain(layer);
  });

  it("the project roster (and so the sidebar, the new-session list and the Slack lookup that read it) leaves the layer out and keeps an ordinary agent", async () => {
    const w = mergeWorld();
    const { layer, ordinary } = await both(w);
    for (const id of [layer, ordinary]) await addToRoster(w.deps, { orgId: ORG_A, project: "web", agentId: id, by: MAX });
    for (const who of [MAX, PRIYA, ARJUN]) {
      const roster = ids(await listRoster(w.deps, callerOf(w, who), "web"));
      expect(roster, who).toContain(ordinary);
      expect(roster, who).not.toContain(layer);
    }
  });
});

describe("the route against the real broker", () => {
  it("serves POST /v1/app/projects/{p}/playbook/process: a contributor is refused (403) and a missing project is a 404", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    h.db.set({ ...projectMemberKey(TEST_ORG, MAYA.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "contributor", grantedAt: new Date().toISOString() });
    const refused = await h.dev(MAYA, "POST", "/v1/app/projects/payments/playbook/process", {});
    expect(refused.status, JSON.stringify(refused.body)).toBe(403);
    const missing = await h.dev(MAYA, "POST", "/v1/app/projects/nothing-here/playbook/process", {});
    expect(missing.status).toBe(404);
  });
});
