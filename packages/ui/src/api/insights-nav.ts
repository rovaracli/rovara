import { useMemo } from "react";
import { useQuery } from "@tanstack/react-query";
import { z } from "zod";
import { useAppHost } from "../host.js";
import { createApiClient } from "./client.js";
import { isInsightsOn } from "../screens/insights/insights-flags.js";
/**
 * The navigation entry's check, kept apart from `insights.ts` so the always-loaded shell does not carry the Insights readers (they live in the Insights screen's own lazy chunk).
 * It asks the overview route and reads only `enabled`. Switch off: no request is made at all. A refusal (403, 404) or any failure means no entry.
 */
const EnabledReader = { parse: (value: unknown) => z.object({ enabled: z.boolean() }).parse(value) };
export function useInsightsNavVisible(person: string): boolean {
 const host = useAppHost(), on = isInsightsOn(host), api = useMemo(() => createApiClient(host), [host]);
 const read = useQuery({ queryKey: ["insights", person, "nav"], queryFn: () => api.get("/v1/app/insights", EnabledReader), enabled: on, retry: false, refetchOnWindowFocus: false, staleTime: 30_000 });
 return on && read.data?.enabled === true;
}
