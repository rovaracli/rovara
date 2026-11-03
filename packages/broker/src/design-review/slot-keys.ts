// Design review stage, DR7 slice A: the model key of one reviewer slot (or the merge step) of a design-review operation.
//
// A design-review operation never has a model key of its own: every key request must name a slot of the binding the broker stored (`/v1/internal/model-access?slot=`), and gets a key minted for
// that (operation, slot) alone, able to call only that slot's resolved model (security S6 to S9, N4). The key is minted ONCE per slot and handed out again for as long as it lives (S7): the
// proxy's record of "the first call of this key" is what proves what a reviewer was sent, and a second key for the same slot would break it. The proxy cannot return a key it minted, so the key
// is kept here SEALED (AES-256-GCM under a key derived from the broker's callback signing key, bound to the org, operation, slot and key id), in the operation's own partition, expiring by TTL.
// The key id (a SHA-256, safe to store) is kept in the clear for `verifyRound`.
import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { GetCommand, PutCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, type DesignReviewBinding, type ModelSelection, type OrgId } from "@agentx/contracts";
import { queryAllItems } from "../aws/admin-reads.js";
import type { OperationRecord, StateTable } from "../aws/cancellation.js";
import { designReviewPartition, SLOT_PACKET_TTL_SECONDS, SLOT_PATTERN } from "./packet-store.js";

/** A reviewer runs at most 15 minutes and the worker asks again 60 seconds before a key expires; the key lives 5 minutes longer than both. */
export const DESIGN_REVIEW_KEY_TTL_SECONDS = 15 * 60 + 60 + 5 * 60;
/** A kept key with less than this left is treated as expired (the worker would not use it). */
export const SLOT_KEY_MIN_REMAINING_MS = 60_000;
const ENTITY = "DESIGN_REVIEW_SLOT_KEY";
const KEY_ID = /^[0-9a-f]{64}$/u;

/** What a slot of the stored binding is: a reviewer's or the merge step's, and the model it runs. */
export interface BindingSlot {
  keySlot: string;
  purpose: "reviewer" | "merge";
  role?: string;
  model: ModelSelection;
  modelRoute?: { alias: string; api: string; catalog: string } | undefined;
}

/** Looks a slot up in the STORED binding only (reviewers, and the merge step when it is a model). Anything else, malformed names included, is undefined. */
export function bindingSlotOf(binding: DesignReviewBinding, slot: string | null | undefined): BindingSlot | undefined {
  if (typeof slot !== "string" || !SLOT_PATTERN.test(slot)) return undefined;
  const reviewer = binding.reviewers.find((entry) => entry.keySlot === slot);
  if (reviewer !== undefined) return { keySlot: slot, purpose: "reviewer", role: reviewer.role, model: reviewer.model, modelRoute: reviewer.modelRoute };
  if (binding.merge !== undefined && binding.merge.keySlot === slot) return { keySlot: slot, purpose: "merge", model: binding.merge.model, modelRoute: binding.merge.modelRoute };
  return undefined;
}

const keyItem = (orgId: string, operationId: string, slot: string) => ({ pk: designReviewPartition(orgId, operationId), sk: `KEY#${slot}` });

const sealingKey = (callbackSigningKey: string): Buffer => createHmac("sha256", callbackSigningKey).update("design-review-slot-key-v1").digest();
const additionalData = (orgId: string, operationId: string, slot: string, keyId: string): Buffer => Buffer.from(`${orgId}|${operationId}|${slot}|${keyId}`, "utf8");

/** Seals a key for storage. The key id is the SHA-256 of the key, so a record whose key does not hash to its id is refused on the way back. */
export function sealSlotKey(callbackSigningKey: string, scope: { orgId: string; operationId: string; slot: string }, key: string): string {
  const keyId = createHash("sha256").update(key).digest("hex");
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", sealingKey(callbackSigningKey), iv);
  cipher.setAAD(additionalData(scope.orgId, scope.operationId, scope.slot, keyId));
  const sealed = Buffer.concat([cipher.update(key, "utf8"), cipher.final()]);
  return Buffer.concat([iv, cipher.getAuthTag(), sealed]).toString("base64");
}

function unsealSlotKey(callbackSigningKey: string, scope: { orgId: string; operationId: string; slot: string; keyId: string }, sealed: string): string | undefined {
  try {
    const raw = Buffer.from(sealed, "base64");
    if (raw.length < 12 + 16 + 1) return undefined;
    const decipher = createDecipheriv("aes-256-gcm", sealingKey(callbackSigningKey), raw.subarray(0, 12));
    decipher.setAAD(additionalData(scope.orgId, scope.operationId, scope.slot, scope.keyId));
    decipher.setAuthTag(raw.subarray(12, 28));
    const key = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
    return createHash("sha256").update(key).digest("hex") === scope.keyId ? key : undefined;
  } catch { return undefined; }
}

export interface KeptSlotKey {
  key: string;
  keyId: string;
  /** Epoch milliseconds. */
  expiresAt: number;
}

/**
 * The key already minted for a slot, when it can still be used: it is there, belongs to this org, operation and slot, opens under the broker's key, hashes to its id, and has at least
 * `SLOT_KEY_MIN_REMAINING_MS` left. Otherwise undefined, with `previousKeyId` naming the record that a new key must replace (an expired or unreadable one).
 */
export async function readSlotKey(deps: StateTable, callbackSigningKey: string, scope: { orgId: OrgId; operationId: string; slot: string }, nowMs: number): Promise<{ kept?: KeptSlotKey; previousKeyId?: string}> {
  const item = (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: keyItem(scope.orgId, scope.operationId, scope.slot), ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  if (item === undefined || item.entityType !== ENTITY || item.orgId !== scope.orgId || item.operationId !== scope.operationId || item.keySlot !== scope.slot) return {};
  const { keyId, sealed, expiresAt } = item;
  if (typeof keyId !== "string" || !KEY_ID.test(keyId)) return {};
  if (typeof sealed !== "string" || typeof expiresAt !== "number" || expiresAt - SLOT_KEY_MIN_REMAINING_MS <= nowMs) return { previousKeyId: keyId };
  const key = unsealSlotKey(callbackSigningKey, { ...scope, keyId }, sealed);
  return key === undefined ? { previousKeyId: keyId } : { kept: { key, keyId, expiresAt } };
}

export interface SlotKeyRecordInput {
  orgId: OrgId;
  operationId: string;
  slot: string;
  purpose: "reviewer" | "merge";
  key: string;
  keyId: string;
  expiresAt: number;
  budgetUsd: number;
  alias: string;
  nowMs: number;
  /** The record this one replaces (an expired key): written only if that is still what is stored. */
  previousKeyId?: string | undefined;
}

/** Keeps the key just minted for a slot. False when another request kept one first (or the replaced record changed): the caller gives its own key back and uses the stored one. */
export async function putSlotKey(deps: StateTable, callbackSigningKey: string, input: SlotKeyRecordInput): Promise<boolean> {
  try {
    await deps.documentClient.send(new PutCommand({
      TableName: deps.tableName,
      Item: {
        ...keyItem(input.orgId, input.operationId, input.slot), entityType: ENTITY, orgId: input.orgId, operationId: input.operationId, keySlot: input.slot, purpose: input.purpose,
        keyId: input.keyId, sealed: sealSlotKey(callbackSigningKey, { orgId: input.orgId, operationId: input.operationId, slot: input.slot }, input.key), expiresAt: input.expiresAt,
        budgetUsd: input.budgetUsd, alias: input.alias, createdAt: input.nowMs, [INDEX_EXPIRY_ATTRIBUTE]: Math.floor(input.nowMs / 1000) + SLOT_PACKET_TTL_SECONDS,
      },
      ...(input.previousKeyId === undefined
        ? { ConditionExpression: "attribute_not_exists(pk)" }
        : { ConditionExpression: "attribute_not_exists(pk) OR keyId = :previous", ExpressionAttributeValues: { ":previous": input.previousKeyId } }),
    }));
    return true;
  } catch (error) {
    if ((error as { name?: string }).name === "ConditionalCheckFailedException") return false;
    throw error;
  }
}

/**
 * The id a design-review operation's OWN key would have. None is ever minted (a request without a slot is refused, and nothing else hands the operation a key), so this is a placeholder that no real
 * key can equal. `verifyRound` still refuses a slot key that equals it, so the check is in place; the guarantee itself is the route's refusal.
 */
export const designReviewNoOperationKeyId = (operationId: string): string => createHash("sha256").update(`design-review:no-operation-key:${operationId}`).digest("hex");

export interface DesignReviewKeyIds {
  /** The key id minted for each slot (reviewer slots and the merge slot), by key slot. A slot that was never asked for has none. */
  bySlot: ReadonlyMap<string, string>;
  /** The merge step's key id (`verifyRound`'s `mergeKeyId`), when the binding has a merge step and it asked. */
  mergeKeyId?: string;
  /** The operation's own key (`verifyRound`'s `operationKeyId`): none is ever minted, so a placeholder no key can equal. */
  operationKeyId: string;
}

/**
 * What `verifyRound` needs of the keys: each reviewer's key (read it with `bySlot.get(reviewer.keySlot)`; a reviewer whose slot has no key never ran and is not verified), the merge key, and the operation key.
 * Read from the records written when the keys were minted, never from the worker.
 */
export async function designReviewKeyIds(deps: StateTable, operation: Pick<OperationRecord, "id" | "orgId" | "designReview">): Promise<DesignReviewKeyIds> {
  const bySlot = new Map<string, string>();
  const binding = operation.designReview;
  if (operation.orgId !== undefined && binding !== undefined) {
    for (const item of await queryAllItems(deps, designReviewPartition(operation.orgId, operation.id), "KEY#")) {
      if (item.entityType !== ENTITY || item.orgId !== operation.orgId || item.operationId !== operation.id || typeof item.keySlot !== "string" || typeof item.keyId !== "string" || !KEY_ID.test(item.keyId)) continue;
      if (bindingSlotOf(binding, item.keySlot) !== undefined) bySlot.set(item.keySlot, item.keyId);
    }
  }
  const mergeKeyId = binding?.merge === undefined ? undefined : bySlot.get(binding.merge.keySlot);
  return { bySlot, ...(mergeKeyId === undefined ? {} : { mergeKeyId }), operationKeyId: designReviewNoOperationKeyId(operation.id) };
}
