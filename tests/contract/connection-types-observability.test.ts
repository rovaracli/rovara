// Plan 4 Task 11: the six new connection types (Sentry, Datadog, CloudWatch, Grafana, Vercel, PagerDuty) on Plan 3's org registry.
// They are read-only, their secrets are write-only like Plan 3's, and each type's check comes from its own connector task through
// the store's `checks` seam. The Secrets Manager and STS fake enforces the role's policies, so org isolation is proven, not assumed.
import { PassThrough } from "node:stream";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CredentialUnavailable } from "@agentx/gateway";
import { orgCredentialRegistry } from "../../packages/broker/src/connections/registry.js";
import { mcpEndpointGuard, type McpEndpointGuard, type RequestFunction } from "../../packages/broker/src/connections/pinned-endpoint.js";
import { OrgConnectionStore, connectionActorIds, readConnection, readConnectionSecret } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets, orgConnectorSecretName } from "../../packages/broker/src/connections/org-secrets.js";
import { routeConnectionRequest } from "../../packages/broker/src/connections/routes.js";
import { ConnectionSecretSchema, ConnectionSecretSchemas, ConnectionTypeSchema, OrgConnectionSchema, connectionKey, connectionSecretToken, type OrgConnection } from "@rovara-code/contracts";
import { DATADOG_SITES, ObservabilityConnectionTypeSchema, cloudwatchExternalId, readOnlyConnectionMessage } from "@rovara-code/contracts";
import type { OrgId } from "@rovara-code/contracts";
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

// An AgentXError's message reads "<CODE>: <text>"; the text is what the plan fixes.
const failure = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string; name?: string }) => ({
  code: error.code, name: error.name, message: error.code !== undefined && error.message.startsWith(`${error.code}: `) ? error.message.slice(error.code.length + 2) : error.message,
}));

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
    expect(DATADOG_SITES).toEqual(["datadoghq.com", "us3.datadoghq.com", "us5.datadoghq.com", "datadoghq.eu", "ap1.datadoghq.com", "ap2.datadoghq.com", "ddog-gov.com", "us2.ddog-gov.com", "uk1.datadoghq.com"]);
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
    // checkEndpointUrl refuses any port but 443 at every call, so a Grafana address with another port is refused when it is saved, in words that say why (review M-1).
    for (const baseUrl of ["https://grafana.acme.dev:3000", "https://grafana.acme.dev:8443/grafana", "https://grafana.acme.dev:80"]) {
      const parsed = OrgConnectionSchema.safeParse({ ...GRAFANA, baseUrl });
      expect(parsed.success, baseUrl).toBe(false);
      expect(parsed.error?.issues.map((issue) => issue.message), baseUrl).toEqual(["baseUrl must use the standard https port (443); Grafana on another port is not supported"]);
    }
    expect(OrgConnectionSchema.safeParse({ ...GRAFANA, baseUrl: "https://grafana.acme.dev:443" }).success).toBe(true);
    // An address with no port, or that is not a URL, is not also told about a port.
    expect(OrgConnectionSchema.safeParse({ ...GRAFANA, baseUrl: "grafana.acme.dev" }).error?.issues.map((issue) => issue.message)).toEqual(["baseUrl must be an absolute URL"]);
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
      expect(await store.get(ORG_A, CON_A)).toMatchObject({ type: connection.type, hasSecret: true, access: "read" });
      expect(await readConnectionSecret(deps, ORG_A, (await readConnection(deps, ORG_A, CON_A))!)).toEqual(secretFor(connection));
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
      [VERCEL, { token: "FINE-TOKEN-VALUE", extra: "EXTRA-VALUE" }],
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
      expect(refusal, connection.type).toMatchObject({ code: "CONFIG_INVALID", message: `access: ${connection.type} connections are read-only` });
      expect(readOnlyConnectionMessage(connection.type as "sentry")).toBe(`access: ${connection.type} connections are read-only`);
      expect(db.items.size).toBe(0);
      expect(fake.calls.filter((call) => call.service === "secretsmanager")).toEqual([]);
    }
    // Lowering a saved read connection to read_write is refused the same way, and the record stays as it was.
    const { db, deps } = setup();
    const store = storeOf(deps);
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    const before = JSON.stringify(db.get(connectionKey(ORG_A, CON_A)));
    expect((await failure(store.put({ orgId: ORG_A, connection: { ...SENTRY, access: "read_write" }, by: ALICE })))?.message).toBe("access: sentry connections are read-only");
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
    for (const [index, { connection: base, change }] of moved.entries()) {
      // Each type gets its own id: a removed connection's secret is waiting for deletion and its name cannot be written again.
      const connection = { ...base, connectionId: `con_move${String(index).padStart(16, "0")}` } as OrgConnection;
      await store.put({ orgId: ORG_A, connection, secret: secretFor(connection), by: ALICE });
      const refusal = await failure(store.put({ orgId: ORG_A, connection: { ...connection, ...change }, by: ALICE }));
      expect(refusal, connection.type).toMatchObject({ code: "CONFIG_INVALID", message: "connection: the saved secret would be sent to a different host; give the new secret with it" });
      expect(await store.get(ORG_A, connection.connectionId)).toMatchObject(connection);
      await store.put({ orgId: ORG_A, connection: { ...connection, ...change }, secret: secretFor(connection), by: ALICE });
      expect(await store.get(ORG_A, connection.connectionId)).toMatchObject(change);
    }
    // A label, an org slug or a team id goes to the same place, so the saved token stays.
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    await store.put({ orgId: ORG_A, connection: { ...SENTRY, orgSlug: "other-org", label: "Other" }, by: ALICE });
    expect(await store.get(ORG_A, CON_A)).toMatchObject({ orgSlug: "other-org", hasSecret: true });
    expect((await orgCredentialRegistry(deps, ORG_A).provider(CON_A).issue({}, "read")).token).toBe(SENTRY_TOKEN);
    const vercel = { ...VERCEL, connectionId: "con_vvvvvvvvvvvvvvvvvvvv" };
    await store.put({ orgId: ORG_A, connection: vercel, secret: secretFor(VERCEL), by: ALICE });
    await store.put({ orgId: ORG_A, connection: { ...vercel, teamId: "team_abc123" }, by: ALICE });
    expect(await store.get(ORG_A, vercel.connectionId)).toMatchObject({ teamId: "team_abc123", hasSecret: true });
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
    expect((await registry.registration("con_dddddddddddddddddddd"))?.host).toBe("api.datadoghq.eu");
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
    expect(check).toHaveBeenCalledWith({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), fetch: expect.any(Function) as unknown });
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
    expect(cloudwatch).toHaveBeenCalledWith({ orgId: ORG_A, connection: { ...CLOUDWATCH, connectionId: "con_cccccccccccccccccccc" }, secret: undefined, fetch: expect.any(Function) as unknown });
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
    expect(result).toEqual({ ok: false, message: "could not check the datadog connection" });
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
      endpointGuard: async () => fetch,
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

  it("answers a check that could not reach its vendor as retryable, records nothing, and names nothing it threw", async () => {
    const { deps } = setup();
    const store = storeOf(deps, { checks: { pagerduty: async () => { throw Object.assign(new Error(`down: ${JSON.stringify(secretFor(PAGERDUTY))}`), { code: "RUNTIME_UNAVAILABLE" }); } } });
    await store.put({ orgId: ORG_A, connection: PAGERDUTY, secret: secretFor(PAGERDUTY), by: ALICE });
    const refusal = await failure(store.check(ORG_A, CON_A));
    expect(refusal).toMatchObject({ code: "RUNTIME_UNAVAILABLE", message: "could not reach pagerduty to check the connection; try again" });
    expect(refusal?.message).not.toContain("pd-api-key");
    expect((await store.get(ORG_A, CON_A))?.lastCheck).toBeUndefined();
  });

  it("answers a failed address lookup as retryable and records no check", async () => {
    const { deps } = setup();
    const grafana = vi.fn(async () => ({ ok: true }));
    let lookup = false;
    const store = storeOf(deps, {
      checkEndpoint: async () => { if (lookup) throw Object.assign(new Error("lookup failed"), { code: "RUNTIME_UNAVAILABLE" }); },
      endpointGuard: async () => fetch,
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


// ---------------------------------------------------------------------------------------------------------------------------------------------
// Task 11 fix round 1 (review I1, M1, M3, M7): a check is given a fetch it cannot misuse; a token is issued only to its vendor's host; a check's
// message is capped and cleaned before it is recorded or answered.
// ---------------------------------------------------------------------------------------------------------------------------------------------

const PUBLIC = "52.1.2.3";
const GRAFANA_HEALTH = "https://grafana.acme.dev/api/health";
const MCP: OrgConnection = { connectionId: CON_A, type: "mcp", label: "Docs", access: "read", endpoint: "https://mcp.acme.dev/mcp", vendor: "Docs" };

/** A node `request` stand-in that records what it was asked and answers with `status`, so no test reaches a network. */
function recordingRequest(status = 200, headers: Record<string, string> = {}) {
  const calls: Array<{ url: URL; options: { lookup: (host: string, options: object, callback: (...args: unknown[]) => void) => void; agent: unknown } }> = [];
  const request = vi.fn((url: URL, options: never, callback?: (response: unknown) => void) => {
    calls.push({ url, options });
    return {
      on: () => undefined,
      destroy: () => undefined,
      end: () => { const response = Object.assign(new PassThrough(), { statusCode: status, headers, statusMessage: "" }); response.end("{}"); callback?.(response); },
    } as never;
  });
  return { request: request as unknown as RequestFunction, calls };
}

const lookupAnswer = (lookup: (host: string, options: object, callback: (...args: unknown[]) => void) => void) =>
  new Promise<unknown[]>((resolve) => lookup("grafana.acme.dev", { all: true }, (...args) => resolve(args)));

describe("a check's fetch (review I1, M7)", () => {
  /** Runs a Grafana check that calls each of `urls` with its fetch, and answers what each call did. */
  async function grafanaCalls(guard: McpEndpointGuard, urls: string[], options: { init?: RequestInit } = {}) {
    const { deps } = setup();
    const outcomes: string[] = [];
    const grafana = vi.fn(async ({ fetch: pinned }: { fetch: typeof fetch }) => {
      for (const url of urls) outcomes.push(await pinned(url, options.init).then((response) => `status ${String(response.status)}`, (error: Error) => error.message));
      return { ok: true };
    });
    const store = storeOf(deps, { endpointGuard: guard, checks: { grafana } });
    await store.put({ orgId: ORG_A, connection: GRAFANA, secret: secretFor(GRAFANA), by: ALICE });
    const result = await store.check(ORG_A, CON_A);
    return { result, outcomes, grafana, store };
  }

  it("connects Grafana's check only to the addresses checked for this very request, asking DNS once", async () => {
    const { request, calls } = recordingRequest();
    const resolveHost = vi.fn(async () => [PUBLIC]);
    const { result, outcomes } = await grafanaCalls(mcpEndpointGuard({ resolveHost, request }), [GRAFANA_HEALTH]);
    expect(result).toEqual({ ok: true });
    expect(outcomes).toEqual(["status 200"]);
    expect(resolveHost).toHaveBeenCalledWith("grafana.acme.dev");
    expect(calls).toHaveLength(1);
    // The connection is made with a lookup that answers only the checked address and never asks DNS, on a connection of its own.
    expect(await lookupAnswer(calls[0]!.options.lookup)).toEqual([null, [{ address: PUBLIC, family: 4 }]]);
    expect(calls[0]!.options.agent).toBe(false);
    expect(calls[0]!.url.href).toBe(GRAFANA_HEALTH);
  });

  it("refuses a redirect from Grafana, which could lead to a private address", async () => {
    const { request, calls } = recordingRequest(302, { location: "http://169.254.169.254/latest/meta-data/" });
    const { outcomes } = await grafanaCalls(mcpEndpointGuard({ resolveHost: async () => [PUBLIC], request }), [GRAFANA_HEALTH]);
    expect(outcomes).toEqual(["fetch failed: a redirect was refused"]);
    expect(calls).toHaveLength(1);
  });

  it("refuses any request to another origin, an address, another scheme or another port, making none", async () => {
    const { request, calls } = recordingRequest();
    const urls = ["https://evil.example/", "https://169.254.169.254/", "https://[::1]/", "http://grafana.acme.dev/api/health", "https://grafana.acme.dev:8443/api/health", "https://grafana.acme.dev.evil.example/"];
    const { outcomes } = await grafanaCalls(mcpEndpointGuard({ resolveHost: async () => [PUBLIC], request }), urls);
    expect(outcomes).toEqual(urls.map(() => "a request to anywhere but the checked endpoint was refused"));
    expect(calls).toEqual([]);
  });

  it("gives the guard the connection's own address, and answers a refused address as a failed check without running the type's check", async () => {
    const { deps } = setup();
    const seen: string[] = [];
    let refuse = false;
    const grafana = vi.fn(async () => ({ ok: true }));
    const store = storeOf(deps, {
      endpointGuard: async (endpoint) => { seen.push(endpoint.href); if (refuse) throw Object.assign(new Error("that address is not allowed"), { code: "CONFIG_INVALID" }); return fetch; },
      checks: { grafana },
    });
    await store.put({ orgId: ORG_A, connection: GRAFANA, secret: secretFor(GRAFANA), by: ALICE });
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: true });
    expect(seen).toEqual(["https://grafana.acme.dev/"]);
    refuse = true;
    grafana.mockClear();
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: false, message: "that address is not allowed" });
    expect(grafana).not.toHaveBeenCalled();
    expect((await store.get(ORG_A, CON_A))?.lastCheck).toMatchObject({ ok: false });
  });

  it("answers a guard whose address lookup failed as retryable, records nothing and runs no check", async () => {
    const { deps } = setup();
    const grafana = vi.fn(async () => ({ ok: true }));
    let down = false;
    const store = storeOf(deps, {
      endpointGuard: async () => { if (down) throw Object.assign(new Error("lookup failed"), { code: "RUNTIME_UNAVAILABLE" }); return fetch; },
      checks: { grafana },
    });
    await store.put({ orgId: ORG_A, connection: GRAFANA, secret: secretFor(GRAFANA), by: ALICE });
    down = true;
    expect((await failure(store.check(ORG_A, CON_A)))?.code).toBe("RUNTIME_UNAVAILABLE");
    expect(grafana).not.toHaveBeenCalled();
    expect((await store.get(ORG_A, CON_A))?.lastCheck).toBeUndefined();
  });

  it("pins the MCP check's tool listing to the checked addresses too, and refuses an MCP endpoint the guard refuses", async () => {
    const { deps } = setup();
    const pinned = (async () => new Response("{}")) as typeof fetch;
    const seen: Array<{ endpoint: string; fetchImplementation: unknown }> = [];
    const listMcpTools = vi.fn(async (input: { endpoint: URL; fetchImplementation?: unknown }) => { seen.push({ endpoint: input.endpoint.href, fetchImplementation: input.fetchImplementation }); return [{ name: "a" }]; });
    let refuse = false;
    const guarded: string[] = [];
    const store = storeOf(deps, {
      endpointGuard: async (endpoint) => { guarded.push(endpoint.href); if (refuse) throw new Error("that address is not allowed"); return pinned; },
      fetch: (async () => { throw new Error("the unpinned fetch was used"); }),
      listMcpTools: listMcpTools as never,
    });
    await store.put({ orgId: ORG_A, connection: MCP, secret: { token: "mcp-secret-0123456789" }, by: ALICE });
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: true, message: "1 tool" });
    expect(seen).toEqual([{ endpoint: "https://mcp.acme.dev/mcp", fetchImplementation: pinned }]);
    expect(guarded).toEqual(["https://mcp.acme.dev/mcp"]);
    refuse = true;
    listMcpTools.mockClear();
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: false, message: "that address is not allowed" });
    expect(listMcpTools).not.toHaveBeenCalled();
  });

  const OWN: Array<[string, OrgConnection, string]> = [
    ["Sentry (us)", SENTRY, "https://us.sentry.io/api/0/organizations/acme/"],
    ["Sentry (de)", { ...SENTRY, region: "de" }, "https://de.sentry.io/api/0/organizations/acme/"],
    ["Datadog", DATADOG, "https://api.datadoghq.eu/api/v1/validate"],
    ["Datadog (gov)", { ...DATADOG, site: "ddog-gov.com" }, "https://api.ddog-gov.com/api/v1/validate"],
    ["PagerDuty (us)", { ...PAGERDUTY, region: "us" }, "https://api.pagerduty.com/abilities"],
    ["PagerDuty (eu)", PAGERDUTY, "https://api.eu.pagerduty.com/abilities"],
    ["Vercel", VERCEL, "https://api.vercel.com/v2/user"],
  ];

  it.each(OWN)("holds %s's check to its vendor's origin, follows no redirect and refuses anywhere else", async (_name, connection, own) => {
    const { deps } = setup();
    const base = vi.fn(async () => new Response("{}"));
    const outcomes: string[] = [];
    const origin = new URL(own).origin;
    const elsewhere = [
      "https://evil.example/", `${origin.replace("https://", "https://x.")}/`, `${origin}.evil.example/`, `${origin.replace("https:", "http:")}/`, `${origin}:8443/`,
      "https://169.254.169.254/", "https://api.vercel.com.evil.example/", "https://sentry.io/",
    ].filter((url) => new URL(url).origin !== origin);
    const check = vi.fn(async ({ fetch: held }: { fetch: typeof fetch }) => {
      outcomes.push((await held(own, { redirect: "follow", headers: { authorization: "x" } })).status === 200 ? "own ok" : "own failed");
      outcomes.push((await held(new URL(own))).status === 200 ? "url ok" : "url failed");
      outcomes.push((await held(new Request(own))).status === 200 ? "request ok" : "request failed");
      // A login in the address does not change its origin, so it is refused by name.
      outcomes.push(await held(own.replace("https://", "https://user:pw@")).then(() => "reached", (error: Error) => error.message));
      for (const url of elsewhere) outcomes.push(await held(url).then(() => "reached", (error: Error) => error.message));
      outcomes.push(await held(new Request(own.replace(origin, "https://evil.example"))).then(() => "reached", (error: Error) => error.message));
      return { ok: true };
    });
    const store = storeOf(deps, { fetch: base, checks: { [connection.type]: check } });
    await store.put({ orgId: ORG_A, connection, secret: secretFor(connection), by: ALICE });
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: true });
    expect(outcomes).toEqual(["own ok", "url ok", "request ok", "a request to anywhere but the vendor's address was refused", ...elsewhere.map(() => "a request to anywhere but the vendor's address was refused"), "a request to anywhere but the vendor's address was refused"]);
    // Three calls got through, each told never to follow a redirect, whatever the caller asked for.
    expect(base).toHaveBeenCalledTimes(3);
    expect(base.mock.calls.map((call) => (call as unknown as [unknown, RequestInit])[1].redirect)).toEqual(["error", "error", "error"]);
  });

  it("gives CloudWatch's check a fetch that reaches nowhere, since it speaks to AWS through its own client", async () => {
    const { deps } = setup();
    const base = vi.fn(async () => new Response("{}"));
    let outcome = "";
    const store = storeOf(deps, { fetch: base, checks: { cloudwatch: async ({ fetch: held }) => { outcome = await held("https://monitoring.us-east-1.amazonaws.com/").then(() => "reached", (error: Error) => error.message); return { ok: true }; } } });
    await store.put({ orgId: ORG_A, connection: CLOUDWATCH, by: ALICE });
    await store.check(ORG_A, CON_A);
    expect(outcome).toMatch(/refused/u);
    expect(base).not.toHaveBeenCalled();
  });

  it("builds a Grafana check's fetch from mcpEndpointGuard when none is injected, so no check runs on an unpinned fetch", async () => {
    const { deps } = setup();
    const grafana = vi.fn(async () => ({ ok: true }));
    // No guard injected: the store's own is the real one, which resolves the host itself. The name below does not exist, so the check cannot run.
    const store = storeOf(deps, { checks: { grafana } });
    await store.put({ orgId: ORG_A, connection: { ...GRAFANA, baseUrl: "https://never-resolves.example.invalid" }, secret: secretFor(GRAFANA), by: ALICE });
    const outcome = await store.check(ORG_A, CON_A).then((answer) => answer, (error: { code?: string }) => ({ code: error.code }));
    expect(grafana).not.toHaveBeenCalled();
    expect(outcome).toSatisfy((value: unknown) => (value as { code?: string }).code === "RUNTIME_UNAVAILABLE" || (value as { ok?: boolean }).ok === false);
  });
});

describe("a token goes only to its vendor's host (review M1)", () => {
  const HOSTS: Array<[string, OrgConnection, string]> = [
    ["Sentry us", SENTRY, "us.sentry.io"],
    ["Sentry de", { ...SENTRY, region: "de" }, "de.sentry.io"],
    ["Datadog", DATADOG, "api.datadoghq.eu"],
    ["Datadog us3", { ...DATADOG, site: "us3.datadoghq.com" }, "api.us3.datadoghq.com"],
    ["Datadog us2 gov", { ...DATADOG, site: "us2.ddog-gov.com" }, "api.us2.ddog-gov.com"],
    ["Datadog uk1", { ...DATADOG, site: "uk1.datadoghq.com" }, "api.uk1.datadoghq.com"],
    ["PagerDuty us", { ...PAGERDUTY, region: "us" }, "api.pagerduty.com"],
    ["PagerDuty eu", PAGERDUTY, "api.eu.pagerduty.com"],
    ["Vercel", VERCEL, "api.vercel.com"],
  ];

  it.each(HOSTS)("pins %s to %s: its registration names it, and a token is issued for that host only", async (_name, connection, host) => {
    const { deps } = setup();
    await storeOf(deps).put({ orgId: ORG_A, connection, secret: secretFor(connection), by: ALICE });
    const registry = orgCredentialRegistry(deps, ORG_A);
    expect((await registry.registration(CON_A))?.host).toBe(host);
    const issued = await registry.provider(CON_A, { pin: { host, required: true } }).issue({}, "read");
    expect(issued.token).toBe(connectionSecretToken(connection.type as "sentry", secretFor(connection) as never));
    for (const other of HOSTS.map((entry) => entry[2]).filter((entry) => entry !== host).concat("evil.example")) {
      await expect(registry.provider(CON_A, { pin: { host: other, required: true } }).issue({}, "read"), other).rejects.toBeInstanceOf(CredentialUnavailable);
      // A connector that does not insist on a pin is still held to the host the record names.
      await expect(registry.provider(CON_A, { pin: { host: other, required: false } }).issue({}, "read"), other).rejects.toBeInstanceOf(CredentialUnavailable);
    }
  });

  it("derives the host from the region or site the connection names, and names none for CloudWatch, whose connector assumes a role", async () => {
    const { vendorHostOf } = await import("../../packages/broker/src/connections/vendor-hosts.js");
    expect(vendorHostOf(SENTRY)).toBe("us.sentry.io");
    expect(vendorHostOf({ ...DATADOG, site: "ap2.datadoghq.com" })).toBe("api.ap2.datadoghq.com");
    expect(vendorHostOf(CLOUDWATCH)).toBeUndefined();
    expect(vendorHostOf(GRAFANA)).toBeUndefined();
    for (const site of DATADOG_SITES) expect(vendorHostOf({ ...DATADOG, site })).toBe(`api.${site}`);
  });
});

describe("a check's message (review M3)", () => {
  it("caps a message at 300 characters and strips control characters, in the answer and in what is recorded", async () => {
    const { deps } = setup();
    const long = `${"x".repeat(400)}`;
    const store = storeOf(deps, { checks: { sentry: async () => ({ ok: false, message: `bad\u0000 token\u001b[31m ${long}\u202e\u200b\n\tend\u2028\u2029` }) } });
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    const answer = await store.check(ORG_A, CON_A);
    expect(answer.ok).toBe(false);
    expect(answer.message!.length).toBeLessThanOrEqual(300);
    expect(answer.message).not.toMatch(/[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u);
    expect(answer.message!.startsWith("bad token[31m xxx")).toBe(true);
  });

  it("strips the line and paragraph separators U+2028 and U+2029, which hide the rest of a line (review A-M3)", async () => {
    const { deps } = setup();
    const store = storeOf(deps, { checks: { sentry: async () => ({ ok: false, message: "first\u2028second\u2029third" }) } });
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    expect((await store.check(ORG_A, CON_A)).message).toBe("firstsecondthird");
  });

  it("replaces every value of the saved secret that a check's message holds with [redacted], however the vendor quoted it (review A-M3)", async () => {
    const { deps } = setup();
    const quoted = `Sentry said: invalid token ${SENTRY_TOKEN}; again ${SENTRY_TOKEN} and split ${SENTRY_TOKEN.slice(0, 8)}\u0000${SENTRY_TOKEN.slice(8)}`;
    const sentry = storeOf(deps, { checks: { sentry: async () => ({ ok: false, message: quoted }) } });
    await sentry.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    const answer = await sentry.check(ORG_A, CON_A);
    expect(answer.message).toBe("Sentry said: invalid token [redacted]; again [redacted] and split [redacted]");
    expect(JSON.stringify(answer)).not.toContain(SENTRY_TOKEN);
    // A connection with two secret values (Datadog's API and application keys) has both replaced; the message is no longer after the cap.
    const other = setup();
    // The cap (300) falls inside the API key: 279 characters and the 11 of `{"apiKey":"` put the key at 290. A cap that ran first would leave its first ten characters.
    const datadog = storeOf(other.deps, { checks: { datadog: async ({ secret }) => ({ ok: false, message: `${"x".repeat(279)}${JSON.stringify(secret)}` }) } });
    await datadog.put({ orgId: ORG_A, connection: DATADOG, secret: secretFor(DATADOG), by: ALICE });
    const refused = await datadog.check(ORG_A, CON_A);
    expect(refused.message!.length).toBeLessThanOrEqual(300);
    expect(refused.message).toContain("[redacted]");
    for (const key of [secretFor(DATADOG)!.apiKey, secretFor(DATADOG)!.appKey]) {
      for (let start = 0; start + 6 <= key!.length; start += 1) expect(refused.message!.includes(key!.slice(start, start + 6)), key!.slice(start, start + 6)).toBe(false);
    }
    const both = storeOf(other.deps, { checks: { datadog: async () => ({ ok: false, message: "api dd-api-key-0123456789 app dd-app-key-0123456789" }) } });
    expect((await both.check(ORG_A, CON_A)).message).toBe("api [redacted] app [redacted]");
  });

  it("leaves alone a message that holds no secret value, and a check with no secret to hold (CloudWatch)", async () => {
    const { deps } = setup();
    const store = storeOf(deps, { checks: { cloudwatch: async () => ({ ok: false, message: "the role could not be assumed" }) } });
    await store.put({ orgId: ORG_A, connection: CLOUDWATCH, by: ALICE });
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: false, message: "the role could not be assumed" });
  });

  it("leaves a short clean message alone, drops a message that is nothing but control characters, and counts code points not units", async () => {
    const { deps } = setup();
    let message: string | undefined = "3 projects";
    const store = storeOf(deps, { checks: { sentry: async () => ({ ok: true, ...(message === undefined ? {} : { message }) }) } });
    await store.put({ orgId: ORG_A, connection: SENTRY, secret: secretFor(SENTRY), by: ALICE });
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: true, message: "3 projects" });
    message = "\u0000\u0007\u202e";
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: true });
    message = "\u{1F600}".repeat(300);
    expect(Array.from((await store.check(ORG_A, CON_A)).message!)).toHaveLength(300);
    message = "\u{1F600}".repeat(301);
    expect(Array.from((await store.check(ORG_A, CON_A)).message!)).toHaveLength(300);
  });
});

describe("which connectors go through the endpoint guard (review I1, hand-off to Task 16)", () => {
  it("names the connection types whose address a person typed, which Grafana's runtime connector must go through the guard as MCP's does", async () => {
    const { HOST_TYPED_CONNECTOR_TYPES } = await import("../../packages/broker/src/aws/connector-presets.js");
    expect([...HOST_TYPED_CONNECTOR_TYPES]).toEqual(["mcp", "grafana"]);
  });
});
