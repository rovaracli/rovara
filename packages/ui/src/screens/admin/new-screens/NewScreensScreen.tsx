import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { createUiFlagsApi, UI_FLAG_NAMES, type UiFlagAdminRow, type UiFlagName, type UiFlagsAdminAnswer, type UiFlagsBody } from "../../../api/ui-flags.js";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { SettingsNote } from "../SettingsNote.js";
import { useAdminContext } from "../AdminLayout.js";

// Settings > Old screens (lane U5; decision 116): a troubleshooting page. Every finished new screen is on for everyone by default, so turning screens on is not a customer task; this page only lets an owner
// (it is offered in Settings to owners; the server lets an owner or admin change it) send one screen back to the old one for the whole company, and turn it on again. One list: each row says which screen, what
// people get now, and has one button. Every change is one PUT from the browser with the revision read last. Nothing is repeated on its own: a conflict, a sign-in that is too old and a refusal are shown and the person decides.
// A press stores that screen's value for the company (a deliberate choice, kept over the default); a screen nobody pressed follows the default.
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
const STATE_WORDS = { on: "New screen", preview: "Old screen", off: "Old screen" } as const;

export function NewScreensScreen() {
 const { orgId, developerId, company } = useAdminContext();
 return <Flags key={`${orgId}:${developerId}`} orgId={orgId} developerId={developerId} company={company} />;
}

function describe(row: UiFlagAdminRow, company: string): string {
 if (row.forcedOff) return FORCED_OFF_WORDS;
 if (row.state === "on") return `Everyone in ${company} has the new screen.`;
 if (row.state === "preview") return `Everyone in ${company} has the old screen. Anyone can try the new one in their own browser.`;
 return `Everyone in ${company} has the old screen.`;
}

function Flags({ orgId, developerId, company }: { orgId: string; developerId: string; company: string }) {
 const host = useAppHost(), api = useMemo(() => createUiFlagsApi(host), [host]), query = useQueryClient();
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
   query.setQueryData(key, answer);setDone(true);
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

 return <section aria-busy={read.isFetching || busy !== undefined}>
  <PageHeader focusOnMount title="Old screens" description="Troubleshooting. Every new screen is on for everyone. If one gets in your company's way, send it back to the old screen for everyone here, and turn it on again when you are ready. Nothing is installed: people see the change when they next open or reload the app." /><SettingsNote area="new-screens" />
  {error !== undefined && <p role="alert" className="rv-newscreens-error"><VisibleText text={error.message} />{error.reauth && <> <Button onClick={() => { host.signIn(host.currentPath()); }}>Sign in again</Button></>}{error.stale && <> <Button onClick={() => { setError(undefined);void read.refetch(); }}>Reload</Button></>}</p>}
  {/* The one place "Saving…" and "Saved." are announced: a live region that is always in the page, so a screen reader hears the text when it appears. */}
  <p role="status">{busy !== undefined ? "Saving…" : done && error === undefined ? `Saved. ${TAKES_EFFECT}` : ""}</p>
  {read.isPending ? <Skeleton label="Loading new screens" /> : read.isError ? <div><p role="alert">Couldn't load the new screens settings.</p><Button onClick={() => { void read.refetch(); }}>Try again</Button></div> : <>
   <div className="rv-newscreens-previews">
    <h2>Previews</h2>
    <p>{read.data.previews ? "Previews are allowed. When a screen is back on the old one, anyone can still try the new one in their own browser." : "Previews are not allowed. A screen sent back to the old one is the old one for everyone."}</p>
    <p className="rv-muted">Preview lets each person try a new screen in their own browser while the company uses the old one. It changes nothing for anyone else.</p>
    {/* A stable name with aria-pressed (not a name that flips). aria-disabled, not disabled, while a change is saving (the button keeps keyboard focus, shows aria-busy and \"Saving…\" is announced in the status line), and the click is ignored (`change` also refuses a second send). */}
    <Button aria-pressed={read.data.previews} aria-busy={busy === "previews" || undefined} aria-disabled={busy !== undefined || undefined} onClick={() => { if (busy === undefined) void togglePreviews(); }}>Allow previews</Button>
   </div>
   {read.data.changedAt !== undefined && <p className="rv-muted">Last changed {when(read.data.changedAt)}.</p>}
   {rows.length === 0 ? <p>There are no new screens to send back yet.</p> : <ul className="rv-newscreens-list" aria-label="New screens">
    {rows.map(row => <li key={row.name} aria-label={row.label}>
     <div className="rv-newscreens-head"><h2><VisibleText text={row.label} /></h2><strong className="rv-newscreens-state" data-state={row.state === "unknown" ? "off" : row.state}>{STATE_WORDS[row.state === "unknown" ? "off" : row.state]}</strong></div>
     <p><VisibleText text={row.summary} /></p>
     <p className="rv-muted"><VisibleText text={describe(row, company)} /></p>
     {!row.forcedOff && <Button variant={row.enabled ? "secondary" : "primary"} aria-busy={busy === row.name || undefined} aria-disabled={busy !== undefined || undefined} onClick={() => { if (busy === undefined) void toggle(row); }}>{row.enabled ? <>Use the old screen instead of <VisibleText text={row.label} /> for everyone</> : <>Turn <VisibleText text={row.label} /> back on for everyone</>}</Button>}
    </li>)}
   </ul>}
  </>}
 </section>;
}
