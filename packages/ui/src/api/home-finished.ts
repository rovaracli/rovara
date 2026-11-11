import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { SessionListReaderSchema } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";
// Its own module: the session list contract is large, and today's Home (api/home.ts) must not load it. Only the new Home imports this.
/**
 * The new Home's "Finished recently" (experience lane exp/home): my ended work, newest first, from the existing `GET /v1/app/sessions?owner=me&status=ended` (the work list reads it too).
 * The key starts with "home", so a home notice (and a card's own action) reads it again with the cards.
 */
export type ReadFinishedSession = ReturnType<typeof SessionListReaderSchema.parse>["sessions"][number];
export const HOME_FINISHED_LIMIT = 5;
export function useHomeFinished() {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 return useQuery({ queryKey: ["home", "finished"], queryFn: () => api.get("/v1/app/sessions?owner=me&status=ended&limit=" + String(HOME_FINISHED_LIMIT), SessionListReaderSchema) });
}
