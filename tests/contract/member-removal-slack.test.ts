// Member removal (v1.1), task 3, §5 rows 9 and 10: a removed person is refused at the one place every Slack service route starts (`slackServiceIdentity`), and cannot act from
// another task's thread through a stored person proof. A Slack person who never joined is not a removed person and is not refused.
import { randomUUID } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { type TaskPersonProofRequest, type TaskPersonProofResponse } from "@rovara-code/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { resolveTaskPickerPerson, checkTaskPersonIdentity, type TaskPersonIdentityDependencies } from "../../packages/broker/src/developer/task-person-identity.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { createDeveloperTaskBroker, OMAR, seedMembership } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { T0, TEAM } from "../support/developer-fakes.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, call, ensureWorkspace } from "../support/slack-broker.js";

const PRIYA_SLACK = "U0PRIYA001";
const PRIYA = developerIdForSlackUser(PRIYA_SLACK);
const thread = (ts: string) => `${SLACK_TEAM}/${SLACK_CHANNEL}/${ts}`;
const removalOf = (db: FakeDynamoDb) => new OrgStore({ documentClient: db, tableName: "state", now: () => Date.now() });

describe("Slack service routes", () => {
  it("refuse a person who was removed from the company, and keep serving one who was never in it", async () => {
    const h = await createDeveloperTaskBroker();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    seedMembership(h.db, PRIYA, { orgId: TEST_ORG, role: "member" });
    expect((await ensureWorkspace(h.handler, thread("1695500000.000301"), PRIYA_SLACK)).status).toBe(200);

    await removalOf(h.db).removeMember({ orgId: TEST_ORG, developerId: PRIYA, emails: [], ban: false, by: { kind: "member", id: OMAR.developerId }, callerRole: "owner", requestId: randomUUID() });
    const refused = await ensureWorkspace(h.handler, thread("1695500000.000302"), PRIYA_SLACK);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "REMOVED_FROM_ORG" } });

    // Someone who has not signed in yet has no member record and no removal tombstone: not removed, not refused.
    expect((await ensureWorkspace(h.handler, thread("1695500000.000303"), "U0NEVER001")).status).toBe(200);
  });

  it("let a person who was removed and invited again in", async () => {
    const h = await createDeveloperTaskBroker();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    seedMembership(h.db, PRIYA, { orgId: TEST_ORG, role: "member" });
    const orgs = removalOf(h.db);
    await orgs.removeMember({ orgId: TEST_ORG, developerId: PRIYA, emails: [], ban: false, by: { kind: "member", id: OMAR.developerId }, callerRole: "owner", requestId: randomUUID() });
    await orgs.addMember({ orgId: TEST_ORG, developerId: PRIYA, role: "member" });
    expect(h.db.get(orgMemberKey(TEST_ORG, PRIYA))).toBeDefined();
    expect((await ensureWorkspace(h.handler, thread("1695500000.000304"), PRIYA_SLACK)).status).toBe(200);
  });

  it("refuse before anything is read for the thread when the person was removed (no workspace is made)", async () => {
    const h = await createDeveloperTaskBroker();
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    seedMembership(h.db, PRIYA, { orgId: TEST_ORG, role: "member" });
    await removalOf(h.db).removeMember({ orgId: TEST_ORG, developerId: PRIYA, emails: [], ban: false, by: { kind: "member", id: OMAR.developerId }, callerRole: "owner", requestId: randomUUID() });
    const before = h.db.find((item) => item.entityType === "WORKSPACE").length;
    await call(h.handler, { method: "POST", path: "/v1/service/threads/workspace", service: { principal: "arn:aws:sts::123456789012:assumed-role/orchestrator/session", thread: thread("1695500000.000305"), slackUser: PRIYA_SLACK }, body: { requestId: randomUUID() } });
    expect(h.db.find((item) => item.entityType === "WORKSPACE")).toHaveLength(before);
  });
});

describe("a task's person proof", () => {
  const TASK_ID = "11111111-1111-4111-8111-111111111111";
  const task = {
    pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, orgId: TEST_ORG, developerId: "e".repeat(64), provider: "slack", developerName: "Creator",
    slackUserId: "U0CREATOR1", project: "payments-api", share: { teamId: TEAM, channelId: "C0PAY0001" },
  } as unknown as DeveloperTaskRecord;
  const world = () => {
    const db = new FakeDynamoDb();
    db.set(task as unknown as Record<string, unknown>);
    const deps: TaskPersonIdentityDependencies = {
      documentClient: db, tableName: "state", slackTeamId: TEAM, now: () => T0, uuid: () => "22222222-2222-4222-8222-222222222222",
      taskPersonProof: vi.fn(async (request: TaskPersonProofRequest): Promise<TaskPersonProofResponse> => ({ ok: true, user: { id: request.slackUserId, teamId: TEAM, name: "Priya" }, memberOf: ["C0PAY0001"] })),
      developerRecord: vi.fn(async () => undefined), projectChannelIds: vi.fn(async () => ["C0PAY0001"]),
      targetProjectAccess: vi.fn(async () => undefined),
    };
    return { db, deps };
  };

  it("is refused for a person who was removed, at qualification and at each use of a stored proof, and not for one who is a member", async () => {
    const w = world();
    seedMembership(w.db, PRIYA, { orgId: TEST_ORG, role: "member" });
    seedMembership(w.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    const identity = await resolveTaskPickerPerson(w.deps, task, PRIYA_SLACK);
    expect(identity.developerId).toBe(PRIYA);
    expect(await checkTaskPersonIdentity(w.deps, task, PRIYA)).toMatchObject({ eligible: true });

    await removalOf(w.db).removeMember({ orgId: TEST_ORG, developerId: PRIYA, emails: [], ban: false, by: { kind: "member", id: OMAR.developerId }, callerRole: "owner", requestId: randomUUID() });
    expect(await checkTaskPersonIdentity(w.deps, task, PRIYA)).toMatchObject({ eligible: false });
    await expect(resolveTaskPickerPerson(w.deps, task, PRIYA_SLACK)).rejects.toBeDefined();
  });

  it("refuses a Slack person who never joined (no member record): a Slack account is not a membership (the one explicit-member rule), and a member record qualifies them", async () => {
    const w = world();
    await expect(resolveTaskPickerPerson(w.deps, task, "U0NEVER001")).rejects.toBeDefined();
    seedMembership(w.db, developerIdForSlackUser("U0NEVER001"), { orgId: TEST_ORG, role: "member" });
    expect(await resolveTaskPickerPerson(w.deps, task, "U0NEVER001")).toMatchObject({ slackUserId: "U0NEVER001" });
  });
});
