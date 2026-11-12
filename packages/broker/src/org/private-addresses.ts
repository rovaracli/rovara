// Internal addresses a company's tasks may reach (owner decision 123, 0.5.15): the company list, its proposals and the two-person rule. The rule for what an entry may be is the contract's
// (`checkPrivateAddressList`, packages/cloud-contracts/src/app-private-addresses.ts); the wall that lets the entries through is the worker's (boot-stage2.sh `rovara-private-allow`), fed at launch (aws/private-address-launch.ts).
//
//   - PROPOSING a list that ADDS anything opens a proposal that a DIFFERENT live owner or admin approves. There is no sole-owner exception: a company with one admin cannot open its walls alone. The proposal and its audit
//     event are one transaction; with no audit ledger nothing is proposed (a loosening needs its record).
//   - A list that only REMOVES entries is the stricter side: applied at once by one live owner or admin, fenced on their authority, audited when a ledger exists (an audit outage never blocks closing the wall).
//   - APPROVING is the shared second-person rule (org/second-person-evidence.ts through lessons/tier0-authority.ts, the one the company's sole-owner switch, known-failing policy and allowed domains use): both people's
//     live authority and the company's membership generation are commit conditions of the ONE transaction that writes the list, marks the proposal applied and puts the audit event. The approver names the digest of the
//     list they were shown; a list that moved since the proposal (its revision) refuses the approval.
//   - WITHDRAWING (the proposer, or any admin turning it down) needs a live admin; it is audited when a ledger exists.
// Every entry is checked again at approval against the install as it is then. Answers carry fixed words, counts and the entries an admin already reads; refusals name an entry's position, never its text.
import { randomUUID } from "node:crypto";
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, agentXError, type OrgId } from "@rovara-code/contracts";
import {
  AUDIT_DETAIL_FIELD_MAX_CHARS, PRIVATE_ADDRESSES_MAX, PRIVATE_ADDRESS_RECYCLE_PK, PRIVATE_ADDRESS_PROPOSAL_TTL_MS, checkPrivateAddressList, orgMetaKey, privateAddressListDigest, privateAddressRefusalText,
  type AuditDetailPart, type AuditEventInput, type PrivateAddressInstall,
} from "@agentx/cloud-contracts";
import { auditOccurrence, auditPrivateAddresses, type PrivateAddressesAuditAction } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, type AuditDeps, type TransactItem } from "../audit/outbox.js";
import { trySecondPersonTimed } from "../lessons/approve.js";
import { secondPersonTier0Authority } from "../lessons/tier0-authority.js";
import type { Tier0Authority } from "../lessons/sole-owner-switch.js";
import { idIn, sameId } from "../lessons/types.js";
import { readCompanyAdminActorConditions, type SecondPersonEvidenceDependencies } from "./second-person-evidence.js";

type Item = Record<string, unknown>;
const LIST_SK = "PRIVATEADDR#LIST";
const CHANGE_PREFIX = "PRIVATEADDR#CHANGE#";
const orgPk = (orgId: string): string => orgMetaKey(orgId).pk;
const listKey = (orgId: string) => ({ pk: orgPk(orgId), sk: LIST_SK });
const changeKey = (orgId: string, id: string) => ({ pk: orgPk(orgId), sk: `${CHANGE_PREFIX}${id}` });
const CHANGE_ID = /^[A-Za-z0-9_-]{1,100}$/u;

export const PRIVATE_ADDRESS_WORDS = {
  notAdmin: "Only a company owner or admin can change the internal addresses tasks may reach.",
  stale: "The list changed meanwhile. Reload and try again.",
  open: "A change to this list is already waiting for a different admin. Approve or withdraw it first.",
  secondPerson: "A different owner or admin has to approve this. The person who proposed it cannot approve it, and a company with one admin cannot open its walls alone.",
  audit: "Adding internal addresses needs the audit ledger, which is not available. Nothing was changed.",
  expired: "That proposal expired. Propose it again.",
  notFound: "No such proposal.",
  digest: "The proposal is not the list you were shown. Reload and check it again.",
  membership: "Someone joined or left the company's admins meanwhile, or the proposer is no longer an admin. Reload and approve again, or propose the list again.",
  unavailable: "Rovara could not check who may change this. Try again.",
  nothing: "That is the list already in place.",
  corrupt: "This company's internal address list is stored in a form Rovara can't read, so no worker starts until it is replaced. A company owner or admin saves the list again to replace it.",
} as const;

export interface PrivateAddressList { revision: number; entries: string[]; digest: string; updatedAt?: number }
/** A list as a change reads it: a stored row that does not parse is `corrupt` (its entries count as none, and saving any list replaces it). */
export interface PrivateAddressCurrent extends PrivateAddressList { corrupt?: true }

/** A mark outlives every worker that could have started before it (the 14 day maximum lifetime), then the table's TTL removes it. */
const RECYCLE_MARK_TTL_SECONDS = 15 * 86_400;
/** A proposal row (pending, applied, withdrawn or expired) is removed by the table's TTL this long after it expires. */
const CHANGE_ROW_KEEP_SECONDS = 30 * 86_400;
export interface PrivateAddressChange {
  id: string; orgId: string; entries: string[]; digest: string; baseRevision: number; baseEntries: string[]; proposedBy: string; at: number; expiresAt: number; state: "pending" | "applied" | "withdrawn";
}

export interface PrivateAddressTable { documentClient: { send(command: unknown): Promise<unknown> }; tableName: string }

export interface PrivateAddressDeps extends PrivateAddressTable, AuditDeps {
  /** The company's records, as the shared second-person evidence reads them. */
  evidence: SecondPersonEvidenceDependencies;
  install: PrivateAddressInstall;
  now(): number;
  newId?: () => string;
  /** Tests: replaces the authority built from `evidence`. */
  authority?: Tier0Authority;
  /** Tests: replaces `readCompanyAdminActorConditions`. */
  adminConditions?: (orgId: OrgId, actorId: string) => Promise<TransactItem[]>;
}

const stringList = (value: unknown): string[] | undefined => Array.isArray(value) && value.every((item): item is string => typeof item === "string") && value.length <= PRIVATE_ADDRESSES_MAX ? [...value] : undefined;
const errorName = (error: unknown): string => (error instanceof Error ? error.name : "unknown");

async function get(table: PrivateAddressTable, key: { pk: string; sk: string }): Promise<Item | undefined> {
  return (await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true })) as { Item?: Item }).Item;
}

const validRevision = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 1;

/** The stored row, read for a change: a row that does not parse is `corrupt`, with its revision when that much reads (else 0, and a save replaces whatever row is there). */
export async function readPrivateAddressesForChange(table: PrivateAddressTable, orgId: string): Promise<PrivateAddressCurrent> {
  const item = await get(table, listKey(orgId));
  if (item === undefined) return { revision: 0, entries: [], digest: privateAddressListDigest([]) };
  const entries = stringList(item.entries);
  if (item.entityType !== "PRIVATE_ADDRESS_LIST" || entries === undefined || !validRevision(item.revision)) return { revision: validRevision(item.revision) ? item.revision : 0, entries: [], digest: privateAddressListDigest([]), corrupt: true };
  return { revision: item.revision, entries, digest: privateAddressListDigest(entries), ...(typeof item.updatedAt === "number" ? { updatedAt: item.updatedAt } : {}) };
}

/**
 * The company's approved list. Never written: revision 0 and no entries. A stored row that does not parse is refused with a clear error (fail closed: a launch then carries nothing and fails for this company alone, loudly,
 * until an admin saves the list again; other companies' launches are untouched).
 */
export async function readPrivateAddresses(table: PrivateAddressTable, orgId: string): Promise<PrivateAddressList> {
  const current = await readPrivateAddressesForChange(table, orgId);
  if (current.corrupt === true) throw agentXError("RUNTIME_UNAVAILABLE", PRIVATE_ADDRESS_WORDS.corrupt);
  return current;
}

function parseChange(item: Item | undefined): PrivateAddressChange | undefined {
  if (item?.entityType !== "PRIVATE_ADDRESS_CHANGE") return undefined;
  const entries = stringList(item.entries), baseEntries = stringList(item.baseEntries);
  if (entries === undefined || baseEntries === undefined || typeof item.id !== "string" || typeof item.orgId !== "string" || typeof item.digest !== "string" || typeof item.proposedBy !== "string") return undefined;
  if (typeof item.baseRevision !== "number" || typeof item.at !== "number" || typeof item.expiresAt !== "number") return undefined;
  if (item.state !== "pending" && item.state !== "applied" && item.state !== "withdrawn") return undefined;
  return { id: item.id, orgId: item.orgId, entries, digest: item.digest, baseRevision: item.baseRevision, baseEntries, proposedBy: item.proposedBy, at: item.at, expiresAt: item.expiresAt, state: item.state };
}

export async function readPrivateAddressChange(table: PrivateAddressTable, orgId: string, id: string): Promise<PrivateAddressChange | undefined> {
  if (!CHANGE_ID.test(id)) return undefined;
  const change = parseChange(await get(table, changeKey(orgId, id)));
  // The key is built from the caller's org; the stored org must say the same (a cross-org id reads as missing).
  return change !== undefined && change.orgId === orgId ? change : undefined;
}

/** The proposal that still waits: pending, not expired, and made against the list as it is now (one made against an older list can no longer be approved, so it does not block a new one). */
export async function openPrivateAddressChange(table: PrivateAddressTable, orgId: string, now: number, current: Pick<PrivateAddressList, "revision">): Promise<PrivateAddressChange | undefined> {
  const response = await table.documentClient.send(new QueryCommand({
    TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :p)", ConsistentRead: true, ExpressionAttributeValues: { ":pk": orgPk(orgId), ":p": CHANGE_PREFIX },
  })) as { Items?: Item[] };
  return (response.Items ?? []).map(parseChange).find((change) => change !== undefined && change.orgId === orgId && change.state === "pending" && change.expiresAt > now && change.baseRevision === current.revision);
}

export const listDifference = (from: readonly string[], to: readonly string[]) => ({ added: to.filter((entry) => !from.includes(entry)), removed: from.filter((entry) => !to.includes(entry)) });

/** The hosts and ports for the event's sealed `details` (subject `org`): the list, in parts that fit a detail field. Never a fact. */
function listDetails(entries: readonly string[]): AuditDetailPart[] {
  const fields: Record<string, string> = {};
  let part = 1, text = "";
  for (const entry of entries) {
    const next = text === "" ? entry : `${text},${entry}`;
    if (next.length > AUDIT_DETAIL_FIELD_MAX_CHARS) { fields[`entries${String(part)}`] = text; part += 1; text = entry; } else text = next;
  }
  fields[`entries${String(part)}`] = text;
  return [{ subject: "org", fields }];
}

function event(deps: PrivateAddressDeps, input: { orgId: string; actorId: string; action: PrivateAddressesAuditAction; occurrence: string; entries: readonly string[]; facts: Record<string, string | number> }): AuditEventInput {
  return auditPrivateAddresses({
    orgId: input.orgId, actor: { kind: "member", id: input.actorId }, occurredAt: new Date(deps.now()).toISOString(), occurrence: auditOccurrence(input.occurrence, input.action), action: input.action,
    facts: { entryCount: input.entries.length, listDigest: privateAddressListDigest(input.entries), ...input.facts }, details: listDetails(input.entries),
  });
}

async function adminConditions(deps: PrivateAddressDeps, orgId: OrgId, actorId: string): Promise<TransactItem[]> {
  try {
    return await (deps.adminConditions ?? ((org, actor) => readCompanyAdminActorConditions(deps.evidence, { orgId: org, actorId: actor })))(orgId, actorId);
  } catch (error) {
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "FORBIDDEN") throw agentXError("FORBIDDEN", PRIVATE_ADDRESS_WORDS.notAdmin);
    if (error instanceof Error && "code" in error && (error as { code?: unknown }).code === "CHANGE_STALE") throw agentXError("CHANGE_STALE", PRIVATE_ADDRESS_WORDS.stale);
    throw agentXError("RUNTIME_UNAVAILABLE", PRIVATE_ADDRESS_WORDS.unavailable);
  }
}

function listPut(deps: PrivateAddressDeps, orgId: string, entries: readonly string[], from: PrivateAddressCurrent, by: string): TransactItem {
  // Written only against the revision read: a lost race is a clear conflict, never an overwrite. A corrupt row whose revision does not read is replaced as it is (it must exist still).
  const condition = from.revision === 0
    ? { ConditionExpression: from.corrupt === true ? "attribute_exists(pk)" : "attribute_not_exists(pk)" }
    : { ConditionExpression: "#r = :r", ExpressionAttributeNames: { "#r": "revision" }, ExpressionAttributeValues: { ":r": from.revision } };
  return { Put: { TableName: deps.tableName, Item: { ...listKey(orgId), entityType: "PRIVATE_ADDRESS_LIST", orgId, entries: [...entries], revision: from.revision + 1, updatedAt: deps.now(), updatedBy: by }, ...condition } };
}

/** The recycle mark of a list change that removed anything (owner decision 128), in the same transaction as the change: the reaper stops this company's workers launched before it. */
function recycleMark(deps: PrivateAddressDeps, orgId: string): TransactItem {
  const at = deps.now();
  return { Put: { TableName: deps.tableName, Item: { pk: PRIVATE_ADDRESS_RECYCLE_PK, sk: orgId, entityType: "PRIVATE_ADDRESS_RECYCLE", orgId, removedAt: at, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(at / 1000) + RECYCLE_MARK_TTL_SECONDS } } };
}

async function commit(deps: PrivateAddressDeps, items: TransactItem[]): Promise<boolean> {
  try {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
    return true;
  } catch (error) {
    if (errorName(error) === "TransactionCanceledException" || errorName(error) === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

function checkedList(deps: PrivateAddressDeps, texts: readonly string[]): string[] {
  const checked = checkPrivateAddressList(texts, deps.install);
  if (!checked.ok) throw agentXError("CONFIG_INVALID", privateAddressRefusalText(checked.index, checked.refusal));
  return checked.entries;
}

export type ProposeResult = { status: "applied"; list: PrivateAddressList } | { status: "needs_approval"; changeId: string };

/** A company owner or admin proposes the whole new list. Only removals: applied now. Anything added: a proposal for a different admin. */
export async function proposePrivateAddresses(deps: PrivateAddressDeps, input: { orgId: OrgId; actorId: string; expectedRevision: number; entries: readonly string[] }): Promise<ProposeResult> {
  const entries = checkedList(deps, input.entries);
  const conditions = await adminConditions(deps, input.orgId, input.actorId);
  const current = await readPrivateAddressesForChange(deps, input.orgId);
  if (current.revision !== input.expectedRevision) throw agentXError("CHANGE_STALE", PRIVATE_ADDRESS_WORDS.stale);
  const { added, removed } = listDifference(current.entries, entries);
  // A corrupt stored list counts as one that holds something unknown: saving the empty list (or any list) replaces it, and its workers are recycled.
  if (added.length === 0 && removed.length === 0 && current.corrupt !== true) throw agentXError("CONFIG_INVALID", PRIVATE_ADDRESS_WORDS.nothing);
  if (added.length === 0) {
    // Stricter: one admin, at once. The event goes in the same transaction when a ledger exists; an outage never keeps a wall open.
    const changed = event(deps, { orgId: input.orgId, actorId: input.actorId, action: "company.private_addresses_changed", occurrence: `rev-${String(current.revision + 1)}`, entries, facts: { revision: current.revision + 1, added: 0, removed: removed.length, mode: "direct" } });
    if (!(await commit(deps, [...conditions, listPut(deps, input.orgId, entries, current, input.actorId), recycleMark(deps, input.orgId), ...auditPending(deps, changed)]))) throw agentXError("CHANGE_STALE", PRIVATE_ADDRESS_WORDS.stale);
    await flushAuditEvents(deps, [changed]);
    return { status: "applied", list: await readPrivateAddresses(deps, input.orgId) };
  }
  const at = deps.now();
  if ((await openPrivateAddressChange(deps, input.orgId, at, current)) !== undefined) throw agentXError("CHANGE_STALE", PRIVATE_ADDRESS_WORDS.open);
  const id = (deps.newId ?? (() => randomUUID()))();
  if (!CHANGE_ID.test(id)) throw new Error("a proposal id must be an id");
  const proposed = event(deps, { orgId: input.orgId, actorId: input.actorId, action: "company.private_addresses_proposed", occurrence: id, entries, facts: { revision: current.revision, added: added.length, removed: removed.length } });
  const pending = auditPending(deps, proposed);
  if (pending.length === 0) throw agentXError("AUDIT_UNAVAILABLE", PRIVATE_ADDRESS_WORDS.audit);
  const change: PrivateAddressChange = { id, orgId: input.orgId, entries, digest: privateAddressListDigest(entries), baseRevision: current.revision, baseEntries: current.entries, proposedBy: input.actorId, at, expiresAt: at + PRIVATE_ADDRESS_PROPOSAL_TTL_MS, state: "pending" };
  const put: TransactItem = {
    Put: { TableName: deps.tableName, Item: { ...changeKey(input.orgId, id), entityType: "PRIVATE_ADDRESS_CHANGE", ...change, ...(current.corrupt === true ? { baseCorrupt: true } : {}), [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(change.expiresAt / 1000) + CHANGE_ROW_KEEP_SECONDS }, ConditionExpression: "attribute_not_exists(pk)" },
  };
  if (!(await commit(deps, [...conditions, put, ...pending]))) throw agentXError("CHANGE_STALE", PRIVATE_ADDRESS_WORDS.stale);
  await flushAuditEvents(deps, [proposed]);
  return { status: "needs_approval", changeId: id };
}

/** A DIFFERENT live owner or admin approves the waiting proposal they were shown. No sole-owner exception. */
export async function approvePrivateAddresses(deps: PrivateAddressDeps, input: { orgId: OrgId; approverId: string; changeId: string; expectedDigest: string }): Promise<PrivateAddressList> {
  const change = await readPrivateAddressChange(deps, input.orgId, input.changeId);
  if (change === undefined) throw agentXError("NOT_FOUND", PRIVATE_ADDRESS_WORDS.notFound);
  if (change.state !== "pending") throw agentXError("CHANGE_STALE", PRIVATE_ADDRESS_WORDS.stale);
  const at = deps.now();
  if (change.expiresAt <= at) throw agentXError("CHANGE_STALE", PRIVATE_ADDRESS_WORDS.expired);
  if (change.digest !== input.expectedDigest || privateAddressListDigest(change.entries) !== change.digest) throw agentXError("CHANGE_STALE", PRIVATE_ADDRESS_WORDS.digest);
  // The two-person rule, first by id (whatever the roster says), then by the shared rule on live records.
  if (sameId(change.proposedBy, input.approverId)) throw agentXError("FORBIDDEN", PRIVATE_ADDRESS_WORDS.secondPerson);
  const authority = deps.authority ?? secondPersonTier0Authority(deps.evidence);
  let group: Awaited<ReturnType<Tier0Authority["eligibility"]>>;
  try {
    group = await authority.eligibility({ kind: "company", workspaceId: input.orgId }, { proposerId: change.proposedBy, approverId: input.approverId });
  } catch (error) {
    if (error instanceof Error && "code" in error && ((error as { code?: unknown }).code === "FORBIDDEN" || (error as { code?: unknown }).code === "CHANGE_STALE")) throw agentXError("FORBIDDEN", PRIVATE_ADDRESS_WORDS.membership);
    throw agentXError("RUNTIME_UNAVAILABLE", PRIVATE_ADDRESS_WORDS.unavailable);
  }
  if (!group.complete) throw agentXError("RUNTIME_UNAVAILABLE", PRIVATE_ADDRESS_WORDS.unavailable);
  if (!idIn(group.eligibleIds, input.approverId)) throw agentXError("FORBIDDEN", PRIVATE_ADDRESS_WORDS.notAdmin);
  const decision = trySecondPersonTimed(group, change.proposedBy, input.approverId, at);
  if (!decision.ok || decision.mode !== "second_person") throw agentXError("FORBIDDEN", PRIVATE_ADDRESS_WORDS.secondPerson);
  // The install may have changed since the proposal (its network, its services): every entry is checked again.
  const entries = checkedList(deps, change.entries);
  const current = await readPrivateAddressesForChange(deps, input.orgId);
  if (current.revision !== change.baseRevision) throw agentXError("CHANGE_STALE", PRIVATE_ADDRESS_WORDS.stale);
  const { added, removed } = listDifference(current.entries, entries);
  const changed = event(deps, { orgId: input.orgId, actorId: input.approverId, action: "company.private_addresses_changed", occurrence: change.id, entries, facts: { revision: current.revision + 1, added: added.length, removed: removed.length, mode: "second_person" } });
  const pending = auditPending(deps, changed);
  if (pending.length === 0) throw agentXError("AUDIT_UNAVAILABLE", PRIVATE_ADDRESS_WORDS.audit);
  const mark: TransactItem = {
    Update: {
      TableName: deps.tableName, Key: changeKey(input.orgId, change.id), UpdateExpression: "SET #s = :applied, approvedBy = :by, approvedAt = :at", ConditionExpression: "#s = :pending AND digest = :digest",
      ExpressionAttributeNames: { "#s": "state" }, ExpressionAttributeValues: { ":applied": "applied", ":pending": "pending", ":by": input.approverId, ":at": at, ":digest": change.digest },
    },
  };
  const fence = (group.fence ?? []) as TransactItem[];
  // An approved list that also removes something (or replaces a corrupt one) recycles the company's workers, as a removal does (owner decision 128).
  const recycle = removed.length > 0 || current.corrupt === true ? [recycleMark(deps, input.orgId)] : [];
  if (!(await commit(deps, [...fence, listPut(deps, input.orgId, entries, current, input.approverId), mark, ...recycle, ...pending]))) {
    // The list moved, the proposal was decided, or someone's authority changed (the fence). The proposal is unchanged in the last case, so the approver can look again.
    const again = await readPrivateAddressesForChange(deps, input.orgId).catch(() => undefined);
    throw agentXError("CHANGE_STALE", again?.revision === current.revision ? PRIVATE_ADDRESS_WORDS.membership : PRIVATE_ADDRESS_WORDS.stale);
  }
  await flushAuditEvents(deps, [changed]);
  return readPrivateAddresses(deps, input.orgId);
}

/** The proposer withdraws their proposal, or another admin turns it down. */
export async function withdrawPrivateAddresses(deps: PrivateAddressDeps, input: { orgId: OrgId; actorId: string; changeId: string }): Promise<void> {
  const change = await readPrivateAddressChange(deps, input.orgId, input.changeId);
  if (change === undefined) throw agentXError("NOT_FOUND", PRIVATE_ADDRESS_WORDS.notFound);
  if (change.state !== "pending") throw agentXError("CHANGE_STALE", PRIVATE_ADDRESS_WORDS.stale);
  const conditions = await adminConditions(deps, input.orgId, input.actorId);
  const withdrawn = event(deps, { orgId: input.orgId, actorId: input.actorId, action: "company.private_addresses_withdrawn", occurrence: change.id, entries: change.entries, facts: { by: sameId(change.proposedBy, input.actorId) ? "proposer" : "admin" } });
  const mark: TransactItem = {
    Update: {
      TableName: deps.tableName, Key: changeKey(input.orgId, change.id), UpdateExpression: "SET #s = :withdrawn", ConditionExpression: "#s = :pending",
      ExpressionAttributeNames: { "#s": "state" }, ExpressionAttributeValues: { ":withdrawn": "withdrawn", ":pending": "pending" },
    },
  };
  if (!(await commit(deps, [...conditions, mark, ...auditPending(deps, withdrawn)]))) throw agentXError("CHANGE_STALE", PRIVATE_ADDRESS_WORDS.stale);
  await flushAuditEvents(deps, [withdrawn]);
}
