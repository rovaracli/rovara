import { Suspense, lazy, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ReadAppNav, SessionAnchorRef } from "@agentx/cloud-contracts/web";
import { createSessionApi, useSession, useSessionTimeline } from "../../api/sessions.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { isWorkingAgreementOn } from "../agreement/agreement-flags.js";
import { isReviewGroupsOn } from "../../review-flags.js";
import { isContinueInToolOn } from "./continue-flags.js";
import { continueOffer } from "./continue-in-tool.js";
import { PRESENCE_HEARTBEAT_SECONDS } from "../../constants.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
import { NotFound } from "../../shell/NotFound.js";
import { Unavailable } from "../../shell/Unavailable.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import { SessionHeader, SessionDetails, type ReadSession } from "./SessionHeader.js";
import { TaskLead } from "./TaskLead.js";
import { useTaskPageFlags } from "./task-page-flags.js";
import { EvidenceDetails } from "./EvidenceDetails.js";
import { useIsPhone } from "./use-phone.js";
import { MoneyBanners } from "./MoneyBanners.js";
import { Conversation, type CommentDraft } from "./Conversation.js";
import { Composer, type MessageInput, type ComposerDrafts } from "./Composer.js";
import { SessionControls } from "./SessionControls.js";
import { Workspace } from "./Workspace.js";
import { TaskDesignPanel } from "./DesignActions.js";
import { usePageVisible } from "./presence.js";
// The review card (switch `rovara.reviews` = "v2", off by default): its own chunk, requested only while the switch is on and the page is a task.
const TaskReviewCard = lazy(async () => ({ default: (await import("../reviews/TaskReviewCard.js")).TaskReviewCard }));
import "./session.css";
// "Continue in your own tool" (switch `rovara.continue`): its own chunk, fetched only when the switch is on and this reader may work on the task.
const ContinueInTool = lazy(() => import("./ContinueInTool.js"));
export function SessionScreen() {
 const id = useParams().id ?? "", host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionApi(host), [host]), read = useSession(id), visible = usePageVisible();
 const [open, setOpen] = useState(false), [connection, setConnection] = useState("connecting"), phone = useIsPhone(), flags = useTaskPageFlags();
 const [editDrafts, setEditDrafts] = useState<Record<string, Record<string, CommentDraft>>>({});
 const [drafts, setDrafts] = useState<Record<string, ComposerDrafts>>({}), [sending, setSending] = useState(false), sendingRef = useRef(false);
 const [selection, setSelection] = useState<{ sessionId: string; anchor: SessionAnchorRef }>();
 const sourceControl = useRef<HTMLElement | undefined>(undefined), root = useRef<HTMLElement>(null);
 const session = read.isError ? undefined : read.data, ready = session !== undefined, title = session?.title;
 const selected = selection?.sessionId === id ? selection.anchor : undefined;
 const currentPart = selected === undefined ? undefined : session?.anchors?.find(part => part.target === selected.target && part.targetId === selected.targetId);
 const anchorKey = selected === undefined ? undefined : selected.target + ":" + selected.targetId, draftKey = id + ":" + (anchorKey ?? "all");
 const timeline = useSessionTimeline(id, open && ready && (selected === undefined || currentPart !== undefined), anchorKey);
 const discuss = useCallback((anchor: SessionAnchorRef, source: HTMLElement) => { sourceControl.current = source;setSelection({ sessionId: id, anchor });setOpen(true); }, [id]);
 useEffect(() => { if (ready) root.current?.querySelector<HTMLElement>("h1")?.focus(); }, [ready]);
 useEffect(() => { if (title === undefined) return;host.setTitle?.(visibleText(title) + " · Rovara");return () => host.setTitle?.("Rovara"); }, [host, title]);
 useEffect(() => { if (!ready) return;const invalidator = createNoticeInvalidator(query), realtime = createRealtimeClient(host, { onNotice: notice => invalidator.notice(notice), onStatus: setConnection, onReset: () => invalidator.reset() });realtime.subscribeSession(id);realtime.start();return () => { realtime.stop();invalidator.stop(); }; }, [host, id, query, ready]);
 useEffect(() => {
 if (!visible || !ready) return;let active = true, writing = false;
 const heartbeat = async () => { if (writing) return;writing = true;try { const result = await api.presence(id);if (active && result.kind === "done") query.setQueryData<ReadSession>(["session", id], old => old === undefined ? undefined : { ...old, viewingNow: result.value.viewingNow }); } catch { if (active) void query.invalidateQueries({ queryKey: ["session", id], exact: true }); } finally { writing = false; } };
 void heartbeat();const timer = setInterval(() => { void heartbeat(); }, PRESENCE_HEARTBEAT_SECONDS * 1000);return () => { active = false;clearInterval(timer); };
 }, [api, id, query, visible, ready]);
 async function send(input: MessageInput) {
 if (sendingRef.current) throw new ApiError(409, "PENDING", "Your previous message is still being sent.");sendingRef.current = true;setSending(true);
 try { if (selected !== undefined && currentPart === undefined) throw new ApiError(404, "NOT_FOUND", "That part of this session is no longer available.");const result = await api.sendMessage(id, { ...input, ...(input.kind === "comment" && selected !== undefined ? { anchor: selected } : {}) });if (result.kind !== "done") throw new ApiError(409, "PENDING", "This message is waiting for confirmation.");await query.invalidateQueries({ queryKey: ["session", id, "messages"] }); }
 finally { sendingRef.current = false;setSending(false); }
 }
 async function edit(messageId: string, rev: number, text: string) { const result = await api.editMessage(id, messageId, rev, text);if (result.kind !== "done") throw new ApiError(409, "PENDING", "This change is waiting for confirmation.");await query.invalidateQueries({ queryKey: ["session", id, "messages"] }); }
 async function remove(messageId: string, rev: number) { const result = await api.deleteMessage(id, messageId, rev);if (result.kind !== "done") throw new ApiError(409, "PENDING", "This change is waiting for confirmation.");await query.invalidateQueries({ queryKey: ["session", id, "messages"] }); }

 if (read.isPending) return <section><h1 tabIndex={-1}>Session</h1><Skeleton label="Loading the session" /></section>;
 if (read.error instanceof ApiError && read.error.status === 404) return <NotFound />;
 if (session === undefined) return <section><h1 tabIndex={-1}>Session unavailable</h1><p role="alert"><VisibleText text={read.error instanceof ApiError ? read.error.message : "Couldn't load this session. Try again."} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
 const agent = session.agent?.name ?? "The agent", nav = query.getQueryData<ReadAppNav>(["nav"]), orgName = nav?.org.name ?? "your company";
 // Chains are hidden (the `chains` feature is off in every install): an old link to a chain run says so instead of showing its steps.
 if (session.body.kind === "chain" && nav?.features.chains !== true) return <Unavailable />;
 const lead = flags.leadingHeader, phoneOrder = lead && phone;
 const offer = isContinueInToolOn(host) ? continueOffer(session) : undefined;
 const controls = <SessionControls key={id} id={id} agent={agent} actions={session.you.actions} following={session.you.following} makeAgent responsive ask={session.you.live?.ask === true} share={{ orgName }} onChanged={() => query.invalidateQueries({ queryKey: ["live"] })} />;
 const conversation = <Dialog title={selected === undefined ? "Conversation" : selected.target === "change_file" ? "Discussion of this file" : selected.target === "step" ? "Discussion of this step" : "Discussion of this plan paragraph"} className="rv-conversation-tray" open={open} onOpenChange={setOpen} onCloseAutoFocus={event => { const source = sourceControl.current;if (source?.isConnected) { event.preventDefault();source.focus(); }sourceControl.current = undefined; }} trigger={<Button onClick={() => { setSelection(undefined);sourceControl.current = undefined; }}>Conversation</Button>}>
 {selected && <Button variant="quiet" onClick={() => setSelection(undefined)}>All conversation</Button>}
 {selected && currentPart === undefined ? <p>That part of this session is no longer available.</p> : <>
 {selected && currentPart?.revision !== selected.revision && <p className="rv-muted">This discussion refers to an earlier version.</p>}
 {timeline.loading ? <Skeleton label="Loading conversation" /> : timeline.error ? <p role="alert"><VisibleText text={timeline.error instanceof ApiError ? timeline.error.message : "Couldn't load the conversation. Close and reopen to try again."} /></p> : <Conversation editDrafts={editDrafts[id]} onEditDraftChange={(messageId, draft) => setEditDrafts(old => { const next = { ...old[id] };if (draft === undefined) delete next[messageId];else next[messageId] = draft;return { ...old, [id]: next }; })} agent={agent} messages={timeline.messages} events={timeline.events} meId={nav?.me.developerId} onEdit={session.you.actions.includes("comment") ? edit : undefined} onDelete={remove} onReload={async messageId => (await timeline.reloadMessages()).find(message => message.messageId === messageId)} />}{timeline.hasMore && <Button busy={timeline.loadingMore} onClick={() => { void timeline.loadMore(); }}>Load more conversation</Button>}<Composer autoFocus={selected !== undefined} agent={agent} actions={selected === undefined ? session.you.actions : session.you.actions.filter(action => action !== "steer")} onSend={send} sending={sending} drafts={drafts[draftKey] ?? { comment: "", steer: "" }} onDraftChange={(kind, text) => setDrafts(old => ({ ...old, [draftKey]: { ...old[draftKey] ?? { comment: "", steer: "" }, [kind]: text } }))} /></>}</Dialog>;
 const workActions = offer === undefined ? conversation : <div className="rv-session-work-actions">{conversation}<Suspense fallback={null}><ContinueInTool offer={offer} /></Suspense></div>;
 const designPanel = session.body.kind === "task" && typeof session.body.task === "object" && session.body.task !== null && "taskId" in session.body.task && typeof session.body.task.taskId === "string" ? <TaskDesignPanel session={session} taskId={session.body.task.taskId} /> : null;
 const reviewCard = isReviewGroupsOn(host) && session.body.kind === "task" && typeof session.body.task === "object" && session.body.task !== null && "taskId" in session.body.task && typeof session.body.task.taskId === "string" && "project" in session.body.task && typeof session.body.task.project === "string" ? <Suspense fallback={null}><TaskReviewCard taskId={session.body.task.taskId} project={session.body.task.project} /></Suspense> : null;
 const workspace = <Workspace session={session} onComment={discuss} designRetryAbove={session.body.kind === "task"} agreement={isWorkingAgreementOn(host)} />;
 const banners = <><MoneyBanners session={session} />{connection === "reconnecting" && <p className="rv-muted">Reconnecting. Showing the last update.</p>}</>;
 // The phone order of the leading header (owner decision 40): the lead (its "can I approve?" line first), the decision, then the facts, then the work and its evidence collapsed. The DOM has this order, so a screen reader reads what the eye sees.
 if (phoneOrder) return <section ref={root} className="rv-session" data-lead="phone"><SessionHeader session={session} onAction={() => undefined} lead={<TaskLead session={session} />} detailsBelow />{banners}{designPanel}{reviewCard}<SessionDetails session={session} onAction={() => undefined} controls={controls} />
  <div className="rv-session-work"><div className="rv-session-work-heading"><h2>Work</h2>{workActions}</div><EvidenceDetails>{workspace}</EvidenceDetails></div></section>;
 return <section ref={root} className="rv-session" {...(lead ? { "data-lead": "wide" } : {})}><SessionHeader session={session} onAction={() => undefined} controls={controls} {...(lead ? { lead: <TaskLead session={session} /> } : {})} />{banners}
 <div className="rv-session-work"><div className="rv-session-work-heading"><h2>Work</h2>{workActions}</div>{designPanel}{reviewCard}{workspace}
 </div></section>;
}
