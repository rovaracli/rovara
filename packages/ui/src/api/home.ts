import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { HomeResponseReaderSchema } from "@agentx/contracts/web";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";
export function useHome() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: ["home"], queryFn: () => api.get("/v1/app/home", HomeResponseReaderSchema) });
}
// RULING Q22: no dismissCard mutation until the owning backend supplies its route and response contract.
