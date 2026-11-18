// AI for your agents (DEC 240): which AI the company's agents use. Three choices: Rovara's AI (nothing to paste, charged per use on the
// company's bill), the company's own Anthropic key (connected on the Learning AI key page), or the company's own Bedrock (coming soon).
// Company admins only, which the server checks too. Agents use only the saved choice: Rovara never
// switches to another one by itself.
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router";
import { AGENT_AI_ENDPOINT_PATH, AGENT_AI_PATH, readAgentAi, type AgentAiRead, type AgentAiSource } from "../../../api/admin-agent-ai.js";
import { TextField } from "../../../design/TextField.js";
import { isNotConnected } from "../../../api/admin-company.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ReadSection, useAdminRead } from "../models/read.js";
import { AdminSection, NotConnected } from "../parts.js";

const reader = { parse: readAgentAi };
const CHOICE: Readonly<Record<AgentAiSource, { label: string; text: string }>> = Object.freeze({
 rovara: { label: "Rovara's AI", text: "Claude, run by Rovara. Nothing to paste. Charged per use on the company's bill, inside the company's monthly budget." },
 anthropic_key: { label: "Your own Anthropic key", text: "Agents use the company's own Anthropic account. Anthropic bills you directly. Connect the key on the Learning AI key page." },
 bedrock_byo: { label: "Your own Bedrock", text: "Agents use Claude in your company's own AWS account. Coming soon." },
 openai_key: { label: "Your own OpenAI key", text: "Agents use the company's own OpenAI account. OpenAI bills you directly. Connect the key on the Learning AI key page." },
 openrouter_key: { label: "Your own OpenRouter key", text: "Agents use the company's own OpenRouter account. OpenRouter bills you directly. Connect the key on the Learning AI key page." },
 custom_endpoint: { label: "Your own endpoint", text: "Agents use an OpenAI-compatible endpoint your company runs or buys. Connect it below: an https address, its key, and the models it serves." },
});
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

export function AgentAiScreen() {
 const read = useAdminRead("agent-ai", AGENT_AI_PATH, reader, { stable: true });
 return <section><PageHeader focusOnMount title="AI for your agents" description="Choose which AI the company's agents use. Agents use only the choice saved here; Rovara never switches to another one by itself." />
  {read.isError && isNotConnected(read.error) && read.error instanceof ApiError && read.error.status === 501 ? <AdminSection title="AI for your agents"><NotConnected what="AI for your agents" /></AdminSection>
   : <ReadSection read={read} label="AI for your agents">{settings => <Choice settings={settings} reload={() => { void read.refetch(); }} />}</ReadSection>}
 </section>;
}

function Choice({ settings, reload }: { settings: AgentAiRead; reload: () => void }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const [picked, setPicked] = useState<AgentAiSource | undefined>(settings.source ?? settings.effectiveSource ?? undefined);
 const [busy, setBusy] = useState(false), [notice, setNotice] = useState<{ ok: boolean; text: string }>();
 async function save(source: AgentAiSource) {
  setBusy(true); setNotice(undefined);
  try {
   await api.sendAnswer("PUT", AGENT_AI_PATH, { expectedVersion: settings.version, source }, { parse: answer => answer }, { retry: "never" });
   setNotice({ ok: true, text: `Saved. Agents now use ${CHOICE[source].label}.` });
   await query.invalidateQueries({ queryKey: ["admin", "lane-c", "agent-ai"] }); reload();
  } catch (error) {
   setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again." });
  } finally { setBusy(false); }
 }
 const current = settings.source !== null ? CHOICE[settings.source].label : settings.effectiveSource !== null ? `${CHOICE[settings.effectiveSource].label} (the default for your company)` : "Not chosen yet";
 return <>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"}><VisibleText text={notice.text} /></p>}
  <AdminSection title="AI for your agents" note={current}>
   {settings.source === null && settings.effectiveSource === null && <p data-testid="agent-ai-unset">No choice is saved yet, so agents use the company's own Anthropic key when one is connected.</p>}
   {settings.source === null && settings.effectiveSource === "rovara" && <p data-testid="agent-ai-default">Your agents use Rovara's AI by default. There is nothing to connect, and it counts under your company's limits. {settings.available.anthropic_key && settings.anthropicKeyConnected === true
    ? <Button onClick={() => setPicked("anthropic_key")}>Use your own key</Button>
    : <Link className="rv-admin-b1-link" to="/app/admin/learning-ai" data-testid="agent-ai-use-own-key">Use your own key</Link>}</p>}
   {settings.source === null && settings.effectiveSource !== null && settings.effectiveSource !== "rovara" && <p data-testid="agent-ai-default-own">Your agents use {CHOICE[settings.effectiveSource].label} because it is connected. To use Rovara's AI instead, choose it below and save.</p>}
   <fieldset aria-label="AI for your agents" disabled={busy}><legend>Choose one</legend>
    {settings.listed.map(source => <label key={source} data-testid={`agent-ai-${source}`}>
     <input type="radio" name="agent-ai" value={source} checked={picked === source} disabled={!settings.available[source]} onChange={() => setPicked(source)} />
     <b>{CHOICE[source].label}</b>{!settings.available[source] && " (coming soon)"}: {CHOICE[source].text}
     {source === "anthropic_key" && settings.anthropicKeyConnected === false && <> <span data-testid="agent-ai-no-key">No Anthropic key is connected yet.</span></>}
     {source === "openai_key" && settings.openaiKeyConnected === false && <> <span data-testid="agent-ai-no-openai-key">No OpenAI key is connected yet.</span></>}
     {source === "openrouter_key" && settings.openrouterKeyConnected === false && <> <span data-testid="agent-ai-no-openrouter-key">No OpenRouter key is connected yet.</span></>}
     {source === "custom_endpoint" && settings.endpointConnected === false && <> <span data-testid="agent-ai-no-endpoint">No endpoint is connected yet.</span></>}
    </label>)}
   </fieldset>
   <p><Button variant="primary" busy={busy} disabled={picked === undefined || picked === settings.source || !settings.available[picked]} onClick={() => { if (picked !== undefined) void save(picked); }}>Save</Button></p>
  </AdminSection>
  {settings.listed.includes("custom_endpoint") && settings.keysRevision !== null && <Endpoint settings={settings} reload={reload} />}
 </>;
}

/** DEC 254t (A3): connect, replace or remove the company's own endpoint. The key is write-only: it is sent once and never shown. */
function Endpoint({ settings, reload }: { settings: AgentAiRead; reload: () => void }) {
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
