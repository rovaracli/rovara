import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { closesHeldText, lessonFileWaitingText, strayBranchesText, unreachableRepoText, type LessonsRepoFileBody } from "@agentx/contracts/web";
import { ApiError } from "../../../api/errors.js";
import { lessonsRepoFileKey, useLessonsRepoFile, useLessonsRepoFileApi, type LessonsRepoFileStatus } from "../../../api/lessons-repo-file.js";
import { Button } from "../../../design/Button.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { safeExternalUrl } from "../../../text/links.js";

const W = {
 TITLE: "Lessons file in the repo", WHY: "Rovara proposes the lessons your own reviews and commits taught, in .rovara/lessons.md, through one pull request a week. Only you merge it. Merged lessons stay in git history.",
 LOADING: "Loading", FAILED: "Couldn't read this setting. Try again.", TRY_AGAIN: "Try again", OFF: "Lessons are off for this project, so no pull request is opened until they are switched on.",
 NONE: "No repository has the lessons file switched on.", TURN_ON: "Turn on", TURN_OFF: "Turn off", RESUME: "Resume", POINTER_ADD: "Add the pointer back", POINTER_DECLINE: "Don't ask again", OPEN_PR: "Open the pull request",
 ON: "On", OFF_STATE: "Off", NO_PR: "No pull request is open.", CHANGE_FAILED: "Couldn't change that. Try again.", NOT_ALLOWED: "A maintainer of this project can change this.", AVAILABLE: "Can be switched on",
 RETIRE: "Retire them", KEEP: "Keep them", RETIRE_CARD: "Lessons missing from the file", STALE: "This changed while you were looking at it. Reload and try again.", DECIDERS: "Only the company owner or a person who can approve this project's lessons can decide this.",
} as const;

type Row = LessonsRepoFileStatus["repos"][number];
const isRetire = (body: LessonsRepoFileBody): boolean => body.action === "retire_confirm" || body.action === "retire_keep";
const failure = (error: unknown, body: LessonsRepoFileBody): string => error instanceof ApiError && error.code === "FORBIDDEN" ? (isRetire(body) ? W.DECIDERS : W.NOT_ALLOWED) : error instanceof ApiError && error.code === "CHANGE_STALE" ? W.STALE : W.CHANGE_FAILED;

/**
 * The lessons file of each repository (Cloud's rows; Code shows the same lines through `agentx project lessons-repo`). Every sentence is fixed wording from the server, shown as text. A maintainer switches a repository on or off,
 * resumes it after the team deleted the file, and answers a missing pointer. Nothing is written to the repository from here: the first pull request is opened by the next nightly pass, and a person merges it.
 */
export function RepoFileControl({ project, canChange }: { project: string; canChange: boolean }) {
 const read = useLessonsRepoFile(project), api = useLessonsRepoFileApi(), query = useQueryClient();
 const [busy, setBusy] = useState<string>(), [error, setError] = useState<string>();
 if (read.isPending) return <p className="rv-muted" role="status">{W.LOADING}</p>;
 // An installation without the lessons file has no such route: the section is simply not there.
 if (read.error instanceof ApiError && read.error.code === "NOT_FOUND") return null;
 if (read.isError || read.data === undefined) return <section className="rv-lessons-repo" aria-label={W.TITLE}><h2>{W.TITLE}</h2><p role="alert">{W.FAILED}</p><Button onClick={() => { void read.refetch(); }}>{W.TRY_AGAIN}</Button></section>;
 const status = read.data;
 if (status.repos.length === 0 && status.available.length === 0 && status.unreachable === undefined && status.strayBranches === undefined && status.closesHeld === undefined) return null;
 async function act(body: LessonsRepoFileBody) {
  if (busy !== undefined) return;
  setBusy(body.repo + body.action);setError(undefined);
  try { await api.act(project, body);await query.invalidateQueries({ queryKey: lessonsRepoFileKey(project) }); }
  catch (cause) { setError(failure(cause, body));await query.invalidateQueries({ queryKey: lessonsRepoFileKey(project) }); }
  finally { setBusy(undefined); }
 }
 const button = (label: string, body: LessonsRepoFileBody, primary = false) => <Button key={body.action} variant={primary ? "primary" : "secondary"} busy={busy === body.repo + body.action} disabled={busy !== undefined} onClick={() => { void act(body); }}>{label}</Button>;
 const rowView = (row: Row) => {
  const url = row.pr === undefined ? undefined : safeExternalUrl(row.pr.url);
  return <li key={row.repo}>
   <strong><VisibleText text={row.repo} /></strong>: {row.enabled ? W.ON : W.OFF_STATE}{" "}
   {row.pr === undefined ? <span className="rv-muted">{W.NO_PR}</span> : url === undefined ? null : <a href={url} target="_blank" rel="noopener noreferrer" aria-label={W.OPEN_PR + ": " + row.repo}>{W.OPEN_PR}</a>}
   {lessonFileWaitingText(row.waitingFor) !== undefined && <p role="note" className="rv-muted" data-testid="lessons-repo-waiting"><VisibleText text={lessonFileWaitingText(row.waitingFor) ?? ""} /></p>}
   {row.notices.map(notice => <p key={notice} role="note" className="rv-muted"><VisibleText text={notice} /></p>)}
   {canChange && <div className="rv-lessons-actions">
    {row.fileDeleted && button(W.RESUME, { action: "resume", repo: row.repo }, true)}
    {row.pointer === "missing" && <>{button(W.POINTER_ADD, { action: "pointer_add", repo: row.repo })}{button(W.POINTER_DECLINE, { action: "pointer_decline", repo: row.repo })}</>}
    {row.enabled && button(W.TURN_OFF, { action: "off", repo: row.repo })}
   </div>}
   {canChange && row.retireConfirm !== undefined && <div className="rv-lessons-actions" role="group" aria-label={W.RETIRE_CARD + ": " + row.repo} data-testid="lessons-repo-retire-card">
    {button(W.RETIRE, { action: "retire_confirm", repo: row.repo, held: row.retireConfirm.digest }, true)}{button(W.KEEP, { action: "retire_keep", repo: row.repo, held: row.retireConfirm.digest })}
   </div>}
  </li>;
 };
 return <section className="rv-lessons-repo" aria-label={W.TITLE}>
  <h2>{W.TITLE}</h2>
  <p className="rv-muted">{W.WHY}</p>
  {status.lessonsOff && <p className="rv-muted" role="note">{W.OFF}</p>}
  {status.repos.length === 0 ? <p className="rv-muted">{W.NONE}</p> : <ul className="rv-lessons-repo-rows" aria-label={W.TITLE}>{status.repos.map(rowView)}</ul>}
  {(status.unreachable ?? []).map(entry => <p key={"u" + entry.repo} role="note" className="rv-muted"><VisibleText text={unreachableRepoText(entry.repo, entry.lessons)} /></p>)}
  {(status.closesHeld ?? []).map(entry => <p key={"h" + entry.repo} role="note" className="rv-muted"><VisibleText text={closesHeldText(entry.repo, entry.count)} /></p>)}
  {(status.strayBranches ?? []).map(entry => <p key={"s" + entry.repo} role="note" className="rv-muted"><VisibleText text={strayBranchesText(entry.repo, entry.branches)} /></p>)}
  {status.available.length > 0 && <div className="rv-lessons-repo-on"><p className="rv-muted">{W.AVAILABLE}</p>
   <ul className="rv-lessons-repo-rows">{status.available.map(name => <li key={name}><strong><VisibleText text={name} /></strong> {canChange ? button(W.TURN_ON, { action: "on", repo: name }, true) : <span className="rv-muted">{W.NOT_ALLOWED}</span>}</li>)}</ul></div>}
  {error !== undefined && <p role="alert">{error}</p>}
 </section>;
}
