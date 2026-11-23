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
type State = { sequence: number; read?: BedrockView | undefined; error?: string | undefined; busy: boolean; lock?: Lock | undefined };
const stores = new Map<string, { state: State; listeners: Set<() => void> }>();
// Identity-scoped authority/fences outlive component lifetimes; storage holds unknown writes across reloads/tabs.
function storeFor(key: string) {
 let store = stores.get(key);
 if (!store) { store = { state: { sequence: 0, busy: false }, listeners: new Set() }; stores.set(key, store); }
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
 const [region, setRegion] = useState("us-west-2"), [roleArn, setRoleArn] = useState("");
 const [presets, setPresets] = useState<Record<string, string>>({}), [models, setModels] = useState<Record<string, string>>({});
 const [fresh, setFresh] = useState(false);
 const [command, setCommand] = useState<string>(), [notice, setNotice] = useState<string>();
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
  if (!allowed) return; setNotice(undefined); setCommand(undefined);
  const sequence = store.get().sequence + 1; store.set({ sequence, busy: true });
  try { await identity(); const setup = await get(`${PATH}/setup/${encodeURIComponent(region)}`, bedrockSetup);
   if (sequence !== store.get().sequence) return;
   if (setup.companyId !== context.orgId || setup.region !== region) throw new Error();
   setPresets(setup.presets); setModels({});
  } catch { store.set({ error: "Couldn't load Bedrock models. Check the connection and try again." }); }
  finally { if (sequence === store.get().sequence) store.set({ busy: false }); }
 }
 async function setupCommand() {
  if (!allowed || Object.keys(models).length === 0) return;
  setNotice(undefined); setCommand(undefined);
  try { await identity(); const response = await host.transport.request({ method: "POST", path: `${PATH}/setup`, body: { region, models, allowGlobal: false }, retry: "never" });
   if (response.status !== 200) throw new Error(); const result = bedrockCommand.parse(response.body);
   if (result.companyId !== context.orgId) throw new Error();
   setCommand(result.command);
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
   if (sequence === store.get().sequence) store.set({ read: result, error: undefined, lock: undefined });
   await query.invalidateQueries({ queryKey: ["ai-spend", context.orgId, context.developerId, context.role, "agent-ai"], exact: true });
  } catch (error) {
   if (error instanceof ApiError && ["CSRF_INVALID", "CSRF_STALE"].includes(error.code)) { host.storage.set(key, ""); store.set({ lock: undefined, error: "Couldn't change that. Check your sign-in and try again." }); }
   else if (sent && isConnectionRefusal(error, method === "POST" ? `${PATH}/recover` : PATH)) { host.storage.set(key, ""); store.set({ lock: undefined }); setNotice(error.message); }
   else if (sent) setNotice(unknown);
   else store.set({ error: "Couldn't verify the current connection. Check again." });
  } finally { if (sequence === store.get().sequence) store.set({ busy: false }); }
 }
 const connection = state.read?.connection;
 return <section aria-label="Your own Bedrock" aria-busy={state.busy}>
  <h3>Your own Bedrock</h3><p>Claude for agents, billed to your AWS account. Live release qualification is pending; the checks below describe this saved connection only.</p>
  {state.error && <p role="alert">{state.error}</p>}
  {state.lock && <p role="alert">{unknown}</p>}{notice && <p role="status">{notice}</p>}
  <Button disabled={state.busy} onClick={() => { void read(); }}>Check Bedrock connection</Button>
  {state.read && !state.error && <><p>{state.read.usage}</p>{connection ? <><p>{connection.roleArn}</p><p>Region: {connection.region}. Connected: {connection.connected ? "Yes" : "No"}. Checked: {viewerTime(connection.checkedAt)}</p><ul>{connection.models.map(m => <li key={m.name}>{m.name}: {m.state}</li>)}</ul>{connection.notEnabledSteps && <p>{connection.notEnabledSteps}</p>}</> : <p>No Bedrock role is connected.</p>}</>}
  {allowed && <><label>Bedrock region<input value={region} onChange={e => { setRegion(e.target.value); setModels({}); setPresets({}); setCommand(undefined); }} /></label>
   <Button onClick={() => { void loadModels(); }}>Load Bedrock models</Button>
   {Object.entries(presets).map(([name, id]) => <label key={name}><input type="checkbox" checked={models[name] === id} onChange={e => { const next = { ...models }; if (e.target.checked) next[name] = id; else delete next[name]; setModels(next); setCommand(undefined); }} />{name}</label>)}
   <Button disabled={Object.keys(models).length === 0} onClick={() => { void setupCommand(); }}>Generate AWS setup command</Button>
   {command && <><p>Have your AWS administrator review and run this command in your AWS account.</p><pre>{command}</pre></>}
   <label>Bedrock role ARN<input value={roleArn} onChange={e => setRoleArn(e.target.value)} /></label>
   <Button disabled={!roleArn || Object.keys(models).length === 0} onClick={() => { void change("PUT"); }}>Check and save Bedrock</Button>
   {connection && <Button onClick={() => { void change("DELETE"); }}>Remove Bedrock connection</Button>}
   {state.read?.removedUntil && <><p>Recovery available until {viewerTime(state.read.removedUntil)}.</p><Button onClick={() => { void change("POST"); }}>Recover Bedrock connection</Button></>}
  </>}
 </section>;
}
