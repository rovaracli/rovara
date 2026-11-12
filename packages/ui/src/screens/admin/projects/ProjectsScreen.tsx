import { projectRoleLabel, projectSetupLabel } from "./labels.js";
import { SettingsNote } from "../SettingsNote.js";
import { Link, useSearchParams } from "react-router";
import { AppProjectsResponseSchema } from "@agentx/cloud-contracts/web";
import { DataTable } from "../../../design/DataTable.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ReadState, useAdminRead } from "./read.js";
const reader = { parse(value: unknown) { const data = AppProjectsResponseSchema.parse(value);return { projects: data.projects.map(p => ({ name: p.name, description: p.description, status: p.status, latestRevision: p.latestRevision, repositories: p.repositories, myRole: p.myRole, shownRole: p.myProjectRole ?? p.myRole, setup: { status: p.setup.status } })) }; } };
export function ProjectsScreen() {
 const [params, setParams] = useSearchParams(), term = params.get("q") ?? "", status = params.get("status") === "archived" ? "archived" : "active";
 const read = useAdminRead("projects", "list", "/v1/app/projects?include=archived", reader);
 function update(key: string, value: string) { const next = new URLSearchParams(params);next.set(key, value);setParams(next, { replace: true }); }
 return <section><PageHeader focusOnMount title="Projects" description="Projects visible to you in this company. Inspect repositories and project access." /><SettingsNote area="projects" /><ReadState read={read} label="projects">{data => {
 const matches = data.projects.filter(p => p.status === status && p.name.toLocaleLowerCase("en-US").includes(term.trim().toLocaleLowerCase("en-US")));
 return <><div className="rv-field rv-admin-search"><label htmlFor="admin-project-status">Project status</label><select id="admin-project-status" value={status} onChange={e => update("status", e.target.value)}><option value="active">Active</option><option value="archived">Archived</option></select><label htmlFor="admin-project-search">Find in this project list</label><input id="admin-project-search" type="search" maxLength={200} value={term} onChange={e => update("q", e.target.value)} /><p className="rv-muted">Search names in the returned project list only.</p></div>
 {data.projects.length === 0 ? <p>No projects were returned.</p> : <><p role="status">{matches.length} matching {status} projects in this list</p>{matches.length === 0 ? <p>No matching projects in this list.</p> : <DataTable caption="Projects" rows={matches} rowKey={p => p.name} columns={[
 { key:"name", title:"Project", render:p => <Link to={`/app/admin/projects/${encodeURIComponent(p.name)}${params.size ? "?" + params.toString() : ""}`}><VisibleText text={p.name} /></Link> },
 { key:"status", title:"Status", render:p => p.status === "archived" ? "Archived" : "Active" }, { key:"repos", title:"Repositories", render:p => p.repositories.length ? p.repositories.map(r => r.fullName).join(", ") : "No repositories returned" },
 { key:"role", title:"Your project role", render:p => projectRoleLabel[p.shownRole] }, { key:"setup", title:"Setup", render:p => projectSetupLabel[p.setup.status] }, { key:"revision", title:"Revision", render:p => p.latestRevision },
 ]} />}</> }</>;
 }}</ReadState></section>;
}
