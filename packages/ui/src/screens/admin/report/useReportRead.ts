// The report reads: scoped to the signed-in company, person and role like every admin read (dropped when access is lost), kept as read until the person asks again.
import { useEffect, useMemo } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { createApiClient, type Reader } from "../../../api/client.js";
import { useAdminContext } from "../AdminLayout.js";

export function useReportRead<T>(area: string, path: string, schema: Reader<T>) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const { orgId, developerId, role } = useAdminContext();
 useEffect(() => () => { const key = ["admin", "report", area, orgId, developerId, role]; void query.cancelQueries({ queryKey: key }); query.removeQueries({ queryKey: key }); }, [query, area, orgId, developerId, role]);
 return useQuery({ queryKey: ["admin", "report", area, orgId, developerId, role, path], queryFn: () => api.get(path, schema), gcTime: 0, retry: false, refetchOnWindowFocus: false });
}
