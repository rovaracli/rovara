import { useEffect, useRef } from "react";
import { TaskPane } from "./TaskPane.js";
import { paths } from "../../paths.js";
import type { WorkRow } from "../../api/work-read.js";
import { TaskMoney } from "../../design/TaskMoney.js";
import { VisibleText } from "../../design/VisibleText.js";
import { QuietCard } from "./work-read-cards.js";
import { QueuePeek, updatedWords } from "./queue-preview.js";
import { WorkRowStatus } from "./WorkRowStatus.js";

const HEADINGS: Record<string, string> = { answer_question: "Question for you", choose_checks: "A check failed twice", approve_spend: "Spend request" };
/**
 * The short peek of board 2c: project and when it was read, the title and its status, the one step (the decision asked, or why nothing is asked) and Open task.
 * The task's evidence, plan and cost stay on the task page; the live decision and spec handlers act here when the latest reads are current.
 */
export function WorkPeek({ row, decisionsError, now, back, onDecided, current = false }: { onDecided: (id: string) => void; current?: boolean; row: WorkRow; decisionsError: unknown; now: number; back: () => void }) {
 const title = useRef<HTMLHeadingElement | null>(null), page = paths.session(row.task.sessionId ?? row.id);
 // On a phone the full-width view opens with focus on its title; the desktop peek never takes focus from the list.
 useEffect(() => { if (window.innerWidth < 1024) title.current?.focus(); }, [row.id]);
 const decision = row.decision !== undefined && decisionsError === undefined ? row.decision.card : undefined;
 return <QueuePeek label="Selected task" backLabel="Back to Work" onBack={back} project={row.project} updated={updatedWords(row.updatedAt, now)} title={row.title} titleTestId="pane-title" titleRef={element => { title.current = element; }}
  status={<WorkRowStatus row={row} />} openTo={page} openLabel="Open task" footnote="Back returns you to this row in Work.">
  {(!current || decision === undefined) && (decision !== undefined ? <section className="rv-qp-step" aria-label={HEADINGS[decision.kind] ?? "Your decision"} data-testid="peek-decision"><h3>{HEADINGS[decision.kind] ?? "Your decision"}</h3><p><VisibleText text={decision.question} /></p><p className="rv-qp-step-next"><VisibleText text={decision.next.text} /></p></section> : <QuietCard row={row} decisionsError={decisionsError} />)}
  {<fieldset disabled={!current} className="rv-qp-action-fields"><TaskPane compact readOnly={!current} row={row} decisionsError={decisionsError} onDecided={onDecided} /></fieldset>}
  {row.task.money !== undefined && <p className="rv-qp-money"><TaskMoney money={row.task.money} /></p>}
 </QueuePeek>;
}
