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
  SNS_FETCH_TIMEOUT_MS,
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
import type { ConnectedAwsAccounts, HookStore } from "./hooks.js";
import type { HookProvider, HookHeaders } from "./providers/types.js";
import { confirmationTarget } from "./providers/cloudwatch-sns.js";
import { SnsCertMemory, isConfirmation, parseSnsMessage, verifySnsMessage, type SnsMessage } from "./sns-verify.js";
import { headerOf, isoOfText } from "./providers/shared.js";
import { vendorFetch } from "../connectors/native/vendor-fetch.js";

export interface HookReply {
  status: 200 | 202 | 400 | 403 | 413 | 429 | 503;
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
  /** The signing certificates of SNS this container fetched, and how often it may fetch more. */
  readonly sns = new SnsCertMemory();
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
  hooks: Pick<HookStore, "orgOf" | "record" | "touch" | "confirmSubscription" | "markUnsubscribed">;
  /** Plan 3's `HookSecretStore.read`: the stored JSON, or a `NOT_FOUND` error when there is none. */
  secrets: { read(orgId: string, hookId: string): Promise<string> };
  /** The provider of each source (Tasks 22 to 25); a source with none answers the uniform 403. */
  providers: Partial<Record<HookSource, HookProvider>>;
  /** Task 20's `dispatchTriggerEvent`, over the broker's dependencies. */
  dispatch(orgId: OrgId, event: TriggerEvent): Promise<unknown>;
  memory: HookIngressMemory;
  /**
   * Team record (R7): offered a verified delivery's body after the hook's own provider read it and did not refuse its tenant (`createHookRecordTap`). It decides for
   * itself what to keep (a Linear or Jira change, comment or deletion that no trigger uses) and never throws. Absent: nothing is offered, as before.
   */
  recordTap?: (input: { orgId: OrgId; hook: HookRecord; body: unknown }) => Promise<unknown>;
  /**
   * Live interaction L1: offered a verified Linear delivery's body after the tenant check (`handleLinearComment`): a comment on an issue a session follows may be an Ask. It decides for itself what to do
   * and never changes what the delivery is answered. Absent: nothing is offered.
   */
  commentIntake?: (input: { orgId: OrgId; hook: HookRecord; body: unknown }) => Promise<unknown>;
  /** The AWS accounts an org connected (Task 25): a subscription is confirmed only for a hook whose account is one of them. Absent, none is confirmed. */
  awsAccounts?: ConnectedAwsAccounts;
  /** The fetch under SNS certificate requests and subscription confirmations; defaults to the vendor fetch that reaches public addresses only. */
  snsFetch?: typeof fetch;
  log?: (event: string, fields: Record<string, unknown>) => void;
}

export interface HookDelivery {
  source: string;
  hookId: string;
  raw: Buffer;
  headers: HookHeaders;
  sourceIp: string | undefined;
}

/** What remembering an event needs: the table and a log. GitHub's events use it with the hook id `github`. */
export type EventMemoryDeps = Pick<HookIngressDeps, "documentClient" | "tableName" | "log">;

const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");
const errorCode = (error: unknown): unknown => (error as { code?: unknown } | null)?.code;

function logOf(deps: Pick<HookIngressDeps, "log">): (event: string, fields: Record<string, unknown>) => void {
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

/** Whether an event's time is outside what is believed: older than `EVENT_MAX_AGE_HOURS` (`stale`) or more than `EVENT_MAX_FUTURE_MINUTES` ahead (`future`); undefined when inside. */
export function outsideEventWindow(occurredAt: string, now: number): "stale" | "future" | undefined {
  const at = Date.parse(occurredAt);
  if (now - at > EVENT_MAX_AGE_HOURS * HOUR) return "stale";
  if (at - now > EVENT_MAX_FUTURE_MINUTES * MINUTE) return "future";
  return undefined;
}

/**
 * Writes the item that says this event was received, `pending` until its dispatch is recorded; false when it was already there (a replay). A pending item older than
 * `EVENT_PENDING_TAKEOVER_MS` is the trace of a delivery that died between the two: one retry takes it over (a conditional update on the time it read) and starts the event again,
 * which is safe because dispatch is idempotent by event id. An item with no status was written before it existed and counts as dispatched.
 */
export async function firstSight(deps: EventMemoryDeps, orgId: OrgId, hookId: string, eventKey: string, now: number): Promise<boolean> {
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
export async function markDispatched(deps: EventMemoryDeps, orgId: OrgId, hookId: string, event: TriggerEvent): Promise<void> {
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
export async function forget(deps: EventMemoryDeps, orgId: OrgId, hookId: string, events: readonly TriggerEvent[]): Promise<void> {
  for (const event of events) {
    try {
      await deps.documentClient.send(new DeleteCommand({ TableName: deps.tableName, Key: hookEventKey(orgId, hookId, event.eventKey) }));
    } catch (error) {
      logOf(deps)("hook.dedupe_not_released", { hookId, error: errorName(error) });
    }
  }
}

/** A hook that is on. An SNS hook also takes deliveries while it waits for its confirmation: only a signed confirmation can end the wait. */
function usableHook(hook: HookRecord | undefined, source: HookSource, hookId: string): hook is HookRecord {
  return hook !== undefined && hook.hookId === hookId && hook.source === source && (hook.status === "active" || (hook.auth === "sns" && hook.status === "pending_confirmation"));
}

/** What SNS answers a visit to a `SubscribeURL`: the new subscription's ARN, which must be a subscription of the hook's own topic. */
const SUBSCRIPTION_ARN_TEXT = /<SubscriptionArn>([^<]{1,600})<\/SubscriptionArn>/;
const SUBSCRIPTION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const CONFIRM_MAX_BYTES = 65_536;

function subscriptionArnOf(answer: string | undefined, topicArn: string): string | undefined {
  const arn = answer === undefined ? undefined : SUBSCRIPTION_ARN_TEXT.exec(answer)?.[1];
  return arn !== undefined && arn.startsWith(`${topicArn}:`) && SUBSCRIPTION_ID.test(arn.slice(topicArn.length + 1)) ? arn : undefined;
}

const unavailable = (): HookReply => ({ status: 503, body: { error: { code: "RUNTIME_UNAVAILABLE", message: "try again" } } });

/**
 * A verified SubscriptionConfirmation: for a hook that waits, one visit to the SubscribeURL (SNS's own confirm action for this hook's topic, nothing else), and only when the hook's AWS
 * account is one the org connected. A hook that is already active ignores it. Nothing is visited unless every check passed.
 */
async function confirmSubscription(deps: HookIngressDeps, orgId: OrgId, hook: HookRecord, message: SnsMessage): Promise<HookReply> {
  const log = logOf(deps);
  if (hook.status === "active") return { status: 202, body: { delivery: "IGNORED" } };
  const tenant = hook.tenant as { awsAccountId: string; topicArn: string };
  const target = confirmationTarget(message, tenant.topicArn);
  if (target === undefined) {
    log("hook.sns_subscribe_url_refused", { hookId: hook.hookId });
    return forbidden();
  }
  if (deps.awsAccounts === undefined || !await deps.awsAccounts.isConnected(orgId, tenant.awsAccountId)) {
    log("hook.sns_account_not_connected", { hookId: hook.hookId });
    return forbidden();
  }
  let arn: string | undefined;
  try {
    const answer = await vendorFetch({
      url: target, allowedHosts: [target.hostname], timeoutMs: SNS_FETCH_TIMEOUT_MS, maxBytes: CONFIRM_MAX_BYTES, ...(deps.snsFetch === undefined ? {} : { fetch: deps.snsFetch }),
    });
    arn = answer.status === 200 ? subscriptionArnOf(answer.text, tenant.topicArn) : undefined;
  } catch (error) {
    log("hook.sns_confirm_failed", { hookId: hook.hookId, error: errorName(error) });
    return unavailable();
  }
  if (arn === undefined) {
    log("hook.sns_confirm_failed", { hookId: hook.hookId, error: "unexpected_answer" });
    return unavailable();
  }
  // A lost race (another delivery confirmed it first) leaves the hook active all the same.
  await deps.hooks.confirmSubscription(orgId, hook.hookId, arn);
  return { status: 202, body: { delivery: "SUBSCRIPTION_CONFIRMED" } };
}

/**
 * An SNS hook's delivery (Task 25). The cheap checks come first and cost nothing: the body names this hook's topic, so does the `x-amz-sns-topic-arn` header, and a Notification is
 * taken only by a hook that is active. Then the signature (`verifySnsMessage`, the one place a certificate is fetched). Only after it passes is anything written: the rate count,
 * then by type a confirmation (once, for the hook's own topic and a connected account), an unsubscription (no URL is visited), or the alarm's events through the common path.
 */
async function receiveSns(deps: HookIngressDeps, orgId: OrgId, hook: HookRecord, provider: HookProvider, delivery: HookDelivery, now: number): Promise<HookReply> {
  const log = logOf(deps);
  const topicArn = (hook.tenant as { topicArn: string }).topicArn;
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(delivery.raw));
  } catch {
    return forbidden();
  }
  const message = parseSnsMessage(body);
  if (message === undefined || message.TopicArn !== topicArn || headerOf(delivery.headers, "x-amz-sns-topic-arn") !== topicArn) return forbidden();
  if (message.Type === "Notification" && hook.status !== "active") return forbidden();
  if (!await verifySnsMessage({ memory: deps.memory.sns, ...(deps.snsFetch === undefined ? {} : { fetch: deps.snsFetch }) }, message, now)) {
    deps.memory.failures.hit(hook.hookId, now);
    return forbidden();
  }
  // A confirmation is signed over its own time: an old one is a replay, not a message from SNS to this hook now.
  if (isConfirmation(message.Type)) {
    const sent = isoOfText(message.Timestamp);
    if (sent === undefined || outsideEventWindow(sent, now) !== undefined) return forbidden();
  }
  // The hook is for an AWS account the org connected, and the connection is read now: one removed since the hook was made ends what the hook may start. (A confirmation checks the same
  // before its visit, and an unsubscription starts nothing.) Read only after the signature, so forged traffic costs no read.
  if (message.Type === "Notification" && (deps.awsAccounts === undefined || !await deps.awsAccounts.isConnected(orgId, (hook.tenant as { awsAccountId: string }).awsAccountId))) {
    log("hook.sns_account_not_connected", { hookId: hook.hookId });
    return forbidden();
  }
  if (!await withinRate(deps, orgId, hook.hookId, now)) {
    log("hook.rate_limited", { hookId: hook.hookId });
    return { status: 429, body: { error: { code: "RATE_LIMITED", message: "too many deliveries" } } };
  }
  if (message.Type === "SubscriptionConfirmation") return confirmSubscription(deps, orgId, hook, message);
  if (message.Type === "UnsubscribeConfirmation") {
    await deps.hooks.markUnsubscribed(orgId, hook.hookId);
    return { status: 202, body: { delivery: "UNSUBSCRIBED" } };
  }
  let normalized: ReturnType<HookProvider["normalize"]>;
  try {
    normalized = provider.normalize(body, delivery.headers, hook);
  } catch (error) {
    log("hook.normalize_failed", { hookId: hook.hookId, error: errorName(error) });
    return forbidden();
  }
  return deliverEvents(deps, orgId, hook, normalized, now);
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
  // An SNS hook has no secret: the message's own signature, the topic it names and the account it is for are the proof (Task 25).
  if (hook.auth === "sns") return receiveSns(deps, orgId, hook, provider, delivery, now);
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
  } catch (error) {
    // The sender is proven by now, so this is a bad request, not a failed check; only the hook id and the kind of fault are logged, never a byte of the body.
    log("hook.body_unreadable", { hookId: hook.hookId, error: errorName(error) });
    return { status: 400, body: { error: { code: "BAD_REQUEST", message: "the delivery body can't be read" } } };
  }
  let normalized: ReturnType<HookProvider["normalize"]>;
  try {
    normalized = provider.normalize(body, delivery.headers, hook);
  } catch (error) {
    log("hook.normalize_failed", { hookId: hook.hookId, error: errorName(error) });
    return forbidden();
  }
  // Team record (R7): after the tenant check, before events are dispatched; a tap that throws or is slow changes nothing about the answer.
  if (deps.recordTap !== undefined && !("tenantMismatch" in normalized)) await offerToRecord(deps.recordTap, { orgId, hook, body }, () => log("hook.record_tap_failed", { hookId: hook.hookId }));
  if (deps.commentIntake !== undefined && hook.source === "linear" && !("tenantMismatch" in normalized)) await offerToRecord(deps.commentIntake, { orgId, hook, body }, () => log("hook.comment_intake_failed", { hookId: hook.hookId }));
  return deliverEvents(deps, orgId, hook, normalized, now);
}

/** Steps 8 (the tenant check, from the provider) to 11: what the provider read becomes events, each checked against the age window, remembered once and dispatched. */
async function deliverEvents(deps: HookIngressDeps, orgId: OrgId, hook: HookRecord, normalized: ReturnType<HookProvider["normalize"]>, now: number): Promise<HookReply> {
  const log = logOf(deps);
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
    const outside = outsideEventWindow(event.occurredAt, now);
    if (outside !== undefined) {
      log(`hook.${outside}`, { hookId: hook.hookId });
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

/** Longest the Team record tap may hold a hook delivery's answer. */
export const HOOK_RECORD_TAP_BUDGET_MS = 1_500;

async function offerToRecord<T>(tap: (input: T) => Promise<unknown>, input: T, onFailure: () => void): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([tap(input), new Promise<void>((resolve) => { timer = setTimeout(() => { onFailure(); resolve(); }, HOOK_RECORD_TAP_BUDGET_MS); })]);
  } catch (error) {
    onFailure();
    // A delete the record could not take at all (TRW-5 S2): not swallowed. `receiveHook` answers 503 with nothing in it, so that Linear or Jira sends the delivery again.
    if ((error as { name?: unknown } | null)?.name === "RecordRemovalNotAccepted") throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
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
