import "./audit.css";
import { useEffect, useMemo, useState, type FormEvent } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { z } from "zod";
import { useAppHost } from "../../../host.js";
import { createApiClient } from "../../../api/client.js";
import { Button } from "../../../design/Button.js";
import { DataTable } from "../../../design/DataTable.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { useAdminContext } from "../AdminLayout.js";
import { checkedTime, ReadSection } from "../models/read.js";

// The company audit (migration plan v3.2 7.5): Cloud's `GET /v1/app/company/audit`, Cloud's own records and Rovara Code's engine records as one list, newest first, for a company owner or
// admin (Cloud checks the role with Code's live access check; another company's records are never in it). The page used to read the old broker's sealed ledger (`/v1/app/org/audit/status`
// and `/records`), which hosted Rovara does not serve (live test run 2, 2026-11-18: both 501). This list makes no sealing claim, so the page makes none.
export const COMPANY_AUDIT_PATH = "/v1/app/company/audit";
export const AUDIT_PAGE_SIZE = 50;
const text = (max: number) => z.string().max(max);
const entrySchema = z.object({
 id: text(300), source: z.enum(["cloud", "engine"]), at: text(64),
 actor: z.object({ developerId: text(256), name: text(200), type: text(32).optional() }),
 via: text(64).optional(), action: text(130), subject: text(600), project: text(63).optional(), outcome: text(32), detail: text(200).optional(),
});
export const companyAuditSchema = z.object({
 records: z.array(entrySchema).max(200), next: text(1_024).optional(),
 engine: z.object({ state: z.enum(["connected", "not_connected", "unavailable", "incomplete"]), message: text(300).optional() }),
});
function utc(value: string): string | undefined {
 if (!value) return undefined;
 if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error("invalid time");
 const date = new Date(value + "Z");if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, value.length) !== value) throw new Error("invalid time");return date.toISOString();
}
// A read can itself be recorded: only entry and explicit actions read again.
const readPolicy = { staleTime: Infinity, gcTime: 0, refetchOnWindowFocus: false, refetchOnReconnect: false, refetchInterval: false, refetchOnMount: false, retry: false } as const;
export function AuditScreen() {
 const scope = useAdminContext();return <AuditView key={`${scope.orgId}:${scope.developerId}:${scope.role}`} />;
}
function AuditView() {
 const { orgId, developerId, role } = useAdminContext(), host = useAppHost(), query = useQueryClient(), api = useMemo(() => createApiClient(host), [host]);
 const [fromInput, setFromInput] = useState(""), [toInput, setToInput] = useState(""), [validation, setValidation] = useState("");
 const [range, setRange] = useState<{ from?: string; to?: string }>({}), [generation, setGeneration] = useState(0), [cursors, setCursors] = useState([""]), [page, setPage] = useState(0);
 const cursor = cursors[page] ?? "";
 useEffect(() => () => { const key = ["admin", "lane-c", "audit", orgId, developerId, role];void query.cancelQueries({ queryKey: key });query.removeQueries({ queryKey: key }); }, [query, orgId, developerId, role]);
 const params = new URLSearchParams({ limit: String(AUDIT_PAGE_SIZE) });if (range.from !== undefined) params.set("from", range.from);if (range.to !== undefined) params.set("to", range.to);if (cursor) params.set("cursor", cursor);
 const records = useQuery({ ...readPolicy, queryKey: ["admin", "lane-c", "audit", orgId, developerId, role, "records", range.from ?? "", range.to ?? "", cursor, generation], // A next page that names the page just read would loop: refused like any answer that does not read.
 queryFn: () => api.get(COMPANY_AUDIT_PATH + "?" + params.toString(), companyAuditSchema.refine(value => value.next === undefined || value.next !== cursor)) });
 function apply(event: FormEvent) {
  event.preventDefault();if (records.isFetching) return;
  let from: string | undefined, to: string | undefined;
  try { from = utc(fromInput);to = utc(toInput); } catch { setValidation("Enter valid UTC dates and times.");return; }
  if (from !== undefined && to !== undefined && from > to) { setValidation("From must be no later than Through.");return; }
  setValidation("");setRange({ ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) });setCursors([""]);setPage(0);setGeneration(previous => previous + 1);
 }
 return <section className="rv-admin-audit"><PageHeader focusOnMount title="Audit" description="Read your company's audit records: changes made in Rovara Cloud and the engine's records from Rovara Code, newest first. This page does not refresh automatically." actions={<Button aria-disabled={records.isFetching} onClick={() => { if (records.isFetching) return;void records.refetch({ cancelRefetch: false }); }}>Refresh this page</Button>} />
 <h2>Time range</h2><form onSubmit={apply} className="rv-audit-filters"><div className="rv-field"><label htmlFor="audit-from">From (UTC)</label><input id="audit-from" aria-invalid={validation ? true : undefined} aria-describedby={validation ? "audit-range-error" : undefined} type="datetime-local" step="1" value={fromInput} onChange={event => setFromInput(event.target.value)} /></div><div className="rv-field"><label htmlFor="audit-to">Through (UTC)</label><input id="audit-to" aria-invalid={validation ? true : undefined} aria-describedby={validation ? "audit-range-error" : undefined} type="datetime-local" step="1" value={toInput} onChange={event => setToInput(event.target.value)} /></div><Button type="submit" aria-disabled={records.isFetching}>Apply range</Button></form>
 {validation && <p id="audit-range-error" role="alert">{validation}</p>}<p>Applied range: {range.from === undefined ? "the earliest record" : checkedTime(range.from)} through {range.to === undefined ? "now" : checkedTime(range.to)}.</p>
 <h2>Records</h2><ReadSection read={records} label="Audit records">{data => <>
 {data.engine.state !== "connected" && <p role="note"><VisibleText text={data.engine.message ?? "Engine records are not in this list."} /></p>}
 <p role="status" aria-label="Audit records shown on this page" aria-live="polite" aria-atomic="true">Page {page + 1}: {data.records.length} {data.records.length === 1 ? "record" : "records"}, up to {AUDIT_PAGE_SIZE} per page.</p>
 {data.records.length === 0 ? <p>No audit records for this page and time range.</p> : <DataTable caption="Audit records" rows={data.records} rowKey={row => row.id} columns={[
 { key: "at", title: "When", render: row => checkedTime(row.at) },
 { key: "who", title: "Who", render: row => <VisibleText text={row.actor.name} /> },
 { key: "action", title: "Action", render: row => <VisibleText text={row.action} /> },
 { key: "subject", title: "About", render: row => <VisibleText text={row.project === undefined ? row.subject : row.subject === "" ? row.project : `${row.subject} (${row.project})`} /> },
 { key: "outcome", title: "Outcome", render: row => <VisibleText text={row.outcome} /> },
 { key: "source", title: "Recorded by", render: row => row.source === "cloud" ? "Rovara Cloud" : "Rovara Code" },
 ]} />}
 <div className="rv-audit-pagination"><Button disabled={page === 0 || records.isFetching} onClick={() => setPage(previous => Math.max(0, previous - 1))}>Previous page</Button><Button disabled={records.isFetching || records.isError || data.next === undefined} onClick={() => { if (data.next !== undefined && !records.isFetching && !records.isError) { setCursors(previous => [...previous.slice(0, page + 1), data.next!]);setPage(previous => previous + 1); } }}>Next page</Button></div>
 <p>{data.next === undefined ? "End of this range." : "More records may follow. Use Next page to read them."}</p>
 </>}</ReadSection>
 </section>;
}
