import { useEffect, useRef } from "react";
import { WorkingBranches } from "./WorkingBranches.js";
import { RestoreProject } from "./RestoreProject.js";
import { ArchiveProject } from "./ArchiveProject.js";
import { useAdminContext } from "../AdminLayout.js";
import { projectRoleLabel, projectSetupLabel } from "./labels.js";
import { Link, useParams, useSearchParams } from "react-router";
import { AppProjectDetailSchema, ProjectMembersResponseSchema, type AppProjectDetail } from "@agentx/contracts/web";
import { DataTable } from "../../../design/DataTable.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ReadState, useAdminRead } from "./read.js";
const detailReader = { parse(value: unknown) { const p = AppProjectDetailSchema.parse(value);return { name: p.name, description: p.description, status: p.status, latestRevision: p.latestRevision, repositories: p.repositories, savedWorkingBranches:p.savedWorkingBranches, myRole: p.myRole, setup: { status: p.setup.status, checkedRevision: p.setup.checkedRevision, checkedAt: p.setup.checkedAt }, settings: { setupCommandCount: p.settings.setupCommands.length, testCommandCount: p.settings.testCommands.length, devcontainer: p.settings.devcontainer, allowedDomains: p.settings.allowedDomains.map(d => ({ domain: d.domain, status: d.status })) } }; } };
const peopleReader = { parse(value: unknown) { return { members: ProjectMembersResponseSchema.parse(value).members.map(p => ({ developerId:p.developerId,name:p.name,role:p.role,source:p.source })) }; } };
function ProjectPeople({ name }: { name: string }) {
 const read = useAdminRead("project-members", name, `/v1/app/projects/${encodeURIComponent(name)}/members`, peopleReader);
 return <section><h2>Project people</h2><p>Company owners and admins maintain every project. This roster shows project grants and company roles; channel-derived access is not a complete roster here.</p><ReadState read={read} label="project people">{data => data.members.length === 0 ? <p>No project people were returned.</p> : <DataTable caption="Project people" rows={data.members} rowKey={p=>p.developerId} columns={[{key:"name",title:"Person",render:p=><VisibleText text={p.name} />},{key:"role",title:"Project role",render:p=>projectRoleLabel[p.role]},{key:"source",title:"Access source",render:p=>p.source === "grant" ? "Project grant" : "Company role"}]} />}</ReadState></section>;
}
function SavedWorkingBranchSummary({saved}:{saved:NonNullable<AppProjectDetail["savedWorkingBranches"]>}){
 const signature=saved.map(item=>`${item.repository}:${item.branch}:${item.commit}`).join("\n"),previous=useRef(signature),status=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{if(previous.current!==signature&&signature!=="")status.current?.focus();previous.current=signature;},[signature]);
 return saved.length===0?<p>Using GitHub default branch</p>:<>{saved.map((item,index)=><p key={item.repository} ref={index===0?status:undefined} tabIndex={-1}>Saved working branch <VisibleText text={item.branch} /> @ <code>{item.commit}</code>. Not used by tasks yet; tasks start from the GitHub default branch.</p>)}</>;
}
export function ProjectDetailScreen() {
 const context = useAdminContext();
 const { name = "" } = useParams(), [params] = useSearchParams();
 const read = useAdminRead("project-detail", name, `/v1/app/projects/${encodeURIComponent(name)}`, detailReader);
 return <section><Link className="rv-admin-b1-link" to={`/app/admin/projects${params.size ? "?" + params.toString() : ""}`}>Back to projects</Link><PageHeader focusOnMount title={name} /><ReadState read={read} label="project details">{p => <>
 <p><VisibleText text={p.description ?? "No description returned"} /></p><p>Status: {p.status === "archived" ? "Archived" : "Active"} · Revision {p.latestRevision}</p>{p.status === "archived" && <p>Archived projects stop new work. Existing work continues.</p>}
 <ArchiveProject key={`${context.orgId}:${context.developerId}:${name}`} name={name} observedStatus={p.status} available={p.name === name && p.status === "active" && p.myRole === "maintainer" && !read.isFetching && !read.isError && !context.checking} />
 <RestoreProject key={`restore:${context.orgId}:${context.developerId}:${name}`} name={name} observedStatus={p.status} available={p.name === name && p.status === "archived" && p.myRole === "maintainer" && !read.isFetching && !read.isError && !context.checking} />
 {p.name===name && p.status==="active" && !read.isFetching && !read.isError && !context.checking && <p><Link className="rv-admin-b1-link" to={`/app/projects/${encodeURIComponent(name)}?tab=how-we-work`}>How we work</Link></p>}<h2>Repositories and working branch</h2>{p.repositories.length === 0 ? <p>No repositories returned. Repository connection status is unavailable here.</p> : p.repositories.map(r => <div className="rv-admin-section" key={r.name??r.fullName}><h3><VisibleText text={r.fullName} /></h3><p>GitHub default branch: <VisibleText text={r.defaultBranch} /></p><SavedWorkingBranchSummary saved={p.savedWorkingBranches?.filter(s=>s.repository===r.name)??[]} /></div>)}
 <WorkingBranches name={name} projectRevision={p.latestRevision} available={p.name === name && p.status === "active" && p.myRole === "maintainer" && !read.isFetching && !read.isError && !context.checking} />
 <h2>Setup</h2><p>Setup status: {projectSetupLabel[p.setup.status]}</p><p>Checked revision: {p.setup.checkedRevision ?? "Unavailable"}</p><p>Setup commands: {p.settings.setupCommandCount} configured. Test commands: {p.settings.testCommandCount} configured.</p><p>Devcontainer: {p.settings.devcontainer ? <VisibleText text={`${p.settings.devcontainer.repository} · ${p.settings.devcontainer.configPath}`} /> : "Not configured"}</p>
 <h2>Allowed websites</h2>{p.settings.allowedDomains.length === 0 ? <p>No project websites returned.</p> : <ul>{p.settings.allowedDomains.map(d=><li key={d.domain}><VisibleText text={d.domain} /> · {d.status}</li>)}</ul>}<p>Always-allowed website list is unavailable in this view. Pending websites require staff approval on Rovara Cloud.</p>
 <p>Spending, AI source order, connector grants and code rules are not included in this read-only view.</p><ProjectPeople key={name} name={p.name} />
 </>}</ReadState></section>;
}
