import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AppMeResponseReaderSchema } from "@agentx/contracts/web";
import { createApiClient, type Reader } from "../../../api/client.js";
import { ApiError, apiError } from "../../../api/errors.js";
import { useAppHost, type AppHost } from "../../../host.js";
import { isCsrfFailure, postWithTimeout } from "../../../safe-action.js";
import { useAdminContext, type AdminContext } from "../admin-context.js";

export const CONNECTION_UNKNOWN = "Rovara didn't confirm this yet. Check the connection before making another change.";
/** Said when a send is attempted while a change waits for confirmation. Never a silent refusal. */
export const CONNECTION_HELD_SEND = "Nothing was sent. An earlier change hasn't been confirmed yet. Check the connection first.";
/** The pause line in each card of a held company AI change, before Check. (CONNECTION_UNKNOWN stays Bedrock's own words.) */
export const CONNECTION_PAUSED = "A key change on this page isn't confirmed yet, so changes are paused. Check the connection to continue.";
/** Said when Check reads the same settings as before the unconfirmed change: long form in the card that made the change, short form in the others. */
export const CONNECTION_NOT_CONFIRMED = "Rovara still shows the same settings as before your change, so it may not have been saved. What you see here is current. If it looks right, choose Continue with these settings.";
export const CONNECTION_NOT_CONFIRMED_SHORT = "Not confirmed. The settings shown are current. If they look right, choose Continue with these settings.";
/** Said when the answer to a key change never arrived: the change may or may not have been saved. */
export const CONNECTION_NO_ANSWER = "Rovara didn't get an answer, so it can't tell whether the new key was saved.";
const NOT_OBSERVED = "The connection change hasn't been confirmed. Check the current settings.";
const ACCESS_CHANGED = "Company access changed. Reload to check access.";
// Cloud's connection routes map only these pre-write refusals (learning-ai-routes.ts,
// agent-ai-routes.ts, bedrock-byo-routes.ts). All other outcomes retain the hold.
// safe-action's action-refusal list does not cover these routes.
const CONNECTION_PATHS = ["/v1/app/org/learning-ai/key", "/v1/app/org/agent-ai/endpoint", "/v1/app/org/bedrock", "/v1/app/org/bedrock/recover"];
const CONNECTION_REFUSALS: readonly (readonly [number, string])[] = [
 [400, "CONFIG_INVALID"],
 [403, "FORBIDDEN"],
 [404, "NOT_FOUND"],
 [409, "CONFLICT"],
 [413, "CONFIG_INVALID"],
];
export function isConnectionRefusal(error: unknown, path: string): error is ApiError {
 return error instanceof ApiError && CONNECTION_PATHS.includes(path) && CONNECTION_REFUSALS.some(([status, code]) => error.status === status && error.code === code);
}
export type ConnectionHold = { requestId: string; expectedRevision: number; startedAt: number };

// Bedrock and credential forms use the same live company/person/admin check, never a cached identity.
export async function connectionIdentity(host: AppHost, context: Pick<AdminContext, "orgId" | "developerId">): Promise<void> {
 try {
  const response = await host.transport.request({ method: "GET", path: "/v1/app/me", retry: "never" });
  if (response.status !== 200) throw apiError(response.status, response.body, host.origin);
  const me = AppMeResponseReaderSchema.parse(response.body);
  if (me.org.orgId !== context.orgId || me.developer.id !== context.developerId || !["owner", "admin"].includes(me.developer.orgRole)) throw new Error(ACCESS_CHANGED);
 } catch { throw new Error(ACCESS_CHANGED); }
}

// The existing Bedrock pending-write metadata. Credential forms persist only these fields, never the body or key.
export function connectionHoldAt(storage: AppHost["storage"], key: string): ConnectionHold | undefined {
 const raw = storage.get(key); if (raw === undefined || raw === "") return undefined;
 const value = JSON.parse(raw) as ConnectionHold;
 if (typeof value.requestId !== "string" || !Number.isSafeInteger(value.expectedRevision) || !Number.isFinite(value.startedAt)) throw new Error("Unreadable pending change");
 return value;
}
export function persistConnectionHold(storage: AppHost["storage"], key: string, hold: ConnectionHold): void {
 const value = JSON.stringify(hold); storage.set(key, value);
 if (storage.get(key) !== value) throw new Error("This change can't be made safely in this browser.");
}
// A strictly newer read observes a state, without attributing it to the unresolved press (Bedrock's rule).
export function observeConnectionHold(storage: AppHost["storage"], key: string, hold: ConnectionHold, revision: number): boolean {
 if (revision <= hold.expectedRevision) return false;
 storage.set(key, ""); return true;
}

/** Shared one-shot credential send and explicit Check. No send body is retained for retry. */
export function useConnectionChange<T>({ path, readPath, reader, revision, revisionOf, reload }: {
 path: string; readPath: string; reader: Reader<T>; revision: number; revisionOf: (value: T) => number; reload: () => void;
}) {
 const host = useAppHost(), context = useAdminContext(), api = useMemo(() => createApiClient(host), [host]);
 const key = `connection:${context.orgId}:${context.developerId}:${path}`;
 const [held, setHeld] = useState(() => { try { return connectionHoldAt(host.storage, key) !== undefined; } catch { return true; } });
 const [busy, setBusy] = useState(false), [notice, setNotice] = useState<{ ok: boolean; text: string }>();
 // True once a Check read the same revision as the unconfirmed change: the person may then release the hold on purpose.
 const [unconfirmed, setUnconfirmed] = useState(false);
 const running = useRef(false), autoChecked = useRef(false);
 // As with Bedrock, another tab's change requires an explicit Check before this form can act.
 useEffect(() => {
  const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) setHeld(true); };
  window.addEventListener("storage", changed); return () => window.removeEventListener("storage", changed);
 }, [key]);
 async function send(method: "PUT" | "DELETE", body: Record<string, unknown>, done: string): Promise<boolean> {
  if (running.current) return false;
  if (held) { setNotice({ ok: false, text: CONNECTION_HELD_SEND }); return false; }
  running.current = true; setBusy(true); setNotice(undefined);
  let persisted = false;
  try {
   await connectionIdentity(host, context);
   if (connectionHoldAt(host.storage, key)) { setHeld(true); setNotice({ ok: false, text: CONNECTION_HELD_SEND }); return false; }
   const hold = { requestId: crypto.randomUUID(), expectedRevision: revision, startedAt: Date.now() };
   persistConnectionHold(host.storage, key, hold); setHeld(true); persisted = true;
   const response = await postWithTimeout(() => host.transport.request({ method, path, body: { ...body, requestId: hold.requestId, expectedRevision: revision }, retry: "never" }));
   if (response.status !== 200) throw apiError(response.status, response.body, host.origin);
   const result = reader.parse(response.body);
   if (revisionOf(result) <= revision) throw new Error(NOT_OBSERVED);
   host.storage.set(key, ""); setHeld(false); setNotice({ ok: true, text: done }); reload(); return true;
  } catch (error) {
   if (isCsrfFailure(error) || isConnectionRefusal(error, path)) { host.storage.set(key, ""); setHeld(false); }
   // Past the point of sending, a lost or unreadable answer leaves the key's fate unknown: say that, not "try again" (the buttons are paused).
   const unknownOutcome = persisted && !(isCsrfFailure(error) || isConnectionRefusal(error, path)) && !(error instanceof Error && error.message === NOT_OBSERVED);
   setNotice({ ok: false, text: unknownOutcome ? CONNECTION_NO_ANSWER : error instanceof Error ? error.message : "Couldn't save that. Check the connection." });
   return false;
  } finally { running.current = false; setBusy(false); }
 }
 async function check(): Promise<void> {
  if (running.current) return;
  running.current = true; setBusy(true); setNotice(undefined); setUnconfirmed(false);
  try {
   // A corrupt marker can't be compared with a revision: it is an unconfirmed change, read the same way and released only on purpose.
   let hold: ConnectionHold | undefined, corrupt = false;
   try { hold = connectionHoldAt(host.storage, key); } catch { corrupt = true; }
   await connectionIdentity(host, context);
   const current = await api.get(readPath, reader, undefined, { retry: "never" });
   await connectionIdentity(host, context);
   if (corrupt || (hold && !observeConnectionHold(host.storage, key, hold, revisionOf(current)))) {
    // Never a dead end: say what Check saw, show the current state, and let the person release the hold explicitly.
    setUnconfirmed(true); setNotice({ ok: false, text: CONNECTION_NOT_CONFIRMED }); reload(); return;
   }
   setHeld(false); setNotice({ ok: true, text: "Connection checked. Read the current settings before making another change." }); reload();
  } catch (error) { setNotice({ ok: false, text: error instanceof ApiError ? error.message : error instanceof Error ? error.message : "Couldn't read the current connection. Check again." }); }
  finally { running.current = false; setBusy(false); }
 }
 /** The person has read the current settings after an unconfirmed change and chooses to continue. Only after a Check that saw no newer revision (or found an unreadable marker). */
 const release = useCallback(() => {
  if (!unconfirmed || running.current) return;
  try {
   host.storage.set(key, "");
   const after = host.storage.get(key);
   if (after !== undefined && after !== "") throw new Error("not cleared");
  } catch { setNotice({ ok: false, text: "Couldn't clear the pending change in this browser, so nothing was released. Check again, or reload." }); return; }
  setHeld(false); setUnconfirmed(false); setNotice({ ok: true, text: "Changes are unlocked. The settings shown are the current ones." }); reload();
 }, [unconfirmed, host, key, reload]);
 // A hold found on load is checked once, so a change that did land clears itself without a press. No loop: a failed or unchanged Check waits for the person.
 // The timer keeps the Check's state updates out of the effect body; the first render's closure is enough (it reads only refs, host and key).
 const [heldOnLoad] = useState(held);
 useEffect(() => {
  if (!heldOnLoad) return;
  const timer = setTimeout(() => {
   if (autoChecked.current) return;
   autoChecked.current = true;
   // A readable or an unreadable marker alike (an absent one means another tab already resolved it).
   let present: boolean;
   try { present = connectionHoldAt(host.storage, key) !== undefined; } catch { present = true; }
   if (present) void check();
  }, 0);
  return () => { clearTimeout(timer); };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- once per load
 }, []);
 return { busy, held, notice, unconfirmed, send, check, release };
}
