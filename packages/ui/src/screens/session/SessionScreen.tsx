import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ReadAppNav, SessionAnchorRef } from "@agentx/contracts/web";
import { createSessionApi, useSession, useSessionTimeline } from "../../api/sessions.js";
import { useDecisions } from "../../api/decisions.js";
import { readTask, useWorkApi, useWorkTasks, workRow, type WorkRow } from "../../api/work.js";
import { paths } from "../../paths.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { PRESENCE_HEARTBEAT_SECONDS } from "../../constants.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
import { NotFound } from "../../shell/NotFound.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import { SessionHeader, type ReadSession } from "./SessionHeader.js";
import { TaskPane } from "../work/TaskPane.js";
import { TaskActions } from "./TaskActions.js";
import type { Steer } from "./SteerBox.js";
import { ToneDot } from "../../design/StatusDot.js";
import { MoneyBanners } from "./MoneyBanners.js";
import { Conversation, type CommentDraft } from "./Conversation.js";
import { Composer, type MessageInput, type ComposerDrafts } from "./Composer.js";
import { SessionControls } from "./SessionControls.js";
import { PeoplePanel } from "./PeoplePanel.js";
import { Workspace } from "./Workspace.js";
import { DesignActions, useTaskDesign } from "./DesignActions.js";
import { usePageVisible } from "./presence.js";
import "./session.css";
/** How often a task with no Cloud session reads its plan, proof and activity again. */
const WORK_REFRESH_SECONDS = 15;
const SESSION_ID = /^ses_[0-9a-z]{20}$/u, TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * One task on its own page (Hybrid 1's full task view, DEC 223): the same pane as the Work page's, at full width. The address is the session's (`/s/ses_...`, what
 * people share) or the task's own id (a task started somewhere other than Cloud has no session, so Stop, steer and sharing are not there). The step rail, the
 * decision card, the spec, the build activity with its steer box, the proof, the pull request, cost and history come from the pane; the session's own controls
 * (follow, share, stop, close) and the conversation stay where they were. The earlier tabs (changes, design, evidence) are under "More about this task".
 */
export function SessionScreen() {
 const id = useParams().id ?? "", bySession = SESSION_ID.test(id), byTask = TASK_ID.test(id), host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionApi(host), [host]), workApi = useWorkApi(), visible = usePageVisible();
 const tasks = useWorkTasks(byTask), decisions = useDecisions(), listed = byTask ? tasks.data?.find(entry => entry.taskId.toLowerCase() === id.toLowerCase()) : undefined;
 const sessionId = bySession ? id : listed?.sessionId, read = useSession(sessionId ?? "", sessionId !== undefined);
 const [shareRequest, setShareRequest] = useState(0), [open, setOpen] = useState(false), [connection, setConnection] = useState("connecting");
 const [editDrafts, setEditDrafts] = useState<Record<string, Record<string, CommentDraft>>>({});
 const [drafts, setDrafts] = useState<Record<string, ComposerDrafts>>({}), [sending, setSending] = useState(false), sendingRef = useRef(false);
 const [selection, setSelection] = useState<{ sessionId: string; anchor: SessionAnchorRef }>();
 const sourceControl = useRef<HTMLElement | undefined>(undefined), root = useRef<HTMLElement>(null);
 const session = sessionId === undefined || read.isError ? undefined : read.data, ready = session !== undefined, title = session?.title ?? listed?.title;
 const selected = selection !== undefined && selection.sessionId === sessionId ? selection.anchor : undefined;
 const currentPart = selected === undefined ? undefined : session?.anchors?.find(part => part.target === selected.target && part.targetId === selected.targetId);
 const anchorKey = selected === undefined ? undefined : selected.target + ":" + selected.targetId, draftKey = (sessionId ?? id) + ":" + (anchorKey ?? "all");
 const timeline = useSessionTimeline(sessionId ?? "", open && ready && (selected === undefined || currentPart !== undefined), anchorKey);
 const discuss = useCallback((anchor: SessionAnchorRef, source: HTMLElement) => { sourceControl.current = source;setSelection({ sessionId: sessionId ?? id, anchor });setOpen(true); }, [id, sessionId]);
 // The task and its row: from the session when there is one (it is read again on every notice), else from the work list.
 const task = useMemo(() => {
  const fromSession = session?.body.kind === "task" ? readTask(session.body.task) : undefined;
  return fromSession === undefined ? listed : { ...fromSession, sessionId };
 }, [session, listed, sessionId]);
 const pendingCard = task === undefined ? undefined : decisions.data?.find(entry => entry.card.status === "pending" && entry.card.taskId === task.taskId);
 const row: WorkRow | undefined = useMemo(() => (task === undefined ? undefined : workRow(task, pendingCard, new Date())), [task, pendingCard]);
 const { task: designTask, key: designKey, design } = useTaskDesign(session, row?.id);
 const shown = row !== undefined || session !== undefined;
 useEffect(() => { if (shown) root.current?.querySelector<HTMLElement>("h1")?.focus(); }, [shown]);
 useEffect(() => { if (title === undefined) return;host.setTitle?.(visibleText(title) + " · Rovara");return () => host.setTitle?.("Rovara"); }, [host, title]);
 useEffect(() => { if (!ready || sessionId === undefined) return;const invalidator = createNoticeInvalidator(query), realtime = createRealtimeClient(host, { onNotice: notice => invalidator.notice(notice), onStatus: setConnection, onReset: () => invalidator.reset() });realtime.subscribeSession(sessionId);realtime.start();return () => { realtime.stop();invalidator.stop(); }; }, [host, sessionId, query, ready]);
 useEffect(() => {
 if (!visible || !ready || sessionId === undefined) return;let active = true, writing = false;
 const heartbeat = async () => { if (writing) return;writing = true;try { const result = await api.presence(sessionId);if (active && result.kind === "done") query.setQueryData<ReadSession>(["session", sessionId], old => old === undefined ? undefined : { ...old, viewingNow: result.value.viewingNow }); } catch { if (active) void query.invalidateQueries({ queryKey: ["session", sessionId], exact: true }); } finally { writing = false; } };
 void heartbeat();const timer = setInterval(() => { void heartbeat(); }, PRESENCE_HEARTBEAT_SECONDS * 1000);return () => { active = false;clearInterval(timer); };
 }, [api, sessionId, query, visible, ready]);
 // A task with no Cloud session (or whose session could not be read) has no notices: its reads are asked again every so often while the page is in view.
 const hasRow = row !== undefined;
 useEffect(() => {
  if (!visible || (sessionId !== undefined && ready) || !hasRow) return;
  const timer = setInterval(() => { void query.invalidateQueries({ queryKey: ["work"] });void query.invalidateQueries({ queryKey: ["decisions"] }); }, WORK_REFRESH_SECONDS * 1000);
  return () => { clearInterval(timer); };
 }, [visible, sessionId, ready, hasRow, query]);
 async function send(input: MessageInput) {
 if (sessionId === undefined) throw new ApiError(404, "NOT_FOUND", "This task has no conversation here.");
 if (sendingRef.current) throw new ApiError(409, "PENDING", "Your previous message is still being sent.");sendingRef.current = true;setSending(true);
 try { if (selected !== undefined && currentPart === undefined) throw new ApiError(404, "NOT_FOUND", "That part of this session is no longer available.");const result = await api.sendMessage(sessionId, { ...input, ...(input.kind === "comment" && selected !== undefined ? { anchor: selected } : {}) });if (result.kind !== "done") throw new ApiError(409, "PENDING", "This message is waiting for confirmation.");await query.invalidateQueries({ queryKey: ["session", sessionId, "messages"] }); }
 finally { sendingRef.current = false;setSending(false); }
 }
 async function edit(messageId: string, rev: number, text: string) { if (sessionId === undefined) return;const result = await api.editMessage(sessionId, messageId, rev, text);if (result.kind !== "done") throw new ApiError(409, "PENDING", "This change is waiting for confirmation.");await query.invalidateQueries({ queryKey: ["session", sessionId, "messages"] }); }
 async function remove(messageId: string, rev: number) { if (sessionId === undefined) return;const result = await api.deleteMessage(sessionId, messageId, rev);if (result.kind !== "done") throw new ApiError(409, "PENDING", "This change is waiting for confirmation.");await query.invalidateQueries({ queryKey: ["session", sessionId, "messages"] }); }

 if (!bySession && !byTask) return <NotFound />;
 const failure = bySession ? (read.isError ? read.error : undefined) : tasks.isError ? tasks.error : undefined;
 if (bySession ? read.isPending : tasks.isPending || (sessionId !== undefined && read.isPending)) return <section><h1 tabIndex={-1}>Session</h1><Skeleton label="Loading the session" /></section>;
 if (failure instanceof ApiError && failure.status === 404) return <NotFound />;
 if (failure !== undefined && (bySession || row === undefined)) return <section><h1 tabIndex={-1}>Session unavailable</h1><p role="alert" data-testid="load-error"><VisibleText text={failure instanceof ApiError ? failure.message : "Couldn't load this session. Try again."} /></p><Button onClick={() => { void (bySession ? read : tasks).refetch(); }}>Try again</Button></section>;
 if (session === undefined && row === undefined) return <NotFound />;
 const agent = session?.agent?.name ?? "The agent", nav = query.getQueryData<ReadAppNav>(["nav"]), orgName = nav?.org.name ?? "your company";
 const owner = session?.you.owner === true, controlsFailed = !bySession && sessionId !== undefined && read.isError;
 // The steer box under the running task: a steering message on the task's session. Cloud answers for itself (today it says messages to the agent are not available in Cloud yet).
 const steer: Steer = sessionId === undefined ? { kind: "unavailable", why: "Steering works for tasks started in Rovara Cloud. This one was started elsewhere." }
  : controlsFailed ? { kind: "unavailable", why: "Steering isn't available while this task's controls could not be loaded." }
  : !owner ? { kind: "unavailable", why: "Only the person who started this task can steer it." }
  : { kind: "send", send: async text => { const result = await api.sendMessage(sessionId, { kind: "steer", text });if (result.kind !== "done") throw new ApiError(409, "PENDING", "Your note is waiting for confirmation.");await query.invalidateQueries({ queryKey: ["session", sessionId, "messages"] }); } };
 const onDecided = () => { void query.invalidateQueries({ queryKey: ["work"] });if (sessionId !== undefined) void query.invalidateQueries({ queryKey: ["session", sessionId] }); };
 const comment = row === undefined ? undefined : async (anchor: string, text: string, replyTo?: string) => {
  let result;
  try { result = await workApi.comment(row.id, text, anchor, replyTo); }
  catch (failure) { throw failure instanceof ApiError && failure.code === "NOT_ON_CODE_YET" ? new Error("Commenting on the spec isn't connected to Rovara Code yet.") : failure; }
  if (result.kind !== "done") throw new ApiError(409, "PENDING", "Your comment is waiting for confirmation.");
  await query.invalidateQueries({ queryKey: ["work", "comments", row.id] });
 };
 const controls = <div className="rv-task-controls">
  {row !== undefined && <TaskActions taskId={row.id} canContinue={row.step !== "merged" && row.step !== "closed"} showNote={sessionId === undefined && row.group !== "done"} />}
  {session !== undefined && sessionId !== undefined && <SessionControls key={sessionId} id={sessionId} agent={agent} actions={session.you.actions} following={session.you.following} makeAgent responsive ask={session.you.live?.ask === true} share={{ orgName }} onPeopleShare={() => { setShareRequest(count => count + 1); }} onChanged={() => query.invalidateQueries({ queryKey: ["live"] })} />}
 </div>;
 const statusWords = row === undefined ? undefined : row.need ?? row.line;
 const conversation = session !== undefined && sessionId !== undefined && <Dialog title={selected === undefined ? "Conversation" : selected.target === "change_file" ? "Discussion of this file" : selected.target === "step" ? "Discussion of this step" : "Discussion of this plan paragraph"} className="rv-conversation-tray" open={open} onOpenChange={setOpen} onCloseAutoFocus={event => { const source = sourceControl.current;if (source?.isConnected) { event.preventDefault();source.focus(); }sourceControl.current = undefined; }} trigger={<Button onClick={() => { setSelection(undefined);sourceControl.current = undefined; }}>Conversation</Button>}>
 {selected && <Button variant="quiet" onClick={() => setSelection(undefined)}>All conversation</Button>}
 {selected && currentPart === undefined ? <p>That part of this session is no longer available.</p> : <>
 {selected && currentPart?.revision !== selected.revision && <p className="rv-muted">This discussion refers to an earlier version.</p>}
 {timeline.loading ? <Skeleton label="Loading conversation" /> : timeline.error ? <p role="alert"><VisibleText text={timeline.error instanceof ApiError ? timeline.error.message : "Couldn't load the conversation. Close and reopen to try again."} /></p> : <Conversation editDrafts={editDrafts[sessionId]} onEditDraftChange={(messageId, draft) => setEditDrafts(old => { const next = { ...old[sessionId] };if (draft === undefined) delete next[messageId];else next[messageId] = draft;return { ...old, [sessionId]: next }; })} agent={agent} messages={timeline.messages} events={timeline.events} meId={nav?.me.developerId} onEdit={session.you.actions.includes("comment") ? edit : undefined} onDelete={remove} onReload={async messageId => (await timeline.reloadMessages()).find(message => message.messageId === messageId)} />}{timeline.hasMore && <Button busy={timeline.loadingMore} onClick={() => { void timeline.loadMore(); }}>Load more conversation</Button>}<Composer autoFocus={selected !== undefined} agent={agent} actions={selected === undefined ? session.you.actions : session.you.actions.filter(action => action !== "steer")} onSend={send} sending={sending} drafts={drafts[draftKey] ?? { comment: "", steer: "" }} onDraftChange={(kind, text) => setDrafts(old => ({ ...old, [draftKey]: { ...old[draftKey] ?? { comment: "", steer: "" }, [kind]: text } }))} /></>}</Dialog>;
 // The earlier tabs stay one click away; they open by themselves when the page has nothing else to offer (no decision card for a task that waits on a person, or no readable task).
 const detailsOpen = row === undefined || (row.group === "you" && row.decision === undefined);
 return <section ref={root} className="rv-session rv-task-full" data-testid="task-page">
  {row !== undefined && <nav className="rv-task-back" aria-label="Back"><Link to={paths.live + "?task=" + encodeURIComponent(row.id)}>Back to Work</Link></nav>}
  {session !== undefined ? <SessionHeader session={session} onAction={() => undefined} controls={controls} />
   : row !== undefined && <header className="rv-session-header" data-testid="session-header"><div className="rv-session-context"><span><VisibleText text={row.project} /></span></div><h1 tabIndex={-1} data-testid="session-title"><VisibleText text={row.title} /></h1><div className="rv-session-facts"><span data-testid="session-status"><ToneDot tone={row.tone} words={statusWords ?? "Status"} /> <VisibleText text={statusWords ?? ""} /></span></div><div className="rv-session-people">{controls}</div></header>}
  {controlsFailed && <div role="alert" className="rv-task-controls-error" data-testid="controls-error"><p>Couldn't load this task's controls (Stop, Share, Conversation).{read.error instanceof ApiError ? " " + read.error.message : ""}</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div>}
  {session !== undefined && sessionId !== undefined && <PeoplePanel key={sessionId} id={sessionId} shareRequest={shareRequest} />}
  {session !== undefined && <MoneyBanners session={session} />}{connection === "reconnecting" && <p className="rv-muted">Reconnecting. Showing the last update.</p>}
  {conversation !== false && <div className="rv-task-bar">{conversation}</div>}
  {designTask !== undefined && <DesignActions task={designTask} sessionKey={designKey} />}
  {row !== undefined && <TaskPane wide row={row} decisionsError={decisions.isError ? decisions.error : undefined} onDecided={onDecided} steer={steer} onComment={comment} design={design} />}
  {session !== undefined && <details className="rv-task-more" open={detailsOpen || undefined}><summary>More about this task</summary>
   <div className="rv-session-work"><Workspace session={session} onComment={discuss} /></div>
  </details>}
 </section>;
}
