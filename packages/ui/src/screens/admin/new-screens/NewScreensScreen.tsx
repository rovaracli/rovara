import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { createUiFlagsApi, UI_FLAG_NAMES, type UiFlagAdminRow, type UiFlagName, type UiFlagsAdminAnswer, type UiFlagsBody } from "../../../api/ui-flags.js";
import { Button } from "../../../design/Button.js";
import { useAnnounce } from "../../../design/Announcer.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { SettingsNote } from "../SettingsNote.js";
import { useAdminContext } from "../AdminLayout.js";

// Settings > New screens (lane U5): the company's runtime switches for the new screens. One page, one list: each row says what it turns on, what it is now, and has one button.
// Every change is one PUT from the browser with the revision read last. Nothing is repeated on its own: a conflict, a sign-in that is too old and a refusal are shown and the person decides.
const TAKES_EFFECT = "Takes effect when people next open or reload the app.";
const STALE_WORDS = "Someone else changed this; reload.";
const KNOWN: ReadonlySet<string> = new Set(UI_FLAG_NAMES);
interface Problem { message: string; reauth: boolean; stale: boolean }
const problem = (error: unknown): Problem => error instanceof ApiError
 ? { message: error.code === "CHANGE_STALE" || error.status === 409 ? STALE_WORDS : error.message, reauth: error.code === "REAUTH_REQUIRED", stale: error.code === "CHANGE_STALE" || error.status === 409 }
 : { message: "Rovara couldn't complete this. Try again shortly.", reauth: false, stale: false };
const when = (value: string) => new Date(value).toLocaleString("en-US", { timeZone: "UTC", year: "numeric", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) + " UTC";
/** The install's operator holds the screen off for every company: nobody here can change it, so the row has no control. */
const FORCED_OFF_WORDS = "Turned off by the Rovara operator";
const STATE_WORDS = { on: "On", preview: "Preview", off: "Off" } as const;

export function NewScreensScreen() {
 const { orgId, developerId, company } = useAdminContext();
 return <Flags key={`${orgId}:${developerId}`} orgId={orgId} developerId={developerId} company={company} />;
}

function describe(row: UiFlagAdminRow, company: string): string {
 if (row.forcedOff) return FORCED_OFF_WORDS;
 if (row.state === "on") return `On for everyone in ${company}.`;
 if (row.state === "preview") return "Off for the company. Anyone can try it in their own browser; it is not on for the company.";
 return "Off.";
}

function Flags({ orgId, developerId, company }: { orgId: string; developerId: string; company: string }) {
 const host = useAppHost(), api = useMemo(() => createUiFlagsApi(host), [host]), query = useQueryClient(), announce = useAnnounce();
 const key = useMemo(() => ["admin", "ui-flags", orgId, developerId], [orgId, developerId]);
 const read = useQuery({ queryKey: key, queryFn: () => api.read(), gcTime: 0, refetchOnWindowFocus: false });
 const [busy, setBusy] = useState<string>(), [error, setError] = useState<Problem>(), [done, setDone] = useState(false), sending = useRef(false);
 useEffect(() => () => { void query.cancelQueries({ queryKey: key }); query.removeQueries({ queryKey: key }); }, [query, key]);

 async function change(label: string, build: (current: UiFlagsAdminAnswer) => Omit<UiFlagsBody, "expectedRevision">) {
  const current = read.data;
  if (current === undefined || sending.current) return;
  sending.current = true;setBusy(label);setError(undefined);setDone(false);
  try {
   const answer = await api.change({ expectedRevision: current.revision, ...build(current) });
   query.setQueryData(key, answer);setDone(true);announce(TAKES_EFFECT);
   // The navigation answer carries the company's flags: read it again so this browser's own screens follow.
   void query.invalidateQueries({ queryKey: ["nav"] });
  } catch (caught) {
   setError(problem(caught));
   if (caught instanceof ApiError && [401, 403].includes(caught.status) && caught.code !== "REAUTH_REQUIRED") void query.invalidateQueries({ queryKey: ["admin", "identity"] });
  } finally { sending.current = false;setBusy(undefined); }
 }
 const toggle = (row: UiFlagAdminRow) => change(row.name, () => ({ flags: { [row.name as UiFlagName]: !row.enabled } }));
 const togglePreviews = () => change("previews", current => ({ previews: !current.previews }));
 const rows = read.data?.flags.filter(row => row.wired && KNOWN.has(row.name)) ?? [];

 return <section aria-busy={read.isFetching}>
  <PageHeader focusOnMount title="New screens" description="Turn the new screens on for everyone in your company. Nothing is installed: people see the change when they next open or reload the app." /><SettingsNote area="new-screens" />
  {error !== undefined && <p role="alert" className="rv-newscreens-error"><VisibleText text={error.message} />{error.reauth && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>Sign in again</Button></>}{error.stale && <> <Button onClick={() => { setError(undefined);void read.refetch(); }}>Reload</Button></>}</p>}
  {done && error === undefined && <p role="status">Saved. {TAKES_EFFECT}</p>}
  {read.isPending ? <Skeleton label="Loading new screens" /> : read.isError ? <div><p role="alert">Couldn't load the new screens settings.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div> : <>
   <div className="rv-newscreens-previews">
    <h2>Previews</h2>
    <p>{read.data.previews ? "Previews are allowed. When a screen is off for the company, anyone can try it in their own browser first." : "Previews are not allowed. A screen that is off for the company stays off for everyone."}</p>
    <p className="rv-muted">Preview lets each person try a screen in their own browser first. It is not on for the company, and it changes nothing for anyone else.</p>
    <Button busy={busy === "previews"} disabled={busy !== undefined} aria-pressed={read.data.previews} onClick={() => { void togglePreviews(); }}>{read.data.previews ? "Stop allowing previews" : "Allow previews"}</Button>
   </div>
   {read.data.changedAt !== undefined && <p className="rv-muted">Last changed {when(read.data.changedAt)}.</p>}
   {rows.length === 0 ? <p>No new screens are available to switch on yet.</p> : <ul className="rv-newscreens-list" aria-label="New screens">
    {rows.map(row => <li key={row.name} aria-label={row.label}>
     <div className="rv-newscreens-head"><h2><VisibleText text={row.label} /></h2><strong className="rv-newscreens-state" data-state={row.state === "unknown" ? "off" : row.state}>{STATE_WORDS[row.state === "unknown" ? "off" : row.state]}</strong></div>
     <p><VisibleText text={row.summary} /></p>
     <p className="rv-muted"><VisibleText text={describe(row, company)} /></p>
     {!row.forcedOff && <Button variant={row.enabled ? "secondary" : "primary"} busy={busy === row.name} disabled={busy !== undefined} aria-label={`${row.enabled ? "Turn off" : "Turn on"} ${row.label} for the company`} onClick={() => { void toggle(row); }}>{row.enabled ? "Turn off for everyone" : "Turn on for everyone"}</Button>}
    </li>)}
   </ul>}
  </>}
 </section>;
}
