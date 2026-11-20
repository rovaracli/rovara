import { useSyncExternalStore } from "react";
import { useQueryClient, type QueryClient } from "@tanstack/react-query";

/**
 * The Merge section's read fence (SCREEN-STATE-RULES R6b/R6e/R6g), kept in the QueryClient, keyed by the SUBJECT `orgId|developerId|sessionId`, so it outlives the component and is never shared between people or companies:
 * unmounting, navigating away and coming back, or a request still in flight while the view is gone, all meet the same fence; another identity gets another fence.
 *
 * ONE RULE, per tab: a tab may void, settle or retire an unresolved press ONLY with a task read that THIS TAB issued AFTER THIS TAB first observed that press (when it wrote it, or when it first saw it in storage or in a
 * storage event). Order is only ever compared inside one tab, by `tabSeq()`, a plain increasing counter in this page's memory. Nothing is compared across tabs, no clock is used, nothing is persisted: after a reload the tab
 * observes the record again and needs a NEW read issued after that.
 *
 * The read is bound to ITS OWN RESPONSE BODY. The section calls the API itself (`fencedRead`): the issue number is taken when the call STARTS and is stored together with the body that call returned, an immutable value held in
 * this closure, never read back from the query cache or from a prop. A cache write of any kind (presence, an Understand answer, the shared session adapter keeping an older projection) cannot supply, change or stamp a fact.
 * The same fence holds the readiness refusal: a failed or refused readiness read is recorded here and only a readiness read issued after it that succeeds clears it (`fencedReadiness`).
 */
let counter = 0;
/** This tab's issue sequence. Strictly increasing within the page; never compared with another tab's. */
export const tabSeq = (): number => { counter += 1; return counter; };

export interface TaskRead { /** The body of that very call. */ data: unknown; /** tabSeq() when the call started. */ issued: number }
export interface Fence {
 latestRead: TaskRead | undefined;
 /** The latest FAILED or REFUSED task read this section made (by issue number). A response issued before it is dropped; resolution waits for a read issued after it that succeeds (R6b/R6e). */
 taskFailed: { seq: number } | undefined;
 /** A readiness read failed or was refused; cleared only by a readiness read issued after it that succeeds. */
 readinessDenied: { seq: number } | undefined;
 /** The issue number of the latest SUCCESSFUL readiness read: a failure issued before it never supersedes it (R6b). */
 readinessLatest: number | undefined;
 /** Records this tab has observed, by `requestId|startedAt`, with tabSeq() at first observation. */
 observed: Map<string, number>;
 version: number;
 listeners: Set<() => void>;
}
const fences = new WeakMap<QueryClient, Map<string, Fence>>();

function make(): Fence { return { latestRead: undefined, taskFailed: undefined, readinessDenied: undefined, readinessLatest: undefined, observed: new Map(), version: 0, listeners: new Set() }; }
function changed(fence: Fence): void { fence.version += 1;for (const listener of fence.listeners) listener(); }

/** The fence for one subject (`orgId|developerId|sessionId`) in this QueryClient. */
export function fenceFor(client: QueryClient, subject: string): Fence {
 let map = fences.get(client);
 if (map === undefined) { map = new Map();fences.set(client, map); }
 let fence = map.get(subject);
 if (fence === undefined) { fence = make();map.set(subject, fence); }
 return fence;
}

/**
 * A task read made BY THE SECTION: the issue number is taken at the start of the call and kept with the body that same call returned. A later-issued read supersedes an earlier one, never the reverse. A failed or refused
 * attempt is recorded by its issue number too (like `fencedReadiness`): any response issued before it is dropped, and nothing resolves until a read issued after it succeeds; a failure issued before the latest successful read is ignored. The fence survives remounts.
 */
export async function fencedRead<T>(fence: Fence, call: () => Promise<T>): Promise<{ issued: number; body: T }> {
 const issued = tabSeq();
 let body: T;
 try { body = await call(); } catch (failure) {
  // A failure supersedes only what was issued BEFORE it: a failed read older than the latest successful read must never override that newer success (R6b). The caller still sees its own failure.
  const newerSuccess = fence.latestRead !== undefined && fence.latestRead.issued > issued;
  if (!newerSuccess && (fence.taskFailed === undefined || issued > fence.taskFailed.seq)) { fence.taskFailed = { seq: issued };changed(fence); }
  throw failure;
 }
 // Issued before a newer failed or refused read: an older response must not apply after it.
 if (fence.taskFailed !== undefined && issued < fence.taskFailed.seq) return { issued, body };
 if (fence.latestRead === undefined || issued > fence.latestRead.issued) fence.latestRead = { data: body, issued };
 if (fence.taskFailed !== undefined && issued > fence.taskFailed.seq) fence.taskFailed = undefined;
 changed(fence);
 return { issued, body };
}

/**
 * A readiness read made by the section: a failure or refusal is recorded in the fence; only a read issued after it that succeeds clears it. The same rule as task reads (R6b): a failure issued BEFORE the latest successful
 * readiness read is ignored (the caller still sees its own failure), so an older failed read landing late can never supersede a newer success.
 */
export async function fencedReadiness<T>(fence: Fence, call: () => Promise<T>): Promise<T> {
 const issued = tabSeq();
 try {
  const body = await call();
  if (fence.readinessLatest === undefined || issued > fence.readinessLatest) fence.readinessLatest = issued;
  if (fence.readinessDenied !== undefined && issued > fence.readinessDenied.seq) { fence.readinessDenied = undefined;changed(fence); }
  return body;
 } catch (failure) {
  const newerSuccess = fence.readinessLatest !== undefined && fence.readinessLatest > issued;
  if (!newerSuccess && (fence.readinessDenied === undefined || issued > fence.readinessDenied.seq)) { fence.readinessDenied = { seq: issued };changed(fence); }
  throw failure;
 }
}

/** This tab first observes a record: when it wrote it, or when it first read it from storage. Later observations keep the first. */
export function observeRecord(fence: Fence, recordKey: string): void {
 if (!fence.observed.has(recordKey)) { fence.observed.set(recordKey, tabSeq());changed(fence); }
}

/** Re-renders the caller whenever the fence changes. */
export function useFence(subject: string): Fence {
 const client = useQueryClient(), fence = fenceFor(client, subject);
 useSyncExternalStore(listener => { fence.listeners.add(listener); return () => { fence.listeners.delete(listener); }; }, () => fence.version, () => 0);
 return fence;
}
