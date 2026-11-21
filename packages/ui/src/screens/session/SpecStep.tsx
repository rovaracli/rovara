import { useState } from "react";
import type { ReadComment, ReadPlan } from "../../api/work.js";
import { VisibleText } from "../../design/VisibleText.js";
import { CriterionRow } from "./CriterionRow.js";

/**
 * The spec: requirements with their criteria (each with its own id, so proof and comments can point at it), then the one-line summary and estimate. A plan
 * from a Code that does not send the structured spec yet shows its summary and checks, which every plan has.
 */
export function SpecStep({ plan, comments, onAnswer, onComment }: { plan: ReadPlan; comments: readonly ReadComment[]; onAnswer?: ((questionId: string, optionId: string) => Promise<void>) | undefined; onComment?: ((anchor: string, text: string, replyTo?: string) => Promise<void>) | undefined }) {
 const [answered, setAnswered] = useState<Record<string, string>>({});
 const criteria = plan.requirements.reduce((count, requirement) => count + requirement.criteria.length, 0);
 async function answer(questionId: string, optionId: string) {
  if (onAnswer === undefined) return;
  await onAnswer(questionId, optionId);
  const label = plan.questions.find(question => question.questionId === questionId)?.options.find(option => option.optionId === optionId)?.label;
  setAnswered(current => ({ ...current, [questionId]: label ?? optionId }));
 }
 return <section aria-label="Spec" className="rv-spec">
  <div className="rv-section-head"><h3>Spec</h3><span>{plan.version === undefined ? "" : "v" + String(plan.version) + " · "}{plan.requirements.length} {plan.requirements.length === 1 ? "requirement" : "requirements"}, {criteria} {criteria === 1 ? "criterion" : "criteria"}</span></div>
  {plan.headline !== undefined && <p className="rv-spec-headline"><VisibleText text={plan.headline} /></p>}
  {plan.requirements.length > 0 && <p className="rv-muted rv-spec-help">Each criterion gets its own test or eval, shown one by one under Proof.</p>}
  {plan.requirements.map(requirement => <div key={requirement.id}>
   <div className="rv-requirement"><span className="rv-id-chip">{requirement.id}</span><VisibleText text={requirement.title} /></div>
   {requirement.criteria.map(criterion => {
    const question = plan.questions.find(candidate => candidate.criterionId === criterion.id), pinned = comments.filter(entry => entry.anchor === criterion.id);
    return <CriterionRow key={criterion.id} criterion={criterion} question={question} answeredLabel={question === undefined ? undefined : answered[question.questionId]} comments={pinned} onAnswer={onAnswer === undefined ? undefined : answer} onComment={onComment} />;
   })}
  </div>)}
  {plan.requirements.length === 0 && plan.checks.length > 0 && <><p className="rv-muted">Checks planned</p><ul className="rv-spec-checks">{plan.checks.map((check, index) => <li key={index}><VisibleText text={check} /></li>)}</ul></>}
  {plan.estimate !== undefined && <p className="rv-muted rv-spec-estimate">Estimate: <VisibleText text={plan.estimate} /></p>}
 </section>;
}
