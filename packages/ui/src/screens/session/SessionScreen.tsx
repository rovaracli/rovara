import { TaskPageBoundary } from "./task-page-policy.js";
import { TaskErrorBlock } from "./TaskErrorBlock.js";
import { TaskSlotsProvider, useTaskChip, useTaskFeedbackRefused } from "./task-slots.js";
import { TaskMark } from "./task-marks.js";
import { TalkRefFooter } from "./TalkParts.js";
import { useTaskAction } from "../../api/task-action.js";
import { createApiClient } from "../../api/client.js";
import { TaskActionNotice } from "./TaskActionNotice.js";
import { lazy, Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { type ReadAppNav, type SessionAnchorRef } from "@agentx/contracts/web";
import { createTaskSessionApi, useSession, useSessionTimeline } from "../../api/sessions.js";
import { useDecisions } from "../../api/decisions.js";
import { readTask, useTaskPlan, useWorkTasks, workRow, type WorkRow } from "../../api/work.js";
import { type PlanChangeFrameFacts } from "./PlanChangeFrame.js";
import { paths } from "../../paths.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { PRESENCE_HEARTBEAT_SECONDS } from "../../constants.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
import { NotFound } from "../../shell/NotFound.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { ConfirmationDialogScope } from "../../design/ConfirmationDialog.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import { SessionHeader, SessionFacts, type ReadSession } from "./SessionHeader.js";
import { WikiTaskUseCard } from "./WikiTaskUseCard.js";
import { TaskPane } from "../work/TaskPane.js";
import { TaskActions } from "./TaskActions.js";
import type { Steer } from "./SteerBox.js";
import { StatusChip, type StatusChipState } from "../../design/StatusChip.js";
import { clockTime } from "./task-time.js";
import { MoneyBanners } from "./MoneyBanners.js";
import { Conversation, type CommentDraft } from "./Conversation.js";
import { Composer, type MessageInput, type ComposerDrafts } from "./Composer.js";
import { SessionControls } from "./SessionControls.js";
import { PeoplePanel } from "./PeoplePanel.js";
import { DecisionsCard } from "./DecisionsCard.js";
import { MergeSection, hasMergeSection } from "./MergeSection.js";
import { hasPrFeedback, prFeedbackPageChip, prFeedbackRail, prFeedbackSubject } from "../../api/pr-feedback.js";
// The PR feedback card loads only on a task that has feedback to show.
const PrFeedbackCard = lazy(async () => ({ default: (await import("./PrFeedbackCard.js")).PrFeedbackCard }));
import { Workspace } from "./Workspace.js";
import { DesignActions, useTaskDesign } from "./DesignActions.js";
import { usePageVisible } from "./presence.js";
import { TaskHeldStatesView } from "./TaskHeldStatesView.js";
import { TaskAnswers } from "../answers/TaskAnswers.js";
import { TaskSessionEntryReadRecoveryView } from "./TaskSessionEntryReadRecoveryView.js";
import { TaskControlsReadRecoveryView } from "./TaskControlsReadRecoveryView.js";
import { TaskStartReceiptView } from "./TaskStartReceiptView.js";
import { TaskDraftReturnView } from "./TaskDraftReturnView.js";
import { useSessionIdentity, useSessionRequest, sessionScope, readSessionIdentity, assertSessionIdentity, type FrozenSessionRequest, isSessionCsrf, isFinalSessionRefusal } from "../../api/session-safety.js";
import { AnsweredSection, answeredOf } from "./AnsweredSection.js";
import { workspaceTask } from "./workspace-types.js";
import { createAnswersApi } from "../../api/answers.js";
import { TalkQuestionRecoveryView } from "./TalkQuestionRecoveryView.js";
import { csrfFailure, talkQuestion, talkQuestionRefused, talkScope, talkRead, talkWritable, talkWrite, useTalkState } from "./talk-lifecycle.js";
import { TalkTimelineReadRecoveryView } from "./TalkTimelineReadRecoveryView.js";
import { TalkPlanChangeHandoffView } from "./TalkPlanChangeHandoffView.js";
import { TalkOutcomeView } from "./TalkOutcomeView.js";
import "./session.css";
import "./task-page.css";
/** How often a task with no Cloud session reads its plan, proof and activity again. */
const WORK_REFRESH_SECONDS = 15;
// The old session Ask route (Code's laptop Ask) is never offered on hosted Cloud (DEC 254z-amend2). "Ask about this task" there is TaskAnswers: the project's answers with the task as context, drawn only when the
// deployment's answers setting is on (the nav's `features.answers`: turned on once the gateway's answers purpose is merged AND deployed). AskPanel and session-ask.ts stay in place for a host that serves that route.
const ASK_ON_HOSTED = false;
const TONE_CHIP: Record<WorkRow["tone"], Exclude<StatusChipState, "waiting_for">> = { wait: "needs_you", run: "running", ok: "done", bad: "failed", idle: "queued" };
const SESSION_ID = /^ses_[0-9a-z]{20}$/u, TASK_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

/**
 * One task on its own page (Hybrid 1's full task view, DEC 223): the same pane as the Work page's, at full width. The address is the session's (`/s/ses_...`, what
 * people share) or the task's own id (a task started somewhere other than Cloud has no session, so Stop, steer and sharing are not there). The step rail, the
 * decision card, the spec, the build activity with its steer box, the proof, the pull request, cost and history come from the pane; the session's own controls
 * (follow, share, stop, close) and the conversation stay where they were. The earlier tabs (changes, design, evidence) are under "More about this task".
 */
export function SessionScreen() {
 const { id } = useParams();
 return <ConfirmationDialogScope key={id}><TaskPageBoundary><TaskSlotsProvider><TaskPageContents /></TaskSlotsProvider></TaskPageBoundary></ConfirmationDialogScope>;
}

function TaskPageContents() {
 const id = useParams().id ?? "", bySession = SESSION_ID.test(id), byTask = TASK_ID.test(id), host = useAppHost(), query = useQueryClient(), api = useMemo(() => createTaskSessionApi(host), [host]), visible = usePageVisible();
 const identity = useSessionIdentity(host), slotChip = useTaskChip(), feedbackRefused = useTaskFeedbackRefused();
 const tasks = useWorkTasks(byTask && identity.data !== undefined, identity.data), decisions = useDecisions(), listed = byTask && !tasks.isError ? tasks.data?.find(entry => entry.taskId.toLowerCase() === id.toLowerCase()) : undefined;
 const sessionId = bySession ? id : listed?.sessionId;
 const scope = identity.data === undefined || sessionId === undefined ? undefined : talkScope(identity.data.companyId, identity.data.personId, sessionId);
 const lifecycle = useTalkState(host, scope), read = useSession(sessionId ?? "", sessionId !== undefined, scope);
 const [shareRequest, setShareRequest] = useState(0), [open, setOpen] = useState(false), [connection, setConnection] = useState("connecting");
 const [editDrafts, setEditDrafts] = useState<Record<string, Record<string, CommentDraft>>>({});
 const [drafts, setDrafts] = useState<Record<string, ComposerDrafts>>({}), [sending, setSending] = useState(false), sendingRef = useRef(false);
 const [selection, setSelection] = useState<{ sessionId: string; anchor: SessionAnchorRef }>();
 const [questionWaiting, setQuestionWaiting] = useState(false);
 const sourceControl = useRef<HTMLElement | undefined>(undefined), root = useRef<HTMLElement>(null);
 const session = sessionId === undefined || read.isError ? undefined : read.data, ready = session !== undefined, title = session?.title ?? listed?.title;
 const selected = selection !== undefined && selection.sessionId === scope ? selection.anchor : undefined;
 const currentPart = selected === undefined ? undefined : session?.anchors?.find(part => part.target === selected.target && part.targetId === selected.targetId);
 const anchorKey = selected === undefined ? undefined : selected.target + ":" + selected.targetId, draftKey = identity.data === undefined ? "unread" : sessionScope(identity.data, (sessionId ?? id) + ":talk:" + (anchorKey ?? "all"));
 const talk = useSessionRequest(host, identity.data, (sessionId ?? id) + ":talk:" + (anchorKey ?? "all"));
 // The PR feedback card's own durable record (same subject, company and person): an unanswered press says so in "Where this task is" too.
 const feedbackPress = useSessionRequest(host, identity.data, prFeedbackSubject(sessionId ?? id));
 const [commentSeed, setCommentSeed] = useState<number>();
 const [restored, setRestored] = useState<string>(), [draftReturn, setDraftReturn] = useState<{ key: string; text: string; operation: "unsent" | "sending" | "sent" | "unknown" }>(), [messageRefusal, setMessageRefusal] = useState<{ text: string; authority: string }>();
 useEffect(() => {
  if (draftKey === "unread" || restored === draftKey) return;
  try { const saved = host.storage.get(draftKey + ":draft");if (saved === undefined) return;const parsed = JSON.parse(saved) as ComposerDrafts;if (typeof parsed.comment !== "string" || typeof parsed.steer !== "string") return;const timer = window.setTimeout(() => { setDrafts(old => ({ ...old, [draftKey]: parsed }));setRestored(draftKey);setDraftReturn({ key: draftKey, text: parsed.comment || parsed.steer, operation: talk.request !== undefined ? "unknown" : "unsent" }); }, 0);return () => window.clearTimeout(timer); } catch { /* A missing draft does not confer task authority. */ }
 }, [host, draftKey, talk.request, restored]);
  const discuss = useCallback((anchor: SessionAnchorRef, source: HTMLElement) => { sourceControl.current = source;setSelection({ sessionId: scope ?? id, anchor });setOpen(true); }, [id, scope]);
 // The task and its row: from the session when there is one (it is read again on every notice), else from the work list.
 const task = useMemo(() => {
  const fromSession = session?.body.kind === "task" ? readTask(session.body.task) : undefined;
  return fromSession === undefined ? listed : { ...fromSession, sessionId };
 }, [session, listed, sessionId]);
 const planComment = useTaskAction(host, "plan-comment:" + (task?.taskId ?? id));
 const pendingCard = task === undefined ? undefined : decisions.isError || decisions.failureCount > 0 ? undefined : decisions.data?.find(entry => entry.card.status === "pending" && entry.card.taskId === task.taskId);
 const row: WorkRow | undefined = useMemo(() => (task === undefined ? undefined : workRow(task, pendingCard, new Date())), [task, pendingCard]);
 const { task: designTask, key: designKey, design } = useTaskDesign(session, row?.id);
 const planPending = pendingCard?.card.kind === "approve_plan", planRead = useTaskPlan(row?.id);
 // A delivered instruction beside a pending plan is the one thing the server tells us about a plan change; what changed from the earlier plan is not served (held).
 const timeline = useSessionTimeline(sessionId ?? "", (open || planPending) && ready && (selected === undefined || currentPart !== undefined), anchorKey, scope);
 const instruction = planPending && !timeline.error ? [...timeline.messages].reverse().find(message => message.kind === "steer" && message.delivery?.state === "delivered" && message.deletedAt === undefined) : undefined;
 const planChange: PlanChangeFrameFacts | undefined = instruction === undefined || planRead.data === undefined ? undefined : { version: planRead.data.version, headline: planRead.data.headline, checks: planRead.data.checks, estimate: planRead.data.estimate, taskCount: planRead.data.tasks.length, instruction: { name: instruction.author.name, at: instruction.createdAt, text: instruction.text } };
 const shown = row !== undefined || session !== undefined;
 useEffect(() => { if (shown) root.current?.querySelector<HTMLElement>("h1")?.focus(); }, [shown]);
 useEffect(() => { if (title === undefined) return;host.setTitle?.(visibleText(title) + " · Rovara");return () => host.setTitle?.("Rovara"); }, [host, title]);
 useEffect(() => { if (!ready || sessionId === undefined) return;const invalidator = createNoticeInvalidator(query), realtime = createRealtimeClient(host, { onNotice: notice => invalidator.notice(notice), onStatus: setConnection, onReset: () => invalidator.reset() });realtime.subscribeSession(sessionId);realtime.start();return () => { realtime.stop();invalidator.stop(); }; }, [host, sessionId, query, ready]);
 useEffect(() => {
 if (!visible || !ready || sessionId === undefined) return;let active = true, writing = false;
 const heartbeat = async () => { if (writing) return;writing = true;try { const result = await api.presence(sessionId);if (active && result.kind === "done" && query.getQueryState(["session", sessionId])?.status === "success") query.setQueryData<ReadSession>(["session", sessionId], old => old === undefined ? undefined : { ...old, viewingNow: result.value.viewingNow }); } catch { if (active) void query.invalidateQueries({ queryKey: ["session", sessionId], exact: true }); } finally { writing = false; } };
 void heartbeat();const timer = setInterval(() => { void heartbeat(); }, PRESENCE_HEARTBEAT_SECONDS * 1000);return () => { active = false;clearInterval(timer); };
 }, [api, sessionId, query, visible, ready]);
 // A task with no Cloud session (or whose session could not be read) has no notices: its reads are asked again every so often while the page is in view.
 const hasRow = row !== undefined;
 useEffect(() => {
  if (!visible || (sessionId !== undefined && ready) || !hasRow) return;
  const timer = setInterval(() => { void query.invalidateQueries({ queryKey: ["work"] });void query.invalidateQueries({ queryKey: ["decisions"] }); }, WORK_REFRESH_SECONDS * 1000);
  return () => { clearInterval(timer); };
 }, [visible, sessionId, ready, hasRow, query]);
 const resources = ["session", "messages:" + (anchorKey ?? "all"), ...(anchorKey === undefined ? ["events"] : [])];
 const writable = lifecycle?.lock === undefined && talk.request === undefined && talk.storageError === undefined && scope !== undefined && !read.isError && !timeline.error && talkWritable(host, scope, resources);
 async function recoverIdentity(failure: unknown) { if (csrfFailure(failure)) { await identity.refetch();await read.refetch();throw new ApiError(403, failure instanceof ApiError ? failure.code : "CSRF_INVALID", "Couldn't change that. Your draft is still here."); } }
 async function send(input: MessageInput, inline = false) {
 if (sessionId === undefined) throw new ApiError(404, "NOT_FOUND", "This task has no conversation here.");
 if (sendingRef.current) throw new ApiError(409, "PENDING", "Your previous message is still being sent.");sendingRef.current = true;setSending(true);setRestored(draftKey);setMessageRefusal(undefined);setDraftReturn({ key: draftKey, text: input.text, operation: "sending" });
 let frozen: FrozenSessionRequest | undefined;
 try {
  if (talk.request !== undefined || talk.storageError !== undefined || scope === undefined || identity.data === undefined || identity.isError || timeline.error || read.isError || selected !== undefined && currentPart === undefined) throw new ApiError(0, "READ_REQUIRED", "Read the current conversation before changing it.");
  const person = await readSessionIdentity(host);assertSessionIdentity(host, identity.data);await talkRead(host, scope, "session", () => api.read(sessionId));assertSessionIdentity(host, person);
  if (inline) await timeline.reload();
  const body = { ...input, ...(input.kind === "comment" && selected !== undefined ? { anchor: selected } : {}) };
  await talkWrite(host, scope, resources, "send", body, async requestId => { frozen = { requestId, action: "message", body, startedAt: Date.now(), fence: 0 };const result = await api.sendMessage(sessionId, { ...body, requestId });if (result.kind !== "done") throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet.");return result.value; });

  setDraftReturn({ key: draftKey, text: input.text, operation: "sent" });
  void query.invalidateQueries({ queryKey: ["session", sessionId, "messages"] });
 } catch (failure) {
    if (frozen !== undefined && isFinalSessionRefusal(failure)) { const fresh = await talkRead(host, scope, "session", () => api.read(sessionId)).catch(() => undefined);if (fresh !== undefined) query.setQueryData(["session", sessionId], fresh);setMessageRefusal({ text: failure instanceof ApiError ? failure.message : "Rovara refused this conversation message.", authority: fresh === undefined ? "Conversation authority could not be re-read." : fresh.you.actions.includes(input.kind) ? "The latest session read still allows this conversation action." : "The latest session read no longer allows this conversation action." }); }
  setDraftReturn({ key: draftKey, text: input.text, operation: isSessionCsrf(failure) || isFinalSessionRefusal(failure) ? "unsent" : "unknown" });await recoverIdentity(failure);throw failure; }
 finally { sendingRef.current = false;setSending(false); }
 }
 async function edit(messageId: string, rev: number, text: string) {
  if (sessionId === undefined || !writable) throw new ApiError(0, "READ_REQUIRED", "Read the current conversation before changing it.");
  try { await talkWrite(host, scope, resources, "edit", { messageId, rev, text }, async () => { const result = await api.editMessage(sessionId, messageId, rev, text);if (result.kind !== "done") throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet.");return result.value; });void query.invalidateQueries({ queryKey: ["session", sessionId, "messages"] }); }
  catch (failure) { await recoverIdentity(failure);throw failure; }
 }
 async function remove(messageId: string, rev: number) {
  if (sessionId === undefined || !writable) throw new ApiError(0, "READ_REQUIRED", "Read the current conversation before changing it.");
  try { await talkWrite(host, scope, resources, "delete", { messageId, rev }, async () => { const result = await api.deleteMessage(sessionId, messageId, rev);if (result.kind !== "done") throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet.");return result.value; });void query.invalidateQueries({ queryKey: ["session", sessionId, "messages"] }); }
  catch (failure) { await recoverIdentity(failure);throw failure; }
 }

 if (!bySession && !byTask) return <NotFound />;
 const refused = (error: unknown): boolean => error instanceof ApiError && (error.status === 401 || error.status === 403);
 const failure = bySession ? (read.isError ? read.error : undefined) : tasks.isError ? tasks.error : undefined;
 // DEC 324: when the person's access is gone (their read was refused), nothing earlier stays on the page; the one 4e block replaces it.
 const accessLost = refused(failure) || refused(identity.error);
 if (accessLost) return <TaskSessionEntryReadRecoveryView accessLost onRetry={() => { void identity.refetch();void (bySession ? read : tasks).refetch(); }} />;
 if (identity.isError) return <TaskErrorBlock page title="Rovara couldn't load this task" happened="Couldn't read who you are. Check again before changing this task." safe="Nothing was changed on the task." next="Check again." action={{ label: "Check again", onClick: () => { void identity.refetch(); } }} refCode="TASK-IDENTITY-UNREAD" />;
 if (bySession ? read.isPending : tasks.isPending || (sessionId !== undefined && read.isPending)) return <section><h1 tabIndex={-1}>Session</h1><Skeleton label="Loading the session" /></section>;
 if (failure instanceof ApiError && failure.status === 404) return <NotFound />;
 if (failure !== undefined) return <TaskSessionEntryReadRecoveryView onRetry={() => { void (bySession ? read : tasks).refetch(); }} />;
 if (session === undefined && row === undefined) return <NotFound />;
 const fullTask = session === undefined ? undefined : workspaceTask(session), hasAnswer = answeredOf(fullTask) !== undefined;
 const agent = session?.agent?.name ?? "The agent", nav = query.getQueryData<ReadAppNav>(["nav"]), orgName = nav?.org.name ?? "your company";
 const owner = session?.you.owner === true, controlsFailed = !bySession && sessionId !== undefined && read.isError;
 // The steer box under the running task: a steering message on the task's session. Cloud answers for itself (today it says messages to the agent are not available in Cloud yet).
 const steer: Steer = sessionId === undefined ? { kind: "unavailable", why: "Stop and steering are only for tasks started in Rovara Cloud. This task started in another tool." }
  : talk.request !== undefined || talk.storageError !== undefined ? { kind: "unavailable", why: "A previous message is unconfirmed. Open Conversation to check before sending another." }
  : controlsFailed ? { kind: "unavailable", why: "Steering isn't available while this task's controls could not be loaded." }
  : !owner ? { kind: "unavailable", why: "Only the person who started this task can steer it." }
  : !session?.you.actions.includes("steer") ? { kind: "unavailable", why: "This session does not allow steering. Read its current controls before changing the work." }
  : !talkWritable(host, scope, ["session"]) ? { kind: "unavailable", why: "Read the current conversation before sending an instruction." }
  : { kind: "send", send: async text => { await send({ kind: "steer", text }, true); } };
 const onDecided = () => { void query.invalidateQueries({ queryKey: ["work"] });if (sessionId !== undefined) void query.invalidateQueries({ queryKey: ["session", sessionId] }); };
 const comment = row === undefined ? undefined : async (anchor: string, text: string, replyTo?: string) => {
  const body = { requestId: crypto.randomUUID(), document: "plan", text, anchor, ...(replyTo === undefined ? {} : { replyTo }) };
  const result = await planComment.run("comment", body, frozen => createApiClient(host).send("POST", "/v1/app/tasks/" + encodeURIComponent(row.id) + "/comments", frozen, { parse: (value: unknown) => value }, { retry: "never", pendingIsUnknown: true }));
  if (result.kind !== "done") throw new ApiError(409, "PENDING", "Your comment is waiting for confirmation.");
  await query.invalidateQueries({ queryKey: ["work", "comments", row.id] });
 };
 const controls = <div className="rv-task-controls"><TaskActionNotice key={planComment.pendingKey} pending={planComment.pending} recovery={planComment.recovery} taskHref={"/app/sessions/" + encodeURIComponent(sessionId ?? id)} check={() => sessionId === undefined ? query.invalidateQueries({ queryKey: ["work"] }) : api.read(sessionId)} />
  {row !== undefined && <TaskActions taskId={row.id} sessionId={sessionId} canContinue={row.step !== "merged" && row.step !== "closed"} task={row.task} showNote={sessionId === undefined && row.group !== "done"} />}
  {session !== undefined && sessionId !== undefined && <SessionControls key={sessionId} id={sessionId} agent={agent} actions={session.you.actions} following={session.you.following} makeAgent responsive ask={ASK_ON_HOSTED && session.you.live?.ask === true} share={{ orgName }} onPeopleShare={() => { setShareRequest(count => count + 1); }} onChanged={() => query.invalidateQueries({ queryKey: ["live"] })} />}
  {row !== undefined && session === undefined && <TaskAnswers taskId={row.id} project={row.project} title={row.title} />}
 </div>;
 const statusWords = row === undefined ? undefined : row.need ?? row.line;
 const conversationProject = session?.project ?? row?.project;
 const changeDraft = (kind: "comment" | "steer", text: string) => setDrafts(old => { const next = { ...old[draftKey] ?? { comment: "", steer: "" }, [kind]: text };if (identity.data !== undefined) { try { host.storage.set(draftKey + ":draft", JSON.stringify(next)); } catch { /* The visible draft stays on this page. */ } }return { ...old, [draftKey]: next }; });
 const talkSubline = lifecycle?.receipt?.kind === "steer" && lifecycle.receipt.delivery?.state === "queued" ? "Your instruction · Queued for this build" : restored === draftKey && (drafts[draftKey]?.comment || drafts[draftKey]?.steer) ? "A draft is saved here" : undefined;
 const conversation = session !== undefined && sessionId !== undefined && <Dialog title={selected === undefined ? "Talk to this session" : selected.target === "change_file" ? "Discussion of this file" : selected.target === "step" ? "Discussion of this step" : "Discussion of this plan paragraph"} description={session.title + (conversationProject === undefined ? "" : " · " + conversationProject)} className="rv-conversation-tray rv-task-rebuild-conversation" modal={false} open={open} onOpenChange={setOpen} onCloseAutoFocus={event => { const source = sourceControl.current;if (source?.isConnected) { event.preventDefault();source.focus(); }sourceControl.current = undefined; }} trigger={<Button className="rv-task-session-entry" aria-label="Talk to this session" data-testid="session-conversation-trigger" onClick={() => { setSelection(undefined);sourceControl.current = undefined; }}><TaskMark kind="chat" /><span className="rv-task-session-entry-text"><strong>Talk to this session</strong>{talkSubline !== undefined && <span className="rv-task-session-subline">{talkSubline}</span>}</span><TaskMark kind="chevron" /></Button>}>
 <div className="rv-talk-back"><button type="button" className="rv-button rv-button-quiet" aria-label="Back to the task" onClick={() => setOpen(false)}><svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m15 5-7 7 7 7" /></svg></button></div>
 {selected && <Button variant="quiet" onClick={() => setSelection(undefined)}>All conversation</Button>}
 {selected && currentPart === undefined ? <p>That part of this session is no longer available.</p> : <>
 {selected && currentPart?.revision !== selected.revision && <p className="rv-muted">This discussion refers to an earlier version.</p>}
 {(restored === draftKey || talk.request !== undefined || lifecycle?.lock !== undefined || identity.data === undefined) && <TaskDraftReturnView identity={identity.data} subject={identity.data === undefined ? undefined : { ...identity.data, taskId: row?.id ?? id }} state={identity.data === undefined ? { kind: "unknown" } : { ...identity.data, taskId: row?.id ?? id, kind: "restored", text: talk.request !== undefined && typeof talk.request.body.text === "string" ? talk.request.body.text : lifecycle?.lock !== undefined && typeof lifecycle.lock.body["text"] === "string" ? lifecycle.lock.body["text"] : draftReturn?.key === draftKey ? draftReturn.text : drafts[draftKey]?.comment || drafts[draftKey]?.steer || "", operation: sending ? "sending" : talk.request !== undefined || lifecycle?.lock !== undefined ? "unknown" : draftReturn?.key === draftKey ? draftReturn.operation : "unsent" }} />}
 {messageRefusal !== undefined && <p role="alert" className="rv-error"><VisibleText text={messageRefusal.text + " " + messageRefusal.authority} /></p>}
 {talk.request !== undefined && <p role="status" className="rv-talk-unconfirmed">Rovara didn't confirm this message yet. Your text is kept. <Button onClick={() => { void timeline.reloadMessages().catch(() => undefined); }}>Check</Button></p>}
 {!session.you.actions.includes("steer") && session.you.actions.includes("comment") && <p className="rv-talk-note" data-testid="talk-comment-only">You can comment on this task. Comments are for people; Rovara doesn't read them.</p>}
 <TaskHeldStatesView page="talk" label="Earlier messages" onCheck={() => { void Promise.all([read.refetch(), timeline.reload()]).catch(() => undefined); }} />
 {(() => {
 const latestSteer = [...timeline.messages].reverse().find(message => message.kind === "steer"), ended = commentSeed === undefined && !timeline.error && (lifecycle?.receipt?.kind === "steer" ? lifecycle.receipt.delivery?.state === "not_delivered" : latestSteer?.delivery?.state === "not_delivered");
 const refused = timeline.error instanceof ApiError && [401, 403].includes(timeline.error.status) || lifecycle !== undefined && Object.values(lifecycle.reads).some(value => value.health === "refused");
 const conversationView = <Conversation editDrafts={editDrafts[scope ?? sessionId]} onEditDraftChange={(messageId, draft) => setEditDrafts(old => { const next = { ...old[scope ?? sessionId] };if (draft === undefined) delete next[messageId];else next[messageId] = draft;return { ...old, [scope ?? sessionId]: next }; })} agent={agent} messages={timeline.messages} events={timeline.events} meId={identity.data?.personId} onCopyDraft={host.copyText === undefined ? undefined : draft => host.copyText!(draft)} onEdit={writable && session.you.actions.includes("comment") ? edit : undefined} onDelete={writable && session.you.actions.includes("comment") ? remove : undefined} onReload={messageId => timeline.reloadMessage(messageId)} onPostAsComment={session.you.actions.includes("comment") ? text => { changeDraft("comment", text);setCommentSeed(old => (old ?? 0) + 1); } : undefined} />;
 return <>{timeline.error || refused ? <TalkTimelineReadRecoveryView errorKind={refused ? "refused" : timeline.messages.length > 0 ? "refresh" : "initial"} {...(selected === undefined ? {} : { anchor: selected })} cachedMessages={conversationView} onReload={async () => { await timeline.reload(); }} /> : timeline.loading ? <Skeleton label="Loading conversation" /> : conversationView}
 {planChange !== undefined && instruction !== undefined && session !== undefined && task !== undefined && <TalkPlanChangeHandoffView part="card" sheet={planChange} instruction={instruction} onNavigate={() => setOpen(false)} session={session} decision={!decisions.isError ? decisions.data?.find(entry => entry.card.taskId === task.taskId && entry.card.kind === "approve_plan") : undefined} origin={host.origin} read={decisions.isError || decisions.failureCount > 0 ? "unavailable" : "current"} onReload={() => { void decisions.refetch(); }} />}
 {timeline.hasMore && !timeline.error && <Button busy={timeline.loadingMore} onClick={() => { void timeline.loadMore(); }}>Load more conversation</Button>}
 {lifecycle?.lock?.operation === "question" && <TalkQuestionRecoveryView read="unavailable" waiting={questionWaiting} onCheck={() => { void Promise.all([read.refetch(), timeline.reload()]).catch(() => undefined); }} {...(typeof lifecycle.lock.body["question"] === "string" ? { question: lifecycle.lock.body["question"] } : {})} asker={{ name: nav?.me.name ?? "You", at: lifecycle.lock.startedAt }} />}
 {lifecycle?.lock !== undefined && lifecycle.lock.operation !== "question" && <TalkOutcomeView anchor={{ href: "#task-talk", label: "this conversation" }} message={{ name: nav?.me.name ?? "You", kind: lifecycle.lock.body["kind"] === "comment" ? "comment" : "steer", text: typeof lifecycle.lock.body["text"] === "string" ? lifecycle.lock.body["text"] : "", at: lifecycle.lock.startedAt }} outcome={{ kind: "unknown" }} onCheck={() => { void Promise.all([read.refetch(), timeline.reload()]).catch(() => undefined); }} />}
 {!timeline.error && !refused && lifecycle?.receipt?.kind === "steer" && (lifecycle.receipt.delivery?.state === "queued" ? <TalkOutcomeView anchor={{ href: "#task-talk", label: "this conversation" }} outcome={{ kind: "queued", serverMessage: lifecycle.receipt.text }} /> : lifecycle.receipt.delivery?.state === "not_delivered" ? <TalkOutcomeView anchor={{ href: "#task-talk", label: "this conversation" }} outcome={{ kind: "refused", serverMessage: lifecycle.receipt.text, reason: lifecycle.receipt.delivery.reason ?? "Delivery unavailable" }} /> : null)}
 {ended ? <div id="task-talk"><TalkRefFooter refCode="TALK-BUILD-ENDED" /></div> : <div className={planChange !== undefined ? "rv-talk-dock" : "rv-talk-dock rv-talk-dock-plain"}>{planChange !== undefined && instruction !== undefined && session !== undefined && task !== undefined && <TalkPlanChangeHandoffView part="bar" sheet={planChange} instruction={instruction} onNavigate={() => setOpen(false)} session={session} decision={!decisions.isError ? decisions.data?.find(entry => entry.card.taskId === task.taskId && entry.card.kind === "approve_plan") : undefined} origin={host.origin} read={decisions.isError || decisions.failureCount > 0 ? "unavailable" : "current"} onReload={() => { void decisions.refetch(); }} />}<div id="task-talk"><Composer seed={commentSeed} question={row !== undefined && nav?.features?.answers === true ? <TaskAnswers taskId={row.id} pending={lifecycle?.lock?.operation === "question"} authorityLost={talkQuestionRefused(host, scope)} scope={scope} project={row.project} title={row.title} submitQuestion={async body => {
  setQuestionWaiting(true);
  try { return await talkQuestion(host, scope, resources, body, requestId => createAnswersApi({ ...host, transport: { async request(input) { const response = await host.transport.request(input);if (response.status === 202) throw new ApiError(202, "PENDING", "Rovara didn't confirm this yet.");return response; } } }).ask(row.project, { ...body, requestId })); }
  catch (failure) { await recoverIdentity(failure);throw failure; }
  finally { setQuestionWaiting(false); }
 }} /> : undefined} autoFocus={selected !== undefined} disabled={!writable} agent={agent} actions={selected === undefined ? session.you.actions : session.you.actions.filter(action => action !== "steer")} onSend={send} sending={sending} compact={selected === undefined && (lifecycle?.lock !== undefined && lifecycle.lock.operation !== "question" || lifecycle?.receipt?.kind === "steer" || timeline.messages.some(message => message.kind === "steer" && message.delivery !== undefined))} collapseQuestion={selected === undefined && lifecycle?.lock?.operation === "question"} collapseAlways={selected === undefined && planChange !== undefined} settleNote={lifecycle?.lock !== undefined && lifecycle.lock.operation !== "question" ? "Wait until this message is settled before writing another. Nothing else is queued." : undefined} drafts={drafts[draftKey] ?? { comment: "", steer: "" }} onDraftChange={changeDraft} /></div></div>}</>;
 })()}</>}</Dialog>;
 // The earlier tabs stay one click away; they open by themselves when the page has nothing else to offer (no decision card for a task that waits on a person, or no readable task).
 const feedbackOn = row !== undefined && !hasAnswer && hasPrFeedback(session);
 const mergeAtTop = row !== undefined && !hasAnswer && row.decision === undefined && fullTask !== undefined && hasMergeSection(fullTask) && ["WAIT_FOR_MERGE", "MERGED"].includes(fullTask.workflow?.stage ?? "");
 const detailsOpen = row === undefined || (row.group === "you" && row.decision === undefined) || ((row.task.workflow?.stage === "WAIT_FOR_MERGE" || row.step === "pull_request") && row.decision === undefined);
 const mergeChip: "merged" | "needs_you" | "ready_to_merge" | "checking" | "running" | "stopped" | "blocked" | "waiting_for_merge" | "waiting_for_owner" | undefined = fullTask?.workflow?.stage === "MERGED" ? "merged" : slotChip ?? (feedbackOn ? prFeedbackPageChip(session, feedbackRefused) : undefined) ?? (row?.decision !== undefined && row.group === "you" ? "needs_you" : undefined);
 const sessionHeld = <TaskHeldStatesView page="session" onCheck={() => { void (sessionId === undefined ? tasks : read).refetch(); }} />;
 const aboutSummary = [session?.you.owner === true ? "You own it" : undefined, row?.project !== undefined ? "Project " + visibleText(row.project) : undefined].filter((part): part is string => part !== undefined).join(" · ");
 return <section ref={root} className="rv-session rv-task-full rv-task-rebuild" data-testid="task-page" data-talk-open={open || undefined}>
  {session !== undefined ? <SessionHeader session={session} onAction={() => undefined} controls={controls} facts={false} {...(mergeChip === undefined ? {} : { chipState: mergeChip })} workHref={row === undefined ? paths.live : paths.live + "?task=" + encodeURIComponent(row.id)} />
   : row !== undefined && <header className="rv-session-header rv-page-header" data-testid="session-header"><div className="rv-session-heading"><nav className="rv-page-breadcrumbs" aria-label="Breadcrumb"><ol><li><Link to={paths.live + "?task=" + encodeURIComponent(row.id)}>Work</Link></li><li><VisibleText text={row.project} /></li></ol></nav><h1 tabIndex={-1} data-testid="session-title"><VisibleText text={row.title} /></h1><div className="rv-session-facts rv-page-meta"><span data-testid="session-status" className="rv-session-status"><StatusChip state={slotChip ?? (row.task.status === "STARTING" ? "setting_up" : row.task.workflow?.state === "BLOCKED" ? "blocked" : TONE_CHIP[row.tone])} /><span className="rv-visually-hidden"><VisibleText text={statusWords ?? ""} /></span></span>{clockTime(row.updatedAt) !== undefined && <span>Updated <time dateTime={row.updatedAt}>{clockTime(row.updatedAt)}</time></span>}</div></div><div className="rv-session-people">{controls}</div></header>}
  {controlsFailed && <TaskControlsReadRecoveryView reloadControls={() => { void read.refetch(); }}>{null}</TaskControlsReadRecoveryView>}
  {session?.status === "starting" && row !== undefined && <TaskStartReceiptView outcome={{ kind: "confirmed", request: { id: row.id, text: row.title, textKind: "task-title" }, currentPhase: "accepted", phases: [{ kind: "accepted" }] }} />}
  {session !== undefined && task !== undefined && <TalkPlanChangeHandoffView onPage={row?.decision?.card.kind === "approve_plan" && row.decision.card.status === "pending"} hideNote={planChange !== undefined} session={session} decision={!decisions.isError ? decisions.data?.find(entry => entry.card.taskId === task.taskId && entry.card.kind === "approve_plan") : undefined} origin={host.origin} read={decisions.isError || decisions.failureCount > 0 ? "unavailable" : "current"} onReload={() => { void decisions.refetch(); }} />}
  {session !== undefined && <MoneyBanners session={session} />}{task?.setupRecheck !== undefined && <p className="rv-muted rv-task-setup-line" role="status" data-testid="task-setup-evidence"><VisibleText text={task.setupRecheck} /></p>}{connection === "reconnecting" && <p className="rv-muted" role="status">Reconnecting. Showing the last update.</p>}
  {(row === undefined || hasAnswer) && conversation !== false && <div className="rv-task-bar">{conversation}</div>}
  {designTask !== undefined && <DesignActions task={designTask} sessionKey={designKey} />}
  {session !== undefined && fullTask !== undefined && <AnsweredSection session={session} task={fullTask} />}
  {row !== undefined && !hasAnswer && <TaskPane wide retryOffered={session?.you.actions.includes("retry") ?? false} pageLocked={planComment.locked} sessionEntry={conversation} aboutSummary={aboutSummary} aboutExtra={<>{session !== undefined && <SessionFacts session={session} />}{sessionHeld}</>} primary={feedbackOn && session !== undefined ? <><Suspense fallback={null}><PrFeedbackCard sessionId={session.sessionId} session={session} readFailed={read.isError || read.failureCount > 0} onCheck={() => { void read.refetch(); }} /></Suspense>{mergeAtTop && fullTask !== undefined && <MergeSection sessionId={session.sessionId} task={fullTask} />}</> : mergeAtTop && session !== undefined && fullTask !== undefined ? <MergeSection sessionId={session.sessionId} task={fullTask} /> : undefined} railOverride={feedbackOn ? prFeedbackRail(session, feedbackPress.request !== undefined, feedbackRefused) : undefined} pageProjection={(byTask && tasks.isError) || (sessionId !== undefined && read.isError) || connection === "reconnecting" ? "stale" : "current"} row={row} decisionsError={decisions.isError ? decisions.error : undefined} onDecided={onDecided} planChange={planChange} steer={steer} onComment={comment} design={design} />}
  {(row === undefined || hasAnswer) && <>{sessionHeld}{session !== undefined && <SessionFacts session={session} />}</>}
  <details className="rv-task-section" open={shareRequest > 0 || undefined}><summary><TaskMark kind="chevron" /><strong>People and decisions</strong><span className="rv-task-section-summary">Task access and recorded answers</span></summary>
   <div className="rv-task-section-body">
   {session !== undefined && sessionId !== undefined && <PeoplePanel key={sessionId} id={sessionId} shareRequest={shareRequest} />}
   {session !== undefined && sessionId !== undefined && <DecisionsCard key={"decisions-" + sessionId} id={sessionId} local />}
   {row !== undefined && <WikiTaskUseCard project={row.project} taskId={row.id} />}
   </div>
  </details>
  {session !== undefined && <details className="rv-task-more rv-task-section" open={detailsOpen || undefined}><summary><TaskMark kind="chevron" /><strong>More about this task</strong><span className="rv-task-section-summary">Changes, design and evidence</span></summary>
   <div className="rv-session-work rv-task-section-body"><Workspace session={session} receiptInPage mergeInPage={mergeAtTop} onComment={discuss} /></div>
  </details>}
 </section>;
}
