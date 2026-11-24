// One more row of the project's setup checklist (the approved mock: "checklist-none / -waiting / -on"): Browser testing, optional and NOT counted in the progress (Code computes that). Its words come from the page's own
// read, never from a saved wizard position. It is absent while Code does not serve the page, or for a person who has no access to it. It says where to go; every change is made on the page.
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { browserTestingKey, useBrowserTestingApi, type BrowserTestingView } from "../../../api/browser-testing.js";
import { ApiError } from "../../../api/errors.js";
import { isAccessEnded, servedReadState } from "../../../api/served-read.js";
import { Skeleton } from "../../../design/Skeleton.js";
import { StatusPill, type StatusTone } from "../../../design/StatusDot.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { BT } from "./browser-testing-text.js";
import { faulty, kindNames, whenOf } from "./model.js";

const pillOf = (state: string, fault: boolean, newer: boolean): { label: string; tone: StatusTone } => {
  if (fault) return { label: BT.chipFault, tone: "bad" };
  if (newer) return { label: "Change waiting", tone: "wait" };
  if (state === "on") return { label: BT.chipOn, tone: "ok" };
  if (state === "paused") return { label: BT.chipPaused, tone: "idle" };
  if (state === "waiting") return { label: BT.chipWaiting, tone: "wait" };
  if (state === "checking") return { label: BT.chipChecking, tone: "run" };
  if (state === "check-failed") return { label: BT.chipFailed, tone: "bad" };
  return { label: "Optional", tone: "idle" };
};

/** The one line a Browser testing read says, by where it stands (the checklist row and the Setup tab's "Also for this project" row both say it). */
export function browserTestingText(view: BrowserTestingView): string {
  const newer = view.state === "on" && (view.candidate !== null || view.newerChange !== null);
  const approved = view.approved === null ? "" : whenOf(view.approved.approvedAt);
  const kinds = view.approved?.summary === null || view.approved === null ? [] : kindNames(view.approved.summary.found);
  if (faulty(view)) return BT.rowFault;
  if (view.state === "not-set-up") return BT.rowNone;
  if (view.state === "draft") return BT.rowDraft;
  if (view.state === "checking") return BT.rowChecking;
  if (view.state === "check-failed") return BT.rowFailed;
  if (view.state === "waiting") return BT.rowChecked(whenOf(view.candidate?.checkedAt));
  if (view.state === "paused") return BT.rowPaused;
  if (newer) return view.candidate === null ? BT.rowNewerUnchecked(approved) : BT.rowNewer(approved);
  return approved === "" ? BT.rowOnNoDate(kinds) : BT.rowOn(approved, kinds);
}

export function BrowserTestingRow({ project, alone = false }: { project: string; /** On its own (a finished checklist leaves the project page): the row brings its own list. */ alone?: boolean }) {
  const api = useBrowserTestingApi();
  const read = useQuery({ queryKey: browserTestingKey(project), queryFn: () => api.read(project), retry: false });
  const shown = servedReadState(read);
  const absent = read.isError && shown.data === undefined && (isAccessEnded(read.error) || (read.error instanceof ApiError && (read.error.status === 501 || read.error.code === "NOT_ON_CODE_YET")));
  if (absent) return null;
  const wrap = (pill: { label: string; tone: StatusTone }, body: React.ReactNode, open = false) => {
    const row = <li className="rv-checklist-row" data-testid="checklist-row-browserTesting" data-state={pill.label === "On" ? "done" : "optional"}>
      <details open={open}><summary><span className="rv-checklist-title">{BT.rowTitle}</span> <StatusPill tone={pill.tone} label={pill.label} /></summary><div className="rv-checklist-body">{body}</div></details>
    </li>;
    return alone ? <ol className="rv-checklist-rows" data-testid="project-browser-testing-only">{row}</ol> : row;
  };
  const to = `/app/projects/${encodeURIComponent(project)}/browser-testing`;
  if (read.isPending) return wrap({ label: "Optional", tone: "idle" }, <Skeleton label={BT.reading} />);
  const view = shown.data;
  if (view === undefined) return wrap({ label: "Optional", tone: "idle" }, <p role="status" data-testid="browser-testing-row-error">{BT.readFailedTitle} <button type="button" className="rv-button rv-button-secondary" onClick={() => { void read.refetch(); }}>{BT.tryAgain}</button></p>, true);
  const newer = view.state === "on" && (view.candidate !== null || view.newerChange !== null);
  const pill = pillOf(view.state, faulty(view), newer);
  const approved = view.approved === null ? "" : whenOf(view.approved.approvedAt);
  const kinds = view.approved?.summary === null || view.approved === null ? [] : kindNames(view.approved.summary.found);
  const link = (label: string, primary = false) => <Link className={`rv-button ${primary ? "rv-button-primary" : ""}`} data-testid="browser-testing-row-link" to={to}>{label}</Link>;
  let text: string, action: React.ReactNode;
  if (faulty(view)) { text = BT.rowFault; action = link(BT.rowOpen); }
  else if (view.state === "not-set-up") { text = BT.rowNone; action = view.canManage ? link(BT.rowSetUp, true) : link(BT.rowOpen); }
  else if (view.state === "draft") { text = BT.rowDraft; action = link(view.canManage ? BT.rowContinue : BT.rowOpen, view.canManage); }
  else if (view.state === "checking") { text = BT.rowChecking; action = link(BT.rowOpen); }
  else if (view.state === "check-failed") { text = BT.rowFailed; action = link(view.canManage ? BT.rowContinue : BT.rowOpen, view.canManage); }
  else if (view.state === "waiting") { text = BT.rowChecked(whenOf(view.candidate?.checkedAt)); action = link(view.canManage ? BT.rowReview : BT.rowOpen, view.canManage); }
  else if (view.state === "paused") { text = BT.rowPaused; action = link(BT.rowOpen); }
  else if (newer) { text = view.candidate === null ? BT.rowNewerUnchecked(approved) : BT.rowNewer(approved); action = link(view.canManage ? BT.rowReviewChange : BT.rowOpen, view.canManage); }
  else { text = approved === "" ? BT.rowOnNoDate(kinds) : BT.rowOn(approved, kinds); action = link(BT.rowOpen); }
  const stale = shown.staleSince !== undefined;
  return wrap(pill, <><p data-testid="browser-testing-row-text"><VisibleText text={text} /></p>{stale && <p className="rv-muted" role="status">{BT.stale}</p>}<div className="rv-connect-actions">{action}</div></>, view.state === "waiting" || view.state === "not-set-up");
}
