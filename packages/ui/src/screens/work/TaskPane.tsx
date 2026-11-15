import { useState, type ReactNode } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { ReadDecision } from "../../api/decisions.js";
import { ApiError } from "../../api/errors.js";
import { proofRows, stageOf, useTaskComments, useTaskEvents, useTaskPlan, useTaskProof, useWorkApi, type Stage, type WorkRow } from "../../api/work.js";
import { Button } from "../../design/Button.js";
import { DecisionCard, type DecisionCardActions, type DecisionPane } from "../../design/DecisionCard.js";
import { Skeleton } from "../../design/Skeleton.js";
import { StepRail } from "../../design/StepRail.js";
import { VisibleText } from "../../design/VisibleText.js";
import { BuildStep } from "../session/BuildStep.js";
import { ProofStep } from "../session/ProofStep.js";
import { PullRequestCard } from "../session/PullRequestCard.js";
import { SpecStep } from "../session/SpecStep.js";
import { TaskSideCards } from "../session/TaskSideCards.js";
import { useDecisionActions } from "../home/NeedsYou.js";

/** A read that failed: a route Code does not serve yet says so plainly (never a spinner); anything else can be tried again. */
export function SectionError({ error, retry, label }: { error: unknown; retry: () => void; label: string }) {
 if (error instanceof ApiError && (error.status === 404 || error.status === 501)) return <p className="rv-muted" role="status" data-testid="not-connected"><VisibleText text={error.message} /></p>;
 return <div role="alert" className="rv-section-error" data-testid="section-error"><p><VisibleText text={error instanceof ApiError ? error.message : `Couldn't load ${label}. Try again.`} /></p><Button onClick={retry}>Try again</Button></div>;
}

/** The quiet card: a task that asks nothing of the person says why, in fixed words. */
export function QuietCard({ row, decisionsError }: { row: WorkRow; decisionsError: unknown }) {
 let title: string, body: ReactNode;
 if (row.group === "you") {
  title = row.need ?? "Needs you";
  body = decisionsError === undefined ? <>This needs you, but its decision card isn't available yet. {row.task.workflow?.blockReason !== undefined && <VisibleText text={row.task.workflow.blockReason} />}</> : <>{decisionsError instanceof ApiError ? <VisibleText text={decisionsError.message} /> : "Decisions couldn't be loaded."}</>;
 } else if (row.group === "others") { title = "Waiting on someone else"; body = <>{row.line}. It moves on when they act.</>; }
 else if (row.group === "done") { title = row.line; body = <>Nothing more to do here.</>; }
 else if (row.line === "In the queue") { title = "In the queue"; body = <>It starts as soon as there is room.</>; }
 else { title = "Nothing needed from you"; body = <>Rovara is working. You get a card here when a decision is needed.</>; }
 return <section className="rv-decision rv-decision-pane none" aria-label="Decision" data-testid="decision-quiet"><h3>{title}</h3><p className="rv-muted">{body}</p></section>;
}

/**
 * The selected task, beside the list (Hybrid 1): its step rail, the decision card pinned at the top, then the stage the task is in (spec, build or proof),
 * and the cost and history to the side. A click on a step shows that stage. The decision's actions are the app's own (digest check, high-risk guard,
 * confirmation page); after one is made `onDecided` lets the list move on.
 */
export function TaskPane({ row, decisionsError, onDecided }: { row: WorkRow; decisionsError: unknown; onDecided: (taskId: string) => void }) {
 const [shown, setShown] = useState<Stage>(), stage = shown ?? stageOf(row.step), query = useQueryClient(), api = useWorkApi();
 const plan = useTaskPlan(row.id), proof = useTaskProof(row.id), events = useTaskEvents(row.id), comments = useTaskComments(row.id), actionsFor = useDecisionActions();
 const decision: ReadDecision | undefined = row.decision;
 const actions: DecisionCardActions | undefined = decision === undefined ? undefined : (() => {
  const base = actionsFor(decision);
  return {
   ...base,
   onApprove: async (tab, reason) => { const result = await base.onApprove(tab, reason);if (result.kind === "decided") onDecided(row.id);return result; },
   onReject: async reason => { const result = await base.onReject(reason);if (result.kind === "decided") onDecided(row.id);return result; },
   onChoose: async action => { await base.onChoose(action);onDecided(row.id); },
  };
 })();
 async function answer(questionId: string, optionId: string) {
  const result = await api.answer(row.id, questionId, optionId, row.task.workflow?.revision);
  if (result.kind !== "done") throw new ApiError(409, "PENDING", "Your answer is waiting for confirmation.");
  await Promise.all([query.invalidateQueries({ queryKey: ["decisions"] }), query.invalidateQueries({ queryKey: ["work"] })]);
  onDecided(row.id);
 }
 const question = decision?.card.kind === "answer_question" ? plan.data?.questions.find(candidate => decision.card.id.endsWith(candidate.questionId)) ?? plan.data?.questions[0] : undefined;
 const failedEval = decision?.card.kind === "choose_checks" ? proof.data?.find(item => item.kind === "eval" && item.verdict === "fail" && item.passed !== undefined && item.total !== undefined) : undefined;
 const pane: DecisionPane | undefined = decision === undefined ? undefined : {
  answers: question === undefined || question.options.length === 0 ? undefined : { options: question.options.map(option => ({ id: option.optionId, label: option.label })), onAnswer: optionId => answer(question.questionId, optionId) },
  evalResult: failedEval === undefined ? undefined : { passed: failedEval.passed!, total: failedEval.total!, bar: failedEval.bar },
  quickChange: row.path === "Quick spec" && ["approve_plan", "approve_requirements", "approve_design"].includes(decision.card.kind) && decision.card.risk === "low",
 };
 const rows = plan.data === undefined ? [] : proofRows(plan.data.requirements, proof.data ?? [], plan.data.tasks);
 const openAnswers = (questionId: string, optionId: string) => answer(questionId, optionId);
 const retryPlan = () => { void plan.refetch(); };
 const planNote = plan.isError ? <SectionError error={plan.error} label="this task's plan" retry={retryPlan} /> : null;
 const proofBody = proof.isError ? <SectionError error={proof.error} label="the proof" retry={() => { void proof.refetch(); }} /> : null;
 const stageBody = (): ReactNode => {
  const pull = row.task.pullRequests[0];
  // Only the spec and the task list need the plan: the proof and the activity are drawn from their own reads, so one failed read does not hide the others.
  if (stage === "spec") return plan.isPending ? <Skeleton label="Loading the task" /> : plan.data === undefined ? planNote : <><SpecStep plan={plan.data} comments={comments.data ?? []} onAnswer={openAnswers} />{plan.data.tasks.length > 0 && <BuildStep heading="Tasks" tasks={plan.data.tasks} events={[]} />}</>;
  if (stage === "build") return <>{plan.isPending ? <Skeleton label="Loading the task" /> : plan.data === undefined ? planNote : <BuildStep tasks={plan.data.tasks} events={events.data ?? []} />}{events.isError && <SectionError error={events.error} label="the build activity" retry={() => { void events.refetch(); }} />}
   <div className="rv-pane-gap">{proofBody ?? <ProofStep heading="Proof so far" rows={rows} items={proof.data ?? []} />}</div></>;
  return <>{plan.isError && planNote}{proofBody ?? <ProofStep rows={rows} items={proof.data ?? []} />}{pull !== undefined && <div className="rv-pane-gap"><PullRequestCard pullRequest={pull} /></div>}</>;
 };
 return <article className="rv-task-pane" aria-label={"Task: " + row.title} data-task-id={row.id}>
  <header className="rv-pane-head">
   <p className="rv-eyebrow"><VisibleText text={row.project} />{row.path === undefined ? "" : " · " + row.path}</p>
   <h2 data-testid="pane-title"><VisibleText text={row.title} /></h2>
   <StepRail step={row.step} tone={row.tone} selected={stage === "spec" ? "spec" : stage === "build" ? "build" : "proof"} onSelect={step => setShown(stageOf(step))} />
  </header>
  <div className="rv-pane-grid">
   <div className="rv-pane-decision">{decision !== undefined && actions !== undefined ? <DecisionCard key={decision.card.id} decision={decision} actions={actions} pane={pane} /> : <QuietCard row={row} decisionsError={decisionsError} />}</div>
   <div className="rv-pane-main">{stageBody()}</div>
   <aside className="rv-pane-side" aria-label="Cost and history"><TaskSideCards task={row.task} plan={plan.data} events={events.data ?? []} /></aside>
  </div>
 </article>;
}
