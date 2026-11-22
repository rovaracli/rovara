import { useEffect, useMemo, useReducer, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import { OutcomeNotConfirmed } from "../../design/OutcomeNotConfirmed.js";
import { createReadClient } from "../../api/read-client.js";
import { AppHostProvider, useAppHost } from "../../host.js";
import { queueActionHost } from "./queue-action-host.js";
import { fenceFor, useUnknownActionExit } from "../../safe-action.js";
import { checkQueuePending, queuePending, queuePendingKeys } from "./queue-action-pending.js";
import { queueActionReads } from "./queue-action-reads.js";
/** The rebuilt pages render the live controls under the G2 transport fence. */
export function QueueActions({ children }: { children: ReactNode }) {
 const host = useAppHost(), query = useQueryClient(), [, changed] = useReducer(value => value + 1, 0);
 const me = useQuery({ queryKey: ["queue", "identity"], retry: false, refetchInterval: current => current.state.status === "error" || current.state.fetchFailureCount > 0 ? 5000 : false, queryFn: () => createReadClient(host).get("/v1/app/me", AppMeResponseReaderSchema) });
 const guarded = useMemo(() => queueActionHost(host, query, () => {
  const state = query.getQueryState<ReturnType<typeof AppMeResponseReaderSchema.parse>>(["queue", "identity"]);
  return state?.status === "success" && state.fetchFailureCount === 0 ? state.data : undefined;
 }, input => queueActionReads(host, query, input), changed), [host, query]);
 useEffect(() => { const update = () => changed();window.addEventListener("storage", update);return () => window.removeEventListener("storage", update); }, []);
 const keys = me.isSuccess && me.failureCount === 0 ? queuePendingKeys(me.data) : [];
 const pendingKeys = JSON.stringify(keys);
 useEffect(() => {
  if (!me.isSuccess || me.failureCount > 0) return;
  let mounted = true;
  const check = async () => { await Promise.all(queuePendingKeys(me.data).map(key => checkQueuePending(host, query, me.data, key)));if (mounted) changed(); };
  void check();
  const unsubscribe = query.getQueryCache().subscribe(event => { if (event.type === "updated" && event.action.type === "success") void check(); });
  return () => { mounted = false;unsubscribe(); };
 }, [host, query, me.data, me.isSuccess, me.failureCount, pendingKeys]);
 return <AppHostProvider host={guarded}>{keys.map(key => <PendingAction key={key} storageKey={key} check={async () => {
  // Keys are rendered only with this identity; Check also re-reads it before and after its own read.
  await checkQueuePending(host, query, me.data!, key, true);await query.invalidateQueries();changed();
 }} />)}{children}</AppHostProvider>;
}
function PendingAction({ storageKey, check }: { storageKey: string; check(this: void): Promise<void> }) {
 const query = useQueryClient();
 let entry;
 try { entry = queuePending(globalThis.localStorage.getItem(storageKey)); } catch { /* Keep the warning if storage failed. */ }
 let parts: string[] = [];
 try { parts = JSON.parse(storageKey.slice("rovara:queue-action:".length)) as string[]; } catch { /* An unreadable subject cannot name a task. */ }
 const subject = String(parts[2] ?? ""), task = subject.startsWith("task:") ? subject.slice(5) : undefined;
 const exit = useUnknownActionExit(fenceFor(query, storageKey, "queue"), entry, task === undefined ? "/app/inbox" : "/t/" + encodeURIComponent(task));
 return <><OutcomeNotConfirmed title="Rovara didn't confirm this yet." happened="An action's answer was not confirmed. Its send lock is kept in this browser." safe="Check the current information without sending the action again." next="Check the current state. An unchanged read cannot confirm what happened to the request." check={{ label: "Check current state", onCheck: () => { void check(); } }} refCode="QUEUE-ACTION-UNCONFIRMED" />{exit !== undefined && <p role="status">{exit.message}. <Link to={exit.href}>Open the task to check</Link></p>}</>;
}
