import type { ReactNode } from "react";
import { STATUS_WORDS, type SessionViewReaderSchema } from "@agentx/contracts/web";
import { AvatarStack } from "../../design/AvatarStack.js";
import { Button } from "../../design/Button.js";
import { Money } from "../../design/Money.js";
import { TaskMoney } from "../../design/TaskMoney.js";
import { StatusChip } from "../../design/StatusChip.js";
import { StatusDot } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";
import { clockTime } from "./task-time.js";
import "../../design/parts/shell-gallery.css";
import "./talk.css";
import "./task-page.css";
export type ReadSession = ReturnType<typeof SessionViewReaderSchema.parse>;
export function statusWords(status: string): string {
 if (status in STATUS_WORDS) return STATUS_WORDS[status as keyof typeof STATUS_WORDS];
 return ({ starting: "Starting", running: "Running", succeeded: "Finished", failed: "Failed", cancelled: "Cancelled" } as Record<string, string>)[status] ?? "Status unavailable";
}
const CHIP_STATE: Record<string, "running" | "needs_you" | "setting_up" | "done" | "failed" | "stopped"> = { running: "running", failed: "failed", stopped: "stopped", waiting: "needs_you", needs_person: "needs_you", starting: "setting_up", succeeded: "done" };
/** Where the task runs, what it costs and who pays: secondary facts, kept out of the title block (the page shows them under "About this task"). */
export function SessionFacts({ session }: { session: ReadSession }) {
 const limit = session.money?.stop.taskMaximumMicros.state === "available" ? session.money.stop.taskMaximumMicros.value / 1_000_000 : undefined;
 return <div className="rv-session-facts rv-session-more-facts">{session.step && <span><VisibleText text={session.step} /></span>}<span>{session.where.kind === "cloud" ? "Cloud" : session.where.kind === "mac" ? <VisibleText text={"on " + session.where.label} /> : "Location unavailable"}</span>{session.where.kind === "mac" && session.where.offline && <span>offline</span>}<span><TaskMoney money={session.money} />{limit !== undefined && <> · Task limit <Money usd={limit} /></>}</span>{session.money?.payer.state === "available" && <span>Paid by <VisibleText text={session.money.payer.value.name} /></span>}</div>;
}
export function SessionHeader({ session, onAction, shareControl, controls, busy = false, facts = true, held, workHref = "/app/live", chipState }: { session: ReadSession; onAction: (action: "watch" | "share") => void; shareControl?: ReactNode; controls?: ReactNode; busy?: boolean; /** The secondary facts (place, cost, payer) stay in the header unless the page shows them elsewhere. */ facts?: boolean; held?: ReactNode; /** Where "Work" goes: the task's own place in the Work list. */ workHref?: string; /** The merge state, when the page reads one (Ready to merge, Merged), replaces the session status word. */ chipState?: "ready_to_merge" | "checking" | "merged" | "needs_you" | "running" | "stopped" | "blocked" | "waiting_for_merge" | "waiting_for_owner" }) {
 // Who owns the task, said to everyone who reads it (approved mock pr-feedback round 2): the owner, a People co-owner, or a reader.
 const ownership = session.you.owner ? "You own this task" : session.owner.name.trim() === "" ? undefined : session.owner.name + " owns this task" + (session.you.coOwner === true ? " · you are a co-owner" : "");
 const chip = chipState ?? (session.status === "needs_person" && session.body.kind === "task" && session.body.task.workflow?.state === "BLOCKED" ? "blocked" : CHIP_STATE[session.status]), updated = clockTime(session.updatedAt), closing = session.body.kind === "task" && session.body.task.closing === true;
 return <header className="rv-session-header rv-page-header" data-testid="session-header"><div className="rv-session-heading"><nav className="rv-page-breadcrumbs" aria-label="Breadcrumb"><ol><li><a href={workHref}>Work</a></li>{session.project && <li><VisibleText text={session.project} /></li>}</ol></nav>{facts && session.agent && <div className="rv-session-context"><span><VisibleText text={session.agent.name} /></span></div>}<h1 tabIndex={-1} data-testid="session-title"><VisibleText text={session.title} /></h1><div className="rv-session-facts rv-page-meta"><span className="rv-session-status" data-testid="session-status">{chip !== undefined ? <>{chip === "waiting_for_merge" ? <StatusChip state="waiting_for" waitingFor="merge" /> : chip === "waiting_for_owner" ? <StatusChip state="waiting_for" waitingFor={session.owner.name} /> : <StatusChip state={chip} />}<span className="rv-visually-hidden rv-session-status-text">{statusWords(session.status)}</span></> : <span className="rv-session-status-text"><StatusDot status={session.status} words={statusWords(session.status)} /></span>}</span>{(ownership !== undefined || updated !== undefined) && <span>{ownership !== undefined && <VisibleText text={ownership} />}{ownership !== undefined && updated !== undefined && " · "}{updated !== undefined && <>Updated <time dateTime={session.updatedAt}>{updated}</time></>}</span>}{closing && <span>Closing…</span>}{!facts && session.step && ["starting", "stopped", "paused", "cancelled", "failed"].includes(session.status) && <span><VisibleText text={session.step} /></span>}{held}</div>{facts && <SessionFacts session={session} />}</div><div className="rv-session-people"><AvatarStack people={session.viewingNow} />{controls ?? <div className="rv-actions">{session.you.actions.includes("watch") && <Button busy={busy} onClick={() => onAction("watch")}>{session.you.following ? "Following" : "Follow"}</Button>}{session.you.actions.includes("share") && (shareControl ?? <Button onClick={() => onAction("share")}>Share</Button>)}</div>}</div></header>;
}
