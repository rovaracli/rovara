// DEC 254zzz84 (1): the "AI models" card, under the company's model in setup's "AI and spending" step and in Company settings (the same component).
// Owners and admins pick a model for each part of a task (plan, coding, the reviews, ...) from the models the company is offered now, or leave a step on the
// company's model. Members see it read only. Each change is saved at once, against the revision the card read (Code refuses a stale one). No step-up (DEC 254zzz73).
// Every refusal shown is the server's own fixed sentence.
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { AGENT_MODELS_PATH, STEP_GROUPS, priceText, readAgentModels, type AgentModelsRead } from "../../api/agent-models.js";
import { createApiClient } from "../../api/client.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";

export const STEP_MODELS_WORDS = Object.freeze({
 title: "AI models for each step",
 intro: "Each part of a task can use its own model. A step left on \"Company model\" uses the company's model.",
 same: "Company model",
 readOnly: "Only a company owner or admin can change these. Ask one of them.",
 notYet: "Choosing a model for each step isn't available on this Rovara yet.",
 readError: "Couldn't load the step models. Try again.",
 saved: "Saved.",
 noPrice: "Price not shown.",
 refused: "No offered model can run this step now. Pick another model for it.",
});
const W = STEP_MODELS_WORDS;
// Not a model name (the gateway names never hold "@"), so it can never stand for one.
const SAME = "@company";

export function StepModelsCard({ developerId, role }: { developerId: string; role: "owner" | "admin" | "member" }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const read = useQuery({ queryKey: ["step-models", developerId, role], queryFn: () => api.get(AGENT_MODELS_PATH, { parse: readAgentModels }), gcTime: 0, refetchOnWindowFocus: false });
 const notYet = read.error instanceof ApiError && read.error.status === 501;
 return <section className="rv-step-models" aria-label={W.title} data-testid="step-models">
  <h3>{W.title}</h3><p>{W.intro}</p>
  {read.isPending ? <Skeleton label="Loading the step models" />
   : read.isError ? <><p role="alert" data-testid="step-models-read-error">{notYet ? W.notYet : W.readError}</p>{!notYet && <Button onClick={() => { void read.refetch(); }}>Try again</Button>}</>
   : <Steps data={read.data} reload={() => { void read.refetch(); }} />}
 </section>;
}

function Steps({ data, reload }: { data: AgentModelsRead; reload: () => void }) {
 const host = useAppHost(), api = useMemo(() => createApiClient(host), [host]);
 const [busy, setBusy] = useState(false);
 const [notice, setNotice] = useState<{ ok: boolean; text: string }>();
 async function change(stage: string, value: string) {
  setBusy(true); setNotice(undefined);
  try {
   const body = value === SAME ? { action: "clear", stage, expectedRevision: data.revision } : { action: "set", stage, model: value, expectedRevision: data.revision };
   await api.sendAnswer("POST", AGENT_MODELS_PATH, body, { parse: (answer: unknown) => answer }, { retry: "never" });
   setNotice({ ok: true, text: W.saved });
  } catch (error) {
   setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again." });
  } finally { setBusy(false); reload(); }
 }
 return <>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"} data-testid={notice.ok ? "step-models-saved" : "step-models-error"}><VisibleText text={notice.text} /></p>}
  {!data.canChange && <p data-testid="step-models-read-only">{W.readOnly}</p>}
  {/* A price shows only where Code knows it; where no step has one, no price line is drawn at all. */}
  <ul className="rv-step-models-list">{STEP_GROUPS.map(group => {
   const step = data.steps.find(s => s.stage === group.stage);
   if (step === undefined) return null;
   const runs = step.effective;
   const price = priceText(runs?.priceUsdPerMillion);
   const pricesKnown = data.steps.some(s => s.effective?.priceUsdPerMillion !== undefined);
   const stale = step.setting !== null && !data.offered.includes(step.setting) ? [{ value: step.setting, label: `${step.setting} (no longer offered)`, disabled: true }] : [];
   return <li key={group.stage} data-testid={`step-model-${group.stage}`}>
    {data.canChange
     ? <Select label={group.label} value={step.setting ?? SAME} disabled={busy} onValueChange={value => { void change(group.stage, value); }}
        options={[{ value: SAME, label: W.same }, ...data.offered.map(id => ({ value: id, label: id })), ...stale]} />
     : <p><b>{group.label}</b>: <VisibleText text={step.setting ?? W.same} /></p>}
    <p className="rv-muted">{step.refused || runs === null ? <span role="alert">{W.refused}</span>
     : <>Runs on <VisibleText text={runs.model} />{runs.companyDefault ? " (company model)" : ""}.{pricesKnown && <> <span data-testid={`step-model-price-${group.stage}`}>{price ?? W.noPrice}</span></>}</>}</p>
   </li>;
  })}</ul>
 </>;
}
