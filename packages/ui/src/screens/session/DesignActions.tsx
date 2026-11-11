import { useMemo, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { DECISION_LABELS, skipRefusalText, type DesignActionsView } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { createDesignReviewApi } from "../../api/design-review.js";
import { ApiError } from "../../api/errors.js";
import { TaskDecisions } from "../home/NeedsYou.js";
import { StoppedTaskActions } from "./StoppedTaskActions.js";
import { TaskPagePeopleAndComments } from "./TaskPagePeopleAndComments.js";
import { PlanPanelHost, usePanelDocument } from "./plan-panel-host.js";
import { createPlanPanelApi } from "../../api/plan-panel.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { classificationLine, notNeededLine, questionLines, readDesignActions, readDesignReview, retryOffer } from "./design-review-view.js";
import type { ReadSession } from "./SessionHeader.js";
import { workspaceTask, type ReadTask } from "./workspace-types.js";

/** What the task page says about design review for a task: the classification line, and the Design first, Skip and Retry review actions the broker offered this person (`designActions`). Nothing shows for a task with neither. */
export function designActionsModel(task: ReadTask): { line: string | undefined; actions: DesignActionsView | undefined } {
 const workflow = task.workflow, review = readDesignReview(workflow?.designReview), actions = readDesignActions(task.designActions);
 const assessment = workflow?.intent?.assessment, design = assessment?.kind === "ready" ? assessment.design : undefined;
 const known = design === undefined ? undefined : { needed: design.needed, reasons: design.reasons.filter((reason): reason is Exclude<typeof reason, "unknown"> => reason !== "unknown") };
 const line = review === "unreadable" ? undefined : review !== undefined ? classificationLine(review) : known !== undefined && !known.needed ? notNeededLine(known) : undefined;
 return { line, actions };
}

/** The strip above the task's work: the line, the hint on a Quick plan, and the buttons. Each press asks the broker, which works out again whether this person may; a refusal is shown in its words. */
export function DesignActions({ task, sessionKey }: { task: ReadTask; sessionKey: readonly unknown[] }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createDesignReviewApi(host), [host]);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [message, setMessage] = useState<string>(), [confirmSkip, setConfirmSkip] = useState(false), [signIn, setSignIn] = useState<false | { url?: string }>(false);
 const { line, actions } = designActionsModel(task);
 if (line === undefined && actions === undefined) return null;
 async function press(kind: "first" | "skip" | "retry") {
  if (busy) return;
  setBusy(true);setError(undefined);setMessage(undefined);setSignIn(false);
  try {
   const result = await (kind === "first" ? api.designFirst(task.taskId, crypto.randomUUID()) : kind === "retry" ? api.retry(task.taskId, crypto.randomUUID()) : api.skip(task.taskId, crypto.randomUUID()));
   if (result.kind !== "done") throw new ApiError(409, "PENDING", "This is waiting for confirmation. Open the task to continue.");
   setConfirmSkip(false);setMessage(kind === "first" ? "Asked for design review first. Rovara reviews the design before it builds." : kind === "retry" ? "Asked for the design review again." : "Design review skipped.");
   await query.invalidateQueries({ queryKey: [...sessionKey] });
  } catch (failure) {
   // A high-risk Skip without the decide-grade sign-in: said here, with "Sign in again" that runs the decide sign-in the broker made for it and comes back to this page (the decision card's pattern).
   setSignIn(failure instanceof ApiError && failure.code === "REAUTH_REQUIRED" ? (failure.signInUrl === undefined ? {} : { url: failure.signInUrl }) : false);
   setError(failure instanceof ApiError ? failure.message : "Couldn't do that. Try again.");
  }
  finally { setBusy(false); }
 }
 // While the cost card waits, its own Skip is the one (behind its evidence and, when high, the email-code sign-in): this strip offers none (final review: one Skip).
 const review = readDesignReview(task.workflow?.designReview), costWaiting = review !== undefined && review !== "unreadable" && review.status === "waiting_cost";
 const skip = actions?.skip, retry = retryOffer(actions?.retry);
 return <section className="rv-design-actions" aria-label="Design review actions">
  {line !== undefined && <p className="rv-design-line"><VisibleText text={line} /></p>}
  {actions?.hint === true && <p className="rv-design-hint" role="status">This may need design review.</p>}
  {skip !== undefined && !skip.allowed && <p className="rv-muted"><VisibleText text={skipRefusalText(skip, skip.approverName)} /></p>}
  <div className="rv-actions">
   {actions?.designFirst === true && <Button disabled={busy} onClick={() => { void press("first"); }}>Design first</Button>}
   {skip?.allowed === true && !costWaiting && !confirmSkip && <Button disabled={busy} onClick={() => setConfirmSkip(true)}>Skip design review</Button>}
   {retry !== undefined && <><Button disabled={busy} onClick={() => { void press("retry"); }}>Retry review</Button><span className="rv-muted">{retry.left}</span></>}
  </div>
  {confirmSkip && <div role="group" aria-label="Confirm skipping design review"><p>Skip design review for this task? The design goes to a person without fresh-context reviewers reading it first.</p><div className="rv-actions"><Button variant="primary" busy={busy} onClick={() => { void press("skip"); }}>Skip design review</Button><Button disabled={busy} onClick={() => setConfirmSkip(false)}>Keep it</Button></div></div>}
  {message !== undefined && <p role="status">{message}</p>}
  {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
  {signIn && (signIn.url !== undefined ? <a className="rv-button rv-button-secondary" href={signIn.url}>{DECISION_LABELS.signInAgain}</a> : <Button onClick={() => host.signIn(host.currentPath())}>{DECISION_LABELS.signInAgain}</Button>)}
 </section>;
}

/** The task's decision cards, with the design review's line and buttons above them. A task view without `designActions` or a design review is exactly the cards, as before. */
export function TaskDesignPanel({ session, taskId }: { session: ReadSession; taskId: string }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createDesignReviewApi(host), [host]), task = useMemo(() => workspaceTask(session), [session]);
 const panel = usePanelDocument();
 // OWNER DECISION 18 (review M4): only for the task's owner, only while a PR feedback review waits for them (its own read, made only at that stage), and only with the cards on.
 const feedback = useQuery({ queryKey: ["task-feedback", taskId], queryFn: () => createPlanPanelApi(host).feedback(taskId), retry: false, enabled: panel.on && session.you.owner && task?.workflow?.stage === "WAIT_FOR_MERGE" });
 const feedbackWaiting = panel.on && session.you.owner && feedback.data?.status === "PENDING";
 const key = ["session", session.sessionId] as const, actions = readDesignActions(task?.designActions), offered = actions?.designFirst === true;
 const design = offered ? { hint: actions?.hint === true, onDesignFirst: async () => {
  const result = await api.designFirst(taskId, crypto.randomUUID());
  if (result.kind !== "done") throw new ApiError(409, "PENDING", "This is waiting for confirmation. Open the task to continue.");
  await query.invalidateQueries({ queryKey: [...key] });
 } } : undefined;
 // Slice 2: the design questions this task waits on, for their card (answered there; a parked review can be kept waiting). The broker checks who may answer and every answer.
 const review = useMemo(() => readDesignReview(task?.workflow?.designReview), [task]);
 const asked = review !== undefined && review !== "unreadable" && review.status === "waiting_answers" ? questionLines(review) : undefined;
 const reread = async () => { await Promise.all([query.invalidateQueries({ queryKey: [...key] }), query.invalidateQueries({ queryKey: ["decisions"] }), query.invalidateQueries({ queryKey: ["home"] })]); };
 const questions = asked === undefined || review === undefined || review === "unreadable" ? undefined : {
  items: asked.questions.map(question => ({ id: question.id, unclear: question.unclear, why: question.why, recommended: question.recommended, options: question.options.map(option => ({ id: option.id, label: option.label, consequence: option.consequence })) })),
  parked: review.waiting?.parkedAt !== undefined,
  submit: async (answers: ReadonlyArray<{ questionId: string; optionId?: string; text?: string }>) => { await api.answer(taskId, crypto.randomUUID(), answers);await reread(); },
  resume: async () => { await api.resume(taskId, crypto.randomUUID());await reread(); },
 };
 return <>{task !== undefined && <DesignActions task={task} sessionKey={key} />}{task !== undefined && <StoppedTaskActions task={task} sessionId={session.sessionId} />}<TaskPagePeopleAndComments taskId={taskId} />{feedbackWaiting && <p><Button onClick={panel.showFeedback}>Review PR feedback</Button></p>}<TaskDecisions taskId={taskId} design={design} questions={questions} /><PlanPanelHost taskId={taskId} /></>;
}
