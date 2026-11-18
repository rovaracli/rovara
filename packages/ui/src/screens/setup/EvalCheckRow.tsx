// L4-EVCI2 (Thursday fallback): "Eval check from your CI", one more row of the project's setup checklist. Rovara reads the project's workflow files and PROPOSES the jobs that look like an eval; a person who manages the
// setup presses "Use this one" for the right one (or "None"), and Rovara then shows that check's result on its pull requests, chat and ticket. Advisory: it never holds, fixes or pays for anything. Code decides who may;
// a person who may not sees what was chosen and no control. The row is not counted in the checklist's progress (Code computes that) and is absent while Code does not serve it.
import { useRef, useState, type ReactNode } from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { EVAL_CHECK_SENTENCES } from "@agentx/contracts/web";
import { evalCheckAbsent, evalCheckKey, useEvalCheckApi, type EvalCheck, type EvalCheckProposal, type EvalCheckView } from "../../api/eval-check.js";
import { ApiError } from "../../api/errors.js";
import { Button } from "../../design/Button.js";
import { Skeleton } from "../../design/Skeleton.js";
import { StatusPill } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";

/** Everything the row says (a check's name and a workflow's path are the customer's own and are shown as text only). */
export const EVAL_CHECK_ROW_WORDS = {
  title: "Eval check from your CI",
  explanation: "Rovara shows this check's result on its pull requests.",
  loading: "Loading the eval check",
  readError: "The eval check couldn't be read just now. Try again.",
  sendError: "That couldn't be saved just now. Try again.",
  saved: "Saved.",
  proposed: "Rovara found these checks in your workflow files. Pick the one that runs your evals.",
  cut: "These are the first few. If yours isn't here, it can't be chosen yet.",
  none: "None of these",
  noneChosen: "No eval check is chosen.",
  noneFound: "Rovara found no check in your workflow files that looks like an eval.",
  unknown: "Rovara couldn't read your workflow files just now, so it can't suggest a check.",
  noOne: "A company owner, admin or this project's admin chooses the eval check.",
  basisName: "its name says it is an eval",
  basisCommands: "it runs an eval tool",
  use: "Use this one",
  clear: "Stop showing it",
  retry: "Try again",
} as const;
const W = EVAL_CHECK_ROW_WORDS;

const sameCheck = (left: EvalCheck, right: EvalCheck): boolean => left.name === right.name && left.source === right.source;

function Proposal({ item, busy, onUse }: { item: EvalCheckProposal; busy: boolean; onUse: () => void }) {
  return <li data-testid="eval-check-proposal">
    <span><strong><VisibleText text={item.name} /></strong> <span className="rv-muted">(<VisibleText text={`${item.workflow} in ${item.repository}`} />; {item.basis === "name" ? W.basisName : W.basisCommands})</span></span>
    <Button disabled={busy} data-testid="eval-check-use" onClick={onUse}>{W.use}</Button>
  </li>;
}

export function EvalCheckRow({ project, alone = false }: { project: string; /** On its own (a finished checklist leaves the project page): the row brings its own list. */ alone?: boolean }) {
  const api = useEvalCheckApi(), query = useQueryClient();
  const read = useQuery({ queryKey: evalCheckKey(project), queryFn: () => api.read(project), retry: false });
  const [busy, setBusy] = useState(false), [error, setError] = useState<string>(), [saved, setSaved] = useState(false);
  // One request id per choice until it succeeds: a retry after a failure repeats the same id, which Code answers with the state and never does twice. Made on a click, never on a render.
  const ids = useRef(new Map<string, string>());
  const sending = useRef(false);
  if (read.isError && evalCheckAbsent(read.error)) return null;
  const wrap = (pill: { label: string; tone: "ok" | "idle" }, body: ReactNode, open = false) => {
    const row = <li className="rv-checklist-row" data-testid="checklist-row-evalCheck" data-state={pill.label === "Done" ? "done" : "optional"}>
      <details open={open}><summary><span className="rv-checklist-title">{W.title}</span> <StatusPill tone={pill.tone} label={pill.label} /></summary><div className="rv-checklist-body">{body}</div></details>
    </li>;
    return alone ? <ol className="rv-checklist-rows" data-testid="project-eval-check-only">{row}</ol> : row;
  };
  if (read.isPending) return wrap({ label: "Optional", tone: "idle" }, <Skeleton label={W.loading} />);
  if (read.isError) return wrap({ label: "Optional", tone: "idle" }, <><p role="alert" data-testid="eval-check-read-error">{W.readError}</p><Button onClick={() => { void read.refetch(); }}>{W.retry}</Button></>, true);
  const view: EvalCheckView = read.data;

  async function choose(key: string, check: EvalCheck | null) {
    if (sending.current) return;
    sending.current = true; setBusy(true); setError(undefined); setSaved(false);
    const id = ids.current.get(key) ?? crypto.randomUUID();
    ids.current.set(key, id);
    try {
      const answered = await api.set(project, id, check);
      ids.current.delete(key);
      query.setQueryData(evalCheckKey(project), answered);
      setSaved(true);
    } catch (caught) {
      // Only the fixed words of this card reach the person; anything else is the one sentence above.
      setError(caught instanceof ApiError && EVAL_CHECK_SENTENCES.has(caught.message) ? caught.message : W.sendError);
      if (caught instanceof ApiError && caught.status >= 400 && caught.status < 500) { ids.current.delete(key); void query.invalidateQueries({ queryKey: evalCheckKey(project) }); }
    } finally { sending.current = false; setBusy(false); }
  }

  const confirmed = view.confirmed;
  const proposals = view.proposals;
  const body = <>
    <p data-testid="eval-check-explanation">{W.explanation}</p>
    {confirmed !== null && <p data-testid="eval-check-confirmed">Chosen: <strong><VisibleText text={confirmed.name} /></strong></p>}
    {confirmed === null && !view.canManage && <p data-testid="eval-check-none-chosen">{W.noneChosen}</p>}
    {!view.canManage && <p className="rv-muted" data-testid="eval-check-who">{W.noOne}</p>}
    {view.canManage && proposals !== null && proposals.verdict === "proposals" && <>
      <p>{W.proposed}</p>
      <ul className="rv-checklist-chips" aria-label={W.title}>{proposals.items.map((item) => <Proposal key={`${item.name}|${item.source ?? ""}`} item={item} busy={busy || (confirmed !== null && sameCheck(confirmed, item))} onUse={() => { void choose(`use:${item.name}|${item.source ?? ""}`, { name: item.name, ...(item.source === undefined ? {} : { source: item.source }) }); }} />)}</ul>
      {proposals.cut && <p className="rv-muted" data-testid="eval-check-cut">{W.cut}</p>}
    </>}
    {view.canManage && proposals !== null && proposals.verdict === "none_found" && <p data-testid="eval-check-none-found">{W.noneFound}</p>}
    {view.canManage && proposals !== null && proposals.verdict === "unknown" && <p data-testid="eval-check-unknown">{W.unknown} <Button onClick={() => { void read.refetch(); }}>{W.retry}</Button></p>}
    {view.canManage && (confirmed !== null || (proposals !== null && proposals.verdict === "proposals")) && <div className="rv-connect-actions">
      <Button busy={busy} disabled={busy} data-testid="eval-check-none" onClick={() => { void choose("none", null); }}>{confirmed === null ? W.none : W.clear}</Button>
    </div>}
    {saved && <p role="status" data-testid="eval-check-saved">{W.saved}</p>}
    {error !== undefined && <p role="alert" data-testid="eval-check-error"><VisibleText text={error} /></p>}
  </>;
  return confirmed === null ? wrap({ label: "Optional", tone: "idle" }, body, view.canManage && proposals?.verdict === "proposals") : wrap({ label: "Done", tone: "ok" }, body);
}
