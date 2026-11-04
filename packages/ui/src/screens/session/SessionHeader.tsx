import type { ReactNode } from "react";
import { STATUS_WORDS, type SessionViewReaderSchema } from "@agentx/contracts/web";
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
export function SessionHeader({ session, onAction, shareControl, controls, busy = false }: { session: ReadSession; onAction: (action: "watch" | "share") => void; shareControl?: ReactNode; controls?: ReactNode; busy?: boolean }) {
 return <header className="rv-session-header"><div className="rv-session-context">{session.agent && <span><VisibleText text={session.agent.name} /></span>}{session.project && <span><VisibleText text={session.project} /></span>}</div><h1 tabIndex={-1}><VisibleText text={session.title} /></h1><div className="rv-session-facts"><StatusDot status={session.status} words={statusWords(session.status)} />{session.body.kind === "task" && session.body.task.closing === true && <span>Closing…</span>}{session.step && <span><VisibleText text={session.step} /></span>}<span>{session.where.kind === "cloud" ? "Cloud" : session.where.kind === "mac" ? <VisibleText text={"on " + session.where.label} /> : "Location unavailable"}</span>{session.where.kind === "mac" && session.where.offline && <span>offline</span>}<span><Money usd={session.cost.spentUsd} />{session.cost.runLimitUsd !== undefined && <> of <Money usd={session.cost.runLimitUsd} /></>}</span><span>Paid by <VisibleText text={session.cost.payer.name} /></span></div><div className="rv-session-people"><AvatarStack people={session.viewingNow} />{controls ?? <div className="rv-actions">{session.you.actions.includes("watch") && <Button busy={busy} onClick={() => onAction("watch")}>{session.you.following ? "Following" : "Follow"}</Button>}{session.you.actions.includes("share") && (shareControl ?? <Button onClick={() => onAction("share")}>Share</Button>)}</div>}</div></header>;
}
