// Design review stage, DR7 slice A: where the packet built for each reviewer slot is KEPT between the broker building it and the worker fetching it (`GET /v1/internal/design-review/packet`).
// The route serves these stored bytes and never rebuilds a packet: a re-read MCP item gets a new `fetchedAt`, which would change the digest the binding already carries (security S3).
//
// Layout, all in the state table under one org-scoped partition per operation, each item expiring by the table's TTL (`SLOT_PACKET_TTL_SECONDS`):
//   pk  ORG#<orgId>#DESIGN_REVIEW#<operationId>
//   sk  PACKET#<slot>#HEAD        the sizes and the SHA-256 of the stored text; written with the chunks in ONE transaction, never overwritten by a different packet
//   sk  PACKET#<slot>#C<nn>       the stored text (gzip, base64) in chunks small enough for an item (a packet can be 400 KB and a table item is limited to 400 KB)
// The stored text is the JSON of the packet's delivery fields only (`PacketDeliverySchema`: nothing of the broker's bookkeeping, estimates, omitted lists or other slots).
//
// Slice B calls `putSlotPackets` when it dispatches a round (before the operation is sent; if it throws, nothing is dispatched) and `removeSlotPackets` when the round is recorded.
import { createHash } from "node:crypto";
import { gunzipSync, gzipSync } from "node:zlib";
import { GetCommand, TransactWriteCommand } from "@aws-sdk/lib-dynamodb";
import { INDEX_EXPIRY_ATTRIBUTE, PACKET_DELIVERY_BYTES_MAX, PacketDeliverySchema, agentXError, type OrgId } from "@agentx/contracts";
import { queryAllItems } from "../aws/admin-reads.js";
import type { StateTable } from "../aws/cancellation.js";
import { failedIndexes } from "../agents/table-writes.js";
import type { PacketDelivery } from "./packet.js";

/** How long a stored packet lives: far past any reviewer run (a round has a time limit of minutes), short enough that repository text does not stay. */
export const SLOT_PACKET_TTL_SECONDS = 24 * 60 * 60;
/** Each chunk is this many base64 characters (ASCII, so one byte each): well inside an item. */
const CHUNK_CHARS = 250_000;
/** A delivery is at most this many bytes of JSON (the contract's limit); more is refused at the write. */
export const SLOT_PACKET_BYTES_MAX = PACKET_DELIVERY_BYTES_MAX;
/** A key slot, as the binding names it. */
export const SLOT_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/;
const ENTITY = "DESIGN_REVIEW_PACKET";

export const designReviewPartition = (orgId: string, operationId: string): string => `ORG#${orgId}#DESIGN_REVIEW#${operationId}`;
const headKey = (orgId: string, operationId: string, slot: string) => ({ pk: designReviewPartition(orgId, operationId), sk: `PACKET#${slot}#HEAD` });
const chunkKey = (orgId: string, operationId: string, slot: string, index: number) => ({ pk: designReviewPartition(orgId, operationId), sk: `PACKET#${slot}#C${String(index).padStart(2, "0")}` });

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The delivery fields of a built packet (and only those: the builder's bookkeeping, estimates and omitted lists are left behind), as the exact JSON text that is stored and served. A value the contract refuses is a refusal. */
export function packetTextOf(packet: PacketDelivery): string {
  const delivery = PacketDeliverySchema.parse({
    role: packet.role, rolePrompt: { id: packet.rolePrompt.id, version: packet.rolePrompt.version, text: packet.rolePrompt.text },
    documents: packet.documents.map((document) => ({ kind: document.kind, ref: document.ref, commitOrFetchedAt: document.commitOrFetchedAt, text: document.text })),
    ...(packet.request === undefined ? {} : { request: packet.request }),
  });
  const text = JSON.stringify(delivery);
  if (Buffer.byteLength(text, "utf8") > SLOT_PACKET_BYTES_MAX) throw agentXError("CONFIG_INVALID", "a reviewer's packet is too large to deliver");
  return text;
}

export interface SlotPacketInput {
  keySlot: string;
  packet: PacketDelivery;
}

export interface SlotPacketStoreInput {
  orgId: OrgId;
  operationId: string;
  packets: readonly SlotPacketInput[];
  nowMs: number;
}

/**
 * Stores the packet of every slot of a round. One transaction per slot (the head and its chunks together). A slot that already holds the SAME text is left as it is (a retried dispatch); one that holds
 * a different text is refused, because the packet a slot serves must not change once it exists. Throws on any failure: the caller must not dispatch the round.
 */
export async function putSlotPackets(deps: StateTable, input: SlotPacketStoreInput): Promise<void> {
  const slots = input.packets.map((entry) => entry.keySlot);
  if (new Set(slots).size !== slots.length) throw agentXError("CONFIG_INVALID", "a key slot holds one packet");
  const expires = Math.floor(input.nowMs / 1000) + SLOT_PACKET_TTL_SECONDS;
  for (const { keySlot, packet } of input.packets) {
    if (!SLOT_PATTERN.test(keySlot)) throw agentXError("CONFIG_INVALID", "a key slot is not valid");
    const text = packetTextOf(packet);
    const encoded = gzipSync(Buffer.from(text, "utf8")).toString("base64");
    const chunks: string[] = [];
    for (let start = 0; start < encoded.length; start += CHUNK_CHARS) chunks.push(encoded.slice(start, start + CHUNK_CHARS));
    const common = { entityType: ENTITY, orgId: input.orgId, operationId: input.operationId, keySlot, [INDEX_EXPIRY_ATTRIBUTE]: expires };
    try {
      await deps.documentClient.send(new TransactWriteCommand({ TransactItems: [
        { Put: { TableName: deps.tableName, Item: { ...headKey(input.orgId, input.operationId, keySlot), ...common, chunks: chunks.length, bytes: Buffer.byteLength(text, "utf8"), textSha256: sha256(text), role: packet.role, createdAt: input.nowMs }, ConditionExpression: "attribute_not_exists(pk)" } },
        ...chunks.map((chunk, index) => ({ Put: { TableName: deps.tableName, Item: { ...chunkKey(input.orgId, input.operationId, keySlot, index), ...common, chunk } } })),
      ] }));
    } catch (error) {
      const failed = failedIndexes(error);
      if (failed === undefined || failed.size === 0) throw error;
      // Already there: fine only when it is the same packet.
      const kept = await readSlotPacket(deps, input.orgId, input.operationId, keySlot);
      if (kept?.text !== text) throw agentXError("CONFIG_INVALID", "a different packet is already stored for this key slot");
    }
  }
}

export interface StoredSlotPacket {
  /** The exact JSON text of the delivery, as stored. Served byte for byte. */
  text: string;
  role: string;
  bytes: number;
}

/**
 * The packet stored for a slot of an operation, or undefined when there is none, when any piece is missing, or when what is read no longer matches the sizes and digest written with it (fail closed: a damaged
 * or tampered packet is never served). Both the org and the operation are part of the key, so another org's operation id reads nothing.
 */
export async function readSlotPacket(deps: StateTable, orgId: OrgId, operationId: string, keySlot: string): Promise<StoredSlotPacket | undefined> {
  if (!SLOT_PATTERN.test(keySlot)) return undefined;
  const get = async (key: { pk: string; sk: string }): Promise<Record<string, unknown> | undefined> =>
    (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: key, ConsistentRead: true })) as { Item?: Record<string, unknown> }).Item;
  const head = await get(headKey(orgId, operationId, keySlot));
  if (head === undefined || head.entityType !== ENTITY || head.orgId !== orgId || head.operationId !== operationId || head.keySlot !== keySlot) return undefined;
  const { chunks, bytes, textSha256, role } = head;
  if (typeof chunks !== "number" || !Number.isInteger(chunks) || chunks < 1 || chunks > 16 || typeof bytes !== "number" || typeof textSha256 !== "string" || typeof role !== "string") return undefined;
  let encoded = "";
  for (let index = 0; index < chunks; index += 1) {
    const piece = await get(chunkKey(orgId, operationId, keySlot, index));
    if (piece === undefined || piece.orgId !== orgId || piece.operationId !== operationId || piece.keySlot !== keySlot || typeof piece.chunk !== "string") return undefined;
    encoded += piece.chunk;
  }
  let text: string;
  try { text = gunzipSync(Buffer.from(encoded, "base64"), { maxOutputLength: SLOT_PACKET_BYTES_MAX + 1 }).toString("utf8"); } catch { return undefined; }
  if (Buffer.byteLength(text, "utf8") !== bytes || bytes > SLOT_PACKET_BYTES_MAX || sha256(text) !== textSha256) return undefined;
  return { text, role, bytes };
}

/** Removes every stored packet of an operation (the round is recorded, or the operation ended). Safe to repeat. */
export async function removeSlotPackets(deps: StateTable, orgId: OrgId, operationId: string): Promise<number> {
  const items = await queryAllItems(deps, designReviewPartition(orgId, operationId), "PACKET#");
  for (let start = 0; start < items.length; start += 25) {
    await deps.documentClient.send(new TransactWriteCommand({ TransactItems: items.slice(start, start + 25).map((item) => ({ Delete: { TableName: deps.tableName, Key: { pk: item.pk as string, sk: item.sk as string } } })) }));
  }
  return items.length;
}
