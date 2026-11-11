// Plan 4 Task 19: the event hooks of a project. A hook is the endpoint one vendor posts one project's events to (`POST /v1/hooks/{source}/{hookId}`, ingress.ts); this file is
// what a maintainer does with it (create, list, rotate, delete: all `edit_settings` on the project) and what stores it. The secret that signs its deliveries is kept by Plan 3's
// `HookSecretStore` (H9), in the org's own tagged secret, and appears nowhere else: not in the record, not in a request item, not in a log, and not in a later read.
import { createHash, randomBytes } from "node:crypto";
import { DeleteCommand, GetCommand, QueryCommand, TransactWriteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { HOOK_AUTHS, HOOK_ROTATION_OVERLAP_HOURS, HOOK_STATUSES, HOOK_TENANT_SCHEMAS, CreateHookBodySchema, HookIdSchema, HookSecretSchema, HookSourceSchema, OrgIdSchema, RotateHookBodySchema, agentXError, canonicalJson, hookDirectoryKey, hookKey, hookLookupKey, type HookRecord, type HookSecret, type HookSource, type OrgId, type OrgKey } from "@rovara-code/contracts";
import type { AgentCaller } from "../agents/access.js";
import { shownText } from "../agents/approvals.js";
import { jsonBody, parseBody, type AgentRouteDependencies } from "../agents/routes.js";
import { strip, type Item, type TableInput } from "../agents/table-writes.js";
import { StatusReply } from "../aws/status-reply.js";
import type { AdaptedHttpRequest } from "../aws/lambda.js";
import { displayNameOf } from "../chains/gates.js";
import type { TriggerHook, TriggerHookReader } from "./ports.js";
import type { HookProvider, HookSetup } from "./providers/types.js";
import { decodeSegment, requireSettingsOn } from "./routes.js";

type Deps = AgentRouteDependencies;

/** The most hooks one project may have: each one is a secret that is billed and a way in that is public. */
export const HOOKS_PER_PROJECT_MAX = 20;
const NAME_MAX = 80;
const HOUR = 3_600_000;

// ---- the store

const isStatus = (value: unknown): value is HookRecord["status"] => (HOOK_STATUSES as readonly unknown[]).includes(value);
const isAuth = (value: unknown): value is HookRecord["auth"] => (HOOK_AUTHS as readonly unknown[]).includes(value);

/** A stored item as the record it is, or undefined when it is not one this code wrote (a hook that can't be read is a hook that is not there). */
function recordOf(item: Item | undefined): HookRecord | undefined {
  if (item === undefined) return undefined;
  const source = HookSourceSchema.safeParse(item["source"]);
  const org = OrgIdSchema.safeParse(item["orgId"]);
  if (!source.success || !org.success || !HookIdSchema.safeParse(item["hookId"]).success) return undefined;
  const tenant = HOOK_TENANT_SCHEMAS[source.data].safeParse(item["tenant"]);
  if (!tenant.success || !isStatus(item["status"]) || !isAuth(item["auth"])) return undefined;
  if (typeof item["project"] !== "string" || typeof item["createdBy"] !== "string" || typeof item["createdAt"] !== "string" || typeof item["hasSecret"] !== "boolean") return undefined;
  return strip(item) as unknown as HookRecord;
}

export class HookStore implements TriggerHookReader {
  constructor(private readonly input: TableInput) {}

  private async read(key: OrgKey): Promise<Item | undefined> {
    return (await this.input.documentClient.send(new GetCommand({ TableName: this.input.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
  }

  /** The org a hook id belongs to, from the global lookup; undefined when there is none (no such hook, or it was deleted). */
  async orgOf(hookId: string): Promise<OrgId | undefined> {
    const parsed = OrgIdSchema.safeParse((await this.read(hookLookupKey(hookId)))?.["orgId"]);
    return parsed.success ? parsed.data : undefined;
  }

  /** The hook's record, read under `orgId`: a record of another org (or a mis-keyed one) is none. */
  async record(orgId: OrgId, hookId: string): Promise<HookRecord | undefined> {
    const record = recordOf(await this.read(hookKey(orgId, hookId)));
    return record === undefined || record.orgId !== orgId || record.hookId !== hookId ? undefined : record;
  }

  /** What a trigger's checks need of a hook. A hook that is off, unsubscribed or not there reads as off or none. */
  async get(orgId: OrgId, hookId: string): Promise<TriggerHook | undefined> {
    const record = await this.record(orgId, hookId);
    return record === undefined ? undefined : { orgId, hookId, project: record.project, source: record.source, disabled: record.status === "disabled" || record.status === "unsubscribed" };
  }

  async hookIds(orgId: OrgId): Promise<string[]> {
    const ids: string[] = [];
    let start: Record<string, unknown> | undefined;
    do {
      const page = await this.input.documentClient.send(new QueryCommand({
        TableName: this.input.tableName, KeyConditionExpression: "pk = :pk", ExpressionAttributeValues: { ":pk": hookDirectoryKey(orgId, "x").pk }, ConsistentRead: true,
        ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> };
      ids.push(...(page.Items ?? []).map((item) => String(item["sk"])));
      start = page.LastEvaluatedKey;
    } while (start !== undefined);
    return ids;
  }

  async list(orgId: OrgId, project?: string): Promise<HookRecord[]> {
    const records = await Promise.all((await this.hookIds(orgId)).map((id) => this.record(orgId, id)));
    return records.filter((record): record is HookRecord => record !== undefined && (project === undefined || record.project === project)).sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.hookId.localeCompare(b.hookId));
  }

  /** Stores a new hook, its lookup and its place in the org's list in one transaction. False when the id is taken (the caller reads who by). */
  async create(record: HookRecord): Promise<boolean> {
    const put = (key: OrgKey, entityType: string, fields: Item) => ({ Put: { TableName: this.input.tableName, Item: { ...key, entityType, ...fields }, ConditionExpression: "attribute_not_exists(pk)" } });
    try {
      await this.input.documentClient.send(new TransactWriteCommand({ TransactItems: [
        put(hookKey(record.orgId, record.hookId), "HOOK", record as unknown as Item),
        put(hookLookupKey(record.hookId), "HOOK_LOOKUP", { orgId: record.orgId }),
        put(hookDirectoryKey(record.orgId, record.hookId), "HOOK_DIRECTORY", { orgId: record.orgId, hookId: record.hookId }),
      ] }));
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "TransactionCanceledException") return false;
      throw error;
    }
  }

  private async send(command: UpdateCommand | DeleteCommand): Promise<boolean> {
    try {
      await this.input.documentClient.send(command);
      return true;
    } catch (error) {
      if (error instanceof Error && error.name === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }

  /** Turns the hook off and takes its lookup away, so nothing reaches it. Each step is repeatable: a hook already off, or without its lookup, is finished. */
  async disable(orgId: OrgId, hookId: string): Promise<void> {
    await this.send(new UpdateCommand({
      TableName: this.input.tableName, Key: hookKey(orgId, hookId), UpdateExpression: "SET #status = :off", ConditionExpression: "attribute_exists(pk) AND orgId = :org",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":off": "disabled", ":org": orgId },
    }));
    // The lookup goes only if it names this org: another org's hook is never touched through this id.
    await this.send(new DeleteCommand({ TableName: this.input.tableName, Key: hookLookupKey(hookId), ConditionExpression: "orgId = :org", ExpressionAttributeValues: { ":org": orgId } }));
  }

  /** Notes that a verified delivery arrived. Only a hook that is on is touched. */
  async touch(orgId: OrgId, hookId: string, at: string): Promise<void> {
    await this.send(new UpdateCommand({
      TableName: this.input.tableName, Key: hookKey(orgId, hookId), UpdateExpression: "SET lastDeliveryAt = :at", ConditionExpression: "attribute_exists(pk) AND (#status = :active OR #status = :pending)",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":at": at, ":active": "active", ":pending": "pending_confirmation" },
    }));
  }

  /** Makes a hook that waited for its SNS confirmation active, noting the subscription. False when it is not (or no longer) waiting: a lost race, or a hook turned off in between. */
  async confirmSubscription(orgId: OrgId, hookId: string, subscriptionArn: string): Promise<boolean> {
    return this.send(new UpdateCommand({
      TableName: this.input.tableName, Key: hookKey(orgId, hookId), UpdateExpression: "SET #status = :active, subscriptionArn = :arn",
      ConditionExpression: "attribute_exists(pk) AND orgId = :org AND #auth = :sns AND #status = :pending",
      ExpressionAttributeNames: { "#status": "status", "#auth": "auth" }, ExpressionAttributeValues: { ":active": "active", ":arn": subscriptionArn, ":org": orgId, ":sns": "sns", ":pending": "pending_confirmation" },
    }));
  }

  /** Stops an SNS hook that was told its subscription ended: later deliveries are refused. False when it was not on (active or waiting). */
  async markUnsubscribed(orgId: OrgId, hookId: string): Promise<boolean> {
    return this.send(new UpdateCommand({
      TableName: this.input.tableName, Key: hookKey(orgId, hookId), UpdateExpression: "SET #status = :off",
      ConditionExpression: "attribute_exists(pk) AND orgId = :org AND #auth = :sns AND (#status = :active OR #status = :pending)",
      ExpressionAttributeNames: { "#status": "status", "#auth": "auth" }, ExpressionAttributeValues: { ":off": "unsubscribed", ":org": orgId, ":sns": "sns", ":active": "active", ":pending": "pending_confirmation" },
    }));
  }

  /** Notes which request rotated the secret and when, while the hook is on. */
  async noteRotation(orgId: OrgId, hookId: string, requestId: string, at: string): Promise<void> {
    await this.send(new UpdateCommand({
      TableName: this.input.tableName, Key: hookKey(orgId, hookId), UpdateExpression: "SET rotationRequestId = :request, rotatedAt = :at", ConditionExpression: "attribute_exists(pk) AND #status = :active",
      ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":request": requestId, ":at": at, ":active": "active" },
    }));
  }
}

/** Whether an AWS account is one the org connected, read now. */
export interface ConnectedAwsAccounts {
  isConnected(orgId: OrgId, awsAccountId: string): Promise<boolean>;
}

/**
 * An AWS connection of the org was removed: each CloudWatch hook of the org for that account is turned off and loses its lookup (as `clearOrgHooks` does for a closed org), unless
 * the org still has another connection to the account (read now). Repeatable. Answers how many hooks it turned off.
 */
export async function disableHooksOfAccount(input: { store: HookStore; awsAccounts: ConnectedAwsAccounts }, orgId: OrgId, awsAccountId: string): Promise<number> {
  if (await input.awsAccounts.isConnected(orgId, awsAccountId)) return 0;
  let turnedOff = 0;
  for (const hook of await input.store.list(orgId)) {
    if (hook.source !== "cloudwatch" || hook.status === "disabled" || (hook.tenant as { awsAccountId?: unknown }).awsAccountId !== awsAccountId) continue;
    await input.store.disable(orgId, hook.hookId);
    turnedOff += 1;
  }
  return turnedOff;
}

/** The secrets of hooks, as ingress and the routes use them (Plan 3's `HookSecretStore`). */
export interface HookSecrets {
  put(orgId: string, hookId: string, value: string): Promise<void>;
  read(orgId: string, hookId: string): Promise<string>;
  scheduleDelete(orgId: string, hookId: string): Promise<void>;
}

/**
 * What closing an org does to its hooks: each is turned off and loses its lookup, so nothing reaches it, and its secret is scheduled for deletion. Repeatable: a hook already
 * off, a lookup already gone and a secret already scheduled are each finished, so a close that stopped part-way is run again.
 */
export async function clearOrgHooks(input: { store: HookStore; secrets: Pick<HookSecrets, "scheduleDelete"> }, orgId: OrgId): Promise<void> {
  for (const hookId of await input.store.hookIds(orgId)) {
    await input.store.disable(orgId, hookId);
    await input.secrets.scheduleDelete(orgId, hookId);
  }
}

// ---- the routes

/** What the hook routes need beyond the agent routes' own dependencies. Absent where hooks are not set up, and then the routes answer 404. */
export interface EventHookDependencies {
  store: HookStore;
  secrets: HookSecrets;
  /** The providers of each source: they say who makes a source's secret, and a source with none can't have a hook yet. */
  providers: Partial<Record<HookSource, HookProvider>>;
  /** The address vendors post to: `<origin>/v1/hooks/<source>/<hookId>`. */
  origin: string;
  /** What the broker knows of the AWS accounts an org connected (its CloudWatch connections): a CloudWatch hook may name only one of them. Absent where that is not known, and then no such hook is made or confirmed. */
  awsAccounts?: ConnectedAwsAccounts;
  /** Forgets what this container remembers of a hook's secret, so a rotation is believed here at once. */
  secretRotated?(hookId: string): void;
}

export const EVENT_HOOKS_PATH = /^\/v1\/app\/projects\/([^/]+)\/event-hooks(?:\/([^/]+)(?:\/(rotate))?)?$/;

const randomSecret = (): string => randomBytes(32).toString("base64url");

/** A hook id from 17 bytes: `hk_` and 26 characters of base 36, as `HookIdSchema` says. */
function hookIdFrom(bytes: Uint8Array): string {
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  return `hk_${(value % 36n ** 26n).toString(36).padStart(26, "0")}`;
}

/** The id one request makes: the same request names the same hook, so a repeat of it finds the hook it made and writes nothing (R18). */
const hookIdOf = (orgId: OrgId, developerId: string, requestId: string): string => hookIdFrom(createHash("sha256").update(`hook|${orgId}|${developerId}|${requestId}`, "utf8").digest().subarray(0, 17));

const urlOf = (hooks: EventHookDependencies, record: Pick<HookRecord, "source" | "hookId">): string => `${hooks.origin}/v1/hooks/${record.source}/${record.hookId}`;

async function viewOf(deps: Deps, hooks: EventHookDependencies, record: HookRecord): Promise<Record<string, unknown>> {
  return {
    hookId: record.hookId, source: record.source, project: record.project, tenant: record.tenant, auth: record.auth, hasSecret: record.hasSecret, status: record.status,
    url: urlOf(hooks, record), createdBy: { developerId: record.createdBy, name: await displayNameOf(deps, record.createdBy) }, createdAt: record.createdAt,
    ...(record.lastDeliveryAt === undefined ? {} : { lastDeliveryAt: record.lastDeliveryAt }), ...(record.rotatedAt === undefined ? {} : { rotatedAt: record.rotatedAt }),
  };
}

function hooksOf(deps: Deps): EventHookDependencies {
  if (deps.eventHooks === undefined) throw agentXError("NOT_FOUND", "event hooks are not set up in this deployment");
  return deps.eventHooks;
}

function providerOf(hooks: EventHookDependencies, source: HookSource): HookProvider {
  const provider = hooks.providers[source];
  if (provider === undefined) throw agentXError("RUNTIME_UNAVAILABLE", `${source} events are not available yet`);
  return provider;
}

/** What a person does at the vendor for this hook: the provider's own steps for it, else its general ones. */
const setupOf = (provider: HookProvider, record: HookRecord): HookSetup | undefined => provider.setupFor?.(record) ?? provider.setup;

/** A hook of a source that has no secret (SNS) takes none: a secret sent with the request is refused rather than ignored. */
function refuseSecret(given: string | undefined): void {
  if (given !== undefined) throw agentXError("CONFIG_INVALID", "secret: this source has no secret; leave it out");
}

/** A CloudWatch hook names an AWS account, and it must be one the org connected: otherwise anyone could point a hook at another company's topic. */
async function requireConnectedAccount(hooks: EventHookDependencies, orgId: OrgId, awsAccountId: string): Promise<void> {
  if (hooks.awsAccounts === undefined) throw agentXError("RUNTIME_UNAVAILABLE", "CloudWatch events are not available in this deployment");
  if (!await hooks.awsAccounts.isConnected(orgId, awsAccountId)) throw agentXError("CONFIG_INVALID", "tenant: connect that AWS account as a CloudWatch connection first, then make the hook");
}

/** The secret a request names: Rovara makes it for a source that says so (and refuses one that is given), and a vendor's is required. */
function secretOf(provider: HookProvider, given: string | undefined): string {
  if (provider.secretOrigin === "rovara") {
    if (given !== undefined) throw agentXError("CONFIG_INVALID", "secret: Rovara makes the secret for this source; leave it out");
    return randomSecret();
  }
  if (given === undefined) throw agentXError("CONFIG_INVALID", "secret: paste the signing secret this source gives you");
  return given;
}

async function createHook(deps: Deps, caller: AgentCaller, project: string, body: unknown): Promise<StatusReply> {
  const input = parseBody(CreateHookBodySchema, body);
  const hooks = hooksOf(deps);
  await requireSettingsOn(deps, caller, project);
  const provider = providerOf(hooks, input.source);
  const tenant = HOOK_TENANT_SCHEMAS[input.source].safeParse(input.tenant);
  if (!tenant.success) {
    const first = tenant.error.issues[0];
    throw agentXError("CONFIG_INVALID", `tenant: ${`${first?.path.join(".") ?? ""} ${first?.message ?? "is not valid"}`.replace(/\s+/gu, " ").trim()}`);
  }
  const hookId = hookIdOf(caller.orgId, caller.developerId, input.requestId);
  // A repeat of the request finds the hook it made. The secret was shown once and is kept nowhere to be shown again, so the answer says to rotate for another.
  const earlier = await hooks.store.record(caller.orgId, hookId);
  if (earlier !== undefined) {
    if (earlier.project !== project || earlier.source !== input.source || canonicalJson(earlier.tenant) !== canonicalJson(tenant.data)) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
    return new StatusReply(200, { hook: await viewOf(deps, hooks, earlier), url: urlOf(hooks, earlier), ...(setupOf(provider, earlier) === undefined ? {} : { setup: setupOf(provider, earlier) }), replayed: true });
  }
  if (input.source === "cloudwatch") await requireConnectedAccount(hooks, caller.orgId, (tenant.data as { awsAccountId: string }).awsAccountId);
  if ((await hooks.store.list(caller.orgId, project)).filter((hook) => hook.status !== "disabled").length >= HOOKS_PER_PROJECT_MAX) {
    throw agentXError("CONFIG_INVALID", `${shownText(project, NAME_MAX)} already has the most hooks it can have (${String(HOOKS_PER_PROJECT_MAX)}). Delete one first.`);
  }
  const hasSecret = provider.secretOrigin !== "none";
  if (!hasSecret) refuseSecret(input.secret);
  const secret = hasSecret ? secretOf(provider, input.secret) : undefined;
  // An SNS hook waits for its subscription's confirmation, which only a signed message for its own topic can give.
  const record: HookRecord = {
    orgId: caller.orgId, hookId, source: input.source, project, tenant: tenant.data, auth: provider.auth, hasSecret, status: provider.auth === "sns" ? "pending_confirmation" : "active",
    createdBy: caller.developerId, createdAt: new Date(deps.now()).toISOString(),
  };
  // The secret first: a hook that is stored always has one (when its source has any), and a secret with no hook is deleted again below.
  if (secret !== undefined) await hooks.secrets.put(caller.orgId, hookId, JSON.stringify({ current: secret } satisfies HookSecret));
  let stored: boolean;
  try {
    stored = await hooks.store.create(record);
  } catch (error) {
    if (secret !== undefined) await hooks.secrets.scheduleDelete(caller.orgId, hookId).catch(() => undefined);
    throw error;
  }
  if (!stored) throw agentXError("CONFIG_INVALID", "requestId: this request ID was already used for a different request");
  const setup = setupOf(provider, record);
  return new StatusReply(201, { hook: await viewOf(deps, hooks, record), url: urlOf(hooks, record), ...(setup === undefined ? {} : { setup }), ...(provider.secretOrigin === "rovara" ? { secret } : {}) });
}

async function listHooks(deps: Deps, caller: AgentCaller, project: string): Promise<Record<string, unknown>> {
  const hooks = hooksOf(deps);
  await requireSettingsOn(deps, caller, project);
  return { hooks: await Promise.all((await hooks.store.list(caller.orgId, project)).map((record) => viewOf(deps, hooks, record))) };
}

/** The hook of this project and org, or the one 404 for anything else. */
async function requireHook(deps: Deps, hooks: EventHookDependencies, caller: AgentCaller, project: string, rawId: string): Promise<HookRecord> {
  const id = HookIdSchema.safeParse(rawId);
  const record = id.success ? await hooks.store.record(caller.orgId, id.data) : undefined;
  if (record === undefined || record.project !== project) throw agentXError("NOT_FOUND", "no hook has that ID");
  return record;
}

async function deleteHook(deps: Deps, caller: AgentCaller, project: string, rawId: string, body: unknown): Promise<Record<string, unknown>> {
  parseBody(RotateHookBodySchema.pick({ requestId: true }).strict(), body);
  const hooks = hooksOf(deps);
  await requireSettingsOn(deps, caller, project);
  const record = await requireHook(deps, hooks, caller, project, rawId);
  // Off first, so nothing reaches it; the secret's removal is repeated by deleting again if it failed.
  await hooks.store.disable(caller.orgId, record.hookId);
  await hooks.secrets.scheduleDelete(caller.orgId, record.hookId);
  return { deleted: true };
}

async function rotateHook(deps: Deps, caller: AgentCaller, project: string, rawId: string, body: unknown): Promise<StatusReply> {
  const input = parseBody(RotateHookBodySchema, body);
  const hooks = hooksOf(deps);
  await requireSettingsOn(deps, caller, project);
  const record = await requireHook(deps, hooks, caller, project, rawId);
  if (record.status !== "active" || !record.hasSecret) throw agentXError("CONFIG_INVALID", "that hook has no secret to rotate");
  // A repeat of a rotation that was made changes nothing: the new secret was shown once.
  if (record.rotationRequestId === input.requestId) return new StatusReply(200, { hook: await viewOf(deps, hooks, record), url: urlOf(hooks, record), replayed: true });
  const provider = providerOf(hooks, record.source);
  const secret = secretOf(provider, input.secret);
  // The secret that is current becomes the previous one for the overlap, in the same secret: the vendor's setting can be changed without dropped events.
  let earlier: HookSecret | undefined;
  try {
    const parsed = HookSecretSchema.safeParse(JSON.parse(await hooks.secrets.read(caller.orgId, record.hookId)));
    earlier = parsed.success ? parsed.data : undefined;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code !== "NOT_FOUND" && !(error instanceof SyntaxError)) throw error;
  }
  const next: HookSecret = { current: secret, ...(earlier === undefined ? {} : { previous: earlier.current, previousValidUntil: new Date(deps.now() + HOOK_ROTATION_OVERLAP_HOURS * HOUR).toISOString() }) };
  await hooks.secrets.put(caller.orgId, record.hookId, JSON.stringify(next));
  // This container believes the new secret at once; the others within a minute (the ingress cache's lifetime). Deleting the hook is the instant revoke: its record is read on every delivery.
  hooks.secretRotated?.(record.hookId);
  await hooks.store.noteRotation(caller.orgId, record.hookId, input.requestId, new Date(deps.now()).toISOString());
  const rotated = await hooks.store.record(caller.orgId, record.hookId) ?? record;
  return new StatusReply(200, { hook: await viewOf(deps, hooks, rotated), url: urlOf(hooks, rotated), ...(provider.secretOrigin === "rovara" ? { secret } : {}) });
}

/** `/v1/app/projects/{p}/event-hooks*`, or undefined for any other path. */
export async function routeEventHooks(deps: Deps, caller: AgentCaller, request: AdaptedHttpRequest, url: URL): Promise<unknown> {
  const matched = EVENT_HOOKS_PATH.exec(url.pathname);
  if (matched === null) return undefined;
  const project = decodeSegment(matched[1]!, "project");
  const [, , rawHook, rotate] = matched;
  if (rawHook === undefined) {
    if (request.method === "POST") return createHook(deps, caller, project, jsonBody(request));
    if (request.method === "GET") return listHooks(deps, caller, project);
  } else if (rotate !== undefined) {
    if (request.method === "POST") return rotateHook(deps, caller, project, rawHook, jsonBody(request));
  } else if (request.method === "DELETE") {
    return deleteHook(deps, caller, project, rawHook, jsonBody(request));
  }
  throw agentXError("NOT_FOUND", "route not found");
}

