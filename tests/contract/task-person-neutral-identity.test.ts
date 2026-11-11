// Owner decision 86 (neutral identity A-13): a task person is any Rovara member, whether they signed in with the web, GitHub, an identity provider or Slack, and not only a Slack
// person. A member with no Slack account is qualified on their membership and project access alone, never on a Slack proof, and the project's Slack channels give them nothing.
import { describe, expect, it, vi } from "vitest";
import { orgMemberKey, orgRemovedKey, type TaskPersonProofRequest, type TaskPersonProofResponse } from "@agentx/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import {
  checkTaskPersonIdentity,
  registerTaskMembers,
  resolveTaskPersonId,
  type ProjectAccessSubject,
  type TaskPersonIdentityDependencies,
} from "../../packages/broker/src/developer/task-person-identity.js";
import { oidcTaskPersonIdentityCheck } from "../../packages/broker/src/aws/broker/model-access.js";
import type { DeveloperTaskRecord } from "../../packages/broker/src/developer/task-records.js";
import type { DeveloperRecord } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { T0, TEAM } from "../support/developer-fakes.js";
import { TEST_ORG } from "../support/orgs.js";

const TASK_ID = "11111111-1111-4111-8111-111111111111";
const PERSON_1 = "22222222-2222-4222-8222-222222222222";
const PERSON_2 = "33333333-3333-4333-8333-333333333333";
const GITHUB = "https://github.com";
const NIA = ownerKeyForSubject(GITHUB, "nia-12345");
const OLIVER = ownerKeyForSubject("https://cloud.example.test", "oliver-sub");
const SLACKED = ownerKeyForSubject("https://id.example.test", "sam-employee");

const task = {
  pk: `DEVTASK#${TASK_ID}`, sk: "META", entityType: "DEVELOPER_TASK", taskId: TASK_ID, orgId: TEST_ORG,
  developerId: NIA, provider: "github", developerName: "Nia Creator",
  project: "payments-api", share: { teamId: TEAM, channelId: "C0PAY0001" },
} as DeveloperTaskRecord;

const developer = (overrides: Partial<DeveloperRecord> & { developerId: string; issuer: string; subject: string; provider: DeveloperRecord["provider"] }): DeveloperRecord => ({
  displayName: "Nia Creator",
  firstSignInAt: new Date(T0 - 1_000).toISOString(), lastSignInAt: new Date(T0).toISOString(), revoked: false,
  ...overrides,
});
const nia = (overrides: Partial<DeveloperRecord> = {}) => developer({ developerId: NIA, provider: "github", issuer: GITHUB, subject: "nia-12345", ...overrides });

function harness(options: { records?: DeveloperRecord[]; access?: (subject: ProjectAccessSubject, project: string, memberOf: readonly string[]) => Promise<void | "viewer"> } = {}) {
  const db = new FakeDynamoDb();
  db.set(task as unknown as Record<string, unknown>);
  const access = vi.fn(options.access ?? (async () => undefined));
  const proof = vi.fn(async (request: TaskPersonProofRequest): Promise<TaskPersonProofResponse> => ({
    ok: true, user: { id: request.slackUserId, teamId: TEAM, name: "Someone" }, memberOf: ["C0PAY0001"],
  }));
  const records = new Map((options.records ?? [nia()]).map((record) => [record.developerId, record]));
  const uuids = [PERSON_1, PERSON_2];
  const deps: TaskPersonIdentityDependencies = {
    documentClient: db, tableName: "state", slackTeamId: TEAM, now: () => T0, uuid: () => uuids.shift() ?? PERSON_2,
    taskPersonProof: proof, developerRecord: async (developerId) => records.get(developerId),
    projectChannelIds: async () => ["C0PAY0001"], targetProjectAccess: access,
  };
  return { db, deps, access, proof, records };
}

const refusal = { code: "PROJECT_ACCESS_DENIED" };

describe("a task person with no Slack account (owner decision 86)", () => {
  it("qualifies a GitHub creator on membership and project access alone: no Slack proof, no channel, access asked with no Slack id and no fresh membership", async () => {
    const { deps, access, proof } = harness();

    const result = await checkTaskPersonIdentity(deps, task, NIA);

    expect(result).toMatchObject({ subject: { developerId: NIA }, identity: { developerId: NIA, method: "github", issuer: GITHUB, subject: "nia-12345", name: "Nia Creator" }, eligible: true, channelMember: true });
    expect(result.identity).not.toHaveProperty("slackUserId");
    expect(result.subject).not.toHaveProperty("slackUserId");
    expect(access).toHaveBeenCalledTimes(1);
    expect(access).toHaveBeenCalledWith({ developerId: NIA }, "payments-api", []);
    expect(proof, "nothing is asked of Slack").not.toHaveBeenCalled();
  });

  it("positive control: the same member with a linked Slack account is still proved through Slack, in its channels", async () => {
    const { deps, proof } = harness({ records: [nia({ slackUserId: "U0NIA0001" })] });

    await expect(checkTaskPersonIdentity(deps, task, NIA)).resolves.toMatchObject({ subject: { developerId: NIA, slackUserId: "U0NIA0001" }, identity: { slackUserId: "U0NIA0001" }, eligible: true, channelMember: true });

    expect(proof).toHaveBeenCalledTimes(1);
  });

  it.each([
    ["web (Rovara sign-in)", "cloud", "https://cloud.example.test", "oliver-sub", OLIVER],
    ["an identity provider", "oidc", "https://id.example.test", "pat-employee", ownerKeyForSubject("https://id.example.test", "pat-employee")],
    ["SAML", "saml", "https://saml.example.test", "quinn-employee", ownerKeyForSubject("https://saml.example.test", "quinn-employee")],
  ] as const)("accepts a member who signed in with %s", async (_label, provider, issuer, subject, developerId) => {
    const own = { ...task, developerId, provider } as DeveloperTaskRecord;
    const { db, deps, proof } = harness({ records: [developer({ developerId, provider, issuer, subject })] });
    db.set(own as unknown as Record<string, unknown>);

    await expect(checkTaskPersonIdentity(deps, own, developerId)).resolves.toMatchObject({ identity: { method: provider }, eligible: true, channelMember: true });

    expect(proof).not.toHaveBeenCalled();
  });

  it("never admits a non-member: with no grant and no org role the project refuses them, and the project's Slack channels cannot rescue them", async () => {
    const { deps, access, proof } = harness({ access: async (subject, _project, memberOf) => {
      // The channel path needs a Slack id and a fresh membership; this person has neither, so only a grant or an org role could allow them, and they have none.
      expect(subject.slackUserId).toBeUndefined();
      expect(memberOf).toEqual([]);
      throw Object.assign(new Error("no access"), { code: "PROJECT_ACCESS_DENIED" });
    } });

    await expect(checkTaskPersonIdentity(deps, task, NIA)).resolves.toMatchObject({ eligible: false, channelMember: false });

    expect(access).toHaveBeenCalledTimes(1);
    expect(proof).not.toHaveBeenCalled();
  });

  it("an unreadable project check is unavailable, never a pass", async () => {
    const { deps } = harness({ access: async () => { throw new Error("dynamodb down"); } });
    await expect(checkTaskPersonIdentity(deps, task, NIA)).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("a project viewer is eligible but capped, as everyone else", async () => {
    const { deps } = harness({ access: async () => "viewer" });
    await expect(checkTaskPersonIdentity(deps, task, NIA)).resolves.toMatchObject({ eligible: true, projectViewer: true });
  });

  it("a person removed from the company is ineligible and the project is not even asked", async () => {
    const { db, deps, access } = harness();
    db.set({ ...orgRemovedKey(TEST_ORG, NIA), entityType: "ORG_REMOVED" });

    await expect(checkTaskPersonIdentity(deps, task, NIA)).resolves.toMatchObject({ eligible: false, channelMember: false });

    expect(access).not.toHaveBeenCalled();
  });

  it("a member who is still a member is not removed (a tombstone beside a live member row does not remove them)", async () => {
    const { db, deps } = harness();
    db.set({ ...orgMemberKey(TEST_ORG, NIA), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: NIA, role: "member" });
    db.set({ ...orgRemovedKey(TEST_ORG, NIA), entityType: "ORG_REMOVED" });
    await expect(checkTaskPersonIdentity(deps, task, NIA)).resolves.toMatchObject({ eligible: true });
  });

  it.each([
    ["revoked", { revoked: true }],
    ["merged away", { mergedInto: "f".repeat(64) }],
  ] as const)("a %s sign-in is ineligible, and nothing else is asked", async (_label, overrides) => {
    const { deps, access } = harness({ records: [nia(overrides)] });
    await expect(checkTaskPersonIdentity(deps, task, NIA)).resolves.toMatchObject({ eligible: false, channelMember: false });
    expect(access).not.toHaveBeenCalled();
  });

  it("refuses a sign-in row that is not the person's (another developer id, another identity, no revoked flag, an unknown method)", async () => {
    const bad: Array<Partial<DeveloperRecord>> = [
      { developerId: "e".repeat(64) },
      { subject: "someone-else" },
      { provider: "slack" },
      { provider: "ldap" as unknown as DeveloperRecord["provider"] },
    ];
    for (const overrides of bad) {
      const { deps, db } = harness({ records: [nia(overrides)] });
      // A record returned under a different key is the row of someone else; the check reads it by Nia's id and must refuse it.
      await expect(checkTaskPersonIdentity(deps, task, NIA), JSON.stringify(overrides)).rejects.toMatchObject(refusal);
      expect(db.find((item) => String(item.sk).startsWith("PERSON"))).toEqual([]);
    }
  });

  it("the route's own non-Slack caller is qualified from their own sign-in row, never from anything the request says", async () => {
    const other = { ...task, developerId: "d".repeat(64), provider: "slack" as const, slackUserId: "U0CREATOR1" } as DeveloperTaskRecord;
    const { db, deps, proof } = harness({ records: [nia()] });
    db.set(other as unknown as Record<string, unknown>);
    Reflect.set(deps, "trustedCaller", { orgId: TEST_ORG, orgRole: "member" as const, developerId: NIA, sessionId: "s", amr: "github", name: "A name the request chose" });

    const result = await checkTaskPersonIdentity(deps, other, NIA);

    expect(result).toMatchObject({ eligible: true, identity: { developerId: NIA, name: "Nia Creator", method: "github" } });
    expect(proof).not.toHaveBeenCalled();
    // Someone else's id is not made eligible by being the caller's: with no registry row and no creator match it is refused.
    await expect(checkTaskPersonIdentity(deps, other, "c".repeat(64))).rejects.toMatchObject(refusal);
  });
});

describe("registering the project's members as task people", () => {
  const persisted = (db: FakeDynamoDb) => db.find((item) => String(item.sk).startsWith("PERSON#"));

  it("registers each qualified member with no Slack account, with no slackUserId key in the stored row, and once", async () => {
    const records = [nia(), developer({ developerId: OLIVER, provider: "cloud", issuer: "https://cloud.example.test", subject: "oliver-sub", displayName: "Oliver Web" })];
    const { db, deps, proof } = harness({ records });

    const first = await registerTaskMembers(deps, task, [NIA, OLIVER]);
    const again = await registerTaskMembers(deps, task, [NIA, OLIVER, NIA]);

    expect(first.map((identity) => identity.developerId)).toEqual([NIA, OLIVER]);
    expect(again.map((identity) => identity.developerId)).toEqual([NIA, OLIVER]);
    expect(persisted(db)).toHaveLength(2);
    for (const row of persisted(db)) {
      expect(row).not.toHaveProperty("slackUserId");
      expect(row.schemaVersion).toBe(1);
      expect(["github", "cloud"]).toContain(row.method);
    }
    expect(proof).not.toHaveBeenCalled();
    // A stored person with no Slack account reads back, and is qualified again on every use.
    const personId = (db.get(`DEVTASK#${TASK_ID}`, `PERSON_SUBJECT#${NIA}`) as { personId: string }).personId;
    await expect(resolveTaskPersonId(deps, TASK_ID, personId)).resolves.toMatchObject({ developerId: NIA, method: "github" });
  });

  it("leaves out a member who does not qualify now, one who is revoked, one with a linked Slack account, and a malformed id", async () => {
    const slacked = developer({ developerId: SLACKED, provider: "oidc", issuer: "https://id.example.test", subject: "sam-employee", slackUserId: "U0SAM0001" });
    const revoked = developer({ developerId: OLIVER, provider: "cloud", issuer: "https://cloud.example.test", subject: "oliver-sub", revoked: true });
    const { db, deps, access } = harness({ records: [nia(), slacked, revoked], access: async (subject) => {
      if (subject.developerId === NIA) throw Object.assign(new Error("no"), { code: "PROJECT_ACCESS_DENIED" });
    } });

    await expect(registerTaskMembers(deps, task, [NIA, SLACKED, OLIVER, "not-a-developer-id", "9".repeat(64)])).resolves.toEqual([]);

    expect(persisted(db)).toEqual([]);
    expect(access.mock.calls.map(([subject]) => subject.developerId), "only the one that could be qualified was asked about").toEqual([NIA]);
  });

  it("an unreadable member table is unavailable, never an empty list that reads as no members", async () => {
    const { deps } = harness();
    deps.developerRecord = async () => { throw new Error("table down"); };
    await expect(registerTaskMembers(deps, task, [NIA])).rejects.toMatchObject({ code: "SLACK_UNAVAILABLE" });
  });

  it("is refused for a task that is not the stored one", async () => {
    const { deps } = harness();
    await expect(registerTaskMembers(deps, { ...task, project: "other-project" }, [NIA])).rejects.toMatchObject(refusal);
  });
});

describe("the key authority's identity check for a person with no Slack account", () => {
  it("holds a person with no Slack id to everything else (provider, issuer, subject, not revoked, not merged) and does not compare a Slack id", () => {
    const check = oidcTaskPersonIdentityCheck("signin", { developerId: NIA, issuer: GITHUB, subject: "nia-12345", provider: "github" }).ConditionCheck;
    expect(check.ConditionExpression).not.toContain("slackUserId");
    expect(check.ConditionExpression).not.toContain("#identitySlack");
    expect(check.ExpressionAttributeValues).not.toHaveProperty(":identitySlack");
    expect(check.ExpressionAttributeValues).toMatchObject({ ":identityProvider": "github", ":identityRevoked": false });
    expect(check.ConditionExpression).toContain("attribute_not_exists(#identityMerged)");
    const slack = oidcTaskPersonIdentityCheck("signin", { developerId: NIA, issuer: GITHUB, subject: "nia-12345", provider: "github", slackUserId: "U0NIA0001" }).ConditionCheck;
    expect(slack.ConditionExpression).toContain("#identitySlack = :identitySlack");
    expect(slack.ExpressionAttributeValues).toMatchObject({ ":identitySlack": "U0NIA0001" });
  });
});
