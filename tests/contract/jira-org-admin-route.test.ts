// DV-1: `/v1/app/org/jira-org-admin`, the web form's route for the Jira organization admin key and the Atlassian organization id. Who may change it, from where, how fresh a sign-in, what a body may say, that the
// pair is write-only (nothing returns it, nothing logs or audits it) and kept together, and that the change is audited with its own event in the same commit.
import { describe, expect, it } from "vitest";
import { OrgConnectionStore, readConnectionSecret } from "../../packages/broker/src/connections/store.js";
import { OrgSecrets } from "../../packages/broker/src/connections/org-secrets.js";
import { connectionKey } from "@rovara-code/contracts";
import { MAYA, OMAR } from "../support/developer-task-broker.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { FAKE_CONNECTOR_ROLE_ARN, FakeOrgSecrets } from "../support/fake-org-secrets.js";
import { TEST_ORG } from "../support/orgs.js";
import { errorOf, setupWizardBench } from "../support/setup-wizard-testenv.js";

const PATH = "/v1/app/org/jira-org-admin";
const REQ = "8f3f2f5e-1c1b-4a53-9d0c-0b1f2a3b4c5d";
const CON = "con_aaaaaaaaaaaaaaaaaaaa";
const KEY = "ATAdminKey-0123456789";
const ORGID = "org-id-1234";
const CONNECTION = { connectionId: CON, type: "jira", label: "Jira", access: "read", siteUrl: "https://acme.atlassian.net" };

async function bench(options: { maya?: "admin" | "member"; withAudit?: boolean; saveJira?: boolean } = {}) {
  const fake = new FakeOrgSecrets({ env: "staging", now: Date.now });
  const secrets = new OrgSecrets({ env: "staging", roleArn: FAKE_CONNECTOR_ROLE_ARN, sts: fake.sts, secretsFor: fake.secretsFor, now: Date.now });
  const holder: { db?: { send(command: unknown): Promise<unknown> }; afterFirstRead?: (() => Promise<void>) | undefined } = {};
  const audit = capturingAuditDeps();
  const deps = { documentClient: { send: (command: unknown) => holder.db!.send(command) }, tableName: "state", env: "staging", secrets, now: Date.now };
  const t = await setupWizardBench({ ...(options.withAudit === false ? {} : { audit }), orgConnections: deps });
  holder.db = t.db;
  // `afterFirstRead` runs once, right after the first read of the connection's record (a change landing between the route's read and its write).
  const plainSend = t.db.send.bind(t.db) as (command: unknown) => Promise<unknown>;
  (t.db as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
    const result = await plainSend(command);
    const key = (command as { input?: { Key?: { pk?: string; sk?: string } } }).input?.Key;
    if (holder.afterFirstRead !== undefined && key?.pk === connectionKey(TEST_ORG, CON).pk && key.sk === connectionKey(TEST_ORG, CON).sk) { const run = holder.afterFirstRead; holder.afterFirstRead = undefined; await run(); }
    return result;
  };
  audit.attach(t.db);
  if (options.maya !== undefined) await t.person(MAYA, options.maya);
  const store = new OrgConnectionStore({ ...deps, checkEndpoint: async () => undefined, ...(options.withAudit === false ? {} : { audit: audit.audit }) });
  if (options.saveJira !== false) await store.put({ orgId: TEST_ORG, connection: CONNECTION, secret: { email: "svc@acme.test", apiToken: "jira-token-xyz" }, by: OMAR.developerId });
  const versionOf = (): string | undefined => (t.db.find((item) => item.entityType === "ORG_CONNECTION" && item.connectionId === CON)[0] as { secretVersion?: string } | undefined)?.secretVersion;
  const secretNow = () => readConnectionSecret(deps, TEST_ORG, { connectionId: CON, type: "jira", ...(versionOf() === undefined ? {} : { secretVersion: versionOf()! }) });
  return { t, audit, fake, deps, store, secretNow, holder };
}
const setBody = { action: "set", requestId: REQ, connectionId: CON, orgAdminKey: KEY, atlassianOrgId: ORGID };

describe("the Team record is off", () => {
  it("is not found", async () => {
    const t = await setupWizardBench({ teamRecord: false });
    expect((await t.web(OMAR, "POST", PATH, setBody)).status).toBe(404);
  });
});

describe("who may change it, and from where", () => {
  it("a token, a member and a non-owner/admin are refused and nothing is written", async () => {
    const { t, store, audit } = await bench({ maya: "member" });
    const before = JSON.stringify(await store.get(TEST_ORG, CON));
    const token = await t.dev(OMAR, "POST", PATH, setBody);
    expect(token.status).toBe(403);
    expect(JSON.stringify(token.body)).toContain("Use a live browser session");
    expect((await t.web(MAYA, "POST", PATH, setBody)).status).toBe(403);
    expect(JSON.stringify(await store.get(TEST_ORG, CON))).toBe(before);
    expect(audit.recordedBy("connection.jira_org_admin_changed")).toEqual([]);
  });

  it("needs a sign-in within the last 10 minutes", async () => {
    const { t, audit } = await bench();
    t.ageSignIn(OMAR, 11);
    expect(JSON.stringify((await t.web(OMAR, "POST", PATH, setBody)).body)).toContain("REAUTH_REQUIRED");
    t.ageSignIn(OMAR, undefined);
    expect(JSON.stringify((await t.web(OMAR, "POST", PATH, setBody)).body)).toContain("REAUTH_REQUIRED");
    expect(audit.recordedBy("connection.jira_org_admin_changed")).toEqual([]);
    t.ageSignIn(OMAR, 2);
    expect((await t.web(OMAR, "POST", PATH, setBody)).status).toBe(200);
  });

  it("a read (GET) is not a route: the key is write-only", async () => {
    const { t } = await bench();
    expect((await t.web(OMAR, "GET", PATH)).status).toBe(404);
  });
});

describe("setting and clearing", () => {
  it("sets the pair, keeps the email and token, answers a fixed word, and writes the pair nowhere but the secret", async () => {
    const { t, audit, fake, store, secretNow } = await bench();
    const reply = await t.web(OMAR, "POST", PATH, setBody);
    expect(reply).toMatchObject({ status: 200, body: { status: "saved" } });
    const record = await store.get(TEST_ORG, CON);
    expect(await secretNow()).toStrictEqual({ email: "svc@acme.test", apiToken: "jira-token-xyz", orgAdminKey: KEY, atlassianOrgId: ORGID });
    expect(record).toMatchObject({ connectionId: CON, type: "jira", hasSecret: true });
    // nothing returns, stores in a record, or audits the pair
    const everywhere = JSON.stringify([reply, record, t.db.find(() => true), audit.recorded(), audit.logs]);
    expect(everywhere).not.toContain(KEY);
    expect(everywhere).not.toContain(ORGID);
    expect(everywhere).not.toContain("jira-token-xyz");
    expect([...fake.secrets.values()].length).toBeGreaterThan(0);
  });

  it("is audited with its own event naming the connection and the word set, in the same commit as the save", async () => {
    const { t, audit } = await bench();
    await t.web(OMAR, "POST", PATH, setBody);
    expect(audit.recordedBy("connection.jira_org_admin_changed")).toMatchObject([{ actor: { kind: "member", id: OMAR.developerId }, target: { kind: "connection", id: CON }, facts: { change: "set" } }]);
    expect(audit.recordedBy("connection.saved")).toHaveLength(2);
    await t.web(OMAR, "POST", PATH, { action: "clear", requestId: "9f3f2f5e-1c1b-4a53-9d0c-0b1f2a3b4c5d", connectionId: CON });
    expect(audit.recordedBy("connection.jira_org_admin_changed").map((event) => event.facts)).toStrictEqual([{ change: "set" }, { change: "cleared" }]);
  });

  it("clear removes the pair and keeps the email and token", async () => {
    const { t, store, secretNow } = await bench();
    await t.web(OMAR, "POST", PATH, setBody);
    expect(await t.web(OMAR, "POST", PATH, { action: "clear", requestId: "9f3f2f5e-1c1b-4a53-9d0c-0b1f2a3b4c5e", connectionId: CON })).toMatchObject({ status: 200, body: { status: "cleared" } });
    expect(await secretNow()).toStrictEqual({ email: "svc@acme.test", apiToken: "jira-token-xyz" });
    expect(await store.get(TEST_ORG, CON)).toMatchObject({ connectionId: CON });
  });

  it("a later save from the connection's own route that leaves the pair out keeps it", async () => {
    const { t, store, secretNow } = await bench();
    await t.web(OMAR, "POST", PATH, setBody);
    await store.put({ orgId: TEST_ORG, connection: CONNECTION, secret: { email: "svc@acme.test", apiToken: "rotated" }, by: OMAR.developerId });
    expect(await secretNow()).toStrictEqual({ email: "svc@acme.test", apiToken: "rotated", orgAdminKey: KEY, atlassianOrgId: ORGID });
  });
});

describe("refusals", () => {
  it("both or neither: a key without the id, an id without the key, a bad id, a bad key, and any other field, with field names only", async () => {
    const { t, audit } = await bench();
    const { atlassianOrgId: _id, ...noId } = setBody; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
    const { orgAdminKey: _key, ...noKey } = setBody; // eslint-disable-line @typescript-eslint/no-unused-vars -- left out on purpose
    const cases = [noId, noKey, { ...setBody, atlassianOrgId: "../../x" }, { ...setBody, orgAdminKey: "has space" }, { ...setBody, email: "x@y.test" }, { ...setBody, orgId: "org_aaaaaaaaaaaaaaaaaaaa" }, { ...setBody, requestId: "nope" }, { ...setBody, connectionId: "../x" }, { action: "clear", requestId: REQ, connectionId: CON, orgAdminKey: KEY }, { action: "wipe" }, {}];
    for (const body of cases) {
      const reply = await t.web(OMAR, "POST", PATH, body);
      expect(reply.status, JSON.stringify(body)).toBe(400);
      expect(JSON.stringify(reply.body)).not.toContain(KEY);
      expect(JSON.stringify(reply.body)).not.toContain("x@y.test");
    }
    expect(audit.recordedBy("connection.jira_org_admin_changed")).toEqual([]);
  });

  it("an unknown connection and a connection that is not Jira are NOT_FOUND; a Jira connection with no email and token saved is told to save them first", async () => {
    const { t, store } = await bench();
    expect(errorOf(await t.web(OMAR, "POST", PATH, { ...setBody, connectionId: "con_bbbbbbbbbbbbbbbbbbbb" })).code).toBe("NOT_FOUND");
    await store.put({ orgId: TEST_ORG, connection: { connectionId: "con_cccccccccccccccccccc", type: "linear", label: "Linear", access: "read" }, secret: { apiKey: "lin-key-1" }, by: OMAR.developerId });
    expect(errorOf(await t.web(OMAR, "POST", PATH, { ...setBody, connectionId: "con_cccccccccccccccccccc" })).code).toBe("NOT_FOUND");
    await store.put({ orgId: TEST_ORG, connection: { ...CONNECTION, connectionId: "con_dddddddddddddddddddd" }, by: OMAR.developerId });
    const unready = await t.web(OMAR, "POST", PATH, { ...setBody, connectionId: "con_dddddddddddddddddddd" });
    expect(unready.status).toBe(400);
    expect(errorOf(unready).message).toContain("save this Jira connection's email and API token first");
  });

  it("without the audit ledger nothing is changed", async () => {
    const { t, store, secretNow } = await bench({ withAudit: false });
    const reply = await t.web(OMAR, "POST", PATH, setBody);
    expect(errorOf(reply).code).toBe("AUDIT_UNAVAILABLE");
    expect(await secretNow()).toStrictEqual({ email: "svc@acme.test", apiToken: "jira-token-xyz" });
    expect(await store.get(TEST_ORG, CON)).toBeDefined();
  });

  it("another company's connection is as unknown as a missing one", async () => {
    const { t, store } = await bench();
    await store.put({ orgId: "org_zzzzzzzzzzzzzzzzzzzz", connection: { ...CONNECTION, connectionId: "con_eeeeeeeeeeeeeeeeeeee" }, secret: { email: "o@other.test", apiToken: "other-token" }, by: "a".repeat(64) }).catch(() => undefined);
    expect(errorOf(await t.web(OMAR, "POST", PATH, { ...setBody, connectionId: "con_eeeeeeeeeeeeeeeeeeee" })).code).toBe("NOT_FOUND");
  });
});

describe("a repeated request and a change that lands in between", () => {
  it("the same request id for the same change is one change: no second write, no second audit event; for another change it is refused", async () => {
    const { t, audit, store } = await bench();
    expect((await t.web(OMAR, "POST", PATH, setBody)).status).toBe(200);
    const revision = (await store.get(TEST_ORG, CON) as { revision?: number }).revision;
    const again = await t.web(OMAR, "POST", PATH, setBody);
    expect(again).toMatchObject({ status: 200, body: { status: "saved" } });
    expect(audit.recordedBy("connection.jira_org_admin_changed")).toHaveLength(1);
    expect((await store.get(TEST_ORG, CON) as { revision?: number }).revision).toBe(revision);
    // The same id for a different key, or for a clear, is not that request.
    expect(errorOf(await t.web(OMAR, "POST", PATH, { ...setBody, orgAdminKey: "AnotherKey-0123456789" })).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(errorOf(await t.web(OMAR, "POST", PATH, { action: "clear", requestId: REQ, connectionId: CON })).code).toBe("IDEMPOTENCY_CONFLICT");
    expect(audit.recordedBy("connection.jira_org_admin_changed")).toHaveLength(1);
  });

  it("an email or token change that lands between the read and the write is not put back: the change is refused as stale and nothing is audited", async () => {
    const { t, audit, store, secretNow, holder } = await bench();
    holder.afterFirstRead = async () => { await store.put({ orgId: TEST_ORG, connection: CONNECTION, secret: { email: "svc@acme.test", apiToken: "rotated-token-9876543210" }, by: OMAR.developerId }); };
    const reply = await t.web(OMAR, "POST", PATH, setBody);
    expect(errorOf(reply).code).toBe("CHANGE_STALE");
    expect(await secretNow()).toStrictEqual({ email: "svc@acme.test", apiToken: "rotated-token-9876543210" });
    expect(audit.recordedBy("connection.jira_org_admin_changed")).toEqual([]);
    // Sent again after the other change, it goes through on top of the new token.
    expect((await t.web(OMAR, "POST", PATH, setBody)).status).toBe(200);
    expect(await secretNow()).toStrictEqual({ email: "svc@acme.test", apiToken: "rotated-token-9876543210", orgAdminKey: KEY, atlassianOrgId: ORGID });
  });
});
