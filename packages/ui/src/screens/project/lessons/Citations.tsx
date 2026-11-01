import type { LessonItem } from "../../../api/lessons.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { safeExternalUrl } from "../../../text/links.js";
import { T, agoWords, checkWords } from "./lessons-text.js";

const TASK_ID = /^[A-Za-z0-9_-]{1,100}$/u;

/** What a lesson cites, and whether it still holds: code is checked against the project's main branch before every use; a pull request or task is a link. Everything is shown as text; a link is followed only if it is a plain https address. */
export function Citations({ citations, now }: { citations: LessonItem["citations"]; now: number }) {
 if (citations.length === 0) return <p className="rv-muted">{T.NO_CITES}</p>;
 return <div><p>{T.CITES}</p><ul className="rv-lessons-citations" aria-label={T.CITES}>{citations.map((citation, index) => {
  if (citation.kind === "code") {
   const holds = citation.check === "valid" || citation.check === "moved";
   return <li key={index}><code><VisibleText text={citation.repo + "/" + citation.path + ":" + String(citation.startLine) + "-" + String(citation.endLine)} /></code> <span className={holds ? "rv-lessons-holds" : "rv-lessons-fails"}>{checkWords(citation.check)}</span>{citation.checkedAt !== undefined && <span className="rv-muted"> · checked {agoWords(citation.checkedAt, now)}</span>}</li>;
  }
  if (citation.kind === "pr") { const url = safeExternalUrl(citation.url);return <li key={index}>{url === undefined ? <VisibleText text={citation.url} /> : <a href={url} target="_blank" rel="noreferrer noopener"><VisibleText text={citation.url} /></a>}</li>; }
  if (citation.kind === "task") return <li key={index}>{TASK_ID.test(citation.taskId) ? <a href={"/review/" + citation.taskId + "/task"}>An earlier task</a> : "An earlier task"}</li>;
  return <li key={index}>A note in the team record</li>;
 })}</ul></div>;
}
