// Guided onboarding PR 9 (design section 1 and section 4 "empty states"): on Home, a "Finish setting up" card for each of the person's first projects whose
// checklist isn't done yet (read from Code's real state, never a saved position), and the empty state that points to the next step when there is no project:
// "Pick repos" for a company owner or admin, "Ask <admin> to add you" for anyone else.
import { Link } from "react-router";
import { useQueries, useQuery } from "@tanstack/react-query";
import { useNav } from "../account/use-nav.js";
import { setupChecklistKey, useSetupChecklistApi } from "../../api/setup-checklist.js";
import { useOnboardingApi } from "../../api/onboarding.js";
import { VisibleText } from "../../design/VisibleText.js";

/** How many projects Home asks about (each is one read). */
const FINISH_SETUP_PROJECTS = 3;

function AskAdmins() {
 const api = useOnboardingApi();
 const members = useQuery({ queryKey: ["org", "members"], queryFn: api.members, retry: false });
 if (members.isPending) return null;
 const names = members.data?.members.filter(member => member.role === "owner" || member.role === "admin").map(member => member.name).join(", ");
 return <>Ask <VisibleText text={names === undefined || names === "" ? "your company's admins" : names} /> to add you to a project.</>;
}

export function FinishSetup() {
 const nav = useNav(), api = useSetupChecklistApi();
 const projects = (nav?.projects ?? []).slice(0, FINISH_SETUP_PROJECTS).map(project => project.name);
 const reads = useQueries({ queries: projects.map(project => ({ queryKey: setupChecklistKey(project), queryFn: () => api.status(project), retry: false })) });
 if (nav === undefined) return null;
 if (nav.projects.length === 0) {
  const admin = nav.me.orgRole === "owner" || nav.me.orgRole === "admin";
  return <section className="rv-empty" data-testid="home-no-projects"><h2>No projects yet</h2>{admin ? <><p className="rv-muted">Pick the repos Rovara should work on. Each project gets a short checklist.</p><Link className="rv-button rv-button-primary" to="/app/onboard?step=repositories">Pick repos</Link></> : <p className="rv-muted"><AskAdmins /></p>}</section>;
 }
 const unfinished = reads.flatMap((read, index) => read.data !== undefined && read.data.progress.percent < 100 ? [{ project: projects[index]!, data: read.data }] : []);
 if (unfinished.length === 0) return null;
 return <ol className="rv-attention-list" aria-label="Finish setting up">{unfinished.map(({ project, data }) => <li key={project} className="rv-attention-row" data-testid="home-finish-setup"><article><div className="rv-attention-content">
  <h2>Finish setting up <VisibleText text={project} /></h2>
  <p className="rv-attention-reason">{data.progress.percent}% done.{data.progress.nextRequired === null ? "" : " Next: " + NEXT_WORDS[data.progress.nextRequired] + "."}</p>
 </div><div className="rv-attention-actions"><Link className="rv-attention-open" to={"/app/projects/" + encodeURIComponent(project)}>Open checklist</Link></div></article></li>)}</ol>;
}
const NEXT_WORDS: Readonly<Record<string, string>> = Object.freeze({ repos: "add a repo", setupRun: "the setup run", evalConfirm: "confirm how work is checked", aiAndSpend: "AI and spend limit", firstTask: "start your first task" });
