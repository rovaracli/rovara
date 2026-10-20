// Task 23 (ruling R55): each cloud org has an allowed GitHub owner that only an operator sets, with
// PUT /v1/admin/org/github-owner and `agentx admin org github-owner set`.
import { beforeAll, describe, expect, it } from "vitest";
import { GithubOwnerSchema, orgMetaKey } from "../../packages/contracts/src/index.js";
import { adminCall, createAdminBroker } from "../support/admin-broker.js";
import { seedMembership } from "../support/developer-task-broker.js";
import { TEST_ORG } from "../support/orgs.js";
import { loadSlackBroker } from "../support/slack-broker.js";

const OTHER_ORG = "org_bbbbbbbbbbbbbbbbbbbb";

describe("GithubOwnerSchema", () => {
  it("lower-cases a login and refuses anything that is not one", () => {
    expect(GithubOwnerSchema.parse(" Acme-Corp ")).toBe("acme-corp");
    for (const bad of ["", "-acme", "acme-", "ac--me", "acme/web", "a b", "x".repeat(40), "https://github.com/acme"]) {
      expect(GithubOwnerSchema.safeParse(bad).success, bad).toBe(false);
    }
  });
});

describe("PUT /v1/admin/org/github-owner", () => {
  beforeAll(loadSlackBroker);

  const put = (handler: Parameters<typeof adminCall>[0], body: unknown, admin = true) => adminCall(handler, { method: "PUT", path: "/v1/admin/org/github-owner", body, admin });

  it("lets an operator set an org's allowed GitHub owner, stored in lower case, and change it again", async () => {
    const { handler, db } = await createAdminBroker({ extra: { cloud: true } });
    seedMembership(db, "dev1", { orgId: TEST_ORG, role: "owner" });
    expect(await put(handler, { orgId: TEST_ORG, githubOwner: "Acme-Corp" })).toMatchObject({ status: 200, body: { org: { orgId: TEST_ORG, githubOwner: "acme-corp" } } });
    expect(db.get(orgMetaKey(TEST_ORG).pk, orgMetaKey(TEST_ORG).sk)).toMatchObject({ orgId: TEST_ORG, name: "staging", githubOwner: "acme-corp" });
    expect((await put(handler, { orgId: TEST_ORG, githubOwner: "other-co" })).status).toBe(200);
    expect(db.get(orgMetaKey(TEST_ORG).pk, orgMetaKey(TEST_ORG).sk)).toMatchObject({ githubOwner: "other-co" });
  });

  it("refuses a caller without the administrator claim with 403 and writes nothing", async () => {
    const { handler, db } = await createAdminBroker({ extra: { cloud: true } });
    seedMembership(db, "dev1", { orgId: TEST_ORG, role: "owner" });
    expect(await put(handler, { orgId: TEST_ORG, githubOwner: "acme" }, false)).toMatchObject({ status: 403, body: { error: { code: "FORBIDDEN" } } });
    expect((db.get(orgMetaKey(TEST_ORG).pk, orgMetaKey(TEST_ORG).sk) as { githubOwner?: string }).githubOwner).toBeUndefined();
  });

  it("refuses a non-cloud install with CONFIG_INVALID, which has one org and uses the admin project add", async () => {
    const { handler, db } = await createAdminBroker();
    seedMembership(db, "dev1", { orgId: TEST_ORG, role: "owner" });
    const refused = await put(handler, { orgId: TEST_ORG, githubOwner: "acme" });
    expect(refused).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    expect((refused.body.error as { message: string }).message).toContain("agentx project add");
    expect((db.get(orgMetaKey(TEST_ORG).pk, orgMetaKey(TEST_ORG).sk) as { githubOwner?: string }).githubOwner).toBeUndefined();
  });

  it("answers NOT_FOUND for an unknown org and creates no org record", async () => {
    const { handler, db } = await createAdminBroker({ extra: { cloud: true } });
    expect(await put(handler, { orgId: OTHER_ORG, githubOwner: "acme" })).toMatchObject({ status: 404, body: { error: { code: "NOT_FOUND" } } });
    expect(db.get(orgMetaKey(OTHER_ORG).pk, orgMetaKey(OTHER_ORG).sk)).toBeUndefined();
  });

  it.each([
    ["no orgId", { githubOwner: "acme" }],
    ["an orgId that is not one", { orgId: "acme", githubOwner: "acme" }],
    ["no owner", { orgId: TEST_ORG }],
    ["a repository instead of an owner", { orgId: TEST_ORG, githubOwner: "acme/web" }],
    ["an extra field", { orgId: TEST_ORG, githubOwner: "acme", plan: "team" }],
  ])("refuses %s with 400 CONFIG_INVALID", async (_name, body) => {
    const { handler, db } = await createAdminBroker({ extra: { cloud: true } });
    seedMembership(db, "dev1", { orgId: TEST_ORG, role: "owner" });
    expect(await put(handler, body)).toMatchObject({ status: 400, body: { error: { code: "CONFIG_INVALID" } } });
    expect((db.get(orgMetaKey(TEST_ORG).pk, orgMetaKey(TEST_ORG).sk) as { githubOwner?: string }).githubOwner).toBeUndefined();
  });
});
