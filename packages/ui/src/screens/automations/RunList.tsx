// exp/automations: a chain's (or a project's) runs, newest first, each linking to its page. The list is Rovara Code's chain run list; only what the page shows is read.
import { Link } from "react-router";
import { useQuery } from "@tanstack/react-query";
import { chainKey, useAutomationsApi } from "../../api/automations.js";
import { Money } from "../../design/Money.js";
import { RelativeTime } from "../../design/RelativeTime.js";
import { Skeleton } from "../../design/Skeleton.js";
import { StatusDot } from "../../design/StatusDot.js";
import { VisibleText } from "../../design/VisibleText.js";
import { paths } from "../../paths.js";
import { ActionNote, problemNote } from "./ActionNote.js";
import { runStatusKey, runStatusWords } from "./automation-text.js";

export function RunList({ scope, showChain }: { scope: { chain: string } | { project: string }; showChain: boolean }) {
  const api = useAutomationsApi(), key = "chain" in scope ? chainKey(scope.chain, "runs") : (["automations", "project-runs", scope.project] as const);
  const read = useQuery({ queryKey: key, queryFn: () => api.runs(scope), retry: false });
  if (read.isPending) return <Skeleton label="Loading runs" />;
  if (read.isError) return <ActionNote note={problemNote(read.error)} />;
  if (read.data.runs.length === 0) return <p className="rv-muted">No runs yet.</p>;
  return <ul className="rv-auto-list" aria-label="Runs">{read.data.runs.map(run => <li key={run.sessionId} className="rv-auto-row">
    <div className="rv-auto-row-head"><div><Link to={paths.session(run.sessionId)}>{showChain ? <VisibleText text={run.chain.name} /> : "Run"} <span className="rv-muted">version {run.chain.version}</span></Link></div><StatusDot status={runStatusKey(run.status)} words={runStatusWords[run.status] ?? run.status} /></div>
    <p className="rv-muted">Started <RelativeTime at={run.createdAt} />{run.cost !== undefined && <> · <Money usd={run.cost.spentUsd} /> of <Money usd={run.cost.runLimitUsd} /></>}</p>
  </li>)}</ul>;
}
