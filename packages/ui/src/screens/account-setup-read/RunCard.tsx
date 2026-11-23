import { SetupAgentViewSchema, SetupJournalReplySchema, type SetupAgentView, type SetupJournalReply } from "@agentx/contracts/web";
import { VisibleText } from "../../design/VisibleText.js";
import { Fact, Facts } from "./parts.js";
import { ReadState } from "./ReadState.js";
import { useScopedRead } from "./read-model.js";

export const runPath = (project: string) => `/v1/app/projects/${encodeURIComponent(project)}/setup-agent`;
export const useRunRead = (project: string) => useScopedRead(runPath(project), SetupAgentViewSchema);
export const useJournalRead = (project: string) => useScopedRead(`${runPath(project)}/journal`, SetupJournalReplySchema);

const HOST = { open: "Waiting for an administrator", approved: "Allowed", refused: "Refused" } as const;
const clock = (iso: string) => new Date(iso).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit", second: "2-digit", hour12: false });
const minutes = (ms: number) => { const total = Math.round(ms / 1000), m = Math.floor(total / 60), s = total % 60; return m === 0 ? `${String(s)} s` : `${String(m)} min ${String(s).padStart(2, "0")} s`; };

/** The result in words: what the run is, from what the read serves. A ready run is never called approved. */
export function runHeading(data: SetupAgentView): string {
 if (data.status === "running") return "Setup is running";
 if (data.status === "failed") return "Setup run failed";
 if (data.status === "ready") return data.verified === true ? "Setup is verified" : "Setup run is ready";
 return "No setup run yet";
}
/** The heading, one muted line and one plain line of the run card. */
export function RunSummary({ data, project }: { data: SetupAgentView; project: string }) {
 return <>
  <h2>{runHeading(data)}</h2>
  {(data.summary !== undefined || data.verified !== undefined) && <p className="g5-muted">{data.summary !== undefined && minutes(data.summary.elapsedMs)}{data.verified !== undefined && <>{data.summary !== undefined ? " · " : ""}{data.verified ? "Verified on a fresh machine" : "Not verified"}</>}</p>}
  {data.status === "running" && <p>Nothing is needed from you, and nothing in <VisibleText text={project} /> is changed.</p>}
  {data.status === "ready" && data.verified !== true && <p>A ready run does not establish that its proposed setup was approved.</p>}
  {data.status === "none" && <p>No setup run has started.</p>}
  {data.failure !== undefined && <p>What failed: <VisibleText text={data.failure} /></p>}
  {data.apply !== undefined && <Facts><Fact label="Candidate check">{data.apply.check.status}</Fact></Facts>}
 </>;
}
function resultWord(entry: SetupJournalReply["entries"][number]) {
 const result = entry.timedOut ? "Timed out" : entry.exitCode === null ? "Exit unknown" : entry.exitCode === 0 ? "Worked · exit 0" : `Exit ${String(entry.exitCode)}`;
 return entry.source === "person" ? `Person's command · ${result}` : result;
}
function Chevron() { return <svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false"><path d="m6 3 5 5-5 5" /></svg>; }
/** The log: every command Rovara ran, in order, each with its time and result. A missing line proves nothing. */
export function LogFold({ query, open }: { query: ReturnType<typeof useJournalRead>; open: boolean }) {
 return <ReadState query={query} label="the setup journal" shell={node => <div className="g5-fold-body">{node}</div>}>{data => {
  const last = data.entries[data.entries.length - 1];
  const preview = last === undefined ? "" : last.tail.split("\n").filter(line => line.trim() !== "").pop() ?? last.command;
  return <details className="g5-fold" aria-label="Setup run journal" {...(open ? { open: true } : {})}>
   <summary><Chevron /><strong>Log</strong><span className="g5-pre"><code><VisibleText text={preview} /></code></span><span className="g5-end">{data.entries.length} {data.entries.length === 1 ? "command" : "commands"}</span></summary>
   <div className="g5-fold-body">{data.entries.length === 0 ? <p className="g5-note">No commands returned.</p> : <ol className="g5-log" aria-label="Commands the run ran">{data.entries.map(entry => <li key={entry.n}>
    <div className="g5-ll"><span className="g5-lt">{clock(entry.startedAt)}</span><span className="g5-lc"><VisibleText text={entry.command} /></span></div>
    {entry.tail !== "" && entry.tail.split("\n").filter(line => line.trim() !== "").slice(-3).map((line, index) => <div className="g5-ll" key={index}><span className="g5-lt" /><span className="g5-lc"><VisibleText text={line} /></span></div>)}
    <div className="g5-ll"><span className="g5-lt" /><span className="g5-lc">{resultWord(entry)}</span></div>
    {entry.flagged && <div className="g5-ll"><span className="g5-lt" /><span className="g5-lc">Downloads and runs code (ran only in the sandbox).</span></div>}
    {entry.afterPersonCommandN !== undefined && <div className="g5-ll"><span className="g5-lt" /><span className="g5-lc">Ran after person&apos;s command #{entry.afterPersonCommandN}; the sandbox may include that command&apos;s changes.</span></div>}
    {entry.blockedHosts.length > 0 && <div className="g5-ll"><span className="g5-lt" /><span className="g5-lc">Could not reach: <VisibleText text={entry.blockedHosts.join(", ")} /></span></div>}
   </li>)}</ol>}</div>
  </details>;
 }}</ReadState>;
}
/** Websites the run asked for, and what became of each. */
export function HostsFold({ query }: { query: ReturnType<typeof useJournalRead> }) {
 return <ReadState query={query} label="the setup journal" shell={() => null}>{data => <details className="g5-fold" aria-label="Websites requested">
  <summary><Chevron /><strong>Host requests</strong><span className="g5-pre">{data.hostAsks.map(ask => ask.host).join(" · ")}</span><span className="g5-end">{data.hostAsks.length} {data.hostAsks.length === 1 ? "request" : "requests"}</span></summary>
  <div className="g5-fold-body">{data.hostAsks.length === 0 ? <p className="g5-note">No website requests returned.</p> : <div className="g5-table"><div className="rv-table-wrap rv-table-v2-wrap"><table className="rv-table rv-table-v2" aria-label="Websites requested"><thead><tr><th scope="col">Need</th><th scope="col">Observed result</th></tr></thead><tbody>{data.hostAsks.map(ask => <tr key={ask.host}><td><strong><code><VisibleText text={ask.host} /></code></strong></td><td>{HOST[ask.status]}</td></tr>)}</tbody></table></div></div>}</div>
 </details>}</ReadState>;
}
