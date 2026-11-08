import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../host.js";
import { ApiError } from "../../api/errors.js";
import { createPlanPanelApi, type CommentTarget, type PanelClaim, type PanelComment, type PanelDecision, type PanelSuggestion, type PanelView } from "../../api/plan-panel.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { PANEL_DOCUMENT_WORDS, type PanelDocument } from "./panel-docs.js";
import "./plan-panel.css";

const Markdown = lazy(async () => ({ default: (await import("../../design/SafeMarkdown.js")).SafeMarkdown }));
/** The longest comment the server keeps (it says so in its own words past this). */
const COMMENT_MAX = 2000;
const AGENTX_WORDS: Record<string, string> = {
 answering: "Rovara is answering. The answer shows here.", couldnt: "Rovara couldn't answer this.", not_answered: "Not answered.", unavailable: "Rovara can't answer questions on this task.",
 skipped: "Not asked: you reached the limit for questions this hour.", sent_to_coding: "Sent to coding with the approval.",
};
const keyOf = (target: CommentTarget): string => target.kind === "document" ? "document" : target.kind + "-" + target.id;
const sameTarget = (left: CommentTarget, right: CommentTarget): boolean => keyOf(left) === keyOf(right);
const domId = (...parts: string[]): string => ["panel", ...parts].join("-").replace(/[^A-Za-z0-9_-]/gu, "-");

interface Context {
 view: PanelView; document: PanelDocument; comments: PanelComment[]; suggestions: PanelSuggestion[]; canRemember: boolean; busy: boolean;
 composing: string | undefined; setComposing: (key: string | undefined) => void; editing: string | undefined; setEditing: (id: string | undefined) => void;
 post: (target: CommentTarget, text: string, ask: boolean, parentId?: string) => Promise<boolean>;
 edit: (comment: PanelComment, text: string) => Promise<boolean>; remove: (comment: PanelComment) => void; learn: (comment: PanelComment, action: "remember" | "forget") => void;
 suggest: (decisionId: string, optionId: string | null) => void;
}

/** A box to write a comment, a reply or an edit; with Ask for a new comment when the person may ask. */
function Composer({ id, label, initial = "", ask, onSubmit, onCancel, busy, submit }: { id: string; label: string; initial?: string; ask: boolean; busy: boolean; submit: string; onSubmit: (text: string, ask: boolean) => Promise<boolean>; onCancel: () => void }) {
 const [text, setText] = useState(initial), [asking, setAsking] = useState(false);
 const trimmed = text.trim();
 return <form className="rv-panel-composer" onSubmit={event => { event.preventDefault();void onSubmit(trimmed, asking).then(done => { if (done) { setText("");setAsking(false); } }); }}>
  <label htmlFor={id}>{label}</label>
  <textarea id={id} value={text} maxLength={COMMENT_MAX} onChange={event => setText(event.target.value)} />
  {ask && <p><input type="checkbox" id={id + "-ask"} checked={asking} onChange={event => setAsking(event.target.checked)} /> <label htmlFor={id + "-ask"}>Ask Rovara to reply to this comment</label></p>}
  <div className="rv-actions"><Button type="submit" variant="primary" busy={busy} disabled={trimmed === ""}>{submit}</Button><Button onClick={onCancel}>Cancel</Button></div>
 </form>;
}

function CommentItem({ comment, replies, context }: { comment: PanelComment; replies: PanelComment[]; context: Context }) {
 const { view, busy } = context, current = view.current?.version, readOnly = view.older !== undefined;
 const mine = !readOnly && comment.author.kind === "person" && comment.author.you && !comment.sent && !comment.deleted;
 const replyKey = "reply-" + comment.id;
 const name = comment.author.kind === "agentx" ? "Rovara" : comment.author.name + (comment.author.owner ? " (owner)" : "");
 return <li id={domId("comment", comment.id)} className="rv-panel-comment" data-author={comment.author.kind}>
  <p className="rv-message-meta"><strong><VisibleText text={name} /></strong>{comment.version !== current && <span>on v{comment.version}</span>}{comment.edited && !comment.deleted && <span>edited</span>}{comment.sent && <span>sent with a decision</span>}</p>
  {comment.deleted ? <p className="rv-muted">Comment deleted</p> : context.editing === comment.id
   ? <Composer id={domId("edit", comment.id)} label="Edit your comment" initial={comment.text} ask={false} busy={busy} submit="Save" onCancel={() => context.setEditing(undefined)} onSubmit={async text => { const done = await context.edit(comment, text);if (done) context.setEditing(undefined);return done; }} />
   : <p className="rv-message-text"><VisibleText text={comment.text} /></p>}
  {comment.agentx !== undefined && AGENTX_WORDS[comment.agentx] !== undefined && <p className="rv-muted" role={comment.agentx === "answering" ? "status" : undefined}>{AGENTX_WORDS[comment.agentx]}</p>}
  {!comment.deleted && context.editing !== comment.id && <div className="rv-panel-comment-actions">
   {comment.parentId === undefined && view.access.canComment && <Button variant="quiet" onClick={() => context.setComposing(replyKey)}>Reply</Button>}
   {mine && <Button variant="quiet" onClick={() => context.setEditing(comment.id)}>Edit</Button>}
   {mine && <Button variant="quiet" busy={busy} onClick={() => context.remove(comment)}>Delete</Button>}
   {!readOnly && context.canRemember && comment.author.kind === "person" && comment.remembered !== undefined && (comment.remembered
    ? <><span className="rv-muted">Remembered for this project</span><Button variant="quiet" busy={busy} onClick={() => context.learn(comment, "forget")}>Forget</Button></>
    : <Button variant="quiet" busy={busy} onClick={() => context.learn(comment, "remember")}>Remember this</Button>)}
  </div>}
  {replies.length > 0 && <ul className="rv-panel-thread">{replies.map(reply => <CommentItem key={reply.id} comment={reply} replies={[]} context={context} />)}</ul>}
  {context.composing === replyKey && <Composer id={domId("reply", comment.id)} label="Your reply" ask={false} busy={busy} submit="Reply" onCancel={() => context.setComposing(undefined)} onSubmit={text => context.post(comment.target, text, false, comment.id)} />}
 </li>;
}

/** The comments on one part of the document, oldest first, with their replies; and the box to add one. */
function Thread({ target, label, context }: { target: CommentTarget; label: string; context: Context }) {
 const key = keyOf(target), on = context.comments.filter(comment => comment.document === context.document && sameTarget(comment.target, target));
 const top = on.filter(comment => comment.parentId === undefined), canComment = context.view.access.canComment && context.view.current !== undefined;
 return <div className="rv-panel-discussion">
  {top.length > 0 && <ul className="rv-panel-thread" aria-label={"Comments on " + label}>{top.map(comment => <CommentItem key={comment.id} comment={comment} replies={context.comments.filter(reply => reply.parentId === comment.id)} context={context} />)}</ul>}
  {canComment && (context.composing === key
   ? <Composer id={domId("new", key)} label={"Comment on " + label} ask={context.view.access.canAsk} busy={context.busy} submit="Comment" onCancel={() => context.setComposing(undefined)} onSubmit={(text, ask) => context.post(target, text, ask)} />
   : <Button variant="quiet" className="rv-panel-comment-open" onClick={() => context.setComposing(key)} aria-label={"Comment on " + label}>{top.length === 0 ? "Comment" : "Add a comment"}</Button>)}
 </div>;
}

function Claims({ claims, context }: { claims: PanelClaim[]; context: Context }) {
 return <ol className="rv-panel-claims">{claims.map(claim => <li key={claim.id} id={domId("claim", claim.id)}>
  <p><span className="rv-muted">{claim.id}</span> <VisibleText text={claim.text} /></p>
  <Thread target={{ kind: "claim", id: claim.id }} label={"point " + claim.id} context={context} />
  {claim.children.length > 0 && <Claims claims={claim.children} context={context} />}
 </li>)}</ol>;
}

function Question({ decision, context }: { decision: PanelDecision; context: Context }) {
 const suggested = context.suggestions.filter(entry => entry.document === context.document && entry.decisionId === decision.id);
 const mine = suggested.find(entry => entry.you)?.optionId;
 return <li id={domId("decision", decision.id)}>
  <p><strong><VisibleText text={decision.question} /></strong></p>
  <ul>{decision.options.map(option => <li key={option.id}><VisibleText text={option.label + (option.consequence === "" ? "" : ": " + option.consequence) + (option.id === decision.recommended ? " (Rovara recommends this)" : "")} /></li>)}</ul>
  {suggested.filter(entry => !entry.you).map(entry => <p key={entry.name + entry.optionId} className="rv-muted"><VisibleText text={entry.name + " suggests: " + (decision.options.find(option => option.id === entry.optionId)?.label ?? entry.optionId)} /></p>)}
  {context.view.access.canSuggest && <fieldset className="rv-panel-suggest"><legend>Suggest an answer to the owner</legend>
   {decision.options.map(option => <Button key={option.id} variant="quiet" aria-pressed={mine === option.id} busy={context.busy} onClick={() => context.suggest(decision.id, mine === option.id ? null : option.id)}><VisibleText text={option.label} /></Button>)}
  </fieldset>}
  <Thread target={{ kind: "decision", id: decision.id }} label={"the question " + decision.question} context={context} />
 </li>;
}

function Body({ context }: { context: Context }) {
 const { view } = context, current = view.current;
 if (current === undefined) return <p>{view.unverified ? "The saved document couldn't be verified, so it isn't shown." : "This document hasn't been written yet."}</p>;
 const status = <p className="rv-muted">{"Version " + current.version + (view.older !== undefined ? " (older)" : "") + (current.approved ? ", approved" : view.waiting ? ", waiting for the owner's decision" : "")}{view.versions.length > 1 ? " · " + view.versions.length + " versions" : ""}</p>;
 if (current.format === "markdown") return <>{status}<Suspense fallback={<Skeleton label="Loading the document" />}><Markdown markdown={current.markdown} comments={[]} /></Suspense><h3>Comments</h3><Thread target={{ kind: "document" }} label="the whole document" context={context} /></>;
 return <>
  {status}
  <h3><VisibleText text={current.title} /></h3>
  {current.why.length > 0 && <section aria-label="Why"><h4>Why</h4>{current.why.map((why, index) => <blockquote key={index}><VisibleText text={why.text} /><footer><VisibleText text={why.author} /></footer></blockquote>)}</section>}
  <section aria-label="What Rovara will do"><h4>What Rovara will do</h4><Claims claims={current.claims} context={context} /></section>
  {current.decisions.length > 0 && <section aria-label="Questions"><h4>Questions</h4><ol className="rv-panel-questions">{current.decisions.map(decision => <Question key={decision.id} decision={decision} context={context} />)}</ol></section>}
  {current.risks.length > 0 && <section aria-label="Risks"><h4>Risks</h4><ul>{current.risks.map((risk, index) => <li key={index}><VisibleText text={risk} /></li>)}</ul></section>}
  {current.notChanging.length > 0 && <section aria-label="Not changing"><h4>Not changing</h4><ul>{current.notChanging.map((line, index) => <li key={index}><VisibleText text={line} /></li>)}</ul></section>}
  {view.checks.length > 0 && <section aria-label="Checks"><h4>Checks</h4><ul className="rv-panel-claims">{view.checks.map(check => <li key={check.id} id={domId("check", check.id)}><p><VisibleText text={check.label} /></p><Thread target={{ kind: "check", id: check.id }} label={"the check " + check.label} context={context} /></li>)}</ul></section>}
  <section aria-label="Comments on the whole document"><h4>Comments on the whole document</h4><Thread target={{ kind: "document" }} label="the whole document" context={context} /></section>
 </>;
}

/**
 * Which saved version the panel shows: the current one, or an older one read-only. The list comes from the current read, so it stays while an older version loads. Choosing the current version (or
 * "Back to the current version") returns to the ordinary view with its comments, suggestions and Approve.
 */
function VersionPicker({ versions, shown, older, onPick }: { versions: PanelView["versions"]; shown: number | undefined; older: { currentVersion: number } | undefined; onPick: (version: number | undefined) => void }) {
 const latest = versions.find(entry => entry.current)?.version;
 return <div className="rv-panel-versions">
  <label htmlFor="panel-version">Version</label>
  <select id="panel-version" value={shown ?? latest ?? ""} onChange={event => { const picked = Number(event.target.value);onPick(picked === latest ? undefined : picked); }}>
   {[...versions].sort((left, right) => right.version - left.version).map(entry => <option key={entry.version} value={entry.version}>{"v" + entry.version + (entry.current ? " (current)" : "") + (entry.approved ? ", approved" : "")}</option>)}
  </select>
  {older !== undefined && <div className="rv-panel-older"><p role="status"><strong>Older version.</strong> You're reading v{shown} read-only. The current version is v{older.currentVersion}.</p> <Button variant="quiet" onClick={() => onPick(undefined)}>Back to the current version</Button></div>}
 </div>;
}

/**
 * OWNER DECISION 18: the full document inside the task page: a side panel on a desktop, a full-screen sheet on a phone. Line comments, replies, edits and deletes of your own, suggestions, Ask (its
 * answer shows in the thread) and Remember / Forget, each through the old page's own server function. `footer` is the decision card's own Approve and Request changes (the same decide path, sign-in
 * and second-person rules as the card), pinned at the bottom; without one (nothing waits on this person) the panel only reads and discusses.
 */
export default function PlanPanel({ taskId, document, footer, onClose, onLoaded }: { taskId: string; document: PanelDocument; footer?: ReactNode; onClose: () => void;
 /** Called once, after the document's current version has been read and drawn (never for a document that failed to load or isn't written): a medium card records its evidence as opened then. */ onLoaded?: () => void }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createPlanPanelApi(host), [host]);
 const [version, setVersion] = useState<number>();
 const latest = useQuery({ queryKey: ["plan-panel", taskId, document], queryFn: () => api.document(taskId, document), retry: false });
 const olderRead = useQuery({ queryKey: ["plan-panel", taskId, document, version], queryFn: () => api.document(taskId, document, version), retry: false, enabled: version !== undefined });
 const view = version === undefined ? latest : olderRead;
 const comments = useQuery({ queryKey: ["plan-panel-comments", taskId], queryFn: () => api.comments(taskId), retry: false,
  // While Rovara answers a question, the thread is read again until the answer is there.
  refetchInterval: read => (read.state.data?.comments.some(comment => comment.agentx === "answering") === true ? 4000 : false) });
 const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [done, setDone] = useState<string>();
 const loaded = useRef(false), shown = latest.isSuccess && latest.data.current !== undefined;
 useEffect(() => { if (shown && !loaded.current) { loaded.current = true;onLoaded?.(); } }, [shown, onLoaded]);
 const [composing, setComposing] = useState<string>(), [editing, setEditing] = useState<string>();
 async function run(work: () => Promise<unknown>, said: string): Promise<boolean> {
  if (busy) return false;
  setBusy(true);setError(undefined);setDone(undefined);
  try {
   await work();
   await Promise.all([query.invalidateQueries({ queryKey: ["plan-panel-comments", taskId] }), query.invalidateQueries({ queryKey: ["task-comments", taskId] }), query.invalidateQueries({ queryKey: ["decisions"] })]);
   setDone(said);return true;
  } catch (failure) { setError(failure instanceof ApiError || (failure instanceof Error && failure.message !== "") ? failure.message : "Couldn't do that. Try again.");return false; } finally { setBusy(false); }
 }
 const words = PANEL_DOCUMENT_WORDS[document];
 const read = view.data, listed = comments.data;
 const context: Context | undefined = read === undefined ? undefined : {
  // An older version shows its own comments only, and none of the current questions' suggestions.
  view: read, document, comments: (listed?.comments ?? []).filter(comment => read.older === undefined || comment.version === read.current?.version), suggestions: read.older === undefined ? listed?.suggestions ?? [] : [], canRemember: listed?.canRemember === true, busy, composing, setComposing, editing, setEditing,
  post: async (target, text, ask, parentId) => {
   let limited = false;
   const posted = await run(async () => {
    const answer = await api.comment(taskId, { document, version: read.current!.version, target, ...(parentId === undefined ? {} : { parentId }), text, ask }) as { askRefused?: unknown };
    limited = answer.askRefused === "limited";
    setComposing(undefined);
   }, ask ? "Posted. Rovara is answering." : "Posted.");
   if (posted && limited) setDone("Your comment is posted. You've asked Rovara a lot this hour, so it won't answer this one.");
   return posted;
  },
  edit: (comment, text) => run(() => api.edit(taskId, comment.id, comment.rev, text), "Saved."),
  remove: comment => { void run(() => api.remove(taskId, comment.id, comment.rev), "Deleted."); },
  learn: (comment, action) => { void run(() => api.learn(taskId, comment.id, action), action === "remember" ? "Remembered for this project." : "Forgotten."); },
  suggest: (decisionId, optionId) => { void run(() => api.suggest(taskId, document, decisionId, optionId), optionId === null ? "Suggestion cleared." : "Suggested to the owner."); },
 };
 const title = words.name + (read?.current === undefined ? "" : " v" + read.current.version + (read.older === undefined ? "" : " (older)"));
 return <Dialog title={title} open onOpenChange={open => { if (!open) onClose(); }} className="rv-plan-panel" description={read?.access.canComment === true ? "Read the whole document and discuss any part of it." : "Read the whole document."}>
  <div className="rv-plan-panel-body">
   {latest.isSuccess && latest.data.versions.length > 1 && <VersionPicker versions={latest.data.versions} shown={version} older={read?.older} onPick={picked => { setComposing(undefined);setEditing(undefined);setError(undefined);setDone(undefined);setVersion(picked); }} />}
   {view.isPending ? <Skeleton label="Loading the document" />
    : view.isError || context === undefined ? <p role="alert"><VisibleText text={view.error instanceof ApiError ? view.error.message : "Couldn't load this document. Close and open it again."} /></p>
    : <Body context={context} />}
   {comments.isError && <p role="alert">Couldn't load the comments. Close and open the document again.</p>}
  </div>
  <div className="rv-plan-panel-messages">{done !== undefined && <p role="status">{done}</p>}{error !== undefined && <p role="alert"><VisibleText text={error} /></p>}</div>
  {footer !== undefined && footer !== null && read?.older === undefined && version === undefined && <div className="rv-plan-panel-footer" role="region" aria-label="Decide">{footer}</div>}
 </Dialog>;
}
