// Company setup recipes (SH29), the DynamoDB adapter of `SetupRecipeStore`. Rows live in the company's partition (`ORG#<id>`):
//   SETUP_RECIPE#<recipeId>              the recipe (a revoked one carries a retention time, so history is bounded);
//   SETUP_RECIPE_COUNTS                  the live (proposed + approved) and proposed counts: every write that adds one increments with a condition in the SAME transaction, so the caps cannot be raced past;
//   SETUP_RECIPE_DEDUPE#<hash>#<digest>  one marker per waiting proposal (project hash + body digest), `attribute_not_exists` on create, deleted when the proposal leaves `proposed`;
//   SETUP_LOCKS                          the company's setup locks, with a waiting loosening beside them.
// Every write is ONE TransactWriteItems: the row (conditional on the revision the caller read), the counters, the dedupe marker, the audit item, and, for the locks, the approval evidence's ConditionChecks. A cancelled
// transaction answers false (the caller then says CHANGE_STALE). A write without an audit ledger is refused: recipes and locks are company authority, so there is no unaudited path.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, SetupRecipeBodySchema, agentXError, orgPk, setupRecipeDigest, type AuditEventInput, type OrgId } from "@agentx/contracts";
import { auditOccurrence, auditSetupRecipeChange, type SetupRecipeAuditAction } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import {
  CompanySetupLocksSchema, RecipeScopeSchema, SETUP_RECIPES_MAX_PER_ORG, SETUP_RECIPES_MAX_PROPOSED,
  type RecipeAuditAction, type RecipeAuditEntry, type RecipeStatus, type SetupRecipeStore, type StoredLocks, type StoredRecipe,
} from "./setup-recipes.js";
import { z } from "zod";

type Row = Record<string, unknown>;
export interface SetupRecipeTable {
  documentClient: { send(command: unknown): Promise<unknown> };
  tableName: string;
  /** The ONE clock of the adapter and of the approval evidence (milliseconds). */
  now(): number;
  /** The Audit Ledger's outbox. Without it every write is refused. */
  audit?: AuditRuntime | undefined;
}

/** A revoked recipe is kept this long as history, then the table's expiry removes it. */
export const SETUP_RECIPE_REVOKED_KEEP_DAYS = 400;
/** The most pages one listing reads (100 rows each): a company never holds more than the caps plus the revoked history within the retention time. */
const LIST_PAGES_MAX = 30;

const recipeKey = (orgId: OrgId, recipeId: string): { pk: string; sk: string } => ({ pk: orgPk(orgId), sk: `SETUP_RECIPE#${recipeId}` });
const countsKey = (orgId: OrgId): { pk: string; sk: string } => ({ pk: orgPk(orgId), sk: "SETUP_RECIPE_COUNTS" });
const dedupeKey = (orgId: OrgId, projectHash: string, bodyDigest: string): { pk: string; sk: string } => ({ pk: orgPk(orgId), sk: `SETUP_RECIPE_DEDUPE#${projectHash}#${bodyDigest}` });
const locksKey = (orgId: OrgId): { pk: string; sk: string } => ({ pk: orgPk(orgId), sk: "SETUP_LOCKS" });

const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Company setup recipes could not be read.");
const auditUnavailable = () => agentXError("AUDIT_UNAVAILABLE", "Company setup recipes need the audit ledger.");
const cancelled = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const StoredRecipeSchema = z.object({
  orgId: OrgIdSchema, recipeId: z.string().regex(/^rcp_[a-f0-9]{20}$/u), revision: z.number().int().min(1), status: z.enum(["proposed", "approved", "revoked"]),
  body: SetupRecipeBodySchema, bodyDigest: Hex64, fingerprint: Hex64, scope: RecipeScopeSchema, proposedFromProjectHash: z.string().regex(/^[a-f0-9]{32}$/u).optional(),
  createdBy: z.string(), createdAt: z.string().datetime(), approvedBy: z.string().optional(), approvedAt: z.string().datetime().optional(), updatedAt: z.string().datetime(),
}).strict();
const StoredLocksSchema = z.object({
  orgId: OrgIdSchema, revision: z.number().int().min(1), locks: CompanySetupLocksSchema, updatedBy: z.string(), updatedAt: z.string().datetime(),
  pending: z.object({ locks: CompanySetupLocksSchema, digest: Hex64, proposedBy: z.string(), proposedAt: z.string().datetime() }).strict().optional(),
}).strict();

/** The stored attributes that are not part of the record (keys, entity type, expiry) are dropped; a row that does not parse, or whose body digest is not its body's, is no row (it is never offered or approved). */
function recipeOf(raw: Row | undefined, orgId: OrgId): StoredRecipe | undefined {
  if (raw === undefined) return undefined;
  const { pk: _pk, sk: _sk, entityType: _type, [INDEX_EXPIRY_ATTRIBUTE]: _expiry, ...rest } = raw;
  void _pk; void _sk; void _type; void _expiry;
  const parsed = StoredRecipeSchema.safeParse(rest);
  if (!parsed.success || parsed.data.orgId !== orgId || setupRecipeDigest(parsed.data.body) !== parsed.data.bodyDigest) return undefined;
  return parsed.data;
}

const isLive = (status: RecipeStatus): boolean => status === "proposed" || status === "approved";

const RECIPE_ACTIONS: Record<RecipeAuditAction, SetupRecipeAuditAction> = {
  recipe_proposed: "setup_recipe.proposed", recipe_created: "setup_recipe.created", recipe_approved: "setup_recipe.approved", recipe_revoked: "setup_recipe.revoked", recipe_scope_changed: "setup_recipe.scope_changed",
  locks_changed: "setup_locks.changed", locks_change_proposed: "setup_locks.proposed", locks_change_approved: "setup_locks.approved",
};

/** The audit event of one entry: the actor is the person, the target the company, the facts ids, digests and fixed words. */
export function recipeAuditEvent(entry: RecipeAuditEntry): AuditEventInput {
  const action = RECIPE_ACTIONS[entry.action];
  const isRecipe = entry.recipeId !== undefined;
  return auditSetupRecipeChange({
    orgId: entry.orgId, actor: { kind: "member", id: entry.actor }, occurredAt: entry.at, occurrence: auditOccurrence(entry.recipeId ?? "locks", String(entry.revision ?? 0), entry.action), action,
    facts: isRecipe
      ? { recipeId: entry.recipeId, revision: entry.revision, bodyDigest: entry.bodyDigest, authority: entry.proof }
      : { revision: entry.revision, previousDigest: entry.previousDigest, nextDigest: entry.nextDigest, loosened: entry.loosened, authority: entry.proof, approvalMode: entry.approvalMode, membershipVersion: entry.membershipVersion },
  });
}

export function dynamoSetupRecipeStore(table: SetupRecipeTable): SetupRecipeStore {
  const get = async (key: { pk: string; sk: string }): Promise<Row | undefined> => ((await table.documentClient.send(new GetCommand({ TableName: table.tableName, Key: key, ConsistentRead: true }))) as { Item?: Row }).Item;

  /** Sends one transaction; false when it was cancelled (a changed row, a full counter, a failed approval condition). The audit event is delivered after the commit. */
  async function transact(items: TransactItem[], event: AuditEventInput): Promise<boolean> {
    if (table.audit === undefined) throw auditUnavailable();
    const audit = auditPending({ audit: table.audit }, event);
    if (audit.length === 0) throw auditUnavailable();
    try { await table.documentClient.send(new TransactWriteCommand({ TransactItems: [...items, ...audit] })); } catch (error) {
      if (cancelled(error)) return false;
      throw error;
    }
    await flushAuditEvents({ audit: table.audit }, [event]);
    return true;
  }

  return {
    async getRecipe(orgId, recipeId) {
      if (!OrgIdSchema.safeParse(orgId).success || !/^rcp_[a-f0-9]{20}$/u.test(recipeId)) return undefined;
      return recipeOf(await get(recipeKey(orgId, recipeId)), orgId);
    },

    async listRecipes(orgId, limit, statuses) {
      if (!OrgIdSchema.safeParse(orgId).success) return [];
      const out: StoredRecipe[] = [];
      let start: Row | undefined;
      for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
        const result = await table.documentClient.send(new QueryCommand({
          TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": "SETUP_RECIPE#" },
          ConsistentRead: true, Limit: 100, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
        })) as { Items?: Row[]; LastEvaluatedKey?: Row };
        for (const raw of result.Items ?? []) {
          const recipe = recipeOf(raw, orgId);
          if (recipe !== undefined && (statuses === undefined || statuses.includes(recipe.status))) out.push(recipe);
          if (out.length >= limit) return out;
        }
        start = result.LastEvaluatedKey;
        if (start === undefined) return out;
      }
      // Never a partial list passed off as everything.
      throw unavailable();
    },

    async commitRecipe(next, expectedRevision, entry) {
      if (!OrgIdSchema.safeParse(next.orgId).success || next.orgId !== entry.orgId) return false;
      let previous: StoredRecipe | undefined;
      if (expectedRevision !== null) {
        previous = recipeOf(await get(recipeKey(next.orgId, next.recipeId)), next.orgId);
        if (previous === undefined || previous.revision !== expectedRevision) return false;
      }
      const nowMs = table.now();
      const live = (isLive(next.status) ? 1 : 0) - (previous !== undefined && isLive(previous.status) ? 1 : 0);
      const proposed = (next.status === "proposed" ? 1 : 0) - (previous?.status === "proposed" ? 1 : 0);
      const items: TransactItem[] = [{ Put: {
        TableName: table.tableName,
        Item: {
          ...recipeKey(next.orgId, next.recipeId), entityType: "SETUP_RECIPE", ...next,
          ...(next.status === "revoked" ? { [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(nowMs / 1000) + SETUP_RECIPE_REVOKED_KEEP_DAYS * 86_400 } : {}),
        },
        ...(expectedRevision === null ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": expectedRevision } }),
      } }];
      if (live !== 0 || proposed !== 0) {
        const names: Record<string, string> = { "#live": "live", "#proposed": "proposed" };
        const values: Record<string, unknown> = { ":zero": 0, ":dl": live, ":dp": proposed, ":type": "SETUP_RECIPE_COUNTS" };
        const conditions: string[] = [];
        if (live > 0) { conditions.push("(attribute_not_exists(#live) OR #live < :maxLive)"); values[":maxLive"] = SETUP_RECIPES_MAX_PER_ORG; }
        if (proposed > 0) { conditions.push("(attribute_not_exists(#proposed) OR #proposed < :maxProposed)"); values[":maxProposed"] = SETUP_RECIPES_MAX_PROPOSED; }
        items.push({ Update: {
          TableName: table.tableName, Key: countsKey(next.orgId), UpdateExpression: "SET #live = if_not_exists(#live, :zero) + :dl, #proposed = if_not_exists(#proposed, :zero) + :dp, entityType = :type",
          ExpressionAttributeNames: names, ExpressionAttributeValues: values, ...(conditions.length === 0 ? {} : { ConditionExpression: conditions.join(" AND ") }),
        } });
      }
      if (next.proposedFromProjectHash !== undefined) {
        const marker = dedupeKey(next.orgId, next.proposedFromProjectHash, next.bodyDigest);
        if (expectedRevision === null && next.status === "proposed") items.push({ Put: { TableName: table.tableName, Item: { ...marker, entityType: "SETUP_RECIPE_DEDUPE", orgId: next.orgId, recipeId: next.recipeId }, ConditionExpression: "attribute_not_exists(pk)" } });
        else if (previous?.status === "proposed" && next.status !== "proposed") items.push({ Delete: { TableName: table.tableName, Key: marker } });
      }
      return transact(items, recipeAuditEvent(entry));
    },

    async getLocks(orgId) {
      if (!OrgIdSchema.safeParse(orgId).success) return undefined;
      const raw = await get(locksKey(orgId));
      if (raw === undefined) return undefined;
      const { pk: _pk, sk: _sk, entityType: _type, ...rest } = raw;
      void _pk; void _sk; void _type;
      const parsed = StoredLocksSchema.safeParse(rest);
      // A locks row that does not read back is an error, never "no locks": a damaged row must not loosen anything.
      if (!parsed.success || parsed.data.orgId !== orgId) throw unavailable();
      return parsed.data as StoredLocks;
    },

    async commitLocks(next, expectedRevision, entry, conditions) {
      if (!OrgIdSchema.safeParse(next.orgId).success || next.orgId !== entry.orgId || (conditions as unknown) === undefined) return false;
      const items: TransactItem[] = [{ Put: {
        TableName: table.tableName, Item: { ...locksKey(next.orgId), entityType: "SETUP_LOCKS", ...next },
        ...(expectedRevision === null ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": expectedRevision } }),
      } }, ...conditions];
      return transact(items, recipeAuditEvent(entry));
    },
  };
}
