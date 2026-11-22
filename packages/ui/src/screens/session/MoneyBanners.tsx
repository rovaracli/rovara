import { useTaskPagePolicy } from "./task-page-policy.js";
import { runTaskAction } from "../../api/task-action.js";
import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { DeveloperTaskViewSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createTaskSessionApi } from "../../api/sessions.js";
import { ApiError } from "../../api/errors.js";
import { useQueryClient } from "@tanstack/react-query";
import { useSessionIdentity, useSessionRequest, readSessionIdentity, assertSessionIdentity, type FrozenSessionRequest, clearSessionRequest, isSessionCsrf, isFinalSessionRefusal, sessionScope } from "../../api/session-safety.js";
import { Button } from "../../design/Button.js";
import { Banner } from "../../design/Banner.js";
import { Skeleton } from "../../design/Skeleton.js";
import { visibleText, VisibleText } from "../../design/VisibleText.js";
import { TaskBudgetPauseView } from "./TaskBudgetPauseView.js";
import { isConfirmUrl } from "../../text/links.js";
import type { ReadSession } from "./SessionHeader.js";
const Markdown = lazy(async () => ({ default: (await import("../../design/SafeMarkdown.js")).SafeMarkdown }));
export function MoneyBanners({ session }: { session: ReadSession }) {
 const page = useTaskPagePolicy();
 const host = useAppHost(), query = useQueryClient(), identity = useSessionIdentity(host), saved = useSessionRequest(host, identity.data, "normal-task:" + session.sessionId), api = useMemo(() => createTaskSessionApi(host), [host]);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [message, setMessage] = useState<string>(), inFlight = useRef(false);
 const parsed = session.body.kind === "task" ? DeveloperTaskViewSchema.safeParse(session.body.task) : undefined, task = parsed?.success ? parsed.data : undefined;
 // RULING Q30: a paused scope is display text, never a structured budget request target.
 function open(url: string | undefined) { return url !== undefined && isConfirmUrl(url, host.origin) ? <Button onClick={() => host.openExternal(url)}>Open</Button> : undefined; }
 async function check() {
  try {
   const current = await api.read(session.sessionId);query.setQueryData(["session", session.sessionId], current);
   if (identity.data === undefined || saved.scope === undefined || saved.request === undefined) return;assertSessionIdentity(host, identity.data);
   if (current.body.kind === "task" && current.body.task.testOffer === undefined) { clearSessionRequest(host, saved.scope, saved.request.requestId);setMessage("Rovara now reads this as a normal task."); }
  } catch { setError("Couldn't check this task. The continuation is still unconfirmed."); }
 }
 async function continueTask() {
  if (page !== undefined || task === undefined || !session.you.owner || inFlight.current || identity.data === undefined || saved.scope === undefined || saved.request !== undefined || saved.storageError !== undefined || saved.failure !== undefined) return;
  inFlight.current = true;setBusy(true);setError(undefined);let frozen: FrozenSessionRequest | undefined;
  try {
   await readSessionIdentity(host);assertSessionIdentity(host, identity.data);const latest = await api.read(session.sessionId);
   if (!latest.you.owner || latest.body.kind !== "task" || latest.body.task.testOffer === undefined) throw new ApiError(403, "FORBIDDEN", "Continuing this test is no longer available.");
   // Keep the operation lock separate while advancing this session's shared read fence.
   const result = await runTaskAction(host, saved.scope, "continue-as-task", { requestId: crypto.randomUUID(), taskId: task.taskId }, async request => {
    frozen = request;assertSessionIdentity(host, identity.data!);
    const answer = await api.continueTask(task.taskId, request.requestId);
    if (answer.kind !== "done") throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet.");
    assertSessionIdentity(host, identity.data!);return answer;
   }, sessionScope(identity.data, session.sessionId));
   if (result.kind === "done") { assertSessionIdentity(host, identity.data);if (result.value.task.sessionId !== undefined) host.navigate("/s/" + encodeURIComponent(result.value.task.sessionId));else setMessage("Rovara returned a normal task. Reload to see its current state."); }
  } catch (failure) {
      if (isSessionCsrf(failure)) { setError("Couldn't change that. Nothing was sent. Rovara is checking your identity.");await readSessionIdentity(host).catch(() => undefined); }
   else if (frozen === undefined || isFinalSessionRefusal(failure)) setError(failure instanceof ApiError ? failure.message : "Couldn't continue this test.");
  } finally { inFlight.current = false;setBusy(false); }
 }

 return <div className="rv-session-banners">{session.approvals.map(approval => <Banner key={approval.approvalId} title={visibleText(approval.title)} tone="warning" action={open(approval.confirmUrl)} />)}{session.cost.paused && <><TaskBudgetPauseView read="current" evidence={{ kind: "generic_pause", detail: "The current task read reports a budget pause. It does not name a monthly-limit refusal." }} /><p>Budget check: <VisibleText text={session.cost.paused.scope} /> needs more budget.</p>{open(session.cost.paused.confirmUrl)}</>}
 {task?.planningSoFar !== undefined && <section aria-label="Planning evidence"><p>Planning stopped at its limit. Here's what it found so far:</p><Suspense fallback={<Skeleton label="Loading planning evidence" />}><Markdown markdown={task.planningSoFar} /></Suspense></section>}
 {task?.testOffer !== undefined && <><TaskBudgetPauseView read="current" evidence={{ kind: "test_cap" }} /><p>This test run reached its ${task.testOffer.capUsd.toFixed(2)} limit.</p>{page === undefined && session.you.owner && <Button busy={busy} disabled={identity.data === undefined || saved.request !== undefined || saved.storageError !== undefined || saved.failure !== undefined} onClick={() => { void continueTask(); }}>Continue as a normal task</Button>}</>}
 {error && <p role="alert"><VisibleText text={error} /></p>}{message && <p><VisibleText text={message} /></p>}{saved.request !== undefined && <p role="status">Rovara didn't confirm this yet. Check whether this is now a normal task. <Button onClick={() => { void check(); }}>Check</Button></p>}{saved.storageError && <p role="alert">{saved.storageError}</p>}
 </div>;
}
