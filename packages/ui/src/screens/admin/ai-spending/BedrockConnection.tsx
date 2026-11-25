import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost, type AppHost } from "../../../host.js";
import type { Reader } from "../../../api/client.js";
import { ApiError, apiError } from "../../../api/errors.js";
import { bedrockView, bedrockSetup, bedrockCommand, type BedrockView } from "../../../api/bedrock.js";
import { viewerTime } from "../../../design/viewer-time.js";
import { Button } from "../../../design/Button.js";
import { useAdminContext } from "../AdminLayout.js";
import { connectionHoldAt, connectionIdentity, CONNECTION_UNKNOWN, isConnectionRefusal, observeConnectionHold, persistConnectionHold } from "./connection-change.js";

type Lock = { requestId: string; expectedRevision: number; body: Record<string, unknown>; startedAt: number };
/** What the person has changed in the form so far. A field left out is not changed: the form shows the saved connection's. It lives with the rest of the page's state, so a remount keeps it. */
type Draft = { region?: string; roleArn?: string; presets?: Record<string, string>; models?: Record<string, string>; command?: string | undefined };
type State = { sequence: number; read?: BedrockView | undefined; error?: string | undefined; busy: boolean; lock?: Lock | undefined; draft: Draft };
/** How each model's state is worded; the plain words stay as they are. */
const STATE_WORDS: Record<string, string> = { no_quota: "not usable right now (AWS quota is 0 or used up)", no_answer: "AWS did not answer, check again" };
/** Check again is refused for 30 seconds after the last check: say how long is left, from the time the page now shows. */
const BEDROCK_CHECK_GAP_SECONDS = 30;
const checkedRecently = (checkedAt: number | undefined, now: number): string => {
 const left = checkedAt === undefined ? 0 : Math.ceil((checkedAt + BEDROCK_CHECK_GAP_SECONDS * 1000 - now) / 1000);
 return `Checked recently. Try again in ${String(left > 0 ? Math.min(left, BEDROCK_CHECK_GAP_SECONDS) : BEDROCK_CHECK_GAP_SECONDS)} seconds.`;
};
const stateWords = (state: string) => STATE_WORDS[state] ?? (["ready", "not_enabled", "refused", "not_found", "unavailable"].includes(state) ? state : "not known, check again");
const stores = new Map<string, { state: State; listeners: Set<() => void> }>();
// Identity-scoped authority/fences outlive component lifetimes; storage holds unknown writes across reloads/tabs.
function storeFor(key: string) {
 let store = stores.get(key);
 if (!store) { store = { state: { sequence: 0, busy: false, draft: {} }, listeners: new Set() }; stores.set(key, store); }
 const value = store;
 return { get: () => value.state, subscribe: (fn: () => void) => { value.listeners.add(fn); return () => { value.listeners.delete(fn); }; },
  set: (patch: Partial<State>) => { value.state = { ...value.state, ...patch }; value.listeners.forEach(fn => fn()); } };
}
const PATH = "/v1/app/org/bedrock";
const unknown = CONNECTION_UNKNOWN;
function lockAt(storage: AppHost["storage"], key: string): Lock | undefined {
 const value = connectionHoldAt(storage, key) as Lock | undefined;
 if (value && !value.body) throw new Error("Unreadable pending change");
 return value;
}
export function BedrockConnection() {
 const context = useAdminContext();
 return <BedrockForm key={`${context.orgId}:${context.developerId}`} />;
}
function BedrockForm() {
 const context = useAdminContext(), host = useAppHost(), query = useQueryClient();
 async function get<T>(path: string, schema: Reader<T>): Promise<T> { const result = await host.transport.request({ method: "GET", path, retry: "never" }); if (result.status !== 200) throw apiError(result.status, result.body, host.origin); return schema.parse(result.body); }
 const key = `bedrock:${context.orgId}:${context.developerId}:connection`;
 const store = useMemo(() => storeFor(key), [key]);
 const state = useSyncExternalStore(store.subscribe, store.get, store.get);
 const [fresh, setFresh] = useState(false);
 const [notice, setNotice] = useState<string>();
 // The form starts from the saved connection (never a built-in Region) and keeps what the person changed in the page's store.
 const saved = state.read?.connection;
 const savedModels = useMemo<Record<string, string>>(() => Object.fromEntries((saved?.models ?? []).map(m => [m.name, m.id])), [saved]);
 const region = state.draft.region ?? saved?.region ?? "", roleArn = state.draft.roleArn ?? saved?.roleArn ?? "";
 const models = state.draft.models ?? savedModels, presets = state.draft.presets ?? savedModels, command = state.draft.command;
 const setDraft = (patch: Draft) => store.set({ draft: { ...store.get().draft, ...patch } });
 const allowed = fresh && !context.checking && (context.role === "owner" || context.role === "admin") && !state.error && state.read?.canChange === true && !state.busy && !state.lock;
 async function identity() {
  await connectionIdentity(host, context);
 }
 async function read() {
  const sequence = store.get().sequence + 1; store.set({ sequence, busy: true }); setNotice(undefined);
  try {
   await identity(); const value = await get(PATH, bedrockView); await identity();
   if (sequence !== store.get().sequence) return;
   const lock = lockAt(host.storage, key);
   // A post-write read of a strictly newer revision is an observed outcome, never attribution to our write.
   if (lock && observeConnectionHold(host.storage, key, lock, value.revision)) { store.set({ lock: undefined }); }
   else store.set({ lock });
   store.set({ read: value, error: undefined, busy: false }); setFresh(true);
  } catch { if (sequence === store.get().sequence) store.set({ error: "Couldn't read the current Bedrock connection. Check again.", busy: false }); }
 }
 useEffect(() => {
  try { store.set({ lock: lockAt(host.storage, key) }); } catch { store.set({ error: "This change can't be made safely in this browser." }); }
  void Promise.resolve().then(read);
  const changed = (event: StorageEvent) => { if (event.key === key || event.key === null) { try { store.set({ lock: lockAt(host.storage, key), error: "Connection state changed in another tab. Check again." }); } catch { store.set({ error: "This change can't be made safely in this browser." }); } } };
  window.addEventListener("storage", changed); return () => { window.removeEventListener("storage", changed); };
  // Identity changes create a separate store and a fresh read.
  // eslint-disable-next-line react-hooks/exhaustive-deps
 }, [key, store]);
 async function loadModels() {
  if (!allowed || region.trim() === "") return; setNotice(undefined); setDraft({ command: undefined });
  const sequence = store.get().sequence + 1; store.set({ sequence, busy: true });
  try { await identity(); const setup = await get(`${PATH}/setup/${encodeURIComponent(region)}`, bedrockSetup);
   if (sequence !== store.get().sequence) return;
   if (setup.companyId !== context.orgId || setup.region !== region) throw new Error();
   setDraft({ presets: setup.presets, models: {} });
  } catch { store.set({ error: "Couldn't load Bedrock models. Check the connection and try again." }); }
  finally { if (sequence === store.get().sequence) store.set({ busy: false }); }
 }
 async function setupCommand() {
  if (!allowed || Object.keys(models).length === 0) return;
  setNotice(undefined); setDraft({ command: undefined });
  try { await identity(); const response = await host.transport.request({ method: "POST", path: `${PATH}/setup`, body: { region, models, allowGlobal: false }, retry: "never" });
   if (response.status !== 200) throw new Error(); const result = bedrockCommand.parse(response.body);
   if (result.companyId !== context.orgId) throw new Error();
   setDraft({ command: result.command });
  } catch { store.set({ error: "Couldn't generate the setup command. Check the connection and try again." }); }
 }
 async function change(method: "PUT" | "DELETE" | "POST") {
  if (!allowed || store.get().busy || store.get().lock) return;
  const snapshot = store.get().read!; const sequence = store.get().sequence + 1; store.set({ sequence, busy: true }); setNotice(undefined);
  let sent = false;
  try {
   await identity();
   const current = await get(PATH, bedrockView); await identity();
   if (sequence !== store.get().sequence || !current.canChange || current.revision !== snapshot.revision) throw new Error("changed");
   if (lockAt(host.storage, key)) { store.set({ lock: lockAt(host.storage, key) }); return; }
   const body = { requestId: crypto.randomUUID(), expectedRevision: current.revision, ...(method === "PUT" ? { roleArn, region, models, allowGlobal: false } : {}) };
   const lock = { requestId: body.requestId, expectedRevision: current.revision, body, startedAt: Date.now() };
   try { persistConnectionHold(host.storage, key, lock); } catch { setNotice("This change can't be made safely in this browser."); return; }
   store.set({ lock }); sent = true;
   const response = await host.transport.request({ method, path: method === "POST" ? `${PATH}/recover` : PATH, body, retry: "never" });
   if (response.status !== 200) throw apiError(response.status, response.body, host.origin);
   const result = bedrockView.parse(response.body);
   if (result.revision <= current.revision) throw new Error("unconfirmed revision");
   host.storage.set(key, "");
   // What was saved (or removed, or recovered) is now the form's starting point: the draft has done its job.
   if (sequence === store.get().sequence) store.set({ read: result, error: undefined, lock: undefined, draft: {} });
   await query.invalidateQueries({ queryKey: ["ai-spend", context.orgId, context.developerId, context.role, "agent-ai"], exact: true });
  } catch (error) {
   if (error instanceof ApiError && ["CSRF_INVALID", "CSRF_STALE"].includes(error.code)) { host.storage.set(key, ""); store.set({ lock: undefined, error: "Couldn't change that. Check your sign-in and try again." }); }
   else if (sent && isConnectionRefusal(error, method === "POST" ? `${PATH}/recover` : PATH)) { host.storage.set(key, ""); store.set({ lock: undefined }); setNotice(error.message); }
   else if (sent) setNotice(unknown);
   else store.set({ error: "Couldn't verify the current connection. Check again." });
  } finally { if (sequence === store.get().sequence) store.set({ busy: false }); }
 }
 /** "Check Bedrock connection": runs the connection test again for the saved connection (POST .../check) and shows the new time and results. Nothing is held: a lost answer is safe to ask again. */
 async function check() {
  if (!allowed || !state.read?.connection) { void read(); return; }
  const sequence = store.get().sequence + 1; store.set({ sequence, busy: true }); setNotice(undefined);
  let current: BedrockView | undefined, sent = false, reread = false;
  try {
   await identity();
   current = await get(PATH, bedrockView); await identity();
   if (sequence !== store.get().sequence || !current.canChange || current.connection === null) throw new Error("changed");
   // The fresh read is what the page shows from here on, whatever the check answers.
   store.set({ read: current });
   sent = true;
   const response = await host.transport.request({ method: "POST", path: `${PATH}/check`, body: { requestId: crypto.randomUUID(), expectedRevision: current.revision }, retry: "never" });
   if (response.status !== 200) throw apiError(response.status, response.body, host.origin);
   const result = bedrockView.parse(response.body);
   if (result.revision <= current.revision) throw new Error("unconfirmed revision");
   if (sequence === store.get().sequence) store.set({ read: result, error: undefined });
   await query.invalidateQueries({ queryKey: ["ai-spend", context.orgId, context.developerId, context.role, "agent-ai"], exact: true });
  } catch (error) {
   if (!sent) store.set({ error: "Couldn't verify the current connection. Check again." });
   else if (!(error instanceof ApiError)) setNotice("Couldn't check the connection. Try again.");
   // Access lost between the read and the check: nothing of the connection stays on screen (the error hides it and the form).
   else if (error.status === 401 || error.status === 403) store.set({ error: "Couldn't check that. Check your sign-in and try again." });
   else if (error.status === 404) { setNotice(error.message); reread = true; }
   else if (error.status === 429) setNotice(checkedRecently(current?.connection?.checkedAt, Date.now()));
   else setNotice(error.message);
  } finally { if (sequence === store.get().sequence) store.set({ busy: false }); }
  // The connection is gone: show what is there now.
  if (reread) await read();
 }
 const connection = saved;
 return <section aria-label="Your own Bedrock" aria-busy={state.busy}>
  <h3>Your own Bedrock</h3><p>Claude for agents, billed to your AWS account. Live release qualification is pending; the checks below describe this saved connection only.</p>
  {state.error && <p role="alert">{state.error}</p>}
  {state.lock && <p role="alert">{unknown}</p>}{notice && <p role="status">{notice}</p>}
  <Button disabled={state.busy} onClick={() => { void check(); }}>Check Bedrock connection</Button>
  {state.read && !state.error && <><p>{state.read.usage}</p>{connection ? <><p style={{ overflowWrap: "anywhere" }}>{connection.roleArn}</p><p>Region: {connection.region}. Connected: {connection.connected ? "Yes" : "No"}. Checked: {viewerTime(connection.checkedAt)}</p><ul>{connection.models.map(m => <li key={m.name}>{m.name}: {stateWords(m.state)}</li>)}</ul>{connection.notEnabledSteps && <p>{connection.notEnabledSteps}</p>}{connection.quotaSteps && <p role="status">{connection.quotaSteps}</p>}</> : <p>No Bedrock role is connected.</p>}</>}
  {allowed && <><label>Bedrock region<input value={region} onChange={e => { setDraft({ region: e.target.value, models: {}, presets: {}, command: undefined }); }} /></label>
   <Button disabled={region.trim() === ""} onClick={() => { void loadModels(); }}>Load Bedrock models</Button>
   {Object.entries(presets).map(([name, id]) => <label key={name}><input type="checkbox" checked={models[name] === id} onChange={e => { const next = { ...models }; if (e.target.checked) next[name] = id; else delete next[name]; setDraft({ models: next, command: undefined }); }} />{name}</label>)}
   <Button disabled={Object.keys(models).length === 0} onClick={() => { void setupCommand(); }}>Generate AWS setup command</Button>
   {command && <><p>Have your AWS administrator review and run this command in your AWS account.</p><pre>{command}</pre></>}
   <label>Bedrock role ARN<input value={roleArn} onChange={e => { setDraft({ roleArn: e.target.value }); }} /></label>
   <Button disabled={!roleArn || Object.keys(models).length === 0} onClick={() => { void change("PUT"); }}>Check and save Bedrock</Button>
   {connection && <Button onClick={() => { void change("DELETE"); }}>Remove Bedrock connection</Button>}
   {state.read?.removedUntil && <><p>Recovery available until {viewerTime(state.read.removedUntil)}.</p><Button onClick={() => { void change("POST"); }}>Recover Bedrock connection</Button></>}
  </>}
 </section>;
}
