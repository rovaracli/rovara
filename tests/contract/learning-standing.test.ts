// v1.2 learning loop, B3: who is a member and who is an outsider (design 2.4, owner Q1). Read live from the company member record and the project grant; nothing else counts.
import { describe, expect, it } from "vitest";
import { githubMemberKey, projectMemberKey } from "@rovara-code/contracts";
import { orgMemberKey } from "@agentx/cloud-contracts";
import { learningScopeOf, learningSalt, readStanding, readStandings } from "../../packages/broker/src/learning/standing.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { TEST_ORG } from "../support/orgs.js";
import { LEO, MAYA_ADMIN, OMAR, PRIYA, PROJECT, PROJECT_CREATED_AT, SAM, seedGrant, seedMember, seedPerson, seedProject } from "../support/learning-page.js";

const world = () => { const db = new FakeDynamoDb(); return { db, deps: { documentClient: db, tableName: "state" } }; };
const standing = (w: ReturnType<typeof world>, who = PRIYA, project = PROJECT) => readStanding(w.deps, TEST_ORG, who.developerId, project);

describe("standing: member or outsider", () => {
  it("a contributor and a maintainer with a company record are members", async () => {
    const w = world();
    seedPerson(w.db, PRIYA, "contributor");
    seedPerson(w.db, SAM, "maintainer");
    expect(await standing(w, PRIYA)).toBe("member");
    expect(await standing(w, SAM)).toBe("member");
  });

  it("a company owner or admin is a member of every project, with no grant", async () => {
    const w = world();
    seedPerson(w.db, PRIYA, "none", "owner");
    seedPerson(w.db, SAM, "none", "admin");
    expect(await standing(w, PRIYA)).toBe("member");
    expect(await standing(w, SAM)).toBe("member");
  });

  it("a project viewer, and a person with no grant, are outsiders", async () => {
    const w = world();
    seedPerson(w.db, PRIYA, "viewer");
    seedPerson(w.db, SAM, "none");
    expect(await standing(w, PRIYA)).toBe("outsider");
    expect(await standing(w, SAM)).toBe("outsider");
  });

  it("owner Q1: reaching the project only through its Slack channel does not count (no grant, Slack identity, channel member)", async () => {
    const w = world();
    seedMember(w.db, SAM); // signed in and in the channel, but granted nothing
    expect(SAM.slackUserId).toBeDefined();
    expect(await standing(w, SAM)).toBe("outsider");
  });

  it("a person with a grant but no company record (removed, or never joined) is an outsider", async () => {
    const w = world();
    seedGrant(w.db, PRIYA, "maintainer");
    expect(await standing(w, PRIYA)).toBe("outsider");
    // Removed from the company later: the member record is gone and the grant row is left behind.
    seedPerson(w.db, SAM, "contributor");
    expect(await standing(w, SAM)).toBe("member");
    w.db.delete(orgMemberKey(TEST_ORG, SAM.developerId));
    expect(await standing(w, SAM)).toBe("outsider");
  });

  it("a GitHub link alone is not membership (GITHUB_MEMBER survives leaving)", async () => {
    const w = world();
    w.db.set({ ...githubMemberKey(TEST_ORG, "4242"), entityType: "GITHUB_MEMBER", orgId: TEST_ORG, githubUserId: "4242", developerId: PRIYA.developerId });
    expect(await standing(w, PRIYA)).toBe("outsider");
  });

  it("a member record or grant that names another person, company or project is not one", async () => {
    const w = world();
    seedGrant(w.db, PRIYA, "maintainer");
    w.db.set({ ...orgMemberKey(TEST_ORG, PRIYA.developerId), entityType: "ORG_MEMBER", orgId: "org_zzzzzzzzzzzzzzzzzzzz", developerId: PRIYA.developerId, role: "member" });
    expect(await standing(w, PRIYA)).toBe("outsider");
    seedMember(w.db, SAM);
    w.db.set({ ...projectMemberKey(TEST_ORG, SAM.developerId, PROJECT), entityType: "PROJECT_MEMBER", orgId: TEST_ORG, ownerKey: OMAR.developerId, projectName: PROJECT, role: "developer", projectRole: "maintainer", grantId: "g" });
    expect(await standing(w, SAM)).toBe("outsider");
    seedMember(w.db, LEO);
    seedGrant(w.db, LEO, "maintainer", "other-project");
    expect(await standing(w, LEO)).toBe("outsider");
  });

  it("an unreadable record fails closed: the read throws, it does not answer member or outsider", async () => {
    const w = world();
    seedPerson(w.db, PRIYA, "maintainer");
    w.db.injectFault({ command: "GetCommand", error: { name: "InternalServerError" }, times: 5 });
    await expect(standing(w, PRIYA)).rejects.toBeDefined();
  });

  it("reads several people at once (the Accept re-check), each by the same test", async () => {
    const w = world();
    seedPerson(w.db, PRIYA, "contributor");
    seedPerson(w.db, SAM, "viewer");
    seedPerson(w.db, MAYA_ADMIN, "none", "admin");
    const result = await readStandings(w.deps, TEST_ORG, PROJECT, [PRIYA.developerId, SAM.developerId, MAYA_ADMIN.developerId, PRIYA.developerId]);
    expect(Object.fromEntries(result)).toEqual({ [PRIYA.developerId]: "member", [SAM.developerId]: "outsider", [MAYA_ADMIN.developerId]: "member" });
  });
});

describe("the project scope", () => {
  it("is the project META's createdAt, canonical, and only for an active project", async () => {
    const w = world();
    expect(await learningScopeOf(w.deps, TEST_ORG, PROJECT)).toBeUndefined();
    seedProject(w.db);
    expect(await learningScopeOf(w.deps, TEST_ORG, PROJECT)).toEqual({ orgId: TEST_ORG, project: PROJECT, projectCreatedAt: PROJECT_CREATED_AT });
    seedProject(w.db, PROJECT, "archived");
    expect(await learningScopeOf(w.deps, TEST_ORG, PROJECT)).toBeUndefined();
  });

  it("gives a salt per company, project and project instance", () => {
    const base = { orgId: TEST_ORG, project: PROJECT, projectCreatedAt: PROJECT_CREATED_AT };
    expect(learningSalt(base)).toBe(learningSalt({ ...base }));
    expect(learningSalt({ ...base, project: "web" })).not.toBe(learningSalt(base));
    expect(learningSalt({ ...base, projectCreatedAt: "2026-10-02T00:00:00.000Z" })).not.toBe(learningSalt(base));
    expect(learningSalt({ ...base, orgId: "org_zzzzzzzzzzzzzzzzzzzz" })).not.toBe(learningSalt(base));
  });
});
