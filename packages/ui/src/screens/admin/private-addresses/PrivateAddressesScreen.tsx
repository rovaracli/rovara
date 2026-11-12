import { useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { privateAddressesKey, usePrivateAddresses, usePrivateAddressesApi, type PrivateAddressesAnswer, type PrivateAddressesState } from "../../../api/private-addresses.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { TextArea } from "../../../design/TextArea.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { SettingsNote } from "../SettingsNote.js";
import { useAdminContext } from "../AdminLayout.js";
import "../how-we-work/how-we-work.css";

export const PRIVATE_ADDRESSES_TEXT = {
 TITLE: "Internal addresses",
 INTRO: "Tasks can't reach private addresses. List the exact internal servers they need, such as a private package mirror, as host:port. Adding needs a second owner or admin; removing applies at once.",
 CURRENT: "Allowed now",
 NONE: "None. Tasks reach no internal address.",
 PENDING: "Waiting for a second owner or admin",
 PENDING_MINE: "You proposed this list. A different owner or admin has to approve it.",
 PENDING_OTHER: "Another admin proposed this list. Check every entry before you approve it.",
 ADDS: "Adds", REMOVES: "Removes", NEW_LIST: "The list after approval",
 APPROVE: "Approve this list", WITHDRAW_MINE: "Withdraw", WITHDRAW_OTHER: "Turn down",
 EDIT: "Change the list",
 FIELD: "One host:port per line",
 HINT: "For example nexus.corp.example:8081 or 10.20.0.15:443. No wildcards, ranges or IPv6.",
 SAVE: "Save",
 READ_ONLY: "Only company owners and admins change this list.",
 APPLIED: "Saved. Workers started from now on use the new list.",
 ASKED: "Proposed. A different owner or admin has to approve it.",
 APPROVED: "Approved. Workers started from now on use the new list.",
 WITHDRAWN: "The proposal was withdrawn.",
 FAILED: "That didn't work. Try again.",
 SIGN_IN_AGAIN: "Sign in again",
 LOAD_FAILED: "The list could not be read.", RETRY: "Try again",
 APPLIES: "A change applies to workers that start after it. Names are looked up once when a worker starts, and only the addresses found then are reachable.",
 AUDIT_LINK: "See changes in the audit",
} as const;
const T = PRIVATE_ADDRESSES_TEXT;
type Message = { kind: "status"; text: string } | { kind: "alert"; text: string; signIn?: boolean };

function useWrite(orgId: string, developerId: string) {
 const query = useQueryClient(), host = useAppHost(), sending = useRef(false), key = privateAddressesKey(orgId, developerId);
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>();
 async function run(write: () => Promise<PrivateAddressesAnswer>, done: (answer: PrivateAddressesAnswer) => string) {
  if (sending.current) return false;
  sending.current = true;setBusy(true);setMessage(undefined);
  try {
   const answer = await write();
   setMessage({ kind: "status", text: done(answer) });
   await query.invalidateQueries({ queryKey: key });
   return true;
  } catch (error) {
   if (error instanceof ApiError && error.code === "CHANGE_STALE") void query.invalidateQueries({ queryKey: key });
   if (error instanceof ApiError) setMessage({ kind: "alert", text: error.message, signIn: error.code === "REAUTH_REQUIRED" });
   else setMessage({ kind: "alert", text: T.FAILED });
   return false;
  } finally { sending.current = false;setBusy(false); }
 }
 const view = <>
  <p role="status">{message?.kind === "status" ? message.text : ""}</p>
  {message?.kind === "alert" && <p role="alert"><VisibleText text={message.text} />{message.signIn === true && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>{T.SIGN_IN_AGAIN}</Button></>}</p>}
 </>;
 return { run, busy, view };
}
type Write = ReturnType<typeof useWrite>;

const List = ({ label, entries }: { label: string; entries: readonly string[] }) => <ul aria-label={label}>{entries.map(entry => <li key={entry}><code><VisibleText text={entry} /></code></li>)}</ul>;

function PendingSection({ state, write }: { state: PrivateAddressesState; write: Write }) {
 const api = usePrivateAddressesApi(), pending = state.pending;
 if (pending === undefined) return null;
 return <section aria-label={T.PENDING} className="rv-hww-company-card" aria-busy={write.busy}><h2>{T.PENDING}</h2>
  <p>{pending.proposedByYou ? T.PENDING_MINE : T.PENDING_OTHER}</p>
  {pending.added.length > 0 && <><h3>{T.ADDS}</h3><List label={T.ADDS} entries={pending.added} /></>}
  {pending.removed.length > 0 && <><h3>{T.REMOVES}</h3><List label={T.REMOVES} entries={pending.removed} /></>}
  <h3>{T.NEW_LIST}</h3>{pending.entries.length === 0 ? <p>{T.NONE}</p> : <List label={T.NEW_LIST} entries={pending.entries} />}
  {state.canChange && <div className="rv-hww-company-actions">
   {!pending.proposedByYou && <Button variant="primary" busy={write.busy} onClick={() => { void write.run(() => api.approve(pending.changeId, pending.digest), () => T.APPROVED); }}>{T.APPROVE}</Button>}
   <Button busy={write.busy} onClick={() => { void write.run(() => api.withdraw(pending.changeId), () => T.WITHDRAWN); }}>{pending.proposedByYou ? T.WITHDRAW_MINE : T.WITHDRAW_OTHER}</Button>
  </div>}
 </section>;
}

function EditSection({ state, write }: { state: PrivateAddressesState; write: Write }) {
 const api = usePrivateAddressesApi(), [draft, setDraft] = useState<string>();
 if (!state.canChange) return <section aria-label={T.EDIT} className="rv-hww-company-card"><h2>{T.EDIT}</h2><p>{T.READ_ONLY}</p></section>;
 const text = draft ?? state.entries.join("\n");
 const entries = text.split("\n").map(line => line.trim()).filter(line => line !== "");
 return <section aria-label={T.EDIT} className="rv-hww-company-card" aria-busy={write.busy}><h2>{T.EDIT}</h2>
  <TextArea label={T.FIELD} hint={T.HINT} rows={Math.min(Math.max(entries.length + 1, 3), state.max + 1)} value={text} spellCheck={false} autoCapitalize="none" onChange={event => { setDraft(event.target.value); }} />
  <div className="rv-hww-company-actions"><Button variant="primary" busy={write.busy} disabled={draft === undefined} onClick={() => {
   void write.run(() => api.propose(state.revision, entries), answer => answer.status === "needs_approval" ? T.ASKED : T.APPLIED).then(ok => { if (ok) setDraft(undefined); });
  }}>{T.SAVE}</Button></div>
 </section>;
}

/**
 * Company settings: the internal addresses tasks may reach (owner decision 123). The approved list, the proposal waiting for a second admin (what it adds and removes, the whole list after it), and a plain editor of the
 * whole list. The server checks every entry and says what is wrong by its position; this screen shows the answer and sends one press.
 */
export function PrivateAddressesScreen() {
 const { orgId, developerId } = useAdminContext(), read = usePrivateAddresses(orgId, developerId), write = useWrite(orgId, developerId);
 if (read.isPending) return <section aria-label={T.TITLE} aria-busy="true"><Skeleton label="Loading the internal addresses" /></section>;
 if (read.data === undefined) return <section><PageHeader focusOnMount title={T.TITLE} />{read.error instanceof ApiError && read.error.code === "FORBIDDEN" ? <p>{T.READ_ONLY}</p> : <><p role="alert">{T.LOAD_FAILED}</p><div><Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button></div></>}</section>;
 const state = read.data;
 return <section aria-label={T.TITLE}><PageHeader focusOnMount title={T.TITLE} description={T.INTRO} /><SettingsNote area="private-addresses" />
  <section aria-label={T.CURRENT} className="rv-hww-company-card"><h2>{T.CURRENT}</h2>
   {state.entries.length === 0 ? <p>{T.NONE}</p> : <List label={T.CURRENT} entries={state.entries} />}
   <p className="rv-muted">{T.APPLIES} {state.revision > 0 && <Link to="/app/admin/audit">{T.AUDIT_LINK}</Link>}</p>
  </section>
  <PendingSection state={state} write={write} />
  <div>{write.view}</div>
  <EditSection state={state} write={write} />
 </section>;
}
