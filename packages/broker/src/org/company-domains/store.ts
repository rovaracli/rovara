// Company domain verification (owner decision 2026-11-02): the store of company domains.
//
// One domain belongs to one company. The claim is ONE item keyed by the domain (`COMPANY_DOMAIN#<domain>` / `CLAIM`), so a conditional write on that key is what refuses a second claim; each
// company also keeps a pointer item (`ORG#<org>` / `COMPANY_DOMAIN#<domain>`) so its own list needs no scan. The claim is the truth: a pointer whose claim names another company is stale and ignored.
//
//   pending   claimed, token not yet found. Another company may take the domain over after COMPANY_DOMAIN_PENDING_DAYS.
//   verified  the token was found. Counts for `isVerifiedCompanyDomain`.
//   lost      a verified domain whose record has been gone COMPANY_DOMAIN_LOST_AFTER_DAYS days running. Does not count; another company may take it over; the check goes on, and finding the record again verifies it.
//
// A lookup that fails (timeout, server failure) changes nothing about the state: only a definite "the record is not there" starts or advances the clock. The daily re-check rides the sparse
// due-time index the workflow rows use (WORKFLOW_DISPATCH_DUE_INDEX) under its own partition value, so it needs no new index and no new schedule.
import { randomBytes } from "node:crypto";
import { BatchGetCommand, GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  COMPANY_DOMAIN_LOST_AFTER_DAYS, COMPANY_DOMAIN_MAX_PER_ORG, COMPANY_DOMAIN_PENDING_DAYS, COMPANY_DOMAIN_TAKEN_MESSAGE, COMPANY_DOMAIN_TXT_PREFIX, WORKFLOW_DISPATCH_DUE_INDEX,
  agentXError, orgMetaKey, orgPk, type AuditActor, type CompanyDomainCheckResult, type CompanyDomainState, type CompanyDomainView, type OrgId,
} from "@agentx/contracts";
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
/** A lost domain is looked at (for a company that put the record back) this long, then left alone until its owner presses Check now. */
const LOST_WATCH_DAYS = 30;
const TOKEN_HEX = /^[0-9a-f]{40}$/;

export interface CompanyDomainDeps {
  documentClient: { send(command: never): Promise<unknown> };
  tableName: string;
  now(): number;
  audit?: AuditRuntime | undefined;
}

export interface ClaimRecord {
  pk: string;
  sk: "CLAIM";
  entityType: "COMPANY_DOMAIN";
  domain: string;
  orgId: OrgId;
  state: CompanyDomainState;
  token: string;
  /** Written on every change; a write holds only while it is the version the caller read. */
  version: number;
  claimedAt: string;
  claimedBy: string;
  verifiedAt?: string;
  lastCheckedAt?: string;
  lastResult?: CompanyDomainCheckResult;
  missingSince?: string;
  lostAt?: string;
  dispatchDuePk?: typeof COMPANY_DOMAIN_RECHECK_PK;
  dispatchDueSk?: string;
}

export const claimKey = (domain: string) => ({ pk: `COMPANY_DOMAIN#${domain}`, sk: "CLAIM" as const });
export const pointerKey = (orgId: OrgId, domain: string) => ({ pk: orgPk(orgId), sk: `COMPANY_DOMAIN#${domain}` });
const POINTER_PREFIX = "COMPANY_DOMAIN#";

type Item = Record<string, unknown>;
/** The audit port for the outbox functions: absent on an install with no ledger. */
const auditDeps = (deps: Pick<CompanyDomainDeps, "audit">): { audit?: AuditRuntime } => (deps.audit === undefined ? {} : { audit: deps.audit });
const send = <T>(deps: CompanyDomainDeps, command: unknown): Promise<T> => deps.documentClient.send(command as never) as Promise<T>;
const iso = (ms: number): string => new Date(ms).toISOString();
const isCancellation = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");

/** The text of the record to publish. */
export const recordValue = (token: string): string => `${COMPANY_DOMAIN_TXT_PREFIX}${token}`;

export function toView(claim: ClaimRecord): CompanyDomainView {
  const expires = claim.state === "pending" ? iso(Date.parse(claim.claimedAt) + COMPANY_DOMAIN_PENDING_DAYS * DAY_MS) : undefined;
  return {
    domain: claim.domain, state: claim.state,
    record: { type: "TXT", name: verificationRecordName(claim.domain), value: recordValue(claim.token) },
    addedAt: claim.claimedAt,
    ...(expires === undefined ? {} : { expiresAt: expires }),
    ...(claim.verifiedAt === undefined ? {} : { verifiedAt: claim.verifiedAt }),
    ...(claim.lastCheckedAt === undefined ? {} : { lastCheckedAt: claim.lastCheckedAt }),
    ...(claim.lastResult === undefined ? {} : { lastResult: claim.lastResult }),
    ...(claim.missingSince === undefined ? {} : { missingSince: claim.missingSince }),
    ...(claim.lostAt === undefined ? {} : { lostAt: claim.lostAt }),
  };
}

function readClaim(item: Item | undefined): ClaimRecord | undefined {
  if (item === undefined || item.entityType !== "COMPANY_DOMAIN") return undefined;
  const state = item.state;
  if (state !== "pending" && state !== "verified" && state !== "lost") return undefined;
  if (typeof item.domain !== "string" || typeof item.orgId !== "string" || typeof item.token !== "string" || !TOKEN_HEX.test(item.token) || typeof item.version !== "number" || typeof item.claimedAt !== "string") return undefined;
  return item as unknown as ClaimRecord;
}

export async function getClaim(deps: CompanyDomainDeps, domain: string): Promise<ClaimRecord | undefined> {
  const found = await send<{ Item?: Item }>(deps, new GetCommand({ TableName: deps.tableName, Key: claimKey(domain), ConsistentRead: true }));
  return readClaim(found.Item);
}

/** Whether the company that holds a claim has closed. An org with no record is not treated as closed: nothing is taken from a company on a guess. */
async function orgClosed(deps: CompanyDomainDeps, orgId: OrgId): Promise<boolean> {
  const found = await send<{ Item?: Item }>(deps, new GetCommand({ TableName: deps.tableName, Key: orgMetaKey(orgId), ConsistentRead: true }));
  return found.Item?.closedAt !== undefined;
}

/** The company's claims, by domain. A pointer whose claim is gone or another company's is left out. */
export async function listClaims(deps: CompanyDomainDeps, orgId: OrgId): Promise<ClaimRecord[]> {
  const domains: string[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await send<{ Items?: Item[]; LastEvaluatedKey?: Record<string, unknown> }>(deps, new QueryCommand({
      TableName: deps.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": POINTER_PREFIX },
      ConsistentRead: true, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    }));
    for (const item of page.Items ?? []) if (typeof item.sk === "string") domains.push(item.sk.slice(POINTER_PREFIX.length));
    start = page.LastEvaluatedKey;
  } while (start !== undefined && domains.length <= COMPANY_DOMAIN_MAX_PER_ORG * 2);
  const found = domains.length === 0 ? [] : (await send<{ Responses?: Record<string, Item[]> }>(deps, new BatchGetCommand({
    RequestItems: { [deps.tableName]: { Keys: domains.slice(0, COMPANY_DOMAIN_MAX_PER_ORG * 2).map(claimKey), ConsistentRead: true } },
  }))).Responses?.[deps.tableName] ?? [];
  return found.map(readClaim).filter((claim): claim is ClaimRecord => claim !== undefined && claim.orgId === orgId).sort((left, right) => left.domain.localeCompare(right.domain));
}

/** When the claim is looked at next, or undefined when it no longer is (a pending claim nobody verified in time; a lost domain left alone for a month). */
function nextCheckAt(claim: Pick<ClaimRecord, "state" | "claimedAt" | "lostAt">, at: number, failed: boolean): number | undefined {
  if (claim.state === "pending" && at > Date.parse(claim.claimedAt) + COMPANY_DOMAIN_PENDING_DAYS * DAY_MS) return undefined;
  if (claim.state === "lost" && claim.lostAt !== undefined && at > Date.parse(claim.lostAt) + LOST_WATCH_DAYS * DAY_MS) return undefined;
  return at + (failed ? RETRY_AFTER_FAILURE_MS : DAY_MS);
}

/** A due time as an index sort key: fixed width, so text order is time order. */
const dueKey = (time: number): string => String(Math.max(0, Math.trunc(time))).padStart(15, "0");
const dueAttributes = (domain: string, at: number | undefined): Pick<ClaimRecord, "dispatchDuePk" | "dispatchDueSk"> =>
  at === undefined ? {} : { dispatchDuePk: COMPANY_DOMAIN_RECHECK_PK, dispatchDueSk: `${dueKey(at)}#${domain}` };

const newToken = (): string => randomBytes(20).toString("hex");

/** `by` is a developer id, or the word "system" for the daily run. */
const actorOf = (by: string): AuditActor => (by === "system" ? SYSTEM_ACTOR : auditActorOf(by));

export interface AddOutcome { claim: ClaimRecord; created: boolean; tookOver: boolean }

/**
 * Claims `domain` (already normalised) for the company. A domain the company already holds is returned as it is. A domain another company holds is refused (COMPANY_DOMAIN_TAKEN) unless that
 * claim is lost, has stayed pending for COMPANY_DOMAIN_PENDING_DAYS, or belongs to a closed company: then it is taken over with a new token. The write holds only while the claim is the
 * one that was read, so two companies claiming at once cannot both win. The audit event is in the same transaction.
 */
export async function addCompanyDomain(deps: CompanyDomainDeps, input: { orgId: OrgId; by: string; domain: string }): Promise<AddOutcome> {
  const at = deps.now();
  const existing = await getClaim(deps, input.domain);
  let tookOver = false;
  if (existing !== undefined) {
    if (existing.orgId === input.orgId) return { claim: existing, created: false, tookOver: false };
    const stalePending = existing.state === "pending" && at > Date.parse(existing.claimedAt) + COMPANY_DOMAIN_PENDING_DAYS * DAY_MS;
    if (existing.state !== "lost" && !stalePending && !(await orgClosed(deps, existing.orgId))) throw agentXError("COMPANY_DOMAIN_TAKEN", COMPANY_DOMAIN_TAKEN_MESSAGE);
    tookOver = true;
  }
  if ((await listClaims(deps, input.orgId)).length >= COMPANY_DOMAIN_MAX_PER_ORG) throw agentXError("CONFIG_INVALID", `A company can hold at most ${String(COMPANY_DOMAIN_MAX_PER_ORG)} domains. Remove one first.`);
  const claim: ClaimRecord = {
    ...claimKey(input.domain), entityType: "COMPANY_DOMAIN", domain: input.domain, orgId: input.orgId, state: "pending", token: newToken(), version: 1,
    claimedAt: iso(at), claimedBy: input.by, ...dueAttributes(input.domain, nextCheckAt({ state: "pending", claimedAt: iso(at) }, at, false)),
  };
  const audited = await auditedWrite(auditDeps(deps), () => [auditCompanyDomainAdded({
    orgId: input.orgId, actor: actorOf(input.by), occurredAt: claim.claimedAt, occurrence: auditOccurrence(input.domain, claim.claimedAt), domain: input.domain, tookOver,
  })]);
  const items: TransactItem[] = [
    {
      Put: {
        TableName: deps.tableName, Item: claim,
        ...(existing === undefined
          ? { ConditionExpression: "attribute_not_exists(pk)" }
          : { ConditionExpression: "#version = :version AND #orgId = :holder", ExpressionAttributeNames: { "#version": "version", "#orgId": "orgId" }, ExpressionAttributeValues: { ":version": existing.version, ":holder": existing.orgId } }),
      },
    },
    { Put: { TableName: deps.tableName, Item: { ...pointerKey(input.orgId, input.domain), entityType: "COMPANY_DOMAIN_POINTER", orgId: input.orgId, domain: input.domain, claimedAt: claim.claimedAt } } },
    ...(existing === undefined ? [] : [{ Delete: { TableName: deps.tableName, Key: pointerKey(existing.orgId, input.domain) } }]),
    ...audited.items,
  ];
  try {
    await send(deps, new TransactWriteCommand({ TransactItems: items }));
  } catch (error) {
    if (isCancellation(error)) throw agentXError("COMPANY_DOMAIN_TAKEN", COMPANY_DOMAIN_TAKEN_MESSAGE);
    throw error;
  }
  await flushAuditEvents(auditDeps(deps), audited.events);
  return { claim, created: true, tookOver };
}

/** Removes the company's own claim. A domain the company does not hold is NOT_FOUND, whoever else holds it: nothing of another company's is touched. */
export async function removeCompanyDomain(deps: CompanyDomainDeps, input: { orgId: OrgId; by: string; domain: string }): Promise<void> {
  const claim = await getClaim(deps, input.domain);
  if (claim === undefined || claim.orgId !== input.orgId) throw agentXError("NOT_FOUND", "That domain is not one of your company's.");
  const at = iso(deps.now());
  const audited = await auditedWrite(auditDeps(deps), () => [auditCompanyDomainRemoved({
    orgId: input.orgId, actor: actorOf(input.by), occurredAt: at, occurrence: auditOccurrence(input.domain, claim.claimedAt), domain: input.domain, wasState: claim.state,
  })]);
  try {
    await send(deps, new TransactWriteCommand({ TransactItems: [
      { Delete: { TableName: deps.tableName, Key: claimKey(input.domain), ConditionExpression: "#orgId = :org AND #version = :version", ExpressionAttributeNames: { "#orgId": "orgId", "#version": "version" }, ExpressionAttributeValues: { ":org": input.orgId, ":version": claim.version } } },
      { Delete: { TableName: deps.tableName, Key: pointerKey(input.orgId, input.domain) } },
      ...audited.items,
    ] }));
  } catch (error) {
    if (isCancellation(error)) throw agentXError("CHANGE_STALE", "This domain changed while you were removing it. Reload and try again.");
    throw error;
  }
  await flushAuditEvents(auditDeps(deps), audited.events);
}

// ---- checking

/** What a lookup comes to for this claim: the token is found only as a whole record, `rovara-verify=<token>`, with nothing before or after (surrounding space is ignored). */
export function resultOf(lookup: TxtLookup, token: string): CompanyDomainCheckResult {
  if (lookup.kind === "unavailable") return "unavailable";
  if (lookup.kind === "indirect") return "indirect";
  if (lookup.kind === "absent") return "not_found";
  const wanted = recordValue(token);
  return lookup.records.some((record) => record.trim() === wanted) ? "found" : "not_found";
}

export type Transition = { kind: "verified"; wasState: "pending" | "lost" } | { kind: "lost"; missingDays: number };

/** The claim after a check, and what it turned into (if it changed state). Pure: the clock and the result are arguments. */
export function applyCheck(claim: ClaimRecord, result: CompanyDomainCheckResult, at: number): { next: ClaimRecord; transition?: Transition } {
  const base: ClaimRecord = { ...claim, version: claim.version + 1, lastCheckedAt: iso(at), lastResult: result };
  const finish = (next: ClaimRecord, failed: boolean, transition?: Transition) => {
    const { dispatchDuePk: _pk, dispatchDueSk: _sk, ...rest } = next;
    void _pk; void _sk;
    const due = nextCheckAt(rest, at, failed);
    const withDue: ClaimRecord = { ...rest, ...dueAttributes(claim.domain, due) };
    return transition === undefined ? { next: withDue } : { next: withDue, transition };
  };
  if (result === "unavailable") return finish(base, true);
  if (result === "found") {
    const { missingSince: _m, lostAt: _l, ...rest } = base;
    void _m; void _l;
    if (claim.state === "verified") return finish(rest, false);
    return finish({ ...rest, state: "verified", verifiedAt: iso(at) }, false, { kind: "verified", wasState: claim.state });
  }
  // Not found, or behind an alias: the record is not where it must be.
  if (claim.state !== "verified") return finish(base, false);
  const since = claim.missingSince ?? iso(at);
  const gone = at - Date.parse(since);
  if (gone >= COMPANY_DOMAIN_LOST_AFTER_DAYS * DAY_MS) return finish({ ...base, state: "lost", missingSince: since, lostAt: iso(at) }, false, { kind: "lost", missingDays: Math.floor(gone / DAY_MS) });
  return finish({ ...base, missingSince: since }, false);
}

export interface CheckOutcome { claim: ClaimRecord; result: CompanyDomainCheckResult; changed: boolean }

/** Looks at the record and writes what it found. `by` is the person who pressed Check now, or "system" for the daily run. A claim that changed while the lookup ran is returned as it now is. */
export async function checkClaim(deps: CompanyDomainDeps, claim: ClaimRecord, resolver: TxtResolver, by: string): Promise<CheckOutcome> {
  const lookup = await resolver.lookupTxt(verificationRecordName(claim.domain)).catch((): TxtLookup => ({ kind: "unavailable" }));
  const at = deps.now();
  const result = resultOf(lookup, claim.token);
  const { next, transition } = applyCheck(claim, result, at);
  const audited = await auditedWrite(auditDeps(deps), () => {
    if (transition === undefined) return [];
    const base = { orgId: claim.orgId, actor: actorOf(by), occurredAt: iso(at), occurrence: auditOccurrence(claim.domain, claim.claimedAt, iso(at)), domain: claim.domain };
    return [transition.kind === "verified" ? auditCompanyDomainVerified({ ...base, wasState: transition.wasState }) : auditCompanyDomainLost({ ...base, actor: SYSTEM_ACTOR, missingDays: transition.missingDays })];
  });
  try {
    await send(deps, new TransactWriteCommand({ TransactItems: [
      { Put: { TableName: deps.tableName, Item: next, ConditionExpression: "#version = :version AND #orgId = :org", ExpressionAttributeNames: { "#version": "version", "#orgId": "orgId" }, ExpressionAttributeValues: { ":version": claim.version, ":org": claim.orgId } } },
      ...audited.items,
    ] }));
  } catch (error) {
    if (!isCancellation(error)) throw error;
    const current = await getClaim(deps, claim.domain);
    return { claim: current ?? claim, result, changed: false };
  }
  await flushAuditEvents(auditDeps(deps), audited.events);
  return { claim: next, result, changed: true };
}

/** The company's claim for a domain, checked now. NOT_FOUND for a domain the company does not hold. */
export async function checkCompanyDomain(deps: CompanyDomainDeps, input: { orgId: OrgId; by: string; domain: string; resolver: TxtResolver }): Promise<CheckOutcome> {
  const claim = await getClaim(deps, input.domain);
  if (claim === undefined || claim.orgId !== input.orgId) throw agentXError("NOT_FOUND", "That domain is not one of your company's.");
  return checkClaim(deps, claim, input.resolver, input.by);
}

// ---- the daily re-check

export interface RecheckOutcome { checked: number; verified: number; lost: number; released: number; skipped: number }

/**
 * Looks at the domains that are due, oldest first, at most `limit` and while `budgetMs` lasts. A domain of a closed company is released instead (its claim and pointer go). A row read just as it
 * changed is skipped: the version holds the write.
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
    const claim = readClaim(row);
    if (claim === undefined) { outcome.skipped += 1; continue; }
    try {
      if (await orgClosed(deps, claim.orgId)) {
        await send(deps, new TransactWriteCommand({ TransactItems: [
          { Delete: { TableName: deps.tableName, Key: claimKey(claim.domain), ConditionExpression: "#version = :version", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":version": claim.version } } },
          { Delete: { TableName: deps.tableName, Key: pointerKey(claim.orgId, claim.domain) } },
        ] }));
        outcome.released += 1;
        continue;
      }
      // The index is eventually consistent: the claim itself says whether it is still due.
      const fresh = await getClaim(deps, claim.domain);
      if (fresh === undefined || fresh.dispatchDueSk === undefined || fresh.dispatchDueSk > `${dueKey(deps.now())}~`) { outcome.skipped += 1; continue; }
      const checked = await checkClaim(deps, fresh, options.resolver, "system");
      if (!checked.changed) { outcome.skipped += 1; continue; }
      outcome.checked += 1;
      if (checked.claim.state !== fresh.state) outcome[checked.claim.state === "verified" ? "verified" : "lost"] += 1;
    } catch (error) {
      if (!isCancellation(error)) console.log(JSON.stringify({ component: "broker", event: "company_domain.recheck_failed", error: error instanceof Error ? error.name : "unknown" }));
      outcome.skipped += 1;
    }
  }
  return outcome;
}

// ---- the question other code asks

/**
 * Whether `emailDomain` (an address's domain, or an address) is a domain the company has verified. Exactly that domain: a subdomain of a verified domain is not, and neither is a domain
 * that only looks like one. A pending or lost domain does not count, and neither does a domain another company holds.
 */
export async function isVerifiedCompanyDomain(deps: Pick<CompanyDomainDeps, "documentClient" | "tableName">, orgId: OrgId, emailDomain: string): Promise<boolean> {
  const domain = normalizeEmailDomain(emailDomain);
  if (domain === undefined) return false;
  const claim = await getClaim({ ...deps, now: Date.now }, domain);
  return claim !== undefined && claim.orgId === orgId && claim.state === "verified";
}
