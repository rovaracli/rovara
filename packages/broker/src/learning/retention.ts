// v1.2 learning loop: retention (design §3.2). Corrections, source records, dismissed patterns and terminal suggestions carry `indexExpiresAt`, 180 days after they were written (or
// ended), on the attribute the State table's TTL watches. The TTL runs only in named environments, so every read here also treats an item whose time has passed as absent, and the
// learning sweep (sweep.ts) deletes such items where there is no TTL. Nothing deletes on read: a project nobody opens again would keep its text.
import { INDEX_EXPIRY_ATTRIBUTE, LEARNING_RATE_ITEM_SECONDS, LEARNING_RETENTION_DAYS } from "@rovara-code/contracts";

type Item = Record<string, unknown>;

/** The expiry (epoch seconds) of something written at `atMs` that is kept the full retention: 180 days. This is not the admin helper, which adds 30. */
export function learningExpiry(atMs: number): number {
  return Math.floor(atMs / 1000) + LEARNING_RETENTION_DAYS * 86_400;
}

/** The expiry of a daily or rate item: it is dead weight a day or two after its window. */
export function shortLearningExpiry(atMs: number): number {
  return Math.floor(atMs / 1000) + LEARNING_RATE_ITEM_SECONDS;
}

export interface LearningItemKind {
  kind: "STATE" | "SETTINGS" | "PROPOSAL" | "CORRECTION" | "SOURCE" | "SUGGESTION" | "RULE" | "DISMISSED" | "METRIC" | "DAILY" | "RATE" | "UNKNOWN";
  /** The kinds that always carry an expiry. A suggestion's depends on its state (terminal ones expire), so it is not listed here. */
  expires: boolean;
  /** The kinds that carry the `projectCreatedAt` of the project they were written for. */
  projectBound: boolean;
}

const KINDS: Array<[prefix: string, kind: LearningItemKind]> = [
  ["STATE", { kind: "STATE", expires: false, projectBound: true }],
  ["SETTINGS", { kind: "SETTINGS", expires: false, projectBound: true }],
  ["PROPOSAL#", { kind: "PROPOSAL", expires: true, projectBound: true }],
  ["CORRECTION#", { kind: "CORRECTION", expires: true, projectBound: true }],
  ["SOURCE#", { kind: "SOURCE", expires: true, projectBound: true }],
  ["SUGGESTION#", { kind: "SUGGESTION", expires: false, projectBound: true }],
  ["RULE#", { kind: "RULE", expires: false, projectBound: true }],
  ["DISMISSED#", { kind: "DISMISSED", expires: true, projectBound: true }],
  ["METRIC#", { kind: "METRIC", expires: false, projectBound: true }],
  ["DAILY#", { kind: "DAILY", expires: true, projectBound: true }],
  ["RATE#", { kind: "RATE", expires: true, projectBound: true }],
];

/** What a sort key of a learning partition is. An unknown key is read as absent (fail closed) and never deleted by the sweep unless it names its own expiry. */
export function learningItemKind(sk: string): LearningItemKind {
  for (const [prefix, kind] of KINDS) if (sk === prefix || (prefix.endsWith("#") && sk.startsWith(prefix))) return kind;
  return { kind: "UNKNOWN", expires: false, projectBound: false };
}

/** The item's own expiry in epoch seconds, if it has a usable one. */
export function itemExpiry(item: Item): number | undefined {
  const expires = item[INDEX_EXPIRY_ATTRIBUTE];
  return typeof expires === "number" && Number.isSafeInteger(expires) && expires > 0 ? expires : undefined;
}

/** True when the item names an expiry and it has passed. An item that must expire and names none is not "expired": the reader refuses it as malformed. */
export function isExpired(item: Item, nowMs: number): boolean {
  const expires = itemExpiry(item);
  return expires !== undefined && expires <= Math.floor(nowMs / 1000);
}

/** Two instants are the same project's when they are the same moment (the project META's `createdAt` is compared as time, not as text). */
export function sameProject(left: unknown, right: unknown): boolean {
  if (typeof left !== "string" || typeof right !== "string") return false;
  if (left === right) return true;
  const [a, b] = [Date.parse(left), Date.parse(right)];
  return Number.isFinite(a) && a === b;
}

export type Visibility = "visible" | "expired" | "other_project" | "malformed";

/**
 * Whether a read may see an item: not expired, written for this project (`projectCreatedAt`), and well formed for its kind (kinds that must expire have an expiry, kinds bound to a
 * project name one). A project created again under the same name sees nothing of the earlier one.
 */
export function visibility(item: Item, context: { nowMs: number; projectCreatedAt: string }): Visibility {
  const sk = item["sk"];
  if (typeof sk !== "string") return "malformed";
  const kind = learningItemKind(sk);
  if (kind.kind === "UNKNOWN") return "malformed";
  if (isExpired(item, context.nowMs)) return "expired";
  if (kind.expires && itemExpiry(item) === undefined) return "malformed";
  if (kind.kind === "SUGGESTION" && typeof item["terminalAt"] === "string" && itemExpiry(item) === undefined) return "malformed";
  if (kind.projectBound) {
    if (typeof item["projectCreatedAt"] !== "string") return "malformed";
    if (!sameProject(item["projectCreatedAt"], context.projectCreatedAt)) return "other_project";
  }
  return "visible";
}
