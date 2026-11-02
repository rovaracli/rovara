// Company setup recipes (SH29), the DynamoDB adapter of `SetupRecipeStore`. Rows live in the company's partition (`ORG#<id>`):
//   SETUP_RECIPE#<recipeId>              the recipe (a revoked one carries a retention time, so history is bounded);
//   SETUP_RECIPE_COUNTS                  the live (proposed + approved) and proposed counts: every write that adds one increments with a condition in the SAME transaction, so the caps cannot be raced past;
//   SETUP_RECIPE_DEDUPE#<hash>#<digest>  one marker per waiting proposal (project hash + body digest), `attribute_not_exists` on create, deleted when the proposal leaves `proposed`;
// The company's setup LOCKS are not here: lane su-musts owns them (one row, one store, one admin route, the setup.locks_* audit actions).
// A revoked or rejected recipe MOVES, in the same transaction, to SETUP_RECIPE_REVOKED#<id>, so live queries (the offers, the caps, the admin's list) never page through history. Every write is ONE TransactWriteItems: the row (conditional on the revision the caller read), the counters, the dedupe marker and the audit item. A cancelled
// transaction answers false (the caller then says CHANGE_STALE). A write without an audit ledger is refused: recipes and locks are company authority, so there is no unaudited path.
import { GetCommand, QueryCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, OrgIdSchema, SetupRecipeBodySchema, agentXError, orgPk, setupRecipeDigest, type AuditEventInput, type OrgId } from "@agentx/contracts";
import { auditOccurrence, auditSetupRecipeChange, type SetupRecipeAuditAction } from "../audit/events.js";
import { flushAuditEvents } from "../audit/flush.js";
import { auditPending, type AuditRuntime, type TransactItem } from "../audit/outbox.js";
import {
  RecipeScopeSchema, SETUP_RECIPES_MAX_PER_ORG, SETUP_RECIPES_MAX_PROPOSED,
  type RecipeAuditAction, type RecipeAuditEntry, type RecipeStatus, type SetupRecipeRowStore, type StoredRecipe,
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
/** The most pages the LIVE listing reads (100 rows each): the live partition holds at most the caps (200 recipes), so more than this is a damaged table, not history. */
const LIST_PAGES_MAX = 10;
/** The most pages of revoked history one listing reads. History is bounded by retention but never by count, so a listing takes what fits and never throws on its size. */
const REVOKED_PAGES_MAX = 3;

const revokedKey = (orgId: OrgId, recipeId: string): { pk: string; sk: string } => ({ pk: orgPk(orgId), sk: `SETUP_RECIPE_REVOKED#${recipeId}` });
const recipeKey = (orgId: OrgId, recipeId: string): { pk: string; sk: string } => ({ pk: orgPk(orgId), sk: `SETUP_RECIPE#${recipeId}` });
const countsKey = (orgId: OrgId): { pk: string; sk: string } => ({ pk: orgPk(orgId), sk: "SETUP_RECIPE_COUNTS" });
const dedupeKey = (orgId: OrgId, projectHash: string, bodyDigest: string): { pk: string; sk: string } => ({ pk: orgPk(orgId), sk: `SETUP_RECIPE_DEDUPE#${projectHash}#${bodyDigest}` });

const unavailable = () => agentXError("RUNTIME_UNAVAILABLE", "Company setup recipes could not be read.");
const auditUnavailable = () => agentXError("AUDIT_UNAVAILABLE", "Company setup recipes need the audit ledger.");
const cancelled = (error: unknown): boolean => error instanceof Error && (error.name === "TransactionCanceledException" || error.name === "ConditionalCheckFailedException");

const Hex64 = z.string().regex(/^[a-f0-9]{64}$/u);
const StoredRecipeSchema = z.object({
  orgId: OrgIdSchema, recipeId: z.string().regex(/^rcp_[a-f0-9]{20}$/u), revision: z.number().int().min(1), status: z.enum(["proposed", "approved", "revoked"]),
  body: SetupRecipeBodySchema, bodyDigest: Hex64, fingerprint: Hex64, scope: RecipeScopeSchema, proposedFromProjectHash: z.string().regex(/^[a-f0-9]{32}$/u).optional(),
  createdBy: z.string(), createdAt: z.string().datetime(), approvedBy: z.string().optional(), approvedAt: z.string().datetime().optional(), updatedAt: z.string().datetime(),
}).strict();
/** The stored attributes that are not part of the record (keys, entity type, expiry) are dropped; a row that does not parse, or whose body digest is not its body's, is no row (it is never offered or approved). */
function recipeOf(raw: Row | undefined, orgId: OrgId): StoredRecipe | undefined {
  if (raw === undefined) return undefined;
  const { pk: _pk, sk: _sk, entityType: _type, [INDEX_EXPIRY_ATTRIBUTE]: _expiry, ...rest } = raw;
  void _pk; void _sk; void _type; void _expiry;
  const parsed = StoredRecipeSchema.safeParse(rest);
  if (!parsed.success || parsed.data.orgId !== orgId || setupRecipeDigest(parsed.data.body) !== parsed.data.bodyDigest) return undefined;
  return parsed.data as StoredRecipe;
}

const isLive = (status: RecipeStatus): boolean => status === "proposed" || status === "approved";

const RECIPE_ACTIONS: Partial<Record<RecipeAuditAction, SetupRecipeAuditAction>> = {
  recipe_proposed: "setup_recipe.proposed", recipe_created: "setup_recipe.created", recipe_approved: "setup_recipe.approved", recipe_revoked: "setup_recipe.revoked", recipe_scope_changed: "setup_recipe.scope_changed",
};

/** The audit event of one recipe entry: the actor is the person, the target the company, the facts ids, digests and fixed words. A locks entry is not this store's (su-musts owns the locks' audit). */
export function recipeAuditEvent(entry: RecipeAuditEntry): AuditEventInput {
  const action = RECIPE_ACTIONS[entry.action];
  if (action === undefined || entry.recipeId === undefined) throw agentXError("CONFIG_INVALID", "That is not a setup recipe change.");
  return auditSetupRecipeChange({
    orgId: entry.orgId, actor: { kind: "member", id: entry.actor }, occurredAt: entry.at, occurrence: auditOccurrence(entry.recipeId, String(entry.revision ?? 0), entry.action), action,
    facts: { recipeId: entry.recipeId, revision: entry.revision, bodyDigest: entry.bodyDigest, authority: entry.proof },
  });
}

export function dynamoSetupRecipeStore(table: SetupRecipeTable): SetupRecipeRowStore {
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


  function countsUpdate(orgId: OrgId, live: number, proposed: number): TransactItem {
    const names: Record<string, string> = { "#live": "live", "#proposed": "proposed" };
    const values: Record<string, unknown> = { ":zero": 0, ":dl": live, ":dp": proposed, ":type": "SETUP_RECIPE_COUNTS" };
    const conditions: string[] = [];
    if (live > 0) { conditions.push("(attribute_not_exists(#live) OR #live < :maxLive)"); values[":maxLive"] = SETUP_RECIPES_MAX_PER_ORG; }
    if (proposed > 0) { conditions.push("(attribute_not_exists(#proposed) OR #proposed < :maxProposed)"); values[":maxProposed"] = SETUP_RECIPES_MAX_PROPOSED; }
    if (live < 0) { conditions.push("#live >= :one"); values[":one"] = -live; }
    if (proposed < 0) { conditions.push("#proposed >= :oneProposed"); values[":oneProposed"] = -proposed; }
    return { Update: {
      TableName: table.tableName, Key: countsKey(orgId), UpdateExpression: "SET #live = if_not_exists(#live, :zero) + :dl, #proposed = if_not_exists(#proposed, :zero) + :dp, entityType = :type",
      ExpressionAttributeNames: names, ExpressionAttributeValues: values, ...(conditions.length === 0 ? {} : { ConditionExpression: conditions.join(" AND ") }),
    } };
  }

  const pageOf = async (orgId: OrgId, prefix: string, start: Row | undefined) => await table.documentClient.send(new QueryCommand({
    TableName: table.tableName, KeyConditionExpression: "pk = :pk AND begins_with(sk, :prefix)", ExpressionAttributeValues: { ":pk": orgPk(orgId), ":prefix": prefix },
    ConsistentRead: true, Limit: 100, ...(start === undefined ? {} : { ExclusiveStartKey: start }),
  })) as { Items?: Row[]; LastEvaluatedKey?: Row };
  const expiry = (nowMs: number): number => Math.floor(nowMs / 1000) + SETUP_RECIPE_REVOKED_KEEP_DAYS * 86_400;

  /** The recipe and where it lives: the live partition first, then the revoked one. */
  async function find(orgId: OrgId, recipeId: string): Promise<{ recipe: StoredRecipe; where: "live" | "revoked" } | undefined> {
    const live = recipeOf(await get(recipeKey(orgId, recipeId)), orgId);
    if (live !== undefined) return { recipe: live, where: "live" };
    const revoked = recipeOf(await get(revokedKey(orgId, recipeId)), orgId);
    return revoked === undefined ? undefined : { recipe: revoked, where: "revoked" };
  }

  return {
    async getRecipe(orgId, recipeId) {
      if (!OrgIdSchema.safeParse(orgId).success || !/^rcp_[a-f0-9]{20}$/u.test(recipeId)) return undefined;
      return (await find(orgId, recipeId))?.recipe;
    },

    async listRecipes(orgId, limit, statuses) {
      if (!OrgIdSchema.safeParse(orgId).success) return [];
      const out: StoredRecipe[] = [];
      const wanted = (status: RecipeStatus): boolean => statuses === undefined || statuses.includes(status);
      if (statuses === undefined || statuses.some(isLive)) {
        let start: Row | undefined;
        let finished = false;
        for (let page = 0; page < LIST_PAGES_MAX && !finished; page += 1) {
          const result = await pageOf(orgId, "SETUP_RECIPE#", start);
          for (const raw of result.Items ?? []) {
            const recipe = recipeOf(raw, orgId);
            if (recipe !== undefined && wanted(recipe.status)) out.push(recipe);
            if (out.length >= limit) return out;
          }
          start = result.LastEvaluatedKey;
          finished = start === undefined;
        }
        // The live partition is bounded by the caps; never a partial live list passed off as everything.
        if (!finished) throw unavailable();
      }
      if (wanted("revoked")) {
        // History: whatever fits, never an error for its size.
        let start: Row | undefined;
        for (let page = 0; page < REVOKED_PAGES_MAX; page += 1) {
          const result = await pageOf(orgId, "SETUP_RECIPE_REVOKED#", start);
          for (const raw of result.Items ?? []) {
            const recipe = recipeOf(raw, orgId);
            if (recipe !== undefined) out.push(recipe);
            if (out.length >= limit) return out;
          }
          start = result.LastEvaluatedKey;
          if (start === undefined) break;
        }
      }
      return out;
    },

    async commitRecipe(next, expectedRevision, entry) {
      if (!OrgIdSchema.safeParse(next.orgId).success || next.orgId !== entry.orgId) return false;
      let previous: { recipe: StoredRecipe; where: "live" | "revoked" } | undefined;
      if (expectedRevision !== null) {
        previous = await find(next.orgId, next.recipeId);
        if (previous === undefined || previous.recipe.revision !== expectedRevision) return false;
        // A revoked recipe never comes back to life.
        if (previous.where === "revoked" && next.status !== "revoked") return false;
      }
      const nowMs = table.now();
      const was = previous?.where === "live" ? previous.recipe.status : undefined;
      const live = (isLive(next.status) ? 1 : 0) - (was !== undefined && isLive(was) ? 1 : 0);
      const proposed = (next.status === "proposed" ? 1 : 0) - (was === "proposed" ? 1 : 0);
      const fence = expectedRevision === null ? { ConditionExpression: "attribute_not_exists(pk)" } : { ConditionExpression: "#revision = :expected", ExpressionAttributeNames: { "#revision": "revision" }, ExpressionAttributeValues: { ":expected": expectedRevision } };
      const items: TransactItem[] = [];
      if (next.status === "revoked") {
        // History moves out of the live partition in the same transaction: the revoked row is new, or the revoked row's next revision; the live row it replaces is deleted at the revision read.
        items.push({ Put: { TableName: table.tableName, Item: { ...revokedKey(next.orgId, next.recipeId), entityType: "SETUP_RECIPE", ...next, [INDEX_EXPIRY_ATTRIBUTE]: expiry(nowMs) }, ...(previous?.where === "revoked" ? fence : { ConditionExpression: "attribute_not_exists(pk)" }) } });
        if (previous?.where === "live") items.push({ Delete: { TableName: table.tableName, Key: recipeKey(next.orgId, next.recipeId), ...fence } });
      } else {
        items.push({ Put: { TableName: table.tableName, Item: { ...recipeKey(next.orgId, next.recipeId), entityType: "SETUP_RECIPE", ...next }, ...fence } });
      }
      if (live !== 0 || proposed !== 0) items.push(countsUpdate(next.orgId, live, proposed));
      if (next.proposedFromProjectHash !== undefined) {
        const marker = dedupeKey(next.orgId, next.proposedFromProjectHash, next.bodyDigest);
        if (expectedRevision === null && next.status === "proposed") items.push({ Put: { TableName: table.tableName, Item: { ...marker, entityType: "SETUP_RECIPE_DEDUPE", orgId: next.orgId, recipeId: next.recipeId }, ConditionExpression: "attribute_not_exists(pk)" } });
        else if (was === "proposed" && next.status !== "proposed") items.push({ Delete: { TableName: table.tableName, Key: marker } });
      }
      return transact(items, recipeAuditEvent(entry));
    },

    async unreadableIds(orgId) {
      if (!OrgIdSchema.safeParse(orgId).success) return [];
      const ids: string[] = [];
      let start: Row | undefined;
      for (let page = 0; page < LIST_PAGES_MAX; page += 1) {
        const result = await pageOf(orgId, "SETUP_RECIPE#", start);
        for (const raw of result.Items ?? []) if (recipeOf(raw, orgId) === undefined && typeof raw.sk === "string") ids.push(raw.sk.slice("SETUP_RECIPE#".length));
        start = result.LastEvaluatedKey;
        if (start === undefined) break;
      }
      return ids.filter((id) => /^rcp_[a-f0-9]{20}$/u.test(id)).slice(0, 50);
    },

    async revokeUnreadable(orgId, recipeId, entry) {
      if (!OrgIdSchema.safeParse(orgId).success || orgId !== entry.orgId || !/^rcp_[a-f0-9]{20}$/u.test(recipeId)) return false;
      const raw = await get(recipeKey(orgId, recipeId));
      // Only a row that exists and does not read back; a readable one is revoked the normal way.
      if (raw === undefined || recipeOf(raw, orgId) !== undefined) return false;
      const wasProposed = raw.status === "proposed";
      const revision = (typeof raw.revision === "number" && Number.isSafeInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0) + 1;
      const digest = typeof raw.bodyDigest === "string" && /^[a-f0-9]{64}$/u.test(raw.bodyDigest) ? raw.bodyDigest : "0".repeat(64);
      const base: TransactItem[] = [
        { Put: { TableName: table.tableName, Item: { ...revokedKey(orgId, recipeId), entityType: "SETUP_RECIPE", orgId, recipeId, status: "revoked", revision, unreadable: true, updatedAt: new Date(table.now()).toISOString(), [INDEX_EXPIRY_ATTRIBUTE]: expiry(table.now()) }, ConditionExpression: "attribute_not_exists(pk)" } },
        { Delete: { TableName: table.tableName, Key: recipeKey(orgId, recipeId), ConditionExpression: "attribute_exists(pk)" } },
        ...(wasProposed && typeof raw.proposedFromProjectHash === "string" ? [{ Delete: { TableName: table.tableName, Key: dedupeKey(orgId, raw.proposedFromProjectHash, digest) } }] : []),
      ];
      const event = recipeAuditEvent({ ...entry, recipeId, revision, bodyDigest: digest });
      // Free the counter slot (the row counted when it was written). A counter that has drifted to zero cannot be lowered, and must not keep the unreadable row alive: the second try removes the row alone.
      if (await transact([...base, countsUpdate(orgId, -1, wasProposed ? -1 : 0)], event)) return true;
      return transact(base, event);
    },
  };
}
