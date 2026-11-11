import { lazy, Suspense, useMemo, useRef, useState } from "react";
import { DeveloperTaskViewSchema, budgetPauseNext, budgetScopeName } from "@agentx/cloud-contracts/web";
import { useAppHost } from "../../host.js";
import { createSessionApi } from "../../api/sessions.js";
import { ApiError } from "../../api/errors.js";
import type { SendResult } from "../../api/client.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { Button } from "../../design/Button.js";
import { Banner } from "../../design/Banner.js";
import { Skeleton } from "../../design/Skeleton.js";
import { visibleText, VisibleText } from "../../design/VisibleText.js";
import { isConfirmUrl } from "../../text/links.js";
import type { ReadSession } from "./SessionHeader.js";
const Markdown = lazy(async () => ({ default: (await import("../../design/SafeMarkdown.js")).SafeMarkdown }));
export function MoneyBanners({ session }: { session: ReadSession }) {
 const host = useAppHost(), api = useMemo(() => createSessionApi(host), [host]);
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [message, setMessage] = useState<string>(), [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>(), inFlight = useRef(false);
 const parsed = session.body.kind === "task" ? DeveloperTaskViewSchema.safeParse(session.body.task) : undefined, task = parsed?.success ? parsed.data : undefined;
 // RULING Q30: a paused scope is display text, never a structured budget request target.
 function open(url: string | undefined) { return url !== undefined && isConfirmUrl(url, host.origin) ? <Button onClick={() => host.openExternal(url)}>Open</Button> : undefined; }
 async function continueTask() {
 if (task === undefined || !session.you.owner || inFlight.current || pending !== undefined) return;inFlight.current = true;setBusy(true);setError(undefined);
 try { const result = await api.continueTask(task.taskId);if (result.kind === "done") { if (result.value.task.sessionId !== undefined) host.navigate("/app/sessions/" + encodeURIComponent(result.value.task.sessionId));else setMessage("Task continued. Reload to see the latest update."); } else setPending(result); } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't continue this test. Try again."); } finally { inFlight.current = false;setBusy(false); }
 }
 return <div className="rv-session-banners">{session.approvals.map(approval => <Banner key={approval.approvalId} title={visibleText(approval.title)} tone="warning" action={open(approval.confirmUrl)} />)}{session.cost.paused && <Banner title="Paused: needs more budget" tone="warning" action={open(session.cost.paused.confirmUrl)}><p><VisibleText text={"It reached " + budgetScopeName(session.cost.paused.scope) + ". " + budgetPauseNext(session.cost.paused.scope, session.cost.paused.confirmUrl !== undefined, session.cost.paused.spendRequestId !== undefined)} /></p></Banner>}
 {task?.planningSoFar !== undefined && <section aria-label="Planning evidence"><p>Planning stopped at its limit. Here's what it found so far:</p><Suspense fallback={<Skeleton label="Loading planning evidence" />}><Markdown markdown={task.planningSoFar} /></Suspense></section>}
 {task?.testOffer !== undefined && <Banner title={`This test run reached its $${task.testOffer.capUsd.toFixed(2)} limit.`} tone="warning" action={session.you.owner ? <Button busy={busy} disabled={pending !== undefined} onClick={() => { void continueTask(); }}>Continue as a normal task</Button> : undefined} />}
 {error && <p role="alert"><VisibleText text={error} /></p>}{message && <p><VisibleText text={message} /></p>}{pending && <ConfirmInBrowser<ReadSession> result={pending} subjectKey={["session", session.sessionId]} isApplied={value => { const current = value.body.kind === "task" ? DeveloperTaskViewSchema.safeParse(value.body.task) : undefined;return current?.success === true && current.data.testOffer === undefined; }} />}
 </div>;
}
