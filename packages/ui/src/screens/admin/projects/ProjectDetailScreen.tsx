import { ProjectSlackLinks } from "./ProjectSlackLinks.js";
import { ProjectIntegrations } from "../../connect/ProjectIntegrations.js";
import { useEffect, useRef } from "react";
import { AllowedWebsites } from "./AllowedWebsites.js";
import { ContextSources } from "./ContextSources.js";
import { WorkingBranches } from "./WorkingBranches.js";
import { RestoreProject } from "./RestoreProject.js";
import { ProjectPeople } from "./ProjectPeople.js";
import { ArchiveProject } from "./ArchiveProject.js";
import { ProjectSpendLimits } from "../../setup/ProjectSpendLimits.js";
import { useAdminContext } from "../AdminLayout.js";
import { projectSetupLabel } from "./labels.js";
import { Link, useParams, useSearchParams } from "react-router";
import { AppProjectDetailSchema, AppProjectLifecycleSchema, PROJECT_LIFECYCLE_WORDS, type AppProjectDetail } from "@agentx/contracts/web";
import { ApiError } from "../../../api/errors.js";
import { PageHeader } from "../../../design/PageHeader.js";
import { VisibleText } from "../../../design/VisibleText.js";
import { ReadState, useAdminRead } from "./read.js";
const detailReader = { parse(value: unknown) { const p = AppProjectDetailSchema.parse(value);return { name: p.name, description: p.description, status: p.status, latestRevision: p.latestRevision, repositories: p.repositories, savedWorkingBranches:p.savedWorkingBranches, myRole: p.myRole, setup: { status: p.setup.status, checkedRevision: p.setup.checkedRevision, checkedAt: p.setup.checkedAt }, settings: { setupCommandCount: p.settings.setupCommands.length, testCommandCount: p.settings.testCommands.length, devcontainer: p.settings.devcontainer, allowedDomains: p.settings.allowedDomains.map(d => ({ domain: d.domain, status: d.status })) } }; } };
const lifecycleReader = { parse(value: unknown) { return AppProjectLifecycleSchema.parse(value); } };
function SavedWorkingBranchSummary({saved}:{saved:NonNullable<AppProjectDetail["savedWorkingBranches"]>}){
 const signature=saved.map(item=>`${item.repository}:${item.branch}:${item.commit}`).join("\n"),previous=useRef(signature),status=useRef<HTMLParagraphElement>(null);
 useEffect(()=>{if(previous.current!==signature&&signature!=="")status.current?.focus();previous.current=signature;},[signature]);
 return saved.length===0?<p>Using GitHub default branch</p>:<>{saved.map((item,index)=><p key={item.repository} ref={index===0?status:undefined} tabIndex={-1}>Saved working branch <VisibleText text={item.branch} /> @ <code>{item.commit}</code>. Not used by tasks yet; tasks start from the GitHub default branch.</p>)}</>;
}
export function ProjectDetailScreen() {
 const context = useAdminContext();
 const { name = "" } = useParams(), [params] = useSearchParams();
 const read = useAdminRead("project-detail", name, `/v1/app/projects/${encodeURIComponent(name)}`, detailReader);
 // Guided onboarding PR 17: the archive state and the one action Code offers this person (none for a person who only uses the project).
 const lifecycle = useAdminRead("project-lifecycle", name, `/v1/app/projects/${encodeURIComponent(name)}/lifecycle`, lifecycleReader);
 const settled = !read.isFetching && !read.isError && !lifecycle.isFetching && !lifecycle.isError && !context.checking;
 const notYet = lifecycle.error instanceof ApiError && lifecycle.error.code === "NOT_ON_CODE_YET";
 return <section><Link className="rv-admin-b1-link" to={`/app/admin/projects${params.size ? "?" + params.toString() : ""}`}>Back to projects</Link><PageHeader focusOnMount title={name} /><ReadState read={read} label="project details">{p => <>
 <p><VisibleText text={p.description ?? "No description returned"} /></p><p>Status: {(lifecycle.data?.status ?? p.status) === "archived" ? "Archived" : "Active"} · Revision {p.latestRevision}</p>{(lifecycle.data?.status ?? p.status) === "archived" && <p>Archived projects stop new work. Running tasks stop at their next step. Nothing is deleted.</p>}
 {notYet && <p className="rv-muted">{PROJECT_LIFECYCLE_WORDS.notYet}</p>}
 <ArchiveProject key={`${context.orgId}:${context.developerId}:${name}`} name={name} observedStatus={lifecycle.data?.status ?? p.status} available={p.name === name && settled && lifecycle.data?.status === "active" && lifecycle.data.actions.includes("archive")} />
 <RestoreProject key={`restore:${context.orgId}:${context.developerId}:${name}`} name={name} observedStatus={lifecycle.data?.status ?? p.status} available={p.name === name && settled && lifecycle.data?.status === "archived" && lifecycle.data.actions.includes("restore")} />
 {p.name===name && p.status==="active" && !read.isFetching && !read.isError && !context.checking && <p><Link className="rv-admin-b1-link" to={`/app/projects/${encodeURIComponent(name)}?tab=how-we-work`}>How we work</Link></p>}<h2>Repositories and working branch</h2>{p.repositories.length === 0 ? <p>No repositories returned. Repository connection status is unavailable here.</p> : p.repositories.map(r => <div className="rv-admin-section" key={r.name??r.fullName}><h3><VisibleText text={r.fullName} /></h3><p>GitHub default branch: <VisibleText text={r.defaultBranch} /></p><SavedWorkingBranchSummary saved={p.savedWorkingBranches?.filter(s=>s.repository===r.name)??[]} /></div>)}
 <WorkingBranches name={name} projectRevision={p.latestRevision} available={p.name === name && p.status === "active" && p.myRole === "maintainer" && !read.isFetching && !read.isError && !context.checking} />
 <h2>Setup</h2><p>Setup status: {projectSetupLabel[p.setup.status]}</p><p>Checked revision: {p.setup.checkedRevision ?? "Unavailable"}</p><p>Setup commands: {p.settings.setupCommandCount} configured. Test commands: {p.settings.testCommandCount} configured.</p><p>Devcontainer: {p.settings.devcontainer ? <VisibleText text={`${p.settings.devcontainer.repository} · ${p.settings.devcontainer.configPath}`} /> : "Not configured"}</p>
 <h2>Allowed websites</h2>{p.settings.allowedDomains.length === 0 ? <p>No project websites returned.</p> : <ul>{p.settings.allowedDomains.map(d=><li key={d.domain}><VisibleText text={d.domain} /> · {d.status}</li>)}</ul>}<p>The website editor shows mandatory defaults and staff decisions. Pending websites require staff approval on Rovara Cloud.</p>
 <AllowedWebsites orgId={context.orgId} project={name} available={p.name === name && p.status === "active" && p.myRole === "maintainer" && !read.isFetching && !read.isError && !context.checking} />
 {p.name===name && p.status==="active" && p.myRole==="maintainer" && !read.isFetching && !read.isError && !context.checking && <ContextSources key={`sources:${context.orgId}:${name}`} project={name} />}
 {p.name===name && p.status==="active" && <ProjectIntegrations key={`integrations:${context.orgId}:${name}`} project={name} canEdit={p.myRole === "maintainer" && !context.checking} />}
 <h2>Slack channels</h2><ProjectSlackLinks orgId={context.orgId} project={name} available={p.name === name && p.myRole === "maintainer" && !read.isFetching && !read.isError && !context.checking} />
 {p.name === name && !context.checking && <ProjectSpendLimits key={`spend:${context.orgId}:${context.developerId}:${name}`} project={name} developerId={context.developerId} />}
 <p>AI source order, connector grants and code rules are not included in this read-only view.</p><ProjectPeople key={name} name={p.name} />
 </>}</ReadState></section>;
}
