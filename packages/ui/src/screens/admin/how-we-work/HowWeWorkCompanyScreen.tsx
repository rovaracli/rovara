import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";
import { useQueryClient } from "@tanstack/react-query";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Select, type SelectOption } from "../../../design/Select.js";
import { Switch } from "../../../design/Switch.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { COMPANY_EFFORT_LEVELS, COMPANY_ROWS, REFUSAL_CODES, type CompanyOverride, type CompanyOverrides, type CompanyPolicy, type CompanyPreview } from "../../../api/stage-models.js";
import { previewCompanyPolicy, saveCompanyPolicy, COMPANY_POLICY_PATH } from "../../../api/company-model-policy.js";
import { EFFORT_LABELS, REFUSAL_TEXT } from "../../project/stage-model-text.js";
import { ReadSection, checkedTime, useAdminRead } from "../models/read.js";
import { useAdminContext } from "../AdminLayout.js";
import { incompleteLocks, lockIncomplete, normalize, patchRow, rowEntry, rowSplit, sameOverrides, type CompanyRow, type EffortChoice } from "./company-edit.js";
import { CompanyPolicySchema } from "../../../api/stage-models.js";
import * as T from "./company-text.js";
import "./how-we-work.css";

const EFFORT_OPTIONS: readonly SelectOption[] = [{ value: "inherit", label: "Rovara's default" }, { value: "null", label: "Model default" }, ...COMPANY_EFFORT_LEVELS.map(level => ({ value: level, label: EFFORT_LABELS[level] }))];
const effortChoice = (effort: CompanyOverride["effort"]): EffortChoice => effort === undefined ? "inherit" : effort === null ? "null" : effort;
type Notice = { kind: "saved" } | { kind: "stale" } | { kind: "failed"; text: string } | { kind: "confirm"; url: string | undefined; soleOwnerAt: string | undefined };
type Review = { state: "loading" } | { state: "failed"; text: string } | { state: "ready"; projects: CompanyPreview["projects"]; unavailable: boolean; next: string | undefined; more: boolean };

export function HowWeWorkCompanyScreen() {
 const read = useAdminRead("company-how-we-work", COMPANY_POLICY_PATH, CompanyPolicySchema);
 const [notice, setNotice] = useState<Notice>();
 return <section><PageHeader focusOnMount title={T.PAGE_TITLE} description={T.PAGE_NOTE} />
  <p><Link to="/app/admin/models/steps">Back to AI models</Link></p>
  {notice?.kind === "saved" && <p role="status">{T.SAVED}</p>}
  <ReadSection read={read} label="Company model defaults">{policy => <Editor key={read.dataUpdatedAt} policy={policy} notice={notice} setNotice={setNotice} reload={() => { setNotice(undefined);void read.refetch(); }} />}</ReadSection>
 </section>;
}

function RowCard({ row, overrides, disabled, onChange }: { row: CompanyRow; overrides: CompanyOverrides; disabled: boolean; onChange: (next: CompanyOverrides) => void }) {
 const entry = rowEntry(overrides, row), locked = entry?.locked === true, incomplete = lockIncomplete(entry, row), split = rowSplit(overrides, row);
 const referenceTitle = row.reference === "plan" ? "Plan" : "Build";
 return <section aria-label={row.title} className="rv-hww-company-card"><h2>{row.title}</h2>
  <p>Model: {entry?.model === undefined ? <>Rovara's default</> : <VisibleText text={entry.model} />}</p>
  <Select label="Effort" value={effortChoice(entry?.effort)} options={EFFORT_OPTIONS} disabled={disabled} onValueChange={value => onChange(patchRow(overrides, row, { effort: value as EffortChoice }))} />
  {row.reference !== undefined && <Switch label={"Different vendor than " + referenceTitle} checked={entry?.differentFrom?.level === "vendor"} disabled={disabled} onCheckedChange={checked => onChange(patchRow(overrides, row, { vendor: checked }))} />}
  <Switch label="Lock this stage" checked={locked} disabled={disabled} onCheckedChange={checked => onChange(patchRow(overrides, row, { locked: checked }))} />
  {incomplete && <p role="status" className="rv-hww-company-hint">{T.CARD_INCOMPLETE}</p>}
  {split && <p className="rv-muted">{T.SPLIT}</p>}
 </section>;
}

function Editor({ policy, notice, setNotice, reload }: { policy: CompanyPolicy; notice: Notice | undefined; setNotice: (notice: Notice | undefined) => void; reload: () => void }) {
 const host = useAppHost(), query = useQueryClient(), context = useAdminContext();
 const [draft, setDraft] = useState<CompanyOverrides>(policy.stepOverrides), [review, setReview] = useState<Review>(), [reviewing, setReviewing] = useState(false), [blocked, setBlocked] = useState<string>(), [saving, setSaving] = useState(false);
 const alive = useRef(true), attempt = useRef<{ key: string; id: string } | undefined>(undefined), ticket = useRef(0);
 useEffect(() => { alive.current = true;return () => { alive.current = false; }; }, []);
 const dirty = useMemo(() => !sameOverrides(policy.stepOverrides, draft), [policy.stepOverrides, draft]);
 const allowed = (context.role === "owner" || context.role === "admin") && !context.checking;
 const busy = saving || reviewing;
 function edit(next: CompanyOverrides) { ticket.current += 1;setDraft(next);setReview(undefined);setReviewing(false);setBlocked(undefined);setNotice(undefined); }
 const body = () => ({ expectedRevision: policy.revision, stepOverrides: normalize(draft) });
 function failure(error: unknown): Notice { return error instanceof ApiError && error.code === "POLICY_STALE" ? { kind: "stale" } : { kind: "failed", text: error instanceof ApiError && error.status === 403 ? T.DENIED : error instanceof ApiError && (REFUSAL_CODES as readonly string[]).includes(error.code) ? REFUSAL_TEXT[error.code as keyof typeof REFUSAL_TEXT] : T.SAVE_FAILED }; }
 async function openReview() {
  if (busy || !dirty) return;
  const missing = incompleteLocks(draft);
  if (missing.length > 0) { setBlocked(T.INCOMPLETE_LOCK + " Check: " + missing.join(", ") + "."); return; }
  setBlocked(undefined);setNotice(undefined);setReview({ state: "loading" });setReviewing(true);const mine = ticket.current;
  try { const page = await previewCompanyPolicy(host, body());if (alive.current && ticket.current === mine) setReview({ state: "ready", projects: page.projects, unavailable: page.coverage === "unavailable", next: page.nextCursor, more: false }); }
  catch (error) { if (alive.current && ticket.current === mine) { if (error instanceof ApiError && error.code === "POLICY_STALE") { setReview(undefined);setNotice({ kind: "stale" }); } else setReview({ state: "failed", text: T.PREVIEW_FAILED }); } }
  finally { if (alive.current && ticket.current === mine) setReviewing(false); }
 }
 async function showMore() {
  if (busy || review?.state !== "ready" || review.next === undefined) return;
  const current = review, mine = ticket.current;setReviewing(true);
  try { const page = await previewCompanyPolicy(host, { ...body(), cursor: current.next! });if (alive.current && ticket.current === mine) { const seen = new Set(current.projects.map(p => p.project));setReview({ state: "ready", projects: [...current.projects, ...page.projects.filter(p => !seen.has(p.project))], unavailable: page.coverage === "unavailable", next: page.nextCursor, more: true }); } }
  catch (error) { if (alive.current && ticket.current === mine) { if (error instanceof ApiError && error.code === "POLICY_STALE") { setReview(undefined);setNotice({ kind: "stale" }); } else setReview({ state: "failed", text: T.PREVIEW_FAILED }); } }
  finally { if (alive.current && ticket.current === mine) setReviewing(false); }
 }
 async function save() {
  if (busy || !allowed || !dirty) return;
  if (incompleteLocks(draft).length > 0) { setBlocked(T.INCOMPLETE_LOCK + " Check: " + incompleteLocks(draft).join(", ") + "." );return; }
  const input = body(), key = String(input.expectedRevision) + JSON.stringify(input.stepOverrides);
  if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
  setSaving(true);setNotice(undefined);const mine = ticket.current;
  try {
   const result = await saveCompanyPolicy(host, { requestId: attempt.current.id, ...input });
   if (!alive.current || ticket.current !== mine) return;
   if (result.kind === "applied") { setNotice({ kind: "saved" });await query.invalidateQueries({ queryKey: ["admin", "lane-c", "company-how-we-work"] }); }
   else setNotice({ kind: "confirm", url: result.confirmUrl, soleOwnerAt: result.soleOwnerAvailableAt });
  } catch (error) { if (alive.current && ticket.current === mine) setNotice(failure(error)); }
  finally { if (alive.current) setSaving(false); }
 }
 return <div aria-busy={busy}>
  <p className="rv-muted">{T.MODEL_NOTE}</p>
  <div className="rv-hww-company-cards">{COMPANY_ROWS.map(row => <RowCard key={row.id} row={row} overrides={draft} disabled={!allowed || busy} onChange={edit} />)}</div>
  <div className="rv-hww-company-actions"><Button variant="primary" disabled={!allowed || busy || !dirty} onClick={() => { void openReview(); }}>Review changes</Button></div>
  {blocked !== undefined && <p role="alert">{blocked}</p>}
  {review !== undefined && <section aria-label="Review of company changes" className="rv-hww-company-review"><h2>Projects affected</h2>
   {review.state === "loading" && <p role="status">Checking projects...</p>}
   {review.state === "failed" && <p role="alert">{review.text}</p>}
   {review.state === "ready" && <>
    <p>{T.PREVIEW_INCOMPLETE}</p>
    {review.unavailable ? <p>{T.PREVIEW_UNAVAILABLE}</p> : review.projects.length === 0 ? <p>No projects were listed.</p> : <ul className="rv-hww-company-projects">{review.projects.map(item => <li key={item.project}><strong><VisibleText text={item.project} /></strong>: {T.IMPACT_TEXT[item.impact]}{item.reasonCodes.length > 0 && <ul>{[...new Set(item.reasonCodes.map(T.reasonText))].map(text => <li key={text}>{text}</li>)}</ul>}</li>)}</ul>}
    {review.next !== undefined && <Button busy={reviewing} onClick={() => { void showMore(); }}>Show more</Button>}
   </>}
   {review.state !== "loading" && <div className="rv-hww-company-actions"><Button variant="primary" busy={saving} disabled={!allowed || reviewing} onClick={() => { void save(); }}>Save company defaults</Button></div>}
  </section>}
  {notice?.kind === "stale" && <p role="alert">{T.STALE} <Button onClick={reload}>Reload</Button></p>}
  {notice?.kind === "failed" && <p role="alert">{notice.text}</p>}
  {notice?.kind === "confirm" && <div role="status"><p>{notice.soleOwnerAt !== undefined ? T.soleOwnerText(checkedTime(notice.soleOwnerAt)) : T.OTHER_ADMIN}</p>{notice.url !== undefined && <Button onClick={() => host.openExternal(notice.url!)}>Open confirmation</Button>}</div>}
 </div>;
}
