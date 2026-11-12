import { Link } from "react-router";
import { useProject } from "../../../api/projects.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { joinedWords } from "./people-text.js";
import "./people.css";

/**
 * Where someone lands after joining through an invite that named a project (switch `rovara.people`): the welcome URL carries `?joined=1&project=<name>`, or `&projectNote=project_archived|project_gone`. With the
 * project, a link into it; with the note, a plain sentence that they joined the company but not the project. Either way a way into the app. The name was checked as a project name before it got here.
 */
export function JoinedLanding({ company, project, note }: { company: string | undefined; project: string | undefined; note: "project_archived" | "project_gone" | null }) {
 // The URL only claims the project: say "you are also on it" and link to it only once the project can be read as this person.
 const read = useProject(note === null ? project : undefined), confirmed = note === null && project !== undefined && read.isSuccess;
 const words = joinedWords(company, project, note, confirmed);
 return <section className="rv-joined" aria-labelledby="rv-joined-title">
  <PageHeader title={words.title} focusOnMount />
  <p id="rv-joined-title"><VisibleText text={words.body} /></p>
  <div className="rv-people-actions">
   {confirmed && project !== undefined && <Link className="rv-button rv-button-primary" to={"/app/projects/" + encodeURIComponent(project)}>Open <VisibleText text={project} /></Link>}
   <Link className={"rv-button " + (confirmed ? "rv-button-secondary" : "rv-button-primary")} to="/app">Go to Rovara</Link>
  </div>
 </section>;
}
