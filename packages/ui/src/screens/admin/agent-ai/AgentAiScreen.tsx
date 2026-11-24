import { useState } from "react";
import { AGENT_AI_ENDPOINT_PATH, AGENT_AI_PATH, readAgentAi, type AgentAiRead } from "../../../api/admin-agent-ai.js";
import { TextField } from "../../../design/TextField.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { AdminSection } from "../parts.js";
import { useConnectionChange } from "../ai-spending/connection-change.js";
import { HeldConnection } from "../ai-spending/HeldConnection.js";

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
 const [baseUrl, setBaseUrl] = useState(""), [key, setKey] = useState(""), [models, setModels] = useState(""), [validation, setValidation] = useState<string>();
 const change = useConnectionChange({ path: AGENT_AI_ENDPOINT_PATH, readPath: AGENT_AI_PATH, reader: { parse: readAgentAi }, revision: settings.keysRevision!, revisionOf: value => value.keysRevision ?? -1, reload });
 const { busy, notice } = change;
 async function send(method: "PUT" | "DELETE", body: Record<string, unknown>, done: string) {
  setValidation(undefined);
  try { await change.send(method, body, done); } finally { setKey(""); }
 }
 function connect() {
  const parsed = parseEndpointModels(models);
  if (parsed === undefined) { setValidation("List 1 to 20 models, one per line, as name=provider/model."); return; }
  void send("PUT", { baseUrl: baseUrl.trim(), key: key.trim(), models: parsed }, settings.endpointConnected === true ? "Endpoint replaced." : "Endpoint connected.");
 }
 return <AdminSection title="Your own endpoint" note={settings.endpointConnected === true ? "Connected" : "Not connected"}>
  {!change.held && notice !== undefined && <p role={notice.ok ? "status" : "alert"}><VisibleText text={notice.text} /></p>}
  {validation && <p role="alert">{validation}</p>}
  <HeldConnection change={change} checkLabel="Check own endpoint" />
  <fieldset disabled={busy || change.held} style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}>
  <form data-testid="agent-ai-endpoint-form" onSubmit={event => { event.preventDefault(); connect(); }}>
   <TextField label="Address (https, port 443)" value={baseUrl} onChange={event => setBaseUrl(event.target.value)} spellCheck={false} autoComplete="off" />
   <TextField label="Key" type="password" value={key} onChange={event => setKey(event.target.value)} spellCheck={false} autoComplete="new-password" />
   <div className="rv-field"><label htmlFor="agent-ai-endpoint-models">Models, one per line: name=provider/model</label><textarea id="agent-ai-endpoint-models" className="rv-input" value={models} onChange={event => setModels(event.target.value)} spellCheck={false} rows={4} /></div>
   <Button type="submit" busy={busy} disabled={baseUrl.trim() === "" || key.trim() === "" || models.trim() === ""}>{settings.endpointConnected === true ? "Replace endpoint" : "Connect endpoint"}</Button>
  </form>
  {settings.endpointConnected === true && <p><Button busy={busy} onClick={() => { void send("DELETE", {}, "Endpoint removed."); }}>Remove endpoint</Button></p>}
  </fieldset>
 </AdminSection>;
}
