// "How we work" (H2): a project's playbook document says which process the project runs. The built-in Rovara Code is the default; a project may point at its own process layer
// (a project-owned custom agent marked `purpose: "process"`). The PUT is a maintainer's, under the revision they read, and records its audit event in the same transaction.
import { fixtureActor } from "../support/money-authority.js";
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { AgentXErrorCodeSchema, DEFAULT_PROJECT_PLAYBOOK, PLAYBOOK_STALE_MESSAGE, ProjectPlaybookBodySchema, ProjectPlaybookSchema, ROVARA_CODE_AGENT_ID, agentKey, agentXError, errorStatus, projectPlaybookKey, type AgentId } from "@rovara-code/contracts";
import { type OrgRole } from "@agentx/cloud-contracts";
import { getProjectPlaybook, putProjectPlaybook, type ProjectPlaybookDependencies } from "../../packages/broker/src/playbook/routes.js";
import { projectProcessOf } from "../../packages/broker/src/playbook/project-process.js";
import { readProjectPlaybook } from "../../packages/broker/src/playbook/project-playbook-store.js";
import { MAX, MIA, OLA, ORG_A, PRIYA, ZED, BO, ORG_B } from "../support/agent-session-world.js";
import { mergeWorld, type MergeWorld } from "../support/rovara-code-merge-world.js";
import { MAYA, createDeveloperTaskBroker } from "../support/developer-task-broker.js";
import { projectMemberKey } from "@rovara-code/contracts";
import { TEST_ORG } from "../support/orgs.js";

const ROLES: Record<string, OrgRole> = { [OLA]: "admin" };
function playbookDeps(w: MergeWorld, extra: Partial<ProjectPlaybookDependencies> = {}): ProjectPlaybookDependencies {
  return {
    documentClient: w.db, tableName: "state", now: () => w.clock.now, store: w.store, audit: w.audit.audit, approvals: w.deps,
    projectFor: async (caller, rawName) => {
      const role = await w.members.roleOf(caller.orgId, rawName, { developerId: caller.developerId, orgRole: ROLES[caller.developerId] ?? "member" });
      if (role === undefined || caller.orgId !== ORG_A) throw agentXError("PROJECT_NOT_FOUND", "project not found");
      return { name: rawName, role };
    },
    ...extra,
  };
}
const put = (w: MergeWorld, who: string, body: Record<string, unknown>, project = "web") =>
  putProjectPlaybook(playbookDeps(w), w.caller(who), project, { expectedRevision: 0, defaultProcess: { kind: "builtin" }, ...body });
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; statusCode?: number; message: string }) => ({ code: error.code, status: error.statusCode, message: error.message.replace(`${String(error.code)}: `, "") }));
const stored = (w: MergeWorld, project = "web") => w.db.get(projectPlaybookKey(ORG_A, project)) as Record<string, unknown> | undefined;

/** A project-owned custom agent; `process: false` makes an ordinary one; `publish: false` leaves it a draft. */
async function makeAgent(w: MergeWorld, options: { project?: string; process?: boolean; publish?: boolean; archive?: boolean; name?: string } = {}): Promise<AgentId> {
  const project = options.project ?? "web";
  const agent = await w.store.create({
    orgId: ORG_A, name: options.name ?? `agent ${randomUUID().slice(0, 8)}`, owner: { kind: "project", project }, accountable: { developerId: MAX }, createdBy: MAX, extends: ROVARA_CODE_AGENT_ID,
    ...(options.process === false ? {} : { purpose: "process" as const }),
  });
  if (options.publish !== false) await w.store.publish({ orgId: ORG_A, agentId: agent.agentId, expectedDraftRevision: agent.draftRevision, digest: "a".repeat(64), by: MAX });
  if (options.archive === true) await w.store.archive(ORG_A, agent.agentId, MAX, undefined, { actor: fixtureActor(w.store, ORG_A, MAX) });
  return agent.agentId;
}
const processBody = (agentId: string) => ({ defaultProcess: { kind: "project_process", agentId } });

describe("the contract", () => {
  it("reads a missing document as the built-in default, and takes only the two kinds", () => {
    expect(DEFAULT_PROJECT_PLAYBOOK).toEqual({ revision: 0, defaultProcess: { kind: "builtin" } });
    expect(ProjectPlaybookSchema.safeParse({ revision: 3, defaultProcess: { kind: "project_process", agentId: "agt_" + "a".repeat(20) } }).success).toBe(true);
    expect(ProjectPlaybookSchema.safeParse({ revision: 3, defaultProcess: { kind: "builtin", agentId: "agt_" + "a".repeat(20) } }).success).toBe(false);
    expect(ProjectPlaybookSchema.safeParse({ revision: -1, defaultProcess: { kind: "builtin" } }).success).toBe(false);
    expect(ProjectPlaybookSchema.safeParse({ revision: 0, defaultProcess: { kind: "builtin" }, extra: 1 }).success).toBe(false);
    // A process layer is a custom agent: a built-in agent's id is not one.
    expect(ProjectPlaybookBodySchema.safeParse({ expectedRevision: 0, defaultProcess: { kind: "project_process", agentId: "rovara-code" } }).success).toBe(false);
    expect(ProjectPlaybookBodySchema.safeParse({ expectedRevision: 0, defaultProcess: { kind: "builtin" } }).success).toBe(true);
  });

  it("has the two codes with their statuses", () => {
    expect(AgentXErrorCodeSchema.options).toEqual(expect.arrayContaining(["PROCESS_UNAVAILABLE", "PLAYBOOK_STALE"]));
    expect(errorStatus("PROCESS_UNAVAILABLE")).toBe(400);
    expect(errorStatus("PLAYBOOK_STALE")).toBe(409);
  });
});

describe("reading the playbook", () => {
  it("answers the built-in default for a project with no document, to anyone who can see the project", async () => {
    const w = mergeWorld();
    for (const who of [PRIYA, MIA, MAX]) {
      expect(await getProjectPlaybook(playbookDeps(w), w.caller(who), "web")).toEqual({ playbook: { revision: 0, defaultProcess: { kind: "builtin" } } });
    }
  });

  it("answers the project not found for someone with no role in it", async () => {
    const w = mergeWorld();
    expect(await failure(getProjectPlaybook(playbookDeps(w), w.caller(ZED), "web"))).toMatchObject({ code: "PROJECT_NOT_FOUND", status: 404 });
  });
});

describe("changing the playbook", () => {
  it("lets a maintainer point the project at its process layer, bumps the revision and audits it in the same transaction", async () => {
    const w = mergeWorld();
    const agentId = await makeAgent(w);
    const reply = await put(w, MAX, processBody(agentId));
    expect(reply.statusCode).toBe(200);
    expect(reply.body).toEqual({ playbook: { revision: 1, defaultProcess: { kind: "project_process", agentId } } });
    expect(await getProjectPlaybook(playbookDeps(w), w.caller(PRIYA), "web")).toEqual({ playbook: { revision: 1, defaultProcess: { kind: "project_process", agentId } } });
    const events = w.audit.recordedBy("playbook.default_process_changed");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ actor: { kind: "member", id: MAX }, target: { kind: "project" }, facts: { revision: 1, processKind: "project_process" } });
    // The process is never named in the event.
    expect(JSON.stringify(events[0])).not.toContain(agentId);
    const written = w.db.transactions().find((items) => items.some((entry) => JSON.stringify(entry).includes("PROJECT_PLAYBOOK")))!;
    expect(JSON.stringify(written)).toContain("AUDIT_PENDING");
    // Back to the built-in under the revision read: one more event, revision 2.
    await put(w, MAX, { expectedRevision: 1, defaultProcess: { kind: "builtin" } });
    expect(stored(w)).toMatchObject({ revision: 2, defaultProcess: { kind: "builtin" } });
    expect(w.audit.recordedBy("playbook.default_process_changed").map((event) => event.facts)).toEqual([
      { revision: 1, processKind: "project_process" }, { revision: 2, processKind: "builtin" },
    ]);
  });

  it("writes nothing when the audit outbox write fails: the document and its event commit together", async () => {
    const w = mergeWorld();
    const agentId = await makeAgent(w);
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("AUDIT_PENDING#"), error: { name: "InternalServerError" }, times: 1 });
    await expect(put(w, MAX, processBody(agentId))).rejects.toMatchObject({ name: "InternalServerError" });
    expect(stored(w)).toBeUndefined();
    expect(w.audit.recordedBy("playbook.default_process_changed")).toEqual([]);
  });

  it("refuses a contributor, a viewer and a non-member, and writes nothing", async () => {
    const w = mergeWorld();
    const agentId = await makeAgent(w);
    expect(await failure(put(w, PRIYA, processBody(agentId)))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await failure(put(w, MIA, processBody(agentId)))).toMatchObject({ code: "FORBIDDEN", status: 403 });
    expect(await failure(put(w, ZED, processBody(agentId)))).toMatchObject({ code: "PROJECT_NOT_FOUND", status: 404 });
    expect(stored(w)).toBeUndefined();
    expect(w.audit.recordedBy("playbook.default_process_changed")).toEqual([]);
  });

  it("refuses a stale revision with the fixed words (409) and writes nothing", async () => {
    const w = mergeWorld();
    await put(w, MAX, {});
    expect(await failure(put(w, MAX, { expectedRevision: 0 }))).toEqual({ code: "PLAYBOOK_STALE", status: 409, message: PLAYBOOK_STALE_MESSAGE });
    expect(stored(w)).toMatchObject({ revision: 1 });
    expect(w.audit.recordedBy("playbook.default_process_changed")).toHaveLength(1);
  });

  it("refuses a write that lost the race on the revision, with the same words", async () => {
    const w = mergeWorld();
    const agentId = await makeAgent(w);
    // Another maintainer's write lands between this one's read and its transaction.
    w.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("PROJECT_PLAYBOOK"), error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }] }, times: 1 });
    expect(await failure(put(w, MAX, processBody(agentId)))).toEqual({ code: "PLAYBOOK_STALE", status: 409, message: PLAYBOOK_STALE_MESSAGE });
  });

  it("answers another organization's caller the project not found", async () => {
    const w = mergeWorld();
    expect(await failure(putProjectPlaybook(playbookDeps(w), w.caller(BO, ORG_B), "web", { expectedRevision: 0, defaultProcess: { kind: "builtin" } }))).toMatchObject({ code: "PROJECT_NOT_FOUND", status: 404 });
  });

  it("refuses a body with a field the route does not take", async () => {
    const w = mergeWorld();
    expect(await failure(put(w, MAX, { revision: 4 }))).toMatchObject({ code: "CONFIG_INVALID", status: 400 });
    expect(await failure(putProjectPlaybook(playbookDeps(w), w.caller(MAX), "web", { defaultProcess: { kind: "builtin" } }))).toMatchObject({ code: "CONFIG_INVALID" });
  });
});

describe("which agents can be the project's process", () => {
  const unavailable = { code: "PROCESS_UNAVAILABLE", status: 400, message: expect.any(String) as unknown as string };

  it("refuses an agent owned by another project", async () => {
    const w = mergeWorld();
    const agentId = await makeAgent(w, { project: "ops" });
    expect(await failure(put(w, MAX, processBody(agentId)))).toMatchObject(unavailable);
    expect(stored(w)).toBeUndefined();
  });

  it("refuses an ordinary agent (no process purpose)", async () => {
    const w = mergeWorld();
    const agentId = await makeAgent(w, { process: false });
    expect(await failure(put(w, MAX, processBody(agentId)))).toMatchObject(unavailable);
  });

  it("refuses an archived process layer", async () => {
    const w = mergeWorld();
    const agentId = await makeAgent(w, { archive: true });
    expect(await failure(put(w, MAX, processBody(agentId)))).toMatchObject(unavailable);
  });

  it("refuses a process layer that has no published version", async () => {
    const w = mergeWorld();
    const agentId = await makeAgent(w, { publish: false });
    expect(await failure(put(w, MAX, processBody(agentId)))).toMatchObject(unavailable);
  });

  it("refuses an agent that does not exist, and a member-owned one, with the same fixed answer", async () => {
    const w = mergeWorld();
    expect(await failure(put(w, MAX, processBody(`agt_${"z".repeat(20)}`)))).toMatchObject(unavailable);
    const member = await w.store.create({ orgId: ORG_A, name: "mine", owner: { kind: "member", developerId: MAX }, createdBy: MAX, extends: ROVARA_CODE_AGENT_ID, purpose: "process" });
    await w.store.publish({ orgId: ORG_A, agentId: member.agentId, expectedDraftRevision: member.draftRevision, digest: "a".repeat(64), by: MAX });
    expect(await failure(put(w, MAX, processBody(member.agentId)))).toMatchObject(unavailable);
  });

  it("says the same words whatever the reason, and names nothing", async () => {
    const w = mergeWorld();
    const reasons = [await makeAgent(w, { project: "ops" }), await makeAgent(w, { process: false }), await makeAgent(w, { archive: true }), await makeAgent(w, { publish: false })];
    const messages = new Set<string>();
    for (const agentId of reasons) messages.add((await failure(put(w, MAX, processBody(agentId))))!.message);
    expect(messages.size).toBe(1);
  });

  it("leaves an agent without a purpose as it was: an ordinary agent has no purpose field", async () => {
    const w = mergeWorld();
    const ordinary = await w.store.create({ orgId: ORG_A, name: "ordinary", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, createdBy: MAX });
    expect("purpose" in ordinary).toBe(false);
    const process = await w.store.create({ orgId: ORG_A, name: "layer", owner: { kind: "project", project: "web" }, accountable: { developerId: MAX }, createdBy: MAX, extends: ROVARA_CODE_AGENT_ID, purpose: "process" });
    expect((await w.store.get(ORG_A, process.agentId))?.purpose).toBe("process");
  });
});

describe("projectProcessOf", () => {
  const readerOf = (w: MergeWorld) => ({ documentClient: w.db, tableName: "state", store: w.store });

  it("is the built-in Rovara Code for a project with no document, and for one set back to the built-in", async () => {
    const w = mergeWorld();
    expect(await projectProcessOf(readerOf(w), ORG_A, "web")).toEqual({ kind: "builtin", agentId: ROVARA_CODE_AGENT_ID });
    await put(w, MAX, {});
    expect(await projectProcessOf(readerOf(w), ORG_A, "web")).toEqual({ kind: "builtin", agentId: ROVARA_CODE_AGENT_ID });
  });

  it("is the process layer's agent id and its current version for a valid pointer", async () => {
    const w = mergeWorld();
    const agentId = await makeAgent(w);
    await put(w, MAX, processBody(agentId));
    expect(await projectProcessOf(readerOf(w), ORG_A, "web")).toEqual({ kind: "project_process", agentId, version: 1 });
    // A newer published version is what runs.
    const draft = (await w.store.get(ORG_A, agentId))!;
    await w.store.publish({ orgId: ORG_A, agentId, expectedDraftRevision: draft.draftRevision, digest: "b".repeat(64), by: MAX });
    expect(await projectProcessOf(readerOf(w), ORG_A, "web")).toEqual({ kind: "project_process", agentId, version: 2 });
    // Another project's reading is its own.
    expect(await projectProcessOf(readerOf(w), ORG_A, "ops")).toEqual({ kind: "builtin", agentId: ROVARA_CODE_AGENT_ID });
  });

  it("throws PROCESS_UNAVAILABLE for a pointer to a process layer archived since, and never falls back to the built-in", async () => {
    const w = mergeWorld();
    const agentId = await makeAgent(w);
    await put(w, MAX, processBody(agentId));
    await w.store.archive(ORG_A, agentId, MAX, undefined, { actor: fixtureActor(w.store, ORG_A, MAX) });
    expect(await failure(projectProcessOf(readerOf(w), ORG_A, "web"))).toMatchObject({ code: "PROCESS_UNAVAILABLE", status: 400 });
  });

  it("throws PROCESS_UNAVAILABLE for a pointer to an agent that is gone, one that moved to another project, one that lost its mark, and a document it cannot read", async () => {
    const w = mergeWorld();
    const agentId = await makeAgent(w);
    await put(w, MAX, processBody(agentId));
    // Moved to another project.
    // (A person can't move a layer any more, H8; one that was moved before then is stored directly.)
    w.db.set({ ...w.db.get(agentKey(ORG_A, agentId, "META"))!, owner: { kind: "project", project: "ops" } });
    expect(await failure(projectProcessOf(readerOf(w), ORG_A, "web"))).toMatchObject({ code: "PROCESS_UNAVAILABLE" });
    // A pointer at an id that holds no agent.
    const key = projectPlaybookKey(ORG_A, "web");
    w.db.set({ ...key, entityType: "PROJECT_PLAYBOOK", orgId: ORG_A, revision: 5, defaultProcess: { kind: "project_process", agentId: `agt_${"y".repeat(20)}` } });
    expect(await failure(projectProcessOf(readerOf(w), ORG_A, "web"))).toMatchObject({ code: "PROCESS_UNAVAILABLE" });
    // A document that is there but unreadable is not read as the built-in either.
    w.db.set({ ...key, entityType: "PROJECT_PLAYBOOK", orgId: ORG_A, revision: 5, defaultProcess: { kind: "somewhere_else" } });
    expect(await failure(projectProcessOf(readerOf(w), ORG_A, "web"))).toMatchObject({ code: "PROCESS_UNAVAILABLE" });
  });

  it("reads the stored document through the store the PUT wrote", async () => {
    const w = mergeWorld();
    expect(await readProjectPlaybook(readerOf(w), ORG_A, "web")).toEqual(DEFAULT_PROJECT_PLAYBOOK);
    await put(w, MAX, {});
    expect(await readProjectPlaybook(readerOf(w), ORG_A, "web")).toEqual({ revision: 1, defaultProcess: { kind: "builtin" } });
  });
});

describe("the route against the real broker", () => {
  it("serves GET and PUT at /v1/app/projects/{p}/playbook, with the project's maintainer allowed and a missing project a 404", async () => {
    const h = await createDeveloperTaskBroker({ brokerExtra: { agents: {} } });
    h.db.set({ ...projectMemberKey(TEST_ORG, MAYA.developerId, "payments"), entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: "payments", grantId: randomUUID(), role: "developer", projectRole: "maintainer", grantedAt: new Date().toISOString() });
    const read = await h.dev(MAYA, "GET", "/v1/app/projects/payments/playbook");
    expect(read.status, JSON.stringify(read.body)).toBe(200);
    expect(read.body.playbook).toEqual({ revision: 0, defaultProcess: { kind: "builtin" } });
    const changed = await h.dev(MAYA, "PUT", "/v1/app/projects/payments/playbook", { expectedRevision: 0, defaultProcess: { kind: "builtin" } });
    expect(changed.status, JSON.stringify(changed.body)).toBe(200);
    expect(changed.body.playbook).toEqual({ revision: 1, defaultProcess: { kind: "builtin" } });
    const stale = await h.dev(MAYA, "PUT", "/v1/app/projects/payments/playbook", { expectedRevision: 0, defaultProcess: { kind: "builtin" } });
    expect(stale.status).toBe(409);
    const missing = await h.dev(MAYA, "GET", "/v1/app/projects/nothing-here/playbook");
    expect(missing.status).toBe(404);
  });
});
