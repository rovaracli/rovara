import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { editionPolicy, singleOrgIdForEnv, slackTeamOrgKey } from "@agentx/contracts";
import { stopSlackThreadTask } from "../../packages/broker/src/aws/broker/slack-workflow-events.js";
import { answerSlackChatGpt } from "../../packages/broker/src/aws/slack-chatgpt.js";
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
    const orgs = new OrgStore({ documentClient: db, tableName: "state", now: () => NOW });
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
    // One rule for the requester (requireSlackRequesterWriterRole): the company sign-in's allowance is asked first; the person's live role (I2) is read after it. The workflow caller and the
    // service route's role both go through it, and the caller carries that role.
    expect(wiring).toMatch(/await requireSlackAllowedByEdition\(dependencies, userId, orgId\);[\s\S]*?liveWriterRole\(/);
    expect(wiring).toMatch(/const role = await requireSlackRequesterWriterRole\(dependencies, userId, teamOrg\);\s*return requireWriterCaller\(\{ \.\.\.slackWorkflowCaller/);
    const preparation = readFileSync(new URL("../../packages/broker/src/aws/broker/workspace-preparation.ts", import.meta.url), "utf8");
    expect(preparation).toMatch(/await requireSlackAllowedByEdition\(dependencies, context\.requester\.userId, orgId\);/);
    expect(preparation).toMatch(/await requireSlackRequesterWriterRole\(dependencies, userId, orgId, \{ allowUnlinked: true \}\)/);
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

describe("every Slack action asks (fix round 2)", () => {
  async function stopWorld(options: { allowed: boolean; shared?: boolean; swebench?: boolean }) {
    const db = new FakeDynamoDb();
    const orgs = new OrgStore({ documentClient: db, tableName: "state", now: () => Date.now() });
    await orgs.ensureOrg(TEST_ORG, "staging");
    db.set({ ...slackTeamOrgKey(TEAM), orgId: TEST_ORG });
    const developerId = "d".repeat(64);
    await orgs.addMember({ orgId: TEST_ORG, developerId, role: "member" });
    const sso = ssoStoresFor({ documentClient: db, tableName: "state", policy: enterprise })!;
    if (options.allowed) await sso.slack.record(TEST_ORG, SLACK_USER, developerId, Math.floor(Date.now() / 1000) + 3600);
    const sentinel = vi.fn(async () => { throw new Error("a branch of the stop ran"); });
    const dependencies = {
      documentClient: db, tableName: "state", editionPolicy: enterprise, sso, orgResolver: async () => TEST_ORG,
      developer: { slackTeamId: TEAM, signInTableName: "signin" },
      ...(options.swebench === true ? { swebench: { deployment: sentinel, startExecution: sentinel } } : {}),
    } as never;
    return { dependencies, sentinel };
  }
  const event = { source: "agentx.slack-ingress", action: "stop-task", thread: { teamId: TEAM, channelId: "C0123456789", threadTs: "1695500000.000001" }, userId: SLACK_USER } as never;

  it.each([
    ["a SWE-bench run's thread", { swebench: true }],
    ["a shared (legacy teammate) thread", { shared: true }],
    ["a plain thread", {}],
  ])("a stop from %s by a person the company sign-in no longer allows is refused before any branch runs", async (_name, options) => {
    const w = await stopWorld({ allowed: false, ...options });
    await expect(stopSlackThreadTask(w.dependencies, event)).rejects.toThrow(SLACK_NOT_ALLOWED_MESSAGE);
    expect(w.sentinel).not.toHaveBeenCalled();
  });

  it("an allowed person gets past the gate (and meets the next check, here the unbound channel)", async () => {
    const w = await stopWorld({ allowed: true });
    await expect(stopSlackThreadTask(w.dependencies, event)).rejects.not.toThrow(SLACK_NOT_ALLOWED_MESSAGE);
  });

  it("the ChatGPT commands from Slack ask first, and the handler hands them the gate", async () => {
    const chatgpt = { start: vi.fn(), finish: vi.fn(), disconnect: vi.fn(), view: vi.fn() };
    const allow = vi.fn(async () => { throw new Error(SLACK_NOT_ALLOWED_MESSAGE); });
    for (const command of ["connect", "status", "disconnect"] as const) {
      await expect(answerSlackChatGpt({ chatgpt: chatgpt as never, allow }, { source: "agentx.slack-ingress", action: "chatgpt-command", command, teamId: TEAM, userId: SLACK_USER })).rejects.toThrow(SLACK_NOT_ALLOWED_MESSAGE);
    }
    await expect(answerSlackChatGpt({ chatgpt: chatgpt as never, allow }, { source: "agentx.slack-ingress", action: "chatgpt-finish", callbackUrl: "https://x.example.test/cb", teamId: TEAM, userId: SLACK_USER })).rejects.toThrow(SLACK_NOT_ALLOWED_MESSAGE);
    expect(Object.values(chatgpt).every((fn) => fn.mock.calls.length === 0)).toBe(true);
    const handler = readFileSync(new URL("../../packages/broker/src/aws/broker/handler.ts", import.meta.url), "utf8");
    expect(handler).toMatch(/allow: async \(userId: string, teamId: string\) => \{ if \(dependencies\.editionPolicy\?\.features\.sso === true\) await requireSlackAllowedByEdition\(dependencies, userId, await slackTeamOrg\(dependencies, teamId\)\); \},/);
  });
});
