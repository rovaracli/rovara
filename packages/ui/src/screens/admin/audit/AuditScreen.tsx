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
import { AuditExportEntry } from "./AuditExportEntry.js";
import { AUDIT_LIMITS_COPY, GOVERNANCE_SENTENCE } from "./metadata.js";
const number = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const text = z.string().max(200);
const statusFields = { headSeq: number, sealedThroughSeq: number, latestTimestamp: z.string().max(40).optional(), epochsWithoutTimestamp: z.array(text).max(20), lockMode: z.enum(["COMPLIANCE", "GOVERNANCE"]).optional() };
const statusSchema = z.object({ ...statusFields, limits: z.literal(AUDIT_LIMITS_COPY) }).refine(value => value.sealedThroughSeq <= value.headSeq);
function recordsSchema(orgId: string, cursor: string) {
 return z.object({ ...statusFields, records: z.array(z.object({ record: z.object({ orgId: z.literal(orgId), seq: number.refine(value => value > 0), action: z.string().max(100), occurredAt: z.string().max(40), recordedAt: z.string().max(40), actor: z.object({ kind: text, id: text }), target: z.object({ kind: text, id: text }), proof: z.object({ kind: text, method: text.optional(), via: text.optional(), authTime: z.string().max(40).optional() }).optional() }) })).max(50), nextCursor: z.string().max(2048).regex(/^[A-Za-z0-9_-]+$/).optional() }).refine(value => value.sealedThroughSeq <= value.headSeq && (value.nextCursor === undefined || value.nextCursor !== cursor));
}
function utc(value: string): string | undefined {
 if (!value) return undefined;
 if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value)) throw new Error("invalid time");
 const date = new Date(value + "Z");if (!Number.isFinite(date.getTime()) || date.toISOString().slice(0, value.length) !== value) throw new Error("invalid time");return date.toISOString();
}
// These reads themselves create audit records. Only entry and explicit actions should refresh them.
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
 const params = new URLSearchParams({ limit: "50" });if (range.from !== undefined) params.set("from", range.from);if (range.to !== undefined) params.set("to", range.to);if (cursor) params.set("cursor", cursor);
 const status = useQuery({ ...readPolicy, queryKey: ["admin", "lane-c", "audit", orgId, developerId, role, "status"], queryFn: () => api.get("/v1/app/org/audit/status", statusSchema) });
 const records = useQuery({ ...readPolicy, queryKey: ["admin", "lane-c", "audit", orgId, developerId, role, "records", range.from ?? "", range.to ?? "", cursor, generation], queryFn: () => api.get("/v1/app/org/audit/records?" + params.toString(), recordsSchema(orgId, cursor)) });
 function apply(event: FormEvent) {
  event.preventDefault();if (records.isFetching) return;
  let from: string | undefined, to: string | undefined;
  try { from = utc(fromInput);to = utc(toInput); } catch { setValidation("Enter valid UTC dates and times.");return; }
  if (from !== undefined && to !== undefined && from > to) { setValidation("From must be no later than Through.");return; }
  setValidation("");setRange({ ...(from === undefined ? {} : { from }), ...(to === undefined ? {} : { to }) });setCursors([""]);setPage(0);setGeneration(previous => previous + 1);
 }
 return <section className="rv-admin-audit"><PageHeader focusOnMount title="Audit" description="Read your company's audit records. Reading can add an audit entry; this page does not refresh automatically." actions={<Button aria-disabled={records.isFetching || status.isFetching} onClick={() => { if (records.isFetching || status.isFetching) return;void records.refetch({ cancelRefetch: false });void status.refetch({ cancelRefetch: false }); }}>Refresh this page and status</Button>} />
 <h2>Log status</h2><ReadSection read={status} label="Audit log status">{data => <>
 <p>Sealed through record {data.sealedThroughSeq} of {data.headSeq} in this status snapshot.</p><p>{data.headSeq - data.sealedThroughSeq} unsealed {data.headSeq - data.sealedThroughSeq === 1 ? "record" : "records"}</p>
 <p>Latest independent timestamp: {data.latestTimestamp === undefined ? "Not returned" : checkedTime(data.latestTimestamp)}.</p>
 <p>{data.epochsWithoutTimestamp.length} {data.epochsWithoutTimestamp.length === 1 ? "epoch" : "epochs"} without an independent timestamp in the newest seal window (up to 20 seals). A returned timestamp does not cover these epochs.</p>
 <p>Latest seal lock mode: {data.lockMode ?? "Not returned"}.</p>{data.lockMode === "GOVERNANCE" && <p>{GOVERNANCE_SENTENCE}</p>}
 <p>Retention duration is not returned by this status. Retention is read-only here.</p>
 </>}</ReadSection>
 <h2>Time range</h2><form onSubmit={apply} className="rv-audit-filters"><div className="rv-field"><label htmlFor="audit-from">From (UTC)</label><input id="audit-from" aria-invalid={validation ? true : undefined} aria-describedby={validation ? "audit-range-error" : undefined} type="datetime-local" step="1" value={fromInput} onChange={event => setFromInput(event.target.value)} /></div><div className="rv-field"><label htmlFor="audit-to">Through (UTC)</label><input id="audit-to" aria-invalid={validation ? true : undefined} aria-describedby={validation ? "audit-range-error" : undefined} type="datetime-local" step="1" value={toInput} onChange={event => setToInput(event.target.value)} /></div><Button type="submit" aria-disabled={records.isFetching}>Apply time range</Button></form>
 {validation && <p id="audit-range-error" role="alert">{validation}</p>}<p>Applied range: {range.from === undefined ? "Beginning of the available log" : checkedTime(range.from)} through {range.to === undefined ? "the current returned log" : checkedTime(range.to)}. Times filter when records were recorded.</p>
 <p>Actor, action and target search are not available in this view. No background scan is performed.</p>
 <h2>Records</h2><ReadSection read={records} label="Audit records">{data => <>
 <p role="status" aria-label="Audit records shown on this page" aria-live="polite" aria-atomic="true">Audit records: Page {page + 1}: {data.records.length} {data.records.length === 1 ? "record" : "records"} returned, up to 50 per page. {data.records.length > 0 && <>Sequence {data.records[0]!.record.seq} through {data.records.at(-1)!.record.seq}. </>}Log head at this read: {data.headSeq}.</p>
 {data.records.length === 0 ? <p>No audit records returned for this page and time range. This does not prove no action occurred.</p> : <DataTable caption="Audit record metadata" rows={data.records} rowKey={row => String(row.record.seq)} columns={[
 { key: "seq", title: "Sequence", render: row => row.record.seq }, { key: "action", title: "Action", render: row => <VisibleText text={row.record.action} /> },
 { key: "actor", title: "Actor", render: row => <VisibleText text={`${row.record.actor.kind}: ${row.record.actor.id}`} /> }, { key: "target", title: "Target", render: row => <VisibleText text={`${row.record.target.kind}: ${row.record.target.id}`} /> },
 { key: "at", title: "Recorded (UTC)", render: row => checkedTime(row.record.recordedAt) }, { key: "proof", title: "Recorded proof", render: row => row.record.proof === undefined ? "Not returned" : <VisibleText text={row.record.proof.kind} /> },
 ]} />}
 <div className="rv-audit-pagination"><Button disabled={page === 0 || records.isFetching} onClick={() => setPage(previous => Math.max(0, previous - 1))}>Previous page</Button><Button disabled={records.isFetching || records.isError || data.nextCursor === undefined} onClick={() => { if (data.nextCursor !== undefined && !records.isFetching && !records.isError) { setCursors(previous => [...previous.slice(0, page + 1), data.nextCursor!]);setPage(previous => previous + 1); } }}>Next page</Button></div>
 <p>{data.nextCursor === undefined ? "End of this returned range. New or unsealed records may still be absent." : "More records may follow. Use Next page to read them explicitly."}</p>
 </>}</ReadSection>
 <p>This view shows record metadata, not opened personal details. Recorded proof is metadata; this page has not verified hashes, seals or signatures. Exports open in a separate protected window.</p>
 <AuditExportEntry availability={status.isSuccess ? status.data.headSeq === 0 ? "empty" : "ready" : "unavailable"} checkingStatus={status.isFetching} />
 <h2>What the ledger proves</h2>{AUDIT_LIMITS_COPY.split("\n\n").map(part => <p key={part}>{part}</p>)}
 </section>;
}
