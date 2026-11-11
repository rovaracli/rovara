// Plan 3 Task 12a: org connections - contracts, org-tagged secrets through an STS-tagged role session, the stores
// and the per-org credential registry. The Secrets Manager and STS fake enforces the role's trust and permissions
// policies, so these tests prove isolation rather than assume it.
import { AssumeRoleCommand } from "@aws-sdk/client-sts";
import {
  CreateSecretCommand,
  DeleteSecretCommand,
  DescribeSecretCommand,
  GetSecretValueCommand,
  TagResourceCommand,
  UntagResourceCommand,
} from "@aws-sdk/client-secrets-manager";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CredentialUnavailable } from "@agentx/gateway";
import { orgCredentialRegistry } from "../../packages/broker/src/connections/registry.js";
import { HookSecretStore, OrgConnectionStore, connectionActorIds } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets, orgConnectorSecretName, orgHookSecretName, type SecretsClient } from "../../packages/broker/src/connections/org-secrets.js";
import { ConnectionSecretSchema, OrgConnectionSchema, connectionKey, connectionsKey, type OrgConnection } from "@rovara-code/contracts";
import type { OrgId } from "@rovara-code/contracts";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { loadSlackBroker } from "../support/slack-broker.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";
import { connectorSecretsPolicyStatements } from "../../infra/lib/connector-secrets-policy.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ENV = "staging";
const CON_A = "con_aaaaaaaaaaaaaaaaaaaa";
const CON_B = "con_bbbbbbbbbbbbbbbbbbbb";
const ALICE = "a".repeat(64);
const JIRA_EMAIL = "agentx-service@acme.com";
const LINEAR_KEY = "lin_api_SECRETKEYVALUE0123456789";
const START = Date.parse("2026-10-21T09:00:00.000Z");

const LINEAR: OrgConnection = { connectionId: CON_A, type: "linear", label: "Linear", access: "read" };
const JIRA: OrgConnection = { connectionId: CON_A, type: "jira", label: "Jira", access: "read_write", siteUrl: "https://acme.atlassian.net" };
const MCP: OrgConnection = { connectionId: CON_A, type: "mcp", label: "Sentry", access: "read", endpoint: "https://mcp.acme.dev/mcp", vendor: "Sentry" };

function setup() {
  const clock = { now: START };
  const fake = new FakeOrgSecrets({ env: ENV, now: () => clock.now });
  const db = new FakeDynamoDb();
  const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => clock.now });
  const deps = { documentClient: db, tableName: "T", env: ENV, secrets, now: () => clock.now };
  return { clock, fake, db, secrets, deps };
}

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string; name?: string }) => ({ code: error.code, name: error.name, message: error.message }));

describe("connection contracts", () => {
  it("accepts each connection type strictly and rejects stray fields", () => {
    expect(OrgConnectionSchema.parse(LINEAR)).toEqual(LINEAR);
    expect(OrgConnectionSchema.parse(JIRA)).toEqual(JIRA);
    expect(OrgConnectionSchema.parse({ ...MCP, auth: { header: "X-Api-Key", prefix: "" } })).toMatchObject({ type: "mcp" });
    expect(OrgConnectionSchema.safeParse({ ...LINEAR, apiKey: LINEAR_KEY }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...LINEAR, siteUrl: "https://acme.atlassian.net" }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...JIRA, siteUrl: "https://acme.atlassian.net.evil.example" }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...JIRA, siteUrl: "https://acme.atlassian.net/wiki" }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...MCP, endpoint: "http://mcp.acme.dev" }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...LINEAR, label: "" }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...LINEAR, label: "x".repeat(65) }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...LINEAR, label: "two\nlines" }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...LINEAR, access: "write" }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...LINEAR, connectionId: "con_short" }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...LINEAR, type: "asana" }).success).toBe(false);
  });

  it("holds one secret shape per type", () => {
    expect(ConnectionSecretSchema.safeParse({ apiKey: LINEAR_KEY }).success).toBe(true);
    expect(ConnectionSecretSchema.safeParse({ email: "svc@acme.com", apiToken: "t" }).success).toBe(true);
    // Jira Cloud needs the account email with the token (Basic auth), and the email cannot hold the ":" that splits them.
    expect(ConnectionSecretSchema.safeParse({ apiToken: "t" }).success).toBe(false);
    expect(ConnectionSecretSchema.safeParse({ email: "not-an-email", apiToken: "t" }).success).toBe(false);
    expect(ConnectionSecretSchema.safeParse({ email: "a:b@acme.com", apiToken: "t" }).success).toBe(false);
    expect(ConnectionSecretSchema.safeParse({ token: "t" }).success).toBe(true);
    expect(ConnectionSecretSchema.safeParse({ token: "t", apiKey: "k" }).success).toBe(false);
    expect(ConnectionSecretSchema.safeParse({ token: "has a\nline" }).success).toBe(false);
    expect(ConnectionSecretSchema.safeParse({ token: "" }).success).toBe(false);
  });

  it("keys a connection and the org's connection directory under the org", () => {
    expect(connectionKey(ORG_A, CON_A)).toEqual({ pk: `ORG#${ORG_A}#CONNECTION#${CON_A}`, sk: "META" });
    expect(connectionsKey(ORG_A, CON_A)).toEqual({ pk: `ORG#${ORG_A}#CONNECTIONS`, sk: CON_A });
    expect(connectionKey(ORG_B, CON_A).pk).not.toBe(connectionKey(ORG_A, CON_A).pk);
  });
});

describe("OrgSecrets", () => {
  const nameA = (id = CON_A) => orgConnectorSecretName(ENV, ORG_A, id);

  it("refuses another org's secret name before any STS or Secrets Manager call", async () => {
    const { fake, secrets } = setup();
    const refusal = await code(secrets.read(ORG_B, nameA("con_x")));
    expect(refusal?.code).toBe("FORBIDDEN");
    expect(await code(secrets.read(ORG_B, orgHookSecretName(ENV, ORG_A, "hok_x")))).toMatchObject({ code: "FORBIDDEN" });
    expect(await code(secrets.put(ORG_B, nameA(), "v"))).toMatchObject({ code: "FORBIDDEN" });
    expect(await code(secrets.scheduleDelete(ORG_B, nameA()))).toMatchObject({ code: "FORBIDDEN" });
    expect(fake.calls).toEqual([]);
  });

  it("refuses names outside the two org paths, other environments and deeper paths", async () => {
    const { fake, secrets } = setup();
    for (const name of [
      "agentx/staging/connectors/shared", `agentx/prod/org-connectors/${ORG_A}/con_x`, `agentx/staging/org-sources/${ORG_A}/src_x`,
      `agentx/staging/org-connectors/${ORG_A}`, `agentx/staging/org-connectors/${ORG_A}/`, `agentx/staging/org-connectors/${ORG_A}/a/b`,
      `agentx/staging/org-connectors/${ORG_A}/..`, `agentx/staging/org-connectors/${ORG_A}x/con_x`, `arn:aws:secretsmanager:us-west-2:1:secret:${nameA()}`,
    ]) {
      expect(await code(secrets.read(ORG_A, name)), name).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("refuses an org id that fails OrgIdSchema before AssumeRole", async () => {
    const { fake, secrets } = setup();
    for (const bad of ["org_*", `org_${"a".repeat(21)}`, "org_a/b", "ORG_AAAAAAAAAAAAAAAAAAAA", `org_${"*".repeat(20)}`, "", "org_aaaaaaaaaaaaaaaaaaa"]) {
      expect(await code(secrets.read(bad, `agentx/staging/org-connectors/${bad}/con_x`)), bad).toMatchObject({ code: "FORBIDDEN" });
      expect(await code(secrets.put(bad, `agentx/staging/org-connectors/${bad}/con_x`, "v")), bad).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(fake.calls).toEqual([]);
  });

  it("refuses a session tagged for org B reading an org A secret that sits under a B-shaped name", async () => {
    const { fake, secrets } = setup();
    const trap = orgConnectorSecretName(ENV, ORG_B, "con_trap");
    fake.seed(trap, "A-SECRET", { "rovara:org": ORG_A });
    expect(await code(secrets.read(ORG_B, trap))).toMatchObject({ code: "FORBIDDEN" });
    expect(fake.calls.filter((call) => call.service === "secretsmanager")).toEqual([{ service: "secretsmanager", action: "GetSecretValue", sessionOrg: ORG_B, name: trap }]);
    // And the same through a raw client: the role denies it, whatever OrgSecrets checks.
    const client = await fake.client(ORG_B);
    await expect(client.send(new GetSecretValueCommand({ SecretId: trap }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(client.send(new GetSecretValueCommand({ SecretId: nameA() }))).rejects.toMatchObject({ name: "AccessDeniedException" });
  });

  it("reads back what it put, through one session per org", async () => {
    const { fake, secrets } = setup();
    await secrets.put(ORG_A, nameA(), "value-1");
    expect(await secrets.read(ORG_A, nameA())).toBe("value-1");
    expect(fake.calls.filter((call) => call.service === "sts")).toHaveLength(1);
    await secrets.put(ORG_B, orgConnectorSecretName(ENV, ORG_B, CON_B), "value-b");
    expect(fake.calls.filter((call) => call.service === "sts")).toHaveLength(2);
    expect(await secrets.read(ORG_B, orgConnectorSecretName(ENV, ORG_B, CON_B))).toBe("value-b");
    // B cannot see A's through its own session, A's value is untouched.
    expect(fake.stored(nameA())?.value).toBe("value-1");
  });

  it("creates a new secret with the org tag and makes a new version of an existing one, never calling TagResource or UntagResource", async () => {
    const { fake, secrets } = setup();
    await secrets.put(ORG_A, nameA(), "one");
    expect(fake.stored(nameA())).toMatchObject({ value: "one", tags: { "rovara:org": ORG_A }, versions: 1 });
    await secrets.put(ORG_A, nameA(), "two");
    expect(fake.stored(nameA())).toMatchObject({ value: "two", tags: { "rovara:org": ORG_A }, versions: 2 });
    const hook = orgHookSecretName(ENV, ORG_A, "hok_one");
    await secrets.put(ORG_A, hook, "h");
    expect(fake.stored(hook)?.tags).toEqual({ "rovara:org": ORG_A });
    const actions = fake.calls.filter((call) => call.service === "secretsmanager").map((call) => call.action);
    expect(actions).toEqual(["CreateSecret", "CreateSecret", "PutSecretValue", "CreateSecret"]);
    expect(actions).not.toContain("TagResource");
    expect(actions).not.toContain("UntagResource");
  });

  it("reads a secret Secrets Manager cannot find as undefined, and any other failure as a refusal that names no value", async () => {
    const failing = (name: string): SecretsClient => ({ send: () => Promise.reject(Object.assign(new Error(`${LINEAR_KEY} detail`), { name })) });
    const { fake } = setup();
    const using = (client: SecretsClient) => new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: () => client });
    expect(await using(failing("ResourceNotFoundException")).read(ORG_A, nameA())).toBeUndefined();
    const denied = await code(using(failing("AccessDeniedException")).read(ORG_A, nameA()));
    expect(denied).toMatchObject({ code: "FORBIDDEN" });
    const broken = await code(using(failing("ThrottlingException")).read(ORG_A, nameA()));
    expect(broken).toMatchObject({ code: "RUNTIME_UNAVAILABLE" });
    expect(JSON.stringify([denied, broken])).not.toContain(LINEAR_KEY);
  });

  it("schedules deletion with a recovery window of 7 days by default", async () => {
    const { fake, secrets, clock } = setup();
    await secrets.put(ORG_A, nameA(), "v");
    await secrets.scheduleDelete(ORG_A, nameA());
    expect(fake.stored(nameA())?.deleteAt).toBe(clock.now + 7 * 86_400_000);
    await secrets.put(ORG_A, nameA("con_two"), "v");
    await secrets.scheduleDelete(ORG_A, nameA("con_two"), 30);
    expect(fake.stored(nameA("con_two"))?.deleteAt).toBe(clock.now + 30 * 86_400_000);
  });

  it("keeps a session until 60 seconds before it expires, then assumes the role again", async () => {
    const { fake, secrets, clock } = setup();
    await secrets.put(ORG_A, nameA(), "v");
    clock.now += 839_000;
    await secrets.read(ORG_A, nameA());
    expect(fake.calls.filter((call) => call.service === "sts")).toHaveLength(1);
    clock.now += 2_000;
    await secrets.read(ORG_A, nameA());
    expect(fake.calls.filter((call) => call.service === "sts")).toHaveLength(2);
  });

  it("assumes the role once for concurrent first calls", async () => {
    const { fake, secrets } = setup();
    await Promise.all([secrets.put(ORG_A, nameA(), "a"), secrets.put(ORG_A, nameA("con_two"), "b"), secrets.put(ORG_A, nameA("con_three"), "c")]);
    expect(fake.calls.filter((call) => call.service === "sts")).toHaveLength(1);
  });

  it("assumes the role with the org tag, a 900 second duration and no other tag", async () => {
    const { secrets, fake } = setup();
    const send = vi.spyOn(fake.sts, "send");
    await secrets.put(ORG_A, nameA(), "v");
    const input = send.mock.calls[0]![0].input;
    expect(input).toMatchObject({ RoleArn: FAKE_CONNECTOR_ROLE_ARN, DurationSeconds: 900, Tags: [{ Key: "rovara:org", Value: ORG_A }] });
    // CloudTrail shows which org a session served; the name stays within AWS's 2-64 characters of [\w+=,.@-].
    expect(input.RoleSessionName).toBe(`org-${ORG_A}`);
    expect(input.RoleSessionName).toMatch(/^[\w+=,.@-]{2,64}$/);
    expect(input.TransitiveTagKeys).toBeUndefined();
  });

  it("starts a new session when AWS says the old one expired", async () => {
    const { fake, secrets, clock } = setup();
    await secrets.put(ORG_A, nameA(), "v");
    // The cache believes the session is good for another 10 minutes, but AWS has expired it.
    const sessions = (fake as unknown as { sessions: Map<string, { expiresAt: number }> }).sessions;
    for (const session of sessions.values()) session.expiresAt = clock.now - 1;
    expect(await secrets.read(ORG_A, nameA())).toBe("v");
    expect(fake.calls.filter((call) => call.service === "sts")).toHaveLength(2);
  });

  it("never logs a value and never puts one in an error", async () => {
    const { fake, secrets } = setup();
    const lines: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); }));
    try {
      await secrets.put(ORG_A, nameA(), LINEAR_KEY);
      await secrets.read(ORG_A, nameA());
      const refusal = await code(secrets.put(ORG_B, nameA(), LINEAR_KEY));
      expect(refusal?.message ?? "").not.toContain(LINEAR_KEY);
      // A denial from AWS: org A's session writes under a B-shaped name.
      fake.seed(orgConnectorSecretName(ENV, ORG_B, "con_x"), "x", { "rovara:org": ORG_B });
      const denied = await code(secrets.put(ORG_B, orgConnectorSecretName(ENV, ORG_B, "con_x"), LINEAR_KEY));
      expect(JSON.stringify(denied) ?? "").not.toContain(LINEAR_KEY);
    } finally {
      spies.forEach((spy) => spy.mockRestore());
    }
    expect(lines.join("\n")).not.toContain(LINEAR_KEY);
  });
});

describe("the role's trust and permissions as the fake enforces them", () => {
  it("refuses AssumeRole without the org tag, with a second tag key, or with an id of the wrong length", async () => {
    const { fake } = setup();
    const assume = (tags: Array<{ Key: string; Value: string }> | undefined) => fake.sts.send(new AssumeRoleCommand({ RoleArn: FAKE_CONNECTOR_ROLE_ARN, RoleSessionName: "t", DurationSeconds: 900, ...(tags === undefined ? {} : { Tags: tags }) }));
    await expect(assume(undefined)).rejects.toMatchObject({ name: "AccessDenied" });
    await expect(assume([{ Key: "other", Value: ORG_A }])).rejects.toMatchObject({ name: "AccessDenied" });
    await expect(assume([{ Key: "rovara:org", Value: ORG_A }, { Key: "extra", Value: "x" }])).rejects.toMatchObject({ name: "AccessDenied" });
    await expect(assume([{ Key: "rovara:org", Value: "org_*" }])).rejects.toMatchObject({ name: "AccessDenied" });
    await expect(assume([{ Key: "rovara:org", Value: `org_${"a".repeat(21)}` }])).rejects.toMatchObject({ name: "AccessDenied" });
    await expect(assume([{ Key: "rovara:org", Value: `team_${"a".repeat(19)}` }])).rejects.toMatchObject({ name: "AccessDenied" });
    await expect(assume([{ Key: "rovara:org", Value: ORG_A }])).resolves.toMatchObject({ Credentials: { AccessKeyId: expect.stringContaining("ASIA") as string } });
  });

  it("allows CreateSecret with TagResource together with the org tag and refuses every variation", async () => {
    const { fake } = setup();
    const a = await fake.client(ORG_A);
    const name = orgConnectorSecretName(ENV, ORG_A, "con_new");
    // The tag of another org, a second key, no tags, and a name outside the session's org path.
    await expect(a.send(new CreateSecretCommand({ Name: name, SecretString: "v", Tags: [{ Key: "rovara:org", Value: ORG_B }] }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(a.send(new CreateSecretCommand({ Name: name, SecretString: "v", Tags: [{ Key: "rovara:org", Value: ORG_A }, { Key: "extra", Value: "x" }] }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(a.send(new CreateSecretCommand({ Name: name, SecretString: "v" }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(a.send(new CreateSecretCommand({ Name: orgConnectorSecretName(ENV, ORG_B, "con_new"), SecretString: "v", Tags: [{ Key: "rovara:org", Value: ORG_A }] }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(a.send(new CreateSecretCommand({ Name: "agentx/staging/connectors/elsewhere", SecretString: "v", Tags: [{ Key: "rovara:org", Value: ORG_A }] }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(fake.secrets.size).toBe(0);
    await expect(a.send(new CreateSecretCommand({ Name: name, SecretString: "v", Tags: [{ Key: "rovara:org", Value: ORG_A }] }))).resolves.toBeDefined();
    expect(fake.stored(name)?.tags).toEqual({ "rovara:org": ORG_A });
  });

  it("refuses a TagResource that sets another org's value, a retag of another org's secret and any UntagResource", async () => {
    const { fake } = setup();
    const a = await fake.client(ORG_A);
    const name = orgConnectorSecretName(ENV, ORG_A, "con_one");
    await a.send(new CreateSecretCommand({ Name: name, SecretString: "v", Tags: [{ Key: "rovara:org", Value: ORG_A }] }));
    await expect(a.send(new TagResourceCommand({ SecretId: name, Tags: [{ Key: "rovara:org", Value: ORG_B }] }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(a.send(new TagResourceCommand({ SecretId: name, Tags: [{ Key: "rovara:org", Value: ORG_A }, { Key: "extra", Value: "x" }] }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(a.send(new UntagResourceCommand({ SecretId: name, TagKeys: ["rovara:org"] }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    const b = await fake.client(ORG_B);
    await expect(b.send(new TagResourceCommand({ SecretId: name, Tags: [{ Key: "rovara:org", Value: ORG_B }] }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(b.send(new UntagResourceCommand({ SecretId: name, TagKeys: ["rovara:org"] }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(fake.stored(name)?.tags).toEqual({ "rovara:org": ORG_A });
  });

  it("refuses a delete that skips the recovery window, and a delete with one (the review's M2: a bug must not make a removal unrecoverable)", async () => {
    const { fake } = setup();
    const name = orgConnectorSecretName(ENV, ORG_A, "con_force");
    fake.seed(name, "v", { "rovara:org": ORG_A });
    const a = await fake.client(ORG_A);
    await expect(a.send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    expect(fake.stored(name)?.deleteAt).toBeUndefined();
    await a.send(new DeleteSecretCommand({ SecretId: name, RecoveryWindowInDays: 7 }));
    expect(fake.stored(name)?.deleteAt).toBeDefined();
    // The Deny is in the policy, not in the fake: without it the fake gets as far as the service's own refusal of a forced delete with a window.
    const without = connectorSecretsPolicyStatements({ secretArnPrefix: "arn:aws:secretsmanager:us-west-2:111122223333:secret:", env: ENV }).filter((statement) => statement.Sid !== "NeverDeleteWithoutRecovery");
    const unguarded = new FakeOrgSecrets({ env: ENV, policy: without });
    unguarded.seed(name, "v", { "rovara:org": ORG_A });
    await expect((await unguarded.client(ORG_A)).send(new DeleteSecretCommand({ SecretId: name, ForceDeleteWithoutRecovery: true }))).rejects.toMatchObject({ name: "InvalidParameterException" });
  });

  it("refuses to read a secret whose tag is another org's even under the session's own path", async () => {
    const { fake } = setup();
    const name = orgConnectorSecretName(ENV, ORG_A, "con_odd");
    fake.seed(name, "v", { "rovara:org": ORG_B });
    const a = await fake.client(ORG_A);
    await expect(a.send(new GetSecretValueCommand({ SecretId: name }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    await expect(a.send(new DescribeSecretCommand({ SecretId: name }))).rejects.toMatchObject({ name: "AccessDeniedException" });
    fake.seed(name, "v", {});
    await expect(a.send(new GetSecretValueCommand({ SecretId: name }))).rejects.toMatchObject({ name: "AccessDeniedException" });
  });

  it("fails every new secret when the TagResource allow is missing, which is why the policy has it", async () => {
    const withoutTag = connectorSecretsPolicyStatements({ secretArnPrefix: "arn:aws:secretsmanager:us-west-2:111122223333:secret:", env: ENV })
      .filter((statement) => ![statement.Action].flat().includes("secretsmanager:TagResource") || statement.Effect === "Deny");
    const fake = new FakeOrgSecrets({ env: ENV, policy: withoutTag });
    const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor });
    expect(await code(secrets.put(ORG_A, orgConnectorSecretName(ENV, ORG_A, CON_A), "v"))).toMatchObject({ code: "FORBIDDEN" });
  });

  it("does not know an action it was not given: a policy with only reads cannot write", async () => {
    const fake = new FakeOrgSecrets({ env: ENV, policy: [] });
    const client: SecretsClient = await fake.client(ORG_A);
    await expect(client.send(new GetSecretValueCommand({ SecretId: orgConnectorSecretName(ENV, ORG_A, CON_A) }))).rejects.toMatchObject({ name: "AccessDeniedException" });
  });
});

describe("OrgConnectionStore", () => {
  const fetchOk = (body: unknown, status = 200) => vi.fn(async () => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
  // Task 12b: an MCP endpoint is checked when it is saved, so a store that saves one has an endpoint check (the real one is in endpoint-check.test.ts).
  const storeOf = (deps: ReturnType<typeof setup>["deps"], extra: Partial<ConstructorParameters<typeof OrgConnectionStore>[0]> = {}) => new OrgConnectionStore({ ...deps, checkEndpoint: async () => undefined, ...extra });

  afterEach(() => { vi.restoreAllMocks(); });

  it("stores a Linear connection with its key only in the org's secret, and no key or secret name in the record, a log line or a read", async () => {
    const { db, fake, deps } = setup();
    const lines: string[] = [];
    const spies = (["log", "error", "warn", "info", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); }));
    const store = storeOf(deps);
    const saved = await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    spies.forEach((spy) => spy.mockRestore());
    expect(saved).toMatchObject({ connectionId: CON_A, type: "linear", label: "Linear", access: "read", hasSecret: true, createdBy: ALICE });
    const everything = JSON.stringify([...db.items.values()]);
    expect(everything).not.toContain(LINEAR_KEY);
    expect(everything).not.toContain("org-connectors");
    expect(everything).not.toContain("agentx/");
    expect(JSON.stringify(saved)).not.toContain(LINEAR_KEY);
    expect(JSON.stringify(await store.get(ORG_A, CON_A))).not.toContain(LINEAR_KEY);
    expect(JSON.stringify(await store.list(ORG_A))).not.toContain(LINEAR_KEY);
    expect(lines.join("\n")).not.toContain(LINEAR_KEY);
    // The key is in the one place the role can read, as JSON, under the id-derived name with the org tag.
    const stored = fake.stored(orgConnectorSecretName(ENV, ORG_A, CON_A));
    expect(JSON.parse(stored!.value)).toEqual({ apiKey: LINEAR_KEY });
    expect(stored!.tags).toEqual({ "rovara:org": ORG_A });
    expect(db.get(connectionKey(ORG_A, CON_A))).toBeDefined();
    expect(db.get(connectionsKey(ORG_A, CON_A))).toBeDefined();
  });

  it("changes a connection's label and access without a secret and keeps the secret it has", async () => {
    const { fake, deps, clock } = setup();
    const store = storeOf(deps);
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    clock.now += 60_000;
    const changed = await store.put({ orgId: ORG_A, connection: { ...LINEAR, label: "Linear (eng)", access: "read_write" }, by: "b".repeat(64) });
    expect(changed).toMatchObject({ label: "Linear (eng)", access: "read_write", hasSecret: true, createdBy: ALICE, updatedBy: "b".repeat(64) });
    expect(changed.createdAt).toBe("2026-10-21T09:00:00.000Z");
    expect(changed.updatedAt).toBe("2026-10-21T09:01:00.000Z");
    expect(JSON.parse(fake.stored(orgConnectorSecretName(ENV, ORG_A, CON_A))!.value)).toEqual({ apiKey: LINEAR_KEY });
  });

  it("replaces the secret with a new version", async () => {
    const { fake, deps } = setup();
    const store = storeOf(deps);
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: "lin_api_other" }, by: ALICE });
    expect(fake.stored(orgConnectorSecretName(ENV, ORG_A, CON_A))).toMatchObject({ versions: 2 });
  });

  it("refuses a secret of the wrong shape or a connection that changes type, without echoing a value", async () => {
    const { deps, fake } = setup();
    const store = storeOf(deps);
    const wrong = await code(store.put({ orgId: ORG_A, connection: JIRA, secret: { apiKey: LINEAR_KEY }, by: ALICE }));
    expect(wrong).toMatchObject({ code: "CONFIG_INVALID" });
    expect(wrong!.message).not.toContain(LINEAR_KEY);
    expect(fake.calls).toEqual([]);
    await store.put({ orgId: ORG_A, connection: LINEAR, by: ALICE });
    expect(await code(store.put({ orgId: ORG_A, connection: { ...JIRA, connectionId: CON_A }, by: ALICE }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await code(store.put({ orgId: ORG_A, connection: { ...LINEAR, label: "" }, by: ALICE }))).toMatchObject({ code: "CONFIG_INVALID" });
  });

  it("refuses to point a saved token at another host without a new token", async () => {
    const { deps } = setup();
    const store = storeOf(deps);
    await store.put({ orgId: ORG_A, connection: MCP, secret: { token: "mcp-token" }, by: ALICE });
    expect(await code(store.put({ orgId: ORG_A, connection: { ...MCP, endpoint: "https://mcp.evil.example/mcp" }, by: ALICE }))).toMatchObject({ code: "CONFIG_INVALID" });
    expect(await store.put({ orgId: ORG_A, connection: { ...MCP, endpoint: "https://mcp.acme.dev/v2" }, by: ALICE })).toMatchObject({ endpoint: "https://mcp.acme.dev/v2", hasSecret: true });
    expect(await store.put({ orgId: ORG_A, connection: { ...MCP, endpoint: "https://mcp.other.dev/mcp" }, secret: { token: "new" }, by: ALICE })).toMatchObject({ endpoint: "https://mcp.other.dev/mcp" });
  });

  it("keeps each org's connections to itself", async () => {
    const { deps } = setup();
    const store = storeOf(deps);
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    await store.put({ orgId: ORG_B, connection: { ...LINEAR, connectionId: CON_B, label: "B's" }, secret: { apiKey: "lin_api_b" }, by: ALICE });
    expect(await store.get(ORG_B, CON_A)).toBeUndefined();
    expect(await store.get(ORG_A, CON_B)).toBeUndefined();
    expect((await store.list(ORG_A)).map((entry) => entry.connectionId)).toEqual([CON_A]);
    expect((await store.list(ORG_B)).map((entry) => entry.connectionId)).toEqual([CON_B]);
    expect(await code(store.remove({ orgId: ORG_B, connectionId: CON_A, by: ALICE }))).toMatchObject({ code: "NOT_FOUND" });
    expect(await code(store.check(ORG_B, CON_A))).toMatchObject({ code: "NOT_FOUND" });
    expect(await store.get(ORG_A, "not-an-id")).toBeUndefined();
  });

  it("removes a connection and schedules its secret for deletion", async () => {
    const { deps, fake, db, clock } = setup();
    const store = storeOf(deps);
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    await store.remove({ orgId: ORG_A, connectionId: CON_A, by: ALICE });
    expect(fake.stored(orgConnectorSecretName(ENV, ORG_A, CON_A))?.deleteAt).toBe(clock.now + 7 * 86_400_000);
    expect(await store.get(ORG_A, CON_A)).toBeUndefined();
    expect(await store.list(ORG_A)).toEqual([]);
    expect(db.items.size).toBe(0);
  });

  it("removes a connection that never had a secret without touching Secrets Manager", async () => {
    const { deps, fake } = setup();
    const store = storeOf(deps);
    await store.put({ orgId: ORG_A, connection: LINEAR, by: ALICE });
    await store.remove({ orgId: ORG_A, connectionId: CON_A, by: ALICE });
    expect(fake.calls).toEqual([]);
  });

  it("records the Linear viewer id as actorId on check, hides it from reads and lists it in connectionActorIds", async () => {
    const { deps, db } = setup();
    const fetchImplementation = fetchOk({ data: { viewer: { id: "lin-user-1" } } });
    const store = storeOf(deps, { fetch: fetchImplementation as unknown as typeof fetch });
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    expect(await connectionActorIds(deps, ORG_A, "linear")).toEqual(new Set());
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: true });
    const [url, init] = fetchImplementation.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://api.linear.app/graphql");
    expect(init.body as string).toContain("viewer");
    expect((init.headers as Record<string, string>).authorization).toBe(LINEAR_KEY);
    expect(db.get(connectionKey(ORG_A, CON_A))).toMatchObject({ actorId: "lin-user-1" });
    expect(await connectionActorIds(deps, ORG_A, "linear")).toEqual(new Set(["lin-user-1"]));
    expect(await connectionActorIds(deps, ORG_A, "jira")).toEqual(new Set());
    expect(await connectionActorIds(deps, ORG_B, "linear")).toEqual(new Set());
    const view = await store.get(ORG_A, CON_A);
    expect(JSON.stringify(view)).not.toContain("lin-user-1");
    expect(view).toMatchObject({ lastCheck: { ok: true, at: "2026-10-21T09:00:00.000Z" } });
    expect(JSON.stringify(await store.list(ORG_A))).not.toContain("lin-user-1");
  });

  it("records the Jira account id on check from GET <siteUrl>/rest/api/3/myself with Basic email:apiToken", async () => {
    const { deps } = setup();
    const fetchImplementation = fetchOk({ accountId: "5b10ac8d82e05b22cc7d4ef5" });
    const store = storeOf(deps, { fetch: fetchImplementation as unknown as typeof fetch });
    await store.put({ orgId: ORG_A, connection: JIRA, secret: { email: JIRA_EMAIL, apiToken: "jira-token-value" }, by: ALICE });
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: true });
    const [url, init] = fetchImplementation.mock.calls[0] as unknown as [string, RequestInit];
    expect(url).toBe("https://acme.atlassian.net/rest/api/3/myself");
    expect(init.method ?? "GET").toBe("GET");
    expect((init.headers as Record<string, string>).authorization).toBe(`Basic ${Buffer.from(`${JIRA_EMAIL}:jira-token-value`).toString("base64")}`);
    expect(await connectionActorIds(deps, ORG_A, "jira")).toEqual(new Set(["5b10ac8d82e05b22cc7d4ef5"]));
  });

  it("does not put the Jira email or token in a failed check's message, the record or the logs", async () => {
    const { deps, db } = setup();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify({ message: `bad ${JIRA_EMAIL} jira-token-value` }), { status: 401 }));
    const store = storeOf(deps, { fetch: fetchImplementation as unknown as typeof fetch });
    await store.put({ orgId: ORG_A, connection: JIRA, secret: { email: JIRA_EMAIL, apiToken: "jira-token-value" }, by: ALICE });
    const result = await store.check(ORG_A, CON_A);
    expect(result.ok).toBe(false);
    for (const text of [JSON.stringify(result), JSON.stringify(db.get(connectionKey(ORG_A, CON_A))), JSON.stringify(logs.map((spy) => spy.mock.calls))]) {
      expect(text).not.toContain(JIRA_EMAIL);
      expect(text).not.toContain("jira-token-value");
    }
  });

  it("forgets the vendor account when the secret is replaced, and keeps it when only the settings change", async () => {
    const { deps, db, clock } = setup();
    const fetchImplementation = fetchOk({ data: { viewer: { id: "lin-user-1" } } });
    const store = storeOf(deps, { fetch: fetchImplementation as unknown as typeof fetch });
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    await store.check(ORG_A, CON_A);
    expect(await connectionActorIds(deps, ORG_A, "linear")).toEqual(new Set(["lin-user-1"]));
    clock.now += 1_000;
    await store.put({ orgId: ORG_A, connection: { ...LINEAR, label: "Renamed" }, by: ALICE });
    expect(await connectionActorIds(deps, ORG_A, "linear")).toEqual(new Set(["lin-user-1"]));
    expect(db.get(connectionKey(ORG_A, CON_A))).toMatchObject({ lastCheck: { ok: true } });
    clock.now += 1_000;
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: "lin_api_rotated" }, by: ALICE });
    expect(await connectionActorIds(deps, ORG_A, "linear")).toEqual(new Set());
    expect(db.get(connectionKey(ORG_A, CON_A))).not.toHaveProperty("lastCheck");
    expect(db.get(connectionKey(ORG_A, CON_A))).not.toHaveProperty("actorId");
    expect(db.get(connectionKey(ORG_A, CON_A))).toMatchObject({ hasSecret: true });
  });

  it("stops reading a check response at the size cap even when it declares no length", async () => {
    const { deps } = setup();
    let pulled = 0;
    const chunk = new Uint8Array(100_000).fill(0x20);
    const oversize = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      pull(controller) {
        pulled += 1;
        if (pulled > 50) controller.close();
        else controller.enqueue(chunk);
      },
    }), { status: 200 }));
    const store = storeOf(deps, { fetch: oversize as unknown as typeof fetch });
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    const result = await store.check(ORG_A, CON_A);
    expect(result).toMatchObject({ ok: false });
    expect(result.message).toContain("more than a check should return");
    // 1,000,000 bytes is 10 chunks; the reader stops soon after, not after all 50.
    expect(pulled).toBeLessThan(20);
  });

  it("still accepts a chunked response under the cap", async () => {
    const { deps } = setup();
    const body = new TextEncoder().encode(JSON.stringify({ data: { viewer: { id: "lin-user-1" } } }));
    const chunked = vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(body.slice(0, 10)); controller.enqueue(body.slice(10)); controller.close(); },
    }), { status: 200 }));
    const store = storeOf(deps, { fetch: chunked as unknown as typeof fetch });
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: true });
  });

  it("reports a refused key without the key, and keeps the actor it already had", async () => {
    const { deps, db } = setup();
    let status = 200;
    const fetchImplementation = vi.fn(async () => new Response(JSON.stringify(status === 200 ? { data: { viewer: { id: "lin-user-1" } } } : { errors: [{ message: `bad key ${LINEAR_KEY}` }] }), { status }));
    const store = storeOf(deps, { fetch: fetchImplementation as unknown as typeof fetch });
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    await store.check(ORG_A, CON_A);
    status = 401;
    const result = await store.check(ORG_A, CON_A);
    expect(result.ok).toBe(false);
    expect(result.message).toBeDefined();
    expect(result.message).not.toContain(LINEAR_KEY);
    expect(db.get(connectionKey(ORG_A, CON_A))).toMatchObject({ actorId: "lin-user-1", lastCheck: { ok: false } });
    expect(JSON.stringify(db.get(connectionKey(ORG_A, CON_A)))).not.toContain(LINEAR_KEY);
  });

  it("does not call the vendor for a connection with no secret", async () => {
    const { deps } = setup();
    const fetchImplementation = fetchOk({});
    const store = storeOf(deps, { fetch: fetchImplementation as unknown as typeof fetch });
    await store.put({ orgId: ORG_A, connection: LINEAR, by: ALICE });
    expect(await store.check(ORG_A, CON_A)).toMatchObject({ ok: false });
    expect(fetchImplementation).not.toHaveBeenCalled();
  });

  it("checks an MCP connection only through an injected endpoint check, and refuses without one", async () => {
    const { deps } = setup();
    await storeOf(deps).put({ orgId: ORG_A, connection: MCP, secret: { token: "mcp-token" }, by: ALICE });
    const withoutCheck = new OrgConnectionStore(deps);
    expect(await code(withoutCheck.check(ORG_A, CON_A))).toMatchObject({ code: "CONFIG_INVALID" });

    const refuse = vi.fn(async () => { throw new Error("endpoint host mcp.acme.dev resolves to 10.1.2.3"); });
    const listTools = vi.fn(async () => [{ name: "a" }, { name: "b" }]);
    const refused = storeOf(deps, { checkEndpoint: refuse, listMcpTools: listTools as never });
    expect(await refused.check(ORG_A, CON_A)).toMatchObject({ ok: false, message: expect.stringContaining("10.1.2.3") as string });
    expect(refuse).toHaveBeenCalledWith("https://mcp.acme.dev/mcp");
    expect(listTools).not.toHaveBeenCalled();

    const allowed = storeOf(deps, { checkEndpoint: vi.fn(async () => undefined), endpointGuard: async () => fetch, listMcpTools: listTools as never });
    expect(await allowed.check(ORG_A, CON_A)).toEqual({ ok: true, message: "2 tools" });
    expect(listTools).toHaveBeenCalledWith(expect.objectContaining({ endpoint: new URL("https://mcp.acme.dev/mcp"), token: "mcp-token" }));
    expect(await connectionActorIds(deps, ORG_A, "mcp")).toEqual(new Set());
  });
});

describe("HookSecretStore", () => {
  it("puts, reads and schedules deletion of a hook secret under the org's hook path", async () => {
    const { fake, secrets, clock } = setup();
    const hooks = new HookSecretStore({ env: ENV, secrets });
    await hooks.put(ORG_A, "hok_aaaaaaaaaaaaaaaaaaaa", "hook-value");
    expect(fake.stored(orgHookSecretName(ENV, ORG_A, "hok_aaaaaaaaaaaaaaaaaaaa"))).toMatchObject({ value: "hook-value", tags: { "rovara:org": ORG_A } });
    expect(await hooks.read(ORG_A, "hok_aaaaaaaaaaaaaaaaaaaa")).toBe("hook-value");
    await hooks.scheduleDelete(ORG_A, "hok_aaaaaaaaaaaaaaaaaaaa");
    expect(fake.stored(orgHookSecretName(ENV, ORG_A, "hok_aaaaaaaaaaaaaaaaaaaa"))?.deleteAt).toBe(clock.now + 7 * 86_400_000);
  });

  it("refuses an id that names a path, and org B never reads org A's hook", async () => {
    const { fake, secrets } = setup();
    const hooks = new HookSecretStore({ env: ENV, secrets });
    await hooks.put(ORG_A, "hok_aaaaaaaaaaaaaaaaaaaa", "hook-value");
    const before = fake.calls.length;
    for (const hookId of [`../${ORG_A}/hok_aaaaaaaaaaaaaaaaaaaa`, `${ORG_A}/hok_aaaaaaaaaaaaaaaaaaaa`, orgHookSecretName(ENV, ORG_A, "hok_aaaaaaaaaaaaaaaaaaaa"), "", "a/b", ".."]) {
      expect(await code(hooks.read(ORG_B, hookId)), hookId).toMatchObject({ code: "FORBIDDEN" });
      expect(await code(hooks.put(ORG_B, hookId, "x")), hookId).toMatchObject({ code: "FORBIDDEN" });
      expect(await code(hooks.scheduleDelete(ORG_B, hookId)), hookId).toMatchObject({ code: "FORBIDDEN" });
    }
    expect(fake.calls.length).toBe(before);
    // The same id under org B's own path is not there (the role cannot tell a missing secret from a forbidden one).
    expect(["FORBIDDEN", "NOT_FOUND"]).toContain((await code(hooks.read(ORG_B, "hok_aaaaaaaaaaaaaaaaaaaa")))?.code);
    expect(fake.stored(orgHookSecretName(ENV, ORG_A, "hok_aaaaaaaaaaaaaaaaaaaa"))?.value).toBe("hook-value");
  });
});

describe("orgCredentialRegistry", () => {
  const savedStore = async (deps: ReturnType<typeof setup>["deps"], connection: OrgConnection, secret: Record<string, string>, orgId = ORG_A) => {
    const store = new OrgConnectionStore({ ...deps, checkEndpoint: async () => undefined });
    await store.put({ orgId, connection, secret, by: ALICE });
  };

  it("reads another org's or an unknown connection id as not registered", async () => {
    const { deps } = setup();
    await savedStore(deps, LINEAR, { apiKey: LINEAR_KEY });
    const registryB = orgCredentialRegistry(deps, ORG_B);
    expect(await registryB.registration(CON_A)).toBeUndefined();
    expect(await registryB.typeOf(CON_A)).toBeUndefined();
    expect(await registryB.has(CON_A)).toBe(false);
    expect(await orgCredentialRegistry(deps, ORG_A).has(CON_A)).toBe(true);
    expect(await registryB.registration("con_zzzzzzzzzzzzzzzzzzzz")).toBeUndefined();
    expect(await registryB.registration("github-agentx-sdlc")).toBeUndefined();
    await expect(registryB.provider(CON_A).issue({}, "read")).rejects.toBeInstanceOf(CredentialUnavailable);
  });

  it("lists a connection with a secret as a static-secret registration that names no secret value", async () => {
    const { deps } = setup();
    await savedStore(deps, LINEAR, { apiKey: LINEAR_KEY });
    await savedStore(deps, { ...MCP, connectionId: "con_mmmmmmmmmmmmmmmmmmmm" }, { token: "mcp-token" });
    await new OrgConnectionStore(deps).put({ orgId: ORG_A, connection: { ...JIRA, connectionId: "con_jjjjjjjjjjjjjjjjjjjj" }, by: ALICE });
    const registry = orgCredentialRegistry(deps, ORG_A);
    const linear = await registry.registration(CON_A);
    expect(linear).toMatchObject({ ref: CON_A, type: "static-secret", secretName: orgConnectorSecretName(ENV, ORG_A, CON_A), registeredBy: ALICE });
    expect(linear!.host).toBeUndefined();
    expect(JSON.stringify(linear)).not.toContain(LINEAR_KEY);
    expect(await registry.registration("con_mmmmmmmmmmmmmmmmmmmm")).toMatchObject({ host: "mcp.acme.dev" });
    expect(await registry.typeOf(CON_A)).toBe("static-secret");
    // A connection with no secret yet is not usable, so it is not registered.
    expect(await registry.registration("con_jjjjjjjjjjjjjjjjjjjj")).toBeUndefined();
    expect(await registry.typeOf("con_jjjjjjjjjjjjjjjjjjjj")).toBeUndefined();
  });

  it("issues the saved token for each type, and a re-saved secret takes effect", async () => {
    const { deps, clock } = setup();
    await savedStore(deps, LINEAR, { apiKey: LINEAR_KEY });
    await savedStore(deps, { ...JIRA, connectionId: "con_jjjjjjjjjjjjjjjjjjjj" }, { email: JIRA_EMAIL, apiToken: "jira-token" });
    await savedStore(deps, { ...MCP, connectionId: "con_mmmmmmmmmmmmmmmmmmmm" }, { token: "mcp-token" });
    const registry = orgCredentialRegistry(deps, ORG_A);
    expect((await registry.provider(CON_A).issue({}, "read")).token).toBe(LINEAR_KEY);
    expect((await registry.provider("con_jjjjjjjjjjjjjjjjjjjj").issue({}, "read")).token).toBe("jira-token");
    expect((await registry.provider("con_mmmmmmmmmmmmmmmmmmmm").issue({}, "read")).token).toBe("mcp-token");
    clock.now += 1_000;
    await savedStore(deps, LINEAR, { apiKey: "lin_api_rotated" });
    expect((await registry.provider(CON_A).issue({}, "read")).token).toBe("lin_api_rotated");
  });

  it("refuses write access on a read-only connection", async () => {
    const { deps } = setup();
    await savedStore(deps, LINEAR, { apiKey: LINEAR_KEY });
    await savedStore(deps, { ...LINEAR, connectionId: "con_wwwwwwwwwwwwwwwwwwww", access: "read_write" }, { apiKey: LINEAR_KEY });
    const registry = orgCredentialRegistry(deps, ORG_A);
    await expect(registry.provider(CON_A).issue({}, "write")).rejects.toBeInstanceOf(CredentialUnavailable);
    expect((await registry.provider("con_wwwwwwwwwwwwwwwwwwww").issue({}, "write")).token).toBe(LINEAR_KEY);
  });

  it("applies the connector's host pin to an MCP connection", async () => {
    const { deps } = setup();
    await savedStore(deps, MCP, { token: "mcp-token" });
    const registry = orgCredentialRegistry(deps, ORG_A);
    expect((await registry.provider(CON_A, { pin: { host: "mcp.acme.dev", required: true } }).issue({}, "read")).token).toBe("mcp-token");
    await expect(registry.provider(CON_A, { pin: { host: "mcp.other.dev", required: true } }).issue({}, "read")).rejects.toBeInstanceOf(CredentialUnavailable);
  });

  it("does not leak a token into the error when the stored secret is malformed", async () => {
    const { deps, fake } = setup();
    await savedStore(deps, LINEAR, { apiKey: LINEAR_KEY });
    // The connection reads the version its save wrote, so the stored version is the one corrupted.
    const stored = fake.stored(orgConnectorSecretName(ENV, ORG_A, CON_A))!;
    stored.history.at(-1)!.value = `{"apiToken":"${LINEAR_KEY}"}`;
    const failure = await code(orgCredentialRegistry(deps, ORG_A).provider(CON_A).issue({}, "read"));
    expect(failure?.name).toBe("CredentialUnavailable");
    expect(failure?.message).not.toContain(LINEAR_KEY);
  });
});

describe("connectorTypeContext", () => {
  type Context = {
    credentialRegistry?: { registration(ref: string): Promise<unknown>; typeOf(ref: string): Promise<unknown> };
    githubMcp?: { credentials(repository: unknown, access: unknown): Promise<unknown> };
  };
  let contextOf: (dependencies: Record<string, unknown>, orgId: OrgId | undefined, scope: () => Promise<unknown>) => Context;

  beforeAll(async () => {
    await loadSlackBroker();
    const broker = await import("../../packages/broker/src/aws/broker.js") as unknown as { connectorTypeContext: typeof contextOf };
    contextOf = broker.connectorTypeContext;
  });

  const noToken = () => Promise.reject(new Error("no token is minted when only the registry is read"));
  const installWide = { registration: async () => ({ ref: "install" }), typeOf: async () => "static-secret", provider: () => ({}) };

  it("keeps the install-wide registry on a private install, whatever the org", () => {
    const { deps } = setup();
    expect(contextOf({ credentialRegistry: installWide, orgConnections: deps }, ORG_A, noToken).credentialRegistry).toBe(installWide);
    expect(contextOf({ credentialRegistry: installWide }, undefined, noToken).credentialRegistry).toBe(installWide);
    expect(contextOf({}, undefined, noToken).credentialRegistry).toBeUndefined();
  });

  it("serves a cloud org only its own connections, never the install-wide registry", async () => {
    const { deps } = setup();
    await new OrgConnectionStore(deps).put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: LINEAR_KEY }, by: ALICE });
    const cloud = { cloud: true, credentialRegistry: installWide, orgConnections: deps };
    const forA = contextOf(cloud, ORG_A, noToken).credentialRegistry!;
    expect(await forA.typeOf(CON_A)).toBe("static-secret");
    expect(await forA.registration("install")).toBeUndefined();
    const forB = contextOf(cloud, ORG_B, noToken).credentialRegistry!;
    expect(await forB.typeOf(CON_A)).toBeUndefined();
    expect(await forB.registration(CON_A)).toBeUndefined();
  });

  it("mints a GitHub token only under the scope the caller named, whatever org the registry is for", async () => {
    const minted: unknown[] = [];
    const githubMcp = { credentials: async (_repository: unknown, _access: unknown, scope: unknown) => { minted.push(scope); return "token"; } };
    const context = contextOf({ cloud: true, githubMcp }, ORG_A, async () => ({ orgId: ORG_B }));
    expect(minted).toEqual([]);
    await context.githubMcp!.credentials({ owner: "o", name: "r" }, "read");
    expect(minted).toEqual([{ orgId: ORG_B }]);
  });

  it("gives a cloud caller with no org, or a cloud install with no org connections, no registry", () => {
    const { deps } = setup();
    expect(contextOf({ cloud: true, credentialRegistry: installWide, orgConnections: deps }, undefined, noToken).credentialRegistry).toBeUndefined();
    expect(contextOf({ cloud: true, credentialRegistry: installWide }, ORG_A, noToken).credentialRegistry).toBeUndefined();
  });
});
