import { useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient, type UseQueryResult } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { createApiClient, type Reader } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
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
export function ReadSection<T>({ read, label, children }: { read: UseQueryResult<T>; label: string; children: (data: T) => ReactNode }) {
 const forbidden = read.error instanceof ApiError && ([401, 403, 404].includes(read.error.status) || read.error.code === "INVALID_RESPONSE");
 const visible = read.data !== undefined && !forbidden;
 return <section aria-label={label} aria-busy={read.isFetching}>
 {read.isPending ? <Skeleton label={"Loading " + label.toLowerCase()} /> : <>
 {read.isError && <><p role="alert">{read.error instanceof ApiError && read.error.status === 403 ? "You don't have permission to view this information." : forbidden ? "This information is unavailable. Reload or try again." : visible ? "This information is stale. Refresh failed; try again." : "Couldn't load this information. Try again."}</p><Button disabled={read.isFetching} onClick={() => { void read.refetch(); }}>Retry {label.toLowerCase()}</Button></>}
 {visible && children(read.data!)}
 {visible && <p className="rv-muted">Read at {new Date(read.dataUpdatedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC. This is a stored snapshot.</p>}
 </>}
 </section>;
}
export function checkedTime(value: string | undefined) { if (value === undefined) return "Unavailable";const time = new Date(value);return Number.isFinite(time.getTime()) ? time.toLocaleString("en-US", { timeZone: "UTC" }) + " UTC" : "Unavailable"; }
