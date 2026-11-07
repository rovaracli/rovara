import { Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";
import { SettingsNote } from "../SettingsNote.js";
import { Link } from "react-router";
import { useAppHost } from "../../../host.js";
import { ApiError } from "../../../api/errors.js";
import { Button } from "../../../design/Button.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { Select, type SelectOption } from "../../../design/Select.js";
import { Switch } from "../../../design/Switch.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { CompanyPolicyReader, isRefusalCode, modelKey, type CompanyOverride, type CompanyOverrides, type CompanyPolicy, type CompanyPreview, type StageCandidate } from "../../../api/stage-models.js";
import { COMPANY_ROWS } from "../../../api/stage-cards.js";
import type { SoleOwnerConfirmation } from "../../../api/client.js";
import { previewCompanyPolicy, saveCompanyPolicy, COMPANY_POLICY_PATH } from "../../../api/company-model-policy.js";
import { EFFORT_OPTIONS, REFUSAL_TEXT, candidateBlock, codedText, effortLabel } from "../../project/stage-model-text.js";
import { ReadSection, checkedTime, useAdminRead } from "../models/read.js";
import { useAdminContext } from "../AdminLayout.js";
import { PrLearningLockRow } from "../agents/PrLearningLockRow.js";
import { defaultStillApplies, incompleteLocks, lockIncomplete, normalize, patchRow, rowEntry, rowSplit, sameOverrides, vendorOn, type CompanyRow, type EffortChoice } from "./company-edit.js";
import * as T from "./company-text.js";
import { LearningSuggestionsRow } from "./LearningSuggestionsRow.js";
import { KnownFailingPolicyRow } from "./KnownFailingPolicyRow.js";
import { SetupRecipesLink } from "./SetupRecipesScreen.js";
import { UnsavedChanges, useReportUnsaved } from "./unsaved.js";
import "./how-we-work.css";

// SU-1: the company's setup locks. Its own chunk; it shows nothing while the setup agent is off.
const SetupLocksRow = lazy(() => import("./SetupLocksRow.js"));
// DR-FU4: the company's design review card (allowed, rules). Its own chunk; it shows nothing while design review is off in the environment, and for anyone but an admin.
const DesignReviewCompanyRow = lazy(() => import("./DesignReviewCompanyRow.js"));

const effortChoice = (effort: CompanyOverride["thinkingLevel"]): EffortChoice => effort === undefined ? "inherit" : effort === null ? "null" : effort;
type Notice = { kind: "saved" } | { kind: "saved_reload_failed" } | { kind: "stale" } | { kind: "failed"; text: string } | { kind: "confirm"; url: string | undefined; changes: string[]; soleOwner: SoleOwnerConfirmation | undefined };
type Review = { state: "loading" } | { state: "failed"; text: string } | { state: "ready"; projects: CompanyPreview["projects"]; next: string | undefined };

export function HowWeWorkCompanyScreen() {
 // A window refocus or reconnect never re-reads this page: it would reset unsaved edits, close an open review or drop a save result. The save result lives here, in the parent, so a re-read (after a save or Reload) cannot lose it.
 const read = useAdminRead("company-how-we-work", COMPANY_POLICY_PATH, CompanyPolicyReader, { stable: true });
 const [notice, setNotice] = useState<Notice>(), { role } = useAdminContext();
 const reread = async (): Promise<boolean> => !(await read.refetch()).isError;
 return <UnsavedChanges><section><PageHeader focusOnMount title={T.PAGE_TITLE} description={T.PAGE_NOTE} /><SettingsNote area="how-we-work" /><p className="rv-muted">{T.SAVE_MODEL_NOTE}</p>
  <p><Link to="/app/admin/models/sources">Back to AI models</Link></p>
  <LearningSuggestionsRow />
  <KnownFailingPolicyRow />
  <SetupRecipesLink />
  {(role === "owner" || role === "admin") && <Suspense fallback={null}><SetupLocksRow /></Suspense>}
  {(role === "owner" || role === "admin") && <Suspense fallback={null}><DesignReviewCompanyRow /></Suspense>}
  {notice?.kind === "saved" && <p role="status">{T.SAVED}</p>}
  {notice?.kind === "saved_reload_failed" && <p role="alert">{T.SAVED_RELOAD_FAILED} <Button onClick={() => { setNotice(undefined);void read.refetch(); }}>Reload</Button></p>}
  <ReadSection read={read} label="Company model defaults">{policy => <Editor key={read.dataUpdatedAt} policy={policy} notice={notice} setNotice={setNotice} reread={reread} reload={() => { setNotice(undefined);void read.refetch(); }} />}</ReadSection>
  <PrLearningLockRow />
 </section></UnsavedChanges>;
}

/** The models a row can offer: the first stage's list, kept to the models every stage of the row lists. Undefined when the read gives no list for any stage of the row (the list is unavailable: the row shows its model read only). An empty list is an answer: no candidates. */
function rowCandidates(policy: CompanyPolicy, row: CompanyRow): StageCandidate[] | undefined {
 const lists = row.stages.map(id => policy.candidates?.[id]);
 if (lists.some(list => list === undefined)) return undefined;
 const [first, ...others] = lists as StageCandidate[][];
 return first!.filter(candidate => others.every(list => list.some(other => modelKey(other.model) === modelKey(candidate.model))));
}
function ModelPicker({ entry, candidates, disabled, onPick }: { entry: CompanyOverride | undefined; candidates: StageCandidate[]; disabled: boolean; onPick: (value: string) => void }) {
 const current = entry?.model === undefined ? "" : modelKey(entry.model);
 const options: SelectOption[] = [{ value: "", label: T.MODEL_DEFAULT_OPTION }, ...candidates.map(candidate => { const block = candidateBlock(candidate);return { value: modelKey(candidate.model), label: block === undefined ? candidate.label : candidate.label + ": " + block, disabled: block !== undefined }; })];
 if (!options.some(option => option.value === current)) options.push({ value: current, label: current, disabled: true });
 return <><Select label="Model" value={current} options={options} disabled={disabled} onValueChange={onPick} />{candidates.every(candidate => candidateBlock(candidate) !== undefined) && <p className="rv-muted">{T.NO_VERIFIED}</p>}</>;
}
function RowCard({ row, overrides, saved, serverDefault, candidates, disabled, onChange }: { row: CompanyRow; overrides: CompanyOverrides; saved: CompanyOverride | undefined; serverDefault: boolean; candidates: StageCandidate[] | undefined; disabled: boolean; onChange: (next: CompanyOverrides) => void }) {
 const entry = rowEntry(overrides, row), locked = entry?.locked === true, incomplete = lockIncomplete(entry, row), split = rowSplit(overrides, row);
const effort = effortChoice(entry?.thinkingLevel), effortOptions = EFFORT_OPTIONS.some(option => option.value === effort) ? EFFORT_OPTIONS : [...EFFORT_OPTIONS, { value: effort, label: effortLabel(effort), disabled: true }];
 const referenceTitle = row.reference === "plan" ? "Plan" : "Build";
 return <section aria-label={row.title} className="rv-hww-company-card"><h2>{row.title}</h2>
  {candidates === undefined ? <p>Model: {entry?.model === undefined ? <>Rovara's default</> : <VisibleText text={modelKey(entry.model)} />}</p> : <ModelPicker entry={entry} candidates={candidates} disabled={disabled} onPick={value => onChange(patchRow(overrides, row, { model: value }))} />}
  <Select label="Effort" value={effort} options={effortOptions} disabled={disabled} onValueChange={value => onChange(patchRow(overrides, row, { effort: value as EffortChoice }))} />
  {row.reference !== undefined && <Switch label={"Different vendor than " + referenceTitle} checked={vendorOn(entry, saved, serverDefault)} disabled={disabled} onCheckedChange={checked => onChange(patchRow(overrides, row, { vendor: checked }))} />}
  {row.reference !== undefined && defaultStillApplies(entry, saved, serverDefault) && <p className="rv-muted">{T.DEFAULT_VENDOR_NOTE}</p>}
  <Switch label="Lock this stage" checked={locked} disabled={disabled} onCheckedChange={checked => onChange(patchRow(overrides, row, { locked: checked }))} />
  {incomplete && <p role="status" className="rv-hww-company-hint">{T.CARD_INCOMPLETE}</p>}
  {split && <p className="rv-muted">{T.SPLIT[row.id]}</p>}
 </section>;
}

function Editor({ policy, notice, setNotice, reload, reread }: { policy: CompanyPolicy; notice: Notice | undefined; setNotice: (notice: Notice | undefined) => void; reload: () => void; reread: () => Promise<boolean> }) {
 const host = useAppHost(), context = useAdminContext();
 const [draft, setDraft] = useState<CompanyOverrides>(policy.stepOverrides), [review, setReview] = useState<Review>(), [reviewing, setReviewing] = useState(false), [blocked, setBlocked] = useState<string>(), [saving, setSaving] = useState(false);
 const alive = useRef(true), attempt = useRef<{ key: string; id: string } | undefined>(undefined), ticket = useRef(0);
 useEffect(() => { alive.current = true;return () => { alive.current = false; }; }, []);
 const dirty = useMemo(() => !sameOverrides(policy.stepOverrides, draft), [policy.stepOverrides, draft]);
 useReportUnsaved("models", "Company model defaults", dirty);
 const allowed = (context.role === "owner" || context.role === "admin") && !context.checking;
 const busy = saving || reviewing, outOfDate = notice?.kind === "stale" || notice?.kind === "saved_reload_failed";
 function edit(next: CompanyOverrides) { ticket.current += 1;setDraft(next);setReview(undefined);setReviewing(false);setBlocked(undefined);setNotice(undefined); }
 const body = () => ({ expectedRevision: policy.revision, stepOverrides: normalize(draft) });
 function failure(error: unknown): Notice { return error instanceof ApiError && error.code === "POLICY_STALE" ? { kind: "stale" } : { kind: "failed", text: error instanceof ApiError && error.status === 403 && error.code === "MODEL_NOT_ALLOWED" ? error.message : error instanceof ApiError && error.status === 403 ? T.DENIED : error instanceof ApiError && isRefusalCode(error.code) ? REFUSAL_TEXT[error.code] : error instanceof ApiError && codedText(error.code) !== undefined ? codedText(error.code)! : T.SAVE_FAILED }; }
 async function openReview() {
  if (busy || !dirty || outOfDate) return;
  const missing = incompleteLocks(draft);
  if (missing.length > 0) { setBlocked(T.INCOMPLETE_LOCK + " Check: " + missing.join(", ") + "."); return; }
  setBlocked(undefined);setNotice(undefined);setReview({ state: "loading" });setReviewing(true);const mine = ticket.current;
  try { const page = await previewCompanyPolicy(host, body());if (alive.current && ticket.current === mine) setReview({ state: "ready", projects: page.projects, next: page.nextCursor }); }
  catch (error) { if (alive.current && ticket.current === mine) { if (error instanceof ApiError && error.code === "POLICY_STALE") { setReview(undefined);setNotice({ kind: "stale" }); } else setReview({ state: "failed", text: T.PREVIEW_FAILED }); } }
  finally { if (alive.current && ticket.current === mine) setReviewing(false); }
 }
 async function showMore() {
  if (busy || review?.state !== "ready" || review.next === undefined) return;
  const current = review, mine = ticket.current;setReviewing(true);
  try { const page = await previewCompanyPolicy(host, { ...body(), cursor: current.next! });if (alive.current && ticket.current === mine) { const seen = new Set(current.projects.map(p => p.project));setReview({ state: "ready", projects: [...current.projects, ...page.projects.filter(p => !seen.has(p.project))], next: page.nextCursor }); } }
  catch (error) { if (alive.current && ticket.current === mine) { if (error instanceof ApiError && error.code === "POLICY_STALE") { setReview(undefined);setNotice({ kind: "stale" }); } else setReview({ state: "failed", text: T.PREVIEW_FAILED }); } }
  finally { if (alive.current && ticket.current === mine) setReviewing(false); }
 }
 async function save() {
  if (busy || !allowed || !dirty || outOfDate) return;
  if (incompleteLocks(draft).length > 0) { setBlocked(T.INCOMPLETE_LOCK + " Check: " + incompleteLocks(draft).join(", ") + "." );return; }
  const input = body(), key = String(input.expectedRevision) + JSON.stringify(input.stepOverrides);
  if (attempt.current?.key !== key) attempt.current = { key, id: crypto.randomUUID() };
  setSaving(true);setNotice(undefined);
  try {
   const result = await saveCompanyPolicy(host, { requestId: attempt.current.id, ...input });
   // The result goes to the parent's notice whether or not this editor is still mounted.
   if (result.kind === "applied") { setNotice({ kind: "saved" });if (!await reread()) setNotice({ kind: "saved_reload_failed" }); }
   else setNotice({ kind: "confirm", url: result.confirmUrl, changes: result.changes, soleOwner: result.soleOwner });
  } catch (error) { setNotice(failure(error)); }
  finally { if (alive.current) setSaving(false); }
 }
 return <div aria-busy={busy}>
  {COMPANY_ROWS.some(row => rowCandidates(policy, row) === undefined) && <p className="rv-muted">{T.MODEL_NOTE}</p>}
  <div className="rv-hww-company-cards">{COMPANY_ROWS.map(row => <RowCard key={row.id} row={row} overrides={draft} saved={rowEntry(policy.stepOverrides, row)} serverDefault={policy.reviewDefaults?.[row.base] === "different_company"} candidates={rowCandidates(policy, row)} disabled={!allowed || busy} onChange={edit} />)}</div>
  <div className="rv-hww-company-actions"><Button variant="primary" busy={saving} disabled={!allowed || busy || !dirty || outOfDate} onClick={() => { void save(); }}>Save company defaults</Button><Button disabled={!allowed || busy || !dirty || outOfDate} onClick={() => { void openReview(); }}>Review changes</Button>{dirty && <span className="rv-muted">{T.UNSAVED_MODELS}</span>}</div>
  {blocked !== undefined && <p role="alert">{blocked}</p>}
  {review !== undefined && <section aria-label="Review of company changes" className="rv-hww-company-review"><h2>Projects affected</h2>
   {review.state === "loading" && <p role="status">Checking projects...</p>}
   {review.state === "failed" && <p role="alert">{review.text}</p>}
   {review.state === "ready" && <>
    <p>{T.PREVIEW_INCOMPLETE}</p>
    {review.projects.length === 0 ? <p>No projects were listed.</p> : <ul className="rv-hww-company-projects">{review.projects.map(item => <li key={item.project}><strong><VisibleText text={item.project} /></strong>: {T.IMPACT_TEXT[item.impact]}{item.reasonCodes.length > 0 && <ul>{[...new Set(item.reasonCodes.map(T.reasonText))].map(text => <li key={text}>{text}</li>)}</ul>}</li>)}</ul>}
    {review.next !== undefined && <Button busy={reviewing} onClick={() => { void showMore(); }}>Show more</Button>}
   </>}
  </section>}
  {notice?.kind === "stale" && <p role="alert">{T.STALE} <Button onClick={reload}>Reload</Button></p>}
  {notice?.kind === "failed" && <p role="alert">{notice.text}</p>}
  {notice?.kind === "confirm" && <div role="status"><p>{notice.soleOwner?.available === true && notice.soleOwner.availableAt !== null ? T.soleOwnerText(checkedTime(notice.soleOwner.availableAt)) : notice.soleOwner !== undefined ? T.OTHER_ADMIN_SHORT : T.OTHER_ADMIN}</p>{notice.changes.length > 0 && <ul>{notice.changes.map((change, index) => <li key={index}><VisibleText text={change} /></li>)}</ul>}{notice.url !== undefined && <Button onClick={() => host.openExternal(notice.url!)}>Open confirmation</Button>}</div>}
 </div>;
}
