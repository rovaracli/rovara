// Guided onboarding PR 15 (DEC 254l item 7, DEC 254n item 1): the company step "AI and spending", chosen before the first setup run. Three things and
// one Save: who pays for the AI (Rovara's AI, or the company's own provider, connected on its existing page), the model from the company's own
// offered list (the one Code preselects starts picked), and one company monthly limit (the saved one, else the existing default prefilled).
//
// Save writes, in this order: the monthly limit (Cloud's company settings route, only when it changed), the AI source (Cloud's agent AI route,
// only when it changed), then the model, ALWAYS, even when the person keeps the preselected one: a new company never silently depends on this
// Rovara's default (the answer to Code #835's Question part 2). The two money writes need a fresh "confirm it's you"; the server checks it too.
// A plain member sees the step read only. Every refusal shown is the server's own fixed sentence.
//
// PR 9 (the setup shell) places this step; Company settings shows the same component (screens/admin/ai-spending).
import { useMemo, useState } from "react";
import { Link } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { COMPANY_MONTHLY_DEFAULT_USD, ENGINE_MODEL_PATH, dollarsOf, readEngineModel, type EngineModelRead } from "../../api/ai-spend.js";
import { AGENT_AI_PATH, readAgentAi, type AgentAiRead, type AgentAiSource } from "../../api/admin-agent-ai.js";
import { ORG_SETTINGS_PATH, needsStepUp, readCompanySettings, type CompanySettingsRead } from "../../api/admin-company.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { FreshSignIn, forgetConfirmed, useJustConfirmed } from "../admin/parts.js";

export type CompanyRole = "owner" | "admin" | "member";
const MICROS = 1_000_000;
/** The company budgets allow up to $1,000,000 a month. */
const MONTHLY_MAX_USD = 1_000_000;
export const AI_SPEND_STEP_WORDS = Object.freeze({
 title: "AI and spending",
 intro: "Choose who pays for the AI, the model Rovara uses, and the most the company spends on AI in a month. Setup runs use AI, so this comes first.",
 rovara: "Rovara's AI",
 rovaraText: "Nothing to connect. Charged per use on the company's bill, inside the monthly limit.",
 own: "Your own provider",
 ownText: "Your company's own AI account pays the provider directly. Rovara still counts it under the monthly limit.",
 anthropic: "Your own Anthropic key",
 bedrock: "Your own Bedrock",
 connectAnthropic: "Connect your Anthropic key",
 model: "Model",
 modelHint: "From the models your company can use now.",
 limit: "Company monthly limit (USD)",
 limitHint: "Prefilled. AI work stops for the month when the company reaches it.",
 badLimit: "The monthly limit must be an amount in dollars above 0, like 500 or 1500.50, up to 1,000,000.",
 readOnly: "Only a company owner or admin can change this. Ask one of them.",
 saved: "Saved.",
 pending: "The new monthly limit is waiting for another admin to approve it. The rest is saved.",
 action: "save the company's AI and spending",
});
const W = AI_SPEND_STEP_WORDS;
const usdText = (usd: number) => (Number.isInteger(usd) ? String(usd) : usd.toFixed(2));

export function AiSpendStep({ role, developerId, onSaved }: { role: CompanyRole; developerId: string; onSaved?: () => void }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const admin = role === "owner" || role === "admin";
 const scope = ["ai-spend", developerId, role] as const;
 const model = useQuery({ queryKey: [...scope, "engine-model"], queryFn: () => api.get(ENGINE_MODEL_PATH, { parse: readEngineModel }), gcTime: 0, refetchOnWindowFocus: false });
 const source = useQuery({ queryKey: [...scope, "agent-ai"], queryFn: () => api.get(AGENT_AI_PATH, { parse: readAgentAi }), enabled: admin, gcTime: 0, refetchOnWindowFocus: false });
 const settings = useQuery({ queryKey: [...scope, "settings"], queryFn: () => api.get(ORG_SETTINGS_PATH, { parse: readCompanySettings }), enabled: admin, gcTime: 0, refetchOnWindowFocus: false });
 const reads = admin ? [model, source, settings] : [model];
 const failed = reads.find(read => read.isError);
 const [notice, setNotice] = useState<Notice>();
 const reload = () => { void model.refetch(); void source.refetch(); void settings.refetch(); };
 return <section className="rv-ai-spend" aria-label={W.title} data-testid="ai-spend-step">
  <h2>{W.title}</h2><p>{W.intro}</p>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"} data-testid={notice.ok ? "ai-spend-saved" : "ai-spend-error"}><VisibleText text={notice.text} /></p>}
  {failed !== undefined ? <><p role="alert" data-testid="ai-spend-read-error">{failed.error instanceof ApiError && failed.error.status === 501 ? "AI and spending isn't available on this Rovara yet." : "Couldn't load AI and spending. Try again."}</p><Button onClick={() => { for (const read of reads) void read.refetch(); }}>Try again</Button></>
   : reads.some(read => read.isPending) ? <Skeleton label="Loading AI and spending" />
   : admin && model.data !== undefined && source.data !== undefined && settings.data !== undefined
    ? <Form key={`${String(settings.data.version)}:${String(source.data.version)}:${model.data.model ?? ""}`} developerId={developerId} model={model.data} source={source.data} settings={settings.data} setNotice={setNotice} reload={reload} onSaved={() => { reload(); onSaved?.(); }} />
    : model.data !== undefined && <ReadOnly model={model.data} />}
 </section>;
}

function ReadOnly({ model }: { model: EngineModelRead }) {
 return <div data-testid="ai-spend-read-only"><p>{W.model}: <b><VisibleText text={model.model ?? model.preselect} /></b>{model.source === "install" && " (this Rovara's default)"}</p><p>{W.readOnly}</p></div>;
}

type Choice = "rovara" | "own";
type Notice = { ok: boolean; text: string } | undefined;
function Form({ developerId, model, source, settings, setNotice, reload, onSaved }: { developerId: string; model: EngineModelRead; source: AgentAiRead; settings: CompanySettingsRead; setNotice: (notice: Notice) => void; reload: () => void; onSaved: () => void }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]), query = useQueryClient();
 const confirmed = useJustConfirmed(developerId);
 const [choice, setChoice] = useState<Choice>(source.source === null || source.source === "rovara" ? "rovara" : "own");
 const [own, setOwn] = useState<Exclude<AgentAiSource, "rovara">>(source.source === "bedrock_byo" ? "bedrock_byo" : "anthropic_key");
 const [picked, setPicked] = useState(model.preselect);
 const savedCap = typeof settings.monthlyCapUsd === "number" ? settings.monthlyCapUsd : undefined;
 const [cap, setCap] = useState(usdText(savedCap ?? COMPANY_MONTHLY_DEFAULT_USD));
 const [busy, setBusy] = useState(false), [stale, setStale] = useState(false);
 const chosenSource: AgentAiSource = choice === "rovara" ? "rovara" : own;
 const capUsd = dollarsOf(cap, MONTHLY_MAX_USD);
 const ready = confirmed && !stale;
 const sourceUsable = source.available[chosenSource];

 async function save() {
  if (capUsd === undefined || capUsd === 0) { setNotice({ ok: false, text: W.badLimit }); return; }
  setBusy(true); setNotice(undefined);
  let pending = false, wrote = false;
  try {
   const capMicros = Math.round(capUsd * MICROS);
   if (savedCap === undefined || Math.round(savedCap * MICROS) !== capMicros) {
    const saved = typeof settings.raw["budgets"] === "object" && settings.raw["budgets"] !== null ? settings.raw["budgets"] as Record<string, unknown> : {};
    // The learning cap is never above the company cap (Cloud refuses it): a lower company cap lowers it too.
    const learning = saved["learningMonthlyUsdMicros"];
    const budgets = { ...saved, companyMonthlyUsdMicros: capMicros, ...(typeof learning === "number" ? { learningMonthlyUsdMicros: Math.min(learning, capMicros) } : {}) };
    const answer = await api.sendAnswer("PUT", ORG_SETTINGS_PATH, { expectedVersion: settings.version, settings: { ...settings.raw, budgets } }, { parse: body => body }, { retry: "never" });
    wrote = true;
    pending = typeof answer === "object" && answer !== null && "pending" in answer && !("settings" in answer);
   }
   if (source.source !== chosenSource) await api.sendAnswer("PUT", AGENT_AI_PATH, { expectedVersion: source.version, source: chosenSource }, { parse: body => body }, { retry: "never" }).then(() => { wrote = true; });
   // Always, even when unchanged: the company's own model is saved explicitly.
   await api.sendAnswer("PUT", ENGINE_MODEL_PATH, { model: picked }, { parse: readEngineModel }, { retry: "never" });
   setNotice({ ok: true, text: pending ? W.pending : W.saved });
   await query.invalidateQueries({ queryKey: ["admin", "lane-c"] });
   onSaved();
  } catch (error) {
   if (needsStepUp(error)) { setStale(true); forgetConfirmed(host.storage, developerId); }
   else setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again." });
   // Part of it was saved: read everything again, so a retry names the new versions.
   if (wrote) reload();
  } finally { setBusy(false); }
 }

 return <>
  {!ready && <FreshSignIn action={W.action} refused={stale} />}
  <fieldset disabled={busy} aria-label="Who pays for the AI"><legend>Who pays for the AI</legend>
   <p><label data-testid="ai-spend-rovara"><input type="radio" name="ai-spend-source" value="rovara" checked={choice === "rovara"} disabled={!source.available.rovara} onChange={() => setChoice("rovara")} /> <b>{W.rovara}</b>: {W.rovaraText}</label></p>
   <p><label data-testid="ai-spend-own"><input type="radio" name="ai-spend-source" value="own" checked={choice === "own"} onChange={() => setChoice("own")} /> <b>{W.own}</b>: {W.ownText}</label></p>
   {choice === "own" && <div className="rv-ai-spend-own" data-testid="ai-spend-own-choices">
    <p><label><input type="radio" name="ai-spend-own" value="anthropic_key" checked={own === "anthropic_key"} disabled={!source.available.anthropic_key} onChange={() => setOwn("anthropic_key")} /> {W.anthropic}{source.anthropicKeyConnected === false && <> <span data-testid="ai-spend-no-key">(not connected yet)</span></>}</label></p>
    <p><label><input type="radio" name="ai-spend-own" value="bedrock_byo" checked={own === "bedrock_byo"} disabled={!source.available.bedrock_byo} onChange={() => setOwn("bedrock_byo")} /> {W.bedrock}{!source.available.bedrock_byo && " (coming soon)"}</label></p>
    {own === "anthropic_key" && source.anthropicKeyConnected !== true && <p><Link className="rv-admin-b1-link" to="/app/admin/learning-ai" data-testid="ai-spend-connect">{W.connectAnthropic}</Link>, then come back here.</p>}
   </div>}
  </fieldset>
  <Select label={W.model} value={picked} onValueChange={setPicked} options={model.offered.map(id => ({ value: id, label: id }))} disabled={busy} />
  <p className="rv-muted">{W.modelHint}</p>
  <TextField label={W.limit} hint={W.limitHint} inputMode="decimal" value={cap} onChange={event => setCap(event.target.value)} disabled={busy} {...(capUsd === undefined || capUsd === 0 ? { error: W.badLimit } : {})} />
  {ready && <p><Button variant="primary" busy={busy} disabled={capUsd === undefined || capUsd === 0 || !sourceUsable} onClick={() => { void save(); }}>Save</Button></p>}
 </>;
}
