import { useAreaRead, useReadContext } from "./ReadEntry.js";
import { ReadState } from "./ReadState.js";
import { ProjectHowWeWorkReadScreen } from "./ProjectHowWeWorkReadScreen.js";
import { RuleHistoryView } from "./RuleHistoryReadPanel.js";
import { LearnedView } from "./ProjectLessonsReadScreen.js";
import { ProjectModelChoicesReadPanel } from "./ProjectModelChoicesReadPanel.js";
import { ViewPills, type ProjectView } from "./parts.js";
import { StaleSlot } from "./stale.js";
function HistoryScreen({ project }: { project: string }) {
 const { api } = useReadContext(), read = useAreaRead([project, "how"], () => api.how(project));
 return <ReadState read={read} scope="page" refName="PROJECT-HISTORY">{data => <RuleHistoryView agentId={data.process.agentId} />}</ReadState>;
}
/** The How we work tab's content: the four views as pills, one page each. The project's title and tab strip are the host's (ProjectScreen). */
export function ProjectViews({ project, view, repository }: { project: string; view: ProjectView; repository?: { fullName: string; defaultBranch: string } | undefined }) {
 return <div className="g4-page g4-project"><ViewPills current={view} /><StaleSlot />
  {view === "rules" ? <ProjectHowWeWorkReadScreen project={project} repository={repository} /> : view === "learned" ? <LearnedView project={project} /> : view === "models" ? <ProjectModelChoicesReadPanel project={project} /> : <HistoryScreen project={project} />}
 </div>;
}
