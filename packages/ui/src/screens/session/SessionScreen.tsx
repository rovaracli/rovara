import { useEffect, useMemo, useRef, useState } from "react";
import { useParams } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import type { ReadAppNav } from "@agentx/contracts/web";
import { createSessionApi, useSession, useSessionTimeline } from "../../api/sessions.js";
import { ApiError } from "../../api/errors.js";
import { useAppHost } from "../../host.js";
import { PRESENCE_HEARTBEAT_SECONDS } from "../../constants.js";
import { createRealtimeClient } from "../../realtime/client.js";
import { createNoticeInvalidator } from "../../realtime/invalidate.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText, visibleText } from "../../design/VisibleText.js";
import { SessionHeader, type ReadSession } from "./SessionHeader.js";
import { MoneyBanners } from "./MoneyBanners.js";
import { Conversation, type CommentDraft } from "./Conversation.js";
import { Composer, type MessageInput, type ComposerDrafts } from "./Composer.js";
import { ShareDialog } from "./ShareDialog.js";
import { usePageVisible } from "./presence.js";
import "./session.css";
export function SessionScreen() {
 const id = useParams().id ?? "", host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionApi(host), [host]), read = useSession(id), visible = usePageVisible();
 const [open, setOpen] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [connection, setConnection] = useState("connecting");
 const [editDrafts, setEditDrafts] = useState<Record<string, Record<string, CommentDraft>>>({});
 const [drafts, setDrafts] = useState<Record<string, ComposerDrafts>>({}), [sending, setSending] = useState(false), sendingRef = useRef(false);
 const root = useRef<HTMLElement>(null), pending = useRef(false), timeline = useSessionTimeline(id, open && read.data !== undefined && !read.isError);
 const session = read.isError ? undefined : read.data, ready = session !== undefined, title = session?.title;
 useEffect(() => { if (ready) root.current?.querySelector<HTMLElement>("h1")?.focus(); }, [ready]);
 useEffect(() => { if (title === undefined) return;host.setTitle?.(visibleText(title) + " · Rovara");return () => host.setTitle?.("Rovara"); }, [host, title]);
 useEffect(() => { if (!ready) return;const invalidator = createNoticeInvalidator(query), realtime = createRealtimeClient(host, { onNotice: notice => invalidator.notice(notice), onStatus: setConnection, onReset: () => invalidator.reset() });realtime.subscribeSession(id);realtime.start();return () => { realtime.stop();invalidator.stop(); }; }, [host, id, query, ready]);
 useEffect(() => {
 if (!visible || !ready) return;let active = true, writing = false;
 const heartbeat = async () => { if (writing) return;writing = true;try { const result = await api.presence(id);if (active && result.kind === "done") query.setQueryData<ReadSession>(["session", id], old => old === undefined ? undefined : { ...old, viewingNow: result.value.viewingNow }); } catch { if (active) void query.invalidateQueries({ queryKey: ["session", id], exact: true }); } finally { writing = false; } };
 void heartbeat();const timer = setInterval(() => { void heartbeat(); }, PRESENCE_HEARTBEAT_SECONDS * 1000);return () => { active = false;clearInterval(timer); };
 }, [api, id, query, visible, ready]);
 async function follow() { if (pending.current || session === undefined) return;pending.current = true;setBusy(true);setError(undefined);try { const result = await api.setFollowing(id, !session.you.following);if (result.kind !== "done") throw new ApiError(409, "PENDING", "This change is waiting for confirmation.");await read.refetch(); } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't change following. Try again."); } finally { pending.current = false;setBusy(false); } }
 async function send(input: MessageInput) {
 if (sendingRef.current) throw new ApiError(409, "PENDING", "Your previous message is still being sent.");sendingRef.current = true;setSending(true);
 try { const result = await api.sendMessage(id, input);if (result.kind !== "done") throw new ApiError(409, "PENDING", "This message is waiting for confirmation.");await query.invalidateQueries({ queryKey: ["session", id, "messages"] }); }
 finally { sendingRef.current = false;setSending(false); }
 }
 async function edit(messageId: string, rev: number, text: string) { const result = await api.editMessage(id, messageId, rev, text);if (result.kind !== "done") throw new ApiError(409, "PENDING", "This change is waiting for confirmation.");await query.invalidateQueries({ queryKey: ["session", id, "messages"] }); }
 async function remove(messageId: string, rev: number) { const result = await api.deleteMessage(id, messageId, rev);if (result.kind !== "done") throw new ApiError(409, "PENDING", "This change is waiting for confirmation.");await query.invalidateQueries({ queryKey: ["session", id, "messages"] }); }

 if (read.isPending) return <section><h1 tabIndex={-1}>Session</h1><Skeleton label="Loading the session" /></section>;
 if (session === undefined) return <section><h1 tabIndex={-1}>Session unavailable</h1><p role="alert"><VisibleText text={read.error instanceof ApiError ? read.error.message : "Couldn't load this session. Try again."} /></p><Button onClick={() => { void read.refetch(); }}>Try again</Button></section>;
 const agent = session.agent?.name ?? "The agent", nav = query.getQueryData<ReadAppNav>(["nav"]), orgName = nav?.org.name ?? "your company";
 return <section ref={root} className="rv-session"><SessionHeader session={session} busy={busy} onAction={action => { if (action === "watch") void follow(); }} shareControl={<ShareDialog id={id} orgName={orgName} />} /><MoneyBanners session={session} />{error && <p role="alert"><VisibleText text={error} /></p>}{connection === "reconnecting" && <p className="rv-muted">Reconnecting. Showing the last update.</p>}
 <div className="rv-session-work"><div className="rv-session-work-heading"><h2>Work in progress</h2><Dialog title="Conversation" className="rv-conversation-tray" open={open} onOpenChange={setOpen} trigger={<Button>Conversation</Button>}>
 {timeline.loading ? <Skeleton label="Loading conversation" /> : timeline.error ? <p role="alert"><VisibleText text={timeline.error instanceof ApiError ? timeline.error.message : "Couldn't load the conversation. Close and reopen to try again."} /></p> : <Conversation editDrafts={editDrafts[id]} onEditDraftChange={(messageId, draft) => setEditDrafts(old => { const next = { ...old[id] };if (draft === undefined) delete next[messageId];else next[messageId] = draft;return { ...old, [id]: next }; })} agent={agent} messages={timeline.messages} events={timeline.events} meId={nav?.me.developerId} onEdit={session.you.actions.includes("comment") ? edit : undefined} onDelete={remove} onReload={async messageId => (await timeline.reloadMessages()).find(message => message.messageId === messageId)} />}{timeline.hasMore && <Button busy={timeline.loadingMore} onClick={() => { void timeline.loadMore(); }}>Load more conversation</Button>}<Composer agent={agent} actions={session.you.actions} onSend={send} sending={sending} drafts={drafts[id] ?? { comment: "", steer: "" }} onDraftChange={(kind, text) => setDrafts(old => ({ ...old, [id]: { ...old[id] ?? { comment: "", steer: "" }, [kind]: text } }))} /></Dialog></div>{session.peek && <p className="rv-session-peek"><VisibleText text={session.peek} /></p>}
 </div></section>;
}
