// Enterprise foundations, I2 fix round 1: the Auditor writes nothing on EVERY surface, not only behind the HTTP dispatcher. Slack, the approval page, GitHub reviews, the task paths and the
// dispatch guard each ask for the person's live company role and refuse one that is not a writer's. Every case fails when the check it names is removed.
import { describe, expect, it } from "vitest";
import { developerOrgKey, editionPolicy, orgMemberKey, projectMemberKey } from "@agentx/contracts";
import { developerIdForSlackUser } from "../../packages/broker/src/aws/admin-actions.js";
import { liveWriterRole } from "../../packages/broker/src/org/live-role.js";
import { requireWriterCaller } from "../../packages/broker/src/org/auditor.js";
import { humanApprovalOf, linkedAmong, nonWritersAmong } from "../../packages/broker/src/rovara-code/approval.js";
import { githubMemberKey, memberGithubKey } from "@agentx/contracts";
import { DECIDE_COOKIE, csrfTokenFor, requireDecideSession } from "../../packages/broker/src/developer/decide-session.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { SLACK_TEAM } from "../support/slack-broker.js";
import { createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";

const USER = "U0AUDITOR1";
const standIn = developerIdForSlackUser(USER);
const refused = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => error);

describe("a writer role is a type, and an unchecked caller becomes one in one place", () => {
  it("accepts the three writer roles and refuses the Auditor, any other value and an absent role", () => {
    for (const orgRole of ["owner", "admin", "member"]) expect(requireWriterCaller({ orgRole }).orgRole).toBe(orgRole);
    for (const orgRole of ["auditor", "viewer", "", "Owner", undefined as never]) expect(() => requireWriterCaller({ orgRole }), String(orgRole)).toThrow("FORBIDDEN");
  });
});

describe("the live role of a person", () => {
  const db = new FakeDynamoDb();
  const merged = "m".repeat(64), survivor = "s".repeat(64);
  db.set({ ...orgMemberKey(TEST_ORG, standIn), orgId: TEST_ORG, developerId: standIn, role: "member" });
  db.set({ ...orgMemberKey(TEST_ORG, survivor), orgId: TEST_ORG, developerId: survivor, role: "auditor" });
  db.set({ pk: `DEVELOPER#${merged}`, sk: "META", developerId: merged, mergedInto: survivor });
  db.set({ ...orgMemberKey(TEST_ORG, merged), orgId: TEST_ORG, developerId: merged, role: "member" });
  const deps = { documentClient: db, tableName: "state", signInTableName: "state" };

  it("is the writer role on record, none for a person with no record, and a refusal for any record that is not a writer's", async () => {
    expect(await liveWriterRole(deps, TEST_ORG, standIn)).toBe("member");
    expect(await liveWriterRole(deps, TEST_ORG, "n".repeat(64))).toBeUndefined();
    db.set({ ...orgMemberKey(TEST_ORG, "a".repeat(64)), orgId: TEST_ORG, developerId: "a".repeat(64), role: "auditor" });
    db.set({ ...orgMemberKey(TEST_ORG, "b".repeat(64)), orgId: TEST_ORG, developerId: "b".repeat(64), role: "future-role" });
    for (const id of ["a", "b"]) expect(await refused(liveWriterRole(deps, TEST_ORG, id.repeat(64))), id).toMatchObject({ code: "FORBIDDEN" });
  });

  it("follows a merge: a member record merged into an Auditor is an Auditor", async () => {
    expect(await refused(liveWriterRole(deps, TEST_ORG, merged))).toMatchObject({ code: "FORBIDDEN" });
    // Without the sign-in table the merge cannot be followed and the member record answers: the caller passes it wherever it has it.
    expect(await liveWriterRole({ documentClient: db, tableName: "state" }, TEST_ORG, merged)).toBe("member");
  });
});

describe("Slack", () => {
  async function resolved(setup: (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>) => void, edition?: "enterprise" | "public") {
    const h = await createDeveloperTaskBroker();
    setup(h);
    const { slackCallerFor } = await import("../../packages/broker/src/aws/broker/dependency-wiring.js");
    // Enterprise: the company sign-in (I1) allows this Slack user (its allowance store says who), and the Slack caller then also needs a member record (I2 below it).
    const allowance = edition === "enterprise" ? { sso: { slack: { allowedDeveloper: async () => standIn } } } : {};
    return slackCallerFor({ ...h.brokerInput, ...allowance, ...(edition === undefined ? {} : { editionPolicy: editionPolicy(edition) }) } as never, USER, SLACK_TEAM);
  }
  const seed = (role: string) => (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>) => { seedMembership(h.db, standIn, { orgId: TEST_ORG, role: role as never }); };

  it("gives the Slack caller the person's real company role", async () => {
    expect((await resolved(seed("member"))).orgRole).toBe("member");
    expect((await resolved(seed("admin"))).orgRole).toBe("admin");
  });

  it("refuses an Auditor, and a role that is not a writer's: starting or steering a task from Slack is not theirs", async () => {
    for (const role of ["auditor", "future-role"]) {
      await expect(resolved(seed(role)), role).rejects.toMatchObject({ code: "FORBIDDEN" });
    }
  });

  it("refuses an Auditor whose Slack identity was merged into their Rovara person", async () => {
    const survivor = "9".repeat(64);
    const setup = (h: Awaited<ReturnType<typeof createDeveloperTaskBroker>>) => {
      h.db.set({ pk: `DEVELOPER#${standIn}`, sk: "META", developerId: standIn, mergedInto: survivor });
      h.db.set({ ...orgMemberKey(TEST_ORG, survivor), orgId: TEST_ORG, developerId: survivor, role: "auditor", joinedAt: "2026-10-01T00:00:00Z" });
      h.db.set({ ...developerOrgKey(survivor), orgId: TEST_ORG, developerId: survivor, role: "auditor" });
    };
    await expect(resolved(setup)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("on Enterprise a Slack identity with no member record is not let in as an implicit member (refused by the company sign-in's allowance first, and by the role step behind it); on Public and where the edition is not known it is, as before", async () => {
    const none = () => undefined;
    await expect(resolved(none, "enterprise")).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await resolved(none, "public")).orgRole).toBe("member");
    expect((await resolved(none)).orgRole).toBe("member");
    expect((await resolved(seed("member"), "enterprise")).orgRole).toBe("member");
  });

  it("the role step refuses an unknown Slack identity by itself where the edition has the Auditor but no company allowance to ask (the rule does not lean on the allowance)", async () => {
    const h = await createDeveloperTaskBroker();
    const { slackCallerFor } = await import("../../packages/broker/src/aws/broker/dependency-wiring.js");
    const enterprise = editionPolicy("enterprise");
    const policy = { ...enterprise, features: { ...enterprise.features, sso: false } };
    await expect(slackCallerFor({ ...h.brokerInput, editionPolicy: policy } as never, USER, SLACK_TEAM)).rejects.toMatchObject({ code: "FORBIDDEN", message: expect.stringContaining("has not signed in to Rovara") as string });
  });
});

describe("a Slack task whose owner has become an Auditor", () => {
  it("is not steered from Slack: the legacy owner swap checks the owner's live role", async () => {
    const owner = "7".repeat(64);
    const h = await createDeveloperTaskBroker();
    const { taskKey } = await import("../../packages/broker/src/developer/task-records.js");
    h.db.set({ ...taskKey("11111111-1111-4111-8111-111111111111"), entityType: "TASK", taskId: "11111111-1111-4111-8111-111111111111", developerId: owner, developerName: "Olga Owner", provider: "slack", slackUserId: USER, orgId: TEST_ORG, project: "payments", workspaceId: "w1", ownerKey: owner });
    const { slackTaskAccess } = await import("../../packages/broker/src/aws/broker/slack-workflow-events.js");
    const attempt = (role: string) => {
      seedMembership(h.db, owner, { orgId: TEST_ORG, role: role as never });
      return refused(slackTaskAccess(h.brokerInput as never, h.actions, "11111111-1111-4111-8111-111111111111", USER, "read", true));
    };
    expect(await attempt("auditor")).toMatchObject({ code: "FORBIDDEN", message: "FORBIDDEN: Your company role can read the audit log and nothing else." });
    // The control: the same task with a member owner is not stopped at this step (it may be refused later for want of a People list or a grant, which is not the point).
    const control = await attempt("member");
    expect(control === undefined || !String(control.message).includes("read the audit log")).toBe(true);
  });
});

describe("the task paths", () => {
  it("refuse work for a person who has become an Auditor, whatever grant they still hold, and do not for a member with the same grant", async () => {
    const h = await createDeveloperTaskBroker();
    const who = "5".repeat(64);
    const { requireProjectAuthority } = await import("../../packages/broker/src/aws/broker/records.js");
    h.db.set({ ...projectMemberKey(TEST_ORG, who, "payments"), entityType: "MEMBERSHIP", ownerKey: who, projectName: "payments", role: "developer", projectRole: "maintainer", grantId: "g1" });
    const attempt = async (role: string) => {
      seedMembership(h.db, who, { orgId: TEST_ORG, role: role as never });
      return refused(requireProjectAuthority(h.brokerInput as never, TEST_ORG, who, "payments"));
    };
    for (const role of ["auditor", "future-role"]) expect(await attempt(role), role).toMatchObject({ code: "TASK_ACCESS_DENIED" });
    expect(await attempt("member")).toBeUndefined();
  });
});

describe("the task creator is the person whose role is read (re-check)", () => {
  it("reads the creator named by the task, not the key that holds the grant: a member's key running an Auditor's task is refused", async () => {
    const h = await createDeveloperTaskBroker();
    const holder = "4".repeat(64), creator = "3".repeat(64);
    const { requireProjectAuthority } = await import("../../packages/broker/src/aws/broker/records.js");
    h.db.set({ ...projectMemberKey(TEST_ORG, holder, "payments"), entityType: "MEMBERSHIP", ownerKey: holder, projectName: "payments", role: "developer", projectRole: "maintainer", grantId: "g1" });
    seedMembership(h.db, holder, { orgId: TEST_ORG, role: "member" });
    seedMembership(h.db, creator, { orgId: TEST_ORG, role: "auditor" });
    const attempt = (taskCreator: () => Promise<string | undefined>) => refused(requireProjectAuthority(h.brokerInput as never, TEST_ORG, holder, "payments", { taskCreator }));
    expect(await attempt(async () => creator)).toMatchObject({ code: "TASK_ACCESS_DENIED" });
    // The controls: the same key with no creator named, or with a member creator, is let through by its grant.
    expect(await attempt(async () => undefined)).toBeUndefined();
    seedMembership(h.db, creator, { orgId: TEST_ORG, role: "member" });
    expect(await attempt(async () => creator)).toBeUndefined();
  });
});

describe("the dispatch guard", () => {
  it("holds the task of a person who has become an Auditor like a viewer's, and does not hold a member's", async () => {
    const { creatorIsProjectViewer } = await import("../../packages/broker/src/aws/task-dispatch-access.js");
    const who = "6".repeat(64);
    const db = new FakeDynamoDb();
    db.set({ ...projectMemberKey(TEST_ORG, who, "payments"), entityType: "MEMBERSHIP", ownerKey: who, projectName: "payments", role: "developer", projectRole: "maintainer", grantId: "g1" });
    const task = { taskId: "22222222-2222-4222-8222-222222222222", orgId: TEST_ORG, project: "payments", developerId: who, developerName: "Pat", provider: "slack" } as never;
    const held = async (role: string) => {
      db.set({ ...orgMemberKey(TEST_ORG, who), orgId: TEST_ORG, developerId: who, role });
      return creatorIsProjectViewer({ documentClient: db, tableName: "state" }, task);
    };
    expect(await held("auditor")).toBe(true);
    expect(await held("future-role")).toBe(true);
    expect(await held("member")).toBe(false);
  });
});

describe("the approval page", () => {
  const sha = (value: string) => createHash("sha256").update(value).digest("hex");

  async function sessionFor(role: string) {
    const h = await createDeveloperTaskBroker();
    const who = "c".repeat(64);
    seedMembership(h.db, who, { orgId: TEST_ORG, role: role as never });
    const { decideRequestContext } = await import("../../packages/broker/src/aws/broker/scope-helpers.js");
    const context = decideRequestContext({ ...h.brokerInput, decide: { kinds: {} } } as never, undefined);
    expect(context, "the assembly the handler uses builds a context").toBeDefined();
    const cookie = `cookie-${"x".repeat(40)}`;
    const approvalId = "apr_1a2b3c4d5e6f7g8h9i0j";
    const now = Math.floor(Date.now() / 1000);
    await context!.store.putSession(cookie, { orgId: TEST_ORG, developerId: who, approvalId, signedInAt: now, method: "email_code", csrfHash: sha(csrfTokenFor(cookie)), expiresAt: now + 600 });
    const request = { method: "GET", path: `/v1/app/approve/${approvalId}`, headers: { cookie: `${DECIDE_COOKIE}=${cookie}` } };
    return { context: context!, request };
  }

  it("is assembled with the writer check, and serves a member", async () => {
    const s = await sessionFor("member");
    expect(s.context.requireWriter).toBeTypeOf("function");
    expect(await requireDecideSession(s.context, s.request)).toMatchObject({ developerId: "c".repeat(64) });
  });

  it("refuses an Auditor who still has a leftover grant or ownership that names them as an approver", async () => {
    const s = await sessionFor("auditor");
    await expect(requireDecideSession(s.context, s.request)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });
});

describe("GitHub approval", () => {
  const db = new FakeDynamoDb();
  const member = "1".repeat(64), auditor = "2".repeat(64);
  for (const [id, github, role] of [[member, "1001", "member"], [auditor, "1002", "auditor"]] as const) {
    db.set({ ...orgMemberKey(TEST_ORG, id), orgId: TEST_ORG, developerId: id, role });
    db.set({ ...githubMemberKey(TEST_ORG, github), orgId: TEST_ORG, githubUserId: github, developerId: id });
    db.set({ ...memberGithubKey(TEST_ORG, id), orgId: TEST_ORG, githubUserId: github, developerId: id });
  }
  const deps = { documentClient: db, tableName: "state" } as never;

  it("counts a linked member as the human approver and never a linked Auditor", async () => {
    expect([...await linkedAmong(deps, TEST_ORG, ["1001", "1002"])]).toEqual(["1001"]);
  });

  it("an Auditor's linked account never counts, with self-approval on or off (re-check New-1)", async () => {
    const excluded = await nonWritersAmong(deps, TEST_ORG, ["1001", "1002", "9999"]);
    expect([...excluded]).toEqual(["1002"]);
    const review = (githubUserId: string, login: string) => ({ githubUserId, login, state: "APPROVED", commitId: "h".repeat(40), userType: "User", submittedAt: "2026-10-31T00:00:00Z" });
    const input = (reviews: unknown[], allowSelfApproval: boolean, excludedGithubUserIds: ReadonlySet<string> | undefined) => humanApprovalOf({
      reviews: reviews as never, headSha: "h".repeat(40), syncedFrom: undefined, ciPassingOnHead: true,
      permissions: new Map([["aud", "write"], ["mem", "write"], ["outsider", "write"]]), requesterGithubUserIds: ["9998"],
      linkedGithubUserIds: new Set(["1001", "1002"]), allowSelfApproval, excludedGithubUserIds,
    });
    // Self-approval on: any account with write access counts, linked or not, but never one linked to an Auditor.
    expect(input([review("1002", "aud")], true, excluded)).toEqual({ approved: false, reason: "no_write" });
    expect(input([review("1002", "aud")], true, undefined)).toMatchObject({ approved: true });
    expect(input([review("1002", "aud"), review("1001", "mem")], true, excluded)).toMatchObject({ approved: true, by: { githubUserId: "1001" } });
    expect(input([review("7777", "outsider")], true, excluded)).toMatchObject({ approved: true });
    // Off: the same.
    expect(input([review("1002", "aud")], false, excluded)).toEqual({ approved: false, reason: "no_write" });
  });

  it("the three places that count an approval pass the exclusion", () => {
    for (const file of ["merge.ts", "merge-tracking.ts"]) {
      const text = readFileSync(resolve(import.meta.dirname, "..", "..", "packages/broker/src/rovara-code", file), "utf8");
      const calls = text.split("humanApprovalOf({").length - 1;
      expect(text.split("excludedGithubUserIds: await nonWritersAmong(").length - 1, file).toBe(calls);
    }
  });

  it("an Auditor's approval alone leaves the merge gate closed when self-approval is off", async () => {
    const linked = await linkedAmong(deps, TEST_ORG, ["1002"]);
    const review = { githubUserId: "1002", login: "aud", state: "APPROVED", commitId: "h".repeat(40), userType: "User", submittedAt: "2026-10-31T00:00:00Z" };
    const result = humanApprovalOf({
      reviews: [review] as never, headSha: "h".repeat(40), syncedFrom: undefined, ciPassingOnHead: true, permissions: new Map([["aud", "write"]]),
      requesterGithubUserIds: ["9999"], linkedGithubUserIds: linked, allowSelfApproval: false,
    });
    expect(result).toEqual({ approved: false, reason: "none" });
  });
});
