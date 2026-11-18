// Dormant until Code supplies an explicit create grant. The parent must not infer one from a company role.
import { useEffect, useMemo, useRef, useState } from "react";
import { flushSync } from "react-dom";
import { CreateScriptTokenBodySchema, SCRIPT_TOKEN_DEFAULT_DAYS, SCRIPT_TOKEN_MAX_DAYS, SCRIPT_TOKEN_PERMISSIONS, type CreateScriptTokenBody } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createScriptTokenApi, scriptTokenError } from "../../api/script-tokens.js";
import { Button } from "../../design/Button.js";

export function CreateAutomationKey({ onCreated }: { onCreated: () => void }) {
 const host = useAppHost(), api = useMemo(() => createScriptTokenApi(host), [host]);
 const alive = useRef(true), sending = useRef(false);
 const [name, setName] = useState(""), [projects, setProjects] = useState(""), [days, setDays] = useState(SCRIPT_TOKEN_DEFAULT_DAYS);
 const [permissions, setPermissions] = useState<CreateScriptTokenBody["permissions"]>(["read"]);
 // Only component state owns this value: no URL, host storage, query/mutation cache, telemetry or logs.
 const [secret, setSecret] = useState<string>(), [finished, setFinished] = useState(false), [busy, setBusy] = useState(false), [problem, setProblem] = useState<string>(), [copied, setCopied] = useState(false), [left, setLeft] = useState(false);
 useEffect(() => {
  alive.current = true;
  // A browser history snapshot may preserve this component without unmounting it. Clear before the page is frozen.
  const leave = () => { alive.current = false; flushSync(() => { setSecret(undefined); setLeft(true); }); };
  window.addEventListener("pagehide", leave);
  return () => { alive.current = false; window.removeEventListener("pagehide", leave); };
 }, []);
 async function create() {
  if (sending.current || finished) return;
  const parsed = CreateScriptTokenBodySchema.safeParse({ requestId: crypto.randomUUID(), name, projects: projects.split(/\r?\n/u).map(p => p.trim()).filter(Boolean), permissions, days });
  if (!parsed.success) { setProblem("Choose a name, at least one project and permission, and a lifetime from 1 to 90 days."); return; }
  sending.current = true; setBusy(true); setProblem(undefined);
  try {
   const made = await api.create(parsed.data);
   if (!alive.current) return;
   setSecret(made.secret); setFinished(true); onCreated();
  } catch (error) {
   if (!alive.current) return;
   setProblem(scriptTokenError(error, "create"));
  } finally { sending.current = false; if (alive.current) setBusy(false); }
 }
 async function copy() {
  if (secret === undefined) return;
  try {
   if (host.copyText === undefined) throw new Error("Clipboard unavailable");
   await host.copyText(secret); if (alive.current) setCopied(true);
  } catch { if (alive.current) setProblem("Couldn't copy the key. Select and copy it yourself."); }
 }
 if (left) return <p role="status">For your safety, reload this page before creating another automation key.</p>;
 if (finished) return secret === undefined ? <p role="status">Automation key created. Its secret is no longer shown.</p> : <section aria-label="Your new automation key">
  <p role="status">Save this key now. You won't be able to see this key again. Keep it somewhere safe; anyone with it can use its permissions.</p>
  <pre aria-label="Automation key secret" style={{ whiteSpace: "pre-wrap", overflowWrap: "anywhere" }}>{secret}</pre>
  <Button onClick={() => { void copy(); }}>Copy key</Button>{copied && <p role="status">Key copied.</p>}
  <Button onClick={() => { setSecret(undefined); setProblem(undefined); }}>I've saved the key</Button>
  {problem && <p role="alert">{problem}</p>}
 </section>;
 return <form onSubmit={event => { event.preventDefault(); void create(); }}>
  <p><label>Name<input value={name} maxLength={60} onChange={event => setName(event.target.value)} /></label></p>
  <p><label>Projects (one name per line)<textarea value={projects} onChange={event => setProjects(event.target.value)} /></label></p>
  <fieldset><legend>Permissions</legend>{SCRIPT_TOKEN_PERMISSIONS.map(permission => <div key={permission}><label><input type="checkbox" checked={permissions.includes(permission)} onChange={event => setPermissions(previous => event.target.checked ? [...previous, permission] : previous.filter(p => p !== permission))} />{permission === "lessons" ? "Team knowledge" : permission}</label>{permission === "lessons" && <p className="rv-muted">Lets AI tools read your team's rules and lessons, and suggest new ones for a person to review.</p>}</div>)}</fieldset>
  <p><label>Expires after (days)<input type="number" min={1} max={SCRIPT_TOKEN_MAX_DAYS} value={days} onChange={event => setDays(Number(event.target.value))} /></label></p>
  <Button type="submit" variant="primary" busy={busy}>Create automation key</Button>
  {problem && <p role="alert">{problem}</p>}
 </form>;
}
