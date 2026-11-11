import { Link } from "react-router";
import { SessionIdSchema } from "@agentx/contracts/web";
import { useInsightsStuck, type InsightsOverview, type StuckItem } from "../../api/insights.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { paths } from "../../paths.js";
import { actorKindWords, ageWords, blockerWords, byAge, nextActorWords, notCoveredWords, sinceWords } from "./insights-format.js";
import { BarList, NotReady, Panel } from "./parts.js";

/**
 * The in-app path of a row's OWN link, or undefined. A link is never built from `itemId` (on a metadata row it is an opaque id; on any row it only tells rows apart): the server's `link` is the only
 * source, it is sent only on a row the reader can open, and only a link of the exact `/app/sessions/<session id>` shape on a plain http(s) address is followed (as its path, inside this app).
 */
export function openablePath(item: Pick<StuckItem, "visibility" | "link">): string | undefined {
 if (item.visibility !== "full" || item.link === undefined) return undefined;
 try {
  const url = new URL(item.link), match = /^\/app\/sessions\/([A-Za-z0-9_-]+)$/u.exec(url.pathname);
  const id = match === null ? undefined : SessionIdSchema.safeParse(match[1]);
  return (url.protocol === "https:" || url.protocol === "http:") && url.username === "" && url.password === "" && url.search === "" && url.hash === "" && id?.success === true ? paths.session(id.data) : undefined;
 } catch { return undefined; }
}
const METADATA_SENTENCE = "You can see that it exists and its state, not its content.";
function Row({ item }: { item: StuckItem }) {
 // Content only when the server says the reader may open it AND sent it. Anything else (including a visibility value this screen does not know) is a metadata row.
 const full = item.visibility === "full" && item.title !== undefined;
 const open = full ? openablePath(item) : undefined;
 return <li className="rv-ins-row">
  <h3>{full ? <VisibleText text={item.title!} /> : "Work you can't open"}</h3>
  <dl className="rv-ins-facts">
   <div><dt>Project</dt><dd><VisibleText text={item.project} /></dd></div>
   <div><dt>Owner</dt><dd>{item.owner === undefined ? <span className="rv-muted">No owner recorded</span> : <VisibleText text={item.owner.name} />}</dd></div>
   <div><dt>Waiting on</dt><dd><VisibleText text={nextActorWords(item.nextActor)} /></dd></div>
   <div><dt>State</dt><dd><VisibleText text={item.stateWords} /></dd></div>
   <div><dt>Waiting</dt><dd>{ageWords(item.ageHours)} <span className="rv-muted">{sinceWords(item.sinceKind)}</span></dd></div>
   <div><dt>Held up by</dt><dd>{blockerWords(item.blocker)}</dd></div>
  </dl>
  {full && item.reason !== undefined && <p><VisibleText text={item.reason} /></p>}
  {!full && <p className="rv-muted">{METADATA_SENTENCE}</p>}
  {open !== undefined && <Link className="rv-ins-open" to={open}>Open task<span className="rv-visually-hidden">: <VisibleText text={item.title!} /></span></Link>}
 </li>;
}
export function StuckPanel({ overview, person, project }: { overview: InsightsOverview; person: string | undefined; project: string | undefined }) {
 const panel = overview.panels.stuck, now = Date.parse(overview.asOf), unavailable = panel.status !== "ready";
 const read = useInsightsStuck({ person, project, enabled: !unavailable });
 const first = read.data?.pages[0];
 const items = byAge((read.data?.pages ?? []).flatMap(page => page.items));
 const coverage = first?.coverage ?? panel.coverage, summary = first?.summary;
 const kinds = Object.entries(summary?.byNextActorKind ?? {}).filter(([, value]) => value > 0), blockers = Object.entries(summary?.byBlocker ?? {}).filter(([, value]) => value > 0);
 return <Panel id="ins-stuck" title="Stuck work" intro="Work that is waiting on someone, the longest wait first.">
  {unavailable ? <NotReady status={panel.status} collectingSince={null} now={now} /> :
   read.isPending ? <Skeleton label="Loading stuck work" /> :
   read.isError || first === undefined ? <p role="alert">Couldn&apos;t load stuck work. No list is shown. <button type="button" className="rv-ins-link-button" onClick={() => { void read.refetch(); }}>Try again</button></p> :
   first.status !== "ready" ? <NotReady status="unavailable" collectingSince={null} now={now} /> : <>
    <dl className="rv-ins-figures"><div><dt>Waiting now</dt><dd>{String(first.summary.total)}</dd></div><div><dt>Over a day</dt><dd>{String(first.summary.over24h)}</dd></div><div><dt>Over three days</dt><dd>{String(first.summary.over72h)}</dd></div></dl>
    {kinds.length > 0 && <BarList caption="Stuck work by who it waits on" rows={kinds.map(([kind, value]) => ({ key: kind, label: actorKindWords(kind), value, text: String(value) }))} />}
    {blockers.length > 0 && <BarList caption="Stuck work by what holds it up" rows={blockers.map(([blocker, value]) => ({ key: blocker, label: blockerWords(blocker), value, text: String(value) }))} />}
    {items.length === 0 ? <p>Nothing is waiting on anyone right now.</p> : <ul className="rv-ins-list" aria-label="Stuck work, longest wait first">{items.map(item => <Row key={item.itemId} item={item} />)}</ul>}
    {read.hasNextPage && <Button busy={read.isFetchingNextPage} onClick={() => { void read.fetchNextPage(); }}>Show more</Button>}
    {read.isFetchNextPageError && <p role="alert">Couldn&apos;t load more. The list above is as far as it got.</p>}
   </>}
  {!unavailable && first !== undefined && <div className="rv-ins-coverage rv-muted">
   {notCoveredWords(coverage) !== undefined && <p>{notCoveredWords(coverage)}</p>}
   {coverage.partial && <p role="status">Some sources did not answer this time, so this list may be missing work.</p>}
   {coverage.truncated && <p role="status">There is more open work than Rovara can list at once, so this is not everything.</p>}
  </div>}
 </Panel>;
}
