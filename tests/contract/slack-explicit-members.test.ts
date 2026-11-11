// 0.5.14 (U2, switch `sm`, owner decision Q5): on a cloud install a Slack person with no explicit, current company membership is no longer the implicit member of the company their Slack
// workspace is bound to. Covers each closed fallback, removed and banned people, a merged person, an explicit member, the three switch values and the plain Slack reply.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SLACK_NOT_A_MEMBER_NOTICE, parseSlackThreadSubject, type SlackRequestMessage } from "../../packages/contracts/src/index.js";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { slackRequesterRole } from "../../packages/broker/src/aws/broker/workspace-preparation.js";
import { createNotifierHandler } from "../../packages/broker/src/aws/developer-task-notifier.js";
import type { Notice, StreamRecord } from "../../packages/broker/src/developer/notifications.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { SLACK_MEMBER_WARNING_TEXT, slackMemberRule, slackMemberWarningKey } from "../../packages/broker/src/org/slack-explicit-members.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { processSlackRequest, type ProcessorDependencies } from "../../packages/slack-service/src/processor.js";
import { createSignedServiceFetch } from "../../packages/slack-service/src/signing-fetch.js";
import { createThreadApi } from "../../packages/slack-service/src/thread-api.js";
import { brokerFetch } from "../support/broker-fetch.js";
import { OMAR, createDeveloperTaskBroker, recordStream, seedMembership } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

const SWITCH = "SLACK_EXPLICIT_MEMBERS";
const PRIYA_SLACK = "U0PRIYA001";
const PRIYA = developerIdForSlackUser(PRIYA_SLACK);
const NEVER = "U0NEVER001";
const thread = (ts: string) => `${SLACK_TEAM}/${SLACK_CHANNEL}/${ts}`;
const orgs = (db: FakeDynamoDb) => new OrgStore({ documentClient: db, tableName: "state", now: () => Date.now() });
const workspaces = (db: FakeDynamoDb) => db.find((item) => item.entityType === "WORKSPACE").length;

let saved: string | undefined;
beforeEach(() => { saved = process.env[SWITCH]; delete process.env[SWITCH]; vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => { if (saved === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = saved; vi.restoreAllMocks(); });

/** A cloud install: the org resolver is membership-based (a developer with no membership has no org), as `orgResolverFromEnvironment` makes it. */
async function cloud() {
  const live: { db?: FakeDynamoDb } = {};
  const orgResolver: OrgResolver = async ({ developerId }) => developerId === undefined || live.db === undefined ? TEST_ORG : (await orgs(live.db).orgForDeveloper(developerId))?.orgId;
  const h = await createDeveloperTaskBroker({ orgResolver });
  live.db = h.db;
  await orgs(h.db).bindSlackTeam({ orgId: TEST_ORG, teamId: SLACK_TEAM });
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  return h;
}
const remove = (h: Awaited<ReturnType<typeof cloud>>, developerId: string, ban: boolean) =>
  orgs(h.db).removeMember({ orgId: TEST_ORG, developerId, emails: [], ban, by: { kind: "member", id: OMAR.developerId }, callerRole: "owner", requestId: randomUUID() });

describe("the switch", () => {
  it("is on unless it is exactly 0 or warn; an absent or unknown value fails closed", () => {
    expect(slackMemberRule({})).toBe("require");
    expect(slackMemberRule({ [SWITCH]: "1" })).toBe("require");
    expect(slackMemberRule({ [SWITCH]: "" })).toBe("require");
    expect(slackMemberRule({ [SWITCH]: "banana" })).toBe("require");
    expect(slackMemberRule({ [SWITCH]: "warn" })).toBe("warn");
    expect(slackMemberRule({ [SWITCH]: "0" })).toBe("off");
  });
});

describe("with the switch on (the default), on a cloud install", () => {
  it("refuses a Slack person with no membership: no workspace is made, and the refusal says to ask an admin or link", async () => {
    const h = await cloud();
    const before = workspaces(h.db);
    const refused = await ensureWorkspace(h.handler, thread("1695500000.000401"), NEVER);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "SLACK_ACCOUNT_NOT_LINKED" } });
    expect(JSON.stringify(refused.body)).toMatch(/ask a Rovara admin to add you/);
    expect(workspaces(h.db)).toBe(before);
  });

  it("still serves an explicit member", async () => {
    const h = await cloud();
    seedMembership(h.db, PRIYA, { orgId: TEST_ORG, role: "member" });
    expect((await ensureWorkspace(h.handler, thread("1695500000.000402"), PRIYA_SLACK)).status).toBe(200);
  });

  it("refuses a removed person and a banned person, and serves one who was removed and invited again", async () => {
    const h = await cloud();
    seedMembership(h.db, PRIYA, { orgId: TEST_ORG, role: "member" });
    await remove(h, PRIYA, false);
    expect((await ensureWorkspace(h.handler, thread("1695500000.000403"), PRIYA_SLACK)).body).toMatchObject({ error: { code: "REMOVED_FROM_ORG" } });
    await orgs(h.db).addMember({ orgId: TEST_ORG, developerId: PRIYA, role: "member" });
    expect((await ensureWorkspace(h.handler, thread("1695500000.000404"), PRIYA_SLACK)).status).toBe(200);

    const banned = "U0BANNED01";
    seedMembership(h.db, developerIdForSlackUser(banned), { orgId: TEST_ORG, role: "member" });
    await remove(h, developerIdForSlackUser(banned), true);
    const refused = await ensureWorkspace(h.handler, thread("1695500000.000405"), banned);
    expect(refused.status).toBe(403);
    expect(refused.body).toMatchObject({ error: { code: "REMOVED_FROM_ORG" } });
  });

  it("follows mergedInto: a Slack identity merged into a member is that member; merged into a non-member it is refused", async () => {
    const h = await cloud();
    const survivor = "s".repeat(64);
    seedMembership(h.db, survivor, { orgId: TEST_ORG, role: "member" });
    h.db.set({ pk: `DEVELOPER#${PRIYA}`, sk: "META", developerId: PRIYA, mergedInto: survivor });
    expect((await ensureWorkspace(h.handler, thread("1695500000.000406"), PRIYA_SLACK)).status).toBe(200);

    const other = "U0OTHER001";
    h.db.set({ pk: `DEVELOPER#${developerIdForSlackUser(other)}`, sk: "META", developerId: developerIdForSlackUser(other), mergedInto: "n".repeat(64) });
    const refused = await ensureWorkspace(h.handler, thread("1695500000.000407"), other);
    expect(refused.status).toBe(403);
    expect(JSON.stringify(refused.body)).toMatch(/SLACK_ACCOUNT_NOT_LINKED|FORBIDDEN/);
  });

  it("makes up no role: a request that is not a Slack person's has none", async () => {
    await expect(slackRequesterRole({} as never, { issuer: "x", subject: "x", ownerKey: "x", orgId: TEST_ORG, isAdministrator: false, claims: {} })).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("leaves a single-org install (no org resolver, no membership to ask for) as it was", async () => {
    const h = await createDeveloperTaskBroker();
    expect((await ensureWorkspace(h.handler, thread("1695500000.000408"), NEVER)).status).toBe(200);
  });
});

describe("with the switch off (the rollback), today's behaviour", () => {
  it("serves a Slack person with no membership as before, and still refuses a removed one", async () => {
    process.env[SWITCH] = "0";
    const h = await cloud();
    expect((await ensureWorkspace(h.handler, thread("1695500000.000409"), NEVER)).status).toBe(200);
    seedMembership(h.db, PRIYA, { orgId: TEST_ORG, role: "member" });
    await remove(h, PRIYA, false);
    expect((await ensureWorkspace(h.handler, thread("1695500000.000410"), PRIYA_SLACK)).body).toMatchObject({ error: { code: "REMOVED_FROM_ORG" } });
    expect(h.db.find((item) => item.entityType === "SLACK_MEMBER_WARNING")).toHaveLength(0);
  });
});

describe("with the switch on warn", () => {
  it("serves a person with no membership as before, queues one direct message once, and tells a member nothing", async () => {
    process.env[SWITCH] = "warn";
    const h = await cloud();
    seedMembership(h.db, PRIYA, { orgId: TEST_ORG, role: "member" });
    expect((await ensureWorkspace(h.handler, thread("1695500000.000411"), PRIYA_SLACK)).status).toBe(200);
    expect(h.db.find((item) => item.entityType === "SLACK_MEMBER_WARNING")).toHaveLength(0);

    expect((await ensureWorkspace(h.handler, thread("1695500000.000412"), NEVER)).status).toBe(200);
    expect((await ensureWorkspace(h.handler, thread("1695500000.000413"), NEVER)).status).toBe(200);
    expect(h.db.get(slackMemberWarningKey(TEST_ORG, NEVER).pk, NEVER)).toMatchObject({ entityType: "SLACK_MEMBER_WARNING" });
    const rows = h.db.find((item) => item.entityType === "TASK_ATTENTION_DM");
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ pk: "NOTIFY_DM", status: "PENDING", slackUserId: NEVER, text: SLACK_MEMBER_WARNING_TEXT });
  });

  it("delivers the notice to the person through the notifier, exactly once", async () => {
    process.env[SWITCH] = "warn";
    const h = await cloud();
    const stream = recordStream(h.db);
    const posts: Array<{ channel: string; text: string }> = [];
    const queue: Notice[] = [];
    const handle = createNotifierHandler({
      documentClient: h.db, tableName: "state", enqueue: async (notices) => { queue.push(...notices); }, retryLater: async () => undefined,
      post: async (input) => { posts.push({ channel: input.channel, text: input.text }); return { ts: "1695500000.000100" }; },
      now: Date.now, log: () => undefined, deliveryFailed: () => undefined,
    });
    const pump = async () => {
      await handle({ Records: stream.take().map((record: StreamRecord) => ({ ...record, eventSource: "aws:dynamodb" })) });
      const batch = queue.splice(0, queue.length);
      await handle({ Records: batch.map((notice, index) => ({ eventSource: "aws:sqs", messageId: `m${index}`, receiptHandle: `r${index}`, body: JSON.stringify(notice), attributes: { ApproximateReceiveCount: "1" } })) });
    };
    await ensureWorkspace(h.handler, thread("1695500000.000414"), NEVER);
    await ensureWorkspace(h.handler, thread("1695500000.000415"), NEVER);
    await pump();
    await pump();
    expect(posts).toEqual([{ channel: NEVER, text: SLACK_MEMBER_WARNING_TEXT }]);
  });
});

describe("the Slack service's reply", () => {
  it("says plainly, once and without a retry, that the account is not matched to a member", async () => {
    const h = await cloud();
    const subject = thread("1695500000.000416");
    const posts: string[] = [];
    const ran: string[] = [];
    const dependencies: ProcessorDependencies = {
      api: () => createThreadApi({
        controlPlaneUrl: "https://agentx.example.test", pollIntervalMilliseconds: 1,
        signedFetch: createSignedServiceFetch({ region: "us-east-1", credentials: { accessKeyId: "test-key", secretAccessKey: "test-secret" }, thread: parseSlackThreadSubject(subject), userId: NEVER, baseFetch: brokerFetch(h.handler) }),
      }),
      threads: { load: async () => ({}), saveConversation: async () => undefined, saveSettingsRevision: async () => undefined, close: async () => undefined, finish: async () => undefined, claimSharedNotice: async () => true },
      runTurn: async (input) => { ran.push(input.message.eventId); return "ran"; },
      post: async (_thread, text) => { posts.push(text); },
    };
    const message: SlackRequestMessage = { version: 1, eventId: "Ev0000000001", thread: parseSlackThreadSubject(subject), userId: NEVER, text: "hello", receivedAt: new Date().toISOString() };
    // Not the final attempt: a retry would not help, so it must not throw for redelivery.
    await processSlackRequest(message, dependencies, { finalAttempt: false, queuedBehind: 0 });
    expect(posts).toEqual([SLACK_NOT_A_MEMBER_NOTICE]);
    expect(ran).toEqual([]);
    expect(SLACK_NOT_A_MEMBER_NOTICE).toMatch(/ask a Rovara admin to add you/i);
    expect(SLACK_NOT_A_MEMBER_NOTICE).toMatch(/Link your Slack account/);
  });
});
