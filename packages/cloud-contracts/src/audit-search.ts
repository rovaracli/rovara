// Browser-safe indexed metadata protocol. This is not an export or chain-verification format.
import { z } from "zod";
import { OrgIdSchema } from "@rovara-code/contracts";
export const AUDIT_INDEX_PAGE_DEFAULT = 50;
export const AUDIT_INDEX_PAGE_MAX = 100;
const text = z.string().min(1).max(256);
const seq = z.number().int().min(1).max(999999999999);
const identity = z.object({ kind: text, id: text }).strict();
export const AuditIndexedQuerySchema = z.object({
  filterVersion: z.literal("1"), action: text.optional(),
  actorKind: z.enum(["member", "operator", "system", "github"]).optional(), actorId: text.optional(),
  targetKind: text.optional(), targetId: text.optional(),
  fromSeq: seq.optional(), toSeq: seq.optional(),
  from: z.iso.datetime().optional(), to: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(AUDIT_INDEX_PAGE_MAX).default(AUDIT_INDEX_PAGE_DEFAULT),
  cursor: z.string().min(1).max(8192).optional(),
}).strict().superRefine((q, ctx) => {
  if ((q.actorKind === undefined) !== (q.actorId === undefined) || (q.targetKind === undefined) !== (q.targetId === undefined) || (q.action === undefined && q.actorKind === undefined && q.targetKind === undefined)) ctx.addIssue({ code: "custom", message: "An indexed predicate is required, with complete identity pairs." });
  if ((q.fromSeq !== undefined && q.toSeq !== undefined && q.fromSeq > q.toSeq) || (q.from !== undefined && q.to !== undefined && Date.parse(q.from) > Date.parse(q.to))) ctx.addIssue({ code: "custom", message: "Invalid range." });
});
export type AuditIndexedQuery = z.infer<typeof AuditIndexedQuerySchema>;
export const AuditIndexedResultSchema = z.object({
  protocol: z.literal("indexed-v1"), checkedAt: z.iso.datetime(),
  records: z.array(z.object({ record: z.object({ orgId: OrgIdSchema, seq, action: text, actor: identity, target: identity, occurredAt: z.iso.datetime(), recordedAt: z.iso.datetime() }).strict() }).strict()).max(AUDIT_INDEX_PAGE_MAX),
  coverage: z.object({ fromSeq: seq, throughSeq: z.number().int().min(0), indexedThroughSeq: seq, currentHeadSeq: seq }).strict(),
  evaluatedCount: z.number().int().min(0).max(AUDIT_INDEX_PAGE_MAX), nextCursor: z.string().max(8192).optional(),
}).strict();
export type AuditIndexedResult = z.infer<typeof AuditIndexedResultSchema>;
