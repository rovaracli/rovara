import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppNavReaderSchema } from "@agentx/contracts/web";
import { createApiClient } from "../../api/client.js";
import { useAppHost } from "../../host.js";
/** The signed-in person and company, from the same read the shell makes (shared by its query key, so it is not asked twice). */
export function useNav() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: ["nav"], queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema) }).data;
}
