import { useMemo, useState } from "react";
import { AGENT_AI_ENDPOINT_PATH, type AgentAiRead } from "../../../api/admin-agent-ai.js";
import { TextField } from "../../../design/TextField.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { AdminSection } from "../parts.js";

/** One model per line: `<name the endpoint serves>=<catalog provider>/<catalog model>` (the catalog model sets prices and limits). */
export function parseEndpointModels(text: string): Array<{ name: string; catalog: { provider: string; modelId: string } }> | undefined {
 const lines = text.split("\n").map(line => line.trim()).filter(line => line !== "");
 if (lines.length < 1 || lines.length > 20) return undefined;
 const models: Array<{ name: string; catalog: { provider: string; modelId: string } }> = [];
 for (const line of lines) {
  const at = line.indexOf("="); const name = line.slice(0, at).trim(); const catalog = line.slice(at + 1).trim(); const slash = catalog.indexOf("/");
  if (at < 1 || slash < 1 || slash === catalog.length - 1) return undefined;
  models.push({ name, catalog: { provider: catalog.slice(0, slash), modelId: catalog.slice(slash + 1) } });
 }
 return models;
}

/** DEC 254t (A3): connect, replace or remove the company's own endpoint. The key is write-only: it is sent once and never shown. */
export function Endpoint({ settings, reload }: { settings: AgentAiRead; reload: () => void }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const [baseUrl, setBaseUrl] = useState(""), [key, setKey] = useState(""), [models, setModels] = useState(""), [busy, setBusy] = useState(false), [notice, setNotice] = useState<{ ok: boolean; text: string }>();
 async function send(method: "PUT" | "DELETE", body: Record<string, unknown>, done: string) {
  setBusy(true); setNotice(undefined);
  try {
   await api.sendAnswer(method, AGENT_AI_ENDPOINT_PATH, { requestId: crypto.randomUUID(), expectedRevision: settings.keysRevision, ...body }, { parse: answer => answer }, { retry: "never" });
   setNotice({ ok: true, text: done }); setKey(""); reload();
  } catch (error) { setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again." }); }
  finally { setBusy(false); }
 }
 function connect() {
  const parsed = parseEndpointModels(models);
  if (parsed === undefined) { setNotice({ ok: false, text: "List 1 to 20 models, one per line, as name=provider/model." }); return; }
  void send("PUT", { baseUrl: baseUrl.trim(), key: key.trim(), models: parsed }, settings.endpointConnected === true ? "Endpoint replaced." : "Endpoint connected.");
 }
 return <AdminSection title="Your own endpoint" note={settings.endpointConnected === true ? "Connected" : "Not connected"}>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"}><VisibleText text={notice.text} /></p>}
  <form data-testid="agent-ai-endpoint-form" onSubmit={event => { event.preventDefault(); connect(); }}>
   <TextField label="Address (https, port 443)" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} spellCheck={false} autoComplete="off" />
   <TextField label="Key" type="password" value={key} onChange={event => setKey(event.target.value)} spellCheck={false} autoComplete="new-password" />
   <div className="rv-field"><label htmlFor="agent-ai-endpoint-models">Models, one per line: name=provider/model</label><textarea id="agent-ai-endpoint-models" className="rv-input" value={models} onChange={event => setModels(event.target.value)} spellCheck={false} rows={4} /></div>
   <Button type="submit" busy={busy} disabled={baseUrl.trim() === "" || key.trim() === "" || models.trim() === ""}>{settings.endpointConnected === true ? "Replace endpoint" : "Connect endpoint"}</Button>
  </form>
  {settings.endpointConnected === true && <p><Button busy={busy} onClick={() => { void send("DELETE", {}, "Endpoint removed."); }}>Remove endpoint</Button></p>}
 </AdminSection>;
}
