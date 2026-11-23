import { viewerTime } from "../../design/viewer-time.js";
import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SESSION_LOG_SURFACE_WORDS, type SessionLogEntry } from "@agentx/contracts/web";
import { ApiError } from "../../api/errors.js";
import { createSessionLogApi } from "../../api/session-log.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { TaskDecisionsReadRecoveryView } from "./TaskDecisionsReadRecoveryView.js";
import { TaskDecisionsUnavailableView } from "./TaskDecisionsUnavailableView.js";

/** The lines shown before "Show all": the page says it once, in a short list; the rest is one click away. */
export const DECISIONS_SHOWN = 5;
const WHAT = { plan: "the plan", requirements: "the requirements", design: "the design", pull_request: "the pull request" } as const;
const OUTCOME_WORDS = { approved: "approved", changes_requested: "changes requested", rejected: "rejected" } as const;
/** A recorded decision in the viewer's local date and time. */
export function whenWords(at: string): string {
 return viewerTime(at, { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit", hour12: false });
}

/** "Nov 17, 14:10": the viewer's own clock, with no zone name (the task page reads every time this way). */
export function localWhenWords(at: string): string {
 const date = new Date(at);
 if (Number.isNaN(date.getTime())) return at;
 return whenWords(at);
}

type Decision = Extract<SessionLogEntry, { kind: "answer" | "approval" }>;
const isDecision = (entry: SessionLogEntry): entry is Decision => entry.kind === "answer" || entry.kind === "approval";

/** What each decision or answer says, with its question: one line of text and one of who, where and when. */
export function decisionRows(entries: readonly SessionLogEntry[], local = false): Array<{ key: string; main: string; who: string }> {
 return entries.filter(isDecision).map(entry => {
  const who = `${entry.by}, ${SESSION_LOG_SURFACE_WORDS[entry.surface]}, ${local ? localWhenWords(entry.at) : whenWords(entry.at)}`;
  if (entry.kind === "approval") return { key: entry.key, main: `Decision: ${WHAT[entry.what]}, ${OUTCOME_WORDS[entry.outcome]}.`, who };
  const question = entries.find((candidate): candidate is Extract<SessionLogEntry, { kind: "question" }> => candidate.kind === "question" && candidate.round === entry.round && candidate.questionId === entry.questionId);
  return { key: entry.key, main: question === undefined ? `A question was answered: ${entry.text}` : `${question.text} Answer: ${entry.text}`, who };
 });
}

/**
 * "Decisions and answers" (L4-B5): what was asked and decided on this task, wherever it was answered (this page, Slack, Linear, Jira), as the task log says it. A short list with the newest first, the rest one click away.
 * Nothing is shown for a task with no answers or decisions yet, or when Code's log can't be read here; the page does not break for it.
 */
export function DecisionsCard({ id, local = false }: { id: string; /** Retained for task-page callers; both paths use the viewer's local clock. */ local?: boolean }) {
 const host = useAppHost(), api = useMemo(() => createSessionLogApi(host), [host]), [all, setAll] = useState(false);
 const read = useQuery({ queryKey: ["session", id, "log"], queryFn: () => api.read(id), retry: false });
 if (read.isPending) return null;
 if (read.isError) {
  const unavailable = read.error instanceof ApiError && ((read.error.status === 501 && read.error.code === "NOT_ON_CODE_YET") || (read.error.status === 404 && read.error.code === "NOT_FOUND" && read.error.message === "route not found"));
  if (unavailable) return <section className="rv-card rv-decisions" aria-label="Decisions and answers"><h3>Decisions and answers</h3><TaskDecisionsUnavailableView /></section>;
  return <TaskDecisionsReadRecoveryView onRetry={() => { void read.refetch(); }} />;
 }
 const rows = decisionRows(read.data.entries, local).reverse();
 if (rows.length === 0) return null;
 const shown = all ? rows : rows.slice(0, DECISIONS_SHOWN);
 return <section className="rv-card rv-decisions" aria-label="Decisions and answers" data-testid="decisions">
  <h3>Decisions and answers</h3>
  <ul className="rv-decisions-list">{shown.map(row => <li key={row.key}><span><VisibleText text={row.main} /></span><small className="rv-muted"><VisibleText text={row.who} /></small></li>)}</ul>
  {rows.length > DECISIONS_SHOWN && <Button variant="quiet" onClick={() => { setAll(value => !value); }} >{all ? "Show fewer" : `Show all ${String(rows.length)}`}</Button>}
 </section>;
}
