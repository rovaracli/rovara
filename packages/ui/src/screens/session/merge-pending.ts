import { createActionRecords, withActionClaim, everyCovered, type ActionPendingState } from "../../safe-action.js";
import { pullKey, type PullRow } from "./merge-facts.js";
export { PENDING_STALE_MS, claimLockSupported, type ClaimOutcome } from "../../safe-action.js";
import { PENDING_STALE_MS } from "../../safe-action.js";

/** Existing strict v1 readers and namespaces are retained for reload/tab compatibility. Subject = orgId|developerId|sessionId (R6g).
 * No replay: Code stores success only (hosted-merge-routes.ts 168-218); Check only reads.
 */
const UNAVAILABLE = "\u0000unavailable";
const SHA = /^[a-f0-9]{40}$/u, UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u;
export interface PendingHead { repositoryId: string; number: number; headSha: string }
export interface PendingPress { v: 1; sessionId: string; requestId: string; startedAt: string; heads: PendingHead[]; risk: "low" | "medium" | "high" | undefined; sent: string[] }
export type PendingState = ActionPendingState<PendingPress>;
/** The record, strictly checked: anything that does not read as exactly what this module wrote is "unreadable", which stays locked. */
export function parsePending(raw: string | null, sessionId: string, now = Date.now()): PendingState {
 if (raw === UNAVAILABLE) return { kind: "unavailable" };
 if (raw === null) return { kind: "none" };
 try {
  const value = JSON.parse(raw) as Partial<PendingPress> | null;
  if (value === null || typeof value !== "object" || value.v !== 1 || value.sessionId !== sessionId || typeof value.requestId !== "string" || !UUID.test(value.requestId) || typeof value.startedAt !== "string" || !Number.isFinite(Date.parse(value.startedAt))) return { kind: "unreadable" };
  if (!Array.isArray(value.heads) || value.heads.length > 32 || !value.heads.every(head => typeof head === "object" && head !== null && typeof head.repositoryId === "string" && head.repositoryId.length > 0 && head.repositoryId.length <= 200 && Number.isInteger(head.number) && head.number > 0 && typeof head.headSha === "string" && SHA.test(head.headSha))) return { kind: "unreadable" };
  if (value.risk !== undefined && value.risk !== "low" && value.risk !== "medium" && value.risk !== "high") return { kind: "unreadable" };
  if (!Array.isArray(value.sent) || !value.sent.every(item => typeof item === "string" && item.length <= 300) || value.sent.length > 32) return { kind: "unreadable" };
  const entry: PendingPress = { v: 1, sessionId, requestId: value.requestId, startedAt: value.startedAt, heads: value.heads, risk: value.risk, sent: value.sent };
  return { kind: "pending", entry, stale: now - Date.parse(value.startedAt) >= PENDING_STALE_MS };
 } catch { return { kind: "unreadable" }; }
}

/**
 * A moved head voids the record only when the rows come from a task read that this tab issued after it observed the record (merge-fence.ts decides that; these rows are those of that read and nothing else). Data of
 * unknown order, a manual cache write, a readiness answer and a failed read never reach this function.
 */
export function headsMoved(entry: PendingPress, resolvingRows: readonly PullRow[]): boolean {
 return entry.heads.some(head => { const tracked = resolvingRows.find(candidate => candidate.key === pullKey(head.repositoryId, head.number))?.tracked; return tracked !== undefined && tracked.headSha !== head.headSha; });
}

/** Every pull request the record covered shows merged in the rows of such a read (an observation, not an answer to the request). */
export function allMerged(entry: PendingPress, resolvingRows: readonly PullRow[]): boolean {
 return everyCovered(entry.heads, head => resolvingRows.find(candidate => candidate.key === pullKey(head.repositoryId, head.number))?.state === "merged");
}


export interface AcceptedAnswer { v: 1; subject: string; requestId: string; acceptedAt: string; words: string; keys: string[]; heads: PendingHead[] }
export function parseAccepted(raw: string | null, subject: string): AcceptedAnswer | undefined {
 if (raw === null) return undefined;
 try {
  const v = JSON.parse(raw) as Partial<AcceptedAnswer> | null;
  if (v === null || typeof v !== "object" || v.v !== 1 || v.subject !== subject || typeof v.requestId !== "string" || !UUID.test(v.requestId) || typeof v.acceptedAt !== "string" || typeof v.words !== "string" || v.words.length > 600) return undefined;
  if (!Array.isArray(v.keys) || v.keys.length > 32 || !v.keys.every(key => typeof key === "string" && key.length <= 260)) return undefined;
  if (!Array.isArray(v.heads) || v.heads.length > 32 || !v.heads.every(head => typeof head === "object" && head !== null && typeof head.repositoryId === "string" && head.repositoryId.length > 0 && head.repositoryId.length <= 200 && Number.isInteger(head.number) && head.number > 0 && typeof head.headSha === "string" && SHA.test(head.headSha))) return undefined;
  return { v: 1, subject, requestId: v.requestId, acceptedAt: v.acceptedAt, words: v.words, keys: v.keys, heads: v.heads };
 } catch { return undefined; }
}

export const mergeActionRecords = createActionRecords<PendingPress, AcceptedAnswer>({
 lockPrefix: "rovara.merge.claim:", pendingPrefix: "rovara.merge.pending.v1:", acceptedPrefix: "rovara.merge.accepted.v1:", changedEvent: "rovara-merge-pending-changed",
 parsePending, parseAccepted, pendingSubject: entry => entry.sessionId, acceptedSubject: answer => answer.subject,
 canonicalAccepted: answer => ({ v: 1, subject: answer.subject, requestId: answer.requestId, acceptedAt: answer.acceptedAt, words: answer.words, keys: answer.keys, heads: answer.heads }),
});
export const { usePending, readPendingNow, writePending, useAccepted, readAcceptedNow, writeAccepted, acceptedStoredExactly, claimPending, recordAccepted } = mergeActionRecords;
export const clearPending = (entry: Pick<PendingPress, "sessionId" | "requestId" | "startedAt">): void => mergeActionRecords.clearPending(entry.sessionId, entry.requestId, entry.startedAt);
export const clearAccepted = (answer: Pick<AcceptedAnswer, "subject" | "requestId">): void => mergeActionRecords.clearAccepted(answer.subject, answer.requestId);
export const withClaim = <T>(subject: string, claim: () => T) => withActionClaim("rovara.merge.claim:" + subject, claim);
