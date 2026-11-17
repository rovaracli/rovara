// AI for your agents (DEC 240): which AI the company's agents use. Three choices: Rovara's AI (nothing to paste, charged per use on the
// company's bill), the company's own Anthropic key (connected on the Learning AI key page), or the company's own Bedrock (coming soon).
// Company admins only. A change needs a fresh sign-in, which the server checks too. Agents use only the saved choice: Rovara never
// switches to another one by itself.
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { AGENT_AI_PATH, readAgentAi, type AgentAiRead, type AgentAiSource } from "../../../api/admin-agent-ai.js";
import { isNotConnected, needsStepUp } from "../../../api/admin-company.js";
import { createApiClient } from "../../../api/client.js";
import { ApiError } from "../../../api/errors.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { ReadSection, useAdminRead } from "../models/read.js";
import { AdminSection, FreshSignIn, NotConnected, forgetConfirmed, useJustConfirmed } from "../parts.js";

const reader = { parse: readAgentAi };
const CHOICE: Readonly<Record<AgentAiSource, { label: string; text: string }>> = Object.freeze({
 rovara: { label: "Rovara's AI", text: "Claude, run by Rovara. Nothing to paste. Charged per use on the company's bill, inside the company's monthly budget." },
 anthropic_key: { label: "Your own Anthropic key", text: "Agents use the company's own Anthropic account. Anthropic bills you directly. Connect the key on the Learning AI key page." },
 bedrock_byo: { label: "Your own Bedrock", text: "Agents use Claude in your company's own AWS account. Coming soon." },
 openai_key: { label: "Your own OpenAI key", text: "Agents use the company's own OpenAI account. OpenAI bills you directly. Connect the key on the Learning AI key page." },
 openrouter_key: { label: "Your own OpenRouter key", text: "Agents use the company's own OpenRouter account. OpenRouter bills you directly. Connect the key on the Learning AI key page." },
});

export function AgentAiScreen() {
 const read = useAdminRead("agent-ai", AGENT_AI_PATH, reader, { stable: true });
 return <section><PageHeader focusOnMount title="AI for your agents" description="Choose which AI the company's agents use. Agents use only the choice saved here; Rovara never switches to another one by itself." />
  {read.isError && isNotConnected(read.error) && read.error instanceof ApiError && read.error.status === 501 ? <AdminSection title="AI for your agents"><NotConnected what="AI for your agents" /></AdminSection>
   : <ReadSection read={read} label="AI for your agents">{settings => <Choice settings={settings} reload={() => { void read.refetch(); }} />}</ReadSection>}
 </section>;
}

function Choice({ settings, reload }: { settings: AgentAiRead; reload: () => void }) {
 const { developerId } = useAdminContext(), host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const confirmed = useJustConfirmed(developerId);
 const [picked, setPicked] = useState<AgentAiSource | undefined>(settings.source ?? undefined);
 const [stale, setStale] = useState(false), [busy, setBusy] = useState(false), [notice, setNotice] = useState<{ ok: boolean; text: string }>();
 const ready = confirmed && !stale;
 async function save(source: AgentAiSource) {
  setBusy(true); setNotice(undefined);
  try {
   await api.sendAnswer("PUT", AGENT_AI_PATH, { expectedVersion: settings.version, source }, { parse: answer => answer }, { retry: "never" });
   setNotice({ ok: true, text: `Saved. Agents now use ${CHOICE[source].label}.` });
   await query.invalidateQueries({ queryKey: ["admin", "lane-c", "agent-ai"] }); reload();
  } catch (error) {
   if (needsStepUp(error)) { setStale(true); forgetConfirmed(host.storage, developerId); }
   else setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again." });
  } finally { setBusy(false); }
 }
 const current = settings.source === null ? "Not chosen yet" : CHOICE[settings.source].label;
 return <>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"}><VisibleText text={notice.text} /></p>}
  {!ready && <FreshSignIn action="change the AI the company's agents use" refused={stale} />}
  <AdminSection title="AI for your agents" note={current}>
   {settings.source === null && <p data-testid="agent-ai-unset">No choice is saved yet, so agents use the company's own Anthropic key when one is connected.</p>}
   <fieldset aria-label="AI for your agents" disabled={!ready || busy}><legend>Choose one</legend>
    {settings.listed.map(source => <label key={source} data-testid={`agent-ai-${source}`}>
     <input type="radio" name="agent-ai" value={source} checked={picked === source} disabled={!settings.available[source]} onChange={() => setPicked(source)} />
     <b>{CHOICE[source].label}</b>{!settings.available[source] && " (coming soon)"}: {CHOICE[source].text}
     {source === "anthropic_key" && settings.anthropicKeyConnected === false && <> <span data-testid="agent-ai-no-key">No Anthropic key is connected yet.</span></>}
     {source === "openai_key" && settings.openaiKeyConnected === false && <> <span data-testid="agent-ai-no-openai-key">No OpenAI key is connected yet.</span></>}
     {source === "openrouter_key" && settings.openrouterKeyConnected === false && <> <span data-testid="agent-ai-no-openrouter-key">No OpenRouter key is connected yet.</span></>}
    </label>)}
   </fieldset>
   {ready && <p><Button variant="primary" busy={busy} disabled={picked === undefined || picked === settings.source || !settings.available[picked]} onClick={() => { if (picked !== undefined) void save(picked); }}>Save</Button></p>}
  </AdminSection>
 </>;
}
