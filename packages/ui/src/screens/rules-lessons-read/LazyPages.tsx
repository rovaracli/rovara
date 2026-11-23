import { useSearchParams } from "react-router";
import { ReadEntry } from "./ReadEntry.js";
import { CompanyRulesReadScreen } from "./CompanyRulesReadScreen.js";
import { SetupRecipesReadScreen } from "./SetupRecipesReadScreen.js";
import { ProjectViews } from "./ProjectViews.js";
import { views, type ProjectView } from "./parts.js";

/** /app/admin/how-we-work: the company's Rules page (owners and admins). */
export function CompanyRulesPage() {
 return <ReadEntry admin header={{ crumbs: ["Company"], title: "Rules" }}><CompanyRulesReadScreen /></ReadEntry>;
}
/** /app/admin/how-we-work/recipes: the company's Setup recipes (owners and admins). */
export function SetupRecipesPage() {
 return <ReadEntry admin header={{ crumbs: ["Company"], title: "Setup recipes" }}><SetupRecipesReadScreen /></ReadEntry>;
}
/**
 * The project's How we work tab: Rules, Learned, Models by stage and History as pills (`?view=`). The legacy `?tab=lessons` address opens Learned.
 * The project's title and tab strip are the host's (ProjectScreen); the project name it passes has already passed the host's own name check.
 */
export default function ProjectHowWeWorkPage({ project, repository }: { project: string; repository?: { fullName: string; defaultBranch: string } | undefined }) {
 const [params] = useSearchParams(), asked = params.get("view"), view: ProjectView = views.find(([value]) => value === asked)?.[0] ?? (params.get("tab") === "lessons" ? "learned" : "rules");
 return <ReadEntry key={project} refName="PROJECT"><ProjectViews project={project} view={view} repository={repository} /></ReadEntry>;
}
