// Plan 3 Task 12b: what the routes need of the connection store beyond 12a - the request item (R18) written with the change,
// writes conditional on what they read, the endpoint check at save, and clearing an org's connections when it closes.
import { describe, expect, it, vi } from "vitest";
import { agentRequestKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { connectionKey } from "../../packages/contracts/src/connections.js";
import type { OrgConnection } from "../../packages/contracts/src/connections.js";
import type { OrgId } from "../../packages/contracts/src/org.js";
import { checkEndpointUrl } from "../../packages/broker/src/connections/endpoint-check.js";
import { OrgSecrets, orgConnectorSecretName, orgHookSecretName } from "../../packages/broker/src/connections/org-secrets.js";
import { HookSecretStore, OrgConnectionStore, clearOrgConnections, connectionActorIds } from "../../packages/broker/src/connections/store.js";
import { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";

const ORG_A = "org_aaaaaaaaaaaaaaaaaaaa" as OrgId;
const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const ENV = "staging";
const CON_A = "con_aaaaaaaaaaaaaaaaaaaa";
const CON_B = "con_bbbbbbbbbbbbbbbbbbbb";
const ALICE = "a".repeat(64);
const START = Date.parse("2026-10-22T09:00:00.000Z");
const LINEAR: OrgConnection = { connectionId: CON_A, type: "linear", label: "Linear", access: "read" };
const MCP: OrgConnection = { connectionId: CON_A, type: "mcp", label: "Sentry", access: "read", endpoint: "https://mcp.acme.dev/mcp", vendor: "Sentry" };
const request = (requestId: string, fingerprint = "f1", orgId: OrgId = ORG_A) => ({ orgId, developerId: ALICE, requestId, fingerprint });
const R1 = "11111111-1111-4111-8111-111111111111";
const R2 = "22222222-2222-4222-8222-222222222222";

function setup() {
  const clock = { now: START };
  const fake = new FakeOrgSecrets({ env: ENV, now: () => clock.now });
  const db = new FakeDynamoDb();
  const secrets = new OrgSecrets({ env: ENV, roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: () => clock.now });
  const deps = { documentClient: db, tableName: "T", env: ENV, secrets, now: () => clock.now };
  const allow = vi.fn(async () => undefined);
  const store = new OrgConnectionStore({ ...deps, checkEndpoint: allow });
  return { clock, fake, db, secrets, deps, store, allow };
}

const code = (promise: Promise<unknown>) => promise.then(() => undefined, (error: { code?: string; message: string }) => ({ code: error.code, message: error.message }));

describe("the request item (R18) of a connection write", () => {
  it("is written in the same transaction as a new connection, and a repeat of the request id is refused whole", async () => {
    const { store, db } = setup();
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: "k1" }, by: ALICE, request: request(R1) });
    expect(db.get(agentRequestKey(ORG_A, ALICE, R1))).toMatchObject({ fingerprint: "f1", result: expect.objectContaining({ connectionId: CON_A, hasSecret: true }) as unknown });
    expect(JSON.stringify(db.get(agentRequestKey(ORG_A, ALICE, R1)))).not.toContain("k1");
    // The same id for another change: nothing about the connection moves.
    const refused = await code(store.put({ orgId: ORG_A, connection: { ...LINEAR, label: "Other" }, by: ALICE, request: request(R1, "f2") }));
    expect(refused?.code).toBe("IDEMPOTENCY_CONFLICT");
    expect((await store.get(ORG_A, CON_A))?.label).toBe("Linear");
  });

  it("is written with a change to an existing connection, and with a removal", async () => {
    const { store, db } = setup();
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: "k1" }, by: ALICE });
    await store.put({ orgId: ORG_A, connection: { ...LINEAR, label: "Renamed" }, by: ALICE, request: request(R1) });
    expect(db.get(agentRequestKey(ORG_A, ALICE, R1))).toBeDefined();
    await store.remove({ orgId: ORG_A, connectionId: CON_A, by: ALICE, request: request(R2) });
    expect(db.get(agentRequestKey(ORG_A, ALICE, R2))).toMatchObject({ result: { removed: true } });
    expect(db.get(connectionKey(ORG_A, CON_A))).toBeUndefined();
  });

  it("leaves no request item when the write is refused, so a corrected retry is a new write", async () => {
    const { store, db } = setup();
    expect((await code(store.remove({ orgId: ORG_A, connectionId: CON_A, by: ALICE, request: request(R1) })))?.code).toBe("NOT_FOUND");
    expect(db.get(agentRequestKey(ORG_A, ALICE, R1))).toBeUndefined();
  });

  it("does not list the request item among the org's connections", async () => {
    const { store } = setup();
    await store.put({ orgId: ORG_A, connection: LINEAR, by: ALICE, request: request(R1) });
    expect((await store.list(ORG_A)).map((c) => c.connectionId)).toEqual([CON_A]);
  });
});

describe("a connection write is conditional on what it read", () => {
  it("refuses a change when the record changed after it was read, and writes neither the record nor the request item", async () => {
    const { deps, db, fake } = setup();
    const store = new OrgConnectionStore({ ...deps, documentClient: { send: async (command: unknown) => {
      // Another admin saves a change between this one's read and its write.
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand" && !raced) {
        raced = true;
        await other.put({ orgId: ORG_A, connection: { ...LINEAR, label: "Theirs" }, by: "b".repeat(64) });
      }
      return db.send(command as never);
    } } });
    let raced = false;
    const other = new OrgConnectionStore(deps);
    await other.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: "k1" }, by: ALICE });
    const refused = await code(store.put({ orgId: ORG_A, connection: { ...LINEAR, label: "Mine" }, by: ALICE, request: request(R1) }));
    expect(refused?.code).toBe("CHANGE_STALE");
    expect((await other.get(ORG_A, CON_A))?.label).toBe("Theirs");
    expect(db.get(agentRequestKey(ORG_A, ALICE, R1))).toBeUndefined();
    expect(fake.secrets.size).toBe(1);
  });

  it("refuses to create a connection that appeared after it was read", async () => {
    const { deps, db } = setup();
    let raced = false;
    const other = new OrgConnectionStore(deps);
    const store = new OrgConnectionStore({ ...deps, documentClient: { send: async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand" && !raced) {
        raced = true;
        await other.put({ orgId: ORG_A, connection: LINEAR, by: "b".repeat(64) });
      }
      return db.send(command as never);
    } } });
    expect((await code(store.put({ orgId: ORG_A, connection: { ...LINEAR, label: "Mine" }, by: ALICE })))?.code).toBe("CHANGE_STALE");
  });

  it("changes only a connection that exists when asked to (a PUT never makes up an id)", async () => {
    const { store, fake, db } = setup();
    const refused = await code(store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: "k1" }, by: ALICE, requireExisting: true }));
    expect(refused?.code).toBe("NOT_FOUND");
    expect(fake.calls).toEqual([]);
    expect(db.items.size).toBe(0);
  });

  it("drops what a check learned about the old secret when the secret is replaced while the check is running", async () => {
    const { deps } = setup();
    // The vendor answers slowly; meanwhile an admin saves a new key, which belongs to another account.
    const store: OrgConnectionStore = new OrgConnectionStore({ ...deps, fetch: async () => {
      await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: "k2" }, by: ALICE });
      return new Response(JSON.stringify({ data: { viewer: { id: "old-account" } } }), { status: 200 });
    } });
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: "k1" }, by: ALICE });
    await store.check(ORG_A, CON_A);
    expect(await connectionActorIds(deps, ORG_A, "linear")).toEqual(new Set());
    expect((await store.get(ORG_A, CON_A))?.lastCheck).toBeUndefined();
  });

  it("writes a check's result and its request item together", async () => {
    const { deps, db } = setup();
    const store = new OrgConnectionStore({ ...deps, fetch: async () => new Response(JSON.stringify({ data: { viewer: { id: "u1" } } }), { status: 200 }) });
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: "k1" }, by: ALICE });
    expect(await store.check(ORG_A, CON_A, request(R1))).toEqual({ ok: true });
    expect(db.get(agentRequestKey(ORG_A, ALICE, R1))).toMatchObject({ result: { ok: true } });
    expect((await store.get(ORG_A, CON_A))?.lastCheck).toMatchObject({ ok: true });
    expect(await connectionActorIds(deps, ORG_A, "linear")).toEqual(new Set(["u1"]));
  });
});

describe("an MCP endpoint is checked when a connection is saved", () => {
  it("refuses to save without an endpoint check, or when the check refuses, before any secret is written", async () => {
    const { deps, fake, db } = setup();
    const bare = new OrgConnectionStore(deps);
    expect((await code(bare.put({ orgId: ORG_A, connection: MCP, secret: { token: "t" }, by: ALICE })))?.code).toBe("CONFIG_INVALID");
    const refusing = new OrgConnectionStore({ ...deps, checkEndpoint: async () => { throw new Error("the endpoint host resolves to an address that is not a public address"); } });
    expect(await code(refusing.put({ orgId: ORG_A, connection: MCP, secret: { token: "t" }, by: ALICE }))).toMatchObject({ message: expect.stringContaining("not a public address") as string });
    expect(fake.calls).toEqual([]);
    expect(db.items.size).toBe(0);
  });

  it("refuses a host that now resolves to a private address, at save and again at check, before any request is made", async () => {
    const { deps } = setup();
    let address = "52.1.2.3";
    const resolver = async () => [address];
    const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
    const tools = vi.fn(async () => [{ name: "a" }]);
    const store = new OrgConnectionStore({ ...deps, fetch: fetchSpy, listMcpTools: tools as never, checkEndpoint: async (url) => { await checkEndpointUrl(url, resolver); } });
    await store.put({ orgId: ORG_A, connection: MCP, secret: { token: "t" }, by: ALICE });
    expect(await store.check(ORG_A, CON_A)).toEqual({ ok: true, message: "1 tool" });
    address = "10.1.2.3";
    const result = await store.check(ORG_A, CON_A);
    expect(result.ok).toBe(false);
    expect(result.message).toContain("not a public address");
    expect(result.message).not.toContain("10.1.2.3");
    expect(tools).toHaveBeenCalledTimes(1);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect((await code(store.put({ orgId: ORG_A, connection: { ...MCP, label: "Again" }, by: ALICE })))?.code).toBe("CONFIG_INVALID");
  });
});

describe("clearing an org's connections when it closes", () => {
  it("schedules every connection secret and hook secret of that org for deletion and removes the records, leaving other orgs alone", async () => {
    const { deps, store, fake, db } = setup();
    const hooks = new HookSecretStore({ env: ENV, secrets: deps.secrets });
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: "k1" }, by: ALICE });
    await store.put({ orgId: ORG_A, connection: { ...MCP, connectionId: CON_B }, secret: { token: "t" }, by: ALICE });
    await store.put({ orgId: ORG_A, connection: { ...LINEAR, connectionId: "con_cccccccccccccccccccc" }, by: ALICE });
    await store.put({ orgId: ORG_B, connection: LINEAR, secret: { apiKey: "other" }, by: ALICE });
    await hooks.put(ORG_A, "hok_aaaaaaaaaaaaaaaaaaaa", "hook-secret");
    await clearOrgConnections({ store, hooks, hookIds: async () => ["hok_aaaaaaaaaaaaaaaaaaaa"] }, ORG_A);
    expect(await store.list(ORG_A)).toEqual([]);
    for (const name of [orgConnectorSecretName(ENV, ORG_A, CON_A), orgConnectorSecretName(ENV, ORG_A, CON_B), orgHookSecretName(ENV, ORG_A, "hok_aaaaaaaaaaaaaaaaaaaa")]) {
      expect(fake.stored(name)?.deleteAt, name).toBe(START + 7 * 86_400_000);
    }
    expect(fake.stored(orgConnectorSecretName(ENV, ORG_B, CON_A))?.deleteAt).toBeUndefined();
    expect((await store.list(ORG_B)).length).toBe(1);
    expect([...db.items.keys()].some((key) => key.includes(ORG_A) && key.includes("CONNECTION"))).toBe(false);
  });

  it("can be run again after it stopped part-way", async () => {
    const { deps, store, fake } = setup();
    await store.put({ orgId: ORG_A, connection: LINEAR, secret: { apiKey: "k1" }, by: ALICE });
    // A first run scheduled the secret but stopped before the record was removed.
    await deps.secrets.scheduleDelete(ORG_A, orgConnectorSecretName(ENV, ORG_A, CON_A));
    await clearOrgConnections({ store }, ORG_A);
    expect(await store.list(ORG_A)).toEqual([]);
    expect(fake.stored(orgConnectorSecretName(ENV, ORG_A, CON_A))?.deleteAt).toBeDefined();
  });
});

describe("OrgSecrets.scheduleDelete", () => {
  it("treats a secret that is already scheduled for deletion as done", async () => {
    const { secrets } = setup();
    await secrets.put(ORG_A, orgConnectorSecretName(ENV, ORG_A, CON_A), "v");
    await secrets.scheduleDelete(ORG_A, orgConnectorSecretName(ENV, ORG_A, CON_A));
    await expect(secrets.scheduleDelete(ORG_A, orgConnectorSecretName(ENV, ORG_A, CON_A))).resolves.toBeUndefined();
  });
});
