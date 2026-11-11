// Plan 4 Task 19: what the tests of event hooks stand on. A world of two orgs on one FakeDynamoDb with a fake clock, a fake `HookSecretStore` that counts its reads, a test provider
// that checks an HMAC-SHA256 (and one that checks a token) and a dispatcher that records what it was asked to start. Nothing here is Plan 4's code: the tests build deliveries the
// way a vendor would (signed over the exact bytes) and read what ingress answered and what it left behind.
import { createHmac, randomUUID } from "node:crypto";
import { agentXError, canonicalJson, HOOK_TENANT_SCHEMAS, hookKey, hookLookupKey, type HookRecord, type HookSource, type OrgId, type TriggerEvent } from "@rovara-code/contracts";
import { HookStore, type HookSecrets } from "../../packages/broker/src/triggers/hooks.js";
import { HookIngressMemory, receiveHook, type HookDelivery, type HookIngressDeps, type HookReply } from "../../packages/broker/src/triggers/ingress.js";
import { hmacHexEquals, tokenEquals, type HookProvider, type Normalized } from "../../packages/broker/src/triggers/providers/types.js";
import { START } from "./chain-run-world.js";
import { FakeDynamoDb } from "./fake-dynamodb.js";
import { ORG_A, ORG_B } from "./chain-gate-world.js";

export { ORG_A, ORG_B };

export const HOOK_1 = `hk_${"1".repeat(26)}`;
export const HOOK_2 = `hk_${"2".repeat(26)}`;
export const HOOK_OTHER_ORG = `hk_${"9".repeat(26)}`;
export const SECRET_1 = "secret-one-0123456789abcdef";
export const SECRET_2 = "secret-two-0123456789abcdef";
export const TEAM = "c408e946-78aa-4db8-923e-f78053dd954f";
export const LINEAR_TENANT = { organizationId: "11111111-1111-4111-8111-111111111111", teamId: TEAM };
export const OTHER_TENANT = { organizationId: "22222222-2222-4222-8222-222222222222", teamId: TEAM };

const EVENT_TYPE: Partial<Record<HookSource, string>> = { linear: "issue.created", jira: "issue.created", sentry: "issue.created", datadog: "monitor.triggered", pagerduty: "incident.triggered", grafana: "alert.firing" };

/** What a test body says. The test provider reads exactly these fields; whatever else a test adds is ignored by it, as a real provider ignores what it does not know. */
export interface TestBody {
  id?: string;
  occurredAt?: string;
  kind?: "event" | "ignore";
  tenant?: unknown;
  /** Several events in one delivery. */
  events?: Array<{ id: string; occurredAt?: string }>;
  /** Fields a hostile body might carry to move the event to another project or hook: ingress must overwrite them. */
  project?: string;
  hookId?: string;
  padding?: string;
}

export const SIGNATURE_HEADER = "x-test-signature";
export const TOKEN_HEADER = "x-rovara-hook-token";

/** A provider that checks `x-test-signature: <hex hmac-sha256 of the raw body>` and reads `TestBody`. */
export function hmacProvider(source: HookSource, secretOrigin: "rovara" | "vendor" = "vendor"): HookProvider {
  return { source, secretOrigin, auth: "hmac", verify: (raw, headers, secret) => hmacHexEquals("sha256", raw, secret, headers[SIGNATURE_HEADER] ?? ""), normalize: (body, _headers, hook) => normalizeTest(body, hook) };
}

/** A provider that checks `x-rovara-hook-token: <the secret>`. */
export function tokenProvider(source: HookSource): HookProvider {
  return { source, secretOrigin: "rovara", auth: "token", verify: (_raw, headers, secret) => tokenEquals(headers[TOKEN_HEADER] ?? "", secret), normalize: (body, _headers, hook) => normalizeTest(body, hook) };
}

function normalizeTest(body: unknown, hook: HookRecord): Normalized {
  const input = body as TestBody;
  if (input.kind === "ignore") return { ignored: "not an event we start work on" };
  if (input.tenant === undefined || canonicalJson(input.tenant) !== canonicalJson(hook.tenant)) return { tenantMismatch: true };
  const list = input.events ?? [{ id: input.id ?? "evt-1", ...(input.occurredAt === undefined ? {} : { occurredAt: input.occurredAt }) }];
  const events: TriggerEvent[] = list.map((entry) => ({
    source: hook.source, type: EVENT_TYPE[hook.source] ?? "issue.created", eventKey: `test:${entry.id}`, occurredAt: entry.occurredAt ?? input.occurredAt ?? new Date(START).toISOString(),
    // What a provider might derive from a hostile body: ingress sets the hook's own.
    project: input.project ?? "elsewhere", ...(input.hookId === undefined ? {} : { hookId: input.hookId }),
    subject: { kind: "issue", id: entry.id, title: `Event ${entry.id}` }, fields: {}, actor: { kind: "external" },
  }));
  return { events };
}

/** The fake `HookSecretStore`: the JSON of each hook's secret, a count of its reads and a note of what was scheduled for deletion. */
export class FakeHookSecrets implements HookSecrets {
  readonly values = new Map<string, string>();
  readonly deleted: string[] = [];
  reads = 0;
  puts = 0;
  failReads: Error | undefined;
  failPuts: Error | undefined;
  private key = (orgId: string, hookId: string) => `${orgId}|${hookId}`;
  async put(orgId: string, hookId: string, value: string): Promise<void> {
    if (this.failPuts !== undefined) throw this.failPuts;
    this.puts += 1;
    this.values.set(this.key(orgId, hookId), value);
  }
  async read(orgId: string, hookId: string): Promise<string> {
    this.reads += 1;
    if (this.failReads !== undefined) throw this.failReads;
    const value = this.values.get(this.key(orgId, hookId));
    if (value === undefined) throw agentXError("NOT_FOUND", "no secret is saved for that hook");
    return value;
  }
  async scheduleDelete(orgId: string, hookId: string): Promise<void> { this.deleted.push(this.key(orgId, hookId)); }
  /** What a hook's secret is now (the stored JSON, parsed). */
  stored(orgId: string, hookId: string): { current: string; previous?: string; previousValidUntil?: string } | undefined {
    const value = this.values.get(this.key(orgId, hookId));
    return value === undefined ? undefined : JSON.parse(value) as { current: string };
  }
}

export interface HookWorld {
  db: FakeDynamoDb;
  clock: { now: number };
  secrets: FakeHookSecrets;
  store: HookStore;
  memory: HookIngressMemory;
  deps: HookIngressDeps;
  dispatched: Array<{ orgId: OrgId; event: TriggerEvent }>;
  logs: Array<{ event: string; fields: Record<string, unknown> }>;
  /** Makes dispatch throw for the next calls. */
  dispatchFails: { error: Error | undefined };
  providers: Partial<Record<HookSource, HookProvider>>;
  /** Stores a hook of `orgId` (and its secret, unless `secret` is null) the way creating one does. */
  hook(over?: Partial<HookRecord> & { secret?: string | null; secretJson?: string }): Promise<HookRecord>;
  /** A delivery to `hook` signed (or tokened) with `secret`, as a vendor would send `body`. */
  delivery(hook: { source: string; hookId: string }, body: TestBody | string, options?: { secret?: string | null; ip?: string; headers?: Record<string, string | undefined>; raw?: Buffer }): HookDelivery;
  receive(delivery: HookDelivery): Promise<HookReply>;
  /** Every command sent since `mark`, by name. */
  commandsSince(mark: number): string[];
  writesSince(mark: number): string[];
}

const WRITES = new Set(["PutCommand", "UpdateCommand", "DeleteCommand", "TransactWriteCommand", "BatchWriteCommand"]);

/** The providers most tests use: Linear and Sentry (vendor secrets, HMAC), Jira (Rovara's secret, HMAC) and Datadog (Rovara's secret, a token). */
export const TEST_PROVIDERS = (): Partial<Record<HookSource, HookProvider>> => ({ linear: hmacProvider("linear"), jira: hmacProvider("jira", "rovara"), datadog: tokenProvider("datadog"), sentry: hmacProvider("sentry") });

export function setupHookWorld(providers: Partial<Record<HookSource, HookProvider>> = TEST_PROVIDERS(), shared: { db?: FakeDynamoDb; clock?: { now: number } } = {}): HookWorld {
  const db = shared.db ?? new FakeDynamoDb();
  const clock = shared.clock ?? { now: START };
  const secrets = new FakeHookSecrets();
  const store = new HookStore({ documentClient: db, tableName: "T", now: () => clock.now });
  const memory = new HookIngressMemory();
  const dispatched: HookWorld["dispatched"] = [];
  const logs: HookWorld["logs"] = [];
  const dispatchFails: HookWorld["dispatchFails"] = { error: undefined };
  const deps: HookIngressDeps = {
    documentClient: db, tableName: "T", now: () => clock.now, hooks: store, secrets, providers, memory,
    dispatch: async (orgId, event) => {
      if (dispatchFails.error !== undefined) throw dispatchFails.error;
      dispatched.push({ orgId, event });
      return [];
    },
    log: (event, fields) => { logs.push({ event, fields }); },
  };
  let counter = 0;
  const hook: HookWorld["hook"] = async (over = {}) => {
    counter += 1;
    const { secret, secretJson, ...record } = over;
    const source = record.source ?? "linear";
    const full = {
      orgId: ORG_A, hookId: HOOK_1, source, project: "web", tenant: source === "linear" ? LINEAR_TENANT : defaultTenant(source), auth: providers[source]?.auth ?? "hmac", hasSecret: true,
      status: "active", createdBy: "d".repeat(64), createdAt: new Date(START).toISOString(), ...record,
    } as unknown as HookRecord;
    expectTenant(full);
    if (!await store.create(full)) throw new Error(`hook ${full.hookId} already exists (${String(counter)})`);
    if (secret !== null) secrets.values.set(`${full.orgId}|${full.hookId}`, secretJson ?? JSON.stringify({ current: secret ?? SECRET_1 }));
    return full;
  };
  const delivery: HookWorld["delivery"] = (target, body, options = {}) => {
    const raw = options.raw ?? Buffer.from(typeof body === "string" ? body : JSON.stringify(body), "utf8");
    const secret = options.secret === undefined ? SECRET_1 : options.secret;
    const provider = providers[target.source as HookSource];
    const headers: Record<string, string | undefined> = {};
    if (secret !== null) {
      if (provider?.auth === "token") headers[TOKEN_HEADER] = secret;
      else headers[SIGNATURE_HEADER] = createHmac("sha256", secret).update(raw).digest("hex");
    }
    return { source: target.source, hookId: target.hookId, raw, headers: { ...headers, ...options.headers }, sourceIp: options.ip ?? "203.0.113.7" };
  };
  return {
    db, clock, secrets, store, memory, deps, dispatched, logs, dispatchFails, providers, hook, delivery, receive: (d) => receiveHook(deps, d),
    commandsSince: (mark) => db.commandNames().slice(mark), writesSince: (mark) => db.commandNames().slice(mark).filter((name) => WRITES.has(name)),
  };
}

function defaultTenant(source: HookSource): Record<string, unknown> {
  const tenants: Partial<Record<HookSource, Record<string, unknown>>> = {
    jira: { siteHost: "acme.atlassian.net" }, datadog: { datadogOrgId: "1234" }, sentry: { installationUuid: "33333333-3333-4333-8333-333333333333" }, pagerduty: { subdomain: "acme" }, grafana: { host: "grafana.acme.com" },
  };
  return tenants[source] ?? {};
}

function expectTenant(record: HookRecord): void {
  const parsed = HOOK_TENANT_SCHEMAS[record.source].safeParse(record.tenant);
  if (!parsed.success) throw new Error(`the test hook's tenant is not one of ${record.source}'s: ${parsed.error.message}`);
}

export const hookRecordKeys = { hookKey, hookLookupKey };
export const newRequestId = (): string => randomUUID();
export const iso = (ms: number): string => new Date(ms).toISOString();
