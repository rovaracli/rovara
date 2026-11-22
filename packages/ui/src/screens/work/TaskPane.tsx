import { openQuestionsOf } from "../session/UnderstandQuestions.js";
import { useTaskAction } from "../../api/task-action.js";
import { useAppHost } from "../../host.js";
import { createTaskSessionApi } from "../../api/sessions.js";
import { isCurrentSessionRead, readSessionIdentity } from "../../api/session-safety.js";
import { createApiClient } from "../../api/client.js";
import { TaskActionNotice } from "../session/TaskActionNotice.js";
import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ReadDecision } from "../../api/decisions.js";
import { ApiError } from "../../api/errors.js";
import { servedReadState } from "../../api/served-read.js";
import { proofRows, stageOf, useTaskComments, useTaskEvents, useTaskPlan, useTaskProof, type Stage, type WorkRow } from "../../api/work.js";
import { Button } from "../../design/Button.js";
import { DecisionCard, type DecisionCardActions, type DecisionPane } from "../../design/DecisionCard.js";
import { DecisionFrame } from "../../design/DecisionFrame.js";
import { TaskTimeline, type TaskTimelineItem } from "../../design/TaskTimeline.js";
import { STEPS } from "../../api/work.js";
import { Skeleton } from "../../design/Skeleton.js";
import { StepRail } from "../../design/StepRail.js";
import { VisibleText } from "../../design/VisibleText.js";
import { stripTerminalEscapes } from "../../text/terminal.js";
import { SteerBox } from "../session/SteerBox.js";
import { TaskMark } from "../session/task-marks.js";
import { clockTime } from "../session/task-time.js";
import { useRegisterTaskStopSlot, useTaskChip } from "../session/task-slots.js";
import { useTaskPagePolicy } from "../session/task-page-policy.js";
import { HeldState } from "../../design/HeldState.js";
import { PlanChangeRail, type PlanChangeFrameFacts } from "../session/PlanChangeFrame.js";
import { taskWords } from "../../text/task-words.js";
import { BuildStep } from "../session/BuildStep.js";
import { RequestStep } from "../session/RequestStep.js";
import type { Steer } from "../session/SteerBox.js";
import { ProofStep } from "../session/ProofStep.js";
import { PullRequestCard } from "../session/PullRequestCard.js";
import { SpecStep } from "../session/SpecStep.js";
import { TaskSideCards } from "../session/TaskSideCards.js";
import { LessonsUsedCard } from "../session/LessonsUsedCard.js";
import { TaskHeldStatesView } from "../session/TaskHeldStatesView.js";
import { TaskRunningProgressView } from "../session/TaskRunningProgressView.js";
import { PlanRevisionView } from "../session/PlanRevisionView.js";
import { PlanStartReceiptView } from "../session/PlanStartReceiptView.js";
import { PlanDecisionView } from "../session/PlanDecisionView.js";
import { useDecisionActions } from "../home/NeedsYou.js";
import "./work.css";
import "../session/task-page.css";

const TIMELINE_LABEL: Record<string, string> = { request: "Request", spec: "Plan", build: "Build", proof: "Checks and review", pull_request: "Merge", closed: "Closed" };
const TASK_WORDS = { todo: "Planned", running: "Running", done: "Done", blocked: "Stopped" } as const;
const LIVE_LINES = 3;

/** A read that failed: a route Code does not serve yet says so plainly (never a spinner); anything else can be tried again. */
export function SectionError({ error, retry, label }: { error: unknown; retry: () => void; label: string }) {
 if (error instanceof ApiError && (error.status === 404 || error.status === 501)) return <p className="rv-muted" role="status" data-testid="not-connected"><VisibleText text={error.message} /></p>;
 return <div role="alert" className="rv-section-error" data-testid="section-error"><p><VisibleText text={error instanceof ApiError ? error.message : `Couldn't load ${label}. Try again.`} /></p><Button onClick={retry}>Try again</Button></div>;
}

/**
 * Code has no proof index route yet (walkthrough 2026-11-17 item 3): Cloud forwards the read and Code answers its unknown-route 404 ("route not found"), or Cloud answers 501.
 * Either means "nothing to show yet", never an error with the route's words. Any other 404 (a task the person can no longer read) stays SectionError's.
 */
const proofNotServed = (error: unknown): boolean => error instanceof ApiError && (error.status === 501 || (error.status === 404 && error.code === "NOT_FOUND" && error.message === "route not found"));

/** The quiet card: a task that asks nothing of the person says why, in fixed words. */
export function QuietCard({ row, decisionsError, wide = false, retryOffered = false }: { row: WorkRow; decisionsError: unknown; retryOffered?: boolean; /** On the task's own page "the full page" is where the person already is. */ wide?: boolean }) {
 const page = useTaskPagePolicy() !== undefined;
 let title: string, body: ReactNode;
 if (row.group === "you") {
  title = row.need ?? "Needs you";
  // Understand's questions (Code #1057's round on the row) are answered under the row in the list, or on the task's page: no decision card is coming for them.
  if (row.need === "Answer questions") body = <>Rovara has questions before it plans this. Answer them under this task in the list, or on the task's page.</>;
  else body = decisionsError === undefined ? (page ? <>This step needs you. Rovara can't show its decision here yet. <HeldState /></> : <>This needs you, but its decision card isn't available yet. {row.task.workflow?.blockReason !== undefined && <VisibleText text={taskWords(row.task.workflow.blockReason, row.task.hasThread)} />}</>) : <>{decisionsError instanceof ApiError ? <VisibleText text={decisionsError.message} /> : "Decisions couldn't be loaded."}</>;
 } else if (row.group === "involved") { title = "You're involved in this task"; body = <>Someone added you to it. Its owner answers the agent's questions and decides. You can follow it here.</>; }
 else if (row.group === "others") { title = "Waiting on someone else"; body = <>{row.line}. It moves on when they act.</>; }
 else if (row.group === "done") { title = row.line; body = <>Nothing more to do here.</>; }
 else if (row.group === "stopped") { title = row.line; body = <>Rovara stopped before it finished and nobody has picked it up since. {wide ? (row.task.sessionId === undefined ? "Continue it in your tool from the button above." : "Close it or continue it in your tool, from the actions above.") : "Open the full page to close it, or continue it in your tool."}</>; }
 else if (row.line === "In the queue") { title = "In the queue"; body = <>It starts as soon as there is room.</>; }
 else { title = "Nothing needed from you"; body = <>Last recorded status: working. Rovara hasn't confirmed current activity. You get a card here when a decision is needed.</>; }
 if (retryOffered && row.task.workflow?.state === "BLOCKED" && row.task.workflow.stage !== "REVIEW") {
  const stages: Record<string, string> = { UNDERSTAND: "understanding the request", PLAN: "planning", PLAN_CRITIQUE: "checking the plan", IMPLEMENT: "coding", VERIFY: "checking the code", PULL_REQUEST: "opening the pull request", WAIT_FOR_MERGE: "updating the pull request" };
  body = <>Rovara stopped while {stages[row.task.workflow.stage ?? ""] ?? "working on this step"}. <VisibleText text={taskWords(row.task.workflow.blockReason ?? "The reason is not available yet.", row.task.hasThread)} />{row.group === "stopped" && <> You can retry this step from Task actions above, close it, or continue it in your tool.</>}</>;
 }
 return <section className="rv-decision rv-decision-pane none" aria-label="Decision" data-testid="decision-quiet"><h3>{title}</h3><p className="rv-muted">{body}</p></section>;
}

/**
 * The selected task, beside the list (Hybrid 1): its step rail, the decision card pinned at the top, then the stage the task is in (spec, build or proof),
 * and the cost and history to the side. A click on a step shows that stage. The decision's actions are the app's own (digest check, high-risk guard,
 * confirmation page); after one is made `onDecided` lets the list move on.
 */
export interface TaskPaneProps {
 compact?: boolean;
 readOnly?: boolean;
 row: WorkRow; decisionsError: unknown; onDecided: (taskId: string) => void;
 /** The task alone on its own page: two columns (the stage on the left; the decision, cost and history on the right), no title of its own (the page has the heading). */
 wide?: boolean;
 /** The latest task projection failed; retained steps are last-known context only. */
 pageProjection?: "current" | "stale" | undefined;
 /** Existing session controls and conversation retain their own safety state. */
 pageLocked?: boolean;
 sessionEntry?: ReactNode;
 /** The served session offers the shared Retry control; this only selects its explanatory copy. */
 retryOffered?: boolean;
 primary?: ReactNode;
 /** Where "Open the full page" goes, drawn only in the side pane. */
 fullPage?: string | undefined;
 /** The steer box under the running task, when the page can steer. */
 steer?: Steer | undefined;
 /** Comment on a passage of the spec; absent where the page cannot comment. */
 onComment?: ((anchor: string, text: string, replyTo?: string) => Promise<void>) | undefined;
 /** "Design first" on a plan card, when the task view offers it. */
 design?: DecisionCardActions["design"];
 /** One line under "About this task", and what opens inside it (the place, cost and payer, and the page-level unknowns). */
 aboutSummary?: string | undefined;
 aboutExtra?: ReactNode;
 /** A pending plan beside a delivered instruction: the decision is drawn as the plan-change frame, with its own rail. */
 planChange?: PlanChangeFrameFacts | undefined;
}
export function TaskPane({ compact = false, readOnly = false, row, decisionsError, onDecided, wide = false, fullPage, steer, onComment, design, pageProjection, sessionEntry, primary, pageLocked = false, aboutSummary, aboutExtra, planChange, retryOffered = false }: TaskPaneProps) {
 const registerStop = useRegisterTaskStopSlot(), approvalReceipt = useTaskChip() === "checking";
 const [shown, setShown] = useState<Stage>(), stage = shown ?? stageOf(row.step), query = useQueryClient(), host = useAppHost();
 const answerAction = useTaskAction(host, "plan-answers:" + row.id);
 const plan = useTaskPlan(row.id), proof = useTaskProof(row.id), events = useTaskEvents(row.id), comments = useTaskComments(row.id), actionsFor = useDecisionActions();
 const currentPlan = plan.isError ? undefined : plan.data, keptPlan = compact ? servedReadState(plan).data : undefined;
 const decision: ReadDecision | undefined = readOnly ? undefined : row.decision;
 const decisionNeedsPlan = decision !== undefined && ["approve_plan", "approve_requirements", "approve_design"].includes(decision.card.kind);
 const actions: DecisionCardActions | undefined = decision === undefined ? undefined : (() => {
  const base = actionsFor(decision);
  return {
   ...base,
   ...(design === undefined ? {} : { design }),
   onApprove: async (tab, reason, extras) => { const result = await (extras === undefined ? base.onApprove(tab, reason) : base.onApprove(tab, reason, extras));if (result.kind === "decided") onDecided(row.id);return result; },
   onRequestChanges: async (reason, includedCommentIds) => { const result = await (includedCommentIds === undefined ? base.onRequestChanges(reason) : base.onRequestChanges(reason, includedCommentIds));if (result.kind === "decided") onDecided(row.id);return result; },
   onReject: async reason => { const result = await base.onReject(reason);if (result.kind === "decided") onDecided(row.id);return result; },
   onChoose: async action => { await base.onChoose(action);onDecided(row.id); },
  };
 })();
 const paneDecision: ReadDecision | undefined = decision?.card.kind !== "approve_plan" ? decision : {
  ...decision,
  card: {
   ...decision.card,
   actions: decision.card.actions.map(action => action.kind === "approve" ? { ...action, label: currentPlan?.version === undefined ? "Approve plan" : "Approve plan v" + String(currentPlan.version) } : action),
  },
 };
 async function answer(questionId: string, optionId: string) {
  if (row.task.sessionId === undefined || row.task.workflow?.round === undefined) throw new ApiError(409, "ANSWER_ON_SESSION_PAGE", "Answer this question on the task's session page.");
  const body = { requestId: crypto.randomUUID(), round: row.task.workflow.round, ...(row.task.workflow.revision === undefined ? {} : { revision: row.task.workflow.revision }), answers: [{ questionId, optionId }] };
  let checkAuthority: () => void = () => { throw new ApiError(409, "INTENT_NOT_WAITING", "Read the current task before answering."); };
  const result = await answerAction.run("answers", body, frozen => {
   checkAuthority();
   return createApiClient(host).send("POST", "/v1/app/sessions/" + encodeURIComponent(row.task.sessionId!) + "/answers", frozen, { parse: (value: unknown) => value }, { retry: "never", pendingIsUnknown: true });
  }, async () => {
   const person = await readSessionIdentity(host), latest = await createTaskSessionApi(host).read(row.task.sessionId!);
   checkAuthority = () => {
    const current = latest.body.kind === "task" ? openQuestionsOf(latest.body.task) : undefined;
    if (!isCurrentSessionRead(host, person, row.task.sessionId!, latest) || !["use", "edit"].includes(latest.you.level) || current?.round !== body.round || current.revision !== body.revision) throw new ApiError(409, "INTENT_NOT_WAITING", "These questions or your permissions changed. Read the current task before answering.");
   };
   checkAuthority();
  });
  if (result.kind !== "done") throw new ApiError(409, "PENDING", "Your answer is waiting for confirmation.");
  await Promise.all([query.invalidateQueries({ queryKey: ["decisions"] }), query.invalidateQueries({ queryKey: ["work"] })]);
  onDecided(row.id);
 }
 const question = decision?.card.kind === "answer_question" ? currentPlan?.questions.find(candidate => decision.card.id.endsWith(candidate.questionId)) ?? currentPlan?.questions[0] : undefined;
 const failedEval = decision?.card.kind === "choose_checks" ? proof.data?.items.find(item => item.kind === "eval" && item.verdict === "fail" && item.passed !== undefined && item.total !== undefined) : undefined;
 const pane: DecisionPane | undefined = decision === undefined ? undefined : {
  answers: answerAction.locked || question === undefined || question.options.length === 0 ? undefined : { options: question.options.map(option => ({ id: option.optionId, label: option.label })), onAnswer: optionId => answer(question.questionId, optionId) },
  evalResult: failedEval === undefined ? undefined : { passed: failedEval.passed!, total: failedEval.total!, bar: failedEval.bar },
  outcome: currentPlan?.headline,
  planChange: decision?.card.kind === "approve_plan" ? planChange : undefined,
  quickChange: row.path === "Quick spec" && ["approve_plan", "approve_requirements", "approve_design"].includes(decision.card.kind) && decision.card.risk === "low",
 };
 const rows = currentPlan === undefined ? [] : proofRows(currentPlan.requirements, proof.data?.items ?? [], currentPlan.tasks);
 // An unresolved answer removes every sender; the durable record keeps Check available.
 const openAnswers = answerAction.locked || readOnly || plan.isError || plan.failureCount > 0 ? undefined : (questionId: string, optionId: string) => answer(questionId, optionId);
 const run = row.task.run?.state === "RUNNING" ? row.task.run : undefined;
 const progress = run === undefined || run.steps.length === 0 ? null : <TaskRunningProgressView
  stages={run.steps.map(step => ({ id: step.id, label: step.name, state: step.status === "done" ? "done" : "upcoming" }))}
  lastKnownStepId={run.currentStep?.id}
  activity="unknown"
  pageProjection={pageProjection}
  onCheck={() => { void query.invalidateQueries({ queryKey: ["work"] });void query.invalidateQueries({ queryKey: ["session"] }); }}
 />;
 const retryPlan = () => { void plan.refetch(); };
 const planNote = plan.isError ? <SectionError error={plan.error} label="this task's plan" retry={retryPlan} /> : null;
 const proofBody = proof.isError ? (proofNotServed(proof.error) ? <p className="rv-muted" role="status" data-testid="proof-not-yet">Proof will appear here.</p> : <SectionError error={proof.error} label="the proof" retry={() => { void proof.refetch(); }} />) : null;
 const stageBody = (): ReactNode => {
  const pulls = row.task.pullRequests;
  // Only the spec and the task list need the plan: the proof and the activity are drawn from their own reads, so one failed read does not hide the others.
  // The short peek keeps the last readable plan as read-only context while a refresh fails (DEC 254zzz324); the answers and the plan decisions stay removed. The task page shows the failed state instead.
  const shownPlan = currentPlan ?? keptPlan;
  if (stage === "spec") return plan.isPending ? <Skeleton label="Loading the task" /> : plan.isError && shownPlan === undefined ? <PlanDecisionView taskTitle={row.title} plan={undefined} state="failed" onRetry={retryPlan} /> : shownPlan === undefined ? planNote : <><fieldset disabled={answerAction.locked} style={{ border: 0, padding: 0, margin: 0, minWidth: 0 }}><SpecStep plan={shownPlan} comments={comments.data ?? []} onAnswer={openAnswers} onComment={onComment} /></fieldset>{shownPlan.tasks.length > 0 && <BuildStep heading="Tasks" tasks={shownPlan.tasks} events={[]} />}
   {!wide && !compact && <details><summary>Plan history</summary>
    {/* The current readers carry no comparison or receipt identity. Never map the workflow revision or a generic decision outcome to either. */}
    <TaskHeldStatesView page="plan" onCheck={retryPlan} />
    <PlanRevisionView readState="ready" comparison={{ status: "unavailable" }} />
    <PlanStartReceiptView unavailable />
   </details>}
  </>;
  if (stage === "request") return plan.isError ? <PlanDecisionView taskTitle={row.title} plan={undefined} state="failed" onRetry={retryPlan} /> : <RequestStep row={row} plan={currentPlan} />;
  if (stage === "build") return <>{plan.isPending ? <Skeleton label="Loading the task" /> : plan.isError ? planNote : currentPlan === undefined ? planNote : <BuildStep tasks={currentPlan.tasks} events={events.data ?? []} steer={row.group === "run" ? steer : undefined} />}{events.isError && <SectionError error={events.error} label="the build activity" retry={() => { void events.refetch(); }} />}
   <div className="rv-pane-gap">{proofBody ?? <ProofStep heading="Proof so far" rows={rows} items={proof.data?.items ?? []} failures={proof.data?.failures} failuresNotListed={proof.data?.failuresNotListed} />}</div></>;
  const proofPart = <>{plan.isError && planNote}{proofBody ?? <ProofStep rows={rows} items={proof.data?.items ?? []} failures={proof.data?.failures} failuresNotListed={proof.data?.failuresNotListed} />}</>;
  if (stage === "proof") return proofPart;
  return <>{proofPart}<div className="rv-pane-gap">{pulls.length === 0 ? <p className="rv-muted" data-testid="no-pull-request">No pull request yet. Rovara opens it once the proof passes.</p> : pulls.map((pull, index) => <PullRequestCard key={index} pullRequest={pull} />)}</div></>;
 };
 const decisionPart = <div className="rv-pane-decision">{decision !== undefined && actions !== undefined && !(plan.isError && decisionNeedsPlan) ? <DecisionCard key={decision.card.id} decision={paneDecision!} actions={actions} pane={pane} /> : decision !== undefined && plan.isError && decisionNeedsPlan ? null : <QuietCard row={row} decisionsError={decisionsError} wide={wide} retryOffered={retryOffered} />}</div>;
 const side = <aside className="rv-pane-side" aria-label="Cost, history and lessons"><TaskSideCards task={row.task} plan={currentPlan} events={events.data ?? []} /><LessonsUsedCard project={row.project} taskId={row.id} /></aside>;
 const sections = <StepRail step={row.step} tone={row.tone} selected={stage} onSelect={step => setShown(stageOf(step))} />;
 const runningHeld = row.task.status === "RUNNING" || run !== undefined ? <TaskHeldStatesView page="running" label="Latest activity" onCheck={() => { void query.invalidateQueries({ queryKey: ["work"] });void query.invalidateQueries({ queryKey: ["session"] }); }} /> : null;
 const rail = progress === null ? <>{sections}{runningHeld}</> : <>{progress}<details><summary>Browse task sections</summary>{sections}</details></>;
 if (compact) return <><TaskActionNotice key={answerAction.pendingKey} pending={answerAction.pending} recovery={answerAction.recovery} taskHref={"/app/sessions/" + encodeURIComponent(row.task.sessionId ?? row.id)} check={() => plan.refetch()} />{decision !== undefined && decisionPart}{stage === "spec" && stageBody()}<LessonsUsedCard project={row.project} taskId={row.id} /></>;
 if (wide) {
  // A list group is not a workflow observation. Never infer progress from it.
  const workflow = row.task.workflow;
  const hasDecision = decision !== undefined && actions !== undefined && !(plan.isError && decisionNeedsPlan);
  const timelineState = workflow?.state === "WAITING" && (decision !== undefined || primary !== undefined) ? "needs_you" : workflow?.state === "RUNNING" && row.task.status === "RUNNING" ? "running" : undefined;
  const planVersion = currentPlan?.version, guard = (body: ReactNode) => <fieldset className="rv-task-content-guard" disabled={pageLocked}>{body}</fieldset>;
  const merged = row.step === "merged", at = merged ? STEPS.length : STEPS.findIndex(item => item.step === row.step);
  const waitWords = row.step === "pull_request" ? "Waiting for your merge decision" : decision?.card.kind === "approve_plan" && planVersion !== undefined ? "Waiting for your decision on v" + String(planVersion) : "Waiting for your decision";
  const railItems: TaskTimelineItem[] | undefined = workflow === undefined || at < 0 || (timelineState === undefined && !merged) ? undefined : [
   ...(at > 0 ? [{ id: "finished", title: at === 1 ? "1 step finished" : String(at) + " steps finished", state: "done" as const, detail: STEPS.slice(0, at).map(item => TIMELINE_LABEL[item.step]).join(", ") }] : []),
   ...STEPS.slice(at).map((item, index): TaskTimelineItem => ({ id: item.step, title: TIMELINE_LABEL[item.step] ?? item.label, state: index === 0 && timelineState !== undefined ? timelineState : "next", ...(index === 0 && timelineState === "needs_you" ? { detail: waitWords } : index === 0 && timelineState === "running" ? { detail: "Current step" } : {}) })),
  ];
  const headline = currentPlan?.headline;
  const context = progress ?? (hasDecision && decision?.card.kind === "approve_plan" && planChange !== undefined ? <PlanChangeRail facts={planChange} /> : <aside className="rv-task-context" aria-label="Where this task is">{primary !== undefined && headline !== undefined && <section className="rv-task-change-summary" aria-label="What this change does"><h2>What this change does</h2><p><VisibleText text={headline} /></p></section>}<h2>Where this task is</h2>{railItems !== undefined ? <TaskTimeline items={railItems} /> : <p className="rv-muted rv-task-progress-held">Current progress is not confirmed here. <HeldState /></p>}</aside>);
  const section = (label: string, summary: ReactNode, body: ReactNode, open = false) => <details className="rv-task-section" open={open || undefined}><summary><TaskMark kind="chevron" /><strong>{label}</strong><span className="rv-task-section-summary">{summary}</span></summary><div className="rv-task-section-body">{body}</div></details>;
  const tasks = currentPlan?.tasks ?? [], runningAt = tasks.findIndex(task => task.status === "running");
  const currentCard = primary === undefined && !hasDecision && stage === "build";
  const stamp = (at: string) => clockTime(at) ?? "";
  const log = events.data ?? [], last = log[log.length - 1], lastText = last === undefined ? undefined : stripTerminalEscapes(last.text ?? last.kind);
  const cardTitle = runningAt >= 0 ? tasks[runningAt]!.title : row.need ?? run?.currentStep?.name ?? row.line;
  const card = <DecisionFrame as="section" title={cardTitle} actions={null} className="rv-task-primary rv-task-current">
   <p className="rv-task-subline">{"Build" + (runningAt >= 0 ? ", plan item " + String(runningAt + 1) + " of " + String(tasks.length) : "")}{runningHeld}</p>
   <div className="rv-task-session-slot">{sessionEntry}</div>
   {guard(<>
    {plan.isError ? planNote : tasks.length > 0 ? <ol className="rv-task-checklist" aria-label="Plan items">{tasks.map((task, index) => <li key={task.id} data-task={task.id} data-state={task.status} aria-current={task.status === "running" ? "step" : undefined}><TaskMark kind={task.status === "done" ? "done" : task.status === "running" ? "running" : task.status === "blocked" ? "attention" : "next"} /><span>{index + 1} · <VisibleText text={task.title} /></span><span className="rv-visually-hidden">, {TASK_WORDS[task.status]}</span></li>)}</ol> : <p className="rv-muted">No plan items recorded yet.</p>}
    <details className="rv-task-log"><summary><TaskMark kind="chevron" /><span className="rv-task-log-label">Live log</span>{lastText !== undefined && <code><VisibleText text={lastText} /></code>}</summary>{log.length === 0 ? <p className="rv-muted">No activity recorded yet.</p> : <div className="rv-live" role="log" aria-label="What Rovara is doing">{log.slice(-LIVE_LINES).map(line => <div key={line.seq}><b>{stamp(line.at)}</b> <VisibleText text={stripTerminalEscapes(line.text ?? line.kind)} /></div>)}</div>}</details>
    {row.group === "run" && steer !== undefined && <details className="rv-task-steer" open={steer.kind === "unavailable" || undefined}><summary><TaskMark kind="chevron" /><span>Steer this task</span></summary><SteerBox steer={steer} label="task" /></details>}
    {events.isError && !plan.isError && <SectionError error={events.error} label="the build activity" retry={() => { void events.refetch(); }} />}
   </>)}
   <div className="rv-task-stop-row"><span className="rv-task-stop-slot" ref={registerStop} /><span className="rv-muted rv-task-stop-note">Files are kept. Rovara stops after its current step.</span></div>
  </DecisionFrame>;
  const quiet = <QuietCard row={row} decisionsError={decisionsError} wide retryOffered={retryOffered} />;
  return <article className="rv-task-pane rv-task-composition wide" aria-label={"Task: " + row.title} data-task-id={row.id}>
   <h2 className="rv-visually-hidden">This task</h2>
   <TaskActionNotice key={answerAction.pendingKey} pending={answerAction.pending} recovery={answerAction.recovery} taskHref={"/app/sessions/" + encodeURIComponent(row.task.sessionId ?? row.id)} check={() => plan.refetch()} />
   <div className="rv-task-columns"><div className="rv-task-reading">
    {primary !== undefined ? <>{primary}<div className="rv-task-session-slot">{sessionEntry}</div></> : !hasDecision && plan.isError && (stage === "spec" || stage === "request") ? <>{guard(stageBody())}<div className="rv-task-session-slot">{sessionEntry}</div>{quiet}</> : hasDecision ? <>{guard(decisionPart)}<div className="rv-task-session-slot">{sessionEntry}</div></> : currentCard ? <>{card}{quiet}</> : <><DecisionFrame as="section" title={row.need ?? run?.currentStep?.name ?? row.line} actions={null} className="rv-task-primary">{guard(stageBody())}</DecisionFrame><div className="rv-task-session-slot">{sessionEntry}</div>{quiet}</>}
    {guard(<>
    {shown !== undefined && stage !== "spec" && stage !== "request" && !currentCard && (hasDecision || primary !== undefined) && <div className="rv-task-selected-section">{stageBody()}</div>}
    {section("Plan and changes", plan.isError ? "Plan unavailable" : currentPlan === undefined ? "Loading plan" : (planVersion === undefined ? "Plan" : "Plan v" + String(planVersion)) + (tasks.length === 0 ? "" : " · " + String(tasks.length) + (tasks.length === 1 ? " item" : " items")), <>{(hasDecision || primary !== undefined && shown !== undefined) && (stage === "spec" || stage === "request") && stageBody()}{(stage !== "spec" && stage !== "request" || currentCard) && (planNote ?? (currentPlan === undefined ? null : <SpecStep plan={currentPlan} comments={comments.data ?? []} onAnswer={openAnswers} onComment={onComment} />))}{sections}<TaskHeldStatesView page="plan" onCheck={retryPlan} /></>, hasDecision && !approvalReceipt && (stage === "spec" || stage === "request"))}
    {section("Checks and reviews", proof.isError ? "Proof unavailable" : proof.data === undefined ? "Loading proof" : proof.data.items.length === 0 ? "Recorded results appear here" : String(proof.data.items.length) + " recorded results", (primary === undefined || shown !== undefined) && (stage === "proof" || stage === "pull_request") ? <p className="rv-muted">Recorded proof is shown above.</p> : proofBody ?? <ProofStep rows={rows} items={proof.data?.items ?? []} failures={proof.data?.failures} failuresNotListed={proof.data?.failuresNotListed} />)}
    {section("Activity", events.isError ? "Activity unavailable" : events.data === undefined ? "Loading activity" : events.data.length === 0 ? "Recorded events appear here" : String(events.data.length) + " recorded events", <>{events.isError && !currentCard && <SectionError error={events.error} label="the activity" retry={() => { void events.refetch(); }} />}<TaskSideCards task={row.task} plan={currentPlan} events={events.data ?? []} /></>)}
    {section("About this task", aboutSummary ?? row.project, <>{aboutExtra}<LessonsUsedCard project={row.project} taskId={row.id} /></>)}
    </>)}
   </div><div>{guard(context)}</div></div>
  </article>;
 }
 return <article className="rv-task-pane" aria-label={"Task: " + row.title} data-task-id={row.id}>
  <TaskActionNotice key={answerAction.pendingKey} pending={answerAction.pending} recovery={answerAction.recovery} taskHref={"/app/sessions/" + encodeURIComponent(row.task.sessionId ?? row.id)} check={() => plan.refetch()} />
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
