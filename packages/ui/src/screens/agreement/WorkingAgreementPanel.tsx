import "./agreement.css";
import type { ReactNode } from "react";
import { useQuery, type UseQueryResult } from "@tanstack/react-query";
import { Link } from "react-router";
import { designReviewKey, useDesignReviewApi } from "../../api/design-review.js";
import { useCompanyRulesSummary } from "../../api/agreement.js";
import { ApiError } from "../../api/errors.js";
import { useHowWeWork } from "../../api/how-we-work.js";
import { useKnownFailingPolicy } from "../../api/known-failing.js";
import { useLearning } from "../../api/learning.js";
import { useLessons } from "../../api/lessons.js";
import { useNav } from "../../api/nav.js";
import { useStageModels } from "../../api/stage-models.js";
import { Chip } from "../../design/Chip.js";
import { Skeleton } from "../../design/Skeleton.js";
import { VisibleText } from "../../design/VisibleText.js";
import { canOpenCompanySettings } from "../../shell/destinations.js";
import { NEEDS_BROKER, ORIGIN_LABEL, SOURCE_NAMES, T, type MissingKey, type SourceId } from "./agreement-text.js";
import { companyRulesRows, designReviewRows, isLocked, knownFailingRows, layerRows, learningRows, lessonsRows, modelRows, taskRows, type AgreementRow, type StepRows, type TaskFacts } from "./agreement-rows.js";

/** One source's state. "missing": the broker has no such read for this person or install (404, 403). "failed": any other failure. */
type Source = { id: SourceId; state: "loading" } | { id: SourceId; state: "missing" } | { id: SourceId; state: "failed"; retry: () => void } | { id: SourceId; state: "ready" };
function sourceOf<T>(id: SourceId, read: UseQueryResult<T>): Source {
 if (read.isPending) return { id, state: "loading" };
 if (read.isError) return read.error instanceof ApiError && (read.error.status === 404 || read.error.status === 403) ? { id, state: "missing" } : { id, state: "failed", retry: () => { void read.refetch(); } };
 return { id, state: "ready" };
}

function WhyLink({ row, admin }: { row: AgreementRow; admin: boolean }) {
 if (row.origin === "rovara-fixed") return <p>{T.WHY_ROVARA}</p>;
 const rules = row.manage === "company-rules";
 return <p>{T.WHY_COMPANY} {admin ? <>{T.WHY_COMPANY_ADMIN} <Link to={rules ? T.COMPANY_SETTINGS_RULES : T.COMPANY_SETTINGS_HOW}>{rules ? T.LINK_RULES : T.LINK_HOW}</Link>.</> : T.WHY_COMPANY_ASK}</p>;
}
function RowItem({ row, admin }: { row: AgreementRow; admin: boolean }) {
 return <li className="rv-agree-row" data-origin={row.origin}>
  <div className="rv-agree-text"><span className="rv-agree-title"><VisibleText text={row.title} /></span><span className="rv-agree-value"><VisibleText text={row.value} /></span>{row.id === "company-rules" && admin && <Link className="rv-agree-link" to={T.COMPANY_SETTINGS_RULES}>{T.LINK_RULES}</Link>}</div>
  <div className="rv-agree-meta">
   <Chip kind={row.origin === "company-lock" ? "company-lock" : "neutral"}>{ORIGIN_LABEL[row.origin]}</Chip>
   {row.version !== undefined && <span className="rv-agree-version">{T.VERSION(row.version)}</span>}
   {row.pending === true && <span className="rv-agree-pending">{T.PENDING}</span>}
   {isLocked(row) && <details className="rv-agree-why"><summary>{T.WHY}</summary><WhyLink row={row} admin={admin} /></details>}
  </div>
 </li>;
}
const List = ({ label, rows, admin }: { label: string; rows: readonly AgreementRow[]; admin: boolean }) => <ul className="rv-agree-list" aria-label={label}>{rows.map(row => <RowItem key={row.id} row={row} admin={admin} />)}</ul>;
const Block = ({ title, children }: { title: string; children: ReactNode }) => <div className="rv-agree-block"><h3>{title}</h3>{children}</div>;

/**
 * The Working agreement panel (experience lane exp/working-agreement, behind `isWorkingAgreementOn`): every rule that applies to a project (and, compact, to a task), where it comes from, whether it is locked and whether
 * a change is waiting for a second admin. It reads only what the app already reads; a source it cannot read is listed as "Not available yet". It changes nothing: the rules are edited where they were.
 */
export function WorkingAgreementPanel({ project, variant, task }: { project: string; variant: "project" | "task"; task?: TaskFacts | undefined }) {
 const full = variant === "project", nav = useNav(), admin = nav.data !== undefined && canOpenCompanySettings(nav.data);
 const design = useDesignReviewApi();
 const layers = useHowWeWork(project), playbook = useQuery({ queryKey: designReviewKey(project), queryFn: () => design.playbook(project) }), models = useStageModels(project, undefined, full);
 const lessons = useLessons(project), learning = useLearning(project), policy = useKnownFailingPolicy(), rules = useCompanyRulesSummary();
 const layer = layers.data === undefined ? undefined : layerRows(layers.data), designRows = playbook.data === undefined ? undefined : designReviewRows(playbook.data);
 // The broker answers 200 with no design review setting where the stage does not exist for this install: nothing to show, so it counts as not available.
 const designSource: Source = playbook.data !== undefined && designRows === undefined ? { id: "design-review", state: "missing" } : sourceOf("design-review", playbook);
 const sources: Source[] = [sourceOf("layers", layers), designSource, ...(full ? [sourceOf("models", models)] : []), sourceOf("lessons", lessons), sourceOf("learning", learning), sourceOf("known-failing", policy), sourceOf("company-rules", rules)];
 const whole: AgreementRow[] = [...(layer?.project ?? []), ...(designRows ?? []), ...(lessons.data === undefined ? [] : lessonsRows(lessons.data)), ...(learning.data === undefined ? [] : learningRows(learning.data)), ...(policy.data === undefined ? [] : knownFailingRows(policy.data)), ...(rules.data === undefined ? [] : companyRulesRows(rules.data))];
 const mine = task === undefined ? [] : taskRows(task), modelList = models.data === undefined ? [] : modelRows(models.data), steps: StepRows[] = full ? layer?.steps ?? [] : [];
 const loading = sources.filter(source => source.state === "loading"), notShown = sources.filter(source => source.state === "missing" || source.state === "failed");
 const missing: MissingKey[] = full ? ["merge", "approvals"] : ["merge", "approvals", "taskSnapshot"];
 return <section className={"rv-agree rv-agree-" + variant} aria-labelledby={"agree-" + variant + "-title"} aria-busy={loading.length > 0}>
  <div className="rv-agree-block">{full ? <h2 id="agree-project-title">{T.TITLE}</h2> : <h3 id="agree-task-title">{T.TASK_TITLE}</h3>}<p className="rv-muted">{full ? T.INTRO : T.TASK_INTRO}</p></div>
  {mine.length > 0 && <Block title={T.SECTION_TASK}><List label={T.SECTION_TASK} rows={mine} admin={admin} /></Block>}
  {whole.length > 0 && <Block title={T.SECTION_PROJECT}><List label={T.SECTION_PROJECT} rows={whole} admin={admin} /></Block>}
  {modelList.length > 0 && <Block title={T.SECTION_MODELS}><List label={T.SECTION_MODELS} rows={modelList} admin={admin} /></Block>}
  {steps.length > 0 && <Block title={T.SECTION_STEPS}>{steps.map(step => <details className="rv-agree-step" key={step.id}><summary><VisibleText text={step.name} /> <span className="rv-muted">({step.rows.length === 1 ? "1 rule" : String(step.rows.length) + " rules"})</span></summary>{step.rows.length === 0 ? <p className="rv-muted">{T.NO_STEP_ROWS}</p> : <List label={step.name} rows={step.rows} admin={admin} />}</details>)}</Block>}
  {loading.length > 0 && (whole.length === 0 ? <Skeleton label={T.LOADING} /> : <p className="rv-muted" role="status">{T.LOADING}</p>)}
  {(notShown.length > 0 || loading.length === 0) && <Block title={T.SECTION_MISSING}><ul className="rv-agree-list rv-agree-missing" aria-label={T.SECTION_MISSING}>
   {notShown.map(source => <li key={source.id}><span>{SOURCE_NAMES[source.id]}</span><span className="rv-muted">{source.state === "failed" ? <>{T.FAILED} <button type="button" className="rv-agree-link" onClick={source.retry}>{T.RETRY}</button></> : T.MISSING}</span></li>)}
   {loading.length === 0 && missing.map(key => <li key={key}><span>{NEEDS_BROKER[key]}</span><span className="rv-muted">{T.MISSING}</span></li>)}
  </ul></Block>}
 </section>;
}
