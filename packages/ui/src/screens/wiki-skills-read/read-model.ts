import { createContext, useContext, useMemo, useState } from "react";
import { useQuery, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { AppMeResponseReaderSchema, ProjectOverviewProjectSchema } from "@agentx/contracts/web";
import { createApiClient, type Reader } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost, type AppHost } from "../../host.js";
import { SkillReader, SkillsReader } from "../../api/skills.js";
import { isAccessEnded, isLocalMissing, markLocalMissing, servedReadState } from "../../api/served-read.js";
export { SkillReader, SkillsReader };
export { SKILL_LIMITS } from "../../api/skills.js";
// The shared reader drops unreadable/duplicate rows; retain that incompleteness here.
export const SkillsListReader = { parse(body: unknown) {
 const value = SkillsReader.parse(body);
 const partial = typeof body === "object" && body !== null && "skills" in body && Array.isArray(body.skills) && body.skills.length !== value.skills.length;
 return { ...value, partial };
} };
const hosts = new WeakMap<AppHost, number>(); let nextHost = 0;
function hostKey(host: AppHost) { let id = hosts.get(host); if (id === undefined) { id = ++nextHost; hosts.set(host, id); } return id; }
export const Scope = createContext<{ key: readonly (string | number)[]; project: string } | undefined>(undefined);
// A refused scope stays fenced across remounts and late/background successes.
function denyScope(client: QueryClient, key: readonly (string | number)[], error: unknown) {
 client.setQueryData([...key, "denied"], error);
 for (const query of client.getQueryCache().findAll({ queryKey: key })) {
  if (query.queryKey.at(-1) !== "denied") query.setState({ data: undefined });
 }
}
/**
 * One mounted page keeps its last good read on screen while that read is fetched again (a write, a return to the tab): the form, draft and refusal sentence stay.
 * Only a read this mount has already shown is kept; a first read, or one that comes from an earlier visit, still shows "Loading" until it is confirmed.
 * A failed read is not kept: it still revokes write controls (the callers draw them only from an error-free read) and an access signal still wipes the data.
 */
export function useKept<R extends { data: unknown; isFetching: boolean }>(read: R, id: string): R {
 const [shown, setShown] = useState<string>();
 const has = read.data !== undefined;
 if (!has && shown !== undefined) setShown(undefined);
 else if (has && !read.isFetching && shown !== id) setShown(id);
 return has && read.isFetching && shown === id ? { ...read, isFetching: false } : read;
}
export function useIdentity() {
 const client = useQueryClient();
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const token = hostKey(host);
 const raw = useQuery({ queryKey: ["g3", token, "identity"], queryFn: async () => {
  try { return await api.get("/v1/app/me", AppMeResponseReaderSchema, undefined, { retry: "never" }); }
  catch (error) {
   if (isAccessEnded(error)) for (const query of client.getQueryCache().findAll({ queryKey: ["g3", token] })) {
    if (query.queryKey.length === 6) denyScope(client, query.queryKey.slice(0, 5) as (string | number)[], error);
   }
   throw error;
  }
 }, staleTime: 0, retry: false });
 const read = useKept(raw, "identity");
 return { token, read };
}
export function useScope() { const scope = useContext(Scope); if (scope === undefined) throw new Error("Wiki read context unavailable"); return scope; }
export function useDenial(key: readonly (string | number)[]) {
 return useQuery<ApiError | null>({ queryKey: [...key, "denied"], queryFn: async () => null, initialData: null, enabled: false });
}
/** `local`: the read is about ONE page or skill; its 404 is a local not-found, not the end of the whole scope's access (a 401 / 403 still is). */
export function useRead<T>(part: string, tail: string, reader: Reader<T>, enabled = true, local = false) {
 const scope = useScope(), host = useAppHost(), client = useQueryClient(), api = useMemo(() => createApiClient(host), [host]);
 const project = ProjectOverviewProjectSchema.shape.name.parse(scope.project);
 const raw = useQuery({ queryKey: [...scope.key, part], enabled, retry: false, staleTime: 0, queryFn: async () => {
  try {
   const result = await api.get("/v1/app/projects/" + encodeURIComponent(project) + "/" + tail, reader, undefined, { retry: "never" });
   // A valid response for a different subject never becomes visible.
   if (typeof result === "object" && result !== null && "project" in result && result.project !== project) throw new ApiError(502, "INVALID_RESPONSE", "Wrong project");
   const denial = client.getQueryData<ApiError | null>([...scope.key, "denied"]);
   if (denial !== undefined && denial !== null) throw denial;
   return result;
  } catch (error) {
   if (local) markLocalMissing(error);
   if (isAccessEnded(error) && !(local && isLocalMissing(error))) denyScope(client, scope.key, error);
   throw error;
  }
 } });
 const read = useKept(raw, part);
 // `refetching` is the read's own fetch flag: `isFetching` is false while the last good read is kept. Only a NEW use of a grant (opening a list from it) waits for the refetch.
 return { ...read, data: servedReadState(read).data, refetching: raw.isFetching };
}
export function failed(read: { isError: boolean; failureCount: number; error: unknown; data: unknown; dataUpdatedAt: number; failureReason?: unknown }) { return servedReadState(read).data === undefined; }
