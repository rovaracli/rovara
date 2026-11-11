import { describe, expect, it } from "vitest";
import { slackTeamOrgKey } from "@agentx/cloud-contracts";
import { type OrgId } from "@rovara-code/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { slackCallerFor } from "../../packages/broker/src/aws/broker/dependency-wiring.js";
import { membershipOrgResolver } from "../../packages/broker/src/org/resolve.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

// QA6-15 (staging 0.5.6): the owner's Slack mention was refused with "this channel isn't connected" because the Slack account (not the channel) belonged to no member of the company.
// A cloud install resolves the org by membership, so a Slack id with no member record of its own is nobody's.

const TEAM = "T0BSHLLUGBD";
const OWNER_SLACK = "U0BSPTAFNG2";
const MEMBER_SLACK = "U0BSRRRADC1";
const OWNER_ACCOUNT = "e".repeat(64);

function broker() {
  const db = new FakeDynamoDb();
  const orgs = new OrgStore({ documentClient: db, tableName: "state", now: () => Date.parse("2026-11-05T19:00:00.000Z") });
  db.set({ ...slackTeamOrgKey(TEAM), orgId: TEST_ORG });
  // The owner signed in with email, not Slack: the member record is the account's, and the Slack id is only written on the account's record.
  seedMembership(db, OWNER_ACCOUNT, { orgId: TEST_ORG, role: "owner" });
  db.set({ pk: `DEVELOPER#${OWNER_ACCOUNT}`, sk: "META", developerId: OWNER_ACCOUNT, provider: "cloud", slackUserId: OWNER_SLACK });
  // A person who joined with their Slack sign-in has a member record under their Slack-derived id.
  seedMembership(db, developerIdForSlackUser(MEMBER_SLACK), { orgId: TEST_ORG, role: "member" });
  const dependencies = {
    documentClient: db, tableName: "state", environmentName: "staging", developer: { slackTeamId: TEAM, signInTableName: "state" },
    orgResolver: membershipOrgResolver(orgs),
  } as never;
  return { db, dependencies };
}

const refusal = (run: () => Promise<unknown>) => run().then(() => undefined, (error: { code?: string; message?: string }) => ({ code: error.code, message: error.message }));

describe("the Slack requester on a install that resolves the company by membership", () => {
  it("serves a person who joined with their Slack sign-in (control)", async () => {
    const { dependencies } = broker();
    const caller = await slackCallerFor(dependencies, MEMBER_SLACK, TEAM);
    expect(caller).toMatchObject({ developerId: developerIdForSlackUser(MEMBER_SLACK), orgRole: "member" });
  });

  it("says SLACK_ACCOUNT_NOT_LINKED, not a channel refusal, for a Slack account that belongs to no member", async () => {
    const { dependencies } = broker();
    const refused = await refusal(() => slackCallerFor(dependencies, OWNER_SLACK, TEAM));
    expect(refused?.code).toBe("SLACK_ACCOUNT_NOT_LINKED");
    expect(refused?.message).not.toContain(OWNER_SLACK);
    expect(refused?.message).not.toContain(OWNER_ACCOUNT);
  });

  it("keeps FORBIDDEN for a Slack account that belongs to another company", async () => {
    const { db, dependencies } = broker();
    const other = "org_zzzzzzzzzzzzzzzzzzzz" as OrgId;
    seedMembership(db, developerIdForSlackUser("U0GUEST0001"), { orgId: other, role: "member" });
    const refused = await refusal(() => slackCallerFor(dependencies, "U0GUEST0001", TEAM));
    expect(refused?.code).toBe("FORBIDDEN");
  });
});
