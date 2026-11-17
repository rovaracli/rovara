import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ReadDecision } from "../../api/decisions.js";
import { ApiError } from "../../api/errors.js";
import { proofRows, stageOf, useTaskComments, useTaskEvents, useTaskPlan, useTaskProof, useWorkApi, type Stage, type WorkRow } from "../../api/work.js";
import { Button } from "../../design/Button.js";
import { DecisionCard, type DecisionCardActions, type DecisionPane } from "../../design/DecisionCard.js";
import { Skeleton } from "../../design/Skeleton.js";
import { StepRail } from "../../design/StepRail.js";
import { VisibleText } from "../../design/VisibleText.js";
import { taskWords } from "../../text/task-words.js";
import { BuildStep } from "../session/BuildStep.js";
import { RequestStep } from "../session/RequestStep.js";
import type { Steer } from "../session/SteerBox.js";
import { ProofStep } from "../session/ProofStep.js";
import { PullRequestCard } from "../session/PullRequestCard.js";
import { SpecStep } from "../session/SpecStep.js";
import { TaskSideCards } from "../session/TaskSideCards.js";
import { LessonsUsedCard } from "../session/LessonsUsedCard.js";
import { useDecisionActions } from "../home/NeedsYou.js";
import "./work.css";

/** A read that failed: a route Code does not serve yet says so plainly (never a spinner); anything else can be tried again. */
export function SectionError({ error, retry, label }: { error: unknown; retry: () => void; label: string }) {
 if (error instanceof ApiError && (error.status === 404 || error.status === 501)) return <p className="rv-muted" role="status" data-testid="not-connected"><VisibleText text={error.message} /></p>;
 return <div role="alert" className="rv-section-error" data-testid="section-error"><p><VisibleText text={error instanceof ApiError ? error.message : `Couldn't load ${label}. Try again.`} /></p><Button onClick={retry}>Try again</Button></div>;
}

/** The quiet card: a task that asks nothing of the person says why, in fixed words. */
export function QuietCard({ row, decisionsError, wide = false }: { row: WorkRow; decisionsError: unknown; /** On the task's own page "the full page" is where the person already is. */ wide?: boolean }) {
 let title: string, body: ReactNode;
 if (row.group === "you") {
  title = row.need ?? "Needs you";
  body = decisionsError === undefined ? <>This needs you, but its decision card isn't available yet. {row.task.workflow?.blockReason !== undefined && <VisibleText text={taskWords(row.task.workflow.blockReason, row.task.hasThread)} />}</> : <>{decisionsError instanceof ApiError ? <VisibleText text={decisionsError.message} /> : "Decisions couldn't be loaded."}</>;
 } else if (row.group === "others") { title = "Waiting on someone else"; body = <>{row.line}. It moves on when they act.</>; }
 else if (row.group === "done") { title = row.line; body = <>Nothing more to do here.</>; }
 else if (row.group === "stopped") { title = row.line; body = <>Rovara stopped before it finished and nobody has picked it up since. {wide ? (row.task.sessionId === undefined ? "Continue it in your tool from the button above." : "Close it or continue it in your tool, from the actions above.") : "Open the full page to close it, or continue it in your tool."}</>; }
 else if (row.line === "In the queue") { title = "In the queue"; body = <>It starts as soon as there is room.</>; }
 else { title = "Nothing needed from you"; body = <>Rovara is working. You get a card here when a decision is needed.</>; }
 return <section className="rv-decision rv-decision-pane none" aria-label="Decision" data-testid="decision-quiet"><h3>{title}</h3><p className="rv-muted">{body}</p></section>;
}

/**
 * The selected task, beside the list (Hybrid 1): its step rail, the decision card pinned at the top, then the stage the task is in (spec, build or proof),
 * and the cost and history to the side. A click on a step shows that stage. The decision's actions are the app's own (digest check, high-risk guard,
 * confirmation page); after one is made `onDecided` lets the list move on.
 */
export interface TaskPaneProps {
 row: WorkRow; decisionsError: unknown; onDecided: (taskId: string) => void;
 /** The task alone on its own page: two columns (the stage on the left; the decision, cost and history on the right), no title of its own (the page has the heading). */
 wide?: boolean;
 /** Where "Open the full page" goes, drawn only in the side pane. */
 fullPage?: string | undefined;
 /** The steer box under the running task, when the page can steer. */
 steer?: Steer | undefined;
 /** Comment on a passage of the spec; absent where the page cannot comment. */
 onComment?: ((anchor: string, text: string, replyTo?: string) => Promise<void>) | undefined;
 /** "Design first" on a plan card, when the task view offers it. */
 design?: DecisionCardActions["design"];
}
export function TaskPane({ row, decisionsError, onDecided, wide = false, fullPage, steer, onComment, design }: TaskPaneProps) {
 const [shown, setShown] = useState<Stage>(), stage = shown ?? stageOf(row.step), query = useQueryClient(), api = useWorkApi();
 const plan = useTaskPlan(row.id), proof = useTaskProof(row.id), events = useTaskEvents(row.id), comments = useTaskComments(row.id), actionsFor = useDecisionActions();
 const decision: ReadDecision | undefined = row.decision;
 const actions: DecisionCardActions | undefined = decision === undefined ? undefined : (() => {
  const base = actionsFor(decision);
  return {
   ...base,
   ...(design === undefined ? {} : { design }),
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
  const pulls = row.task.pullRequests;
  // Only the spec and the task list need the plan: the proof and the activity are drawn from their own reads, so one failed read does not hide the others.
  if (stage === "spec") return plan.isPending ? <Skeleton label="Loading the task" /> : plan.data === undefined ? planNote : <><SpecStep plan={plan.data} comments={comments.data ?? []} onAnswer={openAnswers} onComment={onComment} />{plan.data.tasks.length > 0 && <BuildStep heading="Tasks" tasks={plan.data.tasks} events={[]} />}</>;
  if (stage === "request") return <RequestStep row={row} plan={plan.data} />;
  if (stage === "build") return <>{plan.isPending ? <Skeleton label="Loading the task" /> : plan.data === undefined ? planNote : <BuildStep tasks={plan.data.tasks} events={events.data ?? []} steer={row.group === "run" ? steer : undefined} />}{events.isError && <SectionError error={events.error} label="the build activity" retry={() => { void events.refetch(); }} />}
   <div className="rv-pane-gap">{proofBody ?? <ProofStep heading="Proof so far" rows={rows} items={proof.data ?? []} />}</div></>;
  const proofPart = <>{plan.isError && planNote}{proofBody ?? <ProofStep rows={rows} items={proof.data ?? []} />}</>;
  if (stage === "proof") return proofPart;
  return <>{proofPart}<div className="rv-pane-gap">{pulls.length === 0 ? <p className="rv-muted" data-testid="no-pull-request">No pull request yet. Rovara opens it once the proof passes.</p> : pulls.map((pull, index) => <PullRequestCard key={index} pullRequest={pull} />)}</div></>;
 };
 const decisionPart = <div className="rv-pane-decision">{decision !== undefined && actions !== undefined ? <DecisionCard key={decision.card.id} decision={decision} actions={actions} pane={pane} /> : <QuietCard row={row} decisionsError={decisionsError} wide={wide} />}</div>;
 const side = <aside className="rv-pane-side" aria-label="Cost, history and lessons"><TaskSideCards task={row.task} plan={plan.data} events={events.data ?? []} /><LessonsUsedCard project={row.project} taskId={row.id} /></aside>;
 const rail = <StepRail step={row.step} tone={row.tone} selected={stage} onSelect={step => setShown(stageOf(step))} />;
 if (wide) return <article className="rv-task-pane wide" aria-label={"Task: " + row.title} data-task-id={row.id}>
  <h2 className="rv-visually-hidden">This task</h2>
  <header className="rv-pane-head">{rail}</header>
  <div className="rv-pane-grid wide">
   <div className="rv-pane-main">{stageBody()}</div>
   <div className="rv-pane-col">{decisionPart}{side}</div>
  </div>
 </article>;
 return <article className="rv-task-pane" aria-label={"Task: " + row.title} data-task-id={row.id}>
  <header className="rv-pane-head">
   <p className="rv-eyebrow"><VisibleText text={row.project} />{row.path === undefined ? "" : " · " + row.path}{fullPage !== undefined && <Link className="rv-pane-full" to={fullPage}>Open the full page <kbd>O</kbd></Link>}</p>
   <h2 data-testid="pane-title"><VisibleText text={row.title} /></h2>
   {rail}
  </header>
  <div className="rv-pane-grid">
   {decisionPart}
   <div className="rv-pane-main">{stageBody()}</div>
   {side}
  </div>
 </article>;
}
