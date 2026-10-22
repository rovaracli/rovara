// Plan 4 Task 11: the six new connection types (Sentry, Datadog, CloudWatch, Grafana, Vercel, PagerDuty) on Plan 3's org registry.
// They are read-only, their secrets are write-only like Plan 3's, and each type's check comes from its own connector task through
// the store's `checks` seam. The Secrets Manager and STS fake enforces the role's policies, so org isolation is proven, not assumed.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialUnavailable } from "@agentx/gateway";
import { orgCredentialRegistry } from "../../packages/broker/src/connections/registry.js";
import { OrgConnectionStore, connectionActorIds, readConnectionSecret } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets, orgConnectorSecretName } from "../../packages/broker/src/connections/org-secrets.js";
import { routeConnectionRequest } from "../../packages/broker/src/connections/routes.js";
import {
  ConnectionSecretSchema,
  ConnectionSecretSchemas,
  ConnectionTypeSchema,
  OrgConnectionSchema,
  connectionKey,
  connectionSecretToken,
  type OrgConnection,
} from "../../packages/contracts/src/connections.js";
import {
  DATADOG_SITES,
  ObservabilityConnectionTypeSchema,
  cloudwatchExternalId,
  readOnlyConnectionMessage,
} from "../../packages/contracts/src/connection-types-observability.js";
import type { OrgId } from "../../packages/contracts/src/org.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ENV = "staging";
const CON_A = "con_aaaaaaaaaaaaaaaaaaaa";
const ALICE = "a".repeat(64);
const START = Date.parse("2026-10-22T09:00:00.000Z");
const SENTRY_TOKEN = "sntrys_SECRETTOKENVALUE0123456789";
const ROLE_ARN = "arn:aws:iam::123456789012:role/rovara-read";

const SENTRY: OrgConnection = { connectionId: CON_A, type: "sentry", label: "Sentry", access: "read", region: "us", orgSlug: "acme" };
const DATADOG: OrgConnection = { connectionId: CON_A, type: "datadog", label: "Datadog", access: "read", site: "datadoghq.eu" };
const CLOUDWATCH: OrgConnection = { connectionId: CON_A, type: "cloudwatch", label: "CloudWatch", access: "read", roleArn: ROLE_ARN, regions: ["us-east-1", "eu-west-1"] };
const GRAFANA: OrgConnection = { connectionId: CON_A, type: "grafana", label: "Grafana", access: "read", baseUrl: "https://grafana.acme.dev" };
const VERCEL: OrgConnection = { connectionId: CON_A, type: "vercel", label: "Vercel", access: "read" };
const PAGERDUTY: OrgConnection = { connectionId: CON_A, type: "pagerduty", label: "PagerDuty", access: "read", region: "eu" };

const SECRETS: Record<string, Record<string, string>> = {
  sentry: { authToken: SENTRY_TOKEN },
  datadog: { apiKey: "dd-api-key-0123456789", appKey: "dd-app-key-0123456789" },
  grafana: { serviceAccountToken: "glsa_SECRET0123456789" },
  vercel: { token: "vercel-token-0123456789" },
  pagerduty: { apiKey: "pd-api-key-0123456789" },
};
const SECRET_TYPES = [SENTRY, DATADOG, GRAFANA, VERCEL, PAGERDUTY] as const;

function setup() {
  const clock = { now: START };
  const fake = new FakeOrgSecrets({ env: ENV, now: () => clock.now });
  const db = new FakeDynamoDb();
  const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => clock.now });
  const deps = { documentClient: db, tableName: "T", env: ENV, secrets, now: () => clock.now };
  return { clock, fake, db, secrets, deps };
}

const storeOf = (deps: ReturnType<typeof setup>["deps"], extra: Partial<ConstructorParameters<typeof OrgConnectionStore>[0]> = {}) =>
  new OrgConnectionStore({ ...deps, checkEndpoint: async () => undefined, ...extra });

const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string; name?: string }) => ({ code: error.code, name: error.name, message: error.message }));

const secretFor = (connection: OrgConnection) => SECRETS[connection.type];

function captureConsole(): { lines: string[]; restore: () => void } {
  const lines: string[] = [];
  const spies = (["log", "error", "warn", "info", "debug"] as const).map((method) => vi.spyOn(console, method).mockImplementation((...parts: unknown[]) => { lines.push(parts.map(String).join(" ")); }));
  return { lines, restore: () => spies.forEach((spy) => spy.mockRestore()) };
}

afterEach(() => { vi.restoreAllMocks(); });

describe("the six connection types' contracts", () => {
  it("joins the types to Plan 3's union, and parses each strictly", () => {
    expect(ConnectionTypeSchema.options).toEqual(["linear", "jira", "mcp", "sentry", "datadog", "cloudwatch", "grafana", "vercel", "pagerduty"]);
    expect(ObservabilityConnectionTypeSchema.options).toEqual(["sentry", "datadog", "cloudwatch", "grafana", "vercel", "pagerduty"]);
    for (const connection of [SENTRY, DATADOG, CLOUDWATCH, GRAFANA, VERCEL, PAGERDUTY, { ...VERCEL, teamId: "team_AbC123" }]) {
      expect(OrgConnectionSchema.parse(connection)).toEqual(connection);
      expect(OrgConnectionSchema.safeParse({ ...connection, secret: "x" }).success).toBe(false);
      expect(OrgConnectionSchema.safeParse({ ...connection, label: "" }).success).toBe(false);
      expect(OrgConnectionSchema.safeParse({ ...connection, label: "x".repeat(65) }).success).toBe(false);
      expect(OrgConnectionSchema.safeParse({ ...connection, label: "two\nlines" }).success).toBe(false);
      expect(OrgConnectionSchema.safeParse({ ...connection, connectionId: "con_short" }).success).toBe(false);
    }
  });

  it("is read-only: only access read parses", () => {
    for (const connection of [SENTRY, DATADOG, CLOUDWATCH, GRAFANA, VERCEL, PAGERDUTY]) {
      expect(OrgConnectionSchema.safeParse({ ...connection, access: "read_write" }).success).toBe(false);
      expect(OrgConnectionSchema.safeParse({ ...connection, access: "write" }).success).toBe(false);
      const { access: _access, ...without } = connection; // eslint-disable-line @typescript-eslint/no-unused-vars -- the field is dropped on purpose
      expect(OrgConnectionSchema.safeParse(without).success).toBe(false);
    }
  });

  it("holds Sentry's region and org slug, Datadog's site and PagerDuty's region to the plan's lists", () => {
    expect(OrgConnectionSchema.safeParse({ ...SENTRY, region: "eu" }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...SENTRY, region: "de" }).success).toBe(true);
    for (const slug of ["Acme", "-acme", "acme_x", "", "a".repeat(51), "acme.io"]) expect(OrgConnectionSchema.safeParse({ ...SENTRY, orgSlug: slug }).success, slug).toBe(false);
    for (const slug of ["a", "0acme", "a".repeat(50), "my-org-2"]) expect(OrgConnectionSchema.safeParse({ ...SENTRY, orgSlug: slug }).success, slug).toBe(true);
    expect(DATADOG_SITES).toEqual(["datadoghq.com", "us3.datadoghq.com", "us5.datadoghq.com", "datadoghq.eu", "ap1.datadoghq.com", "ap2.datadoghq.com", "ddog-gov.com"]);
    for (const site of DATADOG_SITES) expect(OrgConnectionSchema.safeParse({ ...DATADOG, site }).success, site).toBe(true);
    for (const site of ["datadoghq.com.evil.example", "evil.example", "https://datadoghq.com", "eu.datadoghq.com"]) expect(OrgConnectionSchema.safeParse({ ...DATADOG, site }).success, site).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...PAGERDUTY, region: "us" }).success).toBe(true);
    expect(OrgConnectionSchema.safeParse({ ...PAGERDUTY, region: "de" }).success).toBe(false);
  });

  it("holds the CloudWatch role to an IAM role ARN and the regions to one to five", () => {
    for (const arn of ["arn:aws-cn:iam::123456789012:role/path/to/role", "arn:aws-us-gov:iam::123456789012:role/r_+=,.@-"]) expect(OrgConnectionSchema.safeParse({ ...CLOUDWATCH, roleArn: arn }).success, arn).toBe(true);
    for (const arn of [
      "arn:aws:iam::12345678901:role/r", "arn:aws:iam::123456789012:user/r", "arn:aws:s3:::bucket", "arn:aws:iam::123456789012:role/", "arn:aws:iam::123456789012:role/r r",
      `arn:aws:iam::123456789012:role/${"r".repeat(513)}`, "arn:aws:iam::123456789012:role/r\nx", "",
    ]) expect(OrgConnectionSchema.safeParse({ ...CLOUDWATCH, roleArn: arn }).success, arn).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...CLOUDWATCH, regions: [] }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...CLOUDWATCH, regions: ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "eu-west-1"] }).success).toBe(true);
    expect(OrgConnectionSchema.safeParse({ ...CLOUDWATCH, regions: ["us-east-1", "us-east-2", "us-west-1", "us-west-2", "eu-west-1", "eu-west-2"] }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...CLOUDWATCH, regions: ["US-EAST-1"] }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...CLOUDWATCH, regions: ["us-east-1; drop"] }).success).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...CLOUDWATCH, regions: ["us-east-1", "us-east-1"] }).success).toBe(false);
  });

  it("refuses an external id from the client: it is server-set, so it is an unknown field", () => {
    expect(OrgConnectionSchema.safeParse({ ...CLOUDWATCH, externalId: "rovara-org_aaaaaaaaaaaaaaaaaaaa" }).success).toBe(false);
    expect(cloudwatchExternalId(ORG_A)).toBe(`rovara-${ORG_A}`);
  });

  it("takes a Grafana address only as a public https URL, and a Vercel team id only as team_<id>", () => {
    for (const baseUrl of ["http://grafana.acme.dev", "https://127.0.0.1", "https://localhost", "https://grafana.internal", "https://user:pw@grafana.acme.dev", "https://grafana.acme.dev/?x=1", "https://grafana", "grafana.acme.dev"]) {
      expect(OrgConnectionSchema.safeParse({ ...GRAFANA, baseUrl }).success, baseUrl).toBe(false);
    }
    expect(OrgConnectionSchema.safeParse({ ...GRAFANA, baseUrl: "https://acme.grafana.net" }).success).toBe(true);
    expect(OrgConnectionSchema.safeParse({ ...GRAFANA, baseUrl: "https://tools.acme.dev/grafana" }).success).toBe(true);
    for (const teamId of ["acme", "team_", "team_a b", `team_${"a".repeat(65)}`, "Team_abc", "team_a-b"]) expect(OrgConnectionSchema.safeParse({ ...VERCEL, teamId }).success, teamId).toBe(false);
    expect(OrgConnectionSchema.safeParse({ ...VERCEL, teamId: `team_${"A1".repeat(32)}` }).success).toBe(true);
  });

  it("holds one strict, write-only secret shape per type that has a secret, and none for CloudWatch", () => {
    expect(ConnectionSecretSchema.safeParse({ authToken: "t" }).success).toBe(true);
    expect(ConnectionSecretSchema.safeParse({ authToken: "t", extra: "x" }).success).toBe(false);
    expect(ConnectionSecretSchema.safeParse({ apiKey: "k", appKey: "a" }).success).toBe(true);
    expect(ConnectionSecretSchema.safeParse({ serviceAccountToken: "t" }).success).toBe(true);
    expect(ConnectionSecretSchema.safeParse({ authToken: "has a space" }).success).toBe(false);
    expect(ConnectionSecretSchema.safeParse({ authToken: "" }).success).toBe(false);
    expect(ConnectionSecretSchema.safeParse({ authToken: "line\nbreak" }).success).toBe(false);
    expect(ConnectionSecretSchemas.datadog.safeParse({ apiKey: "k" }).success).toBe(false);
    expect(ConnectionSecretSchemas.datadog.safeParse({ appKey: "k" }).success).toBe(false);
    expect(ConnectionSecretSchemas.sentry.safeParse({ token: "t" }).success).toBe(false);
    expect(ConnectionSecretSchemas.grafana.safeParse({ token: "t" }).success).toBe(false);
    expect(Object.keys(ConnectionSecretSchemas)).not.toContain("cloudwatch");
  });

  it("names the one value the runtime sends for each type with a secret", () => {
    expect(connectionSecretToken("sentry", { authToken: "s" })).toBe("s");
    expect(connectionSecretToken("datadog", { apiKey: "api", appKey: "app" })).toBe("api");
    expect(connectionSecretToken("grafana", { serviceAccountToken: "g" })).toBe("g");
    expect(connectionSecretToken("vercel", { token: "v" })).toBe("v");
    expect(connectionSecretToken("pagerduty", { apiKey: "p" })).toBe("p");
    expect(connectionSecretToken("linear", { apiKey: "l" })).toBe("l");
  });
});

describe("saving the new connections", () => {
  it("stores a Sentry connection with its token only in the org's secret, and no token or secret name in the record, a response or a log line", async () => {
    const { db, fake, deps } = setup();
    const capture = captureConsole();
    const store = storeOf(deps);
    const saved = await store.put({ orgId: ORG_A, connection: SENTRY, secret: { authToken: SENTRY_TOKEN }, by: ALICE });
    const read = await store.get(ORG_A, CON_A);
    const listed = await store.list(ORG_A);
    await store.check(ORG_A, CON_A);
    capture.restore();
    expect(saved).toMatchObject({ connectionId: CON_A, type: "sentry", region: "us", orgSlug: "acme", access: "read", hasSecret: true, createdBy: ALICE });
    for (const text of [JSON.stringify([...db.items.values()]), JSON.stringify(saved), JSON.stringify(read), JSON.stringify(listed), capture.lines.join("\n")]) {
      expect(text).not.toContain(SENTRY_TOKEN);
      expect(text).not.toContain("org-connectors");
      expect(text).not.toContain("agentx/");
    }
    expect(JSON.parse(fake.stored(orgConnectorSecretName(ENV, ORG_A, CON_A))!.value)).toEqual({ authToken: SENTRY_TOKEN });
    expect(fake.stored(orgConnectorSecretName(ENV, ORG_A, CON_A))!.tags).toEqual({ "rovara:org": ORG_A });
    expect(JSON.stringify([...db.items.values()])).not.toContain("secretName");
  });

  it("keeps each type's secret in the shape the type takes and reads it back whole", async () => {
    for (const connection of SECRET_TYPES) {
      const { deps } = setup();
      const store = storeOf(deps);
      await store.put({ orgId: ORG_A, connection, secret: secretFor(connection), by: ALICE });
      const record = await store.get(ORG_A, CON_A);
      expect(record).toMatchObject({ type: connection.type, hasSecret: true, access: "read" });
      expect(await readConnectionSecret(deps, ORG_A, record!)).toEqual(secretFor(connection));
      const registry = orgCredentialRegistry(deps, ORG_A);
      expect(await registry.typeOf(CON_A)).toBe("static-secret");
      const issued = await registry.provider(CON_A).issue({}, "read");
      expect(issued.token).toBe(connectionSecretToken(connection.type as "sentry", secretFor(connection) as never));
    }
  });

  it("refuses a secret of the wrong shape for the type, and never echoes a value", async () => {
    const { db, fake, deps } = setup();
    const store = storeOf(deps);
    const cases: Array<[OrgConnection, Record<string, string>]> = [
      [SENTRY, { apiKey: "WRONGSHAPE-VALUE" }],
      [DATADOG, { apiKey: "ONLY-ONE-KEY-VALUE" }],
      [GRAFANA, { token: "WRONGSHAPE-VALUE" }],
      [PAGERDUTY, { apiKey: "has a space" }],
      [VERCEL, { token: "ok", extra: "EXTRA-VALUE" }],
    ];
    for (const [connection, secret] of cases) {
      const refusal = await failure(store.put({ orgId: ORG_A, connection, secret, by: ALICE }));
      expect(refusal?.code, connection.type).toBe("CONFIG_INVALID");
      expect(refusal?.message).toMatch(/^secret: a \w+ connection takes/);
      for (const value of Object.values(secret)) expect(refusal?.message).not.toContain(value);
    }
    expect(db.items.size).toBe(0);
    expect(fake.calls.filter((call) => call.service === "secretsmanager")).toEqual([]);
  });

  it("stores a CloudWatch connection with the external id the server sets, and no secret", async () => {
    const { db, fake, deps } = setup();
    const store = storeOf(deps);
    const saved = await store.put({ orgId: ORG_A, connection: CLOUDWATCH, by: ALICE });
    expect(saved).toMatchObject({ type: "cloudwatch", roleArn: ROLE_ARN, regions: ["us-east-1", "eu-west-1"], hasSecret: false, externalId: `rovara-${ORG_A}` });
    expect(db.get(connectionKey(ORG_A, CON_A))).toMatchObject({ externalId: `rovara-${ORG_A}`, hasSecret: false });
    expect(await store.get(ORG_A, CON_A)).toMatchObject({ externalId: `rovara-${ORG_A}` });
    expect((await store.list(ORG_A))[0]).toMatchObject({ externalId: `rovara-${ORG_A}` });
    // Nothing was written to Secrets Manager, and org B's connection gets org B's id.
    expect(fake.calls.filter((call) => call.service === "secretsmanager")).toEqual([]);
    const other = await store.put({ orgId: ORG_B, connection: CLOUDWATCH, by: ALICE });
    expect(other.externalId).toBe(`rovara-${ORG_B}`);
    // A save again re-sets it, whatever the stored item held.
    db.get(connectionKey(ORG_A, CON_A))!.externalId = "rovara-tampered";
    expect((await store.put({ orgId: ORG_A, connection: { ...CLOUDWATCH, label: "Renamed" }, by: ALICE })).externalId).toBe(`rovara-${ORG_A}`);
  });

  it("refuses a CloudWatch body with an external id as an unknown field, and a secret for a type that has none", async () => {
    const { db, fake, deps } = setup();
    const store = storeOf(deps);
    const stray = await failure(store.put({ orgId: ORG_A, connection: { ...CLOUDWATCH, externalId: "rovara-org_cccccccccccccccccccc" }, by: ALICE }));
    expect(stray).toMatchObject({ code: "CONFIG_INVALID", message: "connection: has a field this kind of connection does not take" });
    expect(stray?.message).not.toContain("externalId");
    const secret = await failure(store.put({ orgId: ORG_A, connection: CLOUDWATCH, secret: { token: "SHOULD-NOT-BE-STORED" }, by: ALICE }));
    expect(secret).toMatchObject({ code: "CONFIG_INVALID", message: "secret: a cloudwatch connection takes no secret" });
    expect(db.items.size).toBe(0);
    expect(fake.calls.filter((call) => call.service === "secretsmanager")).toEqual([]);
  });

  it("refuses access read_write on each of the six types with the exact text, and writes nothing", async () => {
    for (const connection of [SENTRY, DATADOG, CLOUDWATCH, GRAFANA, VERCEL, PAGERDUTY]) {
      const { db, fake, deps } = setup();
      const store = storeOf(deps);
      const refusal = await failure(store.put({ orgId: ORG_A, connection: { ...connection, access: "read_write" }, ...(secretFor(connection) === undefined ? {} : { secret: secretFor(connection) }), by: ALICE }));
      expect(refusal, connection.type).toEqual({ code: "CONFIG_INVALID", name: expect.any(String), message: `access: ${connection.type} connections are read-only` });
      expect(readOnlyConnectionMessage(connection.type as "sentry")).toBe(`access: ${connection.type} connections are read-only`);
      expect(db.items.size).toBe(0);
      expect(fake.calls.filter((call) => call.service === "secretsmanager")).toEqual([]);
    }
    // Lowering a saved read connection to read_write is refused the same way, and the record stays as it was.
    const { db, deps } = setup();
    const store = storeOf(deps);
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    const before = JSON.stringify(db.get(connectionKey(ORG_A, CON_A)));
    expect((await failure(store.put({ orgId: ORG_A, connection: { ...SENTRY, access: "read_write" }, by: ALICE }))).message).toBe("access: sentry connections are read-only");
    expect(JSON.stringify(db.get(connectionKey(ORG_A, CON_A)))).toBe(before);
  });

  it("does not let a connection change type into or out of the new types", async () => {
    const { deps } = setup();
    const store = storeOf(deps);
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    const refusal = await failure(store.put({ orgId: ORG_A, connection: { ...VERCEL }, secret: secretFor(VERCEL), by: ALICE }));
    expect(refusal).toMatchObject({ code: "CONFIG_INVALID", message: "connection.type: a connection's type cannot change; remove it and add a new one" });
  });

  it("refuses to send a saved token to another site without a new one, and lets a change that goes nowhere new through", async () => {
    const { deps } = setup();
    const store = storeOf(deps);
    const moved = [
      { connection: SENTRY, change: { region: "de" } },
      { connection: DATADOG, change: { site: "datadoghq.com" } },
      { connection: PAGERDUTY, change: { region: "us" } },
      { connection: GRAFANA, change: { baseUrl: "https://grafana.other.dev" } },
    ] as const;
    for (const { connection, change } of moved) {
      await store.put({ orgId: ORG_A, connection, secret: secretFor(connection), by: ALICE });
      const refusal = await failure(store.put({ orgId: ORG_A, connection: { ...connection, ...change } as OrgConnection, by: ALICE }));
      expect(refusal, connection.type).toMatchObject({ code: "CONFIG_INVALID", message: "connection: the saved secret would be sent to a different host; give the new secret with it" });
      expect(await store.get(ORG_A, CON_A)).toMatchObject(connection);
      await store.put({ orgId: ORG_A, connection: { ...connection, ...change } as OrgConnection, secret: secretFor(connection), by: ALICE });
      expect(await store.get(ORG_A, CON_A)).toMatchObject(change);
      await store.remove({ orgId: ORG_A, connectionId: CON_A, by: ALICE });
    }
    // A label, an org slug or a team id goes to the same place, so the saved token stays.
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    await store.put({ orgId: ORG_A, connection: { ...SENTRY, orgSlug: "other-org", label: "Other" }, by: ALICE });
    expect(await store.get(ORG_A, CON_A)).toMatchObject({ orgSlug: "other-org", hasSecret: true });
    expect((await orgCredentialRegistry(deps, ORG_A).provider(CON_A).issue({}, "read")).token).toBe(SENTRY_TOKEN);
    await store.remove({ orgId: ORG_A, connectionId: CON_A, by: ALICE });
    await store.put({ orgId: ORG_A, connection: VERCEL, secret: secretFor(VERCEL), by: ALICE });
    await store.put({ orgId: ORG_A, connection: { ...VERCEL, teamId: "team_abc123" }, by: ALICE });
    expect(await store.get(ORG_A, CON_A)).toMatchObject({ teamId: "team_abc123", hasSecret: true });
  });

  it("checks a Grafana address before saving it, and refuses the save when it may not be called or cannot be checked", async () => {
    const { db, fake, deps } = setup();
    const seen: string[] = [];
    const store = storeOf(deps, { checkEndpoint: async (url) => { seen.push(url); } });
    await store.put({ orgId: ORG_A, connection: GRAFANA, secret: secretFor(GRAFANA), by: ALICE });
    expect(seen).toEqual(["https://grafana.acme.dev"]);

    const refusing = storeOf(setup().deps, { checkEndpoint: async () => { throw Object.assign(new Error("that address is not allowed"), { code: "CONFIG_INVALID" }); } });
    expect((await failure(refusing.put({ orgId: ORG_A, connection: GRAFANA, secret: secretFor(GRAFANA), by: ALICE })))?.code).toBe("CONFIG_INVALID");

    const fresh = setup();
    const unchecked = new OrgConnectionStore({ ...fresh.deps });
    const refusal = await failure(unchecked.put({ orgId: ORG_A, connection: GRAFANA, secret: secretFor(GRAFANA), by: ALICE }));
    expect(refusal).toMatchObject({ code: "CONFIG_INVALID", message: "this deployment cannot check a Grafana address, so it cannot save a Grafana connection" });
    expect(fresh.db.items.size).toBe(0);
    expect(fresh.fake.calls.filter((call) => call.service === "secretsmanager")).toEqual([]);
    expect(db.items.size).toBeGreaterThan(0);
    expect(fake.calls.length).toBeGreaterThan(0);
  });

  it("does not check an endpoint for the types that have none", async () => {
    const { deps } = setup();
    const checkEndpoint = vi.fn(async () => undefined);
    const store = storeOf(deps, { checkEndpoint });
    for (const connection of [SENTRY, DATADOG, CLOUDWATCH, VERCEL, PAGERDUTY]) {
      await store.put({ orgId: ORG_A, connection: { ...connection, connectionId: `con_${connection.type.padEnd(20, "x").slice(0, 20)}` }, ...(secretFor(connection) === undefined ? {} : { secret: secretFor(connection) }), by: ALICE });
    }
    expect(checkEndpoint).not.toHaveBeenCalled();
    // And a deployment with no endpoint check can still hold them.
    const bare = new OrgConnectionStore({ ...setup().deps });
    await bare.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
  });

  it("removes a new-type connection and schedules its secret for deletion, and one with no secret touches no secret", async () => {
    const { fake, deps } = setup();
    const store = storeOf(deps);
    await store.put({ orgId: ORG_A, connection: DATADOG, secret: secretFor(DATADOG), by: ALICE });
    await store.remove({ orgId: ORG_A, connectionId: CON_A, by: ALICE });
    expect(fake.stored(orgConnectorSecretName(ENV, ORG_A, CON_A))!.deleteAt).toBeDefined();
    const calls = fake.calls.length;
    await store.put({ orgId: ORG_A, connection: { ...CLOUDWATCH, connectionId: "con_cccccccccccccccccccc" }, by: ALICE });
    await store.remove({ orgId: ORG_A, connectionId: "con_cccccccccccccccccccc", by: ALICE });
    expect(fake.calls.length).toBe(calls);
    expect(await store.list(ORG_A)).toEqual([]);
  });
});

describe("the per-org registry and the new types (Review Focus 6)", () => {
  it("reads org A's Sentry connection id as not registered to org B, and makes no secret read for it", async () => {
    const { fake, deps } = setup();
    await storeOf(deps).put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    const readsBefore = fake.calls.filter((call) => call.action === "GetSecretValue").length;
    const callsBefore = fake.calls.length;
    const registryB = orgCredentialRegistry(deps, ORG_B);
    expect(await registryB.registration(CON_A)).toBeUndefined();
    expect(await registryB.typeOf(CON_A)).toBeUndefined();
    expect(await registryB.has(CON_A)).toBe(false);
    await expect(registryB.provider(CON_A).issue({}, "read")).rejects.toBeInstanceOf(CredentialUnavailable);
    expect(fake.calls.filter((call) => call.action === "GetSecretValue").length).toBe(readsBefore);
    expect(fake.calls.length).toBe(callsBefore);
    expect(fake.calls.filter((call) => call.sessionOrg === ORG_B)).toEqual([]);
    expect(await storeOf(deps).get(ORG_B, CON_A)).toBeUndefined();
    expect(await orgCredentialRegistry(deps, ORG_A).has(CON_A)).toBe(true);
  });

  it("serves a registration for a new type that names no secret value, with the Grafana host as its pin", async () => {
    const { deps } = setup();
    const store = storeOf(deps);
    await store.put({ orgId: ORG_A, connection: GRAFANA, secret: secretFor(GRAFANA), by: ALICE });
    await store.put({ orgId: ORG_A, connection: { ...DATADOG, connectionId: "con_dddddddddddddddddddd" }, secret: secretFor(DATADOG), by: ALICE });
    const registry = orgCredentialRegistry(deps, ORG_A);
    const grafana = await registry.registration(CON_A);
    expect(grafana).toMatchObject({ ref: CON_A, type: "static-secret", host: "grafana.acme.dev", secretName: orgConnectorSecretName(ENV, ORG_A, CON_A) });
    expect(JSON.stringify(grafana)).not.toContain(secretFor(GRAFANA)!.serviceAccountToken);
    expect((await registry.provider(CON_A, { pin: { host: "grafana.acme.dev", required: true } }).issue({}, "read")).token).toBe(secretFor(GRAFANA)!.serviceAccountToken);
    await expect(registry.provider(CON_A, { pin: { host: "grafana.other.dev", required: true } }).issue({}, "read")).rejects.toBeInstanceOf(CredentialUnavailable);
    expect((await registry.registration("con_dddddddddddddddddddd"))?.host).toBeUndefined();
  });

  it("refuses write access on these read-only connections", async () => {
    const { deps } = setup();
    await storeOf(deps).put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    await expect(orgCredentialRegistry(deps, ORG_A).provider(CON_A).issue({}, "write")).rejects.toBeInstanceOf(CredentialUnavailable);
  });

  it("does not register a CloudWatch connection: it has no secret, and its role is assumed by its own connector", async () => {
    const { deps } = setup();
    await storeOf(deps).put({ orgId: ORG_A, connection: CLOUDWATCH, by: ALICE });
    const registry = orgCredentialRegistry(deps, ORG_A);
    expect(await registry.has(CON_A)).toBe(false);
    expect(await registry.registration(CON_A)).toBeUndefined();
    expect(await registry.typeOf(CON_A)).toBeUndefined();
    await expect(registry.provider(CON_A).issue({}, "read")).rejects.toBeInstanceOf(CredentialUnavailable);
  });

  it("a stored secret that is not the type's shape reads as unavailable and leaks nothing", async () => {
    const { deps, fake } = setup();
    await storeOf(deps).put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    fake.stored(orgConnectorSecretName(ENV, ORG_A, CON_A))!.history.at(-1)!.value = `{"apiKey":"${SENTRY_TOKEN}"}`;
    const unavailable = await failure(orgCredentialRegistry(deps, ORG_A).provider(CON_A).issue({}, "read"));
    expect(unavailable?.name).toBe("CredentialUnavailable");
    expect(unavailable?.message).not.toContain(SENTRY_TOKEN);
  });
});

describe("checking the new connections", () => {
  it("answers that a check is not available yet for a type whose connector task has not supplied one, and records it", async () => {
    const { deps } = setup();
    const store = storeOf(deps);
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    const result = await store.check(ORG_A, CON_A);
    expect(result).toEqual({ ok: false, message: "checking a sentry connection is not available yet" });
    expect((await store.get(ORG_A, CON_A))?.lastCheck).toMatchObject({ ok: false });
  });

  it("hands the type's own check the connection and its saved secret, and records the account it names", async () => {
    const { deps } = setup();
    const check = vi.fn(async () => ({ ok: true, message: "3 projects", actorId: "sentry-user-1" }));
    const store = storeOf(deps, { checks: { sentry: check } });
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: true, message: "3 projects" });
    expect(check).toHaveBeenCalledTimes(1);
    expect(check).toHaveBeenCalledWith({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY) });
    expect((await store.get(ORG_A, CON_A))?.lastCheck).toMatchObject({ ok: true });
    expect(JSON.stringify(await store.get(ORG_A, CON_A))).not.toContain("sentry-user-1");
    expect([...await connectionActorIds(deps, ORG_A, "sentry")]).toEqual(["sentry-user-1"]);
    expect((await connectionActorIds(deps, ORG_B, "sentry")).size).toBe(0);
  });

  it("does not call a type's check for a connection with no secret saved, except CloudWatch which has none", async () => {
    const { deps } = setup();
    const sentry = vi.fn(async () => ({ ok: true }));
    const cloudwatch = vi.fn(async () => ({ ok: true, message: "role assumed" }));
    const store = storeOf(deps, { checks: { sentry, cloudwatch } });
    await store.put({ orgId: ORG_A, connection: SENTRY, by: ALICE });
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: false, message: "no secret has been saved for this connection yet" });
    expect(sentry).not.toHaveBeenCalled();
    await store.put({ orgId: ORG_A, connection: { ...CLOUDWATCH, connectionId: "con_cccccccccccccccccccc" }, by: ALICE });
    expect(await store.check(ORG_A, "con_cccccccccccccccccccc")).toEqual({ ok: true, message: "role assumed" });
    expect(cloudwatch).toHaveBeenCalledWith({ orgId: ORG_A, connection: { ...CLOUDWATCH, connectionId: "con_cccccccccccccccccccc" }, secret: undefined });
  });

  it("reads the secret by the version its own save wrote, so a check never uses a save that lost", async () => {
    const { deps } = setup();
    const seen: unknown[] = [];
    const store = storeOf(deps, { checks: { sentry: async ({ secret }) => { seen.push(secret); return { ok: true }; } } });
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: { authToken: "first-token" }, by: ALICE });
    // A second secret version written behind the record's back (a save that lost the race) is never read.
    await deps.secrets.put(ORG_A, orgConnectorSecretName(ENV, ORG_A, CON_A), JSON.stringify({ authToken: "loser-token" }));
    await store.check(ORG_A, CON_A);
    expect(seen).toEqual([{ authToken: "first-token" }]);
  });

  it("answers a thrown check with a message that names no part of the error, and records it as failed", async () => {
    const { deps } = setup();
    const capture = captureConsole();
    const store = storeOf(deps, { checks: { datadog: async ({ secret }) => { throw new Error(`boom with ${JSON.stringify(secret)}`); } } });
    await store.put({ orgId: ORG_A, connection: DATADOG, secret: secretFor(DATADOG), by: ALICE });
    const result = await store.check(ORG_A, CON_A);
    capture.restore();
    expect(result).toEqual({ ok: false, message: "could not check the saved datadog secret" });
    expect(JSON.stringify([result, capture.lines])).not.toContain("dd-api-key");
    expect((await store.get(ORG_A, CON_A))?.lastCheck).toMatchObject({ ok: false });
  });

  it("checks a Grafana address before the type's check runs, and does not call it when the address is refused", async () => {
    const { deps } = setup();
    const order: string[] = [];
    const grafana = vi.fn(async () => { order.push("check"); return { ok: true }; });
    let allowed = true;
    const store = storeOf(deps, {
      checkEndpoint: async (url) => { order.push(`endpoint:${url}`); if (!allowed) throw new Error("that address is not allowed"); },
      checks: { grafana },
    });
    await store.put({ orgId: ORG_A, connection: GRAFANA, secret: secretFor(GRAFANA), by: ALICE });
    order.length = 0;
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: true });
    expect(order).toEqual(["endpoint:https://grafana.acme.dev", "check"]);
    allowed = false;
    grafana.mockClear();
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: false, message: "that address is not allowed" });
    expect(grafana).not.toHaveBeenCalled();
  });

  it("answers a failed address lookup as retryable and records no check", async () => {
    const { deps } = setup();
    const grafana = vi.fn(async () => ({ ok: true }));
    let lookup = false;
    const store = storeOf(deps, {
      checkEndpoint: async () => { if (lookup) throw Object.assign(new Error("lookup failed"), { code: "RUNTIME_UNAVAILABLE" }); },
      checks: { grafana },
    });
    await store.put({ orgId: ORG_A, connection: GRAFANA, secret: secretFor(GRAFANA), by: ALICE });
    lookup = true;
    expect((await failure(store.check(ORG_A, CON_A)))?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(grafana).not.toHaveBeenCalled();
    expect((await store.get(ORG_A, CON_A))?.lastCheck).toBeUndefined();
  });

  it("forgets the account a check learned when the token moves to another site, and when the CloudWatch role changes", async () => {
    const { deps } = setup();
    const store = storeOf(deps, { checks: { sentry: async () => ({ ok: true, actorId: "u1" }), cloudwatch: async () => ({ ok: true }) } });
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    await store.check(ORG_A, CON_A);
    await store.put({ orgId: ORG_A, connection: { ...SENTRY, label: "Renamed" }, by: ALICE });
    expect((await store.get(ORG_A, CON_A))?.lastCheck).toBeDefined();
    expect([...await connectionActorIds(deps, ORG_A, "sentry")]).toEqual(["u1"]);
    await store.put({ orgId: ORG_A, connection: { ...SENTRY, region: "de" }, secret: secretFor(SENTRY), by: ALICE });
    expect((await store.get(ORG_A, CON_A))?.lastCheck).toBeUndefined();
    expect((await connectionActorIds(deps, ORG_A, "sentry")).size).toBe(0);

    const cw = "con_cccccccccccccccccccc";
    await store.put({ orgId: ORG_A, connection: { ...CLOUDWATCH, connectionId: cw }, by: ALICE });
    await store.check(ORG_A, cw);
    await store.put({ orgId: ORG_A, connection: { ...CLOUDWATCH, connectionId: cw, regions: ["us-west-2"] }, by: ALICE });
    expect((await store.get(ORG_A, cw))?.lastCheck).toBeDefined();
    await store.put({ orgId: ORG_A, connection: { ...CLOUDWATCH, connectionId: cw, roleArn: "arn:aws:iam::123456789012:role/other" }, by: ALICE });
    expect((await store.get(ORG_A, cw))?.lastCheck).toBeUndefined();
  });
});

describe("the connection routes and the new types", () => {
  const REQUEST_ID = "11111111-1111-4111-8111-111111111111";
  const admin = { developerId: ALICE, orgId: ORG_A, orgRole: "admin" } as const;
  const request = (method: string, path: string, body?: unknown) => ({ method, path, headers: {}, requestId: "req-1", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  function routes() {
    const { deps, fake, db } = setup();
    const store = storeOf(deps);
    return { store, fake, db, call: (method: string, path: string, body?: unknown, caller = admin) => routeConnectionRequest({ store, documentClient: db, tableName: "T", now: () => START }, caller, request(method, path, body), new URL(`https://broker.example${path}`)) };
  }

  it("creates a Sentry connection and answers with no token, secret name or actor id", async () => {
    const { call, db, fake } = routes();
    const capture = captureConsole();
    const answer = await call("POST", "/v1/app/connections", { requestId: REQUEST_ID, connection: { type: "sentry", label: "Sentry", access: "read", region: "us", orgSlug: "acme" }, secret: { authToken: SENTRY_TOKEN } });
    capture.restore();
    const text = JSON.stringify(answer);
    expect(text).toContain("hasCredential");
    expect(text).not.toContain(SENTRY_TOKEN);
    expect(text).not.toContain("hasSecret");
    expect(text).not.toContain("actorId");
    expect(capture.lines.join("\n")).not.toContain(SENTRY_TOKEN);
    expect(JSON.stringify([...db.items.values()])).not.toContain(SENTRY_TOKEN);
    expect(fake.calls.filter((c) => c.action === "GetSecretValue")).toEqual([]);
  });

  it("refuses an external id on a CloudWatch body as an unknown field, and shows the stored one", async () => {
    const { call } = routes();
    const body = { requestId: REQUEST_ID, connection: { type: "cloudwatch", label: "CW", access: "read", roleArn: ROLE_ARN, regions: ["us-east-1"], externalId: "rovara-org_cccccccccccccccccccc" } };
    const refusal = await failure(call("POST", "/v1/app/connections", body));
    expect(refusal).toMatchObject({ code: "CONFIG_INVALID", message: "connection: has a field this kind of connection does not take" });
    expect(refusal?.message).not.toContain("externalId");
    const { externalId: _drop, ...clean } = body.connection; // eslint-disable-line @typescript-eslint/no-unused-vars -- the field is dropped on purpose
    const created = await call("POST", "/v1/app/connections", { requestId: "22222222-2222-4222-8222-222222222222", connection: clean });
    expect(JSON.stringify(created)).toContain(`rovara-${ORG_A}`);
  });

  it("refuses access read_write on a Sentry connection with the exact text", async () => {
    const { call, db } = routes();
    const refusal = await failure(call("POST", "/v1/app/connections", { requestId: REQUEST_ID, connection: { type: "sentry", label: "Sentry", access: "read_write", region: "us", orgSlug: "acme" }, secret: { authToken: SENTRY_TOKEN } }));
    expect(refusal).toMatchObject({ code: "CONFIG_INVALID", message: "access: sentry connections are read-only" });
    expect(db.items.size).toBe(0);
  });

  it("answers org B's read, save and removal of org A's Sentry connection as a missing connection", async () => {
    const { call, store } = routes();
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    const adminB = { developerId: "b".repeat(64), orgId: ORG_B, orgRole: "admin" } as const;
    const missing = await failure(call("GET", "/v1/app/connections/con_zzzzzzzzzzzzzzzzzzzz", undefined, adminB));
    expect(await failure(call("GET", `/v1/app/connections/${CON_A}`, undefined, adminB))).toEqual(missing);
    expect(await failure(call("PUT", `/v1/app/connections/${CON_A}`, { requestId: REQUEST_ID, connection: SENTRY, secret: secretFor(SENTRY) }, adminB))).toMatchObject({ code: "NOT_FOUND" });
    expect(await failure(call("DELETE", `/v1/app/connections/${CON_A}`, { requestId: "33333333-3333-4333-8333-333333333333" }, adminB))).toMatchObject({ code: "NOT_FOUND" });
    expect(await store.get(ORG_A, CON_A)).toBeDefined();
  });
});
