// DEC 254zzz84 (1): the "AI models" card, under the company's model in setup's "AI and spending" step and in Company settings (the same component).
// Owners and admins pick a model for each part of a task (plan, coding, the reviews, ...) from the models the company is offered now, or leave a step on the
// company's model. Members see it read only. Each change is saved at once, against the revision the card read (Code refuses a stale one). No step-up (DEC 254zzz73).
// Every refusal shown is the server's own fixed sentence.
import { Fragment, useState, type ReactNode } from "react";
import { useQuery } from "@tanstack/react-query";
import { AGENT_MODELS_PATH, STEP_GROUPS, priceText, readAgentModels, type AgentModelsRead } from "../../api/agent-models.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Select } from "../../design/Select.js";
import { Skeleton } from "../../design/Skeleton.js";
import { LearningModelCard } from "../admin/ai-spending/LearningModelCard.js";
import { BACK_TO_DEFAULT, defaultModelText, modelScopeId, useModelScope } from "./model-scope.js";
import { VisibleText } from "../../design/VisibleText.js";

export const STEP_MODELS_WORDS = Object.freeze({
 title: "AI models for each step",
 intro: "Each part of a task can use its own model. A step following Rovara's default uses the company model.",
 same: "Rovara's default",
 readOnly: "Only a company owner or admin can change these. Ask one of them.",
 notYet: "Choosing a model for each step isn't available on this Rovara yet.",
 readError: "Couldn't load the step models. Try again.",
 saved: "Saved.",
 noPrice: "Price unavailable.",
 refused: "No offered model can run this step now. Pick another model for it.",
});
const W = STEP_MODELS_WORDS;
// Not a model name (the gateway names never hold "@"), so it can never stand for one.
const SAME = "@company";

export function StepModelsCard({ developerId, role, companyModel, orgId = "" }: { developerId: string; role: "owner" | "admin" | "member"; companyModel?: ReactNode; orgId?: string }) {
 return <ScopedStepModels key={modelScopeId(orgId, developerId, role)} {...{ developerId, role, companyModel, orgId }} />;
}
function ScopedStepModels({ developerId, role, companyModel, orgId }: { developerId: string; role: "owner" | "admin" | "member"; companyModel: ReactNode; orgId: string }) {
 const scope = useModelScope("step-models", orgId, developerId, role), { api } = scope;
 const read = useQuery({ queryKey: scope.key, queryFn: () => api.get(AGENT_MODELS_PATH, { parse: readAgentModels }), gcTime: 0, refetchOnWindowFocus: false });
 const notYet = read.error instanceof ApiError && read.error.status === 501;
 return <section id="ai-models" className="rv-step-models" aria-label={W.title} data-testid="step-models">
  <h2>{W.title}</h2><p>{W.intro}</p>
  <section id="company-model" aria-label="Company model setting"><h3>Company model</h3>{companyModel}</section>
  {read.isPending ? <Skeleton label="Loading the step models" />
   : read.isError ? <><p role="alert" data-testid="step-models-read-error">{notYet ? W.notYet : W.readError}</p>{!notYet && <Button onClick={() => { void read.refetch(); }}>Try again</Button>}</>
   : <Steps scope={scope} data={{ ...read.data, canChange: role !== "member" && read.data.canChange }} reload={() => { void read.refetch(); }} />}
  {!read.isSuccess && <><DesignReviewRow /><SecondReviewRow /></>}
  <LearningModelCard orgId={orgId} developerId={developerId} role={role} />
  <section id="answers-model" aria-label="Answers and Slack chat" data-testid="answers-model-row"><h3>Answers and Slack chat</h3><p>Managed by this Rovara. Read only. Used for answers, start routing and Slack chat/message routing. The install's answers model is independent of the company task model.</p><p>{defaultModelText(null)}. The current model, source and readiness could not be checked here and remain unavailable. Task source order does not select their source.</p><p>Price unavailable. Answers have their own monthly sublimit inside the company monthly limit.</p></section>
 </section>;
}

function DesignReviewRow() { return <section id="design-review-model" aria-label="Design review model"><h3>Design review</h3><p>{defaultModelText(null)}. Automatic. Chosen when the design is reviewed, when enabled for the project. Reviewer, source and price are unavailable here.</p></section>; }
function SecondReviewRow() { return <section id="second-review" aria-label="Second review" data-testid="second-review-model-row"><h3>Second review</h3><p>{defaultModelText(null)}. Automatic. Current reviewer, source and readiness are unavailable. Not available yet.</p><details><summary>Second review availability</summary><p>Settings and mode could not be checked on this release. Current enablement is unavailable.</p><p>Second review through OpenRouter is not available yet. Own Bedrock currently supports Claude only; different-vendor second review is unavailable.</p><p>Direct Anthropic or OpenAI review needs another eligible model through that source. Rovara's AI and aggregators need another vendor. The reviewer depends on the task's coding and first-review models.</p><p>Mode, context sharing and trial evidence will appear here when supported. Review estimate unavailable. Review costs count inside the Task limit and company monthly limit.</p></details></section>; }

function Steps({ data, reload, scope }: { data: AgentModelsRead; reload: () => void; scope: ReturnType<typeof useModelScope> }) {
 const { api, active } = scope;
 const [busy, setBusy] = useState(false);
 const [notice, setNotice] = useState<{ ok: boolean; text: string }>();
 async function change(stage: string, value: string) {
  if (!active() || busy || !data.canChange || value === (data.steps.find(step => step.stage === stage)?.setting ?? SAME)) return;
  setBusy(true); setNotice(undefined);
  try {
   const body = value === SAME ? { action: "clear", stage, expectedRevision: data.revision } : { action: "set", stage, model: value, expectedRevision: data.revision };
   await api.sendAnswer("POST", AGENT_MODELS_PATH, body, { parse: (answer: unknown) => answer }, { retry: "never" });
   if (!active()) return;
   setNotice({ ok: true, text: W.saved });
  } catch (error) {
   if (!active()) return;
   setNotice({ ok: false, text: error instanceof ApiError ? error.message : "Couldn't save that. Try again." });
  } finally { if (active()) { setBusy(false); reload(); } }
 }
 return <>
  {notice !== undefined && <p role={notice.ok ? "status" : "alert"} data-testid={notice.ok ? "step-models-saved" : "step-models-error"}><VisibleText text={notice.text} /></p>}
  {!data.canChange && <p data-testid="step-models-read-only">{W.readOnly}</p>}
  <ul className="rv-step-models-list">{STEP_GROUPS.map(group => {
   const step = data.steps.find(s => s.stage === group.stage);
   const automatic = group.stage === "build" ? <li><DesignReviewRow /></li> : group.stage === "code_review" ? <li><SecondReviewRow /></li> : null;
   if (step === undefined) return <Fragment key={group.stage}><li data-testid={`step-model-${group.stage}`}><p>{group.label}: Not available on this Rovara yet.</p><p>{defaultModelText(null)}</p></li>{automatic}</Fragment>;
   const companions = group.stage === "plan" ? ["understand", "plan"] : group.stage === "code_review" ? ["code_review", "security_review"] : [group.stage];
   const results = companions.map(stage => data.steps.find(s => s.stage === stage)).filter(s => s !== undefined);
   const runs = step.effective;
   const price = priceText(runs?.priceUsdPerMillion);
   const current = step.setting === null ? defaultModelText(step.refused ? null : runs?.model ?? null) : `Your choice: ${step.setting}`;
   const stale = step.setting !== null && !data.offered.includes(step.setting) ? [{ value: step.setting, label: `${step.setting} (no longer offered)`, disabled: true }] : [];
   return <Fragment key={group.stage}><li data-testid={`step-model-${group.stage}`}>
    {data.canChange
     ? <Select label={group.label} value={step.setting ?? SAME} disabled={busy} onValueChange={value => { void change(group.stage, value); }}
        options={[{ value: SAME, label: defaultModelText(step.setting === null && !step.refused ? runs?.model ?? null : null) }, ...data.offered.map(id => ({ value: id, label: id })), ...stale]} />
     : <p><b>{group.label}</b></p>}
    <p><VisibleText text={current} /></p>
    {data.canChange && step.setting !== null && <Button disabled={busy} onClick={() => { void change(group.stage, SAME); }}>{BACK_TO_DEFAULT}</Button>}
    <p className="rv-muted">{step.refused || runs === null ? <span role="alert">{W.refused}</span>
     : <>Runs on <VisibleText text={runs.model} />{runs.companyDefault ? " (company model)" : ""}. <span data-testid={`step-model-price-${group.stage}`}>{price ?? W.noPrice}</span></>}</p>
    {results.filter(result => result.stage !== group.stage && (result.refused || result.effective?.model !== runs?.model)).map(result => <p key={result.stage}>{result.stage === "understand" ? "Understand" : "Security review"}: {result.refused || result.effective === null ? <span role="alert">{W.refused}</span> : <><VisibleText text={result.effective.model} />. {priceText(result.effective.priceUsdPerMillion) ?? W.noPrice}</>}</p>)}
    <p className="rv-muted">Serving source is checked when the task runs. Changes apply at the next model selection, not during a call.</p>
   </li>{automatic}</Fragment>;
  })}</ul>
 </>;
}
