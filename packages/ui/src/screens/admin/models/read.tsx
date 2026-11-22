import { useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { createApiClient, type Reader } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { isAccessEnded, servedReadState } from "../../../api/served-read.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { useAdminContext } from "../AdminLayout.js";

// `stable`: a window refocus or reconnect never re-reads (a page with unsaved edits or a pending save result must not be reset under the person).
// Only the explicitly projected schema output enters the identity-scoped cache.
export function useAdminRead<T>(area: string, path: string, schema: Reader<T>, options?: { stable?: boolean }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const { orgId, developerId, role } = useAdminContext();
 useEffect(() => () => { const key = ["admin", "lane-c", area, orgId, developerId, role];void query.cancelQueries({ queryKey: key, exact: true });query.removeQueries({ queryKey: key, exact: true }); }, [query, area, orgId, developerId, role]);
 return useQuery({ queryKey: ["admin", "lane-c", area, orgId, developerId, role], queryFn: () => api.get(path, schema), gcTime: 0, ...(options?.stable === true ? { refetchOnWindowFocus: false, refetchOnReconnect: false } : {}) });
}
/** What a company admin page says for a read this install does not serve (Cloud's fixed 501 NOT_ON_CODE_YET). */
export const NOT_ON_THIS_ROVARA = "Not available on this Rovara yet.";
/** Cloud's fixed answer for a route this install does not serve: exactly 501 with NOT_ON_CODE_YET (any other 501 or code is a failure). */
export function isNotOnThisRovara(error: unknown): boolean { return error instanceof ApiError && error.status === 501 && error.code === "NOT_ON_CODE_YET"; }
export function ReadSection<T>({ read, label, children, localControls = false }: { read: UseQueryResult<T>; label: string; children: (data: T) => ReactNode; /** Content whose controls only filter the returned facts; no sends, authorization links or confirmations. */ localControls?: boolean }) {
 const { data, staleSince } = servedReadState(read);
 const stale = staleSince !== undefined;
 // Cloud's fixed 501 NOT_ON_CODE_YET: this install does not serve the read at all. That does not change on a retry, so it is a calm status, not an alert.
 const notHere = !stale && isNotOnThisRovara(read.error);
 // An unreadable first answer keeps its existing error description; it never becomes access loss.
 // On refresh the shared policy instead retains only the last validated success.
 const visible = data !== undefined && !notHere;
 return <section aria-label={label} aria-busy={read.isFetching}>
 {read.isPending ? <Skeleton label={"Loading " + label.toLowerCase()} /> : <>
 {notHere && <p role="status">{NOT_ON_THIS_ROVARA}</p>}
 {read.isError && !stale && !notHere && <><p role="alert">{read.error instanceof ApiError && read.error.status === 403 ? "You don't have permission to view this information." : isAccessEnded(read.error) || (read.error instanceof ApiError && read.error.code === "INVALID_RESPONSE") ? "This information is unavailable. Reload or try again." : "Couldn't load this information. Try again."}</p><Button disabled={read.isFetching} onClick={() => { void read.refetch(); }}>Retry {label.toLowerCase()}</Button></>}
 {stale && <><p className="rv-muted" role="status">Updated {new Date(staleSince).toLocaleString("en-US", { timeZone: "UTC" })} UTC · Reconnecting</p><Button disabled={read.isFetching} onClick={() => { void read.refetch(); }}>Retry {label.toLowerCase()}</Button></>}
 {visible && <fieldset disabled={stale && !localControls} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
  onClickCapture={event => { if (stale && !localControls) { event.preventDefault();event.stopPropagation(); } }}
  onSubmitCapture={event => { if (stale && !localControls) { event.preventDefault();event.stopPropagation(); } }}>
  {children(data!)}
 </fieldset>}
 {visible && !stale && <p className="rv-muted">Read at {new Date(read.dataUpdatedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC. This is a stored snapshot.</p>}
 </>}
 </section>;
}
export function checkedTime(value: string | undefined) { if (value === undefined) return "Unavailable";const time = new Date(value);return Number.isFinite(time.getTime()) ? time.toLocaleString("en-US", { timeZone: "UTC" }) + " UTC" : "Unavailable"; }
