// Review groups (owner decision 9): a person's erase takes them out of every review group of every project (the document moves to its next revision) and gives back every claim
// they hold (holder, group and time removed, revision moved on). Nobody else's membership or claim changes, and not the same person's in another company.
import { PutCommand } from "@aws-sdk/lib-dynamodb";
import { describe, expect, it } from "vitest";
import { reviewClaimKey, reviewGroupsKey } from "@agentx/cloud-contracts";
import type { OrgId } from "@rovara-code/contracts";
import { erasePerson } from "../../../packages/broker/src/team-record/erase.js";
import { PERSON_FIELDS } from "../../../packages/broker/src/team-record/person-fields.js";
import { scrubReviewClaimsPerson, scrubReviewGroupsPerson } from "../../../packages/broker/src/review-groups/erase.js";
import { ORG_A, ORG_B, world } from "../../support/team-record-core.js";
import { deleteDeps } from "../../support/team-record-delete.js";

const GONE = "a".repeat(64), STAYS = "b".repeat(64), OTHER = "c".repeat(64);
const TASK_1 = "11111111-1111-4111-8111-111111111111", TASK_2 = "22222222-2222-4222-8222-222222222222", TASK_3 = "33333333-3333-4333-8333-333333333333";
const AT = "2026-11-11T12:00:00.000Z";

type W = ReturnType<typeof world>;
const put = (w: W, item: Record<string, unknown>) => w.table.documentClient.send(new PutCommand({ TableName: w.table.tableName, Item: item }));
const groupsDoc = (orgId: OrgId, project: string, revision: number, groups: Array<{ groupId: string; name: string; members: string[] }>) =>
  ({ ...reviewGroupsKey(orgId, project), entityType: "REVIEW_GROUPS", orgId, project, revision, groups, lastRequestId: "22222222-2222-4222-8222-000000000001", lastRequestDigest: "d".repeat(64) });
const claim = (orgId: OrgId, project: string, taskId: string, holder: string, revision = 1) =>
  ({ ...reviewClaimKey(orgId, project, taskId), entityType: "REVIEW_CLAIM", orgId, taskId, project, revision, holder, groupId: "rgp_0123456789abcdef", claimedAt: AT, hostSync: "requested", reviewKey: "e".repeat(64), lastRequestId: "x", lastRequestDigest: "y" });
const get = (w: W, key: { pk: string; sk: string }) => w.db.get(key) as Record<string, unknown> | undefined;

async function seed(w: W): Promise<void> {
  await put(w, groupsDoc(ORG_A, "web", 3, [{ groupId: "rgp_0000000000000001", name: "Payments", members: [GONE, STAYS] }, { groupId: "rgp_0000000000000002", name: "Core", members: [GONE] }]));
  await put(w, groupsDoc(ORG_A, "api", 1, [{ groupId: "rgp_0000000000000003", name: "API", members: [STAYS] }]));
  await put(w, groupsDoc(ORG_B, "web", 1, [{ groupId: "rgp_0000000000000004", name: "Payments", members: [GONE] }]));
  await put(w, claim(ORG_A, "web", TASK_1, GONE, 4));
  await put(w, claim(ORG_A, "web", TASK_2, STAYS));
  await put(w, claim(ORG_A, "api", TASK_3, GONE));
  await put(w, claim(ORG_B, "web", TASK_1, GONE));
}

describe("a person's erase removes them from review groups and gives back their claims", () => {
  it("through the erase's config step: every project of the company, nobody else, not another company", async () => {
    const w = world();
    await seed(w);
    // positive control: the person is in the stored documents and holds the claims
    expect(JSON.stringify(get(w, reviewGroupsKey(ORG_A, "web")))).toContain(GONE);
    expect(get(w, reviewClaimKey(ORG_A, "web", TASK_1))?.["holder"]).toBe(GONE);

    const result = await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: GONE, projects: ["web", "api"] }, "erase-review-1");
    expect(result.steps?.config).toBe(true);

    const web = get(w, reviewGroupsKey(ORG_A, "web"))!;
    expect(web).toMatchObject({ revision: 4, groups: [{ groupId: "rgp_0000000000000001", members: [STAYS] }, { groupId: "rgp_0000000000000002", members: [] }] });
    expect(web).not.toHaveProperty("lastRequestId");
    expect(JSON.stringify(web)).not.toContain(GONE);
    expect(get(w, reviewGroupsKey(ORG_A, "api"))).toMatchObject({ revision: 1, groups: [{ members: [STAYS] }] });
    expect(get(w, reviewGroupsKey(ORG_B, "web"))).toMatchObject({ revision: 1, groups: [{ members: [GONE] }] });

    const released = get(w, reviewClaimKey(ORG_A, "web", TASK_1))!;
    expect(released).toMatchObject({ revision: 5, lastAction: "erased" });
    for (const field of ["holder", "groupId", "claimedAt", "hostSync", "reviewKey", "lastRequestId"]) expect(released, field).not.toHaveProperty(field);
    expect(get(w, reviewClaimKey(ORG_A, "api", TASK_3))).not.toHaveProperty("holder");
    expect(get(w, reviewClaimKey(ORG_A, "web", TASK_2))).toMatchObject({ holder: STAYS, revision: 1 });
    expect(get(w, reviewClaimKey(ORG_B, "web", TASK_1))).toMatchObject({ holder: GONE, revision: 1 });
  });

  it("is idempotent: a second run changes nothing more", async () => {
    const w = world();
    await seed(w);
    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: GONE, projects: ["web", "api"] }, "erase-review-2");
    const again = await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: GONE, projects: ["web", "api"] }, "erase-review-3");
    expect(again.steps?.config).toBe(true);
    expect(get(w, reviewGroupsKey(ORG_A, "web"))?.["revision"]).toBe(4);
    expect(get(w, reviewClaimKey(ORG_A, "web", TASK_1))?.["revision"]).toBe(5);
  });

  it("a document that does not read leaves the step unfinished (fail closed), and is not overwritten", async () => {
    const w = world();
    await put(w, { ...groupsDoc(ORG_A, "web", 2, []), groups: "garbage" });
    expect(await scrubReviewGroupsPerson(w.table, ORG_A, "web", GONE, AT)).toBe(false);
    expect(get(w, reviewGroupsKey(ORG_A, "web"))?.["groups"]).toBe("garbage");
    const result = await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: GONE, projects: ["web"] }, "erase-review-4");
    expect(result.steps?.config).toBe(false);
  });

  it("reads every page of a project's claims, and stops unfinished at its read budget", async () => {
    const w = world();
    const ids = Array.from({ length: 150 }, (_, index) => `${String(index).padStart(8, "0")}-1111-4111-8111-111111111111`);
    for (const taskId of ids) await put(w, claim(ORG_A, "web", taskId, taskId === ids[149] ? GONE : OTHER));
    expect(await scrubReviewClaimsPerson(w.table, ORG_A, "web", GONE, AT, 100)).toBe(false);
    expect(await scrubReviewClaimsPerson(w.table, ORG_A, "web", GONE, AT)).toBe(true);
    expect(get(w, reviewClaimKey(ORG_A, "web", ids[149]!))).not.toHaveProperty("holder");
  });

  it("turns `updatedBy` naming the person into the 64-zero stand-in on every groups document and claim of the project, member, holder or not", async () => {
    const w = world();
    const ZERO = "0".repeat(64);
    // they saved the groups and have since left every group
    await put(w, { ...groupsDoc(ORG_A, "api", 2, [{ groupId: "rgp_0000000000000003", name: "API", members: [STAYS] }]), updatedBy: GONE });
    // they are in a group and saved it
    await put(w, { ...groupsDoc(ORG_A, "web", 3, [{ groupId: "rgp_0000000000000001", name: "Payments", members: [GONE, STAYS] }]), updatedBy: GONE });
    // a document that does not read still loses their id
    await put(w, { ...groupsDoc(ORG_A, "ops", 1, []), groups: "garbage", updatedBy: GONE });
    // a claim someone else holds, that they reassigned
    await put(w, { ...claim(ORG_A, "web", TASK_2, STAYS), updatedBy: GONE });
    // a claim nobody holds, that they released
    const released = claim(ORG_A, "api", TASK_3, STAYS);
    delete (released as Record<string, unknown>)["holder"];
    await put(w, { ...released, updatedBy: GONE });
    // someone else's change, and another company's
    await put(w, { ...claim(ORG_A, "web", TASK_1, STAYS), updatedBy: STAYS });
    await put(w, { ...groupsDoc(ORG_B, "api", 1, []), updatedBy: GONE });

    await erasePerson(deleteDeps(w).deps, ORG_A, { developerId: GONE, projects: ["web", "api", "ops"] }, "erase-review-5");

    expect(get(w, reviewGroupsKey(ORG_A, "api"))).toMatchObject({ updatedBy: ZERO, revision: 2 });
    expect(get(w, reviewGroupsKey(ORG_A, "web"))).toMatchObject({ updatedBy: "erase", revision: 4 });
    expect(get(w, reviewGroupsKey(ORG_A, "ops"))).toMatchObject({ updatedBy: ZERO, groups: "garbage" });
    expect(get(w, reviewClaimKey(ORG_A, "web", TASK_2))).toMatchObject({ updatedBy: ZERO, holder: STAYS, revision: 1 });
    expect(get(w, reviewClaimKey(ORG_A, "api", TASK_3))).toMatchObject({ updatedBy: ZERO });
    expect(get(w, reviewClaimKey(ORG_A, "web", TASK_1))).toMatchObject({ updatedBy: STAYS });
    expect(get(w, reviewGroupsKey(ORG_B, "api"))).toMatchObject({ updatedBy: GONE });
    for (const item of w.db.find((entry) => entry.orgId === ORG_A && (entry.entityType === "REVIEW_GROUPS" || entry.entityType === "REVIEW_CLAIM"))) expect(JSON.stringify(item)).not.toContain(GONE);
  });

  it("the registry names both under the config step", () => {
    expect(PERSON_FIELDS.find((field) => field.names.includes("reviewGroupMembers"))).toMatchObject({ store: "hot", step: "config" });
    expect(PERSON_FIELDS.find((field) => field.names.includes("holder"))).toMatchObject({ store: "hot", step: "config" });
    expect(PERSON_FIELDS.find((field) => field.names.includes("reviewGroupMembers"))?.names).toContain("updatedBy");
  });
});
