import { ProjectSetupChecklistSchema, SETUP_STATUS_ROWS, type ProjectSetupChecklist, type SetupRowState, type SetupStatusRow } from "@agentx/contracts/web";
import { PageHeader } from "../../../../../packages/ui/src/design/PageHeader.js";
import { Fact, Facts, Foot, ReadFrom, Row, Rows, Section, VisibleText, localClock, type RowTone } from "../../../../../packages/ui/src/screens/account-setup-read/parts.js";
import { ReadState } from "../../../../../packages/ui/src/screens/account-setup-read/ReadState.js";
import { useScopedRead } from "../../../../../packages/ui/src/screens/account-setup-read/read-model.js";

const TITLES: Record<SetupStatusRow, string> = { repos: "Repositories", setupRun: "Setup run", evalConfirm: "AI evals", aiAndSpend: "AI for your agents", slackChannel: "Slack channel", linear: "Linear", invites: "Invite teammates", firstTask: "First task" };
const TONES: Record<SetupRowState, RowTone> = { done: "ok", needs_you: "attention", running: "running", optional: "none", skipped: "none", failed: "failed" };
const WORDS: Record<SetupRowState, string> = { done: "Done", needs_you: "Needs you", running: "Running", optional: "Optional", skipped: "Skipped (optional)", failed: "Failed" };
const SOURCE = { project: "This project's own AI connection", company: "The company's AI connection", default: "The default AI connection" } as const;
/** One plain line per row from what the read serves; a row the read says nothing more about has no line. */
function detail(data: ProjectSetupChecklist, row: SetupStatusRow) {
 switch (row) {
  case "repos": return data.repos.count === 0 ? undefined : `${String(data.repos.count)} ${data.repos.count === 1 ? "repository" : "repositories"}`;
  case "setupRun": return data.setupRun.status === "none" ? undefined : data.setupRun.commandsRun === undefined ? undefined : `${String(data.setupRun.commandsRun)} commands run`;
  case "evalConfirm": return data.evalConfirm.blockedBy === undefined ? undefined : "Waits for the setup run";
  case "aiAndSpend": return SOURCE[data.aiAndSpend.source];
  case "slackChannel": return data.slackChannel.channels.length === 0 ? undefined : data.slackChannel.channels.map(channel => channel.name ?? channel.channelId).join(", ");
  case "linear": return data.linear.team?.name;
  default: return undefined;
 }
}
export function ProjectChecklistRead({ project }: { project: string }) {
 const query = useScopedRead(`/v1/app/projects/${encodeURIComponent(project)}/setup-status`, { parse(value: unknown) {
  const result = ProjectSetupChecklistSchema.parse(value);
  if (result.project !== project) throw new Error("Checklist belongs to another project");
  return result;
 } });
 return <>
  <PageHeader title="Project setup checklist" breadcrumbs={[{ label: "Project checklist" }]} />
  <div className="g5-main g5-stack" aria-label="Project setup checklist" role="region">
   <ReadState query={query} label="the project checklist" variant="page" code="PROJECT-CHECKLIST-READ-FAILED">{(data, at) => <>
    <p className="g5-summary">Rovara learns how to install and test the repo on a clean machine. You approve what it found before any task runs.</p>
    <Section title="Project checklist" note={<><VisibleText text={data.project} /> · {data.progress.done} of {data.progress.total} done · <span>{data.progress.percent}% complete</span></>}>
     <Rows label="Setup rows">{SETUP_STATUS_ROWS.map(row => <Row key={row} mark={TONES[data[row].state]} title={TITLES[row]} detail={detail(data, row)} aside={WORDS[data[row].state]} selected={data.progress.nextRequired === row} />)}</Rows>
    </Section>
    <section className="g5-card" aria-labelledby="g5-read-back"><h2 id="g5-read-back">What you&apos;ve set up, read back just now</h2>
     {data.repos.items.length === 0 ? <p className="g5-lede">No repositories returned. <ReadFrom at={at} /></p> : <Rows label="Repositories">{data.repos.items.map(repo => <Row key={repo.name} mark={repo.access === undefined ? "ok" : "attention"} title={<VisibleText text={repo.fullName ?? repo.name} />} detail={repo.access === undefined ? undefined : repo.access === "removed" ? "Access removed" : "Transferred"} aside={<>Branch {repo.defaultBranch}</>} />)}</Rows>}
     {data.setupRun.startedAt !== undefined && <Facts><Fact label="Setup run started">{localClock(data.setupRun.startedAt)}</Fact></Facts>}
     <Facts>
      <Fact label="Setup will">Copy the repo to a Rovara machine, read it, install dependencies, run your tests once and write a setup summary for you to approve.</Fact>
      <Fact label="Setup won't">Change anything in <VisibleText text={data.project} />, open a pull request, or start a task.</Fact>
     </Facts>
     <span className="g5-field-label">First task, optional</span>
     <p className="g5-note">{data.firstTask.hasTask ? "A first task is saved, not started. It starts only after setup is verified on a fresh machine." : "No first task is saved."}</p>
     {data.viewer.canSkip === false && <p className="g5-note">Ask your company&apos;s admins to finish setup.</p>}
    </section>
    <Foot><ReadFrom at={at} /></Foot>
   </>}</ReadState>
  </div>
 </>;
}
