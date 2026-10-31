import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { editionPolicy, singleOrgIdForEnv } from "@agentx/contracts";
import { requireSlackAllowedByEdition } from "../../packages/broker/src/aws/broker/dependency-wiring.js";
import { dynamoSlackAllowanceStore, SLACK_NOT_ALLOWED_MESSAGE } from "../../packages/broker/src/developer/slack-allowance.js";
import { ssoStoresFor } from "../../packages/broker/src/developer/sso-sign-in.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { OIDC_ISSUER, T0, TEAM, authorizeQuery, httpEvent, identityHarness } from "../support/developer-fakes.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { ownerKeyForSubject } from "../../packages/broker/src/aws/lambda.js";
import { TEST_ORG } from "../support/orgs.js";

// Enterprise foundations I-6 (fix round 1): in Enterprise the Slack ingress acts only for a person the company sign-in still allows.

const enterprise = editionPolicy("enterprise");
const NOW = T0;
const SLACK_USER = "U0UNA00001";
const RULES = [{ id: "users", group: "rovara-users", orgRole: "member" as const, projectRoles: [] }];

describe("the Slack ingress", () => {
  async function broker(options: { policy?: typeof enterprise | undefined; allow?: { until: number } | "none"; member?: boolean }) {
    const db = new FakeDynamoDb();
    const orgs = new OrgStore({ documentClient: db as never, tableName: "state", now: () => NOW });
    await orgs.ensureOrg(TEST_ORG, "staging");
    const developerId = "d".repeat(64);
    if (options.member !== false) await orgs.addMember({ orgId: TEST_ORG, developerId, role: "member" });
    const sso = ssoStoresFor({ documentClient: db, tableName: "state", policy: enterprise })!;
    if (options.allow !== undefined && options.allow !== "none") await sso.slack.record(TEST_ORG, SLACK_USER, developerId, options.allow.until);
    const dependencies = { documentClient: db, tableName: "state", ...(options.policy === undefined ? {} : { editionPolicy: options.policy }), sso } as never;
    return { check: () => requireSlackAllowedByEdition(dependencies, SLACK_USER, TEST_ORG) };
  }
  const refusal = async (check: () => Promise<void>) => check().then(() => undefined, (error: Error) => error.message);
  const later = Math.floor(Date.now() / 1000) + 3600;

  it("acts for a Slack user whose company sign-in is allowed and not over", async () => {
    expect(await refusal((await broker({ policy: enterprise, allow: { until: later } })).check)).toBeUndefined();
  });

  it("refuses a Slack user with no sign-in, one whose allowance is over, and one whose person is no longer a member", async () => {
    expect(await refusal((await broker({ policy: enterprise, allow: "none" })).check)).toContain(SLACK_NOT_ALLOWED_MESSAGE);
    expect(await refusal((await broker({ policy: enterprise, allow: { until: Math.floor(Date.now() / 1000) - 1 } })).check)).toContain(SLACK_NOT_ALLOWED_MESSAGE);
    expect(await refusal((await broker({ policy: enterprise, allow: { until: later }, member: false })).check)).toContain(SLACK_NOT_ALLOWED_MESSAGE);
  });

  it("changes nothing for Public and for an install with no edition", async () => {
    for (const policy of [editionPolicy("public"), undefined]) expect(await refusal((await broker({ policy, allow: "none" })).check), String(policy?.edition)).toBeUndefined();
  });

  it("Enterprise with no allowance store refuses everyone (fail closed)", async () => {
    await expect(requireSlackAllowedByEdition({ documentClient: new FakeDynamoDb(), tableName: "state", editionPolicy: enterprise } as never, SLACK_USER, TEST_ORG)).rejects.toThrow(SLACK_NOT_ALLOWED_MESSAGE);
  });

  it("both Slack entry points ask: the workflow caller and the service identity", () => {
    const wiring = readFileSync(new URL("../../packages/broker/src/aws/broker/dependency-wiring.ts", import.meta.url), "utf8");
    expect(wiring).toMatch(/await requireSlackAllowedByEdition\(dependencies, userId, orgId\);\n  return slackWorkflowCaller/);
    const preparation = readFileSync(new URL("../../packages/broker/src/aws/broker/workspace-preparation.ts", import.meta.url), "utf8");
    expect(preparation).toMatch(/await requireSlackAllowedByEdition\(dependencies, context\.requester\.userId, orgId\);/);
  });
});

describe("the allowance store", () => {
  it("records, expires and revokes", async () => {
    const store = dynamoSlackAllowanceStore({ documentClient: new FakeDynamoDb(), tableName: "state" });
    await store.record(TEST_ORG, SLACK_USER, "x".repeat(64), 100);
    expect(await store.allowedDeveloper(TEST_ORG, SLACK_USER, 99_000)).toBe("x".repeat(64));
    expect(await store.allowedDeveloper(TEST_ORG, SLACK_USER, 100_000)).toBeUndefined();
    await store.record(TEST_ORG, SLACK_USER, "x".repeat(64), 200);
    await store.revoke(TEST_ORG, SLACK_USER);
    expect(await store.allowedDeveloper(TEST_ORG, SLACK_USER, 1000)).toBeUndefined();
    expect(await store.allowedDeveloper(singleOrgIdForEnv("other"), SLACK_USER, 1000)).toBeUndefined();
  });
});

describe("the company sign-in keeps the Slack allowance in step", () => {
  it("records it at an allowed sign-in (until the session ends) and removes it at the next refused one", async () => {
    const capture = capturingAuditDeps();
    const h = identityHarness({
      oidc: {}, slack: false, editionPolicy: enterprise, sso: true, audit: capture,
      oidcUsers: [{ sub: "una", name: "Una", email: "una@example.test", email_verified: true, groups: ["rovara-users"] }],
      slackUsers: [{ userId: SLACK_USER, teamId: TEAM, name: "Una", email: "una@example.test", emailVerified: true }],
    });
    await h.orgs.ensureOrg(TEST_ORG, "staging");
    await h.deps.sso!.mappings.put(TEST_ORG, { claim: "groups", rules: RULES, updatedAt: "2026-10-31T00:00:00Z", updatedBy: "a".repeat(64) }, 0);
    const signIn = async (claims: object = {}) => {
      const started = await h.http(httpEvent("GET", authorizeQuery()));
      return h.http(httpEvent("GET", h.oidc.approve(started.headers.location!, "una", { claims })));
    };
    await signIn();
    const developerId = ownerKeyForSubject(OIDC_ISSUER, "una");
    expect(await h.deps.sso!.slack.allowedDeveloper(TEST_ORG, SLACK_USER, T0)).toBe(developerId);
    // Not for ever: the edition's cap.
    expect(await h.deps.sso!.slack.allowedDeveloper(TEST_ORG, SLACK_USER, T0 + 9 * 3_600_000)).toBeUndefined();
    // The person is taken out of the group: the next sign-in is refused and Slack stops at once.
    await signIn({ groups: ["somewhere-else"] });
    expect(await h.deps.sso!.slack.allowedDeveloper(TEST_ORG, SLACK_USER, T0)).toBeUndefined();
  });
});
