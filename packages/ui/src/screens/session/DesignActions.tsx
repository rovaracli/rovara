import { useMemo, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { skipRefusalText, type DesignActionsView } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
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

/** The strip above the task's work: the line, the hint on a Quick plan, and the buttons. Each press asks the broker, which works out again whether this person may; a refusal is shown in its words. */
export function DesignActions({ task, sessionKey }: { task: ReadTask; sessionKey: readonly unknown[] }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createDesignReviewApi(host), [host]);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [message, setMessage] = useState<string>(), [confirmSkip, setConfirmSkip] = useState(false);
 const { line, actions } = designActionsModel(task);
 if (line === undefined && actions === undefined) return null;
 async function press(kind: "first" | "skip") {
  if (busy) return;
  setBusy(true);setError(undefined);setMessage(undefined);
  try {
   const result = await (kind === "first" ? api.designFirst(task.taskId, crypto.randomUUID()) : api.skip(task.taskId, crypto.randomUUID()));
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
   {actions?.designFirst === true && <Button disabled={busy} onClick={() => { void press("first"); }}>Design first</Button>}
   {skip?.allowed === true && !confirmSkip && <Button disabled={busy} onClick={() => setConfirmSkip(true)}>Skip design review</Button>}
  </div>
  {confirmSkip && <div role="group" aria-label="Confirm skipping design review"><p>Skip design review for this task? The design goes to a person without fresh-context reviewers reading it first.</p><div className="rv-actions"><Button variant="primary" busy={busy} onClick={() => { void press("skip"); }}>Skip design review</Button><Button disabled={busy} onClick={() => setConfirmSkip(false)}>Keep it</Button></div></div>}
  {message !== undefined && <p role="status">{message}</p>}
  {error !== undefined && <p role="alert"><VisibleText text={error} /></p>}
 </section>;
}

/** The task's decision cards, with the design review's line and buttons above them. A task view without `designActions` or a design review is exactly the cards, as before. */
export function TaskDesignPanel({ session, taskId }: { session: ReadSession; taskId: string }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createDesignReviewApi(host), [host]), task = useMemo(() => workspaceTask(session), [session]);
 const key = ["session", session.sessionId] as const, actions = readDesignActions(task?.designActions), offered = actions?.designFirst === true;
 const design = offered ? { hint: actions?.hint === true, onDesignFirst: async () => {
  const result = await api.designFirst(taskId, crypto.randomUUID());
  if (result.kind !== "done") throw new ApiError(409, "PENDING", "This is waiting for confirmation. Open the task to continue.");
  await query.invalidateQueries({ queryKey: [...key] });
 } } : undefined;
 return <>{task !== undefined && <DesignActions task={task} sessionKey={key} />}<TaskDecisions taskId={taskId} design={design} /></>;
}
