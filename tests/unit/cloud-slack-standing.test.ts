// Convergence lane A8 (H1): the person rule of the Slack channel sink. The options it passes to today's `slackRequesterStanding` are pinned, it answers the survivor, it serves nobody unless the explicit-member switch is
// closed (`sm` = 1), and, run against the real rule on a real (fake-table) install, it serves an explicit member, a merged person as their survivor, and refuses a person with no membership, a removed one and a banned one.
import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OrgId } from "@rovara-code/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { slackStandingOf } from "../../packages/broker/src/plugins/channel/slack-cloud/index.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";

const ORG = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const SURVIVOR = "s".repeat(64);
const OTHER = "o".repeat(64);
const DEPENDENCIES = { marker: "dependencies" } as never;

describe("the options and the survivor (pinned against a spy)", () => {
  const spy = (ids: string[]) => {
    const calls: unknown[][] = [];
    const standing = async (...args: unknown[]) => { calls.push(args); return { ids }; };
    return { calls, standing: standing as never };
  };

  it("calls today's rule with the dependencies, the Slack user and the company, and NO options: not allowUnlinked, not allowReadOnly", async () => {
    const { calls, standing } = spy(["a".repeat(64)]);
    await slackStandingOf(DEPENDENCIES, { standing, rule: () => "require" })(ORG, "U0PERSON1");
    expect(calls).toHaveLength(1);
    expect(calls[0]!.slice(0, 3)).toEqual([DEPENDENCIES, "U0PERSON1", ORG]);
    // No fourth argument at all; and were one passed, it would have to name neither option.
    expect(calls[0]!).toHaveLength(3);
    const options = (calls[0]![3] ?? {}) as Record<string, unknown>;
    expect(options).not.toHaveProperty("allowUnlinked");
    expect(options).not.toHaveProperty("allowReadOnly");
  });

  it("answers the survivor: the last id of the walk, the person a merged account is", async () => {
    const { standing } = spy(["m".repeat(64), OTHER, SURVIVOR]);
    expect(await slackStandingOf(DEPENDENCIES, { standing, rule: () => "require" })(ORG, "U0PERSON1")).toBe(SURVIVOR);
  });

  it("refuses an answer with no id at all (fail closed)", async () => {
    const { standing } = spy([]);
    await expect(slackStandingOf(DEPENDENCIES, { standing, rule: () => "require" })(ORG, "U0PERSON1")).rejects.toMatchObject({ code: "SLACK_ACCOUNT_NOT_LINKED" });
  });

  it("lets the rule's own refusal through, with its own code", async () => {
    const refusal = Object.assign(new Error("gone"), { code: "REMOVED_FROM_ORG" });
    const standing = (async () => { throw refusal; }) as never;
    await expect(slackStandingOf(DEPENDENCIES, { standing, rule: () => "require" })(ORG, "U0PERSON1")).rejects.toBe(refusal);
  });

  it("serves nobody unless the switch is the closed value, and does not even ask the rule in the other modes", async () => {
    for (const rule of ["warn", "off"] as const) {
      const { calls, standing } = spy(["a".repeat(64)]);
      await expect(slackStandingOf(DEPENDENCIES, { standing, rule: () => rule })(ORG, "U0PERSON1"), rule).rejects.toMatchObject({ code: "SLACK_ACCOUNT_NOT_LINKED" });
      expect(calls, rule).toEqual([]);
    }
  });
});

describe("against the real rule", () => {
  const SWITCH = "SLACK_EXPLICIT_MEMBERS";
  const PRIYA_SLACK = "U0PRIYA001";
  const PRIYA = developerIdForSlackUser(PRIYA_SLACK);
  const orgs = (db: FakeDynamoDb) => new OrgStore({ documentClient: db, tableName: "state", now: () => Date.now() });
  let saved: string | undefined;
  beforeEach(() => { saved = process.env[SWITCH]; delete process.env[SWITCH]; vi.spyOn(console, "log").mockImplementation(() => undefined); });
  afterEach(() => { if (saved === undefined) delete process.env[SWITCH]; else process.env[SWITCH] = saved; vi.restoreAllMocks(); });

  async function cloud() {
    const live: { db?: FakeDynamoDb } = {};
    const orgResolver: OrgResolver = async ({ developerId }) => developerId === undefined || live.db === undefined ? TEST_ORG : (await orgs(live.db).orgForDeveloper(developerId))?.orgId;
    const h = await createDeveloperTaskBroker({ orgResolver });
    live.db = h.db;
    await orgs(h.db).bindSlackTeam({ orgId: TEST_ORG, teamId: "T0AAAAAAA" });
    seedMembership(h.db, OMAR.developerId, { orgId: TEST_ORG, role: "owner" });
    return { h, standingOf: slackStandingOf(h.brokerInput as never) };
  }
  const remove = (h: Awaited<ReturnType<typeof cloud>>["h"], developerId: string, ban: boolean) =>
    orgs(h.db).removeMember({ orgId: TEST_ORG, developerId, emails: [], ban, by: { kind: "member", id: OMAR.developerId }, callerRole: "owner", requestId: randomUUID() });

  it("serves an explicit member as their own id, and a person merged into a member as that member", async () => {
    const { h, standingOf } = await cloud();
    seedMembership(h.db, PRIYA, { orgId: TEST_ORG, role: "member" });
    expect(await standingOf(TEST_ORG, PRIYA_SLACK)).toBe(PRIYA);
    const merged = "U0MERGED01";
    h.db.set({ pk: `DEVELOPER#${developerIdForSlackUser(merged)}`, sk: "META", developerId: developerIdForSlackUser(merged), mergedInto: PRIYA });
    expect(await standingOf(TEST_ORG, merged)).toBe(PRIYA);
  });

  it("refuses a person with no membership (never the implicit member of the workspace's company)", async () => {
    const { standingOf } = await cloud();
    await expect(standingOf(TEST_ORG, "U0NEVER001")).rejects.toMatchObject({ code: "SLACK_ACCOUNT_NOT_LINKED" });
  });

  it("refuses a removed person and a banned person (today's ingress callers do: with no `allowUnlinked`, one who no longer has a company is stopped as not linked, before the removal check)", async () => {
    const { h, standingOf } = await cloud();
    seedMembership(h.db, PRIYA, { orgId: TEST_ORG, role: "member" });
    await remove(h, PRIYA, false);
    await expect(standingOf(TEST_ORG, PRIYA_SLACK)).rejects.toMatchObject({ code: expect.stringMatching(/^(SLACK_ACCOUNT_NOT_LINKED|REMOVED_FROM_ORG)$/u) as string });
    const banned = "U0BANNED01";
    seedMembership(h.db, developerIdForSlackUser(banned), { orgId: TEST_ORG, role: "member" });
    await remove(h, developerIdForSlackUser(banned), true);
    await expect(standingOf(TEST_ORG, banned)).rejects.toMatchObject({ code: expect.stringMatching(/^(SLACK_ACCOUNT_NOT_LINKED|REMOVED_FROM_ORG)$/u) as string });
  });

  it("refuses an Auditor (a chat message starts work, so the read-only allowance is not given)", async () => {
    const { h, standingOf } = await cloud();
    seedMembership(h.db, PRIYA, { orgId: TEST_ORG, role: "auditor" as never });
    await expect(standingOf(TEST_ORG, PRIYA_SLACK)).rejects.toBeDefined();
  });

  it("serves nobody with the switch on warn or 0, even an explicit member (the channel point never serves an implicit member in any mode)", async () => {
    const { h, standingOf } = await cloud();
    seedMembership(h.db, PRIYA, { orgId: TEST_ORG, role: "member" });
    for (const value of ["warn", "0"]) {
      process.env[SWITCH] = value;
      await expect(standingOf(TEST_ORG, PRIYA_SLACK), value).rejects.toMatchObject({ code: "SLACK_ACCOUNT_NOT_LINKED" });
    }
  });
});
