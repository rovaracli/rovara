import { useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { SESSION_LOG_SURFACE_WORDS, type SessionLogEntry } from "@agentx/contracts/web";
import { ApiError } from "../../api/errors.js";
import { createSessionLogApi } from "../../api/session-log.js";
import { useAppHost } from "../../host.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";

/** The lines shown before "Show all": the page says it once, in a short list; the rest is one click away. */
export const DECISIONS_SHOWN = 5;
const WHAT = { plan: "the plan", requirements: "the requirements", design: "the design", pull_request: "the pull request" } as const;
const OUTCOME_WORDS = { approved: (what: string) => `${what} was approved.`, changes_requested: (what: string) => `Changes were requested on ${what}.`, rejected: (what: string) => `${what} was rejected.` } as const;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"] as const;
/** "Nov 17, 14:10 UTC": a stable reading, whatever the viewer's time zone. */
export function whenWords(at: string): string {
 const date = new Date(at), two = (n: number) => String(n).padStart(2, "0");
 return `${MONTHS[date.getUTCMonth()] ?? ""} ${String(date.getUTCDate())}, ${two(date.getUTCHours())}:${two(date.getUTCMinutes())} UTC`;
}

type Decision = Extract<SessionLogEntry, { kind: "answer" | "approval" }>;
const isDecision = (entry: SessionLogEntry): entry is Decision => entry.kind === "answer" || entry.kind === "approval";

/** What each decision or answer says, with its question: one line of text and one of who, where and when. */
export function decisionRows(entries: readonly SessionLogEntry[]): Array<{ key: string; main: string; who: string }> {
 return entries.filter(isDecision).map(entry => {
  const who = `${entry.by}, ${SESSION_LOG_SURFACE_WORDS[entry.surface]}, ${whenWords(entry.at)}`;
  if (entry.kind === "approval") { const what = WHAT[entry.what]; return { key: entry.key, main: OUTCOME_WORDS[entry.outcome](entry.outcome === "changes_requested" ? what : what.charAt(0).toUpperCase() + what.slice(1)), who }; }
  const question = entries.find((candidate): candidate is Extract<SessionLogEntry, { kind: "question" }> => candidate.kind === "question" && candidate.round === entry.round && candidate.questionId === entry.questionId);
  return { key: entry.key, main: `${question === undefined ? "A question" : question.text} ${entry.text}`, who };
 });
}

/**
 * "Decisions and answers" (L4-B5): what was asked and decided on this task, wherever it was answered (this page, Slack, Linear, Jira), as the task log says it. A short list with the newest first, the rest one click away.
 * Nothing is shown for a task with no answers or decisions yet, or when Code's log can't be read here; the page does not break for it.
 */
export function DecisionsCard({ id }: { id: string }) {
 const host = useAppHost(), api = useMemo(() => createSessionLogApi(host), [host]), [all, setAll] = useState(false);
 const read = useQuery({ queryKey: ["session", id, "log"], queryFn: () => api.read(id), retry: false });
 if (read.isPending) return null;
 if (read.isError) {
  // A task Code can't show a log for (not served here, or not readable by this person) shows nothing; any other failure says so, calmly, with a way to try again.
  if (read.error instanceof ApiError && (read.error.status === 404 || read.error.status === 501)) return null;
  return <section className="rv-card rv-decisions" aria-label="Decisions and answers" data-testid="decisions-error"><h4>Decisions and answers</h4><p className="rv-muted">Couldn't load the decisions and answers.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
 }
 const rows = decisionRows(read.data.entries).reverse();
 if (rows.length === 0) return null;
 const shown = all ? rows : rows.slice(0, DECISIONS_SHOWN);
 return <section className="rv-card rv-decisions" aria-label="Decisions and answers" data-testid="decisions">
  <h4>Decisions and answers</h4>
  <ul className="rv-decisions-list">{shown.map(row => <li key={row.key}><span><VisibleText text={row.main} /></span><small className="rv-muted"><VisibleText text={row.who} /></small></li>)}</ul>
  {rows.length > DECISIONS_SHOWN && <Button variant="quiet" onClick={() => { setAll(value => !value); }} aria-expanded={all}>{all ? "Show fewer" : `Show all ${String(rows.length)}`}</Button>}
 </section>;
}
