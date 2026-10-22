// Plan 3 Task 11: what happens to agents when a member is merged into another, a member is removed, or a project is archived. The sign-in
// function only leaves a marker in the `MEMBER_MERGE_QUEUE` partition; the broker's 5-minute sweep drains it and moves what the duplicate
// owned. A removal moves what the person owned at once, and leaves the same kind of marker until it has.
import { describe, expect, it, vi } from "vitest";
import {
  MEMBER_MERGE_QUEUE_PK, developerOrgKey, memberMergeQueueKey, orgMemberKey, orgSettingsKey, principalSharesKey, type OrgId,
} from "@agentx/contracts";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { mergeDuplicateMember } from "../../packages/broker/src/org/merge-members.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { DeveloperSignInStore } from "../../packages/broker/src/developer/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";

const T0 = Date.parse("2026-10-22T09:00:00.000Z");
const GITHUB_ISSUER = "https://github.com";
const OIDC_ISSUER = "https://idp.example.test";
const D1 = ownerKeyForSubject(OIDC_ISSUER, "priya-cloud-1");
const D2 = ownerKeyForSubject(GITHUB_ISSUER, "4711");
const EMAIL = "priya@acme.dev";

const developerRecord = (developerId: string, provider: "cloud" | "github", issuer: string, subject: string) =>
  ({ pk: `DEVELOPER#${developerId}`, sk: "META", entityType: "DEVELOPER", developerId, provider, issuer, subject, displayName: "Priya", email: EMAIL, firstSignInAt: "2026-09-01T00:00:00.000Z", lastSignInAt: "2026-09-02T00:00:00.000Z", revoked: false });

/** The staging shape of Plan 2 Task 3: D1 created the org, D2 was added to it by a sign-in from before identity links. One table plays both tables. */
async function mergeWorld() {
  let clock = T0;
  const db = new FakeDynamoDb();
  const signInStore = new DeveloperSignInStore({ documentClient: db, tableName: "signin", now: () => clock });
  const orgs = new OrgStore({ documentClient: db, tableName: "state", now: () => clock });
  db.set(developerRecord(D1, "cloud", OIDC_ISSUER, "priya-cloud-1"));
  db.set(developerRecord(D2, "github", GITHUB_ISSUER, "4711"));
  const orgId = await orgs.createOrgWithOwner({ name: "Priya's team", developerId: D1, email: EMAIL });
  await orgs.addMember({ orgId, developerId: D2, role: "member" });
  const mergeDeps = { documentClient: db, tableName: "state", signInStore, now: () => clock };
  const merge = (survivorId = D1, duplicateId = D2) => mergeDuplicateMember(mergeDeps, { orgId, survivorId, duplicateId, duplicateIdentityKey: duplicateId });
  return { db, orgs, orgId, signInStore, merge, tick: (ms: number) => { clock += ms; } };
}

const markers = (db: FakeDynamoDb) => db.find((item) => item.pk === MEMBER_MERGE_QUEUE_PK);

describe("the merge marker", () => {
  it("puts one marker with a time sort key, in the merge's own transaction and nowhere else", async () => {
    const w = await mergeWorld();
    w.tick(1000);
    const commandsBefore = w.db.commandNames().length;

    await w.merge();

    expect(markers(w.db)).toEqual([{
      ...memberMergeQueueKey("2026-10-22T09:00:01.000Z", w.orgId, D2),
      entityType: "MEMBER_MERGE", orgId: w.orgId, survivorId: D1, duplicateId: D2,
    }]);
    expect(markers(w.db)[0]!.sk).toBe(`2026-10-22T09:00:01.000Z#${w.orgId}#${D2}`);
    // One transaction wrote it with the merge; the sign-in path made no separate write for it.
    const writes = w.db.commandNames().slice(commandsBefore).filter((name) => ["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand"].includes(name));
    expect(writes).toEqual(["TransactWriteCommand"]);
    // The member is merged in that same transaction: both or neither.
    expect(w.db.get(orgMemberKey(w.orgId, D2))).toBeUndefined();
  });

  it("is not written when the merge's transaction fails, and not again when the merge is repeated", async () => {
    const w = await mergeWorld();
    w.db.injectFault({ command: "TransactWriteCommand", error: { name: "InternalServerError" } });
    await expect(w.merge()).rejects.toThrow();
    expect(markers(w.db)).toEqual([]);

    await w.merge();
    expect(markers(w.db)).toHaveLength(1);
    w.tick(60_000);
    await w.merge();
    expect(markers(w.db)).toHaveLength(1);
  });

  it("holds ids and the org only", async () => {
    const w = await mergeWorld();
    await w.merge();
    expect(Object.keys(markers(w.db)[0]!).sort()).toEqual(["duplicateId", "entityType", "orgId", "pk", "sk", "survivorId"]);
  });
});

void [vi, developerOrgKey, orgSettingsKey, principalSharesKey];
type Unused = OrgId;
