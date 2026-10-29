/** Strict offline search-export container. Legacy bundle parsing is deliberately unchanged. */
import { BundleParseError, parseBundle, type AuditBundleV1 } from "./bundle.js";

export const SEARCH_EXPORT_MAX_RECORDS = 200_000;
export const SEARCH_EXPORT_MAX_JSON_BYTES = SEARCH_EXPORT_MAX_RECORDS * 2048 + 16 * 1024 * 1024;
const MAX_SEQ = 10 ** 12 - 1;
const HEX = /^[0-9a-f]{64}$/;
const UTC = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?Z$/;
export type SearchPredicate = { action?: string; actorKind?: "member" | "operator" | "system" | "github"; actorId?: string; targetKind?: string; targetId?: string };
export type SearchExportV1 = {
  format: "rovara-audit-search-export"; v: 1; context: AuditBundleV1;
  selection: { protocol: "indexed-v1"; orgId: string; predicate: SearchPredicate;
    range: { fromSeq: number; toSeq: number }; recordedAt?: { from?: string; to?: string };
    reportedCoverage: { fromSeq: 1; indexedThroughSeq: number; currentHeadSeq: number };
    contextEnd: { seq: number; hash: string }; matches: Array<{ seq: number; hash: string }> };
};
type Obj = Record<string, unknown>;
function fail(path: string): never { throw new BundleParseError(`${path}: invalid search export`); }
function object(value: unknown, path: string, allowed: readonly string[], required: readonly string[] = allowed): Obj {
  if (typeof value !== "object" || value === null || Array.isArray(value)) fail(path);
  const result = value as Obj;
  if (Object.keys(result).some(key => !allowed.includes(key)) || required.some(key => !Object.hasOwn(result, key))) fail(path);
  return result;
}
function list(value: unknown, path: string, max = SEARCH_EXPORT_MAX_RECORDS): unknown[] {
  if (!Array.isArray(value) || value.length > max) fail(path);
  return value;
}
function string(value: unknown, path: string, max = SEARCH_EXPORT_MAX_JSON_BYTES): string {
  if (typeof value !== "string" || value.length === 0 || value.length > max) fail(path);
  return value;
}
function seq(value: unknown, path: string, min = 1): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min || value > MAX_SEQ) fail(path);
  return value;
}
function hash(value: unknown, path: string): string { const result = string(value, path); if (!HEX.test(result)) fail(path); return result; }
function time(value: unknown, path: string): string {
  const result = string(value, path), date = new Date(result);
  if (!UTC.test(result) || !Number.isFinite(date.getTime()) || date.getUTCFullYear() !== Number(result.slice(0, 4)) || date.getUTCMonth() + 1 !== Number(result.slice(5, 7)) || date.getUTCDate() !== Number(result.slice(8, 10))) fail(path);
  return result;
}
function identity(value: unknown, path: string): void { const o = object(value, path, ["kind", "id"]); string(o.kind, path); string(o.id, path); }
function canonicalRecord(value: unknown): void {
  const path = "context.record", o = object(value, path, ["v", "orgId", "seq", "eventId", "action", "actor", "target", "occurredAt", "recordedAt", "related", "facts", "proof", "details", "prevHash", "hash"], ["v", "orgId", "seq", "eventId", "action", "actor", "target", "occurredAt", "recordedAt", "related", "facts", "details", "prevHash", "hash"]);
  if (o.v !== 1) fail(path);
  for (const key of ["orgId", "eventId", "action"]) string(o[key], path);
  seq(o.seq, path); hash(o.prevHash, path); hash(o.hash, path); time(o.occurredAt, path); time(o.recordedAt, path);
  identity(o.actor, path); identity(o.target, path);
  for (const item of list(o.related, path, 1000)) string(item, path);
  if (typeof o.facts !== "object" || o.facts === null || Array.isArray(o.facts) || Object.keys(o.facts).length > 1000) fail(path);
  for (const item of Object.values(o.facts)) if (typeof item !== "string" && typeof item !== "boolean" && !(typeof item === "number" && Number.isFinite(item))) fail(path);
  if (o.proof !== undefined) { const proof = object(o.proof, path, ["kind", "method", "authTime", "sessionRef", "via"], ["kind"]); for (const item of Object.values(proof)) string(item, path); }
  for (const item of list(o.details, path, 1000)) { const commitment = object(item, path, ["subject", "commit"]); string(commitment.subject, path); hash(commitment.commit, path); }
}
function locked(value: unknown): void { object(value, "context.object", ["key", "versionId", "lastModified", "lockMode", "retainUntil"]); }
function epoch(value: unknown): void { object(value, "context.epoch", ["v", "epochId", "closedAt", "prevEpochId", "prevStatementHash", "sealsRoot", "sealCount"]); }
function timestamps(value: unknown): void { for (const item of list(value, "context.timestamps", 16)) { const o = object(item, "context.timestamp", ["tsa", "token", "object"]); locked(o.object); } }
function seal(value: unknown): void { object(value, "context.seal", ["v", "orgId", "fromSeq", "toSeq", "batchRoot", "headHash", "prevSealHash", "epochId"]); }
function contextShape(value: unknown): void {
  const o = object(value, "context", ["format", "v", "orgId", "exportedAt", "previous", "previousSeal", "records", "seals", "unsealed"]);
  const records = list(o.records, "context.records"), unsealed = list(o.unsealed, "context.unsealed");
  if (records.length + unsealed.length > SEARCH_EXPORT_MAX_RECORDS || records.length + unsealed.length === 0) fail("context.records");
  object(o.previous, "context.previous", ["seq", "hash"]);
  if (o.previousSeal !== null) seal(o.previousSeal);
  for (const record of [...records, ...unsealed]) canonicalRecord(record);
  for (const item of list(o.seals, "context.seals")) {
    const entry = object(item, "context.seals", ["seal", "sealObject", "recordsObject", "inclusion", "epoch", "epochObject", "timestamps", "coveredBy"], ["seal", "sealObject", "recordsObject", "inclusion", "epoch", "epochObject", "timestamps"]);
    seal(entry.seal); locked(entry.sealObject); locked(entry.recordsObject); epoch(entry.epoch); locked(entry.epochObject); timestamps(entry.timestamps);
    const inclusion = object(entry.inclusion, "context.inclusion", ["index", "size", "path"]); list(inclusion.path, "context.inclusion", 64);
    if (entry.coveredBy !== undefined) { const covered = object(entry.coveredBy, "context.coveredBy", ["epochs", "timestamps"]); for (const item of list(covered.epochs, "context.coveredBy", 100_000)) epoch(item); timestamps(covered.timestamps); }
  }
}
export function parseSearchExport(value: unknown): SearchExportV1 {
  const o = object(value, "searchExport", ["format", "v", "context", "selection"]);
  if (o.format !== "rovara-audit-search-export" || o.v !== 1) fail("format/version");
  const selection = object(o.selection, "selection", ["protocol", "orgId", "predicate", "range", "recordedAt", "reportedCoverage", "contextEnd", "matches"], ["protocol", "orgId", "predicate", "range", "reportedCoverage", "contextEnd", "matches"]);
  if (selection.protocol !== "indexed-v1") fail("selection.protocol");
  const predicate = object(selection.predicate, "selection.predicate", ["action", "actorKind", "actorId", "targetKind", "targetId"], []);
  for (const item of Object.values(predicate)) string(item, "selection.predicate", 256);
  if (Object.keys(predicate).length === 0 || (predicate.actorKind === undefined) !== (predicate.actorId === undefined) || (predicate.targetKind === undefined) !== (predicate.targetId === undefined)) fail("selection.predicate");
  if (predicate.actorKind !== undefined && (typeof predicate.actorKind !== "string" || !["member", "operator", "system", "github"].includes(predicate.actorKind))) fail("selection.predicate");
  const range = object(selection.range, "selection.range", ["fromSeq", "toSeq"]);
  const fromSeq = seq(range.fromSeq, "selection.range"), toSeq = seq(range.toSeq, "selection.range");
  const coverage = object(selection.reportedCoverage, "selection.reportedCoverage", ["fromSeq", "indexedThroughSeq", "currentHeadSeq"]);
  if (coverage.fromSeq !== 1) fail("selection.reportedCoverage");
  const indexedThroughSeq = seq(coverage.indexedThroughSeq, "selection.reportedCoverage"), currentHeadSeq = seq(coverage.currentHeadSeq, "selection.reportedCoverage");
  const end = object(selection.contextEnd, "selection.contextEnd", ["seq", "hash"]);
  const contextEnd = { seq: seq(end.seq, "selection.contextEnd"), hash: hash(end.hash, "selection.contextEnd") };
  const matches = list(selection.matches, "selection.matches").map(item => { const row = object(item, "selection.matches", ["seq", "hash"]); return { seq: seq(row.seq, "selection.matches"), hash: hash(row.hash, "selection.matches") }; });
  let recordedAt: SearchExportV1["selection"]["recordedAt"];
  if (selection.recordedAt !== undefined) { const times = object(selection.recordedAt, "selection.recordedAt", Object.keys({ from: true, to: true }), []); if (Object.keys(times).length === 0) fail("selection.recordedAt"); recordedAt = { ...(times.from === undefined ? {} : { from: time(times.from, "selection.recordedAt") }), ...(times.to === undefined ? {} : { to: time(times.to, "selection.recordedAt") }) }; if (recordedAt.from !== undefined && recordedAt.to !== undefined && Date.parse(recordedAt.from) > Date.parse(recordedAt.to)) fail("selection.recordedAt"); }
  contextShape(o.context);
  // The raw/expanded file ceiling is also enforced by the CLI before JSON.parse. This bound covers direct library callers.
  try { if (Buffer.byteLength(JSON.stringify(value), "utf8") > SEARCH_EXPORT_MAX_JSON_BYTES) fail("searchExport.size"); } catch { fail("searchExport.size"); }
  const context = parseBundle(o.context);
  return { format: "rovara-audit-search-export", v: 1, context, selection: { protocol: "indexed-v1", orgId: string(selection.orgId, "selection.orgId"), predicate, range: { fromSeq, toSeq }, ...(recordedAt === undefined ? {} : { recordedAt }), reportedCoverage: { fromSeq: 1, indexedThroughSeq, currentHeadSeq }, contextEnd, matches } };
}
