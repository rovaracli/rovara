import { useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useSetupAgentApi } from "../../api/setup-agent.js";
import { servedReadState } from "../../api/served-read.js";
import { VisibleText } from "../../design/VisibleText.js";
import { AddressAsks } from "../setup-tab/AddressAsks.js";
import { ADDRESSES, RUN } from "../setup-tab/setup-tab-text.js";

import { journalKey } from "./journal-key.js";
export { journalKey };

/**
 * What the run did, command by command, and the websites it asked for. Every word of a command or its output is a repository's or a model's text, so it is shown through VisibleText, as quoted text and never
 * as anything to follow. An open website ask is allowed or refused here by a company owner or admin (Code decides who); everyone else sees where it stands.
 */
export function RunJournal({ project, running, heading = true }: { project: string; running: boolean; /** False where a summary above already says "What Rovara ran". */ heading?: boolean }) {
  const api = useSetupAgentApi();
  const query = useQuery({ queryKey: journalKey(project), queryFn: () => api.journal(project, { retry: "never" }), retry: false, refetchInterval: running ? 3000 : false });
  // An access signal wipes what was shown; a failed re-read keeps the last facts (one reconnecting line) and takes every control away.
  const shown = servedReadState(query), data = shown.data;
  // A decision that went through in this view stays said even when the re-read then ends in an access signal (401 / 403 / 404): the facts are wiped, the confirmed outcome is not.
  const [done, setDone] = useState<Record<string, "approve" | "reject">>({});
  if (data === undefined) {
    const went = Object.keys(done).length > 0;
    return query.isError ? <p role="alert" data-testid={went ? "host-asks-went-through" : undefined}>{went ? ADDRESSES.wentThrough + " " : ""}{RUN.failed}</p> : <p role="status">{RUN.loading}</p>;
  }
  const fresh = !query.isError && query.failureCount === 0, reconnecting = !fresh && data.hostAsks.length > 0;
  return <>
    {heading && <h4>What Rovara ran</h4>}
    {data.entries.length === 0 ? <p className="rv-muted">{RUN.empty}</p> : <ol className="rv-setup-journal" aria-label="Commands the run ran">
      {data.entries.map(entry => <li key={entry.n}>
        <p><span className="rv-setup-n">#{entry.n}</span> <span>{entry.source === "person" ? "You ran" : "Rovara ran"}</span> <code><VisibleText text={entry.command} /></code></p>
        <p className="rv-proposal-meta"><span>{entry.timedOut ? RUN.timedOut : entry.exitCode === 0 ? RUN.worked : RUN.failedCode(entry.exitCode)}</span>{entry.flagged && <span>{RUN.flagged}</span>}</p>
        {entry.blockedHosts.length > 0 && <p className="rv-proposal-meta">{RUN.couldntReach} {entry.blockedHosts.map(host => <code key={host}><VisibleText text={host} /> </code>)}</p>}
        {entry.tail !== "" && <details><summary>Output</summary><pre><VisibleText text={entry.tail} /></pre></details>}
      </li>)}
    </ol>}
    {data.hostAsks.length > 0 && <><h4>Addresses Rovara asked for</h4><AddressAsks project={project} asks={data.hostAsks} entries={data.entries} fresh={fresh} reconnecting={reconnecting} done={done} setDone={setDone} /></>}
  </>;
}
