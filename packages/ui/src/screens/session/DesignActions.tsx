import { useTaskAction } from "../../api/task-action.js";
import { useTaskPagePolicy } from "./task-page-policy.js";
import { TaskActionNotice } from "./TaskActionNotice.js";
import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { SessionIdSchema, skipRefusalText, type DesignActionsView } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createTaskSessionApi } from "../../api/sessions.js";
import { isCurrentSessionRead, readSessionIdentity } from "../../api/session-safety.js";
import { createDesignReviewApi } from "../../api/design-review.js";
import { ApiError } from "../../api/errors.js";
import { TaskDecisions } from "../home/NeedsYou.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { classificationLine, notNeededLine, readDesignActions, readDesignReview } from "./design-review-view.js";
import type { ReadSession } from "./SessionHeader.js";
import { workspaceTask, type ReadTask } from "./workspace-types.js";

/** What the task page says about design review for a task: the classification line, and the Design first and Skip actions the broker offered this person (`designActions`). Nothing shows for a task with neither. */
export function designActionsModel(task: ReadTask): { line: string | undefined; actions: DesignActionsView | undefined } {
 const workflow = task.workflow, review = readDesignReview(workflow?.designReview), actions = readDesignActions(task.designActions);
 const assessment = workflow?.intent?.assessment, design = assessment?.kind === "ready" ? assessment.design : undefined;
 const known = design === undefined ? undefined : { needed: design.needed, reasons: design.reasons.filter((reason): reason is Exclude<typeof reason, "unknown"> => reason !== "unknown") };
 const line = review === "unreadable" ? undefined : review !== undefined ? classificationLine(review) : known !== undefined && !known.needed ? notNeededLine(known) : undefined;
 return { line, actions };
}

// Both the strip and the plan-card action use the live API and the same durable
// claim. Re-read the served design actions before claiming, then check that
// exact read again inside the claim so an open confirmation cannot use stale consent.
function useDesignAction(taskId: string, sessionKey: readonly unknown[]) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createDesignReviewApi(host), [host]);
 const sessions = useMemo(() => createTaskSessionApi(host), [host]), action = useTaskAction(host, "design:" + taskId);
 return { ...action, async send(kind: "first" | "skip", shown: ReadTask) {
  let check: () => void = () => { throw new ApiError(403, "FORBIDDEN", "Read the current design actions before changing this task."); };
  return action.run(kind, { requestId: crypto.randomUUID() }, async body => {
   check();
   const answer = await (kind === "first" ? api.designFirst(taskId, body.requestId) : api.skip(taskId, body.requestId));
   if (answer.kind !== "done") throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet.");return answer;
  }, async () => {
   const person = await readSessionIdentity(host), id = SessionIdSchema.parse(sessionKey[1]);
   const current = await query.fetchQuery({ queryKey: [...sessionKey], queryFn: () => sessions.read(id), staleTime: 0, retry: false });
   const basis = query.getQueryState(sessionKey), task = workspaceTask(current), offered = readDesignActions(task?.designActions);
   check = () => {
    const latest = query.getQueryState(sessionKey);
    if (!isCurrentSessionRead(host, person, id) || latest !== basis || latest?.status !== "success" || latest.fetchStatus !== "idle" || latest.fetchFailureCount > 0 || task?.taskId !== taskId || task.status === "CLOSED" || task.workflow?.revision !== shown.workflow?.revision || !(kind === "first" ? offered?.designFirst === true : offered?.skip?.allowed === true)) throw new ApiError(403, "FORBIDDEN", "Design actions changed. Check the current task before trying again.");
   };
   check();
  });
 } };
}

/** The strip above the task's work: the line, the hint on a Quick plan, and the buttons. Each press asks the broker, which works out again whether this person may; a refusal is shown in its words. */
export function DesignActions({ task, sessionKey }: { task: ReadTask; sessionKey: readonly unknown[] }) {
 const query = useQueryClient(), page = useTaskPagePolicy();
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [message, setMessage] = useState<string>(), [confirmSkip, setConfirmSkip] = useState(false);
 const action = useDesignAction(task.taskId, sessionKey);
 const { line, actions } = designActionsModel(task);
 if (line === undefined && actions === undefined) return null;
 async function press(kind: "first" | "skip") {
  if (busy || action.locked) return;
  setBusy(true);setError(undefined);setMessage(undefined);
  try {
   const result = await action.send(kind, task);
   if (result.kind !== "done") throw new ApiError(409, "PENDING", "This is waiting for confirmation. Open the task to continue.");
   setConfirmSkip(false);setMessage(kind === "first" ? "Asked for design review first. Rovara reviews the design before it builds." : "Design review skipped.");
   await query.invalidateQueries({ queryKey: [...sessionKey] });
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't do that. Try again."); }
  finally { setBusy(false); }
 }
 const skip = actions?.skip;
 return <section className="rv-design-actions" aria-label="Design review actions">
  {line !== undefined && <p className="rv-design-line"><VisibleText text={line} /></p>}
  {actions?.hint === true && <p className="rv-design-hint" role="status">This may need design review.</p>}
  {skip !== undefined && !skip.allowed && <p className="rv-muted"><VisibleText text={skipRefusalText(skip, skip.approverName)} /></p>}
  <div className="rv-actions">
   {actions?.designFirst === true && <Button disabled={busy || action.locked} onClick={() => { void press("first"); }}>Design first</Button>}
   {skip?.allowed === true && !confirmSkip && <Button disabled={busy || action.locked} onClick={() => setConfirmSkip(true)}>Skip design review</Button>}
  </div>
  {confirmSkip && <div role="group" aria-label="Confirm skipping design review"><p>{page === undefined ? "Skip design review for this task? The design goes to a person without fresh-context reviewers reading it first." : "Skip design review for this task? A person will approve the design without Rovara's reviewers reading it first."}</p><div className="rv-actions">{page === undefined ? <><Button variant={page === undefined ? "primary" : "danger"} busy={busy} disabled={action.locked} onClick={() => { void press("skip"); }}>Skip design review</Button><Button variant={page === undefined ? "secondary" : "primary"} disabled={busy || action.locked} onClick={() => setConfirmSkip(false)}>Keep it</Button></> : <><Button variant={page === undefined ? "secondary" : "primary"} disabled={busy || action.locked} onClick={() => setConfirmSkip(false)}>Keep it</Button><Button variant={page === undefined ? "primary" : "danger"} busy={busy} disabled={action.locked} onClick={() => { void press("skip"); }}>Skip design review</Button></>}</div></div>}
  <TaskActionNotice key={action.pendingKey} pending={action.pending} recovery={action.recovery} taskHref={"/app/sessions/" + encodeURIComponent(task.taskId)} check={() => query.invalidateQueries({ queryKey: [...sessionKey] })} />
  {message !== undefined && <p role="status">{message}</p>}
  {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
 </section>;
}

/** The task's design-review state: its workspace task, the session key to refresh, and the Design first action for the plan card when the task view offers it (`designActions.designFirst`). */
export function useTaskDesign(session: ReadSession | undefined, taskId: string | undefined) {
 const query = useQueryClient(), task = useMemo(() => (session === undefined ? undefined : workspaceTask(session)), [session]);
 const key = ["session", session?.sessionId ?? ""] as const, action = useDesignAction(taskId ?? "unread", key);
 const actions = readDesignActions(task?.designActions), offered = taskId !== undefined && task !== undefined && actions?.designFirst === true;
 const design = offered && !action.locked ? { hint: actions?.hint === true, onDesignFirst: async () => {
  const result = await action.send("first", task);
  if (result.kind !== "done") throw new ApiError(409, "PENDING", "This is waiting for confirmation. Open the task to continue.");
  await query.invalidateQueries({ queryKey: [...key] });
 } } : undefined;
 return { task, key, design };
}

/** The task's decision cards, with the design review's line and buttons above them (the older task page; the task page now draws the cards in its pane). */
export function TaskDesignPanel({ session, taskId }: { session: ReadSession; taskId: string }) {
 const { task, key, design } = useTaskDesign(session, taskId);
 return <>{task !== undefined && <DesignActions task={task} sessionKey={key} />}<TaskDecisions taskId={taskId} design={design} /></>;
}
