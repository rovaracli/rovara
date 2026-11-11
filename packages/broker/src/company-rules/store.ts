// Company rules (G-04), the DynamoDB store. Rows live in the company's partition (`ORG#<id>`) of the State table:
//   COMPANYRULES#HEAD          the newest approved version number and digest, and the id of the one waiting proposal (if any). Every approval and every proposal is conditional on it, so two admins cannot both win.
//   COMPANYRULES#V#<9 digits>  an approved version: IMMUTABLE. It is written once (`attribute_not_exists`) in the transaction that approves it and never updated or deleted by this code (no function here can).
//   COMPANYRULES#P#<uuid>      a proposal (waiting, then approved, rejected, cancelled or expired). A decided one is kept for the history list and expires a year after it was decided.
//   COMPANYRULES#D#<decidedAt>#<uuid>  a copy of a proposal that did NOT become a version (rejected, cancelled, expired), written in the transaction that ends it, so the history lists the latest ones in a deterministic newest-first order.
//   COMPANYRULES#SYNC          the connection to the company's meta repository file, and what the last look at it found.
// Developer ids (proposer, adopter, approver, who connected the file) are opaque 64-hex ids, as in the playbook approvals and the audit ledger; names are looked up through the sign-in record, which erasure turns into a placeholder. These
// rows are governance records and are kept (versions for good, decided proposals 400 days): an erase audit must treat them like the audit ledger, not like Team record rows (so there is no PERSON_FIELDS row).
// A head that names a malformed pending proposal id is NOT "no proposal": `head()` refuses (RUNTIME_UNAVAILABLE, fixed log line) so the state is visible. An operator clears it by removing `pendingProposalId` from the HEAD row.
// Every write is ONE TransactWriteItems that holds the rows, the fences the caller read (the second-person evidence) and the audit event's pending item. A cancelled transaction answers "conflict": the caller reads again and says
// CHANGE_STALE. A write without an audit ledger is refused: changing company rules is company authority, so there is no unaudited path.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, agentXError, orgPk, type AuditEventInput, type OrgId } from "@agentx/contracts";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import type { Rule } from "./rules.js";

type Row = Record<string, unknown>;

/** Who did something: a company member, the connected repository (a login is untrusted text), the operator's seed, or Rovara itself (an expiry). */
export type Actor = { kind: "member"; id: string } | { kind: "repo"; login?: string } | { kind: "seed" } | { kind: "system" };

export type ProposalState = "pending" | "approved" | "rejected" | "cancelled" | "expired";
export type Outcome = Exclude<ProposalState, "pending">;
export type ApprovalMode = "second_person" | "sole_owner_exception" | "admin_review" | "seed";
export type Source = "rovara" | "repo" | "seed";

export interface Head { latestVersion: number; latestDigest?: string; pendingProposalId?: string }

export interface VersionRecord {
  version: number; digest: string; rules: Rule[]; source: Source; approvalMode: ApprovalMode; proposedBy: Actor; approvedBy: Actor; proposalId: string; baseVersion: number; proposedAt: string; approvedAt: string; note?: string;
  /** The admin who adopted a repository proposal (the version's "proposer" for the second-person rule). */
  adoptedBy?: Actor;
}
export interface ProposalRecord {
  proposalId: string; state: ProposalState; baseVersion: number; source: "rovara" | "repo"; rules: Rule[]; digest: string; note?: string; proposedBy: Actor; proposedAt: string; expiresAt: string;
  decidedAt?: string; decidedBy?: Actor; version?: number; repoRevision?: string;
  /** A proposal from the repository has no person as its proposer: the first admin to ADOPT it becomes the person a different admin's approval is measured against (decision 85: second-admin approval). */
  adoptedBy?: Actor; adoptedAt?: string;
}

export type WriteBackState = "waiting" | "open" | "merged" | "closed" | "failed";
export interface SyncRecord {
  /** Counts every write of the row; a write is conditional on the revision it read. */
  revision: number;
  repositoryName: string; repositoryUrl: string; repositoryId: number; path: string; branch: string; connectedBy: string; connectedAt: string;
  lastCheckedAt?: string; lastCheckedRevision?: string;
  /** What the file's rules were at the last check (their digest, and the rules when the file could be read). `fileState` says what was found. */
  fileState: "match" | "differs" | "missing" | "unreadable" | "never_checked";
  problem?: "file_unreadable" | "file_too_large" | "over_limits" | "host_unavailable" | "repository_changed" | "no_write_access" | "no_pull_request_support";
  fileDigest?: string; fileRules?: Rule[];
  /** The digest of the file's rules the last time a repo proposal was made from it, or a person decided about it: the same edit is never proposed twice. */
  handledFileDigest?: string;
  /** The version in force when `handledFileDigest` was set: a handled edit is forgotten when the version moves. */
  handledAtVersion?: number;
  /** The digest of every version Rovara itself wrote to the file through a pull request (the last 20). A file that equals one of them is Rovara's own older write reaching the branch late, not an edit made in the repository. */
  writtenDigests?: string[];
  /** The version's digest and rules the last time the file matched it: the point the two last agreed on, which says which side changed since. */
  syncedDigest?: string; syncedRules?: Rule[];
  /** The version a write-back is owed for (waiting), or the pull request that carries it. */
  writeBack?: { version: number; state: WriteBackState; branch?: string; head?: string; number?: number; url?: string; updatedAt: string };
}

export interface CompanyRulesTable {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The Audit Ledger's outbox. Without it every write is refused. */
  audit?: AuditRuntime | undefined;
}

const HEAD_SK = "COMPANYRULES#HEAD";
const SYNC_SK = "COMPANYRULES#SYNC";
const VERSION_PREFIX = "COMPANYRULES#V#";
const PROPOSAL_PREFIX = "COMPANYRULES#P#";
const DECIDED_PREFIX = "COMPANYRULES#D#";
const DECIDED_KEEP_SECONDS = 400 * 86_400;
const pad = (version: number): string => String(version).padStart(9, "0");
const headKey = (orgId: OrgId) => ({ pk: orgPk(orgId), sk: HEAD_SK });
const versionKey = (orgId: OrgId, version: number) => ({ pk: orgPk(orgId), sk: `${VERSION_PREFIX}${pad(version)}` });
const proposalKey = (orgId: OrgId, proposalId: string) => ({ pk: orgPk(orgId), sk: `${PROPOSAL_PREFIX}${proposalId}` });
const syncKey = (orgId: OrgId) => ({ pk: orgPk(orgId), sk: SYNC_SK });
const decidedKey = (orgId: OrgId, decidedAt: string, proposalId: string) => ({ pk: orgPk(orgId), sk: `${DECIDED_PREFIX}${decidedAt}#${proposalId}` });

const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "The company rules could not be read. Try again.");
const auditUnavailable = () => agentXError("AUDIT_UNAVAILABLE", "Company rule changes need the audit ledger.");
const cancelled = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");
const isUuid = (value: unknown): value is string => typeof value === "string" && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(value);

const strip = (raw: Row): Row => { const { pk: _pk, sk: _sk, entityType: _type, orgId: _org, ...rest } = raw; void _pk; void _sk; void _type; void _org; return rest; };

function actorOf(value: unknown): Actor | undefined {
  const raw = value as { kind?: unknown; id?: unknown; login?: unknown } | undefined;
  if (raw?.kind === "member" && typeof raw.id === "string" && /^[a-f0-9]{64}$/u.test(raw.id)) return { kind: "member", id: raw.id };
  if (raw?.kind === "repo") return typeof raw.login === "string" ? { kind: "repo", login: raw.login.slice(0, 100) } : { kind: "repo" };
  if (raw?.kind === "seed") return { kind: "seed" };
  if (raw?.kind === "system") return { kind: "system" };
  return undefined;
}
function rulesOf(value: unknown): Rule[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const rules: Rule[] = [];
  for (const entry of value as Array<{ text?: unknown; priority?: unknown }>) {
    if (typeof entry?.text !== "string" || (entry.priority !== "required" && entry.priority !== "preferred")) return undefined;
    rules.push({ text: entry.text, priority: entry.priority });
  }
  return rules;
}
const isoOf = (value: unknown): string | undefined => (typeof value === "string" && Number.isFinite(Date.parse(value)) ? value : undefined);

function headOf(raw: Row | undefined, options: { ignorePending?: boolean } = {}): Head {
  if (raw === undefined) return { latestVersion: 0 };
  const latest = raw.latestVersion;
  if (typeof latest !== "number" || !Number.isSafeInteger(latest) || latest < 0) throw unavailable();
  // A pending id that is not a well-formed id is a damaged head, not "nothing waiting": it is refused loudly (an operator removes the attribute), never silently dropped.
  if (options.ignorePending === true) return { latestVersion: latest, ...(typeof raw.latestDigest === "string" ? { latestDigest: raw.latestDigest } : {}) };
  if (raw.pendingProposalId !== undefined && !isUuid(raw.pendingProposalId)) { console.log(JSON.stringify({ component: "company_rules", event: "company_rules.head_pending_id_malformed" })); throw unavailable(); }
  return { latestVersion: latest, ...(typeof raw.latestDigest === "string" ? { latestDigest: raw.latestDigest } : {}), ...(typeof raw.pendingProposalId === "string" ? { pendingProposalId: raw.pendingProposalId } : {}) };
}

/** A stored version, or undefined for a row that does not read (it is then no version: never served as rules). */
export function versionOf(raw: Row | undefined): VersionRecord | undefined {
  if (raw === undefined) return undefined;
  const rules = rulesOf(raw.rules), proposedBy = actorOf(raw.proposedBy), approvedBy = actorOf(raw.approvedBy);
  const proposedAt = isoOf(raw.proposedAt), approvedAt = isoOf(raw.approvedAt);
  const mode = raw.approvalMode, source = raw.source;
  if (rules === undefined || proposedBy === undefined || approvedBy === undefined || proposedAt === undefined || approvedAt === undefined || typeof raw.digest !== "string" || !/^[a-f0-9]{64}$/u.test(raw.digest)
    || typeof raw.version !== "number" || !Number.isSafeInteger(raw.version) || raw.version < 1 || !isUuid(raw.proposalId) && raw.proposalId !== "seed" || typeof raw.baseVersion !== "number"
    || (mode !== "second_person" && mode !== "sole_owner_exception" && mode !== "admin_review" && mode !== "seed") || (source !== "rovara" && source !== "repo" && source !== "seed")) return undefined;
  return { version: raw.version, digest: raw.digest, rules, source, approvalMode: mode, proposedBy, approvedBy, proposalId: raw.proposalId, baseVersion: raw.baseVersion, proposedAt, approvedAt, ...(typeof raw.note === "string" ? { note: raw.note } : {}), ...adoptionOf(raw) };
}

const adoptionOf = (raw: Row): { adoptedBy?: Actor; adoptedAt?: string } => {
  const adoptedBy = actorOf(raw.adoptedBy), adoptedAt = isoOf(raw.adoptedAt);
  return { ...(adoptedBy === undefined ? {} : { adoptedBy }), ...(adoptedAt === undefined ? {} : { adoptedAt }) };
};

export function proposalOf(raw: Row | undefined): ProposalRecord | undefined {
  if (raw === undefined) return undefined;
  const rules = rulesOf(raw.rules), proposedBy = actorOf(raw.proposedBy);
  const proposedAt = isoOf(raw.proposedAt), expiresAt = isoOf(raw.expiresAt);
  const state = raw.state, source = raw.source;
  if (rules === undefined || proposedBy === undefined || proposedAt === undefined || expiresAt === undefined || !isUuid(raw.proposalId) || typeof raw.digest !== "string" || typeof raw.baseVersion !== "number"
    || (state !== "pending" && state !== "approved" && state !== "rejected" && state !== "cancelled" && state !== "expired") || (source !== "rovara" && source !== "repo")) return undefined;
  const decidedBy = actorOf(raw.decidedBy), decidedAt = isoOf(raw.decidedAt);
  return {
    proposalId: raw.proposalId, state, baseVersion: raw.baseVersion, source, rules, digest: raw.digest, proposedBy, proposedAt, expiresAt,
    ...(typeof raw.note === "string" ? { note: raw.note } : {}), ...(decidedBy === undefined ? {} : { decidedBy }), ...(decidedAt === undefined ? {} : { decidedAt }),
    ...(typeof raw.version === "number" ? { version: raw.version } : {}), ...(typeof raw.repoRevision === "string" ? { repoRevision: raw.repoRevision } : {}), ...adoptionOf(raw),
  };
}

export function syncOf(raw: Row | undefined): SyncRecord | undefined {
  if (raw === undefined) return undefined;
  const connectedAt = isoOf(raw.connectedAt);
  if (typeof raw.revision !== "number" || typeof raw.repositoryName !== "string" || typeof raw.repositoryUrl !== "string" || typeof raw.repositoryId !== "number" || typeof raw.path !== "string" || typeof raw.branch !== "string"
    || typeof raw.connectedBy !== "string" || connectedAt === undefined) return undefined;
  const state = raw.fileState;
  const fileState = state === "match" || state === "differs" || state === "missing" || state === "unreadable" ? state : "never_checked";
  const rest = strip(raw);
  return { ...(rest as unknown as SyncRecord), fileState, connectedAt };
}

export interface CompanyRulesStore {
  head(orgId: OrgId): Promise<Head>;
  /** The newest approved version number and digest, and NOTHING about a waiting proposal: what the agent steps need. A damaged pending id does not matter here (it does to `head`, which refuses it loudly), so the approved rules keep being served. */
  currentHead(orgId: OrgId): Promise<Pick<Head, "latestVersion" | "latestDigest">>;
  version(orgId: OrgId, version: number): Promise<VersionRecord | undefined>;
  /** Newest first, below `before` when given. At most `limit` (bounded). */
  versions(orgId: OrgId, input: { before?: number; limit: number }): Promise<VersionRecord[]>;
  proposal(orgId: OrgId, proposalId: string): Promise<ProposalRecord | undefined>;
  /** The most recent proposals that did not become a version (rejected, cancelled, expired), newest decision first. */
  decided(orgId: OrgId, limit: number): Promise<ProposalRecord[]>;
  sync(orgId: OrgId): Promise<SyncRecord | undefined>;

  /** Writes a waiting proposal, conditional on the head being at `expectedBase` with nothing waiting (or with `replacing`, an expired proposal, which the same transaction expires). "conflict" when the head moved. */
  createProposal(input: { orgId: OrgId; proposal: ProposalRecord; expectedBase: number; replacing?: ProposalRecord; /** How the replaced proposal ends: expired (the default) or cancelled (superseded by a newer repository edit). */ replacingOutcome?: "expired" | "cancelled"; events: AuditEventInput[] }): Promise<"ok" | "conflict">;
  /**
   * Ends the waiting proposal as read (conditional on it still waiting with this digest). `approved` also writes version `base + 1`, immutable, and moves the head, all conditional on the head still being at the proposal's base
   * with this proposal waiting. `conditions` are the caller's fences (the second-person evidence); they commit with it.
   */
  decideProposal(input: { orgId: OrgId; proposal: ProposalRecord; outcome: Outcome; decidedBy: Actor; decidedAt: string; version?: VersionRecord; conditions?: readonly TransactItem[]; events: AuditEventInput[] }): Promise<"ok" | "conflict">;
  /** Marks the waiting proposal as adopted by an admin (conditional on it still waiting, with this digest and not yet adopted). `conditions` are the adopter's live-authority fences. */
  adoptProposal(input: { orgId: OrgId; proposal: ProposalRecord; adopter: Actor; adoptedAt: string; conditions?: readonly TransactItem[]; events: AuditEventInput[] }): Promise<"ok" | "conflict">;
  /** The operator's seed: version 1 and the head, in one transaction, only for a company with no versions and nothing waiting. */
  seedVersion(input: { orgId: OrgId; version: VersionRecord; events: AuditEventInput[] }): Promise<"ok" | "conflict">;
  /** Writes the sync row (null deletes it), conditional on the revision read (0: no row). The audit events are optional: a plain status refresh writes none. */
  writeSync(input: { orgId: OrgId; next: SyncRecord | null; expectedRevision: number; events?: AuditEventInput[]; /** Extra items that must commit with it (a repo proposal). */ with?: (readonly TransactItem[]) }): Promise<"ok" | "conflict">;
}

export function dynamoCompanyRulesStore(table: CompanyRulesTable): CompanyRulesStore {
  const read = async (key: { pk: string; sk: string }): Promise<Row | undefined> => ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true }))) as { Item?: Row }).Item;
  const orgOk = (orgId: unknown): orgId is OrgId => OrgIdSchema.safeParse(orgId).success;

  async function query(orgId: OrgId, prefix: string, options: { forward: boolean; limit: number; start?: string }): Promise<Row[]> {
    const out: Row[] = [];
    let start: Row | undefined;
    for (let page = 0; page < 5 && out.length < options.limit; page += 1) {
      const result = await table.documentClient.send(new QueryCommand({
        TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": prefix },
        ConsistentRead: true, ScanIndexForward: options.forward, Limit: Math.min(100, options.limit - out.length), ...(start === undefined ? {} : { ExclusiveStartKey: start }),
      })) as { Items?: Row[]; LastEvaluatedKey?: Row };
      out.push(...(result.Items ?? []));
      start = result.LastEvaluatedKey;
      if (start === undefined) break;
    }
    return out.slice(0, options.limit);
  }

  async function transact(items: TransactItem[], events: readonly AuditEventInput[]): Promise<"ok" | "conflict"> {
    if (events.length > 0 && table.audit === undefined) throw auditUnavailable();
    const pending = events.flatMap((event) => (table.audit === undefined ? [] : auditPending({ audit: table.audit }, event)));
    if (pending.length === 0 && events.length > 0) throw auditUnavailable();
    if (items.length + pending.length > 100) throw unavailable();
    try { await table.documentClient.send(new TransactWriteCommand({ TransactItems: [...items, ...pending] })); } catch (error) {
      if (cancelled(error)) return "conflict";
      throw error;
    }
    if (table.audit !== undefined && events.length > 0) await flushAuditEvents({ audit: table.audit }, [...events]);
    return "ok";
  }

  const expiry = (at: string): number => Math.floor(Date.parse(at) / 1000) + DECIDED_KEEP_SECONDS;
  const proposalItem = (orgId: OrgId, proposal: ProposalRecord): Row => ({
    ...proposalKey(orgId, proposal.proposalId), entityType: "COMPANY_RULES_PROPOSAL", orgId, ...proposal, ...(proposal.state === "pending" ? {} : { [INDEX_EXPIRY_ATTRIBUTE]: expiry(proposal.decidedAt ?? proposal.proposedAt) }),
  });
  const closeProposal = (orgId: OrgId, proposal: ProposalRecord, outcome: Outcome, decidedBy: Actor, decidedAt: string, version?: number): TransactItem[] => [
    { Update: {
      TableName: table.tableName, Key: proposalKey(orgId, proposal.proposalId),
      UpdateExpression: `SET #state = :outcome, decidedAt = :at, decidedBy = :by, ${INDEX_EXPIRY_ATTRIBUTE} = :ttl${version === undefined ? "" : ", #version = :version"}`,
      ConditionExpression: "#state = :pending AND digest = :digest AND baseVersion = :base",
      ExpressionAttributeNames: { "#state": "state", ...(version === undefined ? {} : { "#version": "version" }) },
      ExpressionAttributeValues: { ":outcome": outcome, ":at": decidedAt, ":by": decidedBy, ":ttl": expiry(decidedAt), ":pending": "pending", ":digest": proposal.digest, ":base": proposal.baseVersion, ...(version === undefined ? {} : { ":version": version }) },
    } },
    // A proposal that did not become a version is also copied under a time-ordered key, for the history list.
    ...(outcome === "approved" ? [] : [{ Put: { TableName: table.tableName, Item: { ...decidedKey(orgId, decidedAt, proposal.proposalId), entityType: "COMPANY_RULES_DECIDED", orgId, ...proposal, state: outcome, decidedAt, decidedBy, [INDEX_EXPIRY_ATTRIBUTE]: expiry(decidedAt) } } } as TransactItem]),
  ];

  return {
    async head(orgId) { if (!orgOk(orgId)) throw unavailable(); return headOf(await read(headKey(orgId))); },
    async currentHead(orgId) { if (!orgOk(orgId)) throw unavailable(); return headOf(await read(headKey(orgId)), { ignorePending: true }); },
    async version(orgId, version) {
      if (!orgOk(orgId) || !Number.isSafeInteger(version) || version < 1 || version > 999_999_999) return undefined;
      return versionOf(await read(versionKey(orgId, version)));
    },
    async versions(orgId, input) {
      if (!orgOk(orgId)) return [];
      const limit = Math.max(1, Math.min(51, input.limit));
      const high = input.before === undefined ? 999_999_999 : Math.max(0, Math.min(999_999_999, input.before - 1));
      const result = await table.documentClient.send(new QueryCommand({
        TableName: table.tableName, KeyConditionExpression: "pk = :pk AND sk BETWEEN :low AND :high", ExpressionAttributeValues: { ":pk": orgPk(orgId), ":low": `${VERSION_PREFIX}${pad(1)}`, ":high": `${VERSION_PREFIX}${pad(high)}` },
        ConsistentRead: true, ScanIndexForward: false, Limit: limit,
      })) as { Items?: Row[] };
      return (result.Items ?? []).map((row) => versionOf(row)).filter((version): version is VersionRecord => version !== undefined);
    },
    async proposal(orgId, proposalId) {
      if (!orgOk(orgId) || !isUuid(proposalId)) return undefined;
      return proposalOf(await read(proposalKey(orgId, proposalId)));
    },
    async decided(orgId, limit) {
      if (!orgOk(orgId)) return [];
      // The copies written when a proposal ended, newest first by their time-ordered keys: a deterministic list however many there have been.
      const rows = await query(orgId, DECIDED_PREFIX, { forward: false, limit: Math.max(1, Math.min(50, limit)) });
      return rows.map((row) => proposalOf(row)).filter((proposal): proposal is ProposalRecord => proposal !== undefined && proposal.state !== "pending" && proposal.state !== "approved");
    },
    async sync(orgId) { if (!orgOk(orgId)) return undefined; return syncOf(await read(syncKey(orgId))); },

    async createProposal({ orgId, proposal, expectedBase, replacing, replacingOutcome, events }) {
      if (!orgOk(orgId) || proposal.state !== "pending" || !isUuid(proposal.proposalId)) return "conflict";
      const base = expectedBase === 0 ? "(attribute_not_exists(latestVersion) OR latestVersion = :zero)" : "latestVersion = :base";
      const values: Row = { ":zero": 0, ":id": proposal.proposalId, ":type": "COMPANY_RULES_HEAD", ":org": orgId, ...(expectedBase === 0 ? {} : { ":base": expectedBase }) };
      if (replacing !== undefined) values[":old"] = replacing.proposalId;
      const items: TransactItem[] = [
        { Put: { TableName: table.tableName, Item: proposalItem(orgId, proposal), ConditionExpression: "attribute_not_exists(pk)" } },
        { Update: {
          TableName: table.tableName, Key: headKey(orgId), UpdateExpression: "SET pendingProposalId = :id, latestVersion = if_not_exists(latestVersion, :zero), entityType = :type, orgId = :org",
          ConditionExpression: `${base} AND ${replacing === undefined ? "attribute_not_exists(pendingProposalId)" : "pendingProposalId = :old"}`, ExpressionAttributeValues: values,
        } },
      ];
      if (replacing !== undefined) items.push(...closeProposal(orgId, replacing, replacingOutcome ?? "expired", { kind: "system" }, proposal.proposedAt));
      return transact(items, events);
    },

    async decideProposal({ orgId, proposal, outcome, decidedBy, decidedAt, version, conditions, events }) {
      if (!orgOk(orgId) || proposal.state !== "pending" || (outcome === "approved") !== (version !== undefined)) return "conflict";
      const items: TransactItem[] = [...(conditions ?? [])];
      if (outcome === "approved" && version !== undefined) {
        if (version.version !== proposal.baseVersion + 1) return "conflict";
        items.push(
          { Put: { TableName: table.tableName, Item: { ...versionKey(orgId, version.version), entityType: "COMPANY_RULES_VERSION", orgId, ...version }, ConditionExpression: "attribute_not_exists(pk)" } },
          { Update: {
            TableName: table.tableName, Key: headKey(orgId), UpdateExpression: "SET latestVersion = :next, latestDigest = :digest REMOVE pendingProposalId",
            ConditionExpression: `${proposal.baseVersion === 0 ? "(attribute_not_exists(latestVersion) OR latestVersion = :zero)" : "latestVersion = :base"} AND pendingProposalId = :id`,
            ExpressionAttributeValues: { ":next": version.version, ":digest": version.digest, ":id": proposal.proposalId, ...(proposal.baseVersion === 0 ? { ":zero": 0 } : { ":base": proposal.baseVersion }) },
          } },
        );
      } else {
        items.push({ Update: { TableName: table.tableName, Key: headKey(orgId), UpdateExpression: "REMOVE pendingProposalId", ConditionExpression: "pendingProposalId = :id", ExpressionAttributeValues: { ":id": proposal.proposalId } } });
      }
      items.push(...closeProposal(orgId, proposal, outcome, decidedBy, decidedAt, version?.version));
      return transact(items, events);
    },

    async adoptProposal({ orgId, proposal, adopter, adoptedAt, conditions, events }) {
      if (!orgOk(orgId) || proposal.state !== "pending" || proposal.source !== "repo" || adopter.kind !== "member") return "conflict";
      return transact([
        ...(conditions ?? []),
        { Update: {
          TableName: table.tableName, Key: proposalKey(orgId, proposal.proposalId), UpdateExpression: "SET adoptedBy = :by, adoptedAt = :at",
          ConditionExpression: "#state = :pending AND digest = :digest AND baseVersion = :base AND #source = :repo AND attribute_not_exists(adoptedBy)",
          ExpressionAttributeNames: { "#state": "state", "#source": "source" },
          ExpressionAttributeValues: { ":by": adopter, ":at": adoptedAt, ":pending": "pending", ":digest": proposal.digest, ":base": proposal.baseVersion, ":repo": "repo" },
        } },
        // The head must still wait on this proposal.
        { ConditionCheck: { TableName: table.tableName, Key: headKey(orgId), ConditionExpression: "pendingProposalId = :id", ExpressionAttributeValues: { ":id": proposal.proposalId } } },
      ], events);
    },

    async seedVersion({ orgId, version, events }) {
      if (!orgOk(orgId) || version.version !== 1) return "conflict";
      return transact([
        { Put: { TableName: table.tableName, Item: { ...versionKey(orgId, 1), entityType: "COMPANY_RULES_VERSION", orgId, ...version }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Update: {
          TableName: table.tableName, Key: headKey(orgId), UpdateExpression: "SET latestVersion = :one, latestDigest = :digest, entityType = :type, orgId = :org",
          ConditionExpression: "(attribute_not_exists(latestVersion) OR latestVersion = :zero) AND attribute_not_exists(pendingProposalId)", ExpressionAttributeValues: { ":one": 1, ":zero": 0, ":digest": version.digest, ":type": "COMPANY_RULES_HEAD", ":org": orgId },
        } },
      ], events);
    },

    async writeSync({ orgId, next, expectedRevision, events, with: more }) {
      if (!orgOk(orgId)) return "conflict";
      const key = syncKey(orgId);
      const guard = expectedRevision === 0 ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": expectedRevision } };
      const row: TransactItem = next === null
        ? { Delete: { TableName: table.tableName, Key: key, ...guard } }
        : { Put: { TableName: table.tableName, Item: { ...key, entityType: "COMPANY_RULES_SYNC", orgId, ...next, revision: expectedRevision + 1 }, ...guard } };
      return transact([row, ...(more ?? [])], events ?? []);
    },
  };
}

export { headKey as companyRulesHeadKey, versionKey as companyRulesVersionKey, proposalKey as companyRulesProposalKey, syncKey as companyRulesSyncKey };
