/** Full-context integrity and declared-query consistency, never requester-intent authentication. */
import { verifyBundle, type BundleReport, type VerifyBundleOptions } from "./verify-bundle.js";
import type { SearchExportV1, SearchPredicate } from "./search-export.js";
import type { AuditRecordV1 } from "./record.js";
export const SEARCH_EXPORT_CLAIMS = [
  "Index coverage is reported online, not verified offline.",
  "A consistently substituted predicate cannot be detected without separate authenticated intent; only the declared query is checked.",
  "This does not prove requester identity, consent, installed coverage or real-world/company completeness.",
] as const;
export type SearchExportReport = BundleReport & { selection: { selectedCount: number; contextCount: number; predicateEcho: string; empty: boolean; coverageLabel: string; range: { fromSeq: number; toSeq: number }; contextEnd: { seq: number; hash: string }; reportedCoverage: SearchExportV1["selection"]["reportedCoverage"]; claims: readonly string[] } };
function matches(record: AuditRecordV1, predicate: SearchPredicate, time: SearchExportV1["selection"]["recordedAt"]): boolean {
  return (predicate.action === undefined || record.action === predicate.action)
    && (predicate.actorKind === undefined || (record.actor.kind === predicate.actorKind && record.actor.id === predicate.actorId))
    && (predicate.targetKind === undefined || (record.target.kind === predicate.targetKind && record.target.id === predicate.targetId))
    && (time?.from === undefined || Date.parse(record.recordedAt) >= Date.parse(time.from))
    && (time?.to === undefined || Date.parse(record.recordedAt) <= Date.parse(time.to));
}
export function verifySearchExport(value: SearchExportV1, options: VerifyBundleOptions): SearchExportReport {
  const report = verifyBundle(value.context, options), all = [...value.context.records, ...value.context.unsealed], s = value.selection;
  let ok = true;
  const last = all.at(-1);
  if (s.orgId !== value.context.orgId || all.some(row => row.orgId !== s.orgId) || last === undefined || last.seq !== s.contextEnd.seq || last.hash !== s.contextEnd.hash) ok = false;
  if (s.range.fromSeq > s.range.toSeq || s.range.toSeq > s.contextEnd.seq || s.range.toSeq > s.reportedCoverage.indexedThroughSeq || s.reportedCoverage.indexedThroughSeq > s.reportedCoverage.currentHeadSeq) ok = false;
  const interval = all.filter(row => row.seq >= s.range.fromSeq && row.seq <= s.range.toSeq);
  if (interval.length !== s.range.toSeq - s.range.fromSeq + 1 || interval.some((row, i) => row.seq !== s.range.fromSeq + i)) ok = false;
  const expected = interval.filter(row => matches(row, s.predicate, s.recordedAt));
  if (expected.length !== s.matches.length || expected.some((row, i) => row.seq !== s.matches[i]?.seq || row.hash !== s.matches[i]?.hash)) ok = false;
  const empty = ok && expected.length === 0;
  const detail = ok ? `${s.matches.length} selected / ${all.length} context records; ${empty ? "empty selection in a complete interval" : "exact selection in the declared interval"}; range ${s.range.fromSeq}..${s.range.toSeq}; context end ${s.contextEnd.seq}; indexed through ${s.reportedCoverage.indexedThroughSeq}, head ${s.reportedCoverage.currentHeadSeq} (reported online, not verified offline); predicate ${JSON.stringify(s.predicate)}` : "selection, range, coverage or context end does not match the complete context";
  const checks = [...report.checks, { name: "selection", ok, detail }];
  return { ...report, ok: report.ok && ok, checks, selection: { selectedCount: s.matches.length, contextCount: all.length, predicateEcho: JSON.stringify(s.predicate), empty, coverageLabel: SEARCH_EXPORT_CLAIMS[0], range: { ...s.range }, contextEnd: { ...s.contextEnd }, reportedCoverage: { ...s.reportedCoverage }, claims: SEARCH_EXPORT_CLAIMS } };
}
