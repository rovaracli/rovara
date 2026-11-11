import type { ReactNode } from "react";
import { STATUS_WORDS, TaskStatusReaderSchema, taskStatusFromSession, taskStatusText, type SessionViewReaderSchema } from "@agentx/contracts/web";
import { AvatarStack } from "../../design/AvatarStack.js";
import { Button } from "../../design/Button.js";
import { Money } from "../../design/Money.js";
import { StatusDot } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";
export type ReadSession = ReturnType<typeof SessionViewReaderSchema.parse>;
export function statusWords(status: string): string {
 if (status in STATUS_WORDS) return STATUS_WORDS[status as keyof typeof STATUS_WORDS];
 return ({ starting: "Starting", running: "Running", succeeded: "Finished", failed: "Failed", cancelled: "Cancelled" } as Record<string, string>)[status] ?? "Status unavailable";
}
/** A task its owner closed reads "Closed" here, in the pipeline and in the actions alike (QA6-07), whatever its last step ended as. */
export function isClosedTask(session: ReadSession): boolean {
 return session.body.kind === "task" && (session.body.task as { status?: unknown }).status === "CLOSED";
}
/** UX2 slice 2: where the work stands in the one status model, for this reader: the words, the next step, and the state. A server from before the model is read through the same words. */
export function sessionDisplay(session: ReadSession): { state: string; text: string; next?: string | undefined } {
 const parsed = TaskStatusReaderSchema.safeParse((session as { display?: unknown }).display);
 const status = parsed.success ? parsed.data : taskStatusFromSession({ status: session.status, ...(session.lastRunFailed === true ? { lastRunFailed: true as const } : {}) }, isClosedTask(session));
 return { state: status.state, text: taskStatusText(status), next: typeof status.next === "string" && status.next !== "" ? status.next : undefined };
}
type HeaderProps = { session: ReadSession; onAction: (action: "watch" | "share") => void; shareControl?: ReactNode; controls?: ReactNode; busy?: boolean };
/** Where it runs, what it cost and who pays, with the viewers and the controls. `plain` leaves the status dot out (the lead block says the state in plain words). */
function Facts({ session, display, plain }: { session: ReadSession; display: ReturnType<typeof sessionDisplay>; plain: boolean }) {
 return <div className="rv-session-facts">{!plain && <StatusDot status={session.status} words={display.text} />}{session.body.kind === "task" && session.body.task.closing === true && <span>Closing…</span>}{session.step && display.state !== "needs_you" && display.state !== "failed" && <span><VisibleText text={session.step} /></span>}<span>{session.where.kind === "cloud" ? "Cloud" : session.where.kind === "mac" ? <VisibleText text={"on " + session.where.label} /> : "Location unavailable"}</span>{session.where.kind === "mac" && session.where.offline && <span>offline</span>}<span><Money usd={session.cost.spentUsd} />{session.cost.runLimitUsd !== undefined && <> of <Money usd={session.cost.runLimitUsd} /></>}</span><span>Paid by <VisibleText text={session.cost.payer.name} /></span></div>;
}
function People({ session, onAction, shareControl, controls, busy = false }: HeaderProps) {
 return <div className="rv-session-people"><AvatarStack people={session.viewingNow} />{controls ?? <div className="rv-actions">{session.you.actions.includes("watch") && <Button busy={busy} onClick={() => onAction("watch")}>{session.you.following ? "Following" : "Follow"}</Button>}{session.you.actions.includes("share") && (shareControl ?? <Button onClick={() => onAction("share")}>Share</Button>)}</div>}</div>;
}
/** The facts and the controls of a task on their own, for the phone order (the decision comes first, these follow it). */
export function SessionDetails(props: HeaderProps) {
 return <div className="rv-session-details"><Facts session={props.session} display={sessionDisplay(props.session)} plain /><People {...props} /></div>;
}
/**
 * `lead` (experience lane, `leadingHeader`): the block that says the plain state, next step, who and why. It replaces the old "Next:" line and the status dot; `detailsBelow` leaves
 * the facts and controls out of the header (the phone order puts them after the decision).
 */
export function SessionHeader({ session, onAction, shareControl, controls, busy = false, lead, detailsBelow = false }: HeaderProps & { lead?: ReactNode; detailsBelow?: boolean }) {
 const display = sessionDisplay(session);
 return <header className="rv-session-header"><div className="rv-session-context">{session.agent && <span><VisibleText text={session.agent.name} /></span>}{session.project && <span><VisibleText text={session.project} /></span>}</div><h1 tabIndex={-1}><VisibleText text={session.title} /></h1>{lead}{!detailsBelow && <Facts session={session} display={display} plain={lead !== undefined} />}{lead === undefined && display.next !== undefined && <p className="rv-session-next" aria-label="Next step"><strong>Next:</strong> <VisibleText text={display.next} /></p>}{!detailsBelow && <People session={session} onAction={onAction} shareControl={shareControl} controls={controls} busy={busy} />}</header>;
}
