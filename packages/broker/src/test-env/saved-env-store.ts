// Saved project images (SV wiring): the DynamoDB adapter of `SavedEnvStore` (test-env/saved-env.ts). One row per project, in the company's partition:
//   pk = ORG#<orgId>, sk = SAVED_ENV#<projectId>   the registry row (images, job, flags); `version` is the compare-and-set counter.
// Every write of the row is ONE TransactWriteItems: the row Put (conditional on the stored version, or on no row yet) and the audit ledger's pending item for the change. The transaction answers false when it was
// cancelled (the row changed meanwhile), and the caller then retries or reports `stale_write`. A change with an audit event and no audit ledger is refused: image lifecycle is company authority, there is no
// unaudited path. An audit entry that is not tied to a row change (a refused lease, a routine deletion, a scan start) is written alone through the same outbox.
// Only `activity` (a push or a task touched the row's times) is not an event of the ledger: it is the row write alone, with the same version fence. It happens on every push and task start.
// `deletedNeedingPurge` reads the sparse due index the other cross-company sweeps use (`WORKFLOW_DISPATCH_DUE_INDEX`, partition `SAVED_ENV_PURGE`): a deleted row carries a due time until its registry deletion is final
// (finished after `deletedAt` plus a job lease), then the attributes are dropped in the write that records the purge. No new index, no new table.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { ImageDigestSchema, OrgIdSchema, SavedEnvManifestSchema, WORKFLOW_DISPATCH_DUE_INDEX, agentXError, orgPk, type AuditEventInput } from "@agentx/contracts";
import { z } from "zod";
import { auditOccurrence, auditSavedEnvChanged } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import { SAVED_ENV_JOB_LEASE_MS, type SavedEnvAuditEntry, type SavedEnvState, type SavedEnvStore } from "./saved-env.js";

type Row = Record<string, unknown>;

export interface SavedEnvTable {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The clock of the sweep's due test (milliseconds). Default `Date.now`. */
  now?: () => number;
  /** The Audit Ledger's outbox. Without it every write is refused. */
  audit?: AuditRuntime | undefined;
}

/** The partition of the sparse due index that lists deleted projects whose registry deletion is not final. */
export const SAVED_ENV_PURGE_PARTITION = "SAVED_ENV_PURGE";
/** The most deleted projects one sweep reads (the nightly runs it daily; a remainder is swept the next night). */
export const SAVED_ENV_PURGE_PAGE = 200;

const rowKey = (orgId: string, projectId: string): { pk: string; sk: string } => ({ pk: orgPk(OrgIdSchema.parse(orgId)), sk: `SAVED_ENV#${projectId}` });
const dueKey = (time: number): string => String(Math.max(0, Math.trunc(time))).padStart(15, "0");
const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Saved project images could not be read.");
const auditUnavailable = () => agentXError("AUDIT_UNAVAILABLE", "Saved project images need the audit ledger.");
const cancelled = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");

const Iso = z.string().datetime();
const Approved = z.object({ revision: z.number().int().min(1), digest: z.string().min(1).max(100) }).strict();
const ImageSchema = z.object({
  approved: Approved, digest: ImageDigestSchema, tag: z.string().min(1).max(128), manifest: SavedEnvManifestSchema, recordedAt: Iso, status: z.enum(["ready", "stale"]),
  staleStep: z.string().max(40).optional(), scanStartedAt: Iso.optional(),
}).strict();
const JobSchema = z.object({
  jobId: z.string().min(1).max(64), leaseToken: z.string().min(1).max(200), reason: z.enum(["no_image", "key_changed", "max_age", "stale", "reset"]), approved: Approved,
  commits: z.record(z.string().min(1).max(200), z.string().regex(/^[a-f0-9]{40}$/u)), expectedKey: z.string().regex(/^[a-f0-9]{64}$/u), createdAt: Iso, leaseUntil: Iso, dispatchedAt: Iso.optional(),
}).strict();
const StateSchema = z.object({
  orgId: OrgIdSchema, projectId: z.string().min(1).max(200), version: z.number().int().min(1), enabled: z.boolean(), images: z.array(ImageSchema).max(20), job: JobSchema.optional(),
  resetRequested: z.boolean().optional(), archived: z.boolean().optional(), deleted: z.boolean().optional(), deletedAt: Iso.optional(), registryPurgedAt: Iso.optional(), lastResetAt: Iso.optional(),
  lastResetRequestId: z.string().max(100).optional(), lastPushAt: Iso.optional(), lastTaskAt: Iso.optional(), lastRebuildReason: z.enum(["no_image", "key_changed", "max_age", "stale", "reset"]).optional(),
  lastFailureAt: Iso.optional(), lastFailure: z.string().max(60).optional(), health: z.enum(["never_proved", "healthy", "needs_repair"]),
}).strict();

/** The stored attributes that are not part of the state (keys, entity type, the due index) are dropped. Undefined for a row that does not read back. */
function stateOf(raw: Row | undefined): SavedEnvState | undefined {
  if (raw === undefined) return undefined;
  const { pk: _pk, sk: _sk, entityType: _type, [WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]: _duePk, [WORKFLOW_DISPATCH_DUE_INDEX.sortKey]: _dueSk, ...rest } = raw;
  void _pk; void _sk; void _type; void _duePk; void _dueSk;
  const parsed = StateSchema.safeParse(rest);
  return parsed.success ? (parsed.data as SavedEnvState) : undefined;
}

/** The registry deletion of a deleted row is final once it finished after `deletedAt` plus `leaseMs`. */
function purgeFinal(state: Pick<SavedEnvState, "deletedAt" | "registryPurgedAt">, leaseMs: number): boolean {
  if (state.registryPurgedAt === undefined) return false;
  const deletedAt = Date.parse(state.deletedAt ?? state.registryPurgedAt);
  return !(Date.parse(state.registryPurgedAt) < deletedAt + leaseMs);
}

/** The due attributes of a row: only a deleted row whose purge is not final has them. First due at the delete, then again at `deletedAt` plus a lease. */
function dueAttributes(state: SavedEnvState): Row {
  if (state.deleted !== true || purgeFinal(state, SAVED_ENV_JOB_LEASE_MS)) return {};
  const deletedAt = Date.parse(state.deletedAt ?? "") || 0;
  const at = state.registryPurgedAt === undefined ? deletedAt : deletedAt + SAVED_ENV_JOB_LEASE_MS;
  return { [WORKFLOW_DISPATCH_DUE_INDEX.partitionKey]: SAVED_ENV_PURGE_PARTITION, [WORKFLOW_DISPATCH_DUE_INDEX.sortKey]: `${dueKey(at)}#${state.orgId}#${state.projectId}` };
}

/** The ledger event of one entry, or undefined for `activity` (the row's times only). The actor is the person for a Reset, the system otherwise; the facts are fixed words, a digest and a count. */
export function savedEnvAuditEvent(entry: SavedEnvAuditEntry, version: number | undefined): AuditEventInput | undefined {
  if (entry.action === "activity") return undefined;
  return auditSavedEnvChanged({
    orgId: entry.orgId, actor: entry.actor === undefined ? { kind: "system", id: "rovara" } : { kind: "member", id: entry.actor }, occurredAt: entry.at,
    occurrence: version === undefined ? auditOccurrence(entry.projectId, entry.at, entry.action, entry.digest ?? entry.reason ?? "") : auditOccurrence(entry.projectId, String(version), entry.action),
    projectName: entry.projectId, change: entry.action, ...(entry.reason === undefined ? {} : { cause: entry.reason.slice(0, 60) }), ...(entry.digest === undefined ? {} : { digest: entry.digest }), ...(entry.count === undefined ? {} : { count: entry.count }),
  });
}

export function dynamoSavedEnvStore(table: SavedEnvTable): SavedEnvStore {
  const read = async (orgId: string, projectId: string): Promise<Row | undefined> => ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: rowKey(orgId, projectId), ConsistentRead: true }))) as { Item?: Row }).Item;

  return {
    async get(orgId, projectId) {
      if (!OrgIdSchema.safeParse(orgId).success || projectId.length === 0 || projectId.length > 200) return undefined;
      const raw = await read(orgId, projectId);
      if (raw === undefined) return undefined;
      const state = stateOf(raw);
      // A row that exists and does not read back is an error, never "no row": "no row" would let a first write replace it.
      if (state === undefined) throw unavailable();
      return state;
    },

    async commit(next, expectedVersion, entry) {
      if (!OrgIdSchema.safeParse(next.orgId).success || next.orgId !== entry.orgId || next.projectId !== entry.projectId) return false;
      const parsed = StateSchema.safeParse(next);
      if (!parsed.success) return false;
      if (expectedVersion === null ? next.version !== 1 : next.version !== expectedVersion + 1) return false;
      const event = savedEnvAuditEvent(entry, next.version);
      if (event !== undefined && table.audit === undefined) throw auditUnavailable();
      const audit = event === undefined || table.audit === undefined ? [] : auditPending({ audit: table.audit }, event);
      if (event !== undefined && audit.length === 0) throw auditUnavailable();
      const fence = expectedVersion === null
        ? { ConditionExpression: "attribute_not_exists(pk)" }
        : { ConditionExpression: "#version = :expected", ExpressionAttributeNames: { "#version": "version" }, ExpressionAttributeValues: { ":expected": expectedVersion } };
      const put: TransactItem = { Put: { TableName: table.tableName, Item: { ...rowKey(next.orgId, next.projectId), entityType: "SAVED_ENV", ...(JSON.parse(JSON.stringify(parsed.data)) as Row), ...dueAttributes(parsed.data as SavedEnvState) }, ...fence } };
      try { await table.documentClient.send(new TransactWriteCommand({ TransactItems: [put, ...audit] })); } catch (error) {
        if (cancelled(error)) return false;
        throw error;
      }
      if (event !== undefined && table.audit !== undefined) await flushAuditEvents({ audit: table.audit }, [event]);
      return true;
    },

    async audit(entry) {
      const event = savedEnvAuditEvent(entry, undefined);
      if (event === undefined) return;
      if (table.audit === undefined) throw auditUnavailable();
      const items = auditPending({ audit: table.audit }, event);
      if (items.length === 0) throw auditUnavailable();
      await table.documentClient.send(new TransactWriteCommand({ TransactItems: items }));
      await flushAuditEvents({ audit: table.audit }, [event]);
    },

    async deletedNeedingPurge(leaseMs) {
      const now = (table.now ?? Date.now)();
      const result = await table.documentClient.send(new QueryCommand({
        TableName: table.tableName, IndexName: WORKFLOW_DISPATCH_DUE_INDEX.name,
        KeyConditionExpression: `${WORKFLOW_DISPATCH_DUE_INDEX.partitionKey} = :pk AND ${WORKFLOW_DISPATCH_DUE_INDEX.sortKey} BETWEEN :from AND :due`,
        // "~" sorts after the "#" that follows each due time, so this includes every row due at or before now.
        ExpressionAttributeValues: { ":pk": SAVED_ENV_PURGE_PARTITION, ":from": "0", ":due": `${dueKey(now)}~` }, Limit: SAVED_ENV_PURGE_PAGE,
      })) as { Items?: Row[] };
      const out: Array<{ orgId: string; projectId: string }> = [];
      for (const raw of result.Items ?? []) {
        // The index is eventually consistent: it only names the row; the row itself says whether its deletion is still not final.
        if (typeof raw.orgId !== "string" || typeof raw.projectId !== "string" || !OrgIdSchema.safeParse(raw.orgId).success) continue;
        const fresh = stateOf(await read(raw.orgId, raw.projectId));
        if (fresh?.deleted === true && !purgeFinal(fresh, leaseMs)) out.push({ orgId: fresh.orgId, projectId: fresh.projectId });
      }
      return out;
    },
  };
}
