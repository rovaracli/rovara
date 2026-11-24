import { Fact, Facts, Foot, Unknown } from "./parts.js";
import { ReadState } from "./ReadState.js";
import { HostsFold, LogFold, RunSummary, useJournalRead, useRunRead } from "./RunCard.js";

/** `withRun` is false where the progress panel stands right above it, so the result is shown once. */
export function SetupJournalReadPanel({ project, withRun = true }: { project: string; withRun?: boolean }) {
 const journal = useJournalRead(project), run = useRunRead(project);
 return <div className="g5-cols" aria-label="Setup run journal" role="region">
  <div className="g5-main g5-stack">
   {withRun
    ? <ReadState query={run} label="the setup run" shell={node => <section className="g5-card g5-run">{node}</section>}>{data => <section className="g5-card g5-run" aria-label="Setup run result">
     <RunSummary data={data} project={project} hostAsks={journal.isSuccess ? journal.data.hostAsks : undefined} />
     <div className="g5-frows"><LogFold query={journal} open /><HostsFold query={journal} /></div>
    </section>}</ReadState>
    : <section className="g5-card g5-run" aria-label="Run log, read back"><h2>Run log, read back</h2><div className="g5-frows"><LogFold query={journal} open /><HostsFold query={journal} /></div></section>}
   <Foot>This journal is for this run only. A missing log line does not prove that a command ran or passed.</Foot>
  </div>
  {withRun && <aside className="g5-side"><h2>This run</h2>
   <ReadState query={run} label="the setup run" shell={() => null}>{data => data.summary === undefined ? null : <Facts>
    <Fact label="Commands">{data.summary.commandsRun}</Fact><Fact label="Address requests">{data.summary.hostAsks}</Fact>
   </Facts>}</ReadState>
   <p className="g5-unknown-line"><Unknown />Step names and timings can&apos;t be told yet.</p>
  </aside>}
 </div>;
}
