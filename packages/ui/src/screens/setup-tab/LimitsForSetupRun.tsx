import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { setupLimitsKey, useSetupLimitsApi, type ProjectLimits, type SetupLimitName } from "../../api/setup-limits.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { limitShown } from "../setup/limits-text.js";
import { LIMIT_ORDER, LIMIT_ROWS, LIMITS, OPEN_POINTS } from "./setup-tab-text.js";
import { fieldHelper, fieldText, restHelper, settingOfFields, startFields, type Fields } from "./limits-model.js";
import { NOT_SERVED, limitsHidden, useProjectLimits } from "./use-setup-tab.js";

type Message = { kind: "status" | "alert"; text: string; button?: "read" | "check" };

/**
 * "Limits for a setup run" (2): five read-only lines at the bottom of the Setup tab, and a Change limits button for a person who may save. The form is hidden until then; its fields start from the value in force with the unit
 * beside each. Saving sends the revision the person saw once (a lost answer is checked through a read, never sent again blind). A Code that does not serve the limits, or a person who may not read them, leaves no section at all.
 */
export function LimitsForSetupRun({ project, canChange, company = "Your company", focus, onFocused }: { project: string; canChange: boolean; company?: string | undefined; /** A stop's "Change the … limit" button: open the form with this field in focus. */ focus?: SetupLimitName | undefined; onFocused?: () => void }) {
  const api = useSetupLimitsApi(), client = useQueryClient(), key = setupLimitsKey(project);
  const read = useProjectLimits(project, true);
  const [editing, setEditing] = useState(false), [message, setMessage] = useState<Message>();
  // A stop's "Change the … limit" button opens the form (set while rendering, not in an effect).
  const [seenFocus, setSeenFocus] = useState<SetupLimitName>();
  if (focus !== seenFocus) { setSeenFocus(focus); if (focus !== undefined && canChange) setEditing(true); }
  if (read.data === NOT_SERVED || limitsHidden(read.error)) return null;
  const view = read.data;
  const fresh = !read.isFetching && !read.isError;
  const reread = async () => { await client.invalidateQueries({ queryKey: key }); return client.getQueryState(key)?.status === "success"; };
  const body = read.isPending ? <Skeleton label={LIMITS.loading} />
    : view === undefined ? <><p role="alert" data-testid="limits-load-failed">{LIMITS.loadFailed}</p><Button onClick={() => { void read.refetch(); }}>{LIMITS.readAgain}</Button></>
    : editing && canChange
      ? <Editor key={view.revision} project={project} view={view} company={company} api={api} fresh={fresh} focus={focus} onFocused={onFocused} message={message} setMessage={setMessage}
        onSaved={next => { client.setQueryData(key, next); setEditing(false); setMessage({ kind: "status", text: LIMITS.saved }); }} onReread={reread} onCancel={() => { setEditing(false); setMessage(undefined); }} />
      : <>
        <ul className="rv-setup-rows" aria-label={LIMITS.heading} data-testid="limits-lines">{LIMIT_ORDER.map(name => <li key={name} className="rv-setup-row" data-testid={`limit-${name}`}>
          <div className="rv-setup-row-main"><strong>{LIMIT_ROWS[name].label}</strong><p data-testid={`limit-${name}-value`}>{LIMIT_ROWS[name].rest(limitShown(name, view.effective[name]))}</p><p className="rv-muted">{restHelper(view, name, company)}</p></div>
        </li>)}</ul>
        {message?.kind === "status" && <p role="status" data-testid="limits-saved">{message.text}</p>}
      </>;
  return <section className="rv-setup-section" aria-labelledby="rv-setup-limits-heading" data-testid="setup-limits">
    <div className="rv-setup-section-head"><h2 id="rv-setup-limits-heading">{LIMITS.heading}</h2>{view !== undefined && canChange && !editing && <Button data-testid="limits-change" onClick={() => { setEditing(true); setMessage(undefined); }}>{LIMITS.change}</Button>}</div>
    <p className="rv-muted">{LIMITS.intro}{OPEN_POINTS.limitStopKeepsCommands ? LIMITS.introKept : ""}</p>
    {body}
  </section>;
}

function Editor({ project, view, company, api, fresh, focus, onFocused, message, setMessage, onSaved, onReread, onCancel }: {
  project: string; view: ProjectLimits; company: string; api: ReturnType<typeof useSetupLimitsApi>; fresh: boolean; focus: SetupLimitName | undefined; onFocused: (() => void) | undefined;
  message: Message | undefined; setMessage: (message: Message | undefined) => void; onSaved: (view: ProjectLimits) => void; onReread: () => Promise<boolean>; onCancel: () => void;
}) {
  const [fields, setFields] = useState<Fields>(() => startFields(view)), [busy, setBusy] = useState(false);
  const sending = useRef(false), attempt = useRef<{ key: string; id: string } | undefined>(undefined);
  const { setting, problems, dirty } = settingOfFields(view, fields, company);
  useEffect(() => { if (focus !== undefined) { document.getElementById(`setup-limit-${focus}`)?.focus(); onFocused?.(); } }, [focus]); // eslint-disable-line react-hooks/exhaustive-deps
  async function save() {
    if (sending.current || !fresh || Object.keys(problems).length > 0 || !dirty) return;
    const body = { expectedRevision: view.revision, limits: setting }, requestKey = JSON.stringify(body);
    if (attempt.current?.key !== requestKey) attempt.current = { key: requestKey, id: crypto.randomUUID() };
    sending.current = true; setBusy(true); setMessage(undefined);
    try { onSaved(await api.setProject(project, { requestId: attempt.current.id, ...body })); }
    catch (error) {
      if (error instanceof ApiError && error.code === "CHANGE_STALE") setMessage((await onReread()) ? { kind: "alert", text: LIMITS.stale } : { kind: "alert", text: LIMITS.staleUnread, button: "read" });
      // A write that may have landed (the server could not say, or the answer was lost): read the limits again before anything else; the same change sent again carries the same request id.
      else if (!(error instanceof ApiError) || error.status >= 500) { const ok = await onReread(); setMessage(error instanceof ApiError && !/outcome is unknown/iu.test(error.message) ? { kind: "alert", text: error.message } : ok ? { kind: "alert", text: LIMITS.noReply } : { kind: "alert", text: LIMITS.noReplyUnread, button: "check" }); }
      else setMessage({ kind: "alert", text: error.message });
    } finally { sending.current = false; setBusy(false); }
  }
  return <div aria-busy={busy} data-testid="limits-form">
    {LIMIT_ORDER.map(name => {
      const id = `setup-limit-${name}`, row = LIMIT_ROWS[name], problem = problems[name], differs = fields[name].trim() !== startFieldOf(view, name), helper = fieldHelper(view, name, company);
      return <div key={name} className="rv-setup-limit-field" data-testid={`limit-field-${name}`}>
        <label htmlFor={id}>{row.label}</label>
        <div className="rv-setup-limit-input">
          {name === "budgetCents" && <span aria-hidden="true">$</span>}
          <input id={id} className="rv-input" inputMode="decimal" autoComplete="off" value={fields[name]} disabled={busy} aria-invalid={problem !== undefined} aria-describedby={`${id}-help`}
            onChange={event => { setFields(current => ({ ...current, [name]: event.target.value })); setMessage(undefined); }} />
          <span className="rv-muted">{row.unit}</span>
          {differs && <Button variant="quiet" disabled={busy} data-testid={`limit-standard-${name}`} aria-label={`${LIMITS.standard}: ${row.label}`} onClick={() => { setFields(current => ({ ...current, [name]: startFieldOf(view, name) })); }}>{LIMITS.standard}</Button>}
        </div>
        {problem === undefined ? <p id={`${id}-help`} className="rv-muted">{helper}</p> : <p id={`${id}-help`} role="alert" className="rv-error">{problem}</p>}
      </div>;
    })}
    <p className="rv-muted" data-testid="limits-applies">{LIMITS.applies}{OPEN_POINTS.savedLimitsApplyToLaterRuns ? LIMITS.appliesRunning : ""}</p>
    <div className="rv-setup-card-actions">
      <Button variant="secondary" busy={busy} disabled={!fresh || !dirty || Object.keys(problems).length > 0} data-testid="limits-save" onClick={() => { void save(); }}>{LIMITS.save}</Button>
      <Button disabled={busy} data-testid="limits-cancel" onClick={onCancel}>{LIMITS.cancel}</Button>
    </div>
    <p role="status">{message?.kind === "status" ? message.text : ""}</p>
    {message?.kind === "alert" && <div role="alert" data-testid="limits-alert"><p><VisibleText text={message.text} /></p>{message.button !== undefined && <Button disabled={busy} onClick={() => { void onReread(); }}>{message.button === "read" ? LIMITS.readLimitsAgain : LIMITS.checkLimits}</Button>}</div>}
  </div>;
}
/** The text a field holds for Rovara's standard. */
function startFieldOf(view: ProjectLimits, name: SetupLimitName): string { return fieldText(name, view.defaults[name]); }
