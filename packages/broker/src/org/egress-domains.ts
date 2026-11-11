// Plan 2, Task 18: egress items. One item per owner (a project, or a Plan 3 model source) holds the domains it asks for and what was decided
// about each. On Rovara Cloud a new domain is `pending` until Rovara staff approve it, because the DNS firewall serves one cell-wide union;
// anywhere else the union is one org's list, so a domain is approved when it is saved. Every request, decision and removal is written as an
// audit item in the same transaction as the change; those items never expire. Every write is conditional on the `updatedAt` it read, so a save
// cannot overwrite a staff decision made meanwhile (and a decision cannot overwrite a save).
import { createHash, randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { auditEgressDecided, auditOccurrence } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, type AuditRuntime } from "../audit/outbox.js";
import { EGRESS_ALL_ORGS_SK_PREFIX, EGRESS_AUDIT_PK, EGRESS_CONFLICT_MESSAGE, EGRESS_DOMAINS_PK, EGRESS_SYNC_KEY, EGRESS_SYNC_PENDING_WARNING, ALLOWED_DOMAIN_MESSAGE, EgressDomainsItemSchema, AgentXError, agentXError, egressDomainsKey, egressNotPendingMessage, egressOrgSkPrefix, egressPendingWarning, isAllowedDomain, projectMetaKey, egressRejectedWarning, type EgressAuditAction, type EgressDomainEntry, type EgressDomainsItem, type EgressOwner, type OrgId, type OrgKey } from "@rovara-code/contracts";
import { BROAD_ALLOWED_DOMAIN_MESSAGE, isBroadAllowedDomain, type AuditActor } from "@agentx/cloud-contracts";
import { type AuditEventInput } from "@agentx/cloud-contracts";
import { readRequestRecord, requestRecordPut, requireSameRequest, type RequestTransactItem } from "./request-records.js";

export interface EgressDomainsDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Rovara Cloud: a new domain waits for staff. Anywhere else it is approved when it is saved. */
  cloud: boolean;
  now: () => Date;
  /** Waits before a retry; tests pass a quick one. */
  sleep?: (milliseconds: number) => Promise<void>;
  /** Pushes the approved union to the DNS firewall (Task 19's `syncCellAllowList`, wired by the broker). `{ ok: false }` leaves the marker dirty for the schedule. */
  sync: () => Promise<{ ok: boolean; domains?: number }>;
  /** The Audit Ledger's outbox (Task 18): a staff decision is recorded in the transaction that makes it. Absent on a legacy install. */
  audit?: AuditRuntime;
}

type Reader = Pick<EgressDomainsDependencies, "documentClient" | "tableName">;
type Actor = { kind: "developer" | "operator"; id: string };

/** Who the audit names when no person made the change (an org closing). */
const SYSTEM_ACTOR: Actor = { kind: "operator", id: "system" };
/** A transaction holds 100 actions: the item itself and the sync marker leave the rest for audit items. */
const TRANSACTION_ACTIONS = 100;

interface AuditDraft { orgId: OrgId; owner: EgressOwner; domain: string; action: EgressAuditAction; actor: Actor; reason?: string }
interface Plan<T> {
  /** The item to write, `"delete"` to remove it, or undefined when nothing is stored differently. */
  next?: EgressDomainsItem | "delete";
  /** Items that commit with the change and fail it with them: a request record (final review M2). Counted against the transaction's 100 actions. */
  extra?: RequestTransactItem[];
  audits: AuditDraft[];
  /** Whether the domains the firewall serves change. */
  dirty: boolean;
  /** Audit events that commit with the change (each as a pending item in the same transaction). */
  events?: AuditEventInput[];
  result: T;
}

/** How a cancelled transaction reads: a condition on the item failed (someone changed it), or something else did (a concurrent transaction on the shared sync marker, throttling). */
function cancellation(error: unknown): "changed" | "other" | undefined {
  if (!(error instanceof Error) || error.name !== "TransactionCanceledException") return undefined;
  const reasons = (error as { CancellationReasons?: Array<{ Code?: string }> }).CancellationReasons;
  // A cancellation that names no reasons is taken for a failed condition, the safe reading.
  return reasons === undefined || reasons.some((reason) => reason.Code === "ConditionalCheckFailed") ? "changed" : "other";
}

const defaultSleep = (milliseconds: number) => new Promise<void>((resolve) => { setTimeout(resolve, milliseconds); });

/** The attempts a write gets: one retry after the item changed under it, and a few more for cancellations that were not about the item. */
const MAX_ATTEMPTS = 4;

function parseItem(raw: unknown): EgressDomainsItem | undefined {
  if (raw === undefined) return undefined;
  const parsed = EgressDomainsItemSchema.safeParse(raw);
  if (!parsed.success) throw agentXError("RUNTIME_UNAVAILABLE", "an egress item could not be read");
  return parsed.data;
}

/** The stored item for one owner, read consistently; undefined when the owner has none. */
export async function readEgressDomains(deps: Reader, orgId: OrgId, owner: EgressOwner): Promise<EgressDomainsItem | undefined> {
  return readItem(deps, egressDomainsKey(orgId, owner));
}

async function readItem(deps: Reader, key: OrgKey): Promise<EgressDomainsItem | undefined> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: unknown };
  return parseItem(response.Item);
}

/**
 * Reads the item, plans the change, and writes it with its audit items in one transaction that holds only while the item is as it was read.
 * A refused condition (the item changed) reads again and plans again, once; a second refusal is CHANGE_STALE, as for the other concurrent edits (member roles, the org's members). A cancellation for any
 * other reason (a concurrent transaction on the shared sync marker, throttling) is retried quietly and, if it persists, is RUNTIME_UNAVAILABLE:
 * it says nothing about the allowed domains having changed. `updatedAt` always moves forward, so two writes in one millisecond are never taken for one.
 */
async function mutate<T>(
  deps: EgressDomainsDependencies,
  key: OrgKey,
  planFor: (current: EgressDomainsItem | undefined, at: string, ownerActive: boolean) => Plan<T>,
  /** The owner's own record (a project's META), whose archived status decides whether a NEW item starts active. Read on each attempt and guarded in the transaction. */
  ownerRecord?: OrgKey,
): Promise<{ result: T; dirty: boolean; changed: boolean; events: AuditEventInput[] }> {
  let changedUnderUs = 0;
  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt += 1) {
    const current = await readItem(deps, key);
    const at = new Date(Math.max(deps.now().getTime(), current === undefined ? 0 : Date.parse(current.updatedAt) + 1)).toISOString();
    // A new item for an archived owner starts inactive. The status is checked again in the transaction itself, so an archive or a restore that lands
    // between this read and the write refuses the write and the next attempt reads it afresh (the archive's own flip finds no item to flip).
    const archived = ownerRecord !== undefined && current === undefined && await readOwnerArchived(deps, ownerRecord);
    const plan = planFor(current, at, !archived);
    if (plan.next === undefined) return { result: plan.result, dirty: false, changed: false, events: [] };
    const condition = current === undefined
      ? { ConditionExpression: "attribute_not_exists(pk)" }
      : { ConditionExpression: "updatedAt = :read", ExpressionAttributeValues: { ":read": current.updatedAt } };
    const audits = plan.audits.map((audit) => ({
      Put: { TableName: deps.tableName, Item: { pk: EGRESS_AUDIT_PK, sk: `${at}#${randomUUID()}`, entityType: "EGRESS_AUDIT", ...audit, at } },
    }));
    const marker = plan.dirty ? [{
      Update: {
        TableName: deps.tableName, Key: EGRESS_SYNC_KEY,
        // `dirtySeq` counts changes, so the sync clears exactly the changes it read: `dirtyAt` can repeat across two items in one millisecond.
        UpdateExpression: "SET dirtyAt = :dirtyAt, entityType = :entity, dirtySeq = if_not_exists(dirtySeq, :zero) + :one",
        ExpressionAttributeValues: { ":dirtyAt": at, ":entity": "EGRESS_SYNC", ":zero": 0, ":one": 1 },
      },
    }] : [];
    const write = plan.next === "delete"
      ? { Delete: { TableName: deps.tableName, Key: key, ...condition } }
      : { Put: { TableName: deps.tableName, Item: { ...key, entityType: "EGRESS_DOMAINS", ...plan.next }, ...condition } };
    const ownerCheck = ownerRecord !== undefined && current === undefined ? [{
      ConditionCheck: {
        TableName: deps.tableName, Key: ownerRecord,
        ConditionExpression: archived ? "#status = :archived" : "attribute_not_exists(pk) OR #status <> :archived",
        ExpressionAttributeNames: { "#status": "status" },
        ExpressionAttributeValues: { ":archived": "archived" },
      },
    }] : [];
    const pending = (plan.events ?? []).flatMap((event) => auditPending(deps, event));
    const extra = plan.extra ?? [];
    const room = TRANSACTION_ACTIONS - 1 - marker.length - ownerCheck.length - extra.length - pending.length;
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [write, ...marker, ...ownerCheck, ...extra, ...pending, ...audits.slice(0, room)] }));
    } catch (error) {
      const reason = cancellation(error);
      if (reason === undefined) throw error;
      if (reason === "changed") {
        changedUnderUs += 1;
        if (changedUnderUs >= 2) throw agentXError("CHANGE_STALE", EGRESS_CONFLICT_MESSAGE);
      }
      // Not about the item (a concurrent transaction on the shared sync marker, throttling): a short, jittered wait makes the retry likelier to hold.
      if (reason === "other" && attempt < MAX_ATTEMPTS - 1) await (deps.sleep ?? defaultSleep)(Math.round(50 * (attempt + 1) * (0.5 + Math.random())));
      continue;
    }
    // More audit items than one transaction holds (replacing most of a 50-domain list): the change stands, the rest follow.
    for (let start = room; start < audits.length; start += TRANSACTION_ACTIONS) {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: audits.slice(start, start + TRANSACTION_ACTIONS) }));
    }
    return { result: plan.result, dirty: plan.dirty, changed: true, events: plan.events ?? [] };
  }
  throw agentXError("RUNTIME_UNAVAILABLE", "the allowed domains could not be saved just now; try again");
}

async function readOwnerArchived(deps: Reader, key: OrgKey): Promise<boolean> {
  const response = await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: { status?: unknown } };
  return response.Item?.status === "archived";
}

/** Asks the firewall to follow; a failure (or a throw) leaves the marker dirty for the schedule, and the caller is told. */
async function syncNow(deps: EgressDomainsDependencies): Promise<{ warning?: string }> {
  let ok = false;
  try {
    ok = (await deps.sync()).ok;
  } catch (error) {
    console.log(JSON.stringify({ component: "broker", event: "egress.sync_failed", error: error instanceof Error ? error.name : "UnknownError" }));
  }
  return ok ? {} : { warning: EGRESS_SYNC_PENDING_WARNING };
}

const log = (event: string, fields: Record<string, unknown>) => console.log(JSON.stringify({ component: "broker", event: `egress.${event}`, ...fields }));

/**
 * Makes the owner's domains exactly `domains`. It validates each one itself with `isAllowedDomain` and refuses the lot (CONFIG_INVALID) if any fails. A domain already stored keeps its
 * status; a new one is `pending` on cloud and `approved` (audited `auto_approved`) elsewhere; one no longer listed is dropped (audited
 * `removed`). A release is `putEgressDomains(..., [])`. Syncs when the served domains changed; `{ ok: false }` is `warning`.
 */
export async function putEgressDomains(
  deps: EgressDomainsDependencies,
  orgId: OrgId,
  owner: EgressOwner,
  domains: readonly string[],
  actor?: { developerId: string },
): Promise<{ warning?: string; pending: string[] }> {
  const who: Actor = actor === undefined ? SYSTEM_ACTOR : { kind: "developer", id: actor.developerId };
  const wanted = [...new Set(domains)];
  // Whatever the caller, a domain the firewall must never serve (`*`, a bare TLD, a public suffix, a trailing dot, upper case, not ASCII) is refused
  // here, before anything is stored or any staff member is asked about it. The value is not repeated: a refusal reaches logs and screens.
  const refused = wanted.findIndex((domain) => !isAllowedDomain(domain));
  if (refused !== -1) throw agentXError("CONFIG_INVALID", `allowedDomains.${String(refused)}: ${ALLOWED_DOMAIN_MESSAGE}`);
  // One owner's approval is cell-wide: a wildcard over AWS or GitHub names would reopen what the default list closed for every sandbox.
  const broad = wanted.findIndex(isBroadAllowedDomain);
  if (broad !== -1) throw agentXError("CONFIG_INVALID", `allowedDomains.${String(broad)}: ${BROAD_ALLOWED_DOMAIN_MESSAGE}`);
  const { result, dirty } = await mutate(deps, egressDomainsKey(orgId, owner), (current, at, ownerActive): Plan<string[]> => {
    const stored = current?.domains ?? [];
    const entries: EgressDomainEntry[] = [];
    const audits: AuditDraft[] = [];
    let served = false;
    for (const domain of wanted) {
      const existing = stored.find((entry) => entry.domain === domain);
      if (existing !== undefined) { entries.push(existing); continue; }
      const approved = !deps.cloud;
      entries.push({ domain, status: approved ? "approved" : "pending", requestedAt: at, requestedBy: who.id, ...(approved ? { decidedAt: at } : {}) });
      audits.push({ orgId, owner, domain, action: approved ? "auto_approved" : "requested", actor: who });
      served ||= approved;
    }
    for (const entry of stored) {
      if (wanted.includes(entry.domain)) continue;
      audits.push({ orgId, owner, domain: entry.domain, action: "removed", actor: who });
      served ||= entry.status === "approved";
    }
    const pending = entries.filter((entry) => entry.status === "pending").map((entry) => entry.domain);
    if (audits.length === 0) return { audits, dirty: false, result: pending };
    const active = current?.active ?? ownerActive;
    return { next: { orgId, owner, active, domains: entries, updatedAt: at }, audits, dirty: served && active, result: pending };
  }, owner.kind === "project" ? projectMetaKey(orgId, owner.project) : undefined);
  if (!dirty) return { pending: result };
  log("domains_changed", { orgId, owner });
  return { ...await syncNow(deps), pending: result };
}

/** Archive (false) and restore (true) flip `active`: an inactive item leaves the union and keeps its approvals. An owner with no item has nothing to flip. `warning` is set when the firewall could not be told at once (the schedule finishes it). */
export async function setEgressOwnerActive(deps: EgressDomainsDependencies, orgId: OrgId, owner: EgressOwner, active: boolean): Promise<{ warning?: string }> {
  const { dirty } = await mutate(deps, egressDomainsKey(orgId, owner), (current, at): Plan<undefined> => {
    if (current === undefined || current.active === active) return { audits: [], dirty: false, result: undefined };
    return { next: { ...current, active, updatedAt: at }, audits: [], dirty: current.domains.some((entry) => entry.status === "approved"), result: undefined };
  });
  return dirty ? syncNow(deps) : {};
}

/** Where a staff decision's request id is remembered: its own partition, under a prefix no egress query reads. */
export const EGRESS_DECISION_REQUEST_PK = "EGRESS_DECISION_REQUEST";
const decisionRequestKey = (requestId: string): OrgKey => ({ pk: EGRESS_DECISION_REQUEST_PK, sk: requestId });

/**
 * Staff decide one pending domain: `pending` becomes `approved` or `rejected`, audited with the operator's identity. With a ledger the decision
 * is also recorded in the audit chain, in the same transaction: `auditActor` names the staff member by their pseudonym (never the subject), and
 * `requestId` is the request's id, which with the domain and the owner makes the occurrence. By the one request-id
 * pattern (`request-records`): the decision and the operator's request record are one transaction; a repeat of the id by the same operator for
 * the same decision answers `replayed: true` and writes nothing (even when the domain has been changed since); another operator's use of the id,
 * or the same id for another decision, is IDEMPOTENCY_CONFLICT.
 */
export async function decideEgressDomain(
  deps: EgressDomainsDependencies,
  input: { requestId?: string; orgId: OrgId; owner: EgressOwner; domain: string; decision: "approved" | "rejected"; operatorId: string; reason?: string; auditActor?: AuditActor },
): Promise<{ warning?: string; replayed?: boolean }> {
  const { orgId, owner, domain, decision, operatorId } = input;
  const key = decisionRequestKey(input.requestId ?? "");
  const bodyHash = createHash("sha256").update(JSON.stringify([orgId, egressDomainsKey(orgId, owner).sk, domain, decision, input.reason ?? null]), "utf8").digest("hex");
  // The staff route always has the client's id; a caller inside the broker with none records nothing.
  const recorded = input.requestId !== undefined;
  const replay = async (): Promise<boolean> => {
    if (!recorded) return false;
    const stored = await readRequestRecord(deps.documentClient, deps.tableName, key, deps.now().getTime());
    if (stored === undefined) return false;
    requireSameRequest(stored, { by: operatorId, bodyHash });
    return true;
  };
  if (await replay()) return { replayed: true };
  let outcome: { dirty: boolean; events: AuditEventInput[] };
  try {
    outcome = await mutate(deps, egressDomainsKey(orgId, owner), (current, at): Plan<undefined> => {
      const entry = current?.domains.find((candidate) => candidate.domain === domain);
      if (current === undefined || entry === undefined || entry.status !== "pending") throw agentXError("CONFIG_INVALID", egressNotPendingMessage(domain));
      const decided: EgressDomainEntry = { ...entry, status: decision, decidedAt: at, decidedBy: operatorId, ...(decision === "rejected" && input.reason !== undefined ? { reason: input.reason } : {}) };
      return {
        next: { ...current, domains: current.domains.map((candidate) => (candidate === entry ? decided : candidate)), updatedAt: at },
        ...(recorded ? { extra: [requestRecordPut(deps.tableName, key, "EGRESS_DECISION_REQUEST", { by: operatorId, bodyHash }, deps.now().getTime())] } : {}),
        audits: [{ orgId, owner, domain, action: decision, actor: { kind: "operator", id: operatorId }, ...(decided.reason === undefined ? {} : { reason: decided.reason }) }],
        dirty: decision === "approved" && current.active,
        events: decisionEvents(deps, input, entry.requestedAt, at, decided.reason),
        result: undefined,
      };
    });
  } catch (error) {
    // The same request, sent twice together, decided the domain first: it is then a replay.
    if (error instanceof AgentXError && (error.code === "CONFIG_INVALID" || error.code === "CHANGE_STALE") && await replay()) return { replayed: true };
    throw error;
  }
  log(decision === "approved" ? "domain_approved" : "domain_rejected", { orgId, owner, operatorId });
  await flushAuditEvents(deps, outcome.events);
  return outcome.dirty ? syncNow(deps) : {};
}

/** The project or model source a domain belongs to, for the details of its decision (a name is personal data and stays out of the chain). */
/** The owner as an occurrence part: one request id and domain on another owner is another decision. */
const ownerKey = (owner: EgressOwner): string => (owner.kind === "project" ? `project:${owner.project}` : `model-source:${owner.sourceId}`);

const ownerLabel = (owner: EgressOwner): Record<string, string> => (owner.kind === "project" ? { project: owner.project } : { modelSource: owner.sourceId });

/** The audit event of a staff decision: none on an install with no ledger, and none (logged, without a value) when it cannot be built. */
function decisionEvents(
  deps: EgressDomainsDependencies,
  input: { orgId: OrgId; owner: EgressOwner; domain: string; decision: "approved" | "rejected"; operatorId: string; requestId?: string; auditActor?: AuditActor },
  requestedAt: string,
  at: string,
  reason: string | undefined,
): AuditEventInput[] {
  if (deps.audit === undefined) return [];
  try {
    return [auditEgressDecided({
      orgId: input.orgId, actor: input.auditActor ?? { kind: "system", id: "rovara" }, occurredAt: at,
      // Without a request id (a caller outside the staff route), the domain's own request time makes the occurrence: it is decided once per request.
      occurrence: auditOccurrence(input.requestId ?? requestedAt, input.domain, ownerKey(input.owner)), domain: input.domain, decision: input.decision,
      details: [{ subject: "org", fields: { ...ownerLabel(input.owner), ...(reason === undefined ? {} : { reason }) } }],
    })];
  } catch (error) {
    try { deps.audit.log({ event: "audit.record_invalid", level: "error", reason: "builder_failed", error: error instanceof Error ? error.name : "unknown" }); } catch { /* nothing more can be done */ }
    return [];
  }
}

async function pagesOf(deps: Reader, prefix: string): Promise<EgressDomainsItem[]> {
  const items: EgressDomainsItem[] = [];
  let start: Record<string, unknown> | undefined;
  do {
    const page = await deps.documentClient.send(new QueryCommand({
      TableName: deps.tableName,
      KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)",
      ExpressionAttributeValues: { ":pk": EGRESS_DOMAINS_PK, ":prefix": prefix },
      ConsistentRead: true,
      ...(start === undefined ? {} : { ExclusiveStartKey: start }),
    })) as { Items?: unknown[]; LastEvaluatedKey?: Record<string, unknown> };
    for (const raw of page.Items ?? []) items.push(parseItem(raw)!);
    start = page.LastEvaluatedKey;
  } while (start !== undefined);
  return items;
}

/** Every egress item of every org (the scheduled reconcile reads them to compare each project's item with its META). */
export async function listEgressItems(deps: Reader): Promise<EgressDomainsItem[]> {
  return pagesOf(deps, EGRESS_ALL_ORGS_SK_PREFIX);
}

/** The approved domains of every active item, sorted and without repeats: what the DNS firewall layer serves. */
export async function approvedUnion(deps: Reader): Promise<string[]> {
  const items = await pagesOf(deps, EGRESS_ALL_ORGS_SK_PREFIX);
  return [...new Set(items.filter((item) => item.active).flatMap((item) => item.domains.filter((entry) => entry.status === "approved").map((entry) => entry.domain)))].sort();
}

export interface PendingEgress { orgId: OrgId; owner: EgressOwner; domain: string; requestedAt: string; requestedBy: string }

/** What waits for staff, oldest first, across every org. An archived owner's requests wait for its restore. */
export async function listPendingEgress(deps: Reader): Promise<PendingEgress[]> {
  const items = await pagesOf(deps, EGRESS_ALL_ORGS_SK_PREFIX);
  return items.filter((item) => item.active)
    .flatMap((item) => item.domains.filter((entry) => entry.status === "pending").map((entry) => ({ orgId: item.orgId, owner: item.owner, domain: entry.domain, requestedAt: entry.requestedAt, requestedBy: entry.requestedBy })))
    .sort((left, right) => left.requestedAt.localeCompare(right.requestedAt) || left.domain.localeCompare(right.domain));
}

/** Closing an org: deletes every item of that org (and only that org's), audited as `removed`, then syncs when the served domains changed. */
export async function clearOrgEgress(deps: EgressDomainsDependencies, orgId: OrgId): Promise<void> {
  let dirty = false;
  for (const listed of await pagesOf(deps, egressOrgSkPrefix(orgId))) {
    const key = egressDomainsKey(orgId, listed.owner);
    const outcome = await mutate(deps, key, (current): Plan<undefined> => {
      if (current === undefined) return { audits: [], dirty: false, result: undefined };
      return {
        next: "delete",
        audits: current.domains.map((entry) => ({ orgId, owner: current.owner, domain: entry.domain, action: "removed" as const, actor: SYSTEM_ACTOR })),
        dirty: current.active && current.domains.some((entry) => entry.status === "approved"),
        result: undefined,
      };
    });
    dirty ||= outcome.dirty;
  }
  if (dirty) await syncNow(deps);
}

/** The warnings a settings response carries for the domains an owner listed: each one waiting for staff, each one they refused. */
export function egressStatusWarnings(item: EgressDomainsItem | undefined, listed: readonly string[]): string[] {
  const warnings: string[] = [];
  for (const domain of listed) {
    const entry = item?.domains.find((candidate) => candidate.domain === domain);
    if (entry?.status === "pending") warnings.push(egressPendingWarning(domain));
    if (entry?.status === "rejected") warnings.push(egressRejectedWarning(domain, entry.reason));
  }
  return warnings;
}
