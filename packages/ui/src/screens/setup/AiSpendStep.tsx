// Guided onboarding PR 15 (DEC 254l item 7, DEC 254n item 1): the company step "AI and spending", chosen before the first setup run. Three things and
// one Save: who pays for the AI (Rovara's AI, or the company's own provider, connected on its existing page), the model from the company's own
// offered list (the default stays selected until the person chooses a model), and one company monthly limit (the saved one, else the existing default prefilled).
//
// Save writes, in this order: the monthly limit (Cloud's company settings route, only when it changed), the AI source (Cloud's agent AI route,
// only when it changed), then an explicitly changed model. A preselection never saves itself.
// A spending-only save never replaces an existing company model, including one no longer offered. The server checks each write.
// A plain member sees the step read only. Every refusal shown is the server's own fixed sentence.
//
// PR 9 (the setup shell) places this step; Company settings shows the same component (screens/admin/ai-spending).
import { useEffect, useRef, useState } from "react";
import { Link, useLocation } from "react-router";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { COMPANY_MONTHLY_DEFAULT_USD, ENGINE_MODEL_PATH, dollarsOf, readEngineModel, type EngineModelRead } from "../../api/ai-spend.js";
import { AGENT_MODELS_PATH, readAgentModels, type AgentModelsRead } from "../../api/agent-models.js";
import { AGENT_AI_PATH, readAgentAi, type AgentAiRead, type AgentAiSource } from "../../api/admin-agent-ai.js";
import { ORG_SETTINGS_PATH, readCompanySettings, type CompanySettingsRead } from "../../api/admin-company.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { TextField } from "../../design/TextField.js";
import { VisibleText } from "../../design/VisibleText.js";
import { StepModelsCard } from "./StepModelsCard.js";
import { sourceLabel } from "../admin/models/source-order.js";
import { ProjectScopeContext } from "../admin/admin-context.js";
import { BACK_TO_DEFAULT, DEFAULT_MODEL, defaultModelText, modelScopeId, useModelScope } from "./model-scope.js";
import { CompanyAiConnections } from "../admin/ai-spending/CompanyAiConnections.js";
import "./ai-spend.css";

export type CompanyRole = "owner" | "admin" | "member";
const MICROS = 1_000_000;
/** The company budgets allow up to $1,000,000 a month. */
const MONTHLY_MAX_USD = 1_000_000;
export const AI_SPEND_STEP_WORDS = Object.freeze({
 title: "AI and spending",
 intro: "Choose who pays for the AI, the model Rovara uses, and the most the company spends on AI in a month. Setup runs use AI, so this comes first.",
 rovara: "Rovara's AI",
 defaultNote: "Rovara's AI, billed to your company",
 rovaraText: "Nothing to connect. Charged per use on the company's bill, inside the monthly limit.",
 own: "Your own provider",
 ownText: "Your company's own AI account pays the provider directly. Rovara still counts it under the monthly limit.",
 anthropic: "Your own Anthropic key",
 bedrock: "Your own Bedrock",
 connectAnthropic: "Connect your Anthropic key",
 manageSource: "Manage this AI connection",
 model: "Company model",
 modelHint: "From the models your company can use now.",
 limit: "Company monthly limit (USD)",
 limitHint: "Prefilled. AI work stops for the month when the company reaches it.",
 badLimit: "The monthly limit must be an amount in dollars above 0, like 500 or 1500.50, up to 1,000,000.",
 readOnly: "Only a company owner or admin can change this. Ask one of them.",
 saved: "Saved.",
 pending: "The server reports that the monthly limit is waiting for another admin to approve it.",
});
const W = AI_SPEND_STEP_WORDS;
const usdText = (usd: number) => (Number.isInteger(usd) ? String(usd) : usd.toFixed(2));

export function AiSpendStep({ role, developerId, orgId = "", company = "", onSaved, onContinue }: { role: CompanyRole; developerId: string; orgId?: string; company?: string; onSaved?: () => void; onContinue?: () => void }) {
 return <AiSpendScope key={modelScopeId(orgId, developerId, role)} {...{ role, developerId, orgId, company, onSaved, onContinue }} />;
}
function AiSpendScope({ role, developerId, orgId, company, onSaved, onContinue }: { role: CompanyRole; developerId: string; orgId: string; company: string; onSaved?: (() => void) | undefined; onContinue?: (() => void) | undefined }) {
 const { api, key: scope, active } = useModelScope("ai-spend", orgId, developerId, role);
 const root = useRef<HTMLElement>(null), location = useLocation();
 const admin = role === "owner" || role === "admin";
 const model = useQuery({ queryKey: [...scope, "engine-model"], queryFn: () => api.get(ENGINE_MODEL_PATH, { parse: readEngineModel }), gcTime: 0, refetchOnWindowFocus: false });
 const source = useQuery({ queryKey: [...scope, "agent-ai"], queryFn: () => api.get(AGENT_AI_PATH, { parse: readAgentAi }), enabled: admin, gcTime: 0, refetchOnWindowFocus: false });
 const settings = useQuery({ queryKey: [...scope, "settings"], queryFn: () => api.get(ORG_SETTINGS_PATH, { parse: readCompanySettings }), enabled: admin, gcTime: 0, refetchOnWindowFocus: false });
 const tasks = useQuery({ queryKey: ["step-models", orgId, developerId, role], queryFn: () => api.get(AGENT_MODELS_PATH, { parse: readAgentModels }), gcTime: 0, refetchOnWindowFocus: false });
 const [notice, setNotice] = useState<Notice>();
 const reload = async () => {
  const [nextModel, nextSource, nextSettings, nextTasks] = await Promise.all([model.refetch(), source.refetch(), settings.refetch(), tasks.refetch()]);
  if (!active() || !nextModel.isSuccess || !nextSource.isSuccess || !nextSettings.isSuccess) return undefined;
  return { model: nextModel.data, source: nextSource.data, settings: nextSettings.data, ready: persistedReady(nextModel.data, nextSource.data, nextSettings.data, nextTasks.isSuccess ? nextTasks.data : undefined) };
 };
 const complete = admin && model.isSuccess && source.isSuccess && settings.isSuccess && model.failureCount === 0 && source.failureCount === 0 && settings.failureCount === 0;
 const visibleNotice = notice?.ok ? complete && notice.reads?.model === model.data && notice.reads.source === source.data && notice.reads.settings === settings.data : notice !== undefined;
 const ready = complete && !model.isFetching && !source.isFetching && !settings.isFetching && !tasks.isFetching && tasks.isSuccess && persistedReady(model.data, source.data, settings.data, tasks.data);
 useEffect(() => {
  if (!location.hash || model.isPending || (admin && (source.isPending || settings.isPending))) return;
  const focus = () => {
   const target = root.current?.querySelector<HTMLElement>(`[id="${location.hash.slice(1).replace(/[^a-z-]/gu, "")}"]`);
   if (!target) return false;
   target.tabIndex = -1; target.focus(); target.scrollIntoView?.({ block: "start" }); return true;
  };
  // Wait for the actual replacement row rather than an initial loading placeholder.
  const timer = setTimeout(() => { if (focus()) observer.disconnect(); }, 0);
  const observer = new MutationObserver(() => { if (focus()) observer.disconnect(); });
  if (root.current) observer.observe(root.current, { childList: true, subtree: true });
  return () => { clearTimeout(timer); observer.disconnect(); };
 }, [location.hash, admin, model.isPending, source.isPending, settings.isPending, complete]);
 return <ProjectScopeContext.Provider value={{ orgId, company, developerId, role, checking: false }}><section ref={root} className="rv-ai-spend rv-ai-spend-step" aria-label={W.title} data-testid="ai-spend-step">
  <p>{W.intro}</p>
  {visibleNotice && notice !== undefined && <p role={notice.ok ? "status" : "alert"} data-testid={notice.ok ? "ai-spend-saved" : "ai-spend-error"}><VisibleText text={notice.text} /></p>}
  {notice?.check && <Button disabled={model.isFetching || source.isFetching || settings.isFetching} onClick={() => {
   void reload().then(next => { if (active() && next) setNotice({ ok: true, text: observedSettings(next), reads: next }); });
  }}>Check</Button>}
  {complete
   ? <Form orgId={orgId} developerId={developerId} role={role} model={model.data} source={source.data} settings={settings.data} setNotice={setNotice} onSaved={async confirmed => {
    const persisted = await reload();
    if (active() && !persisted) setNotice({ ok: false, check: true, text: "Rovara didn't confirm this yet. Couldn't re-read AI and spending. Check the current settings before saving again." });
    if (active() && confirmed && persisted?.ready) onSaved?.();
    return persisted;
   }} ready={ready} onContinue={onContinue} />
   : <>
    {!admin && <section id="ai-connections"><h2>AI connections</h2><p>{W.readOnly}</p></section>}
    {admin && <CompanyAiConnections><section aria-label="Task AI source">{source.isPending ? <Skeleton label="Loading task AI source" /> : source.isError ? <ReadFailure read={source} row="source" retry={!notice?.check} /> : <p>Task source: {sourceLabel((source.data.source ?? source.data.effectiveSource) ?? "unknown")}.</p>}</section></CompanyAiConnections>}
    <StepModelsCard orgId={orgId} developerId={developerId} role={role} companyModel={model.isPending ? <Skeleton label="Loading company model" /> : model.isError ? <ReadFailure read={model} row="model" retry={!notice?.check} /> : <ReadOnly model={model.data} blocked={admin} />} />
    {admin && <section aria-label="Company spending">{settings.isPending ? <Skeleton label="Loading company spending" /> : settings.isError ? <ReadFailure read={settings} row="settings" retry={!notice?.check} /> : <p>{W.limit}: {settings.data.monthlyCapUsd ?? "Not saved"}</p>}</section>}
   </>}
  {onContinue && !complete && <Button data-testid="onboard-continue-repos" disabled>Continue to pick repos</Button>}
 </section></ProjectScopeContext.Provider>;
}

// Only persisted required inputs count. Optional learning/second review reads never gate setup.
function persistedReady(model: EngineModelRead, source: AgentAiRead, settings: CompanySettingsRead, tasks: AgentModelsRead | undefined) {
 const serving = source.source ?? source.effectiveSource;
 const required = ["understand", "plan", "plan_check", "build", "code_review", "security_review", "pull_request"];
 const taskReady = tasks !== undefined && required.every(stage => tasks.steps.some(step => step.stage === stage && !step.refused && step.effective !== null));
 return taskReady && settings.modelGateway?.ready === true && model.model !== null && model.offered.includes(model.model) && serving !== null && source.available[serving] && typeof settings.monthlyCapUsd === "number" && settings.monthlyCapUsd > 0;
}
function ReadFailure({ read, row, retry = true }: { retry?: boolean; read: { error: unknown; refetch: () => unknown }; row: "model" | "source" | "settings" }) {
 const notYet = read.error instanceof ApiError && read.error.status === 501;
 const label = row === "model" ? "AI and spending" : row === "source" ? "Task AI source" : "Company spending";
 return <><p role="alert" data-testid={row === "model" ? "ai-spend-read-error" : `ai-spend-${row}-read-error`}>{notYet ? `${label} isn't available on this Rovara yet.` : `Couldn't load ${label === "AI and spending" ? "AI and spending" : label.toLowerCase()}. Try again.`}</p>{!notYet && retry && <Button onClick={() => { void read.refetch(); }}>Try again</Button>}</>;
}

function ReadOnly({ model, blocked }: { model: EngineModelRead; blocked: boolean }) {
 return <div data-testid="ai-spend-read-only"><p>{W.model}: <VisibleText text={model.source === "install" ? defaultModelText(model.model) : `Your choice: ${model.model ?? "unavailable"}`} /></p><p>{blocked ? "Changes are unavailable until the source and spending settings can be checked." : W.readOnly}</p></div>;
}

type Loaded = { model: EngineModelRead; source: AgentAiRead; settings: CompanySettingsRead };
function observedSettings(read: Loaded): string {
 const serving = read.source.source ?? read.source.effectiveSource;
 const cap = read.settings.monthlyCapUsd;
 return `Current AI source: ${serving === null ? "could not be checked" : sourceLabel(serving)}. Company monthly limit: ${typeof cap === "number" ? `$${usdText(cap)}` : "not saved"}. Company model: ${read.model.model ?? "unavailable"}.`;
}
type Choice = "rovara" | "own";
type Notice = { ok: boolean; text: string; reads?: Loaded; check?: boolean } | undefined;
function Form({ model, source, settings, setNotice, onSaved, developerId, role, orgId, ready, onContinue }: { ready: boolean; onContinue: (() => void) | undefined; orgId: string; developerId: string; role: CompanyRole; model: EngineModelRead; source: AgentAiRead; settings: CompanySettingsRead; setNotice: (notice: Notice) => void; onSaved: (confirmed: boolean) => Promise<(Loaded & { ready: boolean }) | undefined> }) {
 const { api, active } = useModelScope("ai-spend", orgId, developerId, role, "company-draft"), query = useQueryClient();
 // DEC 254zzz263: what the company's agents use now (a saved choice, else the default it is on), never a guess.
 const shown = source.source ?? source.effectiveSource;
 const [loaded, setLoaded] = useState({ model, source, settings });
 const savedSource = source.source;
 const servedChoice = source.source ?? source.effectiveSource ?? "rovara";
 const initialPick = (value: EngineModelRead) => value.source === "company" && value.model !== null ? value.model : DEFAULT_MODEL;
 const [modelInteracted, setModelInteracted] = useState(false);
 const [choice, setChoice] = useState<Choice>(shown === null || shown === "rovara" ? "rovara" : "own");
 const [own, setOwn] = useState<AgentAiSource>(shown !== null && shown !== "rovara" ? shown : "anthropic_key");
 const [sourceInteracted, setSourceInteracted] = useState(false);
 const [picked, setPicked] = useState(initialPick(model));
 const savedCap = typeof loaded.settings.monthlyCapUsd === "number" ? loaded.settings.monthlyCapUsd : undefined;
 const [cap, setCap] = useState(usdText(savedCap ?? COMPANY_MONTHLY_DEFAULT_USD));
 const [busy, setBusy] = useState(false);
 // Keep the loaded model and limit baselines for this scope. Only an explicit save starts a new draft.
 const modelChanged = modelInteracted && picked !== initialPick(loaded.model);
 const saveModel = modelChanged;
 const chosenSource: AgentAiSource = choice === "rovara" ? "rovara" : own;
 // Compatibility with an older server: without a served effective source the shown option is only a suggestion.
 const unsavedSuggestion = savedSource === null && (source.effectiveSource ?? null) === null && source.available[chosenSource] === true;
 // Connections can refresh the served source without resetting model, limit or explicit source drafts.
 // Compare an explicit source choice with that current read, rather than the first render's payer.
 const sourceChanged = unsavedSuggestion || (sourceInteracted && savedSource !== chosenSource && !(savedSource === null && servedChoice === chosenSource));
 const capUsd = dollarsOf(cap, MONTHLY_MAX_USD);
 const displayChoice = sourceInteracted ? choice : shown === null || shown === "rovara" ? "rovara" : "own";
 const displayOwn = sourceInteracted ? own : shown !== null && shown !== "rovara" ? shown : "anthropic_key";
 const sourceUsable = !sourceChanged || source.available[chosenSource];

 async function save(resetModel = false) {
  if (!active()) return;
  if (!resetModel && (capUsd === undefined || capUsd === 0)) { setNotice({ ok: false, text: W.badLimit }); return; }
  setBusy(true); setNotice(undefined);
  let pending = false, wrote = false;
  try {
   const capMicros = Math.round((capUsd ?? 0) * MICROS);
   if (!resetModel && (savedCap === undefined || Math.round(savedCap * MICROS) !== capMicros)) {
    const saved = typeof loaded.settings.raw["budgets"] === "object" && loaded.settings.raw["budgets"] !== null ? loaded.settings.raw["budgets"] as Record<string, unknown> : {};
    // The learning cap is never above the company cap (Cloud refuses it): a lower company cap lowers it too.
    const learning = saved["learningMonthlyUsdMicros"];
    const budgets = { ...saved, companyMonthlyUsdMicros: capMicros, ...(typeof learning === "number" ? { learningMonthlyUsdMicros: Math.min(learning, capMicros) } : {}) };
    const answer = await api.sendAnswer("PUT", ORG_SETTINGS_PATH, { expectedVersion: loaded.settings.version, settings: { ...loaded.settings.raw, budgets } }, { parse: body => body }, { retry: "never" });
    wrote = true;
    pending = typeof answer === "object" && answer !== null && "pending" in answer && !("settings" in answer);
   }
   if (!resetModel && sourceChanged && savedSource !== chosenSource) await api.sendAnswer("PUT", AGENT_AI_PATH, { expectedVersion: source.version, source: chosenSource }, { parse: body => body }, { retry: "never" }).then(() => { wrote = true; });
   // Default and offered preselects are readouts until the person makes a choice.
   if (resetModel || saveModel) { await api.sendAnswer("PUT", ENGINE_MODEL_PATH, { model: resetModel || picked === DEFAULT_MODEL ? null : picked }, { parse: readEngineModel }, { retry: "never" }); wrote = true; }
   if (!active()) return;
   await query.invalidateQueries({ queryKey: ["admin", "lane-c"] });
   await query.invalidateQueries({ queryKey: ["step-models", orgId, developerId, role] });
   if (!active()) return;
   const next = await onSaved(!resetModel && !pending);
   if (active() && next) {
    setNotice({ ok: true, text: `${pending ? `${W.pending} ` : ""}${observedSettings(next)}`, reads: next });
    setLoaded(next); setPicked(initialPick(next.model)); setModelInteracted(false);
    const nextSource = next.source.source ?? next.source.effectiveSource;
    if (!resetModel) {
     setChoice(nextSource === null || nextSource === "rovara" ? "rovara" : "own");
     setOwn(nextSource !== null && nextSource !== "rovara" ? nextSource : "anthropic_key"); setSourceInteracted(false);
     if (!pending) setCap(usdText(next.settings.monthlyCapUsd ?? COMPANY_MONTHLY_DEFAULT_USD));
    }
   }
  } catch (error) {
   if (!active()) return;
   setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again." });
   // Part of it was saved: read everything again, so a retry names the new versions.
   if (wrote) { const next = await onSaved(false); if (active() && next) setLoaded(next); }
  } finally { if (active()) setBusy(false); }
 }

 return <>
  <CompanyAiConnections>
  {source.sourceIsDefault && source.effectiveSource === "rovara" && <p data-testid="ai-spend-default">{W.defaultNote}. <Link to="/app/admin/ai-spending#ai-connections">Change</Link></p>}
  <fieldset disabled={busy} aria-label="Who pays for the AI"><legend>Who pays for the AI</legend>
   <p><label data-testid="ai-spend-rovara"><input type="radio" name="ai-spend-source" value="rovara" checked={displayChoice === "rovara"} disabled={!source.available.rovara} onChange={() => { setSourceInteracted(true); setChoice("rovara"); }} /> <b>{W.rovara}</b>: {W.rovaraText}</label></p>
   <p><label data-testid="ai-spend-own"><input type="radio" name="ai-spend-source" value="own" checked={displayChoice === "own"} onChange={() => { setSourceInteracted(true); setChoice("own"); }} /> <b>{W.own}</b>: {W.ownText}</label></p>
   {displayChoice === "own" && <div className="rv-ai-spend-own" data-testid="ai-spend-own-choices">
    {displayOwn !== "anthropic_key" && displayOwn !== "bedrock_byo" ? <p data-testid="ai-spend-source-read-only">Saved source: <b>{sourceLabel(displayOwn)}</b>. <Link className="rv-admin-b1-link" to="#ai-connections">{W.manageSource}</Link></p> : <>
     <p><label><input type="radio" name="ai-spend-own" value="anthropic_key" checked={displayOwn === "anthropic_key"} disabled={!source.available.anthropic_key} onChange={() => { setSourceInteracted(true); setChoice("own"); setOwn("anthropic_key"); }} /> {W.anthropic}{source.anthropicKeyConnected === false && <> <span data-testid="ai-spend-no-key">(not connected yet)</span></>}</label></p>
     <p><label><input type="radio" name="ai-spend-own" value="bedrock_byo" checked={displayOwn === "bedrock_byo"} disabled={!source.available.bedrock_byo} onChange={() => { setSourceInteracted(true); setChoice("own"); setOwn("bedrock_byo"); }} /> {W.bedrock}{!source.available.bedrock_byo && " (coming soon)"}</label></p>
     {displayOwn === "anthropic_key" && source.anthropicKeyConnected !== true && <p><Link className="rv-admin-b1-link" to="#ai-connections" data-testid="ai-spend-connect">{W.connectAnthropic}</Link>, then come back here.</p>}
    </>}
   </div>}
  </fieldset>
  </CompanyAiConnections>
  <StepModelsCard orgId={orgId} developerId={developerId} role={role} companyModel={<>
  <p><VisibleText text={model.source === "install" ? defaultModelText(model.model) : `Your choice: ${model.model ?? "unavailable"}`} /></p>
  {model.model !== null && !model.offered.includes(model.model) && <p role="status">{model.model} is no longer offered for this work. Choose another model.</p>}
  <p>Task source: {(source.source ?? source.effectiveSource) === null ? "The current source could not be checked." : sourceLabel((source.source ?? source.effectiveSource)!)}. Model access is checked when used. Price unavailable.</p>
  <Select label={W.model} value={picked} onValueChange={value => { setModelInteracted(true); setPicked(value); }} options={[{ value: DEFAULT_MODEL, label: defaultModelText(model.source === "install" ? model.model : null) }, ...model.offered.map(id => ({ value: id, label: id })), ...(model.model !== null && !model.offered.includes(model.model) ? [{ value: model.model, label: `${model.model} (no longer offered)`, disabled: true }] : [])]} disabled={busy || !model.canChange} />
  {picked !== DEFAULT_MODEL && !model.offered.includes(picked) && picked !== model.model && <p role="status">Your unsaved model is no longer offered. Choose another option before saving it.</p>}
  <p className="rv-muted">{W.modelHint}</p>
  <p>Save below changes this model only after you choose an option.</p>
  {model.source === "company" && model.canChange && <Button disabled={busy} onClick={() => { void save(true); }}>{BACK_TO_DEFAULT}</Button>}
  </>} />
  <section className="rv-ai-spend-limit" aria-label="Monthly limit"><h2>Monthly limit</h2>
  <TextField label={W.limit} hint={W.limitHint} inputMode="decimal" value={cap} onChange={event => setCap(event.target.value)} disabled={busy} {...(capUsd === undefined || capUsd === 0 ? { error: W.badLimit } : {})} />
  </section>
  <div className="rv-ai-spend-actions">
  <Button variant="primary" busy={busy} disabled={capUsd === undefined || capUsd === 0 || !sourceUsable || (saveModel && (!model.canChange || (picked !== DEFAULT_MODEL && !model.offered.includes(picked))))} onClick={() => { void save(); }}>Save</Button>
  {onContinue && <Button data-testid="onboard-continue-repos" disabled={busy || !ready || sourceChanged || modelChanged || capUsd !== savedCap} onClick={onContinue}>Continue to pick repos</Button>}
  </div>
 </>;
}
