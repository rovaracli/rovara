// Plan 4 Task 19: the public endpoint a vendor posts events to, `POST /v1/hooks/{source}/{hookId}`. Nothing here trusts the sender until its signature or token has verified over
// the bytes that arrived, and nothing is WRITTEN until then: a forged request makes no DynamoDB write, no Secrets Manager write and no log line that carries what it said. In order:
//   1. size (413); 2. a per-address limit in memory (429); 3. the hook, read by its id: unknown, off or of another source is the one 403; 4. the failure gate and 5. the secret
//   (read through `HookSecretStore`, cached, re-read only as rarely as the plan says); 6. the provider's verification against the current secret, then the previous one while it
//   is still valid; 7. the per-hook rate, counted only for a verified delivery; 8. JSON, the provider's events and the tenant check; 9. the age window (24 hours back, a few
//   minutes forward: a body dated ahead could outlive its de-duplication item and be replayed); 10. de-duplication by a conditional put; 11. dispatch.
// A delivery that is refused answers one body whatever the reason, so the answer says nothing about which hooks exist. Secrets, bodies and header values never reach a log.
import { GetCommand, PutCommand, DeleteCommand, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import {
  EVENT_DEDUPE_TTL_HOURS,
  EVENT_MAX_AGE_HOURS,
  EVENT_MAX_FUTURE_MINUTES,
  HOOK_BODY_MAX_BYTES,
  HOOK_FAILED_VERIFY_PER_MINUTE,
  HOOK_MAX_DELIVERIES_PER_MINUTE,
  HOOK_MAX_EVENTS_PER_DELIVERY,
  HOOK_PRE_VERIFY_PER_IP_PER_MINUTE,
  HOOK_SECRET_REREAD_MIN_AGE_SECONDS,
  HookIdSchema,
  HookSecretSchema,
  HookSourceSchema,
  INDEX_EXPIRY_ATTRIBUTE,
  TriggerEventSchema,
  hookEventKey,
  hookRateKey,
  type HookRecord,
  type HookSecret,
  type HookSource,
  type OrgId,
  type TriggerEvent,
} from "@agentx/contracts";
import type { HookStore } from "./hooks.js";
import type { HookProvider, HookHeaders } from "./providers/types.js";

export interface HookReply {
  status: 200 | 202 | 403 | 413 | 429 | 503;
  body: Record<string, unknown>;
}

const FORBIDDEN_BODY = { error: { code: "FORBIDDEN", message: "signature check failed" } } as const;
const forbidden = (): HookReply => ({ status: 403, body: { error: { ...FORBIDDEN_BODY.error } } });

const SECOND = 1000;
const MINUTE = 60_000;
const HOUR = 3_600_000;
/** How long a container believes the secret it read. A rotation or a delete made in another container takes effect here within this time; deleting the hook is the instant revoke (the hook record is read on every request). */
const SECRET_CACHE_MS = MINUTE;
/** How long an unknown hook id is remembered, so a flood at made-up ids costs one read each minute. */
const UNKNOWN_HOOK_MS = MINUTE;
/** An event recorded as received and not yet marked dispatched is taken over by a retry only when it is older than this: before that, its first delivery may still be starting it. */
export const EVENT_PENDING_TAKEOVER_MS = 120 * SECOND;
const REREAD_MIN_AGE_MS = HOOK_SECRET_REREAD_MIN_AGE_SECONDS * SECOND;
/** The most keys each in-memory table keeps; the oldest goes first. A flood of made-up addresses or hook ids can't grow the container's memory without bound. */
const MEMORY_KEYS_MAX = 10_000;
const ADDRESS_MAX_CHARS = 64;

/** A count of what happened to each key in the last minute, in one-second buckets so that no key holds more than sixty entries however busy it is. */
export class WindowCounter {
  private readonly keys = new Map<string, { buckets: Array<[second: number, count: number]>; total: number }>();

  constructor(private readonly maxKeys: number = MEMORY_KEYS_MAX) {}

  private live(key: string, now: number): { buckets: Array<[number, number]>; total: number } | undefined {
    const entry = this.keys.get(key);
    if (entry === undefined) return undefined;
    const cutoff = Math.floor(now / SECOND) - 60;
    while (entry.buckets.length > 0 && entry.buckets[0]![0] <= cutoff) entry.total -= entry.buckets.shift()![1];
    if (entry.total <= 0) {
      this.keys.delete(key);
      return undefined;
    }
    return entry;
  }

  /** Counts one more for `key` and answers how many there were in the last minute, this one included. */
  hit(key: string, now: number): number {
    let entry = this.live(key, now);
    if (entry === undefined) {
      if (this.keys.size >= this.maxKeys) this.keys.delete(this.keys.keys().next().value as string);
      entry = { buckets: [], total: 0 };
      this.keys.set(key, entry);
    }
    const second = Math.floor(now / SECOND);
    const last = entry.buckets.at(-1);
    if (last !== undefined && last[0] === second) last[1] += 1;
    else entry.buckets.push([second, 1]);
    entry.total += 1;
    return entry.total;
  }

  /** How many there were for `key` in the last minute. */
  count(key: string, now: number): number {
    return this.live(key, now)?.total ?? 0;
  }
}

interface CachedSecret { set: HookSecret; readAt: number }

/** Everything the endpoint remembers between requests, per broker container: addresses seen, failed verifications, and each hook's secret. */
export class HookIngressMemory {
  readonly addresses = new WindowCounter();
  readonly failures = new WindowCounter();
  private readonly secrets = new Map<string, CachedSecret>();
  private readonly attempts = new Map<string, number>();
  private readonly unknown = new Map<string, number>();

  /** Whether `hookId` was found unknown less than a minute ago. */
  isUnknown(hookId: string, now: number): boolean {
    const until = this.unknown.get(hookId);
    if (until === undefined) return false;
    if (until <= now) {
      this.unknown.delete(hookId);
      return false;
    }
    return true;
  }

  noteUnknown(hookId: string, now: number): void {
    this.unknown.delete(hookId);
    if (this.unknown.size >= MEMORY_KEYS_MAX) this.unknown.delete(this.unknown.keys().next().value as string);
    this.unknown.set(hookId, now + UNKNOWN_HOOK_MS);
  }

  cached(hookId: string): CachedSecret | undefined {
    return this.secrets.get(hookId);
  }

  remember(hookId: string, entry: CachedSecret | undefined): void {
    if (entry === undefined) {
      this.secrets.delete(hookId);
      return;
    }
    if (!this.secrets.has(hookId) && this.secrets.size >= MEMORY_KEYS_MAX) this.secrets.delete(this.secrets.keys().next().value as string);
    this.secrets.set(hookId, entry);
  }

  lastRead(hookId: string): number | undefined {
    return this.attempts.get(hookId);
  }

  noteRead(hookId: string, at: number): void {
    if (!this.attempts.has(hookId) && this.attempts.size >= MEMORY_KEYS_MAX) this.attempts.delete(this.attempts.keys().next().value as string);
    this.attempts.set(hookId, at);
  }
}

export interface HookIngressDeps {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  now: () => number;
  hooks: Pick<HookStore, "orgOf" | "record" | "touch">;
  /** Plan 3's `HookSecretStore.read`: the stored JSON, or a `NOT_FOUND` error when there is none. */
  secrets: { read(orgId: string, hookId: string): Promise<string> };
  /** The provider of each source (Tasks 22 to 25); a source with none answers the uniform 403. */
  providers: Partial<Record<HookSource, HookProvider>>;
  /** Task 20's `dispatchTriggerEvent`, over the broker's dependencies. */
  dispatch(orgId: OrgId, event: TriggerEvent): Promise<unknown>;
  memory: HookIngressMemory;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface HookDelivery {
  source: string;
  hookId: string;
  raw: Buffer;
  headers: HookHeaders;
  sourceIp: string | undefined;
}

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

function logOf(deps: HookIngressDeps): (event: string, fields: Record<string, unknown>) => void {
  return deps.log ?? ((event, fields) => console.log(JSON.stringify({ component: "broker", event, ...fields })));
}

/** Whether `set` proves the delivery: the current secret, then the previous one while it is still valid. Both are always tried, so a refusal takes the same work either way. */
function verified(provider: HookProvider, delivery: HookDelivery, set: HookSecret, now: number): boolean {
  const attempt = (secret: string): boolean => {
    try {
      return provider.verify(delivery.raw, delivery.headers, secret);
    } catch {
      return false;
    }
  };
  let ok = attempt(set.current);
  if (set.previous !== undefined && set.previousValidUntil !== undefined && now < Date.parse(set.previousValidUntil)) ok = attempt(set.previous) || ok;
  return ok;
}

/** Reads the hook's secret now and remembers it. Undefined when there is none or it is not the shape this code wrote (a hook nobody can verify against). */
async function readSecret(deps: HookIngressDeps, orgId: OrgId, hookId: string, now: number): Promise<CachedSecret | undefined> {
  deps.memory.noteRead(hookId, now);
  let text: string;
  try {
    text = await deps.secrets.read(orgId, hookId);
  } catch (error) {
    if (errorCode(error) !== "NOT_FOUND") throw error;
    deps.memory.remember(hookId, undefined);
    return undefined;
  }
  let parsed: ReturnType<typeof HookSecretSchema.safeParse>;
  try {
    parsed = HookSecretSchema.safeParse(JSON.parse(text));
  } catch {
    parsed = HookSecretSchema.safeParse(undefined);
  }
  if (!parsed.success) {
    logOf(deps)("hook.secret_unreadable", { hookId });
    deps.memory.remember(hookId, undefined);
    return undefined;
  }
  const entry = { set: parsed.data, readAt: now };
  deps.memory.remember(hookId, entry);
  return entry;
}

/**
 * The secret to verify against. A copy younger than a minute is used as it is. An older one, or none, is read again, except while the failure gate is tripped: then at most
 * one read a minute is made per hook, and an older copy is still used when the read is not allowed (so a signed delivery is still checked, with no AWS call).
 */
async function secretFor(deps: HookIngressDeps, orgId: OrgId, hookId: string, now: number, tripped: boolean): Promise<CachedSecret | undefined> {
  const cached = deps.memory.cached(hookId);
  if (cached !== undefined && now - cached.readAt < SECRET_CACHE_MS) return cached;
  const last = deps.memory.lastRead(hookId);
  if (tripped && last !== undefined && now - last < MINUTE) return cached;
  return readSecret(deps, orgId, hookId, now);
}

const minuteOf = (now: number): string => new Date(now).toISOString().slice(0, 16);

/** Counts one verified delivery against the hook's allowance for this minute; false when the minute's allowance is used up. */
async function withinRate(deps: HookIngressDeps, orgId: OrgId, hookId: string, now: number): Promise<boolean> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName,
      Key: hookRateKey(orgId, hookId, minuteOf(now)),
      UpdateExpression: "ADD #count :one SET #expires = :expires",
      ConditionExpression: "attribute_not_exists(#count) OR #count < :max",
      ExpressionAttributeNames: { "#count": "count", "#expires": INDEX_EXPIRY_ATTRIBUTE },
      ExpressionAttributeValues: { ":one": 1, ":max": HOOK_MAX_DELIVERIES_PER_MINUTE, ":expires": Math.floor(now / SECOND) + 600 },
    }));
    return true;
  } catch (error) {
    if (errorName(error) === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/**
 * Writes the item that says this event was received, `pending` until its dispatch is recorded; false when it was already there (a replay). A pending item older than
 * `EVENT_PENDING_TAKEOVER_MS` is the trace of a delivery that died between the two: one retry takes it over (a conditional update on the time it read) and starts the event again,
 * which is safe because dispatch is idempotent by event id. An item with no status was written before it existed and counts as dispatched.
 */
async function firstSight(deps: HookIngressDeps, orgId: OrgId, hookId: string, eventKey: string, now: number): Promise<boolean> {
  const key = hookEventKey(orgId, hookId, eventKey);
  const at = new Date(now).toISOString();
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      await deps.documentClient.send(new PutCommand({
        TableName: deps.tableName,
        Item: { ...key, entityType: "HOOK_EVENT", orgId, hookId, status: "pending", at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(now / SECOND) + EVENT_DEDUPE_TTL_HOURS * 3600 },
        ConditionExpression: "attribute_not_exists(pk)",
      }));
      return true;
    } catch (error) {
      if (errorName(error) !== "ConditionalCheckFailedException") throw error;
    }
    const found = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: { status?: unknown; at?: unknown } }).Item;
    // Gone between the two calls (forgotten): write it again.
    if (found === undefined) continue;
    if (found.status !== "pending" || typeof found.at !== "string" || now - Date.parse(found.at) <= EVENT_PENDING_TAKEOVER_MS) return false;
    try {
      await deps.documentClient.send(new UpdateCommand({
        TableName: deps.tableName, Key: key, UpdateExpression: "SET #at = :now",
        ConditionExpression: "#status = :pending AND #at = :seen", ExpressionAttributeNames: { "#at": "at", "#status": "status" }, ExpressionAttributeValues: { ":now": at, ":pending": "pending", ":seen": found.at },
      }));
      return true;
    } catch (error) {
      if (errorName(error) === "ConditionalCheckFailedException") return false;
      throw error;
    }
  }
  return false;
}

/** Marks an event as started, so its replay is a duplicate for good. Best effort: an item left pending is started once more by a retry after the window, which dispatch tolerates. */
async function markDispatched(deps: HookIngressDeps, orgId: OrgId, hookId: string, event: TriggerEvent): Promise<void> {
  try {
    await deps.documentClient.send(new UpdateCommand({
      TableName: deps.tableName, Key: hookEventKey(orgId, hookId, event.eventKey), UpdateExpression: "SET #status = :dispatched",
      ConditionExpression: "attribute_exists(pk)", ExpressionAttributeNames: { "#status": "status" }, ExpressionAttributeValues: { ":dispatched": "dispatched" },
    }));
  } catch (error) {
    logOf(deps)("hook.dedupe_not_marked", { hookId, error: errorName(error) });
  }
}

/** Forgets the events that were recorded as received but not started, so the vendor's retry starts them. Best effort: what cannot be forgotten is logged. */
async function forget(deps: HookIngressDeps, orgId: OrgId, hookId: string, events: readonly TriggerEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: hookEventKey(orgId, hookId, event.eventKey) }));
    } catch (error) {
      logOf(deps)("hook.dedupe_not_released", { hookId, error: errorName(error) });
    }
  }
}

function usableHook(hook: HookRecord | undefined, source: HookSource, hookId: string): hook is HookRecord {
  return hook !== undefined && hook.hookId === hookId && hook.source === source && hook.status === "active";
}

async function receive(deps: HookIngressDeps, delivery: HookDelivery): Promise<HookReply> {
  const now = deps.now();
  const log = logOf(deps);
  // 1. A body over the limit is refused before anything else is read or counted.
  if (delivery.raw.length > HOOK_BODY_MAX_BYTES) return { status: 413, body: { error: { code: "TOO_LARGE", message: "the delivery is too large" } } };
  // 2. The address, in memory: no AWS call. Every request counts, whatever it turns out to be.
  const address = (delivery.sourceIp ?? "unknown").slice(0, ADDRESS_MAX_CHARS);
  if (deps.memory.addresses.hit(address, now) > HOOK_PRE_VERIFY_PER_IP_PER_MINUTE) return { status: 429, body: { error: { code: "RATE_LIMITED", message: "too many requests" } } };
  // 3. The hook: its id and source are well formed, it names an org, and its record is of that org and source and is on. Any miss is the one answer.
  const source = HookSourceSchema.safeParse(delivery.source);
  const hookId = HookIdSchema.safeParse(delivery.hookId);
  if (!source.success || !hookId.success) return forbidden();
  // An id found unknown in the last minute is not looked up again: a flood at made-up ids costs one read each minute.
  if (deps.memory.isUnknown(hookId.data, now)) return forbidden();
  const orgId = await deps.hooks.orgOf(hookId.data);
  if (orgId === undefined) {
    deps.memory.noteUnknown(hookId.data, now);
    return forbidden();
  }
  const hook = await deps.hooks.record(orgId, hookId.data);
  if (!usableHook(hook, source.data, hookId.data)) return forbidden();
  const provider = deps.providers[source.data];
  // A hook whose provider is missing or checks another way can't be verified, so it is never believed. (An SNS hook is verified by Task 25's own check, which is not here yet.)
  if (provider === undefined || provider.auth !== hook.auth) return forbidden();
  // 4 to 6. The gate, the secret and the check. Forged traffic costs nothing past the reads above: the gate only stops secret re-reads, and every request is still checked.
  const tripped = deps.memory.failures.count(hook.hookId, now) >= HOOK_FAILED_VERIFY_PER_MINUTE;
  let entry: CachedSecret | undefined;
  try {
    entry = await secretFor(deps, orgId, hook.hookId, now, tripped);
  } catch (error) {
    deps.memory.failures.hit(hook.hookId, now);
    throw error;
  }
  let ok = entry !== undefined && verified(provider, delivery, entry.set, now);
  if (!ok) {
    deps.memory.failures.hit(hook.hookId, now);
    // A rotation is noticed by one re-read, and only from a copy old enough, and never while the gate is tripped.
    if (!tripped && entry !== undefined && now - entry.readAt >= REREAD_MIN_AGE_MS) {
      const again = await readSecret(deps, orgId, hook.hookId, now);
      ok = again !== undefined && verified(provider, delivery, again.set, now);
    }
  }
  if (!ok) return forbidden();
  // 7. Verified: only now is anything written. The allowance is the hook's, and only a signed request can use it.
  if (!await withinRate(deps, orgId, hook.hookId, now)) {
    log("hook.rate_limited", { hookId: hook.hookId });
    return { status: 429, body: { error: { code: "RATE_LIMITED", message: "too many deliveries" } } };
  }
  // 8. The body as the provider reads it.
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(delivery.raw));
  } catch {
    return forbidden();
  }
  let normalized: ReturnType<HookProvider["normalize"]>;
  try {
    normalized = provider.normalize(body, delivery.headers, hook);
  } catch (error) {
    log("hook.normalize_failed", { hookId: hook.hookId, error: errorName(error) });
    return forbidden();
  }
  if ("tenantMismatch" in normalized) {
    log("hook.tenant_mismatch", { hookId: hook.hookId });
    return forbidden();
  }
  if ("ignored" in normalized) return { status: 202, body: { delivery: "IGNORED" } };
  if (normalized.events.length > HOOK_MAX_EVENTS_PER_DELIVERY) log("hook.too_many_events", { hookId: hook.hookId, events: normalized.events.length, dropped: normalized.events.length - HOOK_MAX_EVENTS_PER_DELIVERY });
  const fresh: TriggerEvent[] = [];
  let duplicates = 0;
  for (const candidate of normalized.events.slice(0, HOOK_MAX_EVENTS_PER_DELIVERY)) {
    // The hook's own project and id, whatever the provider derived or the body said.
    const parsed = TriggerEventSchema.safeParse({ ...candidate, source: hook.source, project: hook.project, hookId: hook.hookId });
    if (!parsed.success) {
      log("hook.event_invalid", { hookId: hook.hookId });
      continue;
    }
    const event = parsed.data;
    // 9. The age window: not older than a day, and not dated ahead by more than the clock's slack.
    const at = Date.parse(event.occurredAt);
    if (now - at > EVENT_MAX_AGE_HOURS * HOUR) {
      log("hook.stale", { hookId: hook.hookId });
      continue;
    }
    if (at - now > EVENT_MAX_FUTURE_MINUTES * MINUTE) {
      log("hook.future", { hookId: hook.hookId });
      continue;
    }
    // 10. De-duplication, by the event key the signed body names.
    if (await firstSight(deps, orgId, hook.hookId, event.eventKey, now)) fresh.push(event);
    else duplicates += 1;
  }
  // 11. Dispatch. An event that was recorded and not started is forgotten again, so that the vendor's retry starts it.
  for (const [index, event] of fresh.entries()) {
    try {
      await deps.dispatch(orgId, event);
      await markDispatched(deps, orgId, hook.hookId, event);
    } catch (error) {
      log("hook.dispatch_failed", { hookId: hook.hookId, error: errorName(error) });
      await forget(deps, orgId, hook.hookId, fresh.slice(index));
      return { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "try again" } } };
    }
  }
  if (hook.lastDeliveryAt === undefined || now - Date.parse(hook.lastDeliveryAt) >= MINUTE) {
    await deps.hooks.touch(orgId, hook.hookId, new Date(now).toISOString()).catch((error: unknown) => log("hook.touch_failed", { hookId: hook.hookId, error: errorName(error) }));
  }
  if (fresh.length === 0 && duplicates > 0) return { status: 200, body: { delivery: "DUPLICATE" } };
  return { status: 202, body: { delivery: "ACCEPTED", events: fresh.length } };
}

/** What a delivery to `/v1/hooks/{source}/{hookId}` is answered. A fault of ours answers 503 with nothing in it, so that the vendor tries again. */
export async function receiveHook(deps: HookIngressDeps, delivery: HookDelivery): Promise<HookReply> {
  try {
    return await receive(deps, delivery);
  } catch (error) {
    logOf(deps)("hook.unavailable", { error: errorName(error) });
    return { status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "try again" } } };
  }
}
