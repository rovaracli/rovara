// Plan 5 Task 12a: Task People and the dispatch fence follow the task's current owner. After a take-over the taker is an owner actor whatever their Slack link or
// channel membership, the person they took the task from is a commenter, the task is never orphaned while it has a current owner (so no channel member can
// claim it), dispatch asks for a witness for the taker first, and with no Slack proof for them it rests on their project authority.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { projectMemberKey, projectRevisionKey, slackBindingKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { orgMemberKey, orgRemovedKey } from "../../packages/contracts/src/org-node.js";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import type { Ec2OutboxRecord } from "../../packages/broker/src/aws/lambda.js";
import { createTaskAuthorityAdmission } from "../../packages/broker/src/aws/task-authority-admission.js";
import { guardTaskDispatch } from "../../packages/broker/src/aws/task-dispatch-access.js";
import { createTaskPersonRuntime, stateAuthorityWitnessForDispatch, type TaskPersonRuntimePorts } from "../../packages/broker/src/aws/task-person-runtime.js";
import { resolveTaskAccess } from "../../packages/broker/src/developer/task-access.js";
import {
  changeTaskPeople, getTaskPeople, getTaskPeopleCapabilities, resolveTaskDispatchPeople, resolveTaskPeopleAccess, takeTaskOwnership,
  type TaskPeopleDependencies, type TaskPersonCheck,
} from "../../packages/broker/src/developer/task-people.js";
import { taskOwnerKey, type DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { TaskPeopleDisplayAdmission } from "../../packages/broker/src/developer/task-people-display-budget.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const WORKSPACE_ID = "22222222-2222-4222-8222-222222222222";
const TEAM = "T0PEOPLE1";
const CHANNEL = "C0PEOPLE1";
const START = Date.parse("2026-10-22T10:00:00.000Z");
const SINCE = "2026-10-22T11:00:00.000Z";
const PRIYA = "a".repeat(64);
const MAX = "b".repeat(64);
const CASEY = "c".repeat(64);
const S_PRIYA = "U0PRIYA001";
const S_MAX = "U0MAX00001";
const S_CASEY = "U0CASEY001";

const caller = (developerId: string, slackUserId: string | undefined, name: string): DeveloperCaller => ({
  orgId: TEST_ORG, orgRole: "member" as const, developerId, name, sessionId: `s-${name}`, amr: slackUserId === undefined ? "oidc" : "slack", ...(slackUserId === undefined ? {} : { slackUserId }),
});
const MAX_CALLER = caller(MAX, undefined, "Max");
const PRIYA_CALLER = caller(PRIYA, S_PRIYA, "Priya");
const CASEY_CALLER = caller(CASEY, S_CASEY, "Casey");

const identity = (developerId: string, slackUserId: string, name: string) => ({
  developerId, slackUserId, name, method: "slack" as const, issuer: "https://slack.com", subject: slackUserId,
});

/** Priya's task, shared into a channel; `taken` makes Max (a person with no Slack link) its current owner. */
function task(taken: boolean | { slackUserId: string }): DeveloperTaskRecord {
  return {
    pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, orgId: TEST_ORG,
    developerId: PRIYA, provider: "slack", developerName: "Priya", slackUserId: S_PRIYA, client: "slack", project: "payments", title: "Payments", workspaceId: WORKSPACE_ID,
    ownerKey: taskOwnerKey(PRIYA, TASK_ID), conversationId: "conversation", startingRevision: 1,
    charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
    shared: true, share: { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000081", mode: "view", sharedReason: "requested", sharedAt: new Date(START).toISOString() },
    createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
    workflow: { revision: 7, stage: "IMPLEMENT", state: "RUNNING" } as never,
    ...(taken === false ? {} : { currentOwner: { developerId: MAX, name: "Max", provider: "oidc", since: SINCE, ...(taken === true ? {} : { slackUserId: taken.slackUserId }) } }),
  };
}

/** The checks Slack would give: Priya and Casey are eligible channel members; Max has a Slack proof only when `maxOnSlack` says so, else the proof throws. */
function people(options: { taken: boolean | { slackUserId: string }; maxOnSlack?: boolean; people?: boolean }) {
  const db = new FakeDynamoDb();
  db.set(task(options.taken) as unknown as Record<string, unknown>);
  const checks = new Map<string, TaskPersonCheck>([
    [PRIYA, { subject: { developerId: PRIYA, slackUserId: S_PRIYA }, identity: identity(PRIYA, S_PRIYA, "Priya"), eligible: true, channelMember: true }],
    [CASEY, { subject: { developerId: CASEY, slackUserId: S_CASEY }, identity: identity(CASEY, S_CASEY, "Casey"), eligible: true, channelMember: true }],
    ...(options.maxOnSlack === true ? [[MAX, { subject: { developerId: MAX, slackUserId: S_MAX }, identity: identity(MAX, S_MAX, "Max"), eligible: true, channelMember: true }] as const] : []),
  ]);
  const checkTaskPerson = vi.fn(async (_task: DeveloperTaskRecord, developerId: string) => {
    const found = checks.get(developerId);
    if (found === undefined) throw new Error("no Slack proof");
    return structuredClone(found);
  });
  const deps: TaskPeopleDependencies = {
    documentClient: db, tableName: "state", now: () => START, taskPeopleConfiguration: { peopleChangesEnabled: true }, checkTaskPerson,
    createTaskPeopleDisplayAdmission: () => ({
      assertOpen() {}, admitIdentity() {}, noteNativeIdentity() {}, close() {},
      async proof() { throw new Error("not routed"); }, async directory() { throw new Error("not routed"); },
    } satisfies TaskPeopleDisplayAdmission),
    listTaskPeople: async () => [...checks.values()].map((value) => structuredClone(value)),
  };
  const seedPerson = (developerId: string, personId: string = randomUUID()) => {
    const found = checks.get(developerId)!;
    const createdAt = new Date(START).toISOString();
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, ...found.identity, createdAt });
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON_SUBJECT#${developerId}`, schemaVersion: 1, personId, developerId, createdAt });
  };
  /** The sidecar as it was before the take-over: Priya the owner, Casey a commenter. */
  const seedSidecar = () => {
    seedPerson(PRIYA); seedPerson(CASEY);
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 4, orphaned: false, people: [
      { developerId: PRIYA, slackUserId: S_PRIYA, name: "Priya", role: "owner" },
      { developerId: CASEY, slackUserId: S_CASEY, name: "Casey", role: "commenter" },
    ] });
  };
  const sidecar = () => db.get(`DEVTASK#${TASK_ID}`, "PEOPLE") as unknown as { revision: number; orphaned: boolean; people: Array<{ developerId: string; role: string }> };
  return { db, deps, checks, checkTaskPerson, seedPerson, seedSidecar, sidecar, task: () => db.get(`DEVTASK#${TASK_ID}`, "META") as unknown as DeveloperTaskRecord };
}

const refusal = async (promise: Promise<unknown>) => {
  try { await promise; } catch (error) { return error as Error & { code?: string }; }
  throw new Error("expected a refusal");
};
const roles = (sidecar: { people: Array<{ developerId: string; role: string }> }) => Object.fromEntries(sidecar.people.map((person) => [person.developerId, person.role]));

describe("the first People read after a take-over, with no People list yet", () => {
  it("seeds the taker as the owner and the creator as a commenter, and the taker is not orphaned", async () => {
    const h = people({ taken: { slackUserId: S_MAX }, maxOnSlack: true });
    const view = await getTaskPeople(h.deps, caller(MAX, S_MAX, "Max"), TASK_ID);
    expect(roles(h.sidecar())).toEqual({ [MAX]: "owner", [PRIYA]: "commenter" });
    // Seeded as it should stay: nothing had to be corrected after it was written.
    expect(h.sidecar().revision).toBe(1);
    expect(h.sidecar().orphaned).toBe(false);
    expect(view.people.map((person) => [person.name, person.role, person.effectiveRole]).sort()).toEqual([["Max", "owner", "owner"], ["Priya", "commenter", "commenter"]]);
    expect(view).toMatchObject({ orphaned: false, canManage: true, canTakeOwnership: false });
  });

  it("works for a taker with no Slack link: only the creator is seeded (as a commenter), and the taker still manages the list", async () => {
    const h = people({ taken: true });
    const view = await getTaskPeople(h.deps, MAX_CALLER, TASK_ID);
    expect(roles(h.sidecar())).toEqual({ [PRIYA]: "commenter" });
    expect(h.sidecar().revision).toBe(1);
    expect(h.sidecar().orphaned).toBe(false);
    expect(view.canManage).toBe(true);
    expect(view.people.map((person) => [person.name, person.role])).toEqual([["Priya", "commenter"]]);
    expect(await getTaskPeopleCapabilities(h.deps, MAX_CALLER, TASK_ID)).toMatchObject({ canManagePeople: true, canTakeOwnership: false });
  });

  it("seeds the creator as the owner of a task nobody took over, exactly as before", async () => {
    const h = people({ taken: false });
    await getTaskPeople(h.deps, PRIYA_CALLER, TASK_ID);
    expect(roles(h.sidecar())).toEqual({ [PRIYA]: "owner" });
  });

  it("refuses the creator's first read of a taken-over task as an owner action, and admits the taker without a Slack proof", async () => {
    const h = people({ taken: true });
    expect((await refusal(changeTaskPeople(h.deps, PRIYA_CALLER, TASK_ID, { requestId: randomUUID(), expectedPeopleRevision: 1, targetDeveloperId: CASEY, role: "viewer" }))).code).toBe("TASK_ACCESS_DENIED");
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")).toBeUndefined();
    await expect(getTaskPeople(h.deps, MAX_CALLER, TASK_ID)).resolves.toMatchObject({ canManage: true });
  });
});

describe("a People list written before the take-over", () => {
  it("is reconciled on the next read: the previous owner becomes a commenter, the task is never orphaned, and an eligible channel member cannot take it", async () => {
    const h = people({ taken: true });
    h.seedSidecar();
    const access = await resolveTaskPeopleAccess(h.deps, h.task(), MAX);
    expect(access).toMatchObject({ role: "owner", orphaned: false, canTakeOwnership: false });
    expect(access?.ownerActorIds).toEqual([taskOwnerKey(MAX, TASK_ID)]);
    expect(roles(h.sidecar())).toEqual({ [PRIYA]: "commenter", [CASEY]: "commenter" });
    expect(h.sidecar()).toMatchObject({ orphaned: false, revision: 5 });
    // Casey is in the channel and eligible, and still cannot claim a task that has an owner.
    expect((await refusal(takeTaskOwnership(h.deps, CASEY_CALLER, TASK_ID, { requestId: randomUUID(), expectedPeopleRevision: 5 }))).code).toBe("TASK_ACCESS_DENIED");
    expect(await getTaskPeople(h.deps, CASEY_CALLER, TASK_ID)).toMatchObject({ orphaned: false, canTakeOwnership: false });
  });

  it("gives a taker who has a Slack proof an owner entry too, when Slack knows them (they have a person record)", async () => {
    const h = people({ taken: { slackUserId: S_MAX }, maxOnSlack: true });
    h.seedSidecar();
    h.seedPerson(MAX);
    await resolveTaskPeopleAccess(h.deps, h.task(), MAX);
    expect(roles(h.sidecar())).toEqual({ [PRIYA]: "commenter", [CASEY]: "commenter", [MAX]: "owner" });
  });

  it("names the taker first among the owner actors, and the creator is no owner actor", async () => {
    const h = people({ taken: true });
    h.seedSidecar();
    expect((await resolveTaskDispatchPeople(h.deps, h.task()))).toEqual({ peopleRevision: 4, ownerActorIds: [taskOwnerKey(MAX, TASK_ID)], status: "ALLOWED" });
    // The same People list with nobody taking over still has the creator as its owner.
    const plain = people({ taken: false });
    plain.seedSidecar();
    expect(await resolveTaskDispatchPeople(plain.deps, plain.task())).toEqual({ peopleRevision: 4, ownerActorIds: [taskOwnerKey(PRIYA, TASK_ID)], status: "ALLOWED" });
  });

  it("never answers OWNERLESS for a taken-over task, even one the sidecar marks orphaned", async () => {
    const h = people({ taken: true });
    h.seedSidecar();
    h.db.set({ ...h.sidecar(), pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, orphaned: true, people: [{ developerId: PRIYA, slackUserId: S_PRIYA, name: "Priya", role: "viewer" }] });
    expect(await resolveTaskDispatchPeople(h.deps, h.task())).toMatchObject({ status: "ALLOWED", ownerActorIds: [taskOwnerKey(MAX, TASK_ID)] });
    await resolveTaskPeopleAccess(h.deps, h.task(), MAX);
    expect(h.sidecar().orphaned).toBe(false);
  });

  it("still orphans a task nobody took over whose owners all left (the old rule)", async () => {
    const h = people({ taken: false });
    h.seedSidecar();
    h.checks.set(PRIYA, { ...h.checks.get(PRIYA)!, channelMember: false });
    await resolveTaskPeopleAccess(h.deps, h.task(), CASEY);
    expect(h.sidecar().orphaned).toBe(true);
    expect(await resolveTaskDispatchPeople(h.deps, h.task())).toMatchObject({ status: "OWNERLESS" });
  });

  it("gives the taker the owner role and access in resolveTaskAccess, and the creator no more than a commenter", async () => {
    const h = people({ taken: true });
    h.seedSidecar();
    const routeDeps = { documentClient: h.db, tableName: "state", orgId: TEST_ORG, slackTeamId: TEAM, checkTaskPerson: h.checkTaskPerson, taskPeopleConfiguration: { peopleChangesEnabled: true },
      checkAccess: async () => ({ revision: 1, policy: {} as never, access: "granted" as const, channelIds: [], role: "contributor" as const }), channelMember: async () => true, now: () => START, log: () => undefined } as never;
    await expect(resolveTaskAccess(routeDeps, MAX_CALLER, TASK_ID, "decide")).resolves.toMatchObject({ role: "owner", ownerActorIds: [taskOwnerKey(MAX, TASK_ID)] });
    expect((await refusal(resolveTaskAccess(routeDeps, PRIYA_CALLER, TASK_ID, "decide"))).code).toBe("TASK_NOT_FOUND");
    await expect(resolveTaskAccess(routeDeps, PRIYA_CALLER, TASK_ID, "comment")).resolves.toMatchObject({ role: "commenter" });
  });

  it("fences the sidecar's own writes on the owner they were decided for: a take-over landing between the read and the write changes nothing", async () => {
    const h = people({ taken: false });
    h.seedSidecar();
    h.seedPerson(PRIYA);
    // Priya, the owner, makes Casey a viewer; Max takes the task over after the read and before the write.
    let first = true;
    const racing = {
      ...h.deps,
      documentClient: { async send(command: unknown) {
        if (first && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") {
          first = false;
          h.db.set({ ...h.task(), currentOwner: { developerId: MAX, name: "Max", provider: "oidc", since: SINCE } });
        }
        return h.db.send(command as never);
      } },
    };
    const before = structuredClone(h.sidecar());
    const outcome = await refusal(changeTaskPeople(racing, PRIYA_CALLER, TASK_ID, { requestId: randomUUID(), expectedPeopleRevision: 4, targetDeveloperId: CASEY, role: "viewer" }));
    expect(outcome.code).toBeDefined();
    expect(h.sidecar()).toEqual(before);
  });
});

describe("a task nobody took over keeps its old rules", () => {
  it("refuses to seed a People list for a creator Slack can't vouch for, writing nothing", async () => {
    const h = people({ taken: false });
    h.checks.set(PRIYA, { ...h.checks.get(PRIYA)!, channelMember: false });
    expect((await refusal(getTaskPeople(h.deps, CASEY_CALLER, TASK_ID))).code).toBe("TASK_ACCESS_DENIED");
    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")).toBeUndefined();
  });
});

describe("the taker's own entry in a People list", () => {
  const setup = (change: (h: ReturnType<typeof people>) => void, entries: Array<{ developerId: string; slackUserId: string; name: string; role: string }>) => {
    const h = people({ taken: { slackUserId: S_MAX }, maxOnSlack: true });
    h.seedPerson(PRIYA); h.seedPerson(CASEY); h.seedPerson(MAX);
    h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 4, orphaned: false, people: entries });
    change(h);
    return h;
  };
  const priya = { developerId: PRIYA, slackUserId: S_PRIYA, name: "Priya", role: "commenter" };
  const casey = { developerId: CASEY, slackUserId: S_CASEY, name: "Casey", role: "commenter" };
  const max = (role: string) => ({ developerId: MAX, slackUserId: S_MAX, name: "Max", role });

  it("is kept as it is when Slack can't be asked about the taker right now: their ownership never rests on it", async () => {
    const h = setup((world) => world.checks.delete(MAX), [priya, casey, max("owner")]);
    await resolveTaskPeopleAccess(h.deps, h.task(), MAX);
    expect(roles(h.sidecar())[MAX]).toBe("owner");
    expect(h.sidecar().revision).toBe(4);
  });

  it("is lowered to commenter when Slack says the taker has left the channel, though they stay the owner", async () => {
    const h = setup((world) => world.checks.set(MAX, { ...world.checks.get(MAX)!, channelMember: false }), [priya, casey, max("owner")]);
    const access = await resolveTaskPeopleAccess(h.deps, h.task(), MAX);
    expect(roles(h.sidecar())[MAX]).toBe("commenter");
    expect(access).toMatchObject({ role: "owner", orphaned: false });
    expect(access?.ownerActorIds).toEqual([taskOwnerKey(MAX, TASK_ID)]);
  });

  it("is added as an owner entry for a taker Slack knows and who is in the channel", async () => {
    const h = setup(() => undefined, [priya, casey]);
    await resolveTaskPeopleAccess(h.deps, h.task(), MAX);
    expect(roles(h.sidecar())).toEqual({ [PRIYA]: "commenter", [CASEY]: "commenter", [MAX]: "owner" });
  });

  it("is not added for a taker who is only a project viewer, nor when Slack's answer is for someone else", async () => {
    const viewer = setup((world) => world.checks.set(MAX, { ...world.checks.get(MAX)!, projectViewer: true }), [priya, casey]);
    await resolveTaskPeopleAccess(viewer.deps, viewer.task(), MAX);
    expect(roles(viewer.sidecar())[MAX]).toBeUndefined();
    const other = setup((world) => world.checks.set(MAX, { ...world.checks.get(MAX)!, identity: { ...world.checks.get(MAX)!.identity, subject: "U0SOMEONE01" } }), [priya, casey]);
    await resolveTaskPeopleAccess(other.deps, other.task(), MAX);
    expect(roles(other.sidecar())[MAX]).toBeUndefined();
  });

  it("is never raised from denied or revived once the taker was denied: the entry stays as the owner wrote it", async () => {
    const h = setup(() => undefined, [priya, casey, max("denied")]);
    const access = await resolveTaskPeopleAccess(h.deps, h.task(), MAX);
    expect(roles(h.sidecar())[MAX]).toBe("denied");
    // They are still the task's owner by taking it over: a denied entry does not take that away.
    expect(access).toMatchObject({ role: "owner" });
  });

  it("is listed first among the owner actors, ahead of another owner of the list", async () => {
    const h = setup(() => undefined, [priya, { ...casey, role: "owner" }, max("owner")]);
    const access = await resolveTaskPeopleAccess(h.deps, h.task(), CASEY);
    expect(access?.ownerActorIds).toEqual([taskOwnerKey(MAX, TASK_ID), taskOwnerKey(CASEY, TASK_ID)]);
    const dispatch = await resolveTaskDispatchPeople(h.deps, h.task());
    expect(dispatch?.ownerActorIds).toEqual([taskOwnerKey(MAX, TASK_ID), taskOwnerKey(CASEY, TASK_ID)]);
  });
});

// ---- dispatch, with the production witness wiring (dispatcher.ts composes it with `stateAuthorityWitnessForDispatch`)

function dispatch(options: { maxRole?: "developer" | "viewer" | undefined; maxOnSlack?: boolean; withSidecar?: boolean } = {}) {
  const h = people({ taken: options.maxOnSlack === true ? { slackUserId: S_MAX } : true, ...(options.maxOnSlack === undefined ? {} : { maxOnSlack: options.maxOnSlack }) });
  // Everyone here is a member of the company who may write (owner decision 86: a task person is a Rovara member).
  for (const developerId of [PRIYA, MAX, CASEY]) h.db.set({ ...orgMemberKey(TEST_ORG, developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId, role: "member" });
  if (options.withSidecar !== false) h.seedSidecar();
  const operationId = randomUUID();
  const outbox: Ec2OutboxRecord = {
    id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId: WORKSPACE_ID, deploymentMode: "ec2-ebs",
    invocation: { protocolVersion: 1, kind: "task", operationId, workspaceId: WORKSPACE_ID, fence: 4, projectRevision: 1,
      callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "continue", conversationStarted: true } },
  };
  h.db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: TASK_ID, developerId: PRIYA });
  h.db.set({ pk: `OUTBOX#${outbox.id}`, sk: "OUTBOX", ...outbox });
  h.db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: `OPERATION#${operationId}`, status: "DISPATCHING", fence: 4 });
  h.db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "META", status: "BUSY", activeOperationId: operationId, fence: 4 });
  const revision = { ...projectRevisionKey(TEST_ORG, "payments", 7), definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: false } } };
  h.db.set(revision);
  const membershipFor = (developerId: string, role: "developer" | "viewer") => ({ ...projectMemberKey(TEST_ORG, developerId, "payments"), projectName: "payments", role });
  if (options.maxRole !== undefined) h.db.set(membershipFor(MAX, options.maxRole));
  const developerRows = () => [...[PRIYA, MAX, CASEY].flatMap((developerId) => {
    const row = h.db.get(projectMemberKey(TEST_ORG, developerId, "payments").pk, projectMemberKey(TEST_ORG, developerId, "payments").sk);
    return row === undefined ? [] : [{ ...row, developerId }];
  })];
  const admission = createTaskAuthorityAdmission({ now: () => START, lambdaRemainingMs: 20_000 });
  const ports = {
    readTaskRecord: vi.fn(async ({ sortKey }: { taskId: string; sortKey: string }) => sortKey === "META" ? h.task() as unknown as Record<string, unknown> : undefined),
    readDeveloperRecord: vi.fn(async () => undefined),
    readOrgRecord: vi.fn(async ({ key }: { key: { pk: string; sk: string } }) => h.db.get(key.pk, key.sk)),
    projectAuthorityReader: {
      latestRevision: vi.fn(async () => ({ revision: { ...revision, revision: 7 }, complete: true })),
      memberships: vi.fn(async (_orgId: string, developerId: string) => ({ items: developerRows().filter((row) => row.developerId === developerId) as never, complete: true })),
      bindings: vi.fn(async () => ({ items: [], complete: true })),
      orgMember: vi.fn(async (_orgId: string, developerId: string) => ({ item: h.db.get(orgMemberKey(TEST_ORG, developerId).pk, orgMemberKey(TEST_ORG, developerId).sk) as never, complete: true })),
    },
    taskPersonProof: vi.fn(async () => { throw new Error("Max has no Slack proof"); }),
  } as unknown as TaskPersonRuntimePorts;
  const runtime = createTaskPersonRuntime({ orgId: TEST_ORG, admission, ports, stateTableName: "state", slackTeamId: TEAM, now: () => START, uuid: () => randomUUID() });
  // What dispatcher.ts hands the guard: the runtime's identity check, and the dispatch witness.
  const guard = () => guardTaskDispatch({
    documentClient: h.db, tableName: "state", orgId: TEST_ORG, admission,
    checkTaskPerson: (record, developerId) => h.checkTaskPerson(record, developerId),
    stateAuthorityWitnessForOwnerActor: (record, ownerActorId) => stateAuthorityWitnessForDispatch(runtime, record, ownerActorId),
  }, outbox);
  return { ...h, outbox, guard, ports, membershipFor, runtime };
}

describe("dispatch of a task a person with no Slack link took over", () => {
  it("stays ALLOWED after a People read, on the taker's project grant (the creator's stale owner entry is no authority)", async () => {
    const d = dispatch({ maxRole: "developer" });
    await getTaskPeople(d.deps, MAX_CALLER, TASK_ID);
    expect(d.sidecar().orphaned).toBe(false);
    await expect(d.guard()).resolves.toBe("ALLOWED");
    expect(d.db.get(`OUTBOX#${d.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("is ALLOWED even before any People read has reconciled the old list", async () => {
    const d = dispatch({ maxRole: "developer" });
    await expect(d.guard()).resolves.toBe("ALLOWED");
  });

  it("parks when the taker is a project viewer, and Priya's own grant does not carry the task", async () => {
    const d = dispatch({ maxRole: "viewer" });
    d.db.set(d.membershipFor(PRIYA, "developer"));
    await getTaskPeople(d.deps, MAX_CALLER, TASK_ID);
    await expect(d.guard()).resolves.toBe("PARKED");
    expect(d.db.get(`OUTBOX#${d.outbox.id}`, "OUTBOX")?.status).toBe("WAITING_FOR_TASK_ACCESS");
    expect(d.db.get(`OUTBOX#${d.outbox.id}`, "TASK_ACCESS_PAUSE")).toMatchObject({ reason: "PROJECT_VIEWER" });
  });

  it("does not dispatch on the taker's behalf when they hold no role on the project at all (fails closed)", async () => {
    const d = dispatch();
    await expect(d.guard()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(d.db.get(`OUTBOX#${d.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("is fenced on the taker's grant: a grant deleted between the witness and the final fence fails the fence, and the next attempt fails closed", async () => {
    const d = dispatch({ maxRole: "developer" });
    const key = projectMemberKey(TEST_ORG, MAX, "payments");
    let removed = false;
    const documentClient = {
      async send(command: unknown) {
        const input = (command as { input?: { TransactItems?: Array<{ ConditionCheck?: { Key?: { pk?: string; sk?: string } } }> } }).input;
        if (!removed && input?.TransactItems?.some((item) => item.ConditionCheck?.Key?.sk === key.sk && item.ConditionCheck.Key.pk === key.pk)) {
          removed = true;
          d.db.delete(key.pk, key.sk);
        }
        return d.db.send(command as never);
      },
    };
    const admission = createTaskAuthorityAdmission({ now: () => START, lambdaRemainingMs: 20_000 });
    const outcome = await guardTaskDispatch({
      documentClient, tableName: "state", orgId: TEST_ORG, admission, checkTaskPerson: d.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: (record, ownerActorId) => stateAuthorityWitnessForDispatch(d.runtime, record, ownerActorId),
    }, d.outbox).catch((error: { code?: string }) => error.code);
    expect(removed).toBe(true);
    expect(outcome).toBe("RUNTIME_UNAVAILABLE");
    expect(d.db.get(`OUTBOX#${d.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("uses the Slack identity witness when the taker has an eligible in-channel Slack proof", async () => {
    const d = dispatch({ maxOnSlack: true });
    d.ports.projectAuthorityReader.memberships = vi.fn(async (_orgId: string, developerId: string) => ({ items: developerId === MAX ? [d.membershipFor(MAX, "developer")] as never : [], complete: true }));
    d.ports.taskPersonProof = vi.fn(async () => ({ result: { ok: true as const, user: { id: S_MAX, teamId: TEAM, name: "Max" }, memberOf: [CHANNEL] }, slackCallsUsed: 1 }));
    d.db.set(d.membershipFor(MAX, "developer"));
    d.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON_SUBJECT#${MAX}`, schemaVersion: 1, personId: randomUUID(), developerId: MAX, createdAt: new Date(START).toISOString() });
    await expect(d.guard()).resolves.toBe("ALLOWED");
  });

  it("is fenced on the owner: a take-over landing between the read and the final fence fails the fence, and the next attempt judges the new owner", async () => {
    // No People list, so the judgement is the owner's own grant: Max's, then (after the take-over) Casey's, who holds a grant too.
    const d = dispatch({ maxRole: "developer", withSidecar: false });
    d.db.set(d.membershipFor(CASEY, "developer"));
    let transactions = 0;
    let taken = false;
    const documentClient = {
      async send(command: unknown) {
        const input = (command as { input?: { TransactItems?: Array<{ ConditionCheck?: { Key?: { sk?: string } } }> } }).input;
        if (input?.TransactItems?.some((item) => item.ConditionCheck?.Key?.sk === "META")) {
          transactions += 1;
          if (!taken) {
            taken = true;
            d.db.set({ ...d.task(), currentOwner: { developerId: CASEY, name: "Casey", provider: "oidc", since: "2026-10-22T12:00:00.000Z" } });
          }
        }
        return d.db.send(command as never);
      },
    };
    const admission = createTaskAuthorityAdmission({ now: () => START, lambdaRemainingMs: 20_000 });
    await expect(guardTaskDispatch({
      documentClient, tableName: "state", orgId: TEST_ORG, admission, checkTaskPerson: d.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: (record, ownerActorId) => stateAuthorityWitnessForDispatch(d.runtime, record, ownerActorId),
    }, d.outbox)).resolves.toBe("ALLOWED");
    // The first attempt's fence (decided for Max) failed on the changed owner; the second, decided for Casey, held.
    expect(transactions).toBe(2);
  });

  it("parks a task whose current owner can't be read, and never judges the creator instead", async () => {
    const d = dispatch({ maxRole: "developer" });
    d.db.set({ ...d.task(), currentOwner: { developerId: MAX } });
    d.db.set(d.membershipFor(PRIYA, "developer"));
    await expect(d.guard()).resolves.toBe("PARKED");
    expect(d.db.get(`OUTBOX#${d.outbox.id}`, "TASK_ACCESS_PAUSE")).toMatchObject({ reason: "OWNERLESS" });
  });
});

describe("dispatch of a task with no People list", () => {
  it("parks when the person who took it over is a project viewer, and does not when only the creator is", async () => {
    const taken = dispatch({ maxRole: "viewer", withSidecar: false });
    taken.db.set(taken.membershipFor(PRIYA, "developer"));
    await expect(taken.guard()).resolves.toBe("PARKED");
    expect(taken.db.get(`OUTBOX#${taken.outbox.id}`, "TASK_ACCESS_PAUSE")).toMatchObject({ reason: "PROJECT_VIEWER" });

    const creatorDemoted = dispatch({ maxRole: "developer", withSidecar: false });
    creatorDemoted.db.set(creatorDemoted.membershipFor(PRIYA, "viewer"));
    await expect(creatorDemoted.guard()).resolves.toBe("ALLOWED");
  });
});

describe("dispatch of a task whose taker is on Slack and holds the project through its channel", () => {
  const MAX_NATIVE = developerIdForSlackUser(S_MAX);
  /** The production wiring end to end: the runtime's own identity check (Max has a task person record), the witness the dispatcher composes, and no grant for Max at all. */
  function slackWorld(options: { proof: boolean | "ineligible"; grant?: boolean }) {
    const h = people({ taken: false });
    for (const developerId of [PRIYA, MAX_NATIVE]) h.db.set({ ...orgMemberKey(TEST_ORG, developerId), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId, role: "member" });
    const task: DeveloperTaskRecord = { ...h.task(), currentOwner: { developerId: MAX_NATIVE, name: "Max", provider: "slack", slackUserId: S_MAX, since: SINCE } };
    h.db.set(task as never);
    const personId = randomUUID();
    const createdAt = new Date(START).toISOString();
    h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, developerId: MAX_NATIVE, slackUserId: S_MAX, name: "Max", method: "slack", issuer: "https://slack.com", subject: S_MAX, createdAt });
    h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON_SUBJECT#${MAX_NATIVE}`, schemaVersion: 1, personId, developerId: MAX_NATIVE, createdAt });
    h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 4, orphaned: false, people: [{ developerId: PRIYA, slackUserId: S_PRIYA, name: "Priya", role: "owner" }] });
    const operationId = randomUUID();
    const outbox: Ec2OutboxRecord = {
      id: randomUUID(), entityType: "OUTBOX", status: "QUEUED", operationId, workspaceId: WORKSPACE_ID, deploymentMode: "ec2-ebs",
      invocation: { protocolVersion: 1, kind: "task", operationId, workspaceId: WORKSPACE_ID, fence: 4, projectRevision: 1, callbackCapability: "c".repeat(64), payload: { conversationId: randomUUID(), prompt: "continue", conversationStarted: true } },
    };
    h.db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "DEVELOPER_TASK", entityType: "DEVELOPER_TASK_POINTER", taskId: TASK_ID, developerId: PRIYA });
    h.db.set({ pk: `OUTBOX#${outbox.id}`, sk: "OUTBOX", ...outbox });
    h.db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: `OPERATION#${operationId}`, status: "DISPATCHING", fence: 4 });
    h.db.set({ pk: `WORKSPACE#${WORKSPACE_ID}`, sk: "META", status: "BUSY", activeOperationId: operationId, fence: 4 });
    const revision = { ...projectRevisionKey(TEST_ORG, "payments", 7), definition: { revision: 7, developerTasks: { enabled: true, channelMembersMayUse: true } } };
    const binding = { ...slackBindingKey(TEST_ORG, TEAM, CHANNEL), teamId: TEAM, channelId: CHANNEL, projectName: "payments", updatedAt: "2026-10-01T00:00:00.000Z" };
    h.db.set(revision);
    h.db.set(binding);
    // The taker's own project grant, in the table and in the runtime's reads alike.
    const grant = options.grant === true ? { ...projectMemberKey(TEST_ORG, MAX_NATIVE, "payments"), projectName: "payments", role: "developer" } : undefined;
    if (grant !== undefined) h.db.set(grant);
    const admission = createTaskAuthorityAdmission({ now: () => START, lambdaRemainingMs: 20_000 });
    const readOrgRecord = vi.fn(async ({ key }: { key: { pk: string; sk: string } }) => h.db.get(key.pk, key.sk));
    const ports = {
      readTaskRecord: vi.fn(async ({ sortKey }: { taskId: string; sortKey: string }) => h.db.get(`DEVTASK#${TASK_ID}`, sortKey)),
      readDeveloperRecord: vi.fn(async () => undefined),
      readOrgRecord,
      projectAuthorityReader: {
        latestRevision: vi.fn(async () => ({ revision: { ...revision, revision: 7 }, complete: true })),
        memberships: vi.fn(async () => ({ items: grant === undefined ? [] : [grant] as never, complete: true })),
        bindings: vi.fn(async () => ({ items: [binding] as never, complete: true })),
        orgMember: vi.fn(async () => ({ complete: true })),
      },
      taskPersonProof: vi.fn(async () => {
        if (!options.proof) throw new Error("Slack is unavailable");
        if (options.proof === "ineligible") return { result: { ok: false as const, error: "ineligible" as const }, slackCallsUsed: 1 };
        return { result: { ok: true as const, user: { id: S_MAX, teamId: TEAM, name: "Max" }, memberOf: [CHANNEL] }, slackCallsUsed: 1 };
      }),
    } as unknown as TaskPersonRuntimePorts;
    const runtime = createTaskPersonRuntime({ orgId: TEST_ORG, admission, ports, stateTableName: "state", slackTeamId: TEAM, now: () => START, uuid: () => randomUUID() });
    const guard = () => guardTaskDispatch({
      documentClient: h.db, tableName: "state", orgId: TEST_ORG, admission, checkTaskPerson: runtime.checkTaskPerson,
      stateAuthorityWitnessForOwnerActor: (record, ownerActorId) => stateAuthorityWitnessForDispatch(runtime, record, ownerActorId),
    }, outbox);
    return { ...h, task, runtime, guard, outbox, readOrgRecord };
  }

  it("rests on the Slack identity witness: ALLOWED with no grant at all", async () => {
    const w = slackWorld({ proof: true });
    await expect(w.guard()).resolves.toBe("ALLOWED");
  });

  it("refuses the Slack identity witness for a taker removed from the company, whatever Slack says (member removal)", async () => {
    const w = slackWorld({ proof: true });
    expect((w.task as unknown as { orgId?: unknown }).orgId).toBe(TEST_ORG);
    // A removal deletes the member record and writes the tombstone.
    w.db.delete(orgMemberKey(TEST_ORG, MAX_NATIVE));
    w.db.set({ ...orgRemovedKey(TEST_ORG, MAX_NATIVE), removedAt: "2026-10-30T10:00:00.000Z" });
    // With the tombstone the witness is refused, so the dispatch fails closed and is retried (the test above shows the same world ALLOWED without it). Nothing is posted.
    await expect(w.guard()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.db.get(`OUTBOX#${w.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
    expect(w.readOrgRecord).toHaveBeenCalledWith(expect.objectContaining({ key: orgRemovedKey(TEST_ORG, MAX_NATIVE) }));
  });

  it("takes no org record answered under another key: the removal check fails closed", async () => {
    const w = slackWorld({ proof: true });
    w.readOrgRecord.mockImplementation(async () => ({ pk: "ORG#elsewhere#MEMBER", sk: "someone" }));
    // The proof is unavailable, so the task parks for proof; it is never ALLOWED.
    await expect(w.guard()).resolves.toBe("PARKED");
  });

  it("falls to the taker's own project grant when Slack refuses to vouch for them: ALLOWED", async () => {
    const w = slackWorld({ proof: "ineligible", grant: true });
    await expect(w.guard()).resolves.toBe("ALLOWED");
  });

  it("refuses a removed taker whose project grant is still there (the removal's access step has not run yet)", async () => {
    const w = slackWorld({ proof: "ineligible", grant: true });
    w.db.delete(orgMemberKey(TEST_ORG, MAX_NATIVE));
    w.db.set({ ...orgRemovedKey(TEST_ORG, MAX_NATIVE), removedAt: "2026-10-30T10:00:00.000Z" });
    await expect(w.guard()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.db.get(`OUTBOX#${w.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("with Slack unable to vouch for the taker, falls to their project authority, which a channel alone never gives: it fails closed", async () => {
    const w = slackWorld({ proof: false });
    await expect(w.guard()).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(w.db.get(`OUTBOX#${w.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
  });

  it("asks for a project witness only for the task's taker, never for another actor or for a task nobody took over", async () => {
    const w = slackWorld({ proof: false });
    const grant = { ...projectMemberKey(TEST_ORG, MAX_NATIVE, "payments"), projectName: "payments", role: "developer" };
    // A runtime whose project reads give the taker a grant of their own.
    const granted = createTaskPersonRuntime({
      orgId: TEST_ORG, admission: createTaskAuthorityAdmission({ now: () => START, lambdaRemainingMs: 20_000 }), stateTableName: "state", slackTeamId: TEAM, now: () => START, uuid: () => randomUUID(),
      ports: { readTaskRecord: async () => undefined, readDeveloperRecord: async () => undefined, readOrgRecord: async ({ key }) => String(key.sk).startsWith("MEMBER#") ? { ...key, role: "member" } : undefined, taskPersonProof: async () => { throw new Error("unused"); },
        projectAuthorityReader: {
          latestRevision: async () => ({ revision: { ...projectRevisionKey(TEST_ORG, "payments", 7), revision: 7, definition: { developerTasks: { enabled: true, channelMembersMayUse: false } } }, complete: true }),
          memberships: async () => ({ items: [grant] as never, complete: true }), bindings: async () => ({ items: [], complete: true }), orgMember: async () => ({ complete: true }),
        } },
    });
    await expect(stateAuthorityWitnessForDispatch(granted, w.task, taskOwnerKey(MAX_NATIVE, TASK_ID))).resolves.toMatchObject({ developerId: MAX_NATIVE, access: "granted", taskId: TASK_ID });
    await expect(stateAuthorityWitnessForDispatch(granted, w.task, taskOwnerKey(CASEY, TASK_ID))).resolves.toBeUndefined();
    await expect(stateAuthorityWitnessForDispatch(granted, w.task, taskOwnerKey(PRIYA, TASK_ID))).resolves.toBeUndefined();
    // A task nobody took over has no taker: even its creator's actor id gets no project witness from here.
    const { currentOwner: _taker, ...untaken } = w.task as unknown as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out of the copy
    await expect(stateAuthorityWitnessForDispatch(granted, untaken as unknown as DeveloperTaskRecord, taskOwnerKey(PRIYA, TASK_ID))).resolves.toBeUndefined();
  });
});

describe("dispatch fences and pauses under a changing owner", () => {
  it("fences a task with no workflow on the owner too", async () => {
    const d = dispatch({ maxRole: "developer", withSidecar: false });
    d.db.set(d.membershipFor(CASEY, "developer"));
    const { workflow: _workflow, ...bare } = d.task() as unknown as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out of the copy
    d.db.set(bare);
    let transactions = 0;
    let taken = false;
    const documentClient = {
      async send(command: unknown) {
        const input = (command as { input?: { TransactItems?: Array<{ ConditionCheck?: { Key?: { pk?: string; sk?: string } } }> } }).input;
        if (input?.TransactItems?.some((item) => item.ConditionCheck?.Key?.sk === "META" && item.ConditionCheck.Key.pk === `DEVTASK#${TASK_ID}`)) {
          transactions += 1;
          if (!taken) {
            taken = true;
            d.db.set({ ...d.task(), currentOwner: { developerId: CASEY, name: "Casey", provider: "oidc", since: "2026-10-22T12:00:00.000Z" } });
          }
        }
        return d.db.send(command as never);
      },
    };
    const admission = createTaskAuthorityAdmission({ now: () => START, lambdaRemainingMs: 20_000 });
    await expect(guardTaskDispatch({ documentClient, tableName: "state", orgId: TEST_ORG, admission, checkTaskPerson: d.checkTaskPerson }, d.outbox)).resolves.toBe("ALLOWED");
    expect(transactions).toBe(2);
  });

  it("writes a pause only while the owner it was decided for still owns the task", async () => {
    const d = dispatch({ maxRole: "viewer", withSidecar: false });
    let taken = false;
    const documentClient = {
      async send(command: unknown) {
        const input = (command as { input?: { TransactItems?: Array<{ Put?: { Item?: { sk?: string } } }> } }).input;
        if (!taken && input?.TransactItems?.some((item) => item.Put?.Item?.sk === "TASK_ACCESS_PAUSE")) {
          taken = true;
          d.db.set({ ...d.task(), currentOwner: { developerId: CASEY, name: "Casey", provider: "oidc", since: "2026-10-22T12:00:00.000Z" } });
        }
        return d.db.send(command as never);
      },
    };
    const admission = createTaskAuthorityAdmission({ now: () => START, lambdaRemainingMs: 20_000 });
    const outcome = await guardTaskDispatch({ documentClient, tableName: "state", orgId: TEST_ORG, admission, checkTaskPerson: d.checkTaskPerson }, d.outbox).catch((error: { code?: string }) => error.code ?? "error");
    expect(taken).toBe(true);
    // The pause for Max, a viewer, was refused because the task is Casey's now; nothing was parked on the old judgement.
    expect(d.db.get(`OUTBOX#${d.outbox.id}`, "OUTBOX")?.status).toBe("QUEUED");
    expect(outcome).not.toBe("PARKED");
  });

  it("lets a People task go on through another owner when its creator, nobody having taken it over, became a project viewer", async () => {
    const d = dispatch({ maxRole: "developer", withSidecar: false });
    const { currentOwner: _taker, ...plain } = d.task() as unknown as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out of the copy
    d.db.set(plain);
    d.seedPerson(PRIYA);
    d.seedPerson(CASEY);
    d.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 4, orphaned: false, people: [
      { developerId: PRIYA, slackUserId: S_PRIYA, name: "Priya", role: "owner" }, { developerId: CASEY, slackUserId: S_CASEY, name: "Casey", role: "owner" },
    ] });
    d.checks.set(PRIYA, { ...d.checks.get(PRIYA)!, projectViewer: true });
    d.db.set(d.membershipFor(PRIYA, "viewer"));
    d.db.set(d.membershipFor(CASEY, "developer"));
    const admission = createTaskAuthorityAdmission({ now: () => START, lambdaRemainingMs: 20_000 });
    // Priya is a viewer and Casey holds the task as an owner: only Casey's judgement counts, so it is allowed, never parked on Priya's role.
    await expect(guardTaskDispatch({ documentClient: d.db, tableName: "state", orgId: TEST_ORG, admission, checkTaskPerson: d.checkTaskPerson }, d.outbox)).resolves.toBe("ALLOWED");
  });

  it("parks a People task whose creator became a project viewer as ownerless, as before: the viewer check is the taker's alone", async () => {
    const d = dispatch({ maxRole: "developer", withSidecar: false });
    // No take-over here: Priya's own People list, Priya lowered to viewer.
    const { currentOwner: _taker, ...plain } = d.task() as unknown as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out of the copy
    d.db.set(plain);
    d.seedPerson(PRIYA);
    d.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 4, orphaned: false, people: [{ developerId: PRIYA, slackUserId: S_PRIYA, name: "Priya", role: "owner" }] });
    d.checks.set(PRIYA, { ...d.checks.get(PRIYA)!, projectViewer: true });
    d.db.set(d.membershipFor(PRIYA, "viewer"));
    await expect(d.guard()).resolves.toBe("PARKED");
    expect(d.db.get(`OUTBOX#${d.outbox.id}`, "TASK_ACCESS_PAUSE")).toMatchObject({ reason: "OWNERLESS" });
  });
});

describe("a taker with no recorded name (ruling on 12a question 1)", () => {
  /** Max took the task over and his name was never recorded: the id, sign-in method and time are all there is. */
  const nameless = (h: ReturnType<typeof people>) => {
    const record = h.task();
    const { name: _name, ...taker } = record.currentOwner as unknown as Record<string, unknown>; // eslint-disable-line @typescript-eslint/no-unused-vars -- removed on purpose
    h.db.set({ ...record, currentOwner: taker });
  };

  it("is an owner actor at dispatch: ALLOWED, never OWNERLESS, with the creator no authority", async () => {
    const h = people({ taken: true });
    h.seedSidecar();
    nameless(h);
    expect(await resolveTaskDispatchPeople(h.deps, h.task())).toEqual({ peopleRevision: 4, ownerActorIds: [taskOwnerKey(MAX, TASK_ID)], status: "ALLOWED" });
  });

  it("is never orphaned, and manages the People list as the owner", async () => {
    const h = people({ taken: true });
    h.seedSidecar();
    h.db.set({ ...h.sidecar(), pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, orphaned: true, people: [{ developerId: PRIYA, slackUserId: S_PRIYA, name: "Priya", role: "viewer" }] });
    nameless(h);
    await resolveTaskPeopleAccess(h.deps, h.task(), MAX);
    expect(h.sidecar().orphaned).toBe(false);
  });
});
