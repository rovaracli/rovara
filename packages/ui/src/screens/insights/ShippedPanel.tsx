import { useState } from "react";
import { useInsightsShipped, type InsightsOverview, type InsightsShipped } from "../../api/insights.js";
import { Select } from "../../design/Select.js";
import { VisibleText } from "../../design/VisibleText.js";
import { safeExternalUrl } from "../../text/links.js";
import { dateWords, weekWords } from "./insights-format.js";
import { BarList, NotReady, Panel, Reading } from "./parts.js";

type Item = InsightsShipped["weeks"][number]["byProject"][number]["items"][number];
function Links({ item }: { item: Item }) {
 const prs = (item.prs ?? []).map(pr => ({ pr, url: safeExternalUrl(pr.url) })), tickets = (item.tickets ?? []).map(ticket => ({ ticket, url: ticket.url === undefined ? undefined : safeExternalUrl(ticket.url) }));
 return <>
  {prs.map(({ pr, url }) => <span key={`${pr.repository}#${String(pr.number)}`} className="rv-ins-chip">{url === undefined ? <VisibleText text={`${pr.repository}#${String(pr.number)}`} /> : <a href={url} target="_blank" rel="noreferrer noopener"><VisibleText text={`${pr.repository}#${String(pr.number)}`} /><span className="rv-visually-hidden"> (pull request, opens in a new tab)</span></a>}</span>)}
  {tickets.map(({ ticket, url }) => <span key={ticket.key} className="rv-ins-chip">{url === undefined ? <VisibleText text={ticket.key} /> : <a href={url} target="_blank" rel="noreferrer noopener"><VisibleText text={ticket.key} /><span className="rv-visually-hidden"> (ticket, opens in a new tab)</span></a>}</span>)}
 </>;
}
const WEEK_CHOICES = [4, 8, 12, 26] as const;
export function ShippedPanel({ overview, person, project }: { overview: InsightsOverview; person: string | undefined; project: string | undefined }) {
 const panel = overview.panels.shipped, now = Date.parse(overview.asOf), unavailable = panel.status === "unavailable" || panel.status === "unknown";
 const [weeks, setWeeks] = useState<number>(8);
 const read = useInsightsShipped({ person, project, weeks, enabled: !unavailable });
 return <Panel id="ins-shipped" title="Shipped outcomes" intro="Work that was merged, per project and week.">
  {unavailable ? <NotReady status={panel.status} collectingSince={panel.collectingSince} now={now} /> : <>
   <Select label="Weeks to show" value={String(weeks)} onValueChange={value => { setWeeks(Number(value)); }} options={WEEK_CHOICES.map(count => ({ value: String(count), label: `Last ${String(count)} weeks` }))} />
   <Reading read={read} title="shipped outcomes">{data => {
    const sorted = [...data.weeks].sort((a, b) => b.weekStart.localeCompare(a.weekStart));
    const since = data.collectingSince ?? panel.collectingSince;
    return <>
     {data.status !== "ready" && <NotReady status={data.status} collectingSince={since} now={now} />}
     {data.status !== "ready" && sorted.length === 0 ? null : sorted.length === 0 ? <p>Nothing shipped in this period.</p> : <>
      {data.status === "collecting" && <p className="rv-muted">Weeks before {dateWords(since)} are not counted, so they can look smaller than they were.</p>}
      <BarList caption="Work shipped per week" rows={sorted.map(week => ({ key: week.weekStart, label: `Week of ${weekWords(week.weekStart)}`, value: week.shipped, text: `${String(week.shipped)} shipped` }))} />
      {sorted.map((week, index) => <details key={week.weekStart} className="rv-ins-week" open={index === 0}>
       <summary>Week of {weekWords(week.weekStart)}: {String(week.shipped)} shipped</summary>
       {week.byProject.length === 0 ? <p className="rv-muted">No project detail for this week.</p> : week.byProject.map(entry => <div key={entry.project} className="rv-ins-weekproject">
        <h3><VisibleText text={entry.project} />: {String(entry.shipped)}</h3>
        {entry.items.length > 0 && <ul className="rv-ins-items">{entry.items.map(item => <li key={item.itemId}>
         <span>{item.visibility === "full" && item.title !== undefined ? <VisibleText text={item.title} /> : "Work you can't open"}<span className="rv-muted"> merged {dateWords(item.mergedAt)}</span></span>
         {item.visibility === "full" && <Links item={item} />}
        </li>)}</ul>}
        {entry.shipped > entry.items.length && <p className="rv-muted">Showing {String(entry.items.length)} of {String(entry.shipped)}.</p>}
       </div>)}
      </details>)}
     </>}
    </>;
   }}</Reading>
  </>}
 </Panel>;
}
