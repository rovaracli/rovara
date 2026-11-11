// Company domain verification (owner decision 2026-11-02): the store of company domains.
//
// TWO KINDS OF ITEM.
//   own     `ORG#<org>` / `COMPANY_DOMAIN#<domain>`: the company's own claim of a domain. It holds the company's token, which never changes for that company and domain, and it blocks nobody: any number of
//           companies may hold one for the same domain, and a claim with no proof is worth nothing. It carries the daily re-check's due time.
//   holder  `COMPANY_DOMAIN#<domain>` / `CLAIM`: the one company that has PROVED the domain (its token was found in DNS). Written only by a check that found the company's own token, with a condition: the first
//           company to prove wins, and a second proof of another company cannot overwrite it except by the rules below. `isVerifiedCompanyDomain` reads only this item.
//
// STATES of the holder: `verified`; `lost` (the record has been gone COMPANY_DOMAIN_LOST_AFTER_DAYS days running; does not count, but the company stays the holder and can verify again by putting the record back).
//
// WHEN ANOTHER COMPANY TAKES A HELD DOMAIN (the safest rule, and the only one): the holder is LOST (never while it is verified, however DNS looks for that day), or its company has closed; and in one look DNS
// shows the newcomer's token and NOT the holder's; and the newcomer's token alone was seen by an earlier look at least COMPANY_DOMAIN_TAKEOVER_CONFIRM_MS before (any look that does not show it clears that
// sighting). So a short outage or a lookup that fails ("unavailable") moves nothing, a flip between two tokens moves nothing until one of them has stayed the only one and the holder has been gone three days,
// and a holder whose record returns is verified again at its next look (its record in DNS ends any take-over). A take-over writes the holder's version plus one, so a stale release or check can never overwrite it.
//
// A lookup that fails never counts against a domain: only a definite "the record is not there" starts or advances the lost clock. The daily re-check rides the sparse due-time index the workflow rows use
// (WORKFLOW_DISPATCH_DUE_INDEX) under its own partition value, so it needs no new index and no new schedule.
import { createHash, randomBytes } from "node:crypto";
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { COMPANY_DOMAIN_LOST_AFTER_DAYS, COMPANY_DOMAIN_LOST_WATCH_DAYS, COMPANY_DOMAIN_MAX_PER_ORG, COMPANY_DOMAIN_PENDING_DAYS, COMPANY_DOMAIN_TAKEOVER_CONFIRM_MS, COMPANY_DOMAIN_TXT_PREFIX, orgMetaKey, type CompanyDomainCheckResult, type CompanyDomainView } from "@agentx/cloud-contracts";
import { WORKFLOW_DISPATCH_DUE_INDEX, agentXError, orgPk, type OrgId } from "@rovara-code/contracts";
import { type AuditActor } from "@agentx/cloud-contracts";
import { SYSTEM_ACTOR, auditActorOf } from "../../audit/plan3-hooks.js";
import { auditCompanyDomainAdded, auditCompanyDomainLost, auditCompanyDomainRemoved, auditCompanyDomainVerified, auditOccurrence } from "../../audit/events.js";
import { flushAuditEvents } from "../../audit/flush.js";
import type { AuditRuntime, TransactItem } from "../../audit/outbox.js";
import { auditedWrite } from "../../playbook/project-settings-audit.js";
import { normalizeEmailDomain } from "./normalize.js";
import { verificationRecordName, type TxtLookup, type TxtResolver } from "./resolver.js";

export const COMPANY_DOMAIN_RECHECK_PK = "COMPANY_DOMAIN_RECHECK";
const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
/** After a lookup that failed, the domain is looked at again in this long. */
const RETRY_AFTER_FAILURE_MS = HOUR_MS;
const TOKEN_HEX = /^[0-9a-f]{40}$/;

export interface CompanyDomainDeps {
  documentClient: { send(command: never): Promise<unknown> };
  tableName: string;
  now(): number;
  audit?: AuditRuntime | undefined;
}

/** The holder: the company that proved the domain. */
export interface ClaimRecord {
  pk: string;
  sk: "CLAIM";
  entityType: "COMPANY_DOMAIN";
  domain: string;
  orgId: OrgId;
  state: "verified" | "lost";
  token: string;
  /** Written on every change; a write holds only while it is the version the caller read. A take-over writes the old version plus one. */
  version: number;
  /** When this company first proved the domain. */
  claimedAt: string;
  claimedBy: string;
  verifiedAt?: string;
  missingSince?: string;
  lostAt?: string;
}

/** A company's own claim of a domain. */
export interface OwnRecord {
  pk: string;
  sk: string;
  entityType: "COMPANY_DOMAIN_POINTER";
  domain: string;
  orgId: OrgId;
  token: string;
  version: number;
  claimedAt: string;
  claimedBy: string;
  lastCheckedAt?: string;
  lastResult?: CompanyDomainCheckResult;
  /** When the company's token was first seen alone in DNS while another company held the domain as lost. */
  takeoverSeenAt?: string;
  dispatchDuePk?: typeof COMPANY_DOMAIN_RECHECK_PK;
  dispatchDueSk?: string;
}

/** What a company sees of one domain: its own claim, and the holder item when the holder is this company. */
export interface DomainEntry { own: OwnRecord; holder?: ClaimRecord }

export const claimKey = (domain: string) => ({ pk: `COMPANY_DOMAIN#${domain}`, sk: "CLAIM" as const });
export const ownKey = (orgId: OrgId, domain: string) => ({ pk: orgPk(orgId), sk: `COMPANY_DOMAIN#${domain}` });
const POINTER_PREFIX = "COMPANY_DOMAIN#";

type Item = Record<string, unknown>;
/** The audit port for the outbox functions: absent on an install with no ledger. */
const auditDeps = (deps: Pick<CompanyDomainDeps, "audit">): { audit?: AuditRuntime } => (deps.audit === undefined ? {} : { audit: deps.audit });
const send = <T>(deps: CompanyDomainDeps, command: unknown): Promise<T> => deps.documentClient.send(command as never) as Promise<T>;
const iso = (ms: number): string => new Date(ms).toISOString();
const isCancellation = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");

/** The text of the record to publish. */
export const recordValue = (token: string): string => `${COMPANY_DOMAIN_TXT_PREFIX}${token}`;

export function toView(entry: DomainEntry): CompanyDomainView {
  const { own, holder } = entry;
  return {
    domain: own.domain, state: holder === undefined ? "pending" : holder.state,
    record: { type: "TXT", name: verificationRecordName(own.domain), value: recordValue(own.token) },
    addedAt: own.claimedAt,
    ...(holder?.verifiedAt === undefined ? {} : { verifiedAt: holder.verifiedAt }),
    ...(own.lastCheckedAt === undefined ? {} : { lastCheckedAt: own.lastCheckedAt }),
    ...(own.lastResult === undefined ? {} : { lastResult: own.lastResult }),
    ...(holder?.missingSince === undefined ? {} : { missingSince: holder.missingSince }),
    ...(holder?.lostAt === undefined ? {} : { lostAt: holder.lostAt }),
  };
}

function readClaim(item: Item | undefined): ClaimRecord | undefined {
  if (item === undefined || item.entityType !== "COMPANY_DOMAIN") return undefined;
  if (item.state !== "verified" && item.state !== "lost") return undefined;
  if (typeof item.domain !== "string" || typeof item.orgId !== "string" || typeof item.token !== "string" || !TOKEN_HEX.test(item.token) || typeof item.version !== "number" || typeof item.claimedAt !== "string") return undefined;
  return item as unknown as ClaimRecord;
}

function readOwn(item: Item | undefined): OwnRecord | undefined {
  if (item === undefined || item.entityType !== "COMPANY_DOMAIN_POINTER") return undefined;
  if (typeof item.domain !== "string" || typeof item.orgId !== "string" || typeof item.token !== "string" || !TOKEN_HEX.test(item.token) || typeof item.version !== "number" || typeof item.claimedAt !== "string") return undefined;
  return item as unknown as OwnRecord;
}

export async function getClaim(deps: CompanyDomainDeps, domain: string): Promise<ClaimRecord | undefined> {
  const found = await send<{ Item?: Item }>(deps, new GetCommand({ TableName: deps.tableName, Key: claimKey(domain), ConsistentRead: true }));
  return readClaim(found.Item);
}

export async function getOwn(deps: CompanyDomainDeps, orgId: OrgId, domain: string): Promise<OwnRecord | undefined> {
  const found = await send<{ Item?: Item }>(deps, new GetCommand({ TableName: deps.tableName, Key: ownKey(orgId, domain), ConsistentRead: true }));
  return readOwn(found.Item);
}

/** The company's entry for a domain: its claim, and the holder item when this company is the holder. */
export async function getEntry(deps: CompanyDomainDeps, orgId: OrgId, domain: string): Promise<DomainEntry | undefined> {
  const own = await getOwn(deps, orgId, domain);
  if (own === undefined) return undefined;
  const holder = await getClaim(deps, domain);
  return holder !== undefined && holder.orgId === orgId ? { own, holder } : { own };
}

/** Whether the company that holds a claim has closed. An org with no record is not treated as closed: nothing is taken from a company on a guess. */
async function orgClosed(deps: CompanyDomainDeps, orgId: OrgId): Promise<boolean> {
  const found = await send<{ Item?: Item }>(deps, new GetCommand({ TableName: deps.tableName, Key: orgMetaKey(orgId), ConsistentRead: true }));
  return found.Item?.closedAt !== undefined;
}

/** The company's entries, by domain. */
export async function listEntries(deps: CompanyDomainDeps, orgId: OrgId): Promise<DomainEntry[]> {
  const owns: OwnRecord[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await send<{ Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> }>(deps, new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": POINTER_PREFIX },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }));
    for (const item of page.Items ?? []) {
      const own = readOwn(item);
      if (own !== undefined && own.orgId === orgId) owns.push(own);
    }
    start = page.LastEvaluatedKey;
  } while (start !== undefined && owns.length <= COMPANY_DOMAIN_MAX_PER_ORG * 2);
  const capped = owns.slice(0, COMPANY_DOMAIN_MAX_PER_ORG * 2);
  const holders = capped.length === 0 ? [] : (await send<{ Responses?: Record<string, Item[]> }>(deps, new BatchGetCommand({
    RequestItems: { [deps.tableName]: { Keys: capped.map((own) => claimKey(own.domain)), ConsistentRead: true } },
  }))).Responses?.[deps.tableName] ?? [];
  const byDomain = new Map(holders.flatMap((item) => { const claim = readClaim(item); return claim === undefined ? [] : [[claim.domain, claim] as const]; }));
  return capped.map((own): DomainEntry => { const holder = byDomain.get(own.domain); return holder !== undefined && holder.orgId === orgId ? { own, holder } : { own }; })
    .sort((left, right) => left.own.domain.localeCompare(right.own.domain));
}

/** When the claim is looked at next, or undefined when it no longer is (a claim nobody proved within its days; a lost domain left alone after its watch). */
function nextCheckAt(claim: { state: "pending" | "verified" | "lost"; claimedAt: string; lostAt?: string | undefined }, at: number, failed: boolean): number | undefined {
  if (claim.state === "pending" && at > Date.parse(claim.claimedAt) + COMPANY_DOMAIN_PENDING_DAYS * DAY_MS) return undefined;
  if (claim.state === "lost" && claim.lostAt !== undefined && at > Date.parse(claim.lostAt) + COMPANY_DOMAIN_LOST_WATCH_DAYS * DAY_MS) return undefined;
  return at + (failed ? RETRY_AFTER_FAILURE_MS : DAY_MS);
}

/** A due time as an index sort key: fixed width, so text order is time order. */
const dueKey = (time: number): string => String(Math.max(0, Math.trunc(time))).padStart(15, "0");
const dueAttributes = (domain: string, at: number | undefined): Pick<OwnRecord, "dispatchDuePk" | "dispatchDueSk"> =>
  at === undefined ? {} : { dispatchDuePk: COMPANY_DOMAIN_RECHECK_PK, dispatchDueSk: `${dueKey(at)}#${domain}` };

/** The first look is spread over the day after the claim (by the domain's own hash), so a company that adds many at once is not looked at all at once. */
const firstCheckAt = (domain: string, at: number): number => at + HOUR_MS + (createHash("sha256").update(domain).digest().readUInt32BE(0) % (23 * HOUR_MS));

const newToken = (): string => randomBytes(20).toString("hex");

/** `by` is a developer id, or the word "system" for the daily run. */
const actorOf = (by: string): AuditActor => (by === "system" ? SYSTEM_ACTOR : auditActorOf(by));

export interface AddOutcome { entry: DomainEntry; created: boolean }

/**
 * The company adds a domain: its own claim, with a token that never changes for this company and domain. It blocks nobody and nobody's claim blocks it. A domain the company already has is returned as it is.
 * The audit event is in the same transaction.
 */
export async function addCompanyDomain(deps: CompanyDomainDeps, input: { orgId: OrgId; by: string; domain: string }): Promise<AddOutcome> {
  const at = deps.now();
  const existing = await getEntry(deps, input.orgId, input.domain);
  if (existing !== undefined) return { entry: existing, created: false };
  if ((await listEntries(deps, input.orgId)).length >= COMPANY_DOMAIN_MAX_PER_ORG) throw agentXError("CONFIG_INVALID", `A company can hold at most ${String(COMPANY_DOMAIN_MAX_PER_ORG)} domains. Remove one first.`);
  const own: OwnRecord = {
    ...ownKey(input.orgId, input.domain), entityType: "COMPANY_DOMAIN_POINTER", domain: input.domain, orgId: input.orgId, token: newToken(), version: 1,
    claimedAt: iso(at), claimedBy: input.by, ...dueAttributes(input.domain, firstCheckAt(input.domain, at)),
  };
  const audited = await auditedWrite(auditDeps(deps), () => [auditCompanyDomainAdded({
    orgId: input.orgId, actor: actorOf(input.by), occurredAt: own.claimedAt, occurrence: auditOccurrence(input.domain, own.claimedAt), domain: input.domain,
  })]);
  try {
    await send(deps, new TransactWriteCommand({ TransactItems: [{ Put: { TableName: deps.tableName, Item: own, ConditionExpression: "attribute_not_exists(pk)" } }, ...audited.items] }));
  } catch (error) {
    if (!isCancellation(error)) throw error;
    const raced = await getEntry(deps, input.orgId, input.domain);
    if (raced !== undefined) return { entry: raced, created: false };
    throw error;
  }
  await flushAuditEvents(auditDeps(deps), audited.events);
  return { entry: { own }, created: true };
}

/** Removes the company's own claim, and the holder item too when the company is the holder. A domain the company has not added is NOT_FOUND, whoever else holds it: nothing of another company's is touched. */
export async function removeCompanyDomain(deps: CompanyDomainDeps, input: { orgId: OrgId; by: string; domain: string }): Promise<void> {
  const entry = await getEntry(deps, input.orgId, input.domain);
  if (entry === undefined) throw agentXError("NOT_FOUND", "That domain is not one of your company's.");
  const at = iso(deps.now());
  const audited = await auditedWrite(auditDeps(deps), () => [auditCompanyDomainRemoved({
    orgId: input.orgId, actor: actorOf(input.by), occurredAt: at, occurrence: auditOccurrence(input.domain, entry.own.claimedAt), domain: input.domain, wasState: entry.holder?.state ?? "pending",
  })]);
  const items: TransactItem[] = [
    { Delete: { TableName: deps.tableName, Key: ownKey(input.orgId, input.domain), ConditionExpression: "#version = :own", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":own": entry.own.version } } },
    ...(entry.holder === undefined ? [] : [{ Delete: { TableName: deps.tableName, Key: claimKey(input.domain), ConditionExpression: "#orgId = :org AND #version = :version", ExpressionAttributeNames: { "#orgId": "orgId", "#version": "version" }, ExpressionAttributeValues: { ":org": input.orgId, ":version": entry.holder.version } } }]),
    ...audited.items,
  ];
  try {
    await send(deps, new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (isCancellation(error)) throw agentXError("CHANGE_STALE", "This domain changed while you were removing it. Reload and try again.");
    throw error;
  }
  await flushAuditEvents(auditDeps(deps), audited.events);
}

// ---- checking

/** Whether any record is exactly the company's, `rovara-verify=<token>`, with nothing before or after (surrounding space is ignored). */
export const hasToken = (lookup: TxtLookup, token: string): boolean => lookup.kind === "records" && lookup.records.some((record) => record.trim() === recordValue(token));

/** What a lookup comes to for this token. */
export function resultOf(lookup: TxtLookup, token: string): CompanyDomainCheckResult {
  if (lookup.kind === "unavailable") return "unavailable";
  if (lookup.kind === "indirect") return "indirect";
  if (lookup.kind === "absent") return "not_found";
  return hasToken(lookup, token) ? "found" : "not_found";
}

export type Transition = { kind: "verified"; wasState: "pending" | "lost"; tookOver: boolean } | { kind: "lost"; missingDays: number };

/** The holder after a look at ITS OWN record, and what it turned into (if it changed state). Pure: the clock and the result are arguments. */
export function applyCheck(holder: ClaimRecord, result: CompanyDomainCheckResult, at: number): { next: ClaimRecord; transition?: Transition } {
  const base: ClaimRecord = { ...holder, version: holder.version + 1 };
  if (result === "unavailable") return { next: base };
  if (result === "found") {
    const { missingSince: _m, lostAt: _l, ...rest } = base;
    void _m; void _l;
    if (holder.state === "verified") return { next: rest };
    return { next: { ...rest, state: "verified", verifiedAt: iso(at) }, transition: { kind: "verified", wasState: "lost", tookOver: false } };
  }
  // Not found, or behind an alias: the record is not where it must be.
  if (holder.state !== "verified") return { next: base };
  const since = holder.missingSince ?? iso(at);
  const gone = at - Date.parse(since);
  if (gone >= COMPANY_DOMAIN_LOST_AFTER_DAYS * DAY_MS) return { next: { ...base, state: "lost", missingSince: since, lostAt: iso(at) }, transition: { kind: "lost", missingDays: Math.floor(gone / DAY_MS) } };
  return { next: { ...base, missingSince: since } };
}

export interface CheckOutcome { entry: DomainEntry; result: CompanyDomainCheckResult; changed: boolean }

/** A new holder: the company that has just proved the domain. */
const newHolder = (own: OwnRecord, at: number, version: number): ClaimRecord => ({
  ...claimKey(own.domain), entityType: "COMPANY_DOMAIN", domain: own.domain, orgId: own.orgId, state: "verified", token: own.token, version, claimedAt: iso(at), claimedBy: own.claimedBy, verifiedAt: iso(at),
});

/**
 * Looks at the record and writes what it found. `by` is the person who pressed Check now, or "system" for the daily run. See the head of this file for the rules: a company that finds its token while nobody
 * holds the domain becomes the holder (a conditional write: the first to prove wins); the holder's own looks drive verified and lost; another company's token moves a LOST domain only as described there.
 * A claim that changed while the lookup ran is returned as it now is.
 */
export async function checkOwn(deps: CompanyDomainDeps, own: OwnRecord, resolver: TxtResolver, by: string): Promise<CheckOutcome> {
  const lookup = await resolver.lookupTxt(verificationRecordName(own.domain)).catch((): TxtLookup => ({ kind: "unavailable" }));
  const at = deps.now();
  let result = resultOf(lookup, own.token);
  const holder = await getClaim(deps, own.domain);
  const mine = holder !== undefined && holder.orgId === own.orgId;
  let nextHolder: ClaimRecord | undefined;
  let holderCondition: { ConditionExpression: string; ExpressionAttributeNames?: Record<string, string>; ExpressionAttributeValues?: Record<string, unknown> } | undefined;
  let transition: Transition | undefined;
  // A look that fails neither clears nor starts a sighting of the newcomer's token alone.
  let seen: string | undefined = result === "unavailable" ? own.takeoverSeenAt : undefined;
  const replaces = (previous: ClaimRecord) => ({ ConditionExpression: "#version = :version AND #orgId = :holder", ExpressionAttributeNames: { "#version": "version", "#orgId": "orgId" }, ExpressionAttributeValues: { ":version": previous.version, ":holder": previous.orgId } });
  if (mine) {
    const applied = applyCheck(holder, result, at);
    nextHolder = applied.next; transition = applied.transition; holderCondition = replaces(holder);
  } else if (result === "found") {
    const vacant = holder === undefined || await orgClosed(deps, holder.orgId);
    if (vacant) {
      nextHolder = newHolder(own, at, holder === undefined ? 1 : holder.version + 1);
      holderCondition = holder === undefined ? { ConditionExpression: "attribute_not_exists(pk)" } : replaces(holder);
      transition = { kind: "verified", wasState: "pending", tookOver: holder !== undefined };
    } else if (holder.state === "lost" && !hasToken(lookup, holder.token)) {
      // Only this company's token is in DNS and the holder is lost: confirmed by a second look at least an hour after the first.
      if (own.takeoverSeenAt !== undefined && at - Date.parse(own.takeoverSeenAt) >= COMPANY_DOMAIN_TAKEOVER_CONFIRM_MS) {
        nextHolder = newHolder(own, at, holder.version + 1); holderCondition = replaces(holder);
        transition = { kind: "verified", wasState: "pending", tookOver: true };
      } else {
        result = "held"; seen = own.takeoverSeenAt ?? iso(at);
      }
    } else {
      result = "held";
    }
  }
  const state = nextHolder !== undefined && nextHolder.orgId === own.orgId ? nextHolder.state : "pending";
  const nextOwn: OwnRecord = {
    ...own, version: own.version + 1, lastCheckedAt: iso(at), lastResult: result,
    ...(seen === undefined ? {} : { takeoverSeenAt: seen }),
  };
  delete nextOwn.dispatchDuePk; delete nextOwn.dispatchDueSk;
  if (seen === undefined) delete nextOwn.takeoverSeenAt;
  Object.assign(nextOwn, dueAttributes(own.domain, nextCheckAt({ state, claimedAt: own.claimedAt, lostAt: nextHolder?.lostAt }, at, result === "unavailable")));
  const audited = await auditedWrite(auditDeps(deps), () => {
    if (transition === undefined) return [];
    const base = { orgId: own.orgId, actor: actorOf(by), occurredAt: iso(at), occurrence: auditOccurrence(own.domain, own.claimedAt, iso(at)), domain: own.domain };
    return [transition.kind === "verified" ? auditCompanyDomainVerified({ ...base, wasState: transition.wasState, tookOver: transition.tookOver }) : auditCompanyDomainLost({ ...base, actor: SYSTEM_ACTOR, missingDays: transition.missingDays })];
  });
  try {
    await send(deps, new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: nextOwn, ConditionExpression: "#version = :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": own.version } } },
      ...(nextHolder === undefined || holderCondition === undefined ? [] : [{ Put: { TableName: deps.tableName, Item: nextHolder, ...holderCondition } }]),
      ...audited.items,
    ] }));
  } catch (error) {
    if (!isCancellation(error)) throw error;
    const current = await getEntry(deps, own.orgId, own.domain);
    return { entry: current ?? { own }, result, changed: false };
  }
  await flushAuditEvents(auditDeps(deps), audited.events);
  return { entry: nextHolder !== undefined && nextHolder.orgId === own.orgId ? { own: nextOwn, holder: nextHolder } : { own: nextOwn }, result, changed: true };
}

/** The company's claim for a domain, checked now. NOT_FOUND for a domain the company has not added. */
export async function checkCompanyDomain(deps: CompanyDomainDeps, input: { orgId: OrgId; by: string; domain: string; resolver: TxtResolver }): Promise<CheckOutcome> {
  const own = await getOwn(deps, input.orgId, input.domain);
  if (own === undefined) throw agentXError("NOT_FOUND", "That domain is not one of your company's.");
  return checkOwn(deps, own, input.resolver, input.by);
}

// ---- the daily re-check

export interface RecheckOutcome { checked: number; verified: number; lost: number; released: number; skipped: number }

/**
 * Looks at the claims that are due, oldest first, at most `limit` and while `budgetMs` lasts. The claim of a closed company is released instead (its claim, and the holder item if it held the domain, go; the
 * holder is deleted only while it is still that company's, at the version read). A row read just as it changed is skipped: the version holds the write.
 */
export async function recheckDueDomains(deps: CompanyDomainDeps, options: { resolver: TxtResolver; budgetMs: number; limit?: number }): Promise<RecheckOutcome> {
  const started = Date.now();
  const outcome: RecheckOutcome = { checked: 0, verified: 0, lost: 0, released: 0, skipped: 0 };
  const page = await send<{ Items?: Item[] }>(deps, new QueryCommand({
    TableName: deps.tableName, IndexName: WORKFLOW_DISPATCH_DUE_INDEX.name,
    KeyConditionExpression: `${WORKFLOW_DISPATCH_DUE_INDEX.partitionKey} = :pk AND ${WORKFLOW_DISPATCH_DUE_INDEX.sortKey} BETWEEN :from AND :due`,
    // "~" sorts after the "#" that follows each due time, so this includes every row due at or before now.
    ExpressionAttributeValues: { ":pk": COMPANY_DOMAIN_RECHECK_PK, ":from": "0", ":due": `${dueKey(deps.now())}~` }, Limit: options.limit ?? 5,
  }));
  for (const row of page.Items ?? []) {
    if (Date.now() - started >= options.budgetMs) { outcome.skipped += 1; continue; }
    const listed = readOwn(row);
    if (listed === undefined) { outcome.skipped += 1; continue; }
    try {
      // The index is eventually consistent: the claim itself says whether it is still due.
      const own = await getOwn(deps, listed.orgId, listed.domain);
      if (own === undefined || own.dispatchDueSk === undefined || own.dispatchDueSk > `${dueKey(deps.now())}~`) { outcome.skipped += 1; continue; }
      if (await orgClosed(deps, own.orgId)) {
        const holder = await getClaim(deps, own.domain);
        await send(deps, new TransactWriteCommand({ TransactItems: [
          { Delete: { TableName: deps.tableName, Key: ownKey(own.orgId, own.domain), ConditionExpression: "#version = :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": own.version } } },
          ...(holder === undefined || holder.orgId !== own.orgId ? [] : [{ Delete: { TableName: deps.tableName, Key: claimKey(own.domain), ConditionExpression: "#orgId = :org AND #version = :version", ExpressionAttributeNames: { "#orgId": "orgId", "#version": "version" }, ExpressionAttributeValues: { ":org": own.orgId, ":version": holder.version } } }]),
        ] }));
        outcome.released += 1;
        continue;
      }
      const before = await getClaim(deps, own.domain);
      const checked = await checkOwn(deps, own, options.resolver, "system");
      if (!checked.changed) { outcome.skipped += 1; continue; }
      outcome.checked += 1;
      const wasMine = before?.orgId === own.orgId ? before.state : undefined;
      const nowState = checked.entry.holder?.state;
      if (nowState === "verified" && wasMine !== "verified") outcome.verified += 1;
      if (nowState === "lost" && wasMine !== "lost") outcome.lost += 1;
    } catch (error) {
      if (!isCancellation(error)) console.log(JSON.stringify({ component: "broker", event: "company_domain.recheck_failed", error: error instanceof Error ? error.name : "unknown" }));
      outcome.skipped += 1;
    }
  }
  return outcome;
}

// ---- the question other code asks

/**
 * Whether `emailDomain` (an address's domain, or an address) is a domain the company has verified: the company is the HOLDER and the holder is verified. Exactly that domain: a subdomain of a verified
 * domain is not, and neither is a domain that only looks like one. A claim with no proof, a lost domain and a domain another company holds do not count.
 */
export async function isVerifiedCompanyDomain(deps: Pick<CompanyDomainDeps, "documentClient" | "tableName">, orgId: OrgId, emailDomain: string): Promise<boolean> {
  const domain = normalizeEmailDomain(emailDomain);
  if (domain === undefined) return false;
  const claim = await getClaim({ ...deps, now: Date.now }, domain);
  return claim !== undefined && claim.orgId === orgId && claim.state === "verified";
}
