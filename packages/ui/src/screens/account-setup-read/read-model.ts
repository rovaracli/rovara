import { createContext, useContext, useMemo, type ReactNode } from "react";
import { useQuery, useQueryClient, type QueryClient, type QueryFilters, type UseQueryResult } from "@tanstack/react-query";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import { createApiClient, type Reader } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { servedReadState } from "../../api/served-read.js";
import { useAppHost } from "../../host.js";
import { readMySignIns } from "../../api/sign-ins.js";

/** The shared reader filters invalid rows; a complete read must account for all. */
export function readCompleteSignIns(body: unknown) {
 const parsed = readMySignIns(body);
 if (typeof body !== "object" || body === null || !("signIns" in body) ||
     !Array.isArray(body.signIns) || body.signIns.length !== parsed.signIns.length) {
  throw new Error("Incomplete sign-ins read");
 }
 return parsed;
}

export type AccountReadIdentity = ReturnType<typeof AppMeResponseReaderSchema.parse>;
export const IdentityContext = createContext<AccountReadIdentity | undefined>(undefined);
export function useReadIdentity(): AccountReadIdentity {
 const value = useContext(IdentityContext);
 if (value === undefined) throw new Error("Account read needs a current identity");
 return value;
}
/**
 * A slot beside the read frame, not inside it. A node pinned here (the show-once secret dialog) is held by the frame itself, so a failed or repeated
 * read of who you are, which replaces the frame's children with Loading or an error block, never removes it. Memory only: nothing here is stored.
 */
export const PinContext = createContext<(node: ReactNode) => void>(() => undefined);
export function usePin(): (node: ReactNode) => void { return useContext(PinContext); }
function useReadClient() {
 const host = useAppHost();
 // The shared client normally launches sign-in on 401. A read-only slot must
 // report access loss without launching any authentication flow.
 return useMemo(() => createApiClient({ ...host, signIn: () => undefined }), [host]);
}
// No re-read on window focus: a person switching tabs must not unmount a half-filled live form that sits under this read (Change name, the setup steps).
export function useIdentityRead() {
 const api = useReadClient();
 return useQuery({ queryKey: ["g5-account-setup", "/v1/app/me"], queryFn: () => api.get("/v1/app/me", AppMeResponseReaderSchema, undefined, { retry: "never" }), retry: false, gcTime: 0, staleTime: 0, refetchOnMount: "always", refetchOnWindowFocus: false });
}
/** Identity facts in the key keep an older in-flight read out of the fresh view. */
export function useScopedRead<T>(path: string, reader: Reader<T>) {
 const me = useReadIdentity(), api = useReadClient(), cache = useQueryClient();
 const verifyIdentity = async () => {
  try {
   const current = await api.get("/v1/app/me", AppMeResponseReaderSchema, undefined, { retry: "never" });
   if (current.org.orgId !== me.org.orgId || current.developer.id !== me.developer.id ||
       current.developer.orgRole !== me.developer.orgRole || current.developer.name !== me.developer.name ||
       current.developer.nameChosen !== me.developer.nameChosen || current.org.name !== me.org.name) {
    throw new ApiError(403, "IDENTITY_CHANGED", "The current account changed.");
   }
  } catch (error) {
   // A failed or changed identity read ends validity for every sibling, including
   // cached successes. A fresh parent read restores the current role/profile too.
   void cache.invalidateQueries({ queryKey: ["g5-account-setup", "/v1/app/me"], exact: true });
   throw error;
  }
 };
 return useQuery({ queryKey: ["g5-account-setup", me.org.orgId, me.developer.id, me.developer.orgRole, me.developer.name, me.developer.nameChosen, me.org.name, path], queryFn: async () => {
  // Existing endpoints do not repeat viewer ids in their payloads. A read is
  // accepted only between two successful reads of the same company/person.
  await verifyIdentity();
  const value = await api.get(path, reader, undefined, { retry: "never" });
  await verifyIdentity();
  return value;
 }, retry: false, gcTime: 0, staleTime: 0, refetchOnMount: "always" });
}


/**
 * G5's one read rule is the shared one (DEC 254zzz324, servedReadState + isAccessEnded): a failed re-read keeps the last good facts with one
 * "Updated HH:MM · Reconnecting" line; only an access signal (401, 403, 404 or a shared access code) clears them. The last good facts also stay
 * while the same read is fetched again. Nothing is drawn from a read this mount has not finished yet.
 */
export function servedFacts<T>(read: UseQueryResult<T, Error>): { data: T | undefined; staleSince: number | undefined } {
 return read.isFetchedAfterMount && !read.isPending ? servedReadState(read) : { data: undefined, staleSince: undefined };
}
/** After a write that already succeeded: read the matching reads again and say whether any of them could not be refreshed. */
export async function rereadFailed(cache: QueryClient, filters: QueryFilters): Promise<boolean> {
 await cache.invalidateQueries(filters);
 return cache.getQueryCache().findAll({ ...filters, type: "active" }).some(entry => entry.state.status === "error");
}
/** The sentence a success carries when the re-read after it did not answer. */
export const COULDNT_REFRESH = "Couldn't refresh; reconnecting.";

/**
 * ONE write rule for every G5 action (DEC 254zzz324: retained facts never grant write authority). An action is offered, and sent, only while the
 * person's identity read AND the read the action stands on are FRESH: answered by this mount and not kept after a failed re-read. A read that
 * kept its last facts (a 503, a timeout) still shows them with the Reconnecting line, but grants nothing. Every G5 write uses this and nothing else.
 */
export const IdentityFreshContext = createContext(false);
export const isFresh = (read: UseQueryResult<unknown, Error>): boolean => { const { data, staleSince } = servedFacts(read); return data !== undefined && staleSince === undefined; };
export function useWritable(...reads: readonly UseQueryResult<unknown, Error>[]): boolean {
 const identityFresh = useContext(IdentityFreshContext);
 return identityFresh && reads.every(isFresh);
}
/**
 * The last SUCCESSFUL write in this view (F7). The frame (ReadEntry) holds it, above the read states, so it survives the identity read failing: a re-read after a
 * write that answers 401 / 403 / 404 (a sign-in unlink ends every session, so that is the NORMAL path) must never say "Nothing was changed".
 * Every G5 write calls `useNoteWrite()` the moment its send succeeded; the page-level error block then says what is true.
 */
export const READ_FAILED_SAFE = "Rovara couldn't read this page.";
export const WROTE_SAFE = "Your change went through.";
export const SIGNIN_REMOVED_SAFE = "Sign-in removed. You've been signed out; sign in again with another method.";
export type WriteKind = "changed" | "signin-removed";
export const WROTE_SENTENCE: Record<WriteKind, string> = { changed: WROTE_SAFE, "signin-removed": SIGNIN_REMOVED_SAFE };
export const WroteContext = createContext<{ wrote: WriteKind | undefined; note: (kind: WriteKind) => void }>({ wrote: undefined, note: () => undefined });
/** Call right after a write's send succeeded (before its re-read). */
export function useNoteWrite(): (kind?: WriteKind) => void {
 const { note } = useContext(WroteContext);
 return (kind = "changed") => { note(kind); };
}
/** The `safe` sentence for an error block: set only when a write succeeded in this view. */
export function useWroteSafe(): string | undefined {
 const { wrote } = useContext(WroteContext);
 return wrote === undefined ? undefined : WROTE_SENTENCE[wrote];
}
/** What a refused send says. Nothing was sent. */
export const STALE_REFUSAL = "Can't tell yet: this page hasn't confirmed it is up to date. Nothing was changed.";
