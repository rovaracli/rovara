import { useRef, useState, type RefObject } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { privateAddressesKey, usePrivateAddresses, usePrivateAddressesApi, type PrivateAddressesAnswer, type PrivateAddressesState } from "../../../api/private-addresses.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Dialog } from "../../../design/Dialog.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextArea } from "../../../design/TextArea.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { SettingsNote } from "../SettingsNote.js";
import { useAdminContext } from "../AdminLayout.js";
import "./private-addresses.css";

export const PRIVATE_ADDRESSES_TEXT = {
 TITLE: "Internal addresses",
 INTRO: "Tasks can't reach private addresses. List the exact internal servers they need, such as a private package mirror, as host:port. Adding needs a second owner or admin; removing applies at once.",
 UNREADABLE: "The saved list can't be read, so the company's tasks can't start. Save the list again to replace it.",
 PORTS: "Ports workers may open on this install:",
 WARNINGS: "Check before relying on it",
 CURRENT: "Allowed now",
 NONE: "None. Tasks reach no internal address.",
 PENDING: "Waiting for a second owner or admin",
 PENDING_MINE: "You proposed this list. A different owner or admin has to approve it.",
 PENDING_OTHER: "Another admin proposed this list. Check every entry before you approve it.",
 ADDS: "Adds", REMOVES: "Removes", NEW_LIST: "The list after approval",
 REVIEW: "Review and approve", APPROVE: "Approve this list", WITHDRAW_MINE: "Withdraw", WITHDRAW_OTHER: "Turn down",
 APPROVE_TITLE: "Approve this list?",
 APPROVE_DESCRIPTION: "Approving opens these exact addresses to every task of the company. Check every entry.",
 PROPOSAL_CHANGED: "The proposal changed. Review it again.",
 TURN_DOWN_TITLE: "Turn down this proposal?",
 TURN_DOWN_DESCRIPTION: "Nothing changes in the list. The admin who proposed it can propose it again.",
 TURN_DOWN_CONFIRM: "Turn it down",
 EDIT: "Change the list",
 FIELD: "One host:port per line",
 HINT: "For example nexus.corp.example:8081 or 10.20.0.15:443. No wildcards, ranges or IPv6.",
 SAVE: "Save",
 EDITING_STALE: "The list changed since you started editing. Saving will be refused; discard your changes to see the new list.",
 DISCARD: "Discard my changes and reload",
 REMOVE_TITLE: "Remove these addresses now?",
 REMOVE_DESCRIPTION: "Running workers restart now; a running task is interrupted and retried.",
 REMOVE_CONFIRM: "Remove and save",
 CANCEL: "Cancel",
 READ_ONLY: "Only company owners and admins change this list.",
 ASKED: "Proposed. A different owner or admin has to approve it.",
 APPROVED: "Approved. Workers that start from now on use the new list; any address it removes is closed now, as running workers restart.",
 WITHDRAWN: "The proposal was withdrawn.",
 TURNED_DOWN: "The proposal was turned down.",
 FAILED: "That didn't work. Try again.",
 SIGN_IN_AGAIN: "Sign in again",
 LOAD_FAILED: "The list could not be read.", RETRY: "Try again",
 APPLIES: "An added address applies to workers that start after it is approved. A removed address is closed at once: the company's running workers restart, and a task that was running is interrupted and retried. Names are looked up each time a worker starts, and only the addresses found then are reachable.",
 AUDIT_LINK: "See changes in the audit",
} as const;
const T = PRIVATE_ADDRESSES_TEXT;
/** What a save that removed addresses says: it names them. */
export const savedRemovingText = (removed: readonly string[]) => `Saved. Removed ${removed.join(", ")}: closed now, the company's running workers restart, and a task that was running is interrupted and retried.`;
const SAVED = "Saved.";
type Message = { kind: "status"; text: string; warnings?: readonly string[] } | { kind: "alert"; text: string; signIn?: boolean; stale?: boolean };
type Pending = NonNullable<PrivateAddressesState["pending"]>;
/** The form an entry is compared in (the server stores it lower case and trimmed). */
const normal = (entry: string) => entry.trim().toLowerCase();
const linesOf = (text: string) => text.split("\n").map(line => line.trim()).filter(line => line !== "");

function useWrite(orgId: string, developerId: string) {
 const query = useQueryClient(), host = useAppHost(), sending = useRef(false), key = privateAddressesKey(orgId, developerId);
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>();
 async function run(write: () => Promise<PrivateAddressesAnswer>, done: (answer: PrivateAddressesAnswer) => string) {
  if (sending.current) return false;
  sending.current = true;setBusy(true);setMessage(undefined);
  try {
   const answer = await write();
   const warnings = "warnings" in answer && Array.isArray(answer.warnings) ? answer.warnings.filter((item): item is string => typeof item === "string") : [];
   setMessage({ kind: "status", text: done(answer), ...(warnings.length === 0 ? {} : { warnings }) });
   await query.invalidateQueries({ queryKey: key });
   return true;
  } catch (error) {
   // A stale answer refreshes what is shown; the caller keeps its own draft or frozen proposal, so nothing the person typed or saw is replaced under them.
   if (error instanceof ApiError && error.code === "CHANGE_STALE") void query.invalidateQueries({ queryKey: key });
   if (error instanceof ApiError) setMessage({ kind: "alert", text: error.message, signIn: error.code === "REAUTH_REQUIRED", stale: error.code === "CHANGE_STALE" });
   else setMessage({ kind: "alert", text: T.FAILED });
   return false;
  } finally { sending.current = false;setBusy(false); }
 }
 const view = <>
  <p role="status">{message?.kind === "status" ? message.text : ""}</p>
  {message?.kind === "status" && message.warnings !== undefined && <section aria-label={T.WARNINGS}><h3>{T.WARNINGS}</h3><ul className="rv-pa-list">{message.warnings.map((text, index) => <li key={`${String(index)}:${text}`}><VisibleText text={text} /></li>)}</ul></section>}
  {message?.kind === "alert" && <p role="alert"><VisibleText text={message.text} />{message.signIn === true && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>{T.SIGN_IN_AGAIN}</Button></>}</p>}
 </>;
 return { run, busy, view, message, clear: () => { setMessage(undefined); }, reload: () => query.invalidateQueries({ queryKey: key }) };
}
type Write = ReturnType<typeof useWrite>;

const List = ({ label, entries }: { label: string; entries: readonly string[] }) => <ul aria-label={label} className="rv-pa-list">{entries.map((entry, index) => <li key={`${String(index)}:${entry}`}><code><VisibleText text={entry} /></code></li>)}</ul>;

function ProposalLists({ pending }: { pending: Pick<Pending, "entries" | "added" | "removed"> }) {
 return <>
  {pending.added.length > 0 && <><h3>{T.ADDS}</h3><List label={T.ADDS} entries={pending.added} /></>}
  {pending.removed.length > 0 && <><h3>{T.REMOVES}</h3><List label={T.REMOVES} entries={pending.removed} /></>}
  <h3>{T.NEW_LIST}</h3>{pending.entries.length === 0 ? <p>{T.NONE}</p> : <List label={T.NEW_LIST} entries={pending.entries} />}
 </>;
}

/** Focus goes back to the button that opened a dialog; when that button is gone (the proposal was decided), to the fallback (the page's result line). Called from the dialog's close event only. */
function returnFocus(event: Event, opener: RefObject<HTMLButtonElement | null>, fallback: RefObject<HTMLElement | null>) {
 event.preventDefault();(opener.current?.isConnected === true ? opener.current : fallback.current)?.focus();
}

/**
 * Approve: a dialog that FREEZES the proposal it shows (its id, digest, adds, removes and whole new list) when it opens and sends exactly those. If the live proposal changes while it is open (a refetch brings a
 * different one), Approve is disabled and the person is told to review it again: nothing is approved unseen.
 */
function ApproveDialog({ live, write, fallback }: { live: Pending; write: Write; fallback: RefObject<HTMLElement | null> }) {
 const api = usePrivateAddressesApi(), opener = useRef<HTMLButtonElement>(null);
 const [frozen, setFrozen] = useState<Pending>();
 const changed = frozen !== undefined && (frozen.changeId !== live.changeId || frozen.digest !== live.digest);
 return <Dialog title={T.APPROVE_TITLE} description={T.APPROVE_DESCRIPTION} open={frozen !== undefined} onOpenChange={open => { setFrozen(open ? structuredClone(live) : undefined); }} onCloseAutoFocus={event => { returnFocus(event, opener, fallback); }}
  trigger={<Button ref={opener} variant="primary" busy={write.busy}>{T.REVIEW}</Button>}>
  {frozen !== undefined && <div className="rv-pa-dialog" aria-busy={write.busy}>
   <ProposalLists pending={frozen} />
   {changed && <p role="alert">{T.PROPOSAL_CHANGED}</p>}
   <div className="rv-pa-actions">
    <Button variant="primary" busy={write.busy} disabled={changed} onClick={() => {
     const sent = frozen;
     void write.run(() => api.approve(sent.changeId, sent.digest), () => T.APPROVED).then(() => { setFrozen(undefined); });
    }}>{T.APPROVE}</Button>
    <Button onClick={() => { setFrozen(undefined); }}>{T.CANCEL}</Button>
   </div>
  </div>}
 </Dialog>;
}

/** Turning down another admin's proposal confirms first, and names the proposal it froze. */
function TurnDownDialog({ live, write, fallback }: { live: Pending; write: Write; fallback: RefObject<HTMLElement | null> }) {
 const api = usePrivateAddressesApi(), opener = useRef<HTMLButtonElement>(null);
 const [frozen, setFrozen] = useState<string>();
 return <Dialog title={T.TURN_DOWN_TITLE} description={T.TURN_DOWN_DESCRIPTION} open={frozen !== undefined} onOpenChange={open => { setFrozen(open ? live.changeId : undefined); }} onCloseAutoFocus={event => { returnFocus(event, opener, fallback); }}
  trigger={<Button ref={opener} busy={write.busy}>{T.WITHDRAW_OTHER}</Button>}>
  {frozen !== undefined && <div className="rv-pa-actions">
   <Button variant="danger" busy={write.busy} onClick={() => { const changeId = frozen;void write.run(() => api.withdraw(changeId), () => T.TURNED_DOWN).then(() => { setFrozen(undefined); }); }}>{T.TURN_DOWN_CONFIRM}</Button>
   <Button onClick={() => { setFrozen(undefined); }}>{T.CANCEL}</Button>
  </div>}
 </Dialog>;
}

function PendingSection({ state, write, fallback }: { state: PrivateAddressesState; write: Write; fallback: RefObject<HTMLElement | null> }) {
 const api = usePrivateAddressesApi(), pending = state.pending;
 if (pending === undefined) return null;
 return <section aria-label={T.PENDING} className="rv-pa-card" aria-busy={write.busy}><h2>{T.PENDING}</h2>
  <p>{pending.proposedByYou ? T.PENDING_MINE : T.PENDING_OTHER}</p>
  <ProposalLists pending={pending} />
  {state.canChange && <div className="rv-pa-actions">
   {pending.proposedByYou
    ? <Button busy={write.busy} onClick={() => { const changeId = pending.changeId;void write.run(() => api.withdraw(changeId), () => T.WITHDRAWN); }}>{T.WITHDRAW_MINE}</Button>
    : <><ApproveDialog live={pending} write={write} fallback={fallback} /><TurnDownDialog live={pending} write={write} fallback={fallback} /></>}
  </div>}
 </section>;
}

/** The draft remembers the list and revision it was started from, and a save sends THAT revision: a list that moved meanwhile is refused (CHANGE_STALE), never overwritten. */
interface Draft { text: string; baseRevision: number; baseEntries: readonly string[] }

function EditSection({ state, write, fallback }: { state: PrivateAddressesState; write: Write; fallback: RefObject<HTMLElement | null> }) {
 const api = usePrivateAddressesApi(), [draft, setDraft] = useState<Draft>(), [confirm, setConfirm] = useState<{ entries: string[]; removed: string[]; baseRevision: number }>(), saveButton = useRef<HTMLButtonElement>(null);
 if (!state.canChange) return <section aria-label={T.EDIT} className="rv-pa-card"><h2>{T.EDIT}</h2><p>{T.READ_ONLY}</p></section>;
 const text = draft?.text ?? state.entries.join("\n");
 const entries = linesOf(text);
 const send = (base: number, list: string[], removed: readonly string[]) => write.run(() => api.propose(base, list), answer => answer.status === "needs_approval" ? T.ASKED : removed.length > 0 ? savedRemovingText(removed) : SAVED).then(ok => { if (ok) setDraft(undefined); });
 function save() {
  if (draft === undefined) return;
  const kept = new Set(entries.map(normal));
  const removed = draft.baseEntries.filter(entry => !kept.has(normal(entry)));
  if (removed.length > 0) { setConfirm({ entries, removed, baseRevision: draft.baseRevision });return; }
  void send(draft.baseRevision, entries, []);
 }
 const movedOn = draft !== undefined && draft.baseRevision !== state.revision;
 return <section aria-label={T.EDIT} className="rv-pa-card" aria-busy={write.busy}><h2>{T.EDIT}</h2>
  <TextArea label={T.FIELD} hint={T.HINT} className="rv-pa-field" rows={Math.min(Math.max(entries.length + 1, 3), state.max + 1)} value={text} spellCheck={false} autoCapitalize="none"
   onChange={event => { const value = event.target.value;setDraft(current => current === undefined ? { text: value, baseRevision: state.revision, baseEntries: [...state.entries] } : { ...current, text: value }); }} />
  {(movedOn || (write.message?.kind === "alert" && write.message.stale === true && draft !== undefined)) && <p role="alert" className="rv-pa-stale">{T.EDITING_STALE}</p>}
  <div className="rv-pa-actions">
   <Button ref={saveButton} variant="primary" busy={write.busy} disabled={draft === undefined} onClick={save}>{T.SAVE}</Button>
   {draft !== undefined && (movedOn || (write.message?.kind === "alert" && write.message.stale === true)) && <Button onClick={() => { setDraft(undefined);write.clear();void write.reload(); }}>{T.DISCARD}</Button>}
  </div>
  <Dialog title={T.REMOVE_TITLE} description={T.REMOVE_DESCRIPTION} open={confirm !== undefined} onOpenChange={open => { if (!open) setConfirm(undefined); }} onCloseAutoFocus={event => { returnFocus(event, saveButton, fallback); }}>
   {confirm !== undefined && <div className="rv-pa-dialog" aria-busy={write.busy}>
    <h3>{T.REMOVES}</h3><List label={T.REMOVES} entries={confirm.removed} />
    <div className="rv-pa-actions">
     <Button variant="danger" busy={write.busy} onClick={() => { const sent = confirm;void send(sent.baseRevision, sent.entries, sent.removed).then(() => { setConfirm(undefined); }); }}>{T.REMOVE_CONFIRM}</Button>
     <Button onClick={() => { setConfirm(undefined); }}>{T.CANCEL}</Button>
    </div>
   </div>}
  </Dialog>
 </section>;
}

/**
 * Company settings: the internal addresses tasks may reach (owner decision 123). The approved list, the proposal waiting for a second admin (what it adds and removes, the whole list after it), and a plain editor of the
 * whole list. The server checks every entry and says what is wrong by its position; this screen shows the answer and sends one press. A save sends the revision the edit started from; an approval sends the proposal the
 * dialog showed; removals and turning a proposal down confirm first.
 */
export function PrivateAddressesScreen() {
 const { orgId, developerId } = useAdminContext(), read = usePrivateAddresses(orgId, developerId), write = useWrite(orgId, developerId), result = useRef<HTMLDivElement>(null);
 if (read.isPending) return <section aria-label={T.TITLE} aria-busy="true"><Skeleton label="Loading the internal addresses" /></section>;
 if (read.data === undefined) return <section><PageHeader focusOnMount title={T.TITLE} />{read.error instanceof ApiError && read.error.code === "FORBIDDEN" ? <p>{T.READ_ONLY}</p> : <><p role="alert">{T.LOAD_FAILED}</p><div><Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button></div></>}</section>;
 const state = read.data;
 return <section aria-label={T.TITLE} className="rv-pa"><PageHeader focusOnMount title={T.TITLE} description={T.INTRO} /><SettingsNote area="private-addresses" />
  {state.unreadable === true && <p role="alert">{T.UNREADABLE}</p>}
  <section aria-label={T.CURRENT} className="rv-pa-card"><h2>{T.CURRENT}</h2>
   {state.entries.length === 0 ? <p>{T.NONE}</p> : <List label={T.CURRENT} entries={state.entries} />}
   <p className="rv-muted">{T.PORTS} {state.openPorts.join(", ")}.</p>
   <p className="rv-muted">{T.APPLIES} {state.revision > 0 && <Link to="/app/admin/audit">{T.AUDIT_LINK}</Link>}</p>
  </section>
  <PendingSection state={state} write={write} fallback={result} />
  <div className="rv-pa-result" ref={result} tabIndex={-1}>{write.view}</div>
  <EditSection state={state} write={write} fallback={result} />
 </section>;
}
