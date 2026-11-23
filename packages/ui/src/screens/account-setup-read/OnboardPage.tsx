// /app/onboard on the real router (G5 ship, option b): the rebuilt setup frames with the LIVE wizard steps inside them, one implementation, no copy.
//  - company wizard (no project):   Company setup progress frame + the live company steps (Connect GitHub, Add to Slack, AI and spending, Pick repos)
//  - ?project=<p>&step=agents:      Workflows for setup frame + the live Agents step
//  - ?project=<p> (checklist, or step=setup): the live page unchanged, with the Setup run progress and Setup run journal read views under it
//  - ?project=<p>&step=invite|first: the live page unchanged
// The live parts are siblings of the read frames, never children: a read that fails, or a re-read of who you are, never removes a live step.
// The project checklist's own rebuilt view waits for the project page round (DEFERRED in the lane's DONE.md).
import { useEffect } from "react";
import { skipToken, useQuery, useQueryClient } from "@tanstack/react-query";
import { useSearchParams } from "react-router";
import { ProjectOverviewProjectSchema, type AppProjectDetail } from "@agentx/contracts/web";
import { OnboardScreen } from "../onboarding/OnboardScreen.js";
import { ReadEntry } from "./ReadEntry.js";
import { CompanySetupProgressRead } from "./CompanySetupProgressRead.js";
import { SetupWorkflowsReadScreen } from "./SetupWorkflowsReadScreen.js";
import { SetupProgressReadPanel } from "./SetupProgressReadPanel.js";
import { SetupJournalReadPanel } from "./SetupJournalReadPanel.js";
import { Section } from "./parts.js";
import { useReadIdentity } from "./read-model.js";
import { runPath } from "./RunCard.js";
import "./account-setup-read.css";

/** The live screen keeps the project's setup state in its own query; when that state changes the run and journal read views are read again (only those two). */
function useRunSync(project: string) {
 const cache = useQueryClient();
 const live = useQuery<AppProjectDetail>({ queryKey: ["onboard", "project", project], queryFn: skipToken });
 const status = live.data?.setup.status;
 useEffect(() => {
  if (status === undefined) return;
  void cache.invalidateQueries({ predicate: entry => entry.queryKey.some(part => typeof part === "string" && part.startsWith(runPath(project))) });
 }, [status]); // eslint-disable-line react-hooks/exhaustive-deps
}
function RunViewsBody({ project }: { project: string }) {
 const { developer } = useReadIdentity();
 // Only a company owner or admin can read a project's setup run (the live page says the same to a member).
 if (developer.orgRole !== "owner" && developer.orgRole !== "admin") return null;
 return <div className="g5-stack g5-run-views"><Section title="Setup run, read back from Rovara"><SetupProgressReadPanel project={project} withLog={false} /><SetupJournalReadPanel project={project} withRun={false} /></Section></div>;
}
function RunViews({ project }: { project: string }) {
 useRunSync(project);
 return <ReadEntry code="SETUP-READ-FAILED"><RunViewsBody project={project} /></ReadEntry>;
}
export function OnboardPage() {
 const [params] = useSearchParams();
 const parsed = ProjectOverviewProjectSchema.shape.name.safeParse(params.get("project"));
 if (params.get("project") === null || !parsed.success) return <>
  <ReadEntry title="Company setup progress" code="COMPANY-SETUP-READ-FAILED"><CompanySetupProgressRead actions /></ReadEntry>
  <div className="g5-onboard-live"><OnboardScreen embedded /></div>
 </>;
 const project = parsed.data, step = params.get("step");
 if (step === "agents") return <>
  <ReadEntry title="Workflows for setup" code="SETUP-AGENTS-READ-FAILED"><SetupWorkflowsReadScreen project={project} withStep /></ReadEntry>
  <div className="g5-onboard-live"><OnboardScreen embedded /></div>
 </>;
 if (step === "invite" || step === "first") return <div className="g5-onboard-live" data-plain><OnboardScreen /></div>;
 return <><div className="g5-onboard-live" data-plain><OnboardScreen /></div><RunViews project={project} /></>;
}
