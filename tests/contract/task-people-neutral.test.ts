// Owner decision 86 (neutral identity A-13), at the People list: a member with no Slack account is a task person like any other. Their entry has no Slack id, they are never a default
// commenter of a Slack-shared task they were not added to, and with TaskPeopleChangesEnabled off nothing about them changes.
import { describe, expect, it, vi } from "vitest";
import type { DeveloperCaller } from "../../packages/broker/src/aws/developer-routes.js";
import { changeTaskPeople, getTaskPeople, loadTaskPeople, type TaskPeopleDependencies, type TaskPersonCheck } from "../../packages/broker/src/developer/task-people.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { TaskPeopleDisplayAdmission } from "../../packages/broker/src/developer/task-people-display-budget.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const TEAM = "T0PEOPLE1";
const CHANNEL = "C0PEOPLE1";
const START = Date.parse("2026-10-11T10:00:00.000Z");
const A = "a".repeat(64); // the task's creator, signed in with GitHub, no Slack account
const B = "b".repeat(64); // another member, signed in on the web, no Slack account
const C = "c".repeat(64); // a Slack person
const SC = "U0MEMBER02";
const PERSON_B = "22222222-2222-4222-8222-222222222222";
const PERSON_C = "33333333-3333-4333-8333-333333333333";

const caller = (developerId: string, name: string, amr: DeveloperCaller["amr"]): DeveloperCaller => ({ orgId: TEST_ORG, orgRole: "member", developerId, name, sessionId: `s-${name}`, amr });
const CREATOR = caller(A, "Nia Creator", "github");
const WEB = caller(B, "Oliver Web", "cloud");

const task = () => ({
  pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, orgId: TEST_ORG,
  developerId: A, provider: "github", developerName: CREATOR.name,
  client: "slack", project: "payments", title: "Payments", workspaceId: "workspace", ownerKey: "f".repeat(64), conversationId: "conversation", startingRevision: 1,
  charge: { member: { pk: "member", sk: "counter" }, organization: { pk: "organization", sk: "counter" } },
  shared: true, share: { teamId: TEAM, channelId: CHANNEL, threadTs: "1695500000.000081", mode: "view", sharedReason: "requested", sharedAt: new Date(START).toISOString() },
  createdAt: new Date(START).toISOString(), updatedAt: new Date(START).toISOString(),
  workflow: { revision: 7, stage: "PLAN_REVIEW", state: "WAITING" } as never,
}) as DeveloperTaskRecord;

const neutral = (developerId: string, name: string, method: "github" | "cloud"): TaskPersonCheck => ({
  subject: { developerId },
  identity: { developerId, name, method, issuer: method === "github" ? "https://github.com" : "https://cloud.example.test", subject: `subject-${name}` },
  eligible: true, channelMember: true,
});

function harness(options: { enabled: boolean }) {
  const db = new FakeDynamoDb();
  db.set(task() as unknown as Record<string, unknown>);
  const checks = new Map<string, TaskPersonCheck>([
    [A, neutral(A, CREATOR.name, "github")],
    [B, neutral(B, WEB.name, "cloud")],
    [C, { subject: { developerId: C, slackUserId: SC }, identity: { developerId: C, slackUserId: SC, name: "Casey Slack", method: "slack", issuer: "https://slack.com", subject: SC }, eligible: true, channelMember: true }],
  ]);
  const checkTaskPerson = vi.fn(async (_task: DeveloperTaskRecord, developerId: string) => {
    const checked = checks.get(developerId);
    if (checked === undefined) throw new Error("proof unavailable");
    return structuredClone(checked);
  });
  const deps: TaskPeopleDependencies = {
    documentClient: db, tableName: "state", now: () => START, taskPeopleConfiguration: { peopleChangesEnabled: options.enabled }, checkTaskPerson,
    createTaskPeopleDisplayAdmission: () => ({
      assertOpen() {}, admitIdentity() {}, noteNativeIdentity() {}, close() {},
      async proof() { throw new Error("no proof"); }, async directory() { throw new Error("no directory"); },
    } satisfies TaskPeopleDisplayAdmission),
    listTaskPeople: async () => [...checks.values()].map((value) => structuredClone(value)),
  };
  const seedPerson = (developerId: string, personId: string) => {
    const createdAt = new Date(START).toISOString();
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON#${personId}`, schemaVersion: 1, personId, ...checks.get(developerId)!.identity, createdAt });
    db.set({ pk: `DEVTASK#${TASK_ID}`, sk: `PERSON_SUBJECT#${developerId}`, schemaVersion: 1, personId, developerId, createdAt });
  };
  return { db, deps, checks, checkTaskPerson, seedPerson };
}

describe("task people with no Slack account", () => {
  it("seeds a GitHub creator as the task's owner with no Slack id in the stored entry or registry row, and the list reads back", async () => {
    const h = harness({ enabled: true });

    const view = await getTaskPeople(h.deps, CREATOR, TASK_ID);

    expect(view).toMatchObject({ canManage: true, people: [expect.objectContaining({ name: "Nia Creator", role: "owner", effectiveRole: "owner", you: true })] });
    const stored = h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE") as { people: Array<Record<string, unknown>> };
    expect(stored.people).toEqual([{ developerId: A, name: "Nia Creator", role: "owner" }]);
    expect(h.db.find((item) => String(item.sk).startsWith("PERSON#"))[0]).not.toHaveProperty("slackUserId");
    await expect(loadTaskPeople(h.deps, TASK_ID)).resolves.toMatchObject({ people: [{ developerId: A, role: "owner" }] });
    expect(JSON.stringify(view)).not.toContain(A);
  });

  it("lets the owner give another no-Slack member a role, and the member then holds exactly it", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, CREATOR, TASK_ID);
    h.seedPerson(B, PERSON_B);

    const view = await changeTaskPeople(h.deps, CREATOR, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000001", expectedPeopleRevision: 1, targetDeveloperId: B, role: "owner" });

    expect(view.people).toContainEqual(expect.objectContaining({ name: "Oliver Web", role: "owner", effectiveRole: "owner" }));
    expect((h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE") as { people: Array<Record<string, unknown>> }).people.find((person) => person.developerId === B)).toEqual({ developerId: B, name: "Oliver Web", role: "owner" });
    // No Slack person is told: there is no Slack account to tell, and the member is not outside any channel.
    expect(h.db.find((item) => item.entityType === "TASK_PEOPLE_NOTIFICATION")).toEqual([]);
    await expect(getTaskPeople(h.deps, WEB, TASK_ID)).resolves.toMatchObject({ canManage: true });
  });

  it("a member who was never added to the Slack-shared task does not become its commenter, though a Slack person in the channel would", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, CREATOR, TASK_ID);
    h.seedPerson(B, PERSON_B);
    h.seedPerson(C, PERSON_C);

    const view = await getTaskPeople(h.deps, CREATOR, TASK_ID);

    expect(view.people.map((person) => person.name)).toContain("Casey Slack");
    expect(view.people.find((person) => person.name === "Casey Slack")).toMatchObject({ role: "commenter", effectiveRole: "commenter" });
    expect(view.people.map((person) => person.name), "the channel default is for people in the channel").not.toContain("Oliver Web");
    await expect(getTaskPeople(h.deps, WEB, TASK_ID)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it("honours an entry the owner made: commenter or viewer is the role, a project viewer stays capped, denied is nothing", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, CREATOR, TASK_ID);
    h.seedPerson(B, PERSON_B);
    await changeTaskPeople(h.deps, CREATOR, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000002", expectedPeopleRevision: 1, targetDeveloperId: B, role: "commenter" });
    const asCommenter = await getTaskPeople(h.deps, WEB, TASK_ID);
    expect(asCommenter.canManage).toBe(false);
    expect(asCommenter.people.find((person) => person.you)).toMatchObject({ role: "commenter", effectiveRole: "commenter" });

    h.checks.set(B, { ...h.checks.get(B)!, projectViewer: true });
    expect((await getTaskPeople(h.deps, WEB, TASK_ID)).people.find((person) => person.you)).toMatchObject({ role: "commenter", effectiveRole: "viewer" });

    h.checks.set(B, neutral(B, WEB.name, "cloud"));
    await changeTaskPeople(h.deps, CREATOR, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000003", expectedPeopleRevision: 2, targetDeveloperId: B, role: "denied" });
    await expect(getTaskPeople(h.deps, WEB, TASK_ID)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });

  it("will not give a role to a member who is not eligible (not a member of the project), whatever the request says", async () => {
    const h = harness({ enabled: true });
    await getTaskPeople(h.deps, CREATOR, TASK_ID);
    h.seedPerson(B, PERSON_B);
    h.checks.set(B, { ...h.checks.get(B)!, eligible: false, channelMember: false });
    const before = structuredClone(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE"));

    await expect(changeTaskPeople(h.deps, CREATOR, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000004", expectedPeopleRevision: 1, targetDeveloperId: B, role: "commenter" })).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });

    expect(h.db.get(`DEVTASK#${TASK_ID}`, "PEOPLE")).toEqual(before);
  });

  it("with TaskPeopleChangesEnabled off nothing changes: no list is made, no role is given, nothing is written", async () => {
    const h = harness({ enabled: false });
    const before = structuredClone(h.db.items);

    await expect(getTaskPeople(h.deps, CREATOR, TASK_ID)).rejects.toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    await expect(changeTaskPeople(h.deps, CREATOR, TASK_ID, { requestId: "40000000-0000-4000-8000-000000000005", expectedPeopleRevision: 1, targetDeveloperId: B, role: "viewer" })).rejects.toBeDefined();

    expect(h.db.items).toEqual(before);
  });

  it("refuses a stored entry that has a Slack id which is not one (a row is a Slack person's or has no Slack key at all)", async () => {
    const h = harness({ enabled: true });
    h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: A, slackUserId: "not-a-slack-id", name: "Nia Creator", role: "owner" }] });
    await expect(loadTaskPeople(h.deps, TASK_ID)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
    h.db.set({ pk: `DEVTASK#${TASK_ID}`, sk: "PEOPLE", schemaVersion: 1, revision: 1, orphaned: false, people: [{ developerId: A, slackUserId: undefined, name: "Nia Creator", role: "owner" }] });
    await expect(loadTaskPeople(h.deps, TASK_ID)).rejects.toMatchObject({ code: "TASK_ACCESS_DENIED" });
  });
});
