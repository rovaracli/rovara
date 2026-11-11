// srv/needs-broker-ui-2, items 8 and 11: two read routes the maintainer and member screens use, held to the caller's LIVE role on the project.
//   GET /v1/app/projects/{p}/spend         `view_spend` on that project (a maintainer, or an org owner or admin): that project's totals and nothing else
//   GET /v1/app/projects/{p}/code-settings anyone who can see the project (any project role, or an org owner or admin): the merge rules, with no secret in them
// Company is the caller's own (the session's), never the request's. A caller with no role in the project reads the same 404 as a project that is not there.
import { describe, expect, it } from "vitest";
import { codeSettingsKey, personalCounter, projectMemberKey, projectRevisionKey, scopeKey, spendCounterKey, type OrgId } from "@agentx/contracts";
import { fakeModelAccess } from "../support/fake-model-access.js";
import { MAYA, OMAR, createDeveloperTaskBroker, seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { singleOrgIdForEnv } from "../../packages/contracts/src/org-node.js";

const MONTH = "2026-10";
const OTHER = singleOrgIdForEnv("another-company");
type World = Awaited<ReturnType<typeof world>>;
type Role = "maintainer" | "contributor" | "viewer";

async function world() {
  const access = fakeModelAccess();
  const t = await createDeveloperTaskBroker({ brokerExtra: { agents: {}, modelAccess: { access, proxyUrl: "http://internal-proxy.example.test:4000" }, cloud: true } });
  access.setMemberSpent(TEST_ORG, MAYA.developerId, 0);
  access.setOrgSpent(TEST_ORG, 0);
  // Omar administers the org. Maya is a plain member; her role on a project is whatever her grant row says (`grant`).
  seedMembership(t.db, OMAR.developerId, { orgId: TEST_ORG, role: "admin" });
  t.db.set({ ...projectRevisionKey(TEST_ORG, "secret", 1), entityType: "PROJECT_REVISION", name: "secret", definition: { name: "secret", revision: 1 } });
  const counter = (sk: string, spentUsd: number, committedUsd = spentUsd) => t.db.set({ ...spendCounterKey(TEST_ORG, MONTH, sk), entityType: "SPEND_COUNTER", orgId: TEST_ORG, spentUsd, committedUsd });
  counter("ORG", 2.7);
  counter(scopeKey({ kind: "project", project: "payments" }), 2);
  counter(scopeKey({ kind: "project", project: "secret" }), 0.7);
  counter(scopeKey({ kind: "member", developerId: MAYA.developerId }), 1.2);
  counter(personalCounter(MAYA.developerId), 0);
  const grant = (project: string, role: Role | undefined) => {
    const key = projectMemberKey(TEST_ORG, MAYA.developerId, project);
    if (role === undefined) { t.db.delete(key); return; }
    t.db.set({ ...key, entityType: "MEMBERSHIP", ownerKey: MAYA.developerId, projectName: project, role: role === "viewer" ? "viewer" : "developer", projectRole: role });
  };
  const spend = (who: typeof MAYA, project: string) => t.dev(who, "GET", `/v1/app/projects/${project}/spend?month=${MONTH}`);
  const settings = (who: typeof MAYA, project: string) => t.dev(who, "GET", `/v1/app/projects/${project}/code-settings`);
  return { ...t, grant, spend, settings };
}
const fresh = async (): Promise<World> => world();

describe("a project's spend, for the people who may see it", () => {
  it("answers a maintainer of that project with that project's totals only: no other project, no company total, no person", async () => {
    const t = await fresh();
    t.grant("payments", "maintainer");
    const reply = await t.spend(MAYA, "payments");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    const { requestId: _requestId, ...answer } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id
    // Exactly the project's own figures (positive control: they are the project's 2, not the company's 2.7 or secret's 0.7).
    expect(answer).toEqual({ month: MONTH, project: "payments", spentUsd: 2, committedUsd: 2 });
    const text = JSON.stringify(reply.body);
    for (const leak of ["byMember", "byProject", "byAgent", "totalUsd", "secret", MAYA.developerId, OMAR.developerId, "2.7", "1.2"]) expect(text, leak).not.toContain(leak);
  });

  it("refuses a contributor and a viewer of the project with 403, and answers the project not found to a member with no role there and to a maintainer of another project", async () => {
    const t = await fresh();
    for (const role of ["contributor", "viewer"] as const) {
      t.grant("payments", role);
      const reply = await t.spend(MAYA, "payments");
      expect(reply.status, role).toBe(403);
      expect(JSON.stringify(reply.body), role).not.toMatch(/spentUsd|committedUsd/);
    }
    // No role in the project at all (a member): the project does not show to them, as with a project that is not there.
    expect((await t.spend(MAYA, "secret")).status).toBe(404);
    expect((await t.spend(MAYA, "no-such-project")).status).toBe(404);
    // A maintainer of payments reads payments, and no other project's figures.
    t.grant("payments", "maintainer");
    expect((await t.spend(MAYA, "payments")).status).toBe(200);
    const other = await t.spend(MAYA, "secret");
    expect(other.status).toBe(404);
    expect(JSON.stringify(other.body)).not.toMatch(/spentUsd|0\.7/);
    // And the other way: a maintainer of secret reads secret's figures only, not payments'.
    t.grant("payments", "contributor");
    t.grant("secret", "maintainer");
    const secret = await t.spend(MAYA, "secret");
    expect(secret.status).toBe(200);
    expect(secret.body).toMatchObject({ project: "secret", spentUsd: 0.7 });
    expect((await t.spend(MAYA, "payments")).status).toBe(403);
  });

  it("reads the role now: a maintainer who is demoted or removed loses it on the next request", async () => {
    const t = await fresh();
    t.grant("secret", "maintainer");
    expect((await t.spend(MAYA, "secret")).status).toBe(200);
    t.grant("secret", "contributor");
    expect((await t.spend(MAYA, "secret")).status).toBe(403);
    t.grant("secret", "maintainer");
    expect((await t.spend(MAYA, "secret")).status).toBe(200);
    t.grant("secret", undefined);
    expect((await t.spend(MAYA, "secret")).status).toBe(404);
  });

  it("answers an org admin for any project of their own company, and nobody for another company's", async () => {
    const t = await fresh();
    const admin = await t.spend(OMAR, "secret");
    expect(admin.status, JSON.stringify(admin.body)).toBe(200);
    expect(admin.body).toMatchObject({ project: "secret", spentUsd: 0.7 });
    // The same table read as the admin of another company: that company has no such project, and the company comes from the session.
    const elsewhere = await createDeveloperTaskBroker({
      brokerExtra: { agents: {}, modelAccess: { access: fakeModelAccess(), proxyUrl: "http://internal-proxy.example.test:4000" }, cloud: true },
      orgResolver: async () => OTHER as OrgId,
    });
    seedMembership(elsewhere.db, OMAR.developerId, { orgId: OTHER as OrgId, role: "admin" });
    for (const item of t.db.find((candidate) => String(candidate.pk).startsWith(`ORG#${TEST_ORG}#`))) elsewhere.db.set(item);
    // That company has no such counters: whatever it answers holds none of ours (the figures come from the session's company, never from the request).
    const foreign = await elsewhere.dev(OMAR, "GET", `/v1/app/projects/payments/spend?month=${MONTH}`);
    expect(JSON.stringify(foreign.body)).not.toMatch(/"spentUsd":2\b|"committedUsd":2\b/);
    if (foreign.status === 200) expect(foreign.body).toMatchObject({ spentUsd: 0, committedUsd: 0 });
  });
});

describe("a project's merge rules, for the people who may see the project", () => {
  const stored = (t: World, extra: Record<string, unknown> = {}) => t.db.set({
    ...codeSettingsKey(TEST_ORG, "payments"), entityType: "CODE_SETTINGS", orgId: TEST_ORG, allowSelfApproval: true, mergeMethod: "merge", codeReviewers: ["alice", "acme/core"], revision: 3, ...extra,
  });

  it("answers any project role and an org admin with the four settings and nothing else", async () => {
    const t = await fresh();
    // A field that is not one of the settings, even a secret-looking one on the stored item, never reaches the answer.
    stored(t, { webhookToken: "not-a-real-token", notes: "internal" });
    for (const role of ["maintainer", "contributor", "viewer"] as const) {
      t.grant("payments", role);
      const reply = await t.settings(MAYA, "payments");
      expect(reply.status, role).toBe(200);
      const { requestId: _requestId, ...answer } = reply.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id
      expect(answer, role).toEqual({ settings: { allowSelfApproval: true, mergeMethod: "merge", codeReviewers: ["alice", "acme/core"], revision: 3 } });
      expect(JSON.stringify(reply.body), role).not.toMatch(/not-a-real-token|webhookToken|internal/);
    }
    // An org admin with no grant reads any project of their own company.
    const admin = await t.settings(OMAR, "payments");
    expect(admin.status).toBe(200);
    expect(admin.body).toMatchObject({ settings: { allowSelfApproval: true, mergeMethod: "merge", revision: 3 } });
    expect((await t.settings(OMAR, "secret")).status).toBe(200);
  });

  it("answers the defaults for a project with none, and the project not found to a member with no role there, with no setting leaked", async () => {
    const t = await fresh();
    t.grant("payments", "viewer");
    expect((await t.settings(MAYA, "payments")).body).toMatchObject({ settings: { allowSelfApproval: false, mergeMethod: "squash", codeReviewers: [], revision: 0 } });
    stored(t);
    // No role on the project: secret (nobody's Slack channel reaches it) reads the same as a project that is not there, and says nothing of its settings.
    t.db.set({ ...codeSettingsKey(TEST_ORG, "secret"), entityType: "CODE_SETTINGS", orgId: TEST_ORG, allowSelfApproval: true, mergeMethod: "merge", codeReviewers: ["hidden-reviewer"], revision: 9 });
    const refused = await t.settings(MAYA, "secret");
    expect(refused.status).toBe(404);
    expect(JSON.stringify(refused.body)).not.toMatch(/hidden-reviewer|mergeMethod/);
    expect((await t.settings(MAYA, "no-such-project")).status).toBe(404);
    // A role on payments does not reach secret.
    t.grant("payments", "maintainer");
    expect((await t.settings(MAYA, "secret")).status).toBe(404);
  });

  it("reads the role now, and the company from the session", async () => {
    const t = await fresh();
    stored(t);
    t.db.set({ ...codeSettingsKey(TEST_ORG, "secret"), entityType: "CODE_SETTINGS", orgId: TEST_ORG, allowSelfApproval: true, mergeMethod: "merge", codeReviewers: ["hidden-reviewer"], revision: 9 });
    t.grant("secret", "viewer");
    expect((await t.settings(MAYA, "secret")).status).toBe(200);
    t.grant("secret", undefined);
    expect((await t.settings(MAYA, "secret")).status).toBe(404);
    const elsewhere = await createDeveloperTaskBroker({
      brokerExtra: { agents: {}, modelAccess: { access: fakeModelAccess(), proxyUrl: "http://internal-proxy.example.test:4000" }, cloud: true },
      orgResolver: async () => OTHER as OrgId,
    });
    seedMembership(elsewhere.db, OMAR.developerId, { orgId: OTHER as OrgId, role: "admin" });
    for (const item of t.db.find((candidate) => String(candidate.pk).startsWith(`ORG#${TEST_ORG}#`))) elsewhere.db.set(item);
    // The other company's admin reads the settings of THEIR company's project of that name (the defaults there), never ours.
    const foreign = await elsewhere.dev(OMAR, "GET", "/v1/app/projects/secret/code-settings");
    expect(JSON.stringify(foreign.body)).not.toMatch(/hidden-reviewer/);
    if (foreign.status === 200) expect(foreign.body).toMatchObject({ settings: { revision: 0 } });
  });
});
