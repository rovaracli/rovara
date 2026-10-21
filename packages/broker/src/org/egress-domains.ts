// Plan 2, Task 18: egress items. One item per owner (a project, or a Plan 3 model source) holds the domains it asks for and what was decided
// about each. On Rovara Cloud a new domain is `pending` until Rovara staff approve it, because the DNS firewall serves one cell-wide union;
// anywhere else the union is one org's list, so a domain is approved when it is saved. Every request, decision and removal is written as an
// audit item in the same transaction as the change; those items never expire. Every write is conditional on the `updatedAt` it read, so a save
// cannot overwrite a staff decision made meanwhile (and a decision cannot overwrite a save).
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import {
  EGRESS_ALL_ORGS_SK_PREFIX,
  EGRESS_AUDIT_PK,
  EGRESS_CONFLICT_MESSAGE,
  EGRESS_DOMAINS_PK,
  EGRESS_SYNC_KEY,
  EGRESS_SYNC_PENDING_WARNING,
  EgressDomainsItemSchema,
  agentXError,
  egressDomainsKey,
  egressNotPendingMessage,
  egressOrgSkPrefix,
  egressPendingWarning,
  egressRejectedWarning,
  type EgressAuditAction,
  type EgressDomainEntry,
  type EgressDomainsItem,
  type EgressOwner,
  type OrgId,
  type OrgKey,
} from "@agentx/contracts";

export interface EgressDomainsDependencies {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** Rovara Cloud: a new domain waits for staff. Anywhere else it is approved when it is saved. */
  cloud: boolean;
  now: () => Date;
  /** Pushes the approved union to the DNS firewall (Task 19's `syncCellAllowList`). `{ ok: false }` leaves the marker dirty for the schedule. */
  sync: () => Promise<{ ok: boolean }>;
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
  audits: AuditDraft[];
  /** Whether the domains the firewall serves change. */
  dirty: boolean;
  result: T;
}

const cancelled = (error: unknown) => error instanceof Error && error.name === "TransactionCanceledException";

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
 * A refused condition reads again and plans again, once; a second refusal is IDEMPOTENCY_CONFLICT. `updatedAt` always moves forward, so two
 * writes in one millisecond are never taken for one.
 */
async function mutate<T>(
  deps: EgressDomainsDependencies,
  key: OrgKey,
  planFor: (current: EgressDomainsItem | undefined, at: string) => Plan<T>,
): Promise<{ result: T; dirty: boolean; changed: boolean }> {
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const current = await readItem(deps, key);
    const at = new Date(Math.max(deps.now().getTime(), current === undefined ? 0 : Date.parse(current.updatedAt) + 1)).toISOString();
    const plan = planFor(current, at);
    if (plan.next === undefined) return { result: plan.result, dirty: false, changed: false };
    const condition = current === undefined
      ? { ConditionExpression: "attribute_not_exists(pk)" }
      : { ConditionExpression: "updatedAt = :read", ExpressionAttributeValues: { ":read": current.updatedAt } };
    const audits = plan.audits.map((audit) => ({
      Put: { TableName: deps.tableName, Item: { pk: EGRESS_AUDIT_PK, sk: `${at}#${randomUUID()}`, entityType: "EGRESS_AUDIT", ...audit, at } },
    }));
    const marker = plan.dirty ? [{
      Update: {
        TableName: deps.tableName, Key: EGRESS_SYNC_KEY,
        UpdateExpression: "SET dirtyAt = :dirtyAt, entityType = :entity",
        ExpressionAttributeValues: { ":dirtyAt": at, ":entity": "EGRESS_SYNC" },
      },
    }] : [];
    const write = plan.next === "delete"
      ? { Delete: { TableName: deps.tableName, Key: key, ...condition } }
      : { Put: { TableName: deps.tableName, Item: { ...key, entityType: "EGRESS_DOMAINS", ...plan.next }, ...condition } };
    const room = TRANSACTION_ACTIONS - 1 - marker.length;
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [write, ...marker, ...audits.slice(0, room)] }));
    } catch (error) {
      if (cancelled(error) && attempt === 0) continue;
      if (cancelled(error)) throw agentXError("IDEMPOTENCY_CONFLICT", EGRESS_CONFLICT_MESSAGE);
      throw error;
    }
    // More audit items than one transaction holds (replacing most of a 50-domain list): the change stands, the rest follow.
    for (let start = room; start < audits.length; start += TRANSACTION_ACTIONS) {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: audits.slice(start, start + TRANSACTION_ACTIONS) }));
    }
    return { result: plan.result, dirty: plan.dirty, changed: true };
  }
  throw agentXError("IDEMPOTENCY_CONFLICT", EGRESS_CONFLICT_MESSAGE);
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
 * Makes the owner's domains exactly `domains` (callers validate each host with `AllowedDomainSchema` first). A domain already stored keeps its
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
  const { result, dirty } = await mutate(deps, egressDomainsKey(orgId, owner), (current, at): Plan<string[]> => {
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
    const active = current?.active ?? true;
    return { next: { orgId, owner, active, domains: entries, updatedAt: at }, audits, dirty: served && active, result: pending };
  });
  if (!dirty) return { pending: result };
  log("domains_changed", { orgId, owner });
  return { ...await syncNow(deps), pending: result };
}

/** Archive (false) and restore (true) flip `active`: an inactive item leaves the union and keeps its approvals. An owner with no item has nothing to flip. */
export async function setEgressOwnerActive(deps: EgressDomainsDependencies, orgId: OrgId, owner: EgressOwner, active: boolean): Promise<void> {
  const { dirty } = await mutate(deps, egressDomainsKey(orgId, owner), (current, at): Plan<undefined> => {
    if (current === undefined || current.active === active) return { audits: [], dirty: false, result: undefined };
    return { next: { ...current, active, updatedAt: at }, audits: [], dirty: current.domains.some((entry) => entry.status === "approved"), result: undefined };
  });
  if (dirty) await syncNow(deps);
}

/** Staff decide one pending domain: `pending` becomes `approved` or `rejected`, audited with the operator's identity. */
export async function decideEgressDomain(
  deps: EgressDomainsDependencies,
  input: { orgId: OrgId; owner: EgressOwner; domain: string; decision: "approved" | "rejected"; operatorId: string; reason?: string },
): Promise<{ warning?: string }> {
  const { orgId, owner, domain, decision, operatorId } = input;
  const { dirty } = await mutate(deps, egressDomainsKey(orgId, owner), (current, at): Plan<undefined> => {
    const entry = current?.domains.find((candidate) => candidate.domain === domain);
    if (current === undefined || entry === undefined || entry.status !== "pending") throw agentXError("CONFIG_INVALID", egressNotPendingMessage(domain));
    const decided: EgressDomainEntry = { ...entry, status: decision, decidedAt: at, decidedBy: operatorId, ...(decision === "rejected" && input.reason !== undefined ? { reason: input.reason } : {}) };
    return {
      next: { ...current, domains: current.domains.map((candidate) => (candidate === entry ? decided : candidate)), updatedAt: at },
      audits: [{ orgId, owner, domain, action: decision, actor: { kind: "operator", id: operatorId }, ...(decided.reason === undefined ? {} : { reason: decided.reason }) }],
      dirty: decision === "approved" && current.active,
      result: undefined,
    };
  });
  log(decision === "approved" ? "domain_approved" : "domain_rejected", { orgId, owner, operatorId });
  return dirty ? syncNow(deps) : {};
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
