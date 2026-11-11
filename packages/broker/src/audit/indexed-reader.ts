// One bounded posting query; a short page is never filled by scanning further candidates.
import { timingSafeEqual } from "node:crypto";
import { GetCommand, QueryCommand } from "@aws-sdk/lib-dynamodb";
import { z } from "zod";
import { AuditIndexedQuerySchema, AuditIndexedResultSchema, auditCanonicalJson, recordHash, type AuditIndexedQuery, type AuditIndexedResult } from "@agentx/cloud-contracts";
import { agentXError } from "@rovara-code/contracts";
import type { AuditExportClientDeps } from "./export.js";
import type { AuditOrgCaller } from "./routes.js";
import { canReadAuditLog } from "../org/auditor.js";
import { auditSeqSortKey } from "./appender.js";
import { AUDIT_INDEX_COVERAGE, auditIndexDigest, auditIndexPostings, auditIndexPrefix } from "./search-index.js";
import { firstSeqAtOrAfter, lastSeqAtOrBefore, recordOfItem } from "./reader.js";
const invalid = () => agentXError("CONFIG_INVALID", "That indexed audit query or cursor is invalid.");
const unavailable = () => agentXError("AUDIT_UNAVAILABLE", "Indexed audit search is unavailable. Try again later.");
const forbidden = () => agentXError("FORBIDDEN", "Only your organization's current owners and admins can see its audit log.");
const integer = z.number().int().min(0).max(999999999999);
const PostingSchema = z.object({ pk: z.string(), sk: z.string(), v: z.literal(1), orgId: z.string(), dimension: z.enum(["action", "actor", "target"]), digest: z.string().regex(/^[0-9a-f]{64}$/), seq: integer.min(1), hash: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
const CoverageSchema = z.object({ pk: z.string(), sk: z.literal(AUDIT_INDEX_COVERAGE), v: z.literal(1), orgId: z.string(), fromSeq: z.literal(1), throughSeq: integer.min(1) }).strict();
const CursorSchema = z.object({ v: z.literal(1), orgId: z.string(), developerId: z.string(), role: z.enum(["owner", "admin", "auditor"]), query: z.string(), fromSeq: integer.min(1), throughSeq: integer, after: integer, coverageVersion: z.literal(1), tag: z.string().regex(/^[0-9a-f]{64}$/) }).strict();
export function indexedQueryOf(params: URLSearchParams): AuditIndexedQuery {
  const input = Object.create(null) as Record<string, unknown>;
  for (const [key, value] of params) {
    if (Object.hasOwn(input, key)) throw invalid();
    if (["limit", "fromSeq", "toSeq"].includes(key)) {
      if (!/^[1-9][0-9]*$/.test(value)) throw invalid();
      input[key] = Number(value);
    } else input[key] = value;
  }
  const parsed = AuditIndexedQuerySchema.safeParse(input);
  if (!parsed.success) throw invalid();
  return parsed.data;
}
async function authority(deps: AuditExportClientDeps, caller: AuditOrgCaller): Promise<void> {
  if (!canReadAuditLog(caller.orgRole)) throw forbidden();
  const get = async (pk: string, sk: string): Promise<Record<string, unknown> | undefined> => (await deps.documentClient.send(new GetCommand({ TableName: deps.tableName, Key: { pk, sk }, ConsistentRead: true }))).Item;
  const [org, member, pointer] = await Promise.all([get(`ORG#${caller.orgId}`, "META"), get(`ORG#${caller.orgId}`, `MEMBER#${caller.developerId}`), get(`DEVELOPER_ORG#${caller.developerId}`, "ORG")]);
  if (org?.orgId !== caller.orgId || org.closedAt !== undefined || org.closingAt !== undefined || member?.orgId !== caller.orgId || member.developerId !== caller.developerId || member.role !== caller.orgRole || pointer?.orgId !== caller.orgId || pointer.role !== caller.orgRole) throw forbidden();
}
export async function readIndexedAudit(deps: AuditExportClientDeps, caller: AuditOrgCaller, query: AuditIndexedQuery): Promise<AuditIndexedResult> {
  try {
    await authority(deps, caller);
    if (await deps.keyring.isOrgShredded(caller.orgId)) throw unavailable();
    const pk = `AUDIT#${caller.orgId}`;
    const get = async (sk: string): Promise<Record<string, unknown> | undefined> => (await deps.documentClient.send(new GetCommand({ TableName: deps.ledgerTable, Key: { pk, sk }, ConsistentRead: true }))).Item;
    const [headItem, coverageItem] = await Promise.all([get("HEAD"), get(AUDIT_INDEX_COVERAGE)]);
    const head = z.object({ seq: integer.min(1) }).passthrough().parse(headItem);
    const coverage = CoverageSchema.parse(coverageItem);
    if (coverage.pk !== pk || coverage.orgId !== caller.orgId || coverage.throughSeq > head.seq) throw unavailable();
    const { cursor, ...normalized } = query;
    const binding = auditCanonicalJson(z.json().parse(normalized));
    let fromSeq = query.fromSeq ?? 1, throughSeq = query.toSeq ?? coverage.throughSeq, after = 0;
    if (fromSeq > coverage.throughSeq || throughSeq > coverage.throughSeq) throw unavailable();
    if (cursor !== undefined) {
      let decoded: z.infer<typeof CursorSchema>;
      try {
        const raw = Buffer.from(cursor, "base64url").toString("utf8");
        decoded = CursorSchema.parse(JSON.parse(raw));
        if (Buffer.from(raw).toString("base64url") !== cursor || auditCanonicalJson(decoded) !== raw) throw invalid();
      } catch { throw invalid(); }
      const { tag, ...payload } = decoded;
      const expected = await deps.keyring.auditCursorTag(caller.orgId, auditCanonicalJson(payload));
      if (!timingSafeEqual(Buffer.from(tag, "hex"), Buffer.from(expected, "hex")) || decoded.orgId !== caller.orgId || decoded.developerId !== caller.developerId || decoded.role !== caller.orgRole || decoded.query !== binding || decoded.throughSeq > coverage.throughSeq || decoded.fromSeq < 1 || decoded.after < decoded.fromSeq || decoded.after >= decoded.throughSeq) throw invalid();
      fromSeq = decoded.fromSeq; throughSeq = decoded.throughSeq; after = decoded.after;
    } else {
      if (query.from !== undefined) {
        // Resolve against coverage, not a narrower requested upper bound: missing coverage is never an empty result.
        const first = await firstSeqAtOrAfter(deps, caller.orgId, coverage.throughSeq, Date.parse(query.from));
        if (first > coverage.throughSeq) throw unavailable();
        fromSeq = Math.max(fromSeq, first);
      }
      if (query.to !== undefined) throughSeq = Math.min(throughSeq, await lastSeqAtOrBefore(deps, caller.orgId, throughSeq, Date.parse(query.to)));
    }
    const dimension = query.actorKind !== undefined ? "actor" : query.targetKind !== undefined ? "target" : "action";
    const fields = dimension === "actor" ? [query.actorKind!, query.actorId!] : dimension === "target" ? [query.targetKind!, query.targetId!] : [query.action!];
    const digest = auditIndexDigest(caller.orgId, dimension, fields), prefix = auditIndexPrefix(dimension, digest);
    const low = Math.max(fromSeq, after + 1);
    const candidates: { Items?: Array<Record<string, unknown>> | undefined; LastEvaluatedKey?: Record<string, unknown> | undefined } = low > throughSeq ? { Items: [] } : await deps.documentClient.send(new QueryCommand({
      TableName: deps.ledgerTable, ConsistentRead: true, Limit: query.limit,
      KeyConditionExpression: "pk = :pk AND sk BETWEEN :from AND :to",
      ExpressionAttributeValues: { ":pk": pk, ":from": `${prefix}${String(low).padStart(12, "0")}`, ":to": `${prefix}${String(throughSeq).padStart(12, "0")}` },
    }));
    const items = (candidates.Items ?? []).map(item => PostingSchema.parse(item));
    for (let i = 1; i < items.length; i += 1) if (items[i]!.seq <= items[i - 1]!.seq) throw unavailable();
    if (items.length > query.limit) throw unavailable();
    const records: AuditIndexedResult["records"] = [];
    // Bounded batches cap concurrent canonical Gets at eight, without Scan/BatchGet or a fill loop.
    for (let start = 0; start < items.length; start += 8) {
      const batch = await Promise.all(items.slice(start, start + 8).map(async posting => {
        if (posting.pk !== pk || posting.dimension !== dimension || posting.digest !== digest || posting.sk !== `${prefix}${String(posting.seq).padStart(12, "0")}` || posting.seq < low || posting.seq > throughSeq) throw unavailable();
        const item = await get(auditSeqSortKey(posting.seq));
        if (!item || item.pk !== pk || item.sk !== auditSeqSortKey(posting.seq)) throw unavailable();
        const record = recordOfItem(item);
        const expected = auditIndexPostings(record).find(p => p.dimension === dimension);
        if (record.orgId !== caller.orgId || record.seq !== posting.seq || recordHash(record) !== record.hash || auditCanonicalJson(z.json().parse(posting)) !== auditCanonicalJson(z.json().parse(expected))) throw unavailable();
        if ((query.action !== undefined && record.action !== query.action) || (query.actorKind !== undefined && (record.actor.kind !== query.actorKind || record.actor.id !== query.actorId)) || (query.targetKind !== undefined && (record.target.kind !== query.targetKind || record.target.id !== query.targetId))) return undefined;
        return { record: { orgId: record.orgId, seq: record.seq, action: record.action, actor: record.actor, target: record.target, occurredAt: record.occurredAt, recordedAt: record.recordedAt } };
      }));
      for (const row of batch) if (row !== undefined) records.push(row);
    }
    let nextCursor: string | undefined;
    if (candidates.LastEvaluatedKey !== undefined) {
      const last = items.at(-1);
      if (!last || candidates.LastEvaluatedKey.pk !== pk || candidates.LastEvaluatedKey.sk !== last.sk) throw unavailable();
      if (last.seq < throughSeq) {
        const payload = { v: 1, orgId: caller.orgId, developerId: caller.developerId, role: caller.orgRole, query: binding, fromSeq, throughSeq, after: last.seq, coverageVersion: 1 };
        const tag = await deps.keyring.auditCursorTag(caller.orgId, auditCanonicalJson(payload));
        nextCursor = Buffer.from(auditCanonicalJson({ ...payload, tag })).toString("base64url");
      }
    }
    await authority(deps, caller);
    if (await deps.keyring.isOrgShredded(caller.orgId)) throw unavailable();
    return AuditIndexedResultSchema.parse({ protocol: "indexed-v1", checkedAt: new Date(deps.now()).toISOString(), records, coverage: { fromSeq, throughSeq, indexedThroughSeq: coverage.throughSeq, currentHeadSeq: head.seq }, evaluatedCount: items.length, ...(nextCursor === undefined ? {} : { nextCursor }) });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error) {
      if (error.code === "FORBIDDEN") throw forbidden();
      if (error.code === "CONFIG_INVALID") throw invalid();
    }
    throw unavailable();
  }
}
