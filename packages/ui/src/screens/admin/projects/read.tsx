import { useEffect, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { createApiClient, type Reader } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { useAdminContext } from "../AdminLayout.js";
export function useAdminRead<T>(area: string, resource: string, path: string, reader: Reader<T>) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const { orgId, developerId } = useAdminContext();
 useEffect(() => () => { const key = ["admin", area, orgId, developerId, resource];void query.cancelQueries({ queryKey: key, exact: true });query.removeQueries({ queryKey: key, exact: true }); }, [query, area, orgId, developerId, resource]);
 // Reading the signal lets Query discard cancelled results; transport requests and retries may still finish.
 return useQuery({ queryKey: ["admin", area, orgId, developerId, resource], queryFn: ({ signal }) => { signal.throwIfAborted();return api.get(path, reader); }, gcTime: 0, refetchOnWindowFocus: false });
}
export function ReadState<T>({ read, label, children }: { read: ReturnType<typeof useAdminRead<T>>; label: string; children: (data: T) => ReactNode }) {
 const denied = read.error instanceof ApiError && ([401, 403, 404].includes(read.error.status) || read.error.code === "INVALID_RESPONSE");
 const stale = read.isError && read.data !== undefined && !denied, fatal = read.isError && !stale;
 // Use the shared button styles without Button.busy, which disables the native control.
 // This same button survives retries and remains focusable while requests run.
 return <div aria-busy={read.isFetching}>
  {read.isFetched && <button type="button" className="rv-button rv-button-secondary" aria-disabled={read.isFetching || undefined} aria-busy={read.isFetching} onClick={() => { if (!read.isFetching) void read.refetch(); }}>{fatal || read.data === undefined ? "Try again" : `Refresh ${label}`}</button>}
  {read.isPending ? <Skeleton label={`Loading ${label}`} /> : fatal ? <p role="alert">{read.error instanceof ApiError && read.error.status === 403 ? `You don't have permission to view ${label}.` : read.error instanceof ApiError && read.error.status === 404 ? `${label} unavailable. It may not exist or be visible to you.` : `Couldn't load ${label}. Try again.`}</p> : <>
   {stale && <p role="alert">This {label} view is stale. Retry to check current information.</p>}
   {read.data !== undefined && children(read.data)}
  </>}
 </div>;
}
