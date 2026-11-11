import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { AppNavReaderSchema, type ReadAppNav } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";
/** The app navigation answer (`GET /v1/app/nav`), the same cached read the shell makes under the ["nav"] key. */
export function useNav() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery<ReadAppNav>({ queryKey: ["nav"], queryFn: () => api.get("/v1/app/nav", AppNavReaderSchema) });
}
