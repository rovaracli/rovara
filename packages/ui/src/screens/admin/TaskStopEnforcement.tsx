// Lazy owner flow: freshness first, then review, ready and explicit enable.
import { useEffect, useMemo, useState } from "react";
import { formatUsdMicrodollars, type TaskStopReview } from "@agentx/cloud-contracts/web";
import { createTaskStopEnrollmentApi } from "../../api/task-stop-enrollment.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
const outcomes = { refuse_next_admission: "Refused at next admission", new_window_at_stop: "New window at this stop from current spend", retain_current_window: "Current window retained until next admission; then a new window at this stop", exempt: "Verified own-source exemption; customer limits still apply" };
export function TaskStopEnforcement({ orgId, checking }: { orgId: string; checking: boolean }) {
 const host = useAppHost(), api = useMemo(() => createTaskStopEnrollmentApi(host, orgId), [host, orgId]);
 const [context, setContext] = useState<Awaited<ReturnType<typeof api.get>>>(), [review, setReview] = useState<TaskStopReview>(), [busy, setBusy] = useState(true);
 const [error, setError] = useState<{ text: string; signIn: boolean }>(), [message, setMessage] = useState("");
 function failure(caught: unknown) { setReview(undefined);setError({ text: caught instanceof ApiError ? caught.message : "Could not verify enforcement. Reload the review before trying again.", signIn: caught instanceof ApiError && caught.code === "REAUTH_REQUIRED" }); }
 useEffect(() => {
  let live = true;api.setScopeActive(true);
  void (async () => {
   try { const value = await api.get();if (!live) return;setContext(value);if (value.state !== "enabled") { const captured = await api.review(value.revision);if (live) setReview(captured); } }
   catch (caught) { if (live) { setError({ text: caught instanceof ApiError ? caught.message : "Could not verify enforcement. Reload the review before trying again.", signIn: caught instanceof ApiError && caught.code === "REAUTH_REQUIRED" }); } }
   finally { if (live) setBusy(false); }
  })();
  return () => { live = false;api.setScopeActive(false); };
 }, [api]);
 async function reload() {
  if (busy || checking) return;setBusy(true);setError(undefined);setReview(undefined);
  try { const value = await api.get();setContext(value);if (value.state !== "enabled") setReview(await api.review(value.revision)); }
  catch (caught) { failure(caught); }finally { setBusy(false); }
 }
 async function change(state: "disabled" | "ready" | "enabled") {
  if (busy || checking || context === undefined || state !== "disabled" && review === undefined) return;
  setBusy(true);setError(undefined);setMessage("");
  try {
   const result = await api.transition({ requestId: crypto.randomUUID(), expectedRevision: context.revision, state,
    ...(state === "disabled" ? {} : { reviewId: review!.reviewId, expectedReviewDigest: review!.digest }) });
   setContext({ orgId, state: result.state, revision: result.revision });setReview(undefined);
   if (result.state === "ready") setReview(await api.review(result.revision));
   setMessage(result.state === "enabled" ? "Enforcement is enabled." : result.state === "disabled" ? "Enforcement is disabled. Existing admitted windows keep their captured limits." : "Review confirmed. Enforcement is still off until you enable it.");
  } catch (caught) { failure(caught); }finally { setBusy(false); }
 }
 const locked = busy || checking;
 return <section className="rv-admin-section" aria-busy={locked} aria-label="Company enforcement">
  <h3>Company enforcement</h3><p>Only a company owner can change enforcement. Turning it off requires a recent sign-in.</p>
  {busy && <p role="status">Checking enforcement...</p>}{message && <p role="status">{message}</p>}
  {error !== undefined && <p role="alert"><VisibleText text={error.text} />{error.signIn && <> <Button disabled={locked} onClick={() => { host.signIn(host.currentPath()); }}>Sign in again</Button></>}</p>}
  {context !== undefined && <p>Current enforcement: {context.state}. Revision {context.revision}.</p>}
  {review !== undefined && <><h4>Review enforcement impacts</h4><p>As of {new Date(review.capturedAt).toLocaleString("en-US", { timeZone: "UTC" })} UTC. Work can start or finish after this preview.</p>
   <p>Running tasks keep their existing window and customer limits until their next admission. Enabling adds company stops to future admissions. This preview does not stop any task.</p>
   <p>{review.counts.refuse_next_admission} refused; {review.counts.new_window_at_stop} new windows; {review.counts.retain_current_window} running windows retained; {review.counts.exempt} exempt.</p>{review.truncated && <p>Showing the first 25 impacts, refusals first. Counts include all reviewed tasks.</p>}
   {review.tasks.length === 0 ? <p>No active tasks were visible at review time.</p> : <table className="rv-table"><caption>Tasks in this review</caption><thead><tr><th>Task</th><th>Project</th><th>Phase</th><th>Effective stop</th><th>Impact</th></tr></thead><tbody>{review.tasks.map(task => <tr key={task.taskId}><td data-label="Task">{task.taskId}</td><td data-label="Project"><VisibleText text={task.project} /></td><td data-label="Phase">{task.phase}</td><td data-label="Effective stop">{formatUsdMicrodollars(task.effectiveStopMicrousd)}</td><td data-label="Impact">{outcomes[task.outcome]}</td></tr>)}</tbody></table>}
   {context?.state === "disabled" && <Button disabled={locked} onClick={() => { void change("ready"); }}>Confirm review and mark ready</Button>}
   {context?.state === "ready" && <Button disabled={locked} onClick={() => { void change("enabled"); }}>Enable enforcement</Button>}
  </>}
  {context?.state === "enabled" && <><p>Future admissions use company enforcement. Already admitted windows remain bounded by their captured limits.</p><Button disabled={locked} onClick={() => { void change("disabled"); }}>Turn off enforcement</Button></>}
  {context?.state === "ready" && <Button disabled={locked} onClick={() => { void change("disabled"); }}>Cancel enforcement setup</Button>}
  <Button disabled={locked} onClick={() => { void reload(); }}>Reload enforcement review</Button>
 </section>;
}
