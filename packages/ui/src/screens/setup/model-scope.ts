import { createContext, useCallback, useEffect, useMemo, useRef } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import type { ApiRequest } from "../../host.js";
import { useAppHost } from "../../host.js";

export const DEFAULT_MODEL = "@default";
/** How a model id is shown in a choice list. The default shows the id; G2's "Change a model" provides the model's display name. A choice's value is always the id. */
export const ModelNames = createContext<(id: string) => string>(id => id);
export const BACK_TO_DEFAULT = "Go back to Rovara's default";
export const modelScopeId = (company: string, person: string, role: string) => JSON.stringify([company, person, role]);
export const defaultModelText = (model: string | null) => model === null ? "Rovara's default (current model can't be shown yet)" : `Rovara's default (currently ${model})`;

/** Local lifetime fence: the transport has no abort API. Cancel query work and reject late
 * replies before they can apply a response, retry a request or continue a multi-write save. */
export function useModelScope(prefix: string, company: string, person: string, role: string, suffix?: string) {
 const host = useAppHost(), query = useQueryClient(), live = useRef(true);
 const key = useMemo(() => [prefix, company, person, role, ...(suffix === undefined ? [] : [suffix])], [prefix, company, person, role, suffix]);
 useEffect(() => {
  live.current = true;
  return () => { live.current = false; void query.cancelQueries({ queryKey: key }); query.removeQueries({ queryKey: key }); };
 }, [query, key]);
 const request = useCallback(async (input: ApiRequest) => {
  const check = () => { if (!live.current) throw new ApiError(0, "SCOPE_ENDED", "This model settings view has closed."); };
  check(); const answer = await host.transport.request(input); check(); return answer;
 }, [host]);
 // The client stores request; it never invokes the transport during render.
 // eslint-disable-next-line react-hooks/refs
 const api = useMemo(() => createApiClient({ ...host, transport: { request } }), [host, request]);
 return { api, key, active: () => live.current };
}
