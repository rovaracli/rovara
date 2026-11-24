import { useState, type ReactNode } from "react";
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import type { ProjectSetupChecklist } from "@agentx/contracts/web";
import { browserTestingKey, useBrowserTestingApi } from "../../api/browser-testing.js";
import { evalCheckAbsent, evalCheckKey, useEvalCheckApi } from "../../api/eval-check.js";
import { ApiError } from "../../api/errors.js";
import { isAccessEnded, servedReadState } from "../../api/served-read.js";
import { useWikiSetupApi, wikiSetupAbsent, wikiSetupKey } from "../../api/wiki-setup.js";
import { Button } from "../../design/Button.js";
import { VisibleText } from "../../design/VisibleText.js";
import { EVAL_CHECK_ROW_WORDS } from "../setup/EvalCheckRow.js";
import { EvalCheckRow } from "../setup/EvalCheckRow.js";
import { WikiChecklistRow } from "../setup/wiki/WikiChecklistRow.js";
import { BT } from "../setup/browser-testing/browser-testing-text.js";
import { faulty, whenOf } from "../setup/browser-testing/model.js";
import type { BrowserTestingView } from "../../api/browser-testing.js";
import { ALSO } from "./setup-tab-text.js";
import { CHECKLIST_ID } from "../setup/ProjectChecklist.js";

function ExtraRow({ id, title, line, action, panel }: { id: string; title: string; line: ReactNode; action?: ReactNode; panel?: ReactNode }) {
  return <li className="rv-setup-row rv-setup-extra" data-testid={`also-${id}`}>
    <div className="rv-setup-row-main"><strong>{title}</strong><p className="rv-muted" data-testid={`also-${id}-line`}>{line}</p>{panel}</div>
    {action !== undefined && <div className="rv-setup-row-end">{action}</div>}
  </li>;
}
function OpenButton({ id, open, onClick }: { id: string; open: boolean; onClick: () => void }) {
  return <Button aria-expanded={open} data-testid={`also-${id}-open`} onClick={onClick}>{ALSO.open}</Button>;
}

function WikiExtra({ project, companyAdmin }: { project: string; companyAdmin: boolean }) {
  const api = useWikiSetupApi(), [open, setOpen] = useState(false);
  const read = useQuery({ queryKey: wikiSetupKey(project, "build"), queryFn: () => api.build(project), retry: false, refetchInterval: current => (current.state.data?.status === "running" ? 4_000 : false) });
  if (read.isError && wikiSetupAbsent(read.error)) return null;
  const view = servedReadState(read).data;
  const line = read.isPending ? "Reading." : view === undefined ? ALSO.wiki.unknown : view.status === "running" ? ALSO.wiki.building(view.summary?.pagesWritten ?? 0, view.summary?.pagesPlanned ?? 0) : view.wiki.pages > 0 ? ALSO.wiki.pages(view.wiki.pages) : ALSO.wiki.none;
  return <ExtraRow id="wiki" title={ALSO.wiki.title} line={line} action={<OpenButton id="wiki" open={open} onClick={() => { setOpen(!open); }} />} panel={open ? <WikiChecklistRow project={project} companyAdmin={companyAdmin} bare startOpen /> : undefined} />;
}

/** One short line of where browser testing stands (3.10): "Not set up.", "On since 12 Nov.", "Waiting for approval." Never a paragraph; the page it opens explains. */
export function browserLine(view: BrowserTestingView): string {
  if (faulty(view)) return `${BT.chipFault}.`;
  if (view.state === "on") { const when = view.approved === null ? "" : whenOf(view.approved.approvedAt); return when === "" ? `${BT.chipOn}.` : `On since ${when}.`; }
  const chip = view.state === "not-set-up" ? BT.chipNone : view.state === "draft" ? BT.chipDraft : view.state === "checking" ? BT.chipChecking : view.state === "check-failed" ? BT.chipFailed : view.state === "waiting" ? BT.chipWaiting : BT.chipPaused;
  return `${chip}.`;
}

function BrowserExtra({ project }: { project: string }) {
  const api = useBrowserTestingApi();
  const read = useQuery({ queryKey: browserTestingKey(project), queryFn: () => api.read(project), retry: false });
  const shown = servedReadState(read);
  const absent = read.isError && shown.data === undefined && (isAccessEnded(read.error) || (read.error instanceof ApiError && (read.error.status === 501 || read.error.code === "NOT_ON_CODE_YET")));
  if (absent) return null;
  const view = shown.data, to = `/app/projects/${encodeURIComponent(project)}/browser-testing`;
  const line = read.isPending ? BT.reading : view === undefined ? BT.readFailedTitle : browserLine(view);
  return <ExtraRow id="browser" title={ALSO.browser.title} line={<VisibleText text={line} />} action={<Link className="rv-button rv-button-secondary" data-testid="also-browser-open" to={to}>{ALSO.open}</Link>} />;
}

function EvalCheckExtra({ project }: { project: string }) {
  const api = useEvalCheckApi(), [open, setOpen] = useState(false);
  const read = useQuery({ queryKey: evalCheckKey(project), queryFn: () => api.read(project), retry: false });
  if (read.isError && evalCheckAbsent(read.error)) return null;
  const view = read.data, W = EVAL_CHECK_ROW_WORDS;
  const line = read.isPending ? W.loading : view === undefined ? W.readError : view.confirmed !== null ? `Chosen: ${view.confirmed.name}` : view.proposals?.verdict === "proposals" ? W.proposed : view.proposals?.verdict === "none_found" ? W.noneFound : view.proposals?.verdict === "unknown" ? W.unknown : W.noneChosen;
  return <ExtraRow id="evalcheck" title={ALSO.evalCheck.title} line={<VisibleText text={line} />} action={<OpenButton id="evalcheck" open={open} onClick={() => { setOpen(!open); }} />} panel={open ? <EvalCheckRow project={project} bare /> : undefined} />;
}

/** The AI evals line of the checklist's own row (Code decides it, the checklist shows its card): one line of state here, and Review only when a person has something to decide. */
export function evalsLine(row: ProjectSetupChecklist["evalConfirm"] | undefined): { line: string; review: boolean } {
  if (row === undefined) return { line: ALSO.evals.before, review: false };
  if (row.blockedBy === "setupRun") return { line: ALSO.evals.before, review: false };
  if (row.report === "confirmed") return { line: ALSO.evals.confirmed(row.confirmedSelection ?? "the confirmed checks"), review: false };
  if (row.report === "no_evals") return { line: ALSO.evals.noEvals, review: false };
  if (row.report === "reported") return { line: ALSO.evals.waiting, review: row.state !== "done" };
  return { line: ALSO.evals.none, review: false };
}

/** "Also for this project" (3.10): the optional extras as rows, one line of state and an Open button each. Setup is complete without them, and the page says so. */
export function AlsoForProject({ project, checklist, companyAdmin }: { project: string; checklist: ProjectSetupChecklist | undefined; companyAdmin: boolean }) {
  const evals = evalsLine(checklist?.evalConfirm);
  return <section className="rv-setup-section" aria-labelledby="rv-setup-also-heading" data-testid="setup-also">
    <h2 id="rv-setup-also-heading">{ALSO.heading}</h2>
    <p className="rv-muted">{ALSO.optional}</p>
    <ul className="rv-setup-rows" aria-label={ALSO.heading}>
      <WikiExtra project={project} companyAdmin={companyAdmin} />
      <BrowserExtra project={project} />
      {checklist !== undefined && <ExtraRow id="evals" title={ALSO.evals.title} line={evals.line} {...(evals.review ? { action: <Link className="rv-button rv-button-secondary" data-testid="also-evals-review" to={{ pathname: `/app/projects/${encodeURIComponent(project)}`, hash: `#${CHECKLIST_ID}` }}>{ALSO.review}</Link> } : {})} />}
      <EvalCheckExtra project={project} />
    </ul>
  </section>;
}
