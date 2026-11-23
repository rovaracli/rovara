import { useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { ApiError } from "../../api/errors.js";
import { SETUP_LIMIT_NAMES, setupLimitsKey, useSetupLimitsApi, type LimitSetting, type ProjectLimits, type SetupLimitName } from "../../api/setup-limits.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { LimitFields } from "./LimitFields.js";
import { LIMIT_LABELS, PROJECT_LIMITS as T, limitField, limitShown, settingOfFields } from "./limits-text.js";

/** What the read keeps when Code does not serve the limits at all. */
const NOT_SERVED = "not_served" as const;
const fieldsOf = (setting: LimitSetting): Record<SetupLimitName, string> => Object.fromEntries(SETUP_LIMIT_NAMES.map(name => [name, limitField(name, setting[name])])) as Record<SetupLimitName, string>;

/**
 * The project's setup limits (SU-1): what a setup run of this project may use, the company's caps beside them, and the boxes to change them. Only a project maintainer reaches this, and only while the setup agent is on;
 * the server decides both and answers "not found" or "forbidden" otherwise, and then this shows nothing at all. A value above the company's cap is refused by the server, and the page keeps its boxes below it too.
 * Loaded lazily: nothing of it is in the first page.
 */
export function SetupLimitsSection({ project }: { project: string }) {
 const api = useSetupLimitsApi(), client = useQueryClient(), key = setupLimitsKey(project);
 // A Code that does not serve the limits (Cloud's fixed 501 NOT_ON_CODE_YET, or Code's own route-not-found 404) does not start serving them in minutes: that answer is kept as an answer for ten minutes, so a page that
 // remounts or polls does not ask again every few seconds (prod asked 354 times in three hours). The card is then hidden: no form, no button.
 const read = useQuery({ queryKey: key, queryFn: async () => {
  try { return await api.project(project); }
  catch (error) { if (error instanceof ApiError && (error.status === 404 || (error.status === 501 && error.code === "NOT_ON_CODE_YET"))) return NOT_SERVED; throw error; }
 }, retry: false, refetchOnWindowFocus: false, staleTime: 10 * 60_000 });
 const view = read.data === NOT_SERVED ? undefined : read.data;
 if (read.data === NOT_SERVED) return null;
 if (read.error instanceof ApiError && (read.error.status === 404 || read.error.status === 403 || (read.error.status === 501 && read.error.code === "NOT_ON_CODE_YET"))) return null;
 // One section for every state, so a screen reader's place in it survives the load, a save and a re-read.
 const body = read.isPending ? <Skeleton label={T.LOADING} />
  : view === undefined ? <><p role="alert">{T.LOAD_FAILED}</p><Button onClick={() => { void read.refetch(); }}>{T.TRY_AGAIN}</Button></>
  // A new revision is a new form: the boxes start from what the server holds.
  // Rule #14: Save is offered only while this read is fresh; a re-read that failed is said as such, never as done.
  : <Editor key={view.revision} project={project} view={view} api={api} fresh={!read.isFetching && !read.isError} onRetry={() => { void read.refetch(); }} onView={next => { client.setQueryData(key, next); }} onStale={async () => { await client.invalidateQueries({ queryKey: key }); return client.getQueryState(key)?.status === "success"; }} />;
 return <section className="rv-project-section" aria-label={T.HEADING}><h2>{T.HEADING}</h2>{body}</section>;
}

function Editor({ project, view, api, fresh, onRetry, onView, onStale }: { project: string; view: ProjectLimits; api: ReturnType<typeof useSetupLimitsApi>; fresh: boolean; onRetry: () => void; onView: (view: ProjectLimits) => void; onStale: () => Promise<boolean> }) {
 const [fields, setFields] = useState(() => fieldsOf(view.limits)), [busy, setBusy] = useState(false), [message, setMessage] = useState<{ kind: "status" | "alert"; text: string }>();
 const sending = useRef(false), attempt = useRef<{ key: string; id: string } | undefined>(undefined);
 // The most a box may hold: Rovara's most, or the company's cap when that is lower.
 const most = Object.fromEntries(SETUP_LIMIT_NAMES.map(name => [name, Math.min(view.maxima[name], view.companyLock[name] ?? view.maxima[name])])) as Record<SetupLimitName, number>;
 const { setting, problems } = settingOfFields(fields, most);
 const dirty = SETUP_LIMIT_NAMES.some(name => fields[name].trim() !== limitField(name, view.limits[name]));
 const hints = Object.fromEntries(SETUP_LIMIT_NAMES.map(name => [name, `${T.DEFAULT} ${limitShown(name, view.defaults[name])}. ${T.MOST} ${limitShown(name, view.maxima[name])}. ${view.companyLock[name] === undefined ? T.NO_CAP : `${T.CAP} ${limitShown(name, view.companyLock[name])}`}.`])) as Record<SetupLimitName, string>;
 async function save() {
  if (sending.current || !fresh || Object.keys(problems).length > 0 || !dirty) return;
  const body = { expectedRevision: view.revision, limits: setting }, key = JSON.stringify(body);
  if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
  sending.current = true;setBusy(true);setMessage(undefined);
  try { onView(await api.setProject(project, { requestId: attempt.current.id, ...body }));setMessage({ kind: "status", text: T.SAVED }); }
  catch (error) {
   if (error instanceof ApiError && error.code === "CHANGE_STALE") setMessage({ kind: "alert", text: (await onStale()) ? T.STALE : T.STALE_UNREAD });
   // A write that may have landed (the server could not say, or the answer was lost): read the limits again before anything else; the same change sent again carries the same request id.
   else if (!(error instanceof ApiError) || error.status >= 500) { const reread = await onStale();setMessage({ kind: "alert", text: error instanceof ApiError && !/outcome is unknown/iu.test(error.message) ? error.message : reread ? T.UNKNOWN : T.UNKNOWN_UNREAD }); }
   else setMessage({ kind: "alert", text: error.message });
  } finally { sending.current = false;setBusy(false); }
 }
 return <div aria-busy={busy}>
  <p className="rv-muted">{T.HELP}</p>
  <p>{T.NOW}: {SETUP_LIMIT_NAMES.map((name, index) => <span key={name}>{index > 0 && "; "}{LIMIT_LABELS[name]} <strong>{limitShown(name, view.effective[name])}</strong></span>)}.</p>
  <LimitFields fields={fields} hints={hints} problems={problems} disabled={busy} onChange={(name, text) => { setFields(current => ({ ...current, [name]: text }));setMessage(undefined); }} />
  <Button variant="primary" busy={busy} disabled={!fresh || !dirty || Object.keys(problems).length > 0} onClick={() => { void save(); }}>{T.SAVE}</Button>
  {!fresh && !busy && message?.kind === "alert" && <Button onClick={onRetry}>{T.READ_AGAIN}</Button>}
  <p role="status">{message?.kind === "status" ? message.text : ""}</p>
  {message?.kind === "alert" && <p role="alert"><VisibleText text={message.text} /></p>}
 </div>;
}
