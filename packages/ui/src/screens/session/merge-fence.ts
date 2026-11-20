import { useSyncExternalStore } from "react";
import { useQueryClient, type QueryCacheNotifyEvent, type QueryClient } from "@tanstack/react-query";

/**
 * The Merge section's read fence (SCREEN-STATE-RULES R6b/R6e), kept in the QueryClient, keyed by session id, so it outlives the component: unmounting, navigating away and coming back, or a request that is still in
 * flight while the view is gone, all meet the same fence.
 *
 * ONE RULE, per tab: a tab may void, settle or retire an unresolved press ONLY with a task read that THIS TAB issued AFTER THIS TAB first observed that press (when it wrote it, or when it first saw it in storage or in a
 * storage event). Order is therefore only ever compared inside one tab, by `tabSeq()`, a plain increasing counter in this page's memory. Nothing is compared across tabs, no clock is used, and nothing is persisted: after
 * a reload the tab observes the record again and needs a NEW read issued after that.
 *
 * The read is bound to the data it returned: the cache subscription takes `issued` when a fetch of ["session", id] STARTS and, when that same fetch succeeds, records {data, issued} for the exact data object the fetch
 * produced. A manual cache write (setQueryData: the presence heartbeat, an Understand answer) is not a read and carries no issue number; the facts used to resolve anything are the data of the latest real fetch, never
 * a later prop or cache object. The same fence holds the readiness refusal: a failed or refused readiness read is recorded here and only a readiness fetch issued after it that succeeds clears it.
 */
let counter = 0;
/** This tab's issue sequence. Strictly increasing within the page; never compared with another tab's. */
export const tabSeq = (): number => { counter += 1; return counter; };

export interface TaskRead { /** The exact data object the fetch produced. */ data: unknown; /** tabSeq() when that fetch started. */ issued: number }
export interface Fence {
 latestRead: TaskRead | undefined;
 inflight: number | undefined;
 /** A readiness read failed or was refused; cleared only by a readiness fetch issued after it that succeeds. */
 readinessDenied: { seq: number } | undefined;
 readinessInflight: number | undefined;
 /** Records this tab has observed, by `requestId|startedAt`, with tabSeq() at first observation. */
 observed: Map<string, number>;
 /** The identity (`orgId|developerId`, from /v1/app/me) this fence state belongs to (R6g); state of another identity is dropped, never shown. */
 identity: string | undefined;
 version: number;
 listeners: Set<() => void>;
}
const fences = new WeakMap<QueryClient, Map<string, Fence>>(), installed = new WeakSet<QueryClient>();

function make(): Fence { return { latestRead: undefined, inflight: undefined, readinessDenied: undefined, readinessInflight: undefined, observed: new Map(), identity: undefined, version: 0, listeners: new Set() }; }
function get(client: QueryClient, sessionId: string): Fence {
 let map = fences.get(client);
 if (map === undefined) { map = new Map();fences.set(client, map); }
 let fence = map.get(sessionId);
 if (fence === undefined) { fence = make();map.set(sessionId, fence); }
 return fence;
}
function changed(fence: Fence): void { fence.version += 1;for (const listener of fence.listeners) listener(); }

function route(client: QueryClient, event: QueryCacheNotifyEvent): void {
 if (event.type !== "updated") return;
 const key = event.query.queryKey as readonly unknown[];
 if (key[0] !== "session" || typeof key[1] !== "string") return;
 const fence = get(client, key[1]), action = event.action;
 if (key.length === 2) {
  if (action.type === "fetch") fence.inflight ??= tabSeq();
  // A manual write is not a read: it neither consumes the in-flight fetch's issue number nor becomes a read of its own.
  else if (action.type === "success" && action.manual !== true) { if (fence.inflight !== undefined) { fence.latestRead = { data: event.query.state.data, issued: fence.inflight };changed(fence); } fence.inflight = undefined; }
  else if (action.type === "error") fence.inflight = undefined;
 } else if (key.length === 3 && key[2] === "merge") {
  if (action.type === "fetch") fence.readinessInflight ??= tabSeq();
  else if (action.type === "success" && action.manual !== true) { if (fence.readinessInflight !== undefined && (fence.readinessDenied === undefined || fence.readinessInflight > fence.readinessDenied.seq)) { fence.readinessDenied = undefined;changed(fence); } fence.readinessInflight = undefined; }
  else if (action.type === "error") { fence.readinessDenied = { seq: fence.readinessInflight ?? tabSeq() };fence.readinessInflight = undefined;changed(fence); }
 }
}

/** The fence for one session in this QueryClient. The cache subscription is installed once per client and stays for its lifetime, so it also sees requests whose view has unmounted. */
export function fenceFor(client: QueryClient, sessionId: string): Fence {
 if (!installed.has(client)) { installed.add(client);client.getQueryCache().subscribe(event => { route(client, event); }); }
 return get(client, sessionId);
}

/** This tab first observes a record: when it wrote it, or when it first read it from storage. Later observations keep the first. */
export function observeRecord(fence: Fence, recordKey: string): void {
 if (!fence.observed.has(recordKey)) { fence.observed.set(recordKey, tabSeq());changed(fence); }
}

/** Binds the fence to the identity that is reading it. A different identity gets a clean fence: nothing an earlier identity observed, read or was refused can apply to it. */
export function bindIdentity(fence: Fence, identity: string | undefined): void {
 if (identity === undefined || fence.identity === identity) return;
 if (fence.identity !== undefined) { fence.latestRead = undefined;fence.inflight = undefined;fence.readinessDenied = undefined;fence.readinessInflight = undefined;fence.observed.clear(); }
 fence.identity = identity;changed(fence);
}

/** Re-renders the caller whenever the fence changes. */
export function useFence(sessionId: string): Fence {
 const client = useQueryClient(), fence = fenceFor(client, sessionId);
 useSyncExternalStore(listener => { fence.listeners.add(listener); return () => { fence.listeners.delete(listener); }; }, () => fence.version, () => 0);
 return fence;
}
