import { useQuery } from "@tanstack/react-query";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { VisibleText } from "../../design/VisibleText.js";

/**
 * What the run did, command by command, and the websites it asked for. Every word of a command or its output is a repository's or a model's text, so it is shown through VisibleText, as quoted text and never
 * as anything to follow. A host ask is decided by an administrator on the Decisions page; this only shows where it stands.
 */
export function RunJournal({ project, running }: { project: string; running: boolean }) {
  const api = useSetupAgentApi();
  const query = useQuery({ queryKey: ["onboard", "setup-journal", project], queryFn: () => api.journal(project), retry: false, refetchInterval: running ? 3000 : false });
  const data = query.data;
  if (data === undefined) return query.isError ? <p role="alert">Couldn't load what the run did.</p> : <p role="status">Loading what the run did.</p>;
  return <>
    <h4>What Rovara ran</h4>
    {data.entries.length === 0 ? <p className="rv-muted">Nothing yet.</p> : <ol className="rv-setup-journal" aria-label="Commands the run ran">
      {data.entries.map(entry => <li key={entry.n}>
        <p><span className="rv-setup-n">#{entry.n}</span> <span>{entry.source === "person" ? "You ran" : "Rovara ran"}</span> <code><VisibleText text={entry.command} /></code></p>
        <p className="rv-proposal-meta"><span>{entry.timedOut ? "Timed out" : entry.exitCode === 0 ? "Worked" : `Exit ${entry.exitCode === null ? "unknown" : String(entry.exitCode)}`}</span>{entry.flagged && <span>Downloads and runs code (ran only in the sandbox)</span>}</p>
        {entry.blockedHosts.length > 0 && <p className="rv-proposal-meta">Could not reach: {entry.blockedHosts.map(host => <code key={host}><VisibleText text={host} /> </code>)}</p>}
        {entry.tail !== "" && <details><summary>Output</summary><pre><VisibleText text={entry.tail} /></pre></details>}
      </li>)}
    </ol>}
    {data.hostAsks.length > 0 && <>
      <h4>Websites Rovara asked for</h4>
      <ul aria-label="Websites the run asked for">{data.hostAsks.map(ask => <li key={ask.host}><code><VisibleText text={ask.host} /></code> <span className="rv-proposal-meta">{ask.status === "open" ? "Waiting for an administrator to decide on the Decisions page" : ask.status === "approved" ? "Allowed" : "Refused"}</span></li>)}</ul>
    </>}
  </>;
}
