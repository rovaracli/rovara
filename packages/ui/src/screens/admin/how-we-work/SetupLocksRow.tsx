import { useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../../api/errors.js";
import { SETUP_LIMIT_NAMES, isUnreadable, setupLocksKey, useSetupLimitsApi, type LimitSetting, type ReadableLocks, type SetupLimitName } from "../../../api/setup-limits.js";
import { useAppHost } from "../../../host.js";
import { Button } from "../../../design/Button.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { Switch } from "../../../design/Switch.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { LimitFields } from "../../setup/LimitFields.js";
import { LIMIT_SHORT, SETUP_LOCKS as T, expiresText, limitField, limitShown, sameSetting, settingOfFields } from "../../setup/limits-text.js";
import "./how-we-work.css";

type Message = { kind: "status"; text: string } | { kind: "alert"; text: string; signIn?: boolean };
const fieldsOf = (setting: LimitSetting): Record<SetupLimitName, string> => Object.fromEntries(SETUP_LIMIT_NAMES.map(name => [name, limitField(name, setting[name])])) as Record<SetupLimitName, string>;
const limitsText = (setting: LimitSetting): string => SETUP_LIMIT_NAMES.filter(name => setting[name] !== undefined).map(name => `${LIMIT_SHORT[name]} ${limitShown(name, setting[name]!)}`).join(", ");

/**
 * The company's setup locks (SU-1), for a company admin: whether setup runs are off, the caps on a run's limits, any change that loosens a lock and waits for a DIFFERENT admin (with the time it expires), Approve for that
 * other admin (a sign-in within the last 10 minutes; a refusal for it shows "Sign in again"), and Repair when the stored locks do not read. The server decides who may and what a change is; this row shows its answer and sends one
 * press. Absent (NOT_FOUND) while the setup agent is off. Loaded lazily with the How we work page.
 */
export default function SetupLocksRow() {
 const api = useSetupLimitsApi(), client = useQueryClient(), host = useAppHost(), sending = useRef(false), attempt = useRef<{ key: string; id: string } | undefined>(undefined);
 const read = useQuery({ queryKey: setupLocksKey, queryFn: () => api.locks(), retry: false, refetchOnWindowFocus: false });
 const [busy, setBusy] = useState(false), [message, setMessage] = useState<Message>(), [editing, setEditing] = useState(false);
 if (read.error instanceof ApiError && (read.error.status === 404 || read.error.status === 403)) return null;
 const locks = read.data;
 // One press at a time. A new attempt id only when the request changed, so a repeated press of the same request is the same request.
 async function run(request: string, write: (id: string) => Promise<unknown>, done: (answer: unknown) => string) {
  if (sending.current) return;
  if (attempt.current?.key !== request) attempt.current = { key: request, id: crypto.randomUUID() };
  sending.current = true;setBusy(true);setMessage(undefined);
  try { const answer = await write(attempt.current.id);setMessage({ kind: "status", text: done(answer) });setEditing(false);await client.invalidateQueries({ queryKey: setupLocksKey }); }
  catch (error) {
   if (error instanceof ApiError && error.code === "CHANGE_STALE") { await client.invalidateQueries({ queryKey: setupLocksKey });setMessage({ kind: "alert", text: T.CHANGED }); }
   else if (error instanceof ApiError && error.code === "REAUTH_REQUIRED") setMessage({ kind: "alert", text: error.message, signIn: true });
   else setMessage({ kind: "alert", text: error instanceof ApiError ? error.message : T.FAILED });
  } finally { sending.current = false;setBusy(false); }
 }
 const messageView = <><p role="status">{message?.kind === "status" ? message.text : ""}</p>{message?.kind === "alert" && <p role="alert"><VisibleText text={message.text} />{message.signIn === true && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>{T.SIGN_IN_AGAIN}</Button></>}</p>}</>;
 // One section for every state, so a screen reader's place in it survives the load, a repair and a re-read.
 let body: ReactNode;
 if (read.isPending) body = <Skeleton label={T.LOADING} />;
 else if (locks === undefined) body = <><p role="alert">{T.LOAD_FAILED}</p><div><Button onClick={() => { void read.refetch(); }}>{T.RETRY}</Button></div></>;
 else if (isUnreadable(locks)) {
  const revision = locks.revision;
  body = <>
   <p role="alert"><strong>{T.UNREADABLE_HEADING}</strong></p>
   <p><VisibleText text={locks.message} /></p>
   <p className="rv-muted">{T.REPAIR_HELP}</p>
   <div className="rv-hww-company-actions"><Button variant="primary" busy={busy} onClick={() => { void run("repair:" + String(revision), id => api.repair({ requestId: id, expectedRevision: revision }), () => T.REPAIRED); }}>{T.REPAIR}</Button></div>
   {messageView}
  </>;
 } else {
  const pending = locks.pending;
  body = <>
  <p className="rv-muted">{T.HELP}</p>
  <p><strong>{locks.setupAgentOff ? T.AGENT_OFF : T.AGENT_ON}</strong></p>
  <p className="rv-muted">{locks.setupAgentOff ? T.AGENT_OFF_HELP : T.AGENT_ON_HELP}</p>
  <p>{T.CAPS}: {Object.keys(locks.limits).length === 0 ? T.NO_CAPS : limitsText(locks.limits)}</p>
  <p>{T.IMAGES}: {locks.devcontainerImages === null ? T.IMAGES_NONE : <VisibleText text={locks.devcontainerImages.join(", ")} />}</p>
  <p className="rv-muted">{locks.noSoleOwnerException ? T.SOLE_OWNER_OFF : T.SOLE_OWNER_ON}</p>
  {pending !== undefined && <section aria-label={T.PENDING}><p role="status"><strong>{T.PENDING}</strong></p>
   <p>{T.PENDING_WOULD}: {pending.setupAgentOff ? T.AGENT_OFF : T.AGENT_ON}; {Object.keys(pending.limits).length === 0 ? T.NO_CAPS : limitsText(pending.limits)}.</p>
   <p className="rv-muted">{expiresText(pending.proposedAt)}</p>
   <p className="rv-muted">{pending.byYou ? T.PENDING_MINE : T.PENDING_OTHER}</p>
   {!pending.byYou && locks.revision !== null && <div className="rv-hww-company-actions"><Button variant="primary" busy={busy} onClick={() => { void run("approve:" + pending.digest, id => api.approve({ requestId: id, expectedRevision: locks.revision!, expectedDigest: pending.digest }), () => T.APPROVED); }}>{T.APPROVE}</Button><span className="rv-muted">{T.APPROVE_HELP}</span></div>}
  </section>}
  {editing ? <Editor locks={locks} busy={busy} onCancel={() => { setEditing(false); }} onSave={(request, write, text) => { void run(request, write, answer => (typeof answer === "object" && answer !== null && "status" in answer && answer.status === "applied") ? text.applied : text.waiting); }} api={api} />
   : <div className="rv-hww-company-actions"><Button disabled={busy} onClick={() => { setEditing(true);setMessage(undefined); }}>{T.EDIT}</Button></div>}
  {messageView}
  </>;
 }
 return <section aria-label={T.HEADING} className="rv-hww-company-card rv-hww-suggestions" aria-busy={busy}><h2>{T.HEADING}</h2>{body}</section>;
}

function Editor({ locks, busy, api, onSave, onCancel }: { locks: ReadableLocks; busy: boolean; api: ReturnType<typeof useSetupLimitsApi>; onCancel: () => void; onSave: (request: string, write: (id: string) => Promise<unknown>, text: { applied: string; waiting: string }) => void }) {
 const [fields, setFields] = useState(() => fieldsOf(locks.limits)), [off, setOff] = useState(locks.setupAgentOff);
 const { setting, problems } = settingOfFields(fields, locks.maxima);
 const changedLimits = !sameSetting(setting, locks.limits), changedOff = off !== locks.setupAgentOff;
 const hints = Object.fromEntries(SETUP_LIMIT_NAMES.map(name => [name, `${limitShown(name, locks.defaults[name])} by default, at most ${limitShown(name, locks.maxima[name])}. Leave it empty for no company cap.`])) as Record<SetupLimitName, string>;
 const body = { expectedRevision: locks.revision, ...(changedLimits ? { limits: setting } : {}), ...(changedOff ? { setupAgentOff: off } : {}) };
 return <fieldset className="rv-hww-company-review" disabled={busy}><legend>{T.EDIT}</legend>
  <Switch label={T.TURN_OFF} checked={off} disabled={busy} onCheckedChange={setOff} />
  <LimitFields fields={fields} hints={hints} problems={problems} disabled={busy} onChange={(name, text) => { setFields(current => ({ ...current, [name]: text })); }} />
  <div className="rv-hww-company-actions">
   <Button variant="primary" busy={busy} disabled={busy || (!changedLimits && !changedOff) || Object.keys(problems).length > 0} onClick={() => { onSave("set:" + JSON.stringify(body), id => api.setLocks({ requestId: id, ...body }), { applied: T.SAVED, waiting: T.WAITING }); }}>{T.SAVE}</Button>
   <Button disabled={busy} onClick={onCancel}>Cancel</Button>
  </div>
 </fieldset>;
}
