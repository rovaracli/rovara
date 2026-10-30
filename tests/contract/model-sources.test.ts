// Plan 3 Task 24b: company AI sources, the store and the admin routes (`/v1/app/org/model-sources*`), through the broker's handler with two orgs.
// A key is write-only: it goes to the model proxy and appears nowhere else. Every change commits with its request item and its audit item in one
// transaction. An endpoint's host is an egress item that waits for Rovara staff on cloud. The kinds are off at launch, so most tests turn them on.
import { randomUUID } from "node:crypto";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { agentXError, type OrgModelSources } from "@agentx/contracts";
import { ModelSourceStore } from "../../packages/broker/src/model-sources/store.js";
import { chatGptTaskSelection } from "../../packages/broker/src/chatgpt/task-model.js";
import type { ChatGptConnections } from "../../packages/broker/src/chatgpt/connections.js";
import { approvedUnion, decideEgressDomain, readEgressDomains, type EgressDomainsDependencies } from "../../packages/broker/src/org/egress-domains.js";
import { CHATGPT_SETTINGS_KEY } from "../../packages/broker/src/chatgpt/settings.js";
import type { OrgResolver } from "../../packages/broker/src/org/resolve.js";
import { MODEL_SOURCES_NEED_PROXY, MODEL_SOURCE_STILL_APPLYING, type SourceLaunch } from "../../packages/contracts/src/model-sources.js";
import { egressDomainsKey, egressRejectedWarning } from "../../packages/contracts/src/egress.js";
import type { OrgId, OrgRole } from "../../packages/contracts/src/org-node.js";
import { agentRequestKey, modelSourcesKey } from "../../packages/contracts/src/org-scoped-keys.js";
import { auditEventId } from "../../packages/contracts/src/audit.js";
import { INDEX_EXPIRY_ATTRIBUTE } from "../../packages/contracts/src/admin.js";
import { auditOccurrence } from "../../packages/broker/src/audit/events.js";
import { capturingAuditDeps } from "../support/audit-capture.js";
import { OMAR, createDeveloperTaskBroker, seedMembership, type Developer } from "../support/developer-task-broker.js";
import { fakeModelAccess } from "../support/fake-model-access.js";
import type { FakeDynamoDb } from "../support/fake-dynamodb.js";
import { FakeProjectMembers } from "../support/fake-project-members.js";
import { TEST_ORG } from "../support/orgs.js";
import { releaseOrgModelSources } from "../../packages/broker/src/model-sources/release.js";
import { MODEL_SOURCE_SWEEP_BUDGET_MS, sweepModelSources } from "../../packages/broker/src/model-sources/sweep.js";
import { OrgStore } from "../../packages/broker/src/org/store.js";
import { listEgressItems, putEgressDomains } from "../../packages/broker/src/org/egress-domains.js";
import { developerOrgKey, orgMemberKey, orgMetaKey } from "../../packages/contracts/src/org-node.js";
import { createBroker, ensureWorkspace, loadSlackBroker, markReady, registerSlackProject, serviceCall, SLACK_CHANNEL, SLACK_TEAM } from "../support/slack-broker.js";
import { chatGptConnections, type ChatGptSealer } from "../../packages/broker/src/chatgpt/connections.js";
import type { ChatGptConnectionView } from "../../packages/contracts/src/index.js";

const ORG_B = "org_bbbbbbbbbbbbbbbbbbbb" as OrgId;
const person = (digit: string, name: string): Developer => ({ developerId: digit.repeat(64), name, provider: "oidc", sessionId: `s-${name.toLowerCase()}` });
const DANA = person("1", "Dana"); // org admin
const OWEN = person("7", "Owen"); // org owner
const EVE = person("4", "Eve"); // a plain member
const BEA = person("8", "Bea"); // org admin of org B
const orgResolver: OrgResolver = async (subject) => (subject.developerId === OMAR.developerId || subject.developerId === BEA.developerId ? ORG_B : TEST_ORG);

const KEY = "sk-ant-planted-vendor-key-0123456789abcdef";
const OTHER_KEY = "sk-ant-planted-second-key-fedcba9876543210";
const ROLE_ARN = "arn:aws:iam::123456789012:role/rovara/proxy-access";
const PRINCIPALS = ["arn:aws:iam::210987654321:role/agentx/staging/agentx-staging-model-proxy-task", "arn:aws:iam::210987654321:role/agentx/staging/agentx-staging-model-access"];
const ALL_KINDS: SourceLaunch = { kinds: ["anthropic", "openai", "openrouter", "bedrock", "endpoint"] };
const HOST = "llm.example.com";

const sonnet = { provider: "anthropic", modelId: "claude-sonnet-4-5" };
const haiku = { provider: "anthropic", modelId: "claude-haiku-4-5" };
const anthropic = (extra: Record<string, unknown> = {}) => ({ kind: "anthropic", label: "Company Anthropic", models: [{ catalog: sonnet }], ...extra });
const bedrock = (extra: Record<string, unknown> = {}) => ({
  kind: "bedrock", label: "Our AWS", roleArn: ROLE_ARN, region: "us-east-1",
  models: [{ catalog: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" } }], ...extra,
});
const endpoint = (extra: Record<string, unknown> = {}) => ({
  kind: "endpoint", label: "Gateway", baseUrl: `https://${HOST}/v1`, api: "openai-completions", models: [{ name: "our-model", catalog: sonnet }], ...extra,
});

beforeAll(async () => { await loadSlackBroker(); });
afterEach(() => { vi.restoreAllMocks(); });

type Reply = { status: number; body: Record<string, unknown> };
type Tx = Array<Record<string, { Item?: Record<string, unknown>; Key?: Record<string, unknown> } | undefined>>;
interface SourceView { sourceId: string; kind: string; hasCredential: boolean; inOrder: boolean; hostStatus?: string; tested?: boolean; note?: string; trustPolicy?: unknown; models: unknown[]; label: string }

interface Options {
  launch?: SourceLaunch;
  proxy?: boolean;
  cloud?: boolean;
  /** The broker's endpoint checker (Task 12b's `checkEndpointUrl`, bound to a resolver); a test double refuses by throwing. `null`: the broker has none. */
  checkEndpoint?: ((url: string) => Promise<void>) | null;
  principals?: readonly string[];
  /** Whether Pi's catalog knows a model; default: Pi's own. A test that needs more models than a catalog test names lets any through. */
  isKnownCatalog?: () => boolean;
  /** `applied` (default): the sync clears the marker, as the real firewall sync does; `down`: it fails and the marker stays dirty. */
  sync?: "applied" | "down";
}

async function setup(options: Options = {}) {
  const access = fakeModelAccess();
  const members = new FakeProjectMembers();
  const audit = capturingAuditDeps();
  const checked: string[] = [];
  const checker = options.checkEndpoint === null ? undefined : options.checkEndpoint ?? (async () => undefined);
  const ref: { db?: FakeDynamoDb } = {};
  let syncMode = options.sync ?? "applied";
  const sync = async () => {
    if (syncMode === "down") return { ok: false };
    const marker = ref.db?.get("EGRESS_DOMAINS", "SYNC");
    if (marker !== undefined) ref.db?.set({ ...marker, syncedSeq: marker.dirtySeq ?? 0 });
    return { ok: true, domains: 0 };
  };
  const h = await createDeveloperTaskBroker({
    orgResolver, register: false, audit,
    brokerExtra: {
      agents: {
        projectMembers: members,
        modelSources: {
          launch: options.launch ?? ALL_KINDS,
          ...(checker === undefined ? {} : { checkEndpoint: async (url: string) => { checked.push(url); await checker(url); } }),
          ...(options.principals === undefined ? {} : { bedrockTrustPrincipals: options.principals }),
          ...(options.isKnownCatalog === undefined ? {} : { isKnownCatalog: options.isKnownCatalog }),
        },
      },
      ...(options.proxy === false ? {} : { modelAccess: { access, proxyUrl: "https://proxy.example.com" } }),
      ...(options.cloud === true ? { cloud: true } : {}),
      egressDomainsSync: sync,
    },
  });
  ref.db = h.db;
  const enroll = async (who: Developer, role: OrgRole, org: OrgId = TEST_ORG) => {
    h.db.set({ pk: `SESSION#${who.sessionId}`, sk: "META", sessionId: who.sessionId, developerId: who.developerId, amr: who.provider, startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${who.developerId}`, sk: "META", developerId: who.developerId, provider: who.provider, displayName: who.name, firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(who);
    seedMembership(h.db, who.developerId, { orgId: org, role });
  };
  await enroll(DANA, "admin");
  await enroll(OWEN, "owner");
  await enroll(EVE, "member");
  await enroll(BEA, "admin", ORG_B);
  await enroll(OMAR, "member", ORG_B);
  const unwrapped = async (reply: Promise<Reply>): Promise<Reply> => {
    const awaited = await reply;
    const { requestId: _requestId, ...body } = awaited.body; // eslint-disable-line @typescript-eslint/no-unused-vars -- the envelope's id is not part of an answer
    return { status: awaited.status, body };
  };
  const call = (who: Developer, method: string, path: string, body?: Record<string, unknown>): Promise<Reply> => unwrapped(h.dev(who, method, path, body));
  /** A body with a fresh request id, unless the test names one. */
  const write = (who: Developer, method: string, path: string, body: Record<string, unknown> = {}): Promise<Reply> => call(who, method, path, { requestId: randomUUID(), ...body });
  const add = async (who: Developer, source: Record<string, unknown>, apiKey: string | undefined = KEY) => {
    const hasKey = source.kind === "anthropic" || source.kind === "openai" || source.kind === "openrouter";
    const reply = await write(who, "POST", "/v1/app/org/model-sources", { source, ...(apiKey === undefined || !hasKey ? {} : { apiKey }) });
    expect(reply.status, JSON.stringify(reply.body)).toBe(201);
    return reply.body.sourceId as string;
  };
  const list = async (who: Developer = DANA) => {
    const reply = await call(who, "GET", "/v1/app/org/model-sources");
    expect(reply.status, JSON.stringify(reply.body)).toBe(200);
    return { ...reply.body, sources: reply.body.sources as SourceView[], order: reply.body.order as string[] };
  };
  const doc = (org: OrgId = TEST_ORG) => h.db.get(modelSourcesKey(org)) as { revision: number; sources: Array<Record<string, unknown>>; order: string[]; credentials: string[]; removing: Array<{ sourceId: string; kind: string }> } | undefined;
  const everything = () => JSON.stringify(h.db.find(() => true));
  const egressDeps = (): EgressDomainsDependencies => ({ documentClient: h.db, tableName: "state", cloud: options.cloud === true, now: () => new Date(), sync });
  const transactions = (): Tx[] => {
    const seen: Tx[] = [];
    const original = h.db.send.bind(h.db) as (command: unknown) => Promise<unknown>;
    (h.db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand") seen.push((command as { input: { TransactItems: Tx } }).input.TransactItems);
      return original(command);
    };
    return seen;
  };
  const store = (chatgptSwitch = false) => new ModelSourceStore({ documentClient: h.db, tableName: "state", now: Date.now, chatgptSwitch: async () => chatgptSwitch, audit: audit.audit });
  const decide = (sourceId: string, decision: "approved" | "rejected", reason?: string) =>
    decideEgressDomain(egressDeps(), { orgId: TEST_ORG, owner: { kind: "model-source", sourceId }, domain: HOST, decision, operatorId: "operator-1", ...(reason === undefined ? {} : { reason }) });
  const egressOf = (sourceId: string, org: OrgId = TEST_ORG) => readEgressDomains(egressDeps(), org, { kind: "model-source", sourceId });
  const switchOn = () => h.db.set({ ...CHATGPT_SETTINGS_KEY, entityType: "SETTING", enabled: true, preferredModel: "gpt-6.1-sol" });
  return { ...h, access, audit, members, checked, switchOn, call, write, add, list, doc, everything, egressDeps, transactions, store, enroll, decide, egressOf, setSync: (mode: "applied" | "down") => { syncMode = mode; } };
}

const errorOf = (reply: Reply) => reply.body.error as { code: string; message: string };
const isAudit = (item: Tx[number]) => String(item.Put?.Item?.pk).startsWith("AUDIT_PENDING#");
const auditIn = (transaction: Tx) => transaction.filter(isAudit).map((item) => (item.Put!.Item as { event: { action: string; eventId: string; facts?: Record<string, unknown>; target: Record<string, unknown>; actor: Record<string, unknown>; details?: unknown } }).event);
const writesDoc = (transaction: Tx, org: OrgId = TEST_ORG) => transaction.some((item) => item.Put?.Item?.pk === modelSourcesKey(org).pk);
const writesRequest = (transaction: Tx) => transaction.some((item) => String(item.Put?.Item?.pk).includes("AGENT_REQUEST#"));
const MISSING = "no AI source has that ID";

describe("without the model proxy", () => {
  it("answers every route with the exact text, to a member and an admin alike", async () => {
    const s = await setup({ proxy: false });
    const id = "src_aaaaaaaaaaaaaaaaaaaa";
    const calls: Array<[Developer, string, string, Record<string, unknown>?]> = [
      [EVE, "GET", "/v1/app/org/model-sources"],
      [DANA, "GET", "/v1/app/org/model-sources"],
      [DANA, "POST", "/v1/app/org/model-sources", { requestId: randomUUID(), source: anthropic(), apiKey: KEY }],
      [DANA, "PUT", `/v1/app/org/model-sources/${id}`, { requestId: randomUUID(), source: anthropic() }],
      [DANA, "DELETE", `/v1/app/org/model-sources/${id}`, { requestId: randomUUID() }],
      [DANA, "PUT", "/v1/app/org/model-sources-order", { requestId: randomUUID(), order: ["rovara"] }],
      [DANA, "POST", `/v1/app/org/model-sources/${id}/check`],
    ];
    for (const [who, method, path, body] of calls) {
      const reply = await s.call(who, method, path, body);
      expect([reply.status, errorOf(reply).code, errorOf(reply).message], `${method} ${path}`).toEqual([400, "CONFIG_INVALID", MODEL_SOURCES_NEED_PROXY]);
    }
    expect(MODEL_SOURCES_NEED_PROXY).toBe("company AI sources need Rovara's model proxy, which this install doesn't run");
    expect(s.doc()).toBeUndefined();
  });
});

describe("the kinds are off at launch", () => {
  const bodies: Record<string, Record<string, unknown>> = {
    anthropic: anthropic(), openai: anthropic({ kind: "openai", models: [{ catalog: { provider: "openai", modelId: "gpt-5" } }] }),
    openrouter: anthropic({ kind: "openrouter", models: [{ catalog: { provider: "openrouter", modelId: "anthropic/claude-sonnet-4.5" } }] }), bedrock: bedrock(), endpoint: endpoint(),
  };

  it.each(["anthropic", "openai", "openrouter", "bedrock", "endpoint"] as const)("refuses a %s source with the exact text, and writes and registers nothing", async (kind) => {
    const s = await setup({ launch: {} });
    const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: bodies[kind], ...(kind === "bedrock" || kind === "endpoint" ? {} : { apiKey: KEY }) });
    expect([reply.status, errorOf(reply).code, errorOf(reply).message]).toEqual([400, "CONFIG_INVALID", `${kind} sources aren't available yet`]);
    expect(s.doc()).toBeUndefined();
    expect(s.access.upsertSource).not.toHaveBeenCalled();
    expect(s.audit.recorded()).toEqual([]);
  });

  it("refuses with the same text whatever else is wrong with the body, so the refusal never depends on it", async () => {
    const s = await setup({ launch: {} });
    const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: { kind: "anthropic", label: "", models: [], extra: 1 } });
    expect(errorOf(reply).message).toBe("anthropic sources aren't available yet");
  });

  it("refuses an endpoint whose api is outside the transports, even once endpoints are on", async () => {
    const s = await setup();
    for (const api of ["bedrock-converse", "OPENAI-COMPLETIONS", ""]) {
      const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint({ api }) });
      expect([reply.status, errorOf(reply).message], api).toEqual([400, "endpoint sources aren't available yet"]);
    }
    expect(s.doc()).toBeUndefined();
  });

  it("uses the shipped launch list when the broker is given none: nothing can be added", async () => {
    const h = await createDeveloperTaskBroker({ orgResolver, register: false, brokerExtra: { agents: { projectMembers: new FakeProjectMembers() }, modelAccess: { access: fakeModelAccess(), proxyUrl: "https://proxy.example.com" } } });
    h.db.set({ pk: `SESSION#${DANA.sessionId}`, sk: "META", sessionId: DANA.sessionId, developerId: DANA.developerId, amr: "oidc", startedAt: new Date(Date.now() - 60_000).toISOString(), endsAt: Math.floor(Date.now() / 1000) + 604_800 });
    h.db.set({ pk: `DEVELOPER#${DANA.developerId}`, sk: "META", developerId: DANA.developerId, provider: "oidc", displayName: "Dana", firstSignInAt: "x", lastSignInAt: "x", revoked: false });
    await h.orgOf(DANA);
    seedMembership(h.db, DANA.developerId, { orgId: TEST_ORG, role: "admin" });
    const reply = await h.dev(DANA, "POST", "/v1/app/org/model-sources", { requestId: randomUUID(), source: anthropic(), apiKey: KEY });
    expect([reply.status, (reply.body.error as { message: string }).message]).toEqual([400, "anthropic sources aren't available yet"]);
  });
});

describe("who may use the routes", () => {
  it("lets a member read and refuses a member's every write with 403, before anything is read or sent", async () => {
    const s = await setup();
    const id = await s.add(DANA, anthropic());
    expect((await s.call(EVE, "GET", "/v1/app/org/model-sources")).status).toBe(200);
    const writes: Array<[string, string, Record<string, unknown> | undefined]> = [
      ["POST", "/v1/app/org/model-sources", { source: anthropic(), apiKey: KEY }],
      ["PUT", `/v1/app/org/model-sources/${id}`, { source: anthropic() }],
      ["DELETE", `/v1/app/org/model-sources/${id}`, {}],
      ["PUT", "/v1/app/org/model-sources-order", { order: ["rovara"] }],
      ["POST", `/v1/app/org/model-sources/${id}/check`, undefined],
    ];
    s.access.upsertSource.mockClear();
    for (const [method, path, body] of writes) {
      const reply = await s.call(EVE, method, path, body === undefined ? undefined : { requestId: randomUUID(), ...body });
      expect([reply.status, errorOf(reply).code], `${method} ${path}`).toEqual([403, "FORBIDDEN"]);
    }
    expect(s.access.upsertSource).not.toHaveBeenCalled();
    expect(s.access.removeSource).not.toHaveBeenCalled();
    expect(s.access.checkSource).not.toHaveBeenCalled();
    expect(s.doc()!.sources).toHaveLength(1);
  });

  it("lets an owner write, and reads the role afresh on each request: an admin demoted to member can no longer write", async () => {
    const s = await setup();
    await s.add(OWEN, anthropic({ label: "By the owner" }));
    await s.add(DANA, anthropic({ label: "By the admin" }));
    seedMembership(s.db, DANA.developerId, { orgId: TEST_ORG, role: "member" });
    const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic(), apiKey: KEY });
    expect([reply.status, errorOf(reply).code]).toEqual([403, "FORBIDDEN"]);
    expect(s.doc()!.sources).toHaveLength(2);
  });
});

describe("adding a source with a key", () => {
  it("answers 201 with a server-made id, registers it with the proxy, and keeps the key out of every record, answer, event and log", async () => {
    const s = await setup();
    const logs = [vi.spyOn(console, "log"), vi.spyOn(console, "error"), vi.spyOn(console, "warn"), vi.spyOn(console, "info")];
    const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic(), apiKey: KEY });
    expect(reply.status).toBe(201);
    const sourceId = reply.body.sourceId as string;
    expect(sourceId).toMatch(/^src_[0-9a-z]{20}$/);
    expect(Object.keys(reply.body)).toEqual(["sourceId"]);
    expect(s.access.upsertSource).toHaveBeenCalledTimes(1);
    expect(s.access.upsertSource.mock.calls[0]![0]).toMatchObject({ orgId: TEST_ORG, apiKey: KEY, source: { sourceId, kind: "anthropic", label: "Company Anthropic" } });

    const listed = await s.call(EVE, "GET", "/v1/app/org/model-sources");
    expect(listed.status).toBe(200);
    expect(listed.body.sources).toEqual([{ sourceId, kind: "anthropic", label: "Company Anthropic", models: [{ catalog: sonnet }], hasCredential: true, inOrder: false }]);
    expect(listed.body.order).toEqual(["rovara"]);
    const everywhere = [s.everything(), JSON.stringify(listed.body), JSON.stringify(reply.body), JSON.stringify(s.audit.recorded()), JSON.stringify(s.audit.logs), ...logs.map((spy) => JSON.stringify(spy.mock.calls))];
    for (const text of everywhere) expect(text).not.toContain(KEY);
    // Nor does any answer show the proxy's name for the credential.
    expect(JSON.stringify(listed.body)).not.toContain(`${TEST_ORG}.${sourceId}`);
    expect(s.db.refusals).toEqual([]);
  });

  it("needs a key for a source that uses one, refuses a key a Bedrock source cannot use, and never repeats a refused key", async () => {
    const s = await setup();
    const none = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic() });
    expect([none.status, errorOf(none).code, errorOf(none).message]).toEqual([400, "CONFIG_INVALID", "apiKey: an anthropic source needs an API key"]);
    const withKey = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: bedrock(), apiKey: KEY });
    expect([withKey.status, errorOf(withKey).message]).toEqual([400, "apiKey: a bedrock source uses a role, not an API key"]);
    for (const bad of ["short", `${KEY} with space`, `${KEY}\n`, "k".repeat(5000)]) {
      const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic(), apiKey: bad });
      expect([reply.status, errorOf(reply).message], bad.slice(0, 12)).toEqual([400, "apiKey: is not a valid API key"]);
      expect(JSON.stringify(reply.body)).not.toContain(bad.trim().slice(0, 12) === "short" ? "\u0000" : bad.slice(0, 20));
    }
    expect(s.access.upsertSource).not.toHaveBeenCalled();
    expect(s.doc()).toBeUndefined();
  });

  it("refuses a client-sent sourceId, externalId or tested, and a field it does not know, without repeating the field", async () => {
    const s = await setup();
    const extras: Array<[string, Record<string, unknown>]> = [
      ["sourceId", { sourceId: "src_aaaaaaaaaaaaaaaaaaaa" }], ["externalId", { externalId: `rovara-${TEST_ORG}` }], ["tested", { tested: true }], ["unknown", { evilFieldName: 1 }],
    ];
    for (const base of [anthropic(), bedrock(), endpoint()]) {
      for (const [name, extra] of extras) {
        const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: { ...base, ...extra }, ...(base.kind === "anthropic" ? { apiKey: KEY } : {}) });
        expect([reply.status, errorOf(reply).code, errorOf(reply).message], `${String(base.kind)} ${name}`).toEqual([400, "CONFIG_INVALID", expect.stringContaining("has a field Rovara doesn't accept") as unknown]);
        expect(errorOf(reply).message).not.toContain("evilFieldName");
        expect(errorOf(reply).message).not.toContain("src_aaaaaaaaaaaaaaaaaaaa");
      }
    }
    const top = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic(), apiKey: KEY, sourceId: "src_aaaaaaaaaaaaaaaaaaaa" });
    expect([top.status, errorOf(top).message]).toEqual([400, "body: has a field Rovara doesn't accept"]);
    expect(s.doc()).toBeUndefined();
    expect(s.access.upsertSource).not.toHaveBeenCalled();
  });

  it("refuses duplicate canonical models, more than 20 models, a model Pi does not know, and an 11th source", async () => {
    const s = await setup();
    const post = (source: Record<string, unknown>) => s.write(DANA, "POST", "/v1/app/org/model-sources", { source, apiKey: KEY });
    const duplicate = await post(anthropic({ models: [{ catalog: sonnet }, { catalog: sonnet }] }));
    expect([duplicate.status, errorOf(duplicate).message]).toEqual([400, "source.models.1: models must be unique"]);
    const many = Array.from({ length: 21 }, (_, index) => ({ catalog: { provider: "anthropic", modelId: `claude-model-${String(index)}` } }));
    const loose = await setup({ isKnownCatalog: () => true });
    const tooMany = await loose.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic({ models: many }), apiKey: KEY });
    expect([tooMany.status, errorOf(tooMany).message]).toEqual([400, expect.stringMatching(/^source\.models: /) as unknown]);
    expect((await loose.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic({ models: many.slice(0, 20) }), apiKey: KEY })).status).toBe(201);
    const unknown = await post(anthropic({ models: [{ catalog: { provider: "anthropic", modelId: "claude-not-in-pis-catalog-9" } }] }));
    expect([unknown.status, errorOf(unknown).message]).toEqual([400, "source.models.0.catalog: must be a model in the catalog"]);
    for (let index = 0; index < 10; index += 1) await s.add(DANA, anthropic({ label: `Source ${String(index)}` }));
    s.access.upsertSource.mockClear();
    const eleventh = await post(anthropic({ label: "One too many" }));
    expect([eleventh.status, errorOf(eleventh).message]).toEqual([400, "an organization can have at most 10 AI sources"]);
    // Refused before the proxy was asked to register anything.
    expect(s.access.upsertSource).not.toHaveBeenCalled();
    expect(s.doc()!.sources).toHaveLength(10);
  });

  it("counts a label in characters, and refuses control and invisible characters in a label or a model name", async () => {
    const s = await setup();
    const post = (source: Record<string, unknown>) => s.write(DANA, "POST", "/v1/app/org/model-sources", { source, apiKey: KEY });
    expect((await post(anthropic({ label: "\u{1F600}".repeat(40) }))).status).toBe(201);
    for (const label of ["\u{1F600}".repeat(65), "line\nbreak", "zero\u200bwidth", "flip\u202etext", "tab\there", "bell\u0007"]) {
      const reply = await post(anthropic({ label }));
      expect([reply.status, errorOf(reply).message], JSON.stringify(label)).toEqual([400, expect.stringMatching(/^source\.label: must (be at most 64 characters|not hold control or invisible characters)$/) as unknown]);
    }
    const name = await post(endpoint({ models: [{ name: "model\u202ename", catalog: sonnet }] }));
    expect([name.status, errorOf(name).message]).toEqual([400, "source.models.0.name: must not hold control or invisible characters"]);
    expect(s.doc()!.sources).toHaveLength(1);
  });

  it("does not register anything with the proxy when it is down, and writes no record", async () => {
    const s = await setup();
    s.access.upsertSource.mockRejectedValueOnce(agentXError("MODEL_PROXY_UNAVAILABLE", "model proxy is unreachable"));
    const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic(), apiKey: KEY });
    expect([reply.status, errorOf(reply).code]).toEqual([503, "MODEL_PROXY_UNAVAILABLE"]);
    expect(s.doc()).toBeUndefined();
    expect(s.audit.recorded()).toEqual([]);
    // A failure that is not one of ours is a 503 too, and its text (which could hold a key) is not repeated.
    s.access.upsertSource.mockRejectedValueOnce(new Error(`connect failed with ${KEY}`));
    const odd = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic(), apiKey: KEY });
    expect([odd.status, errorOf(odd).code]).toEqual([503, "MODEL_PROXY_UNAVAILABLE"]);
    expect(JSON.stringify(odd.body)).not.toContain(KEY);
  });
});

describe("one transaction, one audit event, one request item", () => {
  it("commits the document, its request item and its audit item together, and the event names the source and its kind, never the label or key", async () => {
    const s = await setup();
    const seen = s.transactions();
    const requestId = randomUUID();
    const reply = await s.call(DANA, "POST", "/v1/app/org/model-sources", { requestId, source: anthropic({ label: "Secret-looking label" }), apiKey: KEY });
    const sourceId = reply.body.sourceId as string;
    const committed = seen.filter((transaction) => writesDoc(transaction));
    expect(committed).toHaveLength(1);
    expect(writesRequest(committed[0]!)).toBe(true);
    const events = auditIn(committed[0]!);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: "model_source.saved", eventId: auditEventId("model_source.saved", auditOccurrence("1")),
      target: { kind: "model_source", id: sourceId }, actor: { kind: "member", id: DANA.developerId }, facts: { kind: "anthropic", change: "created" },
    });
    expect(JSON.stringify(events)).not.toContain("Secret-looking label");
    expect(JSON.stringify(events)).not.toContain(KEY);
    const request = s.db.get(agentRequestKey(TEST_ORG, DANA.developerId, requestId)) as Record<string, unknown>;
    expect(request.entityType).toBe("AGENT_REQUEST");
    expect(typeof request[INDEX_EXPIRY_ATTRIBUTE]).toBe("number");
    expect(request[INDEX_EXPIRY_ATTRIBUTE] as number).toBeGreaterThan(Math.floor(Date.now() / 1000) + 6 * 86_400);
    expect(JSON.stringify(request)).not.toContain(KEY);
  });

  it("records an update, a removal and an order change each in the transaction that makes it", async () => {
    const s = await setup();
    const id = await s.add(DANA, anthropic());
    const other = await s.add(DANA, anthropic({ label: "Second" }));
    const seen = s.transactions();
    expect((await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: anthropic({ label: "Renamed" }) })).status).toBe(200);
    expect((await s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: [id, "rovara", other] })).status).toBe(200);
    expect((await s.write(DANA, "DELETE", `/v1/app/org/model-sources/${other}`)).status).toBe(200);
    // The removal's cleanup then clears its tombstone in a write of its own, which is no request and has no event.
    const docTransactions = seen.filter((transaction) => writesDoc(transaction) && writesRequest(transaction));
    expect(docTransactions).toHaveLength(3);
    for (const transaction of docTransactions) expect(writesRequest(transaction)).toBe(true);
    expect(auditIn(docTransactions[0]!).map((event) => [event.action, event.facts])).toEqual([["model_source.saved", { kind: "anthropic", change: "updated" }]]);
    expect(auditIn(docTransactions[1]!).map((event) => [event.action, event.facts])).toEqual([["model_source.order_changed", { count: 3 }]]);
    expect(auditIn(docTransactions[2]!).map((event) => [event.action, event.target])).toEqual([
      ["model_source.removed", { kind: "model_source", id: other }], ["model_source.order_changed", { kind: "org", id: TEST_ORG }],
    ]);
    // Every event reached the ledger's queue or waits in the outbox, once each.
    expect(new Set(s.audit.recorded().map((event) => event.eventId)).size).toBe(s.audit.recorded().length);
  });

  it("keeps a lost race from losing either change: a conflicting write is read again and applied, and a persistent one refuses and undoes the proxy registration", async () => {
    const s = await setup();
    s.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("MODEL_SOURCES"), error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }] } });
    const id = await s.add(DANA, anthropic());
    expect(s.doc()!.sources.map((source) => source.sourceId)).toEqual([id]);
    expect(s.doc()!.revision).toBe(1);

    s.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("MODEL_SOURCES"), times: 10, error: { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }] } });
    const lost = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic({ label: "Never stored" }), apiKey: KEY });
    expect([lost.status, errorOf(lost).code]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
    expect(s.doc()!.sources).toHaveLength(1);
    // The registration made for the source that did not commit is undone; the earlier source is left alone.
    expect(s.access.removeSource).toHaveBeenCalledTimes(1);
    expect(s.access.removeSource.mock.calls[0]![1]).not.toBe(id);
  });

  it("keeps every change when several land at once: each is read again after losing the race, none overwrites another", async () => {
    const s = await setup();
    // The org has a record first, so the order below is a change; the install-wide switch is on, so ChatGPT may be added to it.
    await s.add(DANA, anthropic({ label: "Seed" }));
    s.switchOn();
    // The first three writes of the record are held until all three are ready, so each has read the record as it was before any of them.
    const send = s.db.send.bind(s.db) as (command: unknown) => Promise<unknown>;
    let ready = 0;
    let open!: () => void;
    const gate = new Promise<void>((resolve) => { open = resolve; });
    (s.db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("MODEL_SOURCES") && ready < 3) {
        ready += 1;
        if (ready === 3) open();
        await gate;
      }
      return send(command);
    };
    const [first, second, third] = await Promise.all([
      s.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic({ label: "A" }), apiKey: KEY }),
      s.write(OWEN, "POST", "/v1/app/org/model-sources", { source: anthropic({ label: "B" }), apiKey: OTHER_KEY }),
      s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: ["personal-chatgpt", "rovara"] }),
    ]);
    expect([first.status, second.status, third.status]).toEqual([201, 201, 200]);
    expect(ready).toBe(3);
    expect(s.doc()!.sources.map((source) => source.label).sort()).toEqual(["A", "B", "Seed"]);
    expect(s.doc()!.order).toEqual(["personal-chatgpt", "rovara"]);
    expect(s.doc()!.credentials).toHaveLength(3);
    expect(s.doc()!.revision).toBe(4);
  });

  it("makes the proxy match the record when a write fails with its outcome unknown: a write that did not land is undone, one that did is kept", async () => {
    const s = await setup();
    s.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("MODEL_SOURCES"), error: { name: "InternalServerError" } });
    const lost = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic(), apiKey: KEY });
    expect(lost.status).toBeGreaterThanOrEqual(500);
    expect(s.doc()).toBeUndefined();
    expect(s.access.removeSource).toHaveBeenCalledTimes(1);

    // The write lands and the answer is lost (a timeout): the record has the source, so its registration stays.
    s.access.removeSource.mockClear();
    const send = s.db.send.bind(s.db) as (command: unknown) => Promise<unknown>;
    let dropped = false;
    (s.db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
      const answer = await send(command);
      if (!dropped && (command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("MODEL_SOURCES")) {
        dropped = true;
        throw Object.assign(new Error("timeout"), { name: "TimeoutError" });
      }
      return answer;
    };
    const unknown = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: anthropic(), apiKey: KEY });
    expect(unknown.status).toBeGreaterThanOrEqual(500);
    expect(s.doc()!.sources).toHaveLength(1);
    expect(s.access.removeSource).not.toHaveBeenCalled();
  });

  it("does not bring back a source that a removal took while a change to it was on its way", async () => {
    const s = await setup();
    const id = await s.add(DANA, anthropic());
    // The removal lands after the change has read the source and registered its new models, before the change is written.
    s.access.upsertSource.mockImplementationOnce(async () => { expect((await s.write(OWEN, "DELETE", `/v1/app/org/model-sources/${id}`)).status).toBe(200); });
    s.access.removeSource.mockClear();
    const reply = await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: anthropic({ label: "Too late" }) });
    expect([reply.status, errorOf(reply).message]).toEqual([404, MISSING]);
    expect(s.doc()!.sources).toEqual([]);
    // The proxy is told again that the source is gone, since the change had registered it meanwhile.
    expect(s.access.removeSource).toHaveBeenLastCalledWith(TEST_ORG, id);
  });
});

describe("repeating a request (R18)", () => {
  it("answers a repeat with the stored outcome and writes, registers and records nothing more", async () => {
    const s = await setup();
    const requestId = randomUUID();
    const body = { requestId, source: anthropic(), apiKey: KEY };
    const first = await s.call(DANA, "POST", "/v1/app/org/model-sources", body);
    const before = JSON.stringify(s.doc());
    const events = s.audit.recorded().length;
    const second = await s.call(DANA, "POST", "/v1/app/org/model-sources", body);
    expect([second.status, second.body]).toEqual([201, first.body]);
    expect(JSON.stringify(s.doc())).toBe(before);
    expect(s.audit.recorded()).toHaveLength(events);
    expect(s.access.upsertSource).toHaveBeenCalledTimes(1);
  });

  it("refuses the same request id for a different request, and keeps one developer's id apart from another's", async () => {
    const s = await setup();
    const requestId = randomUUID();
    await s.call(DANA, "POST", "/v1/app/org/model-sources", { requestId, source: anthropic(), apiKey: KEY });
    const changed = await s.call(DANA, "POST", "/v1/app/org/model-sources", { requestId, source: anthropic({ label: "Another" }), apiKey: KEY });
    expect([changed.status, errorOf(changed).code, errorOf(changed).message]).toEqual([400, "CONFIG_INVALID", "requestId: this request ID was already used for a different request"]);
    const other = await s.call(OWEN, "POST", "/v1/app/org/model-sources", { requestId, source: anthropic(), apiKey: KEY });
    expect(other.status).toBe(201);
    expect(s.doc()!.sources).toHaveLength(2);
  });

  it("leaves a late repeat of an add alone after the source was removed", async () => {
    const s = await setup();
    const requestId = randomUUID();
    const first = await s.call(DANA, "POST", "/v1/app/org/model-sources", { requestId, source: anthropic(), apiKey: KEY });
    const id = first.body.sourceId as string;
    expect((await s.write(DANA, "DELETE", `/v1/app/org/model-sources/${id}`)).status).toBe(200);
    s.access.upsertSource.mockClear();
    const late = await s.call(DANA, "POST", "/v1/app/org/model-sources", { requestId, source: anthropic(), apiKey: KEY });
    expect([late.status, late.body]).toEqual([201, first.body]);
    expect(s.doc()!.sources).toEqual([]);
    expect(s.access.upsertSource).not.toHaveBeenCalled();
  });

  it("answers a repeat of a removal with the stored outcome and runs the cleanup again, which is safe to repeat", async () => {
    const s = await setup();
    const id = await s.add(DANA, anthropic());
    const requestId = randomUUID();
    const first = await s.call(DANA, "DELETE", `/v1/app/org/model-sources/${id}`, { requestId });
    expect(first.status).toBe(200);
    const revision = s.doc()!.revision;
    s.access.removeSource.mockClear();
    const again = await s.call(DANA, "DELETE", `/v1/app/org/model-sources/${id}`, { requestId });
    expect([again.status, again.body]).toEqual([200, first.body]);
    expect(s.doc()!.revision).toBe(revision);
    expect(s.access.removeSource).toHaveBeenCalledTimes(1);
    // A new request for a source that is gone is a 404.
    const gone = await s.write(DANA, "DELETE", `/v1/app/org/model-sources/${id}`);
    expect([gone.status, errorOf(gone).message]).toEqual([404, MISSING]);
  });

  it("repairs a removal whose cleanup failed: the record is gone, the answer is 503, and the same request finishes the cleanup", async () => {
    const s = await setup();
    const id = await s.add(DANA, anthropic());
    s.access.removeSource.mockRejectedValueOnce(agentXError("MODEL_PROXY_UNAVAILABLE", "model proxy is unreachable"));
    const requestId = randomUUID();
    const failed = await s.call(DANA, "DELETE", `/v1/app/org/model-sources/${id}`, { requestId });
    expect([failed.status, errorOf(failed).code]).toEqual([503, "MODEL_PROXY_UNAVAILABLE"]);
    expect(s.doc()!.sources).toEqual([]);
    const retried = await s.call(DANA, "DELETE", `/v1/app/org/model-sources/${id}`, { requestId });
    expect(retried.status).toBe(200);
    expect(s.access.removeSource.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(s.doc()!.sources).toEqual([]);
    expect(s.doc()!.removing).toEqual([]);
  });

  it("records the request item of an order change that changes nothing, and answers its repeat from it", async () => {
    const s = await setup();
    const requestId = randomUUID();
    const first = await s.call(DANA, "PUT", "/v1/app/org/model-sources-order", { requestId, order: ["rovara"] });
    expect(first.status).toBe(200);
    expect(s.db.get(agentRequestKey(TEST_ORG, DANA.developerId, requestId))).toBeDefined();
    expect(s.audit.recorded()).toEqual([]);
    const again = await s.call(DANA, "PUT", "/v1/app/org/model-sources-order", { requestId, order: ["rovara"] });
    expect([again.status, again.body]).toEqual([200, first.body]);
    const changed = await s.call(DANA, "PUT", "/v1/app/org/model-sources-order", { requestId, order: ["personal-chatgpt", "rovara"] });
    expect([changed.status, errorOf(changed).message]).toEqual([400, "requestId: this request ID was already used for a different request"]);
  });
});

describe("changing and removing a source", () => {
  it("updates a source, keeps its key unless a new one is sent, and refuses to change its kind", async () => {
    const s = await setup();
    const id = await s.add(DANA, anthropic());
    s.access.upsertSource.mockClear();
    const renamed = await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: anthropic({ label: "Renamed", models: [{ catalog: sonnet }, { catalog: haiku }] }) });
    expect([renamed.status, renamed.body]).toEqual([200, { sourceId: id }]);
    expect(s.access.upsertSource.mock.calls[0]![0].apiKey).toBeUndefined();
    expect((await s.list()).sources).toEqual([{ sourceId: id, kind: "anthropic", label: "Renamed", models: [{ catalog: sonnet }, { catalog: haiku }], hasCredential: true, inOrder: false }]);
    const rekeyed = await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: anthropic({ label: "Renamed", models: [{ catalog: sonnet }, { catalog: haiku }] }), apiKey: OTHER_KEY });
    expect(rekeyed.status).toBe(200);
    expect(s.access.upsertSource.mock.calls[1]![0]).toMatchObject({ apiKey: OTHER_KEY });
    expect(s.everything()).not.toContain(OTHER_KEY);
    s.access.upsertSource.mockClear();
    const kind = await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: anthropic({ kind: "openai", models: [{ catalog: { provider: "openai", modelId: "gpt-5" } }] }) });
    expect([kind.status, errorOf(kind).message]).toEqual([400, "source.kind: a source's kind can't change; remove it and add a new one"]);
    expect(s.access.upsertSource).not.toHaveBeenCalled();
    expect(s.doc()!.revision).toBe(3);
  });

  it("removes a source from the record, the order and the proxy, and keeps the last entry of the order", async () => {
    const s = await setup();
    const id = await s.add(DANA, anthropic());
    expect((await s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: [id] })).status).toBe(200);
    const refused = await s.write(DANA, "DELETE", `/v1/app/org/model-sources/${id}`);
    expect([refused.status, errorOf(refused).message]).toEqual([400, "order: put another source in the order before removing the last one"]);
    expect(s.doc()!.sources).toHaveLength(1);
    expect(s.access.removeSource).not.toHaveBeenCalled();
    expect((await s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: [id, "rovara"] })).status).toBe(200);
    const removed = await s.write(DANA, "DELETE", `/v1/app/org/model-sources/${id}`);
    expect([removed.status, removed.body]).toEqual([200, { sourceId: id, removed: true }]);
    expect(s.access.removeSource).toHaveBeenCalledWith(TEST_ORG, id);
    expect(s.doc()).toMatchObject({ sources: [], order: ["rovara"], credentials: [] });
  });

  it("orders the sources: it names at least one, none twice, and only sources the org has", async () => {
    const s = await setup();
    const id = await s.add(DANA, anthropic());
    s.switchOn();
    const put = (order: unknown) => s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order });
    const refusals: Array<[unknown, RegExp]> = [
      [[], /^order: name at least one source$/], [["rovara", "rovara"], /^order must not repeat a source$/], [["src_aaaaaaaaaaaaaaaaaaaa"], /^order names a source the organization does not have$/],
      [["rovara", "not-a-source"], /^order\.1: /], ["rovara", /^order: /],
    ];
    for (const [bad, message] of refusals) {
      const reply = await put(bad);
      expect([reply.status, errorOf(reply).code, errorOf(reply).message], JSON.stringify(bad)).toEqual([400, "CONFIG_INVALID", expect.stringMatching(message) as unknown]);
    }
    expect(JSON.stringify((await put(["src_aaaaaaaaaaaaaaaaaaaa"])).body)).not.toContain("src_aaaaaaaaaaaaaaaaaaaa");
    const ok = await put([id, "personal-chatgpt", "rovara"]);
    expect([ok.status, ok.body]).toEqual([200, { order: [id, "personal-chatgpt", "rovara"] }]);
    const listed = await s.list(EVE);
    expect(listed.order).toEqual([id, "personal-chatgpt", "rovara"]);
    expect(listed.sources[0]!.inOrder).toBe(true);
  });
});

describe("another org", () => {
  it("cannot see, change, remove or check an org's source, and a made-up id reads the same", async () => {
    const s = await setup();
    const id = await s.add(DANA, anthropic());
    s.access.upsertSource.mockClear();
    const body = { requestId: randomUUID() };
    const probes: Array<[string, string, Record<string, unknown> | undefined]> = [
      ["PUT", `/v1/app/org/model-sources/${id}`, { ...body, source: anthropic() }], ["DELETE", `/v1/app/org/model-sources/${id}`, body], ["POST", `/v1/app/org/model-sources/${id}/check`, undefined],
    ];
    for (const [method, path, payload] of probes) {
      const real = await s.call(BEA, method, path, payload);
      const made = await s.call(BEA, method, path.replace(id, "src_zzzzzzzzzzzzzzzzzzzz"), payload);
      expect([real.status, real.body], `${method} ${path}`).toEqual([404, made.body]);
      expect(errorOf(real).message).toBe(MISSING);
    }
    expect((await s.list(BEA)).sources).toEqual([]);
    expect((await s.list(OMAR)).sources).toEqual([]);
    expect(s.access.upsertSource).not.toHaveBeenCalled();
    expect(s.access.removeSource).not.toHaveBeenCalled();
    expect(s.access.checkSource).not.toHaveBeenCalled();
    expect(s.doc()!.sources).toHaveLength(1);
    // The other org's own source lives under its own key and is registered under its own id.
    const mine = await s.add(BEA, anthropic());
    expect(s.access.upsertSource.mock.calls[0]![0]).toMatchObject({ orgId: ORG_B });
    expect(s.doc(ORG_B)!.sources.map((source) => source.sourceId)).toEqual([mine]);
    expect(s.doc()!.sources.map((source) => source.sourceId)).toEqual([id]);
  });

  it("does not take the order of one org to enable ChatGPT for another", async () => {
    const s = await setup();
    await s.add(DANA, anthropic());
    s.switchOn();
    expect((await s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: ["personal-chatgpt", "rovara"] })).status).toBe(200);
    const store = s.store();
    expect((await store.orgSources(TEST_ORG)).order).toEqual(["personal-chatgpt", "rovara"]);
    expect((await store.orgSources(ORG_B)).order).toEqual(["rovara"]);
    const view = vi.fn(async () => ({ connected: true, status: "connected" as const, models: ["gpt-6.1-sol"] }));
    const connections = { settings: async () => ({ enabled: true, preferredModel: "gpt-6.1-sol" }), view } as unknown as ChatGptConnections;
    expect(await chatGptTaskSelection(connections, "dev-1", Date.now(), await store.orgSources(TEST_ORG))).toEqual({ developerId: "dev-1", model: { provider: "openai", modelId: "gpt-6.1-sol" } });
    view.mockClear();
    expect(await chatGptTaskSelection(connections, "dev-1", Date.now(), await store.orgSources(ORG_B))).toBeUndefined();
    expect(view).not.toHaveBeenCalled();
  });
});

describe("the order of a new org follows the install-wide ChatGPT switch", () => {
  it("is [personal-chatgpt, rovara] with the switch on and [rovara] with it off, and a stored order no longer follows it", async () => {
    const s = await setup();
    expect((await s.list()).order).toEqual(["rovara"]);
    s.db.set({ ...CHATGPT_SETTINGS_KEY, entityType: "SETTING", enabled: true, preferredModel: "gpt-6.1-sol" });
    expect((await s.list()).order).toEqual(["personal-chatgpt", "rovara"]);
    // The first change stores the order that was in force, so a later flip of the switch does not move it.
    const id = await s.add(DANA, anthropic());
    expect(s.doc()!.order).toEqual(["personal-chatgpt", "rovara"]);
    s.db.set({ ...CHATGPT_SETTINGS_KEY, entityType: "SETTING", enabled: false, preferredModel: "gpt-6.1-sol" });
    expect((await s.list()).order).toEqual(["personal-chatgpt", "rovara"]);
    expect((await s.list()).sources.map((source) => source.sourceId)).toEqual([id]);
  });
});

describe("what ChatGPT does with an org's sources", () => {
  const connections = (enabled: boolean, preferredModel = "gpt-6.1-sol") => {
    const view = vi.fn(async () => ({ connected: true, status: "connected" as const, models: ["gpt-5.5", "gpt-6.1-sol"] }));
    return { connections: { settings: async () => ({ enabled, preferredModel }), view } as unknown as ChatGptConnections, view };
  };
  const sources = (order: string[], extra: Record<string, unknown> = {}) => ({ sources: [], order, ...extra }) as never;

  it("is on only when the install-wide switch is on AND the org's order has personal-chatgpt: the switch stays a hard off", async () => {
    const orderWithout = connections(true);
    expect(await chatGptTaskSelection(orderWithout.connections, "dev-1", Date.now(), sources(["rovara"]))).toBeUndefined();
    expect(orderWithout.view).not.toHaveBeenCalled();
    const switchOff = connections(false);
    expect(await chatGptTaskSelection(switchOff.connections, "dev-1", Date.now(), sources(["personal-chatgpt", "rovara"]))).toBeUndefined();
    expect(switchOff.view).not.toHaveBeenCalled();
    const both = connections(true);
    expect(await chatGptTaskSelection(both.connections, "dev-1", Date.now(), sources(["personal-chatgpt", "rovara"]))).toEqual({ developerId: "dev-1", model: { provider: "openai", modelId: "gpt-6.1-sol" } });
  });

  it("prefers the org's own model over the install's, and leaves the install-wide switch in charge without a proxy", async () => {
    const mine = connections(true, "gpt-6.1-sol");
    expect(await chatGptTaskSelection(mine.connections, "dev-1", Date.now(), sources(["personal-chatgpt"], { chatgptPreferredModel: "gpt-5.5" }))).toEqual({ developerId: "dev-1", model: { provider: "openai", modelId: "gpt-5.5" } });
    const noProxyOn = connections(true);
    expect(await chatGptTaskSelection(noProxyOn.connections, "dev-1", Date.now(), undefined)).toEqual({ developerId: "dev-1", model: { provider: "openai", modelId: "gpt-6.1-sol" } });
    const noProxyOff = connections(false);
    expect(await chatGptTaskSelection(noProxyOff.connections, "dev-1", Date.now(), undefined)).toBeUndefined();
    expect(noProxyOff.view).not.toHaveBeenCalled();
  });
});

describe("an endpoint source", () => {
  it("is checked before anything is written, and a refusal reaches the admin with its own text", async () => {
    const s = await setup({ checkEndpoint: async () => { throw agentXError("CONFIG_INVALID", `${HOST} resolves to an address Rovara can't use`); } });
    const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() });
    expect([reply.status, errorOf(reply).code, errorOf(reply).message]).toEqual([400, "CONFIG_INVALID", `${HOST} resolves to an address Rovara can't use`]);
    expect(s.checked).toEqual([`https://${HOST}/v1`]);
    expect(s.doc()).toBeUndefined();
    expect(s.access.upsertSource).not.toHaveBeenCalled();
  });

  it.each([
    ["plain http", "http://llm.example.com/v1"], ["an IP literal", "https://10.0.0.5/v1"], ["an IPv6 literal", "https://[::1]/v1"], ["localhost", "https://localhost/v1"],
    ["an internal name", "https://proxy.internal/v1"], ["a .local name", "https://printer.local/v1"], ["user info", "https://user:hunter2secret@llm.example.com/v1"],
    ["another port", "https://llm.example.com:4001/v1"], ["the metadata address", "https://169.254.169.254/latest"],
    ["a wildcard host", "https://*.example.com/v1"], ["a wildcard inside a label", "https://a*b.example.com/v1"], ["an underscore in the host", "https://my_host.example.com/v1"],
    ["a query", "https://llm.example.com/v1?key=sk-abc"], ["an empty query", "https://llm.example.com/v1?"], ["a fragment", "https://llm.example.com/v1#token"],
  ])("refuses %s on its own, before the broker's checker runs", async (_name, baseUrl) => {
    const s = await setup();
    const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint({ baseUrl }) });
    expect([reply.status, errorOf(reply).code, errorOf(reply).message]).toEqual([400, "CONFIG_INVALID", expect.stringMatching(/^source\.baseUrl: /) as unknown]);
    expect(s.checked).toEqual([]);
    expect(s.doc()).toBeUndefined();
    expect(JSON.stringify(reply.body)).not.toContain("hunter2secret");
    expect(JSON.stringify(reply.body)).not.toContain("sk-abc");
  });

  it("is unavailable where the broker has no endpoint checker", async () => {
    const s = await setup({ checkEndpoint: null });
    const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() });
    expect([reply.status, errorOf(reply).message]).toEqual([400, "endpoint sources aren't available yet"]);
    expect(s.doc()).toBeUndefined();
  });

  it("waits for Rovara to approve its host on cloud: pending in the answer and the list, a check says so, and approval puts the host in the firewall's union", async () => {
    const s = await setup({ cloud: true });
    const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() });
    expect(reply.status).toBe(201);
    const id = reply.body.sourceId as string;
    expect(reply.body).toEqual({ sourceId: id, hostStatus: "pending", message: `${HOST} is waiting for Rovara to approve it` });
    expect((await s.list(EVE)).sources[0]).toMatchObject({ sourceId: id, kind: "endpoint", hostStatus: "pending", baseUrl: `https://${HOST}/v1`, api: "openai-completions" });
    expect(await approvedUnion(s.egressDeps())).toEqual([]);
    const pending = await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect([pending.status, pending.body]).toEqual([200, { ok: false, message: `${HOST} is waiting for Rovara to approve it` }]);
    expect(s.access.checkSource).not.toHaveBeenCalled();

    await s.decide(id, "approved");
    // PF30: the model source's item is active, so its approved host is in the union the firewall serves.
    expect((await s.egressOf(id))!.active).toBe(true);
    expect(await approvedUnion(s.egressDeps())).toEqual([HOST]);
    expect((await s.list()).sources[0]!.hostStatus).toBe("approved");
    const ok = await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect([ok.status, ok.body]).toEqual([200, { ok: true }]);
    expect(s.access.checkSource).toHaveBeenCalledWith(TEST_ORG, id);
  });

  it("says Rovara is still applying an approved address while the firewall has not caught up, and shows a rejection with its reason", async () => {
    const s = await setup({ cloud: true, sync: "down" });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() })).body.sourceId as string;
    await s.decide(id, "approved");
    const applying = await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect([applying.status, applying.body]).toEqual([200, { ok: false, message: MODEL_SOURCE_STILL_APPLYING }]);
    expect(MODEL_SOURCE_STILL_APPLYING).toBe("Rovara is still applying this address; try again in 5 minutes.");
    expect(s.access.checkSource).not.toHaveBeenCalled();
    s.setSync("applied");
    const marker = s.db.get("EGRESS_DOMAINS", "SYNC")!;
    s.db.set({ ...marker, syncedSeq: marker.dirtySeq });
    expect((await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`)).body).toEqual({ ok: true });

    const other = await setup({ cloud: true });
    const rejectedId = (await other.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() })).body.sourceId as string;
    await other.decide(rejectedId, "rejected", "not a company we know");
    expect((await other.list()).sources[0]!.hostStatus).toBe("rejected");
    expect((await other.call(DANA, "POST", `/v1/app/org/model-sources/${rejectedId}/check`)).body).toEqual({ ok: false, message: egressRejectedWarning(HOST, "not a company we know") });
  });

  it("is approved when it is saved on a private install, and its host is in the union at once", async () => {
    const s = await setup({ cloud: false });
    const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() });
    expect(reply.body).toEqual({ sourceId: reply.body.sourceId, hostStatus: "approved" });
    expect(await approvedUnion(s.egressDeps())).toEqual([HOST]);
  });

  it("fails a later check when the host now resolves somewhere it must not, without asking the proxy", async () => {
    let calls = 0;
    const s = await setup({ checkEndpoint: async () => { calls += 1; if (calls > 1) throw agentXError("CONFIG_INVALID", `${HOST} now resolves to an address Rovara can't use`); } });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() })).body.sourceId as string;
    const check = await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect([check.status, check.body]).toEqual([200, { ok: false, message: `${HOST} now resolves to an address Rovara can't use` }]);
    expect(s.access.checkSource).not.toHaveBeenCalled();
  });

  it("asks for the approval again when a check finds no egress item, so a failure after the save is repaired", async () => {
    const s = await setup({ cloud: true });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() })).body.sourceId as string;
    s.db.delete(egressDomainsKey(TEST_ORG, { kind: "model-source", sourceId: id }));
    expect(await s.egressOf(id)).toBeUndefined();
    expect((await s.list()).sources[0]!.hostStatus).toBe("not_requested");
    const check = await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect(check.body).toEqual({ ok: false, message: `${HOST} is waiting for Rovara to approve it` });
    expect((await s.egressOf(id))!.domains.map((entry) => [entry.domain, entry.status])).toEqual([[HOST, "pending"]]);
  });

  it("does not send a saved key to a new host, and moves the approval to the new host when a new key comes with it", async () => {
    const s = await setup({ cloud: false });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint(), apiKey: KEY })).body.sourceId as string;
    const moved = endpoint({ baseUrl: "https://other.example.org/v1" });
    const refused = await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: moved });
    expect([refused.status, errorOf(refused).message]).toEqual([400, "source.baseUrl: the saved key would be sent to a different host; send the new key with it"]);
    expect(await approvedUnion(s.egressDeps())).toEqual([HOST]);
    const ok = await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: moved, apiKey: OTHER_KEY });
    expect([ok.status, ok.body]).toEqual([200, { sourceId: id, hostStatus: "approved" }]);
    expect(await approvedUnion(s.egressDeps())).toEqual(["other.example.org"]);
    expect(s.everything()).not.toContain(OTHER_KEY);
  });

  it("releases its host when it is removed, and the host leaves the union", async () => {
    const s = await setup({ cloud: false });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() })).body.sourceId as string;
    expect(await approvedUnion(s.egressDeps())).toEqual([HOST]);
    expect((await s.write(DANA, "DELETE", `/v1/app/org/model-sources/${id}`)).status).toBe(200);
    expect((await s.egressOf(id))?.domains ?? []).toEqual([]);
    expect(await approvedUnion(s.egressDeps())).toEqual([]);
  });

  it("keeps another org's approved host out of this org's item", async () => {
    const s = await setup({ cloud: false });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() })).body.sourceId as string;
    expect(await s.egressOf(id, ORG_B)).toBeUndefined();
    expect((await s.list(BEA)).sources).toEqual([]);
  });
});

describe("a Bedrock source", () => {
  it("is stored with the org's external id and tested false, shown with its note and the trust policy to paste, and never takes either from the client", async () => {
    const s = await setup({ principals: PRINCIPALS });
    const id = await s.add(DANA, bedrock());
    expect(s.doc()!.sources[0]).toMatchObject({ sourceId: id, kind: "bedrock", externalId: `rovara-${TEST_ORG}`, tested: false, roleArn: ROLE_ARN });
    expect(s.access.upsertSource.mock.calls[0]![0].source).toMatchObject({ externalId: `rovara-${TEST_ORG}`, tested: false });
    expect(s.access.upsertSource.mock.calls[0]![0].apiKey).toBeUndefined();
    const shown = (await s.list(EVE)).sources[0]!;
    expect(shown).toMatchObject({ sourceId: id, kind: "bedrock", hasCredential: false, tested: false, roleArn: ROLE_ARN, region: "us-east-1", note: "NOT TESTED: Bedrock in your own AWS account hasn't been tested yet." });
    expect(shown.trustPolicy).toEqual({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Principal: { AWS: PRINCIPALS }, Action: "sts:AssumeRole", Condition: { StringEquals: { "sts:ExternalId": `rovara-${TEST_ORG}` } } }],
    });
    expect(JSON.stringify(await s.list(EVE))).not.toContain(`rovara-${ORG_B}`);
    // Org B's source carries org B's external id.
    await s.add(BEA, bedrock());
    expect(s.doc(ORG_B)!.sources[0]).toMatchObject({ externalId: `rovara-${ORG_B}` });
  });

  it("shows no trust policy where the broker does not know Rovara's roles, rather than a made-up one", async () => {
    const s = await setup();
    await s.add(DANA, bedrock());
    const shown = (await s.list()).sources[0]!;
    expect(shown.note).toBeDefined();
    expect(shown).not.toHaveProperty("trustPolicy");
  });

  it("refuses a role that is a wildcard or a user", async () => {
    const s = await setup();
    for (const roleArn of ["arn:aws:iam::123456789012:role/*", "arn:aws:iam::123456789012:user/bob", "arn:aws:iam::*:role/x", "arn:aws:iam::123456789012:root"]) {
      const reply = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: bedrock({ roleArn }) });
      expect([reply.status, errorOf(reply).code, errorOf(reply).message], roleArn).toEqual([400, "CONFIG_INVALID", expect.stringMatching(/^source\.roleArn: /) as unknown]);
    }
    expect(s.doc()).toBeUndefined();
  });

  it("is tested by a check: a pass stores tested and serves it, a failure says why and changes nothing", async () => {
    const s = await setup();
    const id = await s.add(DANA, bedrock());
    s.access.upsertSource.mockClear();
    s.access.checkSource.mockResolvedValueOnce({ ok: false, message: "this role's trust policy must require the external id rovara-org_x" });
    const failed = await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect([failed.status, failed.body]).toEqual([200, { ok: false, message: "this role's trust policy must require the external id rovara-org_x" }]);
    expect((s.doc()!.sources[0] as { tested: boolean }).tested).toBe(false);
    expect(s.access.upsertSource).not.toHaveBeenCalled();

    const passed = await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect([passed.status, passed.body]).toEqual([200, { ok: true }]);
    expect((s.doc()!.sources[0] as { tested: boolean }).tested).toBe(true);
    expect(s.access.upsertSource.mock.calls[0]![0].source).toMatchObject({ sourceId: id, tested: true });
    expect(s.audit.recordedBy("model_source.saved").map((event) => event.facts)).toEqual([{ kind: "bedrock", change: "created" }, { kind: "bedrock", change: "tested" }]);
    // Checking again changes nothing in the record.
    const revision = s.doc()!.revision;
    await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect(s.doc()!.revision).toBe(revision);
  });

  it("is untested again when its role or region changes, and keeps its test when only its label does", async () => {
    const s = await setup();
    const id = await s.add(DANA, bedrock());
    await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect((s.doc()!.sources[0] as { tested: boolean }).tested).toBe(true);
    expect((await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: bedrock({ label: "Renamed" }) })).status).toBe(200);
    expect((s.doc()!.sources[0] as { tested: boolean }).tested).toBe(true);
    expect((await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: bedrock({ region: "eu-west-1" }) })).status).toBe(200);
    expect((s.doc()!.sources[0] as { tested: boolean }).tested).toBe(false);
    expect(s.access.upsertSource.mock.calls.at(-1)![0].source).toMatchObject({ tested: false, region: "eu-west-1" });
  });
});

describe("checking a keyed source", () => {
  it("asks the proxy and passes its answer on, and a proxy that is down is a 503", async () => {
    const s = await setup();
    const id = await s.add(DANA, anthropic());
    expect((await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`)).body).toEqual({ ok: true });
    s.access.checkSource.mockResolvedValueOnce({ ok: false, message: "the vendor refused the key" });
    expect((await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`)).body).toEqual({ ok: false, message: "the vendor refused the key" });
    s.access.checkSource.mockRejectedValueOnce(agentXError("MODEL_PROXY_UNAVAILABLE", "model proxy is unreachable"));
    const down = await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect([down.status, errorOf(down).code]).toEqual([503, "MODEL_PROXY_UNAVAILABLE"]);
  });
});

describe("the store", () => {
  it("validates what it is given, whatever called it", async () => {
    const s = await setup();
    const store = s.store();
    const stored = { sourceId: "src_abcdefghij0123456789", kind: "anthropic", label: "L", models: [{ catalog: sonnet }] } as never;
    expect(await store.save({ orgId: TEST_ORG, source: stored, mode: "create", keyStored: true, by: DANA.developerId })).toEqual({ sourceId: "src_abcdefghij0123456789" });
    await expect(store.save({ orgId: TEST_ORG, source: stored, mode: "create", by: DANA.developerId })).rejects.toThrow("that source already exists");
    await expect(store.save({ orgId: TEST_ORG, source: { ...(stored as object), sourceId: "src_zzzzzzzzzzzzzzzzzzzz" } as never, mode: "update", by: DANA.developerId })).rejects.toThrow(MISSING);
    const kindChange = { ...(stored as object), kind: "openai", models: [{ catalog: { provider: "openai", modelId: "gpt-5" } }] } as never;
    await expect(store.save({ orgId: TEST_ORG, source: kindChange, mode: "update", by: DANA.developerId })).rejects.toThrow("a source's kind can't change");
    const wrongOrg = { sourceId: "src_klmnopqrst0123456789", kind: "bedrock", label: "L", roleArn: ROLE_ARN, region: "us-east-1", externalId: `rovara-${ORG_B}`, tested: false, models: [{ catalog: { provider: "amazon-bedrock", modelId: "us.anthropic.claude-sonnet-4-5-20250929-v1:0" } }] } as never;
    await expect(store.save({ orgId: TEST_ORG, source: wrongOrg, mode: "create", by: DANA.developerId })).rejects.toThrow("the external id does not belong to this organization");
    await expect(store.save({ orgId: TEST_ORG, source: { ...(stored as object), models: [] } as never, mode: "create", by: DANA.developerId })).rejects.toThrow();
    await expect(store.save({ orgId: "org_*", source: stored, mode: "create", by: DANA.developerId })).rejects.toThrow();
    await expect(store.save({ orgId: TEST_ORG, source: stored, mode: "create", by: "" })).rejects.toThrow("by: say who is making this change");
    await expect(store.setOrder({ orgId: TEST_ORG, order: ["src_zzzzzzzzzzzzzzzzzzzz"], by: DANA.developerId })).rejects.toThrow();
    expect((s.doc()!.sources as unknown[]).length).toBe(1);
  });

  it("holds an org to ten sources whoever adds them", async () => {
    const s = await setup();
    const store = s.store();
    const source = (index: number) => ({ sourceId: `src_${String(index).repeat(20)}`, kind: "anthropic", label: "L", models: [{ catalog: sonnet }] }) as never;
    for (let index = 0; index < 10; index += 1) await store.save({ orgId: TEST_ORG, source: source(index), mode: "create", by: DANA.developerId });
    await expect(store.save({ orgId: TEST_ORG, source: { ...(source(1) as object), sourceId: "src_zzzzzzzzzzzzzzzzzzzz" } as never, mode: "create", by: DANA.developerId })).rejects.toThrow("an organization can have at most 10 AI sources");
    expect((await store.read(TEST_ORG)).sources).toHaveLength(10);
  });

  it("fails closed on a record it cannot read, rather than falling back to the defaults", async () => {
    const s = await setup();
    s.db.set({ ...modelSourcesKey(TEST_ORG), entityType: "ORG_MODEL_SOURCES", revision: 1, sources: [{ nonsense: true }], order: ["rovara"], credentials: [] });
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const reply = await s.call(EVE, "GET", "/v1/app/org/model-sources");
    expect([reply.status, errorOf(reply).code]).toEqual([400, "CONFIG_INVALID"]);
    expect(errorOf(reply).message).toBe("your company's AI sources can't be read; ask a Rovara admin to look at them");
    expect(JSON.stringify(error.mock.calls)).not.toContain("nonsense");
  });

  it("holds ten sources of twenty long-named models in one item, under DynamoDB's limit, with the transaction at four items", async () => {
    const s = await setup();
    const store = s.store();
    for (let index = 0; index < 10; index += 1) {
      const name = (n: number) => `m${String(index)}-${String(n).padStart(3, "0")}-`.padEnd(256, "x");
      const source = {
        sourceId: `src_${String(index).repeat(20)}`, kind: "endpoint", label: "L".repeat(64), baseUrl: `https://h${String(index)}.example.com/${"p".repeat(2000)}`, api: "openai-completions",
        models: Array.from({ length: 20 }, (_, n) => ({ name: name(n), catalog: { provider: "x".repeat(60), modelId: `${"i".repeat(100)}${String(n)}` } })),
      } as never;
      await store.save({ orgId: TEST_ORG, source, mode: "create", keyStored: true, by: DANA.developerId });
    }
    expect(Buffer.byteLength(JSON.stringify(s.doc()))).toBeLessThan(400_000);
    expect(s.doc()!.sources).toHaveLength(10);
  });
});

describe("what a task does with the org's order", () => {
  const thread = `${SLACK_TEAM}/${SLACK_CHANNEL}/1695500000.000001`;
  const maya = "U0123456789";
  const models = { default: { provider: "amazon-bedrock", modelId: "default-model", label: "Balanced" }, approved: [{ provider: "amazon-bedrock", modelId: "default-model", label: "Balanced" }] };
  const connected: ChatGptConnectionView = { connected: true, status: "connected", email: "maya@acme.com", models: ["gpt-5.5", "gpt-6.1-sol"] };

  /** A Slack task whose owner has a working plan, on an install with the model proxy; `prepare` plants the org's sources and the install-wide switch. */
  async function task(prepare: (db: FakeDynamoDb) => void, options: { proxy?: boolean; installSwitch?: boolean } = {}) {
    const service = {
      settings: vi.fn(async () => ({ enabled: options.installSwitch ?? true, preferredModel: "gpt-6.1-sol" })),
      view: vi.fn(async () => connected),
    } as unknown as ChatGptConnections;
    const { handler, db } = createBroker({ extra: { chatgpt: service, ...(options.proxy === false ? {} : { modelAccess: { access: fakeModelAccess(), proxyUrl: "https://proxy.example.com" } }) } });
    prepare(db);
    await registerSlackProject(handler, { models });
    const workspace = await ensureWorkspace(handler, thread, maya);
    const workspaceId = workspace.body.workspaceId as string;
    markReady(db, workspaceId);
    const conversation = await serviceCall(handler, thread, maya, "POST", `/v1/service/workspaces/${workspaceId}/conversations`, {});
    const conversationId = (conversation.body.conversation as { id: string }).id;
    const started = await serviceCall(handler, thread, maya, "POST", `/v1/service/workspaces/${workspaceId}/tasks`, { requestId: randomUUID(), conversationId, prompt: "test it" });
    expect(started.status, JSON.stringify(started.body)).toBe(202);
    const operationId = (started.body.operation as { id: string }).id;
    return (db.find((item) => item.entityType === "OUTBOX" && item.operationId === operationId)[0]!.invocation as { payload: Record<string, unknown> }).payload;
  }
  const plant = (db: FakeDynamoDb, order: string[]) => db.set({ ...modelSourcesKey(TEST_ORG), entityType: "ORG_MODEL_SOURCES", revision: 1, sources: [], order, credentials: [], updatedBy: DANA.developerId, updatedAt: "2026-10-22T00:00:00.000Z" });

  it("runs on the owner's plan for an org that never changed its sources, with the install-wide switch on, as before", async () => {
    const payload = await task(() => undefined);
    expect(payload.chatgpt).toEqual({ model: { provider: "openai", modelId: "gpt-6.1-sol" } });
  });

  it("runs on the default for an org that never changed its sources, with the install-wide switch off", async () => {
    expect(await task(() => undefined, { installSwitch: false })).not.toHaveProperty("chatgpt");
  });

  it("runs on the default when the org's order leaves personal-chatgpt out, whatever the install-wide switch says", async () => {
    expect(await task((db) => plant(db, ["rovara"]))).not.toHaveProperty("chatgpt");
  });

  it("runs on the plan when the org's order has personal-chatgpt, and on the default when the org's sources cannot be read", async () => {
    expect((await task((db) => plant(db, ["personal-chatgpt", "rovara"]))).chatgpt).toEqual({ model: { provider: "openai", modelId: "gpt-6.1-sol" } });
    // The install-wide switch is a hard off: an order that kept personal-chatgpt from when the switch was on no longer runs tasks on a plan.
    expect(await task((db) => plant(db, ["personal-chatgpt", "rovara"]), { installSwitch: false })).not.toHaveProperty("chatgpt");
    const log = vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    const payload = await task((db) => { db.set({ ...modelSourcesKey(TEST_ORG), entityType: "ORG_MODEL_SOURCES", revision: 1, sources: "garbage", order: ["rovara"], credentials: [] }); });
    expect(payload).not.toHaveProperty("chatgpt");
    expect(log.mock.calls.map(([line]) => JSON.parse(String(line)) as { event?: string }).some((entry) => entry.event === "model_sources.unreadable")).toBe(true);
  });

  it("leaves the install-wide switch in charge where the install has no model proxy", async () => {
    // A record planted for the org is not read at all: with no proxy the sources are not a thing.
    expect((await task((db) => plant(db, ["rovara"]), { proxy: false })).chatgpt).toEqual({ model: { provider: "openai", modelId: "gpt-6.1-sol" } });
  });

  it("gives settings(orgId) the org's say, and the install's own without an org or a source of orgs", async () => {
    const SEALER: ChatGptSealer = { seal: async (plaintext) => `sealed:${plaintext}`, open: async (sealed) => sealed.slice("sealed:".length) };
    const db = new (await import("../support/fake-dynamodb.js")).FakeDynamoDb();
    db.set({ ...CHATGPT_SETTINGS_KEY, entityType: "SETTING", enabled: true, preferredModel: "gpt-5.5" });
    const base = { documentClient: db, tableName: "state", sealer: SEALER, fetch: vi.fn(), now: () => Date.now(), hostId: "urn:uuid:00000000-0000-4000-8000-000000000000" };
    const orgs: Record<string, Pick<OrgModelSources, "order" | "chatgptPreferredModel">> = { [TEST_ORG]: { order: ["rovara"] }, [ORG_B]: { order: ["personal-chatgpt", "rovara"], chatgptPreferredModel: "gpt-6.1-sol" } };
    const withOrgs = chatGptConnections({ ...base, orgSources: async (org) => orgs[org]! });
    expect(await withOrgs.settings(TEST_ORG)).toEqual({ enabled: false, preferredModel: "gpt-5.5" });
    expect(await withOrgs.settings(ORG_B)).toEqual({ enabled: true, preferredModel: "gpt-6.1-sol" });
    // With the install-wide switch off, no org's order turns it on.
    db.set({ ...CHATGPT_SETTINGS_KEY, entityType: "SETTING", enabled: false, preferredModel: "gpt-5.5" });
    expect(await withOrgs.settings(ORG_B)).toEqual({ enabled: false, preferredModel: "gpt-6.1-sol" });
    db.set({ ...CHATGPT_SETTINGS_KEY, entityType: "SETTING", enabled: true, preferredModel: "gpt-5.5" });
    expect(await withOrgs.settings()).toEqual({ enabled: true, preferredModel: "gpt-5.5" });
    expect(await chatGptConnections(base).settings(TEST_ORG)).toEqual({ enabled: true, preferredModel: "gpt-5.5" });
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 1 (review of 24b)
// ---------------------------------------------------------------------------------------------------------------------

/** What the model proxy holds for each endpoint source, kept the way it keeps it: a key stays until a new one is sent or the source is removed. */
function trackProxy(s: Awaited<ReturnType<typeof setup>>) {
  const proxy = new Map<string, { host: string; key: string | undefined }>();
  const apply = ({ source, apiKey }: { source: { kind: string; sourceId: string; baseUrl?: string }; apiKey?: string | undefined }): void => {
    if (source.kind === "endpoint") proxy.set(source.sourceId, { host: new URL(source.baseUrl!).hostname, key: apiKey ?? proxy.get(source.sourceId)?.key });
  };
  s.access.upsertSource.mockImplementation(async (input) => { apply(input); });
  s.access.removeSource.mockImplementation(async (_org, id) => { proxy.delete(id); });
  /** What an `upsertSource` does to the proxy, for a test that wraps one. */
  return Object.assign(proxy, { apply });
}

/** Holds the first `count` writes of the record until all of them are ready, so each has read the record as it was before any of them. */
function holdRecordWrites(db: FakeDynamoDb, count: number): void {
  const send = db.send.bind(db) as (command: unknown) => Promise<unknown>;
  let ready = 0;
  let open!: () => void;
  const gate = new Promise<void>((resolve) => { open = resolve; });
  (db as unknown as { send: (command: unknown) => Promise<unknown> }).send = async (command: unknown) => {
    if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("MODEL_SOURCES") && ready < count) {
      ready += 1;
      if (ready === count) open();
      await gate;
    }
    return send(command);
  };
}

const conflicts = { name: "TransactionCanceledException", cancellationReasons: [{ Code: "ConditionalCheckFailed" }, { Code: "None" }, { Code: "None" }] };
const touchesRecord = (input: Record<string, unknown>) => JSON.stringify(input).includes("MODEL_SOURCES");

describe("a change is conditional on what the route checked (I1)", () => {
  const OTHER_HOST = "other.example.org";
  const moved = () => endpoint({ baseUrl: `https://${OTHER_HOST}/v1` });

  it("never leaves a key at a host it was not saved for when a host move and another change land at once", async () => {
    const s = await setup({ cloud: false });
    const proxy = trackProxy(s);
    const created = await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint(), apiKey: KEY });
    const id = created.body.sourceId as string;
    holdRecordWrites(s.db, 2);
    const [move, rename] = await Promise.all([
      s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: moved(), apiKey: OTHER_KEY }),
      s.write(OWEN, "PUT", `/v1/app/org/model-sources/${id}`, { source: endpoint({ label: "Renamed" }) }),
    ]);
    // One change applied and the other was refused as stale, whichever got there first.
    expect([move.status, rename.status].sort()).toEqual([200, 409]);
    const recordHost = new URL((s.doc()!.sources[0] as { baseUrl: string }).baseUrl).hostname;
    const held = proxy.get(id);
    expect(held, "the source is still registered").toBeDefined();
    // The invariant: the proxy holds a key only for the host the record names, and the record says so.
    if (held!.key !== undefined) expect(held!.host).toBe(recordHost);
    expect(s.doc()!.credentials.includes(id)).toBe(held!.key !== undefined);
    expect(s.everything()).not.toContain(OTHER_KEY);
  });

  it("drops the key from the proxy when a host move fails to save, and the record says the source has none", async () => {
    const s = await setup({ cloud: false });
    const proxy = trackProxy(s);
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint(), apiKey: KEY })).body.sourceId as string;
    expect(proxy.get(id)).toEqual({ host: HOST, key: KEY });
    s.db.injectFault({ command: "TransactWriteCommand", match: touchesRecord, times: 3, error: conflicts });
    const failed = await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: moved(), apiKey: OTHER_KEY });
    expect([failed.status, errorOf(failed).code]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
    // The record still names the old host; the proxy has the old host and no key at all, never the new key beside the old host.
    expect(new URL((s.doc()!.sources[0] as { baseUrl: string }).baseUrl).hostname).toBe(HOST);
    expect(proxy.get(id)).toEqual({ host: HOST, key: undefined });
    expect(s.access.removeSource).toHaveBeenCalledWith(TEST_ORG, id);
    expect(s.doc()!.credentials).toEqual([]);
    expect((await s.list()).sources[0]!.hasCredential).toBe(false);
    expect(s.everything()).not.toContain(OTHER_KEY);
  });

  it("refuses a change that was checked against a record that has moved, instead of planning it again", async () => {
    const s = await setup({ cloud: false });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint(), apiKey: KEY })).body.sourceId as string;
    const stale = (await s.store().read(TEST_ORG)).revision;
    expect((await s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: ["rovara", id] })).status).toBe(200);
    const source = (await s.store().read(TEST_ORG)).sources[0]!;
    await expect(s.store().save({ orgId: TEST_ORG, source: { ...source, label: "Stale" }, mode: "update", expect: { revision: stale }, by: DANA.developerId })).rejects.toThrow("changed while saving");
    await expect(s.store().save({ orgId: TEST_ORG, source: { ...source, label: "Fresh" }, mode: "update", expect: { revision: stale + 1 }, by: DANA.developerId })).resolves.toEqual({ sourceId: id });
  });
});

describe("a Bedrock check only marks the role it probed (I2)", () => {
  const OTHER_ROLE = "arn:aws:iam::123456789012:role/rovara/other-access";

  it("does not mark a role tested, or register it, when the source changed while it was probed", async () => {
    const s = await setup();
    const id = await s.add(DANA, bedrock());
    s.access.checkSource.mockImplementationOnce(async () => {
      expect((await s.write(OWEN, "PUT", `/v1/app/org/model-sources/${id}`, { source: bedrock({ roleArn: OTHER_ROLE }) })).status).toBe(200);
      return { ok: true as const, health: "healthy" as const };
    });
    const calls = s.access.upsertSource.mock.calls.length;
    const check = await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect([check.status, check.body]).toEqual([200, { ok: false, message: "this source changed while it was being tested; run the check again" }]);
    expect(s.doc()!.sources[0]).toMatchObject({ roleArn: OTHER_ROLE, tested: false });
    // Only the change's own registration happened; the probed role was not registered again.
    expect(s.access.upsertSource.mock.calls.length).toBe(calls + 1);
    expect(s.access.upsertSource.mock.calls.at(-1)![0].source).toMatchObject({ roleArn: OTHER_ROLE, tested: false });
  });

  it("does not register an already tested role again when the source changed while it was probed", async () => {
    const s = await setup();
    const id = await s.add(DANA, bedrock());
    expect((await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`)).body).toEqual({ ok: true });
    s.access.checkSource.mockImplementationOnce(async () => {
      expect((await s.write(OWEN, "PUT", `/v1/app/org/model-sources/${id}`, { source: bedrock({ roleArn: OTHER_ROLE }) })).status).toBe(200);
      return { ok: true as const, health: "healthy" as const };
    });
    const calls = s.access.upsertSource.mock.calls.length;
    const check = await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect(check.body).toEqual({ ok: false, message: "this source changed while it was being tested; run the check again" });
    expect(s.access.upsertSource.mock.calls.length).toBe(calls + 1);
    expect(s.access.upsertSource.mock.calls.at(-1)![0].source).toMatchObject({ roleArn: OTHER_ROLE, tested: false });
  });
});

describe("removals that did not finish (I5)", () => {
  const unavailable = () => agentXError("MODEL_PROXY_UNAVAILABLE", "model proxy is unreachable");

  async function unfinishedRemoval(options: Options = { cloud: false }) {
    const s = await setup(options);
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint(), apiKey: KEY })).body.sourceId as string;
    s.access.removeSource.mockRejectedValueOnce(unavailable());
    const failed = await s.write(DANA, "DELETE", `/v1/app/org/model-sources/${id}`);
    expect([failed.status, errorOf(failed).code]).toEqual([503, "MODEL_PROXY_UNAVAILABLE"]);
    return { s, id };
  }

  it("writes a tombstone in the removal's own transaction", async () => {
    const { s, id } = await unfinishedRemoval();
    expect(s.doc()).toMatchObject({ sources: [], removing: [{ sourceId: id, kind: "endpoint" }] });
  });

  it("finishes the cleanup on the next write, whatever its request id, and clears the tombstone", async () => {
    const { s, id } = await unfinishedRemoval();
    s.access.removeSource.mockClear();
    expect((await s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: ["rovara"] })).status).toBe(200);
    expect(s.access.removeSource).toHaveBeenCalledWith(TEST_ORG, id);
    expect(s.doc()!.removing).toEqual([]);
  });

  it("finishes it when a member reads the list, and says nothing of it", async () => {
    const { s, id } = await unfinishedRemoval();
    s.access.removeSource.mockClear();
    const listed = await s.call(EVE, "GET", "/v1/app/org/model-sources");
    expect(listed.status).toBe(200);
    expect(JSON.stringify(listed.body)).not.toContain("removing");
    expect(s.access.removeSource).toHaveBeenCalledWith(TEST_ORG, id);
    expect(s.doc()!.removing).toEqual([]);
  });

  it("releases the host from the union even when the removal died before the egress release", async () => {
    const s = await setup({ cloud: false });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() })).body.sourceId as string;
    s.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("EGRESS_DOMAINS"), error: { name: "InternalServerError" } });
    expect((await s.write(DANA, "DELETE", `/v1/app/org/model-sources/${id}`)).status).toBeGreaterThanOrEqual(500);
    expect(await approvedUnion(s.egressDeps())).toEqual([HOST]);
    await s.call(EVE, "GET", "/v1/app/org/model-sources");
    expect(await approvedUnion(s.egressDeps())).toEqual([]);
    expect(s.doc()!.removing).toEqual([]);
  });

  it("holds at 50 owed removals: a 51st waits until some are finished", async () => {
    const s = await setup({ cloud: false });
    const id = await s.add(DANA, anthropic());
    s.access.removeSource.mockRejectedValue(unavailable());
    const owed = Array.from({ length: 50 }, (_, index) => ({ sourceId: `src_${String(index).padStart(20, "0")}`, kind: "anthropic" }));
    s.db.set({ ...s.doc()!, removing: owed });
    const refused = await s.write(DANA, "DELETE", `/v1/app/org/model-sources/${id}`);
    expect([refused.status, errorOf(refused).code, errorOf(refused).message]).toEqual([503, "RUNTIME_UNAVAILABLE", "earlier removals haven't finished; try again in a few minutes"]);
    expect(s.doc()!.sources).toHaveLength(1);
    expect(s.doc()!.removing).toHaveLength(50);
  });

  it("keeps a failing cleanup from failing the read or the write that tried it", async () => {
    const { s } = await unfinishedRemoval();
    s.access.removeSource.mockRejectedValue(unavailable());
    expect((await s.call(EVE, "GET", "/v1/app/org/model-sources")).status).toBe(200);
    expect((await s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: ["rovara"] })).status).toBe(200);
    expect(s.doc()!.removing).toHaveLength(1);
  });
});

describe("the sweeper", () => {
  const STRAY = "src_zzzzzzzzzzzzzzzzzzzz";
  const STRAY_B = "src_yyyyyyyyyyyyyyyyyyyy";
  const T0 = Date.parse("2026-10-22T10:00:00.000Z");
  const minutes = (n: number) => n * 60_000;

  function sweeper(s: Awaited<ReturnType<typeof setup>>, clock: { t: number }) {
    return () => sweepModelSources({
      documentClient: s.db, tableName: "state", now: () => clock.t, store: s.store(), access: s.access, egress: s.egressDeps(),
    }, { budgetMs: 5_000 });
  }

  it("finishes a removal that nobody repeated: the tombstone's host leaves the union and the proxy forgets the source", async () => {
    const s = await setup({ cloud: false });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint(), apiKey: KEY })).body.sourceId as string;
    // The removal dies at the egress release, before the proxy is asked anything.
    s.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("EGRESS_DOMAINS"), error: { name: "InternalServerError" } });
    await s.write(DANA, "DELETE", `/v1/app/org/model-sources/${id}`);
    expect(await approvedUnion(s.egressDeps())).toEqual([HOST]);
    s.access.removeSource.mockClear();
    const report = await sweeper(s, { t: T0 })();
    expect(report.complete).toBe(true);
    expect(s.access.removeSource).toHaveBeenCalledWith(TEST_ORG, id);
    expect(await approvedUnion(s.egressDeps())).toEqual([]);
    expect(s.doc()!.removing).toEqual([]);
  });

  it("releases an egress owner whose source the record does not have, and leaves a live source's host alone", async () => {
    const s = await setup({ cloud: false });
    const live = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint({ baseUrl: "https://live.example.com/v1" }) })).body.sourceId as string;
    await putEgressDomains(s.egressDeps(), TEST_ORG, { kind: "model-source", sourceId: STRAY }, [HOST], { developerId: DANA.developerId });
    await putEgressDomains(s.egressDeps(), ORG_B, { kind: "model-source", sourceId: STRAY_B }, ["b.example.com"], { developerId: BEA.developerId });
    expect(await approvedUnion(s.egressDeps())).toEqual(["b.example.com", HOST, "live.example.com"].sort());
    await sweeper(s, { t: T0 })();
    expect(await approvedUnion(s.egressDeps())).toEqual(["live.example.com"]);
    expect((await s.egressOf(live))!.domains.map((entry) => entry.domain)).toEqual(["live.example.com"]);
    expect((await listEgressItems(s.egressDeps())).filter((item) => item.owner.kind === "model-source" && item.domains.length > 0).map((item) => item.owner)).toEqual([{ kind: "model-source", sourceId: live }]);
  });

  it("drops the old host a crashed host change left approved (M2)", async () => {
    const s = await setup({ cloud: false });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() })).body.sourceId as string;
    // The record commits the new host, and the egress request after it dies.
    s.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("EGRESS_DOMAINS"), error: { name: "InternalServerError" } });
    expect((await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: endpoint({ baseUrl: "https://other.example.org/v1" }) })).status).toBeGreaterThanOrEqual(500);
    expect(await approvedUnion(s.egressDeps())).toEqual([HOST]);
    await sweeper(s, { t: T0 })();
    // The old host leaves the union; the host the record names is the live one, so it is asked for (approved at once on a private install).
    expect(await approvedUnion(s.egressDeps())).toEqual(["other.example.org"]);
  });

  it("removes a registration no record names only after seeing it twice, ten minutes apart, so an add in flight is not undone", async () => {
    const s = await setup();
    const live = await s.add(DANA, anthropic());
    const registered = [{ orgId: TEST_ORG, sourceId: live }, { orgId: TEST_ORG, sourceId: STRAY }, { orgId: ORG_B, sourceId: STRAY_B }];
    s.access.listSources.mockImplementation(async () => registered);
    const clock = { t: T0 };
    const sweep = sweeper(s, clock);
    s.access.removeSource.mockClear();
    await sweep();
    clock.t = T0 + minutes(5);
    await sweep();
    expect(s.access.removeSource).not.toHaveBeenCalled();
    clock.t = T0 + minutes(11);
    await sweep();
    expect(s.access.removeSource.mock.calls.map(([org, id]) => `${org}/${id}`).sort()).toEqual([`${ORG_B}/${STRAY_B}`, `${TEST_ORG}/${STRAY}`].sort());
  });

  it("forgets a stray that a record names by the next sighting", async () => {
    const s = await setup();
    s.access.listSources.mockImplementation(async () => [{ orgId: TEST_ORG, sourceId: STRAY }]);
    const clock = { t: T0 };
    const sweep = sweeper(s, clock);
    await sweep();
    // The add that registered it commits its record.
    const source = { sourceId: STRAY, kind: "anthropic", label: "Late", models: [{ catalog: sonnet }] } as never;
    await s.store().save({ orgId: TEST_ORG, source, mode: "create", keyStored: true, by: DANA.developerId });
    const seen = { pk: "MODEL_SOURCES_SWEEP", sk: `ORPHAN#${TEST_ORG}#${STRAY}` };
    expect(s.db.get(seen)).toBeDefined();
    clock.t = T0 + minutes(11);
    s.access.removeSource.mockClear();
    await sweep();
    // A record names it now, so the sighting is forgotten: it cannot count towards removing the source later.
    expect(s.db.get(seen)).toBeUndefined();
    clock.t = T0 + minutes(25);
    await sweep();
    expect(s.access.removeSource).not.toHaveBeenCalled();
  });

  it("stops at its time budget and carries on from where it stopped", async () => {
    const s = await setup({ cloud: false });
    const a = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() })).body.sourceId as string;
    const b = (await s.write(BEA, "POST", "/v1/app/org/model-sources", { source: endpoint({ baseUrl: "https://b.example.com/v1" }) })).body.sourceId as string;
    const clock = { t: T0 };
    // Each removal is slow: the clock moves two seconds.
    s.access.removeSource.mockImplementation(async () => { clock.t += 2_000; });
    s.access.removeSource.mockRejectedValueOnce(agentXError("MODEL_PROXY_UNAVAILABLE", "x"));
    await s.write(DANA, "DELETE", `/v1/app/org/model-sources/${a}`);
    s.access.removeSource.mockRejectedValueOnce(agentXError("MODEL_PROXY_UNAVAILABLE", "x"));
    await s.write(BEA, "DELETE", `/v1/app/org/model-sources/${b}`);
    s.access.removeSource.mockClear();
    const first = await sweepModelSources({ documentClient: s.db, tableName: "state", now: () => clock.t, store: s.store(), access: s.access, egress: s.egressDeps() }, { budgetMs: 1_500 });
    expect(first.complete).toBe(false);
    expect(s.access.removeSource).toHaveBeenCalledTimes(1);
    // It says where it stopped: after the org it finished.
    expect(s.db.get("MODEL_SOURCES_SWEEP", "CURSOR")).toMatchObject({ cursor: TEST_ORG });
    const second = await sweepModelSources({ documentClient: s.db, tableName: "state", now: () => clock.t, store: s.store(), access: s.access, egress: s.egressDeps() }, { budgetMs: 1_500 });
    expect(s.access.removeSource).toHaveBeenCalledTimes(2);
    expect(second.complete).toBe(true);
    expect(s.db.get("MODEL_SOURCES_SWEEP", "CURSOR")).toBeUndefined();
    expect(s.doc()!.removing).toEqual([]);
    expect(s.doc(ORG_B)!.removing).toEqual([]);
  });
});

describe("a check after a crash during a host change (M4)", () => {
  it("releases the old host and asks for the new one", async () => {
    const s = await setup({ cloud: true });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() })).body.sourceId as string;
    await s.decide(id, "approved");
    s.db.injectFault({ command: "TransactWriteCommand", match: (input) => JSON.stringify(input).includes("EGRESS_DOMAINS"), error: { name: "InternalServerError" } });
    const crashed = await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: endpoint({ baseUrl: "https://other.example.org/v1" }), apiKey: OTHER_KEY });
    expect(crashed.status).toBeGreaterThanOrEqual(500);
    // The record names the new host; the egress item still lists the old, approved one.
    expect((await s.list()).sources[0]!.hostStatus).toBe("not_requested");
    expect((await s.egressOf(id))!.domains.map((entry) => [entry.domain, entry.status])).toEqual([[HOST, "approved"]]);
    const check = await s.call(DANA, "POST", `/v1/app/org/model-sources/${id}/check`);
    expect(check.body).toEqual({ ok: false, message: "other.example.org is waiting for Rovara to approve it" });
    expect((await s.egressOf(id))!.domains.map((entry) => [entry.domain, entry.status])).toEqual([["other.example.org", "pending"]]);
    expect(await approvedUnion(s.egressDeps())).toEqual([]);
  });
});

describe("closing an org (I5)", () => {
  it("removes every source from the proxy, finishes its tombstones and deletes the record, after its egress is cleared", async () => {
    const db = new (await import("../support/fake-dynamodb.js")).FakeDynamoDb();
    const access = fakeModelAccess();
    const at = Date.parse("2026-10-22T10:00:00.000Z");
    db.set({ ...orgMetaKey(TEST_ORG), entityType: "ORG", orgId: TEST_ORG, name: "Acme", createdAt: "2026-10-01T00:00:00.000Z", createdBy: "dev-owner", plan: "team" });
    db.set({ ...orgMemberKey(TEST_ORG, "dev-owner"), entityType: "ORG_MEMBER", orgId: TEST_ORG, developerId: "dev-owner", role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" });
    db.set({ ...developerOrgKey("dev-owner"), entityType: "DEVELOPER_ORG", orgId: TEST_ORG, role: "owner", joinedAt: "2026-10-01T00:00:00.000Z" });
    const store = new ModelSourceStore({ documentClient: db, tableName: "state", now: () => at, chatgptSwitch: async () => false });
    const egress: EgressDomainsDependencies = { documentClient: db, tableName: "state", cloud: false, now: () => new Date(at), sync: async () => ({ ok: true }) };
    const source = (index: number) => ({ sourceId: `src_${String(index).repeat(20)}`, kind: "endpoint", label: "L", baseUrl: `https://h${String(index)}.example.com/v1`, api: "openai-completions", models: [{ name: "m", catalog: sonnet }] }) as never;
    await store.save({ orgId: TEST_ORG, source: source(1), mode: "create", keyStored: true, by: "dev-owner" });
    await store.save({ orgId: TEST_ORG, source: source(2), mode: "create", by: "dev-owner" });
    await store.remove({ orgId: TEST_ORG, sourceId: `src_${"2".repeat(20)}`, by: "dev-owner" });
    await putEgressDomains(egress, TEST_ORG, { kind: "model-source", sourceId: `src_${"1".repeat(20)}` }, ["h1.example.com"], { developerId: "dev-owner" });
    expect((db.get(modelSourcesKey(TEST_ORG)) as { removing: unknown[] }).removing).toHaveLength(1);

    const order: string[] = [];
    const orgs = new OrgStore({ documentClient: db, tableName: "state", now: () => at });
    await orgs.closeOrg(TEST_ORG, {
      archiveProjects: async () => undefined,
      clearEgress: async () => { order.push("egress"); },
      releaseModelSources: async (org) => { order.push("sources"); await releaseOrgModelSources({ store, access, egress }, org); },
    });
    expect(order).toEqual(["egress", "sources"]);
    expect(access.removeSource.mock.calls.map(([, id]) => id).sort()).toEqual([`src_${"1".repeat(20)}`, `src_${"2".repeat(20)}`]);
    expect(db.get(modelSourcesKey(TEST_ORG))).toBeUndefined();
    expect(await approvedUnion(egress)).toEqual([]);
  });

  it("is wired into leaving as the last owner: the route's close removes the org's sources", async () => {
    const s = await setup({ cloud: true });
    const id = await s.add(BEA, anthropic());
    // Bea is org B's only admin; make her its only member and owner.
    seedMembership(s.db, BEA.developerId, { orgId: ORG_B, role: "owner" });
    s.db.delete(orgMemberKey(ORG_B, OMAR.developerId));
    s.db.delete(developerOrgKey(OMAR.developerId));
    s.access.removeSource.mockClear();
    const left = await s.call(BEA, "POST", "/v1/app/org/leave", { requestId: randomUUID() });
    expect(left.status, JSON.stringify(left.body)).toBe(200);
    expect(s.access.removeSource).toHaveBeenCalledWith(ORG_B, id);
    expect(s.doc(ORG_B)).toBeUndefined();
  });
});

describe("turning ChatGPT into an order the install allows (I6)", () => {
  it("refuses to add personal-chatgpt to the order while the install-wide switch is off, and lets an order that already has it stay", async () => {
    const s = await setup();
    const id = await s.add(DANA, anthropic());
    const refused = await s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: ["personal-chatgpt", "rovara", id] });
    expect([refused.status, errorOf(refused).code, errorOf(refused).message]).toEqual([400, "CONFIG_INVALID", expect.stringContaining("Sign in with ChatGPT is turned off") as unknown]);
    expect(s.doc()!.order).toEqual(["rovara"]);
    s.switchOn();
    expect((await s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: ["personal-chatgpt", "rovara", id] })).status).toBe(200);
    // The operator turns ChatGPT off later: the order may be reordered with it in, only adding it is refused.
    s.db.set({ ...CHATGPT_SETTINGS_KEY, entityType: "SETTING", enabled: false, preferredModel: "gpt-6.1-sol" });
    expect((await s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: ["rovara", "personal-chatgpt", id] })).status).toBe(200);
    expect((await s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: ["rovara", id] })).status).toBe(200);
    expect((await s.write(DANA, "PUT", "/v1/app/org/model-sources-order", { order: ["rovara", "personal-chatgpt", id] })).status).toBe(400);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
// Fix round 2 (re-check of the review)
// ---------------------------------------------------------------------------------------------------------------------

describe("a key sent by a change that did not save never stays at another writer's host (I1, round 2)", () => {
  it("drops the key when a same-host key change loses to a host move", async () => {
    const s = await setup({ cloud: false });
    const proxy = trackProxy(s);
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint(), apiKey: KEY })).body.sourceId as string;
    // A rotates the key and keeps the host. Before A's proxy write lands, B's whole host move (key, record, egress) completes.
    const register = s.access.upsertSource.getMockImplementation()!;
    s.access.upsertSource.mockImplementationOnce(async (input) => {
      const moved = await s.write(OWEN, "PUT", `/v1/app/org/model-sources/${id}`, { source: endpoint({ baseUrl: "https://other.example.org/v1" }), apiKey: OTHER_KEY });
      expect(moved.status, JSON.stringify(moved.body)).toBe(200);
      await register(input);
    });
    const rotated = await s.write(DANA, "PUT", `/v1/app/org/model-sources/${id}`, { source: endpoint({ label: "Rotated" }), apiKey: "sk-ant-planted-third-key-1111111111111111" });
    expect([rotated.status, errorOf(rotated).code]).toEqual([409, "IDEMPOTENCY_CONFLICT"]);
    expect(new URL((s.doc()!.sources[0] as { baseUrl: string }).baseUrl).hostname).toBe("other.example.org");
    // Neither key stays: the proxy has the record's host and no key, and the record says so.
    expect(proxy.get(id)).toEqual({ host: "other.example.org", key: undefined });
    expect(s.doc()!.credentials).toEqual([]);
    expect(s.everything()).not.toContain("planted-third-key");
  });
});

describe("the sweeper compares each endpoint's host in the proxy with the record's (round 2)", () => {
  const T0 = Date.parse("2026-10-22T10:00:00.000Z");
  const minutes = (n: number) => n * 60_000;
  const EVIL = "evil.example.net";

  function sweeperOf(s: Awaited<ReturnType<typeof setup>>, clock: { t: number }, store = s.store()) {
    return () => sweepModelSources({ documentClient: s.db, tableName: "state", now: () => clock.t, store, access: s.access, egress: s.egressDeps() }, { budgetMs: 5_000 });
  }
  const listing = (s: Awaited<ReturnType<typeof setup>>, sourceId: string, hosts: string[] | undefined) =>
    s.access.listSources.mockImplementation(async () => [{ orgId: TEST_ORG, sourceId, ...(hosts === undefined ? {} : { hosts }) }]);
  const mismatchItem = (id: string) => ({ pk: "MODEL_SOURCES_SWEEP", sk: `MISMATCH#${TEST_ORG}#${id}` });

  async function withKey() {
    const s = await setup({ cloud: false });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint(), apiKey: KEY })).body.sourceId as string;
    return { s, id };
  }

  it("drops the key and registers the source again without one when a host differs twice, ten minutes apart", async () => {
    const { s, id } = await withKey();
    listing(s, id, [EVIL]);
    const clock = { t: T0 };
    const sweep = sweeperOf(s, clock);
    s.access.removeSource.mockClear();
    s.access.upsertSource.mockClear();
    await sweep();
    clock.t = T0 + minutes(5);
    await sweep();
    expect(s.access.removeSource).not.toHaveBeenCalled();
    clock.t = T0 + minutes(11);
    const report = await sweep();
    expect(report.rebound).toBe(1);
    expect(s.access.removeSource).toHaveBeenCalledWith(TEST_ORG, id);
    expect(s.access.upsertSource).toHaveBeenCalledTimes(1);
    expect(s.access.upsertSource.mock.calls[0]![0].apiKey).toBeUndefined();
    expect(s.access.upsertSource.mock.calls[0]![0].source).toMatchObject({ sourceId: id, baseUrl: `https://${HOST}/v1` });
    // Removal first (it deletes the credential), then the keyless registration, then the record says there is no key.
    expect(s.access.removeSource.mock.invocationCallOrder[0]!).toBeLessThan(s.access.upsertSource.mock.invocationCallOrder[0]!);
    expect(s.doc()!.credentials).toEqual([]);
    expect(s.db.get(mismatchItem(id))).toBeUndefined();
  });

  it("acts on a model's host or a credential's host alike, and leaves a source alone whose hosts all match or are unknown", async () => {
    const { s, id } = await withKey();
    const clock = { t: T0 };
    const sweep = sweeperOf(s, clock);
    s.access.removeSource.mockClear();
    for (const hosts of [[HOST], [HOST, HOST], [], undefined]) {
      listing(s, id, hosts);
      clock.t += minutes(11);
      await sweep();
      expect(s.db.get(mismatchItem(id)), JSON.stringify(hosts)).toBeUndefined();
    }
    expect(s.access.removeSource).not.toHaveBeenCalled();
    // One bad host among good ones is a mismatch.
    listing(s, id, [HOST, EVIL]);
    clock.t += minutes(1);
    await sweep();
    expect(s.db.get(mismatchItem(id))).toBeDefined();
  });

  it("forgets a mismatch that went away, so it cannot count towards a later one", async () => {
    const { s, id } = await withKey();
    const clock = { t: T0 };
    const sweep = sweeperOf(s, clock);
    listing(s, id, [EVIL]);
    await sweep();
    expect(s.db.get(mismatchItem(id))).toBeDefined();
    // The change that was in flight finished: the proxy now has the record's host.
    listing(s, id, [HOST]);
    clock.t = T0 + minutes(5);
    await sweep();
    expect(s.db.get(mismatchItem(id))).toBeUndefined();
    listing(s, id, [EVIL]);
    clock.t = T0 + minutes(12);
    s.access.removeSource.mockClear();
    await sweep();
    expect(s.access.removeSource).not.toHaveBeenCalled();
  });

  it("does not act on a mismatch when a consistent read just before finds the record at the proxy's host", async () => {
    const { s, id } = await withKey();
    const clock = { t: T0 };
    listing(s, id, [EVIL]);
    await sweeperOf(s, clock)();
    // The change that moves the record to the proxy's host commits between the sweep's first read of the record and its last look.
    const store = s.store();
    const read = store.readIfAny.bind(store);
    let reads = 0;
    store.readIfAny = async (org) => {
      reads += 1;
      if (reads === 2) await s.store().save({ orgId: TEST_ORG, source: { ...(await s.store().read(TEST_ORG)).sources[0]!, baseUrl: `https://${EVIL}/v1` } as never, mode: "update", by: DANA.developerId });
      return read(org);
    };
    clock.t = T0 + minutes(11);
    s.access.removeSource.mockClear();
    await sweeperOf(s, clock, store)();
    expect(reads).toBeGreaterThanOrEqual(2);
    expect(s.access.removeSource).not.toHaveBeenCalled();
    expect(s.doc()!.credentials).toEqual([id]);
  });

  it("ignores hosts of a source that is not an endpoint", async () => {
    const s = await setup({ cloud: false });
    const id = await s.add(DANA, anthropic());
    listing(s, id, [EVIL]);
    const clock = { t: T0 };
    const sweep = sweeperOf(s, clock);
    await sweep();
    clock.t = T0 + minutes(30);
    s.access.removeSource.mockClear();
    await sweep();
    expect(s.access.removeSource).not.toHaveBeenCalled();
  });
});

describe("the sweeper's remaining cares (round 2)", () => {
  const T0 = Date.parse("2026-10-22T10:00:00.000Z");
  const minutes = (n: number) => n * 60_000;
  const STRAY = "src_zzzzzzzzzzzzzzzzzzzz";

  it("looks at the record again, consistently, before it removes a stray", async () => {
    const s = await setup();
    s.access.listSources.mockImplementation(async () => [{ orgId: TEST_ORG, sourceId: STRAY }]);
    const clock = { t: T0 };
    const make = (store = s.store()) => () => sweepModelSources({ documentClient: s.db, tableName: "state", now: () => clock.t, store, access: s.access, egress: s.egressDeps() }, { budgetMs: 5_000 });
    await make()();
    // The retry of the add that registered it commits its record just after the sweep's first read.
    const store = s.store();
    const read = store.readIfAny.bind(store);
    let reads = 0;
    store.readIfAny = async (org) => {
      reads += 1;
      if (reads === 2) await s.store().save({ orgId: TEST_ORG, source: { sourceId: STRAY, kind: "anthropic", label: "Retried", models: [{ catalog: sonnet }] } as never, mode: "create", keyStored: true, by: DANA.developerId });
      return read(org);
    };
    clock.t = T0 + minutes(11);
    s.access.removeSource.mockClear();
    await make(store)();
    expect(s.access.removeSource).not.toHaveBeenCalled();
    expect(s.db.get({ pk: "MODEL_SOURCES_SWEEP", sk: `ORPHAN#${TEST_ORG}#${STRAY}` })).toBeUndefined();
  });

  it("never wipes the host a live endpoint's record names, even when the egress item it listed is stale", async () => {
    const s = await setup({ cloud: false });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() })).body.sourceId as string;
    // A change committed the new host to the record; its own egress request lands right after the sweeper lists the items (still the old host).
    const source = (await s.store().read(TEST_ORG)).sources[0]!;
    await s.store().save({ orgId: TEST_ORG, source: { ...source, baseUrl: "https://other.example.org/v1" } as never, mode: "update", by: DANA.developerId });
    let landed = false;
    const egress: EgressDomainsDependencies = {
      ...s.egressDeps(),
      documentClient: {
        send: async (command: unknown) => {
          const answer = await s.db.send(command as never);
          const input = (command as { constructor: { name: string }; input: { ExpressionAttributeValues?: Record<string, unknown> } });
          if (!landed && input.constructor.name === "QueryCommand" && input.input.ExpressionAttributeValues?.[":pk"] === "EGRESS_DOMAINS") {
            landed = true;
            await putEgressDomains(s.egressDeps(), TEST_ORG, { kind: "model-source", sourceId: id }, ["other.example.org"], { developerId: DANA.developerId });
          }
          return answer;
        },
      },
    };
    await sweepModelSources({ documentClient: s.db, tableName: "state", now: () => T0, store: s.store(), access: s.access, egress }, { budgetMs: 5_000 });
    expect(landed).toBe(true);
    expect((await s.egressOf(id))!.domains.map((entry) => [entry.domain, entry.status])).toEqual([["other.example.org", "approved"]]);
    expect(await approvedUnion(s.egressDeps())).toEqual(["other.example.org"]);
  });

  it("reads the record again before it decides which host a live endpoint keeps", async () => {
    const s = await setup({ cloud: false });
    const id = (await s.write(DANA, "POST", "/v1/app/org/model-sources", { source: endpoint() })).body.sourceId as string;
    // The item lists a stale host beside the live one, so the sweeper acts.
    await putEgressDomains(s.egressDeps(), TEST_ORG, { kind: "model-source", sourceId: id }, [HOST, "stale.example.org"], { developerId: DANA.developerId });
    const store = s.store();
    const read = store.readIfAny.bind(store);
    let reads = 0;
    store.readIfAny = async (org) => {
      reads += 1;
      if (reads === 2) {
        // A change commits another host and asks for it, between the sweeper's first read of the record and its second.
        await s.store().save({ orgId: TEST_ORG, source: { ...(await s.store().read(TEST_ORG)).sources[0]!, baseUrl: "https://other.example.org/v1" } as never, mode: "update", by: DANA.developerId });
        await putEgressDomains(s.egressDeps(), TEST_ORG, { kind: "model-source", sourceId: id }, ["other.example.org"], { developerId: DANA.developerId });
      }
      return read(org);
    };
    // What the sweeper itself writes to egress items (the change's own writes above go around it).
    let sweeperWrites = 0;
    const egress: EgressDomainsDependencies = {
      ...s.egressDeps(),
      documentClient: { send: async (command: unknown) => {
        if ((command as { constructor: { name: string } }).constructor.name === "TransactWriteCommand" && JSON.stringify((command as { input: unknown }).input).includes("EGRESS_DOMAINS")) sweeperWrites += 1;
        return s.db.send(command as never);
      } },
    };
    await sweepModelSources({ documentClient: s.db, tableName: "state", now: () => T0, store, access: s.access, egress }, { budgetMs: 5_000 });
    expect((await s.egressOf(id))!.domains.map((entry) => [entry.domain, entry.status])).toEqual([["other.example.org", "approved"]]);
    // It saw the live host in the fresh record and found the item already right: it wrote nothing, so it wiped nothing.
    expect(sweeperWrites).toBe(0);
  });

  it("deletes an org's record only at the revision it released, and releases what was added meanwhile", async () => {
    const s = await setup();
    const first = await s.add(DANA, anthropic());
    const added = "src_mmmmmmmmmmmmmmmmmmmm";
    let racing = true;
    s.access.removeSource.mockImplementation(async () => {
      if (!racing) return;
      racing = false;
      await s.store().save({ orgId: TEST_ORG, source: { sourceId: added, kind: "anthropic", label: "Late", models: [{ catalog: sonnet }] } as never, mode: "create", keyStored: true, by: DANA.developerId });
    });
    await releaseOrgModelSources({ store: s.store(), access: s.access, egress: s.egressDeps() }, TEST_ORG);
    expect(s.doc()).toBeUndefined();
    expect(s.access.removeSource.mock.calls.map(([, id]) => id).sort()).toEqual([first, first, added].sort());
    expect(s.db.get({ pk: "MODEL_SOURCES_ORGS", sk: TEST_ORG })).toBeUndefined();
  });

  it("bounds its list calls by its time budget, so the spend sweep keeps its time", async () => {
    const s = await setup({ cloud: false });
    s.access.listSources.mockImplementation(() => new Promise(() => undefined));
    const started = Date.now();
    const report = await sweepModelSources({ documentClient: s.db, tableName: "state", now: Date.now, store: s.store(), access: s.access, egress: s.egressDeps() }, { budgetMs: 40 });
    expect(Date.now() - started).toBeLessThan(2_000);
    expect(report).toMatchObject({ complete: false, failed: 0 });
  });

  it("is given 5 seconds in the settlement run, and a hung proxy list costs it no more", async () => {
    expect(MODEL_SOURCE_SWEEP_BUDGET_MS).toBe(5_000);
    vi.useFakeTimers();
    try {
      const s = await setup();
      s.access.listSources.mockImplementation(() => new Promise(() => undefined));
      const run = s.handler({ source: "agentx.spend-settlement" });
      await vi.advanceTimersByTimeAsync(MODEL_SOURCE_SWEEP_BUDGET_MS);
      const jobs = (JSON.parse((await run).body) as { jobs: Array<{ name: string; ok: boolean; result?: { complete: boolean } }> }).jobs;
      expect(jobs.map((job) => job.name)).toEqual(["drain-member-merges", "expire-approvals", "escalate-owner-requests", "sweep-model-sources", "sweep-spend", "audit-model-keys", "resume-learning-walks"]);
      expect(jobs.find((job) => job.name === "sweep-model-sources")).toMatchObject({ ok: true, result: { complete: false } });
    } finally {
      vi.useRealTimers();
    }
  });
});
