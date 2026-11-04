import { Suspense, lazy, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { SessionIdSchema } from "@agentx/contracts/web";
import { useAppHost } from "../../host.js";
import { createSessionActions } from "../../api/session-actions.js";
import { createSessionApi, acceptSessionRead } from "../../api/sessions.js";
import { ApiError } from "../../api/errors.js";
import type { SendResult } from "../../api/client.js";
import type { ReadSession } from "./SessionHeader.js";
import { ConfirmInBrowser } from "../../confirm/ConfirmInBrowser.js";
import { Button } from "../../design/Button.js";
import { Dialog } from "../../design/Dialog.js";
import { Menu, type MenuItem } from "../../design/Menu.js";
import { MakeAgentDialog } from "../agents/MakeAgentDialog.js";
import { CloseTaskDialog } from "./CloseTaskDialog.js";
import { ShareDialog } from "./ShareDialog.js";
import { VisibleText } from "../../design/VisibleText.js";
// Ask about this task is its own chunk: it is fetched only where the session view offers it.
const AskPanel = lazy(async () => ({ default: (await import("./AskPanel.js")).AskPanel }));
export function SessionControls({ id, agent, actions, following, onChanged, responsive = false, share, makeAgent = false, ask = false }: { id: string; agent: string; actions: readonly string[]; following: boolean; onChanged: () => Promise<unknown>; responsive?: boolean; share?: { orgName: string }; makeAgent?: boolean; ask?: boolean }) {
 const host = useAppHost(), query = useQueryClient(), api = useMemo(() => createSessionActions(host), [host]), sessions = useMemo(() => createSessionApi(host), [host]);
 const [busy, setBusy] = useState(false), [stopOpen, setStopOpen] = useState(false), [error, setError] = useState<string>(), [message, setMessage] = useState<string>();
 const [pending, setPending] = useState<Exclude<SendResult<unknown>, { kind: "done" }>>(), sending = useRef(false), key = ["session", id];
 const ownerRead = useQuery({ queryKey: key, enabled: pending !== undefined, queryFn: async () => acceptSessionRead(query.getQueryData<ReadSession>(key), await sessions.read(id)) });
 async function run(action: "watch" | "stop" | "retry" | "take_over") {
  if (!actions.includes(action) || sending.current || pending !== undefined) return;
  sending.current = true;setBusy(true);setError(undefined);setMessage(undefined);
  try {
   if (action === "watch") {
    const result = await (following ? api.unfollow(id) : api.follow(id));if (result.kind !== "done") throw new ApiError(409, "PENDING", "Following hasn't changed. Refresh to check its status.");
   } else {
    const result = await (action === "stop" ? api.stop(id) : action === "retry" ? api.retry(id) : api.takeOver(id));
    if (result.kind !== "done") { if (action === "take_over") { setPending(result);return; }throw new ApiError(409, "PENDING", "This action is waiting for confirmation. Open the session to continue."); }
    if (action === "retry") { await onChanged();host.navigate("/s/" + SessionIdSchema.parse(result.value.session.sessionId));return; }
    if (action === "stop") { setStopOpen(false);{ const answer = result.value as { stop?: string; message?: string };setMessage(answer.stop === "NOTHING_RUNNING" ? (answer.message ?? "Nothing was running to stop.") : "Stop requested."); } }
   }
   await query.invalidateQueries({ queryKey: key });await onChanged();
  } catch (failure) { setError(failure instanceof ApiError ? failure.message : "Couldn't change this session. Try again."); }
  finally { sending.current = false;setBusy(false); }
 }
 const [shareOpen, setShareOpen] = useState(false), [makeOpen, setMakeOpen] = useState(false), [closeOpen, setCloseOpen] = useState(false);
 const menuTrigger = useRef<HTMLButtonElement>(null), returnFocus = useRef<HTMLElement | null>(null), openingModal = useRef(false);
 function restoreFocus(event: Event) { openingModal.current = false;if (returnFocus.current?.isConnected) { event.preventDefault();returnFocus.current.focus(); }returnFocus.current = null; }
 const disabled = busy || pending !== undefined;
 function handleMenuSelect(action: "watch" | "take_over" | "retry" | "share" | "stop" | "make_agent" | "close") {
  if (action === "stop" || action === "share" || action === "make_agent" || action === "close") { openingModal.current = true;returnFocus.current = menuTrigger.current;if (action === "stop") setStopOpen(true);else if (action === "share") setShareOpen(true);else if (action === "close") setCloseOpen(true);else setMakeOpen(true); }
  else void run(action);
 }
 const hasMenuActions = actions.some(action => ["watch", "take_over", "retry", "stop", "close"].includes(action) || (action === "share" && share !== undefined) || (action === "make_agent" && makeAgent));
 const items: MenuItem[] = [
  ...(actions.includes("watch") ? [{ label: following ? "Following" : "Follow", disabled, onSelect: () => handleMenuSelect("watch") }] : []),
  ...(actions.includes("take_over") ? [{ label: "Take over", disabled, onSelect: () => handleMenuSelect("take_over") }] : []),
  ...(actions.includes("retry") ? [{ label: "Retry", disabled, onSelect: () => handleMenuSelect("retry") }] : []),
  ...(actions.includes("share") && share !== undefined ? [{ label: "Share", disabled, onSelect: () => handleMenuSelect("share") }] : []),
  ...(actions.includes("make_agent") && makeAgent ? [{ label: "Make this an agent", disabled, onSelect: () => handleMenuSelect("make_agent") }] : []),
  ...(actions.includes("stop") ? [{ label: "Stop", disabled, onSelect: () => handleMenuSelect("stop") }] : []),
  ...(actions.includes("close") ? [{ label: "Close task", disabled, onSelect: () => handleMenuSelect("close") }] : []),
 ];
 return <div className="rv-session-controls">{responsive && hasMenuActions && <div className="rv-controls-overflow"><Menu trigger={<Button ref={menuTrigger}>Session actions</Button>} items={items} onCloseAutoFocus={event => { if (openingModal.current) event.preventDefault(); }} /></div>}<div className={responsive ? "rv-actions rv-controls-inline" : "rv-actions"}>{actions.includes("watch") && <Button disabled={disabled} onClick={() => { void run("watch"); }}>{following ? "Following" : "Follow"}</Button>}{actions.includes("take_over") && <Button disabled={disabled} onClick={() => { void run("take_over"); }}>Take over</Button>}{actions.includes("retry") && <Button disabled={disabled} onClick={() => { void run("retry"); }}>Retry</Button>}{actions.includes("stop") && <Dialog title="Stop this session?" description={agent + " stops after its current step. If the task is blocked instead of running, Stop ends it and frees its workspace only while no code has been written; after that, use Close task."} onCloseAutoFocus={restoreFocus} open={stopOpen} onOpenChange={value => { if (!busy) setStopOpen(value); }} trigger={<Button disabled={disabled} onClick={event => { returnFocus.current = event.currentTarget; }}>Stop</Button>}><div className="rv-actions"><Button disabled={busy} onClick={() => setStopOpen(false)}>Keep running</Button><Button variant="danger" busy={busy} onClick={() => { void run("stop"); }}>Stop session</Button></div>{error && <p role="alert"><VisibleText text={error} /></p>}</Dialog>}{actions.includes("close") && <CloseTaskDialog id={id} open={closeOpen} onOpenChange={setCloseOpen} onCloseAutoFocus={restoreFocus} onChecking={() => { void query.invalidateQueries({ queryKey: key }); }} onClosed={async () => { setMessage("Task closed.");await query.invalidateQueries({ queryKey: key });await onChanged(); }} trigger={<Button disabled={disabled} onClick={event => { returnFocus.current = event.currentTarget; }}>Close task</Button>} />}{share && actions.includes("share") && <ShareDialog id={id} orgName={share.orgName} open={shareOpen} onOpenChange={setShareOpen} onCloseAutoFocus={restoreFocus} trigger={<Button disabled={disabled} onClick={event => { returnFocus.current = event.currentTarget; }}>Share</Button>} />}{makeAgent && actions.includes("make_agent") && <MakeAgentDialog id={id} open={makeOpen} onOpenChange={setMakeOpen} onCloseAutoFocus={restoreFocus} trigger={<Button disabled={disabled} onClick={event => { returnFocus.current = event.currentTarget; }}>Make this an agent</Button>} />}</div>{error && !stopOpen && <p role="alert"><VisibleText text={error} /></p>}{message && <p role="status"><VisibleText text={message} /></p>}{ask && <Suspense fallback={null}><AskPanel id={id} /></Suspense>}{pending && (ownerRead.isError ? <p role="alert"><VisibleText text={ownerRead.error instanceof ApiError ? ownerRead.error.message : "Couldn't check ownership. Refresh this page."} /></p> : <ConfirmInBrowser<ReadSession> result={pending} subjectKey={key} isApplied={view => view.you.owner} onApplied={() => { setPending(undefined);setMessage("You now own this session.");void onChanged(); }} />)}</div>;
}
