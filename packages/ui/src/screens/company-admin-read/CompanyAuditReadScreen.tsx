import { useState, type FormEvent } from "react";
import { Button } from "../../design/Button.js";
import { DataTable, type Column } from "../../design/DataTable.js";
import { PageHeader } from "../../design/PageHeader.js";
import { VisibleText } from "../../design/VisibleText.js";
import { checkedTime } from "../admin/models/read.js";
import { useCompanyReadScope } from "./ReadEntry.js";
import { ReadState } from "./ReadState.js";
import { ResultChip, RowStamp, eventClock } from "./parts.js";
import { auditReader, useCompanyRead } from "./read-model.js";
import type { z } from "zod";

type Audit = z.infer<typeof auditReader>;
type Row = Audit["records"][number];
export const AUDIT_PAGE_SIZE = 50;
const sourceLabel = (source: Row["source"]) => source === "cloud" ? "Rovara web" : "Rovara’s task engine";
const events = (count: number) => `${count} ${count === 1 ? "event" : "events"}`;

const columns: readonly Column<Row>[] = [
 { key: "when", title: "When", render: row => <RowStamp iso={row.at} /> },
 { key: "who", title: "Who", render: row => <VisibleText text={row.actor.name} /> },
 { key: "what", title: "What", render: row => <span className="rv-car-what"><VisibleText text={row.action} /><span className="rv-car-sub"><VisibleText text={row.subject} />{row.project !== undefined && <> (<VisibleText text={row.project} />)</>}</span></span> },
 { key: "result", title: "Result", render: row => <ResultChip outcome={row.outcome} /> },
 { key: "source", title: "Recorded by", render: row => sourceLabel(row.source) },
];

function Mark({ ok }: { ok: boolean }) {
 return <svg className={ok ? "rv-car-source-mark" : "rv-car-source-mark rv-car-source-mark-quiet"} viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">{ok ? <path d="m3 8 3 3 7-7" /> : <path d="M5 8h6" />}</svg>;
}
/** The live time-range input (moved unchanged from the retired admin/audit/AuditScreen): a UTC date and time, sent as Cloud's ISO `from` / `to`. */
function utc(value: string): string | undefined {
 if (!value) return undefined;
 if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error("invalid time");
 const date = new Date(value + "Z"); if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, value.length) !== value) throw new Error("invalid time"); return date.toISOString();
}

/**
 * The company audit: Cloud's GET /v1/app/company/audit, read only. The live page's reads are kept: a UTC time range, and paging with Cloud's cursor forward and
 * back (Previous page / Next page). A read can itself be recorded, so nothing re-reads on focus or reconnect; only entry and the person's own presses read.
 */
export function CompanyAuditReadScreen() {
 const scope = useCompanyReadScope();
 const [fromInput, setFromInput] = useState(""), [toInput, setToInput] = useState(""), [validation, setValidation] = useState("");
 const [range, setRange] = useState<{ from?: string; to?: string }>({}), [cursors, setCursors] = useState([""]), [page, setPage] = useState(0);
 const cursor = cursors[page] ?? "";
 const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });
 if (range.from !== undefined) params.set("from", range.from);
 if (range.to !== undefined) params.set("to", range.to);
 if (cursor !== "") params.set("cursor", cursor);
 // A next page that names the page just read would loop: refused like any answer that does not read.
 const read = useCompanyRead(scope, "audit", `/v1/app/company/audit?${params}`, auditReader.refine(data => data.next === undefined || (data.next !== "" && data.next !== cursor)));
 const busy = read.isFetching;
 function apply(event: FormEvent) {
  event.preventDefault(); if (busy) return;
  let from: string | undefined, to: string | undefined;
  try { from = utc(fromInput); to = utc(toInput); } catch { setValidation("Enter valid UTC dates and times."); return; }
  if (from !== undefined && to !== undefined && from > to) { setValidation("From must be no later than Through."); return; }
  setValidation(""); setRange({ ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) }); setCursors([""]); setPage(0);
  if (from === range.from && to === range.to && page === 0) void read.refetch();
 }
 const filters = <section className="rv-car-card rv-car-filters" aria-labelledby="company-audit-range"><h2 id="company-audit-range">Time range</h2>
  <form onSubmit={apply} className="rv-car-range">
   <div className="rv-field"><label htmlFor="audit-from">From (UTC)</label><input id="audit-from" aria-invalid={validation ? true : undefined} aria-describedby={validation ? "audit-range-error" : undefined} type="datetime-local" step="1" value={fromInput} onChange={event => setFromInput(event.target.value)} /></div>
   <div className="rv-field"><label htmlFor="audit-to">Through (UTC)</label><input id="audit-to" aria-invalid={validation ? true : undefined} aria-describedby={validation ? "audit-range-error" : undefined} type="datetime-local" step="1" value={toInput} onChange={event => setToInput(event.target.value)} /></div>
   <Button type="submit" aria-disabled={busy}>Apply range</Button>
  </form>
  {validation && <p id="audit-range-error" className="rv-car-field-error" role="alert">{validation}</p>}
  <p className="rv-car-note">Applied range: {range.from === undefined ? "the earliest record" : checkedTime(range.from)} through {range.to === undefined ? "now" : checkedTime(range.to)}.</p>
 </section>;
 return <ReadState read={read} label="Audit" code="COMPANY-AUDIT-READ-FAILED" wide
  header={(data, readAt) => {
   const meta = data === undefined ? undefined : [`Changes to ${scope.company}’s people, money, connections, rules and projects`, `${events(data.records.length)} on this page`, readAt === undefined ? undefined : `Read\u00a0from\u00a0Rovara\u00a0${readAt}`].filter(Boolean).join(" · ");
   return <PageHeader focusOnMount title="Audit" breadcrumbs={[{ label: "Company", href: "/app/admin" }, { label: "Audit" }]} {...(meta === undefined ? {} : { meta })} />;
  }}
  before={filters}>{data => {
  const engineOk = data.engine.state === "connected";
  const engineWords = engineOk ? "Reporting" : data.engine.state === "incomplete" ? "Partly read" : data.engine.state === "not_connected" ? "Not connected" : "Unavailable";
  const sources = (["cloud", "engine"] as const).map(source => {
   const rows = data.records.filter(row => row.source === source);
   return { source, count: rows.length, last: rows.map(row => row.at).sort().pop() };
  });
  return <div className="rv-car-audit">
   <div className="rv-car-audit-main">
    {!engineOk && <p className="rv-car-quiet-card" role="note"><VisibleText text={data.engine.message ?? "Engine records are not in this list."} /></p>}
    <p className="rv-car-note" role="status" aria-label="Audit records shown on this page" aria-live="polite" aria-atomic="true">Page {page + 1}: {data.records.length} {data.records.length === 1 ? "record" : "records"}, up to {AUDIT_PAGE_SIZE} per page.</p>
    {data.records.length === 0 ? <p className="rv-car-quiet-card">No audit records were returned for this page and time range.</p> : <div className="rv-car-table"><DataTable caption={`Recorded company actions · ${data.records.length} on this page`} columns={columns} rows={data.records} rowKey={row => row.id} /></div>}
    <div className="rv-car-more">
     <Button disabled={page === 0 || busy} onClick={() => setPage(previous => Math.max(0, previous - 1))}>Previous page</Button>
     <Button disabled={busy || read.isError || data.next === undefined} onClick={() => { if (data.next !== undefined && !read.isFetching && !read.isError && read.failureCount === 0) { setCursors(previous => [...previous.slice(0, page + 1), data.next!]); setPage(previous => previous + 1); } }}>Next page</Button>
     <p>{data.next === undefined ? "End of this range. Rovara can't tell if older history exists." : "Older events may follow. Next page reads them."}</p>
    </div>
    <p className="rv-car-note">Result is what was recorded for the change itself. Not confirmed means the request was recorded and its outcome was not. Events can&apos;t be edited or removed here.</p>
   </div>
   <aside className="rv-car-audit-rail" aria-label="Coverage">
    <h2>Where events come from</h2>
    <section className="rv-car-card">
     <ul className="rv-car-sources">
      {sources.map(({ source, count, last }) => {
       const ok = source === "cloud" || engineOk;
       const lastAt = last === undefined ? undefined : eventClock(last);
       return <li key={source}><Mark ok={ok} /><div><strong>{sourceLabel(source)}</strong>
        <p>{source === "engine" && !engineOk ? engineWords : <>{events(count)} on this page{lastAt === undefined ? "" : ` · last event ${lastAt}`}</>}</p></div></li>;
      })}
     </ul>
     <p className="rv-car-note">Rovara can&apos;t tell yet whether this is the complete history. Missing events are not proof that no action happened.</p>
    </section>
   </aside>
  </div>;
 }}</ReadState>;
}
