import { Fact, Facts, Unknown, localClock } from "./parts.js";
import { ReadState } from "./ReadState.js";
import { LogFold, RunSummary, useJournalRead, useRunRead } from "./RunCard.js";

/** `withLog` is false where the journal panel stands right beside it, so the log is shown once. */
export function SetupProgressReadPanel({ project, withLog = true }: { project: string; withLog?: boolean }) {
 const query = useRunRead(project), journal = useJournalRead(project);
 return <div className="g5-cols" aria-label="Setup run progress" role="region">
  <div className="g5-main g5-stack">
   <ReadState refresh query={query} label="setup run progress">{data => <>
    <div className="g5-banner"><b>Setup run</b>{data.startedAt !== undefined && <span>Started {localClock(data.startedAt)}</span>}<p>Your first task starts only after setup is verified.</p></div>
    <section className="g5-card g5-run" aria-label="Setup run status">
     <RunSummary data={data} project={project} hostAsks={journal.isSuccess ? journal.data.hostAsks : undefined} />
     {withLog && <div className="g5-frows"><LogFold query={journal} open={false} /></div>}
    </section>
    <div className="g5-steps"><p className="g5-unknown-line"><Unknown />Rovara can&apos;t tell yet which stage the run is in.</p></div>
    {data.verified === undefined ? null : <Facts><Fact label="Run verification">{data.verified ? "Verified" : "Not verified"}</Fact></Facts>}
   </>}</ReadState>
  </div>
  <aside><h2>If you leave</h2><p>This page shows the same run when you come back.</p></aside>
 </div>;
}
