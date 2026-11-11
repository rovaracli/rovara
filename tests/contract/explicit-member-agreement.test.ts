// One rule for "is this person an explicit, current member who may write": the Slack routes (`slackRequesterStanding`, switch `sm`) and the task person checks (org/explicit-member.ts) call
// the same function, and this test shows they agree on each kind of person, for the broker's way of reading the sign-in table and for the dispatcher's.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { GetCommand } from "@aws-sdk/lib-dynamodb";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { explicitMemberRole, signInReaderFromRecords } from "../../packages/broker/src/org/explicit-member.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { SLACK_CHANNEL, SLACK_TEAM, ensureWorkspace } from "../support/slack-broker.js";

const SWITCH = "SLACK_EXPLICIT_MEMBERS";
const orgs = (db: FakeDynamoDb) => new OrgStore({ documentClient: db, tableName: "state", now: () => Date.now() });
let saved: string | undefined;
beforeEach(() => { saved = process.env[SWITCH]; delete process.env[SWITCH]; vi.spyOn(console, "log").mockImplementation(() => undefined); });
afterEach(() => { if (saved === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = saved; vi.restoreAllMocks(); });

async function cloud() {
  const live: { db?: FakeDynamoDb } = {};
  const orgResolver: OrgResolver = async ({ developerId }) => developerId === undefined || live.db === undefined ? TEST_ORG : (await orgs(live.db).orgForDeveloper(developerId))?.orgId;
  const h = await createDeveloperTaskBroker({ orgResolver });
  live.db = h.db;
  await orgs(h.db).bindSlackTeam({ orgId: TEST_ORG, teamId: SLACK_TEAM });
  seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
  return h;
}

type World = Awaited<ReturnType<typeof cloud>>;
// `dispatcherMember`: what the dispatcher's reader decides when it differs from everyone else's. It may read a developer's own sign-in row and nothing else, so an identity link (a row of its own) is invisible to it.
const SCENARIOS: Array<{ name: string; slackUser: string; member: boolean; dispatcherMember?: boolean; arrange: (h: World, native: string) => void }> = [
  { name: "a Slack person who never joined", slackUser: "U0AGREE001", member: false, arrange: () => undefined },
  { name: "an explicit member", slackUser: "U0AGREE002", member: true, arrange: (h, native) => seedMembership(h.db, native, { orgId: TEST_ORG, role: "member" }) },
  { name: "an owner", slackUser: "U0AGREE003", member: true, arrange: (h, native) => seedMembership(h.db, native, { orgId: TEST_ORG, role: "owner" }) },
  { name: "a Slack identity merged into a member", slackUser: "U0AGREE004", member: true, arrange: (h, native) => {
    const survivor = "7".repeat(64);
    seedMembership(h.db, survivor, { orgId: TEST_ORG, role: "member" });
    h.db.set({ pk: `DEVELOPER#${native}`, sk: "META", developerId: native, provider: "slack", mergedInto: survivor, revoked: false });
  } },
  { name: "a stale member record under an id that was merged into someone with none", slackUser: "U0AGREE005", member: false, arrange: (h, native) => {
    seedMembership(h.db, native, { orgId: TEST_ORG, role: "member" });
    h.db.set({ pk: `DEVELOPER#${native}`, sk: "META", developerId: native, provider: "slack", mergedInto: "8".repeat(64), revoked: false });
  } },
  { name: "a company auditor", slackUser: "U0AGREE006", member: false, arrange: (h, native) => seedMembership(h.db, native, { orgId: TEST_ORG, role: "auditor" }) },
  { name: "merges that loop", slackUser: "U0AGREE007", member: false, arrange: (h, native) => {
    const other = "6".repeat(64);
    seedMembership(h.db, native, { orgId: TEST_ORG, role: "member" });
    h.db.set({ pk: `DEVELOPER#${native}`, sk: "META", developerId: native, provider: "slack", mergedInto: other, revoked: false });
    h.db.set({ pk: `DEVELOPER#${other}`, sk: "META", developerId: other, provider: "oidc", mergedInto: native, revoked: false });
  } },
  { name: "an identity linked to a member with no merge (broker and Slack routes: a member; dispatcher: not a member, because it cannot read link rows, so it fails closed)", slackUser: "U0AGREE008", member: true, dispatcherMember: false, arrange: (h, native) => {
    const survivor = "5".repeat(64);
    seedMembership(h.db, survivor, { orgId: TEST_ORG, role: "member" });
    // The identity link Sign in with Slack writes: the Slack identity belongs to the developer it names, and nothing was merged.
    h.db.set({ pk: `SIGNIN_IDENTITY#${native}`, sk: "META", developerId: survivor });
  } },
];

describe("the Slack routes and the task person checks use one explicit-member rule", () => {
  it.each(SCENARIOS)("agree about $name", async ({ slackUser, member, dispatcherMember, arrange }) => {
    const h = await cloud();
    const native = developerIdForSlackUser(slackUser);
    arrange(h, native);
    // The Slack routes.
    const slack = await ensureWorkspace(h.handler, `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000${slackUser.slice(-3)}`, slackUser);
    expect(slack.status === 200, `Slack routes serve them: ${slack.status}`).toBe(member);
    // The task person checks: the broker's reads of the sign-in table (links included), and the dispatcher's (a developer's own row only).
    const brokerReader = async (key: { pk: string; sk: string }) => (await h.db.send(new GetCommand({ TableName: "signin", Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
    const dispatcherReader = signInReaderFromRecords(async (id) => h.db.get(`DEVELOPER#${id}`, "META"));
    for (const [label, readSignIn] of [["broker", brokerReader], ["dispatcher", dispatcherReader]] as const) {
      const role = await explicitMemberRole({ documentClient: h.db, tableName: "state", readSignIn }, TEST_ORG, native).catch((error: { code?: string }) => error.code);
      const expected = label === "dispatcher" ? dispatcherMember ?? member : member;
      expect(typeof role === "string" && role !== "FORBIDDEN", `${label} reader: a member (${String(role)})`).toBe(expected);
    }
  });
});
